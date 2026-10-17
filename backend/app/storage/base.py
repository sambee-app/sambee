from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Awaitable, BinaryIO, Callable, Optional, Protocol

from app.models.file import DirectoryListing, FileInfo

# Type alias for progress callbacks.
# Called with (bytes_transferred, total_bytes_or_none) after each chunk.
ProgressCallback = Callable[[int, Optional[int]], None]


class RandomAccessReader(Protocol):
    """Operation-scoped reader for bounded random-access archive reads."""

    async def read_at(self, offset: int, length: int) -> bytes:
        """Read up to *length* bytes at *offset*, returning short data only at EOF."""

    async def close(self) -> None:
        """Release the underlying provider handle and associated resources."""


class MoveSourceReader(RandomAccessReader, Protocol):
    """A retained source handle that can delete only the object it opened."""

    async def get_file_info(self) -> FileInfo:
        """Observe identity and metadata through the protected handle, not its pathname."""

    async def commit_delete(self, *, cancellation: Callable[[], bool] | None = None) -> None:
        """Delete the retained source, checking cancellation on the event loop before dispatch."""


class ExclusiveWriter(Protocol):
    """Operation-scoped writer that owns a newly created final target."""

    async def write(self, data: bytes) -> int:
        """Append one bounded chunk to the target."""

    async def close(self) -> None:
        """Flush and release the writer without deleting its target."""

    async def abort_and_delete_if_owned(self) -> bool:
        """Attempt cleanup while this writer's active handle still owns the target."""


class StorageBackend(ABC):
    """Abstract base class for storage backends"""

    #
    # connect
    #
    @abstractmethod
    async def connect(self) -> None:
        """Establish connection to the storage backend"""

        pass

    #
    # disconnect
    #
    @abstractmethod
    async def disconnect(self) -> None:
        """Close connection to the storage backend"""

        pass

    #
    # list_directory
    #
    @abstractmethod
    async def list_directory(self, path: str) -> DirectoryListing:
        """List contents of a directory"""

        pass

    #
    # get_file_info
    #
    @abstractmethod
    async def get_file_info(self, path: str) -> FileInfo:
        """Get information about a specific file or directory"""

        pass

    #
    # read_file
    #
    @abstractmethod
    def read_file(self, path: str) -> AsyncIterator[bytes]:
        """Read file contents as chunks"""

        pass

    @abstractmethod
    async def open_random_access_reader(self, path: str) -> RandomAccessReader:
        """Open an operation-scoped reader for bounded offset reads."""

        pass

    async def open_move_source_reader(self, path: str) -> MoveSourceReader:
        """Open a source handle that supports identity-bound move deletion."""

        raise NotImplementedError("This storage backend cannot safely delete a retained move source")

    @abstractmethod
    async def open_exclusive_writer(self, path: str) -> ExclusiveWriter:
        """Create a final target exclusively and return its streaming writer."""

        pass

    #
    # write_file
    #
    @abstractmethod
    async def write_file(self, path: str, data: BinaryIO) -> int:
        """Write a file to storage, overwriting if it exists.

        Args:
            path: Relative path within the share.
            data: File-like object to read content from.

        Returns:
            Number of bytes written.
        """

        pass

    #
    # file_exists
    #
    @abstractmethod
    async def file_exists(self, path: str) -> bool:
        """Check if a file or directory exists"""

        pass

    #
    # delete_item
    #
    @abstractmethod
    async def delete_item(self, path: str) -> None:
        """Delete a file or directory.

        Directories are deleted recursively — all contents are removed first.

        Args:
            path: Relative path to the file or directory.

        Raises:
            FileNotFoundError: If the path does not exist.
            OSError: If the operation fails.
        """

        pass

    #
    # rename_item
    #
    @abstractmethod
    async def rename_item(self, path: str, new_name: str) -> None:
        """Rename a file or directory in place (same parent directory).

        Args:
            path: Relative path to the file or directory.
            new_name: New name for the item (filename only, no path separators).

        Raises:
            FileNotFoundError: If the path does not exist.
            FileExistsError: If an item with the new name already exists.
            OSError: If the operation fails.
        """

        pass

    #
    # create_directory
    #
    @abstractmethod
    async def create_directory(self, path: str) -> None:
        """Create a new directory.

        Args:
            path: Relative path for the new directory.

        Raises:
            FileExistsError: If an item with this name already exists.
            FileNotFoundError: If the parent directory does not exist.
            OSError: If the operation fails.
        """

        pass

    #
    # create_file
    #
    @abstractmethod
    async def create_file(self, path: str) -> None:
        """Create a new empty file.

        Args:
            path: Relative path for the new file.

        Raises:
            FileExistsError: If an item with this name already exists.
            FileNotFoundError: If the parent directory does not exist.
            OSError: If the operation fails.
        """

        pass

    #
    # get_file_size
    #
    @abstractmethod
    async def get_file_size(self, path: str) -> int | None:
        """Return the size in bytes of a file, or ``None`` if unknown.

        Used by cross-connection transfers to report total progress.

        Args:
            path: Relative path within the share.

        Raises:
            FileNotFoundError: If the path does not exist.
        """

        pass

    #
    # copy_item
    #
    @abstractmethod
    async def copy_item(self, source_path: str, dest_path: str, *, overwrite: bool = False) -> None:
        """Copy a file or directory to a new location within the same share.

        Directories are copied recursively — all contents are replicated
        at the destination.

        Args:
            source_path: Relative path of the item to copy.
            dest_path: Relative path for the copy destination (full path
                including the final name, not just the parent directory).
            overwrite: When ``True``, remove the destination before
                copying.  When ``False`` (default), raise
                ``FileExistsError`` if the destination exists.

        Raises:
            FileNotFoundError: If the source path does not exist.
            FileExistsError: If the destination path already exists
                and *overwrite* is ``False``.
            OSError: If the operation fails.
        """

        pass

    #
    # move_item
    #
    @abstractmethod
    async def move_item(self, source_path: str, dest_path: str, *, overwrite: bool = False) -> None:
        """Move (rename) a file or directory to a new location within the same share.

        This is effectively a cross-directory rename. For SMB backends
        this is typically a server-side operation (instant, no data copy).

        Args:
            source_path: Relative path of the item to move.
            dest_path: Relative path for the move destination (full path
                including the final name, not just the parent directory).
            overwrite: When ``True``, remove the destination before
                moving.  When ``False`` (default), raise
                ``FileExistsError`` if the destination exists.

        Raises:
            FileNotFoundError: If the source path does not exist.
            FileExistsError: If the destination path already exists
                and *overwrite* is ``False``.
            OSError: If the operation fails.
        """

        pass

    #
    # write_file_from_stream
    #
    @abstractmethod
    async def write_file_from_stream(
        self,
        path: str,
        stream: AsyncIterator[bytes],
        on_progress: ProgressCallback | None = None,
        *,
        overwrite: bool = False,
        source_mtime: datetime | None = None,
    ) -> int:
        """Write a file by consuming an async byte stream.

        Designed for cross-connection transfers: the caller reads chunks
        from a source backend via ``read_file()`` and pipes them here.
        No overall timeout is applied — instead, each chunk write has
        its own per-operation timeout so arbitrarily large files can be
        transferred without hitting a wall-clock limit.

        When *source_mtime* is provided, the destination file's
        modification timestamp is set to match the source after all
        data has been written — inside the same connection context,
        avoiding an extra round-trip.

        Args:
            path: Relative path within the share (parent must exist).
            stream: Async iterator yielding file content chunks.
            on_progress: Optional callback invoked after each chunk is
                written.  Receives ``(bytes_written_so_far, None)``.
            overwrite: When ``True``, overwrite the destination if it
                already exists.  When ``False`` (default), raise
                ``FileExistsError``.
            source_mtime: When provided, set the destination file's
                modification time to this value after writing.

        Returns:
            Total number of bytes written.

        Raises:
            FileExistsError: If the destination already exists and
                *overwrite* is ``False``. Archive destinations use the
                ``TargetExistsBeforeContent`` subtype only when no input chunk
                has been accepted.
            OSError: If the write operation fails.
        """

        pass

    @abstractmethod
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
        """Stage one stream and atomically publish it to a target.

        Implementations must own and clean up the private stage on every
        failure. When *overwrite* is ``False``, a target appearance during
        final publication raises ``FileExistsError`` without modifying it.
        When it is ``True``, implementations replace an existing regular
        target through their guarded promotion primitive.
        """

        pass

    async def set_file_times(self, path: str, modified: datetime) -> None:
        """Set the modification timestamp of a file or directory.

        The default implementation is a no-op.  Subclasses that support
        timestamp manipulation (e.g. SMB) should override this method.

        Args:
            path: Relative path within the share.
            modified: The modification timestamp to apply.
        """
