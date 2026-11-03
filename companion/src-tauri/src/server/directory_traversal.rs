//! Descriptor-based traversal; unsupported platforms fail closed without a lossy walker.

use std::path::Path;

use super::directory_index::IndexError;

pub(super) const MOUNT_BOUNDARY_CAPABILITY_ERROR: &str =
    "The kernel cannot check directory mount boundaries. Restart the companion after enabling statx mount IDs or /proc/self/fdinfo.";

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TraversalIssue {
    AccessDenied,
    UnsupportedEncoding,
    UnsafeTraversal,
    ScanFailed,
}

impl TraversalIssue {
    pub fn code(self) -> &'static str {
        match self {
            Self::AccessDenied => "access_denied",
            Self::UnsupportedEncoding => "unsupported_encoding",
            Self::UnsafeTraversal => "unsafe_traversal",
            Self::ScanFailed => "scan_failed",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
pub struct NativeIdentity {
    device: u64,
    inode: u64,
    mount: u64,
}

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

    const DIRECTORY_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
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
    fn validate_filesystem(file: &File, source: NativeIdentity) -> Result<(), IndexError> {
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
        match open_at(libc::AT_FDCWD, device_name) {
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

    fn io_issue(error: &io::Error) -> TraversalIssue {
        match error.kind() {
            io::ErrorKind::PermissionDenied => TraversalIssue::AccessDenied,
            io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => TraversalIssue::UnsafeTraversal,
            _ => TraversalIssue::ScanFailed,
        }
    }

    /// The returned file owns the successful descriptor. Every component is opened without following links.
    fn open_at(parent: libc::c_int, name: &CStr) -> io::Result<File> {
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
    fn descriptor_mount_fallback_requires_the_kernel_mount_id() {
        assert_eq!(descriptor_mount_id("pos:\t0\nmnt_id:\t42\nino:\t1\n").unwrap(), 42);
        assert!(descriptor_mount_id("ino:\t42\n").is_err());
        assert!(descriptor_mount_id("mnt_id:\tinvalid\n").is_err());
    }

    pub struct NativeRoot {
        path: PathBuf,
        file: File,
        pub identity: NativeIdentity,
    }

    impl NativeRoot {
        pub fn open(path: &Path) -> Result<Self, IndexError> {
            if !path.is_absolute() {
                return Err(IndexError::Invalid("Directory source root must be an absolute directory."));
            }
            super::validate_traversal_path(path)?;
            let mut file = open_at(
                libc::AT_FDCWD,
                CStr::from_bytes_with_nul(ROOT_NAME).map_err(|_| IndexError::Invalid("Invalid root name."))?,
            )?;
            for component in path.components() {
                match component {
                    Component::RootDir => {}
                    Component::Normal(name) => {
                        let name = CString::new(name.as_bytes())
                            .map_err(|_| IndexError::Invalid("Directory source root contains an unsupported name."))?;
                        file = open_at(file.as_raw_fd(), &name)?;
                    }
                    _ => {
                        return Err(IndexError::Invalid(
                            "Directory source root must not contain dot or parent components.",
                        ))
                    }
                }
            }
            let identity = identity(&file)?;
            validate_filesystem(&file, identity)?;
            Ok(Self {
                path: path.to_owned(),
                file,
                identity,
            })
        }

        pub fn verify(&self) -> Result<(), IndexError> {
            if Self::open(&self.path)?.identity != self.identity {
                return Err(io::Error::new(
                    io::ErrorKind::NotConnected,
                    "Directory root binding changed. Background verification will bind the root again.",
                )
                .into());
            }
            Ok(())
        }

        fn parent(&self, relative: &str) -> Result<File, IndexError> {
            super::validate_traversal_path(&self.path.join(relative))?;
            self.verify()?;
            let mut file = open_at(
                self.file.as_raw_fd(),
                CStr::from_bytes_with_nul(CURRENT_NAME).map_err(|_| IndexError::Invalid("Invalid current directory name."))?,
            )?;
            if !relative.is_empty() {
                super::super::directory_index::validate_directory_path(relative)?;
                for component in relative.split('/') {
                    let name = CString::new(component).map_err(|_| IndexError::Invalid("Directory name contains NUL."))?;
                    file = open_at(file.as_raw_fd(), &name)?;
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
            if identity(&self.parent(parent)?)? != expected {
                return Err(IndexError::Invalid(
                    "Directory parent changed during scanning. Retry source verification.",
                ));
            }
            Ok(())
        }

        pub fn parent_identity(&self, parent: &str) -> Result<NativeIdentity, IndexError> {
            identity(&self.parent(parent)?)
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
            super::super::directory_index::validate_directory_path(name)?;
            if name.contains('/') {
                return Err(IndexError::Invalid("Directory child check requires one native name."));
            }
            super::validate_traversal_path(&self.path.join(parent).join(name))?;
            let file = self.parent(parent)?;
            if identity(&file)? != expected {
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
                let child = match open_at(file.as_raw_fd(), &name) {
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
            self.verify_parent(parent, expected)?;
            Ok(found)
        }

        /// fdopendir owns its descriptor; copied names remain valid after the next readdir call.
        pub fn children(
            &self,
            parent: &str,
            mut receive: impl FnMut(Result<Option<(String, bool)>, TraversalIssue>) -> Result<(), IndexError>,
        ) -> Result<(), IndexError> {
            let file = self.parent(parent)?;
            let parent_identity = identity(&file)?;
            let descriptor = file.into_raw_fd();
            let pointer = unsafe { libc::fdopendir(descriptor) };
            let Some(pointer) = NonNull::new(pointer) else {
                let error = io::Error::last_os_error();
                drop(unsafe { File::from_raw_fd(descriptor) });
                return Err(error.into());
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
                        return Err(error.into());
                    }
                    return Ok(());
                }
                let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
                if matches!(name.to_bytes(), b"." | b"..") {
                    continue;
                }
                let Ok(text) = name.to_str() else {
                    receive(Err(TraversalIssue::UnsupportedEncoding))?;
                    continue;
                };
                let mut metadata = std::mem::MaybeUninit::<libc::stat>::zeroed();
                let result = unsafe { libc::fstatat(descriptor, name.as_ptr(), metadata.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
                if result != 0 {
                    let error = io::Error::last_os_error();
                    if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) {
                        if self.has_directory_child_with_check(parent, parent_identity, text, || receive(Ok(None)))? {
                            return Err(IndexError::Interrupted);
                        }
                    } else {
                        receive(Err(io_issue(&error)))?;
                    }
                    continue;
                }
                let metadata = unsafe { metadata.assume_init() };
                let kind = metadata.st_mode & libc::S_IFMT;
                if kind == libc::S_IFLNK {
                    receive(Err(TraversalIssue::UnsafeTraversal))?;
                    continue;
                }
                if kind != libc::S_IFDIR {
                    continue;
                }
                if super::validate_traversal_path(&self.path.join(parent).join(text)).is_err() {
                    receive(Err(TraversalIssue::UnsafeTraversal))?;
                    continue;
                }
                match open_at(descriptor, name).and_then(|child| identity(&child).map_err(io::Error::other)) {
                    Ok(child) if child.device == self.identity.device && child.mount == self.identity.mount => {
                        receive(Ok(Some((text.to_owned(), true))))?
                    }
                    Ok(_) => {
                        receive(Ok(Some((text.to_owned(), false))))?;
                        receive(Err(TraversalIssue::UnsafeTraversal))?;
                    }
                    Err(error) => {
                        if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) {
                            if self.has_directory_child_with_check(parent, parent_identity, text, || receive(Ok(None)))? {
                                return Err(IndexError::Interrupted);
                            }
                            continue;
                        }
                        receive(Ok(Some((text.to_owned(), false))))?;
                        receive(Err(io_issue(&error)))?;
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
pub use platform::NativeRoot;

#[cfg(windows)]
#[path = "directory_traversal_windows.rs"]
mod windows_platform;

#[cfg(windows)]
pub use windows_platform::NativeRoot;

#[cfg(not(any(target_os = "linux", windows)))]
pub struct NativeRoot {
    pub identity: NativeIdentity,
}

#[cfg(not(any(target_os = "linux", windows)))]
impl NativeRoot {
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
    pub fn children(
        &self,
        _: &str,
        _: impl FnMut(Result<Option<(String, bool)>, TraversalIssue>) -> Result<(), IndexError>,
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
        assert!(issues.contains(&TraversalIssue::UnsafeTraversal));
        assert!(issues.contains(&TraversalIssue::UnsupportedEncoding));
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
        assert_eq!(issues, [TraversalIssue::UnsafeTraversal]);
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
