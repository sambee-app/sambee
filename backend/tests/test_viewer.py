"""
Tests for the viewer API endpoints.

This module tests file viewing and download functionality including:
- File viewing with various MIME types
- File download with proper headers
- Authentication and authorization
- Error handling for various edge cases
- Connection validation
"""

from datetime import datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import Response

from app.api._smb_helpers import prepare_file_streamer
from app.models.file import FileInfo, FileType
from app.services.pdf_inspector import PDFScreenAnalysis
from app.services.pdf_normalizer import PDFNormalizationError


class AsyncIteratorMock:
    """Helper class to mock async iterators for file streaming."""

    def __init__(self, items):
        self.items = items
        self.index = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self.index >= len(self.items):
            raise StopAsyncIteration
        item = self.items[self.index]
        self.index += 1
        return item


@pytest.fixture
def mock_text_file():
    """Create a mock text file info."""
    return FileInfo(
        name="document.txt",
        path="/document.txt",
        type=FileType.FILE,
        size=1024,
        modified_at=datetime(2024, 1, 1, 12, 0, 0),
        mime_type="text/plain",
    )


@pytest.fixture
def mock_markdown_file():
    """Create a mock markdown file info."""
    return FileInfo(
        name="README.md",
        path="/README.md",
        type=FileType.FILE,
        size=512,
        modified_at=datetime(2024, 1, 1, 12, 0, 0),
        mime_type="text/markdown",
    )


@pytest.fixture
def mock_binary_file():
    """Create a mock binary file info (image)."""
    return FileInfo(
        name="image.png",
        path="/images/image.png",
        type=FileType.FILE,
        size=51200,  # 50KB
        modified_at=datetime(2024, 1, 1, 12, 0, 0),
        mime_type="image/png",
    )


@pytest.fixture
def mock_pdf_file():
    """Create a PDF file info for original-viewer streaming tests."""
    return FileInfo(
        name="document.pdf",
        path="/document.pdf",
        type=FileType.FILE,
        size=31,
        modified_at=datetime(2024, 1, 1, 12, 0, 0),
        mime_type="application/pdf",
    )


@pytest.fixture
def mock_directory():
    """Create a mock directory info."""
    return FileInfo(
        name="folder",
        path="/folder",
        type=FileType.DIRECTORY,
        size=None,
        modified_at=datetime(2024, 1, 1, 12, 0, 0),
        mime_type=None,
    )


@pytest.fixture
def mock_smb_viewer_backend(mock_text_file):
    """Create a mock SMB backend for viewer tests."""
    with patch("app.api.viewer.SMBBackend") as mock:
        backend_instance = AsyncMock()

        # Mock file info retrieval
        backend_instance.get_file_info.return_value = mock_text_file

        # Mock file reading - use a plain function (not AsyncMock)
        # because AsyncMock wraps the result in a coroutine
        content = b"Hello, this is test file content!\n" * 30
        chunks = [content[i : i + 8192] for i in range(0, len(content), 8192)]

        def mock_read_file(path, **kwargs):
            return AsyncIteratorMock(chunks)

        backend_instance.read_file = mock_read_file

        backend_instance.connect.return_value = None
        backend_instance.disconnect.return_value = None

        mock.return_value = backend_instance
        yield mock, backend_instance


class TestViewerFile:
    """Test cases for the file viewer endpoint."""

    @pytest.mark.asyncio
    async def test_prepared_stream_closes_after_a_late_read_failure(self):
        """After the first chunk, a failure terminates the stream rather than replacing headers."""
        backend = AsyncMock()

        async def late_failure(_path):
            yield b"first chunk"
            raise FileNotFoundError("private storage detail")

        backend.read_file = late_failure
        stream = await prepare_file_streamer(backend, "document.txt")
        assert await anext(stream) == b"first chunk"
        with pytest.raises(FileNotFoundError):
            await anext(stream)
        backend.disconnect.assert_awaited_once()

    @pytest.mark.parametrize(
        "error,status_code,code",
        [
            (FileNotFoundError("private path"), 404, "item_not_found"),
            (PermissionError("private path"), 403, "file_access_denied"),
            (TimeoutError("private path"), 504, "file_timeout"),
        ],
    )
    def test_read_failure_after_metadata_is_structured(self, client, auth_headers_user, test_connection, error, status_code, code):
        async def failed_read(_path):
            raise error
            yield b""

        with patch("app.api.viewer.SMBBackend") as backend_class:
            backend = backend_class.return_value
            backend.connect = AsyncMock()
            backend.disconnect = AsyncMock()
            backend.get_file_info = AsyncMock(
                return_value=FileInfo(name="document.txt", path="document.txt", type=FileType.FILE, mime_type="text/plain")
            )
            backend.read_file = failed_read
            response = client.get(f"/api/viewer/{test_connection.id}/file", headers=auth_headers_user, params={"path": "document.txt"})
        assert response.status_code == status_code
        assert response.json()["detail"]["code"] == code
        assert "private path" not in response.text
        backend.disconnect.assert_awaited_once()

    def test_view_text_file_success(self, client, auth_headers_user, test_connection, mock_smb_viewer_backend):
        """Test successful text file viewer."""
        mock, mock_instance = mock_smb_viewer_backend

        response = client.get(
            f"/api/viewer/{test_connection.id}/file",
            headers=auth_headers_user,
            params={"path": "/document.txt"},
        )

        assert response.status_code == 200
        assert response.headers["content-type"] == "text/plain; charset=utf-8"

        # Verify content
        content = response.content
        assert b"Hello, this is test file content!" in content

        # Verify SMB backend was called correctly
        mock_instance.connect.assert_called_once()
        mock_instance.get_file_info.assert_called_once_with("/document.txt")
        # Note: read_file is a lambda function, so we can't assert on it

    def test_view_markdown_file(self, client, auth_headers_user, test_connection, mock_markdown_file):
        """Test viewing a markdown file with correct MIME type."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_markdown_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([b"# Markdown Content\n\nThis is **bold** text."])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/README.md"},
            )

            assert response.status_code == 200
            assert response.headers["content-type"] == "text/markdown; charset=utf-8"
            assert b"# Markdown Content" in response.content

    def test_view_binary_file(self, client, auth_headers_user, test_connection, mock_binary_file):
        """Test viewing a binary file (image)."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_binary_file
            # Simulate PNG header
            png_data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([png_data])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/images/image.png"},
            )

            assert response.status_code == 200
            assert response.headers["content-type"] == "image/png"
            assert response.content.startswith(b"\x89PNG")

    def test_view_pdf_streams_original_bytes(self, client, auth_headers_user, test_connection, mock_pdf_file):
        """PDF viewing must not rewrite the original before compatibility fallback."""
        pdf_bytes = b"%PDF-1.4\noriginal PDF bytes\n%%EOF"

        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_pdf_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([pdf_bytes])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/document.pdf"},
            )

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        assert response.content == pdf_bytes

    def test_view_pdf_normalized_variant_returns_explicit_derivative(self, client, auth_headers_user, test_connection, mock_pdf_file):
        """A normalized variant is opt-in and identifies its derivative response."""
        source_bytes = b"%PDF-1.4\nsource PDF bytes\n%%EOF"
        derivative_bytes = b"%PDF-1.4\nnormalized PDF bytes\n%%EOF"

        with (
            patch("app.api.viewer.SMBBackend") as mock_backend,
            patch("app.api.viewer.pdf_derivative_cache.get_or_create", return_value=(derivative_bytes, False)) as cache_get_or_create,
        ):
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_pdf_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([source_bytes])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock_backend.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/document.pdf", "pdf_variant": "normalized"},
            )

        assert response.status_code == 200
        assert response.content == derivative_bytes
        assert response.headers["x-pdf-variant"] == "normalized"
        assert response.headers["x-pdf-derivative-cache"] == "miss"
        cache_get_or_create.assert_called_once()

    def test_view_pdf_normalized_cache_hit_does_not_read_source(self, client, auth_headers_user, test_connection, mock_pdf_file):
        """A cache hit must avoid a costly SMB content read."""
        derivative_bytes = b"%PDF-1.4\ncached PDF bytes\n%%EOF"

        with (
            patch("app.api.viewer.SMBBackend") as mock_backend,
            patch("app.api.viewer.pdf_derivative_cache.get", return_value=derivative_bytes) as cache_get,
        ):
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_pdf_file
            backend_instance.read_file = lambda path, **kwargs: (_ for _ in ()).throw(AssertionError("source must not be read"))
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock_backend.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/document.pdf", "pdf_variant": "normalized"},
            )

        assert response.status_code == 200
        assert response.content == derivative_bytes
        assert response.headers["x-pdf-derivative-cache"] == "hit"
        cache_get.assert_called_once()

    def test_view_pdf_selects_screen_derivative_when_enabled_and_oversized(self, client, auth_headers_user, test_connection, mock_pdf_file):
        source_bytes = b"%PDF-1.4\nsource PDF bytes\n%%EOF"
        derivative_bytes = b"%PDF-1.4\nnormalized PDF bytes\n%%EOF"
        from app.api.viewer import get_integer_setting_value as actual_setting_value
        from app.core.system_setting_definitions import SystemSettingKey

        def setting_value(key):
            if key == SystemSettingKey.PDF_SCREEN_DERIVATIVE_ENABLED:
                return 1
            return actual_setting_value(key)

        with (
            patch("app.api.viewer.SMBBackend") as mock_backend,
            patch("app.api.viewer.get_integer_setting_value", side_effect=setting_value),
            patch("app.api.viewer.pdf_derivative_cache.get", return_value=None),
            patch("app.api.viewer.pdf_derivative_cache.get_or_create", return_value=(derivative_bytes, False)) as cache_get_or_create,
            patch(
                "app.api.viewer.analyze_pdf_for_screen",
                return_value=PDFScreenAnalysis(True, 100_000_000, 10_000_000, 600),
            ),
        ):
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_pdf_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([source_bytes])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock_backend.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/document.pdf", "pdf_variant": "normalized", "screen_width": 5120, "screen_height": 2880},
            )

        assert response.status_code == 200
        assert response.headers["x-pdf-variant"] == "screen-5120x2880-z200"
        assert cache_get_or_create.call_args.kwargs["variant"] == "screen-5120x2880-z200"

    def test_view_pdf_normalizer_error_returns_unprocessable_content(self, client, auth_headers_user, test_connection, mock_pdf_file):
        source_bytes = b"%PDF-1.4\nsource PDF bytes\n%%EOF"

        with (
            patch("app.api.viewer.SMBBackend") as mock_backend,
            patch("app.api.viewer.pdf_derivative_cache.get", return_value=None),
            patch(
                "app.api.viewer.pdf_derivative_cache.get_or_create",
                side_effect=PDFNormalizationError("normalizer failed", code="normalizer-failed"),
            ),
        ):
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_pdf_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([source_bytes])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock_backend.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/document.pdf", "pdf_variant": "normalized"},
            )

        assert response.status_code == 422
        assert response.json()["detail"] == "PDF compatibility processing could not make this file viewable."

    def test_view_pdf_screen_policy_does_not_reuse_normalized_cache_for_oversized_document(
        self, client, auth_headers_user, test_connection, mock_pdf_file
    ):
        """An oversized PDF must select screen even if a normalized cache entry exists."""
        source_bytes = b"%PDF-1.4\nsource PDF bytes\n%%EOF"
        derivative_bytes = b"%PDF-1.4\nscreen PDF bytes\n%%EOF"
        from app.api.viewer import get_integer_setting_value as actual_setting_value
        from app.core.system_setting_definitions import SystemSettingKey

        def setting_value(key):
            if key == SystemSettingKey.PDF_SCREEN_DERIVATIVE_ENABLED:
                return 1
            return actual_setting_value(key)

        def cached_derivative(*, variant, **_kwargs):
            return None if variant.startswith("screen-") else b"%PDF-1.4\nnormalized cache\n%%EOF"

        with (
            patch("app.api.viewer.SMBBackend") as mock_backend,
            patch("app.api.viewer.get_integer_setting_value", side_effect=setting_value),
            patch("app.api.viewer.pdf_derivative_cache.get", side_effect=cached_derivative) as cache_get,
            patch("app.api.viewer.pdf_derivative_cache.get_or_create", return_value=(derivative_bytes, False)) as cache_get_or_create,
            patch(
                "app.api.viewer.analyze_pdf_for_screen",
                return_value=PDFScreenAnalysis(True, 100_000_000, 10_000_000, 600),
            ),
        ):
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_pdf_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([source_bytes])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock_backend.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/document.pdf", "pdf_variant": "normalized", "screen_width": 5120, "screen_height": 2880},
            )

        assert response.status_code == 200
        assert response.headers["x-pdf-variant"] == "screen-5120x2880-z200"
        assert cache_get.call_args.kwargs["variant"] == "screen-5120x2880-z200"
        assert cache_get_or_create.call_args.kwargs["variant"] == "screen-5120x2880-z200"

    def test_view_file_without_auth(self, client, test_connection):
        """Test that viewing requires authentication."""
        response = client.get(
            f"/api/viewer/{test_connection.id}/file",
            params={"path": "/document.txt"},
        )

        assert response.status_code == 401

    def test_view_nonexistent_connection(self, client, auth_headers_user):
        """Test view with non-existent connection ID."""
        import uuid

        fake_id = uuid.uuid4()

        response = client.get(
            f"/api/viewer/{fake_id}/file",
            headers=auth_headers_user,
            params={"path": "/document.txt"},
        )

        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()

    def test_view_connection_without_share(self, client, auth_headers_user, session):
        """Test view when connection doesn't have a share name."""
        from app.models.connection import Connection, ConnectionScope

        # Create connection without share - use correct Connection model fields
        connection = Connection(
            name="No Share Connection",
            host="192.168.1.100",
            share_name=None,  # No share
            username="testuser",
            password_encrypted="encrypted_password",
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        response = client.get(
            f"/api/viewer/{connection.id}/file",
            headers=auth_headers_user,
            params={"path": "/document.txt"},
        )

        assert response.status_code == 400
        assert "share" in response.json()["detail"].lower()

    def test_view_directory_instead_of_file(self, client, auth_headers_user, test_connection, mock_directory):
        """Test attempting to view a directory."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_directory
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([b""])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/folder"},
            )

            assert response.status_code == 409
            assert response.json()["detail"]["code"] == "not_a_file"

    def test_view_file_with_special_chars_in_name(self, client, auth_headers_user, test_connection):
        """Test viewing a file with a Unicode filename."""
        special_file = FileInfo(
            name="TSTATS_ collection, search, retention, and audit — App Dev Best Practices.pdf",
            path="/folder/TSTATS_ collection, search, retention, and audit — App Dev Best Practices.pdf",
            type=FileType.FILE,
            size=100,
            modified_at=datetime(2024, 1, 1, 12, 0, 0),
            mime_type="application/pdf",
        )

        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = special_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([b"content"])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": special_file.path},
            )

            assert response.status_code == 200
            assert response.headers["content-type"] == "application/pdf"
            assert response.headers["content-disposition"] == (
                "inline; filename*=UTF-8''TSTATS_%20collection%2C%20search%2C%20retention%2C%20and%20audit%20"
                "%E2%80%94%20App%20Dev%20Best%20Practices.pdf"
            )

    @pytest.mark.parametrize("mime_type,filename", [("text/html", "unsafe.html"), ("image/svg+xml", "unsafe.svg")])
    def test_active_document_is_downloaded(self, client, auth_headers_user, test_connection, mime_type, filename):
        active_file = FileInfo(name=filename, path=f"/{filename}", type=FileType.FILE, size=4, mime_type=mime_type)
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = active_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([b"test"])
            mock.return_value = backend_instance

            response = client.get(f"/api/viewer/{test_connection.id}/file", headers=auth_headers_user, params={"path": active_file.path})

        assert response.status_code == 200
        assert response.headers["content-disposition"].startswith("attachment;")
        assert response.headers["x-content-type-options"] == "nosniff"

    def test_content_disposition_encodes_unicode_and_control_characters(self):
        """Filename encoding must stay ASCII-only and prevent header injection."""
        from app.utils.content_disposition import build_content_disposition

        header = build_content_disposition("attachment", "report — final\r\nX-Injected: value.pdf")

        assert header == "attachment; filename*=UTF-8''report%20%E2%80%94%20final%0D%0AX-Injected%3A%20value.pdf"
        assert "\r" not in header
        assert "\n" not in header
        header.encode("latin-1")

    def test_view_smb_connection_failure(self, client, auth_headers_user, test_connection):
        """Test handling of SMB connection failures."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.connect.side_effect = Exception("Connection failed")
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/document.txt"},
            )

            assert response.status_code == 503
            assert response.json()["detail"]["code"] == "file_unavailable"

    def test_view_file_not_found_on_smb(self, client, auth_headers_user, test_connection):
        """Test handling when file doesn't exist on SMB share."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.connect.return_value = None
            backend_instance.get_file_info.side_effect = FileNotFoundError("File not found")
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/nonexistent.txt"},
            )

            assert response.status_code == 404

    def test_view_file_info_timeout_returns_gateway_timeout(self, client, auth_headers_user, test_connection):
        """Timeouts while loading viewer metadata should surface as 504."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.connect.return_value = None
            backend_instance.get_file_info.side_effect = TimeoutError("SMB operation timed out during get_file_info")
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/slow.txt"},
            )

            assert response.status_code == 504
            assert response.json()["detail"]["code"] == "file_timeout"
            backend_instance.disconnect.assert_called_once()


class TestDownloadFile:
    """Test cases for the file download endpoint."""

    @pytest.mark.parametrize("mode", ["normalized_pdf", "native_download"])
    def test_preparation_read_failure_is_safe(self, client, auth_headers_user, test_connection, mock_pdf_file, mode):
        """A source failure before headers returns a safe structured error."""

        async def failed_read(_path):
            if mode == "normalized_pdf":
                yield b"%PDF-1.4"
            raise FileNotFoundError("private storage detail")

        with (
            patch("app.api.viewer.SMBBackend") as backend_class,
            patch("app.api.viewer.is_pdf_normalization_available", return_value=True),
            patch("app.api.viewer.pdf_derivative_cache.get", return_value=None),
        ):
            backend = backend_class.return_value = AsyncMock()
            backend.get_file_info.return_value = mock_pdf_file
            backend.read_file = failed_read
            if mode == "native_download":
                issued = client.post(
                    "/api/viewer/download-intents",
                    headers=auth_headers_user,
                    json={"connection_id": str(test_connection.id), "path": "document.pdf"},
                )
                assert issued.status_code == 200
                response = client.get(issued.json()["url"])
            else:
                response = client.get(
                    f"/api/viewer/{test_connection.id}/file",
                    headers=auth_headers_user,
                    params={"path": "document.pdf", "pdf_variant": "normalized"},
                )
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "item_not_found"
        assert "private storage detail" not in response.text
        backend.disconnect.assert_awaited()

    def test_browser_download_intent_streams_once(self, client, auth_headers_user, test_connection, mock_text_file):
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_text_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([b"first", b"second"])
            mock.return_value = backend_instance

            issued = client.post(
                "/api/viewer/download-intents",
                headers=auth_headers_user,
                json={"connection_id": str(test_connection.id), "path": "/document.txt"},
            )
            assert issued.status_code == 200
            url = issued.json()["url"]
            assert "/document.txt" not in url
            assert client.get(url).content == b"firstsecond"
            assert client.get(url).status_code == 404

    def test_large_file_intent_does_not_read_or_limit_file_bytes(self, client, auth_headers_user, test_connection, mock_text_file):
        with patch("app.api.viewer.SMBBackend") as backend_mock:
            backend = AsyncMock()
            backend.get_file_info.return_value = mock_text_file.model_copy(update={"size": 5 * 1024**3})
            backend_mock.return_value = backend

            response = client.post(
                "/api/viewer/download-intents",
                headers=auth_headers_user,
                json={"connection_id": str(test_connection.id), "path": "/large.bin"},
            )
            assert response.status_code == 200
            backend.read_file.assert_not_called()

    def test_browser_archive_member_intent_uses_raw_stream(self, client, auth_headers_user, test_connection, mock_text_file):
        with (
            patch("app.api.viewer.SMBBackend") as backend_mock,
            patch("app.api.viewer.ZipReader") as reader_mock,
            patch("app.api.viewer.stream_archive_member", new_callable=AsyncMock) as stream_mock,
        ):
            backend = AsyncMock()
            backend.get_file_info.return_value = mock_text_file
            backend_mock.return_value = backend
            reader_mock.return_value.validate_member_in_record_order = AsyncMock()
            stream_mock.return_value = Response(content=b"member", headers={"Content-Disposition": "attachment"})

            issued = client.post(
                "/api/viewer/download-intents",
                headers=auth_headers_user,
                json={"connection_id": str(test_connection.id), "path": "archive.zip", "member_path": "inner/member.txt"},
            )
            assert issued.status_code == 200
            reader_mock.return_value.validate_member_in_record_order.assert_awaited_once_with("inner/member.txt")
            response = client.get(issued.json()["url"])
            assert response.status_code == 200
            assert response.content == b"member"
            assert stream_mock.await_args.args[:6] == (test_connection.id, "archive.zip", "inner/member.txt", True, "raw", "original")

    def test_download_file_success(self, client, auth_headers_user, test_connection, mock_text_file):
        """Test successful file download."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_text_file
            content = b"Download content"
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([content])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/download",
                headers=auth_headers_user,
                params={"path": "/document.txt"},
            )

            assert response.status_code == 200
            assert response.headers["content-disposition"] == "attachment; filename*=UTF-8''document.txt"
            assert response.headers["content-type"] == "application/octet-stream"
            assert response.content == content

    def test_download_binary_file(self, client, auth_headers_user, test_connection, mock_binary_file):
        """Test downloading a binary file."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_binary_file
            png_data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([png_data])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/download",
                headers=auth_headers_user,
                params={"path": "/images/image.png"},
            )

            assert response.status_code == 200
            assert response.headers["content-disposition"] == "attachment; filename*=UTF-8''image.png"
            assert response.content == png_data

    def test_download_large_file_chunks(self, client, auth_headers_user, test_connection):
        """Test downloading a large file that comes in multiple chunks."""
        large_file = FileInfo(
            name="large.bin",
            path="/large.bin",
            type=FileType.FILE,
            size=1024 * 1024,  # 1MB
            modified_at=datetime(2024, 1, 1, 12, 0, 0),
            mime_type="application/octet-stream",
        )

        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = large_file
            # Simulate large file in chunks
            chunk_size = 8192
            chunks = [b"X" * chunk_size for _ in range(10)]
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock(chunks)
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/download",
                headers=auth_headers_user,
                params={"path": "/large.bin"},
            )

            assert response.status_code == 200
            assert len(response.content) == chunk_size * 10

    def test_download_without_auth(self, client, test_connection):
        """Test that download requires authentication."""
        response = client.get(
            f"/api/viewer/{test_connection.id}/download",
            params={"path": "/document.txt"},
        )

        assert response.status_code == 401

    def test_download_directory_instead_of_file(self, client, auth_headers_user, test_connection, mock_directory):
        """Test attempting to download a directory."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_directory
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/download",
                headers=auth_headers_user,
                params={"path": "/folder"},
            )

            assert response.status_code == 409
            assert response.json()["detail"]["code"] == "not_a_file"

    def test_download_nonexistent_connection(self, client, auth_headers_user):
        """Test download with non-existent connection ID."""
        import uuid

        fake_id = uuid.uuid4()

        response = client.get(
            f"/api/viewer/{fake_id}/download",
            headers=auth_headers_user,
            params={"path": "/document.txt"},
        )

        assert response.status_code == 404

    def test_download_file_without_size(self, client, auth_headers_user, test_connection):
        """Test downloading a file without size information."""
        file_no_size = FileInfo(
            name="nosize.txt",
            path="/nosize.txt",
            type=FileType.FILE,
            size=None,
            modified_at=datetime(2024, 1, 1, 12, 0, 0),
            mime_type="text/plain",
        )

        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = file_no_size
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([b"content"])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/download",
                headers=auth_headers_user,
                params={"path": "/nosize.txt"},
            )

            assert response.status_code == 200
            # Content-Length header should not be set
            assert "content-length" not in response.headers

    def test_download_file_info_timeout_returns_gateway_timeout(self, client, auth_headers_user, test_connection):
        """Timeouts while loading download metadata should surface as 504."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.connect.return_value = None
            backend_instance.get_file_info.side_effect = TimeoutError("SMB operation timed out during get_file_info")
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/download",
                headers=auth_headers_user,
                params={"path": "/slow.txt"},
            )

            assert response.status_code == 504
            assert response.json()["detail"]["code"] == "file_timeout"
            backend_instance.disconnect.assert_called_once()


class TestViewerAuthentication:
    """Test authentication and authorization for viewer endpoints."""

    def test_view_with_valid_token(self, client, auth_headers_user, test_connection, mock_text_file):
        """Test view with a valid user token."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_text_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([b"content"])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/document.txt"},
            )

            assert response.status_code == 200

    def test_view_with_invalid_token(self, client, test_connection):
        """Test view with an invalid token."""
        response = client.get(
            f"/api/viewer/{test_connection.id}/file",
            headers={"Authorization": "Bearer invalid_token"},
            params={"path": "/document.txt"},
        )

        assert response.status_code == 401

    def test_view_with_admin_token(self, client, auth_headers_admin, test_connection, mock_text_file):
        """Test that admin users can view files."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_text_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([b"content"])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_admin,
                params={"path": "/document.txt"},
            )

            assert response.status_code == 200

    def test_download_with_valid_token(self, client, auth_headers_user, test_connection, mock_text_file):
        """Test download with a valid user token."""
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = mock_text_file
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([b"content"])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/download",
                headers=auth_headers_user,
                params={"path": "/document.txt"},
            )

            assert response.status_code == 200


class TestValidateConnection:
    """Test the validate_connection helper function."""

    def test_validate_connection_with_share_name(self, client, auth_headers_user, test_connection):
        """Test that connections with share names are valid."""
        # This is implicitly tested by other tests, but we verify behavior
        with patch("app.api.viewer.SMBBackend") as mock:
            backend_instance = AsyncMock()
            backend_instance.get_file_info.return_value = FileInfo(
                name="test.txt",
                path="/test.txt",
                type=FileType.FILE,
                size=100,
                modified_at=datetime(2024, 1, 1, 12, 0, 0),
                mime_type="text/plain",
            )
            backend_instance.read_file = lambda path, **kwargs: AsyncIteratorMock([b"content"])
            backend_instance.connect.return_value = None
            backend_instance.disconnect.return_value = None
            mock.return_value = backend_instance

            response = client.get(
                f"/api/viewer/{test_connection.id}/file",
                headers=auth_headers_user,
                params={"path": "/test.txt"},
            )

            assert response.status_code == 200

    def test_validate_connection_without_share_name(self, client, auth_headers_user, session):
        """Test that connections without share names return 400."""
        from app.models.connection import Connection, ConnectionScope

        connection = Connection(
            name="No Share",
            host="server.local",
            share_name=None,
            username="user",
            password_encrypted="pass",
            scope=ConnectionScope.SHARED,
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        response = client.get(
            f"/api/viewer/{connection.id}/file",
            headers=auth_headers_user,
            params={"path": "/test.txt"},
        )

        assert response.status_code == 400
        assert "share" in response.json()["detail"].lower()
