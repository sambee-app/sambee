"""
Logging utilities for request context management.

Provides request ID tracking and context-aware logging throughout the application.
"""

import logging
import os
import re
import traceback
import uuid
from collections.abc import MutableMapping
from contextvars import ContextVar
from copy import copy
from io import TextIOWrapper
from logging.handlers import RotatingFileHandler
from pathlib import Path
from time import monotonic
from typing import Any, Optional

# Context variables for request tracking
request_id_var: ContextVar[Optional[str]] = ContextVar("request_id", default=None)
user_var: ContextVar[Optional[str]] = ContextVar("user", default=None)
websocket_log_context: ContextVar[tuple[str, float] | None] = ContextVar("websocket_log_context", default=None)
http_summary_active: ContextVar[bool] = ContextVar("http_summary_active", default=False)

SENSITIVE_HEADER_NAMES = ("Cookie", "Set-Cookie", "Authorization", "Proxy-Authorization")
DIAGNOSTIC_LOG_MAX_BYTES = 10 * 1024 * 1024
DIAGNOSTIC_LOG_BACKUP_COUNT = 3
DIAGNOSTIC_LOG_FILENAME = "backend-diagnostics.log"
MILLISECONDS_PER_SECOND = 1000


#
# set_request_id
#
def set_request_id(request_id: Optional[str] = None) -> str:
    """
    Set the request ID for the current context.

    Args:
        request_id: Optional request ID. If not provided, generates a new UUID.

    Returns:
        The request ID that was set.
    """

    if request_id is None:
        request_id = str(uuid.uuid4())
    request_id_var.set(request_id)
    return request_id


#
# get_request_id
#
def get_request_id() -> Optional[str]:
    """Get the current request ID from context."""

    return request_id_var.get()


#
# set_user
#
def set_user(username: Optional[str]) -> None:
    """Set the current user for the request context."""

    user_var.set(username)


#
# get_user
#
def get_user() -> Optional[str]:
    """Get the current user from context."""

    return user_var.get()


#
# clear_context
#
def clear_context() -> None:
    """Clear all context variables."""

    request_id_var.set(None)
    user_var.set(None)


def format_audit_fields(**fields: Any) -> str:
    """Format audit-safe key/value pairs for log messages.

    Skips fields with ``None`` values and quotes string-like identifiers while
    avoiding raw bearer material unless a caller passes it explicitly.
    """

    formatted_fields: list[str] = []
    for key, value in fields.items():
        if value is None:
            continue
        if isinstance(value, uuid.UUID):
            formatted_fields.append(f"{key}='{value}'")
        elif isinstance(value, str):
            formatted_fields.append(f"{key}={value!r}")
        else:
            formatted_fields.append(f"{key}={value}")

    return ", ".join(formatted_fields)


class SensitiveDataLogFilter(logging.Filter):
    """Remove credentials and query strings from emitted log messages."""

    _SENSITIVE_HEADER_PATTERN = re.compile(
        rf"(?P<header>^[ \t]*(?:[<>][ \t]*)?(?:{'|'.join(map(re.escape, SENSITIVE_HEADER_NAMES))})[ \t]*:[ \t]*)[^\r\n]*",
        re.IGNORECASE | re.MULTILINE,
    )
    _QUERY_STRING_PATTERN = re.compile(r"(?P<target>(?:https?|wss?)://[^\s\"']+|/[^\s\"'?]+)\?[^\s\"']*", re.IGNORECASE)
    _TOKEN_PARAMETER_PATTERN = re.compile(r"(?P<name>\b(?:access_token|id_token|refresh_token|token)\b\s*=\s*)[^\s,;&\"']+", re.IGNORECASE)
    _BEARER_TOKEN_PATTERN = re.compile(r"(?P<scheme>\bBearer\s+)[^\s,;]+", re.IGNORECASE)
    _DOWNLOAD_INTENT_PATTERN = re.compile(r"(?P<path>/api/viewer/download-intents/)[A-Za-z0-9_-]+")
    _AUTHENTICATION_STEP_PATTERN = re.compile(
        r"(?P<label>\b(?:SPNEGO|NTLM|GSSAPI|SSPI) step (?:input|output):)[ \t]*[^\r\n]*", re.IGNORECASE
    )

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted_message = self._SENSITIVE_HEADER_PATTERN.sub(r"\g<header><redacted>", message)
        redacted_message = self._QUERY_STRING_PATTERN.sub(r"\g<target>?<redacted>", redacted_message)
        redacted_message = self._TOKEN_PARAMETER_PATTERN.sub(r"\g<name><redacted>", redacted_message)
        redacted_message = self._BEARER_TOKEN_PATTERN.sub(r"\g<scheme><redacted>", redacted_message)
        redacted_message = self._DOWNLOAD_INTENT_PATTERN.sub(r"\g<path><redacted>", redacted_message)
        redacted_message = self._AUTHENTICATION_STEP_PATTERN.sub(r"\g<label> <redacted>", redacted_message)
        if redacted_message != message:
            record.msg = redacted_message
            record.args = ()
        return True


class RecoveryLogFormatter(logging.Formatter):
    """Render one-line summaries without exception text or raw tracebacks."""

    _FIELDS = (
        "event",
        "operation",
        "stage",
        "source_id",
        "generation_id",
        "duration_ms",
        "retry_seconds",
        "retry_after_ms",
        "invalidation_reason",
        "invalidation_count",
        "scan_generation",
        "scan_phase",
        "parents_done",
        "parents_queued",
        "directories_found",
        "smb_round_trips",
        "group_commits",
        "abort_reason",
        "issue_code",
        "access_denied_count",
        "unsupported_encoding_count",
        "unsafe_traversal_count",
        "scan_failed_count",
        "stale_turns",
        "retained_worker_count",
        "error_type",
        "error_id",
        "errno",
        "sqlite_errorcode",
    )
    _PROTOCOL_LOGGERS = ("smbclient", "smbprotocol")
    _RECOVERY_LOGGERS = ("app.storage.smb", "app.services.directory_", "app.api.browser", *_PROTOCOL_LOGGERS)

    def format(self, record: logging.LogRecord) -> str:
        if record.exc_info and not getattr(record, "error_id", None):
            record.error_id = uuid.uuid4().hex
        safe_record = copy(record)
        safe_record.exc_text = None
        if record.name.startswith(self._PROTOCOL_LOGGERS):
            safe_record.msg = "SMB client diagnostic. Check source access if the operation failed."
            safe_record.args = ()
        if record.name.startswith(self._RECOVERY_LOGGERS) and record.exc_info:
            error_type, error, trace = record.exc_info
            causes = []
            seen = set()
            while error is not None and id(error) not in seen:
                seen.add(id(error))
                for field in ("errno", "sqlite_errorcode"):
                    code = getattr(error, field, None)
                    if isinstance(code, int) and getattr(safe_record, field, None) is None:
                        setattr(safe_record, field, code)
                frames = " -> ".join(f"{frame.name}:{frame.lineno}" for frame in traceback.extract_tb(trace))
                causes.append(f"{frames}; {error_type.__name__ if error_type else 'UnknownError'}")
                error = error.__cause__ or (None if error.__suppress_context__ else error.__context__) if error is not None else None
                if error is None:
                    break
                error_type, trace = type(error), error.__traceback__
            safe_record.exc_info = None
            safe_record.exc_text = f"Recovery traceback: {'; caused by '.join(causes)}"
        elif record.exc_info:
            safe_record.error_type = record.exc_info[0].__name__ if record.exc_info[0] else "UnknownError"
            safe_record.exc_info = None
        safe_record.stack_info = None
        message = super().format(safe_record)
        fields = {}
        for key in self._FIELDS:
            value = getattr(safe_record, key, None)
            if isinstance(value, (int, float)) or (isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", value)):
                fields[key] = value
        output = f"{message} | {format_audit_fields(**fields)}" if fields else message
        return output.replace("\r", "\\r").replace("\n", "\\n")


class ExceptionDiagnosticFilter(logging.Filter):
    """Keep full exceptions in a separate file with the summary's error ID."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not record.exc_info:
            return False
        if not getattr(record, "error_id", None):
            record.error_id = uuid.uuid4().hex
        return True


def _open_private_diagnostic(path: str, flags: int) -> int:
    return os.open(path, flags, 0o600)


class PrivateDiagnosticFileHandler(RotatingFileHandler):
    """Keep restrictive permissions when rotation creates a new log file."""

    def _open(self) -> TextIOWrapper:
        return open(self.baseFilename, "a", encoding=self.encoding, errors=self.errors, opener=_open_private_diagnostic)


def create_diagnostic_handler(directory: Path) -> RotatingFileHandler:
    """Create a bounded, owner-only exception log outside normal output."""
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = directory / DIAGNOSTIC_LOG_FILENAME
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    handler = PrivateDiagnosticFileHandler(
        path, maxBytes=DIAGNOSTIC_LOG_MAX_BYTES, backupCount=DIAGNOSTIC_LOG_BACKUP_COUNT, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(name)s - %(levelname)s - error_id=%(error_id)s - %(message)s"))
    handler.addFilter(ExceptionDiagnosticFilter())
    handler.addFilter(SensitiveDataLogFilter())
    return handler


class AccessLogLevelFilter(logging.Filter):
    """Classify access events as DEBUG after their logger-level threshold is applied."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno < logging.WARNING:
            record.levelno = logging.DEBUG
            record.levelname = logging.getLevelName(logging.DEBUG)
        return True


class HttpClientLogFilter(logging.Filter):
    """Avoid duplicate HTTPX records when the caller emits a full summary."""

    def filter(self, record: logging.LogRecord) -> bool:
        return record.levelno >= logging.WARNING or not http_summary_active.get()


class UvicornProtocolLogFilter(logging.Filter):
    """Keep handshake summaries without raw WebSocket protocol output."""

    _HANDSHAKE_PATTERN = re.compile(r'^(?:.* - ")?WebSocket (?P<path>[^"?]+)(?:\?[^\"]*)?" (?P<status>\[accepted\]|\d{3})$')
    _REJECTION_PATTERN = re.compile(r"^connection rejected \((?P<status>\d{3}) [^\r\n]+\)$")
    _PROTOCOL_PREFIXES = ("< ", "> ", "= ", "% ", "! ", "x ", "- timed out ")

    def __init__(self, protocol_log_level: int, access_log_level: int | None = None, application_log_level: int = logging.NOTSET) -> None:
        super().__init__()
        self.protocol_log_level = protocol_log_level
        self.access_log_level = access_log_level if access_log_level is not None else protocol_log_level
        self.application_log_level = application_log_level

    def filter(self, record: logging.LogRecord) -> bool:
        if getattr(record, "_sambee_websocket_summary", False):
            return True
        message = record.getMessage()
        handshake = self._HANDSHAKE_PATTERN.fullmatch(message)
        if handshake is not None:
            if record.levelno < self.access_log_level:
                return False
            status = handshake["status"]
            record.msg = "event=ws_handshake path=%r status=%s outcome=%s"
            record.args = (
                handshake["path"],
                101 if status == "[accepted]" else int(status),
                "accepted" if status == "[accepted]" else "rejected",
            )
            context = websocket_log_context.get()
            if context is not None:
                record.msg += " connection_id=%s duration_ms=%.1f"
                record.args += (context[0], (monotonic() - context[1]) * MILLISECONDS_PER_SECOND)
            record.levelno = logging.DEBUG
            record.levelname = logging.getLevelName(logging.DEBUG)
            record._sambee_websocket_summary = True
            return True

        rejection = self._REJECTION_PATTERN.fullmatch(message)
        if rejection is not None and record.levelno >= logging.INFO and websocket_log_context.get() is None:
            if record.levelno < self.access_log_level:
                return False
            record.msg = "event=ws_handshake status=%s outcome=rejected"
            record.args = (int(rejection["status"]),)
            record.levelno = logging.DEBUG
            record.levelname = logging.getLevelName(logging.DEBUG)
            record._sambee_websocket_summary = True
            return True

        is_protocol_message = (
            hasattr(record, "websocket")
            or message
            in {
                "connection open",
                "connection closed",
            }
            or message.startswith((*self._PROTOCOL_PREFIXES, "connection rejected ("))
        )
        if is_protocol_message:
            return record.levelno >= max(logging.WARNING, self.protocol_log_level)
        return record.levelno >= self.application_log_level


class UvicornAccessLogFilter(logging.Filter):
    """Apply protocol verbosity to rejected WebSockets."""

    def __init__(self, protocol_log_level: int) -> None:
        super().__init__()
        self.protocol_log_level = protocol_log_level

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        is_rejected_websocket = "WebSocket " in message and message.endswith('" 403')
        if is_rejected_websocket and record.levelno < self.protocol_log_level:
            return False

        return SensitiveDataLogFilter().filter(record)


def configure_uvicorn_loggers(
    handlers: list[logging.Handler],
    log_format: str,
    application_log_level: int,
    access_log_level: int,
    protocol_log_level: int,
    diagnostic_handler: logging.Handler | None = None,
) -> None:
    """Configure Uvicorn access, protocol, and lifecycle log routing."""

    def configure_logger(
        logger_name: str,
        level: int,
        log_filter: logging.Filter | None = None,
        is_access_logger: bool = False,
    ) -> None:
        logger = logging.getLogger(logger_name)
        logger.setLevel(level)
        logger.handlers.clear()
        if diagnostic_handler is not None:
            logger.addHandler(diagnostic_handler)
        for handler in handlers:
            configured_handler = logging.StreamHandler(handler.stream) if isinstance(handler, logging.StreamHandler) else handler
            formatter = (
                RecoveryLogFormatter(log_format.replace("%(name)s", "uvicorn"))
                if logger_name == "uvicorn.error"
                else RecoveryLogFormatter(log_format)
            )
            configured_handler.setFormatter(formatter)
            configured_handler.addFilter(SensitiveDataLogFilter())
            if log_filter is not None:
                configured_handler.addFilter(log_filter)
            if is_access_logger:
                configured_handler.addFilter(AccessLogLevelFilter())
            logger.addHandler(configured_handler)
        logger.propagate = False

    protocol_filter = UvicornProtocolLogFilter(protocol_log_level, access_log_level, application_log_level)
    access_filter = UvicornAccessLogFilter(protocol_log_level)
    server_log_level = min(application_log_level, access_log_level, protocol_log_level)
    configure_logger("uvicorn", server_log_level, protocol_filter)
    configure_logger("uvicorn.error", server_log_level, protocol_filter)
    configure_logger("uvicorn.access", access_log_level, access_filter, is_access_logger=True)
    configure_logger("httpx", access_log_level, HttpClientLogFilter(), is_access_logger=True)
    configure_logger("httpx2", access_log_level, HttpClientLogFilter(), is_access_logger=True)
    configure_logger("app.protocol.http", access_log_level, is_access_logger=True)
    configure_logger("app.protocol.websocket", protocol_log_level)
    for logger_name in ("httpcore", "httpcore2", "watchfiles", "python_multipart", "spnego"):
        logging.getLogger(logger_name).setLevel(logging.WARNING)


class ContextAdapter(logging.LoggerAdapter[logging.Logger]):
    """
    Logging adapter that automatically adds request context to log messages.

    Adds request_id and user to all log messages when available.
    """

    #
    # process
    #
    def process(self, msg: str, kwargs: MutableMapping[str, Any]) -> tuple[str, MutableMapping[str, Any]]:
        """Add context information to log message."""

        request_id = get_request_id()
        user = get_user()

        # Build context suffix
        context_parts = []
        if request_id:
            context_parts.append(f"request_id={request_id}")
        if user:
            context_parts.append(f"user={user}")

        if context_parts:
            context_str = " - ".join(context_parts)
            msg = f"{msg} - {context_str}"

        return msg, kwargs


#
# get_logger
#
def get_logger(name: str) -> logging.LoggerAdapter[logging.Logger]:
    """
    Get a context-aware logger.

    Args:
        name: Logger name (typically __name__)

    Returns:
        LoggerAdapter that automatically includes request context.
    """

    base_logger = logging.getLogger(name)
    return ContextAdapter(base_logger, {})


#
# setup_early_error_logging
#
def setup_early_error_logging() -> logging.Logger:
    """
    Setup minimal logging for early startup errors.

    Used for critical errors that occur before main application initialization,
    such as missing configuration files, import errors, or file system issues.

    This function is idempotent - safe to call multiple times. It configures
    the root logger with a simple format suitable for error messages.

    Returns:
        Logger instance ready to use for error logging.

    Example:
        logger = setup_early_error_logging()
        logger.error("Configuration file not found")
        sys.exit(1)
    """

    # Configure root logger if not already configured
    # basicConfig is idempotent - only configures if no handlers exist
    logging.basicConfig(level=logging.ERROR, format="%(levelname)s - %(message)s")

    # Return a logger for the caller
    return logging.getLogger("sambee.startup")


#
# log_error
#
def log_error(logger: logging.Logger | logging.LoggerAdapter[logging.Logger], message: str) -> None:
    """
    Log an error message without stack trace.

    Use this for user-facing errors where stack traces would be confusing.
    Always logs with exc_info=False to prevent stack trace output.

    Args:
        logger: Logger instance to use for logging.
        message: Clear, concise error message with actionable information.
    """

    logger.error(message, exc_info=False)
