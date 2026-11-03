from __future__ import annotations

import heapq
import uuid
from datetime import datetime, timezone
from typing import Iterator

from fastapi import HTTPException, status
from sqlmodel import Session, col, select

from app.models.recent_directory import RecentDirectory, RecentDirectoryRead
from app.models.user import User
from app.services.directory_index import search_terms
from app.services.history_common import (
    HISTORY_QUERY_BATCH_SIZE,
    LOCAL_DRIVE_PREFIX,
    history_search_relevance,
    history_usage_score,
    normalize_history_search_text,
    normalize_recent_history_path,
    updated_history_usage_score,
    validate_history_connection_access,
)
from app.services.system_settings import get_file_search_settings

MAX_RECENT_DIRECTORY_RESULTS = 50


def normalize_recent_directory_path(path: str) -> str:
    """Return a canonical safe relative path for a recent-directory record."""

    return normalize_recent_history_path(path)


def _trim_user_recent_directories(*, user_id: uuid.UUID, session: Session, retention_limit: int) -> None:
    records = session.exec(
        select(RecentDirectory)
        .where(RecentDirectory.user_id == user_id)
        .order_by(col(RecentDirectory.last_visited_at).desc(), col(RecentDirectory.created_at).desc(), col(RecentDirectory.id).desc())
    ).all()
    for record in records[retention_limit:]:
        session.delete(record)


def trim_all_recent_directories(*, retention_limit: int, session: Session) -> None:
    """Apply a reduced retention policy to every user's directory history."""
    for user_id in session.exec(select(RecentDirectory.user_id).distinct()).all():
        _trim_user_recent_directories(user_id=user_id, session=session, retention_limit=retention_limit)


def record_recent_directory(*, connection_id: str, path: str, current_user: User, session: Session) -> RecentDirectoryRead | None:
    """Upsert one successfully visited directory after validating access."""

    normalized_path = normalize_recent_directory_path(path)
    validate_history_connection_access(connection_id=connection_id, current_user=current_user, session=session)
    retention_limit = get_file_search_settings(session).retention_limit
    if retention_limit == 0:
        return None

    statement = (
        select(RecentDirectory)
        .where(RecentDirectory.user_id == current_user.id)
        .where(RecentDirectory.connection_id == connection_id)
        .where(RecentDirectory.path == normalized_path)
    )
    record = session.exec(statement).first()
    now = datetime.now(timezone.utc)
    if record is None:
        record = RecentDirectory(user_id=current_user.id, connection_id=connection_id, path=normalized_path, last_visited_at=now)
    else:
        record.usage_score = updated_history_usage_score(record.usage_score, record.last_visited_at, now)
        record.last_visited_at = now

    session.add(record)
    _trim_user_recent_directories(user_id=current_user.id, session=session, retention_limit=retention_limit)
    session.commit()
    session.refresh(record)
    return RecentDirectoryRead.model_validate(record)


def _is_accessible_history_record(*, record: RecentDirectory, current_user: User, session: Session) -> bool:
    if record.connection_id.startswith(LOCAL_DRIVE_PREFIX):
        return True

    try:
        validate_history_connection_access(connection_id=record.connection_id, current_user=current_user, session=session)
    except (HTTPException, ValueError):
        return False
    return True


def search_recent_directories(*, query: str, limit: int, current_user: User, session: Session) -> list[RecentDirectoryRead]:
    bounded_limit = max(1, min(limit, MAX_RECENT_DIRECTORY_RESULTS, get_file_search_settings(session).result_limit))
    terms = search_terms(query)
    records = session.exec(
        select(RecentDirectory).where(RecentDirectory.user_id == current_user.id).execution_options(yield_per=HISTORY_QUERY_BATCH_SIZE)
    )

    now = datetime.now(timezone.utc)

    def matches() -> Iterator[tuple[int, int, RecentDirectory]]:
        try:
            for record in records:
                relevance = history_search_relevance(
                    normalize_history_search_text(record.path), normalize_history_search_text(record.path.rsplit("/", 1)[-1]), terms
                )
                if relevance is not None and _is_accessible_history_record(record=record, current_user=current_user, session=session):
                    yield *relevance, record
        finally:
            records.close()

    matched = heapq.nsmallest(
        bounded_limit,
        matches(),
        key=lambda result: (
            -result[0],
            result[1],
            -history_usage_score(result[2].usage_score, result[2].last_visited_at, now),
            -result[2].last_visited_at.replace(tzinfo=timezone.utc).timestamp(),
            normalize_history_search_text(result[2].path),
            result[2].path,
            result[2].connection_id,
            str(result[2].id),
        ),
    )
    return [
        RecentDirectoryRead.model_validate(record).model_copy(
            update={
                "matched_term_count": count,
                "match_rank": rank,
                "usage_score": history_usage_score(record.usage_score, record.last_visited_at, now),
            }
        )
        for count, rank, record in matched
    ]


def get_recent_directory(*, record_id: uuid.UUID, current_user: User, session: Session) -> RecentDirectory:
    record = session.get(RecentDirectory, record_id)
    if record is None or record.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recent directory not found")
    return record


def remove_recent_directory(*, record_id: uuid.UUID, current_user: User, session: Session) -> None:
    record = get_recent_directory(record_id=record_id, current_user=current_user, session=session)
    session.delete(record)
    session.commit()


def clear_recent_directories(*, current_user: User, session: Session) -> int:
    records = session.exec(select(RecentDirectory).where(RecentDirectory.user_id == current_user.id)).all()
    for record in records:
        session.delete(record)
    session.commit()
    return len(records)
