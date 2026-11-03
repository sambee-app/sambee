from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import Index, UniqueConstraint
from sqlmodel import Field, SQLModel


class RecentDirectory(SQLModel, table=True):
    """A per-user record of a successfully visited non-root directory."""

    __table_args__ = (
        UniqueConstraint("user_id", "connection_id", "path", name="uq_recentdirectory_user_connection_path"),
        Index("ix_recentdirectory_user_last_visited", "user_id", "last_visited_at"),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    user_id: uuid.UUID = Field(foreign_key="user.id", index=True)
    # Local drives use the synthetic `local-drive:*` ID, so this cannot be a foreign key.
    connection_id: str = Field(index=True, max_length=256)
    path: str = Field(max_length=4096)
    last_visited_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    usage_score: float = Field(default=1.0, ge=0)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class RecentDirectoryRecordRequest(SQLModel):
    connection_id: str = Field(min_length=1, max_length=256)
    path: str = Field(min_length=1, max_length=4096)
    is_directory: Literal[True]


class RecentDirectoryRead(SQLModel):
    id: uuid.UUID
    connection_id: str
    path: str
    last_visited_at: datetime
    usage_score: float = 0
    match_rank: int = 3
    matched_term_count: int = 0


class RecentDirectorySearchRead(SQLModel):
    results: list[RecentDirectoryRead]
    result_limit: int
    search_contract_version: int = 1


class RecentDirectoryClearRead(SQLModel):
    deleted_count: int
