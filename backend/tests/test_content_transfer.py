from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from app.models.file import ContentTransferEffects, ContentTransferError, ContentTransferResult, CopyMoveRequest, FileInfo, FileType
from app.services.content_transfer import (
    ContentTransferPlan,
    RegularFileSourceSnapshot,
    SourceChangedError,
    SourceDeleteError,
    SourceDeletionOutcomeUnknown,
    TargetMutationCommitted,
    TargetMutationTargetExistsBeforeMutation,
    resolve_regular_file_transfer,
    resolve_target_mutation_attempt,
)
from app.services.cross_connection import RegularFileTransferRequiredError, TransferCancelled, cross_connection_copy, cross_connection_move
from app.services.target_resolution import TargetResolutionDisposition, TargetResolutionPolicy


def file_info(path: str, modified_at: datetime) -> FileInfo:
    return FileInfo(
        name=path.rsplit("/", 1)[-1],
        path=path,
        type=FileType.FILE,
        size=1,
        modified_at=modified_at,
        stable_id="source-id",
    )


@pytest.mark.parametrize(
    "status,source,destination,replaced",
    [
        ("outcome_unknown", "unknown", "mutated", True),
        ("outcome_unknown", "unknown", "unknown", False),
        ("outcome_unknown", "mutated", "mutated", True),
        ("failed", "unchanged", "mutated", True),
        ("cancelled", "mutated", "mutated", True),
        ("completed_with_source_retained", "mutated", "mutated", True),
        ("completed_with_source_retained", "unchanged", "unchanged", False),
    ],
)
def test_factual_transfer_result_roundtrips_partial_and_legacy_outcomes(status, source, destination, replaced):
    error = (
        ContentTransferError(code="source_delete_failed", detail="source retained")
        if status == "completed_with_source_retained"
        else (ContentTransferError(code="source_changed", detail="source changed") if status == "failed" else None)
    )
    result = ContentTransferResult(
        status=status, effects=ContentTransferEffects(source=source, destination=destination), replaced=replaced, error=error
    )
    assert ContentTransferResult.model_validate_json(result.model_dump_json()) == result


class MemoryTransferBackend:
    def __init__(self, files: dict[str, bytes], modified_at: datetime) -> None:
        self.files = files
        self.modified_at = modified_at
        self.write_count = 0

    async def get_file_info(self, path: str) -> FileInfo:
        if path not in self.files:
            raise FileNotFoundError(path)
        return FileInfo(
            name=path.rsplit("/", 1)[-1],
            path=path,
            type=FileType.FILE,
            size=len(self.files[path]),
            modified_at=self.modified_at,
            stable_id=f"identity:{path}",
        )

    async def read_file(self, path: str):
        yield self.files[path]

    async def write_file_from_stream(self, path: str, stream, **_kwargs: object) -> int:
        if path in self.files:
            raise FileExistsError(path)
        self.write_count += 1
        self.files[path] = b"".join([chunk async for chunk in stream])
        return len(self.files[path])

    async def stage_and_commit_new_file_from_stream(self, path: str, stream, *, before_commit, **_kwargs: object) -> int:
        if path in self.files:
            raise FileExistsError(path)
        staged_content = b"".join([chunk async for chunk in stream])
        await before_commit()
        if path in self.files:
            raise FileExistsError(path)
        self.write_count += 1
        self.files[path] = staged_content
        return len(staged_content)


class RetainedMoveSource(MemoryTransferBackend):
    def __init__(self, files: dict[str, bytes], modified_at: datetime) -> None:
        super().__init__(files, modified_at)
        self.delete_commits: list[str] = []
        self.closed_paths: list[str] = []

    async def open_move_source_reader(self, path: str):
        source = self

        class Reader:
            async def get_file_info(self) -> FileInfo:
                return await source.get_file_info(path)

            async def read_at(self, offset: int, length: int) -> bytes:
                return source.files[path][offset : offset + length]

            async def commit_delete(self, *, cancellation=None) -> None:
                source.delete_commits.append(path)
                del source.files[path]

            async def close(self) -> None:
                source.closed_paths.append(path)

        return Reader()


class TargetChangesBeforeCommitBackend(MemoryTransferBackend):
    def __init__(self, files: dict[str, bytes], modified_at: datetime, updated_modified_at: datetime) -> None:
        super().__init__(files, modified_at)
        self.updated_modified_at = updated_modified_at

    async def stage_and_commit_new_file_from_stream(
        self, path: str, stream, *, before_commit, overwrite: bool = False, **_kwargs: object
    ) -> int:
        staged_content = b"".join([chunk async for chunk in stream])
        self.modified_at = self.updated_modified_at
        await before_commit()
        if path in self.files and not overwrite:
            raise FileExistsError(path)
        self.write_count += 1
        self.files[path] = staged_content
        return len(staged_content)


@pytest.mark.asyncio
async def test_replace_older_skips_when_target_is_newer_without_attempting_write() -> None:
    now = datetime.now(timezone.utc)
    source = file_info("source.txt", now)
    target = file_info("target.txt", now + timedelta(seconds=1))
    attempt_count = 0

    async def attempt_create(_disposition: TargetResolutionDisposition) -> None:
        nonlocal attempt_count
        attempt_count += 1

    resolution = await resolve_regular_file_transfer(
        source=source,
        target_path="target.txt",
        policy=TargetResolutionPolicy.REPLACE_OLDER,
        observe_target=lambda: _return(target),
        attempt_create=attempt_create,
        replacement_supported=False,
    )

    assert resolution.disposition == TargetResolutionDisposition.SKIP
    assert attempt_count == 0


@pytest.mark.asyncio
async def test_replace_older_skips_when_target_becomes_newer_before_commit() -> None:
    now = datetime.now(timezone.utc)
    source = MemoryTransferBackend({"source.txt": b"new"}, now)
    target = TargetChangesBeforeCommitBackend({"target.txt": b"old"}, now - timedelta(seconds=1), now + timedelta(seconds=1))

    bytes_written, _ = await cross_connection_copy(
        source,
        target,
        "source.txt",
        "target.txt",
        target_resolution_policy=TargetResolutionPolicy.REPLACE_OLDER,
    )

    assert bytes_written is None
    assert target.files["target.txt"] == b"old"
    assert target.write_count == 0


@pytest.mark.asyncio
async def test_cross_connection_copy_reports_factual_replacement() -> None:
    now = datetime.now(timezone.utc)

    class ReplacementBackend(MemoryTransferBackend):
        async def stage_and_commit_new_file_from_stream(
            self, path: str, stream, *, before_commit, overwrite: bool = False, **_kwargs: object
        ) -> int:
            staged_content = b"".join([chunk async for chunk in stream])
            await before_commit()
            if path in self.files and not overwrite:
                raise FileExistsError(path)
            self.write_count += 1
            self.files[path] = staged_content
            return len(staged_content)

    source = MemoryTransferBackend({"source.txt": b"new"}, now)
    target = ReplacementBackend({"target.txt": b"old"}, now - timedelta(seconds=1))

    result = await cross_connection_copy(
        source,
        target,
        "source.txt",
        "target.txt",
        target_resolution_policy=TargetResolutionPolicy.REPLACE,
    )

    assert result.replaced is True
    assert result.bytes_written == len(b"new")
    assert target.files["target.txt"] == b"new"


@pytest.mark.asyncio
async def test_replace_returns_refreshed_conflict_when_guarded_replacement_is_unavailable() -> None:
    now = datetime.now(timezone.utc)
    source = file_info("source.txt", now)
    target = file_info("target.txt", now - timedelta(seconds=1))
    attempt_count = 0

    async def attempt_create(_disposition: TargetResolutionDisposition) -> None:
        nonlocal attempt_count
        attempt_count += 1

    resolution = await resolve_regular_file_transfer(
        source=source,
        target_path="target.txt",
        policy=TargetResolutionPolicy.REPLACE,
        observe_target=lambda: _return(target),
        attempt_create=attempt_create,
        replacement_supported=False,
    )

    assert resolution.disposition == TargetResolutionDisposition.AWAIT_COLLISION
    assert resolution.target == target
    assert attempt_count == 0


@pytest.mark.asyncio
async def test_late_create_collision_uses_one_fresh_retry() -> None:
    now = datetime.now(timezone.utc)
    source = file_info("source.txt", now)
    attempt_count = 0

    async def observe_target() -> FileInfo:
        raise FileNotFoundError

    async def attempt_create(_disposition: TargetResolutionDisposition) -> None:
        nonlocal attempt_count
        attempt_count += 1
        if attempt_count == 1:
            raise FileExistsError

    resolution = await resolve_regular_file_transfer(
        source=source,
        target_path="target.txt",
        policy=TargetResolutionPolicy.ASK,
        observe_target=observe_target,
        attempt_create=attempt_create,
        replacement_supported=False,
    )

    assert resolution.disposition == TargetResolutionDisposition.CREATE_NEW
    assert attempt_count == 2


@pytest.mark.asyncio
async def test_successful_create_returns_the_single_committed_attempt_result() -> None:
    now = datetime.now(timezone.utc)
    source = file_info("source.txt", now)
    attempt_count = 0

    async def observe_target() -> FileInfo:
        raise FileNotFoundError

    async def attempt_create(_disposition: TargetResolutionDisposition) -> int:
        nonlocal attempt_count
        attempt_count += 1
        return 42

    resolution = await resolve_regular_file_transfer(
        source=source,
        target_path="target.txt",
        policy=TargetResolutionPolicy.ASK,
        observe_target=observe_target,
        attempt_create=attempt_create,
        replacement_supported=False,
    )

    assert resolution.disposition == TargetResolutionDisposition.CREATE_NEW
    assert resolution.mutation_result == 42
    assert attempt_count == 1


@pytest.mark.asyncio
async def test_typed_controller_retries_with_a_fresh_attempt_after_one_late_collision() -> None:
    now = datetime.now(timezone.utc)
    source = file_info("source.txt", now)
    attempts: list[TargetResolutionDisposition] = []

    async def observe_target() -> FileInfo:
        raise FileNotFoundError

    async def make_attempt(disposition: TargetResolutionDisposition):
        attempts.append(disposition)
        if len(attempts) == 1:
            return TargetMutationTargetExistsBeforeMutation()
        return TargetMutationCommitted(result=42)

    resolution = await resolve_target_mutation_attempt(
        plan=ContentTransferPlan(
            source=source,
            target_path="target.txt",
            policy=TargetResolutionPolicy.ASK,
            replacement_supported=False,
        ),
        observe_target=observe_target,
        attempt_factory=make_attempt,
    )

    assert resolution.disposition == TargetResolutionDisposition.CREATE_NEW
    assert resolution.mutation_result == 42
    assert attempts == [TargetResolutionDisposition.CREATE_NEW, TargetResolutionDisposition.CREATE_NEW]


@pytest.mark.asyncio
async def test_typed_controller_never_allocates_an_attempt_for_skip() -> None:
    now = datetime.now(timezone.utc)
    source = file_info("source.txt", now)
    target = file_info("target.txt", now)
    attempt_count = 0

    async def make_attempt(_disposition: TargetResolutionDisposition):
        nonlocal attempt_count
        attempt_count += 1
        return TargetMutationCommitted()

    resolution = await resolve_target_mutation_attempt(
        plan=ContentTransferPlan(
            source=source,
            target_path="target.txt",
            policy=TargetResolutionPolicy.SKIP,
            replacement_supported=False,
        ),
        observe_target=lambda: _return(target),
        attempt_factory=make_attempt,
    )

    assert resolution.disposition == TargetResolutionDisposition.SKIP
    assert attempt_count == 0


@pytest.mark.asyncio
async def test_explicit_policy_copy_commits_a_missing_target_once() -> None:
    now = datetime.now(timezone.utc)
    source = MemoryTransferBackend({"source.txt": b"content"}, now)
    target = MemoryTransferBackend({}, now)

    bytes_written, source_info = await cross_connection_copy(
        source,
        target,
        "source.txt",
        "target.txt",
        target_resolution_policy=TargetResolutionPolicy.ASK,
    )

    assert bytes_written == len(b"content")
    assert source_info.path == "source.txt"
    assert target.files == {"target.txt": b"content"}
    assert target.write_count == 1


@pytest.mark.asyncio
async def test_cancellation_before_staged_file_commit_leaves_target_unchanged() -> None:
    now = datetime.now(timezone.utc)
    cancellation_requested = False

    class CancellationAwareTarget(MemoryTransferBackend):
        async def stage_and_commit_new_file_from_stream(self, path: str, stream, *, before_commit, **_kwargs: object) -> int:
            nonlocal cancellation_requested
            staged_content = b"".join([chunk async for chunk in stream])
            cancellation_requested = True
            await before_commit()
            self.files[path] = staged_content
            return len(staged_content)

    source = MemoryTransferBackend({"source.txt": b"content"}, now)
    target = CancellationAwareTarget({}, now)

    with pytest.raises(TransferCancelled, match="Transfer cancelled"):
        await cross_connection_copy(
            source,
            target,
            "source.txt",
            "target.txt",
            target_resolution_policy=TargetResolutionPolicy.ASK,
            cancellation=lambda: cancellation_requested,
        )

    assert source.files == {"source.txt": b"content"}
    assert target.files == {}


@pytest.mark.asyncio
async def test_regular_file_move_deletes_only_through_the_retained_source_reader() -> None:
    now = datetime.now(timezone.utc)
    source = RetainedMoveSource({"source.txt": b"content"}, now)
    target = MemoryTransferBackend({}, now)

    bytes_written, source_info = await cross_connection_move(
        source,
        target,
        "source.txt",
        "target.txt",
        target_resolution_policy=TargetResolutionPolicy.ASK,
    )

    assert bytes_written == len(b"content")
    assert source_info.path == "source.txt"
    assert target.files == {"target.txt": b"content"}
    assert source.files == {}
    assert source.delete_commits == ["source.txt"]
    assert source.closed_paths == ["source.txt"]


@pytest.mark.asyncio
async def test_move_cancelled_after_publication_retains_source_and_replacement() -> None:
    now = datetime.now(timezone.utc)
    source = RetainedMoveSource({"source.txt": b"content"}, now)
    target = TargetChangesBeforeCommitBackend({"target.txt": b"old"}, now, now)
    with pytest.raises(SourceDeleteError, match="cancelled after") as raised:
        await cross_connection_move(
            source,
            target,
            "source.txt",
            "target.txt",
            overwrite=True,
            cancellation=lambda: target.write_count > 0,
        )
    assert raised.value.replaced is True
    assert source.files == {"source.txt": b"content"}
    assert target.files == {"target.txt": b"content"}
    assert source.delete_commits == []
    assert source.closed_paths == ["source.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize("uncertain", [False, True])
@pytest.mark.parametrize("cleanup_failure", [False, True])
async def test_move_deletion_failure_preserves_replacement_and_published_bytes(uncertain: bool, cleanup_failure: bool) -> None:
    now = datetime.now(timezone.utc)
    source = RetainedMoveSource({"source.txt": b"content"}, now)
    target = TargetChangesBeforeCommitBackend({"target.txt": b"old"}, now, now)
    original_open = source.open_move_source_reader

    async def open_reader(path):
        reader = await original_open(path)

        async def reject(*, cancellation=None):
            if uncertain:
                raise SourceDeletionOutcomeUnknown("lost acknowledgement")
            raise SourceDeleteError("server rejected deletion", destination_mutated=True)

        reader.commit_delete = reject
        if cleanup_failure:
            original_close = reader.close

            async def fail_close():
                await original_close()
                raise OSError("cleanup failed too")

            reader.close = fail_close
        return reader

    source.open_move_source_reader = open_reader
    with pytest.raises(SourceDeletionOutcomeUnknown if uncertain else SourceDeleteError) as raised:
        await cross_connection_move(source, target, "source.txt", "target.txt", overwrite=True)
    assert raised.value.replaced is True
    assert target.files == {"target.txt": b"content"}
    assert source.files == {"source.txt": b"content"}
    assert source.closed_paths == ["source.txt"]


@pytest.mark.asyncio
async def test_move_rejects_replaced_object_at_handle_acquisition() -> None:
    now = datetime.now(timezone.utc)
    source = RetainedMoveSource({"source.txt": b"content"}, now)
    target = MemoryTransferBackend({}, now)
    original_open = source.open_move_source_reader

    async def open_reader(path):
        reader = await original_open(path)

        async def observe():
            return (await source.get_file_info(path)).model_copy(update={"stable_id": "replacement-object"})

        reader.get_file_info = observe
        return reader

    source.open_move_source_reader = open_reader
    with pytest.raises(SourceChangedError, match="before reading"):
        await cross_connection_move(source, target, "source.txt", "target.txt")
    assert target.files == {}
    assert source.delete_commits == []
    assert source.closed_paths == ["source.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize("disappears", [False, True])
async def test_copy_source_change_after_replacement_preserves_publication_facts(disappears: bool) -> None:
    now = datetime.now(timezone.utc)
    source = MemoryTransferBackend({"source.txt": b"content"}, now)

    class PostPublicationChange(TargetChangesBeforeCommitBackend):
        async def stage_and_commit_new_file_from_stream(self, *args, **kwargs):
            result = await super().stage_and_commit_new_file_from_stream(*args, **kwargs)
            if disappears:
                del source.files["source.txt"]
            else:
                source.files["source.txt"] = b"newer source content"
            return result

    target = PostPublicationChange({"target.txt": b"old"}, now, now)
    with pytest.raises(SourceChangedError) as raised:
        await cross_connection_copy(source, target, "source.txt", "target.txt", overwrite=True)
    assert raised.value.destination_mutated is True
    assert raised.value.replaced is True
    assert target.files == {"target.txt": b"content"}
    assert source.files == ({} if disappears else {"source.txt": b"newer source content"})


@pytest.mark.asyncio
async def test_skipped_regular_file_move_keeps_its_retained_source() -> None:
    now = datetime.now(timezone.utc)
    source = RetainedMoveSource({"source.txt": b"content"}, now)
    target = MemoryTransferBackend({"target.txt": b"existing"}, now)

    bytes_written, source_info = await cross_connection_move(
        source,
        target,
        "source.txt",
        "target.txt",
        target_resolution_policy=TargetResolutionPolicy.SKIP,
    )

    assert bytes_written is None
    assert source_info.path == "source.txt"
    assert source.files == {"source.txt": b"content"}
    assert target.files == {"target.txt": b"existing"}
    assert source.delete_commits == []
    assert source.closed_paths == ["source.txt"]


@pytest.mark.asyncio
async def test_unmanaged_move_source_keeps_a_skipped_transfer_skipped() -> None:
    now = datetime.now(timezone.utc)
    source = MemoryTransferBackend({"source.txt": b"content"}, now)
    target = MemoryTransferBackend({"target.txt": b"existing"}, now)

    async def unavailable_move_reader(_path: str):
        raise NotImplementedError

    source.open_move_source_reader = unavailable_move_reader  # type: ignore[attr-defined]

    result = await cross_connection_move(
        source,
        target,
        "source.txt",
        "target.txt",
        target_resolution_policy=TargetResolutionPolicy.SKIP,
    )

    assert result.bytes_written is None
    assert result.replaced is False
    assert source.files == {"source.txt": b"content"}
    assert target.files == {"target.txt": b"existing"}


@pytest.mark.asyncio
async def test_unmanaged_move_source_retention_preserves_a_replacement_fact() -> None:
    now = datetime.now(timezone.utc)

    class ReplacementBackend(MemoryTransferBackend):
        async def stage_and_commit_new_file_from_stream(
            self, path: str, stream, *, before_commit, overwrite: bool = False, **_kwargs: object
        ) -> int:
            staged_content = b"".join([chunk async for chunk in stream])
            await before_commit()
            if path in self.files and not overwrite:
                raise FileExistsError(path)
            self.write_count += 1
            self.files[path] = staged_content
            return len(staged_content)

    source = MemoryTransferBackend({"source.txt": b"content"}, now)
    target = ReplacementBackend({"target.txt": b"existing"}, now - timedelta(seconds=1))

    async def unavailable_move_reader(_path: str):
        raise NotImplementedError

    source.open_move_source_reader = unavailable_move_reader  # type: ignore[attr-defined]

    with pytest.raises(SourceDeleteError) as error:
        await cross_connection_move(
            source,
            target,
            "source.txt",
            "target.txt",
            target_resolution_policy=TargetResolutionPolicy.REPLACE,
        )

    assert error.value.destination_mutated is True
    assert error.value.replaced is True
    assert source.files == {"source.txt": b"content"}
    assert target.files == {"target.txt": b"content"}


@pytest.mark.asyncio
async def test_directory_move_is_rejected_without_mutating_either_side() -> None:
    now = datetime.now(timezone.utc)

    class DirectoryTransferBackend(MemoryTransferBackend):
        async def delete_item(self, path: str) -> None:
            del self.files[path]

    source = DirectoryTransferBackend({"source": b"directory"}, now)
    target = DirectoryTransferBackend({"target": b"directory"}, now)
    source.get_file_info = lambda path: _return(
        FileInfo(
            name=path,
            path=path,
            type=FileType.DIRECTORY,
            size=0,
            modified_at=now,
            stable_id=f"identity:{path}",
        )
    )
    target.get_file_info = lambda path: _return(
        FileInfo(
            name=path,
            path=path,
            type=FileType.DIRECTORY,
            size=0,
            modified_at=now,
            stable_id=f"identity:{path}",
        )
    )

    with pytest.raises(RegularFileTransferRequiredError, match="Directory transfers"):
        await cross_connection_move(
            source,
            target,
            "source",
            "target",
            target_resolution_policy=TargetResolutionPolicy.SKIP,
        )

    assert source.files == {"source": b"directory"}
    assert target.files == {"target": b"directory"}


@pytest.mark.asyncio
async def test_source_change_before_staged_commit_leaves_target_unchanged() -> None:
    now = datetime.now(timezone.utc)
    source = MemoryTransferBackend({"source.txt": b"content"}, now)

    class SourceMutatingTarget(MemoryTransferBackend):
        async def stage_and_commit_new_file_from_stream(self, path: str, stream, *, before_commit, **_kwargs: object) -> int:
            staged_content = b"".join([chunk async for chunk in stream])
            source.files["source.txt"] = b"changed-source"
            await before_commit()
            self.files[path] = staged_content
            return len(staged_content)

    target = SourceMutatingTarget({}, now)

    with pytest.raises(SourceChangedError, match="Source changed before commit"):
        await cross_connection_copy(
            source,
            target,
            "source.txt",
            "target.txt",
            target_resolution_policy=TargetResolutionPolicy.ASK,
        )

    assert target.files == {}


@pytest.mark.asyncio
async def test_directory_copy_is_rejected_without_creating_a_stage() -> None:
    now = datetime.now(timezone.utc)

    class DirectoryTransferBackend(MemoryTransferBackend):
        async def list_directory(self, path: str):
            if path == "source":
                return type("Listing", (), {"items": [file_info("child.txt", now)], "total": 1})()
            return type("Listing", (), {"items": [], "total": 0})()

        async def create_directory(self, path: str) -> None:
            if path in self.files:
                raise FileExistsError(path)
            self.files[path] = b"directory"

        async def rename_item(self, path: str, new_name: str) -> None:
            parent_path = path.rpartition("/")[0]
            destination_path = f"{parent_path}/{new_name}" if parent_path else new_name
            for existing_path in [item_path for item_path in self.files if item_path == path or item_path.startswith(f"{path}/")]:
                self.files[destination_path + existing_path.removeprefix(path)] = self.files.pop(existing_path)

        async def delete_item(self, path: str) -> None:
            for existing_path in [item_path for item_path in self.files if item_path == path or item_path.startswith(f"{path}/")]:
                del self.files[existing_path]

        async def stage_and_commit_new_file_from_stream(self, path: str, stream, *, before_commit, **kwargs: object) -> int:
            if path.endswith("/child.txt"):
                raise FileExistsError(path)
            return await super().stage_and_commit_new_file_from_stream(path, stream, before_commit=before_commit, **kwargs)

        async def set_file_times(self, _path: str, _modified_at: datetime) -> None:
            return None

    source = DirectoryTransferBackend({"source": b"directory", "source/child.txt": b"content"}, now)
    target = DirectoryTransferBackend({}, now)
    source.get_file_info = lambda path: _return(
        FileInfo(
            name=path.rsplit("/", 1)[-1],
            path=path,
            type=FileType.DIRECTORY if path == "source" else FileType.FILE,
            size=0,
            modified_at=now,
            stable_id=f"identity:{path}",
        )
    )

    with pytest.raises(RegularFileTransferRequiredError, match="Directory transfers"):
        await cross_connection_copy(source, target, "source", "target")

    assert target.files == {}


@pytest.mark.asyncio
async def test_directory_move_is_rejected_without_deleting_the_source() -> None:
    now = datetime.now(timezone.utc)

    class DirectoryTransferBackend(MemoryTransferBackend):
        async def list_directory(self, path: str):
            if path == "source":
                return type("Listing", (), {"items": [file_info("child.txt", now)], "total": 1})()
            return type("Listing", (), {"items": [], "total": 0})()

        async def create_directory(self, path: str) -> None:
            self.files[path] = b"directory"

        async def rename_item(self, path: str, new_name: str) -> None:
            parent_path = path.rpartition("/")[0]
            destination_path = f"{parent_path}/{new_name}" if parent_path else new_name
            for existing_path in [item_path for item_path in self.files if item_path == path or item_path.startswith(f"{path}/")]:
                self.files[destination_path + existing_path.removeprefix(path)] = self.files.pop(existing_path)

        async def set_file_times(self, _path: str, _modified_at: datetime) -> None:
            return None

        async def delete_item(self, path: str) -> None:
            for child_path in [item_path for item_path in self.files if item_path == path or item_path.startswith(f"{path}/")]:
                del self.files[child_path]

    source = DirectoryTransferBackend({"source": b"directory", "source/child.txt": b"content"}, now)
    target = DirectoryTransferBackend({}, now)
    source.get_file_info = lambda path: _return(
        FileInfo(
            name=path.rsplit("/", 1)[-1],
            path=path,
            type=FileType.DIRECTORY if path == "source" else FileType.FILE,
            size=0,
            modified_at=now,
            stable_id=f"identity:{path}",
        )
    )

    with pytest.raises(RegularFileTransferRequiredError, match="Directory transfers"):
        await cross_connection_move(source, target, "source", "target")

    assert source.files == {"source": b"directory", "source/child.txt": b"content"}
    assert target.files == {}


def test_source_snapshot_rejects_an_identity_that_appears_after_planning() -> None:
    now = datetime.now(timezone.utc)
    snapshot = RegularFileSourceSnapshot.from_file_info(file_info("source.txt", now))
    current = file_info("source.txt", now)
    current.stable_id = "unexpected-id"

    assert not snapshot.matches(current)


@pytest.mark.asyncio
async def test_copy_rejects_a_source_without_stable_identity_before_reading() -> None:
    now = datetime.now(timezone.utc)

    class UnstableSource(MemoryTransferBackend):
        async def get_file_info(self, path: str) -> FileInfo:
            info = await super().get_file_info(path)
            info.stable_id = None
            return info

    source = UnstableSource({"source.txt": b"content"}, now)
    target = MemoryTransferBackend({}, now)

    with pytest.raises(SourceChangedError, match="no stable identity"):
        await cross_connection_copy(source, target, "source.txt", "target.txt", target_resolution_policy=TargetResolutionPolicy.ASK)

    assert target.files == {}


async def _return(value: FileInfo) -> FileInfo:
    return value


def test_copy_move_request_normalizes_legacy_overwrite() -> None:
    request = CopyMoveRequest(source_path="source", dest_path="target", idempotency_key=str(uuid4()))
    assert request.normalized_target_resolution_policy == "ask"
    assert request.idempotency_key
    assert (
        CopyMoveRequest(
            source_path="source", dest_path="target", overwrite=True, idempotency_key=str(uuid4())
        ).normalized_target_resolution_policy
        == "replace"
    )
    with pytest.raises(ValueError, match="conflicts"):
        CopyMoveRequest(
            source_path="source",
            dest_path="target",
            target_resolution_policy="skip",
            overwrite=True,
            idempotency_key=str(uuid4()),
        )
    with pytest.raises(ValueError, match="idempotency_key"):
        CopyMoveRequest(source_path="source", dest_path="target")
