"""
Tests for file browsing functionality.
Uses mocked SMB backend to avoid dependency on real SMB server.
"""

import asyncio
import io
import json
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from fastapi.responses import Response
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.api import browser as browser_api
from app.api import viewer as viewer_api
from app.api.companion import COMPANION_OPERATION_PURPOSE, COMPANION_TOKEN_CLAIM, COMPANION_TOKEN_CLASS
from app.core.security import create_access_token
from app.models.connection import Connection, ConnectionScope
from app.models.edit_lock import EditLock
from app.models.file import ContentTransferEffects, ContentTransferResult, CopyMoveRequest, DirectoryListing, FileInfo, FileType
from app.models.transfer_operation import TransferOperation, TransferOperationPhase
from app.services.content_transfer import SourceChangedError, SourceDeleteError, SourceDeletionOutcomeUnknown
from app.services.preprocessor import PreprocessorFileTooLargeError

PUBLISH_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "archive-contract/v2/fixtures/browser-file-publish-scenarios-v2.json").read_text()
)["staged_publish"]


@pytest.mark.asyncio
async def test_cross_connection_progress_bounds_pending_sends_and_preserves_completion() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    completed = asyncio.Event()
    received: list[int] = []

    async def notify(_connection_id, _path, bytes_transferred, _total_bytes, _item_name, _attempt_id):
        if bytes_transferred >= 0:
            started.set()
            await release.wait()
        received.append(bytes_transferred)
        if bytes_transferred == -1:
            completed.set()

    pending: set[asyncio.Task[None]] = set()
    with patch("app.api.websocket.notify_transfer_progress", side_effect=notify):
        on_progress = browser_api._cross_connection_progress("destination", "file.txt", "attempt", pending)
        on_progress(1, 100)
        await asyncio.wait_for(started.wait(), timeout=1)
        for bytes_transferred in range(2, 100):
            on_progress(bytes_transferred, 100)
        assert len(pending) == 1

        browser_api._notify_cross_connection_complete("destination", "file.txt", "attempt", pending)
        assert not completed.is_set()
        release.set()
        await asyncio.wait_for(completed.wait(), timeout=1)
        await asyncio.wait_for(asyncio.gather(*tuple(pending)), timeout=1)
        await asyncio.sleep(0)

    assert received == [1, -1]
    assert not pending


class _MemoryRandomAccessReader:
    def __init__(self, data: bytes) -> None:
        self._data = data
        self.closed = False
        self.reads: list[tuple[int, int]] = []

    async def read_at(self, offset: int, length: int) -> bytes:
        self.reads.append((offset, length))
        return self._data[offset : offset + length]

    async def close(self) -> None:
        self.closed = True


def _archive_bytes(
    extra_members: dict[str, bytes] | None = None,
    *,
    compression: int = zipfile.ZIP_DEFLATED,
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as archive:
        archive.writestr("docs/readme.txt", "hello")
        archive.writestr("root.txt", "root")
        for path, content in (extra_members or {}).items():
            archive.writestr(path, content)
    return output.getvalue()


def _archive_bytes_with_encrypted_members() -> bytes:
    archive = bytearray(_archive_bytes())
    for offset in range(len(archive) - 3):
        signature = archive[offset : offset + 4]
        if signature == b"PK\x03\x04":
            flags_offset = offset + 6
        elif signature == b"PK\x01\x02":
            flags_offset = offset + 8
        else:
            continue
        flags = int.from_bytes(archive[flags_offset : flags_offset + 2], "little") | 1
        archive[flags_offset : flags_offset + 2] = flags.to_bytes(2, "little")
    return bytes(archive)


@pytest.mark.asyncio
async def test_image_preview_size_limit_returns_a_safe_actionable_error():
    """The viewer exposes only the configured limit, not converter diagnostics."""
    with (
        patch(
            "app.api.viewer.convert_image_for_viewer",
            side_effect=PreprocessorFileTooLargeError(368_050_000, 104_857_600),
        ),
        pytest.raises(HTTPException) as error,
    ):
        await viewer_api.create_converted_image_response(image_bytes=b"large PSD", filename="image.psd")

    assert error.value.status_code == 413
    assert error.value.detail == {
        "code": "image_preview_too_large",
        "message": "This image is too large to preview (351 MB; maximum 100 MB).",
    }


@pytest.mark.asyncio
async def test_in_flight_transfer_receipt_waits_for_the_owner_result() -> None:
    """Concurrent same-key requests share one factual result instead of mutating twice."""
    user = SimpleNamespace(username=f"receipt-owner-{uuid.uuid4()}")
    request = CopyMoveRequest(
        source_path="a.txt",
        dest_path="b.txt",
        idempotency_key=str(uuid.uuid4()),
    )

    assert await browser_api._find_transfer_receipt(user, request) is None
    waiting_result = asyncio.create_task(browser_api._find_transfer_receipt(user, request))
    await asyncio.sleep(0)
    assert not waiting_result.done()

    committed = ContentTransferResult(
        status="completed",
        effects=ContentTransferEffects(source="unchanged", destination="mutated"),
    )
    await browser_api._record_transfer_receipt(user, request, committed)

    assert await waiting_result == committed


@pytest.mark.asyncio
async def test_unrecorded_transfer_reservation_returns_unknown_outcome() -> None:
    """An owner that exits without facts cannot release a key for another mutation."""
    user = SimpleNamespace(username=f"receipt-owner-{uuid.uuid4()}")
    request = CopyMoveRequest(
        source_path="a.txt",
        dest_path="b.txt",
        idempotency_key=str(uuid.uuid4()),
    )

    assert await browser_api._find_transfer_receipt(user, request) is None
    waiting_result = asyncio.create_task(browser_api._find_transfer_receipt(user, request))
    await asyncio.sleep(0)
    await browser_api._record_unknown_transfer_outcome(user, request)

    assert (await waiting_result).status == "outcome_unknown"


def test_move_uses_native_same_connection_rename(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
):
    """A same-connection move uses the SMB native move primitive."""
    with patch("app.api.browser.SMBBackend") as mock_backend:
        mock_instance = AsyncMock()
        mock_instance.get_file_info.side_effect = [
            FileInfo(name="file.txt", path="docs/file.txt", type=FileType.FILE, size=1),
            FileNotFoundError("target does not exist"),
            FileNotFoundError("target does not exist"),
        ]
        mock_backend.return_value = mock_instance
        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={
                "source_path": "docs/file.txt",
                "dest_path": "archive/file.txt",
                "idempotency_key": str(uuid.uuid4()),
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "completed",
        "effects": {"source": "mutated", "destination": "mutated"},
        "replaced": False,
        "error": None,
    }
    mock_instance.move_item.assert_awaited_once_with("docs/file.txt", "archive/file.txt", overwrite=False)


def test_cross_provider_stream_destination_stages_before_publishing(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
):
    """A cross-provider body is delegated to the private SMB staging primitive."""
    scenario = PUBLISH_CONTRACT
    contents = scenario["contents"].encode()
    with patch("app.api.browser.SMBBackend") as mock_backend:
        mock_instance = AsyncMock()
        mock_backend.return_value = mock_instance
        mock_instance.get_file_info.side_effect = FileNotFoundError(scenario["target_path"])

        async def stage_and_commit(path: str, stream, *, before_commit, **_kwargs: object) -> int:
            assert path == scenario["target_path"]
            assert b"".join([chunk async for chunk in stream]) == contents
            await before_commit()
            return len(contents)

        mock_instance.stage_and_commit_new_file_from_stream.side_effect = stage_and_commit
        response = client.post(
            f"/api/browse/{test_connection.id}/transfer-stream",
            params={"path": scenario["target_path"], "expected_size": scenario["expected_size"]},
            headers=auth_headers_user,
            content=contents,
        )

    assert response.status_code == 200
    assert response.json()["status"] == scenario["expected_status"]
    assert response.json()["effects"] == scenario["expected_effects"]
    mock_instance.stage_and_commit_new_file_from_stream.assert_awaited_once()


def test_cross_provider_stream_destination_canonicalizes_only_the_target_leaf(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
):
    """Streaming a new destination must use NFC without changing source semantics."""
    nfd_name = "Auftragsbesta\u0308tigung.pdf"
    nfc_name = "Auftragsbestätigung.pdf"

    async def stage_and_commit(path: str, stream, *, before_commit, **_kwargs: object) -> int:
        assert path == f"incoming/{nfc_name}"
        assert b"".join([chunk async for chunk in stream]) == b"report"
        await before_commit()
        return 6

    with patch("app.api.browser.SMBBackend") as mock_backend:
        mock_instance = AsyncMock()
        mock_backend.return_value = mock_instance
        mock_instance.get_file_info.side_effect = FileNotFoundError("target does not exist")
        mock_instance.stage_and_commit_new_file_from_stream.side_effect = stage_and_commit
        response = client.post(
            f"/api/browse/{test_connection.id}/transfer-stream",
            params={"path": f"incoming/{nfd_name}", "expected_size": 6},
            headers=auth_headers_user,
            content=b"report",
        )

    assert response.status_code == 200
    mock_instance.stage_and_commit_new_file_from_stream.assert_awaited_once()


@pytest.mark.parametrize(
    "source_modified_at",
    [None, datetime(2025, 1, 1, tzinfo=timezone.utc), datetime(2025, 1, 2, tzinfo=timezone.utc)],
)
def test_cross_provider_stream_replace_older_skips_a_missing_equal_or_older_source_without_consuming_body(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
    source_modified_at: datetime | None,
):
    existing_target = FileInfo(
        name="report.txt",
        path="incoming/report.txt",
        type=FileType.FILE,
        size=8,
        modified_at=datetime(2025, 1, 2, tzinfo=timezone.utc),
    )
    parameters: dict[str, str | int] = {
        "path": "incoming/report.txt",
        "expected_size": 6,
        "target_resolution_policy": "replace_older",
    }
    if source_modified_at is not None:
        parameters["source_modified_at"] = source_modified_at.isoformat()

    with patch("app.api.browser.SMBBackend") as mock_backend:
        mock_instance = AsyncMock()
        mock_backend.return_value = mock_instance
        mock_instance.get_file_info.return_value = existing_target
        response = client.post(
            f"/api/browse/{test_connection.id}/transfer-stream",
            params=parameters,
            headers=auth_headers_user,
            content=b"report",
        )

    assert response.status_code == 200
    assert response.json()["status"] == "skipped"
    mock_instance.stage_and_commit_new_file_from_stream.assert_not_awaited()


def test_cross_provider_stream_replace_older_skips_a_malformed_source_timestamp_without_consuming_body(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
):
    existing_target = FileInfo(
        name="report.txt",
        path="incoming/report.txt",
        type=FileType.FILE,
        size=8,
        modified_at=datetime(2025, 1, 2, tzinfo=timezone.utc),
    )

    with patch("app.api.browser.SMBBackend") as mock_backend:
        mock_instance = AsyncMock()
        mock_backend.return_value = mock_instance
        mock_instance.get_file_info.return_value = existing_target
        response = client.post(
            f"/api/browse/{test_connection.id}/transfer-stream",
            params={
                "path": "incoming/report.txt",
                "expected_size": 6,
                "target_resolution_policy": "replace_older",
                "source_modified_at": "not-a-timestamp",
            },
            headers=auth_headers_user,
            content=b"report",
        )

    assert response.status_code == 200
    assert response.json()["status"] == "skipped"
    mock_instance.stage_and_commit_new_file_from_stream.assert_not_awaited()


def test_cross_provider_stream_replace_older_publishes_a_strictly_newer_source(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
):
    source_modified_at = datetime(2025, 1, 3, tzinfo=timezone.utc)
    existing_target = FileInfo(
        name="report.txt",
        path="incoming/report.txt",
        type=FileType.FILE,
        size=8,
        modified_at=datetime(2025, 1, 2, tzinfo=timezone.utc),
    )

    async def stage_and_commit(path: str, stream, *, before_commit, **kwargs: object) -> int:
        assert path == "incoming/report.txt"
        assert b"".join([chunk async for chunk in stream]) == b"report"
        assert kwargs["source_mtime"] == source_modified_at
        assert kwargs["overwrite"] is True
        assert await before_commit() is True
        return 6

    with patch("app.api.browser.SMBBackend") as mock_backend:
        mock_instance = AsyncMock()
        mock_backend.return_value = mock_instance
        mock_instance.get_file_info.side_effect = [existing_target, existing_target]
        mock_instance.stage_and_commit_new_file_from_stream.side_effect = stage_and_commit
        response = client.post(
            f"/api/browse/{test_connection.id}/transfer-stream",
            params={
                "path": "incoming/report.txt",
                "expected_size": 6,
                "target_resolution_policy": "replace_older",
                "source_modified_at": source_modified_at.isoformat(),
            },
            headers=auth_headers_user,
            content=b"report",
        )

    assert response.status_code == 200
    assert response.json() == {
        "status": "completed",
        "effects": {"source": "unchanged", "destination": "mutated"},
        "replaced": True,
        "error": None,
    }


def test_cross_provider_stream_replace_older_reports_a_target_type_change_at_final_commit(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
):
    source_modified_at = datetime(2025, 1, 3, tzinfo=timezone.utc)
    existing_file = FileInfo(
        name="report.txt",
        path="incoming/report.txt",
        type=FileType.FILE,
        size=8,
        modified_at=datetime(2025, 1, 2, tzinfo=timezone.utc),
    )
    replacement_directory = FileInfo(name="report.txt", path="incoming/report.txt", type=FileType.DIRECTORY)

    async def stage_and_commit(_path: str, stream, *, before_commit, **_kwargs: object) -> int:
        assert b"".join([chunk async for chunk in stream]) == b"report"
        await before_commit()
        raise AssertionError("The SMB stage must not promote after a target type conflict")

    with patch("app.api.browser.SMBBackend") as mock_backend:
        mock_instance = AsyncMock()
        mock_backend.return_value = mock_instance
        mock_instance.get_file_info.side_effect = [existing_file, replacement_directory]
        mock_instance.stage_and_commit_new_file_from_stream.side_effect = stage_and_commit
        response = client.post(
            f"/api/browse/{test_connection.id}/transfer-stream",
            params={
                "path": "incoming/report.txt",
                "expected_size": 6,
                "target_resolution_policy": "replace_older",
                "source_modified_at": source_modified_at.isoformat(),
            },
            headers=auth_headers_user,
            content=b"report",
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "Destination already exists: incoming/report.txt"


def test_cross_provider_stream_destination_rejects_empty_path_before_smb_work(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
):
    with patch("app.api.browser.SMBBackend") as mock_backend:
        response = client.post(
            f"/api/browse/{test_connection.id}/transfer-stream?path=/&expected_size=6",
            headers=auth_headers_user,
            content=b"report",
        )

    assert response.status_code == 400
    mock_backend.assert_not_called()


def test_cross_provider_stream_destination_requires_expected_size_before_smb_work(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
):
    with patch("app.api.browser.SMBBackend") as mock_backend:
        response = client.post(
            f"/api/browse/{test_connection.id}/transfer-stream?path=incoming/report.txt",
            headers=auth_headers_user,
            content=b"report",
        )

    assert response.status_code == 422
    mock_backend.assert_not_called()


@pytest.mark.parametrize(
    ("expected_size", "content", "expected_detail"),
    [
        (
            PUBLISH_CONTRACT["expected_size"],
            PUBLISH_CONTRACT["truncated_contents"].encode(),
            f"expected {PUBLISH_CONTRACT['expected_size']} bytes but received {len(PUBLISH_CONTRACT['truncated_contents'].encode())} bytes",
        ),
        (PUBLISH_CONTRACT["expected_size"], b"too long", f"expected {PUBLISH_CONTRACT['expected_size']} bytes but received more"),
    ],
)
def test_cross_provider_stream_destination_rejects_size_mismatch_before_commit(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
    expected_size: int,
    content: bytes,
    expected_detail: str,
):
    async def stage_and_commit(path: str, stream, *, before_commit, **_kwargs: object) -> int:
        assert path == "incoming/report.txt"
        async for _chunk in stream:
            pass
        await before_commit()
        pytest.fail("Size-mismatched stream must not reach the SMB commit callback")

    with patch("app.api.browser.SMBBackend") as mock_backend:
        mock_instance = AsyncMock()
        mock_backend.return_value = mock_instance
        mock_instance.get_file_info.side_effect = FileNotFoundError
        mock_instance.stage_and_commit_new_file_from_stream.side_effect = stage_and_commit
        response = client.post(
            f"/api/browse/{test_connection.id}/transfer-stream?path=incoming/report.txt&expected_size={expected_size}",
            headers=auth_headers_user,
            content=content,
        )

    assert response.status_code == 422
    assert expected_detail in response.json()["detail"]
    mock_instance.stage_and_commit_new_file_from_stream.assert_awaited_once()


def test_durable_transfer_operation_replays_preparation_and_persists_execution_receipt(
    client: TestClient,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
):
    """A regular SMB transfer has one durable operation and one factual receipt."""

    source_connection, destination_connection = multiple_connections[:2]
    source_info = FileInfo(
        name="report.txt",
        path="reports/report.txt",
        type=FileType.FILE,
        size=6,
        modified_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        stable_id="source-file-id",
    )
    destination_info = FileInfo(
        name="report.txt",
        path="incoming/report.txt",
        type=FileType.FILE,
        size=6,
        modified_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
    )
    idempotency_key = str(uuid.uuid4())
    payload = {
        "protocol_version": "v1",
        "idempotency_key": idempotency_key,
        "kind": "copy",
        "source_connection_id": str(source_connection.id),
        "source_path": "reports/report.txt",
        "destination_path": "incoming/report.txt",
        "target_resolution_policy": "replace",
    }
    with patch("app.api.browser.SMBBackend") as mock_backend:
        prepared_source = AsyncMock()
        execution_source = AsyncMock()
        destination = AsyncMock()
        prepared_source.get_file_info.return_value = source_info
        execution_source.get_file_info.return_value = source_info

        async def source_chunks():
            yield b"report"

        async def stage_and_commit(path: str, stream, *, before_commit, **_kwargs: object) -> int:
            assert path == "incoming/report.txt"
            assert b"".join([chunk async for chunk in stream]) == b"report"
            await before_commit()
            return 6

        execution_source.read_file = lambda _path: source_chunks()
        destination.get_file_info.return_value = destination_info
        destination.stage_and_commit_new_file_from_stream.side_effect = stage_and_commit
        mock_backend.side_effect = [prepared_source, execution_source, destination]

        prepared = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations",
            headers=auth_headers_user,
            json=payload,
        )
        replayed = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations",
            headers=auth_headers_user,
            json=payload,
        )
        operation_id = prepared.json()["id"]
        executed = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations/{operation_id}/execute",
            headers=auth_headers_user,
        )
        status = client.get(
            f"/api/browse/{destination_connection.id}/transfer-operations/{operation_id}",
            headers=auth_headers_user,
        )

    assert prepared.status_code == 200
    assert replayed.status_code == 200
    assert replayed.json()["id"] == operation_id
    assert executed.json()["status"] == "completed"
    assert executed.json()["replaced"] is True
    assert status.json()["phase"] == "completed"
    assert status.json()["bytes_transferred"] == 6
    assert status.json()["result"]["status"] == "completed"


def test_durable_transfer_operation_rejects_a_source_changed_after_preparation(
    client: TestClient,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
):
    """Execution must not reset the prepared source identity baseline."""

    source_connection, destination_connection = multiple_connections[:2]
    prepared_info = FileInfo(
        name="report.txt",
        path="reports/report.txt",
        type=FileType.FILE,
        size=6,
        modified_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        stable_id="original-id",
    )
    changed_info = prepared_info.model_copy(update={"stable_id": "replacement-id"})
    with patch("app.api.browser.SMBBackend") as mock_backend:
        prepared_source = AsyncMock()
        execution_source = AsyncMock()
        destination = AsyncMock()
        prepared_source.get_file_info.return_value = prepared_info
        execution_source.get_file_info.return_value = changed_info
        mock_backend.side_effect = [prepared_source, execution_source, destination]
        prepared = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations",
            headers=auth_headers_user,
            json={
                "protocol_version": "v1",
                "idempotency_key": str(uuid.uuid4()),
                "kind": "copy",
                "source_connection_id": str(source_connection.id),
                "source_path": "reports/report.txt",
                "destination_path": "incoming/report.txt",
            },
        )
        operation_id = prepared.json()["id"]
        executed = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations/{operation_id}/execute",
            headers=auth_headers_user,
        )

    assert executed.status_code == 200
    assert executed.json() == {
        "status": "failed",
        "replaced": False,
        "effects": {"source": "unchanged", "destination": "unchanged"},
        "error": {
            "code": "source_changed",
            "detail": "Source changed before durable transfer execution: reports/report.txt",
        },
    }
    destination.stage_and_commit_new_file_from_stream.assert_not_awaited()


@pytest.mark.parametrize("uncertain", [False, True])
def test_cross_connection_move_source_retention_preserves_replacement_fact(
    client: TestClient,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
    uncertain: bool,
):
    source_connection, destination_connection = multiple_connections[:2]
    source_backend = AsyncMock()
    destination_backend = AsyncMock()

    with (
        patch("app.api.browser.SMBBackend", side_effect=[source_backend, destination_backend]),
        patch(
            "app.api.browser.cross_connection_move",
            new_callable=AsyncMock,
            side_effect=SourceDeletionOutcomeUnknown("delete acknowledgement lost", replaced=True)
            if uncertain
            else SourceDeleteError("source retention", destination_mutated=True, replaced=True),
        ),
    ):
        response = client.post(
            f"/api/browse/{source_connection.id}/move",
            headers=auth_headers_user,
            json={
                "idempotency_key": str(uuid.uuid4()),
                "source_path": "reports/report.txt",
                "dest_path": "incoming/report.txt",
                "dest_connection_id": str(destination_connection.id),
                "target_resolution_policy": "replace",
            },
        )

    assert response.status_code == 200
    assert response.json() == (
        {
            "status": "outcome_unknown",
            "effects": {"source": "unknown", "destination": "mutated"},
            "replaced": True,
            "error": None,
        }
        if uncertain
        else {
            "status": "completed_with_source_retained",
            "effects": {"source": "unchanged", "destination": "mutated"},
            "replaced": True,
            "error": {"code": "source_delete_failed", "detail": "source retention"},
        }
    )


@pytest.mark.parametrize("kind", ["copy", "move"])
@pytest.mark.parametrize("published", [False, True])
def test_cross_connection_source_change_preserves_facts_and_destination_cache(
    client: TestClient,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
    kind: str,
    published: bool,
):
    source_connection, destination_connection = multiple_connections[:2]
    request = {
        "idempotency_key": str(uuid.uuid4()),
        "source_path": "reports/report.txt",
        "dest_path": "incoming/report.txt",
        "dest_connection_id": str(destination_connection.id),
        "target_resolution_policy": "replace",
    }
    with (
        patch("app.api.browser.SMBBackend", side_effect=[AsyncMock(), AsyncMock()]),
        patch(
            f"app.api.browser.cross_connection_{kind}",
            new_callable=AsyncMock,
            side_effect=SourceChangedError("source changed", destination_mutated=published, replaced=published),
        ) as transfer,
        patch("app.api.browser._add_to_directory_cache") as update_cache,
    ):
        response = client.post(f"/api/browse/{source_connection.id}/{kind}", headers=auth_headers_user, json=request)
        replay = client.post(f"/api/browse/{source_connection.id}/{kind}", headers=auth_headers_user, json=request)

    assert response.status_code == 200
    assert replay.json() == response.json()
    assert response.json() == {
        "status": "failed",
        "effects": {"source": "unchanged", "destination": "mutated" if published else "unchanged"},
        "replaced": published,
        "error": {"code": "source_changed", "detail": "source changed"},
    }
    transfer.assert_awaited_once()
    if published:
        update_cache.assert_called_once_with(str(destination_connection.id), request["dest_path"])
    else:
        update_cache.assert_not_called()


@pytest.mark.parametrize("failure", ["retained", "unknown", "source_changed"])
def test_durable_transfer_operation_source_retention_preserves_replacement_fact(
    client: TestClient,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
    failure: str,
):
    source_connection, destination_connection = multiple_connections[:2]
    source_info = FileInfo(
        name="report.txt",
        path="reports/report.txt",
        type=FileType.FILE,
        size=6,
        modified_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        stable_id="source-file-id",
    )
    prepared_source = AsyncMock()
    prepared_source.get_file_info.return_value = source_info
    execution_source = AsyncMock()
    execution_source.get_file_info.return_value = source_info
    destination = AsyncMock()

    with (
        patch("app.api.browser.SMBBackend", side_effect=[prepared_source, execution_source, destination]),
        patch(
            "app.api.browser.cross_connection_move",
            new_callable=AsyncMock,
            side_effect=(
                SourceDeletionOutcomeUnknown("delete acknowledgement lost", replaced=True)
                if failure == "unknown"
                else SourceChangedError("source changed", destination_mutated=True, replaced=True)
                if failure == "source_changed"
                else SourceDeleteError("source retention", destination_mutated=True, replaced=True)
            ),
        ),
    ):
        prepared = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations",
            headers=auth_headers_user,
            json={
                "protocol_version": "v1",
                "idempotency_key": str(uuid.uuid4()),
                "kind": "move",
                "source_connection_id": str(source_connection.id),
                "source_path": "reports/report.txt",
                "destination_path": "incoming/report.txt",
                "target_resolution_policy": "replace",
            },
        )
        executed = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations/{prepared.json()['id']}/execute",
            headers=auth_headers_user,
        )
        replayed = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations/{prepared.json()['id']}/execute",
            headers=auth_headers_user,
        )

    assert prepared.status_code == 200
    assert replayed.json() == executed.json()
    assert executed.json() == (
        {
            "status": "outcome_unknown",
            "effects": {"source": "unknown", "destination": "mutated"},
            "replaced": True,
            "error": None,
        }
        if failure == "unknown"
        else {
            "status": "failed",
            "effects": {"source": "unchanged", "destination": "mutated"},
            "replaced": True,
            "error": {"code": "source_changed", "detail": "source changed"},
        }
        if failure == "source_changed"
        else {
            "status": "completed_with_source_retained",
            "effects": {"source": "unchanged", "destination": "mutated"},
            "replaced": True,
            "error": {"code": "source_delete_failed", "detail": "source retention"},
        }
    )


@pytest.mark.parametrize("phase", ["before_publication", "after_publication", "after_delete_dispatch", "uncertain_delete"])
def test_durable_move_cancellation_preserves_publication_and_delete_facts(
    client: TestClient,
    session: Session,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
    phase: str,
):
    source_connection, destination_connection = multiple_connections[:2]
    info = FileInfo(
        name="report.txt",
        path="reports/report.txt",
        type=FileType.FILE,
        size=6,
        modified_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        stable_id="original",
    )
    prepared_source, source, destination, reader = AsyncMock(), AsyncMock(), AsyncMock(), AsyncMock()
    prepared_source.get_file_info.return_value = info
    source.get_file_info.return_value = info
    reader.get_file_info.return_value = info
    reader.read_at.return_value = b"report"
    source.open_move_source_reader.return_value = reader
    destination.get_file_info.return_value = info.model_copy(update={"path": "incoming/report.txt"})
    published: list[bytes] = []

    def cancel():
        operation = session.exec(select(TransferOperation)).one()
        operation.cancellation_requested = True
        session.add(operation)
        session.commit()

    async def stage(_path, stream, *, before_commit, **_kwargs):
        data = b"".join([chunk async for chunk in stream])
        if phase == "before_publication":
            cancel()
        await before_commit()
        published.append(data)
        if phase == "after_publication":
            cancel()
        return len(data)

    async def delete(*, cancellation=None):
        cancel()
        if phase == "uncertain_delete":
            raise SourceDeletionOutcomeUnknown("lost delete acknowledgement")

    destination.stage_and_commit_new_file_from_stream.side_effect = stage
    reader.commit_delete.side_effect = delete
    with patch("app.api.browser.SMBBackend", side_effect=[prepared_source, source, destination]):
        prepared = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations",
            headers=auth_headers_user,
            json={
                "protocol_version": "v1",
                "idempotency_key": str(uuid.uuid4()),
                "kind": "move",
                "source_connection_id": str(source_connection.id),
                "source_path": info.path,
                "destination_path": "incoming/report.txt",
                "target_resolution_policy": "replace",
            },
        )
        assert prepared.status_code == 200
        url = f"/api/browse/{destination_connection.id}/transfer-operations/{prepared.json()['id']}/execute"
        executed = client.post(url, headers=auth_headers_user)
        replayed = client.post(url, headers=auth_headers_user)
    assert executed.status_code == 200
    assert replayed.json() == executed.json()
    expected = {
        "before_publication": "cancelled",
        "after_publication": "completed_with_source_retained",
        "after_delete_dispatch": "completed",
        "uncertain_delete": "outcome_unknown",
    }[phase]
    assert executed.json()["status"] == expected
    assert executed.json()["replaced"] is (phase != "before_publication")
    assert executed.json()["effects"]["destination"] == ("unchanged" if phase == "before_publication" else "mutated")
    assert published == ([] if phase == "before_publication" else [b"report"])
    assert reader.commit_delete.await_count == (1 if phase in {"after_delete_dispatch", "uncertain_delete"} else 0)
    reader.close.assert_awaited_once()


def test_durable_transfer_operation_cancels_before_provider_execution(
    client: TestClient,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
):
    """A prepared operation can be cancelled without opening either SMB provider."""

    source_connection, destination_connection = multiple_connections[:2]
    source_info = FileInfo(
        name="report.txt",
        path="reports/report.txt",
        type=FileType.FILE,
        size=6,
        modified_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        stable_id="source-file-id",
    )
    with patch("app.api.browser.SMBBackend") as mock_backend:
        prepared_source = AsyncMock()
        prepared_source.get_file_info.return_value = source_info
        mock_backend.return_value = prepared_source
        prepared = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations",
            headers=auth_headers_user,
            json={
                "protocol_version": "v1",
                "idempotency_key": str(uuid.uuid4()),
                "kind": "move",
                "source_connection_id": str(source_connection.id),
                "source_path": "reports/report.txt",
                "destination_path": "incoming/report.txt",
            },
        )
        operation_id = prepared.json()["id"]
        cancelled = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations/{operation_id}/cancel",
            headers=auth_headers_user,
        )
        executed = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations/{operation_id}/execute",
            headers=auth_headers_user,
        )

    assert cancelled.status_code == 200
    assert cancelled.json()["phase"] == "cancelled"
    assert cancelled.json()["cancellation_requested"] is True
    assert cancelled.json()["result"]["status"] == "cancelled"
    assert executed.json()["status"] == "cancelled"
    assert mock_backend.call_count == 1


def test_durable_transfer_operation_cancels_during_streaming(
    client: TestClient,
    session: Session,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
):
    """A cancellation observed during a bounded write aborts before promotion."""

    source_connection, destination_connection = multiple_connections[:2]
    source_info = FileInfo(
        name="report.txt",
        path="reports/report.txt",
        type=FileType.FILE,
        size=6,
        modified_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        stable_id="source-file-id",
    )
    with patch("app.api.browser.SMBBackend") as mock_backend:
        prepared_source = AsyncMock()
        execution_source = AsyncMock()
        destination = AsyncMock()
        prepared_source.get_file_info.return_value = source_info
        execution_source.get_file_info.return_value = source_info

        async def source_chunks():
            yield b"report"

        async def stage_and_cancel(_path: str, _stream, *, on_progress, **_kwargs: object) -> int:
            operation = session.exec(select(TransferOperation)).one()
            operation.cancellation_requested = True
            session.add(operation)
            session.commit()
            on_progress(6, 6)
            raise AssertionError("cancellation should interrupt the stage callback")

        execution_source.read_file = lambda _path: source_chunks()
        destination.get_file_info.side_effect = FileNotFoundError("missing target")
        destination.stage_and_commit_new_file_from_stream.side_effect = stage_and_cancel
        mock_backend.side_effect = [prepared_source, execution_source, destination]
        prepared = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations",
            headers=auth_headers_user,
            json={
                "protocol_version": "v1",
                "idempotency_key": str(uuid.uuid4()),
                "kind": "copy",
                "source_connection_id": str(source_connection.id),
                "source_path": "reports/report.txt",
                "destination_path": "incoming/report.txt",
            },
        )
        executed = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations/{prepared.json()['id']}/execute",
            headers=auth_headers_user,
        )

    assert executed.status_code == 200
    assert executed.json()["status"] == "cancelled"
    assert executed.json()["effects"] == {"source": "unchanged", "destination": "unchanged"}


def test_durable_transfer_operation_repairs_a_corrupt_terminal_receipt(
    client: TestClient,
    session: Session,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
):
    """A terminal operation with unreadable state is recoverable as unknown, not restarted."""

    source_connection, destination_connection = multiple_connections[:2]
    source_info = FileInfo(
        name="report.txt",
        path="reports/report.txt",
        type=FileType.FILE,
        size=6,
        modified_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        stable_id="source-file-id",
    )
    with patch("app.api.browser.SMBBackend") as mock_backend:
        source_backend = AsyncMock()
        source_backend.get_file_info.return_value = source_info
        mock_backend.return_value = source_backend
        prepared = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations",
            headers=auth_headers_user,
            json={
                "protocol_version": "v1",
                "idempotency_key": str(uuid.uuid4()),
                "kind": "copy",
                "source_connection_id": str(source_connection.id),
                "source_path": "reports/report.txt",
                "destination_path": "incoming/report.txt",
            },
        )
        operation = session.get(TransferOperation, uuid.UUID(prepared.json()["id"]))
        assert operation is not None
        operation.phase = TransferOperationPhase.COMPLETED
        operation.result_json = "not json"
        session.add(operation)
        session.commit()
        repaired = client.get(
            f"/api/browse/{destination_connection.id}/transfer-operations/{operation.id}",
            headers=auth_headers_user,
        )

    assert repaired.status_code == 200
    assert repaired.json()["phase"] == "failed"
    assert repaired.json()["result"] == {
        "status": "outcome_unknown",
        "replaced": False,
        "effects": {"source": "unknown", "destination": "unknown"},
        "error": None,
    }
    assert mock_backend.call_count == 1


def test_durable_transfer_operation_is_scoped_to_its_destination_connection(
    client: TestClient,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
):
    """An operation ID cannot be used through another SMB destination route."""

    source_connection, destination_connection = multiple_connections[:2]
    source_info = FileInfo(
        name="report.txt",
        path="reports/report.txt",
        type=FileType.FILE,
        size=6,
        modified_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        stable_id="source-file-id",
    )
    with patch("app.api.browser.SMBBackend") as mock_backend:
        source_backend = AsyncMock()
        source_backend.get_file_info.return_value = source_info
        mock_backend.return_value = source_backend
        prepared = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations",
            headers=auth_headers_user,
            json={
                "protocol_version": "v1",
                "idempotency_key": str(uuid.uuid4()),
                "kind": "copy",
                "source_connection_id": str(source_connection.id),
                "source_path": "reports/report.txt",
                "destination_path": "incoming/report.txt",
            },
        )
        wrong_destination = client.get(
            f"/api/browse/{source_connection.id}/transfer-operations/{prepared.json()['id']}",
            headers=auth_headers_user,
        )

    assert wrong_destination.status_code == 404
    assert wrong_destination.json()["detail"] == "Transfer operation not found"


def test_expired_streaming_transfer_operation_reports_an_unknown_outcome(
    client: TestClient,
    session: Session,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
):
    """Expiry during streaming cannot claim either filesystem is unchanged."""

    source_connection, destination_connection = multiple_connections[:2]
    source_info = FileInfo(
        name="report.txt",
        path="reports/report.txt",
        type=FileType.FILE,
        size=6,
        modified_at=datetime(2025, 1, 1, tzinfo=timezone.utc),
        stable_id="source-file-id",
    )
    with patch("app.api.browser.SMBBackend") as mock_backend:
        source_backend = AsyncMock()
        source_backend.get_file_info.return_value = source_info
        mock_backend.return_value = source_backend
        prepared = client.post(
            f"/api/browse/{destination_connection.id}/transfer-operations",
            headers=auth_headers_user,
            json={
                "protocol_version": "v1",
                "idempotency_key": str(uuid.uuid4()),
                "kind": "copy",
                "source_connection_id": str(source_connection.id),
                "source_path": "reports/report.txt",
                "destination_path": "incoming/report.txt",
            },
        )
        operation = session.get(TransferOperation, uuid.UUID(prepared.json()["id"]))
        assert operation is not None
        operation.phase = TransferOperationPhase.STREAMING
        operation.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        session.add(operation)
        session.commit()
        expired = client.get(
            f"/api/browse/{destination_connection.id}/transfer-operations/{operation.id}",
            headers=auth_headers_user,
        )

    assert expired.status_code == 200
    assert expired.json()["phase"] == "failed"
    assert expired.json()["result"] == {
        "status": "outcome_unknown",
        "replaced": False,
        "effects": {"source": "unknown", "destination": "unknown"},
        "error": None,
    }


@pytest.mark.parametrize("idempotency_key", [None, "not-a-uuid"])
def test_copy_rejects_missing_or_malformed_idempotency_key(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
    idempotency_key: str | None,
):
    """Copy requests require a caller-provided UUID before any SMB work."""
    payload = {"source_path": "docs/file.txt", "dest_path": "archive/file.txt"}
    if idempotency_key is not None:
        payload["idempotency_key"] = idempotency_key

    with patch("app.api.browser.SMBBackend") as mock_backend:
        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json=payload,
        )

    assert response.status_code == 422
    mock_backend.assert_not_called()


def test_smb_to_local_routes_are_absent(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
):
    """The withdrawn SMB-to-local capability and source routes are not registered."""
    responses = (
        client.post(
            f"/api/browse/{test_connection.id}/transfer/smb-to-local-capability",
            headers=auth_headers_user,
            json={},
        ),
        client.get(
            f"/api/browse/{test_connection.id}/transfer/relay/source",
            headers=auth_headers_user,
        ),
    )

    assert [response.status_code for response in responses] == [404, 404]


@pytest.fixture
def mock_smb_backend():
    """Create a mock SMB backend."""
    with patch("app.api.browser.SMBBackend") as mock:
        backend_instance = AsyncMock()

        # Mock file listing
        mock_files = [
            FileInfo(
                name="document.txt",
                path="/document.txt",
                type=FileType.FILE,
                size=1024,
                modified_at=datetime(2024, 1, 1, 12, 0, 0),
                mime_type="text/plain",
            ),
            FileInfo(
                name="folder",
                path="/folder",
                type=FileType.DIRECTORY,
                size=None,
                modified_at=datetime(2024, 1, 2, 12, 0, 0),
                mime_type=None,
            ),
            FileInfo(
                name="readme.md",
                path="/readme.md",
                type=FileType.FILE,
                size=2048,
                modified_at=datetime(2024, 1, 3, 12, 0, 0),
                mime_type="text/markdown",
            ),
        ]

        # Return DirectoryListing object as the API expects
        backend_instance.list_directory.return_value = DirectoryListing(
            path="",
            items=mock_files,
            total=len(mock_files),
        )
        backend_instance.get_file_info.return_value = mock_files[0]
        backend_instance.connect.return_value = None
        backend_instance.disconnect.return_value = None

        # Mock constructor to return our instance
        mock.return_value = backend_instance

        yield mock, backend_instance


@pytest.mark.integration
class TestListDirectory:
    """Test directory listing endpoint."""

    def test_list_root_directory(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test listing root directory."""
        mock_class, mock_instance = mock_smb_backend

        response = client.get(
            f"/api/browse/{test_connection.id}/list",
            headers=auth_headers_user,
            params={"path": ""},
        )

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert len(data["items"]) == 3

        # Verify first file
        first_file = data["items"][0]
        assert first_file["name"] == "document.txt"
        assert first_file["type"] == "file"
        assert first_file["size"] == 1024

        # Verify directory
        folder = data["items"][1]
        assert folder["name"] == "folder"
        assert folder["type"] == "directory"
        assert folder["size"] is None

        # Verify SMB backend was called correctly
        mock_instance.connect.assert_called_once()
        mock_instance.list_directory.assert_called_once_with("")
        mock_instance.disconnect.assert_called_once()

    def test_list_subdirectory(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test listing a subdirectory."""
        mock_class, mock_instance = mock_smb_backend

        response = client.get(
            f"/api/browse/{test_connection.id}/list",
            headers=auth_headers_admin,
            params={"path": "/folder/subfolder"},
        )

        assert response.status_code == 200
        mock_instance.list_directory.assert_called_once_with("/folder/subfolder")

    def test_list_directory_without_auth(self, client: TestClient, test_connection: Connection):
        """Test that listing directory requires authentication."""
        response = client.get(
            f"/api/browse/{test_connection.id}/list",
            params={"path": ""},
        )
        assert response.status_code == 401

    def test_list_nonexistent_connection(self, client: TestClient, auth_headers_user: dict):
        """Test listing directory for non-existent connection."""
        import uuid

        fake_id = uuid.uuid4()
        response = client.get(
            f"/api/browse/{fake_id}/list",
            headers=auth_headers_user,
            params={"path": ""},
        )
        assert response.status_code == 404

    def test_list_connection_without_share(self, client: TestClient, auth_headers_user: dict, session):
        """Test listing directory for connection without share name."""
        import uuid

        from app.core.security import encrypt_password

        # Create connection without share_name
        incomplete_conn = Connection(
            id=uuid.uuid4(),
            name="Incomplete Connection",
            host="server.local",
            share_name=None,  # Missing share name
            username="user",
            password_encrypted=encrypt_password("pass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(incomplete_conn)
        session.commit()

        response = client.get(
            f"/api/browse/{incomplete_conn.id}/list",
            headers=auth_headers_user,
            params={"path": ""},
        )
        assert response.status_code == 400


@pytest.mark.integration
class TestListArchiveDirectory:
    def test_lists_zip_root_with_authenticated_connection(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        _, backend = mock_smb_backend
        data = _archive_bytes()
        archive_reader = _MemoryRandomAccessReader(data)
        backend.get_file_info.return_value = FileInfo(
            name="backup.zip",
            path="backup.zip",
            type=FileType.FILE,
            size=len(data),
        )
        backend.open_random_access_reader = AsyncMock(return_value=archive_reader)

        response = client.get(
            f"/api/browse/{test_connection.id}/archive/list",
            headers=auth_headers_user,
            params={"archive_path": "backup.zip", "page_size": 1},
        )

        assert response.status_code == 200
        result = response.json()
        assert [(item["name"], item["type"]) for item in result["items"]] == [("docs", "directory")]
        assert result["items"][0]["state"] == "readable"
        assert result["next_cursor"] is not None
        assert archive_reader.closed is True
        assert len(archive_reader.reads) == 2

    def test_lists_zip_subdirectory_with_canonical_path(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        _, backend = mock_smb_backend
        data = _archive_bytes()
        archive_reader = _MemoryRandomAccessReader(data)
        backend.get_file_info.return_value = FileInfo(
            name="backup.zip",
            path="backup.zip",
            type=FileType.FILE,
            size=len(data),
        )
        backend.open_random_access_reader = AsyncMock(return_value=archive_reader)

        response = client.get(
            f"/api/browse/{test_connection.id}/archive/list",
            headers=auth_headers_user,
            params={"archive_path": "backup.zip", "virtual_path": "docs"},
        )

        assert response.status_code == 200
        result = response.json()
        assert result["path"] == "docs"
        assert [(item["name"], item["path"], item["type"]) for item in result["items"]] == [
            ("readme.txt", "docs/readme.txt", "file"),
        ]

    def test_rejects_invalid_archive_listing_cursor_through_inspection_resolver(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        _, backend = mock_smb_backend
        data = _archive_bytes()
        archive_reader = _MemoryRandomAccessReader(data)
        backend.get_file_info.return_value = FileInfo(name="backup.zip", path="backup.zip", type=FileType.FILE, size=len(data))
        backend.open_random_access_reader = AsyncMock(return_value=archive_reader)

        response = client.get(
            f"/api/browse/{test_connection.id}/archive/list",
            headers=auth_headers_user,
            params={"archive_path": "backup.zip", "cursor": "not-a-cursor"},
        )

        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid_zip"
        assert "cursor is invalid" in response.json()["detail"]["message"]
        assert archive_reader.closed is True


@pytest.mark.integration
class TestStreamArchiveMember:
    @pytest.mark.parametrize(
        "member_path,content_type",
        [("docs/page.html", "text/html"), ("docs/icon.svg", "image/svg+xml"), ("docs/page.xhtml", "application/xhtml+xml")],
    )
    def test_active_archive_member_is_downloaded(self, client, auth_headers_user, test_connection, member_path, content_type):
        data = _archive_bytes({member_path: b"active content"})
        backend = AsyncMock()
        backend.get_file_info.return_value = FileInfo(name="backup.zip", path="backup.zip", type=FileType.FILE, size=len(data))
        backend.open_random_access_reader = AsyncMock(return_value=_MemoryRandomAccessReader(data))

        with (
            patch("app.api.viewer.SMBBackend", return_value=backend),
            patch("app.services.archive.coordinator.mimetypes.guess_type", return_value=(None, None)),
        ):
            response = client.get(
                f"/api/viewer/{test_connection.id}/archive/member",
                headers=auth_headers_user,
                params={"archive_path": "backup.zip", "member_path": member_path},
            )

        assert response.status_code == 200
        assert response.content == b"active content"
        assert response.headers["content-type"].startswith(content_type)
        assert response.headers["content-disposition"].startswith("attachment;")
        assert response.headers["x-content-type-options"] == "nosniff"

    def test_streams_validated_zip_member(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        data = _archive_bytes()
        archive_reader = _MemoryRandomAccessReader(data)
        backend = AsyncMock()
        backend.connect.return_value = None
        backend.disconnect.return_value = None
        backend.get_file_info.return_value = FileInfo(
            name="backup.zip",
            path="backup.zip",
            type=FileType.FILE,
            size=len(data),
        )
        backend.open_random_access_reader = AsyncMock(return_value=archive_reader)

        with patch("app.api.viewer.SMBBackend", return_value=backend):
            response = client.get(
                f"/api/viewer/{test_connection.id}/archive/member",
                headers=auth_headers_user,
                params={"archive_path": "backup.zip", "member_path": "docs/readme.txt"},
            )

        assert response.status_code == 200
        assert response.content == b"hello"
        assert response.headers["content-type"].startswith("text/plain")
        assert response.headers["content-disposition"].startswith("inline;")
        assert archive_reader.closed is True

    def test_streams_zip_member_after_one_local_header_validation(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        data = _archive_bytes()
        archive_reader = _MemoryRandomAccessReader(data)
        backend = AsyncMock()
        backend.connect.return_value = None
        backend.disconnect.return_value = None
        backend.get_file_info.return_value = FileInfo(
            name="backup.zip",
            path="backup.zip",
            type=FileType.FILE,
            size=len(data),
        )
        backend.open_random_access_reader = AsyncMock(return_value=archive_reader)

        with patch("app.api.viewer.SMBBackend", return_value=backend):
            response = client.get(
                f"/api/viewer/{test_connection.id}/archive/member",
                headers=auth_headers_user,
                params={"archive_path": "backup.zip", "member_path": "docs/readme.txt"},
            )

        assert response.status_code == 200
        assert archive_reader.reads.count((0, 30)) == 1

    @pytest.mark.parametrize(
        ("member_path", "archive_data", "error_message"),
        [
            pytest.param("missing.txt", _archive_bytes(), "was not found", id="missing-member"),
            pytest.param(
                "docs/readme.txt",
                _archive_bytes(compression=zipfile.ZIP_LZMA),
                "unavailable codec",
                id="unavailable-codec",
            ),
            pytest.param(
                "docs/readme.txt",
                _archive_bytes_with_encrypted_members(),
                "blocked feature",
                id="encrypted-member",
            ),
        ],
    )
    def test_rejects_invalid_or_unavailable_archive_members_through_inspection_resolver(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        member_path: str,
        archive_data: bytes,
        error_message: str,
    ):
        archive_reader = _MemoryRandomAccessReader(archive_data)
        backend = AsyncMock()
        backend.connect.return_value = None
        backend.disconnect.return_value = None
        backend.get_file_info.return_value = FileInfo(name="backup.zip", path="backup.zip", type=FileType.FILE, size=len(archive_data))
        backend.open_random_access_reader = AsyncMock(return_value=archive_reader)

        with patch("app.api.viewer.SMBBackend", return_value=backend):
            response = client.get(
                f"/api/viewer/{test_connection.id}/archive/member",
                headers=auth_headers_user,
                params={"archive_path": "backup.zip", "member_path": member_path},
            )

        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "invalid_zip"
        assert error_message in response.json()["detail"]["message"]
        assert archive_reader.closed is True

    def test_rejects_oversized_archive_preview_through_inspection_resolver(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        archive_data = _archive_bytes({"large.txt": b"x" * (5 * 1024 * 1024 + 1)})
        archive_reader = _MemoryRandomAccessReader(archive_data)
        backend = AsyncMock()
        backend.connect.return_value = None
        backend.disconnect.return_value = None
        backend.get_file_info.return_value = FileInfo(name="backup.zip", path="backup.zip", type=FileType.FILE, size=len(archive_data))
        backend.open_random_access_reader = AsyncMock(return_value=archive_reader)

        with patch("app.api.viewer.SMBBackend", return_value=backend):
            response = client.get(
                f"/api/viewer/{test_connection.id}/archive/member",
                headers=auth_headers_user,
                params={"archive_path": "backup.zip", "member_path": "large.txt", "view_kind": "text"},
            )

        assert response.status_code == 413
        assert response.json()["detail"] == "Archive member exceeds the inline preview size limit"
        assert archive_reader.closed is True

    def test_invalidates_archive_pdf_derivative_through_inspection_resolver(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        data = _archive_bytes({"docs/inside.pdf": b"%PDF-1.7"})
        archive_reader = _MemoryRandomAccessReader(data)
        backend = AsyncMock()
        backend.connect.return_value = None
        backend.disconnect.return_value = None
        backend.get_file_info.return_value = FileInfo(
            name="backup.zip",
            path="backup.zip",
            type=FileType.FILE,
            size=len(data),
        )
        backend.open_random_access_reader = AsyncMock(return_value=archive_reader)

        with (
            patch("app.api.viewer.SMBBackend", return_value=backend),
            patch("app.api.viewer.invalidate_pdf_derivative_for_revision", new_callable=AsyncMock) as invalidate_derivative,
        ):
            response = client.delete(
                f"/api/viewer/{test_connection.id}/archive/member/pdf-derivative",
                headers=auth_headers_user,
                params={"archive_path": "backup.zip", "member_path": "docs/inside.pdf"},
            )

        assert response.status_code == 204
        invalidate_derivative.assert_awaited_once()
        assert archive_reader.closed is True

    def test_streams_large_raw_archive_members_like_physical_files(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        large_content = b"a" * (5 * 1024 * 1024 + 1)
        data = _archive_bytes({"docs/large.txt": large_content})
        backend = AsyncMock()
        backend.connect.return_value = None
        backend.disconnect.return_value = None
        backend.get_file_info.return_value = FileInfo(
            name="backup.zip",
            path="backup.zip",
            type=FileType.FILE,
            size=len(data),
        )
        backend.open_random_access_reader = AsyncMock(return_value=_MemoryRandomAccessReader(data))

        with patch("app.api.viewer.SMBBackend", return_value=backend):
            response = client.get(
                f"/api/viewer/{test_connection.id}/archive/member",
                headers=auth_headers_user,
                params={"archive_path": "backup.zip", "member_path": "docs/large.txt"},
            )

        assert response.status_code == 200
        assert response.content == large_content

    def test_converts_archive_jpeg_xl_for_browser_viewing(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        data = _archive_bytes({"images/photo.jxl": b"valid JPEG XL"})
        archive_reader = _MemoryRandomAccessReader(data)
        backend = AsyncMock()
        backend.connect.return_value = None
        backend.disconnect.return_value = None
        backend.get_file_info.return_value = FileInfo(
            name="backup.zip",
            path="backup.zip",
            type=FileType.FILE,
            size=len(data),
        )
        backend.open_random_access_reader = AsyncMock(return_value=archive_reader)

        with (
            patch("app.api.viewer.SMBBackend", return_value=backend),
            patch("app.api.viewer.convert_image_for_viewer", return_value=(b"converted", "image/webp", "libvips", 1)),
        ):
            response = client.get(
                f"/api/viewer/{test_connection.id}/archive/member",
                headers=auth_headers_user,
                params={
                    "archive_path": "backup.zip",
                    "member_path": "images/photo.jxl",
                    "view_kind": "image",
                    "viewport_width": 1280,
                    "viewport_height": 720,
                },
            )

        assert response.status_code == 200
        assert response.content == b"converted"
        assert response.headers["content-type"].startswith("image/webp")
        assert archive_reader.closed is True

    def test_normalizes_archive_pdf_through_the_shared_derivative_pipeline(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        data = _archive_bytes({"docs/inside.pdf": b"%PDF-1.7"})
        archive_reader = _MemoryRandomAccessReader(data)
        backend = AsyncMock()
        backend.connect.return_value = None
        backend.disconnect.return_value = None
        backend.get_file_info.return_value = FileInfo(
            name="backup.zip",
            path="backup.zip",
            type=FileType.FILE,
            size=len(data),
        )
        backend.open_random_access_reader = AsyncMock(return_value=archive_reader)

        with (
            patch("app.api.viewer.SMBBackend", return_value=backend),
            patch(
                "app.api.viewer.create_normalized_pdf_response_for_source",
                new_callable=AsyncMock,
                return_value=Response(content=b"normalized", media_type="application/pdf"),
            ) as normalize_pdf,
        ):
            response = client.get(
                f"/api/viewer/{test_connection.id}/archive/member",
                headers=auth_headers_user,
                params={
                    "archive_path": "backup.zip",
                    "member_path": "docs/inside.pdf",
                    "view_kind": "pdf",
                    "pdf_variant": "normalized",
                },
            )

        assert response.status_code == 200
        assert response.content == b"normalized"
        assert normalize_pdf.await_count == 1
        assert archive_reader.closed is True


@pytest.mark.integration
class TestGetFileInfo:
    """Test get file info endpoint."""

    def test_get_file_info_success(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test getting file info successfully."""
        mock_class, mock_instance = mock_smb_backend

        response = client.get(
            f"/api/browse/{test_connection.id}/info",
            headers=auth_headers_user,
            params={"path": "/document.txt"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "document.txt"
        assert data["type"] == "file"
        assert data["size"] == 1024

        mock_instance.get_file_info.assert_called_once_with("/document.txt")

    def test_get_file_info_without_auth(self, client: TestClient, test_connection: Connection):
        """Test that getting file info requires authentication."""
        response = client.get(
            f"/api/browse/{test_connection.id}/info",
            params={"path": "/document.txt"},
        )
        assert response.status_code == 401

    def test_get_file_info_not_found(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Missing files should return 404 so copy preflight can continue."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.get_file_info.side_effect = FileNotFoundError("Path not found: /missing.txt")

        response = client.get(
            f"/api/browse/{test_connection.id}/info",
            headers=auth_headers_user,
            params={"path": "/missing.txt"},
        )

        assert response.status_code == 404
        assert response.json()["detail"] == "Path not found: /missing.txt"

    def test_get_file_info_accepts_companion_operation_context(
        self,
        client: TestClient,
        admin_user,
        test_connection: Connection,
        mock_smb_backend,
        session: Session,
    ):
        """Companion conflict checks should be able to fetch file info with operation-scoped auth."""
        _, mock_instance = mock_smb_backend
        edit_lock = EditLock(
            connection_id=test_connection.id,
            file_path="/document.txt",
            locked_by=admin_user.username,
            last_heartbeat=datetime.now(timezone.utc) - timedelta(seconds=5),
            operation_id="operation-123",
            lock_capability="capability-123",
        )
        session.add(edit_lock)
        session.commit()
        session.refresh(edit_lock)
        operation_token = create_access_token(
            data={
                "sub": admin_user.username,
                "tv": admin_user.token_version,
                COMPANION_TOKEN_CLAIM: True,
                "token_class": COMPANION_TOKEN_CLASS,
                "purpose": COMPANION_OPERATION_PURPOSE,
                "conn_id": str(test_connection.id),
                "path": "/document.txt",
                "op_id": "operation-123",
                "lock_id": str(edit_lock.id),
            }
        )

        response = client.get(
            f"/api/browse/{test_connection.id}/info",
            headers={"Authorization": f"Bearer {operation_token}"},
            params={
                "path": "/document.txt",
                "operation_id": "operation-123",
                "lock_id": str(edit_lock.id),
                "lock_capability": "capability-123",
            },
        )

        assert response.status_code == 200
        assert response.json()["name"] == "document.txt"
        mock_instance.get_file_info.assert_called_once_with("/document.txt")

    def test_get_file_info_rejects_operation_token_without_operation_context(
        self,
        client: TestClient,
        admin_user,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Operation tokens must not authenticate generic browser file-info requests."""
        _, mock_instance = mock_smb_backend
        operation_token = create_access_token(
            data={
                "sub": admin_user.username,
                "tv": admin_user.token_version,
                COMPANION_TOKEN_CLAIM: True,
                "token_class": COMPANION_TOKEN_CLASS,
                "purpose": COMPANION_OPERATION_PURPOSE,
                "conn_id": str(test_connection.id),
                "path": "/document.txt",
                "op_id": "operation-123",
                "lock_id": str(uuid.uuid4()),
            }
        )

        response = client.get(
            f"/api/browse/{test_connection.id}/info",
            headers={"Authorization": f"Bearer {operation_token}"},
            params={"path": "/document.txt"},
        )

        assert response.status_code == 401
        mock_instance.get_file_info.assert_not_called()


@pytest.mark.integration
class TestBrowserEditLocks:
    """Test browser-authenticated edit lock lifecycle endpoints."""

    def test_acquire_browser_edit_lock(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        response = client.post(
            f"/api/browse/{test_connection.id}/lock",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["lock_id"]
        assert data["lock_capability"]
        assert data["operation_id"]
        assert data["file_path"] == "/docs/readme.md"

    def test_acquire_browser_edit_lock_replaces_malformed_legacy_lock(
        self,
        client: TestClient,
        auth_headers_user: dict,
        regular_user,
        test_connection: Connection,
        session: Session,
    ):
        legacy_lock = EditLock(
            file_path="/docs/readme.md",
            connection_id=test_connection.id,
            locked_by=regular_user.username,
            operation_id="",
            lock_capability="",
            last_heartbeat=datetime.now(timezone.utc),
        )
        session.add(legacy_lock)
        session.commit()
        session.refresh(legacy_lock)
        legacy_lock_id = str(legacy_lock.id)

        response = client.post(
            f"/api/browse/{test_connection.id}/lock",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["lock_id"] != legacy_lock_id
        assert data["lock_capability"]
        assert data["operation_id"]

        replacement_lock = session.exec(select(EditLock).where(EditLock.connection_id == test_connection.id)).one()
        assert str(replacement_lock.id) == data["lock_id"]
        assert replacement_lock.lock_capability == data["lock_capability"]
        assert replacement_lock.operation_id == data["operation_id"]
        assert replacement_lock.locked_by == regular_user.username

    def test_acquire_browser_edit_lock_rejects_a_second_session_for_the_same_user(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        session: Session,
    ):
        first = client.post(
            f"/api/browse/{test_connection.id}/lock",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
        )
        second = client.post(
            f"/api/browse/{test_connection.id}/lock",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
        )

        assert first.status_code == 200
        assert second.status_code == 409
        locks = session.exec(select(EditLock).where(EditLock.connection_id == test_connection.id)).all()
        assert len(locks) == 1
        assert str(locks[0].id) == first.json()["lock_id"]

    def test_browser_edit_lock_heartbeat_and_release(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        session: Session,
    ):
        acquire = client.post(
            f"/api/browse/{test_connection.id}/lock",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
        )
        assert acquire.status_code == 200
        lock = acquire.json()

        heartbeat = client.post(
            f"/api/browse/{test_connection.id}/lock/heartbeat",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
            json={
                "operation_id": lock["operation_id"],
                "lock_id": lock["lock_id"],
                "lock_capability": lock["lock_capability"],
            },
        )
        assert heartbeat.status_code == 200

        release = client.request(
            "DELETE",
            f"/api/browse/{test_connection.id}/lock",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
            json={
                "operation_id": lock["operation_id"],
                "lock_id": lock["lock_id"],
                "lock_capability": lock["lock_capability"],
            },
        )
        assert release.status_code == 200
        assert session.exec(select(EditLock).where(EditLock.connection_id == test_connection.id)).first() is None

    def test_browser_edit_lock_heartbeat_reports_lost_lock_code(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        response = client.post(
            f"/api/browse/{test_connection.id}/lock/heartbeat",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
            json={"operation_id": "expired", "lock_id": str(uuid.uuid4()), "lock_capability": "expired"},
        )

        assert response.status_code == 404
        assert response.json()["detail"] == {
            "code": browser_api.EDIT_LOCK_LOST_CODE,
            "message": browser_api.EDIT_LOCK_LOST_MESSAGE,
        }

    def test_browser_edit_lock_control_reports_lost_lock_code_for_unknown_lock_id(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        lock = client.post(
            f"/api/browse/{test_connection.id}/lock",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
        ).json()

        response = client.post(
            f"/api/browse/{test_connection.id}/lock/heartbeat",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
            json={**lock, "lock_id": str(uuid.uuid4())},
        )

        assert response.status_code == 404
        assert response.json()["detail"]["code"] == browser_api.EDIT_LOCK_LOST_CODE

    def test_get_browser_edit_lock_status_omits_secret_material(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        session: Session,
    ):
        lock = EditLock(
            file_path="/docs/readme.md",
            connection_id=test_connection.id,
            locked_by="testuser",
            operation_id="browser-op",
            lock_capability="browser-capability",
            last_heartbeat=datetime.now(timezone.utc),
        )
        session.add(lock)
        session.commit()

        response = client.get(
            f"/api/browse/{test_connection.id}/lock-status",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
        )

        assert response.status_code == 200
        assert response.json() == {
            "locked": True,
            "locked_by": "testuser",
            "locked_at": lock.locked_at.isoformat(),
        }

    def test_get_file_info_timeout_returns_gateway_timeout(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Timed out SMB file-info requests should surface as 504 responses."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.get_file_info.side_effect = TimeoutError("SMB operation timed out during get_file_info")

        response = client.get(
            f"/api/browse/{test_connection.id}/info",
            headers=auth_headers_user,
            params={"path": "/slow.txt"},
        )

        assert response.status_code == 504
        assert response.json()["detail"] == "File info request timed out. The remote share did not respond in time."
        mock_instance.disconnect.assert_called_once()


@pytest.mark.unit
class TestFileInfoModel:
    """Test FileInfo model validation."""

    def test_file_info_creation(self):
        """Test creating a FileInfo instance."""
        entry = FileInfo(
            name="test.txt",
            path="/test.txt",
            type=FileType.FILE,
            size=100,
            modified_at=datetime.now(),
            mime_type="text/plain",
        )

        assert entry.name == "test.txt"
        assert entry.type == FileType.FILE
        assert entry.size == 100

    def test_directory_info_creation(self):
        """Test creating a directory FileInfo."""
        entry = FileInfo(
            name="folder",
            path="/folder",
            type=FileType.DIRECTORY,
            size=None,
            modified_at=datetime.now(),
            mime_type=None,
        )

        assert entry.name == "folder"
        assert entry.type == FileType.DIRECTORY
        assert entry.size is None
        assert entry.mime_type is None

    def test_file_info_serialization(self):
        """Test that FileInfo can be serialized to dict."""
        entry = FileInfo(
            name="test.txt",
            path="/test.txt",
            type=FileType.FILE,
            size=100,
            modified_at=datetime(2024, 1, 1, 12, 0, 0),
            mime_type="text/plain",
        )

        data = entry.model_dump()
        assert data["name"] == "test.txt"
        assert data["type"] == "file"
        assert data["size"] == 100


@pytest.mark.integration
class TestDeleteItem:
    """Test delete item endpoint."""

    def test_delete_file_success(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test deleting a file returns 204."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.delete_item.return_value = None

        response = client.delete(
            f"/api/browse/{test_connection.id}/item",
            headers=auth_headers_user,
            params={"path": "/document.txt"},
        )

        assert response.status_code == 204
        mock_instance.connect.assert_called_once()
        mock_instance.delete_item.assert_called_once_with("/document.txt")
        mock_instance.disconnect.assert_called_once()

    def test_delete_empty_directory_success(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test deleting an empty directory returns 204."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.delete_item.return_value = None

        response = client.delete(
            f"/api/browse/{test_connection.id}/item",
            headers=auth_headers_admin,
            params={"path": "/empty-folder"},
        )

        assert response.status_code == 204
        mock_instance.delete_item.assert_called_once_with("/empty-folder")

    def test_delete_without_auth(self, client: TestClient, test_connection: Connection):
        """Test that deletion requires authentication."""
        response = client.delete(
            f"/api/browse/{test_connection.id}/item",
            params={"path": "/document.txt"},
        )
        assert response.status_code == 401

    def test_delete_nonexistent_connection(self, client: TestClient, auth_headers_user: dict):
        """Test deletion for a non-existent connection returns 404."""
        import uuid

        fake_id = uuid.uuid4()
        response = client.delete(
            f"/api/browse/{fake_id}/item",
            headers=auth_headers_user,
            params={"path": "/document.txt"},
        )
        assert response.status_code == 404

    def test_delete_share_root_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that deleting the share root is rejected with 400."""
        response = client.delete(
            f"/api/browse/{test_connection.id}/item",
            headers=auth_headers_user,
            params={"path": "/"},
        )
        assert response.status_code == 400
        assert "share root" in response.json()["detail"].lower()

    def test_delete_empty_path_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that an empty path is rejected with 422 (missing required param)."""
        response = client.delete(
            f"/api/browse/{test_connection.id}/item",
            headers=auth_headers_user,
        )
        # path is a required query param – FastAPI returns 422 when omitted
        assert response.status_code == 422

    def test_delete_not_found(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test deleting a non-existent item returns 404."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.delete_item.side_effect = FileNotFoundError("Path not found")

        response = client.delete(
            f"/api/browse/{test_connection.id}/item",
            headers=auth_headers_user,
            params={"path": "/ghost.txt"},
        )
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_delete_directory_recursive_success(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test deleting a non-empty directory succeeds (recursive)."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.delete_item.return_value = None

        response = client.delete(
            f"/api/browse/{test_connection.id}/item",
            headers=auth_headers_user,
            params={"path": "/non-empty-folder"},
        )
        assert response.status_code == 204
        mock_instance.delete_item.assert_called_once_with("/non-empty-folder")

    def test_delete_server_error(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test generic SMB error returns 500."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.delete_item.side_effect = Exception("Connection lost")

        response = client.delete(
            f"/api/browse/{test_connection.id}/item",
            headers=auth_headers_user,
            params={"path": "/document.txt"},
        )
        assert response.status_code == 500

    def test_delete_timeout_returns_gateway_timeout(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Timed out SMB deletes should surface as 504 responses."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.delete_item.side_effect = TimeoutError("SMB operation timed out while deleting: /document.txt")

        response = client.delete(
            f"/api/browse/{test_connection.id}/item",
            headers=auth_headers_user,
            params={"path": "/document.txt"},
        )

        assert response.status_code == 504
        assert response.json()["detail"] == "Delete timed out. The remote share did not respond in time."
        mock_instance.disconnect.assert_called_once()

    def test_delete_read_only_connection_blocked(
        self,
        client: TestClient,
        auth_headers_user: dict,
        read_only_connection: Connection,
    ):
        """Delete should be rejected before any SMB operation on read-only connections."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            response = client.delete(
                f"/api/browse/{read_only_connection.id}/item",
                headers=auth_headers_user,
                params={"path": "/document.txt"},
            )

        assert response.status_code == 403
        assert response.json()["detail"] == "Connection is read-only"
        MockBackend.assert_not_called()


# ──────────────────────────────────────────────────────────────────────────────
# Rename file or directory
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestRenameItem:
    """Test rename item endpoint."""

    def test_rename_file_success(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test renaming a file returns 200 with updated FileInfo."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.rename_item.return_value = None
        mock_instance.get_file_info.return_value = FileInfo(
            name="renamed.txt",
            path="/renamed.txt",
            type=FileType.FILE,
            size=1024,
        )

        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": "/document.txt", "new_name": "renamed.txt"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "renamed.txt"
        mock_instance.connect.assert_called_once()
        mock_instance.rename_item.assert_called_once_with("/document.txt", "renamed.txt")
        mock_instance.disconnect.assert_called_once()

    def test_rename_canonicalizes_target_name_without_changing_source_path(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Rename targets use NFC while existing source paths stay addressable."""
        mock_class, mock_instance = mock_smb_backend
        nfd_source_path = "/Auftragsbesta\u0308tigung.pdf"
        nfc_name = "Auftragsbestätigung.pdf"
        mock_instance.rename_item.return_value = None
        mock_instance.get_file_info.return_value = FileInfo(name=nfc_name, path=f"/{nfc_name}", type=FileType.FILE)

        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": nfd_source_path, "new_name": "Auftragsbesta\u0308tigung.pdf"},
        )

        assert response.status_code == 200
        mock_instance.rename_item.assert_called_once_with(nfd_source_path, nfc_name)
        mock_instance.get_file_info.assert_called_once_with(nfc_name)

    def test_rename_nfd_source_to_existing_nfc_target_returns_conflict(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """An NFC destination collision must not modify an existing NFD source."""
        mock_class, mock_instance = mock_smb_backend
        nfd_source_path = "/Auftragsbesta\u0308tigung.pdf"
        nfc_name = "Auftragsbestätigung.pdf"
        mock_instance.rename_item.side_effect = FileExistsError(f"An item named '{nfc_name}' already exists")

        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": nfd_source_path, "new_name": "Auftragsbesta\u0308tigung.pdf"},
        )

        assert response.status_code == 409
        assert "already exists" in response.json()["detail"]
        mock_instance.rename_item.assert_called_once_with(nfd_source_path, nfc_name)

    def test_rename_directory_success(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test renaming a directory returns 200 with updated FileInfo."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.rename_item.return_value = None
        mock_instance.get_file_info.return_value = FileInfo(
            name="new-folder",
            path="/new-folder",
            type=FileType.DIRECTORY,
        )

        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_admin,
            json={"path": "/folder", "new_name": "new-folder"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "new-folder"
        assert data["type"] == "directory"

    def test_rename_without_auth(self, client: TestClient, test_connection: Connection):
        """Test that renaming requires authentication."""
        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            json={"path": "/document.txt", "new_name": "renamed.txt"},
        )
        assert response.status_code == 401

    def test_rename_nonexistent_connection(self, client: TestClient, auth_headers_user: dict):
        """Test renaming for a non-existent connection returns 404."""
        fake_id = uuid.uuid4()
        response = client.post(
            f"/api/browse/{fake_id}/rename",
            headers=auth_headers_user,
            json={"path": "/document.txt", "new_name": "renamed.txt"},
        )
        assert response.status_code == 404

    def test_rename_share_root_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that renaming the share root is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": "/", "new_name": "something"},
        )
        assert response.status_code == 400
        assert "share root" in response.json()["detail"].lower()

    def test_rename_empty_new_name_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that an empty new name is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": "/document.txt", "new_name": ""},
        )
        assert response.status_code == 400
        assert "empty" in response.json()["detail"].lower()

    def test_rename_invalid_chars_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that invalid characters in new name are rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": "/document.txt", "new_name": "file/name.txt"},
        )
        assert response.status_code == 400
        assert "invalid characters" in response.json()["detail"].lower()

    def test_rename_dot_name_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that '.' and '..' are rejected as new names."""
        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": "/document.txt", "new_name": ".."},
        )
        assert response.status_code == 400

    def test_rename_not_found(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test renaming a non-existent item returns 404."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.rename_item.side_effect = FileNotFoundError("Path not found")

        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": "/ghost.txt", "new_name": "renamed.txt"},
        )
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_rename_name_collision(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test renaming to an existing name returns 409."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.rename_item.side_effect = FileExistsError("An item named 'existing.txt' already exists")

        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": "/document.txt", "new_name": "existing.txt"},
        )
        assert response.status_code == 409
        assert "already exists" in response.json()["detail"].lower()

    def test_rename_server_error(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test generic SMB error returns 500."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.rename_item.side_effect = Exception("Connection lost")

        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": "/document.txt", "new_name": "renamed.txt"},
        )
        assert response.status_code == 500

    def test_rename_timeout_returns_gateway_timeout(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Timed out SMB renames should surface as 504 responses."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.rename_item.side_effect = TimeoutError("SMB operation timed out while renaming: /document.txt")

        response = client.post(
            f"/api/browse/{test_connection.id}/rename",
            headers=auth_headers_user,
            json={"path": "/document.txt", "new_name": "renamed.txt"},
        )

        assert response.status_code == 504
        assert response.json()["detail"] == "Rename timed out. The remote share did not respond in time."
        mock_instance.disconnect.assert_called_once()

    def test_rename_read_only_connection_blocked(
        self,
        client: TestClient,
        auth_headers_user: dict,
        read_only_connection: Connection,
    ):
        """Rename should be rejected before any SMB operation on read-only connections."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            response = client.post(
                f"/api/browse/{read_only_connection.id}/rename",
                headers=auth_headers_user,
                json={"path": "/document.txt", "new_name": "renamed.txt"},
            )

        assert response.status_code == 403
        assert response.json()["detail"] == "Connection is read-only"
        MockBackend.assert_not_called()


# ──────────────────────────────────────────────────────────────────────────────
# Create file or directory
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestCreateItem:
    """Test create item endpoint."""

    def test_create_directory_success(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test creating a directory returns 200 with FileInfo."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.create_directory.return_value = None
        mock_instance.get_file_info.return_value = FileInfo(
            name="new-folder",
            path="/new-folder",
            type=FileType.DIRECTORY,
        )

        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "new-folder", "type": "directory"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "new-folder"
        assert data["type"] == "directory"
        mock_instance.connect.assert_called_once()
        mock_instance.create_directory.assert_called_once_with("new-folder")
        mock_instance.disconnect.assert_called_once()

    def test_create_file_success(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test creating a file returns 200 with FileInfo."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.create_file.return_value = None
        mock_instance.get_file_info.return_value = FileInfo(
            name="notes.txt",
            path="/notes.txt",
            type=FileType.FILE,
            size=0,
        )

        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "notes.txt", "type": "file"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "notes.txt"
        assert data["type"] == "file"
        assert data["size"] == 0
        mock_instance.create_file.assert_called_once_with("notes.txt")

    def test_create_canonicalizes_decomposed_name(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """New items are created with NFC filenames."""
        mock_class, mock_instance = mock_smb_backend
        nfc_name = "Auftragsbestätigung"
        mock_instance.create_directory.return_value = None
        mock_instance.get_file_info.return_value = FileInfo(name=nfc_name, path=f"/{nfc_name}", type=FileType.DIRECTORY)

        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "Auftragsbesta\u0308tigung", "type": "directory"},
        )

        assert response.status_code == 200
        mock_instance.create_directory.assert_called_once_with(nfc_name)

    def test_create_in_subdirectory(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test creating inside a subdirectory builds the correct path."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.create_directory.return_value = None
        mock_instance.get_file_info.return_value = FileInfo(
            name="sub",
            path="/docs/sub",
            type=FileType.DIRECTORY,
        )

        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/docs", "name": "sub", "type": "directory"},
        )

        assert response.status_code == 200
        mock_instance.create_directory.assert_called_once_with("docs/sub")

    def test_create_without_auth(self, client: TestClient, test_connection: Connection):
        """Test that create requires authentication."""
        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            json={"parent_path": "/", "name": "folder", "type": "directory"},
        )
        assert response.status_code == 401

    def test_create_nonexistent_connection(self, client: TestClient, auth_headers_user: dict):
        """Test create for a non-existent connection returns 404."""
        fake_id = uuid.uuid4()
        response = client.post(
            f"/api/browse/{fake_id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "folder", "type": "directory"},
        )
        assert response.status_code == 404

    def test_create_empty_name_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that an empty name is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "", "type": "directory"},
        )
        assert response.status_code == 400
        assert "empty" in response.json()["detail"].lower()

    def test_create_invalid_chars_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that invalid characters in name are rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "bad:name", "type": "directory"},
        )
        assert response.status_code == 400
        assert "invalid characters" in response.json()["detail"].lower()

    def test_create_dot_name_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that '.' and '..' are rejected as names."""
        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "..", "type": "file"},
        )
        assert response.status_code == 400

    def test_create_trailing_period_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that trailing period in name is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "folder.", "type": "directory"},
        )
        assert response.status_code == 400
        assert "period" in response.json()["detail"].lower()

    def test_create_name_collision(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test creating an item that already exists returns 409."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.create_directory.side_effect = FileExistsError("An item named 'folder' already exists")

        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "folder", "type": "directory"},
        )
        assert response.status_code == 409
        assert "already exists" in response.json()["detail"].lower()

    def test_create_parent_not_found(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test creating in a non-existent parent returns 404."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.create_file.side_effect = FileNotFoundError("Parent directory not found")

        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/nonexistent", "name": "file.txt", "type": "file"},
        )
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_create_server_error(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test generic SMB error returns 500."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.create_directory.side_effect = Exception("Connection lost")

        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "folder", "type": "directory"},
        )
        assert response.status_code == 500

    def test_create_timeout_returns_gateway_timeout(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Timed out SMB creates should surface as 504 responses."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.create_directory.side_effect = TimeoutError("SMB operation timed out while creating directory: folder")

        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "folder", "type": "directory"},
        )

        assert response.status_code == 504
        assert response.json()["detail"] == "Create timed out. The remote share did not respond in time."
        mock_instance.disconnect.assert_called_once()

    def test_create_preserves_leading_whitespace_in_name(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that leading whitespace reaches the SMB backend unchanged."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.create_directory.return_value = None
        mock_instance.get_file_info.return_value = FileInfo(
            name="clean-name",
            path="/clean-name",
            type=FileType.DIRECTORY,
        )

        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "  clean-name", "type": "directory"},
        )

        assert response.status_code == 200
        mock_instance.create_directory.assert_called_once_with("  clean-name")
        mock_instance.get_file_info.assert_called_once_with("  clean-name")

    def test_create_trailing_whitespace_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that terminal whitespace is rejected before SMB operations."""
        mock_class, mock_instance = mock_smb_backend

        response = client.post(
            f"/api/browse/{test_connection.id}/create",
            headers=auth_headers_user,
            json={"parent_path": "/", "name": "clean-name ", "type": "directory"},
        )

        assert response.status_code == 400
        assert "space or period" in response.json()["detail"].lower()
        mock_instance.create_directory.assert_not_called()

    def test_create_read_only_connection_blocked(
        self,
        client: TestClient,
        auth_headers_user: dict,
        read_only_connection: Connection,
    ):
        """Create should be rejected before any SMB operation on read-only connections."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            response = client.post(
                f"/api/browse/{read_only_connection.id}/create",
                headers=auth_headers_user,
                json={"parent_path": "/", "name": "new-folder", "type": "directory"},
            )

        assert response.status_code == 403
        assert response.json()["detail"] == "Connection is read-only"
        MockBackend.assert_not_called()


# ──────────────────────────────────────────────────────────────────────────────
# _validate_item_name unit tests
# ──────────────────────────────────────────────────────────────────────────────


class TestValidateItemName:
    """Unit tests for the _validate_item_name helper.

    These test the function directly without going through HTTP,
    verifying that it raises the correct HTTPException for each
    validation rule.
    """

    def test_valid_name_preserves_leading_whitespace(self):
        """Valid names retain leading whitespace."""
        from app.api.browser import _validate_item_name

        assert _validate_item_name("  hello.txt") == "  hello.txt"

    def test_simple_valid_name(self):
        """Simple valid name is returned as-is."""
        from app.api.browser import _validate_item_name

        assert _validate_item_name("readme.md") == "readme.md"

    def test_canonicalizes_decomposed_unicode_to_nfc(self):
        """New names must use NFC so composed characters are one code point where possible."""
        from app.api.browser import _validate_item_name

        assert _validate_item_name("Auftragsbesta\u0308tigung.pdf") == "Auftragsbestätigung.pdf"

    def test_copy_move_destination_uses_nfc_and_preserves_source_path(self):
        """Copy and move share one destination-only canonicalization boundary."""
        source_path = "source/Auftragsbesta\u0308tigung.pdf"
        source, destination = browser_api._validate_copy_move_paths(source_path, "target/Auftragsbesta\u0308tigung.pdf")

        assert source == source_path
        assert destination == "target/Auftragsbestätigung.pdf"

    def test_empty_name_raises(self):
        """An empty name raises 400."""
        from fastapi import HTTPException

        from app.api.browser import _validate_item_name

        with pytest.raises(HTTPException) as exc_info:
            _validate_item_name("")
        assert exc_info.value.status_code == 400
        assert "empty" in exc_info.value.detail.lower()

    def test_dot_name_raises(self):
        """'.' raises 400."""
        from fastapi import HTTPException

        from app.api.browser import _validate_item_name

        with pytest.raises(HTTPException) as exc_info:
            _validate_item_name(".")
        assert exc_info.value.status_code == 400

    def test_dotdot_name_raises(self):
        """'..' raises 400."""
        from fastapi import HTTPException

        from app.api.browser import _validate_item_name

        with pytest.raises(HTTPException) as exc_info:
            _validate_item_name("..")
        assert exc_info.value.status_code == 400

    @pytest.mark.parametrize("char", list('\\/:*?"<>|'))
    def test_invalid_char_raises(self, char):
        """Each NTFS-forbidden character triggers 400."""
        from fastapi import HTTPException

        from app.api.browser import _validate_item_name

        with pytest.raises(HTTPException) as exc_info:
            _validate_item_name(f"file{char}name")
        assert exc_info.value.status_code == 400
        assert "invalid characters" in exc_info.value.detail.lower()

    def test_whitespace_only_name_raises(self):
        """Names consisting only of terminal whitespace are rejected."""
        from fastapi import HTTPException

        from app.api.browser import _validate_item_name

        with pytest.raises(HTTPException) as exc_info:
            _validate_item_name("   ")
        assert exc_info.value.status_code == 400
        assert "space or period" in exc_info.value.detail.lower()

    def test_trailing_period_raises(self):
        """Name ending with a period raises 400."""
        from fastapi import HTTPException

        from app.api.browser import _validate_item_name

        with pytest.raises(HTTPException) as exc_info:
            _validate_item_name("myfile.")
        assert exc_info.value.status_code == 400
        assert "space or period" in exc_info.value.detail.lower()

    def test_trailing_whitespace_raises(self):
        """Name ending in whitespace raises 400."""
        from fastapi import HTTPException

        from app.api.browser import _validate_item_name

        with pytest.raises(HTTPException) as exc_info:
            _validate_item_name("myfile ")
        assert exc_info.value.status_code == 400
        assert "space or period" in exc_info.value.detail.lower()

    def test_dotfile_valid(self):
        """Dotfiles like .gitignore are valid."""
        from app.api.browser import _validate_item_name

        assert _validate_item_name(".gitignore") == ".gitignore"

    def test_name_with_spaces_in_middle_valid(self):
        """Names with spaces in the middle are valid."""
        from app.api.browser import _validate_item_name

        assert _validate_item_name("my document.txt") == "my document.txt"


# ──────────────────────────────────────────────────────────────────────────────
# Upload file
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestUploadFile:
    """Tests for POST /api/browse/{connection_id}/upload"""

    def test_editor_upload_accepts_matching_browser_lock(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        lock = client.post(
            f"/api/browse/{test_connection.id}/lock",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
        ).json()
        mock_info = FileInfo(name="readme.md", path="/docs/readme.md", type=FileType.FILE, size=8)

        with patch("app.api.browser.SMBBackend") as mock_backend:
            backend = AsyncMock()
            backend.write_file = AsyncMock(return_value=8)
            backend.get_file_info = AsyncMock(return_value=mock_info)
            mock_backend.return_value = backend
            response = client.post(
                f"/api/browse/{test_connection.id}/upload",
                headers=auth_headers_user,
                params={
                    "path": "/docs/readme.md",
                    "editor_operation_id": lock["operation_id"],
                    "editor_lock_id": lock["lock_id"],
                    "editor_lock_capability": lock["lock_capability"],
                },
                files={"file": ("readme.md", b"updated", "text/markdown")},
            )

        assert response.status_code == 200
        backend.write_file.assert_awaited_once()

    def test_editor_upload_recreates_missing_target_with_matching_browser_lock(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        path = "/docs/recreated.md"
        lock = client.post(
            f"/api/browse/{test_connection.id}/lock",
            headers=auth_headers_user,
            params={"path": path},
        ).json()
        mock_info = FileInfo(name="recreated.md", path=path, type=FileType.FILE, size=8)

        with patch("app.api.browser.SMBBackend") as mock_backend:
            backend = AsyncMock()
            backend.write_file = AsyncMock(return_value=8)
            backend.get_file_info = AsyncMock(return_value=mock_info)
            mock_backend.return_value = backend
            response = client.post(
                f"/api/browse/{test_connection.id}/upload",
                headers=auth_headers_user,
                params={
                    "path": path,
                    "editor_operation_id": lock["operation_id"],
                    "editor_lock_id": lock["lock_id"],
                    "editor_lock_capability": lock["lock_capability"],
                },
                files={"file": ("recreated.md", b"updated", "text/markdown")},
            )

        assert response.status_code == 200
        backend.write_file.assert_awaited_once()

    def test_editor_upload_rejects_mismatched_browser_lock(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        lock = client.post(
            f"/api/browse/{test_connection.id}/lock",
            headers=auth_headers_user,
            params={"path": "/docs/readme.md"},
        ).json()

        response = client.post(
            f"/api/browse/{test_connection.id}/upload",
            headers=auth_headers_user,
            params={
                "path": "/docs/readme.md",
                "editor_operation_id": lock["operation_id"],
                "editor_lock_id": lock["lock_id"],
                "editor_lock_capability": "wrong-capability",
            },
            files={"file": ("readme.md", b"updated", "text/markdown")},
        )

        assert response.status_code == 403

    def test_editor_upload_reports_lost_lock_code_when_lock_is_missing(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        response = client.post(
            f"/api/browse/{test_connection.id}/upload",
            headers=auth_headers_user,
            params={
                "path": "/docs/readme.md",
                "editor_operation_id": "expired",
                "editor_lock_id": str(uuid.uuid4()),
                "editor_lock_capability": "expired",
            },
            files={"file": ("readme.md", b"updated", "text/markdown")},
        )

        assert response.status_code == 404
        assert response.json()["detail"] == {
            "code": browser_api.EDIT_LOCK_LOST_CODE,
            "message": browser_api.EDIT_LOCK_LOST_MESSAGE,
        }

    def test_upload_rejects_operation_token_without_operation_context(
        self,
        client: TestClient,
        admin_user,
        test_connection: Connection,
    ):
        """Operation tokens must not authenticate generic browser upload requests."""
        operation_token = create_access_token(
            data={
                "sub": admin_user.username,
                "tv": admin_user.token_version,
                COMPANION_TOKEN_CLAIM: True,
                "token_class": COMPANION_TOKEN_CLASS,
                "purpose": COMPANION_OPERATION_PURPOSE,
                "conn_id": str(test_connection.id),
                "path": "/document.txt",
                "op_id": "operation-123",
                "lock_id": str(uuid.uuid4()),
            }
        )

        response = client.post(
            f"/api/browse/{test_connection.id}/upload",
            headers={"Authorization": f"Bearer {operation_token}"},
            params={"path": "/document.txt"},
            files={"file": ("document.txt", b"updated content", "application/octet-stream")},
        )

        assert response.status_code == 401

    #
    # test_upload_success
    #
    def test_upload_success(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        test_connection: Connection,
    ):
        """Upload writes file to SMB share and returns metadata."""

        mock_info = FileInfo(
            name="report.docx",
            path="/docs/report.docx",
            type=FileType.FILE,
            size=100,
            modified_at=datetime(2026, 2, 9, 14, 0, 0),
        )

        with patch("app.api.browser.SMBBackend") as MockBackend:
            instance = AsyncMock()
            instance.write_file = AsyncMock(return_value=100)
            instance.get_file_info = AsyncMock(return_value=mock_info)
            MockBackend.return_value = instance

            response = client.post(
                f"/api/browse/{test_connection.id}/upload",
                params={"path": "/docs/report.docx"},
                files={"file": ("report.docx", b"file content here", "application/octet-stream")},
                headers=auth_headers_admin,
            )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["path"] == "/docs/report.docx"
        assert data["size"] == 100

    #
    # test_upload_file_locked
    #
    def test_upload_file_locked(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        test_connection: Connection,
    ):
        """Upload returns 409 when the target file is locked on the SMB share."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            instance = AsyncMock()
            instance.write_file = AsyncMock(side_effect=IOError("File is locked and cannot be written"))
            MockBackend.return_value = instance

            response = client.post(
                f"/api/browse/{test_connection.id}/upload",
                params={"path": "/docs/report.docx"},
                files={"file": ("report.docx", b"content", "application/octet-stream")},
                headers=auth_headers_admin,
            )

        assert response.status_code == 409

    #
    # test_upload_connection_not_found
    #
    def test_upload_connection_not_found(
        self,
        client: TestClient,
        auth_headers_admin: dict,
    ):
        """Upload returns 404 for nonexistent connection."""

        response = client.post(
            f"/api/browse/{uuid.uuid4()}/upload",
            params={"path": "/docs/report.docx"},
            files={"file": ("report.docx", b"content", "application/octet-stream")},
            headers=auth_headers_admin,
        )
        assert response.status_code == 404

    #
    # test_upload_requires_auth
    #
    def test_upload_requires_auth(
        self,
        client: TestClient,
        test_connection: Connection,
    ):
        """Upload endpoint requires authentication."""

        response = client.post(
            f"/api/browse/{test_connection.id}/upload",
            params={"path": "/docs/report.docx"},
            files={"file": ("report.docx", b"content", "application/octet-stream")},
        )
        assert response.status_code == 401

    #
    # test_upload_server_error
    #
    def test_upload_server_error(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        test_connection: Connection,
    ):
        """Upload returns 500 on unexpected SMB errors."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            instance = AsyncMock()
            instance.write_file = AsyncMock(side_effect=Exception("Connection lost"))
            MockBackend.return_value = instance

            response = client.post(
                f"/api/browse/{test_connection.id}/upload",
                params={"path": "/docs/report.docx"},
                files={"file": ("report.docx", b"content", "application/octet-stream")},
                headers=auth_headers_admin,
            )

        assert response.status_code == 500

    def test_upload_timeout_returns_gateway_timeout(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        test_connection: Connection,
    ):
        """Timed out SMB uploads should surface as 504 responses."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            instance = AsyncMock()
            instance.write_file = AsyncMock(side_effect=TimeoutError("SMB operation timed out while writing: /docs/report.docx"))
            MockBackend.return_value = instance

            response = client.post(
                f"/api/browse/{test_connection.id}/upload",
                params={"path": "/docs/report.docx"},
                files={"file": ("report.docx", b"content", "application/octet-stream")},
                headers=auth_headers_admin,
            )

        assert response.status_code == 504
        assert response.json()["detail"] == "Upload timed out. The remote share did not respond in time."
        instance.disconnect.assert_called_once()

    def test_upload_read_only_connection_blocked(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        read_only_connection: Connection,
    ):
        """Upload should be rejected before any SMB operation on read-only connections."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            response = client.post(
                f"/api/browse/{read_only_connection.id}/upload",
                params={"path": "/docs/report.docx"},
                files={"file": ("report.docx", b"content", "application/octet-stream")},
                headers=auth_headers_admin,
            )

        assert response.status_code == 403
        assert response.json()["detail"] == "Connection is read-only"
        MockBackend.assert_not_called()


# ──────────────────────────────────────────────────────────────────────────────
# Copy file or directory
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestCopyItem:
    """Test copy item endpoint."""

    def test_copy_file_success(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test copying a file returns 204."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.get_file_info.side_effect = [
            FileInfo(name="file.txt", path="docs/file.txt", type=FileType.FILE, size=1, stable_id="source-file"),
            FileNotFoundError("target does not exist"),
            FileInfo(name="file.txt", path="docs/file.txt", type=FileType.FILE, size=1, stable_id="source-file"),
            FileInfo(name="file.txt", path="docs/file.txt", type=FileType.FILE, size=1, stable_id="source-file"),
            FileNotFoundError("target does not exist"),
            FileInfo(name="file.txt", path="docs/file.txt", type=FileType.FILE, size=1, stable_id="source-file"),
        ]

        async def read_file(_path: str):
            yield b"x"

        async def stage_and_commit(_path: str, stream, *, before_commit, **_kwargs: object) -> int:
            _ = b"".join([chunk async for chunk in stream])
            await before_commit()
            return 1

        mock_instance.read_file = read_file
        mock_instance.stage_and_commit_new_file_from_stream = AsyncMock(side_effect=stage_and_commit)

        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "docs/file.txt", "dest_path": "backup/file.txt"},
        )

        assert response.status_code == 200
        assert response.json()["status"] == "completed"
        mock_instance.connect.assert_called_once()
        mock_instance.stage_and_commit_new_file_from_stream.assert_called_once()
        mock_instance.copy_item.assert_not_called()
        mock_instance.disconnect.assert_called_once()

    def test_copy_directory_is_rejected(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Directory trees are coordinated by the frontend, not this file route."""
        _mock_class, mock_instance = mock_smb_backend
        mock_instance.get_file_info.return_value = FileInfo(name="photos", path="photos", type=FileType.DIRECTORY)

        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_admin,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "photos", "dest_path": "photos-backup"},
        )

        assert response.status_code == 422
        assert "Directory transfers" in response.json()["detail"]
        mock_instance.copy_item.assert_not_called()

    def test_copy_replays_a_factual_result_for_the_same_idempotency_key(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """A lost response must not cause a copy request to run twice."""
        _mock_class, mock_instance = mock_smb_backend
        request = {
            "source_path": "docs/file.txt",
            "dest_path": "backup/file.txt",
            "idempotency_key": str(uuid.uuid4()),
        }
        source_info = FileInfo(name="file.txt", path="docs/file.txt", type=FileType.FILE, size=1, stable_id="source-file")
        mock_instance.get_file_info.side_effect = [
            source_info,
            FileNotFoundError("target does not exist"),
            source_info,
            source_info,
            FileNotFoundError("target does not exist"),
            source_info,
        ]

        async def read_file(_path: str):
            yield b"x"

        async def stage_and_commit(_path: str, stream, *, before_commit, **_kwargs: object) -> int:
            _ = b"".join([chunk async for chunk in stream])
            await before_commit()
            return 1

        mock_instance.read_file = read_file
        mock_instance.stage_and_commit_new_file_from_stream = AsyncMock(side_effect=stage_and_commit)

        first = client.post(f"/api/browse/{test_connection.id}/copy", headers=auth_headers_user, json=request)
        replay = client.post(f"/api/browse/{test_connection.id}/copy", headers=auth_headers_user, json=request)

        assert first.status_code == 200
        assert replay.status_code == 200
        assert replay.json() == first.json()
        mock_instance.stage_and_commit_new_file_from_stream.assert_awaited_once()
        mock_instance.copy_item.assert_not_called()

    def test_copy_file_reports_source_change_without_committing_destination(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """A changed source aborts the staged same-share copy before publication."""
        _mock_class, mock_instance = mock_smb_backend
        source_info = FileInfo(name="file.txt", path="docs/file.txt", type=FileType.FILE, size=1, stable_id="source-file")
        changed_source = FileInfo(name="file.txt", path="docs/file.txt", type=FileType.FILE, size=2, stable_id="replaced-file")
        mock_instance.get_file_info.side_effect = [
            source_info,
            FileNotFoundError("target does not exist"),
            source_info,
            changed_source,
        ]
        destination_committed = False

        async def read_file(_path: str):
            yield b"x"

        async def stage_and_commit(_path: str, stream, *, before_commit, **_kwargs: object) -> int:
            nonlocal destination_committed
            _ = b"".join([chunk async for chunk in stream])
            await before_commit()
            destination_committed = True
            return 1

        mock_instance.read_file = read_file
        mock_instance.stage_and_commit_new_file_from_stream = AsyncMock(side_effect=stage_and_commit)

        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "docs/file.txt", "dest_path": "backup/file.txt"},
        )

        assert response.status_code == 200
        result = response.json()
        assert result["status"] == "failed"
        assert result["effects"] == {"source": "unchanged", "destination": "unchanged"}
        assert result["error"] == {"code": "source_changed", "detail": "Source changed before commit: docs/file.txt"}
        assert result["replaced"] is False
        assert destination_committed is False

    def test_copy_replays_source_not_found_for_the_same_idempotency_key(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """A repeated key must preserve the original source-not-found response."""
        _mock_class, mock_instance = mock_smb_backend
        request = {
            "source_path": "missing.txt",
            "dest_path": "backup/missing.txt",
            "idempotency_key": str(uuid.uuid4()),
        }
        mock_instance.get_file_info.side_effect = FileNotFoundError("source does not exist")

        first = client.post(f"/api/browse/{test_connection.id}/copy", headers=auth_headers_user, json=request)
        replay = client.post(f"/api/browse/{test_connection.id}/copy", headers=auth_headers_user, json=request)

        assert first.status_code == 404
        assert replay.status_code == 404
        assert replay.json() == first.json()
        mock_instance.get_file_info.assert_awaited_once_with("missing.txt")

    def test_copy_replays_timeout_for_the_same_idempotency_key(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """A repeated key must preserve the original timeout rather than become unknown."""
        _mock_class, mock_instance = mock_smb_backend
        request = {
            "source_path": "a.txt",
            "dest_path": "b.txt",
            "idempotency_key": str(uuid.uuid4()),
        }
        source_info = FileInfo(name="a.txt", path="a.txt", type=FileType.FILE, size=1, stable_id="source-file")
        mock_instance.get_file_info.side_effect = [
            source_info,
            FileNotFoundError("target does not exist"),
            source_info,
        ]
        mock_instance.stage_and_commit_new_file_from_stream.side_effect = TimeoutError("SMB timed out")

        async def read_file(_path: str):
            yield b"x"

        mock_instance.read_file = read_file

        first = client.post(f"/api/browse/{test_connection.id}/copy", headers=auth_headers_user, json=request)
        replay = client.post(f"/api/browse/{test_connection.id}/copy", headers=auth_headers_user, json=request)

        assert first.status_code == 504
        assert replay.status_code == 504
        assert replay.json() == first.json()
        mock_instance.stage_and_commit_new_file_from_stream.assert_awaited_once()

    def test_copy_without_auth(self, client: TestClient, test_connection: Connection):
        """Test that copying requires authentication."""
        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )
        assert response.status_code == 401

    def test_copy_nonexistent_connection(self, client: TestClient, auth_headers_user: dict):
        """Test copying for a non-existent connection returns 404."""
        fake_id = uuid.uuid4()
        response = client.post(
            f"/api/browse/{fake_id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )
        assert response.status_code == 404

    def test_copy_empty_source_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that an empty source path is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "", "dest_path": "backup/file.txt"},
        )
        assert response.status_code == 400
        assert "source" in response.json()["detail"].lower()

    def test_copy_empty_dest_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that an empty dest path is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "docs/file.txt", "dest_path": ""},
        )
        assert response.status_code == 400
        assert "destination" in response.json()["detail"].lower()

    def test_copy_same_path_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that copying to the same path is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "docs/file.txt", "dest_path": "docs/file.txt"},
        )
        assert response.status_code == 400
        assert "different" in response.json()["detail"].lower()

    def test_copy_into_self_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that copying a directory into itself is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "photos", "dest_path": "photos/photos-copy"},
        )
        assert response.status_code == 400
        assert "into itself" in response.json()["detail"].lower()

    def test_copy_source_not_found(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test copying a non-existent source returns 404."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.copy_item.side_effect = FileNotFoundError("Source not found")
        mock_instance.get_file_info.side_effect = FileNotFoundError("Source not found")

        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "ghost.txt", "dest_path": "backup/ghost.txt"},
        )
        assert response.status_code == 404

    def test_copy_dest_exists(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test copying to an existing destination returns 409."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.copy_item.side_effect = FileExistsError("Destination exists")

        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )
        assert response.status_code == 409

    def test_copy_ask_existing_target_does_not_call_native_mutation(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """The default ask policy reports an existing target before mutation."""
        _mock_class, mock_instance = mock_smb_backend
        mock_instance.get_file_info.side_effect = [
            FileInfo(name="a.txt", path="a.txt", type=FileType.FILE, size=1),
            FileInfo(name="b.txt", path="b.txt", type=FileType.FILE, size=2),
        ]

        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )

        assert response.status_code == 409
        mock_instance.copy_item.assert_not_called()

    def test_copy_conflict_replays_as_409_for_the_same_idempotency_key(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """A lost conflict response must not become an unknown successful response."""
        _mock_class, mock_instance = mock_smb_backend
        mock_instance.get_file_info.side_effect = [
            FileInfo(name="a.txt", path="a.txt", type=FileType.FILE, size=1),
            FileInfo(name="b.txt", path="b.txt", type=FileType.FILE, size=2),
        ]
        request = {
            "source_path": "a.txt",
            "dest_path": "b.txt",
            "idempotency_key": str(uuid.uuid4()),
        }

        first = client.post(f"/api/browse/{test_connection.id}/copy", headers=auth_headers_user, json=request)
        observations_after_first = mock_instance.get_file_info.call_count
        replay = client.post(f"/api/browse/{test_connection.id}/copy", headers=auth_headers_user, json=request)

        assert first.status_code == 409
        assert replay.status_code == 409
        assert replay.json() == first.json()
        assert mock_instance.get_file_info.call_count == observations_after_first
        mock_instance.copy_item.assert_not_called()

    def test_copy_skip_directory_is_rejected_without_native_mutation(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Directory roots are rejected before the obsolete recursive copy path."""
        _mock_class, mock_instance = mock_smb_backend
        mock_instance.get_file_info.side_effect = [
            FileInfo(name="source", path="source", type=FileType.DIRECTORY),
            FileInfo(name="target", path="target", type=FileType.DIRECTORY),
        ]

        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={
                "idempotency_key": str(uuid.uuid4()),
                "source_path": "source",
                "dest_path": "target",
                "target_resolution_policy": "skip",
            },
        )

        assert response.status_code == 422
        assert "Directory transfers" in response.json()["detail"]
        mock_instance.copy_item.assert_not_called()

    def test_copy_server_error(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test generic SMB error returns 500."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.stage_and_commit_new_file_from_stream.side_effect = Exception("Connection lost")

        async def source_chunks(_path):
            yield b"a"

        mock_instance.read_file = source_chunks
        mock_instance.get_file_info.side_effect = [
            FileInfo(name="a.txt", path="a.txt", type=FileType.FILE, size=1, stable_id="source-file"),
            FileNotFoundError("target does not exist"),
            FileInfo(name="a.txt", path="a.txt", type=FileType.FILE, size=1, stable_id="source-file"),
        ]

        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )
        assert response.status_code == 500

    def test_copy_timeout_returns_gateway_timeout(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Timed out SMB copies should surface as 504 responses."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.stage_and_commit_new_file_from_stream.side_effect = TimeoutError("SMB operation timed out while copying: a.txt")
        mock_instance.get_file_info.side_effect = [
            FileInfo(name="a.txt", path="a.txt", type=FileType.FILE, size=1, stable_id="source-file"),
            FileNotFoundError("target does not exist"),
            FileInfo(name="a.txt", path="a.txt", type=FileType.FILE, size=1, stable_id="source-file"),
        ]

        async def read_file(_path: str):
            yield b"x"

        mock_instance.read_file = read_file

        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )

        assert response.status_code == 504
        assert response.json()["detail"] == "Copy timed out. The remote share did not respond in time."
        mock_instance.disconnect.assert_called_once()

    def test_copy_cross_connection_success(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        multiple_connections: list,
    ):
        """Test that cross-connection copy returns 204."""
        dest_conn = multiple_connections[0]
        attempt_id = str(uuid.uuid4())

        with patch("app.api.browser.SMBBackend") as MockBackend:
            src_instance = AsyncMock()
            dst_instance = AsyncMock()

            # Source returns a file
            src_instance.get_file_info.return_value = FileInfo(
                name="a.txt",
                path="a.txt",
                type=FileType.FILE,
                size=100,
                stable_id="source-a",
            )
            src_instance.get_file_size.return_value = 100

            async def fake_read_file(path):
                yield b"file content"

            src_instance.read_file = fake_read_file

            async def stage_with_progress(_path, _stream, **kwargs):
                kwargs["on_progress"](6, 100)
                return 12

            dst_instance.stage_and_commit_new_file_from_stream = AsyncMock(side_effect=stage_with_progress)
            dst_instance.get_file_info.side_effect = FileNotFoundError("target does not exist")

            # Return different instances for source and dest backends
            MockBackend.side_effect = [src_instance, dst_instance]

            with patch("app.api.websocket.manager.broadcast_transfer_progress", new_callable=AsyncMock) as progress:
                response = client.post(
                    f"/api/browse/{test_connection.id}/copy",
                    headers=auth_headers_user,
                    json={
                        "idempotency_key": str(uuid.uuid4()),
                        "source_path": "a.txt",
                        "dest_path": "b.txt",
                        "dest_connection_id": str(dest_conn.id),
                        "transfer_attempt_id": attempt_id,
                    },
                )

            assert response.status_code == 200
            assert response.json()["status"] == "completed"
            assert any(call.args[2:4] == (6, 100) for call in progress.await_args_list)
            assert progress.await_args_list[-1].args == (str(dest_conn.id), "", -1, -1, "b.txt", attempt_id)
            assert all(call.args[-1] == attempt_id for call in progress.await_args_list)

    def test_copy_cross_connection_dest_not_found(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        """Test that cross-connection copy with invalid dest connection returns 404."""
        fake_dest_id = str(uuid.uuid4())
        response = client.post(
            f"/api/browse/{test_connection.id}/copy",
            headers=auth_headers_user,
            json={
                "idempotency_key": str(uuid.uuid4()),
                "source_path": "a.txt",
                "dest_path": "b.txt",
                "dest_connection_id": fake_dest_id,
            },
        )
        assert response.status_code == 404

    def test_copy_same_connection_read_only_destination_blocked(
        self,
        client: TestClient,
        auth_headers_user: dict,
        read_only_connection: Connection,
    ):
        """Copying into a read-only connection should be rejected before SMB work starts."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            response = client.post(
                f"/api/browse/{read_only_connection.id}/copy",
                headers=auth_headers_user,
                json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
            )

        assert response.status_code == 403
        assert response.json()["detail"] == "Connection is read-only"
        MockBackend.assert_not_called()

    def test_copy_cross_connection_from_read_only_source_allowed(
        self,
        client: TestClient,
        auth_headers_user: dict,
        read_only_connection: Connection,
        test_connection: Connection,
    ):
        """Copying out of a read-only source into a writable destination remains allowed."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            src_instance = AsyncMock()
            dst_instance = AsyncMock()

            src_instance.get_file_info.return_value = FileInfo(
                name="a.txt",
                path="a.txt",
                type=FileType.FILE,
                size=100,
                stable_id="source-a",
            )

            async def fake_read_file(path):
                yield b"file content"

            src_instance.read_file = fake_read_file
            dst_instance.stage_and_commit_new_file_from_stream = AsyncMock(return_value=12)
            dst_instance.get_file_info.side_effect = FileNotFoundError("target does not exist")

            MockBackend.side_effect = [src_instance, dst_instance]

            with patch("app.api.websocket.manager.broadcast_transfer_progress", new_callable=AsyncMock):
                response = client.post(
                    f"/api/browse/{read_only_connection.id}/copy",
                    headers=auth_headers_user,
                    json={
                        "idempotency_key": str(uuid.uuid4()),
                        "source_path": "a.txt",
                        "dest_path": "b.txt",
                        "dest_connection_id": str(test_connection.id),
                    },
                )

        assert response.status_code == 200
        assert response.json()["status"] == "completed"

    def test_copy_cross_connection_to_read_only_destination_blocked(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        read_only_connection: Connection,
    ):
        """Copying into a read-only destination should be rejected before SMB work starts."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            response = client.post(
                f"/api/browse/{test_connection.id}/copy",
                headers=auth_headers_user,
                json={
                    "idempotency_key": str(uuid.uuid4()),
                    "source_path": "a.txt",
                    "dest_path": "b.txt",
                    "dest_connection_id": str(read_only_connection.id),
                },
            )

        assert response.status_code == 403
        assert response.json()["detail"] == "Connection is read-only"
        MockBackend.assert_not_called()


# ──────────────────────────────────────────────────────────────────────────────
# Move file or directory
# ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.integration
class TestMoveItem:
    """Test move item endpoint."""

    def test_move_file_success(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """A regular-file move uses the native same-connection rename."""
        mock_class, mock_instance = mock_smb_backend
        source_info = FileInfo(name="file.txt", path="docs/file.txt", type=FileType.FILE, size=1, stable_id="source-file")
        mock_instance.get_file_info.side_effect = [
            source_info,
            FileNotFoundError("target does not exist"),
            FileNotFoundError("target does not exist"),
        ]

        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "docs/file.txt", "dest_path": "archive/file.txt"},
        )

        assert response.status_code == 200
        assert response.json()["status"] == "completed"
        assert response.json()["effects"] == {"source": "mutated", "destination": "mutated"}
        mock_instance.connect.assert_called_once()
        mock_instance.move_item.assert_awaited_once_with("docs/file.txt", "archive/file.txt", overwrite=False)
        mock_instance.disconnect.assert_called_once()

    def test_move_directory_is_rejected(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Directory trees are coordinated by the frontend, not this file route."""
        _mock_class, mock_instance = mock_smb_backend
        mock_instance.get_file_info.return_value = FileInfo(name="old-folder", path="old-folder", type=FileType.DIRECTORY)

        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_admin,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "old-folder", "dest_path": "new-folder"},
        )

        assert response.status_code == 422
        assert "Directory transfers" in response.json()["detail"]
        mock_instance.move_item.assert_not_called()

    def test_move_without_auth(self, client: TestClient, test_connection: Connection):
        """Test that moving requires authentication."""
        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )
        assert response.status_code == 401

    def test_move_nonexistent_connection(self, client: TestClient, auth_headers_user: dict):
        """Test moving for a non-existent connection returns 404."""
        fake_id = uuid.uuid4()
        response = client.post(
            f"/api/browse/{fake_id}/move",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )
        assert response.status_code == 404

    def test_move_empty_source_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that an empty source path is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "", "dest_path": "archive/file.txt"},
        )
        assert response.status_code == 400

    def test_move_same_path_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that moving to the same path is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "docs/file.txt", "dest_path": "docs/file.txt"},
        )
        assert response.status_code == 400

    def test_move_into_self_rejected(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test that moving a directory into itself is rejected with 400."""
        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "photos", "dest_path": "photos/subfolder"},
        )
        assert response.status_code == 400
        assert "into itself" in response.json()["detail"].lower()

    def test_move_source_not_found(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test moving a non-existent source returns 404."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.move_item.side_effect = FileNotFoundError("Source not found")
        mock_instance.get_file_info.side_effect = FileNotFoundError("Source not found")

        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "ghost.txt", "dest_path": "archive/ghost.txt"},
        )
        assert response.status_code == 404

    def test_move_dest_exists(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test moving to an existing destination returns 409."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.move_item.side_effect = FileExistsError("Destination exists")

        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )
        assert response.status_code == 409

    def test_move_skip_existing_target_does_not_call_native_mutation(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Skip leaves both source and existing target unchanged for moves."""
        _mock_class, mock_instance = mock_smb_backend
        mock_instance.get_file_info.side_effect = [
            FileInfo(name="a.txt", path="a.txt", type=FileType.FILE, size=1),
            FileInfo(name="b.txt", path="b.txt", type=FileType.FILE, size=2),
        ]

        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={
                "idempotency_key": str(uuid.uuid4()),
                "source_path": "a.txt",
                "dest_path": "b.txt",
                "target_resolution_policy": "skip",
            },
        )

        assert response.status_code == 200
        assert response.json()["status"] == "skipped"
        mock_instance.move_item.assert_not_called()

    def test_move_server_error(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Test generic SMB error returns 500."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.move_item.side_effect = Exception("Connection lost")
        mock_instance.get_file_info.side_effect = [
            FileInfo(name="a.txt", path="a.txt", type=FileType.FILE, size=1, stable_id="source-file"),
            FileNotFoundError("target does not exist"),
            FileNotFoundError("target does not exist"),
        ]

        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )
        assert response.status_code == 500

    def test_move_timeout_returns_gateway_timeout(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_smb_backend,
    ):
        """Timed out SMB moves should surface as 504 responses."""
        mock_class, mock_instance = mock_smb_backend
        mock_instance.move_item.side_effect = TimeoutError("SMB operation timed out while moving: a.txt")
        mock_instance.get_file_info.side_effect = [
            FileInfo(name="a.txt", path="a.txt", type=FileType.FILE, size=1, stable_id="source-file"),
            FileNotFoundError("target does not exist"),
            FileNotFoundError("target does not exist"),
        ]

        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
        )

        assert response.status_code == 504
        assert response.json()["detail"] == "Move timed out. The remote share did not respond in time."
        mock_instance.disconnect.assert_called_once()

    def test_move_cross_connection_success(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        multiple_connections: list,
    ):
        """A cross-connection regular-file move deletes through its retained source handle."""
        dest_conn = multiple_connections[0]
        attempt_id = str(uuid.uuid4())

        with patch("app.api.browser.SMBBackend") as MockBackend:
            src_instance = AsyncMock()
            dst_instance = AsyncMock()

            src_instance.get_file_info.return_value = FileInfo(
                name="a.txt",
                path="a.txt",
                type=FileType.FILE,
                size=100,
                stable_id="source-a",
            )
            src_instance.get_file_size.return_value = 100
            move_reader = AsyncMock()
            move_reader.read_at.return_value = b"file content"
            move_reader.get_file_info.return_value = src_instance.get_file_info.return_value
            src_instance.open_move_source_reader.return_value = move_reader

            async def fake_read_file(path):
                yield b"file content"

            src_instance.read_file = fake_read_file

            async def stage_with_progress(_path, _stream, **kwargs):
                kwargs["on_progress"](6, 100)
                return 12

            dst_instance.stage_and_commit_new_file_from_stream = AsyncMock(side_effect=stage_with_progress)
            dst_instance.get_file_info.side_effect = FileNotFoundError("target does not exist")

            MockBackend.side_effect = [src_instance, dst_instance]

            with patch("app.api.websocket.manager.broadcast_transfer_progress", new_callable=AsyncMock) as progress:
                response = client.post(
                    f"/api/browse/{test_connection.id}/move",
                    headers=auth_headers_user,
                    json={
                        "idempotency_key": str(uuid.uuid4()),
                        "source_path": "a.txt",
                        "dest_path": "b.txt",
                        "dest_connection_id": str(dest_conn.id),
                        "transfer_attempt_id": attempt_id,
                    },
                )

            assert response.status_code == 200
            assert response.json()["status"] == "completed"
            assert any(call.args[2:4] == (6, 100) for call in progress.await_args_list)
            assert progress.await_args_list[-1].args == (str(dest_conn.id), "", -1, -1, "b.txt", attempt_id)
            assert all(call.args[-1] == attempt_id for call in progress.await_args_list)
            assert response.json()["effects"] == {"source": "mutated", "destination": "mutated"}
            move_reader.commit_delete.assert_awaited_once()
            src_instance.delete_item.assert_not_called()

    def test_move_reports_destination_committed_when_source_delete_fails(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        multiple_connections: list,
    ):
        """An unobservable retained-source deletion result reports an unknown outcome."""
        dest_conn = multiple_connections[0]
        with patch("app.api.browser.SMBBackend") as MockBackend:
            source_backend = AsyncMock()
            destination_backend = AsyncMock()
            source_backend.get_file_info.return_value = FileInfo(
                name="a.txt",
                path="a.txt",
                type=FileType.FILE,
                size=12,
                stable_id="source-a",
            )
            move_reader = AsyncMock()
            move_reader.read_at.return_value = b"file content"
            move_reader.get_file_info.return_value = source_backend.get_file_info.return_value
            move_reader.commit_delete.side_effect = OSError("source delete denied")
            source_backend.open_move_source_reader.return_value = move_reader

            async def fake_read_file(path):
                yield b"file content"

            source_backend.read_file = fake_read_file
            destination_backend.stage_and_commit_new_file_from_stream = AsyncMock(return_value=12)
            destination_backend.get_file_info.side_effect = FileNotFoundError("target does not exist")
            MockBackend.side_effect = [source_backend, destination_backend]

            response = client.post(
                f"/api/browse/{test_connection.id}/move",
                headers=auth_headers_user,
                json={
                    "idempotency_key": str(uuid.uuid4()),
                    "source_path": "a.txt",
                    "dest_path": "b.txt",
                    "dest_connection_id": str(dest_conn.id),
                },
            )

        assert response.status_code == 200
        assert response.json()["status"] == "outcome_unknown"
        assert response.json()["effects"] == {"source": "unknown", "destination": "mutated"}
        move_reader.commit_delete.assert_awaited_once()
        source_backend.delete_item.assert_not_called()

    def test_move_cross_connection_dest_not_found(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        """Test that cross-connection move with invalid dest connection returns 404."""
        fake_dest_id = str(uuid.uuid4())
        response = client.post(
            f"/api/browse/{test_connection.id}/move",
            headers=auth_headers_user,
            json={
                "idempotency_key": str(uuid.uuid4()),
                "source_path": "a.txt",
                "dest_path": "b.txt",
                "dest_connection_id": fake_dest_id,
            },
        )
        assert response.status_code == 404

    def test_move_same_connection_read_only_blocked(
        self,
        client: TestClient,
        auth_headers_user: dict,
        read_only_connection: Connection,
    ):
        """Moves on a read-only connection should be rejected before SMB work starts."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            response = client.post(
                f"/api/browse/{read_only_connection.id}/move",
                headers=auth_headers_user,
                json={"idempotency_key": str(uuid.uuid4()), "source_path": "a.txt", "dest_path": "b.txt"},
            )

        assert response.status_code == 403
        assert response.json()["detail"] == "Connection is read-only"
        MockBackend.assert_not_called()

    def test_move_cross_connection_from_read_only_source_blocked(
        self,
        client: TestClient,
        auth_headers_user: dict,
        read_only_connection: Connection,
        test_connection: Connection,
    ):
        """Moving out of a read-only source should be rejected."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            response = client.post(
                f"/api/browse/{read_only_connection.id}/move",
                headers=auth_headers_user,
                json={
                    "idempotency_key": str(uuid.uuid4()),
                    "source_path": "a.txt",
                    "dest_path": "b.txt",
                    "dest_connection_id": str(test_connection.id),
                },
            )

        assert response.status_code == 403
        assert response.json()["detail"] == "Connection is read-only"
        MockBackend.assert_not_called()

    def test_move_cross_connection_to_read_only_destination_blocked(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        read_only_connection: Connection,
    ):
        """Moving into a read-only destination should be rejected."""

        with patch("app.api.browser.SMBBackend") as MockBackend:
            response = client.post(
                f"/api/browse/{test_connection.id}/move",
                headers=auth_headers_user,
                json={
                    "idempotency_key": str(uuid.uuid4()),
                    "source_path": "a.txt",
                    "dest_path": "b.txt",
                    "dest_connection_id": str(read_only_connection.id),
                },
            )

        assert response.status_code == 403
        assert response.json()["detail"] == "Connection is read-only"
        MockBackend.assert_not_called()
