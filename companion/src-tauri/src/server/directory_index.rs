//! Disk-backed directory storage. Managers own source binding, private storage, and worker admission.

use std::cmp::Reverse;
use std::collections::{BTreeSet, BinaryHeap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const APPLICATION_ID: i64 = 1396853073;
pub const SCHEMA_VERSION: i64 = 5;
pub const NORMALIZATION_VERSION: i64 = 1;
pub const TRAVERSAL_VERSION: i64 = 1;
pub const MAX_QUERY_BYTES: usize = 4096;
pub const MAX_QUERY_TERMS: usize = 32;
pub const MAX_RESULT_LIMIT: usize = 200;
pub const ROW_BATCH_SIZE: usize = 256;
pub const SCAN_BATCH_BYTES: usize = 1_048_576;
pub(super) type ScanParentResult = (String, Vec<(String, bool)>);
pub(super) const ITEM_ISSUE_CODES: [&str; 4] = ["access_denied", "unsupported_encoding", "unsafe_traversal", "scan_failed"];
pub(super) type ScanParentIssues = HashMap<String, HashMap<&'static str, usize>>;

pub(super) struct ScanCommitOptions<'a> {
    pub reconcile: bool,
    pub issues: Option<&'a ScanParentIssues>,
}
pub(super) type PendingScanJob = (String, Option<Vec<u8>>);
pub const MAINTENANCE_PAGE_BATCH: i64 = 256;
pub const CHECKPOINT_WAL_BYTES: u64 = 1_048_576;
const INCREMENTAL_VACUUM_MODE: i64 = 2;
pub const PAGE_CACHE_KIB: i64 = 2048;
pub const SQL_BUSY_TIMEOUT: Duration = Duration::from_millis(250);
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(10);
pub const SQL_PROGRESS_STEPS: i32 = 1000;
pub const MIN_SQLITE_VERSION_NUMBER: i32 = 3_051_003;
pub const SCHEMA: &str = include_str!("../../../../shared/directory-index/schema.sql");
const FTS_SCHEMA: &str = include_str!("../../../../shared/directory-index/fts.sql");
const GENERATION_VALIDATION: &str = include_str!("../../../../shared/directory-index/validate-generations.sql");
const SCAN_FILE_ID_UPDATE_SQL: &str = "file_id = ?3, processed = CASE WHEN scan_queue.file_id IS NOT NULL AND scan_queue.file_id <> ?3 THEN 0 ELSE scan_queue.processed END WHERE ?3 IS NOT NULL AND scan_queue.file_id IS NOT ?3";
pub const UNICODE_CONTRACT: &str = include_str!("../../../../shared/directory-index/unicode.json");
#[cfg(unix)]
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
#[cfg(unix)]
const PRIVATE_FILE_MODE: u32 = 0o600;
const LEASE_EXTENSION: &str = ".lease";
const NAMESPACE_LEASE_NAME: &str = ".namespace.lease";
pub(super) const QUARANTINE_FILE_NAME: &str = ".rejected-directory-index";
const STORAGE_FILE_SUFFIXES: [&str; 5] = ["", "-wal", "-shm", "-journal", LEASE_EXTENSION];
const REQUIRED_DIRECTORY_TABLES: [&str; 6] = [
    "source_metadata",
    "generations",
    "directories",
    "scan_queue",
    "coverage_issues",
    "scan_snapshot_children",
];

pub(super) fn acquire_storage(path: &Path) -> Result<File, IndexError> {
    let directory = path.parent().ok_or(IndexError::Invalid(
        "Directory-index path has no parent. Select private local storage.",
    ))?;
    let _namespace_lease = acquire_namespace_lease(directory)?;
    validate_storage_files(path)?;
    acquire_file_lease(&storage_member(path, LEASE_EXTENSION))
}

fn storage_member(path: &Path, suffix: &str) -> PathBuf {
    let mut filename = path.as_os_str().to_owned();
    filename.push(suffix);
    filename.into()
}

pub(super) fn validate_storage_files(path: &Path) -> Result<(), IndexError> {
    for extension in STORAGE_FILE_SUFFIXES {
        let mut filename = path.as_os_str().to_os_string();
        filename.push(extension);
        match fs::symlink_metadata(Path::new(&filename)) {
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                return Err(IndexError::Invalid(
                    "Directory-index files must be regular files without symbolic links. Correct the storage path.",
                ));
            }
            Ok(metadata) => {
                #[cfg(unix)]
                if metadata.nlink() != 1 {
                    return Err(IndexError::Invalid(
                        "Directory-index files must not use hard links. Remove the alias or select new private cache storage, then retry.",
                    ));
                }
                #[cfg(unix)]
                if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o022 != 0 {
                    return Err(IndexError::Invalid("Directory-index files must belong to the current user without public write access. Correct their owner and permissions."));
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::OpenOptionsExt;
                    use windows::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE};

                    let file = OpenOptions::new()
                        .read(true)
                        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
                        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
                        .open(&filename)?;
                    validate_windows_storage_file(&file)?;
                }
                #[cfg(not(unix))]
                let _ = metadata;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn validate_windows_storage_file(file: &File) -> Result<(), IndexError> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT};
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: The file handle and output structure remain live for this call.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information) }
        .map_err(|_| IndexError::Invalid("Directory file identity is unavailable. Select private local storage and retry."))?;
    if information.nNumberOfLinks != 1 || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(IndexError::Invalid(
            "Directory-index files must not use links or redirections. Remove the alias or select private local storage.",
        ));
    }
    Ok(())
}

pub(super) struct StorageDirectory {
    path: PathBuf,
    handle: File,
}

impl StorageDirectory {
    pub(super) fn open(path: &Path) -> Result<Self, IndexError> {
        validate_storage_directory(path)?;
        let directory = Self {
            path: path.to_owned(),
            handle: Self::open_handle(path)?,
        };
        directory.verify()?;
        Ok(directory)
    }

    fn open_handle(path: &Path) -> Result<File, IndexError> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
            };
            options
                .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0);
        }
        Ok(options.open(path)?)
    }

    pub(super) fn verify(&self) -> Result<(), IndexError> {
        validate_storage_directory(&self.path)?;
        #[cfg(unix)]
        {
            let held = self.handle.metadata()?;
            let current = fs::symlink_metadata(&self.path)?;
            if (held.dev(), held.ino()) != (current.dev(), current.ino()) {
                return Err(IndexError::Invalid(
                    "Directory storage changed during cleanup. Restore the private namespace and retry.",
                ));
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::Storage::FileSystem::{FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO};
            let current = Self::open_handle(&self.path)?;
            let mut held_info = FILE_ID_INFO::default();
            let mut current_info = FILE_ID_INFO::default();
            // SAFETY: Both handles and output structures remain live for these calls.
            unsafe {
                GetFileInformationByHandleEx(
                    HANDLE(self.handle.as_raw_handle()),
                    FileIdInfo,
                    std::ptr::from_mut(&mut held_info).cast(),
                    size_of::<FILE_ID_INFO>() as u32,
                )
                .and_then(|()| {
                    GetFileInformationByHandleEx(
                        HANDLE(current.as_raw_handle()),
                        FileIdInfo,
                        std::ptr::from_mut(&mut current_info).cast(),
                        size_of::<FILE_ID_INFO>() as u32,
                    )
                })
            }
            .map_err(|_| IndexError::Invalid("Directory storage identity is unavailable. Select private local storage and retry."))?;
            if (held_info.VolumeSerialNumber, held_info.FileId.Identifier)
                != (current_info.VolumeSerialNumber, current_info.FileId.Identifier)
            {
                return Err(IndexError::Invalid(
                    "Directory storage changed during cleanup. Restore the private namespace and retry.",
                ));
            }
        }
        Ok(())
    }

    fn member(&self, path: &Path) -> Result<std::ffi::CString, IndexError> {
        if path.parent() != Some(self.path.as_path()) {
            return Err(IndexError::Invalid("Directory cleanup target is outside its held namespace."));
        }
        std::ffi::CString::new(
            path.file_name()
                .ok_or(IndexError::Invalid("Directory cleanup target has no file name."))?
                .as_encoded_bytes(),
        )
        .map_err(|_| IndexError::Invalid("Directory cleanup target has an unsupported native name."))
    }

    pub(super) fn remove(&self, path: &Path) -> Result<(), IndexError> {
        self.verify()?;
        let name = self.member(path)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: The directory descriptor and NUL-terminated member name remain live.
            if unsafe { libc::unlinkat(self.handle.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        #[cfg(not(unix))]
        {
            let _ = name;
            fs::remove_file(path)?;
        }
        Ok(())
    }

    fn rename(&self, original: &Path, target: &Path) -> Result<(), IndexError> {
        self.verify()?;
        let original_name = self.member(original)?;
        let target_name = self.member(target)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: Both member names and the held directory descriptor remain live.
            if unsafe {
                libc::renameat(
                    self.handle.as_raw_fd(),
                    original_name.as_ptr(),
                    self.handle.as_raw_fd(),
                    target_name.as_ptr(),
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        #[cfg(not(unix))]
        {
            let _ = (original_name, target_name);
            fs::rename(original, target)?;
        }
        Ok(())
    }
}

fn clear_quarantine_owned(path: &Path) -> Result<bool, IndexError> {
    let directory = StorageDirectory::open(
        path.parent()
            .ok_or(IndexError::Invalid("Directory quarantine has no private parent."))?,
    )?;
    validate_storage_files(path)?;
    let mut removed = false;
    for suffix in STORAGE_FILE_SUFFIXES.into_iter().filter(|suffix| *suffix != LEASE_EXTENSION) {
        match directory.remove(&storage_member(path, suffix)) {
            Ok(()) => removed = true,
            Err(IndexError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(removed)
}

pub(super) fn discard_quarantine(directory: &Path) -> Result<bool, IndexError> {
    let path = directory.join(QUARANTINE_FILE_NAME);
    let mut exists = false;
    for suffix in STORAGE_FILE_SUFFIXES.into_iter().filter(|suffix| *suffix != LEASE_EXTENSION) {
        exists |= storage_member(&path, suffix).try_exists()?;
    }
    if !exists {
        return Ok(false);
    }
    let _namespace_lease = acquire_namespace_lease(directory)?;
    let _lease = acquire_file_lease(&storage_member(&path, LEASE_EXTENSION))?;
    clear_quarantine_owned(&path)
}

fn quarantine_owned(path: &Path, _source_lease: &File) -> Result<(), IndexError> {
    let directory = path
        .parent()
        .ok_or(IndexError::Invalid("Directory-index path has no storage parent."))?;
    let _namespace_lease = acquire_namespace_lease(directory)?;
    let storage_directory = StorageDirectory::open(directory)?;
    let rejected = directory.join(QUARANTINE_FILE_NAME);
    let _lease = acquire_file_lease(&storage_member(&rejected, LEASE_EXTENSION))?;
    validate_storage_files(path)?;
    clear_quarantine_owned(&rejected)?;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for suffix in ["-wal", "-shm", "-journal", ""] {
        let original = storage_member(path, suffix);
        let target = storage_member(&rejected, suffix);
        match storage_directory.rename(&original, &target) {
            Ok(()) => moved.push((original, target)),
            Err(IndexError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                for (original, target) in moved.into_iter().rev() {
                    if storage_directory.rename(&target, &original).is_err() {
                        log::warn!("Directory recovery restore failed. Reconnect after restoring private storage.");
                    }
                }
                return Err(error);
            }
        }
    }
    Ok(())
}

pub(super) fn remove_orphan_lease(path: &Path) -> Result<bool, IndexError> {
    let directory = path
        .parent()
        .ok_or(IndexError::Invalid("Directory-index path has no storage parent."))?;
    let _namespace_lease = acquire_namespace_lease(directory)?;
    let storage_directory = StorageDirectory::open(directory)?;
    let mut lease_path = path.as_os_str().to_owned();
    lease_path.push(LEASE_EXTENSION);
    let lease = acquire_file_lease(Path::new(&lease_path))?;
    for extension in ["", "-wal", "-shm", "-journal"] {
        let mut filename = path.as_os_str().to_owned();
        filename.push(extension);
        match fs::symlink_metadata(Path::new(&filename)) {
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    drop(lease);
    storage_directory.remove(Path::new(&lease_path))?;
    Ok(true)
}

fn validate_storage_directory(directory: &Path) -> Result<(), IndexError> {
    for ancestor in directory.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(IndexError::Invalid(
                    "Directory-index storage must use real directories without symbolic links. Select private local storage.",
                ))
            }
            Ok(metadata) => {
                #[cfg(unix)]
                {
                    let mode = metadata.permissions().mode();
                    let owner = unsafe { libc::geteuid() };
                    if (metadata.uid() != owner && metadata.uid() != 0) || (mode & 0o022 != 0 && mode & 0o1000 == 0) {
                        return Err(IndexError::Invalid(
                            "Directory-index ancestors must have trusted owners and no shared write access without a sticky parent. Correct storage permissions.",
                        ));
                    }
                    if ancestor == directory && (metadata.uid() != owner || mode & 0o077 != 0) {
                        return Err(IndexError::Invalid(
                            "Directory-index storage must belong to the current user with mode 0700. Correct its owner and permissions.",
                        ));
                    }
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
                    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
                        return Err(IndexError::Invalid(
                            "Directory-index storage ancestors must not use redirections. Select private local storage.",
                        ));
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

pub(super) fn open_readonly_directory_database(path: &Path) -> Result<Connection, IndexError> {
    open_directory_database(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
}

pub(super) fn open_directory_database(path: &Path, access: OpenFlags) -> Result<Connection, IndexError> {
    let directory = path
        .parent()
        .ok_or(IndexError::Invalid("Directory database has no private storage parent."))?;
    let guard = StorageDirectory::open(directory)?;
    validate_storage_directory(directory)?;
    validate_storage_files(path)?;
    let before = fs::symlink_metadata(path)?;
    let connection = Connection::open_with_flags(path, access | OpenFlags::SQLITE_OPEN_NOFOLLOW)?;
    guard.verify()?;
    validate_storage_directory(directory)?;
    validate_storage_files(path)?;
    let after = fs::symlink_metadata(path)?;
    #[cfg(unix)]
    if (before.dev(), before.ino()) != (after.dev(), after.ino()) {
        return Err(IndexError::Invalid(
            "Directory database changed during open. Restore private storage and reconnect the source.",
        ));
    }
    #[cfg(not(unix))]
    let _ = (before, after);
    Ok(connection)
}

pub(super) fn acquire_namespace_lease(directory: &Path) -> Result<File, IndexError> {
    validate_storage_directory(directory)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(PRIVATE_DIRECTORY_MODE);
    builder.create(directory)?;
    validate_storage_directory(directory)?;
    acquire_file_lease(&directory.join(NAMESPACE_LEASE_NAME))
}

pub(super) fn acquire_file_lease(path: &Path) -> Result<File, IndexError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    options.mode(PRIVATE_FILE_MODE).custom_flags(libc::O_NOFOLLOW);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE};
        options
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0);
    }
    let lease = options.open(path)?;
    #[cfg(windows)]
    validate_windows_storage_file(&lease)?;
    let metadata = lease.metadata()?;
    if !metadata.is_file() {
        return Err(IndexError::Invalid(
            "Directory-index lease must be a private regular file. Correct its storage path.",
        ));
    }
    #[cfg(unix)]
    if metadata.nlink() != 1 {
        return Err(IndexError::Invalid(
            "Directory-index leases must not use hard links. Remove the alias or select new private cache storage, then retry.",
        ));
    }
    #[cfg(unix)]
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o022 != 0 {
        return Err(IndexError::Invalid(
            "Directory-index lease must belong to the current user without public write access. Correct its owner and permissions.",
        ));
    }
    lease.try_lock().map_err(|error| match error {
        fs::TryLockError::WouldBlock => std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "Another process owns this directory index. Close the other instance and retry.",
        ),
        fs::TryLockError::Error(error) => error,
    })?;
    Ok(lease)
}

#[derive(Deserialize)]
struct UnicodeContract {
    #[serde(deserialize_with = "deserialize_normalization")]
    normalization: HashMap<char, String>,
    whitespace: BTreeSet<char>,
    word_ranges: Vec<(u32, u32)>,
}

fn deserialize_normalization<'de, Deserializer: serde::Deserializer<'de>>(
    deserializer: Deserializer,
) -> Result<HashMap<char, String>, Deserializer::Error> {
    Ok(Vec::<(char, String)>::deserialize(deserializer)?.into_iter().collect())
}

fn unicode_contract() -> &'static UnicodeContract {
    static CONTRACT: OnceLock<UnicodeContract> = OnceLock::new();
    CONTRACT.get_or_init(|| serde_json::from_str(UNICODE_CONTRACT).expect("Embedded search Unicode contract must pass contract tests"))
}

fn is_word_character(character: char) -> bool {
    let codepoint = u32::from(character);
    unicode_contract()
        .word_ranges
        .binary_search_by(|(start, end)| {
            if codepoint < *start {
                std::cmp::Ordering::Greater
            } else if codepoint > *end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("Directory database operation failed. Check local storage and retry: {0}")]
    Sql(rusqlite::Error),
    #[error("Directory database filesystem operation failed. Check local storage and retry: {0}")]
    Io(std::io::Error),
    #[error("Directory item could not be indexed ({0}). Check its name and permissions before the next verification pass.")]
    SourceItem(&'static str),
    #[error("{0}")]
    Invalid(&'static str),
    #[error("{0}")]
    RebuildRequired(&'static str),
    #[error("{0}")]
    StoragePaused(&'static str),
    #[error("Directory query workers are busy. Wait briefly and retry.")]
    QueryBusy,
    #[error("Directory search was cancelled or timed out. Retry the search.")]
    Interrupted,
}

fn sqlite_failure_fields(error: &rusqlite::Error) -> (&'static str, i32) {
    match error {
        rusqlite::Error::SqliteFailure(code, _) => (
            match code.code {
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => "directory_storage_busy",
                rusqlite::ErrorCode::OperationInterrupted => "directory_query_cancelled",
                _ => "directory_transaction_failed",
            },
            code.extended_code,
        ),
        _ => ("directory_transaction_failed", 0),
    }
}

impl From<rusqlite::Error> for IndexError {
    fn from(error: rusqlite::Error) -> Self {
        let (event, code) = sqlite_failure_fields(&error);
        log::debug!("event={event} sqlite_code={code}");
        Self::Sql(error)
    }
}

impl From<std::io::Error> for IndexError {
    fn from(error: std::io::Error) -> Self {
        log::debug!("event=directory_storage_failed os_code={}", error.raw_os_error().unwrap_or(0));
        Self::Io(error)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Smb,
    Local,
}

impl SourceKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Smb => "smb",
            Self::Local => "local",
        }
    }
}

pub fn normalize_search_text(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    for character in value.chars() {
        if let Some(key) = unicode_contract().normalization.get(&character) {
            normalized.push_str(key);
        } else {
            normalized.push(character);
        }
    }
    normalized
}

pub fn search_terms(query: &str) -> Result<Vec<String>, IndexError> {
    if query.len() > MAX_QUERY_BYTES {
        return Err(IndexError::Invalid(
            "Search text exceeds the UTF-8 byte limit. Shorten the search text.",
        ));
    }
    let terms: BTreeSet<_> = query
        .split(|character| unicode_contract().whitespace.contains(&character))
        .map(normalize_search_text)
        .filter(|term| !term.is_empty())
        .collect();
    if terms.len() > MAX_QUERY_TERMS {
        return Err(IndexError::Invalid("Search text has too many distinct terms. Remove some terms."));
    }
    Ok(terms.into_iter().collect())
}

pub fn single_term_rank(basename_key: &str, term: &str) -> i64 {
    if basename_key == term {
        return 0;
    }
    if basename_key.starts_with(term) {
        return 1;
    }
    if basename_key
        .char_indices()
        .any(|(offset, character)| !is_word_character(character) && basename_key[offset + character.len_utf8()..].starts_with(term))
    {
        return 2;
    }
    3
}

pub fn validate_directory_path(path: &str) -> Result<(), IndexError> {
    if path.contains('\0') || path.split('/').any(|part| matches!(part, "" | "." | "..")) {
        return Err(IndexError::Invalid(
            "Directory path must be relative without empty, dot, parent, or NUL components.",
        ));
    }
    Ok(())
}

pub(super) fn epoch_milliseconds() -> Result<i64, IndexError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| IndexError::Invalid("System clock is invalid. Correct the system clock."))?;
    i64::try_from(elapsed.as_millis())
        .map_err(|_| IndexError::Invalid("System clock exceeds the supported timestamp range. Correct the system clock."))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectoryIndexMatch {
    pub path: String,
    pub matched_term_count: usize,
    pub match_rank: i64,
    pub depth: i64,
    pub path_key: String,
}

impl DirectoryIndexMatch {
    fn sort_key(&self) -> (Reverse<usize>, i64, i64, &str, &str) {
        (
            Reverse(self.matched_term_count),
            self.match_rank,
            self.depth,
            &self.path_key,
            &self.path,
        )
    }
}

impl Ord for DirectoryIndexMatch {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.sort_key().cmp(&other.sort_key())
    }
}

impl PartialOrd for DirectoryIndexMatch {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectoryIndexSearch {
    pub results: Vec<DirectoryIndexMatch>,
    pub total_matches: i64,
    pub directory_count: i64,
    pub accepted_revision: i64,
    pub coverage: String,
    pub last_verified_at_ms: Option<i64>,
    pub query_plan: &'static str,
    pub issue_count: i64,
}

pub struct DirectoryIndex {
    path: PathBuf,
    writer: Connection,
    page_cache_kib: i64,
    fts_ready: Arc<AtomicBool>,
    fts_repair_cursor: Option<i64>,
    readers: Arc<Mutex<Vec<PooledReader>>>,
    file_identity: (u64, u64, u64),
    _lease: File,
}

pub enum DirectoryMutation {
    ReadParent { path: String },
    Add { path: String },
    Remove { path: String },
    Rename { path: String, new_path: String },
}

fn checked_sql_size(value: usize) -> Result<i64, IndexError> {
    i64::try_from(value).map_err(|_| IndexError::Invalid("Directory-index size exceeds the supported signed integer range."))
}

impl DirectoryIndex {
    pub(super) fn bind_volume(&mut self, current: &super::drives::VolumeEvidence) -> Result<super::drives::VolumeChange, IndexError> {
        use super::drives::{VolumeChange, VolumeEvidence};
        let transaction = self.writer.transaction()?;
        let identity: String = transaction.query_row("SELECT source_identity FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        let mut identity: serde_json::Value =
            serde_json::from_str(&identity).map_err(|_| IndexError::Invalid("Directory source metadata is invalid."))?;
        let previous = identity
            .get("evidence")
            .cloned()
            .map(serde_json::from_value::<VolumeEvidence>)
            .transpose()
            .map_err(|_| IndexError::Invalid("Directory volume metadata is invalid."))?;
        let change = previous.as_ref().map_or(VolumeChange::Keep, |previous| previous.compare(current));
        if matches!(change, VolumeChange::Index | VolumeChange::Unavailable) {
            return Ok(change);
        }
        if change == VolumeChange::Generation {
            transaction.execute("INSERT INTO generations(state, coverage) VALUES ('building', 'partial')", [])?;
            let generation = transaction.last_insert_rowid();
            transaction.execute(
                "UPDATE source_metadata SET selected_generation = ?, last_verified_at_ms = NULL WHERE id = 1",
                [generation],
            )?;
            transaction.execute("DELETE FROM generations WHERE id <> ?", [generation])?;
            Self::advance_revision(&transaction)?;
        }
        let mut evidence = current.clone();
        if let Some(previous) = previous {
            evidence.retain_available(&previous);
        }
        identity["evidence"] =
            serde_json::to_value(evidence).map_err(|_| IndexError::Invalid("Directory volume metadata cannot be saved."))?;
        transaction.execute(
            "UPDATE source_metadata SET source_identity = ?1 WHERE id = 1 AND source_identity <> ?1",
            [identity.to_string()],
        )?;
        transaction.commit()?;
        Ok(change)
    }

    pub fn open(path: &Path, source_kind: SourceKind, source_identity: &serde_json::Value) -> Result<Self, IndexError> {
        Self::open_with_recovery(path, source_kind, source_identity, None)
    }

    pub(super) fn open_with_recovery(
        path: &Path,
        source_kind: SourceKind,
        source_identity: &serde_json::Value,
        recovery_attempted: Option<&AtomicBool>,
    ) -> Result<Self, IndexError> {
        if rusqlite::version_number() < MIN_SQLITE_VERSION_NUMBER {
            return Err(IndexError::Invalid(
                "Directory indexing requires a patched SQLite runtime. Rebuild the companion from its pinned dependencies.",
            ));
        }
        let absolute_path = std::path::absolute(path)?;
        let path = absolute_path.as_path();
        let lease = acquire_storage(path)?;
        let (writer, fts_ready) = match Self::open_owned(path, source_kind, source_identity) {
            Ok(storage) => storage,
            Err(error) => {
                let rebuildable = match &error {
                    IndexError::RebuildRequired(_) => true,
                    IndexError::Sql(rusqlite::Error::SqliteFailure(code, _)) => {
                        matches!(code.code, rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
                    }
                    _ => false,
                };
                let Some(attempted) = recovery_attempted.filter(|_| rebuildable) else {
                    return Err(error);
                };
                if attempted
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    return Err(IndexError::Invalid(
                        "Directory recovery already failed after replacement. Restore private storage capacity and permissions, then reconnect the drive.",
                    ));
                }
                quarantine_owned(path, &lease)?;
                let storage = Self::open_owned(path, source_kind, source_identity)?;
                log::debug!("event=directory_storage_recovered");
                storage
            }
        };
        log::debug!("event=directory_storage_initialized");
        Ok(Self {
            path: path.to_path_buf(),
            writer,
            page_cache_kib: PAGE_CACHE_KIB,
            fts_ready: Arc::new(AtomicBool::new(fts_ready)),
            fts_repair_cursor: None,
            readers: Arc::new(Mutex::new(Vec::new())),
            file_identity: database_file_identity(path)?,
            _lease: lease,
        })
    }

    fn open_owned(path: &Path, source_kind: SourceKind, source_identity: &serde_json::Value) -> Result<(Connection, bool), IndexError> {
        let directory = StorageDirectory::open(
            path.parent()
                .ok_or(IndexError::Invalid("Directory database has no private parent."))?,
        )?;
        let created = !path.try_exists()?;
        if created {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(PRIVATE_FILE_MODE).custom_flags(libc::O_NOFOLLOW);
            drop(options.open(path)?);
        }
        directory.verify()?;
        let mut writer = open_directory_database(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        writer.busy_timeout(SQL_BUSY_TIMEOUT)?;
        if created {
            writer.execute_batch(SCHEMA)?;
            writer.execute_batch(FTS_SCHEMA)?;
            let now = epoch_milliseconds()?;
            let transaction = writer.transaction()?;
            transaction.execute("INSERT INTO generations(id, state, coverage) VALUES (1, 'building', 'partial')", [])?;
            transaction.execute(
                "INSERT INTO source_metadata(id, source_kind, source_identity, normalization_version, traversal_version, selected_generation, committed_at_ms, last_access_at_ms) VALUES (1, ?, ?, ?, ?, 1, ?, ?)",
                params![source_kind.as_str(), source_identity.to_string(), NORMALIZATION_VERSION, TRAVERSAL_VERSION, now, now],
            )?;
            transaction.commit()?;
        }
        let application_id: i64 = writer.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let schema_version: i64 = writer.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if application_id != APPLICATION_ID {
            return Err(IndexError::Invalid(
                "Directory database application identifier is invalid. Rebuild this source index.",
            ));
        }
        if schema_version != SCHEMA_VERSION {
            return Err(IndexError::RebuildRequired(
                "Directory database schema is unsupported. Rebuild this source index.",
            ));
        }
        for table in REQUIRED_DIRECTORY_TABLES {
            if !writer.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?)",
                [table],
                |row| row.get::<_, bool>(0),
            )? {
                return Err(IndexError::RebuildRequired(
                    "Directory database tables are missing. Rebuild this source index.",
                ));
            }
        }
        let metadata: Option<(String, String, i64, i64)> = writer
            .query_row(
                "SELECT source_kind, source_identity, normalization_version, traversal_version FROM source_metadata WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((kind, identity, normalization, traversal)) = metadata else {
            return Err(IndexError::RebuildRequired(
                "Directory database source metadata is missing. Rebuild this source index.",
            ));
        };
        let mut stored_identity = serde_json::from_str::<serde_json::Value>(&identity).ok();
        if source_kind == SourceKind::Local {
            if let Some(serde_json::Value::Object(identity)) = stored_identity.as_mut() {
                identity.remove("evidence");
            }
        }
        if kind != source_kind.as_str() || stored_identity.as_ref() != Some(source_identity) {
            return Err(IndexError::Invalid(
                "Directory database source or policy does not match. Rebuild this source index.",
            ));
        }
        if normalization != NORMALIZATION_VERSION || traversal != TRAVERSAL_VERSION {
            return Err(IndexError::RebuildRequired(
                "Directory database source or policy does not match. Rebuild this source index.",
            ));
        }
        let file_id_column: Option<(String, bool)> = writer
            .query_row(
                "SELECT type, \"notnull\" FROM pragma_table_info('scan_queue') WHERE name = 'file_id'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if file_id_column != Some(("BLOB".into(), false)) {
            return Err(IndexError::RebuildRequired(
                "Directory scan FileId storage is invalid. Rebuild this source index.",
            ));
        }
        let parent_column: Option<(String, bool)> = writer
            .query_row(
                "SELECT type, \"notnull\" FROM pragma_table_info('directories') WHERE name = 'parent_id'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let parent_index: Option<String> = writer.query_row(
            "SELECT group_concat(name, ',') FROM pragma_index_info('directories_parent')",
            [],
            |row| row.get(0),
        )?;
        if parent_column != Some(("INTEGER".into(), false)) || parent_index.as_deref() != Some("generation_id,parent_id") {
            return Err(IndexError::RebuildRequired(
                "Directory parent storage is invalid. Rebuild this source index.",
            ));
        }
        let marker_column: Option<(String, bool)> = writer
            .query_row(
                "SELECT type, \"notnull\" FROM pragma_table_info('source_metadata') WHERE name = 'clean_shutdown'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if marker_column != Some(("INTEGER".to_owned(), true)) {
            return Err(IndexError::RebuildRequired(
                "Directory shutdown metadata is invalid. Rebuild this source index.",
            ));
        }
        let clean_shutdown: bool = writer.query_row("SELECT clean_shutdown FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        let integrity: String = if clean_shutdown {
            "ok".to_owned()
        } else {
            writer.query_row("PRAGMA quick_check", [], |row| row.get(0))?
        };
        if integrity != "ok" || writer.prepare("PRAGMA foreign_key_check")?.query([])?.next()?.is_some() {
            return Err(IndexError::RebuildRequired(
                "Directory database integrity check failed. Rebuild this source index.",
            ));
        }
        let invalid_metadata: bool = writer.query_row(GENERATION_VALIDATION, [], |row| row.get(0))?;
        if invalid_metadata {
            return Err(IndexError::RebuildRequired(
                "Directory database generation metadata is invalid. Rebuild this source index.",
            ));
        }
        writer.execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA mmap_size = 0; PRAGMA temp_store = FILE;")?;
        let journal_mode: String = writer.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        if journal_mode != "wal" {
            return Err(IndexError::Invalid(
                "Directory-index storage does not support WAL. Select supported private local storage.",
            ));
        }
        writer.pragma_update(None, "cache_size", -PAGE_CACHE_KIB)?;
        let fts_ready = match Self::prepare_fts(&writer, clean_shutdown) {
            Err(IndexError::Sql(rusqlite::Error::SqliteFailure(code, _)))
                if matches!(code.code, rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) =>
            {
                return Err(IndexError::StoragePaused(
                    "Directory search token repair could not start. Validated directory data was retained. Restore private storage and retry the drive.",
                ));
            }
            result => result?,
        };
        let transaction = writer.transaction()?;
        transaction.execute(
            "UPDATE source_metadata SET last_access_at_ms = ?, clean_shutdown = 0 WHERE id = 1",
            [epoch_milliseconds()?],
        )?;
        transaction.commit()?;
        Ok((writer, fts_ready))
    }

    fn prepare_fts(writer: &Connection, clean_shutdown: bool) -> Result<bool, IndexError> {
        let existing_fts: bool = writer.query_row("SELECT count(*) = 5 FROM sqlite_master WHERE name IN ('directory_fts', 'directory_fts_data', 'directory_fts_idx', 'directory_fts_docsize', 'directory_fts_config')", [], |row| row.get(0))?;
        writer.execute_batch(FTS_SCHEMA)?;
        if clean_shutdown && existing_fts {
            return Ok(true);
        }
        match writer.execute("INSERT INTO directory_fts(directory_fts, rank) VALUES ('integrity-check', 1)", []) {
            Ok(_) => Ok(true),
            Err(rusqlite::Error::SqliteFailure(error, _)) if error.code == rusqlite::ErrorCode::DatabaseCorrupt => {
                writer.execute("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all')", [])?;
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn advance_revision(transaction: &rusqlite::Transaction<'_>) -> Result<(), IndexError> {
        let revision: i64 = transaction.query_row("SELECT accepted_revision FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        let next = revision.checked_add(1).ok_or(IndexError::Invalid(
            "Directory-index revision is exhausted. Rebuild this source index.",
        ))?;
        transaction.execute(
            "UPDATE source_metadata SET accepted_revision = ?, committed_at_ms = ? WHERE id = 1",
            params![next, epoch_milliseconds()?],
        )?;
        Ok(())
    }

    pub fn write_paths(&mut self, paths: impl IntoIterator<Item = String>, generation_id: Option<i64>) -> Result<(), IndexError> {
        self.require_fts()?;
        let mut iterator = paths.into_iter();
        let mut pending = None;
        loop {
            let mut batch = Vec::new();
            let mut bytes = 0;
            while batch.len() < ROW_BATCH_SIZE {
                let Some(path) = pending.take().or_else(|| iterator.next()) else {
                    break;
                };
                if path.len() > SCAN_BATCH_BYTES {
                    return Err(IndexError::Invalid(
                        "Directory path exceeds the scan-batch byte limit. Source coverage is incomplete.",
                    ));
                }
                if path.len() > SCAN_BATCH_BYTES - bytes {
                    pending = Some(path);
                    break;
                }
                bytes += path.len();
                batch.push(path);
            }
            if batch.is_empty() {
                return Ok(());
            }
            let transaction = self.writer.transaction()?;
            let selected: i64 =
                transaction.query_row("SELECT selected_generation FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
            let target = generation_id.unwrap_or(selected);
            if generation_id.is_some() {
                Self::require_scan_generation(&transaction, target)?;
            }
            {
                let mut statement = transaction.prepare("INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory, parent_id) VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM directories WHERE generation_id = ? AND path = ?)) ON CONFLICT(generation_id, path) DO NOTHING")?;
                for path in batch {
                    validate_directory_path(&path)?;
                    let depth = i64::try_from(path.bytes().filter(|byte| *byte == b'/').count())
                        .map_err(|_| IndexError::Invalid("Directory depth exceeds the supported range."))?;
                    let dot = path.split('/').any(|part| part.starts_with('.'));
                    statement.execute(params![
                        target,
                        path,
                        normalize_search_text(&path),
                        normalize_search_text(path.rsplit('/').next().unwrap_or(&path)),
                        depth,
                        dot,
                        target,
                        path.rsplit_once('/').map_or("", |(parent, _)| parent),
                    ])?;
                }
            }
            if target == selected {
                Self::advance_revision(&transaction)?;
            }
            transaction.commit()?;
        }
    }

    fn require_scan_generation(transaction: &rusqlite::Transaction<'_>, generation_id: i64) -> Result<(), IndexError> {
        let (state, active): (String, bool) =
            transaction.query_row("SELECT state, scan_active FROM generations WHERE id = ?", [generation_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
        if !matches!(state.as_str(), "building") && !active {
            return Err(IndexError::Invalid(
                "Scan generation is no longer active. Discard this batch and request verification.",
            ));
        }
        Ok(())
    }

    fn require_reconciliation_parent(transaction: &rusqlite::Transaction<'_>, generation_id: i64, parent: &str) -> Result<(), IndexError> {
        let pending: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM generations g JOIN source_metadata m ON m.selected_generation = g.id JOIN scan_queue q ON q.generation_id = g.id WHERE g.id = ? AND g.state = 'accepted' AND g.scan_active = 0 AND q.path = ? AND q.processed = 0)",
            params![generation_id, parent],
            |row| row.get(0),
        )?;
        if !pending {
            return Err(IndexError::Invalid(
                "Reconciliation parent is not pending on the selected generation. Request source verification.",
            ));
        }
        Ok(())
    }

    pub fn seed_scan(&mut self, generation_id: i64) -> Result<(), IndexError> {
        let transaction = self.writer.transaction()?;
        Self::require_scan_generation(&transaction, generation_id)?;
        transaction.execute(
            "INSERT INTO scan_queue(generation_id, path) VALUES (?, '') ON CONFLICT DO NOTHING",
            [generation_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn pending_scan_paths(&self, generation_id: i64, limit: usize) -> Result<Vec<String>, IndexError> {
        self.pending_scan_paths_excluding(generation_id, limit, &[])
    }

    pub(super) fn pending_scan_paths_excluding(
        &self,
        generation_id: i64,
        limit: usize,
        exclude: &[String],
    ) -> Result<Vec<String>, IndexError> {
        if limit == 0 || limit > ROW_BATCH_SIZE {
            return Err(IndexError::Invalid("Scan queue batch limit is unsupported. Use a bounded batch."));
        }
        if exclude.len() > super::directory_manager::limit("scan_bookkeeping_commit_max_parents")?
            || exclude.iter().map(String::len).sum::<usize>() > SCAN_BATCH_BYTES
        {
            return Err(IndexError::Invalid(
                "Buffered scan parents exceed the group limit. Commit the buffered group.",
            ));
        }
        let excluded = serde_json::to_string(exclude)
            .map_err(|_| IndexError::Invalid("Buffered scan parents could not be encoded. Retry source verification."))?;
        let mut statement = self
            .writer
            .prepare("SELECT path FROM scan_queue WHERE generation_id = ? AND processed = 0 AND path NOT IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT ?")?;
        let rows = statement.query_map(params![generation_id, excluded, checked_sql_size(limit)?], |row| {
            row.get::<_, String>(0)
        })?;
        let mut paths = Vec::new();
        let mut bytes = 0;
        for path in rows {
            let path = path?;
            if path.len() > SCAN_BATCH_BYTES {
                return Err(IndexError::Invalid(
                    "Queued directory exceeds the scan-page byte limit. Request source verification.",
                ));
            }
            if bytes + path.len() > SCAN_BATCH_BYTES {
                break;
            }
            bytes += path.len();
            paths.push(path);
        }
        Ok(paths)
    }

    pub(super) fn status(&self) -> Result<DirectoryIndexSearch, IndexError> {
        Ok(self.writer.query_row(
            "SELECT g.indexed_count, m.accepted_revision, g.coverage, m.last_verified_at_ms, g.issue_count \
             FROM source_metadata m JOIN generations g ON g.id = m.selected_generation WHERE m.id = 1",
            [],
            |row| {
                Ok(DirectoryIndexSearch {
                    results: Vec::new(),
                    total_matches: 0,
                    directory_count: row.get(0)?,
                    accepted_revision: row.get(1)?,
                    coverage: row.get(2)?,
                    last_verified_at_ms: row.get(3)?,
                    issue_count: row.get(4)?,
                    query_plan: "empty",
                })
            },
        )?)
    }

    pub(super) fn scan_counts(&self, generation_id: i64) -> Result<(usize, usize, usize), IndexError> {
        let (done, queued, found): (i64, i64, i64) = self.writer.query_row(
            "SELECT (SELECT count(*) FROM scan_queue WHERE generation_id = g.id AND processed = 1), \
             (SELECT count(*) FROM scan_queue WHERE generation_id = g.id AND processed = 0), indexed_count \
             FROM generations g WHERE id = ?",
            [generation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let checked_count =
            |value| usize::try_from(value).map_err(|_| IndexError::Invalid("Directory progress count exceeds the supported range."));
        Ok((checked_count(done)?, checked_count(queued)?, checked_count(found)?))
    }

    #[cfg(test)]
    pub(super) fn scan_parent_pending(&self, generation_id: i64, parent: &str) -> Result<bool, IndexError> {
        Ok(self.writer.query_row(
            "SELECT EXISTS(SELECT 1 FROM scan_queue WHERE generation_id = ? AND path = ? AND processed = 0)",
            params![generation_id, parent],
            |row| row.get(0),
        )?)
    }

    pub(super) fn requeue_completed_scan_batch(&mut self, generation_id: i64) -> Result<bool, IndexError> {
        let transaction = self.writer.transaction()?;
        Self::require_scan_generation(&transaction, generation_id)?;
        let changed = transaction.execute(
            "UPDATE scan_queue SET processed = 0 WHERE rowid IN (SELECT rowid FROM scan_queue WHERE generation_id = ? AND processed = 1 LIMIT ?)",
            params![generation_id, checked_sql_size(ROW_BATCH_SIZE)?],
        )?;
        transaction.commit()?;
        Ok(changed == ROW_BATCH_SIZE)
    }

    pub(super) fn defer_scan_parent(&mut self, generation_id: i64, parent: &str) -> Result<(), IndexError> {
        self.defer_parent(generation_id, parent, false)
    }

    pub(super) fn defer_reconciliation_parent(&mut self, generation_id: i64, parent: &str) -> Result<(), IndexError> {
        self.defer_parent(generation_id, parent, true)
    }

    fn defer_parent(&mut self, generation_id: i64, parent: &str, reconcile: bool) -> Result<(), IndexError> {
        if !parent.is_empty() {
            validate_directory_path(parent)?;
        }
        let transaction = self.writer.transaction()?;
        if reconcile {
            Self::require_reconciliation_parent(&transaction, generation_id, parent)?;
        } else {
            Self::require_scan_generation(&transaction, generation_id)?;
        }
        let file_id: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT file_id FROM scan_queue WHERE generation_id = ? AND path = ?",
                params![generation_id, parent],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        transaction.execute(
            "DELETE FROM scan_queue WHERE generation_id = ? AND path = ?",
            params![generation_id, parent],
        )?;
        transaction.execute(
            "INSERT INTO scan_queue(generation_id, path, file_id) VALUES (?, ?, ?)",
            params![generation_id, parent, file_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn write_scan_children(
        &mut self,
        generation_id: i64,
        children: impl IntoIterator<Item = (String, bool)>,
    ) -> Result<(), IndexError> {
        self.write_children(generation_id, children, None, &HashMap::new())
    }

    pub(super) fn pending_scan_jobs(&self, generation_id: i64, paths: &[String]) -> Result<Vec<PendingScanJob>, IndexError> {
        if paths.len() > ROW_BATCH_SIZE || paths.iter().map(String::len).sum::<usize>() > SCAN_BATCH_BYTES {
            return Err(IndexError::Invalid(
                "Scan work page exceeds its count or byte limit. Split the page.",
            ));
        }
        let paths = serde_json::to_string(paths)
            .map_err(|_| IndexError::Invalid("Scan work page could not be encoded. Retry source verification."))?;
        let mut statement = self.writer.prepare("SELECT path, file_id FROM scan_queue WHERE generation_id = ? AND processed = 0 AND path IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT ?")?;
        let rows = statement.query_map(params![generation_id, paths, checked_sql_size(ROW_BATCH_SIZE)?], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
        rows.collect::<Result<_, _>>().map_err(IndexError::from)
    }

    pub fn scan_parent_file_id(&self, generation_id: i64, parent: &str) -> Result<Option<Vec<u8>>, IndexError> {
        Ok(self
            .writer
            .query_row(
                "SELECT file_id FROM scan_queue WHERE generation_id = ? AND path = ?",
                params![generation_id, parent],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
    }

    pub fn contains_directory(&self, generation_id: i64, path: &str) -> Result<bool, IndexError> {
        validate_directory_path(path)?;
        Ok(self.writer.query_row(
            "SELECT EXISTS(SELECT 1 FROM directories WHERE generation_id = ? AND path = ?)",
            params![generation_id, path],
            |row| row.get(0),
        )?)
    }

    pub fn commit_scan_parents(&mut self, generation_id: i64, results: &[ScanParentResult]) -> Result<(), IndexError> {
        self.commit_scan_parents_with_ids(generation_id, results, &HashMap::new())
    }

    pub fn commit_scan_parents_with_ids(
        &mut self,
        generation_id: i64,
        results: &[ScanParentResult],
        file_ids: &HashMap<String, Vec<u8>>,
    ) -> Result<(), IndexError> {
        self.commit_scan_parent_snapshots(generation_id, results, file_ids, &HashSet::new())
    }

    pub(super) fn scan_parents_have_changes(
        &self,
        generation_id: i64,
        results: &[ScanParentResult],
        partial_parents: &HashSet<String>,
    ) -> Result<bool, IndexError> {
        self.scan_parent_snapshots_have_changes(generation_id, results, partial_parents, &HashSet::new())
    }

    pub(super) fn scan_parent_snapshots_have_changes(
        &self,
        generation_id: i64,
        results: &[ScanParentResult],
        partial_parents: &HashSet<String>,
        streamed_parents: &HashSet<String>,
    ) -> Result<bool, IndexError> {
        let payload = serde_json::to_string(
            &results
                .iter()
                .map(|(parent, children)| {
                    serde_json::json!({
                        "parent": parent,
                        "paths": children.iter().map(|(path, _)| path).collect::<Vec<_>>(),
                        "complete": !partial_parents.contains(parent),
                        "streamed": streamed_parents.contains(parent),
                    })
                })
                .collect::<Vec<_>>(),
        )
        .map_err(|_| IndexError::Invalid("Directory child snapshot could not be encoded. Retry source verification."))?;
        Ok(self.writer.query_row(
            "WITH snapshots AS MATERIALIZED (SELECT json_extract(value, '$.parent') AS parent, json_extract(value, '$.complete') AS complete, json_extract(value, '$.streamed') AS streamed, value AS data FROM json_each(?1)), \
             snapshot_paths AS MATERIALIZED (SELECT snapshots.parent, path.value AS path FROM snapshots CROSS JOIN json_each(snapshots.data, '$.paths') AS path) \
             SELECT EXISTS(SELECT 1 FROM snapshot_paths LEFT JOIN directories AS stored ON stored.generation_id = ?2 AND stored.path = snapshot_paths.path WHERE stored.id IS NULL) \
             OR EXISTS(SELECT 1 FROM snapshots CROSS JOIN directories AS child INDEXED BY directories_parent ON child.generation_id = ?2 \
             AND child.parent_id IS (SELECT id FROM directories WHERE generation_id = ?2 AND path = snapshots.parent) \
             AND ((snapshots.parent = '' AND child.depth = 0) OR child.parent_id IS NOT NULL) \
             LEFT JOIN snapshot_paths AS seen ON seen.parent = snapshots.parent AND seen.path = child.path \
             LEFT JOIN scan_snapshot_children AS staged ON snapshots.streamed = 1 AND staged.generation_id = ?2 AND staged.parent_path = snapshots.parent AND staged.path = child.path \
             WHERE snapshots.complete = 1 AND seen.path IS NULL AND staged.path IS NULL)",
            params![payload, generation_id], |row| row.get(0),
        )?)
    }

    pub fn commit_scan_parent_snapshots(
        &mut self,
        generation_id: i64,
        results: &[ScanParentResult],
        file_ids: &HashMap<String, Vec<u8>>,
        partial_parents: &HashSet<String>,
    ) -> Result<(), IndexError> {
        self.commit_parent_snapshots(generation_id, results, file_ids, partial_parents, &HashSet::new(), false)
    }

    pub(super) fn write_scan_parent_batch(
        &mut self,
        generation_id: i64,
        parent: &str,
        children: &[(String, bool)],
        file_ids: &HashMap<String, Vec<u8>>,
        reset_snapshot: bool,
        reconcile: bool,
    ) -> Result<(), IndexError> {
        if children.len() > ROW_BATCH_SIZE
            || children.iter().map(|(path, _)| path.len()).sum::<usize>() + file_ids.values().map(Vec::len).sum::<usize>()
                > SCAN_BATCH_BYTES
        {
            return Err(IndexError::Invalid(
                "Scan snapshot batch exceeds its count or byte limit. Split it into bounded batches.",
            ));
        }
        self.require_fts()?;
        let transaction = self.writer.transaction()?;
        if reconcile {
            Self::require_reconciliation_parent(&transaction, generation_id, parent)?;
        } else {
            Self::require_scan_generation(&transaction, generation_id)?;
        }
        let pending: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM scan_queue WHERE generation_id = ? AND path = ? AND processed = 0)",
            params![generation_id, parent],
            |row| row.get(0),
        )?;
        if !pending {
            return Err(IndexError::Invalid(
                "Scan snapshot parent is not pending. Request source verification.",
            ));
        }
        if reset_snapshot {
            transaction.execute(
                "DELETE FROM scan_snapshot_children WHERE generation_id = ? AND parent_path = ?",
                params![generation_id, parent],
            )?;
        }
        let mut changed = false;
        for (path, descend) in children {
            validate_directory_path(path)?;
            if path.rsplit_once('/').map_or("", |(parent, _)| parent) != parent {
                return Err(IndexError::Invalid(
                    "Scan child is outside its immediate parent. Request source verification.",
                ));
            }
            changed |= Self::insert_scan_child(
                &transaction,
                generation_id,
                path,
                *descend,
                !reconcile,
                file_ids.get(path).map(Vec::as_slice),
            )?;
            transaction.execute(
                "INSERT INTO scan_snapshot_children(generation_id, parent_path, path) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                params![generation_id, parent, path],
            )?;
        }
        let selected: i64 = transaction.query_row("SELECT selected_generation FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        if changed && selected == generation_id {
            Self::advance_revision(&transaction)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn commit_parent_snapshots(
        &mut self,
        generation_id: i64,
        results: &[ScanParentResult],
        file_ids: &HashMap<String, Vec<u8>>,
        partial_parents: &HashSet<String>,
        streamed_parents: &HashSet<String>,
        reconcile: bool,
    ) -> Result<(), IndexError> {
        self.commit_parent_snapshots_with_issues(
            generation_id,
            results,
            file_ids,
            partial_parents,
            streamed_parents,
            ScanCommitOptions { reconcile, issues: None },
        )
    }

    pub(super) fn commit_parent_snapshots_with_issues(
        &mut self,
        generation_id: i64,
        results: &[ScanParentResult],
        file_ids: &HashMap<String, Vec<u8>>,
        partial_parents: &HashSet<String>,
        streamed_parents: &HashSet<String>,
        options: ScanCommitOptions<'_>,
    ) -> Result<(), IndexError> {
        let reconcile = options.reconcile;
        if results.len() > super::directory_manager::limit("scan_bookkeeping_commit_max_parents")? {
            return Err(IndexError::Invalid(
                "Scan commit exceeds the parent limit. Split it into bounded groups.",
            ));
        }
        if results.len() > super::directory_manager::limit("scan_commit_max_parents")?
            && self.scan_parent_snapshots_have_changes(generation_id, results, partial_parents, streamed_parents)?
        {
            return Err(IndexError::Invalid(
                "Content scan commit exceeds the parent limit. Split it into bounded groups.",
            ));
        }
        self.require_fts()?;
        let transaction = self.writer.transaction()?;
        if !reconcile {
            Self::require_scan_generation(&transaction, generation_id)?;
        }
        let parent_paths: HashSet<&str> = results.iter().map(|(parent, _)| parent.as_str()).collect();
        let mut counts: HashMap<&str, i64> = HashMap::new();
        for (parent, issues) in options.issues.into_iter().flatten() {
            if !parent_paths.contains(parent.as_str()) {
                return Err(IndexError::Invalid(
                    "Scan issues belong to a parent outside this commit. Include its completed snapshot.",
                ));
            }
            for (code, count) in issues {
                let count = checked_sql_size(*count)?;
                let previous = counts.entry(code).or_default();
                *previous = previous.checked_add(count).ok_or(IndexError::Invalid(
                    "Directory coverage issue count is exhausted. Restart verification.",
                ))?;
                if count == 0 {
                    return Err(IndexError::Invalid("Directory coverage issue count must be positive."));
                }
            }
        }
        let mut changed = !counts.is_empty();
        if changed {
            Self::record_issue_counts(&transaction, generation_id, &counts)?;
        }
        for (parent, children) in results {
            if reconcile {
                Self::require_reconciliation_parent(&transaction, generation_id, parent)?;
            }
            if !parent.is_empty() {
                validate_directory_path(parent)?;
            }
            for (path, descend) in children {
                validate_directory_path(path)?;
                if path.rsplit_once('/').map_or("", |(parent, _)| parent) != parent {
                    return Err(IndexError::Invalid(
                        "Scan child is outside its immediate parent. Request source verification.",
                    ));
                }
                changed |= Self::insert_scan_child(
                    &transaction,
                    generation_id,
                    path,
                    *descend,
                    !reconcile,
                    file_ids.get(path).map(Vec::as_slice),
                )?;
            }
            if !partial_parents.contains(parent) {
                let parent_id: Option<i64> = transaction
                    .query_row(
                        "SELECT id FROM directories WHERE generation_id = ? AND path = ?",
                        params![generation_id, parent],
                        |row| row.get(0),
                    )
                    .optional()?;
                if parent.is_empty() || parent_id.is_some() {
                    let paths = serde_json::to_string(&children.iter().map(|(path, _)| path).collect::<Vec<_>>())
                        .map_err(|_| IndexError::Invalid("Directory child snapshot could not be encoded. Retry source verification."))?;
                    changed |= transaction.execute(
                        "DELETE FROM directories WHERE generation_id = ? AND parent_id IS ? AND (? <> '' OR depth = 0) AND path NOT IN (SELECT value FROM json_each(?)) AND (? = 0 OR path NOT IN (SELECT path FROM scan_snapshot_children WHERE generation_id = ? AND parent_path = ?))",
                        params![generation_id, parent_id, parent, paths, streamed_parents.contains(parent), generation_id, parent],
                    )? != 0;
                }
            }
            transaction.execute(
                "DELETE FROM scan_snapshot_children WHERE generation_id = ? AND parent_path = ?",
                params![generation_id, parent],
            )?;
            transaction.execute(
                "UPDATE scan_queue SET processed = 1 WHERE generation_id = ? AND path = ?",
                params![generation_id, parent],
            )?;
        }
        let selected: i64 = transaction.query_row("SELECT selected_generation FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        if changed && selected == generation_id {
            Self::advance_revision(&transaction)?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn insert_scan_child(
        transaction: &Connection,
        generation_id: i64,
        path: &str,
        descend: bool,
        queue_existing: bool,
        file_id: Option<&[u8]>,
    ) -> Result<bool, IndexError> {
        if file_id.is_some_and(|value| ![size_of::<u64>(), size_of::<u128>()].contains(&value.len())) {
            return Err(IndexError::Invalid(
                "Directory FileId must contain 8 or 16 bytes. Retry source verification.",
            ));
        }
        let inserted = transaction.execute(
            "INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory, parent_id) VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM directories WHERE generation_id = ? AND path = ?)) ON CONFLICT(generation_id, path) DO NOTHING",
            params![generation_id, path, normalize_search_text(path), normalize_search_text(path.rsplit('/').next().unwrap_or(path)), checked_sql_size(path.bytes().filter(|byte| *byte == b'/').count())?, path.split('/').any(|part| part.starts_with('.')), generation_id, path.rsplit_once('/').map_or("", |(parent, _)| parent)],
        )?;
        if inserted != 0 {
            transaction.execute(
                "UPDATE directories SET parent_id = (SELECT id FROM directories WHERE generation_id = ? AND path = ?) WHERE generation_id = ? AND parent_id IS NULL AND depth = ? AND path >= ? AND path < ?",
                params![generation_id, path, generation_id, checked_sql_size(path.bytes().filter(|byte| *byte == b'/').count() + 1)?, format!("{path}/"), format!("{path}0")],
            )?;
        }
        if descend {
            let sql = if queue_existing || inserted != 0 {
                format!("INSERT INTO scan_queue(generation_id, path, file_id) VALUES (?1, ?2, ?3) ON CONFLICT(generation_id, path) DO UPDATE SET {SCAN_FILE_ID_UPDATE_SQL}")
            } else {
                format!("UPDATE scan_queue SET {SCAN_FILE_ID_UPDATE_SQL} AND generation_id = ?1 AND path = ?2")
            };
            transaction.execute(&sql, params![generation_id, path, file_id])?;
        }
        Ok(inserted != 0)
    }

    pub fn queue_reconciliation_parent(&mut self, generation_id: i64, parent: &str) -> Result<(), IndexError> {
        if !parent.is_empty() {
            validate_directory_path(parent)?;
        }
        let transaction = self.writer.transaction()?;
        let accepted: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM generations g JOIN source_metadata m ON m.selected_generation = g.id WHERE g.id = ? AND g.state = 'accepted' AND g.scan_active = 0)",
            [generation_id],
            |row| row.get(0),
        )?;
        if !accepted {
            return Err(IndexError::Invalid(
                "Reconciliation generation is no longer selected. Request source verification.",
            ));
        }
        transaction.execute(
            "INSERT INTO scan_queue(generation_id, path) VALUES (?, ?) ON CONFLICT(generation_id, path) DO UPDATE SET processed = 0",
            params![generation_id, parent],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn finish_reconciliation_parent(&mut self, generation_id: i64, parent: &str) -> Result<(), IndexError> {
        let transaction = self.writer.transaction()?;
        Self::require_reconciliation_parent(&transaction, generation_id, parent)?;
        transaction.execute(
            "UPDATE scan_queue SET processed = 1 WHERE generation_id = ? AND path = ?",
            params![generation_id, parent],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn write_reconciliation_children(
        &mut self,
        generation_id: i64,
        parent: &str,
        children: impl IntoIterator<Item = (String, bool)>,
    ) -> Result<(), IndexError> {
        if !parent.is_empty() {
            validate_directory_path(parent)?;
        }
        self.write_children(generation_id, children, Some(parent), &HashMap::new())
    }

    pub(super) fn write_children(
        &mut self,
        generation_id: i64,
        children: impl IntoIterator<Item = (String, bool)>,
        reconciliation_parent: Option<&str>,
        file_ids: &HashMap<String, Vec<u8>>,
    ) -> Result<(), IndexError> {
        self.require_fts()?;
        let mut batch = Vec::new();
        let mut batch_bytes = 0;
        for child in children.into_iter().take(ROW_BATCH_SIZE + 1) {
            if reconciliation_parent.is_some() {
                if child.0.len() > SCAN_BATCH_BYTES - batch_bytes {
                    return Err(IndexError::Invalid(
                        "Reconciliation children exceed the scan-batch byte limit. Split them into bounded batches.",
                    ));
                }
                batch_bytes += child.0.len();
            }
            batch.push(child);
        }
        if batch.len() > ROW_BATCH_SIZE {
            return Err(IndexError::Invalid(
                "Scan children exceed the batch limit. Split them into bounded batches.",
            ));
        }
        let transaction = self.writer.transaction()?;
        let prefix = if let Some(parent) = reconciliation_parent {
            Self::require_reconciliation_parent(&transaction, generation_id, parent)?;
            if parent.is_empty() {
                String::new()
            } else {
                format!("{parent}/")
            }
        } else {
            Self::require_scan_generation(&transaction, generation_id)?;
            String::new()
        };
        let mut changed = false;
        for (path, descend) in batch {
            validate_directory_path(&path)?;
            if reconciliation_parent.is_some()
                && !path
                    .strip_prefix(&prefix)
                    .is_some_and(|child| !child.is_empty() && !child.contains('/'))
            {
                return Err(IndexError::Invalid(
                    "Reconciliation child is outside its immediate parent. Request source verification.",
                ));
            }
            changed |= Self::insert_scan_child(
                &transaction,
                generation_id,
                &path,
                descend,
                reconciliation_parent.is_none(),
                file_ids.get(&path).map(Vec::as_slice),
            )?;
        }
        let selected: i64 = transaction.query_row("SELECT selected_generation FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        if generation_id == selected && changed {
            Self::advance_revision(&transaction)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn direct_child_paths(
        &self,
        generation_id: i64,
        parent: &str,
        after_path: Option<&str>,
        maximum_bytes: usize,
    ) -> Result<Vec<String>, IndexError> {
        if !parent.is_empty() {
            validate_directory_path(parent)?;
        }
        if let Some(cursor) = after_path {
            validate_directory_path(cursor)?;
            if cursor.rsplit_once('/').map_or("", |(parent, _)| parent) != parent {
                return Err(IndexError::Invalid("Child-page cursor must belong to the requested parent."));
            }
        }
        if maximum_bytes == 0 || maximum_bytes > SCAN_BATCH_BYTES {
            return Err(IndexError::Invalid(
                "Child-page byte budget is outside the supported scan-batch range.",
            ));
        }
        let prefix = if parent.is_empty() { String::new() } else { format!("{parent}/") };
        let lower = after_path.unwrap_or(&prefix).max(&prefix);
        let upper = (!parent.is_empty()).then(|| format!("{parent}0"));
        let mut statement = self.writer.prepare(if upper.is_some() {
            "SELECT path FROM directories WHERE generation_id = ?1 AND path >= ?2 AND path < ?3 ORDER BY path"
        } else {
            "SELECT path FROM directories WHERE generation_id = ?1 AND path >= ?2 ORDER BY path"
        })?;
        let mut rows = if let Some(upper) = upper.as_ref() {
            statement.query(params![generation_id, lower, upper])?
        } else {
            statement.query(params![generation_id, lower])?
        };
        let mut result = BTreeSet::new();
        let mut bytes = 0;
        let mut overflow: Option<String> = None;
        let mut frontier: Option<String> = None;
        while let Some(row) = rows.next()? {
            let stored_path: String = row.get(0)?;
            if frontier.as_ref().is_some_and(|boundary| &stored_path >= boundary) {
                break;
            }
            let suffix = &stored_path[prefix.len()..];
            let path = format!("{prefix}{}", suffix.split('/').next().unwrap_or(suffix));
            if after_path.is_some_and(|after| path.as_str() <= after)
                || overflow.as_ref().is_some_and(|excluded| &path >= excluded)
                || result.contains(&path)
            {
                continue;
            }
            bytes += path.len();
            result.insert(path);
            while result.len() > ROW_BATCH_SIZE || bytes > maximum_bytes {
                let excluded = result
                    .pop_last()
                    .ok_or(IndexError::Invalid("Directory child-page accounting is invalid."))?;
                bytes -= excluded.len();
                overflow = Some(excluded);
            }
            let ceiling = overflow
                .as_ref()
                .or_else(|| if result.len() == ROW_BATCH_SIZE { result.last() } else { None });
            if let Some(ceiling) = ceiling {
                let name = &ceiling[prefix.len()..];
                let cut = name
                    .char_indices()
                    .find_map(|(offset, character)| (offset > 0 && character < '/').then_some(offset))
                    .unwrap_or(name.len());
                frontier = Some(format!("{prefix}{}0", &name[..cut]));
            }
        }
        if result.len() < ROW_BATCH_SIZE && overflow.is_some_and(|excluded| excluded.len() > maximum_bytes) {
            return Err(IndexError::Invalid(
                "Directory child exceeds the scan-page byte budget. Source coverage is incomplete.",
            ));
        }
        Ok(result.into_iter().collect())
    }

    pub fn prune_subtree_batch(&mut self, generation_id: i64, path: &str) -> Result<bool, IndexError> {
        validate_directory_path(path)?;
        self.require_fts()?;
        let prefix = format!("{path}/");
        let transaction = self.writer.transaction()?;
        let state: Option<String> = transaction
            .query_row("SELECT state FROM generations WHERE id = ?", [generation_id], |row| row.get(0))
            .optional()?;
        if !matches!(state.as_deref(), Some("building" | "accepted")) {
            return Err(IndexError::Invalid(
                "Reconciliation generation is no longer active. Discard this observation and request verification.",
            ));
        }
        let removed = transaction.execute(
            "DELETE FROM directories WHERE id IN (SELECT id FROM directories WHERE generation_id = ? AND (path = ? OR substr(path, 1, length(?)) = ?) ORDER BY path DESC LIMIT ?)",
            params![generation_id, path, prefix, prefix, checked_sql_size(ROW_BATCH_SIZE)?],
        )?;
        let queued = transaction.execute(
            "DELETE FROM scan_queue WHERE generation_id = ? AND path IN (SELECT path FROM scan_queue WHERE generation_id = ? AND (path = ? OR substr(path, 1, length(?)) = ?) ORDER BY path LIMIT ?)",
            params![generation_id, generation_id, path, prefix, prefix, checked_sql_size(ROW_BATCH_SIZE)?],
        )?;
        let selected: i64 = transaction.query_row("SELECT selected_generation FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        if (removed != 0 || queued != 0) && generation_id == selected {
            Self::advance_revision(&transaction)?;
        }
        let remains = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM directories WHERE generation_id = ? AND (path = ? OR substr(path, 1, length(?)) = ?)) OR EXISTS(SELECT 1 FROM scan_queue WHERE generation_id = ? AND (path = ? OR substr(path, 1, length(?)) = ?))",
            params![generation_id, path, prefix, prefix, generation_id, path, prefix, prefix], |row| row.get(0),
        )?;
        transaction.commit()?;
        Ok(remains)
    }

    pub fn finish_scan_parent(&mut self, generation_id: i64, path: &str) -> Result<(), IndexError> {
        if !path.is_empty() {
            validate_directory_path(path)?;
        }
        let transaction = self.writer.transaction()?;
        Self::require_scan_generation(&transaction, generation_id)?;
        transaction.execute(
            "UPDATE scan_queue SET processed = 1 WHERE generation_id = ? AND path = ?",
            params![generation_id, path],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(super) fn page_cache_target_kib(&self) -> i64 {
        self.page_cache_kib
    }

    pub fn touch_access(&mut self, accessed_at_ms: i64) -> Result<(), IndexError> {
        if accessed_at_ms < 0 {
            return Err(IndexError::Invalid(
                "Directory-index access time is invalid. Check the host clock and retry.",
            ));
        }
        self.writer
            .execute("UPDATE source_metadata SET last_access_at_ms = ? WHERE id = 1", [accessed_at_ms])?;
        Ok(())
    }

    pub fn checkpoint_due(&self) -> Result<bool, IndexError> {
        let mut wal = self.path.as_os_str().to_owned();
        wal.push("-wal");
        let metadata = match fs::symlink_metadata(PathBuf::from(wal)) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        if !metadata.is_file() {
            return Err(IndexError::Invalid(
                "Directory-index WAL must be a regular file. Correct private cache storage and retry.",
            ));
        }
        Ok(metadata.len() >= CHECKPOINT_WAL_BYTES)
    }

    pub fn checkpoint_if_due(&self) -> Result<bool, IndexError> {
        if !self.checkpoint_due()? {
            return Ok(true);
        }
        let (busy, total, completed): (i64, i64, i64) = self.writer.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        if busy != 0 || total != completed {
            log::debug!("event=directory_checkpoint_deferred busy={busy} total={total} completed={completed}");
            return Ok(false);
        }
        let (busy, total, completed): (i64, i64, i64) = self.writer.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
        log::debug!("event=directory_checkpoint_completed busy={busy} total={total} completed={completed}");
        Ok(busy == 0 && total == completed)
    }

    pub fn reclaim_pages(&mut self) -> Result<bool, IndexError> {
        let vacuum: i64 = self.writer.query_row("PRAGMA auto_vacuum", [], |row| row.get(0))?;
        if vacuum != INCREMENTAL_VACUUM_MODE {
            return Err(IndexError::Invalid(
                "Directory storage does not support incremental reclamation. Rebuild this source index.",
            ));
        }
        let free: i64 = self.writer.query_row("PRAGMA freelist_count", [], |row| row.get(0))?;
        if free == 0 {
            return Ok(true);
        }
        let checkpoint = |connection: &Connection, command: &str| -> Result<bool, IndexError> {
            let (busy, total, completed): (i64, i64, i64) =
                connection.query_row(command, [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            Ok(busy == 0 && total == completed)
        };
        if !checkpoint(&self.writer, "PRAGMA wal_checkpoint(PASSIVE)")? {
            return Ok(false);
        }
        let mut statement = self
            .writer
            .prepare(&format!("PRAGMA incremental_vacuum({MAINTENANCE_PAGE_BATCH})"))?;
        let mut pages = statement.query([])?;
        while pages.next()?.is_some() {}
        drop(pages);
        drop(statement);
        log::debug!("event=directory_pages_reclaimed");
        checkpoint(&self.writer, "PRAGMA wal_checkpoint(TRUNCATE)")
    }

    pub fn mutate_path(&mut self, mutation: &DirectoryMutation) -> Result<(), IndexError> {
        self.apply_mutation(mutation, false)
    }

    pub fn mutate_observed_path(&mut self, mutation: &DirectoryMutation) -> Result<(), IndexError> {
        self.apply_mutation(mutation, true)
    }

    pub fn accepted_generation(&self) -> Result<Option<i64>, IndexError> {
        Ok(self
            .writer
            .query_row(
                "SELECT g.id FROM generations g JOIN source_metadata m ON m.selected_generation = g.id WHERE g.state = 'accepted' AND g.scan_active = 0",
                [],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub(super) fn mutation_generations(&self) -> Result<Vec<i64>, IndexError> {
        let mut statement = self
            .writer
            .prepare("SELECT id FROM generations WHERE state IN ('building', 'accepted')")?;
        let rows = statement.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub(super) fn mutation_subtree_paths(&self, generation: i64, path: &str, after: Option<&str>) -> Result<Vec<String>, IndexError> {
        validate_directory_path(path)?;
        let prefix = format!("{path}/");
        let upper = format!("{path}0");
        let mut statement = self.writer.prepare(
            "SELECT path FROM directories WHERE generation_id = ?1 AND path >= ?2 AND path < ?3 AND (?4 IS NULL OR path > ?4) ORDER BY path LIMIT ?5",
        )?;
        let lower = after.unwrap_or(&prefix).max(&prefix);
        let mut rows = statement.query(params![generation, lower, upper, after, checked_sql_size(ROW_BATCH_SIZE)?])?;
        let mut paths = Vec::new();
        let mut bytes = 0;
        while let Some(row) = rows.next()? {
            let child: String = row.get(0)?;
            if child.len() > SCAN_BATCH_BYTES {
                return Err(IndexError::Invalid("Directory mutation path exceeds the scan-batch byte limit."));
            }
            if child.len() > SCAN_BATCH_BYTES - bytes {
                break;
            }
            bytes += child.len();
            paths.push(child);
        }
        Ok(paths)
    }

    pub fn reconciliation_generation(&self) -> Result<Option<i64>, IndexError> {
        Ok(self.writer.query_row(
            "SELECT g.id FROM generations g JOIN source_metadata m ON m.selected_generation = g.id WHERE g.state = 'accepted' AND g.scan_active = 0 AND EXISTS(SELECT 1 FROM scan_queue q WHERE q.generation_id = g.id AND q.processed = 0)",
            [],
            |row| row.get(0),
        ).optional()?)
    }

    fn apply_mutation(&mut self, mutation: &DirectoryMutation, reconcile: bool) -> Result<(), IndexError> {
        self.require_fts()?;
        let path = match mutation {
            DirectoryMutation::Add { path }
            | DirectoryMutation::Remove { path }
            | DirectoryMutation::Rename { path, .. }
            | DirectoryMutation::ReadParent { path } => path,
        };
        if !matches!(mutation, DirectoryMutation::ReadParent { .. }) || !path.is_empty() {
            validate_directory_path(path)?;
        }
        if let DirectoryMutation::Rename { new_path, .. } = mutation {
            validate_directory_path(new_path)?;
            if new_path == path {
                return Ok(());
            }
            if new_path.starts_with(&format!("{path}/")) {
                return Err(IndexError::Invalid("A directory cannot be renamed into its own subtree."));
            }
        }
        let transaction = self.writer.transaction()?;
        match mutation {
            DirectoryMutation::ReadParent { path } => {
                transaction.execute(
                    "INSERT INTO scan_queue(generation_id, path) SELECT id, ? FROM generations WHERE state = 'building' OR scan_active = 1 ON CONFLICT(generation_id, path) DO UPDATE SET processed = 0",
                    [path],
                )?;
            }
            DirectoryMutation::Add { path } => {
                transaction.execute("INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory, parent_id) SELECT g.id, ?, ?, ?, ?, ?, (SELECT id FROM directories WHERE generation_id = g.id AND path = ?) FROM generations g WHERE state IN ('building', 'accepted') ON CONFLICT(generation_id, path) DO NOTHING", params![path, normalize_search_text(path), normalize_search_text(path.rsplit('/').next().unwrap_or(path)), checked_sql_size(path.bytes().filter(|byte| *byte == b'/').count())?, path.split('/').any(|part| part.starts_with('.')), path.rsplit_once('/').map_or("", |(parent, _)| parent)])?;
                transaction.execute(
                    "INSERT INTO scan_queue(generation_id, path) SELECT id, ? FROM generations WHERE state = 'building' OR scan_active = 1 ON CONFLICT(generation_id, path) DO UPDATE SET processed = 0",
                    [path],
                )?;
            }
            DirectoryMutation::Remove { path } => {
                let prefix = format!("{path}/");
                transaction.execute("DELETE FROM directories WHERE generation_id IN (SELECT id FROM generations WHERE state IN ('building', 'accepted')) AND (path = ? OR substr(path, 1, length(?)) = ?)", params![path, prefix, prefix])?;
                transaction.execute("DELETE FROM scan_queue WHERE generation_id IN (SELECT id FROM generations WHERE state IN ('building', 'accepted')) AND (path = ? OR substr(path, 1, length(?)) = ?)", params![path, prefix, prefix])?;
            }
            DirectoryMutation::Rename { path, new_path } => {
                let prefix = format!("{path}/");
                let mut last_id: Option<i64> = None;
                loop {
                    let batch: Vec<(i64, String)> = {
                        let mut statement = transaction.prepare("SELECT id, path FROM directories WHERE (? IS NULL OR id > ?) AND generation_id IN (SELECT id FROM generations WHERE state IN ('building', 'accepted')) AND (path = ? OR substr(path, 1, length(?)) = ?) ORDER BY id LIMIT ?")?;
                        let rows = statement.query_map(
                            params![last_id, last_id, path, prefix, prefix, checked_sql_size(ROW_BATCH_SIZE)?],
                            |row| Ok((row.get(0)?, row.get(1)?)),
                        )?;
                        rows.collect::<Result<Vec<_>, _>>()?
                    };
                    if batch.is_empty() {
                        break;
                    }
                    for (identifier, original) in batch {
                        last_id = Some(identifier);
                        let renamed = format!("{new_path}{}", &original[path.len()..]);
                        transaction.execute("UPDATE directories SET path = ?, path_key = ?, basename_key = ?, depth = ?, has_dot_directory = ?, parent_id = CASE WHEN ? THEN (SELECT id FROM directories parent WHERE parent.generation_id = directories.generation_id AND parent.path = ?) ELSE parent_id END WHERE id = ?", params![renamed, normalize_search_text(&renamed), normalize_search_text(renamed.rsplit('/').next().unwrap_or(&renamed)), checked_sql_size(renamed.bytes().filter(|byte| *byte == b'/').count())?, renamed.split('/').any(|part| part.starts_with('.')), original == *path, new_path.rsplit_once('/').map_or("", |(parent, _)| parent), identifier])?;
                    }
                }
                transaction.execute("UPDATE scan_queue SET path = ? || substr(path, length(?) + 1), processed = 0 WHERE generation_id IN (SELECT id FROM generations WHERE state IN ('building', 'accepted')) AND (path = ? OR substr(path, 1, length(?)) = ?)", params![new_path, path, path, prefix, prefix])?;
            }
        }
        if reconcile {
            let mut parents = Vec::new();
            match mutation {
                DirectoryMutation::ReadParent { path } => parents.push((path.as_str(), true)),
                DirectoryMutation::Add { path } => {
                    parents.push((path.as_str(), true));
                    parents.push((path.rsplit_once('/').map_or("", |(parent, _)| parent), true));
                }
                DirectoryMutation::Remove { path } => parents.push((path.rsplit_once('/').map_or("", |(parent, _)| parent), true)),
                DirectoryMutation::Rename { path, new_path } => {
                    parents.push((path.rsplit_once('/').map_or("", |(parent, _)| parent), true));
                    parents.push((new_path.rsplit_once('/').map_or("", |(parent, _)| parent), true));
                    parents.push((new_path.as_str(), false));
                }
            }
            for (parent, unconditional) in parents {
                transaction.execute(
                    "INSERT INTO scan_queue(generation_id, path) SELECT g.id, ? FROM generations g JOIN source_metadata m ON m.selected_generation = g.id WHERE g.state = 'accepted' AND (? OR EXISTS(SELECT 1 FROM directories d WHERE d.generation_id = g.id AND d.path = ?)) ON CONFLICT(generation_id, path) DO UPDATE SET processed = 0",
                    params![parent, unconditional, parent],
                )?;
            }
        }
        Self::advance_revision(&transaction)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn prepare_scan(&mut self) -> Result<(i64, bool), IndexError> {
        self.require_fts()?;
        let transaction = self.writer.transaction()?;
        let (generation, state, issues, active): (i64, String, i64, bool) = transaction.query_row(
            "SELECT g.id, g.state, g.issue_count, g.scan_active FROM generations g JOIN source_metadata m ON m.selected_generation = g.id WHERE m.id = 1",
            [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        )?;
        if active || state == "building" {
            if !active {
                transaction.execute(
                    "UPDATE generations SET scan_active = 1, scan_pass_id = scan_pass_id + 1 WHERE id = ?",
                    [generation],
                )?;
            }
            if issues != 0 {
                transaction.execute(
                    "DELETE FROM coverage_issues WHERE generation_id = ? AND code = 'event_loss'",
                    [generation],
                )?;
                transaction.execute(
                    "UPDATE generations SET coverage = 'partial', issue_count = (SELECT coalesce(sum(count), 0) FROM coverage_issues WHERE generation_id = ?) WHERE id = ?",
                    params![generation, generation],
                )?;
                Self::advance_revision(&transaction)?;
            }
            transaction.commit()?;
            return Ok((generation, state == "building"));
        }
        transaction.execute("UPDATE scan_queue SET processed = 0 WHERE generation_id = ?", [generation])?;
        transaction.execute("DELETE FROM coverage_issues WHERE generation_id = ?", [generation])?;
        transaction.execute(
            "UPDATE generations SET scan_active = 1, scan_pass_id = scan_pass_id + 1, coverage = 'partial', issue_count = 0 WHERE id = ?",
            [generation],
        )?;
        Self::advance_revision(&transaction)?;
        transaction.commit()?;
        Ok((generation, false))
    }

    pub(super) fn has_resumable_scan(&self) -> Result<bool, IndexError> {
        Ok(self.writer.query_row(
            "SELECT EXISTS(SELECT 1 FROM generations WHERE scan_active = 1 OR state = 'building')",
            [],
            |row| row.get(0),
        )?)
    }

    pub(super) fn has_pending_scan(&self) -> Result<bool, IndexError> {
        Ok(self.writer.query_row(
            "SELECT EXISTS(SELECT 1 FROM scan_queue q JOIN generations g ON g.id = q.generation_id \
             WHERE q.processed = 0 AND g.state IN ('building', 'accepted'))",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn mark_uncertain(&mut self) -> Result<(), IndexError> {
        let transaction = self.writer.transaction()?;
        let generation: i64 =
            transaction.query_row("SELECT selected_generation FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        transaction.execute("INSERT INTO coverage_issues(generation_id, code, count) VALUES (?, 'event_loss', 1) ON CONFLICT(generation_id, code) DO NOTHING", [generation])?;
        let changed = transaction.execute(
            "UPDATE generations SET coverage = 'uncertain', issue_count = (SELECT sum(count) FROM coverage_issues WHERE generation_id = ?) \
             WHERE id = ? AND (coverage <> 'uncertain' OR issue_count <> (SELECT sum(count) FROM coverage_issues WHERE generation_id = ?))",
            params![generation, generation, generation],
        )?;
        if changed != 0 {
            Self::advance_revision(&transaction)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn record_issue(&mut self, generation: i64, code: &str) -> Result<(), IndexError> {
        let transaction = self.writer.transaction()?;
        Self::record_issue_counts(&transaction, generation, &HashMap::from([(code, 1)]))?;
        let selected: i64 = transaction.query_row("SELECT selected_generation FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
        if selected == generation {
            Self::advance_revision(&transaction)?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn record_issue_counts(transaction: &Connection, generation: i64, counts: &HashMap<&str, i64>) -> Result<(), IndexError> {
        for (code, count) in counts {
            if !ITEM_ISSUE_CODES.contains(code) && !matches!(*code, "identity_unverified" | "event_loss") {
                return Err(IndexError::Invalid("Unsupported directory coverage issue."));
            }
            if *count <= 0 {
                return Err(IndexError::Invalid("Directory coverage issue count must be positive."));
            }
            transaction.execute("INSERT INTO coverage_issues(generation_id, code, count) VALUES (?, ?, ?) ON CONFLICT(generation_id, code) DO UPDATE SET count = count + excluded.count", params![generation, code, count])?;
        }
        transaction.execute("UPDATE generations SET issue_count = (SELECT sum(count) FROM coverage_issues WHERE generation_id = ?), coverage = CASE WHEN coverage = 'uncertain' THEN 'uncertain' ELSE 'partial' END WHERE id = ?", params![generation, generation])?;
        Ok(())
    }

    pub fn finish_generation(&mut self, generation_id: i64, issue_count: i64) -> Result<bool, IndexError> {
        if issue_count < 0 {
            return Err(IndexError::Invalid("Coverage issue count must not be negative."));
        }
        let transaction = self.writer.transaction()?;
        let (state, active): (String, bool) =
            transaction.query_row("SELECT state, scan_active FROM generations WHERE id = ?", [generation_id], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
        if !matches!(state.as_str(), "building") && !active {
            return Err(IndexError::Invalid("Generation is not an active build or verification pass."));
        }
        let stored_issues: i64 = transaction.query_row(
            "SELECT coalesce(sum(count), 0) FROM coverage_issues WHERE generation_id = ?",
            [generation_id],
            |row| row.get(0),
        )?;
        let additional_issues = issue_count.saturating_sub(stored_issues).max(0);
        if additional_issues > 0 {
            transaction.execute("INSERT INTO coverage_issues(generation_id, code, count) VALUES (?, 'scan_failed', ?) ON CONFLICT(generation_id, code) DO UPDATE SET count = count + excluded.count", params![generation_id, additional_issues])?;
        }
        let unresolved = issue_count.max(stored_issues);
        let observation_loss: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM coverage_issues WHERE generation_id = ? AND code = 'event_loss')",
            [generation_id],
            |row| row.get(0),
        )?;
        if observation_loss {
            transaction.execute(
                "UPDATE generations SET issue_count = ?, coverage = CASE WHEN coverage = 'uncertain' THEN 'uncertain' ELSE 'partial' END WHERE id = ?",
                params![unresolved, generation_id],
            )?;
            let selected: i64 =
                transaction.query_row("SELECT selected_generation FROM source_metadata WHERE id = 1", [], |row| row.get(0))?;
            if selected == generation_id {
                Self::advance_revision(&transaction)?;
            }
            transaction.commit()?;
            log::debug!("event=directory_scan_issues issue_count={unresolved}");
            return Ok(false);
        }
        if transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM scan_queue WHERE generation_id = ? AND processed = 0)",
            [generation_id],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(IndexError::Invalid(
                "Scan work remains queued. Complete the scan before selecting this generation.",
            ));
        }
        transaction.execute(
            "UPDATE generations SET state = 'accepted', scan_active = 0, coverage = ?, issue_count = ? WHERE id = ?",
            params![if unresolved > 0 { "partial" } else { "complete" }, unresolved, generation_id],
        )?;
        transaction.execute(
            "UPDATE source_metadata SET selected_generation = ?, last_verified_at_ms = ? WHERE id = 1",
            params![generation_id, epoch_milliseconds()?],
        )?;
        Self::advance_revision(&transaction)?;
        transaction.commit()?;
        log::debug!("event=directory_generation_accepted");
        Ok(true)
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
        include_dot: bool,
        cancelled: &Arc<AtomicBool>,
        force_scan: bool,
    ) -> Result<DirectoryIndexSearch, IndexError> {
        self.reader().search(query, limit, include_dot, cancelled, force_scan)
    }

    pub fn reader(&self) -> DirectoryIndexReader {
        DirectoryIndexReader {
            path: self.path.clone(),
            page_cache_kib: self.page_cache_kib,
            fts_ready: Arc::clone(&self.fts_ready),
            readers: Arc::clone(&self.readers),
            file_identity: self.file_identity,
        }
    }

    pub fn needs_fts_repair(&self) -> bool {
        !self.fts_ready.load(Ordering::Acquire)
    }

    fn require_fts(&self) -> Result<(), IndexError> {
        if self.needs_fts_repair() {
            return Err(IndexError::Invalid(
                "Directory search index is being rebuilt. Existing rows remain searchable; retry updates after repair.",
            ));
        }
        Ok(())
    }

    pub fn repair_fts_batch(&mut self) -> Result<bool, IndexError> {
        if !self.needs_fts_repair() {
            return Ok(false);
        }
        let transaction = self.writer.transaction()?;
        let mut statement = transaction.prepare("SELECT id, path_key FROM directories WHERE ? IS NULL OR id > ? ORDER BY id LIMIT ?")?;
        let rows = statement
            .query_map(
                params![self.fts_repair_cursor, self.fts_repair_cursor, checked_sql_size(ROW_BATCH_SIZE)?],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for (id, key) in &rows {
            transaction.execute("INSERT INTO directory_fts(rowid, path_key) VALUES (?, ?)", params![id, key])?;
        }
        let complete = rows.len() < ROW_BATCH_SIZE;
        if complete {
            transaction.execute("INSERT INTO directory_fts(directory_fts, rank) VALUES ('integrity-check', 1)", [])?;
        }
        transaction.commit()?;
        if let Some((id, _)) = rows.last() {
            self.fts_repair_cursor = Some(*id);
        }
        self.fts_ready.store(complete, Ordering::Release);
        Ok(!complete)
    }

    pub fn configure_page_cache(&mut self, kib: i64) -> Result<(), IndexError> {
        if kib <= 0 {
            return Err(IndexError::Invalid("Directory page-cache target must be positive."));
        }
        self.writer.pragma_update(None, "cache_size", -kib)?;
        self.page_cache_kib = kib;
        Ok(())
    }
}

#[derive(Clone)]
pub struct DirectoryIndexReader {
    path: PathBuf,
    page_cache_kib: i64,
    fts_ready: Arc<AtomicBool>,
    readers: Arc<Mutex<Vec<PooledReader>>>,
    file_identity: (u64, u64, u64),
}

struct PooledReader {
    connection: Connection,
    identity: (u64, u64, u64),
}

fn database_file_identity(path: &Path) -> Result<(u64, u64, u64), IndexError> {
    #[cfg(unix)]
    {
        let metadata = fs::symlink_metadata(path)?;
        Ok((metadata.dev(), metadata.ino(), 0))
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(path)?;
        validate_windows_storage_file(&file)?;
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information) }
            .map_err(|_| IndexError::Invalid("Directory database identity is unavailable. Reconnect the drive."))?;
        Ok((
            u64::from(information.dwVolumeSerialNumber),
            u64::from(information.nFileIndexHigh),
            u64::from(information.nFileIndexLow),
        ))
    }
}

struct ReaderCheckout<'a> {
    reader: Option<PooledReader>,
    pool: &'a Mutex<Vec<PooledReader>>,
}

impl std::ops::Deref for ReaderCheckout<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.reader.as_ref().expect("checked out reader").connection
    }
}

impl std::ops::DerefMut for ReaderCheckout<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.reader.as_mut().expect("checked out reader").connection
    }
}

impl Drop for ReaderCheckout<'_> {
    fn drop(&mut self) {
        if let Some(mut reader) = self.reader.take() {
            if reader
                .connection
                .progress_handler(SQL_PROGRESS_STEPS, None::<fn() -> bool>)
                .is_err()
            {
                log::warn!("event=directory_reader_cleanup_failed");
                return;
            }
            if let Ok(mut pool) = self.pool.lock() {
                pool.push(reader);
            }
        }
    }
}

impl Drop for DirectoryIndex {
    fn drop(&mut self) {
        if let Ok(mut readers) = self.readers.lock() {
            readers.clear();
        }
        if self.writer.is_autocommit()
            && self.fts_ready.load(Ordering::Acquire)
            && self
                .writer
                .execute("UPDATE source_metadata SET clean_shutdown = 1 WHERE id = 1", [])
                .is_err()
        {
            log::warn!("Directory storage could not record a clean close. Integrity checks will run on the next open.");
        }
    }
}

impl DirectoryIndexReader {
    fn checkout(&self) -> Result<ReaderCheckout<'_>, IndexError> {
        let directory = self
            .path
            .parent()
            .ok_or(IndexError::Invalid("Directory database has no private storage parent."))?;
        validate_storage_directory(directory)?;
        validate_storage_files(&self.path)?;
        let identity = database_file_identity(&self.path)?;
        if identity != self.file_identity {
            return Err(IndexError::Invalid(
                "Directory database changed. Reconnect the drive before searching.",
            ));
        }
        let saved = self
            .readers
            .lock()
            .map_err(|_| IndexError::Invalid("Directory reader state failed. Reconnect the drive."))?
            .pop();
        let reader = if let Some(reader) = saved {
            if reader.identity != identity {
                return Err(IndexError::Invalid(
                    "Directory database changed. Reconnect the drive before searching.",
                ));
            }
            reader
        } else {
            let connection = open_readonly_directory_database(&self.path)?;
            if database_file_identity(&self.path)? != identity {
                return Err(IndexError::Invalid("Directory database changed during open. Reconnect the drive."));
            }
            connection.busy_timeout(SQL_BUSY_TIMEOUT)?;
            connection.execute_batch("PRAGMA mmap_size = 0; PRAGMA temp_store = FILE;")?;
            PooledReader { connection, identity }
        };
        Ok(ReaderCheckout {
            reader: Some(reader),
            pool: &self.readers,
        })
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
        include_dot: bool,
        cancelled: &Arc<AtomicBool>,
        force_scan: bool,
    ) -> Result<DirectoryIndexSearch, IndexError> {
        let terms = search_terms(query)?;
        if !(1..=MAX_RESULT_LIMIT).contains(&limit) {
            return Err(IndexError::Invalid("Directory result limit is outside the supported range."));
        }
        let started = Instant::now();
        let interrupted = || cancelled.load(Ordering::Acquire) || started.elapsed() >= QUERY_TIMEOUT;
        if interrupted() {
            return Err(IndexError::Interrupted);
        }
        let mut connection = self.checkout()?;
        let cancellation = Arc::clone(cancelled);
        connection.progress_handler(
            SQL_PROGRESS_STEPS,
            Some(move || cancellation.load(Ordering::Acquire) || started.elapsed() >= QUERY_TIMEOUT),
        )?;
        connection.pragma_update(None, "cache_size", -self.page_cache_kib)?;
        let fts_ready = self.fts_ready.load(Ordering::Acquire);
        let transaction = connection.transaction()?;
        let (generation, revision, verified): (i64, i64, Option<i64>) = transaction.query_row(
            "SELECT selected_generation, accepted_revision, last_verified_at_ms FROM source_metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let (directory_count, coverage, issue_count): (i64, String, i64) = transaction.query_row(
            "SELECT indexed_count, coverage, issue_count FROM generations WHERE id = ?",
            [generation],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let mut response = DirectoryIndexSearch {
            results: Vec::new(),
            total_matches: 0,
            directory_count,
            accepted_revision: revision,
            coverage,
            last_verified_at_ms: verified,
            query_plan: "empty",
            issue_count,
        };
        if terms.is_empty() {
            return Ok(response);
        }
        let trigram = fts_ready && !force_scan && terms.iter().all(|term| term.chars().count() >= 3);
        response.query_plan = if trigram { "trigram" } else { "scan" };
        let mut sql = String::from("SELECT directories.path, directories.path_key, directories.basename_key, directories.depth ");
        if trigram {
            sql.push_str("FROM directory_fts CROSS JOIN directories WHERE directories.id = directory_fts.rowid AND directories.generation_id = ? AND (? OR directories.has_dot_directory = 0) AND directory_fts MATCH ?");
        } else {
            sql.push_str("FROM directories WHERE directories.generation_id = ? AND (? OR directories.has_dot_directory = 0)");
        }
        let expression = terms
            .iter()
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let mut statement = transaction.prepare(&sql)?;
        let mut rows = if trigram {
            statement.query(params![generation, include_dot, expression])?
        } else {
            statement.query(params![generation, include_dot])?
        };
        let mut best = BinaryHeap::with_capacity(limit);
        while let Some(row) = rows.next()? {
            if interrupted() {
                return Err(IndexError::Interrupted);
            }
            let path_key: String = row.get(1)?;
            let basename_key: String = row.get(2)?;
            let matched: Vec<_> = terms.iter().filter(|term| path_key.contains(term.as_str())).collect();
            if matched.is_empty() {
                continue;
            }
            response.total_matches = response
                .total_matches
                .checked_add(1)
                .ok_or(IndexError::Invalid("Directory match count exceeds the supported range."))?;
            let result = DirectoryIndexMatch {
                path: row.get(0)?,
                matched_term_count: matched.len(),
                match_rank: matched.iter().map(|term| single_term_rank(&basename_key, term)).min().unwrap_or(3),
                depth: row.get(3)?,
                path_key,
            };
            if best.len() < limit {
                best.push(result);
            } else if best.peek().is_some_and(|worst| result < *worst) {
                best.pop();
                best.push(result);
            }
        }
        response.results = best.into_sorted_vec();
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parent_issue_counts_commit_with_snapshot() {
        for reject_completion in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let mut index = DirectoryIndex::open(
                &temporary.path().join("private").join("source.sqlite3"),
                SourceKind::Local,
                &json!({"root": "fixture"}),
            )
            .unwrap();
            index.prepare_scan().unwrap();
            index.seed_scan(1).unwrap();
            index
                .commit_scan_parent_snapshots(
                    1,
                    &[(String::new(), vec![("parent".to_owned(), true)])],
                    &HashMap::new(),
                    &HashSet::new(),
                )
                .unwrap();
            index.write_scan_children(1, [("parent/retained".to_owned(), false)]).unwrap();
            let before = index.status().unwrap();
            if reject_completion {
                index.writer.execute_batch("CREATE TEMP TRIGGER reject_issue_completion BEFORE UPDATE ON scan_queue WHEN new.path = 'parent' BEGIN SELECT RAISE(ABORT, 'completion rejected'); END;").unwrap();
            }
            let issues = HashMap::from([("parent".to_owned(), HashMap::from([("access_denied", 2), ("scan_failed", 3)]))]);
            let outcome = index.commit_parent_snapshots_with_issues(
                1,
                &[("parent".to_owned(), vec![])],
                &HashMap::new(),
                &HashSet::from(["parent".to_owned()]),
                &HashSet::new(),
                ScanCommitOptions {
                    reconcile: false,
                    issues: Some(&issues),
                },
            );
            if reject_completion {
                assert!(outcome.is_err());
                assert_eq!(index.status().unwrap(), before);
                assert!(index.scan_parent_pending(1, "parent").unwrap());
            } else {
                outcome.unwrap();
                assert!(!index.scan_parent_pending(1, "parent").unwrap());
                assert_eq!(index.status().unwrap().issue_count, 5);
            }
            assert_eq!(index.status().unwrap().directory_count, before.directory_count);
        }
    }

    #[test]
    fn streamed_parent_snapshot_finishes_atomically() {
        for preserve in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let mut index = DirectoryIndex::open(
                &temporary.path().join("private").join("stream.sqlite3"),
                SourceKind::Local,
                &json!({"root": "fixture"}),
            )
            .unwrap();
            index.seed_scan(1).unwrap();
            index.commit_scan_parents(1, &[("".into(), vec![("parent".into(), true)])]).unwrap();
            index
                .commit_scan_parents(
                    1,
                    &[("parent".into(), vec![("parent/keep".into(), true), ("parent/remove".into(), true)])],
                )
                .unwrap();
            index
                .commit_scan_parents(1, &[("parent/remove".into(), vec![("parent/remove/leaf".into(), true)])])
                .unwrap();
            index.defer_scan_parent(1, "parent").unwrap();
            index
                .write_scan_parent_batch(1, "parent", &[("parent/keep".into(), true)], &HashMap::new(), true, false)
                .unwrap();
            let partial = if preserve {
                HashSet::from(["parent".to_owned()])
            } else {
                HashSet::new()
            };
            index
                .commit_parent_snapshots(
                    1,
                    &[("parent".into(), vec![("parent/new".into(), true)])],
                    &HashMap::new(),
                    &partial,
                    &HashSet::from(["parent".to_owned()]),
                    false,
                )
                .unwrap();
            assert!(index
                .writer
                .query_row("SELECT EXISTS(SELECT 1 FROM directories WHERE path = 'parent/keep')", [], |row| row
                    .get::<_, bool>(0))
                .unwrap());
            assert_eq!(
                index
                    .writer
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM directories WHERE path = 'parent/remove/leaf')",
                        [],
                        |row| row.get::<_, bool>(0)
                    )
                    .unwrap(),
                preserve
            );
            assert_eq!(
                index
                    .writer
                    .query_row("SELECT count(*) FROM scan_snapshot_children", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert!(!index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap().contains(&"parent".to_owned()));
        }
    }

    #[test]
    fn streamed_snapshot_restart_replaces_staged_names() {
        for reconcile in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let identity = json!({"root": "fixture"});
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            index.prepare_scan().unwrap();
            index.seed_scan(1).unwrap();
            index
                .commit_scan_parent_snapshots(
                    1,
                    &[(String::new(), vec![("parent".to_owned(), true)])],
                    &HashMap::new(),
                    &HashSet::new(),
                )
                .unwrap();
            if reconcile {
                index
                    .commit_scan_parent_snapshots(1, &[("parent".to_owned(), vec![])], &HashMap::new(), &HashSet::new())
                    .unwrap();
                index.finish_generation(1, 0).unwrap();
                index.queue_reconciliation_parent(1, "parent").unwrap();
            }
            index
                .write_scan_parent_batch(1, "parent", &[("parent/stale".to_owned(), true)], &HashMap::new(), true, reconcile)
                .unwrap();
            drop(index);
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            assert_eq!(
                index
                    .writer
                    .query_row("SELECT path FROM scan_snapshot_children", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "parent/stale"
            );
            if !reconcile {
                assert_eq!(index.prepare_scan().unwrap(), (1, true));
            }
            index
                .write_scan_parent_batch(1, "parent", &[("parent/keep".to_owned(), false)], &HashMap::new(), true, reconcile)
                .unwrap();
            assert_eq!(
                index
                    .writer
                    .query_row("SELECT path FROM scan_snapshot_children", [], |row| row.get::<_, String>(0))
                    .unwrap(),
                "parent/keep"
            );
            index
                .commit_parent_snapshots(
                    1,
                    &[("parent".to_owned(), vec![])],
                    &HashMap::new(),
                    &HashSet::new(),
                    &HashSet::from(["parent".to_owned()]),
                    reconcile,
                )
                .unwrap();
            assert_eq!(index.status().unwrap().directory_count, 2);
            assert!(!index
                .writer
                .query_row("SELECT EXISTS(SELECT 1 FROM directories WHERE path = 'parent/stale')", [], |row| {
                    row.get::<_, bool>(0)
                })
                .unwrap());
            assert_eq!(
                index
                    .writer
                    .query_row("SELECT count(*) FROM scan_snapshot_children", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                0
            );
            assert!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap().is_empty());
        }
    }

    #[test]
    fn reopen_rejects_malformed_streamed_snapshot() {
        for (parent, child, processed) in [
            ("", "deep/child", false),
            ("parent", "outside", false),
            ("parent", "parent/deep/child", false),
            ("", "", false),
            ("", "child", true),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let identity = json!({"root": "fixture"});
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            index.seed_scan(1).unwrap();
            index.write_scan_children(1, [("parent".to_owned(), true)]).unwrap();
            if processed {
                index.finish_scan_parent(1, parent).unwrap();
            }
            index
                .writer
                .execute(
                    "INSERT INTO scan_snapshot_children(generation_id, parent_path, path) VALUES (1, ?, ?)",
                    params![parent, child],
                )
                .unwrap();
            drop(index);
            assert!(
                matches!(DirectoryIndex::open(&path, SourceKind::Local, &identity), Err(IndexError::RebuildRequired(message)) if message.contains("generation metadata"))
            );
        }
    }

    #[test]
    fn scan_file_ids_survive_deferral_and_reopen() {
        for size in [size_of::<u64>(), size_of::<u128>()] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let identity = json!({"root": "file-id-fixture"});
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            let expected = vec![1; size];
            let replacement = vec![2; size];
            let results = [(String::new(), vec![("parent".into(), true)])];
            index.seed_scan(1).unwrap();
            assert_eq!(index.scan_parent_file_id(1, "").unwrap(), None);
            index
                .commit_scan_parents_with_ids(1, &results, &HashMap::from([("parent".into(), expected.clone())]))
                .unwrap();
            assert_eq!(index.scan_parent_file_id(1, "parent").unwrap(), Some(expected.clone()));
            index.finish_scan_parent(1, "parent").unwrap();
            index
                .commit_scan_parents_with_ids(1, &results, &HashMap::from([("parent".into(), expected)]))
                .unwrap();
            assert!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap().is_empty());
            index
                .commit_scan_parents_with_ids(1, &results, &HashMap::from([("parent".into(), replacement.clone())]))
                .unwrap();
            assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), ["parent"]);
            index.defer_scan_parent(1, "parent").unwrap();
            assert!(index
                .commit_scan_parents_with_ids(
                    1,
                    &[("parent".into(), vec![("parent/refused".into(), true)])],
                    &HashMap::from([("parent/refused".into(), b"invalid".to_vec())])
                )
                .is_err());
            assert_eq!(index.status().unwrap().directory_count, 1);
            drop(index);
            let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            assert_eq!(index.scan_parent_file_id(1, "parent").unwrap(), Some(replacement));
            assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), ["parent"]);
        }
    }

    #[test]
    fn reconciliation_refreshes_existing_child_file_ids_without_unchanged_writes() {
        for size in [size_of::<u64>(), size_of::<u128>()] {
            for processed in [false, true] {
                for changed in [false, true] {
                    let temporary = tempfile::tempdir().unwrap();
                    let path = temporary.path().join("private").join("source.sqlite3");
                    let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "file-id-fixture"})).unwrap();
                    let old_id = vec![1; size];
                    let new_id = if changed { vec![2; size] } else { old_id.clone() };
                    let results = [("parent".into(), vec![("parent/child".into(), true)])];
                    index.write_paths(["parent".to_owned()], None).unwrap();
                    index.finish_generation(1, 0).unwrap();
                    index.queue_reconciliation_parent(1, "parent").unwrap();
                    index
                        .commit_parent_snapshots(
                            1,
                            &results,
                            &HashMap::from([("parent/child".into(), old_id)]),
                            &HashSet::new(),
                            &HashSet::new(),
                            true,
                        )
                        .unwrap();
                    if processed {
                        index.finish_reconciliation_parent(1, "parent/child").unwrap();
                    }
                    index.queue_reconciliation_parent(1, "parent").unwrap();
                    index
                        .writer
                        .execute_batch("CREATE TEMP TABLE child_queue_writes(count INTEGER); INSERT INTO child_queue_writes VALUES (0);")
                        .unwrap();
                    for operation in ["INSERT", "UPDATE"] {
                        index.writer.execute_batch(&format!("CREATE TEMP TRIGGER count_child_queue_{operation} AFTER {operation} ON scan_queue WHEN new.path = 'parent/child' BEGIN UPDATE child_queue_writes SET count = count + 1; END;")).unwrap();
                    }
                    index
                        .commit_parent_snapshots(
                            1,
                            &results,
                            &HashMap::from([("parent/child".into(), new_id.clone())]),
                            &HashSet::new(),
                            &HashSet::new(),
                            true,
                        )
                        .unwrap();
                    assert_eq!(index.scan_parent_file_id(1, "parent/child").unwrap(), Some(new_id));
                    assert_eq!(index.scan_parent_pending(1, "parent/child").unwrap(), changed || !processed);
                    let writes: i64 = index
                        .writer
                        .query_row("SELECT count FROM child_queue_writes", [], |row| row.get(0))
                        .unwrap();
                    assert_eq!(writes, i64::from(changed));
                }
            }
        }
    }

    #[test]
    fn reconciliation_identity_update_does_not_insert_or_requeue_unknown_identity() {
        for queue_exists in [false, true] {
            for new_id in [None, Some(vec![2; size_of::<u64>()])] {
                let temporary = tempfile::tempdir().unwrap();
                let path = temporary.path().join("private").join("source.sqlite3");
                let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "file-id-fixture"})).unwrap();
                index.write_paths(["parent".to_owned(), "parent/child".to_owned()], None).unwrap();
                index.finish_generation(1, 0).unwrap();
                if queue_exists {
                    index.queue_reconciliation_parent(1, "parent/child").unwrap();
                    index.finish_reconciliation_parent(1, "parent/child").unwrap();
                }
                index.queue_reconciliation_parent(1, "parent").unwrap();
                let file_ids = new_id
                    .as_ref()
                    .map_or_else(HashMap::new, |identity| HashMap::from([("parent/child".into(), identity.clone())]));
                index
                    .commit_parent_snapshots(
                        1,
                        &[("parent".into(), vec![("parent/child".into(), true)])],
                        &file_ids,
                        &HashSet::new(),
                        &HashSet::new(),
                        true,
                    )
                    .unwrap();
                assert_eq!(
                    index.scan_parent_file_id(1, "parent/child").unwrap(),
                    if queue_exists { new_id } else { None }
                );
                assert!(!index.scan_parent_pending(1, "parent/child").unwrap());
                let count: i64 = index
                    .writer
                    .query_row("SELECT count(*) FROM scan_queue WHERE path = 'parent/child'", [], |row| row.get(0))
                    .unwrap();
                assert_eq!(count, i64::from(queue_exists));
            }
        }
    }

    #[test]
    fn query_reuses_readers_and_clears_cancellation() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "reader-fixture"})).unwrap();
        let reader = index.reader();
        let cancelled = Arc::new(AtomicBool::new(false));
        reader.search("needle", 10, true, &cancelled, false).unwrap();
        let first = unsafe { reader.readers.lock().unwrap()[0].connection.handle() };
        cancelled.store(true, Ordering::Release);
        assert!(matches!(
            reader.search("needle", 10, true, &cancelled, false),
            Err(IndexError::Interrupted)
        ));
        let next = Arc::new(AtomicBool::new(false));
        reader.search("needle", 10, true, &next, false).unwrap();
        let pool = reader.readers.lock().unwrap();
        assert_eq!(pool.len(), 1);
        assert_eq!(unsafe { pool[0].connection.handle() }, first);
        drop(pool);
        #[cfg(unix)]
        {
            let replacement = path.with_extension("replacement");
            fs::copy(&path, &replacement).unwrap();
            fs::rename(replacement, &path).unwrap();
            for _ in 0..2 {
                assert!(matches!(
                    reader.search("needle", 10, true, &next, false),
                    Err(IndexError::Invalid(_))
                ));
            }
        }
    }

    #[test]
    fn grouped_scan_commit_rolls_back_rows_and_parent_completion() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let identity = json!({"root": "group-fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index.seed_scan(1).unwrap();
        index
            .commit_scan_parents(1, &[(String::new(), vec![("parent".into(), true)])])
            .unwrap();
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), ["parent"]);
        index
            .writer
            .execute_batch(
                "CREATE TRIGGER reject_group_child BEFORE INSERT ON directories WHEN new.path = 'parent/refused' \
             BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
            .unwrap();
        assert!(index
            .commit_scan_parents(
                1,
                &[(
                    "parent".into(),
                    vec![("parent/accepted".into(), false), ("parent/refused".into(), false),]
                )]
            )
            .is_err());
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), ["parent"]);
        assert_eq!(index.status().unwrap().directory_count, 1);
        drop(index);
        let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), ["parent"]);
        assert_eq!(index.status().unwrap().directory_count, 1);
        assert_eq!(
            index
                .writer
                .query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn removable_evidence_retires_rows_exactly_once_and_missing_evidence_keeps_them() {
        use super::super::drives::{VolumeChange, VolumeEvidence};
        use super::super::models::DriveType;
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("evidence.sqlite3");
        let identity = serde_json::json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        let mut evidence = VolumeEvidence {
            class: DriveType::Removable,
            volume: Some("first".into()),
            label: Some("label".into()),
            ..Default::default()
        };
        assert_eq!(index.bind_volume(&evidence).unwrap(), VolumeChange::Keep);
        index.write_paths(["old".to_owned()], None).unwrap();
        index.finish_generation(1, 0).unwrap();
        evidence.label = Some("renamed".into());
        assert_eq!(index.bind_volume(&evidence).unwrap(), VolumeChange::Generation);
        let selected: i64 = index
            .writer
            .query_row("SELECT selected_generation FROM source_metadata", [], |row| row.get(0))
            .unwrap();
        assert_ne!(selected, 1);
        assert_eq!(
            index
                .search("old", 5, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .directory_count,
            0
        );
        assert_eq!(index.bind_volume(&evidence).unwrap(), VolumeChange::Keep);
        assert_eq!(index.bind_volume(&VolumeEvidence::default()).unwrap(), VolumeChange::Keep);
        assert_eq!(
            index
                .writer
                .query_row("SELECT selected_generation FROM source_metadata", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            selected
        );
        drop(index);
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        evidence.volume = Some("other".into());
        assert_eq!(index.bind_volume(&evidence).unwrap(), VolumeChange::Index);
        assert_eq!(
            index
                .writer
                .query_row("SELECT selected_generation FROM source_metadata", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            selected
        );
    }

    #[test]
    fn interrupted_candidate_retains_completed_parent_progress() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("progress.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &serde_json::json!({"root": "fixture"})).unwrap();
        index.write_paths(["accepted".to_owned()], None).unwrap();
        index.finish_generation(1, 0).unwrap();
        let (candidate, selected) = index.prepare_scan().unwrap();
        assert!(!selected);
        index.seed_scan(candidate).unwrap();
        index.write_scan_children(candidate, [("retained".to_owned(), true)]).unwrap();
        index.finish_scan_parent(candidate, "").unwrap();
        assert!(index.has_resumable_scan().unwrap());
        assert_eq!(index.prepare_scan().unwrap(), (candidate, false));
        assert_eq!(index.pending_scan_paths(candidate, 1).unwrap(), ["retained"]);
    }

    #[test]
    fn completed_scan_revalidation_is_bounded_and_preserves_rows() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("revalidation.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &serde_json::json!({"root": "fixture"})).unwrap();
        index.write_paths(["accepted".to_owned()], None).unwrap();
        index.finish_generation(1, 0).unwrap();
        let (candidate, selected) = index.prepare_scan().unwrap();
        assert!(!selected);
        index.seed_scan(candidate).unwrap();
        let paths: Vec<_> = (0..=ROW_BATCH_SIZE).map(|number| format!("child-{number}")).collect();
        for batch in paths.chunks(ROW_BATCH_SIZE) {
            index
                .write_scan_children(candidate, batch.iter().map(|path| (path.clone(), true)))
                .unwrap();
        }
        index.finish_scan_parent(candidate, "").unwrap();
        for path in &paths {
            index.finish_scan_parent(candidate, path).unwrap();
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("accepted", 5, false, &cancelled, false).unwrap();
        assert!(index.requeue_completed_scan_batch(candidate).unwrap());
        assert_eq!(index.pending_scan_paths(candidate, ROW_BATCH_SIZE).unwrap().len(), ROW_BATCH_SIZE);
        assert!(!index.requeue_completed_scan_batch(candidate).unwrap());
        let pending: i64 = index
            .writer
            .query_row(
                "SELECT count(*) FROM scan_queue WHERE generation_id = ? AND processed = 0",
                [candidate],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, checked_sql_size(paths.len() + 1).unwrap());
        assert!(!index.requeue_completed_scan_batch(candidate).unwrap());
        assert_eq!(candidate, 1);
        assert!(!index.requeue_completed_scan_batch(1).unwrap());
        let after = index.search("accepted", 5, false, &cancelled, false).unwrap();
        assert_eq!(before.accepted_revision, after.accepted_revision);
        assert_eq!(before.last_verified_at_ms, after.last_verified_at_ms);
        assert_eq!(after.directory_count, before.directory_count);
        assert_eq!(after.results[0].path, "accepted");
    }

    #[test]
    fn sqlite_log_fields_exclude_private_error_text() {
        for (code, expected) in [
            (rusqlite::ffi::SQLITE_BUSY, "directory_storage_busy"),
            (rusqlite::ffi::SQLITE_INTERRUPT, "directory_query_cancelled"),
            (rusqlite::ffi::SQLITE_IOERR_WRITE, "directory_transaction_failed"),
        ] {
            let error = rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(code),
                Some("private/path?grant=secret search-term".into()),
            );
            let fields = sqlite_failure_fields(&error);
            assert_eq!(fields, (expected, code));
            assert!(!format!("event={} sqlite_code={}", fields.0, fields.1).contains("private"));
        }
    }

    #[test]
    fn recovery_replaces_only_invalid_disposable_catalogues() {
        for invalid in [
            "PRAGMA user_version = 1",
            "UPDATE generations SET indexed_count = indexed_count + 1",
            "DELETE FROM source_metadata",
            "DROP TABLE scan_queue",
            "ALTER TABLE scan_queue DROP COLUMN file_id",
            "PRAGMA ignore_check_constraints = ON; UPDATE source_metadata SET normalization_version = 2",
            "PRAGMA ignore_check_constraints = ON; UPDATE source_metadata SET traversal_version = 2",
            "not_database",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let identity = json!({"root": "fixture"});
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            index.write_paths(["rejected".to_owned()], None).unwrap();
            index.finish_generation(1, 0).unwrap();
            if invalid != "not_database" {
                index.writer.execute_batch(invalid).unwrap();
            }
            drop(index);
            if invalid == "not_database" {
                fs::write(&path, b"not a SQLite catalogue").unwrap();
            }
            let before = fs::read(&path).unwrap();
            let attempted = AtomicBool::new(false);
            let mut index = DirectoryIndex::open_with_recovery(&path, SourceKind::Local, &identity, Some(&attempted)).unwrap();
            let response = index
                .search("rejected", 3, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap();
            assert_eq!(response.total_matches, 0);
            assert_eq!(response.coverage, "partial");
            assert_eq!(response.last_verified_at_ms, None);
            assert!(attempted.load(Ordering::Acquire));
            assert_eq!(fs::read(path.parent().unwrap().join(QUARANTINE_FILE_NAME)).unwrap(), before);
            assert!(acquire_storage(&path).is_err());
            index.write_paths(["fresh".to_owned()], None).unwrap();
            assert!(index.finish_generation(1, 0).unwrap());
        }
    }

    #[test]
    fn recovery_refuses_wrong_application_and_source_without_modification() {
        for invalid in ["PRAGMA application_id = 1", "UPDATE source_metadata SET source_identity = '{}'"] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let identity = json!({"root": "fixture"});
            let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            index.writer.execute_batch(invalid).unwrap();
            drop(index);
            let before = fs::read(&path).unwrap();
            let attempted = AtomicBool::new(false);
            assert!(DirectoryIndex::open_with_recovery(&path, SourceKind::Local, &identity, Some(&attempted)).is_err());
            assert!(!attempted.load(Ordering::Acquire));
            assert_eq!(fs::read(&path).unwrap(), before);
            assert!(!path.parent().unwrap().join(QUARANTINE_FILE_NAME).exists());
            assert!(acquire_storage(&path).is_ok());
        }
    }

    #[test]
    fn recovery_refuses_second_discard_after_quarantine_failure() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index.writer.execute_batch("PRAGMA user_version = 1").unwrap();
        drop(index);
        let before = fs::read(&path).unwrap();
        let rejected = path.parent().unwrap().join(QUARANTINE_FILE_NAME);
        let lease = acquire_storage(&rejected).unwrap();
        let attempted = AtomicBool::new(false);
        assert!(DirectoryIndex::open_with_recovery(&path, SourceKind::Local, &identity, Some(&attempted)).is_err());
        assert!(attempted.load(Ordering::Acquire));
        assert_eq!(fs::read(&path).unwrap(), before);
        drop(lease);
        assert!(matches!(
            DirectoryIndex::open_with_recovery(&path, SourceKind::Local, &identity, Some(&attempted)),
            Err(IndexError::Invalid(message)) if message.contains("already failed")
        ));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(!rejected.exists());
    }

    #[test]
    fn recovery_preserves_accepted_data_after_writer_contention() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index.write_paths(["accepted".to_owned()], None).unwrap();
        index.finish_generation(1, 0).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("accepted", 3, false, &cancelled, false).unwrap();
        drop(index);
        let blocker = Connection::open(&path).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        let attempted = AtomicBool::new(false);
        assert!(DirectoryIndex::open_with_recovery(&path, SourceKind::Local, &identity, Some(&attempted)).is_err());
        assert!(!attempted.load(Ordering::Acquire));
        assert!(!path.parent().unwrap().join(QUARANTINE_FILE_NAME).exists());
        blocker.execute_batch("ROLLBACK").unwrap();
        let index = DirectoryIndex::open_with_recovery(&path, SourceKind::Local, &identity, Some(&attempted)).unwrap();
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), before);
    }

    #[test]
    fn recovery_quarantine_retains_source_ownership_through_moves() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        drop(DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap());
        let before = fs::read(&path).unwrap();
        let lease = acquire_storage(&path).unwrap();
        quarantine_owned(&path, &lease).unwrap();
        assert!(acquire_storage(&path).is_err());
        assert_eq!(fs::read(path.parent().unwrap().join(QUARANTINE_FILE_NAME)).unwrap(), before);
        drop(lease);
        assert!(acquire_storage(&path).is_ok());
    }

    #[test]
    fn subtree_rename_includes_all_signed_row_ids() {
        for identifier in [i64::MIN, -1, 0] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
            index.write_paths(["alpha".to_owned(), "alpha/beta".to_owned()], None).unwrap();
            index
                .writer
                .execute("UPDATE directories SET id = ? WHERE path = 'alpha/beta'", [identifier])
                .unwrap();
            index
                .mutate_path(&DirectoryMutation::Rename {
                    path: "alpha".to_owned(),
                    new_path: "renamed".to_owned(),
                })
                .unwrap();
            let cancelled = Arc::new(AtomicBool::new(false));
            assert_eq!(index.search("alpha", 3, false, &cancelled, false).unwrap().total_matches, 0);
            let response = index.search("renamed", 3, false, &cancelled, false).unwrap();
            assert_eq!(response.total_matches, 2);
            assert_eq!(response.directory_count, 2);
        }
    }

    #[test]
    fn startup_rejects_inconsistent_counts_and_unpublished_selection() {
        for corruption in [
            "UPDATE generations SET indexed_count = 1 WHERE id = 1",
            "UPDATE generations SET issue_count = 1 WHERE id = 1",
            "INSERT INTO generations(state, coverage) VALUES ('building', 'partial')",
            "UPDATE source_metadata SET selected_generation = NULL WHERE id = 1",
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let identity = json!({"root": "fixture"});
            let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            index.writer.execute_batch(corruption).unwrap();
            drop(index);
            assert!(
                matches!(DirectoryIndex::open(&path, SourceKind::Local, &identity), Err(IndexError::RebuildRequired(message)) if message.contains("generation metadata"))
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn hard_linked_database_and_sidecars_are_rejected() {
        for suffix in ["", ".lease", "-wal", "-shm"] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let identity = json!({"root": "fixture"});
            let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            let mut file = path.as_os_str().to_owned();
            file.push(suffix);
            let alias = path.parent().unwrap().join("alias.data");
            fs::hard_link(Path::new(&file), &alias).unwrap();
            assert!(
                matches!(DirectoryIndex::open(&path, SourceKind::Local, &identity), Err(IndexError::Invalid(message)) if message.contains("hard links"))
            );
            assert!(matches!(
                index.search("", 3, false, &Arc::new(AtomicBool::new(false)), false),
                Err(IndexError::Invalid(_))
            ));
            fs::remove_file(alias).unwrap();
            assert_eq!(
                index
                    .search("", 3, false, &Arc::new(AtomicBool::new(false)), false)
                    .unwrap()
                    .directory_count,
                0
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn held_storage_directory_refuses_replaced_namespace_without_mutating_other_files() {
        for replacement in ["link", "directory"] {
            let temporary = tempfile::tempdir().unwrap();
            let namespace = temporary.path().join("private");
            let path = namespace.join("source.sqlite3");
            drop(DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap());
            let directory = StorageDirectory::open(&namespace).unwrap();
            let original = temporary.path().join("original");
            let unrelated = temporary.path().join("unrelated");
            fs::create_dir(&unrelated).unwrap();
            fs::set_permissions(&unrelated, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE)).unwrap();
            let victim = unrelated.join("source.sqlite3");
            fs::write(&victim, b"unrelated data").unwrap();
            fs::rename(&namespace, &original).unwrap();
            if replacement == "link" {
                std::os::unix::fs::symlink(&unrelated, &namespace).unwrap();
            } else {
                fs::rename(&unrelated, &namespace).unwrap();
            }
            assert!(directory.remove(&path).is_err());
            assert!(directory.rename(&path, &namespace.join(QUARANTINE_FILE_NAME)).is_err());
            assert!(original.join("source.sqlite3").exists());
            assert_eq!(fs::read(&path).unwrap(), b"unrelated data");
            if replacement == "link" {
                fs::remove_file(&namespace).unwrap();
            } else {
                fs::rename(&namespace, &unrelated).unwrap();
            }
            fs::rename(&original, &namespace).unwrap();
            directory.rename(&path, &namespace.join("renamed.sqlite3")).unwrap();
            directory.remove(&namespace.join("renamed.sqlite3")).unwrap();
            assert_eq!(fs::read(&victim).unwrap(), b"unrelated data");
        }
    }

    #[cfg(unix)]
    #[test]
    fn readonly_queries_revalidate_private_namespace_files_and_ancestors() {
        for changed in ["namespace", "database", "ancestor"] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let identity = json!({"root": "fixture"});
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            index.write_paths(["retained".into()], None).unwrap();
            assert!(index.finish_generation(1, 0).unwrap());
            let cancelled = Arc::new(AtomicBool::new(false));
            let before = index.search("retained", 3, false, &cancelled, false).unwrap();
            let (target, unsafe_mode) = match changed {
                "namespace" => (path.parent().unwrap(), 0o755),
                "database" => (path.as_path(), 0o620),
                _ => (temporary.path(), 0o770),
            };
            let permissions = fs::metadata(target).unwrap().permissions();
            fs::set_permissions(target, fs::Permissions::from_mode(unsafe_mode)).unwrap();
            let refused = index.search("retained", 3, false, &cancelled, false);
            fs::set_permissions(target, permissions).unwrap();
            assert!(matches!(refused, Err(IndexError::Invalid(_))));
            assert_eq!(index.search("retained", 3, false, &cancelled, false).unwrap(), before);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_readers_reject_database_family_hard_links_and_recover_after_removal() {
        for suffix in ["", ".lease", "-wal", "-shm"] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let identity = json!({"root": "fixture"});
            let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            let alias = path.parent().unwrap().join("\u{e9}-alias.data");
            fs::hard_link(storage_member(&path, suffix), &alias).unwrap();
            assert!(matches!(
                index.search("", 3, false, &Arc::new(AtomicBool::new(false)), false),
                Err(IndexError::Invalid(_))
            ));
            drop(index);
            fs::remove_file(alias).unwrap();
            let reopened = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            assert_eq!(
                reopened
                    .search("", 3, false, &Arc::new(AtomicBool::new(false)), false)
                    .unwrap()
                    .directory_count,
                0
            );
        }
    }

    #[test]
    fn namespace_lease_serializes_source_lease_creation() {
        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        let path = namespace.join("source.sqlite3");
        let lease = acquire_namespace_lease(&namespace).unwrap();
        assert!(
            matches!(DirectoryIndex::open(&path, SourceKind::Local, &json!({"id": "fixture"})), Err(IndexError::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
        drop(lease);
        let index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"id": "fixture"})).unwrap();
        assert_eq!(
            index
                .search("", 3, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .directory_count,
            0
        );
    }

    #[test]
    fn normal_checkpoint_defers_for_pinned_reader_without_changing_results() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index.writer.execute_batch("PRAGMA wal_autocheckpoint = 0").unwrap();
        let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        reader.execute_batch("BEGIN; SELECT count(*) FROM directories;").unwrap();
        index
            .write_paths(
                (0..ROW_BATCH_SIZE * 4).map(|number| format!("match/{number}/{}", "long-name-".repeat(100))),
                None,
            )
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("match", 3, false, &cancelled, false).unwrap();
        let mut wal = path.as_os_str().to_owned();
        wal.push("-wal");
        let wal = PathBuf::from(wal);
        assert!(fs::metadata(&wal).unwrap().len() >= CHECKPOINT_WAL_BYTES);
        assert!(!index.checkpoint_if_due().unwrap());
        assert!(fs::metadata(&wal).unwrap().len() >= CHECKPOINT_WAL_BYTES);
        reader.execute_batch("ROLLBACK").unwrap();
        assert!(index.checkpoint_if_due().unwrap());
        assert_eq!(fs::metadata(&wal).unwrap().len(), 0);
        assert_eq!(index.search("match", 3, false, &cancelled, false).unwrap(), before);
    }

    #[test]
    fn fts_repair_is_bounded_restartable_and_preserves_rows() {
        for missing_table in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let identity = serde_json::json!({"root": "fixture"});
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            index
                .write_paths((0..ROW_BATCH_SIZE + 1).map(|number| format!("match/{number}")), None)
                .unwrap();
            index.finish_generation(1, 0).unwrap();
            let cancelled = Arc::new(AtomicBool::new(false));
            let mut before = index.search("match", 3, false, &cancelled, false).unwrap();
            index
                .writer
                .execute_batch(if missing_table {
                    "DROP TABLE directory_fts; BEGIN"
                } else {
                    "INSERT INTO directory_fts(directory_fts) VALUES ('delete-all'); BEGIN"
                })
                .unwrap();
            drop(index);
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            let reader = index.reader();
            assert!(index.needs_fts_repair());
            before.query_plan = "scan";
            assert_eq!(reader.search("match", 3, false, &cancelled, false).unwrap(), before);
            assert!(index
                .mutate_path(&DirectoryMutation::Remove {
                    path: "match/0".to_owned()
                })
                .is_err());
            assert!(index.repair_fts_batch().unwrap());
            let indexed: i64 = index
                .writer
                .query_row("SELECT count(*) FROM directory_fts_docsize", [], |row| row.get(0))
                .unwrap();
            assert_eq!(indexed, ROW_BATCH_SIZE as i64);
            drop(index);
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
            let reader = index.reader();
            assert!(index.repair_fts_batch().unwrap());
            assert!(!index.repair_fts_batch().unwrap());
            assert!(!index.needs_fts_repair());
            before.query_plan = "trigram";
            assert_eq!(reader.search("match", 3, false, &cancelled, false).unwrap(), before);
            index
                .mutate_path(&DirectoryMutation::Add {
                    path: "match/extra".to_owned(),
                })
                .unwrap();
            assert_eq!(
                index.search("match", 3, false, &cancelled, false).unwrap().total_matches,
                before.total_matches + 1
            );
        }
    }

    #[test]
    fn interrupted_partial_fts_repair_preserves_rows_cursor_and_retry() {
        use std::sync::atomic::AtomicUsize;

        const INTERRUPT_AFTER_STEPS: usize = 4096;

        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index
            .write_paths((0..ROW_BATCH_SIZE + 1).map(|number| format!("accepted/{number}")), None)
            .unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        index
            .writer
            .execute_batch("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all'); BEGIN")
            .unwrap();
        drop(index);
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut before = index.search("accepted", 3, false, &cancelled, false).unwrap();
        assert!(index.needs_fts_repair());
        let cursor = index.fts_repair_cursor;
        let changes_before: i64 = index.writer.query_row("SELECT total_changes()", [], |row| row.get(0)).unwrap();
        let steps = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&steps);
        index
            .writer
            .progress_handler(1, Some(move || observed.fetch_add(1, Ordering::Relaxed) >= INTERRUPT_AFTER_STEPS))
            .unwrap();
        let outcome = index.repair_fts_batch();
        index.writer.progress_handler(0, None::<fn() -> bool>).unwrap();
        assert!(outcome.is_err());
        assert!(steps.load(Ordering::Relaxed) > INTERRUPT_AFTER_STEPS);
        let changes_after: i64 = index.writer.query_row("SELECT total_changes()", [], |row| row.get(0)).unwrap();
        assert!(
            changes_after > changes_before,
            "The interruption must occur after a partial token write."
        );
        assert_eq!(index.fts_repair_cursor, cursor);
        assert!(index.needs_fts_repair());
        let tokens: i64 = index
            .writer
            .query_row("SELECT count(*) FROM directory_fts_docsize", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tokens, 0);
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), before);
        assert!(index.repair_fts_batch().unwrap());
        assert!(!index.repair_fts_batch().unwrap());
        assert!(!index.needs_fts_repair());
        before.query_plan = "trigram";
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), before);
    }

    #[test]
    fn full_fts_repair_preserves_rows_cursor_and_retry() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index
            .write_paths((0..ROW_BATCH_SIZE + 1).map(|number| format!("accepted/{number}")), None)
            .unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        index
            .writer
            .execute_batch("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all'); BEGIN")
            .unwrap();
        drop(index);
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut before = index.search("accepted", 3, false, &cancelled, false).unwrap();
        let cursor = index.fts_repair_cursor;
        let page_size: i64 = index.writer.query_row("PRAGMA page_size", [], |row| row.get(0)).unwrap();
        let free_pages: i64 = index.writer.query_row("PRAGMA freelist_count", [], |row| row.get(0)).unwrap();
        index.writer.execute_batch("CREATE TABLE pressure(payload BLOB)").unwrap();
        index
            .writer
            .execute("INSERT INTO pressure VALUES (zeroblob(?))", [(free_pages + 1) * page_size])
            .unwrap();
        let original_limit: i64 = index.writer.query_row("PRAGMA max_page_count", [], |row| row.get(0)).unwrap();
        let pages: i64 = index.writer.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        index.writer.pragma_update(None, "max_page_count", pages).unwrap();
        assert!(matches!(
            index.repair_fts_batch(),
            Err(IndexError::Sql(rusqlite::Error::SqliteFailure(code, _))) if code.code == rusqlite::ErrorCode::DiskFull
        ));
        assert_eq!(index.fts_repair_cursor, cursor);
        assert!(index.needs_fts_repair());
        let tokens: i64 = index
            .writer
            .query_row("SELECT count(*) FROM directory_fts_docsize", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tokens, 0);
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), before);
        index.writer.pragma_update(None, "max_page_count", original_limit).unwrap();
        index.writer.execute_batch("DROP TABLE pressure").unwrap();
        assert!(index.repair_fts_batch().unwrap());
        assert!(!index.repair_fts_batch().unwrap());
        assert!(!index.needs_fts_repair());
        before.query_plan = "trigram";
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), before);
    }

    #[test]
    fn ioerr_during_partial_fts_repair_preserves_rows_cursor_and_retry() {
        unsafe extern "C" fn fail_write(
            context: *mut rusqlite::ffi::sqlite3_context,
            _argument_count: std::ffi::c_int,
            _arguments: *mut *mut rusqlite::ffi::sqlite3_value,
        ) {
            // SAFETY: SQLite supplies a live context for this registered callback.
            unsafe { rusqlite::ffi::sqlite3_result_error_code(context, rusqlite::ffi::SQLITE_IOERR_WRITE) };
        }

        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index
            .write_paths((0..ROW_BATCH_SIZE + 1).map(|number| format!("accepted/{number}")), None)
            .unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        index
            .writer
            .execute_batch("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all'); BEGIN")
            .unwrap();
        drop(index);
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut before = index.search("accepted", 3, false, &cancelled, false).unwrap();
        let cursor = index.fts_repair_cursor;
        let changes_before: i64 = index.writer.query_row("SELECT total_changes()", [], |row| row.get(0)).unwrap();
        // SAFETY: The connection is live, the name is static, and the callback has no user data or destructor.
        let registered = unsafe {
            rusqlite::ffi::sqlite3_create_function_v2(
                index.writer.handle(),
                c"test_directory_ioerr".as_ptr(),
                0,
                rusqlite::ffi::SQLITE_UTF8 | rusqlite::ffi::SQLITE_INNOCUOUS,
                std::ptr::null_mut(),
                Some(fail_write),
                None,
                None,
                None,
            )
        };
        assert_eq!(registered, rusqlite::ffi::SQLITE_OK);
        index
            .writer
            .execute_batch(
                "CREATE TEMP TRIGGER fail_fts_write BEFORE INSERT ON directory_fts_docsize
                 WHEN (SELECT count(*) FROM directory_fts_docsize) > 0
                 BEGIN SELECT test_directory_ioerr(); END;",
            )
            .unwrap();
        assert!(matches!(
            index.repair_fts_batch(),
            Err(IndexError::Sql(rusqlite::Error::SqliteFailure(code, _)))
                if code.extended_code == rusqlite::ffi::SQLITE_IOERR_WRITE
        ));
        let changes_after: i64 = index.writer.query_row("SELECT total_changes()", [], |row| row.get(0)).unwrap();
        assert!(
            changes_after > changes_before,
            "The I/O error must occur after a partial token write."
        );
        assert_eq!(index.fts_repair_cursor, cursor);
        assert!(index.needs_fts_repair());
        let tokens: i64 = index
            .writer
            .query_row("SELECT count(*) FROM directory_fts_docsize", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tokens, 0);
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), before);
        index.writer.execute_batch("DROP TRIGGER fail_fts_write").unwrap();
        assert!(index.repair_fts_batch().unwrap());
        assert!(!index.repair_fts_batch().unwrap());
        assert!(!index.needs_fts_repair());
        before.query_plan = "trigram";
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), before);
    }

    #[test]
    fn refused_fts_reset_does_not_replace_rows_and_retries_after_reopen() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index
            .write_paths(["accepted/first".into(), "accepted/second".into()], None)
            .unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("accepted", 3, false, &cancelled, true).unwrap();
        index
            .writer
            .execute_batch(
                "INSERT INTO directory_fts(directory_fts) VALUES ('delete-all');
                 CREATE TRIGGER refuse_fts_reset BEFORE DELETE ON directory_fts_data
                 BEGIN SELECT RAISE(ABORT, 'Injected FTS reset refusal.'); END; BEGIN;",
            )
            .unwrap();
        drop(index);
        assert!(matches!(
            DirectoryIndex::open(&path, SourceKind::Local, &identity),
            Err(IndexError::Sql(rusqlite::Error::SqliteFailure(code, _)))
                if code.code == rusqlite::ErrorCode::ConstraintViolation
        ));
        assert!(path.is_file());
        let connection = Connection::open(&path).unwrap();
        let retained: i64 = connection
            .query_row("SELECT count(*) FROM directories", [], |row| row.get(0))
            .unwrap();
        assert_eq!(retained, before.directory_count);
        connection.execute_batch("DROP TRIGGER refuse_fts_reset").unwrap();
        drop(connection);
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        assert!(index.needs_fts_repair());
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), before);
        assert!(!index.repair_fts_batch().unwrap());
        assert!(!index.needs_fts_repair());
        assert_eq!(index.search("accepted", 3, false, &cancelled, true).unwrap(), before);
        let mut repaired = before;
        repaired.query_plan = "trigram";
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), repaired);
        drop(index);
        let reopened = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        assert!(!reopened.needs_fts_repair());
        assert_eq!(reopened.search("accepted", 3, false, &cancelled, false).unwrap(), repaired);
    }

    #[test]
    fn incremental_reclamation_preserves_results_and_verification() {
        let temporary = tempfile::tempdir().unwrap();
        let mut index = DirectoryIndex::open(
            &temporary.path().join("private").join("source.sqlite3"),
            SourceKind::Local,
            &serde_json::json!({"root": "test"}),
        )
        .unwrap();
        index
            .write_paths(
                (0..ROW_BATCH_SIZE * 2).map(|number| format!("old/{number}/{}", "long-name-".repeat(100))),
                None,
            )
            .unwrap();
        index.finish_generation(1, 0).unwrap();
        let candidate = index.prepare_scan().unwrap().0;
        index.mutate_path(&DirectoryMutation::Remove { path: "old".to_owned() }).unwrap();
        index.write_paths(["selected".to_owned()], Some(candidate)).unwrap();
        index.finish_generation(candidate, 0).unwrap();

        let before = index
            .search("selected", 3, false, &Arc::new(AtomicBool::new(false)), false)
            .unwrap();
        let pages_before: i64 = index.writer.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        let free: i64 = index.writer.query_row("PRAGMA freelist_count", [], |row| row.get(0)).unwrap();
        assert!(free > 0);
        let reader = Connection::open_with_flags(&index.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        reader.execute_batch("BEGIN; SELECT count(*) FROM directories;").unwrap();
        index.touch_access(1).unwrap();
        assert!(!index.reclaim_pages().unwrap());
        let pinned_pages: i64 = index.writer.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        assert_eq!(pinned_pages, pages_before);
        reader.execute_batch("ROLLBACK").unwrap();
        assert!(index.reclaim_pages().unwrap());
        let pages_after: i64 = index.writer.query_row("PRAGMA page_count", [], |row| row.get(0)).unwrap();
        assert!(pages_after < pages_before);
        assert_eq!(
            index
                .search("selected", 3, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap(),
            before
        );
    }

    #[test]
    fn unchanged_live_pass_has_no_content_writes() {
        const EXPECTED_METADATA_WRITES: i64 = 5;
        let temporary = tempfile::tempdir().unwrap();
        let mut index = DirectoryIndex::open(
            &temporary.path().join("private").join("unchanged.sqlite3"),
            SourceKind::Local,
            &json!({"root": "fixture"}),
        )
        .unwrap();
        let identities = HashMap::from([
            ("parent".to_owned(), 1_u64.to_le_bytes().to_vec()),
            ("parent/child".to_owned(), 2_u64.to_le_bytes().to_vec()),
        ]);
        let mut shadow_counts = None;
        for pass in 0..2 {
            if pass == 1 {
                index.writer.execute_batch("CREATE TEMP TABLE content_writes(count INTEGER); INSERT INTO content_writes VALUES (0); CREATE TEMP TABLE queue_writes(count INTEGER); INSERT INTO queue_writes VALUES (0);").unwrap();
                index
                    .writer
                    .execute_batch("CREATE TEMP TABLE metadata_writes(count INTEGER); INSERT INTO metadata_writes VALUES (0);")
                    .unwrap();
                for operation in ["INSERT", "UPDATE", "DELETE"] {
                    index.writer.execute_batch(&format!("CREATE TEMP TRIGGER count_content_{operation} AFTER {operation} ON directories BEGIN UPDATE content_writes SET count = count + 1; END;")).unwrap();
                }
                for operation in ["INSERT", "UPDATE", "DELETE"] {
                    index.writer.execute_batch(&format!("CREATE TEMP TRIGGER count_queue_{operation} AFTER {operation} ON scan_queue BEGIN UPDATE queue_writes SET count = count + 1; END;")).unwrap();
                    for table in ["generations", "source_metadata"] {
                        index.writer.execute_batch(&format!("CREATE TEMP TRIGGER count_{table}_{operation} AFTER {operation} ON {table} BEGIN UPDATE metadata_writes SET count = count + 1; END;")).unwrap();
                    }
                }
            }
            assert_eq!(index.prepare_scan().unwrap(), (1, pass == 0));
            index.seed_scan(1).unwrap();
            index
                .commit_scan_parents_with_ids(1, &[("".to_owned(), vec![("parent".to_owned(), true)])], &identities)
                .unwrap();
            index
                .commit_scan_parents_with_ids(1, &[("parent".to_owned(), vec![("parent/child".to_owned(), true)])], &identities)
                .unwrap();
            index.commit_scan_parents(1, &[("parent/child".to_owned(), vec![])]).unwrap();
            assert!(index.finish_generation(1, 0).unwrap());
            let counts = [
                "directory_fts_data",
                "directory_fts_idx",
                "directory_fts_docsize",
                "directory_fts_config",
            ]
            .map(|table| {
                index
                    .writer
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get::<_, i64>(0))
                    .unwrap()
            });
            if let Some(previous) = shadow_counts {
                assert_eq!(counts, previous);
            } else {
                shadow_counts = Some(counts);
            }
        }
        assert_eq!(
            index
                .writer
                .query_row("SELECT count FROM content_writes", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            index
                .writer
                .query_row("SELECT count FROM queue_writes", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            6
        );
        assert_eq!(
            index
                .writer
                .query_row("SELECT count FROM metadata_writes", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            EXPECTED_METADATA_WRITES
        );
        assert_eq!(
            index
                .writer
                .query_row("SELECT count(*), max(scan_pass_id) FROM generations", [], |row| Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?
                )))
                .unwrap(),
            (1, 2)
        );
    }

    #[test]
    fn content_commit_cannot_use_bookkeeping_parent_cap() {
        let temporary = tempfile::tempdir().unwrap();
        let mut index = DirectoryIndex::open(
            &temporary.path().join("private").join("content-cap.sqlite3"),
            SourceKind::Local,
            &json!({"root": "fixture"}),
        )
        .unwrap();
        let cap = super::super::directory_manager::limit("scan_commit_max_parents").unwrap();
        let parents: Vec<_> = (0..=cap).map(|number| format!("parent-{number}")).collect();
        index.write_paths(parents.clone(), None).unwrap();
        let results: Vec<_> = parents
            .into_iter()
            .map(|parent| {
                let child = format!("{parent}/child");
                (parent, vec![(child, true)])
            })
            .collect();
        assert!(index.scan_parents_have_changes(1, &results, &HashSet::new()).unwrap());
        assert!(
            matches!(index.commit_scan_parents(1, &results), Err(IndexError::Invalid(message)) if message.starts_with("Content scan commit"))
        );
        assert_eq!(index.status().unwrap().directory_count, i64::try_from(cap + 1).unwrap());
    }

    #[test]
    fn clean_shutdown_marker_tracks_open_and_unclean_drop() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("clean.sqlite3");
        let identity = json!({"root": "fixture"});
        let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        assert_eq!(
            index
                .writer
                .query_row("SELECT clean_shutdown FROM source_metadata", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(index);
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT clean_shutdown FROM source_metadata", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(connection);
        let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index.writer.execute_batch("BEGIN").unwrap();
        drop(index);
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT clean_shutdown FROM source_metadata", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    use super::*;
    use serde_json::json;

    const FIXTURES: &str = include_str!("../../../../shared/directory-index/search-fixtures.json");

    #[test]
    fn shared_fixtures_match_scan_and_trigram() {
        let fixtures: serde_json::Value = serde_json::from_str(FIXTURES).unwrap();
        assert!(search_terms(&"a".repeat(MAX_QUERY_BYTES)).is_ok());
        assert!(search_terms(&"😀".repeat(MAX_QUERY_BYTES / 4)).is_ok());
        assert!(search_terms(&"😀".repeat(MAX_QUERY_BYTES / 4 + 1)).is_err());
        let terms = (0..MAX_QUERY_TERMS).map(|number| format!("term{number}")).collect::<Vec<_>>();
        assert_eq!(search_terms(&terms.join(" ")).unwrap().len(), MAX_QUERY_TERMS);
        assert!(search_terms(&format!("{} excess", terms.join(" "))).is_err());
        for case in fixtures["normalization"].as_array().unwrap() {
            assert_eq!(
                normalize_search_text(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixtures["queries"].as_array().unwrap() {
            let mut expected: Vec<_> = case["terms"]
                .as_array()
                .unwrap()
                .iter()
                .map(|term| term.as_str().unwrap().to_owned())
                .collect();
            expected.sort();
            assert_eq!(search_terms(case["query"].as_str().unwrap()).unwrap(), expected);
        }
        let temporary = tempfile::tempdir().unwrap();
        let mut index = DirectoryIndex::open(
            &temporary.path().join("private").join("source.sqlite3"),
            SourceKind::Local,
            &json!({"root": "fixture"}),
        )
        .unwrap();
        index
            .write_paths(
                fixtures["paths"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|path| path.as_str().unwrap().to_owned()),
                None,
            )
            .unwrap();
        for case in fixtures["searches"].as_array().unwrap() {
            for force_scan in [false, true] {
                let response = index
                    .search(
                        case["query"].as_str().unwrap(),
                        MAX_RESULT_LIMIT,
                        case["include_dot"].as_bool().unwrap(),
                        &Arc::new(AtomicBool::new(false)),
                        force_scan,
                    )
                    .unwrap();
                assert_eq!(response.total_matches, case["count"].as_i64().unwrap());
                let expected: Vec<_> = case["results"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|path| path.as_str().unwrap())
                    .collect();
                assert_eq!(response.results.iter().map(|row| row.path.as_str()).collect::<Vec<_>>(), expected);
            }
        }
        index
            .write_paths(
                (0..ROW_BATCH_SIZE)
                    .map(|number| format!("single/{number}/needleone"))
                    .chain(std::iter::once("last/needleone-needletwo".to_owned())),
                None,
            )
            .unwrap();
        for force_scan in [false, true] {
            let response = index
                .search("needleone needletwo", 1, false, &Arc::new(AtomicBool::new(false)), force_scan)
                .unwrap();
            assert_eq!(response.total_matches, ROW_BATCH_SIZE as i64 + 1);
            assert_eq!(response.results.len(), 1);
            assert_eq!(response.results[0].path, "last/needleone-needletwo");
            assert_eq!(response.results[0].matched_term_count, 2);
        }
    }

    #[test]
    fn pending_scan_reads_do_not_walk_processed_prefix_or_sort_pending_jobs() {
        use std::sync::atomic::AtomicUsize;

        let temporary = tempfile::tempdir().unwrap();
        let mut index = DirectoryIndex::open(
            &temporary.path().join("private").join("source.sqlite3"),
            SourceKind::Local,
            &json!({"root": "fixture"}),
        )
        .unwrap();
        let transaction = index.writer.transaction().unwrap();
        {
            let mut statement = transaction
                .prepare("INSERT INTO scan_queue(generation_id, path, processed) VALUES (1, ?, ?)")
                .unwrap();
            for number in 0..ROW_BATCH_SIZE * 32 {
                statement.execute(params![format!("done-{number:06}"), 1]).unwrap();
            }
            for number in 0..ROW_BATCH_SIZE {
                statement.execute(params![format!("pending-{number:06}"), 0]).unwrap();
            }
        }
        transaction.commit().unwrap();
        let steps = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&steps);
        index
            .writer
            .progress_handler(
                1,
                Some(move || {
                    observed.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
        let pending = index.pending_scan_paths(1, 1).unwrap();
        index.writer.progress_handler(0, None::<fn() -> bool>).unwrap();
        assert_eq!(pending, ["pending-000000"]);
        assert!(steps.load(Ordering::Relaxed) < ROW_BATCH_SIZE);
    }

    #[test]
    fn count_has_no_discovery_cutoff() {
        check_count_and_bounded_results(100_001);
    }

    #[test]
    fn bulk_path_writes_bound_bytes_before_building_row_keys() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        let suffix = "x".repeat(SCAN_BATCH_BYTES / 2);
        index.write_paths((0..3).map(|number| format!("{number}/{suffix}")), None).unwrap();
        let status = index.search("", 3, false, &Arc::new(AtomicBool::new(false)), false).unwrap();
        assert_eq!(status.directory_count, 3);
        assert_eq!(status.accepted_revision, 3);
        assert!(matches!(
            index.write_paths(["x".repeat(SCAN_BATCH_BYTES + 1)], None),
            Err(IndexError::Invalid(_))
        ));
        assert_eq!(
            index.search("", 3, false, &Arc::new(AtomicBool::new(false)), false).unwrap(),
            status
        );
    }

    #[test]
    #[ignore = "Separate million-path capacity check; run explicitly with --ignored."]
    fn million_path_capacity() {
        check_count_and_bounded_results(1_000_001);
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "Explicit small operation-headroom measurement; not part of routine tests."]
    fn operation_headroom_measurement() {
        fn sample(namespace: &Path, peaks: &std::sync::Mutex<(u64, u64, usize)>) {
            let managed = fs::read_dir(namespace)
                .unwrap()
                .map(|entry| entry.unwrap().metadata().unwrap().len())
                .sum::<u64>();
            let descriptors = fs::read_dir("/proc/self/fd").unwrap().collect::<Result<Vec<_>, _>>().unwrap();
            let deleted = descriptors
                .iter()
                .filter_map(|entry| {
                    let target = fs::read_link(entry.path()).ok()?;
                    let target = target.to_string_lossy();
                    (target.contains("etilqs") && target.ends_with(" (deleted)"))
                        .then(|| fs::metadata(entry.path()).ok().map(|metadata| metadata.len()))
                        .flatten()
                })
                .sum::<u64>();
            let mut peaks = peaks.lock().unwrap();
            peaks.0 = peaks.0.max(managed);
            peaks.1 = peaks.1.max(deleted);
            peaks.2 = peaks.2.max(descriptors.len());
        }

        let temporary = tempfile::tempdir().unwrap();
        let namespace = temporary.path().join("private");
        let path = namespace.join("source.sqlite3");
        let second_path = namespace.join("second.sqlite3");
        let identity = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        let mut second = DirectoryIndex::open(&second_path, SourceKind::Local, &identity).unwrap();
        let peaks = Arc::new(std::sync::Mutex::new((0, 0, 0)));
        for writer in [&mut index.writer, &mut second.writer] {
            let namespace = namespace.clone();
            let peaks = Arc::clone(&peaks);
            writer
                .progress_handler(
                    SQL_PROGRESS_STEPS,
                    Some(move || {
                        sample(&namespace, &peaks);
                        false
                    }),
                )
                .unwrap();
        }
        let paths = (0..4096)
            .map(|number| format!("operation/{number:04}/repeated-token-{number:04}"))
            .collect::<Vec<_>>();
        index.write_paths(paths.iter().cloned(), None).unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        second.write_paths(paths.iter().cloned(), None).unwrap();
        assert!(second.finish_generation(1, 0).unwrap());
        let reader = open_readonly_directory_database(&path).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        let old_count: i64 = reader.query_row("SELECT COUNT(*) FROM directories", [], |row| row.get(0)).unwrap();
        let candidate = index.prepare_scan().unwrap().0;
        index.write_paths(paths.iter().cloned(), Some(candidate)).unwrap();
        index.write_paths(["operation/new".to_owned()], None).unwrap();
        assert_eq!(
            reader
                .query_row("SELECT COUNT(*) FROM directories", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            old_count
        );
        index.checkpoint_if_due().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("operation repeated", 3, false, &cancelled, false).unwrap();
        index
            .writer
            .execute("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all')", [])
            .unwrap();
        index.fts_ready.store(false, Ordering::Release);
        index.fts_repair_cursor = None;
        while index.repair_fts_batch().unwrap() {
            sample(&namespace, &peaks);
        }
        assert_eq!(index.search("operation repeated", 3, false, &cancelled, false).unwrap(), before);
        reader.execute_batch("ROLLBACK").unwrap();
        drop(reader);
        assert!(index.finish_generation(candidate, 0).unwrap());

        index.reclaim_pages().unwrap();
        drop(second);
        let lease = acquire_storage(&second_path).unwrap();
        quarantine_owned(&second_path, &lease).unwrap();
        sample(&namespace, &peaks);
        let peaks = peaks.lock().unwrap();
        eprintln!(
            "DIRECTORY_INDEX_HEADROOM_MEASUREMENT rows_per_source=4096 managed_bytes={} sql_deleted_bytes={} descriptors={}",
            peaks.0, peaks.1, peaks.2
        );
    }

    fn check_count_and_bounded_results(count: i64) {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        index
            .write_paths((0..count).map(|number| format!("directory-{number:06}")), None)
            .unwrap();
        let managed_bytes: u64 = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().metadata().unwrap().len())
            .sum();
        eprintln!("directory_index_fixture rows={count} managed_bytes={managed_bytes}");
        for query in ["directory", "ry"] {
            let response = index.search(query, 3, false, &Arc::new(AtomicBool::new(false)), false).unwrap();
            assert_eq!(response.total_matches, count);
            assert_eq!(response.directory_count, count);
            assert_eq!(response.results.len(), 3);
        }
        assert!(index.finish_generation(1, 0).unwrap());
        let cancelled = Arc::new(AtomicBool::new(false));
        let verified = index.search("", 3, false, &cancelled, false).unwrap().last_verified_at_ms;
        let candidate = index.prepare_scan().unwrap().0;
        index
            .write_paths((0..count).map(|number| format!("directory-{number:06}")), Some(candidate))
            .unwrap();
        assert_eq!(
            index.search("directory", 3, false, &cancelled, false).unwrap().directory_count,
            count
        );
        index
            .mutate_path(&DirectoryMutation::Rename {
                path: "directory-100000".into(),
                new_path: "directory-updated".into(),
            })
            .unwrap();
        assert_eq!(index.search("100000", 3, false, &cancelled, false).unwrap().total_matches, 0);
        assert_eq!(
            index.search("updated", 3, false, &cancelled, false).unwrap().results[0].path,
            "directory-updated"
        );
        assert_eq!(index.search("", 3, false, &cancelled, false).unwrap().last_verified_at_ms, verified);
        assert!(index.finish_generation(candidate, 0).unwrap());
        drop(index);
        let index = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        let response = index.search("directory", 3, false, &cancelled, false).unwrap();
        assert_eq!(response.directory_count, count);
        assert_eq!(response.total_matches, count);
        assert_eq!(index.search("100000", 3, false, &cancelled, false).unwrap().total_matches, 0);
        assert_eq!(
            index.search("updated", 3, false, &cancelled, false).unwrap().results[0].path,
            "directory-updated"
        );
    }

    #[test]
    fn schema_rollback_and_fts_cleanup() {
        let mut database = Connection::open_in_memory().unwrap();
        database.execute_batch(SCHEMA).unwrap();
        database.execute_batch(FTS_SCHEMA).unwrap();
        database
            .execute("INSERT INTO generations(id, state, coverage) VALUES (1, 'building', 'partial')", [])
            .unwrap();
        let transaction = database.transaction().unwrap();
        transaction.execute("INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) VALUES (1, 'alpha', 'alpha', 'alpha', 0, 0)", []).unwrap();
        transaction.rollback().unwrap();
        assert_eq!(
            database
                .query_row::<i64, _, _>("SELECT indexed_count FROM generations", [], |row| row.get(0))
                .unwrap(),
            0
        );
        database.execute("INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) VALUES (1, 'alpha', 'alpha', 'alpha', 0, 0)", []).unwrap();
        database.execute("DELETE FROM generations WHERE id = 1", []).unwrap();
        assert_eq!(
            database
                .query_row::<i64, _, _>("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH 'alpha'", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            0
        );
    }

    #[test]
    fn literal_queries_colliding_keys_cancellation_and_limits() {
        let temporary = tempfile::tempdir().unwrap();
        let mut index = DirectoryIndex::open(
            &temporary.path().join("private").join("source.sqlite3"),
            SourceKind::Local,
            &json!({"root": "fixture"}),
        )
        .unwrap();
        index
            .write_paths(["a%/_*/\"quoted\"".into(), "Straße".into(), "STRASSE".into()], None)
            .unwrap();
        assert_eq!(
            index
                .search("a% _* \"quoted\"", 10, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .total_matches,
            1
        );
        assert_eq!(
            index
                .search("strasse", 10, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .total_matches,
            2
        );
        assert!(matches!(
            index.search("strasse", 10, false, &Arc::new(AtomicBool::new(true)), false),
            Err(IndexError::Interrupted)
        ));
        assert!(search_terms(&"x".repeat(MAX_QUERY_BYTES + 1)).is_err());
        assert!(search_terms(
            &(0..=MAX_QUERY_TERMS)
                .map(|number| format!("term{number}"))
                .collect::<Vec<_>>()
                .join(" ")
        )
        .is_err());
        for path in ["", "/alpha", "alpha/", "a//b", "a/./b", "a/../b", "a\0b"] {
            assert!(index.write_paths([path.to_owned()], None).is_err());
        }
    }

    #[test]
    fn process_lease_is_retained_until_owner_drops() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let identity = json!({"root": "fixture"});
        let owner = DirectoryIndex::open(&path, SourceKind::Local, &identity).unwrap();
        assert!(
            matches!(DirectoryIndex::open(&path, SourceKind::Local, &identity), Err(IndexError::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
        drop(owner);
        assert!(DirectoryIndex::open(&path, SourceKind::Local, &identity).is_ok());
    }

    #[test]
    fn scan_queue_is_atomic_bounded_and_blocks_premature_completion() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index.seed_scan(1).unwrap();
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec![""]);
        assert!(index.finish_generation(1, 0).is_err());
        index.writer.execute_batch("CREATE TRIGGER reject_scan_work BEFORE INSERT ON scan_queue WHEN NEW.path = 'abort' BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        assert!(index
            .write_scan_children(1, [("alpha".to_owned(), true), ("abort".to_owned(), true)])
            .is_err());
        let unchanged = index
            .search("", MAX_RESULT_LIMIT, true, &Arc::new(AtomicBool::new(false)), false)
            .unwrap();
        assert_eq!(unchanged.directory_count, 0);
        assert_eq!(unchanged.accepted_revision, 0);
        assert!(index
            .write_scan_children(1, (0..).map(|number| (format!("directory{number}"), true)))
            .is_err());
        index
            .write_scan_children(1, [("alpha".to_owned(), true), ("alpha/beta".to_owned(), false)])
            .unwrap();
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["", "alpha"]);
        index.finish_scan_parent(1, "").unwrap();
        index.finish_scan_parent(1, "alpha").unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
    }

    #[test]
    fn unresolved_issues_block_complete_selection_and_preserve_rows() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index.write_paths(["accepted".to_owned()], None).unwrap();
        index.mark_uncertain().unwrap();
        assert!(!index.finish_generation(1, 0).unwrap());
        let response = index
            .search("accepted", MAX_RESULT_LIMIT, true, &Arc::new(AtomicBool::new(false)), false)
            .unwrap();
        assert_eq!(response.total_matches, 1);
        assert_eq!(response.coverage, "uncertain");
        assert_eq!(response.issue_count, 1);
        let (candidate, selected) = index.prepare_scan().unwrap();
        assert!(selected);
        assert_eq!(candidate, 1);
    }

    #[test]
    fn startup_event_loss_only_restarts_unobserved_empty_generation() {
        for observed in ["empty", "rows", "queue", "issue"] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("private").join("source.sqlite3");
            let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "startup-fixture"})).unwrap();
            index.mark_uncertain().unwrap();
            match observed {
                "rows" => index.write_paths(["retained".into()], None).unwrap(),
                "queue" => index.seed_scan(1).unwrap(),
                "issue" => index.record_issue(1, "access_denied").unwrap(),
                _ => {}
            }
            let (generation, selected) = index.prepare_scan().unwrap();
            assert!(selected);
            let response = index.search("", 3, false, &Arc::new(AtomicBool::new(false)), false).unwrap();
            assert_eq!(response.last_verified_at_ms, None);
            assert_eq!(generation, 1);
            assert_eq!(response.coverage, "partial");
            assert_eq!(response.issue_count, i64::from(observed == "issue"));
        }
    }

    #[test]
    fn repeated_event_loss_is_idempotent_and_recovers() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let source = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &source).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        index.write_paths(["accepted".to_owned()], None).unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        let accepted = index.search("accepted", 3, false, &cancelled, false).unwrap();
        index.mark_uncertain().unwrap();
        let uncertain = index.search("accepted", 3, false, &cancelled, false).unwrap();
        assert_eq!(uncertain.coverage, "uncertain");
        assert_eq!(uncertain.issue_count, 1);
        assert_eq!(uncertain.last_verified_at_ms, accepted.last_verified_at_ms);
        assert!(uncertain.accepted_revision > accepted.accepted_revision);
        index
            .writer
            .execute_batch("CREATE TRIGGER reject_unchanged_loss BEFORE UPDATE ON generations BEGIN SELECT RAISE(ABORT, 'injected'); END")
            .unwrap();
        for _ in 0..3 {
            index.mark_uncertain().unwrap();
            assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), uncertain);
        }
        index.writer.execute_batch("DROP TRIGGER reject_unchanged_loss").unwrap();
        let candidate = index.prepare_scan().unwrap().0;
        index.write_paths(["accepted".to_owned()], Some(candidate)).unwrap();
        assert!(index.finish_generation(candidate, 0).unwrap());
        let recovered = index.search("accepted", 3, false, &cancelled, false).unwrap();
        assert_eq!(recovered.coverage, "complete");
        assert_eq!(recovered.issue_count, 0);
        index.mark_uncertain().unwrap();
        let lost_again = index.search("accepted", 3, false, &cancelled, false).unwrap();
        assert_eq!(lost_again.coverage, "uncertain");
        assert_eq!(lost_again.issue_count, 1);
        assert!(lost_again.accepted_revision > recovered.accepted_revision);
        drop(index);
        let reopened = DirectoryIndex::open(&path, SourceKind::Local, &source).unwrap();
        assert_eq!(reopened.search("accepted", 3, false, &cancelled, false).unwrap(), lost_again);
    }

    #[test]
    fn failed_event_loss_rolls_back_issue_metadata_and_revision() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        index.write_paths(["accepted".to_owned()], None).unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        let before = index.search("accepted", 3, false, &cancelled, false).unwrap();
        index
            .writer
            .execute_batch(
                "CREATE TRIGGER reject_loss_revision BEFORE UPDATE ON source_metadata BEGIN SELECT RAISE(ABORT, 'injected'); END",
            )
            .unwrap();
        assert!(index.mark_uncertain().is_err());
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap(), before);
        let issues: i64 = index
            .writer
            .query_row("SELECT count(*) FROM coverage_issues", [], |row| row.get(0))
            .unwrap();
        assert_eq!(issues, 0);
        index.writer.execute_batch("DROP TRIGGER reject_loss_revision").unwrap();
        index.mark_uncertain().unwrap();
        assert_eq!(index.search("accepted", 3, false, &cancelled, false).unwrap().issue_count, 1);
    }

    #[test]
    fn failed_generation_issue_counts_agree_with_rows() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        assert!(index.finish_generation(1, 3).unwrap());
        let response = index
            .search("", MAX_RESULT_LIMIT, true, &Arc::new(AtomicBool::new(false)), false)
            .unwrap();
        let aggregate: i64 = index
            .writer
            .query_row("SELECT sum(count) FROM coverage_issues WHERE generation_id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(response.issue_count, 3);
        assert_eq!(aggregate, 3);
    }

    #[test]
    fn independent_reader_sees_commits_without_borrowing_the_writer() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        let reader = index.reader();
        index.write_paths(["visible".to_owned()], None).unwrap();
        let result = std::thread::spawn(move || reader.search("visible", MAX_RESULT_LIMIT, true, &Arc::new(AtomicBool::new(false)), false))
            .join()
            .unwrap()
            .unwrap();
        assert_eq!(result.total_matches, 1);
    }

    #[test]
    fn subtree_mutations_reach_candidates_and_rollback_on_collision() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index
            .write_paths(["alpha".to_owned(), "alpha/beta".to_owned(), "occupied".to_owned()], None)
            .unwrap();
        index.finish_generation(1, 0).unwrap();
        let candidate = index.prepare_scan().unwrap().0;
        index
            .write_paths(["alpha".to_owned(), "alpha/beta".to_owned()], Some(candidate))
            .unwrap();
        let cancellation = Arc::new(AtomicBool::new(false));
        let verified = index
            .search("", MAX_RESULT_LIMIT, true, &cancellation, false)
            .unwrap()
            .last_verified_at_ms;
        index
            .mutate_path(&DirectoryMutation::Rename {
                path: "alpha".to_owned(),
                new_path: "archive".to_owned(),
            })
            .unwrap();
        let renamed = index.search("archive", MAX_RESULT_LIMIT, true, &cancellation, false).unwrap();
        assert_eq!(renamed.total_matches, 2);
        assert_eq!(renamed.last_verified_at_ms, verified);
        assert!(index
            .mutate_path(&DirectoryMutation::Rename {
                path: "archive".to_owned(),
                new_path: "occupied".to_owned()
            })
            .is_err());
        assert_eq!(
            index.search("archive", MAX_RESULT_LIMIT, true, &cancellation, false).unwrap(),
            renamed
        );
        let candidate_matches: i64 = index
            .writer
            .query_row(
                "SELECT count(*) FROM directories WHERE generation_id = ? AND path LIKE 'archive%'",
                [candidate],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(candidate_matches, 2);
        index
            .mutate_path(&DirectoryMutation::Remove {
                path: "archive".to_owned(),
            })
            .unwrap();
        assert_eq!(
            index
                .search("archive", MAX_RESULT_LIMIT, true, &cancellation, false)
                .unwrap()
                .total_matches,
            0
        );
        index.mutate_path(&DirectoryMutation::Add { path: "new".to_owned() }).unwrap();
        assert_eq!(
            index
                .search("new", MAX_RESULT_LIMIT, true, &cancellation, false)
                .unwrap()
                .total_matches,
            1
        );
    }

    #[test]
    fn accepted_parent_reconciliation_queues_only_new_subtrees() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let source = json!({"root": "fixture"});
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &source).unwrap();
        index.write_paths(["parent".into(), "parent/existing".into()], None).unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("parent", 3, false, &cancelled, false).unwrap();
        assert!(index.write_scan_children(1, [("parent/unowned".into(), false)]).is_err());
        assert!(index
            .write_reconciliation_children(1, "parent", [("parent/unowned".into(), false)])
            .is_err());
        index.queue_reconciliation_parent(1, "parent").unwrap();
        assert_eq!(index.search("parent", 3, false, &cancelled, false).unwrap(), before);
        drop(index);
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &source).unwrap();
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["parent"]);
        index
            .write_reconciliation_children(1, "parent", [("parent/existing".into(), true), ("parent/new".into(), true)])
            .unwrap();
        let after = index.search("parent", 3, false, &cancelled, false).unwrap();
        assert_eq!(after.directory_count, 3);
        assert_eq!(after.accepted_revision, before.accepted_revision + 1);
        assert_eq!(after.last_verified_at_ms, before.last_verified_at_ms);
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["parent", "parent/new"]);
        index
            .write_reconciliation_children(1, "parent", [("parent/existing".into(), true), ("parent/new".into(), true)])
            .unwrap();
        assert_eq!(index.search("parent", 3, false, &cancelled, false).unwrap(), after);
        index
            .write_reconciliation_children(1, "parent/new", [("parent/new/child".into(), false)])
            .unwrap();
        index.finish_reconciliation_parent(1, "parent/new").unwrap();
        index.finish_reconciliation_parent(1, "parent").unwrap();
        index.queue_reconciliation_parent(1, "parent").unwrap();
        let before_repeat = index.search("parent", 3, false, &cancelled, false).unwrap();
        index
            .write_reconciliation_children(1, "parent", [("parent/new".into(), true)])
            .unwrap();
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["parent"]);
        assert_eq!(index.search("parent", 3, false, &cancelled, false).unwrap(), before_repeat);
        assert_eq!(before_repeat.directory_count, 4);
        assert_eq!(before_repeat.last_verified_at_ms, before.last_verified_at_ms);
    }

    #[test]
    fn accepted_parent_reconciliation_rejects_stale_and_unrelated_work() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        assert!(index.queue_reconciliation_parent(1, "").is_err());
        index.write_paths(["parent".into()], None).unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        index.queue_reconciliation_parent(1, "parent").unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("parent other", 3, false, &cancelled, false).unwrap();
        for invalid in ["other/child", "parent", "parent/deep/child"] {
            assert!(index
                .write_reconciliation_children(1, "parent", [("parent/safe".into(), false), (invalid.into(), false)])
                .is_err());
            assert_eq!(index.search("parent other", 3, false, &cancelled, false).unwrap(), before);
        }
        assert!(index
            .write_reconciliation_children(1, "parent", (0..=ROW_BATCH_SIZE).map(|number| (format!("parent/{number}"), false)))
            .is_err());
        assert_eq!(index.search("parent other", 3, false, &cancelled, false).unwrap(), before);
        index.finish_reconciliation_parent(1, "parent").unwrap();
        assert!(index.finish_reconciliation_parent(1, "parent").is_err());
        assert!(index
            .write_reconciliation_children(1, "parent", [("parent/late".into(), false)])
            .is_err());
        index.queue_reconciliation_parent(1, "parent").unwrap();
        let candidate = index.prepare_scan().unwrap().0;
        assert!(index.queue_reconciliation_parent(candidate, "parent").is_err());
        assert!(index
            .write_reconciliation_children(candidate, "parent", [("parent/late".into(), false)])
            .is_err());
        assert!(index.finish_reconciliation_parent(candidate, "parent").is_err());
        index.write_paths(["replacement".into()], Some(candidate)).unwrap();
        index.finish_scan_parent(candidate, "parent").unwrap();
        assert!(index.finish_generation(candidate, 0).unwrap());
        let selected = index.search("replacement parent", 3, false, &cancelled, false).unwrap();
        for generation in [candidate + 1, i64::MAX] {
            assert!(index.queue_reconciliation_parent(generation, "parent").is_err());
            assert!(index
                .write_reconciliation_children(generation, "parent", [("parent/late".into(), false)])
                .is_err());
            assert!(index.finish_reconciliation_parent(generation, "parent").is_err());
            assert_eq!(index.search("replacement parent", 3, false, &cancelled, false).unwrap(), selected);
        }
    }

    #[test]
    fn accepted_parent_reconciliation_bounds_bytes_and_root_children() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index.write_paths(["existing".into()], None).unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        index.queue_reconciliation_parent(1, "").unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("existing root", 3, false, &cancelled, false).unwrap();
        let mut consumed = 0;
        let children = [
            "a".repeat(SCAN_BATCH_BYTES / 2),
            "b".repeat(SCAN_BATCH_BYTES / 2 + 1),
            "not-consumed".into(),
        ];
        assert!(index
            .write_reconciliation_children(
                1,
                "",
                children.into_iter().map(|path| {
                    consumed += 1;
                    (path, true)
                })
            )
            .is_err());
        assert_eq!(consumed, 2);
        assert_eq!(index.search("existing root", 3, false, &cancelled, false).unwrap(), before);
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec![""]);
        assert!(index
            .write_reconciliation_children(1, "", [("root-child".into(), true), ("nested/child".into(), false)])
            .is_err());
        assert_eq!(index.search("existing root", 3, false, &cancelled, false).unwrap(), before);
        index.write_reconciliation_children(1, "", [("root-child".into(), true)]).unwrap();
        index.finish_reconciliation_parent(1, "").unwrap();
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["root-child"]);
        let after = index.search("existing root", 3, false, &cancelled, false).unwrap();
        assert_eq!(after.directory_count, 2);
        assert_eq!(after.last_verified_at_ms, before.last_verified_at_ms);
    }

    #[test]
    fn observed_mutations_queue_accepted_parents_atomically() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index
            .write_paths(["from".into(), "from/moved".into(), "from/moved/child".into(), "to".into()], None)
            .unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("from to", 3, false, &cancelled, false).unwrap();
        let rename = DirectoryMutation::Rename {
            path: "from/moved".into(),
            new_path: "to/moved".into(),
        };
        index.writer.execute_batch("CREATE TRIGGER reject_owned_parent BEFORE INSERT ON scan_queue WHEN NEW.generation_id = 1 AND NEW.path = 'to' BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        assert!(index.mutate_observed_path(&rename).is_err());
        assert_eq!(index.search("from to", 3, false, &cancelled, false).unwrap(), before);
        assert!(index.reconciliation_generation().unwrap().is_none());
        assert!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap().is_empty());
        index.writer.execute_batch("DROP TRIGGER reject_owned_parent").unwrap();
        index.mutate_observed_path(&rename).unwrap();
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["from", "to", "to/moved"]);
        assert_eq!(index.reconciliation_generation().unwrap(), Some(1));
        let after = index.search("from to", 3, false, &cancelled, false).unwrap();
        assert_eq!(after.directory_count, before.directory_count);
        assert_eq!(after.last_verified_at_ms, before.last_verified_at_ms);
        assert_eq!(index.search("from/moved", 3, false, &cancelled, false).unwrap().total_matches, 0);
        index
            .mutate_observed_path(&DirectoryMutation::Add { path: "to/fresh".into() })
            .unwrap();
        let mut pending = index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap();
        pending.sort_unstable();
        assert_eq!(pending, ["from", "to", "to/fresh", "to/moved"]);
        index
            .mutate_observed_path(&DirectoryMutation::Remove { path: "to/fresh".into() })
            .unwrap();
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["from", "to", "to/moved"]);
        assert_eq!(
            index.search("from to", 3, false, &cancelled, false).unwrap().last_verified_at_ms,
            before.last_verified_at_ms
        );
    }

    #[test]
    fn failed_accepted_parent_reconciliation_rolls_back_rows_and_work() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index.write_paths(["parent".into()], None).unwrap();
        assert!(index.finish_generation(1, 0).unwrap());
        index.queue_reconciliation_parent(1, "parent").unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("parent", 3, false, &cancelled, false).unwrap();
        for trigger in [
            "CREATE TRIGGER reject_reconciliation BEFORE INSERT ON scan_queue WHEN NEW.path = 'parent/abort' BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            "CREATE TRIGGER reject_reconciliation BEFORE UPDATE ON source_metadata BEGIN SELECT RAISE(ABORT, 'injected'); END;",
        ] {
            index.writer.execute_batch(trigger).unwrap();
            assert!(index.write_reconciliation_children(1, "parent", [("parent/abort".into(), true)]).is_err());
            assert_eq!(index.search("parent", 3, false, &cancelled, false).unwrap(), before);
            assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["parent"]);
            index.writer.execute_batch("DROP TRIGGER reject_reconciliation").unwrap();
        }
        index
            .write_reconciliation_children(1, "parent", [("parent/abort".into(), true)])
            .unwrap();
        assert_eq!(index.search("parent", 3, false, &cancelled, false).unwrap().directory_count, 2);
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["parent", "parent/abort"]);
    }

    #[test]
    fn subtree_mutations_update_pending_scan_paths_transactionally() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index.seed_scan(1).unwrap();
        index
            .write_scan_children(
                1,
                [
                    ("alpha".to_owned(), true),
                    ("alpha/child".to_owned(), true),
                    ("other".to_owned(), true),
                ],
            )
            .unwrap();
        index.finish_scan_parent(1, "alpha").unwrap();
        index
            .mutate_path(&DirectoryMutation::Rename {
                path: "alpha".to_owned(),
                new_path: "beta".to_owned(),
            })
            .unwrap();
        assert_eq!(
            index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(),
            vec!["", "beta", "beta/child", "other"]
        );
        index.mutate_path(&DirectoryMutation::Remove { path: "beta".to_owned() }).unwrap();
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["", "other"]);
        assert_eq!(
            index
                .search("alpha beta", MAX_RESULT_LIMIT, true, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .total_matches,
            0
        );
    }

    #[test]
    fn direct_child_pages_preserve_original_names_and_byte_bounds() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index
            .write_paths(
                [
                    "root%_/a/one",
                    "root%_/a/two",
                    "root%_/a-b",
                    "root%_/b/child",
                    "root%_-other/leak",
                    "é/x",
                    "e\u{0301}/y",
                ]
                .map(str::to_owned),
                None,
            )
            .unwrap();
        assert_eq!(
            index.direct_child_paths(1, "root%_", None, 18).unwrap(),
            vec!["root%_/a", "root%_/a-b"]
        );
        assert_eq!(
            index.direct_child_paths(1, "root%_", Some("root%_/a-b"), 18).unwrap(),
            vec!["root%_/b"]
        );
        assert!(index
            .direct_child_paths(1, "root%_", Some("root%_/b"), SCAN_BATCH_BYTES)
            .unwrap()
            .is_empty());
        assert_eq!(
            index.direct_child_paths(1, "", None, SCAN_BATCH_BYTES).unwrap(),
            vec!["e\u{0301}", "root%_", "root%_-other", "é"]
        );
        assert!(index
            .direct_child_paths(1, "root%_", Some("other/child"), SCAN_BATCH_BYTES)
            .is_err());
        assert!(index.direct_child_paths(1, "root%_", None, 1).is_err());
        index
            .write_paths((0..ROW_BATCH_SIZE * 2 + 1).map(|number| format!("many/{number:06}")), None)
            .unwrap();
        let mut cursor: Option<String> = None;
        let mut count = 0;
        loop {
            let page = index.direct_child_paths(1, "many", cursor.as_deref(), SCAN_BATCH_BYTES).unwrap();
            assert!(page.len() <= ROW_BATCH_SIZE);
            if page.is_empty() {
                break;
            }
            count += page.len();
            cursor = page.last().cloned();
        }
        assert_eq!(count, ROW_BATCH_SIZE * 2 + 1);
    }

    #[test]
    fn direct_child_pages_match_sorted_reference_with_interleaved_descendants() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        let mut names = [
            "a",
            "a!",
            "a!a",
            "a!b",
            "a-b",
            "a.",
            "a0",
            "a !",
            "a a",
            "aä",
            "!a",
            "!a!",
            "é",
            "zzzzzzzzzzzzzzzzzzzz",
        ];
        names.sort_unstable();
        index
            .write_paths(names.iter().rev().map(|name| format!("parent/{name}/leaf")), None)
            .unwrap();
        for maximum_bytes in [8, 9, 10, 12, 16, 24, 64] {
            for after_path in [None, Some("parent/a"), Some("parent/a-b"), Some("parent/a0")] {
                let mut expected = Vec::new();
                let mut bytes = 0;
                let mut oversized = false;
                for name in names {
                    let path = format!("parent/{name}");
                    if after_path.is_some_and(|after| path.as_str() <= after) {
                        continue;
                    }
                    if path.len() > maximum_bytes {
                        oversized = true;
                        break;
                    }
                    if bytes + path.len() > maximum_bytes {
                        break;
                    }
                    bytes += path.len();
                    expected.push(path);
                }
                let page = index.direct_child_paths(1, "parent", after_path, maximum_bytes);
                if oversized {
                    assert!(matches!(page, Err(IndexError::Invalid(_))));
                } else {
                    assert_eq!(page.unwrap(), expected);
                }
            }
        }
    }

    #[test]
    fn direct_child_pages_stop_before_reading_the_remaining_flat_tree() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        let row_count = ROW_BATCH_SIZE * 32;
        index
            .write_paths((0..row_count).map(|number| format!("parent/{number:06}")), None)
            .unwrap();
        let steps = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&steps);
        index
            .writer
            .progress_handler(
                1,
                Some(move || {
                    counter.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
        let page = index.direct_child_paths(1, "parent", None, SCAN_BATCH_BYTES);
        index.writer.progress_handler(0, None::<fn() -> bool>).unwrap();
        let page = page.unwrap();
        assert_eq!(page.len(), ROW_BATCH_SIZE);
        assert_eq!(page.last().unwrap(), &format!("parent/{:06}", ROW_BATCH_SIZE - 1));
        assert!(steps.load(Ordering::Relaxed) < row_count);
    }

    #[test]
    fn missing_subtree_pruning_is_bounded_and_preserves_verification() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        let paths: Vec<_> = std::iter::once("gone".to_owned())
            .chain((0..ROW_BATCH_SIZE * 2).map(|number| format!("gone/{number:06}")))
            .collect();
        index
            .write_paths(paths.iter().cloned().chain(["gone-other".into(), "keep".into()]), None)
            .unwrap();
        index.finish_generation(1, 0).unwrap();
        index
            .writer
            .execute("UPDATE directories SET id = -1 WHERE path = 'gone'", [])
            .unwrap();
        for path in &paths {
            index
                .writer
                .execute("INSERT INTO scan_queue(generation_id, path) VALUES (1, ?)", [path])
                .unwrap();
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("keep", 3, false, &cancelled, false).unwrap();
        let mut remaining = true;
        let mut passes = 0;
        while remaining {
            let previous = index.search("keep", 3, false, &cancelled, false).unwrap().directory_count;
            remaining = index.prune_subtree_batch(1, "gone").unwrap();
            let after = index.search("keep", 3, false, &cancelled, false).unwrap();
            assert!(previous - after.directory_count > 0);
            assert!(previous - after.directory_count <= ROW_BATCH_SIZE as i64);
            assert_eq!(after.last_verified_at_ms, before.last_verified_at_ms);
            assert_eq!(
                index.search("gone-other keep", 3, false, &cancelled, false).unwrap().total_matches,
                2
            );
            passes += 1;
        }
        assert_eq!(passes, 3);
        assert!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap().is_empty());
        let completed = index.search("keep", 3, false, &cancelled, false).unwrap();
        assert!(!index.prune_subtree_batch(1, "gone").unwrap());
        assert_eq!(index.search("keep", 3, false, &cancelled, false).unwrap(), completed);
    }

    #[test]
    fn failed_missing_subtree_pruning_rolls_back_rows_queue_and_revision() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index
            .write_paths(["gone".into(), "gone/child".into(), "keep".into()], None)
            .unwrap();
        index
            .writer
            .execute("INSERT INTO scan_queue(generation_id, path) VALUES (1, 'gone')", [])
            .unwrap();
        index
            .writer
            .execute_batch("CREATE TRIGGER reject_prune_queue BEFORE DELETE ON scan_queue BEGIN SELECT RAISE(ABORT, 'injected'); END;")
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let before = index.search("gone keep", 3, false, &cancelled, false).unwrap();
        assert!(index.prune_subtree_batch(1, "gone").is_err());
        assert_eq!(index.search("gone keep", 3, false, &cancelled, false).unwrap(), before);
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["gone"]);
        assert!(index.prune_subtree_batch(2, "gone").is_err());
        assert!(index.prune_subtree_batch(1, "").is_err());
        index.writer.execute_batch("DROP TRIGGER reject_prune_queue;").unwrap();
        let active = index.prepare_scan().unwrap().0;
        index.write_paths(["gone".into(), "gone/child".into()], Some(active)).unwrap();
        assert!(!index.prune_subtree_batch(active, "gone").unwrap());
        assert_eq!(index.search("gone keep", 3, false, &cancelled, false).unwrap().total_matches, 1);
    }

    #[test]
    fn parent_read_hints_queue_work_without_inserting_directory_names() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        let candidate = index.prepare_scan().unwrap().0;
        for parent in ["", "parent"] {
            index.mutate_path(&DirectoryMutation::ReadParent { path: parent.into() }).unwrap();
        }
        for generation in [1, candidate] {
            assert_eq!(index.pending_scan_paths(generation, ROW_BATCH_SIZE).unwrap(), vec!["", "parent"]);
        }
        assert_eq!(
            index
                .search("parent", 3, false, &Arc::new(AtomicBool::new(false)), false)
                .unwrap()
                .directory_count,
            0
        );
        assert!(index
            .mutate_path(&DirectoryMutation::ReadParent { path: "../outside".into() })
            .is_err());
    }

    #[test]
    fn scan_queue_rename_collision_rolls_back_directory_changes() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("source.sqlite3");
        let mut index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        index.seed_scan(1).unwrap();
        index
            .write_scan_children(1, [("alpha".to_owned(), true), ("occupied".to_owned(), true)])
            .unwrap();
        index
            .mutate_path(&DirectoryMutation::Remove {
                path: "occupied".to_owned(),
            })
            .unwrap();
        index
            .writer
            .execute("INSERT INTO scan_queue(generation_id, path) VALUES (1, 'occupied')", [])
            .unwrap();
        let cancellation = Arc::new(AtomicBool::new(false));
        let previous = index
            .search("alpha occupied", MAX_RESULT_LIMIT, true, &cancellation, false)
            .unwrap();
        assert!(index
            .mutate_path(&DirectoryMutation::Rename {
                path: "alpha".to_owned(),
                new_path: "occupied".to_owned()
            })
            .is_err());
        assert_eq!(
            index
                .search("alpha occupied", MAX_RESULT_LIMIT, true, &cancellation, false)
                .unwrap(),
            previous
        );
        assert_eq!(index.pending_scan_paths(1, ROW_BATCH_SIZE).unwrap(), vec!["", "alpha", "occupied"]);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_public_storage_and_symbolic_links() {
        let temporary = tempfile::tempdir().unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(DirectoryIndex::open(&temporary.path().join("source.sqlite3"), SourceKind::Local, &json!({})).is_err());
        let link = temporary.path().join("link");
        std::os::unix::fs::symlink(temporary.path(), &link).unwrap();
        assert!(DirectoryIndex::open(&link.join("source.sqlite3"), SourceKind::Local, &json!({})).is_err());
    }

    #[test]
    #[ignore = "Requires the backend test interpreter; run this compatibility test explicitly."]
    fn opens_python_created_database_through_source_validation() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        let executable = std::env::var_os("SAMBEE_INDEX_TEST_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("backend/.venv/bin/python"));
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("private").join("python.sqlite3");
        let status = std::process::Command::new(&executable)
            .env("PYTHONPATH", root.join("backend"))
            .args(["-c", "import sys; from pathlib import Path; from app.services.directory_index import DirectoryIndex; store = DirectoryIndex(Path(sys.argv[1]), source_kind='local', source_identity={'root': 'fixture'}); store.open(); store.write_paths(['alpha/beta', 'beta', 'neither']); store.finish_generation(1); store.close()"])
            .arg(&path).status().expect("Backend test interpreter could not run. Set SAMBEE_INDEX_TEST_PYTHON to its executable path.");
        assert!(status.success());
        assert!(DirectoryIndex::open(&path, SourceKind::Smb, &json!({"root": "fixture"})).is_err());
        let index = DirectoryIndex::open(&path, SourceKind::Local, &json!({"root": "fixture"})).unwrap();
        let locked_status = std::process::Command::new(&executable)
            .env("PYTHONPATH", root.join("backend"))
            .args(["-c", "import sys; from pathlib import Path; from app.services.directory_index import DirectoryIndex; store = DirectoryIndex(Path(sys.argv[1]), source_kind='local', source_identity={'root': 'fixture'})\ntry:\n store.open()\nexcept BlockingIOError:\n pass\nelse:\n store.close(); raise SystemExit('Rust process lease did not exclude Python')"])
            .arg(&path).status().expect("Backend test interpreter could not run the lease compatibility check.");
        assert!(locked_status.success());
        let response = index
            .search("alpha beta", 10, false, &Arc::new(AtomicBool::new(false)), false)
            .unwrap();
        assert_eq!(response.total_matches, 2);
        assert_eq!(response.directory_count, 3);
        assert_eq!(response.results[0].path, "alpha/beta");
    }
}
