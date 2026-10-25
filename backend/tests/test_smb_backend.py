"""
Comprehensive tests for SMB storage backend.

Tests cover:
- Path construction and normalization
- Connection management and session handling
- Directory listing with various scenarios
- File info retrieval
- File reading and streaming
- File existence checks
- Error handling and edge cases
"""

import asyncio
import io
import os
import stat as stat_module
import uuid
import zipfile
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime
from threading import Event, get_ident
from unittest.mock import ANY, AsyncMock, MagicMock, call, patch

import pytest
import smbclient
from smbclient._os import FileAttributes
from smbprotocol.exceptions import AccessDenied
from smbprotocol.file_info import FileDispositionInformation, InfoType
from smbprotocol.open import FileInformationClass, FilePipePrinterAccessMask, SMB2SetInfoResponse
from smbprotocol.structure import DateTimeField

from app.models.file import DirectoryListing, FileInfo, FileType
from app.services.archive.extraction import extract_archive_to_new_paths
from app.services.archive.target_write import TargetWriteFailure
from app.services.content_transfer import SourceDeleteError, SourceDeletionOutcomeUnknown
from app.services.cross_connection import cross_connection_move
from app.storage.smb import SMB_FILETIME_TICKS_PER_SECOND, SMBBackend

_LIVE_SMB_ENVIRONMENT_VARIABLES = ("TEST_SMB_HOST", "TEST_SMB_SHARE", "TEST_SMB_USERNAME", "TEST_SMB_PASSWORD")
_LIVE_SMB_ENABLED = all(os.environ.get(name) for name in _LIVE_SMB_ENVIRONMENT_VARIABLES)


@pytest.mark.asyncio
async def test_write_access_probe_does_not_truncate_or_write() -> None:
    backend = SMBBackend(host="server", share_name="share", username="user", password="pass")
    with patch("app.storage.smb.smbclient.open_file") as open_file:
        await backend.check_write_access("docs/readme.txt")
    assert open_file.call_args.kwargs["mode"] == "r+b"
    assert open_file.call_args.kwargs["share_access"] == "rwd"
    open_file.return_value.__enter__.return_value.write.assert_not_called()


SMB_AUTH_KWARGS = {
    "username": "user",
    "password": "pass",
    "port": 445,
    "connection_cache": ANY,
    "encrypt": False,
    "connection_timeout": 30,
    "auth_protocol": "negotiate",
    "require_signing": True,
}


@pytest.fixture(autouse=True)
def mock_smb_pool(request: pytest.FixtureRequest):
    """Mock the SMB connection pool for all tests."""

    if request.node.get_closest_marker("integration") is not None:
        yield None
        return

    @asynccontextmanager
    async def mock_get_connection(host, port, username, password, share_name, connection_cache=None):
        # Just yield without actually connecting
        yield None

    with patch("app.storage.smb.get_connection_pool") as mock_pool:
        mock_pool_instance = MagicMock()
        mock_pool_instance.get_connection = mock_get_connection
        mock_pool_instance.retain_connection_until_future_complete = AsyncMock()
        mock_pool.return_value = mock_pool_instance
        yield mock_pool


class _MemoryArchiveReader:
    def __init__(self, data: bytes) -> None:
        self._data = data

    async def read_at(self, offset: int, length: int) -> bytes:
        return self._data[offset : offset + length]

    async def close(self) -> None:
        return None


class _MemoryArchiveSource:
    def __init__(self, data: bytes) -> None:
        self._data = data

    async def get_file_info(self, path: str) -> FileInfo:
        if path != "source.zip":
            raise FileNotFoundError(path)
        return FileInfo(name=path, path=path, type=FileType.FILE, size=len(self._data))

    async def open_random_access_reader(self, path: str) -> _MemoryArchiveReader:
        if path != "source.zip":
            raise FileNotFoundError(path)
        return _MemoryArchiveReader(self._data)


class _CountingExtractionDestination:
    def __init__(self, backend: SMBBackend) -> None:
        self._backend = backend
        self.file_info_paths: list[str] = []
        self.listed_paths: list[str] = []

    async def get_file_info(self, path: str) -> FileInfo:
        self.file_info_paths.append(path)
        return await self._backend.get_file_info(path)

    async def list_directory(self, path: str = "") -> DirectoryListing:
        self.listed_paths.append(path)
        return await self._backend.list_directory(path)

    async def create_directory(self, path: str) -> None:
        await self._backend.create_directory(path)

    async def write_file_from_stream(
        self,
        path: str,
        stream: AsyncIterator[bytes],
        *,
        overwrite: bool = False,
        source_mtime: object | None = None,
    ) -> int:
        return await self._backend.write_file_from_stream(
            path,
            stream,
            overwrite=overwrite,
            source_mtime=source_mtime,
        )


@pytest.mark.asyncio
async def test_disconnect_closes_an_ephemeral_connection_cache() -> None:
    backend = SMBBackend(
        host="server.local",
        share_name="share",
        username="user",
        password="pass",
        close_connection_cache_on_disconnect=True,
    )
    pool = MagicMock()
    pool.invalidate_connection = AsyncMock()

    with patch("app.storage.smb.get_connection_pool", new_callable=AsyncMock, return_value=pool):
        await backend.disconnect()

    pool.invalidate_connection.assert_awaited_once_with(
        host="server.local",
        port=445,
        username="user",
        share_name="share",
        connection_cache=backend._connection_cache,
        reason="ephemeral connection validation completed",
    )


@pytest.mark.asyncio
@patch("app.storage.smb.smbclient.open_file")
async def test_write_file_from_stream_retries_short_native_writes(mock_open: MagicMock) -> None:
    mock_file = MagicMock()
    mock_file.write.side_effect = [2, 3]
    mock_open.return_value = mock_file
    backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")

    async def stream():
        yield b"hello"

    result = await backend.write_file_from_stream("target.txt", stream())

    assert int(result) == 5
    assert mock_file.write.call_args_list == [call(b"hello"), call(b"llo")]
    mock_file.close.assert_called_once()


@pytest.mark.asyncio
@patch("app.storage.smb.smbclient.utime")
@patch("app.storage.smb.smbclient.open_file")
async def test_write_file_from_stream_marks_an_empty_created_target_as_partial_on_metadata_failure(
    mock_open: MagicMock, mock_utime: MagicMock
) -> None:
    mock_file = MagicMock()
    mock_open.return_value = mock_file
    mock_utime.side_effect = OSError("metadata update failed")
    backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")

    async def stream() -> AsyncIterator[bytes]:
        if False:
            yield b""

    with pytest.raises(TargetWriteFailure, match="metadata update failed") as raised:
        await backend.write_file_from_stream("target.txt", stream(), source_mtime=datetime.now())

    assert raised.value.bytes_written == 0
    assert raised.value.output_may_exist is True
    mock_file.close.assert_called_once()


@pytest.mark.integration
@pytest.mark.asyncio
@pytest.mark.skipif(not _LIVE_SMB_ENABLED, reason="requires TEST_SMB_HOST, TEST_SMB_SHARE, TEST_SMB_USERNAME, and TEST_SMB_PASSWORD")
async def test_live_smb_extraction_preflight_coalesces_flat_destination_checks() -> None:
    archive_buffer = io.BytesIO()
    member_names = ("first.txt", "second.txt", "third.txt")
    with zipfile.ZipFile(archive_buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for member_name in member_names:
            archive.writestr(member_name, member_name)
    backend = SMBBackend(
        host=os.environ["TEST_SMB_HOST"],
        share_name=os.environ["TEST_SMB_SHARE"],
        username=os.environ["TEST_SMB_USERNAME"],
        password=os.environ["TEST_SMB_PASSWORD"],
    )
    destination_root = f"sambee-archive-preflight-{uuid.uuid4().hex}/output"
    destination = _CountingExtractionDestination(backend)
    root_created = False
    try:
        await backend.create_directory(destination_root.rpartition("/")[0])
        root_created = True
        await backend.create_directory(destination_root)

        result = await extract_archive_to_new_paths(
            _MemoryArchiveSource(archive_buffer.getvalue()),
            destination=destination,
            archive_path="source.zip",
            destination_root=destination_root,
        )

        target_paths = [f"{destination_root}/{member_name}" for member_name in member_names]
        assert result.files_extracted == len(member_names)
        assert destination.listed_paths == [destination_root]
        assert all(destination.file_info_paths.count(path) == 1 for path in target_paths)
    finally:
        if root_created:
            await backend.delete_item(destination_root.rpartition("/")[0])
        await backend.disconnect()


class TestPathConstruction:
    """Test SMB path building and normalization."""

    def test_build_path_root(self):
        """Test building path for root directory."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        path = backend._build_smb_path("")
        assert path == r"\\server.local\share"

    def test_build_path_subdirectory(self):
        """Test building path for subdirectory."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        path = backend._build_smb_path("documents")
        assert path == r"\\server.local\share\documents"

    def test_build_path_nested_directory(self):
        """Test building path for deeply nested directory."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        path = backend._build_smb_path("documents/2024/reports")
        assert path == r"\\server.local\share\documents\2024\reports"

    def test_build_path_forward_slash_normalization(self):
        """Test that forward slashes are converted to backslashes."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        path = backend._build_smb_path("documents/subfolder/file.txt")
        assert path == r"\\server.local\share\documents\subfolder\file.txt"

    def test_build_path_backslash_handling(self):
        """Test that backslashes are properly handled."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        path = backend._build_smb_path(r"documents\subfolder\file.txt")
        assert path == r"\\server.local\share\documents\subfolder\file.txt"

    def test_build_path_leading_slash_removal(self):
        """Test that leading slashes are removed."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        path = backend._build_smb_path("/documents/file.txt")
        assert path == r"\\server.local\share\documents\file.txt"

    def test_build_path_multiple_leading_slashes(self):
        """Test handling of multiple leading slashes."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        path = backend._build_smb_path("///documents/file.txt")
        assert path == r"\\server.local\share\documents\file.txt"

    @pytest.mark.parametrize("unsafe_path", ["../secret.txt", "photos/../../secret.txt", r"\\other-server\share\secret.txt"])
    def test_build_path_rejects_share_escapes(self, unsafe_path):
        """SMB paths must remain beneath the configured share root."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        with pytest.raises(ValueError):
            backend._build_smb_path(unsafe_path)

    def test_build_path_unicode_characters(self):
        """Test path building with unicode characters."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        path = backend._build_smb_path("documents/файл.txt")
        assert path == r"\\server.local\share\documents\файл.txt"

    def test_build_path_special_characters(self):
        """Test path building with special characters."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        path = backend._build_smb_path("documents/file (1).txt")
        assert path == r"\\server.local\share\documents\file (1).txt"


class TestNormalizePrefix:
    """Test the static _normalize_prefix helper."""

    @pytest.mark.parametrize(
        "raw,expected",
        [
            # Root / empty → no prefix
            ("/", ""),
            ("", ""),
            (None, ""),
            # Simple paths
            ("/photos", "photos"),
            ("photos", "photos"),
            # Nested paths
            ("/a/b/c", "a/b/c"),
            ("/a/b/c/", "a/b/c"),
            # Backslashes converted
            ("\\photos\\sub", "photos/sub"),
            ("/photos\\sub/", "photos/sub"),
            # Multiple / only slashes
            ("///", ""),
            ("//photos//sub//", "photos//sub"),
        ],
    )
    def test_normalize_prefix(self, raw: str | None, expected: str):
        """Verify _normalize_prefix produces clean relative forms."""

        assert SMBBackend._normalize_prefix(raw) == expected


class TestPathConstructionWithPrefix:
    """Test _build_smb_path when a path_prefix is configured."""

    def test_prefix_root_path(self):
        """Prefix only — browsing the application root."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos",
        )

        path = backend._build_smb_path("")
        assert path == r"\\server.local\share\photos"

    def test_prefix_with_relative_path(self):
        """Prefix combined with a relative sub-path."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos",
        )

        path = backend._build_smb_path("vacation/img.jpg")
        assert path == r"\\server.local\share\photos\vacation\img.jpg"

    def test_nested_prefix(self):
        """Multi-level prefix."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/data/year/2025",
        )

        path = backend._build_smb_path("report.pdf")
        assert path == r"\\server.local\share\data\year\2025\report.pdf"

    def test_no_prefix_still_works(self):
        """Default prefix ('/') should behave like no prefix."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/",
        )

        path = backend._build_smb_path("documents")
        assert path == r"\\server.local\share\documents"

    def test_prefix_with_leading_slash_in_path(self):
        """Leading slash in the relative path should be stripped."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos",
        )

        path = backend._build_smb_path("/vacation")
        assert path == r"\\server.local\share\photos\vacation"

    def test_prefix_with_backslash_input(self):
        """Backslash prefix from user input normalizes correctly."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="\\photos\\sub",
        )

        path = backend._build_smb_path("img.jpg")
        assert path == r"\\server.local\share\photos\sub\img.jpg"

    def test_prefix_trailing_slash_ignored(self):
        """Trailing slash in prefix is stripped."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos/",
        )

        path = backend._build_smb_path("img.jpg")
        assert path == r"\\server.local\share\photos\img.jpg"


class TestMimeTypeDetection:
    """Test MIME type detection for various file types."""

    @pytest.mark.parametrize(
        "filename,expected_mime_type",
        [
            # Text files
            ("document.txt", "text/plain"),
            ("README.md", "text/markdown"),
            ("notes.markdown", "text/markdown"),
            ("script.py", "text/x-python"),
            # Images - standard formats (from mimetypes library)
            ("photo.jpg", "image/jpeg"),
            ("photo.jpeg", "image/jpeg"),
            ("logo.png", "image/png"),
            ("animation.gif", "image/gif"),
            ("scan.tiff", "image/tiff"),
            ("scan.tif", "image/tiff"),
            # Images - explicit mappings (may not be in all system MIME databases)
            ("photo.heic", "image/heic"),
            ("photo.heif", "image/heif"),
            ("image.avif", "image/avif"),
            ("image.webp", "image/webp"),
            ("bitmap.bmp", "image/bmp"),
            ("bitmap.dib", "image/bmp"),
            (
                "icon.ico",
                "image/vnd.microsoft.icon",
            ),  # mimetypes returns this, not image/x-icon
            ("vector.svg", "image/svg+xml"),
            # Documents
            ("document.pdf", "application/pdf"),
            # Unknown/no extension
            ("file.xyz123", "application/octet-stream"),
            ("README", "application/octet-stream"),
            ("no-ext-file", "application/octet-stream"),
        ],
    )
    def test_mime_type_detection(self, filename: str, expected_mime_type: str):
        """Test MIME type detection for various file formats."""
        from app.utils.file_type_registry import get_mime_type

        mime_type = get_mime_type(filename)
        assert mime_type == expected_mime_type


class TestConnectionManagement:
    """Test SMB connection lifecycle."""

    @pytest.mark.asyncio
    async def test_connect_success(self):
        """Test successful SMB connection (now uses pool)."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        # Connect should not raise - actual connection happens via pool
        await backend.connect()

    @pytest.mark.asyncio
    async def test_connect_custom_port(self):
        """Test connection with custom port (now uses pool)."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=8445,
        )

        # Connect should not raise - actual connection happens via pool
        await backend.connect()

    @pytest.mark.asyncio
    async def test_connect_authentication_failure(self):
        """Test connection failure due to authentication (handled by pool)."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="wrongpass",
        )

        # Connect itself doesn't fail - errors happen during operations
        await backend.connect()

    @pytest.mark.asyncio
    async def test_connect_network_error(self):
        """Test connection failure due to network error (handled by pool)."""
        backend = SMBBackend(
            host="unreachable.local",
            share_name="share",
            username="user",
            password="pass",
        )

        # Connect itself doesn't fail - errors happen during operations
        await backend.connect()

    @pytest.mark.asyncio
    async def test_disconnect_keeps_session_alive(self):
        """Test that disconnect doesn't delete the session (for reuse)."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        # Should not raise any exceptions
        await backend.disconnect()

        # Session should remain registered for reuse


class TestDirectoryListing:
    """Test directory listing functionality."""

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_empty_directory(self, mock_scandir):
        """Test listing an empty directory."""
        mock_scandir.return_value = []

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        result = await backend.list_directory("")

        assert isinstance(result, DirectoryListing)
        assert result.path == "/"
        assert result.items == []
        assert result.total == 0

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_directory_with_files(self, mock_scandir):
        """Test listing directory with files."""
        # Create mock entries
        mock_entry1 = MagicMock()
        mock_entry1.name = "file1.txt"
        mock_entry1.smb_info.file_attributes = 0  # Not a directory
        mock_entry1.smb_info.end_of_file = 1024
        mock_entry1.smb_info.last_write_time = datetime(2024, 1, 15, 10, 30)
        mock_entry1.smb_info.creation_time = datetime(2024, 1, 10, 9, 0)

        mock_entry2 = MagicMock()
        mock_entry2.name = "file2.pdf"
        mock_entry2.smb_info.file_attributes = 0
        mock_entry2.smb_info.end_of_file = 2048
        mock_entry2.smb_info.last_write_time = datetime(2024, 1, 16, 14, 45)
        mock_entry2.smb_info.creation_time = datetime(2024, 1, 11, 11, 0)

        mock_scandir.return_value = [mock_entry1, mock_entry2]

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        result = await backend.list_directory("")

        assert result.total == 2
        assert len(result.items) == 2
        assert result.items[0].name == "file1.txt"
        assert result.items[0].type == FileType.FILE
        assert result.items[0].size == 1024
        assert result.items[1].name == "file2.pdf"
        assert result.items[1].size == 2048

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_directory_coalesces_populated_entries_without_child_stats(self, mock_scandir, mock_stat):
        entries = []
        for index in range(3):
            entry = MagicMock()
            entry.name = f"file-{index}.txt"
            entry.smb_info.file_attributes = 0
            entry.smb_info.end_of_file = index + 1
            entry.smb_info.last_write_time = datetime(2024, 1, 15, 10, 30)
            entry.smb_info.creation_time = datetime(2024, 1, 10, 9, 0)
            entries.append(entry)
        mock_scandir.return_value = entries
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")

        result = await backend.list_directory("output")

        assert result.total == len(entries)
        assert [item.name for item in result.items] == ["file-0.txt", "file-1.txt", "file-2.txt"]
        mock_scandir.assert_called_once_with(r"\\server.local\share\output", **SMB_AUTH_KWARGS)
        mock_stat.assert_not_called()

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_directory_with_folders(self, mock_scandir):
        """Test listing directory with subdirectories."""
        mock_entry = MagicMock()
        mock_entry.name = "Documents"
        mock_entry.smb_info.file_attributes = FileAttributes.FILE_ATTRIBUTE_DIRECTORY
        mock_entry.smb_info.end_of_file = 0
        mock_entry.smb_info.last_write_time = datetime(2024, 1, 15, 10, 30)
        mock_entry.smb_info.creation_time = datetime(2024, 1, 10, 9, 0)

        mock_scandir.return_value = [mock_entry]

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        result = await backend.list_directory("")

        assert result.total == 1
        assert result.items[0].name == "Documents"
        assert result.items[0].type == FileType.DIRECTORY
        assert result.items[0].size is None

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_directory_filters_dot_entries(self, mock_scandir):
        """Test that . and .. entries are filtered by smbclient.scandir itself.

        smbclient.scandir already excludes '.' and '..' internally, so
        the backend receives only real entries.  This test verifies the
        backend does not break when only real entries are present.
        """
        mock_entry = MagicMock()
        mock_entry.name = "file.txt"
        mock_entry.smb_info.file_attributes = 0
        mock_entry.smb_info.end_of_file = 100
        mock_entry.smb_info.last_write_time = datetime(2024, 1, 15, 10, 30)
        mock_entry.smb_info.creation_time = datetime(2024, 1, 10, 9, 0)

        # smbclient.scandir never yields '.' or '..', so mock returns
        # only real entries.
        mock_scandir.return_value = [mock_entry]

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        result = await backend.list_directory("")

        # Should only have file.txt, not . or ..
        assert result.total == 1
        assert result.items[0].name == "file.txt"

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_directory_hidden_files(self, mock_scandir):
        """Test detection of hidden files (dot-prefixed)."""
        mock_entry1 = MagicMock()
        mock_entry1.name = ".hidden"
        mock_entry1.smb_info.file_attributes = 0
        mock_entry1.smb_info.end_of_file = 100
        mock_entry1.smb_info.last_write_time = datetime(2024, 1, 15, 10, 30)
        mock_entry1.smb_info.creation_time = datetime(2024, 1, 10, 9, 0)

        mock_entry2 = MagicMock()
        mock_entry2.name = "visible.txt"
        mock_entry2.smb_info.file_attributes = 0
        mock_entry2.smb_info.end_of_file = 200
        mock_entry2.smb_info.last_write_time = datetime(2024, 1, 15, 10, 30)
        mock_entry2.smb_info.creation_time = datetime(2024, 1, 10, 9, 0)

        mock_scandir.return_value = [mock_entry1, mock_entry2]

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        result = await backend.list_directory("")

        assert result.items[0].name == ".hidden"
        assert result.items[0].is_hidden is True
        assert result.items[1].name == "visible.txt"
        assert result.items[1].is_hidden is False

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_subdirectory(self, mock_scandir):
        """Test listing a subdirectory."""
        mock_entry = MagicMock()
        mock_entry.name = "report.pdf"
        mock_entry.smb_info.file_attributes = 0
        mock_entry.smb_info.end_of_file = 5000
        mock_entry.smb_info.last_write_time = datetime(2024, 1, 15, 10, 30)
        mock_entry.smb_info.creation_time = datetime(2024, 1, 10, 9, 0)

        mock_scandir.return_value = [mock_entry]

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        result = await backend.list_directory("documents/2024")

        assert result.path == "documents/2024"
        assert result.items[0].name == "report.pdf"
        assert result.items[0].path == "documents/2024/report.pdf"

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_directory_error_handling(self, mock_scandir):
        """Test error handling when listing fails."""
        mock_scandir.side_effect = PermissionError("Access denied")

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        with pytest.raises(PermissionError, match="Access denied"):
            await backend.list_directory("forbidden")

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_directory_with_problematic_entry(self, mock_scandir):
        """Test that problematic entries don't crash the entire listing."""
        mock_good_entry = MagicMock()
        mock_good_entry.name = "good.txt"
        mock_good_entry.smb_info.file_attributes = 0
        mock_good_entry.smb_info.end_of_file = 100
        mock_good_entry.smb_info.last_write_time = datetime(2024, 1, 15, 10, 30)
        mock_good_entry.smb_info.creation_time = datetime(2024, 1, 10, 9, 0)

        mock_bad_entry = MagicMock()
        mock_bad_entry.name = "bad.txt"
        mock_bad_entry.smb_info.file_attributes = 0
        # Simulate an error when accessing properties
        type(mock_bad_entry.smb_info).end_of_file = property(lambda self: (_ for _ in ()).throw(Exception("Corrupted metadata")))

        mock_scandir.return_value = [mock_good_entry, mock_bad_entry]

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        result = await backend.list_directory("")

        # Should have both entries, but bad entry has minimal info
        assert result.total == 2
        assert result.items[0].name == "good.txt"
        assert result.items[1].name == "bad.txt"
        assert result.items[1].is_readable is False


class TestFileInfoRetrieval:
    """Test getting file information."""

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    async def test_get_file_info_for_file(self, mock_stat):
        """Test getting info for a file."""
        mock_stat.return_value = MagicMock(
            st_size=1024,
            st_mode=stat_module.S_IFREG | 0o644,
            st_mtime=datetime(2024, 1, 15, 10, 30).timestamp(),
            st_ctime=datetime(2024, 1, 10, 9, 0).timestamp(),
        )

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        result = await backend.get_file_info("documents/file.txt")

        assert result.name == "file.txt"
        assert result.path == "documents/file.txt"
        assert result.type == FileType.FILE
        assert result.size == 1024
        assert result.mime_type == "text/plain"
        assert result.is_hidden is False

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    async def test_get_file_info_for_directory(self, mock_stat):
        """Test getting info for a directory."""
        mock_stat.return_value = MagicMock(
            st_size=0,
            st_mode=stat_module.S_IFDIR | 0o755,
            st_mtime=datetime(2024, 1, 15, 10, 30).timestamp(),
            st_ctime=datetime(2024, 1, 10, 9, 0).timestamp(),
        )

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        result = await backend.get_file_info("documents")

        assert result.name == "documents"
        assert result.type == FileType.DIRECTORY
        assert result.size is None
        assert result.mime_type is None

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    async def test_get_file_info_hidden_file(self, mock_stat):
        """Test that hidden files are detected."""
        mock_stat.return_value = MagicMock(
            st_size=100,
            st_mode=stat_module.S_IFREG | 0o644,
            st_mtime=datetime(2024, 1, 15, 10, 30).timestamp(),
            st_ctime=datetime(2024, 1, 10, 9, 0).timestamp(),
        )

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        result = await backend.get_file_info(".hidden")

        assert result.is_hidden is True

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    async def test_get_file_info_not_found(self, mock_stat):
        """Test error when file not found."""
        mock_stat.side_effect = FileNotFoundError("File not found")

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        with pytest.raises(FileNotFoundError, match="Path not found: nonexistent.txt"):
            await backend.get_file_info("nonexistent.txt")

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    async def test_get_file_info_maps_smb_missing_path_to_file_not_found(self, mock_stat):
        """SMB missing-path errors should surface as FileNotFoundError."""
        mock_stat.side_effect = OSError("[Error 2] [NtStatus 0xc0000034] No such file or directory")

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        with pytest.raises(FileNotFoundError, match="Path not found: nonexistent.txt"):
            await backend.get_file_info("nonexistent.txt")


class TestFileReading:
    """Test file reading and streaming."""

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_read_small_file(self, mock_open):
        """Test reading a small file completely."""
        mock_file = MagicMock()
        mock_file.read.side_effect = [b"Hello, World!", b""]
        mock_file.close.return_value = None
        mock_open.return_value = mock_file

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        chunks = []
        async for chunk in backend.read_file("file.txt"):
            chunks.append(chunk)

        assert chunks == [b"Hello, World!"]
        mock_file.close.assert_called_once()

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_read_file_in_chunks(self, mock_open):
        """Test reading a file in multiple chunks."""
        mock_file = MagicMock()
        mock_file.read.side_effect = [
            b"chunk1",
            b"chunk2",
            b"chunk3",
            b"",
        ]
        mock_file.close.return_value = None
        mock_open.return_value = mock_file

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        chunks = []
        async for chunk in backend.read_file("largefile.bin"):
            chunks.append(chunk)

        assert chunks == [b"chunk1", b"chunk2", b"chunk3"]
        mock_file.close.assert_called_once()

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_read_empty_file(self, mock_open):
        """Test reading an empty file."""
        mock_file = MagicMock()
        mock_file.read.side_effect = [b""]
        mock_file.close.return_value = None
        mock_open.return_value = mock_file

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        chunks = []
        async for chunk in backend.read_file("empty.txt"):
            chunks.append(chunk)

        assert chunks == []
        mock_file.close.assert_called_once()

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_read_file_error(self, mock_open):
        """Test error handling when file read fails."""
        mock_open.side_effect = PermissionError("Access denied")

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        with pytest.raises(PermissionError, match="Access denied"):
            async for chunk in backend.read_file("forbidden.txt"):
                pass

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_read_file_closes_on_error(self, mock_open):
        """Test that file handle is closed even on error."""
        mock_file = MagicMock()
        mock_file.read.side_effect = [b"data", Exception("Read error")]
        mock_file.close.return_value = None
        mock_open.return_value = mock_file

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        with pytest.raises(Exception, match="Read error"):
            async for chunk in backend.read_file("file.txt"):
                pass

        # File should still be closed
        mock_file.close.assert_called_once()


class TestRandomAccessReading:
    """Test operation-scoped SMB readers used by archive operations."""

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_random_reader_reads_at_offset_and_closes(self, mock_open):
        mock_file = MagicMock()
        mock_file.read.return_value = b"archive"
        mock_open.return_value = mock_file
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")

        reader = await backend.open_random_access_reader("backup.zip")
        assert await reader.read_at(128, 7) == b"archive"

        mock_file.seek.assert_called_once_with(128)
        mock_file.read.assert_called_once_with(7)

        await reader.close()
        await reader.close()
        mock_file.close.assert_called_once()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("failure", [AccessDenied(), TimeoutError("acknowledgement lost"), OSError("connection lost")])
    async def test_move_delete_classifies_server_rejection_and_lost_acknowledgement(self, failure):
        handle = MagicMock(spec=["fd", "close", "seek", "read"])
        handle.fd.file_id = b"f" * 16
        handle.fd.connection.receive.side_effect = failure
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        with patch("app.storage.smb.smbclient.open_file", return_value=handle):
            reader = await backend.open_move_source_reader("source.txt")
            expected = SourceDeleteError if isinstance(failure, AccessDenied) else SourceDeletionOutcomeUnknown
            with pytest.raises(expected):
                await reader.commit_delete()
            await reader.close()
            await reader.close()
        handle.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_move_close_failure_after_delete_pending_is_unknown(self):
        handle = MagicMock(spec=["fd", "close", "seek", "read"])
        handle.fd.file_id = b"f" * 16
        handle.fd.connection.receive.return_value = {"data": MagicMock(get_value=lambda: SMB2SetInfoResponse().pack())}
        handle.close.side_effect = OSError("close acknowledgement lost")
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        with patch("app.storage.smb.smbclient.open_file", return_value=handle):
            reader = await backend.open_move_source_reader("source.txt")
            with pytest.raises(SourceDeletionOutcomeUnknown, match="close"):
                await reader.commit_delete()
        handle.close.assert_called_once()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("cancelled", [False, True])
    async def test_move_queued_delete_rechecks_cancellation_on_event_loop(self, cancelled):
        loop = asyncio.get_running_loop()
        event_loop_thread = get_ident()
        release_worker = Event()
        worker_started = asyncio.Event()
        cancellation_requested = asyncio.Event()
        published = False
        handle = MagicMock(spec=["fd", "close", "seek", "read"])
        handle.fd.file_id = b"f" * 16
        handle.fd.connection.receive.return_value = {"data": MagicMock(get_value=lambda: SMB2SetInfoResponse().pack())}
        handle.read.return_value = b"content"
        source_info = FileInfo(name="source.txt", path="source.txt", type=FileType.FILE, size=7, stable_id="original")
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        with patch("app.storage.smb.smbclient.open_file", return_value=handle):
            reader = await backend.open_move_source_reader("source.txt")
        reader.get_file_info = AsyncMock(return_value=source_info)
        source = AsyncMock()
        source.get_file_info.return_value = source_info
        source.open_move_source_reader.return_value = reader
        destination = AsyncMock()
        run_in_executor = loop.run_in_executor

        def occupy_worker():
            loop.call_soon_threadsafe(worker_started.set)
            assert release_worker.wait(5)

        async def publish(_path, stream, *, before_commit, **_kwargs):
            nonlocal published
            payload = b"".join([chunk async for chunk in stream])
            await before_commit()
            published = True
            loop.run_in_executor(None, occupy_worker)
            await worker_started.wait()
            return len(payload)

        def is_cancelled():
            assert get_ident() == event_loop_thread
            if published and not cancellation_requested.is_set():
                loop.call_soon(cancellation_requested.set)
            return cancelled and cancellation_requested.is_set()

        destination.stage_and_commit_new_file_from_stream.side_effect = publish
        with (
            ThreadPoolExecutor(max_workers=1) as executor,
            patch.object(loop, "run_in_executor", side_effect=lambda _executor, operation: run_in_executor(executor, operation)),
        ):
            moving = asyncio.create_task(
                cross_connection_move(source, destination, "source.txt", "target.txt", cancellation=is_cancelled, overwrite=True)
            )
            try:
                await asyncio.wait_for(cancellation_requested.wait(), 5)
                handle.fd.connection.send.assert_not_called()
            finally:
                release_worker.set()
            if cancelled:
                with pytest.raises(SourceDeleteError, match="cancelled") as raised:
                    await moving
                assert raised.value.destination_mutated is True
                assert raised.value.replaced is True
                handle.fd.connection.send.assert_not_called()
            else:
                result = await moving
                assert result.bytes_written == len(b"content")
                assert result.replaced is True
                handle.fd.connection.send.assert_called_once()
        handle.close.assert_called_once()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("closed", [False, True])
    async def test_move_pre_dispatch_failure_definitely_retains_source(self, closed):
        handle = MagicMock(spec=["close", "seek", "read"])
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        with patch("app.storage.smb.smbclient.open_file", return_value=handle):
            reader = await backend.open_move_source_reader("source.txt")
            if closed:
                await reader.close()
            with pytest.raises(SourceDeleteError) as raised:
                await reader.commit_delete()
            assert raised.value.destination_mutated is True
            await reader.close()
        handle.close.assert_called_once()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("cancelled", [False, True])
    async def test_timed_out_move_open_disposes_late_handle_and_releases_lease(self, cancelled):
        started = Event()
        finish = Event()
        released = asyncio.Event()
        handle = MagicMock(spec=["close", "fd", "seek", "read"])

        @asynccontextmanager
        async def lease(**_kwargs):
            try:
                yield
            finally:
                released.set()

        def open_handle(*_args, **_kwargs):
            started.set()
            assert finish.wait(2)
            return handle

        pool = MagicMock()
        pool.get_connection = lease
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        with (
            patch("app.storage.smb.get_connection_pool", new_callable=AsyncMock, return_value=pool),
            patch("app.storage.smb.smbclient.open_file", side_effect=open_handle),
            patch("app.storage.smb.SMB_FILE_OPEN_TIMEOUT_SECONDS", 2 if cancelled else 0.01),
        ):
            try:
                if cancelled:
                    opening = asyncio.create_task(backend.open_move_source_reader("source.txt"))
                    assert await asyncio.to_thread(started.wait, 2)
                    opening.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await opening
                else:
                    with pytest.raises(TimeoutError):
                        await backend.open_move_source_reader("source.txt")
                assert started.is_set()
                assert not released.is_set()
                handle.close.assert_not_called()
            finally:
                finish.set()
            await asyncio.wait_for(released.wait(), 2)
        handle.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_timed_out_delete_closes_only_after_dispatch_settles(self):
        started = Event()
        finish = Event()
        released = asyncio.Event()
        handle = MagicMock(spec=["close", "fd", "seek", "read"])
        handle.fd.file_id = b"f" * 16

        @asynccontextmanager
        async def lease(**_kwargs):
            try:
                yield
            finally:
                released.set()

        def receive(*_args):
            started.set()
            assert finish.wait(2)
            return {"data": MagicMock(get_value=lambda: SMB2SetInfoResponse().pack())}

        handle.fd.connection.receive.side_effect = receive
        pool = MagicMock()
        pool.get_connection = lease
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        with (
            patch("app.storage.smb.get_connection_pool", new_callable=AsyncMock, return_value=pool),
            patch("app.storage.smb.smbclient.open_file", return_value=handle),
            patch("app.storage.smb.SMB_DELETE_TIMEOUT_SECONDS", 0.01),
            patch("app.storage.smb.SMB_FILE_CLOSE_TIMEOUT_SECONDS", 0.01),
        ):
            reader = await backend.open_move_source_reader("source.txt")
            try:
                with pytest.raises(SourceDeletionOutcomeUnknown):
                    await reader.commit_delete()
                with pytest.raises(TimeoutError):
                    await reader.close()
                assert started.is_set()
                assert not released.is_set()
                handle.close.assert_not_called()
            finally:
                finish.set()
            await asyncio.wait_for(released.wait(), 2)
            await reader.close()
        handle.close.assert_called_once()

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_random_reader_rejects_invalid_offsets_and_closed_reads(self, mock_open):
        mock_open.return_value = MagicMock()
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        reader = await backend.open_random_access_reader("backup.zip")

        with pytest.raises(ValueError, match="non-negative"):
            await reader.read_at(-1, 1)
        with pytest.raises(ValueError, match="non-negative"):
            await reader.read_at(0, -1)

        await reader.close()
        with pytest.raises(ValueError, match="closed"):
            await reader.read_at(0, 1)

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_archive_source_reader_denies_concurrent_writers(self, mock_open):
        mock_open.return_value = MagicMock()
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")

        reader = await backend.open_archive_source_reader("backup.zip")

        assert mock_open.call_args.kwargs["share_access"] == "r"
        await reader.close()

    @pytest.mark.asyncio
    async def test_move_metadata_queries_the_opened_object(self):
        handle = MagicMock(spec=["fd", "close", "seek", "read"])
        modified = datetime(2025, 1, 1)
        values = [
            {
                "last_write_time": MagicMock(
                    get_value=lambda: DateTimeField.EPOCH_FILETIME + int(modified.timestamp()) * SMB_FILETIME_TICKS_PER_SECOND
                )
            },
            {"index_number": MagicMock(get_value=lambda: 123)},
            {"directory": MagicMock(get_value=lambda: False), "end_of_file": MagicMock(get_value=lambda: 7)},
        ]
        transaction = MagicMock()
        transaction.__enter__.return_value.results = values
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        with (
            patch("app.storage.smb.smbclient.open_file", return_value=handle),
            patch("app.storage.smb.SMBFileTransaction", return_value=transaction) as begin,
            patch("app.storage.smb.query_info") as query,
            patch("app.storage.smb.smbclient.stat") as path_stat,
        ):
            reader = await backend.open_move_source_reader("docs/source.txt")
            info = await reader.get_file_info()
            await reader.close()
        assert info.path == "docs/source.txt"
        assert info.size == 7
        assert info.stable_id == "123"
        assert info.modified_at == modified
        begin.assert_called_once_with(handle)
        assert query.call_count == 3
        path_stat.assert_not_called()

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_move_source_reader_deletes_the_retained_smb_handle(self, mock_open):
        response = SMB2SetInfoResponse().pack()
        mock_file = MagicMock(spec=["fd", "close", "seek", "read"])
        mock_file.fd.file_id = b"f" * 16
        mock_file.fd.connection.receive.return_value = {"data": MagicMock(get_value=lambda: response)}
        mock_open.return_value = mock_file
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")

        reader = await backend.open_move_source_reader("source.txt")
        await reader.commit_delete()

        assert mock_open.call_args.kwargs["share_access"] == "r"
        assert mock_open.call_args.kwargs["desired_access"] & FilePipePrinterAccessMask.DELETE
        request = mock_file.fd.connection.send.call_args.args[0]
        assert request["info_type"].get_value() == InfoType.SMB2_0_INFO_FILE
        assert request["file_info_class"].get_value() == FileInformationClass.FILE_DISPOSITION_INFORMATION
        assert request["file_id"].get_value() == b"f" * 16
        disposition = FileDispositionInformation()
        disposition.unpack(request["buffer"].get_value())
        assert disposition["delete_pending"].get_value() is True
        mock_file.close.assert_called_once()


class TestExclusiveArchiveWriting:
    """Test direct final-target writers used by archive creation."""

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_exclusive_writer_appends_and_closes(self, mock_open):
        mock_file = MagicMock()
        mock_file.write.return_value = 3
        mock_open.return_value = mock_file
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")

        writer = await backend.open_exclusive_writer("backup.zip")
        assert await writer.write(b"zip") == 3
        await writer.close()
        await writer.close()

        assert mock_open.call_args.kwargs["mode"] == "x+b"
        assert mock_open.call_args.kwargs["share_access"] == "rwd"
        mock_file.write.assert_called_once_with(b"zip")
        mock_file.close.assert_called_once()

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.remove")
    @patch("app.storage.smb.smbclient.open_file")
    async def test_exclusive_writer_deletes_only_while_active(self, mock_open, mock_remove):
        mock_open.return_value = MagicMock()
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")

        writer = await backend.open_exclusive_writer("partial.zip")
        assert await writer.abort_and_delete_if_owned() is True
        assert await writer.abort_and_delete_if_owned() is False

        mock_remove.assert_called_once()


@pytest.mark.integration
@pytest.mark.asyncio
@pytest.mark.skipif(
    not _LIVE_SMB_ENABLED, reason="requires explicit TEST_SMB_HOST, TEST_SMB_SHARE, TEST_SMB_USERNAME, and TEST_SMB_PASSWORD"
)
async def test_live_smb_protected_move_and_atomic_replacement() -> None:
    """Exercise server sharing and deletion semantics only in a disposable directory."""

    kwargs = dict(
        host=os.environ["TEST_SMB_HOST"],
        share_name=os.environ["TEST_SMB_SHARE"],
        username=os.environ["TEST_SMB_USERNAME"],
        password=os.environ["TEST_SMB_PASSWORD"],
    )
    source = SMBBackend(**kwargs)
    destination = SMBBackend(**kwargs)
    root = f"sambee-transfer-{uuid.uuid4().hex}"
    source_path, target_path = f"{root}/source.txt", f"{root}/target.txt"
    created = False
    try:
        await source.create_directory(root)
        created = True
        await source.write_file(source_path, io.BytesIO(b"copied bytes"))
        await destination.write_file(target_path, io.BytesIO(b"old destination"))
        writer = await asyncio.to_thread(
            smbclient.open_file, source._build_smb_path(source_path), mode="r+b", share_access="rwd", **source._smb_auth_kwargs()
        )
        try:
            with pytest.raises((OSError, AccessDenied)):
                await source.open_move_source_reader(source_path)
        finally:
            await asyncio.to_thread(writer.close)
        reader = await source.open_move_source_reader(source_path)
        try:
            assert (await reader.get_file_info()).stable_id == (await source.get_file_info(source_path)).stable_id

            def update() -> None:
                with smbclient.open_file(
                    source._build_smb_path(source_path), mode="r+b", share_access="rwd", **source._smb_auth_kwargs()
                ) as handle:
                    handle.write(b"newer bytes")

            with pytest.raises(OSError):
                await asyncio.to_thread(update)
            with pytest.raises(OSError):
                await asyncio.to_thread(
                    smbclient.rename,
                    source._build_smb_path(source_path),
                    source._build_smb_path(f"{root}/renamed.txt"),
                    **source._smb_auth_kwargs(),
                )
            assert await reader.read_at(0, 64) == b"copied bytes"
        finally:
            await reader.close()
        result = await cross_connection_move(source, destination, source_path, target_path, overwrite=True)
        assert result.replaced is True
        assert not await source.file_exists(source_path)
        assert b"".join([chunk async for chunk in destination.read_file(target_path)]) == b"copied bytes"
    finally:
        if created:
            await source.delete_item(root)
        await source.disconnect()
        await destination.disconnect()


class TestTransferPublication:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("overwrite", [False, True])
    async def test_stage_publication_uses_actual_replacement_primitive(self, overwrite):
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        handle = MagicMock()
        handle.write.return_value = 7

        async def chunks():
            yield b"content"

        async def before_commit():
            return overwrite

        with (
            patch("app.storage.smb.smbclient.open_file", return_value=handle),
            patch("app.storage.smb.smbclient.replace") as replace,
            patch("app.storage.smb.smbclient.rename") as rename,
            patch("app.storage.smb.smbclient.renames") as renames,
            patch("app.storage.smb.smbclient.remove") as remove,
        ):
            assert await backend.stage_and_commit_new_file_from_stream("target.txt", chunks(), before_commit=before_commit) == 7
        selected, unused = (replace, rename) if overwrite else (rename, replace)
        selected.assert_called_once()
        assert selected.call_args.args[1] == r"\\server.local\share\target.txt"
        unused.assert_not_called()
        renames.assert_not_called()
        remove.assert_not_called()
        handle.close.assert_called_once()

    @pytest.mark.asyncio
    async def test_same_connection_replacement_never_removes_visible_target(self):
        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        with (
            patch("app.storage.smb.smbclient.path.exists", return_value=True),
            patch("app.storage.smb.smbclient.replace") as replace,
            patch("app.storage.smb.smbclient.renames") as renames,
            patch("app.storage.smb.smbclient.remove") as remove,
        ):
            await backend.move_item("source.txt", "target.txt", overwrite=True)
        replace.assert_called_once_with(r"\\server.local\share\source.txt", r"\\server.local\share\target.txt", **SMB_AUTH_KWARGS)
        renames.assert_not_called()
        remove.assert_not_called()


class TestFileExistence:
    """Test file existence checks."""

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.path.exists")
    async def test_file_exists_true(self, mock_exists):
        """Test checking if file exists (exists)."""
        mock_exists.return_value = True

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        exists = await backend.file_exists("file.txt")

        assert exists is True

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.path.exists")
    async def test_file_exists_false(self, mock_exists):
        """Test checking if file exists (doesn't exist)."""
        mock_exists.return_value = False

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        exists = await backend.file_exists("nonexistent.txt")

        assert exists is False

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.path.exists")
    async def test_directory_exists_true(self, mock_exists):
        """Test checking if directory exists."""
        mock_exists.return_value = True

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        exists = await backend.file_exists("documents")

        assert exists is True

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.path.exists")
    async def test_file_exists_error_handling(self, mock_exists):
        """Test that errors return False instead of raising."""
        mock_exists.side_effect = Exception("Network error")

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        exists = await backend.file_exists("file.txt")

        # Should return False on error, not raise
        assert exists is False


class TestErrorHandling:
    """Test comprehensive error handling scenarios."""

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_directory_network_timeout(self, mock_scandir):
        """Test handling network timeout during directory listing."""
        mock_scandir.side_effect = TimeoutError("Connection timed out")

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        with pytest.raises(TimeoutError, match="SMB operation timed out"):
            await backend.list_directory("")

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    async def test_get_file_info_permission_denied(self, mock_stat):
        """Test handling permission denied errors."""
        mock_stat.side_effect = PermissionError("Access is denied")

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        with pytest.raises(PermissionError, match="Access is denied"):
            await backend.get_file_info("forbidden.txt")

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_read_file_network_error(self, mock_open):
        """Test handling network errors during file read."""
        mock_file = MagicMock()
        mock_file.read.side_effect = ConnectionError("Connection lost")
        mock_file.close.return_value = None
        mock_open.return_value = mock_file

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        with pytest.raises(ConnectionError, match="Connection lost"):
            async for chunk in backend.read_file("file.txt"):
                pass


class TestBackendInitialization:
    """Test SMB backend initialization."""

    def test_backend_initialization_default_port(self):
        """Test backend initialization with default port."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        assert backend.host == "server.local"
        assert backend.share_name == "share"
        assert backend.username == "user"
        assert backend.password == "pass"
        assert backend.port == 445
        assert backend._base_path == r"\\server.local\share"

    def test_backend_initialization_custom_port(self):
        """Test backend initialization with custom port."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            port=8445,
        )

        assert backend.port == 8445

    def test_backend_initialization_special_characters(self):
        """Test backend initialization with special characters in share name."""
        backend = SMBBackend(
            host="server.local",
            share_name="share$",
            username="user",
            password="p@ssw0rd!",
        )

        assert backend.share_name == "share$"
        assert backend.password == "p@ssw0rd!"
        assert backend._base_path == r"\\server.local\share$"

    def test_backend_initialization_default_prefix(self):
        """Default path_prefix '/' normalizes to empty string (share root)."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        assert backend._path_prefix == ""

    def test_backend_initialization_custom_prefix(self):
        """Custom path_prefix is cleaned and stored."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos/vacation",
        )

        assert backend._path_prefix == "photos/vacation"

    def test_backend_initialization_none_prefix(self):
        """None path_prefix normalizes to empty string."""

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix=None,
        )

        assert backend._path_prefix == ""


class TestPathPrefixIntegration:
    """Integration tests verifying path_prefix reaches smbclient calls."""

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_directory_uses_prefix(self, mock_scandir):
        """list_directory('') with prefix scans the prefixed path."""

        mock_scandir.return_value = []

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos",
        )

        await backend.list_directory("")

        mock_scandir.assert_called_once_with(r"\\server.local\share\photos", **SMB_AUTH_KWARGS)

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_subdirectory_uses_prefix(self, mock_scandir):
        """list_directory('vacation') with prefix scans prefix/vacation."""

        mock_scandir.return_value = []

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos",
        )

        await backend.list_directory("vacation")

        mock_scandir.assert_called_once_with(r"\\server.local\share\photos\vacation", **SMB_AUTH_KWARGS)

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    async def test_get_file_info_uses_prefix(self, mock_stat):
        """get_file_info with prefix builds the correct UNC path."""

        stat_result = MagicMock()
        stat_result.st_size = 1024
        stat_result.st_mode = 0o100644
        stat_result.st_mtime = 1700000000.0
        stat_result.st_ctime = 1700000000.0
        mock_stat.return_value = stat_result

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos",
        )

        await backend.get_file_info("vacation/img.jpg")

        mock_stat.assert_called_once_with(r"\\server.local\share\photos\vacation\img.jpg", **SMB_AUTH_KWARGS)

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.remove")
    @patch("app.storage.smb.smbclient.stat")
    async def test_delete_file_uses_prefix(self, mock_stat, mock_remove):
        """delete_item with prefix targets the correct prefixed path."""

        stat_result = MagicMock()
        stat_result.st_mode = 0o100644  # regular file
        mock_stat.return_value = stat_result

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos",
        )

        await backend.delete_item("vacation/img.jpg")

        expected_path = r"\\server.local\share\photos\vacation\img.jpg"
        mock_stat.assert_called_once_with(expected_path, **SMB_AUTH_KWARGS)
        mock_remove.assert_called_once_with(expected_path, **SMB_AUTH_KWARGS)

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.open_file")
    async def test_read_file_uses_prefix(self, mock_open):
        """read_file with prefix opens the correct prefixed path."""

        mock_file = MagicMock()
        mock_file.read.side_effect = [b"data", b""]
        mock_file.__enter__ = MagicMock(return_value=mock_file)
        mock_file.__exit__ = MagicMock(return_value=False)
        mock_open.return_value = mock_file

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos",
        )

        chunks = []
        async for chunk in backend.read_file("vacation/img.jpg"):
            chunks.append(chunk)

        mock_open.assert_called_once_with(
            r"\\server.local\share\photos\vacation\img.jpg",
            mode="rb",
            share_access="rwd",
            **SMB_AUTH_KWARGS,
        )

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.path.exists")
    async def test_file_exists_uses_prefix(self, mock_exists):
        """file_exists with prefix checks the correct prefixed path."""

        mock_exists.return_value = True

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos",
        )

        result = await backend.file_exists("vacation/img.jpg")

        assert result is True
        mock_exists.assert_called_once_with(r"\\server.local\share\photos\vacation\img.jpg", **SMB_AUTH_KWARGS)

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.scandir")
    async def test_list_directory_routes_each_private_connection_credentials(self, mock_scandir):
        """SMB operations must select the credentials of the active private connection."""

        mock_scandir.return_value = []
        first_backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="domain\\first-user",
            password="first-password",
        )
        second_backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="domain\\second-user",
            password="second-password",
        )

        await first_backend.list_directory("")
        await second_backend.list_directory("")

        mock_scandir.assert_has_calls(
            [
                call(
                    r"\\server.local\share",
                    username="domain\\first-user",
                    password="first-password",
                    port=445,
                    connection_cache=ANY,
                    encrypt=False,
                    connection_timeout=30,
                    auth_protocol="negotiate",
                    require_signing=True,
                ),
                call(
                    r"\\server.local\share",
                    username="domain\\second-user",
                    password="second-password",
                    port=445,
                    connection_cache=ANY,
                    encrypt=False,
                    connection_timeout=30,
                    auth_protocol="negotiate",
                    require_signing=True,
                ),
            ]
        )
        assert mock_scandir.call_args_list[0].kwargs["connection_cache"] is not mock_scandir.call_args_list[1].kwargs["connection_cache"]


class TestDeleteItem:
    """Test file and directory deletion."""

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.remove")
    @patch("app.storage.smb.smbclient.stat")
    async def test_delete_file(self, mock_stat, mock_remove):
        """Test deleting a regular file calls smbclient.remove."""
        stat_result = MagicMock()
        stat_result.st_mode = 0o100644  # regular file mode
        mock_stat.return_value = stat_result

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        await backend.delete_item("/docs/readme.txt")

        mock_stat.assert_called_once_with(r"\\server.local\share\docs\readme.txt", **SMB_AUTH_KWARGS)
        mock_remove.assert_called_once_with(r"\\server.local\share\docs\readme.txt", **SMB_AUTH_KWARGS)

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.rmdir")
    @patch("app.storage.smb.smbclient.scandir")
    @patch("app.storage.smb.smbclient.stat")
    async def test_delete_empty_directory(self, mock_stat, mock_scandir, mock_rmdir):
        """Test deleting an empty directory calls smbclient.rmdir."""
        stat_result = MagicMock()
        stat_result.st_mode = 0o40755  # directory mode
        mock_stat.return_value = stat_result
        mock_scandir.return_value = []  # empty directory

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        await backend.delete_item("/empty-folder")

        mock_stat.assert_called_once_with(r"\\server.local\share\empty-folder", **SMB_AUTH_KWARGS)
        mock_scandir.assert_called_once_with(r"\\server.local\share\empty-folder", **SMB_AUTH_KWARGS)
        mock_rmdir.assert_called_once_with(r"\\server.local\share\empty-folder", **SMB_AUTH_KWARGS)

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    async def test_delete_not_found_raises(self, mock_stat):
        """Test deleting a non-existent path raises FileNotFoundError."""
        mock_stat.side_effect = OSError("(0xc0000034) STATUS_OBJECT_NAME_NOT_FOUND")

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        with pytest.raises(FileNotFoundError, match="Path not found"):
            await backend.delete_item("/ghost.txt")

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.remove")
    @patch("app.storage.smb.smbclient.rmdir")
    @patch("app.storage.smb.smbclient.scandir")
    @patch("app.storage.smb.smbclient.stat")
    async def test_delete_directory_recursive(self, mock_stat, mock_scandir, mock_rmdir, mock_remove):
        """Test deleting a non-empty directory removes children first."""
        dir_stat = MagicMock()
        dir_stat.st_mode = 0o40755  # directory mode

        file_stat = MagicMock()
        file_stat.st_mode = 0o100644  # regular file mode

        # stat returns dir for the root, file for children
        mock_stat.side_effect = lambda path, **kwargs: dir_stat if path == r"\\server.local\share\folder" else file_stat

        # scandir returns two file entries inside the directory
        child_a = MagicMock()
        child_a.path = r"\\server.local\share\folder\a.txt"
        child_b = MagicMock()
        child_b.path = r"\\server.local\share\folder\b.txt"
        mock_scandir.return_value = [child_a, child_b]

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        await backend.delete_item("/folder")

        # Both children removed, then the directory itself
        assert mock_remove.call_count == 2
        mock_rmdir.assert_called_once_with(r"\\server.local\share\folder", **SMB_AUTH_KWARGS)

    @pytest.mark.asyncio
    async def test_delete_timeout_raises(self):
        """Test that a slow delete operation raises TimeoutError without starting a worker."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        pending_operation = asyncio.get_running_loop().create_future()

        with (
            patch("app.storage.smb.asyncio.get_running_loop") as mock_get_running_loop,
            patch("app.storage.smb.asyncio.wait_for", side_effect=asyncio.TimeoutError()),
        ):
            mock_get_running_loop.return_value.run_in_executor.return_value = pending_operation
            with pytest.raises(TimeoutError, match="timed out"):
                await backend.delete_item("/big-file.zip")

        mock_get_running_loop.return_value.run_in_executor.assert_called_once()

    @pytest.mark.asyncio
    async def test_late_smb_worker_failure_is_logged_after_timeout(self):
        started = Event()
        complete = Event()

        def delayed_failure() -> None:
            started.set()
            complete.wait()
            raise OSError("late SMB failure")

        backend = SMBBackend(host="server.local", share_name="share", username="user", password="pass")
        operation_future = asyncio.get_running_loop().run_in_executor(None, delayed_failure)

        with patch("app.storage.smb.logger.warning") as mock_warning:
            with pytest.raises(asyncio.TimeoutError):
                await backend._wait_for_blocking_smb_operation(
                    operation_future,
                    operation_name="test operation",
                    smb_path=r"\\server.local\share\file.txt",
                    timeout_seconds=0.001,
                )

            assert started.wait(timeout=1.0)
            complete.set()
            with pytest.raises(OSError, match="late SMB failure"):
                await operation_future
            await asyncio.sleep(0)

        mock_warning.assert_any_call(
            "SMB %s for '%s' failed after timing out",
            "test operation",
            r"\\server.local\share\file.txt",
            exc_info=True,
        )

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    async def test_delete_pending_oserror_treated_as_success(self, mock_stat):
        """Test that STATUS_DELETE_PENDING (0xc0000056) OSError is treated as success.

        When the SMB server returns STATUS_DELETE_PENDING it means the item
        is already being deleted — the operation should succeed silently.
        """
        mock_stat.side_effect = OSError(
            "[Error 0] [NtStatus 0xc0000056] Unknown NtStatus error returned 'STATUS_DELETE_PENDING': '\\\\server\\share\\file.txt'"
        )

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        # Should NOT raise — treated as successful deletion
        await backend.delete_item("/file.txt")

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.stat")
    async def test_delete_pending_non_oserror_treated_as_success(self, mock_stat):
        """Test that STATUS_DELETE_PENDING from a non-OSError is also handled.

        smbprotocol may raise custom exception types (e.g. SMBOSError or
        DeletePending) that carry the NtStatus code in the message.
        """

        class FakeDeletePending(Exception):
            """Simulates smbprotocol.exceptions.DeletePending."""

        FakeDeletePending.__name__ = "DeletePending"

        mock_stat.side_effect = FakeDeletePending(
            "A non-close operation has been requested of a file object "
            "that has a delete pending. (3221225558) STATUS_DELETE_PENDING: 0xc0000056"
        )

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        # Should NOT raise
        await backend.delete_item("/file.txt")


class TestRenameItem:
    """Test file and directory renaming."""

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.rename")
    async def test_rename_file(self, mock_rename):
        """Test renaming a file calls smbclient.rename with correct paths."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        await backend.rename_item("/docs/readme.txt", "notes.txt")

        mock_rename.assert_called_once_with(
            r"\\server.local\share\docs\readme.txt",
            r"\\server.local\share\docs\notes.txt",
            **SMB_AUTH_KWARGS,
        )

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.rename")
    async def test_rename_directory(self, mock_rename):
        """Test renaming a directory calls smbclient.rename with correct paths."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        await backend.rename_item("/photos/vacation", "holiday")

        mock_rename.assert_called_once_with(
            r"\\server.local\share\photos\vacation",
            r"\\server.local\share\photos\holiday",
            **SMB_AUTH_KWARGS,
        )

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.rename")
    async def test_rename_not_found_raises(self, mock_rename):
        """Test renaming a non-existent path raises FileNotFoundError."""
        mock_rename.side_effect = OSError("(0xc0000034) STATUS_OBJECT_NAME_NOT_FOUND")

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        with pytest.raises(FileNotFoundError, match="Path not found"):
            await backend.rename_item("/ghost.txt", "renamed.txt")

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.rename")
    async def test_rename_collision_raises(self, mock_rename):
        """Test renaming to an existing name raises FileExistsError."""
        mock_rename.side_effect = OSError("(0xc0000035) STATUS_OBJECT_NAME_COLLISION")

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )
        with pytest.raises(FileExistsError, match="already exists"):
            await backend.rename_item("/document.txt", "existing.txt")

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.rename")
    async def test_rename_timeout_raises(self, mock_rename):
        """Test that a slow rename operation raises TimeoutError."""
        import asyncio

        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
        )

        with patch("asyncio.wait_for", side_effect=asyncio.TimeoutError()):
            with pytest.raises(TimeoutError, match="timed out"):
                await backend.rename_item("/document.txt", "renamed.txt")

    @pytest.mark.asyncio
    @patch("app.storage.smb.smbclient.rename")
    async def test_rename_file_uses_prefix(self, mock_rename):
        """rename_item with path_prefix targets the correct prefixed path."""
        backend = SMBBackend(
            host="server.local",
            share_name="share",
            username="user",
            password="pass",
            path_prefix="/photos",
        )

        await backend.rename_item("vacation/img.jpg", "beach.jpg")

        mock_rename.assert_called_once_with(
            r"\\server.local\share\photos\vacation\img.jpg",
            r"\\server.local\share\photos\vacation\beach.jpg",
            **SMB_AUTH_KWARGS,
        )
