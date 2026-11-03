//! Platform-specific drive/volume enumeration.
//!
//! Discovers all mounted drives accessible to the current user, including
//! physical drives, removable media, network mounts, and virtual drives
//! (Google Drive, OneDrive, Dropbox, etc.).

#[cfg(test)]
use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::{Mutex, OnceLock};

use log::warn;

use super::models::{DriveInfo, DriveType};

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(super) struct VolumeEvidence {
    pub class: DriveType,
    pub volume: Option<String>,
    pub label: Option<String>,
    pub filesystem: Option<String>,
    pub capacity: Option<u64>,
    pub separate_mount: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum VolumeChange {
    Keep,
    Index,
    Generation,
    Unavailable,
}

impl VolumeEvidence {
    pub fn retain_available(&mut self, previous: &Self) {
        self.volume = self.volume.take().or_else(|| previous.volume.clone());
        self.label = self.label.take().or_else(|| previous.label.clone());
        self.filesystem = self.filesystem.take().or_else(|| previous.filesystem.clone());
        self.capacity = self.capacity.or(previous.capacity);
    }

    pub fn removable(&self) -> bool {
        matches!(self.class, DriveType::Removable | DriveType::Unknown)
    }

    pub fn index_volume(&self) -> Option<&str> {
        (!matches!(self.class, DriveType::Network | DriveType::Virtual))
            .then_some(self.volume.as_deref())
            .flatten()
    }

    pub fn compare(&self, current: &Self) -> VolumeChange {
        fn changed<T: PartialEq>(stored: &Option<T>, current: &Option<T>) -> bool {
            matches!((stored, current), (Some(stored), Some(current)) if stored != current)
        }
        if cfg!(target_os = "linux") && self.separate_mount && !current.separate_mount {
            return VolumeChange::Unavailable;
        }
        if matches!(current.class, DriveType::Network | DriveType::Virtual) {
            return VolumeChange::Keep;
        }
        if changed(&self.volume, &current.volume) {
            return VolumeChange::Index;
        }
        if current.removable()
            && (changed(&self.label, &current.label)
                || changed(&self.filesystem, &current.filesystem)
                || changed(&self.capacity, &current.capacity))
        {
            return VolumeChange::Generation;
        }
        VolumeChange::Keep
    }
}

#[cfg(target_os = "linux")]
fn mount_field(value: &str) -> String {
    value
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(target_os = "linux")]
pub(super) fn volume_evidence(root: &Path) -> std::io::Result<VolumeEvidence> {
    use std::os::unix::ffi::OsStrExt;
    std::fs::metadata(root)?;
    let mounts = std::fs::read_to_string("/proc/self/mountinfo")?;
    let mut selected = None;
    for line in mounts.lines() {
        let Some((mount, filesystem)) = line.split_once(" - ") else {
            continue;
        };
        let fields: Vec<_> = mount.split_whitespace().collect();
        let fs: Vec<_> = filesystem.split_whitespace().collect();
        if fields.len() < 5 || fs.len() < 2 {
            continue;
        }
        let path = PathBuf::from(mount_field(fields[4]));
        if root.starts_with(&path)
            && selected
                .as_ref()
                .is_none_or(|(previous, _, _, _): &(PathBuf, String, String, String)| {
                    path.components().count() > previous.components().count()
                })
        {
            selected = Some((path, fields[2].to_owned(), fs[0].to_owned(), mount_field(fs[1])));
        }
    }
    let (mount, device, filesystem, source) =
        selected.ok_or_else(|| std::io::Error::other("Directory mount information is unavailable."))?;
    let udev = std::fs::read_to_string(format!("/run/udev/data/b{device}")).unwrap_or_default();
    let property = |name: &str| {
        udev.lines()
            .find_map(|line| line.strip_prefix(&format!("E:{name}=")).map(str::to_owned))
    };
    let mut volume = property("ID_FS_UUID");
    let mut label = property("ID_FS_LABEL");
    for (directory, target) in [("/dev/disk/by-uuid", &mut volume), ("/dev/disk/by-label", &mut label)] {
        if target.is_none() {
            if let (Ok(source), Ok(entries)) = (std::fs::canonicalize(&source), std::fs::read_dir(directory)) {
                *target = entries
                    .filter_map(Result::ok)
                    .find(|entry| std::fs::canonicalize(entry.path()).is_ok_and(|path| path == source))
                    .and_then(|entry| entry.file_name().into_string().ok());
            }
        }
    }
    let class = linux_storage_class(&filesystem, &device, property("ID_BUS").as_deref());
    let name = std::ffi::CString::new(root.as_os_str().as_bytes())?;
    let mut statistics: libc::statvfs = unsafe { std::mem::zeroed() };
    let capacity = (unsafe { libc::statvfs(name.as_ptr(), &mut statistics) } == 0)
        .then(|| u64::try_from(u128::from(statistics.f_blocks) * u128::from(statistics.f_frsize)).ok())
        .flatten();
    Ok(VolumeEvidence {
        class,
        volume,
        label,
        filesystem: Some(filesystem),
        capacity,
        separate_mount: root == mount && mount != Path::new("/"),
    })
}

#[cfg(target_os = "linux")]
fn linux_storage_class(filesystem: &str, device: &str, bus: Option<&str>) -> DriveType {
    match filesystem {
        "fuse" | "fuse.rclone" | "fuse.google-drive-ocamlfuse" | "fuse.gdfuse" | "fuse.dropbox" => return DriveType::Virtual,
        "nfs" | "nfs4" | "cifs" | "smb" | "smbfs" | "9p" | "sshfs" => return DriveType::Network,
        _ => {}
    }
    let Ok(device) = std::fs::canonicalize(format!("/sys/dev/block/{device}")) else {
        return DriveType::Unknown;
    };
    if matches!(bus, Some("usb" | "sd" | "mmc"))
        || device.components().any(|component| {
            component
                .as_os_str()
                .to_str()
                .is_some_and(|name| name.starts_with("usb") || name.starts_with("mmc"))
        })
    {
        return DriveType::Removable;
    }
    for parent in device.ancestors() {
        if let Ok(removable) = std::fs::read_to_string(parent.join("removable")) {
            return match removable.trim() {
                "0" => DriveType::Fixed,
                "1" => DriveType::Removable,
                _ => DriveType::Unknown,
            };
        }
    }
    DriveType::Unknown
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub(super) fn volume_evidence(root: &Path) -> std::io::Result<VolumeEvidence> {
    std::fs::metadata(root)?;
    Ok(VolumeEvidence::default())
}

#[cfg(target_os = "windows")]
fn windows_hotplug_info(device: &std::fs::File) -> std::io::Result<windows::Win32::System::Ioctl::STORAGE_HOTPLUG_INFO> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Ioctl::{IOCTL_STORAGE_GET_HOTPLUG_INFO, STORAGE_HOTPLUG_INFO};
    use windows::Win32::System::IO::DeviceIoControl;

    let mut hotplug = STORAGE_HOTPLUG_INFO::default();
    let mut returned = 0;
    unsafe {
        DeviceIoControl(
            HANDLE(device.as_raw_handle()),
            IOCTL_STORAGE_GET_HOTPLUG_INFO,
            None,
            0,
            Some(std::ptr::from_mut(&mut hotplug).cast()),
            size_of::<STORAGE_HOTPLUG_INFO>() as u32,
            Some(&mut returned),
            None,
        )
    }
    .map_err(std::io::Error::from)?;
    if (returned as usize) < size_of::<STORAGE_HOTPLUG_INFO>() {
        return Err(std::io::Error::other("Drive hot-plug information is incomplete."));
    }
    Ok(hotplug)
}

#[cfg(target_os = "windows")]
pub(super) fn volume_evidence(root: &Path) -> std::io::Result<VolumeEvidence> {
    use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BusTypeMmc, BusTypeSd, BusTypeUsb, FileIdInfo, GetDiskFreeSpaceExW, GetDriveTypeW, GetFileInformationByHandleEx,
        GetVolumeInformationW, GetVolumePathNameW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    use windows::Win32::System::Ioctl::{
        PropertyStandardQuery, StorageDeviceProperty, IOCTL_STORAGE_QUERY_PROPERTY, STORAGE_DEVICE_DESCRIPTOR, STORAGE_PROPERTY_QUERY,
    };
    use windows::Win32::System::IO::DeviceIoControl;
    const VOLUME_PATH_UNITS: usize = 32768;
    const VOLUME_NAME_UNITS: usize = 256;
    const DEVICE_QUERY_BYTES: usize = 4096;
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;
    let path: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut mount = vec![0u16; VOLUME_PATH_UNITS];
    unsafe { GetVolumePathNameW(PCWSTR(path.as_ptr()), &mut mount) }.map_err(std::io::Error::from)?;
    let end = mount
        .iter()
        .position(|unit| *unit == 0)
        .ok_or_else(|| std::io::Error::other("Invalid volume path."))?;
    let mount_name = String::from_utf16(&mount[..end]).map_err(std::io::Error::other)?;
    let mut evidence = VolumeEvidence::default();
    let raw = unsafe { GetDriveTypeW(PCWSTR(mount.as_ptr())) };
    evidence.class = match raw {
        DRIVE_REMOVABLE | DRIVE_CDROM => DriveType::Removable,
        DRIVE_REMOTE => DriveType::Network,
        DRIVE_RAMDISK => DriveType::Virtual,
        _ => DriveType::Unknown,
    };
    if raw == DRIVE_FIXED {
        let device_name = format!("\\\\.\\{}", mount_name.trim_end_matches('\\'));
        if let Ok(device) = std::fs::OpenOptions::new()
            .access_mode(0)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .open(device_name)
        {
            let query = STORAGE_PROPERTY_QUERY {
                PropertyId: StorageDeviceProperty,
                QueryType: PropertyStandardQuery,
                ..Default::default()
            };
            let mut buffer = [0u64; DEVICE_QUERY_BYTES / size_of::<u64>()];
            let mut returned = 0;
            let descriptor = unsafe {
                DeviceIoControl(
                    HANDLE(device.as_raw_handle()),
                    IOCTL_STORAGE_QUERY_PROPERTY,
                    Some(std::ptr::from_ref(&query).cast()),
                    size_of::<STORAGE_PROPERTY_QUERY>() as u32,
                    Some(buffer.as_mut_ptr().cast()),
                    DEVICE_QUERY_BYTES as u32,
                    Some(&mut returned),
                    None,
                )
            };
            match (descriptor, windows_hotplug_info(&device)) {
                (Ok(()), Ok(hotplug)) if returned as usize >= size_of::<STORAGE_DEVICE_DESCRIPTOR>() => {
                    let descriptor = unsafe { &*buffer.as_ptr().cast::<STORAGE_DEVICE_DESCRIPTOR>() };
                    evidence.class = if [BusTypeUsb, BusTypeSd, BusTypeMmc].contains(&descriptor.BusType)
                        || hotplug.DeviceHotplug
                        || hotplug.MediaRemovable
                    {
                        DriveType::Removable
                    } else {
                        DriveType::Fixed
                    };
                }
                _ => {}
            }
        }
    }
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(root)?;
    let mut identity = FILE_ID_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            std::ptr::from_mut(&mut identity).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .is_ok()
    {
        evidence.volume = Some(identity.VolumeSerialNumber.to_string());
    }
    let mut label = [0u16; VOLUME_NAME_UNITS];
    let mut filesystem = [0u16; VOLUME_NAME_UNITS];
    if unsafe { GetVolumeInformationW(PCWSTR(mount.as_ptr()), Some(&mut label), None, None, None, Some(&mut filesystem)) }.is_ok() {
        let text = |value: &[u16]| String::from_utf16(&value[..value.iter().position(|unit| *unit == 0).unwrap_or(value.len())]).ok();
        evidence.label = text(&label);
        evidence.filesystem = text(&filesystem);
    }
    let mut capacity = 0;
    if unsafe { GetDiskFreeSpaceExW(PCWSTR(mount.as_ptr()), None, Some(&mut capacity), None) }.is_ok() {
        evidence.capacity = Some(capacity);
    }
    Ok(evidence)
}

/// Filesystem types to exclude (pseudo/virtual system filesystems).
const EXCLUDED_FS_TYPES: &[&str] = &[
    "proc",
    "sysfs",
    "devfs",
    "devtmpfs",
    "tmpfs",
    "cgroup",
    "cgroup2",
    "securityfs",
    "debugfs",
    "configfs",
    "fusectl",
    "mqueue",
    "hugetlbfs",
    "pstore",
    "binfmt_misc",
    "autofs",
    "rpc_pipefs",
    "nfsd",
    "tracefs",
    "bpf",
    "efivarfs",
    "ramfs",
    "devpts",
    "overlay",
];

/// Mount points to exclude (always system paths).
const EXCLUDED_MOUNT_POINTS: &[&str] = &["/proc", "/sys", "/dev", "/run", "/snap", "/boot/efi"];
#[cfg(test)]
static TEST_DRIVE_PATHS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

#[cfg(test)]
pub fn register_test_drive_path(drive_id: String, path: PathBuf) {
    let paths = TEST_DRIVE_PATHS.get_or_init(|| Mutex::new(HashMap::new()));
    paths
        .lock()
        .expect("test drive registry lock should not be poisoned")
        .insert(drive_id, path);
}

/// Enumerate all accessible drives/volumes on the current platform.
pub fn enumerate_drives() -> Vec<DriveInfo> {
    let drives = enumerate_platform_drives();
    if drives.is_empty() {
        warn!("No drives found during enumeration");
    }
    drives
}

/// Resolve a drive ID to its root filesystem path.
///
/// Returns `None` if the drive ID is unknown.
pub fn resolve_drive_path(drive_id: &str) -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(path) = TEST_DRIVE_PATHS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .expect("test drive registry lock should not be poisoned")
        .get(drive_id)
    {
        return Some(path.clone());
    }
    let drives = enumerate_platform_drives();
    // The drive ID encodes the mount point — decode it back
    drives.iter().find(|_d| _d.id == drive_id).map(|_| drive_id_to_path(drive_id))
}

/// Map a canonical filesystem path to the most-specific exposed drive.
///
/// The returned path is relative to the selected drive root. Nested mount
/// points take precedence over their parents so that a target remains in the
/// drive the browser can address directly.
pub fn drive_for_path(path: &Path) -> Option<(String, PathBuf)> {
    let canonical_path = std::fs::canonicalize(path).ok()?;
    let mut best_match: Option<(String, PathBuf, usize)> = None;

    for drive in enumerate_platform_drives() {
        let root = drive_id_to_path(&drive.id);
        let canonical_root = match std::fs::canonicalize(&root) {
            Ok(root) => root,
            Err(_) => continue,
        };
        let Ok(relative) = canonical_path.strip_prefix(&canonical_root) else {
            continue;
        };

        let depth = canonical_root.components().count();
        if best_match.as_ref().is_none_or(|(_, _, best_depth)| depth > *best_depth) {
            best_match = Some((drive.id, relative.to_path_buf(), depth));
        }
    }

    best_match.map(|(drive_id, relative, _)| (drive_id, relative))
}

/// Convert a drive ID back to its filesystem path.
fn drive_id_to_path(drive_id: &str) -> PathBuf {
    // On Windows, drive IDs are lowercase letter: "c" -> "C:\\"
    #[cfg(target_os = "windows")]
    {
        if drive_id.len() == 1 && drive_id.chars().next().unwrap().is_ascii_alphabetic() {
            return PathBuf::from(format!("{}:\\", drive_id.to_uppercase()));
        }
    }

    // On Unix, drive IDs are URL-safe slugs of mount points:
    // "root" -> "/"
    // "home" -> "/home"
    // "volumes-my-drive" -> "/Volumes/My Drive" (macOS)
    // We store the mapping during enumeration and look it up.
    // For robustness, re-enumerate and match by ID.
    let drives = enumerate_platform_drives();
    for drive in &drives {
        if drive.id == drive_id {
            // Extract from name or re-derive
            return path_from_drive_id_internal(drive_id);
        }
    }
    // Fallback: treat as literal path
    PathBuf::from(format!("/{drive_id}"))
}

/// Derive a stable, URL-safe ID from a mount point path.
fn path_to_drive_id(path: &Path) -> String {
    let path_str = path.to_string_lossy();

    // Windows: use the drive letter
    #[cfg(target_os = "windows")]
    {
        if let Some(letter) = path_str.chars().next() {
            if letter.is_ascii_alphabetic() && path_str.starts_with(&format!("{letter}:")) {
                return letter.to_lowercase().to_string();
            }
        }
    }

    // Unix: create a slug from the path
    if path_str == "/" {
        return "root".to_string();
    }

    path_str.trim_start_matches('/').to_lowercase().replace([' ', '/'], "-")
}

/// Reverse a drive ID slug back to a filesystem path.
fn path_from_drive_id_internal(drive_id: &str) -> PathBuf {
    if drive_id == "root" {
        return PathBuf::from("/");
    }

    // Re-enumerate to find the actual path
    // This is a fallback — normally resolve_drive_path is used
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/mounts") {
            for line in content.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    let mount_point = parts[1];
                    let id = path_to_drive_id(Path::new(mount_point));
                    if id == drive_id {
                        return PathBuf::from(mount_point);
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(entries) = std::fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                let path = entry.path();
                let id = path_to_drive_id(&path);
                if id == drive_id {
                    return path;
                }
            }
        }
        // Check root
        if drive_id == "root" {
            return PathBuf::from("/");
        }
    }

    // Fallback
    PathBuf::from(format!("/{}", drive_id.replace('-', "/")))
}

// ─── Linux implementation ────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn enumerate_platform_drives() -> Vec<DriveInfo> {
    let content = match std::fs::read_to_string("/proc/mounts") {
        Ok(c) => c,
        Err(e) => {
            warn!("Failed to read /proc/mounts: {e}");
            return vec![default_root_drive()];
        }
    };

    let mut drives = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    for line in content.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }

        let _device = parts[0];
        let mount_point = parts[1];
        let fs_type = parts[2];

        // Skip excluded filesystem types
        if EXCLUDED_FS_TYPES.contains(&fs_type) {
            continue;
        }

        // Skip excluded mount points
        if EXCLUDED_MOUNT_POINTS.iter().any(|&p| mount_point.starts_with(p)) {
            continue;
        }

        let id = path_to_drive_id(Path::new(mount_point));
        if !seen_ids.insert(id.clone()) {
            continue; // Skip duplicate mount points
        }

        let drive_type = classify_linux_drive(fs_type, mount_point);
        let name = derive_drive_name(mount_point, &drive_type);

        drives.push(DriveInfo { id, name, drive_type });
    }

    if drives.is_empty() {
        drives.push(default_root_drive());
    }

    drives.sort_by(|a, b| a.name.cmp(&b.name));
    drives
}

#[cfg(target_os = "linux")]
fn classify_linux_drive(fs_type: &str, mount_point: &str) -> DriveType {
    match fs_type {
        // FUSE-based cloud drives
        "fuse" | "fuse.rclone" | "fuse.google-drive-ocamlfuse" | "fuse.gdfuse" | "fuse.dropbox" => DriveType::Virtual,
        // Network filesystems
        "nfs" | "nfs4" | "cifs" | "smb" | "smbfs" | "9p" | "sshfs" => DriveType::Network,
        _ => volume_evidence(Path::new(mount_point))
            .map(|evidence| evidence.class)
            .unwrap_or(DriveType::Unknown),
    }
}

// ─── macOS implementation ────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn enumerate_platform_drives() -> Vec<DriveInfo> {
    let mut drives = vec![];

    // Add root volume
    drives.push(DriveInfo {
        id: "root".to_string(),
        name: "Macintosh HD".to_string(),
        drive_type: DriveType::Fixed,
    });

    // Enumerate /Volumes
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();

            // Skip the root volume symlink
            if name == "Macintosh HD" {
                continue;
            }

            let id = path_to_drive_id(&path);
            let drive_type = classify_macos_drive(&path, &name);

            drives.push(DriveInfo { id, name, drive_type });
        }
    }

    drives
}

#[cfg(target_os = "macos")]
fn classify_macos_drive(path: &Path, name: &str) -> DriveType {
    let name_lower = name.to_lowercase();

    // Known cloud drives
    if name_lower.contains("google drive")
        || name_lower.contains("onedrive")
        || name_lower.contains("dropbox")
        || name_lower.contains("icloud")
    {
        return DriveType::Virtual;
    }

    // Check if it's a symlink (often network volumes)
    if path.is_symlink() {
        return DriveType::Network;
    }

    // Default to removable for external volumes
    DriveType::Removable
}

// ─── Windows implementation ──────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn enumerate_platform_drives() -> Vec<DriveInfo> {
    use windows::Win32::Storage::FileSystem::{GetLogicalDriveStringsW, GetVolumeInformationW};

    let mut buffer = [0u16; 512];
    let len = unsafe { GetLogicalDriveStringsW(Some(&mut buffer)) } as usize;
    if len == 0 {
        warn!("GetLogicalDriveStringsW returned 0 drives");
        return vec![];
    }

    let mut drives = Vec::new();
    let mut start = 0;

    while start < len {
        let end = buffer[start..len].iter().position(|&c| c == 0).map(|p| start + p).unwrap_or(len);

        if end > start {
            let drive_str = String::from_utf16_lossy(&buffer[start..end]);
            let drive_wide: Vec<u16> = drive_str.encode_utf16().chain(std::iter::once(0)).collect();

            let drive_type = volume_evidence(Path::new(&drive_str))
                .map(|evidence| evidence.class)
                .unwrap_or(DriveType::Unknown);

            // Get volume label
            let mut vol_name = [0u16; 256];
            let has_label = unsafe {
                GetVolumeInformationW(
                    windows::core::PCWSTR(drive_wide.as_ptr()),
                    Some(&mut vol_name),
                    None,
                    None,
                    None,
                    None,
                )
            }
            .is_ok();

            let label = if has_label {
                let label_end = vol_name.iter().position(|&c| c == 0).unwrap_or(vol_name.len());
                let l = String::from_utf16_lossy(&vol_name[..label_end]);
                if l.is_empty() {
                    None
                } else {
                    Some(l)
                }
            } else {
                None
            };

            let letter = drive_str.trim_end_matches('\\').to_string();
            let name = match label {
                Some(l) => format!("{l} ({letter})"),
                None => format!("Drive ({letter})"),
            };

            let id = letter[..1].to_lowercase();

            drives.push(DriveInfo { id, name, drive_type });
        }

        start = end + 1;
    }

    drives
}

// ─── Helper functions ────────────────────────────────────────────────────────

/// Derive a human-readable name from a mount point.
fn derive_drive_name(mount_point: &str, drive_type: &DriveType) -> String {
    let type_label = match drive_type {
        DriveType::Fixed => "Disk",
        DriveType::Removable => "Removable",
        DriveType::Network => "Network",
        DriveType::Virtual => "Cloud Drive",
        DriveType::Unknown => "Drive",
    };

    if mount_point == "/" {
        return format!("Root ({type_label})");
    }

    let basename = Path::new(mount_point).file_name().unwrap_or_default().to_string_lossy().to_string();

    if basename.is_empty() {
        format!("{mount_point} ({type_label})")
    } else {
        format!("{basename} ({type_label})")
    }
}

/// Fallback root drive for Linux when /proc/mounts is unreadable.
fn default_root_drive() -> DriveInfo {
    DriveInfo {
        id: "root".to_string(),
        name: "Root (Disk)".to_string(),
        drive_type: DriveType::Fixed,
    }
}

#[cfg(test)]
mod volume_tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn system_volume_hotplug_query_returns_complete_information() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        use windows::Win32::System::Ioctl::STORAGE_HOTPLUG_INFO;

        let drive = std::env::var("SystemDrive").expect("Windows test host must expose its system drive.");
        let device = std::fs::OpenOptions::new()
            .access_mode(0)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .open(format!("\\\\.\\{drive}"))
            .unwrap();
        let information = windows_hotplug_info(&device).unwrap();
        assert_eq!(information.Size as usize, size_of::<STORAGE_HOTPLUG_INFO>());
    }

    #[test]
    fn volume_decisions_use_only_available_evidence_and_current_class() {
        let stored = VolumeEvidence {
            class: DriveType::Fixed,
            volume: Some("first".into()),
            label: Some("label".into()),
            filesystem: Some("fs".into()),
            capacity: Some(100),
            separate_mount: false,
        };
        for class in [
            DriveType::Fixed,
            DriveType::Removable,
            DriveType::Unknown,
            DriveType::Network,
            DriveType::Virtual,
        ] {
            let mut current = stored.clone();
            current.class = class;
            assert_eq!(stored.compare(&current), VolumeChange::Keep);
            current.volume = Some("second".into());
            assert_eq!(
                stored.compare(&current),
                if matches!(class, DriveType::Network | DriveType::Virtual) {
                    VolumeChange::Keep
                } else {
                    VolumeChange::Index
                }
            );
            current.volume = None;
            assert_eq!(stored.compare(&current), VolumeChange::Keep);
            for field in ["label", "filesystem", "capacity"] {
                let mut changed = current.clone();
                match field {
                    "label" => changed.label = Some("renamed".into()),
                    "filesystem" => changed.filesystem = Some("other".into()),
                    _ => changed.capacity = Some(200),
                }
                assert_eq!(
                    stored.compare(&changed),
                    if matches!(class, DriveType::Removable | DriveType::Unknown) {
                        VolumeChange::Generation
                    } else {
                        VolumeChange::Keep
                    }
                );
            }
        }
    }

    #[test]
    fn missing_evidence_is_not_a_volume_change() {
        let known = VolumeEvidence {
            class: DriveType::Removable,
            volume: Some("known".into()),
            label: Some("label".into()),
            filesystem: Some("fs".into()),
            capacity: Some(100),
            separate_mount: false,
        };
        let missing = VolumeEvidence::default();
        assert_eq!(known.compare(&missing), VolumeChange::Keep);
        assert_eq!(missing.compare(&known), VolumeChange::Keep);
        #[cfg(target_os = "linux")]
        assert_eq!(
            VolumeEvidence {
                separate_mount: true,
                ..known
            }
            .compare(&missing),
            VolumeChange::Unavailable
        );
    }
}
