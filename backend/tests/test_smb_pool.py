"""
Tests for SMB Connection Pool

Verifies that SMB connections are properly pooled and reused across requests.
"""

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.api._smb_helpers import build_smb_backend
from app.models.connection import Connection
from app.storage.smb import SMBBackend
from app.storage.smb_pool import SMBConnectionPool, get_connection_pool, get_smb_connection_cache


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
