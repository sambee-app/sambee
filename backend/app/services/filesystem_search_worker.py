"""Response-owned SMB search workers and bounded result delivery."""

import asyncio
import logging
import threading
import time
import uuid
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from typing import Any, Literal

from smbprotocol.exceptions import SMBOSError, SMBResponseException

from app.core.directory_index_contract import MAX_WIRE_INTEGER
from app.core.filesystem_search_contract import (
    LIMITS,
    ArchiveRoot,
    ArchiveTarget,
    PhysicalTarget,
    SearchBatch,
    SearchCounts,
    SearchItem,
    SearchLimits,
    SearchRequest,
    SearchSkip,
    SearchStart,
    SearchTerminal,
)
from app.models.file import FileInfo, FileType
from app.services.archive.zip_reader import (
    ArchiveFormatError,
    ArchiveInspectionManifestMember,
    ZipEntry,
    ZipReader,
    build_effective_projection,
)
from app.services.directory_traversal import SmbDirectoryRead, SmbDirectoryRoot
from app.services.filesystem_search_admission import SearchLease
from app.services.filesystem_search_archive import ArchiveSearchTooLarge, iter_archive_matches, read_search_entries
from app.services.filesystem_search_matching import NameMatcher
from app.services.filesystem_search_physical import PhysicalSearchEvent, PhysicalSearchOptions, PhysicalSearchSummary, search_physical
from app.storage.smb import SMBBackend
from app.utils.file_type_registry import get_mime_type

logger = logging.getLogger(__name__)
QUEUE_WAIT_SECONDS = 0.1
AUTHORIZATION_CHECK_SECONDS = 1.0
MAX_SEARCH_WORKERS = 16
_search_executor = ThreadPoolExecutor(max_workers=MAX_SEARCH_WORKERS, thread_name_prefix="smb-search")
_search_slots = threading.BoundedSemaphore(MAX_SEARCH_WORKERS)

SkipReason = Literal["unreadable_directory", "unsafe_name", "archive_too_large", "archive_unreadable", "queue_limit"]
TerminalReason = Literal["complete", "partial_coverage", "time_limit", "result_limit", "source_failure"]


@dataclass(frozen=True)
class SearchPolicy:
    concurrent_searches: int
    max_seconds: int
    max_results: int

    def __post_init__(self) -> None:
        if any(type(value) is not int or value <= 0 for value in (self.concurrent_searches, self.max_seconds, self.max_results)):
            raise ValueError("Search policy must contain positive integer limits.")


def _wire_size(size: int | None) -> int | None:
    """Omit sizes that JSON clients cannot represent exactly, as the Companion does."""
    return size if size is not None and 0 <= size <= MAX_WIRE_INTEGER else None


class _Stopped(Exception):
    pass


class _ResultLimit(Exception):
    pass


class SearchCapacityError(RuntimeError):
    """The process cannot admit another source worker."""


class SmbSearchWorker:
    """Keep the admission lease until the storage worker and cleanup have finished."""

    def __init__(
        self,
        request: SearchRequest,
        policy: SearchPolicy,
        lease: SearchLease,
        backend: SMBBackend,
        authorize: Callable[[], Awaitable[bool]],
    ) -> None:
        self.request = request
        self.policy = policy
        self.lease = lease
        self.backend = backend
        self.authorize = authorize
        self.id = uuid.uuid4()
        self.deadline = time.monotonic() + policy.max_seconds
        self._stop = threading.Event()
        self._stop_handle = lease.stop_handle()
        self._loop = asyncio.get_running_loop()
        self._queue: asyncio.Queue[SearchItem | TerminalReason] = asyncio.Queue(maxsize=LIMITS["queued_batches"])
        self._summary = PhysicalSearchSummary()
        self._skips: Counter[SkipReason] = Counter()
        self._matches = 0
        self._seen: set[tuple[str, ...]] = set()
        self._matcher = NameMatcher(request.query, case_sensitive=request.case_sensitive)
        self._task: asyncio.Future[None] | None = None
        self._source: SmbDirectoryRoot | None = None
        self._session: Mapping[str, Any] = {}
        self._capacity: threading.BoundedSemaphore | None = None

    def start(self) -> None:
        if self._task is not None:
            raise RuntimeError("Search worker has already started.")
        capacity = _search_slots
        if not capacity.acquire(blocking=False):
            raise SearchCapacityError("Search capacity is busy. Stop another search or try again shortly.")
        self._capacity = capacity
        try:
            self._task = asyncio.create_task(self._execute())
        except BaseException:
            self._capacity = None
            capacity.release()
            raise

    def stop(self) -> None:
        self._stop.set()
        self._stop_handle.stopping()

    def _check(self) -> None:
        if self._stop.is_set() or time.monotonic() >= self.deadline:
            raise _Stopped()

    def _put(self, item: SearchItem | TerminalReason) -> None:
        self._check()
        pending = asyncio.run_coroutine_threadsafe(self._queue.put(item), self._loop)
        try:
            while True:
                try:
                    pending.result(timeout=QUEUE_WAIT_SECONDS)
                    return
                except FutureTimeout:
                    self._check()
        except BaseException:
            pending.cancel()
            raise

    def _emit(self, item: SearchItem) -> None:
        target = item.target
        key = ("physical", target.path) if isinstance(target, PhysicalTarget) else ("archive", target.archive_path, target.member_path)
        if key in self._seen:
            return
        self._check()
        self._put(item)
        self._seen.add(key)
        self._matches += 1
        if self._matches >= self.policy.max_results:
            raise _ResultLimit()

    async def _archive_entries(self, parent: SmbDirectoryRead, name: str, expected_id: bytes | None) -> tuple[ZipEntry, ...]:
        reader, size = await self.backend.open_search_archive_reader(parent, name, expected_id)
        try:
            return await read_search_entries(ZipReader(reader, size), self._check)
        finally:
            try:
                await reader.close()
            except TimeoutError:
                logger.warning("SMB archive cleanup is still running. The search slot remains occupied.")
                await reader.wait_closed()
                raise

    def _search_archive(self, path: str, root: str, depth: Literal["current", "recursive"], expected_id: bytes | None = None) -> None:
        self._check()
        if self._source is None:
            raise RuntimeError("Search source is not open.")
        parent_path, _, name = path.rpartition("/")
        parent = self._source.read(parent_path, self._check, full_root_check=False, include_files=True, **self._session)
        try:
            raw_entries = asyncio.run_coroutine_threadsafe(self._archive_entries(parent, name, expected_id), self._loop).result()
            parent.verify()
        finally:
            parent.close()
        self._check()
        # The projection is CPU-bound; build it in this worker thread so the event loop stays responsive.
        projection = build_effective_projection(raw_entries)
        for match in iter_archive_matches(projection, root, depth, self.request.item_type, self._matcher, self._check):
            entry = match.entry
            name = match.path.rsplit("/", 1)[-1]
            state: Literal["readable", "blocked", "unavailable"] = "readable"
            if not match.is_directory and entry is not None:
                state = ArchiveInspectionManifestMember(
                    path=entry.path,
                    is_directory=False,
                    compressed_size=entry.compressed_size,
                    uncompressed_size=entry.uncompressed_size,
                    compression_method=entry.compression_method,
                    crc32=entry.crc32,
                    modified_at=entry.modified_at,
                    encrypted=entry.encrypted,
                    is_safe=entry.is_safe,
                    has_supported_file_type=entry.has_supported_file_type,
                ).preview_state
            self._emit(
                SearchItem(
                    entry=FileInfo(
                        name=name,
                        path=match.path,
                        type=FileType.DIRECTORY if match.is_directory else FileType.FILE,
                        size=None if match.is_directory or entry is None else _wire_size(entry.uncompressed_size),
                        mime_type=None if match.is_directory else get_mime_type(name),
                        modified_at=None if entry is None else entry.modified_at,
                        is_readable=state == "readable",
                        is_hidden=name.startswith("."),
                    ),
                    target=ArchiveTarget(kind="archive", archive_path=path, member_path=match.path),
                    archive_state=state,
                )
            )

    def _receive(self, event: PhysicalSearchEvent) -> None:
        if event.kind == "issue":
            self._skips["unsafe_name" if event.issue == "unsafe_name" else "unreadable_directory"] += 1
        elif event.kind == "archive":
            try:
                self._search_archive(event.path, "", "recursive", event.entry.file_id if event.entry else None)
            except ArchiveSearchTooLarge:
                self._skips["archive_too_large"] += 1
            except (ArchiveFormatError, OSError, SMBOSError, SMBResponseException):
                self._skips["archive_unreadable"] += 1
        else:
            if event.entry is None or event.entry.name is None:
                raise ValueError("Search entry metadata is missing.")
            is_directory = event.kind == "directory"
            self._emit(
                SearchItem(
                    entry=FileInfo(
                        name=event.entry.name,
                        path=event.path,
                        type=FileType.DIRECTORY if is_directory else FileType.FILE,
                        size=None if is_directory else _wire_size(event.entry.size),
                        mime_type=None if is_directory else get_mime_type(event.entry.name),
                        modified_at=event.entry.modified_at,
                        is_hidden=event.entry.name.startswith("."),
                    ),
                    target=PhysicalTarget(kind="physical", path=event.path),
                )
            )

    async def _execute(self) -> None:
        try:
            async with self.backend.directory_search_context() as (source_path, session):
                future = self._loop.run_in_executor(_search_executor, self._run, source_path, session)
                try:
                    await asyncio.shield(future)
                except asyncio.CancelledError:
                    self.stop()
                    await asyncio.shield(future)
                    raise
        except Exception as error:
            logger.error("SMB search connection failed (%s). Check source access and retry.", type(error).__name__)
            if not self._stop.is_set():
                await self._queue.put("source_failure")
        finally:
            try:
                self.lease.release()
            finally:
                if self._capacity is not None:
                    self._capacity.release()

    def _run(self, source_path: str, session: Mapping[str, Any]) -> None:
        reason: TerminalReason = "complete"
        root: SmbDirectoryRoot | None = None
        try:
            root = SmbDirectoryRoot(source_path)
            self._source = root
            self._session = session
            if isinstance(self.request.root, ArchiveRoot):
                self._search_archive(self.request.root.path, self.request.root.member_path, self.request.folder_depth)
            else:
                search_physical(
                    root,
                    PhysicalSearchOptions(
                        self.request.root.path,
                        self.request.folder_depth,
                        self.request.item_type,
                        self.request.search_archives,
                        self._matcher,
                    ),
                    session,
                    self._check,
                    self._receive,
                    summary=self._summary,
                )
                if self._summary.queue_limit_reached:
                    self._skips["queue_limit"] += 1
                if self._skips:
                    reason = "partial_coverage"
        except _ResultLimit:
            reason = "result_limit"
        except _Stopped:
            return
        except ArchiveSearchTooLarge:
            self._skips["archive_too_large"] += 1
            reason = "source_failure"
        except ArchiveFormatError:
            self._skips["archive_unreadable"] += 1
            reason = "source_failure"
        except (OSError, SMBOSError, SMBResponseException) as error:
            logger.error(
                "SMB file-system search failed (%s; underlying error: %s). Check source access and retry.",
                type(error).__name__,
                type(error.__cause__).__name__ if error.__cause__ is not None else "none",
            )
            if isinstance(self.request.root, ArchiveRoot):
                self._skips["archive_unreadable"] += 1
            reason = "source_failure"
        except Exception as error:
            logger.error("SMB file-system search failed (%s). Check source access and retry.", type(error).__name__)
            reason = "source_failure"
        finally:
            try:
                if root is not None:
                    root.close()
            except Exception as error:
                logger.error("SMB file-system search could not release its source handles (%s).", type(error).__name__)
                reason = "source_failure"
        try:
            self._put(reason)
        except _Stopped:
            pass

    async def _authorize_before_deadline(self) -> bool:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        return await asyncio.wait_for(self.authorize(), timeout=remaining)

    async def stream(self) -> AsyncIterator[bytes]:
        if self._task is None:
            raise RuntimeError("Search worker has not started.")
        delivered = 0
        try:
            yield (
                SearchStart(
                    type="start",
                    version=1,
                    request_id=self.id,
                    limits=SearchLimits(max_seconds=self.policy.max_seconds, max_results=self.policy.max_results),
                ).model_dump_json()
                + "\n"
            ).encode()
            reason: TerminalReason
            while True:
                remaining = self.deadline - time.monotonic()
                if remaining <= 0:
                    reason = "time_limit"
                    break
                try:
                    item = await asyncio.wait_for(self._queue.get(), timeout=min(remaining, AUTHORIZATION_CHECK_SECONDS))
                except TimeoutError:
                    if time.monotonic() >= self.deadline:
                        reason = "time_limit"
                        break
                    try:
                        authorized = await self._authorize_before_deadline()
                    except TimeoutError:
                        reason = "time_limit"
                        break
                    if not authorized:
                        reason = "source_failure"
                        break
                    continue
                if time.monotonic() >= self.deadline:
                    reason = "time_limit"
                    break
                try:
                    authorized = await self._authorize_before_deadline()
                except TimeoutError:
                    reason = "time_limit"
                    break
                if time.monotonic() >= self.deadline:
                    reason = "time_limit"
                    break
                if not authorized:
                    reason = "source_failure"
                    break
                if isinstance(item, str):
                    reason = item
                    break
                delivered += 1
                yield (SearchBatch(type="batch", results=[item]).model_dump_json(exclude_none=True) + "\n").encode()
            self.stop()
            skip_counts = self._skips.copy()
            skips = [SearchSkip(reason=key, count=value) for key, value in skip_counts.items()]
            terminal = SearchTerminal(
                type="terminal",
                reason=reason,
                counts=SearchCounts(
                    matches=delivered, scanned_directories=self._summary.scanned_directories, skipped=sum(skip_counts.values())
                ),
                skips=skips,
            )
            yield (terminal.model_dump_json() + "\n").encode()
        finally:
            self.stop()
