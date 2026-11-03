"""Tests for backend logging configuration and frontend logging API."""

import errno
import io
import logging
import sqlite3
import sys

import pytest
from fastapi.testclient import TestClient

from app.core.logging import RecoveryLogFormatter, SensitiveDataLogFilter, UvicornProtocolLogFilter, configure_uvicorn_loggers


def test_recovery_formatter_renders_safe_codes_from_causes_without_tracebacks():
    cause = sqlite3.OperationalError("private database path")
    cause.sqlite_errorcode = sqlite3.SQLITE_BUSY
    error = OSError(errno.EACCES, "private source path")
    error.__cause__ = cause
    record = logging.LogRecord("app.storage.smb", logging.WARNING, __file__, 1, "Recovery failed", (), (type(error), error, None))
    output = RecoveryLogFormatter("%(message)s").format(record)
    assert f"errno={errno.EACCES}" in output
    assert f"sqlite_errorcode={sqlite3.SQLITE_BUSY}" in output
    assert "PermissionError" in output
    assert "OperationalError" in output
    assert "private" not in output


@pytest.mark.parametrize("name", ["smbclient._io", "smbprotocol.connection"])
def test_protocol_diagnostics_omit_private_payload_and_exception_text(name):
    try:
        raise OSError("private host, path and credentials")
    except OSError:
        record = logging.LogRecord(name, logging.WARNING, __file__, 1, "private payload %s", ("private user",), sys.exc_info())
    output = RecoveryLogFormatter("%(name)s %(message)s").format(record)
    assert name in output
    assert "OSError" in output
    assert "private host, path and credentials" not in output
    assert "private payload private user" not in output
    assert "private user" not in output
    assert __file__ not in output
    assert record.getMessage() == "private payload private user"


def test_recovery_formatter_handles_unhashable_and_cyclic_exceptions() -> None:
    class UnhashableError(RuntimeError):
        __hash__ = None

    try:
        raise UnhashableError("private exception text")
    except UnhashableError as error:
        error.__cause__ = error
        record = logging.LogRecord("app.storage.smb", logging.WARNING, __file__, 1, "SMB recovery failed", (), sys.exc_info())
    output = RecoveryLogFormatter("%(message)s").format(record)
    assert output.count("UnhashableError") == 1
    assert "private exception text" not in output
    assert __file__ not in output


def test_recovery_formatter_renders_fields_without_private_exception_text() -> None:
    try:
        try:
            raise OSError("private-path password=secret-private-value")
        except OSError as cause:
            raise RuntimeError("private-wrapper") from cause
    except RuntimeError:
        record = logging.LogRecord("app.storage.smb", logging.WARNING, __file__, 1, "SMB recovery failed", (), sys.exc_info())
    record.operation = "read_file"
    record.source_id = "opaque-source"
    record.generation_id = "opaque-generation"
    record.retained_worker_count = 2
    output = RecoveryLogFormatter("%(message)s").format(record)
    assert "private-path" not in output
    assert "secret-private-value" not in output
    assert "private-wrapper" not in output
    assert __file__ not in output
    assert "OSError" in output
    assert "RuntimeError" in output
    assert "operation='read_file'" in output
    assert "retained_worker_count=2" in output


def test_sensitive_data_log_filter_redacts_access_credentials() -> None:
    log_filter = SensitiveDataLogFilter()
    record = logging.LogRecord(
        "httpx",
        logging.INFO,
        __file__,
        0,
        'HTTP Request: GET https://auth.example.test/callback?access_token=secret-token "HTTP/1.1 200 OK"',
        (),
        None,
    )

    assert log_filter.filter(record)
    assert record.getMessage() == 'HTTP Request: GET https://auth.example.test/callback?<redacted> "HTTP/1.1 200 OK"'

    websocket_record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        0,
        '127.0.0.1 - "WebSocket /api/ws?token=secret-token" 403',
        (),
        None,
    )

    assert log_filter.filter(websocket_record)
    assert websocket_record.getMessage() == '127.0.0.1 - "WebSocket /api/ws?<redacted>" 403'

    download_record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        0,
        '127.0.0.1 - "GET /api/viewer/download-intents/secret-token HTTP/1.1" 200',
        (),
        None,
    )
    assert log_filter.filter(download_record)
    assert "/api/viewer/download-intents/<redacted>" in download_record.getMessage()


def test_uvicorn_protocol_filter_applies_access_policy_to_websocket_handshakes() -> None:
    log_filter = UvicornProtocolLogFilter(protocol_log_level=logging.WARNING, access_log_level=logging.WARNING)
    rejected_websocket_record = logging.LogRecord(
        "uvicorn.error",
        logging.INFO,
        __file__,
        0,
        '127.0.0.1 - "WebSocket /api/ws?token=secret-token" 403',
        (),
        None,
    )

    assert not log_filter.filter(rejected_websocket_record)

    debug_access_log_filter = UvicornProtocolLogFilter(protocol_log_level=logging.WARNING, access_log_level=logging.DEBUG)
    assert debug_access_log_filter.filter(rejected_websocket_record)
    assert rejected_websocket_record.levelno == logging.DEBUG
    assert rejected_websocket_record.levelname == "DEBUG"


def test_configure_uvicorn_loggers_applies_access_policy_to_httpx() -> None:
    logger_names = ("uvicorn", "uvicorn.error", "uvicorn.access", "httpx")
    original_logger_state = {
        name: (logging.getLogger(name).level, logging.getLogger(name).handlers[:], logging.getLogger(name).propagate)
        for name in logger_names
    }
    stream = io.StringIO()

    try:
        configure_uvicorn_loggers(
            handlers=[logging.StreamHandler(stream)],
            log_format="%(name)s - %(levelname)s - %(message)s",
            application_log_level=logging.INFO,
            access_log_level=logging.WARNING,
            protocol_log_level=logging.WARNING,
        )

        assert logging.getLogger("uvicorn.access").level == logging.WARNING
        assert logging.getLogger("httpx").level == logging.WARNING

        httpx_logger = logging.getLogger("httpx")
        httpx_logger.info("HTTP Request: GET https://auth.example.test/callback?token=secret-token")
        httpx_logger.warning("HTTP Request: GET https://auth.example.test/callback?token=secret-token")

        uvicorn_error_logger = logging.getLogger("uvicorn.error")
        uvicorn_error_logger.info('127.0.0.1 - "WebSocket /api/ws?token=secret-token" 403')

        assert "secret-token" not in stream.getvalue()
        assert "https://auth.example.test/callback?<redacted>" in stream.getvalue()
        assert "httpx - DEBUG" in stream.getvalue()
        assert "WebSocket /api/ws" not in stream.getvalue()
    finally:
        for name, (level, handlers, propagate) in original_logger_state.items():
            logger = logging.getLogger(name)
            logger.setLevel(level)
            logger.handlers = handlers
            logger.propagate = propagate


#
# test_get_logging_config_default
#
def test_get_logging_config_default(client: TestClient, auth_headers_admin: dict[str, str]) -> None:
    """Test getting default logging configuration"""

    response = client.get("/api/logs/config", headers=auth_headers_admin)
    assert response.status_code == 200

    data = response.json()

    # Console logging fields
    assert "logging_enabled" in data
    assert "logging_level" in data
    assert isinstance(data["logging_enabled"], bool)
    assert isinstance(data["logging_level"], str)

    # Backend tracing fields
    assert "tracing_enabled" in data
    assert "tracing_level" in data
    assert "tracing_components" in data
    assert isinstance(data["tracing_enabled"], bool)
    assert isinstance(data["tracing_level"], str)
    assert isinstance(data["tracing_components"], list)

    # Defaults
    assert data["logging_enabled"] is False
    assert data["logging_level"] == "WARNING"
    assert data["tracing_enabled"] is False
    assert data["tracing_level"] == "ERROR"
    assert data["tracing_components"] == []


#
# test_get_logging_config_with_regex_match
#
def test_get_logging_config_with_regex_match(client: TestClient, auth_headers_admin: dict[str, str], monkeypatch) -> None:
    """Test that logging is enabled when username matches regex"""

    from app.api import logs

    monkeypatch.setattr(logs.settings, "frontend_logging_enabled", True)
    monkeypatch.setattr(logs.settings, "frontend_log_level", "INFO")
    monkeypatch.setattr(logs.settings, "frontend_tracing_enabled", True)
    monkeypatch.setattr(logs.settings, "frontend_tracing_username_regex", "^testadmin$")
    monkeypatch.setattr(logs.settings, "frontend_tracing_level", "WARNING")
    monkeypatch.setattr(logs.settings, "frontend_tracing_components", "Swiper")

    response = client.get("/api/logs/config", headers=auth_headers_admin)
    assert response.status_code == 200

    data = response.json()
    assert data["logging_enabled"] is True
    assert data["logging_level"] == "INFO"
    assert data["tracing_enabled"] is True
    assert data["tracing_level"] == "WARNING"
    assert data["tracing_components"] == ["Swiper"]


#
# test_get_logging_config_with_regex_no_match
#
def test_get_logging_config_with_regex_no_match(client: TestClient, auth_headers_admin: dict[str, str], monkeypatch) -> None:
    """Test that tracing is disabled when username doesn't match regex"""

    from app.api import logs

    monkeypatch.setattr(logs.settings, "frontend_logging_enabled", True)
    monkeypatch.setattr(logs.settings, "frontend_log_level", "DEBUG")
    monkeypatch.setattr(logs.settings, "frontend_tracing_enabled", True)
    monkeypatch.setattr(logs.settings, "frontend_tracing_username_regex", "^other_user$")
    monkeypatch.setattr(logs.settings, "frontend_tracing_level", "DEBUG")
    monkeypatch.setattr(logs.settings, "frontend_tracing_components", "")

    response = client.get("/api/logs/config", headers=auth_headers_admin)
    assert response.status_code == 200

    data = response.json()
    # Console logging is independent of username regex
    assert data["logging_enabled"] is True
    # Tracing should be disabled due to regex mismatch
    assert data["tracing_enabled"] is False


#
# test_get_logging_config_with_invalid_regex
#
def test_get_logging_config_with_invalid_regex(client: TestClient, auth_headers_admin: dict[str, str], monkeypatch) -> None:
    """Test that invalid regex disables tracing"""

    from app.api import logs

    monkeypatch.setattr(logs.settings, "frontend_logging_enabled", True)
    monkeypatch.setattr(logs.settings, "frontend_log_level", "INFO")
    monkeypatch.setattr(logs.settings, "frontend_tracing_enabled", True)
    monkeypatch.setattr(logs.settings, "frontend_tracing_username_regex", "[invalid(regex")
    monkeypatch.setattr(logs.settings, "frontend_tracing_level", "INFO")
    monkeypatch.setattr(logs.settings, "frontend_tracing_components", "")

    response = client.get("/api/logs/config", headers=auth_headers_admin)
    assert response.status_code == 200

    data = response.json()
    # Console logging is independent of regex
    assert data["logging_enabled"] is True
    # Tracing should be disabled due to invalid regex
    assert data["tracing_enabled"] is False


#
# test_logging_config_requires_auth
#
def test_logging_config_requires_auth(client: TestClient) -> None:
    """Test that logging config endpoint requires authentication"""

    response = client.get("/api/logs/config")
    assert response.status_code == 401


#
# test_log_level_returned
#
def test_log_level_returned(client: TestClient, auth_headers_admin: dict[str, str], monkeypatch) -> None:
    """Test that log levels are returned correctly"""

    from app.api import logs

    # Test each log level for both logging and tracing
    for level in ["DEBUG", "INFO", "WARNING", "ERROR"]:
        monkeypatch.setattr(logs.settings, "frontend_logging_enabled", True)
        monkeypatch.setattr(logs.settings, "frontend_log_level", level)
        monkeypatch.setattr(logs.settings, "frontend_tracing_enabled", True)
        monkeypatch.setattr(logs.settings, "frontend_tracing_username_regex", "^testadmin$")
        monkeypatch.setattr(logs.settings, "frontend_tracing_level", level)

        response = client.get("/api/logs/config", headers=auth_headers_admin)
        assert response.status_code == 200
        assert response.json()["logging_level"] == level
        assert response.json()["tracing_level"] == level


#
# test_log_retention_config
#
def test_log_retention_config() -> None:
    """Test that log retention configuration is loaded"""

    from app.core.config import settings

    # Default should be 1 hour
    assert settings.frontend_tracing_retention_hours == 1
    assert isinstance(settings.frontend_tracing_retention_hours, int)
