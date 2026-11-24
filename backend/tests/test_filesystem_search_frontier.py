"""The live-search queue is breadth-first and bounded by UTF-8 bytes."""

import pytest

from app.core.filesystem_search_contract import LIMITS
from app.services.filesystem_search_frontier import SearchFrontier, SearchFrontierFull


def test_frontier_preserves_order_identity_and_byte_accounting() -> None:
    frontier = SearchFrontier()
    frontier.enqueue("alpha", b"identity")
    frontier.enqueue("é", b"id")
    assert frontier.pending_bytes == 2 * LIMITS["pending_directory_entry_bytes"] + len("alpha") + len(b"identity") + len("é".encode()) + 2
    first = frontier.pop()
    assert (first.path, first.expected_id) == ("alpha", b"identity")
    frontier.enqueue("alpha/child")
    assert frontier.pop().path == "é"
    assert frontier.pop().path == "alpha/child"
    assert not frontier
    assert frontier.pending_bytes == 0


def test_frontier_rejects_overflow_without_dropping_existing_directories() -> None:
    frontier = SearchFrontier()
    count = LIMITS["pending_directory_bytes"] // (LIMITS["pending_directory_entry_bytes"] + 1)
    for _ in range(count):
        frontier.enqueue("x")
    before = frontier.pending_bytes
    with pytest.raises(SearchFrontierFull, match="smaller folder"):
        frontier.enqueue("x")
    assert frontier.pending_bytes == before
    assert sum(1 for _ in range(count) if frontier.pop().path == "x") == count
    assert not frontier


def test_frontier_rejects_unsafe_paths() -> None:
    with pytest.raises(ValueError):
        SearchFrontier().enqueue("../outside")
