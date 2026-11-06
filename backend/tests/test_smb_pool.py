"""
Tests for SMB Connection Pool

Verifies that SMB connections are properly pooled and reused across requests.
"""

import asyncio
import socket
import subprocess
import sys
import textwrap
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Event
from unittest.mock import Mock, patch

import pytest
from smbprotocol.connection import Connection as ProtocolConnection
from smbprotocol.connection import SMB2Echo
from smbprotocol.transport import Tcp

from app.api._smb_helpers import build_smb_backend, file_target_http_error
from app.models.connection import Connection
from app.storage.smb import SMBBackend
from app.storage.smb_errors import SMBConnectionCapacityError, SMBConnectionRetired, SMBMutationUncertain, SMBOperationTimeout
from app.storage.smb_pool import ScanCreditConnection, SMBConnectionPool, get_connection_pool, get_smb_connection_cache


@pytest.fixture(autouse=True)
def scan_connection_setup(monkeypatch):
    def connect(connection, *, timeout):
        connection.transport = Mock(connected=True)

    setup = Mock(side_effect=connect)
    monkeypatch.setattr(ScanCreditConnection, "connect", lambda connection, **kwargs: setup(connection, **kwargs))
    return setup


@pytest.mark.asyncio
async def test_pool_registers_atomic_connection_through_smbclient(scan_connection_setup):
    from app.services.system_settings import get_smbclient_policy_kwargs

    pool = SMBConnectionPool()
    cache = {}
    policy = get_smbclient_policy_kwargs()
    with patch("smbclient._pool.Session") as session:
        try:
            async with pool.get_connection("SERVER", 445, "user", "pass", "share", connection_cache=cache):
                connection = cache["server:445"]
                assert isinstance(connection, ScanCreditConnection)
                scan_connection_setup.assert_called_once_with(connection, timeout=policy["connection_timeout"])
                session.assert_called_once_with(
                    connection,
                    username="user",
                    password="pass",
                    require_encryption=policy["encrypt"],
                    auth_protocol=policy["auth_protocol"],
                )
                session.return_value.connect.assert_called_once_with()
        finally:
            await pool.close_all()


def test_scan_credit_admission_rejects_whole_compound_without_mutation():
    connection = ScanCreditConnection(uuid.uuid4(), "server")
    connection.transport = Mock()
    connection.sequence_window["high"] = 20
    before = connection.sequence_window.copy()
    assert connection.send_scan_compound([SMB2Echo() for _ in range(5)], 0, 0, reserve=16, credit_target=64) is None
    assert connection.sequence_window == before
    assert not connection.outstanding_requests
    connection.transport.send.assert_not_called()


def test_scan_credit_admission_uses_negotiated_multi_credit_charges():
    from smbprotocol.open import SMB2QueryDirectoryRequest

    connection = ScanCreditConnection(uuid.uuid4(), "server")
    connection.transport = Mock()
    connection.supports_multi_credit = True
    messages = [SMB2Echo(), SMB2Echo()]
    for _ in range(2):
        query = SMB2QueryDirectoryRequest()
        query["file_id"] = b"\xff" * 16
        query["output_buffer_length"] = 1024 * 1024
        messages.append(query)
    messages.append(SMB2Echo())
    connection.sequence_window["high"] = 51
    requests = connection.send_scan_compound(messages, 0, 0, reserve=16, credit_target=296)
    assert requests is not None
    assert [request.message["credit_charge"].get_value() for request in requests] == [1, 1, 16, 16, 1]
    assert all(request.message["credit_request"].get_value() == 36 for request in requests)
    assert connection.sequence_window["high"] - connection.sequence_window["low"] == 16


@pytest.mark.asyncio
async def test_pool_transport_setup_failure_releases_capacity(scan_connection_setup):
    pool = SMBConnectionPool()
    cache = {}

    def fail_setup(connection, *, timeout):
        connection.transport = Mock(connected=False)
        raise TimeoutError("Injected transport setup timeout.")

    scan_connection_setup.side_effect = fail_setup
    with patch("smbclient.register_session") as register, patch("smbclient.reset_connection_cache"):
        try:
            with pytest.raises(TimeoutError):
                async with pool.get_connection("server", 445, "user", "pass", "share", connection_cache=cache):
                    pytest.fail("Failed transport setup must not admit a pool lease.")
            register.assert_not_called()
            assert isinstance(cache["server:445"], ScanCreditConnection)
            async with asyncio.timeout(3):
                while pool._background_tasks:
                    await asyncio.gather(*tuple(pool._background_tasks), return_exceptions=True)
            assert pool.get_stats()["total_references"] == 0
        finally:
            await pool.close_all()
            cache.clear()


def test_scan_credit_admission_blocks_concurrent_browse_until_whole_compound():
    connection = ScanCreditConnection(uuid.uuid4(), "server")
    connection.transport = Mock()
    connection.sequence_window["high"] = 21
    entered = Event()
    release = Event()
    browsing = Event()
    messages = [SMB2Echo() for _ in range(5)]
    calculate = connection._calculate_credit_charge
    calls = 0

    def charge(message):
        nonlocal calls
        calls += 1
        if calls == len(messages) + 1:
            entered.set()
            assert release.wait(3)
        return calculate(message)

    def browse():
        browsing.set()
        return connection.send(SMB2Echo(), sid=0)

    with patch.object(connection, "_calculate_credit_charge", side_effect=charge), ThreadPoolExecutor(max_workers=2) as workers:
        scan = workers.submit(connection.send_scan_compound, messages, 0, 0, reserve=16, credit_target=64)
        try:
            assert entered.wait(3)
            browser = workers.submit(browse)
            assert browsing.wait(3)
            acquired = connection.sequence_lock.acquire(blocking=False)
            if acquired:
                connection.sequence_lock.release()
            assert not acquired
            assert not browser.done()
        finally:
            release.set()
        requests = scan.result(timeout=3)
        assert requests is not None
        assert [request.message["message_id"].get_value() for request in requests] == list(range(5))
        assert browser.result(timeout=3).message["message_id"].get_value() == 5
    assert connection.sequence_window["high"] - connection.sequence_window["low"] == 15
    assert connection.transport.send.call_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("reader_result", [False, True])
async def test_installed_transport_failure_and_restoration_through_backend_pool(reader_result):
    """Use isolated loopback transports, not a live SMB server or network changes."""
    pool = SMBConnectionPool()
    source_key = str(uuid.uuid4())
    backend = SMBBackend(host="127.0.0.1", share_name="share", username="user", password="pass", connection_context_key=source_key)
    first_cache = backend._connection_cache
    peers = []
    started = Event()
    stale_started = Event()
    release_stale = Event()
    operations = []
    reader = None

    def stale_result(*_args):
        stale_started.set()
        assert release_stale.wait(3)
        return b"stale"

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(2)
        listener.settimeout(3)
        port = listener.getsockname()[1]

        def register(_host, *, connection_cache, **_kwargs):
            connection = ProtocolConnection(uuid.uuid4(), "127.0.0.1", port=port)
            connection.transport = Tcp("127.0.0.1", port, timeout=3)
            connection.transport.connect()
            peer, _address = listener.accept()
            peers.append(peer)
            connection_cache["transport"] = connection
            if connection_cache is not first_cache:
                peer.sendall(b"\x00\x00\x00\x01x")

        def scan(_path, *, connection_cache, **_kwargs):
            operations.append(connection_cache)
            started.set()
            packet = connection_cache["transport"].transport.recv(3)
            entry = Mock()
            entry.name = "recovered" if packet else "stale"
            entry.smb_info.file_attributes = 16
            entry.smb_info.end_of_file = 0
            entry.smb_info.last_write_time = datetime.now(timezone.utc)
            entry.smb_info.creation_time = datetime.now(timezone.utc)
            return [entry]

        with (
            patch("smbclient.register_session", side_effect=register),
            patch("smbclient.scandir", side_effect=scan),
            patch("app.storage.smb.get_connection_pool", return_value=pool),
            patch("app.storage.smb.SMB_LIST_DIRECTORY_TIMEOUT_SECONDS", 0.02),
        ):
            try:
                async with pool.get_connection("127.0.0.1", 445, "user", "pass", "share", connection_cache=first_cache):
                    if reader_result:
                        handle = Mock(read=Mock(side_effect=stale_result))
                        with patch("smbclient.open_file", return_value=handle):
                            reader = await backend.open_random_access_reader("source")
                        stale = asyncio.create_task(reader.read_at(0, 5))
                    else:
                        stale = asyncio.create_task(
                            backend._run_blocking_smb_call("read_old_generation", stale_result, 3, smb_path="source")
                        )
                    assert await asyncio.to_thread(stale_started.wait, 2)
                    with pytest.raises(SMBOperationTimeout):
                        await backend.list_directory("")
                    assert started.is_set()
                    with pytest.raises(SMBConnectionRetired):
                        async with pool.get_connection("127.0.0.1", 445, "user", "pass", "share", connection_cache=first_cache):
                            pytest.fail("Old generation must reject admission")
                    replacement = SMBBackend(
                        host="127.0.0.1", share_name="share", username="user", password="pass", connection_context_key=source_key
                    )
                    assert replacement._connection_cache is not first_cache
                    async with pool.get_connection(
                        "127.0.0.1", 445, "user", "pass", "share", connection_cache=replacement._connection_cache
                    ):
                        listing = await replacement.list_directory("")
                        assert [item.name for item in listing.items] == ["recovered"]
                        release_stale.set()
                        with pytest.raises(SMBConnectionRetired):
                            await stale
                        assert operations == [first_cache, replacement._connection_cache]
                        await pool.invalidate_connection_cache(replacement._connection_cache)
                        third = get_smb_connection_cache(source_key)
                        with pytest.raises(SMBConnectionCapacityError):
                            async with pool.get_connection("127.0.0.1", 445, "user", "pass", "share", connection_cache=third):
                                pytest.fail("Two retained generations must prevent a third admission")
                    assert pool.generation_aborting(first_cache)
            finally:
                release_stale.set()
                if reader is not None:
                    await reader.close()
                for peer in peers:
                    peer.close()
                await pool.close_all()
                async with asyncio.timeout(5):
                    while pool._background_tasks or pool.get_stats()["total_references"]:
                        await asyncio.sleep(0)
                        if pool._background_tasks:
                            await asyncio.gather(*tuple(pool._background_tasks), return_exceptions=True)
    assert pool.get_stats()["total_connections"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("shared_abort", [False, True])
async def test_mutation_deadline_is_uncertain_and_never_replayed(shared_abort):
    pool = SMBConnectionPool()
    backend = SMBBackend(host="server", share_name="share", username="user", password="pass")
    finish = Event()
    started = Event()

    def mutate():
        started.set()
        assert finish.wait(3)
        if shared_abort:
            raise ConnectionError("Controlled shared transport abort")

    operation = Mock(side_effect=mutate)
    with (
        patch("smbclient.register_session"),
        patch("smbclient.reset_connection_cache"),
        patch("app.storage.smb.get_connection_pool", return_value=pool),
    ):
        try:
            async with pool.get_connection("server", 445, "user", "pass", "share", connection_cache=backend._connection_cache):
                with pytest.raises(SMBMutationUncertain) as failure:
                    if shared_abort:
                        mutation = asyncio.create_task(
                            backend._run_blocking_smb_call("write_file", operation, 2, smb_path="target", mutation_paths=("target",))
                        )
                        assert await asyncio.to_thread(started.wait, 2)
                        await pool.invalidate_connection_cache(backend._connection_cache, abort=True)
                        finish.set()
                        await mutation
                    else:
                        await backend._run_blocking_smb_call("write_file", operation, 0.01, smb_path="target", mutation_paths=("target",))
                assert started.is_set()
                response = file_target_http_error(failure.value)
                assert response.status_code == 409
                assert response.detail["mutation_uncertain"] is True
                assert response.detail["recoverable"] is False
                operation.assert_called_once()
                assert pool.get_stats()["active_connections"] == 1
        finally:
            finish.set()
            async with asyncio.timeout(5):
                while pool._background_tasks or pool.get_stats()["total_references"]:
                    await asyncio.sleep(0)
                    if pool._background_tasks:
                        await asyncio.gather(*tuple(pool._background_tasks), return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("abort_fails", [False, True])
async def test_timeout_abort_is_coalesced_retained_and_replacement_isolated(abort_fails):
    pool = SMBConnectionPool()
    started = Event()
    finish = Event()
    source_key = str(uuid.uuid4())
    cache = get_smb_connection_cache(source_key)

    def disconnect(*, close):
        assert close is False
        started.set()
        assert finish.wait(3)
        if abort_fails:
            raise OSError("Controlled abort failure")

    transport = Mock(disconnect=Mock(side_effect=disconnect))
    replacement_transport = Mock()
    arguments = dict(host="server", port=445, username="user", password="pass", share_name="share")
    with patch("smbclient.register_session"), patch("smbclient.reset_connection_cache") as reset:
        try:
            async with pool.get_connection(**arguments, connection_cache=cache):
                cache["server"] = transport
                await pool.invalidate_connection_cache(cache, abort=True)
                await pool.invalidate_connection_cache(cache, abort=True)
                assert await asyncio.to_thread(started.wait, 2)
                replacement = get_smb_connection_cache(source_key)
                async with pool.get_connection(**arguments, connection_cache=replacement):
                    replacement["server"] = replacement_transport
                    assert pool.get_stats()["total_connections"] == 2
            reset.assert_not_called()
            replacement_transport.disconnect.assert_not_called()
            transport.disconnect.assert_called_once_with(close=False)
        finally:
            finish.set()
            while pool._background_tasks:
                await asyncio.gather(*tuple(pool._background_tasks), return_exceptions=True)
        reset.assert_called_once_with(fail_on_error=False, connection_cache=cache)


@pytest.mark.parametrize("mode", ["receive", "send"])
def test_installed_public_disconnect_interruptibility(mode):
    """Isolate socket probes so a library regression cannot retain pytest threads."""
    probe = textwrap.dedent(
        """
        import socket
        import sys
        import threading
        import uuid
        from smbprotocol.connection import Connection
        from smbprotocol.exceptions import SMBConnectionClosed
        from smbprotocol.transport import Tcp

        mode = sys.argv[1]
        deadline = 5
        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen(1)
        listener.settimeout(deadline)
        port = listener.getsockname()[1]
        connection = Connection(uuid.uuid4(), '127.0.0.1', port=port)
        if mode == 'send':
            connection.transport = Tcp('127.0.0.1', port, timeout=deadline)
            connection.transport.connect()
        entered = threading.Event()
        failures = []

        def operation():
            entered.set()
            try:
                if mode == 'receive':
                    connection.connect(timeout=deadline)
                else:
                    connection.transport.send(b'x' * Tcp.MAX_SIZE)
            except BaseException as error:
                failures.append(error)

        worker = threading.Thread(target=operation, daemon=True)
        abort = threading.Thread(target=lambda: connection.disconnect(close=False), daemon=True)
        peer = None
        try:
            worker.start()
            peer, _ = listener.accept()
            peer.settimeout(deadline)
            if mode == 'receive':
                assert peer.recv(65536), 'negotiate must be sent before abort'
            assert entered.wait(deadline)
            worker.join(0.1)
            assert worker.is_alive(), 'operation must be blocked before abort'
            abort.start()
            if mode == 'send':
                abort.join(0.1)
                assert abort.is_alive(), 'send lock must retain abort until send exits'
                while peer.recv(65536):
                    pass
            worker.join(deadline)
            abort.join(deadline)
            assert not worker.is_alive()
            assert not abort.is_alive()
            if mode == 'receive':
                assert len(failures) == 1 and isinstance(failures[0], SMBConnectionClosed), failures
            else:
                assert not failures, failures
        finally:
            if peer is not None:
                peer.close()
            listener.close()
        print(mode + ': public abort verified')
        """
    )
    result = subprocess.run([sys.executable, "-c", probe, mode], capture_output=True, text=True, timeout=15, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
    assert f"{mode}: public abort verified" in result.stdout


@pytest.mark.asyncio
async def test_blocked_registration_does_not_block_another_source():
    pool = SMBConnectionPool()
    started = Event()
    finish = Event()

    def register(host, **_kwargs):
        if host == "blocked":
            started.set()
            assert finish.wait(3)

    async def acquire(host):
        async with pool.get_connection(host=host, port=445, username="user", password="pass", share_name="share"):
            pass

    with patch("smbclient.register_session", side_effect=register):
        blocked = asyncio.create_task(acquire("blocked"))
        try:
            assert await asyncio.to_thread(started.wait, 2)
            await asyncio.wait_for(acquire("available"), 1)
        finally:
            finish.set()
            await blocked


@pytest.mark.asyncio
async def test_cancelled_setup_is_owned_until_registration_and_reset_finish():
    pool = SMBConnectionPool()
    started = Event()
    finish = Event()
    reset_complete = asyncio.Event()
    loop = asyncio.get_running_loop()
    cache = get_smb_connection_cache(str(uuid.uuid4()))

    def register(*_args, **_kwargs):
        started.set()
        assert finish.wait(3)

    def reset(**_kwargs):
        loop.call_soon_threadsafe(reset_complete.set)

    async def acquire():
        async with pool.get_connection(
            host="blocked", port=445, username="user", password="pass", share_name="share", connection_cache=cache
        ):
            pytest.fail("Cancelled setup must not yield a connection")

    with patch("smbclient.register_session", side_effect=register), patch("smbclient.reset_connection_cache", side_effect=reset) as cleanup:
        acquiring = asyncio.create_task(acquire())
        try:
            assert await asyncio.to_thread(started.wait, 2)
            acquiring.cancel()
            with pytest.raises(asyncio.CancelledError):
                await acquiring
            assert pool.get_stats()["active_connections"] == 1
            cleanup.assert_not_called()
        finally:
            finish.set()
        await asyncio.wait_for(reset_complete.wait(), 2)
        for task in tuple(pool._background_tasks):
            try:
                await task
            except Exception:
                pass
        assert pool.get_stats()["total_connections"] == 0
        cleanup.assert_called_once()


@pytest.mark.asyncio
async def test_replacement_generation_is_isolated_and_bounded():
    pool = SMBConnectionPool()
    source_key = str(uuid.uuid4())
    first = get_smb_connection_cache(source_key)
    arguments = dict(host="server", port=445, username="user", password="pass", share_name="share")
    with patch("smbclient.register_session"), patch("smbclient.reset_connection_cache") as reset:
        async with pool.get_connection(**arguments, connection_cache=first):
            await pool.invalidate_connection_cache(first)
            second = get_smb_connection_cache(source_key)
            assert second is not first
            async with pool.get_connection(**arguments, connection_cache=second):
                await pool.invalidate_connection_cache(second)
                third = get_smb_connection_cache(source_key)
                with pytest.raises(SMBConnectionCapacityError):
                    async with pool.get_connection(**arguments, connection_cache=third):
                        pytest.fail("Only two retained generations may be admitted")
                reset.assert_not_called()
            assert reset.call_count == 1
        assert reset.call_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("limit_name", ["MAX_CONNECTION_GENERATIONS", "MAX_CONNECTION_SETUPS"])
@pytest.mark.parametrize("late_failure", [False, True])
async def test_simultaneous_sources_remain_bounded_until_setup_and_cleanup_exit(limit_name, late_failure):
    pool = SMBConnectionPool()
    started = {host: Event() for host in ("first", "second")}
    finish = Event()

    def register(host, **_kwargs):
        started[host].set()
        assert finish.wait(3)
        if late_failure:
            raise OSError("Setup failed after cancellation")

    async def acquire(host):
        async with pool.get_connection(host, 445, "user", "pass", "share"):
            pytest.fail("Cancelled setup must not yield")

    with (
        patch(f"app.storage.smb_pool.{limit_name}", 2),
        patch("smbclient.register_session", side_effect=register),
        patch("smbclient.reset_connection_cache") as reset,
    ):
        tasks = [asyncio.create_task(acquire(host)) for host in started]
        try:
            for event in started.values():
                assert await asyncio.to_thread(event.wait, 2)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            assert pool.get_stats()["total_connections"] == 2
            with pytest.raises(SMBConnectionCapacityError):
                async with pool.get_connection("third", 445, "user", "pass", "share"):
                    pytest.fail("Retained setup must count against global capacity")
            reset.assert_not_called()
        finally:
            finish.set()
            await asyncio.gather(*tasks, return_exceptions=True)
            while pool._background_tasks:
                await asyncio.gather(*tuple(pool._background_tasks), return_exceptions=True)
        assert pool.get_stats()["total_connections"] == 0
        assert reset.call_count == 2


@pytest.mark.asyncio
async def test_global_admission_limit_rejects_work_without_queuing():
    pool = SMBConnectionPool()
    with patch("app.storage.smb_pool.MAX_CONNECTION_ADMISSIONS", 3), patch("smbclient.register_session"):
        async with pool.get_connection("first", 445, "user", "pass", "share"):
            async with pool.get_connection("second", 445, "user", "pass", "share"):
                with pytest.raises(SMBConnectionCapacityError):
                    async with pool.get_connection("third", 445, "user", "pass", "share"):
                        pytest.fail("Admission capacity must reject without queuing")


@pytest.mark.asyncio
async def test_shutdown_rejects_admission_without_resetting_active_work():
    pool = SMBConnectionPool()
    with patch("smbclient.register_session"), patch("smbclient.reset_connection_cache") as reset:
        async with pool.get_connection("first", 445, "user", "pass", "share"):
            await pool.close_all()
            reset.assert_not_called()
            with pytest.raises(SMBConnectionRetired):
                async with pool.get_connection("second", 445, "user", "pass", "share"):
                    pytest.fail("Shutdown must not admit new work")
        reset.assert_called_once()
        assert pool.get_stats()["total_connections"] == 0


@pytest.mark.asyncio
async def test_connection_pool_reuses_connections():
    """Test that connection pool reuses existing connections."""
    pool = SMBConnectionPool()

    with patch("smbclient.register_session") as mock_register:
        # First connection
        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
        ):
            pass

        # Should have called register_session once
        assert mock_register.call_count == 1

        # Second connection with same credentials
        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
        ):
            pass

        # Should NOT call register_session again (reused)
        assert mock_register.call_count == 1, "Connection should be reused"


@pytest.mark.asyncio
async def test_connection_pool_reuses_a_persisted_connection_context():
    """Separate request backends must share one cache for one saved connection."""

    pool = SMBConnectionPool()
    first_request_cache = get_smb_connection_cache("persisted-connection-id")
    second_request_cache = get_smb_connection_cache("persisted-connection-id")

    assert first_request_cache is second_request_cache

    with patch("smbclient.register_session") as mock_register:
        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
            connection_cache=first_request_cache,
        ):
            pass

        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
            connection_cache=second_request_cache,
        ):
            pass

    assert mock_register.call_count == 1


def test_persisted_connections_use_stable_but_distinct_private_caches():
    """Logical connection identity, not server credentials, scopes cache reuse."""

    first_connection = Connection(
        id=uuid.uuid4(),
        name="First",
        host="test-host",
        share_name="share",
        username="user",
        password_encrypted="encrypted-password",
    )
    second_connection = Connection(
        id=uuid.uuid4(),
        name="Second",
        host="test-host",
        share_name="share",
        username="user",
        password_encrypted="encrypted-password",
    )

    with patch("app.api._smb_helpers.decrypt_password", return_value="password"):
        first_request_backend = build_smb_backend(first_connection)
        second_request_backend = build_smb_backend(first_connection)
        other_connection_backend = build_smb_backend(second_connection)

    assert first_request_backend._connection_cache is second_request_backend._connection_cache
    assert first_request_backend._connection_cache is not other_connection_backend._connection_cache


@pytest.mark.asyncio
async def test_connection_pool_reference_counting():
    """Test that reference counting works correctly."""
    pool = SMBConnectionPool()

    with patch("smbclient.register_session"):
        # Acquire connection
        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
        ):
            # Check ref count while in use
            stats = pool.get_stats()
            assert stats["total_connections"] == 1
            assert stats["active_connections"] == 1
            assert stats["total_references"] == 1

        # After release, ref count should be 0 but connection still pooled
        stats = pool.get_stats()
        assert stats["total_connections"] == 1
        assert stats["active_connections"] == 0
        assert stats["idle_connections"] == 1


@pytest.mark.asyncio
async def test_context_invalidation_waits_for_active_lease():
    """Retirement must not terminate an SMB operation that still holds a lease."""

    pool = SMBConnectionPool()
    connection_cache: dict[str, object] = {}

    with (
        patch("smbclient.register_session"),
        patch("smbclient.reset_connection_cache") as mock_reset,
    ):
        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
            connection_cache=connection_cache,
        ):
            await pool.invalidate_connection_cache(connection_cache, reason="policy updated")
            assert pool.get_stats()["active_connections"] == 1
            mock_reset.assert_not_called()

        assert pool.get_stats()["total_connections"] == 0
        mock_reset.assert_called_once_with(fail_on_error=False, connection_cache=connection_cache)


@pytest.mark.asyncio
async def test_retired_context_rejects_new_leases_until_existing_work_finishes():
    """Policy retirement must not permit reuse of the old SMB session."""

    pool = SMBConnectionPool()
    connection_cache: dict[str, object] = {}

    with patch("smbclient.register_session"):
        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
            connection_cache=connection_cache,
        ):
            await pool.invalidate_connection_cache(connection_cache, reason="policy updated")
            with pytest.raises(RuntimeError, match="being retired"):
                async with pool.get_connection(
                    host="test-host",
                    port=445,
                    username="user",
                    password="pass",
                    share_name="share",
                    connection_cache=connection_cache,
                ):
                    pass


@pytest.mark.asyncio
async def test_retired_context_waits_for_executor_future_before_resetting():
    """A canceled caller must not reset a cache while its worker still runs."""

    pool = SMBConnectionPool()
    connection_cache: dict[str, object] = {}
    operation_future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
    reset_complete = asyncio.Event()
    event_loop = asyncio.get_running_loop()

    def record_reset(**_kwargs) -> None:
        event_loop.call_soon_threadsafe(reset_complete.set)

    with (
        patch("smbclient.register_session"),
        patch("smbclient.reset_connection_cache", side_effect=record_reset) as mock_reset,
    ):
        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
            connection_cache=connection_cache,
        ):
            await pool.invalidate_connection_cache(connection_cache, reason="policy updated")
            await pool.retain_connection_until_future_complete(connection_cache, operation_future)

        mock_reset.assert_not_called()
        operation_future.set_result(None)
        await asyncio.wait_for(reset_complete.wait(), timeout=1)

    mock_reset.assert_called_once_with(fail_on_error=False, connection_cache=connection_cache)


@pytest.mark.asyncio
async def test_connection_pool_nested_acquire():
    """Test that multiple nested acquires increment ref count."""
    pool = SMBConnectionPool()

    with patch("smbclient.register_session"):
        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
        ):
            # Nested acquire (same connection)
            async with pool.get_connection(
                host="test-host",
                port=445,
                username="user",
                password="pass",
                share_name="share",
            ):
                stats = pool.get_stats()
                assert stats["total_references"] == 2
                assert stats["active_connections"] == 1  # Still only 1 connection

            # After inner release
            stats = pool.get_stats()
            assert stats["total_references"] == 1

        # After both releases
        stats = pool.get_stats()
        assert stats["total_references"] == 0


@pytest.mark.asyncio
async def test_connection_pool_different_servers():
    """Test that different servers get different connections."""
    pool = SMBConnectionPool()

    with patch("smbclient.register_session") as mock_register:
        # Connection to server 1
        async with pool.get_connection(
            host="server1",
            port=445,
            username="user",
            password="pass",
            share_name="share",
        ):
            pass

        # Connection to server 2 (different host)
        async with pool.get_connection(
            host="server2",
            port=445,
            username="user",
            password="pass",
            share_name="share",
        ):
            pass

        # Should create 2 separate connections
        assert mock_register.call_count == 2

        stats = pool.get_stats()
        assert stats["total_connections"] == 2


@pytest.mark.asyncio
async def test_smb_backend_uses_pool():
    """Test that SMBBackend properly uses the connection pool."""
    backend = SMBBackend(
        host="test-host",
        share_name="test-share",
        username="test-user",
        password="test-pass",
        port=445,
    )

    with (
        patch("smbclient.register_session") as mock_register,
        patch("smbclient.scandir") as mock_scandir,
    ):
        mock_scandir.return_value = []  # Empty directory

        # First request
        await backend.connect()
        await backend.list_directory("/")
        await backend.disconnect()

        # Second request (should reuse connection)
        await backend.connect()
        await backend.list_directory("/another")
        await backend.disconnect()

        # Should only register session once (pooled)
        assert mock_register.call_count == 1, "Connection should be reused from pool"


@pytest.mark.asyncio
async def test_pool_cleanup_removes_idle_connections():
    """Test that cleanup removes idle connections."""
    from datetime import timedelta

    pool = SMBConnectionPool(
        max_idle_time=timedelta(milliseconds=100),  # Very short for testing
    )

    with (
        patch("smbclient.register_session"),
        patch("smbclient.reset_connection_cache") as mock_reset,
    ):
        # Create a connection
        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
        ):
            pass

        # Connection should be in pool
        stats = pool.get_stats()
        assert stats["total_connections"] == 1

        # Wait for connection to become idle
        await asyncio.sleep(0.15)  # Longer than max_idle_time

        # Run cleanup
        await pool.cleanup_idle_connections()

        # Connection should be removed
        stats = pool.get_stats()
        assert stats["total_connections"] == 0
        assert mock_reset.call_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("wall_clock_shift", [timedelta(hours=1), timedelta(hours=-1)])
async def test_pool_idle_timeout_ignores_wall_clock_changes(wall_clock_shift):
    """Clock changes must not shorten or extend the five-minute idle timeout."""
    pool = SMBConnectionPool(max_idle_time=timedelta(minutes=5))
    created = datetime(2026, 1, 1, tzinfo=timezone.utc)
    with (
        patch("smbclient.register_session"),
        patch("smbclient.reset_connection_cache") as reset,
        patch("app.storage.smb_pool.monotonic", return_value=0.0) as elapsed,
        patch("app.storage.smb_pool.datetime") as wall_clock,
    ):
        wall_clock.now.return_value = created
        async with pool.get_connection(host="test-host", port=445, username="user", password="pass", share_name="share"):
            pass
        assert next(iter(pool._connections.values())).created_at == created
        wall_clock.now.return_value = created + wall_clock_shift
        elapsed.return_value = timedelta(minutes=2).total_seconds()
        await pool.cleanup_idle_connections()
        assert pool.get_stats()["idle_connections"] == 1
        reset.assert_not_called()

        elapsed.return_value = timedelta(minutes=6).total_seconds()
        await pool.cleanup_idle_connections()
        assert pool.get_stats()["total_connections"] == 0
        reset.assert_called_once()


@pytest.mark.asyncio
async def test_pool_cleanup_preserves_active_connections():
    """Test that cleanup doesn't remove active connections."""
    from datetime import timedelta

    pool = SMBConnectionPool(
        max_idle_time=timedelta(milliseconds=100),
    )

    with (
        patch("smbclient.register_session"),
        patch("smbclient.reset_connection_cache") as mock_reset,
    ):
        async with pool.get_connection(
            host="test-host",
            port=445,
            username="user",
            password="pass",
            share_name="share",
        ):
            # While connection is active, run cleanup
            await asyncio.sleep(0.15)  # Longer than max_idle_time
            await pool.cleanup_idle_connections()

            # Connection should NOT be removed (still in use)
            stats = pool.get_stats()
            assert stats["total_connections"] == 1
            assert stats["active_connections"] == 1
            assert mock_reset.call_count == 0


@pytest.mark.asyncio
async def test_pool_close_all():
    """Test that close_all properly closes all connections."""
    pool = SMBConnectionPool()

    with (
        patch("smbclient.register_session"),
        patch("smbclient.reset_connection_cache") as mock_reset,
    ):
        # Create multiple connections
        async with pool.get_connection("host1", 445, "user", "pass", "share"):
            pass
        async with pool.get_connection("host2", 445, "user", "pass", "share"):
            pass

        # Should have 2 connections
        stats = pool.get_stats()
        assert stats["total_connections"] == 2

        # Close all
        await pool.close_all()

        # All connections should be removed
        stats = pool.get_stats()
        assert stats["total_connections"] == 0
        assert mock_reset.call_count == 2


@pytest.mark.asyncio
async def test_global_pool_singleton():
    """Test that get_connection_pool returns singleton instance."""
    pool1 = await get_connection_pool()
    pool2 = await get_connection_pool()

    assert pool1 is pool2, "Should return same instance"
