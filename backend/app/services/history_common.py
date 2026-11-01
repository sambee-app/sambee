from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import PurePosixPath

from sqlmodel import Session

from app.models.user import User
from app.services.connection_access import get_accessible_connection_or_404
from app.services.directory_index import normalize_search_text, single_term_rank

LOCAL_DRIVE_PREFIX = "local-drive:"
HISTORY_SCORE_HALF_LIFE_SECONDS = 30 * 24 * 60 * 60
HISTORY_REPEAT_INTERVAL_SECONDS = 60
HISTORY_SUBSTRING_MATCH_RANK = 3
HISTORY_QUERY_BATCH_SIZE = 256
SEARCH_CONTRACT_VERSION = 1


def history_usage_score(score: float, last_used: datetime, now: datetime) -> float:
    """Decay frequency over thirty days, including SQLite's naive UTC dates."""
    elapsed = max(0.0, (now - last_used.replace(tzinfo=timezone.utc)).total_seconds())
    return score * 2 ** (-elapsed / HISTORY_SCORE_HALF_LIFE_SECONDS)


def updated_history_usage_score(score: float, last_used: datetime, now: datetime) -> float:
    """Do not count rapid duplicate events as additional use."""
    elapsed = (now - last_used.replace(tzinfo=timezone.utc)).total_seconds()
    return history_usage_score(score, last_used, now) + (1 if elapsed >= HISTORY_REPEAT_INTERVAL_SECONDS else 0)


def normalize_history_search_text(value: str) -> str:
    return normalize_search_text(value)


def history_search_relevance(field_key: str, basename_key: str, terms: tuple[str, ...]) -> tuple[int, int] | None:
    if not terms:
        return 0, HISTORY_SUBSTRING_MATCH_RANK
    matched = tuple(term for term in terms if term in field_key)
    if not matched:
        return None
    return len(matched), min(single_term_rank(basename_key, term) for term in matched)


def history_match_rank(normalized_name: str, normalized_query: str) -> int | None:
    """Rank an exact name, prefix, word boundary, then substring match."""
    if not normalized_query:
        return 3
    if normalized_name == normalized_query:
        return 0
    if normalized_name.startswith(normalized_query):
        return 1
    for index, character in enumerate(normalized_name):
        if index > 0 and not character.isalnum() and normalized_name[index + 1 :].startswith(normalized_query):
            return 2
    return 3 if normalized_query in normalized_name else None


def directory_match_rank(path: str, normalized_query: str) -> int:
    """Rank a directory basename, with parent-path matches in the substring tier."""
    rank = history_match_rank(normalize_history_search_text(path.rsplit("/", 1)[-1]), normalized_query)
    return HISTORY_SUBSTRING_MATCH_RANK if rank is None else rank


def normalize_recent_history_path(path: str) -> str:
    """Return a canonical safe relative path for a recent-history record."""

    normalized = path.replace("\\", "/").strip()
    if not normalized or normalized.startswith("/"):
        raise ValueError("History path must be a non-empty relative path")

    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("History path must not contain empty, current-directory, or parent-directory segments")

    canonical = str(PurePosixPath(*parts))
    if canonical in {"", "."}:
        raise ValueError("History path must identify an item")
    return canonical


def validate_history_connection_access(*, connection_id: str, current_user: User, session: Session) -> None:
    if connection_id.startswith(LOCAL_DRIVE_PREFIX):
        if len(connection_id) == len(LOCAL_DRIVE_PREFIX):
            raise ValueError("Local drive ID cannot be empty")
        return

    try:
        parsed_connection_id = uuid.UUID(connection_id)
    except ValueError as exc:
        raise ValueError("Connection ID must be a connection UUID or local-drive ID") from exc
    get_accessible_connection_or_404(session, current_user, parsed_connection_id)
