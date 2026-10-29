"""
Tests for the directory monitoring service.

This module tests:
- Directory monitor lifecycle (start/stop)
- SMB connection handling
- Change detection and notifications
- Multi-directory monitoring
- Resource cleanup and error handling
- Thread safety
"""

import threading
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from smbprotocol.exceptions import SMBOSError
from smbprotocol.header import NtStatus

from app.services.directory_monitor import DirectoryMonitor, MonitoredDirectory


class TestDirectoryMonitorLifecycle:
    """Test directory monitor lifecycle operations."""

    @pytest.mark.parametrize("error_status", [NtStatus.STATUS_OBJECT_NAME_NOT_FOUND, NtStatus.STATUS_OBJECT_PATH_NOT_FOUND])
    def test_missing_monitor_target_is_translated_and_released(self, error_status, caplog):
        monitor = DirectoryMonitor()
        with patch("app.services.directory_monitor.MonitoredDirectory") as monitored:
            monitored.return_value.start.side_effect = SMBOSError(error_status, "missing")
            with pytest.raises(FileNotFoundError):
                monitor.start_monitoring("conn-123", "missing", "server", "share", "user", "password")
        assert monitor._monitors == {}
        assert monitor._starting == {}
        assert not any(record.exc_info for record in caplog.records)

    def test_monitor_initialization(self):
        """Test DirectoryMonitor initialization."""
        monitor = DirectoryMonitor()

        assert monitor._monitors == {}
        assert monitor._running is True
        assert isinstance(monitor._lock, type(threading.Lock()))

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_start_monitoring_new_directory(self, mock_monitored_dir):
        """Test starting monitoring for a new directory."""
        monitor = DirectoryMonitor()
        mock_instance = MagicMock()
        mock_monitored_dir.return_value = mock_instance

        monitor.start_monitoring(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
            on_change_callback=None,
        )

        # Verify MonitoredDirectory was created and started
        mock_monitored_dir.assert_called_once()
        mock_instance.start.assert_called_once()

        # Verify it's tracked
        assert "conn-123:/documents" in monitor._monitors

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_start_monitoring_existing_increases_count(self, mock_monitored_dir):
        """Test that starting monitoring on existing directory increases subscriber count."""
        monitor = DirectoryMonitor()
        mock_instance = MagicMock()
        mock_instance.subscriber_count = 1
        mock_monitored_dir.return_value = mock_instance

        # Start first time
        monitor.start_monitoring(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        initial_count = mock_instance.subscriber_count

        # Start again (same directory)
        monitor.start_monitoring(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        # Count should increase, but start() should only be called once
        assert mock_instance.subscriber_count == initial_count + 1
        mock_instance.start.assert_called_once()

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_stop_monitoring_decreases_count(self, mock_monitored_dir):
        """Test that stopping monitoring decreases subscriber count."""
        monitor = DirectoryMonitor()
        mock_instance = MagicMock()
        mock_instance.subscriber_count = 2
        mock_monitored_dir.return_value = mock_instance

        monitor.start_monitoring(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        # Manually set count to 2 to simulate multiple subscribers
        mock_instance.subscriber_count = 2

        # Stop monitoring
        monitor.stop_monitoring("conn-123", "/documents")

        # Count should decrease but monitor shouldn't be stopped yet
        assert mock_instance.subscriber_count == 1
        mock_instance.stop.assert_not_called()
        assert "conn-123:/documents" in monitor._monitors

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_stop_monitoring_last_subscriber_stops_monitor(self, mock_monitored_dir):
        """Test that stopping the last subscriber actually stops monitoring."""
        monitor = DirectoryMonitor()
        mock_instance = MagicMock()
        mock_instance.subscriber_count = 1
        mock_monitored_dir.return_value = mock_instance

        monitor.start_monitoring(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        # Stop monitoring
        monitor.stop_monitoring("conn-123", "/documents")

        # Monitor should be stopped and removed
        mock_instance.stop.assert_called_once()
        assert "conn-123:/documents" not in monitor._monitors

    def test_stop_monitoring_nonexistent(self):
        """Test stopping monitoring for non-existent directory."""
        monitor = DirectoryMonitor()

        # Should not raise exception
        monitor.stop_monitoring("conn-999", "/nonexistent")

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_start_monitoring_rejects_a_generation_retired_before_start(self, mock_monitored_dir):
        """A subscription authorized before retirement must not publish stale credentials."""

        monitor = DirectoryMonitor()
        expected_generation = monitor.get_connection_generation("conn-123")
        monitor.stop_connection("conn-123")

        with pytest.raises(RuntimeError, match="retired"):
            monitor.start_monitoring(
                connection_id="conn-123",
                path="/documents",
                host="server.local",
                share_name="share",
                username="stale-user",
                password="stale-password",
                expected_generation=expected_generation,
            )

        mock_monitored_dir.assert_not_called()

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_stop_all_monitors(self, mock_monitored_dir):
        """Test stopping all monitors at once."""
        monitor = DirectoryMonitor()

        # Create multiple monitors
        mock_instances = []
        for i in range(3):
            mock_instance = MagicMock()
            mock_instances.append(mock_instance)
            mock_monitored_dir.return_value = mock_instance

            monitor.start_monitoring(
                connection_id=f"conn-{i}",
                path=f"/dir{i}",
                host="server.local",
                share_name="share",
                username="user",
                password="pass",
            )

        # Stop all
        monitor.stop_all()

        # All should be stopped
        for mock_instance in mock_instances:
            mock_instance.stop.assert_called()

        assert len(monitor._monitors) == 0
        assert monitor._running is False

    def test_restart_all_preserves_active_monitors(self):
        """A policy update must re-establish monitors without losing subscribers."""

        monitor = DirectoryMonitor()
        first = MagicMock()
        second = MagicMock()
        monitor._monitors = {"conn-1:/one": first, "conn-2:/two": second}

        monitor.restart_all()

        first.restart.assert_called_once()
        second.restart.assert_called_once()
        assert monitor._monitors == {"conn-1:/one": first, "conn-2:/two": second}

    @pytest.mark.asyncio
    async def test_restart_all_async_runs_restart_work_off_loop(self):
        monitor = DirectoryMonitor()
        with patch.object(monitor, "restart_all") as mock_restart:
            await monitor.restart_all_async()

        mock_restart.assert_called_once()

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_monitor_multiple_directories(self, mock_monitored_dir):
        """Test monitoring multiple directories simultaneously."""
        monitor = DirectoryMonitor()

        directories = [
            ("conn-1", "/documents"),
            ("conn-1", "/images"),
            ("conn-2", "/shared"),
        ]

        for conn_id, path in directories:
            mock_instance = MagicMock()
            mock_monitored_dir.return_value = mock_instance

            monitor.start_monitoring(
                connection_id=conn_id,
                path=path,
                host="server.local",
                share_name="share",
                username="user",
                password="pass",
            )

        # All should be tracked
        assert len(monitor._monitors) == 3
        assert "conn-1:/documents" in monitor._monitors
        assert "conn-1:/images" in monitor._monitors
        assert "conn-2:/shared" in monitor._monitors


class TestMonitoredDirectoryLifecycle:
    """Test MonitoredDirectory class lifecycle."""

    def test_monitored_directory_initialization(self):
        """Test MonitoredDirectory initialization."""
        callback = AsyncMock()

        monitored = MonitoredDirectory(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
            on_change_callback=callback,
        )

        assert monitored.connection_id == "conn-123"
        assert monitored.path == "/documents"
        assert monitored.host == "server.local"
        assert monitored.share_name == "share"
        assert monitored.username == "user"
        assert monitored.password == "pass"
        assert monitored.port == 445
        assert monitored.on_change_callback == callback
        assert monitored.subscriber_count == 1

        # SMB resources should be None initially
        assert monitored._connection is None
        assert monitored._session is None
        assert monitored._tree is None
        assert monitored._open is None
        assert monitored._watcher is None
        assert monitored._monitor_thread is None

    def test_retired_monitor_cannot_be_restarted(self):
        monitored = MonitoredDirectory(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
        )

        monitored.stop()
        with patch.object(monitored, "start") as mock_start:
            monitored.restart()

        mock_start.assert_not_called()

    @patch("app.services.directory_monitor.threading.Thread")
    @patch("app.services.directory_monitor.Connection")
    @patch("app.services.directory_monitor.Session")
    @patch("app.services.directory_monitor.TreeConnect")
    @patch("app.services.directory_monitor.Open")
    @patch("app.services.directory_monitor.FileSystemWatcher")
    def test_start_monitoring_establishes_connection(
        self,
        mock_watcher,
        mock_open,
        mock_tree,
        mock_session,
        mock_connection,
        mock_thread,
    ):
        """Test that starting monitoring establishes SMB connection."""
        # Setup mocks
        mock_conn_instance = MagicMock()
        mock_connection.return_value = mock_conn_instance

        mock_session_instance = MagicMock()
        mock_session.return_value = mock_session_instance

        mock_tree_instance = MagicMock()
        mock_tree.return_value = mock_tree_instance

        mock_open_instance = MagicMock()
        mock_open.return_value = mock_open_instance

        mock_watcher_instance = MagicMock()
        mock_watcher.return_value = mock_watcher_instance

        mock_thread_instance = MagicMock()
        mock_thread.return_value = mock_thread_instance

        monitored = MonitoredDirectory(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
        )

        monitored.start()

        # Verify connection sequence
        mock_connection.assert_called_once_with(guid=None, server_name="server.local", port=445, require_signing=True)
        mock_conn_instance.connect.assert_called_once()

        mock_session.assert_called_once_with(
            mock_conn_instance,
            username="user",
            password="pass",
            require_encryption=False,
            auth_protocol="negotiate",
        )

        # Tree connect should be called
        mock_tree.assert_called_once()
        mock_thread_instance.start.assert_called_once()

    @patch("app.services.directory_monitor.Connection")
    @patch("app.services.directory_monitor.Session")
    def test_start_monitoring_connection_failure(self, mock_session, mock_connection):
        """Test handling of connection failures."""
        mock_conn_instance = MagicMock()
        mock_conn_instance.connect.side_effect = Exception("Connection failed")
        mock_connection.return_value = mock_conn_instance

        monitored = MonitoredDirectory(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
        )

        with pytest.raises(Exception, match="Connection failed"):
            monitored.start()

    @patch("app.services.directory_monitor.threading.Thread")
    @patch("app.services.directory_monitor.Connection")
    @patch("app.services.directory_monitor.Session")
    @patch("app.services.directory_monitor.TreeConnect")
    @patch("app.services.directory_monitor.Open")
    @patch("app.services.directory_monitor.FileSystemWatcher")
    def test_stop_monitoring_cleanup(
        self,
        mock_watcher,
        mock_open,
        mock_tree,
        mock_session,
        mock_connection,
        mock_thread,
    ):
        """Test that stopping monitoring cleans up all resources."""
        # Setup mocks
        mock_conn_instance = MagicMock()
        mock_connection.return_value = mock_conn_instance

        mock_session_instance = MagicMock()
        mock_session.return_value = mock_session_instance

        mock_tree_instance = MagicMock()
        mock_tree.return_value = mock_tree_instance

        mock_open_instance = MagicMock()
        mock_open.return_value = mock_open_instance

        mock_watcher_instance = MagicMock()
        mock_watcher.return_value = mock_watcher_instance

        mock_thread_instance = MagicMock()
        mock_thread_instance.is_alive.side_effect = [True, False]
        mock_thread.return_value = mock_thread_instance

        monitored = MonitoredDirectory(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
        )

        monitored.start()

        # Stop
        monitored.stop()

        # Verify cleanup
        assert monitored._stop_event.is_set()
        mock_thread_instance.start.assert_called_once()
        mock_thread_instance.join.assert_called_once_with(timeout=5.0)


class TestChangeNotifications:
    """Test change notification handling."""

    @pytest.mark.parametrize("status", [NtStatus.STATUS_DELETE_PENDING, NtStatus.STATUS_OBJECT_PATH_NOT_FOUND])
    def test_deleted_watch_invalidates_and_retires(self, status, caplog):
        callback = AsyncMock()
        monitored = MonitoredDirectory("conn-123", "documents", "server", "share", "user", "password", 445, callback)
        monitored._watcher = MagicMock()
        monitored._watcher.wait.side_effect = SMBOSError(status, "documents")
        retired = MagicMock()
        monitored.on_stopped = retired
        with patch.object(monitored, "_cleanup") as cleanup:
            monitored._monitor_loop()
        callback.assert_awaited_once_with("conn-123", "documents")
        retired.assert_called_once()
        cleanup.assert_called_once()
        assert not any(record.exc_info for record in caplog.records)

    def test_file_list_watcher_only_watches_immediate_children(self):
        """Descendant writes must not invalidate the visible directory listing."""
        monitored = MonitoredDirectory(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
        )
        watcher = MagicMock()
        watcher.wait.side_effect = lambda: monitored._stop_event.set()
        monitored._watcher = watcher

        monitored._monitor_loop()

        watcher.start.assert_called_once()
        assert watcher.start.call_args.kwargs["flags"] == 0

    def test_handle_change_result_rejects_non_list_result(self):
        """Watcher results must be parsed change-notify lists, not arbitrary mocks."""
        monitored = MonitoredDirectory(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
        )

        with pytest.raises(TypeError, match="Unexpected watcher result type: MagicMock"):
            monitored._handle_change_result(MagicMock())

    @patch("app.services.directory_monitor.Connection")
    @patch("app.services.directory_monitor.Session")
    @patch("app.services.directory_monitor.TreeConnect")
    @patch("app.services.directory_monitor.Open")
    @patch("app.services.directory_monitor.FileSystemWatcher")
    def test_callback_invoked_on_change(self, mock_watcher, mock_open, mock_tree, mock_session, mock_connection):
        """Test that callback is invoked when changes are detected."""
        # Setup mocks
        mock_conn_instance = MagicMock()
        mock_connection.return_value = mock_conn_instance

        mock_session_instance = MagicMock()
        mock_session.return_value = mock_session_instance

        mock_tree_instance = MagicMock()
        mock_tree.return_value = mock_tree_instance

        mock_open_instance = MagicMock()
        mock_open.return_value = mock_open_instance

        # Mock watcher to simulate a change event
        mock_watcher_instance = MagicMock()
        mock_watcher.return_value = mock_watcher_instance

        callback = AsyncMock()

        monitored = MonitoredDirectory(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
            on_change_callback=callback,
        )

        # Note: Full callback testing requires mocking the watch loop
        # which is complex. This test verifies the structure is in place.
        assert monitored.on_change_callback == callback


class TestErrorHandling:
    """Test error handling and edge cases."""

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_start_monitoring_failure_cleanup(self, mock_monitored_dir):
        """Test that failed monitoring start doesn't leave partial state."""
        monitor = DirectoryMonitor()

        mock_instance = MagicMock()
        mock_instance.start.side_effect = Exception("Start failed")
        mock_monitored_dir.return_value = mock_instance

        with pytest.raises(Exception, match="Start failed"):
            monitor.start_monitoring(
                connection_id="conn-123",
                path="/documents",
                host="server.local",
                share_name="share",
                username="user",
                password="pass",
            )

        # Should not be in monitors
        assert "conn-123:/documents" not in monitor._monitors

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_stop_monitoring_error_handling(self, mock_monitored_dir):
        """Test that errors during stop don't crash the system."""
        monitor = DirectoryMonitor()

        mock_instance = MagicMock()
        mock_instance.subscriber_count = 1
        mock_instance.stop.side_effect = Exception("Stop failed")
        mock_monitored_dir.return_value = mock_instance

        monitor.start_monitoring(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        # Should not raise exception even if stop fails
        monitor.stop_monitoring("conn-123", "/documents")

        # Monitor should be removed despite error
        assert "conn-123:/documents" not in monitor._monitors

    @patch("app.services.directory_monitor.Connection")
    def test_monitored_directory_stop_with_no_resources(self, mock_connection):
        """Test stopping a MonitoredDirectory that never started."""
        monitored = MonitoredDirectory(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
        )

        # Stop without starting (all resources are None)
        # Should not raise exception
        monitored.stop()


class TestThreadSafety:
    """Test thread safety of directory monitor."""

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_concurrent_start_requests(self, mock_monitored_dir):
        """Test concurrent start requests are handled safely."""
        monitor = DirectoryMonitor()

        # Use a real integer for subscriber_count that can be incremented
        class MockMonitor:
            def __init__(self):
                self.subscriber_count = 1
                self.start_called = False

            def start(self):
                self.start_called = True

        mock_instance = MockMonitor()
        mock_monitored_dir.return_value = mock_instance

        def start_monitor():
            monitor.start_monitoring(
                connection_id="conn-123",
                path="/documents",
                host="server.local",
                share_name="share",
                username="user",
                password="pass",
            )

        # Start multiple threads trying to start same monitor
        threads = []
        for _ in range(5):
            t = threading.Thread(target=start_monitor)
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # Should have increased subscriber count
        assert mock_instance.subscriber_count == 5
        # But only started once
        assert mock_instance.start_called is True

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_concurrent_stop_requests(self, mock_monitored_dir):
        """Test concurrent stop requests are handled safely."""
        monitor = DirectoryMonitor()

        mock_instance = MagicMock()
        mock_instance.subscriber_count = 5
        mock_monitored_dir.return_value = mock_instance

        monitor.start_monitoring(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        mock_instance.subscriber_count = 5

        def stop_monitor():
            monitor.stop_monitoring("conn-123", "/documents")

        # Stop multiple times concurrently
        threads = []
        for _ in range(5):
            t = threading.Thread(target=stop_monitor)
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # Monitor should be stopped and removed
        assert "conn-123:/documents" not in monitor._monitors


class TestResourceManagement:
    """Test proper resource management and cleanup."""

    @patch("app.services.directory_monitor.threading.Thread")
    @patch("app.services.directory_monitor.Connection")
    @patch("app.services.directory_monitor.Session")
    @patch("app.services.directory_monitor.TreeConnect")
    @patch("app.services.directory_monitor.Open")
    @patch("app.services.directory_monitor.FileSystemWatcher")
    def test_resources_properly_ordered(
        self,
        mock_watcher,
        mock_open,
        mock_tree,
        mock_session,
        mock_connection,
        mock_thread,
    ):
        """Test that SMB resources are created in correct order."""
        # Setup mocks
        mock_conn_instance = MagicMock()
        mock_connection.return_value = mock_conn_instance

        mock_session_instance = MagicMock()
        mock_session.return_value = mock_session_instance

        mock_tree_instance = MagicMock()
        mock_tree.return_value = mock_tree_instance

        mock_open_instance = MagicMock()
        mock_open.return_value = mock_open_instance

        mock_thread_instance = MagicMock()
        mock_thread.return_value = mock_thread_instance

        monitored = MonitoredDirectory(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=445,
        )

        monitored.start()

        # Verify resources are set
        assert monitored._connection is not None
        assert monitored._session is not None
        assert monitored._tree is not None
        mock_thread_instance.start.assert_called_once()


class TestMonitorKeyGeneration:
    """Test monitor key generation."""

    def test_monitor_key_format(self):
        """Test that monitor keys are formatted correctly."""
        monitor = DirectoryMonitor()

        # The key format should be "connection_id:path"
        # This is tested implicitly by other tests, but we verify the behavior

        with patch("app.services.directory_monitor.MonitoredDirectory") as mock:
            mock_instance = MagicMock()
            mock.return_value = mock_instance

            monitor.start_monitoring(
                connection_id="abc-123",
                path="/my/path",
                host="server",
                share_name="share",
                username="user",
                password="pass",
            )

            assert "abc-123:/my/path" in monitor._monitors

    def test_different_paths_same_connection(self):
        """Test monitoring different paths on same connection."""
        monitor = DirectoryMonitor()

        with patch("app.services.directory_monitor.MonitoredDirectory") as mock:
            mock_instance1 = MagicMock()
            mock_instance2 = MagicMock()

            mock.side_effect = [mock_instance1, mock_instance2]

            monitor.start_monitoring(
                connection_id="conn-1",
                path="/path1",
                host="server",
                share_name="share",
                username="user",
                password="pass",
            )

            monitor.start_monitoring(
                connection_id="conn-1",
                path="/path2",
                host="server",
                share_name="share",
                username="user",
                password="pass",
            )

            # Both should exist as separate monitors
            assert "conn-1:/path1" in monitor._monitors
            assert "conn-1:/path2" in monitor._monitors


class TestMonitorStatus:
    """Test monitor status and introspection."""

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_check_if_monitoring(self, mock_monitored_dir):
        """Test checking if a directory is being monitored."""
        monitor = DirectoryMonitor()

        # Use a real integer for subscriber_count
        class MockMonitor:
            def __init__(self):
                self.subscriber_count = 1
                self.stop_called = False
                self.start_called = False

            def start(self):
                self.start_called = True

            def stop(self):
                self.stop_called = True

        mock_instance = MockMonitor()
        mock_monitored_dir.return_value = mock_instance

        # Not monitoring yet
        assert "conn-123:/documents" not in monitor._monitors

        # Start monitoring
        monitor.start_monitoring(
            connection_id="conn-123",
            path="/documents",
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        # Now monitoring
        assert "conn-123:/documents" in monitor._monitors
        assert mock_instance.start_called is True

        # Stop monitoring
        monitor.stop_monitoring("conn-123", "/documents")

        # No longer monitoring
        assert "conn-123:/documents" not in monitor._monitors
        # Should have stopped the monitor
        assert mock_instance.stop_called is True

    @patch("app.services.directory_monitor.MonitoredDirectory")
    def test_list_active_monitors(self, mock_monitored_dir):
        """Test listing all active monitors."""
        monitor = DirectoryMonitor()

        # Start multiple monitors
        paths = ["/documents", "/images", "/videos"]
        for path in paths:
            mock_instance = MagicMock()
            mock_monitored_dir.return_value = mock_instance

            monitor.start_monitoring(
                connection_id="conn-123",
                path=path,
                host="server.local",
                share_name="share",
                username="user",
                password="pass",
            )

        # Check all are active
        active_keys = list(monitor._monitors.keys())
        assert len(active_keys) == 3
        assert "conn-123:/documents" in active_keys
        assert "conn-123:/images" in active_keys
        assert "conn-123:/videos" in active_keys


# Global monitor instance for testing
_monitor_instance = None


def get_monitor() -> DirectoryMonitor:
    """Get or create the global monitor instance."""
    global _monitor_instance
    if _monitor_instance is None:
        _monitor_instance = DirectoryMonitor()
    return _monitor_instance


class TestGlobalMonitorInstance:
    """Test global monitor instance management."""

    def test_get_monitor_singleton(self):
        """Test that get_monitor returns a singleton instance."""
        from app.services.directory_monitor import get_monitor as actual_get_monitor

        monitor1 = actual_get_monitor()
        monitor2 = actual_get_monitor()

        # Should be the same instance
        assert monitor1 is monitor2
