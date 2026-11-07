"""SQLite directory-cache binding, watcher, manager, and shutdown checks."""

import asyncio
import io
import logging
from dataclasses import replace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from app.core.config import static
from app.core.logging import RecoveryLogFormatter
from app.services.directory_cache import (
    CHANGE_NOTIFY_BUFFER_SIZE,
    MAX_SEARCH_RESULTS,
    SCAN_TIMEOUT_SECONDS,
    CacheState,
    ConnectionDirectoryCache,
    DirectoryCacheManager,
    InvalidationReason,
    SQLiteConnectionDirectoryCache,
    get_directory_cache_manager,
    shutdown_directory_cache,
)

# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture(name="cache")
def cache_fixture(tmp_path, monkeypatch):
    """Create an isolated SQLite source with retained shutdown ownership."""

    monkeypatch.setattr("app.services.directory_cache.settings.directory_cache_location", str(tmp_path / "cache"))
    cache = SQLiteConnectionDirectoryCache(
        connection_id="test-conn-001",
        host="server.local",
        share_name="testshare",
        username="testuser",
        password="testpass",
        port=445,
    )
    yield cache
    cache.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("retained", [False, True])
async def test_initial_verification_waits_for_first_watcher_attempt(cache, monkeypatch, retained):
    cache.index.open()
    if retained:
        cache.index.write_paths(["retained"])
        assert cache.index.finish_generation(1)
    waiting = asyncio.Event()
    scanned = []

    async def wait():
        waiting.set()
        return await original_wait()

    original_wait = cache._wait_for_watcher_startup
    monkeypatch.setattr(cache, "_initialize_storage", lambda: None)
    monkeypatch.setattr(cache, "_start_watcher", lambda: None)
    monkeypatch.setattr(cache, "_wait_for_watcher_startup", wait)
    monkeypatch.setattr(cache, "_run_rescan", AsyncMock(side_effect=lambda: scanned.append(cache.coordinator.epoch)))
    monkeypatch.setattr(cache, "_start_periodic_rescan", lambda: None)
    task = asyncio.create_task(cache._initialize())
    await waiting.wait()
    assert not scanned
    assert not cache._active_workers
    assert cache._manager_scan_slots.acquire(blocking=False)
    cache._manager_scan_slots.release()
    cache.coordinator.invalidate(InvalidationReason.WATCHER_START)
    cache._watcher_ready.set()
    cache._publish_watcher_startup(True)
    await task
    assert scanned == [cache.coordinator.epoch]


@pytest.mark.asyncio
@pytest.mark.parametrize("result", [True, False])
async def test_watcher_startup_result_is_separate_from_current_readiness(cache, result):
    cache._publish_watcher_startup(result)
    cache._watcher_ready.clear()
    assert await cache._wait_for_watcher_startup() is result
    cache._publish_watcher_startup(not result)
    assert await cache._wait_for_watcher_startup() is result


@pytest.mark.asyncio
async def test_watcher_startup_timeout_and_cancellation_leave_no_worker(cache, monkeypatch):
    monkeypatch.setattr("app.services.directory_cache.WATCHER_STARTUP_TIMEOUT_SECONDS", 0)
    assert await cache._wait_for_watcher_startup() is None
    assert cache._active_workers == 0
    monkeypatch.setattr("app.services.directory_cache.WATCHER_STARTUP_TIMEOUT_SECONDS", 30)
    task = asyncio.create_task(cache._wait_for_watcher_startup())
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cache._active_workers == 0
    assert not cache._watcher_startup_waiters


@pytest.mark.parametrize("stage", ["connect", "notify"])
def test_first_watcher_attempt_failure_publishes_fallback(cache, monkeypatch, stage):
    failure = OSError("Injected first notification attempt failure.")
    monkeypatch.setattr(cache, "_connect_watcher", MagicMock(side_effect=failure if stage == "connect" else None))
    if stage == "notify":
        monkeypatch.setattr(cache, "_watcher_open", MagicMock())
        watcher = MagicMock()
        watcher.start.side_effect = failure
        monkeypatch.setattr("app.services.directory_cache.FileSystemWatcher", MagicMock(return_value=watcher))
    monkeypatch.setattr(cache._stop_event, "wait", lambda _delay: True)
    cache._watcher_loop()
    assert cache._watcher_startup_result is False
    assert not cache._watcher_ready.is_set()
    assert cache.coordinator.epoch == 0
    assert not cache.coordinator.observation_lost


def test_first_connection_failure_reports_monitoring_unavailable_not_observation_loss(cache, monkeypatch):
    from app.services.directory_cache import InvalidationReason

    def retry(_delay):
        assert cache._watcher_startup_result is False
        assert cache.monitoring_state == "unavailable"
        assert not cache.coordinator.observation_lost
        assert "monitoring is unavailable" in cache.scan_error
        return True

    monkeypatch.setattr(cache, "_connect_watcher", MagicMock(side_effect=OSError("Injected first connection failure.")))
    monkeypatch.setattr(cache._stop_event, "wait", retry)
    cache._watcher_loop()
    cache._observation_started()
    cache._watcher_ready.set()
    assert cache.coordinator.last_reason == InvalidationReason.WATCHER_START
    assert cache.scan_error is None
    assert cache._watcher_startup_result is False
    cache._observation_started()
    assert cache.coordinator.last_reason == InvalidationReason.OBSERVATION_LOSS
    assert "observations were lost" in cache.scan_error


@pytest.mark.asyncio
async def test_readiness_at_timeout_boundary_uses_completed_result(cache, monkeypatch):
    async def timeout(waiter, _timeout):
        cache._watcher_ready.set()
        cache._publish_watcher_startup(True)
        waiter.cancel()
        raise TimeoutError

    with patch("app.services.directory_cache.asyncio.wait_for", timeout):
        assert await cache._wait_for_watcher_startup() is True
    assert not cache._watcher_startup_waiters


@pytest.mark.asyncio
@pytest.mark.parametrize("stop", [False, True])
async def test_cancel_or_shutdown_during_startup_wait_never_starts_scan(cache, monkeypatch, stop):
    cache.index.open()
    entered = asyncio.Event()
    original = cache._wait_for_watcher_startup

    async def wait():
        entered.set()
        return await original()

    monkeypatch.setattr(cache, "_initialize_storage", lambda: None)
    monkeypatch.setattr(cache, "_start_watcher", lambda: None)
    monkeypatch.setattr(cache, "_wait_for_watcher_startup", wait)
    scan = AsyncMock()
    monkeypatch.setattr(cache, "_run_rescan", scan)
    cache._scan_task = asyncio.create_task(cache._initialize())
    await entered.wait()
    if stop:
        cache._request_stop()
    else:
        cache._scan_task.cancel()
    await cache._scan_task
    scan.assert_not_awaited()
    assert not cache._watcher_startup_waiters
    assert cache._active_workers == 0


def test_watcher_logs_omit_source_identity_and_private_error_text(cache, monkeypatch):
    logger = MagicMock()
    monkeypatch.setattr("app.services.directory_cache.logger", logger)
    private_error = f"{cache.host}/{cache.share_name} {cache.username} {cache.password} private-source-path"
    failure = OSError(private_error)
    monkeypatch.setattr(cache, "_connect_watcher", MagicMock(side_effect=failure))
    monkeypatch.setattr(cache._stop_event, "wait", lambda _delay: True)
    cache._watcher_loop()
    for attribute, method in (
        ("_watcher_open", "close"),
        ("_watcher_tree", "disconnect"),
        ("_watcher_session", "disconnect"),
        ("_watcher_connection", "disconnect"),
    ):
        resource = MagicMock()
        getattr(resource, method).side_effect = failure
        setattr(cache, attribute, resource)
    cache._cleanup_watcher()
    cache.stop()
    logged = repr(logger.mock_calls)
    for private_value in (cache.connection_id, cache.host, cache.share_name, cache.username, cache.password, private_error):
        assert private_value not in logged
    assert "OSError" in logged
    logger.exception.assert_not_called()


@pytest.mark.parametrize("watcher_was_ready", [False, True])
def test_failed_watcher_retries_preserve_fallback_scan(cache, monkeypatch, watcher_was_ready):
    from app.services.directory_cache import MAX_WATCHER_RETRIES

    if watcher_was_ready:
        cache._watcher_ready.set()
    initial_epoch = cache.coordinator.epoch
    baseline = None
    attempts = 0

    def wait_for_retry(_delay):
        nonlocal baseline, attempts
        attempts += 1
        if baseline is None:
            assert cache.coordinator.epoch == initial_epoch + int(watcher_was_ready)
            baseline = cache.coordinator.begin_read("")
        else:
            assert cache.coordinator.is_current(baseline)
        return attempts > MAX_WATCHER_RETRIES

    monkeypatch.setattr(cache, "_connect_watcher", MagicMock(side_effect=OSError("Directory notifications are unavailable")))
    monkeypatch.setattr(cache._stop_event, "wait", wait_for_retry)
    try:
        cache._watcher_loop()
        assert attempts > MAX_WATCHER_RETRIES
    finally:
        if baseline is not None:
            cache.coordinator.end_read(baseline)


def test_recovery_logs_have_context_one_cause_and_bounded_failure_volume(cache, monkeypatch):
    from app.services.directory_cache import MAX_WATCHER_RETRIES

    output = io.StringIO()
    logger = logging.Logger("app.services.directory_cache", level=logging.DEBUG)
    handler = logging.StreamHandler(output)
    handler.setFormatter(RecoveryLogFormatter("%(message)s"))
    logger.addHandler(handler)
    monkeypatch.setattr("app.services.directory_cache.logger", logger)
    monkeypatch.setattr(cache, "_connect_watcher", MagicMock(side_effect=OSError("private source and password")))
    monkeypatch.setattr(cache._stop_event, "wait", MagicMock(side_effect=[False] * (MAX_WATCHER_RETRIES + 4) + [True]))
    cache._watcher_loop()
    logs = output.getvalue()
    assert logs.count("Recovery traceback:") == 1
    assert logs.count("event='directory_watcher_retry'") == MAX_WATCHER_RETRIES
    assert logs.count("event='directory_watcher_retry_exhausted'") == 1
    assert "private source" not in logs
    assert cache.connection_id not in logs
    assert f"source_id='{cache._log_context['source_id']}'" in logs
    assert f"generation_id='{cache._diagnostic_generation}'" in logs
    assert "retry_seconds=" in logs
    cache._schedule_retry()
    cache._reset_retry()
    recovered = output.getvalue()
    assert recovered.count("event='directory_verification_recovered'") == 1
    cache._reset_retry()
    assert output.getvalue() == recovered


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["remove_cache_async", "stop_all_async", "stop_all"])
async def test_manager_shutdown_logs_omit_source_identity_and_private_error_text(cache, monkeypatch, operation):
    logger = MagicMock()
    manager = DirectoryCacheManager()
    manager._caches[cache.connection_id] = cache
    failure = OSError(f"{cache.host}/{cache.share_name} {cache.username} {cache.password} private-source-path")
    with monkeypatch.context() as scope:
        scope.setattr("app.services.directory_cache.logger", logger)
        scope.setattr(cache, "_finish_stop", MagicMock(side_effect=failure))
        if operation == "remove_cache_async":
            await manager.remove_cache_async(cache.connection_id)
        elif operation == "stop_all_async":
            await manager.stop_all_async()
        else:
            manager.stop_all()
    logged = repr(logger.mock_calls)
    for private_value in (cache.connection_id, cache.host, cache.share_name, cache.username, cache.password, str(failure)):
        assert private_value not in logged
    assert "OSError" in logged
    assert "exc_info" not in logged
    logger.exception.assert_not_called()


@pytest.fixture(name="populated_cache")
def populated_cache_fixture(cache: ConnectionDirectoryCache) -> ConnectionDirectoryCache:
    """Create a cache pre-populated with directory paths."""

    dirs = [
        "documents",
        "documents/work",
        "documents/work/reports",
        "documents/work/reports/2024",
        "documents/personal",
        "photos",
        "photos/vacation",
        "photos/vacation/2024",
        "photos/family",
        "music",
        "music/rock",
        "music/jazz",
        "projects",
        "projects/alpha",
        "projects/alpha/src",
        "projects/beta",
        "backups",
        "backups/daily",
        "backups/weekly",
    ]
    cache.index.open()
    cache._opened.set()
    cache.index.write_paths(dirs)
    cache.index.finish_generation(1)
    cache._directory_count = len(dirs)
    cache._source_available.set()
    return cache


@pytest_asyncio.fixture(name="manager")
async def manager_fixture(tmp_path, monkeypatch):
    """Create a DirectoryCacheManager instance for testing."""

    monkeypatch.setattr("app.services.directory_cache.settings.directory_cache_location", str(tmp_path / "cache"))
    manager = DirectoryCacheManager()
    yield manager
    await manager.stop_all_async()


# ============================================================================
# CacheState enum
# ============================================================================


@pytest.mark.unit
class TestCacheState:
    """Tests for the CacheState enum."""

    def test_enum_values(self):
        """Verify all expected cache states exist with correct values."""

        assert CacheState.EMPTY.value == "empty"
        assert CacheState.OPENING.value == "opening"
        assert CacheState.BUILDING.value == "building"
        assert CacheState.READY.value == "ready"
        assert CacheState.UPDATING.value == "updating"

    def test_enum_is_string(self):
        """Cache states should be usable as strings."""

        assert isinstance(CacheState.READY, str)
        assert CacheState.READY.value == "ready"

    def test_enum_member_count(self):
        """Ensure no unexpected states were added."""

        expected_states = (
            CacheState.EMPTY,
            CacheState.OPENING,
            CacheState.BUILDING,
            CacheState.READY,
            CacheState.UPDATING,
        )
        assert len(CacheState) == len(expected_states)


# ============================================================================
# Constants
# ============================================================================


@pytest.mark.unit
class TestConstants:
    """Verify module-level constants have sensible values."""

    def test_max_search_results(self):
        """MAX_SEARCH_RESULTS should be a positive integer."""

        assert MAX_SEARCH_RESULTS > 0
        assert isinstance(MAX_SEARCH_RESULTS, int)

    def test_scan_timeout(self):
        """SCAN_TIMEOUT_SECONDS should be positive."""

        assert SCAN_TIMEOUT_SECONDS > 0

    def test_change_notify_buffer_size(self):
        """Buffer size should be the protocol maximum (64 KB)."""

        assert CHANGE_NOTIFY_BUFFER_SIZE == 65536


# ============================================================================
# ConnectionDirectoryCache — initialization
# ============================================================================


@pytest.mark.unit
class TestConnectionDirectoryCacheInit:
    """Tests for ConnectionDirectoryCache constructor and properties."""

    def test_initial_state_is_empty(self, cache: ConnectionDirectoryCache):
        """New cache should start in EMPTY state."""

        assert cache.state == CacheState.EMPTY

    def test_initial_directory_count_is_zero(self, cache: ConnectionDirectoryCache):
        """New cache should have zero directories."""

        assert cache.directory_count == 0

    def test_initial_last_scan_time_is_none(self, cache: ConnectionDirectoryCache):
        """New cache should have no last scan time."""

        assert cache.last_scan_time is None

    def test_initial_scan_error_is_none(self, cache: ConnectionDirectoryCache):
        """New cache should have no scan error."""

        assert cache.scan_error is None

    def test_stores_connection_params(self, cache: ConnectionDirectoryCache):
        """Cache should store all connection parameters."""

        assert cache.connection_id == "test-conn-001"
        assert cache.host == "server.local"
        assert cache.share_name == "testshare"
        assert cache.username == "testuser"
        assert cache.password == "testpass"
        assert cache.port == 445

    def test_default_port(self, cache):
        """Port should default to 445 when not specified."""

        cache = SQLiteConnectionDirectoryCache(
            connection_id="test",
            host="host",
            share_name="share",
            username="user",
            password="pass",
        )
        assert cache.port == 445
        cache.stop()

    @pytest.mark.parametrize("location", ["absolute", "relative", "default"])
    def test_configured_storage_root(self, tmp_path, monkeypatch, location):
        """Preserve absolute, data-relative, and default storage locations."""
        data_root = tmp_path / "data"
        root = tmp_path / "custom" if location == "absolute" else data_root / ("custom" if location == "relative" else "directory_cache")
        configured = str(root) if location == "absolute" else "custom" if location == "relative" else ""
        monkeypatch.setattr("app.services.directory_cache.static", replace(static, data_dir=data_root))
        monkeypatch.setattr("app.services.directory_cache.settings.directory_cache_location", configured)
        cache = SQLiteConnectionDirectoryCache("fixture", "host", "share", "user", "password")
        try:
            assert cache._persist_path.parent == root / "sqlite"
            cache.index.open()
            cache._opened.set()
            assert cache._persist_path.is_file()
        finally:
            cache.stop()


# ============================================================================
# ConnectionDirectoryCache — watcher policy
# ============================================================================


@pytest.mark.parametrize("auth_protocol", ["negotiate", "kerberos"])
@pytest.mark.parametrize("encrypt", [False, True])
def test_watcher_uses_validated_smb_policy(cache, auth_protocol, encrypt):
    policy = {
        "encrypt": encrypt,
        "connection_timeout": 19,
        "auth_protocol": auth_protocol,
        "require_signing": True,
    }
    with (
        patch("app.services.directory_cache.get_smbclient_policy_kwargs", return_value=policy),
        patch("app.services.directory_cache.Connection") as connection,
        patch("app.services.directory_cache.Session") as session,
        patch("app.services.directory_cache.TreeConnect"),
        patch("app.services.directory_cache.Open"),
    ):
        cache._connect_watcher()
        connection.assert_called_once_with(guid=None, server_name=cache.host, port=cache.port, require_signing=True)
        connection.return_value.connect.assert_called_once_with(timeout=policy["connection_timeout"])
        session.assert_called_once_with(
            connection.return_value,
            username=cache.username,
            password=cache.password,
            require_encryption=encrypt,
            auth_protocol=auth_protocol,
        )
        session.return_value.connect.assert_called_once_with()
        cache._cleanup_watcher()


@pytest.mark.parametrize("receives_events", [False, True])
def test_watcher_repeated_post_connect_failure_keeps_backoff(cache, receives_events):
    from app.services.directory_cache import MAX_WATCHER_RETRIES, WATCHER_RETRY_BASE_DELAY, WATCHER_RETRY_MAX_DELAY

    attempts = 0

    def fail():
        nonlocal attempts
        attempts += 1
        cache._watcher_received_events = receives_events and attempts == 4
        if cache._watcher_received_events:
            cache._watcher_ready.set()
        raise ConnectionError("Injected watcher failure.")

    with (
        patch.object(cache, "_connect_watcher") as connect,
        patch.object(cache, "_run_watcher_inner", side_effect=fail),
        patch.object(cache, "_cleanup_watcher"),
        patch.object(cache, "_observation_lost") as lost,
        patch.object(cache._stop_event, "wait", side_effect=[False] * (MAX_WATCHER_RETRIES + 4) + [True]) as wait,
    ):
        cache._watcher_loop()
    assert connect.call_count == MAX_WATCHER_RETRIES + 5
    assert lost.call_count == int(receives_events)
    delays = [call.args[0] for call in wait.call_args_list]
    assert all(0 < delay <= WATCHER_RETRY_MAX_DELAY for delay in delays)
    assert delays[1] > delays[0] >= WATCHER_RETRY_BASE_DELAY * 0.9
    assert delays[3] < delays[2] if receives_events else delays[3] > delays[2]
    assert not cache._watcher_ready.is_set()


# ============================================================================
# ConnectionDirectoryCache — stop
# ============================================================================


@pytest.mark.unit
class TestStop:
    """Tests for the stop method."""

    def test_stop_preserves_persisted_directories(self, populated_cache: SQLiteConnectionDirectoryCache):
        """Shutdown closes the writer without deleting committed catalogue rows."""
        from app.services.directory_index import DirectoryIndex

        count = populated_cache.directory_count
        assert count > 0
        populated_cache.stop()
        assert populated_cache._storage_released
        with pytest.raises(InterruptedError):
            populated_cache.search("documents")
        reopened = DirectoryIndex(populated_cache._persist_path, source_kind="smb", source_identity=populated_cache._source_identity)
        reopened.open()
        try:
            assert reopened.status().directory_count == count
        finally:
            reopened.close()

    def test_stop_sets_empty_state(self, populated_cache: ConnectionDirectoryCache):
        """stop() should reset state to EMPTY."""

        populated_cache._state = CacheState.READY
        populated_cache.stop()
        assert populated_cache.state == CacheState.EMPTY

    def test_stop_sets_stop_event(self, cache: ConnectionDirectoryCache):
        """stop() should signal background tasks to stop."""

        cache.stop()
        assert cache._stop_event.is_set()

    def test_stop_cancels_scan_task(self, cache: ConnectionDirectoryCache):
        """stop() should cancel the scan asyncio task if running."""

        mock_task = MagicMock()
        mock_task.done.return_value = False
        cache._scan_task = mock_task

        cache.stop()
        mock_task.cancel.assert_called_once()

    def test_stop_cancels_rescan_task(self, cache: ConnectionDirectoryCache):
        """stop() should cancel the rescan asyncio task if running."""

        mock_task = MagicMock()
        mock_task.done.return_value = False
        cache._rescan_task = mock_task

        cache.stop()
        mock_task.cancel.assert_called_once()


# ============================================================================
# DirectoryCacheManager
# ============================================================================


@pytest.mark.unit
class TestDirectoryCacheManager:
    """Tests for the DirectoryCacheManager class."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "field,value",
        [
            ("host", "other-host"),
            ("share_name", "other-share"),
            ("username", "other-user"),
            ("password", "other-password"),
            ("port", 1445),
            ("path_prefix", "/other"),
            ("source_revision", "new-revision"),
        ],
    )
    async def test_rebinds_changed_sources_without_serving_previous_paths(self, manager: DirectoryCacheManager, field, value):
        parameters = {"connection_id": "rebound", "host": "host", "share_name": "share", "username": "user", "password": "password"}
        with (
            patch.object(SQLiteConnectionDirectoryCache, "start_scan", new_callable=AsyncMock),
        ):
            previous = await manager.get_or_create_cache(**parameters)
            previous.add_directory("old-source-data")
            replacement = await manager.get_or_create_cache(**{**parameters, field: value})
            assert replacement is not previous
            assert previous._stop_event.is_set()
            assert replacement.directory_count == 0
            assert manager.get_cache("rebound") is replacement
            await manager.stop_all_async()

    def test_get_cache_returns_none_for_unknown(self, manager: DirectoryCacheManager):
        """get_cache should return None for unknown connection IDs."""

        assert manager.get_cache("unknown-id") is None

    @pytest.mark.asyncio
    async def test_get_or_create_cache_creates_new(self, manager: DirectoryCacheManager):
        """get_or_create_cache should create a new cache with scan started."""

        with patch(
            "app.services.directory_cache.SQLiteConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ) as mock_scan:
            cache = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
                port=445,
            )

            assert cache is not None
            assert cache.connection_id == "conn-1"
            mock_scan.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_or_create_cache_returns_existing(self, manager: DirectoryCacheManager):
        """get_or_create_cache should return existing cache on second call."""

        with patch(
            "app.services.directory_cache.SQLiteConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            cache1 = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )
            cache2 = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )
            assert cache1 is cache2

    @pytest.mark.asyncio
    async def test_get_cache_after_create(self, manager: DirectoryCacheManager):
        """get_cache should find cache created by get_or_create_cache."""

        with patch(
            "app.services.directory_cache.SQLiteConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            created = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )
            found = manager.get_cache("conn-1")
            assert found is created

    @pytest.mark.asyncio
    async def test_remove_cache_stops_and_removes(self, manager: DirectoryCacheManager):
        """remove_cache should stop the cache and remove it from the manager."""

        with patch(
            "app.services.directory_cache.SQLiteConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )

        with patch.object(ConnectionDirectoryCache, "stop") as mock_stop:
            manager.remove_cache("conn-1")
            mock_stop.assert_called_once()

        assert manager.get_cache("conn-1") is None

    def test_remove_nonexistent_cache_is_safe(self, manager: DirectoryCacheManager):
        """Removing a non-existent cache should not raise."""

        manager.remove_cache("nonexistent")  # Should not raise

    @pytest.mark.asyncio
    async def test_stop_all(self, manager: DirectoryCacheManager):
        """stop_all should stop every cache and clear the manager."""

        with patch(
            "app.services.directory_cache.SQLiteConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )
            await manager.get_or_create_cache(
                connection_id="conn-2",
                host="host2",
                share_name="share2",
                username="user2",
                password="pass2",
            )

        with patch.object(ConnectionDirectoryCache, "stop"):
            manager.stop_all()

        assert manager.get_cache("conn-1") is None
        assert manager.get_cache("conn-2") is None

    @pytest.mark.asyncio
    async def test_get_stats(self, manager: DirectoryCacheManager):
        """get_stats should return stats for all caches."""

        with patch(
            "app.services.directory_cache.SQLiteConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            cache = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )
            cache.add_directories(["a", "b", "c"])

        stats = manager.get_stats()
        assert "conn-1" in stats
        assert stats["conn-1"]["state"] == CacheState.EMPTY.value
        assert stats["conn-1"]["directory_count"] == 0
        assert stats["conn-1"]["last_scan_time"] is None
        assert stats["conn-1"]["scan_error"] is None

    def test_get_stats_empty_manager(self, manager: DirectoryCacheManager):
        """get_stats on empty manager should return empty dict."""

        assert manager.get_stats() == {}

    @pytest.mark.asyncio
    async def test_separate_caches_per_connection(self, manager: DirectoryCacheManager):
        """Each connection should have its own independent cache."""

        with patch(
            "app.services.directory_cache.SQLiteConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            cache1 = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host1",
                share_name="share1",
                username="user",
                password="pass",
            )
            cache2 = await manager.get_or_create_cache(
                connection_id="conn-2",
                host="host2",
                share_name="share2",
                username="user",
                password="pass",
            )

        cache1.add_directory("only_in_cache1")
        cache2.add_directory("only_in_cache2")

        for cache in (cache1, cache2):
            cache.index.open()
            cache._opened.set()
            cache._source_available.set()
            cache.coordinator.apply_pending()
        assert cache1.search("only_in_cache1") == (["only_in_cache1"], 1)
        assert cache1.search("only_in_cache2") == ([], 0)
        assert cache2.search("only_in_cache2") == (["only_in_cache2"], 1)
        assert cache2.search("only_in_cache1") == ([], 0)


# ============================================================================
# Module-level functions
# ============================================================================


@pytest.mark.unit
class TestModuleFunctions:
    """Tests for module-level singleton and shutdown functions."""

    def test_get_directory_cache_manager_returns_instance(self):
        """Should return a DirectoryCacheManager instance."""

        import app.services.directory_cache as module

        original = module._global_cache_manager
        try:
            module._global_cache_manager = None
            mgr = get_directory_cache_manager()
            assert isinstance(mgr, DirectoryCacheManager)
        finally:
            module._global_cache_manager = original

    def test_get_directory_cache_manager_is_singleton(self):
        """Repeated calls should return the same instance."""

        import app.services.directory_cache as module

        original = module._global_cache_manager
        try:
            module._global_cache_manager = None
            mgr1 = get_directory_cache_manager()
            mgr2 = get_directory_cache_manager()
            assert mgr1 is mgr2
        finally:
            module._global_cache_manager = original

    def test_shutdown_directory_cache(self):
        """shutdown_directory_cache should call stop_all and clear singleton."""

        import app.services.directory_cache as module

        original = module._global_cache_manager
        try:
            mock_manager = MagicMock(spec=DirectoryCacheManager)
            module._global_cache_manager = mock_manager

            shutdown_directory_cache()

            mock_manager.stop_all.assert_called_once()
            assert module._global_cache_manager is None
        finally:
            module._global_cache_manager = original

    def test_shutdown_when_no_manager(self):
        """shutdown_directory_cache should be safe when no manager exists."""

        import app.services.directory_cache as module

        original = module._global_cache_manager
        try:
            module._global_cache_manager = None
            shutdown_directory_cache()  # Should not raise
            assert module._global_cache_manager is None
        finally:
            module._global_cache_manager = original
