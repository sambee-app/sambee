"""
Directory monitoring service using SMB change notifications.
Monitors directories for changes and notifies WebSocket clients.
"""

import asyncio
import logging
import random
import threading
from collections.abc import Awaitable, Callable
from typing import Dict, Optional

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
    ) -> None:
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
                if self._connection_generations.get(connection_id, 0) != requested_generation:
                    raise RuntimeError(f"Connection was retired before monitor {key} could start")

                existing_monitor = self._monitors.get(key)
                if existing_monitor is not None:
                    existing_monitor.subscriber_count += 1
                    logger.debug(f"Increased subscriber count for {key} to {existing_monitor.subscriber_count}")
                    return

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
            connection_retired = self._connection_generations.get(connection_id, 0) != connection_generation
            stopped_during_start = monitor_stopped.is_set()
            if not connection_retired and not stopped_during_start:
                self._monitors[key] = monitor
            self._starting.pop(key, None)
            start_event.set()

        if connection_retired:
            monitor.stop()
            raise RuntimeError(f"Connection was retired while monitor {key} was starting")
        if stopped_during_start:
            raise RuntimeError("Directory monitoring stopped during startup")

        logger.debug(f"Started monitoring: {key}")

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

        await asyncio.to_thread(
            self.start_monitoring,
            connection_id,
            path,
            host,
            share_name,
            username,
            password,
            port,
            on_change_callback,
            expected_generation,
        )

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

        with self._lock:
            if key not in self._monitors:
                logger.debug(f"Attempted to stop monitoring non-existent key: {key}")
                return

            monitor = self._monitors[key]
            monitor.subscriber_count -= 1

            if monitor.subscriber_count <= 0:
                logger.debug(f"Stopping monitoring: {key}")
                del self._monitors[key]
            else:
                logger.debug(f"Decreased subscriber count for {key} to {monitor.subscriber_count}")
                return

        try:
            monitor.stop()
        except Exception:
            logger.error("Error stopping monitor %s", key, exc_info=True)

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
                logger.warning("Error stopping monitor %s for retired connection", key, exc_info=True)

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
                logger.warning("Error restarting monitor %s after SMB policy update", key, exc_info=True)

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
            except Exception as e:
                logger.error(f"Error stopping monitor {key}: {e}", exc_info=True)

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

        # Retry state
        self._retry_count = 0
        self._consecutive_failures = 0

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

        except Exception:
            # Clean up on error
            self._cleanup()
            raise

    #
    # _reconnect
    #
    def _reconnect(self) -> None:
        """Reconnect to SMB server after connection loss with exponential backoff."""

        self._consecutive_failures += 1

        if self._consecutive_failures > MAX_RETRY_ATTEMPTS:
            logger.error(f"Max retry attempts ({MAX_RETRY_ATTEMPTS}) reached for {self.connection_id}:{self.path}, giving up")
            self._stop_event.set()
            return

        # Calculate delay with exponential backoff and jitter
        base_delay = min(
            INITIAL_RETRY_DELAY * (RETRY_BACKOFF_MULTIPLIER ** (self._consecutive_failures - 1)),
            MAX_RETRY_DELAY,
        )
        jitter = base_delay * RETRY_JITTER_FACTOR * (random.random() * 2 - 1)  # +/- 10%
        delay = max(0, base_delay + jitter)

        logger.info(
            f"Reconnecting monitor for {self.connection_id}:{self.path} "
            f"(attempt {self._consecutive_failures}/{MAX_RETRY_ATTEMPTS}, delay: {delay:.1f}s)"
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
        except Exception as e:
            logger.error(f"Connection failed during reconnect: {e}", exc_info=True)
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

        logger.info(f"Successfully reconnected monitor for {self.connection_id}:{self.path}")

    def _handle_change_result(self, result: object) -> None:
        """Handle a completed watcher result from smbprotocol."""

        if result is None:
            return

        if not isinstance(result, list):
            raise TypeError(f"Unexpected watcher result type: {type(result).__name__}")

        self._consecutive_failures = 0

        for action_info in result:
            action = action_info["action"].get_value()
            filename = action_info["file_name"].get_value()
            action_name = self._get_action_name(action)
            logger.debug(
                "Change detected in %s:%s - %s: %s",
                self.connection_id,
                self.path,
                action_name,
                filename,
            )

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
            except Exception as cb_error:
                logger.error("Error in change callback: %s", cb_error, exc_info=True)
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
                    logger.warning(f"Watcher is None for {self.connection_id}:{self.path}, exiting loop")
                    break

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
                        error_type = type(e).__name__
                        error_msg = str(e).lower()

                        # STATUS_DELETE_PENDING (0xc0000056) means the
                        # directory we are watching was deleted.  This is
                        # normal — stop monitoring instead of retrying.
                        status = getattr(e, "ntstatus", getattr(e, "status", None))
                        if status in (
                            NtStatus.STATUS_DELETE_PENDING,
                            NtStatus.STATUS_OBJECT_NAME_NOT_FOUND,
                            NtStatus.STATUS_OBJECT_PATH_NOT_FOUND,
                        ) or isinstance(e, FileNotFoundError):
                            logger.info(
                                "Watched directory deleted, stopping monitor: %s:%s",
                                self.connection_id,
                                self.path,
                            )
                            self._notify_change()
                            break

                        logger.error(
                            "Error waiting for changes in %s:%s: %s: %s",
                            self.connection_id,
                            self.path,
                            error_type,
                            e,
                            exc_info=True,
                        )

                        # Check if the error is due to connection/timeout issues
                        is_connection_error = (
                            "socket" in error_msg
                            or "connection" in error_msg
                            or "closed" in error_msg
                            or "timeout" in error_msg
                            or "timed out" in error_msg
                            or error_type in ("TimeoutError", "ConnectionError", "OSError")
                        )

                        if is_connection_error:
                            logger.warning(
                                "Connection/timeout issue detected for %s:%s, attempting recovery (consecutive failures: %s)",
                                self.connection_id,
                                self.path,
                                self._consecutive_failures,
                            )
                            # Clean up old resources
                            self._cleanup()
                            # Try to reconnect with exponential backoff
                            try:
                                self._reconnect()
                                # Success - reset failure counter
                                self._consecutive_failures = 0
                                logger.info("Successfully reconnected %s:%s", self.connection_id, self.path)
                            except Exception as reconnect_error:
                                logger.error(
                                    "Failed to reconnect (attempt %s/%s): %s",
                                    self._consecutive_failures,
                                    MAX_RETRY_ATTEMPTS,
                                    reconnect_error,
                                    exc_info=True,
                                )
                                # _reconnect handles retry logic and stop event
                                if self._stop_event.is_set():
                                    break
                        else:
                            # Other errors - wait briefly and retry with same connection
                            logger.info("Non-connection error, recreating watcher after 5s delay")
                            self._stop_event.wait(5)
                            if not self._stop_event.is_set() and self._open:
                                self._watcher = FileSystemWatcher(self._open)

        except Exception as e:
            logger.error(
                "Monitor loop error for %s:%s: %s",
                self.connection_id,
                self.path,
                e,
                exc_info=True,
            )
        finally:
            self._cleanup()
            if self.on_stopped and not self._stop_event.is_set():
                self.on_stopped()
            logger.debug("Monitor loop stopped for %s:%s", self.connection_id, self.path)

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
            self._stop_locked()
            self._stop_event.clear()
            self._retry_count = 0
            self._consecutive_failures = 0
            self.start()

    def _stop_locked(self) -> None:
        """Stop monitor resources while holding the lifecycle lock."""

        logger.debug(f"Stopping monitor for {self.connection_id}:{self.path}")
        self._stop_event.set()

        # Cancel any pending watcher
        if self._watcher and hasattr(self._watcher, "cancel"):
            try:
                self._watcher.cancel()
            except Exception as e:
                logger.warning(f"Error canceling watcher: {e}")

        # Wait for monitor thread to finish
        if self._monitor_thread and self._monitor_thread.is_alive():
            self._monitor_thread.join(timeout=5.0)
            if self._monitor_thread.is_alive():
                logger.warning(f"Monitor thread did not stop cleanly for {self.connection_id}:{self.path}")

        # Clean up SMB resources
        self._cleanup()

    #
    # _cleanup
    #
    def _cleanup(self) -> None:
        """Clean up SMB resources in proper order."""

        # Close in reverse order of creation to prevent leaks

        if self._open:
            try:
                self._open.close()
                logger.debug(f"Closed directory handle for {self.connection_id}:{self.path}")
            except Exception as e:
                logger.warning(f"Error closing directory handle: {e}")
            finally:
                self._open = None

        if self._tree:
            try:
                self._tree.disconnect()
                logger.debug(f"Disconnected tree for {self.connection_id}:{self.path}")
            except Exception as e:
                logger.warning(f"Error disconnecting tree: {e}")
            finally:
                self._tree = None

        if self._session:
            try:
                self._session.disconnect()
                logger.debug(f"Disconnected session for {self.connection_id}:{self.path}")
            except Exception as e:
                logger.warning(f"Error disconnecting session: {e}")
            finally:
                self._session = None

        if self._connection:
            try:
                self._connection.disconnect()
                logger.debug(f"Disconnected connection for {self.connection_id}:{self.path}")
            except RuntimeError as e:
                # smbprotocol bug: disconnect() tries to join the current
                # thread when called from the message-worker after a timeout.
                logger.debug(f"Ignored RuntimeError during connection disconnect for {self.connection_id}:{self.path}: {e}")
            except Exception as e:
                logger.warning(f"Error disconnecting connection: {e}")
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
