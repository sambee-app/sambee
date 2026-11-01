"""Language-neutral SQLite contract and transaction checks."""

import json
import sqlite3
import threading
from contextlib import closing
from pathlib import Path

import pytest

from app.services.directory_index import MAX_QUERY_BYTES, MAX_QUERY_TERMS, DirectoryIndex, normalize_search_text, search_terms

CONTRACT_ROOT = Path(__file__).resolve().parents[2] / "shared" / "directory-index"
APPLICATION_ID = 1396853073
SCHEMA_VERSION = 1


@pytest.fixture
def database(tmp_path):
    with closing(sqlite3.connect(tmp_path / "index.sqlite3")) as connection:
        connection.executescript((CONTRACT_ROOT / "schema.sql").read_text())
        connection.execute("INSERT INTO generations(id, state, coverage) VALUES (1, 'building', 'partial')")
        connection.commit()
        yield connection


def insert_directory(database, path):
    database.execute(
        "INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) VALUES (1, ?, ?, ?, ?, 0)",
        (path, path, path.rsplit("/", 1)[-1], path.count("/")),
    )


def test_schema_identifiers_and_fts(database):
    assert database.execute("PRAGMA application_id").fetchone()[0] == APPLICATION_ID
    assert database.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert database.execute("PRAGMA auto_vacuum").fetchone()[0] == 2
    insert_directory(database, "alpha/beta")
    assert database.execute("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH ?", ('"alpha" OR "beta"',)).fetchone()[0] == 1


def test_fts_counts_and_rollback(database):
    insert_directory(database, "alpha")
    database.commit()
    with pytest.raises(RuntimeError), database:
        database.execute("UPDATE directories SET path = 'beta', path_key = 'beta' WHERE path = 'alpha'")
        raise RuntimeError("injected failure")
    assert database.execute("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH 'alpha'").fetchone()[0] == 1
    assert database.execute("SELECT indexed_count FROM generations").fetchone()[0] == 1
    with database:
        database.execute("DELETE FROM generations WHERE id = 1")
    assert database.execute("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH 'alpha'").fetchone()[0] == 0


@pytest.mark.parametrize("path", ["", "/alpha", "alpha/", "a//b", "a/./b", "a/../b", "a\x00b"])
def test_invalid_paths(database, path):
    with pytest.raises(sqlite3.IntegrityError):
        insert_directory(database, path)


@pytest.fixture
def index(tmp_path):
    store = DirectoryIndex(tmp_path / "source.sqlite3", source_kind="smb", source_identity={"connection_id": "test", "host": "test"})
    store.open()
    try:
        yield store
    finally:
        store.close()


def test_shared_normalization_and_terms():
    fixtures = json.loads((CONTRACT_ROOT / "search-fixtures.json").read_text())
    for case in fixtures["normalization"]:
        assert normalize_search_text(case["input"]) == case["expected"]
    for case in fixtures["queries"]:
        assert search_terms(case["query"]) == tuple(sorted(case["terms"]))


def test_shared_search_scan_and_fts_parity(index):
    fixtures = json.loads((CONTRACT_ROOT / "search-fixtures.json").read_text())
    index.write_paths(fixtures["paths"])
    for case in fixtures["searches"]:
        for force_scan in (False, True):
            response = index.search(case["query"], include_dot_directories=case["include_dot"], force_scan=force_scan)
            assert response.total_matches == case["count"]
            assert [row.path for row in response.results] == case["results"]


def test_candidate_failure_preserves_accepted_data(index):
    index.write_paths(["old/alpha"])
    assert index.finish_generation(1)
    accepted = index.search("alpha")
    candidate = index.begin_verification()
    index.write_paths(["new/beta"], generation_id=candidate)
    assert not index.finish_generation(candidate, issue_count=1)
    assert index.search("alpha") == accepted
    index.write_paths(["other/alpha"])
    assert index.search("alpha").total_matches == 2
    assert index.search("alpha").last_verified_at_ms == accepted.last_verified_at_ms


def test_candidate_selection_is_atomic_and_reopens(index):
    index.write_paths(["old/alpha"])
    index.finish_generation(1)
    candidate = index.begin_verification()
    index.write_paths(["new/beta"], generation_id=candidate)
    assert index.search("beta").total_matches == 0
    assert index.finish_generation(candidate)
    assert index.search("alpha").total_matches == 0
    assert index.search("beta").total_matches == 1
    index.close()
    index.open()
    assert index.search("beta").directory_count == 1


def test_source_kind_and_identity_must_match(index):
    index.close()
    other = DirectoryIndex(index.path, source_kind="local", source_identity={"connection_id": "test", "host": "test"})
    with pytest.raises(ValueError, match="source or policy"):
        other.open()
    with pytest.raises(RuntimeError, match="not initialized"):
        other.search("alpha")


def test_late_scan_cannot_write_completed_generation(index):
    index.write_paths(["alpha"])
    index.finish_generation(1)
    with pytest.raises(ValueError, match="no longer active"):
        index.write_paths(["late/alpha"], generation_id=1)
    assert index.search("alpha").total_matches == 1


def test_integer_overflow_rolls_back(database):
    with database:
        database.execute("UPDATE generations SET indexed_count = ?", ((1 << 63) - 1,))
    with pytest.raises(sqlite3.IntegrityError), database:
        insert_directory(database, "alpha")
    assert database.execute("SELECT count(*) FROM directories").fetchone()[0] == 0


def test_literal_operators_and_colliding_keys(index):
    index.write_paths(['a%/_*/"quoted"', "Straße", "STRASSE"])
    assert index.search('a% _* "quoted"').total_matches == 1
    assert index.search("strasse").total_matches == 2


def test_cancelled_query_has_no_success_response(index):
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(InterruptedError):
        index.search("alpha", cancelled=cancelled)


def test_input_limits_are_not_silent():
    with pytest.raises(ValueError, match="UTF-8 bytes"):
        search_terms("x" * (MAX_QUERY_BYTES + 1))
    with pytest.raises(ValueError, match="distinct terms"):
        search_terms(" ".join(f"term{number}" for number in range(MAX_QUERY_TERMS + 1)))


def test_coverage_above_old_cutoff_and_bounded_results(index):
    index.write_paths(f"directory-{number:06d}" for number in range(100_001))
    response = index.search("directory", limit=3)
    assert response.directory_count == response.total_matches == 100_001
    assert len(response.results) == 3
    assert index.search("100000").results[0].path == "directory-100000"
    index.finish_generation(1)
    index.close()
    index.open()
    assert index.search("100000").directory_count == 100_001
