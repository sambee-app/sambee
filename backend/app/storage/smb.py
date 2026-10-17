import asyncio
import logging
import stat
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import datetime
from pathlib import PurePosixPath
from time import monotonic
from typing import Any, Awaitable, BinaryIO, TypeVar, cast

import smbclient
from smbclient._io import SMBFileIO, SMBFileTransaction, query_info
from smbclient._os import FileAttributes
from smbprotocol.exceptions import SMBResponseException
from smbprotocol.file_info import (
    FileBasicInformation,
    FileDispositionInformation,
    FileInternalInformation,
    FileStandardInformation,
    InfoType,
)
from smbprotocol.open import FileInformationClass, FilePipePrinterAccessMask, SMB2SetInfoRequest, SMB2SetInfoResponse
from smbprotocol.structure import DateTimeField

from app.core.system_setting_definitions import SystemSettingKey
from app.models.file import DirectoryListing, FileInfo, FileType
from app.services.archive.target_write import TargetExistsBeforeContent, TargetWriteFailure, TargetWriteResult
from app.services.archive.zip_reader import ArchiveSourceUnavailableError
from app.services.content_transfer import SourceDeleteError, SourceDeletionOutcomeUnknown
from app.services.system_settings import get_integer_setting_value, get_smbclient_policy_kwargs
from app.storage.base import ExclusiveWriter, MoveSourceReader, ProgressCallback, RandomAccessReader, StorageBackend
from app.storage.smb_pool import get_connection_pool, get_smb_connection_cache
from app.utils.file_type_registry import get_mime_type

logger = logging.getLogger(__name__)

SMB_LIST_DIRECTORY_TIMEOUT_SECONDS = 30.0
SMB_FILE_INFO_TIMEOUT_SECONDS = 10.0
SMB_FILE_OPEN_TIMEOUT_SECONDS = 15.0
SMB_READ_CHUNK_TIMEOUT_SECONDS = 30.0
SMB_FILE_CLOSE_TIMEOUT_SECONDS = 5.0
SMB_WRITE_FILE_TIMEOUT_SECONDS = 120.0
SMB_EXISTS_TIMEOUT_SECONDS = 10.0
SMB_DELETE_TIMEOUT_SECONDS = 120.0
SMB_FILETIME_TICKS_PER_SECOND = 10_000_000

BlockingResultT = TypeVar("BlockingResultT")
_MOVE_CLEANUP_TASKS: set[asyncio.Task[None]] = set()


def _retain_move_cleanup(task: asyncio.Task[None]) -> None:
    _MOVE_CLEANUP_TASKS.add(task)

    def completed(result: asyncio.Task[None]) -> None:
        _MOVE_CLEANUP_TASKS.discard(result)
        if not result.cancelled() and result.exception() is not None:
            logger.warning("Deferred SMB move cleanup failed", exc_info=result.exception())

    task.add_done_callback(completed)


class _SMBRandomAccessReader:
    """One SMB handle with serialized offset reads for an archive operation."""

    def __init__(self, *, backend: "SMBBackend", smb_path: str, handle: BinaryIO, connection_lease: object) -> None:
        self._backend = backend
        self._smb_path = smb_path
        self._handle = handle
        self._connection_lease = connection_lease
        self._lock = asyncio.Lock()
        self._closed = False

    async def read_at(self, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0:
            raise ValueError("SMB random-access reads require non-negative offset and length")

        async with self._lock:
            if self._closed:
                raise ValueError("SMB random-access reader is closed")

            def _read_at() -> bytes:
                self._handle.seek(offset)
                return self._handle.read(length)

            return await self._backend._run_blocking_smb_call(
                "read_file_at",
                _read_at,
                SMB_READ_CHUNK_TIMEOUT_SECONDS,
                smb_path=self._smb_path,
            )

    async def close(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            try:
                await self._backend._run_blocking_smb_call(
                    "close_file_after_random_read",
                    self._handle.close,
                    SMB_FILE_CLOSE_TIMEOUT_SECONDS,
                    smb_path=self._smb_path,
                )
            finally:
                await self._connection_lease.__aexit__(None, None, None)  # type: ignore[attr-defined]


class _SMBMoveSourceReader(_SMBRandomAccessReader):
    """A read handle that marks the exact opened SMB object for deletion on commit."""

    def __init__(self, *, backend: "SMBBackend", smb_path: str, handle: BinaryIO, connection_lease: object, source_path: str) -> None:
        super().__init__(backend=backend, smb_path=smb_path, handle=handle, connection_lease=connection_lease)
        self._source_path = source_path
        self._inflight: asyncio.Future[Any] | None = None
        self._cleanup: asyncio.Task[None] | None = None

    async def _operate(self, operation: Callable[[], BlockingResultT], timeout: float) -> BlockingResultT:
        if self._closed:
            raise ValueError("SMB move source reader is closed")
        if self._inflight is not None and not self._inflight.done():
            raise RuntimeError("Previous SMB move source operation is still running")
        future = asyncio.get_running_loop().run_in_executor(None, operation)
        self._inflight = future
        return await asyncio.wait_for(asyncio.shield(future), timeout)

    async def read_at(self, offset: int, length: int) -> bytes:
        if offset < 0 or length < 0:
            raise ValueError("SMB random-access reads require non-negative offset and length")
        async with self._lock:

            def read() -> bytes:
                self._handle.seek(offset)
                return self._handle.read(length)

            return await self._operate(read, SMB_READ_CHUNK_TIMEOUT_SECONDS)

    async def get_file_info(self) -> FileInfo:
        async with self._lock:

            def observe() -> FileInfo:
                raw = cast(SMBFileIO, self._handle)
                with SMBFileTransaction(raw) as transaction:
                    query_info(transaction, FileBasicInformation)
                    query_info(transaction, FileInternalInformation)
                    query_info(transaction, FileStandardInformation)
                basic, internal, standard = transaction.results
                return FileInfo(
                    name=PurePosixPath(self._smb_path.replace("\\", "/")).name,
                    path=self._source_path,
                    type=FileType.DIRECTORY if standard["directory"].get_value() else FileType.FILE,
                    size=standard["end_of_file"].get_value(),
                    modified_at=datetime.fromtimestamp(
                        (basic["last_write_time"].get_value() - DateTimeField.EPOCH_FILETIME) / SMB_FILETIME_TICKS_PER_SECOND
                    ),
                    stable_id=str(internal["index_number"].get_value()),
                )

            return await self._operate(observe, SMB_FILE_INFO_TIMEOUT_SECONDS)

    async def close(self) -> None:
        async with self._lock:
            if self._cleanup is None:
                self._closed = True

                async def cleanup() -> None:
                    try:
                        if self._inflight is not None:
                            try:
                                await asyncio.shield(self._inflight)
                            except BaseException:
                                pass
                        await asyncio.get_running_loop().run_in_executor(None, self._handle.close)
                    finally:
                        await self._connection_lease.__aexit__(None, None, None)  # type: ignore[attr-defined]

                self._cleanup = asyncio.create_task(cleanup())
                _retain_move_cleanup(self._cleanup)
            cleanup_task = self._cleanup
        await asyncio.wait_for(asyncio.shield(cleanup_task), SMB_FILE_CLOSE_TIMEOUT_SECONDS)

    async def commit_delete(self, *, cancellation: Callable[[], bool] | None = None) -> None:
        async with self._lock:
            if self._closed:
                raise SourceDeleteError("Move source handle was closed before delete dispatch", destination_mutated=True)

            loop = asyncio.get_running_loop()
            dispatched = False

            async def cancellation_requested() -> bool:
                """Keep callbacks that access database state on their owning event loop."""
                return cancellation is not None and cancellation()

            def _delete_opened_file() -> None:
                nonlocal dispatched
                raw = cast(SMBFileIO, self._handle)
                request = SMB2SetInfoRequest()
                request["info_type"] = InfoType.SMB2_0_INFO_FILE
                request["file_info_class"] = FileInformationClass.FILE_DISPOSITION_INFORMATION
                request["file_id"] = raw.fd.file_id
                disposition = FileDispositionInformation()
                disposition["delete_pending"] = True
                request["buffer"] = disposition.pack()
                connection = raw.fd.connection
                session_id = raw.fd.tree_connect.session.session_id
                tree_connect_id = raw.fd.tree_connect.tree_connect_id
                if cancellation is not None:
                    pending_cancellation = asyncio.run_coroutine_threadsafe(cancellation_requested(), loop)
                    try:
                        cancelled = pending_cancellation.result(timeout=SMB_DELETE_TIMEOUT_SECONDS)
                    finally:
                        pending_cancellation.cancel()
                    if cancelled:
                        raise SourceDeleteError(
                            "Move cancelled before source delete dispatch; the destination is published and the source is retained",
                            destination_mutated=True,
                        )
                dispatched = True
                pending = connection.send(request, session_id, tree_connect_id)
                response = connection.receive(pending)
                parsed = SMB2SetInfoResponse()
                parsed.unpack(response["data"].get_value())

            try:
                await self._operate(_delete_opened_file, SMB_DELETE_TIMEOUT_SECONDS)
            except SourceDeleteError:
                raise
            except SMBResponseException as error:
                raise SourceDeleteError(
                    "SMB server rejected source deletion; the destination is published and the source is retained",
                    destination_mutated=True,
                ) from error
            except (Exception, asyncio.CancelledError) as error:
                if not dispatched and not isinstance(error, (TimeoutError, asyncio.CancelledError)):
                    raise SourceDeleteError(
                        "Source delete was not dispatched; the destination is published and source retained",
                        destination_mutated=True,
                    ) from error
                raise SourceDeletionOutcomeUnknown("SMB source delete acknowledgement was not confirmed") from error
        try:
            await self.close()
        except (Exception, asyncio.CancelledError) as error:
            raise SourceDeletionOutcomeUnknown("SMB source close after delete-pending was not confirmed") from error


class _SMBExclusiveWriter:
    """One exclusively created SMB target, retained until close or cleanup."""

    def __init__(self, *, backend: "SMBBackend", smb_path: str, handle: BinaryIO, connection_lease: object) -> None:
        self._backend = backend
        self._smb_path = smb_path
        self._handle = handle
        self._connection_lease = connection_lease
        self._lock = asyncio.Lock()
        self._closed = False

    async def write(self, data: bytes) -> int:
        if not data:
            return 0
        async with self._lock:
            if self._closed:
                raise ValueError("SMB exclusive writer is closed")
            return await self._backend._run_blocking_smb_call(
                "write_exclusive_file",
                lambda: self._handle.write(data),
                SMB_WRITE_FILE_TIMEOUT_SECONDS,
                smb_path=self._smb_path,
            )

    async def close(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            try:
                await self._backend._run_blocking_smb_call(
                    "close_exclusive_file",
                    self._handle.close,
                    SMB_FILE_CLOSE_TIMEOUT_SECONDS,
                    smb_path=self._smb_path,
                )
            finally:
                await self._connection_lease.__aexit__(None, None, None)  # type: ignore[attr-defined]

    async def abort_and_delete_if_owned(self) -> bool:
        async with self._lock:
            if self._closed:
                return False
            try:
                await self._backend._run_blocking_smb_call(
                    "delete_owned_exclusive_file",
                    lambda: smbclient.remove(self._smb_path, **self._backend._smb_auth_kwargs()),
                    SMB_DELETE_TIMEOUT_SECONDS,
                    smb_path=self._smb_path,
                )
            except OSError:
                return False
            await self._backend._run_blocking_smb_call(
                "close_deleted_exclusive_file",
                self._handle.close,
                SMB_FILE_CLOSE_TIMEOUT_SECONDS,
                smb_path=self._smb_path,
            )
            self._closed = True
            await self._connection_lease.__aexit__(None, None, None)  # type: ignore[attr-defined]
            return True


class SMBBackend(StorageBackend):
    """SMB storage backend using smbprotocol"""

    # Sentinel for no prefix (share root)
    _NO_PREFIX = ""

    #
    # __init__
    #
    def __init__(
        self,
        host: str,
        share_name: str,
        username: str,
        password: str,
        port: int = 445,
        path_prefix: str = "/",
        connection_context_key: str | None = None,
        close_connection_cache_on_disconnect: bool = False,
    ):
        """Initialize SMB storage backend.

        Args:
            host: SMB server hostname or IP.
            share_name: Name of the SMB share.
            username: SMB authentication username.
            password: SMB authentication password.
            port: SMB port (default 445).
            path_prefix: Base path within the share. When set to a
                non-root value (e.g. "/photos"), all operations are
                scoped to that sub-directory — the frontend never
                sees the prefix in returned paths.
            connection_context_key: Stable identity for a persisted connection.
            close_connection_cache_on_disconnect: Close this backend's private
                cache instead of retaining it for pooled reuse.
        """

        self.host = host
        self.share_name = share_name
        self.username = username
        self.password = password
        self.port = port
        self._base_path = f"\\\\{host}\\{share_name}"
        # Persisted connections share one isolated cache across request-scoped
        # backend instances. Detail-only test backends remain self-contained.
        self._connection_cache = get_smb_connection_cache(connection_context_key) if connection_context_key is not None else {}
        self._close_connection_cache_on_disconnect = close_connection_cache_on_disconnect

        # Normalize path_prefix: strip slashes, collapse to empty string for root
        self._path_prefix = self._normalize_prefix(path_prefix)

    def _smb_auth_kwargs(self) -> dict[str, object]:
        """Return credentials required to select this backend's SMB session."""

        return {
            "username": self.username,
            "password": self.password,
            "port": self.port,
            "connection_cache": self._connection_cache,
            **get_smbclient_policy_kwargs(),
        }

    #
    # connect
    #
    async def connect(self) -> None:
        """
        Establish SMB connection using connection pool.

        This acquires a connection from the global pool. If a connection
        to this server already exists, it will be reused. Otherwise, a new
        connection is created.

        The connection is NOT immediately established here - it's acquired
        through the pool's context manager when operations are performed.
        """

        # Connection pooling is handled transparently in operations.
        logger.debug(f"SMB backend ready (will use pooled connection): //{self.host}:{self.port}/{self.share_name}")

    #
    # disconnect
    #
    async def disconnect(self) -> None:
        """
        Release SMB connection back to pool.

        The connection is not actually closed - it's returned to the pool
        for reuse by other requests. The pool will clean up idle connections
        automatically.
        """

        if self._close_connection_cache_on_disconnect:
            pool = await get_connection_pool()
            await pool.invalidate_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
                reason="ephemeral connection validation completed",
            )
            return

        logger.debug(f"SMB backend released (connection remains in pool): //{self.host}/{self.share_name}")

    #
    # _normalize_prefix
    #
    @staticmethod
    def _normalize_prefix(prefix: str | None) -> str:
        """Normalize a path prefix to a clean relative form.

        "/"  -> ""  (share root)
        None -> ""  (share root)
        ""   -> ""  (share root)
        "/photos"  -> "photos"
        "/a/b/c/"  -> "a/b/c"
        """

        return SMBBackend._normalize_relative_path(prefix)

    @staticmethod
    def _normalize_relative_path(path: str | None) -> str:
        """Return a share-relative SMB path or reject an unsafe path."""

        if not path:
            return SMBBackend._NO_PREFIX
        if any(ord(character) < 32 for character in path):
            raise ValueError("SMB paths cannot contain control characters")

        if path.startswith("\\\\"):
            raise ValueError("SMB paths must be relative to the configured share")
        normalized = path.replace("\\", "/")

        cleaned = normalized.strip("/")
        segments = cleaned.split("/")
        if any(segment in {".", ".."} for segment in segments):
            raise ValueError("SMB paths cannot contain traversal segments")
        return cleaned

    #
    # _build_smb_path
    #
    def _build_smb_path(self, path: str) -> str:
        """Build full SMB path from relative path.

        The path_prefix is prepended automatically so the caller only
        needs to supply paths relative to the application root.
        """

        path = self._normalize_relative_path(path)

        # Combine prefix and path
        if self._path_prefix and path:
            full_rel = f"{self._path_prefix}/{path}"
        elif self._path_prefix:
            full_rel = self._path_prefix
        else:
            full_rel = path

        if full_rel:
            return f"{self._base_path}\\{full_rel.replace('/', '\\')}"
        return self._base_path

    async def _invalidate_pooled_connection(self, reason: str) -> None:
        pool = await get_connection_pool()
        await pool.invalidate_connection(
            host=self.host,
            port=self.port,
            username=self.username,
            share_name=self.share_name,
            connection_cache=self._connection_cache,
            reason=reason,
        )

    async def _run_blocking_smb_call(
        self,
        operation_name: str,
        operation: Callable[[], BlockingResultT],
        timeout_seconds: float,
        *,
        smb_path: str,
    ) -> BlockingResultT:
        try:
            return await self._run_blocking_smb_operation(
                operation_name,
                operation,
                timeout_seconds,
                smb_path=smb_path,
            )
        except asyncio.TimeoutError as exc:
            raise TimeoutError(f"SMB operation timed out during {operation_name}") from exc

    async def _run_blocking_smb_operation(
        self,
        operation_name: str,
        operation: Callable[[], BlockingResultT],
        timeout_seconds: float,
        *,
        smb_path: str,
    ) -> BlockingResultT:
        """Run executor work without releasing its SMB cache before it completes."""

        loop = asyncio.get_running_loop()
        operation_future = loop.run_in_executor(None, operation)

        try:
            return await self._wait_for_blocking_smb_operation(
                operation_future,
                operation_name=operation_name,
                smb_path=smb_path,
                timeout_seconds=timeout_seconds,
            )
        except asyncio.TimeoutError:
            pool = await get_connection_pool()
            await pool.retain_connection_until_future_complete(self._connection_cache, operation_future)
            logger.error(
                "Timeout during SMB %s for '%s' after %.1fs",
                operation_name,
                smb_path,
                timeout_seconds,
            )
            try:
                await self._invalidate_pooled_connection(f"timeout during {operation_name}")
            except Exception:
                logger.warning(
                    "Failed to invalidate pooled SMB connection after timeout during %s",
                    operation_name,
                    exc_info=True,
                )
            raise
        except asyncio.CancelledError:
            pool = await get_connection_pool()
            await pool.retain_connection_until_future_complete(self._connection_cache, operation_future)
            raise

    async def _wait_for_blocking_smb_operation(
        self,
        operation_future: asyncio.Future[BlockingResultT],
        *,
        operation_name: str,
        smb_path: str,
        timeout_seconds: float,
    ) -> BlockingResultT:
        try:
            return await asyncio.wait_for(asyncio.shield(operation_future), timeout=timeout_seconds)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            operation_future.add_done_callback(
                lambda completed_operation: self._report_late_smb_operation_result(
                    completed_operation,
                    operation_name=operation_name,
                    smb_path=smb_path,
                )
            )
            raise

    @staticmethod
    def _report_late_smb_operation_result(
        operation_future: asyncio.Future[BlockingResultT],
        *,
        operation_name: str,
        smb_path: str,
    ) -> None:
        try:
            operation_future.result()
        except asyncio.CancelledError:
            logger.warning("SMB %s for '%s' was cancelled after timing out", operation_name, smb_path)
        except Exception:
            logger.warning("SMB %s for '%s' failed after timing out", operation_name, smb_path, exc_info=True)
        else:
            logger.warning("SMB %s for '%s' completed after timing out", operation_name, smb_path)

    #
    # list_directory
    #
    async def list_directory(self, path: str = "") -> DirectoryListing:
        """List contents of a directory"""

        smb_path = self._build_smb_path(path)
        logger.debug(f"Listing directory: path='{path}' -> smb_path='{smb_path}'")

        try:
            # Acquire connection from pool
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                # Use scandir for better performance - all info from ONE SMB query_directory call
                def _scan_directory() -> list[FileInfo]:
                    result = []
                    # Pass credentials so smbclient selects this backend's session.
                    # scandir internally manages its SMBDirectoryIO handle
                    # and already filters out "." and ".." entries.
                    for entry in smbclient.scandir(smb_path, **self._smb_auth_kwargs()):
                        item_path = f"{path}/{entry.name}" if path else entry.name

                        try:
                            # Use smb_info which is already populated by scandir - NO extra SMB calls!
                            info = entry.smb_info

                            # OPTIMIZATION: Check directory flag directly from file_attributes
                            # to avoid calling is_dir() which might call is_symlink() which might
                            # call stat() for reparse points (symlinks/junctions)
                            is_dir = bool(info.file_attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY)

                            # Convert Windows FILETIME (100ns intervals since 1601) to Python datetime
                            # The smb_info already has datetime objects
                            file_info = FileInfo(
                                name=entry.name,
                                path=item_path,
                                type=FileType.DIRECTORY if is_dir else FileType.FILE,
                                size=info.end_of_file if not is_dir else None,
                                mime_type=None if is_dir else get_mime_type(entry.name),
                                modified_at=info.last_write_time,
                                created_at=info.creation_time,
                                is_hidden=entry.name.startswith("."),
                            )
                            result.append(file_info)
                        except Exception as e:
                            logger.warning(f"Failed to process {entry.name}: {e}")
                            # Add basic entry even if processing fails
                            result.append(
                                FileInfo(
                                    name=entry.name,
                                    path=item_path,
                                    type=FileType.FILE,
                                    is_readable=False,
                                    is_hidden=entry.name.startswith("."),
                                )
                            )
                    return result

                items = await self._run_blocking_smb_call(
                    "list_directory",
                    _scan_directory,
                    SMB_LIST_DIRECTORY_TIMEOUT_SECONDS,
                    smb_path=smb_path,
                )

                # NOTE: No sorting here - frontend handles sorting based on user preference
                # Avoiding unnecessary work on the backend for large directories

                return DirectoryListing(path=path or "/", items=items, total=len(items))

        except TimeoutError:
            logger.error(
                f"Timeout listing directory '{path}' (smb_path='{smb_path}') after {SMB_LIST_DIRECTORY_TIMEOUT_SECONDS:.0f} seconds"
            )
            raise TimeoutError(f"SMB operation timed out while listing directory: {path}")
        except Exception as e:
            logger.error(
                f"Failed to list directory '{path}' (smb_path='{smb_path}'): {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise

    #
    # get_file_info
    #
    async def get_file_info(self, path: str) -> FileInfo:
        """Get information about a specific file or directory"""

        smb_path = self._build_smb_path(path)

        try:
            # Acquire connection from pool
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                stat_info = await self._run_blocking_smb_call(
                    "get_file_info",
                    lambda: smbclient.stat(smb_path, **self._smb_auth_kwargs()),
                    SMB_FILE_INFO_TIMEOUT_SECONDS,
                    smb_path=smb_path,
                )

                # Derive directory status from stat_info.st_mode (already fetched above)
                # instead of calling smbclient.path.isdir() which would make a redundant
                # blocking SMB round-trip on the event loop.
                is_dir = stat.S_ISDIR(stat_info.st_mode)
                filename = PurePosixPath(path).name

                return FileInfo(
                    name=filename,
                    path=path,
                    type=FileType.DIRECTORY if is_dir else FileType.FILE,
                    size=stat_info.st_size if not is_dir else None,
                    mime_type=None if is_dir else get_mime_type(filename),
                    modified_at=datetime.fromtimestamp(stat_info.st_mtime),
                    created_at=datetime.fromtimestamp(stat_info.st_ctime),
                    stable_id=str(stat_info.st_ino) if getattr(stat_info, "st_ino", 0) else None,
                    is_hidden=filename.startswith("."),
                )

        except Exception as e:
            error_str = str(e)
            if "0xc0000034" in error_str or "No such file" in error_str or "File not found" in error_str:
                raise FileNotFoundError(f"Path not found: {path}") from e
            logger.error(f"Failed to get file info for {path}: {e}")
            raise

    #
    # read_file
    #
    async def read_file(self, path: str) -> AsyncIterator[bytes]:
        """Read file contents as chunks"""

        # Set the SMB chunk size
        # Larger chunk sizes can improve throughput but use more memory (on both client and server)
        # Larger chunks also use more SMB credits
        chunk_size = get_integer_setting_value(SystemSettingKey.SMB_READ_CHUNK_SIZE_BYTES)

        # Build full SMB path
        smb_path = self._build_smb_path(path)

        try:
            # Acquire connection from pool
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                # Open file with retry logic for file locking issues
                # SMB can throw "file in use" errors when multiple requests access the same file
                max_retries = 3
                retry_delay = 0.1  # Start with 100ms
                file_handle = None

                for attempt in range(max_retries):
                    try:
                        file_handle = await self._run_blocking_smb_call(
                            "open_file_for_read",
                            lambda: smbclient.open_file(
                                smb_path,
                                mode="rb",
                                share_access="rwd",
                                **self._smb_auth_kwargs(),
                            ),
                            SMB_FILE_OPEN_TIMEOUT_SECONDS,
                            smb_path=smb_path,
                        )
                        if attempt > 0:
                            logger.info(f"Successfully opened file after {attempt + 1} attempts: {path}")
                        break  # Success
                    except Exception as e:
                        # Check for retryable errors
                        error_str = str(e)
                        is_lock_error = "0xc0000043" in error_str or "being used by another process" in error_str
                        is_credit_error = "credits" in error_str.lower() and "available" in error_str.lower()

                        if (is_lock_error or is_credit_error) and attempt < max_retries - 1:
                            # Wait with exponential backoff and retry
                            error_type = "credits exhausted" if is_credit_error else "file locked"
                            logger.warning(f"SMB {error_type}, retrying in {retry_delay}s (attempt {attempt + 1}/{max_retries}): {path}")
                            await asyncio.sleep(retry_delay)
                            retry_delay *= 2  # Double the delay each time
                        else:
                            # Not a retryable error or out of retries
                            raise

                if not file_handle:
                    raise RuntimeError(f"Failed to open file after {max_retries} attempts")

                try:
                    while True:
                        try:
                            chunk = await self._run_blocking_smb_call(
                                "read_file_chunk",
                                lambda: file_handle.read(chunk_size),
                                SMB_READ_CHUNK_TIMEOUT_SECONDS,
                                smb_path=smb_path,
                            )
                            if not chunk:
                                break
                            yield chunk
                        except Exception as read_error:
                            # Check for file deletion/modification errors
                            error_str = str(read_error)
                            # NtStatus 0xc0000034 = FILE_NOT_FOUND (file deleted during read)
                            # NtStatus 0xc0000043 = SHARING_VIOLATION (file locked during read)
                            # Credit exhaustion = "Request requires X credits but only Y credits are available"
                            if "0xc0000034" in error_str or "does not exist" in error_str.lower():
                                logger.warning(f"File was deleted during read: {path}")
                                raise FileNotFoundError(f"File was deleted: {path}")
                            elif "0xc0000043" in error_str or "sharing violation" in error_str.lower():
                                logger.warning(f"File sharing violation during read (possibly being modified): {path}")
                                raise IOError(f"File access conflict: {path}")
                            elif "credits" in error_str.lower() and "available" in error_str.lower():
                                logger.error(f"SMB credit exhaustion during read: {path} - {read_error}")
                                raise IOError(f"SMB server out of credits (too many concurrent requests): {path}")
                            else:
                                # Unknown error during read
                                logger.error(f"Error reading chunk from {path}: {read_error}")
                                raise
                finally:
                    try:
                        await self._run_blocking_smb_call(
                            "close_file_after_read",
                            file_handle.close,
                            SMB_FILE_CLOSE_TIMEOUT_SECONDS,
                            smb_path=smb_path,
                        )
                    except Exception as close_error:
                        # Log but don't raise - we're already in cleanup
                        logger.warning(f"Error closing file handle for {path}: {close_error}")

        except Exception as e:
            logger.error(f"Failed to read file {path}: {e}")
            raise

    async def _open_random_access_reader(self, path: str, *, share_access: str, operation_name: str) -> RandomAccessReader:
        """Open one pooled SMB handle for serialized bounded offset reads."""

        smb_path = self._build_smb_path(path)
        pool = await get_connection_pool()
        connection_lease = pool.get_connection(
            host=self.host,
            port=self.port,
            username=self.username,
            password=self.password,
            share_name=self.share_name,
            connection_cache=self._connection_cache,
        )

        await connection_lease.__aenter__()
        try:
            handle = await self._run_blocking_smb_call(
                operation_name,
                lambda: smbclient.open_file(
                    smb_path,
                    mode="rb",
                    buffering=0,
                    share_access=share_access,
                    **self._smb_auth_kwargs(),
                ),
                SMB_FILE_OPEN_TIMEOUT_SECONDS,
                smb_path=smb_path,
            )
        except BaseException:
            await connection_lease.__aexit__(None, None, None)
            raise

        return _SMBRandomAccessReader(
            backend=self,
            smb_path=smb_path,
            handle=handle,
            connection_lease=connection_lease,
        )

    async def open_random_access_reader(self, path: str) -> RandomAccessReader:
        """Open a general-purpose SMB reader that permits concurrent share updates."""

        return await self._open_random_access_reader(
            path,
            share_access="rwd",
            operation_name="open_file_for_random_read",
        )

    async def open_move_source_reader(self, path: str) -> MoveSourceReader:
        """Open an SMB source with delete access retained for post-commit move cleanup."""

        smb_path = self._build_smb_path(path)
        pool = await get_connection_pool()
        connection_lease = pool.get_connection(
            host=self.host,
            port=self.port,
            username=self.username,
            password=self.password,
            share_name=self.share_name,
            connection_cache=self._connection_cache,
        )
        await connection_lease.__aenter__()
        open_future = asyncio.get_running_loop().run_in_executor(
            None,
            lambda: smbclient.open_file(
                smb_path,
                mode="rb",
                buffering=0,
                share_access="r",
                desired_access=(
                    FilePipePrinterAccessMask.FILE_READ_DATA
                    | FilePipePrinterAccessMask.FILE_READ_ATTRIBUTES
                    | FilePipePrinterAccessMask.FILE_READ_EA
                    | FilePipePrinterAccessMask.DELETE
                ),
                **self._smb_auth_kwargs(),
            ),
        )
        try:
            handle = await asyncio.wait_for(asyncio.shield(open_future), SMB_FILE_OPEN_TIMEOUT_SECONDS)
        except BaseException:

            async def dispose_late_open() -> None:
                try:
                    late_handle = await asyncio.shield(open_future)
                    await asyncio.get_running_loop().run_in_executor(None, late_handle.close)
                except Exception:
                    logger.warning("Failed to dispose late SMB move source open: path=%s", path, exc_info=True)
                finally:
                    await connection_lease.__aexit__(None, None, None)

            _retain_move_cleanup(asyncio.create_task(dispose_late_open()))
            raise
        reader = _SMBMoveSourceReader(
            backend=self,
            smb_path=smb_path,
            handle=handle,
            connection_lease=connection_lease,
            source_path=path,
        )
        return reader

    async def open_archive_source_reader(self, path: str) -> RandomAccessReader:
        """Pin an archive source against concurrent SMB writers for its live operation."""

        try:
            return await self._open_random_access_reader(
                path,
                share_access="r",
                operation_name="open_file_for_archive_source_read",
            )
        except Exception as exc:
            logger.warning("Unable to open pinned archive source '%s': %s", path, exc)
            raise ArchiveSourceUnavailableError("Archive source cannot be opened with required sharing") from exc

    async def open_exclusive_writer(self, path: str) -> ExclusiveWriter:
        """Create a final SMB target without replacement and retain its handle."""

        smb_path = self._build_smb_path(path)
        pool = await get_connection_pool()
        connection_lease = pool.get_connection(
            host=self.host,
            port=self.port,
            username=self.username,
            password=self.password,
            share_name=self.share_name,
            connection_cache=self._connection_cache,
        )
        await connection_lease.__aenter__()
        try:
            handle = await self._run_blocking_smb_call(
                "open_file_for_exclusive_write",
                lambda: smbclient.open_file(
                    smb_path,
                    mode="x+b",
                    buffering=0,
                    share_access="rwd",
                    **self._smb_auth_kwargs(),
                ),
                SMB_FILE_OPEN_TIMEOUT_SECONDS,
                smb_path=smb_path,
            )
        except BaseException:
            await connection_lease.__aexit__(None, None, None)
            raise
        return _SMBExclusiveWriter(
            backend=self,
            smb_path=smb_path,
            handle=handle,
            connection_lease=connection_lease,
        )

    #
    # write_file
    #
    async def write_file(self, path: str, data: BinaryIO) -> int:
        """Write a file to the SMB share, overwriting if it exists.

        Reads from *data* in chunks and writes them to the remote path.
        Parent directories must already exist.

        Args:
            path: Relative path within the share.
            data: File-like object to read content from.

        Returns:
            Number of bytes written.

        Raises:
            TimeoutError: If the operation takes longer than 120 seconds.
            OSError: If the SMB write operation fails.
        """

        # Write chunk size — 4 MB matches read_file for consistency
        write_chunk_size: int = 4 * 1024 * 1024
        smb_path = self._build_smb_path(path)
        logger.debug(f"Writing file: path='{path}' -> smb_path='{smb_path}'")

        try:
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):

                def _write() -> int:
                    bytes_written = 0
                    with smbclient.open_file(
                        smb_path,
                        mode="wb",
                        share_access="r",
                        **self._smb_auth_kwargs(),
                    ) as f:
                        while True:
                            chunk = data.read(write_chunk_size)
                            if not chunk:
                                break
                            f.write(chunk)
                            bytes_written += len(chunk)
                    return bytes_written

                bytes_written = await self._run_blocking_smb_call(
                    "write_file",
                    _write,
                    SMB_WRITE_FILE_TIMEOUT_SECONDS,
                    smb_path=smb_path,
                )

                logger.debug(f"Successfully wrote {bytes_written} bytes: path='{path}'")
                return bytes_written

        except TimeoutError:
            logger.error(f"Timeout writing '{path}' after {SMB_WRITE_FILE_TIMEOUT_SECONDS:.0f} seconds")
            raise TimeoutError(f"SMB operation timed out while writing: {path}")
        except OSError as e:
            error_str = str(e)
            if "0xc0000043" in error_str or "being used by another process" in error_str:
                logger.warning(f"File locked during write: path='{path}'")
                raise IOError(f"File is locked and cannot be written: {path}") from e
            logger.error(f"Failed to write '{path}': {type(e).__name__}: {e}", exc_info=True)
            raise
        except Exception as e:
            logger.error(f"Failed to write '{path}': {type(e).__name__}: {e}", exc_info=True)
            raise

    #
    # file_exists
    #
    async def file_exists(self, path: str) -> bool:
        """Check if a file or directory exists"""

        smb_path = self._build_smb_path(path)

        try:
            # Acquire connection from pool
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                exists = await self._run_blocking_smb_call(
                    "file_exists",
                    lambda: smbclient.path.exists(  # pyright: ignore[reportAttributeAccessIssue]
                        smb_path,
                        **self._smb_auth_kwargs(),
                    ),
                    SMB_EXISTS_TIMEOUT_SECONDS,
                    smb_path=smb_path,
                )
                return bool(exists)
        except Exception:
            return False

    #
    # _remove_if_exists
    #
    async def _remove_if_exists(self, smb_path: str) -> bool:
        """Remove *smb_path* (file or directory) if it exists.

        Used internally by copy/move/write operations when the caller
        has requested overwrite semantics. The caller must already hold
        a pool connection.

        Directory removal is depth-first (recursive).
        """

        def _remove(target: str) -> bool:
            if not smbclient.path.exists(target, **self._smb_auth_kwargs()):  # pyright: ignore[reportAttributeAccessIssue]
                return False
            stat_info = smbclient.stat(target, **self._smb_auth_kwargs())
            if stat.S_ISDIR(stat_info.st_mode):
                # Collect all children before recursing so the scandir
                # generator is fully consumed and closed first.
                children = [entry.path for entry in smbclient.scandir(target, **self._smb_auth_kwargs())]
                for child_path in children:
                    _remove(child_path)
                smbclient.rmdir(target, **self._smb_auth_kwargs())
            else:
                smbclient.remove(target, **self._smb_auth_kwargs())
            return True

        return await self._run_blocking_smb_call(
            "remove existing destination",
            lambda: _remove(smb_path),
            SMB_DELETE_TIMEOUT_SECONDS,
            smb_path=smb_path,
        )

    async def _remove_regular_file_if_exists(self, smb_path: str) -> bool:
        """Remove only a regular target file for archive replacement."""

        def _remove(target: str) -> bool:
            if not smbclient.path.exists(target, **self._smb_auth_kwargs()):  # pyright: ignore[reportAttributeAccessIssue]
                return False
            stat_info = smbclient.stat(target, **self._smb_auth_kwargs())
            if not stat.S_ISREG(stat_info.st_mode):
                raise FileExistsError(f"Archive target is not a regular file: {target}")
            smbclient.remove(target, **self._smb_auth_kwargs())
            return True

        return await self._run_blocking_smb_call(
            "remove archive replacement target",
            lambda: _remove(smb_path),
            SMB_DELETE_TIMEOUT_SECONDS,
            smb_path=smb_path,
        )

    #
    # set_file_times
    #
    async def set_file_times(self, path: str, modified: datetime) -> None:
        """Set the modification timestamp of a file or directory.

        Converts the *modified* datetime to nanosecond precision and
        applies it via ``smbclient.utime()``.

        Args:
            path: Relative path within the share.
            modified: The modification timestamp to apply.
        """

        smb_path = self._build_smb_path(path)

        try:
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                # Convert to nanoseconds — smbclient.utime() requires
                # int via the ns= parameter.
                mtime_ns = int(modified.timestamp() * 1_000_000_000)

                await self._run_blocking_smb_operation(
                    "set file times",
                    lambda: smbclient.utime(
                        smb_path,
                        ns=(mtime_ns, mtime_ns),
                        **self._smb_auth_kwargs(),
                    ),
                    10.0,
                    smb_path=smb_path,
                )

        except Exception as e:
            logger.warning(f"Failed to set modification time on '{path}': {type(e).__name__}: {e}")

    #
    # delete_item
    #
    async def delete_item(self, path: str) -> None:
        """Delete a file or directory via SMB.

        Directories are deleted recursively — every file and sub-directory
        is removed depth-first before the directory itself is deleted.

        Args:
            path: Relative path within the share.

        Raises:
            FileNotFoundError: If the path does not exist.
            OSError: If the operation fails.
        """

        smb_path = self._build_smb_path(path)
        logger.debug(f"Deleting item: path='{path}' -> smb_path='{smb_path}'")

        try:
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):

                def _delete_recursive(target: str) -> None:
                    """Depth-first removal of *target* (file or directory).

                    Children are collected into a list before recursing
                    so the scandir generator is fully consumed — this
                    releases the underlying SMB directory handle before
                    we attempt rmdir on the parent.
                    """

                    stat_info = smbclient.stat(target, **self._smb_auth_kwargs())
                    if stat.S_ISDIR(stat_info.st_mode):
                        # Collect all children before recursing so the
                        # scandir generator (and its underlying SMB
                        # directory handle) is fully consumed and closed
                        # before we call rmdir.
                        children = [entry.path for entry in smbclient.scandir(target, **self._smb_auth_kwargs())]
                        for child_path in children:
                            _delete_recursive(child_path)
                        smbclient.rmdir(target, **self._smb_auth_kwargs())
                    else:
                        smbclient.remove(target, **self._smb_auth_kwargs())

                await self._run_blocking_smb_call(
                    "delete",
                    lambda: _delete_recursive(smb_path),
                    SMB_DELETE_TIMEOUT_SECONDS,
                    smb_path=smb_path,
                )

                logger.debug(f"Successfully deleted: path='{path}'")

        except TimeoutError as error:
            logger.error(f"Timeout deleting '{path}' after {SMB_DELETE_TIMEOUT_SECONDS:.0f} seconds")
            raise TimeoutError(f"SMB operation timed out while deleting: {path}") from error
        except OSError as e:
            error_str = str(e)
            # 0xc0000034 = STATUS_OBJECT_NAME_NOT_FOUND
            if "0xc0000034" in error_str or "No such file" in error_str:
                raise FileNotFoundError(f"Path not found: {path}") from e
            # 0xc0000056 = STATUS_DELETE_PENDING — item is already being
            # deleted by the server.  Treat as success.
            if "0xc0000056" in error_str:
                logger.info(f"Item already being deleted (STATUS_DELETE_PENDING): path='{path}'")
                return
            logger.error(
                f"Failed to delete '{path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise
        except Exception as e:
            error_str = str(e)
            if "0xc0000056" in error_str or "DeletePending" in type(e).__name__:
                logger.info(f"Item already being deleted (STATUS_DELETE_PENDING): path='{path}'")
                return
            logger.error(
                f"Failed to delete '{path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise

    async def remove_empty_directory(self, path: str) -> None:
        """Remove one empty directory without recursively deleting its contents."""

        smb_path = self._build_smb_path(path)
        try:
            pool = await get_connection_pool()
            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                await self._run_blocking_smb_call(
                    "remove empty directory",
                    lambda: smbclient.rmdir(smb_path, **self._smb_auth_kwargs()),
                    SMB_DELETE_TIMEOUT_SECONDS,
                    smb_path=smb_path,
                )
        except OSError as error:
            error_text = str(error)
            if "0xc0000034" in error_text or "No such file" in error_text:
                raise FileNotFoundError(f"Path not found: {path}") from error
            raise
        except Exception as e:
            error_str = str(e)
            # smbprotocol may raise non-OSError exceptions that still
            # carry the NTSTATUS code in their message.
            if "0xc0000056" in error_str or "DeletePending" in type(e).__name__:
                logger.info(f"Item already being deleted (STATUS_DELETE_PENDING): path='{path}'")
                return
            logger.error(
                f"Failed to delete '{path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise

    #
    # rename_item
    #
    async def rename_item(self, path: str, new_name: str) -> None:
        """Rename a file or directory via SMB.

        The item stays in its current parent directory — only the final
        path component is changed.

        Args:
            path: Relative path within the share.
            new_name: New name for the item (filename only).

        Raises:
            FileNotFoundError: If the source path does not exist.
            FileExistsError: If an item with *new_name* already exists
                in the same directory.
            OSError: If the operation fails.
        """

        normalized_name = self._normalize_relative_path(new_name)
        if not normalized_name or "/" in normalized_name:
            raise ValueError("New SMB item names must be a single path segment")
        smb_src = self._build_smb_path(path)

        # Derive destination: same parent directory, different leaf name.
        parent = smb_src.rsplit("\\", 1)[0]
        smb_dst = f"{parent}\\{normalized_name}"

        logger.debug(f"Renaming item: path='{path}' -> new_name='{new_name}' (smb: '{smb_src}' -> '{smb_dst}')")

        try:
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                await self._run_blocking_smb_operation(
                    "rename",
                    lambda: smbclient.rename(smb_src, smb_dst, **self._smb_auth_kwargs()),
                    30.0,
                    smb_path=smb_src,
                )

                logger.debug(f"Successfully renamed: '{path}' -> '{new_name}'")

        except asyncio.TimeoutError:
            logger.error(f"Timeout renaming '{path}' after 30 seconds")
            raise TimeoutError(f"SMB operation timed out while renaming: {path}")
        except OSError as e:
            error_str = str(e)
            # 0xc0000034 = STATUS_OBJECT_NAME_NOT_FOUND
            if "0xc0000034" in error_str or "No such file" in error_str:
                raise FileNotFoundError(f"Path not found: {path}") from e
            # 0xc0000035 = STATUS_OBJECT_NAME_COLLISION (target already exists)
            if "0xc0000035" in error_str:
                raise FileExistsError(f"An item named '{new_name}' already exists") from e
            logger.error(
                f"Failed to rename '{path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise
        except Exception as e:
            logger.error(
                f"Failed to rename '{path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise

    #
    # create_directory
    #
    async def create_directory(self, path: str) -> None:
        """Create a new directory via SMB.

        Args:
            path: Relative path for the new directory.

        Raises:
            FileExistsError: If an item with this name already exists.
            FileNotFoundError: If the parent directory does not exist.
            OSError: If the operation fails.
        """

        smb_path = self._build_smb_path(path)
        logger.debug(f"Creating directory: path='{path}' -> smb_path='{smb_path}'")

        try:
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                await self._run_blocking_smb_operation(
                    "create directory",
                    lambda: smbclient.mkdir(smb_path, **self._smb_auth_kwargs()),
                    30.0,
                    smb_path=smb_path,
                )

                logger.debug(f"Successfully created directory: '{path}'")

        except asyncio.TimeoutError:
            logger.error(f"Timeout creating directory '{path}' after 30 seconds")
            raise TimeoutError(f"SMB operation timed out while creating directory: {path}")
        except OSError as e:
            error_str = str(e)
            # 0xc0000035 = STATUS_OBJECT_NAME_COLLISION (already exists)
            if "0xc0000035" in error_str:
                raise FileExistsError(f"An item named '{path.rsplit('/', 1)[-1]}' already exists") from e
            # 0xc0000034 = STATUS_OBJECT_NAME_NOT_FOUND (parent missing)
            if "0xc0000034" in error_str or "No such file" in error_str:
                raise FileNotFoundError(f"Parent directory not found for: {path}") from e
            logger.error(
                f"Failed to create directory '{path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise
        except Exception as e:
            logger.error(
                f"Failed to create directory '{path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise

    #
    # create_file
    #
    async def create_file(self, path: str) -> None:
        """Create a new empty file via SMB.

        Uses exclusive-create mode ('x') to fail if the file already exists.

        Args:
            path: Relative path for the new file.

        Raises:
            FileExistsError: If an item with this name already exists.
            FileNotFoundError: If the parent directory does not exist.
            OSError: If the operation fails.
        """

        smb_path = self._build_smb_path(path)
        logger.debug(f"Creating file: path='{path}' -> smb_path='{smb_path}'")

        try:
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):

                def _create_empty_file() -> None:
                    with smbclient.open_file(smb_path, mode="xb", **self._smb_auth_kwargs()):
                        pass  # Create empty file and close immediately

                await self._run_blocking_smb_operation(
                    "create file",
                    _create_empty_file,
                    30.0,
                    smb_path=smb_path,
                )

                logger.debug(f"Successfully created file: '{path}'")

        except asyncio.TimeoutError:
            logger.error(f"Timeout creating file '{path}' after 30 seconds")
            raise TimeoutError(f"SMB operation timed out while creating file: {path}")
        except OSError as e:
            error_str = str(e)
            # 0xc0000035 = STATUS_OBJECT_NAME_COLLISION (already exists)
            if "0xc0000035" in error_str:
                raise FileExistsError(f"An item named '{path.rsplit('/', 1)[-1]}' already exists") from e
            # 0xc0000034 = STATUS_OBJECT_NAME_NOT_FOUND (parent missing)
            if "0xc0000034" in error_str or "No such file" in error_str:
                raise FileNotFoundError(f"Parent directory not found for: {path}") from e
            logger.error(
                f"Failed to create file '{path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise
        except Exception as e:
            logger.error(
                f"Failed to create file '{path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise

    #
    # get_file_size
    #
    async def get_file_size(self, path: str) -> int | None:
        """Return the file size in bytes, or ``None`` for directories."""

        smb_path = self._build_smb_path(path)

        try:
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                stat_result = await self._run_blocking_smb_operation(
                    "get file size",
                    lambda: smbclient.stat(smb_path, **self._smb_auth_kwargs()),
                    10.0,
                    smb_path=smb_path,
                )
                if stat.S_ISDIR(stat_result.st_mode):
                    return None
                return stat_result.st_size  # type: ignore  # smbclient untyped
        except Exception as e:
            error_str = str(e)
            if "0xc0000034" in error_str or "No such file" in error_str:
                raise FileNotFoundError(f"Path not found: {path}") from e
            logger.error(f"Failed to get file size for '{path}': {e}")
            raise

    #
    # copy_item
    #
    async def copy_item(self, source_path: str, dest_path: str, *, overwrite: bool = False) -> None:
        """Copy a file or directory to a new location via SMB.

        Files are copied using ``smbclient.copyfile`` which performs a
        server-side copy (``FSCTL_SRV_COPYCHUNK``).  Directories are
        copied recursively — structure is replicated depth-first.

        Args:
            source_path: Relative path of the item to copy.
            dest_path: Relative destination path (full path including name).
            overwrite: Replace an existing regular destination through an
                atomic SMB rename.

        Raises:
            FileNotFoundError: If the source path does not exist.
            FileExistsError: If the destination path already exists
                and *overwrite* is ``False``.
            OSError: If the operation fails.
        """

        smb_src = self._build_smb_path(source_path)
        smb_dst = self._build_smb_path(dest_path)
        logger.debug(f"Copying item: '{source_path}' -> '{dest_path}' (smb: '{smb_src}' -> '{smb_dst}')")

        try:
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                exists = await self._run_blocking_smb_operation(
                    "check copy destination",
                    lambda: smbclient.path.exists(  # pyright: ignore[reportAttributeAccessIssue]
                        smb_dst,
                        **self._smb_auth_kwargs(),
                    ),
                    10.0,
                    smb_path=smb_dst,
                )
                if exists:
                    raise FileExistsError(f"Destination already exists: {dest_path}")

                def _copy_recursive(src: str, dst: str) -> None:
                    """Copy *src* to *dst*, creating directories as needed.

                    Preserves the original modification time on both files
                    and directories.
                    """

                    stat_info = smbclient.stat(src, **self._smb_auth_kwargs())
                    # Convert float seconds to integer nanoseconds —
                    # smbclient.utime() requires int via the ns= parameter.
                    atime_ns = int(stat_info.st_atime * 1_000_000_000)
                    mtime_ns = int(stat_info.st_mtime * 1_000_000_000)

                    if stat.S_ISDIR(stat_info.st_mode):
                        smbclient.mkdir(dst, **self._smb_auth_kwargs())
                        # Collect children before recursing so the scandir
                        # generator is fully consumed before deeper calls.
                        children = [(entry.name, entry.path) for entry in smbclient.scandir(src, **self._smb_auth_kwargs())]
                        for child_name, child_path in children:
                            _copy_recursive(child_path, f"{dst}\\{child_name}")
                        # Restore directory timestamps after all children are
                        # copied (adding children updates the directory mtime).
                        smbclient.utime(dst, ns=(atime_ns, mtime_ns), **self._smb_auth_kwargs())
                    else:
                        smbclient.copyfile(src, dst, **self._smb_auth_kwargs())
                        smbclient.utime(dst, ns=(atime_ns, mtime_ns), **self._smb_auth_kwargs())

                await self._run_blocking_smb_operation(
                    "copy",
                    lambda: _copy_recursive(smb_src, smb_dst),
                    300.0,  # Large copies may take time
                    smb_path=smb_src,
                )

                logger.debug(f"Successfully copied: '{source_path}' -> '{dest_path}'")

        except asyncio.TimeoutError:
            logger.error(f"Timeout copying '{source_path}' after 300 seconds")
            raise TimeoutError(f"SMB operation timed out while copying: {source_path}")
        except OSError as e:
            error_str = str(e)
            # 0xc0000034 = STATUS_OBJECT_NAME_NOT_FOUND
            if "0xc0000034" in error_str or "No such file" in error_str:
                raise FileNotFoundError(f"Source not found: {source_path}") from e
            # 0xc0000035 = STATUS_OBJECT_NAME_COLLISION (destination already exists)
            if "0xc0000035" in error_str:
                raise FileExistsError(f"Destination already exists: {dest_path}") from e
            logger.error(
                f"Failed to copy '{source_path}' -> '{dest_path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise
        except Exception as e:
            logger.error(
                f"Failed to copy '{source_path}' -> '{dest_path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise

    #
    # move_item
    #
    async def move_item(self, source_path: str, dest_path: str, *, overwrite: bool = False) -> None:
        """Move a file or directory to a new location via SMB.

        Uses ``smbclient.rename`` which performs a server-side rename
        (instant, no data copy) — this works across directories within
        the same share.

        Args:
            source_path: Relative path of the item to move.
            dest_path: Relative destination path (full path including name).
            overwrite: Replace an existing regular destination atomically.

        Raises:
            FileNotFoundError: If the source path does not exist.
            FileExistsError: If the destination path already exists
                and *overwrite* is ``False``.
            OSError: If the operation fails.
        """

        smb_src = self._build_smb_path(source_path)
        smb_dst = self._build_smb_path(dest_path)
        logger.debug(f"Moving item: '{source_path}' -> '{dest_path}' (smb: '{smb_src}' -> '{smb_dst}')")

        try:
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                exists = await self._run_blocking_smb_operation(
                    "check move destination",
                    lambda: smbclient.path.exists(  # pyright: ignore[reportAttributeAccessIssue]
                        smb_dst,
                        **self._smb_auth_kwargs(),
                    ),
                    10.0,
                    smb_path=smb_dst,
                )
                if exists and not overwrite:
                    raise FileExistsError(f"Destination already exists: {dest_path}")

                await self._run_blocking_smb_operation(
                    "replace move destination" if overwrite else "move",
                    lambda: (
                        smbclient.replace(smb_src, smb_dst, **self._smb_auth_kwargs())
                        if overwrite
                        else smbclient.rename(smb_src, smb_dst, **self._smb_auth_kwargs())
                    ),
                    30.0,
                    smb_path=smb_src,
                )

                logger.debug(f"Successfully moved: '{source_path}' -> '{dest_path}'")

        except asyncio.TimeoutError:
            logger.error(f"Timeout moving '{source_path}' after 30 seconds")
            raise TimeoutError(f"SMB operation timed out while moving: {source_path}")
        except OSError as e:
            error_str = str(e)
            # 0xc0000034 = STATUS_OBJECT_NAME_NOT_FOUND
            if "0xc0000034" in error_str or "No such file" in error_str:
                raise FileNotFoundError(f"Source not found: {source_path}") from e
            # 0xc0000035 = STATUS_OBJECT_NAME_COLLISION (destination already exists)
            if "0xc0000035" in error_str:
                raise FileExistsError(f"Destination already exists: {dest_path}") from e
            logger.error(
                f"Failed to move '{source_path}' -> '{dest_path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise
        except Exception as e:
            logger.error(
                f"Failed to move '{source_path}' -> '{dest_path}': {type(e).__name__}: {e}",
                exc_info=True,
            )
            raise

    #
    # write_file_from_stream
    #
    async def write_file_from_stream(
        self,
        path: str,
        stream: AsyncIterator[bytes],
        on_progress: ProgressCallback | None = None,
        *,
        overwrite: bool = False,
        source_mtime: datetime | None = None,
    ) -> int:
        """Write a file from an async byte stream (for cross-connection transfers).

        Opens the destination file and writes chunks as they arrive from
        the async iterator.  Each individual chunk write is guarded by a
        per-chunk timeout (60 s) instead of a total timeout, so
        arbitrarily large files can be transferred without hitting a
        wall-clock limit.

        Args:
            path: Relative path within the share (parent must exist).
            stream: Async iterator yielding file content in chunks.
            on_progress: Optional callback invoked after each chunk with
                ``(bytes_written_so_far, None)``.
            overwrite: When ``True``, overwrite the destination if it
                already exists.  When ``False`` (default), raise
                ``FileExistsError``.
            source_mtime: When provided, set the destination file's
                modification time to this value after writing \u2014 inside
                the same connection context (no extra round-trip).

        Returns:
            Total number of bytes written.
        """

        # Per-chunk timeout — generous to handle slow network segments
        # without capping total transfer time.
        chunk_write_timeout_s: float = 60.0

        smb_path = self._build_smb_path(path)
        logger.debug(f"write_file_from_stream: path='{path}' -> smb_path='{smb_path}'")

        bytes_written = 0
        replaced = False
        target_may_have_changed = False
        try:
            pool = await get_connection_pool()

            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                if overwrite:
                    # When overwrite is requested, remove the existing
                    # regular file before exclusively recreating it below.
                    replaced = await self._remove_regular_file_if_exists(smb_path)
                    target_may_have_changed = replaced

                # Exclusive creation closes the check/open race. A target that
                # appears after replacement removal is reported before any
                # input chunk is consumed.
                file_handle = await self._run_blocking_smb_operation(
                    "open write handle",
                    lambda: smbclient.open_file(
                        smb_path,
                        mode="x+b",
                        share_access="r",
                        **self._smb_auth_kwargs(),
                    ),
                    15.0,
                    smb_path=smb_path,
                )
                target_may_have_changed = True

                try:
                    async for chunk in stream:
                        offset = 0
                        while offset < len(chunk):
                            remaining = chunk[offset:]
                            accepted = await self._run_blocking_smb_operation(
                                "write chunk",
                                lambda: file_handle.write(remaining),
                                chunk_write_timeout_s,
                                smb_path=smb_path,
                            )
                            if not isinstance(accepted, int) or not 0 < accepted <= len(remaining):
                                raise OSError(f"SMB write returned an invalid byte count for '{path}'")
                            offset += accepted
                            bytes_written += accepted
                            if on_progress:
                                on_progress(bytes_written, None)
                finally:
                    await self._run_blocking_smb_operation(
                        "close write handle",
                        file_handle.close,
                        5.0,
                        smb_path=smb_path,
                    )

                # Preserve the original modification timestamp inside
                # the same connection context (no extra pool checkout).
                if source_mtime is not None:
                    mtime_ns = int(source_mtime.timestamp() * 1_000_000_000)
                    await self._run_blocking_smb_operation(
                        "preserve modification time",
                        lambda: smbclient.utime(
                            smb_path,
                            ns=(mtime_ns, mtime_ns),
                            **self._smb_auth_kwargs(),
                        ),
                        10.0,
                        smb_path=smb_path,
                    )

                logger.debug(f"write_file_from_stream: wrote {bytes_written} bytes to '{path}'")
                return TargetWriteResult(bytes_written, replaced=replaced)

        except asyncio.TimeoutError as exc:
            logger.error(f"Timeout during write_file_from_stream for '{path}'")
            timeout_error = TimeoutError(f"SMB operation timed out while writing: {path}")
            if target_may_have_changed:
                raise TargetWriteFailure(timeout_error, bytes_written) from exc
            raise timeout_error from exc
        except OSError as e:
            error_str = str(e)
            if target_may_have_changed:
                raise TargetWriteFailure(e, bytes_written) from e
            if isinstance(e, FileExistsError) or "0xc0000035" in error_str:
                raise TargetExistsBeforeContent(f"Destination already exists: {path}") from e
            if "0xc0000043" in error_str or "being used by another process" in error_str:
                raise IOError(f"File is locked and cannot be written: {path}") from e
            logger.error(f"Failed write_file_from_stream '{path}': {type(e).__name__}: {e}", exc_info=True)
            raise
        except Exception as e:
            if target_may_have_changed:
                raise TargetWriteFailure(e, bytes_written) from e
            logger.error(f"Failed write_file_from_stream '{path}': {type(e).__name__}: {e}", exc_info=True)
            raise

    async def stage_and_commit_new_file_from_stream(
        self,
        path: str,
        stream: AsyncIterator[bytes],
        *,
        before_commit: Callable[[], Awaitable[bool | None]],
        on_progress: ProgressCallback | None = None,
        source_mtime: datetime | None = None,
        overwrite: bool = False,
    ) -> int:
        """Publish a streamed file through a private sibling stage.

        Writing a unique stage leaves the visible destination unchanged if
        reading, writing, source validation, flushing, or final publication
        fails. Existing regular targets are atomically replaced only after
        the complete stage has been closed and validated.
        """

        target_path = self._normalize_relative_path(path)
        target_parts = PurePosixPath(target_path)
        stage_name = f".{target_parts.name}.sambee-stage-{uuid.uuid4().hex}"
        stage_path = str(target_parts.with_name(stage_name))
        smb_path = self._build_smb_path(target_path)
        smb_stage_path = self._build_smb_path(stage_path)
        bytes_written = 0
        committed = False
        started_at = monotonic()
        write_calls = 0
        write_seconds = 0.0

        async def remove_stage() -> None:
            if committed:
                return
            try:
                await self._run_blocking_smb_operation(
                    "discard transfer stage",
                    lambda: smbclient.remove(smb_stage_path, **self._smb_auth_kwargs()),
                    SMB_DELETE_TIMEOUT_SECONDS,
                    smb_path=smb_stage_path,
                )
            except Exception as cleanup_error:
                logger.warning(
                    "Failed to discard SMB transfer stage '%s': %s",
                    stage_path,
                    cleanup_error,
                )

        try:
            pool = await get_connection_pool()
            async with pool.get_connection(
                host=self.host,
                port=self.port,
                username=self.username,
                password=self.password,
                share_name=self.share_name,
                connection_cache=self._connection_cache,
            ):
                file_handle = await self._run_blocking_smb_operation(
                    "open transfer stage",
                    lambda: smbclient.open_file(
                        smb_stage_path,
                        mode="x+b",
                        share_access="r",
                        **self._smb_auth_kwargs(),
                    ),
                    SMB_FILE_OPEN_TIMEOUT_SECONDS,
                    smb_path=smb_stage_path,
                )
                try:
                    async for chunk in stream:
                        offset = 0
                        while offset < len(chunk):
                            remaining = chunk[offset:]
                            write_started_at = monotonic()
                            write_calls += 1
                            try:
                                accepted = await self._run_blocking_smb_operation(
                                    "write transfer stage chunk",
                                    lambda: file_handle.write(remaining),
                                    SMB_WRITE_FILE_TIMEOUT_SECONDS,
                                    smb_path=smb_stage_path,
                                )
                            finally:
                                write_seconds += monotonic() - write_started_at
                            if not isinstance(accepted, int) or not 0 < accepted <= len(remaining):
                                raise OSError(f"SMB write returned an invalid byte count for transfer stage '{path}'")
                            offset += accepted
                            bytes_written += accepted
                            if on_progress:
                                on_progress(bytes_written, None)
                finally:
                    await self._run_blocking_smb_operation(
                        "close transfer stage",
                        file_handle.close,
                        SMB_FILE_CLOSE_TIMEOUT_SECONDS,
                        smb_path=smb_stage_path,
                    )

                if source_mtime is not None:
                    mtime_ns = int(source_mtime.timestamp() * 1_000_000_000)
                    await self._run_blocking_smb_operation(
                        "preserve transfer stage modification time",
                        lambda: smbclient.utime(
                            smb_stage_path,
                            ns=(mtime_ns, mtime_ns),
                            **self._smb_auth_kwargs(),
                        ),
                        SMB_FILE_INFO_TIMEOUT_SECONDS,
                        smb_path=smb_stage_path,
                    )

                final_overwrite = await before_commit()
                commit_with_replacement = overwrite if final_overwrite is None else final_overwrite
                commit_stage = smbclient.replace if commit_with_replacement else smbclient.rename
                await self._run_blocking_smb_operation(
                    "replace transfer destination" if commit_with_replacement else "commit transfer stage",
                    lambda: commit_stage(smb_stage_path, smb_path, **self._smb_auth_kwargs()),
                    SMB_FILE_OPEN_TIMEOUT_SECONDS,
                    smb_path=smb_path,
                )
                committed = True
                logger.debug("Committed staged SMB transfer: '%s'", path)
                return bytes_written
        except OSError as error:
            error_text = str(error)
            if isinstance(error, FileExistsError) or "0xc0000035" in error_text:
                raise FileExistsError(f"Destination already exists: {path}") from error
            raise
        finally:
            await remove_stage()
            logger.info(
                "SMB transfer staging: bytes=%s, write_calls=%s, smb_write_ms=%.0f, total_ms=%.0f, committed=%s",
                bytes_written,
                write_calls,
                write_seconds * 1000,
                (monotonic() - started_at) * 1000,
                committed,
            )
