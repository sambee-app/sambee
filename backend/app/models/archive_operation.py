"""Durable, scoped state for archive creation and extraction workflows."""

import json
import uuid
from datetime import datetime, timezone
from enum import StrEnum
from typing import Literal

from pydantic import StrictInt, computed_field, field_serializer, model_validator
from sqlalchemy import CheckConstraint
from sqlmodel import Field, SQLModel
from sqlmodel._compat import SQLModelConfig


class ArchiveContractVersion(StrEnum):
    """Archive wire-contract versions accepted by this release."""

    V2 = "v2"


class ArchiveOperationKind(StrEnum):
    CREATE = "create"
    EXTRACT = "extract"


class ArchiveOperationPhase(StrEnum):
    PREPARED = "prepared"
    ACCEPTED = "accepted"
    STREAMING = "streaming"
    AWAITING_USER_DECISION = "awaiting_user_decision"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


class ArchiveOperationErrorCode(StrEnum):
    """Stable machine-readable V2 archive operation error codes."""

    INVALID_MANIFEST = "invalid_manifest"
    INVALID_CHECKPOINT = "invalid_checkpoint"
    INVALID_CONTRACT_VERSION = "invalid_contract_version"
    INVALID_MEMBER_PATH = "invalid_member_path"
    COLLISION = "collision"
    PARTIAL_OUTPUT = "partial_output"
    SOURCE_CHANGED = "source_changed"
    TRANSPORT_FAILURE = "transport_failure"
    CANCELLED = "cancelled"
    IDEMPOTENCY_CONFLICT = "idempotency_conflict"
    CAPABILITY_INVALID = "capability_invalid"
    CAPABILITY_VERSION_MISMATCH = "capability_version_mismatch"
    INVALID_REQUEST = "invalid_request"
    AUTHENTICATION_INVALID = "authentication_invalid"
    AUTHORIZATION_DENIED = "authorization_denied"
    NOT_FOUND = "not_found"
    INVALID_OPERATION_STATE = "invalid_operation_state"
    OPERATION_UNAVAILABLE = "operation_unavailable"


TERMINAL_ARCHIVE_OPERATION_PHASES = frozenset(
    {ArchiveOperationPhase.COMPLETED, ArchiveOperationPhase.CANCELLED, ArchiveOperationPhase.FAILED}
)

ARCHIVE_OPERATION_HEARTBEAT_TIMEOUT_SECONDS = 120
ARCHIVE_OPERATION_ORPHAN_CHECK_INTERVAL_SECONDS = 30


class ArchiveOperation(SQLModel, table=True):
    """State that lets direct archive output report progress after a request ends."""

    __tablename__ = "archive_operations"
    __table_args__ = (CheckConstraint("contract_version = 'V2'", name="ck_archive_operations_contract_version_v2"),)

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: uuid.UUID = Field(foreign_key="user.id", index=True)
    contract_version: ArchiveContractVersion = Field(default=ArchiveContractVersion.V2, index=True)
    kind: ArchiveOperationKind = Field(index=True)
    phase: ArchiveOperationPhase = Field(default=ArchiveOperationPhase.PREPARED, index=True)
    source_connection_id: str = Field(default="", index=True)
    source_path: str = Field(default="")
    destination_connection_id: str = Field(default="", index=True)
    destination_path: str = Field(default="")
    manifest_hash: str = Field(default="", index=True)
    revision: int = Field(default=0, ge=0)
    plan_json: str = Field(default="{}")
    selected_member_paths_json: str | None = Field(default=None)
    checkpoint_json: str | None = Field(default=None)
    pending_decision_json: str | None = Field(default=None)
    collision_policy: str | None = Field(default=None)
    cancellation_requested: bool = Field(default=False, index=True)
    last_error_json: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    heartbeat_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


class ArchiveV2Payload(SQLModel):
    """Strict V2 request model base; V2 never discards unknown wire fields."""

    model_config = SQLModelConfig(extra="forbid")


class ArchiveOperationPrepare(ArchiveV2Payload):
    contract_version: ArchiveContractVersion
    kind: ArchiveOperationKind
    source_connection_id: str
    source_path: str
    destination_connection_id: str
    destination_path: str
    manifest_hash: str = ""
    plan_json: str = "{}"
    selected_member_paths: list[str] | None = None


class ArchiveOperationError(SQLModel):
    """A typed terminal failure projected from durable operation state."""

    code: ArchiveOperationErrorCode
    message: str = Field(min_length=1, max_length=500)


class ArchiveOperationRead(SQLModel):
    id: uuid.UUID
    contract_version: ArchiveContractVersion
    kind: ArchiveOperationKind
    phase: ArchiveOperationPhase
    source_connection_id: str
    source_path: str
    destination_connection_id: str
    destination_path: str
    manifest_hash: str
    revision: int
    checkpoint_json: str | None
    pending_decision_json: str | None
    collision_policy: str | None
    cancellation_requested: bool
    last_error_json: str | None
    created_at: datetime
    updated_at: datetime
    heartbeat_at: datetime

    @computed_field
    def last_error(self) -> ArchiveOperationError | None:
        """Decode persisted errors defensively without exposing undocumented codes."""

        if self.last_error_json is None:
            return None
        try:
            value = json.loads(self.last_error_json)
            return ArchiveOperationError.model_validate(value)
        except (json.JSONDecodeError, ValueError):
            return ArchiveOperationError(
                code=ArchiveOperationErrorCode.INVALID_OPERATION_STATE,
                message="Archive operation error state is invalid",
            )

    @field_serializer("created_at", "updated_at", "heartbeat_at", when_used="json")
    def serialize_v2_timestamp(self, value: datetime) -> str:
        timestamp = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
        return timestamp.isoformat().replace("+00:00", "Z")


class ArchiveOperationTransition(ArchiveV2Payload):
    expected_phase: ArchiveOperationPhase
    next_phase: ArchiveOperationPhase
    expected_revision: int | None = Field(default=None, ge=0)


class ArchiveCompanionSession(SQLModel):
    """Short-lived backend capability handed to the paired Companion executor."""

    token: str
    expires_in: int
    operation: ArchiveOperationRead
    selected_member_paths: list[str] | None = None


class ArchiveCompanionFailure(ArchiveV2Payload):
    """A bounded executor failure description safe to persist on an operation."""

    message: str = Field(min_length=1, max_length=500)


class ArchiveCompanionCreationManifestEntry(ArchiveV2Payload):
    """One validated SMB source item that Companion may add to a local ZIP."""

    source_path: str
    archive_path: str
    is_directory: bool
    source_size: int = Field(ge=0)
    modified_at: datetime | None = None


class ArchiveCompanionCreationManifest(SQLModel):
    """Complete portable ZIP creation manifest for a local Companion executor."""

    operation: ArchiveOperationRead
    entries: list[ArchiveCompanionCreationManifestEntry]


class ArchiveCompanionCreationSourceManifestEntry(ArchiveV2Payload):
    """One validated local source member to be committed by the SMB ZIP writer."""

    archive_path: str = Field(min_length=1)
    is_directory: bool
    source_size: int = Field(ge=0)
    modified_at: datetime | None = None


class ArchiveCompanionCreationSourceManifest(ArchiveV2Payload):
    """Complete local-source manifest for a member-framed SMB ZIP relay."""

    entries: list[ArchiveCompanionCreationSourceManifestEntry]


class ArchiveCompanionCreationSummary(ArchiveV2Payload):
    """Counts reported by the paired Companion after writing a local ZIP."""

    files_created: int = Field(ge=0)
    directories_created: int = Field(ge=0)
    source_bytes: int = Field(ge=0)


class ArchiveCompanionCreationMemberCompletion(ArchiveV2Payload):
    """One local ZIP member durably committed from the validated SMB manifest."""

    archive_path: str = Field(min_length=1)
    status: Literal["directory", "created"]
    source_bytes: int = Field(ge=0)


class ArchiveExtractionDecision(ArchiveV2Payload):
    action: Literal["skip", "skip_all", "replace", "replace_all", "replace_older", "rename", "retry", "ignore", "cancel"]
    member_path: str | None = None
    target_path: str | None = None
    expected_revision: int | None = Field(default=None, ge=0)
    source_session_id: str | None = Field(default=None, min_length=1, max_length=64)
    delivery_sequence: int | None = Field(default=None, ge=1)
    decision_revision: int | None = Field(default=None, ge=1)


class ArchiveExtractionConflictItem(ArchiveV2Payload):
    path: str = Field(min_length=1)
    size: int | None = Field(default=None, ge=0)
    modified_at: datetime | None = None


class ArchiveLiveExtractionPendingDecisionBase(ArchiveV2Payload):
    revision: int = Field(ge=1)
    member_path: str
    delivery_sequence: int = Field(ge=1)
    is_directory: bool


class ArchiveLiveExtractionCollisionPendingDecision(ArchiveLiveExtractionPendingDecisionBase):
    kind: Literal["collision"]
    allowed_actions: list[Literal["skip", "skip_all", "replace", "replace_all", "replace_older", "rename"]]
    source: ArchiveExtractionConflictItem
    target: ArchiveExtractionConflictItem


class ArchiveLiveExtractionMemberErrorPendingDecision(ArchiveLiveExtractionPendingDecisionBase):
    kind: Literal["member_error"]
    allowed_actions: list[Literal["retry", "ignore"]]
    target_path: str | None = None
    message: str | None = None


ArchiveLiveExtractionPendingDecision = ArchiveLiveExtractionCollisionPendingDecision | ArchiveLiveExtractionMemberErrorPendingDecision


class ArchiveExtractionAggregate(ArchiveV2Payload):
    """Exact checked aggregate counters exposed by every S1 extraction status."""

    members_processed: StrictInt = Field(ge=0, lt=1 << 63)
    members_completed: StrictInt = Field(ge=0, lt=1 << 63)
    members_skipped: StrictInt = Field(ge=0, lt=1 << 63)
    encrypted_members_skipped: StrictInt = Field(default=0, ge=0, lt=1 << 63)
    unsupported_compression_members_skipped: StrictInt = Field(default=0, ge=0, lt=1 << 63)
    members_failed: StrictInt = Field(ge=0, lt=1 << 63)
    files_extracted: StrictInt = Field(ge=0, lt=1 << 63)
    directories_created: StrictInt = Field(ge=0, lt=1 << 63)
    extracted_bytes: StrictInt = Field(ge=0, lt=1 << 63)
    files_replaced: StrictInt = Field(ge=0, lt=1 << 63)

    @model_validator(mode="after")
    def _validate_member_outcomes(self) -> "ArchiveExtractionAggregate":
        if self.members_processed != self.members_completed + self.members_skipped + self.members_failed:
            raise ValueError("Archive aggregate member counters are invalid")
        if self.encrypted_members_skipped + self.unsupported_compression_members_skipped > self.members_skipped:
            raise ValueError("Archive skipped member reason counters exceed the skipped total")
        return self


class ArchiveLiveExtractionStatus(ArchiveV2Payload):
    source_session_id: str
    phase: Literal[
        "ready",
        "current",
        "streaming_current",
        "awaiting_result",
        "awaiting_decision",
        "completed",
        "failed",
        "cancelled",
    ]
    aggregate_counters: ArchiveExtractionAggregate
    pending_decision: ArchiveLiveExtractionPendingDecision | None = None


class ArchiveCompanionLiveExtractionBegin(ArchiveV2Payload):
    operation: ArchiveOperationRead
    source_session_id: str


class ArchiveCompanionLiveExtractionMember(ArchiveV2Payload):
    source_session_id: str
    delivery_sequence: int = Field(ge=1)
    member_path: str
    is_directory: bool
    uncompressed_size: int = Field(ge=0)
    modified_at: datetime | None = None
    target_path: str | None = Field(default=None, min_length=1)
    collision_policy: Literal["ask", "skip", "skip_all", "replace", "replace_all", "replace_older", "rename"] | None = None


class ArchiveCompanionLiveDestinationWriteResult(ArchiveV2Payload):
    source_session_id: str = Field(min_length=1, max_length=64)
    delivery_sequence: int = Field(ge=1)
    member_path: str = Field(min_length=1)
    status: Literal["directory", "extracted", "skipped", "ignored", "awaiting_collision", "awaiting_retry", "fatal"]
    extracted_bytes: int = Field(default=0, ge=0)
    directories_created: int = Field(default=0, ge=0)
    replaced: bool = False
    target_path: str | None = Field(default=None, min_length=1)
    message: str | None = Field(default=None, min_length=1, max_length=500)
    target_size: int | None = Field(default=None, ge=0)
    target_modified_at: datetime | None = None


class ArchiveCompanionLiveDestinationWriteRequest(ArchiveV2Payload):
    """One transient write request from a Companion-held live ZIP source."""

    source_session_id: str = Field(min_length=1, max_length=64)
    delivery_sequence: int = Field(ge=1)
    member_path: str = Field(min_length=1)
    target_path: str | None = Field(default=None, min_length=1)
    is_directory: bool
    modified_at: datetime | None = None
    collision_policy: Literal["ask", "skip", "skip_all", "replace", "replace_all", "replace_older", "rename"] | None = None


class ArchiveCompanionLiveExtractionSummary(ArchiveV2Payload):
    """Aggregate-only terminal state supplied by a Companion-held ZIP source."""

    source_session_id: str = Field(min_length=1, max_length=64)
    members_processed: StrictInt = Field(ge=0, lt=1 << 63)
    members_completed: StrictInt = Field(ge=0, lt=1 << 63)
    members_skipped: StrictInt = Field(ge=0, lt=1 << 63)
    encrypted_members_skipped: StrictInt = Field(default=0, ge=0, lt=1 << 63)
    unsupported_compression_members_skipped: StrictInt = Field(default=0, ge=0, lt=1 << 63)
    members_failed: StrictInt = Field(ge=0, lt=1 << 63)
    files_extracted: StrictInt = Field(ge=0, lt=1 << 63)
    directories_created: StrictInt = Field(ge=0, lt=1 << 63)
    extracted_bytes: StrictInt = Field(ge=0, lt=1 << 63)
    files_replaced: StrictInt = Field(ge=0, lt=1 << 63)

    @model_validator(mode="after")
    def _validate_member_outcomes(self) -> "ArchiveCompanionLiveExtractionSummary":
        if self.members_processed != self.members_completed + self.members_skipped + self.members_failed:
            raise ValueError("Archive aggregate member counters are invalid")
        if self.encrypted_members_skipped + self.unsupported_compression_members_skipped > self.members_skipped:
            raise ValueError("Archive skipped member reason counters exceed the skipped total")
        return self


class ArchiveCompanionLiveDestinationDecision(ArchiveV2Payload):
    """One fenced decision that a Companion-held live source will validate and apply."""

    source_session_id: str = Field(min_length=1, max_length=64)
    delivery_sequence: int = Field(ge=1)
    decision_revision: int = Field(ge=1)
    action: Literal["skip", "skip_all", "replace", "replace_all", "replace_older", "rename", "retry", "ignore", "cancel"]
    member_path: str = Field(min_length=1)
    target_path: str | None = Field(default=None, min_length=1)
