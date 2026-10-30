"""Round-trip tests for direct portable ZIP creation."""

import io
import logging
import struct
import zipfile
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone

import pytest

from app.models.file import DirectoryListing, FileInfo, FileType
from app.services.archive.creation import ArchiveCreationCancelled, ArchiveCreationMemberOutcome, create_archive_from_files
from app.services.archive.zip_reader import ArchiveFormatError
from app.services.archive.zip_writer import PortableZipWriter


class MemoryExclusiveWriter:
    def __init__(self) -> None:
        self.data = bytearray()
        self.closed = False

    async def write(self, data: bytes) -> int:
        self.data.extend(data)
        return len(data)

    async def close(self) -> None:
        self.closed = True

    async def abort_and_delete_if_owned(self) -> bool:
        self.data.clear()
        return False


class CountingExclusiveWriter(MemoryExclusiveWriter):
    def __init__(self) -> None:
        super().__init__()
        self.write_sizes: list[int] = []

    async def write(self, data: bytes) -> int:
        self.write_sizes.append(len(data))
        return await super().write(data)

    @property
    def write_count(self) -> int:
        return len(self.write_sizes)


class ShortWritingExclusiveWriter(CountingExclusiveWriter):
    async def write(self, data: bytes) -> int:
        written = max(1, len(data) // 2)
        self.write_sizes.append(written)
        self.data.extend(data[:written])
        return written


class MemoryCreationBackend:
    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files
        self.directories: set[str] = set()
        for path in files:
            parent = path.rpartition("/")[0]
            while parent:
                self.directories.add(parent)
                parent = parent.rpartition("/")[0]
        self.target = MemoryExclusiveWriter()

    async def get_file_info(self, path: str) -> FileInfo:
        if path in self.files:
            return FileInfo(name=path.rsplit("/", 1)[-1], path=path, type=FileType.FILE, size=len(self.files[path]))
        if path in self.directories:
            return FileInfo(name=path.rsplit("/", 1)[-1], path=path, type=FileType.DIRECTORY)
        raise FileNotFoundError(path)

    async def list_directory(self, path: str = "") -> DirectoryListing:
        prefix = f"{path}/" if path else ""
        items: list[FileInfo] = []
        for candidate in sorted(self.directories | set(self.files)):
            if not candidate.startswith(prefix):
                continue
            relative = candidate[len(prefix) :]
            if "/" in relative:
                continue
            items.append(await self.get_file_info(candidate))
        return DirectoryListing(path=path, items=items, total=len(items))

    async def open_exclusive_writer(self, path: str) -> MemoryExclusiveWriter:
        return self.target

    async def _read(self, data: bytes) -> AsyncIterator[bytes]:
        yield data

    def read_file(self, path: str) -> AsyncIterator[bytes]:
        return self._read(self.files[path])


class MemoryCreationSource:
    def __init__(self, backend: MemoryCreationBackend) -> None:
        self.backend = backend

    async def get_file_info(self, path: str) -> FileInfo:
        return await self.backend.get_file_info(path)

    async def list_directory(self, path: str = "") -> DirectoryListing:
        return await self.backend.list_directory(path)

    def read_file(self, path: str) -> AsyncIterator[bytes]:
        return self.backend.read_file(path)


class MemoryCreationDestination:
    def __init__(self, backend: MemoryCreationBackend) -> None:
        self.backend = backend

    async def get_file_info(self, path: str) -> FileInfo:
        return await self.backend.get_file_info(path)

    async def open_exclusive_writer(self, path: str) -> MemoryExclusiveWriter:
        return await self.backend.open_exclusive_writer(path)


async def _chunks(data: bytes) -> AsyncIterator[bytes]:
    for position in range(0, len(data), 3):
        yield data[position : position + 3]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "modified",
    [
        datetime(2026, 1, 15, 11, 52, 2, tzinfo=timezone.utc),
        datetime(2026, 1, 15, 13, 52, 2, tzinfo=timezone(timedelta(hours=2))),
        datetime(2026, 1, 15, 11, 52, 2),
    ],
)
async def test_writer_encodes_utc_dos_clock_fields(modified):
    target = MemoryExclusiveWriter()
    writer = PortableZipWriter(target)
    await writer.add_file("file.txt", _chunks(b"content"), modified_at=modified)
    await writer.close()
    with zipfile.ZipFile(io.BytesIO(target.data)) as archive:
        assert archive.getinfo("file.txt").date_time == (2026, 1, 15, 11, 52, 2)


@pytest.mark.asyncio
async def test_writes_readable_portable_zip_without_source_staging() -> None:
    target = MemoryExclusiveWriter()
    writer = PortableZipWriter(target)

    await writer.add_directory("empty")
    await writer.add_file("notes.txt", _chunks(b"notes"))
    await writer.add_file("repeated.txt", _chunks(b"archive data " * 2_000))
    await writer.close()

    with zipfile.ZipFile(io.BytesIO(target.data)) as archive:
        assert archive.namelist() == ["empty/", "notes.txt", "repeated.txt"]
        assert archive.read("notes.txt") == b"notes"
        assert archive.read("repeated.txt") == b"archive data " * 2_000
        assert archive.getinfo("notes.txt").compress_type == zipfile.ZIP_STORED
        assert archive.getinfo("repeated.txt").compress_type == zipfile.ZIP_DEFLATED
    assert target.closed is True


@pytest.mark.asyncio
async def test_writes_zip64_records_when_the_local_header_offset_requires_them() -> None:
    target = MemoryExclusiveWriter()
    writer = PortableZipWriter(target)
    writer._offset = 0xFFFFFFFF

    await writer.add_file("offset.zip64", _chunks(b"content"))
    await writer.close()

    local_header = struct.unpack_from("<IHHHHHIIIHH", target.data)
    assert local_header[1] == 45
    assert local_header[7:9] == (0xFFFFFFFF, 0xFFFFFFFF)
    assert local_header[9] == len("offset.zip64")
    assert local_header[10] == 20
    assert b"PK\x01\x02" in target.data
    assert b"PK\x06\x06" in target.data
    assert b"PK\x06\x07" in target.data
    assert target.data[-22:-18] == b"PK\x05\x06"


@pytest.mark.asyncio
async def test_coalesces_local_and_central_directory_metadata_writes() -> None:
    target = CountingExclusiveWriter()
    writer = PortableZipWriter(target)

    await writer.add_directory("first")
    await writer.add_directory("second")
    await writer.add_directory("third")
    await writer.close()

    assert target.write_sizes[:6] == [len(b"first/") + 30, 16, len(b"second/") + 30, 16, len(b"third/") + 30, 16]
    assert target.write_sizes[-2] == 3 * 46 + len(b"first/second/third/")
    assert target.write_sizes[-1] == 22
    assert target.write_count == 8


@pytest.mark.asyncio
async def test_logs_aggregate_creation_metrics_without_member_name(caplog: pytest.LogCaptureFixture) -> None:
    target = MemoryExclusiveWriter()
    writer = PortableZipWriter(target)

    with caplog.at_level(logging.INFO, logger="app.services.archive.telemetry"):
        await writer.add_file("private-member.txt", _chunks(b"content"))
        await writer.close()

    message = next(record.getMessage() for record in caplog.records if "operation='archive_creation'" in record.getMessage())
    assert "entry_count=1" in message
    assert "metadata_write_operations=" in message
    assert "write_operations=" in message
    assert "private-member.txt" not in message


@pytest.mark.asyncio
async def test_coalesced_metadata_remains_valid_when_the_target_short_writes() -> None:
    target = ShortWritingExclusiveWriter()
    writer = PortableZipWriter(target)

    await writer.add_directory("first")
    await writer.add_directory("second")
    await writer.close()

    with zipfile.ZipFile(io.BytesIO(target.data)) as archive:
        assert archive.namelist() == ["first/", "second/"]


@pytest.mark.asyncio
async def test_bounds_buffered_central_directory_write_size() -> None:
    target = CountingExclusiveWriter()
    writer = PortableZipWriter(target)

    for index in range(5_000):
        await writer.add_directory(f"directory-{index:04d}")
    await writer.close()

    with zipfile.ZipFile(io.BytesIO(target.data)) as archive:
        assert len(archive.infolist()) == 5_000
    assert max(target.write_sizes) <= 256 * 1024


@pytest.mark.asyncio
async def test_rejects_oversized_source_before_writing_member_data() -> None:
    target = MemoryExclusiveWriter()
    writer = PortableZipWriter(target)

    with pytest.raises(ArchiveFormatError, match="exceeds its declared size"):
        await writer.add_file("notes.txt", _chunks(b"oversized"), expected_uncompressed_size=1)

    assert target.data == b""


@pytest.mark.asyncio
async def test_creates_direct_archive_from_regular_file_sources() -> None:
    backend = MemoryCreationBackend({"in/first.txt": b"first", "in/second.txt": b"second"})
    outcomes = []

    async def record_outcome(outcome):
        outcomes.append(outcome)

    result = await create_archive_from_files(
        backend,
        source_paths=["in/first.txt", "in/second.txt"],
        target_path="out.zip",
        on_member_completed=record_outcome,
    )

    assert result.files_created == 2
    assert result.source_bytes == 11
    assert outcomes == [
        ArchiveCreationMemberOutcome("first.txt", "created", 5),
        ArchiveCreationMemberOutcome("second.txt", "created", 6),
    ]
    with zipfile.ZipFile(io.BytesIO(backend.target.data)) as archive:
        assert archive.read("first.txt") == b"first"
        assert archive.read("second.txt") == b"second"


@pytest.mark.asyncio
async def test_creates_archive_through_separate_source_and_destination_adapters() -> None:
    backend = MemoryCreationBackend({"in/first.txt": b"first", "in/second.txt": b"second"})

    result = await create_archive_from_files(
        MemoryCreationSource(backend),
        destination=MemoryCreationDestination(backend),
        source_paths=["in/first.txt", "in/second.txt"],
        target_path="out.zip",
    )

    assert result.files_created == 2
    with zipfile.ZipFile(io.BytesIO(backend.target.data)) as archive:
        assert archive.read("first.txt") == b"first"
        assert archive.read("second.txt") == b"second"


@pytest.mark.asyncio
async def test_cancellation_deletes_the_owned_partial_target() -> None:
    backend = MemoryCreationBackend({"in/first.txt": b"first"})

    with pytest.raises(ArchiveCreationCancelled):
        await create_archive_from_files(
            backend,
            source_paths=["in/first.txt"],
            target_path="out.zip",
            is_cancelled=lambda: _cancelled(),
        )

    assert backend.target.data == b""


@pytest.mark.asyncio
async def test_creates_archive_from_directory_sources_with_explicit_directories() -> None:
    backend = MemoryCreationBackend({"input/empty/.keep": b"", "input/docs/readme.txt": b"readme"})
    backend.directories.add("input/empty-dir")

    result = await create_archive_from_files(backend, source_paths=["input"], target_path="out.zip")

    assert result.files_created == 2
    assert result.directories_created == 4
    with zipfile.ZipFile(io.BytesIO(backend.target.data)) as archive:
        assert archive.namelist() == [
            "input/",
            "input/docs/",
            "input/docs/readme.txt",
            "input/empty/",
            "input/empty/.keep",
            "input/empty-dir/",
        ]


@pytest.mark.asyncio
async def test_rejects_archive_target_inside_selected_directory() -> None:
    backend = MemoryCreationBackend({"input/readme.txt": b"readme"})

    with pytest.raises(ArchiveFormatError, match="inside a selected source directory"):
        await create_archive_from_files(backend, source_paths=["input"], target_path="input/out.zip")


@pytest.mark.asyncio
async def test_rejects_duplicate_normalized_member_names_before_opening_target() -> None:
    backend = MemoryCreationBackend({"first/Report.txt": b"first", "second/report.txt": b"second"})

    with pytest.raises(ArchiveFormatError, match="duplicate normalized entry names"):
        await create_archive_from_files(
            backend,
            source_paths=["first/Report.txt", "second/report.txt"],
            target_path="out.zip",
        )

    assert backend.target.data == b""


@pytest.mark.asyncio
async def test_rejects_existing_target_before_opening_writer() -> None:
    backend = MemoryCreationBackend({"input.txt": b"input", "out.zip": b"existing"})

    with pytest.raises(ArchiveFormatError, match="target already exists"):
        await create_archive_from_files(backend, source_paths=["input.txt"], target_path="out.zip")

    assert backend.target.data == b""


async def _cancelled() -> bool:
    return True
