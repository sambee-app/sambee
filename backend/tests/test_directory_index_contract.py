"""Language-neutral SQLite contract and transaction checks."""

import asyncio
import json
import os
import sqlite3
import stat
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from smbprotocol.exceptions import SMBResponseException
from smbprotocol.header import NtStatus, SMB2HeaderResponse

from app.services.directory_index import MAX_QUERY_BYTES, MAX_QUERY_TERMS, DirectoryIndex, normalize_search_text, search_terms

CONTRACT_ROOT = Path(__file__).resolve().parents[2] / "shared" / "directory-index"


def _lose_observations(coordinator) -> None:
    from app.services.directory_cache import InvalidationReason

    coordinator.invalidate(InvalidationReason.OBSERVATION_LOSS)


def test_deep_hint_does_not_invalidate_ancestor_listing(index):
    from app.services.directory_cache import READ_PARENT_ACTION, DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index)
    with coordinator.read("parent") as token:
        assert coordinator.enqueue(_DirectoryMutation(READ_PARENT_ACTION, "parent/child/grandchild"))
        assert coordinator.is_current(token)


@pytest.mark.parametrize("failure", ["ancestor_event", "watcher_loss"])
def test_observed_buffered_reads_recheck_containment_before_commit(index, failure):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    ready = threading.Event()
    ready.set()
    coordinator = DirectoryScanCoordinator(index)
    coordinator.observed_ready = ready.is_set
    index.seed_scan(1)
    index.write_scan_children(1, [("parent", True), ("quiet", True), ("parent/child", True)])
    coordinator.start_scan_groups()
    try:
        for parent in ("parent/child", "quiet"):
            with coordinator.read(parent, observed=True) as token:
                coordinator.commit_children(token, 1, [(parent + "/new", True)])
                coordinator.finish_parent(token, 1)
        if failure == "ancestor_event":
            coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "parent"))
        else:
            ready.clear()
        coordinator.flush_scan_group()
        assert not index.search("parent/child/new").results
        assert bool(index.search("quiet/new").results) == (failure == "ancestor_event")
        assert not coordinator._producers
    finally:
        coordinator.cancel_scan_groups()


def test_drained_barrier_overflow_stales_reads_without_changing_epoch(index):
    from app.services.directory_cache import MAX_PENDING_OBSERVATIONS, READ_PARENT_ACTION, DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index)
    with coordinator.read("parent") as token:
        epoch = coordinator.epoch
        for number in range(MAX_PENDING_OBSERVATIONS + 1):
            assert coordinator.enqueue(_DirectoryMutation(READ_PARENT_ACTION, f"unrelated-{number}"))
            coordinator.apply_pending()
        assert coordinator.epoch == epoch
        assert len(coordinator.barriers) <= MAX_PENDING_OBSERVATIONS
        assert not coordinator.is_current(token)
    assert not coordinator.barriers


def test_epoch_capture_does_not_retain_barriers(index):
    from app.services.directory_cache import READ_PARENT_ACTION, DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index)
    epoch = coordinator.capture_epoch()
    assert not coordinator._producers
    for number in range(1025):
        assert coordinator.enqueue(_DirectoryMutation(READ_PARENT_ACTION, f"parent-{number}"))
        coordinator.apply_pending()
        assert not coordinator.barriers
    assert coordinator.capture_epoch() == epoch


def test_active_full_pass_drains_many_hints_without_epoch_change(sqlite_cache, monkeypatch):
    from app.services.directory_cache import MAX_PENDING_OBSERVATIONS

    cache = sqlite_cache
    original = cache._scan_parent
    injected = False
    epoch = cache.coordinator.epoch
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: (entry for entry in ()))

    def scan(generation, parent, **kwargs):
        nonlocal injected
        original(generation, parent, **kwargs)
        if not injected:
            injected = True
            assert cache._scan_running.is_set()
            cache.coordinator.flush_scan_group()
            assert not cache.coordinator._producers
            for number in range(MAX_PENDING_OBSERVATIONS + 1):
                cache.observe_parent(f"hint-{number}")
                cache.coordinator.apply_pending()
                assert cache.coordinator.epoch == epoch
                assert not cache.coordinator.barriers

    monkeypatch.setattr(cache, "_scan_parent", scan)
    cache._scan_disk_queue()
    assert cache.coordinator.epoch == epoch
    assert cache.index.status().coverage == "complete"


def test_observed_completed_and_deferred_parents_move_to_queue_tail(index):
    index.seed_scan(1)
    index.write_scan_children(1, [("hot", True), ("quiet", True)])
    index.finish_scan_parent(1, "")
    index.finish_scan_parent(1, "hot")
    index.queue_observed_parent("hot")
    assert index.pending_scan_paths(1) == ["quiet", "hot"]
    index.queue_observed_parent("quiet")
    assert index.pending_scan_paths(1) == ["quiet", "hot"]
    index.defer_scan_parent(1, "quiet")
    assert index.pending_scan_paths(1) == ["hot", "quiet"]


def test_failed_parent_deferral_preserves_queue_order_and_index_rows(index):
    index.seed_scan(1)
    index.write_scan_children(1, [("hot", True), ("quiet", True)])
    index.finish_scan_parent(1, "")
    before = index.status()
    pending = index.pending_scan_paths(1)
    index._connection().execute(
        "CREATE TRIGGER reject_deferred_parent BEFORE INSERT ON scan_queue WHEN NEW.path = 'hot' BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    with pytest.raises(sqlite3.IntegrityError):
        index.defer_scan_parent(1, "hot")
    assert index.pending_scan_paths(1) == pending
    assert index.status() == before
    index._connection().execute("DROP TRIGGER reject_deferred_parent")
    index.defer_scan_parent(1, "hot")
    assert index.pending_scan_paths(1) == ["quiet", "hot"]


@pytest.mark.parametrize("failure", ["stale", "transient"])
def test_local_parent_retry_retains_unrelated_completed_work(sqlite_cache, monkeypatch, failure):
    from app.services.directory_cache import ScanObservationInvalidated

    cache = sqlite_cache
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: (entry for entry in ()))
    cache.index.write_paths(["accepted"])
    assert cache.index.finish_generation(1)
    candidate, _selected = cache.index.prepare_scan()
    cache.index.seed_scan(candidate)
    cache.index.write_scan_children(candidate, [("quiet", True), ("hot", True), ("later", True)])
    cache.index.finish_scan_parent(candidate, "")
    cache.index.finish_scan_parent(candidate, "quiet")
    cache._scan_epoch = (candidate, cache.coordinator.epoch)
    epoch = cache.coordinator.epoch
    reads = []
    original = cache._scan_parent_read

    def read(generation, parent, token, **kwargs):
        reads.append(parent)
        if parent == "hot":
            if failure == "stale":
                cache.observe_parent("hot")
                raise ScanObservationInvalidated("Injected local stale read.")
            raise OSError("Injected transient parent failure.")
        original(generation, parent, token, **kwargs)

    monkeypatch.setattr(cache, "_scan_parent_read", read)
    with pytest.raises(ScanObservationInvalidated if failure == "stale" else OSError):
        cache._scan_disk_queue()
    assert cache.coordinator.epoch == epoch
    assert "quiet" not in cache.index.pending_scan_paths(candidate)
    monkeypatch.setattr(cache, "_scan_parent_read", original)
    cache._scan_disk_queue()
    assert "quiet" not in reads
    assert cache.index.status().coverage == "complete"


@pytest.mark.parametrize("reason", ["observation_loss", "read_capacity"])
def test_observed_reads_stay_blocked_after_requeue_flag_is_cleared(sqlite_cache, reason):
    from app.services.directory_cache import InvalidationReason

    coordinator = sqlite_cache.coordinator
    coordinator.invalidate(InvalidationReason(reason))
    coordinator.observation_lost = False
    assert coordinator.observed_reads_blocked


def test_retry_delay_reports_latest_scan_gate_and_earliest_watcher(sqlite_cache, monkeypatch):
    monkeypatch.setattr("app.services.directory_cache.time.monotonic", lambda: 100.0)
    sqlite_cache._resource_retry_at = 130.0
    sqlite_cache._verification_retry_at = 101.0
    assert sqlite_cache.retry_after_ms == 30000
    sqlite_cache._watcher_retry_at = 105.0
    assert sqlite_cache.retry_after_ms == 5000


@pytest.mark.parametrize("remember_bytes", [0, 7, 1024])
@pytest.mark.parametrize("children", [("Exact", "other"), ("Name", "name", "é", "e\u0301")])
def test_enumerated_children_skip_extra_native_existence_queries(sqlite_cache, smb_directory_server, monkeypatch, remember_bytes, children):
    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRead, SmbDirectoryRoot

    cache = sqlite_cache
    cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(cache)
    smb_directory_server.directories["base"] = [(name, 16) for name in children]
    queries = []
    original = SmbDirectoryRead.has_directory_child
    expected_queries = []
    remembered_bytes = 0
    tracking_full = False
    for name in children:
        size = len(name.encode("utf-8"))
        if tracking_full or remembered_bytes + size > remember_bytes:
            tracking_full = True
            expected_queries.append(name)
        else:
            remembered_bytes += size

    def lookup(read, name):
        queries.append(name)
        return original(read, name)

    monkeypatch.setattr("app.services.directory_cache.SCAN_SEEN_CHILD_BYTES", remember_bytes)
    monkeypatch.setattr(SmbDirectoryRead, "has_directory_child", lookup)
    try:
        cache.index.seed_scan(1)
        cache._scan_parent(1, "")
        assert queries == sorted(expected_queries)
        assert cache.index.search("").directory_count == len(children)
    finally:
        cache._request_stop()
        cache._finish_stop()


@pytest.mark.parametrize("stage", ["probe", "accept"])
def test_final_hint_does_not_requeue_completed_parents(sqlite_cache, monkeypatch, stage):
    cache = sqlite_cache
    cache.index.write_paths(["accepted"])
    assert cache.index.finish_generation(1)
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: (entry for entry in ()))
    visited = []
    original_scan = cache._scan_parent
    original_probe = cache._probe_source_root_read
    original_accept = cache.coordinator.accept_generation
    injected = False
    epoch = cache.coordinator.epoch

    def scan(generation, parent, **kwargs):
        visited.append(parent)
        original_scan(generation, parent, **kwargs)

    def inject():
        nonlocal injected
        if not injected:
            injected = True
            cache.observe_parent("late")

    def probe(token):
        inject()
        original_probe(token)

    def accept(baseline, generation, **kwargs):
        inject()
        return original_accept(baseline, generation, **kwargs)

    monkeypatch.setattr(cache, "_scan_parent", scan)
    if stage == "probe":
        monkeypatch.setattr(cache, "_probe_source_root_read", probe)
        cache._scan_disk_queue()
    else:
        from app.services.directory_cache import ScanObservationInvalidated

        monkeypatch.setattr(cache.coordinator, "accept_generation", accept)
        with pytest.raises(ScanObservationInvalidated):
            cache._scan_disk_queue()
        cache._scan_disk_queue()
    assert cache.coordinator.epoch == epoch
    assert visited.count("") == 1
    assert cache.index.status().coverage == "complete"


def test_local_retry_status_has_no_sticky_source_change_message(sqlite_cache, monkeypatch):
    cache = sqlite_cache
    cache._watcher_ready.set()
    cache._schedule_observation_retry()
    assert cache.scan_error is None
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: (entry for entry in ()))
    cache.index.seed_scan(1)
    cache._scan_parent(1, "")
    assert cache.scan_error is None


def test_first_watcher_readiness_invalidates_without_observation_loss_status(sqlite_cache):
    from app.services.directory_cache import InvalidationReason

    cache = sqlite_cache
    with cache.coordinator.read("parent") as token:
        cache._observation_started()
        assert not cache.coordinator.is_current(token)
    cache._watcher_ready.set()
    assert cache.coordinator.last_reason == InvalidationReason.WATCHER_START
    assert cache.scan_error is None
    cache._observation_started()
    assert cache.coordinator.last_reason == InvalidationReason.OBSERVATION_LOSS
    assert "observations were lost" in cache.scan_error


def test_status_priority_and_recovery_follow_current_conditions(sqlite_cache, monkeypatch):
    cache = sqlite_cache
    cache._watcher_ready.set()
    cache._disk_budget_error = "Directory indexing is paused. Increase its disk budget and retry."
    cache._verification_error = "Directory verification failed. Check source access; existing results remain available."
    cache._source_available.clear()
    assert "root is unavailable" in cache.scan_error
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: (entry for entry in ()))
    cache._probe_source_root()
    assert "disk budget" in cache.scan_error
    cache._reset_retry()
    assert cache.scan_error is None


@pytest.mark.parametrize("state", ["empty", "building", "accepted"])
def test_continuous_change_status_clears_after_parent_progress(sqlite_cache, monkeypatch, state):
    from app.services.directory_cache import CONTINUOUS_CHANGE_STALE_TURNS

    cache = sqlite_cache
    cache._watcher_ready.set()
    if state != "empty":
        cache.index.write_paths(["retained"])
    if state == "accepted":
        assert cache.index.finish_generation(1)
        cache.index.queue_reconciliation_parent(1, "")
    else:
        cache.index.seed_scan(1)
    cache._stale_turns = CONTINUOUS_CHANGE_STALE_TURNS
    assert "keep changing" in cache.scan_error
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: (entry for entry in ()))
    cache._scan_parent(1, "", reconcile=state == "accepted")
    assert cache._stale_turns == 0
    assert cache.scan_error is None


def test_finished_pass_with_coverage_issue_replaces_observation_loss_status(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    cache = sqlite_cache
    cache._watcher_ready.set()
    cache.index.write_paths(["accepted"])
    assert cache.index.finish_generation(1)
    cache._observation_lost()
    assert "observations were lost" in cache.scan_error

    def scan(path, **kwargs):
        parent = path[len(cache._smb_base_path) :].lstrip("\\")
        if parent == "denied":
            raise PermissionError("Injected denied child.")
        names = ("accepted", "denied") if not parent else ()
        return (
            SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY)) for name in names
        )

    monkeypatch.setattr("smbclient.scandir", scan)
    cache._scan_disk_queue()
    assert not cache.coordinator.observation_lost
    assert cache.scan_error is None
    assert cache.index.status().coverage == "partial"
    assert cache.search_index("accepted").total_matches == 1


def test_update_error_survives_unrelated_parent_success(sqlite_cache, monkeypatch):
    cache = sqlite_cache
    cache._watcher_ready.set()
    cache._update_error = "Directory updates failed. Check source access and private local storage, then retry."
    cache._verification_error = "Directory verification failed. Check source access; existing results remain available."
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: (entry for entry in ()))
    cache.index.seed_scan(1)
    cache._scan_parent(1, "")
    assert "verification failed" in cache.scan_error
    cache._reset_retry()
    assert cache.scan_error is None


@pytest.mark.asyncio
async def test_update_error_clears_after_successful_periodic_iteration(sqlite_cache, monkeypatch):
    from app.services import directory_cache

    cache = sqlite_cache
    cache._watcher_ready.set()
    cache._opened.set()
    cache._source_available.set()
    outcomes = [OSError("Injected update failure."), None]
    statuses = []
    ticks = 0

    async def tick(_delay):
        nonlocal ticks
        statuses.append(cache.scan_error)
        ticks += 1
        if ticks > len(outcomes):
            raise asyncio.CancelledError
        cache._resource_retry_at = 0.0

    async def reconcile():
        outcome = outcomes[ticks - 1]
        if outcome is not None:
            raise outcome

    monkeypatch.setattr(cache, "_run_reconciliation", reconcile)
    monkeypatch.setattr(cache, "_verification_due", lambda _verified_at: False)
    monkeypatch.setattr(directory_cache, "asyncio", SimpleNamespace(**(vars(asyncio) | {"sleep": tick})))
    await cache._periodic_rescan_loop()
    assert statuses[0] is None
    assert "updates failed" in statuses[1]
    assert statuses[2] is None


@pytest.mark.parametrize("cause", ["pending", "unsupported", "capacity", "binding", "stop"])
def test_real_invalidation_causes_still_change_epoch(sqlite_cache, cause):
    from app.services.directory_cache import (
        READ_PARENT_ACTION,
        DirectorySourceUnavailableError,
        InvalidationReason,
        ScanObservationInvalidated,
        _DirectoryMutation,
    )
    from app.services.directory_index import MAX_SIGNED_INTEGER
    from app.services.directory_traversal import DirectoryBindingChangedError

    cache = sqlite_cache
    epoch = cache.coordinator.epoch
    expected = InvalidationReason.OBSERVATION_LOSS
    if cause == "pending":
        cache.coordinator.maximum_pending = 1
        assert cache.coordinator.enqueue(_DirectoryMutation(READ_PARENT_ACTION, "first"))
        assert not cache.coordinator.enqueue(_DirectoryMutation(READ_PARENT_ACTION, "second"))
    elif cause == "unsupported":
        cache.coordinator.enqueue(_DirectoryMutation(0, "first"))
        with pytest.raises(ValueError, match="unsupported"):
            cache.coordinator.apply_pending()
    elif cause == "capacity":
        expected = InvalidationReason.READ_CAPACITY
        cache.coordinator._next_producer_id = MAX_SIGNED_INTEGER
        with pytest.raises(ScanObservationInvalidated, match="capacity"):
            cache.coordinator.begin_read("parent")
    elif cause == "binding":
        expected = InvalidationReason.SOURCE_REBIND

        def replaced():
            raise DirectoryBindingChangedError("Injected source replacement.")

        with pytest.raises(DirectorySourceUnavailableError):
            cache._source_call("parent", replaced)
    else:
        expected = InvalidationReason.LIFECYCLE
        cache._request_stop()
    assert cache.coordinator.epoch == epoch + 1
    assert cache.coordinator.last_reason == expected


def test_scan_and_retry_logs_include_reason_and_stale_turns(sqlite_cache, monkeypatch, caplog):
    import logging

    from app.services.directory_cache import InvalidationReason

    caplog.set_level(logging.DEBUG, logger="app.services.directory_cache")
    cache = sqlite_cache
    cache.coordinator.invalidate(InvalidationReason.WATCHER_START)
    cache.coordinator.invalidate(InvalidationReason.WATCHER_START)
    cache._stale_turns = 2
    cache._schedule_retry()
    retry = next(record for record in caplog.records if getattr(record, "event", None) == "directory_retry_scheduled")
    assert retry.invalidation_reason == "watcher_start"
    assert retry.stale_turns == 2
    invalidations = [record for record in caplog.records if getattr(record, "event", None) == "directory_scan_invalidated"]
    assert [record.invalidation_count for record in invalidations] == [1, 2]
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: (entry for entry in ()))
    cache._scan_disk_queue()
    finished = next(record for record in caplog.records if getattr(record, "event", None) == "directory_scan_finished")
    assert finished.invalidation_reason == "watcher_start"
    assert finished.stale_turns == 0
    assert cache.coordinator.last_reason is None


@pytest.mark.asyncio
@pytest.mark.parametrize("retained", [False, True])
async def test_successful_notification_start_precedes_initial_pass_without_retry(sqlite_cache, monkeypatch, retained):
    from contextlib import asynccontextmanager

    from app.services.directory_cache import InvalidationReason

    cache = sqlite_cache
    if retained:
        cache.index.write_paths(["retained"])
        assert cache.index.finish_generation(1)
    release = threading.Event()
    started = threading.Event()
    initial_epoch = cache.coordinator.epoch

    class Watcher:
        def __init__(self, _handle):
            pass

        def start(self, **kwargs):
            assert cache.coordinator.epoch == initial_epoch
            assert not cache._watcher_ready.is_set()
            started.set()

        def wait(self):
            assert cache.coordinator.last_reason == InvalidationReason.WATCHER_START
            assert cache._watcher_ready.is_set()
            assert cache._watcher_startup_result is True
            assert release.wait(timeout=5)
            return None

    @asynccontextmanager
    async def connected(**kwargs):
        yield

    def scan(path, **kwargs):
        assert started.is_set()
        assert cache._watcher_startup_result is True
        if retained and path == cache._smb_base_path:
            yield SimpleNamespace(name="retained", smb_info=SimpleNamespace(file_attributes=16))

    monkeypatch.setattr(cache, "_initialize_storage", lambda: None)
    monkeypatch.setattr(cache, "_connect_watcher", lambda: setattr(cache, "_watcher_open", SimpleNamespace(close=release.set)))
    monkeypatch.setattr(cache, "_start_periodic_rescan", lambda: None)
    monkeypatch.setattr(cache, "_refresh_connection_generation", AsyncMock())
    monkeypatch.setattr("app.services.directory_cache.FileSystemWatcher", Watcher)
    monkeypatch.setattr(
        "app.services.directory_cache.get_connection_pool", AsyncMock(return_value=SimpleNamespace(get_connection=connected))
    )
    monkeypatch.setattr("smbclient.scandir", scan)
    try:
        await cache._initialize()
        assert cache.index.status().coverage == "complete"
        assert cache.index.status().directory_count == int(retained)
        assert cache._verification_retry_at is None
        assert cache._resource_retry_at == 0
        assert cache.coordinator.epoch == initial_epoch + 1
        assert cache.scan_error is None
        assert cache.last_scan_time is not None
    finally:
        cache._request_stop()
        cache._finish_stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("fallback", ["failure", "timeout"])
async def test_late_watcher_readiness_during_fallback_rejects_old_read_and_recovers(sqlite_cache, monkeypatch, fallback):
    from contextlib import asynccontextmanager

    from app.services.directory_cache import OBSERVATION_RETRY_SECONDS

    cache = sqlite_cache
    cache.index.write_paths(["retained"])
    assert cache.index.finish_generation(1)
    clock = [cache._last_access]
    root_reads = []

    @asynccontextmanager
    async def connected(**kwargs):
        yield

    def scan(path, **kwargs):
        if path == cache._smb_base_path:
            root_reads.append(path)
            if len(root_reads) == 2:
                cache._observation_started()
                cache._watcher_ready.set()
                cache._publish_watcher_startup(True)
            yield SimpleNamespace(name="retained", smb_info=SimpleNamespace(file_attributes=16))

    monkeypatch.setattr(cache, "_initialize_storage", lambda: None)
    monkeypatch.setattr(cache, "_start_watcher", lambda: cache._publish_watcher_startup(False) if fallback == "failure" else None)
    monkeypatch.setattr(cache, "_start_periodic_rescan", lambda: None)
    monkeypatch.setattr(cache, "_refresh_connection_generation", AsyncMock())
    monkeypatch.setattr("app.services.directory_cache.WATCHER_STARTUP_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr("app.services.directory_cache.time.monotonic", lambda: clock[0])
    monkeypatch.setattr(
        "app.services.directory_cache.get_connection_pool", AsyncMock(return_value=SimpleNamespace(get_connection=connected))
    )
    monkeypatch.setattr("smbclient.scandir", scan)
    await cache._initialize()
    assert cache._verification_retry_at == clock[0] + OBSERVATION_RETRY_SECONDS
    assert cache.search_index("retained").total_matches == 1
    assert cache.scan_error is None
    assert cache.monitoring_state == "recovering"
    assert cache.index.has_resumable_scan()
    assert not cache.coordinator._producers
    assert cache._active_workers == 0
    before = len(root_reads)
    await cache._run_rescan()
    assert len(root_reads) == before
    clock[0] += OBSERVATION_RETRY_SECONDS
    await cache._run_rescan()
    assert cache.index.status().coverage == "complete"
    assert cache.monitoring_state == "healthy"
    assert cache.scan_error is None
    assert cache._verification_retry_at is None
    assert not cache._watcher_startup_waiters


def _smb_response_error(status: int) -> SMBResponseException:
    """Build the registered SMB error subtype from an explicit response status."""
    header = SMB2HeaderResponse()
    header["status"] = status
    return SMBResponseException(header)


def test_standard_sqlite_runtime_has_required_features():
    from app.services.directory_index import validate_sqlite_runtime

    validate_sqlite_runtime()


def test_directory_cache_uses_wal_normal_durability(index):
    assert index._connection().execute("PRAGMA journal_mode").fetchone() == ("wal",)
    assert index._connection().execute("PRAGMA synchronous").fetchone() == (1,)


def test_status_poll_does_not_open_sqlite_connection(sqlite_cache, monkeypatch):
    sqlite_cache._source_available.set()
    sqlite_cache.index.write_paths(["retained"])

    def unexpected_connection(*args, **kwargs):
        pytest.fail("Status polls must not open a SQLite connection.")

    monkeypatch.setattr(sqlite_cache.index, "_connect", unexpected_connection)
    statements = []
    sqlite_cache.index._connection().set_trace_callback(statements.append)
    for _ in range(3):
        assert sqlite_cache.search_index("").directory_count == 1
    assert not statements


def test_scan_progress_matches_shared_wire_contract():
    from dataclasses import fields

    from app.core.directory_index_contract import CONTRACT_PATH, ScanProgress
    from app.models.file import DirectorySearchResult

    contract = json.loads(CONTRACT_PATH.read_text())["scan_progress"]
    assert [field.name for field in fields(ScanProgress)] == contract["fields"]
    for phase in contract["phases"]:
        result = DirectorySearchResult(
            results=[],
            total_matches=0,
            cache_state="ready",
            directory_count=0,
            scan_progress=ScanProgress(phase, 1, 2, 3, 4),
        )
        assert result.model_dump()["scan_progress"] == {
            "phase": phase,
            "parents_done": 1,
            "parents_queued": 2,
            "directories_found": 3,
            "started_at_ms": 4,
        }


def test_candidate_progress_survives_an_interrupted_scan(index):
    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    candidate, selected = index.prepare_scan()
    assert not selected
    index.seed_scan(candidate)
    index.write_scan_children(candidate, [("retained", True)])
    index.finish_scan_parent(candidate, "")
    before = index.search("accepted retained")
    assert index.has_resumable_scan()
    assert index.prepare_scan() == (candidate, False)
    assert index.pending_scan_paths(candidate) == ["retained"]
    assert index.search("accepted retained") == before


def test_group_scan_commit_is_atomic_and_retains_uncommitted_work(index):
    index.seed_scan(1)
    index.commit_scan_parents(1, [("", [("parent", True)])])
    assert index.pending_scan_paths(1) == ["parent"]
    index._connection().execute(
        "CREATE TRIGGER reject_group_child BEFORE INSERT ON directories "
        "WHEN new.path = 'parent/refused' BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    with pytest.raises(sqlite3.IntegrityError):
        index.commit_scan_parents(1, [("parent", [("parent/accepted", False), ("parent/refused", False)])])
    assert index.pending_scan_paths(1) == ["parent"]
    assert index.search("accepted").total_matches == 0
    index.close()
    index.open()
    assert index.pending_scan_paths(1) == ["parent"]
    assert index.search("parent").directory_count == 1


@pytest.mark.parametrize("size", [8, 16])
def test_scan_file_ids_survive_deferral_and_reopen(index, size):
    expected = bytes(range(size))
    index.seed_scan(1)
    assert index.scan_parent_file_id(1, "") is None
    index.commit_scan_parents(1, [("", [("parent", True)])], file_ids={"parent": expected})
    assert index.scan_parent_file_id(1, "parent") == expected
    index.finish_scan_parent(1, "parent")
    index.commit_scan_parents(1, [("", [("parent", True)])], file_ids={"parent": expected})
    assert index.pending_scan_paths(1) == []
    replacement = bytes(reversed(expected))
    index.commit_scan_parents(1, [("", [("parent", True)])], file_ids={"parent": replacement})
    assert index.pending_scan_paths(1) == ["parent"]
    index.defer_scan_parent(1, "parent")
    assert index.scan_parent_file_id(1, "parent") == replacement
    with pytest.raises(ValueError, match="8 or 16 bytes"):
        index.commit_scan_parents(1, [("parent", [("parent/refused", True)])], file_ids={"parent/refused": b"invalid"})
    assert index.search("refused").total_matches == 0
    index.close()
    index.open()
    assert index.scan_parent_file_id(1, "parent") == replacement
    assert index.pending_scan_paths(1) == ["parent"]


@pytest.mark.parametrize("processed", [False, True])
@pytest.mark.parametrize("changed", [False, True])
@pytest.mark.parametrize("size", [8, 16])
def test_reconciliation_refreshes_existing_child_file_ids_without_unchanged_writes(index, processed, changed, size):
    old_id = bytes([1]) * size
    new_id = bytes([2]) * size if changed else old_id
    index.write_paths(["parent"])
    assert index.finish_generation(1)
    index.queue_reconciliation_parent(1, "parent")
    index.commit_scan_parents(1, [("parent", [("parent/child", True)])], reconcile=True, file_ids={"parent/child": old_id})
    if processed:
        index.finish_reconciliation_parent(1, "parent/child")
    index.queue_reconciliation_parent(1, "parent")
    connection = index._connection()
    connection.execute("CREATE TEMP TABLE child_queue_writes(count INTEGER)")
    connection.execute("INSERT INTO child_queue_writes VALUES (0)")
    for operation in ("INSERT", "UPDATE"):
        connection.execute(
            f"CREATE TEMP TRIGGER count_child_queue_{operation} AFTER {operation} ON scan_queue "
            "WHEN new.path = 'parent/child' BEGIN UPDATE child_queue_writes SET count = count + 1; END"
        )
    index.commit_scan_parents(1, [("parent", [("parent/child", True)])], reconcile=True, file_ids={"parent/child": new_id})
    assert index.scan_parent_file_id(1, "parent/child") == new_id
    assert index.scan_parent_pending(1, "parent/child") == (changed or not processed)
    assert connection.execute("SELECT count FROM child_queue_writes").fetchone() == (int(changed),)


@pytest.mark.parametrize("queue_exists", [False, True])
@pytest.mark.parametrize("new_id", [None, bytes([2]) * 8])
def test_reconciliation_identity_update_does_not_insert_or_requeue_unknown_identity(index, queue_exists, new_id):
    index.write_paths(["parent", "parent/child"])
    assert index.finish_generation(1)
    if queue_exists:
        index.queue_reconciliation_parent(1, "parent/child")
        index.finish_reconciliation_parent(1, "parent/child")
    index.queue_reconciliation_parent(1, "parent")
    index.commit_scan_parents(
        1, [("parent", [("parent/child", True)])], reconcile=True, file_ids={"parent/child": new_id} if new_id else None
    )
    assert index.scan_parent_file_id(1, "parent/child") == (new_id if queue_exists else None)
    assert not index.scan_parent_pending(1, "parent/child")
    assert index._connection().execute("SELECT count(*) FROM scan_queue WHERE path = 'parent/child'").fetchone() == (int(queue_exists),)


def test_missing_scan_file_id_column_requires_rebuild(index):
    index.write_paths(["untrusted"])
    index._connection().execute("ALTER TABLE scan_queue DROP COLUMN file_id")
    index.close()
    index.open(rebuild_invalid=True)
    assert index.search("untrusted").directory_count == 0
    assert index.scan_parent_file_id(1, "") is None


@pytest.mark.parametrize("candidate", [False, True])
def test_scan_progress_survives_reopen(index, candidate):
    if candidate:
        index.write_paths(["accepted"])
        assert index.finish_generation(1)
    generation, selected = index.prepare_scan()
    index.seed_scan(generation)
    index.write_scan_children(generation, [("retained", True)])
    index.finish_scan_parent(generation, "")
    index.close()
    index.open()
    assert index.prepare_scan() == (generation, selected)
    assert index.pending_scan_paths(generation) == ["retained"]
    assert index._connection().execute("SELECT path FROM directories WHERE generation_id = ? ORDER BY path", (generation,)).fetchall() == (
        [("accepted",), ("retained",)] if candidate else [("retained",)]
    )


def test_completed_scan_revalidation_is_bounded_and_preserves_rows(index):
    from app.services.directory_index import ROW_BATCH_SIZE

    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    candidate, selected = index.prepare_scan()
    assert not selected
    index.seed_scan(candidate)
    paths = [f"child-{number}" for number in range(ROW_BATCH_SIZE + 1)]
    for offset in range(0, len(paths), ROW_BATCH_SIZE):
        index.write_scan_children(candidate, [(path, True) for path in paths[offset : offset + ROW_BATCH_SIZE]])
    for path in ["", *paths]:
        index.finish_scan_parent(candidate, path)
    before = index.search("accepted")
    assert index.requeue_completed_scan_batch(candidate)
    assert len(index.pending_scan_paths(candidate)) == ROW_BATCH_SIZE
    assert not index.requeue_completed_scan_batch(candidate)
    assert (
        index._connection().execute("SELECT count(*) FROM scan_queue WHERE generation_id = ? AND processed = 0", (candidate,)).fetchone()[0]
        == len(paths) + 1
    )
    assert not index.requeue_completed_scan_batch(candidate)
    assert candidate == 1
    assert not index.requeue_completed_scan_batch(1)
    assert index.search("accepted") == before


@pytest.mark.asyncio
async def test_automatic_full_pass_spacing_cannot_be_bypassed_by_requests(sqlite_cache, monkeypatch):
    from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT

    cache = sqlite_cache
    cache.index.write_paths(["retained"])
    assert cache.index.finish_generation(1)
    cache._source_available.set()
    cache._next_full_pass_at = time.monotonic() + DIRECTORY_INDEX_CONTRACT.limits["minimum_full_pass_spacing_seconds"]
    pool = AsyncMock()
    monkeypatch.setattr("app.services.directory_cache.get_connection_pool", pool)
    for _attempt in range(10):
        await cache._run_rescan()
    pool.assert_not_awaited()
    assert cache.index.search("retained").directory_count == 1


def test_reopened_backend_storage_retains_rows_but_not_verified_coverage(sqlite_cache):
    cache = sqlite_cache
    cache.index.write_paths(["retained"])
    assert cache.index.finish_generation(1)
    before = cache.index.search("retained")
    cache.index.close()
    cache._initialize_storage()
    after = cache.index.search("retained")
    assert after.results == before.results
    assert after.coverage == "uncertain"
    assert cache.coordinator.verification_required


def test_directory_storage_events_do_not_expose_paths_or_sql_error_text(index, caplog):
    import logging

    from app.services.directory_index import transaction

    caplog.set_level(logging.DEBUG, logger="app.services.directory_index")
    index.close()
    index.open()
    index.write_paths(["private-directory-term"])
    assert index.finish_generation(1)
    before = index.search("private-directory-term")
    index.checkpoint()
    with pytest.raises(sqlite3.DatabaseError):
        with transaction(index._connection()) as writer:
            writer.execute("SELECT * FROM private_sql_error_text")
    assert index.search("private-directory-term") == before
    events = {getattr(record, "event", None) for record in caplog.records}
    assert {
        "directory_storage_initialized",
        "directory_transaction_failed",
        "directory_generation_accepted",
        "directory_checkpoint_completed",
    } <= events
    assert "directory_transaction_completed" not in events
    payload = " ".join(str(record.__dict__) for record in caplog.records)
    assert str(index.path) not in payload
    assert "private-directory-term" not in payload
    assert "private_sql_error_text" not in payload


def test_idle_directory_transactions_are_quiet_but_slow_work_is_reported(index, caplog, monkeypatch):
    import logging

    from app.services.directory_index import transaction

    connection = index._connection()
    caplog.set_level(logging.DEBUG, logger="app.services.directory_index")
    for _ in range(10):
        with transaction(connection) as reader:
            reader.execute("SELECT 1").fetchall()
    assert not caplog.records
    clock = iter((0.0, 2.0))
    monkeypatch.setattr("app.services.directory_index.time.monotonic", lambda: next(clock))
    with transaction(connection) as reader:
        reader.execute("SELECT 1").fetchall()
    assert len(caplog.records) == 1
    assert caplog.records[0].event == "directory_transaction_slow"
    assert caplog.records[0].duration_ms == 2000


def test_directory_query_connection_is_read_only(index):
    assert isinstance(index._connection(), sqlite3.Connection)
    with closing(index._connect(readonly=True)) as reader:
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            reader.execute("UPDATE source_metadata SET accepted_revision = accepted_revision + 1")
    assert index.status().accepted_revision == 0


def test_directory_read_transaction_keeps_metadata_and_rows_consistent(index):
    from app.services.directory_index import transaction

    index.write_paths(["accepted"])
    with closing(index._connect(readonly=True)) as reader, transaction(reader):
        before = reader.execute("SELECT accepted_revision FROM source_metadata").fetchone()
        index.write_paths(["new"])
        assert reader.execute("SELECT accepted_revision FROM source_metadata").fetchone() == before
        assert reader.execute("SELECT path FROM directories ORDER BY path").fetchall() == [("accepted",)]
    assert index.search("accepted new").total_matches == 2
    assert index.status().accepted_revision == before[0] + 1


def test_directory_checkpoint_uses_writer_connection_and_lock(index):
    entered = threading.Event()
    statements = []
    writer = index._connection()
    writer.set_trace_callback(statements.append)

    def checkpoint():
        entered.set()
        index.checkpoint()

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            with index._writer_lock:
                pending = executor.submit(checkpoint)
                assert entered.wait(timeout=5)
                with pytest.raises(TimeoutError):
                    pending.result(timeout=0.05)
                assert not statements
            pending.result(timeout=5)
        assert statements == ["PRAGMA wal_checkpoint(PASSIVE)"]
    finally:
        writer.set_trace_callback(None)


def test_inactive_cleanup_defers_deletion_for_pinned_reader(index):
    from app.services.directory_index import transaction
    from app.services.directory_index_resources import DirectoryIndexResources

    resources = DirectoryIndexResources(index.path.parent)
    index.write_paths(["accepted"])
    with closing(index._connect(readonly=True)) as reader, transaction(reader):
        accessed = reader.execute("SELECT last_access_at_ms FROM source_metadata").fetchone()[0]
        index.write_paths(["new"])
        index.close()
        assert not resources._delete_inactive(index.path, accessed)
        assert index.path.is_file()
        assert reader.execute("SELECT path FROM directories ORDER BY path").fetchall() == [("accepted",)]
    assert resources._delete_inactive(index.path, accessed)
    assert not index.path.exists()


def test_shared_resource_contract_defaults_and_bounds():
    from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT

    assert DIRECTORY_INDEX_CONTRACT.limits["row_batch_size"] == 256
    assert DIRECTORY_INDEX_CONTRACT.policy["disk_budget_bytes"].default == 2 * 1024 * 1024 * 1024
    assert DIRECTORY_INDEX_CONTRACT.policy["inactive_retention_seconds"].default == 7 * 24 * 60 * 60
    assert DIRECTORY_INDEX_CONTRACT.policy["max_retained_inactive_sources"].default == 4
    for field in DIRECTORY_INDEX_CONTRACT.policy.values():
        assert field.validate(field.default) == field.default
        with pytest.raises(ValueError):
            field.validate(0)
        with pytest.raises(ValueError):
            field.validate(True)


def test_directory_disk_accounting_includes_wal_work_and_legacy_files(tmp_path):
    from app.services.directory_index_resources import DirectoryIndexResources

    root = tmp_path / "cache"
    namespace = root / "sqlite"
    namespace.mkdir(parents=True)
    for name in ("source.sqlite3", "source.sqlite3-wal", "source.sqlite3-shm", "source.sqlite3-journal", "temporary.work"):
        (namespace / name).write_bytes(b"1234")
    (root / "legacy.idx").write_bytes(b"123")
    (root / "legacy.bak").write_bytes(b"12")
    resources = DirectoryIndexResources(namespace)
    assert resources.usage().managed_bytes == 25


def test_legacy_retirement_is_bounded_and_preserves_recent_writer_work(tmp_path):
    from uuid import UUID

    from app.services.directory_index_resources import LEASE_CLEANUP_BATCH, DirectoryIndexResources

    root = tmp_path / "cache"
    namespace = root / "sqlite"
    namespace.mkdir(parents=True, mode=0o700)
    resources = DirectoryIndexResources(namespace)
    snapshots = [root / f"{UUID(int=number + 1)}.idx" for number in range(LEASE_CLEANUP_BATCH + 1)]
    for path in snapshots:
        path.write_bytes(b"obsolete snapshot; never import")
    backup = root / f"{UUID(int=1)}.bak"
    backup.write_bytes(b"obsolete backup")
    recent = root / ".1234abcd_abcdefgh.tmp"
    stale = root / ".1234abcd_ijklmnop.tmp"
    unrelated = root / "unrelated.idx"
    for path in (recent, stale, unrelated):
        path.write_bytes(b"preserve unless eligible")
    now = int(time.time() * 1000)
    expired = now / 1000 - resources.policy.inactive_retention_seconds - 1
    os.utime(stale, (expired, expired))
    assert resources.cleanup_inactive(now_ms=now) == LEASE_CLEANUP_BATCH
    assert resources._next_cleanup_at == 0
    assert recent.is_file() and unrelated.is_file()
    assert resources.cleanup_inactive(now_ms=now) == 3
    assert not any(path.exists() for path in (*snapshots, backup, stale))
    assert recent.read_bytes() == unrelated.read_bytes() == b"preserve unless eligible"


def test_older_snapshot_writer_cannot_change_active_sqlite_results(sqlite_cache):
    from uuid import UUID

    cache = sqlite_cache
    cache.index.write_paths(["accepted/child"])
    assert cache.index.finish_generation(1)
    before = cache.index.search("accepted")
    legacy = cache._persist_path.parent.parent / f"{UUID(int=1)}.idx"
    for _ in range(2):
        legacy.write_bytes(b'old writer data: {"p":"unverified"}\n')
        assert cache.resources.cleanup_legacy() == 1
        assert not legacy.exists()
        assert cache.index.search("accepted") == before
        assert cache.index.search("unverified").total_matches == 0
        assert cache.index.path.is_file()


def test_legacy_cleanup_does_not_block_private_namespace_under_sticky_parent(tmp_path):
    from uuid import UUID

    from app.services.directory_index_resources import DirectoryIndexResources

    root = tmp_path / "shared"
    root.mkdir()
    root.chmod(0o1777)
    namespace = root / "private"
    namespace.mkdir(mode=0o700)
    legacy = root / f"{UUID(int=1)}.idx"
    legacy.write_bytes(b"not owned by the private namespace")
    resources = DirectoryIndexResources(namespace)
    with resources.reserve_growth():
        assert legacy.is_file()
    assert resources.usage().reserved_bytes == 0


def test_legacy_cleanup_can_retry_after_unlink_failure(sqlite_cache, monkeypatch):
    from uuid import UUID

    cache = sqlite_cache
    cache.index.write_paths(["accepted"])
    assert cache.index.finish_generation(1)
    before = cache.index.search("accepted")
    legacy = cache._persist_path.parent.parent / f"{UUID(int=1)}.idx"
    legacy.write_bytes(b"obsolete")
    original = os.unlink

    def denied(name, **kwargs):
        if name == legacy.name:
            raise PermissionError("private path must not enter query status")
        return original(name, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr("app.services.directory_index_resources.os.unlink", denied)
        assert cache.resources.cleanup_legacy() == 0
        assert legacy.is_file()
        assert cache.index.search("accepted") == before
    assert cache.resources.cleanup_legacy() == 1
    assert cache.index.search("accepted") == before


@pytest.mark.parametrize("kind", ["link", "hard_link", "directory", "foreign_owner"])
def test_legacy_retirement_preserves_unsafe_or_unowned_entries(tmp_path, monkeypatch, kind):
    from uuid import UUID

    from app.services.directory_index_resources import DirectoryIndexResources

    namespace = tmp_path / "sqlite"
    namespace.mkdir(mode=0o700)
    legacy = tmp_path / f"{UUID(int=1)}.idx"
    target = tmp_path / "unrelated"
    target.write_bytes(b"must survive")
    if kind == "link":
        legacy.symlink_to(target)
    elif kind == "hard_link":
        os.link(target, legacy)
    elif kind == "directory":
        legacy.mkdir()
    else:
        legacy.write_bytes(b"foreign")
        original = os.scandir

        @contextmanager
        def entries(descriptor):
            with original(descriptor) as iterator:
                yield (
                    SimpleNamespace(
                        name=entry.name,
                        stat=lambda **_kwargs: SimpleNamespace(st_mode=stat.S_IFREG, st_uid=os.getuid() + 1, st_nlink=1),
                    )
                    for entry in iterator
                )

        monkeypatch.setattr("app.services.directory_index_resources.os.scandir", entries)
    assert DirectoryIndexResources(namespace).cleanup_legacy() == 0
    assert legacy.exists()
    assert target.read_bytes() == b"must survive"


@pytest.mark.skipif(os.name != "posix", reason="Unix hard-link qualification")
@pytest.mark.parametrize("suffix", ["", ".lease", "-wal", "-shm"])
def test_hard_linked_database_and_sidecars_are_rejected(index, suffix):
    alias = index.path.parent / "alias.data"
    os.link(Path(str(index.path) + suffix), alias)
    other = DirectoryIndex(index.path, source_kind=index.source_kind, source_identity=json.loads(index.source_identity))
    try:
        with pytest.raises(PermissionError, match="hard links"):
            other.open()
        with pytest.raises(PermissionError, match="hard links"):
            index.search("")
    finally:
        alias.unlink()
    assert index.search("").directory_count == 0


@pytest.mark.skipif(os.name != "posix", reason="Unix database-open ownership policy")
@pytest.mark.parametrize("change", ["alias", "database_permissions", "namespace_permissions"])
def test_database_open_revalidates_private_storage_after_connect(index, monkeypatch, change):
    from app.services.directory_index import connect_directory_database

    index.write_paths(["accepted"])
    before = index.search("accepted")
    database_mode = stat.S_IMODE(index.path.stat().st_mode)
    namespace_mode = stat.S_IMODE(index.path.parent.stat().st_mode)
    alias = index.path.parent / "alias.data"
    connections = []
    original = sqlite3.connect

    def connect(*args, **kwargs):
        connection = original(*args, **kwargs)
        connections.append(connection)
        if change == "alias":
            os.link(index.path, alias)
        elif change == "database_permissions":
            index.path.chmod(database_mode | stat.S_IWGRP)
        else:
            index.path.parent.chmod(namespace_mode | stat.S_IRGRP)
        return connection

    try:
        with monkeypatch.context() as patch:
            patch.setattr(sqlite3, "connect", connect)
            with pytest.raises(PermissionError):
                connect_directory_database(index.path, readonly=True)
        assert len(connections) == 1
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            connections[0].execute("SELECT 1")
    finally:
        for connection in connections:
            connection.close()
        alias.unlink(missing_ok=True)
        index.path.chmod(database_mode)
        index.path.parent.chmod(namespace_mode)
    assert index.search("accepted") == before


@pytest.mark.parametrize(
    "corruption",
    [
        "UPDATE generations SET indexed_count = 1 WHERE id = 1",
        "UPDATE generations SET issue_count = 1 WHERE id = 1",
        "INSERT INTO generations(state, coverage) VALUES ('building', 'partial')",
        "UPDATE source_metadata SET selected_generation = NULL WHERE id = 1",
    ],
)
def test_startup_rejects_inconsistent_counts_and_unpublished_selection(index, corruption):
    index._connection().execute(corruption)
    index.close()
    with pytest.raises(ValueError, match="generation metadata"):
        index.open()


@pytest.mark.skipif(os.name != "posix", reason="Unix directory ownership policy")
@pytest.mark.parametrize("mode", [0o777, 0o775])
def test_namespace_lease_rejects_replaceable_ancestors_before_creation(tmp_path, mode):
    parent = tmp_path / "replaceable"
    parent.mkdir(mode=mode)
    parent.chmod(mode)
    namespace = parent / "private"
    with pytest.raises(PermissionError, match="unsafe ancestor"):
        DirectoryIndex.acquire_namespace_lease(namespace)
    assert not namespace.exists()


@pytest.mark.skipif(os.name != "posix", reason="Unix directory ownership policy")
def test_namespace_lease_accepts_trusted_sticky_ancestors(tmp_path):
    parent = tmp_path / "sticky"
    parent.mkdir()
    parent.chmod(0o1777)
    descriptor = DirectoryIndex.acquire_namespace_lease(parent / "private")
    os.close(descriptor)


@pytest.mark.skipif(os.name != "posix", reason="Unix directory ownership policy")
def test_namespace_lease_rejects_foreign_owned_ancestors(tmp_path, monkeypatch):
    parent = tmp_path / "foreign"
    parent.mkdir()
    original = Path.lstat

    def metadata(path, *args, **kwargs):
        information = original(path, *args, **kwargs)
        if path == parent:
            return SimpleNamespace(st_mode=information.st_mode, st_uid=os.getuid() + 1)
        return information

    monkeypatch.setattr(Path, "lstat", metadata)
    with pytest.raises(PermissionError, match="unsafe ancestor"):
        DirectoryIndex.acquire_namespace_lease(parent / "private")
    assert not (parent / "private").exists()


@pytest.mark.skipif(os.name != "posix", reason="Unix directory ownership policy")
def test_readonly_queries_recheck_private_namespace_permissions(index):
    namespace = index.path.parent
    original_mode = namespace.stat().st_mode & 0o777
    index.write_paths(["accepted"])
    before = index.search("accepted")
    namespace.chmod(0o755)
    try:
        with pytest.raises(PermissionError, match="0700"):
            index.search("accepted")
    finally:
        namespace.chmod(original_mode)
    assert index.search("accepted") == before


@pytest.mark.parametrize("incompatible", ["schema", "normalization", "traversal"])
def test_rebuildable_database_validation_has_a_distinct_error_and_releases_ownership(index, incompatible):
    from app.services.directory_index import SCHEMA_VERSION, DirectoryIndexRebuildRequired

    index._connection().execute("PRAGMA ignore_check_constraints = ON")
    if incompatible == "schema":
        index._connection().execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
    elif incompatible == "normalization":
        index._connection().execute("UPDATE source_metadata SET normalization_version = normalization_version + 1")
    else:
        index._connection().execute("UPDATE source_metadata SET traversal_version = traversal_version + 1")
    index._connection().execute("PRAGMA ignore_check_constraints = OFF")
    index.close()
    with pytest.raises(DirectoryIndexRebuildRequired):
        index.open()
    assert index._writer is None
    assert index._lease_fd is None


def test_wrong_source_database_is_not_classified_for_automatic_replacement(index):
    from app.services.directory_index import DirectoryIndexRebuildRequired

    index._connection().execute("UPDATE source_metadata SET source_identity = ?", ('{"different":true}',))
    index.close()
    with pytest.raises(ValueError) as caught:
        index.open()
    assert not isinstance(caught.value, DirectoryIndexRebuildRequired)
    assert index._writer is None
    assert index._lease_fd is None


def test_invalid_database_quarantine_keeps_source_ownership_and_bounds_retention(index):
    from app.services.directory_index import QUARANTINE_FILE_NAME

    index.write_paths(["accepted"])
    index.close()
    original = index.path.read_bytes()
    rejected = index.path.parent / QUARANTINE_FILE_NAME
    index._acquire_storage()
    try:
        index._quarantine_owned()
        assert not index.path.exists()
        assert rejected.read_bytes() == original
        assert index._lease_fd is not None
        with pytest.raises(BlockingIOError):
            DirectoryIndex.acquire_storage_lease(index.path)
    finally:
        index._release_storage()
    assert DirectoryIndex.discard_quarantine(index.path.parent)
    assert not DirectoryIndex.discard_quarantine(index.path.parent)
    assert not rejected.exists()


@pytest.mark.skipif(os.name != "posix", reason="Descriptor-relative cleanup requires POSIX.")
@pytest.mark.parametrize("replacement", ["link", "directory"])
def test_quarantine_cleanup_refuses_replaced_namespace(index, monkeypatch, replacement):
    from app.services.directory_index import QUARANTINE_FILE_NAME

    index.write_paths(["retained"])
    index.close()
    namespace = index.path.parent
    original = namespace.with_name(f"{namespace.name}-original")
    unrelated = namespace.with_name(f"{namespace.name}-unrelated")
    unrelated.mkdir(mode=0o700)
    rejected = namespace / QUARANTINE_FILE_NAME
    rejected.write_bytes(b"rejected data")
    victim = unrelated / QUARANTINE_FILE_NAME
    victim.write_bytes(b"unrelated data")
    validate = DirectoryIndex._validate_storage_files

    def replace_after_validation(path):
        validate(path)
        if path == rejected:
            namespace.rename(original)
            if replacement == "link":
                namespace.symlink_to(unrelated, target_is_directory=True)
            else:
                unrelated.rename(namespace)

    with monkeypatch.context() as patch:
        patch.setattr(DirectoryIndex, "_validate_storage_files", replace_after_validation)
        try:
            with pytest.raises(PermissionError):
                DirectoryIndex._clear_quarantine_owned(rejected)
            assert (original / QUARANTINE_FILE_NAME).read_bytes() == b"rejected data"
            assert rejected.read_bytes() == b"unrelated data"
        finally:
            if replacement == "link":
                namespace.unlink()
            else:
                namespace.rename(unrelated)
            original.rename(namespace)
    assert victim.read_bytes() == b"unrelated data"
    index.open()
    assert index.search("retained").total_matches == 1


def test_quarantine_move_failure_restores_original_sidecars_and_preserves_error(index, monkeypatch):
    import app.services.directory_index as directory_index

    index.close()
    sidecar = Path(str(index.path) + "-journal")
    sidecar.write_bytes(b"rejected journal")
    original = index.path.read_bytes()
    journal = sidecar.read_bytes()
    replace = os.replace
    failure = PermissionError("Injected main-file move refusal.")

    def move(source, target, **kwargs):
        if source in (index.path, index.path.name):
            raise failure
        return replace(source, target, **kwargs)

    monkeypatch.setattr(directory_index.os, "replace", move)
    index._acquire_storage()
    try:
        with pytest.raises(PermissionError) as caught:
            index._quarantine_owned()
        assert caught.value is failure
        assert index.path.read_bytes() == original
        assert sidecar.read_bytes() == journal
        assert index._lease_fd is not None
    finally:
        index._release_storage()
        sidecar.unlink()


@pytest.mark.parametrize("invalid", ["schema", "not_database", "generation", "metadata", "normalization", "traversal", "scan_queue"])
def test_invalid_directory_database_rebuilds_once_without_serving_rejected_rows(index, monkeypatch, invalid):
    from app.services.directory_index import QUARANTINE_FILE_NAME, SCHEMA_VERSION

    index.write_paths(["rejected"])
    assert index.finish_generation(1)
    if invalid == "schema":
        index._connection().execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
    elif invalid == "generation":
        index._connection().execute("UPDATE generations SET indexed_count = indexed_count + 1")
    elif invalid == "metadata":
        index._connection().execute("DELETE FROM source_metadata")
    elif invalid == "scan_queue":
        index._connection().execute("DROP TABLE scan_queue")
    elif invalid in {"normalization", "traversal"}:
        index._connection().execute("PRAGMA ignore_check_constraints = ON")
        column = "normalization_version" if invalid == "normalization" else "traversal_version"
        index._connection().execute(f"UPDATE source_metadata SET {column} = {column} + 1")
        index._connection().execute("PRAGMA ignore_check_constraints = OFF")
    index.close()
    if invalid == "not_database":
        index.path.write_bytes(b"not a SQLite directory database")
    rejected = index.path.read_bytes()
    original = index._open_owned

    def open_while_owned():
        assert index._lease_fd is not None
        with pytest.raises(BlockingIOError):
            DirectoryIndex.acquire_storage_lease(index.path)
        original()

    monkeypatch.setattr(index, "_open_owned", open_while_owned)
    index.open(rebuild_invalid=True)
    assert index.search("rejected").total_matches == 0
    assert index.status().coverage == "partial"
    assert index.status().last_verified_at_ms is None
    assert index._recovery_attempted
    assert (index.path.parent / QUARANTINE_FILE_NAME).read_bytes() == rejected
    assert index._lease_fd is not None
    index.write_paths(["fresh"])
    assert index.finish_generation(1)
    assert index.search("fresh").total_matches == 1


@pytest.mark.parametrize("wrong", ["application", "source"])
def test_automatic_recovery_refuses_unrelated_or_wrong_source_files(index, wrong):
    from app.services.directory_index import APPLICATION_ID, QUARANTINE_FILE_NAME

    if wrong == "application":
        index._connection().execute(f"PRAGMA application_id = {APPLICATION_ID + 1}")
    else:
        index._connection().execute("UPDATE source_metadata SET source_identity = ?", ('{"unrelated":true}',))
    index.close()
    before = index.path.read_bytes()
    with pytest.raises(ValueError):
        index.open(rebuild_invalid=True)
    assert index.path.read_bytes() == before
    assert not (index.path.parent / QUARANTINE_FILE_NAME).exists()
    assert not index._recovery_attempted
    assert index._lease_fd is None


@pytest.mark.parametrize("code", [sqlite3.SQLITE_FULL, sqlite3.SQLITE_IOERR, sqlite3.SQLITE_READONLY, None])
def test_recovery_never_discards_data_after_storage_refusal(index, monkeypatch, code):
    from app.services.directory_index import QUARANTINE_FILE_NAME

    index.close()
    before = index.path.read_bytes()
    if code is None:
        failure = PermissionError("Injected permission refusal.")
    else:
        failure = sqlite3.OperationalError("Injected SQLite storage refusal.")
        failure.sqlite_errorcode = code

    def refuse():
        raise failure

    monkeypatch.setattr(index, "_open_owned", refuse)
    with pytest.raises(type(failure)) as caught:
        index.open(rebuild_invalid=True)
    assert caught.value is failure
    assert index.path.read_bytes() == before
    assert not (index.path.parent / QUARANTINE_FILE_NAME).exists()
    assert not index._recovery_attempted
    assert index._lease_fd is None


def test_recovery_does_not_replace_valid_rows_during_derived_fts_repair(index):
    from dataclasses import replace

    from app.services.directory_index import QUARANTINE_FILE_NAME

    index.write_paths(["accepted", "accepted/child"])
    assert index.finish_generation(1)
    before = index.search("accepted")
    index._connection().execute("DROP TABLE directory_fts")
    index.close()
    index.open(rebuild_invalid=True)
    assert index.needs_fts_repair
    assert replace(index.search("accepted"), query_plan=before.query_plan) == before
    assert not (index.path.parent / QUARANTINE_FILE_NAME).exists()
    assert not index._recovery_attempted


def test_fts_setup_corruption_cannot_trigger_replacement_of_validated_rows(index, monkeypatch):
    from app.services.directory_index import QUARANTINE_FILE_NAME

    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    before = index.search("accepted")
    index.close()
    original = index._prepare_fts

    def fail(_connection, **_kwargs):
        error = sqlite3.DatabaseError("Injected derived-token reset corruption.")
        error.sqlite_errorcode = sqlite3.SQLITE_CORRUPT
        raise error

    monkeypatch.setattr(index, "_prepare_fts", fail)
    with pytest.raises(RuntimeError, match="Validated directory data was retained"):
        index.open(rebuild_invalid=True)
    assert not (index.path.parent / QUARANTINE_FILE_NAME).exists()
    assert not index._recovery_attempted
    monkeypatch.setattr(index, "_prepare_fts", original)
    index.open(rebuild_invalid=True)
    assert index.search("accepted") == before


def test_failed_replacement_is_not_discarded_again_on_retry(index, monkeypatch):
    from app.services.directory_index import QUARANTINE_FILE_NAME, DirectoryIndexRebuildRequired

    index.close()
    before = index.path.read_bytes()
    calls = 0

    def fail():
        nonlocal calls
        calls += 1
        if calls == 2:
            error = sqlite3.OperationalError("Injected replacement storage failure.")
            error.sqlite_errorcode = sqlite3.SQLITE_IOERR
            raise error
        raise DirectoryIndexRebuildRequired("Injected invalid directory metadata.")

    monkeypatch.setattr(index, "_open_owned", fail)
    with pytest.raises(sqlite3.OperationalError):
        index.open(rebuild_invalid=True)
    assert index._recovery_attempted
    rejected = index.path.parent / QUARANTINE_FILE_NAME
    assert rejected.read_bytes() == before
    with pytest.raises(RuntimeError, match="already failed after replacement"):
        index.open(rebuild_invalid=True)
    assert calls == 3
    assert rejected.read_bytes() == before
    assert index._lease_fd is None


@pytest.mark.parametrize("sidecar_only", [False, True])
def test_pressure_cleanup_accounts_for_quarantine_and_preserves_active_rows(index, sidecar_only):
    from app.services.directory_index import QUARANTINE_FILE_NAME
    from app.services.directory_index_resources import DirectoryIndexResources

    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    before = index.search("accepted")
    resources = DirectoryIndexResources(index.path.parent)
    resources.register_source(index.path)
    before_bytes = resources.usage().managed_bytes
    rejected = index.path.parent / QUARANTINE_FILE_NAME
    if sidecar_only:
        rejected = Path(str(rejected) + "-journal")
    content = b"rejected disposable bytes"
    rejected.write_bytes(content)
    assert resources.usage().managed_bytes == before_bytes + len(content)
    resources.cleanup_inactive(pressure=False)
    assert rejected.read_bytes() == content
    resources.cleanup_inactive(pressure=True)
    assert not rejected.exists()
    assert index.search("accepted") == before
    assert resources.usage().managed_bytes == before_bytes


def test_pressure_cleanup_defers_owned_quarantine(index):
    from app.services.directory_index import QUARANTINE_FILE_NAME
    from app.services.directory_index_resources import DirectoryIndexResources

    resources = DirectoryIndexResources(index.path.parent)
    rejected = index.path.parent / QUARANTINE_FILE_NAME
    rejected.write_bytes(b"rejected")
    descriptor = DirectoryIndex.acquire_storage_lease(rejected)
    try:
        resources.cleanup_inactive(pressure=True)
        assert rejected.read_bytes() == b"rejected"
    finally:
        os.close(descriptor)
    resources.cleanup_inactive(pressure=True)
    assert not rejected.exists()


@pytest.mark.asyncio
async def test_backend_initialization_recovers_disposable_corruption_off_loop(sqlite_cache, monkeypatch):
    import threading
    from unittest.mock import AsyncMock

    cache = sqlite_cache
    cache.index.close()
    cache.index.path.write_bytes(b"corrupt disposable catalogue")
    cache._opened.clear()
    original = cache.index._open_owned
    loop_thread = threading.get_ident()
    threads = []

    def opened():
        threads.append(threading.get_ident())
        original()

    monkeypatch.setattr(cache.index, "_open_owned", opened)
    monkeypatch.setattr(cache, "_start_watcher", lambda: None)
    monkeypatch.setattr(cache, "_start_periodic_rescan", lambda: None)
    monkeypatch.setattr(cache, "_run_rescan", AsyncMock())
    await cache.start_scan()
    await cache._scan_task
    assert threads and all(thread != loop_thread for thread in threads)
    assert cache._opened.is_set()
    assert cache.index._recovery_attempted
    assert cache.index.status().directory_count == 0
    assert cache._active_workers == 0
    assert cache.resources.usage().reserved_bytes == 0


@pytest.mark.asyncio
async def test_sqlite_worker_never_uses_legacy_scans_or_snapshot_import(sqlite_cache, monkeypatch):
    from app.services.directory_cache import ConnectionDirectoryCache

    cache = sqlite_cache

    for method in ("_run_scan", "_scan_single_directory", "load_from_disk", "_load_snapshot_file", "save_to_disk"):
        assert not hasattr(ConnectionDirectoryCache, method)
        assert not hasattr(cache, method)
    assert not hasattr(cache, "_directories")
    assert not hasattr(cache, "_rescan_changes")
    monkeypatch.setattr(cache, "_start_watcher", lambda: None)
    monkeypatch.setattr(cache, "_start_periodic_rescan", lambda: None)
    monkeypatch.setattr("smbclient.scandir", lambda *_args, **_kwargs: (entry for entry in ()))
    await cache._blocking(cache._scan_disk_queue)
    assert cache.index.status().coverage == "complete"
    assert cache.index.status().directory_count == 0
    assert cache.index.search("").total_matches == 0


def test_namespace_lease_serializes_source_lease_creation(tmp_path):
    import os

    namespace = tmp_path / "private"
    source = DirectoryIndex(namespace / "source.sqlite3", source_kind="smb", source_identity={"id": "fixture"})
    descriptor = DirectoryIndex.acquire_namespace_lease(namespace)
    try:
        with pytest.raises(BlockingIOError):
            source.open()
    finally:
        os.close(descriptor)
    source.open()
    try:
        assert source.search("").directory_count == 0
    finally:
        source.close()


@pytest.mark.skipif(os.name != "posix", reason="Descriptor-relative backend cleanup uses the Debian filesystem API")
@pytest.mark.parametrize("replacement", ["namespace_link", "namespace_directory", "database", "sidecar_link"])
def test_inactive_deletion_refuses_replaced_storage_without_deleting_unrelated_files(index, monkeypatch, replacement):
    from app.services.directory_index import connect_directory_database
    from app.services.directory_index_resources import DirectoryIndexResources

    index.write_paths(["retained"])
    assert index.finish_generation(1)
    namespace = index.path.parent
    resources = DirectoryIndexResources(namespace)
    index.close()
    accessed = resources._inactive_access(index.path)
    assert isinstance(accessed, int)
    unrelated = namespace.with_name(f"{namespace.name}-unrelated")
    unrelated.mkdir(mode=0o700)
    victim = unrelated / index.path.name
    contents = b"Unrelated data must not be deleted."
    victim.write_bytes(contents)
    original_namespace = namespace.with_name(f"{namespace.name}-original")
    original_database = namespace / "original-source.sqlite3"
    sidecar = Path(str(index.path) + "-journal")
    original_connect = connect_directory_database

    def connect_and_replace(path, **kwargs):
        connection = original_connect(path, **kwargs)

        def close():
            connection.close()
            if replacement.startswith("namespace"):
                namespace.rename(original_namespace)
                if replacement == "namespace_link":
                    namespace.symlink_to(unrelated, target_is_directory=True)
                else:
                    unrelated.rename(namespace)
            elif replacement == "database":
                index.path.rename(original_database)
                index.path.write_bytes(contents)
            else:
                sidecar.symlink_to(victim)

        return SimpleNamespace(execute=connection.execute, close=close)

    monkeypatch.setattr("app.services.directory_index_resources.connect_directory_database", connect_and_replace)
    try:
        with pytest.raises(PermissionError):
            resources._delete_inactive(index.path, accessed)
    finally:
        if namespace.is_symlink():
            namespace.unlink()
            original_namespace.rename(namespace)
        elif original_namespace.exists():
            namespace.rename(unrelated)
            original_namespace.rename(namespace)
        if original_database.exists():
            index.path.unlink()
            original_database.rename(index.path)
        if sidecar.is_symlink():
            sidecar.unlink()
    assert victim.read_bytes() == contents
    index.open()
    assert index.search("retained").total_matches == 1


def test_inactive_retention_count_and_leases_preserve_active_sources(tmp_path):
    from app.models.system_settings import DirectoryIndexPolicy
    from app.services.directory_index_resources import DirectoryIndexResources

    namespace = tmp_path / "private"
    indexes = []
    for position, character in enumerate("abc", start=1):
        source = DirectoryIndex(namespace / f"{character * 64}.sqlite3", source_kind="smb", source_identity={"id": character})
        source.open()
        source.write_paths(["accepted"])
        source._connection().execute("UPDATE source_metadata SET last_access_at_ms = ? WHERE id = 1", (position * 1000,))
        indexes.append(source)
    indexes[0].close()
    indexes[1].close()
    resources = DirectoryIndexResources(namespace, DirectoryIndexPolicy(max_retained_inactive_sources=1))
    try:
        assert resources.cleanup_inactive(now_ms=4000) == 1
        assert not indexes[0].path.exists()
        assert indexes[1].path.exists()
        assert indexes[2].path.exists()
        assert indexes[2].search("accepted").total_matches == 1
        resources.register_source(indexes[1].path)
        assert resources.cleanup_inactive(now_ms=1_000_000_000) == 0
        resources.release_source(indexes[1].path)
        assert resources.cleanup_inactive(now_ms=1_000_000_000) == 1
        assert indexes[2].search("accepted").total_matches == 1
    finally:
        for source in indexes:
            source.close()


def test_orphan_lease_cleanup_is_bounded_and_preserves_owners_and_sidecars(tmp_path):
    import os

    from app.services.directory_index_resources import LEASE_CLEANUP_BATCH, DirectoryIndexResources

    namespace = tmp_path / "private"
    namespace.mkdir(mode=0o700)
    resources = DirectoryIndexResources(namespace)
    for number in range(LEASE_CLEANUP_BATCH + 2):
        (namespace / f"{number:064x}.sqlite3.lease").write_bytes(b"")
    held = namespace / f"{'b' * 64}.sqlite3"
    descriptor = DirectoryIndex.acquire_storage_lease(held)
    sidecar = namespace / f"{'c' * 64}.sqlite3"
    Path(str(sidecar) + ".lease").write_bytes(b"")
    Path(str(sidecar) + "-wal").write_bytes(b"held")
    admitted = namespace / f"{'d' * 64}.sqlite3"
    Path(str(admitted) + ".lease").write_bytes(b"")
    resources.register_source(admitted)
    try:
        namespace_descriptor = DirectoryIndex.acquire_namespace_lease(namespace)
        try:
            assert resources.cleanup_orphan_leases() == 0
        finally:
            os.close(namespace_descriptor)
        assert resources.cleanup_orphan_leases() == LEASE_CLEANUP_BATCH
        assert resources.cleanup_orphan_leases() == 2
        assert Path(str(held) + ".lease").exists()
        assert Path(str(sidecar) + ".lease").exists()
        assert Path(str(admitted) + ".lease").exists()
    finally:
        os.close(descriptor)
        resources.release_source(admitted)
    assert resources.cleanup_orphan_leases() == 2
    assert Path(str(sidecar) + ".lease").exists()


def test_source_registration_survives_previous_owner_release(tmp_path):
    from app.services.directory_index_resources import DirectoryIndexResources

    resources = DirectoryIndexResources(tmp_path / "sqlite")
    path = resources.namespace / "source.sqlite3"
    resources.register_source(path)
    resources.register_source(path)
    resources.release_source(path)
    assert resources.active_paths[path] == 1
    resources.release_source(path)
    assert path not in resources.active_paths


def test_incremental_reclamation_preserves_results_and_verification(index):
    from app.services.directory_index import ROW_BATCH_SIZE

    index.write_paths(f"old/{number}/{'long-name-' * 100}" for number in range(ROW_BATCH_SIZE * 2))
    index.finish_generation(1)
    candidate = index.prepare_scan()[0]
    index.mutate_path("remove", "old")
    index.write_paths(["selected"], generation_id=candidate)
    index.finish_generation(candidate)
    before = index.search("selected")
    pages_before = index._connection().execute("PRAGMA page_count").fetchone()[0]
    assert index._connection().execute("PRAGMA freelist_count").fetchone()[0] > 0
    with closing(index._connect(readonly=True)) as reader:
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM directories").fetchone()
        index.touch_access(1)
        assert not index.reclaim_pages()
        assert index._connection().execute("PRAGMA page_count").fetchone()[0] == pages_before
        reader.execute("ROLLBACK")
    assert index.reclaim_pages()
    assert index._connection().execute("PRAGMA page_count").fetchone()[0] < pages_before
    assert index.search("selected") == before


@pytest.mark.asyncio
async def test_update_loop_defers_checkpoint_until_foreground_mutations_drain(sqlite_cache, monkeypatch):
    from smbprotocol.change_notify import FileAction

    from app.services import directory_cache
    from app.services.directory_cache import _DirectoryMutation
    from app.services.directory_index import ROW_BATCH_SIZE

    for number in range(ROW_BATCH_SIZE + 1):
        assert sqlite_cache.coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, f"foreground/{number}"))
    ticks = 0
    checkpoints = []

    async def tick(_delay):
        nonlocal ticks
        ticks += 1
        if ticks > 1:
            raise asyncio.CancelledError

    async def run(operation):
        return operation()

    monkeypatch.setattr(directory_cache, "asyncio", SimpleNamespace(sleep=tick, CancelledError=asyncio.CancelledError))
    monkeypatch.setattr(sqlite_cache, "_blocking", run)
    monkeypatch.setattr(sqlite_cache, "_verification_due", lambda _verified_at: False)
    monkeypatch.setattr(sqlite_cache.index, "checkpoint_if_due", lambda: checkpoints.append(len(sqlite_cache.coordinator.pending)))
    await sqlite_cache._periodic_rescan_loop()
    assert len(sqlite_cache.coordinator.pending) == 1
    assert not checkpoints
    ticks = 0
    await sqlite_cache._periodic_rescan_loop()
    assert not sqlite_cache.coordinator.pending
    assert checkpoints == [0]
    assert sqlite_cache.index.search("foreground").total_matches == ROW_BATCH_SIZE + 1


@pytest.mark.parametrize("blocker", ["mutation", "query", "scan", "stop"])
def test_checkpoint_worker_defers_for_foreground_ownership(sqlite_cache, monkeypatch, blocker):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import _DirectoryMutation

    calls = []
    monkeypatch.setattr(sqlite_cache.index, "checkpoint_if_due", lambda: calls.append(True))
    if blocker == "mutation":
        assert sqlite_cache.coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "foreground"))
    elif blocker == "query":
        monkeypatch.setattr(sqlite_cache.index, "_active_queries", 1)
    elif blocker == "scan":
        sqlite_cache._scan_running.set()
    else:
        sqlite_cache._stop_event.set()
    sqlite_cache._checkpoint_work()
    assert not calls
    if blocker == "mutation":
        sqlite_cache.coordinator.apply_pending()
    elif blocker == "query":
        monkeypatch.setattr(sqlite_cache.index, "_active_queries", 0)
    elif blocker == "scan":
        sqlite_cache._scan_running.clear()
    else:
        sqlite_cache._stop_event.clear()
    sqlite_cache._checkpoint_work()
    assert calls == [True]


def test_checkpoint_worker_retries_pinned_reader_and_refused_headroom(sqlite_cache, monkeypatch):
    from app.services.directory_index import CHECKPOINT_WAL_BYTES, ROW_BATCH_SIZE
    from app.services.directory_index_resources import DirectoryDiskBudgetError

    index = sqlite_cache.index
    index._connection().execute("PRAGMA wal_autocheckpoint = 0")
    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    with closing(index._connect(readonly=True)) as reader:
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM directories").fetchone()
        index.write_paths(f"match/{number}/{'long-name-' * 100}" for number in range(ROW_BATCH_SIZE * 4))
        before = index.search("match accepted")
        wal = Path(str(index.path) + "-wal")
        assert wal.stat().st_size >= CHECKPOINT_WAL_BYTES
        sqlite_cache._checkpoint_work()
        assert wal.stat().st_size >= CHECKPOINT_WAL_BYTES
        assert index.search("match accepted") == before
        reader.execute("ROLLBACK")

    def denied():
        raise DirectoryDiskBudgetError("Injected checkpoint headroom refusal.")

    with monkeypatch.context() as refusal:
        refusal.setattr(index, "growth_guard", denied)
        with pytest.raises(DirectoryDiskBudgetError, match="checkpoint headroom"):
            sqlite_cache._checkpoint_work()
        assert wal.stat().st_size >= CHECKPOINT_WAL_BYTES
        assert index.search("match accepted") == before
    sqlite_cache._checkpoint_work()
    assert wal.stat().st_size == 0
    assert index.search("match accepted") == before


def test_small_wal_does_not_request_checkpoint_admission(index, monkeypatch):
    def unexpected_admission():
        raise AssertionError("A small WAL must not request maintenance admission.")

    monkeypatch.setattr(index, "growth_guard", unexpected_admission)
    assert index.checkpoint_if_due()


def test_normal_checkpoint_defers_for_pinned_reader_without_changing_results(index):
    from app.services.directory_index import CHECKPOINT_WAL_BYTES, ROW_BATCH_SIZE

    index._connection().execute("PRAGMA wal_autocheckpoint = 0")
    with closing(index._connect(readonly=True)) as reader:
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM directories").fetchone()
        index.write_paths(f"match/{number}/{'long-name-' * 100}" for number in range(ROW_BATCH_SIZE * 4))
        before = index.search("match")
        wal = Path(str(index.path) + "-wal")
        assert wal.stat().st_size >= CHECKPOINT_WAL_BYTES
        assert not index.checkpoint_if_due()
        assert wal.stat().st_size >= CHECKPOINT_WAL_BYTES
        reader.execute("ROLLBACK")
    assert index.checkpoint_if_due()
    assert wal.stat().st_size == 0
    assert index.search("match") == before


@pytest.mark.parametrize("missing_table", [False, True])
def test_fts_repair_is_bounded_restartable_and_preserves_rows(index, missing_table):
    from dataclasses import replace

    from app.services.directory_index import ROW_BATCH_SIZE

    index.write_paths(f"match/{number}" for number in range(ROW_BATCH_SIZE + 1))
    index.finish_generation(1)
    before = index.search("match")
    index._connection().execute(
        "DROP TABLE directory_fts" if missing_table else "INSERT INTO directory_fts(directory_fts) VALUES ('delete-all')"
    )
    index._connection().execute("BEGIN")
    index.close()
    index.open()
    assert index.needs_fts_repair
    assert index.search("match") == replace(before, query_plan="scan")
    with pytest.raises(RuntimeError, match="being rebuilt"):
        index.mutate_path("remove", "match/0")
    assert index.repair_fts_batch()
    assert index._connection().execute("SELECT count(*) FROM directory_fts_docsize").fetchone()[0] == ROW_BATCH_SIZE
    index.close()
    index.open()
    assert index.needs_fts_repair
    assert index.repair_fts_batch()
    assert not index.repair_fts_batch()
    assert not index.needs_fts_repair
    assert index.search("match") == before
    index.mutate_path("add", "match/extra")
    assert index.search("match").total_matches == before.total_matches + 1


@pytest.mark.parametrize("error_code", [sqlite3.SQLITE_FULL, sqlite3.SQLITE_IOERR])
def test_failed_partial_fts_batch_preserves_rows_cursor_and_retry(index, monkeypatch, error_code):
    from dataclasses import replace

    index.write_paths(["accepted/first", "accepted/second"])
    index.finish_generation(1)
    index._connection().execute("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all')")
    index._connection().execute("BEGIN")
    index.close()
    index.open()
    assert index.needs_fts_repair
    before = index.search("accepted")
    cursor = index._fts_repair_cursor
    connection = index._connection()
    failure = sqlite3.OperationalError("Injected directory-token storage failure.")
    failure.sqlite_errorcode = error_code

    class PartialWriteFailure:
        def __enter__(self):
            connection.__enter__()
            return self

        def __exit__(self, exception_type, exception, traceback):
            return connection.__exit__(exception_type, exception, traceback)

        def __getattr__(self, name):
            return getattr(connection, name)

        def executemany(self, statement, rows):
            connection.execute(statement, next(iter(rows)))
            raise failure

    with monkeypatch.context() as patcher:
        patcher.setattr(index, "_connection", PartialWriteFailure)
        with pytest.raises(sqlite3.OperationalError) as caught:
            index.repair_fts_batch()
        assert caught.value is failure
    assert index._fts_repair_cursor == cursor
    assert index.needs_fts_repair
    assert connection.execute("SELECT count(*) FROM directory_fts_docsize").fetchone()[0] == 0
    assert index.search("accepted") == before
    assert not index.repair_fts_batch()
    assert not index.needs_fts_repair
    assert index.search("accepted") == replace(before, query_plan="trigram")


def test_source_close_releases_registration_once(sqlite_cache):
    sqlite_cache.resources.register_source(sqlite_cache._persist_path)
    sqlite_cache.resources.register_source(sqlite_cache._persist_path)
    sqlite_cache._request_stop()
    sqlite_cache._finish_stop()
    sqlite_cache._finish_stop()
    assert sqlite_cache.resources.active_paths[sqlite_cache._persist_path] == 1
    with pytest.raises(InterruptedError, match="replaced or stopped"):
        sqlite_cache.search_index("accepted")


def test_background_fts_repair_releases_actual_scan_ownership_after_failure(sqlite_cache, monkeypatch):
    index = sqlite_cache.index
    index.write_paths(["accepted"])
    index._connection().execute("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all')")
    index._connection().execute("BEGIN")
    index.close()
    index.open()
    original = index.repair_fts_batch

    def fail():
        raise OSError("Injected storage failure.")

    monkeypatch.setattr(index, "repair_fts_batch", fail)
    with pytest.raises(OSError, match="storage failure"):
        sqlite_cache._repair_fts_work()
    assert not sqlite_cache._scan_running.is_set()
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    sqlite_cache._manager_scan_slots.release()
    assert index.search("accepted").total_matches == 1
    monkeypatch.setattr(index, "repair_fts_batch", original)
    sqlite_cache._repair_fts_work()
    assert not index.needs_fts_repair
    assert index.search("accepted").query_plan == "trigram"


def test_pressure_reclamation_coalesces_and_defers_for_actual_readers(sqlite_cache, monkeypatch):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import _DirectoryMutation
    from app.services.directory_index_resources import DirectoryDiskBudgetError

    outcomes = iter([False, True])
    calls = []

    def reclaim():
        calls.append(True)
        return next(outcomes)

    monkeypatch.setattr(sqlite_cache.index, "reclaim_pages", reclaim)
    sqlite_cache._reclaim_disk_work()
    assert not calls
    sqlite_cache._reclamation_pending = True
    assert sqlite_cache.coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "foreground"))
    sqlite_cache._reclaim_disk_work()
    assert not calls
    assert sqlite_cache._reclamation_pending
    sqlite_cache.coordinator.apply_pending()
    before = sqlite_cache.index.search("foreground")
    sqlite_cache._scan_running.set()
    sqlite_cache._reclaim_disk_work()
    assert not calls
    assert sqlite_cache._reclamation_pending
    sqlite_cache._scan_running.clear()
    with monkeypatch.context() as reader:
        reader.setattr(sqlite_cache.index, "_active_queries", 1)
        sqlite_cache._reclaim_disk_work()
        assert not calls
        assert sqlite_cache._reclamation_pending
    with monkeypatch.context() as refusal:

        def denied():
            raise DirectoryDiskBudgetError("Injected maintenance headroom refusal.")

        refusal.setattr(sqlite_cache.index, "reclaim_pages", denied)
        with pytest.raises(DirectoryDiskBudgetError):
            sqlite_cache._reclaim_disk_work()
        assert sqlite_cache._reclamation_pending
        assert sqlite_cache.index.search("foreground") == before
    sqlite_cache._reclaim_disk_work()
    assert sqlite_cache._reclamation_pending
    sqlite_cache._reclaim_disk_work()
    assert not sqlite_cache._reclamation_pending
    sqlite_cache._reclaim_disk_work()
    assert len(calls) == 2
    assert sqlite_cache.index.search("foreground") == before


def test_last_access_update_does_not_change_search_or_verification(index):
    index.write_paths(["accepted"])
    index.finish_generation(1)
    before = index.search("accepted")
    index.touch_access(1000)
    assert index._connection().execute("SELECT last_access_at_ms FROM source_metadata WHERE id = 1").fetchone() == (1000,)
    assert index.search("accepted") == before


def test_directory_disk_admission_preserves_rows_and_releases_reservations(index):
    from app.models.system_settings import DirectoryIndexPolicy
    from app.services.directory_index_resources import DirectoryDiskBudgetError, DirectoryIndexResources

    index.write_paths(["accepted"])
    before = index.search("accepted")
    resources = DirectoryIndexResources(index.path.parent, DirectoryIndexPolicy(disk_budget_bytes=64 * 1024 * 1024))
    index.growth_guard = resources.reserve_growth
    with resources.reserve_growth():
        assert resources.usage().reserved_bytes > 0
        with pytest.raises(DirectoryDiskBudgetError, match="headroom is unavailable"):
            index.write_paths(["refused"])
    assert resources.usage().reserved_bytes == 0
    assert index.search("accepted") == before
    assert index.search("refused").total_matches == 0
    resources.apply_policy(DirectoryIndexPolicy())
    index.write_paths(["restored"])
    assert index.search("restored").total_matches == 1


def test_directory_disk_accounting_rejects_links_without_reading_target(tmp_path):
    from app.services.directory_index_resources import DirectoryIndexResources

    namespace = tmp_path / "sqlite"
    namespace.mkdir()
    outside = tmp_path / "outside"
    outside.write_bytes(b"private")
    (namespace / "linked.sqlite3").symlink_to(outside)
    with pytest.raises(ValueError, match="unsupported entries"):
        DirectoryIndexResources(namespace).usage()
    assert outside.read_bytes() == b"private"


@pytest.mark.asyncio
async def test_backend_idle_release_preserves_sources_with_actual_work(sqlite_cache, monkeypatch):
    import time

    from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT
    from app.services.directory_cache import DirectoryCacheManager

    manager = DirectoryCacheManager()
    manager._caches[sqlite_cache.connection_id] = sqlite_cache
    stopped = []
    monkeypatch.setattr(sqlite_cache, "_finish_stop", lambda: stopped.append(sqlite_cache.connection_id))
    sqlite_cache._last_access = time.monotonic() - DIRECTORY_INDEX_CONTRACT.limits["idle_release_seconds"] - 1
    sqlite_cache._scan_running.set()
    await manager.release_idle_caches()
    assert not stopped
    sqlite_cache._scan_running.clear()
    sqlite_cache._active_workers = 1
    await manager.release_idle_caches()
    assert not stopped
    sqlite_cache._active_workers = 0
    sqlite_cache.index.seed_scan(1)
    await manager.release_idle_caches()
    assert not stopped
    sqlite_cache.index.finish_scan_parent(1, "")
    await manager.release_idle_caches()
    assert stopped == [sqlite_cache.connection_id]
    assert manager.get_cache(sqlite_cache.connection_id) is None
    assert not manager._retiring_caches


@pytest.mark.asyncio
async def test_failed_initialization_keeps_bounded_retry_eligibility(sqlite_cache, monkeypatch):
    import time

    sqlite_cache.index.close()
    sqlite_cache._opened.clear()
    started = []

    def unavailable():
        raise BlockingIOError("leased")

    monkeypatch.setattr(sqlite_cache, "_initialize_storage", unavailable)
    monkeypatch.setattr(sqlite_cache, "_start_periodic_rescan", lambda: started.append(True))
    await sqlite_cache._initialize()
    assert sqlite_cache._resource_retry_at > time.monotonic()
    assert "Wait for active workers" in sqlite_cache.scan_error
    assert started == [True]
    assert not sqlite_cache._opened.is_set()
    assert sqlite_cache.state.value == "empty"


@pytest.mark.asyncio
@pytest.mark.parametrize("next_state", ["building", "updating", "ready"])
async def test_cold_scan_reports_opening_until_initialization_finishes(sqlite_cache, monkeypatch, next_state):
    from app.services.directory_cache import CacheState

    entered = asyncio.Event()
    release = asyncio.Event()

    async def initialize():
        entered.set()
        await release.wait()
        sqlite_cache._state = CacheState(next_state)

    monkeypatch.setattr(sqlite_cache, "_initialize", initialize)
    await sqlite_cache.start_scan()
    try:
        await entered.wait()
        assert sqlite_cache.state is CacheState.OPENING
    finally:
        release.set()
        await sqlite_cache._scan_task
    assert sqlite_cache.state.value == next_state


@pytest.mark.asyncio
async def test_repeated_cold_requests_respect_retry_deadline(sqlite_cache, monkeypatch):
    from unittest.mock import AsyncMock

    sqlite_cache._opened.clear()
    sqlite_cache._schedule_retry(now=1000.0)
    deadline = sqlite_cache._resource_retry_at
    now = [deadline - 0.001]
    initialize = AsyncMock()
    monkeypatch.setattr(sqlite_cache, "_initialize", initialize)
    monkeypatch.setattr("app.services.directory_cache.time", SimpleNamespace(monotonic=lambda: now[0]))
    for _ in range(3):
        await sqlite_cache.start_scan()
        if sqlite_cache._scan_task is not None:
            await sqlite_cache._scan_task
        initialize.assert_not_awaited()
        assert sqlite_cache._resource_retry_at == deadline
    now[0] = deadline
    await sqlite_cache.start_scan()
    assert sqlite_cache._scan_task is not None
    await sqlite_cache._scan_task
    initialize.assert_awaited_once()


@pytest.mark.asyncio
async def test_source_replacement_does_not_wait_for_old_close(sqlite_cache, monkeypatch):
    from app.services.directory_cache import DirectoryCacheManager, SQLiteConnectionDirectoryCache

    manager = DirectoryCacheManager()
    manager._caches[sqlite_cache.connection_id] = sqlite_cache
    release = threading.Event()
    entered = asyncio.Event()
    loop = asyncio.get_running_loop()

    def finish():
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(timeout=5)

    async def initialize_later(_cache):
        return None

    monkeypatch.setattr(sqlite_cache, "_finish_stop", finish)
    monkeypatch.setattr(SQLiteConnectionDirectoryCache, "start_scan", initialize_later)
    try:
        replacement = await asyncio.wait_for(
            manager.get_or_create_cache(
                sqlite_cache.connection_id,
                sqlite_cache.host,
                sqlite_cache.share_name,
                sqlite_cache.username,
                "replacement-password",
                sqlite_cache.port,
            ),
            timeout=1,
        )
        await asyncio.wait_for(entered.wait(), timeout=5)
        assert replacement is not sqlite_cache
        assert sqlite_cache in manager._retiring_caches
        assert sqlite_cache._stop_event.is_set()
    finally:
        release.set()
        await manager.stop_all_async()


@pytest.mark.asyncio
async def test_cancelled_idle_cleanup_keeps_actual_close_ownership(sqlite_cache, monkeypatch):
    import time

    from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT
    from app.services.directory_cache import DirectoryCacheManager

    manager = DirectoryCacheManager()
    manager._caches[sqlite_cache.connection_id] = sqlite_cache
    sqlite_cache._last_access = time.monotonic() - DIRECTORY_INDEX_CONTRACT.limits["idle_release_seconds"] - 1
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()

    def finish():
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(timeout=5)

    monkeypatch.setattr(sqlite_cache, "_finish_stop", finish)
    cleanup = asyncio.create_task(manager.release_idle_caches())
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        cleanup.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cleanup
        assert sqlite_cache in manager._retiring_caches
    finally:
        release.set()
        await manager.stop_all_async()
    assert not manager._retiring_caches


def test_directory_disk_admission_checks_filesystem_headroom_and_retains_rows(index, monkeypatch):
    from types import SimpleNamespace

    from app.services.directory_index_resources import WRITE_HEADROOM_BYTES, DirectoryDiskBudgetError, DirectoryIndexResources

    index.write_paths(["accepted"])
    before = index.search("accepted")
    resources = DirectoryIndexResources(index.path.parent)
    index.growth_guard = resources.reserve_growth
    monkeypatch.setattr(
        "app.services.directory_index_resources.shutil.disk_usage", lambda _path: SimpleNamespace(free=WRITE_HEADROOM_BYTES - 1)
    )
    with pytest.raises(DirectoryDiskBudgetError, match="insufficient free space"):
        index.write_paths(["refused"])
    assert resources.usage().growth_paused
    assert resources.usage().reserved_bytes == 0
    assert index.search("accepted") == before
    assert index.search("refused").total_matches == 0
    monkeypatch.setattr(
        "app.services.directory_index_resources.shutil.disk_usage", lambda _path: SimpleNamespace(free=WRITE_HEADROOM_BYTES)
    )
    index.write_paths(["restored"])
    assert index.search("restored").total_matches == 1


def test_page_cache_policy_applies_to_connections_without_changing_coverage(index):
    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    before = index.search("accepted")
    index.configure_page_cache(64)
    with closing(index._connect(readonly=True)) as connection:
        assert connection.execute("PRAGMA cache_size").fetchone() == (-64,)
        assert connection.execute("PRAGMA mmap_size").fetchone() == (0,)
    assert index.search("accepted") == before
    with pytest.raises(ValueError, match="integer between"):
        index.configure_page_cache(0)


def test_trigram_query_streams_candidates_without_temporary_id_list(index, monkeypatch):
    traced = []
    original_connect = index._connect

    def connect(**kwargs):
        connection = original_connect(**kwargs)
        connection.set_trace_callback(traced.append)
        return connection

    index.write_paths(["alpha/beta", "alpha", "beta", "neither"])
    monkeypatch.setattr(index, "_connect", connect)
    assert index.search("alpha beta").total_matches == 3
    statement = next(statement for statement in traced if "CROSS JOIN directories" in statement)
    details = [row[3] for row in index._connection().execute("EXPLAIN QUERY PLAN " + statement)]
    assert all("LIST SUBQUERY" not in detail and "TEMP B-TREE" not in detail for detail in details)


def test_resource_policy_model_uses_shared_defaults_and_scope_keys():
    from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT
    from app.core.system_setting_definitions import DIRECTORY_INDEX_SETTING_KEYS, SYSTEM_SETTING_DEFINITIONS, DirectoryIndexPolicyScope
    from app.models.system_settings import DirectoryIndexPolicy

    policy = DirectoryIndexPolicy()
    for scope in DirectoryIndexPolicyScope:
        for field, definition in DIRECTORY_INDEX_CONTRACT.policy.items():
            assert getattr(policy, field) == definition.default
            assert SYSTEM_SETTING_DEFINITIONS[DIRECTORY_INDEX_SETTING_KEYS[scope][field]].default_value == definition.default


@pytest.mark.parametrize("invalid", [0, True, "2048", 2048.5])
def test_resource_policy_model_rejects_unsafe_values(invalid):
    from app.models.system_settings import DirectoryIndexPolicy

    with pytest.raises(ValueError):
        DirectoryIndexPolicy(page_cache_kib=invalid)


def test_resource_policy_model_validates_correlated_intervals():
    from app.models.system_settings import DirectoryIndexPolicy

    with pytest.raises(ValueError, match="must not exceed"):
        DirectoryIndexPolicy(healthy_verification_seconds=60, degraded_verification_seconds=300)


@pytest.mark.parametrize("invalid", [0, True, "2", -1])
def test_shared_resource_contract_rejects_invalid_limits(tmp_path, invalid):
    from app.core.directory_index_contract import load_directory_index_contract

    contract = json.loads((CONTRACT_ROOT / "contract.json").read_text())
    contract["limits"]["query_workers"] = invalid
    path = tmp_path / "invalid.json"
    path.write_text(json.dumps(contract), encoding="utf-8")
    with pytest.raises(ValueError, match="limits are invalid"):
        load_directory_index_contract(path)


@pytest.fixture
def sqlite_cache(index):
    from app.services.directory_cache import DirectoryScanCoordinator, SQLiteConnectionDirectoryCache

    cache = SQLiteConnectionDirectoryCache("fixture", "fixture", "share", "user", "password")
    cache.index = index
    from app.services.directory_index_resources import DirectoryIndexResources

    cache._persist_path = index.path
    cache.resources = DirectoryIndexResources(index.path.parent)
    cache.index.growth_guard = cache.resources.reserve_growth
    cache.coordinator = DirectoryScanCoordinator(index)
    cache._opened.set()
    cache._source_available.set()
    cache._source_probe_completed.set()

    class SourceRead:
        def __init__(self, entries):
            self.entries = entries

        def __next__(self):
            return next(self.entries)

        def close(self):
            self.entries.close()

        def verify(self):
            pass

        def has_directory_child(self, name):
            return True

    def open_read(parent, token):
        import smbclient

        from app.services.system_settings import get_smbclient_policy_kwargs

        path = cache._smb_base_path + ("\\" + parent.replace("/", "\\") if parent else "")
        return SourceRead(
            smbclient.scandir(
                path,
                username=cache.username,
                password=cache.password,
                port=cache.port,
                connection_cache=cache._connection_cache,
                **get_smbclient_policy_kwargs(),
            )
        )

    with pytest.MonkeyPatch.context() as reader_patch:
        reader_patch.setattr(cache, "_open_source_read", open_read)
        try:
            yield cache
        finally:
            cache._request_stop()
            cache._finish_stop()


def test_smb_handle_uses_no_redirect_open_and_bounded_native_reads(monkeypatch):
    from types import SimpleNamespace

    from smbprotocol.exceptions import PathNotCovered
    from smbprotocol.open import CreateOptions, ShareAccess

    from app.services.directory_traversal import DIRECTORY_READ_BUFFER_BYTES, SmbDirectoryHandle

    calls = []
    replies = [[object()], _smb_response_error(NtStatus.STATUS_NO_MORE_FILES), _smb_response_error(NtStatus.STATUS_PATH_NOT_COVERED)]

    class Handle:
        connected = True
        file_attributes = 0

        def __init__(self, tree, path):
            calls.append((tree, path))
            self.connection = tree.session.connection

        def create(self, *args):
            calls.append(args)

        def query_directory(self, *args, **kwargs):
            calls.append((args, kwargs))
            reply = replies.pop(0)
            if isinstance(reply, BaseException):
                raise reply
            return reply

        def close(self):
            self.connected = False

    tree = SimpleNamespace(
        share_name=r"\\host\share",
        is_dfs_share=False,
        session=SimpleNamespace(connection=SimpleNamespace(max_transact_size=DIRECTORY_READ_BUFFER_BYTES, supports_multi_credit=False)),
    )
    monkeypatch.setattr("app.services.directory_traversal.get_smb_tree", lambda *args, **kwargs: (tree, "parent"))
    monkeypatch.setattr("app.services.directory_traversal.Open", Handle)
    handle = SmbDirectoryHandle(r"\\host\share\parent", lambda: None)
    assert calls[1][3] == ShareAccess.FILE_SHARE_READ | ShareAccess.FILE_SHARE_WRITE
    assert calls[1][5] & CreateOptions.FILE_OPEN_REPARSE_POINT
    assert len(list(handle.records(lambda: None))) == 1
    assert calls[2][1]["max_output"] == DIRECTORY_READ_BUFFER_BYTES
    assert calls[2][1]["flags"] != 0
    assert calls[3][1]["flags"] == 0
    with pytest.raises(PathNotCovered):
        list(handle.records(lambda: None))
    handle.close()
    assert handle.closed


@pytest.fixture
def smb_directory_server(monkeypatch):
    from datetime import datetime, timezone
    from types import SimpleNamespace
    from uuid import UUID

    from smbprotocol.file_info import FileFsVolumeInformation, FileIdFullDirectoryInformation, FileInternalInformation
    from smbprotocol.header import Commands, SMB2HeaderRequest
    from smbprotocol.open import (
        Open as ProtocolOpen,
    )
    from smbprotocol.open import (
        SMB2CloseResponse,
        SMB2CreateResponse,
        SMB2QueryDirectoryResponse,
        SMB2QueryInfoResponse,
    )

    from app.services.directory_traversal import SCAN_CREDIT_RESERVE, SMB_CREDIT_BYTES
    from app.storage.smb_pool import ScanCreditConnection

    server = SimpleNamespace(
        directories={"": [("base", 16)], "base": [("parent", 16)], "base\\parent": [("Exact", 16), ("file", 0), ("redirect", 16 | 1024)]},
        identifiers={},
        volumes={},
        names={},
        aliases={},
        handles=[],
        patterns=[],
        denied=set(),
        metadata_denied=set(),
        metadata_error=None,
        volume_error=None,
        volume_queries=0,
        file_queries=[],
        query_buffers=[],
        record_ids=False,
        compounds=[],
        received=[],
        compound_errors={},
        empty_compound_response=None,
        attributes={},
        standalone=[],
        events=[],
        credit_requests=[],
        credit_accounting=False,
        credit_grant_limit=None,
        echo_grant=None,
        stall_path=None,
        on_query=lambda: None,
        connection=SimpleNamespace(
            server_guid=UUID(int=1),
            dialect=0x0311,
            max_transact_size=1024 * 1024,
            supports_multi_credit=True,
            sequence_lock=threading.RLock(),
            sequence_window={"low": 0, "high": 0},
        ),
    )
    server.tree = SimpleNamespace(
        share_name=r"\\host\share",
        is_dfs_share=False,
        tree_connect_id=1,
        session=SimpleNamespace(session_id=1, connection=server.connection, open_table={}, username="test"),
    )

    def resolve(path):
        for alias, target in server.aliases.items():
            if path == alias or path.startswith(alias + "\\"):
                return target + path[len(alias) :]
        return path

    class Handle(ProtocolOpen):
        file_attributes = 16

        def __init__(self, tree, path):
            attributes = self.file_attributes
            super().__init__(tree, path)
            self.file_attributes = attributes
            self.path = path
            self.cursor = 0
            server.handles.append(self)

        def create(self, *args, send=True):
            if not send:
                return super().create(*args, send=False)
            if resolve(self.path) not in server.directories:
                raise FileNotFoundError("Injected missing directory.")
            self._connected = True

        def close(self, *, send=True):
            if not send:
                return super().close(send=False)
            self._connected = False

        def query_directory(self, pattern, info_class, *, flags, max_output, send=True):
            if not send:
                return super().query_directory(pattern, info_class, flags=flags, max_output=max_output, send=False)
            if self.path in server.denied:
                raise _smb_response_error(NtStatus.STATUS_ACCESS_DENIED)
            server.on_query()
            server.patterns.append(pattern)
            server.query_buffers.append(max_output)
            if flags:
                self.cursor = 0
            entries = server.directories[resolve(self.path)]
            if pattern != "*":
                entries = [(name, attributes) for name, attributes in entries if name.casefold() == pattern.casefold()]
            if self.cursor >= len(entries):
                raise _smb_response_error(NtStatus.STATUS_NO_MORE_FILES)
            records = []
            for name, attributes in entries[self.cursor : self.cursor + 2]:
                record = FileIdFullDirectoryInformation()
                record["file_name"] = name.encode("utf-16-le", errors="surrogatepass")
                record["file_attributes"] = attributes
                if server.record_ids:
                    child = self.path + "\\" + name if self.path else name
                    record["file_id"] = server.identifiers.setdefault(child, len(server.identifiers) + 1)
                records.append(record)
            self.cursor += len(records)
            return records

    def send_compound(messages, session_id, tree_id, *, related):
        server.compounds.append(messages)
        assert related
        assert session_id == server.tree.session.session_id
        assert tree_id == server.tree.tree_connect_id
        charge = sum(
            max(1, (message["output_buffer_length"].get_value() + SMB_CREDIT_BYTES - 1) // SMB_CREDIT_BYTES)
            if message.COMMAND == Commands.SMB2_QUERY_DIRECTORY
            else 1
            for message in messages
        )
        assert charge <= server.connection.sequence_window["high"] - server.connection.sequence_window["low"]
        descriptor = server.handles[-1]
        server.events.append(("send", descriptor.path))
        requests = []
        for position, message in enumerate(messages):
            header = SMB2HeaderRequest()
            header["data"] = message.pack()
            requests.append(SimpleNamespace(position=position, body=message, message=header, descriptor=descriptor))
        return requests

    def receive(request, *, resolve_symlinks, timeout=None):
        assert not resolve_symlinks
        assert timeout is None or timeout > 0
        server.received.append(request.position)
        server.events.append(("receive", request.descriptor.path))
        if request.descriptor.path == server.stall_path and request.position == 0:
            raise TimeoutError("Injected stalled pipeline response.")
        if server.credit_accounting:
            grant = request.message["credit_request"].get_value()
            if server.credit_grant_limit is not None:
                grant = min(grant, server.credit_grant_limit)
            server.connection.sequence_window["high"] += grant
        if request.position in server.compound_errors:
            raise _smb_response_error(server.compound_errors[request.position])
        descriptor = request.descriptor
        message = request.body
        if message.COMMAND == Commands.SMB2_CREATE:
            descriptor.create()
            response = SMB2CreateResponse()
            response["file_id"] = (server.handles.index(descriptor) + 1).to_bytes(16, "little")
            response["file_attributes"] = server.attributes.get(descriptor.path, descriptor.file_attributes)
        elif message.COMMAND == Commands.SMB2_QUERY_INFO:
            information = FileInternalInformation()
            information["index_number"] = server.identifiers.setdefault(resolve(descriptor.path), len(server.identifiers) + 1)
            response = SMB2QueryInfoResponse()
            response["buffer"] = information.pack()
        elif message.COMMAND == Commands.SMB2_QUERY_DIRECTORY:
            records = (
                []
                if request.position == server.empty_compound_response
                else descriptor.query_directory(
                    "*",
                    message["file_information_class"].get_value(),
                    flags=message["flags"].get_value(),
                    max_output=message["output_buffer_length"].get_value(),
                )
            )
            packed = []
            for position, record in enumerate(records):
                padding = (8 - len(record) % 8) % 8
                if position < len(records) - 1:
                    record["next_entry_offset"] = len(record) + padding
                packed.append(record.pack() + b"\x00" * padding)
            response = SMB2QueryDirectoryResponse()
            response["buffer"] = b"".join(packed)
        else:
            assert message.COMMAND == Commands.SMB2_CLOSE
            response = SMB2CloseResponse()
        header = SMB2HeaderResponse()
        header["data"] = response.pack()
        return header

    server.connection.send_compound = send_compound
    server.connection.receive = receive

    def send(message, session_id, tree_id):
        server.standalone.append(message)
        header = SMB2HeaderRequest()
        header["data"] = message.pack()
        return SimpleNamespace(position=5, body=message, message=header, descriptor=server.handles[-1])

    server.connection.send = send

    def pipeline_send(messages, *, session_id, tree_id, related, credit_request):
        available = server.connection.sequence_window["high"] - server.connection.sequence_window["low"]
        requests = send_compound(messages, session_id, tree_id, related=related)
        total_charge = 0
        for request in requests:
            message = request.body
            charge = (
                max(1, (message["output_buffer_length"].get_value() + SMB_CREDIT_BYTES - 1) // SMB_CREDIT_BYTES)
                if message.COMMAND == Commands.SMB2_QUERY_DIRECTORY
                else 1
            )
            request.message["credit_request"] = credit_request or charge
            total_charge += charge
            server.credit_requests.append(credit_request)
            if server.credit_accounting:
                server.connection.sequence_window["low"] += charge
            assert available - total_charge >= SCAN_CREDIT_RESERVE
        return requests

    def echo(*, sid, timeout, credit_request):
        assert sid == server.tree.session.session_id
        assert timeout > 0
        server.events.append(("echo", credit_request))
        if server.echo_grant is None:
            server.connection.sequence_window["high"] += credit_request
        else:
            server.connection.sequence_window["high"] += server.echo_grant

    server.connection._send = pipeline_send
    server.connection._calculate_credit_charge = lambda message: (
        max(1, (message["output_buffer_length"].get_value() + SMB_CREDIT_BYTES - 1) // SMB_CREDIT_BYTES)
        if message.COMMAND == Commands.SMB2_QUERY_DIRECTORY
        else 1
    )
    server.connection.send_scan_compound = ScanCreditConnection.send_scan_compound.__get__(server.connection)
    server.connection.echo = echo

    class Transaction:
        def __init__(self, raw):
            self.raw = raw
            self.results = ()

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def metadata(transaction, kind, **kwargs):
        information = kind()
        path = transaction.raw.fd.path
        if path in server.metadata_denied:
            raise server.metadata_error if server.metadata_error is not None else _smb_response_error(NtStatus.STATUS_ACCESS_DENIED)
        if isinstance(information, FileFsVolumeInformation):
            server.volume_queries += 1
            if server.volume_error is not None:
                raise server.volume_error
            information["volume_serial_number"] = server.volumes.get(path, 1)
            information["volume_creation_time"] = datetime(2026, 1, 1, tzinfo=timezone.utc)
        else:
            server.file_queries.append(path)
            information["internal_information"].get_value()["index_number"] = server.identifiers.setdefault(
                resolve(path), len(server.identifiers) + 1
            )
            information["name_information"].get_value()["file_name"] = server.names.get(path, "\\" + path)
            information["standard_information"].get_value()["directory"] = True
        transaction.results += (information,)

    def tree(path, **kwargs):
        return server.tree, "\\".join(PureWindowsPath(path).parts[1:])

    from pathlib import PureWindowsPath

    monkeypatch.setattr("app.services.directory_traversal.get_smb_tree", tree)
    monkeypatch.setattr("app.services.directory_traversal.Open", Handle)
    monkeypatch.setattr("app.services.directory_traversal.SMBFileTransaction", Transaction)
    monkeypatch.setattr("app.services.directory_traversal.query_info", metadata)
    yield server
    assert all(not handle.connected for handle in server.handles)


@pytest.mark.parametrize("bound", ["depth", "bytes"])
def test_smb_traversal_bounds_reject_before_open_and_preserve_exact_limits(smb_directory_server, monkeypatch, bound):
    from pathlib import PureWindowsPath

    from app.services.directory_traversal import (
        MAX_SOURCE_DEPTH,
        MAX_SOURCE_PATH_BYTES,
        DirectoryTraversalError,
        SmbDirectoryRoot,
        _validate_traversal_path,
    )

    if bound == "depth":
        allowed = "/".join(["entry"] * MAX_SOURCE_DEPTH)
        refused = f"{allowed}/child"
    else:
        allowed = "\u00e9" * (MAX_SOURCE_PATH_BYTES // 2)
        refused = f"{allowed}\u00e9"
    _validate_traversal_path(allowed)
    with pytest.raises(DirectoryTraversalError, match="traversal bounds"):
        _validate_traversal_path(refused)
    root = SmbDirectoryRoot(r"\\host\share")
    try:
        with pytest.raises(DirectoryTraversalError, match="traversal bounds"):
            root.read(refused, lambda: None)
        with pytest.raises(DirectoryTraversalError, match="traversal bounds"):
            SmbDirectoryRoot(str(PureWindowsPath(r"\\host\share", *refused.split("/"))))
        assert not smb_directory_server.handles
    finally:
        root.close()

    with monkeypatch.context() as bounds:
        if bound == "depth":
            bounds.setattr("app.services.directory_traversal.MAX_SOURCE_DEPTH", 2)
        else:
            bounds.setattr("app.services.directory_traversal.MAX_SOURCE_PATH_BYTES", len("base/parent".encode("utf-8")))
        root = SmbDirectoryRoot(r"\\host\share\base")
        try:
            read = root.read("parent", lambda: None)
            try:
                assert [entry.name for entry in read] == [None, "file", None]
            finally:
                read.close()
        finally:
            root.close()


@pytest.mark.parametrize("changed", [False, True])
def test_smb_root_replacement_binds_fresh_identity_across_sessions(smb_directory_server, changed):
    from app.services.directory_traversal import SmbDirectoryRoot

    root = SmbDirectoryRoot(r"\\host\share\base")
    root.read("", lambda: None).close()
    replacement = root.replacement()
    smb_directory_server.tree.session.session_id += 1
    smb_directory_server.tree.tree_connect_id += 1
    if changed:
        smb_directory_server.identifiers["base"] += 1
    try:
        replacement.read("", lambda: None).close()
    finally:
        replacement.close()


@pytest.mark.asyncio
async def test_directory_rebinding_waits_for_retained_workers(sqlite_cache, monkeypatch):
    from unittest.mock import MagicMock

    from app.services.directory_cache import DirectoryScanCapacityError

    original = sqlite_cache._connection_cache
    replacement = {}
    root = MagicMock()
    replacement_root = MagicMock()
    root.replacement.return_value = replacement_root
    sqlite_cache._source_root = root
    sqlite_cache._source_available.set()
    monkeypatch.setattr("app.services.directory_cache.get_smb_connection_cache", lambda _source: replacement)
    sqlite_cache._active_workers = 1
    try:
        with pytest.raises(DirectoryScanCapacityError):
            await sqlite_cache._refresh_connection_generation()
        root.replacement.assert_not_called()
        assert sqlite_cache._connection_cache is original
    finally:
        sqlite_cache._active_workers = 0
    await sqlite_cache._refresh_connection_generation()
    assert sqlite_cache._connection_cache is replacement
    assert sqlite_cache._source_root is replacement_root
    assert not sqlite_cache._source_available.is_set()
    assert sqlite_cache.coordinator.verification_required
    root.replacement.assert_called_once()


@pytest.mark.parametrize("credits", [0, 128])
@pytest.mark.parametrize("event_timing", ["before_read", "after_commit"])
def test_smb_observed_ancestor_rename_and_link_replacement(index, smb_directory_server, event_timing, credits):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, ScanObservationInvalidated, _DirectoryMutation
    from app.services.directory_traversal import SmbDirectoryRoot

    server = smb_directory_server
    server.connection.sequence_window["high"] = credits
    server.directories["base\\parent"] = [("child", 16)]
    server.directories["base\\parent\\child"] = [("new", 16)]
    server.identifiers["base\\parent\\child"] = 42
    index.write_paths(["parent/child"])
    coordinator = DirectoryScanCoordinator(index)
    coordinator.observed_ready = lambda: True
    root = SmbDirectoryRoot(r"\\host\share\base")
    try:
        root.read("", lambda: None).close()
        with coordinator.read("parent/child", observed=True) as token:
            server.directories["base\\moved"] = server.directories.pop("base\\parent")
            server.directories["base\\moved\\child"] = server.directories.pop("base\\parent\\child")
            server.identifiers["base\\moved\\child"] = server.identifiers.pop("base\\parent\\child")
            server.aliases["base\\parent"] = "base\\moved"

            def check():
                if not coordinator.is_current(token):
                    raise ScanObservationInvalidated("Ancestor changed during the observed read.")

            mutation = _DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "parent")
            if event_timing == "before_read":
                coordinator.enqueue(mutation)
                with pytest.raises(ScanObservationInvalidated):
                    root.read_observed("parent/child", (42).to_bytes(8, "little"), check)
            else:
                read = root.read_observed("parent/child", (42).to_bytes(8, "little"), check)
                try:
                    assert [entry.name for entry in read] == ["new"]
                    coordinator.commit_children(token, 1, [("parent/child/new", True)])
                finally:
                    read.close()
                assert index.search("parent/child/new").results
                coordinator.enqueue(mutation)
            coordinator.apply_pending()
            assert not index.search("parent").results
    finally:
        root.close()


@pytest.fixture
def smb_pipeline_cache(sqlite_cache, smb_directory_server):
    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SCAN_PIPELINE_DEPTH, SmbDirectoryRoot

    cache = sqlite_cache
    server = smb_directory_server
    parents = [f"parent-{number:02}" for number in range(SCAN_PIPELINE_DEPTH + 2)]
    server.directories["base"] = [(parent, 16) for parent in parents]
    for parent in parents:
        server.directories["base\\" + parent] = []
    server.record_ids = True
    server.credit_accounting = True
    server.connection.sequence_window["high"] = 1024
    cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(cache)
    cache._watcher_ready.set()
    yield cache, server, parents
    cache._source_root.close()


@pytest.mark.parametrize("credits", [1, 128, 1024])
def test_smb_scan_pipeline_bounds_depth_reserve_and_queue_order(smb_pipeline_cache, credits):
    from app.services.directory_traversal import SCAN_PIPELINE_DEPTH

    cache, server, parents = smb_pipeline_cache
    server.connection.sequence_window["high"] = credits
    cache._scan_disk_queue()
    assert cache.index.status().coverage == "complete"
    sends = [value for event, value in server.events if event == "send"]
    assert sends == ["base\\" + parent for parent in parents]
    first_receive = next(number for number, (event, _value) in enumerate(server.events) if event == "receive")
    initial_sends = sum(event == "send" for event, _value in server.events[:first_receive])
    assert 1 < initial_sends <= SCAN_PIPELINE_DEPTH
    if credits == 1024:
        assert initial_sends == SCAN_PIPELINE_DEPTH
    if credits == 1:
        assert sum(event == "echo" for event, _value in server.events) == 1
    assert any(value is not None for value in server.credit_requests) == (credits < 1024)
    assert not cache.coordinator._producers
    assert not server.tree.session.open_table


@pytest.mark.parametrize("depth", [1, 4])
def test_smb_full_tree_request_budget_and_per_pass_logs(smb_pipeline_cache, caplog, depth):
    import logging

    from app.core.logging import RecoveryLogFormatter

    caplog.set_level(logging.INFO, logger="app.services.directory_cache")
    cache, server, _parents = smb_pipeline_cache
    branch_count = 2
    boundary_request_budget = 24
    parents = [""]
    paths = []
    for level in range(depth + 1):
        children = []
        for parent in parents:
            names = [f"child-{number}" for number in range(branch_count)] if level < depth else []
            native = "base" + ("\\" + parent.replace("/", "\\") if parent else "")
            server.directories[native] = [(name, 16) for name in names]
            children.extend(parent + "/" + name if parent else name for name in names)
        paths.extend(children)
        parents = children
    for _pass in range(2):
        before = cache._source_root.io.round_trips
        compounds_before = len(server.compounds)
        caplog.clear()
        cache._scan_disk_queue()
        records = {record.event: record for record in caplog.records if hasattr(record, "event")}
        finished = records["directory_scan_finished"]
        requests = cache._source_root.io.round_trips - before
        assert records["directory_scan_started"].smb_round_trips == 0
        assert finished.smb_round_trips == requests
        assert f"smb_round_trips={requests}" in RecoveryLogFormatter("%(message)s").format(finished)
        assert finished.abort_reason is None
        assert len(server.compounds) - compounds_before == len(paths)
        assert len(paths) < requests <= len(paths) + boundary_request_budget
        assert cache.index.search("").directory_count == len(paths)
        assert cache.index.status().coverage == "complete"


def test_smb_io_counter_survives_root_replacement(smb_directory_server):
    from app.services.directory_traversal import SmbDirectoryRoot

    root = SmbDirectoryRoot(r"\\host\share\base")
    root.read("", lambda: None).close()
    before = root.io.round_trips
    replacement = root.replacement()
    try:
        assert replacement.io is root.io
        assert replacement.io.round_trips == before + len(root._binding)
        replacement.read("", lambda: None).close()
        assert replacement.io.round_trips > before
    finally:
        replacement.close()


@pytest.mark.parametrize("credits", [0, 128])
def test_smb_io_counter_counts_compounds_not_messages(smb_directory_server, credits):
    from app.services.directory_traversal import SmbCompoundDirectoryReader, SmbDirectoryIo

    server = smb_directory_server
    server.connection.sequence_window["high"] = credits
    server.directories["base\\parent"] = []
    server.identifiers["base\\parent"] = 42
    source_io = SmbDirectoryIo()
    reader = SmbCompoundDirectoryReader(server.tree, "base\\parent", (42).to_bytes(8, "little"), lambda: None, io=source_io)
    try:
        assert source_io.round_trips == len(server.compounds) == (1 if credits else 0)
    finally:
        reader.close()


def test_smb_pipeline_uses_loop_when_server_does_not_grant_credits(smb_pipeline_cache):
    cache, server, _parents = smb_pipeline_cache
    server.connection.sequence_window["high"] = 1
    server.echo_grant = 0
    cache._scan_disk_queue()
    assert cache.index.status().coverage == "complete"
    assert not server.compounds
    assert sum(event == "echo" for event, _value in server.events) == 1
    assert not cache.coordinator._producers


@pytest.mark.parametrize("outcome,expected", [("rejected", 0), ("send_failed", 1), ("cleanup", 2)])
def test_smb_io_counter_handles_admission_failure_and_cleanup(smb_directory_server, outcome, expected):
    from app.services.directory_traversal import DirectoryPipelineTransportError, SmbCompoundDirectoryReader, SmbDirectoryIo

    server = smb_directory_server
    server.connection.sequence_window["high"] = 128
    server.identifiers["base\\parent"] = 42
    source_io = SmbDirectoryIo()
    if outcome == "rejected":
        server.connection.send_scan_compound = lambda *_args, **_kwargs: None
    elif outcome == "send_failed":

        def fail_send(*_args, **_kwargs):
            raise OSError("Injected scan send failure.")

        server.connection.send_scan_compound = fail_send
    else:
        server.compound_errors[4] = NtStatus.STATUS_ACCESS_DENIED

    def read():
        return SmbCompoundDirectoryReader(
            server.tree, "base\\parent", (42).to_bytes(8, "little"), lambda: None, credit_reserve=16, io=source_io
        )

    if outcome == "rejected":
        read().close()
    else:
        with pytest.raises(DirectoryPipelineTransportError if outcome == "send_failed" else SMBResponseException):
            read()
    assert source_io.round_trips == expected


def test_smb_aborted_pass_logs_request_attempts(smb_pipeline_cache, caplog):
    import logging

    caplog.set_level(logging.INFO, logger="app.services.directory_cache")
    cache, server, parents = smb_pipeline_cache
    server.stall_path = "base\\" + parents[0]
    before = cache._source_root.io.round_trips
    with pytest.raises(TimeoutError):
        cache._scan_disk_queue()
    finished = next(record for record in caplog.records if getattr(record, "event", None) == "directory_scan_finished")
    assert finished.smb_round_trips == cache._source_root.io.round_trips - before
    assert finished.smb_round_trips > len(server.compounds) > 0
    assert finished.abort_reason == "DirectoryPipelineTimeout"


def test_smb_io_counter_includes_credit_growth_echo(smb_directory_server):
    from app.services.directory_traversal import SmbCompoundDirectoryReader, SmbDirectoryIo

    server = smb_directory_server
    server.connection.sequence_window["high"] = 1
    source_io = SmbDirectoryIo()
    reader = SmbCompoundDirectoryReader(server.tree, "base\\parent", (42).to_bytes(8, "little"), lambda: None, io=source_io)
    try:
        assert source_io.round_trips == 0
        reader.grow_credits(timeout=1)
        assert source_io.round_trips == 1
        assert [event for event, _value in server.events] == ["echo"]
    finally:
        reader.close()


def test_smb_pipeline_local_barrier_defers_only_affected_parent(smb_pipeline_cache):
    from app.services.directory_cache import READ_PARENT_ACTION, ScanObservationInvalidated, _DirectoryMutation

    cache, server, parents = smb_pipeline_cache
    changed = False
    affected = parents[3]

    def mutate():
        nonlocal changed
        if not changed and server.events and server.events[-1] == ("receive", "base\\" + parents[0]):
            changed = True
            cache.coordinator.enqueue(_DirectoryMutation(READ_PARENT_ACTION, affected))

    server.on_query = mutate
    with pytest.raises(ScanObservationInvalidated):
        cache._scan_disk_queue()
    assert changed
    assert cache.index.pending_scan_paths(1) == [affected]
    assert not cache.coordinator._producers
    assert not server.tree.session.open_table


def test_smb_pipeline_stall_defers_all_inflight_parents(smb_pipeline_cache):
    from app.services.directory_cache import InvalidationReason
    from app.services.directory_traversal import SCAN_PIPELINE_DEPTH

    cache, server, parents = smb_pipeline_cache
    server.stall_path = "base\\" + parents[0]
    with pytest.raises(TimeoutError):
        cache._scan_disk_queue()
    sends = [value for event, value in server.events if event == "send"]
    assert len(sends) == SCAN_PIPELINE_DEPTH
    assert set(cache.index.pending_scan_paths(1)) == set(parents)
    assert cache.coordinator.last_reason == InvalidationReason.STALLED_READ
    assert not cache.coordinator._producers
    assert not server.tree.session.open_table


def test_smb_pipeline_watcher_loss_defers_inflight_and_continues_safe(smb_pipeline_cache):
    from app.services.directory_traversal import SCAN_PIPELINE_DEPTH

    cache, server, parents = smb_pipeline_cache
    lost = False

    def lose_observation():
        nonlocal lost
        if not lost and server.events and server.events[-1] == ("receive", "base\\" + parents[0]):
            lost = True
            cache._watcher_ready.clear()
            cache._observation_lost()

    server.on_query = lose_observation
    cache._scan_disk_queue()
    assert lost
    assert sum(event == "send" for event, _value in server.events) == SCAN_PIPELINE_DEPTH
    assert not cache.index.pending_scan_paths(1)
    assert cache.index.search("").directory_count == len(parents)
    assert cache.coordinator.observed_reads_blocked
    assert not cache.coordinator._producers
    assert not server.tree.session.open_table


@pytest.mark.asyncio
@pytest.mark.parametrize("send_failed", [False, True])
async def test_smb_pipeline_failure_retires_the_owned_connection(sqlite_cache, send_failed):
    from app.services.directory_traversal import DirectoryPipelineTimeout, DirectoryPipelineTransportError

    pool = SimpleNamespace(invalidate_connection_cache=AsyncMock())
    failure = DirectoryPipelineTransportError if send_failed else DirectoryPipelineTimeout

    def stalled():
        raise failure("Injected pipeline failure.")

    with pytest.raises(failure):
        await sqlite_cache._blocking(stalled, pool=pool)
    pool.invalidate_connection_cache.assert_awaited_once_with(
        sqlite_cache._connection_cache,
        reason="directory_pipeline_send_failed" if send_failed else "directory_pipeline_timeout",
        abort=True,
    )


def test_smb_pipeline_uses_safe_loop_without_atomic_admission(smb_pipeline_cache):
    cache, server, parents = smb_pipeline_cache
    del server.connection.send_scan_compound
    cache._scan_disk_queue()
    assert not server.compounds
    assert cache.index.search("").directory_count == len(parents)
    assert not cache.index.pending_scan_paths(1)
    assert not cache.coordinator._producers


def test_smb_pipeline_partial_send_failure_defers_unfinished_parents(smb_pipeline_cache):
    from smbprotocol.exceptions import SMBException

    from app.services.directory_traversal import DirectoryPipelineTransportError

    cache, server, parents = smb_pipeline_cache

    def partial_send(*_args, **_kwargs):
        server.connection.sequence_window["low"] += 1
        raise SMBException("Injected insufficient credits after partial admission.")

    server.connection._send = partial_send
    with pytest.raises(DirectoryPipelineTransportError):
        cache._scan_disk_queue()
    assert set(cache.index.pending_scan_paths(1)) == set(parents)
    assert not cache.coordinator._producers


def test_smb_pipeline_cleanup_deadline_is_not_hidden_by_watcher_loss(smb_pipeline_cache):
    from app.services.directory_traversal import DirectoryPipelineTimeout

    cache, server, parents = smb_pipeline_cache
    server.stall_path = "base\\" + parents[5]
    lost = False

    def lose_observation():
        nonlocal lost
        if not lost and server.events and server.events[-1] == ("receive", "base\\" + parents[0]):
            lost = True
            cache._watcher_ready.clear()
            cache._observation_lost()

    server.on_query = lose_observation
    with pytest.raises(DirectoryPipelineTimeout):
        cache._scan_disk_queue()
    assert set(cache.index.pending_scan_paths(1)) == set(parents)
    assert not cache.coordinator._producers
    assert not server.tree.session.open_table


def test_smb_pipeline_rejects_replacement_transport_with_reused_ids(smb_pipeline_cache, monkeypatch):
    from app.services.directory_traversal import DirectoryBindingChangedError

    cache, server, parents = smb_pipeline_cache
    cache._source_root.read("", lambda: None).close()
    replacement_connection = SimpleNamespace(**vars(server.connection))
    replacement_session = SimpleNamespace(**{**vars(server.tree.session), "connection": replacement_connection})
    replacement_tree = SimpleNamespace(**{**vars(server.tree), "session": replacement_session})
    monkeypatch.setattr(
        "app.services.directory_traversal.get_smb_tree",
        lambda *_args, **_kwargs: (replacement_tree, "base\\" + parents[0]),
    )
    with pytest.raises(DirectoryBindingChangedError):
        cache._source_root.read_observed(parents[0], (42).to_bytes(8, "little"), lambda: None, deferred=True)
    assert not server.compounds


def test_smb_pipeline_sends_multiple_parents_before_receiving(smb_directory_server):
    from app.services.directory_traversal import SmbCompoundDirectoryReader

    server = smb_directory_server
    server.connection.sequence_window["high"] = 128
    server.directories["base\\parent"] = []
    server.directories["base\\other"] = []
    server.identifiers.update({"base\\parent": 42, "base\\other": 43})
    reads = [
        SmbCompoundDirectoryReader(server.tree, path, identity.to_bytes(8, "little"), lambda: None, deferred=True)
        for path, identity in (("base\\parent", 42), ("base\\other", 43))
    ]
    try:
        assert len(server.compounds) == 2
        assert not server.received
        for read in reads:
            read.finish()
            assert read.complete
    finally:
        for read in reads:
            read.close()


@pytest.mark.parametrize("empty", [False, True])
def test_smb_compound_small_directory_uses_one_request_group(smb_directory_server, empty):
    from smbprotocol.header import Commands
    from smbprotocol.open import CreateOptions, QueryDirectoryFlags, ShareAccess

    from app.services.directory_traversal import SmbCompoundDirectoryReader

    server = smb_directory_server
    server.connection.sequence_window["high"] = 128
    server.directories["base\\parent"] = [] if empty else [("Exact", 16), ("file", 0)]
    server.identifiers["base\\parent"] = 42
    reader = SmbCompoundDirectoryReader(server.tree, "base\\parent", (42).to_bytes(8, "little"), lambda: None)
    try:
        assert reader.complete
        assert [entry.name for entry in reader] == ([] if empty else ["Exact", "file"])
        assert len(server.compounds) == 1
        messages = server.compounds[0]
        assert [message.COMMAND for message in messages] == [
            Commands.SMB2_CREATE,
            Commands.SMB2_QUERY_INFO,
            Commands.SMB2_QUERY_DIRECTORY,
            Commands.SMB2_QUERY_DIRECTORY,
            Commands.SMB2_CLOSE,
        ]
        assert messages[0]["create_options"].get_value() & CreateOptions.FILE_OPEN_REPARSE_POINT
        assert messages[0]["share_access"].get_value() & ShareAccess.FILE_SHARE_DELETE
        assert messages[2]["flags"].get_value() == QueryDirectoryFlags.SMB2_RESTART_SCANS
        assert messages[3]["flags"].get_value() == 0
        assert server.received == list(range(5))
        reader.verify_file_id((42).to_bytes(8, "little"))
        reader.verify()
        assert not server.handles[-1].connected
        assert not server.tree.session.open_table
    finally:
        reader.close()


@pytest.mark.parametrize(
    "credits,multi_credit,maximum,expected",
    [
        (128, True, 2 * 1024 * 1024, 1024 * 1024),
        (128, False, 1024 * 1024, 64 * 1024),
        (5, True, 1024 * 1024, 64 * 1024),
        (128, True, 32 * 1024, 32 * 1024),
        (1, True, 1024 * 1024, None),
    ],
)
def test_smb_compound_bounds_buffer_to_negotiation_and_credits(smb_directory_server, credits, multi_credit, maximum, expected):
    from app.services.directory_traversal import SmbCompoundDirectoryReader

    server = smb_directory_server
    server.connection.sequence_window["high"] = credits
    server.connection.supports_multi_credit = multi_credit
    server.connection.max_transact_size = maximum
    server.directories["base\\parent"] = []
    server.identifiers["base\\parent"] = 42
    reader = SmbCompoundDirectoryReader(server.tree, "base\\parent", (42).to_bytes(8, "little"), lambda: None)
    try:
        if expected is None:
            assert not reader.complete
            assert not server.compounds
        else:
            assert reader.complete
            assert server.compounds[0][2]["output_buffer_length"].get_value() == expected
            assert server.compounds[0][3]["output_buffer_length"].get_value() == expected
    finally:
        reader.close()


@pytest.mark.parametrize("unsafe", ["file_id", "reparse", "not_directory"])
def test_smb_compound_rejects_unsafe_open_after_draining(smb_directory_server, unsafe):
    from app.services.directory_traversal import DirectoryTraversalError, SmbCompoundDirectoryReader

    server = smb_directory_server
    server.connection.sequence_window["high"] = 128
    server.identifiers["base\\parent"] = 43 if unsafe == "file_id" else 42
    server.attributes["base\\parent"] = {"file_id": 16, "reparse": 16 | 1024, "not_directory": 0}[unsafe]
    with pytest.raises(DirectoryTraversalError):
        SmbCompoundDirectoryReader(server.tree, "base\\parent", (42).to_bytes(8, "little"), lambda: None)
    assert server.received == list(range(5))
    assert not server.tree.session.open_table


@pytest.mark.parametrize(
    "position,status",
    [
        (0, NtStatus.STATUS_OBJECT_NAME_NOT_FOUND),
        (0, NtStatus.STATUS_OBJECT_PATH_NOT_FOUND),
        (0, NtStatus.STATUS_STOPPED_ON_SYMLINK),
        (0, NtStatus.STATUS_ACCESS_DENIED),
        (1, NtStatus.STATUS_ACCESS_DENIED),
        (2, NtStatus.STATUS_ACCESS_DENIED),
        (3, NtStatus.STATUS_ACCESS_DENIED),
        (4, NtStatus.STATUS_ACCESS_DENIED),
    ],
)
def test_smb_compound_drains_failures_and_preserves_first_error(smb_directory_server, position, status):
    from app.services.directory_traversal import SmbCompoundDirectoryReader

    server = smb_directory_server
    server.connection.sequence_window["high"] = 128
    server.identifiers["base\\parent"] = 42
    server.compound_errors[position] = status
    with pytest.raises(SMBResponseException) as failure:
        SmbCompoundDirectoryReader(server.tree, "base\\parent", (42).to_bytes(8, "little"), lambda: None)
    assert failure.value.status == status
    assert server.received[:5] == list(range(5))
    assert len(server.standalone) == (1 if position == 4 else 0)
    assert not server.tree.session.open_table


@pytest.mark.parametrize("position", [2, 3])
def test_smb_compound_rejects_empty_successful_response(smb_directory_server, position):
    from app.services.directory_traversal import DirectoryTraversalError, SmbCompoundDirectoryReader

    server = smb_directory_server
    server.connection.sequence_window["high"] = 128
    server.identifiers["base\\parent"] = 42
    server.empty_compound_response = position
    with pytest.raises(DirectoryTraversalError, match="invalid response data"):
        SmbCompoundDirectoryReader(server.tree, "base\\parent", (42).to_bytes(8, "little"), lambda: None)
    assert server.received == list(range(5))


@pytest.mark.parametrize(
    "status,exception",
    [
        (NtStatus.STATUS_OBJECT_NAME_NOT_FOUND, "_DescendantMissing"),
        (NtStatus.STATUS_OBJECT_PATH_NOT_FOUND, "_DescendantMissing"),
        (NtStatus.STATUS_ACCESS_DENIED, "_DescendantAccessDenied"),
    ],
)
def test_smb_compound_source_errors_keep_cache_classification(sqlite_cache, smb_directory_server, status, exception):
    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    cache = sqlite_cache
    server = smb_directory_server
    cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(cache)
    try:
        cache._source_root.read("", lambda: None).close()
        cache.index.seed_scan(1)
        cache.index.write_scan_children(1, [("parent", True)], file_ids={"parent": (42).to_bytes(8, "little")})
        cache._progress_generation = 1
        cache._watcher_ready.set()
        cache.coordinator.observed_ready = cache._watcher_ready.is_set
        server.connection.sequence_window["high"] = 128
        server.compound_errors[0] = status
        with cache.coordinator.read("parent", observed=True) as token:
            with pytest.raises(getattr(cache, exception)):
                cache._source_call("parent", lambda: cache._open_source_read("parent", token))
        assert server.received == list(range(5))
    finally:
        cache._source_root.close()


@pytest.mark.parametrize("credits", [1, 128])
def test_smb_compound_large_directory_or_low_credits_use_loop(smb_directory_server, credits):
    from smbprotocol.header import Commands

    from app.services.directory_traversal import SmbDirectoryRoot

    server = smb_directory_server
    root = SmbDirectoryRoot(r"\\host\share\base")
    try:
        root.read("", lambda: None).close()
        before = root.io.round_trips
        handles_before = len(server.handles)
        metadata_before = len(server.file_queries) + server.volume_queries
        queries_before = len(server.query_buffers)
        server.connection.sequence_window["high"] = credits
        server.identifiers["base\\parent"] = 42
        read = root.read_observed("parent", (42).to_bytes(8, "little"), lambda: None)
        try:
            assert [entry.name for entry in read] == ["Exact", "file", "redirect"]
            assert read.has_directory_child("Exact")
            assert len(server.compounds) == (1 if credits > 1 else 0)
            assert not server.tree.session.open_table
        finally:
            read.close()
        expected = (
            2 * (len(server.handles) - handles_before - len(server.compounds))
            + len(server.file_queries)
            + server.volume_queries
            - metadata_before
            + len(server.query_buffers)
            - queries_before
            - sum(message.COMMAND == Commands.SMB2_QUERY_DIRECTORY for messages in server.compounds for message in messages)
            + len(server.compounds)
        )
        assert root.io.round_trips - before == expected
    finally:
        root.close()


def test_smb_observed_read_opens_only_target_and_uses_safe_child_lookup(smb_directory_server):
    from app.services.directory_traversal import SmbDirectoryRoot

    server = smb_directory_server
    root = SmbDirectoryRoot(r"\\host\share\base")
    try:
        root.read("", lambda: None).close()
        server.identifiers["base\\parent"] = 42
        before = len(server.handles)
        read = root.read_observed("parent", (42).to_bytes(8, "little"), lambda: None)
        try:
            assert [handle.path for handle in server.handles[before:]] == ["base\\parent"]
            assert [entry.name for entry in read] == ["Exact", "file", "redirect"]
            assert read.has_directory_child("Exact")
            assert len(server.handles) - before == 2
        finally:
            read.close()
    finally:
        root.close()


@pytest.mark.parametrize("unsafe", ["file_id", "reparse", "session", "tree", "name", "unbound"])
def test_smb_observed_read_rejects_changed_identity(smb_directory_server, unsafe, monkeypatch):
    from app.services.directory_traversal import DirectoryTraversalError, SmbDirectoryRoot

    server = smb_directory_server
    root = SmbDirectoryRoot(r"\\host\share\base")
    try:
        if unsafe != "unbound":
            root.read("", lambda: None).close()
        server.identifiers["base\\parent"] = 42
        if unsafe == "file_id":
            server.identifiers["base\\parent"] = 43
        elif unsafe == "reparse":
            monkeypatch.setattr("app.services.directory_traversal.Open.file_attributes", 16 | 1024)
        elif unsafe == "session":
            server.tree.session.session_id += 1
        elif unsafe == "tree":
            server.tree.tree_connect_id += 1
        elif unsafe == "name":
            server.names["base\\parent"] = "\\outside"
        with pytest.raises(DirectoryTraversalError):
            root.read_observed("parent", (42).to_bytes(8, "little"), lambda: None)
    finally:
        root.close()


@pytest.mark.parametrize("scenario", ["early_event", "late_event", "not_ready", "watcher_loss"])
@pytest.mark.parametrize("credits", [0, 128])
def test_smb_observed_containment_and_safe_fallback(sqlite_cache, smb_directory_server, monkeypatch, scenario, credits):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import ScanObservationInvalidated, SQLiteConnectionDirectoryCache, _DirectoryMutation
    from app.services.directory_traversal import SmbDirectoryRoot

    cache = sqlite_cache
    server = smb_directory_server
    server.connection.sequence_window["high"] = credits
    server.directories["base\\parent"] = [("Exact", 16)]
    server.directories["base\\parent\\Exact"] = []
    server.record_ids = True
    cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(cache)
    if scenario != "not_ready":
        cache._watcher_ready.set()
    observed = []
    safe = []
    original_observed = cache._source_root.read_observed
    original_safe = cache._source_root.read

    def safe_read(parent, check, **session):
        safe.append(parent)
        return original_safe(parent, check, **session)

    def observed_read(parent, expected_id, check, **session):
        observed.append(parent)
        read = original_observed(parent, expected_id, check, **session)
        if parent == "parent" and scenario in ("early_event", "watcher_loss"):
            if scenario == "early_event":
                cache.coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "parent"))
            else:
                cache._watcher_ready.clear()
                cache._observation_lost()
            with pytest.raises(ScanObservationInvalidated):
                next(read)
        return read

    monkeypatch.setattr(cache._source_root, "read", safe_read)
    monkeypatch.setattr(cache._source_root, "read_observed", observed_read)
    try:
        if scenario == "early_event":
            with pytest.raises(ScanObservationInvalidated):
                cache._scan_disk_queue()
            assert "parent/Exact" not in {row.path for row in cache.index.search("parent").results}
            assert cache.index.pending_scan_paths(1)
        else:
            cache._scan_disk_queue()
            assert cache.index.status().coverage == ("uncertain" if scenario == "watcher_loss" else "complete")
            assert "parent/Exact" in {row.path for row in cache.index.search("parent").results}
            if scenario == "not_ready":
                assert not observed
                assert "parent" in safe
            elif scenario == "watcher_loss":
                assert observed == ["parent"]
                assert "parent" in safe
                assert cache.coordinator.observed_reads_blocked
            else:
                assert "parent" in observed
                cache.coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "parent"))
                cache.coordinator.apply_pending()
                assert not cache.index.search("parent").results
    finally:
        cache._source_root.close()


def test_smb_root_holds_ancestors_and_checks_exact_children(smb_directory_server):
    from app.services.directory_traversal import DirectoryTraversalError, SmbDirectoryRoot

    root = SmbDirectoryRoot(r"\\host\share\base")
    read = root.read("parent", lambda: None)
    try:
        assert all(handle.connected for handle in smb_directory_server.handles)
        assert [entry.name for entry in read] == ["Exact", "file", "redirect"]
        assert read.has_directory_child("Exact")
        assert not read.has_directory_child("exact")
        assert not read.has_directory_child("file")
        assert not read.has_directory_child("missing")
        with pytest.raises(DirectoryTraversalError):
            read.has_directory_child("redirect")
        assert smb_directory_server.patterns.count("*") == 3
        assert set(smb_directory_server.patterns) == {"*", "Exact", "exact", "file", "missing", "redirect"}
    finally:
        read.close()
        assert any(handle.connected for handle in smb_directory_server.handles)
        root.close()
    assert all(not handle.connected for handle in smb_directory_server.handles)


@pytest.mark.parametrize("replacement", ["file", "session", "tree", "name"])
def test_smb_root_rejects_replaced_bindings(smb_directory_server, replacement):
    from uuid import UUID

    from app.services.directory_traversal import DirectoryTraversalError, SmbDirectoryRoot

    root = SmbDirectoryRoot(r"\\host\share\base")
    root.read("", lambda: None).close()
    if replacement == "file":
        smb_directory_server.identifiers["base"] += 1
    elif replacement == "volume":
        smb_directory_server.volumes["base"] = 2
    elif replacement == "server":
        smb_directory_server.connection.server_guid = UUID(int=2)
    elif replacement == "session":
        smb_directory_server.tree.session.session_id += 1
    elif replacement == "tree":
        smb_directory_server.tree.tree_connect_id += 1
    else:
        smb_directory_server.names["base"] = "\\outside"
    try:
        with pytest.raises(DirectoryTraversalError):
            root.read("parent", lambda: None)
    finally:
        root.close()


@pytest.mark.parametrize("unsafe", ["dfs", "redirected_parent"])
def test_smb_root_refuses_unverified_parent_sources(smb_directory_server, unsafe):
    from app.services.directory_traversal import DirectoryTraversalError, SmbDirectoryRoot

    if unsafe == "dfs":
        smb_directory_server.tree.is_dfs_share = True
    elif unsafe == "zero_id":
        smb_directory_server.identifiers["base"] = 0
    elif unsafe == "zero_volume":
        smb_directory_server.volumes["base"] = 0
    elif unsafe == "redirected_parent":
        smb_directory_server.names["base\\parent"] = "\\outside\\parent"
    else:
        smb_directory_server.volumes["base\\parent"] = 2
    with pytest.raises(DirectoryTraversalError):
        SmbDirectoryRoot(r"\\host\share\base").read("parent", lambda: None)


@pytest.mark.parametrize("file_id", [0, 0xFFFFFFFFFFFFFFFF, 1])
def test_smb_root_accepts_unavailable_ids_and_inconsistent_volume_metadata(smb_directory_server, file_id):
    from app.services.directory_traversal import SmbDirectoryRoot

    smb_directory_server.identifiers["base"] = file_id
    smb_directory_server.volumes["base"] = 0
    smb_directory_server.volumes["base\\parent"] = 2
    smb_directory_server.tree.session.session_id = 0
    smb_directory_server.tree.tree_connect_id = 0
    root = SmbDirectoryRoot(r"\\host\share\base")
    try:
        read = root.read("parent", lambda: None)
        try:
            assert [entry.name for entry in read] == ["Exact", "file", "redirect"]
            smb_directory_server.volumes["base\\parent"] += 1
            read.verify()
        finally:
            read.close()
    finally:
        root.close()


@pytest.mark.parametrize("parent", ["", "parent", "parent/nested"])
def test_smb_root_reuses_pinned_chain_between_full_probes(smb_directory_server, parent):
    from app.services.directory_traversal import SmbDirectoryRoot

    server = smb_directory_server
    server.directories["base\\parent\\nested"] = []
    root = SmbDirectoryRoot(r"\\host\share\base")
    try:
        root.read("", lambda: None).close()
        opened = len(server.handles)
        server.file_queries.clear()
        read = root.read(parent, lambda: None, full_root_check=False)
        try:
            read.verify()
            assert "" not in server.file_queries
            assert "base" not in server.file_queries
            assert len(server.handles) - opened == (len(parent.split("/")) if parent else 0)
        finally:
            read.close()
        assert all(handle.connected for handle in server.handles[:opened])
    finally:
        root.close()


@pytest.mark.parametrize("change", ["closed", "session", "tree", "connection", "server"])
def test_smb_local_root_checks_reject_binding_changes_without_metadata(smb_directory_server, change):
    from uuid import UUID

    from app.services.directory_traversal import DirectoryBindingChangedError, SmbDirectoryRoot

    server = smb_directory_server
    root = SmbDirectoryRoot(r"\\host\share\base")
    try:
        root.read("", lambda: None).close()
        server.file_queries.clear()
        if change == "closed":
            server.handles[0]._connected = False
        elif change == "session":
            server.tree.session.session_id += 1
        elif change == "tree":
            server.tree.tree_connect_id += 1
        elif change == "connection":
            server.tree.session.connection = SimpleNamespace(**vars(server.connection))
        else:
            server.connection.server_guid = UUID(int=2)
        with pytest.raises(DirectoryBindingChangedError):
            root.read("parent", lambda: None, full_root_check=False)
        assert not server.file_queries
    finally:
        root.close()


def test_smb_local_root_read_failure_preserves_pins_and_requires_full_probe(smb_directory_server):
    from app.services.directory_traversal import SmbDirectoryRoot

    server = smb_directory_server
    root = SmbDirectoryRoot(r"\\host\share\base")
    try:
        root.read("", lambda: None).close()
        pinned = list(server.handles)
        with pytest.raises(FileNotFoundError):
            root.read("missing", lambda: None, full_root_check=False)
        assert all(handle.connected for handle in pinned)
        server.file_queries.clear()
        root.read("parent", lambda: None, full_root_check=False).close()
        assert "base" in server.file_queries
        assert "" in server.file_queries
    finally:
        root.close()


def test_smb_scan_safe_reads_limit_root_queries_to_boundary_probes(smb_pipeline_cache):
    cache, server, parents = smb_pipeline_cache
    cache._watcher_ready.clear()
    cache._scan_disk_queue()
    assert cache.index.status().coverage == "complete"
    assert cache.index.search("").directory_count == len(parents)
    assert server.file_queries.count("") == 3
    assert server.file_queries.count("base") == 5
    assert not cache.coordinator._producers


def test_smb_source_error_requires_full_probe_before_observed_read(smb_pipeline_cache):
    from app.services.directory_traversal import DirectoryBindingChangedError

    cache, server, parents = smb_pipeline_cache
    cache._source_root.read("", lambda: None).close()

    def denied():
        raise PermissionError("Injected source access denial.")

    with pytest.raises(cache._DescendantAccessDenied):
        cache._source_call(parents[0], denied)
    server.identifiers["base"] += 1
    with pytest.raises(DirectoryBindingChangedError):
        cache._source_root.read_observed(parents[0], (42).to_bytes(8, "little"), lambda: None)
    assert not server.compounds


def test_smb_end_probe_rejects_root_changed_during_local_reads(smb_pipeline_cache):
    from app.services.directory_cache import DirectorySourceUnavailableError, InvalidationReason

    cache, server, parents = smb_pipeline_cache
    cache._watcher_ready.clear()
    changed = False

    def replace_root():
        nonlocal changed
        if not changed and server.file_queries and server.file_queries[-1] == "base\\" + parents[0]:
            changed = True
            server.identifiers["base"] += 1

    server.on_query = replace_root
    with pytest.raises(DirectorySourceUnavailableError):
        cache._scan_disk_queue()
    assert changed
    assert not cache._source_available.is_set()
    assert cache.coordinator.last_reason == InvalidationReason.SOURCE_REBIND
    assert not cache.coordinator._producers


def test_smb_root_caches_volume_information_per_tree(smb_directory_server):
    from app.services.directory_traversal import DirectoryTraversalError, SmbDirectoryRoot

    root = SmbDirectoryRoot(r"\\host\share\base")
    try:
        for _ in range(2):
            read = root.read("parent", lambda: None)
            try:
                read.verify()
                assert read.has_directory_child("Exact")
            finally:
                read.close()
        assert smb_directory_server.volume_queries == 1
        smb_directory_server.identifiers["base"] += 1
        with pytest.raises(DirectoryTraversalError):
            root.read("parent", lambda: None)
    finally:
        root.close()


@pytest.mark.parametrize("scope", ["tree_object", "connection", "session", "tree_id"])
@pytest.mark.parametrize("unsupported", [False, True])
def test_smb_volume_cache_is_scoped_to_live_tree_binding(smb_directory_server, scope, unsupported):
    from app.services.directory_traversal import SmbDirectoryHandle

    server = smb_directory_server
    cache = {}
    if unsupported:
        server.volume_error = _smb_response_error(NtStatus.STATUS_NOT_SUPPORTED)
    first = SmbDirectoryHandle(r"\\host\share\base", lambda: None, volume_cache=cache)
    try:
        first.identity(lambda: None)
        first.identity(lambda: None)
        assert server.volume_queries == 1
        server.volume_error = None
        if scope == "tree_object":
            server.tree = SimpleNamespace(**vars(server.tree))
        elif scope == "connection":
            server.tree.session.connection = SimpleNamespace(**vars(server.connection))
        elif scope == "session":
            server.tree.session.session_id += 1
        else:
            server.tree.tree_connect_id += 1
        second = SmbDirectoryHandle(r"\\host\share\base", lambda: None, volume_cache=cache)
        try:
            assert second.identity(lambda: None).volume_serial == 1
            second.identity(lambda: None)
            assert server.volume_queries == 2
        finally:
            second.close()
    finally:
        first.close()


def test_smb_volume_cache_does_not_cache_access_failure(smb_directory_server):
    from app.services.directory_traversal import SmbDirectoryHandle

    server = smb_directory_server
    handle = SmbDirectoryHandle(r"\\host\share\base", lambda: None)
    try:
        server.volume_error = _smb_response_error(NtStatus.STATUS_ACCESS_DENIED)
        with pytest.raises(SMBResponseException):
            handle.identity(lambda: None)
        server.volume_error = None
        handle.identity(lambda: None)
        handle.identity(lambda: None)
        assert server.volume_queries == 2
    finally:
        handle.close()


@pytest.mark.parametrize(
    ("negotiated", "credits", "multi_credit", "expected"),
    [
        (2 * 1024 * 1024, 128, True, 1024 * 1024),
        (1024 * 1024, 20, True, 4 * 65536),
        (1024 * 1024, 1, True, 65536),
        (1024 * 1024, 128, False, 65536),
        (32768, 128, True, 32768),
    ],
)
def test_smb_loop_query_buffers_respect_limits(smb_directory_server, negotiated, credits, multi_credit, expected):
    from app.services.directory_traversal import SmbDirectoryHandle

    server = smb_directory_server
    server.connection.max_transact_size = negotiated
    server.connection.sequence_window = {"low": 0, "high": credits}
    server.connection.supports_multi_credit = multi_credit
    handle = SmbDirectoryHandle(r"\\host\share\base\parent", lambda: None)
    try:
        assert list(handle.records(lambda: None))
        assert set(server.query_buffers) == {expected}
    finally:
        handle.close()


def test_smb_loop_query_buffers_shrink_after_credit_use(smb_directory_server):
    from app.services.directory_traversal import SmbDirectoryHandle

    server = smb_directory_server
    server.connection.sequence_window = {"low": 0, "high": 128}
    handle = SmbDirectoryHandle(r"\\host\share\base\parent", lambda: None)
    records = handle.records(lambda: None)
    try:
        next(records)
        server.connection.sequence_window = {"low": 0, "high": 17}
        list(records)
        assert server.query_buffers[0] == 1024 * 1024
        assert set(server.query_buffers[1:]) == {65536}
    finally:
        records.close()
        handle.close()


def test_smb_optional_volume_query_does_not_prevent_safe_traversal(smb_directory_server):
    from app.services.directory_traversal import SmbDirectoryRoot

    smb_directory_server.volume_error = _smb_response_error(NtStatus.STATUS_NOT_SUPPORTED)
    root = SmbDirectoryRoot(r"\\host\share\base")
    try:
        read = root.read("parent", lambda: None)
        try:
            assert [entry.name for entry in read] == ["Exact", "file", "redirect"]
            read.verify()
            assert smb_directory_server.volume_queries == 1
        finally:
            read.close()
    finally:
        root.close()


@pytest.mark.parametrize("lookup", [False, True])
def test_smb_native_read_checks_cancellation_after_protocol_calls(smb_directory_server, lookup):
    from app.services.directory_traversal import SmbDirectoryRoot

    cancelled = False

    def check():
        if cancelled:
            raise InterruptedError("Injected cancellation.")

    def cancel():
        nonlocal cancelled
        cancelled = True

    root = SmbDirectoryRoot(r"\\host\share\base")
    read = root.read("parent", check)
    smb_directory_server.on_query = cancel
    try:
        with pytest.raises(InterruptedError):
            if lookup:
                read.has_directory_child("Exact")
            else:
                next(read)
    finally:
        read.close()
        root.close()


def test_idle_source_queries_preserve_running_reads(sqlite_cache, smb_directory_server):
    from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT
    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    cache = sqlite_cache
    cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(cache)
    cache.index.write_paths(["parent/Exact"])
    assert cache.index.finish_generation(1)
    cache._probe_source_root()
    accepted = cache.index.search("Exact")
    token = cache.coordinator.begin_read("parent")
    try:
        cache._last_access -= DIRECTORY_INDEX_CONTRACT.limits["idle_release_seconds"]
        assert cache.search_index("Exact") == accepted
        assert cache.coordinator.is_current(token)
        assert cache._source_available.is_set()
        assert cache.index.search("Exact") == accepted
    finally:
        cache.coordinator.end_read(token)
        cache._source_root.close()


def test_smb_reconciliation_worker_prunes_missing_subtrees_and_discovers_children(sqlite_cache, smb_directory_server):
    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    sqlite_cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    smb_directory_server.directories["base\\parent"] = [("Exact", 16), ("file", 0), ("New", 16)]
    smb_directory_server.directories["base\\parent\\New"] = [("child", 16)]
    smb_directory_server.directories["base\\parent\\New\\child"] = []
    sqlite_cache.index.write_paths(["parent", "parent/Exact", "parent/old", "parent/old/leaf", "outside"])
    assert sqlite_cache.index.finish_generation(1)
    before = sqlite_cache.index.search("")
    sqlite_cache.index.queue_reconciliation_parent(1, "parent")
    sqlite_cache._reconcile_disk_queue()
    assert sqlite_cache.index.reconciliation_generation() is None
    assert sqlite_cache.index.search("old").total_matches == 0
    assert sqlite_cache.index.search("New/child").total_matches == 1
    assert sqlite_cache.index.search("Exact").total_matches == 1
    assert sqlite_cache.index.search("outside").total_matches == 1
    assert sqlite_cache.index.search("file").total_matches == 0
    assert sqlite_cache.index.search("").last_verified_at_ms == before.last_verified_at_ms
    assert not sqlite_cache._scan_running.is_set()
    assert not sqlite_cache.coordinator._producers
    sqlite_cache._request_stop()
    sqlite_cache._finish_stop()
    assert all(not handle.connected for handle in smb_directory_server.handles)


@pytest.mark.parametrize("processed", [False, True])
def test_smb_reconciliation_reads_replaced_child_with_refreshed_file_id(smb_source_cache, smb_directory_server, monkeypatch, processed):
    cache = smb_source_cache
    server = smb_directory_server
    server.record_ids = True
    server.directories["base\\parent"] = [("child", 16)]
    server.directories["base\\parent\\child"] = []
    cache.index.write_paths(["parent"])
    assert cache.index.finish_generation(1)
    cache.index.queue_reconciliation_parent(1, "parent")
    cache._scan_parent(1, "parent", reconcile=True)
    old_id = cache.index.scan_parent_file_id(1, "parent/child")
    assert old_id is not None
    if processed:
        cache._scan_parent(1, "parent/child", reconcile=True)
        assert not cache.index.scan_parent_pending(1, "parent/child")
    new_id = int.from_bytes(old_id, "little") + 100
    server.identifiers["base\\parent\\child"] = new_id
    server.directories["base\\parent\\child"] = [("new-descendant", 16)]
    server.directories["base\\parent\\child\\new-descendant"] = []
    cache.index.queue_reconciliation_parent(1, "parent")
    monkeypatch.setattr("app.services.directory_cache.time.monotonic", lambda: cache._last_access)
    cache._reconcile_disk_queue()
    assert cache.index.scan_parent_file_id(1, "parent/child") == new_id.to_bytes(8, "little")
    assert cache.index.search("new-descendant").total_matches == 1
    assert cache.index.reconciliation_generation() is None
    assert cache.index.status().coverage == "complete"
    assert cache.index.status().issue_count == 0
    assert not cache.coordinator._producers


@pytest.fixture
def smb_source_cache(sqlite_cache, smb_directory_server):
    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    sqlite_cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    try:
        yield sqlite_cache
    finally:
        sqlite_cache._request_stop()
        sqlite_cache._finish_stop()


def test_reconnected_candidate_revalidates_completed_branches(smb_source_cache, smb_directory_server, monkeypatch):
    cache = smb_source_cache
    server = smb_directory_server
    server.directories["base"] = [("old", 16), ("later", 16)]
    server.directories["base\\old"] = []
    server.directories["base\\later"] = []
    cache.index.write_paths(["accepted"])
    assert cache.index.finish_generation(1)
    scan_parent = cache._scan_parent

    def interrupt(generation, parent, **kwargs):
        if parent == "later":
            raise ConnectionError("Injected disconnection after a completed branch.")
        return scan_parent(generation, parent, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(cache, "_scan_parent", interrupt)
        with pytest.raises(ConnectionError):
            cache._scan_disk_queue()
    candidate, selected = cache.index.prepare_scan()
    assert not selected
    assert cache.index.pending_scan_paths(candidate) == ["old", "later"]
    server.directories["base"] = [("later", 16), ("new", 16)]
    del server.directories["base\\old"]
    server.directories["base\\new"] = []
    server.tree.session.session_id += 1
    _lose_observations(cache.coordinator)
    cache._source_root = cache._source_root.replacement()
    cache._probe_source_root()
    cache._scan_disk_queue()
    result = cache.index.search("old new later")
    assert {row.path for row in result.results} == {"new", "later"}
    assert result.coverage == "complete"
    assert result.last_verified_at_ms is not None
    assert cache.index._connection().execute("SELECT selected_generation FROM source_metadata").fetchone()[0] == candidate


@pytest.mark.parametrize("reconcile", [False, True])
@pytest.mark.parametrize("parent", ["parent", "parent/old"])
@pytest.mark.parametrize("missing_status", [None, NtStatus.STATUS_OBJECT_NAME_NOT_FOUND, NtStatus.STATUS_NOT_A_DIRECTORY])
def test_missing_queued_smb_parent_recovers_without_watcher_hint(
    smb_source_cache, smb_directory_server, monkeypatch, reconcile, parent, missing_status
):
    from app.services import directory_traversal

    sqlite_cache = smb_source_cache
    server = smb_directory_server
    sqlite_cache.index.write_paths(["parent", "parent/old", "outside"])
    assert sqlite_cache.index.finish_generation(1)
    before = sqlite_cache.index.status()
    sqlite_cache._probe_source_root()
    sqlite_cache.index.queue_reconciliation_parent(1, parent)
    server.directories["base"] = [("outside", 16)]
    server.directories["base\\outside"] = []
    del server.directories["base\\parent"]
    original_create = directory_traversal.Open.create

    def create(handle, *args):
        if missing_status is not None and handle.path.startswith("base\\parent"):
            raise _smb_response_error(missing_status)
        return original_create(handle, *args)

    monkeypatch.setattr(directory_traversal.Open, "create", create)
    if reconcile:
        sqlite_cache._reconcile_disk_queue()
    else:
        sqlite_cache._scan_disk_queue()
    after = sqlite_cache.index.search("parent outside")
    assert [row.path for row in after.results] == ["outside"]
    assert sqlite_cache.index.reconciliation_generation() is None
    assert sqlite_cache._source_available.is_set()
    assert not sqlite_cache.coordinator._producers
    assert sqlite_cache._failure_retry_delay == 0
    if reconcile:
        assert after.last_verified_at_ms == before.last_verified_at_ms
        sqlite_cache._scan_disk_queue()
    assert sqlite_cache.index.status().coverage == "complete"


def test_missing_smb_parent_recovery_does_not_hide_storage_failure(smb_source_cache, smb_directory_server, monkeypatch):
    sqlite_cache = smb_source_cache
    smb_directory_server.directories["base\\parent"] = []
    sqlite_cache.index.write_paths(["parent", "parent/old"])
    assert sqlite_cache.index.finish_generation(1)
    sqlite_cache.index.queue_reconciliation_parent(1, "parent")
    before = sqlite_cache.index.status()
    original = FileNotFoundError("Injected local index failure.")
    monkeypatch.setattr(sqlite_cache.index, "commit_scan_parents", Mock(side_effect=original))
    with pytest.raises(FileNotFoundError) as caught:
        sqlite_cache._reconcile_disk_queue()
    assert caught.value is original
    assert sqlite_cache.index.status() == before
    assert sqlite_cache.index.pending_scan_paths(1) == ["parent"]


def test_missing_smb_parent_recovery_rejects_stale_ancestor(smb_source_cache, smb_directory_server, monkeypatch):
    from app.services.directory_cache import ScanObservationInvalidated
    from app.services.directory_traversal import SmbDirectoryRead

    sqlite_cache = smb_source_cache
    sqlite_cache.index.write_paths(["parent", "parent/old"])
    assert sqlite_cache.index.finish_generation(1)
    sqlite_cache.index.queue_reconciliation_parent(1, "parent")
    smb_directory_server.directories["base"] = []
    del smb_directory_server.directories["base\\parent"]
    before = sqlite_cache.index.status()
    lookup = SmbDirectoryRead.has_directory_child

    def invalidate(read, name):
        result = lookup(read, name)
        _lose_observations(sqlite_cache.coordinator)
        return result

    monkeypatch.setattr(SmbDirectoryRead, "has_directory_child", invalidate)
    with pytest.raises(ScanObservationInvalidated):
        sqlite_cache._reconcile_disk_queue()
    assert sqlite_cache.index.status() == before
    assert sqlite_cache.index.pending_scan_paths(1) == ["parent"]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["delete", "copy"])
@pytest.mark.parametrize("failed", [False, True])
async def test_recursive_smb_mutations_reconcile_partial_results(sqlite_cache, smb_directory_server, monkeypatch, failed, operation):
    import stat
    from contextlib import asynccontextmanager
    from pathlib import PureWindowsPath

    from smbclient._os import FileAttributes

    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot
    from app.storage.smb import SMBBackend

    directory_attributes = FileAttributes.FILE_ATTRIBUTE_DIRECTORY
    server = smb_directory_server
    server.tree.share_name = r"\\fixture\share"
    server.directories.update(
        {
            "base\\parent": [("target", directory_attributes)],
            "base\\parent\\target": [("removed", directory_attributes), ("protected", directory_attributes)],
            "base\\parent\\target\\removed": [],
            "base\\parent\\target\\protected": [],
        }
    )
    backend = SMBBackend(
        host="fixture", share_name="share", username="user", password="password", connection_context_key="fixture", path_prefix="base"
    )
    sqlite_cache._path_prefix = "base"
    sqlite_cache._smb_base_path = backend._build_smb_path("")
    sqlite_cache._source_root = SmbDirectoryRoot(sqlite_cache._smb_base_path)
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    index = sqlite_cache.index
    index.write_paths(["parent", "parent/target", "parent/target/removed", "parent/target/protected", "outside"])
    assert index.finish_generation(1)
    before = index.search("")
    manager = SimpleNamespace(get_cache=lambda _connection_id: sqlite_cache)
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: manager)

    @asynccontextmanager
    async def connected(**kwargs):
        yield

    async def pool():
        return SimpleNamespace(get_connection=connected, connection_diagnostics=lambda _cache: {}, generation_aborting=lambda _cache: False)

    def scan(path, **kwargs):
        relative = "\\".join(PureWindowsPath(path).parts[1:])
        for name, _attributes in server.directories[relative]:
            yield SimpleNamespace(name=name, path=str(PureWindowsPath(path) / name))

    def remove(path, **kwargs):
        relative = "\\".join(PureWindowsPath(path).parts[1:])
        if failed and relative.endswith("\\protected"):
            raise PermissionError("Injected descendant deletion denial.")
        parent, _, name = relative.rpartition("\\")
        server.directories[parent] = [(child, attributes) for child, attributes in server.directories[parent] if child != name]
        del server.directories[relative]

    def create(path, **kwargs):
        relative = "\\".join(PureWindowsPath(path).parts[1:])
        if failed and relative.endswith("\\protected"):
            raise PermissionError("Injected descendant copy denial.")
        parent, _, name = relative.rpartition("\\")
        server.directories[parent].append((name, directory_attributes))
        server.directories[relative] = []

    monkeypatch.setattr("app.storage.smb.get_connection_pool", pool)
    monkeypatch.setattr(
        "app.storage.smb.smbclient.stat", lambda *args, **kwargs: SimpleNamespace(st_mode=stat.S_IFDIR, st_atime=0, st_mtime=0)
    )
    monkeypatch.setattr("app.storage.smb.smbclient.scandir", scan)
    monkeypatch.setattr("app.storage.smb.smbclient.rmdir", remove)
    monkeypatch.setattr("app.storage.smb.smbclient.mkdir", create)
    monkeypatch.setattr("app.storage.smb.smbclient.path.exists", lambda *args, **kwargs: False)
    monkeypatch.setattr("app.storage.smb.smbclient.utime", lambda *args, **kwargs: None)
    try:
        mutation = backend.delete_item("parent/target") if operation == "delete" else backend.copy_item("parent/target", "parent/copied")
        if failed:
            with pytest.raises(PermissionError, match="Injected descendant"):
                await mutation
        else:
            await mutation
        assert ("base\\parent\\target\\removed" in server.directories) == (operation == "copy")
        assert index.search("removed").total_matches == 1
        sqlite_cache.coordinator.apply_pending()
        sqlite_cache._reconcile_disk_queue()
        after = sqlite_cache.search_index("parent outside")
        expected = {"parent", "outside"}
        if operation == "copy":
            expected.update({"parent/target", "parent/target/removed", "parent/target/protected", "parent/copied", "parent/copied/removed"})
            if not failed:
                expected.add("parent/copied/protected")
        elif failed:
            expected.update({"parent/target", "parent/target/protected"})
        assert {row.path for row in after.results} == expected
        assert after.total_matches == after.directory_count == len(expected)
        assert after.last_verified_at_ms == before.last_verified_at_ms
        assert index.accepted_generation() == 1
        assert index.reconciliation_generation() is None
        assert sqlite_cache.coordinator.verification_required
        assert not sqlite_cache.coordinator._producers
        assert sqlite_cache.resources.usage().reserved_bytes == 0
    finally:
        sqlite_cache._request_stop()
        sqlite_cache._finish_stop()


def test_smb_worker_root_replacement_hides_results_without_deleting_accepted_rows(sqlite_cache, smb_directory_server):
    from app.services.directory_cache import DirectorySourceUnavailableError, SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    sqlite_cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    sqlite_cache.index.write_paths(["parent", "parent/old", "parent/old/leaf"])
    assert sqlite_cache.index.finish_generation(1)
    sqlite_cache._probe_source_root()
    before = sqlite_cache.index.search("parent")
    sqlite_cache.index.queue_reconciliation_parent(1, "parent")
    smb_directory_server.identifiers["base"] += 1
    with pytest.raises(DirectorySourceUnavailableError, match="temporarily unavailable"):
        sqlite_cache._reconcile_disk_queue()
    assert sqlite_cache.index.search("parent") == before
    assert sqlite_cache.index.reconciliation_generation() == 1
    with pytest.raises(DirectorySourceUnavailableError):
        sqlite_cache.search_index("parent")
    assert sqlite_cache.coordinator.verification_required
    assert not sqlite_cache._source_available.is_set()
    assert not sqlite_cache._scan_running.is_set()
    assert not sqlite_cache.coordinator._producers
    sqlite_cache._request_stop()
    sqlite_cache._finish_stop()


def test_smb_snapshot_rejects_event_during_enumeration(sqlite_cache, smb_directory_server, monkeypatch):
    from app.services.directory_cache import ScanObservationInvalidated, SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    sqlite_cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    smb_directory_server.directories["base\\parent"] = [("Exact", 16)]
    sqlite_cache.index.write_paths(["parent", "parent/Exact", "parent/old", "parent/old/leaf"])
    assert sqlite_cache.index.finish_generation(1)
    sqlite_cache.index.queue_reconciliation_parent(1, "parent")
    before = sqlite_cache.index.search("parent")
    original = smb_directory_server.on_query

    def invalidate():
        original()
        _lose_observations(sqlite_cache.coordinator)

    monkeypatch.setattr(smb_directory_server, "on_query", invalidate)
    with pytest.raises(ScanObservationInvalidated):
        sqlite_cache._reconcile_disk_queue()
    assert sqlite_cache.index.search("parent") == before
    assert sqlite_cache.index.reconciliation_generation() == 1
    assert sqlite_cache.coordinator.verification_required
    assert not sqlite_cache.coordinator._producers
    assert not sqlite_cache._scan_running.is_set()
    sqlite_cache._request_stop()
    sqlite_cache._finish_stop()


@pytest.mark.parametrize("primary_failure", [False, True])
def test_smb_worker_closes_all_ancestors_and_preserves_primary_failure(sqlite_cache, smb_directory_server, monkeypatch, primary_failure):

    from app.services import directory_traversal
    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    sqlite_cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    smb_directory_server.directories["base\\parent"] = []
    sqlite_cache.index.write_paths(["parent", "parent/old"])
    assert sqlite_cache.index.finish_generation(1)
    sqlite_cache.index.queue_reconciliation_parent(1, "parent")
    failure = _smb_response_error(NtStatus.STATUS_PATH_NOT_COVERED)
    handle_type = directory_traversal.Open
    original_close = handle_type.close

    def close(handle):
        original_close(handle)
        if handle.path == "base\\parent":
            raise OSError("Injected close failure.")

    def query():
        if primary_failure:
            raise failure

    monkeypatch.setattr(handle_type, "close", close)
    smb_directory_server.on_query = query
    sqlite_cache._reconcile_disk_queue()
    if primary_failure:
        assert sqlite_cache.index.search("old").total_matches == 1
    assert sqlite_cache.index.status().coverage == "partial"
    assert sqlite_cache.index.reconciliation_generation() is None
    assert not sqlite_cache.coordinator._producers
    assert not sqlite_cache._scan_running.is_set()
    sqlite_cache._request_stop()
    sqlite_cache._finish_stop()


def test_smb_full_worker_reconciles_through_capture_and_retains_later_events(sqlite_cache, smb_directory_server, monkeypatch):
    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    sqlite_cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    smb_directory_server.directories.update(
        {"base": [("old", 16), ("stable", 16)], "base\\old": [("leaf", 16)], "base\\old\\leaf": [], "base\\stable": []}
    )
    sqlite_cache.index.write_paths(["old", "old/leaf", "stable"])
    assert sqlite_cache.index.finish_generation(1)
    original_scan = sqlite_cache._scan_parent
    original_accept = sqlite_cache.coordinator.accept_generation
    renamed = False
    captured = []

    def scan(generation, parent, *, reconcile=False):
        nonlocal renamed
        original_scan(generation, parent, reconcile=reconcile)
        if not parent and not reconcile and not renamed:
            renamed = True
            smb_directory_server.directories["base"] = [("new", 16), ("stable", 16)]
            smb_directory_server.directories["base\\new"] = [("leaf", 16)]
            smb_directory_server.directories["base\\new\\leaf"] = []
            del smb_directory_server.directories["base\\old"]
            del smb_directory_server.directories["base\\old\\leaf"]
            sqlite_cache.observe_parent("")

    def accept(baseline, generation, **kwargs):
        assert baseline == sqlite_cache.coordinator.capture_epoch()
        assert not sqlite_cache.coordinator._producers
        assert sqlite_cache.index.reconciliation_generation() is None
        assert not sqlite_cache.index.pending_scan_paths(generation)
        assert not sqlite_cache.coordinator.pending
        accepted = original_accept(baseline, generation, **kwargs)
        captured.append(accepted)
        sqlite_cache.observe_parent("")
        return accepted

    monkeypatch.setattr(sqlite_cache, "_scan_parent", scan)
    monkeypatch.setattr(sqlite_cache.coordinator, "accept_generation", accept)
    sqlite_cache._scan_disk_queue()
    assert captured == [True]
    assert sqlite_cache.index.accepted_generation() == 1
    assert sqlite_cache.index.search("old").total_matches == 0
    assert sqlite_cache.index.search("new/leaf").total_matches == 1
    assert sqlite_cache.index.search("stable").total_matches == 1
    assert sqlite_cache.index.search("").coverage == "complete"
    assert len(sqlite_cache.coordinator.pending) == 1
    assert sqlite_cache.coordinator.verification_required
    assert not sqlite_cache.coordinator._producers
    assert not sqlite_cache._scan_running.is_set()
    sqlite_cache._request_stop()
    sqlite_cache._finish_stop()
    assert all(not handle.connected for handle in smb_directory_server.handles)


@pytest.mark.parametrize("refusal", ["epoch", "old_producer", "uncertain", "pending", "producer", "observed_work", "scan_work"])
def test_backend_capture_refusal_preserves_selected_rows_and_freshness(sqlite_cache, refusal):
    from app.services.directory_cache import ScanObservationInvalidated

    sqlite_cache.index.write_paths(["accepted", "accepted/child"])
    assert sqlite_cache.index.finish_generation(1)
    generation, _selected = sqlite_cache.index.prepare_scan()
    sqlite_cache.index.seed_scan(generation)
    sqlite_cache.index.write_scan_children(generation, [("candidate", False)])
    sqlite_cache.index.finish_scan_parent(generation, "")
    before = sqlite_cache.index.search("accepted")
    baseline = sqlite_cache.coordinator.capture_epoch()
    producer = None
    try:
        if refusal == "epoch":
            _lose_observations(sqlite_cache.coordinator)
        elif refusal == "old_producer":
            producer = sqlite_cache.coordinator.begin_read("accepted")
            _lose_observations(sqlite_cache.coordinator)
            sqlite_cache.coordinator._uncertain_pending = False
            baseline = sqlite_cache.coordinator.capture_epoch()
        elif refusal == "uncertain":
            sqlite_cache.coordinator._uncertain_pending = True
        elif refusal == "pending":
            sqlite_cache.observe_parent("")
        elif refusal == "observed_work":
            sqlite_cache.index.queue_observed_parent("")
        elif refusal == "scan_work":
            sqlite_cache.index.write_scan_children(generation, [("pending", True)])
        if refusal == "producer":
            with sqlite_cache.coordinator.read("accepted"):
                with pytest.raises(ScanObservationInvalidated):
                    sqlite_cache.coordinator.accept_generation(baseline, generation)
        else:
            with pytest.raises(ScanObservationInvalidated):
                sqlite_cache.coordinator.accept_generation(baseline, generation)
    finally:
        if producer is not None:
            sqlite_cache.coordinator.end_read(producer)
    after = sqlite_cache.index.search("accepted")
    assert after.results == before.results
    assert after.last_verified_at_ms == before.last_verified_at_ms
    assert sqlite_cache.index.accepted_generation() is None
    assert sqlite_cache.coordinator.verification_required
    assert not sqlite_cache.coordinator._producers


def test_backend_source_catalogues_use_boundary_settings_not_runtime_or_credentials():
    from app.services.directory_cache import SQLiteConnectionDirectoryCache

    first = SQLiteConnectionDirectoryCache("fixture", "fixture", "share", "user", "password")
    second = SQLiteConnectionDirectoryCache("fixture", "fixture", "share", "user", "changed-password", source_revision="changed-time")
    try:
        assert first._persist_path.parent == second._persist_path.parent
        assert first._persist_path == second._persist_path
        assert first._source_identity == second._source_identity
        assert first._diagnostic_generation != second._diagnostic_generation
        assert "runtime_session" not in first._source_identity
        assert "revision" not in first._source_identity
        assert first._source_root._binding is None
        assert second._source_root._binding is None
        assert first.search_index("retained").directory_count == 0
        assert second.search_index("retained").directory_count == 0
    finally:
        first._request_stop()
        second._request_stop()
        first._finish_stop()
        second._finish_stop()


@pytest.mark.parametrize("name", ["bad/name", "bad\\name", "bad:name", "trailing.", "\ud800", "\udc00", "nul\x00name"])
def test_smb_unsupported_directory_names_preserve_readable_root_coverage(sqlite_cache, smb_directory_server, name):
    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    sqlite_cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    smb_directory_server.directories["base"] = [(name, 16), ("\ud800", 0), ("readable", 16)]
    smb_directory_server.directories["base\\readable"] = []
    sqlite_cache._scan_disk_queue()
    response = sqlite_cache.search_index("readable")
    assert response.total_matches == 1
    assert response.directory_count == 1
    assert response.coverage == "partial"
    assert response.issue_count == 1
    assert sqlite_cache._source_available.is_set()
    assert not sqlite_cache.coordinator.verification_required
    assert not sqlite_cache.coordinator._producers
    sqlite_cache._request_stop()
    sqlite_cache._finish_stop()


def test_smb_many_file_traversal_checks_control_before_directory_filtering(smb_directory_server):
    from app.services.directory_traversal import SmbDirectoryRoot

    smb_directory_server.directories["base"] = [(f"file-{position}", 0) for position in range(513)] + [("last-directory", 16)]
    checks = 0
    stop_at = None

    def check():
        nonlocal checks
        checks += 1
        if stop_at is not None and checks >= stop_at:
            raise InterruptedError("Injected many-file cancellation.")

    root = SmbDirectoryRoot(r"\\host\share\base")
    read = root.read("", check)
    try:
        stop_at = checks + 20
        with pytest.raises(InterruptedError):
            list(read)
    finally:
        read.close()
    try:
        stop_at = None
        read = root.read("", check)
        try:
            entries = list(read)
            assert len(entries) == 514
            assert entries[-1].name == "last-directory"
        finally:
            read.close()
    finally:
        root.close()


def test_smb_native_access_denial_continues_readable_siblings(sqlite_cache, smb_directory_server):
    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    sqlite_cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    smb_directory_server.directories["base"] = [("parent", 16), ("readable", 16)]
    smb_directory_server.directories["base\\readable"] = []
    smb_directory_server.denied.add("base\\parent")
    sqlite_cache._scan_disk_queue()
    response = sqlite_cache.search_index("readable")
    assert response.total_matches == 1
    assert response.directory_count == 2
    assert response.coverage == "partial"
    assert response.issue_count == 1
    assert response.last_verified_at_ms is not None
    sqlite_cache._request_stop()
    sqlite_cache._finish_stop()


@pytest.mark.parametrize("transport_failure", [False, True])
def test_smb_held_root_metadata_failure_blocks_search_and_retains_rows(sqlite_cache, smb_directory_server, transport_failure):
    from smbprotocol.exceptions import SMBException

    from app.services.directory_cache import DirectorySourceUnavailableError, SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    sqlite_cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    sqlite_cache.index.write_paths(["parent", "parent/old"])
    assert sqlite_cache.index.finish_generation(1)
    sqlite_cache._probe_source_root()
    before = sqlite_cache.index.search("parent")
    sqlite_cache.index.queue_reconciliation_parent(1, "parent")
    smb_directory_server.metadata_denied.add("base")
    if transport_failure:
        smb_directory_server.metadata_error = SMBException("Injected disconnected transport.")
    with pytest.raises(DirectorySourceUnavailableError):
        sqlite_cache._reconcile_disk_queue()
    assert sqlite_cache.index.search("parent") == before
    with pytest.raises(DirectorySourceUnavailableError):
        sqlite_cache.search_index("parent")
    sqlite_cache._request_stop()
    sqlite_cache._finish_stop()


def test_smb_root_handles_and_database_lease_remain_owned_through_blocked_worker(sqlite_cache, smb_directory_server):
    import concurrent.futures
    import threading

    from app.services.directory_cache import SQLiteConnectionDirectoryCache
    from app.services.directory_traversal import SmbDirectoryRoot

    sqlite_cache._source_root = SmbDirectoryRoot(r"\\host\share\base")
    sqlite_cache._open_source_read = SQLiteConnectionDirectoryCache._open_source_read.__get__(sqlite_cache)
    sqlite_cache.index.write_paths(["parent", "parent/old"])
    assert sqlite_cache.index.finish_generation(1)
    sqlite_cache.index.queue_reconciliation_parent(1, "parent")
    entered = threading.Event()
    release = threading.Event()

    def blocked_query():
        entered.set()
        assert release.wait(5)

    def worker():
        with sqlite_cache._workers:
            sqlite_cache._active_workers += 1
        try:
            sqlite_cache._reconcile_disk_queue()
        finally:
            with sqlite_cache._workers:
                sqlite_cache._active_workers -= 1
                sqlite_cache._workers.notify_all()

    smb_directory_server.on_query = blocked_query
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        future = executor.submit(worker)
        assert entered.wait(5)
        sqlite_cache._request_stop()
        stopped = executor.submit(sqlite_cache._finish_stop)
        try:
            assert not stopped.done()
            assert sqlite_cache._source_root._held_handles
            assert all(not handle.closed for handle in sqlite_cache._source_root._held_handles)
            assert sqlite_cache._opened.is_set()
            assert sqlite_cache._scan_running.is_set()
            assert not sqlite_cache._manager_scan_slots.acquire(blocking=False)
            assert sqlite_cache.coordinator._producers
        finally:
            release.set()
        with pytest.raises(InterruptedError):
            future.result(timeout=5)
        stopped.result(timeout=5)
    assert not sqlite_cache._source_root._held_handles
    assert not sqlite_cache._opened.is_set()
    assert not sqlite_cache.coordinator._producers
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    sqlite_cache._manager_scan_slots.release()


def test_root_read_failure_blocks_retained_results_but_descendant_failure_does_not(sqlite_cache, monkeypatch):
    from app.services.directory_cache import DirectorySourceUnavailableError

    sqlite_cache.index.write_paths(["accepted"])

    def missing(path, **kwargs):
        if path.endswith("\\descendant"):
            raise FileNotFoundError("Injected missing source descendant.")
        return (entry for entry in ())

    monkeypatch.setattr("smbclient.scandir", missing)
    with pytest.raises(FileNotFoundError):
        sqlite_cache._scan_parent(1, "descendant")
    assert sqlite_cache.search_index("accepted").total_matches == 1
    monkeypatch.setattr("smbclient.scandir", Mock(side_effect=FileNotFoundError("Injected missing source root.")))
    with pytest.raises(DirectorySourceUnavailableError, match="root is unavailable"):
        sqlite_cache._scan_parent(1, "")
    with pytest.raises(DirectorySourceUnavailableError, match="root is unavailable"):
        sqlite_cache.search_index("accepted")
    assert sqlite_cache.index.search("accepted").total_matches == 1


def test_unprobed_root_never_exposes_retained_rows_and_empty_probe_recovers(sqlite_cache, monkeypatch):
    sqlite_cache.index.write_paths(["accepted"])
    sqlite_cache._source_available.clear()
    sqlite_cache._source_probe_completed.clear()
    response = sqlite_cache.search_index("accepted")
    assert not response.results
    assert response.coverage == "partial"
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: (entry for entry in []))
    sqlite_cache._probe_source_root()
    assert sqlite_cache.search_index("accepted").total_matches == 1


def test_root_probe_does_not_start_when_scan_capacity_is_owned(sqlite_cache, monkeypatch):
    from app.services.directory_cache import DirectoryScanCapacityError

    def unexpected_read(*args, **kwargs):
        raise AssertionError("An unadmitted root probe must not access SMB.")

    monkeypatch.setattr("smbclient.scandir", unexpected_read)
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    try:
        with pytest.raises(DirectoryScanCapacityError, match="capacity is in use"):
            sqlite_cache._probe_source_root()
        assert sqlite_cache._source_available.is_set()
        assert not sqlite_cache._scan_running.is_set()
    finally:
        sqlite_cache._manager_scan_slots.release()


def test_invalidated_root_probe_cannot_restore_availability(sqlite_cache, monkeypatch):
    from app.services.directory_cache import ScanObservationInvalidated

    sqlite_cache._source_available.clear()

    def entries(*args, **kwargs):
        _lose_observations(sqlite_cache.coordinator)
        return
        yield

    monkeypatch.setattr("smbclient.scandir", entries)
    with pytest.raises(ScanObservationInvalidated, match="root observation became stale"):
        sqlite_cache._probe_source_root()
    assert not sqlite_cache._source_available.is_set()


@pytest.mark.parametrize(
    ("maximum_pending", "maximum_bytes", "drain_first"),
    [(1, 64, False), (4, 14, False), (1, 64, True), (4, 14, True)],
    ids=["queue-entries", "queue-bytes", "barrier-entries", "barrier-bytes"],
)
def test_blocked_root_read_retains_producer_and_permit_after_overflow(
    sqlite_cache, monkeypatch, maximum_pending, maximum_bytes, drain_first
):
    import threading

    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, ScanObservationInvalidated, _DirectoryMutation

    sqlite_cache.index.write_paths(["accepted"])
    assert sqlite_cache.index.finish_generation(1)
    verified = sqlite_cache.index.status().last_verified_at_ms
    candidate = sqlite_cache.index.prepare_scan()[0]
    sqlite_cache.index.write_paths(["candidate"], generation_id=candidate)
    before = sqlite_cache.index.search("accepted candidate stale")
    sqlite_cache.coordinator = DirectoryScanCoordinator(sqlite_cache.index, maximum_pending=maximum_pending, maximum_bytes=maximum_bytes)
    sqlite_cache._source_available.clear()
    entered = threading.Event()
    release = threading.Event()
    failures = []

    def entries(*args, **kwargs):
        entered.set()
        assert release.wait(timeout=5)
        return
        yield

    def probe():
        try:
            sqlite_cache._probe_source_root()
        except BaseException as error:
            failures.append(error)

    monkeypatch.setattr("smbclient.scandir", entries)
    worker = threading.Thread(target=probe)
    worker.start()
    try:
        assert entered.wait(timeout=5)
        coordinator = sqlite_cache.coordinator
        token = next(iter(coordinator._producers.values()))
        assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "accepted"))
        if drain_first:
            coordinator.apply_pending()
        assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "deleted")) == drain_first
        assert coordinator.epoch == (0 if drain_first else 1)
        assert list(coordinator.barriers) == ([(coordinator.sequence, "", 0)] if drain_first else [])
        assert coordinator.barrier_bytes == 0
        assert len(coordinator.pending) == 1
        assert coordinator.pending_bytes == len("deleted" if drain_first else "accepted")
        assert not coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "overflow"))
        assert coordinator.epoch == (1 if drain_first else 2)
        assert len(coordinator.pending) == 1
        assert coordinator.pending_bytes == len("deleted" if drain_first else "accepted")
        assert len(coordinator._producers) == 1
        assert coordinator.verification_required
        assert not sqlite_cache._manager_scan_slots.acquire(blocking=False)
        with pytest.raises(ScanObservationInvalidated):
            coordinator.commit_children(token, candidate, [("stale", False)])
        with pytest.raises(ScanObservationInvalidated):
            coordinator.finish_parent(token, candidate)
        with pytest.raises(ScanObservationInvalidated):
            coordinator.accept_generation(token.epoch, candidate)
        assert coordinator.apply_pending() == 1
        assert not coordinator.pending
        assert coordinator.pending_bytes == 0
        response = sqlite_cache.index.search("accepted candidate stale")
        assert response.total_matches == before.total_matches
        assert response.directory_count == before.directory_count
        assert response.results == before.results
        assert response.coverage == "uncertain"
        assert response.issue_count == 1
        assert response.last_verified_at_ms == verified
    finally:
        release.set()
        worker.join(timeout=5)
    assert not worker.is_alive()
    assert len(failures) == 1
    assert isinstance(failures[0], ScanObservationInvalidated)
    assert not sqlite_cache.coordinator._producers
    assert not sqlite_cache._source_available.is_set()
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    sqlite_cache._manager_scan_slots.release()


@pytest.mark.parametrize("stop", [False, True])
def test_blocked_root_close_retains_producer_and_permit_without_late_availability(sqlite_cache, monkeypatch, stop):
    from app.services.directory_cache import ScanObservationInvalidated

    sqlite_cache._source_available.clear()
    sqlite_cache.index.write_paths(["accepted"])
    entered = threading.Event()
    release = threading.Event()
    failures = []

    class Entries:
        def __next__(self):
            raise StopIteration

        def close(self):
            entered.set()
            assert release.wait(timeout=5)

    def probe():
        try:
            sqlite_cache._probe_source_root()
        except BaseException as error:
            failures.append(error)

    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: Entries())
    worker = threading.Thread(target=probe)
    worker.start()
    try:
        assert entered.wait(timeout=5)
        if stop:
            sqlite_cache._stop_event.set()
        else:
            _lose_observations(sqlite_cache.coordinator)
        assert len(sqlite_cache.coordinator._producers) == 1
        assert sqlite_cache._scan_running.is_set()
        assert not sqlite_cache._source_available.is_set()
        assert not sqlite_cache._manager_scan_slots.acquire(blocking=False)
        assert sqlite_cache.index.search("accepted").total_matches == 1
    finally:
        release.set()
        worker.join(timeout=5)
    assert not worker.is_alive()
    assert len(failures) == 1
    assert isinstance(failures[0], ScanObservationInvalidated)
    assert not sqlite_cache.coordinator._producers
    assert not sqlite_cache._scan_running.is_set()
    assert not sqlite_cache._source_available.is_set()
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    sqlite_cache._manager_scan_slots.release()


def test_root_loss_during_query_blocks_late_results(sqlite_cache, monkeypatch):
    from app.services.directory_cache import DirectorySourceUnavailableError

    sqlite_cache.index.write_paths(["accepted"])
    original = sqlite_cache.index.search

    def query(*args, **kwargs):
        response = original(*args, **kwargs)
        sqlite_cache._source_available.clear()
        return response

    monkeypatch.setattr(sqlite_cache.index, "search", query)
    with pytest.raises(DirectorySourceUnavailableError, match="root is unavailable"):
        sqlite_cache.search_index("accepted")


@pytest.mark.asyncio
@pytest.mark.parametrize("reconcile", [False, True])
async def test_pool_entry_failure_marks_root_unavailable_without_discarding_rows(sqlite_cache, monkeypatch, reconcile):
    from contextlib import asynccontextmanager

    sqlite_cache.index.write_paths(["accepted"])
    if reconcile:
        assert sqlite_cache.index.finish_generation(1)
        sqlite_cache.index.queue_reconciliation_parent(1, "")

    @asynccontextmanager
    async def unavailable(**kwargs):
        raise OSError("Injected unavailable SMB session.")
        yield

    async def pool():
        return SimpleNamespace(get_connection=unavailable, invalidate_connection_cache=AsyncMock())

    monkeypatch.setattr("app.services.directory_cache.get_connection_pool", pool)
    if reconcile:
        with pytest.raises(OSError, match="unavailable SMB session"):
            await sqlite_cache._run_reconciliation()
    else:
        await sqlite_cache._run_rescan()
    assert not sqlite_cache._source_available.is_set()
    assert sqlite_cache._source_probe_completed.is_set()
    if not reconcile:
        assert "root is unavailable" in sqlite_cache.scan_error
    assert sqlite_cache.index.search("accepted").total_matches == 1


@pytest.mark.asyncio
async def test_scan_admission_refusal_preserves_known_root_and_retries(sqlite_cache, monkeypatch):
    from contextlib import asynccontextmanager
    from time import monotonic

    @asynccontextmanager
    async def available(**kwargs):
        yield

    async def pool():
        return SimpleNamespace(get_connection=available)

    monkeypatch.setattr("app.services.directory_cache.get_connection_pool", pool)
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    before = monotonic()
    try:
        await sqlite_cache._run_rescan()
        assert sqlite_cache._source_available.is_set()
        assert "capacity is in use" in sqlite_cache.scan_error
        assert before < sqlite_cache._resource_retry_at <= monotonic() + sqlite_cache.policy.degraded_verification_seconds
    finally:
        sqlite_cache._manager_scan_slots.release()


@pytest.mark.asyncio
async def test_stale_rescan_preserves_root_and_uses_bounded_observation_retry(sqlite_cache, monkeypatch):
    from contextlib import asynccontextmanager

    from app.services.directory_cache import OBSERVATION_RETRY_SECONDS, ScanObservationInvalidated

    @asynccontextmanager
    async def connected(**kwargs):
        yield

    pool = SimpleNamespace(get_connection=connected, invalidate_connection_cache=AsyncMock())
    monkeypatch.setattr("app.services.directory_cache.get_connection_pool", AsyncMock(return_value=pool))
    monkeypatch.setattr(sqlite_cache, "_refresh_connection_generation", AsyncMock())
    probe = Mock(side_effect=ScanObservationInvalidated("Injected watcher startup."))
    monkeypatch.setattr(sqlite_cache, "_probe_source_root", probe)
    clock = SimpleNamespace(monotonic=lambda: 1000.0)
    monkeypatch.setattr("app.services.directory_cache.time", clock)

    await sqlite_cache._run_rescan()
    assert sqlite_cache._source_available.is_set()
    pool.invalidate_connection_cache.assert_not_awaited()
    assert sqlite_cache._failure_retry_delay == 0
    assert sqlite_cache._resource_retry_at == 0
    assert sqlite_cache._verification_retry_at == 1000.0 + OBSERVATION_RETRY_SECONDS
    assert not sqlite_cache._verification_due(1000.0, now=1000.0)
    assert sqlite_cache._verification_due(1000.0, now=sqlite_cache._verification_retry_at)
    await sqlite_cache._run_rescan()
    assert probe.call_count == 1


@pytest.mark.parametrize("partial", [False, True])
def test_watcher_startup_uncertainty_is_drained_before_initial_generation(sqlite_cache, monkeypatch, partial):
    from smbclient._os import FileAttributes

    def scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            yield SimpleNamespace(name="visible", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))
            if partial:
                yield SimpleNamespace(
                    name=None,
                    smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY),
                )

    monkeypatch.setattr("smbclient.scandir", scan)
    _lose_observations(sqlite_cache.coordinator)
    sqlite_cache._watcher_ready.set()
    sqlite_cache._scan_disk_queue()
    response = sqlite_cache.index.status()
    assert response.directory_count == 1
    assert sqlite_cache.index.search("visible").total_matches == 1
    assert response.coverage == ("partial" if partial else "complete")
    assert response.issue_count == int(partial)
    assert response.last_verified_at_ms is not None
    assert not sqlite_cache.coordinator.verification_required
    assert sqlite_cache.scan_error is None


@pytest.mark.parametrize("observed", ["empty", "rows", "queue", "issue"])
def test_startup_event_loss_only_restarts_unobserved_empty_generation(index, observed):
    index.mark_uncertain()
    if observed == "rows":
        index.write_paths(["retained"])
    elif observed == "queue":
        index.seed_scan(1)
    elif observed == "issue":
        index.record_access_denied(1)
    generation, selected = index.prepare_scan()
    assert selected
    response = index.status()
    assert response.last_verified_at_ms is None
    assert generation == 1
    assert response.coverage == "partial"
    assert response.issue_count == int(observed == "issue")


def test_partial_generation_is_reported_as_verified(sqlite_cache, monkeypatch):
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: (entry for entry in ()))
    finish = sqlite_cache.index.finish_generation

    def incomplete(generation, **kwargs):
        sqlite_cache.index.record_access_denied(generation)
        return finish(generation, **kwargs)

    monkeypatch.setattr(sqlite_cache.index, "finish_generation", incomplete)
    sqlite_cache._watcher_ready.set()
    sqlite_cache._scan_disk_queue()
    assert sqlite_cache.scan_error is None
    assert sqlite_cache.index.status().coverage == "partial"
    assert sqlite_cache.index.status().last_verified_at_ms is not None
    assert sqlite_cache.last_scan_time is not None
    assert not sqlite_cache.coordinator.verification_required


def test_sqlite_source_policy_applies_at_connection_boundaries(sqlite_cache):
    from app.models.system_settings import DirectoryIndexPolicy

    sqlite_cache.index.write_paths(["accepted"])
    before = sqlite_cache.search_index("accepted")
    policy = DirectoryIndexPolicy(page_cache_kib=1024, healthy_verification_seconds=600, degraded_verification_seconds=120)
    sqlite_cache.apply_policy(policy)
    assert sqlite_cache.policy == policy
    assert sqlite_cache.resources.policy == policy
    with closing(sqlite_cache.index._connect(readonly=True)) as connection:
        assert connection.execute("PRAGMA cache_size").fetchone() == (-1024,)
    assert sqlite_cache.search_index("accepted") == before


def test_failed_verification_backoff_is_due_before_the_full_pass_interval(sqlite_cache):
    from app.services.directory_cache import FAILURE_RETRY_JITTER_PERCENT

    sqlite_cache._retry_jitter = FAILURE_RETRY_JITTER_PERCENT
    now = 1000.0
    verified_at = now
    for seconds in (30, 60, 120, 240, 300, 300):
        sqlite_cache._schedule_retry(now=now)
        assert sqlite_cache._resource_retry_at == now + seconds
        assert not sqlite_cache._verification_due(verified_at, now=now + seconds - 0.001)
        assert sqlite_cache._verification_due(verified_at, now=now + seconds)
        now += seconds
        verified_at = now
    sqlite_cache._reset_retry()
    assert not sqlite_cache._verification_due(verified_at, now=now)
    sqlite_cache._schedule_retry(now=now)
    assert sqlite_cache._failure_retry_delay == 30


@pytest.mark.parametrize("degraded", [False, True])
def test_periodic_verification_jitter_preserves_deadlines_and_retry_priority(sqlite_cache, degraded):
    from app.services.directory_cache import PERIODIC_VERIFICATION_JITTER_PERCENT

    sqlite_cache.coordinator.verification_required = degraded
    sqlite_cache._watcher_ready.set()
    interval = sqlite_cache.policy.degraded_verification_seconds if degraded else sqlite_cache.policy.healthy_verification_seconds
    verified_at = 1000.0
    deadlines = set()
    for jitter in range(256):
        sqlite_cache._retry_jitter = jitter
        delay = interval * (100 - jitter % (PERIODIC_VERIFICATION_JITTER_PERCENT + 1)) / 100
        deadline = verified_at + delay
        deadlines.add(deadline)
        assert not sqlite_cache._verification_due(verified_at, now=deadline - 0.001)
        assert sqlite_cache._verification_due(verified_at, now=deadline)
        assert verified_at + interval * 0.9 <= deadline <= verified_at + interval
        sqlite_cache._resource_retry_at = deadline + 30
        assert not sqlite_cache._verification_due(verified_at, now=deadline)
        assert sqlite_cache._verification_due(verified_at, now=deadline + 30)
        sqlite_cache._resource_retry_at = 0
    assert len(deadlines) > 1
    sqlite_cache._retry_jitter = 0
    sqlite_cache._schedule_retry(now=verified_at)
    assert sqlite_cache._verification_due(verified_at, now=sqlite_cache._resource_retry_at)


def test_retry_jitter_stays_bounded_and_spreads_backend_sources(sqlite_cache):
    from app.services.directory_cache import FAILURE_RETRY_MAX_SECONDS, FAILURE_RETRY_MIN_SECONDS

    delays = set()
    for jitter in range(256):
        sqlite_cache._retry_jitter = jitter
        sqlite_cache._reset_retry()
        sqlite_cache._schedule_retry(now=1000.0)
        delay = sqlite_cache._resource_retry_at - 1000.0
        assert FAILURE_RETRY_MIN_SECONDS <= delay <= FAILURE_RETRY_MAX_SECONDS
        delays.add(delay)
        sqlite_cache._failure_retry_delay = FAILURE_RETRY_MAX_SECONDS
        sqlite_cache._schedule_retry(now=1000.0)
        assert FAILURE_RETRY_MIN_SECONDS <= sqlite_cache._resource_retry_at - 1000.0 <= FAILURE_RETRY_MAX_SECONDS
    assert len(delays) > 1


def test_unchanged_policy_preserves_backoff_and_changed_policy_retries(sqlite_cache):
    from app.models.system_settings import DirectoryIndexPolicy

    sqlite_cache._schedule_retry(now=1000.0)
    deadline = sqlite_cache._resource_retry_at
    sqlite_cache.apply_policy(sqlite_cache.policy)
    assert sqlite_cache._resource_retry_at == deadline
    assert sqlite_cache._failure_retry_delay > 0
    sqlite_cache.apply_policy(DirectoryIndexPolicy(page_cache_kib=1024))
    assert sqlite_cache._failure_retry_delay == 0
    assert sqlite_cache._resource_retry_at == 0


@pytest.mark.asyncio
async def test_failed_root_retries_back_off_and_success_resets_delay(sqlite_cache, monkeypatch):
    from contextlib import asynccontextmanager
    from time import time

    unavailable = True
    now = [1000.0]
    attempts = []
    monkeypatch.setattr("app.services.directory_cache.time", SimpleNamespace(monotonic=lambda: now[0], time=time))

    @asynccontextmanager
    async def connection(**kwargs):
        attempts.append(now[0])
        if unavailable:
            raise OSError("Injected missing root")
        yield

    async def pool():
        return SimpleNamespace(get_connection=connection, invalidate_connection_cache=AsyncMock())

    monkeypatch.setattr("app.services.directory_cache.get_connection_pool", pool)
    await sqlite_cache._run_rescan()
    assert sqlite_cache._failure_retry_delay == 30
    deadline = sqlite_cache._resource_retry_at
    for _ in range(3):
        await sqlite_cache._run_rescan()
        assert sqlite_cache._resource_retry_at == deadline
        assert sqlite_cache._failure_retry_delay == 30
        assert attempts == [1000.0]
    now[0] = deadline
    await sqlite_cache._run_rescan()
    assert sqlite_cache._failure_retry_delay == 60
    assert len(attempts) == 2
    unavailable = False
    now[0] = sqlite_cache._resource_retry_at
    monkeypatch.setattr(sqlite_cache, "_probe_source_root", lambda: None)
    monkeypatch.setattr(sqlite_cache, "_scan_disk_queue", lambda: None)
    await sqlite_cache._run_rescan()
    assert sqlite_cache._failure_retry_delay == 0
    assert sqlite_cache._resource_retry_at == 0


def test_root_unavailable_api_returns_specific_service_error(sqlite_cache, monkeypatch, client, auth_headers_user, test_connection):
    sqlite_cache.index.write_paths(["accepted"])
    sqlite_cache._source_available.clear()

    async def get_source(**kwargs):
        return sqlite_cache

    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: SimpleNamespace(get_or_create_cache=get_source))
    response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": "accepted"})
    assert response.status_code == 503
    assert "root is unavailable" in response.json()["detail"]["message"]
    assert response.json()["detail"]["recoverable"] is True
    assert "Restore source access" in response.json()["detail"]["message"]


def test_sqlite_source_warm_search_does_not_traverse(sqlite_cache, monkeypatch):
    def unexpected_scan(*args, **kwargs):
        raise AssertionError("A warm directory query must not scan the source.")

    monkeypatch.setattr("smbclient.scandir", unexpected_scan)
    sqlite_cache.index.write_paths(["alpha/beta", "beta", "neither"])
    assert sqlite_cache.search("alpha beta") == (["alpha/beta", "beta"], 2)
    assert not hasattr(sqlite_cache, "_directories")


def test_sqlite_api_uses_one_read_view_off_the_event_loop(sqlite_cache, monkeypatch, client, auth_headers_user, test_connection):
    event_loop_threads = []
    query_threads = []
    original_search = sqlite_cache.search_index

    async def get_source(**kwargs):
        event_loop_threads.append(threading.get_ident())
        return sqlite_cache

    def query(*args, **kwargs):
        query_threads.append(threading.get_ident())
        return original_search(*args, **kwargs)

    sqlite_cache.index.write_paths(["alpha/beta", "beta", "neither"])
    monkeypatch.setattr(sqlite_cache, "search_index", query)
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: SimpleNamespace(get_or_create_cache=get_source))
    response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": "alpha beta"})
    assert response.status_code == 200
    body = response.json()
    assert body["results"] == ["alpha/beta", "beta"]
    assert body["matched_term_counts"] == {"alpha/beta": 2, "beta": 1}
    assert body["match_ranks"] == {"alpha/beta": 0, "beta": 0}
    assert body["total_matches"] == 2
    assert body["directory_count"] == 3
    assert body["accepted_revision"] == sqlite_cache.index.status().accepted_revision
    assert body["coverage"] == "partial"
    assert event_loop_threads[0] != query_threads[0]


def test_sqlite_api_empty_query_returns_coverage_without_matches(sqlite_cache, monkeypatch, client, auth_headers_user, test_connection):
    async def get_source(**kwargs):
        return sqlite_cache

    sqlite_cache.index.write_paths(["alpha"])
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: SimpleNamespace(get_or_create_cache=get_source))
    response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": ""})
    assert response.status_code == 200
    assert response.json()["results"] == []
    assert response.json()["directory_count"] == 1
    assert response.json()["coverage"] == "partial"


@pytest.mark.parametrize("include_details", [False, True])
def test_directory_api_returns_issue_details_only_on_request(
    sqlite_cache, monkeypatch, client, auth_headers_user, test_connection, include_details
):
    async def get_source(**kwargs):
        return sqlite_cache

    sqlite_cache.index.seed_scan(1)
    sqlite_cache.coordinator.start_scan_groups()
    token = sqlite_cache.coordinator.begin_read("")
    sqlite_cache.coordinator.record_issue(token, 1, "unsupported_encoding")
    sqlite_cache.coordinator.finish_parent(token, 1)
    sqlite_cache.coordinator.flush_scan_group()
    assert sqlite_cache.index.finish_generation(1)
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: SimpleNamespace(get_or_create_cache=get_source))
    response = client.get(
        f"/api/browse/{test_connection.id}/directories",
        headers=auth_headers_user,
        params={"q": "", "include_issue_details": str(include_details).lower()},
    )
    assert response.status_code == 200
    assert response.json()["issue_details_available"] is True
    assert response.json()["issue_details"] == (
        [{"path": "/", "code": "unsupported_encoding", "scope": "contents"}] if include_details else None
    )
    assert response.json()["issue_details_incomplete"] is False


def test_directory_api_rejects_excess_terms_before_source_creation(monkeypatch, client, auth_headers_user, test_connection):
    def unexpected_manager():
        raise AssertionError("Invalid queries must not initialize a directory source.")

    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", unexpected_manager)
    response = client.get(
        f"/api/browse/{test_connection.id}/directories",
        headers=auth_headers_user,
        params={"q": " ".join(f"term{number}" for number in range(MAX_QUERY_TERMS + 1))},
    )
    assert response.status_code == 400
    assert "distinct terms" in response.json()["detail"]


@pytest.mark.parametrize("boundary", ["next", "close"])
@pytest.mark.parametrize("stop", [False, True])
@pytest.mark.parametrize("has_child", [False, True])
def test_root_scan_rejects_late_availability_and_parent_completion(sqlite_cache, monkeypatch, boundary, stop, has_child):
    from smbclient._os import FileAttributes

    from app.services.directory_cache import ScanObservationInvalidated

    sqlite_cache.index.write_paths(["accepted"])
    assert sqlite_cache.index.finish_generation(1)
    before = sqlite_cache.index.search("accepted")
    sqlite_cache._source_available.clear()
    sqlite_cache._source_probe_completed.clear()
    completed = []
    closed = []

    def interrupt():
        if stop:
            sqlite_cache._stop_event.set()
        else:
            _lose_observations(sqlite_cache.coordinator)

    class Entries:
        def __init__(self):
            self.returned_child = False

        def __next__(self):
            if boundary == "next":
                interrupt()
            if has_child and not self.returned_child:
                self.returned_child = True
                return SimpleNamespace(name="candidate", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))
            raise StopIteration

        def close(self):
            closed.append(True)
            if boundary == "close":
                interrupt()

    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: Entries())
    monkeypatch.setattr(sqlite_cache.index, "finish_scan_parent", lambda *args: completed.append(args))
    with pytest.raises((InterruptedError, ScanObservationInvalidated)):
        sqlite_cache._scan_disk_queue()
    assert closed == [True]
    assert not completed
    assert not sqlite_cache._source_available.is_set()
    assert not sqlite_cache._source_probe_completed.is_set()
    after = sqlite_cache.index.search("accepted")
    assert after.results == before.results
    assert after.last_verified_at_ms == before.last_verified_at_ms
    assert sqlite_cache.coordinator.verification_required
    assert not sqlite_cache.coordinator._producers
    assert not sqlite_cache._scan_running.is_set()
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    sqlite_cache._manager_scan_slots.release()


def test_sqlite_source_initial_batches_are_visible_after_commit_deadline(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    from app.services.directory_index import SCAN_COMMIT_INTERVAL_SECONDS

    observed = []
    observed_progress = []

    def scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            for number in range(257):
                if number == 255:
                    sqlite_cache.coordinator._scan_group_started -= SCAN_COMMIT_INTERVAL_SECONDS
                if number == 256:
                    observed.append(sqlite_cache.search_index("directory").total_matches)
                    observed_progress.append(sqlite_cache.scan_progress.directories_found)
                yield SimpleNamespace(
                    name=f"directory{number}", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
                )

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._scan_disk_queue()
    assert observed == [256]
    assert observed_progress == [256]
    response = sqlite_cache.search_index("directory")
    assert response.directory_count == response.total_matches == 257
    assert response.coverage == "complete"
    assert not hasattr(sqlite_cache, "_directories")


def test_sqlite_source_excludes_reparse_directories_without_coverage_issues(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    def scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            for name in ("redirected", "unknown-placeholder"):
                yield SimpleNamespace(
                    name=name,
                    smb_info=SimpleNamespace(
                        file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY | FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT
                    ),
                )
            yield SimpleNamespace(name="regular", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))
        elif path != sqlite_cache._smb_base_path + "\\regular":
            raise AssertionError("Excluded reparse directories must not be read.")

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._scan_disk_queue()
    response = sqlite_cache.search_index("regular redirected placeholder")
    assert response.total_matches == response.directory_count == 1
    assert response.coverage == "complete"
    assert response.issue_count == 0
    assert sqlite_cache.directory_issue_details() == ([], False)
    assert response.last_verified_at_ms is not None
    assert not sqlite_cache.coordinator.verification_required

    def recovered_scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            yield SimpleNamespace(name="regular", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    monkeypatch.setattr("smbclient.scandir", recovered_scan)
    sqlite_cache._scan_disk_queue()
    recovered = sqlite_cache.search_index("regular redirected placeholder")
    assert recovered.total_matches == recovered.directory_count == 1
    assert recovered.issue_count == 0
    assert recovered.coverage == "complete"
    assert recovered.last_verified_at_ms is not None
    assert not sqlite_cache.coordinator.verification_required


def test_sqlite_source_reparse_candidate_clears_previous_coverage_issues(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    sqlite_cache.index.write_paths(["accepted"])
    sqlite_cache.index.record_unsafe_traversal(1)
    sqlite_cache.coordinator._publish_issue_details("", {"unsafe_traversal": 1})
    assert sqlite_cache.index.finish_generation(1)
    assert sqlite_cache.index.status().coverage == "partial"

    def scan(path, **kwargs):
        yield SimpleNamespace(
            name="redirected",
            smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY | FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT),
        )

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._scan_disk_queue()
    assert sqlite_cache.index.search("accepted").total_matches == 0
    assert sqlite_cache.index.status().coverage == "complete"
    assert sqlite_cache.index.status().issue_count == 0
    assert sqlite_cache.directory_issue_details() == ([], False)
    assert not sqlite_cache.coordinator.verification_required


@pytest.mark.parametrize("denied_at_open", [False, True])
@pytest.mark.parametrize("smb_denial", [False, True])
def test_sqlite_source_denied_descendant_preserves_readable_siblings(sqlite_cache, monkeypatch, denied_at_open, smb_denial):
    from smbclient._os import FileAttributes
    from smbprotocol.exceptions import SMBOSError
    from smbprotocol.header import NtStatus

    reads = []

    def deny():
        if smb_denial:
            raise SMBOSError(NtStatus.STATUS_ACCESS_DENIED, "fixture")
        raise PermissionError("Injected source denial.")

    def entries(path):
        if path == sqlite_cache._smb_base_path:
            for name in ("denied", "readable"):
                yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))
        elif path.endswith("\\denied"):
            deny()
        elif path.endswith("\\readable"):
            yield SimpleNamespace(name="child", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    def scan(path, **kwargs):
        reads.append(path)
        if denied_at_open and path.endswith("\\denied"):
            deny()
        return entries(path)

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._scan_disk_queue()
    response = sqlite_cache.search_index("denied readable")
    assert response.directory_count == response.total_matches == 3
    assert response.coverage == "partial"
    assert response.issue_count == 1
    assert response.last_verified_at_ms is not None
    assert not sqlite_cache.coordinator.verification_required
    assert sqlite_cache.index.pending_scan_paths(1) == []
    assert sqlite_cache._smb_base_path + "\\readable\\child" in reads
    assert sqlite_cache.index._connection().execute("SELECT code, count FROM coverage_issues").fetchall() == [("access_denied", 1)]
    assert sqlite_cache.directory_issue_details() == ([{"path": "denied", "code": "access_denied", "scope": "directory"}], False)

    def empty_scan(*_args, **_kwargs):
        yield from ()

    monkeypatch.setattr("smbclient.scandir", empty_scan)
    sqlite_cache._scan_disk_queue()
    assert sqlite_cache.directory_issue_details() == ([], False)


@pytest.mark.parametrize("failure", ["separator", "surrogate", "oversized", "folder_io", "denied"])
def test_best_effort_pass_accepts_item_failures(sqlite_cache, monkeypatch, failure):
    from smbclient._os import FileAttributes

    from app.services.directory_cache import MAX_OBSERVATION_BYTES

    invalid_name = {"separator": "bad/name", "surrogate": "bad\ud800", "oversized": "x" * (MAX_OBSERVATION_BYTES + 1)}

    def scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            names = [invalid_name[failure], "readable"] if failure in invalid_name else ["failed", "readable"]
            for name in names:
                yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))
        elif path.endswith("\\failed"):
            if failure == "denied":
                raise PermissionError("Injected folder denial.")
            raise OSError("Injected unclassified folder read failure.")
        elif path.endswith("\\readable"):
            yield SimpleNamespace(name="child", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._watcher_ready.set()
    sqlite_cache._scan_disk_queue()
    response = sqlite_cache.search_index("readable")
    assert response.total_matches == 2
    assert response.coverage == "partial"
    assert response.issue_count == 1
    assert response.last_verified_at_ms is not None
    assert not sqlite_cache.coordinator.verification_required
    assert sqlite_cache.scan_error is None
    assert sqlite_cache.monitoring_state == "healthy"
    assert not sqlite_cache._verification_due(0, now=sqlite_cache.policy.degraded_verification_seconds + 1)
    assert sqlite_cache._verification_due(0, now=sqlite_cache.policy.healthy_verification_seconds)
    assert not sqlite_cache.index.pending_scan_paths(1)


def test_denied_reconciliation_completes(sqlite_cache, monkeypatch):
    sqlite_cache.index.write_paths(["denied", "denied/retained"])
    assert sqlite_cache.index.finish_generation(1)
    sqlite_cache.index.queue_observed_parent("denied")

    def scan(path, **kwargs):
        raise PermissionError("Injected reconciliation denial.")

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._scan_parent(1, "denied", reconcile=True)
    assert sqlite_cache.index.reconciliation_generation() is None
    assert sqlite_cache.index.status().coverage == "partial"
    assert sqlite_cache.index.search("retained").total_matches == 1


def test_late_folder_failure_discards_its_candidate_subtree(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    from app.services.directory_index import ROW_BATCH_SIZE

    def scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            for name in ("failed", "readable"):
                yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))
        elif path.endswith("\\failed"):
            for number in range(ROW_BATCH_SIZE + 1):
                yield SimpleNamespace(
                    name=f"child-{number}", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
                )
            raise OSError("Injected late folder failure.")

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._scan_disk_queue()
    assert sqlite_cache.index.search("child").total_matches == 0
    assert sqlite_cache.index.status().directory_count == 2
    assert sqlite_cache.index.status().coverage == "partial"
    assert sqlite_cache.index.status().issue_count == 1


def test_sqlite_source_denied_candidate_preserves_accepted_rows_and_recovers(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    sqlite_cache.index.write_paths(["accepted", "denied/retained"])
    assert sqlite_cache.index.finish_generation(1)
    denied = True

    def scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            for name in ("denied", "readable"):
                yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))
        elif path.endswith("\\denied") and denied:
            raise PermissionError("Injected source denial.")

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._scan_disk_queue()
    response = sqlite_cache.index.search("denied readable")
    assert response.total_matches == 3
    assert response.coverage == "partial"
    assert sqlite_cache.index.search("retained").total_matches == 1
    assert not sqlite_cache.coordinator.verification_required
    denied = False
    sqlite_cache._scan_disk_queue()
    response = sqlite_cache.search_index("accepted denied readable")
    assert response.directory_count == response.total_matches == 2
    assert response.coverage == "complete"
    assert response.issue_count == 0
    assert response.last_verified_at_ms is not None
    assert not sqlite_cache.coordinator.verification_required


@pytest.mark.parametrize("parent", ["", "parent"])
def test_stale_source_call_preserves_source_availability(sqlite_cache, parent):
    from app.services.directory_cache import ScanObservationInvalidated

    original = ScanObservationInvalidated("Injected stale source observation.")

    def stale():
        raise original

    with pytest.raises(ScanObservationInvalidated) as caught:
        sqlite_cache._source_call(parent, stale)
    assert caught.value is original
    assert sqlite_cache._source_available.is_set()
    assert sqlite_cache._source_probe_completed.is_set()
    assert not sqlite_cache._root_reading.is_set()


def test_sqlite_source_root_permission_denial_blocks_results(sqlite_cache, monkeypatch):
    from app.services.directory_cache import DirectorySourceUnavailableError

    sqlite_cache.index.write_paths(["accepted"])

    def denied(*args, **kwargs):
        raise PermissionError("Injected root denial.")

    monkeypatch.setattr("smbclient.scandir", denied)
    with pytest.raises(DirectorySourceUnavailableError):
        sqlite_cache._scan_disk_queue()
    with pytest.raises(DirectorySourceUnavailableError):
        sqlite_cache.search_index("accepted")
    assert sqlite_cache.index.search("accepted").total_matches == 1


def test_sqlite_source_storage_permission_denial_is_not_a_source_issue(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    def scan(path, **kwargs):
        yield SimpleNamespace(name="child", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    def denied(*args, **kwargs):
        raise PermissionError("Injected local storage denial.")

    monkeypatch.setattr("smbclient.scandir", scan)
    monkeypatch.setattr(sqlite_cache.index, "write_scan_children", denied)
    with pytest.raises(PermissionError, match="local storage denial"):
        sqlite_cache._scan_parent(1, "parent")
    assert sqlite_cache.index._connection().execute("SELECT count(*) FROM coverage_issues").fetchone()[0] == 0
    assert sqlite_cache._source_available.is_set()


@pytest.mark.parametrize("failure", ["storage", "stale", "cancelled", "task_cancelled"])
@pytest.mark.parametrize("parent", ["", "parent"])
def test_sqlite_source_close_denial_preserves_primary_failure(sqlite_cache, monkeypatch, failure, parent):
    from smbclient._os import FileAttributes

    from app.services.directory_cache import ScanObservationInvalidated

    errors = {
        "storage": PermissionError("Injected local storage denial."),
        "stale": ScanObservationInvalidated("Injected stale read."),
        "cancelled": InterruptedError("Injected cancelled read."),
        "task_cancelled": asyncio.CancelledError("Injected task cancellation."),
    }
    original = errors[failure]
    closed = []
    warnings = []

    def warning(message, *args):
        warnings.append(message % args)

    monkeypatch.setattr("app.services.directory_cache.logger.warning", warning)

    class Entries:
        def __init__(self):
            self.items = iter(
                [SimpleNamespace(name="child", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))]
            )

        def __next__(self):
            return next(self.items)

        def close(self):
            closed.append(True)
            raise PermissionError("Injected close denial with private source path.")

    def reject_batch(*args, **kwargs):
        raise original

    sqlite_cache.index.seed_scan(1)
    if parent:
        sqlite_cache.index.write_scan_children(1, [(parent, True)])
        sqlite_cache.index.finish_scan_parent(1, "")
    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: Entries())
    monkeypatch.setattr(sqlite_cache.coordinator, "commit_children", reject_batch)
    with pytest.raises(type(original)) as caught:
        sqlite_cache._scan_parent(1, parent)
    assert caught.value is original
    assert closed == [True]
    assert sqlite_cache.index.pending_scan_paths(1) == [parent]
    assert sqlite_cache.index._connection().execute("SELECT count(*) FROM coverage_issues").fetchone()[0] == 0
    assert len(warnings) == 1
    assert "Directory source read cleanup failed" in warnings[0]
    assert "private source path" not in warnings[0]


def test_sqlite_source_close_failure_completes_parent_with_issue(sqlite_cache, monkeypatch):
    sqlite_cache.index.seed_scan(1)
    sqlite_cache.index.write_scan_children(1, [("parent", True)])
    sqlite_cache.index.finish_scan_parent(1, "")
    closed = []

    class Entries:
        def __next__(self):
            raise StopIteration

        def close(self):
            closed.append(True)
            raise OSError("Injected close failure.")

    monkeypatch.setattr("smbclient.scandir", lambda *args, **kwargs: Entries())
    sqlite_cache._scan_parent(1, "parent")
    assert closed == [True]
    assert sqlite_cache.index.pending_scan_paths(1) == []
    assert sqlite_cache.index.status().issue_count == 1


def test_sqlite_source_late_permission_denial_cannot_finish_stale_parent(sqlite_cache, monkeypatch):
    from app.services.directory_cache import ScanObservationInvalidated

    sqlite_cache.index.seed_scan(1)
    sqlite_cache.index.write_scan_children(1, [("parent", True)])
    sqlite_cache.index.finish_scan_parent(1, "")

    def denied(*args, **kwargs):
        _lose_observations(sqlite_cache.coordinator)
        raise PermissionError("Injected late denial.")

    monkeypatch.setattr("smbclient.scandir", denied)
    with pytest.raises(ScanObservationInvalidated):
        sqlite_cache._scan_parent(1, "parent")
    assert sqlite_cache.index.pending_scan_paths(1) == ["parent"]
    assert sqlite_cache.index._connection().execute("SELECT count(*) FROM coverage_issues").fetchone()[0] == 0


def test_sqlite_source_rejects_late_parent_observations(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    from app.services.directory_cache import ScanObservationInvalidated

    def scan(path, **kwargs):
        yield SimpleNamespace(name="alpha", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))
        sqlite_cache.remove_directory("alpha")

    monkeypatch.setattr("smbclient.scandir", scan)
    with pytest.raises(ScanObservationInvalidated):
        sqlite_cache._scan_disk_queue()
    assert sqlite_cache.search_index("alpha").total_matches == 0
    assert sqlite_cache.coordinator.verification_required


def test_sqlite_source_interrupted_initial_build_keeps_completed_parents(sqlite_cache, monkeypatch):
    sqlite_cache.index.seed_scan(1)
    sqlite_cache.index.write_scan_children(1, [("stale", False)])
    sqlite_cache.index.finish_scan_parent(1, "")

    def empty_scan(path, **kwargs):
        assert sqlite_cache.search_index("stale").total_matches == 1
        yield from ()

    monkeypatch.setattr("smbclient.scandir", empty_scan)
    sqlite_cache._scan_disk_queue()
    assert sqlite_cache.search_index("stale").total_matches == 1
    assert sqlite_cache.search_index("").coverage == "complete"


@pytest.mark.asyncio
async def test_sqlite_source_cancellation_retains_smb_pool_future(sqlite_cache):
    from unittest.mock import AsyncMock

    started = threading.Event()
    release = threading.Event()
    pool = SimpleNamespace(retain_connection_until_future_complete=AsyncMock())

    def blocked():
        started.set()
        assert release.wait(timeout=5)

    task = asyncio.create_task(sqlite_cache._blocking(blocked, pool=pool))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        pool.retain_connection_until_future_complete.assert_awaited_once()
        connection_cache, future = pool.retain_connection_until_future_complete.call_args.args
        assert connection_cache is sqlite_cache._connection_cache
        assert not future.done()
        release.set()
        await asyncio.wait_for(asyncio.shield(future), timeout=5)
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_sqlite_source_stalled_read_retains_worker_and_pool_ownership(sqlite_cache, monkeypatch):
    from unittest.mock import AsyncMock

    release = threading.Event()
    started = threading.Event()
    pool = SimpleNamespace(retain_connection_until_future_complete=AsyncMock(), invalidate_connection_cache=AsyncMock())

    def blocked():
        started.set()
        assert release.wait(timeout=5)

    monkeypatch.setattr("app.services.directory_cache.SCAN_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr("app.services.directory_cache.WORKER_POLL_SECONDS", 0.005)
    try:
        with pytest.raises(TimeoutError, match="capacity stays reserved"):
            await sqlite_cache._blocking(blocked, pool=pool)
        assert started.is_set()
        assert sqlite_cache._active_workers == 1
        pool.retain_connection_until_future_complete.assert_awaited_once()
        pool.invalidate_connection_cache.assert_not_awaited()
        future = pool.retain_connection_until_future_complete.call_args.args[1]
        assert not future.done()
        assert sqlite_cache.coordinator.verification_required
        release.set()
        await asyncio.wait_for(asyncio.shield(future), timeout=5)
        assert sqlite_cache._active_workers == 0
    finally:
        release.set()


@pytest.mark.asyncio
async def test_sqlite_source_cancelled_worker_keeps_process_lease(sqlite_cache):
    started = threading.Event()
    release = threading.Event()

    def blocked():
        started.set()
        assert release.wait(timeout=5)

    task = asyncio.create_task(sqlite_cache._blocking(blocked))
    closing = None
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        sqlite_cache._request_stop()
        closing = asyncio.create_task(asyncio.to_thread(sqlite_cache._finish_stop))
        contender = DirectoryIndex(sqlite_cache.index.path, source_kind=sqlite_cache.index.source_kind, source_identity={})
        with pytest.raises(BlockingIOError):
            contender.open()
        assert not closing.done()
    finally:
        release.set()
        if closing is not None:
            await asyncio.wait_for(closing, timeout=5)
        else:
            await asyncio.gather(task, return_exceptions=True)


APPLICATION_ID = 1396853073
SCHEMA_VERSION = json.loads((CONTRACT_ROOT / "contract.json").read_text(encoding="utf-8"))["limits"]["schema_version"]


def test_generated_unicode_contract_matches_backend() -> None:
    contract = json.loads((CONTRACT_ROOT / "unicode.json").read_text(encoding="utf-8"))
    assert contract["unicode_version"] == unicodedata.unidata_version
    for character, normalized in contract["normalization"]:
        assert normalize_search_text(character) == normalized
    assert contract["whitespace"] == [chr(codepoint) for codepoint in range(0x110000) if chr(codepoint).isspace()]


def test_query_admission_is_bounded(index):
    from app.services.directory_index import QUERY_WORKERS

    for _ in range(QUERY_WORKERS):
        assert index._query_slots.acquire(blocking=False)
    try:
        with pytest.raises(TimeoutError, match="workers are busy"):
            index.search("alpha")
    finally:
        for _ in range(QUERY_WORKERS):
            index._query_slots.release()
    assert index.search("alpha").total_matches == 0


@pytest.mark.parametrize("suffix", ["", "-wal", "-shm", "-journal", ".lease"])
def test_rejects_linked_storage_files_before_sqlite_io(tmp_path, monkeypatch, suffix):
    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    path = directory / "source.sqlite3"
    target = tmp_path / "outside"
    target.write_bytes(b"unchanged")
    Path(str(path) + suffix).symlink_to(target)
    store = DirectoryIndex(path, source_kind="local", source_identity={"root": "fixture"})
    monkeypatch.setattr(store, "_connect", lambda **_kwargs: pytest.fail("SQLite I/O must not begin"))
    with pytest.raises(PermissionError, match="regular files"):
        store.open()
    assert target.read_bytes() == b"unchanged"
    assert store._lease_fd is None


def test_new_database_and_lease_are_private(index):
    import os
    import stat

    if os.name == "posix":
        assert stat.S_IMODE(index.path.stat().st_mode) == 0o600
        assert stat.S_IMODE(Path(str(index.path) + ".lease").stat().st_mode) == 0o600


def test_accepted_parent_reconciliation_queues_only_new_subtrees(index):
    index.write_paths(["parent", "parent/existing"])
    assert index.finish_generation(1)
    before = index.search("parent")
    with pytest.raises(ValueError):
        index.write_scan_children(1, [("parent/unowned", False)])
    with pytest.raises(ValueError):
        index.write_reconciliation_children(1, "parent", [("parent/unowned", False)])
    index.queue_reconciliation_parent(1, "parent")
    assert index.search("parent") == before
    index.close()
    index.open()
    assert index.pending_scan_paths(1) == ["parent"]
    index.write_reconciliation_children(1, "parent", [("parent/existing", True), ("parent/new", True)])
    after = index.search("parent")
    assert after.directory_count == 3
    assert after.accepted_revision == before.accepted_revision + 1
    assert after.last_verified_at_ms == before.last_verified_at_ms
    assert index.pending_scan_paths(1) == ["parent", "parent/new"]
    index.write_reconciliation_children(1, "parent", [("parent/existing", True), ("parent/new", True)])
    assert index.search("parent") == after
    index.write_reconciliation_children(1, "parent/new", [("parent/new/child", False)])
    index.finish_reconciliation_parent(1, "parent/new")
    index.finish_reconciliation_parent(1, "parent")
    index.queue_reconciliation_parent(1, "parent")
    before_repeat = index.search("parent")
    index.write_reconciliation_children(1, "parent", [("parent/new", True)])
    assert index.pending_scan_paths(1) == ["parent"]
    assert index.search("parent") == before_repeat
    assert before_repeat.directory_count == 4
    assert before_repeat.last_verified_at_ms == before.last_verified_at_ms


def test_accepted_parent_reconciliation_rejects_stale_and_unrelated_work(index):
    from app.services.directory_index import MAX_SIGNED_INTEGER, ROW_BATCH_SIZE

    assert index.accepted_generation() is None
    with pytest.raises(ValueError):
        index.queue_reconciliation_parent(1, "")
    index.write_paths(["parent"])
    assert index.finish_generation(1)
    assert index.accepted_generation() == 1
    index.queue_reconciliation_parent(1, "parent")
    assert index.reconciliation_generation() == 1
    before = index.search("parent other")
    for invalid in ("other/child", "parent", "parent/deep/child"):
        with pytest.raises(ValueError, match="immediate parent"):
            index.write_reconciliation_children(1, "parent", [("parent/safe", False), (invalid, False)])
        assert index.search("parent other") == before
    with pytest.raises(ValueError, match="row batch"):
        index.write_reconciliation_children(1, "parent", ((f"parent/{number}", False) for number in range(ROW_BATCH_SIZE + 1)))
    assert index.search("parent other") == before
    index.finish_reconciliation_parent(1, "parent")
    assert index.reconciliation_generation() is None
    with pytest.raises(ValueError):
        index.finish_reconciliation_parent(1, "parent")
    with pytest.raises(ValueError):
        index.write_reconciliation_children(1, "parent", [("parent/late", False)])
    index.queue_reconciliation_parent(1, "parent")
    candidate = index.prepare_scan()[0]
    for operation in (
        lambda: index.queue_reconciliation_parent(candidate, "parent"),
        lambda: index.write_reconciliation_children(candidate, "parent", [("parent/late", False)]),
        lambda: index.finish_reconciliation_parent(candidate, "parent"),
    ):
        with pytest.raises(ValueError):
            operation()
    index.write_paths(["replacement"], generation_id=candidate)
    index.finish_scan_parent(candidate, "parent")
    assert index.finish_generation(candidate)
    selected = index.search("replacement parent")
    for generation in (candidate + 1, MAX_SIGNED_INTEGER):
        for operation in (
            lambda: index.queue_reconciliation_parent(generation, "parent"),
            lambda: index.write_reconciliation_children(generation, "parent", [("parent/late", False)]),
            lambda: index.finish_reconciliation_parent(generation, "parent"),
        ):
            with pytest.raises(ValueError):
                operation()
            assert index.search("replacement parent") == selected


def test_accepted_parent_reconciliation_bounds_bytes_and_root_children(index, monkeypatch):
    index.write_paths(["existing"])
    assert index.finish_generation(1)
    index.queue_reconciliation_parent(1, "")
    before = index.search("existing root")
    consumed = []

    def children():
        for path in ("safe", "\u00e9" * 3):
            consumed.append(path)
            yield path, True
        raise AssertionError("An oversized batch must not consume further children.")

    with monkeypatch.context() as budget:
        budget.setattr("app.services.directory_index.SCAN_BATCH_BYTES", 9)
        with pytest.raises(ValueError, match="byte limit"):
            index.write_reconciliation_children(1, "", children())
        assert len(consumed) == 2
        assert index.search("existing root") == before
        assert index.pending_scan_paths(1) == [""]
        index.write_reconciliation_children(1, "", [(prefix + "\u00e9", False) for prefix in ("a", "b", "c")])
        assert index.status().directory_count == 4
    before_invalid = index.status()
    with pytest.raises(ValueError, match="immediate parent"):
        index.write_reconciliation_children(1, "", [("root-child", True), ("nested/child", False)])
    assert index.status() == before_invalid
    index.write_reconciliation_children(1, "", [("root-child", True)])
    index.finish_reconciliation_parent(1, "")
    assert index.pending_scan_paths(1) == ["root-child"]
    after = index.search("existing root")
    assert after.directory_count == 5
    assert after.last_verified_at_ms == before.last_verified_at_ms


@pytest.mark.parametrize("failure", ["queue", "revision", "completion"])
def test_failed_accepted_parent_reconciliation_rolls_back_rows_and_work(index, failure):
    index.write_paths(["parent"])
    assert index.finish_generation(1)
    index.queue_reconciliation_parent(1, "parent")
    before = index.search("parent")
    triggers = {
        "queue": "BEFORE INSERT ON scan_queue WHEN NEW.path = 'parent/abort'",
        "revision": "BEFORE UPDATE ON source_metadata",
        "completion": "BEFORE UPDATE ON scan_queue WHEN OLD.path = 'parent'",
    }
    index._connection().execute(f"CREATE TRIGGER reject_reconciliation {triggers[failure]} BEGIN SELECT RAISE(ABORT, 'injected'); END")

    def operation():
        if failure == "completion":
            index.finish_reconciliation_parent(1, "parent")
        else:
            index.write_reconciliation_children(1, "parent", [("parent/abort", True)])

    with pytest.raises(sqlite3.IntegrityError):
        operation()
    assert index.search("parent") == before
    assert index.pending_scan_paths(1) == ["parent"]
    index._connection().execute("DROP TRIGGER reject_reconciliation")
    operation()
    if failure == "completion":
        assert index.pending_scan_paths(1) == []
        assert index.search("parent") == before
    else:
        assert index.search("parent").directory_count == 2
        assert index.pending_scan_paths(1) == ["parent", "parent/abort"]


def test_accepted_parent_reconciliation_headroom_refusal_retains_work(index, monkeypatch):
    from app.services.directory_index_resources import DirectoryDiskBudgetError

    index.write_paths(["parent"])
    assert index.finish_generation(1)
    index.queue_reconciliation_parent(1, "parent")
    before = index.search("parent")

    def denied():
        raise DirectoryDiskBudgetError("Injected reconciliation headroom refusal.")

    with monkeypatch.context() as refusal:
        refusal.setattr(index, "growth_guard", denied)
        for operation in (
            lambda: index.queue_reconciliation_parent(1, "other"),
            lambda: index.write_reconciliation_children(1, "parent", [("parent/child", False)]),
            lambda: index.finish_reconciliation_parent(1, "parent"),
        ):
            with pytest.raises(DirectoryDiskBudgetError):
                operation()
            assert index.pending_scan_paths(1) == ["parent"]
            assert index.search("parent") == before
    index.write_reconciliation_children(1, "parent", [("parent/child", False)])
    index.finish_reconciliation_parent(1, "parent")
    assert index.reconciliation_generation() is None
    after = index.search("parent")
    assert after.directory_count == 2
    assert after.last_verified_at_ms == before.last_verified_at_ms


@pytest.mark.asyncio
@pytest.mark.parametrize("abandon", ["cancel", "timeout"])
async def test_abandoned_smb_mutation_requeues_only_after_actual_worker_exit(sqlite_cache, monkeypatch, abandon):
    from app.storage.smb import SMBBackend
    from app.storage.smb_errors import SMBMutationUncertain

    backend = SMBBackend(host="fixture", share_name="share", username="user", password="password", connection_context_key="fixture")
    manager = SimpleNamespace(get_cache=lambda _connection_id: sqlite_cache)
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: manager)
    entered = threading.Event()
    release = threading.Event()
    retained = []

    def mutate():
        entered.set()
        assert release.wait(timeout=5)

    async def retain(cache, future):
        assert cache is backend._connection_cache
        retained.append(future)

    async def invalidate(**kwargs):
        return None

    async def pool():
        return SimpleNamespace(
            retain_connection_until_future_complete=retain,
            invalidate_connection=invalidate,
            connection_diagnostics=lambda _cache: {},
        )

    async def timeout(future, **kwargs):
        assert await asyncio.to_thread(entered.wait, 5)
        raise TimeoutError("Injected timeout while native mutation is blocked.")

    monkeypatch.setattr("app.storage.smb.get_connection_pool", pool)
    if abandon == "timeout":
        monkeypatch.setattr(backend, "_wait_for_blocking_smb_operation", timeout)
    task = asyncio.create_task(
        backend._run_blocking_smb_operation(
            "injected mutation",
            mutate,
            5,
            smb_path=backend._build_smb_path("parent/item"),
            mutation_paths=(backend._build_smb_path("parent/item"),),
        )
    )
    token = None
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        token = sqlite_cache.coordinator.begin_read("parent")
        if abandon == "cancel":
            task.cancel()
        with pytest.raises(asyncio.CancelledError if abandon == "cancel" else SMBMutationUncertain):
            await task
        assert len(retained) == 1
        assert not retained[0].done()
        assert len(sqlite_cache.coordinator.pending) == 1
        assert sqlite_cache.coordinator.is_current(token)
    finally:
        release.set()
        if retained:
            await asyncio.wait_for(asyncio.shield(retained[0]), 5)
        elif not task.done():
            await asyncio.wait_for(task, 5)
        if token is not None:
            current = sqlite_cache.coordinator.is_current(token)
            sqlite_cache.coordinator.end_read(token)
    assert not current
    assert len(sqlite_cache.coordinator.pending) == 2
    assert all(mutation.path == "parent" for _sequence, mutation, _size in sqlite_cache.coordinator.pending)


@pytest.mark.parametrize("binding", ["context", "root", "credentials", "stopped", "unowned"])
def test_smb_mutation_hints_cannot_cross_source_bindings(sqlite_cache, monkeypatch, binding):
    from app.storage.smb import SMBBackend

    key = None if binding == "unowned" else "other" if binding == "context" else "fixture"
    backend = SMBBackend(host="fixture", share_name="share", username="user", password="password", connection_context_key=key)
    manager = SimpleNamespace(get_cache=lambda _connection_id: sqlite_cache)
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: manager)
    if binding == "root":
        backend._path_prefix = "other"
    elif binding == "credentials":
        backend.password = "other"
    elif binding == "stopped":
        sqlite_cache._stop_event.set()
    backend._observe_mutation_paths((backend._build_smb_path("parent/item"),))
    assert not sqlite_cache.coordinator.pending
    sqlite_cache._stop_event.clear()


@pytest.mark.asyncio
async def test_smb_hint_failure_preserves_mutation_result_and_private_error_text(sqlite_cache, monkeypatch):
    from app.storage import smb

    backend = smb.SMBBackend(host="fixture", share_name="share", username="user", password="password", connection_context_key="fixture")
    manager = SimpleNamespace(get_cache=lambda _connection_id: sqlite_cache)
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: manager)
    messages = []

    def failed_hint(parent):
        raise PermissionError("private source and account text")

    monkeypatch.setattr(sqlite_cache, "observe_parent", failed_hint)
    monkeypatch.setattr(smb.logger, "warning", lambda *args: messages.append(args))
    result = await backend._run_blocking_smb_operation(
        "injected mutation",
        lambda: "source result",
        5,
        smb_path=backend._build_smb_path("parent/item"),
        mutation_paths=(backend._build_smb_path("parent/item"),),
    )
    assert result == "source result"
    assert sqlite_cache.coordinator.verification_required
    assert sqlite_cache.coordinator.epoch == 2
    assert len(messages) == 2
    assert all(arguments == ("Directory mutation hints could not be queued (%s).", "PermissionError") for arguments in messages)


@pytest.mark.asyncio
@pytest.mark.parametrize("yield_after_parent", [False, True])
@pytest.mark.parametrize("failed", [False, True])
@pytest.mark.parametrize(
    "operation,prefix",
    [("create", ""), ("create", "scoped"), ("archive", "scoped"), ("mixed_archive", "scoped"), ("upload", "scoped")],
)
async def test_smb_mutation_queues_parent_before_dispatch_and_after_exit(
    sqlite_cache, monkeypatch, failed, prefix, operation, yield_after_parent
):
    from contextlib import asynccontextmanager, contextmanager
    from io import BytesIO
    from pathlib import PureWindowsPath
    from unittest.mock import AsyncMock

    from smbclient._os import FileAttributes

    from app.api.archive_operations import _ensure_mixed_archive_parent_directories
    from app.models.file import FileType
    from app.services import directory_cache
    from app.services.archive.extraction import _ensure_live_directory
    from app.storage.smb import SMBBackend

    index = sqlite_cache.index
    clock = [sqlite_cache._last_access]
    index.write_paths(["parent"])
    assert index.finish_generation(1)
    before = index.search("parent")
    manager = SimpleNamespace(get_cache=lambda _connection_id: sqlite_cache)
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: manager)
    sqlite_cache._path_prefix = prefix
    backend = SMBBackend(
        host="fixture", share_name="share", username="user", password="password", connection_context_key="fixture", path_prefix=prefix
    )
    dispatched = []
    source_directories = {"parent"}
    root = PureWindowsPath(backend._build_smb_path(""))
    sqlite_cache._smb_base_path = str(root)

    def relative_path(path):
        relative = PureWindowsPath(path).relative_to(root).as_posix()
        return "" if relative == "." else relative

    @asynccontextmanager
    async def connected(**kwargs):
        yield

    async def pool():
        return SimpleNamespace(get_connection=connected, connection_diagnostics=lambda _cache: {}, generation_aborting=lambda _cache: False)

    def create(path, **kwargs):
        dispatched.append(path)
        relative = relative_path(path)
        assert sqlite_cache.coordinator.pending[-1][1].path == relative.rpartition("/")[0]
        if relative in source_directories:
            raise FileExistsError(relative)
        source_directories.add(relative)
        if failed:
            raise PermissionError("Injected partial source mutation.")

    def scan(path, **kwargs):
        relative = relative_path(path)
        for directory in sorted(source_directories):
            parent, _, name = directory.rpartition("/")
            if parent == relative:
                yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))
        if yield_after_parent:
            clock[0] += directory_cache.WORKER_POLL_SECONDS

    @contextmanager
    def open_writer(path, **kwargs):
        dispatched.append(path)
        assert sqlite_cache.coordinator.pending[-1][1].path == relative_path(path).rpartition("/")[0]

        def write(chunk):
            source_directories.add("parent/discovered")
            if failed:
                raise PermissionError("Injected partial source mutation.")
            return len(chunk)

        yield SimpleNamespace(write=write)

    monkeypatch.setattr("app.storage.smb.get_connection_pool", pool)
    monkeypatch.setattr("app.storage.smb.smbclient.mkdir", create)
    monkeypatch.setattr("app.storage.smb.smbclient.open_file", open_writer)
    monkeypatch.setattr("smbclient.scandir", scan)
    monkeypatch.setattr(backend, "get_file_info", AsyncMock(return_value=SimpleNamespace(type=FileType.DIRECTORY)))
    if operation == "archive":
        mutation = _ensure_live_directory(backend, "parent/new/deep")
    elif operation == "mixed_archive":
        mutation = _ensure_mixed_archive_parent_directories(backend, destination_root="parent", target_path="parent/new/deep/file")
    elif operation == "upload":
        mutation = backend.write_file("parent/new", BytesIO(b"uploaded"))
    else:
        mutation = backend.create_directory("parent/new")
    if failed:
        with pytest.raises(PermissionError, match="partial source mutation"):
            await mutation
    else:
        await mutation
    assert backend._build_smb_path("parent/new") in dispatched
    assert len(sqlite_cache.coordinator.pending) == 2 * len(dispatched)
    sqlite_cache.coordinator.apply_pending()
    assert set(index.pending_scan_paths(1)) == {relative_path(path).rpartition("/")[0] for path in dispatched}
    assert index.search("parent") == before
    monkeypatch.setattr(directory_cache, "time", SimpleNamespace(monotonic=lambda: clock[0], time=directory_cache.time.time))
    # Reconciliation can yield after each parent; include the source root in the turn bound.
    for reconciliation_turn in range(len(source_directories) + 1):
        sqlite_cache._reconcile_disk_queue()
        if index.reconciliation_generation() is None:
            break
    if yield_after_parent:
        assert reconciliation_turn > 0
    after = sqlite_cache.search_index("parent new")
    assert {row.path for row in after.results} == source_directories
    assert after.total_matches == after.directory_count == len(source_directories)
    assert after.last_verified_at_ms == before.last_verified_at_ms
    assert index.accepted_generation() == 1
    assert index.reconciliation_generation() is None
    assert sqlite_cache.coordinator.verification_required
    assert not sqlite_cache.coordinator.pending
    assert not sqlite_cache.coordinator._producers
    assert sqlite_cache.resources.usage().reserved_bytes == 0


def test_transfer_destination_hint_never_inserts_a_file_as_directory(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    from app.api.browser import _add_to_directory_cache

    index = sqlite_cache.index
    index.write_paths(["parent"])
    assert index.finish_generation(1)
    before = index.search("parent")
    manager = SimpleNamespace(get_cache=lambda _connection_id: sqlite_cache)
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: manager)

    def scan(path, **kwargs):
        if path.endswith("\\parent"):
            yield SimpleNamespace(name="file.txt", smb_info=SimpleNamespace(file_attributes=0))
            yield SimpleNamespace(name="directory", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    monkeypatch.setattr("smbclient.scandir", scan)
    _add_to_directory_cache("fixture", "/parent/file.txt")
    sqlite_cache.coordinator.apply_pending()
    assert index.search("parent") == before
    assert index.pending_scan_paths(1) == ["parent"]
    sqlite_cache._reconcile_disk_queue()
    assert {row.path for row in index.search("parent").results} == {"parent", "parent/directory"}
    assert index.search("file.txt").total_matches == 0
    assert index.status().last_verified_at_ms == before.last_verified_at_ms


def test_observed_parent_hints_are_transactional_and_do_not_publish_names(index):
    from app.services.directory_cache import READ_PARENT_ACTION, DirectoryScanCoordinator, _DirectoryMutation

    index.write_paths(["retained"])
    assert index.finish_generation(1)
    candidate = index.prepare_scan()[0]
    before = index.search("retained unverified")
    coordinator = DirectoryScanCoordinator(index)
    assert coordinator.enqueue(_DirectoryMutation(READ_PARENT_ACTION, "unverified"))
    index._connection().execute(
        f"CREATE TRIGGER reject_parent_hint BEFORE INSERT ON scan_queue WHEN NEW.generation_id = {candidate} "
        "BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    with pytest.raises(sqlite3.IntegrityError):
        coordinator.apply_pending()
    assert index.pending_scan_paths(1) == index.pending_scan_paths(candidate) == []
    assert len(coordinator.pending) == 1
    assert index.search("retained unverified") == before
    index._connection().execute("DROP TRIGGER reject_parent_hint")
    coordinator.apply_pending()
    assert index.pending_scan_paths(1) == index.pending_scan_paths(candidate) == ["unverified"]
    index.finish_scan_parent(candidate, "unverified")
    index.queue_observed_parent("unverified")
    assert index.pending_scan_paths(1) == index.pending_scan_paths(candidate) == ["unverified"]
    index.finish_scan_parent(candidate, "unverified")
    assert index.finish_generation(candidate)
    selected = index.status()
    index.queue_observed_parent("")
    assert index.pending_scan_paths(1) == [""]
    assert index.pending_scan_paths(candidate) == [""]
    assert index.status() == selected
    assert index.search("unverified").total_matches == 0


@pytest.mark.parametrize("overflow", ["entries", "bytes"])
def test_parent_hints_fence_root_reads_and_share_bounded_observation_limits(index, overflow):
    from app.services.directory_cache import READ_PARENT_ACTION, DirectoryScanCoordinator, ScanObservationInvalidated, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index, maximum_pending=2, maximum_bytes=3)
    token = coordinator.begin_read("other")
    assert coordinator.enqueue(_DirectoryMutation(READ_PARENT_ACTION, ""))
    assert not coordinator.is_current(token)
    assert list(coordinator.barriers) == [(1, "", 0)]
    assert coordinator.enqueue(_DirectoryMutation(READ_PARENT_ACTION, "a"))
    assert list(coordinator.barriers) == [(2, "", 0)]
    if overflow == "bytes":
        coordinator.maximum_pending += 1
    epoch = coordinator.epoch
    assert not coordinator.enqueue(_DirectoryMutation(READ_PARENT_ACTION, "b" if overflow == "entries" else "long"))
    assert coordinator.epoch == epoch + 1
    assert coordinator.verification_required
    assert coordinator.pending_bytes == 1
    assert len(coordinator.pending) == 2
    assert not coordinator.barriers
    assert len(coordinator._producers) == 1
    with pytest.raises(ScanObservationInvalidated):
        coordinator.commit_children(token, 1, [("other/late", False)])
    coordinator.apply_pending()
    assert index.pending_scan_paths(1) == ["", "a"]
    assert index.status().directory_count == 0
    coordinator.end_read(token)
    assert not coordinator._producers


@pytest.mark.parametrize("directions", [("from",), ("to",), ("to", "from"), ("from", "to"), ("file",)])
def test_backend_rename_hints_do_not_require_pairing_or_insert_unverified_names(sqlite_cache, monkeypatch, directions):
    from smbclient._os import FileAttributes
    from smbprotocol.change_notify import FileAction

    index = sqlite_cache.index
    index.write_paths(["old", "old/tree", "old/tree/child", "new"])
    assert index.finish_generation(1)
    verified = index.status().last_verified_at_ms
    actions = {
        "from": (FileAction.FILE_ACTION_RENAMED_OLD_NAME, "old\\tree"),
        "to": (FileAction.FILE_ACTION_RENAMED_NEW_NAME, "new\\tree"),
        "file": (FileAction.FILE_ACTION_RENAMED_NEW_NAME, "new\\regular-file"),
    }

    def event(action, path):
        return {"action": SimpleNamespace(get_value=lambda: action), "file_name": SimpleNamespace(get_value=lambda: path)}

    def scan(path, **kwargs):
        relative = path[len(sqlite_cache._smb_base_path) :].lstrip("\\").replace("\\", "/")
        for name in {"new": ["tree", "regular-file"], "new/tree": ["child"]}.get(relative, []):
            attributes = 0 if name == "regular-file" else FileAttributes.FILE_ATTRIBUTE_DIRECTORY
            yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=attributes))

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._process_change_events([event(*actions[direction]) for direction in directions])
    sqlite_cache.coordinator.apply_pending()
    assert index.search("new/tree regular-file").total_matches == 0
    assert index.search("old/tree").total_matches == (0 if "from" in directions else 2)
    assert set(index.pending_scan_paths(1)) == {"old" if direction == "from" else "new" for direction in directions}
    sqlite_cache._reconcile_disk_queue()
    assert index.search("regular-file").total_matches == 0
    assert index.search("new/tree").total_matches == (0 if directions == ("from",) else 2)
    assert index.status().last_verified_at_ms == verified
    assert index.reconciliation_generation() is None


@pytest.mark.asyncio
async def test_update_loop_discovers_accepted_subtrees_without_full_verification(sqlite_cache, monkeypatch):
    from contextlib import asynccontextmanager

    from smbclient._os import FileAttributes
    from smbprotocol.change_notify import FileAction

    from app.services import directory_cache
    from app.services.directory_cache import _DirectoryMutation

    index = sqlite_cache.index
    index.write_paths(["retained"])
    assert index.finish_generation(1)
    verified = index.status().last_verified_at_ms
    clock = sqlite_cache._last_scan_time
    sqlite_cache.coordinator.verification_required = False
    assert sqlite_cache.coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "tree"))
    assert sqlite_cache.coordinator.verification_required
    reads = []
    ticks = 0

    def scan(path, **kwargs):
        reads.append(path)
        assert sqlite_cache._scan_running.is_set()
        assert not sqlite_cache._manager_scan_slots.acquire(blocking=False)
        children = {"": ["retained", "tree"], "tree": ["deep"], "tree/deep": ["child"]}
        relative = path[len(sqlite_cache._smb_base_path) :].lstrip("\\").replace("\\", "/")
        for name in children.get(relative, []):
            yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    @asynccontextmanager
    async def connected(**kwargs):
        yield

    async def pool():
        return SimpleNamespace(get_connection=connected)

    async def tick(_delay):
        nonlocal ticks
        ticks += 1
        if ticks > 1:
            raise asyncio.CancelledError

    monkeypatch.setattr(directory_cache, "asyncio", SimpleNamespace(**(vars(asyncio) | {"sleep": tick})))
    monkeypatch.setattr(directory_cache, "get_connection_pool", pool)
    monkeypatch.setattr("smbclient.scandir", scan)
    monkeypatch.setattr(sqlite_cache, "_verification_due", lambda _verified_at: False)
    monkeypatch.setattr(sqlite_cache, "_run_rescan", lambda: pytest.fail("Reconciliation must not start a full pass."))
    await sqlite_cache._periodic_rescan_loop()
    response = index.search("tree retained")
    assert {row.path for row in response.results} == {"retained", "tree", "tree/deep", "tree/deep/child"}
    assert response.last_verified_at_ms == verified
    assert sqlite_cache._last_scan_time == clock
    assert sqlite_cache.coordinator.verification_required
    assert index.accepted_generation() == 1
    assert index.reconciliation_generation() is None
    assert not sqlite_cache.coordinator._producers
    assert not sqlite_cache._scan_running.is_set()
    assert sqlite_cache._active_workers == 0
    assert sqlite_cache.resources.usage().reserved_bytes == 0
    assert reads == [sqlite_cache._smb_base_path + suffix for suffix in ("", "\\tree", "\\tree\\deep", "\\tree\\deep\\child")]


@pytest.mark.parametrize("blocker", ["capacity", "generation", "retry", "unavailable", "stop", "storage"])
def test_accepted_parent_worker_preserves_work_after_refusal(sqlite_cache, monkeypatch, blocker):
    from time import monotonic

    from app.services.directory_index_resources import DirectoryDiskBudgetError

    index = sqlite_cache.index
    index.write_paths(["parent"])
    assert index.finish_generation(1)
    index.queue_reconciliation_parent(1, "parent")
    before = index.search("parent")
    reads = []

    def scan(path, **kwargs):
        reads.append(path)
        return (entry for entry in ())

    monkeypatch.setattr("smbclient.scandir", scan)
    lock = None
    if blocker == "capacity":
        lock = sqlite_cache._manager_scan_slots
        assert lock.acquire(blocking=False)
    elif blocker == "generation":
        lock = sqlite_cache._generation_lock
        assert lock.acquire(blocking=False)
    elif blocker == "retry":
        sqlite_cache._schedule_retry(now=monotonic())
    elif blocker == "unavailable":
        sqlite_cache._source_available.clear()
    elif blocker == "stop":
        sqlite_cache._stop_event.set()
    else:

        def denied():
            raise DirectoryDiskBudgetError("Injected reconciliation headroom refusal.")

        monkeypatch.setattr(index, "growth_guard", denied)
    try:
        for _attempt in range(2):
            if blocker == "storage":
                with pytest.raises(DirectoryDiskBudgetError):
                    sqlite_cache._reconcile_disk_queue()
            else:
                sqlite_cache._reconcile_disk_queue()
            assert index.pending_scan_paths(1) == ["parent"]
            assert index.search("parent") == before
            assert not sqlite_cache.coordinator._producers
            assert not sqlite_cache._scan_running.is_set()
            assert sqlite_cache.resources.usage().reserved_bytes == 0
        assert len(reads) == (2 if blocker == "storage" else 0)
    finally:
        if lock is not None:
            lock.release()
        monkeypatch.undo()
        sqlite_cache._reset_retry()
        sqlite_cache._source_available.set()
        sqlite_cache._stop_event.clear()
    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._reconcile_disk_queue()
    assert index.reconciliation_generation() is None
    assert index.search("parent") == before


@pytest.mark.parametrize("failure", ["denied", "redirected", "close"])
def test_accepted_parent_worker_completes_item_failures_and_exclusions(sqlite_cache, monkeypatch, failure):
    from smbclient._os import FileAttributes

    index = sqlite_cache.index
    index.write_paths(["parent", "parent/retained"])
    assert index.finish_generation(1)
    index.queue_reconciliation_parent(1, "parent")
    before = index.search("parent")

    def scan(path, **kwargs):
        if failure == "denied":
            raise PermissionError("Injected source denial.")
        if failure == "redirected":
            yield SimpleNamespace(
                name="unsafe",
                smb_info=SimpleNamespace(
                    file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY | FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT
                ),
            )

    class FailedClose:
        def __next__(self):
            raise StopIteration

        def close(self):
            raise OSError("Injected source cleanup failure.")

    monkeypatch.setattr("smbclient.scandir", (lambda *args, **kwargs: FailedClose()) if failure == "close" else scan)
    sqlite_cache._reconcile_disk_queue()
    assert index.pending_scan_paths(1) == []
    after = index.search("parent")
    assert after.coverage == ("complete" if failure == "redirected" else "partial")
    assert after.issue_count == (0 if failure == "redirected" else 1)
    if failure == "redirected":
        assert sqlite_cache.directory_issue_details() == ([], False)
    assert after.last_verified_at_ms == before.last_verified_at_ms
    if failure == "denied":
        assert after.results == before.results
    assert not sqlite_cache.coordinator._producers
    assert not sqlite_cache._scan_running.is_set()
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    sqlite_cache._manager_scan_slots.release()


def test_pending_accepted_parent_work_defers_all_maintenance(sqlite_cache, monkeypatch):
    index = sqlite_cache.index
    index.write_paths(["parent"])
    assert index.finish_generation(1)
    index.queue_reconciliation_parent(1, "parent")
    before = index.search("parent")
    calls = []

    def complete():
        calls.append(True)
        return True

    monkeypatch.setattr(index, "reclaim_pages", complete)
    monkeypatch.setattr(index, "checkpoint_if_due", complete)
    sqlite_cache._reclamation_pending = True
    for operation in (sqlite_cache._reclaim_disk_work, sqlite_cache._checkpoint_work):
        operation()
    assert not calls
    assert sqlite_cache._reclamation_pending
    assert index.search("parent") == before
    index.finish_reconciliation_parent(1, "parent")
    for operation in (sqlite_cache._reclaim_disk_work, sqlite_cache._checkpoint_work):
        operation()
    assert len(calls) == 2
    assert not sqlite_cache._reclamation_pending
    assert index.search("parent") == before


def test_blocked_accepted_parent_worker_retains_ownership_and_rejects_late_rows(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    from app.services.directory_cache import ScanObservationInvalidated

    index = sqlite_cache.index
    index.write_paths(["parent"])
    assert index.finish_generation(1)
    index.queue_reconciliation_parent(1, "parent")
    before = index.search("parent")
    entered = threading.Event()
    release = threading.Event()
    failures = []

    def scan(path, **kwargs):
        entered.set()
        assert release.wait(timeout=5)
        yield SimpleNamespace(name="late", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    def reconcile():
        try:
            sqlite_cache._reconcile_disk_queue()
        except BaseException as error:
            failures.append(error)

    monkeypatch.setattr("smbclient.scandir", scan)
    worker = threading.Thread(target=reconcile)
    worker.start()
    try:
        assert entered.wait(timeout=5)
        _lose_observations(sqlite_cache.coordinator)
        assert len(sqlite_cache.coordinator._producers) == 1
        assert sqlite_cache._scan_running.is_set()
        assert not sqlite_cache._manager_scan_slots.acquire(blocking=False)
        assert not sqlite_cache._generation_lock.acquire(blocking=False)
        assert index.search("parent") == before
    finally:
        release.set()
        worker.join(timeout=5)
    assert not worker.is_alive()
    assert len(failures) == 1
    assert isinstance(failures[0], ScanObservationInvalidated)
    assert index.search("parent") == before
    assert index.pending_scan_paths(1) == ["parent"]
    assert sqlite_cache.coordinator.verification_required
    assert not sqlite_cache.coordinator._producers
    assert not sqlite_cache._scan_running.is_set()
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    sqlite_cache._manager_scan_slots.release()


def test_observed_mutations_queue_accepted_parents_atomically(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    index.write_paths(["old", "old/tree", "old/tree/child", "new"])
    assert index.finish_generation(1)
    before = index.search("old new")
    coordinator = DirectoryScanCoordinator(index)
    mutation = _DirectoryMutation(FileAction.FILE_ACTION_RENAMED_NEW_NAME, "old/tree", "new/tree")
    assert coordinator.enqueue(mutation)
    index._connection().execute(
        "CREATE TRIGGER reject_observed_work BEFORE INSERT ON scan_queue WHEN NEW.path = 'new' BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    with pytest.raises(sqlite3.IntegrityError):
        coordinator.apply_pending()
    assert index.search("old new") == before
    assert index.pending_scan_paths(1) == []
    assert len(coordinator.pending) == 1
    index._connection().execute("DROP TRIGGER reject_observed_work")
    assert coordinator.apply_pending() == 1
    assert index.pending_scan_paths(1) == ["new", "new/tree", "old"]
    assert index.search("old new").last_verified_at_ms == before.last_verified_at_ms
    for parent in index.pending_scan_paths(1):
        index.finish_reconciliation_parent(1, parent)
    assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "new/tree"))
    assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "old"))
    assert coordinator.apply_pending() == 2
    assert set(index.pending_scan_paths(1)) == {"", "new", "new/tree"}
    assert not coordinator.pending


def test_added_subtrees_queue_live_pass_without_advancing_verification(index):
    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    before = index.search("accepted")
    candidate = index.prepare_scan()[0]
    index.mutate_path("add", "new")
    assert index.pending_scan_paths(1) == ["new"]
    assert index.pending_scan_paths(candidate) == ["new"]
    assert index.search("accepted new").directory_count == 2
    assert index.search("accepted").last_verified_at_ms == before.last_verified_at_ms


def test_direct_child_pages_preserve_original_names_and_byte_bounds(index):
    index.write_paths(["root%_/a/one", "root%_/a/two", "root%_/a-b", "root%_/b/child", "root%_-other/leak", "é/x", "e\u0301/y"])
    assert index.direct_child_paths(1, "root%_", maximum_bytes=18) == ["root%_/a", "root%_/a-b"]
    assert index.direct_child_paths(1, "root%_", after_path="root%_/a-b", maximum_bytes=18) == ["root%_/b"]
    assert index.direct_child_paths(1, "root%_", after_path="root%_/b") == []
    assert index.direct_child_paths(1, "") == ["e\u0301", "root%_", "root%_-other", "é"]
    with pytest.raises(ValueError, match="cursor"):
        index.direct_child_paths(1, "root%_", after_path="other/child")
    with pytest.raises(ValueError, match="byte budget"):
        index.direct_child_paths(1, "root%_", maximum_bytes=1)
    with pytest.raises(ValueError, match="byte budget"):
        index.direct_child_paths(1, "root%_", maximum_bytes=True)
    from app.services.directory_index import ROW_BATCH_SIZE

    index.write_paths(f"many/{number:06d}" for number in range(ROW_BATCH_SIZE * 2 + 1))
    cursor = None
    count = 0
    while page := index.direct_child_paths(1, "many", after_path=cursor):
        assert len(page) <= ROW_BATCH_SIZE
        count += len(page)
        cursor = page[-1]
    assert count == ROW_BATCH_SIZE * 2 + 1


@pytest.mark.parametrize("maximum_bytes", [8, 9, 10, 12, 16, 24, 64])
def test_direct_child_pages_match_sorted_reference_without_temporary_sort(index, maximum_bytes):
    names = ["a", "a!", "a!a", "a!b", "a-b", "a.", "a0", "a !", "a a", "aä", "!a", "!a!", "é", "z" * 20]
    index.write_paths(f"parent/{name}/leaf" for name in reversed(names))
    statements = []
    index._connection().set_trace_callback(statements.append)
    try:
        for after_path in [None, "parent/a", "parent/a-b", "parent/a0"]:
            expected = []
            size = 0
            oversized = False
            for path in sorted(f"parent/{name}" for name in names):
                if after_path is not None and path <= after_path:
                    continue
                if len(path.encode("utf-8")) > maximum_bytes:
                    oversized = True
                    break
                if size + len(path.encode("utf-8")) > maximum_bytes:
                    break
                expected.append(path)
                size += len(path.encode("utf-8"))
            if oversized:
                with pytest.raises(ValueError, match="byte budget"):
                    index.direct_child_paths(1, "parent", after_path=after_path, maximum_bytes=maximum_bytes)
            else:
                assert index.direct_child_paths(1, "parent", after_path=after_path, maximum_bytes=maximum_bytes) == expected
    finally:
        index._connection().set_trace_callback(None)
    assert statements
    for sql in statements:
        plan = index._connection().execute("EXPLAIN QUERY PLAN " + sql).fetchall()
        assert all("TEMP B-TREE" not in row[-1] for row in plan)
        assert any("COVERING INDEX" in row[-1] for row in plan)


def test_direct_child_pages_stop_before_reading_the_remaining_flat_tree(index):
    from app.services.directory_index import ROW_BATCH_SIZE

    row_count = ROW_BATCH_SIZE * 32
    index.write_paths(f"parent/{number:06d}" for number in range(row_count))
    steps = 0

    def observe_step():
        nonlocal steps
        steps += 1
        return False

    index._connection().set_progress_handler(observe_step, 1)
    try:
        page = index.direct_child_paths(1, "parent")
    finally:
        index._connection().set_progress_handler(None, 0)
    assert len(page) == ROW_BATCH_SIZE
    assert page[-1] == f"parent/{ROW_BATCH_SIZE - 1:06d}"
    assert steps < row_count


def test_missing_subtree_pruning_is_bounded_and_preserves_verification(index):
    from app.services.directory_index import ROW_BATCH_SIZE

    paths = ["gone"] + [f"gone/{number:06d}" for number in range(ROW_BATCH_SIZE * 2)]
    index.write_paths(paths + ["gone-other", "keep"])
    assert index.finish_generation(1)
    before = index.search("keep")
    index._connection().executemany("INSERT INTO scan_queue(generation_id, path) VALUES (1, ?)", ((path,) for path in paths))
    remaining = True
    passes = 0
    while remaining:
        previous = index.status().directory_count
        remaining = index.prune_subtree_batch(1, "gone")
        after = index.status()
        assert 0 < previous - after.directory_count <= ROW_BATCH_SIZE
        assert after.last_verified_at_ms == before.last_verified_at_ms
        assert index.search("gone-other keep").total_matches == 2
        passes += 1
    assert passes == 3
    assert index.status().directory_count == 2
    assert index.pending_scan_paths(1) == []
    completed = index.search("keep")
    assert not index.prune_subtree_batch(1, "gone")
    assert index.search("keep") == completed


def test_failed_missing_subtree_pruning_rolls_back_rows_queue_and_revision(index):
    index.write_paths(["gone", "gone/child", "keep"])
    index._connection().execute("INSERT INTO scan_queue(generation_id, path) VALUES (1, 'gone')")
    index._connection().execute("CREATE TRIGGER reject_prune_queue BEFORE DELETE ON scan_queue BEGIN SELECT RAISE(ABORT, 'injected'); END")
    before = index.search("gone keep")
    with pytest.raises(sqlite3.IntegrityError):
        index.prune_subtree_batch(1, "gone")
    assert index.search("gone keep") == before
    assert index.pending_scan_paths(1) == ["gone"]
    with pytest.raises(ValueError, match="no longer active"):
        index.prune_subtree_batch(2, "gone")
    with pytest.raises(ValueError):
        index.prune_subtree_batch(1, "")
    index._connection().execute("DROP TRIGGER reject_prune_queue")
    active = index.prepare_scan()[0]
    index.write_paths(["gone", "gone/child"], generation_id=active)
    assert not index.prune_subtree_batch(active, "gone")
    assert index.search("gone keep").total_matches == 1


@pytest.mark.parametrize("code", ["unsafe_traversal", "access_denied"])
def test_scan_issues_preserve_uncertainty_and_block_acceptance(index, code):
    index.write_paths(["regular"])
    index.mark_uncertain()
    before = index.status()
    for count in (2, 3):
        getattr(index, f"record_{code}")(1)
        after = index.status()
        assert after.issue_count == count
        assert after.coverage == "uncertain"
        assert after.directory_count == before.directory_count
        assert after.last_verified_at_ms == before.last_verified_at_ms
        assert after.accepted_revision > before.accepted_revision
        before = after
    assert not index.finish_generation(1)
    assert index.status().issue_count == 3
    assert index._connection().execute("SELECT code, count FROM coverage_issues ORDER BY code").fetchall() == sorted(
        [
            ("event_loss", 1),
            (code, 2),
        ]
    )


@pytest.mark.parametrize("code", ["unsafe_traversal", "access_denied"])
def test_failed_scan_issue_rolls_back_issue_coverage_and_revision(index, code):
    before = index.status()
    index._connection().execute(
        "CREATE TRIGGER reject_issue_metadata BEFORE UPDATE ON generations BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    with pytest.raises(sqlite3.IntegrityError):
        getattr(index, f"record_{code}")(1)
    assert index.status() == before
    assert index._connection().execute("SELECT count(*) FROM coverage_issues").fetchone()[0] == 0


@pytest.mark.parametrize("state", ["accepted", "missing"])
@pytest.mark.parametrize("code", ["unsafe_traversal", "access_denied"])
def test_scan_issue_rejects_inactive_generation(index, state, code):
    assert index.finish_generation(1)
    if state == "accepted":
        generation = 1
    else:
        generation = 2
    before = index.status()
    with pytest.raises(ValueError, match="inactive scan"):
        getattr(index, f"record_{code}")(generation)
    assert index.status() == before
    assert index._connection().execute("SELECT count(*) FROM coverage_issues").fetchone()[0] == 0


@pytest.mark.parametrize("invalidate", [False, True])
@pytest.mark.parametrize("code", ["unsafe_traversal", "access_denied"])
def test_scan_issue_rejects_completed_and_invalidated_reads(index, invalidate, code):
    from app.services.directory_cache import DirectoryScanCoordinator, ScanObservationInvalidated

    coordinator = DirectoryScanCoordinator(index)
    token = coordinator.begin_read("parent")
    if invalidate:
        _lose_observations(coordinator)
    else:
        coordinator.end_read(token)
    before = index.status()
    with pytest.raises(ScanObservationInvalidated):
        getattr(coordinator, f"record_{code}")(token, 1)
    assert index.status() == before
    assert index._connection().execute("SELECT count(*) FROM coverage_issues").fetchone()[0] == 0
    assert coordinator.verification_required
    coordinator.end_read(token)


def test_scan_barriers_reject_late_rename_observations(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, ScanObservationInvalidated, _DirectoryMutation

    index.write_paths(["alpha", "alpha/child"])
    coordinator = DirectoryScanCoordinator(index)
    token = coordinator.begin_read("alpha")
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_RENAMED_NEW_NAME, "alpha", "beta"))
    assert coordinator.apply_pending() == 1
    with pytest.raises(ScanObservationInvalidated):
        coordinator.commit_children(token, 1, [("alpha/stale", True)])
    assert index.search("alpha").total_matches == 0
    assert index.search("beta").total_matches == 2


def test_repeated_prefix_events_coalesce_without_accepting_old_reads(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index, maximum_pending=2)
    oldest = coordinator.begin_read("alpha")
    assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "alpha"))
    coordinator.apply_pending()
    newer = coordinator.begin_read("alpha")
    epoch = coordinator.epoch
    for path in ("alpha/child", "alpha", "alpha/next"):
        assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, path))
        coordinator.apply_pending()
    assert coordinator.epoch == epoch
    assert list(coordinator.barriers) == [(coordinator.sequence, "alpha", len("alpha"))]
    assert coordinator.barrier_bytes == len("alpha")
    assert not coordinator.is_current(oldest)
    assert not coordinator.is_current(newer)


def test_parent_barrier_coalesces_children_and_preserves_unrelated_prefix(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index, maximum_pending=3)
    token = coordinator.begin_read("alpha/first")
    for path in ("alpha/first", "unrelated", "alpha/second", "alpha"):
        assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, path))
        coordinator.apply_pending()
    assert {entry[1] for entry in coordinator.barriers} == {"alpha", "unrelated"}
    assert coordinator.barrier_bytes == len("alpha") + len("unrelated")
    assert not coordinator.is_current(token)


def test_unrelated_mutation_does_not_invalidate_directory_read(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index)
    token = coordinator.begin_read("alpha")
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "unrelated"))
    coordinator.commit_children(token, 1, [("alpha/child", False)])
    assert index.search("alpha unrelated").total_matches == 2


def test_observation_overflow_keeps_pending_updates_and_invalidates_producers(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index, maximum_pending=1)
    token = coordinator.begin_read("alpha")
    assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "accepted"))
    assert not coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "lost"))
    assert len(coordinator.pending) == 1
    assert not coordinator.is_current(token)
    assert coordinator.apply_pending() == 1
    assert index.search("accepted").total_matches == 1
    assert coordinator.verification_required


def test_failed_observation_commit_retains_pending_work(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    index.write_paths(["alpha", "occupied"])
    coordinator = DirectoryScanCoordinator(index)
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_RENAMED_NEW_NAME, "alpha", "occupied"))
    with pytest.raises(sqlite3.IntegrityError):
        coordinator.apply_pending()
    assert len(coordinator.pending) == 1
    assert coordinator.pending_bytes > 0
    assert index.search("alpha occupied").total_matches == 2


def test_barrier_retirement_waits_for_all_old_producers_and_pending_mutations(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, ScanObservationInvalidated, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index)
    first = coordinator.begin_read("alpha")
    second = coordinator.begin_read("alpha")
    assert first != second
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "alpha"))
    coordinator.end_read(first)
    coordinator.apply_pending()
    assert coordinator.barriers
    assert not coordinator.is_current(second)
    coordinator.end_read(second)
    assert not coordinator.barriers
    assert coordinator.barrier_bytes == 0
    with pytest.raises(ScanObservationInvalidated):
        coordinator.commit_children(second, 1, [("alpha/stale", False)])
    newer = coordinator.begin_read("beta")
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "beta"))
    coordinator.end_read(newer)
    assert coordinator.barriers
    coordinator.apply_pending()
    assert not coordinator.barriers


def test_invalidated_producer_cannot_publish_after_barrier_retirement(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index, maximum_pending=1)
    blocked = coordinator.begin_read("alpha")
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "accepted"))
    assert not coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "alpha"))
    coordinator.apply_pending()
    assert not coordinator.barriers
    assert blocked.producer_id in coordinator._producers
    assert not coordinator.is_current(blocked)
    coordinator.end_read(blocked)
    assert not coordinator._producers
    assert coordinator.verification_required


def test_read_context_releases_producer_after_exception(index):
    from app.services.directory_cache import DirectoryScanCoordinator

    coordinator = DirectoryScanCoordinator(index)
    with pytest.raises(OSError):
        with coordinator.read("alpha") as token:
            raise OSError("Injected blocked read failure")
    assert not coordinator._producers
    assert not coordinator.is_current(token)


def test_generation_acceptance_rejects_change_after_last_parent(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, ScanObservationInvalidated, _DirectoryMutation

    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    generation = index.prepare_scan()[0]
    coordinator = DirectoryScanCoordinator(index)
    baseline = coordinator.capture_epoch()
    index.seed_scan(generation)
    with coordinator.read("") as token:
        coordinator.commit_children(token, generation, [("candidate", False)])
        coordinator.finish_parent(token, generation)
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "candidate"))
    with pytest.raises(ScanObservationInvalidated):
        coordinator.accept_generation(baseline, generation)
    assert index.search("accepted").total_matches == 1
    assert coordinator.verification_required


def test_generation_acceptance_clears_sticky_verification_only_on_success(index):
    from app.services.directory_cache import DirectoryScanCoordinator

    coordinator = DirectoryScanCoordinator(index)
    baseline = coordinator.capture_epoch()
    index.seed_scan(1)
    with coordinator.read("") as token:
        coordinator.commit_children(token, 1, [("accepted", False)])
        coordinator.finish_parent(token, 1)
    assert coordinator.accept_generation(baseline, 1)
    assert not coordinator.verification_required
    assert index.search("accepted").coverage == "complete"


def test_event_loss_persists_uncertain_coverage_without_losing_accepted_rows(index):
    from app.services.directory_cache import DirectoryScanCoordinator

    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    verified = index.status().last_verified_at_ms
    coordinator = DirectoryScanCoordinator(index)
    _lose_observations(coordinator)
    coordinator.apply_pending()
    response = index.search("accepted")
    assert response.total_matches == 1
    assert response.coverage == "uncertain"
    assert response.issue_count == 1
    assert response.last_verified_at_ms == verified
    revision = response.accepted_revision
    coordinator.apply_pending()
    assert index.status().accepted_revision == revision
    with coordinator.read("accepted") as read:
        _lose_observations(coordinator)
        assert not coordinator.is_current(read)
        coordinator.apply_pending()
    repeated = index.search("accepted")
    assert repeated == response
    assert coordinator.verification_required
    index._connection().execute(
        "CREATE TRIGGER reject_unchanged_loss BEFORE UPDATE ON generations BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    _lose_observations(coordinator)
    coordinator.apply_pending()
    assert index.search("accepted") == response
    index._connection().execute("DROP TRIGGER reject_unchanged_loss")


def test_failed_event_loss_persistence_retains_verification_and_retries(index):
    from app.services.directory_cache import DirectoryScanCoordinator

    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    before = index.search("accepted")
    coordinator = DirectoryScanCoordinator(index)
    _lose_observations(coordinator)
    index._connection().execute(
        "CREATE TRIGGER reject_loss_revision BEFORE UPDATE ON source_metadata BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    with pytest.raises(sqlite3.IntegrityError):
        coordinator.apply_pending()
    assert index.search("accepted") == before
    assert index._connection().execute("SELECT count(*) FROM coverage_issues").fetchone()[0] == 0
    assert coordinator.verification_required
    assert coordinator._uncertain_pending
    index._connection().execute("DROP TRIGGER reject_loss_revision")
    coordinator.apply_pending()
    response = index.search("accepted")
    assert response.coverage == "uncertain"
    assert response.issue_count == 1
    assert response.last_verified_at_ms == before.last_verified_at_ms
    assert not coordinator._uncertain_pending


def test_stalled_read_invalidation_keeps_coverage_and_allows_acceptance(index):
    from app.services.directory_cache import DirectoryScanCoordinator, InvalidationReason

    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    coordinator = DirectoryScanCoordinator(index)
    coordinator.invalidate(InvalidationReason.STALLED_READ)
    coordinator.apply_pending()
    assert coordinator.verification_required
    assert not coordinator._uncertain_pending
    response = index.search("accepted")
    assert response.coverage == "complete"
    assert response.issue_count == 0
    generation = index.prepare_scan()[0]
    baseline = coordinator.capture_epoch()
    index.seed_scan(generation)
    with coordinator.read("") as token:
        coordinator.commit_children(token, generation, [("accepted", False)])
        coordinator.finish_parent(token, generation)
    assert coordinator.accept_generation(baseline, generation)
    assert not coordinator.verification_required


@pytest.mark.parametrize("reason", ["WATCHER_START", "OBSERVATION_LOSS", "SOURCE_REBIND", "READ_CAPACITY", "LIFECYCLE"])
def test_event_loss_invalidation_makes_coverage_uncertain(index, reason):
    from app.services.directory_cache import DirectoryScanCoordinator, InvalidationReason

    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    coordinator = DirectoryScanCoordinator(index)
    coordinator.invalidate(InvalidationReason[reason])
    coordinator.apply_pending()
    assert index.search("accepted").coverage == "uncertain"


@pytest.mark.parametrize("code", ["access_denied", "unsafe_traversal", "unsupported_encoding", "scan_failed"])
def test_item_issues_allow_partial_acceptance(index, code):
    index.record_issue(1, code)
    assert index.finish_generation(1)
    status = index.status()
    assert status.coverage == "partial"
    assert status.issue_count == 1
    assert status.last_verified_at_ms is not None


def test_parent_links_cascade_content_and_queue_rows(index):
    index.seed_scan(1)
    index.commit_scan_parents(1, [("", [("parent", True)])])
    index.commit_scan_parents(1, [("parent", [("parent/child", True)])])
    index.commit_scan_parents(1, [("parent/child", [("parent/child/leaf", True)])])
    connection = index._connection()
    assert connection.execute(
        "SELECT child.path, parent.path FROM directories child JOIN directories parent ON parent.id = child.parent_id ORDER BY child.path"
    ).fetchall() == [("parent/child", "parent"), ("parent/child/leaf", "parent/child")]
    with connection:
        connection.execute("DELETE FROM directories WHERE path = 'parent'")
    assert connection.execute("SELECT count(*) FROM directories").fetchone()[0] == 0
    assert index.pending_scan_paths(1) == []


def test_parent_links_follow_observed_moves_and_adds(index):
    index.write_paths(["old", "new", "old/child", "old/child/leaf"])
    index.mutate_observed_path("rename", "old/child", "new/moved")
    index.mutate_observed_path("add", "new/added")
    assert index._connection().execute(
        "SELECT child.path, parent.path FROM directories child JOIN directories parent ON parent.id = child.parent_id ORDER BY child.path"
    ).fetchall() == [("new/added", "new"), ("new/moved", "new"), ("new/moved/leaf", "new/moved")]
    index.close()
    index.open()
    assert index.status().directory_count == 5


def test_parent_snapshot_diff_preserves_unchanged_rows_and_removes_missing_subtree(index):
    index.seed_scan(1)
    index.commit_scan_parents(1, [("", [("parent", True)])])
    index.commit_scan_parents(1, [("parent", [("parent/keep", True), ("parent/remove", True)])])
    index.commit_scan_parents(1, [("parent/remove", [("parent/remove/leaf", True)])])
    identifier = index._connection().execute("SELECT id FROM directories WHERE path = 'parent/keep'").fetchone()
    index.defer_scan_parent(1, "parent")
    index.commit_scan_parents(1, [("parent", [("parent/keep", True), ("parent/add", True)])])
    assert index._connection().execute("SELECT id FROM directories WHERE path = 'parent/keep'").fetchone() == identifier
    assert index._connection().execute("SELECT path FROM directories ORDER BY path").fetchall() == [
        ("parent",),
        ("parent/add",),
        ("parent/keep",),
    ]
    assert "parent/remove/leaf" not in index.pending_scan_paths(1)
    index._connection().execute("INSERT INTO directory_fts(directory_fts, rank) VALUES ('integrity-check', 1)")


@pytest.mark.parametrize("preserve", [False, True])
def test_streamed_parent_snapshot_finishes_atomically(index, preserve):
    index.seed_scan(1)
    index.commit_scan_parents(1, [("", [("parent", True)])])
    index.commit_scan_parents(1, [("parent", [("parent/keep", True), ("parent/remove", True)])])
    index.commit_scan_parents(1, [("parent/remove", [("parent/remove/leaf", True)])])
    index.defer_scan_parent(1, "parent")
    index.write_scan_parent_batch(1, "parent", [("parent/keep", True)], reset_snapshot=True)
    assert index._connection().execute("SELECT count(*) FROM scan_snapshot_children").fetchone() == (1,)
    index.commit_scan_parents(
        1, [("parent", [("parent/new", True)])], streamed_parents={"parent"}, partial_parents={"parent"} if preserve else None
    )
    assert index.search("parent/keep").total_matches == 1
    assert index.search("parent/remove/leaf").total_matches == int(preserve)
    assert index._connection().execute("SELECT count(*) FROM scan_snapshot_children").fetchone() == (0,)
    assert "parent" not in index.pending_scan_paths(1)


@pytest.mark.parametrize("preserve", [False, True])
def test_streamed_reconciliation_snapshot_preserves_read_children(index, preserve):
    index.write_paths(["parent", "parent/keep", "parent/old"])
    assert index.finish_generation(1)
    index.queue_reconciliation_parent(1, "parent")
    index.write_scan_parent_batch(1, "parent", [("parent/keep", True)], reset_snapshot=True, reconcile=True)
    index.commit_scan_parents(
        1,
        [("parent", [("parent/new", True)])],
        streamed_parents={"parent"},
        partial_parents={"parent"} if preserve else None,
        reconcile=True,
    )
    assert index.search("parent/keep").total_matches == 1
    assert index.search("parent/old").total_matches == int(preserve)
    assert index._connection().execute("SELECT count(*) FROM scan_snapshot_children").fetchone() == (0,)


@pytest.mark.parametrize("reconcile", [False, True])
def test_streamed_snapshot_restart_replaces_staged_names(index, reconcile):
    index.prepare_scan()
    index.seed_scan(1)
    index.commit_scan_parents(1, [("", [("parent", True)])])
    if reconcile:
        index.commit_scan_parents(1, [("parent", [])])
        assert index.finish_generation(1)
        index.queue_reconciliation_parent(1, "parent")
    index.write_scan_parent_batch(1, "parent", [("parent/stale", True)], reset_snapshot=True, reconcile=reconcile)
    index.close()
    index.open()
    assert index._connection().execute("SELECT path FROM scan_snapshot_children").fetchall() == [("parent/stale",)]
    if not reconcile:
        assert index.prepare_scan() == (1, True)
    index.write_scan_parent_batch(1, "parent", [("parent/keep", False)], reset_snapshot=True, reconcile=reconcile)
    assert index._connection().execute("SELECT path FROM scan_snapshot_children").fetchall() == [("parent/keep",)]
    index.commit_scan_parents(1, [("parent", [])], streamed_parents={"parent"}, reconcile=reconcile)
    assert index._connection().execute("SELECT path FROM directories ORDER BY path").fetchall() == [("parent",), ("parent/keep",)]
    assert index._connection().execute("SELECT count(*) FROM scan_snapshot_children").fetchone() == (0,)
    assert index.pending_scan_paths(1) == []


@pytest.mark.parametrize(
    "parent,path,processed",
    [("", "deep/child", False), ("parent", "outside", False), ("parent", "parent/deep/child", False), ("", "", False), ("", "child", True)],
)
def test_reopen_rejects_malformed_streamed_snapshot(index, parent, path, processed):
    index.seed_scan(1)
    index.write_scan_children(1, [("parent", True)])
    if processed:
        index.finish_scan_parent(1, parent)
    index._connection().execute("INSERT INTO scan_snapshot_children(generation_id, parent_path, path) VALUES (1, ?, ?)", (parent, path))
    index.close()
    with pytest.raises(ValueError, match="generation metadata"):
        index.open()


@pytest.mark.parametrize("reject_completion", [False, True])
def test_parent_issue_counts_commit_with_snapshot(index, reject_completion):
    index.prepare_scan()
    index.seed_scan(1)
    index.commit_scan_parents(1, [("", [("parent", True)])])
    index.write_scan_children(1, [("parent/retained", False)])
    before = index.search("retained")
    if reject_completion:
        index._connection().execute(
            "CREATE TEMP TRIGGER reject_issue_completion BEFORE UPDATE ON scan_queue WHEN new.path = 'parent' BEGIN SELECT RAISE(ABORT, 'completion rejected'); END"
        )
    options = {"partial_parents": {"parent"}, "issues": {"parent": {"access_denied": 2, "scan_failed": 3}}}
    if reject_completion:
        with pytest.raises(sqlite3.IntegrityError, match="completion rejected"):
            index.commit_scan_parents(1, [("parent", [])], **options)
        assert index.search("retained") == before
        assert index.scan_parent_pending(1, "parent")
        assert index._connection().execute("SELECT count(*) FROM coverage_issues").fetchone() == (0,)
    else:
        index.commit_scan_parents(1, [("parent", [])], **options)
        assert not index.scan_parent_pending(1, "parent")
        assert index.status().issue_count == 5
        assert index.search("retained").total_matches == 1
        assert index._connection().execute("SELECT code, count FROM coverage_issues ORDER BY code").fetchall() == [
            ("access_denied", 2),
            ("scan_failed", 3),
        ]


@pytest.mark.parametrize("early_flush", [False, True])
@pytest.mark.parametrize("reconcile", [False, True])
def test_scan_group_buffers_parent_issues(index, early_flush, reconcile):
    from app.services.directory_cache import DirectoryScanCoordinator

    index.prepare_scan()
    index.seed_scan(1)
    if reconcile:
        index.commit_scan_parents(1, [("", [])])
        assert index.finish_generation(1)
        index.queue_observed_parent("")
    coordinator = DirectoryScanCoordinator(index)
    coordinator.start_scan_groups(reconcile=reconcile)
    token = coordinator.begin_read("")
    coordinator.record_issue(token, 1, "unsupported_encoding", reconcile=reconcile, path="child-too-long")
    if early_flush:
        coordinator.flush_scan_group()
    coordinator.record_issue(token, 1, "unsupported_encoding", reconcile=reconcile, path="another-child")
    assert index.status().issue_count == 0
    assert not coordinator.issue_details
    coordinator.finish_parent(token, 1, reconcile=reconcile)
    coordinator.flush_scan_group()
    assert index.status().issue_count == 2
    assert coordinator.scan_commits == 1
    assert not coordinator._pending_scan_issues
    assert not coordinator._pending_issue_paths
    assert not coordinator._producers
    assert coordinator.issue_details == {("", "unsupported_encoding")}
    assert coordinator.issue_paths == {("", "unsupported_encoding"): "child-too-long"}


@pytest.mark.parametrize("reconcile", [False, True])
def test_stale_scan_group_discards_parent_issues(index, reconcile):
    from app.services.directory_cache import DirectoryScanCoordinator

    index.prepare_scan()
    index.seed_scan(1)
    if reconcile:
        index.commit_scan_parents(1, [("", [])])
        assert index.finish_generation(1)
        index.queue_observed_parent("")
    coordinator = DirectoryScanCoordinator(index)
    coordinator.start_scan_groups(reconcile=reconcile)
    token = coordinator.begin_read("")
    coordinator.record_issue(token, 1, "unsupported_encoding", reconcile=reconcile, path="child-too-long")
    coordinator.finish_parent(token, 1, reconcile=reconcile)
    _lose_observations(coordinator)
    with pytest.raises(RuntimeError, match="stale"):
        coordinator.flush_scan_group()
    assert index.scan_parent_pending(1, "")
    assert index._connection().execute("SELECT count(*) FROM coverage_issues WHERE code = 'unsupported_encoding'").fetchone() == (0,)
    assert not coordinator._pending_scan_issues
    assert not coordinator._pending_issue_paths
    assert not coordinator.issue_details
    assert not coordinator.issue_paths


@pytest.mark.parametrize("parent_hint", [False, True])
def test_issue_details_remove_deleted_subtree_after_reconciliation(index, parent_hint):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import READ_PARENT_ACTION, DirectoryScanCoordinator, _DirectoryMutation

    index.seed_scan(1)
    coordinator = DirectoryScanCoordinator(index)
    coordinator.start_scan_groups()
    for parent, children in [
        ("", [("private", True), ("private-backup", True)]),
        ("private", [("private/child", True)]),
        ("private/child", []),
        ("private-backup", []),
    ]:
        with coordinator.read(parent) as token:
            coordinator.commit_children(token, 1, children)
            coordinator.record_issue(token, 1, "access_denied")
            coordinator.finish_parent(token, 1)
        coordinator.flush_scan_group()
    coordinator.cancel_scan_groups()
    assert index.finish_generation(1)

    mutation = _DirectoryMutation(READ_PARENT_ACTION, "") if parent_hint else _DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "private")
    assert coordinator.enqueue(mutation)
    coordinator.apply_pending()
    coordinator.start_scan_groups(reconcile=True)
    with coordinator.read("") as token:
        coordinator.commit_children(token, 1, [("private-backup", True)], reconcile=True)
        coordinator.record_issue(token, 1, "access_denied", reconcile=True)
        coordinator.finish_parent(token, 1, reconcile=True)
    coordinator.flush_scan_group()
    coordinator.cancel_scan_groups()

    assert not index.search("private/child").results
    assert coordinator.issue_details == {("", "access_denied"), ("private-backup", "access_denied")}


def test_issue_details_preserved_when_subtree_deletion_rolls_back(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    index.write_paths(["private", "private/child"])
    assert index.finish_generation(1)
    coordinator = DirectoryScanCoordinator(index)
    coordinator._publish_issue_details("private", {"access_denied": 1})
    coordinator._publish_issue_details("private/child", {"access_denied": 1})
    samples = coordinator.issue_details.copy()
    index._connection().execute(
        "CREATE TRIGGER reject_sample_deletion BEFORE DELETE ON directories "
        "WHEN OLD.path = 'private' BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END"
    )
    assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "private"))
    with pytest.raises(sqlite3.IntegrityError, match="injected deletion failure"):
        coordinator.apply_pending()
    assert coordinator.issue_details == samples
    assert index.contains_directory(1, "private/child")
    assert coordinator.pending
    index._connection().execute("DROP TRIGGER reject_sample_deletion")
    coordinator.apply_pending()
    assert not coordinator.issue_details


def test_issue_detail_samples_are_bounded_and_replaced_by_clean_reads(index):
    from app.services.directory_cache import MAX_LOGGED_SCAN_ISSUES_PER_PASS, DirectoryScanCoordinator

    coordinator = DirectoryScanCoordinator(index)
    for number in range(MAX_LOGGED_SCAN_ISSUES_PER_PASS + 1):
        coordinator._publish_issue_details(f"parent-{number}", {"access_denied": 1})
    assert len(coordinator.issue_details) == MAX_LOGGED_SCAN_ISSUES_PER_PASS
    assert coordinator.issue_details_incomplete
    coordinator._publish_issue_details("parent-0", {})
    assert not any(parent == "parent-0" for parent, _code in coordinator.issue_details)
    coordinator._publish_issue_details("parent-1", {"scan_failed": 1})
    assert ("parent-1", "scan_failed") in coordinator.issue_details
    assert ("parent-1", "access_denied") not in coordinator.issue_details


def test_reconciliation_groups_independent_pages(smb_source_cache, smb_directory_server, monkeypatch):
    from unittest.mock import Mock

    from app.services import directory_cache
    from app.services.directory_index import ROW_BATCH_SIZE

    parent_count = ROW_BATCH_SIZE + 1
    parents = [f"parent-{number}" for number in range(parent_count)]
    smb_directory_server.directories = {"": [("base", 16)], "base": [(parent, 16) for parent in parents]}
    smb_directory_server.directories.update({"base\\" + parent: [] for parent in parents})
    smb_source_cache._scan_disk_queue()
    index = smb_source_cache.index
    for parent in parents:
        index.queue_observed_parent(parent)
    jobs = Mock(wraps=index.pending_scan_jobs)
    single_identity = Mock(wraps=index.scan_parent_file_id)
    monkeypatch.setattr(index, "pending_scan_jobs", jobs)
    monkeypatch.setattr(index, "scan_parent_file_id", single_identity)
    monkeypatch.setattr(directory_cache.time, "monotonic", lambda: smb_source_cache._last_access)
    smb_source_cache._reconcile_disk_queue()
    completion_checks = 2
    assert jobs.call_count == (parent_count + ROW_BATCH_SIZE - 1) // ROW_BATCH_SIZE + completion_checks
    single_identity.assert_not_called()
    assert smb_source_cache.coordinator.scan_commits == 1
    assert not index.pending_scan_paths(1)
    assert index.status().directory_count == parent_count
    assert not smb_source_cache.coordinator._producers
    assert smb_source_cache.coordinator._scan_group is None
    assert not smb_source_cache.coordinator._scan_group_reconcile
    assert not smb_source_cache._scan_job_file_ids


def test_streamed_snapshot_final_failure_rolls_back_deletion(index):
    index.seed_scan(1)
    index.commit_scan_parents(1, [("", [("parent", True)])])
    index.commit_scan_parents(1, [("parent", [("parent/old", True)])])
    index.defer_scan_parent(1, "parent")
    index.write_scan_parent_batch(1, "parent", [("parent/new", True)], reset_snapshot=True)
    index._connection().execute(
        "CREATE TEMP TRIGGER reject_completion BEFORE UPDATE ON scan_queue WHEN new.path = 'parent' BEGIN SELECT RAISE(ABORT, 'completion rejected'); END"
    )
    with pytest.raises(sqlite3.IntegrityError, match="completion rejected"):
        index.commit_scan_parents(1, [("parent", [])], streamed_parents={"parent"})
    assert index.search("parent/old").total_matches == 1
    assert index._connection().execute("SELECT count(*) FROM scan_snapshot_children").fetchone() == (1,)
    assert "parent" in index.pending_scan_paths(1)


def test_shared_scan_tree_fixtures(smb_source_cache, smb_directory_server):
    fixtures_path = Path(__file__).resolve().parents[2] / "shared" / "directory-index" / "search-fixtures.json"
    fixtures = json.loads(fixtures_path.read_text(encoding="utf-8"))["scan_trees"]
    for fixture in fixtures:
        for paths in fixture["passes"]:
            directories = {"": [("base", 16)], "base": []}
            for path in paths:
                parent, _, name = path.rpartition("/")
                native_parent = "base" + ("\\" + parent.replace("/", "\\") if parent else "")
                directories[native_parent].append((name, 16))
                directories["base\\" + path.replace("/", "\\")] = []
            smb_directory_server.directories = directories
            for _ in range(2):
                smb_source_cache._scan_disk_queue()
                result = smb_source_cache.index.search("tree")
                assert sorted(row.path for row in result.results) == sorted(paths), fixture["name"]
                assert result.directory_count == result.total_matches == len(paths)
                assert result.coverage == "complete"
                assert smb_source_cache.index._connection().execute("SELECT count(*) FROM generations").fetchone()[0] == 1


def test_streamed_scanner_snapshots_do_not_use_separate_pruning(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    from app.services.directory_index import ROW_BATCH_SIZE

    children = [f"child-{number}" for number in range(ROW_BATCH_SIZE + 1)]
    nodes = {"": ["parent"], "parent": children}

    def scan(path, **kwargs):
        relative = path[len(sqlite_cache._smb_base_path) :].strip("\\").replace("\\", "/")
        for name in nodes.get(relative, []):
            yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    def unexpected_prune(*args, **kwargs):
        pytest.fail("A streamed snapshot must use the transactional parent diff.")

    monkeypatch.setattr("smbclient.scandir", scan)
    monkeypatch.setattr("app.services.directory_cache.MAX_OBSERVATION_BYTES", 512)
    monkeypatch.setattr(sqlite_cache.index, "direct_child_paths", unexpected_prune)
    monkeypatch.setattr(sqlite_cache.index, "prune_subtree_batch", unexpected_prune)
    sqlite_cache._scan_disk_queue()
    nodes["parent"] = children[1:] + ["new"]
    sqlite_cache._scan_disk_queue()
    assert sqlite_cache.index.search("parent/child-0").total_matches == 0
    assert sqlite_cache.index.search("parent/child-1").total_matches > 0
    assert sqlite_cache.index.search("parent/new").total_matches == 1
    assert sqlite_cache.index.status().coverage == "complete"
    assert sqlite_cache.index._connection().execute("SELECT count(*) FROM scan_snapshot_children").fetchone() == (0,)


def test_complete_scanner_snapshots_do_not_use_separate_pruning(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    nodes = {"": ["parent"], "parent": ["old"], "parent/old": []}

    def scan(path, **kwargs):
        relative = path[len(sqlite_cache._smb_base_path) :].strip("\\").replace("\\", "/")
        for name in nodes.get(relative, []):
            yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    def unexpected_prune(*args, **kwargs):
        pytest.fail("A complete buffered snapshot must use the transactional parent diff.")

    monkeypatch.setattr("smbclient.scandir", scan)
    monkeypatch.setattr(sqlite_cache.index, "direct_child_paths", unexpected_prune)
    monkeypatch.setattr(sqlite_cache.index, "prune_subtree_batch", unexpected_prune)
    sqlite_cache._scan_disk_queue()
    assert sqlite_cache.index.search("parent/old").total_matches == 1
    nodes["parent"] = ["new"]
    sqlite_cache._scan_disk_queue()
    assert sqlite_cache.index.search("parent/old").total_matches == 0
    assert sqlite_cache.index.search("parent/new").total_matches == 1
    assert sqlite_cache.index.status().coverage == "complete"


def test_empty_parents_share_bookkeeping_commits(index, monkeypatch):
    from app.services.directory_cache import DirectoryScanCoordinator
    from app.services.directory_index import ROW_BATCH_SIZE

    parents = [f"empty-{number}" for number in range(10_000)]
    index.seed_scan(1)
    for offset in range(0, len(parents), ROW_BATCH_SIZE):
        index.write_scan_children(1, [(parent, True) for parent in parents[offset : offset + ROW_BATCH_SIZE]])
    index.finish_scan_parent(1, "")
    monkeypatch.setattr("app.services.directory_cache.time.monotonic", lambda: 0.0)
    coordinator = DirectoryScanCoordinator(index)
    coordinator.start_scan_groups()
    seen = []
    while page := index.pending_scan_paths(1, exclude=coordinator.buffered_scan_parents(1)):
        for parent in page:
            with coordinator.read(parent) as token:
                coordinator.finish_parent(token, 1)
            seen.append(parent)
    coordinator.flush_scan_group()
    assert seen == parents
    assert 1 <= coordinator.scan_commits <= 2
    assert not coordinator._producers
    assert not index.pending_scan_paths(1)


def test_content_group_commits_at_parent_cap(index, monkeypatch):
    from app.services.directory_cache import DirectoryScanCoordinator
    from app.services.directory_index import SCAN_COMMIT_MAX_PARENTS

    parents = [f"parent-{number}" for number in range(SCAN_COMMIT_MAX_PARENTS)]
    index.write_paths(parents)
    monkeypatch.setattr("app.services.directory_cache.time.monotonic", lambda: 0.0)
    coordinator = DirectoryScanCoordinator(index)
    coordinator.start_scan_groups()
    for parent in parents:
        with coordinator.read(parent) as token:
            coordinator.commit_children(token, 1, [(parent + "/child", True)])
            coordinator.finish_parent(token, 1)
    assert coordinator.scan_commits == 1
    assert not coordinator._scan_group
    assert index.search("child").total_matches == SCAN_COMMIT_MAX_PARENTS


@pytest.mark.parametrize("content", [False, True])
def test_group_interval_starts_at_first_parent(index, monkeypatch, content):
    from app.services.directory_cache import DirectoryScanCoordinator
    from app.services.directory_index import SCAN_BOOKKEEPING_COMMIT_INTERVAL_SECONDS, SCAN_COMMIT_INTERVAL_SECONDS

    clock = [0.0]
    monkeypatch.setattr("app.services.directory_cache.time.monotonic", lambda: clock[0])
    coordinator = DirectoryScanCoordinator(index)
    coordinator.start_scan_groups()
    clock[0] = 10.0
    with coordinator.read("") as token:
        if content:
            coordinator.commit_children(token, 1, [("child", True)])
        coordinator.finish_parent(token, 1)
    assert coordinator.scan_commits == 0
    interval = SCAN_COMMIT_INTERVAL_SECONDS if content else SCAN_BOOKKEEPING_COMMIT_INTERVAL_SECONDS
    clock[0] += interval
    coordinator.flush_scan_group_if_due()
    assert coordinator.scan_commits == 1


def test_bookkeeping_group_commits_at_byte_bound(index, monkeypatch):
    from app.services.directory_cache import DirectoryScanCoordinator

    parents = ["empty-parent-one", "empty-parent-two"]
    index.write_paths(parents)
    monkeypatch.setattr("app.services.directory_cache.time.monotonic", lambda: 0.0)
    monkeypatch.setattr("app.services.directory_cache.MAX_OBSERVATION_BYTES", len(parents[0].encode()))
    coordinator = DirectoryScanCoordinator(index)
    coordinator.start_scan_groups()
    for parent in parents:
        with coordinator.read(parent) as token:
            coordinator.finish_parent(token, 1)
    assert coordinator.scan_commits == 2
    assert not coordinator._producers


def test_content_commit_cannot_use_bookkeeping_parent_cap(index):
    from app.services.directory_index import SCAN_COMMIT_MAX_PARENTS

    parents = [f"parent-{number}" for number in range(SCAN_COMMIT_MAX_PARENTS + 1)]
    index.write_paths(parents)
    results = [(parent, [(parent + "/child", True)]) for parent in parents]
    assert index.scan_parents_have_changes(1, results)
    with pytest.raises(ValueError, match="Content scan commit"):
        index.commit_scan_parents(1, results)
    assert index.search("child").total_matches == 0


def test_clean_shutdown_controls_integrity_checks(index, monkeypatch):
    index.write_paths(["retained"])
    index.close()
    statements = []
    connect = index._connect

    def traced(*, readonly=False):
        connection = connect(readonly=readonly)
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(index, "_connect", traced)
    index.open()
    assert not any("quick_check" in statement or "integrity-check" in statement for statement in statements)
    assert index._connection().execute("SELECT clean_shutdown FROM source_metadata").fetchone() == (0,)
    index._connection().execute("BEGIN")
    index.close()
    statements.clear()
    index.open()
    assert any("quick_check" in statement for statement in statements)
    assert any("integrity-check" in statement for statement in statements)
    assert index.search("retained").total_matches == 1


@pytest.mark.parametrize("scanner", ["store", "smb", "streamed-smb"])
def test_unchanged_live_pass_has_no_content_writes(index, smb_source_cache, smb_directory_server, scanner, monkeypatch):
    from app.services import directory_cache
    from app.services.directory_index import ROW_BATCH_SIZE

    streamed = scanner == "streamed-smb"
    scanner = scanner != "store"
    expected_metadata_writes = 5
    expected_parents = 3
    if scanner:
        index = smb_source_cache.index
        smb_directory_server.directories = {
            "": [("base", 16)],
            "base": [("parent", 16)],
            "base\\parent": [("child", 16)],
            "base\\parent\\child": [],
        }
        if streamed:
            STREAM_GROUP_BYTES = 512
            monkeypatch.setattr(directory_cache, "MAX_OBSERVATION_BYTES", STREAM_GROUP_BYTES)
            children = [(f"child-{number}", 16) for number in range(ROW_BATCH_SIZE + 1)]
            smb_directory_server.directories["base\\parent"] = children
            for name, _attributes in children:
                smb_directory_server.directories["base\\parent\\" + name] = []
            expected_parents = len(children) + 2
        smb_source_cache._scan_disk_queue()
    else:
        index.prepare_scan()
        index.seed_scan(1)
        index.commit_scan_parents(1, [("", [("parent", True)])])
        index.commit_scan_parents(1, [("parent", [("parent/child", True)])])
        index.commit_scan_parents(1, [("parent/child", [])])
        assert index.finish_generation(1)
    connection = index._connection()
    connection.execute("CREATE TEMP TABLE content_writes(count INTEGER)")
    connection.execute("INSERT INTO content_writes VALUES (0)")
    connection.execute("CREATE TEMP TABLE queue_writes(count INTEGER)")
    connection.execute("INSERT INTO queue_writes VALUES (0)")
    connection.execute("CREATE TEMP TABLE metadata_writes(count INTEGER)")
    connection.execute("INSERT INTO metadata_writes VALUES (0)")
    connection.execute("CREATE TEMP TABLE snapshot_writes(count INTEGER)")
    connection.execute("INSERT INTO snapshot_writes VALUES (0)")
    connection.execute(
        "CREATE TEMP TRIGGER count_snapshot_insert AFTER INSERT ON scan_snapshot_children BEGIN UPDATE snapshot_writes SET count = count + 1; END"
    )
    shadows = ("directory_fts_data", "directory_fts_idx", "directory_fts_docsize", "directory_fts_config")
    shadow_rows = [connection.execute(f"SELECT count(*) FROM {table}").fetchone() for table in shadows]
    for operation in ("INSERT", "UPDATE", "DELETE"):
        connection.execute(
            f"CREATE TEMP TRIGGER count_content_{operation} AFTER {operation} ON directories BEGIN UPDATE content_writes SET count = count + 1; END"
        )
        connection.execute(
            f"CREATE TEMP TRIGGER count_queue_{operation} AFTER {operation} ON scan_queue BEGIN UPDATE queue_writes SET count = count + 1; END"
        )
        for table in ("generations", "source_metadata"):
            connection.execute(
                f"CREATE TEMP TRIGGER count_{table}_{operation} AFTER {operation} ON {table} BEGIN UPDATE metadata_writes SET count = count + 1; END"
            )
    if scanner:
        smb_source_cache._scan_disk_queue()
    else:
        assert index.prepare_scan() == (1, False)
        assert index.accepted_generation() is None
        index.seed_scan(1)
        index.commit_scan_parents(1, [("", [("parent", True)])])
        index.commit_scan_parents(1, [("parent", [("parent/child", True)])])
        index.commit_scan_parents(1, [("parent/child", [])])
        assert index.finish_generation(1)
    assert connection.execute("SELECT count FROM content_writes").fetchone() == (0,)
    assert connection.execute("SELECT count FROM queue_writes").fetchone() == (expected_parents * 2,)
    assert connection.execute("SELECT count FROM metadata_writes").fetchone() == (expected_metadata_writes,)
    assert [connection.execute(f"SELECT count(*) FROM {table}").fetchone() for table in shadows] == shadow_rows
    assert connection.execute("SELECT count(*), max(scan_pass_id) FROM generations").fetchone() == (1, 2)
    assert index.accepted_generation() == 1
    if streamed:
        assert connection.execute("SELECT count FROM snapshot_writes").fetchone()[0] > 0
        assert connection.execute("SELECT count(*) FROM scan_snapshot_children").fetchone() == (0,)


def test_unresolved_issue_rows_cannot_be_selected_as_complete(index):
    index.write_paths(["partial"])
    index.mark_uncertain()
    assert not index.finish_generation(1)
    response = index.search("partial")
    assert response.coverage == "uncertain"
    assert response.issue_count == 1
    generation, selected = index.prepare_scan()
    assert selected
    assert generation == 1


def test_failed_generation_issue_count_agrees_with_issue_rows(index):
    assert index.finish_generation(1, issue_count=3)
    with index._writer_lock:
        aggregate = index._connection().execute("SELECT sum(count) FROM coverage_issues WHERE generation_id = 1").fetchone()[0]
    assert index.status().issue_count == aggregate == 3


@pytest.mark.parametrize("direct_exception", [False, True])
def test_watcher_notify_overflow_requests_verification(sqlite_cache, monkeypatch, direct_exception):
    from smbprotocol.change_notify import FileSystemWatcher
    from smbprotocol.header import NtStatus

    index = sqlite_cache.index
    index.write_paths(["accepted", "accepted/child"])
    assert index.finish_generation(1)
    before = index.search("accepted")
    sqlite_cache.coordinator.verification_required = False
    calls = []

    def receive(request):
        if not request.cancelled:
            raise _smb_response_error(NtStatus.STATUS_NOTIFY_ENUM_DIR)

    def start(watcher, **kwargs):
        calls.append(kwargs)
        if direct_exception and len(calls) <= 2:
            watcher._t_exc = _smb_response_error(NtStatus.STATUS_NOTIFY_ENUM_DIR)
        request = SimpleNamespace(
            cancelled=len(calls) > 2,
            response={"status": SimpleNamespace(get_value=lambda: NtStatus.STATUS_NOTIFY_ENUM_DIR)},
        )
        watcher._start_response(request)

    monkeypatch.setattr(FileSystemWatcher, "start", start)
    monkeypatch.setattr(sqlite_cache, "_watcher_open", SimpleNamespace(connection=SimpleNamespace(receive=receive), file_name=""))
    with sqlite_cache.coordinator.read("accepted") as token:
        with pytest.raises(ConnectionError, match="observation stopped unexpectedly"):
            sqlite_cache._run_watcher_inner()
        assert not sqlite_cache.coordinator.is_current(token)
        assert sqlite_cache.coordinator.verification_required
        assert len(sqlite_cache.coordinator._producers) == 1
    sqlite_cache.coordinator.apply_pending()
    response = index.search("accepted")
    assert [row.path for row in response.results] == [row.path for row in before.results]
    assert response.coverage == "uncertain"
    assert response.issue_count == 1
    assert response.last_verified_at_ms == before.last_verified_at_ms
    assert sqlite_cache.scan_error is not None
    assert len(calls) == 3
    assert not sqlite_cache.coordinator._producers
    monkeypatch.setattr(sqlite_cache, "_watcher_open", None)

    from smbclient._os import FileAttributes

    def scan(path, **kwargs):
        relative = path[len(sqlite_cache._smb_base_path) :].lstrip("\\").replace("\\", "/")
        for name in {"": ["accepted"], "accepted": ["child"]}.get(relative, []):
            yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._scan_disk_queue()
    recovered = index.search("accepted")
    assert [row.path for row in recovered.results] == [row.path for row in before.results]
    assert recovered.coverage == "complete"
    assert recovered.issue_count == 0
    assert not sqlite_cache.coordinator.verification_required
    assert sqlite_cache.scan_error is None


def test_watcher_shutdown_does_not_report_observation_loss(sqlite_cache, monkeypatch):
    sqlite_cache.index.write_paths(["accepted"])
    assert sqlite_cache.index.finish_generation(1)
    before = sqlite_cache.index.search("accepted")
    sqlite_cache.coordinator.verification_required = False
    sqlite_cache._watcher_ready.set()

    def wait():
        sqlite_cache._stop_event.set()
        return None

    monkeypatch.setattr(sqlite_cache, "_watcher_open", object())
    monkeypatch.setattr(
        "app.services.directory_cache.FileSystemWatcher", lambda _handle: SimpleNamespace(start=lambda **kwargs: None, wait=wait)
    )
    sqlite_cache._run_watcher_inner()
    sqlite_cache.coordinator.apply_pending()
    assert sqlite_cache.index.search("accepted") == before
    assert not sqlite_cache.coordinator.verification_required
    assert sqlite_cache.scan_error is None
    monkeypatch.setattr(sqlite_cache, "_watcher_open", None)


def test_sqlite_source_watcher_gap_invalidates_scan_and_coverage(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    sqlite_cache.index.write_paths(["accepted"])
    assert sqlite_cache.index.finish_generation(1)
    token = sqlite_cache.coordinator.begin_read("accepted")
    sqlite_cache._observation_lost()
    assert not sqlite_cache.coordinator.is_current(token)
    sqlite_cache.coordinator.apply_pending()
    response = sqlite_cache.search_index("accepted")
    assert response.coverage == "uncertain"
    assert response.total_matches == 1
    assert sqlite_cache.scan_error is not None
    sqlite_cache.coordinator.end_read(token)
    for _ in range(3):
        sqlite_cache._observation_lost()
        sqlite_cache.coordinator.apply_pending()
        assert sqlite_cache.search_index("accepted") == response

    def scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            yield SimpleNamespace(name="accepted", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    monkeypatch.setattr("smbclient.scandir", scan)
    sqlite_cache._scan_disk_queue()
    recovered = sqlite_cache.search_index("accepted")
    assert recovered.coverage == "complete"
    assert recovered.issue_count == 0
    assert not sqlite_cache.coordinator.verification_required
    assert "monitoring is unavailable" in sqlite_cache.scan_error
    sqlite_cache._watcher_ready.set()
    sqlite_cache._scan_disk_queue()
    assert sqlite_cache.scan_error is None
    recovered = sqlite_cache.search_index("accepted")
    sqlite_cache._observation_lost()
    sqlite_cache.coordinator.apply_pending()
    lost_again = sqlite_cache.search_index("accepted")
    assert lost_again.coverage == "uncertain"
    assert lost_again.issue_count == 1
    assert lost_again.accepted_revision > recovered.accepted_revision
    assert lost_again.last_verified_at_ms == recovered.last_verified_at_ms


def test_sqlite_source_bounds_batch_bytes_without_limiting_coverage(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    sizes = []
    original_commit = sqlite_cache.coordinator.commit_children

    def commit(token, generation, batch, *, reconcile=False, file_ids=None):
        sizes.append(sum(len(path.encode("utf-8")) for path, _descend in batch))
        original_commit(token, generation, batch, reconcile=reconcile, file_ids=file_ids)

    def scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            for name in ("alpha", "beta", "gamma"):
                yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    monkeypatch.setattr("app.services.directory_cache.MAX_OBSERVATION_BYTES", 9)
    monkeypatch.setattr("smbclient.scandir", scan)
    monkeypatch.setattr(sqlite_cache.coordinator, "commit_children", commit)
    sqlite_cache._scan_disk_queue()
    assert sizes == [9, 5]
    assert sqlite_cache.search_index("alpha beta gamma").total_matches == 3


def test_rename_barriers_cannot_exceed_observation_limit(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index, maximum_pending=1)
    baseline = coordinator.begin_read("")
    assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_RENAMED_NEW_NAME, "alpha", "beta"))
    assert len(coordinator.barriers) <= coordinator.maximum_pending
    assert not coordinator.is_current(baseline)


def test_subtree_mutations_update_pending_scan_paths_transactionally(index):
    index.seed_scan(1)
    index.write_scan_children(1, [("alpha", True), ("alpha/child", True), ("other", True)])
    index.finish_scan_parent(1, "alpha")
    index.mutate_path("rename", "alpha", "beta")
    assert index.pending_scan_paths(1) == ["", "beta", "beta/child", "other"]
    index.mutate_path("remove", "beta")
    assert index.pending_scan_paths(1) == ["", "other"]
    assert index.search("alpha beta").total_matches == 0


def test_scan_queue_rename_collision_rolls_back_directory_changes(index):
    index.seed_scan(1)
    index.write_scan_children(1, [("alpha", True), ("occupied", True)])
    index.mutate_path("remove", "occupied")
    with index._writer_lock, index._connection() as connection:
        connection.execute("INSERT INTO scan_queue(generation_id, path) VALUES (1, 'occupied')")
    revision = index.status().accepted_revision
    with pytest.raises(sqlite3.IntegrityError):
        index.mutate_path("rename", "alpha", "occupied")
    assert index.search("alpha").total_matches == 1
    assert index.search("occupied").total_matches == 0
    assert index.pending_scan_paths(1) == ["", "alpha", "occupied"]
    assert index.status().accepted_revision == revision


def test_pending_work_blocks_complete_generation_and_unbounded_batches(index):
    from itertools import count

    from app.services.directory_index import ROW_BATCH_SIZE

    index.seed_scan(1)
    with pytest.raises(ValueError, match="work remains queued"):
        index.finish_generation(1)
    observed = []

    def children():
        for number in count():
            observed.append(number)
            yield f"directory{number}", True

    with pytest.raises(ValueError):
        index.write_scan_children(1, children())
    assert len(observed) == ROW_BATCH_SIZE + 1
    assert index.search("").directory_count == 0
    index.finish_scan_parent(1, "")
    assert index.finish_generation(1)


def test_close_retains_process_lease_until_readers_exit(index, monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    closed = threading.Event()
    original_connect = index._connect

    def connect(*, readonly=False):
        if readonly:
            entered.set()
            assert release.wait(timeout=5)
        return original_connect(readonly=readonly)

    def close():
        index.close()
        closed.set()

    monkeypatch.setattr(index, "_connect", connect)
    with ThreadPoolExecutor(max_workers=2) as executor:
        query = executor.submit(index.search, "alpha")
        try:
            assert entered.wait(timeout=5)
            shutdown = executor.submit(close)
            assert not closed.wait(timeout=0.1)
            competing = DirectoryIndex(index.path, source_kind=index.source_kind, source_identity=json.loads(index.source_identity))
            with pytest.raises(BlockingIOError):
                competing.open()
        finally:
            release.set()
        assert query.result(timeout=5).total_matches == 0
        shutdown.result(timeout=5)
    assert closed.is_set()


@pytest.fixture
def database(tmp_path):
    with closing(sqlite3.connect(tmp_path / "index.sqlite3")) as connection:
        connection.executescript((CONTRACT_ROOT / "schema.sql").read_text())
        connection.executescript((CONTRACT_ROOT / "fts.sql").read_text())
        connection.execute("INSERT INTO generations(id, state, coverage) VALUES (1, 'building', 'partial')")
        connection.commit()
        yield connection


def insert_directory(database, path):
    database.execute(
        "INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) VALUES (1, ?, ?, ?, ?, 0)",
        (path, path, path.rsplit("/", 1)[-1], path.count("/")),
    )


def test_schema_identifiers_and_fts(database):
    assert database.execute("PRAGMA application_id").fetchone()[0] == APPLICATION_ID
    assert database.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert database.execute("PRAGMA auto_vacuum").fetchone()[0] == 2
    insert_directory(database, "alpha/beta")
    assert database.execute("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH ?", ('"alpha" OR "beta"',)).fetchone()[0] == 1


def test_fts_counts_and_rollback(database):
    insert_directory(database, "alpha")
    database.commit()
    with pytest.raises(RuntimeError), database:
        database.execute("UPDATE directories SET path = 'beta', path_key = 'beta' WHERE path = 'alpha'")
        raise RuntimeError("injected failure")
    assert database.execute("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH 'alpha'").fetchone()[0] == 1
    assert database.execute("SELECT indexed_count FROM generations").fetchone()[0] == 1
    with database:
        database.execute("DELETE FROM generations WHERE id = 1")
    assert database.execute("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH 'alpha'").fetchone()[0] == 0


@pytest.mark.parametrize("path", ["", "/alpha", "alpha/", "a//b", "a/./b", "a/../b", "a\x00b"])
def test_invalid_paths(database, path):
    with pytest.raises(sqlite3.IntegrityError):
        insert_directory(database, path)


@pytest.fixture
def index(tmp_path):
    store = DirectoryIndex(tmp_path / "source.sqlite3", source_kind="smb", source_identity={"connection_id": "test", "host": "test"})
    store.open()
    try:
        yield store
    finally:
        store.close()


def test_shared_normalization_and_terms():
    fixtures = json.loads((CONTRACT_ROOT / "search-fixtures.json").read_text())
    for case in fixtures["normalization"]:
        assert normalize_search_text(case["input"]) == case["expected"]
    for case in fixtures["queries"]:
        assert search_terms(case["query"]) == tuple(sorted(case["terms"]))


def test_shared_search_scan_and_fts_parity(index):
    fixtures = json.loads((CONTRACT_ROOT / "search-fixtures.json").read_text())
    index.write_paths(fixtures["paths"])
    for case in fixtures["searches"]:
        for force_scan in (False, True):
            response = index.search(case["query"], include_dot_directories=case["include_dot"], force_scan=force_scan)
            assert response.total_matches == case["count"]
            assert [row.path for row in response.results] == case["results"]
    from app.services.directory_index import ROW_BATCH_SIZE

    index.write_paths(f"single/{number}/needleone" for number in range(ROW_BATCH_SIZE))
    index.write_paths(["last/needleone-needletwo"])
    for force_scan in (False, True):
        response = index.search("needleone needletwo", limit=1, force_scan=force_scan)
        assert response.total_matches == ROW_BATCH_SIZE + 1
        assert [row.path for row in response.results] == ["last/needleone-needletwo"]
        assert response.results[0].matched_term_count == 2


def test_pending_scan_reads_do_not_walk_processed_prefix_or_sort_pending_jobs(index):
    from app.services.directory_index import ROW_BATCH_SIZE, transaction

    connection = index._connection()
    with transaction(connection):
        connection.executemany(
            "INSERT INTO scan_queue(generation_id, path, processed) VALUES (1, ?, 1)",
            ((f"done-{number:06d}",) for number in range(ROW_BATCH_SIZE * 32)),
        )
        connection.executemany(
            "INSERT INTO scan_queue(generation_id, path, processed) VALUES (1, ?, 0)",
            ((f"pending-{number:06d}",) for number in range(ROW_BATCH_SIZE)),
        )
    steps = 0

    def observe_step():
        nonlocal steps
        steps += 1
        return False

    connection.set_progress_handler(observe_step, 1)
    try:
        assert index.pending_scan_paths(1, limit=1) == ["pending-000000"]
    finally:
        connection.set_progress_handler(None, 0)
    assert steps < ROW_BATCH_SIZE


def test_source_kind_and_identity_must_match(index):
    index.close()
    other = DirectoryIndex(index.path, source_kind="local", source_identity={"connection_id": "test", "host": "test"})
    with pytest.raises(ValueError, match="source or policy"):
        other.open()
    with pytest.raises(RuntimeError, match="not initialized"):
        other.search("alpha")


def test_late_scan_cannot_write_completed_generation(index):
    index.write_paths(["alpha"])
    index.finish_generation(1)
    with pytest.raises(ValueError, match="no longer active"):
        index.write_paths(["late/alpha"], generation_id=1)
    assert index.search("alpha").total_matches == 1


def test_integer_overflow_rolls_back(database):
    with database:
        database.execute("UPDATE generations SET indexed_count = ?", ((1 << 63) - 1,))
    with pytest.raises(sqlite3.IntegrityError), database:
        insert_directory(database, "alpha")
    assert database.execute("SELECT count(*) FROM directories").fetchone()[0] == 0


def test_literal_operators_and_colliding_keys(index):
    index.write_paths(['a%/_*/"quoted"', "Straße", "STRASSE"])
    assert index.search('a% _* "quoted"').total_matches == 1
    assert index.search("strasse").total_matches == 2


def test_cancelled_query_has_no_success_response(index):
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(InterruptedError):
        index.search("alpha", cancelled=cancelled)


def test_input_limits_are_not_silent():
    with pytest.raises(ValueError, match="UTF-8 bytes"):
        search_terms("x" * (MAX_QUERY_BYTES + 1))
    with pytest.raises(ValueError, match="distinct terms"):
        search_terms(" ".join(f"term{number}" for number in range(MAX_QUERY_TERMS + 1)))


@pytest.mark.parametrize(
    "count",
    [
        100_001,
        pytest.param(
            1_000_001,
            marks=pytest.mark.skipif(
                os.environ.get("DIRECTORY_INDEX_CAPACITY_TEST") != "1",
                reason="Set DIRECTORY_INDEX_CAPACITY_TEST=1 to run the separate million-path capacity check.",
            ),
        ),
    ],
)
def test_coverage_above_old_cutoff_and_bounded_results(index, count):
    index.write_paths(f"directory-{number:06d}" for number in range(count))
    managed_bytes = sum(path.stat().st_size for path in index.path.parent.iterdir() if path.is_file())
    print(f"directory_index_fixture rows={count} managed_bytes={managed_bytes}")
    for query in ["directory", "ry"]:
        response = index.search(query, limit=3)
        assert response.directory_count == response.total_matches == count
        assert len(response.results) == 3
    assert index.search("100000").results[0].path == "directory-100000"
    remaining_matches = sum("100000" in f"directory-{number:06d}" for number in range(count)) - 1
    assert index.finish_generation(1)
    verified = index.search("").last_verified_at_ms
    candidate = index.prepare_scan()[0]
    index.write_paths((f"directory-{number:06d}" for number in range(count)), generation_id=candidate)
    assert index.search("directory").directory_count == count
    index.mutate_path("rename", "directory-100000", "directory-updated")
    assert index.search("100000").total_matches == remaining_matches
    assert index.search("updated").results[0].path == "directory-updated"
    assert index.search("").last_verified_at_ms == verified
    assert index.finish_generation(candidate)
    index.close()
    index.open()
    assert index.search("directory").directory_count == index.search("directory").total_matches == count
    assert index.search("100000").total_matches == remaining_matches
    assert index.search("updated").results[0].path == "directory-updated"


@pytest.mark.skipif(
    os.environ.get("DIRECTORY_INDEX_HEADROOM_MEASUREMENT") != "1" or not Path("/proc/self/fd").is_dir(),
    reason="Explicit Linux operation-headroom measurement; not part of routine tests.",
)
def test_directory_operation_headroom_measurement(index):
    from app.services.directory_index import transaction
    from app.services.directory_index_resources import WRITE_HEADROOM_BYTES, DirectoryIndexResources

    resources = DirectoryIndexResources(index.path.parent)
    resources.register_source(index.path)
    index.growth_guard = resources.reserve_growth
    peaks = {"managed_bytes": 0, "sql_deleted_bytes": 0, "all_deleted_bytes": 0, "descriptors": 0, "rss_kib": 0}

    def sample():
        peaks["managed_bytes"] = max(peaks["managed_bytes"], resources.usage().managed_bytes)
        sql_deleted = 0
        all_deleted = 0
        descriptors = tuple(Path("/proc/self/fd").iterdir())
        peaks["descriptors"] = max(peaks["descriptors"], len(descriptors))
        for descriptor in descriptors:
            try:
                target = os.readlink(descriptor)
                metadata = descriptor.stat()
            except FileNotFoundError:
                continue
            if target.endswith(" (deleted)") and stat.S_ISREG(metadata.st_mode):
                all_deleted += metadata.st_size
                if "etilqs" in target:
                    sql_deleted += metadata.st_size
        peaks["sql_deleted_bytes"] = max(peaks["sql_deleted_bytes"], sql_deleted)
        peaks["all_deleted_bytes"] = max(peaks["all_deleted_bytes"], all_deleted)
        with Path("/proc/self/status").open() as status:
            rss = next(int(line.split()[1]) for line in status if line.startswith("VmRSS:"))
        peaks["rss_kib"] = max(peaks["rss_kib"], rss)
        return False

    initial_managed = resources.usage().managed_bytes
    sample()
    initial_rss = peaks["rss_kib"]
    index._connection().set_progress_handler(sample, 1000)
    second = DirectoryIndex(index.path.with_name("second.sqlite3"), source_kind="smb", source_identity={"root": "second"})
    try:
        second.open()
        resources.register_source(second.path)
        second.growth_guard = resources.reserve_growth
        second._connection().set_progress_handler(sample, 1000)
        paths = tuple(f"operation/{number:04d}/repeated-token-{number:04d}" for number in range(4096))
        index.write_paths(paths)
        assert index.finish_generation(1)
        second.write_paths(paths)
        assert second.finish_generation(1)
        sample()
        with closing(index._connect(readonly=True)) as reader, transaction(reader):
            old_count = reader.execute("SELECT COUNT(*) FROM directories").fetchone()[0]
            candidate = index.prepare_scan()[0]
            index.write_paths(paths, generation_id=candidate)
            index.write_paths(["operation/new"])
            assert reader.execute("SELECT COUNT(*) FROM directories").fetchone() == (old_count,)
            index.checkpoint()
            before = index.search("operation repeated")
            with transaction(index._connection()) as writer:
                writer.execute("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all')")
            index._fts_ready = False
            index._fts_repair_cursor = None
            while index.repair_fts_batch():
                sample()
            assert index.search("operation repeated") == before
            sample()
        assert index.finish_generation(candidate)
        while index.cleanup_retired_batch():
            sample()
        index.reclaim_pages()
        second.close()
        resources.release_source(second.path)
        second._acquire_storage()
        try:
            second._quarantine_owned()
            with resources.reserve_growth(), resources.reserve_growth():
                sample()
                assert resources.usage().reserved_bytes == 2 * WRITE_HEADROOM_BYTES
        finally:
            second._release_storage()
        sample()
        print(
            "DIRECTORY_INDEX_HEADROOM_MEASUREMENT "
            + json.dumps(
                {
                    "rows_per_source": len(paths),
                    "initial_managed_bytes": initial_managed,
                    "initial_rss_kib": initial_rss,
                    "reservation_overlap_bytes": 2 * WRITE_HEADROOM_BYTES,
                    **peaks,
                },
                sort_keys=True,
            ),
            flush=True,
        )
    finally:
        index._connection().set_progress_handler(None, 0)
        second.close()
        resources.release_source(second.path)
        resources.release_source(index.path)


@pytest.mark.skipif(
    os.environ.get("DIRECTORY_INDEX_APPLICATION_MEASUREMENT") != "1",
    reason="Explicit injected application resource measurement; not part of routine tests.",
)
def test_injected_application_capacity_measurement(sqlite_cache, monkeypatch):
    import platform
    import resource

    from smbclient._os import FileAttributes

    count = int(os.environ.get("DIRECTORY_INDEX_MEASURE_COUNT", "100000"))
    assert count >= 100_000
    cache = sqlite_cache
    index = cache.index
    started = time.perf_counter()
    finished = threading.Event()
    first_partial = []
    peaks: dict[str, int] = dict.fromkeys(
        ("rss_kib", "fds", "managed_bytes", "main_bytes", "wal_bytes", "shm_bytes", "producers", "pending"), 0
    )
    failures = []
    metrics = {"rows": count, "python": platform.python_version(), "sqlite": sqlite3.sqlite_version, "host": platform.platform()}

    def rss():
        with Path("/proc/self/status").open() as status:
            return next(int(line.split()[1]) for line in status if line.startswith("VmRSS:"))

    def entries(path, **_kwargs):
        if path == cache._smb_base_path:
            return (
                SimpleNamespace(
                    name=f"directory-{number:06d}", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
                )
                for number in range(count)
            )
        return (entry for entry in ())

    def monitor():
        try:
            while not finished.is_set():
                peaks["rss_kib"] = max(peaks["rss_kib"], rss())
                peaks["fds"] = max(peaks["fds"], len(tuple(Path("/proc/self/fd").iterdir())))
                peaks["managed_bytes"] = max(peaks["managed_bytes"], cache.resources.usage().managed_bytes)
                for key, suffix in (("main_bytes", ""), ("wal_bytes", "-wal"), ("shm_bytes", "-shm")):
                    try:
                        peaks[key] = max(peaks[key], Path(str(index.path) + suffix).stat().st_size)
                    except FileNotFoundError:
                        pass
                with cache.coordinator.lock:
                    peaks["producers"] = max(peaks["producers"], len(cache.coordinator._producers))
                    peaks["pending"] = max(peaks["pending"], len(cache.coordinator.pending))
                if not first_partial:
                    response = cache.search_index("000099", 3)
                    if response.results:
                        first_partial.append(
                            {
                                "seconds": time.perf_counter() - started,
                                "coverage": response.coverage,
                                "directory_count": response.directory_count,
                            }
                        )
                finished.wait(0.1)
        except BaseException as error:
            failures.append(error)

    monkeypatch.setattr("smbclient.scandir", entries)
    sampler = threading.Thread(target=monitor)
    metrics.update(cache_target_kib_per_connection=cache.policy.page_cache_kib, initial_rss_kib=rss())
    sampler.start()
    try:
        cpu = time.process_time()
        begin = time.perf_counter()
        cache._scan_disk_queue()
        metrics.update(build_seconds=time.perf_counter() - begin, build_cpu_seconds=time.process_time() - cpu)
        assert index.status().directory_count == count
        print("DIRECTORY_INDEX_BUILD " + json.dumps(metrics, sort_keys=True), flush=True)
        for label, query in (("common", "directory"), ("mixed_short", "ry 090000")):
            begin = time.perf_counter()
            response = cache.search_index(query, 3)
            metrics[label + "_query_ms"] = (time.perf_counter() - begin) * 1000
            assert response.total_matches == count and len(response.results) == 3
        begin = time.perf_counter()
        with ThreadPoolExecutor(max_workers=1) as executor:
            verification = executor.submit(cache._scan_disk_queue)
            response = cache.search_index("090000", 3)
            metrics["query_during_verification_ms"] = (time.perf_counter() - begin) * 1000
            assert response.directory_count == count and response.total_matches == 1
            verification.result()
        metrics["verification_seconds"] = time.perf_counter() - begin
        cache.apply_policy(cache.policy.model_copy(update={"page_cache_kib": 64}))
        response = cache.search_index("ry 090000", 3)
        assert response.directory_count == response.total_matches == count
        metrics.update(small_cache_count=response.total_matches, small_cache_kib=cache.policy.page_cache_kib)
        metrics["first_partial"] = first_partial
    finally:
        finished.set()
        sampler.join()
        cache.stop()
    assert not failures
    begin = time.perf_counter()
    reopened = DirectoryIndex(index.path, source_kind=index.source_kind, source_identity=json.loads(index.source_identity))
    reopened.open()
    try:
        response = reopened.search("090000", limit=3)
        assert response.directory_count == count
        assert response.total_matches == 1
        metrics["storage_reopen_seconds"] = time.perf_counter() - begin
    finally:
        reopened.close()
    metrics.update(
        sampled_peaks=peaks,
        process_peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        total_seconds=time.perf_counter() - started,
    )
    print("DIRECTORY_INDEX_APPLICATION_MEASUREMENT " + json.dumps(metrics, sort_keys=True), flush=True)


def test_bulk_path_writes_bound_bytes_before_building_row_keys(index, monkeypatch):
    from contextlib import contextmanager

    monkeypatch.setattr("app.services.directory_index.SCAN_BATCH_BYTES", 32)
    counts = []

    @contextmanager
    def observe_batch():
        yield
        counts.append(index._connection().execute("SELECT count(*) FROM directories").fetchone()[0])

    index.growth_guard = observe_batch
    index.write_paths(f"directory-{number:06d}" for number in range(5))
    assert counts == [2, 4, 5]
    with pytest.raises(ValueError, match="scan-batch byte limit"):
        index.write_paths(["x" * 33])
    assert index.search("directory").directory_count == 5


@pytest.mark.parametrize("identifier", [-(1 << 63), -1, 0], ids=["minimum-signed-id", "negative-id", "zero-id"])
def test_rename_includes_nonpositive_row_ids(index, identifier):
    index.write_paths(["alpha", "alpha/child"])
    index._connection().execute("UPDATE directories SET id = ? WHERE path = 'alpha'", (identifier,))
    index.finish_generation(1)
    before = index.search("alpha")

    index.mutate_path("rename", "alpha", "beta")

    after = index.search("beta")
    assert {result.path for result in after.results} == {"beta", "beta/child"}
    assert after.directory_count == after.total_matches == before.directory_count == 2
    assert after.last_verified_at_ms == before.last_verified_at_ms
    assert index.search("alpha").total_matches == 0
    assert index._connection().execute("SELECT id FROM directories WHERE path = 'beta'").fetchone() == (identifier,)


def test_rename_conflict_rolls_back_rows_counts_and_revision(index):
    index.write_paths(["alpha", "beta"])
    before = index.search("alpha beta")
    with pytest.raises(sqlite3.IntegrityError):
        index.mutate_path("rename", "alpha", "beta")
    assert index.search("alpha beta") == before


def test_scan_queue_is_disk_backed_and_deduplicated(index):
    index.seed_scan(1)
    assert index.pending_scan_paths(1) == [""]
    index.write_scan_children(1, [("alpha", True), ("link", False)])
    index.write_scan_children(1, [("alpha", True)])
    index.finish_scan_parent(1, "")
    assert index.pending_scan_paths(1) == ["alpha"]
    index.finish_scan_parent(1, "alpha")
    assert index.pending_scan_paths(1) == []
    assert index.status().directory_count == 2


def test_scan_queue_failure_rolls_back_directory_rows(index):
    index._connection().execute("CREATE TRIGGER fail_queue BEFORE INSERT ON scan_queue BEGIN SELECT RAISE(ABORT, 'injected'); END")
    with pytest.raises(sqlite3.IntegrityError, match="injected"):
        index.write_scan_children(1, [("alpha", True)])
    assert index.search("alpha").total_matches == 0
    assert index.status().accepted_revision == 0


def test_process_lease_prevents_two_writers(index):
    second = DirectoryIndex(index.path, source_kind="smb", source_identity={"connection_id": "test", "host": "test"})
    with pytest.raises(BlockingIOError):
        second.open()
    index.close()
    second.open()
    second.close()


def test_private_storage_rejects_links_and_public_permissions(tmp_path):
    public = tmp_path / "public"
    public.mkdir(mode=0o755)
    store = DirectoryIndex(public / "source.sqlite3", source_kind="local", source_identity={"root": "test"})
    with pytest.raises(PermissionError, match="0700"):
        store.open()
    link = tmp_path / "link"
    link.symlink_to(public, target_is_directory=True)
    store = DirectoryIndex(link / "source.sqlite3", source_kind="local", source_identity={"root": "test"})
    with pytest.raises(PermissionError, match="symbolic"):
        store.open()


def test_open_failure_releases_process_lease(index, monkeypatch):
    index.close()
    with monkeypatch.context() as context:
        context.setattr(index, "_connect", lambda **_kwargs: (_ for _ in ()).throw(sqlite3.OperationalError("injected")))
        with pytest.raises(sqlite3.OperationalError, match="injected"):
            index.open()
    assert index._lease_fd is None
    index.open()
