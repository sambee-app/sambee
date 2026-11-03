"""
Directory monitoring service using SMB change notifications.
Monitors directories for changes and notifies WebSocket clients.
"""

import asyncio
import hashlib
import logging
import random
import threading
from collections.abc import Awaitable, Callable
from typing import Dict, Optional
from uuid import uuid4

from smbprotocol.change_notify import (
    CompletionFilter,
    FileAction,
    FileSystemWatcher,
)
from smbprotocol.connection import Connection
from smbprotocol.header import NtStatus
from smbprotocol.open import (
    CreateDisposition,
    CreateOptions,
    DirectoryAccessMask,
    FileAttributes,
    ImpersonationLevel,
    Open,
    ShareAccess,
)
from smbprotocol.session import Session
from smbprotocol.tree import TreeConnect

from app.services.system_settings import get_smbclient_policy_kwargs
from app.storage.smb_errors import translate_smb_target_error
from app.utils.worker_wait import wait_for_worker

logger = logging.getLogger(__name__)

# Connection retry configuration
MAX_RETRY_ATTEMPTS = 5
INITIAL_RETRY_DELAY = 1.0  # seconds
MAX_RETRY_DELAY = 60.0  # seconds
RETRY_BACKOFF_MULTIPLIER = 2.0
RETRY_JITTER_FACTOR = 0.1  # 10% jitter

# Timeout configuration
SMB_CONNECT_TIMEOUT = 30  # seconds for initial connection
SMB_OPERATION_TIMEOUT = 60  # seconds for SMB operations
DIRECTORY_ONLY_NOTIFY_FLAGS = 0


class DirectoryMonitor:
    """
    Monitors SMB directories for changes using SMB2_CHANGE_NOTIFY.
    Manages directory handles and watchers with proper cleanup.
    """

    #
    # __init__
    #
    def __init__(self) -> None:
        # Map: "connection_id:path" -> MonitoredDirectory
        self._monitors: Dict[str, "MonitoredDirectory"] = {}
        self._lock = threading.Lock()
        self._starting: dict[str, threading.Event] = {}
        self._connection_generations: dict[str, int] = {}
        self._running = True
        self._startup_cleanups: set[asyncio.Task[None]] = set()

    def get_connection_generation(self, connection_id: str) -> int:
        """Return the lifecycle generation used to detect stale startups."""

        with self._lock:
            return self._connection_generations.get(connection_id, 0)

    #
    # start_monitoring
    #
    def start_monitoring(
        self,
        connection_id: str,
        path: str,
        host: str,
        share_name: str,
        username: str,
        password: str,
        port: int = 445,
        on_change_callback: Optional[Callable[[str, str], Awaitable[None]]] = None,
        expected_generation: int | None = None,
    ) -> "MonitoredDirectory":
        """
        Start monitoring a directory for changes.

        Args:
            connection_id: Unique connection identifier
            path: Directory path to monitor (relative to share root)
            host: SMB server hostname
            share_name: SMB share name
            username: SMB username
            password: SMB password
            port: SMB port
            on_change_callback: Async callback function(connection_id, path) called on changes
        """

        key = f"{connection_id}:{path}"
        with self._lock:
            requested_generation = (
                self._connection_generations.get(connection_id, 0) if expected_generation is None else expected_generation
            )

        while True:
            with self._lock:
                if not self._running:
                    raise RuntimeError("Directory monitoring is shutting down. Reconnect after the service restarts.")
                if self._connection_generations.get(connection_id, 0) != requested_generation:
                    raise RuntimeError("Connection was retired before monitoring could start. Reconnect and subscribe again.")

                existing_monitor = self._monitors.get(key)
                if existing_monitor is not None and existing_monitor.stopped is True:
                    del self._monitors[key]
                    existing_monitor = None
                if existing_monitor is not None:
                    existing_monitor.subscriber_count += 1
                    logger.debug("File-list subscriber added.")
                    return existing_monitor

                start_event = self._starting.get(key)
                if start_event is None:
                    start_event = threading.Event()
                    self._starting[key] = start_event
                    connection_generation = requested_generation
                    break

            start_event.wait()

        monitor = MonitoredDirectory(
            connection_id=connection_id,
            path=path,
            host=host,
            share_name=share_name,
            username=username,
            password=password,
            port=port,
            on_change_callback=on_change_callback,
        )
        monitor_stopped = threading.Event()

        def retire_monitor() -> None:
            monitor_stopped.set()
            with self._lock:
                if self._monitors.get(key) is monitor:
                    del self._monitors[key]

        monitor.on_stopped = retire_monitor
        try:
            monitor.start()
        except Exception as error:
            with self._lock:
                self._starting.pop(key, None)
                start_event.set()
            translated = translate_smb_target_error(error, path)
            if translated is not error:
                raise translated from error
            raise

        with self._lock:
            connection_retired = not self._running or self._connection_generations.get(connection_id, 0) != connection_generation
            stopped_during_start = monitor_stopped.is_set()
            if not connection_retired and not stopped_during_start:
                self._monitors[key] = monitor
            self._starting.pop(key, None)
            start_event.set()

        if connection_retired:
            monitor.stop()
            raise RuntimeError("Connection was retired during monitoring startup. Reconnect and subscribe again.")
        if stopped_during_start:
            raise RuntimeError("Directory monitoring stopped during startup")

        logger.debug("File-list monitoring started.")
        return monitor

    async def start_monitoring_async(
        self,
        connection_id: str,
        path: str,
        host: str,
        share_name: str,
        username: str,
        password: str,
        port: int = 445,
        on_change_callback: Optional[Callable[[str, str], Awaitable[None]]] = None,
        expected_generation: int | None = None,
    ) -> None:
        """Start a monitor without blocking the application event loop."""

        future = asyncio.get_running_loop().run_in_executor(
            None,
            lambda: self.start_monitoring(
                connection_id, path, host, share_name, username, password, port, on_change_callback, expected_generation
            ),
        )
        try:
            await wait_for_worker(future)
        except asyncio.CancelledError:

            async def release_cancelled_start() -> None:
                try:
                    acquired = await wait_for_worker(future)
                    await asyncio.to_thread(self._release_subscription, f"{connection_id}:{path}", acquired)
                except Exception:
                    logger.warning("Cancelled file-list startup finished with an error.", exc_info=True)

            cleanup = asyncio.create_task(release_cancelled_start())
            self._startup_cleanups.add(cleanup)
            cleanup.add_done_callback(self._startup_cleanups.discard)
            raise

    #
    # stop_monitoring
    #
    def stop_monitoring(self, connection_id: str, path: str) -> None:
        """
        Stop monitoring a directory (decreases subscriber count, stops when 0).

        Args:
            connection_id: Connection identifier
            path: Directory path
        """

        key = f"{connection_id}:{path}"
        self._release_subscription(key)

    def _release_subscription(self, key: str, expected: "MonitoredDirectory | None" = None) -> None:
        """Release only the monitor acquired by an abandoned startup, if supplied."""
        with self._lock:
            if key not in self._monitors or (expected is not None and self._monitors[key] is not expected):
                logger.debug("File-list subscription is already stopped.")
                return

            monitor = self._monitors[key]
            monitor.subscriber_count -= 1

            if monitor.subscriber_count <= 0:
                logger.debug("Last file-list subscriber removed.")
                del self._monitors[key]
            else:
                logger.debug("File-list subscriber removed.")
                return

        try:
            monitor.stop()
        except Exception:
            logger.error("File-list monitor could not be stopped. Retry after its worker exits.", exc_info=True)

    def stop_connection(self, connection_id: str) -> None:
        """Stop every active monitor associated with a connection."""

        with self._lock:
            self._connection_generations[connection_id] = self._connection_generations.get(connection_id, 0) + 1
            monitors = [(key, monitor) for key, monitor in self._monitors.items() if monitor.connection_id == connection_id]
            for key, _ in monitors:
                del self._monitors[key]

        for key, monitor in monitors:
            try:
                monitor.stop()
            except Exception:
                logger.warning("Retired file-list monitor is still stopping.", exc_info=True)

    async def stop_connection_async(self, connection_id: str) -> None:
        """Stop a connection's monitors without blocking the application event loop."""

        await asyncio.to_thread(self.stop_connection, connection_id)

    def restart_all(self) -> None:
        """Reconnect active monitors so they apply the current SMB policy."""

        with self._lock:
            monitors = list(self._monitors.items())

        for key, monitor in monitors:
            try:
                monitor.restart()
            except Exception:
                logger.warning("File-list monitor could not restart after the policy update.", exc_info=True)

    async def restart_all_async(self) -> None:
        """Reconnect monitors without blocking the application event loop."""

        await asyncio.to_thread(self.restart_all)

    #
    # stop_all
    #
    def stop_all(self) -> None:
        """Stop all monitors and clean up resources."""

        with self._lock:
            self._running = False
            monitors = list(self._monitors.items())
            self._monitors.clear()

        for key, monitor in monitors:
            try:
                monitor.stop()
            except Exception:
                logger.error("File-list monitor shutdown failed. Its worker retains resources until exit.", exc_info=True)

        logger.info("All directory monitors stopped")


class MonitoredDirectory:
    """
    Represents a single monitored directory with its SMB handles and watcher.
    Handles proper resource cleanup to prevent handle leaks.
    """

    #
    # __init__
    #
    def __init__(
        self,
        connection_id: str,
        path: str,
        host: str,
        share_name: str,
        username: str,
        password: str,
        port: int,
        on_change_callback: Optional[Callable[[str, str], Awaitable[None]]] = None,
    ) -> None:
        self.connection_id = connection_id
        self.path = path
        self.host = host
        self.share_name = share_name
        self.username = username
        self.password = password
        self.port = port
        self.on_change_callback = on_change_callback
        self.subscriber_count = 1
        self.on_stopped: Callable[[], None] | None = None

        # SMB resources - must be cleaned up
        self._connection: Optional[Connection] = None
        self._session: Optional[Session] = None
        self._tree: Optional[TreeConnect] = None
        self._open: Optional[Open] = None
        self._watcher: Optional[FileSystemWatcher] = None
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._lifecycle_lock = threading.Lock()
        self._retired = False
        self._restarting = False

        # Retry state
        self._retry_count = 0
        self._consecutive_failures = 0
        self._failure_reported = False
        self._log_context = {
            "source_id": hashlib.sha256(connection_id.encode()).hexdigest()[:16],
            "generation_id": uuid4().hex,
            "operation": "file_list_watch",
            "stage": "watcher",
        }

    @property
    def _logger(self) -> logging.LoggerAdapter[logging.Logger]:
        return logging.LoggerAdapter(logger, self._log_context, merge_extra=True)

    def _report_watcher_failure(self, error: Exception) -> None:
        """Keep one cause until a watcher result confirms recovery."""
        if not self._failure_reported:
            self._failure_reported = True
            self._logger.warning(
                "File-list watcher is unavailable. Background recovery remains active.",
                extra={"event": "directory_watcher_unavailable", "error_type": type(error).__name__},
                exc_info=error,
            )

    @property
    def stopped(self) -> bool:
        return self._retired or (self._stop_event.is_set() and not self._restarting)

    #
    # start
    #
    def start(self) -> None:
        """Start monitoring this directory."""

        try:
            policy = get_smbclient_policy_kwargs()
            # Establish SMB connection
            self._connection = Connection(guid=None, server_name=self.host, port=self.port, require_signing=True)
            self._connection.connect(timeout=int(policy["connection_timeout"]))

            # Create session
            self._session = Session(
                self._connection,
                username=self.username,
                password=self.password,
                require_encryption=bool(policy["encrypt"]),
                auth_protocol=str(policy["auth_protocol"]),
            )
            self._session.connect()

            # Connect to tree (share)
            self._tree = TreeConnect(self._session, rf"\\{self.host}\{self.share_name}")
            self._tree.connect()

            # Open directory for change notification
            # Convert path to Windows format
            windows_path = self.path.replace("/", "\\") if self.path else ""

            self._open = Open(self._tree, windows_path)
            self._open.create(
                impersonation_level=ImpersonationLevel.Impersonation,
                desired_access=DirectoryAccessMask.FILE_LIST_DIRECTORY | DirectoryAccessMask.SYNCHRONIZE,
                file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY,
                share_access=ShareAccess.FILE_SHARE_READ | ShareAccess.FILE_SHARE_WRITE | ShareAccess.FILE_SHARE_DELETE,
                create_disposition=CreateDisposition.FILE_OPEN,
                create_options=CreateOptions.FILE_DIRECTORY_FILE,
            )

            # Create watcher
            self._watcher = FileSystemWatcher(self._open)

            # Start monitoring in background thread
            self._monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
            self._monitor_thread.start()

        except Exception as error:
            self._cleanup()
            translated = translate_smb_target_error(error, self.path)
            if isinstance(translated, (FileNotFoundError, PermissionError, NotADirectoryError)):
                raise translated from error
            if self._stop_event.is_set():
                raise
            self._report_watcher_failure(error)
            self._monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True)
            self._monitor_thread.start()

    #
    # _reconnect
    #
    def _reconnect(self) -> None:
        """Reconnect to SMB server after connection loss with exponential backoff."""

        self._consecutive_failures += 1

        if self._consecutive_failures == MAX_RETRY_ATTEMPTS + 1:
            self._logger.warning(
                "File-list watcher fast retries exhausted. Capped background retries remain active.",
                extra={"event": "directory_watcher_retry_exhausted"},
            )

        # Calculate delay with exponential backoff and jitter
        base_delay = min(
            INITIAL_RETRY_DELAY * (RETRY_BACKOFF_MULTIPLIER ** min(self._consecutive_failures - 1, MAX_RETRY_ATTEMPTS + 1)),
            MAX_RETRY_DELAY,
        )
        jitter = base_delay * RETRY_JITTER_FACTOR * (random.random() * 2 - 1)  # +/- 10%
        delay = min(MAX_RETRY_DELAY, max(0, base_delay + jitter))

        if self._consecutive_failures <= MAX_RETRY_ATTEMPTS:
            self._logger.info(
                "File-list watcher retry scheduled.",
                extra={"event": "directory_watcher_retry", "retry_seconds": delay},
            )

        # Wait before reconnecting
        if self._stop_event.wait(delay):
            return  # Stop event was set during wait

        # Establish new SMB connection with timeout handling
        policy = get_smbclient_policy_kwargs()

        # Establish new SMB connection with timeout handling
        try:
            self._connection = Connection(guid=None, server_name=self.host, port=self.port, require_signing=True)
            self._connection.connect(timeout=int(policy["connection_timeout"]))
        except Exception:
            raise

        # Create new session
        self._session = Session(
            self._connection,
            username=self.username,
            password=self.password,
            require_encryption=bool(policy["encrypt"]),
            auth_protocol=str(policy["auth_protocol"]),
        )
        self._session.connect()

        # Connect to tree (share)
        self._tree = TreeConnect(self._session, rf"\\{self.host}\{self.share_name}")
        self._tree.connect()

        # Open directory for change notification
        windows_path = self.path.replace("/", "\\") if self.path else ""

        self._open = Open(self._tree, windows_path)
        self._open.create(
            impersonation_level=ImpersonationLevel.Impersonation,
            desired_access=DirectoryAccessMask.FILE_LIST_DIRECTORY | DirectoryAccessMask.SYNCHRONIZE,
            file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY,
            share_access=ShareAccess.FILE_SHARE_READ | ShareAccess.FILE_SHARE_WRITE | ShareAccess.FILE_SHARE_DELETE,
            create_disposition=CreateDisposition.FILE_OPEN,
            create_options=CreateOptions.FILE_DIRECTORY_FILE,
        )

        # Create new watcher
        self._watcher = FileSystemWatcher(self._open)

    def _handle_change_result(self, result: object) -> None:
        """Handle a completed watcher result from smbprotocol."""

        if result is None:
            raise ConnectionError("File-list monitoring stopped. Reconnect monitoring and refresh the listing.")

        if not isinstance(result, list):
            raise TypeError(f"Unexpected watcher result type: {type(result).__name__}")

        if self._failure_reported:
            self._logger.info("File-list watcher recovered.", extra={"event": "directory_watcher_recovered"})
        self._failure_reported = False
        self._consecutive_failures = 0

        self._notify_change()

        # Restart watcher for next change using a fresh watcher instance.
        self._watcher = FileSystemWatcher(self._open)

    def _notify_change(self) -> None:
        """Send one invalidation from the monitoring thread."""
        if self.on_change_callback:
            loop = asyncio.new_event_loop()
            try:
                asyncio.set_event_loop(loop)
                loop.run_until_complete(self.on_change_callback(self.connection_id, self.path))
            except Exception:
                logger.error("File-list invalidation callback failed. Refresh the listing to verify changes.", exc_info=True)
            finally:
                asyncio.set_event_loop(None)
                loop.close()

    #
    # _monitor_loop
    #
    def _monitor_loop(self) -> None:
        """Background thread that monitors for changes."""

        try:
            while not self._stop_event.is_set():
                # Start watching for changes
                # Monitor file/dir additions, deletions, renames, and modifications
                completion_filter = (
                    CompletionFilter.FILE_NOTIFY_CHANGE_FILE_NAME
                    | CompletionFilter.FILE_NOTIFY_CHANGE_DIR_NAME
                    | CompletionFilter.FILE_NOTIFY_CHANGE_SIZE
                    | CompletionFilter.FILE_NOTIFY_CHANGE_LAST_WRITE
                )

                if self._watcher is None:
                    try:
                        self._cleanup()
                        self._reconnect()
                        if not self._stop_event.is_set():
                            self._notify_change()
                    except Exception as error:
                        self._report_watcher_failure(error)
                    continue

                # Start the watcher (this is a blocking call until change occurs)
                # Wait for response (blocking)
                try:
                    self._watcher.start(
                        completion_filter=completion_filter,
                        flags=DIRECTORY_ONLY_NOTIFY_FLAGS,
                        output_buffer_length=4096,
                        send=True,
                    )
                    result = self._watcher.wait()

                    if self._stop_event.is_set():
                        break

                    self._handle_change_result(result)

                except Exception as e:
                    if not self._stop_event.is_set():
                        # STATUS_DELETE_PENDING (0xc0000056) means the
                        # directory we are watching was deleted.  This is
                        # normal — stop monitoring instead of retrying.
                        status = getattr(e, "ntstatus", getattr(e, "status", None))
                        if status in (
                            NtStatus.STATUS_DELETE_PENDING,
                            NtStatus.STATUS_OBJECT_NAME_NOT_FOUND,
                            NtStatus.STATUS_OBJECT_PATH_NOT_FOUND,
                        ) or isinstance(e, FileNotFoundError):
                            logger.info("Watched directory was deleted. File-list monitoring stopped.")
                            self._notify_change()
                            break

                        self._report_watcher_failure(e)
                        self._cleanup()

        except Exception:
            logger.error("File-list monitor stopped unexpectedly. Reopen the directory to subscribe again.", exc_info=True)
        finally:
            self._cleanup()
            if self.on_stopped and not self._restarting:
                self.on_stopped()
            logger.debug("File-list monitor worker stopped.")

    #
    # _get_action_name
    #
    def _get_action_name(self, action: int) -> str:
        """Get human-readable action name."""

        action_names = {
            FileAction.FILE_ACTION_ADDED: "ADDED",
            FileAction.FILE_ACTION_REMOVED: "REMOVED",
            FileAction.FILE_ACTION_MODIFIED: "MODIFIED",
            FileAction.FILE_ACTION_RENAMED_OLD_NAME: "RENAMED_OLD",
            FileAction.FILE_ACTION_RENAMED_NEW_NAME: "RENAMED_NEW",
        }
        return action_names.get(action, f"UNKNOWN({action})")

    #
    # stop
    #
    def stop(self) -> None:
        """Stop monitoring and clean up resources."""

        with self._lifecycle_lock:
            self._retired = True
            self._stop_locked()

    def restart(self) -> None:
        """Reconnect this monitor unless its connection was retired."""

        with self._lifecycle_lock:
            if self._retired:
                return
            self._restarting = True
            try:
                try:
                    stopped = self._stop_locked()
                    if not stopped:
                        return
                    self._stop_event.clear()
                finally:
                    self._restarting = False
                self._retry_count = 0
                self._consecutive_failures = 0
                self.start()
            except Exception:
                self._stop_event.set()
                if self.on_stopped:
                    self.on_stopped()
                raise

    def _stop_locked(self) -> bool:
        """Stop monitor resources while holding the lifecycle lock."""

        logger.debug("File-list monitor stop requested.")
        self._stop_event.set()

        # Cancel any pending watcher
        if self._watcher and hasattr(self._watcher, "cancel"):
            try:
                self._watcher.cancel()
            except Exception as e:
                logger.warning("File-list watcher cancellation failed.", extra={"error_type": type(e).__name__})

        # Wait for monitor thread to finish
        if self._monitor_thread and self._monitor_thread.is_alive():
            self._monitor_thread.join(timeout=5.0)
            if self._monitor_thread.is_alive():
                logger.warning("File-list watcher is still stopping. Its worker retains resources until exit.")
                return False

        # Clean up SMB resources
        self._cleanup()
        return True

    #
    # _cleanup
    #
    def _cleanup(self) -> None:
        """Clean up SMB resources in proper order."""

        self._watcher = None
        # Close in reverse order of creation to prevent leaks

        if self._open:
            try:
                self._open.close()
                logger.debug("File-list directory handle closed.")
            except Exception as e:
                logger.warning("File-list directory handle cleanup failed.", extra={"error_type": type(e).__name__})
            finally:
                self._open = None

        if self._tree:
            try:
                self._tree.disconnect()
                logger.debug("File-list tree disconnected.")
            except Exception as e:
                logger.warning("File-list tree cleanup failed.", extra={"error_type": type(e).__name__})
            finally:
                self._tree = None

        if self._session:
            try:
                self._session.disconnect()
                logger.debug("File-list session disconnected.")
            except Exception as e:
                logger.warning("File-list session cleanup failed.", extra={"error_type": type(e).__name__})
            finally:
                self._session = None

        if self._connection:
            try:
                self._connection.disconnect()
                logger.debug("File-list connection disconnected.")
            except RuntimeError as e:
                # smbprotocol bug: disconnect() tries to join the current
                # thread when called from the message-worker after a timeout.
                logger.debug("File-list disconnect worker could not join itself.", extra={"error_type": type(e).__name__})
            except Exception as e:
                logger.warning("File-list connection cleanup failed.", extra={"error_type": type(e).__name__})
            finally:
                self._connection = None


# Global monitor instance
_global_monitor: Optional[DirectoryMonitor] = None


#
# get_monitor
#
def get_monitor() -> DirectoryMonitor:
    """Get or create the global directory monitor instance."""

    global _global_monitor
    if _global_monitor is None:
        _global_monitor = DirectoryMonitor()
    return _global_monitor


#
# shutdown_monitor
#
def shutdown_monitor() -> None:
    """Shutdown the global monitor and clean up all resources."""

    global _global_monitor
    if _global_monitor is not None:
        _global_monitor.stop_all()
        _global_monitor = None
