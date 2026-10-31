"""Process-local, source-owned ZIP extraction session state."""

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Literal

from app.services.archive.zip_reader import ArchiveFormatError, ValidatedZipEntry, ZipEntry, ZipReader
from app.storage.base import RandomAccessReader

_MAX_AGGREGATE_COUNTER = (1 << 63) - 1


def canonicalize_selected_member_roots(paths: list[str] | tuple[str, ...] | None) -> tuple[str, ...] | None:
    """Validate and collapse selected ZIP member roots into a stable namespace."""

    if paths is None:
        return None
    if not paths:
        raise LiveSourceSessionError("Archive member selection must not be empty")
    roots: list[str] = []
    for path in paths:
        normalized = path.replace("\\", "/").rstrip("/")
        if not normalized or normalized.startswith("/") or "\x00" in normalized:
            raise LiveSourceSessionError("Archive member selection contains an invalid path")
        segments = normalized.split("/")
        if any(segment in {"", ".", ".."} for segment in segments):
            raise LiveSourceSessionError("Archive member selection contains an invalid path")
        if any(normalized == root or normalized.startswith(f"{root}/") for root in roots):
            continue
        roots = [root for root in roots if not root.startswith(f"{normalized}/")]
        roots.append(normalized)
    return tuple(sorted(roots))


class LiveSourceSessionError(ValueError):
    """Raised when a live source transition does not match its current state."""


class LiveSourceSessionCancelled(Exception):
    """Raised when a live source stream observes its cancellation fence."""


class LiveSourceSessionPhase(StrEnum):
    READY = "ready"
    CURRENT = "current"
    STREAMING_CURRENT = "streaming_current"
    AWAITING_RESULT = "awaiting_result"
    AWAITING_DECISION = "awaiting_decision"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

    @property
    def is_terminal(self) -> bool:
        return self in {self.COMPLETED, self.FAILED, self.CANCELLED}


@dataclass(frozen=True)
class DestinationWriteResult:
    """Transient destination outcome accepted only by the ZIP-owning session."""

    source_session_id: str
    delivery_sequence: int
    member_path: str
    status: Literal[
        "directory",
        "extracted",
        "skipped",
        "ignored",
        "awaiting_collision",
        "awaiting_retry",
        "fatal",
    ]
    extracted_bytes: int = 0
    directories_created: int = 0
    replaced: bool = False
    target_path: str | None = None
    message: str | None = None
    target_size: int | None = None
    target_modified_at: datetime | None = None


@dataclass(frozen=True)
class LiveSourcePendingDecision:
    """Bounded actionable state retained only while the source session is live."""

    revision: int
    kind: Literal["collision", "member_error"]
    member_path: str
    target_path: str | None
    message: str | None
    source_size: int | None = None
    source_modified_at: datetime | None = None
    target_size: int | None = None
    target_modified_at: datetime | None = None


@dataclass
class LiveExtractionAggregate:
    """Aggregate-only outcome facts persisted at operation completion."""

    members_processed: int = 0
    members_completed: int = 0
    members_skipped: int = 0
    encrypted_members_skipped: int = 0
    unsupported_compression_members_skipped: int = 0
    members_failed: int = 0
    files_extracted: int = 0
    directories_created: int = 0
    extracted_bytes: int = 0
    files_replaced: int = 0

    def record(
        self,
        status: Literal["directory", "extracted", "skipped", "ignored", "failed"],
        *,
        extracted_bytes: int = 0,
        directories_created: int = 0,
        replaced: bool = False,
    ) -> None:
        if extracted_bytes < 0 or directories_created < 0 or type(replaced) is not bool:
            raise LiveSourceSessionError("Destination result counters are invalid")
        if status == "directory":
            if extracted_bytes or replaced:
                raise LiveSourceSessionError("Directory destination result counters are invalid")
            self.members_completed = _checked_add(self.members_completed, 1)
        elif status == "extracted":
            self.members_completed = _checked_add(self.members_completed, 1)
            self.files_extracted = _checked_add(self.files_extracted, 1)
            self.extracted_bytes = _checked_add(self.extracted_bytes, extracted_bytes)
            self.files_replaced = _checked_add(self.files_replaced, int(replaced))
        elif status in {"skipped", "ignored"}:
            if extracted_bytes or replaced:
                raise LiveSourceSessionError("Skipped destination result counters are invalid")
            self.members_skipped = _checked_add(self.members_skipped, 1)
        else:
            if extracted_bytes or directories_created or replaced:
                raise LiveSourceSessionError("Failed destination result counters are invalid")
            self.members_failed = _checked_add(self.members_failed, 1)
        self.directories_created = _checked_add(self.directories_created, directories_created)
        self.members_processed = _checked_add(self.members_processed, 1)
        if self.members_processed != self.members_completed + self.members_skipped + self.members_failed:
            raise LiveSourceSessionError("Archive aggregate member counters are invalid")

    def checkpoint_payload(self) -> dict[str, int]:
        return {
            "members_processed": self.members_processed,
            "members_completed": self.members_completed,
            "members_skipped": self.members_skipped,
            "members_failed": self.members_failed,
            "files_extracted": self.files_extracted,
            "directories_created": self.directories_created,
            "extracted_bytes": self.extracted_bytes,
            "files_replaced": self.files_replaced,
            "encrypted_members_skipped": self.encrypted_members_skipped,
            "unsupported_compression_members_skipped": self.unsupported_compression_members_skipped,
        }


@dataclass(frozen=True)
class LiveSourceMember:
    """Current source-owned record that a destination may receive once."""

    source_session_id: str
    delivery_sequence: int
    path: str
    is_directory: bool
    uncompressed_size: int
    modified_at: datetime | None
    target_path: str | None = None
    collision_policy: str | None = None


@dataclass
class _CurrentEntry:
    entry: ZipEntry
    validated_entry: ValidatedZipEntry
    delivery_sequence: int
    target_path: str | None = None
    collision_policy: str | None = None


@dataclass
class LiveSourceSession:
    """One retained ZIP source cursor serialized by its per-session lock."""

    reader: ZipReader
    selected_member_roots: tuple[str, ...] | None = None
    source_session_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    aggregate: LiveExtractionAggregate = field(default_factory=LiveExtractionAggregate)
    phase: LiveSourceSessionPhase = LiveSourceSessionPhase.READY
    _current: _CurrentEntry | None = field(default=None, init=False, repr=False)
    _redelivery_available: bool = field(default=False, init=False, repr=False)
    _next_delivery_sequence: int = field(default=1, init=False, repr=False)
    _next_decision_revision: int = field(default=1, init=False, repr=False)
    _pending_decision: LiveSourcePendingDecision | None = field(default=None, init=False, repr=False)
    _collision_policy: str | None = field(default=None, init=False, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _cancellation_requested: asyncio.Event = field(default_factory=asyncio.Event, init=False, repr=False)
    _stream_finished: asyncio.Event = field(default_factory=asyncio.Event, init=False, repr=False)
    _streaming: bool = field(default=False, init=False, repr=False)
    _close_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _closed: bool = field(default=False, init=False, repr=False)
    _projected_entries: tuple[ZipEntry, ...] | None = field(default=None, init=False, repr=False)
    _projected_entry_index: int = field(default=0, init=False, repr=False)

    def __post_init__(self) -> None:
        self.selected_member_roots = canonicalize_selected_member_roots(self.selected_member_roots)

    async def next_member(self) -> LiveSourceMember | None:
        """Return the next destination-facing record after source-only rejections."""

        async with self._lock:
            self._require_phase(LiveSourceSessionPhase.READY)
            return await self._next_member_locked()

    async def next_destination_member(self) -> LiveSourceMember | None:
        """Return a new record or the one redelivery authorized by a live decision."""

        async with self._lock:
            if self.phase == LiveSourceSessionPhase.CURRENT and self._redelivery_available:
                self._redelivery_available = False
                return self._member_from_current()
            self._require_phase(LiveSourceSessionPhase.READY)
            return await self._next_member_locked()

    async def _next_member_locked(self) -> LiveSourceMember | None:
        if self._projected_entries is None:
            self._projected_entries, skipped_entries = await self.reader.extraction_entries()
            if self.selected_member_roots is not None:
                unmatched_roots = [
                    root
                    for root in self.selected_member_roots
                    if not any(entry.path == root or entry.path.startswith(f"{root}/") for entry in self._projected_entries)
                ]
                if unmatched_roots:
                    raise ArchiveFormatError("Archive member selection does not match the archive contents")
                self._projected_entries = tuple(
                    entry
                    for entry in self._projected_entries
                    if any(entry.path == root or entry.path.startswith(f"{root}/") for root in self.selected_member_roots)
                )
            for _ in range(skipped_entries):
                self.aggregate.record("skipped")
        while True:
            if self._projected_entry_index >= len(self._projected_entries):
                self.phase = LiveSourceSessionPhase.COMPLETED
                return None
            entry = self._projected_entries[self._projected_entry_index]
            self._projected_entry_index += 1
            outcome = self._source_only_outcome(entry)
            if outcome is not None:
                self.finalize_source_outcome(entry, outcome)
                continue
            try:
                validated_entry = await self.reader.validate_entry(entry)
            except ArchiveFormatError:
                self.finalize_source_outcome(entry, "failed")
                continue
            delivery_sequence = self._next_delivery_sequence
            self._next_delivery_sequence += 1
            self._current = _CurrentEntry(entry, validated_entry, delivery_sequence, collision_policy=self._collision_policy)
            self._redelivery_available = False
            self.phase = LiveSourceSessionPhase.CURRENT
            return self._member_from_current()

    def _member_from_current(self) -> LiveSourceMember:
        current = self._current
        if current is None:
            raise LiveSourceSessionError("Archive source member is unavailable")
        entry = current.entry
        return LiveSourceMember(
            self.source_session_id,
            current.delivery_sequence,
            entry.path,
            entry.is_directory,
            entry.uncompressed_size,
            entry.modified_at,
            current.target_path,
            current.collision_policy,
        )

    def finalize_source_outcome(self, entry: ZipEntry, outcome: Literal["skipped", "failed"]) -> None:
        """Record one known pre-transfer rejection without allocating a delivery."""

        if self.phase != LiveSourceSessionPhase.READY or self._current is not None:
            raise LiveSourceSessionError("Source-only outcome is not valid for the current session state")
        self.aggregate.record(outcome)
        if outcome == "skipped":
            if entry.encrypted:
                self.aggregate.encrypted_members_skipped = _checked_add(self.aggregate.encrypted_members_skipped, 1)
            elif entry.compression_method not in {0, 8, 12}:
                self.aggregate.unsupported_compression_members_skipped = _checked_add(
                    self.aggregate.unsupported_compression_members_skipped, 1
                )

    async def stream_current_member(
        self,
        source_session_id: str,
        delivery_sequence: int,
        *,
        on_chunk: Callable[[], None] | None = None,
    ) -> AsyncIterator[bytes]:
        """Stream the current regular member and enable result acceptance at clean EOF."""

        async with self._lock:
            current = self._current_for_delivery(source_session_id, delivery_sequence)
            if self.phase != LiveSourceSessionPhase.CURRENT or current.entry.is_directory:
                raise LiveSourceSessionError("Current archive member is not available for streaming")
            self.phase = LiveSourceSessionPhase.STREAMING_CURRENT
            self._streaming = True
            self._stream_finished.clear()
            validated_entry = current.validated_entry
        completed = False
        try:
            async for chunk in self.reader.stream_validated_entry(validated_entry):
                if self._cancellation_requested.is_set():
                    raise LiveSourceSessionCancelled()
                if on_chunk is not None:
                    on_chunk()
                yield chunk
                if self._cancellation_requested.is_set():
                    raise LiveSourceSessionCancelled()
        except LiveSourceSessionCancelled:
            raise
        except ArchiveFormatError as error:
            async with self._lock:
                if self.phase == LiveSourceSessionPhase.STREAMING_CURRENT:
                    self._await_decision("member_error", current.entry.path, None, str(error))
            raise
        else:
            async with self._lock:
                if self.phase != LiveSourceSessionPhase.STREAMING_CURRENT:
                    raise LiveSourceSessionError("Archive member stream was interrupted")
                self.phase = LiveSourceSessionPhase.AWAITING_RESULT
                completed = True
        finally:
            async with self._lock:
                self._streaming = False
                self._stream_finished.set()
                if not completed and self.phase == LiveSourceSessionPhase.STREAMING_CURRENT:
                    if self._cancellation_requested.is_set():
                        self.phase = LiveSourceSessionPhase.CANCELLED
                    else:
                        self.phase = LiveSourceSessionPhase.FAILED

    async def mark_directory_delivery_ready(self, source_session_id: str, delivery_sequence: int) -> None:
        """Mark a current directory ready for its destination result."""

        async with self._lock:
            current = self._current_for_delivery(source_session_id, delivery_sequence)
            if self.phase != LiveSourceSessionPhase.CURRENT or not current.entry.is_directory:
                raise LiveSourceSessionError("Current archive member is not a directory delivery")
            self.phase = LiveSourceSessionPhase.AWAITING_RESULT

    async def apply_destination_write_result(self, result: DestinationWriteResult) -> None:
        """Accept one known destination result after source validation completed."""

        async with self._lock:
            current = self._current_for_delivery(result.source_session_id, result.delivery_sequence)
            if result.member_path != current.entry.path:
                raise LiveSourceSessionError("Destination result member does not match the current source record")
            if result.status in {"awaiting_collision", "awaiting_retry"}:
                pre_stream_collision = result.status == "awaiting_collision" and self.phase == LiveSourceSessionPhase.CURRENT
                if self.phase != LiveSourceSessionPhase.AWAITING_RESULT and not pre_stream_collision:
                    raise LiveSourceSessionError("Archive source is not awaiting a destination result")
                decision_kind: Literal["collision", "member_error"] = (
                    "collision" if result.status == "awaiting_collision" else "member_error"
                )
                self._await_decision(
                    decision_kind,
                    current.entry.path,
                    result.target_path,
                    result.message,
                    source_size=current.entry.uncompressed_size,
                    source_modified_at=current.entry.modified_at,
                    target_size=result.target_size,
                    target_modified_at=result.target_modified_at,
                )
                return
            pre_stream_skip = result.status in {"skipped", "ignored"} and not current.entry.is_directory
            if self.phase != LiveSourceSessionPhase.AWAITING_RESULT and not (
                pre_stream_skip and self.phase == LiveSourceSessionPhase.CURRENT
            ):
                raise LiveSourceSessionError("Archive source is not awaiting a destination result")
            if result.status == "fatal":
                self.aggregate.record("failed")
                self._current = None
                self._redelivery_available = False
                self.phase = LiveSourceSessionPhase.FAILED
                return
            if result.status == "directory":
                if not current.entry.is_directory:
                    raise LiveSourceSessionError("Destination result member type is invalid")
            elif result.status == "extracted":
                if current.entry.is_directory or result.extracted_bytes != current.entry.uncompressed_size:
                    raise LiveSourceSessionError("Destination result byte count is invalid")
            elif result.status in {"skipped", "ignored"}:
                pass
            else:
                raise LiveSourceSessionError("Destination result status is invalid")
            self.aggregate.record(
                result.status,
                extracted_bytes=result.extracted_bytes,
                directories_created=result.directories_created,
                replaced=result.replaced,
            )
            self._current = None
            self._redelivery_available = False
            self.phase = LiveSourceSessionPhase.READY

    async def resolve_decision(
        self,
        source_session_id: str,
        delivery_sequence: int,
        decision_revision: int,
        action: Literal["skip", "skip_all", "replace", "replace_all", "replace_older", "rename", "retry", "ignore"],
        target_path: str | None = None,
    ) -> LiveSourceMember | None:
        """Finalize or redeliver the one retained record after a live decision."""

        async with self._lock:
            current = self._current_for_delivery(source_session_id, delivery_sequence)
            decision = self._pending_decision
            if self.phase != LiveSourceSessionPhase.AWAITING_DECISION or decision is None:
                raise LiveSourceSessionError("Archive source session is not awaiting a decision")
            if decision.revision != decision_revision:
                raise LiveSourceSessionError("Archive source decision revision does not match the current member")
            collision_actions = {"skip", "skip_all", "replace", "replace_all", "replace_older", "rename"}
            member_error_actions = {"retry", "ignore"}
            if decision.kind == "collision":
                if action not in collision_actions:
                    raise LiveSourceSessionError("Archive collision decision is not valid for the current member")
            elif action not in member_error_actions:
                raise LiveSourceSessionError("Archive member error decision is not valid for the current member")
            if action in {"skip", "skip_all", "ignore"}:
                if action == "skip_all":
                    self._collision_policy = action
                self.aggregate.record("ignored" if action == "ignore" else "skipped")
                self._current = None
                self._redelivery_available = False
                self._pending_decision = None
                self.phase = LiveSourceSessionPhase.READY
                return None
            if action in {"replace_all", "replace_older"}:
                self._collision_policy = action
                current.collision_policy = action
            elif action == "replace":
                current.collision_policy = action
            if action == "rename":
                if decision.kind != "collision" or not target_path:
                    raise LiveSourceSessionError("Archive rename decision requires a current collision target")
                current.target_path = target_path
            current.delivery_sequence = self._next_delivery_sequence
            self._next_delivery_sequence += 1
            self._pending_decision = None
            self.phase = LiveSourceSessionPhase.CURRENT
            self._redelivery_available = True
            return self._member_from_current()

    async def destination_outcome_unknown(self, source_session_id: str, delivery_sequence: int) -> None:
        """Fence the session after a dispatched write has no trustworthy result."""

        async with self._lock:
            self._current_for_delivery(source_session_id, delivery_sequence)
            if self.phase not in {
                LiveSourceSessionPhase.CURRENT,
                LiveSourceSessionPhase.STREAMING_CURRENT,
                LiveSourceSessionPhase.AWAITING_RESULT,
            }:
                raise LiveSourceSessionError("Archive source has no dispatched destination write")
            self.phase = LiveSourceSessionPhase.FAILED

    async def cancel(self) -> None:
        """Fence future transitions without creating a member outcome."""

        self._cancellation_requested.set()
        async with self._lock:
            if not self.phase.is_terminal:
                self.phase = LiveSourceSessionPhase.CANCELLED

    async def close(self) -> None:
        """Close the retained archive handle after the owning session ends."""

        async with self._close_lock:
            if self._closed:
                return
            await self.cancel()
            async with self._lock:
                streaming = self._streaming
            if streaming:
                await self._stream_finished.wait()
            await self.reader.close()
            self._closed = True

    def cancellation_requested(self) -> bool:
        """Return whether an external cancellation fence has been requested."""

        return self._cancellation_requested.is_set()

    async def pending_decision(self) -> LiveSourcePendingDecision | None:
        """Return the active bounded decision without exposing prior member state."""

        async with self._lock:
            return self._pending_decision

    async def current_member(self) -> LiveSourceMember | None:
        """Return only the current delivery metadata while a record is live."""

        async with self._lock:
            if self._current is None or self.phase.is_terminal:
                return None
            entry = self._current.entry
            return LiveSourceMember(
                self.source_session_id,
                self._current.delivery_sequence,
                entry.path,
                entry.is_directory,
                entry.uncompressed_size,
                entry.modified_at,
                self._current.target_path,
                self._current.collision_policy,
            )

    def _current_for_delivery(self, source_session_id: str, delivery_sequence: int) -> _CurrentEntry:
        if source_session_id != self.source_session_id:
            raise LiveSourceSessionError("Archive source session does not match the current operation")
        if self.phase.is_terminal or self._current is None or delivery_sequence != self._current.delivery_sequence:
            raise LiveSourceSessionError("Archive delivery sequence does not match the current member")
        return self._current

    @staticmethod
    def _source_only_outcome(entry: ZipEntry) -> Literal["skipped", "failed"] | None:
        if not entry.is_safe or not entry.has_supported_file_type:
            return "failed"
        if entry.encrypted or entry.compression_method not in {0, 8, 12}:
            return "skipped"
        return None

    def _require_phase(self, phase: LiveSourceSessionPhase) -> None:
        if self.phase != phase:
            raise LiveSourceSessionError("Archive source session is not ready for the requested transition")

    def _await_decision(
        self,
        kind: Literal["collision", "member_error"],
        member_path: str,
        target_path: str | None,
        message: str | None,
        *,
        source_size: int | None = None,
        source_modified_at: datetime | None = None,
        target_size: int | None = None,
        target_modified_at: datetime | None = None,
    ) -> None:
        if message is not None and (not message or len(message) > 500):
            raise LiveSourceSessionError("Archive decision message is invalid")
        if kind == "collision" and target_path is None:
            raise LiveSourceSessionError("Archive collision target is unavailable")
        self._pending_decision = LiveSourcePendingDecision(
            self._next_decision_revision,
            kind,
            member_path,
            target_path,
            message,
            source_size,
            source_modified_at,
            target_size,
            target_modified_at,
        )
        self._next_decision_revision += 1
        self.phase = LiveSourceSessionPhase.AWAITING_DECISION


def _checked_add(value: int, increment: int) -> int:
    if type(value) is not int or type(increment) is not int or value < 0 or increment < 0 or value > _MAX_AGGREGATE_COUNTER - increment:
        raise LiveSourceSessionError("Archive aggregate counter exceeds its supported range")
    return value + increment


class LiveSourceSessionRegistry:
    """Process-local registry for retained ZIP source sessions."""

    def __init__(self) -> None:
        self._sessions: dict[str, LiveSourceSession] = {}
        self._operation_sessions: dict[object, str] = {}
        self._lock = asyncio.Lock()

    async def open(
        self,
        reader: RandomAccessReader,
        size: int,
        *,
        operation_id: object | None = None,
        selected_member_roots: tuple[str, ...] | None = None,
    ) -> LiveSourceSession:
        session = LiveSourceSession(ZipReader(reader, size), selected_member_roots)
        async with self._lock:
            if operation_id is not None and operation_id in self._operation_sessions:
                raise LiveSourceSessionError("Archive operation already has a live source session")
            self._sessions[session.source_session_id] = session
            if operation_id is not None:
                self._operation_sessions[operation_id] = session.source_session_id
        return session

    async def get(self, source_session_id: str) -> LiveSourceSession:
        async with self._lock:
            session = self._sessions.get(source_session_id)
        if session is None:
            raise LiveSourceSessionError("Archive source session is unavailable")
        return session

    async def get_for_operation(self, operation_id: object) -> LiveSourceSession:
        async with self._lock:
            source_session_id = self._operation_sessions.get(operation_id)
            session = self._sessions.get(source_session_id) if source_session_id is not None else None
        if session is None:
            raise LiveSourceSessionError("Archive source session is unavailable")
        return session

    async def remove(self, source_session_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(source_session_id, None)
            for operation_id, registered_session_id in tuple(self._operation_sessions.items()):
                if registered_session_id == source_session_id:
                    del self._operation_sessions[operation_id]
        if session is not None:
            await session.close()

    async def remove_for_operation(self, operation_id: object) -> None:
        async with self._lock:
            source_session_id = self._operation_sessions.get(operation_id)
        if source_session_id is not None:
            await self.remove(source_session_id)

    async def close_all(self) -> None:
        async with self._lock:
            session_ids = tuple(self._sessions)
        for source_session_id in session_ids:
            await self.remove(source_session_id)
