//! Windows traversal with retained ancestor handles and exact native identities.

use super::{
    validate_windows_component as validate_name, windows_entry_name, windows_record_name_range, windows_reparse_kind, IndexError,
    NativeIdentity, TraversalIssue, WindowsReparseKind,
};
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Component, Path, PathBuf, Prefix};
use windows::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE};
use windows::Win32::Storage::FileSystem::{
    FileAttributeTagInfo, FileIdExtdDirectoryInfo, FileIdExtdDirectoryRestartInfo, FileIdInfo, GetFileInformationByHandleEx,
    GetFinalPathNameByHandleW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_EXTD_DIR_INFO, FILE_ID_INFO, FILE_INFO_BY_HANDLE_CLASS, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, VOLUME_NAME_NT,
};

const DIRECTORY_BUFFER_BYTES: usize = 64 * 1024;
const DIRECTORY_BUFFER_WORDS: usize = DIRECTORY_BUFFER_BYTES / size_of::<u64>();
const FILE_ID_HALF_BYTES: usize = size_of::<u64>();
const MAX_NATIVE_PATH_UNITS: usize = 32 * 1024;

fn query<T>(file: &File, class: FILE_INFO_BY_HANDLE_CLASS, output: &mut T) -> Result<(), IndexError> {
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            class,
            std::ptr::from_mut(output).cast(),
            size_of::<T>() as u32,
        )
    }
    .map_err(|error| io::Error::from_raw_os_error(error.code().0 & 0xffff))?;
    Ok(())
}

fn identity(file: &File) -> Result<NativeIdentity, IndexError> {
    let mut information = FILE_ID_INFO::default();
    query(file, FileIdInfo, &mut information)?;
    Ok(identity_information(&information))
}

fn identity_information(information: &FILE_ID_INFO) -> NativeIdentity {
    let bytes = information.FileId.Identifier;
    let mut low = [0; FILE_ID_HALF_BYTES];
    let mut high = [0; FILE_ID_HALF_BYTES];
    low.copy_from_slice(&bytes[..FILE_ID_HALF_BYTES]);
    high.copy_from_slice(&bytes[FILE_ID_HALF_BYTES..]);
    NativeIdentity {
        device: information.VolumeSerialNumber,
        inode: u64::from_le_bytes(low),
        mount: u64::from_le_bytes(high),
    }
}

#[test]
fn zero_volume_serial_and_full_file_id_are_valid_native_values() {
    let mut information = FILE_ID_INFO::default();
    assert_eq!(identity_information(&information).device, 0);
    information.VolumeSerialNumber = u64::from(u32::MAX) + 1;
    information.FileId.Identifier = [u8::MAX; size_of::<u128>()];
    let found = identity_information(&information);
    assert_eq!(found.device, u64::from(u32::MAX) + 1);
    assert_eq!(found.inode, u64::MAX);
    assert_eq!(found.mount, u64::MAX);
}

fn attributes(file: &File) -> Result<FILE_ATTRIBUTE_TAG_INFO, IndexError> {
    let mut information = FILE_ATTRIBUTE_TAG_INFO::default();
    query(file, FileAttributeTagInfo, &mut information)?;
    Ok(information)
}

fn native_path(file: &File) -> Result<PathBuf, IndexError> {
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(MAX_NATIVE_PATH_UNITS)
        .map_err(|_| IndexError::Invalid("Directory identity buffer allocation failed. Close other applications and retry indexing."))?;
    buffer.resize(MAX_NATIVE_PATH_UNITS, 0u16);
    let length = unsafe { GetFinalPathNameByHandleW(HANDLE(file.as_raw_handle()), &mut buffer, VOLUME_NAME_NT) } as usize;
    if length == 0 {
        return Err(io::Error::last_os_error().into());
    }
    if length >= buffer.len() {
        return Err(IndexError::Invalid(
            "Directory native identity path exceeds the supported size. Source coverage is incomplete.",
        ));
    }
    let path = String::from_utf16(&buffer[..length])
        .map_err(|_| IndexError::Invalid("Directory native identity has unsupported encoding. Use a supported source."))?;
    Ok(PathBuf::from(path))
}

fn open_directory(path: &Path) -> Result<File, IndexError> {
    let file = OpenOptions::new()
        .read(true)
        .access_mode(FILE_LIST_DIRECTORY.0 | FILE_READ_ATTRIBUTES.0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)?;
    let information = attributes(&file)?;
    if information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0
        || information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || windows_reparse_kind(information.ReparseTag) != WindowsReparseKind::Ordinary
    {
        return Err(IndexError::Invalid(
            "Directory path is redirected or unavailable. Select a real directory on a supported volume.",
        ));
    }
    Ok(file)
}

fn root_path(path: &Path) -> Result<PathBuf, IndexError> {
    if !path.is_absolute() {
        return Err(IndexError::Invalid("Directory source root must be an absolute directory."));
    }
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return Err(IndexError::Invalid("Directory source root has no supported Windows volume prefix."));
    };
    let mut result = match prefix.kind() {
        Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => PathBuf::from(format!("\\\\?\\{}:\\", char::from(drive))),
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
            let server = server
                .to_str()
                .ok_or(IndexError::Invalid("Directory server name has unsupported native encoding."))?;
            let share = share
                .to_str()
                .ok_or(IndexError::Invalid("Directory share name has unsupported native encoding."))?;
            validate_name(server)?;
            validate_name(share)?;
            PathBuf::from(format!("\\\\?\\UNC\\{server}\\{share}\\"))
        }
        _ => {
            return Err(IndexError::Invalid(
                "Device namespace paths cannot be indexed. Select a drive or share root.",
            ))
        }
    };
    for component in components {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                let name = name
                    .to_str()
                    .ok_or(IndexError::Invalid("Directory path has unsupported native encoding."))?;
                validate_name(name)?;
                result.push(name);
            }
            _ => {
                return Err(IndexError::Invalid(
                    "Directory source root must not contain dot or parent components.",
                ))
            }
        }
    }
    Ok(result)
}

/// Compare handle-normalized paths, not input components that can contain DOS aliases.
fn verify_native_parent(parent: &Path, child: &Path) -> Result<(), IndexError> {
    if child.parent() != Some(parent) {
        return Err(IndexError::Invalid(
            "Directory ancestry changed or redirected during open. Retry source verification.",
        ));
    }
    Ok(())
}

/// No ancestor permits deletion or rename while a descendant is opened or read.
fn open_chain(path: &Path) -> Result<Vec<File>, IndexError> {
    let mut current = PathBuf::new();
    let mut files = Vec::new();
    let mut volume = None;
    let mut binding: Option<PathBuf> = None;
    for component in path.components() {
        current.push(component);
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let file = open_directory(&current)?;
        let found = identity(&file)?;
        let native = native_path(&file)?;
        if let Some(parent) = binding.as_ref() {
            verify_native_parent(parent, &native)?;
        }
        if volume.is_some_and(|expected| expected != found.device) {
            return Err(IndexError::Invalid(
                "Directory traversal would cross a volume. Index the mounted drive separately.",
            ));
        }
        volume = Some(found.device);
        binding = Some(native);
        files.push(file);
    }
    if files.is_empty() {
        return Err(IndexError::Invalid("Directory source root has no directory handle."));
    }
    Ok(files)
}

fn last(files: &[File]) -> Result<&File, IndexError> {
    files
        .last()
        .ok_or(IndexError::Invalid("Directory source handle is unavailable. Reopen the drive."))
}

/// Each native record and UTF-16 name is checked before it is read from the bounded buffer.
fn visit(
    file: &File,
    mut receive: impl FnMut(Option<(&FILE_ID_EXTD_DIR_INFO, &[u16])>) -> Result<bool, IndexError>,
) -> Result<(), IndexError> {
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(DIRECTORY_BUFFER_WORDS)
        .map_err(|_| IndexError::Invalid("Directory enumeration buffer allocation failed. Close other applications and retry indexing."))?;
    buffer.resize(DIRECTORY_BUFFER_WORDS, 0u64);
    let name_offset = offset_of!(FILE_ID_EXTD_DIR_INFO, FileName);
    let mut class = FileIdExtdDirectoryRestartInfo;
    loop {
        if !receive(None)? {
            return Ok(());
        }
        buffer.fill(0);
        let result = unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                class,
                buffer.as_mut_ptr().cast(),
                DIRECTORY_BUFFER_BYTES as u32,
            )
        };
        if let Err(error) = result {
            if error.code() == windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) {
                return Ok(());
            }
            return Err(io::Error::from_raw_os_error(error.code().0 & 0xffff).into());
        }
        class = FileIdExtdDirectoryInfo;
        let mut offset = 0usize;
        loop {
            if !receive(None)? {
                return Ok(());
            }
            if DIRECTORY_BUFFER_BYTES - offset < size_of::<FILE_ID_EXTD_DIR_INFO>() {
                return Err(IndexError::Invalid(
                    "Directory enumeration returned an incomplete native record. Retry verification.",
                ));
            }
            let record = unsafe {
                buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<FILE_ID_EXTD_DIR_INFO>()
                    .read_unaligned()
            };
            let name_bytes = record.FileNameLength as usize;
            let remaining = DIRECTORY_BUFFER_BYTES - offset;
            let range = windows_record_name_range(remaining, record.NextEntryOffset as usize, name_offset, name_bytes)?;
            let name = unsafe {
                std::slice::from_raw_parts(
                    buffer.as_ptr().cast::<u8>().add(offset + range.start).cast::<u16>(),
                    range.len() / size_of::<u16>(),
                )
            };
            if !receive(Some((&record, name)))? {
                return Ok(());
            }
            if record.NextEntryOffset == 0 {
                break;
            }
            offset += record.NextEntryOffset as usize;
        }
    }
}

pub struct NativeRoot {
    path: PathBuf,
    binding: PathBuf,
    files: Vec<File>,
    pub identity: NativeIdentity,
}

impl NativeRoot {
    pub fn open(path: &Path) -> Result<Self, IndexError> {
        super::validate_traversal_path(path)?;
        let path = root_path(path)?;
        let files = open_chain(&path)?;
        let identity = identity(last(&files)?)?;
        let binding = native_path(last(&files)?)?;
        Ok(Self {
            path,
            binding,
            files,
            identity,
        })
    }

    pub fn verify(&self) -> Result<(), IndexError> {
        let current = open_chain(&self.path)?;
        if identity(last(&self.files)?)? != self.identity
            || identity(last(&current)?)? != self.identity
            || native_path(last(&current)?)? != self.binding
            || native_path(last(&self.files)?)? != self.binding
        {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "Directory root binding changed. Background verification will bind the root again.",
            )
            .into());
        }
        Ok(())
    }

    fn parent(&self, relative: &str) -> Result<Vec<File>, IndexError> {
        self.verify()?;
        let mut path = self.path.clone();
        if !relative.is_empty() {
            super::super::directory_index::validate_directory_path(relative)?;
            for name in relative.split('/') {
                validate_name(name)?;
                path.push(name);
            }
        }
        super::validate_traversal_path(&path)?;
        let files = open_chain(&path)?;
        let expected = if relative.is_empty() {
            self.binding.clone()
        } else {
            self.binding.join(relative.replace('/', "\\"))
        };
        if identity(last(&files)?)?.device != self.identity.device || native_path(last(&files)?)? != expected {
            return Err(IndexError::Invalid(
                "Directory parent belongs to a different volume. Retry source verification.",
            ));
        }
        Ok(files)
    }

    pub fn parent_identity(&self, parent: &str) -> Result<NativeIdentity, IndexError> {
        identity(last(&self.parent(parent)?)?)
    }

    pub fn verify_parent(&self, parent: &str, expected: NativeIdentity) -> Result<(), IndexError> {
        if self.parent_identity(parent)? != expected {
            return Err(IndexError::Invalid(
                "Directory parent changed during scanning. Retry source verification.",
            ));
        }
        Ok(())
    }

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
        validate_name(name)?;
        super::validate_traversal_path(&self.path.join(parent.replace('/', "\\")).join(name))?;
        let files = self.parent(parent)?;
        let file = last(&files)?;
        if identity(file)? != expected {
            return Err(IndexError::Invalid(
                "Directory parent changed during reconciliation. Retry source verification.",
            ));
        }
        let mut found = false;
        visit(file, |entry| {
            check()?;
            self.verify_parent(parent, expected)?;
            let Some((record, native_name)) = entry else {
                return Ok(true);
            };
            let text =
                String::from_utf16(native_name).map_err(|_| IndexError::Invalid("Directory entry has unsupported native encoding."))?;
            if text != name {
                return Ok(true);
            }
            if record.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
                || windows_reparse_kind(record.ReparsePointTag) != WindowsReparseKind::Ordinary
            {
                return Err(IndexError::Invalid(
                    "Directory child is redirected or unverified. Retry full source verification.",
                ));
            }
            found = record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
            Ok(false)
        })?;
        check()?;
        self.verify_parent(parent, expected)?;
        Ok(found)
    }

    pub fn children(
        &self,
        parent: &str,
        mut receive: impl FnMut(Result<Option<(String, bool)>, TraversalIssue>) -> Result<(), IndexError>,
    ) -> Result<(), IndexError> {
        let files = self.parent(parent)?;
        let file = last(&files)?;
        let expected = identity(file)?;
        visit(file, |entry| {
            let Some((record, native_name)) = entry else {
                receive(Ok(None))?;
                return Ok(true);
            };
            if native_name == [b'.' as u16] || native_name == [b'.' as u16, b'.' as u16] {
                return Ok(true);
            }
            let name = match windows_entry_name(native_name) {
                Ok(name) => name,
                Err(issue) => {
                    receive(Err(issue))?;
                    return Ok(true);
                }
            };
            if record.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
                || windows_reparse_kind(record.ReparsePointTag) != WindowsReparseKind::Ordinary
            {
                receive(Err(TraversalIssue::UnsafeTraversal))?;
                return Ok(true);
            }
            if record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0 {
                return Ok(true);
            }
            let path = self.path.join(parent.replace('/', "\\")).join(&name);
            if super::validate_traversal_path(&path).is_err() {
                receive(Err(TraversalIssue::UnsafeTraversal))?;
                return Ok(true);
            }
            let event = match open_directory(&path).and_then(|child| {
                if native_path(&child)? != native_path(file)?.join(&name) {
                    return Err(IndexError::Invalid(
                        "Directory child was redirected outside its observed parent. Retry verification.",
                    ));
                }
                identity(&child)
            }) {
                Ok(child)
                    if child.device == self.identity.device
                        && child.inode.to_le_bytes() == record.FileId.Identifier[..FILE_ID_HALF_BYTES]
                        && child.mount.to_le_bytes() == record.FileId.Identifier[FILE_ID_HALF_BYTES..] =>
                {
                    Ok(Some((name, true)))
                }
                Ok(_) => Err(TraversalIssue::UnsafeTraversal),
                Err(IndexError::Io(error)) if error.kind() == io::ErrorKind::PermissionDenied => Err(TraversalIssue::AccessDenied),
                Err(_) => Err(TraversalIssue::UnsafeTraversal),
            };
            self.verify_parent(parent, expected)?;
            receive(event)?;
            Ok(true)
        })?;
        self.verify_parent(parent, expected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;

    #[test]
    fn normalized_ancestry_accepts_aliases_but_rejects_different_parents() {
        let parent = Path::new(r"\Device\HarddiskVolume1\Users");
        let normalized = parent.join("runneradmin");
        assert_ne!(parent.join("RUNNER~1"), normalized);
        verify_native_parent(parent, &normalized).unwrap();
        for redirected in [
            r"\Device\HarddiskVolume1\UsersElse\runneradmin",
            r"\Device\HarddiskVolume1\Users\runneradmin\AppData",
            r"\Device\HarddiskVolume2\Users\runneradmin",
            r"\Device\HarddiskVolume1\users\runneradmin",
            r"\Device\HarddiskVolume1\Users",
        ] {
            assert!(
                verify_native_parent(parent, Path::new(redirected)).is_err(),
                "Unexpected ancestry: {redirected}"
            );
        }
    }

    #[test]
    fn short_root_paths_preserve_handle_identity_verification_and_enumeration() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("Mixed Case Source Directory");
        std::fs::create_dir_all(path.join("parent/child")).unwrap();
        let native: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut buffer = vec![0u16; MAX_NATIVE_PATH_UNITS];
        let length = unsafe { GetShortPathNameW(PCWSTR(native.as_ptr()), Some(&mut buffer)) } as usize;
        assert!(
            length > 0 && length < buffer.len(),
            "Short path query failed: {}",
            io::Error::last_os_error()
        );
        let alias = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
        let root = NativeRoot::open(&path).unwrap();
        let short_root = NativeRoot::open(&alias).unwrap();
        assert_eq!(short_root.identity, root.identity);
        assert_eq!(short_root.binding, root.binding);
        short_root.verify().unwrap();
        let parent = short_root.parent_identity("parent").unwrap();
        assert!(short_root.has_directory_child("parent", parent, "child").unwrap());
        let mut rows = Vec::new();
        short_root
            .children("parent", |event| {
                match event {
                    Ok(Some(row)) => rows.push(row),
                    Ok(None) => {}
                    Err(issue) => panic!("Unexpected traversal issue: {issue:?}"),
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(rows, vec![("child".to_owned(), true)]);
    }

    #[test]
    fn junction_ancestors_and_children_are_rejected() {
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("target");
        let junction = temporary.path().join("redirected");
        std::fs::create_dir_all(target.join("child")).unwrap();
        let result = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .output()
            .unwrap();
        assert!(result.status.success(), "Junction creation failed: {result:?}");
        for path in [&junction, &junction.join("child")] {
            assert!(matches!(NativeRoot::open(path), Err(IndexError::Invalid(_))));
        }
        let root = NativeRoot::open(temporary.path()).unwrap();
        let mut issues = Vec::new();
        root.children("", |event| {
            if let Err(issue) = event {
                issues.push(issue);
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(issues, vec![TraversalIssue::UnsafeTraversal]);
        assert!(root.has_directory_child("", root.identity, "redirected").is_err());
    }

    #[test]
    fn native_handles_preserve_exact_names_and_exclude_regular_files() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source");
        std::fs::create_dir_all(path.join("parent/é")).unwrap();
        std::fs::create_dir(path.join("parent/.hidden")).unwrap();
        std::fs::write(path.join("parent/file.lnk"), b"not a directory").unwrap();
        let root = NativeRoot::open(&path).unwrap();
        let parent = root.parent_identity("parent").unwrap();
        let mut rows = Vec::new();
        root.children("parent", |event| {
            match event {
                Ok(Some(row)) => rows.push(row),
                Ok(None) => {}
                Err(issue) => panic!("Unexpected traversal issue: {issue:?}"),
            }
            Ok(())
        })
        .unwrap();
        rows.sort();
        assert_eq!(rows, vec![(".hidden".to_owned(), true), ("é".to_owned(), true)]);
        assert!(root.has_directory_child("parent", parent, "é").unwrap());
        assert!(!root.has_directory_child("parent", parent, "É").unwrap());
        assert!(!root.has_directory_child("parent", parent, "missing").unwrap());
        assert!(!root.has_directory_child("parent", parent, "file.lnk").unwrap());
        assert!(root.has_directory_child("parent", parent, "nested/name").is_err());
    }

    #[test]
    fn held_root_and_ancestors_refuse_replacement_until_release() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source");
        std::fs::create_dir_all(path.join("parent")).unwrap();
        let root = NativeRoot::open(&path).unwrap();
        assert!(std::fs::rename(&path, temporary.path().join("old-source")).is_err());
        let held = root.parent("parent").unwrap();
        assert!(std::fs::rename(path.join("parent"), path.join("old-parent")).is_err());
        drop(held);
        let old = root.parent_identity("parent").unwrap();
        std::fs::rename(path.join("parent"), path.join("old-parent")).unwrap();
        std::fs::create_dir(path.join("parent")).unwrap();
        assert!(root.verify_parent("parent", old).is_err());
        root.verify().unwrap();
        drop(root);
        std::fs::rename(&path, temporary.path().join("old-source")).unwrap();
    }

    #[test]
    fn cancellation_and_early_exact_match_stop_enumeration() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("source");
        std::fs::create_dir(&path).unwrap();
        for number in 0..513 {
            std::fs::create_dir(path.join(format!("child-{number:04}"))).unwrap();
        }
        let root = NativeRoot::open(&path).unwrap();
        let mut checks = 0;
        assert!(matches!(
            root.children("", |_| {
                checks += 1;
                Err(IndexError::Interrupted)
            }),
            Err(IndexError::Interrupted)
        ));
        assert_eq!(checks, 1);
        let mut lookup_checks = 0;
        assert!(matches!(
            root.has_directory_child_with_check("", root.identity, "missing", || {
                lookup_checks += 1;
                if lookup_checks == 3 {
                    Err(IndexError::Interrupted)
                } else {
                    Ok(())
                }
            }),
            Err(IndexError::Interrupted)
        ));
        assert_eq!(lookup_checks, 3);
        let held = root.parent("").unwrap();
        let mut records = 0;
        visit(last(&held).unwrap(), |entry| {
            if entry.is_some() {
                records += 1;
                return Ok(false);
            }
            Ok(true)
        })
        .unwrap();
        assert_eq!(records, 1);
        let mut rows = 0;
        root.children("", |entry| {
            if matches!(entry, Ok(Some(_))) {
                rows += 1;
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(rows, 513);
    }

    #[test]
    fn unsafe_windows_names_and_device_roots_are_refused() {
        for name in [".", "..", "a/b", "a\\b", "stream:alternate", "wild*card", "name?", "tail.", "tail "] {
            assert!(validate_name(name).is_err(), "Unexpected valid name: {name}");
        }
        for path in [
            "relative",
            "C:relative",
            "\\\\.\\C:\\",
            "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\",
        ] {
            assert!(root_path(Path::new(path)).is_err(), "Unexpected valid root: {path}");
        }
    }
}
