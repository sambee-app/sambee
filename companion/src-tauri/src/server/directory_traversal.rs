//! Descriptor-based traversal; unsupported platforms fail closed without a lossy walker.

use std::path::Path;

use super::directory_index::IndexError;

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
        if result != 0 {
            return Err(io::Error::last_os_error().into());
        }
        let extended = unsafe { extended.assume_init() };
        if extended.stx_mask & libc::STATX_MNT_ID == 0 {
            return Err(IndexError::Invalid(
                "Directory mount identity is unavailable. Use a supported local filesystem.",
            ));
        }
        Ok(NativeIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            mount: extended.stx_mnt_id,
        })
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
                return Err(IndexError::Invalid(
                    "Directory source identity changed. Reopen the drive to build a new index.",
                ));
            }
            Ok(())
        }

        fn parent(&self, relative: &str) -> Result<File, IndexError> {
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
        pub fn has_directory_child(&self, parent: &str, expected: NativeIdentity, name: &str) -> Result<bool, IndexError> {
            super::super::directory_index::validate_directory_path(name)?;
            if name.contains('/') {
                return Err(IndexError::Invalid("Directory child check requires one native name."));
            }
            let file = self.parent(parent)?;
            if identity(&file)? != expected {
                return Err(IndexError::Invalid(
                    "Directory parent changed during reconciliation. Retry source verification.",
                ));
            }
            let name = CString::new(name).map_err(|_| IndexError::Invalid("Directory child name contains NUL."))?;
            let outcome = (|| {
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
            self.verify_parent(parent, expected)?;
            outcome
        }

        /// fdopendir owns its descriptor; copied names remain valid after the next readdir call.
        pub fn children(
            &self,
            parent: &str,
            mut receive: impl FnMut(Result<Option<(String, bool)>, TraversalIssue>) -> Result<(), IndexError>,
        ) -> Result<(), IndexError> {
            let file = self.parent(parent)?;
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
                    receive(Err(io_issue(&io::Error::last_os_error())))?;
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
                match open_at(descriptor, name).and_then(|child| identity(&child).map_err(io::Error::other)) {
                    Ok(child) if child.device == self.identity.device && child.mount == self.identity.mount => {
                        receive(Ok(Some((text.to_owned(), true))))?
                    }
                    Ok(_) => {
                        receive(Ok(Some((text.to_owned(), false))))?;
                        receive(Err(TraversalIssue::UnsafeTraversal))?;
                    }
                    Err(error) => {
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

#[cfg(not(target_os = "linux"))]
pub struct NativeRoot {
    pub identity: NativeIdentity,
}

#[cfg(not(target_os = "linux"))]
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
