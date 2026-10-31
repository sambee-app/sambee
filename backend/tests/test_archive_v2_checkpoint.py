"""Strict V2 archive checkpoint contract tests."""

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.archive_operation import ArchiveCompanionLiveExtractionSummary, ArchiveExtractionAggregate
from app.services.archive.v2_checkpoint import (
    canonical_v2_timestamp,
    new_v2_creation_checkpoint,
    new_v2_extraction_checkpoint,
    validate_v2_creation_checkpoint,
    validate_v2_extraction_checkpoint,
)

INVALID_CHECKPOINTS_PATH = Path(__file__).resolve().parents[2] / "archive-contract" / "v2" / "fixtures" / "invalid-checkpoints-v2.json"


def test_canonical_v2_timestamp_uses_utc_z_suffix() -> None:
    assert canonical_v2_timestamp(datetime(2026, 8, 30, 12, 34, 56, tzinfo=timezone.utc)) == "2026-08-30T12:34:56Z"


def valid_checkpoint() -> dict[str, object]:
    return new_v2_extraction_checkpoint()


def test_companion_extraction_summary_enforces_strict_aggregate_counters() -> None:
    summary = {
        "source_session_id": "source-session",
        "members_processed": 3,
        "members_completed": 1,
        "members_skipped": 1,
        "members_failed": 1,
        "files_extracted": 1,
        "directories_created": 0,
        "extracted_bytes": 42,
        "files_replaced": 0,
    }
    assert ArchiveCompanionLiveExtractionSummary.model_validate(summary).members_processed == 3

    for value in (True, 1.5, 1 << 63):
        invalid_summary = {**summary, "members_processed": value}
        with pytest.raises(ValidationError):
            ArchiveCompanionLiveExtractionSummary.model_validate(invalid_summary)

    invalid_summary = {**summary, "members_processed": 2}
    with pytest.raises(ValidationError, match="aggregate member counters"):
        ArchiveCompanionLiveExtractionSummary.model_validate(invalid_summary)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda checkpoint: checkpoint.pop("version"),
        lambda checkpoint: checkpoint.__setitem__("manifest", []),
        lambda checkpoint: checkpoint.__setitem__("unexpected", True),
        lambda checkpoint: checkpoint.__setitem__("version", 1),
    ],
)
def test_v2_checkpoint_rejects_legacy_unknown_and_unversioned_shapes(mutate) -> None:
    checkpoint = valid_checkpoint()
    mutate(checkpoint)
    with pytest.raises(HTTPException, match="Archive V2 checkpoint"):
        validate_v2_extraction_checkpoint(checkpoint)


def test_v2_checkpoint_rejects_all_invalid_fixture_cases() -> None:
    fixture = json.loads(INVALID_CHECKPOINTS_PATH.read_text(encoding="utf-8"))
    assert fixture["version"] == 2

    for case in fixture["cases"]:
        with pytest.raises(HTTPException, match="Archive V2 checkpoint"):
            validate_v2_extraction_checkpoint(case["checkpoint"])


@pytest.mark.parametrize("field", ["manifest", "source_snapshot", "member_outcomes", "decisions", "pending_decision", "delivery_ids"])
def test_v2_checkpoint_rejects_legacy_extraction_state(field: str) -> None:
    checkpoint = valid_checkpoint()
    checkpoint[field] = {}  # type: ignore[assignment]
    with pytest.raises(HTTPException, match="disallowed fields"):
        validate_v2_extraction_checkpoint(checkpoint)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda checkpoint: checkpoint.__setitem__("aggregate_counters", {}),
        lambda checkpoint: checkpoint["aggregate_counters"].__setitem__("members_processed", -1),  # type: ignore[index,union-attr]
        lambda checkpoint: checkpoint["aggregate_counters"].__setitem__("members_completed", True),  # type: ignore[index,union-attr]
        lambda checkpoint: checkpoint["aggregate_counters"].__setitem__("files_replaced", 1 << 63),  # type: ignore[index,union-attr]
        lambda checkpoint: checkpoint["aggregate_counters"].__setitem__("members_processed", 1),  # type: ignore[index,union-attr]
    ],
)
def test_v2_checkpoint_rejects_invalid_canonical_nested_values(mutate) -> None:
    checkpoint = valid_checkpoint()
    mutate(checkpoint)

    with pytest.raises(HTTPException, match="Archive V2 checkpoint"):
        validate_v2_extraction_checkpoint(checkpoint)


def test_v2_checkpoint_returns_a_defensive_validated_copy() -> None:
    checkpoint = valid_checkpoint()
    validated = validate_v2_extraction_checkpoint(checkpoint)
    assert validated == checkpoint
    assert validated is not checkpoint


def test_v2_checkpoint_rejects_disallowed_executor_fields() -> None:
    checkpoint = valid_checkpoint()
    checkpoint["files_extracted"] = 1
    with pytest.raises(HTTPException, match="disallowed fields"):
        validate_v2_extraction_checkpoint(checkpoint)


def test_v2_checkpoint_accepts_aggregate_result() -> None:
    checkpoint = valid_checkpoint()
    checkpoint["aggregate_counters"] = {
        "members_processed": 3,
        "members_completed": 1,
        "members_skipped": 1,
        "members_failed": 1,
        "files_extracted": 1,
        "directories_created": 2,
        "extracted_bytes": 7,
        "files_replaced": 1,
    }

    assert validate_v2_extraction_checkpoint(checkpoint) == checkpoint


def test_live_extraction_aggregate_requires_exact_valid_counters() -> None:
    aggregate = {
        "members_processed": 3,
        "members_completed": 1,
        "members_skipped": 1,
        "members_failed": 1,
        "files_extracted": 1,
        "directories_created": 2,
        "extracted_bytes": 7,
        "files_replaced": 1,
    }

    assert ArchiveExtractionAggregate.model_validate(aggregate).model_dump() == {
        **aggregate,
        "encrypted_members_skipped": 0,
        "unsupported_compression_members_skipped": 0,
    }
    for invalid in (
        {**aggregate, "members_processed": True},
        {**aggregate, "members_processed": 2},
        {key: value for key, value in aggregate.items() if key != "files_replaced"},
        {**aggregate, "unexpected": 1},
    ):
        with pytest.raises(ValidationError):
            ArchiveExtractionAggregate.model_validate(invalid)


@pytest.mark.parametrize("reason", ["encrypted_members_skipped", "unsupported_compression_members_skipped"])
def test_v2_skipped_reason_counters_are_optional_checked_and_bounded_by_total(reason: str) -> None:
    checkpoint = valid_checkpoint()
    aggregate = ArchiveExtractionAggregate.model_validate(checkpoint["aggregate_counters"]).model_dump()
    aggregate.update(members_processed=1, members_skipped=1)
    aggregate[reason] = 1
    checkpoint["aggregate_counters"] = aggregate
    assert validate_v2_extraction_checkpoint(checkpoint) == checkpoint
    assert ArchiveExtractionAggregate.model_validate(aggregate).model_dump()[reason] == 1
    assert (
        ArchiveCompanionLiveExtractionSummary.model_validate({**aggregate, "source_session_id": "source-session"}).model_dump()[reason] == 1
    )

    for invalid in (
        *({**aggregate, reason: value} for value in (True, -1, 2, 1 << 63)),
        {**aggregate, "encrypted_members_skipped": 1, "unsupported_compression_members_skipped": 1},
    ):
        with pytest.raises(HTTPException, match="Archive V2 checkpoint"):
            validate_v2_extraction_checkpoint({**checkpoint, "aggregate_counters": invalid})
        with pytest.raises(ValidationError):
            ArchiveExtractionAggregate.model_validate(invalid)
        with pytest.raises(ValidationError):
            ArchiveCompanionLiveExtractionSummary.model_validate({**invalid, "source_session_id": "source-session"})


def test_v2_creation_checkpoint_rejects_aggregate_counters() -> None:
    checkpoint = new_v2_creation_checkpoint(
        manifest=[
            {
                "archive_path": "report.txt",
                "is_directory": False,
                "source_size": 4,
                "source_path": "report.txt",
                "modified_at": None,
            }
        ]
    )

    checkpoint["files_created"] = 1
    with pytest.raises(HTTPException, match="fields are invalid"):
        validate_v2_creation_checkpoint(checkpoint)


def test_v2_creation_checkpoint_rejects_malformed_member_outcomes() -> None:
    checkpoint = new_v2_creation_checkpoint(
        manifest=[
            {
                "archive_path": "report.txt",
                "is_directory": False,
                "source_size": 4,
                "source_path": "report.txt",
                "modified_at": None,
            }
        ]
    )
    checkpoint["member_outcomes"] = {"report.txt": {}}

    with pytest.raises(HTTPException, match="member outcomes are invalid"):
        validate_v2_creation_checkpoint(checkpoint)
