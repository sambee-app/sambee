"""Live S1 relay protocol coverage at the backend/Companion boundary."""

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from zipfile import ZipFile

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.api.archive_operations import (
    ArchiveExtractionDirectoryCollision,
    ScopedCompanionRelay,
    _live_extraction_sessions,
    resume_live_companion_archive_destination,
    stream_live_companion_local_archive_member,
    write_live_companion_archive_destination_member,
)
from app.models.archive_operation import (
    ArchiveCompanionLiveDestinationDecision,
    ArchiveCompanionLiveDestinationWriteRequest,
    ArchiveOperation,
    ArchiveOperationErrorCode,
    ArchiveOperationPhase,
    ArchiveOperationRead,
)
from app.models.connection import Connection
from app.models.file import FileInfo, FileType
from app.services.archive.execution import ArchiveCompanionRelayPurpose
from app.services.archive.live_extraction import LiveSourceSessionError
from app.services.archive.operation_monitor import expire_stale_archive_operations_and_cleanup
from app.services.archive.target_write import TargetWriteControllerResult, TargetWriteDisposition
from app.services.archive.zip_reader import ArchiveFormatError, ArchiveSourceUnavailableError


class MemoryArchiveSourceReader:
    """Small pinned reader used to drive the backend side of a Companion relay."""

    def __init__(self, archive_bytes: bytes) -> None:
        self.archive_bytes = archive_bytes
        self.closed = False

    async def read_at(self, offset: int, length: int) -> bytes:
        return self.archive_bytes[offset : offset + length]

    async def close(self) -> None:
        self.closed = True


class UnavailableArchiveSourceReader:
    """Pinned reader whose retained SMB handle becomes unavailable."""

    def __init__(self) -> None:
        self.closed = False

    async def read_at(self, offset: int, length: int) -> bytes:
        del offset, length
        raise OSError("SMB handle was closed")

    async def close(self) -> None:
        self.closed = True


class BlockingArchiveSourceReader(MemoryArchiveSourceReader):
    """Pinned reader that blocks on a second large stored-member payload read."""

    def __init__(self, archive_bytes: bytes) -> None:
        super().__init__(archive_bytes)
        self.first_payload_chunk_read = False
        self.second_payload_chunk_started = asyncio.Event()
        self.release_second_payload_chunk = asyncio.Event()

    async def read_at(self, offset: int, length: int) -> bytes:
        if length == 256 * 1024:
            self.first_payload_chunk_read = True
        elif self.first_payload_chunk_read and length == 1:
            self.second_payload_chunk_started.set()
            await self.release_second_payload_chunk.wait()
        return await super().read_at(offset, length)


class StreamingRequest:
    """Tracks whether a no-write relay response consumed its member payload."""

    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.consumed: list[bytes] = []

    async def stream(self):
        for chunk in self.chunks:
            self.consumed.append(chunk)
            yield chunk


def relay_source_backend(contents: bytes) -> AsyncMock:
    archive = BytesIO()
    with ZipFile(archive, "w") as zip_file:
        zip_file.writestr("member.txt", contents)
    archive_bytes = archive.getvalue()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=len(archive_bytes))
    backend.open_archive_source_reader.side_effect = lambda _path: MemoryArchiveSourceReader(archive_bytes)
    return backend


def prepare_smb_to_local_relay(client: TestClient, auth_headers_user: dict, connection: Connection) -> tuple[str, dict[str, str]]:
    operation = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(connection.id),
            "source_path": "input.zip",
            "destination_connection_id": "local-drive:c",
            "destination_path": "output",
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{operation['id']}/companion-session", headers=auth_headers_user).json()
    return operation["id"], {"Authorization": f"Bearer {capability['token']}"}


@pytest.mark.parametrize(
    ("disposition", "expected_status"),
    [
        (TargetWriteDisposition.SKIP, "skipped"),
        (TargetWriteDisposition.AWAIT_COLLISION, "awaiting_collision"),
    ],
)
def test_live_local_source_no_write_result_consumes_regular_member_body(disposition: TargetWriteDisposition, expected_status: str) -> None:
    request = StreamingRequest([b"first", b"second"])
    operation = SimpleNamespace(
        id=uuid.uuid4(),
        destination_path="output",
        collision_policy=None,
        phase=None,
    )
    relay = SimpleNamespace(session=MagicMock(), streaming=MagicMock(return_value=(MagicMock(), operation)))
    payload = ArchiveCompanionLiveDestinationWriteRequest(
        source_session_id="source-session",
        delivery_sequence=1,
        member_path="member.txt",
        is_directory=False,
    )
    destination_backend = AsyncMock()
    destination_backend.connect.return_value = None
    destination_backend.disconnect.return_value = None
    target_write = TargetWriteControllerResult(disposition=disposition, target=None)

    with (
        patch("app.api.archive_operations._mixed_extraction_destination_connection", return_value=MagicMock()),
        patch("app.api.archive_operations.build_smb_backend", return_value=destination_backend),
        patch("app.api.archive_operations._ensure_mixed_archive_parent_directories", new=AsyncMock(return_value=0)),
        patch("app.api.archive_operations.resolve_target_write_attempt", new=AsyncMock(return_value=target_write)),
        patch("app.api.archive_operations.update_operation_phase") as update_phase,
    ):
        result = asyncio.run(write_live_companion_archive_destination_member(request, payload, relay))

    assert result.status == expected_status
    assert request.consumed == [b"first", b"second"]
    if disposition == TargetWriteDisposition.AWAIT_COLLISION:
        update_phase.assert_called_once()
    else:
        update_phase.assert_not_called()


def test_live_local_source_directory_collision_preserves_target_snapshot() -> None:
    operation = SimpleNamespace(
        id=uuid.uuid4(),
        destination_path="output",
        collision_policy=None,
        phase=None,
    )
    relay = SimpleNamespace(session=MagicMock(), streaming=MagicMock(return_value=(MagicMock(), operation)))
    payload = ArchiveCompanionLiveDestinationWriteRequest(
        source_session_id="source-session",
        delivery_sequence=1,
        member_path="blocked",
        is_directory=True,
    )
    target_modified_at = datetime(2025, 1, 2, tzinfo=timezone.utc)
    target = FileInfo(
        name="blocked",
        path="output/blocked",
        type=FileType.FILE,
        size=17,
        modified_at=target_modified_at,
    )
    destination_backend = AsyncMock()
    destination_backend.connect.return_value = None
    destination_backend.disconnect.return_value = None

    with (
        patch("app.api.archive_operations._mixed_extraction_destination_connection", return_value=MagicMock()),
        patch("app.api.archive_operations.build_smb_backend", return_value=destination_backend),
        patch(
            "app.api.archive_operations._ensure_mixed_archive_parent_directories",
            new=AsyncMock(side_effect=ArchiveExtractionDirectoryCollision("output/blocked", target)),
        ),
        patch("app.api.archive_operations.update_operation_phase") as update_phase,
    ):
        result = asyncio.run(write_live_companion_archive_destination_member(StreamingRequest([]), payload, relay))

    assert result.status == "awaiting_collision"
    assert result.target_path == "output/blocked"
    assert result.target_size == 17
    assert result.target_modified_at == target_modified_at
    update_phase.assert_called_once()


@pytest.mark.parametrize("action", ["retry", "ignore"])
def test_live_local_source_integrity_decision_acknowledges_discarded_skip_response(action: str) -> None:
    operation = SimpleNamespace(phase=ArchiveOperationPhase.STREAMING, cancellation_requested=False)
    relay = SimpleNamespace(resolve=MagicMock(return_value=(MagicMock(), operation)), session=MagicMock())
    payload = ArchiveCompanionLiveDestinationDecision(
        source_session_id="source-session",
        delivery_sequence=1,
        decision_revision=1,
        action=action,
        member_path="member.txt",
    )

    result = resume_live_companion_archive_destination(payload, relay)

    assert result is operation
    assert relay.resolve.call_count == 1


@pytest.mark.parametrize(
    ("action", "cancellation_requested"),
    [("skip", False), ("retry", True)],
)
def test_live_local_source_invalid_streaming_decision_is_rejected(action: str, cancellation_requested: bool) -> None:
    operation = SimpleNamespace(phase=ArchiveOperationPhase.STREAMING, cancellation_requested=cancellation_requested)
    relay = SimpleNamespace(resolve=MagicMock(return_value=(MagicMock(), operation)), session=MagicMock())
    payload = ArchiveCompanionLiveDestinationDecision(
        source_session_id="source-session",
        delivery_sequence=1,
        decision_revision=1,
        action=action,
        member_path="member.txt",
    )

    with pytest.raises(HTTPException, match="not awaiting a live destination decision"):
        resume_live_companion_archive_destination(payload, relay)


def test_live_relay_requires_source_result_before_aggregate_completion(
    client: TestClient, auth_headers_user: dict, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    backend = relay_source_backend(b"payload")

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        assert (
            client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers).status_code == 200
        )
        member = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=relay_headers).json()
        assert {"manifest", "receipt", "total_members"}.isdisjoint(member)

        payload = {
            "source_session_id": member["source_session_id"],
            "delivery_sequence": member["delivery_sequence"],
            "member_path": member["member_path"],
            "status": "extracted",
            "extracted_bytes": len(b"payload"),
        }
        assert (
            client.post(
                f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/result",
                headers=relay_headers,
                json=payload,
            ).status_code
            == 409
        )

        stream = client.get(
            f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/current-member",
            headers=relay_headers,
            params={"source_session_id": member["source_session_id"], "delivery_sequence": member["delivery_sequence"]},
        )
        assert stream.content == b"payload"
        stale = {**payload, "delivery_sequence": member["delivery_sequence"] + 1}
        assert (
            client.post(
                f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/result",
                headers=relay_headers,
                json=stale,
            ).status_code
            == 409
        )
        result = client.post(
            f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/result",
            headers=relay_headers,
            json=payload,
        )
        assert result.status_code == 200
        assert result.json()["phase"] == "ready"
        assert result.json()["aggregate_counters"]["members_completed"] == 1
        assert (
            client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=relay_headers).json() is None
        )
        complete = client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/complete", headers=relay_headers)

    assert complete.status_code == 200
    assert complete.json() == {
        "source_session_id": member["source_session_id"],
        "phase": "completed",
        "aggregate_counters": {
            "members_processed": 1,
            "members_completed": 1,
            "members_skipped": 0,
            "encrypted_members_skipped": 0,
            "unsupported_compression_members_skipped": 0,
            "members_failed": 0,
            "files_extracted": 1,
            "directories_created": 0,
            "extracted_bytes": len(b"payload"),
            "files_replaced": 0,
        },
        "pending_decision": None,
    }
    backend.open_archive_source_reader.assert_awaited_once_with("input.zip")
    backend.open_random_access_reader.assert_not_awaited()


def test_live_relay_failed_pinned_source_open_terminalizes_operation(
    client: TestClient, auth_headers_user: dict, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=22)
    backend.open_archive_source_reader.side_effect = ArchiveSourceUnavailableError("sharing violation")

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        response = client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers)

    assert response.status_code == 409
    operation = client.get(f"/api/archive/v2/operations/{operation_id}", headers=auth_headers_user).json()
    assert operation["phase"] == "failed"
    assert operation["last_error"]["code"] == ArchiveOperationErrorCode.OPERATION_UNAVAILABLE.value
    backend.open_archive_source_reader.assert_awaited_once_with("input.zip")
    backend.open_random_access_reader.assert_not_awaited()


def test_live_relay_duplicate_source_registration_preserves_existing_source(
    client: TestClient, auth_headers_user: dict, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    archive = BytesIO()
    with ZipFile(archive, "w") as zip_file:
        zip_file.writestr("entry.txt", b"payload")
    archive_bytes = archive.getvalue()
    existing_reader = MemoryArchiveSourceReader(archive_bytes)
    losing_reader = MemoryArchiveSourceReader(archive_bytes)
    existing_source = asyncio.run(_live_extraction_sessions.open(existing_reader, len(archive_bytes), operation_id=uuid.UUID(operation_id)))
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=len(archive_bytes))
    backend.open_archive_source_reader.return_value = losing_reader

    try:
        with patch("app.api.archive_operations.SMBBackend", return_value=backend):
            response = client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers)

        assert response.status_code == 409
        assert losing_reader.closed
        assert asyncio.run(_live_extraction_sessions.get_for_operation(uuid.UUID(operation_id))) is existing_source
        operation = client.get(f"/api/archive/v2/operations/{operation_id}", headers=auth_headers_user).json()
        assert operation["phase"] == "accepted"
    finally:
        asyncio.run(_live_extraction_sessions.remove_for_operation(uuid.UUID(operation_id)))


def test_live_relay_retained_source_read_failure_closes_and_terminalizes_operation(
    client: TestClient, auth_headers_user: dict, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    reader = UnavailableArchiveSourceReader()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=22)
    backend.open_archive_source_reader.return_value = reader

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        assert (
            client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers).status_code == 200
        )
        response = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=relay_headers)

    assert response.status_code == 409
    assert reader.closed
    operation = client.get(f"/api/archive/v2/operations/{operation_id}", headers=auth_headers_user).json()
    assert operation["phase"] == "failed"
    assert operation["last_error"]["code"] == ArchiveOperationErrorCode.OPERATION_UNAVAILABLE.value


def test_live_relay_failure_terminalizes_and_closes_backend_source(
    client: TestClient, auth_headers_user: dict, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    reader = UnavailableArchiveSourceReader()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=22)
    backend.open_archive_source_reader.return_value = reader

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers)
        failed = client.post(
            f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/fail",
            headers=relay_headers,
            json={"message": "Companion archive relay failed"},
        )

    assert begin.status_code == 200
    assert failed.status_code == 200
    assert failed.json()["phase"] == "failed"
    assert failed.json()["last_error"]["code"] == ArchiveOperationErrorCode.TRANSPORT_FAILURE.value
    assert reader.closed


def test_cancelled_live_relay_member_stream_closes_source_and_terminalizes_operation(
    client: TestClient, auth_headers_user: dict, session: Session, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    archive = BytesIO()
    with ZipFile(archive, "w") as zip_file:
        zip_file.writestr("member.bin", b"x" * (256 * 1024 + 1))
    archive_bytes = archive.getvalue()
    reader = BlockingArchiveSourceReader(archive_bytes)
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=len(archive_bytes))
    backend.open_archive_source_reader.return_value = reader

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        assert (
            client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers).status_code == 200
        )
        member = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=relay_headers).json()

        async def cancel_stream() -> None:
            relay = ScopedCompanionRelay(
                uuid.UUID(operation_id),
                ArchiveCompanionRelayPurpose.SMB_ZIP_TO_LOCAL_EXTRACT,
                relay_headers["Authorization"].removeprefix("Bearer "),
                session,
            )
            response = await stream_live_companion_local_archive_member(
                member["source_session_id"],
                member["delivery_sequence"],
                relay,
            )
            consumer = asyncio.create_task(anext(response.body_iterator))
            assert await consumer
            consumer = asyncio.create_task(anext(response.body_iterator))
            await reader.second_payload_chunk_started.wait()
            consumer.cancel()
            with pytest.raises(asyncio.CancelledError):
                await consumer

        asyncio.run(cancel_stream())

    session.expire_all()
    operation = session.get(ArchiveOperation, uuid.UUID(operation_id))
    assert operation is not None
    assert operation.phase.value == "failed"
    assert ArchiveOperationRead.model_validate(operation).last_error is not None
    assert ArchiveOperationRead.model_validate(operation).last_error.code == ArchiveOperationErrorCode.TRANSPORT_FAILURE
    assert reader.closed
    with pytest.raises(LiveSourceSessionError):
        asyncio.run(_live_extraction_sessions.get_for_operation(uuid.UUID(operation_id)))


def test_live_relay_capability_refresh_preserves_backend_source_session(
    client: TestClient, auth_headers_user: dict, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    backend = relay_source_backend(b"payload")

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers)
        refresh = client.post(f"/api/archive/v2/operations/{operation_id}/companion-session", headers=auth_headers_user)
        refreshed_headers = {"Authorization": f"Bearer {refresh.json()['token']}"}
        member = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=refreshed_headers)

    assert begin.status_code == 200
    assert refresh.status_code == 200
    assert refresh.json()["operation"]["phase"] == "streaming"
    assert member.status_code == 200
    assert member.json()["source_session_id"] == begin.json()["source_session_id"]
    backend.open_archive_source_reader.assert_awaited_once_with("input.zip")


def test_live_relay_expiry_closes_retained_source_and_terminalizes_operation(
    client: TestClient, auth_headers_user: dict, session: Session, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    reader = UnavailableArchiveSourceReader()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=22)
    backend.open_archive_source_reader.return_value = reader
    now = datetime.now(timezone.utc)

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        assert (
            client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers).status_code == 200
        )
        for candidate in session.exec(select(ArchiveOperation)).all():
            candidate.heartbeat_at = now
        operation = session.get(ArchiveOperation, uuid.UUID(operation_id))
        assert operation is not None
        operation.heartbeat_at = now - timedelta(seconds=121)
        session.commit()
        assert asyncio.run(expire_stale_archive_operations_and_cleanup(now=now, session=session)) == 1
        session.refresh(operation)
        assert operation.phase.value == "failed"

    assert reader.closed
    unavailable = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=relay_headers)
    assert unavailable.status_code == 409


def test_live_relay_expiry_persists_known_aggregate_progress(
    client: TestClient, auth_headers_user: dict, session: Session, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    archive = BytesIO()
    with ZipFile(archive, "w") as zip_file:
        zip_file.writestr("member.txt", b"payload")
    archive_bytes = archive.getvalue()
    reader = MemoryArchiveSourceReader(archive_bytes)
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=len(archive_bytes))
    backend.open_archive_source_reader.return_value = reader
    now = datetime.now(timezone.utc)

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        assert (
            client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers).status_code == 200
        )
        member = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=relay_headers).json()
        assert (
            client.get(
                f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/current-member",
                headers=relay_headers,
                params={"source_session_id": member["source_session_id"], "delivery_sequence": member["delivery_sequence"]},
            ).content
            == b"payload"
        )
        assert (
            client.post(
                f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/result",
                headers=relay_headers,
                json={
                    "source_session_id": member["source_session_id"],
                    "delivery_sequence": member["delivery_sequence"],
                    "member_path": member["member_path"],
                    "status": "extracted",
                    "extracted_bytes": len(b"payload"),
                },
            ).status_code
            == 200
        )
        operation = session.get(ArchiveOperation, uuid.UUID(operation_id))
        assert operation is not None
        operation.heartbeat_at = now - timedelta(seconds=121)
        session.commit()
        assert asyncio.run(expire_stale_archive_operations_and_cleanup(now=now, session=session)) == 1

    session.expire_all()
    operation = session.get(ArchiveOperation, uuid.UUID(operation_id))
    assert operation is not None
    checkpoint = json.loads(operation.checkpoint_json)
    assert checkpoint["aggregate_counters"] == {
        "members_processed": 1,
        "members_completed": 1,
        "members_skipped": 0,
        "encrypted_members_skipped": 0,
        "unsupported_compression_members_skipped": 0,
        "members_failed": 0,
        "files_extracted": 1,
        "directories_created": 0,
        "extracted_bytes": len(b"payload"),
        "files_replaced": 0,
    }
    assert reader.closed


def test_cancelling_lost_live_relay_source_terminalizes_operation(
    client: TestClient, auth_headers_user: dict, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    backend = relay_source_backend(b"payload")

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        assert (
            client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers).status_code == 200
        )
    with patch(
        "app.api.archive_operations._live_extraction_sessions.get_for_operation",
        new=AsyncMock(side_effect=LiveSourceSessionError("Archive source session is unavailable")),
    ):
        cancelled = client.post(f"/api/archive/v2/operations/{operation_id}/cancel", headers=auth_headers_user)

    assert cancelled.status_code == 200
    assert cancelled.json()["phase"] == "cancelled"


def test_live_relay_integrity_failure_exposes_member_error_decision(
    client: TestClient, auth_headers_user: dict, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    archive = BytesIO()
    with ZipFile(archive, "w") as zip_file:
        zip_file.writestr("member.txt", b"payload")
    archive_bytes = bytearray(archive.getvalue())
    archive_bytes[archive_bytes.index(b"payload")] ^= 1
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=len(archive_bytes))
    backend.open_archive_source_reader.return_value = MemoryArchiveSourceReader(bytes(archive_bytes))

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        assert (
            client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers).status_code == 200
        )
        member = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=relay_headers).json()

        async def consume_member() -> None:
            source_session = await _live_extraction_sessions.get_for_operation(uuid.UUID(operation_id))
            async for _chunk in source_session.stream_current_member(member["source_session_id"], member["delivery_sequence"]):
                pass

        with pytest.raises(ArchiveFormatError, match="integrity"):
            asyncio.run(consume_member())
        live_status = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/status", headers=relay_headers)
        operation = client.get(f"/api/archive/v2/operations/{operation_id}", headers=auth_headers_user)
        cancelled = client.post(f"/api/archive/v2/operations/{operation_id}/cancel", headers=auth_headers_user)

    assert live_status.status_code == 200
    assert live_status.json()["phase"] == "awaiting_decision"
    assert live_status.json()["pending_decision"]["kind"] == "member_error"
    assert live_status.json()["aggregate_counters"]["members_processed"] == 0
    assert operation.json()["phase"] == "awaiting_user_decision"
    assert operation.json()["pending_decision_json"] is None
    assert cancelled.json()["phase"] == "cancelled"


def test_live_relay_rejects_duplicate_and_paused_next_member_reads(
    client: TestClient, auth_headers_user: dict, test_connection: Connection
) -> None:
    operation_id, relay_headers = prepare_smb_to_local_relay(client, auth_headers_user, test_connection)
    archive = BytesIO()
    with ZipFile(archive, "w") as zip_file:
        zip_file.writestr("folder/", b"")
    archive_bytes = archive.getvalue()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=len(archive_bytes))
    backend.open_archive_source_reader.return_value = MemoryArchiveSourceReader(archive_bytes)

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        assert (
            client.post(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/begin", headers=relay_headers).status_code == 200
        )
        member = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=relay_headers).json()
        duplicate = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=relay_headers)
        paused = client.post(
            f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/result",
            headers=relay_headers,
            json={
                "source_session_id": member["source_session_id"],
                "delivery_sequence": member["delivery_sequence"],
                "member_path": member["member_path"],
                "status": "awaiting_collision",
                "target_path": "output/folder",
                "message": "Archive target already exists",
            },
        )
        paused_next = client.get(f"/api/archive/v2/operations/{operation_id}/relay/extraction/live/next-member", headers=relay_headers)

    assert duplicate.status_code == 409
    assert paused.status_code == 200
    assert paused.json()["phase"] == "awaiting_decision"
    assert paused_next.status_code == 409
