"""SQLite directory catalogues with shared SMB observation and verification workers."""

import asyncio
import errno
import hashlib
import json
import logging
import threading
import time
from abc import ABC, abstractmethod
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
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
from smbprotocol.exceptions import NotifyEnumDir, SMBException, SMBOSError, SMBResponseException
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
from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT, ScanProgress
from app.models.system_settings import DirectoryIndexPolicy
from app.services.directory_index import (
    ITEM_ISSUE_CODES,
    MAX_SIGNED_INTEGER,
    QUERY_WORKERS,
    ROW_BATCH_SIZE,
    SCAN_BOOKKEEPING_COMMIT_INTERVAL_SECONDS,
    SCAN_BOOKKEEPING_COMMIT_MAX_PARENTS,
    SCAN_COMMIT_INTERVAL_SECONDS,
    SCAN_COMMIT_MAX_PARENTS,
    SQL_BUSY_TIMEOUT_MS,
    DirectoryIndex,
    DirectoryIndexSearch,
    validate_directory_path,
)
from app.services.directory_index_resources import DirectoryDiskBudgetError, DirectoryIndexResources
from app.services.directory_traversal import (
    SCAN_CREDIT_RESERVE,
    SCAN_PIPELINE_DEPTH,
    DirectoryBindingChangedError,
    DirectoryPipelineTimeout,
    DirectoryPipelineTransportError,
    DirectoryTraversalError,
    SmbCompoundDirectoryReader,
    SmbDirectoryRead,
    SmbDirectoryRoot,
)
from app.services.system_settings import get_directory_index_policy, get_smbclient_policy_kwargs
from app.storage.smb_pool import SMBConnectionPool, get_connection_pool, get_smb_connection_cache
from app.utils.worker_wait import wait_for_worker

logger = logging.getLogger(__name__)


# ============================================================================
# Constants
# ============================================================================


# Cache states
class CacheState(str, Enum):
    """State of a connection's directory cache."""

    EMPTY = "empty"  # No scan started yet
    OPENING = "opening"
    BUILDING = "building"  # Initial scan in progress
    READY = "ready"  # Scan complete, cache is usable
    UPDATING = "updating"  # Rescan in progress, stale data served


class InvalidationReason(str, Enum):
    """Cause of an epoch change and loss of trustworthy observation."""

    WATCHER_START = "watcher_start"
    OBSERVATION_LOSS = "observation_loss"
    SOURCE_REBIND = "source_rebind"
    READ_CAPACITY = "read_capacity"
    STALLED_READ = "stalled_read"
    LIFECYCLE = "lifecycle"

    @property
    def loses_observations(self) -> bool:
        """A stalled read loses no watcher events, so it does not make coverage uncertain."""
        return self is not InvalidationReason.STALLED_READ


# Scan configuration
SCAN_TIMEOUT_SECONDS = 30.0  # Timeout for single scandir call

# CHANGE_NOTIFY configuration
CHANGE_NOTIFY_BUFFER_SIZE = 65536  # 64 KB — protocol maximum

# Reconnect configuration
MAX_WATCHER_RETRIES = 5
WATCHER_RETRY_BASE_DELAY = 2.0  # seconds
WATCHER_RETRY_MAX_DELAY = 120.0  # seconds
WATCHER_STARTUP_TIMEOUT_SECONDS = 10.0

# Search configuration
MAX_SEARCH_RESULTS = 200
PATH_SEPARATOR = "/"

# Persistence configuration
CACHE_PERSIST_SUBDIR = "directory_cache"  # Default subdirectory under data_dir
MAX_PENDING_OBSERVATIONS = DIRECTORY_INDEX_CONTRACT.limits["max_pending_observations"]
MAX_OBSERVATION_BYTES = DIRECTORY_INDEX_CONTRACT.limits["max_observation_bytes"]
MAX_LOGGED_SCAN_ISSUES_PER_PASS = DIRECTORY_INDEX_CONTRACT.limits["max_logged_scan_issues_per_pass"]
SOURCE_RESOURCE_ERRNOS = frozenset(
    {
        errno.EMFILE,
        errno.ENFILE,
        errno.ENOMEM,
        errno.ENOSPC,
        errno.ENETDOWN,
        errno.ENETUNREACH,
        errno.EHOSTUNREACH,
        errno.ECONNRESET,
        errno.ECONNABORTED,
        errno.ENOTCONN,
        errno.ETIMEDOUT,
        errno.EPIPE,
    }
)
SOURCE_TRANSPORT_STATUSES = frozenset(
    getattr(NtStatus, name)
    for name in (
        "STATUS_NETWORK_NAME_DELETED",
        "STATUS_USER_SESSION_DELETED",
        "STATUS_LOGON_FAILURE",
        "STATUS_ACCOUNT_DISABLED",
        "STATUS_ACCOUNT_RESTRICTION",
        "STATUS_PASSWORD_EXPIRED",
        "STATUS_LOGON_TYPE_NOT_GRANTED",
        "STATUS_WRONG_PASSWORD",
        "STATUS_NETWORK_SESSION_EXPIRED",
        "STATUS_IO_TIMEOUT",
        "STATUS_CONNECTION_DISCONNECTED",
        "STATUS_INSUFFICIENT_RESOURCES",
        "STATUS_NO_MEMORY",
        "STATUS_DISK_FULL",
    )
    if hasattr(NtStatus, name)
)
SCAN_SEEN_CHILD_BYTES = MAX_OBSERVATION_BYTES
SQLITE_CACHE_SUBDIR = "sqlite"
SQLITE_CACHE_EXTENSION = ".sqlite3"
DEGRADED_VERIFICATION_SECONDS = DIRECTORY_INDEX_CONTRACT.policy["degraded_verification_seconds"].default
HEALTHY_VERIFICATION_SECONDS = DIRECTORY_INDEX_CONTRACT.policy["healthy_verification_seconds"].default
OBSERVATION_POLL_SECONDS = DIRECTORY_INDEX_CONTRACT.limits["event_coalescing_ms"] / 1000
OBSERVATION_RETRY_SECONDS = 1.0
CONTINUOUS_CHANGE_STALE_TURNS = 3
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


@dataclass(frozen=True)
class ScanReadToken:
    epoch: int
    sequence: int
    path: str
    producer_id: int
    availability_only: bool = False
    observed: bool = False


class ScanObservationInvalidated(RuntimeError):
    """A filesystem observation can no longer be safely committed."""


@dataclass
class _PendingScanParent:
    token: ScanReadToken
    generation: int
    children: list[tuple[str, bool]]
    complete: bool = False
    preserve_children: bool = False
    file_ids: dict[str, bytes] = field(default_factory=dict)


@dataclass
class _PendingSourceRead:
    token: ScanReadToken
    reader: SmbCompoundDirectoryReader | None = None
    error: Exception | None = None


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
        self.last_reason: InvalidationReason | None = None
        self.invalidation_count = 0
        self.observation_lost = False
        self.observed_reads_blocked = False
        self.observed_ready: Callable[[], bool] = lambda: False
        self._scan_group: dict[int, _PendingScanParent] | None = None
        self._scan_group_reconcile = False
        self._scan_group_bytes = 0
        self._scan_group_started: float | None = None
        self._scan_group_has_changes = False
        self._streamed_parent_reads: set[int] = set()
        self._completed_scan_reads: set[int] = set()
        self._pending_scan_issues: dict[int, dict[str, int]] = {}
        self._pending_issue_paths: dict[int, dict[str, str]] = {}
        self.issue_paths: dict[tuple[str, str], str] = {}
        self.issue_details: set[tuple[str, str]] = set()
        self.issue_details_incomplete = False
        self.scan_commits = 0
        self.on_scan_commit: Callable[[int], None] | None = None

    def _publish_issue_details(self, parent: str, counts: dict[str, int], paths: dict[str, str] | None = None) -> None:
        """Publish diagnostics only after the owning parent transaction succeeds."""
        self.issue_details = {detail for detail in self.issue_details if detail[0] != parent}
        self.issue_paths = {detail: path for detail, path in self.issue_paths.items() if detail in self.issue_details}
        for code in counts:
            if len(self.issue_details) < MAX_LOGGED_SCAN_ISSUES_PER_PASS:
                self.issue_details.add((parent, code))
                if paths is not None and code in paths:
                    self.issue_paths[(parent, code)] = paths[code]
            else:
                self.issue_details_incomplete = True

    def _discard_missing_issue_details(self, generation_id: int) -> None:
        """Remove samples for subtrees pruned by committed parent snapshots."""
        self.issue_details = {
            detail for detail in self.issue_details if not detail[0] or self.index.contains_directory(generation_id, detail[0])
        }
        self.issue_paths = {detail: path for detail, path in self.issue_paths.items() if detail in self.issue_details}

    def start_scan_groups(self, *, reconcile: bool = False) -> None:
        with self.lock:
            self._scan_group = {}
            self._scan_group_reconcile = reconcile
            self._scan_group_started = None
            self._scan_group_has_changes = False
            self._scan_group_bytes = 0
            self._streamed_parent_reads.clear()
            self._completed_scan_reads.clear()
            self.scan_commits = 0

    def cancel_scan_groups(self) -> None:
        with self.lock:
            pending = self._scan_group or {}
            self._scan_group = None
            for entry in pending.values():
                self.end_read(entry.token)
            self._scan_group_bytes = 0
            self._scan_group_reconcile = False
            self._scan_group_started = None
            self._scan_group_has_changes = False

    def flush_scan_group(self) -> None:
        with self.lock:
            if not self._scan_group:
                return
            self.apply_pending()
            pending = self._scan_group
            self._scan_group = {}
            self._scan_group_bytes = 0
            stale_epoch = False
            try:
                complete: dict[int, list[tuple[str, list[tuple[str, bool]]]]] = {}
                file_ids: dict[int, dict[str, bytes]] = {}
                partial_parents: dict[int, set[str]] = {}
                streamed_parents: dict[int, set[str]] = {}
                changed: set[int] = set()
                for entry in pending.values():
                    if not self.is_current(entry.token):
                        self.index.defer_scan_parent(entry.generation, entry.token.path)
                        stale_epoch |= entry.token.epoch != self.epoch
                    elif entry.complete:
                        complete.setdefault(entry.generation, []).append((entry.token.path, entry.children))
                        file_ids.setdefault(entry.generation, {}).update(entry.file_ids)
                        if entry.token.producer_id in self._streamed_parent_reads:
                            streamed_parents.setdefault(entry.generation, set()).add(entry.token.path)
                        if entry.preserve_children:
                            partial_parents.setdefault(entry.generation, set()).add(entry.token.path)
                        changed.add(entry.generation)
                    else:
                        reset = entry.token.producer_id not in self._streamed_parent_reads
                        for offset in range(0, len(entry.children), ROW_BATCH_SIZE):
                            batch = entry.children[offset : offset + ROW_BATCH_SIZE]
                            self.index.write_scan_parent_batch(
                                entry.generation,
                                entry.token.path,
                                batch,
                                reset_snapshot=reset and offset == 0,
                                file_ids=entry.file_ids,
                                **({"reconcile": True} if self._scan_group_reconcile else {}),
                            )
                            self._streamed_parent_reads.add(entry.token.producer_id)
                            changed.add(entry.generation)
                for generation, results in complete.items():
                    options: dict[str, Any] = {}
                    if self._scan_group_reconcile:
                        options["reconcile"] = True
                    issues = {
                        entry.token.path: self._pending_scan_issues[entry.token.producer_id]
                        for entry in pending.values()
                        if entry.complete
                        and entry.generation == generation
                        and self.is_current(entry.token)
                        and entry.token.producer_id in self._pending_scan_issues
                    }
                    if issues:
                        options["issues"] = issues
                    if partial_parents.get(generation):
                        options["partial_parents"] = partial_parents[generation]
                    if streamed_parents.get(generation):
                        options["streamed_parents"] = streamed_parents[generation]
                    if file_ids[generation]:
                        options["file_ids"] = file_ids[generation]
                    issue_paths = {
                        entry.token.path: self._pending_issue_paths.get(entry.token.producer_id)
                        for entry in pending.values()
                        if entry.generation == generation
                    }
                    self.index.commit_scan_parents(generation, results, **options)
                    for parent, _children in results:
                        self._publish_issue_details(parent, issues.get(parent, {}), issue_paths.get(parent))
                    self._discard_missing_issue_details(generation)
                    self.scan_commits += 1
                if self.on_scan_commit is not None:
                    for generation in changed:
                        self.on_scan_commit(generation)
            finally:
                for entry in pending.values():
                    if entry.complete:
                        self.end_read(entry.token)
                self._scan_group_started = None
                self._scan_group_has_changes = False
            if stale_epoch:
                raise ScanObservationInvalidated("Directory scan observations became stale. Retry the affected parents.")

    def flush_scan_group_if_due(self) -> None:
        with self.lock:
            cap = SCAN_COMMIT_MAX_PARENTS if self._scan_group_has_changes else SCAN_BOOKKEEPING_COMMIT_MAX_PARENTS
            interval = SCAN_COMMIT_INTERVAL_SECONDS if self._scan_group_has_changes else SCAN_BOOKKEEPING_COMMIT_INTERVAL_SECONDS
            if self._scan_group and (
                len(self._completed_scan_reads) >= cap
                or self._scan_group_bytes >= MAX_OBSERVATION_BYTES
                or (self._scan_group_started is not None and time.monotonic() - self._scan_group_started >= interval)
            ):
                self.flush_scan_group()

    def buffered_scan_parents(self, generation: int) -> list[str]:
        with self.lock:
            return [entry.token.path for entry in (self._scan_group or {}).values() if entry.generation == generation and entry.complete]

    def has_complete_scan_snapshot(self, token: ScanReadToken) -> bool:
        with self.lock:
            return self._scan_group is not None

    def has_buffered_ancestor(self, generation: int, parents: list[str]) -> bool:
        ancestors = {""}
        for parent in parents:
            while parent:
                parent = parent.rpartition(PATH_SEPARATOR)[0]
                ancestors.add(parent)
        with self.lock:
            return any(
                entry.complete and entry.generation == generation and entry.token.path in ancestors
                for entry in (self._scan_group or {}).values()
            )

    def _stage_scan_parent(self, token: ScanReadToken, generation: int, *, has_changes: bool, size: int = 0) -> _PendingScanParent:
        group = self._scan_group
        if group is None:
            raise RuntimeError("Scan grouping is not active. Start scan groups before buffering a parent.")
        entry = group.get(token.producer_id)
        parent_bytes = len(token.path.encode("utf-8")) + self._scan_issue_bytes(token) if entry is None else 0
        promote = has_changes and not self._scan_group_has_changes and len(group) >= SCAN_COMMIT_MAX_PARENTS
        carried = None
        if promote and entry is not None:
            carried = group.pop(token.producer_id)
            self._scan_group_bytes -= len(token.path.encode("utf-8")) + sum(len(path.encode("utf-8")) for path, _ in carried.children)
            self._scan_group_bytes -= sum(len(value) for value in carried.file_ids.values())
            self._scan_group_bytes -= self._scan_issue_bytes(token)
        if self._scan_group_bytes + size + parent_bytes > MAX_OBSERVATION_BYTES or promote:
            self.flush_scan_group()
            group = self._scan_group
            assert group is not None
            entry = group.get(token.producer_id)
            parent_bytes = len(token.path.encode("utf-8")) + self._scan_issue_bytes(token) if entry is None else 0
        if not group and self._scan_group_started is None:
            self._scan_group_started = time.monotonic()
        if entry is None:
            entry = carried or _PendingScanParent(token, generation, [])
            group[token.producer_id] = entry
            if carried is not None:
                self._scan_group_bytes += sum(len(path.encode("utf-8")) for path, _ in carried.children) + sum(
                    len(value) for value in carried.file_ids.values()
                )
        self._scan_group_bytes += parent_bytes + size
        self._scan_group_has_changes |= has_changes
        return entry

    def _scan_issue_bytes(self, token: ScanReadToken) -> int:
        return sum(
            len(code.encode("utf-8")) + len(str(count)) for code, count in self._pending_scan_issues.get(token.producer_id, {}).items()
        ) + sum(len(path.encode("utf-8")) for path in self._pending_issue_paths.get(token.producer_id, {}).values())

    def invalidate(self, reason: InvalidationReason) -> None:
        with self.lock:
            self.invalidation_count += 1
            logger.info(
                "Directory scan invalidated.",
                extra={
                    "event": "directory_scan_invalidated",
                    "invalidation_reason": reason.value,
                    "invalidation_count": self.invalidation_count,
                },
            )
            self.last_reason = reason
            self.observed_reads_blocked = reason in (InvalidationReason.OBSERVATION_LOSS, InvalidationReason.READ_CAPACITY)
            if reason in (InvalidationReason.OBSERVATION_LOSS, InvalidationReason.READ_CAPACITY):
                self.observation_lost = True
            self.epoch += 1
            self.barriers.clear()
            self.barrier_bytes = 0
            self.verification_required = True
            self._uncertain_pending |= reason.loses_observations

    def enqueue(self, mutation: _DirectoryMutation) -> bool:
        if mutation.path or mutation.action != READ_PARENT_ACTION:
            validate_directory_path(mutation.path)
        if mutation.new_path is not None:
            validate_directory_path(mutation.new_path)
        paths = (mutation.path,) if mutation.new_path is None else (mutation.path, mutation.new_path)
        size = sum(len(path.encode("utf-8")) for path in paths)
        with self.lock:
            if self.sequence >= MAX_SIGNED_INTEGER:
                self.invalidate(InvalidationReason.OBSERVATION_LOSS)
                raise OverflowError("Directory observation sequence is exhausted. Reinitialize this source.")
            self.sequence += 1
            if len(self.pending) >= self.maximum_pending or self.pending_bytes + size > self.maximum_bytes:
                self.invalidate(InvalidationReason.OBSERVATION_LOSS)
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
            self.barriers = deque([(self.sequence, "", 0)])
            self.barrier_bytes = 0
            return
        retained.append((self.sequence, prefix, size))
        self.barriers = retained
        self.barrier_bytes = total_bytes

    def capture_epoch(self) -> int:
        """Capture full-pass identity without retaining content barriers."""
        with self.lock:
            return self.epoch

    def begin_read(self, path: str, *, availability_only: bool = False, observed: bool = False) -> ScanReadToken:
        if path:
            validate_directory_path(path)
        with self.lock:
            if (
                len(self._producers) - len(self._completed_scan_reads) >= MAX_PENDING_OBSERVATIONS
                or self._next_producer_id >= MAX_SIGNED_INTEGER
            ):
                self.invalidate(InvalidationReason.READ_CAPACITY)
                raise ScanObservationInvalidated("Directory read capacity is exhausted. Wait for active source reads to finish.")
            self._next_producer_id += 1
            if self._scan_group is not None and not self._scan_group and self._scan_group_started is None and not availability_only:
                self._scan_group_started = time.monotonic()
            token = ScanReadToken(self.epoch, self.sequence, path, self._next_producer_id, availability_only, observed)
            self._producers[token.producer_id] = token
            return token

    def end_read(self, token: ScanReadToken) -> None:
        """Release a producer only after its reads and synchronous batches have exited."""
        with self.lock:
            if self._scan_group is not None:
                entry = self._scan_group.get(token.producer_id)
                if entry is not None:
                    if entry.complete:
                        return
                    del self._scan_group[token.producer_id]
                    self._scan_group_bytes -= sum(len(path.encode("utf-8")) for path, _descend in entry.children)
                    self._scan_group_bytes -= len(entry.token.path.encode("utf-8")) + sum(len(value) for value in entry.file_ids.values())
                    self._scan_group_bytes -= self._scan_issue_bytes(token)
            if self._producers.get(token.producer_id) == token:
                self._streamed_parent_reads.discard(token.producer_id)
                self._completed_scan_reads.discard(token.producer_id)
                self._pending_scan_issues.pop(token.producer_id, None)
                self._pending_issue_paths.pop(token.producer_id, None)
                del self._producers[token.producer_id]
                self._retire_barriers()

    @contextmanager
    def read(self, path: str, *, availability_only: bool = False, observed: bool = False) -> Iterator[ScanReadToken]:
        token = self.begin_read(path, availability_only=availability_only, observed=observed)
        try:
            yield token
        finally:
            self.end_read(token)

    def _retire_barriers(self) -> None:
        """Pending mutations and older live reads retain their rejection fences."""
        if not self.barriers:
            return
        oldest = min(
            (token.sequence for token in self._producers.values() if token.epoch == self.epoch),
            default=self.sequence,
        )
        if self.pending:
            oldest = min(oldest, self.pending[0][0] - 1)
        self.barriers = deque(entry for entry in self.barriers if entry[0] > oldest)
        self.barrier_bytes = sum(entry[2] for entry in self.barriers)

    def is_epoch_current(self, token: ScanReadToken) -> bool:
        with self.lock:
            return self._producers.get(token.producer_id) == token and token.epoch == self.epoch

    def is_current(self, token: ScanReadToken) -> bool:
        with self.lock:
            if token.observed and (self.observed_reads_blocked or not self.observed_ready()):
                return False
            return self.is_epoch_current(token) and not any(
                sequence > token.sequence
                and (
                    not path
                    or path == token.path
                    or path.rpartition(PATH_SEPARATOR)[0] == token.path
                    or token.path.startswith(path + PATH_SEPARATOR)
                )
                for sequence, path, _size in self.barriers
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
                    prefix = mutation.path + "/"
                    self.issue_details = {
                        detail for detail in self.issue_details if detail[0] != mutation.path and not detail[0].startswith(prefix)
                    }
                elif mutation.action == FileAction.FILE_ACTION_RENAMED_NEW_NAME:
                    self.index.mutate_observed_path("rename", mutation.path, mutation.new_path)
                else:
                    self.invalidate(InvalidationReason.OBSERVATION_LOSS)
                    raise ValueError("Directory observation action is unsupported. Request source verification.")
                self.pending.popleft()
                self.pending_bytes -= size
                applied += 1
            self._retire_barriers()
            return applied

    def commit_children(
        self,
        token: ScanReadToken,
        generation_id: int,
        children: Iterable[tuple[str, bool]],
        *,
        reconcile: bool = False,
        file_ids: dict[str, bytes] | None = None,
    ) -> None:
        with self.lock:
            if not self.is_current(token):
                self.verification_required = True
                raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
            self.apply_pending()
            if reconcile and not self._scan_group_reconcile:
                self.index.write_scan_parent_batch(
                    generation_id,
                    token.path,
                    children,
                    reset_snapshot=token.producer_id not in self._streamed_parent_reads,
                    file_ids=file_ids,
                    reconcile=True,
                )
                self._streamed_parent_reads.add(token.producer_id)
            elif self._scan_group is not None:
                batch = list(children)
                size = sum(len(path.encode("utf-8")) for path, _descend in batch)
                size += sum(len(value) for value in (file_ids or {}).values())
                has_changes = self.index.scan_parents_have_changes(generation_id, [(token.path, batch)], partial_parents={token.path})
                entry = self._stage_scan_parent(token, generation_id, has_changes=has_changes, size=size)
                entry.children.extend(batch)
                entry.file_ids.update(file_ids or {})
                self.flush_scan_group_if_due()
            else:
                if file_ids:
                    self.index.write_scan_children(generation_id, children, file_ids=file_ids)
                else:
                    self.index.write_scan_children(generation_id, children)

    def record_unsafe_traversal(self, token: ScanReadToken, generation_id: int) -> None:
        self._record_scan_issue(token, generation_id, self.index.record_unsafe_traversal)

    def record_access_denied(self, token: ScanReadToken, generation_id: int) -> None:
        self._record_scan_issue(token, generation_id, self.index.record_access_denied)

    def record_issue(
        self, token: ScanReadToken, generation_id: int, code: str, *, reconcile: bool = False, path: str | None = None
    ) -> None:
        if code not in ITEM_ISSUE_CODES:
            raise ValueError("Unsupported directory coverage issue. Use a contract issue code.")
        if path is not None and len(path.encode("utf-8")) > MAX_OBSERVATION_BYTES:
            path = None
        with self.lock:
            if not self.is_current(token):
                self.verification_required = True
                raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
            self.apply_pending()
            if self._scan_group is not None or reconcile:
                counts = self._pending_scan_issues.get(token.producer_id, {})
                previous = counts.get(code, 0)
                if previous >= MAX_SIGNED_INTEGER:
                    raise OverflowError("Directory coverage issue count is exhausted. Restart source verification.")
                if self._scan_group is not None:
                    size = len(str(previous + 1)) - len(str(previous)) if previous else len(code.encode("utf-8")) + 1
                    if path is not None and code not in self._pending_issue_paths.get(token.producer_id, {}):
                        size += len(path.encode("utf-8"))
                    self._stage_scan_parent(token, generation_id, has_changes=False, size=size)
                self._pending_scan_issues.setdefault(token.producer_id, {})[code] = previous + 1
                if path is not None:
                    self._pending_issue_paths.setdefault(token.producer_id, {}).setdefault(code, path)
                if self._scan_group is not None:
                    self.flush_scan_group_if_due()
            else:
                self.index.record_issue(generation_id, code, reconcile=reconcile)
                counts = {previous_code: 1 for parent, previous_code in self.issue_details if parent == token.path}
                counts[code] = 1
                paths = {previous_code: value for (parent, previous_code), value in self.issue_paths.items() if parent == token.path}
                if path is not None:
                    paths.setdefault(code, path)
                self._publish_issue_details(token.path, counts, paths)

    def _record_scan_issue(self, token: ScanReadToken, generation_id: int, record: Callable[[int], None]) -> None:
        with self.lock:
            if not self.is_current(token):
                self.verification_required = True
                raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
            self.apply_pending()
            record(generation_id)

    def finish_parent(self, token: ScanReadToken, generation_id: int, *, reconcile: bool = False, skip_children: bool = False) -> None:
        with self.lock:
            if not self.is_current(token):
                self.verification_required = True
                raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
            self.apply_pending()
            if skip_children:
                entry = self._scan_group.get(token.producer_id) if self._scan_group is not None else None
                if entry is not None:
                    self._scan_group_bytes -= sum(len(path.encode("utf-8")) for path, _descend in entry.children)
                    self._scan_group_bytes -= sum(len(value) for value in entry.file_ids.values())
                    entry.children.clear()
                    entry.file_ids.clear()
            if reconcile and not self._scan_group_reconcile:
                self.index.commit_scan_parents(
                    generation_id,
                    [(token.path, [])],
                    streamed_parents={token.path} if token.producer_id in self._streamed_parent_reads else None,
                    partial_parents={token.path} if skip_children else None,
                    reconcile=True,
                    issues={token.path: self._pending_scan_issues[token.producer_id]}
                    if token.producer_id in self._pending_scan_issues
                    else None,
                )
                self._publish_issue_details(
                    token.path, self._pending_scan_issues.get(token.producer_id, {}), self._pending_issue_paths.get(token.producer_id)
                )
                self._discard_missing_issue_details(generation_id)
            elif self._scan_group is not None:
                existing = self._scan_group.get(token.producer_id)
                snapshot_children = existing.children if existing is not None else []
                partial = {token.path} if skip_children else None
                streamed = {token.path} if token.producer_id in self._streamed_parent_reads else None
                has_changes = self.index.scan_parents_have_changes(
                    generation_id, [(token.path, snapshot_children)], partial_parents=partial, streamed_parents=streamed
                )
                entry = self._stage_scan_parent(token, generation_id, has_changes=has_changes)
                entry.complete = True
                entry.preserve_children = skip_children
                self._completed_scan_reads.add(token.producer_id)
                self.flush_scan_group_if_due()
            else:
                self.index.finish_scan_parent(generation_id, token.path)

    def accept_generation(self, epoch: int, generation_id: int, *, issue_count: int = 0) -> bool:
        with self.lock:
            if epoch != self.epoch or self._uncertain_pending or self.pending or self._producers:
                self.verification_required = True
                raise ScanObservationInvalidated("Directory scan capture is not current. Drain source observations and retry verification.")
            if self.index.reconciliation_generation() is not None or self.index.pending_scan_paths(generation_id, limit=1):
                self.verification_required = True
                raise ScanObservationInvalidated(
                    "Directory parent work remains pending. Complete reconciliation before source verification."
                )
            accepted = self.index.finish_generation(generation_id, issue_count=issue_count)
            self.verification_required = not accepted
            # The finished pass re-read the gap; coverage issues are reported separately.
            self.observation_lost = False
            if accepted:
                self._uncertain_pending = False
                self.last_reason = None
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
        self._source_revision = source_revision
        self._connection_cache = get_smb_connection_cache(connection_id)
        self._diagnostic_generation = uuid4().hex
        self._log_context = {
            "source_id": hashlib.sha256(connection_id.encode()).hexdigest()[:16],
            "generation_id": self._diagnostic_generation,
            "operation": "directory_index",
        }

        # Normalize path_prefix: strip slashes so "" means share root
        cleaned = (path_prefix or "/").replace("\\", "/").strip("/")
        self._path_prefix = cleaned  # e.g. "photos" or ""
        self._source_identity: dict[str, str | int] = {
            "source_kind": "smb",
            "host": host,
            "share_name": share_name,
            "port": port,
            "path_prefix": cleaned,
            "username": username,
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
        self._watcher_ready = threading.Event()
        self._watcher_retry_at = 0.0
        self._watcher_startup_lock = threading.Lock()
        self._watcher_startup_result: bool | None = None
        self._watcher_startup_waiters: set[asyncio.Future[bool]] = set()

        self._cache_root = self._resolve_cache_root()

    @property
    def state(self) -> CacheState:
        """Current cache state."""

        return self._state

    @property
    def _logger(self) -> logging.LoggerAdapter[logging.Logger]:
        return logging.LoggerAdapter(logger, self._log_context, merge_extra=True)

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
        """Highest-priority active condition, if any."""

        return None

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
    def _observation_started(self) -> None:
        """Invalidate reads made before notification setup completed."""
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
    def _publish_watcher_startup(self, ready: bool) -> None:
        """Publish the first notification attempt without changing current readiness."""
        with self._watcher_startup_lock:
            if self._watcher_startup_result is not None:
                return
            self._watcher_startup_result = ready
            waiters = tuple(self._watcher_startup_waiters)
        for waiter in waiters:

            def deliver(target: asyncio.Future[bool] = waiter) -> None:
                if not target.done():
                    target.set_result(ready)

            try:
                waiter.get_loop().call_soon_threadsafe(deliver)
            except RuntimeError:
                logger.debug("Directory startup waiter event loop is closed.")

    async def _wait_for_watcher_startup(self) -> bool | None:
        """Wait without a blocking worker; timeout permits fallback verification."""
        waiter = asyncio.get_running_loop().create_future()
        with self._watcher_startup_lock:
            if self._watcher_startup_result is not None:
                return self._watcher_startup_result
            self._watcher_startup_waiters.add(waiter)
        try:
            return await asyncio.wait_for(waiter, WATCHER_STARTUP_TIMEOUT_SECONDS)
        except TimeoutError:
            with self._watcher_startup_lock:
                return self._watcher_startup_result
        finally:
            with self._watcher_startup_lock:
                self._watcher_startup_waiters.discard(waiter)

    def _start_watcher(self) -> None:
        """Start the CHANGE_NOTIFY watcher thread for live directory updates."""

        if self._watcher_thread is not None and self._watcher_thread.is_alive():
            return

        self._watcher_thread = threading.Thread(
            target=self._watcher_loop,
            daemon=True,
            name="directory-cache-watcher",
        )
        self._watcher_thread.start()
        logger.info("Directory watcher started.", extra={"event": "directory_watcher_started"})

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

            except Exception as error:
                if self._stop_event.is_set():
                    break

                if self._watcher_ready.is_set():
                    self._observation_lost()
                retry_count = 1 if self._watcher_received_events else retry_count + 1
                self._watcher_ready.clear()
                if retry_count == MAX_WATCHER_RETRIES + 1:
                    self._logger.error(
                        "Directory watcher exhausted %s fast retries. Capped background retries remain active.",
                        MAX_WATCHER_RETRIES,
                        extra={"event": "directory_watcher_retry_exhausted"},
                    )

                delay = min(
                    WATCHER_RETRY_BASE_DELAY * (2 ** min(retry_count - 1, MAX_WATCHER_RETRIES)),
                    WATCHER_RETRY_MAX_DELAY,
                )
                jitter = hashlib.sha256(self.connection_id.encode("utf-8")).digest()[0]
                delay = min(WATCHER_RETRY_MAX_DELAY, delay * (90 + jitter % 21) / 100)
                self._watcher_retry_at = time.monotonic() + delay
                self._publish_watcher_startup(False)
                if retry_count <= MAX_WATCHER_RETRIES:
                    self._logger.warning(
                        "Directory watcher failed (%s); retrying in %.1f seconds.",
                        type(error).__name__,
                        delay,
                        extra={
                            "event": "directory_watcher_retry",
                            "stage": "watcher",
                            "error_type": type(error).__name__,
                            "retry_seconds": delay,
                        },
                        exc_info=retry_count == 1,
                    )

                self._cleanup_watcher()

                if self._stop_event.wait(delay):
                    break  # Stop event was set during wait

        self._watcher_ready.clear()
        self._watcher_retry_at = 0.0
        self._cleanup_watcher()
        logger.info("Directory watcher stopped.", extra={"event": "directory_watcher_stopped"})

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

        logger.debug("Directory watcher connected.", extra={"event": "directory_watcher_connected"})

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
            if self._stop_event.is_set():
                break
            if not self._watcher_ready.is_set():
                self._observation_started()
                self._watcher_ready.set()
                self._watcher_retry_at = 0.0
                self._publish_watcher_startup(True)

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
            except Exception as error:
                logger.debug("Directory watcher handle cleanup failed (%s).", type(error).__name__)
            finally:
                self._watcher_open = None

        if self._watcher_tree:
            try:
                self._watcher_tree.disconnect()
            except Exception as error:
                logger.debug("Directory watcher tree cleanup failed (%s).", type(error).__name__)
            finally:
                self._watcher_tree = None

        if self._watcher_session:
            try:
                self._watcher_session.disconnect()
            except Exception as error:
                logger.debug("Directory watcher session cleanup failed (%s).", type(error).__name__)
            finally:
                self._watcher_session = None

        if self._watcher_connection:
            try:
                self._watcher_connection.disconnect()
            except RuntimeError as error:
                # smbprotocol bug: disconnect() tries to join the current
                # thread when called from the message-worker after a timeout.
                logger.debug("Directory watcher connection cleanup failed (%s).", type(error).__name__)
            except Exception as error:
                logger.debug("Directory watcher connection cleanup failed (%s).", type(error).__name__)
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

        logger.info("Stopping directory cache.", extra={"event": "directory_source_stopping"})
        self._request_stop()
        self._finish_stop()

    def _request_stop(self) -> None:
        """Signal running tasks to stop from their owning event loop."""

        self._stop_event.set()
        self._publish_watcher_startup(False)

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

    @property
    def scan_error(self) -> str | None:
        if self._source_probe_completed.is_set() and not self._source_available.is_set():
            return "Directory source root is unavailable. Restore source access and retry verification."
        if self._disk_budget_error is not None:
            return self._disk_budget_error
        if self._storage_error is not None:
            return self._storage_error
        if self._stalled_read.is_set():
            return "Directory read has stalled. Existing results remain available; scan capacity stays reserved until the worker exits."
        if self._verification_error is not None:
            return self._verification_error
        if self._update_error is not None:
            return self._update_error
        if self.coordinator.observation_lost:
            return "Directory observations were lost. Background verification is required."
        if not self._watcher_ready.is_set() and (self._watcher_retry_at or self._last_scan_time is not None):
            return "Directory monitoring is unavailable. Background verification remains active."
        if self._opened.is_set() and self.index.needs_fts_repair:
            return "Directory search index is being rebuilt. Existing directory rows remain searchable."
        if self._stale_turns >= CONTINUOUS_CHANGE_STALE_TURNS:
            return "Directories keep changing. Existing results remain available; background verification will retry."
        return None

    @property
    def monitoring_state(self) -> str:
        if not self._watcher_ready.is_set():
            return "unavailable" if self._watcher_retry_at else "starting"
        return "recovering" if self.coordinator.verification_required else "healthy"

    @property
    def retry_after_ms(self) -> int | None:
        now = time.monotonic()
        scan_deadline = max(self._resource_retry_at, self._verification_retry_at or 0.0)
        deadlines = (scan_deadline, self._watcher_retry_at)
        pending = [deadline - now for deadline in deadlines if deadline is not None and deadline > now]
        return max(1, int(min(pending) * 1000)) if pending else None

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
        self._verification_retry_at: float | None = None
        self._next_full_pass_at = 0.0
        self._scan_epoch: tuple[int, int] | None = None
        self._reconcile_next = True
        self._stale_turns = 0
        self._failure_retry_delay = 0.0
        self._retry_jitter = hashlib.sha256(identity.encode("utf-8")).digest()[0]
        self._owning_loop: asyncio.AbstractEventLoop | None = None
        self._last_access = time.monotonic()
        self._last_access_at_ms = int(time.time() * 1000)
        self._reclamation_pending = False
        self._source_available = threading.Event()
        self._source_probe_completed = threading.Event()
        self._root_reading = threading.Event()
        self._source_root = SmbDirectoryRoot(self._smb_base_path)
        self._storage_error: str | None = None
        self._disk_budget_error: str | None = None
        self._verification_error: str | None = None
        self._update_error: str | None = None
        self._coverage_incomplete = False
        self._scan_issue_counts: dict[str, int] = {}
        self._stalled_read = threading.Event()
        self._watcher_ever_ready = False
        self.scan_progress: ScanProgress | None = None
        self._progress_generation: int | None = None
        self._scan_job_file_ids: dict[tuple[int, str], bytes | None] = {}

    def _publish_scan_progress(self, generation: int) -> None:
        progress = self.scan_progress
        if progress is None or generation != self._progress_generation:
            return
        done, queued, found = self.index.scan_counts(generation)
        self.scan_progress = ScanProgress(progress.phase, done, queued, found, progress.started_at_ms)
        if progress.phase == "building":
            self._directory_count = found

    def touch(self) -> None:
        with self.coordinator.lock:
            self._last_access = time.monotonic()
        self._last_access_at_ms = int(time.time() * 1000)

    def can_release_idle(self) -> bool:
        with self._workers:
            return (
                time.monotonic() - self._last_access >= DIRECTORY_INDEX_CONTRACT.limits["idle_release_seconds"]
                and not self._active_workers
                and not self._scan_running.is_set()
                and not self.index.has_active_queries
                and not self.index.has_pending_scan()
                and not self.coordinator.pending
            )

    def _maintenance_blocked(self) -> bool:
        return (
            self._stop_event.is_set()
            or bool(self.coordinator.pending)
            or self.index.has_active_queries
            or self._scan_running.is_set()
            or self.index.reconciliation_generation() is not None
        )

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
                    if not self._active_workers:
                        self._stalled_read.clear()
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
                return await wait_for_worker(future)
            self._scan_progress = time.monotonic()
            while True:
                try:
                    return await wait_for_worker(future, WORKER_POLL_SECONDS)
                except TimeoutError:
                    if future.done():
                        return future.result()
                    if time.monotonic() - self._scan_progress >= SCAN_TIMEOUT_SECONDS:
                        self.coordinator.invalidate(InvalidationReason.STALLED_READ)
                        with self._workers:
                            if self._active_workers:
                                self._stalled_read.set()
                        future.add_done_callback(report_abandoned)
                        await pool.retain_connection_until_future_complete(self._connection_cache, future)
                        raise TimeoutError("Directory read has stalled. Scan capacity stays reserved until the worker exits.") from None
        except DirectoryPipelineTimeout:
            if pool is not None:
                await pool.invalidate_connection_cache(self._connection_cache, reason="directory_pipeline_timeout", abort=True)
            raise
        except DirectoryPipelineTransportError:
            if pool is not None:
                await pool.invalidate_connection_cache(self._connection_cache, reason="directory_pipeline_send_failed", abort=True)
            raise
        except asyncio.CancelledError:
            self.coordinator.invalidate(InvalidationReason.LIFECYCLE)
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
        self._state = CacheState.OPENING
        self._scan_task = asyncio.create_task(self._initialize())

    async def _initialize(self) -> None:
        try:
            await self._blocking(self._initialize_storage)
            self._opened.set()
            self._directory_count = (await self._blocking(self.index.status)).directory_count
            self._start_watcher()
            await self._wait_for_watcher_startup()
            if self._stop_event.is_set():
                return
            await self._run_rescan()
            self._start_periodic_rescan()
        except asyncio.CancelledError:
            return
        except Exception as error:
            if isinstance(error, DirectoryDiskBudgetError):
                self._disk_budget_error = str(error)
            else:
                self._storage_error = (
                    "Directory index storage is in use. Wait for active workers to finish, then retry."
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
        self._storage_error = None
        self._disk_budget_error = None
        self.coordinator.invalidate(InvalidationReason.LIFECYCLE)
        self.coordinator.apply_pending()

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
        if not query.strip():
            if cancelled is not None and cancelled.is_set():
                raise InterruptedError("Directory search was cancelled. Retry the search.")
            return self.index.cached_status()
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
                break

    def observe_parent(self, parent: str) -> None:
        """Queue source validation without assuming that a destination is a directory."""
        self._apply_mutations([_DirectoryMutation(READ_PARENT_ACTION, parent.strip("/"))])

    def _observation_lost(self) -> None:
        self.coordinator.invalidate(InvalidationReason.OBSERVATION_LOSS)

    def _observation_started(self) -> None:
        reason = InvalidationReason.OBSERVATION_LOSS if self._watcher_ever_ready else InvalidationReason.WATCHER_START
        self.coordinator.invalidate(reason)
        self._watcher_ever_ready = True

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

    class _DescendantMissing(FileNotFoundError):
        """A source directory disappeared, not a local index file."""

    class _DescendantScanIssue(Exception):
        """An item error from a source operation, never from index storage."""

        def __init__(self, code: str) -> None:
            super().__init__("Directory item could not be read. Check the folder and retry the next verification pass.")
            self.code = code

    @staticmethod
    def _classify_source_error(error: Exception) -> str | None:
        """Keep connection and resource failures outside best-effort item handling."""
        status = error.ntstatus if isinstance(error, SMBOSError) else error.status if isinstance(error, SMBResponseException) else None
        if (
            isinstance(
                error, (InterruptedError, TimeoutError, ConnectionError, DirectoryBindingChangedError, DirectoryPipelineTransportError)
            )
            or isinstance(error, SMBException)
            and not isinstance(error, (SMBOSError, SMBResponseException))
            or isinstance(error, OSError)
            and error.errno in SOURCE_RESOURCE_ERRNOS
            or status in SOURCE_TRANSPORT_STATUSES
        ):
            return None
        if isinstance(error, PermissionError) or status == NtStatus.STATUS_ACCESS_DENIED:
            return "access_denied"
        if isinstance(error, DirectoryTraversalError):
            return "unsafe_traversal"
        if isinstance(error, (UnicodeError, ValueError)):
            return "unsupported_encoding"
        return "scan_failed"

    def directory_issue_details(self) -> tuple[list[dict[str, str]], bool]:
        """Return bounded, source-local diagnostics, never a persistent error history."""
        with self.coordinator.lock:
            details = [
                {
                    "path": self.coordinator.issue_paths.get((parent, code), parent) or "/",
                    "code": code,
                    "scope": "directory" if (parent, code) in self.coordinator.issue_paths else "contents",
                }
                for parent, code in sorted(self.coordinator.issue_details)
            ]
            return details, self.coordinator.issue_details_incomplete

    def _record_item_issue(self, token: ScanReadToken, generation: int, code: str, *, reconcile: bool, path: str | None = None) -> None:
        self.coordinator.record_issue(token, generation, code, reconcile=reconcile, path=path)
        self._scan_issue_counts[code] = self._scan_issue_counts.get(code, 0) + 1
        if sum(self._scan_issue_counts.values()) <= MAX_LOGGED_SCAN_ISSUES_PER_PASS:
            self._logger.info(
                "Directory item skipped (path=%r). Check the folder name and permissions before the next verification pass.",
                token.path if path is None else path,
                extra={"event": "directory_scan_item_issue", "issue_code": code, "path": token.path if path is None else path},
            )

    def _source_call(self, parent: str, operation: Callable[[], WorkerResult]) -> WorkerResult:
        if not parent:
            self._root_reading.set()
        try:
            return operation()
        except (ScanObservationInvalidated, self._DescendantScanIssue):
            raise
        except DirectoryBindingChangedError as error:
            self._source_available.clear()
            self._source_probe_completed.set()
            self.coordinator.invalidate(InvalidationReason.SOURCE_REBIND)
            self._source_root = self._source_root.replacement()
            raise DirectorySourceUnavailableError(
                "Directory source is temporarily unavailable. Background verification will bind the root again."
            ) from error
        except Exception as error:
            self._source_root.require_verification()
            if parent:
                if (
                    isinstance(error, (FileNotFoundError, NotADirectoryError))
                    or isinstance(error, SMBOSError)
                    and error.ntstatus
                    in (NtStatus.STATUS_OBJECT_NAME_NOT_FOUND, NtStatus.STATUS_OBJECT_PATH_NOT_FOUND, NtStatus.STATUS_NOT_A_DIRECTORY)
                    or isinstance(error, SMBResponseException)
                    and error.status
                    in (NtStatus.STATUS_OBJECT_NAME_NOT_FOUND, NtStatus.STATUS_OBJECT_PATH_NOT_FOUND, NtStatus.STATUS_NOT_A_DIRECTORY)
                ):
                    raise self._DescendantMissing(
                        "Directory descendant disappeared. Verify its parent before retrying directory indexing."
                    ) from error
                if (
                    isinstance(error, PermissionError)
                    or (isinstance(error, SMBOSError) and error.ntstatus == NtStatus.STATUS_ACCESS_DENIED)
                    or (isinstance(error, SMBResponseException) and error.status == NtStatus.STATUS_ACCESS_DENIED)
                ):
                    raise self._DescendantAccessDenied(
                        "Directory descendant access was denied. Restore source permissions and retry verification."
                    ) from error
                code = self._classify_source_error(error)
                if code is not None:
                    raise self._DescendantScanIssue(code) from error
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
            with self.coordinator.read("", availability_only=True) as token:
                self._probe_source_root_read(token)
        finally:
            self._scan_running.clear()
            self._manager_scan_slots.release()

    def _probe_source_root_read(self, token: ScanReadToken) -> None:
        entries = self._source_call("", lambda: self._open_source_read("", token))
        with self._source_read("", entries.close):
            self._source_call("", lambda: next(entries, None))
            self._source_call("", entries.verify)
            if self._stop_event.is_set() or not self.coordinator.is_epoch_current(token):
                raise ScanObservationInvalidated("Directory root observation became stale. Retry source verification.")
        with self.coordinator.lock:
            if self._stop_event.is_set() or not self.coordinator.is_epoch_current(token):
                raise ScanObservationInvalidated("Directory root observation became stale. Retry source verification.")
            self._source_available.set()
            self._source_probe_completed.set()
            self._verification_error = None

    def _expected_scan_file_id(self, generation: int, parent: str) -> bytes | None:
        key = (generation, parent)
        if key in self._scan_job_file_ids:
            return self._scan_job_file_ids[key]
        return self.index.scan_parent_file_id(generation, parent)

    def _open_source_read(self, parent: str, token: ScanReadToken, *, deferred: bool = False) -> SmbDirectoryRead:
        def check() -> None:
            if self._stop_event.is_set():
                raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
            current = self.coordinator.is_epoch_current(token) if token.availability_only else self.coordinator.is_current(token)
            if not current:
                raise ScanObservationInvalidated("Directory scan observation became stale. Restart source verification.")
            self._scan_progress = time.monotonic()

        session: dict[str, Any] = {
            "username": self.username,
            "password": self.password,
            "port": self.port,
            "connection_cache": self._connection_cache,
            **get_smbclient_policy_kwargs(),
        }
        if token.observed:
            generation = self._progress_generation
            expected_id = self._expected_scan_file_id(generation, parent) if generation is not None else None
            if expected_id is None:
                raise ScanObservationInvalidated("Directory identity is not queued. Retry the parent through safe traversal.")
            if deferred:
                return self._source_root.read_observed(
                    parent,
                    expected_id,
                    check,
                    deferred=True,
                    credit_reserve=SCAN_CREDIT_RESERVE,
                    timeout=SCAN_TIMEOUT_SECONDS,
                    **session,
                )
            return self._source_root.read_observed(parent, expected_id, check, **session)
        return self._source_root.read(
            parent, check, full_root_check=token.availability_only or self._progress_generation is None, **session
        )

    def _scan_parent(
        self,
        generation: int,
        parent: str,
        *,
        reconcile: bool = False,
        prepared: _PendingSourceRead | None = None,
    ) -> None:
        try:
            self.coordinator.observed_ready = self._watcher_ready.is_set
            observed = (
                bool(parent)
                and not reconcile
                and self._watcher_ready.is_set()
                and not self.coordinator.observed_reads_blocked
                and self._expected_scan_file_id(generation, parent) is not None
                and self._progress_generation == generation
            )
            token = prepared.token if prepared is not None else self.coordinator.begin_read(parent, observed=observed)
            try:
                try:
                    if prepared is None:
                        self._scan_parent_read(generation, parent, token, reconcile=reconcile)
                    else:
                        if prepared.error is not None:
                            error = prepared.error

                            def failed_read() -> SmbDirectoryRead:
                                raise error

                            self._source_call(parent, failed_read)
                        if prepared.reader is None:
                            raise RuntimeError("Directory pipeline has no reader. Retry source verification.")
                        entries = self._source_call(parent, prepared.reader.result)
                        self._scan_parent_read(generation, parent, token, reconcile=reconcile, entries=entries)
                except self._DescendantMissing as error:
                    self._recover_missing_parent(generation, parent, token, error, reconcile=reconcile)
                except (self._DescendantAccessDenied, self._DescendantScanIssue, DirectoryTraversalError) as error:
                    if self._stop_event.is_set():
                        raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.") from None
                    if not parent:
                        raise
                    code = error.code if isinstance(error, self._DescendantScanIssue) else self._classify_source_error(error)
                    if code is None:
                        raise
                    self._record_item_issue(token, generation, code, reconcile=reconcile, path=token.path)
                    self.coordinator.finish_parent(token, generation, reconcile=reconcile, skip_children=True)
            finally:
                self.coordinator.end_read(token)
            self._stale_turns = 0
        except ScanObservationInvalidated:
            with self.coordinator.lock:
                self.index.defer_scan_parent(generation, parent)
            raise

    def _recover_missing_parent(self, generation: int, parent: str, token: ScanReadToken, error: Exception, *, reconcile: bool) -> None:
        """Verify absence through a held ancestor before deferring the missing job."""
        ancestor = parent.rpartition(PATH_SEPARATOR)[0]
        while True:
            with self.coordinator.read(ancestor) as ancestor_token:
                try:
                    entries = self._source_call(ancestor, lambda: self._open_source_read(ancestor, ancestor_token))
                except self._DescendantMissing:
                    ancestor = ancestor.rpartition(PATH_SEPARATOR)[0]
                    continue
                child = parent[len(ancestor) + 1 :].split(PATH_SEPARATOR)[0] if ancestor else parent.split(PATH_SEPARATOR)[0]
                with self._source_read(ancestor, entries.close):
                    if self._source_call(ancestor, lambda: entries.has_directory_child(child)):
                        raise error
                    self._source_call(ancestor, entries.verify)
                with self.coordinator.lock:
                    if (
                        self._stop_event.is_set()
                        or not self.coordinator.is_current(token)
                        or not self.coordinator.is_current(ancestor_token)
                    ):
                        raise ScanObservationInvalidated("Directory ancestor observation became stale. Retry source verification.")
                    self.index.queue_observed_parent(ancestor)
                    self.coordinator.finish_parent(token, generation, reconcile=reconcile)
                return

    def _scan_parent_read(
        self,
        generation: int,
        parent: str,
        token: ScanReadToken,
        *,
        reconcile: bool = False,
        entries: SmbDirectoryRead | None = None,
    ) -> None:
        if entries is None:
            entries = self._source_call(parent, lambda: self._open_source_read(parent, token))
        batch: list[tuple[str, bool]] = []
        batch_file_ids: dict[str, bytes] = {}
        batch_bytes = 0
        seen_children: set[str] = set()
        seen_bytes = 0
        seen_full = False

        def commit_batch() -> None:
            nonlocal batch_bytes, seen_bytes, seen_full
            self._source_call(parent, entries.verify)
            self.coordinator.commit_children(token, generation, batch, reconcile=reconcile, file_ids=batch_file_ids)
            for path, _is_directory in batch:
                if seen_full or path in seen_children:
                    continue
                size = len(path.encode("utf-8"))
                if seen_bytes + size > SCAN_SEEN_CHILD_BYTES:
                    seen_full = True
                    continue
                seen_children.add(path)
                seen_bytes += size
            batch.clear()
            batch_file_ids.clear()
            batch_bytes = 0

        with self._source_read(parent, entries.close):
            expected_id = self._expected_scan_file_id(generation, parent)
            if expected_id is not None:
                self._source_call(parent, lambda: entries.verify_file_id(expected_id))
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
                attributes = entry.smb_info.file_attributes
                if attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT:
                    continue
                if entry.name is None:
                    self._record_item_issue(token, generation, "unsupported_encoding", reconcile=reconcile)
                    continue
                if entry.name in (".", ".."):
                    continue
                if PATH_SEPARATOR in entry.name or "\\" in entry.name:
                    self._record_item_issue(token, generation, "unsupported_encoding", reconcile=reconcile)
                    continue
                if not attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY:
                    continue
                path = parent + PATH_SEPARATOR + entry.name if parent else entry.name
                try:
                    path_bytes = len(path.encode("utf-8"))
                except UnicodeError:
                    self._record_item_issue(token, generation, "unsupported_encoding", reconcile=reconcile)
                    continue
                try:
                    validate_directory_path(path)
                except ValueError:
                    self._record_item_issue(token, generation, "unsupported_encoding", reconcile=reconcile, path=path)
                    continue
                if path_bytes > MAX_OBSERVATION_BYTES:
                    self._record_item_issue(token, generation, "unsupported_encoding", reconcile=reconcile, path=path)
                    continue
                if batch and batch_bytes + path_bytes > MAX_OBSERVATION_BYTES:
                    commit_batch()
                batch.append((path, True))
                file_id = getattr(entry, "file_id", None)
                if file_id is not None:
                    batch_file_ids[path] = file_id
                batch_bytes += path_bytes
                if len(batch) == ROW_BATCH_SIZE:
                    commit_batch()
            if batch:
                commit_batch()
            self._source_call(parent, entries.verify)
            if not reconcile and not self.coordinator.has_complete_scan_snapshot(token):
                self._prune_missing_children(generation, parent, token, entries, seen_children, reconcile=reconcile)
        with self.coordinator.lock:
            if self._stop_event.is_set():
                raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
            self.coordinator.finish_parent(token, generation, reconcile=reconcile)
            if not parent:
                self._source_available.set()
                self._source_probe_completed.set()

    def _prune_missing_children(
        self, generation: int, parent: str, token: ScanReadToken, entries: SmbDirectoryRead, seen_children: set[str], *, reconcile: bool
    ) -> None:
        cursor: str | None = None
        while True:
            page = self.index.direct_child_paths(generation, parent, after_path=cursor)
            if not page:
                return
            for path in page:
                if path in seen_children:
                    continue
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

    def _scan_parent_page(self, generation: int, parents: list[str], *, reconcile: bool) -> None:
        """Keep bounded observed reads in flight and publish in queue order."""
        jobs = dict(self.index.pending_scan_jobs(generation, paths=parents))
        self._scan_job_file_ids = {(generation, parent): identity for parent, identity in jobs.items()}
        remaining = deque(parents)
        pending: deque[_PendingSourceRead] = deque()
        stale = False
        grew_credits = False
        active: _PendingSourceRead | None = None
        self.coordinator.observed_ready = self._watcher_ready.is_set
        try:
            while remaining or pending:
                while remaining and len(pending) < SCAN_PIPELINE_DEPTH:
                    parent = remaining[0]
                    if parent not in jobs:
                        remaining.popleft()
                        continue
                    observed = (
                        bool(parent)
                        and not reconcile
                        and self._watcher_ready.is_set()
                        and not self.coordinator.observed_reads_blocked
                        and self._progress_generation == generation
                        and self._expected_scan_file_id(generation, parent) is not None
                    )
                    if not observed:
                        if pending:
                            break
                        remaining.popleft()
                        self._scan_parent(generation, parent, reconcile=reconcile)
                        self.coordinator.flush_scan_group_if_due()
                        continue
                    prepared = _PendingSourceRead(self.coordinator.begin_read(parent, observed=True))
                    try:
                        reader = self._source_call(parent, lambda: self._open_source_read(parent, prepared.token, deferred=True))
                        if not isinstance(reader, SmbCompoundDirectoryReader):
                            reader.close()
                            raise RuntimeError("Directory pipeline requires a compound reader. Retry source verification.")
                        prepared.reader = reader
                        if not reader.sent and not pending and not grew_credits:
                            if not self.coordinator.is_current(prepared.token):
                                raise ScanObservationInvalidated("Directory observation changed before credit admission. Retry the parent.")
                            grew_credits = True
                            compound_reader = reader
                            self._source_call(parent, lambda: compound_reader.grow_credits(SCAN_TIMEOUT_SECONDS))
                            reader.close()
                            replacement = self._source_call(parent, lambda: self._open_source_read(parent, prepared.token, deferred=True))
                            if not isinstance(replacement, SmbCompoundDirectoryReader):
                                replacement.close()
                                raise RuntimeError("Directory pipeline requires a compound reader. Retry source verification.")
                            prepared.reader = replacement
                    except Exception as error:
                        prepared.error = error
                    admitted_reader = prepared.reader
                    if admitted_reader is not None and not admitted_reader.sent and pending and prepared.error is None:
                        admitted_reader.close()
                        self.coordinator.end_read(prepared.token)
                        break
                    pending.append(prepared)
                    remaining.popleft()
                    if prepared.error is not None or admitted_reader is None or not admitted_reader.sent:
                        break
                if not pending:
                    continue
                active = pending.popleft()
                try:
                    self._scan_parent(generation, active.token.path, reconcile=reconcile, prepared=active)
                except ScanObservationInvalidated:
                    if (
                        active.token.epoch != self.coordinator.epoch
                        or not self._watcher_ready.is_set()
                        or self.coordinator.observed_reads_blocked
                    ):
                        raise
                    stale = True
                finally:
                    if active.reader is not None:
                        try:
                            active.reader.close()
                        except ScanObservationInvalidated:
                            pass
                        except Exception as error:
                            logger.warning("Directory pipeline read cleanup failed (%s).", type(error).__name__)
                active = None
                self.coordinator.flush_scan_group_if_due()
            if stale:
                self.coordinator.flush_scan_group()
                raise ScanObservationInvalidated("Directory pipeline parent changed. Retry the affected parents.")
        except DirectoryPipelineTransportError:
            self.coordinator.invalidate(InvalidationReason.READ_CAPACITY)
            if active is not None:
                self.index.defer_scan_parent(generation, active.token.path)
            raise
        except TimeoutError as error:
            self.coordinator.invalidate(InvalidationReason.STALLED_READ)
            if active is not None:
                self.index.defer_scan_parent(generation, active.token.path)
            raise DirectoryPipelineTimeout("Directory pipeline stalled. Retry verification after the connection recovers.") from error
        finally:
            cleanup_timeout: TimeoutError | None = None
            for entry in pending:
                self.index.defer_scan_parent(generation, entry.token.path)
                try:
                    if entry.reader is not None:
                        entry.reader.close()
                except ScanObservationInvalidated:
                    pass
                except TimeoutError as error:
                    cleanup_timeout = error
                except Exception as error:
                    logger.warning("Directory pipeline read cleanup failed (%s).", type(error).__name__)
                finally:
                    self.coordinator.end_read(entry.token)
            if cleanup_timeout is not None:
                self.coordinator.invalidate(InvalidationReason.STALLED_READ)
                raise DirectoryPipelineTimeout(
                    "Directory pipeline cleanup stalled. Retry after the connection recovers."
                ) from cleanup_timeout

    def _reconcile_disk_queue(self) -> None:
        """Read bounded accepted-parent work without advancing full-pass clocks."""
        now = time.monotonic()
        if (
            self._stop_event.is_set()
            or now < max(self._resource_retry_at, self._verification_retry_at or 0.0)
            or not self._source_available.is_set()
        ):
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
                finished_parent = False
                self.coordinator.on_scan_commit = self._publish_scan_progress
                self.coordinator.start_scan_groups(reconcile=True)
                while generation is not None and time.monotonic() < deadline:
                    if self._stop_event.is_set():
                        raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                    if self.index.reconciliation_generation() != generation:
                        return
                    jobs = dict(self.index.pending_scan_jobs(generation, exclude=self.coordinator.buffered_scan_parents(generation)))
                    parents = list(jobs)
                    if parents and self.coordinator.has_buffered_ancestor(generation, parents):
                        self.coordinator.flush_scan_group()
                        continue
                    if not parents:
                        self.coordinator.flush_scan_group()
                        if self.index.pending_scan_paths(generation, limit=1):
                            continue
                        return
                    ready = [
                        parent
                        for parent in parents
                        if not any(other != parent and (not other or parent.startswith(other + PATH_SEPARATOR)) for other in parents)
                    ]
                    self._scan_job_file_ids = {(generation, parent): jobs[parent] for parent in ready}
                    for parent in ready:
                        if time.monotonic() >= deadline:
                            break
                        if parent not in jobs:
                            continue
                        self._reconcile_next = False
                        self._scan_parent(generation, parent, reconcile=True)
                        finished_parent = True
                self.coordinator.flush_scan_group()
            except ScanObservationInvalidated:
                if not finished_parent:
                    self._stale_turns += 1
                raise
            finally:
                self.coordinator.cancel_scan_groups()
                self._scan_job_file_ids.clear()
                self._scan_running.clear()
                self._manager_scan_slots.release()
        finally:
            self._generation_lock.release()

    async def _run_reconciliation(self) -> None:
        if (
            self._stop_event.is_set()
            or self._scan_running.is_set()
            or time.monotonic() < max(self._resource_retry_at, self._verification_retry_at or 0.0)
            or not self._source_available.is_set()
            or await self._blocking(self.index.reconciliation_generation) is None
        ):
            return
        connected = False
        try:
            await self._refresh_connection_generation()
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
        except ScanObservationInvalidated:
            raise
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
        started = time.monotonic()
        source_io = self._source_root.io
        round_trips_before = source_io.round_trips
        success = False
        finished_parent = False
        reconcile_error: Exception | None = None
        generation: int | None = None
        abort_reason: str | None = None
        invalidation_reason = self.coordinator.last_reason
        self._scan_issue_counts = {}
        try:
            self._scan_running.set()
            self._scan_progress = time.monotonic()
            with self._generation_lock:
                baseline = self.coordinator.capture_epoch()
                with self.coordinator.lock:
                    self.coordinator.apply_pending()
                    resuming = self.index.has_resumable_scan()
                    generation, _selected = self.index.prepare_scan()
                    if not resuming:
                        self.coordinator.issue_details.clear()
                        self.coordinator.issue_paths.clear()
                        self.coordinator.issue_details_incomplete = False
                        self._scan_epoch = (generation, baseline)
                    if self.coordinator.observation_lost:
                        while self.index.requeue_completed_scan_batch(generation):
                            if self._stop_event.is_set():
                                raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                        self.coordinator.observation_lost = False
                    self.index.seed_scan(generation)
                    self.coordinator.on_scan_commit = self._publish_scan_progress
                    self.coordinator.start_scan_groups()
                    done, queued, found = self.index.scan_counts(generation)
                    self.scan_progress = ScanProgress("building" if _selected else "updating", done, queued, found, int(time.time() * 1000))
                    self._progress_generation = generation
                    self._logger.info(
                        "Directory scan started.",
                        extra={
                            "event": "directory_scan_started",
                            "stage": "scan",
                            "scan_generation": generation,
                            "scan_phase": self.scan_progress.phase,
                            "parents_done": done,
                            "parents_queued": queued,
                            "directories_found": found,
                            "smb_round_trips": source_io.round_trips - round_trips_before,
                            "group_commits": 0,
                            "duration_ms": (time.monotonic() - started) * 1000,
                            "abort_reason": None,
                        },
                    )
                with self.coordinator.read("", availability_only=True) as root_token:
                    self._probe_source_root_read(root_token)

                def resume_safe_reads() -> int:
                    with self.coordinator.lock:
                        try:
                            self.coordinator.flush_scan_group()
                        except ScanObservationInvalidated:
                            pass
                        if self.coordinator.observation_lost:
                            while self.index.requeue_completed_scan_batch(generation):
                                if self._stop_event.is_set():
                                    raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                            self.coordinator.observation_lost = False
                        return self.coordinator.capture_epoch()

                while not self._stop_event.is_set():
                    with self.coordinator.lock:
                        if baseline != self.coordinator.epoch:
                            if self.coordinator.observed_reads_blocked:
                                baseline = resume_safe_reads()
                            else:
                                raise ScanObservationInvalidated("Directory scan epoch changed. Retry source verification.")
                        self.coordinator.apply_pending()
                        if self.coordinator.pending:
                            continue
                    reconciliation = None if reconcile_error is not None else self.index.reconciliation_generation()
                    parents = self.index.pending_scan_paths(generation, exclude=self.coordinator.buffered_scan_parents(generation))
                    if parents and self.coordinator.has_buffered_ancestor(generation, parents):
                        self.coordinator.flush_scan_group()
                        continue
                    if not parents and reconcile_error is not None:
                        self.coordinator.flush_scan_group()
                        raise reconcile_error
                    reconcile = reconciliation is not None and (not parents or self._reconcile_next)
                    current = reconciliation if reconcile and reconciliation is not None else generation
                    if reconcile:
                        self.coordinator.flush_scan_group()
                        parents = self.index.pending_scan_paths(current, limit=1)
                    if not parents:
                        self.coordinator.flush_scan_group()
                        if self.index.pending_scan_paths(generation, limit=1) or self.index.reconciliation_generation() is not None:
                            continue
                        with self.coordinator.read("", availability_only=True) as root_token:
                            self._probe_source_root_read(root_token)
                        with self.coordinator.lock:
                            if self._stop_event.is_set():
                                raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
                            self.coordinator.apply_pending()
                            if (
                                self.coordinator.pending
                                or self.index.reconciliation_generation() is not None
                                or self.index.pending_scan_paths(generation, limit=1)
                            ):
                                continue
                            invalidation_reason = self.coordinator.last_reason
                            complete = self.coordinator.accept_generation(baseline, generation)
                        self._state = CacheState.READY
                        self._coverage_incomplete = not complete
                        if complete:
                            self._last_scan_time = time.time()
                            self._stale_turns = 0
                        success = complete
                        break
                    self._reconcile_next = not reconcile
                    watcher_was_ready = self._watcher_ready.is_set()
                    try:
                        self._scan_parent_page(current, parents, reconcile=reconcile)
                        self.coordinator.flush_scan_group_if_due()
                    except (InterruptedError, DirectoryDiskBudgetError):
                        raise
                    except Exception as error:
                        if (
                            isinstance(error, ScanObservationInvalidated)
                            and not reconcile
                            and (
                                (baseline != self.coordinator.epoch and self.coordinator.observed_reads_blocked)
                                or (watcher_was_ready and not self._watcher_ready.is_set())
                            )
                        ):
                            baseline = resume_safe_reads()
                            continue
                        if not reconcile or self._stop_event.is_set():
                            raise
                        # Finish candidate work first; the accepted-parent failure ends the turn afterwards.
                        reconcile_error = error
                        continue
                    finished_parent = True
                else:
                    raise InterruptedError("Directory source stopped. Reopen the connection to initialize it.")
        except ScanObservationInvalidated:
            abort_reason = "observation_invalidated"
            if not finished_parent:
                self._stale_turns += 1
            raise
        except Exception as error:
            abort_reason = type(error).__name__
            raise
        finally:
            self.coordinator.cancel_scan_groups()
            self._progress_generation = None
            self._scan_job_file_ids.clear()
            last_progress = self.scan_progress
            if last_progress is not None:
                self.scan_progress = ScanProgress(
                    "idle",
                    last_progress.parents_done,
                    last_progress.parents_queued,
                    last_progress.directories_found,
                    last_progress.started_at_ms,
                )
            self._scan_running.clear()
            self._manager_scan_slots.release()
            reason = self.coordinator.last_reason or invalidation_reason
            self._logger.info(
                "Directory scan finished (success=%s).",
                success,
                extra={
                    "event": "directory_scan_finished",
                    "stage": "scan",
                    "duration_ms": (time.monotonic() - started) * 1000,
                    "invalidation_reason": reason.value if reason is not None else None,
                    "stale_turns": self._stale_turns,
                    "scan_generation": generation,
                    "scan_phase": last_progress.phase if last_progress is not None else None,
                    "parents_done": last_progress.parents_done if last_progress is not None else 0,
                    "parents_queued": last_progress.parents_queued if last_progress is not None else 0,
                    "directories_found": last_progress.directories_found if last_progress is not None else 0,
                    "group_commits": self.coordinator.scan_commits,
                    "smb_round_trips": source_io.round_trips - round_trips_before,
                    "abort_reason": abort_reason,
                    "access_denied_count": self._scan_issue_counts.get("access_denied", 0),
                    "unsupported_encoding_count": self._scan_issue_counts.get("unsupported_encoding", 0),
                    "unsafe_traversal_count": self._scan_issue_counts.get("unsafe_traversal", 0),
                    "scan_failed_count": self._scan_issue_counts.get("scan_failed", 0),
                },
            )

    def _schedule_observation_retry(self) -> None:
        """Coalesce stale-read retries without classifying them as source failures."""
        now = time.monotonic()
        deadline = now + OBSERVATION_RETRY_SECONDS
        if self._verification_retry_at is None or self._verification_retry_at <= now:
            self._verification_retry_at = deadline
        else:
            self._verification_retry_at = min(self._verification_retry_at, deadline)
        self._state = CacheState.READY if self._directory_count else CacheState.EMPTY
        self._logger.debug(
            "Directory observation retry scheduled.",
            extra={
                "event": "directory_retry_scheduled",
                "stage": "observation",
                "retry_seconds": OBSERVATION_RETRY_SECONDS,
                "invalidation_reason": self.coordinator.last_reason.value if self.coordinator.last_reason else None,
                "stale_turns": self._stale_turns,
            },
        )

    def _schedule_retry(self, *, now: float | None = None) -> None:
        """Spread bounded retries without changing the configured full-pass interval."""
        self._failure_retry_delay = (
            FAILURE_RETRY_MIN_SECONDS if not self._failure_retry_delay else min(self._failure_retry_delay * 2, FAILURE_RETRY_MAX_SECONDS)
        )
        percent = 100 - FAILURE_RETRY_JITTER_PERCENT + self._retry_jitter % (FAILURE_RETRY_JITTER_PERCENT * 2 + 1)
        delay = min(FAILURE_RETRY_MAX_SECONDS, max(FAILURE_RETRY_MIN_SECONDS, self._failure_retry_delay * percent / 100))
        self._resource_retry_at = (time.monotonic() if now is None else now) + delay
        self._logger.debug(
            "Directory retry scheduled.",
            extra={
                "event": "directory_retry_scheduled",
                "stage": "verification",
                "retry_seconds": delay,
                "invalidation_reason": self.coordinator.last_reason.value if self.coordinator.last_reason else None,
                "stale_turns": self._stale_turns,
            },
        )

    def _reset_retry(self) -> None:
        if self._failure_retry_delay:
            self._logger.info(
                "Directory verification recovered.", extra={"event": "directory_verification_recovered", "stage": "verification"}
            )
        self._failure_retry_delay = 0.0
        self._resource_retry_at = 0.0
        self._verification_retry_at = None
        self._disk_budget_error = None
        self._verification_error = None
        self._update_error = None

    def _verification_due(self, verified_at: float, *, now: float | None = None) -> bool:
        current = time.monotonic() if now is None else now
        interval = (
            self.policy.degraded_verification_seconds
            if self.coordinator.verification_required or not self._watcher_ready.is_set()
            else self.policy.healthy_verification_seconds
        )
        delay = interval * (100 - self._retry_jitter % (PERIODIC_VERIFICATION_JITTER_PERCENT + 1)) / 100
        return current >= self._resource_retry_at and (
            bool(self._failure_retry_delay)
            or (self._verification_retry_at is not None and current >= self._verification_retry_at)
            or current >= verified_at + delay
        )

    async def _refresh_connection_generation(self) -> None:
        replacement = get_smb_connection_cache(self.connection_id)
        if replacement is self._connection_cache:
            return
        with self._workers:
            if self._active_workers:
                raise DirectoryScanCapacityError(
                    "Previous directory work is still running. Wait for its cleanup before retrying verification."
                )
        self.coordinator.invalidate(InvalidationReason.SOURCE_REBIND)
        self._source_available.clear()
        self._source_probe_completed.set()
        self._source_root = await self._blocking(self._source_root.replacement)
        self._connection_cache = replacement

    async def _run_rescan(self) -> None:
        now = time.monotonic()
        if (
            not self._opened.is_set()
            or self._scan_running.is_set()
            or now < self._resource_retry_at
            or (self._verification_retry_at is not None and now < self._verification_retry_at)
        ):
            return
        resumable = await self._blocking(self.index.has_resumable_scan)
        if now < self._next_full_pass_at and not resumable and self._source_available.is_set():
            return
        self._state = CacheState.UPDATING if self._directory_count else CacheState.BUILDING
        root_checked = False
        try:
            await self._refresh_connection_generation()
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
                if now < self._next_full_pass_at and not resumable:
                    self._state = CacheState.READY if self._directory_count else CacheState.EMPTY
                    return
                if self.index.needs_fts_repair:
                    await self._blocking(self._repair_fts_work)
                if not resumable:
                    self._next_full_pass_at = time.monotonic() + DIRECTORY_INDEX_CONTRACT.limits["minimum_full_pass_spacing_seconds"]
                await self._blocking(self._scan_disk_queue, pool=pool)
            self._reset_retry()
        except asyncio.CancelledError:
            self.coordinator.invalidate(InvalidationReason.LIFECYCLE)
            raise
        except ScanObservationInvalidated:
            self._schedule_observation_retry()
        except Exception as error:
            capacity_busy = isinstance(error, DirectoryScanCapacityError)
            if not capacity_busy and (not root_checked or self._root_reading.is_set()):
                self._source_available.clear()
                self._source_probe_completed.set()
            if isinstance(error, DirectoryDiskBudgetError):
                self._reclamation_pending = True
                self._disk_budget_error = str(error)
            elif not self._stalled_read.is_set():
                self._verification_error = (
                    str(error)
                    if capacity_busy
                    else "Directory verification failed. Check source access; existing results remain available."
                )
            self._state = CacheState.READY if self._directory_count else CacheState.EMPTY
            if not self._failure_retry_delay:
                self._logger.warning(
                    "Directory verification failed. Background retries remain active.",
                    extra={"event": "directory_verification_unavailable", "stage": "verification", "error_type": type(error).__name__},
                    exc_info=True,
                )
            self._schedule_retry()

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
                    if self._verification_due(verified_at):
                        await self._run_rescan()
                        verified_at = time.monotonic()
                    await self._run_reconciliation()
                    response = await self._blocking(self.index.status)
                    self._directory_count = response.directory_count
                    if self._reclamation_pending:
                        await self._blocking(self._reclaim_disk_work)
                    if not self._scan_running.is_set():
                        await self._blocking(self._checkpoint_work)
                    self._update_error = None
            except asyncio.CancelledError:
                return
            except ScanObservationInvalidated:
                self._schedule_observation_retry()
            except Exception as error:
                if isinstance(error, DirectoryDiskBudgetError):
                    self._reclamation_pending = True
                    self._disk_budget_error = str(error)
                else:
                    self._update_error = "Directory updates failed. Check source access and private local storage, then retry."
                self._schedule_retry()
                logger.warning("Directory updates paused (%s).", type(error).__name__)

    def _request_stop(self) -> None:
        self.coordinator.invalidate(InvalidationReason.LIFECYCLE)
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
            await wait_for_worker(closing)

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
            except Exception as error:
                logger.error(
                    "Directory idle release failed (%s). Existing sources remain protected; retrying background cleanup.",
                    type(error).__name__,
                    extra={"event": "directory_idle_release_failed", "error_type": type(error).__name__},
                )

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
                and previous._source_revision == source_revision
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
            logger.info("Directory cache removed.", extra={"event": "directory_source_removed"})

    async def remove_cache_async(self, connection_id: str) -> None:
        """Remove one cache without blocking the application event loop."""

        with self._lock:
            cache = self._caches.pop(connection_id, None)

        if cache is None:
            return

        cache._request_stop()
        try:
            await asyncio.to_thread(cache._finish_stop)
        except Exception as error:
            logger.error(
                "Directory cache shutdown failed (%s). Storage ownership remains held until workers exit.",
                type(error).__name__,
                extra={"event": "directory_source_shutdown_failed", "error_type": type(error).__name__},
            )
        else:
            logger.info("Directory cache removed.", extra={"event": "directory_source_removed"})

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
            except Exception as error:
                logger.error(
                    "Directory cache shutdown failed (%s). Storage ownership remains held until workers exit.",
                    type(error).__name__,
                    extra={"event": "directory_source_shutdown_failed", "error_type": type(error).__name__},
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
                    "Directory cache shutdown failed (%s). Storage ownership remains held until workers exit.",
                    type(result).__name__,
                    extra={"event": "directory_source_shutdown_failed", "error_type": type(result).__name__},
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
