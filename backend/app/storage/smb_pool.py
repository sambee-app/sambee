"""
SMB Connection Pool

Manages a pool of SMB connections with automatic reuse across requests.
This eliminates the connection overhead (TCP handshake + SMB negotiation)
for subsequent requests to the same server.

Key Features:
- Thread-safe connection sharing
- Reference counting for automatic cleanup
- Connection health checks
- Per-server connection limits
"""

import asyncio
import logging
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import partial
from time import monotonic
from typing import Any, Optional

import smbclient

from app.services.system_settings import get_smbclient_policy_kwargs

logger = logging.getLogger(__name__)

_connection_context_caches: dict[str, dict[str, Any]] = {}
_connection_context_lock = threading.RLock()


def get_smb_connection_cache(connection_context_key: str) -> dict[str, Any]:
    """Return the stable private smbclient cache for a persisted connection."""

    with _connection_context_lock:
        return _connection_context_caches.setdefault(connection_context_key, {})


def _pop_smb_connection_cache(connection_context_key: str) -> dict[str, Any] | None:
    with _connection_context_lock:
        return _connection_context_caches.pop(connection_context_key, None)


@dataclass
class PooledConnection:
    """Represents a pooled SMB connection with metadata."""

    host: str
    port: int
    username: str
    share_name: str
    created_at: datetime
    last_used_monotonic: float
    reference_count: int
    connection_cache: dict[str, Any]
    retire_when_idle: bool = False


class SMBConnectionPool:
    """
    Thread-safe pool of SMB connections.

    Connections are identified by (host, port, username, share_name).
    Multiple requests to the same server reuse the same connection.
    """

    #
    # __init__
    #
    def __init__(
        self,
        max_idle_time: timedelta = timedelta(minutes=5),
        cleanup_interval: timedelta = timedelta(minutes=1),
    ):
        """
        Initialize the connection pool.

        Args:
            max_idle_time: How long to keep idle connections alive
            cleanup_interval: How often to run cleanup of idle connections
        """

        self._connections: dict[int, PooledConnection] = {}
        self._lock = asyncio.Lock()
        self._max_idle_time = max_idle_time
        self._cleanup_interval = cleanup_interval
        self._cleanup_task: Optional[asyncio.Task[None]] = None
        self._legacy_connection_caches: dict[tuple[str, int, str, str], dict[str, Any]] = {}

    #
    # _get_pool_key
    #
    def _get_pool_key(self, connection_cache: dict[str, Any]) -> int:
        """Generate an identity key for an isolated smbclient cache."""

        return id(connection_cache)

    @asynccontextmanager
    async def get_connection(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        share_name: str,
        connection_cache: dict[str, Any] | None = None,
    ) -> AsyncIterator[None]:
        """
        Acquire a connection from the pool (or create if needed).

        This is a context manager that automatically handles reference counting.
        The connection is released when the context exits.

        Usage:
            async with pool.get_connection(...):
                # Use smbclient operations here
                # The connection is guaranteed to be active
                result = smbclient.scandir(path, username=username, password=password)

        Args:
            host: SMB server hostname or IP
            port: SMB server port (usually 445)
            username: Username for authentication
            password: Password for authentication
            share_name: SMB share name

        Yields:
            None (connection is managed internally by smbclient)
        """
        if connection_cache is None:
            legacy_key = (host.lower(), port, username, share_name)
            connection_cache = self._legacy_connection_caches.setdefault(legacy_key, {})
        pool_key = self._get_pool_key(connection_cache)

        # Acquire connection
        async with self._lock:
            if pool_key in self._connections:
                # Reuse existing connection
                conn = self._connections[pool_key]
                if conn.retire_when_idle:
                    raise RuntimeError("SMB connection context is being retired")
                conn.reference_count += 1
                conn.last_used_monotonic = monotonic()
                logger.debug(f"Reusing pooled connection: {host}:{port}/{share_name} (refs={conn.reference_count})")
            else:
                # Create new connection
                logger.debug(f"Creating new pooled connection: {host}:{port}/{share_name}")

                # Register session with smbclient (establishes connection)
                try:
                    await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: smbclient.register_session(
                            host,
                            username=username,
                            password=password,
                            port=port,
                            connection_cache=connection_cache,
                            **get_smbclient_policy_kwargs(),
                        ),
                    )
                except Exception as e:
                    logger.error(
                        f"Failed to create SMB connection to {host}:{port}: {e}",
                        exc_info=True,
                    )
                    raise

                # Add to pool
                conn = PooledConnection(
                    host=host,
                    port=port,
                    username=username,
                    share_name=share_name,
                    created_at=datetime.now(timezone.utc),
                    last_used_monotonic=monotonic(),
                    reference_count=1,
                    connection_cache=connection_cache,
                )
                self._connections[pool_key] = conn

                logger.debug(f"SMB connection pooled: {host}:{port}/{share_name}")

        try:
            # Yield control to caller (connection is ready)
            yield

        finally:
            await self._release_connection_reference(pool_key, host, port, share_name)

    async def retain_connection_until_future_complete(
        self,
        connection_cache: dict[str, Any],
        operation_future: asyncio.Future[Any],
    ) -> None:
        """Keep a cache alive while non-cancellable executor work is still running."""

        if operation_future.done():
            return

        pool_key = self._get_pool_key(connection_cache)
        async with self._lock:
            conn = self._connections.get(pool_key)
            if conn is None:
                return
            conn.reference_count += 1
            conn.last_used_monotonic = monotonic()

        def release_when_complete(_future: asyncio.Future[Any]) -> None:
            asyncio.create_task(self._release_connection_reference(pool_key, conn.host, conn.port, conn.share_name))

        operation_future.add_done_callback(release_when_complete)

    async def _release_connection_reference(self, pool_key: int, host: str, port: int, share_name: str) -> None:
        """Release one pool lease and reset a retired cache once all work ends."""

        connection_to_reset: PooledConnection | None = None
        async with self._lock:
            conn = self._connections.get(pool_key)
            if conn is None:
                return

            conn.reference_count -= 1
            conn.last_used_monotonic = monotonic()
            logger.debug(f"Released pooled connection: {host}:{port}/{share_name} (refs={conn.reference_count})")

            if conn.reference_count == 0 and conn.retire_when_idle:
                connection_to_reset = self._connections.pop(pool_key)

        if connection_to_reset is not None:
            await asyncio.get_event_loop().run_in_executor(
                None,
                partial(
                    smbclient.reset_connection_cache,
                    fail_on_error=False,
                    connection_cache=connection_to_reset.connection_cache,
                ),
            )

    #
    # cleanup_idle_connections
    #
    async def cleanup_idle_connections(self) -> None:
        """Remove connections that have been idle for too long."""

        async with self._lock:
            now = monotonic()
            to_remove = []

            for pool_key, conn in self._connections.items():
                # Only remove if not actively in use
                if conn.reference_count == 0:
                    idle_time = now - conn.last_used_monotonic
                    if idle_time > self._max_idle_time.total_seconds():
                        to_remove.append(pool_key)

            # Remove idle connections
            for pool_key in to_remove:
                conn = self._connections[pool_key]
                logger.debug(
                    f"Removing idle connection: {conn.host}:{conn.port}/{conn.share_name} (idle for {now - conn.last_used_monotonic:.0f}s)"
                )

                # Disconnect only this backend's private smbclient cache.
                try:
                    await asyncio.get_event_loop().run_in_executor(
                        None,
                        partial(smbclient.reset_connection_cache, fail_on_error=False, connection_cache=conn.connection_cache),
                    )
                except Exception as e:
                    logger.warning(f"Error deleting session for {conn.host}:{conn.port}: {e}")

                del self._connections[pool_key]

            if to_remove:
                logger.debug(f"Cleaned up {len(to_remove)} idle connection(s), {len(self._connections)} remaining")

    #
    # start_cleanup_task
    #
    async def start_cleanup_task(self) -> None:
        """Start the background cleanup task."""

        if self._cleanup_task is not None:
            return  # Already running

        async def cleanup_loop() -> None:
            """Periodically clean up idle connections."""
            while True:
                try:
                    await asyncio.sleep(self._cleanup_interval.total_seconds())
                    await self.cleanup_idle_connections()
                except asyncio.CancelledError:
                    logger.info("Connection pool cleanup task cancelled")
                    break
                except Exception as e:
                    logger.error(f"Error in cleanup task: {e}", exc_info=True)

        self._cleanup_task = asyncio.create_task(cleanup_loop())
        logger.debug("Started SMB connection pool cleanup task")

    #
    # stop_cleanup_task
    #
    async def stop_cleanup_task(self) -> None:
        """Stop the background cleanup task."""

        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None

    #
    # close_all
    #
    async def close_all(self) -> None:
        """Close all pooled connections (for shutdown)."""

        async with self._lock:
            loop = asyncio.get_event_loop()
            for pool_key, conn in self._connections.items():
                try:
                    logger.info(f"Closing connection: {conn.host}:{conn.port}/{conn.share_name}")
                    # Run in executor to avoid blocking the event loop during
                    # the SMB disconnect handshake.
                    await loop.run_in_executor(
                        None,
                        partial(smbclient.reset_connection_cache, fail_on_error=False, connection_cache=conn.connection_cache),
                    )
                except Exception as e:
                    logger.warning(f"Error closing connection {conn.host}:{conn.port}: {e}")

            self._connections.clear()
            logger.info("All SMB connections closed")

    async def invalidate_connection(
        self,
        host: str,
        port: int,
        username: str,
        share_name: str,
        connection_cache: dict[str, Any] | None = None,
        reason: str | None = None,
    ) -> None:
        """Remove a pooled connection and delete its underlying smbclient session."""

        if connection_cache is None:
            legacy_key = (host.lower(), port, username, share_name)
            connection_cache = self._legacy_connection_caches.get(legacy_key)
        if connection_cache is None:
            return

        await self.invalidate_connection_cache(connection_cache, reason=reason)

    async def invalidate_connection_cache(self, connection_cache: dict[str, Any], reason: str | None = None) -> None:
        """Close a private cache after its active pool leases have finished."""

        pool_key = self._get_pool_key(connection_cache)

        async with self._lock:
            conn = self._connections.get(pool_key)
            if conn is not None and conn.reference_count > 0:
                conn.retire_when_idle = True
                logger.warning(
                    "Deferring invalidation of active pooled connection: %s:%s/%s%s",
                    conn.host,
                    conn.port,
                    conn.share_name,
                    f" ({reason})" if reason else "",
                )
                return

            if conn is not None:
                self._connections.pop(pool_key)

        try:
            if conn is not None:
                logger.warning(
                    "Invalidating pooled connection: %s:%s/%s%s",
                    conn.host,
                    conn.port,
                    conn.share_name,
                    f" ({reason})" if reason else "",
                )
            await asyncio.get_event_loop().run_in_executor(
                None,
                partial(smbclient.reset_connection_cache, fail_on_error=False, connection_cache=connection_cache),
            )
        except Exception as e:
            if conn is None:
                logger.warning("Error invalidating unpooled SMB cache: %s", e)
            else:
                logger.warning(f"Error invalidating connection {conn.host}:{conn.port}: {e}")

    #
    # get_stats
    #
    def get_stats(self) -> dict[str, int]:
        """
        Get statistics about the connection pool.

        Returns:
            Dictionary with pool statistics
        """

        total_refs = sum(conn.reference_count for conn in self._connections.values())
        active_conns = sum(1 for conn in self._connections.values() if conn.reference_count > 0)

        return {
            "total_connections": len(self._connections),
            "active_connections": active_conns,
            "idle_connections": len(self._connections) - active_conns,
            "total_references": total_refs,
        }


# Global singleton instance
_pool: Optional[SMBConnectionPool] = None
_pool_lock = asyncio.Lock()


#
# get_connection_pool
#
async def get_connection_pool() -> SMBConnectionPool:
    """
    Get the global SMB connection pool instance.

    Creates the pool on first access and starts the cleanup task.

    Returns:
        The global connection pool
    """

    global _pool

    if _pool is None:
        async with _pool_lock:
            if _pool is None:  # Double-check after acquiring lock
                _pool = SMBConnectionPool()
                await _pool.start_cleanup_task()
                logger.info("Initialized global SMB connection pool")

    return _pool


#
# shutdown_connection_pool
#
async def shutdown_connection_pool() -> None:
    """Shutdown the global connection pool (for application shutdown)."""

    global _pool

    if _pool is not None:
        await _pool.stop_cleanup_task()
        await _pool.close_all()
        _pool = None
        logger.info("SMB connection pool shut down")


async def retire_smb_connection_context(connection_context_key: str, reason: str) -> None:
    """Close the private cache associated with one persisted connection."""

    connection_cache = _pop_smb_connection_cache(connection_context_key)
    if connection_cache is None:
        return

    if _pool is not None:
        await _pool.invalidate_connection_cache(connection_cache, reason=reason)
        return

    await asyncio.get_running_loop().run_in_executor(
        None,
        partial(smbclient.reset_connection_cache, fail_on_error=False, connection_cache=connection_cache),
    )


async def retire_all_smb_connection_contexts(reason: str) -> None:
    """Close every private cache after a global SMB policy change."""

    with _connection_context_lock:
        connection_caches = list(_connection_context_caches.values())
        _connection_context_caches.clear()

    for connection_cache in connection_caches:
        if _pool is not None:
            await _pool.invalidate_connection_cache(connection_cache, reason=reason)
        else:
            await asyncio.get_running_loop().run_in_executor(
                None,
                partial(smbclient.reset_connection_cache, fail_on_error=False, connection_cache=connection_cache),
            )
