"""HTTP admission and streaming for SMB file-system search."""

import asyncio
import json
import socket
import threading
import uuid
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from starlette.requests import ClientDisconnect

from app.api.filesystem_search import _SearchStreamingResponse
from app.core.security import get_current_user_with_auth_check
from app.db.database import get_session
from app.models.system_settings import FilesystemSearchPolicy
from app.services.directory_traversal import SmbDirectoryEntry, SmbDirectoryEntryInformation
from app.services.filesystem_search_physical import PhysicalSearchEvent
from app.storage.smb import SMBBackend


def _body(connection_id):
    return {
        "version": 1,
        "source": {"kind": "smb", "id": str(connection_id)},
        "root": {"kind": "directory", "path": ""},
        "query": "*.txt",
        "case_sensitive": False,
        "folder_depth": "current",
        "item_type": "files",
        "search_archives": False,
    }


def test_search_http_stream(client, auth_headers_user, test_connection, monkeypatch):
    class Root:
        def __init__(self, path):
            assert path == "source"

        def close(self):
            pass

    def search(_root, _options, _session, _check, receive, *, summary):
        receive(PhysicalSearchEvent("file", "report.txt", SmbDirectoryEntry("report.txt", SmbDirectoryEntryInformation(0), size=3)))
        summary.scanned_directories += 1

    backend = Mock(spec=SMBBackend)
    backend.directory_search_context.return_value = nullcontext(("source", {}))
    monkeypatch.setattr("app.api.filesystem_search.build_smb_backend", lambda _connection: backend)
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", Root)
    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    response = client.post(
        f"/api/browse/{test_connection.id}/filesystem-search",
        headers=auth_headers_user,
        json=_body(test_connection.id),
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert response.headers["x-accel-buffering"] == "no"
    records = [json.loads(line) for line in response.text.splitlines()]
    assert [record["type"] for record in records] == ["start", "batch", "terminal"]
    assert records[1]["results"][0]["target"] == {"kind": "physical", "path": "report.txt"}
    assert records[-1]["reason"] == "complete"
    assert records[-1]["counts"] == {"matches": 1, "scanned_directories": 1, "skipped": 0}


def test_search_uses_the_current_admin_policy(client, auth_headers_user, test_connection, monkeypatch):
    class Root:
        def __init__(self, _path):
            pass

        def close(self):
            pass

    def search(_root, _options, _session, _check, receive, *, summary):
        receive(PhysicalSearchEvent("file", "first.txt", SmbDirectoryEntry("first.txt", SmbDirectoryEntryInformation(0), size=1)))
        receive(PhysicalSearchEvent("file", "second.txt", SmbDirectoryEntry("second.txt", SmbDirectoryEntryInformation(0), size=1)))

    backend = Mock(spec=SMBBackend)
    backend.directory_search_context.return_value = nullcontext(("source", {}))
    monkeypatch.setattr("app.api.filesystem_search.build_smb_backend", lambda _connection: backend)
    monkeypatch.setattr(
        "app.api.filesystem_search.get_filesystem_search_policy", lambda _session: FilesystemSearchPolicy(max_seconds=9, max_results=1)
    )
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", Root)
    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    response = client.post(
        f"/api/browse/{test_connection.id}/filesystem-search",
        headers=auth_headers_user,
        json=_body(test_connection.id),
    )
    assert response.status_code == 200
    records = [json.loads(line) for line in response.text.splitlines()]
    assert records[0]["limits"] == {"max_seconds": 9, "max_results": 1}
    assert records[-1]["reason"] == "result_limit"
    assert records[-1]["counts"]["matches"] == 1


def test_invalid_or_inaccessible_search_starts_no_worker(client, auth_headers_user, test_connection, other_private_connection, monkeypatch):
    backend = Mock()
    monkeypatch.setattr("app.api.filesystem_search.build_smb_backend", backend)
    url = f"/api/browse/{test_connection.id}/filesystem-search"
    wrong_source = _body(uuid.uuid4())
    assert client.post(url, headers=auth_headers_user, json=wrong_source).status_code == 422
    invalid = _body(test_connection.id) | {"query": " "}
    assert client.post(url, headers=auth_headers_user, json=invalid).status_code == 422
    unsafe_root = _body(test_connection.id) | {"root": {"kind": "directory", "path": "unsafe\\name"}}
    assert client.post(url, headers=auth_headers_user, json=unsafe_root).status_code == 422
    inaccessible = client.post(
        f"/api/browse/{other_private_connection.id}/filesystem-search",
        headers=auth_headers_user,
        json=_body(other_private_connection.id),
    )
    assert inaccessible.status_code == 404
    backend.assert_not_called()


def test_search_capacity_rejects_without_retaining_account_slot(client, auth_headers_user, test_connection, monkeypatch):
    capacity = threading.BoundedSemaphore(1)
    assert capacity.acquire(blocking=False)
    monkeypatch.setattr("app.services.filesystem_search_worker._search_slots", capacity)
    monkeypatch.setattr("app.api.filesystem_search.build_smb_backend", lambda _connection: Mock(spec=SMBBackend))
    try:
        for _ in range(2):
            response = client.post(
                f"/api/browse/{test_connection.id}/filesystem-search",
                headers=auth_headers_user,
                json=_body(test_connection.id),
            )
            assert response.status_code == 429
            assert response.json()["detail"]["code"] == "search_capacity"
    finally:
        capacity.release()


@pytest.mark.asyncio
async def test_disconnect_before_stream_iteration_stops_the_worker():
    async def stream():
        yield b"start\n"

    worker = Mock()
    worker.stream.return_value = stream()
    response = _SearchStreamingResponse(worker)

    async def receive():
        return {"type": "http.disconnect"}

    async def send(_message):
        raise OSError("Disconnected")

    with pytest.raises(ClientDisconnect):
        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
    worker.stop.assert_called_once()


@pytest.mark.asyncio
async def test_real_http_delivers_a_result_before_the_scan_finishes(session, regular_user, test_connection, monkeypatch):
    from app.api import filesystem_search

    release = threading.Event()
    entered = threading.Event()

    class Root:
        def __init__(self, _path):
            pass

        def close(self):
            pass

    def search(_root, _options, _session, _check, receive, *, summary):
        receive(PhysicalSearchEvent("file", "early.txt", SmbDirectoryEntry("early.txt", SmbDirectoryEntryInformation(0), size=1)))
        entered.set()
        assert release.wait(5)
        summary.scanned_directories += 1

    async def authenticate(_token, _session):
        return SimpleNamespace(user=regular_user)

    backend = Mock(spec=SMBBackend)
    backend.directory_search_context.return_value = nullcontext(("source", {}))
    monkeypatch.setattr("app.api.filesystem_search.build_smb_backend", lambda _connection: backend)
    monkeypatch.setattr("app.api.filesystem_search.get_current_browser_authentication_with_auth_check", authenticate)
    monkeypatch.setattr("app.services.filesystem_search_worker.SmbDirectoryRoot", Root)
    monkeypatch.setattr("app.services.filesystem_search_worker.search_physical", search)
    app = FastAPI()
    app.include_router(filesystem_search.router, prefix="/api/browse")
    app.dependency_overrides[get_session] = lambda: session
    app.dependency_overrides[get_current_user_with_auth_check] = lambda: regular_user
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, lifespan="off", log_level="error"))
    server_task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            while not server.started:
                await asyncio.sleep(0.01)
            async with client.stream(
                "POST", f"http://127.0.0.1:{port}/api/browse/{test_connection.id}/filesystem-search", json=_body(test_connection.id)
            ) as response:
                assert response.status_code == 200
                lines = response.aiter_lines()
                assert json.loads(await asyncio.wait_for(anext(lines), 2))["type"] == "start"
                batch = json.loads(await asyncio.wait_for(anext(lines), 2))
                assert batch["results"][0]["target"]["path"] == "early.txt"
                assert entered.is_set() and not release.is_set()
                release.set()
                assert json.loads(await asyncio.wait_for(anext(lines), 2))["reason"] == "complete"
    finally:
        release.set()
        try:
            server.should_exit = True
            await asyncio.wait_for(server_task, 5)
        finally:
            sock.close()
