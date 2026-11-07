"""Disk-backed directory storage; callers own source authorization and worker admission."""

from __future__ import annotations

import heapq
import json
import logging
import os
import sqlite3
import stat
import sys
import threading
import time
import unicodedata
from bisect import insort
from contextlib import AbstractContextManager, closing, contextmanager, nullcontext
from dataclasses import dataclass
from itertools import islice
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Literal

from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT, MAX_SQL_INTEGER

APPLICATION_ID = 1396853073
SCHEMA_VERSION = DIRECTORY_INDEX_CONTRACT.limits["schema_version"]
REQUIRED_DIRECTORY_TABLES = ("source_metadata", "generations", "directories", "scan_queue", "coverage_issues", "scan_snapshot_children")
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
QUARANTINE_FILE_NAME = ".rejected-directory-index"
INCREMENTAL_VACUUM_MODE = 2
PAGE_CACHE_KIB = DIRECTORY_INDEX_CONTRACT.policy["page_cache_kib"].default
SQL_BUSY_TIMEOUT_MS = DIRECTORY_INDEX_CONTRACT.limits["busy_timeout_ms"]
SCAN_COMMIT_INTERVAL_SECONDS = DIRECTORY_INDEX_CONTRACT.limits["scan_commit_interval_ms"] / 1000
SCAN_COMMIT_MAX_PARENTS = DIRECTORY_INDEX_CONTRACT.limits["scan_commit_max_parents"]
SCAN_BOOKKEEPING_COMMIT_INTERVAL_SECONDS = DIRECTORY_INDEX_CONTRACT.limits["scan_bookkeeping_commit_interval_ms"] / 1000
SCAN_BOOKKEEPING_COMMIT_MAX_PARENTS = DIRECTORY_INDEX_CONTRACT.limits["scan_bookkeeping_commit_max_parents"]
SQLITE_CACHE_SYNCHRONOUS = "NORMAL"
SCAN_FILE_ID_UPDATE_SQL = (
    "file_id = :file_id, processed = CASE WHEN scan_queue.file_id IS NOT NULL "
    "AND scan_queue.file_id <> :file_id THEN 0 ELSE scan_queue.processed END "
    "WHERE :file_id IS NOT NULL AND scan_queue.file_id IS NOT :file_id"
)
QUERY_WORKERS = DIRECTORY_INDEX_CONTRACT.limits["query_workers"]
SQL_PROGRESS_STEPS = DIRECTORY_INDEX_CONTRACT.limits["progress_steps"]
QUERY_TIMEOUT_SECONDS = DIRECTORY_INDEX_CONTRACT.limits["query_timeout_seconds"]
MAX_SIGNED_INTEGER = MAX_SQL_INTEGER
ITEM_ISSUE_CODES = frozenset({"unsafe_traversal", "access_denied", "unsupported_encoding", "scan_failed"})
SCHEMA_PATH_CANDIDATES = tuple(Path(__file__).resolve().parents[level] / "shared" / "directory-index" / "schema.sql" for level in (3, 2))
SCHEMA_PATH = next((path for path in SCHEMA_PATH_CANDIDATES if path.is_file()), SCHEMA_PATH_CANDIDATES[0])
PRIVATE_DIRECTORY_MODE = 0o700
LEASE_FILE_MODE = 0o600
ROOT_USER_ID = 0
STORAGE_FILE_SUFFIXES = ("", "-wal", "-shm", "-journal", ".lease")
MIN_SQLITE_VERSION_NUMBER = DIRECTORY_INDEX_CONTRACT.limits["minimum_sqlite_version_number"]
MIN_SQLITE_VERSION = (MIN_SQLITE_VERSION_NUMBER // 1_000_000, MIN_SQLITE_VERSION_NUMBER // 1_000 % 1_000, MIN_SQLITE_VERSION_NUMBER % 1_000)
SQLITE_PRIMARY_ERROR_MASK = 0xFF
SLOW_TRANSACTION_SECONDS = 1.0
logger = logging.getLogger(__name__)


class DirectoryIndexRebuildRequired(ValueError):
    """Validated application storage cannot publish its disposable directory data."""


def validate_storage_ancestors(directory: Path) -> None:
    """Reject storage ancestry controlled or replaceable by another account."""
    directory = directory.absolute()
    for ancestor in (directory, *directory.parents):
        try:
            metadata = ancestor.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise PermissionError("Directory-index storage must not use symbolic links. Select a private local directory.")
        if not stat.S_ISDIR(metadata.st_mode):
            raise PermissionError("Directory-index storage ancestors must be real directories. Select private local storage.")
        if os.name == "posix":
            if ancestor == directory and (metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077):
                raise PermissionError(
                    "Directory-index storage must belong to the service account with mode 0700. Correct its owner and permissions."
                )
            if metadata.st_uid not in {os.getuid(), ROOT_USER_ID} or (
                metadata.st_mode & (stat.S_IWGRP | stat.S_IWOTH) and not metadata.st_mode & stat.S_ISVTX
            ):
                raise PermissionError(
                    "Directory-index storage has an unsafe ancestor. Use directories owned by the service account or root, "
                    "and remove group/public write access or use a trusted sticky parent."
                )


class DirectoryDatabaseConnection(sqlite3.Connection):
    on_commit: Callable[[], None] | None = None


def connect_directory_database(path: Path, *, readonly: bool = False) -> sqlite3.Connection:
    """Open existing private storage without creating a file or accepting a link."""
    path = path.absolute()
    validate_storage_ancestors(path.parent)
    DirectoryIndex._validate_storage_files(path)
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
        factory=DirectoryDatabaseConnection,
    )
    try:
        after = path.lstat()
        if not stat.S_ISREG(after.st_mode) or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise PermissionError("Directory-index database changed during open. Stop the source and correct private cache storage.")
        validate_storage_ancestors(path.parent)
        DirectoryIndex._validate_storage_files(path)
        return connection
    except BaseException:
        connection.close()
        raise


@contextmanager
def held_storage_directory(directory: Path) -> Iterator[int | None]:
    """Keep POSIX namespace mutations bound to the directory that was validated."""
    validate_storage_ancestors(directory)
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW) if os.name == "posix" else None
    try:
        validate_storage_binding(directory, descriptor)
        yield descriptor
    finally:
        if descriptor is not None:
            os.close(descriptor)


def validate_storage_binding(directory: Path, descriptor: int | None) -> None:
    """Refuse a namespace replacement before a retained-directory mutation."""
    validate_storage_ancestors(directory)
    if descriptor is not None:
        held = os.fstat(descriptor)
        current = directory.lstat()
        if (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
            raise PermissionError("Directory storage changed during cleanup. Restore the private namespace and retry cleanup.")


@contextmanager
def transaction(connection: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """Include initial reads and all changes in one explicitly started transaction."""
    if connection.in_transaction:
        connection.execute("SAVEPOINT directory_write")
        try:
            yield connection
        except BaseException:
            connection.execute("ROLLBACK TO directory_write")
            connection.execute("RELEASE directory_write")
            raise
        else:
            connection.execute("RELEASE directory_write")
        return
    started = time.monotonic()
    try:
        with connection:
            connection.execute("BEGIN")
            yield connection
    except sqlite3.DatabaseError as error:
        logger.warning(
            "Directory transaction failed. Restore storage or retry after contention.",
            extra={
                "event": "directory_transaction_failed",
                "sqlite_errorcode": getattr(error, "sqlite_errorcode", 0) & SQLITE_PRIMARY_ERROR_MASK,
            },
        )
        raise
    if isinstance(connection, DirectoryDatabaseConnection) and connection.on_commit is not None:
        connection.on_commit()
    duration = time.monotonic() - started
    if duration >= SLOW_TRANSACTION_SECONDS:
        logger.warning(
            "Directory transaction was slow.",
            extra={"event": "directory_transaction_slow", "duration_ms": round(duration * 1000, 3)},
        )


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
        self._readers: list[tuple[sqlite3.Connection, tuple[int, int]]] = []
        self._status_snapshot: DirectoryIndexSearch | None = None
        self._lease_fd: int | None = None
        self._fts_ready = False
        self._fts_repair_cursor: int | None = None
        self._recovery_attempted = False
        self._quarantine_restore_failed = False
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
            DirectoryIndex._validate_storage_files(path)
            return DirectoryIndex._acquire_file_lease(Path(str(path) + ".lease"))
        finally:
            os.close(namespace_descriptor)

    @staticmethod
    def _validate_storage_files(path: Path) -> None:
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

    @staticmethod
    def _clear_quarantine_owned(path: Path) -> bool:
        with held_storage_directory(path.parent) as directory_descriptor:
            DirectoryIndex._validate_storage_files(path)
            removed = False
            for suffix in STORAGE_FILE_SUFFIXES:
                if suffix == ".lease":
                    continue
                candidate = Path(str(path) + suffix)
                validate_storage_binding(path.parent, directory_descriptor)
                try:
                    if directory_descriptor is None:
                        candidate.unlink()
                    else:
                        os.unlink(candidate.name, dir_fd=directory_descriptor)
                    removed = True
                except FileNotFoundError:
                    pass
            return removed

    @staticmethod
    def discard_quarantine(directory: Path) -> bool:
        """Evict the single inactive rejected family under namespace ownership."""
        path = directory / QUARANTINE_FILE_NAME
        if not any(Path(str(path) + suffix).exists() for suffix in STORAGE_FILE_SUFFIXES if suffix != ".lease"):
            return False
        namespace_descriptor = DirectoryIndex.acquire_namespace_lease(directory)
        try:
            path = directory / QUARANTINE_FILE_NAME
            descriptor = DirectoryIndex._acquire_file_lease(Path(str(path) + ".lease"))
            try:
                return DirectoryIndex._clear_quarantine_owned(path)
            finally:
                os.close(descriptor)
        finally:
            os.close(namespace_descriptor)

    def _quarantine_owned(self) -> None:
        if self._writer is not None or self._lease_fd is None or self._active_queries:
            raise BlockingIOError("Directory recovery is still in use. Wait for source workers to close before retrying.")
        self._quarantine_restore_failed = False
        namespace_descriptor = self.acquire_namespace_lease(self.path.parent)
        try:
            path = self.path.parent / QUARANTINE_FILE_NAME
            descriptor = self._acquire_file_lease(Path(str(path) + ".lease"))
            try:
                self._validate_storage_files(self.path)
                self._clear_quarantine_owned(path)
                moved: list[tuple[Path, Path]] = []
                with held_storage_directory(path.parent) as directory_descriptor:

                    def move(original: Path, rejected: Path) -> None:
                        validate_storage_binding(path.parent, directory_descriptor)
                        if directory_descriptor is None:
                            os.replace(original, rejected)
                        else:
                            os.replace(original.name, rejected.name, src_dir_fd=directory_descriptor, dst_dir_fd=directory_descriptor)

                    try:
                        for suffix in (*[suffix for suffix in STORAGE_FILE_SUFFIXES if suffix not in {"", ".lease"}], ""):
                            original = Path(str(self.path) + suffix)
                            rejected = Path(str(path) + suffix)
                            try:
                                move(original, rejected)
                            except FileNotFoundError:
                                continue
                            moved.append((original, rejected))
                    except BaseException:
                        for original, rejected in reversed(moved):
                            try:
                                move(rejected, original)
                            except OSError as error:
                                self._quarantine_restore_failed = True
                                logger.warning(
                                    "Directory recovery restore failed (%s). Reconnect after restoring private storage.",
                                    type(error).__name__,
                                )
                        raise
            finally:
                os.close(descriptor)
        finally:
            os.close(namespace_descriptor)

    @staticmethod
    def acquire_namespace_lease(directory: Path) -> int:
        """Serialize lease creation and inode cleanup across processes."""
        directory = directory.absolute()
        validate_storage_ancestors(directory)
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
            with held_storage_directory(path.parent) as directory_descriptor:
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
                validate_storage_binding(path.parent, directory_descriptor)
                candidate = Path(str(path) + ".lease")
                if directory_descriptor is None:
                    candidate.unlink()
                else:
                    os.unlink(candidate.name, dir_fd=directory_descriptor)
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
            connection.execute(f"PRAGMA synchronous = {SQLITE_CACHE_SYNCHRONOUS}")
            return connection
        except BaseException:
            connection.close()
            raise

    def open(self, *, rebuild_invalid: bool = False) -> None:
        """Validate storage and optionally replace disposable invalid data once."""
        with self._writer_lock:
            if self._writer is not None:
                return
            validate_sqlite_runtime()
            with self.growth_guard():
                self._acquire_storage()
                try:
                    try:
                        self._open_owned()
                    except (DirectoryIndexRebuildRequired, sqlite3.DatabaseError) as error:
                        rebuildable = isinstance(error, DirectoryIndexRebuildRequired) or (
                            getattr(error, "sqlite_errorcode", 0) & SQLITE_PRIMARY_ERROR_MASK
                            in {sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB}
                        )
                        if not rebuild_invalid or not rebuildable:
                            raise
                        if self._recovery_attempted:
                            raise RuntimeError(
                                "Directory recovery already failed after replacement. Restore private storage capacity and permissions, "
                                "then reconnect the source."
                            ) from error
                        try:
                            self._quarantine_owned()
                        except BaseException:
                            self._recovery_attempted = self._quarantine_restore_failed
                            raise
                        self._recovery_attempted = True
                        self._open_owned()
                        logger.debug("Directory storage recovered.", extra={"event": "directory_storage_recovered"})
                finally:
                    if self._writer is None:
                        self._release_storage()

    def _open_owned(self) -> None:
        with self._writer_lock:
            created = not self.path.exists()
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
            try:
                if required_row(connection.execute("PRAGMA application_id"))[0] != APPLICATION_ID:
                    raise ValueError("Directory database application identifier is invalid. Rebuild this source index.")
                if required_row(connection.execute("PRAGMA user_version"))[0] != SCHEMA_VERSION:
                    raise DirectoryIndexRebuildRequired("Directory database schema is unsupported. Rebuild this source index.")
                placeholders = ",".join("?" for _ in REQUIRED_DIRECTORY_TABLES)
                table_count = required_row(
                    connection.execute(
                        f"SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN ({placeholders})",
                        REQUIRED_DIRECTORY_TABLES,
                    )
                )[0]
                if table_count != len(REQUIRED_DIRECTORY_TABLES):
                    raise DirectoryIndexRebuildRequired("Directory database tables are missing. Rebuild this source index.")
                if connection.execute(
                    "SELECT type, \"notnull\" FROM pragma_table_info('scan_queue') WHERE name = 'file_id'"
                ).fetchone() != ("BLOB", 0):
                    raise DirectoryIndexRebuildRequired("Directory scan FileId storage is invalid. Rebuild this source index.")
                if connection.execute(
                    "SELECT type, \"notnull\" FROM pragma_table_info('directories') WHERE name = 'parent_id'"
                ).fetchone() != ("INTEGER", 0) or connection.execute(
                    "SELECT group_concat(name, ',') FROM pragma_index_info('directories_parent')"
                ).fetchone() != ("generation_id,parent_id",):
                    raise DirectoryIndexRebuildRequired("Directory parent storage is invalid. Rebuild this source index.")
                metadata = connection.execute(
                    "SELECT source_kind, source_identity, normalization_version, traversal_version FROM source_metadata WHERE id = 1"
                ).fetchone()
                if metadata is None:
                    raise DirectoryIndexRebuildRequired("Directory database source metadata is missing. Rebuild this source index.")
                if metadata[:2] != (self.source_kind, self.source_identity):
                    raise ValueError("Directory database source or policy does not match. Rebuild this source index.")
                if metadata[2:] != (NORMALIZATION_VERSION, TRAVERSAL_VERSION):
                    raise DirectoryIndexRebuildRequired("Directory database source or policy does not match. Rebuild this source index.")
                if connection.execute(
                    "SELECT type, \"notnull\" FROM pragma_table_info('source_metadata') WHERE name = 'clean_shutdown'"
                ).fetchone() != ("INTEGER", 1):
                    raise DirectoryIndexRebuildRequired("Directory shutdown metadata is invalid. Rebuild this source index.")
                clean_shutdown = bool(required_row(connection.execute("SELECT clean_shutdown FROM source_metadata WHERE id = 1"))[0])
                if not clean_shutdown and connection.execute("PRAGMA quick_check").fetchone() != ("ok",):
                    raise DirectoryIndexRebuildRequired("Directory database integrity check failed. Rebuild this source index.")
                if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise DirectoryIndexRebuildRequired("Directory database references are invalid. Rebuild this source index.")
                if required_row(connection.execute(SCHEMA_PATH.with_name("validate-generations.sql").read_text(encoding="utf-8")))[0]:
                    raise DirectoryIndexRebuildRequired("Directory database generation metadata is invalid. Rebuild this source index.")
                if connection.execute("PRAGMA journal_mode = WAL").fetchone() != ("wal",):
                    raise RuntimeError("Directory-index storage does not support WAL. Select supported private local storage.")
                self._fts_ready = False
                self._fts_repair_cursor = None
                try:
                    self._prepare_fts(connection, clean_shutdown=clean_shutdown)
                except sqlite3.DatabaseError as error:
                    if getattr(error, "sqlite_errorcode", 0) & SQLITE_PRIMARY_ERROR_MASK not in {
                        sqlite3.SQLITE_CORRUPT,
                        sqlite3.SQLITE_NOTADB,
                    }:
                        raise
                    raise RuntimeError(
                        "Directory search token repair could not start. Validated directory data was retained. "
                        "Restore private storage and retry the source."
                    ) from error
                with transaction(connection):
                    connection.execute(
                        "UPDATE source_metadata SET last_access_at_ms = ?, clean_shutdown = 0 WHERE id = 1", (epoch_milliseconds(),)
                    )
                self._writer = connection
                self._closing = False
                self._refresh_status_snapshot()
                if isinstance(connection, DirectoryDatabaseConnection):
                    connection.on_commit = self._refresh_status_snapshot
                logger.debug("Directory storage initialized.", extra={"event": "directory_storage_initialized"})
            except BaseException:
                connection.close()
                raise

    def _prepare_fts(self, connection: sqlite3.Connection, *, clean_shutdown: bool = False) -> None:
        existing_fts = (
            required_row(
                connection.execute(
                    "SELECT count(*) FROM sqlite_master WHERE name IN ('directory_fts', 'directory_fts_data', 'directory_fts_idx', 'directory_fts_docsize', 'directory_fts_config')"
                )
            )[0]
            == 5
        )
        connection.executescript(SCHEMA_PATH.with_name("fts.sql").read_text(encoding="utf-8"))
        if clean_shutdown and existing_fts:
            self._fts_ready = True
            return
        try:
            with transaction(connection):
                connection.execute("INSERT INTO directory_fts(directory_fts, rank) VALUES ('integrity-check', 1)")
            self._fts_ready = True
        except sqlite3.DatabaseError as error:
            if getattr(error, "sqlite_errorcode", 0) & SQLITE_PRIMARY_ERROR_MASK != sqlite3.SQLITE_CORRUPT:
                raise
            with transaction(connection):
                connection.execute("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all')")

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
            for reader, _identity in self._readers:
                reader.close()
            self._readers.clear()
            if self._writer is not None:
                try:
                    if not self._writer.in_transaction and self._fts_ready:
                        self._writer.execute("UPDATE source_metadata SET clean_shutdown = 1 WHERE id = 1")
                except sqlite3.Error:
                    logger.warning("Directory storage could not record a clean close. Integrity checks will run on the next open.")
                finally:
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
        pending: str | None = None
        while True:
            batch: list[tuple[str, str, str, int, bool]] = []
            batch_bytes = 0
            for _ in range(ROW_BATCH_SIZE):
                path = pending if pending is not None else next(iterator, None)
                pending = None
                if path is None:
                    break
                validate_directory_path(path)
                path_bytes = len(path.encode("utf-8"))
                if path_bytes > SCAN_BATCH_BYTES:
                    raise ValueError("Directory path exceeds the scan-batch byte limit. Source coverage is incomplete.")
                if batch and batch_bytes + path_bytes > SCAN_BATCH_BYTES:
                    pending = path
                    break
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
                batch_bytes += path_bytes
            if not batch:
                return
            with self._writer_lock, self.growth_guard():
                connection = self._connection()
                self._require_fts()
                with transaction(connection):
                    selected = required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0]
                    target = selected if generation_id is None else generation_id
                    if generation_id is not None:
                        state = connection.execute("SELECT state, scan_active FROM generations WHERE id = ?", (target,)).fetchone()
                        if state is None or (state[0] != "building" and not state[1]):
                            raise ValueError("Scan generation is no longer active. Discard this batch and request verification.")
                    connection.executemany(
                        "INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory, parent_id) "
                        "VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM directories WHERE generation_id = ? AND path = ?)) "
                        "ON CONFLICT(generation_id, path) DO NOTHING",
                        ((target, *row, target, row[0].rpartition("/")[0]) for row in batch),
                    )
                    if target == selected:
                        self._revision(connection)

    def status(self) -> DirectoryIndexSearch:
        with self._writer_lock:
            count, revision, coverage, verified, issues = required_row(
                self._connection().execute(
                    "SELECT g.indexed_count, m.accepted_revision, g.coverage, m.last_verified_at_ms, g.issue_count "
                    "FROM source_metadata m JOIN generations g ON g.id = m.selected_generation WHERE m.id = 1"
                )
            )
            return DirectoryIndexSearch((), 0, count, revision, coverage, verified, "empty", issues)

    def _refresh_status_snapshot(self) -> None:
        self._status_snapshot = self.status()

    def cached_status(self) -> DirectoryIndexSearch:
        snapshot = self._status_snapshot
        if snapshot is None:
            raise RuntimeError("Directory index is not initialized. Wait for source initialization and retry.")
        return snapshot

    def scan_counts(self, generation_id: int) -> tuple[int, int, int]:
        """Read counters through the owned writer without opening a poll connection."""
        with self._writer_lock:
            done, queued, found = required_row(
                self._connection().execute(
                    "SELECT (SELECT count(*) FROM scan_queue WHERE generation_id = g.id AND processed = 1), "
                    "(SELECT count(*) FROM scan_queue WHERE generation_id = g.id AND processed = 0), indexed_count "
                    "FROM generations g WHERE id = ?",
                    (generation_id,),
                )
            )
            return done, queued, found

    def generation_directory_count(self, generation_id: int) -> int:
        with self._writer_lock:
            return int(required_row(self._connection().execute("SELECT indexed_count FROM generations WHERE id = ?", (generation_id,)))[0])

    def scan_parent_pending(self, generation_id: int, parent: str) -> bool:
        with self._writer_lock:
            return bool(
                required_row(
                    self._connection().execute(
                        "SELECT EXISTS(SELECT 1 FROM scan_queue WHERE generation_id = ? AND path = ? AND processed = 0)",
                        (generation_id, parent),
                    )
                )[0]
            )

    def has_resumable_scan(self) -> bool:
        """Return whether the selected build or verification pass can continue."""
        with self._writer_lock:
            return bool(
                required_row(
                    self._connection().execute("SELECT EXISTS(SELECT 1 FROM generations WHERE scan_active = 1 OR state = 'building')")
                )[0]
            )

    def has_pending_scan(self) -> bool:
        """Keep source ownership while persisted scan work remains."""
        with self._writer_lock:
            if self._writer is None:
                return False
            return bool(
                required_row(
                    self._connection().execute(
                        "SELECT EXISTS(SELECT 1 FROM scan_queue q JOIN generations g ON g.id = q.generation_id "
                        "WHERE q.processed = 0 AND g.state IN ('building', 'accepted'))"
                    )
                )[0]
            )

    def prepare_scan(self) -> tuple[int, bool]:
        """Resume best-effort verification work without trusting the selected rows."""
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            self._require_fts()
            with transaction(connection):
                generation, state, count, queued, issues, active = required_row(
                    connection.execute(
                        "SELECT g.id, g.state, g.indexed_count, EXISTS(SELECT 1 FROM scan_queue q WHERE q.generation_id = g.id), g.issue_count, g.scan_active "
                        "FROM generations g JOIN source_metadata m ON m.selected_generation = g.id WHERE m.id = 1"
                    )
                )
                if active or state == "building":
                    if not active:
                        connection.execute(
                            "UPDATE generations SET scan_active = 1, scan_pass_id = scan_pass_id + 1 WHERE id = ?", (generation,)
                        )
                    if issues:
                        connection.execute("DELETE FROM coverage_issues WHERE generation_id = ? AND code = 'event_loss'", (generation,))
                        connection.execute(
                            "UPDATE generations SET coverage = 'partial', issue_count = "
                            "(SELECT coalesce(sum(count), 0) FROM coverage_issues WHERE generation_id = ?) WHERE id = ?",
                            (generation, generation),
                        )
                        self._revision(connection)
                    return int(generation), state == "building"
                connection.execute("UPDATE scan_queue SET processed = 0 WHERE generation_id = ?", (generation,))
                connection.execute("DELETE FROM coverage_issues WHERE generation_id = ?", (generation,))
                connection.execute(
                    "UPDATE generations SET scan_active = 1, scan_pass_id = scan_pass_id + 1, coverage = 'partial', issue_count = 0 WHERE id = ?",
                    (generation,),
                )
                self._revision(connection)
                return int(generation), False
        raise RuntimeError("Directory scan allocation did not complete. Retry source verification.")

    def seed_scan(self, generation_id: int) -> None:
        with self._writer_lock:
            connection = self._connection()
            with transaction(connection):
                connection.execute("INSERT INTO scan_queue(generation_id, path) VALUES (?, '') ON CONFLICT DO NOTHING", (generation_id,))

    def pending_scan_paths(self, generation_id: int, limit: int = ROW_BATCH_SIZE, *, exclude: list[str] | None = None) -> list[str]:
        return [path for path, _identity in self.pending_scan_jobs(generation_id, limit=limit, exclude=exclude)]

    def pending_scan_jobs(
        self, generation_id: int, *, limit: int = ROW_BATCH_SIZE, paths: list[str] | None = None, exclude: list[str] | None = None
    ) -> list[tuple[str, bytes | None]]:
        if not 1 <= limit <= ROW_BATCH_SIZE:
            raise ValueError("Scan work batch limit is outside the supported range.")
        if paths is not None and (len(paths) > ROW_BATCH_SIZE or sum(len(path.encode("utf-8")) for path in paths) > SCAN_BATCH_BYTES):
            raise ValueError("Scan work page exceeds its count or byte limit. Split the page.")
        selected_paths = None if paths is None else json.dumps(paths)
        if exclude is not None and (
            len(exclude) > SCAN_BOOKKEEPING_COMMIT_MAX_PARENTS or sum(len(path.encode("utf-8")) for path in exclude) > SCAN_BATCH_BYTES
        ):
            raise ValueError("Buffered scan parents exceed the group limit. Commit the buffered group.")
        excluded_paths = json.dumps(exclude or [])
        with self._writer_lock:
            jobs: list[tuple[str, bytes | None]] = []
            size = 0
            for path, file_id in self._connection().execute(
                "SELECT path, file_id FROM scan_queue WHERE generation_id = ? AND processed = 0 "
                "AND (? IS NULL OR path IN (SELECT value FROM json_each(?))) "
                "AND path NOT IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT ?",
                (generation_id, selected_paths, selected_paths, excluded_paths, limit),
            ):
                amount = len(path.encode("utf-8")) + (len(file_id) if file_id is not None else 0)
                if amount > SCAN_BATCH_BYTES:
                    raise ValueError("Queued directory exceeds the scan-page byte limit. Request source verification.")
                if size + amount > SCAN_BATCH_BYTES:
                    break
                jobs.append((path, None if file_id is None else bytes(file_id)))
                size += amount
            return jobs

    def scan_parent_file_id(self, generation_id: int, parent: str) -> bytes | None:
        with self._writer_lock:
            row = (
                self._connection()
                .execute("SELECT file_id FROM scan_queue WHERE generation_id = ? AND path = ?", (generation_id, parent))
                .fetchone()
            )
            return None if row is None or row[0] is None else bytes(row[0])

    def contains_directory(self, generation_id: int, path: str) -> bool:
        """Check whether a sampled directory remains in the committed generation."""
        validate_directory_path(path)
        with self._writer_lock:
            return (
                self._connection()
                .execute("SELECT 1 FROM directories WHERE generation_id = ? AND path = ?", (generation_id, path))
                .fetchone()
                is not None
            )

    def write_scan_children(
        self, generation_id: int, children: Iterable[tuple[str, bool]], *, file_ids: dict[str, bytes] | None = None
    ) -> None:
        self._write_children(generation_id, children, file_ids=file_ids)

    def scan_parents_have_changes(
        self,
        generation_id: int,
        parents: list[tuple[str, list[tuple[str, bool]]]],
        *,
        partial_parents: set[str] | None = None,
        streamed_parents: set[str] | None = None,
    ) -> bool:
        payload = json.dumps(
            [
                {
                    "parent": parent,
                    "paths": [path for path, _descend in children],
                    "complete": partial_parents is None or parent not in partial_parents,
                    "streamed": streamed_parents is not None and parent in streamed_parents,
                }
                for parent, children in parents
            ]
        )
        with self._writer_lock:
            return bool(
                required_row(
                    self._connection().execute(
                        "WITH snapshots AS MATERIALIZED (SELECT json_extract(value, '$.parent') AS parent, json_extract(value, '$.complete') AS complete, json_extract(value, '$.streamed') AS streamed, value AS data FROM json_each(?1)), "
                        "snapshot_paths AS MATERIALIZED (SELECT snapshots.parent, path.value AS path FROM snapshots CROSS JOIN json_each(snapshots.data, '$.paths') AS path) "
                        "SELECT EXISTS(SELECT 1 FROM snapshot_paths LEFT JOIN directories AS stored ON stored.generation_id = ?2 AND stored.path = snapshot_paths.path WHERE stored.id IS NULL) "
                        "OR EXISTS(SELECT 1 FROM snapshots CROSS JOIN directories AS child INDEXED BY directories_parent ON child.generation_id = ?2 "
                        "AND child.parent_id IS (SELECT id FROM directories WHERE generation_id = ?2 AND path = snapshots.parent) "
                        "AND ((snapshots.parent = '' AND child.depth = 0) OR child.parent_id IS NOT NULL) "
                        "LEFT JOIN snapshot_paths AS seen ON seen.parent = snapshots.parent AND seen.path = child.path "
                        "LEFT JOIN scan_snapshot_children AS staged ON snapshots.streamed = 1 AND staged.generation_id = ?2 AND staged.parent_path = snapshots.parent AND staged.path = child.path "
                        "WHERE snapshots.complete = 1 AND seen.path IS NULL AND staged.path IS NULL)",
                        (payload, generation_id),
                    )
                )[0]
            )

    def write_scan_parent_batch(
        self,
        generation_id: int,
        parent: str,
        children: Iterable[tuple[str, bool]],
        *,
        reset_snapshot: bool,
        file_ids: dict[str, bytes] | None = None,
        reconcile: bool = False,
    ) -> None:
        """Publish a bounded batch and retain its names for the final parent diff."""
        batch = list(islice(children, ROW_BATCH_SIZE + 1))
        if (
            len(batch) > ROW_BATCH_SIZE
            or sum(len(path.encode("utf-8")) for path, _ in batch) + sum(len(value) for value in (file_ids or {}).values())
            > SCAN_BATCH_BYTES
        ):
            raise ValueError("Scan snapshot batch exceeds its count or byte limit. Split it into bounded batches.")
        for path, _ in batch:
            validate_directory_path(path)
            if path.rpartition("/")[0] != parent:
                raise ValueError("Scan child is outside its immediate parent. Request source verification.")
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            with transaction(connection):
                if not required_row(
                    connection.execute(
                        "SELECT EXISTS(SELECT 1 FROM scan_queue WHERE generation_id = ? AND path = ? AND processed = 0)",
                        (generation_id, parent),
                    )
                )[0]:
                    raise ValueError("Scan snapshot parent is not pending. Request source verification.")
                if reset_snapshot:
                    connection.execute(
                        "DELETE FROM scan_snapshot_children WHERE generation_id = ? AND parent_path = ?", (generation_id, parent)
                    )
                self._write_children(generation_id, batch, parent=parent if reconcile else None, reserved=True, file_ids=file_ids)
                connection.executemany(
                    "INSERT INTO scan_snapshot_children(generation_id, parent_path, path) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                    [(generation_id, parent, path) for path, _ in batch],
                )

    def commit_scan_parents(
        self,
        generation_id: int,
        results: Iterable[tuple[str, list[tuple[str, bool]]]],
        *,
        file_ids: dict[str, bytes] | None = None,
        partial_parents: set[str] | None = None,
        streamed_parents: set[str] | None = None,
        reconcile: bool = False,
        issues: dict[str, dict[str, int]] | None = None,
    ) -> None:
        """Diff complete parent snapshots and finish their queue work atomically."""
        parents = list(islice(results, SCAN_BOOKKEEPING_COMMIT_MAX_PARENTS + 1))
        if len(parents) > SCAN_BOOKKEEPING_COMMIT_MAX_PARENTS:
            raise ValueError("Scan commit exceeds the parent limit. Split it into bounded groups.")
        parent_paths = {parent for parent, _ in parents}
        counts: dict[str, int] = {}
        for parent, parent_counts in (issues or {}).items():
            if parent not in parent_paths:
                raise ValueError("Scan issues belong to a parent outside this commit. Include its completed snapshot.")
            for code, count in parent_counts.items():
                if type(count) is not int or not 0 < count <= MAX_SIGNED_INTEGER:
                    raise ValueError("Directory coverage issue count is invalid. Use a positive supported integer.")
                counts[code] = counts.get(code, 0) + count
        with self._writer_lock, self.growth_guard():
            with transaction(self._connection()):
                if len(parents) > SCAN_COMMIT_MAX_PARENTS and self.scan_parents_have_changes(
                    generation_id, parents, partial_parents=partial_parents, streamed_parents=streamed_parents
                ):
                    raise ValueError("Content scan commit exceeds the parent limit. Split it into bounded groups.")
                if counts:
                    self._record_issue_counts(self._connection(), generation_id, counts, reconcile=reconcile)
                for parent, children in parents:
                    if parent:
                        validate_directory_path(parent)
                    if reconcile:
                        self._require_reconciliation_parent(self._connection(), generation_id, parent)
                    for path, _descend in children:
                        if path.rpartition("/")[0] != parent:
                            raise ValueError("Scan child is outside its immediate parent. Request source verification.")
                    for offset in range(0, len(children), ROW_BATCH_SIZE):
                        self._write_children(
                            generation_id,
                            children[offset : offset + ROW_BATCH_SIZE],
                            parent=parent if reconcile else None,
                            reserved=True,
                            file_ids=file_ids,
                        )
                    if partial_parents is None or parent not in partial_parents:
                        connection = self._connection()
                        parent_row = connection.execute(
                            "SELECT id FROM directories WHERE generation_id = ? AND path = ?", (generation_id, parent)
                        ).fetchone()
                        if not parent or parent_row is not None:
                            removed = connection.execute(
                                "DELETE FROM directories WHERE generation_id = ? AND parent_id IS ? "
                                "AND (? <> '' OR depth = 0) AND path NOT IN (SELECT value FROM json_each(?)) "
                                "AND (? = 0 OR path NOT IN (SELECT path FROM scan_snapshot_children WHERE generation_id = ? AND parent_path = ?))",
                                (
                                    generation_id,
                                    None if parent_row is None else parent_row[0],
                                    parent,
                                    json.dumps([path for path, _ in children]),
                                    streamed_parents is not None and parent in streamed_parents,
                                    generation_id,
                                    parent,
                                ),
                            ).rowcount
                            if (
                                removed
                                and required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0]
                                == generation_id
                            ):
                                self._revision(connection)
                    self._connection().execute(
                        "DELETE FROM scan_snapshot_children WHERE generation_id = ? AND parent_path = ?", (generation_id, parent)
                    )
                    self.finish_scan_parent(generation_id, parent)

    def requeue_completed_scan_batch(self, generation_id: int) -> bool:
        """Revalidate retained work after an observation gap without discarding rows."""
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            with transaction(connection):
                state = required_row(connection.execute("SELECT state FROM generations WHERE id = ?", (generation_id,)))[0]
                if (
                    state not in ("building",)
                    and not required_row(connection.execute("SELECT scan_active FROM generations WHERE id = ?", (generation_id,)))[0]
                ):
                    raise ValueError("Scan generation is no longer active. Request source verification.")
                changed = connection.execute(
                    "UPDATE scan_queue SET processed = 0 WHERE rowid IN "
                    "(SELECT rowid FROM scan_queue WHERE generation_id = ? AND processed = 1 LIMIT ?)",
                    (generation_id, ROW_BATCH_SIZE),
                ).rowcount
                return changed == ROW_BATCH_SIZE
        raise RuntimeError("Scan revalidation did not complete. Retry source verification.")

    def accepted_generation(self) -> int | None:
        with self._writer_lock:
            row = (
                self._connection()
                .execute(
                    "SELECT g.id FROM generations g JOIN source_metadata m ON m.selected_generation = g.id WHERE g.state = 'accepted' AND g.scan_active = 0"
                )
                .fetchone()
            )
            return None if row is None else int(row[0])

    def scan_is_initial(self, generation_id: int) -> bool:
        with self._writer_lock:
            return not bool(
                required_row(
                    self._connection().execute(
                        "SELECT EXISTS(SELECT 1 FROM source_metadata WHERE selected_generation = ? AND last_verified_at_ms IS NOT NULL)",
                        (generation_id,),
                    )
                )[0]
            )

    def reconciliation_generation(self) -> int | None:
        with self._writer_lock:
            row = (
                self._connection()
                .execute(
                    "SELECT g.id FROM generations g JOIN source_metadata m ON m.selected_generation = g.id WHERE g.state = 'accepted' "
                    "AND g.scan_active = 0 "
                    "AND EXISTS(SELECT 1 FROM scan_queue q WHERE q.generation_id = g.id AND q.processed = 0)"
                )
                .fetchone()
            )
            return None if row is None else int(row[0])

    @staticmethod
    def _require_reconciliation_parent(connection: sqlite3.Connection, generation_id: int, parent: str | None) -> None:
        accepted = required_row(
            connection.execute(
                "SELECT EXISTS(SELECT 1 FROM generations g JOIN source_metadata m ON m.selected_generation = g.id "
                "WHERE g.id = ? AND g.state = 'accepted' AND g.scan_active = 0 AND (? IS NULL OR EXISTS(SELECT 1 FROM scan_queue q "
                "WHERE q.generation_id = g.id AND q.path = ? AND q.processed = 0)))",
                (generation_id, parent, parent),
            )
        )[0]
        if not accepted:
            if parent is None:
                raise ValueError("Reconciliation generation is no longer selected and accepted. Request source verification.")
            raise ValueError("Reconciliation parent is not pending on the selected accepted generation. Request source verification.")

    def queue_reconciliation_parent(self, generation_id: int, parent: str) -> None:
        """Queue an accepted parent without changing selected rows or verification time."""
        if parent:
            validate_directory_path(parent)
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            with transaction(connection):
                self._require_reconciliation_parent(connection, generation_id, None)
                self._queue_scan_parent(connection, generation_id, parent)

    @staticmethod
    def _queue_scan_parent(connection: sqlite3.Connection, generation_id: int, parent: str, *, defer: bool = False) -> None:
        """Keep pending hints in place; put completed or deferred work at the tail."""
        removed = connection.execute(
            "DELETE FROM scan_queue WHERE generation_id = ? AND path = ? AND (processed = 1 OR ?) RETURNING file_id",
            (generation_id, parent, defer),
        ).fetchone()
        connection.execute(
            "INSERT INTO scan_queue(generation_id, path, file_id) VALUES (?, ?, ?) ON CONFLICT(generation_id, path) DO NOTHING",
            (generation_id, parent, removed[0] if removed is not None and defer else None),
        )

    def defer_scan_parent(self, generation_id: int, path: str) -> None:
        """Retain partial rows while moving a stale parent behind pending work."""
        if path:
            validate_directory_path(path)
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            with transaction(connection):
                active = connection.execute(
                    "SELECT 1 FROM generations WHERE id = ? AND (state IN ('building') OR "
                    "(state = 'accepted' AND id = (SELECT selected_generation FROM source_metadata WHERE id = 1)))",
                    (generation_id,),
                ).fetchone()
                if active is None:
                    raise ValueError("Directory scan generation is no longer active. Request source verification.")
                self._queue_scan_parent(connection, generation_id, path, defer=True)

    def queue_observed_parent(self, parent: str) -> None:
        """Queue a source hint across active scans and the selected accepted generation."""
        if parent:
            validate_directory_path(parent)
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            with transaction(connection):
                generations = connection.execute(
                    "SELECT g.id FROM generations g "
                    "WHERE g.state IN ('building') OR (g.state = 'accepted' AND g.id = "
                    "(SELECT selected_generation FROM source_metadata WHERE id = 1))"
                ).fetchall()
                for (generation_id,) in generations:
                    self._queue_scan_parent(connection, generation_id, parent)

    def finish_reconciliation_parent(self, generation_id: int, parent: str) -> None:
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            with transaction(connection):
                self._require_reconciliation_parent(connection, generation_id, parent)
                connection.execute("UPDATE scan_queue SET processed = 1 WHERE generation_id = ? AND path = ?", (generation_id, parent))

    def write_reconciliation_children(self, generation_id: int, parent: str, children: Iterable[tuple[str, bool]]) -> None:
        """Commit immediate children only for pending selected accepted work."""
        if parent:
            validate_directory_path(parent)
        self._write_children(generation_id, children, parent=parent)

    def _write_children(
        self,
        generation_id: int,
        children: Iterable[tuple[str, bool]],
        *,
        parent: str | None = None,
        reserved: bool = False,
        file_ids: dict[str, bytes] | None = None,
    ) -> None:
        batch: list[tuple[str, bool]] = []
        batch_bytes = 0
        for path, descend in islice(children, ROW_BATCH_SIZE + 1):
            if parent is not None:
                path_bytes = len(path.encode("utf-8"))
                if path_bytes > SCAN_BATCH_BYTES - batch_bytes:
                    raise ValueError("Reconciliation children exceed the scan-batch byte limit. Split them into bounded batches.")
                batch_bytes += path_bytes
            batch.append((path, descend))
        if len(batch) > ROW_BATCH_SIZE:
            raise ValueError("Scan row batch exceeds the supported limit. Split the batch.")
        for path, _ in batch:
            validate_directory_path(path)
            if parent is not None and path.rpartition("/")[0] != parent:
                raise ValueError("Reconciliation child is outside its immediate parent. Request source verification.")
        with self._writer_lock, nullcontext() if reserved else self.growth_guard():
            connection = self._connection()
            self._require_fts()
            with transaction(connection):
                if parent is None:
                    state = connection.execute("SELECT state, scan_active FROM generations WHERE id = ?", (generation_id,)).fetchone()
                    if state is None or (state[0] not in {"building"} and not state[1]):
                        raise ValueError("Scan generation is no longer active. Discard this batch and request verification.")
                else:
                    self._require_reconciliation_parent(connection, generation_id, parent)
                changed = False
                for path, descend in batch:
                    inserted = connection.execute(
                        "INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory, parent_id) "
                        "VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM directories WHERE generation_id = ? AND path = ?)) "
                        "ON CONFLICT(generation_id, path) DO NOTHING",
                        (
                            generation_id,
                            path,
                            normalize_search_text(path),
                            normalize_search_text(path.rsplit("/", 1)[-1]),
                            path.count("/"),
                            any(part.startswith(".") for part in path.split("/")),
                            generation_id,
                            path.rpartition("/")[0],
                        ),
                    ).rowcount
                    changed |= bool(inserted)
                    if inserted:
                        connection.execute(
                            "UPDATE directories SET parent_id = (SELECT id FROM directories WHERE generation_id = ? AND path = ?) "
                            "WHERE generation_id = ? AND parent_id IS NULL AND depth = ? AND path >= ? AND path < ?",
                            (generation_id, path, generation_id, path.count("/") + 1, path + "/", path + "0"),
                        )
                    if descend:
                        file_id = None if file_ids is None else file_ids.get(path)
                        if file_id is not None and (not isinstance(file_id, bytes) or len(file_id) not in (8, 16)):
                            raise ValueError("Directory FileId must contain 8 or 16 bytes. Retry source verification.")
                        sql = (
                            "INSERT INTO scan_queue(generation_id, path, file_id) VALUES (:generation, :path, :file_id) "
                            "ON CONFLICT(generation_id, path) DO UPDATE SET " + SCAN_FILE_ID_UPDATE_SQL
                            if parent is None or inserted
                            else "UPDATE scan_queue SET " + SCAN_FILE_ID_UPDATE_SQL + " AND generation_id = :generation AND path = :path"
                        )
                        connection.execute(
                            sql,
                            {"generation": generation_id, "path": path, "file_id": file_id},
                        )
                if (
                    changed
                    and required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0] == generation_id
                ):
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
            result: list[str] = []
            size = 0
            overflow: str | None = None
            frontier: str | None = None
            upper = prefix[:-1] + "0" if prefix else None
            sql = "SELECT path FROM directories WHERE generation_id = ? AND path >= ?"
            parameters: list[str | int] = [generation_id, max(prefix, after_path or "")]
            if upper is not None:
                sql += " AND path < ?"
                parameters.append(upper)
            sql += " ORDER BY path"
            with closing(self._connection().execute(sql, parameters)) as cursor:
                for (stored_path,) in cursor:
                    if frontier is not None and stored_path >= frontier:
                        break
                    path = prefix + stored_path[len(prefix) :].split("/", 1)[0]
                    if (after_path is not None and path <= after_path) or (overflow is not None and path >= overflow):
                        continue
                    if path in result:
                        continue
                    insort(result, path)
                    size += len(path.encode("utf-8"))
                    while len(result) > ROW_BATCH_SIZE or size > maximum_bytes:
                        overflow = result.pop()
                        size -= len(overflow.encode("utf-8"))
                    ceiling = overflow if overflow is not None else result[-1] if len(result) == ROW_BATCH_SIZE else None
                    if ceiling is not None:
                        name = ceiling[len(prefix) :]
                        # A missing shorter ancestor can sort after punctuation-bearing siblings in stored paths.
                        cut = next((offset for offset, character in enumerate(name) if offset and character < "/"), len(name))
                        frontier = prefix + name[:cut] + "0"
            if overflow is not None and len(result) < ROW_BATCH_SIZE and len(overflow.encode("utf-8")) > maximum_bytes:
                raise ValueError("Directory child exceeds the scan-page byte budget. Source coverage is incomplete.")
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
                if state is None or state[0] not in {"building", "accepted"}:
                    raise ValueError("Reconciliation generation is no longer active. Discard this observation and request verification.")
                removed = connection.execute(
                    "DELETE FROM directories WHERE id IN (SELECT id FROM directories WHERE generation_id = ? "
                    "AND (path = ? OR substr(path, 1, length(?)) = ?) ORDER BY path DESC LIMIT ?)",
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
        self._record_scan_issue(generation_id, "unsafe_traversal")

    def record_access_denied(self, generation_id: int) -> None:
        """Record an unreadable descendant without discarding readable siblings."""
        self._record_scan_issue(generation_id, "access_denied")

    def record_issue(self, generation_id: int, code: str, *, reconcile: bool = False) -> None:
        """Record an item issue only on active work or the selected reconciliation generation."""
        with self._writer_lock, self.growth_guard():
            connection = self._connection()
            with transaction(connection):
                self._record_issue_counts(connection, generation_id, {code: 1}, reconcile=reconcile)

    def _record_issue_counts(self, connection: sqlite3.Connection, generation_id: int, counts: dict[str, int], *, reconcile: bool) -> None:
        """Write grouped issue counts within the caller's parent transaction."""
        for code, count in counts.items():
            if code not in ITEM_ISSUE_CODES:
                raise ValueError("Unsupported directory coverage issue. Use a contract issue code.")
            if type(count) is not int or not 0 < count <= MAX_SIGNED_INTEGER:
                raise ValueError("Directory coverage issue count is invalid. Use a positive supported integer.")
        state = connection.execute("SELECT state, scan_active FROM generations WHERE id = ?", (generation_id,)).fetchone()
        selected = required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0]
        if state is None or not (
            state[0] == "building" or (reconcile or state[1]) and state[0] == "accepted" and selected == generation_id
        ):
            raise ValueError("Traversal issue belongs to an inactive scan. Restart source verification.")
        connection.executemany(
            "INSERT INTO coverage_issues(generation_id, code, count) VALUES (?, ?, ?) "
            "ON CONFLICT(generation_id, code) DO UPDATE SET count = count + excluded.count",
            ((generation_id, code, count) for code, count in counts.items()),
        )
        connection.execute(
            "UPDATE generations SET issue_count = (SELECT sum(count) FROM coverage_issues WHERE generation_id = ?), "
            "coverage = CASE WHEN coverage = 'uncertain' THEN 'uncertain' ELSE 'partial' END WHERE id = ?",
            (generation_id, generation_id),
        )
        if selected == generation_id:
            self._revision(connection)

    def _record_scan_issue(self, generation_id: int, code: Literal["unsafe_traversal", "access_denied"]) -> None:
        self.record_issue(generation_id, code)

    def finish_scan_parent(self, generation_id: int, path: str) -> None:
        with self._writer_lock:
            connection = self._connection()
            with transaction(connection):
                connection.execute("UPDATE scan_queue SET processed = 1 WHERE generation_id = ? AND path = ?", (generation_id, path))

    def checkpoint(self) -> None:
        with self._writer_lock:
            self._connection().execute("PRAGMA wal_checkpoint(PASSIVE)")
            logger.debug("Directory checkpoint completed.", extra={"event": "directory_checkpoint_completed"})

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
                    logger.debug("Directory checkpoint deferred for readers.", extra={"event": "directory_checkpoint_deferred"})
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
            logger.debug("Directory page reclamation completed.", extra={"event": "directory_pages_reclaimed"})
            busy, total, completed = required_row(connection.execute("PRAGMA wal_checkpoint(TRUNCATE)"))
            return not busy and total == completed

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
                changed = connection.execute(
                    "UPDATE generations SET coverage = 'uncertain', issue_count = "
                    "(SELECT sum(count) FROM coverage_issues WHERE generation_id = ?) WHERE id = ? "
                    "AND (coverage <> 'uncertain' OR issue_count <> (SELECT sum(count) FROM coverage_issues WHERE generation_id = ?))",
                    (generation, generation, generation),
                ).rowcount
                if changed:
                    self._revision(connection)

    def mutate_path(self, action: Literal["add", "remove", "rename"], path: str, new_path: str | None = None) -> None:
        """Apply one observation to both accepted rows and active verification rows."""
        self._mutate_path(action, path, new_path, reconcile=False)

    def mutate_observed_path(self, action: Literal["add", "remove", "rename"], path: str, new_path: str | None = None) -> None:
        """Commit manager-owned observations and accepted-parent work together."""
        self._mutate_path(action, path, new_path, reconcile=True)

    def _mutate_path(self, action: Literal["add", "remove", "rename"], path: str, new_path: str | None, *, reconcile: bool) -> None:
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
                generations = connection.execute("SELECT id FROM generations WHERE state IN ('building', 'accepted')").fetchall()
                for (generation_id,) in generations:
                    if action == "add":
                        connection.execute(
                            "INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory, parent_id) "
                            "VALUES (?, ?, ?, ?, ?, ?, (SELECT id FROM directories WHERE generation_id = ? AND path = ?)) "
                            "ON CONFLICT(generation_id, path) DO NOTHING",
                            (
                                generation_id,
                                path,
                                normalize_search_text(path),
                                normalize_search_text(path.rsplit("/", 1)[-1]),
                                path.count("/"),
                                any(part.startswith(".") for part in path.split("/")),
                                generation_id,
                                path.rpartition("/")[0],
                            ),
                        )
                        connection.execute(
                            "INSERT INTO scan_queue(generation_id, path) SELECT id, ? FROM generations "
                            "WHERE id = ? AND (state = 'building' OR scan_active = 1) "
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
                            "parent_id = CASE WHEN path = ? THEN (SELECT id FROM directories WHERE generation_id = ? AND path = ?) "
                            "ELSE parent_id END, depth = depth + ? WHERE generation_id = ? AND (path = ? OR substr(path, 1, ?) = ?)",
                            (
                                new_path,
                                len(path) + 1,
                                new_path,
                                len(path) + 1,
                                new_path,
                                len(path) + 1,
                                new_path,
                                len(path) + 1,
                                path,
                                generation_id,
                                new_path.rpartition("/")[0],
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
                if reconcile:
                    accepted = connection.execute(
                        "SELECT g.id FROM generations g JOIN source_metadata m ON m.selected_generation = g.id WHERE g.state = 'accepted'"
                    ).fetchone()
                    if accepted is not None:
                        parents = {path.rpartition("/")[0]}
                        if action == "add":
                            parents.add(path)
                        elif action == "rename" and new_path is not None:
                            parents.add(new_path.rpartition("/")[0])
                            if (
                                connection.execute(
                                    "SELECT 1 FROM directories WHERE generation_id = ? AND path = ?", (accepted[0], new_path)
                                ).fetchone()
                                is not None
                            ):
                                parents.add(new_path)
                        connection.executemany(
                            "INSERT INTO scan_queue(generation_id, path) VALUES (?, ?) "
                            "ON CONFLICT(generation_id, path) DO UPDATE SET processed = 0",
                            ((accepted[0], parent) for parent in sorted(parents)),
                        )
                self._revision(connection)

    def finish_generation(self, generation_id: int, *, issue_count: int = 0) -> bool:
        """Accept best-effort passes unless an observation gap remains unresolved."""
        if not 0 <= issue_count <= MAX_SIGNED_INTEGER:
            raise ValueError("Coverage issue count is outside the supported range.")
        with self._writer_lock:
            connection = self._connection()
            with transaction(connection):
                row = connection.execute("SELECT state, scan_active FROM generations WHERE id = ?", (generation_id,)).fetchone()
                if row is None or (row[0] not in {"building"} and not row[1]):
                    raise ValueError("Generation is not an active build or verification pass.")
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
                observation_loss = (
                    connection.execute(
                        "SELECT 1 FROM coverage_issues WHERE generation_id = ? AND code = 'event_loss' LIMIT 1", (generation_id,)
                    ).fetchone()
                    is not None
                )
                if observation_loss:
                    connection.execute(
                        "UPDATE generations SET issue_count = ?, coverage = CASE WHEN coverage = 'uncertain' THEN 'uncertain' ELSE 'partial' END WHERE id = ?",
                        (unresolved, generation_id),
                    )
                    selected = required_row(connection.execute("SELECT selected_generation FROM source_metadata WHERE id = 1"))[0]
                    if selected == generation_id:
                        self._revision(connection)
                    logger.debug("Directory scan issues observed.", extra={"event": "directory_scan_issues", "issue_count": unresolved})
                    return False
                if connection.execute(
                    "SELECT 1 FROM scan_queue WHERE generation_id = ? AND processed = 0 LIMIT 1", (generation_id,)
                ).fetchone():
                    raise ValueError("Scan work remains queued. Complete the scan before selecting this generation.")
                connection.execute(
                    "UPDATE generations SET state = 'accepted', scan_active = 0, coverage = ?, issue_count = ? WHERE id = ?",
                    ("partial" if unresolved else "complete", unresolved, generation_id),
                )
                connection.execute(
                    "UPDATE source_metadata SET selected_generation = ?, last_verified_at_ms = ? WHERE id = 1",
                    (generation_id, epoch_milliseconds()),
                )
                self._revision(connection)
            logger.debug("Directory generation accepted.", extra={"event": "directory_generation_accepted"})
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

    @contextmanager
    def _query_connection(self) -> Iterator[sqlite3.Connection]:
        validate_storage_ancestors(self.path.parent)
        self._validate_storage_files(self.path)
        metadata = self.path.lstat()
        identity = (metadata.st_dev, metadata.st_ino)
        with self._writer_lock:
            if self._readers:
                connection, held_identity = self._readers.pop()
                if identity != held_identity:
                    connection.close()
                    raise PermissionError("Directory-index database changed. Stop the source and restore its private storage.")
            else:
                connection = self._connect(readonly=True)
        try:
            yield connection
        finally:
            connection.set_progress_handler(None, 0)
            with self._writer_lock:
                self._readers.append((connection, identity))

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
        with self._query_connection() as connection:
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
