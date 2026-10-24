"""Tests for same-executor direct ZIP extraction."""

import io
import json
import zipfile
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from app.models.file import DirectoryListing, FileInfo, FileType
from app.services.archive.extraction import (
    ArchiveExtractionCancelled,
    ArchiveExtractionMemberError,
    extract_archive_to_new_paths,
    extract_live_archive_to_new_paths,
)
from app.services.archive.live_extraction import DestinationWriteResult, LiveSourceSession, LiveSourceSessionError, LiveSourceSessionPhase
from app.services.archive.target_write import (
    ResolvedCollisionPolicy,
    TargetExistsBeforeContent,
    TargetSnapshot,
    TargetWriteDisposition,
    TargetWriteFailure,
    TargetWriteResult,
    collision_policy_from_action,
    resolve_target_write,
    resolve_target_write_attempt,
)
from app.services.archive.zip_reader import ZipReader

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_TESTDATA_ROOT = WORKSPACE_ROOT / "archive_testdata"
EXTRACTION_OUTCOME_CORPUS_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "fixtures" / "extraction-outcome-scenarios-v2.json"
TARGET_WRITE_CORPUS_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "fixtures" / "target-write-resolution-scenarios-v2.json"
TOPOLOGY_TRACE_FIXTURE_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "fixtures" / "topology-execution-traces-v2.json"
ARCHIVE_CONTRACT_SCHEMA_PATH = WORKSPACE_ROOT / "archive-contract" / "v2" / "schema.json"


class MemoryRandomReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.closed = False
        self.reads: list[tuple[int, int]] = []

    async def read_at(self, offset: int, length: int) -> bytes:
        self.reads.append((offset, length))
        return self.data[offset : offset + length]

    async def close(self) -> None:
        self.closed = True


class MemoryExtractionBackend:
    def __init__(self, archive: bytes) -> None:
        self.archive = archive
        self.reader = MemoryRandomReader(archive)
        self.directories: set[str] = set()
        self.files: dict[str, bytes] = {}
        self.modified_at: dict[str, datetime] = {}
        self.file_info_paths: list[str] = []
        self.listed_paths: list[str] = []
        self.created_directory_paths: list[str] = []
        self.written_file_paths: list[str] = []

    async def get_file_info(self, path: str) -> FileInfo:
        self.file_info_paths.append(path)
        if path == "input.zip":
            return FileInfo(name="input.zip", path=path, type=FileType.FILE, size=len(self.archive))
        if path in self.directories:
            return FileInfo(name=path.rsplit("/", 1)[-1], path=path, type=FileType.DIRECTORY)
        if path in self.files:
            return FileInfo(
                name=path.rsplit("/", 1)[-1],
                path=path,
                type=FileType.FILE,
                size=len(self.files[path]),
                modified_at=self.modified_at.get(path),
            )
        raise FileNotFoundError(path)

    async def list_directory(self, path: str = "") -> DirectoryListing:
        self.listed_paths.append(path)
        if path in self.files:
            raise NotADirectoryError(path)
        if path and path not in self.directories:
            raise FileNotFoundError(path)
        prefix = f"{path}/" if path else ""
        items = [
            await self.get_file_info(candidate)
            for candidate in sorted(self.directories | set(self.files))
            if candidate.startswith(prefix) and "/" not in candidate[len(prefix) :]
        ]
        return DirectoryListing(path=path, items=items, total=len(items))

    async def open_random_access_reader(self, path: str) -> MemoryRandomReader:
        assert path == "input.zip"
        return self.reader

    async def open_archive_source_reader(self, path: str) -> MemoryRandomReader:
        return await self.open_random_access_reader(path)

    async def create_directory(self, path: str) -> None:
        self.created_directory_paths.append(path)
        if path in self.directories or path in self.files:
            raise FileExistsError(path)
        self.directories.add(path)

    async def write_file_from_stream(
        self,
        path: str,
        stream: AsyncIterator[bytes],
        *,
        overwrite: bool = False,
        source_mtime: object | None = None,
    ) -> int:
        del source_mtime
        self.written_file_paths.append(path)
        replaced = path in self.files and overwrite
        if path in self.files and not overwrite:
            raise FileExistsError(path)
        content = b"".join([chunk async for chunk in stream])
        self.files[path] = content
        return TargetWriteResult(len(content), replaced=replaced)


class CaseInsensitiveMemoryExtractionBackend(MemoryExtractionBackend):
    async def get_file_info(self, path: str) -> FileInfo:
        if path != "input.zip":
            matching_path = next(
                (candidate for candidate in self.directories | set(self.files) if candidate.casefold() == path.casefold()),
                None,
            )
            if matching_path is not None:
                return await super().get_file_info(matching_path)
        return await super().get_file_info(path)


class MemoryExtractionSource:
    def __init__(self, backend: MemoryExtractionBackend) -> None:
        self.backend = backend

    async def get_file_info(self, path: str) -> FileInfo:
        return await self.backend.get_file_info(path)

    async def open_random_access_reader(self, path: str) -> MemoryRandomReader:
        return await self.backend.open_random_access_reader(path)

    async def open_archive_source_reader(self, path: str) -> MemoryRandomReader:
        return await self.backend.open_archive_source_reader(path)


class MemoryExtractionDestination:
    def __init__(self, backend: MemoryExtractionBackend) -> None:
        self.backend = backend

    async def get_file_info(self, path: str) -> FileInfo:
        return await self.backend.get_file_info(path)

    async def list_directory(self, path: str = "") -> DirectoryListing:
        return await self.backend.list_directory(path)

    async def create_directory(self, path: str) -> None:
        await self.backend.create_directory(path)

    async def write_file_from_stream(
        self,
        path: str,
        stream: AsyncIterator[bytes],
        *,
        overwrite: bool = False,
        source_mtime: datetime | None = None,
    ) -> int:
        return await self.backend.write_file_from_stream(path, stream, overwrite=overwrite, source_mtime=source_mtime)


class NonListingMemoryExtractionDestination:
    def __init__(self, backend: MemoryExtractionBackend) -> None:
        self.backend = backend

    async def get_file_info(self, path: str) -> FileInfo:
        return await self.backend.get_file_info(path)

    async def create_directory(self, path: str) -> None:
        await self.backend.create_directory(path)

    async def write_file_from_stream(
        self,
        path: str,
        stream: AsyncIterator[bytes],
        *,
        overwrite: bool = False,
        source_mtime: datetime | None = None,
    ) -> int:
        return await self.backend.write_file_from_stream(path, stream, overwrite=overwrite, source_mtime=source_mtime)


def _archive_bytes() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("docs/readme.txt", "readme")
        archive.writestr("root.txt", "root")
    return output.getvalue()


def _flat_archive_bytes(member_names: list[str]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for member_name in member_names:
            archive.writestr(member_name, member_name)
    return output.getvalue()


@pytest.mark.asyncio
async def test_live_extraction_streams_members_in_record_order_without_preflight() -> None:
    backend = MemoryExtractionBackend(_archive_bytes())
    source_session = LiveSourceSession(ZipReader(backend.reader, len(backend.archive)))

    aggregate = await extract_live_archive_to_new_paths(
        source_session,
        destination=backend,
        destination_root="output",
        existing_file_policy=None,
    )

    assert backend.written_file_paths == ["output/docs/readme.txt", "output/root.txt"]
    assert backend.listed_paths == []
    assert aggregate.members_processed == 2
    assert aggregate.members_completed == 2
    assert aggregate.files_extracted == 2
    assert aggregate.extracted_bytes == len(b"readme") + len(b"root")
    assert source_session.phase == LiveSourceSessionPhase.COMPLETED


@pytest.mark.asyncio
async def test_live_extraction_limits_delivery_to_selected_member_roots() -> None:
    backend = MemoryExtractionBackend(_flat_archive_bytes(["included/empty/", "included/report.txt", "excluded/secret.txt"]))
    source_session = LiveSourceSession(
        ZipReader(backend.reader, len(backend.archive)), selected_member_roots=("included", "included/report.txt")
    )

    aggregate = await extract_live_archive_to_new_paths(
        source_session,
        destination=backend,
        destination_root="output",
        existing_file_policy=None,
    )

    assert {"output", "output/included", "output/included/empty"}.issubset(backend.directories)
    assert backend.written_file_paths == ["output/included/report.txt"]
    assert "output/excluded" not in backend.directories
    assert aggregate.members_processed == 2
    assert source_session.phase == LiveSourceSessionPhase.COMPLETED


@pytest.mark.asyncio
async def test_live_extraction_rejects_selected_roots_absent_from_archive() -> None:
    backend = MemoryExtractionBackend(_flat_archive_bytes(["included/report.txt"]))
    source_session = LiveSourceSession(ZipReader(backend.reader, len(backend.archive)), selected_member_roots=("missing",))

    with pytest.raises(Exception, match="selection does not match"):
        await source_session.next_member()


@pytest.mark.asyncio
async def test_live_extraction_retains_current_member_for_a_collision_decision() -> None:
    backend = MemoryExtractionBackend(_flat_archive_bytes(["first.txt"]))
    backend.files["output/first.txt"] = b"existing"
    source_session = LiveSourceSession(ZipReader(backend.reader, len(backend.archive)))

    aggregate = await extract_live_archive_to_new_paths(
        source_session,
        destination=backend,
        destination_root="output",
        existing_file_policy=None,
    )

    decision = await source_session.pending_decision()
    assert aggregate.members_processed == 0
    assert source_session.phase == LiveSourceSessionPhase.AWAITING_DECISION
    assert decision is not None
    assert decision.member_path == "first.txt"
    assert backend.written_file_paths == []


@pytest.mark.asyncio
async def test_live_extraction_selects_the_last_replacement_decoded_name() -> None:
    archive = (ARCHIVE_TESTDATA_ROOT / "compat-names.zip").read_bytes()
    backend = MemoryExtractionBackend(archive)
    source_session = LiveSourceSession(ZipReader(backend.reader, len(archive)))

    aggregate = await extract_live_archive_to_new_paths(
        source_session,
        destination=backend,
        destination_root="output",
        existing_file_policy=None,
    )

    assert aggregate.members_processed == 2
    assert aggregate.members_completed == 1
    assert aggregate.members_skipped == 1
    assert source_session.phase == LiveSourceSessionPhase.COMPLETED
    assert backend.written_file_paths == ["output/bad\ufffd.txt"]
    assert backend.files == {"output/bad\ufffd.txt": b"replacement name"}


@pytest.mark.asyncio
async def test_live_extraction_retains_a_regular_member_when_its_parent_is_a_file() -> None:
    backend = MemoryExtractionBackend(_flat_archive_bytes(["parent/file.txt"]))
    backend.files["output/parent"] = b"blocked"
    source_session = LiveSourceSession(ZipReader(backend.reader, len(backend.archive)))

    aggregate = await extract_live_archive_to_new_paths(
        source_session,
        destination=backend,
        destination_root="output",
        existing_file_policy=None,
    )

    decision = await source_session.pending_decision()
    assert aggregate.members_processed == 0
    assert source_session.phase == LiveSourceSessionPhase.AWAITING_DECISION
    assert decision is not None
    assert decision.member_path == "parent/file.txt"
    assert decision.target_path == "output/parent"
    assert backend.written_file_paths == []

    member = await source_session.current_member()
    assert member is not None
    redelivery = await source_session.resolve_decision(
        member.source_session_id,
        member.delivery_sequence,
        decision.revision,
        "rename",
        "renamed/file.txt",
    )
    assert redelivery is not None
    aggregate = await extract_live_archive_to_new_paths(
        source_session,
        destination=backend,
        destination_root="output",
        existing_file_policy=None,
    )

    assert aggregate.members_processed == 1
    assert aggregate.members_completed == 1
    assert backend.files["renamed/file.txt"] == b"parent/file.txt"


@pytest.mark.asyncio
async def test_live_source_rejects_stale_collision_decision_revisions() -> None:
    backend = MemoryExtractionBackend(_flat_archive_bytes(["first.txt"]))
    source_session = LiveSourceSession(ZipReader(backend.reader, len(backend.archive)))
    member = await source_session.next_member()

    assert member is not None
    await source_session.apply_destination_write_result(
        DestinationWriteResult(
            member.source_session_id,
            member.delivery_sequence,
            member.path,
            "awaiting_collision",
            target_path="output/first.txt",
        )
    )
    decision = await source_session.pending_decision()
    assert decision is not None

    with pytest.raises(LiveSourceSessionError, match="decision revision"):
        await source_session.resolve_decision(
            member.source_session_id,
            member.delivery_sequence,
            decision.revision + 1,
            "skip",
        )

    assert source_session.phase == LiveSourceSessionPhase.AWAITING_DECISION
    assert await source_session.pending_decision() == decision


@pytest.mark.asyncio
async def test_live_source_rejects_pre_stream_retry_result() -> None:
    backend = MemoryExtractionBackend(_flat_archive_bytes(["first.txt"]))
    source_session = LiveSourceSession(ZipReader(backend.reader, len(backend.archive)))
    member = await source_session.next_member()

    assert member is not None
    with pytest.raises(LiveSourceSessionError, match="not awaiting a destination result"):
        await source_session.apply_destination_write_result(
            DestinationWriteResult(member.source_session_id, member.delivery_sequence, member.path, "awaiting_retry")
        )

    assert source_session.phase == LiveSourceSessionPhase.CURRENT
    assert await source_session.pending_decision() is None


def _unavailable_member_archive_bytes(member_path: str = "unavailable.txt") -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr(member_path, b"unavailable payload")
    archive_bytes = bytearray(output.getvalue())
    central_directory_offset = archive_bytes.index(b"PK\x01\x02")
    archive_bytes[central_directory_offset + 10 : central_directory_offset + 12] = (99).to_bytes(2, "little")
    return bytes(archive_bytes)


def _bzip2_archive_bytes() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_BZIP2) as archive:
        archive.writestr("compressed.txt", b"BZIP2 extraction content" * 100)
    return output.getvalue()


class _NonSeekableArchiveBuffer(io.BytesIO):
    def seekable(self) -> bool:
        return False

    def seek(self, _offset: int, _whence: int = io.SEEK_SET) -> int:
        raise OSError("archive buffer is not seekable")


def _data_descriptor_archive_bytes() -> bytes:
    output = _NonSeekableArchiveBuffer()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("descriptor.txt", b"data descriptor content")
    return output.getvalue()


def _zip64_archive_bytes() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        with archive.open("zip64.txt", "w", force_zip64=True) as member:
            member.write(b"ZIP64 extraction content")
    return output.getvalue()


def _malformed_local_header_archive_bytes() -> bytes:
    archive = bytearray(_flat_archive_bytes(["broken.txt"]))
    archive[:4] = b"FAIL"
    return bytes(archive)


def _unsafe_archive_bytes() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("../unsafe.txt", "unsafe")
    return output.getvalue()


def _symbolic_link_archive_bytes() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        member = zipfile.ZipInfo("link")
        member.create_system = 3
        member.external_attr = 0o120777 << 16
        archive.writestr(member, "target")
    return output.getvalue()


async def _first_archive_entry(archive: bytes):
    reader = MemoryRandomReader(archive)
    try:
        return await ZipReader(reader, len(archive)).next_entry()
    finally:
        await reader.close()


def test_target_write_policy_matches_the_v2_scenario_corpus() -> None:
    corpus = json.loads(TARGET_WRITE_CORPUS_PATH.read_text(encoding="utf-8"))

    for scenario in corpus["scenarios"]:
        phase = scenario.get("phase")
        attempt_ordinal = scenario.get("attempt_ordinal")
        if phase is None:
            assert attempt_ordinal is None, scenario["name"]
        else:
            assert phase == "after_create_race", scenario["name"]
            assert attempt_ordinal in {1, 2}, scenario["name"]
        target = TargetSnapshot.missing()
        if scenario["target"] == "regular_file":
            target_modified_at = scenario.get("target_modified_at")
            target = TargetSnapshot(
                exists=True,
                is_regular_file=True,
                modified_at=datetime.fromisoformat(target_modified_at) if target_modified_at is not None else None,
            )
        elif scenario["target"] == "other":
            target = TargetSnapshot(exists=True)
        source_modified_at = scenario.get("source_modified_at")
        disposition = resolve_target_write(
            ResolvedCollisionPolicy(scenario["policy"]),
            datetime.fromisoformat(source_modified_at) if source_modified_at is not None else None,
            target,
        )

        assert disposition == TargetWriteDisposition(scenario["expected"]), scenario["name"]


def test_live_relay_collision_policy_aliases_match_the_v2_contract() -> None:
    corpus = json.loads(TARGET_WRITE_CORPUS_PATH.read_text(encoding="utf-8"))
    schema = json.loads(ARCHIVE_CONTRACT_SCHEMA_PATH.read_text(encoding="utf-8"))
    aliases = corpus["live_relay_collision_policy_aliases"]
    schema_values = schema["$defs"]["liveExtractionMember"]["oneOf"][1]["properties"]["collision_policy"]["enum"]

    assert {alias["wire_value"] for alias in aliases if alias["wire_value"] is not None} == set(schema_values)
    for alias in aliases:
        assert collision_policy_from_action(alias["wire_value"]) == ResolvedCollisionPolicy(alias["expected_policy"])
    with pytest.raises(ValueError, match="collision policy"):
        collision_policy_from_action("invalid")


@pytest.mark.asyncio
async def test_target_write_controller_matches_the_v2_attempt_scenario_corpus() -> None:
    corpus = json.loads(TARGET_WRITE_CORPUS_PATH.read_text(encoding="utf-8"))

    for scenario in corpus["attempt_scenarios"]:
        steps = iter(scenario["steps"])
        write_attempts = 0
        stream_polls = 0

        async def observe_target(_path: str) -> FileInfo:
            step = next(steps)
            assert step["kind"] == "observe", scenario["name"]
            if step["target"] == "missing":
                raise FileNotFoundError()
            if step["target"] == "regular_file":
                target_modified_at = step.get("target_modified_at")
                return FileInfo(
                    name="entry.txt",
                    path="output/entry.txt",
                    type=FileType.FILE,
                    size=7,
                    modified_at=datetime.fromisoformat(target_modified_at) if target_modified_at is not None else None,
                )
            assert step["target"] == "other", scenario["name"]
            return FileInfo(name="entry.txt", path="output/entry.txt", type=FileType.DIRECTORY)

        def stream_factory() -> AsyncIterator[bytes]:
            async def stream() -> AsyncIterator[bytes]:
                nonlocal stream_polls
                stream_polls += 1
                yield b"content"

            return stream()

        async def write_target(_path: str, stream: AsyncIterator[bytes], _overwrite: bool, _mtime: datetime | None) -> int:
            nonlocal write_attempts
            write_attempts += 1
            step = next(steps)
            assert step["kind"] == "write", scenario["name"]
            if step["result"] == "target_exists_before_content":
                raise TargetExistsBeforeContent()
            assert step["result"] == "ready", scenario["name"]
            bytes_written = 0
            async for chunk in stream:
                bytes_written += len(chunk)
            return bytes_written

        source_modified_at = scenario.get("source_modified_at")
        result = await resolve_target_write_attempt(
            target_path="output/entry.txt",
            policy=ResolvedCollisionPolicy(scenario["policy"]),
            source_modified_at=datetime.fromisoformat(source_modified_at) if source_modified_at is not None else None,
            observe_target=observe_target,
            stream_factory=stream_factory,
            write_target=write_target,
        )

        assert result.disposition == TargetWriteDisposition(scenario["expected"]), scenario["name"]
        assert write_attempts == scenario["expected_attempts"], scenario["name"]
        assert stream_polls == scenario["expected_stream_polls"], scenario["name"]
        with pytest.raises(StopIteration):
            next(steps)


@pytest.mark.asyncio
async def test_target_write_controller_does_not_poll_pre_content_collision_stream() -> None:
    target: FileInfo | None = None
    stream_polls = 0

    async def observe_target(_path: str) -> FileInfo:
        if target is None:
            raise FileNotFoundError()
        return target

    def stream_factory() -> AsyncIterator[bytes]:
        async def stream() -> AsyncIterator[bytes]:
            nonlocal stream_polls
            stream_polls += 1
            yield b"content"

        return stream()

    async def write_target(_path: str, _stream: AsyncIterator[bytes], _overwrite: bool, _mtime: datetime | None) -> int:
        nonlocal target
        target = FileInfo(name="entry.txt", path="output/entry.txt", type=FileType.FILE, size=7)
        raise TargetExistsBeforeContent()

    result = await resolve_target_write_attempt(
        target_path="output/entry.txt",
        policy=ResolvedCollisionPolicy.ASK,
        source_modified_at=None,
        observe_target=observe_target,
        stream_factory=stream_factory,
        write_target=write_target,
    )

    assert result.disposition == TargetWriteDisposition.AWAIT_COLLISION
    assert stream_polls == 0


@pytest.mark.asyncio
async def test_target_write_controller_retries_once_when_late_target_disappears() -> None:
    observations = 0
    write_attempts: list[bool] = []

    async def observe_target(_path: str) -> FileInfo:
        nonlocal observations
        observations += 1
        raise FileNotFoundError()

    async def stream() -> AsyncIterator[bytes]:
        yield b"content"

    async def write_target(_path: str, _stream: AsyncIterator[bytes], overwrite: bool, _mtime: datetime | None) -> int:
        write_attempts.append(overwrite)
        if len(write_attempts) == 1:
            raise TargetExistsBeforeContent()
        return 7

    result = await resolve_target_write_attempt(
        target_path="output/entry.txt",
        policy=ResolvedCollisionPolicy.ASK,
        source_modified_at=None,
        observe_target=observe_target,
        stream_factory=stream,
        write_target=write_target,
    )

    assert result.disposition == TargetWriteDisposition.CREATE_NEW
    assert result.bytes_written == 7
    assert observations == 2
    assert write_attempts == [False, False]


@pytest.mark.asyncio
async def test_target_write_controller_propagates_native_failures() -> None:
    failure = OSError("destination is unavailable")

    async def observe_target(_path: str) -> FileInfo:
        raise FileNotFoundError()

    async def stream() -> AsyncIterator[bytes]:
        yield b"content"

    async def write_target(_path: str, _stream: AsyncIterator[bytes], _overwrite: bool, _mtime: datetime | None) -> int:
        raise failure

    with pytest.raises(OSError, match="destination is unavailable") as raised:
        await resolve_target_write_attempt(
            target_path="output/entry.txt",
            policy=ResolvedCollisionPolicy.ASK,
            source_modified_at=None,
            observe_target=observe_target,
            stream_factory=stream,
            write_target=write_target,
        )

    assert raised.value is failure


@pytest.mark.asyncio
async def test_direct_extraction_marks_a_zero_byte_mutated_target_as_partial_output() -> None:
    backend = MemoryExtractionBackend(_flat_archive_bytes(["empty.txt"]))

    async def create_then_fail(path: str, _stream: AsyncIterator[bytes], **_kwargs: object) -> int:
        backend.files[path] = b""
        raise TargetWriteFailure(OSError("metadata update failed"), 0)

    backend.write_file_from_stream = create_then_fail  # type: ignore[method-assign]

    with pytest.raises(ArchiveExtractionMemberError) as raised:
        await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert raised.value.partial_output is True
    assert backend.files["output/empty.txt"] == b""


@pytest.mark.asyncio
async def test_directory_creation_reports_a_current_member_failure_when_the_target_changes() -> None:
    backend = MemoryExtractionBackend(_archive_bytes())
    original_create_directory = backend.create_directory
    attempts = 0

    async def create_directory(path: str) -> None:
        nonlocal attempts
        if path == "output/docs":
            attempts += 1
            if attempts == 1:
                raise FileExistsError(path)
        await original_create_directory(path)

    backend.create_directory = create_directory  # type: ignore[method-assign]

    with pytest.raises(ArchiveExtractionMemberError) as error:
        await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert error.value.member_path == "docs/readme.txt"
    assert error.value.target_path == "output/docs/readme.txt"
    assert error.value.partial_output is False
    assert attempts == 1


@pytest.mark.asyncio
async def test_extracts_safe_members_to_new_paths() -> None:
    backend = MemoryExtractionBackend(_archive_bytes())

    result = await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert result.files_extracted == 2
    assert result.extracted_bytes == 10
    assert backend.directories == {"output", "output/docs"}
    assert backend.files == {"output/docs/readme.txt": b"readme", "output/root.txt": b"root"}
    assert backend.reader.closed is True
    assert set(backend.created_directory_paths) == {"output", "output/docs"}
    assert backend.written_file_paths == ["output/docs/readme.txt", "output/root.txt"]


@pytest.mark.asyncio
async def test_records_an_unavailable_selected_member_as_skipped_without_reading_it() -> None:
    backend = MemoryExtractionBackend(_unavailable_member_archive_bytes())

    result = await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert result.files_extracted == 0
    assert result.members_skipped == 1
    assert result.members_processed == 1
    assert result.members_skipped == 1
    assert result.members_failed == 0
    assert backend.files == {}
    assert backend.directories == set()
    assert (0, 30) not in backend.reader.reads


@pytest.mark.asyncio
async def test_skips_an_unavailable_member_without_preflighting_its_blocked_parent() -> None:
    backend = MemoryExtractionBackend(_unavailable_member_archive_bytes("folder/file.txt"))
    backend.directories.add("output")
    backend.files["output/folder"] = b"existing file"

    result = await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert result.members_skipped == 1
    assert result.members_skipped == 1
    assert backend.file_info_paths == ["input.zip"]
    assert backend.written_file_paths == []


@pytest.mark.asyncio
async def test_direct_extraction_parses_the_central_directory_once() -> None:
    backend = MemoryExtractionBackend(_archive_bytes())
    original_directory = ZipReader._directory
    directory_calls = 0

    async def count_directory(reader: ZipReader):
        nonlocal directory_calls
        directory_calls += 1
        return await original_directory(reader)

    with patch.object(ZipReader, "_directory", count_directory):
        await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert directory_calls == 1


@pytest.mark.asyncio
async def test_extracts_through_separate_source_and_destination_adapters() -> None:
    backend = MemoryExtractionBackend(_archive_bytes())

    result = await extract_archive_to_new_paths(
        MemoryExtractionSource(backend),
        destination=MemoryExtractionDestination(backend),
        archive_path="input.zip",
        destination_root="output",
    )

    assert result.files_extracted == 2
    assert backend.files == {"output/docs/readme.txt": b"readme", "output/root.txt": b"root"}


@pytest.mark.asyncio
async def test_rejects_unsafe_members_before_creating_output() -> None:
    backend = MemoryExtractionBackend(_unsafe_archive_bytes())

    result = await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert result.members_processed == 1
    assert result.members_completed == 0
    assert result.members_skipped == 1
    assert result.members_failed == 0
    assert backend.directories == set()
    assert backend.files == {}
    assert backend.reader.closed is True


@pytest.mark.asyncio
async def test_rejects_symbolic_link_members_before_creating_output() -> None:
    backend = MemoryExtractionBackend(_symbolic_link_archive_bytes())

    result = await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert result.members_processed == 1
    assert result.members_completed == 0
    assert result.members_skipped == 1
    assert result.members_failed == 0
    assert backend.directories == set()
    assert backend.files == {}
    assert backend.reader.closed is True


@pytest.mark.asyncio
async def test_skip_all_policy_preserves_existing_files() -> None:
    backend = MemoryExtractionBackend(_archive_bytes())
    backend.files["output/root.txt"] = b"existing"

    result = await extract_archive_to_new_paths(
        backend, archive_path="input.zip", destination_root="output", existing_file_policy="skip_all"
    )

    assert result.files_extracted == 1
    assert backend.files == {"output/docs/readme.txt": b"readme", "output/root.txt": b"existing"}


@pytest.mark.asyncio
async def test_replace_all_policy_replaces_existing_files() -> None:
    backend = MemoryExtractionBackend(_archive_bytes())
    backend.files["output/root.txt"] = b"existing"

    result = await extract_archive_to_new_paths(
        backend, archive_path="input.zip", destination_root="output", existing_file_policy="replace_all"
    )

    assert result.files_extracted == 2
    assert backend.files["output/root.txt"] == b"root"


@pytest.mark.asyncio
async def test_live_source_selects_the_last_duplicate_record() -> None:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("duplicate.txt", "first")
        with pytest.warns(UserWarning, match=r"^Duplicate name: 'duplicate\.txt'$"):
            archive.writestr("duplicate.txt", "last")
    backend = MemoryExtractionBackend(output.getvalue())

    source_session = LiveSourceSession(ZipReader(backend.reader, len(backend.archive)))
    member = await source_session.next_member()
    assert member is not None
    contents = b"".join([chunk async for chunk in source_session.stream_current_member(member.source_session_id, member.delivery_sequence)])
    await source_session.apply_destination_write_result(
        DestinationWriteResult(member.source_session_id, member.delivery_sequence, member.path, "extracted", extracted_bytes=len(contents))
    )

    assert (member.path, member.delivery_sequence, contents) == ("duplicate.txt", 1, b"last")
    assert (await source_session.next_member()) is None
    assert source_session.aggregate.members_completed == 1
    assert source_session.aggregate.members_skipped == 1
    await source_session.close()


@pytest.mark.asyncio
async def test_extracts_bzip2_members_without_staging() -> None:
    backend = MemoryExtractionBackend(_bzip2_archive_bytes())

    result = await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert result.files_extracted == 1
    assert backend.files["output/compressed.txt"] == b"BZIP2 extraction content" * 100


@pytest.mark.asyncio
async def test_extracts_data_descriptor_members() -> None:
    backend = MemoryExtractionBackend(_data_descriptor_archive_bytes())

    result = await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert result.files_extracted == 1
    assert backend.files["output/descriptor.txt"] == b"data descriptor content"


@pytest.mark.asyncio
async def test_extracts_zip64_members() -> None:
    backend = MemoryExtractionBackend(_zip64_archive_bytes())

    result = await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert result.files_extracted == 1
    assert backend.files["output/zip64.txt"] == b"ZIP64 extraction content"


@pytest.mark.asyncio
async def test_rejects_malformed_local_header_without_creating_the_target() -> None:
    backend = MemoryExtractionBackend(_malformed_local_header_archive_bytes())

    result = await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert result.members_processed == 1
    assert result.members_failed == 1
    assert "output/broken.txt" not in backend.files


@pytest.mark.asyncio
async def test_replace_older_policy_replaces_only_strictly_older_destination() -> None:
    corpus = json.loads(EXTRACTION_OUTCOME_CORPUS_PATH.read_text(encoding="utf-8"))
    scenario = next(
        scenario for scenario in corpus["behavioral_scenarios"] if scenario["name"] == "replace_older_replaces_strictly_older_destination"
    )
    backend = MemoryExtractionBackend(_archive_bytes())
    backend.files["output/root.txt"] = b"existing"
    backend.modified_at["output/root.txt"] = datetime.fromisoformat(scenario["target_modified_at"])

    result = await extract_archive_to_new_paths(
        backend,
        archive_path="input.zip",
        destination_root="output",
        existing_file_policy=scenario["existing_file_policy"],
    )

    assert scenario["terminal_phase"] == "completed"
    assert result.files_extracted == scenario["progress"]["files_extracted"]
    assert result.files_replaced == scenario["progress"]["files_replaced"]
    assert result.members_skipped == scenario["progress"]["files_skipped"]
    assert backend.files["output/root.txt"] == b"root"


@pytest.mark.asyncio
async def test_replace_older_policy_skips_incomparable_timestamps() -> None:
    backend = MemoryExtractionBackend(_archive_bytes())
    backend.files["output/root.txt"] = b"existing"
    backend.modified_at["output/root.txt"] = datetime(1979, 1, 1, tzinfo=timezone.utc)

    result = await extract_archive_to_new_paths(
        backend, archive_path="input.zip", destination_root="output", existing_file_policy="replace_older"
    )

    assert result.files_extracted == 1
    assert result.files_replaced == 0
    assert result.members_skipped == 1
    assert backend.files["output/root.txt"] == b"existing"


@pytest.mark.asyncio
async def test_cancellation_stops_before_writing_members() -> None:
    corpus = json.loads(EXTRACTION_OUTCOME_CORPUS_PATH.read_text(encoding="utf-8"))
    scenario = next(
        scenario for scenario in corpus["behavioral_scenarios"] if scenario["name"] == "cancellation_stops_before_member_completion"
    )
    backend = MemoryExtractionBackend(_archive_bytes())

    with pytest.raises(ArchiveExtractionCancelled):
        await extract_archive_to_new_paths(
            backend,
            archive_path="input.zip",
            destination_root="output",
            is_cancelled=lambda: _cancelled(),
        )

    assert backend.files == {}
    assert backend.reader.closed is True
    assert scenario["terminal_phase"] == "cancelled"
    assert scenario["progress"]["files_extracted"] == 0


@pytest.mark.asyncio
async def test_replace_older_skips_a_newer_target_created_after_preflight() -> None:
    backend = MemoryExtractionBackend(_archive_bytes())

    async def create_newer_competing_file(path: str, _stream: AsyncIterator[bytes], **_kwargs: object) -> int:
        backend.files[path] = b"existing"
        backend.modified_at[path] = datetime(2026, 1, 2, tzinfo=timezone.utc)
        raise TargetExistsBeforeContent(path)

    backend.write_file_from_stream = create_newer_competing_file  # type: ignore[method-assign]

    result = await extract_archive_to_new_paths(
        backend,
        archive_path="input.zip",
        destination_root="output",
        existing_file_policy="replace_older",
    )

    assert result.files_extracted == 0
    assert result.members_skipped == 2
    assert backend.files["output/docs/readme.txt"] == b"existing"


@pytest.mark.asyncio
async def test_replace_older_retries_an_older_target_created_after_preflight() -> None:
    topology_fixture = json.loads(TOPOLOGY_TRACE_FIXTURE_PATH.read_text(encoding="utf-8"))
    scenario_name = next(case["scenario"] for case in topology_fixture["target_write_attempt_cases"] if case["topology"] == "smb_to_smb")
    target_write_fixture = json.loads(TARGET_WRITE_CORPUS_PATH.read_text(encoding="utf-8"))
    scenario = next(scenario for scenario in target_write_fixture["attempt_scenarios"] if scenario["name"] == scenario_name)
    assert scenario["expected"] == "replace_existing"

    backend = MemoryExtractionBackend(_archive_bytes())
    source_entry = await _first_archive_entry(backend.archive)
    assert source_entry is not None
    source_modified_at = source_entry.modified_at
    assert source_modified_at is not None
    writes: list[tuple[str, bool]] = []

    async def write_after_race(path: str, stream: AsyncIterator[bytes], **kwargs: object) -> int:
        overwrite = kwargs["overwrite"]
        assert isinstance(overwrite, bool)
        writes.append((path, overwrite))
        if path == "output/docs/readme.txt" and len([attempt for attempt in writes if attempt[0] == path]) == 1:
            backend.files[path] = b"existing"
            backend.modified_at[path] = source_modified_at - timedelta(seconds=1)
            raise TargetExistsBeforeContent(path)
        return await MemoryExtractionBackend.write_file_from_stream(backend, path, stream, **kwargs)

    backend.write_file_from_stream = write_after_race  # type: ignore[method-assign]

    result = await extract_archive_to_new_paths(
        backend,
        archive_path="input.zip",
        destination_root="output",
        existing_file_policy="replace_older",
    )

    assert [overwrite for path, overwrite in writes if path == "output/docs/readme.txt"] == [False, True]
    assert result.files_replaced == scenario["expected_attempts"] - 1
    assert backend.files["output/docs/readme.txt"] == b"readme"


@pytest.mark.asyncio
async def test_write_failure_identifies_the_member_that_can_be_retried() -> None:
    backend = MemoryExtractionBackend(_archive_bytes())

    async def fail_write(path: str, _stream: AsyncIterator[bytes], **_kwargs: object) -> int:
        raise OSError(f"Cannot write {path}")

    backend.write_file_from_stream = fail_write  # type: ignore[method-assign]

    with pytest.raises(ArchiveExtractionMemberError) as error:
        await extract_archive_to_new_paths(backend, archive_path="input.zip", destination_root="output")

    assert error.value.member_path == "docs/readme.txt"
    assert error.value.target_path == "output/docs/readme.txt"
    assert error.value.message == "Cannot write output/docs/readme.txt"


async def _cancelled() -> bool:
    return True
