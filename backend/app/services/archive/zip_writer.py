"""Portable ZIP creation directly to an exclusive final-target writer."""

import struct
import time
import unicodedata
import zlib
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timezone

from app.services.archive.telemetry import log_archive_operation_metrics
from app.services.archive.zip_reader import ArchiveFormatError
from app.storage.base import ExclusiveWriter

_ARCHIVE_IO_CHUNK_BYTES = 256 * 1024
_COMPRESSION_PROBE_BYTES = 64 * 1024
_STORED_SAVINGS_BYTES = 1024
_STORED_SAVINGS_RATIO = 0.05
_ZIP32_MAX = 0xFFFFFFFF
_ZIP16_MAX = 0xFFFF
_ZIP64_EXTRA_FIELD_ID = 0x0001
_ZIP64_VERSION_NEEDED = 45
_ZIP_VERSION_NEEDED = 20
_ZIP_VERSION_MADE_BY = 0x0314
_UTF8_FLAG = 0x0800
_DATA_DESCRIPTOR_FLAG = 0x0008
_STORED_METHOD = 0
_DEFLATE_METHOD = 8


@dataclass(frozen=True)
class _WrittenEntry:
    name: bytes
    flags: int
    method: int
    dos_time: int
    dos_date: int
    crc32: int
    compressed_size: int
    uncompressed_size: int
    local_offset: int
    is_directory: bool
    uses_zip64: bool


def _dos_time_and_date(modified_at: datetime | None) -> tuple[int, int]:
    """Write UTC clock fields; timezone-free inputs follow the DOS UTC fallback."""
    if modified_at is None:
        return 0, 0
    timestamp = modified_at.replace(tzinfo=timezone.utc) if modified_at.tzinfo is None else modified_at.astimezone(timezone.utc)
    if timestamp.year < 1980:
        return 0, 0
    year = min(timestamp.year, 2107) - 1980
    return (timestamp.hour << 11) | (timestamp.minute << 5) | (timestamp.second // 2), (year << 9) | (timestamp.month << 5) | timestamp.day


def _normalize_entry_name(name: str, *, directory: bool) -> str:
    normalized = name.replace("\\", "/").rstrip("/")
    segments = normalized.split("/")
    if (
        not normalized
        or normalized.startswith("/")
        or "\x00" in normalized
        or any(not part or part in {".", ".."} or ":" in part for part in segments)
    ):
        raise ArchiveFormatError("Archive output entry name is unsafe")
    return f"{normalized}/" if directory else normalized


class PortableZipWriter:
    """Writes UTF-8 Stored/Deflate ZIP entries without staging source members."""

    def __init__(self, writer: ExclusiveWriter) -> None:
        self._writer = writer
        self._offset = 0
        self._entries: list[_WrittenEntry] = []
        self._path_keys: set[str] = set()
        self._closed = False
        self._started_at = time.perf_counter()
        self._write_operations = 0
        self._write_bytes = 0
        self._metadata_write_operations = 0
        self._metadata_write_bytes = 0

    async def _write(self, data: bytes, *, metadata: bool = False) -> None:
        position = 0
        while position < len(data):
            written = await self._writer.write(data[position:])
            if written <= 0:
                raise OSError("Archive target writer accepted no bytes")
            self._write_operations += 1
            self._write_bytes += written
            if metadata:
                self._metadata_write_operations += 1
                self._metadata_write_bytes += written
            position += written
        self._offset += len(data)

    def _reserve_name(self, name: str, *, directory: bool) -> bytes:
        normalized = _normalize_entry_name(name, directory=directory)
        key = unicodedata.normalize("NFC", normalized.rstrip("/")).casefold()
        if key in self._path_keys:
            raise ArchiveFormatError("Archive output contains duplicate normalized entry names")
        self._path_keys.add(key)
        return normalized.encode("utf-8")

    async def add_directory(self, name: str, modified_at: datetime | None = None) -> None:
        """Emit an explicit empty directory entry."""

        entry_name = self._reserve_name(name, directory=True)
        await self._write_entry(entry_name, None, modified_at, is_directory=True)

    async def add_file(
        self,
        name: str,
        source: AsyncIterator[bytes],
        modified_at: datetime | None = None,
        *,
        expected_uncompressed_size: int | None = None,
    ) -> None:
        """Stream a regular file using the portable Stored/Deflate selection rule."""

        if expected_uncompressed_size is not None and expected_uncompressed_size < 0:
            raise ValueError("Expected archive source size cannot be negative")
        entry_name = self._reserve_name(name, directory=False)
        await self._write_entry(
            entry_name,
            source,
            modified_at,
            is_directory=False,
            expected_uncompressed_size=expected_uncompressed_size,
        )

    async def _write_entry(
        self,
        name: bytes,
        source: AsyncIterator[bytes] | None,
        modified_at: datetime | None,
        *,
        is_directory: bool,
        expected_uncompressed_size: int | None = None,
    ) -> None:
        if self._closed:
            raise ValueError("ZIP writer is already finalized")
        source = source or _empty_chunks()
        probe, remainder = await _read_probe(source)
        if expected_uncompressed_size is not None and len(probe) + len(remainder) > expected_uncompressed_size:
            raise ArchiveFormatError("Archive source exceeds its declared size")
        method = _STORED_METHOD if is_directory or _should_store(probe) else _DEFLATE_METHOD
        flags = _UTF8_FLAG | _DATA_DESCRIPTOR_FLAG
        dos_time, dos_date = _dos_time_and_date(modified_at)
        local_offset = self._offset
        uses_zip64 = _requires_zip64(local_offset) or (
            expected_uncompressed_size is not None and _requires_zip64(expected_uncompressed_size)
        )
        local_extra = _zip64_extra(0, 0) if uses_zip64 else b""
        size_placeholder = _ZIP32_MAX if uses_zip64 else 0
        version_needed = _ZIP64_VERSION_NEEDED if uses_zip64 else _ZIP_VERSION_NEEDED
        await self._write(
            struct.pack(
                "<IHHHHHIIIHH",
                0x04034B50,
                version_needed,
                flags,
                method,
                dos_time,
                dos_date,
                0,
                size_placeholder,
                size_placeholder,
                len(name),
                len(local_extra),
            )
            + name
            + local_extra,
            metadata=True,
        )

        crc = 0
        uncompressed_size = 0
        compressed_size = 0
        compressor = zlib.compressobj(level=6, wbits=-zlib.MAX_WBITS) if method == _DEFLATE_METHOD else None
        async for chunk in _prepend_chunks(probe, remainder, source):
            if not chunk:
                continue
            if expected_uncompressed_size is not None and len(chunk) > expected_uncompressed_size - uncompressed_size:
                raise ArchiveFormatError("Archive source exceeds its declared size")
            crc = zlib.crc32(chunk, crc)
            uncompressed_size += len(chunk)
            output = compressor.compress(chunk) if compressor is not None else chunk
            if output:
                await self._write(output)
                compressed_size += len(output)
        if compressor is not None:
            output = compressor.flush()
            if output:
                await self._write(output)
                compressed_size += len(output)

        if expected_uncompressed_size is not None and uncompressed_size != expected_uncompressed_size:
            raise ArchiveFormatError("Archive source size does not match its manifest")

        if not uses_zip64 and (_requires_zip64(compressed_size) or _requires_zip64(uncompressed_size)):
            raise ArchiveFormatError("Archive source exceeded the ZIP32 size reserved for its streamed entry")
        if uses_zip64:
            await self._write(struct.pack("<IIQQ", 0x08074B50, crc & _ZIP32_MAX, compressed_size, uncompressed_size), metadata=True)
        else:
            await self._write(struct.pack("<IIII", 0x08074B50, crc & _ZIP32_MAX, compressed_size, uncompressed_size), metadata=True)
        self._entries.append(
            _WrittenEntry(
                name,
                flags,
                method,
                dos_time,
                dos_date,
                crc & _ZIP32_MAX,
                compressed_size,
                uncompressed_size,
                local_offset,
                is_directory,
                uses_zip64,
            )
        )

    async def close(self) -> None:
        """Write central-directory records and close the final target."""

        if self._closed:
            return
        directory_offset = self._offset
        central_directory = bytearray()

        async def append_central_record(record: bytes) -> None:
            if central_directory and len(central_directory) + len(record) > _ARCHIVE_IO_CHUNK_BYTES:
                await self._write(bytes(central_directory), metadata=True)
                central_directory.clear()
            if len(record) > _ARCHIVE_IO_CHUNK_BYTES:
                await self._write(record, metadata=True)
                return
            central_directory.extend(record)

        for entry in self._entries:
            external_attributes = 0x10 if entry.is_directory else 0
            uses_zip64 = entry.uses_zip64 or any(
                _requires_zip64(value) for value in (entry.compressed_size, entry.uncompressed_size, entry.local_offset)
            )
            central_extra = _zip64_extra(entry.uncompressed_size, entry.compressed_size, entry.local_offset) if uses_zip64 else b""
            size_value = _ZIP32_MAX if uses_zip64 else entry.compressed_size
            uncompressed_value = _ZIP32_MAX if uses_zip64 else entry.uncompressed_size
            offset_value = _ZIP32_MAX if uses_zip64 else entry.local_offset
            version_needed = _ZIP64_VERSION_NEEDED if uses_zip64 else _ZIP_VERSION_NEEDED
            version_made_by = (_ZIP_VERSION_MADE_BY & 0xFF00) | version_needed
            await append_central_record(
                struct.pack(
                    "<IHHHHHHIIIHHHHHII",
                    0x02014B50,
                    version_made_by,
                    version_needed,
                    entry.flags,
                    entry.method,
                    entry.dos_time,
                    entry.dos_date,
                    entry.crc32,
                    size_value,
                    uncompressed_value,
                    len(entry.name),
                    len(central_extra),
                    0,
                    0,
                    0,
                    external_attributes,
                    offset_value,
                )
                + entry.name
                + central_extra
            )
        if central_directory:
            await self._write(bytes(central_directory), metadata=True)
        directory_size = self._offset - directory_offset
        requires_zip64_directory = len(self._entries) >= _ZIP16_MAX or _requires_zip64(directory_offset) or _requires_zip64(directory_size)
        if requires_zip64_directory:
            zip64_directory_offset = self._offset
            await self._write(
                struct.pack(
                    "<IQHHIIQQQQ",
                    0x06064B50,
                    44,
                    _ZIP64_VERSION_NEEDED,
                    _ZIP64_VERSION_NEEDED,
                    0,
                    0,
                    len(self._entries),
                    len(self._entries),
                    directory_size,
                    directory_offset,
                ),
                metadata=True,
            )
            await self._write(struct.pack("<IIQI", 0x07064B50, 0, zip64_directory_offset, 1), metadata=True)
        await self._write(
            struct.pack(
                "<IHHHHIIH",
                0x06054B50,
                0,
                0,
                _ZIP16_MAX if requires_zip64_directory else len(self._entries),
                _ZIP16_MAX if requires_zip64_directory else len(self._entries),
                _ZIP32_MAX if requires_zip64_directory else directory_size,
                _ZIP32_MAX if requires_zip64_directory else directory_offset,
                0,
            ),
            metadata=True,
        )
        self._closed = True
        await self._writer.close()
        log_archive_operation_metrics(
            "archive_creation",
            (time.perf_counter() - self._started_at) * 1000,
            {
                "entry_count": len(self._entries),
                "metadata_write_bytes": self._metadata_write_bytes,
                "metadata_write_operations": self._metadata_write_operations,
                "write_bytes": self._write_bytes,
                "write_operations": self._write_operations,
            },
        )


async def _empty_chunks() -> AsyncIterator[bytes]:
    empty: tuple[bytes, ...] = ()
    for chunk in empty:
        yield chunk


async def _read_probe(source: AsyncIterator[bytes]) -> tuple[bytes, bytes]:
    probe = bytearray()
    remainder = b""
    async for chunk in source:
        if len(probe) + len(chunk) <= _COMPRESSION_PROBE_BYTES:
            probe.extend(chunk)
            if len(probe) == _COMPRESSION_PROBE_BYTES:
                break
            continue
        required = _COMPRESSION_PROBE_BYTES - len(probe)
        probe.extend(chunk[:required])
        remainder = chunk[required:]
        break
    return bytes(probe), remainder


async def _prepend_chunks(probe: bytes, remainder: bytes, source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    if probe:
        yield probe
    if remainder:
        yield remainder
    async for chunk in source:
        yield chunk


def _should_store(probe: bytes) -> bool:
    if not probe:
        return True
    compressed = zlib.compress(probe, level=6)
    savings = len(probe) - len(compressed)
    return savings < _STORED_SAVINGS_BYTES and savings / len(probe) < _STORED_SAVINGS_RATIO


def _requires_zip64(value: int) -> bool:
    return value >= _ZIP32_MAX


def _zip64_extra(*values: int) -> bytes:
    return struct.pack(f"<HH{'Q' * len(values)}", _ZIP64_EXTRA_FIELD_ID, len(values) * 8, *values)
