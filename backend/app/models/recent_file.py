from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import Index, UniqueConstraint
from sqlmodel import Field, SQLModel


class RecentFile(SQLModel, table=True):
    """A per-user record of a browser-initiated file open attempt."""

    __table_args__ = (
        UniqueConstraint("user_id", "connection_id", "path", name="uq_recentfile_user_connection_path"),
        Index("ix_recentfile_user_last_opened", "user_id", "last_opened_at"),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: uuid.UUID = Field(foreign_key="user.id", index=True)
    # Local drives use the synthetic `local-drive:*` ID, so this cannot be a foreign key.
    connection_id: str = Field(index=True, max_length=256)
    path: str = Field(max_length=4096)
    file_name: str = Field(max_length=1024)
    last_opened_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    usage_score: float = Field(default=1.0, ge=0)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class RecentFileRecordRequest(SQLModel):
    connection_id: str = Field(min_length=1, max_length=256)
    path: str = Field(min_length=1, max_length=4096)
    is_regular_file: Literal[True]


class RecentFileRead(SQLModel):
    id: uuid.UUID
    connection_id: str
    path: str
    file_name: str
    last_opened_at: datetime
    usage_score: float = 0
    match_rank: int = 3


class RecentFileSearchRead(SQLModel):
    results: list[RecentFileRead]
    result_limit: int


class RecentFileClearRead(SQLModel):
    deleted_count: int


RecentFileValidationCode = Literal[
    "recent_file_target_missing",
    "recent_file_target_not_file",
    "recent_file_native_launch_failed",
    "recent_file_invalid_path",
    "recent_file_connection_removed",
    "recent_file_access_denied",
    "recent_file_validation_transient",
]


class RecentFileValidationError(SQLModel):
    code: RecentFileValidationCode
    message: str
