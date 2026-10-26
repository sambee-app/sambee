"""
Tests for the directory search API endpoint.

Tests the GET /{connection_id}/directories endpoint and the
_update_directory_cache_from_listing helper function.
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.models.connection import Connection, ConnectionScope
from app.models.file import DirectoryListing, DirectorySearchResult, FileInfo, FileType
from app.services.directory_cache import CacheState, ConnectionDirectoryCache

# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture(name="mock_cache")
def mock_cache_fixture() -> ConnectionDirectoryCache:
    """Create a pre-populated mock-friendly cache for testing."""

    cache = ConnectionDirectoryCache(
        connection_id="test",
        host="host",
        share_name="share",
        username="user",
        password="pass",
    )
    cache.add_directories(
        [
            "documents",
            "documents/work",
            "documents/personal",
            "photos",
            "photos/vacation",
        ]
    )
    cache._state = CacheState.READY
    return cache


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


@pytest.mark.integration
class TestSearchDirectories:
    """Tests for GET /{connection_id}/directories endpoint."""

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

        response = client.get(
            f"/api/browse/{test_connection.id}/directories",
            headers=auth_headers_user,
            params={"q": "cache", "include_dot_directories": True},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == ["projects/visible-cache", "projects/.cache"]
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

        for state_value in ["empty", "building", "ready", "updating"]:
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

        cache = ConnectionDirectoryCache(
            connection_id="conn-1",
            host="h",
            share_name="s",
            username="u",
            password="p",
        )

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
        assert cache.directory_count == 2

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

        cache = ConnectionDirectoryCache(
            connection_id="conn-1",
            host="h",
            share_name="s",
            username="u",
            password="p",
        )

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

        assert cache.directory_count == 0

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

        cache = ConnectionDirectoryCache(
            connection_id="conn-1",
            host="h",
            share_name="s",
            username="u",
            password="p",
        )

        listing = DirectoryListing(path="/", items=[], total=0)

        manager = MagicMock()
        manager.get_cache.return_value = cache

        with patch(
            "app.services.directory_cache.get_directory_cache_manager",
            return_value=manager,
        ):
            _update_directory_cache_from_listing("conn-1", listing)

        assert cache.directory_count == 0
