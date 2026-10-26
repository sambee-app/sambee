from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pytest import MonkeyPatch
from sqlmodel import Session

from app.models.connection import Connection
from app.models.file import FileInfo, FileType
from app.models.recent_directory import RecentDirectory
from app.models.system_settings import FileSearchSettings
from app.models.user import User
from app.services import recent_directories
from app.services.history_common import history_usage_score, updated_history_usage_score


class TestRecentDirectoriesApi:
    def test_shared_policy_trims_both_histories_and_zero_disables_them(
        self, client: TestClient, auth_headers_user: dict[str, str], auth_headers_admin: dict[str, str]
    ) -> None:
        settings = client.get("/api/admin/settings/file-search", headers=auth_headers_admin)
        assert settings.status_code == 200
        assert settings.json()["settings"]["retention_limit"] == 200
        for index in range(3):
            for endpoint, target in (("recent-files", {"is_regular_file": True}), ("recent-directories", {"is_directory": True})):
                response = client.post(
                    f"/api/browse/{endpoint}",
                    headers=auth_headers_user,
                    json={"connection_id": "local-drive:c", "path": f"item-{index}.txt", **target},
                )
                assert response.status_code == 200
        for field, value in (("retention_limit", 2), ("result_limit", 1)):
            response = client.put("/api/admin/settings/file-search", headers=auth_headers_admin, json={"field": field, "value": value})
            assert response.status_code == 200
        for endpoint in ("recent-files", "recent-directories"):
            response = client.get(f"/api/browse/{endpoint}", headers=auth_headers_user, params={"limit": 50})
            assert response.status_code == 200
            assert response.json()["result_limit"] == 1
            assert len(response.json()["results"]) == 1
        response = client.put("/api/admin/settings/file-search", headers=auth_headers_admin, json={"field": "result_limit", "value": 50})
        assert response.status_code == 200
        for endpoint in ("recent-files", "recent-directories"):
            assert len(client.get(f"/api/browse/{endpoint}", headers=auth_headers_user, params={"limit": 50}).json()["results"]) == 2
        response = client.put("/api/admin/settings/file-search", headers=auth_headers_admin, json={"field": "retention_limit", "value": 0})
        assert response.status_code == 200
        for endpoint, target in (("recent-files", {"is_regular_file": True}), ("recent-directories", {"is_directory": True})):
            assert client.get(f"/api/browse/{endpoint}", headers=auth_headers_user).json()["results"] == []
            response = client.post(
                f"/api/browse/{endpoint}",
                headers=auth_headers_user,
                json={"connection_id": "local-drive:c", "path": "disabled.txt", **target},
            )
            assert response.status_code == 200
            assert response.json() is None

    @pytest.fixture(autouse=True)
    def mock_remote_target(self, monkeypatch: MonkeyPatch) -> None:
        import app.api.browser as browser_api

        class TargetBackend:
            async def connect(self) -> None:
                return None

            async def disconnect(self) -> None:
                return None

            async def get_file_info(self, path: str) -> FileInfo:
                return FileInfo(name=path.rsplit("/", 1)[-1], path=path, type=FileType.DIRECTORY)

        monkeypatch.setattr(browser_api, "build_smb_backend", lambda *_args, **_kwargs: TargetBackend())

    def test_records_searches_removes_and_clears_recent_directories(self, client: TestClient, auth_headers_user: dict[str, str]) -> None:
        first = client.post(
            "/api/browse/recent-directories",
            headers=auth_headers_user,
            json={"connection_id": "local-drive:c", "path": "Documents/Reports", "is_directory": True},
        )
        second = client.post(
            "/api/browse/recent-directories",
            headers=auth_headers_user,
            json={"connection_id": "local-drive:c", "path": "Projects/2026", "is_directory": True},
        )

        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["path"] == "Documents/Reports"

        search = client.get("/api/browse/recent-directories", headers=auth_headers_user, params={"q": "project"})
        assert search.status_code == 200
        assert [record["id"] for record in search.json()["results"]] == [second.json()["id"]]

        remove = client.delete(f"/api/browse/recent-directories/{first.json()['id']}", headers=auth_headers_user)
        assert remove.status_code == 204

        clear = client.delete("/api/browse/recent-directories", headers=auth_headers_user)
        assert clear.status_code == 200
        assert clear.json()["deleted_count"] == 1

    def test_normalizes_paths_rejects_unsafe_paths_and_keeps_records_private(
        self, client: TestClient, auth_headers_user: dict[str, str], auth_headers_admin: dict[str, str]
    ) -> None:
        first = client.post(
            "/api/browse/recent-directories",
            headers=auth_headers_user,
            json={"connection_id": "local-drive:c", "path": r"Documents\Résumé", "is_directory": True},
        )
        second = client.post(
            "/api/browse/recent-directories",
            headers=auth_headers_user,
            json={"connection_id": "local-drive:c", "path": "Documents/Résumé", "is_directory": True},
        )
        assert first.status_code == 200
        assert second.status_code == 200
        assert first.json()["id"] == second.json()["id"]

        for invalid_path, expected_status in (("", 422), ("/absolute", 400), ("../outside", 400), ("Documents//duplicate", 400)):
            response = client.post(
                "/api/browse/recent-directories",
                headers=auth_headers_user,
                json={"connection_id": "local-drive:c", "path": invalid_path, "is_directory": True},
            )
            assert response.status_code == expected_status

        admin_results = client.get("/api/browse/recent-directories", headers=auth_headers_admin)
        assert admin_results.status_code == 200
        assert admin_results.json()["results"] == []

        foreign_remove = client.delete(f"/api/browse/recent-directories/{first.json()['id']}", headers=auth_headers_admin)
        assert foreign_remove.status_code == 404

    def test_rejects_a_remote_file_before_recording(
        self, client: TestClient, auth_headers_user: dict[str, str], test_connection: Connection, monkeypatch: MonkeyPatch
    ) -> None:
        import app.api.browser as browser_api

        class FileBackend:
            async def connect(self) -> None:
                return None

            async def disconnect(self) -> None:
                return None

            async def get_file_info(self, path: str) -> FileInfo:
                return FileInfo(name="report.txt", path=path, type=FileType.FILE)

        monkeypatch.setattr(browser_api, "build_smb_backend", lambda *_args, **_kwargs: FileBackend())

        response = client.post(
            "/api/browse/recent-directories",
            headers=auth_headers_user,
            json={"connection_id": str(test_connection.id), "path": "Reports", "is_directory": True},
        )

        assert response.status_code == 400


class TestRecentDirectoryService:
    def test_frequency_decay_and_duplicate_events(self) -> None:
        now = datetime.now(timezone.utc)
        assert history_usage_score(8, now - timedelta(days=30), now) == pytest.approx(4)
        assert updated_history_usage_score(8, now, now) == 8
        assert updated_history_usage_score(8, now - timedelta(minutes=1), now) > 8

    def test_ranks_match_quality_before_frequency_then_recency(self, session: Session, regular_user: User) -> None:
        now = datetime.now(timezone.utc)
        for path, score, age in (("report-old", 8, 1), ("report-new", 1, 0), ("report", 1, 2)):
            session.add(
                RecentDirectory(
                    user_id=regular_user.id,
                    connection_id="local-drive:c",
                    path=path,
                    usage_score=score,
                    last_visited_at=now - timedelta(days=age),
                )
            )
        session.commit()
        results = recent_directories.search_recent_directories(query="report", limit=10, current_user=regular_user, session=session)
        assert [record.path for record in results] == ["report", "report-old", "report-new"]

    def test_zero_retention_disables_recording(self, session: Session, regular_user: User, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setattr(recent_directories, "get_file_search_settings", lambda _session: FileSearchSettings(retention_limit=0))
        assert (
            recent_directories.record_recent_directory(
                connection_id="local-drive:c", path="Projects", current_user=regular_user, session=session
            )
            is None
        )

    def test_upserts_normalizes_matches_and_trims_each_users_history(
        self, session: Session, regular_user: User, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setattr(recent_directories, "get_file_search_settings", lambda _session: FileSearchSettings(retention_limit=2))

        first = recent_directories.record_recent_directory(
            connection_id="local-drive:c", path="Café\\Résumé", current_user=regular_user, session=session
        )
        recent_directories.record_recent_directory(
            connection_id="local-drive:c", path="Projects", current_user=regular_user, session=session
        )
        refreshed_first = recent_directories.record_recent_directory(
            connection_id="local-drive:c", path="Caf\u00e9/R\u00e9sum\u00e9", current_user=regular_user, session=session
        )
        recent_directories.record_recent_directory(
            connection_id="local-drive:c", path="Archive", current_user=regular_user, session=session
        )

        assert refreshed_first is not None and first is not None
        assert refreshed_first.id == first.id
        assert [
            record.path
            for record in recent_directories.search_recent_directories(
                query="resume", limit=100, current_user=regular_user, session=session
            )
        ] == ["Caf\u00e9/R\u00e9sum\u00e9"]
        assert [
            record.path
            for record in recent_directories.search_recent_directories(query="", limit=100, current_user=regular_user, session=session)
        ] == [
            "Archive",
            "Caf\u00e9/R\u00e9sum\u00e9",
        ]

    def test_filters_inaccessible_connections_and_bounds_results(
        self, session: Session, regular_user: User, other_private_connection: Connection
    ) -> None:
        session.add(
            RecentDirectory(
                user_id=regular_user.id,
                connection_id=str(other_private_connection.id),
                path="Private",
            )
        )
        for index in range(55):
            session.add(
                RecentDirectory(
                    user_id=regular_user.id,
                    connection_id="local-drive:c",
                    path=f"Directory {index}",
                )
            )
        session.commit()

        results = recent_directories.search_recent_directories(query="", limit=100, current_user=regular_user, session=session)

        assert len(results) == FileSearchSettings().result_limit
        assert all(record.path != "Private" for record in results)

    def test_refuses_to_remove_another_users_record(self, session: Session, regular_user: User, admin_user: User) -> None:
        record = recent_directories.record_recent_directory(
            connection_id="local-drive:c", path="Private", current_user=regular_user, session=session
        )

        with pytest.raises(HTTPException, match="Recent directory not found"):
            recent_directories.remove_recent_directory(record_id=record.id, current_user=admin_user, session=session)
