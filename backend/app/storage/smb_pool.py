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
import hashlib
import logging
import threading
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import partial
from time import monotonic
from typing import Any, Optional

import smbclient
from smbprotocol.connection import Connection as ProtocolConnection

from app.services.system_settings import get_smbclient_policy_kwargs
from app.storage.smb_errors import SMBConnectionCapacityError, SMBConnectionRetired, SMBOperationTimeout
from app.utils.worker_wait import wait_for_worker

logger = logging.getLogger(__name__)

MAX_CONNECTION_GENERATIONS = 64
MAX_SOURCE_GENERATIONS = 2
MAX_CONNECTION_SETUPS = 8
MAX_CONNECTION_ADMISSIONS = 128
MAX_SOURCE_ADMISSIONS = 16
CONNECTION_SETUP_TIMEOUT_SECONDS = 30.0

_connection_context_caches: dict[str, dict[str, Any]] = {}
_connection_context_lock = threading.RLock()


class ScanCreditConnection(ProtocolConnection):  # type: ignore[misc]
    """Keep whole scan compounds inside the same credit lock as ordinary sends."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.sequence_lock = threading.RLock()

    def send_scan_compound(
        self, messages: list[Any], session_id: int, tree_id: int, *, reserve: int, credit_target: int
    ) -> list[Any] | None:
        if not messages or reserve < 1 or credit_target < 1:
            raise ValueError("Scan credit admission requires messages and positive credit limits.")
        with self.sequence_lock:
            charge = sum(max(1, self._calculate_credit_charge(message)) for message in messages)
            available = self.sequence_window["high"] - self.sequence_window["low"]
            if available < charge + reserve:
                return None
            requests: list[Any] = self._send(
                messages,
                session_id=session_id,
                tree_id=tree_id,
                related=True,
                credit_request=charge + 1 if available < credit_target else None,
            )
            return requests


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
    source_key: str = ""
    setup: asyncio.Task[None] | None = None
    resetting: bool = False
    abort_task: asyncio.Task[None] | None = None
    generation_id: str = field(default_factory=lambda: uuid.uuid4().hex)


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
        self._background_tasks: set[asyncio.Task[None]] = set()
        self._closing = False

    def _retain_task(self, task: asyncio.Task[None]) -> None:
        self._background_tasks.add(task)

        def completed(result: asyncio.Task[None]) -> None:
            self._background_tasks.discard(result)
            if not result.cancelled():
                result.exception()

        task.add_done_callback(completed)

    async def _register(self, pool_key: int, conn: PooledConnection, password: str) -> None:
        def register() -> None:
            policy = get_smbclient_policy_kwargs()
            connection_key = f"{conn.host.lower()}:{conn.port}"
            connection = conn.connection_cache.get(connection_key)
            if connection is None or connection.transport is None or not connection.transport.connected:
                connection = ScanCreditConnection(
                    smbclient.ClientConfig().client_guid, conn.host, conn.port, require_signing=policy["require_signing"]
                )
                conn.connection_cache[connection_key] = connection
                connection.connect(timeout=policy["connection_timeout"])
            smbclient.register_session(
                conn.host,
                username=conn.username,
                password=password,
                port=conn.port,
                connection_cache=conn.connection_cache,
                **policy,
            )

        try:
            await asyncio.get_running_loop().run_in_executor(None, register)
        except BaseException:
            conn.retire_when_idle = True
            raise
        finally:
            await self._release_connection_reference(pool_key, conn.host, conn.port, conn.share_name)

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

        async with self._lock:
            if self._closing:
                raise SMBConnectionRetired("SMB connection pool is shutting down. Reconnect after the service restarts.")
            existing = self._connections.get(pool_key)
            with _connection_context_lock:
                source_key = next(
                    (key for key, cache in _connection_context_caches.items() if cache is connection_cache),
                    existing.source_key if existing is not None else repr((host.lower(), port, username, share_name)),
                )
            source_connections = [entry for entry in self._connections.values() if entry.source_key == source_key]
            required_references = 1 + (existing is None)
            if (
                sum(entry.reference_count for entry in self._connections.values()) + required_references > MAX_CONNECTION_ADMISSIONS
                or sum(entry.reference_count for entry in source_connections) + required_references > MAX_SOURCE_ADMISSIONS
            ):
                raise SMBConnectionCapacityError("SMB work capacity is busy. Wait briefly and retry; active work is retained.")
            conn = self._connections.get(pool_key)
            if conn is None:
                if (
                    len(self._connections) >= MAX_CONNECTION_GENERATIONS
                    or len(source_connections) >= MAX_SOURCE_GENERATIONS
                    or sum(entry.setup is not None and not entry.setup.done() for entry in self._connections.values())
                    >= MAX_CONNECTION_SETUPS
                ):
                    raise SMBConnectionCapacityError("SMB recovery capacity is busy. Wait for retained workers to finish, then retry.")
                conn = PooledConnection(
                    host=host,
                    port=port,
                    username=username,
                    share_name=share_name,
                    created_at=datetime.now(timezone.utc),
                    last_used_monotonic=monotonic(),
                    reference_count=1,
                    connection_cache=connection_cache,
                    source_key=source_key,
                )
                self._connections[pool_key] = conn
                conn.setup = asyncio.create_task(self._register(pool_key, conn, password))
                self._retain_task(conn.setup)
            if conn.retire_when_idle:
                raise SMBConnectionRetired("SMB connection context is being retired. Retry with a new connection generation.")
            conn.reference_count += 1
            conn.last_used_monotonic = monotonic()

        try:
            if conn.setup is not None:
                try:
                    await wait_for_worker(conn.setup, CONNECTION_SETUP_TIMEOUT_SECONDS)
                except TimeoutError as error:
                    await self.invalidate_connection_cache(connection_cache, reason="setup_timeout", abort=True)
                    raise SMBOperationTimeout(
                        "SMB connection setup timed out. Wait briefly and reconnect; setup cleanup is retained."
                    ) from error
                except asyncio.CancelledError:
                    if conn.reference_count == 2:
                        await self.invalidate_connection_cache(connection_cache, reason="setup_cancelled")
                    raise
            if conn.retire_when_idle:
                raise SMBConnectionRetired("SMB connection was retired during setup. Reconnect and retry.")
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
            self._retain_task(asyncio.create_task(self._release_connection_reference(pool_key, conn.host, conn.port, conn.share_name)))

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

            if conn.reference_count == 0 and conn.retire_when_idle and not conn.resetting:
                conn.resetting = True
                connection_to_reset = conn

        if connection_to_reset is not None:
            cleanup = asyncio.create_task(self._reset_connection(pool_key, connection_to_reset))
            self._retain_task(cleanup)
            await wait_for_worker(cleanup)

    async def _reset_connection(self, pool_key: int, conn: PooledConnection) -> None:
        try:
            await asyncio.get_running_loop().run_in_executor(
                None, partial(smbclient.reset_connection_cache, fail_on_error=False, connection_cache=conn.connection_cache)
            )
        except Exception as error:
            logger.warning(
                "SMB generation cleanup failed. Check source access before reconnecting.",
                extra={
                    "event": "smb_cleanup_failed",
                    "operation": "reset_connection_cache",
                    "stage": "cleanup",
                    "source_id": hashlib.sha256(conn.source_key.encode()).hexdigest()[:16],
                    "generation_id": conn.generation_id,
                    "error_type": type(error).__name__,
                },
                exc_info=True,
            )
        finally:
            async with self._lock:
                if self._connections.get(pool_key) is conn:
                    self._connections.pop(pool_key)

    #
    # cleanup_idle_connections
    #
    async def cleanup_idle_connections(self) -> None:
        """Remove connections that have been idle for too long."""

        async with self._lock:
            now = monotonic()
            expired = [
                conn.connection_cache
                for conn in self._connections.values()
                if conn.reference_count == 0 and not conn.resetting and now - conn.last_used_monotonic > self._max_idle_time.total_seconds()
            ]
        for cache in expired:
            await self.invalidate_connection_cache(cache, reason="idle_release")

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
                except Exception as error:
                    logger.error(
                        "SMB pool cleanup failed. Check source access before reconnecting.",
                        extra={"event": "smb_pool_cleanup_failed", "stage": "cleanup", "error_type": type(error).__name__},
                        exc_info=True,
                    )

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
            self._closing = True
            caches = [conn.connection_cache for conn in self._connections.values()]
        for cache in caches:
            await self.invalidate_connection_cache(cache, reason="shutdown")

    async def invalidate_connection(
        self,
        host: str,
        port: int,
        username: str,
        share_name: str,
        connection_cache: dict[str, Any] | None = None,
        reason: str | None = None,
        *,
        abort: bool = False,
    ) -> None:
        """Remove a pooled connection and delete its underlying smbclient session."""

        if connection_cache is None:
            legacy_key = (host.lower(), port, username, share_name)
            connection_cache = self._legacy_connection_caches.get(legacy_key)
        if connection_cache is None:
            return

        await self.invalidate_connection_cache(connection_cache, reason=reason, abort=abort)

    async def _abort_generation(self, pool_key: int, conn: PooledConnection, transports: tuple[Any, ...]) -> None:
        """Keep abort capacity owned until every public disconnect call exits."""
        try:
            for transport in transports:
                try:
                    await asyncio.to_thread(transport.disconnect, close=False)
                except Exception as error:
                    logger.warning(
                        "SMB transport abort failed. Retry when capacity is available; restart the service if work remains blocked.",
                        extra={
                            **self.connection_diagnostics(conn.connection_cache),
                            "event": "smb_abort_failed",
                            "operation": "disconnect",
                            "stage": "abort",
                            "error_type": type(error).__name__,
                        },
                        exc_info=True,
                    )
        finally:
            await self._release_connection_reference(pool_key, conn.host, conn.port, conn.share_name)

    async def invalidate_connection_cache(
        self, connection_cache: dict[str, Any], reason: str | None = None, *, abort: bool = False
    ) -> None:
        """Close a private cache after its active pool leases have finished."""

        pool_key = self._get_pool_key(connection_cache)

        async with self._lock:
            conn = self._connections.get(pool_key)
            with _connection_context_lock:
                for source_key, cache in list(_connection_context_caches.items()):
                    if cache is connection_cache:
                        _connection_context_caches.pop(source_key)
            if conn is not None and conn.resetting:
                return
            was_retired = conn.retire_when_idle if conn is not None else False
            if conn is not None and abort and conn.abort_task is None:
                conn.retire_when_idle = True
                transports = tuple(connection_cache.copy().values())
                conn.reference_count += 1
                conn.abort_task = asyncio.create_task(self._abort_generation(pool_key, conn, transports))
                self._retain_task(conn.abort_task)
            if conn is not None and conn.reference_count > 0:
                conn.retire_when_idle = True
                if not was_retired:
                    logger.warning(
                        "SMB generation retired; cleanup waits for retained leases.",
                        extra={
                            "event": "smb_generation_retired",
                            "stage": "retirement",
                            "source_id": hashlib.sha256(conn.source_key.encode()).hexdigest()[:16],
                            "generation_id": conn.generation_id,
                            "retained_worker_count": conn.reference_count,
                        },
                    )
                return

            if conn is not None:
                conn.retire_when_idle = True
                conn.resetting = True

        if conn is not None:
            cleanup = asyncio.create_task(self._reset_connection(pool_key, conn))
            self._retain_task(cleanup)
            await wait_for_worker(cleanup)
        else:
            future = asyncio.get_running_loop().run_in_executor(
                None,
                partial(smbclient.reset_connection_cache, fail_on_error=False, connection_cache=connection_cache),
            )
            await wait_for_worker(future)

    #
    # get_stats
    #
    def connection_diagnostics(self, connection_cache: dict[str, Any]) -> dict[str, str | int]:
        """Copy opaque ownership fields on the pool's event-loop thread."""
        connection = self._connections.get(self._get_pool_key(connection_cache))
        if connection is None:
            return {}
        return {
            "source_id": hashlib.sha256(connection.source_key.encode()).hexdigest()[:16],
            "generation_id": connection.generation_id,
            "retained_worker_count": connection.reference_count,
        }

    def generation_aborting(self, connection_cache: dict[str, Any]) -> bool:
        """Read the acquired generation's abort state on the event-loop thread."""
        connection = self._connections.get(self._get_pool_key(connection_cache))
        return connection is not None and connection.abort_task is not None

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
