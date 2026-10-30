"""Unit tests for the bounded custom ZIP metadata reader."""

import bz2
import io
import math
import struct
import zipfile
import zlib
from datetime import datetime, timezone

import pytest

from app.services.archive.zip_reader import ArchiveFormatError, ZipReader, _dos_datetime


class MemoryRandomAccessReader:
    """In-memory reader used only to exercise archive metadata parsing."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.closed = False

    async def read_at(self, offset: int, length: int) -> bytes:
        return self.data[offset : offset + length]

    async def close(self) -> None:
        self.closed = True


class CountingRandomAccessReader(MemoryRandomAccessReader):
    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.reads: list[tuple[int, int]] = []

    async def read_at(self, offset: int, length: int) -> bytes:
        self.reads.append((offset, length))
        return await super().read_at(offset, length)

    @property
    def read_count(self) -> int:
        return len(self.reads)

    @property
    def total_bytes_read(self) -> int:
        return sum(length for _, length in self.reads)


def _zip_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("root.txt", "root")
        archive.writestr("folder/nested.txt", "nested")
        archive.writestr("folder/deeper/item.txt", "item")
    return buffer.getvalue()


def _symbolic_link_zip_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        member = zipfile.ZipInfo("link")
        member.create_system = 3
        member.external_attr = 0o120777 << 16
        archive.writestr(member, "target")
    return buffer.getvalue()


def _large_directory_zip_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for index in range(10_000):
            archive.writestr(f"directory/{index:05d}-{'x' * 64}.txt", b"")
    return buffer.getvalue()


def _duplicate_name_zip_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("duplicate.txt", b"first")
        with pytest.warns(UserWarning, match=r"^Duplicate name: 'duplicate\.txt'$"):
            archive.writestr("duplicate.txt", b"second entry")
    return buffer.getvalue()


@pytest.mark.asyncio
@pytest.mark.parametrize("month", [1, 7])
async def test_dos_member_timestamps_use_utc(month):
    expected = datetime(2026, month, 15, 11, 52, 2, tzinfo=timezone.utc)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(zipfile.ZipInfo("file.txt", date_time=expected.timetuple()[:6]), b"content")
    data = buffer.getvalue()
    reader = ZipReader(MemoryRandomAccessReader(data), len(data))
    entry = await reader.next_entry()
    assert entry is not None
    assert entry.modified_at == expected
    assert entry.modified_at.tzinfo == timezone.utc


def test_invalid_dos_timestamp_is_unavailable():
    assert _dos_datetime(0, 0) is None


@pytest.mark.asyncio
async def test_reads_central_directory_records_forward_in_archive_order() -> None:
    data = _zip_bytes()
    reader = ZipReader(MemoryRandomAccessReader(data), len(data))

    entries: list[str] = []
    while (entry := await reader.next_entry()) is not None:
        entries.append(entry.path)

    assert entries == ["root.txt", "folder/nested.txt", "folder/deeper/item.txt"]
    assert await reader.next_entry() is None


@pytest.mark.asyncio
async def test_inspection_page_continues_from_a_record_boundary_without_a_manifest() -> None:
    data = _zip_bytes()
    first_reader = ZipReader(MemoryRandomAccessReader(data), len(data))
    first_page, cursor = await first_reader.inspection_page(None, 1)
    second_reader = ZipReader(MemoryRandomAccessReader(data), len(data))
    second_page, next_cursor = await second_reader.inspection_page(cursor, 1)

    assert [entry.path for entry in first_page] == ["root.txt"]
    assert [entry.path for entry in second_page] == ["folder/nested.txt"]
    assert next_cursor is not None


def _zip_with_underreported_size(compression: int) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=compression) as archive:
        archive.writestr("data.txt", b"oversized member")
    data = bytearray(buffer.getvalue())
    central_offset = data.index(b"PK\x01\x02")
    struct.pack_into("<I", data, central_offset + 24, 1)
    return bytes(data)


def _encoded_member_data(compression: int, content: bytes) -> bytes:
    if compression == zipfile.ZIP_DEFLATED:
        compressor = zlib.compressobj(wbits=-zlib.MAX_WBITS)
        return compressor.compress(content) + compressor.flush()
    if compression == zipfile.ZIP_BZIP2:
        return bz2.compress(content)
    raise ValueError(f"Unsupported test compression method: {compression}")


def _zip_with_trailing_compressed_data(compression: int, trailing_data: bytes) -> tuple[bytes, bytes]:
    content = b"verified compatibility payload"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=compression) as archive:
        archive.writestr("data.txt", content)
    data = bytearray(buffer.getvalue())
    local_offset = data.index(b"PK\x03\x04")
    central_offset = data.index(b"PK\x01\x02")
    eocd_offset = data.rindex(b"PK\x05\x06")
    compressed_size = struct.unpack_from("<I", data, central_offset + 20)[0]

    data[central_offset:central_offset] = trailing_data
    central_offset += len(trailing_data)
    eocd_offset += len(trailing_data)
    struct.pack_into("<I", data, local_offset + 18, compressed_size + len(trailing_data))
    struct.pack_into("<I", data, central_offset + 20, compressed_size + len(trailing_data))
    directory_offset = struct.unpack_from("<I", data, eocd_offset + 16)[0]
    struct.pack_into("<I", data, eocd_offset + 16, directory_offset + len(trailing_data))
    return bytes(data), content


def _zip_with_truncated_compressed_data(compression: int) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=compression) as archive:
        archive.writestr("data.txt", b"verified compatibility payload")
    data = bytearray(buffer.getvalue())
    local_offset = data.index(b"PK\x03\x04")
    central_offset = data.index(b"PK\x01\x02")
    compressed_size = struct.unpack_from("<I", data, central_offset + 20)[0]
    assert compressed_size > 1
    struct.pack_into("<I", data, local_offset + 18, compressed_size - 1)
    struct.pack_into("<I", data, central_offset + 20, compressed_size - 1)
    return bytes(data)


def _zip_with_malformed_utf8_flagged_name() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("name.txt", b"content")
    data = bytearray(buffer.getvalue())
    local_offset = data.index(b"PK\x03\x04")
    central_offset = data.index(b"PK\x01\x02")
    raw_name = b"bad\xff.txt"
    assert len(raw_name) == len(b"name.txt")
    data[local_offset + 7] |= 0x08
    data[central_offset + 9] |= 0x08
    data[local_offset + 30 : local_offset + 30 + len(raw_name)] = raw_name
    data[central_offset + 46 : central_offset + 46 + len(raw_name)] = raw_name
    return bytes(data)


def _zip_with_unicode_path_extra(*, valid_crc: bool) -> bytes:
    raw_name = b"cafe.txt"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("cafe.txt", "content")
    data = bytearray(buffer.getvalue())
    local_offset = data.index(b"PK\x03\x04")
    central_offset = data.index(b"PK\x01\x02")
    data[local_offset + 30 : local_offset + 30 + len(raw_name)] = raw_name
    data[central_offset + 46 : central_offset + 46 + len(raw_name)] = raw_name
    crc32 = zlib.crc32(raw_name) & 0xFFFFFFFF
    unicode_extra = (
        struct.pack("<HHBI", 0x7075, 1 + 4 + len("café.txt".encode()), 1, crc32 if valid_crc else crc32 ^ 1) + "café.txt".encode()
    )
    name_length = struct.unpack_from("<H", data, central_offset + 28)[0]
    struct.pack_into("<H", data, central_offset + 30, len(unicode_extra))
    insert_at = central_offset + 46 + name_length
    data[insert_at:insert_at] = unicode_extra
    eocd_offset = data.rindex(b"PK\x05\x06")
    directory_size = struct.unpack_from("<I", data, eocd_offset + 12)[0]
    struct.pack_into("<I", data, eocd_offset + 12, directory_size + len(unicode_extra))
    return bytes(data)


@pytest.mark.asyncio
async def test_inspection_page_returns_archive_records_without_inferred_directories() -> None:
    data = _zip_bytes()
    entries, cursor = await ZipReader(MemoryRandomAccessReader(data), len(data)).inspection_page(None, 10)

    assert [entry.path for entry in entries] == ["root.txt", "folder/nested.txt", "folder/deeper/item.txt"]
    assert cursor is None


@pytest.mark.asyncio
async def test_rejects_non_zip_bytes() -> None:
    reader = ZipReader(MemoryRandomAccessReader(b"not a zip" * 4), len(b"not a zip" * 4))

    with pytest.raises(ArchiveFormatError, match="end-of-central-directory"):
        await reader.next_entry()


@pytest.mark.asyncio
async def test_streams_and_verifies_deflated_member() -> None:
    data = _zip_bytes()
    reader = ZipReader(MemoryRandomAccessReader(data), len(data))

    chunks = [chunk async for chunk in reader.stream_member("folder/nested.txt", chunk_size=2)]

    assert b"".join(chunks) == b"nested"


@pytest.mark.asyncio
async def test_rejects_invalid_member_stream_chunk_sizes() -> None:
    data = _zip_bytes()
    reader = ZipReader(MemoryRandomAccessReader(data), len(data))

    with pytest.raises(ValueError, match="between 1"):
        await anext(reader.stream_member("folder/nested.txt", chunk_size=0))


@pytest.mark.asyncio
async def test_normalizes_backslash_member_names() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("folder\\entry.txt", "entry")
    data = buffer.getvalue()

    entry = await ZipReader(MemoryRandomAccessReader(data), len(data)).next_entry()

    assert entry is not None
    assert entry.path == "folder/entry.txt"
    assert entry.is_directory is False


@pytest.mark.asyncio
async def test_uses_validated_infozip_unicode_path_for_unflagged_names() -> None:
    data = _zip_with_unicode_path_extra(valid_crc=True)

    entry = await ZipReader(MemoryRandomAccessReader(data), len(data)).next_entry()

    assert entry is not None
    assert entry.path == "café.txt"


@pytest.mark.asyncio
async def test_ignores_infozip_unicode_path_when_its_crc_does_not_match() -> None:
    data = _zip_with_unicode_path_extra(valid_crc=False)

    entry = await ZipReader(MemoryRandomAccessReader(data), len(data)).next_entry()

    assert entry is not None
    assert entry.path == "cafe.txt"


@pytest.mark.asyncio
async def test_rejects_symbolic_link_members_from_virtual_listings() -> None:
    data = _symbolic_link_zip_bytes()

    with pytest.raises(ArchiveFormatError, match="unsafe or unsupported"):
        await ZipReader(MemoryRandomAccessReader(data), len(data)).inspection_page(None, 10)


@pytest.mark.asyncio
async def test_streams_bzip2_member_in_bounded_chunks() -> None:
    buffer = io.BytesIO()
    expected = b"bounded bzip2 member " * 20_000
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_BZIP2) as archive:
        archive.writestr("data.txt", expected)
    data = buffer.getvalue()

    chunks = [chunk async for chunk in ZipReader(MemoryRandomAccessReader(data), len(data)).stream_member("data.txt", chunk_size=1024)]

    assert b"".join(chunks) == expected
    assert max(map(len, chunks)) <= 1024


@pytest.mark.asyncio
@pytest.mark.parametrize("compression", [zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2])
async def test_streams_verified_member_with_trailing_compressed_data(compression: int) -> None:
    for trailing_data in (b"producer padding", _encoded_member_data(compression, b"second member stream")):
        data, expected = _zip_with_trailing_compressed_data(compression, trailing_data)
        reader = ZipReader(MemoryRandomAccessReader(data), len(data))

        chunks = [chunk async for chunk in reader.stream_member("data.txt", chunk_size=1)]

        assert b"".join(chunks) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("compression", [zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2])
async def test_rejects_truncated_compressed_member(compression: int) -> None:
    data = _zip_with_truncated_compressed_data(compression)
    reader = ZipReader(MemoryRandomAccessReader(data), len(data))

    with pytest.raises(ArchiveFormatError, match="truncated|integrity"):
        _ = [chunk async for chunk in reader.stream_member("data.txt")]


@pytest.mark.asyncio
async def test_recovers_malformed_utf8_flagged_name_with_replacement() -> None:
    data = _zip_with_malformed_utf8_flagged_name()

    entry = await ZipReader(MemoryRandomAccessReader(data), len(data)).next_entry()

    assert entry is not None
    assert entry.path == "bad\ufffd.txt"
    assert entry.is_safe is True


@pytest.mark.asyncio
@pytest.mark.parametrize("compression", [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2])
async def test_rejects_member_before_yielding_bytes_beyond_its_declared_size(compression: int) -> None:
    reader = ZipReader(MemoryRandomAccessReader(_zip_with_underreported_size(compression)), len(_zip_with_underreported_size(compression)))
    chunks: list[bytes] = []

    with pytest.raises(ArchiveFormatError, match="exceeds its declared"):
        async for chunk in reader.stream_member("data.txt", chunk_size=1):
            chunks.append(chunk)

    assert len(b"".join(chunks)) <= 1


@pytest.mark.asyncio
async def test_reads_central_directory_in_bounded_sequential_chunks() -> None:
    data = _large_directory_zip_bytes()
    reader_source = CountingRandomAccessReader(data)

    reader = ZipReader(reader_source, len(data))
    entry_count = 0
    while await reader.next_entry() is not None:
        entry_count += 1

    eocd_offset = data.rindex(b"PK\x05\x06")
    directory_size = struct.unpack_from("<I", data, eocd_offset + 12)[0]
    assert entry_count == 10_000
    assert reader_source.read_count == 1 + math.ceil(directory_size / (256 * 1024))
    assert all(length <= 256 * 1024 for _, length in reader_source.reads[1:])


@pytest.mark.asyncio
async def test_inspection_page_preserves_duplicate_records_in_archive_order() -> None:
    data = _duplicate_name_zip_bytes()
    reader = ZipReader(MemoryRandomAccessReader(data), len(data))
    entries, cursor = await reader.inspection_page(None, 10)

    assert [(entry.path, entry.uncompressed_size) for entry in entries] == [
        ("duplicate.txt", len(b"first")),
        ("duplicate.txt", len(b"second entry")),
    ]
    assert cursor is None


@pytest.mark.asyncio
async def test_rejects_validated_descriptor_from_another_reader() -> None:
    data = _zip_bytes()
    first_reader = ZipReader(MemoryRandomAccessReader(data), len(data))
    second_reader = ZipReader(MemoryRandomAccessReader(data), len(data))
    validated_entry = await first_reader.validate_member("root.txt")

    with pytest.raises(ArchiveFormatError, match="different reader"):
        await anext(second_reader.stream_validated_entry(validated_entry))


@pytest.mark.asyncio
async def test_rejects_raw_entry_from_another_reader_without_searching_its_entries() -> None:
    data = _zip_bytes()
    first_reader = ZipReader(MemoryRandomAccessReader(data), len(data))
    second_reader = ZipReader(MemoryRandomAccessReader(data), len(data))
    entry = await first_reader.next_entry()

    assert entry is not None

    with pytest.raises(ArchiveFormatError, match="member was not found"):
        await anext(second_reader.stream_entry(entry))


@pytest.mark.asyncio
async def test_stream_entry_reads_local_header_once_after_validation() -> None:
    data = _zip_bytes()
    reader_source = CountingRandomAccessReader(data)
    reader = ZipReader(reader_source, len(data))
    entry = await reader.next_entry()

    assert entry is not None
    reader_source.reads.clear()

    chunks = [chunk async for chunk in reader.stream_entry(entry)]

    assert b"".join(chunks) == b"root"
    assert reader_source.reads.count((entry.local_header_offset, 30)) == 1
