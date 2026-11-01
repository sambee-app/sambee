"""Disk-backed directory storage; callers own source authorization and worker admission."""

from __future__ import annotations

import heapq
import json
import os
import sqlite3
import stat
import sys
import threading
import time
import unicodedata
from contextlib import AbstractContextManager, closing, contextmanager, nullcontext
from dataclasses import dataclass
from itertools import islice
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Literal

from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT, MAX_SQL_INTEGER

APPLICATION_ID = 1396853073
SCHEMA_VERSION = DIRECTORY_INDEX_CONTRACT.limits["schema_version"]
NORMALIZATION_VERSION = DIRECTORY_INDEX_CONTRACT.limits["normalization_version"]
TRAVERSAL_VERSION = DIRECTORY_INDEX_CONTRACT.limits["traversal_version"]
MAX_QUERY_BYTES = DIRECTORY_INDEX_CONTRACT.limits["max_query_bytes"]
MAX_QUERY_TERMS = DIRECTORY_INDEX_CONTRACT.limits["max_query_terms"]
MAX_RESULT_LIMIT = DIRECTORY_INDEX_CONTRACT.limits["max_result_limit"]
ROW_BATCH_SIZE = DIRECTORY_INDEX_CONTRACT.limits["row_batch_size"]
SCAN_BATCH_BYTES = DIRECTORY_INDEX_CONTRACT.limits["max_observation_bytes"]
MAINTENANCE_PAGE_BATCH = DIRECTORY_INDEX_CONTRACT.limits["maintenance_page_batch"]
CHECKPOINT_WAL_BYTES = DIRECTORY_INDEX_CONTRACT.limits["checkpoint_wal_bytes"]
NAMESPACE_LEASE_NAME = ".namespace.lease"
INCREMENTAL_VACUUM_MODE = 2
PAGE_CACHE_KIB = DIRECTORY_INDEX_CONTRACT.policy["page_cache_kib"].default
SQL_BUSY_TIMEOUT_MS = DIRECTORY_INDEX_CONTRACT.limits["busy_timeout_ms"]
QUERY_WORKERS = DIRECTORY_INDEX_CONTRACT.limits["query_workers"]
SQL_PROGRESS_STEPS = DIRECTORY_INDEX_CONTRACT.limits["progress_steps"]
QUERY_TIMEOUT_SECONDS = DIRECTORY_INDEX_CONTRACT.limits["query_timeout_seconds"]
MAX_SIGNED_INTEGER = MAX_SQL_INTEGER
SCHEMA_PATH_CANDIDATES = tuple(Path(__file__).resolve().parents[level] / "shared" / "directory-index" / "schema.sql" for level in (3, 2))
SCHEMA_PATH = next((path for path in SCHEMA_PATH_CANDIDATES if path.is_file()), SCHEMA_PATH_CANDIDATES[0])
PRIVATE_DIRECTORY_MODE = 0o700
LEASE_FILE_MODE = 0o600
STORAGE_FILE_SUFFIXES = ("", "-wal", "-shm", "-journal", ".lease")
MIN_SQLITE_VERSION_NUMBER = DIRECTORY_INDEX_CONTRACT.limits["minimum_sqlite_version_number"]
MIN_SQLITE_VERSION = (MIN_SQLITE_VERSION_NUMBER // 1_000_000, MIN_SQLITE_VERSION_NUMBER // 1_000 % 1_000, MIN_SQLITE_VERSION_NUMBER % 1_000)
SQLITE_PRIMARY_ERROR_MASK = 0xFF


def connect_directory_database(path: Path, *, readonly: bool = False) -> sqlite3.Connection:
    """Open existing private storage without creating a file or accepting a link."""
    path = path.absolute()
    if any(ancestor.is_symlink() for ancestor in path.parents):
        raise PermissionError("Directory-index storage must not use symbolic links. Select private local storage.")
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise PermissionError("Directory-index database must be a regular file without symbolic links. Correct private cache storage.")
    mode = "ro" if readonly else "rw"
    connection = sqlite3.connect(
        f"{path.as_uri()}?mode={mode}",
        uri=True,
        timeout=SQL_BUSY_TIMEOUT_MS / 1000,
        isolation_level=None,
        check_same_thread=False,
    )
    try:
        after = path.lstat()
        if not stat.S_ISREG(after.st_mode) or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise PermissionError("Directory-index database changed during open. Stop the source and correct private cache storage.")
        return connection
    except BaseException:
        connection.close()
        raise


@contextmanager
def transaction(connection: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Include initial reads and all changes in one explicitly started transaction."""
    with connection:
        connection.execute("BEGIN")
        yield connection


def validate_sqlite_runtime() -> None:
    """Check the SQL features used by the index in the actual Python runtime."""
    if sqlite3.sqlite_version_info < MIN_SQLITE_VERSION or sqlite3.threadsafety != 3:
        raise RuntimeError("Directory indexing requires SQLite 3.37 or later with serialized threading. Rebuild the Debian backend image.")
    try:
        with closing(sqlite3.connect(":memory:")) as connection:
            connection.execute("CREATE TABLE runtime_rows(id INTEGER PRIMARY KEY) STRICT")
            connection.execute("INSERT INTO runtime_rows DEFAULT VALUES RETURNING id").fetchall()
            connection.execute("CREATE VIRTUAL TABLE runtime_fts USING fts5(path, tokenize='trigram case_sensitive 1', detail=full)")
            connection.execute("INSERT INTO runtime_fts(path) VALUES ('runtime')")
            if connection.execute("SELECT path FROM runtime_fts WHERE runtime_fts MATCH ?", ('"unt"',)).fetchone() != ("runtime",):
                raise RuntimeError("Directory indexing requires working FTS5 trigram search. Rebuild the Debian backend image.")
    except sqlite3.Error as exc:
        raise RuntimeError(
            "Directory indexing requires STRICT tables, RETURNING, and FTS5 trigram search. Rebuild the Debian backend image."
        ) from exc


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


def required_row(cursor: sqlite3.Cursor) -> tuple[Any, ...]:
    row = cursor.fetchone()
    if not isinstance(row, tuple):
        raise ValueError("Directory-index metadata is missing or invalid. Rebuild this source index.")
    return row


def sql_text(*values: object) -> str:
    if len(values) != 1 or not isinstance(values[0], str):
        raise ValueError("Directory-index search key input is invalid. Rebuild this source index.")
    return values[0]


def sql_normalize_key(*values: object) -> str:
    return normalize_search_text(sql_text(*values))


def sql_basename_key(*values: object) -> str:
    return normalize_search_text(sql_text(*values).rsplit("/", 1)[-1])


def sql_dot_path(*values: object) -> int:
    return int(any(part.startswith(".") for part in sql_text(*values).split("/")))


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
    issue_count: int = 0


class DirectoryIndex:
    """One serialized writer and isolated read transactions, without a RAM catalogue."""

    def __init__(self, path: Path, *, source_kind: Literal["smb", "local"], source_identity: dict[str, str | int]) -> None:
        self.path = path
        self.source_kind = source_kind
        self.source_identity = json.dumps(source_identity, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        self._writer_lock = threading.RLock()
        self._reader_condition = threading.Condition(self._writer_lock)
        self._query_slots = threading.BoundedSemaphore(QUERY_WORKERS)
        self._active_queries = 0
        self._closing = False
        self._writer: sqlite3.Connection | None = None
        self._lease_fd: int | None = None
        self._fts_ready = False
        self._fts_repair_cursor: int | None = None
        self.page_cache_kib = PAGE_CACHE_KIB
        self.growth_guard: Callable[[], AbstractContextManager[None]] = lambda: nullcontext()

    def configure_page_cache(self, value: int) -> None:
        DIRECTORY_INDEX_CONTRACT.policy["page_cache_kib"].validate(value)
        with self._writer_lock:
            if self._writer is not None:
                self._writer.execute(f"PRAGMA cache_size = -{value}")
            self.page_cache_kib = value

    def _acquire_storage(self) -> None:
        self._lease_fd = self.acquire_storage_lease(self.path)

    @staticmethod
    def acquire_storage_lease(path: Path) -> int:
        """Validate private storage and acquire ownership before open or cleanup."""
        namespace_descriptor = DirectoryIndex.acquire_namespace_lease(path.parent)
        try:
            for suffix in STORAGE_FILE_SUFFIXES:
                candidate = Path(str(path) + suffix)
                try:
                    info = candidate.lstat()
                except FileNotFoundError:
                    continue
                if not stat.S_ISREG(info.st_mode):
                    raise PermissionError("Directory-index files must be regular files without symbolic links. Correct the storage path.")
                if os.name == "posix" and info.st_nlink != 1:
                    raise PermissionError(
                        "Directory-index files must not use hard links. Remove the alias or select new private cache storage, then retry."
                    )
                if os.name == "posix" and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022):
                    raise PermissionError(
                        "Directory-index files must belong to the service account without public write access. Correct their permissions."
                    )
            return DirectoryIndex._acquire_file_lease(Path(str(path) + ".lease"))
        finally:
            os.close(namespace_descriptor)

    @staticmethod
    def acquire_namespace_lease(directory: Path) -> int:
        """Serialize lease creation and inode cleanup across processes."""
        directory = directory.absolute()
        for ancestor in (directory, *directory.parents):
            if ancestor.is_symlink():
                raise PermissionError("Directory-index storage must not use symbolic links. Select a private local directory.")
        directory.mkdir(mode=PRIVATE_DIRECTORY_MODE, parents=True, exist_ok=True)
        info = directory.stat()
        if os.name == "posix" and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
            raise PermissionError(
                "Directory-index storage must belong to the service account with mode 0700. Correct its owner and permissions."
            )
        return DirectoryIndex._acquire_file_lease(directory / NAMESPACE_LEASE_NAME)

    @staticmethod
    def _acquire_file_lease(path: Path) -> int:
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), LEASE_FILE_MODE)
        try:
            info = os.fstat(descriptor)
            if os.name == "posix" and info.st_nlink != 1:
                raise PermissionError(
                    "Directory-index leases must not use hard links. Remove the alias or select new private cache storage, then retry."
                )
            if not stat.S_ISREG(info.st_mode) or (
                os.name == "posix" and (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022)
            ):
                raise PermissionError("Directory-index lease is not a private regular file. Correct its owner and permissions.")
            if os.name == "posix":
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            elif sys.platform == "win32":
                import msvcrt

                os.write(descriptor, b"\0")
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                raise OSError("Directory-index process leases are unsupported on this platform. Use a supported backend host.")
        except BaseException:
            os.close(descriptor)
            raise
        return descriptor

    @staticmethod
    def remove_orphan_lease(path: Path) -> bool:
        """Hold namespace ownership until an unused source lease inode is removed."""
        namespace_descriptor = DirectoryIndex.acquire_namespace_lease(path.parent)
        try:
            descriptor = DirectoryIndex._acquire_file_lease(Path(str(path) + ".lease"))
            try:
                for suffix in STORAGE_FILE_SUFFIXES:
                    if suffix == ".lease":
                        continue
                    try:
                        Path(str(path) + suffix).lstat()
                    except FileNotFoundError:
                        continue
                    return False
            finally:
                os.close(descriptor)
            Path(str(path) + ".lease").unlink()
            return True
        finally:
            os.close(namespace_descriptor)

    def _release_storage(self) -> None:
        if self._lease_fd is not None:
            os.close(self._lease_fd)
            self._lease_fd = None

    def _connect(self, *, readonly: bool = False) -> sqlite3.Connection:
        connection = connect_directory_database(self.path, readonly=readonly)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute(f"PRAGMA cache_size = -{self.page_cache_kib}")
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
            validate_sqlite_runtime()
            self._acquire_storage()
            created = not self.path.exists()
            try:
                if created:
                    descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), LEASE_FILE_MODE)
                    os.close(descriptor)
                    with closing(self._connect()) as connection:
                        connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
                        connection.executescript(SCHEMA_PATH.with_name("fts.sql").read_text(encoding="utf-8"))
                        now = epoch_milliseconds()
                        with transaction(connection):
                            connection.execute("INSERT INTO generations(id, state, coverage) VALUES (1, 'building', 'partial')")
                            connection.execute(
                                "INSERT INTO source_metadata(id, source_kind, source_identity, normalization_version, "
                                "traversal_version, selected_generation, committed_at_ms, last_access_at_ms) "
                                "VALUES (1, ?, ?, ?, ?, 1, ?, ?)",
                                (self.source_kind, self.source_identity, NORMALIZATION_VERSION, TRAVERSAL_VERSION, now, now),
                            )
                connection = self._connect()
            except BaseException:
                self._release_storage()
                raise
            try:
                if required_row(connection.execute("PRAGMA application_id"))[0] != APPLICATION_ID:
                    raise ValueError("Directory database application identifier is invalid. Rebuild this source index.")
                if required_row(connection.execute("PRAGMA user_version"))[0] != SCHEMA_VERSION:
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
                if required_row(connection.execute(SCHEMA_PATH.with_name("validate-generations.sql").read_text(encoding="utf-8")))[0]:
                    raise ValueError("Directory database generation metadata is invalid. Rebuild this source index.")
                if connection.execute("PRAGMA journal_mode = WAL").fetchone() != ("wal",):
                    raise RuntimeError("Directory-index storage does not support WAL. Select supported private local storage.")
                self._fts_ready = False
                self._fts_repair_cursor = None
                connection.executescript(SCHEMA_PATH.with_name("fts.sql").read_text(encoding="utf-8"))
                try:
                    with transaction(connection):
                        connection.execute("INSERT INTO directory_fts(directory_fts, rank) VALUES ('integrity-check', 1)")
                    self._fts_ready = True
                except sqlite3.DatabaseError as exc:
                    if exc.sqlite_errorcode & SQLITE_PRIMARY_ERROR_MASK != sqlite3.SQLITE_CORRUPT:
                        raise
                    with transaction(connection):
                        connection.execute("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all')")
                with transaction(connection):
                    connection.execute("UPDATE source_metadata SET last_access_at_ms = ? WHERE id = 1", (epoch_milliseconds(),))
                    connection.execute(
                        "UPDATE generations SET state = 'retired' WHERE state = 'candidate' AND id <> "
                        "(SELECT selected_generation FROM source_metadata WHERE id = 1)"
                    )
                self._writer = connection
                self._closing = False
            except BaseException:
                connection.close()
                self._release_storage()
                raise

    def _connection(self) -> sqlite3.Connection:
        if self._writer is None or self._closing:
            raise RuntimeError("Directory index is not initialized. Wait for source initialization and retry.")
        return self._writer

    @property
    def has_active_queries(self) -> bool:
        with self._reader_condition:
            return self._active_queries > 0

    @property
    def needs_fts_repair(self) -> bool:
        return not self._fts_ready

    def _require_fts(self) -> None:
        if not self._fts_ready:
            raise RuntimeError("Directory search index is being rebuilt. Existing rows remain searchable; retry updates after repair.")

    def repair_fts_batch(self) -> bool:
        """Rebuild derived tokens without changing directory rows or freshness."""
        with self._writer_lock, self.growth_guard():
            if self._fts_ready:
                return False
            connection = self._connection()
            with transaction(connection):
                rows = connection.execute(
                    "SELECT id, path_key FROM directories WHERE ? IS NULL OR id > ? ORDER BY id LIMIT ?",
                    (self._fts_repair_cursor, self._fts_repair_cursor, ROW_BATCH_SIZE),
                ).fetchall()
                connection.executemany("INSERT INTO directory_fts(rowid, path_key) VALUES (?, ?)", rows)
                complete = len(rows) < ROW_BATCH_SIZE
                if complete:
                    connection.execute("INSERT INTO directory_fts(directory_fts, rank) VALUES ('integrity-check', 1)")
            if rows:
                last_row_id = rows[-1][0]
                if not isinstance(last_row_id, int):
                    raise ValueError("Directory row identifier is invalid. Rebuild this source index.")
                self._fts_repair_cursor = last_row_id
            self._fts_ready = complete
            return not complete

    def close(self) -> None:
        with self._reader_condition:
            self._closing = True
            self._reader_condition.wait_for(lambda: self._active_queries == 0)
            if self._writer is not None:
                self._writer.close()
                self._writer = None
            self._release_storage()

    def _revision(self, connection: sqlite3.Connection) -> None:
        revision = required_row(connection.execute("SELECT accepted_revision FROM source_metadata WHERE id = 1"))[0]
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
            with self._writer_lock, self.growth_guard():
                connection = self._connection()
                self._require_fts()
                with transaction(connection):
                    selected = required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0]
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
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            with transaction(connection):
                row = connection.execute("INSERT INTO generations(state, coverage) VALUES ('candidate', 'partial') RETURNING id").fetchone()
                if row is None:
                    raise RuntimeError("SQLite did not allocate a verification generation. Retry verification.")
                return int(row[0])
            raise RuntimeError("Verification generation allocation did not complete. Retry verification.")

    def status(self) -> DirectoryIndexSearch:
        return self.search("")

    def prepare_scan(self) -> tuple[int, bool]:
        """Resume only an untouched initial generation; verify existing data separately."""
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            self._require_fts()
            with transaction(connection):
                generation, state, count, queued, issues = required_row(
                    connection.execute(
                        "SELECT g.id, g.state, g.indexed_count, EXISTS(SELECT 1 FROM scan_queue q WHERE q.generation_id = g.id), g.issue_count "
                        "FROM generations g JOIN source_metadata m ON m.selected_generation = g.id WHERE m.id = 1"
                    )
                )
                if state == "building" and not count and not queued and not issues:
                    return int(generation), True
                candidate = required_row(
                    connection.execute("INSERT INTO generations(state, coverage) VALUES ('candidate', 'partial') RETURNING id")
                )
                return int(candidate[0]), False
        raise RuntimeError("Directory scan allocation did not complete. Retry source verification.")

    def seed_scan(self, generation_id: int) -> None:
        with self._writer_lock:
            connection = self._connection()
            with transaction(connection):
                connection.execute("INSERT INTO scan_queue(generation_id, path) VALUES (?, '') ON CONFLICT DO NOTHING", (generation_id,))

    def pending_scan_paths(self, generation_id: int, limit: int = ROW_BATCH_SIZE) -> list[str]:
        if not 1 <= limit <= ROW_BATCH_SIZE:
            raise ValueError("Scan work batch limit is outside the supported range.")
        with self._writer_lock:
            return [
                row[0]
                for row in self._connection().execute(
                    "SELECT path FROM scan_queue WHERE generation_id = ? AND processed = 0 ORDER BY path LIMIT ?", (generation_id, limit)
                )
            ]

    def write_scan_children(self, generation_id: int, children: Iterable[tuple[str, bool]]) -> None:
        batch = list(islice(children, ROW_BATCH_SIZE + 1))
        if len(batch) > ROW_BATCH_SIZE:
            raise ValueError("Scan row batch exceeds the supported limit. Split the batch.")
        for path, _ in batch:
            validate_directory_path(path)
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            self._require_fts()
            with transaction(connection):
                state = connection.execute("SELECT state FROM generations WHERE id = ?", (generation_id,)).fetchone()
                if state is None or state[0] not in {"building", "candidate"}:
                    raise ValueError("Scan generation is no longer active. Discard this batch and request verification.")
                connection.executemany(
                    "INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) "
                    "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(generation_id, path) DO NOTHING",
                    (
                        (
                            generation_id,
                            path,
                            normalize_search_text(path),
                            normalize_search_text(path.rsplit("/", 1)[-1]),
                            path.count("/"),
                            any(part.startswith(".") for part in path.split("/")),
                        )
                        for path, _ in batch
                    ),
                )
                connection.executemany(
                    "INSERT INTO scan_queue(generation_id, path) VALUES (?, ?) ON CONFLICT DO NOTHING",
                    ((generation_id, path) for path, descend in batch if descend),
                )
                if required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0] == generation_id:
                    self._revision(connection)

    def direct_child_paths(
        self, generation_id: int, parent: str, *, after_path: str | None = None, maximum_bytes: int = SCAN_BATCH_BYTES
    ) -> list[str]:
        """Page original immediate-child paths, including branches without an ancestor row."""
        if parent:
            validate_directory_path(parent)
        if after_path is not None:
            validate_directory_path(after_path)
            if after_path.rpartition("/")[0] != parent:
                raise ValueError("Child-page cursor must belong to the requested parent.")
        if type(maximum_bytes) is not int or not 1 <= maximum_bytes <= SCAN_BATCH_BYTES:
            raise ValueError("Child-page byte budget is outside the supported scan-batch range.")
        prefix = parent + "/" if parent else ""
        with self._writer_lock:
            cursor = self._connection().execute(
                "WITH suffixes AS (SELECT substr(path, length(?) + 1) AS suffix FROM directories "
                "WHERE generation_id = ? AND (? = '' OR substr(path, 1, length(?)) = ?)), "
                "children AS (SELECT ? || substr(suffix, 1, instr(suffix || '/', '/') - 1) AS path FROM suffixes) "
                "SELECT DISTINCT path FROM children WHERE (? IS NULL OR path > ?) ORDER BY path LIMIT ?",
                (prefix, generation_id, prefix, prefix, prefix, prefix, after_path, after_path, ROW_BATCH_SIZE),
            )
            result: list[str] = []
            size = 0
            try:
                for (path,) in cursor:
                    path_bytes = len(path.encode("utf-8"))
                    if path_bytes > maximum_bytes:
                        raise ValueError("Directory child exceeds the scan-page byte budget. Source coverage is incomplete.")
                    if size + path_bytes > maximum_bytes:
                        break
                    result.append(path)
                    size += path_bytes
            finally:
                cursor.close()
            return result

    def prune_subtree_batch(self, generation_id: int, path: str) -> bool:
        """Remove bounded missing-subtree work; return whether more work remains."""
        validate_directory_path(path)
        prefix = path + "/"
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            self._require_fts()
            with transaction(connection):
                state = connection.execute("SELECT state FROM generations WHERE id = ?", (generation_id,)).fetchone()
                if state is None or state[0] not in {"building", "candidate", "accepted"}:
                    raise ValueError("Reconciliation generation is no longer active. Discard this observation and request verification.")
                removed = connection.execute(
                    "DELETE FROM directories WHERE id IN (SELECT id FROM directories WHERE generation_id = ? "
                    "AND (path = ? OR substr(path, 1, length(?)) = ?) ORDER BY id LIMIT ?)",
                    (generation_id, path, prefix, prefix, ROW_BATCH_SIZE),
                ).rowcount
                queued = connection.execute(
                    "DELETE FROM scan_queue WHERE generation_id = ? AND path IN (SELECT path FROM scan_queue "
                    "WHERE generation_id = ? AND (path = ? OR substr(path, 1, length(?)) = ?) ORDER BY path LIMIT ?)",
                    (generation_id, generation_id, path, prefix, prefix, ROW_BATCH_SIZE),
                ).rowcount
                if (removed or queued) and required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[
                    0
                ] == generation_id:
                    self._revision(connection)
                return bool(
                    required_row(
                        connection.execute(
                            "SELECT EXISTS(SELECT 1 FROM directories WHERE generation_id = ? "
                            "AND (path = ? OR substr(path, 1, length(?)) = ?)) OR EXISTS(SELECT 1 FROM scan_queue "
                            "WHERE generation_id = ? AND (path = ? OR substr(path, 1, length(?)) = ?))",
                            (generation_id, path, prefix, prefix, generation_id, path, prefix, prefix),
                        )
                    )[0]
                )
        raise RuntimeError("Directory reconciliation did not complete. Retry source verification.")

    def record_unsafe_traversal(self, generation_id: int) -> None:
        """Record an excluded directory without selecting an incomplete candidate."""
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            with transaction(connection):
                state = connection.execute("SELECT state FROM generations WHERE id = ?", (generation_id,)).fetchone()
                if state is None or state[0] not in {"building", "candidate"}:
                    raise ValueError("Traversal issue belongs to an inactive scan. Restart source verification.")
                connection.execute(
                    "INSERT INTO coverage_issues(generation_id, code, count) VALUES (?, 'unsafe_traversal', 1) "
                    "ON CONFLICT(generation_id, code) DO UPDATE SET count = count + 1",
                    (generation_id,),
                )
                connection.execute(
                    "UPDATE generations SET issue_count = (SELECT sum(count) FROM coverage_issues WHERE generation_id = ?), "
                    "coverage = CASE WHEN coverage = 'uncertain' THEN 'uncertain' ELSE 'partial' END WHERE id = ?",
                    (generation_id, generation_id),
                )
                if required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0] == generation_id:
                    self._revision(connection)

    def finish_scan_parent(self, generation_id: int, path: str) -> None:
        with self._writer_lock:
            connection = self._connection()
            with transaction(connection):
                connection.execute("UPDATE scan_queue SET processed = 1 WHERE generation_id = ? AND path = ?", (generation_id, path))

    def discard_generation(self, generation_id: int) -> None:
        with self._writer_lock:
            connection = self._connection()
            with transaction(connection):
                connection.execute(
                    "UPDATE generations SET state = 'retired' WHERE id = ? AND id <> (SELECT selected_generation FROM source_metadata WHERE id = 1)",
                    (generation_id,),
                )

    def checkpoint(self) -> None:
        with self._writer_lock:
            self._connection().execute("PRAGMA wal_checkpoint(PASSIVE)")

    def checkpoint_if_due(self) -> bool:
        """Checkpoint only a large WAL; pinned readers retain retry eligibility."""
        with self._writer_lock:
            if self.has_active_queries:
                return False
            try:
                metadata = Path(str(self.path) + "-wal").lstat()
            except FileNotFoundError:
                return True
            if not stat.S_ISREG(metadata.st_mode):
                raise PermissionError("Directory-index WAL must be a regular file. Correct private cache storage and retry.")
            if metadata.st_size < CHECKPOINT_WAL_BYTES:
                return True
            with self.growth_guard():
                connection = self._connection()
                busy, total, completed = required_row(connection.execute("PRAGMA wal_checkpoint(PASSIVE)"))
                if busy or total != completed:
                    return False
                busy, total, completed = required_row(connection.execute("PRAGMA wal_checkpoint(TRUNCATE)"))
                return not busy and total == completed

    def touch_access(self, accessed_at_ms: int) -> None:
        if type(accessed_at_ms) is not int or not 0 <= accessed_at_ms <= MAX_SIGNED_INTEGER:
            raise ValueError("Directory-index access time is invalid. Check the host clock and retry.")
        with self._writer_lock, self.growth_guard():
            self._connection().execute("UPDATE source_metadata SET last_access_at_ms = ? WHERE id = 1", (accessed_at_ms,))

    def reclaim_pages(self) -> bool:
        """Run one admitted reclamation step; false means readers deferred it."""
        with self._writer_lock, self.growth_guard():
            if self._active_queries:
                return False
            connection = self._connection()
            if required_row(connection.execute("PRAGMA auto_vacuum"))[0] != INCREMENTAL_VACUUM_MODE:
                raise ValueError("Directory storage does not support incremental reclamation. Rebuild this source index.")
            if required_row(connection.execute("PRAGMA freelist_count"))[0] == 0:
                return True
            busy, total, completed = required_row(connection.execute("PRAGMA wal_checkpoint(PASSIVE)"))
            if busy or total != completed:
                return False
            connection.execute(f"PRAGMA incremental_vacuum({MAINTENANCE_PAGE_BATCH})").fetchall()
            busy, total, completed = required_row(connection.execute("PRAGMA wal_checkpoint(TRUNCATE)"))
            return not busy and total == completed

    def cleanup_retired_batch(self) -> bool:
        """Remove bounded retired rows; return whether logical cleanup remains."""
        with self._writer_lock, self.growth_guard():
            self._require_fts()
            connection = self._connection()
            if self._active_queries:
                return True
            with transaction(connection):
                retired = connection.execute(
                    "SELECT id FROM generations WHERE state = 'retired' AND id <> "
                    "(SELECT selected_generation FROM source_metadata WHERE id = 1) ORDER BY id LIMIT 1"
                ).fetchone()
                if retired is None:
                    return False
                generation = retired[0]
                connection.execute(
                    "DELETE FROM directories WHERE id IN (SELECT id FROM directories WHERE generation_id = ? ORDER BY id LIMIT ?)",
                    (generation, ROW_BATCH_SIZE),
                )
                connection.execute(
                    "DELETE FROM scan_queue WHERE generation_id = ? AND path IN "
                    "(SELECT path FROM scan_queue WHERE generation_id = ? ORDER BY path LIMIT ?)",
                    (generation, generation, ROW_BATCH_SIZE),
                )
                connection.execute(
                    "DELETE FROM generations WHERE id = ? AND NOT EXISTS "
                    "(SELECT 1 FROM directories WHERE generation_id = ?) AND NOT EXISTS "
                    "(SELECT 1 FROM scan_queue WHERE generation_id = ?)",
                    (generation, generation, generation),
                )
                return connection.execute("SELECT 1 FROM generations WHERE state = 'retired' LIMIT 1").fetchone() is not None
        raise RuntimeError("Directory cleanup did not complete. Retry background cleanup.")

    def mark_uncertain(self) -> None:
        """Persist event loss without removing rows or advancing verification time."""
        with self._writer_lock:
            connection = self._connection()
            with transaction(connection):
                generation = required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0]
                connection.execute(
                    "INSERT INTO coverage_issues(generation_id, code, count) VALUES (?, 'event_loss', 1) "
                    "ON CONFLICT(generation_id, code) DO NOTHING",
                    (generation,),
                )
                connection.execute(
                    "UPDATE generations SET coverage = 'uncertain', issue_count = "
                    "(SELECT sum(count) FROM coverage_issues WHERE generation_id = ?) WHERE id = ?",
                    (generation, generation),
                )
                self._revision(connection)

    def mutate_path(self, action: Literal["add", "remove", "rename"], path: str, new_path: str | None = None) -> None:
        """Apply one observation to both accepted rows and active verification rows."""
        validate_directory_path(path)
        if action == "rename":
            if new_path is None:
                raise ValueError("A directory rename requires a new relative path.")
            validate_directory_path(new_path)
            if new_path == path:
                return
            if new_path.startswith(path + "/"):
                raise ValueError("A directory cannot be renamed into its own subtree.")
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            self._require_fts()
            connection.create_function("normalize_directory_key", 1, sql_normalize_key, deterministic=True)
            connection.create_function("directory_basename_key", 1, sql_basename_key, deterministic=True)
            connection.create_function("directory_dot_path", 1, sql_dot_path, deterministic=True)
            with transaction(connection):
                generations = connection.execute(
                    "SELECT id FROM generations WHERE state IN ('building', 'accepted', 'candidate')"
                ).fetchall()
                for (generation_id,) in generations:
                    if action == "add":
                        connection.execute(
                            "INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) "
                            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(generation_id, path) DO NOTHING",
                            (
                                generation_id,
                                path,
                                normalize_search_text(path),
                                normalize_search_text(path.rsplit("/", 1)[-1]),
                                path.count("/"),
                                any(part.startswith(".") for part in path.split("/")),
                            ),
                        )
                        connection.execute(
                            "INSERT INTO scan_queue(generation_id, path) SELECT id, ? FROM generations "
                            "WHERE id = ? AND state IN ('building', 'candidate') "
                            "ON CONFLICT(generation_id, path) DO UPDATE SET processed = 0",
                            (path, generation_id),
                        )
                    elif action == "remove":
                        connection.execute(
                            "DELETE FROM directories WHERE generation_id = ? AND (path = ? OR substr(path, 1, ?) = ?)",
                            (generation_id, path, len(path) + 1, path + "/"),
                        )
                        connection.execute(
                            "DELETE FROM scan_queue WHERE generation_id = ? AND (path = ? OR substr(path, 1, ?) = ?)",
                            (generation_id, path, len(path) + 1, path + "/"),
                        )
                    elif action == "rename" and new_path is not None:
                        expression = "? || substr(path, ?)"
                        connection.execute(
                            f"UPDATE directories SET path = {expression}, path_key = normalize_directory_key({expression}), "
                            f"basename_key = directory_basename_key({expression}), has_dot_directory = directory_dot_path({expression}), "
                            "depth = depth + ? WHERE generation_id = ? AND (path = ? OR substr(path, 1, ?) = ?)",
                            (
                                new_path,
                                len(path) + 1,
                                new_path,
                                len(path) + 1,
                                new_path,
                                len(path) + 1,
                                new_path,
                                len(path) + 1,
                                new_path.count("/") - path.count("/"),
                                generation_id,
                                path,
                                len(path) + 1,
                                path + "/",
                            ),
                        )
                        connection.execute(
                            "UPDATE scan_queue SET path = ? || substr(path, ?), processed = 0 "
                            "WHERE generation_id = ? AND (path = ? OR substr(path, 1, ?) = ?)",
                            (new_path, len(path) + 1, generation_id, path, len(path) + 1, path + "/"),
                        )
                    else:
                        raise ValueError("Unsupported directory mutation. Use add, remove, or rename.")
                self._revision(connection)

    def finish_generation(self, generation_id: int, *, issue_count: int = 0) -> bool:
        """Only issue-free full passes select candidates and advance verification time."""
        if not 0 <= issue_count <= MAX_SIGNED_INTEGER:
            raise ValueError("Coverage issue count is outside the supported range.")
        with self._writer_lock:
            connection = self._connection()
            with transaction(connection):
                row = connection.execute("SELECT state FROM generations WHERE id = ?", (generation_id,)).fetchone()
                if row is None or row[0] not in {"candidate", "building"}:
                    raise ValueError("Generation is not an active build or verification candidate.")
                stored_issues = required_row(
                    connection.execute("SELECT coalesce(sum(count), 0) FROM coverage_issues WHERE generation_id = ?", (generation_id,))
                )[0]
                additional_issues = max(0, issue_count - stored_issues)
                if additional_issues:
                    connection.execute(
                        "INSERT INTO coverage_issues(generation_id, code, count) VALUES (?, 'scan_failed', ?) "
                        "ON CONFLICT(generation_id, code) DO UPDATE SET count = count + excluded.count",
                        (generation_id, additional_issues),
                    )
                unresolved = max(issue_count, stored_issues)
                if unresolved:
                    connection.execute(
                        "UPDATE generations SET issue_count = ?, coverage = CASE WHEN coverage = 'uncertain' THEN 'uncertain' ELSE 'partial' END WHERE id = ?",
                        (unresolved, generation_id),
                    )
                    selected = required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0]
                    if selected == generation_id:
                        self._revision(connection)
                    return False
                if connection.execute(
                    "SELECT 1 FROM scan_queue WHERE generation_id = ? AND processed = 0 LIMIT 1", (generation_id,)
                ).fetchone():
                    raise ValueError("Scan work remains queued. Complete the scan before selecting this generation.")
                previous = required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0]
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
            raise RuntimeError("Directory generation selection did not complete. Retry verification.")

    def search(
        self,
        query: str,
        *,
        limit: int = MAX_RESULT_LIMIT,
        include_dot_directories: bool = False,
        cancelled: threading.Event | None = None,
        force_scan: bool = False,
    ) -> DirectoryIndexSearch:
        if not self._query_slots.acquire(timeout=SQL_BUSY_TIMEOUT_MS / 1000):
            raise TimeoutError("Directory query workers are busy. Wait briefly and retry the search.")
        admitted = False
        try:
            with self._reader_condition:
                self._connection()
                self._active_queries += 1
                admitted = True
            return self._search(
                query, limit=limit, include_dot_directories=include_dot_directories, cancelled=cancelled, force_scan=force_scan
            )
        except sqlite3.OperationalError as exc:
            if exc.sqlite_errorcode == sqlite3.SQLITE_INTERRUPT:
                raise InterruptedError("Directory search was cancelled or timed out. Retry the search.") from exc
            raise
        finally:
            with self._reader_condition:
                if admitted:
                    self._active_queries -= 1
                    self._reader_condition.notify_all()
            self._query_slots.release()

    def _search(
        self,
        query: str,
        *,
        limit: int = MAX_RESULT_LIMIT,
        include_dot_directories: bool = False,
        cancelled: threading.Event | None = None,
        force_scan: bool = False,
    ) -> DirectoryIndexSearch:
        terms = search_terms(query)
        if not 1 <= limit <= MAX_RESULT_LIMIT:
            raise ValueError(f"Result limit must be between 1 and {MAX_RESULT_LIMIT}.")
        deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS

        def interrupted() -> bool:
            return bool(cancelled is not None and cancelled.is_set()) or time.monotonic() >= deadline

        if interrupted():
            raise InterruptedError("Directory search was cancelled or timed out. Retry the search.")
        fts_ready = self._fts_ready
        with closing(self._connect(readonly=True)) as connection:
            connection.set_progress_handler(interrupted, SQL_PROGRESS_STEPS)
            with transaction(connection):
                metadata = required_row(
                    connection.execute(
                        "SELECT selected_generation, accepted_revision, last_verified_at_ms FROM source_metadata WHERE id = 1"
                    )
                )
                generation_id, revision, verified = metadata
                directory_count, coverage, issue_count = required_row(
                    connection.execute("SELECT indexed_count, coverage, issue_count FROM generations WHERE id = ?", (generation_id,))
                )
                plan: Literal["empty", "trigram", "scan"] = "empty"
                count = 0
                if not terms:
                    return DirectoryIndexSearch((), count, directory_count, revision, coverage, verified, plan, issue_count)
                plan = "trigram" if fts_ready and not force_scan and all(len(term) >= 3 for term in terms) else "scan"
                columns = "SELECT directories.path, directories.path_key, directories.basename_key, directories.depth "
                sql = columns + (
                    "FROM directory_fts CROSS JOIN directories WHERE directories.id = directory_fts.rowid AND directories.generation_id = ?"
                    if plan == "trigram"
                    else "FROM directories WHERE directories.generation_id = ?"
                )
                parameters: list[str | int] = [generation_id]
                if not include_dot_directories:
                    sql += " AND directories.has_dot_directory = 0"
                if plan == "trigram":
                    sql += " AND directory_fts MATCH ?"
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
                return DirectoryIndexSearch(rows, count, directory_count, revision, coverage, verified, plan, issue_count)
            raise RuntimeError("Directory search did not complete. Retry the search.")
