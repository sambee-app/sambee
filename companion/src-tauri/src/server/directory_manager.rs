//! Shared local catalogues, native observations, and worker ownership independent of HTTP requests.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use notify::{
    event::{CreateKind, ModifyKind, RemoveKind, RenameMode},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
#[cfg(test)]
use rusqlite::Connection;
use rusqlite::OpenFlags;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use super::directory_index::{
    acquire_storage, epoch_milliseconds, open_directory_database, open_readonly_directory_database, search_terms, validate_directory_path,
    validate_storage_files, DirectoryIndex, DirectoryIndexReader, DirectoryMutation, IndexError, SourceKind, StorageDirectory,
    APPLICATION_ID, ROW_BATCH_SIZE, SCHEMA_VERSION, SQL_BUSY_TIMEOUT,
};
#[cfg(test)]
use super::directory_traversal::NativeIdentity;
use super::directory_traversal::{source_error, NativeIo, NativeParent, NativeRoot, TraversalIssue, MOUNT_BOUNDARY_CAPABILITY_ERROR};
use super::drives::{volume_evidence, VolumeChange, VolumeEvidence};
use super::models::{DirectoryIssueDetail, DirectorySearchResult, ScanProgress};

const CONTRACT_JSON: &str = include_str!("../../../../shared/directory-index/contract.json");
const STALLED_READ_TIMEOUT: Duration = Duration::from_secs(30);
const FAILURE_RETRY_MIN: Duration = Duration::from_secs(30);
const FAILURE_RETRY_MAX: Duration = Duration::from_secs(300);
const FAILURE_RETRY_JITTER_PERCENT: u8 = 10;
const PERIODIC_VERIFICATION_JITTER_PERCENT: u8 = 10;
const DEFAULT_RESULT_LIMIT: usize = 50;
const SEARCH_CONTRACT_VERSION: u32 = 1;
pub(super) const MAX_WIRE_INTEGER: i64 = 9_007_199_254_740_991;
const POLICY_VERSION: u32 = 1;

#[cfg(windows)]
#[path = "directory_removal_windows.rs"]
mod removal_windows;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Contract {
    version: u32,
    limits: HashMap<String, i64>,
    policy: HashMap<String, PolicyField>,
    scan_progress: ProgressContract,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProgressContract {
    fields: Vec<String>,
    phases: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyField {
    label: String,
    description: String,
    default: i64,
    minimum: i64,
    maximum: i64,
    step: i64,
}

fn contract() -> Result<&'static Contract, IndexError> {
    static CONTRACT: OnceLock<Result<Contract, serde_json::Error>> = OnceLock::new();
    let contract = CONTRACT
        .get_or_init(|| serde_json::from_str(CONTRACT_JSON))
        .as_ref()
        .map_err(|_| IndexError::Invalid("Bundled directory-index policy is invalid. Reinstall the companion."))?;
    if contract.version != POLICY_VERSION
        || contract.scan_progress.fields != ["phase", "parents_done", "parents_queued", "directories_found", "started_at_ms"]
        || contract.scan_progress.phases != ["building", "updating", "idle"]
    {
        return Err(IndexError::Invalid(
            "Unsupported directory policy contract. Reinstall the companion.",
        ));
    }
    Ok(contract)
}

pub(super) fn limit(name: &str) -> Result<usize, IndexError> {
    let value = contract()?.limits.get(name).ok_or(IndexError::Invalid(
        "Bundled directory resource limit is missing. Reinstall the companion.",
    ))?;
    usize::try_from(*value).ok().filter(|value| *value > 0).ok_or(IndexError::Invalid(
        "Bundled directory resource limit is invalid. Reinstall the companion.",
    ))
}

#[derive(Clone, Debug, Deserialize, serde::Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DirectoryPolicy {
    pub version: u32,
    pub disk_budget_bytes: i64,
    pub inactive_retention_seconds: i64,
    pub max_retained_inactive_sources: i64,
    pub page_cache_kib: i64,
    pub healthy_verification_seconds: i64,
    pub degraded_verification_seconds: i64,
}

impl DirectoryPolicy {
    pub fn defaults() -> Result<Self, IndexError> {
        let mut values = serde_json::Map::new();
        values.insert("version".into(), json!(POLICY_VERSION));
        for (name, field) in &contract()?.policy {
            values.insert(name.clone(), json!(field.default));
        }
        let policy: Self = serde_json::from_value(Value::Object(values))
            .map_err(|_| IndexError::Invalid("Bundled directory policy fields are invalid. Reinstall the companion."))?;
        policy.validate()?;
        Ok(policy)
    }

    pub fn validate(&self) -> Result<(), IndexError> {
        if self.version != POLICY_VERSION {
            return Err(IndexError::Invalid("Directory policy version is not supported."));
        }
        for (name, value) in [
            ("disk_budget_bytes", self.disk_budget_bytes),
            ("inactive_retention_seconds", self.inactive_retention_seconds),
            ("max_retained_inactive_sources", self.max_retained_inactive_sources),
            ("page_cache_kib", self.page_cache_kib),
            ("healthy_verification_seconds", self.healthy_verification_seconds),
            ("degraded_verification_seconds", self.degraded_verification_seconds),
        ] {
            let field = contract()?
                .policy
                .get(name)
                .ok_or(IndexError::Invalid("Directory policy field is not defined."))?;
            if field.label.is_empty() || field.description.is_empty() || field.step <= 0 || value < field.minimum || value > field.maximum {
                return Err(IndexError::Invalid("Directory policy value is outside its supported range."));
            }
        }
        if self.degraded_verification_seconds > self.healthy_verification_seconds {
            return Err(IndexError::Invalid(
                "Degraded verification must not be slower than healthy verification.",
            ));
        }
        Ok(())
    }
}

fn lock<T>(value: &Mutex<T>) -> Result<MutexGuard<'_, T>, IndexError> {
    value
        .lock()
        .map_err(|_| IndexError::Invalid("Directory worker state is unavailable. Restart the companion."))
}

struct DiskState {
    policy: DirectoryPolicy,
    reserved: u64,
    next_cleanup_at: Instant,
}
struct DiskBudget {
    namespace: PathBuf,
    policy_gate: Mutex<()>,
    state: Mutex<DiskState>,
    space_probe: fn(&Path) -> Result<u64, IndexError>,
}

fn available_disk_bytes(namespace: &Path) -> Result<u64, IndexError> {
    let mut existing = None;
    for ancestor in namespace.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(IndexError::Invalid(
                        "Directory-index storage must use real directories without links. Select private local storage.",
                    ));
                }
                if existing.is_none() {
                    existing = Some(ancestor);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let directory = existing.ok_or(IndexError::Invalid(
        "Directory-index filesystem is unavailable. Restore cache storage before retrying.",
    ))?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        let descriptor = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory)?;
        let mut volume: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatvfs(descriptor.as_raw_fd(), &mut volume) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        u64::try_from(u128::from(volume.f_bavail) * u128::from(volume.f_frsize))
            .map_err(|_| IndexError::Invalid("Directory-index filesystem space exceeds the supported range."))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let name: Vec<u16> = directory.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut available = 0;
        unsafe { GetDiskFreeSpaceExW(PCWSTR(name.as_ptr()), Some(&mut available), None, None) }.map_err(|_| {
            IndexError::Invalid("Directory-index filesystem space cannot be checked. Restore cache storage before retrying.")
        })?;
        Ok(available)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = directory;
        Err(IndexError::Invalid(
            "Directory-index filesystem space checks are unavailable on this platform.",
        ))
    }
}

impl DiskBudget {
    fn inactive_access(path: &Path) -> Result<Option<i64>, IndexError> {
        if !path.try_exists()? {
            return Ok(None);
        }
        let _lease = acquire_storage(path)?;
        let connection = open_readonly_directory_database(path)?;
        connection.busy_timeout(SQL_BUSY_TIMEOUT)?;
        let application: i64 = connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let schema: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if application != APPLICATION_ID || schema != SCHEMA_VERSION {
            return Ok(None);
        }
        let (kind, accessed): (String, i64) = connection.query_row(
            "SELECT source_kind, last_access_at_ms FROM source_metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok((kind == "local" && accessed >= 0).then_some(accessed))
    }

    fn delete_inactive(path: &Path, expected_access: i64) -> Result<bool, IndexError> {
        let directory = StorageDirectory::open(
            path.parent()
                .ok_or(IndexError::Invalid("Directory cleanup has no private parent."))?,
        )?;
        let _lease = acquire_storage(path)?;
        if !path.try_exists()? {
            return Ok(false);
        }
        let connection = open_directory_database(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.busy_timeout(SQL_BUSY_TIMEOUT)?;
        let application: i64 = connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let accessed: i64 = connection.query_row("SELECT last_access_at_ms FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        if application != APPLICATION_ID || accessed != expected_access {
            return Ok(false);
        }
        let busy: i64 = connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))?;
        if busy != 0 {
            return Ok(false);
        }
        drop(connection);
        directory.verify()?;
        validate_storage_files(path)?;
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut filename = path.as_os_str().to_os_string();
            filename.push(suffix);
            match directory.remove(Path::new(&filename)) {
                Ok(()) => {}
                Err(IndexError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        log::debug!("event=directory_inactive_evicted");
        Ok(true)
    }

    fn cleanup_inactive(&self, policy: &DirectoryPolicy, reserved: u64, pressure: bool, now_ms: i64) -> Result<usize, IndexError> {
        if pressure {
            let _ = super::directory_index::discard_quarantine(&self.namespace);
        }
        let entries = match std::fs::read_dir(&self.namespace) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error.into()),
        };
        let maximum =
            usize::try_from(policy.max_retained_inactive_sources).map_err(|_| IndexError::Invalid("Invalid inactive-source count."))?;
        let retention_ms = policy
            .inactive_retention_seconds
            .checked_mul(1000)
            .ok_or(IndexError::Invalid("Invalid inactive retention time."))?;
        let mut retained = BinaryHeap::new();
        let mut removed = 0;
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let Some(stem) = name.to_str().and_then(|name| name.strip_suffix(".sqlite3")) else {
                continue;
            };
            if stem.len() != 64
                || !stem
                    .bytes()
                    .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
            {
                continue;
            }
            let path = entry.path();
            let Ok(Some(accessed)) = Self::inactive_access(&path) else {
                continue;
            };
            let effective_access = if accessed > now_ms { 0 } else { accessed };
            if now_ms.saturating_sub(effective_access) >= retention_ms {
                removed += usize::from(Self::delete_inactive(&path, accessed).unwrap_or(false));
                continue;
            }
            retained.push(Reverse((effective_access, path, accessed)));
            if retained.len() > maximum {
                if let Some(Reverse((_, path, accessed))) = retained.pop() {
                    removed += usize::from(Self::delete_inactive(&path, accessed).unwrap_or(false));
                }
            }
        }
        let headroom = u64::try_from(limit("write_headroom_bytes")?).map_err(|_| IndexError::Invalid("Invalid cleanup headroom."))?;
        while pressure && !retained.is_empty() {
            let needed = self
                .managed_bytes()?
                .checked_add(reserved)
                .and_then(|bytes| bytes.checked_add(headroom))
                .ok_or(IndexError::Invalid("Directory disk accounting overflowed."))?;
            if needed <= u64::try_from(policy.disk_budget_bytes).map_err(|_| IndexError::Invalid("Invalid disk budget."))?
                && reserved
                    .checked_add(headroom)
                    .ok_or(IndexError::Invalid("Directory disk accounting overflowed."))?
                    <= (self.space_probe)(&self.namespace)?
            {
                break;
            }
            let Some(Reverse((_, path, accessed))) = retained.pop() else {
                break;
            };
            removed += usize::from(Self::delete_inactive(&path, accessed).unwrap_or(false));
        }
        Ok(removed)
    }

    fn cleanup_orphan_leases(&self) -> Result<usize, IndexError> {
        let entries = match std::fs::read_dir(&self.namespace) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(error.into()),
        };
        let mut removed = 0;
        for entry in entries {
            if removed >= limit("lease_cleanup_batch")? {
                break;
            }
            let entry = entry?;
            let name = entry.file_name();
            let Some(stem) = name.to_str().and_then(|name| name.strip_suffix(".sqlite3.lease")) else {
                continue;
            };
            if stem.len() != 64
                || !stem
                    .bytes()
                    .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
            {
                continue;
            }
            let path = self.namespace.join(format!("{stem}.sqlite3"));
            match super::directory_index::remove_orphan_lease(&path) {
                Ok(deleted) => removed += usize::from(deleted),
                Err(IndexError::Io(_)) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(removed)
    }

    fn managed_bytes(&self) -> Result<u64, IndexError> {
        let mut bytes: u64 = 0;
        match std::fs::read_dir(&self.namespace) {
            Ok(entries) => {
                for entry in entries {
                    let metadata = std::fs::symlink_metadata(entry?.path())?;
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(IndexError::Invalid(
                            "Directory-index storage contains links or non-file entries. Select private local storage.",
                        ));
                    }
                    bytes = bytes
                        .checked_add(metadata.len())
                        .ok_or(IndexError::Invalid("Directory disk accounting overflowed."))?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(bytes)
    }

    fn reserve(self: &Arc<Self>) -> Result<DiskReservation, IndexError> {
        let mut state = lock(&self.state)?;
        let mut bytes = self.managed_bytes()?;
        let headroom =
            u64::try_from(limit("write_headroom_bytes")?).map_err(|_| IndexError::Invalid("Directory operation headroom is invalid."))?;
        let mut available_space = None;
        let pressure = bytes
            .checked_add(state.reserved)
            .and_then(|bytes| bytes.checked_add(headroom))
            .ok_or(IndexError::Invalid("Directory disk accounting overflowed."))?
            > u64::try_from(state.policy.disk_budget_bytes).map_err(|_| IndexError::Invalid("Invalid disk budget."))?
            || state
                .reserved
                .checked_add(headroom)
                .ok_or(IndexError::Invalid("Directory disk accounting overflowed."))?
                > {
                    let bytes = (self.space_probe)(&self.namespace)?;
                    available_space = Some(bytes);
                    bytes
                };
        if pressure || Instant::now() >= state.next_cleanup_at {
            self.cleanup_inactive(&state.policy, state.reserved, pressure, epoch_milliseconds()?)?;
            self.cleanup_orphan_leases()?;
            state.next_cleanup_at = Instant::now()
                + Duration::from_secs(
                    u64::try_from(
                        state
                            .policy
                            .inactive_retention_seconds
                            .min(state.policy.degraded_verification_seconds),
                    )
                    .map_err(|_| IndexError::Invalid("Invalid cleanup interval."))?,
                );
            bytes = self.managed_bytes()?;
            available_space = None;
        }
        let required = bytes
            .checked_add(state.reserved)
            .and_then(|bytes| bytes.checked_add(headroom))
            .ok_or(IndexError::Invalid("Directory disk reservation overflowed."))?;
        if required > u64::try_from(state.policy.disk_budget_bytes).map_err(|_| IndexError::Invalid("Directory disk policy is invalid."))? {
            return Err(IndexError::StoragePaused("Directory-index disk headroom is unavailable. Increase the companion disk budget or remove eligible inactive indexes, then retry."));
        }
        let available_space = match available_space {
            Some(bytes) => bytes,
            None => (self.space_probe)(&self.namespace)?,
        };
        if state
            .reserved
            .checked_add(headroom)
            .ok_or(IndexError::Invalid("Directory disk reservation overflowed."))?
            > available_space
        {
            return Err(IndexError::StoragePaused(
                "Directory-index filesystem has insufficient free space. Free disk space or select another cache location, then retry.",
            ));
        }
        state.reserved += headroom;
        Ok(DiskReservation {
            budget: Arc::clone(self),
            bytes: headroom,
        })
    }

    fn policy(&self) -> Result<DirectoryPolicy, IndexError> {
        Ok(lock(&self.state)?.policy.clone())
    }
}

struct DiskReservation {
    budget: Arc<DiskBudget>,
    bytes: u64,
}
impl Drop for DiskReservation {
    fn drop(&mut self) {
        match self.budget.state.lock() {
            Ok(mut state) => state.reserved -= self.bytes,
            Err(_) => log::warn!("Directory disk reservation could not be released. Restart the companion."),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ObservationToken {
    epoch: u64,
    sequence: u64,
    producer: u64,
}

#[derive(Default)]
struct Observations {
    epoch: u64,
    scan_epoch: Option<(i64, u64)>,
    sequence: u64,
    next_producer: u64,
    producers: HashMap<u64, ObservationToken>,
    barriers: Vec<(u64, String)>,
    barrier_bytes: usize,
    uncertain: bool,
    pending: VecDeque<(u64, DirectoryMutation, usize)>,
    bytes: usize,
    verification_required: bool,
    observation_lost: bool,
    invalidation_count: u64,
    scan_group: Option<HashMap<u64, PendingScanParent>>,
    scan_group_reconcile: bool,
    scan_group_bytes: usize,
    scan_group_started: Option<Instant>,
    #[cfg(test)]
    scan_group_test_elapsed: Option<Duration>,
    scan_group_has_changes: bool,
    completed_scan_reads: HashSet<u64>,
    streamed_parent_reads: HashSet<u64>,
    scan_commits: usize,
    scan_issue_counts: HashMap<&'static str, usize>,
    issue_details: HashSet<(String, &'static str)>,
    issue_paths: HashMap<(String, &'static str), String>,
    issue_details_incomplete: bool,
    pending_scan_issues: HashMap<u64, HashMap<&'static str, usize>>,
    pending_issue_paths: HashMap<u64, HashMap<&'static str, String>>,
}

struct PendingScanParent {
    token: ObservationToken,
    generation: i64,
    parent: String,
    children: Vec<(String, bool)>,
    complete: bool,
    preserve_children: bool,
    file_ids: HashMap<String, Vec<u8>>,
}

struct IdentifiedChildren<'a> {
    children: &'a [(String, bool)],
    file_ids: &'a HashMap<String, Vec<u8>>,
}

#[derive(Clone)]
struct NativeScanJob {
    parent: String,
    file_id: Option<Vec<u8>>,
}

enum NativeScanResult<'a> {
    Batch(Arc<NativeParent<'a>>, Vec<(String, bool)>, HashMap<String, Vec<u8>>),
    Issue(TraversalIssue),
    Complete(Arc<NativeParent<'a>>),
    Failed(IndexError),
}

struct NativeScanEvent<'a> {
    job: NativeScanJob,
    read: Arc<ObservationRead>,
    result: NativeScanResult<'a>,
}

fn volume_unavailable_error() -> IndexError {
    std::io::Error::new(
        std::io::ErrorKind::NotConnected,
        "Directory volume is unavailable. Restore the volume and retry the search.",
    )
    .into()
}

#[derive(Clone, Copy, Debug)]
enum InvalidationReason {
    WatcherStart,
    ObservationLoss,
    SourceRebind,
    ReadCapacity,
    StalledRead,
    Lifecycle,
}

impl InvalidationReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::WatcherStart => "watcher_start",
            Self::ObservationLoss => "observation_loss",
            Self::SourceRebind => "source_rebind",
            Self::ReadCapacity => "read_capacity",
            Self::StalledRead => "stalled_read",
            Self::Lifecycle => "lifecycle",
        }
    }

    /// A stalled read loses no watcher events, so it does not make coverage uncertain.
    fn loses_observations(self) -> bool {
        !matches!(self, Self::StalledRead)
    }
}

impl Observations {
    #[cfg(test)]
    fn publish_issue_details(&mut self, parent: &str, counts: &HashMap<&'static str, usize>) -> Result<(), IndexError> {
        self.publish_issue_details_with_paths(parent, counts, &HashMap::new())
    }

    fn publish_issue_details_with_paths(
        &mut self,
        parent: &str,
        counts: &HashMap<&'static str, usize>,
        paths: &HashMap<&'static str, String>,
    ) -> Result<(), IndexError> {
        self.issue_details.retain(|(path, _code)| path != parent);
        self.issue_paths.retain(|key, _| self.issue_details.contains(key));
        let maximum = limit("max_logged_scan_issues_per_pass")?;
        for code in counts.keys() {
            if self.issue_details.len() < maximum {
                self.issue_details.insert((parent.to_owned(), code));
                if let Some(path) = paths.get(code) {
                    self.issue_paths.insert((parent.to_owned(), code), path.clone());
                }
            } else {
                self.issue_details_incomplete = true;
            }
        }
        Ok(())
    }

    fn discard_missing_issue_details(&mut self, index: &DirectoryIndex, generation: i64) -> Result<(), IndexError> {
        let mut missing = HashSet::new();
        for (path, _code) in &self.issue_details {
            if !path.is_empty() && !index.contains_directory(generation, path)? {
                missing.insert(path.clone());
            }
        }
        self.issue_details.retain(|(path, _code)| !missing.contains(path));
        self.issue_paths.retain(|key, _| self.issue_details.contains(key));
        Ok(())
    }

    fn scan_issue_bytes(&self, producer: u64) -> usize {
        self.pending_scan_issues.get(&producer).map_or(0, |counts| {
            counts.iter().map(|(code, count)| code.len() + count.to_string().len()).sum()
        }) + self
            .pending_issue_paths
            .get(&producer)
            .map_or(0, |paths| paths.values().map(String::len).sum::<usize>())
    }

    fn scan_group_elapsed(&self) -> Option<Duration> {
        #[cfg(test)]
        if let Some(elapsed) = self.scan_group_test_elapsed {
            return Some(elapsed);
        }
        self.scan_group_started.map(|started| started.elapsed())
    }

    fn invalidate(&mut self) -> Result<(), IndexError> {
        self.invalidate_for(InvalidationReason::ObservationLoss)
    }

    fn invalidate_for(&mut self, reason: InvalidationReason) -> Result<(), IndexError> {
        self.observation_lost |= matches!(reason, InvalidationReason::ObservationLoss | InvalidationReason::ReadCapacity);
        self.invalidation_count = self.invalidation_count.saturating_add(1);
        log::info!(
            "event=directory_scan_invalidated invalidation_reason={} invalidation_count={}",
            reason.as_str(),
            self.invalidation_count
        );
        self.epoch = self.epoch.checked_add(1).ok_or(IndexError::Invalid(
            "Directory observation epoch is exhausted. Restart the companion.",
        ))?;
        self.barriers.clear();
        self.barrier_bytes = 0;
        self.uncertain |= reason.loses_observations();
        self.verification_required = true;
        Ok(())
    }

    fn begin_read(&mut self) -> Result<ObservationToken, IndexError> {
        if self.producers.len() - self.completed_scan_reads.len() >= limit("max_pending_observations")? || self.next_producer == u64::MAX {
            self.invalidate_for(InvalidationReason::ReadCapacity)?;
            return Err(IndexError::Invalid(
                "Directory read capacity is exhausted. Wait for active reads to finish.",
            ));
        }
        self.next_producer += 1;
        let token = ObservationToken {
            epoch: self.epoch,
            sequence: self.sequence,
            producer: self.next_producer,
        };
        self.producers.insert(token.producer, token);
        Ok(token)
    }

    fn is_current(&self, token: ObservationToken, parent: &str) -> bool {
        self.producers.get(&token.producer) == Some(&token)
            && token.epoch == self.epoch
            && !self
                .barriers
                .iter()
                .any(|(sequence, path)| *sequence > token.sequence && (parent.is_empty() || overlaps(path, parent)))
    }

    fn can_capture(&self, token: ObservationToken) -> bool {
        self.producers.get(&token.producer) == Some(&token)
            && token.epoch == self.epoch
            && !self.uncertain
            && self.pending.is_empty()
            && !self
                .producers
                .values()
                .any(|other| other.epoch == self.epoch && other.producer != token.producer)
    }

    fn end_read(&mut self, token: ObservationToken) {
        let issue_bytes = self.scan_issue_bytes(token.producer);
        if let Some(group) = self.scan_group.as_mut() {
            if let Some(entry) = group.get(&token.producer) {
                if entry.complete {
                    return;
                }
            }
            if let Some(entry) = group.remove(&token.producer) {
                self.scan_group_bytes -= entry.children.iter().map(|(path, _)| path.len()).sum::<usize>();
                self.scan_group_bytes -= entry.parent.len() + entry.file_ids.values().map(Vec::len).sum::<usize>();
                self.scan_group_bytes -= issue_bytes;
            }
        }
        if self.producers.get(&token.producer) == Some(&token) {
            self.streamed_parent_reads.remove(&token.producer);
            self.completed_scan_reads.remove(&token.producer);
            self.pending_scan_issues.remove(&token.producer);
            self.pending_issue_paths.remove(&token.producer);
            self.producers.remove(&token.producer);
            self.retire_barriers();
        }
    }

    fn retire_barriers(&mut self) {
        if self.barriers.is_empty() {
            return;
        }
        let mut oldest = self
            .producers
            .values()
            .filter(|token| token.epoch == self.epoch)
            .map(|token| token.sequence)
            .min()
            .unwrap_or(self.sequence);
        if let Some((sequence, _, _)) = self.pending.front() {
            oldest = oldest.min(sequence.saturating_sub(1));
        }
        self.barriers.retain(|(sequence, _)| *sequence > oldest);
        self.barrier_bytes = self.barriers.iter().map(|(_, path)| path.len()).sum();
    }

    fn enqueue(&mut self, mutation: DirectoryMutation, maximum_pending: usize, maximum_bytes: usize) -> Result<bool, IndexError> {
        let paths = match &mutation {
            DirectoryMutation::Add { path } | DirectoryMutation::Remove { path } | DirectoryMutation::ReadParent { path } => {
                vec![path.as_str()]
            }
            DirectoryMutation::Rename { path, new_path } => vec![path.as_str(), new_path.as_str()],
        };
        let bytes = paths.iter().map(|path| path.len()).sum::<usize>();
        if self.sequence == u64::MAX {
            self.invalidate()?;
            return Err(IndexError::Invalid(
                "Directory observation sequence is exhausted. Restart the companion.",
            ));
        }
        self.sequence += 1;
        self.verification_required = true;
        if self.pending.len() >= maximum_pending || bytes > maximum_bytes.saturating_sub(self.bytes) {
            self.invalidate()?;
            return Ok(false);
        }
        for path in paths {
            let mut prefix = path.to_owned();
            self.barriers.retain(|(_, existing)| {
                if is_prefix(existing, path) {
                    prefix.clone_from(existing);
                    false
                } else {
                    !is_prefix(path, existing)
                }
            });
            self.barriers.push((self.sequence, prefix));
        }
        self.barrier_bytes = self.barriers.iter().map(|(_, path)| path.len()).sum();
        self.pending.push_back((self.sequence, mutation, bytes));
        self.bytes += bytes;
        if self.barriers.len() > maximum_pending || self.barrier_bytes > maximum_bytes {
            self.invalidate()?;
        }
        Ok(true)
    }
}

fn is_prefix(parent: &str, path: &str) -> bool {
    parent.is_empty() || path == parent || path.strip_prefix(parent).is_some_and(|suffix| suffix.starts_with('/'))
}

fn parent_observation(path: &str) -> DirectoryMutation {
    DirectoryMutation::ReadParent {
        path: path.rsplit_once('/').map_or("", |(parent, _)| parent).to_owned(),
    }
}

fn overlaps(first: &str, second: &str) -> bool {
    is_prefix(first, second) || is_prefix(second, first)
}

struct ObservationRead {
    source: Arc<LocalSource>,
    token: ObservationToken,
}

impl Drop for ObservationRead {
    fn drop(&mut self) {
        match self.source.observations.lock() {
            Ok(mut observations) => observations.end_read(self.token),
            Err(_) => log::warn!("Directory read ownership could not be released. Restart the companion."),
        }
    }
}

/// Retain producer ownership until the synchronous mutation worker actually exits.
struct MutationObservation {
    read: ObservationRead,
    parent: String,
    subtree: Option<String>,
    ancestors: bool,
}

impl MutationObservation {
    fn observe(&self) {
        let source = &self.read.source;
        if source.stopped.load(Ordering::Acquire) {
            return;
        }
        let outcome = (|| {
            lock(&source.root)?
                .as_ref()
                .ok_or(IndexError::Invalid("Directory source identity is unavailable."))?
                .verify()?;
            let admitted = lock(&source.observations)?.enqueue(
                DirectoryMutation::ReadParent { path: self.parent.clone() },
                limit("max_pending_observations")?,
                limit("max_observation_bytes")?,
            )?;
            if !admitted {
                return Ok(());
            }
            if self.ancestors {
                let mut parent = self.parent.as_str();
                while !parent.is_empty() {
                    parent = parent.rsplit_once('/').map_or("", |(ancestor, _)| ancestor);
                    if !lock(&source.observations)?.enqueue(
                        DirectoryMutation::ReadParent { path: parent.to_owned() },
                        limit("max_pending_observations")?,
                        limit("max_observation_bytes")?,
                    )? {
                        return Ok(());
                    }
                }
            }
            if let Some(subtree) = &self.subtree {
                let generations = lock(&source.writer)?
                    .as_ref()
                    .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                    .mutation_generations()?;
                for generation in generations {
                    let mut cursor = None;
                    loop {
                        if source.stopped.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        let paths = lock(&source.writer)?
                            .as_ref()
                            .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                            .mutation_subtree_paths(generation, subtree, cursor.as_deref())?;
                        if paths.is_empty() {
                            break;
                        }
                        for path in paths {
                            let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent).to_owned();
                            if !lock(&source.observations)?.enqueue(
                                DirectoryMutation::ReadParent { path: parent },
                                limit("max_pending_observations")?,
                                limit("max_observation_bytes")?,
                            )? {
                                return Ok(());
                            }
                            cursor = Some(path);
                        }
                    }
                }
            }
            Ok::<(), IndexError>(())
        })();
        if outcome.is_err() {
            if source.invalidate().is_err() {
                log::warn!("Directory mutation observations could not be invalidated. Restart the companion.");
            }
            log::warn!("Directory mutation reconciliation was not queued. Check drive access and retry verification.");
        }
    }
}

impl Drop for MutationObservation {
    fn drop(&mut self) {
        self.observe();
    }
}

const INDEX_OPENING_STATE: &str = "opening";

struct SourceStatus {
    state: &'static str,
    message: Option<String>,
    progress: Instant,
    verified: Instant,
    accessed: Instant,
    accessed_at_ms: Option<i64>,
    retry_at: Instant,
    failure_delay: Duration,
    verification_jitter: u8,
    stalled: bool,
    watcher_retry_at: Instant,
    watcher_failure_delay: Duration,
    scan_progress: Option<ScanProgress>,
    index_status: Option<super::directory_index::DirectoryIndexSearch>,
    scan_generation: Option<i64>,
}

impl SourceStatus {
    fn retry_after_ms(&self) -> Option<u64> {
        let now = Instant::now();
        [self.retry_at, self.watcher_retry_at]
            .into_iter()
            .filter(|deadline| *deadline > now)
            .map(|deadline| u64::try_from(deadline.duration_since(now).as_millis()).unwrap_or(u64::MAX).max(1))
            .min()
    }

    fn schedule_retry(&mut self, now: Instant, jitter: u8) {
        self.failure_delay = if self.failure_delay.is_zero() {
            FAILURE_RETRY_MIN
        } else {
            self.failure_delay.saturating_mul(2).min(FAILURE_RETRY_MAX)
        };
        let percent = 100 - FAILURE_RETRY_JITTER_PERCENT + jitter % (FAILURE_RETRY_JITTER_PERCENT * 2 + 1);
        let delay = self
            .failure_delay
            .mul_f64(f64::from(percent) / 100.0)
            .clamp(FAILURE_RETRY_MIN, FAILURE_RETRY_MAX);
        self.retry_at = now + delay;
    }

    fn verification_due(&self, now: Instant, interval: Duration, initialized: bool) -> bool {
        let percent = 100 - self.verification_jitter % (PERIODIC_VERIFICATION_JITTER_PERCENT + 1);
        let interval = interval.mul_f64(f64::from(percent) / 100.0);
        now >= self.retry_at && (!initialized || !self.failure_delay.is_zero() || now.saturating_duration_since(self.verified) >= interval)
    }

    fn complete_pass(&mut self, now: Instant) {
        self.verified = now;
        self.retry_at = now;
        self.failure_delay = Duration::ZERO;
    }
}

struct LocalSource {
    root_path: PathBuf,
    index_path: PathBuf,
    source_id: String,
    session: String,
    volume: Mutex<VolumeEvidence>,
    root: Mutex<Option<Arc<NativeRoot>>>,
    io: Arc<NativeIo>,
    writer: Mutex<Option<DirectoryIndex>>,
    reader: Mutex<Option<DirectoryIndexReader>>,
    observations: Mutex<Observations>,
    status: Mutex<SourceStatus>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    watcher_failed: AtomicBool,
    watcher_reconciling: AtomicBool,
    busy: AtomicBool,
    flush_busy: AtomicBool,
    reclamation_pending: AtomicBool,
    active_queries: AtomicUsize,
    stopped: AtomicBool,
    root_invalid: AtomicBool,
    recovery_attempted: AtomicBool,
    capability_failed: AtomicBool,
    media_unavailable: AtomicBool,
    removal_drain: (Mutex<()>, Condvar),
    #[cfg(windows)]
    removal_watch: Mutex<Option<removal_windows::RemovalWatch>>,
    next_full_pass: Mutex<Option<Instant>>,
    finished: Notify,
}

#[derive(Clone, Copy)]
struct ScanGeneration {
    id: i64,
    read: ObservationToken,
}

impl LocalSource {
    fn close_idle(&self, budget: &Arc<DiskBudget>) -> Result<(), IndexError> {
        let mut writer = lock(&self.writer)?.take();
        if let (Some(index), Some(accessed)) = (writer.as_mut(), lock(&self.status)?.accessed_at_ms) {
            match budget.reserve() {
                Ok(_reservation) => {
                    if index.touch_access(accessed).is_err() {
                        log::warn!("Directory last-access time could not be saved. Closed cache data can be rebuilt after cleanup.");
                    }
                }
                Err(_) => log::warn!("Directory last-access time could not be saved. Closed cache data can be rebuilt after cleanup."),
            }
        }
        lock(&self.reader)?.take();
        lock(&self.watcher)?.take();
        lock(&self.root)?.take();
        #[cfg(windows)]
        lock(&self.removal_watch)?.take();
        drop(writer);
        Ok(())
    }

    fn ensure_available(&self) -> Result<(), IndexError> {
        if self.media_unavailable.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "Directory volume is temporarily unavailable. Insert or mount the volume to resume search.",
            )
            .into());
        }
        if self.stopped.load(Ordering::Acquire) {
            return Err(IndexError::Invalid(
                "Directory source was replaced or stopped. Retry the search on the current drive.",
            ));
        }
        Ok(())
    }

    fn touch(&self) -> Result<(), IndexError> {
        let now = Instant::now();
        let accessed_at_ms = epoch_milliseconds()?;
        let mut status = lock(&self.status)?;
        status.accessed = now;
        status.accessed_at_ms = Some(accessed_at_ms);
        Ok(())
    }

    #[cfg(test)]
    fn new(root_path: PathBuf, namespace: &Path) -> Arc<Self> {
        let evidence = volume_evidence(&root_path).unwrap_or_default();
        Self::with_volume(root_path, namespace, evidence)
    }

    fn with_volume(root_path: PathBuf, namespace: &Path, mut evidence: VolumeEvidence) -> Arc<Self> {
        let session = uuid::Uuid::new_v4().to_string();
        let source_id = format!("{:x}", Sha256::digest(root_path.as_os_str().as_encoded_bytes()));
        let verification_jitter = Sha256::digest(session.as_bytes())[0];
        let identity =
            json!({"kind": "local", "root": hex::encode(root_path.as_os_str().as_encoded_bytes()), "volume": evidence.index_volume()});
        let filename = format!("{:x}.sqlite3", Sha256::digest(identity.to_string().as_bytes()));
        let mut index_path = namespace.join(filename);
        if !index_path.exists() || cfg!(target_os = "linux") && !evidence.separate_mount {
            if let Some((path, previous)) = Self::retained_boundary(namespace, &root_path, &evidence) {
                index_path = path;
                evidence.retain_available(&previous);
                evidence.separate_mount |= previous.separate_mount;
            }
        }
        let now = Instant::now();
        Arc::new(Self {
            root_path,
            index_path,
            source_id,
            session,
            volume: Mutex::new(evidence),
            root: Mutex::new(None),
            io: Arc::default(),
            writer: Mutex::new(None),
            reader: Mutex::new(None),
            watcher: Mutex::new(None),
            watcher_failed: AtomicBool::new(false),
            watcher_reconciling: AtomicBool::new(true),
            observations: Mutex::new(Observations::default()),
            status: Mutex::new(SourceStatus {
                state: INDEX_OPENING_STATE,
                message: None,
                progress: now,
                verified: now,
                accessed: now,
                accessed_at_ms: None,
                retry_at: now,
                failure_delay: Duration::ZERO,
                verification_jitter,
                stalled: false,
                watcher_retry_at: now,
                watcher_failure_delay: Duration::ZERO,
                scan_progress: None,
                index_status: None,
                scan_generation: None,
            }),
            busy: AtomicBool::new(false),
            flush_busy: AtomicBool::new(false),
            reclamation_pending: AtomicBool::new(false),
            recovery_attempted: AtomicBool::new(false),
            capability_failed: AtomicBool::new(false),
            media_unavailable: AtomicBool::new(false),
            removal_drain: (Mutex::new(()), Condvar::new()),
            #[cfg(windows)]
            removal_watch: Mutex::new(None),
            next_full_pass: Mutex::new(None),
            active_queries: AtomicUsize::new(0),
            stopped: AtomicBool::new(false),
            root_invalid: AtomicBool::new(false),
            finished: Notify::new(),
        })
    }

    fn retained_boundary(namespace: &Path, root: &Path, current: &VolumeEvidence) -> Option<(PathBuf, VolumeEvidence)> {
        let entries = std::fs::read_dir(namespace).ok()?;
        let root = hex::encode(root.as_os_str().as_encoded_bytes());
        let mut retained = None;
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name();
            let Some(stem) = name.to_str().and_then(|name| name.strip_suffix(".sqlite3")) else {
                continue;
            };
            if stem.len() != 64 || !stem.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                continue;
            }
            let Ok(database) = open_readonly_directory_database(&entry.path()) else {
                continue;
            };
            let Ok((kind, identity, accessed)) = database.query_row(
                "SELECT source_kind, source_identity, last_access_at_ms FROM source_metadata WHERE id = 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
            ) else {
                continue;
            };
            let Ok(identity) = serde_json::from_str::<Value>(&identity) else {
                continue;
            };
            if kind != "local"
                || identity.get("root").and_then(Value::as_str) != Some(root.as_str())
                || identity.get("platform").and_then(Value::as_str) != Some(std::env::consts::OS)
            {
                continue;
            }
            let Some(previous) = identity
                .get("evidence")
                .cloned()
                .and_then(|value| serde_json::from_value::<VolumeEvidence>(value).ok())
            else {
                continue;
            };
            if previous.compare(current) == VolumeChange::Index {
                continue;
            }
            if retained
                .as_ref()
                .is_none_or(|(_, _, last): &(PathBuf, VolumeEvidence, i64)| accessed > *last)
            {
                retained = Some((entry.path(), previous, accessed));
            }
        }
        retained.map(|(path, evidence, _)| (path, evidence))
    }

    fn progress(&self) -> Result<(), IndexError> {
        self.ensure_available()?;
        lock(&self.status)?.progress = Instant::now();
        Ok(())
    }

    fn release_media_handles(&self) -> Result<(), IndexError> {
        self.media_unavailable.store(true, Ordering::Release);
        self.invalidate_for(InvalidationReason::Lifecycle)?;
        lock(&self.watcher)?.take();
        lock(&self.root)?.take();
        {
            let mut status = lock(&self.status)?;
            status.state = "ready";
            status.message = Some("Directory volume is temporarily unavailable. Insert or mount the volume to resume search.".into());
            status.retry_at = Instant::now() + FAILURE_RETRY_MIN;
        }
        Ok(())
    }

    #[cfg(any(windows, test))]
    fn pause_for_removal(&self) -> Result<bool, IndexError> {
        self.release_media_handles()?;
        let guard = lock(&self.removal_drain.0)?;
        let (_guard, timeout) = self
            .removal_drain
            .1
            .wait_timeout_while(guard, STALLED_READ_TIMEOUT, |_| {
                self.busy.load(Ordering::Acquire)
                    || self.flush_busy.load(Ordering::Acquire)
                    || self.active_queries.load(Ordering::Acquire) != 0
            })
            .map_err(|_| IndexError::Invalid("Directory removal state is unavailable. Restart the companion before removing the drive."))?;
        Ok(!timeout.timed_out())
    }

    fn notify_worker_exit(&self) {
        if let Ok(_guard) = self.removal_drain.0.lock() {
            self.removal_drain.1.notify_all();
        }
        let release = (|| -> Result<(), IndexError> {
            if lock(&self.volume)?.removable()
                && lock(&self.watcher)?.is_none()
                && !self.busy.load(Ordering::Acquire)
                && !self.flush_busy.load(Ordering::Acquire)
                && self.active_queries.load(Ordering::Acquire) == 0
                && lock(&self.observations)?.producers.is_empty()
            {
                lock(&self.root)?.take();
                #[cfg(windows)]
                lock(&self.removal_watch)?.take();
            }
            Ok(())
        })();
        if release.is_err() {
            log::warn!("Idle directory media handles could not be released. Restart the companion before removing the drive.");
        }
    }

    fn fail(&self, error: &IndexError, _budget: &DiskBudget) {
        if matches!(error, IndexError::Io(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotConnected | std::io::ErrorKind::NotADirectory))
            && lock(&self.volume).is_ok_and(|volume| volume.removable())
            && self.release_media_handles().is_err()
        {
            log::warn!("Directory media handles could not be released. Restart the companion before removing the drive.");
        }
        if matches!(error, IndexError::Invalid(message) if *message == MOUNT_BOUNDARY_CAPABILITY_ERROR) {
            self.capability_failed.store(true, Ordering::Release);
        }
        if matches!(error, IndexError::Interrupted) {
            if let Ok(mut status) = self.status.lock() {
                status.state = "ready";
            }
            return;
        }
        if matches!(error, IndexError::StoragePaused(_)) {
            self.reclamation_pending.store(true, Ordering::Release);
        }
        let message = match error {
            IndexError::Invalid(message) | IndexError::RebuildRequired(message) | IndexError::StoragePaused(message) => {
                (*message).to_owned()
            }
            _ => "Directory verification failed. Check drive access and private local storage, then retry.".to_owned(),
        };
        if let Ok(mut status) = self.status.lock() {
            if status.failure_delay.is_zero() {
                let (error_type, os_code, sqlite_code) = match error {
                    IndexError::Io(cause) => ("Io", cause.raw_os_error(), None),
                    IndexError::SourceItem(_) => ("SourceItem", None, None),
                    IndexError::Sql(cause) => ("Sql", None, cause.sqlite_error().map(|code| code.extended_code)),
                    IndexError::Invalid(_) => ("Invalid", None, None),
                    IndexError::RebuildRequired(_) => ("RebuildRequired", None, None),
                    IndexError::StoragePaused(_) => ("StoragePaused", None, None),
                    IndexError::QueryBusy => ("QueryBusy", None, None),
                    IndexError::Interrupted => ("Interrupted", None, None),
                };
                log::warn!(
                    "event=directory_verification_unavailable operation=directory_index stage=verification source_id={} generation_id={} error_type={error_type} os_code={os_code:?} sqlite_code={sqlite_code:?}",
                    self.source_id, self.session
                );
            }
            status.state = "ready";
            status.message = Some(message);
            status.schedule_retry(Instant::now(), Sha256::digest(self.session.as_bytes())[0]);
            log::debug!(
                "event=directory_retry_scheduled operation=directory_index stage=verification source_id={} generation_id={} retry_after_ms={}",
                self.source_id, self.session, status.retry_after_ms().unwrap_or_default()
            );
        }
    }

    fn invalidate(&self) -> Result<(), IndexError> {
        lock(&self.observations)?.invalidate()
    }

    fn invalidate_for(&self, reason: InvalidationReason) -> Result<(), IndexError> {
        lock(&self.observations)?.invalidate_for(reason)
    }

    fn begin_read(self: &Arc<Self>) -> Result<ObservationRead, IndexError> {
        let token = lock(&self.observations)?.begin_read()?;
        Ok(ObservationRead {
            source: Arc::clone(self),
            token,
        })
    }

    fn observe(&self, event: Result<Event, notify::Error>) -> Result<(), IndexError> {
        let Ok(event) = event else {
            return self.lose_watcher().map(|_| ());
        };
        if event.need_rescan() {
            return self.invalidate();
        }
        if event.paths.len() > limit("max_pending_observations")? {
            return self.invalidate();
        }
        if matches!(
            event.kind,
            EventKind::Create(CreateKind::File)
                | EventKind::Remove(RemoveKind::File)
                | EventKind::Modify(ModifyKind::Data(_))
                | EventKind::Access(_)
        ) {
            return Ok(());
        }
        let relative = |path: &Path| -> Result<String, IndexError> {
            let relative = path
                .strip_prefix(&self.root_path)
                .map_err(|_| IndexError::Invalid("Directory observation is outside its bound source."))?;
            let text = relative
                .to_str()
                .ok_or(IndexError::Invalid("Directory observation uses an unsupported native encoding."))?;
            if text.len() > limit("max_observation_bytes")? {
                return Err(IndexError::Invalid("Directory observation exceeds the pending byte limit."));
            }
            #[cfg(windows)]
            let text = text.replace('\\', "/");
            let text = text.to_owned();
            validate_directory_path(&text)?;
            Ok(text)
        };
        let maximum_pending = limit("max_pending_observations")?;
        let maximum_bytes = limit("max_observation_bytes")?;
        let mut observations = lock(&self.observations)?;
        let mut enqueue = |mutation| observations.enqueue(mutation, maximum_pending, maximum_bytes);
        match event.kind {
            EventKind::Create(CreateKind::Folder) => {
                for path in &event.paths {
                    if !enqueue(DirectoryMutation::Add { path: relative(path)? })? {
                        break;
                    }
                }
            }
            EventKind::Remove(RemoveKind::Folder) => {
                for path in &event.paths {
                    if !enqueue(DirectoryMutation::Remove { path: relative(path)? })? {
                        break;
                    }
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                for path in &event.paths {
                    let path = relative(path)?;
                    if !enqueue(DirectoryMutation::Remove { path: path.clone() })? || !enqueue(parent_observation(&path))? {
                        break;
                    }
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() == 2 => {
                let old = relative(&event.paths[0])?;
                let new = relative(&event.paths[1])?;
                if enqueue(DirectoryMutation::Rename {
                    path: old.clone(),
                    new_path: new.clone(),
                })? && enqueue(parent_observation(&old))?
                {
                    enqueue(parent_observation(&new))?;
                }
            }
            EventKind::Create(CreateKind::Any)
            | EventKind::Remove(RemoveKind::Any)
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Modify(ModifyKind::Name(_)) => {
                for path in &event.paths {
                    if !enqueue(parent_observation(&relative(path)?))? {
                        break;
                    }
                }
            }
            EventKind::Modify(ModifyKind::Metadata(_)) => return Ok(()),
            _ => return observations.invalidate(),
        }
        Ok(())
    }

    fn lose_watcher(&self) -> Result<bool, IndexError> {
        let changed = !self.watcher_failed.swap(true, Ordering::AcqRel);
        if changed {
            log::warn!(
                "event=directory_watcher_lost operation=directory_index stage=watcher source_id={} generation_id={} Directory observations were lost. Background verification is required.",
                self.source_id, self.session
            );
        }
        self.invalidate()?;
        Ok(changed)
    }

    fn recover_watcher(self: &Arc<Self>) -> Result<(), IndexError> {
        #[cfg(windows)]
        if lock(&self.volume)?.removable() && !self.media_unavailable.load(Ordering::Acquire) {
            let mut monitor = lock(&self.removal_watch)?;
            if monitor.is_none() {
                *monitor = Some(removal_windows::RemovalWatch::new(self)?);
            }
        }
        let mut active = lock(&self.watcher)?;
        if self.stopped.load(Ordering::Acquire)
            || (active.is_some() && !self.watcher_failed.load(Ordering::Acquire))
            || Instant::now() < lock(&self.status)?.watcher_retry_at
        {
            return Ok(());
        }
        active.take();
        if !self.watcher_failed.load(Ordering::Acquire) {
            self.invalidate_for(InvalidationReason::WatcherStart)?;
        }
        self.watcher_failed.store(false, Ordering::Release);
        self.watcher_reconciling.store(true, Ordering::Release);
        let weak = Arc::downgrade(self);
        let outcome = notify::recommended_watcher(move |event| {
            if let Some(source) = weak.upgrade() {
                if source.observe(event).is_err() {
                    let _ = source.lose_watcher();
                }
            }
        })
        .and_then(|mut watcher| {
            watcher.watch(&self.root_path, RecursiveMode::Recursive)?;
            Ok(watcher)
        });
        match outcome {
            Ok(watcher) => {
                *active = Some(watcher);
                self.invalidate_for(InvalidationReason::WatcherStart)?;
                let mut status = lock(&self.status)?;
                status.watcher_failure_delay = Duration::ZERO;
                status.watcher_retry_at = Instant::now();
                log::info!(
                    "event=directory_watcher_reconciling operation=directory_index stage=watcher source_id={} generation_id={}",
                    self.source_id,
                    self.session
                );
            }
            Err(_) => {
                self.watcher_failed.store(true, Ordering::Release);
                let mut status = lock(&self.status)?;
                status.watcher_failure_delay = if status.watcher_failure_delay.is_zero() {
                    FAILURE_RETRY_MIN
                } else {
                    status.watcher_failure_delay.saturating_mul(2).min(FAILURE_RETRY_MAX)
                };
                let percent = 100 - FAILURE_RETRY_JITTER_PERCENT + status.verification_jitter % (FAILURE_RETRY_JITTER_PERCENT * 2 + 1);
                let delay = status
                    .watcher_failure_delay
                    .mul_f64(f64::from(percent) / 100.0)
                    .clamp(FAILURE_RETRY_MIN, FAILURE_RETRY_MAX);
                status.watcher_retry_at = Instant::now() + delay;
                status.message = Some("Directory monitoring is unavailable. Background verification remains active.".to_owned());
                if status.watcher_failure_delay == FAILURE_RETRY_MIN {
                    log::warn!(
                        "event=directory_watcher_unavailable operation=directory_index stage=watcher source_id={} generation_id={} retry_after_ms={} error_type=NotifyError",
                        self.source_id, self.session, delay.as_millis()
                    );
                }
            }
        }
        Ok(())
    }

    fn flush(&self, budget: &Arc<DiskBudget>) -> Result<(), IndexError> {
        let mut observations = lock(&self.observations)?;
        if !observations.uncertain && observations.pending.is_empty() && !self.reclamation_pending.load(Ordering::Acquire) {
            if !self.busy.load(Ordering::Acquire) && self.active_queries.load(Ordering::Acquire) == 0 {
                let writer = lock(&self.writer)?;
                if let Some(writer) = writer.as_ref() {
                    if writer.reconciliation_generation()?.is_none() && writer.checkpoint_due()? {
                        let _reservation = budget.reserve()?;
                        writer.checkpoint_if_due()?;
                    }
                }
            }
            return Ok(());
        }
        let mut writer_guard = lock(&self.writer)?;
        let Some(writer) = writer_guard.as_mut() else {
            return Ok(());
        };
        if writer.needs_fts_repair() {
            return Ok(());
        }
        let _reservation = budget.reserve()?;
        if observations.uncertain {
            writer.mark_uncertain()?;
            observations.uncertain = false;
        }
        for _ in 0..ROW_BATCH_SIZE {
            let Some((_, mutation, bytes)) = observations.pending.front() else {
                break;
            };
            writer.mutate_observed_path(mutation)?;
            let bytes = *bytes;
            if let DirectoryMutation::Remove { path } = mutation {
                let prefix = format!("{path}/");
                let path = path.clone();
                observations
                    .issue_details
                    .retain(|(parent, _code)| parent != &path && !parent.starts_with(&prefix));
            }
            observations.bytes -= bytes;
            observations.pending.pop_front();
        }
        observations.retire_barriers();
        let reconciliation_pending = writer.reconciliation_generation()?.is_some();

        if !reconciliation_pending
            && observations.pending.is_empty()
            && !self.busy.load(Ordering::Acquire)
            && self.active_queries.load(Ordering::Acquire) == 0
            && self.reclamation_pending.load(Ordering::Acquire)
        {
            self.reclamation_pending.store(!writer.reclaim_pages()?, Ordering::Release);
        }
        if !reconciliation_pending
            && observations.pending.is_empty()
            && !self.busy.load(Ordering::Acquire)
            && self.active_queries.load(Ordering::Acquire) == 0
        {
            writer.checkpoint_if_due()?;
        }
        lock(&self.status)?.index_status = Some(writer.status()?);
        drop(_reservation);
        drop(writer_guard);
        drop(observations);
        Ok(())
    }

    #[cfg(test)]
    fn commit_children(
        &self,
        root: &NativeRoot,
        parent: &str,
        parent_identity: NativeIdentity,
        scan: ScanGeneration,
        children: &[(String, bool)],
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        let source_read = root.open_parent(parent)?;
        if source_read.identity != parent_identity {
            return Err(IndexError::Invalid(
                "Directory parent changed during scanning. Retry source verification.",
            ));
        }
        self.commit_identified_children(
            root,
            parent,
            &source_read,
            scan,
            IdentifiedChildren {
                children,
                file_ids: &HashMap::new(),
            },
            budget,
        )
    }

    fn commit_identified_children(
        &self,
        root: &NativeRoot,
        parent: &str,
        source_read: &NativeParent<'_>,
        scan: ScanGeneration,
        batch: IdentifiedChildren<'_>,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        let IdentifiedChildren { children, file_ids } = batch;
        self.verify_native_publication(root, parent, source_read)?;
        let mut observations = lock(&self.observations)?;
        if !observations.is_current(scan.read, parent) || self.stopped.load(Ordering::Acquire) {
            return Err(IndexError::Interrupted);
        }
        if observations.scan_group.is_some() {
            let bytes = children.iter().map(|(path, _)| path.len()).sum::<usize>() + file_ids.values().map(Vec::len).sum::<usize>();
            let has_changes = lock(&self.writer)?
                .as_ref()
                .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                .scan_parents_have_changes(
                    scan.id,
                    &[(parent.to_owned(), children.to_vec())],
                    &HashSet::from([parent.to_owned()]),
                )?;
            self.stage_scan_parent_locked(&mut observations, scan, parent, has_changes, bytes, budget)?;
            if let Some(group) = observations.scan_group.as_mut() {
                let entry = group
                    .get_mut(&scan.read.producer)
                    .ok_or(IndexError::Invalid("Buffered scan parent is unavailable. Retry verification."))?;
                entry.children.extend_from_slice(children);
                entry.file_ids.extend(file_ids.clone());
            }
            self.flush_scan_group_if_due_locked(&mut observations, budget)?;
            return Ok(());
        }
        let _reservation = budget.reserve()?;
        let mut writer = lock(&self.writer)?;
        let writer = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
        let accepted = writer.accepted_generation()? == Some(scan.id);
        if accepted {
            writer.write_scan_parent_batch(
                scan.id,
                parent,
                children,
                file_ids,
                !observations.streamed_parent_reads.contains(&scan.read.producer),
                true,
            )?;
            observations.streamed_parent_reads.insert(scan.read.producer);
        } else {
            writer.write_children(scan.id, children.iter().cloned(), None, file_ids)?;
        }
        Ok(())
    }

    fn stage_scan_parent_locked(
        &self,
        observations: &mut Observations,
        scan: ScanGeneration,
        parent: &str,
        has_changes: bool,
        bytes: usize,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        let issue_bytes = observations.scan_issue_bytes(scan.read.producer);
        let group = observations.scan_group.as_mut().ok_or(IndexError::Invalid(
            "Scan grouping is not active. Start scan groups before buffering a parent.",
        ))?;
        let promote = has_changes && !observations.scan_group_has_changes && group.len() >= limit("scan_commit_max_parents")?;
        let carried = if promote { group.remove(&scan.read.producer) } else { None };
        if let Some(entry) = &carried {
            observations.scan_group_bytes -= entry.parent.len()
                + entry.children.iter().map(|(path, _)| path.len()).sum::<usize>()
                + entry.file_ids.values().map(Vec::len).sum::<usize>()
                + issue_bytes;
        }
        let parent_bytes = if group.contains_key(&scan.read.producer) {
            0
        } else {
            parent.len() + issue_bytes
        };
        if promote || observations.scan_group_bytes.saturating_add(parent_bytes).saturating_add(bytes) > limit("max_observation_bytes")? {
            self.flush_scan_group_locked(observations, budget)?;
        }
        let group = observations
            .scan_group
            .as_mut()
            .ok_or(IndexError::Invalid("Scan grouping is not active. Retry verification."))?;
        if group.is_empty() {
            observations.scan_group_started = Some(Instant::now());
        }
        if let std::collections::hash_map::Entry::Vacant(slot) = group.entry(scan.read.producer) {
            let entry = carried.unwrap_or_else(|| PendingScanParent {
                token: scan.read,
                generation: scan.id,
                parent: parent.to_owned(),
                children: Vec::new(),
                complete: false,
                preserve_children: false,
                file_ids: HashMap::new(),
            });
            observations.scan_group_bytes += entry.parent.len()
                + entry.children.iter().map(|(path, _)| path.len()).sum::<usize>()
                + entry.file_ids.values().map(Vec::len).sum::<usize>()
                + issue_bytes;
            slot.insert(entry);
        }
        observations.scan_group_bytes += bytes;
        observations.scan_group_has_changes |= has_changes;
        Ok(())
    }

    fn complete_scan_parent_locked(
        &self,
        observations: &mut Observations,
        scan: ScanGeneration,
        parent: &str,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        let children = observations
            .scan_group
            .as_ref()
            .and_then(|group| group.get(&scan.read.producer))
            .map(|entry| entry.children.clone())
            .unwrap_or_default();
        let partial = if observations
            .scan_group
            .as_ref()
            .and_then(|group| group.get(&scan.read.producer))
            .is_some_and(|entry| entry.preserve_children)
        {
            HashSet::from([parent.to_owned()])
        } else {
            HashSet::new()
        };
        let streamed = if observations.streamed_parent_reads.contains(&scan.read.producer) {
            HashSet::from([parent.to_owned()])
        } else {
            HashSet::new()
        };
        let has_changes = lock(&self.writer)?
            .as_ref()
            .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
            .scan_parent_snapshots_have_changes(scan.id, &[(parent.to_owned(), children)], &partial, &streamed)?;
        self.stage_scan_parent_locked(observations, scan, parent, has_changes, 0, budget)?;
        if let Some(entry) = observations
            .scan_group
            .as_mut()
            .and_then(|group| group.get_mut(&scan.read.producer))
        {
            entry.complete = true;
        }
        observations.completed_scan_reads.insert(scan.read.producer);
        self.flush_scan_group_if_due_locked(observations, budget)
    }

    fn flush_scan_group_if_due_locked(&self, observations: &mut Observations, budget: &Arc<DiskBudget>) -> Result<(), IndexError> {
        let (cap, interval) = if observations.scan_group_has_changes {
            (
                limit("scan_commit_max_parents")?,
                Duration::from_millis(limit("scan_commit_interval_ms")? as u64),
            )
        } else {
            (
                limit("scan_bookkeeping_commit_max_parents")?,
                Duration::from_millis(limit("scan_bookkeeping_commit_interval_ms")? as u64),
            )
        };
        if observations.completed_scan_reads.len() >= cap
            || observations.scan_group_bytes >= limit("max_observation_bytes")?
            || observations.scan_group_elapsed().is_some_and(|elapsed| elapsed >= interval)
        {
            self.flush_scan_group_locked(observations, budget)?;
        }
        Ok(())
    }

    fn flush_scan_group_locked(&self, observations: &mut Observations, budget: &Arc<DiskBudget>) -> Result<(), IndexError> {
        let Some(group) = observations.scan_group.as_mut() else {
            return Ok(());
        };
        if group.is_empty() {
            return Ok(());
        }
        let pending = std::mem::take(group);
        observations.scan_group_bytes = 0;
        let outcome = (|| {
            let _reservation = budget.reserve()?;
            let mut writer = lock(&self.writer)?;
            let writer = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
            let mut complete: HashMap<i64, Vec<super::directory_index::ScanParentResult>> = HashMap::new();
            let mut file_ids: HashMap<i64, HashMap<String, Vec<u8>>> = HashMap::new();
            let mut partial_parents: HashMap<i64, HashSet<String>> = HashMap::new();
            let mut streamed_parents: HashMap<i64, HashSet<String>> = HashMap::new();
            let mut issues: HashMap<i64, super::directory_index::ScanParentIssues> = HashMap::new();
            let mut issue_paths = HashMap::<_, HashMap<_, _>>::new();
            let mut stale_epoch = false;
            let mut ordered: Vec<_> = pending.values().collect();
            ordered.sort_unstable_by_key(|entry| entry.token.producer);
            for entry in ordered {
                if !observations.is_current(entry.token, &entry.parent) {
                    if observations.scan_group_reconcile {
                        writer.defer_reconciliation_parent(entry.generation, &entry.parent)?;
                    } else {
                        writer.defer_scan_parent(entry.generation, &entry.parent)?;
                    }
                    stale_epoch |= entry.token.epoch != observations.epoch;
                } else if entry.complete {
                    if let Some(counts) = observations.pending_scan_issues.get(&entry.token.producer) {
                        issues
                            .entry(entry.generation)
                            .or_default()
                            .insert(entry.parent.clone(), counts.clone());
                    }
                    if let Some(paths) = observations.pending_issue_paths.get(&entry.token.producer) {
                        issue_paths
                            .entry(entry.generation)
                            .or_default()
                            .insert(entry.parent.clone(), paths.clone());
                    }
                    if observations.streamed_parent_reads.contains(&entry.token.producer) {
                        streamed_parents.entry(entry.generation).or_default().insert(entry.parent.clone());
                    }
                    if entry.preserve_children {
                        partial_parents.entry(entry.generation).or_default().insert(entry.parent.clone());
                    }
                    file_ids.entry(entry.generation).or_default().extend(entry.file_ids.clone());
                    complete
                        .entry(entry.generation)
                        .or_default()
                        .push((entry.parent.clone(), entry.children.clone()));
                } else {
                    let reset = !observations.streamed_parent_reads.contains(&entry.token.producer);
                    for (offset, children) in entry.children.chunks(ROW_BATCH_SIZE).enumerate() {
                        writer.write_scan_parent_batch(
                            entry.generation,
                            &entry.parent,
                            children,
                            &entry.file_ids,
                            reset && offset == 0,
                            observations.scan_group_reconcile,
                        )?;
                        observations.streamed_parent_reads.insert(entry.token.producer);
                    }
                }
            }
            for (generation, results) in complete {
                writer.commit_parent_snapshots_with_issues(
                    generation,
                    &results,
                    &file_ids[&generation],
                    partial_parents.get(&generation).unwrap_or(&HashSet::new()),
                    streamed_parents.get(&generation).unwrap_or(&HashSet::new()),
                    super::directory_index::ScanCommitOptions {
                        reconcile: observations.scan_group_reconcile,
                        issues: issues.get(&generation),
                    },
                )?;
                for (parent, _children) in &results {
                    observations.publish_issue_details_with_paths(
                        parent,
                        issues
                            .get(&generation)
                            .and_then(|parents| parents.get(parent))
                            .unwrap_or(&HashMap::new()),
                        issue_paths
                            .get(&generation)
                            .and_then(|parents| parents.get(parent))
                            .unwrap_or(&HashMap::new()),
                    )?;
                }
                observations.discard_missing_issue_details(writer, generation)?;
                observations.scan_commits += 1;
            }
            let mut status = lock(&self.status)?;
            status.index_status = Some(writer.status()?);
            if let Some(generation) = status.scan_generation {
                let (done, queued, found) = writer.scan_counts(generation)?;
                if let Some(progress) = status.scan_progress.as_mut() {
                    progress.parents_done = done;
                    progress.parents_queued = queued;
                    progress.directories_found = found;
                }
            }
            if stale_epoch {
                return Err(IndexError::Interrupted);
            }
            Ok(())
        })();
        for entry in pending.values() {
            if entry.complete {
                observations.end_read(entry.token);
            }
        }
        observations.scan_group_started = None;
        observations.scan_group_has_changes = false;
        outcome
    }

    fn cancel_scan_groups(&self) -> Result<(), IndexError> {
        let mut observations = lock(&self.observations)?;
        if let Some(group) = observations.scan_group.take() {
            for entry in group.values() {
                observations.end_read(entry.token);
            }
        }
        observations.scan_group_bytes = 0;
        observations.scan_group_reconcile = false;
        observations.scan_group_started = None;
        observations.scan_group_has_changes = false;
        Ok(())
    }

    #[cfg(test)]
    fn prune_missing_children(
        &self,
        root: &NativeRoot,
        parent: &str,
        parent_identity: NativeIdentity,
        scan: ScanGeneration,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        let source_read = root.open_parent(parent)?;
        if source_read.identity != parent_identity {
            return Err(IndexError::Invalid(
                "Directory parent changed during scanning. Retry source verification.",
            ));
        }
        self.prune_parent_children(&source_read, parent, scan, budget)
    }

    #[cfg(test)]
    fn prune_parent_children(
        &self,
        source_read: &NativeParent<'_>,
        parent: &str,
        scan: ScanGeneration,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        let prefix = if parent.is_empty() { String::new() } else { format!("{parent}/") };
        let mut cursor: Option<String> = None;
        loop {
            self.progress()?;
            source_read.verify().map_err(source_error)?;
            let paths = {
                let observations = lock(&self.observations)?;
                if self.stopped.load(Ordering::Acquire) || !observations.is_current(scan.read, parent) {
                    return Err(IndexError::Interrupted);
                }
                lock(&self.writer)?
                    .as_ref()
                    .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                    .direct_child_paths(scan.id, parent, cursor.as_deref(), limit("max_observation_bytes")?)?
            };
            if paths.is_empty() {
                return Ok(());
            }
            for path in paths {
                self.progress()?;
                {
                    let observations = lock(&self.observations)?;
                    if self.stopped.load(Ordering::Acquire) || !observations.is_current(scan.read, parent) {
                        return Err(IndexError::Interrupted);
                    }
                }
                let name = path.strip_prefix(&prefix).ok_or(IndexError::Invalid(
                    "Indexed child is outside its observed parent. Rebuild this source.",
                ))?;
                if !source_read.has_directory_child_with_check(name, || {
                    self.progress()?;
                    let observations = lock(&self.observations)?;
                    if self.stopped.load(Ordering::Acquire) || !observations.is_current(scan.read, parent) {
                        return Err(IndexError::Interrupted);
                    }
                    Ok(())
                })? {
                    loop {
                        self.progress()?;
                        source_read.verify()?;
                        let observations = lock(&self.observations)?;
                        if self.stopped.load(Ordering::Acquire) || !observations.is_current(scan.read, parent) {
                            return Err(IndexError::Interrupted);
                        }
                        let _reservation = budget.reserve()?;
                        if !lock(&self.writer)?
                            .as_mut()
                            .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                            .prune_subtree_batch(scan.id, &path)?
                        {
                            break;
                        }
                    }
                }
                cursor = Some(path);
            }
        }
    }

    fn accept_generation(
        &self,
        root: &NativeRoot,
        baseline: ObservationToken,
        generation: i64,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        root.verify()?;
        let mut observations = lock(&self.observations)?;
        if !observations.can_capture(baseline) || self.stopped.load(Ordering::Acquire) {
            return Err(IndexError::Interrupted);
        }
        let _reservation = budget.reserve()?;
        let mut writer = lock(&self.writer)?;
        let writer = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
        if writer.reconciliation_generation()?.is_some() || !writer.pending_scan_paths(generation, 1)?.is_empty() {
            return Err(IndexError::Interrupted);
        }
        let complete = writer.finish_generation(generation, 0)?;
        let mut status = lock(&self.status)?;
        status.index_status = Some(writer.status()?);
        status.state = "ready";
        if !status.failure_delay.is_zero() {
            log::info!(
                "event=directory_verification_recovered operation=directory_index stage=verification source_id={} generation_id={}",
                self.source_id,
                self.session
            );
        }
        status.complete_pass(Instant::now());
        if complete {
            observations.verification_required = false;
            if self.watcher_reconciling.swap(false, Ordering::AcqRel) && !self.watcher_failed.load(Ordering::Acquire) {
                log::info!(
                    "event=directory_watcher_recovered operation=directory_index stage=watcher source_id={} generation_id={}",
                    self.source_id,
                    self.session
                );
            }
            status.message = if self.watcher_failed.load(Ordering::Acquire) {
                Some("Directory monitoring is unavailable. Background verification remains active.".to_owned())
            } else {
                None
            };
        } else {
            status.message = Some("Directory coverage is incomplete. Some paths cannot be indexed safely.".to_owned());
            observations.verification_required = true;
        }
        Ok(())
    }

    #[cfg(test)]
    fn scan_parent(self: &Arc<Self>, root: &NativeRoot, generation: i64, parent: &str, budget: &Arc<DiskBudget>) -> Result<(), IndexError> {
        self.with_parent_read(root, parent, |read| {
            match self.scan_parent_read(root, generation, parent, read, budget) {
                Err(IndexError::SourceItem(code)) if !parent.is_empty() => {
                    self.finish_failed_native_parent(generation, parent, read, code, budget)
                }
                result => result,
            }
        })
    }

    fn finish_failed_native_parent(
        &self,
        generation: i64,
        parent: &str,
        read: &ObservationRead,
        code: &'static str,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        self.record_item_issue(generation, parent, read.token, code, budget)?;
        let mut observations = lock(&self.observations)?;
        if !observations.is_current(read.token, parent) || self.stopped.load(Ordering::Acquire) {
            return Err(IndexError::Interrupted);
        }
        if observations.scan_group.is_some() {
            let released = if let Some(entry) = observations
                .scan_group
                .as_mut()
                .and_then(|group| group.get_mut(&read.token.producer))
            {
                let bytes =
                    entry.children.iter().map(|(path, _)| path.len()).sum::<usize>() + entry.file_ids.values().map(Vec::len).sum::<usize>();
                entry.children.clear();
                entry.file_ids.clear();
                bytes
            } else {
                0
            };
            observations.scan_group_bytes -= released;
            let scan = ScanGeneration {
                id: generation,
                read: read.token,
            };
            self.stage_scan_parent_locked(&mut observations, scan, parent, false, 0, budget)?;
            if let Some(entry) = observations
                .scan_group
                .as_mut()
                .and_then(|group| group.get_mut(&read.token.producer))
            {
                entry.preserve_children = true;
            }
            return self.complete_scan_parent_locked(&mut observations, scan, parent, budget);
        }
        let _reservation = budget.reserve()?;
        let mut writer = lock(&self.writer)?;
        let writer = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
        if writer.accepted_generation()? == Some(generation) {
            let streamed = if observations.streamed_parent_reads.contains(&read.token.producer) {
                HashSet::from([parent.to_owned()])
            } else {
                HashSet::new()
            };
            let issues = observations
                .pending_scan_issues
                .get(&read.token.producer)
                .map(|counts| HashMap::from([(parent.to_owned(), counts.clone())]));
            writer.commit_parent_snapshots_with_issues(
                generation,
                &[(parent.to_owned(), vec![])],
                &HashMap::new(),
                &HashSet::from([parent.to_owned()]),
                &streamed,
                super::directory_index::ScanCommitOptions {
                    reconcile: true,
                    issues: issues.as_ref(),
                },
            )?;
        } else {
            writer.finish_scan_parent(generation, parent)?;
        }
        let counts = observations
            .pending_scan_issues
            .get(&read.token.producer)
            .cloned()
            .unwrap_or_default();
        let paths = observations
            .pending_issue_paths
            .get(&read.token.producer)
            .cloned()
            .unwrap_or_default();
        observations.publish_issue_details_with_paths(parent, &counts, &paths)?;
        observations.discard_missing_issue_details(writer, generation)?;
        lock(&self.status)?.index_status = Some(writer.status()?);
        Ok(())
    }

    fn record_item_issue(
        &self,
        generation: i64,
        parent: &str,
        token: ObservationToken,
        code: &'static str,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        self.record_item_issue_with_path(generation, parent, token, code, Some(parent), budget)
    }

    fn record_item_issue_with_path(
        &self,
        generation: i64,
        parent: &str,
        token: ObservationToken,
        code: &'static str,
        path: Option<&str>,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        if !super::directory_index::ITEM_ISSUE_CODES.contains(&code) {
            return Err(IndexError::Invalid("Unsupported directory coverage issue. Use an item issue code."));
        }
        let maximum_bytes = limit("max_observation_bytes")?;
        let path = path.filter(|path| path.len() <= maximum_bytes);
        let mut observations = lock(&self.observations)?;
        if !observations.is_current(token, parent) || self.stopped.load(Ordering::Acquire) {
            return Err(IndexError::Interrupted);
        }
        let buffered = observations.scan_group.is_some()
            || lock(&self.writer)?
                .as_ref()
                .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                .accepted_generation()?
                == Some(generation);
        if buffered {
            let previous = observations
                .pending_scan_issues
                .get(&token.producer)
                .and_then(|counts| counts.get(code))
                .copied()
                .unwrap_or(0);
            let count = previous
                .checked_add(1)
                .filter(|count| i64::try_from(*count).is_ok())
                .ok_or(IndexError::Invalid(
                    "Directory coverage issue count is exhausted. Restart verification.",
                ))?;
            if observations.scan_group.is_some() {
                let mut bytes = if previous == 0 {
                    code.len() + count.to_string().len()
                } else {
                    count.to_string().len() - previous.to_string().len()
                };
                if let Some(path) = path.filter(|_| {
                    !observations
                        .pending_issue_paths
                        .get(&token.producer)
                        .is_some_and(|paths| paths.contains_key(code))
                }) {
                    bytes += path.len();
                }
                self.stage_scan_parent_locked(
                    &mut observations,
                    ScanGeneration {
                        id: generation,
                        read: token,
                    },
                    parent,
                    false,
                    bytes,
                    budget,
                )?;
            }
            observations
                .pending_scan_issues
                .entry(token.producer)
                .or_default()
                .insert(code, count);
            if let Some(path) = path {
                observations
                    .pending_issue_paths
                    .entry(token.producer)
                    .or_default()
                    .entry(code)
                    .or_insert_with(|| path.to_owned());
            }
            if observations.scan_group.is_some() {
                self.flush_scan_group_if_due_locked(&mut observations, budget)?;
            }
        } else {
            let _reservation = budget.reserve()?;
            let mut writer = lock(&self.writer)?;
            let writer = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
            writer.record_issue(generation, code)?;
            lock(&self.status)?.index_status = Some(writer.status()?);
            let mut counts: HashMap<_, _> = observations
                .issue_details
                .iter()
                .filter(|(path, _code)| path == parent)
                .map(|(_path, code)| (*code, 1))
                .collect();
            counts.insert(code, 1);
            let mut paths: HashMap<_, _> = observations
                .issue_paths
                .iter()
                .filter(|((owner, _), _)| owner == parent)
                .map(|((_, code), path)| (*code, path.clone()))
                .collect();
            if let Some(path) = path {
                paths.entry(code).or_insert_with(|| path.to_owned());
            }
            observations.publish_issue_details_with_paths(parent, &counts, &paths)?;
        }
        *observations.scan_issue_counts.entry(code).or_default() += 1;
        if observations.scan_issue_counts.values().sum::<usize>() <= limit("max_logged_scan_issues_per_pass")? {
            log::info!(
                "event=directory_scan_item_issue source_id={} code={} path={:?}",
                self.source_id,
                code,
                parent
            );
        }
        Ok(())
    }

    #[cfg(test)]
    fn with_parent_read(
        self: &Arc<Self>,
        root: &NativeRoot,
        parent: &str,
        operation: impl FnOnce(&ObservationRead) -> Result<(), IndexError>,
    ) -> Result<(), IndexError> {
        let read = self.begin_read()?;
        let outcome = operation(&read);
        if outcome.is_err() {
            root.require_verification();
        }
        match outcome {
            Err(IndexError::Io(error))
                if !parent.is_empty() && matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) =>
            {
                root.verify()?;
                match root.parent_identity(parent) {
                    Err(IndexError::Io(current))
                        if matches!(current.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {}
                    Ok(_) => return Err(IndexError::Io(error)),
                    Err(error) => return Err(error),
                }
                let mut observations = lock(&self.observations)?;
                if self.stopped.load(Ordering::Acquire) || !observations.is_current(read.token, parent) {
                    return Err(IndexError::Interrupted);
                }
                observations.enqueue(
                    parent_observation(parent),
                    limit("max_pending_observations")?,
                    limit("max_observation_bytes")?,
                )?;
                Err(IndexError::Interrupted)
            }
            result => result,
        }
    }

    #[cfg(test)]
    fn scan_parent_read(
        self: &Arc<Self>,
        root: &NativeRoot,
        generation: i64,
        parent: &str,
        read: &ObservationRead,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        let expected_id = lock(&self.writer)?
            .as_ref()
            .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
            .scan_parent_file_id(generation, parent)?;
        let full_pass = {
            let observations = lock(&self.observations)?;
            observations.scan_group.is_some() && !observations.scan_group_reconcile
        };
        let source_read = match (full_pass, expected_id.as_deref()) {
            (true, Some(expected)) => root.open_parent_for_scan_with_id(parent, expected).map_err(source_error)?,
            (true, None) => root.open_parent_for_scan(parent).map_err(source_error)?,
            (false, _) => root.open_parent(parent).map_err(source_error)?,
        };
        let parent_identity = source_read.identity;
        if expected_id.is_some_and(|expected| expected != parent_identity.file_id()) {
            let mut observations = lock(&self.observations)?;
            self.flush_scan_group_locked(&mut observations, budget)?;
            let mut writer = lock(&self.writer)?;
            let writer = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
            if writer
                .scan_parent_file_id(generation, parent)?
                .is_some_and(|expected| expected != parent_identity.file_id())
            {
                return Err(IndexError::SourceItem(TraversalIssue::UnsafeTraversal.code()));
            }
        }
        let mut batch = Vec::with_capacity(ROW_BATCH_SIZE);
        let mut file_ids = HashMap::new();
        let mut bytes = 0;
        self.progress()?;
        source_read.children_with_ids(|entry| {
            self.ensure_available()?;
            if self.stopped.load(Ordering::Acquire) || !lock(&self.observations)?.is_current(read.token, parent) {
                return Err(IndexError::Interrupted);
            }
            match entry {
                Ok(Some((name, descend, file_id))) => {
                    let path = if parent.is_empty() {
                        name.clone()
                    } else {
                        format!("{parent}/{name}")
                    };
                    if validate_directory_path(&path).is_err() || path.len() > limit("max_observation_bytes")? {
                        self.record_item_issue_with_path(
                            generation,
                            parent,
                            read.token,
                            TraversalIssue::UnsupportedEncoding.code(),
                            Some(&path),
                            budget,
                        )?;
                        return Ok(());
                    }
                    if !batch.is_empty() && (batch.len() == ROW_BATCH_SIZE || bytes + path.len() > limit("max_observation_bytes")?) {
                        self.commit_identified_children(
                            root,
                            parent,
                            &source_read,
                            ScanGeneration {
                                id: generation,
                                read: read.token,
                            },
                            IdentifiedChildren {
                                children: &batch,
                                file_ids: &file_ids,
                            },
                            budget,
                        )?;
                        batch.clear();
                        file_ids.clear();
                        bytes = 0;
                    }
                    bytes += path.len();
                    if let Some(file_id) = file_id {
                        file_ids.insert(path.clone(), file_id);
                    }
                    batch.push((path, descend));
                }
                Ok(None) => {}
                Err(issue) => {
                    root.require_verification();
                    source_read.verify().map_err(source_error)?;
                    let path = issue.name().map(|name| {
                        if parent.is_empty() {
                            name.to_owned()
                        } else {
                            format!("{parent}/{name}")
                        }
                    });
                    self.record_item_issue_with_path(generation, parent, read.token, issue.code(), path.as_deref(), budget)?;
                }
            }
            Ok(())
        })?;
        if !batch.is_empty() {
            self.commit_identified_children(
                root,
                parent,
                &source_read,
                ScanGeneration {
                    id: generation,
                    read: read.token,
                },
                IdentifiedChildren {
                    children: &batch,
                    file_ids: &file_ids,
                },
                budget,
            )?;
        }
        self.finish_native_parent(root, &source_read, generation, parent, read, budget)
    }

    fn verify_native_publication(&self, root: &NativeRoot, parent: &str, source_read: &NativeParent<'_>) -> Result<(), IndexError> {
        source_read.verify().map_err(source_error)?;
        #[cfg(target_os = "linux")]
        if self.watcher_failed.load(Ordering::Acquire) || self.watcher_reconciling.load(Ordering::Acquire) || lock(&self.watcher)?.is_none()
        {
            root.verify_parent(parent, source_read.identity).map_err(source_error)?;
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (root, parent);
        Ok(())
    }

    fn finish_native_parent(
        &self,
        root: &NativeRoot,
        source_read: &NativeParent<'_>,
        generation: i64,
        parent: &str,
        read: &ObservationRead,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        #[cfg(test)]
        if lock(&self.observations)?.scan_group.is_none()
            && lock(&self.writer)?
                .as_ref()
                .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                .accepted_generation()?
                != Some(generation)
        {
            self.prune_parent_children(
                source_read,
                parent,
                ScanGeneration {
                    id: generation,
                    read: read.token,
                },
                budget,
            )?;
        }
        self.verify_native_publication(root, parent, source_read)?;
        let mut observations = lock(&self.observations)?;
        if self.stopped.load(Ordering::Acquire) || !observations.is_current(read.token, parent) {
            return Err(IndexError::Interrupted);
        }
        if observations.scan_group.is_some() {
            self.complete_scan_parent_locked(
                &mut observations,
                ScanGeneration {
                    id: generation,
                    read: read.token,
                },
                parent,
                budget,
            )?;
            return Ok(());
        }
        let _reservation = budget.reserve()?;
        let mut writer = lock(&self.writer)?;
        let writer = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
        if writer.accepted_generation()? == Some(generation) {
            let streamed = if observations.streamed_parent_reads.contains(&read.token.producer) {
                HashSet::from([parent.to_owned()])
            } else {
                HashSet::new()
            };
            let issues = observations
                .pending_scan_issues
                .get(&read.token.producer)
                .map(|counts| HashMap::from([(parent.to_owned(), counts.clone())]));
            writer.commit_parent_snapshots_with_issues(
                generation,
                &[(parent.to_owned(), vec![])],
                &HashMap::new(),
                &HashSet::new(),
                &streamed,
                super::directory_index::ScanCommitOptions {
                    reconcile: true,
                    issues: issues.as_ref(),
                },
            )?;
        } else {
            writer.finish_scan_parent(generation, parent)?;
        }
        let counts = observations
            .pending_scan_issues
            .get(&read.token.producer)
            .cloned()
            .unwrap_or_default();
        let paths = observations
            .pending_issue_paths
            .get(&read.token.producer)
            .cloned()
            .unwrap_or_default();
        observations.publish_issue_details_with_paths(parent, &counts, &paths)?;
        observations.discard_missing_issue_details(writer, generation)?;
        lock(&self.status)?.index_status = Some(writer.status()?);
        Ok(())
    }

    fn read_native_scan_job<'a>(
        self: &Arc<Self>,
        root: &'a NativeRoot,
        job: &NativeScanJob,
        read: &Arc<ObservationRead>,
        sender: &SyncSender<NativeScanEvent<'a>>,
        cancelled: &AtomicBool,
    ) -> Result<(), IndexError> {
        #[cfg(test)]
        {
            let gate = lock(&self.io.read_gate)?.clone();
            if let Some(gate) = gate {
                gate.wait();
                gate.wait();
            }
        }
        let send = |result| {
            sender
                .send(NativeScanEvent {
                    job: job.clone(),
                    read: Arc::clone(read),
                    result,
                })
                .map_err(|_| IndexError::Interrupted)
        };
        let full_pass = {
            let observations = lock(&self.observations)?;
            observations.scan_group.is_some() && !observations.scan_group_reconcile
        };
        let source_read = match (full_pass, job.file_id.as_deref()) {
            (true, Some(expected)) => root.open_parent_for_scan_with_id(&job.parent, expected),
            (true, None) => root.open_parent_for_scan(&job.parent),
            (false, _) => root.open_parent(&job.parent),
        }
        .map_err(source_error)?;
        if job
            .file_id
            .as_ref()
            .is_some_and(|expected| *expected != source_read.identity.file_id())
        {
            return Err(IndexError::SourceItem(TraversalIssue::UnsafeTraversal.code()));
        }
        let source_read = Arc::new(source_read);
        let maximum_bytes = limit("max_observation_bytes")?;
        let mut children = Vec::with_capacity(ROW_BATCH_SIZE);
        let mut file_ids = HashMap::new();
        let mut bytes = 0;
        self.progress()?;
        source_read.children_with_ids(|entry| {
            if cancelled.load(Ordering::Acquire)
                || self.stopped.load(Ordering::Acquire)
                || !lock(&self.observations)?.is_current(read.token, &job.parent)
            {
                return Err(IndexError::Interrupted);
            }
            self.ensure_available()?;
            match entry {
                Ok(Some((name, descend, file_id))) => {
                    let path = if job.parent.is_empty() {
                        name.clone()
                    } else {
                        format!("{}/{name}", job.parent)
                    };
                    if validate_directory_path(&path).is_err() || path.len() > maximum_bytes {
                        return send(NativeScanResult::Issue(TraversalIssue::UnsupportedDirectoryName(name)));
                    }
                    let entry_bytes = path.len() + file_id.as_ref().map_or(0, Vec::len);
                    if !children.is_empty() && (children.len() == ROW_BATCH_SIZE || bytes + entry_bytes > maximum_bytes) {
                        send(NativeScanResult::Batch(
                            Arc::clone(&source_read),
                            std::mem::take(&mut children),
                            std::mem::take(&mut file_ids),
                        ))?;
                        bytes = 0;
                    }
                    bytes += entry_bytes;
                    if let Some(file_id) = file_id {
                        file_ids.insert(path.clone(), file_id);
                    }
                    children.push((path, descend));
                }
                Ok(None) => {}
                Err(issue) => send(NativeScanResult::Issue(issue))?,
            }
            Ok(())
        })?;
        if !children.is_empty() {
            send(NativeScanResult::Batch(Arc::clone(&source_read), children, file_ids))?;
        }
        send(NativeScanResult::Complete(source_read))
    }

    fn scan_native_parent_page(
        self: &Arc<Self>,
        root: &NativeRoot,
        generation: i64,
        parents: &[String],
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        let mut remaining = parents.to_vec();
        while !remaining.is_empty() {
            let ready: Vec<_> = remaining
                .iter()
                .filter(|parent| !remaining.iter().any(|other| other != *parent && is_prefix(other, parent)))
                .cloned()
                .collect();
            if ready.is_empty() {
                return Err(IndexError::Invalid(
                    "Directory scan dependencies cannot advance. Rebuild this source index.",
                ));
            }
            self.scan_native_independent_page(root, generation, &ready, budget)?;
            remaining.retain(|parent| !ready.contains(parent));
            if !remaining.is_empty() {
                let mut observations = lock(&self.observations)?;
                self.flush_scan_group_locked(&mut observations, budget)?;
            }
        }
        Ok(())
    }

    fn scan_native_independent_page(
        self: &Arc<Self>,
        root: &NativeRoot,
        generation: i64,
        parents: &[String],
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        let jobs = {
            let writer = lock(&self.writer)?;
            let writer = writer.as_ref().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
            let mut jobs = VecDeque::new();
            for (parent, file_id) in writer.pending_scan_jobs(generation, parents)? {
                jobs.push_back(NativeScanJob { parent, file_id });
            }
            Mutex::new(jobs)
        };
        let parallelism = limit("scan_read_parallelism")?.min(parents.len());
        let cancelled = AtomicBool::new(false);
        std::thread::scope(|scope| {
            let (sender, receiver) = sync_channel(parallelism.max(1));
            let mut workers = Vec::new();
            for _worker in 0..parallelism {
                let sender = sender.clone();
                let jobs = &jobs;
                let cancelled = &cancelled;
                workers.push(scope.spawn(move || -> Result<(), IndexError> {
                    while !cancelled.load(Ordering::Acquire) {
                        let Some(job) = lock(jobs)?.pop_front() else { break };
                        let read = Arc::new(self.begin_read()?);
                        if let Err(error) = self.read_native_scan_job(root, &job, &read, &sender, cancelled) {
                            root.require_verification();
                            if sender
                                .send(NativeScanEvent {
                                    job,
                                    read,
                                    result: NativeScanResult::Failed(error),
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                    Ok(())
                }));
            }
            drop(sender);
            let mut failed = HashSet::new();
            let mut outcome = Ok(());
            for event in receiver.iter() {
                if failed.contains(&event.read.token.producer) {
                    continue;
                }
                let result = match event.result {
                    NativeScanResult::Batch(source_read, children, file_ids) => self.commit_identified_children(
                        root,
                        &event.job.parent,
                        &source_read,
                        ScanGeneration {
                            id: generation,
                            read: event.read.token,
                        },
                        IdentifiedChildren {
                            children: &children,
                            file_ids: &file_ids,
                        },
                        budget,
                    ),
                    NativeScanResult::Issue(issue) => {
                        root.require_verification();
                        let path = issue.name().map(|name| {
                            if event.job.parent.is_empty() {
                                name.to_owned()
                            } else {
                                format!("{}/{name}", event.job.parent)
                            }
                        });
                        self.record_item_issue_with_path(
                            generation,
                            &event.job.parent,
                            event.read.token,
                            issue.code(),
                            path.as_deref(),
                            budget,
                        )
                    }
                    NativeScanResult::Complete(source_read) => {
                        self.finish_native_parent(root, &source_read, generation, &event.job.parent, &event.read, budget)
                    }
                    NativeScanResult::Failed(error) => Err(error),
                };
                let result = match result {
                    Err(IndexError::SourceItem(code)) if !event.job.parent.is_empty() => {
                        failed.insert(event.read.token.producer);
                        self.finish_failed_native_parent(generation, &event.job.parent, &event.read, code, budget)
                    }
                    result => result,
                };
                if let Err(error) = result {
                    cancelled.store(true, Ordering::Release);
                    outcome = Err(error);
                    break;
                }
                let mut observations = lock(&self.observations)?;
                self.flush_scan_group_if_due_locked(&mut observations, budget)?;
            }
            drop(receiver);
            cancelled.store(true, Ordering::Release);
            for worker in workers {
                match worker.join() {
                    Ok(Err(error)) if outcome.is_ok() => outcome = Err(error),
                    Err(_) if outcome.is_ok() => outcome = Err(IndexError::Invalid("Directory read worker failed. Retry verification.")),
                    _ => {}
                }
            }
            outcome
        })
    }

    fn reconcile(self: &Arc<Self>, budget: &Arc<DiskBudget>, scans: &Arc<Semaphore>) -> Result<(), IndexError> {
        if self.stopped.load(Ordering::Acquire) || Instant::now() < lock(&self.status)?.retry_at {
            return Ok(());
        }
        let generation = {
            let writer = lock(&self.writer)?;
            match writer.as_ref() {
                Some(writer) if !writer.needs_fts_repair() => writer.reconciliation_generation()?,
                _ => None,
            }
        };
        let Some(_) = generation else {
            return Ok(());
        };
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(());
        }
        let Ok(permit) = Arc::clone(scans).try_acquire_owned() else {
            self.busy.store(false, Ordering::Release);
            return Ok(());
        };
        let _ownership = ScanOwnership {
            source: Arc::clone(self),
            _permit: permit,
        };
        self.progress()?;
        let outcome = (|| {
            if self.stopped.load(Ordering::Acquire) {
                return Err(IndexError::Interrupted);
            }
            let root = self.bind_root(budget)?;
            let Some(generation) = lock(&self.writer)?
                .as_ref()
                .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                .reconciliation_generation()?
            else {
                return Ok(());
            };
            root.verify()?;
            {
                let mut observations = lock(&self.observations)?;
                observations.scan_group = Some(HashMap::new());
                observations.scan_group_reconcile = true;
            }
            let baseline = self.begin_read()?;
            loop {
                if self.stopped.load(Ordering::Acquire) || !lock(&self.observations)?.is_current(baseline.token, "") {
                    return Err(IndexError::Interrupted);
                }
                let buffered: Vec<_> = lock(&self.observations)?
                    .scan_group
                    .as_ref()
                    .into_iter()
                    .flat_map(|group| group.values())
                    .filter(|entry| entry.complete)
                    .map(|entry| entry.parent.clone())
                    .collect();
                let parents = lock(&self.writer)?
                    .as_ref()
                    .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                    .pending_scan_paths_excluding(generation, ROW_BATCH_SIZE, &buffered)?;
                if parents.is_empty() {
                    let mut observations = lock(&self.observations)?;
                    self.flush_scan_group_locked(&mut observations, budget)?;
                    if lock(&self.writer)?
                        .as_ref()
                        .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                        .pending_scan_paths(generation, 1)?
                        .is_empty()
                    {
                        break;
                    }
                    continue;
                }
                self.scan_native_parent_page(&root, generation, &parents, budget)?;
            }
            root.verify()?;
            let observations = lock(&self.observations)?;
            if self.stopped.load(Ordering::Acquire) || !observations.is_current(baseline.token, "") {
                return Err(IndexError::Interrupted);
            }
            Ok(())
        })();
        let cleanup = self.cancel_scan_groups();
        outcome.and(cleanup)
    }

    fn scan_to_acceptance(
        self: &Arc<Self>,
        root: &NativeRoot,
        baseline: ObservationToken,
        generation: i64,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        self.scan_to_acceptance_pages_with(root, baseline, generation, budget, |generation, parents| {
            self.scan_native_parent_page(root, generation, parents, budget)
        })
    }

    #[cfg(test)]
    fn scan_to_acceptance_with(
        self: &Arc<Self>,
        root: &NativeRoot,
        baseline: ObservationToken,
        generation: i64,
        budget: &Arc<DiskBudget>,
        mut scan_parent: impl FnMut(i64, &str) -> Result<(), IndexError>,
    ) -> Result<(), IndexError> {
        self.scan_to_acceptance_pages_with(root, baseline, generation, budget, |work_generation, parents| {
            for parent in parents {
                if !lock(&self.writer)?
                    .as_ref()
                    .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                    .scan_parent_pending(work_generation, parent)?
                {
                    continue;
                }
                scan_parent(work_generation, parent)?;
                let mut observations = lock(&self.observations)?;
                self.flush_scan_group_if_due_locked(&mut observations, budget)?;
            }
            Ok(())
        })
    }

    fn scan_to_acceptance_pages_with(
        self: &Arc<Self>,
        root: &NativeRoot,
        baseline: ObservationToken,
        generation: i64,
        budget: &Arc<DiskBudget>,
        mut scan_page: impl FnMut(i64, &[String]) -> Result<(), IndexError>,
    ) -> Result<(), IndexError> {
        loop {
            if self.stopped.load(Ordering::Acquire) {
                return Err(IndexError::Interrupted);
            }
            let needs_flush = {
                let observations = lock(&self.observations)?;
                if observations.epoch != baseline.epoch {
                    return Err(IndexError::Interrupted);
                }
                observations.uncertain || !observations.pending.is_empty()
            };
            if needs_flush {
                self.flush(budget)?;
            }
            if !lock(&self.observations)?.pending.is_empty() {
                continue;
            }
            let buffered: Vec<_> = lock(&self.observations)?
                .scan_group
                .as_ref()
                .into_iter()
                .flat_map(|group| group.values())
                .filter(|entry| entry.complete && entry.generation == generation)
                .map(|entry| entry.parent.clone())
                .collect();
            let (work_generation, parents) = {
                let writer = lock(&self.writer)?;
                let writer = writer.as_ref().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
                let work_generation = writer.reconciliation_generation()?.unwrap_or(generation);
                (
                    work_generation,
                    writer.pending_scan_paths_excluding(work_generation, ROW_BATCH_SIZE, &buffered)?,
                )
            };
            if parents.is_empty() {
                let mut observations = lock(&self.observations)?;
                self.flush_scan_group_locked(&mut observations, budget)?;
                if lock(&self.writer)?
                    .as_ref()
                    .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                    .pending_scan_paths(work_generation, 1)?
                    .is_empty()
                {
                    break;
                }
                continue;
            }
            if buffered.iter().any(|ancestor| {
                parents
                    .iter()
                    .any(|parent| ancestor.is_empty() || parent.strip_prefix(ancestor).is_some_and(|rest| rest.starts_with('/')))
            }) {
                let mut observations = lock(&self.observations)?;
                self.flush_scan_group_locked(&mut observations, budget)?;
                continue;
            }
            scan_page(work_generation, &parents)?;
            {
                let mut observations = lock(&self.observations)?;
                self.flush_scan_group_if_due_locked(&mut observations, budget)?;
            }
            let (done, queued, found) = lock(&self.writer)?
                .as_ref()
                .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                .scan_counts(generation)?;
            if let Some(progress) = lock(&self.status)?.scan_progress.as_mut().filter(|_| work_generation == generation) {
                progress.parents_done = done;
                progress.parents_queued = queued;
                progress.directories_found = found;
            }
        }
        self.accept_generation(root, baseline, generation, budget)
    }

    #[cfg(test)]
    fn scan(self: &Arc<Self>, budget: &Arc<DiskBudget>) -> Result<(), IndexError> {
        self.scan_with_mode(budget, false)
    }

    fn scan_with_mode(self: &Arc<Self>, budget: &Arc<DiskBudget>, rebind_only: bool) -> Result<(), IndexError> {
        let started = Instant::now();
        let opens_before = self.io.opens();
        let outcome = self.scan_source(budget, rebind_only, started, opens_before);
        self.cancel_scan_groups()?;
        let commits = lock(&self.observations)?.scan_commits;
        let issue_counts = lock(&self.observations)?.scan_issue_counts.clone();
        let mut status = lock(&self.status)?;
        let abort_reason = match &outcome {
            Ok(()) => "none",
            Err(IndexError::Interrupted) => "interrupted",
            Err(IndexError::Io(_) | IndexError::SourceItem(_)) => "source_io",
            Err(IndexError::StoragePaused(_)) => "storage_paused",
            Err(IndexError::Sql(_)) => "sqlite",
            Err(IndexError::QueryBusy) => "query_busy",
            Err(IndexError::Invalid(_) | IndexError::RebuildRequired(_)) => "invalid_source_or_storage",
        };
        let progress = status.scan_progress.as_ref();
        log::info!(
            "event=directory_scan_finished operation=directory_index stage=scan source_id={} generation_id={} scan_generation={:?} scan_phase={} parents_done={} parents_queued={} directories_found={} native_opens={} group_commits={} success={} duration_ms={} abort_reason={}",
            self.source_id,
            self.session,
            status.scan_generation,
            progress.map_or("idle", |progress| progress.phase),
            progress.map_or(0, |progress| progress.parents_done),
            progress.map_or(0, |progress| progress.parents_queued),
            progress.map_or(0, |progress| progress.directories_found),
            self.io.opens() - opens_before,
            commits,
            outcome.is_ok(),
            started.elapsed().as_millis(),
            abort_reason
        );
        log::info!(
            "event=directory_scan_issue_totals source_id={} issue_counts={:?}",
            self.source_id,
            issue_counts
        );
        if let Some(progress) = status.scan_progress.as_mut() {
            progress.phase = "idle";
        }
        outcome
    }

    fn bind_root(self: &Arc<Self>, budget: &Arc<DiskBudget>) -> Result<Arc<NativeRoot>, IndexError> {
        self.progress()?;
        let evidence = volume_evidence(&self.root_path)?;
        match lock(&self.volume)?.compare(&evidence) {
            VolumeChange::Unavailable => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "Directory volume is not mounted. Mount the volume to resume verification.",
                )
                .into())
            }
            VolumeChange::Index => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "Directory volume changed. Retry the search to bind its index.",
                )
                .into())
            }
            _ => {}
        }
        let root = match lock(&self.root)?.clone() {
            Some(root) => {
                if root.verify().is_ok() {
                    root
                } else {
                    self.invalidate_for(InvalidationReason::SourceRebind)?;
                    lock(&self.watcher)?.take();
                    Arc::new(NativeRoot::open_with_io(&self.root_path, self.io.clone())?)
                }
            }
            None => Arc::new(NativeRoot::open_with_io(&self.root_path, self.io.clone())?),
        };
        // A newly opened index reports a volume change only on its first bind_volume call.
        let mut opened_change = None;
        if lock(&self.writer)?.is_none() {
            let _reservation = budget.reserve()?;
            let mut index = DirectoryIndex::open_with_recovery(
                &self.index_path,
                SourceKind::Local,
                &json!({"platform": std::env::consts::OS, "root": hex::encode(self.root_path.as_os_str().as_encoded_bytes())}),
                Some(&self.recovery_attempted),
            )?;
            let _policy_gate = lock(&budget.policy_gate)?;
            index.configure_page_cache(budget.policy()?.page_cache_kib)?;
            let change = index.bind_volume(&evidence)?;
            if matches!(change, VolumeChange::Index | VolumeChange::Unavailable) {
                return Err(volume_unavailable_error());
            }
            opened_change = Some(change);
            *lock(&self.reader)? = Some(index.reader());
            *lock(&self.writer)? = Some(index);
            *lock(&self.root)? = Some(Arc::clone(&root));
        }
        {
            let _reservation = budget.reserve()?;
            let mut writer = lock(&self.writer)?;
            let index = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
            let change = match opened_change {
                Some(change) => change,
                None => index.bind_volume(&evidence)?,
            };
            match change {
                VolumeChange::Index | VolumeChange::Unavailable => return Err(volume_unavailable_error()),
                VolumeChange::Generation => {
                    self.invalidate_for(InvalidationReason::SourceRebind)?;
                }
                VolumeChange::Keep => {}
            }
            lock(&self.status)?.index_status = Some(index.status()?);
        }
        let mut retained_evidence = lock(&self.volume)?;
        let mut evidence = evidence;
        evidence.retain_available(&retained_evidence);
        *retained_evidence = evidence;
        drop(retained_evidence);
        *lock(&self.root)? = Some(Arc::clone(&root));
        Ok(root)
    }

    fn scan_source(
        self: &Arc<Self>,
        budget: &Arc<DiskBudget>,
        rebind_only: bool,
        started: Instant,
        opens_before: u64,
    ) -> Result<(), IndexError> {
        let root = self.bind_root(budget)?;
        self.recover_watcher()?;
        if rebind_only {
            lock(&self.status)?.state = "ready";
            return Ok(());
        }
        loop {
            if self.stopped.load(Ordering::Acquire) {
                return Err(IndexError::Interrupted);
            }
            self.progress()?;
            let mut writer = lock(&self.writer)?;
            let index = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
            if !index.needs_fts_repair() {
                break;
            }
            let _reservation = budget.reserve()?;
            index.repair_fts_batch()?;
        }
        self.flush(budget)?;
        let baseline = self.begin_read()?;
        let (generation, _selected) = {
            let mut observations = lock(&self.observations)?;
            if !observations.is_current(baseline.token, "") {
                return Err(IndexError::Interrupted);
            }
            let _reservation = budget.reserve()?;
            let mut writer = lock(&self.writer)?;
            let index = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
            let resuming = index.has_resumable_scan()?;
            let (generation, selected) = index.prepare_scan()?;
            if !resuming {
                observations.issue_details.clear();
                observations.issue_paths.clear();
                observations.issue_details_incomplete = false;
                observations.scan_epoch = Some((generation, baseline.token.epoch));
            }
            if observations.observation_lost {
                while index.requeue_completed_scan_batch(generation)? {
                    if self.stopped.load(Ordering::Acquire) {
                        return Err(IndexError::Interrupted);
                    }
                }
                observations.observation_lost = false;
            }
            index.seed_scan(generation)?;
            observations.scan_group = Some(HashMap::new());
            observations.scan_group_started = None;
            observations.scan_group_has_changes = false;
            observations.completed_scan_reads.clear();
            observations.scan_group_bytes = 0;
            observations.scan_commits = 0;
            observations.scan_issue_counts.clear();
            let (done, queued, found) = index.scan_counts(generation)?;
            let mut status = lock(&self.status)?;
            status.state = if selected { "building" } else { "updating" };
            status.scan_progress = Some(ScanProgress {
                phase: if selected { "building" } else { "updating" },
                parents_done: done,
                parents_queued: queued,
                directories_found: found,
                started_at_ms: epoch_milliseconds()?,
            });
            status.scan_generation = Some(generation);
            drop(status);
            log::info!(
                "event=directory_scan_started operation=directory_index stage=scan source_id={} generation_id={} scan_generation={} scan_phase={} parents_done={} parents_queued={} directories_found={} native_opens={} group_commits=0 duration_ms={} abort_reason=none",
                self.source_id,
                self.session,
                generation,
                if selected { "building" } else { "updating" },
                done,
                queued,
                found,
                self.io.opens() - opens_before,
                started.elapsed().as_millis(),
            );
            (generation, selected)
        };
        self.scan_to_acceptance(&root, baseline.token, generation, budget)
    }
}

struct ScanOwnership {
    source: Arc<LocalSource>,
    _permit: OwnedSemaphorePermit,
}
impl Drop for ScanOwnership {
    fn drop(&mut self) {
        self.source.busy.store(false, Ordering::Release);
        self.source.finished.notify_waiters();
        self.source.notify_worker_exit();
    }
}

struct QueryCancellation(Arc<AtomicBool>);
struct QueryOwnership {
    source: Arc<LocalSource>,
    _permit: OwnedSemaphorePermit,
}

impl Drop for QueryOwnership {
    fn drop(&mut self) {
        self.source.active_queries.fetch_sub(1, Ordering::AcqRel);
        self.source.notify_worker_exit();
    }
}

struct UpdateOwnership {
    source: Arc<LocalSource>,
    _permit: OwnedSemaphorePermit,
}

impl Drop for UpdateOwnership {
    fn drop(&mut self) {
        self.source.flush_busy.store(false, Ordering::Release);
        self.source.notify_worker_exit();
    }
}
impl Drop for QueryCancellation {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

pub struct LocalDirectoryManager {
    sources: Mutex<HashMap<String, Arc<LocalSource>>>,
    budget: Arc<DiskBudget>,
    scans: Arc<Semaphore>,
    queries: Arc<Semaphore>,
    updates: Arc<Semaphore>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MutationScope {
    Parent,
    Subtree,
    Ancestors,
}

impl LocalDirectoryManager {
    #[cfg(feature = "recovery-verification")]
    pub(super) fn verification_watcher_loss(&self, drive: &str, restore: bool) -> Result<(), IndexError> {
        let source = lock(&self.sources)?
            .get(drive)
            .cloned()
            .ok_or(IndexError::Invalid("Verification source is not active."))?;
        if restore {
            lock(&source.status)?.watcher_retry_at = Instant::now();
            source.recover_watcher()?;
            let mut status = lock(&source.status)?;
            status.verified = Instant::now() - FAILURE_RETRY_MAX;
            status.retry_at = Instant::now();
        } else {
            lock(&source.watcher)?.take();
            source.lose_watcher()?;
            lock(&source.status)?.watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
        }
        Ok(())
    }

    #[cfg(feature = "recovery-verification")]
    pub(super) fn verification_stop(&self, drive: &str) -> Result<bool, IndexError> {
        let source = lock(&self.sources)?.get(drive).cloned();
        let Some(source) = source else { return Ok(true) };
        source.stopped.store(true, Ordering::Release);
        lock(&source.watcher)?.take();
        if source.busy.load(Ordering::Acquire)
            || source.flush_busy.load(Ordering::Acquire)
            || source.active_queries.load(Ordering::Acquire) != 0
        {
            return Ok(false);
        }
        source.close_idle(&self.budget)?;
        lock(&self.sources)?.remove(drive);
        Ok(true)
    }

    pub(super) fn storage_directory(&self) -> &Path {
        &self.budget.namespace
    }

    /// Call inside the blocking worker, not in the async future that waits for it.
    pub(super) fn run_observed_operation<T>(&self, drive: &str, root: &Path, path: &Path, operation: impl FnOnce() -> T) -> T {
        self.run_observed_mutation(drive, root, path, MutationScope::Parent, operation)
    }

    pub(super) fn run_observed_subtree_operation<T>(&self, drive: &str, root: &Path, path: &Path, operation: impl FnOnce() -> T) -> T {
        self.run_observed_mutation(drive, root, path, MutationScope::Subtree, operation)
    }

    pub(super) fn run_observed_parent_creation<T>(&self, drive: &str, root: &Path, path: &Path, operation: impl FnOnce() -> T) -> T {
        self.run_observed_mutation(drive, root, path, MutationScope::Ancestors, operation)
    }

    pub(super) fn run_observed_root_creation<T>(&self, root: &Path, path: &Path, operation: impl FnOnce() -> T) -> T {
        let bindings = lock(&self.sources).map(|sources| {
            sources
                .iter()
                .filter(|(_, source)| source.root_path == root && !source.stopped.load(Ordering::Acquire))
                .map(|(drive, _)| drive.clone())
                .collect::<Vec<_>>()
        });
        let _observations = match bindings {
            Ok(bindings) => bindings
                .iter()
                .filter_map(|drive| self.mutation_observation(drive, root, path, MutationScope::Ancestors))
                .collect::<Vec<_>>(),
            Err(_) => {
                log::warn!("Archive directory observation is unavailable. Restart the companion and retry verification.");
                Vec::new()
            }
        };
        operation()
    }

    fn run_observed_mutation<T>(&self, drive: &str, root: &Path, path: &Path, scope: MutationScope, operation: impl FnOnce() -> T) -> T {
        let _observation = self.mutation_observation(drive, root, path, scope);
        operation()
    }

    fn mutation_observation(&self, drive: &str, root: &Path, path: &Path, scope: MutationScope) -> Option<MutationObservation> {
        let observation = (|| {
            let source = lock(&self.sources)?.get(drive).cloned();
            let Some(source) = source.filter(|source| source.root_path == root && !source.stopped.load(Ordering::Acquire)) else {
                return Ok(None);
            };
            let prepare = (|| {
                let relative = path
                    .strip_prefix(root)
                    .ok()
                    .and_then(|path| path.to_str())
                    .ok_or(IndexError::Invalid(
                        "Directory mutation is outside its bound source or uses unsupported encoding.",
                    ))?;
                #[cfg(windows)]
                let relative = relative.replace('\\', "/");
                let relative = relative.to_owned();
                if !relative.is_empty() || scope != MutationScope::Ancestors {
                    validate_directory_path(&relative)?;
                }
                if relative.len() > limit("max_observation_bytes")? {
                    return Err(IndexError::Invalid("Directory mutation path exceeds the observation byte limit."));
                }
                Ok(MutationObservation {
                    read: source.begin_read()?,
                    parent: relative.rsplit_once('/').map_or("", |(parent, _)| parent).to_owned(),
                    subtree: (scope == MutationScope::Subtree).then_some(relative),
                    ancestors: scope == MutationScope::Ancestors,
                })
            })();
            match prepare {
                Ok(observation) => {
                    observation.observe();
                    Ok(Some(observation))
                }
                Err(error) => {
                    source.invalidate()?;
                    Err(error)
                }
            }
        })();
        match observation {
            Ok(observation) => observation,
            Err(_) => {
                log::warn!("Directory mutation observation is unavailable. Check drive access and retry verification.");
                None
            }
        }
    }

    pub fn apply_policy(&self, policy: DirectoryPolicy) -> Result<(), IndexError> {
        self.apply_policy_with_persistence(policy, || Ok(()))
    }

    pub(super) fn apply_policy_with_persistence(
        &self,
        policy: DirectoryPolicy,
        persist: impl FnOnce() -> Result<(), IndexError>,
    ) -> Result<(), IndexError> {
        policy.validate()?;
        let _policy_gate = lock(&self.budget.policy_gate)?;
        let sources: Vec<_> = lock(&self.sources)?.values().cloned().collect();
        let mut writers: Vec<_> = sources.iter().map(|source| lock(&source.writer)).collect::<Result<_, _>>()?;
        let mut readers: Vec<_> = sources.iter().map(|source| lock(&source.reader)).collect::<Result<_, _>>()?;
        let mut state = lock(&self.budget.state)?;
        let previous_targets: Vec<_> = writers
            .iter()
            .map(|writer| writer.as_ref().map(DirectoryIndex::page_cache_target_kib))
            .collect();
        let outcome = (|| {
            for writer in &mut writers {
                if let Some(index) = writer.as_mut() {
                    index.configure_page_cache(policy.page_cache_kib)?;
                }
            }
            persist()
        })();
        if let Err(error) = outcome {
            let mut restored = true;
            for (writer, previous_target) in writers.iter_mut().zip(previous_targets) {
                if let (Some(index), Some(target)) = (writer.as_mut(), previous_target) {
                    restored &= index.configure_page_cache(target).is_ok();
                }
            }
            if !restored {
                for (source, reader) in sources.iter().zip(&mut readers) {
                    source.stopped.store(true, Ordering::Release);
                    **reader = None;
                }
                return Err(IndexError::Invalid(
                    "Directory policy could not be restored. Sources are stopped. Restart the companion.",
                ));
            }
            return Err(error);
        }
        for (writer, reader) in writers.iter().zip(&mut readers) {
            **reader = writer.as_ref().map(DirectoryIndex::reader);
        }
        state.policy = policy;
        state.next_cleanup_at = Instant::now();
        drop(state);
        drop(readers);
        drop(writers);
        for source in &sources {
            if let Ok(mut status) = source.status.lock() {
                status.retry_at = Instant::now();
                status.failure_delay = Duration::ZERO;
            }
        }
        Ok(())
    }

    pub fn new(namespace: PathBuf) -> Result<Arc<Self>, IndexError> {
        let manager = Arc::new(Self {
            sources: Mutex::new(HashMap::new()),
            budget: Arc::new(DiskBudget {
                namespace,
                policy_gate: Mutex::new(()),
                space_probe: available_disk_bytes,
                state: Mutex::new(DiskState {
                    policy: DirectoryPolicy::defaults()?,
                    reserved: 0,
                    next_cleanup_at: Instant::now(),
                }),
            }),
            scans: Arc::new(Semaphore::new(limit("scan_workers")?)),
            queries: Arc::new(Semaphore::new(limit("query_workers")?)),
            updates: Arc::new(Semaphore::new(limit("query_workers")?)),
        });
        let weak = Arc::downgrade(&manager);
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(limit("event_coalescing_ms").unwrap_or(300) as u64));
            let mut maintenance_failed = false;
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(manager) = weak.upgrade() else {
                    break;
                };
                if manager.tick().is_err() {
                    if !maintenance_failed {
                        log::warn!("event=directory_maintenance_unavailable Directory maintenance paused. Check private local storage.");
                    }
                    maintenance_failed = true;
                } else if maintenance_failed {
                    log::info!("event=directory_maintenance_recovered");
                    maintenance_failed = false;
                }
            }
        });
        Ok(manager)
    }

    fn start_scan(self: &Arc<Self>, source: &Arc<LocalSource>) -> Result<(), IndexError> {
        if source.capability_failed.load(Ordering::Acquire) || source.media_unavailable.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut rebind_only = false;
        if lock(&source.next_full_pass)?.is_some_and(|deadline| Instant::now() < deadline) {
            let writer = lock(&source.writer)?;
            if !writer
                .as_ref()
                .map(DirectoryIndex::has_resumable_scan)
                .transpose()?
                .unwrap_or(false)
            {
                if lock(&source.root)?.is_some() {
                    return Ok(());
                }
                rebind_only = true;
            }
        }
        if source.stopped.load(Ordering::Acquire)
            || Instant::now() < lock(&source.status)?.retry_at
            || source
                .busy
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Ok(());
        }
        let Ok(permit) = Arc::clone(&self.scans).try_acquire_owned() else {
            source.busy.store(false, Ordering::Release);
            return Ok(());
        };
        {
            let mut status = lock(&source.status)?;
            status.state = if lock(&source.reader)?.is_some() {
                "updating"
            } else {
                INDEX_OPENING_STATE
            };
            status.stalled = false;
        }
        source.progress()?;
        if !rebind_only
            && !lock(&source.writer)?
                .as_ref()
                .map(DirectoryIndex::has_resumable_scan)
                .transpose()?
                .unwrap_or(false)
        {
            *lock(&source.next_full_pass)? = Some(Instant::now() + Duration::from_secs(limit("minimum_full_pass_spacing_seconds")? as u64));
        }
        let ownership = ScanOwnership {
            source: Arc::clone(source),
            _permit: permit,
        };
        let source = Arc::clone(source);
        let budget = Arc::clone(&self.budget);
        tauri::async_runtime::spawn(async move {
            let task_source = Arc::clone(&source);
            let task_budget = Arc::clone(&budget);
            let result = tokio::task::spawn_blocking(move || {
                let _ownership = ownership;
                let outcome = task_source.scan_with_mode(&task_budget, rebind_only);
                if let Err(error) = &outcome {
                    task_source.fail(error, &task_budget);
                }
                outcome
            })
            .await;
            if result.is_err() {
                source.fail(
                    &IndexError::Invalid("Directory worker failed. Restart the companion and retry."),
                    &budget,
                );
            }
        });
        Ok(())
    }

    fn tick(self: &Arc<Self>) -> Result<(), IndexError> {
        let policy = self.budget.policy()?;
        let mut retired = Vec::new();
        let sources: Vec<_> = {
            let mut sources = lock(&self.sources)?;
            sources.retain(|_, source| {
                let expired = source
                    .status
                    .try_lock()
                    .map(|status| status.accessed.elapsed() >= Duration::from_secs(limit("idle_release_seconds").unwrap_or(600) as u64))
                    .unwrap_or(false);
                let pending = source
                    .writer
                    .lock()
                    .ok()
                    .and_then(|writer| writer.as_ref().map(DirectoryIndex::has_pending_scan))
                    .transpose()
                    .unwrap_or(Some(true))
                    .unwrap_or(false);
                if expired
                    && !pending
                    && !source.capability_failed.load(Ordering::Acquire)
                    && !source.busy.load(Ordering::Acquire)
                    && !source.flush_busy.load(Ordering::Acquire)
                    && Arc::strong_count(source) == 1
                {
                    source.stopped.store(true, Ordering::Release);
                    retired.push(Arc::clone(source));
                    return false;
                }
                true
            });
            sources.values().cloned().collect()
        };
        for source in retired {
            let budget = Arc::clone(&self.budget);
            tauri::async_runtime::spawn(async move {
                let result = tokio::task::spawn_blocking(move || {
                    let outcome = source.close_idle(&budget);
                    drop(source);
                    lock(&budget.state)?.next_cleanup_at = Instant::now();
                    outcome
                })
                .await;
                if !matches!(result, Ok(Ok(()))) {
                    log::warn!("Directory idle close failed. Cache ownership remains protected until its worker exits.");
                }
            });
        }
        for source in sources {
            if source.capability_failed.load(Ordering::Acquire) || source.media_unavailable.load(Ordering::Acquire) {
                continue;
            }
            let stalled = {
                let status = lock(&source.status)?;
                source.busy.load(Ordering::Acquire) && !status.stalled && status.progress.elapsed() >= STALLED_READ_TIMEOUT
            };
            if stalled {
                source.invalidate_for(InvalidationReason::StalledRead)?;
                let mut status = lock(&source.status)?;
                status.stalled = true;
                status.state = "ready";
                status.message = Some(
                    "Directory read has stalled. Existing results remain available; scan capacity stays reserved until the worker exits."
                        .to_owned(),
                );
            }
            if Instant::now() < lock(&source.status)?.retry_at {
                continue;
            }
            if source
                .flush_busy
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                if let Ok(permit) = Arc::clone(&self.updates).try_acquire_owned() {
                    let task_source = Arc::clone(&source);
                    let ownership = UpdateOwnership {
                        source: Arc::clone(&source),
                        _permit: permit,
                    };
                    let budget = Arc::clone(&self.budget);
                    let scans = Arc::clone(&self.scans);
                    tauri::async_runtime::spawn(async move {
                        let result = tokio::task::spawn_blocking(move || {
                            let _ownership = ownership;
                            let result = task_source
                                .recover_watcher()
                                .and_then(|()| task_source.flush(&budget))
                                .and_then(|()| task_source.reconcile(&budget, &scans));
                            if let Err(error) = &result {
                                task_source.fail(error, &budget);
                            }
                            result
                        })
                        .await;
                        if result.is_err() {
                            log::warn!("Directory update worker failed. Restart the companion.");
                        }
                    });
                } else {
                    source.flush_busy.store(false, Ordering::Release);
                }
            }
            let required = lock(&source.observations)?.verification_required || source.watcher_failed.load(Ordering::Acquire);
            let status = lock(&source.status)?;
            let interval = if required {
                policy.degraded_verification_seconds
            } else {
                policy.healthy_verification_seconds
            };
            let due = status.verification_due(
                Instant::now(),
                Duration::from_secs(interval as u64),
                lock(&source.reader)?.is_some(),
            );
            drop(status);
            let resumable = lock(&source.writer)?
                .as_ref()
                .map(DirectoryIndex::has_resumable_scan)
                .transpose()?
                .unwrap_or(false);
            if due || resumable {
                self.start_scan(&source)?;
            }
        }
        Ok(())
    }

    pub fn issue_details(&self, drive: &str) -> Result<(Vec<DirectoryIssueDetail>, bool), IndexError> {
        let sources = lock(&self.sources)?;
        let source = sources.get(drive).ok_or(IndexError::Interrupted)?;
        source.ensure_available()?;
        let observations = lock(&source.observations)?;
        let mut details: Vec<_> = observations
            .issue_details
            .iter()
            .map(|(parent, code)| {
                let path = observations.issue_paths.get(&(parent.clone(), *code));
                let displayed = path.map(String::as_str).unwrap_or(parent);
                DirectoryIssueDetail {
                    path: if displayed.is_empty() {
                        "/".to_owned()
                    } else {
                        displayed.to_owned()
                    },
                    code,
                    scope: if path.is_some() { "directory" } else { "contents" },
                }
            })
            .collect();
        details.sort_by(|left, right| (&left.path, left.code).cmp(&(&right.path, right.code)));
        Ok((details, observations.issue_details_incomplete))
    }

    pub async fn search(
        self: &Arc<Self>,
        drive: String,
        root: PathBuf,
        query: String,
        include_dot: bool,
    ) -> Result<DirectorySearchResult, IndexError> {
        search_terms(&query)?;
        let evidence_root = root.clone();
        let evidence = tokio::task::spawn_blocking(move || volume_evidence(&evidence_root))
            .await
            .map_err(|_| IndexError::Invalid("Drive evidence worker failed. Retry the search."))??;
        let source = {
            let mut sources = lock(&self.sources)?;
            if let Some(previous) = sources.get(&drive) {
                let change = lock(&previous.volume)?.compare(&evidence);
                if change == VolumeChange::Unavailable {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::NotConnected,
                        "Directory volume is not mounted. Mount the volume to resume search.",
                    )
                    .into());
                }
                if change == VolumeChange::Generation {
                    if !previous.busy.load(Ordering::Acquire) && !previous.flush_busy.load(Ordering::Acquire) {
                        previous.invalidate()?;
                        self.start_scan(previous)?;
                    }
                    return Err(IndexError::QueryBusy);
                }
                if previous.root_path != root || change == VolumeChange::Index {
                    if previous.busy.load(Ordering::Acquire)
                        || previous.flush_busy.load(Ordering::Acquire)
                        || previous.active_queries.load(Ordering::Acquire) != 0
                    {
                        previous.invalidate()?;
                        return Err(IndexError::QueryBusy);
                    }
                    previous.stopped.store(true, Ordering::Release);
                    previous.close_idle(&self.budget)?;
                    sources.remove(&drive);
                }
            }
            Arc::clone(
                sources
                    .entry(drive.clone())
                    .or_insert_with(|| LocalSource::with_volume(root, &self.budget.namespace, evidence)),
            )
        };
        source.touch()?;
        if source.capability_failed.load(Ordering::Acquire) {
            return Err(IndexError::Invalid(MOUNT_BOUNDARY_CAPABILITY_ERROR));
        }
        if source.media_unavailable.load(Ordering::Acquire) {
            if Instant::now() < lock(&source.status)?.retry_at {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "Directory volume is temporarily unavailable. Insert or mount the volume and retry after the pause.",
                )
                .into());
            }
            source.media_unavailable.store(false, Ordering::Release);
            #[cfg(windows)]
            lock(&source.removal_watch)?.take();
        }
        self.start_scan_if_cold(&source)?;
        let reader = lock(&source.reader)?.clone();
        let Some(reader) = reader else {
            let status = lock(&source.status)?;
            return Ok(DirectorySearchResult {
                results: Vec::new(),
                total_matches: 0,
                cache_state: status.state.into(),
                directory_count: 0,
                search_contract_version: cfg!(any(target_os = "linux", target_os = "windows")).then_some(SEARCH_CONTRACT_VERSION),
                match_ranks: HashMap::new(),
                matched_term_counts: HashMap::new(),
                accepted_revision: Some(0),
                coverage: Some("partial".into()),
                coverage_issue_count: 0,
                issue_details_available: false,
                issue_details: None,
                issue_details_incomplete: false,
                last_verified_at_ms: None,
                status_message: status.message.clone(),
                monitoring_state: Some(
                    if source.watcher_failed.load(Ordering::Acquire) {
                        "unavailable"
                    } else {
                        "starting"
                    }
                    .into(),
                ),
                retry_after_ms: status.retry_after_ms(),
                scan_progress: status.scan_progress.clone(),
            });
        };
        let result = if query.trim().is_empty() {
            lock(&source.status)?.index_status.clone().ok_or(IndexError::QueryBusy)?
        } else {
            let permit = Arc::clone(&self.queries).try_acquire_owned().map_err(|_| IndexError::QueryBusy)?;
            let cancellation = QueryCancellation(Arc::new(AtomicBool::new(false)));
            let cancelled = Arc::clone(&cancellation.0);
            let task_source = Arc::clone(&source);
            source.active_queries.fetch_add(1, Ordering::AcqRel);
            let ownership = QueryOwnership {
                source: Arc::clone(&source),
                _permit: permit,
            };
            let result = tokio::task::spawn_blocking(move || {
                let _ownership = ownership;
                let observation = task_source.begin_read()?;
                task_source.ensure_available()?;
                let root = lock(&task_source.root)?.as_ref().ok_or(IndexError::QueryBusy)?.clone();
                if let Err(error) = root.verify() {
                    task_source.root_invalid.store(true, Ordering::Release);
                    return Err(error);
                }
                let response = reader.search(&query, DEFAULT_RESULT_LIMIT, include_dot, &cancelled, false)?;
                task_source.ensure_available()?;
                if let Err(error) = root.verify() {
                    task_source.root_invalid.store(true, Ordering::Release);
                    return Err(error);
                }
                if !lock(&task_source.observations)?.is_current(observation.token, "") {
                    return Err(IndexError::Interrupted);
                }
                Ok(response)
            })
            .await
            .map_err(|_| IndexError::Invalid("Directory query worker failed. Retry the search."))?;
            if source.root_invalid.swap(false, Ordering::AcqRel) {
                source.invalidate()?;
                lock(&source.root)?.take();
                lock(&source.watcher)?.take();
                self.start_scan(&source)?;
            }
            result?
        };
        source.ensure_available()?;
        let observations = lock(&source.observations)?;
        let has_details = result.coverage == "partial" && result.issue_count > 0 && !observations.issue_details.is_empty();
        let details_incomplete = observations.issue_details_incomplete;
        drop(observations);
        let status = lock(&source.status)?;
        let wire_count = |value: i64| -> Result<usize, IndexError> {
            if !(0..=MAX_WIRE_INTEGER).contains(&value) {
                return Err(IndexError::Invalid("Directory response integer exceeds the supported API range."));
            }
            usize::try_from(value).map_err(|_| IndexError::Invalid("Directory count exceeds the supported API range."))
        };
        wire_count(result.accepted_revision)?;
        if let Some(verified) = result.last_verified_at_ms {
            wire_count(verified)?;
        }
        Ok(DirectorySearchResult {
            match_ranks: result.results.iter().map(|row| (row.path.clone(), row.match_rank)).collect(),
            matched_term_counts: result
                .results
                .iter()
                .map(|row| (row.path.clone(), row.matched_term_count))
                .collect(),
            results: result.results.into_iter().map(|row| row.path).collect(),
            total_matches: wire_count(result.total_matches)?,
            directory_count: wire_count(result.directory_count)?,
            cache_state: status.state.into(),
            search_contract_version: cfg!(any(target_os = "linux", target_os = "windows")).then_some(SEARCH_CONTRACT_VERSION),
            accepted_revision: Some(result.accepted_revision),
            coverage: Some(result.coverage),
            coverage_issue_count: wire_count(result.issue_count)?,
            issue_details_available: has_details,
            issue_details: None,
            issue_details_incomplete: details_incomplete,
            last_verified_at_ms: result.last_verified_at_ms,
            status_message: status.message.clone(),
            monitoring_state: Some(
                if source.watcher_failed.load(Ordering::Acquire) {
                    "unavailable"
                } else if source.watcher_reconciling.load(Ordering::Acquire) {
                    "recovering"
                } else {
                    "healthy"
                }
                .into(),
            ),
            retry_after_ms: status.retry_after_ms(),
            scan_progress: status.scan_progress.clone(),
        })
    }

    fn start_scan_if_cold(self: &Arc<Self>, source: &Arc<LocalSource>) -> Result<(), IndexError> {
        if (lock(&source.reader)?.is_none() || lock(&source.root)?.is_none()) && Instant::now() >= lock(&source.status)?.retry_at {
            self.start_scan(source)?;
        }
        Ok(())
    }
}

impl Drop for LocalDirectoryManager {
    fn drop(&mut self) {
        if let Ok(sources) = self.sources.lock() {
            for source in sources.values() {
                source.stopped.store(true, Ordering::Release);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn issue_details_remove_deleted_subtree_after_reconciliation() {
        for parent_hint in [false, true] {
            issue_details_remove_deleted_subtree(parent_hint);
        }
    }

    fn issue_details_remove_deleted_subtree(parent_hint: bool) {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir_all(path.join("private/child")).unwrap();
        std::fs::create_dir(path.join("private-backup")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("storage")).unwrap();
        let source = LocalSource::new(path.clone(), manager.storage_directory());
        source.scan(&manager.budget).unwrap();
        {
            let mut observations = lock(&source.observations).unwrap();
            for parent in ["", "private", "private/child", "private-backup"] {
                observations
                    .publish_issue_details(parent, &HashMap::from([("access_denied", 1)]))
                    .unwrap();
            }
            observations
                .enqueue(
                    if parent_hint {
                        DirectoryMutation::ReadParent { path: String::new() }
                    } else {
                        DirectoryMutation::Remove { path: "private".into() }
                    },
                    limit("max_pending_observations").unwrap(),
                    limit("max_observation_bytes").unwrap(),
                )
                .unwrap();
        }
        std::fs::remove_dir_all(path.join("private")).unwrap();
        source.flush(&manager.budget).unwrap();
        source.reconcile(&manager.budget, &manager.scans).unwrap();
        assert_eq!(
            lock(&source.observations).unwrap().issue_details,
            HashSet::from([("private-backup".to_owned(), "access_denied")])
        );
    }

    #[test]
    fn issue_details_preserved_when_subtree_deletion_rolls_back() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir_all(path.join("private/child")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("storage")).unwrap();
        let source = LocalSource::new(path, manager.storage_directory());
        source.scan(&manager.budget).unwrap();
        let samples = HashSet::from([
            ("private".to_owned(), "access_denied"),
            ("private/child".to_owned(), "access_denied"),
        ]);
        {
            let mut observations = lock(&source.observations).unwrap();
            observations.issue_details = samples.clone();
            observations
                .enqueue(
                    DirectoryMutation::Remove { path: "private".into() },
                    limit("max_pending_observations").unwrap(),
                    limit("max_observation_bytes").unwrap(),
                )
                .unwrap();
        }
        let connection = open_directory_database(&source.index_path, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        connection.execute_batch(
            "CREATE TRIGGER reject_sample_deletion BEFORE DELETE ON directories WHEN OLD.path = 'private' BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END",
        ).unwrap();
        assert!(matches!(source.flush(&manager.budget), Err(IndexError::Sql(_))));
        assert_eq!(lock(&source.observations).unwrap().issue_details, samples);
        assert!(!lock(&source.observations).unwrap().pending.is_empty());
        assert!(lock(&source.writer)
            .unwrap()
            .as_ref()
            .unwrap()
            .contains_directory(1, "private/child")
            .unwrap());
        connection.execute_batch("DROP TRIGGER reject_sample_deletion").unwrap();
        source.flush(&manager.budget).unwrap();
        assert!(lock(&source.observations).unwrap().issue_details.is_empty());
    }

    #[test]
    fn issue_detail_samples_are_bounded_and_replaced_by_clean_reads() {
        let mut observations = Observations::default();
        let maximum = limit("max_logged_scan_issues_per_pass").unwrap();
        for number in 0..=maximum {
            observations
                .publish_issue_details(&format!("parent-{number}"), &HashMap::from([("access_denied", 1)]))
                .unwrap();
        }
        assert_eq!(observations.issue_details.len(), maximum);
        assert!(observations.issue_details_incomplete);
        observations.publish_issue_details("parent-0", &HashMap::new()).unwrap();
        assert!(!observations.issue_details.iter().any(|(parent, _code)| parent == "parent-0"));
        observations
            .publish_issue_details("parent-1", &HashMap::from([("scan_failed", 1)]))
            .unwrap();
        assert!(observations.issue_details.contains(&("parent-1".to_owned(), "scan_failed")));
        assert!(!observations.issue_details.contains(&("parent-1".to_owned(), "access_denied")));
    }

    #[test]
    fn scan_group_buffers_parent_issues() {
        for (early_flush, stale, reconcile) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (true, true, false),
            (false, false, true),
            (true, false, true),
            (false, true, true),
            (true, true, true),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("root");
            std::fs::create_dir(&path).unwrap();
            let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
            let source = LocalSource::new(path, manager.storage_directory());
            source.scan(&manager.budget).unwrap();
            {
                let mut writer = lock(&source.writer).unwrap();
                if reconcile {
                    writer.as_mut().unwrap().queue_reconciliation_parent(1, "").unwrap();
                } else {
                    writer.as_mut().unwrap().prepare_scan().unwrap();
                }
                let mut observations = lock(&source.observations).unwrap();
                observations.scan_group = Some(HashMap::new());
                observations.scan_group_reconcile = reconcile;
                observations.scan_group_test_elapsed = Some(Duration::ZERO);
                observations.scan_commits = 0;
            }
            let read = source.begin_read().unwrap();
            source
                .record_item_issue_with_path(1, "", read.token, "unsupported_encoding", Some("child-too-long"), &manager.budget)
                .unwrap();
            if early_flush {
                let mut observations = lock(&source.observations).unwrap();
                source.flush_scan_group_locked(&mut observations, &manager.budget).unwrap();
            }
            source
                .record_item_issue_with_path(1, "", read.token, "unsupported_encoding", Some("another-child"), &manager.budget)
                .unwrap();
            assert_eq!(lock(&source.writer).unwrap().as_ref().unwrap().status().unwrap().issue_count, 0);
            assert!(lock(&source.observations).unwrap().issue_details.is_empty());
            let mut observations = lock(&source.observations).unwrap();
            source
                .complete_scan_parent_locked(&mut observations, ScanGeneration { id: 1, read: read.token }, "", &manager.budget)
                .unwrap();
            if stale {
                observations.invalidate().unwrap();
            }
            let flushed = source.flush_scan_group_locked(&mut observations, &manager.budget);
            if stale {
                assert!(matches!(flushed, Err(IndexError::Interrupted)));
            } else {
                flushed.unwrap();
            }
            assert_eq!(observations.scan_commits, usize::from(!stale));
            assert!(observations.pending_scan_issues.is_empty());
            assert!(observations.pending_issue_paths.is_empty());
            assert!(observations.producers.is_empty());
            assert_eq!(observations.issue_details.len(), usize::from(!stale));
            assert_eq!(
                observations
                    .issue_paths
                    .get(&(String::new(), "unsupported_encoding"))
                    .map(String::as_str),
                if stale { None } else { Some("child-too-long") }
            );
            assert_eq!(
                lock(&source.writer).unwrap().as_ref().unwrap().status().unwrap().issue_count,
                if stale { 0 } else { 2 }
            );
            if stale {
                assert_eq!(
                    lock(&source.writer)
                        .unwrap()
                        .as_ref()
                        .unwrap()
                        .pending_scan_paths(1, ROW_BATCH_SIZE)
                        .unwrap(),
                    vec![String::new()]
                );
            }
        }
    }

    #[test]
    fn reconciliation_groups_independent_pages_with_bounded_admission() {
        const PARENT_COUNT: usize = ROW_BATCH_SIZE + 1;
        const ROOT_ADMISSION_ALLOWANCE: usize = 2;
        thread_local! {
            static SPACE_PROBES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
        }
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir(&path).unwrap();
        for parent in 0..PARENT_COUNT {
            std::fs::create_dir(path.join(format!("parent-{parent}"))).unwrap();
        }
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path, manager.storage_directory());
        source.scan(&manager.budget).unwrap();
        {
            let mut writer = lock(&source.writer).unwrap();
            for parent in 0..PARENT_COUNT {
                writer
                    .as_mut()
                    .unwrap()
                    .queue_reconciliation_parent(1, &format!("parent-{parent}"))
                    .unwrap();
            }
            let mut observations = lock(&source.observations).unwrap();
            observations.scan_group_test_elapsed = Some(Duration::ZERO);
            observations.scan_commits = 0;
        }
        let policy = DirectoryPolicy::defaults().unwrap();
        let next_cleanup_at = Instant::now() + Duration::from_secs(u64::try_from(policy.degraded_verification_seconds).unwrap());
        let budget = Arc::new(DiskBudget {
            namespace: manager.storage_directory().to_path_buf(),
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy,
                reserved: 0,
                next_cleanup_at,
            }),
            space_probe: |_| {
                SPACE_PROBES.with(|count| count.set(count.get() + 1));
                Ok(u64::MAX)
            },
        });
        source.reconcile(&budget, &manager.scans).unwrap();
        let observations = lock(&source.observations).unwrap();
        assert_eq!(observations.scan_commits, 1);
        assert!(SPACE_PROBES.with(|count| count.get()) <= observations.scan_commits + ROOT_ADMISSION_ALLOWANCE);
        assert!(observations.scan_group.is_none());
        assert!(!observations.scan_group_reconcile);
        assert!(observations.producers.is_empty());
        assert!(observations.pending_scan_issues.is_empty());
        let writer = lock(&source.writer).unwrap();
        assert!(writer.as_ref().unwrap().pending_scan_paths(1, ROW_BATCH_SIZE).unwrap().is_empty());
        assert_eq!(
            writer.as_ref().unwrap().status().unwrap().directory_count,
            i64::try_from(PARENT_COUNT).unwrap()
        );
        assert_eq!(lock(&budget.state).unwrap().reserved, 0);
    }

    #[test]
    fn full_native_tree_does_not_open_regular_files() {
        const FILES_PER_PARENT: usize = 32;
        const PARENTS: [&str; 5] = ["", "shallow", "deep", "deep/deeper", "deep/deeper/leaf"];
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        for parent in PARENTS {
            std::fs::create_dir_all(path.join(parent)).unwrap();
        }
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path.clone(), manager.storage_directory());
        lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
        source.scan(&manager.budget).unwrap();
        assert!(lock(&source.watcher).unwrap().is_none());
        let before = source.io.opens();
        source.scan(&manager.budget).unwrap();
        let directory_only_opens = source.io.opens() - before;
        for parent in PARENTS {
            for file in 0..FILES_PER_PARENT {
                std::fs::write(path.join(parent).join(format!("file-{file}")), b"file").unwrap();
            }
        }
        let before = source.io.opens();
        source.scan(&manager.budget).unwrap();
        assert!(lock(&source.watcher).unwrap().is_none());
        assert_eq!(source.io.opens() - before, directory_only_opens);
        let writer = lock(&source.writer).unwrap();
        let status = writer.as_ref().unwrap().status().unwrap();
        assert_eq!(status.directory_count, i64::try_from(PARENTS.len() - 1).unwrap());
        assert_eq!(status.coverage, "complete");
    }

    #[test]
    fn shared_scan_tree_fixtures() {
        const EXPECTED_METADATA_WRITES: i64 = 5;
        const QUEUE_WRITES_PER_PARENT: usize = 2;
        const WIDE_PARENT_DEPTH: usize = 5;
        const WIDE_COMPONENT_PADDING: usize = 200;
        const COUNTED_TABLES: [&str; 5] = [
            "directories",
            "scan_queue",
            "generations",
            "source_metadata",
            "scan_snapshot_children",
        ];
        let mut fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../../../shared/directory-index/search-fixtures.json")).unwrap();
        let mut wide_paths = Vec::new();
        let mut parent = String::new();
        for depth in 0..WIDE_PARENT_DEPTH {
            let component = format!("tree-level-{depth}-{}", "p".repeat(WIDE_COMPONENT_PADDING));
            parent = if parent.is_empty() {
                component
            } else {
                format!("{parent}/{component}")
            };
            wide_paths.push(parent.clone());
        }
        let child_count = limit("max_observation_bytes").unwrap() / parent.len() + ROW_BATCH_SIZE;
        for child in 0..child_count {
            wide_paths.push(format!("{parent}/tree-child-{child}-{}", "c".repeat(WIDE_COMPONENT_PADDING)));
        }
        fixtures["scan_trees"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name": "forced-stream", "passes": [wide_paths]}));
        for fixture in fixtures["scan_trees"].as_array().unwrap() {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("root");
            std::fs::create_dir(&path).unwrap();
            let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
            let source = LocalSource::new(path.clone(), manager.storage_directory());
            lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
            let mut previous: Vec<String> = Vec::new();
            for pass in fixture["passes"].as_array().unwrap() {
                let mut expected: Vec<String> = pass
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_str().unwrap().to_owned())
                    .collect();
                for removed in previous.iter().rev().filter(|value| !expected.contains(value)) {
                    std::fs::remove_dir(path.join(removed)).unwrap();
                }
                for directory in &expected {
                    std::fs::create_dir_all(path.join(directory)).unwrap();
                }
                for unchanged in [false, true] {
                    let metrics = unchanged.then(|| {
                        let metrics = rusqlite::Connection::open(&source.index_path).unwrap();
                        metrics.execute_batch("CREATE TABLE scan_test_writes(table_name TEXT PRIMARY KEY, writes INTEGER NOT NULL);").unwrap();
                        for table in COUNTED_TABLES {
                            metrics.execute("INSERT INTO scan_test_writes VALUES (?, 0)", [table]).unwrap();
                            for operation in ["INSERT", "UPDATE", "DELETE"] {
                                metrics.execute_batch(&format!("CREATE TRIGGER scan_test_{table}_{operation} AFTER {operation} ON {table} BEGIN UPDATE scan_test_writes SET writes = writes + 1 WHERE table_name = '{table}'; END;")).unwrap();
                            }
                        }
                        metrics
                    });
                    let shadows = [
                        "directory_fts_data",
                        "directory_fts_idx",
                        "directory_fts_docsize",
                        "directory_fts_config",
                    ];
                    let shadow_rows: Vec<i64> = metrics.as_ref().map_or_else(Vec::new, |metrics| {
                        shadows
                            .iter()
                            .map(|table| {
                                metrics
                                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))
                                    .unwrap()
                            })
                            .collect()
                    });
                    source.scan(&manager.budget).unwrap();
                    assert!(lock(&source.watcher).unwrap().is_none());
                    let writer = lock(&source.writer).unwrap();
                    let result = writer
                        .as_ref()
                        .unwrap()
                        .search(
                            "tree",
                            expected.len().max(1).min(limit("max_result_limit").unwrap()),
                            false,
                            &Arc::new(AtomicBool::new(false)),
                            false,
                        )
                        .unwrap();
                    let reader =
                        rusqlite::Connection::open_with_flags(&source.index_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
                    let mut statement = reader.prepare("SELECT path FROM directories ORDER BY path").unwrap();
                    let actual: Vec<String> = statement
                        .query_map([], |row| row.get(0))
                        .unwrap()
                        .collect::<Result<_, _>>()
                        .unwrap();
                    expected.sort();
                    assert_eq!(actual, expected, "{}", fixture["name"]);
                    let mut searched: Vec<String> = result.results.into_iter().map(|entry| entry.path).collect();
                    searched.sort();
                    assert_eq!(searched.len(), expected.len().min(limit("max_result_limit").unwrap()));
                    assert!(searched.iter().all(|path| expected.binary_search(path).is_ok()));
                    if expected.len() <= limit("max_result_limit").unwrap() {
                        assert_eq!(searched, expected);
                    }
                    assert_eq!(result.directory_count, i64::try_from(expected.len()).unwrap());
                    assert_eq!(result.total_matches, result.directory_count);
                    assert_eq!(result.coverage, "complete");
                    if let Some(metrics) = metrics {
                        let writes = |table: &str| {
                            metrics
                                .query_row("SELECT writes FROM scan_test_writes WHERE table_name = ?", [table], |row| {
                                    row.get::<_, i64>(0)
                                })
                                .unwrap()
                        };
                        assert_eq!(writes("directories"), 0);
                        assert_eq!(
                            writes("scan_queue"),
                            i64::try_from((expected.len() + 1) * QUEUE_WRITES_PER_PARENT).unwrap()
                        );
                        assert_eq!(writes("generations") + writes("source_metadata"), EXPECTED_METADATA_WRITES);
                        if fixture["name"] == "forced-stream" {
                            assert!(writes("scan_snapshot_children") > 0);
                            assert_eq!(
                                metrics
                                    .query_row("SELECT count(*) FROM scan_snapshot_children", [], |row| row.get::<_, i64>(0))
                                    .unwrap(),
                                0
                            );
                        }
                        assert_eq!(
                            metrics
                                .query_row("SELECT count(*) FROM generations", [], |row| row.get::<_, i64>(0))
                                .unwrap(),
                            1
                        );
                        for (table, before) in shadows.iter().zip(shadow_rows) {
                            assert_eq!(
                                metrics
                                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get::<_, i64>(0))
                                    .unwrap(),
                                before
                            );
                        }
                        for table in COUNTED_TABLES {
                            for operation in ["INSERT", "UPDATE", "DELETE"] {
                                metrics
                                    .execute_batch(&format!("DROP TRIGGER scan_test_{table}_{operation};"))
                                    .unwrap();
                            }
                        }
                        metrics.execute_batch("DROP TABLE scan_test_writes;").unwrap();
                    }
                }
                previous = expected;
            }
        }
    }

    #[test]
    fn streamed_native_snapshots_add_and_remove_children() {
        const CHILD_COUNT: usize = ROW_BATCH_SIZE + 1;
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir_all(path.join("parent")).unwrap();
        for number in 0..CHILD_COUNT {
            std::fs::create_dir(path.join(format!("parent/child-{number}"))).unwrap();
        }
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path.clone(), manager.storage_directory());
        lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
        lock(&source.observations).unwrap().scan_group_test_elapsed =
            Some(Duration::from_millis(limit("scan_commit_interval_ms").unwrap() as u64));
        source.scan(&manager.budget).unwrap();
        assert!(lock(&source.watcher).unwrap().is_none());
        std::fs::remove_dir(path.join("parent/child-0")).unwrap();
        std::fs::create_dir(path.join("parent/new")).unwrap();
        source.scan(&manager.budget).unwrap();
        assert!(lock(&source.watcher).unwrap().is_none());
        let writer = lock(&source.writer).unwrap();
        let index = writer.as_ref().unwrap();
        assert_eq!(index.status().unwrap().directory_count, i64::try_from(CHILD_COUNT + 1).unwrap());
        assert_eq!(index.status().unwrap().coverage, "complete");
        assert_eq!(index.scan_parent_file_id(1, "parent/child-0").unwrap(), None);
        assert!(index.scan_parent_file_id(1, "parent/child-1").unwrap().is_some());
        assert!(index.scan_parent_file_id(1, "parent/new").unwrap().is_some());
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "Explicit local filesystem performance measurement."]
    fn ten_thousand_empty_folders_local_scan_measurement() {
        const PARENT_COUNT: usize = 10_000;
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir(&path).unwrap();
        for number in 0..PARENT_COUNT {
            std::fs::create_dir(path.join(format!("empty-{number}"))).unwrap();
        }
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path, manager.storage_directory());
        source.recover_watcher().unwrap();
        source.watcher_reconciling.store(false, Ordering::Release);
        for pass in ["initial", "unchanged"] {
            let opens = source.io.opens();
            let started = Instant::now();
            source.scan(&manager.budget).unwrap();
            let elapsed = started.elapsed();
            let status = lock(&source.writer).unwrap().as_ref().unwrap().status().unwrap();
            assert_eq!(status.directory_count, i64::try_from(PARENT_COUNT).unwrap());
            assert_eq!(status.coverage, "complete");
            println!(
                "local_scan pass={pass} parents={PARENT_COUNT} elapsed_ms={} native_opens={} group_commits={}",
                elapsed.as_millis(),
                source.io.opens() - opens,
                lock(&source.observations).unwrap().scan_commits
            );
        }
    }

    #[test]
    fn complete_native_snapshots_add_and_remove_children_in_place() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir_all(path.join("parent/old")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path.clone(), manager.storage_directory());
        lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
        source.scan(&manager.budget).unwrap();
        assert!(lock(&source.watcher).unwrap().is_none());
        std::fs::remove_dir(path.join("parent/old")).unwrap();
        std::fs::create_dir(path.join("parent/new")).unwrap();
        source.scan(&manager.budget).unwrap();
        assert!(lock(&source.watcher).unwrap().is_none());
        let writer = lock(&source.writer).unwrap();
        let index = writer.as_ref().unwrap();
        assert_eq!(index.status().unwrap().directory_count, 2);
        assert_eq!(index.status().unwrap().coverage, "complete");
        assert_eq!(index.scan_parent_file_id(1, "parent/old").unwrap(), None);
        assert!(index.scan_parent_file_id(1, "parent/new").unwrap().is_some());
    }

    fn grouped_source() -> (tempfile::TempDir, Arc<LocalDirectoryManager>, Arc<LocalSource>) {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir(&path).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path, manager.storage_directory());
        source.bind_root(&manager.budget).unwrap();
        lock(&source.observations).unwrap().scan_group = Some(HashMap::new());
        lock(&source.observations).unwrap().scan_group_test_elapsed = Some(Duration::ZERO);
        (temporary, manager, source)
    }

    #[test]
    fn empty_parents_share_bookkeeping_commits() {
        let (_temporary, manager, source) = grouped_source();
        let parents: Vec<_> = (0..10_000).map(|number| format!("empty-{number}")).collect();
        {
            let mut writer = lock(&source.writer).unwrap();
            let index = writer.as_mut().unwrap();
            index.seed_scan(1).unwrap();
            for page in parents.chunks(ROW_BATCH_SIZE) {
                index
                    .write_children(1, page.iter().cloned().map(|path| (path, true)), None, &HashMap::new())
                    .unwrap();
            }
            index.finish_scan_parent(1, "").unwrap();
        }
        let mut seen = Vec::new();
        loop {
            let excluded: Vec<_> = lock(&source.observations)
                .unwrap()
                .scan_group
                .as_ref()
                .unwrap()
                .values()
                .map(|entry| entry.parent.clone())
                .collect();
            let page = lock(&source.writer)
                .unwrap()
                .as_ref()
                .unwrap()
                .pending_scan_paths_excluding(1, ROW_BATCH_SIZE, &excluded)
                .unwrap();
            if page.is_empty() {
                break;
            }
            for parent in page {
                let read = source.begin_read().unwrap();
                source
                    .complete_scan_parent_locked(
                        &mut lock(&source.observations).unwrap(),
                        ScanGeneration { id: 1, read: read.token },
                        &parent,
                        &manager.budget,
                    )
                    .unwrap();
                seen.push(parent);
            }
        }
        let mut observations = lock(&source.observations).unwrap();
        source.flush_scan_group_locked(&mut observations, &manager.budget).unwrap();
        assert_eq!(seen, parents);
        assert!((1..=2).contains(&observations.scan_commits));
        assert!(observations.producers.is_empty());
        assert!(lock(&source.writer)
            .unwrap()
            .as_ref()
            .unwrap()
            .pending_scan_paths(1, 1)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn content_group_commits_at_parent_cap() {
        let (_temporary, manager, source) = grouped_source();
        let cap = limit("scan_commit_max_parents").unwrap();
        let parents: Vec<_> = (0..cap).map(|number| format!("parent-{number}")).collect();
        lock(&source.writer)
            .unwrap()
            .as_mut()
            .unwrap()
            .write_paths(parents.clone(), None)
            .unwrap();
        for parent in parents {
            let read = source.begin_read().unwrap();
            let scan = ScanGeneration { id: 1, read: read.token };
            let child = format!("{parent}/child");
            let mut observations = lock(&source.observations).unwrap();
            source
                .stage_scan_parent_locked(&mut observations, scan, &parent, true, child.len(), &manager.budget)
                .unwrap();
            observations
                .scan_group
                .as_mut()
                .unwrap()
                .get_mut(&read.token.producer)
                .unwrap()
                .children
                .push((child, true));
            source
                .complete_scan_parent_locked(&mut observations, scan, &parent, &manager.budget)
                .unwrap();
        }
        let observations = lock(&source.observations).unwrap();
        assert_eq!(observations.scan_commits, 1);
        assert!(observations.scan_group.as_ref().unwrap().is_empty());
        assert!(observations.producers.is_empty());
    }

    #[test]
    fn bookkeeping_group_commits_at_byte_bound() {
        let (_temporary, manager, source) = grouped_source();
        let parent = "a".repeat(limit("max_observation_bytes").unwrap());
        let read = source.begin_read().unwrap();
        let mut observations = lock(&source.observations).unwrap();
        source
            .complete_scan_parent_locked(
                &mut observations,
                ScanGeneration { id: 1, read: read.token },
                &parent,
                &manager.budget,
            )
            .unwrap();
        assert_eq!(observations.scan_commits, 1);
        assert!(observations.scan_group.as_ref().unwrap().is_empty());
    }

    #[test]
    fn group_interval_starts_at_first_parent() {
        for content in [false, true] {
            let (_temporary, manager, source) = grouped_source();
            let interval = if content {
                Duration::from_millis(limit("scan_commit_interval_ms").unwrap() as u64)
            } else {
                Duration::from_millis(limit("scan_bookkeeping_commit_interval_ms").unwrap() as u64)
            };
            let read = source.begin_read().unwrap();
            let scan = ScanGeneration { id: 1, read: read.token };
            let mut observations = lock(&source.observations).unwrap();
            observations.scan_group_started = Some(Instant::now() - interval);
            source
                .stage_scan_parent_locked(&mut observations, scan, "", content, 0, &manager.budget)
                .unwrap();
            if content {
                observations
                    .scan_group
                    .as_mut()
                    .unwrap()
                    .get_mut(&read.token.producer)
                    .unwrap()
                    .children
                    .push(("child".to_owned(), true));
            }
            source
                .complete_scan_parent_locked(&mut observations, scan, "", &manager.budget)
                .unwrap();
            assert_eq!(observations.scan_commits, 0);
            assert!(observations.scan_group_started.unwrap().elapsed() < interval);
            observations.scan_group_started = Some(Instant::now() - interval);
            observations.scan_group_test_elapsed = Some(interval);
            source.flush_scan_group_if_due_locked(&mut observations, &manager.budget).unwrap();
            assert_eq!(observations.scan_commits, 1);
        }
    }

    use super::*;

    #[test]
    fn shared_contract_exposes_scan_pipeline_limits() {
        assert_eq!(limit("scan_pipeline_depth").unwrap(), 8);
        assert_eq!(limit("scan_credit_reserve").unwrap(), 16);
    }

    #[test]
    fn scan_progress_serialization_matches_the_shared_contract() {
        for phase in ["building", "updating", "idle"] {
            let progress = ScanProgress {
                phase,
                parents_done: 1,
                parents_queued: 2,
                directories_found: 3,
                started_at_ms: 4,
            };
            let serialized = serde_json::to_value(progress).unwrap();
            let fields = &contract().unwrap().scan_progress.fields;
            assert_eq!(serialized.as_object().unwrap().len(), fields.len());
            assert!(fields.iter().all(|field| serialized.get(field).is_some()));
            assert_eq!(serialized["phase"], phase);
            assert_eq!(serialized["directories_found"], 3);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn cold_source_reports_opening_before_scan_progress() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir(&path).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path, manager.storage_directory());
        {
            let status = lock(&source.status).unwrap();
            assert_eq!(status.state, INDEX_OPENING_STATE);
            assert!(status.scan_progress.is_none());
        }
        source.scan(&manager.budget).unwrap();
        let status = lock(&source.status).unwrap();
        assert_eq!(status.state, "ready");
        assert_eq!(status.scan_progress.as_ref().unwrap().phase, "idle");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn full_pass_root_probes_have_a_fixed_open_budget() {
        const CHILD_COUNT: usize = 16;
        const BOUNDARY_PROBES: u64 = 2;
        const MAX_PARENT_OPEN_ATTEMPTS: u64 = 4;
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        for number in 0..CHILD_COUNT {
            std::fs::create_dir_all(path.join(format!("child-{number}"))).unwrap();
        }
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path, manager.storage_directory());
        let root = source.bind_root(&manager.budget).unwrap();
        let before = source.io.opens();
        root.verify().unwrap();
        let root_probe_opens = source.io.opens() - before;
        source.recover_watcher().unwrap();
        source.watcher_reconciling.store(false, Ordering::Release);
        for _pass in 0..2 {
            let before = source.io.opens();
            source.scan(&manager.budget).unwrap();
            let maximum_opens = BOUNDARY_PROBES * root_probe_opens + MAX_PARENT_OPEN_ATTEMPTS * (CHILD_COUNT as u64 + 1);
            assert!(source.io.opens() - before <= maximum_opens);
            assert!(lock(&source.observations).unwrap().scan_group.is_none());
            assert_eq!(
                lock(&source.writer).unwrap().as_ref().unwrap().status().unwrap().directory_count,
                CHILD_COUNT as i64
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parent_read_errors_request_verification_before_the_next_scan_read() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir_all(path.join("parent")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path.clone(), manager.storage_directory());
        let root = source.bind_root(&manager.budget).unwrap();
        assert!(matches!(
            source.with_parent_read(&root, "parent", |_| Err(IndexError::Interrupted)),
            Err(IndexError::Interrupted)
        ));
        std::fs::rename(&path, temporary.path().join("previous")).unwrap();
        std::fs::create_dir_all(path.join("parent")).unwrap();
        assert!(root.open_parent_for_scan("parent").is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unwatched_parallel_read_rejects_parent_moved_outside_root() {
        for reconcile in [false, true] {
            for publish_batch in [false, true] {
                for parallel in [false, true] {
                    let temporary = tempfile::tempdir().unwrap();
                    let path = temporary.path().join("root");
                    std::fs::create_dir_all(path.join("parent")).unwrap();
                    let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
                    let source = LocalSource::new(path.clone(), manager.storage_directory());
                    let root = source.bind_root(&manager.budget).unwrap();
                    assert!(lock(&source.watcher).unwrap().is_none());
                    {
                        let mut writer = lock(&source.writer).unwrap();
                        let index = writer.as_mut().unwrap();
                        index.seed_scan(1).unwrap();
                        index
                            .commit_scan_parents(1, &[(String::new(), vec![("parent".into(), true)])])
                            .unwrap();
                        index
                            .commit_scan_parents(1, &[("parent".into(), vec![("parent/retained".into(), false)])])
                            .unwrap();
                        if reconcile {
                            assert!(index.finish_generation(1, 0).unwrap());
                            index.queue_reconciliation_parent(1, "parent").unwrap();
                        } else {
                            index.defer_scan_parent(1, "parent").unwrap();
                        }
                    }
                    {
                        let mut observations = lock(&source.observations).unwrap();
                        observations.scan_group = Some(HashMap::new());
                        observations.scan_group_reconcile = reconcile;
                    }
                    let gate = Arc::new(std::sync::Barrier::new(2));
                    *lock(&source.io.parent_read_gate).unwrap() = Some(Arc::clone(&gate));
                    std::thread::scope(|scope| {
                        let worker = scope.spawn(|| {
                            if parallel {
                                source.scan_native_parent_page(&root, 1, &["parent".into()], &manager.budget)
                            } else {
                                source.scan_parent(&root, 1, "parent", &manager.budget)
                            }
                        });
                        gate.wait();
                        let outside = temporary.path().join("outside");
                        std::fs::rename(path.join("parent"), &outside).unwrap();
                        std::fs::create_dir(path.join("parent")).unwrap();
                        if publish_batch {
                            std::fs::create_dir(outside.join("only-created-outside")).unwrap();
                        }
                        gate.wait();
                        worker.join().unwrap().unwrap();
                    });
                    *lock(&source.io.parent_read_gate).unwrap() = None;
                    source
                        .flush_scan_group_locked(&mut lock(&source.observations).unwrap(), &manager.budget)
                        .unwrap();
                    let writer = lock(&source.writer).unwrap();
                    let index = writer.as_ref().unwrap();
                    assert_eq!(index.status().unwrap().directory_count, 2);
                    assert_eq!(index.scan_parent_file_id(1, "parent/only-created-outside").unwrap(), None);
                    assert!(!index.scan_parent_pending(1, "parent").unwrap());
                    assert_eq!(index.status().unwrap().issue_count, 1);
                    assert!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap().is_empty());
                    assert!(lock(&source.observations).unwrap().producers.is_empty());
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn healthy_watcher_publication_checks_add_no_native_opens() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir_all(path.join("parent")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path, manager.storage_directory());
        let root = source.bind_root(&manager.budget).unwrap();
        source.recover_watcher().unwrap();
        source.watcher_reconciling.store(false, Ordering::Release);
        let parent = root.open_parent_for_scan("parent").unwrap();
        let before = source.io.opens();
        source.verify_native_publication(&root, "parent", &parent).unwrap();
        assert_eq!(source.io.opens(), before);
        for failed in [false, true] {
            source.watcher_failed.store(failed, Ordering::Release);
            source.watcher_reconciling.store(!failed, Ordering::Release);
            let before = source.io.opens();
            source.verify_native_publication(&root, "parent", &parent).unwrap();
            assert!(source.io.opens() > before);
        }
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn reconciliation_reads_replaced_child_with_refreshed_file_id() {
        for processed in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("root");
            std::fs::create_dir_all(path.join("parent/child")).unwrap();
            let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
            let source = LocalSource::new(path.clone(), manager.storage_directory());
            let root = source.bind_root(&manager.budget).unwrap();
            {
                let mut writer = lock(&source.writer).unwrap();
                let index = writer.as_mut().unwrap();
                index.write_paths(["parent".to_owned()], None).unwrap();
                assert!(index.finish_generation(1, 0).unwrap());
                index.queue_reconciliation_parent(1, "parent").unwrap();
            }
            source
                .scan_native_parent_page(&root, 1, &["parent".into()], &manager.budget)
                .unwrap();
            let old_id = lock(&source.writer)
                .unwrap()
                .as_ref()
                .unwrap()
                .scan_parent_file_id(1, "parent/child")
                .unwrap()
                .unwrap();
            if processed {
                source
                    .scan_native_parent_page(&root, 1, &["parent/child".into()], &manager.budget)
                    .unwrap();
                assert!(!lock(&source.writer)
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .scan_parent_pending(1, "parent/child")
                    .unwrap());
            }
            std::fs::rename(path.join("parent/child"), temporary.path().join("previous-child")).unwrap();
            std::fs::create_dir_all(path.join("parent/child/new-descendant")).unwrap();
            let new_id = root.parent_identity("parent/child").unwrap().file_id();
            assert_ne!(old_id, new_id);
            lock(&source.writer)
                .unwrap()
                .as_mut()
                .unwrap()
                .queue_reconciliation_parent(1, "parent")
                .unwrap();
            source.reconcile(&manager.budget, &manager.scans).unwrap();
            let writer = lock(&source.writer).unwrap();
            let index = writer.as_ref().unwrap();
            assert_eq!(index.scan_parent_file_id(1, "parent/child").unwrap(), Some(new_id));
            let cancelled = Arc::new(AtomicBool::new(false));
            assert_eq!(
                index
                    .reader()
                    .search("new-descendant", 10, true, &cancelled, false)
                    .unwrap()
                    .total_matches,
                1
            );
            assert_eq!(index.reconciliation_generation().unwrap(), None);
            assert_eq!(index.status().unwrap().coverage, "complete");
            assert_eq!(index.status().unwrap().issue_count, 0);
            assert!(lock(&source.observations).unwrap().producers.is_empty());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn held_parent_scan_bounds_opens_across_batches_and_pruning() {
        const ROOT_AND_DEVICE_OPENS: u64 = 2;
        const FALLBACK_PARENT_OPENS: u64 = 2;
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        let child_count = ROW_BATCH_SIZE + 1;
        for number in 0..child_count {
            std::fs::create_dir_all(path.join("parent").join(format!("child-{number}"))).unwrap();
        }
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path.clone(), manager.storage_directory());
        let root = source.bind_root(&manager.budget).unwrap();
        {
            let mut writer = lock(&source.writer).unwrap();
            let index = writer.as_mut().unwrap();
            index.seed_scan(1).unwrap();
            index
                .commit_scan_parents_with_ids(1, &[(String::new(), vec![("parent".into(), true)])], &HashMap::new())
                .unwrap();
        }
        let before = source.io.opens();
        source.scan_parent(&root, 1, "parent", &manager.budget).unwrap();
        let root_probe_opens = path
            .components()
            .filter(|part| matches!(part, std::path::Component::Normal(_)))
            .count() as u64
            + ROOT_AND_DEVICE_OPENS;
        let maximum_opens = root_probe_opens + FALLBACK_PARENT_OPENS + 2 * child_count as u64;
        assert!(source.io.opens() - before <= maximum_opens);
        assert_eq!(
            lock(&source.writer).unwrap().as_ref().unwrap().status().unwrap().directory_count,
            child_count as i64 + 1
        );
        assert!(lock(&source.observations).unwrap().producers.is_empty());
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn replaced_parent_is_deferred_before_its_children_are_indexed() {
        for full_pass in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("root");
            std::fs::create_dir_all(path.join("parent")).unwrap();
            let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
            let source = LocalSource::new(path.clone(), manager.storage_directory());
            let root = source.bind_root(&manager.budget).unwrap();
            let expected = root.parent_identity("parent").unwrap().file_id();
            {
                let mut writer = lock(&source.writer).unwrap();
                let index = writer.as_mut().unwrap();
                index.seed_scan(1).unwrap();
                index
                    .commit_scan_parents_with_ids(
                        1,
                        &[(String::new(), vec![("parent".into(), true)])],
                        &HashMap::from([("parent".into(), expected.clone())]),
                    )
                    .unwrap();
            }
            std::fs::rename(path.join("parent"), path.join("previous")).unwrap();
            std::fs::create_dir_all(path.join("parent/unverified")).unwrap();
            if full_pass {
                lock(&source.observations).unwrap().scan_group = Some(HashMap::new());
            }
            source.scan_parent(&root, 1, "parent", &manager.budget).unwrap();
            if full_pass {
                source
                    .flush_scan_group_locked(&mut lock(&source.observations).unwrap(), &manager.budget)
                    .unwrap();
            }
            let writer = lock(&source.writer).unwrap();
            let index = writer.as_ref().unwrap();
            assert_eq!(index.status().unwrap().directory_count, 1);
            assert_eq!(index.scan_parent_file_id(1, "parent").unwrap(), Some(expected));
            assert!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap().is_empty());
            assert_eq!(index.status().unwrap().coverage, "partial");
            assert_eq!(index.status().unwrap().issue_count, 1);
            assert!(lock(&source.observations).unwrap().pending.is_empty());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rebound_candidate_revalidates_completed_branches() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir_all(path.join("old")).unwrap();
        std::fs::create_dir(path.join("later")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path.clone(), manager.storage_directory());
        let root = source.bind_root(&manager.budget).unwrap();
        let candidate = {
            let mut writer = lock(&source.writer).unwrap();
            let index = writer.as_mut().unwrap();
            index.write_paths(["accepted".to_owned()], None).unwrap();
            index.finish_generation(1, 0).unwrap();
            let (candidate, selected) = index.prepare_scan().unwrap();
            assert!(!selected);
            index.seed_scan(candidate).unwrap();
            candidate
        };
        source.flush(&manager.budget).unwrap();
        let baseline = source.begin_read().unwrap();
        lock(&source.observations).unwrap().scan_epoch = Some((candidate, baseline.token.epoch));
        source.scan_parent(&root, candidate, "", &manager.budget).unwrap();
        source.scan_parent(&root, candidate, "old", &manager.budget).unwrap();
        let interrupted = source.scan_to_acceptance_with(&root, baseline.token, candidate, &manager.budget, |generation, parent| {
            if parent == "later" {
                return Err(IndexError::Interrupted);
            }
            source.scan_parent(&root, generation, parent, &manager.budget)
        });
        assert!(matches!(interrupted, Err(IndexError::Interrupted)));
        assert_eq!(
            lock(&source.writer)
                .unwrap()
                .as_ref()
                .unwrap()
                .pending_scan_paths(candidate, 1)
                .unwrap(),
            ["later"]
        );
        drop(baseline);
        source.invalidate().unwrap();
        std::fs::rename(&path, temporary.path().join("previous-root")).unwrap();
        std::fs::create_dir_all(path.join("later")).unwrap();
        std::fs::create_dir(path.join("new")).unwrap();
        source.scan(&manager.budget).unwrap();
        let writer = lock(&source.writer).unwrap();
        let index = writer.as_ref().unwrap();
        assert_eq!(index.accepted_generation().unwrap(), Some(candidate));
        let result = index
            .search("old new later", 5, false, &Arc::new(AtomicBool::new(false)), false)
            .unwrap();
        let paths: std::collections::BTreeSet<_> = result.results.iter().map(|row| row.path.as_str()).collect();
        assert_eq!(paths, ["later", "new"].into_iter().collect());
        assert_eq!(result.coverage, "complete");
        assert!(result.last_verified_at_ms.is_some());
    }

    #[test]
    fn volume_swaps_and_class_changes_choose_the_retained_boundary_index() {
        use super::super::models::DriveType;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir(&root).unwrap();
        let namespace = temporary.path().join("private");
        let first = VolumeEvidence {
            class: DriveType::Fixed,
            volume: Some("first".into()),
            ..Default::default()
        };
        let source = LocalSource::with_volume(root.clone(), &namespace, first.clone());
        let first_path = source.index_path.clone();
        let identity = json!({"platform": std::env::consts::OS, "root": hex::encode(root.as_os_str().as_encoded_bytes())});
        let mut index = DirectoryIndex::open(&first_path, SourceKind::Local, &identity).unwrap();
        index.bind_volume(&first).unwrap();
        drop(index);
        for class in [DriveType::Removable, DriveType::Unknown, DriveType::Network, DriveType::Virtual] {
            let source = LocalSource::with_volume(root.clone(), &namespace, VolumeEvidence { class, ..first.clone() });
            assert_eq!(source.index_path, first_path);
        }
        let second = VolumeEvidence {
            volume: Some("second".into()),
            ..first.clone()
        };
        let second_source = LocalSource::with_volume(root.clone(), &namespace, second.clone());
        assert_ne!(second_source.index_path, first_path);
        let mut index = DirectoryIndex::open(&second_source.index_path, SourceKind::Local, &identity).unwrap();
        index.bind_volume(&second).unwrap();
        drop(index);
        assert_eq!(LocalSource::with_volume(root, &namespace, first).index_path, first_path);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unmounted_retained_root_does_not_index_or_prune_the_mount_point() {
        use super::super::models::DriveType;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("mount-point");
        std::fs::create_dir(&root).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let mounted = VolumeEvidence {
            class: DriveType::Fixed,
            volume: Some("mounted-volume".into()),
            separate_mount: true,
            ..Default::default()
        };
        let original = LocalSource::with_volume(root.clone(), manager.storage_directory(), mounted.clone());
        let identity = json!({"platform": std::env::consts::OS, "root": hex::encode(root.as_os_str().as_encoded_bytes())});
        let mut index = DirectoryIndex::open(&original.index_path, SourceKind::Local, &identity).unwrap();
        index.bind_volume(&mounted).unwrap();
        index.write_paths(["retained".into()], None).unwrap();
        index.finish_generation(1, 0).unwrap();
        drop(index);
        let current = LocalSource::with_volume(root, manager.storage_directory(), VolumeEvidence::default());
        assert_eq!(current.index_path, original.index_path);
        assert!(current.scan(&manager.budget).is_err());
        assert!(lock(&current.writer).unwrap().is_none());
        let index = DirectoryIndex::open(&current.index_path, SourceKind::Local, &identity).unwrap();
        assert_eq!(
            index
                .search("retained", 5, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .directory_count,
            1
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn removable_pause_releases_idle_handles_and_keeps_catalogue() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir_all(root.join("retained")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root, manager.storage_directory());
        source.scan(&manager.budget).unwrap();
        assert!(source.pause_for_removal().unwrap());
        assert!(lock(&source.root).unwrap().is_none());
        assert!(lock(&source.watcher).unwrap().is_none());
        assert!(source.ensure_available().is_err());
        let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
        assert_eq!(
            reader
                .search("retained", 5, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .directory_count,
            1
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn restart_reuses_boundary_index_without_file_identity_or_session_metadata() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir_all(root.join("retained")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let first = LocalSource::new(root.clone(), manager.storage_directory());
        first.scan(&manager.budget).unwrap();
        let filename = first.index_path.clone();
        first.close_idle(&manager.budget).unwrap();
        std::fs::rename(&root, temporary.path().join("old-root")).unwrap();
        std::fs::create_dir_all(root.join("current")).unwrap();
        let second = LocalSource::new(root, manager.storage_directory());
        assert_eq!(second.index_path, filename);
        assert_ne!(first.session, second.session);
        let mut index = DirectoryIndex::open(
            &filename,
            SourceKind::Local,
            &json!({"platform": std::env::consts::OS, "root": hex::encode(second.root_path.as_os_str().as_encoded_bytes())}),
        )
        .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        assert_eq!(index.search("retained", 5, false, &cancelled, false).unwrap().directory_count, 1);
        index.mark_uncertain().unwrap();
        assert_eq!(index.search("retained", 5, false, &cancelled, false).unwrap().coverage, "uncertain");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn background_tick_resumes_interrupted_initial_scan_before_verification_interval() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir_all(root.join("retained")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root, manager.storage_directory());
        source.bind_root(&manager.budget).unwrap();
        {
            let mut writer = lock(&source.writer).unwrap();
            let index = writer.as_mut().unwrap();
            let (generation, _) = index.prepare_scan().unwrap();
            index.seed_scan(generation).unwrap();
        }
        source.fail(&IndexError::Interrupted, &manager.budget);
        let next_full_pass = Instant::now() + Duration::from_secs(limit("minimum_full_pass_spacing_seconds").unwrap() as u64);
        *lock(&source.next_full_pass).unwrap() = Some(next_full_pass);
        lock(&manager.sources)
            .unwrap()
            .insert(source.source_id.clone(), Arc::clone(&source));

        manager.tick().unwrap();
        let _scan_exit = manager.scans.acquire().await.unwrap();
        let writer = lock(&source.writer).unwrap();
        let index = writer.as_ref().unwrap();
        assert!(index.accepted_generation().unwrap().is_some());
        let result = index
            .search("retained", 5, false, &Arc::new(AtomicBool::new(false)), false)
            .unwrap();
        assert_eq!(result.total_matches, 1);
        assert!(result.last_verified_at_ms.is_some());
        assert_eq!(*lock(&source.next_full_pass).unwrap(), Some(next_full_pass));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn repeated_automatic_requests_do_not_start_full_passes_inside_spacing() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir_all(root.join("retained")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root, manager.storage_directory());
        source.scan(&manager.budget).unwrap();
        *lock(&source.next_full_pass).unwrap() =
            Some(Instant::now() + Duration::from_secs(limit("minimum_full_pass_spacing_seconds").unwrap() as u64));
        let permits = manager.scans.available_permits();
        for _attempt in 0..10 {
            manager.start_scan(&source).unwrap();
        }
        assert!(!source.busy.load(Ordering::Acquire));
        assert_eq!(manager.scans.available_permits(), permits);
    }

    #[cfg(feature = "recovery-verification")]
    #[tokio::test]
    async fn verification_controls_reconcile_gap_and_release_resources() {
        const DEADLINE: Duration = Duration::from_secs(10);
        const POLL_INTERVAL: Duration = Duration::from_millis(20);
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("source");
        std::fs::create_dir_all(root.join("retained-reports")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let search = || async {
            loop {
                match manager.search("verification".into(), root.clone(), "reports".into(), false).await {
                    Err(IndexError::Interrupted | IndexError::QueryBusy) => tokio::time::sleep(POLL_INTERVAL).await,
                    result => break result,
                }
            }
        };
        tokio::time::timeout(DEADLINE, async {
            loop {
                let response = search().await.unwrap();
                if response.monitoring_state.as_deref() == Some("healthy") && response.results.contains(&"retained-reports".into()) {
                    break;
                }
                tokio::time::sleep(POLL_INTERVAL).await;
            }
            manager.verification_watcher_loss("verification", false).unwrap();
            let source = lock(&manager.sources).unwrap().get("verification").unwrap().clone();
            source.flush(&manager.budget).unwrap();
            let retained = search().await.unwrap();
            assert_eq!(retained.monitoring_state.as_deref(), Some("unavailable"));
            assert_eq!(retained.coverage.as_deref(), Some("uncertain"));
            assert!(retained.results.contains(&"retained-reports".into()));
            std::fs::create_dir(root.join("gap-reports")).unwrap();
            manager.verification_watcher_loss("verification", true).unwrap();
            {
                *lock(&source.next_full_pass).unwrap() = Some(Instant::now());
            }
            loop {
                let response = search().await.unwrap();
                if response.monitoring_state.as_deref() == Some("healthy") && response.coverage.as_deref() == Some("complete") {
                    assert!(response.results.contains(&"gap-reports".into()));
                    assert!(response.results.contains(&"retained-reports".into()));
                    break;
                }
                tokio::time::sleep(POLL_INTERVAL).await;
            }
            std::fs::create_dir(root.join("native-reports")).unwrap();
            loop {
                let response = search().await.unwrap();
                if response.monitoring_state.as_deref() == Some("healthy") && response.results.contains(&"native-reports".into()) {
                    assert_eq!(response.coverage.as_deref(), Some("complete"));
                    break;
                }
                tokio::time::sleep(POLL_INTERVAL).await;
            }
            while !manager.verification_stop("verification").unwrap() {
                tokio::time::sleep(POLL_INTERVAL).await;
            }
            assert!(lock(&manager.sources).unwrap().is_empty());
            assert_eq!(manager.scans.available_permits(), limit("scan_workers").unwrap());
            assert_eq!(manager.updates.available_permits(), limit("query_workers").unwrap());
        })
        .await
        .expect("bounded verification lifecycle");
    }

    #[tokio::test]
    async fn released_root_returns_query_busy_until_rebound_without_losing_rows() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir_all(root.join("retained-reports")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root.clone(), manager.storage_directory());
        lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
        source.scan(&manager.budget).unwrap();
        let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = reader.search("reports", 3, false, &cancelled, false).unwrap();
        lock(&source.root).unwrap().take();
        source.busy.store(true, Ordering::Release);
        lock(&manager.sources).unwrap().insert("fixture".into(), Arc::clone(&source));
        assert!(matches!(
            manager.search("fixture".into(), root.clone(), "reports".into(), false).await,
            Err(IndexError::QueryBusy)
        ));
        assert_eq!(reader.search("reports", 3, false, &cancelled, false).unwrap(), before);
        source.bind_root(&manager.budget).unwrap();
        source.busy.store(false, Ordering::Release);
        let recovered = manager.search("fixture".into(), root, "reports".into(), false).await.unwrap();
        assert_eq!(recovered.results, ["retained-reports"]);
        assert_eq!(recovered.last_verified_at_ms, before.last_verified_at_ms);
    }

    #[test]
    fn watcher_loss_is_coalesced_until_recovery_with_opaque_context() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("private-root");
        let source = LocalSource::new(root.clone(), temporary.path());
        let replacement = LocalSource::new(root, temporary.path());
        assert_eq!(source.source_id, replacement.source_id);
        assert_ne!(source.session, replacement.session);
        assert!(source.source_id.chars().all(|value| value.is_ascii_hexdigit()));
        assert!(source.lose_watcher().unwrap());
        for _attempt in 0..10 {
            assert!(!source.lose_watcher().unwrap());
        }
        assert!(lock(&source.observations).unwrap().verification_required);
        source.watcher_failed.store(false, Ordering::Release);
        assert!(source.lose_watcher().unwrap());
    }

    #[test]
    fn watcher_startup_failure_retries_without_reinitializing_writer() {
        let temporary = tempfile::tempdir().unwrap();
        let root_path = temporary.path().join("root");
        let namespace = temporary.path().join("private");
        let source = LocalSource::new(root_path.clone(), &namespace);
        let budget = Arc::new(DiskBudget {
            namespace,
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: available_disk_bytes,
        });
        source.recover_watcher().unwrap();
        assert!(source.watcher_failed.load(Ordering::Acquire));
        let fallback = source.begin_read().unwrap();
        for _attempt in 0..10 {
            lock(&source.status).unwrap().watcher_retry_at = Instant::now();
            source.recover_watcher().unwrap();
            assert!(source.watcher_failed.load(Ordering::Acquire));
            assert!(lock(&source.observations).unwrap().is_current(fallback.token, ""));
        }
        drop(fallback);
        let retry = lock(&source.status).unwrap().watcher_retry_at;
        assert!(retry > Instant::now());
        std::fs::create_dir_all(root_path.join("reports")).unwrap();
        source.scan(&budget).unwrap();
        assert!(lock(&source.writer).unwrap().is_some());
        assert!(lock(&source.watcher).unwrap().is_none());
        assert!(lock(&source.status)
            .unwrap()
            .message
            .as_ref()
            .unwrap()
            .contains("monitoring is unavailable"));
        assert_eq!(lock(&source.status).unwrap().watcher_retry_at, retry);
        let fallback = source.begin_read().unwrap();
        lock(&source.status).unwrap().watcher_retry_at = Instant::now();
        source.recover_watcher().unwrap();
        assert!(lock(&source.watcher).unwrap().is_some());
        assert!(lock(&source.observations).unwrap().verification_required);
        assert!(!lock(&source.observations).unwrap().is_current(fallback.token, ""));
        drop(fallback);
        source.scan(&budget).unwrap();
        assert!(lock(&source.status).unwrap().message.is_none());
        source.observe(Err(notify::Error::generic("injected native failure"))).unwrap();
        assert!(source.watcher_failed.load(Ordering::Acquire));
        assert!(lock(&source.observations).unwrap().verification_required);
        source.recover_watcher().unwrap();
        source.scan(&budget).unwrap();
        assert!(!source.watcher_failed.load(Ordering::Acquire));
        source.stopped.store(true, Ordering::Release);
        lock(&source.watcher).unwrap().take();
        source.recover_watcher().unwrap();
        assert!(lock(&source.watcher).unwrap().is_none());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "Explicit small-tree native watcher timing measurement; not part of routine tests."]
    async fn small_many_file_tree_reports_first_result_and_native_watcher_freshness() {
        const FRESHNESS_TARGET: Duration = Duration::from_secs(2);
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir(&root).unwrap();
        let regular_files = limit("row_batch_size").unwrap() * 2 + 1;
        for number in 0..regular_files {
            std::fs::write(root.join(format!("file-{number:04}")), b"file").unwrap();
        }
        std::fs::create_dir(root.join("Reports")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let poll_period = Duration::from_millis(limit("event_coalescing_ms").unwrap() as u64);
        let timeout = Duration::from_secs(limit("query_timeout_seconds").unwrap() as u64);
        let mut polling = tokio::time::interval(poll_period);
        let started = Instant::now();
        let mut first_result = None;
        let before = tokio::time::timeout(timeout, async {
            loop {
                polling.tick().await;
                let response = manager
                    .search("measurement".into(), root.clone(), "reports".into(), false)
                    .await
                    .unwrap();
                if !response.results.is_empty() {
                    first_result.get_or_insert_with(|| started.elapsed());
                }
                if response.cache_state == "ready" && response.directory_count == 1 {
                    break response;
                }
            }
        })
        .await
        .expect("The native many-file build must finish before the query timeout.");
        let ready = started.elapsed();
        let source = lock(&manager.sources).unwrap().get("measurement").unwrap().clone();
        assert!(lock(&source.watcher).unwrap().is_some());
        let mutated = Instant::now();
        std::fs::create_dir_all(root.join("Reports New/Child")).unwrap();
        let after = tokio::time::timeout(timeout, async {
            loop {
                polling.tick().await;
                let response = manager
                    .search("measurement".into(), root.clone(), "reports".into(), false)
                    .await
                    .unwrap();
                if response.directory_count == 3 && response.results.iter().any(|path| path == "Reports New/Child") {
                    break response;
                }
            }
        })
        .await;
        let freshness = mutated.elapsed();
        lock(&manager.sources).unwrap().remove("measurement");
        source.stopped.store(true, Ordering::Release);
        let _scan_exit = manager.scans.acquire().await.unwrap();
        let _update_exit = manager.updates.acquire_many(limit("query_workers").unwrap() as u32).await.unwrap();
        let _query_exit = manager.queries.acquire_many(limit("query_workers").unwrap() as u32).await.unwrap();
        source.close_idle(&manager.budget).unwrap();
        let after = after.expect("The real watcher and background scheduler must publish the new subtree before the query timeout.");
        assert_eq!(after.total_matches, 3);
        assert_eq!(after.last_verified_at_ms, before.last_verified_at_ms);
        println!(
            "{}",
            serde_json::json!({
                "measurement": "small_native_many_file_tree",
                "os": std::env::consts::OS,
                "regular_files": regular_files,
                "initial_directories": before.directory_count,
                "final_directories": after.directory_count,
                "poll_resolution_ms": poll_period.as_millis(),
                "first_result_ms": first_result.unwrap().as_millis(),
                "ready_ms": ready.as_millis(),
                "mutation_freshness_ms": freshness.as_millis(),
                "freshness_target_ms": FRESHNESS_TARGET.as_millis(),
                "freshness_target_met": freshness <= FRESHNESS_TARGET,
                "native_watcher": true,
                "application_mutation_hint": false
            })
        );
    }

    #[tokio::test]
    async fn cooperative_mutation_interruption_preserves_retry_deadline_and_failure_state() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(temporary.path().join("root"), manager.storage_directory());
        for resource_failure in [false, true] {
            if resource_failure {
                source.fail(&IndexError::StoragePaused("Injected storage refusal."), &manager.budget);
            }
            let (deadline, delay, message, verified) = {
                let status = lock(&source.status).unwrap();
                (status.retry_at, status.failure_delay, status.message.clone(), status.verified)
            };
            for _ in 0..3 {
                source.fail(&IndexError::Interrupted, &manager.budget);
                let status = lock(&source.status).unwrap();
                assert_eq!(status.state, "ready");
                assert_eq!(status.retry_at, deadline);
                assert_eq!(status.failure_delay, delay);
                assert_eq!(status.message, message);
                assert_eq!(status.verified, verified);
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn idle_query_preserves_reads_without_bypassing_retry_or_root_revalidation() {
        for replaced in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().join("root");
            std::fs::create_dir_all(root.join("retained")).unwrap();
            let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
            let source = LocalSource::new(root.clone(), manager.storage_directory());
            source.scan(&manager.budget).unwrap();
            lock(&source.watcher).unwrap().take();
            let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            let before = reader.search("retained", 3, false, &cancelled, false).unwrap();
            let old_read = source.begin_read().unwrap();
            source.fail(&IndexError::StoragePaused("Injected storage refusal."), &manager.budget);
            let (retry_at, verified) = {
                let mut status = lock(&source.status).unwrap();
                status.accessed = Instant::now() - Duration::from_secs(limit("idle_release_seconds").unwrap() as u64);
                (status.retry_at, status.verified)
            };
            lock(&manager.sources).unwrap().insert("drive".into(), Arc::clone(&source));
            if replaced {
                std::fs::rename(&root, temporary.path().join("old-root")).unwrap();
                std::fs::create_dir(&root).unwrap();
            }
            let response = manager.search("drive".into(), root, "retained".into(), false).await;
            if replaced {
                assert!(response.is_err());
                assert!(!source.stopped.load(Ordering::Acquire));
                assert!(Arc::ptr_eq(lock(&manager.sources).unwrap().get("drive").unwrap(), &source));
            } else {
                let response = response.unwrap();
                assert_eq!(response.results, ["retained"]);
                assert_eq!(response.last_verified_at_ms, before.last_verified_at_ms);
            }
            {
                let observations = lock(&source.observations).unwrap();
                assert_eq!(observations.is_current(old_read.token, ""), !replaced);
                assert!(observations.producers.contains_key(&old_read.token.producer));
            }
            assert_eq!(lock(&source.status).unwrap().retry_at, retry_at);
            assert_eq!(lock(&source.status).unwrap().verified, verified);
            assert_eq!(reader.search("retained", 3, false, &cancelled, false).unwrap(), before);
            drop(old_read);
            assert!(lock(&source.observations).unwrap().producers.is_empty());
            lock(&manager.sources).unwrap().remove("drive");
            source.stopped.store(true, Ordering::Release);
            source.close_idle(&manager.budget).unwrap();
        }
    }

    #[tokio::test]
    async fn application_mutation_rejects_unbound_hints_without_replacing_operation_errors() {
        for binding in ["drive", "root", "stopped", "outside", "unavailable"] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().join("root");
            let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
            let source = LocalSource::new(root.clone(), manager.storage_directory());
            lock(&source.status).unwrap().retry_at = Instant::now() + FAILURE_RETRY_MAX;
            source.stopped.store(binding == "stopped", Ordering::Release);
            lock(&manager.sources).unwrap().insert("drive".into(), Arc::clone(&source));
            let drive = if binding == "drive" { "other-drive" } else { "drive" };
            let operation_root = if binding == "root" {
                temporary.path().join("other-root")
            } else {
                root.clone()
            };
            let target = if binding == "outside" {
                temporary.path().join("outside")
            } else {
                root.join("target")
            };
            let mut executed = false;
            let result = manager.run_observed_operation(drive, &operation_root, &target, || {
                executed = true;
                Err::<(), _>(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "Original operation failure.",
                ))
            });
            assert!(executed);
            assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
            let observations = lock(&source.observations).unwrap();
            assert!(observations.pending.is_empty());
            assert!(observations.producers.is_empty());
            assert_eq!(observations.verification_required, matches!(binding, "outside" | "unavailable"));
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn application_mutation_reconciles_after_success_or_failure_without_watcher_events() {
        for (failed, operation) in [
            (false, "delete"),
            (true, "delete"),
            (false, "create"),
            (true, "create"),
            (false, "create-parents"),
            (true, "create-parents"),
            (false, "archive-parents"),
            (true, "archive-parents"),
            (false, "rename"),
            (true, "rename"),
            (false, "recursive-delete"),
            (true, "recursive-delete"),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().join("root");
            let target = root.join("parent/target");
            let create_parents = matches!(operation, "create-parents" | "archive-parents");
            let create = operation == "create" || create_parents;
            std::fs::create_dir_all(if create { target.parent().unwrap() } else { &target }).unwrap();
            if operation == "rename" {
                std::fs::create_dir(target.join("child")).unwrap();
            }
            if operation == "recursive-delete" {
                std::fs::create_dir_all(target.join("survivor/removed")).unwrap();
            }
            std::fs::create_dir(root.join("outside")).unwrap();
            let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
            let source = LocalSource::new(root.clone(), manager.storage_directory());
            source.scan(&manager.budget).unwrap();
            lock(&source.watcher).unwrap().take();
            lock(&source.status).unwrap().retry_at = Instant::now() + FAILURE_RETRY_MAX;
            lock(&manager.sources).unwrap().insert("drive".into(), Arc::clone(&source));
            let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            let before = reader.search("parent target outside", 3, false, &cancelled, false).unwrap();
            let mutation = || {
                let observations = lock(&source.observations).unwrap();
                assert_eq!(observations.producers.len(), 1);
                let expected_hints = match operation {
                    "recursive-delete" => 3,
                    _ if create_parents => 4,
                    _ => 1,
                };
                assert_eq!(observations.pending.len(), expected_hints);
                let expected_parent = if create_parents { "parent/target/nested" } else { "parent" };
                assert!(matches!(&observations.pending[0].1, DirectoryMutation::ReadParent { path } if path == expected_parent));
                drop(observations);
                if create_parents {
                    source.flush(&manager.budget).unwrap();
                    lock(&source.status).unwrap().retry_at = Instant::now();
                    let retry = lock(&source.status).unwrap().retry_at;
                    source.reconcile(&manager.budget, &manager.scans).unwrap();
                    assert_eq!(lock(&source.status).unwrap().retry_at, retry);
                    assert_eq!(lock(&source.status).unwrap().failure_delay, Duration::ZERO);
                    assert_eq!(
                        reader.search("parent target outside", 3, false, &cancelled, false).unwrap().results,
                        before.results
                    );
                    lock(&source.status).unwrap().retry_at = Instant::now() + FAILURE_RETRY_MAX;
                }
                match operation {
                    "create" => std::fs::create_dir(&target),
                    "create-parents" | "archive-parents" => std::fs::create_dir_all(target.join("nested")),
                    "rename" => std::fs::rename(&target, root.join("parent/renamed")),
                    "recursive-delete" if failed => std::fs::remove_dir(target.join("survivor/removed")),
                    "recursive-delete" => std::fs::remove_dir_all(&target),
                    _ => std::fs::remove_dir(&target),
                }?;
                if failed {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "Injected failure after mutation.",
                    ))
                } else {
                    Ok(())
                }
            };
            let result = if operation == "recursive-delete" {
                manager.run_observed_subtree_operation("drive", &root, &target, mutation)
            } else if operation == "create-parents" {
                manager.run_observed_parent_creation("drive", &root, &target.join("nested/file"), mutation)
            } else if operation == "archive-parents" {
                manager.run_observed_root_creation(&root, &target.join("nested/file"), mutation)
            } else {
                manager.run_observed_operation("drive", &root, &target, mutation)
            };
            assert_eq!(
                result.as_ref().err().map(std::io::Error::kind),
                failed.then_some(std::io::ErrorKind::PermissionDenied)
            );
            assert_eq!(
                reader.search("parent target outside", 3, false, &cancelled, false).unwrap().results,
                before.results
            );
            {
                let observations = lock(&source.observations).unwrap();
                assert!(observations.producers.is_empty());
                let expected_hints = match operation {
                    "recursive-delete" => 6,
                    _ if create_parents => 4,
                    _ => 2,
                };
                assert_eq!(observations.pending.len(), expected_hints);
            }
            lock(&manager.sources).unwrap().remove("drive");
            lock(&source.status).unwrap().retry_at = Instant::now();
            source.flush(&manager.budget).unwrap();
            source.reconcile(&manager.budget, &manager.scans).unwrap();
            let after = reader.search("parent target outside", 3, false, &cancelled, false).unwrap();
            let expected_count = match operation {
                "create" => 3,
                _ if create_parents => 4,
                "rename" => 4,
                "recursive-delete" if failed => 4,
                _ => 2,
            };
            assert_eq!(after.directory_count, expected_count);
            assert_eq!(
                after.results.iter().any(|row| row.path == "parent/target"),
                create || (operation == "recursive-delete" && failed)
            );
            if operation == "rename" {
                assert_eq!(reader.search("renamed", 3, false, &cancelled, false).unwrap().total_matches, 2);
                assert_eq!(reader.search("target", 3, false, &cancelled, false).unwrap().total_matches, 0);
            }
            assert_eq!(after.last_verified_at_ms, before.last_verified_at_ms);
            assert!(lock(&source.observations).unwrap().verification_required);
            assert!(lock(&source.observations).unwrap().pending.is_empty());
            assert_eq!(lock(&manager.budget.state).unwrap().reserved, 0);
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn parent_loss_after_identity_read_retains_rows_and_does_not_hide_storage_or_root_failure() {
        for scenario in ["renamed-parent", "replaced-by-file", "missing-storage", "replaced-root"] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("root");
            std::fs::create_dir_all(path.join("target/child")).unwrap();
            let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
            let source = LocalSource::new(path.clone(), manager.storage_directory());
            source.scan(&manager.budget).unwrap();
            lock(&source.watcher).unwrap().take();
            let root = lock(&source.root).unwrap().as_ref().unwrap().clone();
            let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            let before = reader.search("target", 3, false, &cancelled, false).unwrap();
            let retry_at = lock(&source.status).unwrap().retry_at;
            let failure_delay = lock(&source.status).unwrap().failure_delay;
            let result = source.with_parent_read(&root, "target", |_read| {
                root.parent_identity("target")?;
                match scenario {
                    "renamed-parent" | "replaced-by-file" => {
                        std::fs::rename(path.join("target"), path.join("moved"))?;
                        if scenario == "replaced-by-file" {
                            std::fs::write(path.join("target"), b"not a directory")?;
                        }
                    }
                    "replaced-root" => std::fs::rename(&path, temporary.path().join("old-root"))?,
                    _ => return Err(IndexError::Io(std::io::Error::from(std::io::ErrorKind::NotFound))),
                }
                root.children("target", |_entry| Ok(()))
            });
            let error = result.unwrap_err();
            assert_eq!(reader.search("target", 3, false, &cancelled, false).unwrap(), before);
            let observations = lock(&source.observations).unwrap();
            assert!(observations.producers.is_empty());
            if matches!(scenario, "renamed-parent" | "replaced-by-file") {
                assert!(matches!(error, IndexError::Interrupted));
                assert!(observations.verification_required);
                assert_eq!(observations.pending.len(), 1);
                assert!(matches!(&observations.pending.front().unwrap().1, DirectoryMutation::ReadParent { path } if path.is_empty()));
                drop(observations);
                source.fail(&error, &manager.budget);
                let status = lock(&source.status).unwrap();
                assert_eq!(status.retry_at, retry_at);
                assert_eq!(status.failure_delay, failure_delay);
            } else {
                assert!(!matches!(error, IndexError::Interrupted));
                assert!(observations.pending.is_empty());
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn application_subtree_queue_overflow_preserves_rows_and_actual_worker_ownership() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir_all(root.join("target/child")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root.clone(), manager.storage_directory());
        source.scan(&manager.budget).unwrap();
        lock(&source.watcher).unwrap().take();
        lock(&source.status).unwrap().retry_at = Instant::now() + FAILURE_RETRY_MAX;
        lock(&manager.sources).unwrap().insert("drive".into(), Arc::clone(&source));
        let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = reader.search("target", 3, false, &cancelled, false).unwrap();
        let maximum = limit("max_pending_observations").unwrap();
        {
            let mut observations = lock(&source.observations).unwrap();
            for _ in 0..maximum - 1 {
                assert!(observations
                    .enqueue(
                        DirectoryMutation::ReadParent { path: "target".into() },
                        maximum,
                        limit("max_observation_bytes").unwrap()
                    )
                    .unwrap());
            }
        }
        let old_read = source.begin_read().unwrap();
        let epoch = lock(&source.observations).unwrap().epoch;
        let result = manager.run_observed_subtree_operation("drive", &root, &root.join("target"), || {
            let observations = lock(&source.observations).unwrap();
            assert!(observations.epoch > epoch);
            assert_eq!(observations.pending.len(), maximum);
            assert_eq!(observations.producers.len(), 2);
            assert!(!observations.is_current(old_read.token, "target"));
            assert!(observations.verification_required);
            Err::<(), _>(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "Original deletion failure.",
            ))
        });
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::PermissionDenied);
        assert_eq!(reader.search("target", 3, false, &cancelled, false).unwrap(), before);
        let observations = lock(&source.observations).unwrap();
        assert_eq!(observations.producers.len(), 1);
        assert_eq!(observations.pending.len(), maximum);
        assert!(observations.epoch > epoch);
        assert!(observations.verification_required);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn application_mutation_ownership_survives_cancelled_async_waiter() {
        for (scope, root_bound) in [
            (MutationScope::Parent, false),
            (MutationScope::Subtree, false),
            (MutationScope::Ancestors, false),
            (MutationScope::Ancestors, true),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().join("root");
            std::fs::create_dir_all(root.join("target")).unwrap();
            let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
            let source = LocalSource::new(root.clone(), manager.storage_directory());
            lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
            source.scan(&manager.budget).unwrap();
            assert!(lock(&source.watcher).unwrap().is_none());
            lock(&source.status).unwrap().retry_at = Instant::now() + FAILURE_RETRY_MAX;
            lock(&manager.sources).unwrap().insert("drive".into(), Arc::clone(&source));
            let task_manager = Arc::clone(&manager);
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, blocked) = std::sync::mpsc::channel::<()>();
            let (finished, complete) = tokio::sync::oneshot::channel();
            let request = tokio::spawn(async move {
                tokio::task::spawn_blocking(move || {
                    let operation = || {
                        started.send(()).unwrap();
                        blocked.recv().unwrap();
                        std::fs::remove_dir(root.join("target"))
                    };
                    let result = if root_bound {
                        task_manager.run_observed_root_creation(&root, &root.join("target"), operation)
                    } else {
                        task_manager.run_observed_mutation("drive", &root, &root.join("target"), scope, operation)
                    };
                    finished.send(result).unwrap();
                })
                .await
            });
            ready.await.unwrap();
            request.abort();
            assert!(request.await.unwrap_err().is_cancelled());
            {
                let observations = lock(&source.observations).unwrap();
                assert_eq!(observations.producers.len(), 1);
                assert_eq!(observations.pending.len(), 1);
                assert!(!observations.barriers.is_empty());
            }
            release.send(()).unwrap();
            complete.await.unwrap().unwrap();
            let observations = lock(&source.observations).unwrap();
            assert!(observations.producers.is_empty());
            assert_eq!(observations.pending.len(), 2);
            assert!(observations.verification_required);
        }
    }

    #[tokio::test]
    async fn repeated_scan_requests_respect_resource_retry_deadline() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        for initialized in [false, true] {
            let source = LocalSource::new(temporary.path().join(format!("root-{initialized}")), manager.storage_directory());
            std::fs::create_dir(&source.root_path).unwrap();
            let mut reader = None;
            if initialized {
                let mut index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
                index.write_paths(["accepted".to_owned()], None).unwrap();
                index.finish_generation(1, 0).unwrap();
                reader = Some(index.reader());
                *lock(&source.reader).unwrap() = reader.clone();
                *lock(&source.writer).unwrap() = Some(index);
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            let before = reader
                .as_ref()
                .map(|reader| reader.search("accepted", 3, false, &cancelled, false).unwrap());
            source.fail(&IndexError::StoragePaused("Injected resource refusal."), &manager.budget);
            if !initialized {
                lock(&manager.sources).unwrap().insert("fixture".into(), Arc::clone(&source));
                let response = manager
                    .search("fixture".into(), source.root_path.clone(), "accepted".into(), false)
                    .await
                    .unwrap();
                let expected = cfg!(any(target_os = "linux", target_os = "windows")).then_some(SEARCH_CONTRACT_VERSION);
                assert_eq!(response.search_contract_version, expected);
                assert_eq!(serde_json::to_value(&response).unwrap()["search_contract_version"], json!(expected));
            }
            let (deadline, delay, message, progress) = {
                let status = lock(&source.status).unwrap();
                (status.retry_at, status.failure_delay, status.message.clone(), status.progress)
            };
            let permits = manager.scans.available_permits();
            for _ in 0..3 {
                manager.start_scan(&source).unwrap();
                manager.start_scan_if_cold(&source).unwrap();
                assert!(!source.busy.load(Ordering::Acquire));
                assert_eq!(manager.scans.available_permits(), permits);
                let status = lock(&source.status).unwrap();
                assert_eq!(status.retry_at, deadline);
                assert_eq!(status.failure_delay, delay);
                assert_eq!(status.message, message);
                assert_eq!(status.progress, progress);
                assert_eq!(status.state, "ready");
            }
            assert!(lock(&source.observations).unwrap().producers.is_empty());
            assert_eq!(
                reader
                    .as_ref()
                    .map(|reader| reader.search("accepted", 3, false, &cancelled, false).unwrap()),
                before
            );
        }
    }

    #[tokio::test]
    async fn failed_policy_persistence_preserves_effective_resource_policy() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        let previous = manager.budget.policy().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), manager.storage_directory());
        let mut index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index.write_paths(["accepted".to_owned()], None).unwrap();
        *source.reader.lock().unwrap() = Some(index.reader());
        *source.writer.lock().unwrap() = Some(index);
        manager.sources.lock().unwrap().insert("drive".to_owned(), Arc::clone(&source));
        let mut proposed = previous.clone();
        proposed.page_cache_kib = 64;
        assert!(manager
            .apply_policy_with_persistence(proposed, || Err(IndexError::Invalid("Injected storage failure.")))
            .is_err());
        assert_eq!(manager.budget.policy().unwrap(), previous);
        assert_eq!(
            source.writer.lock().unwrap().as_ref().unwrap().page_cache_target_kib(),
            previous.page_cache_kib
        );
        let response = source
            .reader
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .search("accepted", 3, false, &Arc::new(AtomicBool::new(false)), false)
            .unwrap();
        assert_eq!(response.total_matches, 1);
    }

    #[test]
    fn idle_close_records_query_access_before_releasing_storage() {
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        let source = LocalSource::new(temporary.path().join("root"), &namespace);
        let index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "test"})).unwrap();
        *source.writer.lock().unwrap() = Some(index);
        let accessed = epoch_milliseconds().unwrap();
        source.status.lock().unwrap().accessed_at_ms = Some(accessed);
        let budget = Arc::new(DiskBudget {
            namespace,
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: available_disk_bytes,
        });
        source.close_idle(&budget).unwrap();
        assert_eq!(DiskBudget::inactive_access(&source.index_path).unwrap(), Some(accessed));
        assert!(source.writer.lock().unwrap().is_none());
    }

    #[test]
    fn inactive_retention_count_and_leases_preserve_active_sources() {
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        let mut paths = Vec::new();
        let mut active = None;
        for (position, character) in ['a', 'b', 'c'].into_iter().enumerate() {
            let path = namespace.join(format!("{}.sqlite3", character.to_string().repeat(64)));
            let index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"id": character})).unwrap();
            let connection = Connection::open(&path).unwrap();
            connection
                .execute(
                    "UPDATE source_metadata SET last_access_at_ms = ? WHERE id = 1",
                    [i64::try_from(position + 1).unwrap() * 1000],
                )
                .unwrap();
            drop(connection);
            paths.push(path);
            if character == 'c' {
                active = Some(index);
            }
        }
        let mut policy = DirectoryPolicy::defaults().unwrap();
        policy.max_retained_inactive_sources = 1;
        let budget = DiskBudget {
            namespace,
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: policy.clone(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: available_disk_bytes,
        };
        assert_eq!(budget.cleanup_inactive(&policy, 0, false, 4000).unwrap(), 1);
        assert!(!paths[0].exists());
        assert!(paths[1].exists());
        assert!(paths[2].exists());
        assert_eq!(budget.cleanup_inactive(&policy, 0, false, 1_000_000_000).unwrap(), 1);
        assert!(paths[2].exists());
        drop(active);
    }

    #[test]
    fn pressure_cleanup_accounts_quarantine_and_preserves_owned_catalogue() {
        use super::super::directory_index::QUARANTINE_FILE_NAME;

        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let path = manager.budget.namespace.join(format!("{}.sqlite3", "a".repeat(64)));
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index.write_paths(["accepted".to_owned()], None).unwrap();
        index.finish_generation(1, 0).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("accepted", 3, false, &cancelled, false).unwrap();
        for suffix in ["", "-journal"] {
            let rejected = manager.budget.namespace.join(format!("{QUARANTINE_FILE_NAME}{suffix}"));
            let bytes = manager.budget.managed_bytes().unwrap();
            std::fs::write(&rejected, b"rejected").unwrap();
            assert_eq!(manager.budget.managed_bytes().unwrap(), bytes + 8);
            let policy = manager.budget.policy().unwrap();
            manager
                .budget
                .cleanup_inactive(&policy, 0, false, epoch_milliseconds().unwrap())
                .unwrap();
            assert!(rejected.exists());
            let lease = acquire_storage(&manager.budget.namespace.join(QUARANTINE_FILE_NAME)).unwrap();
            manager
                .budget
                .cleanup_inactive(&policy, 0, true, epoch_milliseconds().unwrap())
                .unwrap();
            assert!(rejected.exists());
            drop(lease);
            manager
                .budget
                .cleanup_inactive(&policy, 0, true, epoch_milliseconds().unwrap())
                .unwrap();
            assert!(!rejected.exists());
            assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), before);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn background_scan_recovers_corruption_then_builds_current_directories() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("fresh")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root, &manager.budget.namespace);
        let lease = acquire_storage(&source.index_path).unwrap();
        std::fs::write(&source.index_path, b"corrupt disposable catalogue").unwrap();
        drop(lease);
        source.scan(&manager.budget).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let writer = lock(&source.writer).unwrap();
        let response = writer.as_ref().unwrap().search("fresh", 3, false, &cancelled, false).unwrap();
        assert_eq!(response.total_matches, 1);
        assert_eq!(response.coverage, "complete");
        assert!(source.recovery_attempted.load(Ordering::Acquire));
        assert_eq!(lock(&manager.budget.state).unwrap().reserved, 0);
    }

    #[test]
    fn orphan_lease_cleanup_is_bounded_and_preserves_owners_and_sidecars() {
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        drop(super::super::directory_index::acquire_namespace_lease(&namespace).unwrap());
        let maximum = limit("lease_cleanup_batch").unwrap();
        for number in 0..maximum + 2 {
            std::fs::write(namespace.join(format!("{number:064x}.sqlite3.lease")), []).unwrap();
        }
        let held = namespace.join(format!("{}.sqlite3", "b".repeat(64)));
        let lease = acquire_storage(&held).unwrap();
        let sidecar_stem = "c".repeat(64);
        std::fs::write(namespace.join(format!("{sidecar_stem}.sqlite3.lease")), []).unwrap();
        std::fs::write(namespace.join(format!("{sidecar_stem}.sqlite3-wal")), b"held").unwrap();
        let budget = DiskBudget {
            namespace: namespace.clone(),
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: available_disk_bytes,
        };
        let namespace_lease = super::super::directory_index::acquire_namespace_lease(&namespace).unwrap();
        assert_eq!(budget.cleanup_orphan_leases().unwrap(), 0);
        drop(namespace_lease);
        assert_eq!(budget.cleanup_orphan_leases().unwrap(), maximum);
        assert_eq!(budget.cleanup_orphan_leases().unwrap(), 2);
        assert!(namespace.join(format!("{sidecar_stem}.sqlite3.lease")).exists());
        drop(lease);
        assert_eq!(budget.cleanup_orphan_leases().unwrap(), 1);
        assert!(namespace.join(format!("{sidecar_stem}.sqlite3.lease")).exists());
    }

    #[test]
    fn quiet_source_does_not_request_checkpoint_admission() {
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        let source = LocalSource::new(temporary.path().join("root"), &namespace);
        let index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        *source.writer.lock().unwrap() = Some(index);
        source.observations.lock().unwrap().uncertain = false;
        let budget = Arc::new(DiskBudget {
            namespace,
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: |_| panic!("A small WAL must not request maintenance admission."),
        });
        source.flush(&budget).unwrap();
    }

    #[test]
    fn stopped_source_cannot_publish_query_results() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), temporary.path());
        assert!(source.ensure_available().is_ok());
        source.stopped.store(true, Ordering::Release);
        assert!(source.ensure_available().is_err());
    }

    #[test]
    fn disk_admission_samples_space_once_without_cleanup() {
        thread_local! {
            static PROBE_STATE: std::cell::Cell<(usize, bool)> = const { std::cell::Cell::new((0, false)) };
        }
        for (cleanup, space_lost) in [(false, false), (true, false), (true, true)] {
            let temporary = tempfile::tempdir().unwrap();
            let policy = DirectoryPolicy::defaults().unwrap();
            let next_cleanup_at = if cleanup {
                Instant::now()
            } else {
                Instant::now() + Duration::from_secs(u64::try_from(policy.degraded_verification_seconds).unwrap())
            };
            PROBE_STATE.with(|state| state.set((0, space_lost)));
            let budget = Arc::new(DiskBudget {
                namespace: temporary.path().to_path_buf(),
                policy_gate: Mutex::new(()),
                state: Mutex::new(DiskState {
                    policy,
                    reserved: 0,
                    next_cleanup_at,
                }),
                space_probe: |_| {
                    Ok(PROBE_STATE.with(|state| {
                        let (count, space_lost) = state.get();
                        state.set((count + 1, space_lost));
                        if space_lost && count > 0 {
                            0
                        } else {
                            u64::MAX
                        }
                    }))
                },
            });
            let reservation = budget.reserve();
            if space_lost {
                assert!(matches!(reservation, Err(IndexError::StoragePaused(_))));
            } else {
                assert!(reservation.is_ok());
            }
            drop(reservation);
            assert_eq!(lock(&budget.state).unwrap().reserved, 0);
            assert_eq!(PROBE_STATE.with(|state| state.get().0), if cleanup { 2 } else { 1 });
        }
    }

    #[test]
    fn physical_disk_admission_retains_outstanding_reservations() {
        let temporary = tempfile::tempdir().unwrap();
        let budget = Arc::new(DiskBudget {
            namespace: temporary.path().to_path_buf(),
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: |_| u64::try_from(limit("write_headroom_bytes")?).map_err(|_| IndexError::Invalid("Invalid test headroom.")),
        });
        let held = budget.reserve().unwrap();
        assert!(budget.reserve().is_err());
        assert!(lock(&budget.state).unwrap().reserved > 0);
        drop(held);
        assert_eq!(lock(&budget.state).unwrap().reserved, 0);
        assert!(budget.reserve().is_ok());
        assert!(available_disk_bytes(temporary.path()).is_ok());
    }

    #[test]
    fn shared_policy_defaults_and_strict_validation() {
        let policy = DirectoryPolicy::defaults().unwrap();
        assert_eq!(policy.page_cache_kib, super::super::directory_index::PAGE_CACHE_KIB);
        assert_eq!(limit("row_batch_size").unwrap(), ROW_BATCH_SIZE);
        assert_eq!(
            limit("max_observation_bytes").unwrap(),
            super::super::directory_index::SCAN_BATCH_BYTES
        );
        assert_eq!(
            limit("maintenance_page_batch").unwrap(),
            super::super::directory_index::MAINTENANCE_PAGE_BATCH as usize
        );
        assert_eq!(
            limit("checkpoint_wal_bytes").unwrap(),
            super::super::directory_index::CHECKPOINT_WAL_BYTES as usize
        );
        assert_eq!(limit("query_workers").unwrap(), 2);
        let mut invalid = policy.clone();
        invalid.disk_budget_bytes = 0;
        assert!(invalid.validate().is_err());
        invalid = policy.clone();
        invalid.degraded_verification_seconds = 3600;
        assert!(invalid.validate().is_err());
        let mut serialized = serde_json::to_value(&policy).unwrap();
        serialized["page_cache_kib"] = json!(true);
        assert!(serde_json::from_value::<DirectoryPolicy>(serialized).is_err());
    }

    #[test]
    fn failed_verification_uses_bounded_backoff_instead_of_the_full_pass_interval() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), temporary.path());
        let mut status = lock(&source.status).unwrap();
        let mut now = status.verified;
        let interval = Duration::from_secs(900);
        for seconds in [30, 60, 120, 240, 300, 300] {
            status.schedule_retry(now, FAILURE_RETRY_JITTER_PERCENT);
            let delay = Duration::from_secs(seconds);
            assert_eq!(status.retry_at.saturating_duration_since(now), delay);
            assert!(!status.verification_due(now + delay - Duration::from_millis(1), interval, true));
            assert!(status.verification_due(now + delay, interval, true));
            now += delay;
        }
        status.complete_pass(now);
        assert!(!status.verification_due(now, interval, true));
        status.schedule_retry(now, FAILURE_RETRY_JITTER_PERCENT);
        assert_eq!(status.failure_delay, FAILURE_RETRY_MIN);
    }

    #[test]
    fn retry_jitter_stays_within_limits_and_spreads_sources() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), temporary.path());
        let mut status = lock(&source.status).unwrap();
        let now = status.verified;
        let mut delays = std::collections::HashSet::new();
        for jitter in 0..=u8::MAX {
            status.failure_delay = Duration::ZERO;
            status.schedule_retry(now, jitter);
            let delay = status.retry_at.saturating_duration_since(now);
            assert!((FAILURE_RETRY_MIN..=FAILURE_RETRY_MAX).contains(&delay));
            delays.insert(delay);
            status.failure_delay = FAILURE_RETRY_MAX;
            status.schedule_retry(now, jitter);
            assert!((FAILURE_RETRY_MIN..=FAILURE_RETRY_MAX).contains(&status.retry_at.saturating_duration_since(now)));
        }
        assert!(delays.len() > 1);
    }

    #[test]
    fn periodic_verification_jitter_preserves_deadlines_and_retry_priority() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), temporary.path());
        let policy = DirectoryPolicy::defaults().unwrap();
        let mut status = lock(&source.status).unwrap();
        assert_eq!(status.verification_jitter, Sha256::digest(source.session.as_bytes())[0]);
        let now = status.verified;
        for seconds in [policy.healthy_verification_seconds, policy.degraded_verification_seconds] {
            let interval = Duration::from_secs(seconds as u64);
            let mut delays = std::collections::HashSet::new();
            for jitter in 0..=u8::MAX {
                status.verification_jitter = jitter;
                let percent = 100 - jitter % (PERIODIC_VERIFICATION_JITTER_PERCENT + 1);
                let delay = interval.mul_f64(f64::from(percent) / 100.0);
                delays.insert(delay);
                assert!(delay >= interval.mul_f64(0.9) && delay <= interval);
                assert!(!status.verification_due(now + delay - Duration::from_millis(1), interval, true));
                assert!(status.verification_due(now + delay, interval, true));
                status.retry_at = now + delay + FAILURE_RETRY_MIN;
                assert!(!status.verification_due(now + delay, interval, true));
                assert!(status.verification_due(status.retry_at, interval, true));
                status.retry_at = now;
            }
            assert!(delays.len() > 1);
        }
        status.verification_jitter = 0;
        let interval = Duration::from_secs(policy.healthy_verification_seconds as u64);
        status.schedule_retry(now, FAILURE_RETRY_JITTER_PERCENT);
        assert!(status.verification_due(status.retry_at, interval, true));
        status.complete_pass(now + FAILURE_RETRY_MIN);
        assert!(!status.verification_due(status.verified, interval, true));
        assert!(status.verification_due(status.verified, interval, false));
        assert!(status.verification_due(status.verified + interval, interval, true));
    }

    #[test]
    fn completed_partial_pass_waits_for_its_degraded_deadline() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), temporary.path());
        let mut status = lock(&source.status).unwrap();
        status.verification_jitter = 0;
        let now = status.verified;
        let interval = Duration::from_secs(300);
        status.complete_pass(now);
        assert!(!status.verification_due(now, interval, true));
        assert!(!status.verification_due(now + interval - Duration::from_millis(1), interval, true));
        assert!(status.verification_due(now + interval, interval, true));
        assert!(status.verification_due(now, interval, false));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn parent_pruning_removes_only_confirmed_missing_children_and_rejects_stale_reads() {
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        let root_path = temporary.path().join("root");
        std::fs::create_dir_all(root_path.join("parent/keep/child")).unwrap();
        std::fs::create_dir(root_path.join("parent/gone-other")).unwrap();
        std::fs::write(root_path.join("parent/file"), b"fixture").unwrap();
        let root = NativeRoot::open(&root_path).unwrap();
        let identity = root.parent_identity("parent").unwrap();
        let source = LocalSource::new(root_path, &namespace);
        let mut index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index
            .write_paths(
                [
                    "parent/gone",
                    "parent/gone/child",
                    "parent/file",
                    "parent/file/child",
                    "parent/keep",
                    "parent/keep/child",
                    "parent/gone-other",
                ]
                .map(str::to_owned),
                None,
            )
            .unwrap();
        index.finish_generation(1, 0).unwrap();
        let reader = index.reader();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = reader.search("keep", 3, false, &cancelled, false).unwrap();
        *lock(&source.writer).unwrap() = Some(index);
        let budget = Arc::new(DiskBudget {
            namespace,
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: available_disk_bytes,
        });
        let read = source.begin_read().unwrap();
        let scan = ScanGeneration { id: 1, read: read.token };
        source.prune_missing_children(&root, "parent", identity, scan, &budget).unwrap();
        let after = reader.search("gone file keep", 3, false, &cancelled, false).unwrap();
        assert_eq!(after.directory_count, 3);
        assert_eq!(after.last_verified_at_ms, before.last_verified_at_ms);
        assert_eq!(reader.search("file", 3, false, &cancelled, false).unwrap().total_matches, 0);
        assert_eq!(reader.search("gone-other", 3, false, &cancelled, false).unwrap().total_matches, 1);
        source.invalidate().unwrap();
        assert!(matches!(
            source.prune_missing_children(&root, "parent", identity, scan, &budget),
            Err(IndexError::Interrupted)
        ));
        assert_eq!(reader.search("gone file keep", 3, false, &cancelled, false).unwrap(), after);
        let current = source.begin_read().unwrap();
        std::fs::rename(source.root_path.join("parent"), source.root_path.join("replaced-parent")).unwrap();
        std::fs::create_dir(source.root_path.join("parent")).unwrap();
        assert!(source
            .prune_missing_children(
                &root,
                "parent",
                identity,
                ScanGeneration {
                    id: 1,
                    read: current.token
                },
                &budget
            )
            .is_err());
        assert_eq!(reader.search("gone file keep", 3, false, &cancelled, false).unwrap(), after);
    }

    #[test]
    fn root_parent_barriers_reject_all_older_directory_reads() {
        let mut observations = Observations::default();
        let old = observations.begin_read().unwrap();
        observations.enqueue(parent_observation("renamed"), 4, 64).unwrap();
        assert!(!observations.is_current(old, "unrelated/child"));
        assert!(!observations.is_current(old, ""));
        let current = observations.begin_read().unwrap();
        assert!(observations.is_current(current, "unrelated"));
    }

    #[test]
    fn parallel_native_reads_hold_distinct_tokens_and_publish_on_the_scan_thread() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        let parallelism = limit("scan_read_parallelism").unwrap();
        let parents: Vec<_> = (0..parallelism).map(|number| format!("parent-{number}")).collect();
        for parent in &parents {
            std::fs::create_dir_all(path.join(parent).join("child")).unwrap();
        }
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path, manager.storage_directory());
        let root = source.bind_root(&manager.budget).unwrap();
        {
            let mut writer = lock(&source.writer).unwrap();
            let index = writer.as_mut().unwrap();
            index.seed_scan(1).unwrap();
            index
                .commit_scan_parents(1, &[(String::new(), parents.iter().map(|parent| (parent.clone(), true)).collect())])
                .unwrap();
        }
        let gate = Arc::new(std::sync::Barrier::new(parallelism + 1));
        *lock(&source.io.read_gate).unwrap() = Some(Arc::clone(&gate));
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| source.scan_native_parent_page(&root, 1, &parents, &manager.budget));
            gate.wait();
            assert_eq!(lock(&source.observations).unwrap().producers.len(), parallelism);
            assert_eq!(
                lock(&source.writer).unwrap().as_ref().unwrap().status().unwrap().directory_count,
                parallelism as i64
            );
            gate.wait();
            worker.join().unwrap().unwrap();
        });
        *lock(&source.io.read_gate).unwrap() = None;
        let index = lock(&source.writer).unwrap();
        assert_eq!(index.as_ref().unwrap().status().unwrap().directory_count, (parallelism * 2) as i64);
        assert!(lock(&source.observations).unwrap().producers.is_empty());
    }

    #[test]
    fn parallel_native_reads_release_tokens_after_storage_failure() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        let parents: Vec<_> = (0..limit("scan_read_parallelism").unwrap())
            .map(|number| format!("parent-{number}"))
            .collect();
        for parent in &parents {
            for number in 0..ROW_BATCH_SIZE + 1 {
                std::fs::create_dir_all(path.join(parent).join(format!("child-{number}"))).unwrap();
            }
        }
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(path, manager.storage_directory());
        let root = source.bind_root(&manager.budget).unwrap();
        {
            let mut writer = lock(&source.writer).unwrap();
            let index = writer.as_mut().unwrap();
            index.seed_scan(1).unwrap();
            index
                .commit_scan_parents(1, &[(String::new(), parents.iter().map(|parent| (parent.clone(), true)).collect())])
                .unwrap();
        }
        let connection = open_directory_database(&source.index_path, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        connection
            .execute_batch("CREATE TRIGGER reject_scan_child BEFORE INSERT ON directories BEGIN SELECT RAISE(ABORT, 'injected'); END")
            .unwrap();
        assert!(matches!(
            source.scan_native_parent_page(&root, 1, &parents, &manager.budget),
            Err(IndexError::Sql(_))
        ));
        assert!(lock(&source.observations).unwrap().producers.is_empty());
        assert_eq!(
            lock(&source.writer)
                .unwrap()
                .as_ref()
                .unwrap()
                .pending_scan_paths(1, ROW_BATCH_SIZE)
                .unwrap()
                .len(),
            parents.len()
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn invalid_native_name_accepts_partial_pass_and_keeps_readable_siblings() {
        use std::os::unix::ffi::OsStringExt;
        let temporary = tempfile::tempdir().unwrap();
        let root_path = temporary.path().join("root");
        std::fs::create_dir_all(root_path.join("readable/child")).unwrap();
        std::fs::create_dir(root_path.join(std::ffi::OsString::from_vec(vec![0xff]))).unwrap();
        std::os::unix::fs::symlink(temporary.path(), root_path.join("excluded-link")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root_path, manager.storage_directory());
        source.scan(&manager.budget).unwrap();
        let status = lock(&source.status).unwrap();
        let index = status.index_status.as_ref().unwrap();
        assert_eq!(index.directory_count, 2);
        assert_eq!(index.coverage, "partial");
        assert_eq!(index.issue_count, 1);
        assert!(index.last_verified_at_ms.is_some());
        assert!(status.message.is_none());
        assert!(!lock(&source.observations).unwrap().verification_required);
    }

    #[test]
    fn redirected_descendants_keep_complete_coverage_and_clear_old_issues() {
        let temporary = tempfile::tempdir().unwrap();
        let root_path = temporary.path().join("root");
        let target = temporary.path().join("outside");
        std::fs::create_dir(&root_path).unwrap();
        std::fs::create_dir_all(target.join("must-not-be-indexed")).unwrap();
        for (name, destination) in [("redirected", &target), ("cycle", &root_path)] {
            let link = root_path.join(name);
            #[cfg(unix)]
            std::os::unix::fs::symlink(destination, &link).unwrap();
            #[cfg(windows)]
            {
                let result = std::process::Command::new("cmd")
                    .args(["/d", "/c", "mklink", "/J"])
                    .arg(&link)
                    .arg(destination)
                    .output()
                    .unwrap();
                assert!(result.status.success(), "Junction creation failed: {result:?}");
            }
        }
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root_path, manager.storage_directory());
        source.scan(&manager.budget).unwrap();
        {
            let mut writer = lock(&source.writer).unwrap();
            let writer = writer.as_mut().unwrap();
            let status = writer.status().unwrap();
            assert_eq!(status.directory_count, 0);
            assert_eq!(status.issue_count, 0);
            assert_eq!(status.coverage, "complete");
            writer.record_issue(1, "unsafe_traversal").unwrap();
        }
        lock(&source.observations)
            .unwrap()
            .publish_issue_details("", &HashMap::from([("unsafe_traversal", 1)]))
            .unwrap();
        source.scan(&manager.budget).unwrap();
        let writer = lock(&source.writer).unwrap();
        let status = writer.as_ref().unwrap().status().unwrap();
        assert_eq!(status.directory_count, 0);
        assert_eq!(status.issue_count, 0);
        assert_eq!(status.coverage, "complete");
        assert!(lock(&source.observations).unwrap().issue_details.is_empty());
    }

    #[test]
    fn failed_native_parent_finishes_and_reconciliation_keeps_stored_children() {
        let temporary = tempfile::tempdir().unwrap();
        let root_path = temporary.path().join("root");
        std::fs::create_dir_all(root_path.join("parent/retained")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root_path.clone(), manager.storage_directory());
        source.scan(&manager.budget).unwrap();
        lock(&source.watcher).unwrap().take();
        let root = lock(&source.root).unwrap().as_ref().unwrap().clone();
        let generation = lock(&source.writer)
            .unwrap()
            .as_ref()
            .unwrap()
            .accepted_generation()
            .unwrap()
            .unwrap();
        std::fs::remove_dir_all(root_path.join("parent")).unwrap();
        std::fs::write(root_path.join("parent"), b"not a directory").unwrap();
        lock(&source.writer)
            .unwrap()
            .as_mut()
            .unwrap()
            .queue_reconciliation_parent(generation, "parent")
            .unwrap();
        source.scan_parent(&root, generation, "parent", &manager.budget).unwrap();
        let writer = lock(&source.writer).unwrap();
        let index = writer.as_ref().unwrap();
        assert!(index.reconciliation_generation().unwrap().is_none());
        assert_eq!(index.status().unwrap().coverage, "partial");
        assert_eq!(index.status().unwrap().issue_count, 1);
        assert_eq!(index.status().unwrap().directory_count, 2);
    }

    #[test]
    fn repeated_watcher_loss_preserves_rows_and_recovers_through_verification() {
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        let root_path = temporary.path().join("root");
        std::fs::create_dir_all(root_path.join("accepted/child")).unwrap();
        let source = LocalSource::new(root_path.clone(), &namespace);
        let mut index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index.write_paths(["accepted".into(), "accepted/child".into()], None).unwrap();
        index.finish_generation(1, 0).unwrap();
        let reader = index.reader();
        *lock(&source.writer).unwrap() = Some(index);
        *lock(&source.root).unwrap() = Some(Arc::new(NativeRoot::open(&root_path).unwrap()));
        let budget = Arc::new(DiskBudget {
            namespace,
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: available_disk_bytes,
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = reader.search("accepted", 3, false, &cancelled, false).unwrap();
        let mut uncertain = None;
        for _ in 0..3 {
            let read = source.begin_read().unwrap();
            source.observe(Err(notify::Error::generic("Injected watcher loss."))).unwrap();
            assert!(!lock(&source.observations).unwrap().is_current(read.token, "accepted"));
            source.flush(&budget).unwrap();
            let response = reader.search("accepted", 3, false, &cancelled, false).unwrap();
            assert_eq!(response.directory_count, before.directory_count);
            assert_eq!(response.total_matches, before.total_matches);
            assert_eq!(response.last_verified_at_ms, before.last_verified_at_ms);
            assert_eq!(response.coverage, "uncertain");
            assert_eq!(response.issue_count, 1);
            if let Some(previous) = &uncertain {
                assert_eq!(&response, previous);
            }
            uncertain = Some(response);
            assert!(lock(&source.observations).unwrap().verification_required);
        }
        lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
        let root = lock(&source.root).unwrap().as_ref().unwrap().clone();
        let mut candidate = None;
        for event in [
            Err(notify::Error::generic("Injected watcher loss during verification.")),
            Ok(Event::new(EventKind::Modify(ModifyKind::Any))
                .add_path(root_path.join("accepted"))
                .set_flag(notify::event::Flag::Rescan)),
        ] {
            source.flush(&budget).unwrap();
            let baseline = source.begin_read().unwrap();
            let generation = {
                let mut writer = lock(&source.writer).unwrap();
                let index = writer.as_mut().unwrap();
                let (generation, selected) = index.prepare_scan().unwrap();
                assert!(!selected);
                index.seed_scan(generation).unwrap();
                generation
            };
            if let Some(previous) = candidate {
                assert_eq!(generation, previous);
            }
            candidate = Some(generation);
            let mut interruption = Some(event);
            let outcome = source.scan_to_acceptance_with(&root, baseline.token, generation, &budget, |generation, parent| {
                source.scan_parent(&root, generation, parent, &budget)?;
                source.observe(interruption.take().unwrap())
            });
            assert!(matches!(outcome, Err(IndexError::Interrupted)));
            assert!(interruption.is_none());
            assert!(!lock(&source.observations).unwrap().is_current(baseline.token, ""));
            drop(baseline);
            source.flush(&budget).unwrap();
            let retained = reader.search("accepted", 3, false, &cancelled, false).unwrap();
            assert_eq!(retained.results, uncertain.as_ref().unwrap().results);
            assert_eq!(retained.last_verified_at_ms, uncertain.as_ref().unwrap().last_verified_at_ms);
            let writer = lock(&source.writer).unwrap();
            let index = writer.as_ref().unwrap();
            assert!(index.has_resumable_scan().unwrap());
            assert!(!index.pending_scan_paths(generation, 1).unwrap().is_empty());
        }
        source.scan(&budget).unwrap();
        assert!(lock(&source.watcher).unwrap().is_none());
        assert!(source.watcher_failed.load(Ordering::Acquire));
        assert_eq!(
            lock(&source.writer).unwrap().as_ref().unwrap().accepted_generation().unwrap(),
            candidate
        );
        let recovered = reader.search("accepted", 3, false, &cancelled, false).unwrap();
        assert_eq!(recovered.coverage, "complete");
        assert_eq!(recovered.issue_count, 0);
        assert!(!lock(&source.observations).unwrap().verification_required);
        source.observe(Err(notify::Error::generic("Injected new watcher loss."))).unwrap();
        source.flush(&budget).unwrap();
        let lost_again = reader.search("accepted", 3, false, &cancelled, false).unwrap();
        assert_eq!(lost_again.coverage, "uncertain");
        assert_eq!(lost_again.issue_count, 1);
        assert!(lost_again.accepted_revision > recovered.accepted_revision);
        assert_eq!(lost_again.last_verified_at_ms, recovered.last_verified_at_ms);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn unpaired_rename_hints_verify_directories_without_indexing_files() {
        for modes in [
            vec![RenameMode::From],
            vec![RenameMode::To],
            vec![RenameMode::To, RenameMode::From],
            vec![RenameMode::Any],
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let namespace = temporary.path().join("private");
            let root_path = temporary.path().join("root");
            std::fs::create_dir_all(root_path.join("old/child")).unwrap();
            let source = LocalSource::new(root_path.clone(), &namespace);
            let mut index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
            index.write_paths(["old".into(), "old/child".into()], None).unwrap();
            index.finish_generation(1, 0).unwrap();
            let reader = index.reader();
            *lock(&source.writer).unwrap() = Some(index);
            *lock(&source.root).unwrap() = Some(Arc::new(NativeRoot::open(&root_path).unwrap()));
            std::fs::rename(root_path.join("old"), root_path.join("new")).unwrap();
            std::fs::write(root_path.join("renamed-file.txt"), b"fixture").unwrap();
            for mode in modes {
                let path = if mode == RenameMode::From { "old" } else { "new" };
                source
                    .observe(Ok(
                        Event::new(EventKind::Modify(ModifyKind::Name(mode))).add_path(root_path.join(path))
                    ))
                    .unwrap();
            }
            source
                .observe(Ok(
                    Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To))).add_path(root_path.join("renamed-file.txt"))
                ))
                .unwrap();
            let budget = Arc::new(DiskBudget {
                namespace,
                policy_gate: Mutex::new(()),
                state: Mutex::new(DiskState {
                    policy: DirectoryPolicy::defaults().unwrap(),
                    reserved: 0,
                    next_cleanup_at: Instant::now(),
                }),
                space_probe: available_disk_bytes,
            });
            source.flush(&budget).unwrap();
            let cancelled = Arc::new(AtomicBool::new(false));
            assert_eq!(reader.search("renamed-file", 3, false, &cancelled, false).unwrap().total_matches, 0);
            assert!(lock(&source.observations).unwrap().verification_required);
            source.scan(&budget).unwrap();
            assert_eq!(
                reader
                    .search("old renamed-file", 3, false, &cancelled, false)
                    .unwrap()
                    .total_matches,
                0
            );
            let response = reader.search("new", 3, false, &cancelled, false).unwrap();
            assert_eq!(response.total_matches, 2);
            assert_eq!(response.directory_count, 2);
            assert!(!lock(&source.observations).unwrap().verification_required);
        }
    }

    #[tokio::test]
    async fn untyped_native_events_reconcile_directories_without_indexing_files() {
        for kind in [
            EventKind::Create(CreateKind::Any),
            EventKind::Remove(RemoveKind::Any),
            EventKind::Modify(ModifyKind::Any),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().join("root");
            std::fs::create_dir_all(root.join("old-reports/child")).unwrap();
            let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
            let source = LocalSource::new(root.clone(), manager.storage_directory());
            lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
            source.scan(&manager.budget).unwrap();
            let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            let initial = reader.search("reports", 5, false, &cancelled, false).unwrap();
            std::fs::remove_dir_all(root.join("old-reports")).unwrap();
            std::fs::create_dir_all(root.join("new-reports/child")).unwrap();
            std::fs::write(root.join("file-reports.txt"), b"fixture").unwrap();
            source
                .observe(Ok(Event::new(kind)
                    .add_path(root.join("new-reports"))
                    .add_path(root.join("old-reports"))
                    .add_path(root.join("file-reports.txt"))))
                .unwrap();
            assert!(!lock(&source.observations).unwrap().pending.is_empty(), "{kind:?}");
            source.flush(&manager.budget).unwrap();
            source.reconcile(&manager.budget, &manager.scans).unwrap();
            let result = reader.search("reports", 5, false, &cancelled, false).unwrap();
            assert_eq!(result.total_matches, 2, "{kind:?}");
            assert_eq!(result.directory_count, 2, "{kind:?}");
            assert!(result.results.iter().all(|row| row.path.starts_with("new-reports")), "{kind:?}");
            assert_eq!(result.coverage, initial.coverage, "{kind:?}");
            assert_eq!(result.last_verified_at_ms, initial.last_verified_at_ms);
        }
    }

    #[tokio::test]
    async fn observed_typed_change_keeps_coverage_complete() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root.clone(), manager.storage_directory());
        lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
        source.scan(&manager.budget).unwrap();
        let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let initial = reader.search("reports", 5, false, &cancelled, false).unwrap();
        assert_eq!(initial.coverage, "complete");
        std::fs::create_dir_all(root.join("reports")).unwrap();
        source
            .observe(Ok(Event::new(EventKind::Create(CreateKind::Folder)).add_path(root.join("reports"))))
            .unwrap();
        assert!(!lock(&source.observations).unwrap().uncertain);
        source.flush(&manager.budget).unwrap();
        source.reconcile(&manager.budget, &manager.scans).unwrap();
        let result = reader.search("reports", 5, false, &cancelled, false).unwrap();
        assert_eq!(result.total_matches, 1);
        assert_eq!(result.coverage, "complete");
        assert_eq!(result.last_verified_at_ms, initial.last_verified_at_ms);
    }

    #[tokio::test]
    async fn only_event_loss_invalidation_makes_coverage_uncertain() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir_all(root.join("reports")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root.clone(), manager.storage_directory());
        lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
        source.scan(&manager.budget).unwrap();
        let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let coverage = || reader.search("reports", 5, false, &cancelled, false).unwrap().coverage;
        assert_eq!(coverage(), "complete");

        source.invalidate_for(InvalidationReason::StalledRead).unwrap();
        {
            let observations = lock(&source.observations).unwrap();
            assert!(!observations.uncertain);
            assert!(observations.verification_required);
        }
        source.flush(&manager.budget).unwrap();
        assert_eq!(coverage(), "complete");
        source.scan(&manager.budget).unwrap();
        assert!(!lock(&source.observations).unwrap().verification_required);
        assert_eq!(coverage(), "complete");

        source.invalidate_for(InvalidationReason::ObservationLoss).unwrap();
        assert!(lock(&source.observations).unwrap().uncertain);
        source.flush(&manager.budget).unwrap();
        assert_eq!(coverage(), "uncertain");
    }

    #[test]
    fn observation_overflow_invalidates_before_dropping_the_new_hint() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), temporary.path());
        for number in 0..limit("max_pending_observations").unwrap() + 1 {
            source
                .observe(Ok(
                    Event::new(EventKind::Create(CreateKind::Folder)).add_path(source.root_path.join(format!("directory-{number}")))
                ))
                .unwrap();
        }
        let observations = source.observations.lock().unwrap();
        assert_eq!(observations.pending.len(), limit("max_pending_observations").unwrap());
        assert!(observations.verification_required);
        assert!(observations.uncertain);
        assert_eq!(observations.epoch, 1);
    }

    #[test]
    fn single_event_byte_overflow_stops_before_copying_remaining_hints() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), temporary.path());
        let read = source.begin_read().unwrap();
        let bytes = limit("max_observation_bytes").unwrap() / 2 + 1;
        let event = Event::new(EventKind::Create(CreateKind::Folder))
            .add_path(source.root_path.join("a".repeat(bytes)))
            .add_path(source.root_path.join("b".repeat(bytes)))
            .add_path(source.root_path.join("../not-parsed-after-overflow"));
        source.observe(Ok(event)).unwrap();
        let observations = lock(&source.observations).unwrap();
        assert_eq!(observations.pending.len(), 1);
        assert_eq!(observations.bytes, bytes);
        assert_eq!(observations.epoch, 1);
        assert!(observations.verification_required);
        assert!(!observations.is_current(read.token, ""));
    }

    #[test]
    fn prefix_barriers_coalesce_and_keep_the_newest_sequence() {
        let mut observations = Observations::default();
        let old = observations.begin_read().unwrap();
        for path in ["alpha/first", "unrelated", "alpha/second", "alpha", "alpha/next"] {
            assert!(observations.enqueue(DirectoryMutation::Add { path: path.into() }, 3, 64).unwrap());
            observations.pending.clear();
            observations.bytes = 0;
            observations.retire_barriers();
        }
        assert_eq!(observations.epoch, 0);
        assert_eq!(observations.barriers.len(), 2);
        assert_eq!(observations.barrier_bytes, "alpha".len() + "unrelated".len());
        assert!(observations.barriers.contains(&(observations.sequence, "alpha".into())));
        assert!(!observations.is_current(old, "alpha/first"));
        assert!(!observations.is_current(old, ""));
        assert!(observations.is_current(old, "other"));
        assert!(observations.is_current(old, "alphabet"));
    }

    #[test]
    fn barrier_retirement_waits_for_distinct_producers_and_queued_work() {
        let mut observations = Observations::default();
        let first = observations.begin_read().unwrap();
        let second = observations.begin_read().unwrap();
        assert_ne!(first, second);
        observations
            .enqueue(DirectoryMutation::Remove { path: "alpha".into() }, 2, 64)
            .unwrap();
        observations.end_read(first);
        assert_eq!(observations.barriers.len(), 1);
        observations.end_read(second);
        assert_eq!(observations.barriers.len(), 1);
        observations.pending.clear();
        observations.bytes = 0;
        observations.retire_barriers();
        assert!(observations.barriers.is_empty());
        assert_eq!(observations.barrier_bytes, 0);
        assert!(!observations.is_current(second, "alpha"));
    }

    #[test]
    fn barrier_overflow_invalidates_blocked_producers_before_retirement() {
        for (maximum_pending, maximum_bytes) in [(1, 64), (4, 5)] {
            let mut observations = Observations::default();
            let old = observations.begin_read().unwrap();
            observations
                .enqueue(DirectoryMutation::Add { path: "alpha".into() }, maximum_pending, maximum_bytes)
                .unwrap();
            observations.pending.clear();
            observations.bytes = 0;
            assert!(observations
                .enqueue(DirectoryMutation::Remove { path: "beta".into() }, maximum_pending, maximum_bytes)
                .unwrap());
            assert_eq!(observations.epoch, 1);
            assert!(observations.barriers.is_empty());
            assert_eq!(observations.barrier_bytes, 0);
            assert_eq!(observations.pending.len(), 1);
            assert_eq!(observations.producers.len(), 1);
            assert!(observations.verification_required);
            assert!(!observations.is_current(old, "alpha"));
            assert!(!observations.is_current(old, ""));
            observations.end_read(old);
            assert!(observations.producers.is_empty());
        }
    }

    #[test]
    fn observation_read_releases_on_error_without_early_permit_release() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), temporary.path());
        source.busy.store(true, Ordering::Release);
        let semaphore = Arc::new(Semaphore::new(1));
        let ownership = ScanOwnership {
            source: Arc::clone(&source),
            _permit: Arc::clone(&semaphore).try_acquire_owned().unwrap(),
        };
        let read = source.begin_read().unwrap();
        source.invalidate().unwrap();
        assert_eq!(lock(&source.observations).unwrap().producers.len(), 1);
        assert_eq!(semaphore.available_permits(), 0);
        drop(read);
        assert!(lock(&source.observations).unwrap().producers.is_empty());
        assert_eq!(semaphore.available_permits(), 0);
        drop(ownership);
        assert_eq!(semaphore.available_permits(), 1);
    }

    #[test]
    fn blocked_observation_read_keeps_ownership_through_overflow() {
        for (maximum_pending, maximum_bytes, drain_first) in [(1, 64, false), (4, 14, false), (1, 64, true), (4, 14, true)] {
            let temporary = tempfile::tempdir().unwrap();
            let root_path = temporary.path().join("root");
            std::fs::create_dir(&root_path).unwrap();
            let namespace = temporary.path().join("private");
            let source = LocalSource::new(root_path, &namespace);
            let mut index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
            index.write_paths(["accepted".into()], None).unwrap();
            assert!(index.finish_generation(1, 0).unwrap());
            let candidate = index.prepare_scan().unwrap().0;
            index.write_paths(["candidate".into()], Some(candidate)).unwrap();
            let reader = index.reader();
            let cancelled = Arc::new(AtomicBool::new(false));
            let before = reader.search("accepted candidate stale", 3, false, &cancelled, false).unwrap();
            *lock(&source.writer).unwrap() = Some(index);
            let budget = Arc::new(DiskBudget {
                namespace,
                policy_gate: Mutex::new(()),
                state: Mutex::new(DiskState {
                    policy: DirectoryPolicy::defaults().unwrap(),
                    reserved: 0,
                    next_cleanup_at: Instant::now(),
                }),
                space_probe: available_disk_bytes,
            });
            source.busy.store(true, Ordering::Release);
            let semaphore = Arc::new(Semaphore::new(1));
            let ownership = ScanOwnership {
                source: Arc::clone(&source),
                _permit: Arc::clone(&semaphore).try_acquire_owned().unwrap(),
            };
            let read = source.begin_read().unwrap();
            let token = read.token;
            let (release, blocked) = std::sync::mpsc::channel::<()>();
            let worker = std::thread::spawn(move || {
                let _ownership = ownership;
                let _read = read;
                blocked.recv().unwrap();
            });
            assert!(lock(&source.observations)
                .unwrap()
                .enqueue(DirectoryMutation::Add { path: "accepted".into() }, maximum_pending, maximum_bytes)
                .unwrap());
            if drain_first {
                source.flush(&budget).unwrap();
            }
            {
                let mut observations = lock(&source.observations).unwrap();
                assert_eq!(
                    observations
                        .enqueue(
                            DirectoryMutation::ReadParent { path: "deleted".into() },
                            maximum_pending,
                            maximum_bytes
                        )
                        .unwrap(),
                    drain_first
                );
                assert_eq!(observations.epoch, 1);
                assert!(observations.barriers.is_empty());
                assert_eq!(observations.barrier_bytes, 0);
                assert!(!observations.is_current(token, ""));
                assert_eq!(observations.producers.len(), 1);
                assert_eq!(observations.pending.len(), 1);
                assert_eq!(observations.bytes, if drain_first { "deleted".len() } else { "accepted".len() });
                assert!(!observations
                    .enqueue(DirectoryMutation::Add { path: "overflow".into() }, maximum_pending, maximum_bytes)
                    .unwrap());
                assert_eq!(observations.epoch, 2);
                assert_eq!(observations.pending.len(), 1);
                assert_eq!(observations.bytes, if drain_first { "deleted".len() } else { "accepted".len() });
                assert!(observations.verification_required);
            }
            source.flush(&budget).unwrap();
            #[cfg(target_os = "linux")]
            {
                let root = NativeRoot::open(&source.root_path).unwrap();
                let identity = root.parent_identity("").unwrap();
                assert!(matches!(
                    source.commit_children(
                        &root,
                        "",
                        identity,
                        ScanGeneration {
                            id: candidate,
                            read: token
                        },
                        &[("stale".into(), false)],
                        &budget,
                    ),
                    Err(IndexError::Interrupted)
                ));
                assert!(matches!(
                    source.accept_generation(&root, token, candidate, &budget),
                    Err(IndexError::Interrupted)
                ));
            }
            let response = reader.search("accepted candidate stale", 3, false, &cancelled, false).unwrap();
            assert_eq!(response.total_matches, before.total_matches);
            assert_eq!(response.directory_count, before.directory_count);
            assert_eq!(response.results, before.results);
            assert_eq!(response.coverage, "uncertain");
            assert_eq!(response.issue_count, 1);
            assert_eq!(response.last_verified_at_ms, before.last_verified_at_ms);
            assert!(lock(&source.observations).unwrap().pending.is_empty());
            assert_eq!(lock(&source.observations).unwrap().bytes, 0);
            assert_eq!(semaphore.available_permits(), 0);
            assert!(source.busy.load(Ordering::Acquire));
            release.send(()).unwrap();
            worker.join().unwrap();
            assert!(lock(&source.observations).unwrap().producers.is_empty());
            assert_eq!(semaphore.available_permits(), 1);
            assert!(!source.busy.load(Ordering::Acquire));
            assert!(lock(&source.observations).unwrap().verification_required);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn accepted_parent_reconciliation_updates_tree_without_full_verification() {
        for mode in ["paired", "from-to", "to-from", "unknown"] {
            let temporary = tempfile::tempdir().unwrap();
            let root_path = temporary.path().join("root");
            for path in ["stable", "old/child", "gone/child"] {
                std::fs::create_dir_all(root_path.join(path)).unwrap();
            }
            std::fs::write(root_path.join("regular"), b"fixture").unwrap();
            let source = LocalSource::new(root_path.clone(), &temporary.path().join("private"));
            let mut budget = Arc::new(DiskBudget {
                namespace: temporary.path().join("private"),
                policy_gate: Mutex::new(()),
                state: Mutex::new(DiskState {
                    policy: DirectoryPolicy::defaults().unwrap(),
                    reserved: 0,
                    next_cleanup_at: Instant::now(),
                }),
                space_probe: available_disk_bytes,
            });
            source.scan(&budget).unwrap();
            let accepted = lock(&source.writer).unwrap().as_ref().unwrap().accepted_generation().unwrap();
            lock(&source.watcher).unwrap().take();
            let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            let before = reader.search("stable old gone", 3, false, &cancelled, false).unwrap();
            let verified = lock(&source.status).unwrap().verified;
            std::fs::rename(root_path.join("old"), root_path.join("new")).unwrap();
            std::fs::create_dir_all(root_path.join("new/additional/deeper")).unwrap();
            std::fs::create_dir_all(root_path.join("created/deep")).unwrap();
            std::fs::remove_dir_all(root_path.join("gone")).unwrap();
            std::fs::rename(root_path.join("regular"), root_path.join("moved-file")).unwrap();
            let from = || Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From))).add_path(root_path.join("old"));
            let to = || Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To))).add_path(root_path.join("new"));
            match mode {
                "paired" => source
                    .observe(Ok(Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                        .add_path(root_path.join("old"))
                        .add_path(root_path.join("new"))))
                    .unwrap(),
                "from-to" => {
                    source.observe(Ok(from())).unwrap();
                    source.observe(Ok(to())).unwrap();
                }
                "to-from" => {
                    source.observe(Ok(to())).unwrap();
                    source.observe(Ok(from())).unwrap();
                }
                _ => source
                    .observe(Ok(
                        Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any))).add_path(root_path.join("new"))
                    ))
                    .unwrap(),
            }
            source
                .observe(Ok(
                    Event::new(EventKind::Create(CreateKind::Folder)).add_path(root_path.join("created"))
                ))
                .unwrap();
            source
                .observe(Ok(
                    Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Any))).add_path(root_path.join("moved-file"))
                ))
                .unwrap();
            source.flush(&budget).unwrap();
            {
                let stale = source.begin_read().unwrap();
                let root = lock(&source.root).unwrap().clone().unwrap();
                let identity = root.parent_identity("").unwrap();
                source.invalidate().unwrap();
                assert!(matches!(
                    source.commit_children(
                        &root,
                        "",
                        identity,
                        ScanGeneration { id: 1, read: stale.token },
                        &[("stale".into(), false)],
                        &budget,
                    ),
                    Err(IndexError::Interrupted)
                ));
            }
            let paused = reader
                .search("stable old new gone created moved-file", 3, false, &cancelled, false)
                .unwrap();
            let scans = Arc::new(Semaphore::new(1));
            let held = Arc::clone(&scans).try_acquire_owned().unwrap();
            source.reconcile(&budget, &scans).unwrap();
            assert!(!source.busy.load(Ordering::Acquire));
            assert!(lock(&source.writer)
                .unwrap()
                .as_ref()
                .unwrap()
                .reconciliation_generation()
                .unwrap()
                .is_some());
            assert_eq!(
                reader
                    .search("stable old new gone created moved-file", 3, false, &cancelled, false)
                    .unwrap(),
                paused
            );
            drop(held);
            Arc::get_mut(&mut budget).unwrap().space_probe = |_| Ok(0);
            let refusal = source.reconcile(&budget, &scans).unwrap_err();
            assert!(matches!(refusal, IndexError::StoragePaused(_)));
            assert_eq!(
                reader
                    .search("stable old new gone created moved-file", 3, false, &cancelled, false)
                    .unwrap(),
                paused
            );
            assert_eq!(scans.available_permits(), 1);
            assert!(!source.busy.load(Ordering::Acquire));
            assert!(lock(&source.observations).unwrap().producers.is_empty());
            source.fail(&refusal, &budget);
            Arc::get_mut(&mut budget).unwrap().space_probe = available_disk_bytes;
            source.reconcile(&budget, &scans).unwrap();
            assert_eq!(
                reader
                    .search("stable old new gone created moved-file", 3, false, &cancelled, false)
                    .unwrap(),
                paused
            );
            lock(&source.status).unwrap().retry_at = Instant::now();
            source.reconcile(&budget, &scans).unwrap();
            let after = reader.search("stable new created", 3, false, &cancelled, false).unwrap();
            assert_eq!(after.total_matches, 7);
            assert_eq!(after.directory_count, 7);
            assert_eq!(
                reader
                    .search("old gone moved-file", 3, false, &cancelled, false)
                    .unwrap()
                    .total_matches,
                0
            );
            assert_eq!(after.last_verified_at_ms, before.last_verified_at_ms);
            assert_eq!(lock(&source.status).unwrap().verified, verified);
            // Observed changes keep coverage. Only the injected loss marks it uncertain on the next flush.
            assert_eq!(after.coverage, before.coverage);
            assert!(lock(&source.observations).unwrap().uncertain);
            source.flush(&budget).unwrap();
            assert_eq!(reader.search("stable", 3, false, &cancelled, false).unwrap().coverage, "uncertain");
            assert!(lock(&source.observations).unwrap().verification_required);
            assert!(lock(&source.observations).unwrap().producers.is_empty());
            assert_eq!(scans.available_permits(), 1);
            assert!(!source.busy.load(Ordering::Acquire));
            assert_eq!(lock(&budget.state).unwrap().reserved, 0);
            let writer = lock(&source.writer).unwrap();
            let writer = writer.as_ref().unwrap();
            assert_eq!(writer.accepted_generation().unwrap(), accepted);
            assert!(writer.reconciliation_generation().unwrap().is_none());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "Explicit injected application resource measurement; not part of routine tests."]
    fn injected_application_capacity_measurement() {
        const DEFAULT_COUNT: usize = 100_000;
        const QUERY_SAMPLES: usize = 30;
        const SAMPLE_INTERVAL: Duration = Duration::from_millis(100);
        const NANOSECONDS_PER_SECOND: f64 = 1_000_000_000.0;

        fn process_cpu_seconds() -> f64 {
            let mut clock = libc::timespec { tv_sec: 0, tv_nsec: 0 };
            assert_eq!(
                unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut clock) },
                0,
                "Cannot read the process CPU clock: {}",
                std::io::Error::last_os_error()
            );
            clock.tv_sec as f64 + clock.tv_nsec as f64 / NANOSECONDS_PER_SECOND
        }

        fn process_memory() -> (u64, u64) {
            let status = std::fs::read_to_string("/proc/self/status").unwrap();
            let value = |key| {
                status
                    .lines()
                    .find(|line| line.starts_with(key))
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
            };
            (value("VmRSS:"), value("VmHWM:"))
        }

        let count = std::env::var("DIRECTORY_INDEX_MEASURE_COUNT")
            .map(|value| value.parse::<usize>().unwrap())
            .unwrap_or(DEFAULT_COUNT);
        assert!(count >= DEFAULT_COUNT);
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        let root_path = temporary.path().join("root");
        std::fs::create_dir(&root_path).unwrap();
        let root = NativeRoot::open(&root_path).unwrap();
        let source = LocalSource::new(root_path, &namespace);
        let identity = json!({"root": "injected-capacity-fixture"});
        let index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &identity).unwrap();
        let reader = index.reader();
        *lock(&source.writer).unwrap() = Some(index);
        source.busy.store(true, Ordering::Release);
        let budget = Arc::new(DiskBudget {
            namespace: namespace.clone(),
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: available_disk_bytes,
        });
        let started = Instant::now();
        let started_cpu = process_cpu_seconds();
        let initial_memory = process_memory();
        let finished = Arc::new(AtomicBool::new(false));
        let sampled = Arc::new(Mutex::new(
            json!({"rss_kib": 0, "fds": 0, "managed_bytes": 0, "main_bytes": 0, "wal_bytes": 0, "shm_bytes": 0}),
        ));
        let first_partial = Arc::new(Mutex::new(None));
        let sampler = {
            let finished = Arc::clone(&finished);
            let sampled = Arc::clone(&sampled);
            let first_partial = Arc::clone(&first_partial);
            let path = source.index_path.clone();
            let reader = reader.clone();
            let budget = Arc::clone(&budget);
            std::thread::spawn(move || {
                while !finished.load(Ordering::Acquire) {
                    let mut sample = lock(&sampled).unwrap();
                    for (key, value) in [
                        ("rss_kib", process_memory().0),
                        ("fds", std::fs::read_dir("/proc/self/fd").unwrap().count() as u64),
                        ("managed_bytes", budget.managed_bytes().unwrap()),
                    ] {
                        sample[key] = json!(sample[key].as_u64().unwrap().max(value));
                    }
                    for (key, suffix) in [("main_bytes", ""), ("wal_bytes", "-wal"), ("shm_bytes", "-shm")] {
                        let value = std::fs::metadata(format!("{}{suffix}", path.display()))
                            .map(|metadata| metadata.len())
                            .unwrap_or(0);
                        sample[key] = json!(sample[key].as_u64().unwrap().max(value));
                    }
                    drop(sample);
                    if lock(&first_partial).unwrap().is_none() {
                        let result = reader.search("000099", 3, false, &Arc::new(AtomicBool::new(false)), false).unwrap();
                        if !result.results.is_empty() {
                            *lock(&first_partial).unwrap() = Some(json!({
                                "seconds": started.elapsed().as_secs_f64(),
                                "coverage": result.coverage,
                                "directory_count": result.directory_count
                            }));
                        }
                    }
                    std::thread::park_timeout(SAMPLE_INTERVAL);
                }
            })
        };
        let run_generation = || {
            let baseline = source.begin_read().unwrap();
            let generation = {
                let _reservation = budget.reserve().unwrap();
                let mut writer = lock(&source.writer).unwrap();
                let writer = writer.as_mut().unwrap();
                let (generation, _) = writer.prepare_scan().unwrap();
                writer.seed_scan(generation).unwrap();
                generation
            };
            source
                .scan_to_acceptance_with(&root, baseline.token, generation, &budget, |generation, parent| {
                    let read = source.begin_read()?;
                    if parent.is_empty() {
                        let mut batch = Vec::with_capacity(ROW_BATCH_SIZE);
                        for number in 0..count {
                            batch.push((format!("directory-{number:06}"), true));
                            if batch.len() == ROW_BATCH_SIZE || number + 1 == count {
                                let observations = lock(&source.observations)?;
                                assert!(observations.is_current(read.token, parent));
                                let _reservation = budget.reserve()?;
                                lock(&source.writer)?
                                    .as_mut()
                                    .unwrap()
                                    .write_scan_children(generation, batch.drain(..))?;
                            }
                        }
                    }
                    let observations = lock(&source.observations)?;
                    assert!(observations.is_current(read.token, parent));
                    let _reservation = budget.reserve()?;
                    lock(&source.writer)?.as_mut().unwrap().finish_scan_parent(generation, parent)
                })
                .unwrap();
        };
        let begin = Instant::now();
        let begin_cpu = process_cpu_seconds();
        run_generation();
        let build_seconds = begin.elapsed().as_secs_f64();
        let build_cpu_seconds = process_cpu_seconds() - begin_cpu;
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut selective_ms = Vec::with_capacity(QUERY_SAMPLES);
        for _ in 0..QUERY_SAMPLES {
            let begin = Instant::now();
            let result = reader.search("090000", 3, false, &cancelled, false).unwrap();
            selective_ms.push(begin.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(result.directory_count, count as i64);
            assert_eq!(result.total_matches, 1);
        }
        selective_ms.sort_by(f64::total_cmp);
        let mut query_ms = serde_json::Map::new();
        for (label, query) in [("common", "directory"), ("mixed_short", "ry 090000")] {
            let begin = Instant::now();
            let result = reader.search(query, 3, false, &cancelled, false).unwrap();
            query_ms.insert(label.into(), json!(begin.elapsed().as_secs_f64() * 1000.0));
            assert_eq!(result.total_matches, count as i64);
            assert_eq!(result.results.len(), 3);
        }
        let verification_started = Instant::now();
        let verification_started_cpu = process_cpu_seconds();
        let verification_query_ms = std::thread::scope(|scope| {
            let verification = scope.spawn(run_generation);
            let begin = Instant::now();
            let result = reader.search("090000", 3, false, &cancelled, false).unwrap();
            assert_eq!(result.directory_count, count as i64);
            assert_eq!(result.total_matches, 1);
            let elapsed = begin.elapsed().as_secs_f64() * 1000.0;
            verification.join().unwrap();
            elapsed
        });
        let verification_seconds = verification_started.elapsed().as_secs_f64();
        let verification_cpu_seconds = process_cpu_seconds() - verification_started_cpu;
        let small_reader = {
            let mut writer = lock(&source.writer).unwrap();
            let writer = writer.as_mut().unwrap();
            writer.configure_page_cache(64).unwrap();
            writer.reader()
        };
        assert_eq!(
            small_reader.search("ry 090000", 3, false, &cancelled, false).unwrap().total_matches,
            count as i64
        );
        finished.store(true, Ordering::Release);
        sampler.thread().unpark();
        sampler.join().unwrap();
        lock(&source.writer).unwrap().take();
        let reopen_started = Instant::now();
        let reopened = DirectoryIndex::open(&source.index_path, SourceKind::Local, &identity).unwrap();
        assert_eq!(
            reopened.search("090000", 3, false, &cancelled, false).unwrap().directory_count,
            count as i64
        );
        eprintln!(
            "DIRECTORY_INDEX_APPLICATION_MEASUREMENT {}",
            json!({
                "rows": count, "build_seconds": build_seconds, "verification_seconds": verification_seconds,
                "build_cpu_seconds": build_cpu_seconds, "verification_cpu_seconds": verification_cpu_seconds,
                "query_during_verification_ms": verification_query_ms, "storage_reopen_seconds": reopen_started.elapsed().as_secs_f64(),
                "selective_query_ms": {"samples": QUERY_SAMPLES, "p50": selective_ms[QUERY_SAMPLES / 2], "p95": selective_ms[(QUERY_SAMPLES * 95).div_ceil(100) - 1], "max": selective_ms[QUERY_SAMPLES - 1]},
                "broad_query_ms": query_ms, "first_partial": *lock(&first_partial).unwrap(), "sampled_peaks": *lock(&sampled).unwrap(),
                "initial_rss_kib": initial_memory.0, "process_peak_rss_kib": process_memory().1,
                "cache_target_kib_per_connection": DirectoryPolicy::defaults().unwrap().page_cache_kib, "small_cache_kib": 64,
                "sqlite": rusqlite::version(), "total_seconds": started.elapsed().as_secs_f64(),
                "total_cpu_seconds": process_cpu_seconds() - started_cpu
            })
        );
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[tokio::test]
    async fn saturated_query_workers_return_retriable_http_status_and_recover() {
        use axum::{body::Body, http::Request, routing::get, Router};
        use tower::ServiceExt;

        const MAX_RESPONSE_BYTES: usize = 64 * 1024;
        let temporary = tempfile::tempdir().unwrap();
        let root_path = temporary.path().join("root");
        std::fs::create_dir(&root_path).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root_path.clone(), &manager.budget.namespace);
        let mut index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "query-capacity-fixture"})).unwrap();
        index.write_paths(["reports".into()], None).unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        *lock(&source.root).unwrap() = Some(Arc::new(NativeRoot::open(&root_path).unwrap()));
        *lock(&source.reader).unwrap() = Some(index.reader());
        *lock(&source.writer).unwrap() = Some(index);
        lock(&source.status).unwrap().state = "ready";
        source.busy.store(true, Ordering::Release);
        let drive = format!("query-capacity-{}", uuid::Uuid::new_v4());
        super::super::drives::register_test_drive_path(drive.clone(), root_path);
        lock(&manager.sources).unwrap().insert(drive.clone(), Arc::clone(&source));
        let query_capacity = manager.queries.available_permits();
        let mut permits = Some(
            Arc::clone(&manager.queries)
                .try_acquire_many_owned(u32::try_from(query_capacity).unwrap())
                .unwrap(),
        );
        let router = Router::new()
            .route(
                "/api/browse/{drive}/directories",
                get(super::super::handlers::browse_search_directories),
            )
            .with_state(super::super::handlers::DirectoryMutationState(Arc::clone(&manager)));
        for saturated in [true, false] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/browse/{drive}/directories?q=reports"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), MAX_RESPONSE_BYTES).await.unwrap();
            let result: serde_json::Value = serde_json::from_slice(&body).unwrap();
            if saturated {
                assert_eq!(status, axum::http::StatusCode::TOO_MANY_REQUESTS);
                assert_eq!(result["detail"], IndexError::QueryBusy.to_string());
            } else {
                assert_eq!(status, axum::http::StatusCode::OK);
                assert_eq!(result["results"], json!(["reports"]));
            }
            if saturated {
                drop(permits.take());
            }
        }
        assert_eq!(manager.queries.available_permits(), query_capacity);
        assert_eq!(source.active_queries.load(Ordering::Acquire), 0);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "Explicit seeded HTTP latency measurement; not part of routine tests."]
    async fn seeded_directory_search_http_latency_measurement() {
        use axum::{body::Body, http::Request, routing::get, Router};
        use tower::ServiceExt;

        const DEFAULT_COUNT: usize = 100_000;
        const QUERY_SAMPLES: usize = 30;
        const MAX_RESPONSE_BYTES: usize = 64 * 1024;

        let count = std::env::var("DIRECTORY_INDEX_HTTP_MEASURE_COUNT")
            .map(|value| value.parse::<usize>().unwrap())
            .unwrap_or(DEFAULT_COUNT);
        assert!(count > 0);
        let temporary = tempfile::tempdir().unwrap();
        let root_path = temporary.path().join("root");
        std::fs::create_dir(&root_path).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let source = LocalSource::new(root_path.clone(), &manager.budget.namespace);
        let mut index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "http-timing-fixture"})).unwrap();
        index
            .write_paths((0..count).map(|number| format!("directory-{number:06}")), None)
            .unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        *lock(&source.root).unwrap() = Some(Arc::new(NativeRoot::open(&root_path).unwrap()));
        *lock(&source.reader).unwrap() = Some(index.reader());
        *lock(&source.writer).unwrap() = Some(index);
        lock(&source.status).unwrap().state = "ready";
        source.busy.store(true, Ordering::Release);
        let drive = format!("http-measurement-{}", uuid::Uuid::new_v4());
        super::super::drives::register_test_drive_path(drive.clone(), root_path);
        lock(&manager.sources).unwrap().insert(drive.clone(), Arc::clone(&source));
        let router = Router::new()
            .route(
                "/api/browse/{drive}/directories",
                get(super::super::handlers::browse_search_directories),
            )
            .with_state(super::super::handlers::DirectoryMutationState(Arc::clone(&manager)));
        let query = format!("{:06}", count - 1);
        let mut samples = Vec::with_capacity(QUERY_SAMPLES);
        for _ in 0..QUERY_SAMPLES {
            let started = Instant::now();
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/api/browse/{drive}/directories?q={query}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), MAX_RESPONSE_BYTES).await.unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(status, axum::http::StatusCode::OK, "{}", String::from_utf8_lossy(&body));
            let result: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(result["directory_count"].as_u64(), Some(count as u64));
            assert_eq!(result["total_matches"].as_u64(), Some(1));
            assert_eq!(result["results"], json!([format!("directory-{:06}", count - 1)]));
        }
        assert_eq!(source.active_queries.load(Ordering::Acquire), 0);
        samples.sort_by(f64::total_cmp);
        eprintln!(
            "DIRECTORY_INDEX_HTTP_MEASUREMENT {}",
            json!({
                "rows": count, "samples": QUERY_SAMPLES,
                "p50_ms": (samples[QUERY_SAMPLES / 2 - 1] + samples[QUERY_SAMPLES / 2]) / 2.0,
                "p95_ms": samples[(QUERY_SAMPLES * 95).div_ceil(100) - 1], "max_ms": samples[QUERY_SAMPLES - 1],
                "method": "Axum routing, real native query worker and seeded SQLite; excludes pairing authentication, TCP and source build time",
                "cache_target_kib_per_connection": DirectoryPolicy::defaults().unwrap().page_cache_kib,
                "sqlite": rusqlite::version(), "debug_build": cfg!(debug_assertions)
            })
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn late_scan_batches_and_live_pass_completion_cannot_restore_deleted_rows() {
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        let root_path = temporary.path().join("root");
        std::fs::create_dir(&root_path).unwrap();
        std::fs::create_dir(root_path.join("alpha")).unwrap();
        let root = NativeRoot::open(&root_path).unwrap();
        let parent_identity = root.parent_identity("alpha").unwrap();
        let source = LocalSource::new(root_path, &namespace);
        let mut index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index
            .write_paths(["alpha".into(), "alpha/child".into(), "unrelated".into()], None)
            .unwrap();
        index.finish_generation(1, 0).unwrap();
        let generation = index.prepare_scan().unwrap().0;
        index.write_paths(["alpha".into(), "candidate".into()], Some(generation)).unwrap();
        let reader = index.reader();
        *lock(&source.writer).unwrap() = Some(index);
        source.busy.store(true, Ordering::Release);
        let baseline = source.begin_read().unwrap();
        let read = source.begin_read().unwrap();
        let budget = Arc::new(DiskBudget {
            namespace,
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: available_disk_bytes,
        });
        source
            .observe(Ok(
                Event::new(EventKind::Remove(RemoveKind::Folder)).add_path(source.root_path.join("alpha"))
            ))
            .unwrap();
        source.flush(&budget).unwrap();
        assert!(matches!(
            source.commit_children(
                &root,
                "alpha",
                parent_identity,
                ScanGeneration {
                    id: generation,
                    read: read.token
                },
                &[("alpha/stale".into(), false)],
                &budget,
            ),
            Err(IndexError::Interrupted)
        ));
        assert!(matches!(
            source.accept_generation(&root, baseline.token, generation, &budget),
            Err(IndexError::Interrupted)
        ));
        let cancelled = Arc::new(AtomicBool::new(false));
        assert_eq!(reader.search("alpha", 3, false, &cancelled, false).unwrap().total_matches, 0);
        assert_eq!(
            reader
                .search("unrelated candidate", 3, false, &cancelled, false)
                .unwrap()
                .total_matches,
            2
        );
        assert!(lock(&source.observations).unwrap().verification_required);
    }

    #[test]
    fn scan_permit_is_owned_until_the_real_worker_drops() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), temporary.path());
        source.busy.store(true, Ordering::Release);
        let semaphore = Arc::new(Semaphore::new(1));
        let ownership = ScanOwnership {
            source: Arc::clone(&source),
            _permit: Arc::clone(&semaphore).try_acquire_owned().unwrap(),
        };
        source.invalidate().unwrap();
        assert_eq!(semaphore.available_permits(), 0);
        assert!(source.busy.load(Ordering::Acquire));
        drop(ownership);
        assert_eq!(semaphore.available_permits(), 1);
        assert!(!source.busy.load(Ordering::Acquire));
    }

    #[test]
    fn update_ownership_releases_on_worker_failure() {
        let temporary = tempfile::tempdir().unwrap();
        let source = LocalSource::new(temporary.path().join("root"), temporary.path());
        source.flush_busy.store(true, Ordering::Release);
        let semaphore = Arc::new(Semaphore::new(1));
        let ownership = UpdateOwnership {
            source: Arc::clone(&source),
            _permit: Arc::clone(&semaphore).try_acquire_owned().unwrap(),
        };
        let outcome = std::thread::spawn(move || {
            let _ownership = ownership;
            panic!("Injected worker failure");
        })
        .join();
        assert!(outcome.is_err());
        assert!(!source.flush_busy.load(Ordering::Acquire));
        assert_eq!(semaphore.available_permits(), 1);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn accepted_parent_reconciliation_runs_in_update_worker() {
        let temporary = tempfile::tempdir().unwrap();
        let root_path = temporary.path().join("root");
        std::fs::create_dir_all(root_path.join("stable")).unwrap();
        let namespace = temporary.path().join("private");
        let budget = Arc::new(DiskBudget {
            namespace: namespace.clone(),
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: available_disk_bytes,
        });
        let source = LocalSource::new(root_path.clone(), &namespace);
        source.scan(&budget).unwrap();
        let accepted = lock(&source.writer).unwrap().as_ref().unwrap().accepted_generation().unwrap();
        lock(&source.watcher).unwrap().take();
        lock(&source.status).unwrap().watcher_retry_at = Instant::now() + FAILURE_RETRY_MAX;
        let reader = lock(&source.reader).unwrap().as_ref().unwrap().clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = reader.search("stable incoming", 3, false, &cancelled, false).unwrap();
        let verified = lock(&source.status).unwrap().verified;
        let manager = Arc::new(LocalDirectoryManager {
            sources: Mutex::new(HashMap::from([("fixture".into(), Arc::clone(&source))])),
            budget,
            scans: Arc::new(Semaphore::new(limit("scan_workers").unwrap())),
            queries: Arc::new(Semaphore::new(limit("query_workers").unwrap())),
            updates: Arc::new(Semaphore::new(limit("query_workers").unwrap())),
        });
        std::fs::create_dir_all(root_path.join("incoming/child")).unwrap();
        source
            .observe(Ok(
                Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To))).add_path(root_path.join("incoming"))
            ))
            .unwrap();
        manager.tick().unwrap();
        let _updates = tokio::time::timeout(
            Duration::from_secs(10),
            Arc::clone(&manager.updates).acquire_many_owned(u32::try_from(limit("query_workers").unwrap()).unwrap()),
        )
        .await
        .unwrap()
        .unwrap();
        let after = reader.search("stable incoming", 3, false, &cancelled, false).unwrap();
        assert_eq!(after.directory_count, 3);
        assert_eq!(after.total_matches, 3);
        assert_eq!(after.last_verified_at_ms, before.last_verified_at_ms);
        assert_eq!(lock(&source.status).unwrap().verified, verified);
        assert_eq!(
            lock(&source.writer).unwrap().as_ref().unwrap().accepted_generation().unwrap(),
            accepted
        );
        assert!(!source.busy.load(Ordering::Acquire));
        assert!(!source.flush_busy.load(Ordering::Acquire));
        assert!(lock(&source.observations).unwrap().producers.is_empty());
        assert_eq!(manager.scans.available_permits(), limit("scan_workers").unwrap());
        assert_eq!(lock(&manager.budget.state).unwrap().reserved, 0);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn cold_initialization_is_shared_and_warm_search_does_not_scan() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("alpha")).unwrap();
        std::fs::create_dir(root.join(".hidden")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let started = Instant::now();
        let cold = manager.search("fixture".into(), root.clone(), "".into(), false).await.unwrap();
        assert_eq!(cold.total_matches, 0);
        assert_eq!(cold.search_contract_version, Some(SEARCH_CONTRACT_VERSION));
        assert!(started.elapsed() < Duration::from_secs(1));
        let source = Arc::clone(manager.sources.lock().unwrap().get("fixture").unwrap());
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let finished = source.finished.notified();
                tokio::pin!(finished);
                finished.as_mut().enable();
                if !source.busy.load(Ordering::Acquire) {
                    break;
                }
                finished.await;
            }
        })
        .await
        .unwrap();
        let warm = manager.search("fixture".into(), root.clone(), "alpha".into(), false).await.unwrap();
        assert_eq!(warm.results, vec!["alpha"]);
        assert_eq!(warm.directory_count, 2);
        assert_eq!(warm.coverage.as_deref(), Some("complete"));
        assert_eq!(warm.search_contract_version, Some(SEARCH_CONTRACT_VERSION));
        assert_eq!(
            serde_json::to_value(&warm).unwrap()["search_contract_version"],
            SEARCH_CONTRACT_VERSION
        );
        let progress = source.status.lock().unwrap().progress;
        manager.search("fixture".into(), root, "hidden alpha".into(), true).await.unwrap();
        assert_eq!(source.status.lock().unwrap().progress, progress);
        assert_eq!(manager.sources.lock().unwrap().len(), 1);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn replaced_root_keeps_index_and_rebinds_the_same_source() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("old")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let old = LocalSource::new(root.clone(), &manager.budget.namespace);
        old.scan(&manager.budget).unwrap();
        let opens_before = old.io.opens();
        assert!(opens_before > 0);
        manager.sources.lock().unwrap().insert("fixture".into(), Arc::clone(&old));
        std::fs::rename(&root, temporary.path().join("old-root")).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("new")).unwrap();
        assert!(manager.search("fixture".into(), root.clone(), "old".into(), false).await.is_err());
        assert!(!old.stopped.load(Ordering::Acquire));
        let new = Arc::clone(manager.sources.lock().unwrap().get("fixture").unwrap());
        assert!(Arc::ptr_eq(&new, &old));
        assert_eq!(new.index_path, old.index_path);
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let finished = new.finished.notified();
                tokio::pin!(finished);
                finished.as_mut().enable();
                if !new.busy.load(Ordering::Acquire) {
                    break;
                }
                finished.await;
            }
        })
        .await
        .unwrap();
        let response = manager.search("fixture".into(), root, "old new".into(), false).await.unwrap();
        assert_eq!(response.results, ["new"]);
        assert!(Arc::ptr_eq(&new.io, &old.io));
        assert!(new.io.opens() > opens_before);
    }
}
