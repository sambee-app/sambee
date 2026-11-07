"""
Tests for the directory search API endpoint.

Tests the GET /{connection_id}/directories endpoint and the
_update_directory_cache_from_listing helper function.
"""

import asyncio
import os
import sqlite3
import statistics
import threading
import time
import uuid
from dataclasses import replace
from math import ceil
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.core.directory_index_contract import CONTRACT_VERSION
from app.models.connection import Connection, ConnectionScope
from app.models.file import DirectoryListing, DirectorySearchResult, FileInfo, FileType
from app.services.directory_cache import CacheState, ConnectionDirectoryCache, SQLiteConnectionDirectoryCache
from app.services.directory_index import MAX_QUERY_BYTES, MAX_QUERY_TERMS

WORKER_TIMEOUT_SECONDS = 5
HTTP_MEASUREMENT_ROWS = 100_000
HTTP_MEASUREMENT_SAMPLES = 30

# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture(name="mock_cache")
def mock_cache_fixture(tmp_path, monkeypatch):
    """Create a pre-populated mock-friendly cache for testing."""

    monkeypatch.setattr("app.services.directory_cache.settings.directory_cache_location", str(tmp_path / "cache"))
    cache = SQLiteConnectionDirectoryCache(
        connection_id="test",
        host="host",
        share_name="share",
        username="user",
        password="pass",
    )
    cache.index.open()
    cache._opened.set()
    cache.index.write_paths(
        [
            "documents",
            "documents/work",
            "documents/personal",
            "photos",
            "photos/vacation",
        ]
    )
    cache.index.finish_generation(1)
    cache._directory_count = cache.index.status().directory_count
    cache._source_available.set()
    cache._state = CacheState.READY
    yield cache
    cache.stop()


@pytest.fixture(name="mock_cache_manager")
def mock_cache_manager_fixture(mock_cache: ConnectionDirectoryCache):
    """Patch the global directory cache manager to return mock_cache."""

    manager = MagicMock()
    manager.get_or_create_cache = AsyncMock(return_value=mock_cache)
    manager.get_cache.return_value = mock_cache

    with patch("app.services.directory_cache.get_directory_cache_manager", return_value=manager):
        yield manager


# ============================================================================
# Search directories endpoint
# ============================================================================


@pytest.mark.skipif(
    os.environ.get("DIRECTORY_INDEX_HTTP_MEASUREMENT") != "1",
    reason="Explicit HTTP latency measurement; not part of routine tests.",
)
def test_directory_search_http_latency_measurement(client, mock_cache_manager, auth_headers_user, test_connection, mock_cache):
    """Measure the real HTTP boundary separately from long source scans."""
    import json

    count = int(os.environ.get("DIRECTORY_INDEX_HTTP_MEASURE_COUNT", str(HTTP_MEASUREMENT_ROWS)))
    assert count > 0
    index = mock_cache.index
    generation = index.prepare_scan()[0]
    index.write_paths((f"directory-{number:06d}" for number in range(count)), generation_id=generation)
    assert index.finish_generation(generation)
    mock_cache._directory_count = count
    query = f"{count - 1:06d}"
    samples = []
    for _ in range(HTTP_MEASUREMENT_SAMPLES):
        started = time.perf_counter()
        response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": query})
        samples.append((time.perf_counter() - started) * 1000)
        assert response.status_code == 200, response.json()
        data = response.json()
        assert data["directory_count"] == count
        assert data["total_matches"] == 1
        assert data["results"] == [f"directory-{count - 1:06d}"]
    print(
        "DIRECTORY_INDEX_HTTP_MEASUREMENT "
        + json.dumps(
            {
                "rows": count,
                "samples": len(samples),
                "p50_ms": statistics.median(samples),
                "p95_ms": sorted(samples)[ceil(len(samples) * 95 / 100) - 1],
                "max_ms": max(samples),
                "cache_target_kib_per_connection": mock_cache.policy.page_cache_kib,
                "method": "FastAPI TestClient with authentication and seeded SQLite; excludes source build time",
            },
            sort_keys=True,
        ),
        flush=True,
    )


@pytest.mark.integration
class TestSearchDirectories:
    """Tests for GET /{connection_id}/directories endpoint."""

    def test_legacy_search_does_not_advertise_index_contract(self, client, auth_headers_user, test_connection, mock_cache_manager):
        """Only the SQLite implementation can opt in to compatible quiet refresh."""
        cache = MagicMock(spec=ConnectionDirectoryCache)
        cache.search.return_value = ([], 0)
        cache.state = CacheState.READY
        cache.directory_count = 0
        mock_cache_manager.get_or_create_cache.return_value = cache
        response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": "photos"})
        assert response.status_code == 200
        assert response.json()["search_contract_version"] is None

    @pytest.mark.parametrize(
        "query,expected_status",
        [
            ("a" * MAX_QUERY_BYTES, 200),
            ("\U0001f600" * (MAX_QUERY_BYTES // 4), 200),
            ("\U0001f600" * (MAX_QUERY_BYTES // 4 + 1), 400),
            (" ".join(f"term{number}" for number in range(MAX_QUERY_TERMS)), 200),
            (" ".join(f"term{number}" for number in range(MAX_QUERY_TERMS + 1)), 400),
        ],
        ids=["maximum-ascii-bytes", "maximum-utf8-bytes", "excess-utf8-bytes", "maximum-terms", "excess-terms"],
    )
    def test_search_uses_shared_input_limits(self, client, auth_headers_user, test_connection, mock_cache_manager, query, expected_status):
        """HTTP validation accepts the shared byte range and rejects excess bytes or terms."""
        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": query},
        )
        assert response.status_code == expected_status
        if expected_status == 200:
            assert response.json()["results"] == []
            assert response.json()["directory_count"] == 5
        else:
            assert "Shorten" in response.json()["detail"] or "Remove some terms" in response.json()["detail"]

    def test_search_preserves_exact_metadata_when_output_is_truncated(
        self, client, auth_headers_user, test_connection, mock_cache_manager, mock_cache, monkeypatch
    ):
        """The HTTP serializer must not cap exact counts or lose selected-generation metadata."""
        selected = replace(mock_cache.index.search("photos"), directory_count=100_001, total_matches=100_001)
        monkeypatch.setattr(mock_cache, "search_index", lambda *_args, **_kwargs: selected)
        response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": "photos"})
        assert response.status_code == 200
        data = response.json()
        assert data["directory_count"] == data["total_matches"] == 100_001
        assert data["search_contract_version"] == CONTRACT_VERSION
        assert len(data["results"]) == len(selected.results) < data["total_matches"]
        assert data["accepted_revision"] == selected.accepted_revision
        assert data["coverage"] == selected.coverage
        assert data["last_verified_at_ms"] == selected.last_verified_at_ms
        assert data["matched_term_counts"] == {row.path: row.matched_term_count for row in selected.results}

    def test_search_retains_accepted_rows_and_reports_uncertain_paused_status(
        self, client, auth_headers_user, test_connection, mock_cache_manager, mock_cache
    ):
        """Uncertainty and storage refusal are not empty or newly verified catalogues."""
        selected = mock_cache.index.search("photos")
        mock_cache.index.mark_uncertain()
        mock_cache._disk_budget_error = "Directory indexing is paused. Increase its disk budget and retry."
        response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": "photos"})
        assert response.status_code == 200
        data = response.json()
        assert data["results"] == [row.path for row in selected.results]
        assert data["coverage"] == "uncertain"
        assert data["coverage_issue_count"] == 1
        assert data["status_message"] == mock_cache.scan_error
        assert data["last_verified_at_ms"] == selected.last_verified_at_ms

    @pytest.mark.parametrize("stopped", [False, True], ids=["root-unavailable", "binding-stopped"])
    def test_search_hides_retained_rows_after_source_loss(
        self, client, auth_headers_user, test_connection, mock_cache_manager, mock_cache, stopped
    ):
        """Source loss returns a retryable failure without publishing or deleting retained rows."""
        selected = mock_cache.index.search("photos")
        if stopped:
            mock_cache._stop_event.set()
        else:
            mock_cache._source_probe_completed.set()
            mock_cache._source_available.clear()
        response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": "photos"})
        assert response.status_code == 503
        detail = response.json()["detail"]
        assert "retry" in detail["message"].lower()
        assert detail["code"] == "directory_temporarily_unavailable"
        assert detail["recoverable"] is True
        assert detail["retry_after_ms"] == 5000
        assert response.headers["Retry-After"] == "5"
        assert "results" not in response.json()
        assert mock_cache.index.search("photos") == selected

    def test_search_storage_error_does_not_expose_private_details(
        self, client, auth_headers_user, test_connection, mock_cache_manager, mock_cache, monkeypatch
    ):
        """A failed storage read has no successful result or private error text."""
        private_detail = "private directory, account, and storage identity"

        def failed(*_args, **_kwargs):
            raise sqlite3.DatabaseError(private_detail)

        monkeypatch.setattr(mock_cache.index, "search", failed)
        response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": "photos"})
        assert response.status_code == 500
        assert private_detail not in response.text
        assert "results" not in response.json()
        assert "local index storage" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_cancelled_http_query_signals_the_retained_worker(
        self, session, regular_user, test_connection, mock_cache_manager, mock_cache, monkeypatch
    ):
        """Cancellation reaches the actual worker and cannot return a late success."""
        from app.api.browser import search_directories

        started = threading.Event()
        release = threading.Event()
        exited = threading.Event()
        tokens = []
        successful = []
        original = mock_cache.search_index

        def blocked(*args, cancelled, **kwargs):
            tokens.append(cancelled)
            started.set()
            try:
                if not release.wait(WORKER_TIMEOUT_SECONDS):
                    raise TimeoutError("Test query worker was not released.")
                response = original(*args, cancelled=cancelled, **kwargs)
                successful.append(response)
                return response
            finally:
                exited.set()

        monkeypatch.setattr(mock_cache, "search_index", blocked)
        task = asyncio.create_task(search_directories(test_connection.id, "photos", False, current_user=regular_user, session=session))
        try:
            assert await asyncio.to_thread(started.wait, WORKER_TIMEOUT_SECONDS)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert tokens[0].is_set()
            assert not exited.is_set()
        finally:
            release.set()
            assert await asyncio.to_thread(exited.wait, WORKER_TIMEOUT_SECONDS)
        assert not successful

    def test_search_requires_auth(
        self,
        client: TestClient,
        test_connection: Connection,
    ):
        """Endpoint should require authentication."""

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            params={"q": "test"},
        )
        assert response.status_code == 401

    def test_search_nonexistent_connection(
        self,
        client: TestClient,
        auth_headers_user: dict,
    ):
        """Non-existent connection should return 404."""

        fake_id = uuid.uuid4()
        response = client.get(
            f"/api/browse/{fake_id}/directories",
            headers=auth_headers_user,
            params={"q": "test"},
        )
        assert response.status_code == 404

    def test_search_connection_without_share(
        self,
        client: TestClient,
        auth_headers_user: dict,
        session,
    ):
        """Connection without share_name should return 400."""

        from app.core.security import encrypt_password

        conn = Connection(
            id=uuid.uuid4(),
            name="No Share Connection",
            host="server.local",
            share_name=None,
            username="user",
            password_encrypted=encrypt_password("pass"),
            scope=ConnectionScope.SHARED,
        )
        session.add(conn)
        session.commit()

        response = client.get(
            f"/api/browse/{conn.id}/directories",
            headers=auth_headers_user,
            params={"q": "test"},
        )
        assert response.status_code == 400

    def test_search_with_query(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_cache_manager,
    ):
        """Search with a query should return matching results."""

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": "documents"},
        )

        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert "total_matches" in data
        assert "cache_state" in data
        assert "directory_count" in data
        assert data["search_contract_version"] == CONTRACT_VERSION

        # The mock_cache has 3 directories containing "documents"
        assert data["total_matches"] > 0
        assert all("documents" in r.lower() for r in data["results"])

    @pytest.mark.parametrize(
        ("query", "paths", "expected_ranks"),
        [
            ("  STRASSE  ", ["Stra\u00dfe", "strasse-extra"], {"Stra\u00dfe": 0, "strasse-extra": 1}),
            ("resume", ["R\u00e9sum\u00e9", "resume-extra"], {"R\u00e9sum\u00e9": 0, "resume-extra": 1}),
            (r"Stra\child", ["Stra/child", "Stra/child/nested"], {"Stra/child": 3, "Stra/child/nested": 3}),
        ],
    )
    def test_search_returns_server_match_ranks(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_cache_manager,
        mock_cache: ConnectionDirectoryCache,
        query: str,
        paths: list[str],
        expected_ranks: dict[str, int],
    ):
        """Expose the cache's Unicode-aware ranks for cross-source merging."""
        mock_cache.add_directories(paths)
        mock_cache.coordinator.apply_pending()

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": query},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == paths
        assert data["match_ranks"] == expected_ranks

    def test_search_empty_query(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_cache_manager,
    ):
        """Empty query should return empty results."""

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": ""},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == []
        assert data["match_ranks"] == {}
        assert data["total_matches"] == 0

    def test_search_no_query_param(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_cache_manager,
    ):
        """Missing q parameter should default to empty string."""

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
        )

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == []

    def test_search_no_matches(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_cache_manager,
    ):
        """Query with no matches should return empty results."""

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": "nonexistent_xyz_123"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == []
        assert data["total_matches"] == 0

    def test_search_returns_cache_state(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_cache_manager,
    ):
        """Response should include the current cache state."""

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": "photos"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["cache_state"] == "ready"

    def test_search_returns_directory_count(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_cache_manager,
    ):
        """Response should include total directory count."""

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": "photos"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["directory_count"] == 5  # mock_cache has 5 directories

    def test_search_excludes_dot_directories_by_default(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_cache_manager,
        mock_cache: ConnectionDirectoryCache,
    ):
        """Dot directories should be filtered out unless explicitly enabled."""

        mock_cache.add_directories(
            [
                ".git",
                "projects/.cache",
                "projects/visible-cache",
            ]
        )
        mock_cache.coordinator.apply_pending()

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": "cache"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == ["projects/visible-cache"]
        assert data["total_matches"] == 1

    def test_search_can_include_dot_directories(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_cache_manager,
        mock_cache: ConnectionDirectoryCache,
    ):
        """Dot directories should be returned when explicitly enabled."""

        mock_cache.add_directories(
            [
                ".git",
                "projects/.cache",
                "projects/visible-cache",
            ]
        )
        mock_cache.coordinator.apply_pending()

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": "cache", "include_dot_directories": True},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == ["projects/.cache", "projects/visible-cache"]
        assert data["total_matches"] == 2

    def test_search_triggers_cache_creation(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
        mock_cache_manager,
    ):
        """Search should trigger get_or_create_cache for the connection."""

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": "test"},
        )

        assert response.status_code == 200
        mock_cache_manager.get_or_create_cache.assert_called_once()

        # Verify connection params were passed
        call_kwargs = mock_cache_manager.get_or_create_cache.call_args
        assert call_kwargs.kwargs["connection_id"] == str(test_connection.id)
        assert call_kwargs.kwargs["host"] == test_connection.host
        assert call_kwargs.kwargs["share_name"] == test_connection.share_name
        assert call_kwargs.kwargs["source_revision"] == test_connection.updated_at.isoformat()

    def test_search_admin_user_also_works(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        test_connection: Connection,
        mock_cache_manager,
    ):
        """Admin users should also be able to search directories."""

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_admin,
            params={"q": "photos"},
        )

        assert response.status_code == 200

    def test_search_internal_error_returns_500(
        self,
        client: TestClient,
        auth_headers_user: dict,
        test_connection: Connection,
    ):
        """Internal errors should return 500."""

        manager = MagicMock()
        manager.get_or_create_cache = AsyncMock(side_effect=RuntimeError("Connection failed"))

        with patch("app.services.directory_cache.get_directory_cache_manager", return_value=manager):
            response = client.get(
                f"/api/browse/{test_connection.id}/directories",
                headers=auth_headers_user,
                params={"q": "test"},
            )

        assert response.status_code == 500


# ============================================================================
# DirectorySearchResult model
# ============================================================================


@pytest.mark.unit
class TestDirectorySearchResultModel:
    """Tests for the DirectorySearchResult Pydantic model."""

    def test_model_creation(self):
        """Creating a DirectorySearchResult should work."""

        result = DirectorySearchResult(
            results=["dir1", "dir2"],
            total_matches=2,
            cache_state="ready",
            directory_count=100,
        )
        assert result.results == ["dir1", "dir2"]
        assert result.total_matches == 2
        assert result.cache_state == "ready"
        assert result.directory_count == 100

    def test_model_empty_results(self):
        """Model should accept empty results."""

        result = DirectorySearchResult(
            results=[],
            total_matches=0,
            cache_state="empty",
            directory_count=0,
        )
        assert result.results == []
        assert result.total_matches == 0

    def test_model_serialization(self):
        """Model should serialize to dict correctly."""

        result = DirectorySearchResult(
            results=["a/b", "c/d"],
            total_matches=2,
            cache_state="building",
            directory_count=50,
        )
        data = result.model_dump()
        assert data["results"] == ["a/b", "c/d"]
        assert data["cache_state"] == "building"

    def test_model_all_cache_states(self):
        """Model should accept all valid cache states."""

        for state_value in ["empty", "opening", "building", "ready", "updating"]:
            result = DirectorySearchResult(
                results=[],
                total_matches=0,
                cache_state=state_value,
                directory_count=0,
            )
            assert result.cache_state == state_value


# ============================================================================
# _update_directory_cache_from_listing helper
# ============================================================================


@pytest.mark.unit
class TestUpdateDirectoryCacheFromListing:
    """Tests for the _update_directory_cache_from_listing helper function."""

    def test_feeds_directories_to_cache(self):
        """Should add directory paths from listing to the cache."""

        from app.api.browser import _update_directory_cache_from_listing

        cache = MagicMock(spec=ConnectionDirectoryCache)

        listing = DirectoryListing(
            path="/parent",
            items=[
                FileInfo(
                    name="subdir",
                    path="/parent/subdir",
                    type=FileType.DIRECTORY,
                    size=None,
                    modified_at=None,
                ),
                FileInfo(
                    name="file.txt",
                    path="/parent/file.txt",
                    type=FileType.FILE,
                    size=100,
                    modified_at=None,
                ),
                FileInfo(
                    name="another_dir",
                    path="/parent/another_dir",
                    type=FileType.DIRECTORY,
                    size=None,
                    modified_at=None,
                ),
            ],
            total=3,
        )

        manager = MagicMock()
        manager.get_cache.return_value = cache

        with patch(
            "app.services.directory_cache.get_directory_cache_manager",
            return_value=manager,
        ):
            _update_directory_cache_from_listing("conn-1", listing)

        # Should have added the 2 directories (not the file)
        cache.add_directories.assert_called_once_with(["/parent/subdir", "/parent/another_dir"])

    def test_skips_when_no_cache_exists(self):
        """Should do nothing if no cache exists for connection."""

        from app.api.browser import _update_directory_cache_from_listing

        manager = MagicMock()
        manager.get_cache.return_value = None

        listing = DirectoryListing(
            path="/",
            items=[
                FileInfo(
                    name="dir",
                    path="/dir",
                    type=FileType.DIRECTORY,
                    size=None,
                    modified_at=None,
                ),
            ],
            total=1,
        )

        with patch(
            "app.services.directory_cache.get_directory_cache_manager",
            return_value=manager,
        ):
            # Should not raise
            _update_directory_cache_from_listing("unknown", listing)

    def test_skips_files_only_adds_directories(self):
        """Should only add items of type DIRECTORY, ignoring files."""

        from app.api.browser import _update_directory_cache_from_listing

        cache = MagicMock(spec=ConnectionDirectoryCache)

        listing = DirectoryListing(
            path="/",
            items=[
                FileInfo(
                    name="file1.txt",
                    path="/file1.txt",
                    type=FileType.FILE,
                    size=100,
                    modified_at=None,
                ),
                FileInfo(
                    name="file2.txt",
                    path="/file2.txt",
                    type=FileType.FILE,
                    size=200,
                    modified_at=None,
                ),
            ],
            total=2,
        )

        manager = MagicMock()
        manager.get_cache.return_value = cache

        with patch(
            "app.services.directory_cache.get_directory_cache_manager",
            return_value=manager,
        ):
            _update_directory_cache_from_listing("conn-1", listing)

        cache.add_directories.assert_not_called()

    def test_does_not_crash_on_exception(self):
        """Should silently handle any exceptions."""

        from app.api.browser import _update_directory_cache_from_listing

        listing = DirectoryListing(path="/", items=[], total=0)

        with patch(
            "app.services.directory_cache.get_directory_cache_manager",
            side_effect=RuntimeError("broken"),
        ):
            # Should not raise
            _update_directory_cache_from_listing("conn-1", listing)

    def test_empty_listing_is_noop(self):
        """Empty listing should not add anything."""

        from app.api.browser import _update_directory_cache_from_listing

        cache = MagicMock(spec=ConnectionDirectoryCache)

        listing = DirectoryListing(path="/", items=[], total=0)

        manager = MagicMock()
        manager.get_cache.return_value = cache

        with patch(
            "app.services.directory_cache.get_directory_cache_manager",
            return_value=manager,
        ):
            _update_directory_cache_from_listing("conn-1", listing)

        cache.add_directories.assert_not_called()
