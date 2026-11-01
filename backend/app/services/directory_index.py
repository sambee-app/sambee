"""Disk-backed directory storage; callers own source authorization and worker admission."""

from __future__ import annotations

import heapq
import json
import sqlite3
import threading
import time
import unicodedata
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal

APPLICATION_ID = 1396853073
SCHEMA_VERSION = 1
NORMALIZATION_VERSION = 1
TRAVERSAL_VERSION = 1
MAX_QUERY_BYTES = 4096
MAX_QUERY_TERMS = 32
MAX_RESULT_LIMIT = 200
ROW_BATCH_SIZE = 256
PAGE_CACHE_KIB = 2048
SQL_BUSY_TIMEOUT_MS = 250
SQL_PROGRESS_STEPS = 1000
QUERY_TIMEOUT_SECONDS = 10.0
MAX_SIGNED_INTEGER = (1 << 63) - 1
SCHEMA_PATH = Path(__file__).resolve().parents[3] / "shared" / "directory-index" / "schema.sql"


def normalize_search_text(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(character for character in decomposed if not unicodedata.combining(character)).casefold()


def search_terms(query: str) -> tuple[str, ...]:
    if len(query.encode("utf-8", errors="strict")) > MAX_QUERY_BYTES:
        raise ValueError(f"Search text must use at most {MAX_QUERY_BYTES} UTF-8 bytes. Shorten the search text.")
    terms = tuple(sorted({normalized for term in query.split() if (normalized := normalize_search_text(term))}))
    if len(terms) > MAX_QUERY_TERMS:
        raise ValueError(f"Search text must contain at most {MAX_QUERY_TERMS} distinct terms. Remove some terms.")
    return terms


def single_term_rank(basename_key: str, term: str) -> int:
    if basename_key == term:
        return 0
    if basename_key.startswith(term):
        return 1
    for offset, character in enumerate(basename_key):
        if not character.isalnum() and basename_key[offset + 1 :].startswith(term):
            return 2
    return 3


def validate_directory_path(path: str) -> None:
    path.encode("utf-8", errors="strict")
    if "\x00" in path or any(component in {"", ".", ".."} for component in path.split("/")):
        raise ValueError("Directory path must be relative and must not contain empty, dot, parent, or NUL components.")


def epoch_milliseconds() -> int:
    value = time.time_ns() // 1_000_000
    if not 0 <= value <= MAX_SIGNED_INTEGER:
        raise OverflowError("System time is outside the supported directory-index timestamp range. Correct the system clock.")
    return value


@dataclass(frozen=True)
class DirectoryIndexMatch:
    path: str
    matched_term_count: int
    match_rank: int
    depth: int
    path_key: str

    @property
    def sort_key(self) -> tuple[int, int, int, str, str]:
        return (-self.matched_term_count, self.match_rank, self.depth, self.path_key, self.path)


@dataclass(frozen=True)
class DirectoryIndexSearch:
    results: tuple[DirectoryIndexMatch, ...]
    total_matches: int
    directory_count: int
    accepted_revision: int
    coverage: str
    last_verified_at_ms: int | None
    query_plan: Literal["empty", "trigram", "scan"]


class DirectoryIndex:
    """One serialized writer and isolated read transactions, without a RAM catalogue."""

    def __init__(self, path: Path, *, source_kind: Literal["smb", "local"], source_identity: dict[str, str | int]) -> None:
        self.path = path
        self.source_kind = source_kind
        self.source_identity = json.dumps(source_identity, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        self._writer_lock = threading.RLock()
        self._writer: sqlite3.Connection | None = None

    def _connect(self, *, readonly: bool = False) -> sqlite3.Connection:
        uri = self.path.resolve().as_uri() + ("?mode=ro" if readonly else "?mode=rw")
        connection = sqlite3.connect(uri, uri=True, timeout=SQL_BUSY_TIMEOUT_MS / 1000, check_same_thread=False)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute(f"PRAGMA cache_size = -{PAGE_CACHE_KIB}")
            connection.execute("PRAGMA mmap_size = 0")
            connection.execute("PRAGMA temp_store = FILE")
            connection.execute("PRAGMA synchronous = FULL")
            return connection
        except BaseException:
            connection.close()
            raise

    def open(self) -> None:
        """Open off the request path, after the manager validates private storage and source binding."""
        with self._writer_lock:
            if self._writer is not None:
                return
            created = not self.path.exists()
            if created:
                with closing(sqlite3.connect(self.path)) as connection:
                    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
                    now = epoch_milliseconds()
                    with connection:
                        connection.execute("INSERT INTO generations(id, state, coverage) VALUES (1, 'building', 'partial')")
                        connection.execute(
                            "INSERT INTO source_metadata(id, source_kind, source_identity, normalization_version, "
                            "traversal_version, selected_generation, committed_at_ms, last_access_at_ms) "
                            "VALUES (1, ?, ?, ?, ?, 1, ?, ?)",
                            (self.source_kind, self.source_identity, NORMALIZATION_VERSION, TRAVERSAL_VERSION, now, now),
                        )
            connection = self._connect()
            try:
                if connection.execute("PRAGMA application_id").fetchone()[0] != APPLICATION_ID:
                    raise ValueError("Directory database application identifier is invalid. Rebuild this source index.")
                if connection.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION:
                    raise ValueError("Directory database schema is unsupported. Rebuild this source index.")
                metadata = connection.execute(
                    "SELECT source_kind, source_identity, normalization_version, traversal_version FROM source_metadata WHERE id = 1"
                ).fetchone()
                if metadata != (self.source_kind, self.source_identity, NORMALIZATION_VERSION, TRAVERSAL_VERSION):
                    raise ValueError("Directory database source or policy does not match. Rebuild this source index.")
                if connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
                    raise ValueError("Directory database integrity check failed. Rebuild this source index.")
                if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise ValueError("Directory database references are invalid. Rebuild this source index.")
                connection.execute("PRAGMA journal_mode = WAL")
                with connection:
                    connection.execute("INSERT INTO directory_fts(directory_fts, rank) VALUES ('integrity-check', 1)")
                    connection.execute("UPDATE source_metadata SET last_access_at_ms = ? WHERE id = 1", (epoch_milliseconds(),))
                    connection.execute(
                        "DELETE FROM generations WHERE state = 'candidate' AND id <> "
                        "(SELECT selected_generation FROM source_metadata WHERE id = 1)"
                    )
                self._writer = connection
            except BaseException:
                connection.close()
                raise

    def _connection(self) -> sqlite3.Connection:
        if self._writer is None:
            raise RuntimeError("Directory index is not initialized. Wait for source initialization and retry.")
        return self._writer

    def close(self) -> None:
        with self._writer_lock:
            if self._writer is not None:
                self._writer.close()
                self._writer = None

    def _revision(self, connection: sqlite3.Connection) -> None:
        revision = connection.execute("SELECT accepted_revision FROM source_metadata WHERE id = 1").fetchone()[0]
        if revision >= MAX_SIGNED_INTEGER:
            raise OverflowError("Directory-index revision is exhausted. Rebuild this source index.")
        connection.execute(
            "UPDATE source_metadata SET accepted_revision = accepted_revision + 1, committed_at_ms = ? WHERE id = 1",
            (epoch_milliseconds(),),
        )

    def write_paths(self, paths: Iterable[str], *, generation_id: int | None = None) -> None:
        iterator = iter(paths)
        while True:
            batch: list[tuple[str, str, str, int, bool]] = []
            for _ in range(ROW_BATCH_SIZE):
                path = next(iterator, None)
                if path is None:
                    break
                validate_directory_path(path)
                key = normalize_search_text(path)
                batch.append(
                    (
                        path,
                        key,
                        normalize_search_text(path.rsplit("/", 1)[-1]),
                        path.count("/"),
                        any(component.startswith(".") for component in path.split("/")),
                    )
                )
            if not batch:
                return
            with self._writer_lock:
                connection = self._connection()
                with connection:
                    selected = connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1").fetchone()[0]
                    target = selected if generation_id is None else generation_id
                    if generation_id is not None:
                        state = connection.execute("SELECT state FROM generations WHERE id = ?", (target,)).fetchone()
                        if state is None or state[0] not in {"building", "candidate"}:
                            raise ValueError("Scan generation is no longer active. Discard this batch and request verification.")
                    connection.executemany(
                        "INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) "
                        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(generation_id, path) DO NOTHING",
                        ((target, *row) for row in batch),
                    )
                    if target == selected:
                        self._revision(connection)

    def begin_verification(self) -> int:
        with self._writer_lock:
            connection = self._connection()
            with connection:
                cursor = connection.execute("INSERT INTO generations(state, coverage) VALUES ('candidate', 'partial')")
                if cursor.lastrowid is None:
                    raise RuntimeError("SQLite did not allocate a verification generation. Retry verification.")
                return cursor.lastrowid

    def finish_generation(self, generation_id: int, *, issue_count: int = 0) -> bool:
        """Only issue-free full passes select candidates and advance verification time."""
        if not 0 <= issue_count <= MAX_SIGNED_INTEGER:
            raise ValueError("Coverage issue count is outside the supported range.")
        with self._writer_lock:
            connection = self._connection()
            with connection:
                row = connection.execute("SELECT state FROM generations WHERE id = ?", (generation_id,)).fetchone()
                if row is None or row[0] not in {"candidate", "building"}:
                    raise ValueError("Generation is not an active build or verification candidate.")
                if issue_count:
                    connection.execute(
                        "UPDATE generations SET issue_count = ?, coverage = 'partial' WHERE id = ?", (issue_count, generation_id)
                    )
                    return False
                previous = connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1").fetchone()[0]
                connection.execute("UPDATE generations SET state = 'retired' WHERE id = ? AND id <> ?", (previous, generation_id))
                connection.execute(
                    "UPDATE generations SET state = 'accepted', coverage = 'complete', issue_count = 0 WHERE id = ?", (generation_id,)
                )
                connection.execute(
                    "UPDATE source_metadata SET selected_generation = ?, last_verified_at_ms = ? WHERE id = 1",
                    (generation_id, epoch_milliseconds()),
                )
                self._revision(connection)
                return True

    def search(
        self,
        query: str,
        *,
        limit: int = MAX_RESULT_LIMIT,
        include_dot_directories: bool = False,
        cancelled: threading.Event | None = None,
        force_scan: bool = False,
    ) -> DirectoryIndexSearch:
        terms = search_terms(query)
        with self._writer_lock:
            self._connection()
        if not 1 <= limit <= MAX_RESULT_LIMIT:
            raise ValueError(f"Result limit must be between 1 and {MAX_RESULT_LIMIT}.")
        deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS

        def interrupted() -> bool:
            return bool(cancelled is not None and cancelled.is_set()) or time.monotonic() >= deadline

        if interrupted():
            raise InterruptedError("Directory search was cancelled or timed out. Retry the search.")
        with closing(self._connect(readonly=True)) as connection:
            connection.set_progress_handler(lambda: int(interrupted()), SQL_PROGRESS_STEPS)
            with connection:
                connection.execute("BEGIN")
                metadata = connection.execute(
                    "SELECT selected_generation, accepted_revision, last_verified_at_ms FROM source_metadata WHERE id = 1"
                ).fetchone()
                generation_id, revision, verified = metadata
                directory_count, coverage = connection.execute(
                    "SELECT indexed_count, coverage FROM generations WHERE id = ?", (generation_id,)
                ).fetchone()
                plan: Literal["empty", "trigram", "scan"] = "empty"
                count = 0
                if not terms:
                    return DirectoryIndexSearch((), count, directory_count, revision, coverage, verified, plan)
                plan = "trigram" if not force_scan and all(len(term) >= 3 for term in terms) else "scan"
                sql = "SELECT path, path_key, basename_key, depth FROM directories WHERE generation_id = ?"
                parameters: list[str | int] = [generation_id]
                if not include_dot_directories:
                    sql += " AND has_dot_directory = 0"
                if plan == "trigram":
                    sql += " AND id IN (SELECT rowid FROM directory_fts WHERE directory_fts MATCH ?)"
                    parameters.append(" OR ".join('"' + term.replace('"', '""') + '"' for term in terms))

                def matches() -> Iterable[DirectoryIndexMatch]:
                    nonlocal count
                    with closing(connection.execute(sql, parameters)) as cursor:
                        for path, path_key, basename_key, depth in cursor:
                            if interrupted():
                                raise InterruptedError("Directory search was cancelled or timed out. Retry the search.")
                            matched = tuple(term for term in terms if term in path_key)
                            if matched:
                                count += 1
                                yield DirectoryIndexMatch(
                                    path, len(matched), min(single_term_rank(basename_key, term) for term in matched), depth, path_key
                                )

                rows = tuple(heapq.nsmallest(limit, matches(), key=lambda result: result.sort_key))
                return DirectoryIndexSearch(rows, count, directory_count, revision, coverage, verified, plan)
