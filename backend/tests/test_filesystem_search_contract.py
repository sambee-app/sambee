"""Verify the shared live-search wire fixtures and request validation."""

import json
from pathlib import Path

import pytest
from pydantic import TypeAdapter, ValidationError

from app.core.filesystem_search_contract import LIMITS, SearchBatch, SearchRequest, SearchStart, SearchTerminal

ROOT = Path(__file__).resolve().parents[2] / "shared" / "filesystem-search"
FIXTURES = json.loads((ROOT / "stream-fixtures.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("wire_request", FIXTURES["requests"])
def test_shared_requests(wire_request: dict) -> None:
    SearchRequest.model_validate(wire_request)


@pytest.mark.parametrize("record", FIXTURES["stream"])
def test_shared_stream_records(record: dict) -> None:
    adapter = TypeAdapter(SearchStart | SearchBatch | SearchTerminal)
    adapter.validate_json(json.dumps(record))


def test_archive_result_requires_consistent_target_and_capability() -> None:
    record = FIXTURES["stream"][1]
    archive_item = record["results"][1]
    for changed in (
        archive_item | {"archive_state": None},
        archive_item | {"archive_state": "readable"},
        archive_item | {"target": archive_item["target"] | {"member_path": "other.txt"}},
        archive_item | {"target": archive_item["target"] | {"archive_path": "../outside.zip"}},
    ):
        with pytest.raises(ValidationError):
            SearchBatch.model_validate(record | {"results": [changed]})


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("version", 2),
        ("version", True),
        ("query", "  "),
        ("query", "a" * (LIMITS["query_utf8_bytes"] + 1)),
        ("case_sensitive", "false"),
        ("root", {"kind": "directory", "path": "../outside"}),
        ("root", {"kind": "archive", "path": "", "member_path": ""}),
    ],
)
def test_invalid_requests_are_rejected(field: str, value: object) -> None:
    request = FIXTURES["requests"][0] | {field: value}
    with pytest.raises(ValidationError):
        SearchRequest.model_validate(request)
