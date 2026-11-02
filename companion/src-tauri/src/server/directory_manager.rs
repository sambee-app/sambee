//! Shared local catalogues, native observations, and worker ownership independent of HTTP requests.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use notify::{
    event::{CreateKind, ModifyKind, RemoveKind, RenameMode},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

use super::directory_index::{
    acquire_storage, epoch_milliseconds, search_terms, validate_directory_path, DirectoryIndex, DirectoryIndexReader, DirectoryMutation,
    IndexError, SourceKind, APPLICATION_ID, ROW_BATCH_SIZE, SCHEMA_VERSION, SQL_BUSY_TIMEOUT,
};
use super::directory_traversal::{NativeIdentity, NativeRoot};
use super::models::DirectorySearchResult;

const CONTRACT_JSON: &str = include_str!("../../../../shared/directory-index/contract.json");
const STALLED_READ_TIMEOUT: Duration = Duration::from_secs(30);
const FAILURE_RETRY_MIN: Duration = Duration::from_secs(30);
const FAILURE_RETRY_MAX: Duration = Duration::from_secs(300);
const FAILURE_RETRY_JITTER_PERCENT: u8 = 10;
const PERIODIC_VERIFICATION_JITTER_PERCENT: u8 = 10;
const DEFAULT_RESULT_LIMIT: usize = 50;
pub(super) const MAX_WIRE_INTEGER: i64 = 9_007_199_254_740_991;
const POLICY_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Contract {
    version: u32,
    limits: HashMap<String, i64>,
    policy: HashMap<String, PolicyField>,
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
    if contract.version != POLICY_VERSION {
        return Err(IndexError::Invalid(
            "Unsupported directory policy contract. Reinstall the companion.",
        ));
    }
    Ok(contract)
}

fn limit(name: &str) -> Result<usize, IndexError> {
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
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NOFOLLOW)?;
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
        let _lease = acquire_storage(path)?;
        if !path.try_exists()? {
            return Ok(false);
        }
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW)?;
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
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut filename = path.as_os_str().to_os_string();
            filename.push(suffix);
            match std::fs::remove_file(Path::new(&filename)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(true)
    }

    fn cleanup_inactive(&self, policy: &DirectoryPolicy, reserved: u64, pressure: bool, now_ms: i64) -> Result<usize, IndexError> {
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
        let pressure = bytes
            .checked_add(state.reserved)
            .and_then(|bytes| bytes.checked_add(headroom))
            .ok_or(IndexError::Invalid("Directory disk accounting overflowed."))?
            > u64::try_from(state.policy.disk_budget_bytes).map_err(|_| IndexError::Invalid("Invalid disk budget."))?
            || state
                .reserved
                .checked_add(headroom)
                .ok_or(IndexError::Invalid("Directory disk accounting overflowed."))?
                > (self.space_probe)(&self.namespace)?;
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
        }
        let required = bytes
            .checked_add(state.reserved)
            .and_then(|bytes| bytes.checked_add(headroom))
            .ok_or(IndexError::Invalid("Directory disk reservation overflowed."))?;
        if required > u64::try_from(state.policy.disk_budget_bytes).map_err(|_| IndexError::Invalid("Directory disk policy is invalid."))? {
            return Err(IndexError::StoragePaused("Directory-index disk headroom is unavailable. Increase the companion disk budget or remove eligible inactive indexes, then retry."));
        }
        if state
            .reserved
            .checked_add(headroom)
            .ok_or(IndexError::Invalid("Directory disk reservation overflowed."))?
            > (self.space_probe)(&self.namespace)?
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
    sequence: u64,
    next_producer: u64,
    producers: HashMap<u64, ObservationToken>,
    barriers: Vec<(u64, String)>,
    barrier_bytes: usize,
    uncertain: bool,
    pending: VecDeque<(u64, DirectoryMutation, usize)>,
    bytes: usize,
    verification_required: bool,
}

impl Observations {
    fn invalidate(&mut self) -> Result<(), IndexError> {
        self.epoch = self.epoch.checked_add(1).ok_or(IndexError::Invalid(
            "Directory observation epoch is exhausted. Restart the companion.",
        ))?;
        self.barriers.clear();
        self.barrier_bytes = 0;
        self.uncertain = true;
        self.verification_required = true;
        Ok(())
    }

    fn begin_read(&mut self) -> Result<ObservationToken, IndexError> {
        if self.producers.len() >= limit("max_pending_observations")? || self.next_producer == u64::MAX {
            self.invalidate()?;
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

    fn end_read(&mut self, token: ObservationToken) {
        if self.producers.get(&token.producer) == Some(&token) {
            self.producers.remove(&token.producer);
            self.retire_barriers();
        }
    }

    fn retire_barriers(&mut self) {
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
        self.uncertain = true;
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
}

impl SourceStatus {
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
    session: String,
    root: Mutex<Option<Arc<NativeRoot>>>,
    writer: Mutex<Option<DirectoryIndex>>,
    reader: Mutex<Option<DirectoryIndexReader>>,
    observations: Mutex<Observations>,
    status: Mutex<SourceStatus>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    busy: AtomicBool,
    flush_busy: AtomicBool,
    cleanup_pending: AtomicBool,
    reclamation_pending: AtomicBool,
    active_queries: AtomicUsize,
    stopped: AtomicBool,
    root_invalid: AtomicBool,
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
        drop(writer);
        Ok(())
    }

    fn ensure_available(&self) -> Result<(), IndexError> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(IndexError::Invalid(
                "Directory source was replaced or stopped. Retry the search on the current drive.",
            ));
        }
        Ok(())
    }

    fn new(root_path: PathBuf, namespace: &Path) -> Arc<Self> {
        let session = uuid::Uuid::new_v4().to_string();
        let verification_jitter = Sha256::digest(session.as_bytes())[0];
        let filename = format!("{:x}.sqlite3", Sha256::digest(session.as_bytes()));
        let now = Instant::now();
        Arc::new(Self {
            root_path,
            index_path: namespace.join(filename),
            session,
            root: Mutex::new(None),
            writer: Mutex::new(None),
            reader: Mutex::new(None),
            watcher: Mutex::new(None),
            observations: Mutex::new(Observations::default()),
            status: Mutex::new(SourceStatus {
                state: "building",
                message: None,
                progress: now,
                verified: now,
                accessed: now,
                accessed_at_ms: None,
                retry_at: now,
                failure_delay: Duration::ZERO,
                verification_jitter,
                stalled: false,
            }),
            busy: AtomicBool::new(false),
            flush_busy: AtomicBool::new(false),
            cleanup_pending: AtomicBool::new(true),
            reclamation_pending: AtomicBool::new(false),
            active_queries: AtomicUsize::new(0),
            stopped: AtomicBool::new(false),
            root_invalid: AtomicBool::new(false),
            finished: Notify::new(),
        })
    }

    fn progress(&self) -> Result<(), IndexError> {
        lock(&self.status)?.progress = Instant::now();
        Ok(())
    }

    fn fail(&self, error: &IndexError, _budget: &DiskBudget) {
        if matches!(error, IndexError::StoragePaused(_)) {
            self.reclamation_pending.store(true, Ordering::Release);
        }
        let message = match error {
            IndexError::Invalid(message) | IndexError::StoragePaused(message) => (*message).to_owned(),
            _ => "Directory verification failed. Check drive access and private local storage, then retry.".to_owned(),
        };
        if let Ok(mut status) = self.status.lock() {
            status.state = "ready";
            status.message = Some(message);
            status.schedule_retry(Instant::now(), Sha256::digest(self.session.as_bytes())[0]);
        }
    }

    fn invalidate(&self) -> Result<(), IndexError> {
        lock(&self.observations)?.invalidate()
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
            return self.invalidate();
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
            EventKind::Modify(ModifyKind::Name(_)) => {
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

    fn start_watcher(self: &Arc<Self>) -> Result<(), IndexError> {
        let weak = Arc::downgrade(self);
        let mut watcher = notify::recommended_watcher(move |event| {
            if let Some(source) = weak.upgrade() {
                if source.observe(event).is_err() {
                    let _ = source.invalidate();
                    log::warn!("Directory observations were lost. Background verification is required.");
                }
            }
        })
        .map_err(|_| IndexError::Invalid("Directory watcher is unavailable. Background verification is required."))?;
        watcher
            .watch(&self.root_path, RecursiveMode::Recursive)
            .map_err(|_| IndexError::Invalid("Directory watcher could not start. Background verification is required."))?;
        *lock(&self.watcher)? = Some(watcher);
        Ok(())
    }

    fn cleanup_retired_work(&self, budget: &Arc<DiskBudget>) -> Result<(), IndexError> {
        let slice_ms =
            u64::try_from(limit("status_publication_ms")?).map_err(|_| IndexError::Invalid("Invalid directory worker time slice."))?;
        let deadline = Instant::now() + Duration::from_millis(slice_ms);
        while self.cleanup_pending.load(Ordering::Acquire) && Instant::now() < deadline {
            if self.stopped.load(Ordering::Acquire) || self.busy.load(Ordering::Acquire) || self.active_queries.load(Ordering::Acquire) != 0
            {
                break;
            }
            let observations = lock(&self.observations)?;
            if observations.uncertain || !observations.pending.is_empty() {
                break;
            }
            let mut writer = lock(&self.writer)?;
            let Some(writer) = writer.as_mut() else {
                break;
            };
            if writer.needs_fts_repair() {
                break;
            }
            if writer.reconciliation_generation()?.is_some() {
                break;
            }
            let _reservation = budget.reserve()?;
            self.cleanup_pending.store(writer.cleanup_retired_batch()?, Ordering::Release);
        }
        Ok(())
    }

    fn flush(&self, budget: &Arc<DiskBudget>) -> Result<(), IndexError> {
        let mut observations = lock(&self.observations)?;
        if !observations.uncertain
            && observations.pending.is_empty()
            && !self.cleanup_pending.load(Ordering::Acquire)
            && !self.reclamation_pending.load(Ordering::Acquire)
        {
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
            observations.bytes -= *bytes;
            observations.pending.pop_front();
        }
        observations.retire_barriers();
        let reconciliation_pending = writer.reconciliation_generation()?.is_some();
        if !reconciliation_pending
            && observations.pending.is_empty()
            && !self.busy.load(Ordering::Acquire)
            && self.active_queries.load(Ordering::Acquire) == 0
            && self.cleanup_pending.load(Ordering::Acquire)
        {
            self.cleanup_pending.store(writer.cleanup_retired_batch()?, Ordering::Release);
        }
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
        drop(_reservation);
        drop(writer_guard);
        drop(observations);
        self.cleanup_retired_work(budget)?;
        Ok(())
    }

    fn commit_children(
        &self,
        root: &NativeRoot,
        parent: &str,
        parent_identity: NativeIdentity,
        scan: ScanGeneration,
        children: &[(String, bool)],
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        root.verify_parent(parent, parent_identity)?;
        let observations = lock(&self.observations)?;
        if !observations.is_current(scan.read, parent) || self.stopped.load(Ordering::Acquire) {
            return Err(IndexError::Interrupted);
        }
        let _reservation = budget.reserve()?;
        let mut writer = lock(&self.writer)?;
        let writer = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
        if writer.accepted_generation()? == Some(scan.id) {
            writer.write_reconciliation_children(scan.id, parent, children.iter().cloned())?;
        } else {
            writer.write_scan_children(scan.id, children.iter().cloned())?;
        }
        Ok(())
    }

    fn prune_missing_children(
        &self,
        root: &NativeRoot,
        parent: &str,
        parent_identity: NativeIdentity,
        scan: ScanGeneration,
        budget: &Arc<DiskBudget>,
    ) -> Result<(), IndexError> {
        let prefix = if parent.is_empty() { String::new() } else { format!("{parent}/") };
        let mut cursor: Option<String> = None;
        loop {
            self.progress()?;
            root.verify_parent(parent, parent_identity)?;
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
                if !root.has_directory_child(parent, parent_identity, name)? {
                    loop {
                        self.progress()?;
                        root.verify_parent(parent, parent_identity)?;
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
        if !observations.is_current(baseline, "") || !observations.pending.is_empty() || self.stopped.load(Ordering::Acquire) {
            return Err(IndexError::Interrupted);
        }
        let _reservation = budget.reserve()?;
        let complete = lock(&self.writer)?
            .as_mut()
            .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
            .finish_generation(generation, 0)?;
        let mut status = lock(&self.status)?;
        status.state = "ready";
        status.complete_pass(Instant::now());
        if complete {
            self.cleanup_pending.store(true, Ordering::Release);
            observations.verification_required = false;
            status.message = None;
        } else {
            status.message = Some("Directory coverage is incomplete. Some paths cannot be indexed safely.".to_owned());
            observations.verification_required = true;
        }
        Ok(())
    }

    fn scan_parent(self: &Arc<Self>, root: &NativeRoot, generation: i64, parent: &str, budget: &Arc<DiskBudget>) -> Result<(), IndexError> {
        let read = self.begin_read()?;
        let parent_identity = root.parent_identity(parent)?;
        let mut batch = Vec::with_capacity(ROW_BATCH_SIZE);
        let mut bytes = 0;
        self.progress()?;
        root.children(parent, |entry| {
            self.progress()?;
            if self.stopped.load(Ordering::Acquire) || !lock(&self.observations)?.is_current(read.token, parent) {
                return Err(IndexError::Interrupted);
            }
            match entry {
                Ok(Some((name, descend))) => {
                    let path = if parent.is_empty() { name } else { format!("{parent}/{name}") };
                    validate_directory_path(&path)?;
                    if path.len() > limit("max_observation_bytes")? {
                        return Err(IndexError::Invalid(
                            "Directory path exceeds the scan-batch byte limit. Source coverage is incomplete.",
                        ));
                    }
                    if !batch.is_empty() && (batch.len() == ROW_BATCH_SIZE || bytes + path.len() > limit("max_observation_bytes")?) {
                        self.commit_children(
                            root,
                            parent,
                            parent_identity,
                            ScanGeneration {
                                id: generation,
                                read: read.token,
                            },
                            &batch,
                            budget,
                        )?;
                        batch.clear();
                        bytes = 0;
                    }
                    bytes += path.len();
                    batch.push((path, descend));
                }
                Ok(None) => {}
                Err(issue) => {
                    root.verify_parent(parent, parent_identity)?;
                    let observations = lock(&self.observations)?;
                    if !observations.is_current(read.token, parent) || self.stopped.load(Ordering::Acquire) {
                        return Err(IndexError::Interrupted);
                    }
                    let _reservation = budget.reserve()?;
                    lock(&self.writer)?
                        .as_mut()
                        .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                        .record_issue(generation, issue.code())?;
                }
            }
            Ok(())
        })?;
        if !batch.is_empty() {
            self.commit_children(
                root,
                parent,
                parent_identity,
                ScanGeneration {
                    id: generation,
                    read: read.token,
                },
                &batch,
                budget,
            )?;
        }
        self.prune_missing_children(
            root,
            parent,
            parent_identity,
            ScanGeneration {
                id: generation,
                read: read.token,
            },
            budget,
        )?;
        root.verify_parent(parent, parent_identity)?;
        let observations = lock(&self.observations)?;
        if self.stopped.load(Ordering::Acquire) || !observations.is_current(read.token, parent) {
            return Err(IndexError::Interrupted);
        }
        let _reservation = budget.reserve()?;
        let mut writer = lock(&self.writer)?;
        let writer = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
        if writer.accepted_generation()? == Some(generation) {
            writer.finish_reconciliation_parent(generation, parent)?;
        } else {
            writer.finish_scan_parent(generation, parent)?;
        }
        Ok(())
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
            let Some(generation) = lock(&self.writer)?
                .as_ref()
                .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                .reconciliation_generation()?
            else {
                return Ok(());
            };
            let root = lock(&self.root)?
                .clone()
                .ok_or(IndexError::Invalid("Directory root is unavailable. Request source verification."))?;
            root.verify()?;
            let baseline = self.begin_read()?;
            loop {
                if self.stopped.load(Ordering::Acquire) || !lock(&self.observations)?.is_current(baseline.token, "") {
                    return Err(IndexError::Interrupted);
                }
                let parents = lock(&self.writer)?
                    .as_ref()
                    .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                    .pending_scan_paths(generation, 1)?;
                let Some(parent) = parents.first() else {
                    break;
                };
                self.scan_parent(&root, generation, parent, budget)?;
            }
            root.verify()?;
            let observations = lock(&self.observations)?;
            if self.stopped.load(Ordering::Acquire) || !observations.is_current(baseline.token, "") {
                return Err(IndexError::Interrupted);
            }
            Ok(())
        })();
        if outcome.is_err() {
            self.invalidate()?;
        }
        outcome
    }

    fn scan(self: &Arc<Self>, budget: &Arc<DiskBudget>) -> Result<(), IndexError> {
        self.progress()?;
        let root = match lock(&self.root)?.clone() {
            Some(root) => {
                root.verify()?;
                root
            }
            None => Arc::new(NativeRoot::open(&self.root_path)?),
        };
        if lock(&self.writer)?.is_none() {
            let _reservation = budget.reserve()?;
            let mut index = DirectoryIndex::open(
                &self.index_path,
                SourceKind::Local,
                &json!({"platform": std::env::consts::OS, "root_identity": root.identity, "session": self.session}),
            )?;
            let _policy_gate = lock(&budget.policy_gate)?;
            index.configure_page_cache(budget.policy()?.page_cache_kib)?;
            *lock(&self.reader)? = Some(index.reader());
            *lock(&self.writer)? = Some(index);
            *lock(&self.root)? = Some(Arc::clone(&root));
            if let Err(error) = self.start_watcher() {
                self.invalidate()?;
                self.fail(&error, budget);
            }
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
        let (epoch, generation, selected) = {
            let observations = lock(&self.observations)?;
            if !observations.is_current(baseline.token, "") {
                return Err(IndexError::Interrupted);
            }
            let _reservation = budget.reserve()?;
            let mut writer = lock(&self.writer)?;
            let index = writer.as_mut().ok_or(IndexError::Invalid("Directory writer is unavailable."))?;
            let (generation, selected) = index.prepare_scan()?;
            index.seed_scan(generation)?;
            (observations.epoch, generation, selected)
        };
        let outcome = (|| {
            loop {
                if self.stopped.load(Ordering::Acquire) || lock(&self.observations)?.epoch != epoch {
                    return Err(IndexError::Interrupted);
                }
                let parents = lock(&self.writer)?
                    .as_ref()
                    .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                    .pending_scan_paths(generation, 1)?;
                let Some(parent) = parents.first() else {
                    break;
                };
                self.scan_parent(&root, generation, parent, budget)?;
            }
            self.accept_generation(&root, baseline.token, generation, budget)
        })();
        if outcome.is_err() {
            self.invalidate()?;
            if !selected {
                lock(&self.writer)?
                    .as_mut()
                    .ok_or(IndexError::Invalid("Directory writer is unavailable."))?
                    .discard_generation(generation)?;
                self.cleanup_pending.store(true, Ordering::Release);
            }
        }
        outcome
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
    }
}

struct UpdateOwnership {
    source: Arc<LocalSource>,
    _permit: OwnedSemaphorePermit,
}

impl Drop for UpdateOwnership {
    fn drop(&mut self) {
        self.source.flush_busy.store(false, Ordering::Release);
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

impl LocalDirectoryManager {
    pub(super) fn storage_directory(&self) -> &Path {
        &self.budget.namespace
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
            interval.tick().await;
            loop {
                interval.tick().await;
                let Some(manager) = weak.upgrade() else {
                    break;
                };
                if manager.tick().is_err() {
                    log::warn!("Directory maintenance paused. Check private local storage.");
                }
            }
        });
        Ok(manager)
    }

    fn start_scan(self: &Arc<Self>, source: &Arc<LocalSource>) -> Result<(), IndexError> {
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
            status.state = if lock(&source.reader)?.is_some() { "updating" } else { "building" };
            status.stalled = false;
        }
        source.progress()?;
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
                let outcome = task_source.scan(&task_budget);
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
                    .lock()
                    .map(|status| status.accessed.elapsed() >= Duration::from_secs(limit("idle_release_seconds").unwrap_or(600) as u64))
                    .unwrap_or(false);
                if expired
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
            let stalled = {
                let status = lock(&source.status)?;
                source.busy.load(Ordering::Acquire) && !status.stalled && status.progress.elapsed() >= STALLED_READ_TIMEOUT
            };
            if stalled {
                source.invalidate()?;
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
                            let result = task_source.flush(&budget).and_then(|()| task_source.reconcile(&budget, &scans));
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
            let required = lock(&source.observations)?.verification_required;
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
            if due {
                self.start_scan(&source)?;
            }
        }
        Ok(())
    }

    pub async fn search(
        self: &Arc<Self>,
        drive: String,
        root: PathBuf,
        query: String,
        include_dot: bool,
    ) -> Result<DirectorySearchResult, IndexError> {
        search_terms(&query)?;
        let source = {
            let mut sources = lock(&self.sources)?;
            if let Some(previous) = sources.get(&drive) {
                if previous.root_path != root {
                    previous.stopped.store(true, Ordering::Release);
                    sources.remove(&drive);
                }
            }
            Arc::clone(
                sources
                    .entry(drive.clone())
                    .or_insert_with(|| LocalSource::new(root, &self.budget.namespace)),
            )
        };
        {
            let mut status = lock(&source.status)?;
            status.accessed = Instant::now();
            status.accessed_at_ms = Some(epoch_milliseconds()?);
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
                match_ranks: HashMap::new(),
                matched_term_counts: HashMap::new(),
                accepted_revision: Some(0),
                coverage: Some("partial".into()),
                coverage_issue_count: 0,
                last_verified_at_ms: None,
                status_message: status.message.clone(),
            });
        };
        let permit = Arc::clone(&self.queries)
            .try_acquire_owned()
            .map_err(|_| IndexError::Invalid("Directory query workers are busy. Wait briefly and retry."))?;
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
            task_source.ensure_available()?;
            let root = lock(&task_source.root)?
                .as_ref()
                .ok_or(IndexError::Invalid("Directory source identity is unavailable."))?
                .clone();
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
            Ok(response)
        })
        .await
        .map_err(|_| IndexError::Invalid("Directory query worker failed. Retry the search."))?;
        if source.root_invalid.swap(false, Ordering::AcqRel) {
            source.stopped.store(true, Ordering::Release);
            source.invalidate()?;
            let mut sources = lock(&self.sources)?;
            if sources.get(&drive).is_some_and(|current| Arc::ptr_eq(current, &source)) {
                sources.remove(&drive);
            }
        }
        let result = result?;
        source.ensure_available()?;
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
            accepted_revision: Some(result.accepted_revision),
            coverage: Some(result.coverage),
            coverage_issue_count: wire_count(result.issue_count)?,
            last_verified_at_ms: result.last_verified_at_ms,
            status_message: status.message.clone(),
        })
    }

    fn start_scan_if_cold(self: &Arc<Self>, source: &Arc<LocalSource>) -> Result<(), IndexError> {
        if lock(&source.reader)?.is_none() && Instant::now() >= lock(&source.status)?.retry_at {
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
    use super::*;

    #[tokio::test]
    async fn repeated_scan_requests_respect_resource_retry_deadline() {
        let temporary = tempfile::tempdir().unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("cache")).unwrap();
        for initialized in [false, true] {
            let source = LocalSource::new(temporary.path().join(format!("root-{initialized}")), manager.storage_directory());
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
        source.cleanup_pending.store(false, Ordering::Release);
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
    fn query_ownership_defers_retired_cleanup_until_actual_exit() {
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        let source = LocalSource::new(temporary.path().join("root"), &namespace);
        let mut index = DirectoryIndex::open(&source.index_path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index
            .write_paths((0..ROW_BATCH_SIZE * 2).map(|number| format!("old/{number}")), None)
            .unwrap();
        index.finish_generation(1, 0).unwrap();
        let candidate = index.begin_verification().unwrap();
        index.write_paths(["selected".to_owned()], Some(candidate)).unwrap();
        index.finish_generation(candidate, 0).unwrap();
        let reader = index.reader();
        *source.writer.lock().unwrap() = Some(index);
        let mut budget = Arc::new(DiskBudget {
            namespace,
            policy_gate: Mutex::new(()),
            state: Mutex::new(DiskState {
                policy: DirectoryPolicy::defaults().unwrap(),
                reserved: 0,
                next_cleanup_at: Instant::now(),
            }),
            space_probe: available_disk_bytes,
        });
        for number in 0..ROW_BATCH_SIZE + 1 {
            assert!(lock(&source.observations)
                .unwrap()
                .enqueue(
                    DirectoryMutation::Add {
                        path: format!("foreground/{number}")
                    },
                    limit("max_pending_observations").unwrap(),
                    limit("max_observation_bytes").unwrap(),
                )
                .unwrap());
        }
        source.reclamation_pending.store(true, Ordering::Release);
        source.flush(&budget).unwrap();
        assert_eq!(lock(&source.observations).unwrap().pending.len(), 1);
        assert!(source.cleanup_pending.load(Ordering::Acquire));
        assert!(source.reclamation_pending.load(Ordering::Acquire));
        let semaphore = Arc::new(Semaphore::new(1));
        source.active_queries.fetch_add(1, Ordering::AcqRel);
        let ownership = QueryOwnership {
            source: Arc::clone(&source),
            _permit: semaphore.try_acquire_owned().unwrap(),
        };
        let pressure = IndexError::StoragePaused("Test disk pressure.");
        source.fail(&pressure, &budget);
        source.fail(&pressure, &budget);
        source.flush(&budget).unwrap();
        assert!(source.cleanup_pending.load(Ordering::Acquire));
        assert!(source.reclamation_pending.load(Ordering::Acquire));
        assert_eq!(source.active_queries.load(Ordering::Acquire), 1);
        assert!(lock(&source.observations).unwrap().pending.is_empty());
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = reader.search("selected foreground", 3, false, &cancelled, false).unwrap();
        assert_eq!(before.directory_count, ROW_BATCH_SIZE as i64 + 2);
        source.busy.store(true, Ordering::Release);
        drop(ownership);
        source.flush(&budget).unwrap();
        assert!(source.cleanup_pending.load(Ordering::Acquire));
        assert!(source.reclamation_pending.load(Ordering::Acquire));
        source.busy.store(false, Ordering::Release);
        source.flush(&budget).unwrap();
        assert!(source.cleanup_pending.load(Ordering::Acquire));
        assert!(source.reclamation_pending.load(Ordering::Acquire));
        {
            let mut writer = lock(&source.writer).unwrap();
            let writer = writer.as_mut().unwrap();
            assert_eq!(writer.reconciliation_generation().unwrap(), Some(candidate));
            while let Some(parent) = writer.pending_scan_paths(candidate, 1).unwrap().into_iter().next() {
                writer.finish_reconciliation_parent(candidate, &parent).unwrap();
            }
        }
        Arc::get_mut(&mut budget).unwrap().space_probe = |_| Ok(0);
        assert!(matches!(source.flush(&budget), Err(IndexError::StoragePaused(_))));
        assert!(source.cleanup_pending.load(Ordering::Acquire));
        assert!(source.reclamation_pending.load(Ordering::Acquire));
        assert_eq!(lock(&budget.state).unwrap().reserved, 0);
        assert_eq!(reader.search("selected foreground", 3, false, &cancelled, false).unwrap(), before);
        Arc::get_mut(&mut budget).unwrap().space_probe = available_disk_bytes;
        source.flush(&budget).unwrap();
        assert!(!source.cleanup_pending.load(Ordering::Acquire));
        assert!(!source.reclamation_pending.load(Ordering::Acquire));
        assert_eq!(source.active_queries.load(Ordering::Acquire), 0);
        assert_eq!(reader.search("selected foreground", 3, false, &cancelled, false).unwrap(), before);
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

    #[cfg(target_os = "linux")]
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
        source.scan(&budget).unwrap();
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
            let candidate = index.begin_verification().unwrap();
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
            assert_eq!(response.total_matches, 1);
            assert_eq!(response.directory_count, 1);
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
            assert_eq!(after.coverage, "uncertain");
            assert!(lock(&source.observations).unwrap().verification_required);
            assert!(lock(&source.observations).unwrap().producers.is_empty());
            assert_eq!(scans.available_permits(), 1);
            assert!(!source.busy.load(Ordering::Acquire));
            assert_eq!(lock(&budget.state).unwrap().reserved, 0);
            let writer = lock(&source.writer).unwrap();
            let writer = writer.as_ref().unwrap();
            assert_eq!(writer.accepted_generation().unwrap(), Some(1));
            assert!(writer.reconciliation_generation().unwrap().is_none());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn late_scan_batches_and_candidate_selection_cannot_restore_deleted_rows() {
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
        let generation = index.begin_verification().unwrap();
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
            1
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
        lock(&source.watcher).unwrap().take();
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
            Some(1)
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
        let progress = source.status.lock().unwrap().progress;
        manager.search("fixture".into(), root, "hidden alpha".into(), true).await.unwrap();
        assert_eq!(source.status.lock().unwrap().progress, progress);
        assert_eq!(manager.sources.lock().unwrap().len(), 1);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn replaced_root_retires_old_results_and_rebinds_a_new_source() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("old")).unwrap();
        let manager = LocalDirectoryManager::new(temporary.path().join("private")).unwrap();
        let old = LocalSource::new(root.clone(), &manager.budget.namespace);
        old.scan(&manager.budget).unwrap();
        manager.sources.lock().unwrap().insert("fixture".into(), Arc::clone(&old));
        std::fs::rename(&root, temporary.path().join("old-root")).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("new")).unwrap();
        assert!(manager.search("fixture".into(), root.clone(), "old".into(), false).await.is_err());
        assert!(manager.sources.lock().unwrap().is_empty());
        assert!(old.stopped.load(Ordering::Acquire));
        let cold = manager.search("fixture".into(), root, "new".into(), false).await.unwrap();
        assert!(cold.results.is_empty());
        let new = Arc::clone(manager.sources.lock().unwrap().get("fixture").unwrap());
        assert_ne!(new.session, old.session);
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
    }
}
