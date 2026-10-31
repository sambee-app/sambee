//! Direct local ZIP archive creation with portable entry-name validation.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File as FsFile, OpenOptions};
use std::io::{BufWriter, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime};

use bzip2::read::BzDecoder;
use chrono::{DateTime, Datelike, NaiveDate, SecondsFormat, Timelike, Utc};
use flate2::{write::DeflateEncoder, Compression, Decompress, FlushDecompress, Status};
use log::info;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::mpsc::Receiver;
use unicode_casefold::UnicodeCaseFold;
use unicode_normalization::UnicodeNormalization;
use zip::write::{SimpleFileOptions, StreamWriter, ZipWriter};
use zip::CompressionMethod;

use super::models::{ArchiveDirectoryListing, ArchiveEntryInfo, ArchiveEntryState, ArchiveIdentity, FileType};
use super::target_resolution::{resolve_target_mutation, TargetResolutionDisposition, TargetResolutionPolicy, TargetSnapshot};

/// Bounded source-read size for direct local archive output.
pub const ARCHIVE_COPY_BUFFER_SIZE: usize = 64 * 1024;
const ARCHIVE_WRITE_BUFFER_SIZE: usize = 256 * 1024;
pub const TEMPORARY_ARCHIVE_SIZE_LIMIT_EXCEEDED: &str = "temporary_archive_size_limit_exceeded";
const TEMPORARY_ARCHIVE_DIRECTORY: &str = "sambee-archive-downloads";
const TEMPORARY_ARCHIVE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const TEMPORARY_DOWNLOAD_PREFIX: &str = "sambee-download-";
const TEMPORARY_SOURCE_PREFIX: &str = "sambee-zip-source-";
const STORED_SAVINGS_BYTES: usize = 1024;
const STORED_SAVINGS_RATIO: f64 = 0.05;
const ZIP_MIN_YEAR: i32 = 1980;
const ZIP_MAX_YEAR: i32 = 2107;
const ZIP_DOS_EPOCH_SECONDS: u64 = 315_532_800;
const EOCD_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
const CENTRAL_DIRECTORY_SIGNATURE: &[u8; 4] = b"PK\x01\x02";
const ZIP64_LOCATOR_SIGNATURE: &[u8; 4] = b"PK\x06\x07";
const ZIP64_EOCD_SIGNATURE: &[u8; 4] = b"PK\x06\x06";

#[derive(Clone, Default)]
struct ArchiveWriteMetrics {
    bytes: Arc<AtomicU64>,
    operations: Arc<AtomicUsize>,
}

struct MeasuredWriter<W: Write> {
    inner: W,
    metrics: ArchiveWriteMetrics,
}

impl<W: Write> Write for MeasuredWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.metrics.operations.fetch_add(1, Ordering::Relaxed);
        self.metrics.bytes.fetch_add(written as u64, Ordering::Relaxed);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

pub struct SizeLimitedArchiveWriter<W: Write> {
    inner: W,
    limit: u64,
    written: u64,
}

impl<W: Write> SizeLimitedArchiveWriter<W> {
    pub fn new(inner: W, limit: u64) -> Self {
        Self { inner, limit, written: 0 }
    }
}

impl<W: Write> Write for SizeLimitedArchiveWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if u64::try_from(buffer.len()).map_or(true, |size| size > self.limit.saturating_sub(self.written)) {
            return Err(std::io::Error::other(TEMPORARY_ARCHIVE_SIZE_LIMIT_EXCEEDED));
        }
        let written = self.inner.write(buffer)?;
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}
const LOCAL_FILE_SIGNATURE: &[u8; 4] = b"PK\x03\x04";
const EOCD_SIZE: usize = 22;
const ZIP64_LOCATOR_SIZE: usize = 20;
const CENTRAL_DIRECTORY_FIXED_SIZE: usize = 46;
const MAX_COMMENT_BYTES: usize = u16::MAX as usize;
const MAX_ENTRY_VARIABLE_BYTES: usize = u16::MAX as usize * 3;
const ZIP64_SENTINEL_U16: u16 = u16::MAX;
const ZIP64_SENTINEL_U32: u32 = u32::MAX;
const INFOZIP_UNICODE_PATH_FIELD_ID: u16 = 0x7075;
const INFOZIP_UNICODE_PATH_VERSION: u8 = 1;
const CP437_EXTENDED_CHARACTERS: &str =
    "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const UNIX_HOST_SYSTEM: u16 = 3;
const UNIX_FILE_TYPE_MASK: u16 = 0o170000;
const UNIX_DIRECTORY_FILE_TYPE: u16 = 0o040000;
const UNIX_REGULAR_FILE_TYPE: u16 = 0o100000;

/// Archive operations owned by the Companion runtime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompanionArchiveOperationKind {
    Inspect,
    Create,
    Extract,
}

/// Source and destination placement for a Companion-owned archive operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompanionArchiveTopology {
    LocalInspection,
    LocalToLocal,
    SmbToLocal,
    LocalToSmb,
}

/// Concrete adapter binding selected by a Companion topology plan.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompanionArchiveBinding {
    LocalInspection,
    LocalToLocal,
    SmbToLocalRelay,
    LocalToSmbRelay,
}

/// Signed V2 capability purpose for one mixed Companion relay topology.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompanionArchiveRelayPurpose {
    LocalZipToSmbExtract,
    SmbZipToLocalExtract,
    SmbToLocalZipCreate,
    LocalToSmbZipCreate,
}

impl CompanionArchiveRelayPurpose {
    pub const fn resolve(
        kind: CompanionArchiveOperationKind,
        source_is_local: bool,
        destination_is_local: bool,
    ) -> Result<Self, LocalArchiveError> {
        match (kind, source_is_local, destination_is_local) {
            (CompanionArchiveOperationKind::Extract, true, false) => Ok(Self::LocalZipToSmbExtract),
            (CompanionArchiveOperationKind::Extract, false, true) => Ok(Self::SmbZipToLocalExtract),
            (CompanionArchiveOperationKind::Create, false, true) => Ok(Self::SmbToLocalZipCreate),
            (CompanionArchiveOperationKind::Create, true, false) => Ok(Self::LocalToSmbZipCreate),
            _ => Err(LocalArchiveError::UnsupportedSource),
        }
    }

    pub const fn binding(self) -> CompanionArchiveBinding {
        match self {
            Self::LocalZipToSmbExtract | Self::LocalToSmbZipCreate => CompanionArchiveBinding::LocalToSmbRelay,
            Self::SmbZipToLocalExtract | Self::SmbToLocalZipCreate => CompanionArchiveBinding::SmbToLocalRelay,
        }
    }

    pub const fn operation_segment(self) -> &'static str {
        match self {
            Self::LocalZipToSmbExtract | Self::SmbZipToLocalExtract => "extraction",
            Self::SmbToLocalZipCreate | Self::LocalToSmbZipCreate => "creation",
        }
    }

    #[cfg(test)]
    pub const fn capability_purpose(self) -> &'static str {
        match self {
            Self::LocalZipToSmbExtract => "local_zip_to_smb_extract",
            Self::SmbZipToLocalExtract => "smb_zip_to_local_extract",
            Self::SmbToLocalZipCreate => "smb_to_local_zip_create",
            Self::LocalToSmbZipCreate => "local_to_smb_zip_create",
        }
    }
}

/// Runtime selected to execute a Companion-owned archive topology plan.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompanionArchiveExecutionDriver {
    Companion,
}

/// Immutable routing decision used before a Companion archive coordinator starts work.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CompanionArchiveTopologyPlan {
    pub kind: CompanionArchiveOperationKind,
    pub driver: CompanionArchiveExecutionDriver,
    pub topology: CompanionArchiveTopology,
    pub source_is_local: bool,
    pub destination_is_local: Option<bool>,
    pub binding: CompanionArchiveBinding,
}

/// Resolve the Companion owner and concrete adapter direction for one operation.
pub fn resolve_companion_archive_topology_plan(
    kind: CompanionArchiveOperationKind,
    source_is_local: bool,
    destination_is_local: bool,
) -> Result<CompanionArchiveTopologyPlan, LocalArchiveError> {
    let (topology, binding) = match (source_is_local, destination_is_local) {
        (true, true) if matches!(kind, CompanionArchiveOperationKind::Create | CompanionArchiveOperationKind::Extract) => {
            (CompanionArchiveTopology::LocalToLocal, CompanionArchiveBinding::LocalToLocal)
        }
        (false, true) => (
            CompanionArchiveTopology::SmbToLocal,
            CompanionArchiveRelayPurpose::resolve(kind, source_is_local, destination_is_local)?.binding(),
        ),
        (true, false) => (
            CompanionArchiveTopology::LocalToSmb,
            CompanionArchiveRelayPurpose::resolve(kind, source_is_local, destination_is_local)?.binding(),
        ),
        _ => return Err(LocalArchiveError::UnsupportedSource),
    };
    Ok(CompanionArchiveTopologyPlan {
        kind,
        driver: CompanionArchiveExecutionDriver::Companion,
        topology,
        source_is_local,
        destination_is_local: Some(destination_is_local),
        binding,
    })
}

/// Resolve the Companion-owned binding for a request-scoped archive inspection.
pub fn resolve_companion_archive_inspection_topology_plan(
    source_is_local: bool,
) -> Result<CompanionArchiveTopologyPlan, LocalArchiveError> {
    if !source_is_local {
        return Err(LocalArchiveError::UnsupportedSource);
    }
    Ok(CompanionArchiveTopologyPlan {
        kind: CompanionArchiveOperationKind::Inspect,
        driver: CompanionArchiveExecutionDriver::Companion,
        topology: CompanionArchiveTopology::LocalInspection,
        source_is_local,
        destination_is_local: None,
        binding: CompanionArchiveBinding::LocalInspection,
    })
}

/// A safe entry parsed from a local ZIP central directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchiveReadEntry {
    pub path: String,
    pub is_directory: bool,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    pub compression_method: u16,
    pub crc32: u32,
    pub modified_at: Option<DateTime<Utc>>,
    pub encrypted: bool,
    pub is_safe: bool,
    pub has_supported_file_type: bool,
    pub local_header_offset: u64,
    pub flags: u16,
    pub raw_name: Vec<u8>,
}

/// One local-header-validated member, bound to the file handle that supplied it.
pub struct ValidatedLocalArchiveEntry {
    entry: LocalArchiveReadEntry,
    file: FsFile,
}

impl std::ops::Deref for ValidatedLocalArchiveEntry {
    type Target = LocalArchiveReadEntry;

    fn deref(&self) -> &Self::Target {
        &self.entry
    }
}

/// Local archive source adapter bound before request-scoped inspection begins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchiveInspectionSource {
    archive_path: PathBuf,
}

impl LocalArchiveInspectionSource {
    /// Bind one validated local archive source without exposing parser details to callers.
    pub fn from_archive_path(archive_path: PathBuf) -> Self {
        Self { archive_path }
    }

    fn inspection_page(
        &self,
        virtual_path: &str,
        cursor: Option<&str>,
        page_size: usize,
    ) -> Result<LocalArchiveDirectoryPage, LocalArchiveReadError> {
        LocalArchiveReader::open_pinned(&self.archive_path)?.directory_page(virtual_path, cursor, page_size)
    }

    fn member_entry(&self, member_path: &str) -> Result<LocalArchiveReadEntry, LocalArchiveReadError> {
        let mut reader = LocalArchiveReader::open_pinned(&self.archive_path)?;
        find_local_archive_member(&mut reader, member_path)
    }

    fn validated_member(&self, member_path: &str) -> Result<ValidatedLocalArchiveEntry, LocalArchiveReadError> {
        let mut reader = LocalArchiveReader::open_pinned(&self.archive_path)?;
        let entry = find_local_archive_member(&mut reader, member_path)?;
        reader.validate_entry(entry)
    }
}

fn find_local_archive_member(reader: &mut LocalArchiveReader, member_path: &str) -> Result<LocalArchiveReadEntry, LocalArchiveReadError> {
    let (normalized_path, is_directory) = normalize_virtual_path(member_path);
    if is_directory || normalized_path.is_empty() || !is_safe_virtual_path(member_path, &normalized_path) {
        return Err(LocalArchiveReadError::InvalidMemberPath);
    }
    let projection = reader.effective_projection()?;
    if let Some(entry) = projection.member_by_path.get(&normalized_path) {
        if entry.encrypted {
            return Err(LocalArchiveReadError::EncryptedMember);
        }
        if !matches!(entry.compression_method, 0 | 8 | 12) {
            return Err(LocalArchiveReadError::UnavailableMember);
        }
        return Ok(entry.clone());
    }
    Err(LocalArchiveReadError::MemberNotFound)
}

/// Immutable V2 archive-directory presenter bound before inspection starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveDirectoryListingPresentation {
    archive_path: String,
    archive_size: u64,
    archive_modified_at: Option<DateTime<Utc>>,
    virtual_path: String,
    cursor: Option<String>,
    page_size: usize,
}

impl ArchiveDirectoryListingPresentation {
    pub fn new(
        archive_path: String,
        archive_size: u64,
        archive_modified_at: Option<DateTime<Utc>>,
        virtual_path: String,
        cursor: Option<String>,
        page_size: usize,
    ) -> Self {
        Self {
            archive_path,
            archive_size,
            archive_modified_at,
            virtual_path,
            cursor,
            page_size,
        }
    }

    fn present(&self, page: LocalArchiveDirectoryPage) -> ArchiveDirectoryListing {
        ArchiveDirectoryListing {
            archive: ArchiveIdentity {
                path: self.archive_path.clone(),
                size: self.archive_size,
                modified_at: self.archive_modified_at,
            },
            path: page.path,
            items: page
                .entries
                .into_iter()
                .map(|entry| ArchiveEntryInfo {
                    name: entry.name.clone(),
                    path: entry.path,
                    file_type: if entry.is_directory { FileType::Directory } else { FileType::File },
                    size: entry.uncompressed_size,
                    compressed_size: entry.compressed_size,
                    compression_method: entry.compression_method,
                    crc32: entry.crc32,
                    modified_at: entry.modified_at,
                    state: if entry.is_directory {
                        ArchiveEntryState::Readable
                    } else if entry.encrypted {
                        ArchiveEntryState::Blocked
                    } else if entry.is_available {
                        ArchiveEntryState::Readable
                    } else {
                        ArchiveEntryState::Unavailable
                    },
                    is_hidden: entry.name.starts_with('.'),
                })
                .collect(),
            next_cursor: page.next_cursor,
            page_size: self.page_size,
        }
    }
}

/// Immutable V2 archive-member presenter bound before inspection starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveMemberReadPresentation {
    member_path: String,
    download: bool,
}

impl ArchiveMemberReadPresentation {
    pub fn new(member_path: String, download: bool) -> Self {
        Self { member_path, download }
    }

    fn present(&self, member: &LocalArchiveReadEntry) -> Result<ArchiveMemberReadProjection, LocalArchiveReadError> {
        let member_name = self.member_path.rsplit('/').next().unwrap_or("download");
        let inline_preview_eligible = !member.is_directory && !member.encrypted && matches!(member.compression_method, 0 | 8 | 12);
        Ok(ArchiveMemberReadProjection {
            member_path: member.path.clone(),
            inline_preview_eligible,
            delivery: if !self.download && !inline_preview_eligible {
                ArchiveMemberReadDelivery::PreviewUnavailable
            } else {
                ArchiveMemberReadDelivery::Stream
            },
            content_type: mime_guess::from_path(member_name).first_or_octet_stream().to_string(),
            content_disposition: format!(
                "{}; filename=\"{member_name}\"",
                if self.download { "attachment" } else { "inline" }
            ),
        })
    }
}

/// Transport-neutral V2 member delivery selected by the presentation adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveMemberReadDelivery {
    Stream,
    PreviewUnavailable,
}

/// V2 member response details projected by a request-scoped presentation adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveMemberReadProjection {
    pub member_path: String,
    pub inline_preview_eligible: bool,
    pub delivery: ArchiveMemberReadDelivery,
    pub content_type: String,
    pub content_disposition: String,
}

/// Existing V2 response presenter selected by a request route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveInspectionPresentation {
    DirectoryListing(ArchiveDirectoryListingPresentation),
    MemberRead(ArchiveMemberReadPresentation),
}

/// Immutable, request-scoped local inspection source and presentation binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveInspectionPlan {
    source: LocalArchiveInspectionSource,
    presentation: ArchiveInspectionPresentation,
}

impl ArchiveInspectionPlan {
    /// Bind a local source and request presentation without retaining archive-wide state.
    pub fn from_local_source(
        source: LocalArchiveInspectionSource,
        presentation: ArchiveInspectionPresentation,
    ) -> Result<Self, LocalArchiveReadError> {
        Ok(Self { source, presentation })
    }

    /// Return the existing V2 response projection selected for this request.
    pub fn presentation(&self) -> ArchiveInspectionPresentation {
        self.presentation.clone()
    }
}

/// Resolve a request-scoped inspection plan without owning transport or HTTP projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveInspectionCoordinator {
    plan: ArchiveInspectionPlan,
}

impl ArchiveInspectionCoordinator {
    pub fn from_plan(plan: ArchiveInspectionPlan) -> Self {
        Self { plan }
    }

    pub fn directory_listing(&self) -> Result<ArchiveDirectoryListing, LocalArchiveReadError> {
        match self.plan.presentation() {
            ArchiveInspectionPresentation::DirectoryListing(presentation) => {
                let page =
                    self.plan
                        .source
                        .inspection_page(&presentation.virtual_path, presentation.cursor.as_deref(), presentation.page_size)?;
                Ok(presentation.present(page))
            }
            ArchiveInspectionPresentation::MemberRead(_) => Err(LocalArchiveReadError::PresentationMismatch),
        }
    }

    /// Resolve and validate a streamed member against this request's parsed entries.
    pub fn validated_member_read(
        &self,
    ) -> Result<(ArchiveMemberReadProjection, Option<ValidatedLocalArchiveEntry>), LocalArchiveReadError> {
        let ArchiveInspectionPresentation::MemberRead(presentation) = self.plan.presentation() else {
            return Err(LocalArchiveReadError::PresentationMismatch);
        };
        let entry = self.plan.source.member_entry(&presentation.member_path)?;
        let projection = presentation.present(&entry)?;
        if projection.delivery == ArchiveMemberReadDelivery::PreviewUnavailable {
            return Ok((projection, None));
        }
        Ok((projection, Some(self.plan.source.validated_member(&entry.path)?)))
    }
}

/// A single direct child returned from a virtual archive directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchiveDirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    pub compressed_size: Option<u64>,
    pub uncompressed_size: Option<u64>,
    pub compression_method: Option<u16>,
    pub crc32: Option<u32>,
    pub modified_at: Option<DateTime<Utc>>,
    pub encrypted: bool,
    pub is_available: bool,
}

/// A bounded virtual-directory page from a local ZIP archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchiveDirectoryPage {
    pub path: String,
    pub entries: Vec<LocalArchiveDirectoryEntry>,
    pub next_cursor: Option<String>,
}

/// Selected source entries and inferred virtual directories for one local reader.
#[derive(Debug, Clone)]
pub(crate) struct EffectiveLocalArchiveProjection {
    pub entries: Vec<LocalArchiveReadEntry>,
    member_by_path: HashMap<String, LocalArchiveReadEntry>,
    directories: HashSet<String>,
    pub skipped_entries: usize,
}

/// A source item mapped to one portable archive entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchiveEntry {
    pub source_path: PathBuf,
    pub archive_path: String,
    pub is_directory: bool,
    pub source_size: u64,
    pub source_modified_at: Option<String>,
}

/// Summary of a completed local archive write.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LocalArchiveCreationResult {
    pub files_created: u64,
    pub directories_created: u64,
    pub source_bytes: u64,
}

/// An immutable, normalized member approved for archive creation.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ArchiveCreationManifestMember {
    pub archive_path: String,
    pub is_directory: bool,
    pub source_size: u64,
    #[serde(default, rename = "modified_at", alias = "source_modified_at")]
    pub source_modified_at: Option<String>,
}

/// Typed creation manifest shared by local and relayed archive writers.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ArchiveCreationManifest {
    pub entries: Vec<ArchiveCreationManifestMember>,
}

impl ArchiveCreationManifest {
    /// Normalize and validate all immutable creation members before output begins.
    pub fn from_entries(entries: Vec<ArchiveCreationManifestMember>) -> Result<Self, LocalArchiveError> {
        if entries.is_empty() {
            return Err(LocalArchiveError::EmptyCreationManifest);
        }
        let mut normalized_entries = Vec::with_capacity(entries.len());
        let mut file_paths = HashSet::new();
        let mut directory_paths = HashSet::new();
        for entry in entries {
            if entry.is_directory && entry.source_size != 0 {
                return Err(LocalArchiveError::InvalidDirectorySourceSize);
            }
            let archive_path = normalized_archive_path(&entry.archive_path, entry.is_directory)?
                .trim_end_matches('/')
                .to_string();
            let archive_path_key = collision_key(&archive_path);
            if entry.is_directory {
                if !directory_paths.insert(archive_path_key) {
                    return Err(LocalArchiveError::DuplicateEntryPath);
                }
            } else if !file_paths.insert(archive_path_key) {
                return Err(LocalArchiveError::DuplicateEntryPath);
            }
            let path_parts = archive_path.split('/').collect::<Vec<_>>();
            let directory_part_count = if entry.is_directory {
                path_parts.len()
            } else {
                path_parts.len().saturating_sub(1)
            };
            for index in 1..=directory_part_count {
                directory_paths.insert(collision_key(&path_parts[..index].join("/")));
            }
            normalized_entries.push(ArchiveCreationManifestMember {
                archive_path,
                is_directory: entry.is_directory,
                source_size: entry.source_size,
                source_modified_at: normalize_creation_source_modified_at(entry.source_modified_at)?,
            });
        }
        if !file_paths.is_disjoint(&directory_paths) {
            return Err(LocalArchiveError::DuplicateEntryPath);
        }
        Ok(Self {
            entries: normalized_entries,
        })
    }

    /// Return the normalized approved member for a transport path.
    pub fn member(&self, archive_path: &str) -> Result<&ArchiveCreationManifestMember, LocalArchiveError> {
        let normalized_path = normalized_archive_path(archive_path, false)?;
        let normalized = normalized_path.trim_end_matches('/');
        self.entries
            .iter()
            .find(|entry| entry.archive_path == normalized)
            .ok_or(LocalArchiveError::UnknownCreationMember)
    }

    /// Return aggregate expected totals for a fully committed manifest.
    #[cfg(test)]
    pub fn summary(&self) -> Result<LocalArchiveCreationResult, LocalArchiveError> {
        let mut result = LocalArchiveCreationResult::default();
        for entry in &self.entries {
            if entry.is_directory {
                result.directories_created = result
                    .directories_created
                    .checked_add(1)
                    .ok_or_else(|| LocalArchiveError::Io(std::io::Error::other("Archive directory count overflow")))?;
            } else {
                result.files_created = result
                    .files_created
                    .checked_add(1)
                    .ok_or_else(|| LocalArchiveError::Io(std::io::Error::other("Archive file count overflow")))?;
                result.source_bytes = result
                    .source_bytes
                    .checked_add(entry.source_size)
                    .ok_or_else(|| LocalArchiveError::Io(std::io::Error::other("Archive source size overflow")))?;
            }
        }
        Ok(result)
    }
}

/// Immutable creation manifest binding consumed by a local creation execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchiveCreationExecutionPlan {
    manifest: ArchiveCreationManifest,
}

impl LocalArchiveCreationExecutionPlan {
    pub fn from_manifest(manifest: ArchiveCreationManifest) -> Self {
        Self { manifest }
    }

    pub fn from_entries(entries: &[LocalArchiveEntry]) -> Result<Self, LocalArchiveError> {
        project_local_archive_creation_manifest(entries).map(Self::from_manifest)
    }

    fn into_state(self) -> ArchiveCreationManifestState {
        ArchiveCreationManifestState::new(self.manifest)
    }
}

/// One manifest-validated creation member outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveCreationMemberOutcome {
    pub archive_path: String,
    pub status: LocalArchiveCreationMemberStatus,
    pub source_bytes: u64,
}

/// In-memory relay outcome state that requires exact manifest coverage at completion.
#[derive(Debug, Clone)]
pub struct ArchiveCreationManifestState {
    manifest: ArchiveCreationManifest,
    outcomes: HashMap<String, ArchiveCreationMemberOutcome>,
}

impl ArchiveCreationManifestState {
    pub fn new(manifest: ArchiveCreationManifest) -> Self {
        Self {
            manifest,
            outcomes: HashMap::new(),
        }
    }

    pub fn expected_outcome(&self, archive_path: &str) -> Result<ArchiveCreationMemberOutcome, LocalArchiveError> {
        let member = self.manifest.member(archive_path)?;
        Ok(ArchiveCreationMemberOutcome {
            archive_path: member.archive_path.clone(),
            status: if member.is_directory {
                LocalArchiveCreationMemberStatus::Directory
            } else {
                LocalArchiveCreationMemberStatus::Created
            },
            source_bytes: member.source_size,
        })
    }

    pub fn record(&mut self, outcome: ArchiveCreationMemberOutcome) -> Result<(), LocalArchiveError> {
        let expected = self.expected_outcome(&outcome.archive_path)?;
        if outcome != expected {
            return Err(LocalArchiveError::InvalidCreationOutcome);
        }
        if let Some(existing) = self.outcomes.get(&expected.archive_path) {
            return if existing == &expected {
                Ok(())
            } else {
                Err(LocalArchiveError::ConflictingCreationOutcome)
            };
        }
        self.outcomes.insert(expected.archive_path.clone(), expected);
        Ok(())
    }

    /// Record the sole permitted outcome after the member's physical write is acknowledged.
    pub fn record_expected(&mut self, archive_path: &str) -> Result<(), LocalArchiveError> {
        self.record(self.expected_outcome(archive_path)?)
    }

    #[cfg(test)]
    pub fn completed_member_paths(&self) -> impl Iterator<Item = &str> {
        self.outcomes.keys().map(String::as_str)
    }

    /// Return aggregate progress derived solely from recorded member outcomes.
    pub fn progress(&self) -> Result<LocalArchiveCreationResult, LocalArchiveError> {
        let mut result = LocalArchiveCreationResult::default();
        for outcome in self.outcomes.values() {
            match outcome.status {
                LocalArchiveCreationMemberStatus::Directory => {
                    result.directories_created = result
                        .directories_created
                        .checked_add(1)
                        .ok_or_else(|| LocalArchiveError::Io(std::io::Error::other("Archive directory count overflow")))?;
                }
                LocalArchiveCreationMemberStatus::Created => {
                    result.files_created = result
                        .files_created
                        .checked_add(1)
                        .ok_or_else(|| LocalArchiveError::Io(std::io::Error::other("Archive file count overflow")))?;
                    result.source_bytes = result
                        .source_bytes
                        .checked_add(outcome.source_bytes)
                        .ok_or_else(|| LocalArchiveError::Io(std::io::Error::other("Archive source size overflow")))?;
                }
            }
        }
        Ok(result)
    }

    pub fn terminal_summary(&self) -> Result<LocalArchiveCreationResult, LocalArchiveError> {
        if self.outcomes.len() != self.manifest.entries.len()
            || self
                .manifest
                .entries
                .iter()
                .any(|entry| !self.outcomes.contains_key(&entry.archive_path))
        {
            return Err(LocalArchiveError::IncompleteCreationManifest);
        }
        self.progress()
    }
}

/// Terminal state reported after one local ZIP entry commits successfully.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalArchiveCreationMemberStatus {
    Directory,
    Created,
}

/// One bounded source-stream event supplied by the asynchronous SMB relay.
pub enum LocalArchiveRelayChunk {
    Data(Vec<u8>),
    Complete,
    Failed,
}

/// Stateful local ZIP writer used while an asynchronous source relay streams one member at a time.
pub struct LocalArchiveRelayWriter {
    writer: ZipWriter<StreamWriter<BufWriter<MeasuredWriter<FsFile>>>>,
    manifest: ArchiveCreationManifest,
    next_manifest_index: usize,
    metrics: ArchiveWriteMetrics,
    started_at: Instant,
}

/// Summary of a completed local archive extraction.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LocalArchiveExtractionResult {
    pub members_processed: u64,
    pub members_completed: u64,
    pub members_skipped: u64,
    pub encrypted_members_skipped: u64,
    pub unsupported_compression_members_skipped: u64,
    pub members_failed: u64,
    pub files_extracted: u64,
    pub directories_created: u64,
    pub extracted_bytes: u64,
    pub files_replaced: u64,
}

/// Terminal state reported by a local extraction destination for one archive member.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalArchiveExtractionDestinationStatus {
    Directory,
    Extracted,
    Skipped,
    Ignored,
}

/// Provider-neutral member result used to update extraction progress and replay state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchiveExtractionDestinationResult {
    pub member_path: String,
    pub status: LocalArchiveExtractionDestinationStatus,
    pub target_path: String,
    pub extracted_bytes: u64,
    pub directories_created: u64,
    pub replaced: bool,
    pub renamed: bool,
}

/// Compatibility aliases for operation-neutral target-resolution types.
pub type LocalArchiveTargetWritePolicy = TargetResolutionPolicy;
pub type LocalArchiveTargetWriteDisposition = TargetResolutionDisposition;

/// The local target-output controller result consumed by direct and relay extraction.
pub enum LocalArchiveTargetOutput {
    Ready {
        file: FsFile,
        replaced: bool,
        directories_created: u64,
    },
    Skip,
    AwaitCollision {
        target: LocalArchiveConflictTarget,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchiveConflictTarget {
    pub size: Option<u64>,
    pub modified_at: Option<DateTime<Utc>>,
}

impl LocalArchiveConflictTarget {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            size: metadata.file_type().is_file().then_some(metadata.len()),
            modified_at: metadata.modified().ok().map(DateTime::<Utc>::from),
        }
    }

    pub(crate) fn unavailable() -> Self {
        Self {
            size: None,
            modified_at: None,
        }
    }
}

/// One native local target-open attempt before content output begins.
enum LocalArchiveTargetWriteAttempt {
    Ready(FsFile),
    TargetExistsBeforeContent,
    Failure(LocalArchiveError),
}

/// The local directory controller result used by direct and relay extraction.
pub enum LocalArchiveDirectoryOutput {
    Ready { directories_created: u64 },
    AwaitCollision { target: LocalArchiveConflictTarget },
}

pub type LocalArchiveTargetSnapshot = TargetSnapshot;

pub(crate) fn local_archive_target_write_policy_from_wire(action: Option<&str>) -> Option<LocalArchiveTargetWritePolicy> {
    match action {
        None | Some("ask") | Some("rename") => Some(LocalArchiveTargetWritePolicy::Ask),
        Some("skip") | Some("skip_all") => Some(LocalArchiveTargetWritePolicy::Skip),
        Some("replace") | Some("replace_all") => Some(LocalArchiveTargetWritePolicy::Replace),
        Some("replace_older") => Some(LocalArchiveTargetWritePolicy::ReplaceOlder),
        Some(_) => None,
    }
}

pub fn resolve_local_archive_target_write(
    policy: LocalArchiveTargetWritePolicy,
    source_modified_at: Option<DateTime<Utc>>,
    target_metadata: Option<&fs::Metadata>,
) -> LocalArchiveTargetWriteDisposition {
    let target = match target_metadata {
        None => LocalArchiveTargetSnapshot::Missing,
        Some(metadata) if metadata.file_type().is_file() => LocalArchiveTargetSnapshot::RegularFile {
            modified_at: metadata.modified().ok().map(DateTime::<Utc>::from),
        },
        Some(_) => LocalArchiveTargetSnapshot::Other,
    };
    resolve_local_archive_target_snapshot(policy, source_modified_at, target)
}

pub fn resolve_local_archive_target_snapshot(
    policy: LocalArchiveTargetWritePolicy,
    source_modified_at: Option<DateTime<Utc>>,
    target: LocalArchiveTargetSnapshot,
) -> LocalArchiveTargetWriteDisposition {
    resolve_target_mutation(policy, source_modified_at, target)
}

/// A failed local archive member that can be retried or left in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArchiveExtractionMemberError {
    pub member_path: String,
    pub target_path: String,
    pub message: String,
    pub partial_output: bool,
}

/// Errors returned by local direct archive creation.
#[derive(Debug, Error)]
pub enum LocalArchiveError {
    #[error("archive entry path is unsafe")]
    UnsafeEntryPath,
    #[error("archive output already exists")]
    TargetExists,
    #[error("archive extraction destination already exists")]
    ExtractionTargetExists,
    #[error("archive output is inside a selected source directory")]
    TargetInsideSource,
    #[error("archive output is outside the allowed drive root")]
    TargetOutsideRoot,
    #[error("archive sources produce duplicate normalized entry names")]
    DuplicateEntryPath,
    #[error("archive creation manifest is empty")]
    EmptyCreationManifest,
    #[error("archive directory source size must be zero")]
    InvalidDirectorySourceSize,
    #[error("archive creation member is invalid or unavailable")]
    UnknownCreationMember,
    #[error("selected archive member is invalid or unavailable")]
    UnknownExtractionMember,
    #[error("archive creation member outcome is invalid")]
    InvalidCreationOutcome,
    #[error("archive creation member outcome conflicts with its prior result")]
    ConflictingCreationOutcome,
    #[error("archive creation member outcomes did not match the preflight manifest")]
    IncompleteCreationManifest,
    #[error("archive source changed since extraction began")]
    ArchiveSourceChanged,
    #[error("archive source is not a regular file or directory")]
    UnsupportedSource,
    #[error("archive operation was cancelled")]
    Cancelled,
    #[error("archive creation failed after creating partial output: {0}")]
    PartialArchiveOutput(#[source] Box<LocalArchiveError>),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
    #[error(transparent)]
    ArchiveRead(#[from] LocalArchiveReadError),
}

/// Errors returned by custom local ZIP metadata parsing.
#[derive(Debug, Error)]
pub enum LocalArchiveReadError {
    #[error("archive is too small to be a ZIP file")]
    TooSmall,
    #[error("ZIP end-of-central-directory record is missing or malformed")]
    InvalidEndOfDirectory,
    #[error("ZIP64 end-of-central-directory record is invalid")]
    InvalidZip64Directory,
    #[error("ZIP central directory extends beyond archive bounds")]
    DirectoryOutOfBounds,
    #[error("ZIP central-directory entry is invalid")]
    InvalidDirectoryEntry,
    #[error("ZIP central-directory entry length is invalid")]
    InvalidEntryLength,
    #[error("ZIP64 member metadata is missing or malformed")]
    InvalidZip64Member,
    #[error("archive listing cursor is invalid")]
    InvalidCursor,
    #[error("archive member path is invalid")]
    InvalidMemberPath,
    #[error("archive member was not found")]
    MemberNotFound,
    #[error("archive member is encrypted. Use an archive tool with the password to open it")]
    EncryptedMember,
    #[error("archive member uses unsupported compression. Use another archive tool to open it")]
    UnavailableMember,
    #[error("ZIP local header is invalid or does not match the central directory")]
    InvalidLocalHeader,
    #[error("archive member payload extends beyond archive bounds")]
    MemberOutOfBounds,
    #[error("archive operation was cancelled")]
    Cancelled,
    #[error("archive member integrity check failed")]
    MemberIntegrityFailure,
    #[error("pinned archive source changed")]
    SourceChanged,
    #[error("archive inspection plan does not support this response projection")]
    PresentationMismatch,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

fn u16_le(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

fn u32_le(data: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]])
}

fn u64_le(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
    ])
}

fn encode_directory_cursor(path: &str, offset: usize) -> String {
    format!("{}:{offset}", hex::encode(path))
}

fn decode_directory_cursor(value: &str, path: &str) -> Result<usize, LocalArchiveReadError> {
    let Some((encoded_path, encoded_offset)) = value.split_once(':') else {
        return Err(LocalArchiveReadError::InvalidCursor);
    };
    let decoded_path = String::from_utf8(hex::decode(encoded_path).map_err(|_| LocalArchiveReadError::InvalidCursor)?)
        .map_err(|_| LocalArchiveReadError::InvalidCursor)?;
    if decoded_path != path {
        return Err(LocalArchiveReadError::InvalidCursor);
    }
    encoded_offset.parse().map_err(|_| LocalArchiveReadError::InvalidCursor)
}

fn read_exact_at(file: &mut FsFile, archive_size: u64, offset: u64, length: usize) -> Result<Vec<u8>, LocalArchiveReadError> {
    let end = offset
        .checked_add(length as u64)
        .ok_or(LocalArchiveReadError::DirectoryOutOfBounds)?;
    if end > archive_size {
        return Err(LocalArchiveReadError::DirectoryOutOfBounds);
    }
    let mut data = vec![0; length];
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut data)?;
    Ok(data)
}

#[cfg(windows)]
const WINDOWS_FILE_SHARE_READ: u32 = 0x0000_0001;

fn open_pinned_archive_file(path: &Path) -> Result<FsFile, LocalArchiveReadError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        options.share_mode(WINDOWS_FILE_SHARE_READ);
    }
    Ok(options.open(path)?)
}

/// One retained, forward-only local ZIP central-directory reader.
pub struct LocalArchiveReader {
    file: FsFile,
    archive_size: u64,
    #[cfg(unix)]
    archive_metadata: PinnedArchiveMetadata,
    directory_end: u64,
    position: u64,
    remaining_entries: u64,
}

#[cfg(unix)]
#[derive(Clone, Copy, Eq, PartialEq)]
struct PinnedArchiveMetadata {
    device: u64,
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

#[cfg(unix)]
impl PinnedArchiveMetadata {
    fn from_metadata(metadata: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;

        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.len(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }
}

impl LocalArchiveReader {
    /// Open a local ZIP once and retain its descriptor until the source session ends.
    pub fn open_pinned(archive_path: &Path) -> Result<Self, LocalArchiveReadError> {
        let mut file = open_pinned_archive_file(archive_path)?;
        let metadata = file.metadata()?;
        let archive_size = metadata.len();
        #[cfg(unix)]
        let archive_metadata = PinnedArchiveMetadata::from_metadata(&metadata);
        if archive_size < EOCD_SIZE as u64 {
            return Err(LocalArchiveReadError::TooSmall);
        }
        let tail_length = archive_size.min((EOCD_SIZE + MAX_COMMENT_BYTES) as u64) as usize;
        let tail = read_exact_at(&mut file, archive_size, archive_size - tail_length as u64, tail_length)?;
        let Some(eocd_index) = tail.windows(EOCD_SIGNATURE.len()).rposition(|window| window == EOCD_SIGNATURE) else {
            return Err(LocalArchiveReadError::InvalidEndOfDirectory);
        };
        if eocd_index + EOCD_SIZE > tail.len() || eocd_index + EOCD_SIZE + usize::from(u16_le(&tail, eocd_index + 20)) != tail.len() {
            return Err(LocalArchiveReadError::InvalidEndOfDirectory);
        }
        let eocd_offset = archive_size - tail_length as u64 + eocd_index as u64;
        let mut remaining_entries = u64::from(u16_le(&tail, eocd_index + 10));
        let mut directory_size = u64::from(u32_le(&tail, eocd_index + 12));
        let mut position = u64::from(u32_le(&tail, eocd_index + 16));
        if remaining_entries == u64::from(ZIP64_SENTINEL_U16)
            || directory_size == u64::from(ZIP64_SENTINEL_U32)
            || position == u64::from(ZIP64_SENTINEL_U32)
        {
            if eocd_offset < ZIP64_LOCATOR_SIZE as u64 {
                return Err(LocalArchiveReadError::InvalidZip64Directory);
            }
            let locator = read_exact_at(&mut file, archive_size, eocd_offset - ZIP64_LOCATOR_SIZE as u64, ZIP64_LOCATOR_SIZE)?;
            if locator[..4] != *ZIP64_LOCATOR_SIGNATURE {
                return Err(LocalArchiveReadError::InvalidZip64Directory);
            }
            let header = read_exact_at(&mut file, archive_size, u64_le(&locator, 8), 56)?;
            if header[..4] != *ZIP64_EOCD_SIGNATURE || u64_le(&header, 4) < 44 {
                return Err(LocalArchiveReadError::InvalidZip64Directory);
            }
            remaining_entries = u64_le(&header, 32);
            directory_size = u64_le(&header, 40);
            position = u64_le(&header, 48);
        }
        let directory_end = position
            .checked_add(directory_size)
            .filter(|end| *end <= archive_size)
            .ok_or(LocalArchiveReadError::DirectoryOutOfBounds)?;
        Ok(Self {
            file,
            archive_size,
            #[cfg(unix)]
            archive_metadata,
            directory_end,
            position,
            remaining_entries,
        })
    }

    pub(crate) fn effective_projection(&mut self) -> Result<EffectiveLocalArchiveProjection, LocalArchiveReadError> {
        let mut raw_entries = Vec::new();
        while let Some(entry) = self.next_entry()? {
            raw_entries.push(entry);
        }

        let mut member_indexes = HashMap::new();
        let mut directory_indexes = HashMap::new();
        for (index, entry) in raw_entries.iter().enumerate() {
            if !entry.is_safe || !entry.has_supported_file_type {
                continue;
            }
            if entry.is_directory {
                directory_indexes.insert(entry.path.clone(), index);
            } else {
                member_indexes.insert(entry.path.clone(), index);
            }
        }
        let mut directories: HashSet<String> = directory_indexes
            .keys()
            .filter(|path| !member_indexes.contains_key(*path))
            .cloned()
            .collect();
        let selected_indexes: HashSet<usize> = member_indexes
            .values()
            .chain(
                directory_indexes
                    .iter()
                    .filter_map(|(path, index)| (!member_indexes.contains_key(path)).then_some(index)),
            )
            .copied()
            .collect();
        let entries: Vec<_> = raw_entries
            .iter()
            .enumerate()
            .filter(|(index, _)| selected_indexes.contains(index))
            .map(|(_, entry)| entry.clone())
            .collect();
        let member_by_path: HashMap<String, LocalArchiveReadEntry> = member_indexes
            .into_iter()
            .map(|(path, index)| (path, raw_entries[index].clone()))
            .collect();
        for entry in &entries {
            let segments: Vec<_> = entry.path.split('/').collect();
            for index in 1..segments.len() {
                directories.insert(segments[..index].join("/"));
            }
        }
        directories.retain(|path| !member_by_path.contains_key(path));
        Ok(EffectiveLocalArchiveProjection {
            skipped_entries: raw_entries.len() - entries.len(),
            entries,
            member_by_path,
            directories,
        })
    }

    pub fn directory_page(
        &mut self,
        virtual_path: &str,
        cursor: Option<&str>,
        page_size: usize,
    ) -> Result<LocalArchiveDirectoryPage, LocalArchiveReadError> {
        if !(1..=500).contains(&page_size) {
            return Err(LocalArchiveReadError::InvalidCursor);
        }
        let (path, _) = normalize_virtual_path(virtual_path);
        if !virtual_path.is_empty() && (path.is_empty() || !is_safe_virtual_path(virtual_path, &path)) {
            return Err(LocalArchiveReadError::InvalidMemberPath);
        }
        let projection = self.effective_projection()?;
        if projection.member_by_path.contains_key(&path) {
            return Err(LocalArchiveReadError::InvalidMemberPath);
        }
        if !path.is_empty() && !projection.directories.contains(&path) {
            return Err(LocalArchiveReadError::MemberNotFound);
        }
        let offset = match cursor {
            Some(cursor) => decode_directory_cursor(cursor, &path)?,
            None => 0,
        };
        let prefix = if path.is_empty() { String::new() } else { format!("{path}/") };
        let mut children = HashMap::new();
        for entry in &projection.entries {
            let Some(remainder) = entry.path.strip_prefix(&prefix) else {
                continue;
            };
            if !remainder.is_empty() && !remainder.contains('/') {
                children.insert(entry.path.clone(), local_directory_entry(entry));
            }
        }
        for directory_path in &projection.directories {
            let Some(remainder) = directory_path.strip_prefix(&prefix) else {
                continue;
            };
            if remainder.is_empty() || remainder.contains('/') || children.contains_key(directory_path) {
                continue;
            }
            let Some(representative) = projection
                .entries
                .iter()
                .find(|entry| entry.path.starts_with(&format!("{directory_path}/")))
            else {
                continue;
            };
            children.insert(
                directory_path.clone(),
                LocalArchiveDirectoryEntry {
                    name: remainder.to_string(),
                    path: directory_path.clone(),
                    is_directory: true,
                    compressed_size: None,
                    uncompressed_size: None,
                    compression_method: None,
                    crc32: None,
                    modified_at: representative.modified_at,
                    encrypted: false,
                    is_available: false,
                },
            );
        }
        let mut entries: Vec<_> = children.into_values().collect();
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        if offset > entries.len() {
            return Err(LocalArchiveReadError::InvalidCursor);
        }
        let next_offset = offset + page_size.min(entries.len() - offset);
        let has_more = next_offset < entries.len();
        Ok(LocalArchiveDirectoryPage {
            path: path.clone(),
            entries: entries.into_iter().skip(offset).take(page_size).collect(),
            next_cursor: has_more.then(|| encode_directory_cursor(&path, next_offset)),
        })
    }

    /// Return exactly one central-directory entry, preserving archive record order.
    pub fn next_entry(&mut self) -> Result<Option<LocalArchiveReadEntry>, LocalArchiveReadError> {
        self.ensure_source_unchanged()?;
        if self.remaining_entries == 0 {
            return if self.position == self.directory_end {
                Ok(None)
            } else {
                Err(LocalArchiveReadError::InvalidDirectoryEntry)
            };
        }
        let fixed = read_exact_at(&mut self.file, self.archive_size, self.position, CENTRAL_DIRECTORY_FIXED_SIZE)?;
        if fixed[..4] != *CENTRAL_DIRECTORY_SIGNATURE {
            return Err(LocalArchiveReadError::InvalidDirectoryEntry);
        }
        let name_length = usize::from(u16_le(&fixed, 28));
        let extra_length = usize::from(u16_le(&fixed, 30));
        let comment_length = usize::from(u16_le(&fixed, 32));
        let variable_length = name_length + extra_length + comment_length;
        if variable_length > MAX_ENTRY_VARIABLE_BYTES {
            return Err(LocalArchiveReadError::InvalidEntryLength);
        }
        let entry_end = self
            .position
            .checked_add(CENTRAL_DIRECTORY_FIXED_SIZE as u64)
            .and_then(|offset| offset.checked_add(variable_length as u64))
            .filter(|end| *end <= self.directory_end)
            .ok_or(LocalArchiveReadError::InvalidEntryLength)?;
        let variable = read_exact_at(
            &mut self.file,
            self.archive_size,
            self.position + CENTRAL_DIRECTORY_FIXED_SIZE as u64,
            variable_length,
        )?;
        let raw_name = variable[..name_length].to_vec();
        let flags = u16_le(&fixed, 8);
        let extra = &variable[name_length..name_length + extra_length];
        let decoded_name = decode_entry_name(&raw_name, flags, extra);
        let (path, is_directory) = normalize_virtual_path(&decoded_name);
        let (compressed_size, uncompressed_size, local_header_offset) = zip64_member_values(
            extra,
            u64::from(u32_le(&fixed, 20)),
            u64::from(u32_le(&fixed, 24)),
            u64::from(u32_le(&fixed, 42)),
        )?;
        self.position = entry_end;
        self.remaining_entries -= 1;
        if self.remaining_entries == 0 && self.position != self.directory_end {
            return Err(LocalArchiveReadError::InvalidDirectoryEntry);
        }
        Ok(Some(LocalArchiveReadEntry {
            path: path.clone(),
            is_directory,
            compressed_size,
            uncompressed_size,
            compression_method: u16_le(&fixed, 10),
            crc32: u32_le(&fixed, 16),
            modified_at: dos_datetime(u16_le(&fixed, 14), u16_le(&fixed, 12)),
            encrypted: flags & 1 != 0,
            is_safe: is_safe_virtual_path(&decoded_name, &path),
            has_supported_file_type: has_supported_file_type(u16_le(&fixed, 4), u32_le(&fixed, 38)),
            local_header_offset,
            flags,
            raw_name,
        }))
    }

    /// Validate a record through a duplicate of the original pinned descriptor.
    pub fn validate_entry(&self, entry: LocalArchiveReadEntry) -> Result<ValidatedLocalArchiveEntry, LocalArchiveReadError> {
        self.ensure_source_unchanged()?;
        if entry.encrypted {
            return Err(LocalArchiveReadError::EncryptedMember);
        }
        if !matches!(entry.compression_method, 0 | 8 | 12) {
            return Err(LocalArchiveReadError::UnavailableMember);
        }
        let mut file = self.file.try_clone()?;
        let local_header = read_exact_at(&mut file, self.archive_size, entry.local_header_offset, 30)?;
        if local_header[..4] != *LOCAL_FILE_SIGNATURE
            || u16_le(&local_header, 6) != entry.flags
            || u16_le(&local_header, 8) != entry.compression_method
        {
            return Err(LocalArchiveReadError::InvalidLocalHeader);
        }
        let name_length = usize::from(u16_le(&local_header, 26));
        let extra_length = usize::from(u16_le(&local_header, 28));
        let local_name = read_exact_at(&mut file, self.archive_size, entry.local_header_offset + 30, name_length)?;
        if local_name != entry.raw_name {
            return Err(LocalArchiveReadError::InvalidLocalHeader);
        }
        let data_offset = entry
            .local_header_offset
            .checked_add(30)
            .and_then(|offset| offset.checked_add(name_length as u64))
            .and_then(|offset| offset.checked_add(extra_length as u64))
            .ok_or(LocalArchiveReadError::MemberOutOfBounds)?;
        if data_offset
            .checked_add(entry.compressed_size)
            .filter(|end| *end <= self.archive_size)
            .is_none()
        {
            return Err(LocalArchiveReadError::MemberOutOfBounds);
        }
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(data_offset))?;
        Ok(ValidatedLocalArchiveEntry { entry, file })
    }

    /// Stream one entry through a duplicate of this reader's pinned descriptor.
    pub fn stream_entry_with_cancellation(
        &self,
        entry: LocalArchiveReadEntry,
        output: &mut impl Write,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<(), LocalArchiveReadError> {
        self.ensure_source_unchanged()?;
        let result = stream_validated_local_archive_entry_with_cancellation(self.validate_entry(entry)?, output, is_cancelled);
        self.ensure_source_unchanged()?;
        result
    }

    #[cfg(test)]
    pub fn stream_entry(&self, entry: LocalArchiveReadEntry, output: &mut impl Write) -> Result<(), LocalArchiveReadError> {
        self.stream_entry_with_cancellation(entry, output, || false)
    }

    fn ensure_source_unchanged(&self) -> Result<(), LocalArchiveReadError> {
        #[cfg(unix)]
        {
            let metadata = self.file.metadata()?;
            if PinnedArchiveMetadata::from_metadata(&metadata) != self.archive_metadata {
                return Err(LocalArchiveReadError::SourceChanged);
            }
        }
        Ok(())
    }
}

fn unicode_path_name(raw_name: &[u8], extra: &[u8]) -> Option<String> {
    let mut position = 0;
    while position + 4 <= extra.len() {
        let field_id = u16_le(extra, position);
        let field_length = usize::from(u16_le(extra, position + 2));
        position += 4;
        if position + field_length > extra.len() {
            return None;
        }
        let field = &extra[position..position + field_length];
        position += field_length;
        if field_id != INFOZIP_UNICODE_PATH_FIELD_ID || field.len() < 5 {
            continue;
        }
        if field[0] != INFOZIP_UNICODE_PATH_VERSION || u32_le(field, 1) != !update_crc32(u32::MAX, raw_name) {
            continue;
        }
        if let Ok(name) = std::str::from_utf8(&field[5..]) {
            return Some(name.to_owned());
        }
    }
    None
}

fn decode_entry_name(raw_name: &[u8], flags: u16, extra: &[u8]) -> String {
    if flags & 0x0800 != 0 {
        return String::from_utf8_lossy(raw_name).into_owned();
    }
    if let Some(name) = unicode_path_name(raw_name, extra) {
        return name;
    }
    decode_cp437(raw_name)
}

fn decode_cp437(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| {
            if *byte < 0x80 {
                char::from(*byte)
            } else {
                CP437_EXTENDED_CHARACTERS
                    .chars()
                    .nth(usize::from(*byte - 0x80))
                    .expect("CP437 mapping must contain all 128 extended characters")
            }
        })
        .collect()
}

fn normalize_virtual_path(path: &str) -> (String, bool) {
    let is_directory = path.ends_with(['/', '\\']);
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    (trimmed.to_string(), is_directory)
}

fn is_safe_virtual_path(path: &str, normalized_path: &str) -> bool {
    let canonical = path.replace('\\', "/");
    let trimmed = canonical.trim_end_matches('/');
    if trimmed.is_empty() || trimmed.starts_with('/') || trimmed.contains('\0') {
        return false;
    }
    let segments = trimmed.split('/');
    segments
        .clone()
        .all(|segment| !segment.is_empty() && !matches!(segment, "." | "..") && !segment.contains(':'))
        && normalized_path == trimmed
}

fn local_directory_entry(entry: &LocalArchiveReadEntry) -> LocalArchiveDirectoryEntry {
    LocalArchiveDirectoryEntry {
        name: entry.path.rsplit('/').next().unwrap_or_default().to_string(),
        path: entry.path.clone(),
        is_directory: entry.is_directory,
        compressed_size: (!entry.is_directory).then_some(entry.compressed_size),
        uncompressed_size: (!entry.is_directory).then_some(entry.uncompressed_size),
        compression_method: (!entry.is_directory).then_some(entry.compression_method),
        crc32: (!entry.is_directory).then_some(entry.crc32),
        modified_at: entry.modified_at,
        encrypted: entry.encrypted,
        is_available: !entry.is_directory && !entry.encrypted && matches!(entry.compression_method, 0 | 8 | 12),
    }
}

fn has_supported_file_type(version_made_by: u16, external_attributes: u32) -> bool {
    if version_made_by >> 8 != UNIX_HOST_SYSTEM {
        return true;
    }
    matches!(
        (external_attributes >> 16) as u16 & UNIX_FILE_TYPE_MASK,
        0 | UNIX_DIRECTORY_FILE_TYPE | UNIX_REGULAR_FILE_TYPE
    )
}

fn dos_datetime(date_value: u16, time_value: u16) -> Option<DateTime<Utc>> {
    let year = i32::from((date_value >> 9) & 0x7f) + 1980;
    let month = u32::from((date_value >> 5) & 0x0f);
    let day = u32::from(date_value & 0x1f);
    let hour = u32::from((time_value >> 11) & 0x1f);
    let minute = u32::from((time_value >> 5) & 0x3f);
    let second = u32::from((time_value & 0x1f) * 2);
    NaiveDate::from_ymd_opt(year, month, day)?
        .and_hms_opt(hour, minute, second)
        .map(|value| value.and_utc())
}

fn zip64_member_values(
    extra: &[u8],
    mut compressed_size: u64,
    mut uncompressed_size: u64,
    mut local_header_offset: u64,
) -> Result<(u64, u64, u64), LocalArchiveReadError> {
    let mut position = 0;
    while position + 4 <= extra.len() {
        let field_id = u16_le(extra, position);
        let field_length = usize::from(u16_le(extra, position + 2));
        position += 4;
        if position + field_length > extra.len() {
            return Err(LocalArchiveReadError::InvalidZip64Member);
        }
        if field_id != 0x0001 {
            position += field_length;
            continue;
        }
        let field = &extra[position..position + field_length];
        let mut value_position = 0;
        let mut take_value = |required: bool, value: &mut u64| -> Result<(), LocalArchiveReadError> {
            if required {
                if value_position + 8 > field.len() {
                    return Err(LocalArchiveReadError::InvalidZip64Member);
                }
                *value = u64_le(field, value_position);
                value_position += 8;
            }
            Ok(())
        };
        take_value(uncompressed_size == u64::from(ZIP64_SENTINEL_U32), &mut uncompressed_size)?;
        take_value(compressed_size == u64::from(ZIP64_SENTINEL_U32), &mut compressed_size)?;
        take_value(local_header_offset == u64::from(ZIP64_SENTINEL_U32), &mut local_header_offset)?;
        return Ok((compressed_size, uncompressed_size, local_header_offset));
    }
    if compressed_size == u64::from(ZIP64_SENTINEL_U32)
        || uncompressed_size == u64::from(ZIP64_SENTINEL_U32)
        || local_header_offset == u64::from(ZIP64_SENTINEL_U32)
    {
        return Err(LocalArchiveReadError::InvalidZip64Member);
    }
    Ok((compressed_size, uncompressed_size, local_header_offset))
}

fn read_local_archive_entries(archive_path: &Path) -> Result<Vec<LocalArchiveReadEntry>, LocalArchiveReadError> {
    let mut reader = LocalArchiveReader::open_pinned(archive_path)?;
    let mut entries = Vec::new();
    while let Some(entry) = reader.next_entry()? {
        entries.push(entry);
    }
    Ok(entries)
}

fn update_crc32(mut state: u32, bytes: &[u8]) -> u32 {
    for byte in bytes {
        state ^= u32::from(*byte);
        for _ in 0..8 {
            state = if state & 1 != 0 { (state >> 1) ^ 0xedb8_8320 } else { state >> 1 };
        }
    }
    state
}

fn copy_member_data(
    reader: &mut impl Read,
    output: &mut impl Write,
    expected_uncompressed_size: u64,
    is_cancelled: &impl Fn() -> bool,
) -> Result<(u64, u32), LocalArchiveReadError> {
    let mut buffer = vec![0; ARCHIVE_COPY_BUFFER_SIZE];
    let mut total = 0_u64;
    let mut crc = u32::MAX;
    loop {
        if is_cancelled() {
            return Err(LocalArchiveReadError::Cancelled);
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok((total, !crc));
        }
        if u64::try_from(read).map_err(|_| LocalArchiveReadError::MemberIntegrityFailure)?
            > expected_uncompressed_size
                .checked_sub(total)
                .ok_or(LocalArchiveReadError::MemberIntegrityFailure)?
        {
            return Err(LocalArchiveReadError::MemberIntegrityFailure);
        }
        if is_cancelled() {
            return Err(LocalArchiveReadError::Cancelled);
        }
        output.write_all(&buffer[..read])?;
        total = total
            .checked_add(read as u64)
            .ok_or(LocalArchiveReadError::MemberIntegrityFailure)?;
        crc = update_crc32(crc, &buffer[..read]);
    }
}

fn copy_deflate_member_data(
    reader: &mut impl Read,
    output: &mut impl Write,
    expected_uncompressed_size: u64,
    is_cancelled: &impl Fn() -> bool,
) -> Result<(u64, u32), LocalArchiveReadError> {
    let mut compressed_buffer = vec![0; ARCHIVE_COPY_BUFFER_SIZE];
    let mut output_buffer = vec![0; ARCHIVE_COPY_BUFFER_SIZE];
    let mut compressed_start = 0;
    let mut compressed_end = 0;
    let mut decompressor = Decompress::new(false);
    let mut total = 0_u64;
    let mut crc = u32::MAX;

    loop {
        if is_cancelled() {
            return Err(LocalArchiveReadError::Cancelled);
        }
        if compressed_start == compressed_end {
            compressed_start = 0;
            compressed_end = reader.read(&mut compressed_buffer)?;
            if compressed_end == 0 {
                return Err(LocalArchiveReadError::MemberIntegrityFailure);
            }
        }
        let total_in = decompressor.total_in();
        let total_out = decompressor.total_out();
        let status = decompressor
            .decompress(
                &compressed_buffer[compressed_start..compressed_end],
                &mut output_buffer,
                FlushDecompress::None,
            )
            .map_err(|_| LocalArchiveReadError::MemberIntegrityFailure)?;
        let consumed = usize::try_from(decompressor.total_in() - total_in).map_err(|_| LocalArchiveReadError::MemberIntegrityFailure)?;
        let produced = usize::try_from(decompressor.total_out() - total_out).map_err(|_| LocalArchiveReadError::MemberIntegrityFailure)?;
        compressed_start = compressed_start
            .checked_add(consumed)
            .filter(|position| *position <= compressed_end)
            .ok_or(LocalArchiveReadError::MemberIntegrityFailure)?;
        if u64::try_from(produced).map_err(|_| LocalArchiveReadError::MemberIntegrityFailure)?
            > expected_uncompressed_size
                .checked_sub(total)
                .ok_or(LocalArchiveReadError::MemberIntegrityFailure)?
        {
            return Err(LocalArchiveReadError::MemberIntegrityFailure);
        }
        if produced > 0 {
            if is_cancelled() {
                return Err(LocalArchiveReadError::Cancelled);
            }
            output.write_all(&output_buffer[..produced])?;
            total = total
                .checked_add(produced as u64)
                .ok_or(LocalArchiveReadError::MemberIntegrityFailure)?;
            crc = update_crc32(crc, &output_buffer[..produced]);
        }
        if status == Status::StreamEnd {
            return Ok((total, !crc));
        }
        if consumed == 0 && produced == 0 {
            return Err(LocalArchiveReadError::MemberIntegrityFailure);
        }
    }
}

pub fn stream_validated_local_archive_entry(
    validated_entry: ValidatedLocalArchiveEntry,
    output: &mut impl Write,
) -> Result<(), LocalArchiveReadError> {
    stream_validated_local_archive_entry_with_cancellation(validated_entry, output, || false)
}

pub fn stream_validated_local_archive_entry_with_cancellation(
    validated_entry: ValidatedLocalArchiveEntry,
    output: &mut impl Write,
    is_cancelled: impl Fn() -> bool,
) -> Result<(), LocalArchiveReadError> {
    let ValidatedLocalArchiveEntry { entry, file } = validated_entry;
    let (written, crc32) = match entry.compression_method {
        0 => {
            let mut reader = file.take(entry.compressed_size);
            copy_member_data(&mut reader, output, entry.uncompressed_size, &is_cancelled)?
        }
        8 => {
            let mut reader = file.take(entry.compressed_size);
            copy_deflate_member_data(&mut reader, output, entry.uncompressed_size, &is_cancelled)?
        }
        12 => {
            let reader = file.take(entry.compressed_size);
            let mut decoder = BzDecoder::new(reader);
            copy_member_data(&mut decoder, output, entry.uncompressed_size, &is_cancelled)?
        }
        _ => return Err(LocalArchiveReadError::UnavailableMember),
    };
    if written != entry.uncompressed_size || crc32 != entry.crc32 {
        return Err(LocalArchiveReadError::MemberIntegrityFailure);
    }
    Ok(())
}

fn ensure_extraction_directory(
    drive_root: &Path,
    destination_path: &Path,
    directory_path: &Path,
) -> Result<LocalArchiveDirectoryOutput, LocalArchiveError> {
    let relative_path = directory_path
        .strip_prefix(destination_path)
        .map_err(|_| LocalArchiveError::TargetOutsideRoot)?;
    let mut created = 0;
    let mut current = destination_path.to_path_buf();
    for segment in relative_path.components() {
        current.push(segment);
        for attempt in 0..=1 {
            match fs::symlink_metadata(&current) {
                Ok(metadata) if metadata.file_type().is_dir() => break,
                Ok(metadata) => {
                    return Ok(LocalArchiveDirectoryOutput::AwaitCollision {
                        target: LocalArchiveConflictTarget::from_metadata(&metadata),
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    revalidate_target_parent(drive_root, &current)?;
                    match fs::create_dir(&current) {
                        Ok(()) => {
                            created += 1;
                            break;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => match fs::symlink_metadata(&current) {
                            Ok(metadata) if metadata.file_type().is_dir() => break,
                            Ok(metadata) => {
                                return Ok(LocalArchiveDirectoryOutput::AwaitCollision {
                                    target: LocalArchiveConflictTarget::from_metadata(&metadata),
                                })
                            }
                            Err(observe_error) if observe_error.kind() == std::io::ErrorKind::NotFound && attempt == 0 => {
                                continue;
                            }
                            Err(_) => return Err(LocalArchiveError::Io(error)),
                        },
                        Err(error) => return Err(LocalArchiveError::Io(error)),
                    }
                }
                Err(error) => return Err(LocalArchiveError::Io(error)),
            }
        }
    }
    Ok(LocalArchiveDirectoryOutput::Ready {
        directories_created: created,
    })
}

/// Create an extraction root when absent, or validate an existing directory.
pub fn create_local_extraction_root(drive_root: &Path, destination_path: &Path) -> Result<bool, LocalArchiveError> {
    for attempt in 0..=1 {
        match fs::symlink_metadata(destination_path) {
            Ok(metadata) => {
                return if metadata.file_type().is_dir() {
                    Ok(false)
                } else {
                    Err(LocalArchiveError::ExtractionTargetExists)
                };
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                revalidate_target_parent(drive_root, destination_path)?;
                match fs::create_dir(destination_path) {
                    Ok(()) => return Ok(true),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => continue,
                    Err(error) => return Err(LocalArchiveError::Io(error)),
                }
            }
            Err(error) => return Err(LocalArchiveError::Io(error)),
        }
    }
    Err(LocalArchiveError::ExtractionTargetExists)
}

/// Create required local descendants under an already-owned extraction root.
pub fn ensure_local_extraction_directory(
    drive_root: &Path,
    destination_path: &Path,
    directory_path: &Path,
) -> Result<LocalArchiveDirectoryOutput, LocalArchiveError> {
    ensure_extraction_directory(drive_root, destination_path, directory_path)
}

/// Open one new local output file after revalidating containment and parents.
pub fn open_local_extraction_file(drive_root: &Path, destination_path: &Path) -> Result<FsFile, LocalArchiveError> {
    revalidate_target_parent(drive_root, destination_path)?;
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination_path)
        .map_err(LocalArchiveError::Io)
}

fn local_archive_target_write_attempt<OpenTarget>(
    open_target: &mut OpenTarget,
    drive_root: &Path,
    destination_path: &Path,
) -> LocalArchiveTargetWriteAttempt
where
    OpenTarget: FnMut(&Path, &Path) -> Result<FsFile, LocalArchiveError>,
{
    match open_target(drive_root, destination_path) {
        Ok(file) => LocalArchiveTargetWriteAttempt::Ready(file),
        Err(LocalArchiveError::Io(error)) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            LocalArchiveTargetWriteAttempt::TargetExistsBeforeContent
        }
        Err(error) => LocalArchiveTargetWriteAttempt::Failure(error),
    }
}

/// Resolve one local extraction target using exclusive creation and one bounded late-race retry.
pub fn prepare_local_archive_target_output(
    drive_root: &Path,
    destination_root: &Path,
    destination_path: &Path,
    policy: LocalArchiveTargetWritePolicy,
    source_modified_at: Option<DateTime<Utc>>,
) -> Result<LocalArchiveTargetOutput, LocalArchiveError> {
    prepare_local_archive_target_output_with_open(
        drive_root,
        destination_root,
        destination_path,
        policy,
        source_modified_at,
        open_local_extraction_file,
    )
}

pub(crate) fn prepare_local_archive_target_output_with_open<OpenTarget>(
    drive_root: &Path,
    destination_root: &Path,
    destination_path: &Path,
    policy: LocalArchiveTargetWritePolicy,
    source_modified_at: Option<DateTime<Utc>>,
    mut open_target: OpenTarget,
) -> Result<LocalArchiveTargetOutput, LocalArchiveError>
where
    OpenTarget: FnMut(&Path, &Path) -> Result<FsFile, LocalArchiveError>,
{
    let parent = destination_path.parent().ok_or(LocalArchiveError::TargetOutsideRoot)?;
    let directories_created = match ensure_extraction_directory(drive_root, destination_root, parent)? {
        LocalArchiveDirectoryOutput::Ready { directories_created } => directories_created,
        LocalArchiveDirectoryOutput::AwaitCollision { target } => return Ok(LocalArchiveTargetOutput::AwaitCollision { target }),
    };
    let mut replaced = false;
    for attempt in 0..=1 {
        let target_metadata = match fs::symlink_metadata(destination_path) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(LocalArchiveError::Io(error)),
        };
        let disposition = resolve_local_archive_target_write(policy, source_modified_at, target_metadata.as_ref());
        match disposition {
            LocalArchiveTargetWriteDisposition::Skip => return Ok(LocalArchiveTargetOutput::Skip),
            LocalArchiveTargetWriteDisposition::AwaitCollision => {
                return Ok(LocalArchiveTargetOutput::AwaitCollision {
                    target: target_metadata
                        .as_ref()
                        .map(LocalArchiveConflictTarget::from_metadata)
                        .unwrap_or_else(LocalArchiveConflictTarget::unavailable),
                })
            }
            LocalArchiveTargetWriteDisposition::ReplaceExisting => {
                let metadata = target_metadata.expect("replace requires an observed target");
                if !metadata.file_type().is_file() {
                    return Ok(LocalArchiveTargetOutput::AwaitCollision {
                        target: LocalArchiveConflictTarget::from_metadata(&metadata),
                    });
                }
                revalidate_target_parent(drive_root, destination_path)?;
                match fs::remove_file(destination_path) {
                    Ok(()) => replaced = true,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound && attempt == 0 => continue,
                    Err(error) => match fs::symlink_metadata(destination_path) {
                        Ok(metadata) if !metadata.file_type().is_file() => {
                            return Ok(LocalArchiveTargetOutput::AwaitCollision {
                                target: LocalArchiveConflictTarget::from_metadata(&metadata),
                            })
                        }
                        _ => return Err(LocalArchiveError::Io(error)),
                    },
                }
            }
            LocalArchiveTargetWriteDisposition::CreateNew => {}
        }
        match local_archive_target_write_attempt(&mut open_target, drive_root, destination_path) {
            LocalArchiveTargetWriteAttempt::Ready(file) => {
                return Ok(LocalArchiveTargetOutput::Ready {
                    file,
                    replaced,
                    directories_created,
                })
            }
            LocalArchiveTargetWriteAttempt::TargetExistsBeforeContent if attempt == 0 => {}
            LocalArchiveTargetWriteAttempt::TargetExistsBeforeContent => {
                let target = match fs::symlink_metadata(destination_path) {
                    Ok(metadata) => LocalArchiveConflictTarget::from_metadata(&metadata),
                    Err(observe_error) if observe_error.kind() == std::io::ErrorKind::NotFound => LocalArchiveConflictTarget::unavailable(),
                    Err(observe_error) => return Err(LocalArchiveError::Io(observe_error)),
                };
                return Ok(LocalArchiveTargetOutput::AwaitCollision { target });
            }
            LocalArchiveTargetWriteAttempt::Failure(error) => return Err(error),
        }
    }
    let target = match fs::symlink_metadata(destination_path) {
        Ok(metadata) => LocalArchiveConflictTarget::from_metadata(&metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => LocalArchiveConflictTarget::unavailable(),
        Err(error) => return Err(LocalArchiveError::Io(error)),
    };
    Ok(LocalArchiveTargetOutput::AwaitCollision { target })
}

/// Reopen the known partial target of a failed member without broad overwrite permission.
#[cfg(test)]
pub fn reopen_partial_local_extraction_file(drive_root: &Path, destination_path: &Path) -> Result<FsFile, LocalArchiveError> {
    revalidate_target_parent(drive_root, destination_path)?;
    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(destination_path)
        .map_err(LocalArchiveError::Io)
}

/// Validate a manifest member path before combining it with a local destination root.
pub fn validate_local_extraction_member_path(member_path: &str, is_directory: bool) -> Result<(), LocalArchiveError> {
    normalized_archive_path(member_path, is_directory).map(|_| ())
}

/// Normalize, validate, and collapse the immutable roots selected for extraction.
pub fn canonicalize_local_archive_member_roots(paths: Option<Vec<String>>) -> Result<Option<Vec<String>>, LocalArchiveError> {
    let Some(paths) = paths else {
        return Ok(None);
    };
    if paths.is_empty() {
        return Err(LocalArchiveError::UnsafeEntryPath);
    }
    let mut roots = Vec::new();
    for path in paths {
        let normalized = normalized_archive_path(&path, false)?;
        if roots
            .iter()
            .any(|root: &String| normalized == *root || normalized.starts_with(&format!("{root}/")))
        {
            continue;
        }
        roots.retain(|root| !root.starts_with(&format!("{normalized}/")));
        roots.push(normalized);
    }
    roots.sort();
    Ok(Some(roots))
}

fn normalized_archive_path(value: &str, is_directory: bool) -> Result<String, LocalArchiveError> {
    let path = value.replace('\\', "/");
    if path.is_empty() || path.starts_with('/') || path.contains('\0') {
        return Err(LocalArchiveError::UnsafeEntryPath);
    }
    let path = path.trim_end_matches('/');
    if path.is_empty()
        || path
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | "..") || segment.contains(':'))
    {
        return Err(LocalArchiveError::UnsafeEntryPath);
    }
    Ok(if is_directory { format!("{path}/") } else { path.to_owned() })
}

fn collision_key(path: &str) -> String {
    path.trim_end_matches('/').nfc().case_fold().collect()
}

fn normalized_source_modified_at(metadata: &fs::Metadata) -> Option<String> {
    metadata
        .modified()
        .ok()
        .map(DateTime::<Utc>::from)
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn normalize_creation_source_modified_at(source_modified_at: Option<String>) -> Result<Option<String>, LocalArchiveError> {
    source_modified_at
        .map(|timestamp| {
            DateTime::parse_from_rfc3339(&timestamp)
                .map(|timestamp| timestamp.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Secs, true))
                .map_err(|_| LocalArchiveError::InvalidCreationOutcome)
        })
        .transpose()
}

fn source_name(path: &Path) -> Result<String, LocalArchiveError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or(LocalArchiveError::UnsafeEntryPath)
}

/// Build a complete recursive manifest from selected local sources.
#[cfg(test)]
pub fn build_local_archive_manifest(source_paths: &[PathBuf], target_path: &Path) -> Result<Vec<LocalArchiveEntry>, LocalArchiveError> {
    build_local_archive_manifest_with_cancellation(source_paths, target_path, || false)
}

/// Build a complete recursive manifest while checking for cooperative cancellation.
pub fn build_local_archive_manifest_with_cancellation(
    source_paths: &[PathBuf],
    target_path: &Path,
    is_cancelled: impl Fn() -> bool,
) -> Result<Vec<LocalArchiveEntry>, LocalArchiveError> {
    if is_cancelled() {
        return Err(LocalArchiveError::Cancelled);
    }
    if target_path.exists() {
        return Err(LocalArchiveError::TargetExists);
    }
    build_local_archive_manifest_inner(source_paths, Some(target_path), &is_cancelled)
}

/// Build a complete recursive manifest for a ZIP target owned by another provider.
pub fn build_local_archive_manifest_for_remote_target(source_paths: &[PathBuf]) -> Result<Vec<LocalArchiveEntry>, LocalArchiveError> {
    build_local_archive_manifest_for_remote_target_with_cancellation(source_paths, || false)
}

pub fn build_local_archive_manifest_for_remote_target_with_cancellation(
    source_paths: &[PathBuf],
    is_cancelled: impl Fn() -> bool,
) -> Result<Vec<LocalArchiveEntry>, LocalArchiveError> {
    build_local_archive_manifest_inner(source_paths, None, &is_cancelled)
}

fn build_local_archive_manifest_inner<F: Fn() -> bool>(
    source_paths: &[PathBuf],
    target_path: Option<&Path>,
    is_cancelled: &F,
) -> Result<Vec<LocalArchiveEntry>, LocalArchiveError> {
    let mut entries = Vec::new();
    let mut names = HashSet::new();

    fn visit<F: Fn() -> bool>(
        source_path: &Path,
        archive_path: &str,
        target_path: Option<&Path>,
        entries: &mut Vec<LocalArchiveEntry>,
        names: &mut HashSet<String>,
        is_cancelled: &F,
    ) -> Result<(), LocalArchiveError> {
        if is_cancelled() {
            return Err(LocalArchiveError::Cancelled);
        }
        let metadata = fs::symlink_metadata(source_path)?;
        let is_directory = metadata.file_type().is_dir();
        if !is_directory && !metadata.file_type().is_file() {
            return Err(LocalArchiveError::UnsupportedSource);
        }
        if is_directory && target_path.is_some_and(|target| target.starts_with(source_path)) {
            return Err(LocalArchiveError::TargetInsideSource);
        }
        let archive_path = normalized_archive_path(archive_path, is_directory)?;
        if !names.insert(collision_key(&archive_path)) {
            return Err(LocalArchiveError::DuplicateEntryPath);
        }
        entries.push(LocalArchiveEntry {
            source_path: source_path.to_owned(),
            archive_path: archive_path.clone(),
            is_directory,
            source_size: if is_directory { 0 } else { metadata.len() },
            source_modified_at: normalized_source_modified_at(&metadata),
        });
        if !is_directory {
            return Ok(());
        }

        let mut children = fs::read_dir(source_path)?.collect::<Result<Vec<_>, _>>()?;
        children.sort_by_key(|child| collision_key(&child.file_name().to_string_lossy()));
        for child in children {
            let child_name = child.file_name().to_string_lossy().into_owned();
            visit(
                &child.path(),
                &format!("{}{child_name}", archive_path),
                target_path,
                entries,
                names,
                is_cancelled,
            )?;
        }
        Ok(())
    }

    for source_path in source_paths {
        visit(
            source_path,
            &source_name(source_path)?,
            target_path,
            &mut entries,
            &mut names,
            is_cancelled,
        )?;
    }
    if entries.is_empty() {
        return Err(LocalArchiveError::UnsupportedSource);
    }
    Ok(entries)
}

/// Project adapter-enumerated local entries into the immutable creation manifest before writing.
pub fn project_local_archive_creation_manifest(entries: &[LocalArchiveEntry]) -> Result<ArchiveCreationManifest, LocalArchiveError> {
    ArchiveCreationManifest::from_entries(
        entries
            .iter()
            .map(|entry| ArchiveCreationManifestMember {
                archive_path: entry.archive_path.clone(),
                is_directory: entry.is_directory,
                source_size: entry.source_size,
                source_modified_at: entry.source_modified_at.clone(),
            })
            .collect(),
    )
}

fn validate_local_archive_manifest_entries(
    entries: &[LocalArchiveEntry],
    manifest: &ArchiveCreationManifest,
) -> Result<(), LocalArchiveError> {
    if entries.len() != manifest.entries.len()
        || entries.iter().zip(&manifest.entries).any(|(entry, member)| {
            entry.archive_path.trim_end_matches('/') != member.archive_path
                || entry.is_directory != member.is_directory
                || entry.source_size != member.source_size
                || entry.source_modified_at != member.source_modified_at
        })
    {
        return Err(LocalArchiveError::InvalidCreationOutcome);
    }
    Ok(())
}

/// Confirm a local creation source still matches its immutable preflight entry.
pub fn revalidate_local_archive_creation_source(entry: &LocalArchiveEntry) -> Result<(), LocalArchiveError> {
    let source_metadata = fs::metadata(&entry.source_path)?;
    if !source_metadata.is_file()
        || source_metadata.len() != entry.source_size
        || normalized_source_modified_at(&source_metadata) != entry.source_modified_at
    {
        return Err(LocalArchiveError::ArchiveSourceChanged);
    }
    Ok(())
}

/// Create a ZIP directly at a previously non-existent local output path.
#[cfg(test)]
pub fn create_local_archive(
    drive_root: &Path,
    target_path: &Path,
    entries: &[LocalArchiveEntry],
    is_cancelled: impl Fn() -> bool,
) -> Result<LocalArchiveCreationResult, LocalArchiveError> {
    create_local_archive_with_cancellation_and_progress(drive_root, target_path, entries, is_cancelled, |_| {})
}

/// Create a local ZIP while publishing committed source-member progress.
#[cfg(test)]
pub fn create_local_archive_with_cancellation_and_progress(
    drive_root: &Path,
    target_path: &Path,
    entries: &[LocalArchiveEntry],
    is_cancelled: impl Fn() -> bool,
    on_progress: impl FnMut(LocalArchiveCreationResult),
) -> Result<LocalArchiveCreationResult, LocalArchiveError> {
    create_local_archive_with_cancellation_progress_and_state(drive_root, target_path, entries, is_cancelled, on_progress)
        .map(|(result, _state)| result)
}

/// Create a local ZIP while retaining its immutable manifest and outcome ledger.
#[cfg(test)]
pub fn create_local_archive_with_cancellation_progress_and_state(
    drive_root: &Path,
    target_path: &Path,
    entries: &[LocalArchiveEntry],
    is_cancelled: impl Fn() -> bool,
    on_progress: impl FnMut(LocalArchiveCreationResult),
) -> Result<(LocalArchiveCreationResult, ArchiveCreationManifestState), LocalArchiveError> {
    create_local_archive_with_execution_plan_progress_and_state(
        drive_root,
        target_path,
        entries,
        LocalArchiveCreationExecutionPlan::from_entries(entries)?,
        is_cancelled,
        on_progress,
    )
}

/// Create a local ZIP from one immutable preflight execution plan.
pub fn create_local_archive_with_execution_plan_progress_and_state(
    drive_root: &Path,
    target_path: &Path,
    entries: &[LocalArchiveEntry],
    execution_plan: LocalArchiveCreationExecutionPlan,
    is_cancelled: impl Fn() -> bool,
    on_progress: impl FnMut(LocalArchiveCreationResult),
) -> Result<(LocalArchiveCreationResult, ArchiveCreationManifestState), LocalArchiveError> {
    if target_path.exists() {
        return Err(LocalArchiveError::TargetExists);
    }
    revalidate_target_parent(drive_root, target_path)?;
    let output = OpenOptions::new().write(true).create_new(true).open(target_path)?;
    let (result, state) = write_local_archive_stream_with_execution_plan(output, entries, execution_plan, &is_cancelled, on_progress)
        .map_err(|error| match error {
            LocalArchiveError::Cancelled => LocalArchiveError::Cancelled,
            LocalArchiveError::ArchiveSourceChanged => LocalArchiveError::ArchiveSourceChanged,
            error => LocalArchiveError::PartialArchiveOutput(Box::new(error)),
        })?;
    if is_cancelled() {
        return Err(LocalArchiveError::Cancelled);
    }
    read_local_archive_entries(target_path).map_err(|error| LocalArchiveError::PartialArchiveOutput(Box::new(error.into())))?;
    Ok((result, state))
}

pub fn create_temporary_local_archive(
    entries: &[LocalArchiveEntry],
    size_limit: u64,
    is_cancelled: impl Fn() -> bool,
) -> Result<(tempfile::TempDir, PathBuf), LocalArchiveError> {
    create_temporary_local_archive_with_directory(entries, size_limit, is_cancelled, || {
        create_private_temporary_directory(TEMPORARY_DOWNLOAD_PREFIX)
    })
}

fn create_temporary_local_archive_with_directory(
    entries: &[LocalArchiveEntry],
    size_limit: u64,
    is_cancelled: impl Fn() -> bool,
    create_directory: impl FnOnce() -> Result<tempfile::TempDir, std::io::Error>,
) -> Result<(tempfile::TempDir, PathBuf), LocalArchiveError> {
    let execution_plan = LocalArchiveCreationExecutionPlan::from_entries(entries)?;
    let directory = create_directory()?;
    let path = directory.path().join("download.zip");
    let output = create_private_temporary_file(&path)?;
    let output = SizeLimitedArchiveWriter::new(output, size_limit);
    write_local_archive_stream_with_execution_plan(output, entries, execution_plan, &is_cancelled, |_| {})?;
    if is_cancelled() {
        return Err(LocalArchiveError::Cancelled);
    }
    read_local_archive_entries(&path)?;
    Ok((directory, path))
}

fn create_private_temporary_file(path: &Path) -> Result<FsFile, std::io::Error> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path)
}

fn create_private_temporary_directory(prefix: &str) -> Result<tempfile::TempDir, std::io::Error> {
    let store = prepare_temporary_archive_store()?;
    create_private_temporary_directory_in_store(&store, prefix)
}

fn create_private_temporary_directory_in_store(store: &Path, prefix: &str) -> Result<tempfile::TempDir, std::io::Error> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(prefix);
    #[cfg(unix)]
    builder.permissions(fs::Permissions::from_mode(0o700));
    builder.tempdir_in(store)
}

fn prepare_temporary_archive_store() -> Result<PathBuf, std::io::Error> {
    let store = std::env::temp_dir().join(TEMPORARY_ARCHIVE_DIRECTORY);
    #[cfg(unix)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    match builder.create(&store) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(&store)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::other("Temporary archive store is not a private directory"));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(std::io::Error::other("Temporary archive store permissions are not private"));
    }
    Ok(store)
}

fn cleanup_stale_temporary_archive_directories(store: &Path) -> Result<(), std::io::Error> {
    for entry in fs::read_dir(store)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(TEMPORARY_DOWNLOAD_PREFIX) && !name.starts_with(TEMPORARY_SOURCE_PREFIX) {
            continue;
        }
        let metadata = match fs::symlink_metadata(entry.path()) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if metadata.file_type().is_dir()
            && SystemTime::now().duration_since(metadata.modified()?).unwrap_or_default() > TEMPORARY_ARCHIVE_MAX_AGE
        {
            match fs::remove_dir_all(entry.path()) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

pub fn cleanup_stale_temporary_archive_downloads() -> Result<(), std::io::Error> {
    cleanup_stale_temporary_archive_directories(&prepare_temporary_archive_store()?)
}

pub fn create_temporary_local_zip_selection(
    archive_path: &Path,
    selected_paths: &[String],
    size_limit: u64,
    is_cancelled: impl Fn() -> bool,
) -> Result<(tempfile::TempDir, PathBuf), LocalArchiveError> {
    if is_cancelled() {
        return Err(LocalArchiveError::Cancelled);
    }
    let roots = canonicalize_local_archive_member_roots(Some(selected_paths.to_vec()))?.ok_or(LocalArchiveError::UnsafeEntryPath)?;
    if roots.len() != selected_paths.len() {
        return Err(LocalArchiveError::UnsafeEntryPath);
    }
    let parent = roots[0].rsplit_once('/').map_or("", |(parent, _)| parent);
    if roots
        .iter()
        .any(|root| root.rsplit_once('/').map_or("", |(parent, _)| parent) != parent)
    {
        return Err(LocalArchiveError::UnsafeEntryPath);
    }
    let mut reader = LocalArchiveReader::open_pinned(archive_path)?;
    let projection = reader.effective_projection()?;
    if projection.skipped_entries != 0 {
        return Err(LocalArchiveError::UnsafeEntryPath);
    }
    for root in &roots {
        if !projection.member_by_path.contains_key(root) && !projection.directories.contains(root) {
            return Err(LocalArchiveError::UnknownExtractionMember);
        }
    }
    let is_selected = |path: &str| roots.iter().any(|root| path == root || path.starts_with(&format!("{root}/")));
    let staging = create_private_temporary_directory(TEMPORARY_SOURCE_PREFIX)?;
    let mut entries = Vec::new();
    let mut source_bytes = 0u64;
    for entry in projection.entries.iter().filter(|entry| is_selected(&entry.path)) {
        if is_cancelled() {
            return Err(LocalArchiveError::Cancelled);
        }
        let relative_path = entry.path.strip_prefix(parent).unwrap_or(&entry.path).trim_start_matches('/');
        let archive_path = normalized_archive_path(relative_path, entry.is_directory)?;
        let source_path = if entry.is_directory {
            staging.path().to_path_buf()
        } else {
            source_bytes = source_bytes
                .checked_add(entry.uncompressed_size)
                .filter(|size| *size <= size_limit)
                .ok_or_else(|| LocalArchiveError::Io(std::io::Error::other(TEMPORARY_ARCHIVE_SIZE_LIMIT_EXCEEDED)))?;
            let path = staging.path().join(format!("{}.source", uuid::Uuid::new_v4()));
            let mut output = create_private_temporary_file(&path)?;
            stream_validated_local_archive_entry_with_cancellation(reader.validate_entry(entry.clone())?, &mut output, &is_cancelled)
                .map_err(|error| match error {
                    LocalArchiveReadError::Cancelled => LocalArchiveError::Cancelled,
                    LocalArchiveReadError::SourceChanged => LocalArchiveError::ArchiveSourceChanged,
                    LocalArchiveReadError::Io(io_error) => LocalArchiveError::Io(io_error),
                    error => LocalArchiveError::ArchiveRead(error),
                })?;
            let modified_at = entry
                .modified_at
                .map(SystemTime::from)
                .unwrap_or(SystemTime::UNIX_EPOCH + Duration::from_secs(ZIP_DOS_EPOCH_SECONDS));
            output.set_times(fs::FileTimes::new().set_modified(modified_at))?;
            path
        };
        let metadata = fs::metadata(&source_path)?;
        entries.push(LocalArchiveEntry {
            source_path,
            archive_path,
            is_directory: entry.is_directory,
            source_size: if entry.is_directory { 0 } else { entry.uncompressed_size },
            source_modified_at: if entry.is_directory {
                entry
                    .modified_at
                    .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Secs, true))
            } else {
                normalized_source_modified_at(&metadata)
            },
        });
    }
    for directory in projection.directories.iter().filter(|path| is_selected(path)) {
        if entries.iter().any(|entry| {
            entry.is_directory
                && entry.archive_path.trim_end_matches('/') == directory.strip_prefix(parent).unwrap_or(directory).trim_start_matches('/')
        }) {
            continue;
        }
        let archive_path = normalized_archive_path(directory.strip_prefix(parent).unwrap_or(directory).trim_start_matches('/'), true)?;
        entries.push(LocalArchiveEntry {
            source_path: staging.path().to_path_buf(),
            archive_path,
            is_directory: true,
            source_size: 0,
            source_modified_at: projection
                .entries
                .iter()
                .find(|entry| entry.path.starts_with(&format!("{directory}/")))
                .and_then(|entry| entry.modified_at)
                .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Secs, true)),
        });
    }
    entries.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    create_temporary_local_archive(&entries, size_limit, is_cancelled)
}

/// Write a portable ZIP while retaining the immutable manifest and committed outcomes.
/// Write a portable ZIP from a preflight manifest and its local source adapter entries.
#[cfg(test)]
pub fn write_local_archive_stream_with_manifest<W: Write>(
    output: W,
    entries: &[LocalArchiveEntry],
    manifest: ArchiveCreationManifest,
    is_cancelled: impl Fn() -> bool,
    on_progress: impl FnMut(LocalArchiveCreationResult),
) -> Result<(LocalArchiveCreationResult, ArchiveCreationManifestState), LocalArchiveError> {
    write_local_archive_stream_with_execution_plan(
        output,
        entries,
        LocalArchiveCreationExecutionPlan::from_manifest(manifest),
        is_cancelled,
        on_progress,
    )
}

/// Write a portable ZIP from an immutable execution plan and local source adapter entries.
pub fn write_local_archive_stream_with_execution_plan<W: Write>(
    output: W,
    entries: &[LocalArchiveEntry],
    execution_plan: LocalArchiveCreationExecutionPlan,
    is_cancelled: impl Fn() -> bool,
    mut on_progress: impl FnMut(LocalArchiveCreationResult),
) -> Result<(LocalArchiveCreationResult, ArchiveCreationManifestState), LocalArchiveError> {
    validate_local_archive_manifest_entries(entries, &execution_plan.manifest)?;
    (|| {
        let started_at = Instant::now();
        let metrics = ArchiveWriteMetrics::default();
        let output = MeasuredWriter {
            inner: output,
            metrics: metrics.clone(),
        };
        let mut writer = ZipWriter::new_stream(BufWriter::with_capacity(ARCHIVE_WRITE_BUFFER_SIZE, output));
        let mut state = execution_plan.into_state();
        let manifest_entries = state.manifest.entries.clone();
        let mut buffer = vec![0; ARCHIVE_COPY_BUFFER_SIZE];

        on_progress(state.progress()?);

        for (entry, manifest_entry) in entries.iter().zip(&manifest_entries) {
            if is_cancelled() {
                return Err(LocalArchiveError::Cancelled);
            }
            if entry.is_directory {
                writer.add_directory(
                    normalized_archive_path(&manifest_entry.archive_path, true)?,
                    source_timestamp_options(directory_options(), manifest_entry.source_modified_at.as_deref())?,
                )?;
                state.record_expected(&manifest_entry.archive_path)?;
                on_progress(state.progress()?);
                continue;
            }
            revalidate_local_archive_creation_source(entry)?;
            let mut source = FsFile::open(&entry.source_path)?;
            let probe_size = source.read(&mut buffer)?;
            if probe_size as u64 > manifest_entry.source_size {
                return Err(LocalArchiveError::InvalidCreationOutcome);
            }
            writer.start_file(
                normalized_archive_path(&manifest_entry.archive_path, false)?,
                source_timestamp_options(
                    regular_file_options(&buffer[..probe_size])?,
                    manifest_entry.source_modified_at.as_deref(),
                )?,
            )?;
            writer.write_all(&buffer[..probe_size])?;
            let mut source_bytes = probe_size as u64;
            loop {
                if is_cancelled() {
                    return Err(LocalArchiveError::Cancelled);
                }
                let read = source.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                if read as u64 > manifest_entry.source_size.saturating_sub(source_bytes) {
                    return Err(LocalArchiveError::InvalidCreationOutcome);
                }
                writer.write_all(&buffer[..read])?;
                source_bytes = source_bytes
                    .checked_add(read as u64)
                    .ok_or_else(|| LocalArchiveError::Io(std::io::Error::other("Archive source size overflow")))?;
            }
            if source_bytes != manifest_entry.source_size {
                return Err(LocalArchiveError::InvalidCreationOutcome);
            }
            state.record_expected(&manifest_entry.archive_path)?;
            on_progress(state.progress()?);
        }

        let mut output = writer.finish()?;
        output.flush()?;
        let result = state.terminal_summary()?;
        info!(
            "archive_metrics operation=archive_creation duration_ms={} entry_count={} physical_write_bytes={} physical_write_operations={}",
            started_at.elapsed().as_millis(),
            manifest_entries.len(),
            metrics.bytes.load(Ordering::Relaxed),
            metrics.operations.load(Ordering::Relaxed),
        );
        Ok((result, state))
    })()
}

fn directory_options() -> SimpleFileOptions {
    SimpleFileOptions::default().compression_method(CompressionMethod::Stored)
}

/// Encode UTC clock fields, not host-local time, in the timezone-free DOS timestamp.
fn source_timestamp_options(options: SimpleFileOptions, modified_at: Option<&str>) -> Result<SimpleFileOptions, LocalArchiveError> {
    let Some(modified_at) = modified_at else {
        return Ok(options);
    };
    let timestamp = DateTime::parse_from_rfc3339(modified_at)
        .map_err(|_| LocalArchiveError::InvalidCreationOutcome)?
        .with_timezone(&Utc);
    if timestamp.year() < ZIP_MIN_YEAR {
        return Ok(options);
    }
    let timestamp = zip::DateTime::from_date_and_time(
        timestamp.year().min(ZIP_MAX_YEAR) as u16,
        timestamp.month() as u8,
        timestamp.day() as u8,
        timestamp.hour() as u8,
        timestamp.minute() as u8,
        timestamp.second() as u8,
    )
    .map_err(|_| LocalArchiveError::InvalidCreationOutcome)?;
    Ok(options.last_modified_time(timestamp))
}

fn regular_file_options(probe: &[u8]) -> Result<SimpleFileOptions, LocalArchiveError> {
    let method = if should_store(probe)? {
        CompressionMethod::Stored
    } else {
        CompressionMethod::Deflated
    };
    Ok(SimpleFileOptions::default()
        .compression_method(method)
        .compression_level((method == CompressionMethod::Deflated).then_some(6)))
}

fn should_store(probe: &[u8]) -> Result<bool, LocalArchiveError> {
    if probe.is_empty() {
        return Ok(true);
    }
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(probe)?;
    let compressed_size = encoder.finish()?.len();
    let savings = probe.len().saturating_sub(compressed_size);
    Ok(savings < STORED_SAVINGS_BYTES && (savings as f64 / probe.len() as f64) < STORED_SAVINGS_RATIO)
}

type CompressionProbe = (Vec<u8>, Option<Vec<u8>>, bool);

fn receive_compression_probe(chunks: &mut Receiver<LocalArchiveRelayChunk>) -> Result<CompressionProbe, LocalArchiveError> {
    let mut probe = Vec::with_capacity(ARCHIVE_COPY_BUFFER_SIZE);
    while probe.len() < ARCHIVE_COPY_BUFFER_SIZE {
        match chunks.blocking_recv() {
            Some(LocalArchiveRelayChunk::Data(chunk)) => {
                if chunk.len() > ARCHIVE_COPY_BUFFER_SIZE {
                    return Err(LocalArchiveError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Archive source relay chunk exceeds the configured bound",
                    )));
                }
                let remaining = ARCHIVE_COPY_BUFFER_SIZE - probe.len();
                if chunk.len() <= remaining {
                    probe.extend_from_slice(&chunk);
                    continue;
                }
                probe.extend_from_slice(&chunk[..remaining]);
                return Ok((probe, Some(chunk[remaining..].to_vec()), false));
            }
            Some(LocalArchiveRelayChunk::Complete) => return Ok((probe, None, true)),
            Some(LocalArchiveRelayChunk::Failed) => {
                return Err(LocalArchiveError::Io(std::io::Error::other("Archive source relay failed")));
            }
            None => {
                return Err(LocalArchiveError::Io(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "Archive source relay ended before completion",
                )));
            }
        }
    }
    Ok((probe, None, false))
}

/// Create a new local ZIP target that receives source bytes through bounded relay channels.
pub fn create_local_archive_relay_writer(
    drive_root: &Path,
    target_path: &Path,
    manifest: ArchiveCreationManifest,
) -> Result<LocalArchiveRelayWriter, LocalArchiveError> {
    if target_path.exists() {
        return Err(LocalArchiveError::TargetExists);
    }
    revalidate_target_parent(drive_root, target_path)?;
    let output = OpenOptions::new().write(true).create_new(true).open(target_path)?;
    let metrics = ArchiveWriteMetrics::default();
    let output = MeasuredWriter {
        inner: output,
        metrics: metrics.clone(),
    };
    Ok(LocalArchiveRelayWriter {
        writer: ZipWriter::new_stream(BufWriter::with_capacity(ARCHIVE_WRITE_BUFFER_SIZE, output)),
        manifest,
        next_manifest_index: 0,
        metrics,
        started_at: Instant::now(),
    })
}

impl LocalArchiveRelayWriter {
    fn next_manifest_entry(&self, archive_path: &str, is_directory: bool) -> Result<ArchiveCreationManifestMember, LocalArchiveError> {
        let normalized_path = normalized_archive_path(archive_path, is_directory)?
            .trim_end_matches('/')
            .to_string();
        let entry = self
            .manifest
            .entries
            .get(self.next_manifest_index)
            .filter(|entry| entry.archive_path == normalized_path && entry.is_directory == is_directory)
            .ok_or(LocalArchiveError::InvalidCreationOutcome)?;
        Ok(entry.clone())
    }

    /// Add one explicit directory entry to the local ZIP.
    pub fn add_directory(mut self, archive_path: &str) -> Result<Self, LocalArchiveError> {
        let entry = self.next_manifest_entry(archive_path, true)?;
        if entry.source_size != 0 {
            return Err(LocalArchiveError::InvalidCreationOutcome);
        }
        (|| {
            self.writer.add_directory(
                normalized_archive_path(&entry.archive_path, true)?,
                source_timestamp_options(directory_options(), entry.source_modified_at.as_deref())?,
            )?;
            self.next_manifest_index += 1;
            Ok(self)
        })()
        .map_err(|error| LocalArchiveError::PartialArchiveOutput(Box::new(error)))
    }

    /// Write one regular member from a bounded asynchronous-relay channel.
    pub fn write_file(mut self, archive_path: &str, mut chunks: Receiver<LocalArchiveRelayChunk>) -> Result<Self, LocalArchiveError> {
        let entry = self.next_manifest_entry(archive_path, false)?;
        let expected_size = entry.source_size;
        (|| {
            let (probe, pending_chunk, source_completed) = receive_compression_probe(&mut chunks)?;
            if probe.len() as u64 > expected_size {
                return Err(LocalArchiveError::InvalidCreationOutcome);
            }
            self.writer.start_file(
                normalized_archive_path(&entry.archive_path, false)?,
                source_timestamp_options(regular_file_options(&probe)?, entry.source_modified_at.as_deref())?,
            )?;
            self.writer.write_all(&probe)?;
            let mut written = probe.len() as u64;
            if let Some(chunk) = pending_chunk {
                if chunk.len() as u64 > expected_size.saturating_sub(written) {
                    return Err(LocalArchiveError::InvalidCreationOutcome);
                }
                self.writer.write_all(&chunk)?;
                written = written
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| LocalArchiveError::Io(std::io::Error::other("Archive source size overflow")))?;
            }
            if !source_completed {
                loop {
                    match chunks.blocking_recv() {
                        Some(LocalArchiveRelayChunk::Data(chunk)) => {
                            if chunk.len() as u64 > expected_size.saturating_sub(written) {
                                return Err(LocalArchiveError::InvalidCreationOutcome);
                            }
                            self.writer.write_all(&chunk)?;
                            written = written
                                .checked_add(chunk.len() as u64)
                                .ok_or_else(|| LocalArchiveError::Io(std::io::Error::other("Archive source size overflow")))?;
                        }
                        Some(LocalArchiveRelayChunk::Complete) => break,
                        Some(LocalArchiveRelayChunk::Failed) => {
                            return Err(LocalArchiveError::Io(std::io::Error::other("Archive source relay failed")));
                        }
                        None => {
                            return Err(LocalArchiveError::Io(std::io::Error::new(
                                std::io::ErrorKind::UnexpectedEof,
                                "Archive source relay ended before completion",
                            )));
                        }
                    }
                }
            }
            if written != expected_size {
                return Err(LocalArchiveError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Archive source size does not match its manifest",
                )));
            }
            self.next_manifest_index += 1;
            Ok(self)
        })()
        .map_err(|error| LocalArchiveError::PartialArchiveOutput(Box::new(error)))
    }

    /// Finalize the ZIP central directory after all manifest members commit.
    pub fn finish(self) -> Result<(), LocalArchiveError> {
        if self.next_manifest_index != self.manifest.entries.len() {
            return Err(LocalArchiveError::InvalidCreationOutcome);
        }
        (|| {
            let mut output = self.writer.finish()?;
            output.flush()?;
            info!(
                "archive_metrics operation=archive_creation_relay duration_ms={} entry_count={} physical_write_bytes={} physical_write_operations={}",
                self.started_at.elapsed().as_millis(),
                self.manifest.entries.len(),
                self.metrics.bytes.load(Ordering::Relaxed),
                self.metrics.operations.load(Ordering::Relaxed),
            );
            Ok(())
        })()
        .map_err(|error| LocalArchiveError::PartialArchiveOutput(Box::new(error)))
    }
}

fn revalidate_target_parent(drive_root: &Path, target_path: &Path) -> Result<(), LocalArchiveError> {
    let canonical_root = fs::canonicalize(drive_root)?;
    let parent = target_path.parent().ok_or(LocalArchiveError::TargetOutsideRoot)?;
    let canonical_parent = fs::canonicalize(parent)?;
    if !canonical_parent.starts_with(canonical_root) {
        return Err(LocalArchiveError::TargetOutsideRoot);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::io::{Read, Write};
    use std::rc::Rc;
    use std::time::SystemTime;

    use flate2::read::DeflateDecoder;
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use tempfile::tempdir;
    use zip::ZipArchive;

    use super::*;

    #[test]
    fn dos_member_timestamps_use_utc() {
        for month in [1, 7] {
            let date = ((2026 - 1980) << 9) | (month << 5) | 15;
            let time = (11 << 11) | (52 << 5) | 1;
            let expected = DateTime::parse_from_rfc3339(&format!("2026-{month:02}-15T11:52:02Z"))
                .expect("test timestamp must be valid")
                .with_timezone(&Utc);
            assert_eq!(dos_datetime(date, time), Some(expected));
        }
        assert_eq!(dos_datetime(0, 0), None);
    }

    #[test]
    fn temporary_archive_writer_rejects_chunks_before_exceeding_limit() {
        let mut output = SizeLimitedArchiveWriter::new(Vec::new(), 5);
        output.write_all(b"hello").unwrap();
        let error = output.write_all(b"!").unwrap_err();
        assert_eq!(error.to_string(), TEMPORARY_ARCHIVE_SIZE_LIMIT_EXCEEDED);
        assert_eq!(output.inner, b"hello");
    }

    #[test]
    fn temporary_archive_cleanup_removes_only_stale_owned_directories() {
        let store = tempdir().unwrap();
        let stale = store.path().join(format!("{TEMPORARY_DOWNLOAD_PREFIX}stale"));
        let recent = store.path().join(format!("{TEMPORARY_SOURCE_PREFIX}recent"));
        let unrelated = store.path().join("other-directory");
        for path in [&stale, &recent, &unrelated] {
            fs::create_dir(path).unwrap();
        }
        set_test_path_modified_time(&stale, SystemTime::now() - TEMPORARY_ARCHIVE_MAX_AGE - Duration::from_secs(1));
        cleanup_stale_temporary_archive_directories(store.path()).unwrap();
        assert!(!stale.exists());
        assert!(recent.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn temporary_directory_creation_does_not_clean_other_downloads() {
        let store = tempdir().unwrap();
        let stale = store.path().join(format!("{TEMPORARY_DOWNLOAD_PREFIX}stale"));
        fs::create_dir(&stale).unwrap();
        set_test_path_modified_time(&stale, SystemTime::now() - TEMPORARY_ARCHIVE_MAX_AGE - Duration::from_secs(1));

        for prefix in [TEMPORARY_DOWNLOAD_PREFIX, TEMPORARY_SOURCE_PREFIX] {
            let directory = create_private_temporary_directory_in_store(store.path(), prefix).unwrap();
            assert!(directory.path().is_dir());
            assert!(stale.is_dir());
        }

        cleanup_stale_temporary_archive_directories(store.path()).unwrap();
        assert!(!stale.exists());
    }

    #[test]
    fn temporary_archive_validates_output_and_enforces_cap() {
        let corpus_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../archive-contract/v2/fixtures/temporary-download-scenarios-v2.json");
        let corpus: serde_json::Value = serde_json::from_slice(&fs::read(corpus_path).unwrap()).unwrap();
        let scenario = &corpus["physical_selection"];
        let source = tempdir().unwrap();
        fs::create_dir_all(source.path().join("parent/folder/empty")).unwrap();
        fs::write(source.path().join("parent/file.txt"), scenario["file_contents"].as_str().unwrap()).unwrap();
        let roots: Vec<PathBuf> = scenario["roots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|root| source.path().join(root.as_str().unwrap()))
            .collect();
        let entries = build_local_archive_manifest_for_remote_target(&roots).unwrap();
        let (directory, path) = create_temporary_local_archive(&entries, 1024 * 1024, || false).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(directory.path()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let mut zip = ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
        let mut actual_paths: Vec<_> = zip
            .file_names()
            .map(|name| name.map(|name| name.into_owned()))
            .collect::<Result<_, _>>()
            .unwrap();
        actual_paths.sort();
        let mut expected_paths: Vec<_> = scenario["expected_paths"]
            .as_array()
            .unwrap()
            .iter()
            .map(|path| path.as_str().unwrap().to_owned())
            .collect();
        expected_paths.sort();
        assert_eq!(actual_paths, expected_paths);
        let mut content = String::new();
        zip.by_name(scenario["file_path"].as_str().unwrap())
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, scenario["file_contents"].as_str().unwrap());
        drop(zip);
        drop(directory);
        assert!(!path.exists());

        let error = create_temporary_local_archive(&entries, scenario["reject_limit_bytes"].as_u64().unwrap(), || false).unwrap_err();
        assert!(error.to_string().contains(TEMPORARY_ARCHIVE_SIZE_LIMIT_EXCEEDED), "{error}");

        let store = tempdir().unwrap();
        let owned_artifact_count = || {
            fs::read_dir(store.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with(TEMPORARY_DOWNLOAD_PREFIX))
                .count()
        };
        assert!(matches!(
            create_temporary_local_archive_with_directory(
                &entries,
                1024 * 1024,
                || scenario["cancel_before_write"].as_bool().unwrap(),
                || tempfile::Builder::new().prefix(TEMPORARY_DOWNLOAD_PREFIX).tempdir_in(store.path()),
            ),
            Err(LocalArchiveError::Cancelled)
        ));
        assert_eq!(
            owned_artifact_count(),
            scenario["expected_artifacts_after_cancel"].as_u64().unwrap() as usize
        );
    }

    #[test]
    fn temporary_local_zip_selection_preserves_selected_roots_and_implicit_directories() {
        let source = tempdir().unwrap();
        let archive_path = source.path().join("source.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&archive_path).unwrap());
        let options = source_timestamp_options(SimpleFileOptions::default(), Some("2026-01-15T11:52:02Z")).unwrap();
        writer.add_directory("parent/empty/", options).unwrap();
        writer.start_file("parent/folder/report.txt", options).unwrap();
        writer.write_all(b"report").unwrap();
        writer.finish().unwrap();

        let (directory, output_path) = create_temporary_local_zip_selection(
            &archive_path,
            &["parent/empty".to_string(), "parent/folder".to_string()],
            1024 * 1024,
            || false,
        )
        .unwrap();
        let mut output = ZipArchive::new(fs::File::open(&output_path).unwrap()).unwrap();
        assert_eq!(output.len(), 3);
        assert!(output.by_name("empty/").is_ok());
        assert!(output.by_name("folder/").is_ok());
        for name in ["empty/", "folder/", "folder/report.txt"] {
            let timestamp = output.by_name(name).unwrap().last_modified().unwrap();
            assert_eq!(timestamp, zip::DateTime::from_date_and_time(2026, 1, 15, 11, 52, 2).unwrap());
        }
        let mut content = String::new();
        output.by_name("folder/report.txt").unwrap().read_to_string(&mut content).unwrap();
        assert_eq!(content, "report");
        drop(output);
        drop(directory);
        assert!(!output_path.exists());

        let error = create_temporary_local_zip_selection(&archive_path, &["parent/folder".to_string()], 2, || false).unwrap_err();
        assert!(error.to_string().contains(TEMPORARY_ARCHIVE_SIZE_LIMIT_EXCEEDED));
        assert!(matches!(
            create_temporary_local_zip_selection(&archive_path, &["parent/folder".to_string()], 1024 * 1024, || true),
            Err(LocalArchiveError::Cancelled)
        ));
    }

    #[test]
    fn temporary_local_zip_selection_rejects_missing_and_unsafe_members() {
        let source = tempdir().unwrap();
        let archive_path = source.path().join("source.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&archive_path).unwrap());
        writer.start_file("safe.txt", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"safe").unwrap();
        writer.start_file("../unsafe.txt", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"unsafe").unwrap();
        writer.finish().unwrap();

        assert!(matches!(
            create_temporary_local_zip_selection(&archive_path, &["safe.txt".to_string()], 1024, || false),
            Err(LocalArchiveError::UnsafeEntryPath)
        ));
        let clean_path = source.path().join("clean.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&clean_path).unwrap());
        writer.start_file("safe.txt", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"safe").unwrap();
        writer.finish().unwrap();
        assert!(matches!(
            create_temporary_local_zip_selection(&clean_path, &["missing.txt".to_string()], 1024, || false),
            Err(LocalArchiveError::UnknownExtractionMember)
        ));
        assert!(matches!(
            create_temporary_local_zip_selection(&clean_path, &["safe.txt".to_string(), "safe.txt".to_string()], 1024, || false),
            Err(LocalArchiveError::UnsafeEntryPath)
        ));
    }

    fn set_test_path_modified_time(path: &std::path::Path, modified_at: SystemTime) {
        filetime::set_file_mtime(path, filetime::FileTime::from_system_time(modified_at)).expect("test path timestamp should be set");
    }

    #[derive(Deserialize)]
    struct ConformanceManifest {
        version: u8,
        fixtures: Vec<ConformanceFixture>,
    }

    #[derive(Deserialize)]
    struct ConformanceFixture {
        name: String,
        sha256: String,
        entries: Vec<ConformanceEntry>,
        expected_error: Option<String>,
    }

    #[derive(Deserialize)]
    struct ConformanceEntry {
        raw_name_hex: String,
        path: String,
        directory: bool,
        method: u16,
        uncompressed_size: u64,
        safe: bool,
        data_descriptor: bool,
        member_sha256: Option<String>,
    }

    #[derive(Deserialize)]
    struct CompatibilityRecoveryCorpus {
        version: u8,
        fixtures: Vec<CompatibilityRecoveryFixture>,
    }

    #[derive(Deserialize)]
    struct CompatibilityRecoveryFixture {
        name: String,
        sha256: String,
        members: Vec<CompatibilityRecoveryMember>,
    }

    #[derive(Deserialize)]
    struct CompatibilityRecoveryMember {
        raw_name_hex: String,
        path: String,
        method: u16,
        outcome: String,
        member_sha256: Option<String>,
    }

    #[derive(Default)]
    struct CountingWrite {
        write_calls: Rc<Cell<usize>>,
    }

    impl Write for CountingWrite {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.write_calls.set(self.write_calls.get() + 1);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[derive(Deserialize)]
    struct TargetWriteConformanceCorpus {
        version: u8,
        scenarios: Vec<TargetWriteConformanceScenario>,
        attempt_scenarios: Vec<TargetWriteAttemptConformanceScenario>,
        live_relay_collision_policy_aliases: Vec<LiveRelayCollisionPolicyAlias>,
    }

    #[derive(Deserialize)]
    struct LiveRelayCollisionPolicyAlias {
        wire_value: Option<String>,
        expected_policy: String,
    }

    #[derive(Deserialize)]
    struct TargetWriteConformanceScenario {
        name: String,
        phase: Option<String>,
        attempt_ordinal: Option<u8>,
        policy: String,
        source_modified_at: Option<String>,
        target: String,
        target_modified_at: Option<String>,
        expected: String,
    }

    #[derive(Deserialize)]
    struct TargetWriteAttemptConformanceScenario {
        name: String,
        policy: String,
        source_modified_at: Option<String>,
        steps: Vec<TargetWriteAttemptConformanceStep>,
        expected: String,
        expected_attempts: u8,
        expected_stream_polls: u8,
    }

    #[derive(Clone, Deserialize)]
    struct TargetWriteAttemptConformanceStep {
        kind: String,
        target: Option<String>,
        result: Option<String>,
        target_modified_at: Option<String>,
    }

    #[derive(Deserialize)]
    struct CreationOutcomeConformanceCorpus {
        version: u8,
        #[serde(default)]
        manifest_scenarios: Vec<CreationManifestConformanceScenario>,
        #[serde(default)]
        terminal_scenarios: Vec<CreationTerminalConformanceScenario>,
        scenarios: Vec<CreationOutcomeConformanceScenario>,
    }

    #[derive(Deserialize)]
    struct CreationManifestConformanceScenario {
        name: String,
        entries: Vec<CreationManifestConformanceEntry>,
        normalized_entries: Option<Vec<CreationManifestConformanceEntry>>,
        progress: Option<std::collections::HashMap<String, u64>>,
        error: Option<String>,
    }

    #[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
    struct CreationManifestConformanceEntry {
        archive_path: String,
        is_directory: bool,
        source_size: u64,
    }

    #[derive(Deserialize)]
    struct CreationTerminalConformanceScenario {
        name: String,
        entries: Vec<CreationManifestConformanceEntry>,
        result_reports: Vec<CreationOutcomeResultReport>,
        progress: Option<std::collections::HashMap<String, u64>>,
        error: Option<String>,
    }

    #[derive(Deserialize)]
    struct CreationOutcomeConformanceScenario {
        name: String,
        result_reports: Vec<CreationOutcomeResultReport>,
        member_outcomes: Option<std::collections::HashMap<String, CreationOutcomeExpected>>,
        progress: Option<std::collections::HashMap<String, u64>>,
        error: Option<String>,
    }

    #[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
    struct CreationOutcomeResultReport {
        archive_path: String,
        status: String,
        source_bytes: u64,
    }

    #[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
    struct CreationOutcomeExpected {
        status: String,
        source_bytes: u64,
    }

    #[derive(Deserialize)]
    struct CreationTrajectoryConformanceCorpus {
        version: u8,
        topologies: Vec<String>,
        scenarios: Vec<CreationTrajectoryConformanceScenario>,
    }

    #[derive(Deserialize)]
    struct CreationTrajectoryConformanceScenario {
        name: String,
        entries: Vec<CreationManifestConformanceEntry>,
        steps: Vec<CreationTrajectoryStep>,
        terminal_phase: String,
        completed_members: Vec<String>,
        progress: std::collections::HashMap<String, u64>,
    }

    #[derive(Deserialize)]
    struct CreationTrajectoryStep {
        event: String,
        archive_path: Option<String>,
        status: Option<String>,
        #[serde(default)]
        source_bytes: u64,
    }

    fn conformance_corpus_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join("archive_testdata")
    }

    fn compatibility_recovery_corpus_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("archive-contract/v2/fixtures/zip-compatibility-recovery.json")
    }

    #[test]
    fn rejects_unsafe_archive_entry_paths() {
        assert!(matches!(
            normalized_archive_path("../unsafe", false),
            Err(LocalArchiveError::UnsafeEntryPath)
        ));
        assert!(matches!(
            normalized_archive_path("C:/unsafe", false),
            Err(LocalArchiveError::UnsafeEntryPath)
        ));
    }

    #[test]
    fn uses_validated_infozip_unicode_path_for_unflagged_names() {
        let raw_name = b"cafe.txt";
        let unicode_name = "café.txt";
        let field_length = u16::try_from(1 + 4 + unicode_name.len()).unwrap();
        let mut extra = Vec::new();
        extra.extend_from_slice(&INFOZIP_UNICODE_PATH_FIELD_ID.to_le_bytes());
        extra.extend_from_slice(&field_length.to_le_bytes());
        extra.push(INFOZIP_UNICODE_PATH_VERSION);
        extra.extend_from_slice(&(!update_crc32(u32::MAX, raw_name)).to_le_bytes());
        extra.extend_from_slice(unicode_name.as_bytes());

        assert_eq!(decode_entry_name(raw_name, 0, &extra), unicode_name);
    }

    #[test]
    fn ignores_infozip_unicode_path_with_a_mismatched_crc() {
        let raw_name = b"cafe.txt";
        let unicode_name = "café.txt";
        let field_length = u16::try_from(1 + 4 + unicode_name.len()).unwrap();
        let mut extra = Vec::new();
        extra.extend_from_slice(&INFOZIP_UNICODE_PATH_FIELD_ID.to_le_bytes());
        extra.extend_from_slice(&field_length.to_le_bytes());
        extra.push(INFOZIP_UNICODE_PATH_VERSION);
        extra.extend_from_slice(&(!update_crc32(u32::MAX, raw_name) ^ 1).to_le_bytes());
        extra.extend_from_slice(unicode_name.as_bytes());

        assert_eq!(decode_entry_name(raw_name, 0, &extra), "cafe.txt");
    }

    #[test]
    fn decodes_unflagged_legacy_names_as_cp437() {
        assert_eq!(decode_entry_name(b"caf\x82.txt", 0, &[]), "café.txt");
    }

    #[test]
    fn passes_shared_zip_compatibility_recovery_corpus() {
        let corpus: CompatibilityRecoveryCorpus = serde_json::from_slice(&fs::read(compatibility_recovery_corpus_path()).unwrap()).unwrap();
        assert_eq!(corpus.version, 1);

        for fixture in corpus.fixtures {
            let fixture_path = conformance_corpus_root().join(&fixture.name);
            let fixture_bytes = fs::read(&fixture_path).unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(&fixture_bytes)), fixture.sha256);
            let mut reader = LocalArchiveReader::open_pinned(&fixture_path).unwrap();
            for expected in fixture.members {
                let entry = reader.next_entry().unwrap().expect("fixture member should exist");
                assert_eq!(
                    entry.raw_name.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
                    expected.raw_name_hex
                );
                assert_eq!(entry.path, expected.path);
                assert_eq!(entry.compression_method, expected.method);
                let mut output = Vec::new();
                let result = reader.stream_entry(entry, &mut output);
                if expected.outcome == "accepted" {
                    result.unwrap();
                    assert_eq!(
                        format!("{:x}", Sha256::digest(&output)),
                        expected.member_sha256.expect("accepted member hash should exist")
                    );
                } else {
                    assert!(result.is_err());
                }
            }
            assert!(reader.next_entry().unwrap().is_none());
        }
    }

    #[test]
    fn companion_owned_member_delivery_reports_compatibility_recovery_outcomes() {
        let accepted_source = LocalArchiveInspectionSource::from_archive_path(conformance_corpus_root().join("compat-deflate-padding.zip"));
        let accepted_plan = ArchiveInspectionPlan::from_local_source(
            accepted_source,
            ArchiveInspectionPresentation::MemberRead(ArchiveMemberReadPresentation::new("deflate-padding.txt".to_string(), true)),
        )
        .unwrap();
        let (accepted_projection, accepted_member) = ArchiveInspectionCoordinator::from_plan(accepted_plan)
            .validated_member_read()
            .unwrap();
        assert_eq!(accepted_projection.member_path, "deflate-padding.txt");
        let mut accepted_output = Vec::new();
        stream_validated_local_archive_entry(accepted_member.unwrap(), &mut accepted_output).unwrap();
        assert_eq!(accepted_output, b"verified compatibility payload");

        let rejected_source =
            LocalArchiveInspectionSource::from_archive_path(conformance_corpus_root().join("compat-truncated-deflate.zip"));
        let rejected_plan = ArchiveInspectionPlan::from_local_source(
            rejected_source,
            ArchiveInspectionPresentation::MemberRead(ArchiveMemberReadPresentation::new("truncated-deflate.txt".to_string(), true)),
        )
        .unwrap();
        let (_, rejected_member) = ArchiveInspectionCoordinator::from_plan(rejected_plan)
            .validated_member_read()
            .unwrap();
        assert!(stream_validated_local_archive_entry(rejected_member.unwrap(), &mut Vec::new()).is_err());
    }

    #[test]
    fn recovers_malformed_utf8_flagged_names_with_replacement() {
        assert_eq!(decode_entry_name(b"bad\xff.txt", 0x0800, &[]), "bad�.txt");
        assert_eq!(
            collision_key(&decode_entry_name(b"bad\xff.txt", 0x0800, &[])),
            collision_key("bad�.txt")
        );
    }

    #[test]
    fn streams_verified_compressed_member_with_trailing_data() {
        fn stream_member(compression_method: u16, compressed: Vec<u8>, expected: &[u8]) -> Result<Vec<u8>, LocalArchiveReadError> {
            let mut source = tempfile::NamedTempFile::new()?;
            source.write_all(&compressed)?;
            source.flush()?;
            let entry = LocalArchiveReadEntry {
                path: "data.txt".to_string(),
                is_directory: false,
                compressed_size: compressed.len() as u64,
                uncompressed_size: expected.len() as u64,
                compression_method,
                crc32: !update_crc32(u32::MAX, expected),
                modified_at: None,
                encrypted: false,
                is_safe: true,
                has_supported_file_type: true,
                local_header_offset: 0,
                flags: 0,
                raw_name: b"data.txt".to_vec(),
            };
            let mut output = Vec::new();
            stream_validated_local_archive_entry(
                ValidatedLocalArchiveEntry {
                    entry,
                    file: source.reopen()?,
                },
                &mut output,
            )?;
            Ok(output)
        }

        let expected = b"verified compatibility payload";
        let mut deflate_encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        deflate_encoder.write_all(expected).unwrap();
        let deflate = deflate_encoder.finish().unwrap();
        let mut deflate_with_padding = deflate.clone();
        deflate_with_padding.extend_from_slice(b"producer padding");
        assert_eq!(stream_member(8, deflate_with_padding, expected).unwrap(), expected);
        let mut second_deflate_encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        second_deflate_encoder.write_all(b"second member stream").unwrap();
        let mut deflate_with_second_stream = deflate;
        deflate_with_second_stream.extend_from_slice(&second_deflate_encoder.finish().unwrap());
        assert_eq!(stream_member(8, deflate_with_second_stream, expected).unwrap(), expected);

        let mut bzip2_encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
        bzip2_encoder.write_all(expected).unwrap();
        let bzip2 = bzip2_encoder.finish().unwrap();
        let mut bzip2_with_padding = bzip2.clone();
        bzip2_with_padding.extend_from_slice(b"producer padding");
        assert_eq!(stream_member(12, bzip2_with_padding, expected).unwrap(), expected);
        let mut second_bzip2_encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
        second_bzip2_encoder.write_all(b"second member stream").unwrap();
        let mut bzip2_with_second_stream = bzip2;
        bzip2_with_second_stream.extend_from_slice(&second_bzip2_encoder.finish().unwrap());
        assert_eq!(stream_member(12, bzip2_with_second_stream, expected).unwrap(), expected);
    }

    #[test]
    fn rejects_truncated_compressed_members() {
        fn stream_member(compression_method: u16, compressed: Vec<u8>) -> Result<(), LocalArchiveReadError> {
            let expected = b"verified compatibility payload";
            let mut source = tempfile::NamedTempFile::new()?;
            source.write_all(&compressed)?;
            source.flush()?;
            let entry = LocalArchiveReadEntry {
                path: "data.txt".to_string(),
                is_directory: false,
                compressed_size: compressed.len() as u64,
                uncompressed_size: expected.len() as u64,
                compression_method,
                crc32: !update_crc32(u32::MAX, expected),
                modified_at: None,
                encrypted: false,
                is_safe: true,
                has_supported_file_type: true,
                local_header_offset: 0,
                flags: 0,
                raw_name: b"data.txt".to_vec(),
            };
            stream_validated_local_archive_entry(
                ValidatedLocalArchiveEntry {
                    entry,
                    file: source.reopen()?,
                },
                &mut Vec::new(),
            )
        }

        let expected = b"verified compatibility payload";
        let mut deflate_encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        deflate_encoder.write_all(expected).unwrap();
        let mut deflate = deflate_encoder.finish().unwrap();
        deflate.pop();
        assert!(stream_member(8, deflate).is_err());

        let mut bzip2_encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
        bzip2_encoder.write_all(expected).unwrap();
        let mut bzip2 = bzip2_encoder.finish().unwrap();
        bzip2.pop();
        assert!(stream_member(12, bzip2).is_err());
    }

    #[test]
    fn pinned_reader_returns_entries_in_central_directory_order() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("ordered.zip");
        let mut archive = ZipWriter::new(FsFile::create(&archive_path).unwrap());
        archive.start_file("first.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"first").unwrap();
        archive.start_file("second.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"second").unwrap();
        archive.finish().unwrap();
        let mut reader = LocalArchiveReader::open_pinned(&archive_path).unwrap();

        let first = reader.next_entry().unwrap().unwrap();
        let second = reader.next_entry().unwrap().unwrap();

        let mut contents = Vec::new();
        reader.stream_entry(first.clone(), &mut contents).unwrap();

        assert_eq!(first.path, "first.txt");
        assert_eq!(contents, b"first");
        assert_eq!(second.path, "second.txt");
        assert!(reader.next_entry().unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn pinned_reader_rejects_a_source_changed_after_open() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("changed.zip");
        let mut archive = ZipWriter::new(FsFile::create(&archive_path).unwrap());
        archive.start_file("first.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"first").unwrap();
        archive.finish().unwrap();
        let mut reader = LocalArchiveReader::open_pinned(&archive_path).unwrap();

        fs::write(&archive_path, b"replacement archive contents").unwrap();

        assert!(matches!(reader.next_entry(), Err(LocalArchiveReadError::SourceChanged)));
    }

    #[cfg(unix)]
    #[test]
    fn pinned_reader_reports_source_change_after_a_failed_stream() {
        struct SourceChangingWrite {
            archive_path: std::path::PathBuf,
        }

        impl Write for SourceChangingWrite {
            fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
                fs::write(&self.archive_path, b"replacement archive contents")?;
                Ok(buffer.len())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("changed-during-stream.zip");
        let mut archive = ZipWriter::new(FsFile::create(&archive_path).unwrap());
        archive
            .start_file(
                "entry.txt",
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
            )
            .unwrap();
        archive.write_all(b"member payload").unwrap();
        archive.finish().unwrap();
        let mut archive_bytes = fs::read(&archive_path).unwrap();
        let payload_offset = archive_bytes
            .windows(b"member payload".len())
            .position(|bytes| bytes == b"member payload")
            .unwrap();
        archive_bytes[payload_offset] ^= 1;
        fs::write(&archive_path, archive_bytes).unwrap();
        let mut reader = LocalArchiveReader::open_pinned(&archive_path).unwrap();
        let entry = reader.next_entry().unwrap().unwrap();
        let mut output = SourceChangingWrite {
            archive_path: archive_path.clone(),
        };

        assert!(matches!(
            reader.stream_entry(entry, &mut output),
            Err(LocalArchiveReadError::SourceChanged)
        ));
    }

    #[test]
    fn passes_v2_zip_reader_conformance_corpus() {
        let corpus_root = conformance_corpus_root();
        let manifest: ConformanceManifest = serde_json::from_slice(&fs::read(corpus_root.join("manifest-v2.json")).unwrap()).unwrap();
        assert_eq!(manifest.version, 2);

        for fixture in manifest.fixtures {
            let fixture_path = corpus_root.join(&fixture.name);
            let fixture_data = fs::read(&fixture_path).unwrap();
            assert_eq!(hex::encode(Sha256::digest(fixture_data)), fixture.sha256);
            if fixture.expected_error.as_deref() == Some("format_error") {
                assert!(matches!(
                    LocalArchiveReader::open_pinned(&fixture_path),
                    Err(LocalArchiveReadError::TooSmall | LocalArchiveReadError::InvalidEndOfDirectory)
                ));
                continue;
            }
            let mut reader = LocalArchiveReader::open_pinned(&fixture_path).unwrap();
            for expected in fixture.entries {
                let entry = reader.next_entry().unwrap().unwrap();
                assert_eq!(hex::encode(&entry.raw_name), expected.raw_name_hex);
                assert_eq!(entry.path, expected.path);
                assert_eq!(entry.is_directory, expected.directory);
                assert_eq!(entry.compression_method, expected.method);
                assert_eq!(entry.uncompressed_size, expected.uncompressed_size);
                assert_eq!(entry.is_safe, expected.safe);
                assert_eq!(entry.flags & 0x0008 != 0, expected.data_descriptor);
                if expected.safe {
                    if let Some(member_sha256) = expected.member_sha256 {
                        let mut member = Vec::new();
                        reader.stream_entry(entry, &mut member).unwrap();
                        assert_eq!(hex::encode(Sha256::digest(member)), member_sha256);
                    }
                }
            }
            assert!(reader.next_entry().unwrap().is_none());
        }
    }

    #[test]
    fn rejects_oversized_member_data_before_writing_for_supported_codecs() {
        fn assert_oversized(reader: impl Read) {
            let mut output = Vec::new();
            assert!(matches!(
                copy_member_data(&mut std::io::BufReader::new(reader), &mut output, 1, &|| false),
                Err(LocalArchiveReadError::MemberIntegrityFailure)
            ));
            assert!(output.is_empty());
        }

        assert_oversized(std::io::Cursor::new(b"oversized"));

        let mut deflate_encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        deflate_encoder.write_all(b"oversized").unwrap();
        assert_oversized(DeflateDecoder::new(std::io::Cursor::new(deflate_encoder.finish().unwrap())));

        let mut bzip2_encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
        bzip2_encoder.write_all(b"oversized").unwrap();
        assert_oversized(BzDecoder::new(std::io::Cursor::new(bzip2_encoder.finish().unwrap())));
    }

    #[test]
    fn writes_directory_manifest_to_a_readable_zip() {
        let directory = tempdir().unwrap();
        let source_root = directory.path().join("source");
        fs::create_dir_all(source_root.join("empty")).unwrap();
        fs::write(source_root.join("notes.txt"), b"notes").unwrap();
        let target = directory.path().join("archive.zip");
        let entries = build_local_archive_manifest(&[source_root], &target).unwrap();

        let result = create_local_archive(directory.path(), &target, &entries, || false).unwrap();

        assert_eq!(result.files_created, 1);
        assert_eq!(result.directories_created, 2);
        assert_eq!(read_local_archive_entries(&target).unwrap().len(), 3);
        let mut archive = ZipArchive::new(FsFile::open(&target).unwrap()).unwrap();
        assert_eq!(
            archive.file_names().collect::<Result<Vec<_>, _>>().unwrap(),
            ["source/", "source/empty/", "source/notes.txt"]
        );
        let mut notes = String::new();
        archive.by_name("source/notes.txt").unwrap().read_to_string(&mut notes).unwrap();
        assert_eq!(notes, "notes");
    }

    #[test]
    fn streams_unicode_writer_output_through_the_local_reader() {
        let directory = tempdir().unwrap();
        let source_root = directory.path().join("source");
        let member_name = "caf\u{00e9}.txt";
        let content = "archive contents".repeat(ARCHIVE_COPY_BUFFER_SIZE);
        fs::create_dir(&source_root).unwrap();
        fs::write(source_root.join(member_name), &content).unwrap();
        let target = directory.path().join("archive.zip");
        let entries = build_local_archive_manifest(&[source_root], &target).unwrap();

        create_local_archive(directory.path(), &target, &entries, || false).unwrap();

        let mut reader = LocalArchiveReader::open_pinned(&target).unwrap();
        let root = reader.next_entry().unwrap().unwrap();
        assert!(root.is_directory);
        let member = reader.next_entry().unwrap().unwrap();
        assert_eq!(member.path, format!("source/{member_name}"));
        assert_eq!(member.compression_method, 8);
        let mut actual = Vec::new();
        reader.stream_entry(member, &mut actual).unwrap();
        assert_eq!(actual, content.as_bytes());
        assert!(reader.next_entry().unwrap().is_none());
    }

    #[test]
    fn streams_zip64_directory_count_above_the_classic_limit() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("archive.zip");
        let mut writer = ZipWriter::new_stream(BufWriter::new(FsFile::create(&target).unwrap()));
        let entry_count = u64::from(ZIP64_SENTINEL_U16) + 1;
        for index in 0..entry_count {
            writer.add_directory(format!("directory-{index}/"), directory_options()).unwrap();
        }
        writer.finish().unwrap().flush().unwrap();

        let mut reader = LocalArchiveReader::open_pinned(&target).unwrap();
        for index in 0..entry_count {
            let entry = reader.next_entry().unwrap().unwrap();
            assert!(entry.is_directory);
            assert_eq!(entry.path, format!("directory-{index}"));
        }
        assert!(reader.next_entry().unwrap().is_none());
    }

    #[test]
    fn cancels_manifest_enumeration_before_traversing_sources() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source");
        fs::create_dir(&source).unwrap();
        let target = directory.path().join("archive.zip");
        let cancellation_checks = std::cell::Cell::new(0);

        assert!(matches!(
            build_local_archive_manifest_with_cancellation(&[source], &target, || {
                let checks = cancellation_checks.get() + 1;
                cancellation_checks.set(checks);
                checks >= 2
            }),
            Err(LocalArchiveError::Cancelled)
        ));
        assert!(!target.exists());
    }

    #[test]
    fn writes_relayed_members_to_a_readable_zip_without_staging() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("archive.zip");
        let manifest = ArchiveCreationManifest::from_entries(vec![
            ArchiveCreationManifestMember {
                archive_path: "empty".to_string(),
                is_directory: true,
                source_size: 0,
                source_modified_at: Some("2024-07-15T13:52:02+02:00".to_string()),
            },
            ArchiveCreationManifestMember {
                archive_path: "notes.txt".to_string(),
                is_directory: false,
                source_size: 5,
                source_modified_at: Some("2026-01-15T13:52:02+02:00".to_string()),
            },
        ])
        .unwrap();
        let writer = create_local_archive_relay_writer(directory.path(), &target, manifest)
            .unwrap()
            .add_directory("empty")
            .unwrap();
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        sender.try_send(LocalArchiveRelayChunk::Data(b"notes".to_vec())).unwrap();
        sender.try_send(LocalArchiveRelayChunk::Complete).unwrap();
        writer.write_file("notes.txt", receiver).unwrap().finish().unwrap();
        let mut archive = ZipArchive::new(FsFile::open(&target).unwrap()).unwrap();
        let mut notes = String::new();
        archive.by_name("notes.txt").unwrap().read_to_string(&mut notes).unwrap();
        assert_eq!(notes, "notes");
        let mut reader = LocalArchiveReader::open_pinned(&target).unwrap();
        let directory_entry = reader.next_entry().unwrap().unwrap();
        assert_eq!(directory_entry.modified_at.unwrap().to_rfc3339(), "2024-07-15T11:52:02+00:00");
        let entry = reader.next_entry().unwrap().unwrap();
        assert_eq!(entry.modified_at.unwrap().to_rfc3339(), "2026-01-15T11:52:02+00:00");
        let mut contents = Vec::new();
        reader.stream_entry(entry, &mut contents).unwrap();
        assert_eq!(contents, b"notes");
        assert_eq!(
            LocalArchiveReader::open_pinned(&target)
                .unwrap()
                .next_entry()
                .unwrap()
                .unwrap()
                .compression_method,
            0
        );
    }

    #[test]
    fn deflates_compressible_relayed_members() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("archive.zip");
        let content = vec![b'x'; ARCHIVE_COPY_BUFFER_SIZE];
        let manifest = ArchiveCreationManifest::from_entries(vec![ArchiveCreationManifestMember {
            archive_path: "notes.txt".to_string(),
            is_directory: false,
            source_size: content.len() as u64,
            source_modified_at: None,
        }])
        .unwrap();
        let writer = create_local_archive_relay_writer(directory.path(), &target, manifest).unwrap();
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        sender.try_send(LocalArchiveRelayChunk::Data(content.clone())).unwrap();
        sender.try_send(LocalArchiveRelayChunk::Complete).unwrap();

        writer.write_file("notes.txt", receiver).unwrap().finish().unwrap();

        let mut reader = LocalArchiveReader::open_pinned(&target).unwrap();
        let entry = reader.next_entry().unwrap().unwrap();
        let mut contents = Vec::new();
        reader.stream_entry(entry, &mut contents).unwrap();
        assert_eq!(contents, content);

        assert_eq!(
            LocalArchiveReader::open_pinned(&target)
                .unwrap()
                .next_entry()
                .unwrap()
                .unwrap()
                .compression_method,
            8
        );
    }

    #[test]
    fn rejects_relay_members_that_do_not_match_the_preflight_manifest() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("archive.zip");
        let manifest = ArchiveCreationManifest::from_entries(vec![ArchiveCreationManifestMember {
            archive_path: "notes.txt".to_string(),
            is_directory: false,
            source_size: 0,
            source_modified_at: None,
        }])
        .unwrap();
        let writer = create_local_archive_relay_writer(directory.path(), &target, manifest).unwrap();
        let (_sender, receiver) = tokio::sync::mpsc::channel(1);

        assert!(matches!(
            writer.write_file("unexpected.txt", receiver),
            Err(LocalArchiveError::InvalidCreationOutcome)
        ));
    }

    #[test]
    fn rejects_oversized_relay_members_before_writing_member_data() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("archive.zip");
        let manifest = ArchiveCreationManifest::from_entries(vec![ArchiveCreationManifestMember {
            archive_path: "notes.txt".to_string(),
            is_directory: false,
            source_size: 1,
            source_modified_at: None,
        }])
        .unwrap();
        let writer = create_local_archive_relay_writer(directory.path(), &target, manifest).unwrap();
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        sender
            .try_send(LocalArchiveRelayChunk::Data(vec![b'x'; ARCHIVE_COPY_BUFFER_SIZE]))
            .unwrap();

        assert!(matches!(
            writer.write_file("notes.txt", receiver),
            Err(LocalArchiveError::PartialArchiveOutput(_))
        ));
        assert!(!fs::read(target)
            .unwrap()
            .windows(b"notes.txt".len())
            .any(|window| window == b"notes.txt"));
    }

    #[test]
    fn rejects_colliding_relay_manifest_before_opening_output() {
        assert!(matches!(
            ArchiveCreationManifest::from_entries(vec![
                ArchiveCreationManifestMember {
                    archive_path: "folder".to_string(),
                    is_directory: false,
                    source_size: 1,
                    source_modified_at: None,
                },
                ArchiveCreationManifestMember {
                    archive_path: "folder/child.txt".to_string(),
                    is_directory: false,
                    source_size: 1,
                    source_modified_at: None,
                },
            ]),
            Err(LocalArchiveError::DuplicateEntryPath)
        ));
    }

    #[test]
    fn reopens_only_an_existing_partial_extraction_file() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("partial.txt");
        fs::write(&target, b"partial output").unwrap();

        let mut output = reopen_partial_local_extraction_file(directory.path(), &target).unwrap();
        output.write_all(b"complete").unwrap();
        output.flush().unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"complete");
        assert!(reopen_partial_local_extraction_file(directory.path(), &directory.path().join("missing.txt")).is_err());
    }

    #[test]
    fn reports_partial_archive_output_after_source_read_failure() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("archive.zip");
        let entries = [LocalArchiveEntry {
            source_path: directory.path().join("missing.txt"),
            archive_path: "missing.txt".to_string(),
            is_directory: false,
            source_size: 0,
            source_modified_at: None,
        }];

        assert!(matches!(
            create_local_archive(directory.path(), &target, &entries, || false),
            Err(LocalArchiveError::PartialArchiveOutput(_))
        ));
        assert!(target.is_file());
    }

    #[test]
    fn rejects_a_creation_source_that_changed_after_manifest_construction() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.txt");
        let target = directory.path().join("archive.zip");
        fs::write(&source, b"source").unwrap();
        let entries = build_local_archive_manifest(std::slice::from_ref(&source), &target).unwrap();
        fs::write(&source, b"changed source").unwrap();

        assert!(matches!(
            create_local_archive(directory.path(), &target, &entries, || false),
            Err(LocalArchiveError::ArchiveSourceChanged)
        ));
        assert!(target.is_file());
    }

    #[test]
    fn rejects_local_source_entries_that_do_not_match_the_preflight_manifest() {
        let entries = [LocalArchiveEntry {
            source_path: PathBuf::from("source.txt"),
            archive_path: "source.txt".to_string(),
            is_directory: false,
            source_size: 1,
            source_modified_at: None,
        }];
        let manifest = ArchiveCreationManifest::from_entries(vec![ArchiveCreationManifestMember {
            archive_path: "different.txt".to_string(),
            is_directory: false,
            source_size: 1,
            source_modified_at: None,
        }])
        .unwrap();

        assert!(matches!(
            write_local_archive_stream_with_manifest(Vec::new(), &entries, manifest, || false, |_| {}),
            Err(LocalArchiveError::InvalidCreationOutcome)
        ));
    }

    #[test]
    fn cancels_archive_creation_before_finalization() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.txt");
        fs::write(&source, b"source").unwrap();
        let target = directory.path().join("archive.zip");
        let entries = build_local_archive_manifest(&[source], &target).unwrap();
        let cancellation_checks = std::cell::Cell::new(0);

        assert!(matches!(
            create_local_archive(directory.path(), &target, &entries, || {
                let checks = cancellation_checks.get() + 1;
                cancellation_checks.set(checks);
                checks >= 3
            }),
            Err(LocalArchiveError::Cancelled)
        ));
        assert!(target.is_file());
    }

    #[test]
    fn publishes_creation_progress_and_preserves_cancellation() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("source.txt");
        fs::write(&source, b"source").unwrap();
        let target = directory.path().join("archive.zip");
        let entries = build_local_archive_manifest(&[source], &target).unwrap();
        let mut progress = Vec::new();

        let result = create_local_archive_with_cancellation_and_progress(
            directory.path(),
            &target,
            &entries,
            || false,
            |update| progress.push(update),
        )
        .unwrap();

        assert_eq!(
            progress.first(),
            Some(&LocalArchiveCreationResult {
                files_created: 0,
                directories_created: 0,
                source_bytes: 0
            })
        );
        assert_eq!(progress.last(), Some(&result));

        let cancelled_target = directory.path().join("cancelled.zip");
        assert!(matches!(
            create_local_archive_with_cancellation_and_progress(directory.path(), &cancelled_target, &entries, || true, |_| {},),
            Err(LocalArchiveError::Cancelled)
        ));
        assert!(cancelled_target.is_file());
    }

    #[test]
    fn lists_projected_archive_root_and_nested_directory() {
        let directory = tempdir().unwrap();
        let source_root = directory.path().join("source");
        fs::create_dir_all(source_root.join("nested/empty")).unwrap();
        fs::write(source_root.join("alpha.txt"), b"alpha").unwrap();
        fs::write(source_root.join("nested/beta.txt"), b"beta").unwrap();
        let modified_at = DateTime::parse_from_rfc3339("2026-07-15T11:52:02Z").unwrap().with_timezone(&Utc);
        for path in [
            source_root.clone(),
            source_root.join("alpha.txt"),
            source_root.join("nested"),
            source_root.join("nested/beta.txt"),
            source_root.join("nested/empty"),
        ] {
            set_test_path_modified_time(&path, modified_at.into());
        }
        let target = directory.path().join("archive.zip");
        let entries = build_local_archive_manifest(&[source_root], &target).unwrap();
        create_local_archive(directory.path(), &target, &entries, || false).unwrap();

        let inspection = ArchiveInspectionCoordinator::from_plan(
            ArchiveInspectionPlan::from_local_source(
                LocalArchiveInspectionSource::from_archive_path(target.clone()),
                ArchiveInspectionPresentation::DirectoryListing(ArchiveDirectoryListingPresentation::new(
                    "archive.zip".to_string(),
                    0,
                    None,
                    String::new(),
                    None,
                    1,
                )),
            )
            .unwrap(),
        );
        let first_page = inspection.directory_listing().unwrap();
        assert_eq!(first_page.items.len(), 1);
        assert_eq!(first_page.items[0].file_type, FileType::Directory);
        assert_eq!(first_page.items[0].state, ArchiveEntryState::Readable);
        assert_eq!(first_page.items[0].modified_at, Some(modified_at));
        assert!(first_page.next_cursor.is_none());

        let nested_page = ArchiveInspectionCoordinator::from_plan(
            ArchiveInspectionPlan::from_local_source(
                LocalArchiveInspectionSource::from_archive_path(target.clone()),
                ArchiveInspectionPresentation::DirectoryListing(ArchiveDirectoryListingPresentation::new(
                    "archive.zip".to_string(),
                    0,
                    None,
                    first_page.items[0].path.clone(),
                    None,
                    10,
                )),
            )
            .unwrap(),
        )
        .directory_listing()
        .unwrap();
        assert_eq!(nested_page.path, first_page.items[0].path);
        assert!(nested_page.items.iter().all(|entry| entry.modified_at == Some(modified_at)));
        assert_eq!(
            nested_page
                .items
                .iter()
                .map(|item| (item.name.as_str(), &item.file_type))
                .collect::<Vec<_>>(),
            vec![("alpha.txt", &FileType::File), ("nested", &FileType::Directory)]
        );
        assert_eq!(
            nested_page.items.iter().find(|item| item.name == "nested").map(|item| &item.state),
            Some(&ArchiveEntryState::Readable)
        );
    }

    #[test]
    fn large_archive_members_can_be_previewed() {
        const LARGE_MEMBER_TEST_BYTES: usize = 6 * 1024 * 1024;
        let directory = tempdir().unwrap();
        let target = directory.path().join("archive.zip");
        let content = vec![b'x'; LARGE_MEMBER_TEST_BYTES];
        let mut archive = ZipWriter::new(FsFile::create(&target).unwrap());
        archive
            .start_file("large.pdf", regular_file_options(&content[..ARCHIVE_COPY_BUFFER_SIZE]).unwrap())
            .unwrap();
        archive.write_all(&content).unwrap();
        archive.finish().unwrap();

        let mut reader = LocalArchiveReader::open_pinned(&target).unwrap();
        let page = reader.directory_page("", None, 10).unwrap();
        let listing = ArchiveDirectoryListingPresentation::new("archive.zip".to_string(), 0, None, String::new(), None, 10).present(page);
        assert_eq!(listing.items[0].state, ArchiveEntryState::Readable);

        let mut reader = LocalArchiveReader::open_pinned(&target).unwrap();
        let member = find_local_archive_member(&mut reader, "large.pdf").unwrap();
        for size in [0, LARGE_MEMBER_TEST_BYTES as u64, u64::MAX] {
            let mut entry = member.clone();
            entry.uncompressed_size = size;
            for method in [0, 8, 12, 99] {
                entry.compression_method = method;
                let page = LocalArchiveDirectoryPage {
                    path: String::new(),
                    entries: vec![local_directory_entry(&entry)],
                    next_cursor: None,
                };
                let listing =
                    ArchiveDirectoryListingPresentation::new("archive.zip".to_string(), 0, None, String::new(), None, 10).present(page);
                assert_eq!(
                    listing.items[0].state,
                    if method == 99 {
                        ArchiveEntryState::Unavailable
                    } else {
                        ArchiveEntryState::Readable
                    }
                );
            }
            entry.encrypted = true;
            let page = LocalArchiveDirectoryPage {
                path: String::new(),
                entries: vec![local_directory_entry(&entry)],
                next_cursor: None,
            };
            let listing =
                ArchiveDirectoryListingPresentation::new("archive.zip".to_string(), 0, None, String::new(), None, 10).present(page);
            assert_eq!(listing.items[0].state, ArchiveEntryState::Blocked);
        }
        assert_eq!(
            ArchiveMemberReadPresentation::new("large.pdf".to_string(), false)
                .present(&member)
                .unwrap()
                .delivery,
            ArchiveMemberReadDelivery::Stream
        );
        assert_eq!(
            ArchiveMemberReadPresentation::new("large.pdf".to_string(), true)
                .present(&member)
                .unwrap()
                .delivery,
            ArchiveMemberReadDelivery::Stream
        );
        let mut output = Vec::new();
        reader.stream_entry(member, &mut output).unwrap();
        assert_eq!(output, content);
    }

    #[test]
    fn lists_synthesized_archive_directory_as_readable() {
        let directory = tempdir().unwrap();
        let archive_path = directory.path().join("implicit-directory.zip");
        let mut archive = ZipWriter::new(FsFile::create(&archive_path).unwrap());
        archive.start_file("nested/file.txt", SimpleFileOptions::default()).unwrap();
        archive.write_all(b"content").unwrap();
        archive.finish().unwrap();

        let inspection = ArchiveInspectionCoordinator::from_plan(
            ArchiveInspectionPlan::from_local_source(
                LocalArchiveInspectionSource::from_archive_path(archive_path),
                ArchiveInspectionPresentation::DirectoryListing(ArchiveDirectoryListingPresentation::new(
                    "implicit-directory.zip".to_string(),
                    0,
                    None,
                    String::new(),
                    None,
                    10,
                )),
            )
            .unwrap(),
        );
        let listing = inspection.directory_listing().unwrap();

        assert_eq!(listing.items.len(), 1);
        assert_eq!(listing.items[0].name, "nested");
        assert_eq!(listing.items[0].file_type, FileType::Directory);
        assert_eq!(listing.items[0].state, ArchiveEntryState::Readable);
    }

    #[test]
    fn streams_a_validated_deflate_member_without_staging() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("notes.txt");
        fs::write(&source, vec![b'x'; ARCHIVE_COPY_BUFFER_SIZE]).unwrap();
        let target = directory.path().join("archive.zip");
        let entries = build_local_archive_manifest(&[source], &target).unwrap();
        create_local_archive(directory.path(), &target, &entries, || false).unwrap();

        let mut reader = LocalArchiveReader::open_pinned(&target).unwrap();
        let member = reader.next_entry().unwrap().unwrap();
        assert_eq!(member.compression_method, 8);
        let mut output = Vec::new();
        reader.stream_entry(member, &mut output).unwrap();
        assert_eq!(output, vec![b'x'; ARCHIVE_COPY_BUFFER_SIZE]);
    }

    #[test]
    fn stores_incompressible_members_after_a_bounded_probe() {
        let directory = tempdir().unwrap();
        let source = directory.path().join("data.bin");
        let mut content = Vec::with_capacity(ARCHIVE_COPY_BUFFER_SIZE);
        let mut state = 0x4d595df4_u32;
        for _ in 0..ARCHIVE_COPY_BUFFER_SIZE {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            content.push((state >> 24) as u8);
        }
        fs::write(&source, &content).unwrap();
        let target = directory.path().join("archive.zip");
        let entries = build_local_archive_manifest(&[source], &target).unwrap();

        create_local_archive(directory.path(), &target, &entries, || false).unwrap();

        let mut reader = LocalArchiveReader::open_pinned(&target).unwrap();
        let member = reader.next_entry().unwrap().unwrap();
        assert_eq!(member.compression_method, 0);
        let mut output = Vec::new();
        reader.stream_entry(member, &mut output).unwrap();
        assert_eq!(output, content);
    }

    #[test]
    fn passes_v2_creation_result_conformance_scenarios() {
        let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("archive-contract/v2/fixtures/creation-outcome-scenarios-v2.json");
        let corpus: CreationOutcomeConformanceCorpus =
            serde_json::from_slice(&fs::read(corpus_path).expect("shared creation outcome corpus should be readable"))
                .expect("shared creation outcome corpus should be valid JSON");
        assert_eq!(corpus.version, 2);

        for scenario in corpus.scenarios {
            let manifest = ArchiveCreationManifest::from_entries(scenario.result_reports.iter().fold(Vec::new(), |mut entries, report| {
                if !entries
                    .iter()
                    .any(|entry: &ArchiveCreationManifestMember| entry.archive_path == report.archive_path)
                {
                    entries.push(ArchiveCreationManifestMember {
                        archive_path: report.archive_path.clone(),
                        is_directory: report.status == "directory",
                        source_size: if report.status == "directory" { 0 } else { report.source_bytes },
                        source_modified_at: None,
                    });
                }
                entries
            }))
            .expect("creation outcome scenario must form a valid manifest");
            let mut state = ArchiveCreationManifestState::new(manifest);
            let result = scenario.result_reports.into_iter().try_for_each(|report| {
                let status = match report.status.as_str() {
                    "directory" => LocalArchiveCreationMemberStatus::Directory,
                    "created" => LocalArchiveCreationMemberStatus::Created,
                    status => panic!("unsupported creation result status in {}: {status}", scenario.name),
                };
                state.record(ArchiveCreationMemberOutcome {
                    archive_path: report.archive_path,
                    status,
                    source_bytes: report.source_bytes,
                })
            });
            if scenario.error.is_some() {
                assert!(result.is_err(), "{} must reject its invalid result", scenario.name);
                continue;
            }
            result.expect("valid creation outcome scenario must be accepted");
            let expected_outcomes = scenario
                .member_outcomes
                .expect("valid creation outcome scenario must declare outcomes");
            assert_eq!(state.outcomes.len(), expected_outcomes.len());
            for (archive_path, expected_outcome) in expected_outcomes {
                let member_result = state
                    .outcomes
                    .get(&archive_path)
                    .expect("expected creation result must be recorded");
                assert_eq!(member_result.source_bytes, expected_outcome.source_bytes);
                assert_eq!(
                    matches!(member_result.status, LocalArchiveCreationMemberStatus::Directory),
                    expected_outcome.status == "directory"
                );
            }
            let expected_progress = scenario.progress.expect("valid creation outcome scenario must declare progress");
            let progress = state.progress().expect("creation outcome progress must be derivable");
            assert_eq!(progress.files_created, expected_progress["files_created"]);
            assert_eq!(progress.directories_created, expected_progress["directories_created"]);
            assert_eq!(progress.source_bytes, expected_progress["source_bytes"]);
        }
    }

    #[test]
    fn passes_v2_target_write_resolution_scenarios() {
        let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("archive-contract/v2/fixtures/target-write-resolution-scenarios-v2.json");
        let corpus: TargetWriteConformanceCorpus =
            serde_json::from_slice(&fs::read(corpus_path).expect("target-write corpus should be readable"))
                .expect("target-write corpus should be valid JSON");
        assert_eq!(corpus.version, 2);

        for scenario in corpus.scenarios {
            match (&scenario.phase, scenario.attempt_ordinal) {
                (None, None) => {}
                (Some(phase), Some(attempt_ordinal)) => {
                    assert_eq!(phase, "after_create_race", "{}", scenario.name);
                    assert!((1..=2).contains(&attempt_ordinal), "{}", scenario.name);
                }
                _ => panic!("{} has incomplete late-race metadata", scenario.name),
            }
            let parse_timestamp = |value: Option<String>| {
                value.map(|timestamp| {
                    DateTime::parse_from_rfc3339(&timestamp)
                        .expect("fixture timestamps must be RFC 3339")
                        .with_timezone(&Utc)
                })
            };
            let target = match scenario.target.as_str() {
                "missing" => LocalArchiveTargetSnapshot::Missing,
                "regular_file" => LocalArchiveTargetSnapshot::RegularFile {
                    modified_at: parse_timestamp(scenario.target_modified_at),
                },
                "other" => LocalArchiveTargetSnapshot::Other,
                _ => panic!("unknown target fixture kind: {}", scenario.target),
            };
            let policy = match scenario.policy.as_str() {
                "ask" => LocalArchiveTargetWritePolicy::Ask,
                "skip" => LocalArchiveTargetWritePolicy::Skip,
                "replace" => LocalArchiveTargetWritePolicy::Replace,
                "replace_older" => LocalArchiveTargetWritePolicy::ReplaceOlder,
                _ => panic!("unknown target-write fixture policy: {}", scenario.policy),
            };
            let expected = match scenario.expected.as_str() {
                "create_new" => LocalArchiveTargetWriteDisposition::CreateNew,
                "replace_existing" => LocalArchiveTargetWriteDisposition::ReplaceExisting,
                "skip" => LocalArchiveTargetWriteDisposition::Skip,
                "await_collision" => LocalArchiveTargetWriteDisposition::AwaitCollision,
                _ => panic!("unknown target-write fixture disposition: {}", scenario.expected),
            };

            assert_eq!(
                resolve_local_archive_target_snapshot(policy, parse_timestamp(scenario.source_modified_at), target),
                expected,
                "{}",
                scenario.name
            );
        }
    }

    #[test]
    fn passes_v2_target_write_attempt_scenarios() {
        let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("archive-contract/v2/fixtures/target-write-resolution-scenarios-v2.json");
        let corpus: TargetWriteConformanceCorpus =
            serde_json::from_slice(&fs::read(corpus_path).expect("target-write corpus should be readable"))
                .expect("target-write corpus should be valid JSON");

        let parse_timestamp = |value: Option<String>| {
            value.map(|timestamp| {
                DateTime::parse_from_rfc3339(&timestamp)
                    .expect("fixture timestamps must be RFC 3339")
                    .with_timezone(&Utc)
            })
        };
        for scenario in corpus.attempt_scenarios {
            let policy = local_archive_target_write_policy_from_wire(Some(&scenario.policy)).expect("fixture policy must be valid");
            let source_modified_at = parse_timestamp(scenario.source_modified_at);
            assert_eq!(
                scenario.steps.first().map(|step| step.kind.as_str()),
                Some("observe"),
                "{}",
                scenario.name
            );
            assert_eq!(
                scenario.steps.first().and_then(|step| step.target.as_deref()),
                Some("missing"),
                "{}",
                scenario.name
            );
            let write_outcomes = scenario
                .steps
                .iter()
                .enumerate()
                .filter(|(_, step)| step.kind == "write")
                .map(|(index, step)| {
                    let observation = scenario.steps.get(index + 1).filter(|next| next.kind == "observe");
                    (
                        step.result.clone().expect("write step must specify a result"),
                        observation.and_then(|next| next.target.clone()),
                        observation.and_then(|next| next.target_modified_at.clone()),
                    )
                })
                .collect::<Vec<_>>();
            let temporary = tempdir().expect("temporary directory");
            let root = temporary.path();
            let target = root.join("entry.txt");
            let mut write_attempts = 0_usize;

            let output = prepare_local_archive_target_output_with_open(
                root,
                root,
                &target,
                policy,
                source_modified_at,
                |drive_root, destination_path| {
                    let (result, next_target, next_modified_at) = write_outcomes
                        .get(write_attempts)
                        .expect("controller attempted more writes than the corpus permits");
                    write_attempts += 1;
                    if result == "ready" {
                        return open_local_extraction_file(drive_root, destination_path);
                    }
                    assert_eq!(result, "target_exists_before_content", "{}", scenario.name);
                    match next_target.as_deref() {
                        None | Some("missing") => {}
                        Some("regular_file") => {
                            fs::write(destination_path, b"late target").expect("create late target");
                            let modified_at =
                                parse_timestamp(next_modified_at.clone()).expect("regular target observation must have a timestamp");
                            set_test_path_modified_time(destination_path, SystemTime::from(modified_at));
                        }
                        Some("other") => fs::create_dir(destination_path).expect("create late directory target"),
                        Some(target) => panic!("{} has invalid target kind {target}", scenario.name),
                    }
                    Err(LocalArchiveError::Io(std::io::Error::from(std::io::ErrorKind::AlreadyExists)))
                },
            )
            .expect("corpus controller scenario should not fail");

            let expected = match scenario.expected.as_str() {
                "create_new" => matches!(output, LocalArchiveTargetOutput::Ready { replaced: false, .. }),
                "replace_existing" => matches!(output, LocalArchiveTargetOutput::Ready { replaced: true, .. }),
                "skip" => matches!(output, LocalArchiveTargetOutput::Skip),
                "await_collision" => matches!(output, LocalArchiveTargetOutput::AwaitCollision { .. }),
                _ => panic!("{} has an invalid expected disposition", scenario.name),
            };
            assert!(expected, "{}", scenario.name);
            assert_eq!(write_attempts, usize::from(scenario.expected_attempts), "{}", scenario.name);
            assert_eq!(
                u8::from(matches!(output, LocalArchiveTargetOutput::Ready { .. })),
                scenario.expected_stream_polls,
                "{}",
                scenario.name
            );
        }
    }

    #[test]
    fn live_relay_collision_policy_aliases_match_v2_fixture() {
        let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("archive-contract/v2/fixtures/target-write-resolution-scenarios-v2.json");
        let corpus: TargetWriteConformanceCorpus =
            serde_json::from_slice(&fs::read(corpus_path).expect("target-write corpus should be readable"))
                .expect("target-write corpus should be valid JSON");

        for alias in corpus.live_relay_collision_policy_aliases {
            let expected = match alias.expected_policy.as_str() {
                "ask" => LocalArchiveTargetWritePolicy::Ask,
                "skip" => LocalArchiveTargetWritePolicy::Skip,
                "replace" => LocalArchiveTargetWritePolicy::Replace,
                "replace_older" => LocalArchiveTargetWritePolicy::ReplaceOlder,
                _ => panic!("unknown target-write fixture policy: {}", alias.expected_policy),
            };
            assert_eq!(
                local_archive_target_write_policy_from_wire(alias.wire_value.as_deref()),
                Some(expected)
            );
        }
        assert_eq!(local_archive_target_write_policy_from_wire(Some("invalid")), None);
    }

    #[test]
    fn local_target_output_controller_applies_policy_without_broad_overwrite() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path();
        let target = root.join("output").join("entry.txt");
        let source_modified_at = Utc::now();

        let created =
            prepare_local_archive_target_output(root, root, &target, LocalArchiveTargetWritePolicy::Ask, Some(source_modified_at))
                .expect("missing target should create");
        assert!(matches!(created, LocalArchiveTargetOutput::Ready { replaced: false, .. }));
        drop(created);

        let skipped =
            prepare_local_archive_target_output(root, root, &target, LocalArchiveTargetWritePolicy::Skip, Some(source_modified_at))
                .expect("skip policy should inspect target");
        assert!(matches!(skipped, LocalArchiveTargetOutput::Skip));

        let replaced = prepare_local_archive_target_output(
            root,
            root,
            &target,
            LocalArchiveTargetWritePolicy::Replace,
            Some(source_modified_at),
        )
        .expect("replace policy should recreate regular target");
        assert!(matches!(replaced, LocalArchiveTargetOutput::Ready { replaced: true, .. }));
        drop(replaced);

        fs::remove_file(&target).expect("remove file before directory collision");
        fs::create_dir(&target).expect("create conflicting directory");
        let collision = prepare_local_archive_target_output(
            root,
            root,
            &target,
            LocalArchiveTargetWritePolicy::Replace,
            Some(source_modified_at),
        )
        .expect("non-file target should remain a collision");
        assert!(matches!(collision, LocalArchiveTargetOutput::AwaitCollision { .. }));
    }

    #[test]
    fn local_target_output_controller_resolves_late_create_races() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path();

        let older_target = root.join("older.txt");
        let mut older_opens = 0;
        let older_result = prepare_local_archive_target_output_with_open(
            root,
            root,
            &older_target,
            LocalArchiveTargetWritePolicy::ReplaceOlder,
            Some(Utc::now() + chrono::Duration::days(1)),
            |drive_root, destination_path| {
                older_opens += 1;
                if older_opens == 1 {
                    fs::write(destination_path, b"late target").expect("create late target");
                }
                open_local_extraction_file(drive_root, destination_path)
            },
        )
        .expect("late older target should be replaced");
        assert!(matches!(older_result, LocalArchiveTargetOutput::Ready { replaced: true, .. }));
        assert_eq!(older_opens, 2);

        let newer_target = root.join("newer.txt");
        let mut newer_opens = 0;
        let newer_result = prepare_local_archive_target_output_with_open(
            root,
            root,
            &newer_target,
            LocalArchiveTargetWritePolicy::ReplaceOlder,
            Some(Utc::now() - chrono::Duration::days(1)),
            |drive_root, destination_path| {
                newer_opens += 1;
                if newer_opens == 1 {
                    fs::write(destination_path, b"late target").expect("create late target");
                }
                open_local_extraction_file(drive_root, destination_path)
            },
        )
        .expect("late newer target should be skipped");
        assert!(matches!(newer_result, LocalArchiveTargetOutput::Skip));
        assert_eq!(newer_opens, 1);

        let repeated_target = root.join("repeated.txt");
        let mut repeated_opens = 0;
        let repeated_result = prepare_local_archive_target_output_with_open(
            root,
            root,
            &repeated_target,
            LocalArchiveTargetWritePolicy::Replace,
            None,
            |drive_root, destination_path| {
                repeated_opens += 1;
                fs::write(destination_path, b"late target").expect("create late target");
                open_local_extraction_file(drive_root, destination_path)
            },
        )
        .expect("second late collision should pause");
        assert!(matches!(repeated_result, LocalArchiveTargetOutput::AwaitCollision { .. }));
        assert_eq!(repeated_opens, 2);
    }

    #[test]
    fn local_directory_controller_reports_late_non_directory_blocker() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path();
        let destination = root.join("output");
        fs::create_dir(&destination).expect("create destination");
        fs::write(destination.join("blocked"), b"file").expect("create blocker");

        let result = ensure_extraction_directory(root, &destination, &destination.join("blocked/child"))
            .expect("directory observation should succeed");

        assert!(matches!(
            result,
            LocalArchiveDirectoryOutput::AwaitCollision {
                target: LocalArchiveConflictTarget { size: Some(4), .. }
            }
        ));
    }

    #[test]
    fn passes_v2_creation_manifest_conformance_scenarios() {
        let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("archive-contract/v2/fixtures/creation-outcome-scenarios-v2.json");
        let corpus: CreationOutcomeConformanceCorpus =
            serde_json::from_slice(&fs::read(corpus_path).expect("shared creation outcome corpus should be readable"))
                .expect("shared creation outcome corpus should be valid JSON");
        assert_eq!(corpus.version, 2);

        for scenario in corpus.manifest_scenarios {
            let manifest = ArchiveCreationManifest::from_entries(
                scenario
                    .entries
                    .into_iter()
                    .map(|entry| ArchiveCreationManifestMember {
                        archive_path: entry.archive_path,
                        is_directory: entry.is_directory,
                        source_size: entry.source_size,
                        source_modified_at: None,
                    })
                    .collect(),
            );
            if scenario.error.is_some() {
                assert!(manifest.is_err(), "{} must reject its invalid manifest", scenario.name);
                continue;
            }
            let manifest = manifest.expect("valid manifest scenario must be accepted");
            let expected_entries = scenario
                .normalized_entries
                .expect("valid manifest scenario must declare normalized entries");
            assert_eq!(manifest.entries.len(), expected_entries.len(), "{}", scenario.name);
            for (member, expected) in manifest.entries.iter().zip(expected_entries) {
                assert_eq!(member.archive_path, expected.archive_path, "{}", scenario.name);
                assert_eq!(member.is_directory, expected.is_directory, "{}", scenario.name);
                assert_eq!(member.source_size, expected.source_size, "{}", scenario.name);
            }
            let expected_progress = scenario.progress.expect("valid manifest scenario must declare progress");
            let summary = manifest.summary().expect("valid manifest summary must be representable");
            assert_eq!(summary.files_created, expected_progress["files_created"], "{}", scenario.name);
            assert_eq!(
                summary.directories_created, expected_progress["directories_created"],
                "{}",
                scenario.name
            );
            assert_eq!(summary.source_bytes, expected_progress["source_bytes"], "{}", scenario.name);
        }
    }

    #[test]
    fn passes_v2_creation_terminal_conformance_scenarios() {
        let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("archive-contract/v2/fixtures/creation-outcome-scenarios-v2.json");
        let corpus: CreationOutcomeConformanceCorpus =
            serde_json::from_slice(&fs::read(corpus_path).expect("shared creation outcome corpus should be readable"))
                .expect("shared creation outcome corpus should be valid JSON");
        assert_eq!(corpus.version, 2);

        for scenario in corpus.terminal_scenarios {
            let manifest = ArchiveCreationManifest::from_entries(
                scenario
                    .entries
                    .into_iter()
                    .map(|entry| ArchiveCreationManifestMember {
                        archive_path: entry.archive_path,
                        is_directory: entry.is_directory,
                        source_size: entry.source_size,
                        source_modified_at: None,
                    })
                    .collect(),
            )
            .expect("terminal scenario manifest must be valid");
            let result = (|| {
                let mut state = ArchiveCreationManifestState::new(manifest);
                for report in scenario.result_reports {
                    let status = match report.status.as_str() {
                        "directory" => LocalArchiveCreationMemberStatus::Directory,
                        "created" => LocalArchiveCreationMemberStatus::Created,
                        status => panic!("unsupported creation result status in {}: {status}", scenario.name),
                    };
                    state.record(ArchiveCreationMemberOutcome {
                        archive_path: report.archive_path,
                        status,
                        source_bytes: report.source_bytes,
                    })?;
                }
                state.terminal_summary()
            })();
            if scenario.error.is_some() {
                assert!(result.is_err(), "{} must reject its invalid terminal state", scenario.name);
                continue;
            }
            let summary = result.expect("valid terminal scenario must be accepted");
            let expected_progress = scenario.progress.expect("valid terminal scenario must declare progress");
            assert_eq!(summary.files_created, expected_progress["files_created"], "{}", scenario.name);
            assert_eq!(
                summary.directories_created, expected_progress["directories_created"],
                "{}",
                scenario.name
            );
            assert_eq!(summary.source_bytes, expected_progress["source_bytes"], "{}", scenario.name);
        }
    }

    #[test]
    fn passes_v2_creation_trajectory_conformance_scenarios() {
        let corpus_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("archive-contract/v2/fixtures/creation-trajectory-scenarios-v2.json");
        let corpus: CreationTrajectoryConformanceCorpus =
            serde_json::from_slice(&fs::read(corpus_path).expect("shared creation trajectory corpus should be readable"))
                .expect("shared creation trajectory corpus should be valid JSON");
        assert_eq!(corpus.version, 2);
        assert_eq!(
            corpus.topologies.into_iter().collect::<std::collections::HashSet<_>>(),
            std::collections::HashSet::from([
                "smb_to_smb".to_string(),
                "local_to_local".to_string(),
                "smb_to_local".to_string(),
                "local_to_smb".to_string(),
            ])
        );

        for scenario in corpus.scenarios {
            let manifest = ArchiveCreationManifest::from_entries(
                scenario
                    .entries
                    .iter()
                    .map(|entry| ArchiveCreationManifestMember {
                        archive_path: entry.archive_path.clone(),
                        is_directory: entry.is_directory,
                        source_size: entry.source_size,
                        source_modified_at: None,
                    })
                    .collect(),
            )
            .expect("trajectory members must form a valid immutable manifest");
            let mut state = ArchiveCreationManifestState::new(manifest);
            let mut cancelled = false;
            for step in scenario.steps {
                match step.event.as_str() {
                    "initialize" | "resume" | "terminal_summary" => {}
                    "cancel" => cancelled = true,
                    "report" => {
                        let status = match step.status.as_deref() {
                            Some("directory") => LocalArchiveCreationMemberStatus::Directory,
                            Some("created") => LocalArchiveCreationMemberStatus::Created,
                            status => panic!("unsupported creation result status in {}: {status:?}", scenario.name),
                        };
                        state
                            .record(ArchiveCreationMemberOutcome {
                                archive_path: step.archive_path.expect("creation reports must identify their archive member"),
                                status,
                                source_bytes: step.source_bytes,
                            })
                            .expect("valid creation trajectory outcome must be accepted");
                    }
                    event => panic!("unsupported creation trajectory event in {}: {event}", scenario.name),
                }
            }
            assert_eq!(
                state.outcomes.keys().cloned().collect::<std::collections::HashSet<_>>(),
                scenario.completed_members.into_iter().collect(),
                "{}",
                scenario.name
            );
            if cancelled {
                assert_eq!(scenario.terminal_phase, "cancelled", "{}", scenario.name);
            } else {
                let summary = state
                    .terminal_summary()
                    .expect("complete trajectory must produce a terminal summary");
                assert_eq!(summary.files_created, scenario.progress["files_created"], "{}", scenario.name);
                assert_eq!(
                    summary.directories_created, scenario.progress["directories_created"],
                    "{}",
                    scenario.name
                );
                assert_eq!(summary.source_bytes, scenario.progress["source_bytes"], "{}", scenario.name);
            }
        }
    }

    #[test]
    fn streaming_zip_writer_coalesces_directory_metadata_writes() {
        let write_calls = Rc::new(Cell::new(0));
        let output = CountingWrite {
            write_calls: Rc::clone(&write_calls),
        };
        let mut writer = ZipWriter::new_stream(BufWriter::with_capacity(ARCHIVE_WRITE_BUFFER_SIZE, output));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        writer.add_directory("first", options).unwrap();
        writer.add_directory("second", options).unwrap();
        writer.add_directory("third", options).unwrap();

        writer.finish().unwrap().flush().unwrap();

        assert_eq!(write_calls.get(), 1);
    }

    #[test]
    fn rejects_a_target_inside_a_source_directory() {
        let directory = tempdir().unwrap();
        let source_root = directory.path().join("source");
        fs::create_dir(&source_root).unwrap();

        assert!(matches!(
            build_local_archive_manifest(std::slice::from_ref(&source_root), &source_root.join("archive.zip")),
            Err(LocalArchiveError::TargetInsideSource)
        ));
    }

    #[test]
    fn loads_v2_topology_operation_compatibility_matrix() {
        let matrix_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../archive-contract/v2/fixtures/topology-operation-compatibility-matrix-v2.json");
        let matrix: serde_json::Value = serde_json::from_slice(&fs::read(matrix_path).unwrap()).unwrap();

        assert_eq!(matrix["version"], 2);
        let operations = matrix["operations"].as_array().unwrap();
        let mut cells = operations
            .iter()
            .map(|entry| format!("{}:{}", entry["topology"].as_str().unwrap(), entry["operation"].as_str().unwrap()))
            .collect::<Vec<_>>();
        cells.sort();
        assert_eq!(
            cells,
            vec![
                "local_to_local:creation",
                "local_to_local:extraction",
                "local_to_local:inspection",
                "local_to_smb:creation",
                "local_to_smb:extraction",
                "local_to_smb:inspection",
                "smb_to_local:creation",
                "smb_to_local:extraction",
                "smb_to_local:inspection",
                "smb_to_smb:creation",
                "smb_to_smb:extraction",
                "smb_to_smb:inspection",
            ]
        );
        for entry in operations {
            assert_eq!(entry["status"], "supported");
            assert!(entry["driver"].is_string());
            assert!(entry.get("retirement_condition").is_none());
            if entry["operation"] == "inspection" {
                assert!(entry.get("relay_purpose").is_none());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn passes_v2_creation_manifest_virtual_tree_corpus() {
        use std::os::unix::fs::symlink;

        let corpus_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../archive-contract/v2/fixtures/creation-manifest-scenarios-v2.json");
        let corpus: serde_json::Value = serde_json::from_slice(&fs::read(corpus_path).unwrap()).unwrap();
        for scenario in corpus["scenarios"].as_array().unwrap() {
            let root = tempdir().unwrap();
            for node in scenario["nodes"].as_array().unwrap() {
                let path = root.path().join(node["path"].as_str().unwrap());
                match node["type"].as_str().unwrap() {
                    "directory" => fs::create_dir_all(path).unwrap(),
                    "file" => {
                        fs::create_dir_all(path.parent().unwrap()).unwrap();
                        fs::write(path, vec![0; node["size"].as_u64().unwrap_or(0) as usize]).unwrap();
                    }
                    "symlink" | "unsupported" => symlink("missing", path).unwrap(),
                    _ => unreachable!(),
                }
            }
            for node in scenario["nodes"].as_array().unwrap() {
                let Some(modified_at) = node.get("modified_at").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let timestamp = DateTime::parse_from_rfc3339(modified_at).unwrap().with_timezone(&Utc).into();
                let path = root.path().join(node["path"].as_str().unwrap());
                set_test_path_modified_time(&path, timestamp);
            }
            let sources = scenario["sources"]
                .as_array()
                .unwrap()
                .iter()
                .map(|path| root.path().join(path.as_str().unwrap()))
                .collect::<Vec<_>>();
            let result = build_local_archive_manifest(&sources, &root.path().join(scenario["target"].as_str().unwrap()));
            if scenario.get("error").is_some() {
                assert!(result.is_err(), "{}", scenario["name"]);
                continue;
            }
            let manifest = project_local_archive_creation_manifest(&result.unwrap()).unwrap();
            let actual = manifest
                .entries
                .iter()
                .zip(scenario["manifest"].as_array().unwrap())
                .map(|(entry, expected)| {
                    let mut actual = serde_json::json!({
                        "archive_path": entry.archive_path.trim_end_matches('/'),
                        "is_directory": entry.is_directory,
                        "source_size": entry.source_size,
                    });
                    if expected.get("modified_at").is_some() {
                        actual["modified_at"] = serde_json::json!(entry.source_modified_at);
                    }
                    actual
                })
                .collect::<Vec<_>>();
            assert_eq!(actual, *scenario["manifest"].as_array().unwrap(), "{}", scenario["name"]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_target_parent_symlinked_outside_drive_root() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let source = root.path().join("source.txt");
        fs::write(&source, b"source").unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        let target = root.path().join("escape/archive.zip");
        let entries = build_local_archive_manifest(&[source], &target).unwrap();

        assert!(matches!(
            create_local_archive(root.path(), &target, &entries, || false),
            Err(LocalArchiveError::TargetOutsideRoot)
        ));
    }
}
