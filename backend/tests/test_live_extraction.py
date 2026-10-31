"""Tests for source-owned incremental ZIP extraction state."""

import asyncio
import io
import zipfile
from dataclasses import replace
from pathlib import Path

import pytest

from app.services.archive.live_extraction import (
    DestinationWriteResult,
    LiveExtractionAggregate,
    LiveSourceSession,
    LiveSourceSessionCancelled,
    LiveSourceSessionError,
    LiveSourceSessionPhase,
)
from app.services.archive.zip_reader import ArchiveFormatError, ZipReader

ARCHIVE_TESTDATA_ROOT = Path(__file__).resolve().parents[2] / "archive_testdata"


class MemoryRandomAccessReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.closed = False

    async def read_at(self, offset: int, length: int) -> bytes:
        return self.data[offset : offset + length]

    async def close(self) -> None:
        self.closed = True


def _zip_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("first.txt", b"one")
        archive.writestr("second.txt", b"two")
    return buffer.getvalue()


def _unsupported_member_zip_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("blocked.txt", b"blocked", compress_type=zipfile.ZIP_LZMA)
        archive.writestr("available.txt", b"available")
    return buffer.getvalue()


def _directory_then_file_zip_bytes() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("directory/", b"")
        archive.writestr("available.txt", b"available")
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_live_source_session_advances_only_after_accepted_results() -> None:
    data = _zip_bytes()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))

    first = await session.next_member()
    assert first is not None
    assert first.delivery_sequence == 1
    assert b"".join([chunk async for chunk in session.stream_current_member(first.source_session_id, first.delivery_sequence)]) == b"one"

    await session.apply_destination_write_result(
        DestinationWriteResult(first.source_session_id, first.delivery_sequence, first.path, "extracted", extracted_bytes=3)
    )
    second = await session.next_member()

    assert second is not None
    assert second.path == "second.txt"
    assert second.delivery_sequence == 2


@pytest.mark.asyncio
async def test_backend_owned_live_source_reports_compatibility_recovery_outcomes() -> None:
    accepted_archive = (ARCHIVE_TESTDATA_ROOT / "compat-deflate-padding.zip").read_bytes()
    accepted_session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(accepted_archive), len(accepted_archive)))
    accepted_member = await accepted_session.next_member()

    assert accepted_member is not None
    assert accepted_member.path == "deflate-padding.txt"
    assert (
        b"".join(
            [
                chunk
                async for chunk in accepted_session.stream_current_member(
                    accepted_member.source_session_id,
                    accepted_member.delivery_sequence,
                )
            ]
        )
        == b"verified compatibility payload"
    )

    rejected_archive = (ARCHIVE_TESTDATA_ROOT / "compat-truncated-deflate.zip").read_bytes()
    rejected_session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(rejected_archive), len(rejected_archive)))
    rejected_member = await rejected_session.next_member()

    assert rejected_member is not None
    assert rejected_member.path == "truncated-deflate.txt"
    with pytest.raises(ArchiveFormatError, match="truncated"):
        _ = [
            chunk
            async for chunk in rejected_session.stream_current_member(
                rejected_member.source_session_id,
                rejected_member.delivery_sequence,
            )
        ]


@pytest.mark.asyncio
async def test_live_source_session_rejects_stale_delivery_results() -> None:
    data = _zip_bytes()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))
    member = await session.next_member()
    assert member is not None
    _ = [chunk async for chunk in session.stream_current_member(member.source_session_id, member.delivery_sequence)]

    with pytest.raises(LiveSourceSessionError, match="delivery sequence"):
        await session.apply_destination_write_result(
            DestinationWriteResult(member.source_session_id, member.delivery_sequence + 1, member.path, "extracted", extracted_bytes=3)
        )

    assert session.aggregate.members_processed == 0
    assert session.phase == LiveSourceSessionPhase.AWAITING_RESULT


@pytest.mark.asyncio
async def test_live_source_session_skips_known_unsupported_entries_without_delivery() -> None:
    data = _unsupported_member_zip_bytes()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))

    member = await session.next_member()

    assert member is not None
    assert member.path == "available.txt"
    assert member.delivery_sequence == 1
    assert session.aggregate.members_processed == 1
    assert session.aggregate.members_skipped == 1
    assert session.aggregate.unsupported_compression_members_skipped == 1
    assert session.aggregate.encrypted_members_skipped == 0
    assert session.aggregate.checkpoint_payload()["unsupported_compression_members_skipped"] == 1


@pytest.mark.asyncio
async def test_live_source_session_records_encrypted_skip_reason_before_unsupported_compression() -> None:
    data = _zip_bytes()
    reader = ZipReader(MemoryRandomAccessReader(data), len(data))
    entries, _ = await reader.extraction_entries()
    entry = replace(entries[0], encrypted=True, compression_method=zipfile.ZIP_LZMA)
    session = LiveSourceSession(reader)

    session.finalize_source_outcome(entry, "skipped")

    assert session.aggregate.members_skipped == 1
    assert session.aggregate.encrypted_members_skipped == 1
    assert session.aggregate.unsupported_compression_members_skipped == 0
    assert session.aggregate.checkpoint_payload()["encrypted_members_skipped"] == 1


@pytest.mark.asyncio
async def test_live_source_session_rejects_invalid_directory_local_header_without_delivery() -> None:
    data = bytearray(_directory_then_file_zip_bytes())
    data[:4] = b"BAD!"
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(bytes(data)), len(data)))

    member = await session.next_member()

    assert member is not None
    assert member.path == "available.txt"
    assert member.delivery_sequence == 1
    assert session.aggregate.members_processed == 1
    assert session.aggregate.members_failed == 1


@pytest.mark.asyncio
async def test_live_source_session_allows_a_directory_collision_skip() -> None:
    data = _directory_then_file_zip_bytes()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))
    member = await session.next_member()
    assert member is not None and member.is_directory
    await session.mark_directory_delivery_ready(member.source_session_id, member.delivery_sequence)
    await session.apply_destination_write_result(
        DestinationWriteResult(
            member.source_session_id,
            member.delivery_sequence,
            member.path,
            "awaiting_collision",
            target_path="output/directory",
        )
    )
    decision = await session.pending_decision()
    assert decision is not None
    assert decision.source_size == 0
    assert decision.source_modified_at is not None
    assert decision.target_path == "output/directory"
    assert decision.target_size is None
    assert decision.target_modified_at is None

    result = await session.resolve_decision(
        member.source_session_id,
        member.delivery_sequence,
        decision.revision,
        "skip",
    )

    assert result is None
    assert session.phase == LiveSourceSessionPhase.READY
    assert session.aggregate.members_processed == 1
    assert session.aggregate.members_skipped == 1


@pytest.mark.asyncio
async def test_live_source_session_rejects_retry_before_regular_member_streams() -> None:
    data = _zip_bytes()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))
    member = await session.next_member()
    assert member is not None and not member.is_directory

    with pytest.raises(LiveSourceSessionError, match="not awaiting"):
        await session.apply_destination_write_result(
            DestinationWriteResult(member.source_session_id, member.delivery_sequence, member.path, "awaiting_retry")
        )

    assert session.phase == LiveSourceSessionPhase.CURRENT
    assert await session.current_member() == member
    assert session.aggregate.members_processed == 0


@pytest.mark.asyncio
async def test_live_source_session_allows_regular_member_collision_before_streaming() -> None:
    data = _zip_bytes()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))
    member = await session.next_member()
    assert member is not None and not member.is_directory

    await session.apply_destination_write_result(
        DestinationWriteResult(
            member.source_session_id,
            member.delivery_sequence,
            member.path,
            "awaiting_collision",
            target_path="output/entry.txt",
        )
    )

    assert session.phase == LiveSourceSessionPhase.AWAITING_DECISION
    assert await session.current_member() == member
    assert session.aggregate.members_processed == 0


@pytest.mark.asyncio
async def test_unknown_destination_outcome_terminalizes_without_counting_current_member() -> None:
    data = _zip_bytes()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))
    member = await session.next_member()
    assert member is not None

    await session.destination_outcome_unknown(member.source_session_id, member.delivery_sequence)

    assert session.phase == LiveSourceSessionPhase.FAILED
    assert session.aggregate.members_processed == 0


@pytest.mark.asyncio
async def test_abandoned_member_stream_terminalizes_without_counting_current_member() -> None:
    data = _zip_bytes()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))
    member = await session.next_member()
    assert member is not None
    stream = session.stream_current_member(member.source_session_id, member.delivery_sequence)

    assert await anext(stream) == b"one"
    await stream.aclose()

    assert session.phase == LiveSourceSessionPhase.FAILED
    assert session.aggregate.members_processed == 0


@pytest.mark.asyncio
async def test_live_source_session_cancellation_stops_stream_without_counting_member() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("large.bin", b"x" * (512 * 1024))
    data = buffer.getvalue()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))
    member = await session.next_member()
    assert member is not None
    stream = session.stream_current_member(member.source_session_id, member.delivery_sequence)

    assert len(await anext(stream)) == 256 * 1024
    await session.cancel()

    with pytest.raises(LiveSourceSessionCancelled):
        await anext(stream)
    assert session.phase == LiveSourceSessionPhase.CANCELLED
    assert session.aggregate.members_processed == 0


@pytest.mark.asyncio
async def test_closing_live_source_session_cancels_active_stream_before_closing_reader() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("large.bin", b"x" * (512 * 1024))
    data = buffer.getvalue()
    reader = MemoryRandomAccessReader(data)
    session = LiveSourceSession(ZipReader(reader, len(data)))
    member = await session.next_member()
    assert member is not None
    stream = session.stream_current_member(member.source_session_id, member.delivery_sequence)

    assert len(await anext(stream)) == 256 * 1024
    close_task = asyncio.create_task(session.close())
    advance_task = asyncio.create_task(anext(stream))

    with pytest.raises(LiveSourceSessionCancelled):
        await advance_task
    await close_task

    assert session.phase == LiveSourceSessionPhase.CANCELLED
    assert session.aggregate.members_processed == 0
    assert reader.closed


@pytest.mark.asyncio
async def test_collision_decision_redelivers_current_member_with_a_new_sequence() -> None:
    data = _zip_bytes()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))
    member = await session.next_member()
    assert member is not None
    _ = [chunk async for chunk in session.stream_current_member(member.source_session_id, member.delivery_sequence)]
    await session.apply_destination_write_result(
        DestinationWriteResult(
            member.source_session_id,
            member.delivery_sequence,
            member.path,
            "awaiting_collision",
            target_path="output/first.txt",
        )
    )

    decision = await session.pending_decision()
    assert decision is not None
    redelivery = await session.resolve_decision(
        member.source_session_id,
        member.delivery_sequence,
        decision.revision,
        "replace",
    )

    assert redelivery is not None
    assert redelivery.path == member.path
    assert redelivery.delivery_sequence == member.delivery_sequence + 1
    assert session.aggregate.members_processed == 0
    destination_member = await session.next_destination_member()
    assert destination_member == redelivery
    with pytest.raises(LiveSourceSessionError, match="not ready"):
        await session.next_destination_member()
    with pytest.raises(LiveSourceSessionError, match="delivery sequence"):
        await session.apply_destination_write_result(
            DestinationWriteResult(member.source_session_id, member.delivery_sequence, member.path, "extracted", extracted_bytes=3)
        )


@pytest.mark.asyncio
async def test_stale_decision_revision_does_not_change_current_member() -> None:
    data = _zip_bytes()
    session = LiveSourceSession(ZipReader(MemoryRandomAccessReader(data), len(data)))
    member = await session.next_member()
    assert member is not None
    _ = [chunk async for chunk in session.stream_current_member(member.source_session_id, member.delivery_sequence)]
    await session.apply_destination_write_result(
        DestinationWriteResult(member.source_session_id, member.delivery_sequence, member.path, "awaiting_retry")
    )
    decision = await session.pending_decision()
    assert decision is not None

    with pytest.raises(LiveSourceSessionError, match="decision revision"):
        await session.resolve_decision(member.source_session_id, member.delivery_sequence, decision.revision + 1, "retry")

    assert session.phase == LiveSourceSessionPhase.AWAITING_DECISION
    assert session.aggregate.members_processed == 0


def test_aggregate_rejects_counter_overflow() -> None:
    aggregate = LiveExtractionAggregate(members_processed=(1 << 63) - 1)

    with pytest.raises(LiveSourceSessionError, match="counter"):
        aggregate.record("skipped")
