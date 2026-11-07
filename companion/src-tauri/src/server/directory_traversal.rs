//! Descriptor-based traversal; unsupported platforms fail closed without a lossy walker.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use super::directory_index::IndexError;

pub(super) const MOUNT_BOUNDARY_CAPABILITY_ERROR: &str =
    "The kernel cannot check directory mount boundaries. Restart the companion after enabling statx mount IDs or /proc/self/fdinfo.";

#[derive(Default)]
pub struct NativeIo {
    opens: AtomicU64,
    #[cfg(test)]
    pub(super) read_gate: std::sync::Mutex<Option<std::sync::Arc<std::sync::Barrier>>>,
    #[cfg(all(test, target_os = "linux"))]
    pub(super) parent_read_gate: std::sync::Mutex<Option<std::sync::Arc<std::sync::Barrier>>>,
    #[cfg(all(test, target_os = "linux"))]
    force_unknown_entry_types: std::sync::atomic::AtomicBool,
    #[cfg(all(test, target_os = "linux"))]
    unknown_entry_checks: AtomicU64,
}

impl NativeIo {
    pub fn opens(&self) -> u64 {
        self.opens.load(Ordering::Relaxed)
    }

    fn record_open(&self) {
        self.opens.fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct RootProbeState {
    requested: AtomicU64,
    verified: AtomicU64,
}

impl RootProbeState {
    fn require(&self) -> u64 {
        self.requested.fetch_add(1, Ordering::AcqRel).wrapping_add(1)
    }

    fn needed(&self) -> bool {
        self.requested.load(Ordering::Acquire) != self.verified.load(Ordering::Acquire)
    }

    fn complete(&self, version: u64) {
        self.verified.store(version, Ordering::Release);
    }
}

fn validate_traversal_path(path: &Path) -> Result<(), IndexError> {
    let maximum_bytes = super::directory_manager::limit("max_source_path_bytes")?;
    let maximum_depth = super::directory_manager::limit("max_source_depth")?;
    if path.as_os_str().as_encoded_bytes().len() > maximum_bytes
        || path
            .components()
            .filter(|component| matches!(component, std::path::Component::Normal(_)))
            .count()
            > maximum_depth
    {
        return Err(IndexError::Invalid(
            "Directory path exceeds supported traversal bounds. Shorten the path or reduce nesting, then reopen the drive.",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TraversalIssue {
    AccessDenied,
    UnsupportedEncoding,
    UnsafeTraversal,
    ScanFailed,
    UnsafeDirectory(String),
    UnsupportedDirectoryName(String),
}

impl TraversalIssue {
    pub fn code(&self) -> &'static str {
        match self {
            Self::AccessDenied => "access_denied",
            Self::UnsupportedEncoding | Self::UnsupportedDirectoryName(_) => "unsupported_encoding",
            Self::UnsafeTraversal | Self::UnsafeDirectory(_) => "unsafe_traversal",
            Self::ScanFailed => "scan_failed",
        }
    }

    pub fn name(&self) -> Option<&str> {
        match self {
            Self::UnsafeDirectory(name) | Self::UnsupportedDirectoryName(name) => Some(name),
            _ => None,
        }
    }
}

pub(super) fn source_error(error: IndexError) -> IndexError {
    match error {
        IndexError::Io(error) => {
            if matches!(
                error.kind(),
                std::io::ErrorKind::Interrupted
                    | std::io::ErrorKind::TimedOut
                    | std::io::ErrorKind::NotConnected
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::NetworkDown
                    | std::io::ErrorKind::NetworkUnreachable
                    | std::io::ErrorKind::HostUnreachable
                    | std::io::ErrorKind::OutOfMemory
                    | std::io::ErrorKind::StorageFull
            ) || source_resource_error(&error)
            {
                return IndexError::Io(error);
            }
            IndexError::SourceItem(match error.kind() {
                std::io::ErrorKind::PermissionDenied => TraversalIssue::AccessDenied.code(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => TraversalIssue::ScanFailed.code(),
                _ => TraversalIssue::ScanFailed.code(),
            })
        }
        IndexError::Invalid(message) if message != MOUNT_BOUNDARY_CAPABILITY_ERROR => {
            IndexError::SourceItem(TraversalIssue::UnsafeTraversal.code())
        }
        _ => error,
    }
}

fn source_resource_error(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        matches!(
            error.raw_os_error(),
            Some(libc::EMFILE | libc::ENFILE | libc::ENOMEM | libc::ENOSPC)
        )
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{
            ERROR_BAD_NETPATH, ERROR_DISK_FULL, ERROR_LOGON_FAILURE, ERROR_NETNAME_DELETED, ERROR_NOT_ENOUGH_MEMORY,
            ERROR_NO_SYSTEM_RESOURCES, ERROR_TOO_MANY_OPEN_FILES,
        };
        error.raw_os_error().is_some_and(|code| {
            [
                ERROR_BAD_NETPATH,
                ERROR_DISK_FULL,
                ERROR_LOGON_FAILURE,
                ERROR_NETNAME_DELETED,
                ERROR_NO_SYSTEM_RESOURCES,
                ERROR_NOT_ENOUGH_MEMORY,
                ERROR_TOO_MANY_OPEN_FILES,
            ]
            .iter()
            .any(|value| code == value.0 as i32)
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = error;
        false
    }
}

#[cfg(test)]
mod source_error_tests {
    use super::*;

    #[test]
    fn source_classifier_preserves_connection_resource_and_storage_errors() {
        for kind in [
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::NotConnected,
            std::io::ErrorKind::OutOfMemory,
            std::io::ErrorKind::StorageFull,
        ] {
            assert!(matches!(
                source_error(IndexError::Io(std::io::Error::from(kind))),
                IndexError::Io(_)
            ));
        }
        assert!(matches!(source_error(IndexError::Interrupted), IndexError::Interrupted));
        assert!(matches!(
            source_error(IndexError::StoragePaused("fixture")),
            IndexError::StoragePaused(_)
        ));
        for (kind, expected) in [
            (std::io::ErrorKind::PermissionDenied, "access_denied"),
            (std::io::ErrorKind::Other, "scan_failed"),
            (std::io::ErrorKind::NotFound, "scan_failed"),
            (std::io::ErrorKind::NotADirectory, "scan_failed"),
        ] {
            assert!(matches!(source_error(IndexError::Io(std::io::Error::from(kind))), IndexError::SourceItem(code) if code == expected));
        }
        #[cfg(unix)]
        for code in [libc::EMFILE, libc::ENFILE, libc::ENOMEM, libc::ENOSPC] {
            assert!(
                matches!(source_error(IndexError::Io(std::io::Error::from_raw_os_error(code))), IndexError::Io(error) if error.raw_os_error() == Some(code))
            );
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
pub struct NativeIdentity {
    device: u64,
    inode: u64,
    mount: u64,
}

impl NativeIdentity {
    pub fn file_id(self) -> Vec<u8> {
        #[cfg(windows)]
        {
            [self.inode.to_le_bytes(), self.mount.to_le_bytes()].concat()
        }
        #[cfg(not(windows))]
        {
            self.inode.to_le_bytes().to_vec()
        }
    }
}

pub type NativeChild = (String, bool, Option<Vec<u8>>);

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WindowsReparseKind {
    Ordinary,
    Redirection,
    CloudPlaceholder,
    Unsupported,
}

#[cfg(any(windows, test))]
fn windows_reparse_kind(tag: u32) -> WindowsReparseKind {
    const NAME_SURROGATE: u32 = 0x2000_0000;
    const CLOUD_TAG: u32 = 0x9000_001a;
    const CLOUD_VARIANT_MASK: u32 = 0xffff_0fff;
    const ONEDRIVE_TAG: u32 = 0x8000_0021;

    if tag == 0 {
        WindowsReparseKind::Ordinary
    } else if tag & NAME_SURROGATE != 0 {
        WindowsReparseKind::Redirection
    } else if tag & CLOUD_VARIANT_MASK == CLOUD_TAG || tag == ONEDRIVE_TAG {
        WindowsReparseKind::CloudPlaceholder
    } else {
        WindowsReparseKind::Unsupported
    }
}

#[cfg(any(windows, test))]
fn validate_windows_component(name: &str) -> Result<(), IndexError> {
    super::directory_index::validate_directory_path(name)?;
    if name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) || name.ends_with(['.', ' ']) || name.chars().any(char::is_control) {
        return Err(IndexError::Invalid(
            "Directory name cannot round-trip through the Windows path API. Source coverage is incomplete.",
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn windows_entry_name(native: &[u16]) -> Result<String, TraversalIssue> {
    let name = String::from_utf16(native).map_err(|_| TraversalIssue::UnsupportedEncoding)?;
    validate_windows_component(&name).map_err(|_| TraversalIssue::UnsupportedEncoding)?;
    Ok(name)
}

#[cfg(any(windows, test))]
fn windows_record_name_range(
    remaining: usize,
    next_offset: usize,
    name_offset: usize,
    name_bytes: usize,
) -> Result<std::ops::Range<usize>, IndexError> {
    let record_bytes = if next_offset == 0 { remaining } else { next_offset };
    if name_bytes == 0
        || !name_bytes.is_multiple_of(size_of::<u16>())
        || record_bytes > remaining
        || record_bytes < name_offset
        || name_bytes > record_bytes - name_offset
        || (next_offset != 0 && !record_bytes.is_multiple_of(size_of::<u64>()))
    {
        return Err(IndexError::Invalid(
            "Directory enumeration returned an invalid native name record. Retry verification.",
        ));
    }
    Ok(name_offset..name_offset + name_bytes)
}

#[cfg(test)]
mod windows_policy_tests {
    use super::*;

    #[test]
    fn traversal_bounds_preserve_exact_depth_and_utf8_byte_limits_before_native_io() {
        let depth = super::super::directory_manager::limit("max_source_depth").unwrap();
        let bytes = super::super::directory_manager::limit("max_source_path_bytes").unwrap();
        let allowed_depth = std::iter::repeat_n("entry", depth).collect::<Vec<_>>().join("/");
        let allowed_bytes = "\u{e9}".repeat(bytes / 2);
        for allowed in [&allowed_depth, &allowed_bytes] {
            assert!(validate_traversal_path(Path::new(allowed)).is_ok());
        }
        let temporary = tempfile::tempdir().unwrap();
        for refused in [format!("{allowed_depth}/child"), format!("{allowed_bytes}\u{e9}")] {
            assert!(validate_traversal_path(Path::new(&refused)).is_err());
            assert!(matches!(
                super::NativeRoot::open(&temporary.path().join("missing").join(refused)),
                Err(IndexError::Invalid(_))
            ));
        }
    }

    #[test]
    fn windows_native_names_preserve_exact_spelling_and_reject_lossy_or_ambiguous_names() {
        for name in [
            ".hidden",
            "\u{e9}",
            "e\u{301}",
            "MixedCASE",
            "emoji-\u{1f4c1}",
            "percent%underscore_",
        ] {
            let native: Vec<_> = name.encode_utf16().collect();
            assert_eq!(windows_entry_name(&native).unwrap(), name);
        }
        for native in [vec![0xd800], vec![0xdc00], vec![0xd800, b'a' as u16]] {
            assert_eq!(windows_entry_name(&native), Err(TraversalIssue::UnsupportedEncoding));
        }
        for name in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "stream:alternate",
            "wild*card",
            "name?",
            "tail.",
            "tail ",
            "nul\0name",
            "control\u{1}name",
        ] {
            let native: Vec<_> = name.encode_utf16().collect();
            assert_eq!(
                windows_entry_name(&native),
                Err(TraversalIssue::UnsupportedEncoding),
                "Unexpected valid name: {name:?}"
            );
        }
    }

    #[test]
    fn windows_reparse_tags_keep_redirections_cloud_and_unknown_types_distinct() {
        assert_eq!(windows_reparse_kind(0), WindowsReparseKind::Ordinary);
        for tag in [0xa000_0003, 0xa000_000c, 0xa000_001d] {
            assert_eq!(windows_reparse_kind(tag), WindowsReparseKind::Redirection);
        }
        for variant in 0..=15 {
            assert_eq!(
                windows_reparse_kind(0x9000_001a | (variant << 12)),
                WindowsReparseKind::CloudPlaceholder
            );
        }
        assert_eq!(windows_reparse_kind(0x8000_0021), WindowsReparseKind::CloudPlaceholder);
        for tag in [0x8000_001b, 0x8000_0023, 0x8000_ffff, 1] {
            assert_eq!(windows_reparse_kind(tag), WindowsReparseKind::Unsupported);
        }
    }

    #[test]
    fn windows_directory_record_bounds_reject_truncation_overflow_and_misalignment() {
        assert_eq!(windows_record_name_range(128, 112, 88, 8).unwrap(), 88..96);
        assert_eq!(windows_record_name_range(128, 0, 88, 40).unwrap(), 88..128);
        for (remaining, next, name_offset, name_bytes) in [
            (128, 0, 88, 0),
            (128, 0, 88, 3),
            (128, 136, 88, 2),
            (128, 80, 88, 2),
            (128, 112, 88, 26),
            (128, 110, 88, 2),
            (128, 0, usize::MAX, 2),
            (128, 0, 88, usize::MAX - 1),
        ] {
            assert!(windows_record_name_range(remaining, next, name_offset, name_bytes).is_err());
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Component, PathBuf};
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};

    const DIRECTORY_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    static OPENAT2_UNAVAILABLE: AtomicBool = AtomicBool::new(false);
    fn open_at2(descriptor: libc::c_int, name: &CStr) -> io::Result<File> {
        let mut how: libc::open_how = unsafe { std::mem::zeroed() };
        how.flags = DIRECTORY_FLAGS as u64;
        how.resolve = libc::RESOLVE_NO_SYMLINKS | libc::RESOLVE_NO_XDEV | libc::RESOLVE_BENEATH;
        let descriptor = unsafe { libc::syscall(libc::SYS_openat2, descriptor, name.as_ptr(), &how, size_of::<libc::open_how>()) };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(descriptor as libc::c_int) })
    }
    const EMPTY_NAME: &[u8] = b"\0";
    const CURRENT_NAME: &[u8] = b".\0";
    const ROOT_NAME: &[u8] = b"/\0";
    const DEVICE_ROOT_NAME: &[u8] = b"/dev\0";
    const CONFIGFS_MAGIC: libc::__fsword_t = 0x62656570;
    const PSEUDO_FILESYSTEMS: &[libc::__fsword_t] = &[
        libc::PROC_SUPER_MAGIC,
        libc::SYSFS_MAGIC,
        libc::DEBUGFS_MAGIC,
        libc::SECURITYFS_MAGIC,
        libc::CGROUP_SUPER_MAGIC,
        libc::CGROUP2_SUPER_MAGIC,
        libc::DEVPTS_SUPER_MAGIC,
        libc::TRACEFS_MAGIC,
        CONFIGFS_MAGIC,
        libc::BPF_FS_MAGIC,
        libc::NSFS_MAGIC,
        libc::SELINUX_MAGIC,
    ];

    pub(super) fn is_pseudo_filesystem(kind: libc::__fsword_t) -> bool {
        PSEUDO_FILESYSTEMS.contains(&kind)
    }

    /// Classify the held filesystem so root aliases cannot bypass kernel-tree exclusions.
    fn validate_filesystem(file: &File, source: NativeIdentity, io: &super::NativeIo) -> Result<(), IndexError> {
        let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::zeroed();
        if unsafe { libc::fstatfs(file.as_raw_fd(), filesystem.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        let filesystem = unsafe { filesystem.assume_init() };
        if is_pseudo_filesystem(filesystem.f_type) {
            return Err(IndexError::Invalid(
                "Kernel pseudo-filesystems cannot be indexed. Select a regular data directory or use recent directories.",
            ));
        }
        let device_name = CStr::from_bytes_with_nul(DEVICE_ROOT_NAME).map_err(|_| IndexError::Invalid("Invalid device root name."))?;
        match open_at(libc::AT_FDCWD, device_name, io) {
            Ok(device_root) if device_root.metadata()?.dev() == source.device => {
                return Err(IndexError::Invalid(
                    "Kernel device directories cannot be indexed. Select a regular data directory or use recent directories.",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    fn io_issue(error: io::Error) -> Result<TraversalIssue, IndexError> {
        match super::source_error(IndexError::Io(error)) {
            IndexError::SourceItem("access_denied") => Ok(TraversalIssue::AccessDenied),
            IndexError::SourceItem("unsafe_traversal") => Ok(TraversalIssue::UnsafeTraversal),
            IndexError::SourceItem(_) => Ok(TraversalIssue::ScanFailed),
            error => Err(error),
        }
    }

    /// The returned file owns the successful descriptor. Every component is opened without following links.
    fn open_at(parent: libc::c_int, name: &CStr, io: &super::NativeIo) -> io::Result<File> {
        io.record_open();
        let descriptor = unsafe { libc::openat(parent, name.as_ptr(), DIRECTORY_FLAGS) };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    /// statx reads the already-owned descriptor, not a path that can redirect the request.
    fn identity(file: &File) -> Result<NativeIdentity, IndexError> {
        let metadata = file.metadata()?;
        let mut extended = std::mem::MaybeUninit::<libc::statx>::zeroed();
        let result = unsafe {
            libc::statx(
                file.as_raw_fd(),
                EMPTY_NAME.as_ptr().cast(),
                libc::AT_EMPTY_PATH,
                libc::STATX_MNT_ID,
                extended.as_mut_ptr(),
            )
        };
        let extended = unsafe { extended.assume_init() };
        let mount = if result == 0 && extended.stx_mask & libc::STATX_MNT_ID != 0 {
            extended.stx_mnt_id
        } else {
            descriptor_mount_id(
                &std::fs::read_to_string(format!("/proc/self/fdinfo/{}", file.as_raw_fd()))
                    .map_err(|_| IndexError::Invalid(MOUNT_BOUNDARY_CAPABILITY_ERROR))?,
            )?
        };
        Ok(NativeIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            mount,
        })
    }

    fn descriptor_mount_id(information: &str) -> Result<u64, IndexError> {
        information
            .lines()
            .find_map(|line| line.strip_prefix("mnt_id:").and_then(|value| value.trim().parse().ok()))
            .ok_or(IndexError::Invalid(MOUNT_BOUNDARY_CAPABILITY_ERROR))
    }

    #[test]
    fn parent_capability_cache_only_remembers_enosys() {
        thread_local! {
            static PROBE: std::cell::Cell<(usize, i32)> = const { std::cell::Cell::new((0, 0)) };
        }
        for errno in [libc::ENOSYS, libc::EACCES, libc::ELOOP, libc::EXDEV] {
            let temporary = tempfile::tempdir().unwrap();
            std::fs::create_dir(temporary.path().join("parent")).unwrap();
            let root = NativeRoot::open(temporary.path()).unwrap();
            let unavailable = AtomicBool::new(false);
            PROBE.with(|probe| probe.set((0, errno)));
            for _attempt in 0..2 {
                let result = root.parent_with_openat2("parent", false, &unavailable, |_descriptor, _name| {
                    Err(PROBE.with(|probe| {
                        let (count, errno) = probe.get();
                        probe.set((count + 1, errno));
                        io::Error::from_raw_os_error(errno)
                    }))
                });
                assert_eq!(result.is_ok(), errno == libc::ENOSYS);
            }
            assert_eq!(unavailable.load(Ordering::Relaxed), errno == libc::ENOSYS);
            assert_eq!(PROBE.with(|probe| probe.get().0), if errno == libc::ENOSYS { 1 } else { 2 });
        }
    }

    #[test]
    fn fallback_parent_opens_reject_leaf_and_ancestor_links() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temporary.path().join("real/child")).unwrap();
        std::os::unix::fs::symlink("real", temporary.path().join("alias")).unwrap();
        let root = NativeRoot::open(temporary.path()).unwrap();
        let unavailable = AtomicBool::new(true);
        assert!(root.parent_with_openat2("real/child", false, &unavailable, open_at2).is_ok());
        for relative in ["alias", "alias/child"] {
            assert!(root.parent_with_openat2(relative, false, &unavailable, open_at2).is_err());
        }
    }

    #[test]
    fn unknown_entry_types_use_nofollow_metadata() {
        use std::os::unix::ffi::OsStringExt;

        const EXPECTED_ENTRY_CHECKS: u64 = 6;
        const INVALID_LINK_NAME: &[u8] = b"\xff-link";
        const INVALID_FILE_NAME: &[u8] = b"\xff-file";
        const INVALID_DIRECTORY_NAME: &[u8] = b"\xff-directory";
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir(temporary.path().join("directory")).unwrap();
        std::fs::write(temporary.path().join("file"), b"file").unwrap();
        std::os::unix::fs::symlink("directory", temporary.path().join("link")).unwrap();
        std::os::unix::fs::symlink(
            "directory",
            temporary.path().join(std::ffi::OsString::from_vec(INVALID_LINK_NAME.to_vec())),
        )
        .unwrap();
        std::fs::write(
            temporary.path().join(std::ffi::OsString::from_vec(INVALID_FILE_NAME.to_vec())),
            b"file",
        )
        .unwrap();
        std::fs::create_dir(temporary.path().join(std::ffi::OsString::from_vec(INVALID_DIRECTORY_NAME.to_vec()))).unwrap();
        let root = NativeRoot::open(temporary.path()).unwrap();
        root.io.force_unknown_entry_types.store(true, Ordering::Relaxed);
        let parent = root.open_parent_for_scan("").unwrap();
        let mut children = Vec::new();
        let mut issues = Vec::new();
        parent
            .children_with_ids(|entry| {
                match entry {
                    Ok(Some(child)) => children.push(child),
                    Err(issue) => issues.push(issue),
                    Ok(None) => {}
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(root.io.unknown_entry_checks.load(Ordering::Relaxed), EXPECTED_ENTRY_CHECKS);
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].0, "directory");
        assert!(children[0].1);
        assert!(children[0].2.is_some());
        assert_eq!(issues, vec![TraversalIssue::UnsupportedEncoding]);
    }

    #[test]
    fn descriptor_mount_fallback_requires_the_kernel_mount_id() {
        assert_eq!(descriptor_mount_id("pos:\t0\nmnt_id:\t42\nino:\t1\n").unwrap(), 42);
        assert!(descriptor_mount_id("ino:\t42\n").is_err());
        assert!(descriptor_mount_id("mnt_id:\tinvalid\n").is_err());
    }

    #[test]
    fn enumeration_does_not_open_child_directories_or_regular_files() {
        const CHILD_COUNT: usize = 64;
        let temporary = tempfile::tempdir().unwrap();
        let root = NativeRoot::open(temporary.path()).unwrap();
        let mut metadata = std::mem::MaybeUninit::<libc::statx>::zeroed();
        let mask = libc::STATX_TYPE | libc::STATX_INO | libc::STATX_MNT_ID;
        let result = unsafe {
            libc::statx(
                root.file.as_raw_fd(),
                EMPTY_NAME.as_ptr().cast(),
                libc::AT_EMPTY_PATH,
                mask,
                metadata.as_mut_ptr(),
            )
        };
        if result != 0 || unsafe { metadata.assume_init() }.stx_mask & mask != mask {
            return;
        }
        let before = root.io.opens();
        root.children("", |_| Ok(())).unwrap();
        let baseline = root.io.opens() - before;
        for number in 0..CHILD_COUNT {
            std::fs::create_dir(temporary.path().join(format!("directory-{number}"))).unwrap();
            std::fs::write(temporary.path().join(format!("file-{number}")), b"file").unwrap();
        }
        let before = root.io.opens();
        let mut found = 0;
        root.children("", |entry| {
            if let Some((_, descend)) = entry.expect("ordinary entries") {
                assert!(descend);
                found += 1;
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(found, CHILD_COUNT);
        assert_eq!(root.io.opens() - before, baseline);
    }

    pub struct NativeRoot {
        path: PathBuf,
        file: File,
        io: std::sync::Arc<super::NativeIo>,
        probes: super::RootProbeState,
        pub identity: NativeIdentity,
    }

    pub struct NativeParent<'root> {
        root: &'root NativeRoot,
        relative: String,
        file: File,
        pub identity: NativeIdentity,
    }

    impl NativeParent<'_> {
        pub fn verify(&self) -> Result<(), IndexError> {
            if self.file.metadata()?.nlink() == 0 || identity(&self.file)? != self.identity {
                return Err(IndexError::Invalid(
                    "Directory parent changed during scanning. Retry source verification.",
                ));
            }
            Ok(())
        }

        pub fn children_with_ids(
            &self,
            receive: impl FnMut(Result<Option<NativeChild>, TraversalIssue>) -> Result<(), IndexError>,
        ) -> Result<(), IndexError> {
            self.verify().map_err(super::source_error)?;
            #[cfg(test)]
            {
                let gate = self
                    .root
                    .io
                    .parent_read_gate
                    .lock()
                    .map_err(|_| IndexError::Invalid("Directory read gate is unavailable."))?
                    .clone();
                if let Some(gate) = gate {
                    gate.wait();
                    gate.wait();
                }
            }
            self.root.children_from_handle(&self.relative, &self.file, receive)
        }

        #[cfg(test)]
        pub fn has_directory_child_with_check(
            &self,
            name: &str,
            check: impl FnMut() -> Result<(), IndexError>,
        ) -> Result<bool, IndexError> {
            self.verify().map_err(super::source_error)?;
            let found = self
                .root
                .has_directory_child_from_handle(&self.relative, self.identity, &self.file, name, check)?;
            self.verify().map_err(super::source_error)?;
            Ok(found)
        }
    }

    impl NativeRoot {
        pub fn open_parent(&self, relative: &str) -> Result<NativeParent<'_>, IndexError> {
            self.open_parent_with_check(relative, true)
        }

        pub fn open_parent_for_scan(&self, relative: &str) -> Result<NativeParent<'_>, IndexError> {
            self.open_parent_with_check(relative, false)
        }

        pub fn open_parent_for_scan_with_id(&self, relative: &str, _expected_id: &[u8]) -> Result<NativeParent<'_>, IndexError> {
            self.open_parent_for_scan(relative)
        }

        pub fn require_verification(&self) {
            self.probes.require();
        }

        fn open_parent_with_check(&self, relative: &str, full_root_check: bool) -> Result<NativeParent<'_>, IndexError> {
            let result = (|| {
                let file = self.parent(relative, full_root_check)?;
                let identity = identity(&file)?;
                Ok(NativeParent {
                    root: self,
                    relative: relative.to_owned(),
                    file,
                    identity,
                })
            })();
            if result.is_err() {
                self.require_verification();
            }
            result
        }

        #[cfg(test)]
        pub fn open(path: &Path) -> Result<Self, IndexError> {
            Self::open_with_io(path, std::sync::Arc::default())
        }

        pub fn open_with_io(path: &Path, io: std::sync::Arc<super::NativeIo>) -> Result<Self, IndexError> {
            if !path.is_absolute() {
                return Err(IndexError::Invalid("Directory source root must be an absolute directory."));
            }
            super::validate_traversal_path(path)?;
            let mut file = open_at(
                libc::AT_FDCWD,
                CStr::from_bytes_with_nul(ROOT_NAME).map_err(|_| IndexError::Invalid("Invalid root name."))?,
                &io,
            )?;
            for component in path.components() {
                match component {
                    Component::RootDir => {}
                    Component::Normal(name) => {
                        let name = CString::new(name.as_bytes())
                            .map_err(|_| IndexError::Invalid("Directory source root contains an unsupported name."))?;
                        file = open_at(file.as_raw_fd(), &name, &io)?;
                    }
                    _ => {
                        return Err(IndexError::Invalid(
                            "Directory source root must not contain dot or parent components.",
                        ))
                    }
                }
            }
            let identity = identity(&file)?;
            validate_filesystem(&file, identity, &io)?;
            Ok(Self {
                path: path.to_owned(),
                file,
                io,
                probes: super::RootProbeState::default(),
                identity,
            })
        }

        pub fn verify(&self) -> Result<(), IndexError> {
            let version = self.probes.require();
            if Self::open_with_io(&self.path, self.io.clone())?.identity != self.identity {
                return Err(io::Error::new(
                    io::ErrorKind::NotConnected,
                    "Directory root binding changed. Background verification will bind the root again.",
                )
                .into());
            }
            self.probes.complete(version);
            Ok(())
        }

        fn parent(&self, relative: &str, full_root_check: bool) -> Result<File, IndexError> {
            self.parent_with_openat2(relative, full_root_check, &OPENAT2_UNAVAILABLE, open_at2)
        }

        fn parent_with_openat2(
            &self,
            relative: &str,
            full_root_check: bool,
            unavailable: &AtomicBool,
            opener: fn(libc::c_int, &CStr) -> io::Result<File>,
        ) -> Result<File, IndexError> {
            super::validate_traversal_path(&self.path.join(relative))?;
            if full_root_check || self.probes.needed() {
                self.verify()?;
            } else if self.file.metadata()?.nlink() == 0 || identity(&self.file)? != self.identity {
                return Err(io::Error::new(
                    io::ErrorKind::NotConnected,
                    "Directory root binding changed. Background verification will bind the root again.",
                )
                .into());
            }
            if !relative.is_empty() {
                super::super::directory_index::validate_directory_path(relative)?;
            }
            if !unavailable.load(Ordering::Relaxed) {
                let name = CString::new(if relative.is_empty() { "." } else { relative })
                    .map_err(|_| IndexError::Invalid("Directory name contains NUL."))?;
                self.io.record_open();
                let error = match opener(self.file.as_raw_fd(), &name) {
                    Ok(file) => {
                        let current = identity(&file)?;
                        if current.device != self.identity.device || current.mount != self.identity.mount {
                            return Err(IndexError::Invalid(
                                "Directory traversal would cross a mount. Index the mounted drive separately.",
                            ));
                        }
                        return Ok(file);
                    }
                    Err(error) => error,
                };
                if error.raw_os_error() != Some(libc::ENOSYS) {
                    return Err(error.into());
                }
                unavailable.store(true, Ordering::Relaxed);
            }
            let mut file = open_at(
                self.file.as_raw_fd(),
                CStr::from_bytes_with_nul(CURRENT_NAME).map_err(|_| IndexError::Invalid("Invalid current directory name."))?,
                &self.io,
            )?;
            if !relative.is_empty() {
                super::super::directory_index::validate_directory_path(relative)?;
                for component in relative.split('/') {
                    let name = CString::new(component).map_err(|_| IndexError::Invalid("Directory name contains NUL."))?;
                    file = open_at(file.as_raw_fd(), &name, &self.io)?;
                    let current = identity(&file)?;
                    if current.device != self.identity.device || current.mount != self.identity.mount {
                        return Err(IndexError::Invalid(
                            "Directory traversal would cross a mount. Index the mounted drive separately.",
                        ));
                    }
                }
            }
            Ok(file)
        }

        pub fn verify_parent(&self, parent: &str, expected: NativeIdentity) -> Result<(), IndexError> {
            if identity(&self.parent(parent, true)?)? != expected {
                return Err(IndexError::Invalid(
                    "Directory parent changed during scanning. Retry source verification.",
                ));
            }
            Ok(())
        }

        #[cfg(test)]
        pub fn parent_identity(&self, parent: &str) -> Result<NativeIdentity, IndexError> {
            identity(&self.parent(parent, true)?)
        }

        /// Check one exact child through the held parent; errors are not evidence of absence.
        #[cfg(test)]
        pub fn has_directory_child(&self, parent: &str, expected: NativeIdentity, name: &str) -> Result<bool, IndexError> {
            self.has_directory_child_with_check(parent, expected, name, || Ok(()))
        }

        pub fn has_directory_child_with_check(
            &self,
            parent: &str,
            expected: NativeIdentity,
            name: &str,
            mut check: impl FnMut() -> Result<(), IndexError>,
        ) -> Result<bool, IndexError> {
            check()?;
            let file = self.parent(parent, true)?;
            let found = self.has_directory_child_from_handle(parent, expected, &file, name, check)?;
            self.verify_parent(parent, expected)?;
            Ok(found)
        }

        fn has_directory_child_from_handle(
            &self,
            parent: &str,
            expected: NativeIdentity,
            file: &File,
            name: &str,
            mut check: impl FnMut() -> Result<(), IndexError>,
        ) -> Result<bool, IndexError> {
            check()?;
            super::super::directory_index::validate_directory_path(name)?;
            if name.contains('/') {
                return Err(IndexError::Invalid("Directory child check requires one native name."));
            }
            super::validate_traversal_path(&self.path.join(parent).join(name))?;
            if identity(file)? != expected {
                return Err(IndexError::Invalid(
                    "Directory parent changed during reconciliation. Retry source verification.",
                ));
            }
            let name = CString::new(name).map_err(|_| IndexError::Invalid("Directory child name contains NUL."))?;
            let outcome = (|| {
                check()?;
                let mut metadata = std::mem::MaybeUninit::<libc::stat>::zeroed();
                if unsafe { libc::fstatat(file.as_raw_fd(), name.as_ptr(), metadata.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
                    let error = io::Error::last_os_error();
                    return if error.kind() == io::ErrorKind::NotFound {
                        Ok(false)
                    } else {
                        Err(error.into())
                    };
                }
                let kind = unsafe { metadata.assume_init() }.st_mode & libc::S_IFMT;
                if kind == libc::S_IFLNK {
                    return Err(IndexError::Invalid(
                        "Directory child is a redirection. Retry source verification under the traversal policy.",
                    ));
                }
                if kind != libc::S_IFDIR {
                    return Ok(false);
                }
                check()?;
                let child = match open_at(file.as_raw_fd(), &name, &self.io) {
                    Ok(child) => child,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
                    Err(error) => return Err(error.into()),
                };
                let current = identity(&child)?;
                if current.device != self.identity.device || current.mount != self.identity.mount {
                    return Err(IndexError::Invalid(
                        "Directory child is on a different mount. Retry verification without crossing filesystems.",
                    ));
                }
                Ok(true)
            })();
            let found = outcome?;
            check()?;
            Ok(found)
        }

        /// fdopendir owns its descriptor; copied names remain valid after the next readdir call.
        #[cfg(test)]
        pub fn children(
            &self,
            parent: &str,
            mut receive: impl FnMut(Result<Option<(String, bool)>, TraversalIssue>) -> Result<(), IndexError>,
        ) -> Result<(), IndexError> {
            self.children_with_ids(parent, |entry| {
                receive(entry.map(|entry| entry.map(|(name, descend, _)| (name, descend))))
            })
        }

        #[cfg(test)]
        pub fn children_with_ids(
            &self,
            parent: &str,
            receive: impl FnMut(Result<Option<NativeChild>, TraversalIssue>) -> Result<(), IndexError>,
        ) -> Result<(), IndexError> {
            self.open_parent(parent)?.children_with_ids(receive)
        }

        fn children_from_handle(
            &self,
            parent: &str,
            file: &File,
            mut receive: impl FnMut(Result<Option<NativeChild>, TraversalIssue>) -> Result<(), IndexError>,
        ) -> Result<(), IndexError> {
            let parent_identity = identity(file).map_err(super::source_error)?;
            let descriptor = file
                .try_clone()
                .map_err(|error| super::source_error(IndexError::Io(error)))?
                .into_raw_fd();
            let pointer = unsafe { libc::fdopendir(descriptor) };
            let Some(pointer) = NonNull::new(pointer) else {
                let error = io::Error::last_os_error();
                drop(unsafe { File::from_raw_fd(descriptor) });
                return Err(super::source_error(IndexError::Io(error)));
            };
            let directory = NativeDirectory(pointer);
            loop {
                receive(Ok(None))?;
                unsafe {
                    *libc::__errno_location() = 0;
                }
                let entry = unsafe { libc::readdir(directory.0.as_ptr()) };
                if entry.is_null() {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() != Some(0) {
                        return Err(super::source_error(IndexError::Io(error)));
                    }
                    return Ok(());
                }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                if matches!(name.to_bytes(), b"." | b"..") {
                    continue;
                }
                let entry_type = unsafe { (*entry).d_type };
                #[cfg(test)]
                let entry_type = if self.io.force_unknown_entry_types.load(Ordering::Relaxed) {
                    libc::DT_UNKNOWN
                } else {
                    entry_type
                };
                match entry_type {
                    libc::DT_LNK => continue,
                    libc::DT_DIR | libc::DT_UNKNOWN => {}
                    _ => continue,
                }
                if entry_type == libc::DT_UNKNOWN {
                    #[cfg(test)]
                    self.io.unknown_entry_checks.fetch_add(1, Ordering::Relaxed);
                    let mut metadata = std::mem::MaybeUninit::<libc::stat>::zeroed();
                    let result = unsafe { libc::fstatat(descriptor, name.as_ptr(), metadata.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
                    if result != 0 {
                        let error = io::Error::last_os_error();
                        if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) {
                            let Ok(text) = name.to_str() else {
                                receive(Err(TraversalIssue::UnsupportedEncoding))?;
                                continue;
                            };
                            if self.has_directory_child_with_check(parent, parent_identity, text, || receive(Ok(None)))? {
                                return Err(IndexError::Interrupted);
                            }
                        } else {
                            receive(Err(io_issue(error)?))?;
                        }
                        continue;
                    }
                    let kind = unsafe { metadata.assume_init() }.st_mode & libc::S_IFMT;
                    if kind == libc::S_IFLNK {
                        continue;
                    }
                    if kind != libc::S_IFDIR {
                        continue;
                    }
                }
                let Ok(text) = name.to_str() else {
                    receive(Err(TraversalIssue::UnsupportedEncoding))?;
                    continue;
                };
                if super::validate_traversal_path(&self.path.join(parent).join(text)).is_err() {
                    receive(Err(TraversalIssue::UnsafeDirectory(text.to_owned())))?;
                    continue;
                }
                let mut extended = std::mem::MaybeUninit::<libc::statx>::zeroed();
                let mask = libc::STATX_TYPE | libc::STATX_INO | libc::STATX_MNT_ID;
                let result = unsafe {
                    libc::statx(
                        descriptor,
                        name.as_ptr(),
                        libc::AT_SYMLINK_NOFOLLOW | libc::AT_NO_AUTOMOUNT,
                        mask,
                        extended.as_mut_ptr(),
                    )
                };
                if result == 0 {
                    let metadata = unsafe { extended.assume_init() };
                    if metadata.stx_mask & mask == mask {
                        let kind = u32::from(metadata.stx_mode) & libc::S_IFMT;
                        if kind == libc::S_IFDIR {
                            let same_mount = libc::makedev(metadata.stx_dev_major, metadata.stx_dev_minor) == self.identity.device
                                && metadata.stx_mnt_id == self.identity.mount;
                            receive(Ok(Some((
                                text.to_owned(),
                                same_mount,
                                Some(metadata.stx_ino.to_le_bytes().to_vec()),
                            ))))?;
                            if !same_mount {
                                receive(Err(TraversalIssue::UnsafeDirectory(text.to_owned())))?;
                            }
                        }
                        continue;
                    }
                } else {
                    let error = io::Error::last_os_error();
                    if !matches!(error.raw_os_error(), Some(libc::ENOSYS | libc::EINVAL | libc::EOPNOTSUPP)) {
                        if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) {
                            if self.has_directory_child_with_check(parent, parent_identity, text, || receive(Ok(None)))? {
                                return Err(IndexError::Interrupted);
                            }
                        } else {
                            receive(Err(io_issue(error)?))?;
                        }
                        continue;
                    }
                }
                match open_at(descriptor, name, &self.io).and_then(|child| identity(&child).map_err(io::Error::other)) {
                    Ok(child) if child.device == self.identity.device && child.mount == self.identity.mount => {
                        receive(Ok(Some((text.to_owned(), true, Some(child.file_id())))))?
                    }
                    Ok(_) => {
                        receive(Ok(Some((text.to_owned(), false, None))))?;
                        receive(Err(TraversalIssue::UnsafeDirectory(text.to_owned())))?;
                    }
                    Err(error) => {
                        if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) {
                            if self.has_directory_child_with_check(parent, parent_identity, text, || receive(Ok(None)))? {
                                return Err(IndexError::Interrupted);
                            }
                            continue;
                        }
                        receive(Ok(Some((text.to_owned(), false, None))))?;
                        receive(Err(io_issue(error)?))?;
                    }
                }
            }
        }
    }

    struct NativeDirectory(NonNull<libc::DIR>);

    impl Drop for NativeDirectory {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0.as_ptr());
            }
        }
    }
}

#[cfg(target_os = "linux")]
pub use platform::{NativeParent, NativeRoot};

#[cfg(windows)]
#[path = "directory_traversal_windows.rs"]
mod windows_platform;

#[cfg(windows)]
pub use windows_platform::{NativeParent, NativeRoot};

#[cfg(not(any(target_os = "linux", windows)))]
pub struct NativeRoot {
    pub identity: NativeIdentity,
    probes: RootProbeState,
}

#[cfg(not(any(target_os = "linux", windows)))]
pub struct NativeParent<'root> {
    root: &'root NativeRoot,
    pub identity: NativeIdentity,
}

#[cfg(not(any(target_os = "linux", windows)))]
impl NativeParent<'_> {
    pub fn verify(&self) -> Result<(), IndexError> {
        self.root.verify()
    }

    pub fn children_with_ids(
        &self,
        _: impl FnMut(Result<Option<NativeChild>, TraversalIssue>) -> Result<(), IndexError>,
    ) -> Result<(), IndexError> {
        self.verify()
    }

    pub fn has_directory_child_with_check(&self, _: &str, mut check: impl FnMut() -> Result<(), IndexError>) -> Result<bool, IndexError> {
        check()?;
        self.verify().map(|()| false)
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
impl NativeRoot {
    pub fn open_parent_for_scan(&self, relative: &str) -> Result<NativeParent<'_>, IndexError> {
        self.open_parent(relative)
    }

    pub fn open_parent_for_scan_with_id(&self, relative: &str, _expected_id: &[u8]) -> Result<NativeParent<'_>, IndexError> {
        self.open_parent_for_scan(relative)
    }

    pub fn require_verification(&self) {
        self.probes.require();
    }

    pub fn open_parent(&self, _: &str) -> Result<NativeParent<'_>, IndexError> {
        self.verify()?;
        Err(IndexError::Invalid(
            "Safe directory indexing is not available on this platform. Use recent directories.",
        ))
    }

    pub fn open_with_io(path: &Path, _: std::sync::Arc<NativeIo>) -> Result<Self, IndexError> {
        Self::open(path)
    }

    pub fn open(_: &Path) -> Result<Self, IndexError> {
        Err(IndexError::Invalid("Safe directory indexing is not available on this platform. Use recent directories until a verified traversal adapter is available."))
    }
    pub fn verify(&self) -> Result<(), IndexError> {
        Self::open(Path::new("")).map(|_| ())
    }
    pub fn parent_identity(&self, _: &str) -> Result<NativeIdentity, IndexError> {
        self.verify().map(|_| self.identity)
    }
    pub fn verify_parent(&self, _: &str, _: NativeIdentity) -> Result<(), IndexError> {
        self.verify()
    }
    pub fn has_directory_child(&self, _: &str, _: NativeIdentity, _: &str) -> Result<bool, IndexError> {
        Err(IndexError::Invalid(
            "Safe directory reconciliation is unavailable on this platform. Use recent directories.",
        ))
    }
    pub fn has_directory_child_with_check(
        &self,
        parent: &str,
        expected: NativeIdentity,
        name: &str,
        mut check: impl FnMut() -> Result<(), IndexError>,
    ) -> Result<bool, IndexError> {
        check()?;
        self.has_directory_child(parent, expected, name)
    }
    #[cfg(test)]
    pub fn children(
        &self,
        _: &str,
        _: impl FnMut(Result<Option<(String, bool)>, TraversalIssue>) -> Result<(), IndexError>,
    ) -> Result<(), IndexError> {
        self.verify()
    }

    pub fn children_with_ids(
        &self,
        _: &str,
        _: impl FnMut(Result<Option<NativeChild>, TraversalIssue>) -> Result<(), IndexError>,
    ) -> Result<(), IndexError> {
        self.verify()
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::fs::symlink;

    #[test]
    fn scan_parent_opens_skip_full_root_probes_until_requested() {
        const TWO_PARENT_OPEN_BUDGET: u64 = 5;
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir(temporary.path().join("parent")).unwrap();
        let io = std::sync::Arc::<NativeIo>::default();
        let root = NativeRoot::open_with_io(temporary.path(), io.clone()).unwrap();
        let root_probe_opens = io.opens();
        let before = io.opens();
        root.open_parent_for_scan("parent").unwrap();
        root.open_parent_for_scan("parent").unwrap();
        assert!(io.opens() - before <= TWO_PARENT_OPEN_BUDGET);
        root.require_verification();
        let before = io.opens();
        root.open_parent_for_scan("parent").unwrap();
        assert!(io.opens() - before > root_probe_opens);
    }

    #[test]
    fn root_probe_completion_preserves_newer_verification_requests() {
        let probes = RootProbeState::default();
        let earlier = probes.require();
        let later = probes.require();
        probes.complete(earlier);
        assert!(probes.needed());
        probes.complete(later);
        assert!(!probes.needed());
    }

    #[test]
    fn scan_open_error_requires_a_fresh_root_probe() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source");
        std::fs::create_dir_all(path.join("parent")).unwrap();
        let root = NativeRoot::open(&path).unwrap();
        assert!(root.open_parent_for_scan("missing").is_err());
        std::fs::rename(&path, temporary.path().join("previous")).unwrap();
        std::fs::create_dir_all(path.join("parent")).unwrap();
        assert!(root.open_parent_for_scan("parent").is_err());
    }

    #[test]
    fn boundary_probe_rejects_root_replaced_during_local_scan_reads() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source");
        std::fs::create_dir_all(path.join("parent")).unwrap();
        let root = NativeRoot::open(&path).unwrap();
        std::fs::rename(&path, temporary.path().join("previous")).unwrap();
        std::fs::create_dir_all(path.join("parent")).unwrap();
        root.open_parent_for_scan("parent").unwrap();
        assert!(root.verify().is_err());
        assert!(root.open_parent("parent").is_err());
    }

    #[test]
    fn held_parent_enumeration_and_verification_do_not_reopen_directories() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir(temporary.path().join("parent")).unwrap();
        let io = std::sync::Arc::<NativeIo>::default();
        let root = NativeRoot::open_with_io(temporary.path(), io.clone()).unwrap();
        let read = root.open_parent("parent").unwrap();
        let before = io.opens();
        for _ in 0..3 {
            read.verify().unwrap();
        }
        read.children_with_ids(|entry| {
            assert!(entry.unwrap().is_none());
            Ok(())
        })
        .unwrap();
        assert!(!read.has_directory_child_with_check("missing", || Ok(())).unwrap());
        assert_eq!(io.opens(), before);
    }

    #[test]
    fn held_parent_does_not_follow_a_replacement_link() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        let outside = temporary.path().join("outside");
        std::fs::create_dir_all(path.join("parent/original")).unwrap();
        std::fs::create_dir_all(outside.join("external")).unwrap();
        let root = NativeRoot::open(&path).unwrap();
        let read = root.open_parent("parent").unwrap();
        std::fs::rename(path.join("parent"), path.join("previous")).unwrap();
        symlink(&outside, path.join("parent")).unwrap();
        let mut children = Vec::new();
        read.children_with_ids(|entry| {
            if let Some((name, _, _)) = entry.unwrap() {
                children.push(name);
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(children, ["original"]);
        assert!(!read.has_directory_child_with_check("external", || Ok(())).unwrap());
        assert!(root.open_parent("parent").is_err());
    }

    #[test]
    fn held_parent_rejects_a_deleted_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("parent");
        std::fs::create_dir(&path).unwrap();
        let root = NativeRoot::open(temporary.path()).unwrap();
        let read = root.open_parent("parent").unwrap();
        std::fs::remove_dir(&path).unwrap();
        assert!(read.verify().is_err());
        assert!(read.children_with_ids(|_| Ok(())).is_err());
    }

    #[test]
    fn native_open_counter_is_source_scoped_and_includes_failed_opens() {
        const ROOT_AND_DEVICE_OPENS: u64 = 2;
        let temporary = tempfile::tempdir().unwrap();
        let io = std::sync::Arc::<NativeIo>::default();
        let root = NativeRoot::open_with_io(temporary.path(), io.clone()).unwrap();
        let root_opens = temporary
            .path()
            .components()
            .filter(|part| matches!(part, std::path::Component::Normal(_)))
            .count() as u64
            + ROOT_AND_DEVICE_OPENS;
        assert_eq!(io.opens(), root_opens);
        root.verify().unwrap();
        assert_eq!(io.opens(), root_opens * 2);
        NativeRoot::open(temporary.path()).unwrap().verify().unwrap();
        assert_eq!(io.opens(), root_opens * 2);
        assert!(root.parent_identity("missing").is_err());
        assert!(io.opens() > root_opens * 3);
        let before = io.opens();
        assert!(NativeRoot::open_with_io(&temporary.path().join("missing"), io.clone()).is_err());
        assert_eq!(io.opens() - before, root_opens);
    }

    #[test]
    fn kernel_and_device_roots_are_rejected() {
        for path in ["/proc", "/sys", "/dev"] {
            assert!(NativeRoot::open(Path::new(path)).is_err(), "Kernel root was accepted: {path}");
        }
        for kind in [
            libc::PROC_SUPER_MAGIC,
            libc::SYSFS_MAGIC,
            libc::CGROUP2_SUPER_MAGIC,
            libc::DEVPTS_SUPER_MAGIC,
        ] {
            assert!(platform::is_pseudo_filesystem(kind));
        }
        assert!(!platform::is_pseudo_filesystem(libc::TMPFS_MAGIC));
        assert!(!platform::is_pseudo_filesystem(libc::EXT4_SUPER_MAGIC));
        let root = NativeRoot::open(Path::new("/")).unwrap();
        assert!(root.parent_identity("proc").is_err());
        assert!(root.parent_identity("dev").is_err());
    }

    #[test]
    fn root_links_and_component_links_are_rejected() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir(&root).unwrap();
        let link = temporary.path().join("link");
        symlink(&root, &link).unwrap();
        assert!(NativeRoot::open(&link).is_err());
        assert!(NativeRoot::open(&link.join("child")).is_err());
    }

    #[test]
    fn traversal_never_follows_links_or_uses_lossy_names() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("visible")).unwrap();
        std::fs::create_dir(root.join(".hidden")).unwrap();
        std::fs::create_dir(root.join(std::ffi::OsString::from_vec(vec![0xff]))).unwrap();
        symlink(temporary.path(), root.join("outside")).unwrap();
        let source = NativeRoot::open(&root).unwrap();
        let mut rows = Vec::new();
        let mut issues = Vec::new();
        source
            .children("", |entry| {
                match entry {
                    Ok(Some(row)) => rows.push(row),
                    Ok(None) => {}
                    Err(issue) => issues.push(issue),
                };
                Ok(())
            })
            .unwrap();
        rows.sort();
        assert_eq!(rows, vec![(".hidden".to_owned(), true), ("visible".to_owned(), true)]);
        assert_eq!(issues, vec![TraversalIssue::UnsupportedEncoding]);
    }

    #[test]
    fn child_checks_use_exact_names_and_do_not_treat_redirections_or_replacement_as_absence() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir_all(root.join("parent/é")).unwrap();
        std::fs::write(root.join("parent/file"), b"fixture").unwrap();
        symlink(temporary.path(), root.join("parent/link")).unwrap();
        let source = NativeRoot::open(&root).unwrap();
        let parent = source.parent_identity("parent").unwrap();
        assert!(source.has_directory_child("parent", parent, "é").unwrap());
        assert!(!source.has_directory_child("parent", parent, "missing").unwrap());
        assert!(!source.has_directory_child("parent", parent, "file").unwrap());
        assert!(source.has_directory_child("parent", parent, "link").is_err());
        assert!(source.has_directory_child("parent", parent, "nested/name").is_err());
        std::fs::rename(root.join("parent"), root.join("old-parent")).unwrap();
        std::fs::create_dir(root.join("parent")).unwrap();
        assert!(source.has_directory_child("parent", parent, "missing").is_err());
    }

    #[test]
    fn child_lookup_obeys_control_checks_before_and_after_native_work() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir(temporary.path().join("child")).unwrap();
        let root = NativeRoot::open(temporary.path()).unwrap();
        for stop_at in 1..=4 {
            let mut checks = 0;
            let result = root.has_directory_child_with_check("", root.identity, "child", || {
                checks += 1;
                if checks == stop_at {
                    Err(IndexError::Interrupted)
                } else {
                    Ok(())
                }
            });
            assert!(matches!(result, Err(IndexError::Interrupted)));
            assert_eq!(checks, stop_at);
            root.verify().unwrap();
        }
        assert!(root.has_directory_child("", root.identity, "child").unwrap());
    }

    #[test]
    fn traversal_depth_refusal_preserves_readable_branches() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir_all(path.join("readable")).unwrap();
        let maximum_depth = super::super::directory_manager::limit("max_source_depth").unwrap();
        let root_depth = path
            .components()
            .filter(|component| matches!(component, std::path::Component::Normal(_)))
            .count();
        let parent = std::iter::repeat_n("d", maximum_depth - root_depth).collect::<Vec<_>>().join("/");
        std::fs::create_dir_all(path.join(&parent).join("excluded")).unwrap();
        let root = NativeRoot::open(&path).unwrap();
        let mut entries = Vec::new();
        let mut issues = Vec::new();
        root.children(&parent, |entry| {
            match entry {
                Ok(Some(entry)) => entries.push(entry),
                Err(issue) => issues.push(issue),
                Ok(None) => {}
            }
            Ok(())
        })
        .unwrap();
        assert!(entries.is_empty());
        assert_eq!(issues, [TraversalIssue::UnsafeDirectory("excluded".to_owned())]);
        root.children("", |entry| {
            if let Ok(Some(entry)) = entry {
                entries.push(entry);
            }
            Ok(())
        })
        .unwrap();
        assert!(entries.iter().any(|(name, descend)| name == "readable" && *descend));
    }

    #[test]
    fn many_regular_files_keep_enumeration_cancellable_without_a_directory_cutoff() {
        use super::super::directory_index::ROW_BATCH_SIZE;

        const FILE_COUNT: usize = ROW_BATCH_SIZE * 2 + 1;

        let temporary = tempfile::tempdir().unwrap();
        for number in 0..FILE_COUNT {
            std::fs::write(temporary.path().join(format!("file-{number}")), b"").unwrap();
        }
        std::fs::create_dir(temporary.path().join("directory")).unwrap();
        let root = NativeRoot::open(temporary.path()).unwrap();
        let mut checks = 0;
        let outcome = root.children("", |_| {
            checks += 1;
            if checks == ROW_BATCH_SIZE {
                Err(IndexError::Interrupted)
            } else {
                Ok(())
            }
        });
        assert!(matches!(outcome, Err(IndexError::Interrupted)));
        assert_eq!(checks, ROW_BATCH_SIZE);
        root.verify().unwrap();
        let mut rows = Vec::new();
        checks = 0;
        root.children("", |entry| {
            checks += 1;
            if let Some(row) = entry.unwrap() {
                rows.push(row);
            }
            Ok(())
        })
        .unwrap();
        assert!(checks >= FILE_COUNT);
        assert_eq!(rows, vec![("directory".to_owned(), true)]);
    }

    #[test]
    fn parent_and_root_replacement_invalidate_observations() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("root");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("parent")).unwrap();
        let source = NativeRoot::open(&root).unwrap();
        let observed = source.parent_identity("parent").unwrap();
        std::fs::rename(root.join("parent"), root.join("old")).unwrap();
        std::fs::create_dir(root.join("parent")).unwrap();
        assert!(source.verify_parent("parent", observed).is_err());
        std::fs::rename(&root, temporary.path().join("old-root")).unwrap();
        std::fs::create_dir(&root).unwrap();
        assert!(source.verify().is_err());
    }
}
