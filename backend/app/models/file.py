from datetime import datetime
from enum import StrEnum
from typing import List, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class FileType(StrEnum):
    FILE = "file"
    DIRECTORY = "directory"


class FileInfo(BaseModel):
    name: str
    path: str
    type: FileType
    size: Optional[int] = None
    mime_type: Optional[str] = None
    created_at: Optional[datetime] = None
    modified_at: Optional[datetime] = None
    stable_id: Optional[str] = None
    is_readable: bool = True
    is_hidden: bool = False


class DirectoryListing(BaseModel):
    path: str
    items: List[FileInfo]
    total: int


class RenameRequest(BaseModel):
    """Request model for renaming a file or directory."""

    path: str
    new_name: str


class CreateItemRequest(BaseModel):
    """Request model for creating a new file or directory."""

    parent_path: str
    name: str
    type: FileType


class CopyMoveRequest(BaseModel):
    """Request model for copying or moving a file or directory.

    ``source_path`` is relative to the source connection's share.
    ``dest_path`` is relative to the destination connection's share
    (or the same connection when ``dest_connection_id`` is omitted).

    ``target_resolution_policy`` is the authoritative file collision policy.
    The legacy ``overwrite`` field is accepted only while clients migrate and
    is normalized at the API boundary.
    """

    source_path: str
    dest_path: str
    dest_connection_id: Optional[str] = None
    target_resolution_policy: Literal["ask", "skip", "replace", "replace_older"] | None = None
    overwrite: bool | None = None
    # Each executed plan needs a caller-supplied key so a transport retry can
    # retrieve its factual result instead of starting a new mutation.
    idempotency_key: str
    # Ephemeral identifier for cooperative cancellation of an active request.
    transfer_attempt_id: Optional[UUID] = None

    @model_validator(mode="after")
    def validate_resolution_policy(self) -> "CopyMoveRequest":
        if self.target_resolution_policy is not None and self.overwrite is not None:
            expected_legacy_value = self.target_resolution_policy == "replace"
            if self.overwrite != expected_legacy_value:
                raise ValueError("overwrite conflicts with target_resolution_policy")
        if self.idempotency_key is not None:
            try:
                UUID(self.idempotency_key)
            except ValueError as exc:
                raise ValueError("idempotency_key must be a UUID") from exc
        return self

    @property
    def normalized_target_resolution_policy(self) -> str:
        if self.target_resolution_policy is not None:
            return self.target_resolution_policy
        return "replace" if self.overwrite else "ask"


class ConflictInfo(BaseModel):
    """Metadata about an existing file that blocks a copy/move.

    Returned in 409 responses so the frontend can display a meaningful
    overwrite-confirmation dialog (file sizes, dates, etc.).
    """

    existing_file: FileInfo
    incoming_file: FileInfo


class ContentTransferEffects(BaseModel):
    """Factual mutations made by a copy or move request."""

    source: Literal["unchanged", "mutated", "unknown"]
    destination: Literal["unchanged", "mutated", "unknown"]


class ContentTransferError(BaseModel):
    """A stable failure detail for a factual transfer result."""

    code: Literal["conflict", "source_changed", "source_delete_failed", "transport", "unavailable"]
    detail: str


class ContentTransferResult(BaseModel):
    """Outcome returned by a regular-file copy or move operation."""

    status: Literal["completed", "skipped", "completed_with_source_retained", "outcome_unknown", "failed", "cancelled"]
    effects: ContentTransferEffects
    replaced: bool = False
    error: ContentTransferError | None = None

    @model_validator(mode="after")
    def validate_factual_outcome(self) -> "ContentTransferResult":
        if self.status in {"completed", "skipped", "outcome_unknown", "cancelled"} and self.error is not None:
            raise ValueError(f"{self.status} transfer outcomes cannot include an error")
        if self.status in {"completed_with_source_retained", "failed"} and self.error is None:
            raise ValueError(f"{self.status} transfer outcomes require an error")
        if self.status == "skipped" and (self.effects.source != "unchanged" or self.effects.destination != "unchanged" or self.replaced):
            raise ValueError("skipped transfer outcomes must leave both paths unchanged")
        if (
            self.status == "outcome_unknown"
            and "unknown" not in (self.effects.source, self.effects.destination)
            and "mutated" not in (self.effects.source, self.effects.destination)
        ):
            raise ValueError("unknown transfer outcomes require uncertain effects or confirmed aggregate mutations")
        if self.status == "completed_with_source_retained" and (self.effects.source == "unknown" or self.effects.destination == "unknown"):
            raise ValueError("source-retained outcomes require known effects")
        if self.replaced and self.effects.destination != "mutated":
            raise ValueError("replacement requires confirmed destination mutation")
        return self


class DirectorySearchResult(BaseModel):
    """Response model for directory search (quick navigate)."""

    results: List[str]
    match_ranks: dict[str, int] = Field(default_factory=dict)
    matched_term_counts: dict[str, int] = Field(default_factory=dict)
    total_matches: int
    cache_state: str
    directory_count: int
    accepted_revision: int | None = Field(default=None, ge=0)
    coverage: str | None = None
    coverage_issue_count: int = Field(default=0, ge=0)
    last_verified_at_ms: int | None = Field(default=None, ge=0)
    status_message: str | None = None
