"""
Logging utilities for request context management.

Provides request ID tracking and context-aware logging throughout the application.
"""

import logging
import re
import traceback
import uuid
from collections.abc import MutableMapping
from contextvars import ContextVar
from copy import copy
from typing import Any, Optional

# Context variables for request tracking
request_id_var: ContextVar[Optional[str]] = ContextVar("request_id", default=None)
user_var: ContextVar[Optional[str]] = ContextVar("user", default=None)


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

    _QUERY_STRING_PATTERN = re.compile(r"(?P<target>(?:https?|wss?)://[^\s\"']+|/[^\s\"'?]+)\?[^\s\"']*", re.IGNORECASE)
    _TOKEN_PARAMETER_PATTERN = re.compile(r"(?P<name>\b(?:access_token|id_token|refresh_token|token)\b\s*=\s*)[^\s,;&\"']+", re.IGNORECASE)
    _BEARER_TOKEN_PATTERN = re.compile(r"(?P<scheme>\bBearer\s+)[^\s,;]+", re.IGNORECASE)
    _DOWNLOAD_INTENT_PATTERN = re.compile(r"(?P<path>/api/viewer/download-intents/)[A-Za-z0-9_-]+")

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted_message = self._QUERY_STRING_PATTERN.sub(r"\g<target>?<redacted>", message)
        redacted_message = self._TOKEN_PARAMETER_PATTERN.sub(r"\g<name><redacted>", redacted_message)
        redacted_message = self._BEARER_TOKEN_PATTERN.sub(r"\g<scheme><redacted>", redacted_message)
        redacted_message = self._DOWNLOAD_INTENT_PATTERN.sub(r"\g<path><redacted>", redacted_message)
        if redacted_message != message:
            record.msg = redacted_message
            record.args = ()
        return True


class RecoveryLogFormatter(logging.Formatter):
    """Render safe diagnostic fields and omit private recovery exception text."""

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
        "errno",
        "sqlite_errorcode",
    )
    _PROTOCOL_LOGGERS = ("smbclient", "smbprotocol")
    _RECOVERY_LOGGERS = ("app.storage.smb", "app.services.directory_", "app.api.browser", *_PROTOCOL_LOGGERS)

    def format(self, record: logging.LogRecord) -> str:
        safe_record = copy(record)
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
        message = super().format(safe_record)
        fields = {}
        for key in self._FIELDS:
            value = getattr(safe_record, key, None)
            if isinstance(value, (int, float)) or (isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", value)):
                fields[key] = value
        return f"{message} | {format_audit_fields(**fields)}" if fields else message


class AccessLogLevelFilter(logging.Filter):
    """Classify access events as DEBUG after their logger-level threshold is applied."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.levelno = logging.DEBUG
        record.levelname = logging.getLevelName(logging.DEBUG)
        return True


class UvicornProtocolLogFilter(logging.Filter):
    """Apply access and protocol thresholds to Uvicorn WebSocket records."""

    _FRAME_PREFIXES = (
        "> TEXT ",
        "< TEXT ",
        "> BINARY ",
        "< BINARY ",
        "> PING ",
        "< PING ",
        "> PONG ",
        "< PONG ",
        "> CLOSE ",
        "< CLOSE ",
    )

    def __init__(self, protocol_log_level: int, access_log_level: int | None = None) -> None:
        super().__init__()
        self.protocol_log_level = protocol_log_level
        self.access_log_level = access_log_level if access_log_level is not None else protocol_log_level

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "WebSocket " in message:
            if record.levelno < self.access_log_level:
                return False
            record.levelno = logging.DEBUG
            record.levelname = logging.getLevelName(logging.DEBUG)
            return True

        is_protocol_message = message in {
            "connection open",
            "connection closed",
            "connection rejected (403 Forbidden)",
        } or message.startswith(self._FRAME_PREFIXES)
        return not is_protocol_message or record.levelno >= self.protocol_log_level


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
        for handler in handlers:
            configured_handler = logging.StreamHandler(handler.stream) if isinstance(handler, logging.StreamHandler) else handler
            formatter = (
                logging.Formatter(log_format.replace("%(name)s", "uvicorn"))
                if logger_name == "uvicorn.error"
                else logging.Formatter(log_format)
            )
            configured_handler.setFormatter(formatter)
            configured_handler.addFilter(SensitiveDataLogFilter())
            if log_filter is not None:
                configured_handler.addFilter(log_filter)
            if is_access_logger:
                configured_handler.addFilter(AccessLogLevelFilter())
            logger.addHandler(configured_handler)
        logger.propagate = False

    protocol_filter = UvicornProtocolLogFilter(protocol_log_level, access_log_level)
    access_filter = UvicornAccessLogFilter(protocol_log_level)
    configure_logger("uvicorn", application_log_level, protocol_filter)
    configure_logger("uvicorn.error", application_log_level, protocol_filter)
    configure_logger("uvicorn.access", access_log_level, access_filter, is_access_logger=True)
    configure_logger("httpx", access_log_level, is_access_logger=True)


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
