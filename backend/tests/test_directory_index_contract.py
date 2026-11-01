"""Language-neutral SQLite contract and transaction checks."""

import asyncio
import json
import os
import sqlite3
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.directory_index import MAX_QUERY_BYTES, MAX_QUERY_TERMS, DirectoryIndex, normalize_search_text, search_terms

CONTRACT_ROOT = Path(__file__).resolve().parents[2] / "shared" / "directory-index"


def test_standard_sqlite_runtime_has_required_features():
    from app.services.directory_index import validate_sqlite_runtime

    validate_sqlite_runtime()


def test_directory_query_connection_is_read_only(index):
    assert isinstance(index._connection(), sqlite3.Connection)
    with closing(index._connect(readonly=True)) as reader:
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            reader.execute("UPDATE source_metadata SET accepted_revision = accepted_revision + 1")
    assert index.status().accepted_revision == 0


def test_directory_read_transaction_keeps_metadata_and_rows_consistent(index):
    from app.services.directory_index import transaction

    index.write_paths(["accepted"])
    with closing(index._connect(readonly=True)) as reader, transaction(reader):
        before = reader.execute("SELECT accepted_revision FROM source_metadata").fetchone()
        index.write_paths(["new"])
        assert reader.execute("SELECT accepted_revision FROM source_metadata").fetchone() == before
        assert reader.execute("SELECT path FROM directories ORDER BY path").fetchall() == [("accepted",)]
    assert index.search("accepted new").total_matches == 2
    assert index.status().accepted_revision == before[0] + 1


def test_directory_checkpoint_uses_writer_connection_and_lock(index):
    entered = threading.Event()
    statements = []
    writer = index._connection()
    writer.set_trace_callback(statements.append)

    def checkpoint():
        entered.set()
        index.checkpoint()

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            with index._writer_lock:
                pending = executor.submit(checkpoint)
                assert entered.wait(timeout=5)
                with pytest.raises(TimeoutError):
                    pending.result(timeout=0.05)
                assert not statements
            pending.result(timeout=5)
        assert statements == ["PRAGMA wal_checkpoint(PASSIVE)"]
    finally:
        writer.set_trace_callback(None)


def test_inactive_cleanup_defers_deletion_for_pinned_reader(index):
    from app.services.directory_index import transaction
    from app.services.directory_index_resources import DirectoryIndexResources

    resources = DirectoryIndexResources(index.path.parent)
    index.write_paths(["accepted"])
    with closing(index._connect(readonly=True)) as reader, transaction(reader):
        accessed = reader.execute("SELECT last_access_at_ms FROM source_metadata").fetchone()[0]
        index.write_paths(["new"])
        index.close()
        assert not resources._delete_inactive(index.path, accessed)
        assert index.path.is_file()
        assert reader.execute("SELECT path FROM directories ORDER BY path").fetchall() == [("accepted",)]
    assert resources._delete_inactive(index.path, accessed)
    assert not index.path.exists()


def test_shared_resource_contract_defaults_and_bounds():
    from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT

    assert DIRECTORY_INDEX_CONTRACT.limits["row_batch_size"] == 256
    assert DIRECTORY_INDEX_CONTRACT.policy["disk_budget_bytes"].default == 2 * 1024 * 1024 * 1024
    assert DIRECTORY_INDEX_CONTRACT.policy["inactive_retention_seconds"].default == 7 * 24 * 60 * 60
    assert DIRECTORY_INDEX_CONTRACT.policy["max_retained_inactive_sources"].default == 4
    for field in DIRECTORY_INDEX_CONTRACT.policy.values():
        assert field.validate(field.default) == field.default
        with pytest.raises(ValueError):
            field.validate(0)
        with pytest.raises(ValueError):
            field.validate(True)


def test_directory_disk_accounting_includes_wal_work_and_legacy_files(tmp_path):
    from app.services.directory_index_resources import DirectoryIndexResources

    root = tmp_path / "cache"
    namespace = root / "sqlite"
    namespace.mkdir(parents=True)
    for name in ("source.sqlite3", "source.sqlite3-wal", "source.sqlite3-shm", "source.sqlite3-journal", "temporary.work"):
        (namespace / name).write_bytes(b"1234")
    (root / "legacy.idx").write_bytes(b"123")
    (root / "legacy.bak").write_bytes(b"12")
    resources = DirectoryIndexResources(namespace)
    assert resources.usage().managed_bytes == 25


@pytest.mark.skipif(os.name != "posix", reason="Unix hard-link qualification")
@pytest.mark.parametrize("suffix", ["", ".lease", "-wal", "-shm"])
def test_hard_linked_database_and_sidecars_are_rejected(index, suffix):
    alias = index.path.parent / "alias.data"
    os.link(Path(str(index.path) + suffix), alias)
    other = DirectoryIndex(index.path, source_kind=index.source_kind, source_identity=json.loads(index.source_identity))
    try:
        with pytest.raises(PermissionError, match="hard links"):
            other.open()
        assert index.search("").directory_count == 0
    finally:
        alias.unlink()


@pytest.mark.parametrize(
    "corruption",
    [
        "UPDATE generations SET indexed_count = 1 WHERE id = 1",
        "UPDATE generations SET issue_count = 1 WHERE id = 1",
        "UPDATE generations SET state = 'candidate' WHERE id = 1",
        "UPDATE source_metadata SET selected_generation = NULL WHERE id = 1",
    ],
)
def test_startup_rejects_inconsistent_counts_and_unpublished_selection(index, corruption):
    index._connection().execute(corruption)
    index.close()
    with pytest.raises(ValueError, match="generation metadata"):
        index.open()


def test_namespace_lease_serializes_source_lease_creation(tmp_path):
    import os

    namespace = tmp_path / "private"
    source = DirectoryIndex(namespace / "source.sqlite3", source_kind="smb", source_identity={"id": "fixture"})
    descriptor = DirectoryIndex.acquire_namespace_lease(namespace)
    try:
        with pytest.raises(BlockingIOError):
            source.open()
    finally:
        os.close(descriptor)
    source.open()
    try:
        assert source.search("").directory_count == 0
    finally:
        source.close()


def test_inactive_retention_count_and_leases_preserve_active_sources(tmp_path):
    from app.models.system_settings import DirectoryIndexPolicy
    from app.services.directory_index_resources import DirectoryIndexResources

    namespace = tmp_path / "private"
    indexes = []
    for position, character in enumerate("abc", start=1):
        source = DirectoryIndex(namespace / f"{character * 64}.sqlite3", source_kind="smb", source_identity={"id": character})
        source.open()
        source.write_paths(["accepted"])
        source._connection().execute("UPDATE source_metadata SET last_access_at_ms = ? WHERE id = 1", (position * 1000,))
        indexes.append(source)
    indexes[0].close()
    indexes[1].close()
    resources = DirectoryIndexResources(namespace, DirectoryIndexPolicy(max_retained_inactive_sources=1))
    try:
        assert resources.cleanup_inactive(now_ms=4000) == 1
        assert not indexes[0].path.exists()
        assert indexes[1].path.exists()
        assert indexes[2].path.exists()
        assert indexes[2].search("accepted").total_matches == 1
        resources.register_source(indexes[1].path)
        assert resources.cleanup_inactive(now_ms=1_000_000_000) == 0
        resources.release_source(indexes[1].path)
        assert resources.cleanup_inactive(now_ms=1_000_000_000) == 1
        assert indexes[2].search("accepted").total_matches == 1
    finally:
        for source in indexes:
            source.close()


def test_orphan_lease_cleanup_is_bounded_and_preserves_owners_and_sidecars(tmp_path):
    import os

    from app.services.directory_index_resources import LEASE_CLEANUP_BATCH, DirectoryIndexResources

    namespace = tmp_path / "private"
    namespace.mkdir(mode=0o700)
    resources = DirectoryIndexResources(namespace)
    for number in range(LEASE_CLEANUP_BATCH + 2):
        (namespace / f"{number:064x}.sqlite3.lease").write_bytes(b"")
    held = namespace / f"{'b' * 64}.sqlite3"
    descriptor = DirectoryIndex.acquire_storage_lease(held)
    sidecar = namespace / f"{'c' * 64}.sqlite3"
    Path(str(sidecar) + ".lease").write_bytes(b"")
    Path(str(sidecar) + "-wal").write_bytes(b"held")
    admitted = namespace / f"{'d' * 64}.sqlite3"
    Path(str(admitted) + ".lease").write_bytes(b"")
    resources.register_source(admitted)
    try:
        namespace_descriptor = DirectoryIndex.acquire_namespace_lease(namespace)
        try:
            assert resources.cleanup_orphan_leases() == 0
        finally:
            os.close(namespace_descriptor)
        assert resources.cleanup_orphan_leases() == LEASE_CLEANUP_BATCH
        assert resources.cleanup_orphan_leases() == 2
        assert Path(str(held) + ".lease").exists()
        assert Path(str(sidecar) + ".lease").exists()
        assert Path(str(admitted) + ".lease").exists()
    finally:
        os.close(descriptor)
        resources.release_source(admitted)
    assert resources.cleanup_orphan_leases() == 2
    assert Path(str(sidecar) + ".lease").exists()


def test_retired_cleanup_is_bounded_and_preserves_selected_metadata(index):
    from app.services.directory_index import ROW_BATCH_SIZE

    index.write_paths(f"old/{number}" for number in range(ROW_BATCH_SIZE * 2))
    index.finish_generation(1)
    candidate = index.begin_verification()
    index.write_paths(["selected"], generation_id=candidate)
    assert index.finish_generation(candidate)
    before = index.search("selected")
    assert index.cleanup_retired_batch()
    remaining = index._connection().execute("SELECT indexed_count FROM generations WHERE id = 1").fetchone()
    assert remaining == (ROW_BATCH_SIZE,)
    assert not index.cleanup_retired_batch()
    assert index.search("selected") == before
    assert index._connection().execute("SELECT 1 FROM generations WHERE id = 1").fetchone() is None
    index._connection().execute("INSERT INTO directory_fts(directory_fts, rank) VALUES ('integrity-check', 1)")


def test_source_registration_survives_previous_owner_release(tmp_path):
    from app.services.directory_index_resources import DirectoryIndexResources

    resources = DirectoryIndexResources(tmp_path / "sqlite")
    path = resources.namespace / "source.sqlite3"
    resources.register_source(path)
    resources.register_source(path)
    resources.release_source(path)
    assert resources.active_paths[path] == 1
    resources.release_source(path)
    assert path not in resources.active_paths


def test_incremental_reclamation_preserves_results_and_verification(index):
    from app.services.directory_index import ROW_BATCH_SIZE

    index.write_paths(f"old/{number}/{'long-name-' * 100}" for number in range(ROW_BATCH_SIZE * 2))
    index.finish_generation(1)
    candidate = index.begin_verification()
    index.write_paths(["selected"], generation_id=candidate)
    index.finish_generation(candidate)
    while index.cleanup_retired_batch():
        pass
    before = index.search("selected")
    pages_before = index._connection().execute("PRAGMA page_count").fetchone()[0]
    assert index._connection().execute("PRAGMA freelist_count").fetchone()[0] > 0
    with closing(index._connect(readonly=True)) as reader:
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM directories").fetchone()
        index.touch_access(1)
        assert not index.reclaim_pages()
        assert index._connection().execute("PRAGMA page_count").fetchone()[0] == pages_before
        reader.execute("ROLLBACK")
    assert index.reclaim_pages()
    assert index._connection().execute("PRAGMA page_count").fetchone()[0] < pages_before
    assert index.search("selected") == before


def test_small_wal_does_not_request_checkpoint_admission(index, monkeypatch):
    def unexpected_admission():
        raise AssertionError("A small WAL must not request maintenance admission.")

    monkeypatch.setattr(index, "growth_guard", unexpected_admission)
    assert index.checkpoint_if_due()


def test_normal_checkpoint_defers_for_pinned_reader_without_changing_results(index):
    from app.services.directory_index import CHECKPOINT_WAL_BYTES, ROW_BATCH_SIZE

    index._connection().execute("PRAGMA wal_autocheckpoint = 0")
    with closing(index._connect(readonly=True)) as reader:
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM directories").fetchone()
        index.write_paths(f"match/{number}/{'long-name-' * 100}" for number in range(ROW_BATCH_SIZE * 4))
        before = index.search("match")
        wal = Path(str(index.path) + "-wal")
        assert wal.stat().st_size >= CHECKPOINT_WAL_BYTES
        assert not index.checkpoint_if_due()
        assert wal.stat().st_size >= CHECKPOINT_WAL_BYTES
        reader.execute("ROLLBACK")
    assert index.checkpoint_if_due()
    assert wal.stat().st_size == 0
    assert index.search("match") == before


@pytest.mark.parametrize("missing_table", [False, True])
def test_fts_repair_is_bounded_restartable_and_preserves_rows(index, missing_table):
    from dataclasses import replace

    from app.services.directory_index import ROW_BATCH_SIZE

    index.write_paths(f"match/{number}" for number in range(ROW_BATCH_SIZE + 1))
    index.finish_generation(1)
    before = index.search("match")
    index._connection().execute(
        "DROP TABLE directory_fts" if missing_table else "INSERT INTO directory_fts(directory_fts) VALUES ('delete-all')"
    )
    index.close()
    index.open()
    assert index.needs_fts_repair
    assert index.search("match") == replace(before, query_plan="scan")
    with pytest.raises(RuntimeError, match="being rebuilt"):
        index.mutate_path("remove", "match/0")
    assert index.repair_fts_batch()
    assert index._connection().execute("SELECT count(*) FROM directory_fts_docsize").fetchone()[0] == ROW_BATCH_SIZE
    index.close()
    index.open()
    assert index.needs_fts_repair
    assert index.repair_fts_batch()
    assert not index.repair_fts_batch()
    assert not index.needs_fts_repair
    assert index.search("match") == before
    index.mutate_path("add", "match/extra")
    assert index.search("match").total_matches == before.total_matches + 1


def test_source_close_releases_registration_once(sqlite_cache):
    sqlite_cache.resources.register_source(sqlite_cache._persist_path)
    sqlite_cache.resources.register_source(sqlite_cache._persist_path)
    sqlite_cache._request_stop()
    sqlite_cache._finish_stop()
    sqlite_cache._finish_stop()
    assert sqlite_cache.resources.active_paths[sqlite_cache._persist_path] == 1
    with pytest.raises(InterruptedError, match="replaced or stopped"):
        sqlite_cache.search_index("accepted")


def test_background_fts_repair_releases_actual_scan_ownership_after_failure(sqlite_cache, monkeypatch):
    index = sqlite_cache.index
    index.write_paths(["accepted"])
    index._connection().execute("INSERT INTO directory_fts(directory_fts) VALUES ('delete-all')")
    index.close()
    index.open()
    original = index.repair_fts_batch

    def fail():
        raise OSError("Injected storage failure.")

    monkeypatch.setattr(index, "repair_fts_batch", fail)
    with pytest.raises(OSError, match="storage failure"):
        sqlite_cache._repair_fts_work()
    assert not sqlite_cache._scan_running.is_set()
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    sqlite_cache._manager_scan_slots.release()
    assert index.search("accepted").total_matches == 1
    monkeypatch.setattr(index, "repair_fts_batch", original)
    sqlite_cache._repair_fts_work()
    assert not index.needs_fts_repair
    assert index.search("accepted").query_plan == "trigram"


def test_pressure_reclamation_coalesces_and_defers_for_actual_readers(sqlite_cache, monkeypatch):
    outcomes = iter([False, True])
    calls = []

    def reclaim():
        calls.append(True)
        return next(outcomes)

    monkeypatch.setattr(sqlite_cache.index, "reclaim_pages", reclaim)
    sqlite_cache._reclaim_disk_work()
    assert not calls
    sqlite_cache._reclamation_pending = True
    with monkeypatch.context() as reader:
        reader.setattr(sqlite_cache.index, "_active_queries", 1)
        sqlite_cache._reclaim_disk_work()
        assert not calls
        assert sqlite_cache._reclamation_pending
    sqlite_cache._reclaim_disk_work()
    assert sqlite_cache._reclamation_pending
    sqlite_cache._reclaim_disk_work()
    assert not sqlite_cache._reclamation_pending
    sqlite_cache._reclaim_disk_work()
    assert len(calls) == 2


def test_last_access_update_does_not_change_search_or_verification(index):
    index.write_paths(["accepted"])
    index.finish_generation(1)
    before = index.search("accepted")
    index.touch_access(1000)
    assert index._connection().execute("SELECT last_access_at_ms FROM source_metadata WHERE id = 1").fetchone() == (1000,)
    assert index.search("accepted") == before


def test_directory_disk_admission_preserves_rows_and_releases_reservations(index):
    from app.models.system_settings import DirectoryIndexPolicy
    from app.services.directory_index_resources import DirectoryDiskBudgetError, DirectoryIndexResources

    index.write_paths(["accepted"])
    before = index.search("accepted")
    resources = DirectoryIndexResources(index.path.parent, DirectoryIndexPolicy(disk_budget_bytes=64 * 1024 * 1024))
    index.growth_guard = resources.reserve_growth
    with resources.reserve_growth():
        assert resources.usage().reserved_bytes > 0
        with pytest.raises(DirectoryDiskBudgetError, match="headroom is unavailable"):
            index.write_paths(["refused"])
    assert resources.usage().reserved_bytes == 0
    assert index.search("accepted") == before
    assert index.search("refused").total_matches == 0
    resources.apply_policy(DirectoryIndexPolicy())
    index.write_paths(["restored"])
    assert index.search("restored").total_matches == 1


def test_directory_disk_accounting_rejects_links_without_reading_target(tmp_path):
    from app.services.directory_index_resources import DirectoryIndexResources

    namespace = tmp_path / "sqlite"
    namespace.mkdir()
    outside = tmp_path / "outside"
    outside.write_bytes(b"private")
    (namespace / "linked.sqlite3").symlink_to(outside)
    with pytest.raises(ValueError, match="unsupported entries"):
        DirectoryIndexResources(namespace).usage()
    assert outside.read_bytes() == b"private"


@pytest.mark.asyncio
async def test_backend_idle_release_preserves_sources_with_actual_work(sqlite_cache, monkeypatch):
    import time

    from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT
    from app.services.directory_cache import DirectoryCacheManager

    manager = DirectoryCacheManager()
    manager._caches[sqlite_cache.connection_id] = sqlite_cache
    stopped = []
    monkeypatch.setattr(sqlite_cache, "_finish_stop", lambda: stopped.append(sqlite_cache.connection_id))
    sqlite_cache._last_access = time.monotonic() - DIRECTORY_INDEX_CONTRACT.limits["idle_release_seconds"] - 1
    sqlite_cache._scan_running.set()
    await manager.release_idle_caches()
    assert not stopped
    sqlite_cache._scan_running.clear()
    sqlite_cache._active_workers = 1
    await manager.release_idle_caches()
    assert not stopped
    sqlite_cache._active_workers = 0
    await manager.release_idle_caches()
    assert stopped == [sqlite_cache.connection_id]
    assert manager.get_cache(sqlite_cache.connection_id) is None
    assert not manager._retiring_caches


@pytest.mark.asyncio
async def test_failed_initialization_keeps_bounded_retry_eligibility(sqlite_cache, monkeypatch):
    import time

    sqlite_cache.index.close()
    sqlite_cache._opened.clear()
    started = []

    def unavailable():
        raise BlockingIOError("leased")

    monkeypatch.setattr(sqlite_cache, "_initialize_storage", unavailable)
    monkeypatch.setattr(sqlite_cache, "_start_periodic_rescan", lambda: started.append(True))
    await sqlite_cache._initialize()
    assert sqlite_cache._resource_retry_at > time.monotonic()
    assert "Wait for active workers" in sqlite_cache.scan_error
    assert started == [True]
    assert not sqlite_cache._opened.is_set()


@pytest.mark.asyncio
async def test_source_replacement_does_not_wait_for_old_close(sqlite_cache, monkeypatch):
    from app.services.directory_cache import DirectoryCacheManager, SQLiteConnectionDirectoryCache

    manager = DirectoryCacheManager()
    manager._caches[sqlite_cache.connection_id] = sqlite_cache
    release = threading.Event()
    entered = asyncio.Event()
    loop = asyncio.get_running_loop()

    def finish():
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(timeout=5)

    async def initialize_later(_cache):
        return None

    monkeypatch.setattr(sqlite_cache, "_finish_stop", finish)
    monkeypatch.setattr(SQLiteConnectionDirectoryCache, "start_scan", initialize_later)
    try:
        replacement = await asyncio.wait_for(
            manager.get_or_create_cache(
                sqlite_cache.connection_id,
                sqlite_cache.host,
                sqlite_cache.share_name,
                sqlite_cache.username,
                "replacement-password",
                sqlite_cache.port,
            ),
            timeout=1,
        )
        await asyncio.wait_for(entered.wait(), timeout=5)
        assert replacement is not sqlite_cache
        assert sqlite_cache in manager._retiring_caches
        assert sqlite_cache._stop_event.is_set()
    finally:
        release.set()
        await manager.stop_all_async()


@pytest.mark.asyncio
async def test_cancelled_idle_cleanup_keeps_actual_close_ownership(sqlite_cache, monkeypatch):
    import time

    from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT
    from app.services.directory_cache import DirectoryCacheManager

    manager = DirectoryCacheManager()
    manager._caches[sqlite_cache.connection_id] = sqlite_cache
    sqlite_cache._last_access = time.monotonic() - DIRECTORY_INDEX_CONTRACT.limits["idle_release_seconds"] - 1
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()

    def finish():
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(timeout=5)

    monkeypatch.setattr(sqlite_cache, "_finish_stop", finish)
    cleanup = asyncio.create_task(manager.release_idle_caches())
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        cleanup.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cleanup
        assert sqlite_cache in manager._retiring_caches
    finally:
        release.set()
        await manager.stop_all_async()
    assert not manager._retiring_caches


def test_directory_disk_admission_checks_filesystem_headroom_and_retains_rows(index, monkeypatch):
    from types import SimpleNamespace

    from app.services.directory_index_resources import WRITE_HEADROOM_BYTES, DirectoryDiskBudgetError, DirectoryIndexResources

    index.write_paths(["accepted"])
    before = index.search("accepted")
    resources = DirectoryIndexResources(index.path.parent)
    index.growth_guard = resources.reserve_growth
    monkeypatch.setattr(
        "app.services.directory_index_resources.shutil.disk_usage", lambda _path: SimpleNamespace(free=WRITE_HEADROOM_BYTES - 1)
    )
    with pytest.raises(DirectoryDiskBudgetError, match="insufficient free space"):
        index.write_paths(["refused"])
    assert resources.usage().growth_paused
    assert resources.usage().reserved_bytes == 0
    assert index.search("accepted") == before
    assert index.search("refused").total_matches == 0
    monkeypatch.setattr(
        "app.services.directory_index_resources.shutil.disk_usage", lambda _path: SimpleNamespace(free=WRITE_HEADROOM_BYTES)
    )
    index.write_paths(["restored"])
    assert index.search("restored").total_matches == 1


def test_page_cache_policy_applies_to_connections_without_changing_coverage(index):
    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    before = index.search("accepted")
    index.configure_page_cache(64)
    with closing(index._connect(readonly=True)) as connection:
        assert connection.execute("PRAGMA cache_size").fetchone() == (-64,)
        assert connection.execute("PRAGMA mmap_size").fetchone() == (0,)
    assert index.search("accepted") == before
    with pytest.raises(ValueError, match="integer between"):
        index.configure_page_cache(0)


def test_trigram_query_streams_candidates_without_temporary_id_list(index, monkeypatch):
    traced = []
    original_connect = index._connect

    def connect(**kwargs):
        connection = original_connect(**kwargs)
        connection.set_trace_callback(traced.append)
        return connection

    index.write_paths(["alpha/beta", "alpha", "beta", "neither"])
    monkeypatch.setattr(index, "_connect", connect)
    assert index.search("alpha beta").total_matches == 3
    statement = next(statement for statement in traced if "CROSS JOIN directories" in statement)
    details = [row[3] for row in index._connection().execute("EXPLAIN QUERY PLAN " + statement)]
    assert all("LIST SUBQUERY" not in detail and "TEMP B-TREE" not in detail for detail in details)


def test_resource_policy_model_uses_shared_defaults_and_scope_keys():
    from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT
    from app.core.system_setting_definitions import DIRECTORY_INDEX_SETTING_KEYS, SYSTEM_SETTING_DEFINITIONS, DirectoryIndexPolicyScope
    from app.models.system_settings import DirectoryIndexPolicy

    policy = DirectoryIndexPolicy()
    for scope in DirectoryIndexPolicyScope:
        for field, definition in DIRECTORY_INDEX_CONTRACT.policy.items():
            assert getattr(policy, field) == definition.default
            assert SYSTEM_SETTING_DEFINITIONS[DIRECTORY_INDEX_SETTING_KEYS[scope][field]].default_value == definition.default


@pytest.mark.parametrize("invalid", [0, True, "2048", 2048.5])
def test_resource_policy_model_rejects_unsafe_values(invalid):
    from app.models.system_settings import DirectoryIndexPolicy

    with pytest.raises(ValueError):
        DirectoryIndexPolicy(page_cache_kib=invalid)


def test_resource_policy_model_validates_correlated_intervals():
    from app.models.system_settings import DirectoryIndexPolicy

    with pytest.raises(ValueError, match="must not exceed"):
        DirectoryIndexPolicy(healthy_verification_seconds=60, degraded_verification_seconds=300)


@pytest.mark.parametrize("invalid", [0, True, "2", -1])
def test_shared_resource_contract_rejects_invalid_limits(tmp_path, invalid):
    from app.core.directory_index_contract import load_directory_index_contract

    contract = json.loads((CONTRACT_ROOT / "contract.json").read_text())
    contract["limits"]["query_workers"] = invalid
    path = tmp_path / "invalid.json"
    path.write_text(json.dumps(contract), encoding="utf-8")
    with pytest.raises(ValueError, match="limits are invalid"):
        load_directory_index_contract(path)


@pytest.fixture
def sqlite_cache(index):
    from app.services.directory_cache import DirectoryScanCoordinator, SQLiteConnectionDirectoryCache

    cache = SQLiteConnectionDirectoryCache("fixture", "fixture", "share", "user", "password")
    cache.index = index
    from app.services.directory_index_resources import DirectoryIndexResources

    cache._persist_path = index.path
    cache.resources = DirectoryIndexResources(index.path.parent)
    cache.index.growth_guard = cache.resources.reserve_growth
    cache.coordinator = DirectoryScanCoordinator(index)
    cache._opened.set()
    cache._source_available.set()
    cache._source_probe_completed.set()
    yield cache
    cache._request_stop()
    cache._finish_stop()


def test_root_read_failure_blocks_retained_results_but_descendant_failure_does_not(sqlite_cache, monkeypatch):
    from app.services.directory_cache import DirectorySourceUnavailableError

    sqlite_cache.index.write_paths(["accepted"])

    def missing(*args, **kwargs):
        raise FileNotFoundError("Injected missing source.")

    monkeypatch.setattr("app.services.directory_cache.smbclient.scandir", missing)
    with pytest.raises(FileNotFoundError):
        sqlite_cache._scan_parent(1, "descendant")
    assert sqlite_cache.search_index("accepted").total_matches == 1
    with pytest.raises(DirectorySourceUnavailableError, match="root is unavailable"):
        sqlite_cache._scan_parent(1, "")
    with pytest.raises(DirectorySourceUnavailableError, match="root is unavailable"):
        sqlite_cache.search_index("accepted")
    assert sqlite_cache.index.search("accepted").total_matches == 1


def test_unprobed_root_never_exposes_retained_rows_and_empty_probe_recovers(sqlite_cache, monkeypatch):
    sqlite_cache.index.write_paths(["accepted"])
    sqlite_cache._source_available.clear()
    sqlite_cache._source_probe_completed.clear()
    response = sqlite_cache.search_index("accepted")
    assert not response.results
    assert response.coverage == "partial"
    monkeypatch.setattr("app.services.directory_cache.smbclient.scandir", lambda *args, **kwargs: (entry for entry in []))
    sqlite_cache._probe_source_root()
    assert sqlite_cache.search_index("accepted").total_matches == 1


def test_root_probe_does_not_start_when_scan_capacity_is_owned(sqlite_cache, monkeypatch):
    from app.services.directory_cache import DirectoryScanCapacityError

    def unexpected_read(*args, **kwargs):
        raise AssertionError("An unadmitted root probe must not access SMB.")

    monkeypatch.setattr("app.services.directory_cache.smbclient.scandir", unexpected_read)
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    try:
        with pytest.raises(DirectoryScanCapacityError, match="capacity is in use"):
            sqlite_cache._probe_source_root()
        assert sqlite_cache._source_available.is_set()
        assert not sqlite_cache._scan_running.is_set()
    finally:
        sqlite_cache._manager_scan_slots.release()


def test_invalidated_root_probe_cannot_restore_availability(sqlite_cache, monkeypatch):
    from app.services.directory_cache import ScanObservationInvalidated

    sqlite_cache._source_available.clear()

    def entries(*args, **kwargs):
        sqlite_cache.coordinator.invalidate()
        return
        yield

    monkeypatch.setattr("app.services.directory_cache.smbclient.scandir", entries)
    with pytest.raises(ScanObservationInvalidated, match="root observation became stale"):
        sqlite_cache._probe_source_root()
    assert not sqlite_cache._source_available.is_set()


def test_root_loss_during_query_blocks_late_results(sqlite_cache, monkeypatch):
    from app.services.directory_cache import DirectorySourceUnavailableError

    sqlite_cache.index.write_paths(["accepted"])
    original = sqlite_cache.index.search

    def query(*args, **kwargs):
        response = original(*args, **kwargs)
        sqlite_cache._source_available.clear()
        return response

    monkeypatch.setattr(sqlite_cache.index, "search", query)
    with pytest.raises(DirectorySourceUnavailableError, match="root is unavailable"):
        sqlite_cache.search_index("accepted")


@pytest.mark.asyncio
async def test_pool_entry_failure_marks_root_unavailable_without_discarding_rows(sqlite_cache, monkeypatch):
    from contextlib import asynccontextmanager

    sqlite_cache.index.write_paths(["accepted"])

    @asynccontextmanager
    async def unavailable(**kwargs):
        raise OSError("Injected unavailable SMB session.")
        yield

    async def pool():
        return SimpleNamespace(get_connection=unavailable)

    monkeypatch.setattr("app.services.directory_cache.get_connection_pool", pool)
    await sqlite_cache._run_rescan()
    assert not sqlite_cache._source_available.is_set()
    assert sqlite_cache._source_probe_completed.is_set()
    assert "root is unavailable" in sqlite_cache.scan_error
    assert sqlite_cache.index.search("accepted").total_matches == 1


@pytest.mark.asyncio
async def test_scan_admission_refusal_preserves_known_root_and_retries(sqlite_cache, monkeypatch):
    from contextlib import asynccontextmanager
    from time import monotonic

    @asynccontextmanager
    async def available(**kwargs):
        yield

    async def pool():
        return SimpleNamespace(get_connection=available)

    monkeypatch.setattr("app.services.directory_cache.get_connection_pool", pool)
    assert sqlite_cache._manager_scan_slots.acquire(blocking=False)
    before = monotonic()
    try:
        await sqlite_cache._run_rescan()
        assert sqlite_cache._source_available.is_set()
        assert "capacity is in use" in sqlite_cache.scan_error
        assert before < sqlite_cache._resource_retry_at <= monotonic() + sqlite_cache.policy.degraded_verification_seconds
    finally:
        sqlite_cache._manager_scan_slots.release()


def test_sqlite_source_policy_applies_at_connection_boundaries(sqlite_cache):
    from app.models.system_settings import DirectoryIndexPolicy

    sqlite_cache.index.write_paths(["accepted"])
    before = sqlite_cache.search_index("accepted")
    policy = DirectoryIndexPolicy(page_cache_kib=1024, healthy_verification_seconds=600, degraded_verification_seconds=120)
    sqlite_cache.apply_policy(policy)
    assert sqlite_cache.policy == policy
    assert sqlite_cache.resources.policy == policy
    with closing(sqlite_cache.index._connect(readonly=True)) as connection:
        assert connection.execute("PRAGMA cache_size").fetchone() == (-1024,)
    assert sqlite_cache.search_index("accepted") == before


def test_root_unavailable_api_returns_specific_service_error(sqlite_cache, monkeypatch, client, auth_headers_user, test_connection):
    sqlite_cache.index.write_paths(["accepted"])
    sqlite_cache._source_available.clear()

    async def get_source(**kwargs):
        return sqlite_cache

    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: SimpleNamespace(get_or_create_cache=get_source))
    response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": "accepted"})
    assert response.status_code == 503
    assert "root is unavailable" in response.json()["detail"]
    assert "Restore source access" in response.json()["detail"]


def test_sqlite_source_warm_search_does_not_traverse(sqlite_cache, monkeypatch):
    def unexpected_scan(*args, **kwargs):
        raise AssertionError("A warm directory query must not scan the source.")

    monkeypatch.setattr("app.services.directory_cache.smbclient.scandir", unexpected_scan)
    sqlite_cache.index.write_paths(["alpha/beta", "beta", "neither"])
    assert sqlite_cache.search("alpha beta") == (["alpha/beta", "beta"], 2)
    assert not sqlite_cache._directories


def test_sqlite_api_uses_one_read_view_off_the_event_loop(sqlite_cache, monkeypatch, client, auth_headers_user, test_connection):
    event_loop_threads = []
    query_threads = []
    original_search = sqlite_cache.search_index

    async def get_source(**kwargs):
        event_loop_threads.append(threading.get_ident())
        return sqlite_cache

    def query(*args, **kwargs):
        query_threads.append(threading.get_ident())
        return original_search(*args, **kwargs)

    sqlite_cache.index.write_paths(["alpha/beta", "beta", "neither"])
    monkeypatch.setattr(sqlite_cache, "search_index", query)
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: SimpleNamespace(get_or_create_cache=get_source))
    response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": "alpha beta"})
    assert response.status_code == 200
    body = response.json()
    assert body["results"] == ["alpha/beta", "beta"]
    assert body["matched_term_counts"] == {"alpha/beta": 2, "beta": 1}
    assert body["match_ranks"] == {"alpha/beta": 0, "beta": 0}
    assert body["total_matches"] == 2
    assert body["directory_count"] == 3
    assert body["accepted_revision"] == sqlite_cache.index.status().accepted_revision
    assert body["coverage"] == "partial"
    assert event_loop_threads[0] != query_threads[0]


def test_sqlite_api_empty_query_returns_coverage_without_matches(sqlite_cache, monkeypatch, client, auth_headers_user, test_connection):
    async def get_source(**kwargs):
        return sqlite_cache

    sqlite_cache.index.write_paths(["alpha"])
    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", lambda: SimpleNamespace(get_or_create_cache=get_source))
    response = client.get(f"/api/browse/{test_connection.id}/directories", headers=auth_headers_user, params={"q": ""})
    assert response.status_code == 200
    assert response.json()["results"] == []
    assert response.json()["directory_count"] == 1
    assert response.json()["coverage"] == "partial"


def test_directory_api_rejects_excess_terms_before_source_creation(monkeypatch, client, auth_headers_user, test_connection):
    def unexpected_manager():
        raise AssertionError("Invalid queries must not initialize a directory source.")

    monkeypatch.setattr("app.services.directory_cache.get_directory_cache_manager", unexpected_manager)
    response = client.get(
        f"/api/browse/{test_connection.id}/directories",
        headers=auth_headers_user,
        params={"q": " ".join(f"term{number}" for number in range(MAX_QUERY_TERMS + 1))},
    )
    assert response.status_code == 400
    assert "distinct terms" in response.json()["detail"]


def test_sqlite_source_initial_batches_are_visible_before_parent_completion(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    observed = []

    def scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            for number in range(257):
                if number == 256:
                    observed.append(sqlite_cache.search_index("directory").total_matches)
                yield SimpleNamespace(
                    name=f"directory{number}", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
                )

    monkeypatch.setattr("app.services.directory_cache.smbclient.scandir", scan)
    sqlite_cache._scan_disk_queue()
    assert observed == [256]
    response = sqlite_cache.search_index("directory")
    assert response.directory_count == response.total_matches == 257
    assert response.coverage == "complete"
    assert not sqlite_cache._directories


def test_sqlite_source_rejects_late_parent_observations(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    from app.services.directory_cache import ScanObservationInvalidated

    def scan(path, **kwargs):
        yield SimpleNamespace(name="alpha", smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))
        sqlite_cache.remove_directory("alpha")

    monkeypatch.setattr("app.services.directory_cache.smbclient.scandir", scan)
    with pytest.raises(ScanObservationInvalidated):
        sqlite_cache._scan_disk_queue()
    assert sqlite_cache.search_index("alpha").total_matches == 0
    assert sqlite_cache.coordinator.verification_required


def test_sqlite_source_failed_initial_build_is_verified_in_fresh_candidate(sqlite_cache, monkeypatch):
    sqlite_cache.index.seed_scan(1)
    sqlite_cache.index.write_scan_children(1, [("stale", False)])
    sqlite_cache.index.finish_scan_parent(1, "")

    def empty_scan(path, **kwargs):
        assert sqlite_cache.search_index("stale").total_matches == 1
        yield from ()

    monkeypatch.setattr("app.services.directory_cache.smbclient.scandir", empty_scan)
    sqlite_cache._scan_disk_queue()
    assert sqlite_cache.search_index("stale").total_matches == 0
    assert sqlite_cache.search_index("").coverage == "complete"


@pytest.mark.asyncio
async def test_sqlite_source_cancellation_retains_smb_pool_future(sqlite_cache):
    from unittest.mock import AsyncMock

    started = threading.Event()
    release = threading.Event()
    pool = SimpleNamespace(retain_connection_until_future_complete=AsyncMock())

    def blocked():
        started.set()
        assert release.wait(timeout=5)

    task = asyncio.create_task(sqlite_cache._blocking(blocked, pool=pool))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        pool.retain_connection_until_future_complete.assert_awaited_once()
        connection_cache, future = pool.retain_connection_until_future_complete.call_args.args
        assert connection_cache is sqlite_cache._connection_cache
        assert not future.done()
        release.set()
        await asyncio.wait_for(asyncio.shield(future), timeout=5)
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_sqlite_source_stalled_read_retains_worker_and_pool_ownership(sqlite_cache, monkeypatch):
    from unittest.mock import AsyncMock

    release = threading.Event()
    started = threading.Event()
    pool = SimpleNamespace(retain_connection_until_future_complete=AsyncMock())

    def blocked():
        started.set()
        assert release.wait(timeout=5)

    monkeypatch.setattr("app.services.directory_cache.SCAN_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr("app.services.directory_cache.WORKER_POLL_SECONDS", 0.005)
    try:
        with pytest.raises(TimeoutError, match="capacity stays reserved"):
            await sqlite_cache._blocking(blocked, pool=pool)
        assert started.is_set()
        assert sqlite_cache._active_workers == 1
        pool.retain_connection_until_future_complete.assert_awaited_once()
        future = pool.retain_connection_until_future_complete.call_args.args[1]
        assert not future.done()
        assert sqlite_cache.coordinator.verification_required
        release.set()
        await asyncio.wait_for(asyncio.shield(future), timeout=5)
        assert sqlite_cache._active_workers == 0
    finally:
        release.set()


@pytest.mark.asyncio
async def test_sqlite_source_cancelled_worker_keeps_process_lease(sqlite_cache):
    started = threading.Event()
    release = threading.Event()

    def blocked():
        started.set()
        assert release.wait(timeout=5)

    task = asyncio.create_task(sqlite_cache._blocking(blocked))
    closing = None
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        sqlite_cache._request_stop()
        closing = asyncio.create_task(asyncio.to_thread(sqlite_cache._finish_stop))
        contender = DirectoryIndex(sqlite_cache.index.path, source_kind=sqlite_cache.index.source_kind, source_identity={})
        with pytest.raises(BlockingIOError):
            contender.open()
        assert not closing.done()
    finally:
        release.set()
        if closing is not None:
            await asyncio.wait_for(closing, timeout=5)
        else:
            await asyncio.gather(task, return_exceptions=True)


APPLICATION_ID = 1396853073
SCHEMA_VERSION = 1


def test_generated_unicode_contract_matches_backend() -> None:
    contract = json.loads((CONTRACT_ROOT / "unicode.json").read_text(encoding="utf-8"))
    assert contract["unicode_version"] == unicodedata.unidata_version
    for character, normalized in contract["normalization"]:
        assert normalize_search_text(character) == normalized
    assert contract["whitespace"] == [chr(codepoint) for codepoint in range(0x110000) if chr(codepoint).isspace()]


def test_query_admission_is_bounded(index):
    from app.services.directory_index import QUERY_WORKERS

    for _ in range(QUERY_WORKERS):
        assert index._query_slots.acquire(blocking=False)
    try:
        with pytest.raises(TimeoutError, match="workers are busy"):
            index.search("alpha")
    finally:
        for _ in range(QUERY_WORKERS):
            index._query_slots.release()
    assert index.search("alpha").total_matches == 0


@pytest.mark.parametrize("suffix", ["", "-wal", "-shm", "-journal", ".lease"])
def test_rejects_linked_storage_files_before_sqlite_io(tmp_path, monkeypatch, suffix):
    directory = tmp_path / "private"
    directory.mkdir(mode=0o700)
    path = directory / "source.sqlite3"
    target = tmp_path / "outside"
    target.write_bytes(b"unchanged")
    Path(str(path) + suffix).symlink_to(target)
    store = DirectoryIndex(path, source_kind="local", source_identity={"root": "fixture"})
    monkeypatch.setattr(store, "_connect", lambda **_kwargs: pytest.fail("SQLite I/O must not begin"))
    with pytest.raises(PermissionError, match="regular files"):
        store.open()
    assert target.read_bytes() == b"unchanged"
    assert store._lease_fd is None


def test_new_database_and_lease_are_private(index):
    import os
    import stat

    if os.name == "posix":
        assert stat.S_IMODE(index.path.stat().st_mode) == 0o600
        assert stat.S_IMODE(Path(str(index.path) + ".lease").stat().st_mode) == 0o600


def test_scan_barriers_reject_late_rename_observations(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, ScanObservationInvalidated, _DirectoryMutation

    index.write_paths(["alpha", "alpha/child"])
    coordinator = DirectoryScanCoordinator(index)
    token = coordinator.begin_read("alpha")
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_RENAMED_NEW_NAME, "alpha", "beta"))
    assert coordinator.apply_pending() == 1
    with pytest.raises(ScanObservationInvalidated):
        coordinator.commit_children(token, 1, [("alpha/stale", True)])
    assert index.search("alpha").total_matches == 0
    assert index.search("beta").total_matches == 2


def test_unrelated_mutation_does_not_invalidate_directory_read(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index)
    token = coordinator.begin_read("alpha")
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "unrelated"))
    coordinator.commit_children(token, 1, [("alpha/child", False)])
    assert index.search("alpha unrelated").total_matches == 2


def test_observation_overflow_keeps_pending_updates_and_invalidates_producers(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index, maximum_pending=1)
    token = coordinator.begin_read("alpha")
    assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "accepted"))
    assert not coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_ADDED, "lost"))
    assert len(coordinator.pending) == 1
    assert not coordinator.is_current(token)
    assert coordinator.apply_pending() == 1
    assert index.search("accepted").total_matches == 1
    assert coordinator.verification_required


def test_failed_observation_commit_retains_pending_work(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    index.write_paths(["alpha", "occupied"])
    coordinator = DirectoryScanCoordinator(index)
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_RENAMED_NEW_NAME, "alpha", "occupied"))
    with pytest.raises(sqlite3.IntegrityError):
        coordinator.apply_pending()
    assert len(coordinator.pending) == 1
    assert coordinator.pending_bytes > 0
    assert index.search("alpha occupied").total_matches == 2


def test_generation_acceptance_rejects_change_after_last_parent(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, ScanObservationInvalidated, _DirectoryMutation

    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    generation = index.begin_verification()
    coordinator = DirectoryScanCoordinator(index)
    baseline = coordinator.begin_read("")
    index.seed_scan(generation)
    coordinator.commit_children(baseline, generation, [("candidate", False)])
    coordinator.finish_parent(baseline, generation)
    coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_REMOVED, "candidate"))
    with pytest.raises(ScanObservationInvalidated):
        coordinator.accept_generation(baseline, generation)
    assert index.search("accepted").total_matches == 1
    assert coordinator.verification_required


def test_generation_acceptance_clears_sticky_verification_only_on_success(index):
    from app.services.directory_cache import DirectoryScanCoordinator

    coordinator = DirectoryScanCoordinator(index)
    baseline = coordinator.begin_read("")
    index.seed_scan(1)
    coordinator.commit_children(baseline, 1, [("accepted", False)])
    coordinator.finish_parent(baseline, 1)
    assert coordinator.accept_generation(baseline, 1)
    assert not coordinator.verification_required
    assert index.search("accepted").coverage == "complete"


def test_event_loss_persists_uncertain_coverage_without_losing_accepted_rows(index):
    from app.services.directory_cache import DirectoryScanCoordinator

    index.write_paths(["accepted"])
    assert index.finish_generation(1)
    verified = index.status().last_verified_at_ms
    coordinator = DirectoryScanCoordinator(index)
    coordinator.invalidate()
    coordinator.apply_pending()
    response = index.search("accepted")
    assert response.total_matches == 1
    assert response.coverage == "uncertain"
    assert response.issue_count == 1
    assert response.last_verified_at_ms == verified
    revision = response.accepted_revision
    coordinator.apply_pending()
    assert index.status().accepted_revision == revision
    assert coordinator.verification_required


def test_unresolved_issue_rows_cannot_be_selected_as_complete(index):
    index.write_paths(["partial"])
    index.mark_uncertain()
    assert not index.finish_generation(1)
    response = index.search("partial")
    assert response.coverage == "uncertain"
    assert response.issue_count == 1
    generation, selected = index.prepare_scan()
    assert not selected
    assert generation != 1


def test_failed_generation_issue_count_agrees_with_issue_rows(index):
    assert not index.finish_generation(1, issue_count=3)
    with index._writer_lock:
        aggregate = index._connection().execute("SELECT sum(count) FROM coverage_issues WHERE generation_id = 1").fetchone()[0]
    assert index.status().issue_count == aggregate == 3


def test_sqlite_source_watcher_gap_invalidates_scan_and_coverage(sqlite_cache):
    sqlite_cache.index.write_paths(["accepted"])
    assert sqlite_cache.index.finish_generation(1)
    token = sqlite_cache.coordinator.begin_read("accepted")
    sqlite_cache._observation_lost()
    assert not sqlite_cache.coordinator.is_current(token)
    sqlite_cache.coordinator.apply_pending()
    response = sqlite_cache.search_index("accepted")
    assert response.coverage == "uncertain"
    assert response.total_matches == 1
    assert sqlite_cache.scan_error is not None


def test_sqlite_source_bounds_batch_bytes_without_limiting_coverage(sqlite_cache, monkeypatch):
    from smbclient._os import FileAttributes

    sizes = []
    original_commit = sqlite_cache.coordinator.commit_children

    def commit(token, generation, batch):
        sizes.append(sum(len(path.encode("utf-8")) for path, _descend in batch))
        original_commit(token, generation, batch)

    def scan(path, **kwargs):
        if path == sqlite_cache._smb_base_path:
            for name in ("alpha", "beta", "gamma"):
                yield SimpleNamespace(name=name, smb_info=SimpleNamespace(file_attributes=FileAttributes.FILE_ATTRIBUTE_DIRECTORY))

    monkeypatch.setattr("app.services.directory_cache.MAX_OBSERVATION_BYTES", 9)
    monkeypatch.setattr("app.services.directory_cache.smbclient.scandir", scan)
    monkeypatch.setattr(sqlite_cache.coordinator, "commit_children", commit)
    sqlite_cache._scan_disk_queue()
    assert sizes == [9, 5]
    assert sqlite_cache.search_index("alpha beta gamma").total_matches == 3


def test_rename_barriers_cannot_exceed_observation_limit(index):
    from smbprotocol.change_notify import FileAction

    from app.services.directory_cache import DirectoryScanCoordinator, _DirectoryMutation

    coordinator = DirectoryScanCoordinator(index, maximum_pending=1)
    baseline = coordinator.begin_read("")
    assert coordinator.enqueue(_DirectoryMutation(FileAction.FILE_ACTION_RENAMED_NEW_NAME, "alpha", "beta"))
    assert len(coordinator.barriers) <= coordinator.maximum_pending
    assert not coordinator.is_current(baseline)


def test_subtree_mutations_update_pending_scan_paths_transactionally(index):
    index.seed_scan(1)
    index.write_scan_children(1, [("alpha", True), ("alpha/child", True), ("other", True)])
    index.finish_scan_parent(1, "alpha")
    index.mutate_path("rename", "alpha", "beta")
    assert index.pending_scan_paths(1) == ["", "beta", "beta/child", "other"]
    index.mutate_path("remove", "beta")
    assert index.pending_scan_paths(1) == ["", "other"]
    assert index.search("alpha beta").total_matches == 0


def test_scan_queue_rename_collision_rolls_back_directory_changes(index):
    index.seed_scan(1)
    index.write_scan_children(1, [("alpha", True), ("occupied", True)])
    index.mutate_path("remove", "occupied")
    with index._writer_lock, index._connection() as connection:
        connection.execute("INSERT INTO scan_queue(generation_id, path) VALUES (1, 'occupied')")
    revision = index.status().accepted_revision
    with pytest.raises(sqlite3.IntegrityError):
        index.mutate_path("rename", "alpha", "occupied")
    assert index.search("alpha").total_matches == 1
    assert index.search("occupied").total_matches == 0
    assert index.pending_scan_paths(1) == ["", "alpha", "occupied"]
    assert index.status().accepted_revision == revision


def test_pending_work_blocks_complete_generation_and_unbounded_batches(index):
    from itertools import count

    from app.services.directory_index import ROW_BATCH_SIZE

    index.seed_scan(1)
    with pytest.raises(ValueError, match="work remains queued"):
        index.finish_generation(1)
    observed = []

    def children():
        for number in count():
            observed.append(number)
            yield f"directory{number}", True

    with pytest.raises(ValueError):
        index.write_scan_children(1, children())
    assert len(observed) == ROW_BATCH_SIZE + 1
    assert index.search("").directory_count == 0
    index.finish_scan_parent(1, "")
    assert index.finish_generation(1)


def test_close_retains_process_lease_until_readers_exit(index, monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    closed = threading.Event()
    original_connect = index._connect

    def connect(*, readonly=False):
        if readonly:
            entered.set()
            assert release.wait(timeout=5)
        return original_connect(readonly=readonly)

    def close():
        index.close()
        closed.set()

    monkeypatch.setattr(index, "_connect", connect)
    with ThreadPoolExecutor(max_workers=2) as executor:
        query = executor.submit(index.search, "alpha")
        try:
            assert entered.wait(timeout=5)
            shutdown = executor.submit(close)
            assert not closed.wait(timeout=0.1)
            competing = DirectoryIndex(index.path, source_kind=index.source_kind, source_identity=json.loads(index.source_identity))
            with pytest.raises(BlockingIOError):
                competing.open()
        finally:
            release.set()
        assert query.result(timeout=5).total_matches == 0
        shutdown.result(timeout=5)
    assert closed.is_set()


@pytest.fixture
def database(tmp_path):
    with closing(sqlite3.connect(tmp_path / "index.sqlite3")) as connection:
        connection.executescript((CONTRACT_ROOT / "schema.sql").read_text())
        connection.executescript((CONTRACT_ROOT / "fts.sql").read_text())
        connection.execute("INSERT INTO generations(id, state, coverage) VALUES (1, 'building', 'partial')")
        connection.commit()
        yield connection


def insert_directory(database, path):
    database.execute(
        "INSERT INTO directories(generation_id, path, path_key, basename_key, depth, has_dot_directory) VALUES (1, ?, ?, ?, ?, 0)",
        (path, path, path.rsplit("/", 1)[-1], path.count("/")),
    )


def test_schema_identifiers_and_fts(database):
    assert database.execute("PRAGMA application_id").fetchone()[0] == APPLICATION_ID
    assert database.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    assert database.execute("PRAGMA auto_vacuum").fetchone()[0] == 2
    insert_directory(database, "alpha/beta")
    assert database.execute("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH ?", ('"alpha" OR "beta"',)).fetchone()[0] == 1


def test_fts_counts_and_rollback(database):
    insert_directory(database, "alpha")
    database.commit()
    with pytest.raises(RuntimeError), database:
        database.execute("UPDATE directories SET path = 'beta', path_key = 'beta' WHERE path = 'alpha'")
        raise RuntimeError("injected failure")
    assert database.execute("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH 'alpha'").fetchone()[0] == 1
    assert database.execute("SELECT indexed_count FROM generations").fetchone()[0] == 1
    with database:
        database.execute("DELETE FROM generations WHERE id = 1")
    assert database.execute("SELECT count(*) FROM directory_fts WHERE directory_fts MATCH 'alpha'").fetchone()[0] == 0


@pytest.mark.parametrize("path", ["", "/alpha", "alpha/", "a//b", "a/./b", "a/../b", "a\x00b"])
def test_invalid_paths(database, path):
    with pytest.raises(sqlite3.IntegrityError):
        insert_directory(database, path)


@pytest.fixture
def index(tmp_path):
    store = DirectoryIndex(tmp_path / "source.sqlite3", source_kind="smb", source_identity={"connection_id": "test", "host": "test"})
    store.open()
    try:
        yield store
    finally:
        store.close()


def test_shared_normalization_and_terms():
    fixtures = json.loads((CONTRACT_ROOT / "search-fixtures.json").read_text())
    for case in fixtures["normalization"]:
        assert normalize_search_text(case["input"]) == case["expected"]
    for case in fixtures["queries"]:
        assert search_terms(case["query"]) == tuple(sorted(case["terms"]))


def test_shared_search_scan_and_fts_parity(index):
    fixtures = json.loads((CONTRACT_ROOT / "search-fixtures.json").read_text())
    index.write_paths(fixtures["paths"])
    for case in fixtures["searches"]:
        for force_scan in (False, True):
            response = index.search(case["query"], include_dot_directories=case["include_dot"], force_scan=force_scan)
            assert response.total_matches == case["count"]
            assert [row.path for row in response.results] == case["results"]


def test_candidate_failure_preserves_accepted_data(index):
    index.write_paths(["old/alpha"])
    assert index.finish_generation(1)
    accepted = index.search("alpha")
    candidate = index.begin_verification()
    index.write_paths(["new/beta"], generation_id=candidate)
    assert not index.finish_generation(candidate, issue_count=1)
    assert index.search("alpha") == accepted
    index.write_paths(["other/alpha"])
    assert index.search("alpha").total_matches == 2
    assert index.search("alpha").last_verified_at_ms == accepted.last_verified_at_ms


def test_candidate_selection_is_atomic_and_reopens(index):
    index.write_paths(["old/alpha"])
    index.finish_generation(1)
    candidate = index.begin_verification()
    index.write_paths(["new/beta"], generation_id=candidate)
    assert index.search("beta").total_matches == 0
    assert index.finish_generation(candidate)
    assert index.search("alpha").total_matches == 0
    assert index.search("beta").total_matches == 1
    index.close()
    index.open()
    assert index.search("beta").directory_count == 1


def test_source_kind_and_identity_must_match(index):
    index.close()
    other = DirectoryIndex(index.path, source_kind="local", source_identity={"connection_id": "test", "host": "test"})
    with pytest.raises(ValueError, match="source or policy"):
        other.open()
    with pytest.raises(RuntimeError, match="not initialized"):
        other.search("alpha")


def test_late_scan_cannot_write_completed_generation(index):
    index.write_paths(["alpha"])
    index.finish_generation(1)
    with pytest.raises(ValueError, match="no longer active"):
        index.write_paths(["late/alpha"], generation_id=1)
    assert index.search("alpha").total_matches == 1


def test_integer_overflow_rolls_back(database):
    with database:
        database.execute("UPDATE generations SET indexed_count = ?", ((1 << 63) - 1,))
    with pytest.raises(sqlite3.IntegrityError), database:
        insert_directory(database, "alpha")
    assert database.execute("SELECT count(*) FROM directories").fetchone()[0] == 0


def test_literal_operators_and_colliding_keys(index):
    index.write_paths(['a%/_*/"quoted"', "Straße", "STRASSE"])
    assert index.search('a% _* "quoted"').total_matches == 1
    assert index.search("strasse").total_matches == 2


def test_cancelled_query_has_no_success_response(index):
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(InterruptedError):
        index.search("alpha", cancelled=cancelled)


def test_input_limits_are_not_silent():
    with pytest.raises(ValueError, match="UTF-8 bytes"):
        search_terms("x" * (MAX_QUERY_BYTES + 1))
    with pytest.raises(ValueError, match="distinct terms"):
        search_terms(" ".join(f"term{number}" for number in range(MAX_QUERY_TERMS + 1)))


@pytest.mark.parametrize(
    "count",
    [
        100_001,
        pytest.param(
            1_000_001,
            marks=pytest.mark.skipif(
                os.environ.get("DIRECTORY_INDEX_CAPACITY_TEST") != "1",
                reason="Set DIRECTORY_INDEX_CAPACITY_TEST=1 to run the separate million-path capacity check.",
            ),
        ),
    ],
)
def test_coverage_above_old_cutoff_and_bounded_results(index, count):
    index.write_paths(f"directory-{number:06d}" for number in range(count))
    managed_bytes = sum(path.stat().st_size for path in index.path.parent.iterdir() if path.is_file())
    print(f"directory_index_fixture rows={count} managed_bytes={managed_bytes}")
    for query in ["directory", "ry"]:
        response = index.search(query, limit=3)
        assert response.directory_count == response.total_matches == count
        assert len(response.results) == 3
    assert index.search("100000").results[0].path == "directory-100000"
    index.finish_generation(1)
    index.close()
    index.open()
    assert index.search("100000").directory_count == count


def test_mutations_update_accepted_candidate_fts_and_preserve_verification(index):
    index.write_paths(["parent/alpha", "parent/alpha/child", "parent/alpha-other"])
    index.finish_generation(1)
    before = index.search("alpha")
    candidate = index.begin_verification()
    index.write_paths(["parent/alpha", "parent/alpha/child", "parent/alpha-other"], generation_id=candidate)
    index.mutate_path("rename", "parent/alpha", "new/.beta")
    assert index.search("alpha").total_matches == 1
    assert index.search("beta").total_matches == 0
    assert index.search("beta", include_dot_directories=True).total_matches == 2
    assert index.search("beta", include_dot_directories=True).last_verified_at_ms == before.last_verified_at_ms
    index.mutate_path("remove", "new/.beta")
    index.mutate_path("add", "fresh/beta")
    assert index.search("beta").total_matches == 1
    index.finish_generation(candidate)
    assert index.search("beta").results[0].path == "fresh/beta"
    assert index.search("alpha").total_matches == 1


@pytest.mark.parametrize("identifier", [-(1 << 63), -1, 0], ids=["minimum-signed-id", "negative-id", "zero-id"])
def test_rename_includes_nonpositive_row_ids(index, identifier):
    index.write_paths(["alpha", "alpha/child"])
    index._connection().execute("UPDATE directories SET id = ? WHERE path = 'alpha'", (identifier,))
    index.finish_generation(1)
    before = index.search("alpha")

    index.mutate_path("rename", "alpha", "beta")

    after = index.search("beta")
    assert {result.path for result in after.results} == {"beta", "beta/child"}
    assert after.directory_count == after.total_matches == before.directory_count == 2
    assert after.last_verified_at_ms == before.last_verified_at_ms
    assert index.search("alpha").total_matches == 0
    assert index._connection().execute("SELECT id FROM directories WHERE path = 'beta'").fetchone() == (identifier,)


def test_rename_conflict_rolls_back_rows_counts_and_revision(index):
    index.write_paths(["alpha", "beta"])
    before = index.search("alpha beta")
    with pytest.raises(sqlite3.IntegrityError):
        index.mutate_path("rename", "alpha", "beta")
    assert index.search("alpha beta") == before


def test_scan_queue_is_disk_backed_and_deduplicated(index):
    index.seed_scan(1)
    assert index.pending_scan_paths(1) == [""]
    index.write_scan_children(1, [("alpha", True), ("link", False)])
    index.write_scan_children(1, [("alpha", True)])
    index.finish_scan_parent(1, "")
    assert index.pending_scan_paths(1) == ["alpha"]
    index.finish_scan_parent(1, "alpha")
    assert index.pending_scan_paths(1) == []
    assert index.status().directory_count == 2


def test_scan_queue_failure_rolls_back_directory_rows(index):
    index._connection().execute("CREATE TRIGGER fail_queue BEFORE INSERT ON scan_queue BEGIN SELECT RAISE(ABORT, 'injected'); END")
    with pytest.raises(sqlite3.IntegrityError, match="injected"):
        index.write_scan_children(1, [("alpha", True)])
    assert index.search("alpha").total_matches == 0
    assert index.status().accepted_revision == 0


def test_process_lease_prevents_two_writers(index):
    second = DirectoryIndex(index.path, source_kind="smb", source_identity={"connection_id": "test", "host": "test"})
    with pytest.raises(BlockingIOError):
        second.open()
    index.close()
    second.open()
    second.close()


def test_private_storage_rejects_links_and_public_permissions(tmp_path):
    public = tmp_path / "public"
    public.mkdir(mode=0o755)
    store = DirectoryIndex(public / "source.sqlite3", source_kind="local", source_identity={"root": "test"})
    with pytest.raises(PermissionError, match="0700"):
        store.open()
    link = tmp_path / "link"
    link.symlink_to(public, target_is_directory=True)
    store = DirectoryIndex(link / "source.sqlite3", source_kind="local", source_identity={"root": "test"})
    with pytest.raises(PermissionError, match="symbolic"):
        store.open()


def test_open_failure_releases_process_lease(index, monkeypatch):
    index.close()
    with monkeypatch.context() as context:
        context.setattr(index, "_connect", lambda **_kwargs: (_ for _ in ()).throw(sqlite3.OperationalError("injected")))
        with pytest.raises(sqlite3.OperationalError, match="injected"):
            index.open()
    assert index._lease_fd is None
    index.open()
