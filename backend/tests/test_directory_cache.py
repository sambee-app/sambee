"""
Tests for the directory cache service (instant directory navigation).

Tests cover:
- CacheState enum values
- ConnectionDirectoryCache: search, add, remove, rename, state management
- DirectoryCacheManager: get/create/remove caches, stats, shutdown
- Module-level singleton and shutdown functions
"""

import asyncio
import threading
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from smbclient._os import FileAttributes
from smbprotocol.reparse_point import ReparseTags

from app.services.directory_cache import (
    CHANGE_NOTIFY_BUFFER_SIZE,
    MAX_SEARCH_RESULTS,
    RESCAN_INTERVAL_SECONDS,
    SCAN_BATCH_SIZE,
    SCAN_TIMEOUT_SECONDS,
    CacheState,
    ConnectionDirectoryCache,
    DirectoryCacheManager,
    _DirectoryMutation,
    _ScannedDirectory,
    get_directory_cache_manager,
    shutdown_directory_cache,
)

# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture(name="cache")
def cache_fixture() -> ConnectionDirectoryCache:
    """Create a ConnectionDirectoryCache instance for testing."""

    return ConnectionDirectoryCache(
        connection_id="test-conn-001",
        host="server.local",
        share_name="testshare",
        username="testuser",
        password="testpass",
        port=445,
    )


@pytest.fixture(name="populated_cache")
def populated_cache_fixture(cache: ConnectionDirectoryCache) -> ConnectionDirectoryCache:
    """Create a cache pre-populated with directory paths."""

    dirs = [
        "documents",
        "documents/work",
        "documents/work/reports",
        "documents/work/reports/2024",
        "documents/personal",
        "photos",
        "photos/vacation",
        "photos/vacation/2024",
        "photos/family",
        "music",
        "music/rock",
        "music/jazz",
        "projects",
        "projects/alpha",
        "projects/alpha/src",
        "projects/beta",
        "backups",
        "backups/daily",
        "backups/weekly",
    ]
    cache.add_directories(dirs)
    return cache


@pytest.fixture(name="manager")
def manager_fixture() -> DirectoryCacheManager:
    """Create a DirectoryCacheManager instance for testing."""

    return DirectoryCacheManager(cache_factory=ConnectionDirectoryCache)


# ============================================================================
# CacheState enum
# ============================================================================


@pytest.mark.unit
class TestCacheState:
    """Tests for the CacheState enum."""

    def test_enum_values(self):
        """Verify all expected cache states exist with correct values."""

        assert CacheState.EMPTY.value == "empty"
        assert CacheState.BUILDING.value == "building"
        assert CacheState.READY.value == "ready"
        assert CacheState.UPDATING.value == "updating"

    def test_enum_is_string(self):
        """Cache states should be usable as strings."""

        assert isinstance(CacheState.READY, str)
        assert CacheState.READY.value == "ready"

    def test_enum_member_count(self):
        """Ensure no unexpected states were added."""

        assert len(CacheState) == 4


# ============================================================================
# Constants
# ============================================================================


@pytest.mark.unit
class TestConstants:
    """Verify module-level constants have sensible values."""

    def test_max_search_results(self):
        """MAX_SEARCH_RESULTS should be a positive integer."""

        assert MAX_SEARCH_RESULTS > 0
        assert isinstance(MAX_SEARCH_RESULTS, int)

    def test_scan_batch_size(self):
        """SCAN_BATCH_SIZE should be a positive integer."""

        assert SCAN_BATCH_SIZE > 0
        assert isinstance(SCAN_BATCH_SIZE, int)

    def test_rescan_interval(self):
        """RESCAN_INTERVAL_SECONDS should be at least 60 seconds."""

        assert RESCAN_INTERVAL_SECONDS >= 60

    def test_scan_timeout(self):
        """SCAN_TIMEOUT_SECONDS should be positive."""

        assert SCAN_TIMEOUT_SECONDS > 0

    def test_change_notify_buffer_size(self):
        """Buffer size should be the protocol maximum (64 KB)."""

        assert CHANGE_NOTIFY_BUFFER_SIZE == 65536


# ============================================================================
# ConnectionDirectoryCache — initialization
# ============================================================================


@pytest.mark.unit
class TestConnectionDirectoryCacheInit:
    """Tests for ConnectionDirectoryCache constructor and properties."""

    def test_initial_state_is_empty(self, cache: ConnectionDirectoryCache):
        """New cache should start in EMPTY state."""

        assert cache.state == CacheState.EMPTY

    def test_initial_directory_count_is_zero(self, cache: ConnectionDirectoryCache):
        """New cache should have zero directories."""

        assert cache.directory_count == 0

    def test_initial_last_scan_time_is_none(self, cache: ConnectionDirectoryCache):
        """New cache should have no last scan time."""

        assert cache.last_scan_time is None

    def test_initial_scan_error_is_none(self, cache: ConnectionDirectoryCache):
        """New cache should have no scan error."""

        assert cache.scan_error is None

    def test_stores_connection_params(self, cache: ConnectionDirectoryCache):
        """Cache should store all connection parameters."""

        assert cache.connection_id == "test-conn-001"
        assert cache.host == "server.local"
        assert cache.share_name == "testshare"
        assert cache.username == "testuser"
        assert cache.password == "testpass"
        assert cache.port == 445

    def test_default_port(self):
        """Port should default to 445 when not specified."""

        cache = ConnectionDirectoryCache(
            connection_id="test",
            host="host",
            share_name="share",
            username="user",
            password="pass",
        )
        assert cache.port == 445


# ============================================================================
# ConnectionDirectoryCache — search
# ============================================================================


@pytest.mark.unit
class TestSearch:
    """Tests for the search method."""

    def test_word_boundary_ranks_before_substring_and_normalizes_accents(self, cache: ConnectionDirectoryCache):
        cache.add_directories(["xreport", "annual-report", "report", "Résumé"])
        matches, count = cache.search("report")
        assert matches == ["report", "annual-report", "xreport"]
        assert count == 3
        assert cache.search("resume")[0] == ["Résumé"]

    def test_empty_query_returns_empty(self, populated_cache: ConnectionDirectoryCache):
        """Empty query should return no results."""

        assert populated_cache.search("") == ([], 0)

    def test_no_matches_returns_empty(self, populated_cache: ConnectionDirectoryCache):
        """Query that matches nothing should return empty list."""

        assert populated_cache.search("nonexistent_xyz") == ([], 0)

    def test_finds_substring_match(self, populated_cache: ConnectionDirectoryCache):
        """Substring match should find directories containing the query."""

        results, _ = populated_cache.search("rock")
        assert "music/rock" in results

    def test_case_insensitive(self, populated_cache: ConnectionDirectoryCache):
        """Search should be case-insensitive."""

        results_lower, _ = populated_cache.search("documents")
        results_upper, _ = populated_cache.search("DOCUMENTS")
        results_mixed, _ = populated_cache.search("Documents")

        # All searches should return the same set of results
        assert set(results_lower) == set(results_upper)
        assert set(results_lower) == set(results_mixed)
        assert len(results_lower) > 0

    def test_finds_multiple_matches(self, populated_cache: ConnectionDirectoryCache):
        """Query matching multiple paths should return all matches."""

        results, _ = populated_cache.search("2024")
        assert len(results) >= 2
        assert "documents/work/reports/2024" in results
        assert "photos/vacation/2024" in results

    def test_relevance_exact_basename_first(self, populated_cache: ConnectionDirectoryCache):
        """Exact basename match should rank highest."""

        results, _ = populated_cache.search("music")
        # "music" (exact basename match) should come before "music/rock" etc.
        assert results[0] == "music"

    def test_relevance_basename_starts_with_before_contains(self):
        """Basename starting with query should rank above path-contains."""

        cache = ConnectionDirectoryCache(
            connection_id="test",
            host="h",
            share_name="s",
            username="u",
            password="p",
        )
        cache.add_directories(
            [
                "deep/nested/report",  # basename starts with "report"
                "reports",  # exact basename match
                "some/path/quarterly-report",  # basename contains "report"
            ]
        )

        results, _ = cache.search("report")
        # "reports" is exact match -> tier 0
        # "deep/nested/report" is exact basename match -> tier 0
        # "some/path/quarterly-report" is basename-contains -> tier 2
        assert results[-1] == "some/path/quarterly-report"

    def test_relevance_shorter_paths_preferred(self):
        """Among same-tier matches, shorter (shallower) paths rank higher."""

        cache = ConnectionDirectoryCache(
            connection_id="test",
            host="h",
            share_name="s",
            username="u",
            password="p",
        )
        cache.add_directories(
            [
                "a/b/c/docs",
                "docs",
                "x/docs",
            ]
        )

        results, _ = cache.search("docs")
        # All are exact basename matches, sorted by depth
        assert results[0] == "docs"
        assert results[1] == "x/docs"
        assert results[2] == "a/b/c/docs"

    def test_search_caps_at_max_results(self):
        """Search should return at most MAX_SEARCH_RESULTS."""

        cache = ConnectionDirectoryCache(
            connection_id="test",
            host="h",
            share_name="s",
            username="u",
            password="p",
        )
        # Add more directories than the cap
        dirs = [f"dir_{i}" for i in range(MAX_SEARCH_RESULTS + 100)]
        cache.add_directories(dirs)

        results, total_count = cache.search("dir")
        assert len(results) == MAX_SEARCH_RESULTS
        assert total_count == MAX_SEARCH_RESULTS + 100

    def test_search_on_empty_cache(self, cache: ConnectionDirectoryCache):
        """Search on empty cache should return empty list."""

        assert cache.search("anything") == ([], 0)

    def test_search_partial_path_segment(self, populated_cache: ConnectionDirectoryCache):
        """Should match partial segments within path components."""

        results, _ = populated_cache.search("vac")
        matching_paths = [r for r in results if "vacation" in r]
        assert len(matching_paths) > 0

    def test_search_slash_in_query(self, populated_cache: ConnectionDirectoryCache):
        """Query containing / should match path separator."""

        results, _ = populated_cache.search("music/rock")
        assert "music/rock" in results

    def test_search_backslash_normalized_to_forward_slash(self, populated_cache: ConnectionDirectoryCache):
        """Query containing \\ should be normalised to / and match across directories."""

        results, _ = populated_cache.search("music\\rock")
        assert "music/rock" in results

    def test_search_mixed_separators_normalized(self):
        """Query with mixed / and \\ should normalise all to /."""

        cache = ConnectionDirectoryCache(
            connection_id="test",
            host="h",
            share_name="s",
            username="u",
            password="p",
        )
        cache.add_directories(["a/b/c/d"])

        results, total = cache.search("a\\b/c")
        assert results == ["a/b/c/d"]
        assert total == 1


# ============================================================================
# ConnectionDirectoryCache — add_directory
# ============================================================================


@pytest.mark.unit
class TestAddDirectory:
    """Tests for the add_directory method."""

    def test_add_single_directory(self, cache: ConnectionDirectoryCache):
        """Adding a directory should increase count and make it searchable."""

        cache.add_directory("photos")
        assert cache.directory_count == 1
        assert cache.search("photos") == (["photos"], 1)

    def test_normalizes_leading_slash(self, cache: ConnectionDirectoryCache):
        """Leading slashes should be stripped."""

        cache.add_directory("/photos")
        results, _ = cache.search("photos")
        assert results == ["photos"]

    def test_normalizes_trailing_slash(self, cache: ConnectionDirectoryCache):
        """Trailing slashes should be stripped."""

        cache.add_directory("photos/")
        results, _ = cache.search("photos")
        assert results == ["photos"]

    def test_normalizes_both_slashes(self, cache: ConnectionDirectoryCache):
        """Both leading and trailing slashes should be stripped."""

        cache.add_directory("/photos/")
        results, _ = cache.search("photos")
        assert results == ["photos"]

    def test_empty_path_ignored(self, cache: ConnectionDirectoryCache):
        """Empty string (root) should not be added."""

        cache.add_directory("")
        assert cache.directory_count == 0

    def test_slash_only_ignored(self, cache: ConnectionDirectoryCache):
        """Slash-only path (root) should not be added."""

        cache.add_directory("/")
        assert cache.directory_count == 0

    def test_duplicate_single_entry(self, cache: ConnectionDirectoryCache):
        """Adding same path twice should not create duplicate."""

        cache.add_directory("photos")
        cache.add_directory("photos")
        assert cache.directory_count == 1

    def test_updates_count(self, cache: ConnectionDirectoryCache):
        """Directory count should update after each add."""

        cache.add_directory("a")
        assert cache.directory_count == 1
        cache.add_directory("b")
        assert cache.directory_count == 2
        cache.add_directory("c")
        assert cache.directory_count == 3


# ============================================================================
# ConnectionDirectoryCache — add_directories (batch)
# ============================================================================


@pytest.mark.unit
class TestAddDirectories:
    """Tests for the add_directories method (batch add)."""

    def test_add_multiple(self, cache: ConnectionDirectoryCache):
        """Batch add should add all directories."""

        cache.add_directories(["a", "b", "c"])
        assert cache.directory_count == 3

    def test_normalizes_all(self, cache: ConnectionDirectoryCache):
        """Batch add should normalize all paths."""

        cache.add_directories(["/a/", "/b", "c/"])
        results_a, _ = cache.search("a")
        results_b, _ = cache.search("b")
        results_c, _ = cache.search("c")
        assert results_a == ["a"]
        assert results_b == ["b"]
        assert results_c == ["c"]

    def test_deduplicates(self, cache: ConnectionDirectoryCache):
        """Batch add should not create duplicates."""

        cache.add_directories(["a", "a", "b", "b", "c"])
        assert cache.directory_count == 3

    def test_empty_list(self, cache: ConnectionDirectoryCache):
        """Empty list should be a no-op."""

        cache.add_directories([])
        assert cache.directory_count == 0

    def test_all_empty_paths(self, cache: ConnectionDirectoryCache):
        """List of empty/root paths should be a no-op."""

        cache.add_directories(["", "/", ""])
        assert cache.directory_count == 0

    def test_mixed_valid_and_empty(self, cache: ConnectionDirectoryCache):
        """Should add valid paths and skip empty ones."""

        cache.add_directories(["", "valid", "/", "also_valid"])
        assert cache.directory_count == 2

    def test_merges_with_existing(self, cache: ConnectionDirectoryCache):
        """Batch add should merge with existing directories."""

        cache.add_directory("existing")
        cache.add_directories(["new1", "new2"])
        assert cache.directory_count == 3


# ============================================================================
# ConnectionDirectoryCache — remove_directory
# ============================================================================


@pytest.mark.unit
class TestRemoveDirectory:
    """Tests for the remove_directory method."""

    def test_remove_single(self, populated_cache: ConnectionDirectoryCache):
        """Removing a leaf directory should remove it from cache."""

        initial = populated_cache.directory_count
        populated_cache.remove_directory("music/jazz")
        assert populated_cache.directory_count == initial - 1
        assert populated_cache.search("jazz") == ([], 0)

    def test_remove_with_children(self, populated_cache: ConnectionDirectoryCache):
        """Removing a parent should remove all children too."""

        populated_cache.remove_directory("documents")
        results, _ = populated_cache.search("documents")
        assert len(results) == 0
        assert populated_cache.search("reports") == ([], 0)

    def test_remove_normalizes_path(self, cache: ConnectionDirectoryCache):
        """Remove should normalize the path before matching."""

        cache.add_directory("photos")
        cache.remove_directory("/photos/")
        assert cache.directory_count == 0

    def test_remove_nonexistent_is_safe(self, cache: ConnectionDirectoryCache):
        """Removing a non-existent path should not raise."""

        cache.add_directory("existing")
        cache.remove_directory("nonexistent")
        assert cache.directory_count == 1

    def test_remove_empty_path_is_noop(self, cache: ConnectionDirectoryCache):
        """Empty path should be ignored."""

        cache.add_directory("something")
        cache.remove_directory("")
        assert cache.directory_count == 1

    def test_remove_updates_count(self, populated_cache: ConnectionDirectoryCache):
        """Directory count should decrease correctly after removal."""

        # Count directories starting with "photos"
        photos_dirs, _ = populated_cache.search("photos")
        initial = populated_cache.directory_count

        populated_cache.remove_directory("photos")
        assert populated_cache.directory_count == initial - len(photos_dirs)

    def test_remove_does_not_affect_similarly_named(self, cache: ConnectionDirectoryCache):
        """Removing 'abc' should not remove 'abcdef' (non-child prefix)."""

        cache.add_directories(["abc", "abcdef", "abc/child"])
        cache.remove_directory("abc")
        # "abc" and "abc/child" removed, but "abcdef" stays (different prefix)
        assert cache.directory_count == 1
        assert cache.search("abcdef") == (["abcdef"], 1)


# ============================================================================
# ConnectionDirectoryCache — rename_directory
# ============================================================================


@pytest.mark.unit
class TestRenameDirectory:
    """Tests for the rename_directory method."""

    def test_rename_single(self, cache: ConnectionDirectoryCache):
        """Renaming a directory should update its path."""

        cache.add_directory("old_name")
        cache.rename_directory("old_name", "new_name")
        assert cache.search("old_name") == ([], 0)
        assert cache.search("new_name") == (["new_name"], 1)
        assert cache.directory_count == 1

    def test_rename_updates_children(self, cache: ConnectionDirectoryCache):
        """Renaming a parent should update all children paths."""

        cache.add_directories(
            [
                "projects",
                "projects/alpha",
                "projects/alpha/src",
            ]
        )
        cache.rename_directory("projects", "work")

        assert cache.search("projects") == ([], 0)
        assert "work" in cache.search("work")[0]
        assert "work/alpha" in cache.search("alpha")[0]
        assert "work/alpha/src" in cache.search("src")[0]
        assert cache.directory_count == 3

    def test_rename_preserves_count(self, cache: ConnectionDirectoryCache):
        """Rename should not change the total directory count."""

        cache.add_directories(["a", "a/b", "a/b/c"])
        cache.rename_directory("a", "x")
        assert cache.directory_count == 3

    def test_rename_normalizes_paths(self, cache: ConnectionDirectoryCache):
        """Rename should normalize both old and new paths."""

        cache.add_directory("photos")
        cache.rename_directory("/photos/", "/images/")
        assert cache.search("photos") == ([], 0)
        assert cache.search("images") == (["images"], 1)

    def test_rename_empty_old_is_noop(self, cache: ConnectionDirectoryCache):
        """Empty old path should be a no-op."""

        cache.add_directory("test")
        cache.rename_directory("", "new")
        assert cache.search("test") == (["test"], 1)
        assert cache.directory_count == 1

    def test_rename_empty_new_is_noop(self, cache: ConnectionDirectoryCache):
        """Empty new path should be a no-op."""

        cache.add_directory("test")
        cache.rename_directory("test", "")
        assert cache.search("test") == (["test"], 1)
        assert cache.directory_count == 1

    def test_rename_does_not_affect_similarly_named(self, cache: ConnectionDirectoryCache):
        """Renaming 'abc' should not affect 'abcdef'."""

        cache.add_directories(["abc", "abcdef", "abc/child"])
        cache.rename_directory("abc", "xyz")

        assert "xyz" in cache.search("xyz")[0]
        assert "xyz/child" in cache.search("child")[0]
        assert "abcdef" in cache.search("abcdef")[0]
        assert cache.directory_count == 3


# ============================================================================
# ConnectionDirectoryCache — start_scan
# ============================================================================


@pytest.mark.unit
class TestStartScan:
    """Tests for the start_scan method."""

    @pytest.mark.asyncio
    async def test_sets_building_state(self, cache: ConnectionDirectoryCache):
        """start_scan should set state to BUILDING."""

        with patch.object(cache, "_run_scan", new_callable=AsyncMock):
            await cache.start_scan()
            assert cache.state == CacheState.BUILDING

    @pytest.mark.asyncio
    async def test_skips_if_already_building(self, cache: ConnectionDirectoryCache):
        """Should not start a new scan if one is already in progress."""

        cache._state = CacheState.BUILDING
        original_task = cache._scan_task

        await cache.start_scan()
        # Should not have created a new task
        assert cache._scan_task is original_task

    @pytest.mark.asyncio
    async def test_skips_if_updating(self, cache: ConnectionDirectoryCache):
        """Should not start a new scan if a rescan is in progress."""

        cache._state = CacheState.UPDATING
        await cache.start_scan()
        assert cache._scan_task is None

    @pytest.mark.asyncio
    async def test_clears_scan_error(self, cache: ConnectionDirectoryCache):
        """start_scan should clear previous scan errors."""

        cache._scan_error = "Previous error"
        with patch.object(cache, "_run_scan", new_callable=AsyncMock):
            await cache.start_scan()
            assert cache.scan_error is None


# ============================================================================
# ConnectionDirectoryCache — rescans
# ============================================================================


@pytest.mark.unit
class TestRescan:
    """Rescans must preserve usable search data when SMB reads fail."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize("failed_path", ["", "documents"])
    async def test_incomplete_rescan_preserves_live_index(self, populated_cache: ConnectionDirectoryCache, failed_path: str):
        """A root or subtree timeout must not replace or persist a partial index."""
        cache = populated_cache
        cache._state = CacheState.READY
        cache._last_scan_time = 123.0
        previous_directories = set(cache._directories)
        pool = MagicMock()

        async def scan_directory(_pool, _smb_path, rel_path):
            if rel_path == failed_path:
                raise TimeoutError("SMB directory read timed out")
            return [_ScannedDirectory("documents")] if not rel_path else []

        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=pool),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory),
            patch.object(cache, "save_to_disk") as save,
        ):
            await cache._run_rescan()

        assert cache._directories == previous_directories
        assert cache.state == CacheState.READY
        assert cache.last_scan_time == 123.0
        assert cache.scan_error is not None
        save.assert_not_called()

    @pytest.mark.asyncio
    async def test_unreadable_entry_does_not_publish_partial_rescan(self, populated_cache: ConnectionDirectoryCache):
        """An entry metadata failure must not turn a partial listing into a complete index."""
        cache = populated_cache
        cache._state = CacheState.READY
        previous_directories = cache._directories.copy()
        readable_entry = MagicMock()
        readable_entry.name = "fresh-directory"
        readable_entry.smb_info.file_attributes = FileAttributes.FILE_ATTRIBUTE_DIRECTORY

        class UnreadableEntry:
            name = "unreadable-directory"

            @property
            def smb_info(self):
                raise OSError("Entry metadata could not be read")

        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=MagicMock()),
            patch("app.services.directory_cache.smbclient.scandir", return_value=[readable_entry, UnreadableEntry()]),
            patch.object(
                cache,
                "_scan_directory_with_pool_lease",
                side_effect=lambda _pool, smb_path, rel_path: cache._scan_single_directory(smb_path, rel_path),
            ),
            patch.object(cache, "save_to_disk") as save,
        ):
            await cache._run_rescan()

        assert cache._directories == previous_directories
        assert cache.scan_error is not None
        save.assert_not_called()

    @pytest.mark.asyncio
    async def test_successful_rescan_replaces_index_after_failure(self, populated_cache: ConnectionDirectoryCache):
        """Recovery must clear the error and remove paths absent from a complete scan."""
        cache = populated_cache
        cache._state = CacheState.READY

        async def scan_directory(_pool, _smb_path, rel_path):
            return [_ScannedDirectory("fresh-directory")] if not rel_path else []

        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=MagicMock()),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=TimeoutError("Temporary failure")) as scan,
            patch.object(cache, "save_to_disk") as save,
        ):
            await cache._run_rescan()
            assert cache.scan_error is not None
            scan.side_effect = scan_directory
            await cache._run_rescan()

        assert cache._directories == {"fresh-directory"}
        assert cache.scan_error is None
        assert cache.state == CacheState.READY
        save.assert_called_once()

    @pytest.mark.asyncio
    async def test_cancelled_rescan_discards_replay_without_losing_live_changes(self, populated_cache: ConnectionDirectoryCache):
        """Cancellation must preserve live mutations and allow a later rescan."""
        cache = populated_cache
        cache._state = CacheState.READY
        started = asyncio.Event()
        blocked = asyncio.Event()

        async def scan_directory(_pool, _smb_path, _rel_path):
            started.set()
            await blocked.wait()

        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=MagicMock()),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory),
            patch.object(cache, "save_to_disk") as save,
        ):
            scan_task = asyncio.create_task(cache._run_rescan())
            await started.wait()
            cache.add_directory("created-during-rescan")
            scan_task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await scan_task

        assert "created-during-rescan" in cache._directories
        assert cache._rescan_changes is None
        assert cache.state == CacheState.READY
        save.assert_not_called()

    @pytest.mark.asyncio
    async def test_overlapping_rescan_does_not_replace_active_replay(self, cache: ConnectionDirectoryCache):
        """Only one rescan may own the live-change journal at a time."""
        cache._state = CacheState.UPDATING
        replay = []
        cache._rescan_changes = replay
        with patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock) as get_pool:
            await cache._run_rescan()

        assert cache._rescan_changes is replay
        get_pool.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("action", ["add", "remove", "rename"])
    async def test_rescan_preserves_concurrent_mutations(self, cache: ConnectionDirectoryCache, action: str):
        """Watcher updates must win over directory data read earlier by a rescan."""
        cache._state = CacheState.READY
        cache.add_directory("documents")
        pool = MagicMock()

        async def scan_directory(_pool, _smb_path, rel_path):
            if not rel_path:
                return [_ScannedDirectory("documents"), _ScannedDirectory("photos")]
            if rel_path == "documents":
                return [_ScannedDirectory("documents/work")]
            if rel_path == "photos":
                if action == "add":
                    cache.add_directories(["new-directory", "new-directory/child"])
                elif action == "remove":
                    cache.remove_directory("documents")
                else:
                    cache.rename_directory("documents", "renamed")
            return []

        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=pool),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory),
            patch.object(cache, "save_to_disk") as save,
        ):
            await cache._run_rescan()

        expected = {
            "add": {"documents", "documents/work", "photos", "new-directory", "new-directory/child"},
            "remove": set(),
            "rename": {"renamed"},
        }
        assert cache._directories == expected[action]
        assert cache.directory_count == len(expected[action])
        assert cache._rescan_changes is None
        assert cache.state == CacheState.READY
        if action == "add":
            assert cache.scan_error is None
            save.assert_called_once()
        else:
            assert cache.scan_error is not None
            save.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("action", ["rename", "recreate"])
    async def test_rescan_does_not_replay_changes_already_seen_by_scan(self, cache: ConnectionDirectoryCache, action: str):
        """Changes before a directory read must not be applied twice to its results."""
        cache._state = CacheState.READY
        cache.add_directories(["alpha", "alpha/original", "incoming", "incoming/new-child"])

        async def get_pool():
            if action == "rename":
                cache.rename_directory("alpha", "moved")
                cache.rename_directory("incoming", "alpha")
            else:
                cache.remove_directory("alpha")
                cache.add_directory("alpha")
            return MagicMock()

        async def scan_directory(_pool, _smb_path, rel_path):
            directories = {
                "": ["alpha", "moved" if action == "rename" else "incoming"],
                "alpha": ["alpha/new-child"],
                "moved": ["moved/original"],
                "incoming": ["incoming/new-child"],
            }
            return [_ScannedDirectory(path) for path in directories.get(rel_path, [])]

        with (
            patch("app.services.directory_cache.get_connection_pool", side_effect=get_pool),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory),
            patch.object(cache, "save_to_disk") as save,
        ):
            await cache._run_rescan()

        other = "moved" if action == "rename" else "incoming"
        child = "original" if action == "rename" else "new-child"
        assert cache._directories == {"alpha", "alpha/new-child", other, f"{other}/{child}"}
        assert cache.directory_count == 4
        assert cache.scan_error is None
        save.assert_called_once()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("action", ["rename", "recreate"])
    @pytest.mark.parametrize("changed_during_read", ["", "alpha"])
    async def test_rescan_keeps_live_index_when_read_is_ambiguous(
        self, cache: ConnectionDirectoryCache, action: str, changed_during_read: str
    ):
        """A namespace change during a read must not replace a correct live index."""
        cache._state = CacheState.READY
        cache._last_scan_time = 123.0
        cache.add_directories(["alpha", "alpha/original", "incoming", "incoming/new-child"])
        live_after_changes = set()

        async def scan_directory(_pool, _smb_path, rel_path):
            nonlocal live_after_changes
            if rel_path == changed_during_read:
                if action == "rename":
                    cache.rename_directory("alpha", "moved")
                    cache.rename_directory("incoming", "alpha")
                else:
                    cache.remove_directory("alpha")
                    cache.add_directory("alpha")
                live_after_changes = cache._directories.copy()
            directories = {"": ["alpha", "incoming"], "alpha": ["alpha/new-child"]}
            return [_ScannedDirectory(path) for path in directories.get(rel_path, [])]

        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=MagicMock()),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory),
            patch.object(cache, "save_to_disk") as save,
        ):
            await cache._run_rescan()

        assert live_after_changes
        assert cache._directories == live_after_changes
        assert cache.last_scan_time == 123.0
        assert cache.scan_error is not None
        assert cache._rescan_changes is None
        assert cache.state == CacheState.READY
        save.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("notification_point", ["later-read", "publication"])
    @pytest.mark.parametrize("action", ["rename", "recreate"])
    async def test_rescan_rejects_delayed_events_for_already_current_reads(
        self, cache: ConnectionDirectoryCache, notification_point: str, action: str
    ):
        """Delayed events must not transform paths that already reflect the namespace changes."""
        cache._state = CacheState.READY
        cache._last_scan_time = 123.0
        cache.add_directories(["alpha", "alpha/original", "incoming", "incoming/new-child"])
        pool = MagicMock()
        live_after_changes = set()

        def notify():
            nonlocal live_after_changes
            if action == "rename":
                cache.rename_directory("alpha", "moved")
                cache.rename_directory("incoming", "alpha")
            else:
                cache.remove_directory("alpha")
                cache.add_directory("alpha")
            live_after_changes = cache._directories.copy()

        async def scan_directory(_pool, _smb_path, rel_path):
            if notification_point == "later-read" and rel_path == "unrelated":
                notify()
            directories = {
                "": ["alpha", "moved" if action == "rename" else "incoming", "unrelated"],
                "alpha": ["alpha/new-child"],
                "moved": ["moved/original"],
                "incoming": ["incoming/new-child"],
            }
            return [_ScannedDirectory(path) for path in directories.get(rel_path, [])]

        async def release_connection(*_args):
            if notification_point == "publication":
                notify()
            return False

        pool.get_connection.return_value.__aexit__.side_effect = release_connection
        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=pool),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory),
            patch.object(cache, "save_to_disk") as save,
        ):
            await cache._run_rescan()

        assert live_after_changes
        assert cache._directories == live_after_changes
        assert cache.last_scan_time == 123.0
        assert cache.scan_error is not None
        assert cache.state == CacheState.READY
        assert cache._rescan_changes is None
        save.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("action", ["add", "remove", "rename"])
    async def test_rescan_applies_changes_after_last_directory_read(self, cache: ConnectionDirectoryCache, action: str):
        """Publication accepts additions but rejects ambiguous namespace changes after reads."""
        cache._state = CacheState.READY
        cache.add_directories(["documents", "documents/work"])
        pool = MagicMock()

        async def release_connection(*_args):
            if action == "add":
                cache.add_directory("new-directory")
            elif action == "remove":
                cache.remove_directory("documents")
            else:
                cache.rename_directory("documents", "renamed")
            return False

        pool.get_connection.return_value.__aexit__.side_effect = release_connection

        async def scan_directory(_pool, _smb_path, rel_path):
            directories = {"": ["documents"], "documents": ["documents/work"]}
            return [_ScannedDirectory(path) for path in directories.get(rel_path, [])]

        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=pool),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory),
            patch.object(cache, "save_to_disk") as save,
        ):
            await cache._run_rescan()

        expected = {
            "add": {"documents", "documents/work", "new-directory"},
            "remove": set(),
            "rename": {"renamed", "renamed/work"},
        }
        assert cache._directories == expected[action]
        assert cache.directory_count == len(expected[action])
        if action == "add":
            assert cache.scan_error is None
            save.assert_called_once()
        else:
            assert cache.scan_error is not None
            save.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("notification_point", ["read", "publication"])
    async def test_rescan_skips_overlap_checks_for_additions(self, cache: ConnectionDirectoryCache, notification_point: str):
        """Additions merge without comparing each path against previously read directories."""
        cache._state = CacheState.READY
        pool = MagicMock()
        additions = ["documents", "new-directory", "new-directory/child"]

        async def scan_directory(_pool, _smb_path, rel_path):
            if rel_path == "documents" and notification_point == "read":
                cache.add_directories(additions)
            return [_ScannedDirectory("documents")] if not rel_path else []

        async def release_connection(*_args):
            if notification_point == "publication":
                cache.add_directories(additions)
            return False

        pool.get_connection.return_value.__aexit__.side_effect = release_connection
        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=pool),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory),
            patch.object(_DirectoryMutation, "invalidates_read", return_value=False) as overlap_check,
            patch.object(cache, "save_to_disk") as save,
        ):
            await cache._run_rescan()

        overlap_check.assert_not_called()
        assert cache._directories == set(additions)
        assert cache.directory_count == len(additions)
        assert cache.state == CacheState.READY
        assert cache.scan_error is None
        save.assert_called_once()

    @pytest.mark.asyncio
    async def test_rescan_accepts_changes_below_listed_children(self, cache: ConnectionDirectoryCache):
        """Removing a grandchild doesn't make an immediate-child listing ambiguous."""
        cache._state = CacheState.READY
        cache.add_directories(["documents", "documents/work", "documents/work/old"])

        async def scan_directory(_pool, _smb_path, rel_path):
            if not rel_path:
                cache.remove_directory("documents/work/old")
            directories = {"": ["documents"], "documents": ["documents/work"], "documents/work": ["documents/work/new"]}
            return [_ScannedDirectory(path) for path in directories.get(rel_path, [])]

        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=MagicMock()),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory),
            patch.object(cache, "save_to_disk") as save,
        ):
            await cache._run_rescan()

        assert cache._directories == {"documents", "documents/work", "documents/work/new"}
        assert cache.scan_error is None
        save.assert_called_once()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("initial_scan", [False, True])
    async def test_scans_index_junctions_without_traversing_them(self, cache: ConnectionDirectoryCache, initial_scan: bool):
        """A junction remains searchable without recursively visiting its target."""
        cache._state = CacheState.READY
        pool = MagicMock()

        async def scan_directory(_pool, _smb_path, rel_path):
            assert rel_path != "ancestor-junction", "Scanner descended into a directory junction"
            if not rel_path:
                return [_ScannedDirectory("ancestor-junction", is_reparse_point=True), _ScannedDirectory("ordinary")]
            return []

        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=pool),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory) as scan,
            patch.object(cache, "_start_watcher"),
            patch.object(cache, "_start_periodic_rescan"),
            patch.object(cache, "_start_coalesce_flush"),
            patch.object(cache, "save_to_disk"),
        ):
            if initial_scan:
                await cache._run_scan()
            else:
                await cache._run_rescan()

        assert cache._directories == {"ancestor-junction", "ordinary"}
        assert scan.await_count == 2

    @pytest.mark.parametrize("is_reparse_point", [False, True])
    def test_scan_reads_reparse_attribute(self, cache: ConnectionDirectoryCache, is_reparse_point: bool):
        """Directory discovery preserves SMB's reparse-point attribute for traversal decisions."""
        entry = MagicMock()
        entry.name = "directory"
        entry.smb_info.file_attributes = FileAttributes.FILE_ATTRIBUTE_DIRECTORY
        if is_reparse_point:
            entry.smb_info.file_attributes |= FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT
        with patch("app.services.directory_cache.smbclient.scandir", return_value=[entry]):
            result = cache._scan_single_directory("unused", "parent")

        assert result == [_ScannedDirectory("parent/directory", is_reparse_point=is_reparse_point)]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("initial_scan", [False, True])
    @pytest.mark.parametrize(
        "reparse_tag,should_descend",
        [
            (ReparseTags.IO_REPARSE_TAG_DFS, True),
            (ReparseTags.IO_REPARSE_TAG_MOUNT_POINT, False),
            (ReparseTags.IO_REPARSE_TAG_SYMLINK, False),
            (ReparseTags.IO_REPARSE_TAG_RESERVED_ZERO, False),
        ],
    )
    async def test_scans_distinguish_dfs_from_other_reparse_points(
        self, cache: ConnectionDirectoryCache, initial_scan: bool, reparse_tag: int, should_descend: bool
    ):
        """Both scan paths follow DFS referrals without traversing other directory reparse points."""
        cache._state = CacheState.READY
        referral = MagicMock()
        referral.name = "Departments"
        referral.smb_info.file_attributes = FileAttributes.FILE_ATTRIBUTE_DIRECTORY | FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT
        referral.smb_info.ea_size = reparse_tag
        child = MagicMock()
        child.name = "Projects"
        child.smb_info.file_attributes = FileAttributes.FILE_ATTRIBUTE_DIRECTORY
        entries = {"": [referral], "Departments": [child], "Departments/Projects": []}

        async def scan_directory(_pool, smb_path, rel_path):
            with patch("app.services.directory_cache.smbclient.scandir", return_value=entries[rel_path]):
                return cache._scan_single_directory(smb_path, rel_path)

        with (
            patch("app.services.directory_cache.get_connection_pool", new_callable=AsyncMock, return_value=MagicMock()),
            patch.object(cache, "_scan_directory_with_pool_lease", side_effect=scan_directory),
            patch.object(cache, "_start_watcher"),
            patch.object(cache, "_start_periodic_rescan"),
            patch.object(cache, "_start_coalesce_flush"),
            patch.object(cache, "save_to_disk"),
        ):
            if initial_scan:
                await cache._run_scan()
            else:
                await cache._run_rescan()

        expected = {"Departments", "Departments/Projects"} if should_descend else {"Departments"}
        assert cache._directories == expected


# ============================================================================
# ConnectionDirectoryCache — stop
# ============================================================================


@pytest.mark.unit
class TestStop:
    """Tests for the stop method."""

    def test_stop_clears_directories(self, populated_cache: ConnectionDirectoryCache):
        """stop() should clear all cached directories."""

        assert populated_cache.directory_count > 0
        populated_cache.stop()
        assert populated_cache.directory_count == 0

    def test_stop_sets_empty_state(self, populated_cache: ConnectionDirectoryCache):
        """stop() should reset state to EMPTY."""

        populated_cache._state = CacheState.READY
        populated_cache.stop()
        assert populated_cache.state == CacheState.EMPTY

    def test_stop_sets_stop_event(self, cache: ConnectionDirectoryCache):
        """stop() should signal background tasks to stop."""

        cache.stop()
        assert cache._stop_event.is_set()

    def test_stop_cancels_scan_task(self, cache: ConnectionDirectoryCache):
        """stop() should cancel the scan asyncio task if running."""

        mock_task = MagicMock()
        mock_task.done.return_value = False
        cache._scan_task = mock_task

        cache.stop()
        mock_task.cancel.assert_called_once()

    def test_stop_cancels_rescan_task(self, cache: ConnectionDirectoryCache):
        """stop() should cancel the rescan asyncio task if running."""

        mock_task = MagicMock()
        mock_task.done.return_value = False
        cache._rescan_task = mock_task

        cache.stop()
        mock_task.cancel.assert_called_once()

    def test_stop_cancels_verification_task(self, cache: ConnectionDirectoryCache):
        """Shutdown must also cancel the startup snapshot verification."""
        mock_task = MagicMock()
        mock_task.done.return_value = False
        cache._verification_task = mock_task

        cache.stop()

        mock_task.cancel.assert_called_once()


# ============================================================================
# ConnectionDirectoryCache — _process_change_events
# ============================================================================


@pytest.mark.unit
class TestProcessChangeEvents:
    """Tests for the _process_change_events method."""

    @staticmethod
    def _make_event(action_value: int, file_name: str) -> dict:
        """Create a mock CHANGE_NOTIFY event dictionary."""

        action_mock = MagicMock()
        action_mock.get_value.return_value = action_value
        name_mock = MagicMock()
        name_mock.get_value.return_value = file_name
        return {"action": action_mock, "file_name": name_mock}

    def test_file_action_added(self, cache: ConnectionDirectoryCache):
        """FILE_ACTION_ADDED should add directory to cache."""

        from smbprotocol.change_notify import FileAction

        event = self._make_event(FileAction.FILE_ACTION_ADDED, "new_dir")
        cache._process_change_events([event])
        assert cache.search("new_dir") == (["new_dir"], 1)

    def test_file_action_removed(self, cache: ConnectionDirectoryCache):
        """FILE_ACTION_REMOVED should remove directory from cache."""

        from smbprotocol.change_notify import FileAction

        cache.add_directory("old_dir")
        event = self._make_event(FileAction.FILE_ACTION_REMOVED, "old_dir")
        cache._process_change_events([event])
        assert cache.search("old_dir") == ([], 0)

    def test_file_action_renamed(self, cache: ConnectionDirectoryCache):
        """Rename events (old + new) should update directory path."""

        from smbprotocol.change_notify import FileAction

        cache.add_directory("before")
        old_event = self._make_event(FileAction.FILE_ACTION_RENAMED_OLD_NAME, "before")
        new_event = self._make_event(FileAction.FILE_ACTION_RENAMED_NEW_NAME, "after")
        cache._process_change_events([old_event, new_event])

        assert cache.search("before") == ([], 0)
        assert cache.search("after") == (["after"], 1)

    def test_rename_new_without_old_treated_as_add(self, cache: ConnectionDirectoryCache):
        """RENAMED_NEW_NAME without preceding RENAMED_OLD_NAME should add."""

        from smbprotocol.change_notify import FileAction

        event = self._make_event(FileAction.FILE_ACTION_RENAMED_NEW_NAME, "orphan_dir")
        cache._process_change_events([event])
        assert cache.search("orphan_dir") == (["orphan_dir"], 1)

    def test_backslash_to_forward_slash(self, cache: ConnectionDirectoryCache):
        """Windows-style backslashes should be converted to forward slashes."""

        from smbprotocol.change_notify import FileAction

        event = self._make_event(FileAction.FILE_ACTION_ADDED, "path\\to\\dir")
        cache._process_change_events([event])
        assert cache.search("dir") == (["path/to/dir"], 1)

    def test_malformed_event_does_not_crash(self, cache: ConnectionDirectoryCache):
        """Malformed events should be logged and skipped, not crash."""

        bad_event: dict = {"action": MagicMock(side_effect=Exception("bad")), "file_name": MagicMock()}
        # Should not raise
        cache._process_change_events([bad_event])


# ============================================================================
# ConnectionDirectoryCache — thread safety
# ============================================================================


@pytest.mark.unit
class TestThreadSafety:
    """Tests for concurrent access to the cache."""

    def test_concurrent_add_and_search(self, cache: ConnectionDirectoryCache):
        """Adding and searching concurrently should not corrupt data."""

        errors: list[Exception] = []

        def adder():
            try:
                for i in range(100):
                    cache.add_directory(f"dir_{i}")
            except Exception as e:
                errors.append(e)

        def searcher():
            try:
                for _ in range(100):
                    cache.search("dir")
            except Exception as e:
                errors.append(e)

        threads = [
            threading.Thread(target=adder),
            threading.Thread(target=searcher),
            threading.Thread(target=adder),
            threading.Thread(target=searcher),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert len(errors) == 0
        assert cache.directory_count > 0


# ============================================================================
# DirectoryCacheManager
# ============================================================================


@pytest.mark.unit
class TestDirectoryCacheManager:
    """Tests for the DirectoryCacheManager class."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "field,value",
        [
            ("host", "other-host"),
            ("share_name", "other-share"),
            ("username", "other-user"),
            ("password", "other-password"),
            ("port", 1445),
            ("path_prefix", "/other"),
            ("source_revision", "new-revision"),
        ],
    )
    async def test_rebinds_changed_sources_without_serving_previous_paths(self, manager: DirectoryCacheManager, field, value):
        parameters = {"connection_id": "rebound", "host": "host", "share_name": "share", "username": "user", "password": "password"}
        with (
            patch.object(ConnectionDirectoryCache, "start_scan", new_callable=AsyncMock),
            patch.object(ConnectionDirectoryCache, "load_from_disk", return_value=False),
            patch.object(ConnectionDirectoryCache, "save_to_disk"),
        ):
            previous = await manager.get_or_create_cache(**parameters)
            previous.add_directory("old-source-data")
            replacement = await manager.get_or_create_cache(**{**parameters, field: value})
            assert replacement is not previous
            assert previous._stop_event.is_set()
            assert replacement.directory_count == 0
            assert manager.get_cache("rebound") is replacement
            await manager.stop_all_async()

    def test_get_cache_returns_none_for_unknown(self, manager: DirectoryCacheManager):
        """get_cache should return None for unknown connection IDs."""

        assert manager.get_cache("unknown-id") is None

    @pytest.mark.asyncio
    async def test_get_or_create_cache_creates_new(self, manager: DirectoryCacheManager):
        """get_or_create_cache should create a new cache with scan started."""

        with patch(
            "app.services.directory_cache.ConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ) as mock_scan:
            cache = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
                port=445,
            )

            assert cache is not None
            assert cache.connection_id == "conn-1"
            mock_scan.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_or_create_cache_returns_existing(self, manager: DirectoryCacheManager):
        """get_or_create_cache should return existing cache on second call."""

        with patch(
            "app.services.directory_cache.ConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            cache1 = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )
            cache2 = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )
            assert cache1 is cache2

    @pytest.mark.asyncio
    async def test_get_cache_after_create(self, manager: DirectoryCacheManager):
        """get_cache should find cache created by get_or_create_cache."""

        with patch(
            "app.services.directory_cache.ConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            created = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )
            found = manager.get_cache("conn-1")
            assert found is created

    @pytest.mark.asyncio
    async def test_remove_cache_stops_and_removes(self, manager: DirectoryCacheManager):
        """remove_cache should stop the cache and remove it from the manager."""

        with patch(
            "app.services.directory_cache.ConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )

        with patch.object(ConnectionDirectoryCache, "stop") as mock_stop:
            manager.remove_cache("conn-1")
            mock_stop.assert_called_once()

        assert manager.get_cache("conn-1") is None

    def test_remove_nonexistent_cache_is_safe(self, manager: DirectoryCacheManager):
        """Removing a non-existent cache should not raise."""

        manager.remove_cache("nonexistent")  # Should not raise

    @pytest.mark.asyncio
    async def test_stop_all(self, manager: DirectoryCacheManager):
        """stop_all should stop every cache and clear the manager."""

        with patch(
            "app.services.directory_cache.ConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )
            await manager.get_or_create_cache(
                connection_id="conn-2",
                host="host2",
                share_name="share2",
                username="user2",
                password="pass2",
            )

        with patch.object(ConnectionDirectoryCache, "stop"):
            manager.stop_all()

        assert manager.get_cache("conn-1") is None
        assert manager.get_cache("conn-2") is None

    @pytest.mark.asyncio
    async def test_get_stats(self, manager: DirectoryCacheManager):
        """get_stats should return stats for all caches."""

        with patch(
            "app.services.directory_cache.ConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            cache = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host",
                share_name="share",
                username="user",
                password="pass",
            )
            cache.add_directories(["a", "b", "c"])

        stats = manager.get_stats()
        assert "conn-1" in stats
        assert stats["conn-1"]["state"] == CacheState.EMPTY.value
        assert stats["conn-1"]["directory_count"] == 3
        assert stats["conn-1"]["last_scan_time"] is None
        assert stats["conn-1"]["scan_error"] is None

    def test_get_stats_empty_manager(self, manager: DirectoryCacheManager):
        """get_stats on empty manager should return empty dict."""

        assert manager.get_stats() == {}

    @pytest.mark.asyncio
    async def test_separate_caches_per_connection(self, manager: DirectoryCacheManager):
        """Each connection should have its own independent cache."""

        with patch(
            "app.services.directory_cache.ConnectionDirectoryCache.start_scan",
            new_callable=AsyncMock,
        ):
            cache1 = await manager.get_or_create_cache(
                connection_id="conn-1",
                host="host1",
                share_name="share1",
                username="user",
                password="pass",
            )
            cache2 = await manager.get_or_create_cache(
                connection_id="conn-2",
                host="host2",
                share_name="share2",
                username="user",
                password="pass",
            )

        cache1.add_directory("only_in_cache1")
        cache2.add_directory("only_in_cache2")

        assert cache1.search("only_in_cache1") == (["only_in_cache1"], 1)
        assert cache1.search("only_in_cache2") == ([], 0)
        assert cache2.search("only_in_cache2") == (["only_in_cache2"], 1)
        assert cache2.search("only_in_cache1") == ([], 0)


# ============================================================================
# Module-level functions
# ============================================================================


@pytest.mark.unit
class TestModuleFunctions:
    """Tests for module-level singleton and shutdown functions."""

    def test_get_directory_cache_manager_returns_instance(self):
        """Should return a DirectoryCacheManager instance."""

        import app.services.directory_cache as module

        original = module._global_cache_manager
        try:
            module._global_cache_manager = None
            mgr = get_directory_cache_manager()
            assert isinstance(mgr, DirectoryCacheManager)
        finally:
            module._global_cache_manager = original

    def test_get_directory_cache_manager_is_singleton(self):
        """Repeated calls should return the same instance."""

        import app.services.directory_cache as module

        original = module._global_cache_manager
        try:
            module._global_cache_manager = None
            mgr1 = get_directory_cache_manager()
            mgr2 = get_directory_cache_manager()
            assert mgr1 is mgr2
        finally:
            module._global_cache_manager = original

    def test_shutdown_directory_cache(self):
        """shutdown_directory_cache should call stop_all and clear singleton."""

        import app.services.directory_cache as module

        original = module._global_cache_manager
        try:
            mock_manager = MagicMock(spec=DirectoryCacheManager)
            module._global_cache_manager = mock_manager

            shutdown_directory_cache()

            mock_manager.stop_all.assert_called_once()
            assert module._global_cache_manager is None
        finally:
            module._global_cache_manager = original

    def test_shutdown_when_no_manager(self):
        """shutdown_directory_cache should be safe when no manager exists."""

        import app.services.directory_cache as module

        original = module._global_cache_manager
        try:
            module._global_cache_manager = None
            shutdown_directory_cache()  # Should not raise
            assert module._global_cache_manager is None
        finally:
            module._global_cache_manager = original
