//! Windows traversal with retained ancestor handles and exact native identities.

use super::{
    validate_windows_component as validate_name, windows_entry_name, windows_record_name_range, windows_reparse_kind, IndexError,
    NativeChild, NativeIdentity, TraversalIssue, WindowsReparseKind,
};
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::{offset_of, size_of};
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf, Prefix};
use std::sync::atomic::{AtomicBool, Ordering};
use windows::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows::Wdk::Storage::FileSystem::{
    NtCreateFile, FILE_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_FOR_BACKUP_INTENT, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows::Win32::Foundation::{
    RtlNtStatusToDosError, ERROR_CALL_NOT_IMPLEMENTED, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED,
    ERROR_NO_MORE_FILES, HANDLE, OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING,
};
use windows::Win32::Storage::FileSystem::{
    ExtendedFileIdType, FileAttributeTagInfo, FileIdExtdDirectoryInfo, FileIdExtdDirectoryRestartInfo, FileIdInfo, FileIdType,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, OpenFileById, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_128, FILE_ID_DESCRIPTOR,
    FILE_ID_DESCRIPTOR_0, FILE_ID_EXTD_DIR_INFO, FILE_ID_INFO, FILE_INFO_BY_HANDLE_CLASS, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES,
    FILE_SHARE_DELETE, FILE_SHARE_MODE, FILE_SHARE_READ, FILE_SHARE_WRITE, SYNCHRONIZE, VOLUME_NAME_NT,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;

const FILE_ID_HALF_BYTES: usize = size_of::<u64>();
const MAX_NATIVE_PATH_UNITS: usize = 32 * 1024;
const ROOT_SHARE_MODE: FILE_SHARE_MODE = FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0);
const SCAN_SHARE_MODE: FILE_SHARE_MODE = FILE_SHARE_MODE(ROOT_SHARE_MODE.0 | FILE_SHARE_DELETE.0);

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

fn open_directory(path: &Path, io: &super::NativeIo, share_mode: FILE_SHARE_MODE) -> Result<File, IndexError> {
    io.record_open();
    let file = OpenOptions::new()
        .read(true)
        .access_mode(FILE_LIST_DIRECTORY.0 | FILE_READ_ATTRIBUTES.0)
        .share_mode(share_mode.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)?;
    validate_directory(&file)?;
    Ok(file)
}

fn validate_directory(file: &File) -> Result<(), IndexError> {
    let information = attributes(file)?;
    if information.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0
        || information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
        || windows_reparse_kind(information.ReparseTag) != WindowsReparseKind::Ordinary
    {
        return Err(IndexError::Invalid(
            "Directory path is redirected or unavailable. Select a real directory on a supported volume.",
        ));
    }
    Ok(())
}

fn file_id_descriptor(file_id: &[u8; size_of::<u128>()], legacy: bool) -> Result<FILE_ID_DESCRIPTOR, IndexError> {
    let (kind, value) = if legacy {
        if file_id[FILE_ID_HALF_BYTES..].iter().any(|byte| *byte != 0) {
            return Err(IndexError::Invalid(
                "Directory FileId cannot use a 64-bit descriptor. Retry source verification.",
            ));
        }
        let mut bytes = [0; FILE_ID_HALF_BYTES];
        bytes.copy_from_slice(&file_id[..FILE_ID_HALF_BYTES]);
        (
            FileIdType,
            FILE_ID_DESCRIPTOR_0 {
                FileId: i64::from_le_bytes(bytes),
            },
        )
    } else {
        (
            ExtendedFileIdType,
            FILE_ID_DESCRIPTOR_0 {
                ExtendedFileId: FILE_ID_128 { Identifier: *file_id },
            },
        )
    };
    Ok(FILE_ID_DESCRIPTOR {
        dwSize: size_of::<FILE_ID_DESCRIPTOR>() as u32,
        Type: kind,
        Anonymous: value,
    })
}

fn open_directory_by_id(volume: &File, descriptor: &FILE_ID_DESCRIPTOR, io: &super::NativeIo) -> Result<File, IndexError> {
    io.record_open();
    let handle = unsafe {
        OpenFileById(
            HANDLE(volume.as_raw_handle()),
            descriptor,
            FILE_LIST_DIRECTORY.0 | FILE_READ_ATTRIBUTES.0,
            SCAN_SHARE_MODE,
            None,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        )
    }
    .map_err(|error| io::Error::from_raw_os_error(error.code().0 & 0xffff))?;
    let file = unsafe { File::from_raw_handle(handle.0) };
    validate_directory(&file)?;
    Ok(file)
}

fn native_open_unsupported(error: &IndexError) -> bool {
    matches!(error, IndexError::Io(error) if error.raw_os_error().is_some_and(|code|
        [ERROR_INVALID_FUNCTION.0, ERROR_NOT_SUPPORTED.0, ERROR_CALL_NOT_IMPLEMENTED.0].contains(&(code as u32))))
}

/// Open below the retained root without following any reparse point.
fn open_directory_relative(root: &File, relative: &str, io: &super::NativeIo) -> Result<File, IndexError> {
    super::super::directory_index::validate_directory_path(relative)?;
    for component in relative.split('/') {
        validate_name(component)?;
    }
    let text = relative.replace('/', "\\");
    let mut name = Vec::new();
    name.try_reserve_exact(text.len())
        .map_err(|_| IndexError::Invalid("Directory relative-name allocation failed. Close other applications and retry indexing."))?;
    name.extend(text.encode_utf16());
    let byte_length = name
        .len()
        .checked_mul(size_of::<u16>())
        .and_then(|length| u16::try_from(length).ok())
        .ok_or(IndexError::Invalid(
            "Directory relative name exceeds the native limit. Shorten the path and retry indexing.",
        ))?;
    let native_name = UNICODE_STRING {
        Length: byte_length,
        MaximumLength: byte_length,
        Buffer: windows::core::PWSTR(name.as_mut_ptr()),
    };
    let object = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: HANDLE(root.as_raw_handle()),
        ObjectName: &native_name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        ..Default::default()
    };
    let mut handle = HANDLE::default();
    let mut completion = IO_STATUS_BLOCK::default();
    io.record_open();
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            &object,
            &mut completion,
            None,
            Default::default(),
            SCAN_SHARE_MODE,
            FILE_OPEN,
            FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_SYNCHRONOUS_IO_NONALERT,
            None,
            0,
        )
    };
    if status.is_err() {
        return Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32).into());
    }
    if handle.is_invalid() {
        return Err(IndexError::Invalid(
            "Directory relative open returned no handle. Retry source verification.",
        ));
    }
    let file = unsafe { File::from_raw_handle(handle.0) };
    validate_directory(&file)?;
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

/// Root bindings block rename; scan chains permit it and validate the retained native path.
fn open_chain(path: &Path, io: &super::NativeIo, share_mode: FILE_SHARE_MODE) -> Result<Vec<File>, IndexError> {
    let mut current = PathBuf::new();
    let mut files = Vec::new();
    let mut volume = None;
    let mut binding: Option<PathBuf> = None;
    for component in path.components() {
        current.push(component);
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let file = open_directory(&current, io, share_mode)?;
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
    let buffer_bytes = super::super::directory_manager::limit("scan_query_buffer_max_bytes")?;
    let native_buffer_bytes = u32::try_from(buffer_bytes)
        .map_err(|_| IndexError::Invalid("Directory enumeration buffer exceeds the native limit. Restore the shared contract."))?;
    if buffer_bytes < size_of::<FILE_ID_EXTD_DIR_INFO>() || !buffer_bytes.is_multiple_of(size_of::<u64>()) {
        return Err(IndexError::Invalid(
            "Directory enumeration buffer is invalid. Restore the shared contract.",
        ));
    }
    let buffer_words = buffer_bytes / size_of::<u64>();
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(buffer_words)
        .map_err(|_| IndexError::Invalid("Directory enumeration buffer allocation failed. Close other applications and retry indexing."))?;
    buffer.resize(buffer_words, 0u64);
    let name_offset = offset_of!(FILE_ID_EXTD_DIR_INFO, FileName);
    let mut class = FileIdExtdDirectoryRestartInfo;
    loop {
        if !receive(None)? {
            return Ok(());
        }
        buffer.fill(0);
        let result =
            unsafe { GetFileInformationByHandleEx(HANDLE(file.as_raw_handle()), class, buffer.as_mut_ptr().cast(), native_buffer_bytes) };
        if let Err(error) = result {
            if error.code() == windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) {
                return Ok(());
            }
            return Err(super::source_error(IndexError::Io(io::Error::from_raw_os_error(
                error.code().0 & 0xffff,
            ))));
        }
        class = FileIdExtdDirectoryInfo;
        let mut offset = 0usize;
        loop {
            if !receive(None)? {
                return Ok(());
            }
            if buffer_bytes - offset < size_of::<FILE_ID_EXTD_DIR_INFO>() {
                return Err(IndexError::SourceItem(TraversalIssue::ScanFailed.code()));
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
            let remaining = buffer_bytes - offset;
            let range = windows_record_name_range(remaining, record.NextEntryOffset as usize, name_offset, name_bytes)
                .map_err(super::source_error)?;
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
    io: std::sync::Arc<super::NativeIo>,
    probes: super::RootProbeState,
    extended_id_unsupported: AtomicBool,
    legacy_id_unsupported: AtomicBool,
    relative_open_unsupported: AtomicBool,
    pub identity: NativeIdentity,
}

pub struct NativeParent<'root> {
    root: &'root NativeRoot,
    relative: String,
    files: Vec<File>,
    pub identity: NativeIdentity,
}

impl NativeParent<'_> {
    pub fn verify(&self) -> Result<(), IndexError> {
        self.root.verify_held_parent(&self.relative, last(&self.files)?, self.identity)
    }

    pub fn children_with_ids(
        &self,
        receive: impl FnMut(Result<Option<NativeChild>, TraversalIssue>) -> Result<(), IndexError>,
    ) -> Result<(), IndexError> {
        self.verify().map_err(super::source_error)?;
        self.root.children_from_handles(&self.relative, &self.files, receive)
    }

    #[cfg(test)]
    pub fn has_directory_child_with_check(&self, name: &str, check: impl FnMut() -> Result<(), IndexError>) -> Result<bool, IndexError> {
        self.verify().map_err(super::source_error)?;
        self.root
            .has_directory_child_from_handles(&self.relative, self.identity, &self.files, name, check)
    }
}

impl NativeRoot {
    pub fn open_parent(&self, relative: &str) -> Result<NativeParent<'_>, IndexError> {
        self.open_parent_with_check(relative, true, None)
    }

    pub fn open_parent_for_scan(&self, relative: &str) -> Result<NativeParent<'_>, IndexError> {
        self.open_parent_with_check(relative, false, None)
    }

    /// The queued identity selects an open method; callers still check the returned identity after fallback.
    pub fn open_parent_for_scan_with_id(&self, relative: &str, expected_id: &[u8]) -> Result<NativeParent<'_>, IndexError> {
        self.open_parent_with_check(relative, false, Some(expected_id))
    }

    pub fn require_verification(&self) {
        self.probes.require();
    }

    fn open_parent_with_check(
        &self,
        relative: &str,
        full_root_check: bool,
        expected_id: Option<&[u8]>,
    ) -> Result<NativeParent<'_>, IndexError> {
        let result = (|| {
            let files = match expected_id {
                Some(expected) => self.parent_by_id(relative, expected)?,
                None => self.parent(relative, full_root_check)?,
            };
            let identity = identity(last(&files)?)?;
            Ok(NativeParent {
                root: self,
                relative: relative.to_owned(),
                files,
                identity,
            })
        })();
        if result.is_err() {
            self.require_verification();
        }
        result
    }

    fn verify_held_parent(&self, parent: &str, file: &File, expected: NativeIdentity) -> Result<(), IndexError> {
        let expected_path = if parent.is_empty() {
            self.binding.clone()
        } else {
            self.binding.join(parent.replace('/', "\\"))
        };
        if identity(file)? != expected || native_path(file)? != expected_path {
            return Err(IndexError::Invalid(
                "Directory parent changed during scanning. Retry source verification.",
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn open(path: &Path) -> Result<Self, IndexError> {
        Self::open_with_io(path, std::sync::Arc::default())
    }

    pub fn open_with_io(path: &Path, io: std::sync::Arc<super::NativeIo>) -> Result<Self, IndexError> {
        super::validate_traversal_path(path)?;
        let path = root_path(path)?;
        let files = open_chain(&path, &io, ROOT_SHARE_MODE)?;
        let identity = identity(last(&files)?)?;
        let binding = native_path(last(&files)?)?;
        Ok(Self {
            path,
            binding,
            files,
            io,
            probes: super::RootProbeState::default(),
            extended_id_unsupported: AtomicBool::new(false),
            legacy_id_unsupported: AtomicBool::new(false),
            relative_open_unsupported: AtomicBool::new(false),
            identity,
        })
    }

    pub fn verify(&self) -> Result<(), IndexError> {
        let version = self.probes.require();
        let current = open_chain(&self.path, &self.io, ROOT_SHARE_MODE)?;
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
        self.probes.complete(version);
        Ok(())
    }

    fn verify_for_read(&self, full_root_check: bool) -> Result<(), IndexError> {
        if full_root_check || self.probes.needed() {
            self.verify()?;
        } else {
            self.verify_held_parent("", last(&self.files)?, self.identity)?;
        }
        Ok(())
    }

    fn parent_path(&self, relative: &str) -> Result<PathBuf, IndexError> {
        let mut path = self.path.clone();
        if !relative.is_empty() {
            super::super::directory_index::validate_directory_path(relative)?;
            for name in relative.split('/') {
                validate_name(name)?;
                path.push(name);
            }
        }
        super::validate_traversal_path(&path)?;
        Ok(path)
    }

    fn parent_by_id(&self, relative: &str, expected_id: &[u8]) -> Result<Vec<File>, IndexError> {
        let file_id: &[u8; size_of::<u128>()] = expected_id
            .try_into()
            .map_err(|_| IndexError::Invalid("Directory FileId must contain 16 bytes. Rebuild the directory index."))?;
        self.verify_for_read(false)?;
        self.parent_path(relative)?;
        let expected_path = if relative.is_empty() {
            self.binding.clone()
        } else {
            self.binding.join(relative.replace('/', "\\"))
        };
        let mut extended_invalid = false;
        for (legacy, unsupported) in [(false, &self.extended_id_unsupported), (true, &self.legacy_id_unsupported)] {
            if unsupported.load(Ordering::Acquire) || (legacy && file_id[FILE_ID_HALF_BYTES..].iter().any(|byte| *byte != 0)) {
                continue;
            }
            let descriptor = file_id_descriptor(file_id, legacy)?;
            match open_directory_by_id(last(&self.files)?, &descriptor, &self.io) {
                Ok(file) => {
                    let current = identity(&file)?;
                    if current.device == self.identity.device && current.file_id() == expected_id && native_path(&file)? == expected_path {
                        if legacy && extended_invalid {
                            self.extended_id_unsupported.store(true, Ordering::Release);
                        }
                        return Ok(vec![file]);
                    }
                    break;
                }
                Err(error) if native_open_unsupported(&error) => unsupported.store(true, Ordering::Release),
                Err(IndexError::Io(error)) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER.0 as i32) => {
                    if !legacy {
                        extended_invalid = true;
                    }
                }
                Err(IndexError::Io(error)) if error.kind() == io::ErrorKind::NotFound => break,
                Err(error) => return Err(error),
            }
        }
        self.parent_relative(relative)
    }

    fn parent_relative(&self, relative: &str) -> Result<Vec<File>, IndexError> {
        if relative.is_empty() || self.relative_open_unsupported.load(Ordering::Acquire) {
            return self.parent(relative, false);
        }
        match open_directory_relative(last(&self.files)?, relative, &self.io) {
            Ok(file) => {
                let current = identity(&file)?;
                if current.device != self.identity.device {
                    return Err(IndexError::Invalid(
                        "Directory traversal would cross a volume. Index the mounted drive separately.",
                    ));
                }
                self.verify_held_parent(relative, &file, current)?;
                Ok(vec![file])
            }
            Err(error) if native_open_unsupported(&error) => {
                self.relative_open_unsupported.store(true, Ordering::Release);
                self.parent(relative, false)
            }
            Err(IndexError::Io(error)) if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER.0 as i32) => self.parent(relative, false),
            Err(error) => Err(error),
        }
    }

    fn parent(&self, relative: &str, full_root_check: bool) -> Result<Vec<File>, IndexError> {
        self.verify_for_read(full_root_check)?;
        let path = self.parent_path(relative)?;
        let share_mode = if full_root_check || relative.is_empty() {
            ROOT_SHARE_MODE
        } else {
            SCAN_SHARE_MODE
        };
        let files = open_chain(&path, &self.io, share_mode)?;
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
        identity(last(&self.parent(parent, true)?)?)
    }

    #[cfg(test)]
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

    #[cfg(test)]
    pub fn has_directory_child_with_check(
        &self,
        parent: &str,
        expected: NativeIdentity,
        name: &str,
        mut check: impl FnMut() -> Result<(), IndexError>,
    ) -> Result<bool, IndexError> {
        check()?;
        let files = self.parent(parent, true)?;
        let found = self.has_directory_child_from_handles(parent, expected, &files, name, check)?;
        self.verify_parent(parent, expected)?;
        Ok(found)
    }

    fn has_directory_child_from_handles(
        &self,
        parent: &str,
        expected: NativeIdentity,
        files: &[File],
        name: &str,
        mut check: impl FnMut() -> Result<(), IndexError>,
    ) -> Result<bool, IndexError> {
        check()?;
        validate_name(name)?;
        super::validate_traversal_path(&self.path.join(parent.replace('/', "\\")).join(name))?;
        let file = last(files)?;
        if identity(file)? != expected {
            return Err(IndexError::Invalid(
                "Directory parent changed during reconciliation. Retry source verification.",
            ));
        }
        let mut found = false;
        visit(file, |entry| {
            check()?;
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
        self.verify_held_parent(parent, file, expected)?;
        Ok(found)
    }

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

    fn children_from_handles(
        &self,
        parent: &str,
        files: &[File],
        mut receive: impl FnMut(Result<Option<NativeChild>, TraversalIssue>) -> Result<(), IndexError>,
    ) -> Result<(), IndexError> {
        let file = last(files)?;
        let expected = identity(file)?;
        visit(file, |entry| {
            let Some((record, native_name)) = entry else {
                receive(Ok(None))?;
                return Ok(true);
            };
            if native_name == [b'.' as u16] || native_name == [b'.' as u16, b'.' as u16] {
                return Ok(true);
            }
            if record.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0
                || record.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
                || windows_reparse_kind(record.ReparsePointTag) != WindowsReparseKind::Ordinary
            {
                return Ok(true);
            }
            let name = match windows_entry_name(native_name) {
                Ok(name) => name,
                Err(issue) => {
                    receive(Err(match String::from_utf16(native_name) {
                        Ok(name) => TraversalIssue::UnsupportedDirectoryName(name),
                        Err(_) => issue,
                    }))?;
                    return Ok(true);
                }
            };
            let path = self.path.join(parent.replace('/', "\\")).join(&name);
            if super::validate_traversal_path(&path).is_err() {
                receive(Err(TraversalIssue::UnsafeDirectory(name)))?;
                return Ok(true);
            }
            receive(Ok(Some((name, true, Some(record.FileId.Identifier.to_vec())))))?;
            Ok(true)
        })?;
        self.verify_held_parent(parent, file, expected)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn scan_handles_allow_parent_rename_but_root_binding_blocks_it() {
        for checked_chain in [false, true] {
            let temporary = tempfile::tempdir().unwrap();
            let path = temporary.path().join("root");
            std::fs::create_dir_all(path.join("parent/child")).unwrap();
            let root = NativeRoot::open(&path).unwrap();
            let expected = root.parent_identity("parent").unwrap();
            if checked_chain {
                root.extended_id_unsupported.store(true, Ordering::Release);
                root.legacy_id_unsupported.store(true, Ordering::Release);
                root.relative_open_unsupported.store(true, Ordering::Release);
            }
            let read = root.open_parent_for_scan_with_id("parent", &expected.file_id()).unwrap();
            std::fs::rename(path.join("parent"), path.join("renamed")).unwrap();
            assert!(read.verify().is_err());
            assert!(std::fs::rename(&path, temporary.path().join("moved-root")).is_err());
            root.verify().unwrap();
        }
    }

    #[test]
    fn relative_fallback_opens_each_parent_once_with_file_id_modes_disabled() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temporary.path().join("parent/child-\u{e9}")).unwrap();
        let io = std::sync::Arc::<super::super::NativeIo>::default();
        let root = NativeRoot::open_with_io(temporary.path(), io.clone()).unwrap();
        root.extended_id_unsupported.store(true, Ordering::Release);
        root.legacy_id_unsupported.store(true, Ordering::Release);
        for relative in ["parent", "parent/child-\u{e9}"] {
            let expected = root.parent_identity(relative).unwrap();
            let before = io.opens();
            let read = root.open_parent_for_scan_with_id(relative, &expected.file_id()).unwrap();
            assert_eq!(read.identity, expected);
            assert_eq!(read.files.len(), 1);
            assert_eq!(io.opens() - before, 1);
            read.verify().unwrap();
        }
    }

    #[test]
    fn relative_open_rejects_unsafe_names_before_native_io() {
        let temporary = tempfile::tempdir().unwrap();
        let io = std::sync::Arc::<super::super::NativeIo>::default();
        let root = NativeRoot::open_with_io(temporary.path(), io.clone()).unwrap();
        let before = io.opens();
        for relative in [
            "",
            ".",
            "..",
            "../outside",
            "/absolute",
            "parent//child",
            "parent\\child",
            "stream:child",
            "nul\0name",
        ] {
            assert!(open_directory_relative(last(&root.files).unwrap(), relative, &io).is_err());
        }
        let overlong = "a".repeat(MAX_NATIVE_PATH_UNITS);
        assert!(open_directory_relative(last(&root.files).unwrap(), &overlong, &io).is_err());
        assert_eq!(io.opens(), before);
    }

    #[test]
    fn file_id_capability_cache_excludes_object_and_permission_errors() {
        use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_SHARING_VIOLATION};
        for code in [ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED, ERROR_CALL_NOT_IMPLEMENTED] {
            let error = IndexError::Io(io::Error::from_raw_os_error(code.0 as i32));
            assert!(native_open_unsupported(&error));
        }
        for code in [
            ERROR_ACCESS_DENIED,
            ERROR_FILE_NOT_FOUND,
            ERROR_SHARING_VIOLATION,
            ERROR_INVALID_PARAMETER,
        ] {
            let error = IndexError::Io(io::Error::from_raw_os_error(code.0 as i32));
            assert!(!native_open_unsupported(&error));
        }
    }

    #[test]
    fn file_id_scan_parent_preserves_identity_and_bounds_supported_opens() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temporary.path().join("parent/child")).unwrap();
        let io = std::sync::Arc::<super::super::NativeIo>::default();
        let root = NativeRoot::open_with_io(temporary.path(), io.clone()).unwrap();
        let expected = root.parent_identity("parent/child").unwrap();
        let file_id: [u8; size_of::<u128>()] = expected.file_id().try_into().unwrap();
        let extended = file_id_descriptor(&file_id, false).unwrap();
        let direct_available = open_directory_by_id(last(&root.files).unwrap(), &extended, &io).is_ok()
            || (expected.mount == 0
                && open_directory_by_id(last(&root.files).unwrap(), &file_id_descriptor(&file_id, true).unwrap(), &io).is_ok())
            || open_directory_relative(last(&root.files).unwrap(), "parent/child", &io).is_ok();
        let read = root.open_parent_for_scan_with_id("parent/child", &expected.file_id()).unwrap();
        assert_eq!(read.identity, expected);
        read.verify().unwrap();
        let direct_open = read.files.len() == 1;
        assert_eq!(direct_open, direct_available);
        drop(read);
        let before = io.opens();
        let read = root.open_parent_for_scan_with_id("parent/child", &expected.file_id()).unwrap();
        assert_eq!(read.identity, expected);
        if direct_open {
            assert_eq!(read.files.len(), 1);
            let maximum_opens = 1
                + u64::from(!root.extended_id_unsupported.load(Ordering::Acquire))
                + u64::from(expected.mount == 0 && !root.legacy_id_unsupported.load(Ordering::Acquire));
            assert!(io.opens() - before <= maximum_opens);
        }
    }

    #[test]
    fn unsupported_native_opens_reuse_checked_chain_without_probe_attempts() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temporary.path().join("parent/child")).unwrap();
        let io = std::sync::Arc::<super::super::NativeIo>::default();
        let root = NativeRoot::open_with_io(temporary.path(), io.clone()).unwrap();
        let expected = root.parent_identity("parent/child").unwrap();
        root.extended_id_unsupported.store(true, Ordering::Release);
        root.legacy_id_unsupported.store(true, Ordering::Release);
        root.relative_open_unsupported.store(true, Ordering::Release);
        let before = io.opens();
        root.open_parent_for_scan("parent/child").unwrap();
        let chain_opens = io.opens() - before;
        let before = io.opens();
        let read = root.open_parent_for_scan_with_id("parent/child", &expected.file_id()).unwrap();
        assert_eq!(read.identity, expected);
        assert_eq!(io.opens() - before, chain_opens);
        assert!(root.open_parent_for_scan_with_id("parent/child", &[]).is_err());
    }

    #[test]
    fn moved_file_id_falls_back_to_current_path_instead_of_reading_outside_root() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("root");
        std::fs::create_dir_all(path.join("parent/child/outside-only")).unwrap();
        let root = NativeRoot::open(&path).unwrap();
        let expected = root.parent_identity("parent/child").unwrap();
        std::fs::rename(path.join("parent"), temporary.path().join("moved")).unwrap();
        std::fs::create_dir_all(path.join("parent/child/replacement-only")).unwrap();
        let read = root.open_parent_for_scan_with_id("parent/child", &expected.file_id()).unwrap();
        assert_ne!(read.identity, expected);
        let mut children = Vec::new();
        read.children_with_ids(|entry| {
            if let Some((name, _, _)) = entry.unwrap() {
                children.push(name);
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(children, ["replacement-only"]);
    }

    #[test]
    fn file_id_descriptors_preserve_all_bits_and_refuse_lossy_legacy_ids() {
        let mut file_id = [u8::MAX; size_of::<u128>()];
        let extended = file_id_descriptor(&file_id, false).unwrap();
        assert_eq!(extended.Type, ExtendedFileIdType);
        assert_eq!(unsafe { extended.Anonymous.ExtendedFileId.Identifier }, file_id);
        assert!(file_id_descriptor(&file_id, true).is_err());
        file_id[FILE_ID_HALF_BYTES..].fill(0);
        let legacy = file_id_descriptor(&file_id, true).unwrap();
        assert_eq!(legacy.Type, FileIdType);
        assert_eq!(unsafe { legacy.Anonymous.FileId }, -1);
        assert_eq!(legacy.dwSize as usize, size_of::<FILE_ID_DESCRIPTOR>());
    }

    #[test]
    fn enumeration_uses_record_file_ids_without_child_opens() {
        const CHILD_COUNT: usize = 3;
        let temporary = tempfile::tempdir().unwrap();
        for number in 0..CHILD_COUNT {
            std::fs::create_dir_all(temporary.path().join("parent").join(format!("child-{number}"))).unwrap();
        }
        std::fs::write(temporary.path().join("parent/file"), b"not a directory").unwrap();
        let io = std::sync::Arc::<super::super::NativeIo>::default();
        let root = super::NativeRoot::open_with_io(temporary.path(), io.clone()).unwrap();
        let expected = (0..CHILD_COUNT)
            .map(|number| {
                let name = format!("child-{number}");
                let file_id = root.parent_identity(&format!("parent/{name}")).unwrap().file_id();
                (name, true, Some(file_id))
            })
            .collect::<Vec<_>>();
        let read = root.open_parent("parent").unwrap();
        let before = io.opens();
        let mut children = Vec::new();
        read.children_with_ids(|entry| {
            if let Some(child) = entry.unwrap() {
                children.push(child);
            }
            Ok(())
        })
        .unwrap();
        children.sort();
        assert_eq!(children, expected);
        assert_eq!(io.opens(), before);
    }

    #[test]
    fn scan_parent_opens_skip_duplicate_root_chains_until_requested() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir(temporary.path().join("parent")).unwrap();
        let io = std::sync::Arc::<super::super::NativeIo>::default();
        let root = super::NativeRoot::open_with_io(temporary.path(), io.clone()).unwrap();
        let before = io.opens();
        root.open_parent_for_scan("parent").unwrap();
        let parent_opens = io.opens() - before;
        let before = io.opens();
        root.open_parent_for_scan("parent").unwrap();
        assert_eq!(io.opens() - before, parent_opens);
        root.require_verification();
        let before = io.opens();
        root.open_parent_for_scan("parent").unwrap();
        assert!(io.opens() - before > parent_opens);
        assert!(root.open_parent_for_scan("missing").is_err());
        let before = io.opens();
        root.open_parent_for_scan("parent").unwrap();
        assert!(io.opens() - before > parent_opens);
    }

    #[test]
    fn held_parent_checks_do_not_reopen_the_ancestor_chain() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::create_dir(temporary.path().join("parent")).unwrap();
        let io = std::sync::Arc::<super::super::NativeIo>::default();
        let root = super::NativeRoot::open_with_io(temporary.path(), io.clone()).unwrap();
        let read = root.open_parent("parent").unwrap();
        let before = io.opens();
        read.verify().unwrap();
        read.children_with_ids(|entry| {
            assert!(entry.unwrap().is_none());
            Ok(())
        })
        .unwrap();
        assert!(!read.has_directory_child_with_check("missing", || Ok(())).unwrap());
        assert_eq!(io.opens(), before);
    }

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
    fn junction_ancestors_are_rejected_and_children_are_silently_excluded() {
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
        for relative in ["redirected", "redirected/child"] {
            assert!(open_directory_relative(last(&root.files).unwrap(), relative, &root.io).is_err());
        }
        let mut issues = Vec::new();
        root.children("", |event| {
            if let Err(issue) = event {
                issues.push(issue);
            }
            Ok(())
        })
        .unwrap();
        assert!(issues.is_empty());
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
        let held = root.parent("parent", true).unwrap();
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
        let held = root.parent("", true).unwrap();
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
