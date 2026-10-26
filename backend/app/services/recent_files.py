from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import PurePosixPath

from fastapi import HTTPException, status
from sqlmodel import Session, col, select

from app.models.recent_file import RecentFile, RecentFileRead
from app.models.user import User
from app.services.history_common import (
    history_match_rank,
    history_usage_score,
    normalize_history_search_text,
    normalize_recent_history_path,
    updated_history_usage_score,
    validate_history_connection_access,
)
from app.services.system_settings import get_file_search_settings

MAX_RECENT_FILE_RESULTS = 50
IMAGE_EXTENSIONS = frozenset(
    {
        ".ai",
        ".apng",
        ".avif",
        ".bmp",
        ".dds",
        ".dng",
        ".eps",
        ".gif",
        ".heic",
        ".heif",
        ".ico",
        ".jfif",
        ".jp2",
        ".jpeg",
        ".jpg",
        ".jxl",
        ".png",
        ".psb",
        ".psd",
        ".svg",
        ".tga",
        ".tif",
        ".tiff",
        ".webp",
    }
)
TEMPORARY_BACKUP_EXTENSIONS = frozenset({".bak", ".tmp", ".temp", ".swp", ".swo", ".swx", ".old", ".orig", ".rej", ".part", ".crdownload"})


def _normalize_for_matching(value: str) -> str:
    return normalize_history_search_text(value)


def normalize_recent_file_path(path: str) -> str:
    """Return a canonical safe relative path for a recent-file record."""

    return normalize_recent_history_path(path)


def _is_temporary_or_backup(file_name: str) -> bool:
    normalized = file_name.casefold()
    return (
        normalized.startswith("~$")
        or normalized.startswith(".#")
        or normalized.endswith("~")
        or PurePosixPath(normalized).suffix in TEMPORARY_BACKUP_EXTENSIONS
    )


def _is_image(file_name: str) -> bool:
    return PurePosixPath(file_name.casefold()).suffix in IMAGE_EXTENSIONS


def _is_excluded(file_name: str, session: Session) -> bool:
    settings = get_file_search_settings(session)
    extension = PurePosixPath(file_name.casefold()).suffix
    return (
        ("images" in settings.excluded_categories and _is_image(file_name))
        or ("temporary_backup" in settings.excluded_categories and _is_temporary_or_backup(file_name))
        or extension in settings.excluded_extensions
    )


def should_record_recent_file(*, connection_id: str, path: str, is_regular_file: bool, current_user: User, session: Session) -> bool:
    """Validate history metadata and return whether retention policy permits recording it."""

    if not is_regular_file:
        raise ValueError("Only regular files can be recorded in recent-file history")
    normalized_path = normalize_recent_file_path(path)
    validate_history_connection_access(connection_id=connection_id, current_user=current_user, session=session)
    file_name = PurePosixPath(normalized_path).name
    settings = get_file_search_settings(session)
    return settings.retention_limit > 0 and not _is_excluded(file_name, session)


def _trim_user_recent_files(*, user_id: uuid.UUID, retention_limit: int, session: Session) -> int:
    records = session.exec(
        select(RecentFile)
        .where(RecentFile.user_id == user_id)
        .order_by(col(RecentFile.last_opened_at).desc(), col(RecentFile.created_at).desc(), col(RecentFile.id).desc())
    ).all()
    for record in records[retention_limit:]:
        session.delete(record)
    return max(0, len(records) - retention_limit)


def trim_all_recent_files(*, retention_limit: int, session: Session) -> int:
    """Trim all user histories after an administrator lowers retention."""

    user_ids = session.exec(select(RecentFile.user_id).distinct()).all()
    deleted_count = sum(_trim_user_recent_files(user_id=user_id, retention_limit=retention_limit, session=session) for user_id in user_ids)
    return deleted_count


def record_recent_file(
    *, connection_id: str, path: str, is_regular_file: bool, current_user: User, session: Session
) -> RecentFileRead | None:
    should_record = should_record_recent_file(
        connection_id=connection_id,
        path=path,
        is_regular_file=is_regular_file,
        current_user=current_user,
        session=session,
    )
    normalized_path = normalize_recent_file_path(path)
    file_name = PurePosixPath(normalized_path).name
    if not should_record:
        return None

    settings = get_file_search_settings(session)

    statement = (
        select(RecentFile)
        .where(RecentFile.user_id == current_user.id)
        .where(RecentFile.connection_id == connection_id)
        .where(RecentFile.path == normalized_path)
    )
    record = session.exec(statement).first()
    now = datetime.now(timezone.utc)
    if record is None:
        record = RecentFile(
            user_id=current_user.id, connection_id=connection_id, path=normalized_path, file_name=file_name, last_opened_at=now
        )
    else:
        record.file_name = file_name
        record.usage_score = updated_history_usage_score(record.usage_score, record.last_opened_at, now)
        record.last_opened_at = now
    session.add(record)
    _trim_user_recent_files(user_id=current_user.id, retention_limit=settings.retention_limit, session=session)
    session.commit()
    session.refresh(record)
    return RecentFileRead.model_validate(record)


def search_recent_files(*, query: str, limit: int, current_user: User, session: Session) -> list[RecentFileRead]:
    bounded_limit = get_recent_file_result_limit(limit=limit, session=session)
    normalized_query = _normalize_for_matching(query.strip())
    records = session.exec(
        select(RecentFile).where(RecentFile.user_id == current_user.id).order_by(col(RecentFile.last_opened_at).desc())
    ).all()
    matched: list[tuple[int, RecentFile]] = []
    for record in records:
        rank = history_match_rank(_normalize_for_matching(record.file_name), normalized_query)
        if rank is not None:
            matched.append((rank, record))
    now = datetime.now(timezone.utc)
    matched.sort(
        key=lambda result: (
            result[0],
            -history_usage_score(result[1].usage_score, result[1].last_opened_at, now),
            -result[1].last_opened_at.timestamp(),
            str(result[1].id),
        )
    )
    return [
        RecentFileRead.model_validate(record).model_copy(
            update={"match_rank": rank, "usage_score": history_usage_score(record.usage_score, record.last_opened_at, now)}
        )
        for rank, record in matched[:bounded_limit]
    ]


def get_recent_file_result_limit(*, limit: int, session: Session) -> int:
    """Clamp a client request to the administrator's per-group result policy."""

    return max(1, min(limit, MAX_RECENT_FILE_RESULTS, get_file_search_settings(session).result_limit))


def remove_recent_file(*, record_id: uuid.UUID, current_user: User, session: Session) -> None:
    record = get_recent_file(record_id=record_id, current_user=current_user, session=session)
    session.delete(record)
    session.commit()


def get_recent_file(*, record_id: uuid.UUID, current_user: User, session: Session) -> RecentFile:
    """Return a history record only when it belongs to the authenticated user."""

    record = session.get(RecentFile, record_id)
    if record is None or record.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recent file not found")
    return record


def clear_recent_files(*, current_user: User, session: Session) -> int:
    records = session.exec(select(RecentFile).where(RecentFile.user_id == current_user.id)).all()
    for record in records:
        session.delete(record)
    session.commit()
    return len(records)
