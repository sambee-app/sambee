"""Same-executor direct ZIP extraction without archive or member staging."""

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, cast

from app.models.file import FileInfo, FileType
from app.services.archive.live_extraction import (
    DestinationWriteResult,
    LiveExtractionAggregate,
    LiveSourceSession,
    LiveSourceSessionCancelled,
)
from app.services.archive.target_write import (
    TargetWriteDisposition,
    TargetWriteFailure,
    collision_policy_from_action,
    resolve_target_write_attempt,
)
from app.services.archive.zip_reader import ArchiveFormatError, ArchiveSourceUnavailableError, ZipReader
from app.storage.base import RandomAccessReader


class ArchiveExtractionSource(Protocol):
    """Supply validated archive metadata and random-access ZIP bytes."""

    async def get_file_info(self, path: str) -> FileInfo: ...

    async def open_archive_source_reader(self, path: str) -> RandomAccessReader: ...


class ArchiveExtractionDestination(Protocol):
    """Inspect and write direct extraction output paths."""

    async def get_file_info(self, path: str) -> FileInfo: ...

    async def create_directory(self, path: str) -> None: ...

    async def write_file_from_stream(
        self,
        path: str,
        stream: AsyncIterator[bytes],
        *,
        overwrite: bool = False,
        source_mtime: datetime | None = None,
    ) -> int: ...


class ArchiveExtractionCancelled(Exception):
    """Raised when extraction is cancelled between bounded member chunks."""


@dataclass
class ArchiveExtractionMemberError(Exception):
    """A direct output failure that can be retried or ignored for one member."""

    member_path: str
    target_path: str
    message: str
    partial_output: bool = False


@dataclass(frozen=True)
class ArchiveExtractionConflict:
    member_path: str
    target_path: str
    is_directory: bool = False
    source_size: int | None = None
    source_modified_at: datetime | str | None = None
    target_size: int | None = None
    target_modified_at: datetime | None = None


class ArchiveExtractionConflicts(Exception):
    """Raised before direct writes when regular-file target collisions exist."""

    def __init__(self, conflicts: list[ArchiveExtractionConflict]) -> None:
        self.conflicts = conflicts
        super().__init__("Archive extraction requires a decision for existing destination files")


MAX_LATE_EXISTENCE_RETRIES = 1


async def extract_live_archive_to_new_paths(
    source_session: LiveSourceSession,
    *,
    destination: ArchiveExtractionDestination,
    destination_root: str,
    existing_file_policy: str | None,
    is_cancelled: Callable[[], Awaitable[bool]] | None = None,
    on_chunk: Callable[[], None] | None = None,
) -> LiveExtractionAggregate:
    """Extract in central-directory order without a manifest or member ledger.

    A caller retaining ``source_session`` owns collision and retry decisions. This
    loop returns when the reader reaches end-of-directory or when a current member
    has entered the normal live decision state.
    """

    try:
        collision_policy_from_action(existing_file_policy)
    except ValueError as exc:
        raise ArchiveFormatError("Archive extraction collision policy is invalid") from exc
    while True:
        if is_cancelled is not None and await is_cancelled():
            await source_session.cancel()
            raise ArchiveExtractionCancelled("Archive extraction was cancelled")
        member = await source_session.current_member()
        if member is None:
            member = await source_session.next_member()
        if member is None:
            return source_session.aggregate
        target_path = member.target_path or _target_path(destination_root, source_session.relative_member_path(member.path))
        directories_created = 0
        try:
            if member.is_directory:
                directories_created = await _ensure_live_directory(destination, target_path)
                await source_session.mark_directory_delivery_ready(member.source_session_id, member.delivery_sequence)
                await source_session.apply_destination_write_result(
                    DestinationWriteResult(
                        member.source_session_id,
                        member.delivery_sequence,
                        member.path,
                        "directory",
                        directories_created=directories_created,
                    )
                )
                continue
            parent = target_path.rpartition("/")[0]
            if parent:
                directories_created = await _ensure_live_directory(destination, parent)
            target_write = await resolve_target_write_attempt(
                target_path=target_path,
                policy=collision_policy_from_action(member.collision_policy or existing_file_policy),
                source_modified_at=member.modified_at,
                observe_target=destination.get_file_info,
                stream_factory=lambda: source_session.stream_current_member(
                    member.source_session_id,
                    member.delivery_sequence,
                    on_chunk=on_chunk,
                ),
                write_target=lambda path, stream, overwrite, mtime: destination.write_file_from_stream(
                    path, stream, overwrite=overwrite, source_mtime=mtime
                ),
            )
        except LiveSourceSessionCancelled as error:
            raise ArchiveExtractionCancelled("Archive extraction was cancelled") from error
        except ArchiveExtractionConflicts as error:
            await source_session.apply_destination_write_result(
                DestinationWriteResult(
                    member.source_session_id,
                    member.delivery_sequence,
                    member.path,
                    "awaiting_collision",
                    target_path=error.conflicts[0].target_path,
                    target_size=error.conflicts[0].target_size,
                    target_modified_at=error.conflicts[0].target_modified_at,
                )
            )
            return source_session.aggregate
        except ArchiveSourceUnavailableError:
            raise
        except ArchiveFormatError as error:
            if await source_session.pending_decision() is not None:
                return source_session.aggregate
            await source_session.destination_outcome_unknown(member.source_session_id, member.delivery_sequence)
            raise ArchiveExtractionMemberError(member.path, target_path, str(error), partial_output=True) from error
        except Exception as error:
            if isinstance(error, ArchiveExtractionCancelled):
                raise
            if source_session.cancellation_requested():
                raise ArchiveExtractionCancelled("Archive extraction was cancelled") from error
            partial_output = isinstance(error, TargetWriteFailure) and error.output_may_exist
            await source_session.destination_outcome_unknown(member.source_session_id, member.delivery_sequence)
            raise ArchiveExtractionMemberError(member.path, target_path, str(error), partial_output=partial_output) from error
        if target_write.disposition == TargetWriteDisposition.AWAIT_COLLISION:
            await source_session.apply_destination_write_result(
                DestinationWriteResult(
                    member.source_session_id,
                    member.delivery_sequence,
                    member.path,
                    "awaiting_collision",
                    directories_created=directories_created,
                    target_path=target_path,
                    target_size=target_write.target.size if target_write.target is not None else None,
                    target_modified_at=target_write.target.modified_at if target_write.target is not None else None,
                )
            )
            return source_session.aggregate
        if target_write.disposition == TargetWriteDisposition.SKIP:
            await source_session.apply_destination_write_result(
                DestinationWriteResult(
                    member.source_session_id,
                    member.delivery_sequence,
                    member.path,
                    "skipped",
                    directories_created=directories_created,
                )
            )
            continue
        if target_write.bytes_written != member.uncompressed_size:
            await source_session.destination_outcome_unknown(member.source_session_id, member.delivery_sequence)
            raise ArchiveExtractionMemberError(
                member.path,
                target_path,
                "Archive extraction output size does not match member metadata",
                partial_output=True,
            )
        await source_session.apply_destination_write_result(
            DestinationWriteResult(
                member.source_session_id,
                member.delivery_sequence,
                member.path,
                "extracted",
                extracted_bytes=target_write.bytes_written,
                directories_created=directories_created,
                replaced=target_write.replaced,
            )
        )


async def _ensure_live_directory(destination: ArchiveExtractionDestination, path: str) -> int:
    """Create a target directory chain and return only directories created now."""

    created = 0
    current = ""
    for segment in path.split("/"):
        current = f"{current}/{segment}" if current else segment
        try:
            await destination.create_directory(current)
        except FileExistsError:
            info = await destination.get_file_info(current)
            if info.type != FileType.DIRECTORY:
                raise ArchiveExtractionConflicts(
                    [
                        ArchiveExtractionConflict(
                            path,
                            current,
                            is_directory=True,
                            target_size=info.size,
                            target_modified_at=info.modified_at,
                        )
                    ]
                )
        else:
            created += 1
    return created


def _target_path(destination_root: str, member_path: str) -> str:
    root = destination_root.replace("\\", "/").strip("/")
    return f"{root}/{member_path}" if root else member_path


def archive_extraction_target_path(destination_root: str, member_path: str) -> str:
    """Build one safe destination target for the current live member only."""

    return _target_path(destination_root, _normalized_relative_path(member_path))


def _normalized_relative_path(path: str) -> str:
    normalized = path.replace("\\", "/")
    if not normalized or normalized.startswith("/") or "\x00" in normalized:
        raise ArchiveFormatError("Archive extraction rename target must be a safe relative path")
    segments = normalized.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ArchiveFormatError("Archive extraction rename target must be a safe relative path")
    return normalized


async def extract_archive_to_new_paths(
    source: ArchiveExtractionSource,
    *,
    destination: ArchiveExtractionDestination | None = None,
    archive_path: str,
    destination_root: str,
    existing_file_policy: str | None = None,
    is_cancelled: Callable[[], Awaitable[bool]] | None = None,
) -> LiveExtractionAggregate:
    """Extract through one retained source session without archive-wide state."""

    if destination is None:
        destination = cast(ArchiveExtractionDestination, source)
    archive_info = await source.get_file_info(archive_path)
    if archive_info.type != FileType.FILE or archive_info.size is None:
        raise ArchiveFormatError("Archive extraction source must be a regular file")
    random_reader = await source.open_archive_source_reader(archive_path)
    source_session = LiveSourceSession(ZipReader(random_reader, archive_info.size))
    try:
        aggregate = await extract_live_archive_to_new_paths(
            source_session,
            destination=destination,
            destination_root=destination_root,
            existing_file_policy=existing_file_policy,
            is_cancelled=is_cancelled,
        )
        return aggregate
    finally:
        await source_session.close()
