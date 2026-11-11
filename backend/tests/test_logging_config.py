"""Tests for backend logging configuration and frontend logging API."""

import asyncio
import errno
import io
import logging
import socket
import sqlite3
import sys
from pathlib import Path

import pytest
import uvicorn
from fastapi.testclient import TestClient
from starlette.types import Message, Scope
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from app.core.logging import (
    RecoveryLogFormatter,
    SensitiveDataLogFilter,
    UvicornProtocolLogFilter,
    configure_uvicorn_loggers,
    create_diagnostic_handler,
)
from app.middleware.logging import OperationSummaryMiddleware


@pytest.fixture(autouse=True)
def restore_configured_loggers():
    names = (
        "uvicorn",
        "uvicorn.error",
        "uvicorn.access",
        "httpx",
        "httpx2",
        "httpcore",
        "httpcore2",
        "watchfiles",
        "python_multipart",
        "spnego",
        "app.protocol.http",
        "app.protocol.websocket",
    )
    original = {
        name: (logging.getLogger(name).level, logging.getLogger(name).handlers[:], logging.getLogger(name).propagate) for name in names
    }
    yield
    for name, (level, handlers, propagate) in original.items():
        logger = logging.getLogger(name)
        logger.setLevel(level)
        logger.handlers = handlers
        logger.propagate = propagate


@pytest.mark.asyncio
@pytest.mark.parametrize("accepted", [False, True])
async def test_real_uvicorn_handshake_has_one_safe_summary(accepted: bool) -> None:
    stream = io.StringIO()
    configure_uvicorn_loggers([logging.StreamHandler(stream)], "%(message)s", logging.DEBUG, logging.INFO, logging.DEBUG)

    async def app(scope, receive, send) -> None:
        await receive()
        if accepted:
            await send({"type": "websocket.accept"})
        await send({"type": "websocket.close", "code": 1000})

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        server = uvicorn.Server(uvicorn.Config(OperationSummaryMiddleware(app), log_config=None, lifespan="off", ws="websockets-sansio"))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            address = f"ws://127.0.0.1:{listener.getsockname()[1]}/api/ws?token=private"
            if accepted:
                async with connect(address, additional_headers={"Cookie": "private"}) as websocket:
                    await websocket.wait_closed()
            else:
                with pytest.raises(InvalidStatus) as error:
                    await connect(address, additional_headers={"Cookie": "private"})
                assert error.value.response.status_code == 403
        finally:
            server.should_exit = True
            await asyncio.wait_for(serving, timeout=5)
    output = stream.getvalue()
    assert output.count("event=ws_handshake") == 1
    assert f"status={101 if accepted else 403}" in output
    assert output.count("event=ws_closed") == int(accepted)
    assert "private" not in output
    assert "< GET" not in output
    assert "connection is " not in output


@pytest.mark.asyncio
async def test_websocket_summary_counts_traffic_without_payloads(caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(logging.getLogger("app.protocol.websocket"), "handlers", [])
    monkeypatch.setattr(logging.getLogger("app.protocol.websocket"), "propagate", True)
    incoming = iter([{"type": "websocket.receive", "text": "private"}, {"type": "websocket.disconnect", "code": 1000}])
    sent = []

    async def receive() -> Message:
        return next(incoming)

    async def send(message: Message) -> None:
        sent.append(message)

    async def app(scope, receive, send) -> None:
        await send({"type": "websocket.accept"})
        await receive()
        await send({"type": "websocket.send", "bytes": b"private"})
        await receive()

    with caplog.at_level(logging.DEBUG, logger="app.protocol.websocket"):
        await OperationSummaryMiddleware(app)({"type": "websocket"}, receive, send)
    assert len(caplog.records) == 1
    output = caplog.records[0].getMessage()
    assert "event=ws_closed" in output
    assert "rx_messages=1 tx_messages=1 rx_bytes=7 tx_bytes=7" in output
    assert "private" not in output
    assert len(sent) == 2


@pytest.mark.asyncio
async def test_operation_summary_keeps_stream_and_omits_file_paths(caplog: pytest.LogCaptureFixture) -> None:
    sent = []

    async def receive() -> Message:
        return {"type": "http.request", "body": b""}

    async def send(message: Message) -> None:
        sent.append(message)

    async def app(scope, receive, send) -> None:
        scope["path_params"] = {"connection_id": "opaque-source"}
        await send({"type": "http.response.start", "status": 200})
        await send({"type": "http.response.body", "body": b"private", "more_body": False})

    scope: Scope = {"type": "http", "path": "/api/browse/opaque-source/list", "query_string": b"path=private"}
    with caplog.at_level(logging.DEBUG, logger="app.operations"):
        await OperationSummaryMiddleware(app)(scope, receive, send)
    assert len(caplog.records) == 1
    assert "event=storage_operation" in caplog.text
    assert "source_id='opaque-source' status=200" in caplog.text
    assert "private" not in caplog.text
    assert sent[-1]["body"] == b"private"


def test_exception_summary_and_private_diagnostic_share_error_id(tmp_path: Path) -> None:
    handler = create_diagnostic_handler(tmp_path / "logs")
    try:
        try:
            raise ValueError("private exception detail")
        except ValueError:
            record = logging.LogRecord(
                "app.example", logging.ERROR, __file__, 1, "Operation failed\nRetry the operation.", (), sys.exc_info()
            )
        handler.handle(record)
        output = RecoveryLogFormatter("%(message)s").format(record)
        assert len(output.splitlines()) == 1
        assert "error_type='ValueError'" in output
        assert f"error_id='{record.error_id}'" in output
        assert "private exception detail" not in output
        diagnostic = Path(handler.baseFilename).read_text()
        assert record.error_id in diagnostic
        assert "ValueError: private exception detail" in diagnostic
        assert "Traceback" in diagnostic
        assert Path(handler.baseFilename).stat().st_mode & 0o777 == 0o600
        handler.doRollover()
        assert Path(handler.baseFilename).stat().st_mode & 0o777 == 0o600
        assert Path(f"{handler.baseFilename}.1").stat().st_mode & 0o777 == 0o600
    finally:
        handler.close()


def test_diagnostic_log_excludes_records_without_exceptions(tmp_path: Path) -> None:
    handler = create_diagnostic_handler(tmp_path)
    try:
        handler.handle(logging.LogRecord("app.example", logging.INFO, __file__, 1, "Normal event", (), None))
        assert Path(handler.baseFilename).read_text() == ""
    finally:
        handler.close()


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


@pytest.mark.parametrize("header", ["Cookie", "Set-Cookie", "Authorization", "Proxy-Authorization"])
@pytest.mark.parametrize("prefix", ["", "< ", "> "])
@pytest.mark.parametrize("mixed_case", [False, True])
def test_sensitive_headers_are_redacted(header: str, prefix: str, mixed_case: bool) -> None:
    name = header.swapcase() if mixed_case else header
    message = f"{prefix}{name}: Basic secret; session=private"
    record = logging.LogRecord("uvicorn.error", logging.DEBUG, __file__, 0, "%s", (message,), None)
    assert SensitiveDataLogFilter().filter(record)
    assert record.getMessage() == f"{prefix}{name}: <redacted>"


def test_other_headers_are_not_redacted() -> None:
    message = "< user-agent: example\n> Content-Type: text/plain"
    record = logging.LogRecord("uvicorn.error", logging.DEBUG, __file__, 0, message, (), None)
    assert SensitiveDataLogFilter().filter(record)
    assert record.getMessage() == message


@pytest.mark.parametrize("protocol", ["SPNEGO", "NTLM", "GSSAPI", "SSPI"])
@pytest.mark.parametrize("direction", ["input", "output"])
def test_authentication_step_tokens_are_redacted(protocol: str, direction: str) -> None:
    message = f"{protocol} step {direction}: %s"
    record = logging.LogRecord("spnego._negotiate", logging.DEBUG, __file__, 0, message, ("cHJpdmF0ZQ==",), None)
    log_filter = SensitiveDataLogFilter()
    assert log_filter.filter(record)
    assert record.getMessage() == f"{protocol} step {direction}: <redacted>"
    assert log_filter.filter(record)
    assert record.getMessage() == f"{protocol} step {direction}: <redacted>"


def test_empty_authentication_step_token_does_not_consume_next_line() -> None:
    message = "SPNEGO step output: \nAuthentication finished."
    record = logging.LogRecord("spnego._negotiate", logging.DEBUG, __file__, 0, message, (), None)
    assert SensitiveDataLogFilter().filter(record)
    assert record.getMessage() == "SPNEGO step output: <redacted>\nAuthentication finished."


def test_spnego_routine_messages_are_suppressed_but_warnings_and_errors_remain(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    logger = logging.getLogger("spnego._negotiate")
    monkeypatch.setattr(logger, "level", logging.NOTSET)
    with caplog.at_level(logging.DEBUG):
        configure_uvicorn_loggers([logging.StreamHandler(io.StringIO())], "%(message)s", logging.DEBUG, logging.DEBUG, logging.DEBUG)
        logger.debug("SPNEGO step input: %s", "cHJpdmF0ZQ==")
        logger.info("Creating authentication context.")
        logger.warning("Authentication warning.")
        logger.error("Authentication failed.")
    records = [record for record in caplog.records if record.name == logger.name]
    assert [(record.levelno, record.getMessage()) for record in records] == [
        (logging.WARNING, "Authentication warning."),
        (logging.ERROR, "Authentication failed."),
    ]


def test_empty_sensitive_header_does_not_consume_next_header() -> None:
    message = "< cookie: \n< user-agent: example\n> Set-Cookie: session=secret\r\n> Content-Type: text/plain"
    record = logging.LogRecord("uvicorn.error", logging.DEBUG, __file__, 0, message, (), None)
    assert SensitiveDataLogFilter().filter(record)
    assert record.getMessage() == "< cookie: <redacted>\n< user-agent: example\n> Set-Cookie: <redacted>\r\n> Content-Type: text/plain"


def test_uvicorn_debug_headers_are_redacted() -> None:
    logger_names = (
        "uvicorn",
        "uvicorn.error",
        "uvicorn.access",
        "httpx",
        "httpx2",
        "httpcore",
        "httpcore2",
        "watchfiles",
        "python_multipart",
    )
    original_state = {
        name: (logging.getLogger(name).level, logging.getLogger(name).handlers[:], logging.getLogger(name).propagate)
        for name in logger_names
    }
    stream = io.StringIO()
    try:
        configure_uvicorn_loggers([logging.StreamHandler(stream)], "%(message)s", logging.DEBUG, logging.DEBUG, logging.DEBUG)
        logging.getLogger("uvicorn.error").debug("< cookie: name=%s", "secret")
        assert stream.getvalue() == ""
    finally:
        for name, (level, handlers, propagate) in original_state.items():
            logger = logging.getLogger(name)
            logger.setLevel(level)
            logger.handlers = handlers
            logger.propagate = propagate


@pytest.mark.parametrize(
    "message",
    [
        "= connection is CONNECTING",
        "< GET /api/ws?token=secret HTTP/1.1",
        "< host: example.test",
        "> HTTP/1.1 403 Forbidden",
        "> EOF",
        "% sending keepalive ping",
        "> TEXT secret [6 bytes]",
        "connection open",
        "connection rejected (400 Bad Request)",
        "x closing TCP connection",
    ],
)
def test_uvicorn_protocol_details_are_suppressed(message: str) -> None:
    record = logging.LogRecord("uvicorn.error", logging.DEBUG, __file__, 0, message, (), None)
    assert not UvicornProtocolLogFilter(logging.DEBUG, logging.DEBUG).filter(record)


def test_uvicorn_handshake_is_one_safe_summary() -> None:
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 0, '127.0.0.1 - "WebSocket /api/ws?token=secret" 403', (), None)
    assert UvicornProtocolLogFilter(logging.WARNING, logging.DEBUG).filter(record)
    assert record.getMessage() == "event=ws_handshake path='/api/ws' status=403 outcome=rejected"


def test_invalid_handshake_is_summarized_before_asgi_starts() -> None:
    record = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 0, "connection rejected (426 Upgrade Required)", (), None)
    assert UvicornProtocolLogFilter(logging.WARNING, logging.INFO).filter(record)
    assert record.getMessage() == "event=ws_handshake status=426 outcome=rejected"


def test_access_and_protocol_thresholds_are_independent_of_application_level() -> None:
    stream = io.StringIO()
    configure_uvicorn_loggers([logging.StreamHandler(stream)], "%(message)s", logging.ERROR, logging.INFO, logging.DEBUG)
    logging.getLogger("uvicorn.error").info('127.0.0.1 - "WebSocket /api/ws" [accepted]')
    logging.getLogger("uvicorn.error").info("Started server process")
    logging.getLogger("app.protocol.websocket").debug("event=ws_closed close_code=1000")
    assert stream.getvalue().splitlines() == [
        "event=ws_handshake path='/api/ws' status=101 outcome=accepted",
        "event=ws_closed close_code=1000",
    ]


def test_handshake_summary_reaches_each_handler_with_independent_thresholds() -> None:
    streams = [io.StringIO(), io.StringIO()]
    configure_uvicorn_loggers(
        [logging.StreamHandler(stream) for stream in streams], "%(message)s", logging.ERROR, logging.INFO, logging.WARNING
    )
    logging.getLogger("uvicorn.error").info('127.0.0.1 - "WebSocket /api/ws?token=private" 403')
    assert all(stream.getvalue() == "event=ws_handshake path='/api/ws' status=403 outcome=rejected\n" for stream in streams)


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
        assert "httpx - WARNING" in stream.getvalue()
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
