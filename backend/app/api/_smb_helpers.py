import asyncio
import logging
from collections.abc import AsyncGenerator
from typing import Any

from fastapi import HTTPException, status

from app.core.security import decrypt_password
from app.models.connection import Connection
from app.storage.smb import SMBBackend

BACKEND_DISCONNECT_TIMEOUT_SECONDS = 5.0
ITEM_NOT_FOUND_CODE = "item_not_found"
FILE_ACCESS_DENIED_CODE = "file_access_denied"
NOT_A_FILE_CODE = "not_a_file"
NOT_A_DIRECTORY_CODE = "not_a_directory"
FILE_TIMEOUT_CODE = "file_timeout"
FILE_UNAVAILABLE_CODE = "file_unavailable"


def file_target_http_error(error: Exception, *, requires_file: bool = True) -> HTTPException:
    """Map physical item failures without exposing storage or operating-system details."""
    if isinstance(error, FileNotFoundError):
        status_code, code, message = (
            status.HTTP_404_NOT_FOUND,
            ITEM_NOT_FOUND_CODE,
            "The item was not found. It may have been moved or deleted.",
        )
    elif isinstance(error, PermissionError):
        status_code, code, message = (
            status.HTTP_403_FORBIDDEN,
            FILE_ACCESS_DENIED_CODE,
            "Access to this file was denied. Check your permissions and retry.",
        )
    elif isinstance(error, (IsADirectoryError, NotADirectoryError)):
        status_code = status.HTTP_409_CONFLICT
        code = NOT_A_FILE_CODE if requires_file else NOT_A_DIRECTORY_CODE
        message = (
            "This target is not a regular file. Select another file."
            if requires_file
            else "An item in this path is not a folder. Select another location."
        )
    elif isinstance(error, TimeoutError):
        status_code, code, message = (
            status.HTTP_504_GATEWAY_TIMEOUT,
            FILE_TIMEOUT_CODE,
            "The file request timed out. Check the connection and retry.",
        )
    else:
        status_code, code, message = (
            status.HTTP_503_SERVICE_UNAVAILABLE,
            FILE_UNAVAILABLE_CODE,
            "The file is unavailable. Check the connection and retry.",
        )
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def create_file_streamer(backend: SMBBackend, path: str) -> AsyncGenerator[bytes]:
    """Stream a physical file and release its backend on success, failure, or cancellation."""

    async def stream() -> AsyncGenerator[bytes]:
        try:
            async for chunk in backend.read_file(path):
                yield chunk
        finally:
            await disconnect_backend_safely(backend, logger=logging.getLogger(__name__), context="file stream")

    return stream()


async def prepare_file_streamer(backend: SMBBackend, path: str) -> AsyncGenerator[bytes]:
    """Open the source before headers commit so initial read failures remain structured."""
    stream = create_file_streamer(backend, path)
    try:
        first_chunk = await anext(stream, None)
    except Exception as error:
        raise file_target_http_error(error) from error

    async def prepared_stream() -> AsyncGenerator[bytes]:
        try:
            if first_chunk is not None:
                yield first_chunk
            async for chunk in stream:
                yield chunk
        finally:
            await stream.aclose()

    return prepared_stream()


def require_share_name(connection: Connection) -> str:
    """Return a validated share name for SMB backend construction."""

    assert connection.share_name is not None
    return connection.share_name


def build_smb_backend(
    connection: Connection,
    *,
    backend_factory: type[SMBBackend] = SMBBackend,
) -> SMBBackend:
    """Build an SMB backend instance from a persisted connection."""

    return backend_factory(
        host=connection.host,
        share_name=require_share_name(connection),
        username=connection.username,
        password=decrypt_password(connection.password_encrypted),
        port=connection.port,
        path_prefix=connection.path_prefix or "/",
        connection_context_key=str(connection.id),
    )


def build_smb_backend_from_details(
    *,
    host: str,
    share_name: str,
    username: str,
    password: str,
    port: int,
    path_prefix: str | None,
    backend_factory: type[SMBBackend] = SMBBackend,
) -> SMBBackend:
    """Build an SMB backend instance from raw connection details."""

    return backend_factory(
        host=host,
        share_name=share_name,
        username=username,
        password=password,
        port=port,
        path_prefix=path_prefix or "/",
        close_connection_cache_on_disconnect=True,
    )


async def disconnect_backend_safely(
    backend: SMBBackend,
    *,
    logger: logging.Logger | logging.LoggerAdapter[Any],
    context: str,
) -> None:
    """Disconnect the backend without masking the main request outcome."""

    try:
        await asyncio.wait_for(backend.disconnect(), timeout=BACKEND_DISCONNECT_TIMEOUT_SECONDS)
    except Exception:
        logger.warning("Failed to disconnect backend cleanly after %s", context, exc_info=True)
