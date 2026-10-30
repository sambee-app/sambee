"""Bounded ZIP central-directory parsing for virtual archive browsing."""

import base64
import bz2
import json
import struct
import zlib
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

from app.storage.base import RandomAccessReader

_EOCD_SIGNATURE = b"PK\x05\x06"
_CENTRAL_DIRECTORY_SIGNATURE = b"PK\x01\x02"
_LOCAL_FILE_SIGNATURE = b"PK\x03\x04"
_ZIP64_LOCATOR_SIGNATURE = b"PK\x06\x07"
_ZIP64_EOCD_SIGNATURE = b"PK\x06\x06"
_EOCD_SIZE = 22
_ZIP64_LOCATOR_SIZE = 20
_MAX_COMMENT_BYTES = 65_535
_MAX_ENTRY_VARIABLE_BYTES = 65_535 * 3
_CENTRAL_DIRECTORY_FIXED_SIZE = 46
_ZIP64_SENTINEL_U32 = 0xFFFFFFFF
_ZIP64_SENTINEL_U16 = 0xFFFF
_INFOZIP_UNICODE_PATH_FIELD_ID = 0x7075
_INFOZIP_UNICODE_PATH_VERSION = 1
_READABLE_METHODS = {0, 8, 12}
_ARCHIVE_IO_CHUNK_BYTES = 256 * 1024
ARCHIVE_INLINE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024
_UNIX_HOST_SYSTEM = 3
_UNIX_FILE_TYPE_MASK = 0o170000
_UNIX_DIRECTORY_FILE_TYPE = 0o040000
_UNIX_REGULAR_FILE_TYPE = 0o100000


class ArchiveFormatError(ValueError):
    """Raised when an archive cannot be safely interpreted as a ZIP file."""


class ArchiveSourceUnavailableError(OSError):
    """Raised when the retained archive source can no longer be read."""


@dataclass(frozen=True)
class ZipDirectory:
    """Location and entry count declared by the ZIP directory records."""

    offset: int
    size: int
    entries: int


@dataclass(frozen=True)
class ZipEntry:
    """Minimal parsed central-directory record used for virtual listings."""

    path: str
    is_directory: bool
    compressed_size: int
    uncompressed_size: int
    compression_method: int
    crc32: int
    modified_at: datetime | None
    encrypted: bool
    is_safe: bool
    has_supported_file_type: bool
    local_header_offset: int
    flags: int
    raw_name: bytes
    reader_identity: object = field(repr=False, compare=False)


@dataclass(frozen=True)
class ValidatedZipEntry:
    """One local-header-validated entry bound to the reader that created it."""

    entry: ZipEntry
    data_offset: int
    reader_identity: object = field(repr=False, compare=False)


@dataclass(frozen=True)
class ArchiveInspectionManifestMember:
    """Normalized inspection metadata for one archive member."""

    path: str
    is_directory: bool
    compressed_size: int
    uncompressed_size: int
    compression_method: int
    crc32: int
    modified_at: datetime | None
    encrypted: bool
    is_safe: bool
    has_supported_file_type: bool

    @property
    def preview_state(self) -> Literal["readable", "blocked", "unavailable"]:
        if self.encrypted:
            return "blocked"
        return "readable" if self.compression_method in _READABLE_METHODS else "unavailable"

    def is_inline_preview_eligible(self) -> bool:
        return (
            not self.is_directory
            and self.is_safe
            and self.has_supported_file_type
            and self.preview_state == "readable"
            and self.uncompressed_size <= ARCHIVE_INLINE_PREVIEW_MAX_BYTES
        )


@dataclass(frozen=True)
class ZipDirectoryPage:
    """One page of projected immediate children in a virtual ZIP directory."""

    path: str
    entries: tuple[ZipEntry, ...]
    next_cursor: str | None


@dataclass(frozen=True)
class EffectiveZipProjection:
    """Selected safe archive entries and virtual directories for one reader."""

    entries: tuple[ZipEntry, ...]
    regular_entries: tuple[ZipEntry, ...]
    explicit_directories: tuple[ZipEntry, ...]
    directories: frozenset[str]
    member_by_path: dict[str, ZipEntry]
    skipped_entries: int


def _u16(data: bytes, offset: int) -> int:
    return int(struct.unpack_from("<H", data, offset)[0])


def _u32(data: bytes, offset: int) -> int:
    return int(struct.unpack_from("<I", data, offset)[0])


def _u64(data: bytes, offset: int) -> int:
    return int(struct.unpack_from("<Q", data, offset)[0])


def _unicode_path_name(raw_name: bytes, extra: bytes) -> str | None:
    """Return a validated Info-ZIP Unicode Path name, when one is present."""

    position = 0
    while position + 4 <= len(extra):
        field_id = _u16(extra, position)
        field_length = _u16(extra, position + 2)
        position += 4
        if position + field_length > len(extra):
            return None
        field = extra[position : position + field_length]
        position += field_length
        if field_id != _INFOZIP_UNICODE_PATH_FIELD_ID or len(field) < 5:
            continue
        if field[0] != _INFOZIP_UNICODE_PATH_VERSION or _u32(field, 1) != zlib.crc32(raw_name) & _ZIP64_SENTINEL_U32:
            continue
        try:
            return field[5:].decode("utf-8")
        except UnicodeDecodeError:
            continue
    return None


def _decode_name(raw_name: bytes, flags: int, extra: bytes) -> str:
    if flags & 0x0800:
        return raw_name.decode("utf-8", errors="replace")
    unicode_path_name = _unicode_path_name(raw_name, extra)
    if unicode_path_name is not None:
        return unicode_path_name
    try:
        return raw_name.decode("utf-8")
    except UnicodeDecodeError:
        return raw_name.decode("cp437")


def _zip64_member_values(
    extra: bytes,
    *,
    compressed_size: int,
    uncompressed_size: int,
    local_header_offset: int,
) -> tuple[int, int, int]:
    """Resolve sentinel central-directory fields from the ZIP64 extra field."""

    position = 0
    while position + 4 <= len(extra):
        field_id = _u16(extra, position)
        field_length = _u16(extra, position + 2)
        position += 4
        if position + field_length > len(extra):
            raise ArchiveFormatError("ZIP extra field is malformed")
        if field_id != 0x0001:
            position += field_length
            continue
        field = extra[position : position + field_length]
        value_position = 0

        def take_u64(required: bool, value: int) -> int:
            nonlocal value_position
            if not required:
                return value
            if value_position + 8 > len(field):
                raise ArchiveFormatError("ZIP64 member metadata is truncated")
            value = _u64(field, value_position)
            value_position += 8
            return value

        uncompressed_size = take_u64(uncompressed_size == _ZIP64_SENTINEL_U32, uncompressed_size)
        compressed_size = take_u64(compressed_size == _ZIP64_SENTINEL_U32, compressed_size)
        local_header_offset = take_u64(local_header_offset == _ZIP64_SENTINEL_U32, local_header_offset)
        return compressed_size, uncompressed_size, local_header_offset
    if compressed_size == _ZIP64_SENTINEL_U32 or uncompressed_size == _ZIP64_SENTINEL_U32 or local_header_offset == _ZIP64_SENTINEL_U32:
        raise ArchiveFormatError("ZIP64 member metadata is missing")
    return compressed_size, uncompressed_size, local_header_offset


def _normalize_path(name: str) -> tuple[str, bool]:
    is_directory = name.endswith(("/", "\\"))
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or "\x00" in normalized:
        return normalized.rstrip("/"), False
    segments = normalized.rstrip("/").split("/")
    if not segments or any(not segment or segment in {".", ".."} for segment in segments):
        return normalized.rstrip("/"), False
    if any(":" in segment for segment in segments):
        return normalized.rstrip("/"), False
    return "/".join(segments), is_directory


def _is_safe_path(name: str, normalized_path: str) -> bool:
    canonical = name.replace("\\", "/").rstrip("/")
    if not canonical or canonical.startswith("/") or "\x00" in canonical:
        return False
    segments = canonical.split("/")
    return all(segment and segment not in {".", ".."} and ":" not in segment for segment in segments) and normalized_path == "/".join(
        segments
    )


def _has_supported_file_type(version_made_by: int, external_attributes: int) -> bool:
    if version_made_by >> 8 != _UNIX_HOST_SYSTEM:
        return True
    file_type = (external_attributes >> 16) & _UNIX_FILE_TYPE_MASK
    return file_type in {0, _UNIX_DIRECTORY_FILE_TYPE, _UNIX_REGULAR_FILE_TYPE}


def _dos_datetime(date_value: int, time_value: int) -> datetime | None:
    """Interpret DOS-only dates as UTC, consistently with the Companion reader."""
    year = ((date_value >> 9) & 0x7F) + 1980
    month = (date_value >> 5) & 0x0F
    day = date_value & 0x1F
    hour = (time_value >> 11) & 0x1F
    minute = (time_value >> 5) & 0x3F
    second = (time_value & 0x1F) * 2
    try:
        return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    except ValueError:
        return None


def _forward_cursor(position: int, remaining_entries: int) -> str:
    """Encode one bounded central-directory continuation point."""

    return (
        base64.urlsafe_b64encode(json.dumps({"position": position, "remaining_entries": remaining_entries}, separators=(",", ":")).encode())
        .decode()
        .rstrip("=")
    )


def _decode_forward_cursor(value: str) -> tuple[int, int]:
    """Decode a continuation point emitted by this reader only."""

    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        position = payload["position"]
        remaining_entries = payload["remaining_entries"]
    except (KeyError, TypeError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
        raise ArchiveFormatError("Archive listing cursor is invalid") from exc
    if type(position) is not int or type(remaining_entries) is not int or position < 0 or remaining_entries < 0:
        raise ArchiveFormatError("Archive listing cursor is invalid")
    return position, remaining_entries


def _directory_cursor(path: str, offset: int) -> str:
    """Encode a projected directory-list continuation."""

    return base64.urlsafe_b64encode(json.dumps({"path": path, "offset": offset}, separators=(",", ":")).encode()).decode().rstrip("=")


def _decode_directory_cursor(value: str, path: str) -> int:
    """Decode and bind a directory-list continuation to its virtual path."""

    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        cursor_path = payload["path"]
        offset = payload["offset"]
    except (KeyError, TypeError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
        raise ArchiveFormatError("Archive listing cursor is invalid") from exc
    if cursor_path != path or type(offset) is not int or offset < 0:
        raise ArchiveFormatError("Archive listing cursor is invalid")
    return offset


def _parent_paths(path: str) -> tuple[str, ...]:
    parts = path.split("/")
    return tuple("/".join(parts[:index]) for index in range(1, len(parts)))


class ZipReader:
    """Read ZIP metadata without staging archive contents or member bytes."""

    def __init__(self, reader: RandomAccessReader, size: int) -> None:
        if size < _EOCD_SIZE:
            raise ArchiveFormatError("Archive is too small to be a ZIP file")
        self._reader = reader
        self._size = size
        self._entry_identity = object()
        self._validation_identity = object()
        self._forward_directory: ZipDirectory | None = None
        self._forward_position: int | None = None
        self._forward_remaining_entries: int | None = None
        self._forward_next_read_offset: int | None = None
        self._forward_buffer = bytearray()
        self._read_operations = 0
        self._read_bytes = 0
        self._projection: EffectiveZipProjection | None = None

    async def close(self) -> None:
        """Release the retained random-access archive source."""

        await self._reader.close()

    async def _read_exact(self, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0 or offset + length > self._size:
            raise ArchiveFormatError("ZIP record extends beyond archive bounds")
        try:
            data = await self._reader.read_at(offset, length)
        except Exception as exc:
            raise ArchiveSourceUnavailableError("Archive source cannot be read") from exc
        self._read_operations += 1
        self._read_bytes += len(data)
        if len(data) != length:
            raise ArchiveFormatError("ZIP record is truncated")
        return data

    async def _directory(self) -> ZipDirectory:
        tail_length = min(self._size, _EOCD_SIZE + _MAX_COMMENT_BYTES)
        tail_offset = self._size - tail_length
        tail = await self._read_exact(tail_offset, tail_length)
        eocd_index = tail.rfind(_EOCD_SIGNATURE)
        if eocd_index < 0 or eocd_index + _EOCD_SIZE > len(tail):
            raise ArchiveFormatError("ZIP end-of-central-directory record is missing")
        eocd = tail[eocd_index : eocd_index + _EOCD_SIZE]
        comment_length = _u16(eocd, 20)
        if eocd_index + _EOCD_SIZE + comment_length != len(tail):
            raise ArchiveFormatError("ZIP end-of-central-directory comment is malformed")
        entries = _u16(eocd, 10)
        directory_size = _u32(eocd, 12)
        directory_offset = _u32(eocd, 16)
        eocd_offset = tail_offset + eocd_index
        if entries != _ZIP64_SENTINEL_U16 and directory_size != _ZIP64_SENTINEL_U32 and directory_offset != _ZIP64_SENTINEL_U32:
            return ZipDirectory(directory_offset, directory_size, entries)
        if eocd_offset < _ZIP64_LOCATOR_SIZE:
            raise ArchiveFormatError("ZIP64 locator is missing")
        locator = await self._read_exact(eocd_offset - _ZIP64_LOCATOR_SIZE, _ZIP64_LOCATOR_SIZE)
        if locator[:4] != _ZIP64_LOCATOR_SIGNATURE:
            raise ArchiveFormatError("ZIP64 locator is invalid")
        zip64_offset = _u64(locator, 8)
        header = await self._read_exact(zip64_offset, 56)
        if header[:4] != _ZIP64_EOCD_SIGNATURE or _u64(header, 4) < 44:
            raise ArchiveFormatError("ZIP64 end-of-central-directory record is invalid")
        return ZipDirectory(_u64(header, 48), _u64(header, 40), _u64(header, 32))

    async def _initialize_forward_reader(self) -> ZipDirectory:
        if self._forward_directory is not None:
            return self._forward_directory
        directory = await self._directory()
        if directory.offset + directory.size > self._size:
            raise ArchiveFormatError("ZIP central directory extends beyond archive bounds")
        self._forward_directory = directory
        self._forward_position = directory.offset
        self._forward_remaining_entries = directory.entries
        self._forward_next_read_offset = directory.offset
        return directory

    async def set_forward_cursor(self, cursor: str | None) -> None:
        """Set this new reader to a previously emitted record boundary."""

        if cursor is None:
            return
        if self._forward_position is not None:
            raise ArchiveFormatError("Archive listing cursor cannot be applied after traversal begins")
        position, remaining_entries = _decode_forward_cursor(cursor)
        directory = await self._initialize_forward_reader()
        directory_end = directory.offset + directory.size
        if position < directory.offset or position > directory_end or remaining_entries > directory.entries:
            raise ArchiveFormatError("Archive listing cursor is out of range")
        self._forward_position = position
        self._forward_remaining_entries = remaining_entries
        self._forward_next_read_offset = position
        self._forward_buffer.clear()

    async def inspection_page(self, cursor: str | None, page_size: int) -> tuple[tuple[ZipEntry, ...], str | None]:
        """Return one record-order page without collecting the full directory."""

        if not 1 <= page_size <= 500:
            raise ValueError("Archive listing page size is invalid")
        await self.set_forward_cursor(cursor)
        entries: list[ZipEntry] = []
        while len(entries) < page_size:
            entry = await self.next_entry()
            if entry is None:
                return tuple(entries), None
            if not entry.is_safe or not entry.has_supported_file_type:
                raise ArchiveFormatError("Archive contains an unsafe or unsupported member")
            entries.append(entry)
        assert self._forward_position is not None
        assert self._forward_remaining_entries is not None
        return tuple(entries), _forward_cursor(self._forward_position, self._forward_remaining_entries)

    async def _effective_projection(self) -> EffectiveZipProjection:
        """Build the source-entry projection once without reading member payloads."""

        if self._projection is not None:
            return self._projection
        if self._forward_position is not None:
            raise ArchiveFormatError("Archive projection cannot begin after traversal starts")

        raw_entries: list[ZipEntry] = []
        while (entry := await self.next_entry()) is not None:
            raw_entries.append(entry)

        selected_by_path: dict[str, ZipEntry] = {}
        explicit_directories_by_path: dict[str, ZipEntry] = {}
        for entry in raw_entries:
            if not entry.is_safe or not entry.has_supported_file_type:
                continue
            if entry.is_directory:
                explicit_directories_by_path[entry.path] = entry
            else:
                selected_by_path[entry.path] = entry

        regular_entries = tuple(entry for entry in raw_entries if selected_by_path.get(entry.path) is entry)
        explicit_directories = tuple(
            entry for entry in raw_entries if entry.path not in selected_by_path and explicit_directories_by_path.get(entry.path) is entry
        )
        entries = tuple(
            entry
            for entry in raw_entries
            if selected_by_path.get(entry.path) is entry
            or (entry.path not in selected_by_path and explicit_directories_by_path.get(entry.path) is entry)
        )
        directories = set(explicit_directories_by_path)
        for entry in entries:
            directories.update(_parent_paths(entry.path))
        directories.difference_update(selected_by_path)
        self._projection = EffectiveZipProjection(
            entries=entries,
            regular_entries=regular_entries,
            explicit_directories=explicit_directories,
            directories=frozenset(directories),
            member_by_path=selected_by_path,
            skipped_entries=len(raw_entries) - len(entries),
        )
        return self._projection

    async def extraction_entries(self) -> tuple[tuple[ZipEntry, ...], int]:
        """Return selected source entries and aggregate-only skipped record count."""

        projection = await self._effective_projection()
        return projection.entries, projection.skipped_entries

    async def list_directory(self, virtual_path: str, cursor: str | None, page_size: int) -> ZipDirectoryPage:
        """List selected immediate children of a safe virtual ZIP directory."""

        if not 1 <= page_size <= 500:
            raise ValueError("Archive listing page size is invalid")
        path, _is_directory = _normalize_path(virtual_path)
        if virtual_path and (not path or not _is_safe_path(virtual_path, path)):
            raise ArchiveFormatError("Archive virtual directory path is invalid")
        projection = await self._effective_projection()
        if path in projection.member_by_path:
            raise ArchiveFormatError("Archive virtual path is not a directory")
        if path and path not in projection.directories:
            raise ArchiveFormatError("Archive virtual directory was not found")
        offset = _decode_directory_cursor(cursor, path) if cursor is not None else 0
        prefix = f"{path}/" if path else ""
        children: dict[str, ZipEntry] = {}
        for entry in (*projection.explicit_directories, *projection.regular_entries):
            if not entry.path.startswith(prefix):
                continue
            remainder = entry.path[len(prefix) :]
            if remainder and "/" not in remainder:
                children[entry.path] = entry
        for directory_path in projection.directories:
            if not directory_path.startswith(prefix):
                continue
            remainder = directory_path[len(prefix) :]
            if not remainder or "/" in remainder or directory_path in children:
                continue
            representative = next((entry for entry in projection.entries if entry.path.startswith(f"{directory_path}/")), None)
            if representative is None:
                continue
            children[directory_path] = ZipEntry(
                path=directory_path,
                is_directory=True,
                compressed_size=0,
                uncompressed_size=0,
                compression_method=0,
                crc32=0,
                modified_at=representative.modified_at,
                encrypted=False,
                is_safe=True,
                has_supported_file_type=True,
                local_header_offset=0,
                flags=0,
                raw_name=b"",
                reader_identity=self._entry_identity,
            )
        ordered_children = tuple(sorted(children.values(), key=lambda entry: entry.path))
        if offset > len(ordered_children):
            raise ArchiveFormatError("Archive listing cursor is out of range")
        entries = ordered_children[offset : offset + page_size]
        next_offset = offset + len(entries)
        return ZipDirectoryPage(path, entries, _directory_cursor(path, next_offset) if next_offset < len(ordered_children) else None)

    async def _fill_forward_buffer(self, required_length: int, directory_end: int) -> None:
        next_read_offset = self._forward_next_read_offset
        if next_read_offset is None:
            raise ArchiveFormatError("ZIP forward reader is not initialized")
        while len(self._forward_buffer) < required_length and next_read_offset < directory_end:
            read_length = min(_ARCHIVE_IO_CHUNK_BYTES, directory_end - next_read_offset)
            self._forward_buffer.extend(await self._read_exact(next_read_offset, read_length))
            next_read_offset += read_length
        self._forward_next_read_offset = next_read_offset

    async def next_entry(self) -> ZipEntry | None:
        """Return the next central-directory record without retaining prior records."""

        directory = await self._initialize_forward_reader()
        assert self._forward_position is not None
        assert self._forward_remaining_entries is not None
        assert self._forward_next_read_offset is not None
        directory_end = directory.offset + directory.size

        if self._forward_remaining_entries == 0:
            if self._forward_position != directory_end or self._forward_buffer:
                raise ArchiveFormatError("ZIP central-directory size does not match its entries")
            return None

        await self._fill_forward_buffer(_CENTRAL_DIRECTORY_FIXED_SIZE, directory_end)
        if len(self._forward_buffer) < _CENTRAL_DIRECTORY_FIXED_SIZE:
            raise ArchiveFormatError("ZIP central-directory entry is truncated")
        fixed = bytes(self._forward_buffer[:_CENTRAL_DIRECTORY_FIXED_SIZE])
        if fixed[:4] != _CENTRAL_DIRECTORY_SIGNATURE:
            raise ArchiveFormatError("ZIP central-directory entry is invalid")
        flags = _u16(fixed, 8)
        version_made_by = _u16(fixed, 4)
        external_attributes = _u32(fixed, 38)
        method = _u16(fixed, 10)
        time_value = _u16(fixed, 12)
        date_value = _u16(fixed, 14)
        crc32 = _u32(fixed, 16)
        compressed_size = _u32(fixed, 20)
        uncompressed_size = _u32(fixed, 24)
        name_length = _u16(fixed, 28)
        extra_length = _u16(fixed, 30)
        comment_length = _u16(fixed, 32)
        variable_length = name_length + extra_length + comment_length
        record_length = _CENTRAL_DIRECTORY_FIXED_SIZE + variable_length
        if variable_length > _MAX_ENTRY_VARIABLE_BYTES or self._forward_position + record_length > directory_end:
            raise ArchiveFormatError("ZIP central-directory entry length is invalid")
        await self._fill_forward_buffer(record_length, directory_end)
        if len(self._forward_buffer) < record_length:
            raise ArchiveFormatError("ZIP central-directory entry is truncated")
        variable = bytes(self._forward_buffer[_CENTRAL_DIRECTORY_FIXED_SIZE:record_length])
        raw_name = variable[:name_length]
        extra = variable[name_length : name_length + extra_length]
        decoded_name = _decode_name(raw_name, flags, extra)
        path, is_directory = _normalize_path(decoded_name)
        local_header_offset = _u32(fixed, 42)
        compressed_size, uncompressed_size, local_header_offset = _zip64_member_values(
            extra,
            compressed_size=compressed_size,
            uncompressed_size=uncompressed_size,
            local_header_offset=local_header_offset,
        )
        del self._forward_buffer[:record_length]
        self._forward_position += record_length
        self._forward_remaining_entries -= 1
        if self._forward_remaining_entries == 0 and (self._forward_position != directory_end or self._forward_buffer):
            raise ArchiveFormatError("ZIP central-directory size does not match its entries")
        return ZipEntry(
            path=path,
            is_directory=is_directory,
            compressed_size=compressed_size,
            uncompressed_size=uncompressed_size,
            compression_method=method,
            crc32=crc32,
            modified_at=_dos_datetime(date_value, time_value),
            encrypted=bool(flags & 1),
            is_safe=_is_safe_path(decoded_name, path),
            has_supported_file_type=_has_supported_file_type(version_made_by, external_attributes),
            local_header_offset=local_header_offset,
            flags=flags,
            raw_name=raw_name,
            reader_identity=self._entry_identity,
        )

    async def validate_member(self, path: str) -> ValidatedZipEntry:
        """Find and validate one safe regular member in central-directory order."""

        return await self.validate_member_in_record_order(path)

    async def validate_member_in_record_order(self, path: str) -> ValidatedZipEntry:
        """Find and validate one selected regular member."""

        normalized_path, is_directory = _normalize_path(path)
        if is_directory or not normalized_path:
            raise ArchiveFormatError("Archive member path must identify a regular file")
        projection = await self._effective_projection()
        entry = projection.member_by_path.get(normalized_path)
        if entry is None:
            raise ArchiveFormatError("Archive member was not found")
        return await self.validate_entry(entry)

    async def validate_entry(self, entry: ZipEntry) -> ValidatedZipEntry:
        """Validate one selected readable entry without resolving its path again."""

        if entry.encrypted or entry.compression_method not in _READABLE_METHODS:
            raise ArchiveFormatError("Archive member uses an unavailable codec or blocked feature")
        return await self._validate_entry(entry)

    async def _validate_entry(self, entry: ZipEntry) -> ValidatedZipEntry:
        if entry.reader_identity is not self._entry_identity:
            raise ArchiveFormatError("ZIP member was not found")

        local_header = await self._read_exact(entry.local_header_offset, 30)
        if local_header[:4] != _LOCAL_FILE_SIGNATURE:
            raise ArchiveFormatError("ZIP local header is invalid")
        local_flags = _u16(local_header, 6)
        local_method = _u16(local_header, 8)
        local_name_length = _u16(local_header, 26)
        local_extra_length = _u16(local_header, 28)
        if local_flags != entry.flags:
            raise ArchiveFormatError("ZIP local header flags do not match central directory")
        if local_method != entry.compression_method:
            raise ArchiveFormatError("ZIP local header method does not match central directory")
        local_name = await self._read_exact(entry.local_header_offset + 30, local_name_length)
        if local_name != entry.raw_name:
            raise ArchiveFormatError("ZIP local header filename does not match central directory")
        data_offset = entry.local_header_offset + 30 + local_name_length + local_extra_length
        if data_offset + entry.compressed_size > self._size:
            raise ArchiveFormatError("ZIP member payload extends beyond archive bounds")
        return ValidatedZipEntry(entry, data_offset, self._validation_identity)

    async def stream_member(self, path: str, chunk_size: int = 262_144) -> AsyncIterator[bytes]:
        """Validate and stream a single permitted member without staging it."""

        entry = await self.validate_member(path)
        async for chunk in self.stream_validated_entry(entry, chunk_size=chunk_size):
            yield chunk

    async def stream_entry(self, entry: ZipEntry | ValidatedZipEntry, chunk_size: int = 262_144) -> AsyncIterator[bytes]:
        """Validate and stream a central-directory entry from this reader session."""

        validated_entry = entry if isinstance(entry, ValidatedZipEntry) else await self._validate_entry(entry)
        async for chunk in self.stream_validated_entry(validated_entry, chunk_size=chunk_size):
            yield chunk

    async def stream_validated_entry(self, validated_entry: ValidatedZipEntry, chunk_size: int = 262_144) -> AsyncIterator[bytes]:
        """Stream one local-header-validated entry without repeating validation."""

        if validated_entry.reader_identity is not self._validation_identity:
            raise ArchiveFormatError("ZIP member validation belongs to a different reader")
        if not 0 < chunk_size <= _ARCHIVE_IO_CHUNK_BYTES:
            raise ValueError(f"ZIP member chunk size must be between 1 and {_ARCHIVE_IO_CHUNK_BYTES} bytes")
        entry = validated_entry.entry
        data_offset = validated_entry.data_offset

        crc = 0
        total = 0

        def record_output(output: bytes) -> None:
            nonlocal crc, total
            if len(output) > entry.uncompressed_size - total:
                raise ArchiveFormatError("ZIP member exceeds its declared uncompressed size")
            crc = zlib.crc32(output, crc)
            total += len(output)

        offset = data_offset
        remaining = entry.compressed_size
        if entry.compression_method == 0:
            while remaining:
                part = await self._read_exact(offset, min(chunk_size, remaining))
                offset += len(part)
                remaining -= len(part)
                record_output(part)
                yield part
        elif entry.compression_method == 8:
            deflate_decompressor = zlib.decompressobj(-zlib.MAX_WBITS)
            while remaining and not deflate_decompressor.eof:
                part = await self._read_exact(offset, min(chunk_size, remaining))
                offset += len(part)
                remaining -= len(part)
                pending = part
                while pending and not deflate_decompressor.eof:
                    output = deflate_decompressor.decompress(pending, chunk_size)
                    pending = deflate_decompressor.unconsumed_tail
                    if output:
                        record_output(output)
                        yield output
            output = deflate_decompressor.flush(chunk_size)
            if output:
                record_output(output)
                yield output
            if not deflate_decompressor.eof:
                raise ArchiveFormatError("ZIP Deflate member is truncated")
        elif entry.compression_method == 12:
            bzip2_decompressor = bz2.BZ2Decompressor()
            while remaining and not bzip2_decompressor.eof:
                part = await self._read_exact(offset, min(chunk_size, remaining))
                offset += len(part)
                remaining -= len(part)
                pending = part
                while (pending or not bzip2_decompressor.needs_input) and not bzip2_decompressor.eof:
                    output = bzip2_decompressor.decompress(pending, max_length=chunk_size)
                    pending = b""
                    if output:
                        record_output(output)
                        yield output
                    if bzip2_decompressor.eof or bzip2_decompressor.needs_input:
                        break
            if not bzip2_decompressor.eof:
                raise ArchiveFormatError("ZIP BZIP2 member is truncated")
        else:
            raise ArchiveFormatError("Archive member codec is unavailable")
        if total != entry.uncompressed_size or crc & 0xFFFFFFFF != entry.crc32:
            raise ArchiveFormatError("ZIP member integrity check failed")
