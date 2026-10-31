"""Integration tests for persisted archive-operation lifecycle state."""

import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO
from unittest.mock import ANY, AsyncMock, patch
from zipfile import ZipFile

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient

from app.api.archive_operations import _live_extraction_sessions
from app.models.archive_operation import (
    ArchiveOperation,
    ArchiveOperationError,
    ArchiveOperationErrorCode,
    ArchiveOperationKind,
    ArchiveOperationPhase,
)
from app.models.connection import Connection
from app.models.file import FileInfo, FileType
from app.services.archive.coordinator import (
    ArchiveCreationManifest,
    ArchiveCreationManifestMember,
    ArchiveCreationState,
    commit_creation_member_outcome,
    creation_outcome_summary,
    load_archive_checkpoint,
)
from app.services.archive.creation import ArchiveCreationEntry, ArchiveCreationMemberOutcome, ArchiveCreationResult
from app.services.archive.live_extraction import LiveSourceSessionError
from app.services.archive.zip_reader import ArchiveSourceUnavailableError


class MemoryRandomAccessReader:
    """Minimal archive reader used to exercise scoped relay endpoints."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.closed = False

    async def read_at(self, offset: int, length: int) -> bytes:
        return self.data[offset : offset + length]

    async def close(self) -> None:
        self.closed = True


class FailingPayloadRandomAccessReader(MemoryRandomAccessReader):
    """Fail after one payload chunk to exercise retained-source loss."""

    def __init__(self, data: bytes, failure_offset: int) -> None:
        super().__init__(data)
        self.failure_offset = failure_offset

    async def read_at(self, offset: int, length: int) -> bytes:
        if offset == self.failure_offset:
            raise OSError("source handle lost")
        return await super().read_at(offset, length)


def configure_direct_extraction_archive(backend: AsyncMock, members: dict[str, bytes]) -> None:
    """Configure a direct-extraction backend with a small valid ZIP source."""

    archive_buffer = BytesIO()
    with ZipFile(archive_buffer, "w") as archive:
        for member_path, contents in members.items():
            archive.writestr(member_path, contents)
    archive_bytes = archive_buffer.getvalue()
    backend.get_file_info.return_value = FileInfo(
        name="input.zip",
        path="input.zip",
        type=FileType.FILE,
        size=len(archive_bytes),
    )
    backend.open_random_access_reader.side_effect = lambda _path: MemoryRandomAccessReader(archive_bytes)
    backend.open_archive_source_reader.side_effect = lambda _path: MemoryRandomAccessReader(archive_bytes)


def set_zip_central_directory_compression_method(archive_bytes: bytes, occurrence: int, compression_method: int) -> bytes:
    """Set one test ZIP central-directory record's compression method without changing payload bytes."""

    central_directory_signature = b"PK\x01\x02"
    position = -1
    for _ in range(occurrence + 1):
        position = archive_bytes.find(central_directory_signature, position + 1)
        if position < 0:
            raise AssertionError("Test ZIP does not contain the requested central-directory record")
    patched_bytes = bytearray(archive_bytes)
    method_offset = position + 10
    patched_bytes[method_offset : method_offset + 2] = compression_method.to_bytes(2, "little")
    return bytes(patched_bytes)


class MemoryArchiveExecutionStateStore:
    def __init__(self) -> None:
        self.transitions: list[tuple[ArchiveOperationPhase, ArchiveOperationPhase]] = []

    def transition(
        self,
        operation: ArchiveOperation,
        *,
        expected_phase: ArchiveOperationPhase,
        next_phase: ArchiveOperationPhase,
        additional_changes: dict[str, object] | None = None,
    ) -> ArchiveOperation:
        assert operation.phase == expected_phase
        self.transitions.append((expected_phase, next_phase))
        operation.phase = next_phase
        if additional_changes is not None:
            for name, value in additional_changes.items():
                setattr(operation, name, value)
        return operation

    def update_checkpoint(self, operation: ArchiveOperation, checkpoint_json: str) -> ArchiveOperation:
        operation.checkpoint_json = checkpoint_json
        return operation

    def await_decision(self, operation: ArchiveOperation, decision: dict[str, object]) -> ArchiveOperation:
        operation.phase = ArchiveOperationPhase.AWAITING_USER_DECISION
        operation.pending_decision_json = json.dumps(decision)
        return operation

    def fail(
        self,
        operation: ArchiveOperation,
        message: str,
        *,
        error_code: ArchiveOperationErrorCode | None = None,
    ) -> ArchiveOperation:
        operation.phase = ArchiveOperationPhase.FAILED
        operation.last_error_json = ArchiveOperationError(
            code=error_code or ArchiveOperationErrorCode.TRANSPORT_FAILURE,
            message=message,
        ).model_dump_json()
        return operation

    def cancellation_requested(self, operation: ArchiveOperation) -> bool:
        return operation.cancellation_requested

    def heartbeat(self, operation: ArchiveOperation) -> None:
        return None

    async def is_cancelled(self, operation: ArchiveOperation) -> bool:
        return operation.cancellation_requested


def test_companion_creation_summary_rejects_checkpoint_entry_without_size() -> None:
    operation = ArchiveOperation(
        user_id=uuid.uuid4(),
        kind=ArchiveOperationKind.CREATE,
        checkpoint_json=json.dumps({"version": 2}),
    )

    with pytest.raises(HTTPException, match="Archive operation checkpoint is invalid") as exc_info:
        creation_outcome_summary(load_archive_checkpoint(operation))
    assert exc_info.value.status_code == status.HTTP_409_CONFLICT


def test_creation_state_rejects_duplicate_members_and_bounds_member_lookup() -> None:
    manifest = ArchiveCreationManifest.from_members([ArchiveCreationManifestMember("docs/readme.txt", False, 7, None, None)])
    state = ArchiveCreationState.from_checkpoint(manifest.empty_checkpoint())

    assert state.member("docs/readme.txt").source_size == 7
    with pytest.raises(HTTPException, match="invalid or unavailable") as exc_info:
        state.member("missing.txt")
    assert exc_info.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT

    with pytest.raises(HTTPException, match="checkpoint is invalid") as exc_info:
        ArchiveCreationState.from_checkpoint({**manifest.empty_checkpoint(), "manifest": manifest.empty_checkpoint()["manifest"] * 2})
    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    with pytest.raises(HTTPException, match="checkpoint is invalid") as exc_info:
        ArchiveCreationState.from_checkpoint(
            {
                **manifest.empty_checkpoint(),
                "manifest": [
                    {"archive_path": "folder", "is_directory": False, "source_size": 1, "source_path": None, "modified_at": None},
                    {"archive_path": "folder/child.txt", "is_directory": False, "source_size": 1, "source_path": None, "modified_at": None},
                ],
            }
        )
    assert exc_info.value.status_code == status.HTTP_409_CONFLICT


def test_creation_state_normalizes_member_lookup_and_validates_member_reports() -> None:
    manifest = ArchiveCreationManifest.from_members([ArchiveCreationManifestMember("docs/readme.txt", False, 7, None, None)])
    state = ArchiveCreationState.from_checkpoint(manifest.empty_checkpoint())

    outcome = state.expected_outcome("docs\\readme.txt")

    assert outcome == ArchiveCreationMemberOutcome("docs/readme.txt", "created", 7)
    assert state.has_committed_outcome(outcome) is False
    with pytest.raises(HTTPException, match="completion counts are invalid") as exc_info:
        state.validate_report(ArchiveCreationMemberOutcome("docs/readme.txt", "created", 6))
    assert exc_info.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_creation_member_commit_normalizes_and_persists_manifest_outcome() -> None:
    operation = ArchiveOperation(user_id=uuid.uuid4(), kind=ArchiveOperationKind.CREATE)
    manifest = ArchiveCreationManifest.from_members([ArchiveCreationManifestMember("docs/readme.txt", False, 7, None, None)])
    operation.checkpoint_json = json.dumps(manifest.empty_checkpoint())

    committed = commit_creation_member_outcome(
        MemoryArchiveExecutionStateStore(),
        operation,
        ArchiveCreationMemberOutcome("docs\\readme.txt", "created", 7),
    )

    assert json.loads(committed.checkpoint_json)["member_outcomes"] == {"docs/readme.txt": {"status": "created", "source_bytes": 7}}


def test_creation_manifest_centralizes_relay_normalization_and_validation() -> None:
    manifest = ArchiveCreationManifest.from_members([ArchiveCreationManifestMember("docs\\readme.txt", False, 7, None, None)])

    assert manifest.members[0].archive_path == "docs/readme.txt"
    assert manifest.empty_checkpoint()["manifest"] == [
        {
            "source_path": None,
            "archive_path": "docs/readme.txt",
            "is_directory": False,
            "source_size": 7,
            "modified_at": None,
        }
    ]
    with pytest.raises(HTTPException, match="duplicate entry names") as exc_info:
        ArchiveCreationManifest.from_members(
            [
                ArchiveCreationManifestMember("Report.txt", False, 1, None, None),
                ArchiveCreationManifestMember("report.txt", False, 1, None, None),
            ]
        )
    assert exc_info.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    with pytest.raises(HTTPException, match="duplicate entry names") as exc_info:
        ArchiveCreationManifest.from_members(
            [
                ArchiveCreationManifestMember("folder", False, 1, None, None),
                ArchiveCreationManifestMember("folder/child.txt", False, 1, None, None),
            ]
        )
    assert exc_info.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    with pytest.raises(HTTPException, match="directory source size") as exc_info:
        ArchiveCreationManifest.from_members([ArchiveCreationManifestMember("docs", True, 1, None, None)])
    assert exc_info.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_creation_member_outcome_recorder_is_idempotent_and_rejects_conflicts() -> None:
    from app.services.archive.coordinator import record_creation_member_outcome
    from app.services.archive.creation import ArchiveCreationMemberOutcome

    checkpoint = ArchiveCreationManifest.from_members(
        [
            ArchiveCreationManifestMember("docs", True, 0, None, None),
            ArchiveCreationManifestMember("docs/readme.txt", False, 7, None, None),
        ]
    ).empty_checkpoint()
    record_creation_member_outcome(checkpoint, ArchiveCreationMemberOutcome("docs", "directory"))
    record_creation_member_outcome(checkpoint, ArchiveCreationMemberOutcome("docs/readme.txt", "created", 7))
    record_creation_member_outcome(checkpoint, ArchiveCreationMemberOutcome("docs/readme.txt", "created", 7))

    assert checkpoint["member_outcomes"] == {
        "docs": {"status": "directory", "source_bytes": 0},
        "docs/readme.txt": {"status": "created", "source_bytes": 7},
    }
    with pytest.raises(HTTPException, match="outcome conflicts") as exc_info:
        record_creation_member_outcome(checkpoint, ArchiveCreationMemberOutcome("docs/readme.txt", "created", 8))
    assert exc_info.value.status_code == status.HTTP_409_CONFLICT


def test_creation_outcome_summary_requires_complete_manifest_ledger() -> None:
    checkpoint = ArchiveCreationManifest.from_members(
        [
            ArchiveCreationManifestMember("docs", True, 0, None, None),
            ArchiveCreationManifestMember("docs/readme.txt", False, 7, None, None),
        ]
    ).empty_checkpoint()
    checkpoint["member_outcomes"] = {
        "docs": {"status": "directory", "source_bytes": 0},
        "docs/readme.txt": {"status": "created", "source_bytes": 7},
    }

    assert creation_outcome_summary(checkpoint).to_checkpoint() == {
        "files_created": 1,
        "directories_created": 1,
        "source_bytes": 7,
    }
    checkpoint["member_outcomes"] = {"docs": {"status": "directory", "source_bytes": 0}}
    with pytest.raises(HTTPException, match="outcomes did not match"):
        creation_outcome_summary(checkpoint)


def test_companion_local_creation_relay_streams_smb_members_and_completes(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": str(test_connection.id),
            "source_path": "",
            "destination_connection_id": "local-drive:c",
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    member_relay_headers = {**relay_headers, "Idempotency-Key": str(uuid.uuid4())}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="readme.txt", path="readme.txt", type=FileType.FILE, size=5)

    async def source_chunks():
        yield b"hello"

    backend.read_file = lambda _path: source_chunks()
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        manifest = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
        )
        member = client.get(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "readme.txt"},
        )
        member_complete = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member-complete",
            headers=member_relay_headers,
            json={"archive_path": "readme.txt", "status": "created", "source_bytes": 5},
        )
        repeated_member_complete = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member-complete",
            headers=member_relay_headers,
            json={"archive_path": "readme.txt", "status": "created", "source_bytes": 5},
        )
        conflicting_member_complete = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member-complete",
            headers=member_relay_headers,
            json={"archive_path": "readme.txt", "status": "created", "source_bytes": 4},
        )
        complete = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/complete",
            headers=relay_headers,
            json={"files_created": 1, "directories_created": 0, "source_bytes": 5},
        )

    assert manifest.status_code == 200
    assert manifest.json()["operation"]["phase"] == "streaming"
    assert manifest.json()["entries"] == [
        {
            "source_path": "readme.txt",
            "archive_path": "readme.txt",
            "is_directory": False,
            "source_size": 5,
            "modified_at": None,
        }
    ]
    assert member.status_code == 200
    assert member.content == b"hello"
    assert member_complete.status_code == 200
    assert repeated_member_complete.status_code == 200
    assert conflicting_member_complete.status_code == status.HTTP_409_CONFLICT
    assert conflicting_member_complete.json()["message"] == "Archive relay idempotency key conflicts with its command"
    assert complete.status_code == 200
    assert complete.json()["phase"] == "completed"
    checkpoint = json.loads(complete.json()["checkpoint_json"])
    assert checkpoint["member_outcomes"] == {"readme.txt": {"status": "created", "source_bytes": 5}}
    assert checkpoint["manifest"] == [
        {
            "source_path": "readme.txt",
            "archive_path": "readme.txt",
            "is_directory": False,
            "source_size": 5,
            "modified_at": None,
        }
    ]


def test_companion_creation_relay_rejects_invalid_idempotency_key(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": str(test_connection.id),
            "source_path": "",
            "destination_connection_id": "local-drive:c",
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    response = client.post(
        f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member-complete",
        headers={"Authorization": f"Bearer {capability['token']}", "Idempotency-Key": "not-a-uuid"},
        json={"archive_path": "readme.txt", "status": "created", "source_bytes": 5},
    )

    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert response.json()["message"] == "Archive relay idempotency key is invalid"


def test_companion_local_creation_relay_reuses_its_persisted_manifest(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": str(test_connection.id),
            "source_path": "",
            "destination_connection_id": "local-drive:c",
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}", "Idempotency-Key": str(uuid.uuid4())}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="readme.txt", path="readme.txt", type=FileType.FILE, size=5)
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        first_manifest = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
        )
        backend.get_file_info.reset_mock()
        repeated_manifest = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
        )

    assert first_manifest.status_code == 200
    assert repeated_manifest.status_code == 200
    assert repeated_manifest.json()["entries"] == first_manifest.json()["entries"]
    backend.connect.assert_awaited_once()
    backend.get_file_info.assert_not_awaited()


def test_companion_local_creation_relay_accepts_equivalent_canonical_source_timestamps(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": str(test_connection.id),
            "source_path": "",
            "destination_connection_id": "local-drive:c",
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.side_effect = [
        FileInfo(
            name="readme.txt",
            path="readme.txt",
            type=FileType.FILE,
            size=5,
            modified_at=datetime(2024, 3, 1, 8, 30, 45, 987654, tzinfo=timezone(timedelta(hours=2))),
        ),
        FileInfo(
            name="readme.txt",
            path="readme.txt",
            type=FileType.FILE,
            size=5,
            modified_at=datetime(2024, 3, 1, 6, 30, 45, tzinfo=timezone.utc),
        ),
    ]

    async def source_chunks():
        yield b"hello"

    backend.read_file = lambda _path: source_chunks()
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        manifest = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
        )
        member = client.get(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "readme.txt"},
        )

    assert manifest.status_code == 200
    assert datetime.fromisoformat(manifest.json()["entries"][0]["modified_at"].replace("Z", "+00:00")) == datetime(
        2024, 3, 1, 6, 30, 45, tzinfo=timezone.utc
    )
    assert member.status_code == 200
    assert member.content == b"hello"


def test_companion_local_creation_relay_rejects_a_source_changed_after_manifest_preflight(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": str(test_connection.id),
            "source_path": "",
            "destination_connection_id": "local-drive:c",
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.side_effect = [
        FileInfo(name="readme.txt", path="readme.txt", type=FileType.FILE, size=5),
        FileInfo(name="readme.txt", path="readme.txt", type=FileType.FILE, size=6),
    ]
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        manifest = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
        )
        member = client.get(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "readme.txt"},
        )
        operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user)

    assert manifest.status_code == 200
    assert member.status_code == 409
    assert operation.json()["phase"] == "failed"


def test_companion_local_creation_relay_rejects_an_inconsistent_completion_summary(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": str(test_connection.id),
            "source_path": "",
            "destination_connection_id": "local-drive:c",
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="readme.txt", path="readme.txt", type=FileType.FILE, size=5)
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        manifest = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
        )
        complete = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/complete",
            headers=relay_headers,
            json={"files_created": 1, "directories_created": 0, "source_bytes": 4},
        )
        operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user)

    assert manifest.status_code == 200
    assert complete.status_code == 409
    assert operation.json()["phase"] == "failed"


def test_companion_local_creation_relay_requires_member_outcomes_before_completion(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": str(test_connection.id),
            "source_path": "",
            "destination_connection_id": "local-drive:c",
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="readme.txt", path="readme.txt", type=FileType.FILE, size=5)
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        manifest = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
        )
        complete = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/complete",
            headers=relay_headers,
            json={"files_created": 1, "directories_created": 0, "source_bytes": 5},
        )
        operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user)

    assert manifest.status_code == 200
    assert complete.status_code == 409
    assert operation.json()["phase"] == "failed"


def test_companion_smb_creation_relay_commits_local_members_and_completes(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": "local-drive:c",
            "source_path": "",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    writer = AsyncMock()
    writer.write.side_effect = lambda data: len(data)
    backend.open_exclusive_writer.return_value = writer

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
            json={"entries": [{"archive_path": "readme.txt", "is_directory": False, "source_size": 9}]},
        )
        member = client.put(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "readme.txt"},
            content=b"zip-bytes",
        )
        checkpoint = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user)
        complete = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/complete",
            headers=relay_headers,
            json={"files_created": 1, "directories_created": 0, "source_bytes": 9},
        )
        repeated_complete = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/complete",
            headers=relay_headers,
            json={"files_created": 1, "directories_created": 0, "source_bytes": 9},
        )

    assert begin.status_code == 200
    assert member.status_code == 200
    assert member.json()["phase"] == "streaming"
    assert json.loads(checkpoint.json()["checkpoint_json"])["member_outcomes"] == {"readme.txt": {"status": "created", "source_bytes": 9}}
    writer.write.assert_awaited()
    writer.close.assert_awaited_once()
    assert complete.status_code == 200
    assert complete.json()["phase"] == "completed"
    assert repeated_complete.status_code == 200
    assert repeated_complete.json()["phase"] == "completed"
    assert creation_outcome_summary(json.loads(complete.json()["checkpoint_json"])).source_bytes == 9


def test_local_to_smb_creation_relay_commits_directories_and_replays_members_once(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": "local-drive:c",
            "source_path": "",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["docs"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    writer = AsyncMock()
    writer.write.side_effect = lambda data: len(data)
    backend.open_exclusive_writer.return_value = writer

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
            json={
                "entries": [
                    {"archive_path": "docs", "is_directory": True, "source_size": 0},
                    {"archive_path": "docs/readme.txt", "is_directory": False, "source_size": 5},
                ]
            },
        )
        repeated_begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
            json={
                "entries": [
                    {"archive_path": "docs", "is_directory": True, "source_size": 0},
                    {"archive_path": "docs/readme.txt", "is_directory": False, "source_size": 5},
                ]
            },
        )
        directory = client.put(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "docs"},
        )
        file_member = client.put(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "docs\\readme.txt"},
            content=b"hello",
        )
        write_count_before_replay = writer.write.await_count
        replay = client.put(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "docs\\readme.txt"},
            content=b"hello",
        )
        write_count_after_replay = writer.write.await_count
        complete = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/complete",
            headers=relay_headers,
            json={"files_created": 1, "directories_created": 1, "source_bytes": 5},
        )

    assert begin.status_code == 200
    assert repeated_begin.status_code == 200
    backend.open_exclusive_writer.assert_awaited_once()
    assert directory.status_code == 200
    assert file_member.status_code == 200
    assert replay.status_code == 200
    assert write_count_after_replay == write_count_before_replay
    assert complete.status_code == 200
    assert json.loads(complete.json()["checkpoint_json"])["member_outcomes"] == {
        "docs": {"status": "directory", "source_bytes": 0},
        "docs/readme.txt": {"status": "created", "source_bytes": 5},
    }


def test_cancelling_local_to_smb_creation_after_a_member_commit_preserves_ledger(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": "local-drive:c",
            "source_path": "",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["first.txt", "second.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    writer = AsyncMock()
    writer.write.side_effect = lambda data: len(data)
    backend.open_exclusive_writer.return_value = writer

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
            json={
                "entries": [
                    {"archive_path": "first.txt", "is_directory": False, "source_size": 5},
                    {"archive_path": "second.txt", "is_directory": False, "source_size": 6},
                ]
            },
        )
        member = client.put(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "first.txt"},
            content=b"first",
        )
        cancelled = client.post(f"/api/archive/v2/operations/{prepared['id']}/cancel", headers=auth_headers_user)

    assert begin.status_code == 200
    assert member.status_code == 200
    assert cancelled.status_code == 200
    assert cancelled.json()["phase"] == "cancelled"
    assert json.loads(cancelled.json()["checkpoint_json"])["member_outcomes"] == {"first.txt": {"status": "created", "source_bytes": 5}}
    writer.abort_and_delete_if_owned.assert_awaited_once()
    backend.disconnect.assert_awaited_once()


def test_local_to_smb_creation_rejects_completion_before_the_manifest_is_reported(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": "local-drive:c",
            "source_path": "",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["first.txt", "second.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    writer = AsyncMock()
    writer.write.side_effect = lambda data: len(data)
    backend.open_exclusive_writer.return_value = writer

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
            json={
                "entries": [
                    {"archive_path": "first.txt", "is_directory": False, "source_size": 5},
                    {"archive_path": "second.txt", "is_directory": False, "source_size": 6},
                ]
            },
        )
        member = client.put(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "first.txt"},
            content=b"first",
        )
        complete = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/complete",
            headers=relay_headers,
            json={"files_created": 1, "directories_created": 0, "source_bytes": 5},
        )

    assert begin.status_code == 200
    assert member.status_code == 200
    assert complete.status_code == 409
    writer.abort_and_delete_if_owned.assert_awaited_once()
    backend.disconnect.assert_awaited_once()


def test_cancelled_local_to_smb_creation_does_not_open_a_live_writer(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": "local-drive:c",
            "source_path": "",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        cancelled = client.post(f"/api/archive/v2/operations/{prepared['id']}/cancel", headers=auth_headers_user)
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
            json={"entries": [{"archive_path": "readme.txt", "is_directory": False, "source_size": 9}]},
        )
        operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user)

    assert cancelled.status_code == 200
    assert begin.status_code == 409
    assert operation.json()["phase"] == "cancelled"
    backend.connect.assert_not_awaited()
    backend.open_exclusive_writer.assert_not_awaited()


def test_cancelling_local_to_smb_creation_aborts_the_live_writer(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": "local-drive:c",
            "source_path": "",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    writer = AsyncMock()
    backend.open_exclusive_writer.return_value = writer

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers={"Authorization": f"Bearer {capability['token']}"},
            json={"entries": [{"archive_path": "readme.txt", "is_directory": False, "source_size": 9}]},
        )
        cancelled = client.post(f"/api/archive/v2/operations/{prepared['id']}/cancel", headers=auth_headers_user)

    assert begin.status_code == 200
    assert cancelled.status_code == 200
    writer.abort_and_delete_if_owned.assert_awaited_once()
    backend.disconnect.assert_awaited_once()


def test_failing_local_to_smb_creation_aborts_the_live_writer(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": "local-drive:c",
            "source_path": "",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    writer = AsyncMock()
    backend.open_exclusive_writer.return_value = writer

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
            json={"entries": [{"archive_path": "readme.txt", "is_directory": False, "source_size": 9}]},
        )
        failed = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/fail",
            headers=relay_headers,
            json={"message": "Local source became unavailable"},
        )

    assert begin.status_code == 200
    assert failed.status_code == 200
    assert failed.json()["phase"] == "failed"
    writer.abort_and_delete_if_owned.assert_awaited_once()
    backend.disconnect.assert_awaited_once()


def test_local_to_smb_creation_rejects_changed_member_size(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": "local-drive:c",
            "source_path": "",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    writer = AsyncMock()
    writer.write.side_effect = lambda data: len(data)
    backend.open_exclusive_writer.return_value = writer

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
            json={"entries": [{"archive_path": "readme.txt", "is_directory": False, "source_size": 10}]},
        )
        member = client.put(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "readme.txt"},
            content=b"zip-bytes",
        )

    assert begin.status_code == 200
    assert member.status_code == 409
    assert member.json()["message"] == "Archive creation source changed after manifest validation"
    writer.abort_and_delete_if_owned.assert_awaited_once()
    operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user)
    assert operation.json()["last_error"]["code"] == "source_changed"


def test_local_to_smb_creation_rejects_members_after_live_writer_interruption(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": "local-drive:c",
            "source_path": "",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output.zip",
            "plan_json": json.dumps({"source_paths": ["readme.txt"]}),
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    execution = AsyncMock()
    execution.is_active = lambda: False

    with (
        patch("app.api.archive_operations.SMBBackend", return_value=backend),
        patch("app.api.archive_operations._local_to_smb_creation_writers.execution", return_value=execution),
    ):
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/begin",
            headers=relay_headers,
            json={"entries": [{"archive_path": "readme.txt", "is_directory": False, "source_size": 5}]},
        )
        member = client.put(
            f"/api/archive/v2/operations/{prepared['id']}/relay/creation/member",
            headers=relay_headers,
            params={"archive_path": "readme.txt"},
            content=b"hello",
        )

    assert begin.status_code == 200
    assert member.status_code == 409
    assert member.json()["message"] == "Archive creation session was interrupted"
    execution.write_member.assert_not_awaited()


def test_v2_creates_from_selected_zip_members_and_closes_reader(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": str(test_connection.id),
            "source_path": "source.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "nested/backup.zip",
            "selected_member_paths": ["nested"],
        },
    ).json()
    backend = AsyncMock()
    archive_buffer = BytesIO()
    with ZipFile(archive_buffer, "w") as archive:
        archive.writestr("nested/empty/", b"")
        archive.writestr("nested/report.txt", b"hello")
    archive_bytes = archive_buffer.getvalue()
    reader = MemoryRandomAccessReader(archive_bytes)
    backend.get_file_info.return_value = FileInfo(name="source.zip", path="source.zip", type=FileType.FILE, size=len(archive_bytes))
    backend.open_random_access_reader.return_value = reader
    streamed: list[bytes] = []

    async def create_archive(source, *, preflight_manifest, on_member_completed, **_kwargs):
        for member in preflight_manifest.members:
            if member.is_directory:
                await on_member_completed(ArchiveCreationMemberOutcome(member.archive_path, "directory"))
            else:
                streamed.extend([chunk async for chunk in source.read_file(member.source_path)])
                await on_member_completed(ArchiveCreationMemberOutcome(member.archive_path, "created", member.source_size))
        return ArchiveCreationResult(1, 5, 2)

    with (
        patch("app.api.archive_operations.SMBBackend", return_value=backend),
        patch("app.api.archive_operations.create_archive_from_files", new=AsyncMock(side_effect=create_archive)) as creator,
    ):
        response = client.post(f"/api/archive/v2/operations/{prepared['id']}/creation/begin", headers=auth_headers_user)

    assert response.status_code == 200, response.text
    assert response.json()["phase"] == "completed"
    assert streamed == [b"hello"]
    assert reader.closed
    assert creator.await_args.kwargs["source_paths"] == ["nested"]
    assert {entry["archive_path"] for entry in json.loads(response.json()["checkpoint_json"])["manifest"]} == {
        "nested",
        "nested/empty",
        "nested/report.txt",
    }


def test_v2_zip_member_creation_rejects_invalid_scope_and_closes_failed_source(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    request = {
        "contract_version": "v2",
        "kind": "create",
        "source_connection_id": str(test_connection.id),
        "source_path": "source.zip",
        "destination_connection_id": str(test_connection.id),
        "destination_path": "backup.zip",
        "selected_member_paths": ["nested/report.txt"],
    }
    invalid = client.post("/api/archive/v2/operations", headers=auth_headers_user, json={**request, "selected_member_paths": ["../escape"]})
    assert invalid.status_code == 422
    mixed = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={**request, "destination_connection_id": "local-drive:c"},
    )
    assert mixed.status_code == 422

    prepared = client.post("/api/archive/v2/operations", headers=auth_headers_user, json=request).json()
    backend = AsyncMock()
    archive_buffer = BytesIO()
    with ZipFile(archive_buffer, "w") as archive:
        archive.writestr("nested/report.txt", b"hello")
        archive.writestr("../unsafe.txt", b"unsafe")
    reader = MemoryRandomAccessReader(archive_buffer.getvalue())
    backend.get_file_info.return_value = FileInfo(
        name="source.zip", path="source.zip", type=FileType.FILE, size=len(archive_buffer.getvalue())
    )
    backend.open_random_access_reader.return_value = reader
    with (
        patch("app.api.archive_operations.SMBBackend", return_value=backend),
        patch("app.api.archive_operations.create_archive_from_files", new=AsyncMock()) as creator,
    ):
        response = client.post(f"/api/archive/v2/operations/{prepared['id']}/creation/begin", headers=auth_headers_user)

    assert response.status_code == 422
    assert reader.closed
    creator.assert_not_awaited()


def test_v2_executes_same_connection_creation_with_strict_ledger(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "create",
            "source_connection_id": str(test_connection.id),
            "source_path": "",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "backup.zip",
            "plan_json": json.dumps({"source_paths": ["first.txt", "second.txt"]}),
        },
    ).json()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None

    async def create_archive_with_member_outcomes(*_args, on_member_completed, **_kwargs):
        await on_member_completed(ArchiveCreationMemberOutcome("first.txt", "created", 5))
        await on_member_completed(ArchiveCreationMemberOutcome("second.txt", "created", 6))
        return ArchiveCreationResult(2, 11)

    preflight_entries = [
        ArchiveCreationEntry("first.txt", "first.txt", FileInfo(name="first.txt", path="first.txt", type=FileType.FILE, size=5)),
        ArchiveCreationEntry("second.txt", "second.txt", FileInfo(name="second.txt", path="second.txt", type=FileType.FILE, size=6)),
    ]
    with (
        patch("app.api.archive_operations.SMBBackend", return_value=backend),
        patch("app.api.archive_operations.build_archive_creation_manifest", new=AsyncMock(return_value=preflight_entries)),
        patch(
            "app.api.archive_operations.create_archive_from_files", new=AsyncMock(side_effect=create_archive_with_member_outcomes)
        ) as create_archive,
    ):
        response = client.post(f"/api/archive/v2/operations/{prepared['id']}/creation/begin", headers=auth_headers_user)

    assert response.status_code == 200
    assert response.json()["phase"] == "completed"
    assert json.loads(response.json()["checkpoint_json"]) == {
        "version": 2,
        "member_outcomes": {
            "first.txt": {"status": "created", "source_bytes": 5},
            "second.txt": {"status": "created", "source_bytes": 6},
        },
        "decisions": {},
        "pending_decision": None,
        "delivery_ids": {},
        "manifest": [
            {
                "source_path": "first.txt",
                "archive_path": "first.txt",
                "is_directory": False,
                "source_size": 5,
                "modified_at": None,
            },
            {
                "source_path": "second.txt",
                "archive_path": "second.txt",
                "is_directory": False,
                "source_size": 6,
                "modified_at": None,
            },
        ],
    }
    create_archive.assert_awaited_once_with(
        backend,
        destination=backend,
        source_paths=["first.txt", "second.txt"],
        target_path="backup.zip",
        is_cancelled=ANY,
        on_member_completed=ANY,
        preflight_manifest=ANY,
    )
    manifest = create_archive.await_args.kwargs["preflight_manifest"]
    assert [(member.archive_path, member.source_size, member.source_modified_at) for member in manifest.members] == [
        ("first.txt", 5, None),
        ("second.txt", 6, None),
    ]


def test_executes_same_connection_extraction(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(test_connection.id),
            "source_path": "input.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output",
        },
    ).json()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    configure_direct_extraction_archive(backend, {"first.txt": b"12345", "second.txt": b"67890"})
    directories: set[str] = set()
    files: dict[str, bytes] = {}
    archive_info = backend.get_file_info.return_value

    async def get_file_info(path: str) -> FileInfo:
        if path == "input.zip":
            return archive_info
        if path in directories:
            return FileInfo(name=path.rsplit("/", 1)[-1], path=path, type=FileType.DIRECTORY)
        if path in files:
            return FileInfo(name=path.rsplit("/", 1)[-1], path=path, type=FileType.FILE, size=len(files[path]))
        raise FileNotFoundError(path)

    async def create_directory(path: str) -> None:
        if path in directories:
            raise FileExistsError(path)
        directories.add(path)

    async def write_file_from_stream(path: str, stream, *, overwrite: bool = False, source_mtime=None) -> int:
        del overwrite, source_mtime
        files[path] = b"".join([chunk async for chunk in stream])
        return len(files[path])

    backend.get_file_info.side_effect = get_file_info
    backend.create_directory.side_effect = create_directory
    backend.write_file_from_stream.side_effect = write_file_from_stream

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        response = client.post(f"/api/archive/v2/operations/{prepared['id']}/extraction/begin", headers=auth_headers_user)

    assert response.status_code == 200, response.text
    assert response.json()["phase"] == "completed"
    checkpoint = json.loads(response.json()["checkpoint_json"])
    assert checkpoint == {
        "version": 2,
        "aggregate_counters": {
            "members_processed": 2,
            "members_completed": 2,
            "members_skipped": 0,
            "encrypted_members_skipped": 0,
            "unsupported_compression_members_skipped": 0,
            "members_failed": 0,
            "files_extracted": 2,
            "directories_created": 1,
            "extracted_bytes": 10,
            "files_replaced": 0,
        },
    }
    assert files == {"output/first.txt": b"12345", "output/second.txt": b"67890"}
    backend.open_archive_source_reader.assert_awaited_once_with("input.zip")
    backend.open_random_access_reader.assert_not_awaited()


def test_executes_distinct_connection_extraction(
    client: TestClient,
    auth_headers_user: dict,
    multiple_connections: list[Connection],
) -> None:
    source_connection, destination_connection = multiple_connections[:2]
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(source_connection.id),
            "source_path": "input.zip",
            "destination_connection_id": str(destination_connection.id),
            "destination_path": "output",
        },
    ).json()
    source_backend = AsyncMock()
    destination_backend = AsyncMock()
    for backend in (source_backend, destination_backend):
        backend.connect.return_value = None
        backend.disconnect.return_value = None
    configure_direct_extraction_archive(source_backend, {"first.txt": b"contents"})
    files: dict[str, bytes] = {}

    async def destination_file_info(path: str) -> FileInfo:
        if path in files:
            return FileInfo(name=path.rsplit("/", 1)[-1], path=path, type=FileType.FILE, size=len(files[path]))
        raise FileNotFoundError(path)

    async def write_file_from_stream(path: str, stream, *, overwrite: bool = False, source_mtime=None) -> int:
        del overwrite, source_mtime
        files[path] = b"".join([chunk async for chunk in stream])
        return len(files[path])

    destination_backend.get_file_info.side_effect = destination_file_info
    destination_backend.create_directory.return_value = None
    destination_backend.write_file_from_stream.side_effect = write_file_from_stream

    with patch("app.api.archive_operations.SMBBackend", side_effect=[source_backend, destination_backend]):
        response = client.post(f"/api/archive/v2/operations/{prepared['id']}/extraction/begin", headers=auth_headers_user)

    assert response.status_code == 200, response.text
    assert response.json()["phase"] == "completed"
    assert files == {"output/first.txt": b"contents"}
    source_backend.open_archive_source_reader.assert_awaited_once_with("input.zip")
    destination_backend.open_archive_source_reader.assert_not_awaited()
    source_backend.connect.assert_awaited_once()
    destination_backend.connect.assert_awaited_once()


def test_direct_extraction_retains_live_source_through_collision_resolution(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(test_connection.id),
            "source_path": "input.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output",
        },
    ).json()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    configure_direct_extraction_archive(backend, {"first.txt": b"replacement"})
    directories = {"output"}
    files = {"output/first.txt": b"existing"}
    archive_info = backend.get_file_info.return_value

    async def get_file_info(path: str) -> FileInfo:
        if path == "input.zip":
            return archive_info
        if path in directories:
            return FileInfo(name=path.rsplit("/", 1)[-1], path=path, type=FileType.DIRECTORY)
        if path in files:
            return FileInfo(name=path.rsplit("/", 1)[-1], path=path, type=FileType.FILE, size=len(files[path]))
        raise FileNotFoundError(path)

    async def create_directory(path: str) -> None:
        if path in directories:
            raise FileExistsError(path)
        directories.add(path)

    async def write_file_from_stream(path: str, stream, *, overwrite: bool = False, source_mtime=None) -> int:
        del source_mtime
        if path in files and not overwrite:
            raise FileExistsError(path)
        files[path] = b"".join([chunk async for chunk in stream])
        return len(files[path])

    backend.get_file_info.side_effect = get_file_info
    backend.create_directory.side_effect = create_directory
    backend.write_file_from_stream.side_effect = write_file_from_stream
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        paused = client.post(f"/api/archive/v2/operations/{prepared['id']}/extraction/begin", headers=auth_headers_user)
        status_response = client.get(f"/api/archive/v2/operations/{prepared['id']}/extraction/live-status", headers=auth_headers_user)

    assert paused.json()["phase"] == "awaiting_user_decision"
    assert paused.json()["pending_decision_json"] is None
    live_status = status_response.json()
    assert live_status["phase"] == "awaiting_decision"
    pending_decision = live_status["pending_decision"]
    assert pending_decision["member_path"] == "first.txt"
    assert pending_decision["source"]["path"] == "first.txt"
    assert pending_decision["source"]["size"] == len(b"replacement")
    assert isinstance(pending_decision["source"]["modified_at"], str)
    assert pending_decision["target"] == {
        "path": "output/first.txt",
        "size": len(b"existing"),
        "modified_at": None,
    }

    resolved = client.post(
        f"/api/archive/v2/operations/{prepared['id']}/extraction/decision",
        headers=auth_headers_user,
        json={
            "action": "replace",
            "source_session_id": live_status["source_session_id"],
            "delivery_sequence": 1,
            "decision_revision": pending_decision["revision"],
        },
    )
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        completed = client.post(f"/api/archive/v2/operations/{prepared['id']}/extraction/begin", headers=auth_headers_user)

    assert resolved.json()["phase"] == "streaming"
    assert completed.json()["phase"] == "completed"
    assert files["output/first.txt"] == b"replacement"
    backend.open_archive_source_reader.assert_awaited_once_with("input.zip")


def test_live_status_source_loss_terminalizes_operation_and_rejects_stale_decision(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(test_connection.id),
            "source_path": "input.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output",
        },
    ).json()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    configure_direct_extraction_archive(backend, {"first.txt": b"replacement"})
    archive_info = backend.get_file_info.return_value

    async def get_file_info(path: str) -> FileInfo:
        if path == "input.zip":
            return archive_info
        if path == "output":
            return FileInfo(name="output", path="output", type=FileType.DIRECTORY)
        if path == "output/first.txt":
            return FileInfo(name="first.txt", path=path, type=FileType.FILE, size=8)
        raise FileNotFoundError(path)

    backend.get_file_info.side_effect = get_file_info
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        paused = client.post(f"/api/archive/v2/operations/{prepared['id']}/extraction/begin", headers=auth_headers_user)
    assert paused.json()["phase"] == "awaiting_user_decision"

    with patch(
        "app.api.archive_operations._live_extraction_sessions.get_for_operation",
        new=AsyncMock(side_effect=LiveSourceSessionError("Archive source session is unavailable")),
    ):
        unavailable = client.get(f"/api/archive/v2/operations/{prepared['id']}/extraction/live-status", headers=auth_headers_user)
    assert unavailable.status_code == status.HTTP_409_CONFLICT
    operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user).json()
    assert operation["phase"] == "failed"
    assert operation["last_error"]["code"] == ArchiveOperationErrorCode.OPERATION_UNAVAILABLE.value
    stale_decision = client.post(
        f"/api/archive/v2/operations/{prepared['id']}/extraction/decision",
        headers=auth_headers_user,
        json={
            "action": "replace",
            "source_session_id": "stale-session",
            "delivery_sequence": 1,
            "decision_revision": 1,
        },
    )
    assert stale_decision.status_code == status.HTTP_409_CONFLICT


def test_direct_extraction_failed_pinned_source_open_terminalizes_operation(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(test_connection.id),
            "source_path": "input.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output",
        },
    ).json()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=22)
    backend.open_archive_source_reader.side_effect = ArchiveSourceUnavailableError("sharing violation")

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        response = client.post(f"/api/archive/v2/operations/{prepared['id']}/extraction/begin", headers=auth_headers_user)

    assert response.status_code == status.HTTP_409_CONFLICT
    operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user).json()
    assert operation["phase"] == ArchiveOperationPhase.FAILED.value
    assert operation["last_error"]["code"] == ArchiveOperationErrorCode.OPERATION_UNAVAILABLE.value
    backend.open_archive_source_reader.assert_awaited_once_with("input.zip")
    backend.open_random_access_reader.assert_not_awaited()


def test_direct_duplicate_live_source_registration_preserves_existing_source(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(test_connection.id),
            "source_path": "input.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output",
        },
    ).json()
    archive = BytesIO()
    with ZipFile(archive, "w") as zip_file:
        zip_file.writestr("entry.txt", b"payload")
    archive_bytes = archive.getvalue()
    existing_reader = MemoryRandomAccessReader(archive_bytes)
    losing_reader = MemoryRandomAccessReader(archive_bytes)
    existing_source = asyncio.run(
        _live_extraction_sessions.open(existing_reader, len(archive_bytes), operation_id=uuid.UUID(prepared["id"]))
    )
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.get_file_info.return_value = FileInfo(name="input.zip", path="input.zip", type=FileType.FILE, size=len(archive_bytes))
    backend.open_archive_source_reader.return_value = losing_reader

    try:
        with patch("app.api.archive_operations.SMBBackend", return_value=backend):
            response = client.post(f"/api/archive/v2/operations/{prepared['id']}/extraction/begin", headers=auth_headers_user)

        assert response.status_code == status.HTTP_409_CONFLICT
        assert losing_reader.closed
        assert asyncio.run(_live_extraction_sessions.get_for_operation(uuid.UUID(prepared["id"]))) is existing_source
        operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user).json()
        assert operation["phase"] == ArchiveOperationPhase.PREPARED.value
    finally:
        asyncio.run(_live_extraction_sessions.remove_for_operation(uuid.UUID(prepared["id"])))


def test_direct_extraction_mid_stream_source_loss_terminalizes_as_unavailable(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(test_connection.id),
            "source_path": "input.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output",
        },
    ).json()
    payload = b"x" * (256 * 1024 + 1)
    archive_buffer = BytesIO()
    with ZipFile(archive_buffer, "w") as archive:
        archive.writestr("member.bin", payload)
    archive_bytes = archive_buffer.getvalue()
    payload_offset = archive_bytes.index(payload)
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None

    async def get_file_info(path: str) -> FileInfo:
        if path == "input.zip":
            return FileInfo(
                name="input.zip",
                path="input.zip",
                type=FileType.FILE,
                size=len(archive_bytes),
            )
        raise FileNotFoundError(path)

    backend.get_file_info.side_effect = get_file_info
    reader = FailingPayloadRandomAccessReader(
        archive_bytes,
        payload_offset + 256 * 1024,
    )
    backend.open_archive_source_reader.return_value = reader

    written_chunks: list[bytes] = []

    async def write_file_from_stream(path: str, stream, *, overwrite: bool = False, source_mtime=None) -> int:
        total = 0
        async for chunk in stream:
            written_chunks.append(chunk)
            total += len(chunk)
        return total

    backend.write_file_from_stream.side_effect = write_file_from_stream
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        response = client.post(f"/api/archive/v2/operations/{prepared['id']}/extraction/begin", headers=auth_headers_user)

    assert response.status_code == status.HTTP_409_CONFLICT
    operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user).json()
    assert operation["phase"] == ArchiveOperationPhase.FAILED.value
    assert operation["last_error"]["code"] == ArchiveOperationErrorCode.OPERATION_UNAVAILABLE.value
    backend.write_file_from_stream.assert_awaited_once()
    assert [len(chunk) for chunk in written_chunks] == [256 * 1024]
    assert reader.closed


def test_direct_extraction_source_loss_persists_known_aggregate_progress(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(test_connection.id),
            "source_path": "input.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output",
        },
    ).json()
    second_payload = b"y" * 1024
    archive_buffer = BytesIO()
    with ZipFile(archive_buffer, "w") as archive:
        archive.writestr("first.txt", b"first")
        archive.writestr("second.bin", second_payload)
    archive_bytes = archive_buffer.getvalue()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None

    async def get_file_info(path: str) -> FileInfo:
        if path == "input.zip":
            return FileInfo(
                name="input.zip",
                path="input.zip",
                type=FileType.FILE,
                size=len(archive_bytes),
            )
        raise FileNotFoundError(path)

    backend.get_file_info.side_effect = get_file_info
    reader = FailingPayloadRandomAccessReader(archive_bytes, archive_bytes.index(second_payload))
    backend.open_archive_source_reader.return_value = reader

    async def write_file_from_stream(path: str, stream, *, overwrite: bool = False, source_mtime=None) -> int:
        total = 0
        async for chunk in stream:
            total += len(chunk)
        return total

    backend.write_file_from_stream.side_effect = write_file_from_stream
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        response = client.post(f"/api/archive/v2/operations/{prepared['id']}/extraction/begin", headers=auth_headers_user)

    assert response.status_code == status.HTTP_409_CONFLICT
    operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user).json()
    checkpoint = json.loads(operation["checkpoint_json"])
    assert checkpoint["aggregate_counters"] == {
        "members_processed": 1,
        "members_completed": 1,
        "members_skipped": 0,
        "encrypted_members_skipped": 0,
        "unsupported_compression_members_skipped": 0,
        "members_failed": 0,
        "files_extracted": 1,
        "directories_created": 1,
        "extracted_bytes": len(b"first"),
        "files_replaced": 0,
    }
    assert reader.closed


def test_companion_capability_returns_persisted_selected_member_paths(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(test_connection.id),
            "source_path": "input.zip",
            "destination_connection_id": "local-drive:c",
            "destination_path": "output",
            "selected_member_paths": ["docs", "docs/readme.txt"],
        },
    ).json()

    capability = client.post(
        f"/api/archive/v2/operations/{prepared['id']}/companion-session",
        headers=auth_headers_user,
    )

    assert capability.status_code == 200
    assert capability.json()["selected_member_paths"] == ["docs"]


def test_local_selected_member_extraction_to_smb_share_root_skips_root_creation(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": "local-drive:c",
            "source_path": "archives/input.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "",
            "selected_member_paths": ["docs/readme.txt"],
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/destination-begin",
            headers={"Authorization": f"Bearer {capability['token']}"},
        )

    assert begin.status_code == 200, begin.text
    assert begin.json()["phase"] == "streaming"
    backend.create_directory.assert_not_awaited()
    backend.connect.assert_awaited_once()
    backend.disconnect.assert_awaited_once()


def test_local_selected_member_extraction_to_existing_smb_file_awaits_collision_decision(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": "local-drive:c",
            "source_path": "archives/input.zip",
            "destination_connection_id": str(test_connection.id),
            "destination_path": "output",
            "selected_member_paths": ["selected.txt"],
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    backend.create_directory.side_effect = FileExistsError("output")

    async def get_file_info(path: str) -> FileInfo:
        if path == "output":
            return FileInfo(name="output", path="output", type=FileType.DIRECTORY)
        if path == "output/selected.txt":
            return FileInfo(name="selected.txt", path="output/selected.txt", type=FileType.FILE, size=8)
        raise FileNotFoundError(path)

    backend.get_file_info.side_effect = get_file_info
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/destination-begin",
            headers=relay_headers,
        )
        result = client.put(
            f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/destination-member",
            headers=relay_headers,
            params={
                "source_session_id": "local-source",
                "delivery_sequence": 1,
                "member_path": "selected.txt",
                "target_path": "selected.txt",
                "is_directory": False,
                "collision_policy": "ask",
            },
            content=b"selected",
        )
        operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user)

    assert begin.status_code == 200, begin.text
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "awaiting_collision"
    assert result.json()["target_path"] == "output/selected.txt"
    assert operation.json()["phase"] == "awaiting_user_decision"
    backend.write_file_from_stream.assert_not_awaited()


def test_live_smb_to_companion_relay_is_source_driven_and_aggregate_only(
    client: TestClient,
    auth_headers_user: dict,
    test_connection: Connection,
) -> None:
    prepared = client.post(
        "/api/archive/v2/operations",
        headers=auth_headers_user,
        json={
            "contract_version": "v2",
            "kind": "extract",
            "source_connection_id": str(test_connection.id),
            "source_path": "input.zip",
            "destination_connection_id": "local-drive:c",
            "destination_path": "output",
            "selected_member_paths": ["selected.txt"],
        },
    ).json()
    capability = client.post(f"/api/archive/v2/operations/{prepared['id']}/companion-session", headers=auth_headers_user).json()
    relay_headers = {"Authorization": f"Bearer {capability['token']}"}
    backend = AsyncMock()
    backend.connect.return_value = None
    backend.disconnect.return_value = None
    configure_direct_extraction_archive(backend, {"selected.txt": b"contents", "excluded.txt": b"not selected"})

    with patch("app.api.archive_operations.SMBBackend", return_value=backend):
        begin = client.post(f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/begin", headers=relay_headers)
        member = client.get(f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/next-member", headers=relay_headers)
        member_data = member.json()
        result_payload = {
            "source_session_id": member_data["source_session_id"],
            "delivery_sequence": member_data["delivery_sequence"],
            "member_path": member_data["member_path"],
            "status": "extracted",
            "extracted_bytes": len(b"contents"),
        }
        premature_result = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/result",
            headers=relay_headers,
            json=result_payload,
        )
        content = client.get(
            f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/current-member",
            headers=relay_headers,
            params={"source_session_id": member_data["source_session_id"], "delivery_sequence": member_data["delivery_sequence"]},
        )
        result = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/result",
            headers=relay_headers,
            json=result_payload,
        )
        duplicate_result = client.post(
            f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/result",
            headers=relay_headers,
            json=result_payload,
        )
        end = client.get(f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/next-member", headers=relay_headers)
        completed = client.post(f"/api/archive/v2/operations/{prepared['id']}/relay/extraction/live/complete", headers=relay_headers)

    assert begin.status_code == 200, begin.text
    assert member_data["member_path"] == "selected.txt"
    assert premature_result.status_code == 409
    assert content.content == b"contents"
    assert result.status_code == 200
    assert result.json()["aggregate_counters"]["members_completed"] == 1
    assert result.json()["phase"] == "ready"
    assert duplicate_result.status_code == 409
    assert end.json() is None
    assert completed.json()["phase"] == "completed"
    assert completed.json()["aggregate_counters"] == {
        "members_processed": 1,
        "members_completed": 1,
        "members_skipped": 0,
        "encrypted_members_skipped": 0,
        "unsupported_compression_members_skipped": 0,
        "members_failed": 0,
        "files_extracted": 1,
        "directories_created": 0,
        "extracted_bytes": len(b"contents"),
        "files_replaced": 0,
    }
    operation = client.get(f"/api/archive/v2/operations/{prepared['id']}", headers=auth_headers_user).json()
    assert json.loads(operation["checkpoint_json"])["aggregate_counters"] == completed.json()["aggregate_counters"]
    backend.open_archive_source_reader.assert_awaited_once_with("input.zip")
    backend.open_random_access_reader.assert_not_awaited()
