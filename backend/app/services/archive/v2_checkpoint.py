"""Strict V2 extraction checkpoint envelope validation."""

from __future__ import annotations

import re
from copy import deepcopy
from datetime import datetime, timezone
from uuid import UUID

from fastapi import HTTPException, status

from app.models.archive_operation import ArchiveOperationKind

V2_CHECKPOINT_VERSION = 2
V2_CHECKPOINT_FIELDS = frozenset(
    {
        "version",
        "aggregate_counters",
    }
)
V2_EXTRACTION_COUNTER_FIELDS = (
    "members_processed",
    "members_completed",
    "members_skipped",
    "members_failed",
    "files_extracted",
    "directories_created",
    "extracted_bytes",
    "files_replaced",
)
V2_EXTRACTION_OPTIONAL_COUNTER_FIELDS = (
    "encrypted_members_skipped",
    "unsupported_compression_members_skipped",
)
V2_EXTRACTION_MAX_COUNTER = (1 << 63) - 1
V2_CREATION_CHECKPOINT_FIELDS = frozenset({"version", "manifest", "member_outcomes", "decisions", "pending_decision", "delivery_ids"})
V2_TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")
DISALLOWED_CHECKPOINT_FIELDS = frozenset(
    {
        "extraction_outcome_checkpoint_version",
        "archive_manifest",
        "source_identity",
        "manifest",
        "source_snapshot",
        "member_outcomes",
        "decisions",
        "pending_decision",
        "delivery_ids",
        "total_members",
        "files_extracted",
        "directories_created",
        "extracted_bytes",
        "files_skipped",
        "skipped_members",
        "replaced_members",
        "renamed_members",
        "member_collision_actions",
        "member_rename_targets",
        "ignored_members",
        "retry_members",
    }
)


def _invalid_checkpoint(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail)


def _canonical_member_path(value: object) -> str:
    if not isinstance(value, str):
        raise _invalid_checkpoint("Archive V2 checkpoint member path is invalid")
    normalized = value.replace("\\", "/").rstrip("/")
    parts = normalized.split("/")
    if (
        not normalized
        or normalized != value
        or normalized.startswith("/")
        or "\x00" in normalized
        or any(not part or part in {".", ".."} or ":" in part for part in parts)
    ):
        raise _invalid_checkpoint("Archive V2 checkpoint member path is invalid")
    return normalized


def _validate_timestamp(value: object, *, detail: str) -> None:
    if value is None:
        return
    if not isinstance(value, str) or not V2_TIMESTAMP_PATTERN.fullmatch(value):
        raise _invalid_checkpoint(detail)
    try:
        datetime.fromisoformat(f"{value[:-1]}+00:00")
    except ValueError as exc:
        raise _invalid_checkpoint(detail) from exc


def canonical_v2_timestamp(value: datetime | str | None) -> str | None:
    """Serialize metadata timestamps in the one V2 wire representation."""

    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(f"{value[:-1]}+00:00" if value.endswith("Z") else value)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_delivery_ids(value: object) -> None:
    if not isinstance(value, dict) or len(value) > 1024:
        raise _invalid_checkpoint("Archive V2 checkpoint delivery IDs are invalid")
    for delivery_id, fingerprint in value.items():
        try:
            UUID(delivery_id) if isinstance(delivery_id, str) else None
        except ValueError as exc:
            raise _invalid_checkpoint("Archive V2 checkpoint delivery IDs are invalid") from exc
        if not isinstance(delivery_id, str) or not isinstance(fingerprint, str) or not fingerprint or len(fingerprint) > 4096:
            raise _invalid_checkpoint("Archive V2 checkpoint delivery IDs are invalid")


def validate_v2_extraction_checkpoint(checkpoint: object) -> dict[str, object]:
    """Return the aggregate-only S1 extraction envelope or reject legacy state."""

    if not isinstance(checkpoint, dict):
        raise _invalid_checkpoint("Archive V2 checkpoint must be an object")
    fields = frozenset(checkpoint)
    if fields & DISALLOWED_CHECKPOINT_FIELDS:
        raise _invalid_checkpoint("Archive V2 checkpoint contains disallowed fields")
    if fields != V2_CHECKPOINT_FIELDS:
        raise _invalid_checkpoint("Archive V2 checkpoint fields are invalid")
    if checkpoint.get("version") != V2_CHECKPOINT_VERSION:
        raise _invalid_checkpoint("Archive V2 checkpoint version is invalid")
    counters = checkpoint.get("aggregate_counters")
    required_counters = frozenset(V2_EXTRACTION_COUNTER_FIELDS)
    allowed_counters = required_counters | frozenset(V2_EXTRACTION_OPTIONAL_COUNTER_FIELDS)
    if not isinstance(counters, dict) or not required_counters <= frozenset(counters) <= allowed_counters:
        raise _invalid_checkpoint("Archive V2 checkpoint aggregate counters are invalid")
    for name in counters:
        value = counters[name]
        if type(value) is not int or value < 0 or value > V2_EXTRACTION_MAX_COUNTER:
            raise _invalid_checkpoint("Archive V2 checkpoint aggregate counters are invalid")
    if counters["members_processed"] != counters["members_completed"] + counters["members_skipped"] + counters["members_failed"]:
        raise _invalid_checkpoint("Archive V2 checkpoint aggregate counters are invalid")
    if sum(counters.get(name, 0) for name in V2_EXTRACTION_OPTIONAL_COUNTER_FIELDS) > counters["members_skipped"]:
        raise _invalid_checkpoint("Archive V2 checkpoint skipped member reason counters exceed the skipped total")
    return deepcopy(checkpoint)


def new_v2_extraction_checkpoint() -> dict[str, object]:
    """Create the empty aggregate-only V2 extraction envelope."""

    return validate_v2_extraction_checkpoint(
        {
            "version": V2_CHECKPOINT_VERSION,
            "aggregate_counters": {name: 0 for name in V2_EXTRACTION_COUNTER_FIELDS},
        }
    )


def validate_v2_creation_checkpoint(checkpoint: object) -> dict[str, object]:
    """Validate the closed V2 creation ledger without accepting V1 state."""

    if not isinstance(checkpoint, dict) or frozenset(checkpoint) != V2_CREATION_CHECKPOINT_FIELDS:
        raise _invalid_checkpoint("Archive V2 creation checkpoint fields are invalid")
    if checkpoint.get("version") != V2_CHECKPOINT_VERSION:
        raise _invalid_checkpoint("Archive V2 creation checkpoint version is invalid")
    manifest = checkpoint.get("manifest")
    outcomes = checkpoint.get("member_outcomes")
    if not isinstance(manifest, list) or not isinstance(outcomes, dict):
        raise _invalid_checkpoint("Archive V2 creation checkpoint envelope is invalid")
    paths: set[str] = set()
    for member in manifest:
        if not isinstance(member, dict) or frozenset(member) != {
            "archive_path",
            "is_directory",
            "source_size",
            "source_path",
            "modified_at",
        }:
            raise _invalid_checkpoint("Archive V2 creation checkpoint manifest is invalid")
        path = _canonical_member_path(member["archive_path"])
        if path in paths or type(member["is_directory"]) is not bool or type(member["source_size"]) is not int or member["source_size"] < 0:
            raise _invalid_checkpoint("Archive V2 creation checkpoint manifest is invalid")
        if member["source_path"] is not None and not isinstance(member["source_path"], str):
            raise _invalid_checkpoint("Archive V2 creation checkpoint manifest is invalid")
        _validate_timestamp(member["modified_at"], detail="Archive V2 creation checkpoint manifest is invalid")
        paths.add(path)
    for path, outcome in outcomes.items():
        if _canonical_member_path(path) not in paths or not isinstance(outcome, dict):
            raise _invalid_checkpoint("Archive V2 creation checkpoint member outcomes are invalid")
        if (
            frozenset(outcome) != {"status", "source_bytes"}
            or outcome["status"] not in {"directory", "created"}
            or type(outcome["source_bytes"]) is not int
            or outcome["source_bytes"] < 0
        ):
            raise _invalid_checkpoint("Archive V2 creation checkpoint member outcomes are invalid")
    if checkpoint.get("decisions") != {} or checkpoint.get("pending_decision") is not None:
        raise _invalid_checkpoint("Archive V2 creation checkpoint decisions are invalid")
    _validate_delivery_ids(checkpoint.get("delivery_ids"))
    return deepcopy(checkpoint)


def new_v2_creation_checkpoint(*, manifest: list[dict[str, object]]) -> dict[str, object]:
    """Create the empty strict V2 creation ledger before output begins."""

    return validate_v2_creation_checkpoint(
        {
            "version": V2_CHECKPOINT_VERSION,
            "manifest": manifest,
            "member_outcomes": {},
            "decisions": {},
            "pending_decision": None,
            "delivery_ids": {},
        }
    )


def validate_v2_operation_checkpoint(kind: ArchiveOperationKind, checkpoint: object) -> dict[str, object]:
    """Select the only valid V2 checkpoint envelope from the persisted operation kind."""

    if kind == ArchiveOperationKind.EXTRACT:
        return validate_v2_extraction_checkpoint(checkpoint)
    if kind == ArchiveOperationKind.CREATE:
        return validate_v2_creation_checkpoint(checkpoint)
    raise _invalid_checkpoint("Archive V2 operation kind is invalid")
