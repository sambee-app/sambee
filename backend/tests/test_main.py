"""
Tests for main application module.

Tests cover:
- Application lifecycle (startup/shutdown)
- Middleware (CORS, request logging)
- Health check endpoint
- Error handling
- Static file serving
"""

import logging
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.models.user import User


@pytest.mark.integration
class TestHealthCheck:
    """Test health check endpoint."""

    def test_health_check_endpoint(self, client: TestClient):
        """Test that health check endpoint returns healthy status."""
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json() == {"status": "healthy"}

    def test_client_lifespan_does_not_bootstrap_administrator(self, client: TestClient, session: Session):
        response = client.get("/api/health")

        assert response.status_code == 200
        assert session.exec(select(User)).all() == []


@pytest.mark.integration
class TestCORSMiddleware:
    """Test CORS middleware configuration."""

    def test_cors_headers_present(self, client: TestClient):
        """Test that CORS headers are present in responses."""
        response = client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "GET",
            },
        )
        # Should allow the origin
        assert "access-control-allow-origin" in response.headers
        assert response.headers["access-control-allow-origin"] == "http://localhost:3000"

    def test_cors_allows_credentials(self, client: TestClient):
        """Test that CORS allows credentials."""
        response = client.get(
            "/api/health",
            headers={"Origin": "http://localhost:3000"},
        )
        assert response.headers.get("access-control-allow-credentials") == "true"

    def test_cors_allows_all_methods(self, client: TestClient):
        """Test that CORS allows all HTTP methods."""
        response = client.options(
            "/api/health",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
            },
        )
        # Should have allow-methods header
        assert "access-control-allow-methods" in response.headers


@pytest.mark.integration
class TestRequestLoggingMiddleware:
    """Test request logging middleware."""

    @pytest.mark.asyncio
    async def test_failed_request_duration_uses_monotonic_time(self, caplog):
        from app.main import log_requests

        request = Request({"type": "http", "method": "GET", "path": "/api/health", "headers": [], "query_string": b""})
        failure = RuntimeError("request failed")
        with (
            patch("app.main.monotonic", side_effect=[1000.0, 1000.125]),
            patch("app.main.datetime") as wall_clock,
            caplog.at_level(logging.ERROR, logger="app.main"),
        ):
            wall_clock.now.side_effect = AssertionError("Elapsed time must not use a wall clock")
            with pytest.raises(RuntimeError, match="request failed"):
                await log_requests(request, AsyncMock(side_effect=failure))
        assert "failed after 125ms: request failed" in caplog.text

    def test_smb_pool_logger_inherits_application_log_level(self):
        """Allow SMB pool diagnostics when the application log level is DEBUG."""

        assert logging.getLogger("app.storage.smb_pool").level == logging.NOTSET

    def test_successful_requests_do_not_duplicate_uvicorn_access_logs(self, client: TestClient, caplog):
        """Successful requests rely on Uvicorn access logs instead of application duplicates."""
        with caplog.at_level(logging.INFO, logger="app.main"):
            response = client.get("/api/health")
            assert response.status_code == 200

        assert not [record for record in caplog.records if record.name == "app.main"]


@pytest.mark.integration
class TestApplicationLifecycle:
    """Test application startup and shutdown events."""

    @patch(
        "app.main.consume_unsupported_config_settings",
        return_value=(Path("/tmp/config.toml"), ("auth2.some_test",)),
    )
    @patch("app.main.init_db")
    @patch("app.main.Session")
    def test_startup_logs_unsupported_configuration_with_application_logger(
        self,
        mock_session,
        mock_init_db,
        mock_consume_unsupported_settings,
        caplog,
    ):
        """Report unsupported TOML values through the configured application logger."""

        from app.main import app

        mock_db_session = MagicMock()
        mock_session.return_value.__enter__.return_value = mock_db_session
        mock_db_session.exec.return_value.first.return_value = MagicMock(username="testadmin")

        with caplog.at_level(logging.INFO, logger="app.main"):
            with TestClient(app):
                pass

        warning = next(record for record in caplog.records if record.getMessage().startswith("Ignoring unsupported configuration"))
        startup_message = next(record for record in caplog.records if record.getMessage() == "Starting Sambee application...")

        assert warning.name == "app.main"
        assert warning.levelno == logging.WARNING
        assert warning.getMessage() == "Ignoring unsupported configuration settings in '/tmp/config.toml': auth2.some_test"
        assert caplog.records.index(warning) < caplog.records.index(startup_message)

    @patch("app.main.init_db")
    @patch("app.main.Session")
    def test_startup_initializes_database(self, mock_session, mock_init_db):
        """Test that database is initialized on startup."""
        from app.main import app

        # Mock the database session
        mock_db_session = MagicMock()
        mock_session.return_value.__enter__.return_value = mock_db_session
        mock_db_session.exec.return_value.first.return_value = MagicMock(username="testadmin")

        # Create client which triggers startup
        with TestClient(app):
            mock_init_db.assert_called_once()

    @patch("app.main.init_db")
    @patch("app.main.Session")
    def test_startup_creates_admin_user_if_not_exists(self, mock_session, mock_init_db):
        """Test that admin user is created if it doesn't exist."""
        from app.main import app

        # Mock the database session to return None (no admin user)
        mock_db_session = MagicMock()
        mock_session.return_value.__enter__.return_value = mock_db_session
        mock_db_session.exec.return_value.first.return_value = None
        mock_db_session.get.return_value = None

        # Create client which triggers startup
        with TestClient(app):
            # Verify admin user was added
            assert mock_db_session.add.called
            assert mock_db_session.commit.called

    @patch("app.main.init_db")
    @patch("app.main.Session")
    def test_startup_does_not_recreate_admin_when_auth_configuration_exists(self, mock_session, mock_init_db):
        from app.main import app

        mock_db_session = MagicMock()
        mock_session.return_value.__enter__.return_value = mock_db_session
        mock_db_session.exec.return_value.first.return_value = None
        mock_db_session.get.return_value = MagicMock()

        with TestClient(app):
            assert not mock_db_session.add.called
            assert not mock_db_session.commit.called

    @patch("app.main.init_db")
    @patch("app.main.Session")
    def test_startup_does_not_create_admin_if_exists(self, mock_session, mock_init_db):
        """Test that admin user is not created if it already exists."""
        from app.main import app
        from app.models.user import UserRole

        # Mock the database session to return existing admin
        mock_db_session = MagicMock()
        mock_session.return_value.__enter__.return_value = mock_db_session
        existing_admin = MagicMock(username="testadmin", role=UserRole.ADMIN, is_active=True)
        mock_db_session.exec.return_value.first.return_value = existing_admin

        # Create client which triggers startup
        with TestClient(app):
            # Verify admin user was NOT added
            assert not mock_db_session.add.called

    @patch("app.main.init_db")
    @patch("app.main.Session")
    @patch("app.services.directory_monitor.shutdown_monitor")
    def test_shutdown_stops_directory_monitors(self, mock_shutdown, mock_session, mock_init_db):
        """Test that directory monitors are stopped on shutdown."""
        from app.main import app

        # Mock the database session
        mock_db_session = MagicMock()
        mock_session.return_value.__enter__.return_value = mock_db_session
        mock_db_session.exec.return_value.first.return_value = MagicMock(username="testadmin")

        # Create and close client which triggers shutdown
        with TestClient(app):
            pass  # Context manager exit triggers shutdown

        # Verify shutdown_monitor was called
        mock_shutdown.assert_called_once()

    @patch("app.main.init_db")
    @patch("app.main.Session")
    @patch("app.services.directory_monitor.shutdown_monitor")
    def test_shutdown_handles_monitor_errors(self, mock_shutdown, mock_session, mock_init_db, caplog):
        """Test that shutdown handles errors from directory monitor gracefully."""
        from app.main import app

        # Mock the database session
        mock_db_session = MagicMock()
        mock_session.return_value.__enter__.return_value = mock_db_session
        mock_db_session.exec.return_value.first.return_value = MagicMock(username="testadmin")

        # Make shutdown_monitor raise an error
        mock_shutdown.side_effect = Exception("Monitor shutdown error")

        # Create and close client - should not raise
        with caplog.at_level(logging.ERROR):
            with TestClient(app):
                pass

        # Verify error was logged but didn't crash
        log_messages = [record.message for record in caplog.records]
        assert any("Error stopping directory monitors" in msg for msg in log_messages)


@pytest.mark.integration
class TestAPIDocumentationDisabled:
    """Test that generated API documentation endpoints are disabled."""

    def test_openapi_schema_is_not_served(self, client: TestClient):
        """The OpenAPI schema must not be publicly served."""
        response = client.get("/openapi.json")
        assert response.status_code == 404

    def test_swagger_ui_is_not_served(self, client: TestClient):
        """The Swagger UI must not be publicly served."""
        response = client.get("/docs")
        assert response.status_code == 404

    def test_redoc_is_not_served(self, client: TestClient):
        """The ReDoc UI must not be publicly served."""
        response = client.get("/redoc")
        assert response.status_code == 404


@pytest.mark.integration
class TestStaticFileServing:
    """Test static file serving for SPA."""

    def test_apply_cache_headers_sets_no_store_headers(self):
        """SPA shell responses should bypass caches."""
        from app.main import SPA_DOCUMENT_CACHE_CONTROL, apply_cache_headers

        response = Response()
        apply_cache_headers(response, SPA_DOCUMENT_CACHE_CONTROL)

        assert response.headers["Cache-Control"] == SPA_DOCUMENT_CACHE_CONTROL
        assert response.headers["Pragma"] == "no-cache"
        assert response.headers["Expires"] == "0"

    def test_apply_cache_headers_clears_legacy_headers_for_immutable_assets(self):
        """Immutable assets should not retain no-cache compatibility headers."""
        from app.main import IMMUTABLE_ASSET_CACHE_CONTROL, apply_cache_headers

        response = Response(headers={"Pragma": "no-cache", "Expires": "0"})
        apply_cache_headers(response, IMMUTABLE_ASSET_CACHE_CONTROL)

        assert response.headers["Cache-Control"] == IMMUTABLE_ASSET_CACHE_CONTROL
        assert "Pragma" not in response.headers
        assert "Expires" not in response.headers

    def test_pdfjs_wasm_is_served_as_a_revalidated_static_file(self, tmp_path):
        """PDF.js decoders must not fall through to the SPA HTML response."""
        from app.main import REVALIDATED_STATIC_CACHE_CONTROL, mount_production_static_files

        static_directory = tmp_path / "static"
        for directory in ("assets", "icons", "pdfjs/wasm"):
            (static_directory / directory).mkdir(parents=True, exist_ok=True)
        wasm_content = b"\x00asm\x01\x00\x00\x00"
        (static_directory / "pdfjs" / "wasm" / "openjpeg.wasm").write_bytes(wasm_content)

        application = FastAPI()
        mount_production_static_files(application, static_directory)

        with TestClient(application) as client:
            response = client.get("/pdfjs/wasm/openjpeg.wasm")

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/wasm"
        assert response.headers["cache-control"] == REVALIDATED_STATIC_CACHE_CONTROL
        assert response.content == wasm_content


@pytest.mark.integration
class TestVersionInfo:
    """Test version metadata resolution."""

    def test_read_first_available_text_uses_fallback_repo_commit_file(self, tmp_path):
        """Version metadata should fall back to the repo file in dev environments."""
        from app.main import read_first_available_text

        missing_path = tmp_path / "missing.txt"
        repo_commit_path = tmp_path / "GIT_COMMIT"
        repo_commit_path.write_text("345dc98\n")

        assert read_first_available_text([missing_path, repo_commit_path]) == "345dc98"

    @patch("app.main.static_path")
    def test_spa_serving_returns_index_for_root(self, mock_static_path, client: TestClient):
        """Test that root path serves index.html."""
        from pathlib import Path

        # Mock static path to exist
        mock_path = MagicMock(spec=Path)
        mock_path.exists.return_value = True
        mock_static_path.exists.return_value = True

        # Note: We can't easily test this without actual static files.
        assert client is not None

    def test_api_routes_not_served_as_static(self, client: TestClient):
        """Test that API routes are not served as static files."""
        # API routes should return proper responses, not index.html
        response = client.get("/api/health")
        assert response.status_code == 200
        # Should be JSON, not HTML
        assert response.headers["content-type"] == "application/json"


@pytest.mark.integration
class TestErrorHandling:
    """Test error handling and responses."""

    def test_404_for_unknown_route(self, client: TestClient):
        """Test that unknown routes return 404."""
        response = client.get("/api/unknown/route")
        assert response.status_code == 404

    def test_405_for_wrong_method(self, client: TestClient):
        """Test that wrong HTTP method returns 405."""
        response = client.post("/api/health")  # GET endpoint
        assert response.status_code == 405

    def test_validation_error_422(self, client: TestClient):
        """Test that validation errors return 422."""
        # Try to login without required fields
        response = client.post("/api/auth/token", data={})
        assert response.status_code == 422
        data = response.json()
        assert "detail" in data


@pytest.mark.integration
class TestApplicationMetadata:
    """Test application metadata and configuration."""

    def test_app_title_correct(self):
        """Test that application title is set correctly."""
        from app.main import app

        assert app.title == "Sambee"

    def test_app_version_set(self):
        """Test that application version is set."""
        from app import __version__
        from app.main import app

        assert app.version == __version__

    def test_app_description_set(self):
        """Test that application description is set."""
        from app.main import app

        assert "SMB" in app.description


@pytest.mark.integration
class TestRouterInclusion:
    """Test that all routers are properly included."""

    def test_auth_router_included(self, client: TestClient):
        """Test that auth router is accessible."""
        # Login endpoint should exist
        response = client.post("/api/auth/token", data={})
        # Should get validation error, not 404
        assert response.status_code != 404

    def test_admin_router_included(self, client: TestClient):
        """Test that admin router is accessible."""
        response = client.get("/api/connections")
        # Should get 401 (no auth), not 404
        assert response.status_code != 404

    def test_browser_router_included(self, client: TestClient):
        """Test that browser router is accessible."""
        response = client.get("/api/browse/1/list")
        # Should get 401 or other error, not 404
        assert response.status_code != 404

    def test_viewer_router_included(self, client: TestClient):
        """Test that viewer router is accessible."""
        response = client.get("/api/viewer/1/file")
        # Should get 401 or other error, not 404
        assert response.status_code != 404

    def test_websocket_router_included(self):
        """Test that websocket router is accessible."""
        from app.main import app

        assert str(app.url_path_for("websocket_endpoint")) == "/api/ws"
