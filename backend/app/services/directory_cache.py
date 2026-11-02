"""SQLite directory catalogues with shared SMB observation and verification workers."""

import asyncio
import hashlib
import json
import logging
import threading
import time
from abc import ABC, abstractmethod
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Optional, TypeVar
from uuid import uuid4

from smbclient._os import FileAttributes
from smbprotocol.change_notify import (
    ChangeNotifyFlags,
    CompletionFilter,
    FileAction,
    FileSystemWatcher,
)
from smbprotocol.connection import Connection
from smbprotocol.exceptions import NotifyEnumDir, SMBOSError, SMBResponseException
from smbprotocol.header import NtStatus
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
from smbprotocol.session import Session
from smbprotocol.tree import TreeConnect

from app.core.config import settings, static
from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT
from app.models.system_settings import DirectoryIndexPolicy
from app.services.directory_index import (
    MAX_SIGNED_INTEGER,
    QUERY_WORKERS,
    ROW_BATCH_SIZE,
    SQL_BUSY_TIMEOUT_MS,
    DirectoryIndex,
    DirectoryIndexSearch,
    validate_directory_path,
)
from app.services.directory_index_resources import DirectoryDiskBudgetError, DirectoryIndexResources
from app.services.directory_traversal import DirectoryBindingChangedError, DirectoryTraversalError, SmbDirectoryRead, SmbDirectoryRoot
from app.services.system_settings import get_directory_index_policy, get_smbclient_policy_kwargs
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
SCAN_TIMEOUT_SECONDS = 30.0  # Timeout for single scandir call

# CHANGE_NOTIFY configuration
CHANGE_NOTIFY_BUFFER_SIZE = 65536  # 64 KB — protocol maximum

# Reconnect configuration
MAX_WATCHER_RETRIES = 5
WATCHER_RETRY_BASE_DELAY = 2.0  # seconds
WATCHER_RETRY_MAX_DELAY = 120.0  # seconds

# Search configuration
MAX_SEARCH_RESULTS = 200
PATH_SEPARATOR = "/"

# Persistence configuration
CACHE_PERSIST_SUBDIR = "directory_cache"  # Default subdirectory under data_dir
MAX_PENDING_OBSERVATIONS = DIRECTORY_INDEX_CONTRACT.limits["max_pending_observations"]
MAX_OBSERVATION_BYTES = DIRECTORY_INDEX_CONTRACT.limits["max_observation_bytes"]
SQLITE_CACHE_SUBDIR = "sqlite"
SQLITE_CACHE_EXTENSION = ".sqlite3"
DEGRADED_VERIFICATION_SECONDS = DIRECTORY_INDEX_CONTRACT.policy["degraded_verification_seconds"].default
HEALTHY_VERIFICATION_SECONDS = DIRECTORY_INDEX_CONTRACT.policy["healthy_verification_seconds"].default
OBSERVATION_POLL_SECONDS = DIRECTORY_INDEX_CONTRACT.limits["event_coalescing_ms"] / 1000
WORKER_POLL_SECONDS = SQL_BUSY_TIMEOUT_MS / 1000
FAILURE_RETRY_MIN_SECONDS = 30.0
FAILURE_RETRY_MAX_SECONDS = 300.0
FAILURE_RETRY_JITTER_PERCENT = 10
PERIODIC_VERIFICATION_JITTER_PERCENT = 10
READ_PARENT_ACTION = -1
WorkerResult = TypeVar("WorkerResult")


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


@dataclass(frozen=True)
class ScanReadToken:
    epoch: int
    sequence: int
    path: str
    producer_id: int


class ScanObservationInvalidated(RuntimeError):
    """A filesystem observation can no longer be safely committed."""


class DirectoryScanCoordinator:
    """Serialize bounded observations and reject stale filesystem batches."""

    def __init__(
        self, index: DirectoryIndex, *, maximum_pending: int = MAX_PENDING_OBSERVATIONS, maximum_bytes: int = MAX_OBSERVATION_BYTES
    ) -> None:
        if maximum_pending < 1 or maximum_bytes < 1:
            raise ValueError("Directory observation limits must be positive.")
        self.index = index
        self.maximum_pending = maximum_pending
        self.maximum_bytes = maximum_bytes
        self.lock = threading.RLock()
        self.pending: deque[tuple[int, _DirectoryMutation, int]] = deque()
        self.barriers: deque[tuple[int, str, int]] = deque()
        self.pending_bytes = 0
        self.barrier_bytes = 0
        self.sequence = 0
        self.epoch = 0
        self.verification_required = True
        self._uncertain_pending = False
        self._next_producer_id = 0
        self._producers: dict[int, ScanReadToken] = {}

    def invalidate(self) -> None:
        with self.lock:
            self.epoch += 1
            self.barriers.clear()
            self.barrier_bytes = 0
            self.verification_required = True
            self._uncertain_pending = True

    def enqueue(self, mutation: _DirectoryMutation) -> bool:
        if mutation.path or mutation.action != READ_PARENT_ACTION:
            validate_directory_path(mutation.path)
        if mutation.new_path is not None:
            validate_directory_path(mutation.new_path)
        paths = (mutation.path,) if mutation.new_path is None else (mutation.path, mutation.new_path)
        size = sum(len(path.encode("utf-8")) for path in paths)
        with self.lock:
            if self.sequence >= MAX_SIGNED_INTEGER:
                self.invalidate()
                raise OverflowError("Directory observation sequence is exhausted. Reinitialize this source.")
            self.sequence += 1
            if len(self.pending) >= self.maximum_pending or self.pending_bytes + size > self.maximum_bytes:
                self.invalidate()
                return False
            self.pending.append((self.sequence, mutation, size))
            self.pending_bytes += size
            self.verification_required = True
            for path in paths:
                self._record_barrier(path)
            return True

    def _record_barrier(self, path: str) -> None:
        """Merge overlapping prefixes without allowing an older read to publish."""
        retained: deque[tuple[int, str, int]] = deque()
        prefix = path
        for sequence, existing, size in self.barriers:
            if not existing or path == existing or path.startswith(existing + PATH_SEPARATOR):
                prefix = existing
            elif path and not existing.startswith(path + PATH_SEPARATOR):
                retained.append((sequence, existing, size))
        size = len(prefix.encode("utf-8"))
        total_bytes = sum(entry[2] for entry in retained) + size
        if len(retained) >= self.maximum_pending or total_bytes > self.maximum_bytes:
            self.invalidate()
            return
        retained.append((self.sequence, prefix, size))
        self.barriers = retained
        self.barrier_bytes = total_bytes

    def begin_read(self, path: str) -> ScanReadToken:
        if path:
            validate_directory_path(path)
        with self.lock:
            if len(self._producers) >= MAX_PENDING_OBSERVATIONS or self._next_producer_id >= MAX_SIGNED_INTEGER:
                self.invalidate()
                raise ScanObservationInvalidated("Directory read capacity is exhausted. Wait for active source reads to finish.")
            self._next_producer_id += 1
            token = ScanReadToken(self.epoch, self.sequence, path, self._next_producer_id)
            self._producers[token.producer_id] = token
            return token

    def end_read(self, token: ScanReadToken) -> None:
        """Release a producer only after its reads and synchronous batches have exited."""
        with self.lock:
            if self._producers.get(token.producer_id) == token:
                del self._producers[token.producer_id]
                self._retire_barriers()

    @contextmanager
    def read(self, path: str) -> Iterator[ScanReadToken]:
        token = self.begin_read(path)
        try:
            yield token
        finally:
            self.end_read(token)

    def _retire_barriers(self) -> None:
        """Pending mutations and older live reads retain their rejection fences."""
        oldest = min(
            (token.sequence for token in self._producers.values() if token.epoch == self.epoch),
            default=self.sequence,
        )
        if self.pending:
            oldest = min(oldest, self.pending[0][0] - 1)
        self.barriers = deque(entry for entry in self.barriers if entry[0] > oldest)
        self.barrier_bytes = sum(entry[2] for entry in self.barriers)

    def is_current(self, token: ScanReadToken) -> bool:
        with self.lock:
            return (
                self._producers.get(token.producer_id) == token
                and token.epoch == self.epoch
                and not any(
                    sequence > token.sequence
                    and (
                        not path
                        or not token.path
                        or path == token.path
                        or path.startswith(token.path + PATH_SEPARATOR)
                        or token.path.startswith(path + PATH_SEPARATOR)
                    )
                    for sequence, path, _size in self.barriers
                )
            )

    def apply_pending(self) -> int:
        with self.lock:
            if self._uncertain_pending:
                self.index.mark_uncertain()
                self._uncertain_pending = False
            applied = 0
            while self.pending and applied < ROW_BATCH_SIZE:
                _sequence, mutation, size = self.pending[0]
                if mutation.action == READ_PARENT_ACTION:
                    self.index.queue_observed_parent(mutation.path)
                elif mutation.action == FileAction.FILE_ACTION_ADDED:
                    self.index.mutate_observed_path("add", mutation.path)
                elif mutation.action == FileAction.FILE_ACTION_REMOVED:
                    self.index.mutate_observed_path("remove", mutation.path)
                elif mutation.action == FileAction.FILE_ACTION_RENAMED_NEW_NAME:
                    self.index.mutate_observed_path("rename", mutation.path, mutation.new_path)
                else:
                    self.invalidate()
                    raise ValueError("Directory observation action is unsupported. Request source verification.")
                self.pending.popleft()
                self.pending_bytes -= size
                applied += 1
            self._retire_barriers()
            return applied

    def commit_children(
        self, token: ScanReadToken, generation_id: int, children: Iterable[tuple[str, bool]], *, reconcile: bool = False
    ) -> None:
        with self.lock:
            if not self.is_current(token):
                self.verification_required = True
                raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
            self.apply_pending()
            if reconcile:
                self.index.write_reconciliation_children(generation_id, token.path, children)
            else:
                self.index.write_scan_children(generation_id, children)

    def record_unsafe_traversal(self, token: ScanReadToken, generation_id: int) -> None:
        self._record_scan_issue(token, generation_id, self.index.record_unsafe_traversal)

    def record_access_denied(self, token: ScanReadToken, generation_id: int) -> None:
        self._record_scan_issue(token, generation_id, self.index.record_access_denied)

    def _record_scan_issue(self, token: ScanReadToken, generation_id: int, record: Callable[[int], None]) -> None:
        with self.lock:
            if not self.is_current(token):
                self.verification_required = True
                raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
            self.apply_pending()
            record(generation_id)

    def finish_parent(self, token: ScanReadToken, generation_id: int, *, reconcile: bool = False) -> None:
        with self.lock:
            if not self.is_current(token):
                self.verification_required = True
                raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
            self.apply_pending()
            if reconcile:
                self.index.finish_reconciliation_parent(generation_id, token.path)
            else:
                self.index.finish_scan_parent(generation_id, token.path)

    def accept_generation(self, token: ScanReadToken, generation_id: int, *, issue_count: int = 0) -> bool:
        with self.lock:
            if (
                token.path
                or self._producers.get(token.producer_id) != token
                or token.epoch != self.epoch
                or self._uncertain_pending
                or self.pending
                or any(producer != token and producer.epoch == self.epoch for producer in self._producers.values())
            ):
                self.verification_required = True
                raise ScanObservationInvalidated("Directory scan capture is not current. Drain source observations and retry verification.")
            if self.index.reconciliation_generation() is not None or self.index.pending_scan_paths(generation_id, limit=1):
                self.verification_required = True
                raise ScanObservationInvalidated(
                    "Directory parent work remains pending. Complete reconciliation before source verification."
                )
            accepted = self.index.finish_generation(generation_id, issue_count=issue_count)
            self.verification_required = not accepted
            if accepted:
                self._uncertain_pending = False
            return accepted


# ============================================================================
# ConnectionDirectoryCache — per-connection cache
# ============================================================================


class ConnectionDirectoryCache(ABC):
    """Shared SMB binding, watcher, and task lifecycle for a directory catalogue."""

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
            source_revision: Connection revision used to invalidate source bindings after edits
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
        self._source_identity: dict[str, str | int] = {
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

        # State tracking
        self._state = CacheState.EMPTY
        self._directory_count = 0
        self._last_scan_time: Optional[float] = None
        self._scan_error: Optional[str] = None

        # Background tasks
        self._scan_task: Optional[asyncio.Task[None]] = None
        self._rescan_task: Optional[asyncio.Task[None]] = None
        self._watcher_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # CHANGE_NOTIFY SMB resources
        self._watcher_connection: Optional[Connection] = None
        self._watcher_session: Optional[Session] = None
        self._watcher_tree: Optional[TreeConnect] = None
        self._watcher_open: Optional[Open] = None
        self._watcher_received_events = False

        self._cache_root = self._resolve_cache_root()

    @property
    def state(self) -> CacheState:
        """Current cache state."""

        return self._state

    @staticmethod
    def _resolve_cache_root() -> Path:
        """Resolve the configured parent of the private SQLite namespace.

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

        return base

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
    @abstractmethod
    def search(self, query: str, max_results: int = MAX_SEARCH_RESULTS, *, include_dot_directories: bool = False) -> tuple[list[str], int]:
        """Query the selected catalogue without traversing the source."""
        raise NotImplementedError

    @abstractmethod
    def _apply_mutations(self, mutations: list[_DirectoryMutation]) -> None:
        """Queue bounded source observations for the owning writer."""
        raise NotImplementedError

    @abstractmethod
    async def start_scan(self) -> None:
        """Start or join background catalogue initialization."""
        raise NotImplementedError

    @abstractmethod
    async def _run_rescan(self) -> None:
        """Verify the source while preserving the selected catalogue."""
        raise NotImplementedError

    @abstractmethod
    def _process_change_events(self, events: list[dict[str, Any]]) -> None:
        """Route native hints without inferring unverified directory rows."""
        raise NotImplementedError

    @abstractmethod
    def _observation_lost(self) -> None:
        """Invalidate live reads and retain a verification request."""
        raise NotImplementedError

    @abstractmethod
    def _finish_stop(self) -> None:
        """Retain source and storage ownership until actual worker exit."""
        raise NotImplementedError

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
            self._watcher_received_events = False
            try:
                self._connect_watcher()
                self._run_watcher_inner()

            except Exception as e:
                if self._stop_event.is_set():
                    break

                self._observation_lost()
                retry_count = 1 if self._watcher_received_events else retry_count + 1
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
            auth_protocol=policy["auth_protocol"],
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
            except NotifyEnumDir:
                result = []

            if self._stop_event.is_set():
                break
            if result is None:
                raise ConnectionError("Directory observation stopped unexpectedly. Reconnect and verify the source.")
            if not result:
                self._observation_lost()
                logger.info("Directory observation details were lost; source verification is required.")
                continue

            # Debounce: collect events for a short period
            self._process_change_events(result)
            self._watcher_received_events = True

    #
    # _process_change_events
    #

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
    @abstractmethod
    async def _periodic_rescan_loop(self) -> None:
        """Run observation, verification, retry, and maintenance scheduling."""
        raise NotImplementedError

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


class DirectorySourceUnavailableError(InterruptedError):
    """A failed root read prevents retained results from leaving the binding."""


class DirectoryScanCapacityError(TimeoutError):
    """A source must retry without starting another blocking root probe."""


class SQLiteConnectionDirectoryCache(ConnectionDirectoryCache):
    """Disk-backed SMB source with shared scan work and bounded observations."""

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
        *,
        query_slots: threading.BoundedSemaphore | None = None,
        scan_slots: threading.BoundedSemaphore | None = None,
    ) -> None:
        super().__init__(connection_id, host, share_name, username, password, port, path_prefix, source_revision)
        self._source_identity["connection_id"] = connection_id
        self._source_identity["runtime_session"] = uuid4().hex
        identity = json.dumps(self._source_identity, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        filename = hashlib.sha256(identity.encode("utf-8")).hexdigest() + SQLITE_CACHE_EXTENSION
        self._persist_path = self._cache_root / SQLITE_CACHE_SUBDIR / filename
        self.index = DirectoryIndex(self._persist_path, source_kind="smb", source_identity=self._source_identity)
        self.policy = DirectoryIndexPolicy()
        self.resources = DirectoryIndexResources(self._persist_path.parent, self.policy)
        self.resources.register_source(self._persist_path)
        self.index.growth_guard = self.resources.reserve_growth
        self.coordinator = DirectoryScanCoordinator(self.index)
        self._manager_query_slots = query_slots if query_slots is not None else threading.BoundedSemaphore(QUERY_WORKERS)
        self._manager_scan_slots = scan_slots if scan_slots is not None else threading.BoundedSemaphore(1)
        self._workers = threading.Condition()
        self._finish_lock = threading.Lock()
        self._storage_released = False
        self._active_workers = 0
        self._opened = threading.Event()
        self._generation_lock = threading.Lock()
        self._scan_progress = time.monotonic()
        self._scan_running = threading.Event()
        self._resource_retry_at = 0.0
        self._failure_retry_delay = 0.0
        self._retry_jitter = hashlib.sha256(identity.encode("utf-8")).digest()[0]
        self._owning_loop: asyncio.AbstractEventLoop | None = None
        self._last_access = time.monotonic()
        self._last_access_at_ms = int(time.time() * 1000)
        self._cleanup_pending = True
        self._reclamation_pending = False
        self._source_available = threading.Event()
        self._source_probe_completed = threading.Event()
        self._root_reading = threading.Event()
        self._source_root = SmbDirectoryRoot(self._smb_base_path)

    def touch(self) -> None:
        self._last_access = time.monotonic()
        self._last_access_at_ms = int(time.time() * 1000)

    def can_release_idle(self) -> bool:
        with self._workers:
            return (
                time.monotonic() - self._last_access >= DIRECTORY_INDEX_CONTRACT.limits["idle_release_seconds"]
                and not self._active_workers
                and not self._scan_running.is_set()
                and not self.index.has_active_queries
            )

    def _maintenance_blocked(self) -> bool:
        return (
            self._stop_event.is_set()
            or bool(self.coordinator.pending)
            or self.index.has_active_queries
            or self._scan_running.is_set()
            or self.index.reconciliation_generation() is not None
        )

    def _cleanup_retired_work(self) -> None:
        deadline = time.monotonic() + WORKER_POLL_SECONDS
        while self._cleanup_pending and not self._stop_event.is_set() and time.monotonic() < deadline:
            with self.coordinator.lock:
                if self._maintenance_blocked():
                    return
                self._cleanup_pending = self.index.cleanup_retired_batch()

    def _reclaim_disk_work(self) -> None:
        with self.coordinator.lock:
            if not self._reclamation_pending or self._maintenance_blocked():
                return
            self._reclamation_pending = not self.index.reclaim_pages()

    def _checkpoint_work(self) -> None:
        with self.coordinator.lock:
            if self._maintenance_blocked():
                return
            self.index.checkpoint_if_due()

    def _repair_fts_work(self) -> None:
        while not self._manager_scan_slots.acquire(timeout=WORKER_POLL_SECONDS):
            if self._stop_event.is_set():
                raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
        try:
            self._scan_running.set()
            while self.index.needs_fts_repair:
                if self._stop_event.is_set():
                    raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                with self.coordinator.lock:
                    self.index.repair_fts_batch()
        finally:
            self._scan_running.clear()
            self._manager_scan_slots.release()

    async def _blocking(self, operation: Callable[[], WorkerResult], *, pool: SMBConnectionPool | None = None) -> WorkerResult:
        def run() -> WorkerResult:
            try:
                if self._stop_event.is_set():
                    raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                return operation()
            finally:
                with self._workers:
                    self._active_workers -= 1
                    self._workers.notify_all()

        with self._workers:
            if self._stop_event.is_set():
                raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
            self._active_workers += 1
        try:
            future = asyncio.get_running_loop().run_in_executor(None, run)
        except BaseException:
            with self._workers:
                self._active_workers -= 1
                self._workers.notify_all()
            raise

        def report_abandoned(completed: asyncio.Future[WorkerResult]) -> None:
            if not completed.cancelled():
                error = completed.exception()
                if error is not None:
                    logger.warning("Abandoned directory worker failed (%s).", type(error).__name__)

        try:
            if pool is None:
                return await asyncio.shield(future)
            self._scan_progress = time.monotonic()
            while True:
                try:
                    return await asyncio.wait_for(asyncio.shield(future), timeout=WORKER_POLL_SECONDS)
                except TimeoutError:
                    if future.done():
                        return future.result()
                    if time.monotonic() - self._scan_progress >= SCAN_TIMEOUT_SECONDS:
                        self.coordinator.invalidate()
                        future.add_done_callback(report_abandoned)
                        await pool.retain_connection_until_future_complete(self._connection_cache, future)
                        raise TimeoutError("Directory read has stalled. Scan capacity stays reserved until the worker exits.") from None
        except asyncio.CancelledError:
            self.coordinator.invalidate()
            future.add_done_callback(report_abandoned)
            if pool is not None:
                await pool.retain_connection_until_future_complete(self._connection_cache, future)
            raise

    async def start_scan(self) -> None:
        if self._stop_event.is_set() or time.monotonic() < self._resource_retry_at:
            return
        if self._scan_task is not None and not self._scan_task.done():
            return
        self._owning_loop = asyncio.get_running_loop()
        self._state = CacheState.BUILDING
        self._scan_task = asyncio.create_task(self._initialize())

    async def _initialize(self) -> None:
        try:
            await self._blocking(self._initialize_storage)
            self._opened.set()
            self._directory_count = (await self._blocking(self.index.status)).directory_count
            self._start_watcher()
            await self._run_rescan()
            self._start_periodic_rescan()
        except asyncio.CancelledError:
            return
        except Exception as error:
            self._scan_error = (
                str(error)
                if isinstance(error, DirectoryDiskBudgetError)
                else "Directory index storage is in use. Wait for active workers to finish, then retry."
                if isinstance(error, BlockingIOError)
                else "Directory index initialization failed. Check private local storage and reopen the connection."
            )
            self._state = CacheState.READY if self._opened.is_set() else CacheState.EMPTY
            self._schedule_retry()
            self._start_periodic_rescan()
            logger.warning("Directory index initialization failed (%s).", type(error).__name__)

    def _initialize_storage(self) -> None:
        self.apply_policy(get_directory_index_policy())
        self.index.open(rebuild_invalid=True)

    def apply_policy(self, policy: DirectoryIndexPolicy) -> None:
        changed = policy != self.policy
        self.resources.apply_policy(policy)
        self.index.configure_page_cache(policy.page_cache_kib)
        self.policy = DirectoryIndexPolicy.model_validate(policy.model_dump())
        if changed:
            self._reset_retry()
        if not self._opened.is_set() and self._owning_loop is not None and not self._stop_event.is_set():
            if self._scan_task is None or self._scan_task.done():
                self._owning_loop.call_soon_threadsafe(lambda: asyncio.create_task(self.start_scan()))

    def search(self, query: str, max_results: int = MAX_SEARCH_RESULTS, *, include_dot_directories: bool = False) -> tuple[list[str], int]:
        response = self.search_index(query, max_results, include_dot_directories=include_dot_directories)
        return [row.path for row in response.results], response.total_matches

    def search_index(
        self,
        query: str,
        max_results: int = MAX_SEARCH_RESULTS,
        *,
        include_dot_directories: bool = False,
        cancelled: threading.Event | None = None,
    ) -> DirectoryIndexSearch:
        self.touch()
        if self._stop_event.is_set():
            raise InterruptedError("Directory source was replaced or stopped. Retry the search on the current connection.")
        if not self._opened.is_set():
            return DirectoryIndexSearch((), 0, 0, 0, "partial", None, "empty")
        if not self._source_available.is_set():
            if not self._source_probe_completed.is_set():
                return DirectoryIndexSearch((), 0, 0, 0, "partial", None, "empty")
            raise DirectorySourceUnavailableError(
                "Directory source root is unavailable. Restore source access and retry the search after verification."
            )
        if not self._manager_query_slots.acquire(timeout=WORKER_POLL_SECONDS):
            raise TimeoutError("Directory query workers are busy. Wait briefly and retry the search.")
        try:
            response = self.index.search(
                query.replace("\\", "/"), limit=max_results, include_dot_directories=include_dot_directories, cancelled=cancelled
            )
            if self._stop_event.is_set():
                raise InterruptedError("Directory source was replaced or stopped. Retry the search on the current connection.")
            if not self._source_available.is_set():
                raise DirectorySourceUnavailableError(
                    "Directory source root is unavailable. Restore source access and retry the search after verification."
                )
            return response
        finally:
            self._manager_query_slots.release()

    def _apply_mutations(self, mutations: list[_DirectoryMutation]) -> None:
        for mutation in mutations:
            if not self.coordinator.enqueue(mutation):
                self._scan_error = "Directory observations were lost. Background verification is required."

    def observe_parent(self, parent: str) -> None:
        """Queue source validation without assuming that a destination is a directory."""
        self._apply_mutations([_DirectoryMutation(READ_PARENT_ACTION, parent.strip("/"))])

    def _observation_lost(self) -> None:
        self.coordinator.invalidate()
        self._scan_error = "Directory observations were lost. Background verification is required."

    def _process_change_events(self, events: list[dict[str, Any]]) -> None:
        """Treat rename directions independently and discover destinations from parents."""
        for event in events:
            try:
                action = event["action"].get_value()
                path = event["file_name"].get_value().replace("\\", "/")
                validate_directory_path(path)
                parent = path.rpartition(PATH_SEPARATOR)[0]
                if action in (FileAction.FILE_ACTION_REMOVED, FileAction.FILE_ACTION_RENAMED_OLD_NAME):
                    self._apply_mutations([_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, path)])
                elif action not in (FileAction.FILE_ACTION_ADDED, FileAction.FILE_ACTION_RENAMED_NEW_NAME):
                    self._observation_lost()
                    continue
                self._apply_mutations([_DirectoryMutation(READ_PARENT_ACTION, parent)])
            except Exception as error:
                self._observation_lost()
                logger.warning("Directory observation could not be queued (%s).", type(error).__name__)

    class _DescendantAccessDenied(PermissionError):
        """A source operation failed, not a local index write."""

    def _source_call(self, parent: str, operation: Callable[[], WorkerResult]) -> WorkerResult:
        if not parent:
            self._root_reading.set()
        try:
            return operation()
        except DirectoryBindingChangedError as error:
            self._source_available.clear()
            self._source_probe_completed.set()
            self.coordinator.invalidate()
            raise DirectorySourceUnavailableError(
                "Directory source identity changed or cannot be verified. Reconnect the source to rebuild its directory index."
            ) from error
        except Exception as error:
            if parent:
                if (
                    isinstance(error, PermissionError)
                    or (isinstance(error, SMBOSError) and error.ntstatus == NtStatus.STATUS_ACCESS_DENIED)
                    or (isinstance(error, SMBResponseException) and error.status == NtStatus.STATUS_ACCESS_DENIED)
                ):
                    raise self._DescendantAccessDenied(
                        "Directory descendant access was denied. Restore source permissions and retry verification."
                    ) from error
                raise
            self._source_available.clear()
            self._source_probe_completed.set()
            raise DirectorySourceUnavailableError(
                "Directory source root is unavailable. Restore source access and retry verification."
            ) from error
        finally:
            if not parent:
                self._root_reading.clear()

    @contextmanager
    def _source_read(self, parent: str, close: Callable[[], None]) -> Iterator[None]:
        """Keep the primary read failure when cleanup also fails."""
        try:
            yield
        except BaseException:
            try:
                self._source_call(parent, close)
            except Exception as error:
                logger.warning("Directory source read cleanup failed (%s).", type(error).__name__)
            raise
        else:
            self._source_call(parent, close)

    def _probe_source_root(self) -> None:
        if not self._manager_scan_slots.acquire(blocking=False):
            raise DirectoryScanCapacityError("Directory scan capacity is in use. Wait for active work to finish, then retry.")
        try:
            self._scan_running.set()
            with self.coordinator.read("") as token:
                self._probe_source_root_read(token)
        finally:
            self._scan_running.clear()
            self._manager_scan_slots.release()

    def _probe_source_root_read(self, token: ScanReadToken) -> None:
        entries = self._source_call("", lambda: self._open_source_read("", token))
        with self._source_read("", entries.close):
            self._source_call("", lambda: next(entries, None))
            self._source_call("", entries.verify)
            if self._stop_event.is_set() or not self.coordinator.is_current(token):
                raise ScanObservationInvalidated("Directory root observation became stale. Retry source verification.")
        with self.coordinator.lock:
            if self._stop_event.is_set() or not self.coordinator.is_current(token):
                raise ScanObservationInvalidated("Directory root observation became stale. Retry source verification.")
            self._source_available.set()
            self._source_probe_completed.set()

    def _open_source_read(self, parent: str, token: ScanReadToken) -> SmbDirectoryRead:
        def check() -> None:
            if self._stop_event.is_set():
                raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
            if not self.coordinator.is_current(token):
                raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
            self._scan_progress = time.monotonic()

        return self._source_root.read(
            parent,
            check,
            username=self.username,
            password=self.password,
            port=self.port,
            connection_cache=self._connection_cache,
            **get_smbclient_policy_kwargs(),
        )

    def _scan_parent(self, generation: int, parent: str, *, reconcile: bool = False) -> None:
        with self.coordinator.read(parent) as token:
            try:
                self._scan_parent_read(generation, parent, token, reconcile=reconcile)
            except self._DescendantAccessDenied:
                if self._stop_event.is_set():
                    raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.") from None
                if reconcile:
                    raise
                self.coordinator.record_access_denied(token, generation)
                self.coordinator.finish_parent(token, generation)
            except DirectoryTraversalError:
                if self._stop_event.is_set():
                    raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.") from None
                if reconcile:
                    raise
                self.coordinator.record_unsafe_traversal(token, generation)
                self.coordinator.finish_parent(token, generation)

    def _scan_parent_read(self, generation: int, parent: str, token: ScanReadToken, *, reconcile: bool = False) -> None:
        entries = self._source_call(parent, lambda: self._open_source_read(parent, token))
        batch: list[tuple[str, bool]] = []
        batch_bytes = 0
        with self._source_read(parent, entries.close):
            while True:
                if self._stop_event.is_set():
                    raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                if not self.coordinator.is_current(token):
                    raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
                self._scan_progress = time.monotonic()
                entry = self._source_call(parent, lambda: next(entries, None))
                if self._stop_event.is_set():
                    raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                if not self.coordinator.is_current(token):
                    raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
                if entry is None:
                    break
                self._scan_progress = time.monotonic()
                if entry.name is None:
                    if reconcile:
                        raise DirectoryTraversalError(
                            "Directory reconciliation found an unsupported name. Complete source verification is required."
                        )
                    self.coordinator.record_unsafe_traversal(token, generation)
                    continue
                if entry.name in (".", ".."):
                    continue
                if PATH_SEPARATOR in entry.name or "\\" in entry.name:
                    raise ValueError("Directory entry has an unsupported separator. Source coverage is incomplete.")
                attributes = entry.smb_info.file_attributes
                if not attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY:
                    continue
                if attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT:
                    if reconcile:
                        raise OSError("Directory reconciliation found a redirected directory. Complete source verification is required.")
                    self.coordinator.record_unsafe_traversal(token, generation)
                    continue
                path = parent + PATH_SEPARATOR + entry.name if parent else entry.name
                validate_directory_path(path)
                path_bytes = len(path.encode("utf-8"))
                if path_bytes > MAX_OBSERVATION_BYTES:
                    raise ValueError("Directory path exceeds the scan-batch byte limit. Source coverage is incomplete.")
                if batch and batch_bytes + path_bytes > MAX_OBSERVATION_BYTES:
                    self._source_call(parent, entries.verify)
                    self.coordinator.commit_children(token, generation, batch, reconcile=reconcile)
                    batch.clear()
                    batch_bytes = 0
                batch.append((path, True))
                batch_bytes += path_bytes
                if len(batch) == ROW_BATCH_SIZE:
                    self._source_call(parent, entries.verify)
                    self.coordinator.commit_children(token, generation, batch, reconcile=reconcile)
                    batch.clear()
                    batch_bytes = 0
            if batch:
                self._source_call(parent, entries.verify)
                self.coordinator.commit_children(token, generation, batch, reconcile=reconcile)
            self._source_call(parent, entries.verify)
            self._prune_missing_children(generation, parent, token, entries, reconcile=reconcile)
        with self.coordinator.lock:
            if self._stop_event.is_set():
                raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
            self.coordinator.finish_parent(token, generation, reconcile=reconcile)
            if not parent:
                self._source_available.set()
                self._source_probe_completed.set()

    def _prune_missing_children(
        self, generation: int, parent: str, token: ScanReadToken, entries: SmbDirectoryRead, *, reconcile: bool
    ) -> None:
        cursor: str | None = None
        while True:
            page = self.index.direct_child_paths(generation, parent, after_path=cursor)
            if not page:
                return
            for path in page:
                if self._source_call(parent, lambda: entries.has_directory_child(path.rsplit(PATH_SEPARATOR, 1)[-1])):
                    continue
                more = True
                while more:
                    self._source_call(parent, entries.verify)
                    with self.coordinator.lock:
                        if self._stop_event.is_set():
                            raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                        if not self.coordinator.is_current(token):
                            raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
                        self.coordinator.apply_pending()
                        if reconcile:
                            self.index.write_reconciliation_children(generation, parent, ())
                        more = self.index.prune_subtree_batch(generation, path)
            cursor = page[-1]

    def _reconcile_disk_queue(self) -> None:
        """Read bounded accepted-parent work without advancing full-pass clocks."""
        if self._stop_event.is_set() or time.monotonic() < self._resource_retry_at or not self._source_available.is_set():
            return
        if not self._generation_lock.acquire(blocking=False):
            return
        try:
            if not self._manager_scan_slots.acquire(blocking=False):
                return
            try:
                self._scan_running.set()
                deadline = time.monotonic() + WORKER_POLL_SECONDS
                generation = self.index.reconciliation_generation()
                while generation is not None and time.monotonic() < deadline:
                    if self._stop_event.is_set():
                        raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                    if self.index.reconciliation_generation() != generation:
                        return
                    parents = self.index.pending_scan_paths(generation, limit=1)
                    if not parents:
                        return
                    self._scan_parent(generation, parents[0], reconcile=True)
            finally:
                self._scan_running.clear()
                self._manager_scan_slots.release()
        finally:
            self._generation_lock.release()

    async def _run_reconciliation(self) -> None:
        if (
            self._stop_event.is_set()
            or self._scan_running.is_set()
            or time.monotonic() < self._resource_retry_at
            or not self._source_available.is_set()
            or await self._blocking(self.index.reconciliation_generation) is None
        ):
            return
        connected = False
        try:
            pool = await get_connection_pool()
            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                connected = True
                await self._blocking(self._reconcile_disk_queue, pool=pool)
        except Exception:
            if not connected:
                self._source_available.clear()
                self._source_probe_completed.set()
            raise

    def _scan_disk_queue(self) -> None:
        while not self._manager_scan_slots.acquire(timeout=WORKER_POLL_SECONDS):
            self._scan_progress = time.monotonic()
            if self._stop_event.is_set():
                raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
        try:
            self._scan_running.set()
            self._scan_progress = time.monotonic()
            with self._generation_lock, self.coordinator.read("") as baseline:
                generation, selected = self.index.prepare_scan()
                self.index.seed_scan(generation)
                try:
                    while not self._stop_event.is_set():
                        with self.coordinator.lock:
                            if baseline.epoch != self.coordinator.epoch:
                                raise ScanObservationInvalidated("Directory scan epoch changed. Retry source verification.")
                            self.coordinator.apply_pending()
                            if self.coordinator.pending:
                                continue
                        reconciliation = self.index.reconciliation_generation()
                        current = reconciliation if reconciliation is not None else generation
                        parents = self.index.pending_scan_paths(current, limit=1)
                        if not parents:
                            with self.coordinator.read("") as root_token:
                                self._probe_source_root_read(root_token)
                            with self.coordinator.lock:
                                if self._stop_event.is_set():
                                    raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                                self.coordinator.accept_generation(baseline, generation)
                            self._cleanup_pending = True
                            self._state = CacheState.READY
                            self._scan_error = None
                            self._last_scan_time = time.time()
                            break
                        self._scan_parent(current, parents[0], reconcile=reconciliation is not None)
                        status = self.index.status()
                        self._directory_count = status.directory_count
                    else:
                        raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                except BaseException:
                    self.coordinator.invalidate()
                    if not selected:
                        self.index.discard_generation(generation)
                        self._cleanup_pending = True
                    raise
        finally:
            self._scan_running.clear()
            self._manager_scan_slots.release()

    def _schedule_retry(self, *, now: float | None = None) -> None:
        """Spread bounded retries without changing the configured full-pass interval."""
        self._failure_retry_delay = (
            FAILURE_RETRY_MIN_SECONDS if not self._failure_retry_delay else min(self._failure_retry_delay * 2, FAILURE_RETRY_MAX_SECONDS)
        )
        percent = 100 - FAILURE_RETRY_JITTER_PERCENT + self._retry_jitter % (FAILURE_RETRY_JITTER_PERCENT * 2 + 1)
        delay = min(FAILURE_RETRY_MAX_SECONDS, max(FAILURE_RETRY_MIN_SECONDS, self._failure_retry_delay * percent / 100))
        self._resource_retry_at = (time.monotonic() if now is None else now) + delay

    def _reset_retry(self) -> None:
        self._failure_retry_delay = 0.0
        self._resource_retry_at = 0.0

    def _verification_due(self, verified_at: float, *, now: float | None = None) -> bool:
        current = time.monotonic() if now is None else now
        interval = (
            self.policy.degraded_verification_seconds
            if self.coordinator.verification_required
            else self.policy.healthy_verification_seconds
        )
        delay = interval * (100 - self._retry_jitter % (PERIODIC_VERIFICATION_JITTER_PERCENT + 1)) / 100
        return current >= self._resource_retry_at and (bool(self._failure_retry_delay) or current >= verified_at + delay)

    async def _run_rescan(self) -> None:
        if not self._opened.is_set() or self._scan_running.is_set() or time.monotonic() < self._resource_retry_at:
            return
        self._state = CacheState.UPDATING if self._directory_count else CacheState.BUILDING
        root_checked = False
        try:
            pool = await get_connection_pool()
            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                await self._blocking(self._probe_source_root, pool=pool)
                root_checked = True
                if self.index.needs_fts_repair:
                    self._scan_error = "Directory search index is being rebuilt. Existing directory rows remain searchable."
                    await self._blocking(self._repair_fts_work)
                await self._blocking(self._scan_disk_queue, pool=pool)
            self._reset_retry()
        except asyncio.CancelledError:
            self.coordinator.invalidate()
            raise
        except Exception as error:
            capacity_busy = isinstance(error, DirectoryScanCapacityError)
            if not capacity_busy and (not root_checked or self._root_reading.is_set()):
                self._source_available.clear()
                self._source_probe_completed.set()
            if isinstance(error, DirectoryDiskBudgetError):
                self._reclamation_pending = True
            self._scan_error = (
                str(error)
                if capacity_busy
                else "Directory source root is unavailable. Restore source access and retry verification."
                if not self._source_available.is_set()
                else str(error)
                if isinstance(error, DirectoryDiskBudgetError)
                else "Directory read has stalled. Existing results remain available; scan capacity stays reserved until the worker exits."
                if isinstance(error, TimeoutError)
                else "Directory verification failed. Check source access; existing results remain available."
            )
            self._state = CacheState.READY if self._directory_count else CacheState.EMPTY
            self._schedule_retry()
            logger.warning("Directory verification failed (%s).", type(error).__name__)

    async def _periodic_rescan_loop(self) -> None:
        verified_at = time.monotonic()
        while not self._stop_event.is_set():
            try:
                await asyncio.sleep(OBSERVATION_POLL_SECONDS)
                if time.monotonic() < self._resource_retry_at:
                    continue
                if not self._opened.is_set():
                    await self.start_scan()
                    return
                if self._opened.is_set():
                    if self.index.needs_fts_repair or not self._source_available.is_set():
                        await self._run_rescan()
                        verified_at = time.monotonic()
                        continue
                    await self._blocking(self.coordinator.apply_pending)
                    await self._run_reconciliation()
                    response = await self._blocking(self.index.status)
                    self._directory_count = response.directory_count
                    if self._cleanup_pending:
                        await self._blocking(self._cleanup_retired_work)
                    if self._reclamation_pending:
                        await self._blocking(self._reclaim_disk_work)
                    if not self._scan_running.is_set():
                        await self._blocking(self._checkpoint_work)
                if self._verification_due(verified_at):
                    await self._run_rescan()
                    verified_at = time.monotonic()
            except asyncio.CancelledError:
                return
            except Exception as error:
                self.coordinator.invalidate()
                if isinstance(error, DirectoryDiskBudgetError):
                    self._reclamation_pending = True
                self._scan_error = (
                    str(error)
                    if isinstance(error, DirectoryDiskBudgetError)
                    else "Directory updates failed. Check source access and private local storage, then retry."
                )
                self._schedule_retry()
                logger.warning("Directory updates paused (%s).", type(error).__name__)

    def _request_stop(self) -> None:
        self.coordinator.invalidate()
        super()._request_stop()

    def _finish_stop(self) -> None:
        with self._finish_lock:
            if self._storage_released:
                return
            with self._workers:
                while self._active_workers:
                    self._workers.wait()
            self._cleanup_watcher()
            if self._watcher_thread is not None and self._watcher_thread.is_alive():
                self._watcher_thread.join()
            try:
                self._source_root.close()
            except Exception as error:
                logger.warning("Directory root handle cleanup failed (%s).", type(error).__name__)
            try:
                if self._opened.is_set():
                    self.index.touch_access(self._last_access_at_ms)
            except Exception:
                logger.warning("Directory last-access time could not be saved. Closed cache data can be rebuilt after cleanup.")
            self.index.close()
            self.resources.release_source(self._persist_path)
            self._storage_released = True
            self._opened.clear()
            self._state = CacheState.EMPTY


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
    def __init__(self, cache_factory: type[ConnectionDirectoryCache] = SQLiteConnectionDirectoryCache) -> None:
        self._caches: dict[str, ConnectionDirectoryCache] = {}
        self._lock = threading.Lock()
        self._cache_factory = cache_factory
        self._query_slots = threading.BoundedSemaphore(QUERY_WORKERS)
        self._scan_slots = threading.BoundedSemaphore(1)
        namespace = ConnectionDirectoryCache._resolve_cache_root() / SQLITE_CACHE_SUBDIR
        self.resources = DirectoryIndexResources(namespace)
        self._idle_task: asyncio.Task[None] | None = None
        self._retiring_caches: set[SQLiteConnectionDirectoryCache] = set()

    async def release_idle_caches(self) -> None:
        with self._lock:
            expired = [
                cache for cache in self._caches.values() if isinstance(cache, SQLiteConnectionDirectoryCache) and cache.can_release_idle()
            ]
            for cache in expired:
                self._caches.pop(cache.connection_id)
                self._retiring_caches.add(cache)
                cache._request_stop()
        if expired:
            closing = asyncio.gather(*(self._finish_idle_cache(cache) for cache in expired))
            closing.add_done_callback(lambda completed: completed.exception() if not completed.cancelled() else None)
            await asyncio.shield(closing)

    async def _finish_idle_cache(self, cache: SQLiteConnectionDirectoryCache) -> None:
        await asyncio.to_thread(cache._finish_stop)
        with self._lock:
            self._retiring_caches.discard(cache)

    async def _idle_release_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(OBSERVATION_POLL_SECONDS)
                await self.release_idle_caches()
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("Directory idle release failed. Existing sources remain protected; retrying background cleanup.")

    def apply_policy(self, policy: DirectoryIndexPolicy) -> None:
        self.resources.apply_policy(policy)
        with self._lock:
            caches = list(self._caches.values())
        for cache in caches:
            if isinstance(cache, SQLiteConnectionDirectoryCache):
                cache.apply_policy(policy)

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

        If the cache doesn't exist, create it and start shared background
        initialization. Only validated SQLite catalogues can supply results.

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
                if isinstance(previous, SQLiteConnectionDirectoryCache):
                    previous.touch()
                return previous

            cache = self._cache_factory(
                connection_id=connection_id,
                host=host,
                share_name=share_name,
                username=username,
                password=password,
                port=port,
                path_prefix=path_prefix,
                source_revision=source_revision,
            )
            if isinstance(cache, SQLiteConnectionDirectoryCache):
                cache._manager_query_slots = self._query_slots
                cache._manager_scan_slots = self._scan_slots
                cache.resources = self.resources
                self.resources.register_source(cache._persist_path)
                cache.index.growth_guard = self.resources.reserve_growth
                if self._idle_task is None or self._idle_task.done():
                    self._idle_task = asyncio.create_task(self._idle_release_loop())
            self._caches[connection_id] = cache

        if previous is not None:
            previous._request_stop()
            if isinstance(previous, SQLiteConnectionDirectoryCache):
                with self._lock:
                    self._retiring_caches.add(previous)
                closing = asyncio.create_task(self._finish_idle_cache(previous))
                closing.add_done_callback(lambda completed: completed.exception() if not completed.cancelled() else None)
            else:
                await asyncio.to_thread(previous._finish_stop)

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
            caches = list(self._caches.values()) + list(self._retiring_caches)
            self._caches.clear()
            if self._idle_task is not None:
                self._idle_task.cancel()

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
            caches = list(self._caches.values()) + list(self._retiring_caches)
            self._caches.clear()
            if self._idle_task is not None:
                self._idle_task.cancel()

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
            elif isinstance(cache, SQLiteConnectionDirectoryCache):
                with self._lock:
                    self._retiring_caches.discard(cache)

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
