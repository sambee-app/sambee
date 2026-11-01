"""
Directory cache service for instant directory navigation.

Maintains an in-memory cache of all directory paths per SMB connection,
enabling instant substring search across the entire directory tree.

Architecture:
- One cache per connection (not per user)
- BFS scan using smbclient.scandir() via the connection pool
- CHANGE_NOTIFY watcher on share root for live updates (DIR_NAME only)
- Periodic full rescan as safety net (default: 60 min)
- Stale serving during rescans (eventual consistency)
- JSONL snapshot persistence for instant availability on restart

Persistence:
- Snapshots are written to the configured location (default: data/<CACHE_PERSIST_SUBDIR>/)
- Format: JSONL — header line with version/timestamp/count, then one {"p":"path"} per directory
- Write-behind with dirty flag + coalesced flush (configurable interval, default 30s)
- Atomic writes via temp file + os.replace(); previous file kept as .bak backup
- Snapshots older than the configured max staleness (default 30 days) are ignored
- On startup, a valid snapshot is loaded instantly, then a background rescan verifies freshness

See documentation_developers/INSTANT_DIRECTORY_NAVIGATION.md for full design.
"""

import asyncio
import json
import logging
import os
import tempfile
import threading
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Optional

import smbclient
from smbclient._os import FileAttributes
from smbprotocol.change_notify import (
    ChangeNotifyFlags,
    CompletionFilter,
    FileAction,
    FileSystemWatcher,
)
from smbprotocol.connection import Connection
from smbprotocol.open import (
    CreateDisposition,
    CreateOptions,
    DirectoryAccessMask,
    ImpersonationLevel,
    Open,
    ShareAccess,
)
from smbprotocol.open import (
    FileAttributes as SMBFileAttributes,
)
from smbprotocol.reparse_point import ReparseTags
from smbprotocol.session import Session
from smbprotocol.tree import TreeConnect

from app.core.config import settings, static
from app.services.history_common import directory_match_rank, normalize_history_search_text
from app.services.system_settings import get_smbclient_policy_kwargs
from app.storage.smb_pool import SMBConnectionPool, get_connection_pool, get_smb_connection_cache

logger = logging.getLogger(__name__)


# ============================================================================
# Constants
# ============================================================================


# Cache states
class CacheState(str, Enum):
    """State of a connection's directory cache."""

    EMPTY = "empty"  # No scan started yet
    BUILDING = "building"  # Initial scan in progress
    READY = "ready"  # Scan complete, cache is usable
    UPDATING = "updating"  # Rescan in progress, stale data served


# Scan configuration
SCAN_BATCH_SIZE = 50  # Directories to process per BFS batch
SCAN_TIMEOUT_SECONDS = 30.0  # Timeout for single scandir call
RESCAN_INTERVAL_SECONDS = 3600  # 60 minutes between periodic rescans

# CHANGE_NOTIFY configuration
CHANGE_NOTIFY_BUFFER_SIZE = 65536  # 64 KB — protocol maximum
CHANGE_NOTIFY_DEBOUNCE_SECONDS = 2  # Aggregate events before processing

# Reconnect configuration
MAX_WATCHER_RETRIES = 5
WATCHER_RETRY_BASE_DELAY = 2.0  # seconds
WATCHER_RETRY_MAX_DELAY = 120.0  # seconds

# Search configuration
MAX_SEARCH_RESULTS = 200
PATH_SEPARATOR = "/"
HIDDEN_DIRECTORY_PREFIX = "."

# Persistence configuration
CACHE_PERSIST_SUBDIR = "directory_cache"  # Default subdirectory under data_dir
CACHE_FILE_EXTENSION = ".idx"
CACHE_BACKUP_EXTENSION = ".bak"  # Backup kept alongside the main file
CACHE_FILE_VERSION = 2


def path_contains_dot_directory(path: str) -> bool:
    """Return True when any path segment is dot-prefixed."""

    return any(segment.startswith(HIDDEN_DIRECTORY_PREFIX) for segment in path.split(PATH_SEPARATOR) if segment)


@dataclass(frozen=True)
class _ScannedDirectory:
    path: str
    is_reparse_point: bool = False
    is_dfs_referral: bool = False

    @property
    def can_descend(self) -> bool:
        """Follow DFS referrals, but do not follow arbitrary directory links."""
        return not self.is_reparse_point or self.is_dfs_referral


@dataclass(frozen=True)
class _DirectoryMutation:
    action: int
    path: str
    new_path: Optional[str] = None

    def invalidates_read(self, directory: str) -> bool:
        """A concurrent removal or rename makes overlapping scan results ambiguous."""

        if self.action == FileAction.FILE_ACTION_ADDED:
            return False

        return any(
            path == directory or path.rpartition(PATH_SEPARATOR)[0] == directory or directory.startswith(path + PATH_SEPARATOR)
            for path in (self.path, self.new_path)
            if path is not None
        )

    def apply(self, directories: set[str]) -> set[str]:
        """Apply the same path operation to a live index or a rescan snapshot."""

        if self.action == FileAction.FILE_ACTION_ADDED:
            directories.add(self.path)
            return directories

        prefix = self.path + PATH_SEPARATOR
        if self.action == FileAction.FILE_ACTION_REMOVED:
            return {path for path in directories if path != self.path and not path.startswith(prefix)}

        if self.action == FileAction.FILE_ACTION_RENAMED_NEW_NAME and self.new_path:
            return {
                self.new_path + path[len(self.path) :] if path == self.path or path.startswith(prefix) else path for path in directories
            }

        raise ValueError(f"Invalid directory cache mutation: action={self.action}, path={self.path!r}")


# ============================================================================
# ConnectionDirectoryCache — per-connection cache
# ============================================================================


class ConnectionDirectoryCache:
    """
    In-memory cache of all directory paths for a single SMB connection.

    Lifecycle:
    1. Created when first needed (user opens a connection)
    2. BFS scans all directories from share root
    3. CHANGE_NOTIFY watcher keeps cache updated
    4. Periodic rescan as safety net
    5. Destroyed when DirectoryCacheManager shuts down
    """

    #
    # __init__
    #
    def __init__(
        self,
        connection_id: str,
        host: str,
        share_name: str,
        username: str,
        password: str,
        port: int = 445,
        path_prefix: str = "/",
        source_revision: str = "",
    ) -> None:
        """Initialize a per-connection directory cache.

        Args:
            connection_id: UUID string identifying the connection
            host: SMB server hostname
            share_name: SMB share name
            username: SMB username
            password: SMB password
            port: SMB port (default 445)
            path_prefix: Base path within the share (e.g. "/photos")
            source_revision: Connection revision used to invalidate snapshots after edits
        """

        self.connection_id = connection_id
        self.host = host
        self.share_name = share_name
        self.username = username
        self.password = password
        self.port = port
        self._connection_cache = get_smb_connection_cache(connection_id)

        # Normalize path_prefix: strip slashes so "" means share root
        cleaned = (path_prefix or "/").replace("\\", "/").strip("/")
        self._path_prefix = cleaned  # e.g. "photos" or ""
        self._source_identity = {
            "host": host,
            "share_name": share_name,
            "port": port,
            "path_prefix": cleaned,
            "username": username,
            "revision": source_revision,
        }
        # Pre-compute the SMB base path (share root + prefix)
        share_base = f"\\\\{host}\\{share_name}"
        if cleaned:
            self._smb_base_path = f"{share_base}\\{cleaned.replace('/', '\\')}"
        else:
            self._smb_base_path = share_base

        # The cache: a set of all directory paths (relative to share root)
        # Root is represented as ""
        self._directories: set[str] = set()
        self._lock = threading.Lock()
        self._rescan_changes: Optional[list[_DirectoryMutation]] = None

        # State tracking
        self._state = CacheState.EMPTY
        self._directory_count = 0
        self._last_scan_time: Optional[float] = None
        self._scan_error: Optional[str] = None

        # Background tasks
        self._scan_task: Optional[asyncio.Task[None]] = None
        self._rescan_task: Optional[asyncio.Task[None]] = None
        self._verification_task: Optional[asyncio.Task[None]] = None
        self._watcher_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # CHANGE_NOTIFY SMB resources
        self._watcher_connection: Optional[Connection] = None
        self._watcher_session: Optional[Session] = None
        self._watcher_tree: Optional[TreeConnect] = None
        self._watcher_open: Optional[Open] = None

        # Disk persistence
        self._dirty = False
        self._coalesce_task: Optional[asyncio.Task[None]] = None
        self._persist_path: Path = self._resolve_persist_path(connection_id)

    @property
    def state(self) -> CacheState:
        """Current cache state."""

        return self._state

    @staticmethod
    def _resolve_persist_path(connection_id: str) -> Path:
        """Compute the on-disk path for a connection's index file.

        Uses ``settings.directory_cache_location`` when set (relative paths
        are resolved against *data_dir*); otherwise falls back to
        ``data_dir / CACHE_PERSIST_SUBDIR``.
        """

        custom = settings.directory_cache_location
        if custom:
            base = Path(custom)
            if not base.is_absolute():
                base = static.data_dir / base
        else:
            base = static.data_dir / CACHE_PERSIST_SUBDIR

        return base / f"{connection_id}{CACHE_FILE_EXTENSION}"

    @property
    def directory_count(self) -> int:
        """Number of cached directories."""

        return self._directory_count

    @property
    def last_scan_time(self) -> Optional[float]:
        """Timestamp of last completed scan."""

        return self._last_scan_time

    @property
    def scan_error(self) -> Optional[str]:
        """Error message from last scan attempt, if any."""

        return self._scan_error

    # ========================================================================
    # Public API
    # ========================================================================

    #
    # search
    #
    def search(
        self,
        query: str,
        max_results: int = MAX_SEARCH_RESULTS,
        *,
        include_dot_directories: bool = False,
    ) -> tuple[list[str], int]:
        """Search for directories matching query (case-insensitive substring).

        Supports path separators in the query: both ``/`` and ``\\`` are
        normalised to ``/`` so that queries like ``abc/def`` or ``abc\\def``
        match across directory levels.

        Args:
            query: Search term (substring match, may contain path separators)
            max_results: Maximum results to return (server-side cap)
            include_dot_directories: Whether to include dot-prefixed path segments

        Returns:
            Tuple of (matching directory paths sorted by relevance, total match count).
            The list is capped at max_results; total_count reflects all matches
            before capping, so callers can detect truncation.
        """

        if not query:
            return [], 0

        # Normalise backslashes to forward slashes so users can type either
        query_lower = normalize_history_search_text(query.replace("\\", "/").strip())

        with self._lock:
            # Substring match on all cached paths
            matches = [
                directory
                for directory in self._directories
                if query_lower in normalize_history_search_text(directory)
                and (include_dot_directories or not path_contains_dot_directory(directory))
            ]

        def sort_key(path: str) -> tuple[int, int, str]:
            """Sorting key: (priority_tier, path_depth, path_string)."""

            depth = path.count("/")
            return (directory_match_rank(path, query_lower), depth, path.lower())

        matches.sort(key=sort_key)
        total_count = len(matches)
        return matches[:max_results], total_count

    #
    # add_directory
    #
    def add_directory(self, path: str) -> None:
        """Add a single directory path to the cache.

        Used by external callers (e.g., browser.list_directory, websocket change notifications)
        to incrementally update the cache when directories are discovered.

        Args:
            path: Directory path relative to share root
        """

        normalized = path.strip("/")
        if not normalized:
            return

        self._apply_mutations([_DirectoryMutation(FileAction.FILE_ACTION_ADDED, normalized)])

    #
    # add_directories
    #
    def add_directories(self, paths: list[str]) -> None:
        """Add multiple directory paths to the cache.

        Args:
            paths: List of directory paths relative to share root
        """

        normalized = {p.strip("/") for p in paths if p.strip("/")}
        if not normalized:
            return

        self._apply_mutations([_DirectoryMutation(FileAction.FILE_ACTION_ADDED, path) for path in normalized])

    #
    # remove_directory
    #
    def remove_directory(self, path: str) -> None:
        """Remove a directory and all its children from the cache.

        Args:
            path: Directory path to remove
        """

        normalized = path.strip("/")
        if not normalized:
            return

        self._apply_mutations([_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, normalized)])

    #
    # rename_directory
    #
    def rename_directory(self, old_path: str, new_path: str) -> None:
        """Update paths for a renamed directory and all its children.

        Args:
            old_path: Previous directory path
            new_path: New directory path
        """

        old_normalized = old_path.strip("/")
        new_normalized = new_path.strip("/")

        if not old_normalized or not new_normalized:
            return

        self._apply_mutations([_DirectoryMutation(FileAction.FILE_ACTION_RENAMED_NEW_NAME, old_normalized, new_normalized)])

    def _apply_mutations(self, mutations: list[_DirectoryMutation]) -> None:
        """Update the live index and retain changes for an active rescan."""

        with self._lock:
            for mutation in mutations:
                self._directories = mutation.apply(self._directories)
            if self._rescan_changes is not None:
                self._rescan_changes.extend(mutations)
            self._directory_count = len(self._directories)
            self._dirty = True

    # ========================================================================
    # Disk persistence
    # ========================================================================

    #
    # save_to_disk
    #
    def save_to_disk(self) -> None:
        """Persist the current directory set to disk as JSONL.

        Uses atomic write (temp file + rename) so readers never see a
        half-written file.  Before replacing the main file, the current
        version is kept as a ``.bak`` backup so a valid snapshot always
        exists even if the process is killed mid-write.

        File format (JSONL):
            Line 1 (header): version, connection ID, source identity, timestamp, count
            Lines 2+:        {"p":"relative/dir/path"}
        """

        with self._lock:
            dirs = list(self._directories)
            self._dirty = False

        backup_path = self._persist_path.with_suffix(CACHE_BACKUP_EXTENSION)

        try:
            self._persist_path.parent.mkdir(parents=True, exist_ok=True)

            fd, tmp_path = tempfile.mkstemp(
                dir=str(self._persist_path.parent),
                prefix=f".{self.connection_id[:8]}_",
                suffix=".tmp",
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    header = {
                        "v": CACHE_FILE_VERSION,
                        "connection_id": self.connection_id,
                        "source": self._source_identity,
                        "ts": time.time(),
                        "count": len(dirs),
                    }
                    f.write(json.dumps(header, separators=(",", ":")) + "\n")

                    for d in dirs:
                        f.write(json.dumps({"p": d}, separators=(",", ":")) + "\n")

                # Rotate: current -> backup, then temp -> current
                if self._persist_path.exists():
                    try:
                        os.replace(str(self._persist_path), str(backup_path))
                    except OSError as e:
                        logger.debug(f"Could not create backup for connection {self.connection_id}: {e}")

                os.replace(tmp_path, str(self._persist_path))
                logger.debug(f"Saved directory cache to disk for connection {self.connection_id}: {len(dirs)} directories")
            except BaseException:
                # Clean up temp file on any error
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise

        except Exception as e:
            logger.warning(f"Failed to save directory cache to disk for connection {self.connection_id}: {type(e).__name__}: {e}")

    #
    # load_from_disk
    #
    def load_from_disk(self) -> bool:
        """Load the directory set from a JSONL snapshot on disk.

        Tries the main index file first; if it is missing, corrupt, or stale,
        falls back to the ``.bak`` backup file.

        Returns True if a valid, non-stale snapshot was loaded.
        """

        backup_path = self._persist_path.with_suffix(CACHE_BACKUP_EXTENSION)

        # Try main file first, then backup
        for path, label in [(self._persist_path, "index"), (backup_path, "backup")]:
            if not path.exists():
                continue

            result = self._load_snapshot_file(path, label)
            if result:
                return True

        return False

    #
    # _load_snapshot_file
    #
    def _load_snapshot_file(self, path: Path, label: str) -> bool:
        """Attempt to load a single JSONL snapshot file.

        Returns True if valid and non-stale, False otherwise.

        Args:
            path: Path to the JSONL file
            label: Human-readable label for log messages (e.g. "index", "backup")
        """

        try:
            with open(path, encoding="utf-8") as f:
                header_line = f.readline()
                if not header_line:
                    logger.warning(f"Empty {label} file for connection {self.connection_id}, ignoring")
                    return False

                header = json.loads(header_line)

                # Version check
                if header.get("v") != CACHE_FILE_VERSION:
                    logger.info(
                        f"{label.capitalize()} version mismatch for connection {self.connection_id} "
                        f"(got {header.get('v')}, expected {CACHE_FILE_VERSION}), ignoring"
                    )
                    return False

                # Connection ID check
                if header.get("connection_id") != self.connection_id:
                    logger.warning(f"{label.capitalize()} connection_id mismatch for connection {self.connection_id}, ignoring")
                    return False

                if header.get("source") != self._source_identity:
                    logger.info("Ignoring %s for connection %s: connection target or revision changed", label, self.connection_id)
                    return False

                # Staleness check
                ts = header.get("ts", 0)
                age = time.time() - ts
                max_staleness_seconds = settings.directory_cache_max_staleness_minutes * 60
                if age > max_staleness_seconds:
                    logger.info(
                        f"{label.capitalize()} file for connection {self.connection_id} is stale ({age / 86400:.1f} days old), ignoring"
                    )
                    return False

                expected_count = header.get("count", 0)

                # Read directory entries
                dirs: set[str] = set()
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    entry = json.loads(line)
                    dir_path = entry.get("p", "")
                    if dir_path:
                        dirs.add(dir_path)

            # Validate count matches
            if len(dirs) != expected_count:
                logger.warning(
                    f"{label.capitalize()} count mismatch for connection {self.connection_id}: "
                    f"header says {expected_count}, found {len(dirs)} entries"
                )
                # Still usable — load what we have

            with self._lock:
                self._directories = dirs
                self._directory_count = len(dirs)

            self._last_scan_time = ts
            self._state = CacheState.READY
            logger.info(
                f"Loaded directory cache from {label} for connection {self.connection_id}: "
                f"{len(dirs)} directories (snapshot age: {age:.0f}s)"
            )
            return True

        except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
            logger.warning(f"Corrupt {label} file for connection {self.connection_id}: {type(e).__name__}: {e}")
            return False
        except Exception as e:
            logger.warning(f"Failed to load directory cache from {label} for connection {self.connection_id}: {type(e).__name__}: {e}")
            return False

    #
    # _start_coalesce_flush
    #
    def _start_coalesce_flush(self) -> None:
        """Start the coalesced flush background task if not already running."""

        if self._coalesce_task is not None and not self._coalesce_task.done():
            return

        try:
            loop = asyncio.get_running_loop()
            self._coalesce_task = loop.create_task(self._coalesce_flush_loop())
        except RuntimeError:
            # No running event loop — save synchronously
            if self._dirty:
                self.save_to_disk()

    #
    # _coalesce_flush_loop
    #
    async def _coalesce_flush_loop(self) -> None:
        """Periodically flush dirty cache to disk.

        Runs until stopped, writing at most once per the configured
        coalesce interval.
        """

        interval = settings.directory_cache_coalesce_interval_seconds
        while not self._stop_event.is_set():
            try:
                await asyncio.sleep(interval)
                if self._stop_event.is_set():
                    break
                if self._dirty:
                    self.save_to_disk()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Error in coalesce flush for connection {self.connection_id}: {type(e).__name__}: {e}")

    #
    # delete_persist_file
    #
    def delete_persist_file(self) -> None:
        """Remove the on-disk index and backup files for this connection."""

        backup_path = self._persist_path.with_suffix(CACHE_BACKUP_EXTENSION)
        for path, label in [(self._persist_path, "index"), (backup_path, "backup")]:
            try:
                if path.exists():
                    path.unlink()
                    logger.debug(f"Deleted {label} file for connection {self.connection_id}")
            except Exception as e:
                logger.warning(f"Failed to delete {label} file for connection {self.connection_id}: {type(e).__name__}: {e}")

    # ========================================================================
    # Initial scan (BFS)
    # ========================================================================

    #
    # start_scan
    #
    async def start_scan(self) -> None:
        """Start the initial directory scan in the background.

        Safe to call multiple times — will not start a new scan if one is
        already in progress.
        """

        if self._state in (CacheState.BUILDING, CacheState.UPDATING):
            logger.debug(f"Scan already in progress for connection {self.connection_id}")
            return

        self._state = CacheState.BUILDING
        self._scan_error = None
        self._scan_task = asyncio.create_task(self._run_scan())

    #
    # _run_scan
    #
    async def _run_scan(self) -> None:
        """Execute a full BFS scan of the share directory tree.

        Uses smbclient.scandir() via the connection pool for each directory.
        Results are added progressively so search works during scan.
        """

        logger.info(f"Starting directory scan for connection {self.connection_id} ({self.host}/{self.share_name})")

        scan_start = time.monotonic()
        scanned_count = 0
        error_count = 0

        try:
            pool = await get_connection_pool()
            base_path = self._smb_base_path

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                # BFS queue: list of relative paths to scan
                queue: list[str] = [""]
                discovered: set[str] = set()

                while queue:
                    # Process in batches to avoid holding the event loop too long
                    batch = queue[:SCAN_BATCH_SIZE]
                    queue = queue[SCAN_BATCH_SIZE:]

                    for rel_path in batch:
                        if self._stop_event.is_set():
                            logger.info(f"Scan cancelled for connection {self.connection_id}")
                            return

                        # Build SMB path (relative to the prefix-adjusted base)
                        if rel_path:
                            smb_path = f"{base_path}\\{rel_path.replace('/', '\\')}"
                        else:
                            smb_path = base_path

                        try:
                            subdirs = await self._scan_directory_with_pool_lease(pool, smb_path, rel_path)

                            # Add discovered directories to cache and queue
                            for subdir in subdirs:
                                if subdir.path not in discovered:
                                    discovered.add(subdir.path)
                                    self.add_directory(subdir.path)
                                    if subdir.can_descend:
                                        queue.append(subdir.path)

                            scanned_count += 1
                        except asyncio.TimeoutError:
                            logger.warning(f"Timeout scanning directory '{rel_path}' for connection {self.connection_id}")
                            error_count += 1
                        except Exception as e:
                            logger.warning(
                                f"Error scanning directory '{rel_path}' for connection {self.connection_id}: {type(e).__name__}: {e}"
                            )
                            error_count += 1

                    # Yield to event loop between batches
                    await asyncio.sleep(0)

            elapsed = time.monotonic() - scan_start
            self._last_scan_time = time.time()
            self._state = CacheState.READY
            logger.info(
                f"Directory scan complete for connection {self.connection_id}: "
                f"{self._directory_count} directories found, "
                f"{scanned_count} dirs scanned, {error_count} errors, "
                f"{elapsed:.1f}s elapsed"
            )

            # Start the CHANGE_NOTIFY watcher and periodic rescan
            self._start_watcher()
            self._start_periodic_rescan()

            # Persist snapshot to disk and start coalesced flushing
            self.save_to_disk()
            self._start_coalesce_flush()

        except Exception as e:
            elapsed = time.monotonic() - scan_start
            self._scan_error = f"{type(e).__name__}: {e}"
            # Keep whatever we found so far — partial cache is better than nothing
            if self._directory_count > 0:
                self._state = CacheState.READY
            else:
                self._state = CacheState.EMPTY
            logger.error(
                f"Directory scan failed for connection {self.connection_id} "
                f"after {elapsed:.1f}s ({self._directory_count} dirs found before failure): "
                f"{type(e).__name__}: {e}",
                exc_info=True,
            )

    #
    # _scan_single_directory
    #
    def _scan_single_directory(self, smb_path: str, rel_path: str) -> list[_ScannedDirectory]:
        """Scan a single directory for subdirectories (runs in executor).

        Args:
            smb_path: Full UNC path to the directory
            rel_path: Relative path from share root

        Returns:
            Relative directory paths and whether each entry is a reparse point
        """

        subdirs: list[_ScannedDirectory] = []

        try:
            entries = smbclient.scandir(
                smb_path,
                username=self.username,
                password=self.password,
                port=self.port,
                connection_cache=self._connection_cache,
                **get_smbclient_policy_kwargs(),
            )
            for entry in entries:
                if entry.name in (".", ".."):
                    continue

                try:
                    info = entry.smb_info
                    is_dir = bool(info.file_attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY)

                    if is_dir:
                        child_path = f"{rel_path}/{entry.name}" if rel_path else entry.name
                        subdirs.append(
                            _ScannedDirectory(
                                child_path,
                                is_reparse_point=bool(info.file_attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT),
                                is_dfs_referral=bool(info.file_attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT)
                                and info.ea_size == ReparseTags.IO_REPARSE_TAG_DFS,
                            )
                        )
                except Exception as e:
                    logger.debug(f"Error processing entry '{entry.name}' in '{rel_path}': {e}")
                    raise
        except Exception as e:
            logger.debug(f"Error scanning '{smb_path}': {type(e).__name__}: {e}")
            raise

        return subdirs

    async def _scan_directory_with_pool_lease(self, pool: SMBConnectionPool, smb_path: str, rel_path: str) -> list[_ScannedDirectory]:
        """Run a blocking scan without releasing its pool lease prematurely."""

        future = asyncio.get_running_loop().run_in_executor(None, self._scan_single_directory, smb_path, rel_path)
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=SCAN_TIMEOUT_SECONDS)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            await pool.retain_connection_until_future_complete(self._connection_cache, future)
            raise

    #
    # _run_rescan
    #
    async def _run_rescan(self) -> None:
        """Execute a periodic rescan, replacing the cache when done.

        During rescan, the old cache continues to serve search requests
        (stale serving / eventual consistency).
        """

        with self._lock:
            if self._state in (CacheState.BUILDING, CacheState.UPDATING):
                return
            previous_state = self._state
            self._state = CacheState.UPDATING
            self._rescan_changes = []

        logger.info(f"Starting periodic rescan for connection {self.connection_id}")

        scan_start = time.monotonic()
        scanned_count = 0
        error_count = 0

        try:
            pool = await get_connection_pool()
            base_path = self._smb_base_path

            # Build a new set — don't modify the live one yet
            new_directories: set[str] = set()
            discovered: set[str] = set()
            applied_changes = 0
            read_directories: set[str] = set()

            def apply_pending_changes() -> None:
                """Called under the cache lock; delayed events make overlapping reads ambiguous."""
                nonlocal new_directories, applied_changes
                changes = self._rescan_changes or []
                pending = changes[applied_changes:]
                if any(
                    mutation.invalidates_read(directory)
                    for mutation in pending
                    if mutation.action != FileAction.FILE_ACTION_ADDED
                    for directory in read_directories
                ):
                    raise RuntimeError("Directory namespace changed after an overlapping read started; keeping the existing index")
                for mutation in pending:
                    new_directories = mutation.apply(new_directories)
                applied_changes = len(changes)

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                queue: list[str] = [""]

                while queue:
                    batch = queue[:SCAN_BATCH_SIZE]
                    queue = queue[SCAN_BATCH_SIZE:]

                    for rel_path in batch:
                        if self._stop_event.is_set():
                            logger.info(f"Rescan cancelled for connection {self.connection_id}")
                            self._state = previous_state
                            return

                        if rel_path:
                            smb_path = f"{base_path}\\{rel_path.replace('/', '\\')}"
                        else:
                            smb_path = base_path

                        try:
                            with self._lock:
                                apply_pending_changes()
                                read_directories.add(rel_path)

                            subdirs = await self._scan_directory_with_pool_lease(pool, smb_path, rel_path)

                            with self._lock:
                                apply_pending_changes()

                                for subdir in subdirs:
                                    if subdir.path not in discovered:
                                        discovered.add(subdir.path)
                                        new_directories.add(subdir.path)
                                        if subdir.can_descend:
                                            queue.append(subdir.path)

                            scanned_count += 1
                        except asyncio.TimeoutError:
                            logger.warning(f"Timeout during rescan of '{rel_path}' for connection {self.connection_id}")
                            error_count += 1
                        except Exception as e:
                            logger.warning(
                                f"Error during rescan of '{rel_path}' for connection {self.connection_id}: {type(e).__name__}: {e}"
                            )
                            error_count += 1

                    await asyncio.sleep(0)

            if error_count:
                self._state = previous_state
                self._scan_error = (
                    f"Directory rescan incomplete: {error_count} directories could not be scanned; keeping the existing index."
                )
                logger.warning("%s Connection: %s", self._scan_error, self.connection_id)
                return

            # Atomically replace the cache
            with self._lock:
                apply_pending_changes()
                self._directories = new_directories
                self._directory_count = len(new_directories)
                self._rescan_changes = None

            self._scan_error = None
            self._last_scan_time = time.time()
            self._state = CacheState.READY
            elapsed = time.monotonic() - scan_start
            logger.info(
                f"Periodic rescan complete for connection {self.connection_id}: "
                f"{self._directory_count} directories, "
                f"{scanned_count} dirs scanned, {error_count} errors, "
                f"{elapsed:.1f}s elapsed"
            )

            # Persist updated snapshot to disk
            self.save_to_disk()

        except asyncio.CancelledError:
            self._state = previous_state
            raise
        except Exception as e:
            # Keep the old cache on failure
            self._state = previous_state
            self._scan_error = f"{type(e).__name__}: {e}"
            elapsed = time.monotonic() - scan_start
            logger.error(
                f"Periodic rescan failed for connection {self.connection_id} after {elapsed:.1f}s: {type(e).__name__}: {e}",
                exc_info=True,
            )
        finally:
            with self._lock:
                self._rescan_changes = None

    # ========================================================================
    # CHANGE_NOTIFY watcher
    # ========================================================================

    #
    # _start_watcher
    #
    def _start_watcher(self) -> None:
        """Start the CHANGE_NOTIFY watcher thread for live directory updates."""

        if self._watcher_thread is not None and self._watcher_thread.is_alive():
            return

        self._watcher_thread = threading.Thread(
            target=self._watcher_loop,
            daemon=True,
            name=f"dir-cache-watcher-{self.connection_id[:8]}",
        )
        self._watcher_thread.start()
        logger.info(f"Started CHANGE_NOTIFY watcher for connection {self.connection_id}")

    #
    # _watcher_loop
    #
    def _watcher_loop(self) -> None:
        """Background thread running the CHANGE_NOTIFY watcher.

        Monitors the share root with WATCH_TREE + DIR_NAME-only filter.
        On directory change events, updates the cache accordingly.
        On connection errors, reconnects with exponential backoff.
        """

        retry_count = 0

        while not self._stop_event.is_set():
            try:
                self._connect_watcher()
                retry_count = 0  # Reset on successful connect

                self._run_watcher_inner()

            except Exception as e:
                if self._stop_event.is_set():
                    break

                retry_count += 1
                if retry_count > MAX_WATCHER_RETRIES:
                    logger.error(
                        f"CHANGE_NOTIFY watcher for connection {self.connection_id} exceeded max retries ({MAX_WATCHER_RETRIES}), stopping"
                    )
                    break

                delay = min(
                    WATCHER_RETRY_BASE_DELAY * (2 ** (retry_count - 1)),
                    WATCHER_RETRY_MAX_DELAY,
                )
                logger.warning(
                    f"CHANGE_NOTIFY watcher error for connection {self.connection_id}, "
                    f"retrying in {delay:.0f}s (attempt {retry_count}/{MAX_WATCHER_RETRIES}): "
                    f"{type(e).__name__}: {e}"
                )

                self._cleanup_watcher()

                if self._stop_event.wait(delay):
                    break  # Stop event was set during wait

        self._cleanup_watcher()
        logger.info(f"CHANGE_NOTIFY watcher stopped for connection {self.connection_id}")

    #
    # _connect_watcher
    #
    def _connect_watcher(self) -> None:
        """Establish a low-level SMB connection for the CHANGE_NOTIFY watcher."""

        policy = get_smbclient_policy_kwargs()

        self._watcher_connection = Connection(
            guid=None,
            server_name=self.host,
            port=self.port,
            require_signing=True,
        )
        self._watcher_connection.connect(timeout=int(policy["connection_timeout"]))

        self._watcher_session = Session(
            self._watcher_connection,
            username=self.username,
            password=self.password,
            require_encryption=bool(policy["encrypt"]),
            auth_protocol=str(policy["auth_protocol"]),
        )
        self._watcher_session.connect()

        self._watcher_tree = TreeConnect(
            self._watcher_session,
            rf"\\{self.host}\{self.share_name}",
        )
        self._watcher_tree.connect()

        # Open the prefix directory for watching (or share root if no prefix)
        watch_path = self._path_prefix.replace("/", "\\") if self._path_prefix else ""
        self._watcher_open = Open(self._watcher_tree, watch_path)
        self._watcher_open.create(
            impersonation_level=ImpersonationLevel.Impersonation,
            desired_access=(DirectoryAccessMask.FILE_LIST_DIRECTORY | DirectoryAccessMask.SYNCHRONIZE),
            file_attributes=SMBFileAttributes.FILE_ATTRIBUTE_DIRECTORY,
            share_access=(ShareAccess.FILE_SHARE_READ | ShareAccess.FILE_SHARE_WRITE | ShareAccess.FILE_SHARE_DELETE),
            create_disposition=CreateDisposition.FILE_OPEN,
            create_options=CreateOptions.FILE_DIRECTORY_FILE,
        )

        logger.debug(f"CHANGE_NOTIFY watcher connected for connection {self.connection_id} ({self.host}/{self.share_name})")

    #
    # _run_watcher_inner
    #
    def _run_watcher_inner(self) -> None:
        """Inner loop: issue CHANGE_NOTIFY, wait for events, process them.

        Runs until stop event is set or an error occurs.
        """

        while not self._stop_event.is_set():
            if self._watcher_open is None:
                break

            watcher = FileSystemWatcher(self._watcher_open)

            # Watch for directory name changes only, across entire tree
            watcher.start(
                completion_filter=CompletionFilter.FILE_NOTIFY_CHANGE_DIR_NAME,
                flags=ChangeNotifyFlags.SMB2_WATCH_TREE,
                output_buffer_length=CHANGE_NOTIFY_BUFFER_SIZE,
                send=True,
            )

            try:
                result = watcher.wait()
            except Exception as e:
                error_msg = str(e).lower()
                # STATUS_NOTIFY_ENUM_DIR (buffer overflow) — ignore per plan
                if "0xc000010c" in error_msg or "notify_enum_dir" in error_msg:
                    logger.info(f"CHANGE_NOTIFY buffer overflow for connection {self.connection_id}, ignoring (next rescan will catch up)")
                    continue
                raise

            if self._stop_event.is_set() or result is None:
                break

            # Debounce: collect events for a short period
            self._process_change_events(result)

    #
    # _process_change_events
    #
    def _process_change_events(self, events: list[dict]) -> None:  # type: ignore[type-arg]
        """Process CHANGE_NOTIFY events and update the cache.

        Args:
            events: List of FILE_NOTIFY_INFORMATION dictionaries from the watcher
        """

        for event in events:
            try:
                action = event["action"].get_value()
                # Filename is relative to the watched directory (share root)
                # and uses backslash separators
                raw_path = event["file_name"].get_value()
                rel_path = raw_path.replace("\\", "/")

                if action == FileAction.FILE_ACTION_ADDED:
                    logger.debug(f"Directory added: '{rel_path}' (connection {self.connection_id})")
                    self.add_directory(rel_path)

                elif action == FileAction.FILE_ACTION_REMOVED:
                    logger.debug(f"Directory removed: '{rel_path}' (connection {self.connection_id})")
                    self.remove_directory(rel_path)

                elif action == FileAction.FILE_ACTION_RENAMED_OLD_NAME:
                    # Store the old name; the next event should be RENAMED_NEW_NAME
                    self._pending_rename_old = rel_path

                elif action == FileAction.FILE_ACTION_RENAMED_NEW_NAME:
                    old_path = getattr(self, "_pending_rename_old", None)
                    if old_path:
                        logger.debug(f"Directory renamed: '{old_path}' -> '{rel_path}' (connection {self.connection_id})")
                        self.rename_directory(old_path, rel_path)
                        self._pending_rename_old = None
                    else:
                        # Got rename-new without rename-old; treat as add
                        logger.debug(f"Directory rename-new without old: '{rel_path}' (connection {self.connection_id})")
                        self.add_directory(rel_path)

            except Exception as e:
                logger.warning(f"Error processing CHANGE_NOTIFY event for connection {self.connection_id}: {type(e).__name__}: {e}")

    #
    # _cleanup_watcher
    #
    def _cleanup_watcher(self) -> None:
        """Clean up CHANGE_NOTIFY SMB resources in proper order.

        Each resource is closed individually so that a failure on one
        does not prevent the others from being released.  We also guard
        against the smbprotocol bug where ``connection.disconnect()``
        raises ``RuntimeError('cannot join current thread')`` when
        called from the library's own message-worker thread after a
        timeout.
        """

        if self._watcher_open:
            try:
                self._watcher_open.close()
            except Exception as e:
                logger.debug(f"Error closing watcher handle: {e}")
            finally:
                self._watcher_open = None

        if self._watcher_tree:
            try:
                self._watcher_tree.disconnect()
            except Exception as e:
                logger.debug(f"Error disconnecting watcher tree: {e}")
            finally:
                self._watcher_tree = None

        if self._watcher_session:
            try:
                self._watcher_session.disconnect()
            except Exception as e:
                logger.debug(f"Error disconnecting watcher session: {e}")
            finally:
                self._watcher_session = None

        if self._watcher_connection:
            try:
                self._watcher_connection.disconnect()
            except RuntimeError as e:
                # smbprotocol bug: disconnect() tries to join the current
                # thread when called from the message-worker after a timeout.
                logger.debug(f"Ignored RuntimeError during watcher connection disconnect: {e}")
            except Exception as e:
                logger.debug(f"Error disconnecting watcher connection: {e}")
            finally:
                self._watcher_connection = None

    # ========================================================================
    # Periodic rescan
    # ========================================================================

    #
    # _start_periodic_rescan
    #
    def _start_periodic_rescan(self) -> None:
        """Start the periodic rescan background task."""

        if self._rescan_task is not None and not self._rescan_task.done():
            return

        self._rescan_task = asyncio.create_task(self._periodic_rescan_loop())

    #
    # _periodic_rescan_loop
    #
    async def _periodic_rescan_loop(self) -> None:
        """Periodically trigger a full rescan."""

        while not self._stop_event.is_set():
            try:
                await asyncio.sleep(RESCAN_INTERVAL_SECONDS)
                if self._stop_event.is_set():
                    break
                await self._run_rescan()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(
                    f"Error in periodic rescan for connection {self.connection_id}: {type(e).__name__}: {e}",
                    exc_info=True,
                )

    # ========================================================================
    # Shutdown
    # ========================================================================

    #
    # stop
    #
    def stop(self) -> None:
        """Stop all background tasks and clean up resources."""

        logger.info(f"Stopping directory cache for connection {self.connection_id}")
        self._request_stop()
        self._finish_stop()

    def _request_stop(self) -> None:
        """Signal running tasks to stop from their owning event loop."""

        self._stop_event.set()

        if self._scan_task and not self._scan_task.done():
            self._scan_task.cancel()

        if self._rescan_task and not self._rescan_task.done():
            self._rescan_task.cancel()

        if self._verification_task and not self._verification_task.done():
            self._verification_task.cancel()

        if self._coalesce_task and not self._coalesce_task.done():
            self._coalesce_task.cancel()

    def _finish_stop(self) -> None:
        """Wait for blocking watcher cleanup after asynchronous tasks stop."""

        # Wait for watcher thread
        if self._watcher_thread and self._watcher_thread.is_alive():
            self._watcher_thread.join(timeout=5.0)
            if self._watcher_thread.is_alive():
                logger.warning(f"Watcher thread did not stop cleanly for connection {self.connection_id}")

        self._cleanup_watcher()

        # Flush dirty cache to disk before clearing
        if self._dirty and self._directory_count > 0:
            self.save_to_disk()

        with self._lock:
            self._directories.clear()
            self._directory_count = 0

        self._state = CacheState.EMPTY
        logger.info(f"Directory cache stopped for connection {self.connection_id}")


# ============================================================================
# DirectoryCacheManager — global singleton
# ============================================================================


class DirectoryCacheManager:
    """
    Manages directory caches for all connections.

    Global singleton accessed via get_directory_cache_manager().
    One ConnectionDirectoryCache per connection_id.
    """

    #
    # __init__
    #
    def __init__(self) -> None:
        self._caches: dict[str, ConnectionDirectoryCache] = {}
        self._lock = threading.Lock()

    #
    # get_cache
    #
    def get_cache(self, connection_id: str) -> Optional[ConnectionDirectoryCache]:
        """Get the directory cache for a connection, if it exists.

        Args:
            connection_id: UUID string of the connection

        Returns:
            The cache instance, or None if not initialized
        """

        with self._lock:
            return self._caches.get(connection_id)

    #
    # get_or_create_cache
    #
    async def get_or_create_cache(
        self,
        connection_id: str,
        host: str,
        share_name: str,
        username: str,
        password: str,
        port: int = 445,
        path_prefix: str = "/",
        source_revision: str = "",
    ) -> ConnectionDirectoryCache:
        """Get or create a directory cache for a connection.

        If the cache doesn't exist, creates it.  Tries to load a persisted
        snapshot first for instant availability; always starts a background
        scan (which doubles as a verification / refresh of the snapshot).

        Args:
            connection_id: UUID string of the connection
            host: SMB server hostname
            share_name: SMB share name
            username: SMB username
            password: SMB password
            port: SMB port
            path_prefix: Base path within the share
            source_revision: Connection revision used to validate persisted snapshots

        Returns:
            The cache instance (may still be building)
        """

        with self._lock:
            previous = self._caches.get(connection_id)
            if previous is not None and (
                previous.host == host
                and previous.share_name == share_name
                and previous.username == username
                and previous.password == password
                and previous.port == port
                and previous._path_prefix == (path_prefix or "/").replace("\\", "/").strip("/")
                and previous._source_identity["revision"] == source_revision
            ):
                return previous

            cache = ConnectionDirectoryCache(
                connection_id=connection_id,
                host=host,
                share_name=share_name,
                username=username,
                password=password,
                port=port,
                path_prefix=path_prefix,
                source_revision=source_revision,
            )
            self._caches[connection_id] = cache

        if previous is not None:
            previous._request_stop()
            await asyncio.to_thread(previous._finish_stop)

        # Try to load cached snapshot from disk for instant availability
        loaded = cache.load_from_disk()

        if loaded:
            # Snapshot loaded — start a background rescan to verify freshness,
            # plus the watcher and coalesce flush loop
            cache._start_watcher()
            cache._start_periodic_rescan()
            cache._start_coalesce_flush()
            # Also kick off a verification rescan immediately (non-blocking)
            cache._verification_task = asyncio.create_task(cache._run_rescan())
        else:
            # No snapshot — do a full scan from scratch
            await cache.start_scan()

        return cache

    #
    # remove_cache
    #
    def remove_cache(self, connection_id: str) -> None:
        """Remove and stop the cache for a connection.

        Args:
            connection_id: UUID string of the connection
        """

        with self._lock:
            cache = self._caches.pop(connection_id, None)

        if cache:
            cache.stop()
            logger.info(f"Removed directory cache for connection {connection_id}")

    async def remove_cache_async(self, connection_id: str) -> None:
        """Remove one cache without blocking the application event loop."""

        with self._lock:
            cache = self._caches.pop(connection_id, None)

        if cache is None:
            return

        cache._request_stop()
        try:
            await asyncio.to_thread(cache._finish_stop)
        except Exception:
            logger.exception("Error stopping cache for connection %s", connection_id)
        else:
            logger.info(f"Removed directory cache for connection {connection_id}")

    #
    # stop_all
    #
    def stop_all(self) -> None:
        """Stop all caches and clean up resources."""

        with self._lock:
            caches = list(self._caches.values())
            self._caches.clear()

        for cache in caches:
            try:
                cache.stop()
            except Exception as e:
                logger.error(
                    f"Error stopping cache for connection {cache.connection_id}: {e}",
                    exc_info=True,
                )

        logger.info("All directory caches stopped")

    async def stop_all_async(self) -> None:
        """Stop all caches without blocking the application event loop."""

        with self._lock:
            caches = list(self._caches.values())
            self._caches.clear()

        for cache in caches:
            cache._request_stop()

        results = await asyncio.gather(
            *(asyncio.to_thread(cache._finish_stop) for cache in caches),
            return_exceptions=True,
        )
        for cache, result in zip(caches, results, strict=True):
            if isinstance(result, BaseException):
                logger.error(
                    f"Error stopping cache for connection {cache.connection_id}: {result}",
                    exc_info=result,
                )

        logger.info("All directory caches stopped")

    #
    # get_stats
    #
    def get_stats(self) -> dict[str, dict[str, object]]:
        """Get statistics for all caches.

        Returns:
            Dict mapping connection_id to cache stats
        """

        with self._lock:
            caches = list(self._caches.items())

        stats: dict[str, dict[str, object]] = {}
        for conn_id, cache in caches:
            stats[conn_id] = {
                "state": cache.state.value,
                "directory_count": cache.directory_count,
                "last_scan_time": cache.last_scan_time,
                "scan_error": cache.scan_error,
            }

        return stats


# Global singleton
_global_cache_manager: Optional[DirectoryCacheManager] = None


#
# get_directory_cache_manager
#
def get_directory_cache_manager() -> DirectoryCacheManager:
    """Get or create the global DirectoryCacheManager instance."""

    global _global_cache_manager
    if _global_cache_manager is None:
        _global_cache_manager = DirectoryCacheManager()
    return _global_cache_manager


#
# shutdown_directory_cache
#
def shutdown_directory_cache() -> None:
    """Shutdown the global cache manager and clean up all resources."""

    global _global_cache_manager
    if _global_cache_manager is not None:
        _global_cache_manager.stop_all()
        _global_cache_manager = None
        logger.info("Directory cache manager shut down")
