"""Cross-connection file copy/move operations.

Orchestrates copying files between two different SMB connections by
streaming data through the backend: source ``read_file()`` → destination
``write_file_from_stream()``.

Design decisions
----------------
* **No overall timeout** — individual chunk reads/writes each have their
  own timeouts, so arbitrarily large files transfer without hitting a
  wall-clock limit.
* **Move source safety** — a target is committed before a move source is
    considered for deletion; source deletion remains unavailable without an
    identity-guarded primitive.
* **Progress callback** — the caller supplies an ``on_progress`` callback
  that receives byte-level updates for UI progress reporting.
"""

import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from dataclasses import dataclass
from typing import Optional

from app.models.file import FileInfo, FileType
from app.services.content_transfer import (
    RegularFileSourceSnapshot,
    SourceChangedError,
    SourceDeleteError,
    SourceDeletionOutcomeUnknown,
    TargetCollisionError,
    resolve_regular_file_transfer,
)
from app.services.target_resolution import TargetResolutionDisposition, TargetResolutionPolicy, TargetSnapshot, resolve_target_mutation
from app.storage.base import MoveSourceReader, ProgressCallback, StorageBackend

logger = logging.getLogger(__name__)


class RegularFileTransferRequiredError(ValueError):
    """Raised when a legacy item transfer request attempts to copy a directory."""


class TransferCancelled(RuntimeError):
    """Raised when an active copy or move is cancelled before publication."""


@dataclass(frozen=True)
class CrossConnectionTransferResult:
    """Cross-SMB outcome that remains compatible with legacy two-value unpacking."""

    bytes_written: int | None
    source_info: FileInfo
    replaced: bool = False

    def __iter__(self) -> Iterator[int | None | FileInfo]:
        yield self.bytes_written
        yield self.source_info


def _raise_if_cancelled(cancellation: Callable[[], bool] | None) -> None:
    if cancellation is not None and cancellation():
        raise TransferCancelled("Transfer cancelled before destination publication")


def final_target_policy_check(
    *,
    source: FileInfo,
    dest: StorageBackend,
    dest_path: str,
    policy: TargetResolutionPolicy,
    expected_disposition: TargetResolutionDisposition,
    before_destination_commit: Callable[[], Awaitable[None]] | None,
) -> Callable[[], Awaitable[None]]:
    """Return a commit hook that rejects a stage when target policy changed."""

    async def check() -> None:
        if before_destination_commit is not None:
            await before_destination_commit()
        try:
            target = await dest.get_file_info(dest_path)
        except FileNotFoundError:
            target = None
        disposition = resolve_target_mutation(
            policy,
            source.modified_at,
            TargetSnapshot.missing() if target is None else TargetSnapshot.from_file_info(target),
        )
        if disposition != expected_disposition:
            raise FileExistsError(f"Destination changed while staging: {dest_path}")

    return check


async def cross_connection_copy(
    source: StorageBackend,
    dest: StorageBackend,
    source_path: str,
    dest_path: str,
    on_progress: ProgressCallback | None = None,
    before_destination_commit: Callable[[], Awaitable[None]] | None = None,
    cancellation: Callable[[], bool] | None = None,
    *,
    overwrite: bool = False,
    target_resolution_policy: TargetResolutionPolicy | None = None,
) -> CrossConnectionTransferResult:
    """Copy one regular file from one connection to another.

    For files, data is streamed chunk-by-chunk through the backend so
    memory usage stays constant regardless of file size.

    Args:
        source: The storage backend to read from.
        dest: The storage backend to write to.
        source_path: Relative path on the source share.
        dest_path: Relative path on the destination share
            (full path including the final name).
        on_progress: Optional callback invoked after every chunk write
            with ``(bytes_transferred_so_far, total_bytes_or_none)``.
        overwrite: When ``True``, replace existing destinations.

    Returns:
        Total number of bytes transferred.

    Raises:
        FileNotFoundError: If the source path does not exist.
        FileExistsError: If the destination path already exists
            and *overwrite* is ``False``.
        OSError: On any I/O failure during the transfer.
    """

    _raise_if_cancelled(cancellation)
    info = await source.get_file_info(source_path)
    if info.type != FileType.FILE:
        raise RegularFileTransferRequiredError("Directory transfers must be coordinated by the client")

    source_snapshot = RegularFileSourceSnapshot.from_file_info(info)
    if target_resolution_policy is not None:

        async def copy_attempt(disposition: TargetResolutionDisposition) -> int:
            return await _copy_file(
                source,
                dest,
                source_path,
                dest_path,
                on_progress,
                before_destination_commit=final_target_policy_check(
                    source=info,
                    dest=dest,
                    dest_path=dest_path,
                    policy=target_resolution_policy,
                    expected_disposition=disposition,
                    before_destination_commit=before_destination_commit,
                ),
                cancellation=cancellation,
                source_info=info,
                source_snapshot=source_snapshot,
                overwrite=disposition == TargetResolutionDisposition.REPLACE_EXISTING,
            )

        resolution = await resolve_regular_file_transfer(
            source=info,
            target_path=dest_path,
            policy=target_resolution_policy,
            observe_target=lambda: dest.get_file_info(dest_path),
            attempt_create=copy_attempt,
            replacement_supported=True,
        )
        if resolution.disposition == TargetResolutionDisposition.SKIP:
            return CrossConnectionTransferResult(None, info)
        if resolution.disposition == TargetResolutionDisposition.AWAIT_COLLISION:
            raise TargetCollisionError(source=info, target=resolution.target)
        if not isinstance(resolution.mutation_result, int):
            raise RuntimeError("Regular-file transfer committed without reporting bytes written")
        bytes_written = resolution.mutation_result
        replaced = resolution.replaced
    else:
        bytes_written = await _copy_file(
            source,
            dest,
            source_path,
            dest_path,
            on_progress,
            before_destination_commit=before_destination_commit,
            cancellation=cancellation,
            source_info=info,
            source_snapshot=source_snapshot,
            overwrite=overwrite,
        )
        replaced = overwrite

    await _verify_published_copy_source(source, source_path, source_snapshot, replaced=replaced)
    return CrossConnectionTransferResult(bytes_written, info, replaced=replaced)


async def copy_regular_file_to_missing_target(
    source: StorageBackend,
    dest: StorageBackend,
    source_path: str,
    dest_path: str,
    source_info: FileInfo,
    on_progress: ProgressCallback | None = None,
    cancellation: Callable[[], bool] | None = None,
    *,
    overwrite: bool = False,
    target_resolution_policy: TargetResolutionPolicy | None = None,
    expected_disposition: TargetResolutionDisposition | None = None,
) -> int:
    """Copy one already-observed regular source through a staged missing-target commit."""

    source_snapshot = RegularFileSourceSnapshot.from_file_info(source_info)
    if (target_resolution_policy is None) != (expected_disposition is None):
        raise ValueError("Target policy and expected disposition must be provided together")
    before_destination_commit = (
        final_target_policy_check(
            source=source_info,
            dest=dest,
            dest_path=dest_path,
            policy=target_resolution_policy,
            expected_disposition=expected_disposition,
            before_destination_commit=None,
        )
        if target_resolution_policy is not None and expected_disposition is not None
        else None
    )
    bytes_written = await _copy_file(
        source,
        dest,
        source_path,
        dest_path,
        on_progress,
        before_destination_commit=before_destination_commit,
        cancellation=cancellation,
        source_info=source_info,
        source_snapshot=source_snapshot,
        overwrite=overwrite,
    )
    await _verify_published_copy_source(source, source_path, source_snapshot, replaced=overwrite)
    return bytes_written


async def _verify_published_copy_source(
    source: StorageBackend, source_path: str, snapshot: RegularFileSourceSnapshot, *, replaced: bool
) -> None:
    """Keep publication facts when post-copy source validation cannot succeed."""

    try:
        current = await source.get_file_info(source_path)
    except Exception as error:
        raise SourceChangedError(
            f"Source could not be validated after destination publication: {source_path}",
            destination_mutated=True,
            replaced=replaced,
        ) from error
    if not snapshot.matches(current):
        raise SourceChangedError(f"Source changed while copying: {source_path}", destination_mutated=True, replaced=replaced)


async def cross_connection_move(
    source: StorageBackend,
    dest: StorageBackend,
    source_path: str,
    dest_path: str,
    on_progress: ProgressCallback | None = None,
    before_destination_commit: Callable[[], Awaitable[None]] | None = None,
    cancellation: Callable[[], bool] | None = None,
    *,
    overwrite: bool = False,
    target_resolution_policy: TargetResolutionPolicy | None = None,
) -> CrossConnectionTransferResult:
    """Move one regular file across connections (copy + delete).

    Copies the item to the destination first, then deletes the source.
    If the copy succeeds but the delete fails, an error is logged but
    the successfully-copied data is *not* rolled back (safer than data
    loss).

    Args:
        source: The storage backend to read from (and delete after).
        dest: The storage backend to write to.
        source_path: Relative path on the source share.
        dest_path: Relative path on the destination share.
        on_progress: Optional progress callback (see ``cross_connection_copy``).
        overwrite: When ``True``, replace existing destinations.

    Returns:
        Total number of bytes transferred.

    Raises:
        FileNotFoundError: If the source path does not exist.
        FileExistsError: If the destination already exists
            and *overwrite* is ``False``.
        OSError: On transfer failure.
    """

    _raise_if_cancelled(cancellation)
    source_info = await source.get_file_info(source_path)
    if source_info.type != FileType.FILE:
        raise RegularFileTransferRequiredError("Directory transfers must be coordinated by the client")
    source_snapshot = RegularFileSourceSnapshot.from_file_info(source_info)
    try:
        source_reader = await source.open_move_source_reader(source_path)
    except NotImplementedError as error:
        transfer_result = await cross_connection_copy(
            source,
            dest,
            source_path,
            dest_path,
            on_progress,
            cancellation=cancellation,
            overwrite=overwrite,
            target_resolution_policy=target_resolution_policy,
        )
        if transfer_result.bytes_written is None:
            return transfer_result
        raise SourceDeleteError(
            f"Destination was committed but guarded source deletion is unavailable: {source_path}",
            destination_mutated=True,
            replaced=transfer_result.replaced,
        ) from error

    try:
        if target_resolution_policy is not None:

            async def copy_attempt(disposition: TargetResolutionDisposition) -> int:
                return await _copy_file(
                    source,
                    dest,
                    source_path,
                    dest_path,
                    on_progress,
                    before_destination_commit=final_target_policy_check(
                        source=source_info,
                        dest=dest,
                        dest_path=dest_path,
                        policy=target_resolution_policy,
                        expected_disposition=disposition,
                        before_destination_commit=before_destination_commit,
                    ),
                    cancellation=cancellation,
                    source_info=source_info,
                    source_snapshot=source_snapshot,
                    source_reader=source_reader,
                    overwrite=disposition == TargetResolutionDisposition.REPLACE_EXISTING,
                )

            resolution = await resolve_regular_file_transfer(
                source=source_info,
                target_path=dest_path,
                policy=target_resolution_policy,
                observe_target=lambda: dest.get_file_info(dest_path),
                attempt_create=copy_attempt,
                replacement_supported=True,
            )
            if resolution.disposition == TargetResolutionDisposition.SKIP:
                return CrossConnectionTransferResult(None, source_info)
            if resolution.disposition == TargetResolutionDisposition.AWAIT_COLLISION:
                raise TargetCollisionError(source=source_info, target=resolution.target)
            if not isinstance(resolution.mutation_result, int):
                raise RuntimeError("Regular-file move committed without reporting bytes written")
            total_bytes = resolution.mutation_result
            replaced = resolution.replaced
        else:
            total_bytes = await _copy_file(
                source,
                dest,
                source_path,
                dest_path,
                on_progress,
                before_destination_commit=before_destination_commit,
                cancellation=cancellation,
                source_info=source_info,
                source_snapshot=source_snapshot,
                source_reader=source_reader,
                overwrite=overwrite,
            )
            replaced = overwrite
        if cancellation is not None and cancellation():
            raise SourceDeleteError(
                f"Move cancelled after destination publication; source retained: {source_path}",
                destination_mutated=True,
                replaced=replaced,
            )
        try:
            await source_reader.commit_delete(cancellation=cancellation)
        except SourceDeleteError as error:
            error.replaced = replaced
            raise
        except SourceDeletionOutcomeUnknown as error:
            error.replaced = replaced
            raise
        except Exception as error:
            raise SourceDeletionOutcomeUnknown(
                f"Guarded source deletion may have completed before its result was observed: {source_path}",
                replaced=replaced,
            ) from error
        return CrossConnectionTransferResult(total_bytes, source_info, replaced=replaced)
    finally:
        try:
            await source_reader.close()
        except Exception:
            logger.warning("SMB move source cleanup failed: source=%s destination=%s", source_path, dest_path, exc_info=True)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _copy_file(
    source: StorageBackend,
    dest: StorageBackend,
    source_path: str,
    dest_path: str,
    on_progress: ProgressCallback | None,
    *,
    before_destination_commit: Callable[[], Awaitable[None]] | None = None,
    cancellation: Callable[[], bool] | None = None,
    source_info: FileInfo | None = None,
    source_snapshot: RegularFileSourceSnapshot | None = None,
    source_reader: MoveSourceReader | None = None,
    overwrite: bool = False,
) -> int:
    """Stream a single file from *source* to *dest*.

    When *source_info* is supplied (e.g. from an earlier ``get_file_info``
    call), its ``size`` and ``modified_at`` fields are reused — avoiding
    extra round-trips to the source share.
    """

    # Reuse source_info when available; fall back to a dedicated call.
    if source_info is None:
        try:
            source_info = await source.get_file_info(source_path)
        except Exception:
            pass  # Non-critical; progress + mtime will degrade gracefully

    if source_snapshot is not None:
        if source_snapshot.stable_id is None:
            raise SourceChangedError(f"Source has no stable identity for transfer: {source_path}")
        current_source = await source_reader.get_file_info() if source_reader is not None else await source.get_file_info(source_path)
        if not source_snapshot.matches(current_source):
            raise SourceChangedError(f"Source changed before reading: {source_path}")

    total_size = source_info.size if source_info else None
    source_mtime = source_info.modified_at if source_info else None

    def _progress_with_total(transferred: int, _total: Optional[int]) -> None:
        if on_progress:
            on_progress(transferred, total_size)

    async def verify_source_before_commit() -> None:
        _raise_if_cancelled(cancellation)
        if source_snapshot is None:
            return
        try:
            current_source = await source_reader.get_file_info() if source_reader is not None else await source.get_file_info(source_path)
        except FileNotFoundError as error:
            raise SourceChangedError(f"Source disappeared before commit: {source_path}") from error
        if not source_snapshot.matches(current_source):
            raise SourceChangedError(f"Source changed before commit: {source_path}")
        if before_destination_commit is not None:
            await before_destination_commit()

    # A fresh reader is created only after target policy has authorized this
    # attempt. The destination owns and discards its private stage on failure.
    if source_reader is None:
        stream: AsyncIterator[bytes] = source.read_file(source_path)
    else:
        stream = _read_retained_move_source(source_reader, total_size)

    async def cancellable_stream() -> AsyncIterator[bytes]:
        async for chunk in stream:
            _raise_if_cancelled(cancellation)
            yield chunk

    bytes_written = await dest.stage_and_commit_new_file_from_stream(
        dest_path,
        cancellable_stream(),
        before_commit=verify_source_before_commit,
        on_progress=_progress_with_total,
        source_mtime=source_mtime,
        overwrite=overwrite,
    )

    logger.info(f"Cross-connection copy file: '{source_path}' -> '{dest_path}' ({bytes_written} bytes)")
    return bytes_written


async def _read_retained_move_source(source_reader: MoveSourceReader, total_size: int | None) -> AsyncIterator[bytes]:
    """Stream a retained source handle so its delete capability stays bound to copied bytes."""

    if total_size is None:
        raise SourceChangedError("Move source has no stable length")
    chunk_size = 1024 * 1024
    offset = 0
    while offset < total_size:
        chunk = await source_reader.read_at(offset, min(chunk_size, total_size - offset))
        if not chunk:
            raise SourceChangedError("Move source ended before its captured length")
        offset += len(chunk)
        yield chunk
