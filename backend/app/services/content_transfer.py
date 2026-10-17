"""Regular-file transfer target resolution.

The coordinator owns only target observation, policy reduction, and one retry
after a native create collision. Source validation, byte transfer, and move
source deletion remain in the caller that owns those resources.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TypeVar

from app.models.file import FileInfo, FileType
from app.services.target_resolution import (
    TargetResolutionDisposition,
    TargetResolutionPolicy,
    TargetSnapshot,
    resolve_target_mutation,
)

TMutationResult = TypeVar("TMutationResult")


@dataclass(frozen=True)
class RegularFileTransferResolution:
    """The final target decision and its most recent observation."""

    disposition: TargetResolutionDisposition
    target: FileInfo | None
    replaced: bool = False
    mutation_result: object | None = None


@dataclass(frozen=True)
class ContentTransferPlan:
    """Immutable policy inputs for one regular-file target mutation."""

    source: FileInfo
    target_path: str
    policy: TargetResolutionPolicy
    replacement_supported: bool

    def __post_init__(self) -> None:
        if self.source.type != FileType.FILE:
            raise ValueError("Content transfer plans require a regular-file source")


@dataclass(frozen=True)
class TargetMutationCommitted:
    """A fresh target-owned attempt committed its private stage."""

    result: object | None = None
    replaced: bool = False


@dataclass(frozen=True)
class TargetMutationTargetExistsBeforeMutation:
    """A fresh attempt lost an exclusive-create race before publication."""


TargetMutationAttempt = TargetMutationCommitted | TargetMutationTargetExistsBeforeMutation


@dataclass(frozen=True)
class RegularFileSourceSnapshot:
    """The source facts that must still match before a move delete."""

    path: str
    size: int | None
    modified_at: datetime | None
    stable_id: str | None

    @classmethod
    def from_file_info(cls, source: FileInfo) -> "RegularFileSourceSnapshot":
        if source.type != FileType.FILE:
            raise ValueError("Regular-file source snapshots require a regular file")
        return cls(source.path, source.size, source.modified_at, source.stable_id)

    def matches(self, current: FileInfo) -> bool:
        """Return whether a re-observed source is safe to treat as unchanged."""

        if current.type != FileType.FILE or current.path != self.path:
            return False
        if self.stable_id is None:
            return False
        if self.stable_id != current.stable_id:
            return False
        return self.size == current.size and _same_utc_timestamp(self.modified_at, current.modified_at)


def _same_utc_timestamp(left: datetime | None, right: datetime | None) -> bool:
    """Compare persisted and provider timestamps without SQLite timezone drift."""

    if left is None or right is None:
        return left == right
    normalized_left = left.replace(tzinfo=timezone.utc) if left.tzinfo is None else left.astimezone(timezone.utc)
    normalized_right = right.replace(tzinfo=timezone.utc) if right.tzinfo is None else right.astimezone(timezone.utc)
    return normalized_left == normalized_right


class SourceChangedError(RuntimeError):
    """Raised when a source no longer matches the plan snapshot."""

    def __init__(self, message: str, *, destination_mutated: bool = False, replaced: bool = False) -> None:
        super().__init__(message)
        self.destination_mutated = destination_mutated
        self.replaced = replaced


class SourceDeleteError(RuntimeError):
    """Raised after a destination commit when guarded source deletion fails."""

    def __init__(self, message: str, *, destination_mutated: bool, replaced: bool = False) -> None:
        super().__init__(message)
        self.destination_mutated = destination_mutated
        self.replaced = replaced


class SourceDeletionOutcomeUnknown(RuntimeError):
    """Raised when an attempted source-handle deletion has an unobservable result."""

    def __init__(self, message: str, *, replaced: bool = False) -> None:
        super().__init__(message)
        self.replaced = replaced


class TargetCollisionError(FileExistsError):
    """A refreshed target collision with the facts observed by the controller."""

    def __init__(self, *, source: FileInfo, target: FileInfo | None) -> None:
        super().__init__(f"Destination already exists: {source.path}")
        self.source = source
        self.target = target


async def resolve_target_mutation_attempt(
    *,
    plan: ContentTransferPlan,
    observe_target: Callable[[], Awaitable[FileInfo]],
    attempt_factory: Callable[[TargetResolutionDisposition], Awaitable[TargetMutationAttempt]],
) -> RegularFileTransferResolution:
    """Run up to two fresh, authorized target mutation attempts.

    Each invocation of ``attempt_factory`` must allocate a fresh target-owned
    stage and source reader. This coordinator owns only target observation and
    policy reduction; stream lifetime and source verification stay in that
    attempt factory.
    """

    for attempt_index in range(2):
        try:
            target = await observe_target()
        except FileNotFoundError:
            target = None

        disposition = resolve_target_mutation(
            plan.policy,
            plan.source.modified_at,
            TargetSnapshot.missing() if target is None else TargetSnapshot.from_file_info(target),
        )
        if disposition in {TargetResolutionDisposition.SKIP, TargetResolutionDisposition.AWAIT_COLLISION}:
            return RegularFileTransferResolution(disposition, target)
        if disposition == TargetResolutionDisposition.REPLACE_EXISTING and not plan.replacement_supported:
            return RegularFileTransferResolution(TargetResolutionDisposition.AWAIT_COLLISION, target)

        attempt = await attempt_factory(disposition)
        if isinstance(attempt, TargetMutationTargetExistsBeforeMutation):
            if attempt_index == 0:
                continue
            try:
                target = await observe_target()
            except FileNotFoundError:
                target = None
            return RegularFileTransferResolution(TargetResolutionDisposition.AWAIT_COLLISION, target)

        return RegularFileTransferResolution(
            disposition,
            target,
            replaced=attempt.replaced,
            mutation_result=attempt.result,
        )

    raise AssertionError("regular-file transfer attempts must return or raise")


async def resolve_regular_file_transfer(
    *,
    source: FileInfo,
    target_path: str,
    policy: TargetResolutionPolicy,
    observe_target: Callable[[], Awaitable[FileInfo]],
    attempt_create: Callable[[TargetResolutionDisposition], Awaitable[TMutationResult]],
    replacement_supported: bool,
) -> RegularFileTransferResolution:
    """Authorize at most two fresh create attempts for one regular file.

    An adapter that cannot prove guarded replacement must advertise
    ``replacement_supported=False``. In that case a replacement disposition is
    surfaced as a refreshed conflict without invoking the attempt factory.
    """

    async def make_fresh_attempt(disposition: TargetResolutionDisposition) -> TargetMutationAttempt:
        try:
            result = await attempt_create(disposition)
        except FileExistsError:
            return TargetMutationTargetExistsBeforeMutation()
        return TargetMutationCommitted(
            result=result,
            replaced=disposition == TargetResolutionDisposition.REPLACE_EXISTING,
        )

    return await resolve_target_mutation_attempt(
        plan=ContentTransferPlan(
            source=source,
            target_path=target_path,
            policy=policy,
            replacement_supported=replacement_supported,
        ),
        observe_target=observe_target,
        attempt_factory=make_fresh_attempt,
    )
