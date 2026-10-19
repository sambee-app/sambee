"""
Tests for directory cache disk persistence (JSONL snapshot format).

Tests cover:
- save_to_disk / load_from_disk round-trip
- Atomic write (temp file + rename) with .bak backup
- JSONL format validation (header + directory entries)
- Staleness detection (max age threshold, configurable in minutes)
- Version mismatch handling
- Connection ID mismatch handling
- Corrupt / empty file handling
- Backup fallback when main file is corrupt
- Count mismatch (still loads)
- Dirty flag tracking across mutations
- Coalesce flush loop
- Flush on stop
- Load-on-create in DirectoryCacheManager
- delete_persist_file (removes both .idx and .bak)
"""

import asyncio
import json
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.services.directory_cache import (
    CACHE_BACKUP_EXTENSION,
    CACHE_FILE_EXTENSION,
    CACHE_FILE_VERSION,
    CACHE_PERSIST_SUBDIR,
    CacheState,
    ConnectionDirectoryCache,
    DirectoryCacheManager,
)

# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture(name="persist_dir")
def persist_dir_fixture(tmp_path: Path) -> Path:
    """Create a temporary persistence directory."""

    d = tmp_path / CACHE_PERSIST_SUBDIR
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture(name="cache")
def cache_fixture(tmp_path: Path) -> ConnectionDirectoryCache:
    """Create a cache with persistence pointed at a temp directory."""

    with (
        patch("app.services.directory_cache.static") as mock_static,
        patch("app.services.directory_cache.settings") as mock_settings,
    ):
        mock_static.data_dir = tmp_path
        mock_settings.directory_cache_location = ""
        mock_settings.directory_cache_coalesce_interval_seconds = 30
        mock_settings.directory_cache_max_staleness_minutes = 43200
        c = ConnectionDirectoryCache(
            connection_id="persist-test-001",
            host="server.local",
            share_name="testshare",
            username="testuser",
            password="testpass",
            port=445,
        )

    return c


@pytest.fixture(name="populated_cache")
def populated_cache_fixture(cache: ConnectionDirectoryCache) -> ConnectionDirectoryCache:
    """Create a cache pre-populated with directory paths."""

    dirs = [
        "documents",
        "documents/work",
        "documents/work/reports",
        "photos",
        "photos/vacation",
        "music",
        "music/rock",
        "music/jazz",
        "projects",
        "projects/alpha",
    ]
    cache.add_directories(dirs)
    return cache


@pytest.fixture(autouse=True)
def _mock_settings():
    """Ensure settings are available for all persistence operations."""

    with patch("app.services.directory_cache.settings") as mock_settings:
        mock_settings.directory_cache_location = ""
        mock_settings.directory_cache_coalesce_interval_seconds = 30
        mock_settings.directory_cache_max_staleness_minutes = 43200  # 30 days
        yield mock_settings


# ============================================================================
# Helper: read JSONL file
# ============================================================================


def read_jsonl(path: Path) -> tuple[dict, list[dict]]:
    """Read a JSONL index file, returning (header, entries)."""

    with open(path, encoding="utf-8") as f:
        header = json.loads(f.readline())
        entries = [json.loads(line) for line in f if line.strip()]

    return header, entries


# ============================================================================
# save_to_disk / load_from_disk round-trip
# ============================================================================


@pytest.mark.unit
class TestSaveLoadRoundTrip:
    """Tests for save and load round-trip."""

    def test_save_creates_file(self, populated_cache: ConnectionDirectoryCache):
        """save_to_disk should create the JSONL index file."""

        populated_cache.save_to_disk()
        assert populated_cache._persist_path.exists()

    def test_round_trip_preserves_directories(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path):
        """Directories should survive a save/load round-trip."""

        populated_cache.save_to_disk()

        # Create a fresh cache pointing at the same file
        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        loaded = fresh.load_from_disk()
        assert loaded is True
        assert fresh.directory_count == populated_cache.directory_count
        assert fresh.state == CacheState.READY

        # Verify all paths match
        original_results, _ = populated_cache.search("", max_results=100)
        loaded_results, _ = fresh.search("", max_results=100)
        # search("") returns ([], 0) since query is empty — use internal set instead
        with populated_cache._lock:
            original_dirs = set(populated_cache._directories)
        with fresh._lock:
            loaded_dirs = set(fresh._directories)
        assert original_dirs == loaded_dirs

    def test_save_sets_dirty_false(self, populated_cache: ConnectionDirectoryCache):
        """save_to_disk should clear the dirty flag."""

        assert populated_cache._dirty is True  # mutations set dirty
        populated_cache.save_to_disk()
        assert populated_cache._dirty is False

    def test_load_sets_state_ready(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path):
        """load_from_disk should set state to READY."""

        populated_cache.save_to_disk()

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        assert fresh.state == CacheState.EMPTY
        fresh.load_from_disk()
        assert fresh.state == CacheState.READY


# ============================================================================
# JSONL format validation
# ============================================================================


@pytest.mark.unit
class TestJSONLFormat:
    """Tests for the JSONL file format."""

    def test_header_fields(self, populated_cache: ConnectionDirectoryCache):
        """Header line should contain version, connection_id, timestamp, count."""

        populated_cache.save_to_disk()
        header, _ = read_jsonl(populated_cache._persist_path)

        assert header["v"] == CACHE_FILE_VERSION
        assert header["connection_id"] == "persist-test-001"
        assert header["source"] == populated_cache._source_identity
        assert populated_cache.password not in json.dumps(header)
        assert isinstance(header["ts"], float)
        assert header["count"] == populated_cache.directory_count

    @pytest.mark.parametrize(
        "field,value",
        [
            ("host", "other-server"),
            ("share_name", "other-share"),
            ("username", "other-user"),
            ("port", "1445"),
            ("path_prefix", "/other-prefix"),
            ("source_revision", "updated-connection"),
        ],
    )
    def test_retargeted_snapshot_is_rejected(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path, field: str, value: str):
        """A snapshot must belong to the current target, account and connection revision."""
        populated_cache.save_to_disk()
        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id=populated_cache.connection_id,
                host=value if field == "host" else populated_cache.host,
                share_name=value if field == "share_name" else populated_cache.share_name,
                username=value if field == "username" else populated_cache.username,
                password="replacement-password",
                port=int(value) if field == "port" else populated_cache.port,
                path_prefix=value if field == "path_prefix" else populated_cache._path_prefix,
                source_revision=value if field == "source_revision" else "",
            )

        assert fresh.load_from_disk() is False
        assert fresh.directory_count == 0

    def test_legacy_snapshot_is_rejected(self, populated_cache: ConnectionDirectoryCache):
        """Unbound version-one snapshots must trigger a new scan instead of being reused."""
        populated_cache.save_to_disk()
        header, entries = read_jsonl(populated_cache._persist_path)
        header["v"] = 1
        header.pop("source")
        with populated_cache._persist_path.open("w", encoding="utf-8") as snapshot:
            snapshot.write(json.dumps(header) + "\n")
            for entry in entries:
                snapshot.write(json.dumps(entry) + "\n")

        assert populated_cache.load_from_disk() is False

    def test_entry_format(self, populated_cache: ConnectionDirectoryCache):
        """Each entry line should have a 'p' field with the directory path."""

        populated_cache.save_to_disk()
        _, entries = read_jsonl(populated_cache._persist_path)

        assert len(entries) == populated_cache.directory_count
        paths = {e["p"] for e in entries}
        assert "documents" in paths
        assert "music/rock" in paths

    def test_compact_json(self, populated_cache: ConnectionDirectoryCache):
        """JSONL should use compact separators (no spaces)."""

        populated_cache.save_to_disk()
        with open(populated_cache._persist_path, encoding="utf-8") as f:
            first_line = f.readline()

        # No spaces after colons or commas
        assert ": " not in first_line
        assert ", " not in first_line

    def test_file_extension(self, populated_cache: ConnectionDirectoryCache):
        """Persist file should use the configured extension."""

        assert populated_cache._persist_path.suffix == CACHE_FILE_EXTENSION

    def test_persist_subdirectory(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path):
        """Persist file should be under data_dir / CACHE_PERSIST_SUBDIR."""

        populated_cache.save_to_disk()
        assert populated_cache._persist_path.parent == tmp_path / CACHE_PERSIST_SUBDIR


# ============================================================================
# Staleness detection
# ============================================================================


@pytest.mark.unit
class TestStaleness:
    """Tests for snapshot staleness handling."""

    def test_stale_snapshot_rejected(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path):
        """Snapshots older than the configured max staleness should be rejected."""

        populated_cache.save_to_disk()

        # Manually rewrite the header with an old timestamp (31 days past the 30-day limit)
        _, entries = read_jsonl(populated_cache._persist_path)
        max_staleness_seconds = 43200 * 60  # 30 days in seconds
        old_ts = time.time() - max_staleness_seconds - 86400  # 1 day past staleness
        header = {
            "v": CACHE_FILE_VERSION,
            "connection_id": "persist-test-001",
            "source": populated_cache._source_identity,
            "ts": old_ts,
            "count": len(entries),
        }
        with open(populated_cache._persist_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(header) + "\n")
            for e in entries:
                f.write(json.dumps(e) + "\n")

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        loaded = fresh.load_from_disk()
        assert loaded is False
        assert fresh.state == CacheState.EMPTY

    def test_fresh_snapshot_accepted(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path):
        """A recently written snapshot should be accepted."""

        populated_cache.save_to_disk()

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        loaded = fresh.load_from_disk()
        assert loaded is True
        assert fresh.directory_count == populated_cache.directory_count


# ============================================================================
# Version mismatch
# ============================================================================


@pytest.mark.unit
class TestVersionMismatch:
    """Tests for version mismatch handling."""

    def test_wrong_version_rejected(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path):
        """Snapshots with a different version should be rejected."""

        populated_cache.save_to_disk()

        # Rewrite with wrong version
        _, entries = read_jsonl(populated_cache._persist_path)
        header = {
            "v": 999,
            "connection_id": "persist-test-001",
            "ts": time.time(),
            "count": len(entries),
        }
        with open(populated_cache._persist_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(header) + "\n")
            for e in entries:
                f.write(json.dumps(e) + "\n")

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        loaded = fresh.load_from_disk()
        assert loaded is False


# ============================================================================
# Connection ID mismatch
# ============================================================================


@pytest.mark.unit
class TestConnectionIdMismatch:
    """Tests for connection ID mismatch handling."""

    def test_wrong_connection_id_rejected(self, tmp_path: Path):
        """Snapshots with a different connection_id should be rejected."""

        persist_dir = tmp_path / CACHE_PERSIST_SUBDIR
        persist_dir.mkdir(parents=True, exist_ok=True)

        # Write a file for a different connection
        idx_path = persist_dir / f"persist-test-001{CACHE_FILE_EXTENSION}"
        header = {
            "v": CACHE_FILE_VERSION,
            "connection_id": "different-conn-999",
            "ts": time.time(),
            "count": 1,
        }
        with open(idx_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(header) + "\n")
            f.write(json.dumps({"p": "some/dir"}) + "\n")

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            cache = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        loaded = cache.load_from_disk()
        assert loaded is False


# ============================================================================
# Corrupt / empty file handling
# ============================================================================


@pytest.mark.unit
class TestCorruptFile:
    """Tests for corrupt and edge-case file handling."""

    def test_empty_file_rejected(self, cache: ConnectionDirectoryCache):
        """An empty file should be rejected gracefully."""

        cache._persist_path.parent.mkdir(parents=True, exist_ok=True)
        cache._persist_path.write_text("")

        loaded = cache.load_from_disk()
        assert loaded is False

    def test_invalid_json_header_rejected(self, cache: ConnectionDirectoryCache):
        """A file with invalid JSON in the header should be rejected."""

        cache._persist_path.parent.mkdir(parents=True, exist_ok=True)
        cache._persist_path.write_text("this is not json\n")

        loaded = cache.load_from_disk()
        assert loaded is False

    def test_invalid_json_entry_skipped(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path):
        """Invalid JSON in an entry line should not crash; partial load succeeds."""

        populated_cache.save_to_disk()

        # Inject a corrupt line
        with open(populated_cache._persist_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        # Insert corrupt line after header
        lines.insert(1, "NOT VALID JSON\n")
        with open(populated_cache._persist_path, "w", encoding="utf-8") as f:
            f.writelines(lines)

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        # Should raise due to corrupt entry JSON
        loaded = fresh.load_from_disk()
        assert loaded is False

    def test_missing_file_returns_false(self, cache: ConnectionDirectoryCache):
        """load_from_disk should return False if no file exists."""

        loaded = cache.load_from_disk()
        assert loaded is False


# ============================================================================
# Count mismatch (still loads)
# ============================================================================


@pytest.mark.unit
class TestCountMismatch:
    """Tests for header count vs actual entry count mismatch."""

    def test_count_mismatch_still_loads(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path):
        """If count doesn't match entries, cache should still load with warning."""

        populated_cache.save_to_disk()

        # Rewrite header with wrong count
        header, entries = read_jsonl(populated_cache._persist_path)
        header["count"] = 999  # Wrong count
        with open(populated_cache._persist_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(header) + "\n")
            for e in entries:
                f.write(json.dumps(e) + "\n")

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        loaded = fresh.load_from_disk()
        assert loaded is True
        assert fresh.directory_count == len(entries)  # Actual count, not header count


# ============================================================================
# Dirty flag tracking
# ============================================================================


@pytest.mark.unit
class TestDirtyFlag:
    """Tests for dirty flag tracking across mutations."""

    def test_initially_not_dirty(self, cache: ConnectionDirectoryCache):
        """A fresh cache should not be dirty."""

        assert cache._dirty is False

    def test_add_directory_sets_dirty(self, cache: ConnectionDirectoryCache):
        """add_directory should set the dirty flag."""

        cache.add_directory("test/dir")
        assert cache._dirty is True

    def test_add_directories_sets_dirty(self, cache: ConnectionDirectoryCache):
        """add_directories should set the dirty flag."""

        cache.add_directories(["a", "b"])
        assert cache._dirty is True

    def test_remove_directory_sets_dirty(self, populated_cache: ConnectionDirectoryCache):
        """remove_directory should set the dirty flag."""

        populated_cache._dirty = False  # Reset
        populated_cache.remove_directory("documents")
        assert populated_cache._dirty is True

    def test_rename_directory_sets_dirty(self, populated_cache: ConnectionDirectoryCache):
        """rename_directory should set the dirty flag."""

        populated_cache._dirty = False  # Reset
        populated_cache.rename_directory("music", "audio")
        assert populated_cache._dirty is True

    def test_save_clears_dirty(self, populated_cache: ConnectionDirectoryCache):
        """save_to_disk should clear the dirty flag."""

        assert populated_cache._dirty is True
        populated_cache.save_to_disk()
        assert populated_cache._dirty is False


# ============================================================================
# Flush on stop
# ============================================================================


@pytest.mark.unit
class TestFlushOnStop:
    """Tests for flushing dirty cache on stop."""

    def test_stop_flushes_dirty_cache(self, populated_cache: ConnectionDirectoryCache):
        """stop() should save to disk if cache is dirty and non-empty."""

        assert populated_cache._dirty is True
        assert populated_cache.directory_count > 0

        populated_cache.stop()

        # File should have been written
        assert populated_cache._persist_path.exists()

    def test_stop_skips_flush_if_clean(self, populated_cache: ConnectionDirectoryCache):
        """stop() should not write if cache is not dirty."""

        populated_cache.save_to_disk()  # Clears dirty
        populated_cache._persist_path.unlink()  # Remove the file

        populated_cache.stop()

        # File should NOT have been recreated
        assert not populated_cache._persist_path.exists()

    def test_stop_skips_flush_if_empty(self, cache: ConnectionDirectoryCache):
        """stop() should not write if cache has no directories."""

        cache._dirty = True  # Simulate dirty but empty

        cache.stop()

        assert not cache._persist_path.exists()


# ============================================================================
# delete_persist_file
# ============================================================================


@pytest.mark.unit
class TestDeletePersistFile:
    """Tests for delete_persist_file."""

    def test_deletes_existing_file(self, populated_cache: ConnectionDirectoryCache):
        """delete_persist_file should remove the index file."""

        populated_cache.save_to_disk()
        assert populated_cache._persist_path.exists()

        populated_cache.delete_persist_file()
        assert not populated_cache._persist_path.exists()

    def test_deletes_backup_file_too(self, populated_cache: ConnectionDirectoryCache):
        """delete_persist_file should also remove the .bak backup."""

        populated_cache.save_to_disk()
        # Save a second time to create both .idx and .bak
        populated_cache._dirty = True
        populated_cache.save_to_disk()

        backup_path = populated_cache._persist_path.with_suffix(CACHE_BACKUP_EXTENSION)
        assert populated_cache._persist_path.exists()
        assert backup_path.exists()

        populated_cache.delete_persist_file()
        assert not populated_cache._persist_path.exists()
        assert not backup_path.exists()

    def test_no_error_if_file_missing(self, cache: ConnectionDirectoryCache):
        """delete_persist_file should not raise if no file exists."""

        cache.delete_persist_file()  # Should not raise


# ============================================================================
# Backup file handling
# ============================================================================


@pytest.mark.unit
class TestBackupFile:
    """Tests for .bak backup file creation and fallback."""

    def test_save_creates_backup(self, populated_cache: ConnectionDirectoryCache):
        """Second save should create a .bak backup of the previous file."""

        populated_cache.save_to_disk()
        backup_path = populated_cache._persist_path.with_suffix(CACHE_BACKUP_EXTENSION)
        assert not backup_path.exists()  # First save — no previous file

        # Mutate and save again
        populated_cache.add_directory("new/dir")
        populated_cache.save_to_disk()
        assert backup_path.exists()

    def test_backup_contains_previous_snapshot(self, populated_cache: ConnectionDirectoryCache):
        """The .bak file should contain the data from the previous save."""

        populated_cache.save_to_disk()
        original_count = populated_cache.directory_count

        # Mutate and save again
        populated_cache.add_directory("new/dir")
        populated_cache.save_to_disk()

        backup_path = populated_cache._persist_path.with_suffix(CACHE_BACKUP_EXTENSION)
        header, entries = read_jsonl(backup_path)
        assert header["count"] == original_count
        assert len(entries) == original_count

    def test_fallback_to_backup_on_corrupt_main(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path):
        """If the main file is corrupt, load_from_disk should fall back to backup."""

        populated_cache.save_to_disk()

        # Save again to create .bak
        populated_cache.add_directory("extra/dir")
        populated_cache.save_to_disk()

        # Corrupt the main file
        populated_cache._persist_path.write_text("CORRUPT DATA\n")

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        loaded = fresh.load_from_disk()
        assert loaded is True
        # Should have the previous snapshot's count (without "extra/dir")
        assert fresh.state == CacheState.READY

    def test_fallback_to_backup_on_missing_main(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path):
        """If the main file is missing but backup exists, should load from backup."""

        populated_cache.save_to_disk()

        # Save again to create .bak
        populated_cache.add_directory("extra/dir")
        populated_cache.save_to_disk()

        # Remove the main file
        populated_cache._persist_path.unlink()

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        loaded = fresh.load_from_disk()
        assert loaded is True
        assert fresh.state == CacheState.READY


# ============================================================================
# Config-driven settings
# ============================================================================


@pytest.mark.unit
class TestConfigDrivenSettings:
    """Tests for config-driven cache settings."""

    def test_custom_location_absolute(self, tmp_path: Path):
        """Custom absolute location should be used for persist path."""

        custom_dir = tmp_path / "custom_cache"
        with (
            patch("app.services.directory_cache.static") as mock_static,
            patch("app.services.directory_cache.settings") as mock_settings,
        ):
            mock_static.data_dir = tmp_path
            mock_settings.directory_cache_location = str(custom_dir)
            mock_settings.directory_cache_coalesce_interval_seconds = 30
            mock_settings.directory_cache_max_staleness_minutes = 43200
            cache = ConnectionDirectoryCache(
                connection_id="config-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        assert cache._persist_path.parent == custom_dir

    def test_custom_location_relative(self, tmp_path: Path):
        """Custom relative location should be resolved against data_dir."""

        with (
            patch("app.services.directory_cache.static") as mock_static,
            patch("app.services.directory_cache.settings") as mock_settings,
        ):
            mock_static.data_dir = tmp_path
            mock_settings.directory_cache_location = "my_cache"
            mock_settings.directory_cache_coalesce_interval_seconds = 30
            mock_settings.directory_cache_max_staleness_minutes = 43200
            cache = ConnectionDirectoryCache(
                connection_id="config-test-002",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        assert cache._persist_path.parent == tmp_path / "my_cache"

    def test_empty_location_uses_default(self, tmp_path: Path):
        """Empty location should use default data_dir / CACHE_PERSIST_SUBDIR."""

        with (
            patch("app.services.directory_cache.static") as mock_static,
            patch("app.services.directory_cache.settings") as mock_settings,
        ):
            mock_static.data_dir = tmp_path
            mock_settings.directory_cache_location = ""
            mock_settings.directory_cache_coalesce_interval_seconds = 30
            mock_settings.directory_cache_max_staleness_minutes = 43200
            cache = ConnectionDirectoryCache(
                connection_id="config-test-003",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        assert cache._persist_path.parent == tmp_path / CACHE_PERSIST_SUBDIR

    def test_custom_staleness_is_respected(self, populated_cache: ConnectionDirectoryCache, tmp_path: Path, _mock_settings):
        """Custom max_staleness_minutes should be used for staleness check."""

        populated_cache.save_to_disk()

        # Set a very short staleness (1 minute)
        _mock_settings.directory_cache_max_staleness_minutes = 1

        # Rewrite header with timestamp 2 minutes old
        _, entries = read_jsonl(populated_cache._persist_path)
        old_ts = time.time() - 120  # 2 minutes old
        header = {
            "v": CACHE_FILE_VERSION,
            "connection_id": "persist-test-001",
            "source": populated_cache._source_identity,
            "ts": old_ts,
            "count": len(entries),
        }
        with open(populated_cache._persist_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(header) + "\n")
            for e in entries:
                f.write(json.dumps(e) + "\n")

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path
            fresh = ConnectionDirectoryCache(
                connection_id="persist-test-001",
                host="server.local",
                share_name="testshare",
                username="testuser",
                password="testpass",
            )

        loaded = fresh.load_from_disk()
        assert loaded is False  # 2 min old > 1 min limit


# ============================================================================
# Persistence constants
# ============================================================================


@pytest.mark.unit
class TestPersistenceConstants:
    """Verify persistence constants have sensible values."""

    def test_file_version_positive(self):
        """File version should be a positive integer."""

        assert CACHE_FILE_VERSION >= 1

    def test_file_extension_starts_with_dot(self):
        """File extension should start with a dot."""

        assert CACHE_FILE_EXTENSION.startswith(".")

    def test_backup_extension_starts_with_dot(self):
        """Backup extension should start with a dot."""

        assert CACHE_BACKUP_EXTENSION.startswith(".")

    def test_backup_extension_differs_from_main(self):
        """Backup extension should differ from the main extension."""

        assert CACHE_BACKUP_EXTENSION != CACHE_FILE_EXTENSION

    def test_persist_subdir_non_empty(self):
        """Persist subdirectory name should not be empty."""

        assert len(CACHE_PERSIST_SUBDIR) > 0


# ============================================================================
# Manager: load-on-create
# ============================================================================


@pytest.mark.asyncio
@pytest.mark.unit
class TestManagerLoadOnCreate:
    """Tests for DirectoryCacheManager.get_or_create_cache loading from disk."""

    async def test_loaded_snapshot_keeps_both_scan_tasks_cancellable(self):
        """Snapshot verification must not replace the periodic task's tracked handle."""
        manager = DirectoryCacheManager()
        verification_started = asyncio.Event()
        periodic_started = asyncio.Event()
        blocked = asyncio.Event()

        async def verification():
            verification_started.set()
            await blocked.wait()

        async def periodic():
            periodic_started.set()
            await blocked.wait()

        with (
            patch.object(ConnectionDirectoryCache, "load_from_disk", return_value=True),
            patch.object(ConnectionDirectoryCache, "_start_watcher"),
            patch.object(ConnectionDirectoryCache, "_start_coalesce_flush"),
            patch.object(ConnectionDirectoryCache, "_run_rescan", side_effect=verification),
            patch.object(ConnectionDirectoryCache, "_periodic_rescan_loop", side_effect=periodic),
        ):
            cache = await manager.get_or_create_cache("task-test", "host", "share", "user", "password")
            await verification_started.wait()
            await periodic_started.wait()
            verification_task = cache._verification_task
            periodic_task = cache._rescan_task
            assert verification_task is not None
            assert periodic_task is not None
            assert verification_task is not periodic_task

            cache._request_stop()
            await asyncio.gather(verification_task, periodic_task, return_exceptions=True)

        assert verification_task.cancelled()
        assert periodic_task.cancelled()

    async def test_loads_snapshot_instead_of_scanning(self, tmp_path: Path):
        """When a valid snapshot exists, manager should load it and skip initial scan."""

        persist_dir = tmp_path / CACHE_PERSIST_SUBDIR
        persist_dir.mkdir(parents=True, exist_ok=True)

        conn_id = "mgr-test-001"

        # Write a valid snapshot
        idx_path = persist_dir / f"{conn_id}{CACHE_FILE_EXTENSION}"
        header = {
            "v": CACHE_FILE_VERSION,
            "connection_id": conn_id,
            "source": {
                "host": "server.local",
                "share_name": "testshare",
                "port": 445,
                "path_prefix": "",
                "username": "testuser",
                "revision": "",
            },
            "ts": time.time(),
            "count": 3,
        }
        with open(idx_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(header) + "\n")
            f.write(json.dumps({"p": "dir_a"}) + "\n")
            f.write(json.dumps({"p": "dir_b"}) + "\n")
            f.write(json.dumps({"p": "dir_c"}) + "\n")

        manager = DirectoryCacheManager()

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path

            # Patch start_scan to verify it's NOT called, and _run_rescan to be a no-op
            with (
                patch.object(ConnectionDirectoryCache, "start_scan", new_callable=AsyncMock) as mock_scan,
                patch.object(ConnectionDirectoryCache, "_run_rescan", new_callable=AsyncMock),
                patch.object(ConnectionDirectoryCache, "_start_watcher"),
                patch.object(ConnectionDirectoryCache, "_start_periodic_rescan"),
                patch.object(ConnectionDirectoryCache, "_start_coalesce_flush"),
            ):
                cache = await manager.get_or_create_cache(
                    connection_id=conn_id,
                    host="server.local",
                    share_name="testshare",
                    username="testuser",
                    password="testpass",
                )

                # start_scan should NOT have been called (snapshot was loaded)
                mock_scan.assert_not_called()

        assert cache.state == CacheState.READY
        assert cache.directory_count == 3
        assert cache.search("dir_a") == (["dir_a"], 1)

        # Clean up
        cache._stop_event.set()

    async def test_falls_back_to_scan_without_snapshot(self, tmp_path: Path):
        """Without a snapshot, manager should start a full scan."""

        manager = DirectoryCacheManager()

        with patch("app.services.directory_cache.static") as mock_static:
            mock_static.data_dir = tmp_path

            with patch.object(ConnectionDirectoryCache, "start_scan", new_callable=AsyncMock) as mock_scan:
                cache = await manager.get_or_create_cache(
                    connection_id="mgr-test-002",
                    host="server.local",
                    share_name="testshare",
                    username="testuser",
                    password="testpass",
                )

                mock_scan.assert_called_once()

        cache._stop_event.set()
