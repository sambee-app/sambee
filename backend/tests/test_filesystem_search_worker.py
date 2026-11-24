"""Exercise response ownership, limits, and archive scope for SMB searches."""

import asyncio
import io
import json
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from unittest.mock import Mock

import pytest

from app.core.filesystem_search_contract import SearchRequest
from app.services.archive.zip_reader import ZipReader
from app.services.directory_traversal import SmbDirectoryEntry, SmbDirectoryEntryInformation
from app.services.filesystem_search_admission import SearchAdmission, SearchAdmissionError, SearchAdmissionReason
from app.services.filesystem_search_archive import ArchiveSearchTooLarge, read_search_entries
from app.services.filesystem_search_physical import PhysicalSearchEvent
from app.services.filesystem_search_worker import SearchPolicy, SmbSearchWorker
from app.storage.smb import SMBBackend


class _Root:
    def __init__(self, path):
        self.path = path

    def close(self):
        pass

    def read(self, _path, _check, **_kwargs):
        return self

    def verify(self):
        pass


def _request(**changes):
    return SearchRequest.model_validate(
        {
            "version": 1,
            "source": {"kind": "smb", "id": "connection"},
            "root": {"kind": "directory", "path": ""},
            "query": "*",
            "case_sensitive": False,
            "folder_depth": "current",
            "item_type": "files",
            "search_archives": False,
        }
        | changes
    )


async def _allowed():
    return True


def _file(name):
    return PhysicalSearchEvent("file", name, SmbDirectoryEntry(name, SmbDirectoryEntryInformation(0), size=1))


def _worker(admission, request=None, policy=None, authorize=_allowed):
    policy = policy or SearchPolicy(1, 5, 20)
    lease = admission.admit("account", "connection", policy.concurrent_searches)
    backend = Mock(spec=SMBBackend)
    backend.directory_search_context.return_value = nullcontext(("source", {}))
    return SmbSearchWorker(request or _request(), policy, lease, backend, authorize)


async def _records(worker):
    return [json.loads(chunk) async for chunk in worker.stream()]


def test_search_worker_does_not_starve_default_executor(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)

    def search(_root, _options, _session, _check, receive, *, summary):
        for number in range(10):
            receive(_file(f"{number}.txt"))

    async def authorize():
        return await asyncio.to_thread(lambda: True)

    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)

    async def run():
        executor = ThreadPoolExecutor(max_workers=1)
        asyncio.get_running_loop().set_default_executor(executor)
        worker = _worker(SearchAdmission(), authorize=authorize)
        worker.start()
        records = await asyncio.wait_for(_records(worker), 3)
        assert records[-1]["reason"] == "complete"
        assert records[-1]["counts"]["matches"] == 10
        assert worker._task is not None
        await worker._task

    asyncio.run(run())


@pytest.mark.asyncio
async def test_worker_streams_distinct_matches_and_enforces_exact_limit(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)

    def search(_root, _options, _session, _check, receive, *, summary):
        for name in ("first", "first", "second", "third"):
            receive(_file(name))

    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    admission = SearchAdmission()
    worker = _worker(admission, policy=SearchPolicy(1, 5, 2))
    worker.start()
    records = await _records(worker)
    assert [record["type"] for record in records] == ["start", "batch", "batch", "terminal"]
    assert [record["results"][0]["target"]["path"] for record in records[1:-1]] == ["first", "second"]
    assert records[-1]["reason"] == "result_limit"
    assert records[-1]["counts"]["matches"] == 2
    assert worker._task is not None
    await worker._task
    admission.admit("account", "connection", 1).release()


@pytest.mark.asyncio
async def test_worker_omits_sizes_that_json_clients_cannot_represent(monkeypatch):
    from app.core.directory_index_contract import MAX_WIRE_INTEGER

    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)

    def search(_root, _options, _session, _check, receive, *, summary):
        for name, size in (("largest", MAX_WIRE_INTEGER), ("too-large", MAX_WIRE_INTEGER + 1)):
            receive(PhysicalSearchEvent("file", name, SmbDirectoryEntry(name, SmbDirectoryEntryInformation(0), size=size)))

    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    worker = _worker(SearchAdmission())
    worker.start()
    records = await _records(worker)
    sizes = {
        item["entry"]["name"]: item["entry"].get("size") for record in records if record["type"] == "batch" for item in record["results"]
    }
    assert sizes == {"largest": MAX_WIRE_INTEGER, "too-large": None}
    assert worker._task is not None
    await worker._task


@pytest.mark.asyncio
async def test_deadline_keeps_slot_until_blocked_worker_cleans_up(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)
    capacity = threading.BoundedSemaphore(1)
    monkeypatch.setattr("app.services.filesystem_search_worker._search_slots", capacity)
    started = threading.Event()
    release = threading.Event()

    def search(_root, _options, _session, check, receive, *, summary):
        receive(_file("early"))
        started.set()
        assert release.wait(5)
        check()
        receive(_file("late"))

    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    admission = SearchAdmission()
    worker = _worker(admission, policy=SearchPolicy(1, 1, 20))
    worker.start()
    try:
        records = await _records(worker)
        assert started.is_set()
        assert [record["type"] for record in records] == ["start", "batch", "terminal"]
        assert records[-1]["reason"] == "time_limit"
        assert records[-1]["counts"]["matches"] == 1
        with pytest.raises(SearchAdmissionError) as error:
            admission.admit("account", "connection", 1)
        assert error.value.reason is SearchAdmissionReason.STOPPING
        assert not capacity.acquire(blocking=False)
    finally:
        release.set()
        assert worker._task is not None
        await asyncio.wait_for(worker._task, 5)
    admission.admit("account", "connection", 1).release()
    assert capacity.acquire(blocking=False)
    capacity.release()


@pytest.mark.asyncio
async def test_authorization_loss_stops_delivery(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)

    def search(_root, _options, _session, check, receive, *, summary):
        for number in range(20):
            check()
            receive(_file(f"{number}.txt"))

    async def denied():
        return False

    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    admission = SearchAdmission()
    worker = _worker(admission, authorize=denied)
    worker.start()
    records = await _records(worker)
    assert [record["type"] for record in records] == ["start", "terminal"]
    assert records[-1]["reason"] == "source_failure"
    assert records[-1]["counts"]["matches"] == 0
    assert worker._task is not None
    await asyncio.wait_for(worker._task, 5)


@pytest.mark.asyncio
async def test_authorization_revoked_during_scan_keeps_only_earlier_results(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)
    release = threading.Event()
    allowed = True

    def search(_root, _options, _session, _check, receive, *, summary):
        receive(_file("early"))
        assert release.wait(5)
        receive(_file("late"))

    async def authorize():
        return allowed

    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    worker = _worker(SearchAdmission(), authorize=authorize)
    worker.start()
    stream = worker.stream()
    try:
        assert json.loads(await anext(stream))["type"] == "start"
        assert json.loads(await anext(stream))["results"][0]["target"]["path"] == "early"
        allowed = False
        release.set()
        terminal = json.loads(await anext(stream))
        assert terminal["reason"] == "source_failure"
        assert terminal["counts"]["matches"] == 1
    finally:
        release.set()
        await stream.aclose()
        assert worker._task is not None
        await asyncio.wait_for(worker._task, 5)


@pytest.mark.asyncio
async def test_slow_authorization_does_not_delay_the_search_deadline(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)

    def search(_root, _options, _session, _check, receive, *, summary):
        receive(_file("early"))

    async def slow_authorization():
        await asyncio.sleep(5)
        return True

    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    worker = _worker(SearchAdmission(), policy=SearchPolicy(1, 1, 20), authorize=slow_authorization)
    worker.start()
    records = await asyncio.wait_for(_records(worker), 2)
    assert [record["type"] for record in records] == ["start", "terminal"]
    assert records[-1]["reason"] == "time_limit"
    assert records[-1]["counts"]["matches"] == 0
    assert worker._task is not None
    await worker._task


@pytest.mark.asyncio
async def test_discovered_archive_searches_all_members_at_current_physical_depth(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)

    class MemoryReader:
        def __init__(self, data):
            self.data = data

        async def read_at(self, offset, length):
            return self.data[offset : offset + length]

        async def close(self):
            pass

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as writer:
        writer.writestr("folder/nested.txt", "contents")
    data = archive.getvalue()
    raw_entries = await read_search_entries(ZipReader(MemoryReader(data), len(data)), lambda: None)

    async def get_entries(self, _parent, name, _expected_id):
        assert name == "test.zip"
        return raw_entries

    def search(_root, _options, _session, _check, receive, *, summary):
        receive(PhysicalSearchEvent("archive", "test.zip"))

    monkeypatch.setattr(SmbSearchWorker, "_archive_entries", get_entries)
    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    admission = SearchAdmission()
    worker = _worker(admission, request=_request(search_archives=True))
    worker.start()
    records = await _records(worker)
    assert records[1]["results"][0]["target"] == {
        "kind": "archive",
        "archive_path": "test.zip",
        "member_path": "folder/nested.txt",
    }
    assert records[-1]["reason"] == "complete"
    assert worker._task is not None
    await worker._task


@pytest.mark.asyncio
async def test_archive_root_search_reads_members_even_when_discovery_is_disabled(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as writer:
        writer.writestr("folder/note.txt", "contents")
        writer.writestr("folder/nested/note.txt", "contents")
    data = archive.getvalue()

    class Reader:
        async def read_at(self, offset, length):
            return data[offset : offset + length]

        async def close(self):
            pass

    async def open_archive(_parent, name, expected_id):
        assert name == "test.zip" and expected_id is None
        return Reader(), len(data)

    worker = _worker(
        SearchAdmission(),
        request=_request(
            root={"kind": "archive", "path": "test.zip", "member_path": "folder"},
            query="note",
            search_archives=False,
        ),
    )
    worker.backend.open_search_archive_reader.side_effect = open_archive
    worker.start()
    records = await _records(worker)
    assert [record["results"][0]["target"]["member_path"] for record in records if record["type"] == "batch"] == ["folder/note.txt"]
    assert records[-1]["reason"] == "complete"
    assert worker._task is not None
    await worker._task


@pytest.mark.asyncio
async def test_slow_archive_open_preserves_early_results_and_retains_slot(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)
    opening = asyncio.Event()
    release = asyncio.Event()
    closed = asyncio.Event()

    class Reader:
        async def close(self):
            closed.set()

    async def open_archive(_parent, _name, _expected_id):
        opening.set()
        await release.wait()
        return Reader(), 0

    def search(_root, _options, _session, _check, receive, *, summary):
        receive(_file("early.txt"))
        receive(PhysicalSearchEvent("archive", "test.zip"))
        receive(_file("late.txt"))

    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    admission = SearchAdmission()
    worker = _worker(admission, request=_request(search_archives=True), policy=SearchPolicy(1, 1, 20))
    worker.backend.open_search_archive_reader.side_effect = open_archive
    worker.start()
    try:
        records = await asyncio.wait_for(_records(worker), 3)
        assert opening.is_set()
        assert [record["type"] for record in records] == ["start", "batch", "terminal"]
        assert records[1]["results"][0]["target"]["path"] == "early.txt"
        assert records[-1]["reason"] == "time_limit"
        with pytest.raises(SearchAdmissionError) as error:
            admission.admit("account", "connection", 1)
        assert error.value.reason is SearchAdmissionReason.STOPPING
    finally:
        release.set()
        assert worker._task is not None
        await asyncio.wait_for(worker._task, 5)
    assert closed.is_set()
    admission.admit("account", "connection", 1).release()


@pytest.mark.asyncio
async def test_archive_cleanup_keeps_slot_after_deadline(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)
    cleanup_started = asyncio.Event()
    release_cleanup = asyncio.Event()

    class Reader:
        async def close(self):
            cleanup_started.set()
            raise TimeoutError("Close is still running")

        async def wait_closed(self):
            await release_cleanup.wait()

    async def open_archive(_parent, _name, _expected_id):
        return Reader(), 100

    async def entries(_reader, _check):
        return ()

    def search(_root, _options, _session, _check, receive, *, summary):
        receive(PhysicalSearchEvent("archive", "test.zip"))

    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    monkeypatch.setattr("app.services.filesystem_search_worker.read_search_entries", entries)
    admission = SearchAdmission()
    worker = _worker(admission, request=_request(search_archives=True), policy=SearchPolicy(1, 1, 20))
    worker.backend.open_search_archive_reader.side_effect = open_archive
    worker.start()
    try:
        records = await _records(worker)
        assert cleanup_started.is_set()
        assert records[-1]["reason"] == "time_limit"
        with pytest.raises(SearchAdmissionError) as error:
            admission.admit("account", "connection", 1)
        assert error.value.reason is SearchAdmissionReason.STOPPING
    finally:
        release_cleanup.set()
        assert worker._task is not None
        await asyncio.wait_for(worker._task, 5)
    admission.admit("account", "connection", 1).release()


@pytest.mark.asyncio
async def test_archive_root_reports_the_metadata_limit(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)

    async def oversized(_self, _parent, _name, _expected_id):
        raise ArchiveSearchTooLarge("Archive metadata exceeds the search limit.")

    monkeypatch.setattr(SmbSearchWorker, "_archive_entries", oversized)
    worker = _worker(SearchAdmission(), request=_request(root={"kind": "archive", "path": "test.zip", "member_path": ""}))
    worker.start()
    records = await _records(worker)
    assert records[-1]["reason"] == "source_failure"
    assert records[-1]["skips"] == [{"reason": "archive_too_large", "count": 1}]
    assert worker._task is not None
    await worker._task


@pytest.mark.asyncio
async def test_archive_root_reports_unreadable_source(monkeypatch):
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", _Root)
    worker = _worker(SearchAdmission(), request=_request(root={"kind": "archive", "path": "test.zip", "member_path": ""}))
    worker.backend.open_search_archive_reader.side_effect = OSError("Archive unavailable")
    worker.start()
    records = await _records(worker)
    assert records[-1]["reason"] == "source_failure"
    assert records[-1]["skips"] == [{"reason": "archive_unreadable", "count": 1}]
    assert worker._task is not None
    await worker._task
