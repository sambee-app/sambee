"""Shared live-search name-matching contract."""

import json
import unicodedata
from pathlib import Path

import pytest

from app.services.filesystem_search_matching import NameMatcher

ROOT = Path(__file__).resolve().parents[2] / "shared" / "filesystem-search"
FIXTURES = json.loads((ROOT / "matching-fixtures.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("query", FIXTURES["invalid_queries"])
def test_rejects_empty_queries(query: str) -> None:
    with pytest.raises(ValueError, match="Enter a search term"):
        NameMatcher(query, case_sensitive=False)


@pytest.mark.parametrize("case", FIXTURES["matches"])
def test_shared_name_matching(case: dict) -> None:
    matcher = NameMatcher(case["query"], case_sensitive=case["case_sensitive"])
    assert matcher.matches(case["name"]) is case["expected"]


def test_unicode_casefold_contract_matches_backend() -> None:
    contract = json.loads((ROOT / "casefold.json").read_text(encoding="utf-8"))
    assert contract["unicode_version"] == unicodedata.unidata_version
    for character, folded in contract["casefold"]:
        assert character.casefold() == folded


def test_pathological_pattern_completes_without_backtracking() -> None:
    matcher = NameMatcher("*a*a*a*a*b", case_sensitive=True)
    assert not matcher.matches("a" * 10_000)
