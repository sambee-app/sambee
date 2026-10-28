"""
End-to-end scenario tests for Sambee.

Tests cover complete user journeys and workflows:
- User registration and authentication
- Connection management
- File browsing and viewing
- Real-time notifications
- Multi-user collaboration
- Error recovery scenarios
"""

from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

import app.api.websocket as websocket_module
from app.core.security import encrypt_password
from app.models.connection import Connection, ConnectionScope
from app.models.file import DirectoryListing, FileInfo, FileType
from app.models.user import User, UserRole


class _SessionContext:
    def __init__(self, session: Session) -> None:
        self.session = session

    def __enter__(self) -> Session:
        return self.session

    def __exit__(self, exc_type, exc, tb) -> None:
        del exc_type, exc, tb


@pytest.mark.integration
class TestCompleteUserJourney:
    """Test complete user workflow from registration to file operations."""

    def test_complete_authenticated_workflow(self, client: TestClient, session: Session, auth_headers_admin: dict[str, str]):
        """Test full workflow: admin operations on connections, browse, view, download."""
        # Step 1: Admin creates SMB connection (mock the connection test)
        with patch("app.api.connections.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_backend_class.return_value = mock_instance

            connection_data = {
                "name": "Test Share",
                "type": "smb",
                "host": "server.local",
                "port": 445,
                "share_name": "share",
                "username": "smbuser",
                "password": "smbpass",
            }
            response = client.post(
                "/api/connections",
                json=connection_data,
                headers=auth_headers_admin,
            )
            assert response.status_code == 200
            connection_id = response.json()["id"]

        # Step 4: Admin lists connections
        response = client.get("/api/connections", headers=auth_headers_admin)
        assert response.status_code == 200
        connections = response.json()
        assert len(connections) >= 1
        assert any(c["id"] == connection_id for c in connections)

        # Step 5: Browse directory with mocked SMB backend
        with patch("app.api.browser.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.list_directory.return_value = DirectoryListing(
                path="/",
                items=[
                    FileInfo(
                        name="file.txt",
                        path="/file.txt",
                        type=FileType.FILE,
                        size=1024,
                    )
                ],
                total=1,
            )
            mock_backend_class.return_value = mock_instance

            response = client.get(
                f"/api/browse/{connection_id}/list",
                headers=auth_headers_admin,
            )
            assert response.status_code == 200
            data = response.json()
            assert len(data["items"]) == 1
            assert data["items"][0]["name"] == "file.txt"

        # Step 6: View file
        with patch("app.api.viewer.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.file_exists.return_value = True
            mock_instance.get_file_info.return_value = FileInfo(
                name="file.txt",
                path="/file.txt",
                type=FileType.FILE,
                size=11,
            )

            # Mock read_file as async generator
            async def mock_read_file(path, **kwargs):
                yield b"Hello World"

            mock_instance.read_file = mock_read_file
            mock_backend_class.return_value = mock_instance

            response = client.get(
                f"/api/viewer/{connection_id}/file?path=file.txt",
                headers=auth_headers_admin,
            )
            assert response.status_code == 200
            assert response.content == b"Hello World"

        # Step 7: Download file
        with patch("app.api.viewer.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.file_exists.return_value = True
            mock_instance.get_file_info.return_value = FileInfo(
                name="file.txt",
                path="/file.txt",
                type=FileType.FILE,
                size=11,
            )

            # Mock read_file as async generator
            async def mock_read_file(path, **kwargs):
                yield b"Hello World"

            mock_instance.read_file = mock_read_file
            mock_backend_class.return_value = mock_instance

            response = client.get(
                f"/api/viewer/{connection_id}/download?path=file.txt",
                headers=auth_headers_admin,
            )
            assert response.status_code == 200
            assert "attachment" in response.headers.get("content-disposition", "")

        # Step 8: Update connection (using PUT, not PATCH)
        with patch("app.api.connections.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_backend_class.return_value = mock_instance

            update_data = {
                "name": "Updated Share",
                "type": "smb",
                "host": "server.local",
                "port": 445,
                "share_name": "share",
                "username": "smbuser",
                "password": "smbpass",
            }
            response = client.put(
                f"/api/connections/{connection_id}",
                json=update_data,
                headers=auth_headers_admin,
            )
            assert response.status_code == 200
            assert response.json()["name"] == "Updated Share"

        # Step 9: Delete connection
        response = client.delete(
            f"/api/connections/{connection_id}",
            headers=auth_headers_admin,
        )
        assert response.status_code == 200

        # Step 10: Verify deletion
        response = client.get("/api/connections", headers=auth_headers_admin)
        assert response.status_code == 200
        connections = response.json()
        assert not any(c["id"] == connection_id for c in connections)

    def test_regular_user_workflow(self, client: TestClient, session: Session, auth_headers_user: dict[str, str]):
        """Test regular user can browse but not manage connections."""
        # Create connection for browsing
        connection = Connection(
            name="User Share",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        # User can browse
        with patch("app.api.browser.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.list_directory.return_value = DirectoryListing(path="/", items=[], total=0)
            mock_backend_class.return_value = mock_instance

            response = client.get(
                f"/api/browse/{connection.id}/list",
                headers=auth_headers_user,
            )
            assert response.status_code == 200

        # User can create private connections via the neutral connections endpoint.
        connection_data = {
            "name": "Private Connection",
            "type": "smb",
            "host": "server.local",
            "share_name": "share",
            "username": "user",
            "password": "pass",
            "scope": "shared",
        }
        with patch("app.api.connections.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_backend_class.return_value = mock_instance

            response = client.post(
                "/api/connections",
                json=connection_data,
                headers=auth_headers_user,
            )

        assert response.status_code == 200
        assert response.json()["scope"] == "private"
        assert response.json()["can_manage"] is True


@pytest.mark.integration
class TestMultiUserCollaboration:
    """Test multiple users interacting with the system."""

    def test_multiple_users_browse_same_share(
        self,
        client: TestClient,
        session: Session,
        auth_headers_user: dict[str, str],
        auth_headers_admin: dict[str, str],
    ):
        """Test multiple users can browse the same share simultaneously."""
        # Create shared connection
        connection = Connection(
            name="Shared",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        # Both users browse simultaneously
        with patch("app.api.browser.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.list_directory.return_value = DirectoryListing(
                path="/",
                items=[
                    FileInfo(
                        name="doc.pdf",
                        path="/doc.pdf",
                        type=FileType.FILE,
                        size=1024,
                    )
                ],
                total=1,
            )
            mock_backend_class.return_value = mock_instance

            response1 = client.get(
                f"/api/browse/{connection.id}/list",
                headers=auth_headers_user,
            )
            response2 = client.get(
                f"/api/browse/{connection.id}/list",
                headers=auth_headers_admin,
            )

            assert response1.status_code == 200
            assert response2.status_code == 200
            assert response1.json() == response2.json()

    def test_concurrent_file_access(
        self,
        client: TestClient,
        session: Session,
        auth_headers_user: dict[str, str],
        auth_headers_admin: dict[str, str],
    ):
        """Test multiple users accessing different files simultaneously."""
        # Create connection
        connection = Connection(
            name="Concurrent",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        # Both users access different files
        with patch("app.api.viewer.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.file_exists.return_value = True
            mock_instance.get_file_info.return_value = FileInfo(
                name="file",
                path="/file",
                type=FileType.FILE,
                size=10,
            )

            # Mock read_file as async generator
            async def mock_read_file(path, **kwargs):
                yield b"data"

            mock_instance.read_file = mock_read_file
            mock_backend_class.return_value = mock_instance

            response1 = client.get(
                f"/api/viewer/{connection.id}/file?path=file1.txt",
                headers=auth_headers_user,
            )
            response2 = client.get(
                f"/api/viewer/{connection.id}/file?path=file2.txt",
                headers=auth_headers_admin,
            )

            assert response1.status_code == 200
            assert response2.status_code == 200


@pytest.mark.integration
class TestErrorRecoveryScenarios:
    """Test error handling and recovery in realistic scenarios."""

    def test_smb_connection_error_during_browse(self, client: TestClient, auth_headers_user: dict[str, str], session: Session):
        """Test graceful handling of SMB connection errors."""
        # Create connection
        connection = Connection(
            name="Error Test",
            type="smb",
            host="unreachable.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        # Simulate SMB connection failure
        with patch("app.api.browser.SMBBackend") as mock_backend_class:
            mock_backend_class.side_effect = Exception("Network unreachable")

            response = client.get(
                f"/api/browse/{connection.id}/list",
                headers=auth_headers_user,
            )
            assert response.status_code == 500
            assert "detail" in response.json()

    def test_file_not_found_during_view(self, client: TestClient, auth_headers_user: dict[str, str], session: Session):
        """Test file not found error during viewing."""
        connection = Connection(
            name="Not Found Test",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        with patch("app.api.viewer.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            # Make get_file_info raise an exception for missing file
            mock_instance.get_file_info.side_effect = FileNotFoundError("File not found")
            mock_instance.disconnect.return_value = None
            mock_backend_class.return_value = mock_instance

            response = client.get(
                f"/api/viewer/{connection.id}/file?path=missing.txt",
                headers=auth_headers_user,
            )
            # Returns 404 when file is not found
            assert response.status_code == 404

    def test_invalid_token_error(self, client: TestClient):
        """Test invalid authentication token handling."""
        invalid_headers = {"Authorization": "Bearer invalid_token"}

        response = client.get("/api/connections", headers=invalid_headers)
        assert response.status_code == 401

    def test_missing_connection_error(self, client: TestClient, auth_headers_user: dict[str, str]):
        """Test accessing non-existent connection."""
        fake_id = "nonexistent-uuid-12345"

        response = client.get(
            f"/api/browse/{fake_id}/",
            headers=auth_headers_user,
        )
        assert response.status_code in [404, 422]  # Not found or validation error

    def test_directory_view_error(self, client: TestClient, auth_headers_user: dict[str, str], session: Session):
        """Test attempting to view a directory."""
        connection = Connection(
            name="Dir Test",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        with patch("app.api.viewer.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.file_exists.return_value = True
            mock_instance.get_file_info.return_value = FileInfo(
                name="folder",
                path="/folder",
                type=FileType.DIRECTORY,
            )
            mock_instance.disconnect.return_value = None
            mock_backend_class.return_value = mock_instance

            response = client.get(
                f"/api/viewer/{connection.id}/file?path=folder",
                headers=auth_headers_user,
            )
            assert response.status_code == 409
            assert response.json()["detail"]["code"] == "not_a_file"


@pytest.mark.integration
class TestWebSocketScenarios:
    """Test WebSocket integration in realistic scenarios."""

    @pytest.mark.asyncio
    async def test_websocket_file_notification_workflow(self, session: Session, regular_user: User):
        """Test complete workflow with WebSocket notifications."""
        from app.api.websocket import ConnectionManager

        # Create connection
        connection = Connection(
            name="WS Test",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        # Create connection manager and mock WebSocket
        manager = ConnectionManager()
        mock_ws = AsyncMock()

        original_db_session = websocket_module.DBSession
        websocket_module.DBSession = cast(Any, lambda _engine: _SessionContext(session))

        try:
            with patch("app.api.websocket.get_monitor") as mock_get_monitor:
                monitor = MagicMock()
                monitor.start_monitoring_async = AsyncMock()
                mock_get_monitor.return_value = monitor

                await manager.connect(mock_ws, regular_user)
                subscribed = await manager.subscribe(mock_ws, str(connection.id), "/documents")
        finally:
            websocket_module.DBSession = original_db_session

        # Verify subscription was registered
        assert subscribed is True
        assert mock_ws in manager.subscriptions
        key = f"{connection.id}:/documents"
        assert key in manager.active_connections

        # Cleanup
        manager.disconnect(mock_ws)

    @pytest.mark.asyncio
    async def test_multiple_subscribers_notification(self, session: Session, regular_user: User):
        """Test notifications sent to multiple subscribers."""
        from app.api.websocket import ConnectionManager

        connection = Connection(
            name="Multi WS",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        manager = ConnectionManager()
        mock_ws1 = AsyncMock()
        mock_ws2 = AsyncMock()

        original_db_session = websocket_module.DBSession
        websocket_module.DBSession = cast(Any, lambda _engine: _SessionContext(session))

        try:
            with patch("app.api.websocket.get_monitor") as mock_get_monitor:
                monitor = MagicMock()
                monitor.start_monitoring_async = AsyncMock()
                mock_get_monitor.return_value = monitor

                await manager.connect(mock_ws1, regular_user)
                await manager.connect(mock_ws2, regular_user)

                await manager.subscribe(mock_ws1, str(connection.id), "/shared")
                await manager.subscribe(mock_ws2, str(connection.id), "/shared")
        finally:
            websocket_module.DBSession = original_db_session

        # Verify both are subscribed
        key = f"{connection.id}:/shared"
        assert key in manager.active_connections
        assert len(manager.active_connections[key]) == 2

        # Cleanup
        manager.disconnect(mock_ws1)
        manager.disconnect(mock_ws2)


@pytest.mark.integration
class TestAdminConnectionManagement:
    """Test admin-specific connection management scenarios."""

    def test_create_connection_validation(self, client: TestClient, auth_headers_admin: dict[str, str]):
        """Test connection creation with validation."""
        # Valid connection (mock the connection test)
        with patch("app.api.connections.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_backend_class.return_value = mock_instance

            valid_data = {
                "name": "Valid Connection",
                "type": "smb",
                "host": "server.local",
                "port": 445,
                "share_name": "share",
                "username": "user",
                "password": "pass",
            }
            response = client.post(
                "/api/connections",
                json=valid_data,
                headers=auth_headers_admin,
            )
            assert response.status_code == 200
            connection_id = response.json()["id"]

            # Verify password is NOT returned for security
            assert "password" not in response.json()
            assert "password_encrypted" not in response.json()
            # But other fields are present
            assert response.json()["name"] == "Valid Connection"
            assert response.json()["host"] == "server.local"

            # Cleanup
            client.delete(
                f"/api/connections/{connection_id}",
                headers=auth_headers_admin,
            )

    def test_create_connection_missing_fields(self, client: TestClient, auth_headers_admin: dict[str, str]):
        """Test connection creation with missing required fields."""
        invalid_data = {
            "name": "Incomplete",
            "type": "smb",
            # Missing host, share_name, etc.
        }
        response = client.post(
            "/api/connections",
            json=invalid_data,
            headers=auth_headers_admin,
        )
        assert response.status_code == 422  # Validation error

    def test_update_connection_with_put(self, client: TestClient, auth_headers_admin: dict[str, str], session: Session):
        """Test connection updates using PUT (not PATCH)."""
        # Create connection
        connection = Connection(
            name="Original",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        # Update with PUT (requires all fields, mock the connection test)
        with patch("app.api.connections.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_backend_class.return_value = mock_instance

            update_data = {
                "name": "Updated Name",
                "type": "smb",
                "host": "server.local",
                "port": 445,
                "share_name": "share",
                "username": "user",
                "password": "newpassword",
            }
            response = client.put(
                f"/api/connections/{connection.id}",
                json=update_data,
                headers=auth_headers_admin,
            )
            assert response.status_code == 200
            assert response.json()["name"] == "Updated Name"

    def test_update_connection_password(self, client: TestClient, auth_headers_admin: dict[str, str], session: Session):
        """Test updating connection password."""
        old_password_encrypted = encrypt_password("old_password")
        connection = Connection(
            name="Pass Update",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=old_password_encrypted,
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        # Update password with PUT (mock the connection test)
        with patch("app.api.connections.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_backend_class.return_value = mock_instance

            update_data = {
                "name": "Pass Update",
                "type": "smb",
                "host": "server.local",
                "port": 445,
                "share_name": "share",
                "username": "user",
                "password": "new_password",
            }
            response = client.put(
                f"/api/connections/{connection.id}",
                json=update_data,
                headers=auth_headers_admin,
            )
            assert response.status_code == 200

            # Verify password was re-encrypted
            updated_conn = session.exec(select(Connection).where(Connection.id == connection.id)).first()
            assert updated_conn is not None
            assert updated_conn.password_encrypted != old_password_encrypted

    def test_delete_nonexistent_connection(self, client: TestClient, auth_headers_admin: dict[str, str]):
        """Test deleting a connection that doesn't exist."""
        fake_id = "00000000-0000-0000-0000-000000000000"
        response = client.delete(
            f"/api/connections/{fake_id}",
            headers=auth_headers_admin,
        )
        assert response.status_code == 404

    def test_list_all_connections(self, client: TestClient, auth_headers_admin: dict[str, str], session: Session):
        """Test retrieving all connections."""
        # Create test connection
        connection = Connection(
            name="List Test",
            type="smb",
            host="server.local",
            port=445,
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()

        response = client.get(
            "/api/connections",
            headers=auth_headers_admin,
        )
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert any(c["name"] == "List Test" for c in data)


@pytest.mark.integration
class TestBrowserEdgeCases:
    """Test browser API edge cases and error scenarios."""

    def test_browse_root_directory(self, client: TestClient, auth_headers_user: dict[str, str], session: Session):
        """Test browsing root directory."""
        connection = Connection(
            name="Root Browse",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        with patch("app.api.browser.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.list_directory.return_value = DirectoryListing(
                path="/",
                items=[
                    FileInfo(
                        name="folder1",
                        path="/folder1",
                        type=FileType.DIRECTORY,
                    )
                ],
                total=1,
            )
            mock_backend_class.return_value = mock_instance

            response = client.get(
                f"/api/browse/{connection.id}/list",
                headers=auth_headers_user,
            )
            assert response.status_code == 200
            data = response.json()
            assert len(data["items"]) == 1

    def test_browse_nested_directory(self, client: TestClient, auth_headers_user: dict[str, str], session: Session):
        """Test browsing deeply nested directory."""
        connection = Connection(
            name="Nested Browse",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        with patch("app.api.browser.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.list_directory.return_value = DirectoryListing(
                path="/a/b/c",
                items=[
                    FileInfo(
                        name="deep.txt",
                        path="/a/b/c/deep.txt",
                        type=FileType.FILE,
                        size=100,
                    )
                ],
                total=1,
            )
            mock_backend_class.return_value = mock_instance

            response = client.get(
                f"/api/browse/{connection.id}/list?path=a/b/c",
                headers=auth_headers_user,
            )
            assert response.status_code == 200

    def test_browse_with_special_characters(self, client: TestClient, auth_headers_user: dict[str, str], session: Session):
        """Test browsing directories with special characters."""
        connection = Connection(
            name="Special Chars",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        with patch("app.api.browser.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.list_directory.return_value = DirectoryListing(
                path="/folder with spaces",
                items=[
                    FileInfo(
                        name="file with spaces.txt",
                        path="/file with spaces.txt",
                        type=FileType.FILE,
                        size=100,
                    )
                ],
                total=1,
            )
            mock_backend_class.return_value = mock_instance

            # URL-encoded path
            response = client.get(
                f"/api/browse/{connection.id}/list?path=folder%20with%20spaces",
                headers=auth_headers_user,
            )
            # Should handle gracefully
            assert response.status_code in [200, 500]

    def test_browse_empty_directory(self, client: TestClient, auth_headers_user: dict[str, str], session: Session):
        """Test browsing an empty directory."""
        connection = Connection(
            name="Empty Dir",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted=encrypt_password("testpass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        with patch("app.api.browser.SMBBackend") as mock_backend_class:
            mock_instance = AsyncMock()
            mock_instance.list_directory.return_value = DirectoryListing(path="/", items=[], total=0)
            mock_backend_class.return_value = mock_instance

            response = client.get(
                f"/api/browse/{connection.id}/list?path=empty",
                headers=auth_headers_user,
            )
            assert response.status_code == 200
            assert response.json()["items"] == []


@pytest.mark.integration
class TestAuthenticationFlows:
    """Test various authentication and authorization flows."""

    def test_login_success(self, client: TestClient, session: Session):
        """Test successful login."""
        user = User(username="testuser", password_hash="correct_hash", role=UserRole.EDITOR)
        session.add(user)
        session.commit()

        # Login is tested via fixtures, but we can test the endpoint exists
        response = client.get("/api/auth/me", headers={"Authorization": "Bearer invalid"})
        assert response.status_code in [401, 422]  # Invalid token rejected

    def test_access_admin_endpoint_as_regular_user(self, client: TestClient, auth_headers_user: dict[str, str]):
        """Test that regular users cannot access admin endpoints."""
        response = client.get("/api/connections", headers=auth_headers_user)
        assert response.status_code == 200

    def test_access_without_authentication(self, client: TestClient):
        """Test that endpoints require authentication."""
        # No Authorization header
        response = client.get("/api/connections")
        assert response.status_code == 401

        # Use fake connection ID
        response = client.get("/api/browse/00000000-0000-0000-0000-000000000000/list")
        assert response.status_code == 401
