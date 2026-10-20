import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.api.themes import COLOR_SHAPE
from app.core.user_setting_definitions import UserSettingKey
from app.models.user_settings import UserSetting
from app.services import user_settings


def complete_theme_definition() -> dict:
    def colors(shape: object) -> object:
        if isinstance(shape, tuple):
            return {key: "#12345678" for key in shape}
        if isinstance(shape, dict):
            return {key: colors(value) if value is not None else "#12345678" for key, value in shape.items()}
        raise AssertionError("Unknown color role")

    return {"name": "Test theme", "description": "Test", "mode": "dark", **colors(COLOR_SHAPE)}


def test_legacy_theme_preserves_absent_syntax_group(client: TestClient, auth_headers_user: dict[str, str]) -> None:
    definition = complete_theme_definition()
    del definition["components"]["syntax"]
    response = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition})
    assert response.status_code == 201, response.text
    assert "syntax" not in response.json()["definition"]["components"]
    listing = client.get("/api/themes", headers=auth_headers_user)
    assert "syntax" not in listing.json()["themes"][0]["definition"]["components"]


@pytest.mark.parametrize("syntax", [None, {}, {"keyword": "#123456"}, {"unknown": "#123456"}, "#123456"])
def test_supplied_syntax_requires_complete_palette(client: TestClient, auth_headers_user: dict[str, str], syntax: object) -> None:
    definition = complete_theme_definition()
    definition["components"]["syntax"] = syntax
    response = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition})
    assert response.status_code == 422, response.text
    assert "syntax" in response.json()["detail"]


def test_syntax_palette_round_trip_and_strict_values(client: TestClient, auth_headers_user: dict[str, str]) -> None:
    definition = complete_theme_definition()
    definition["components"]["syntax"]["keyword"] = "#aabbccdd"
    response = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition})
    assert response.status_code == 201, response.text
    assert response.json()["definition"]["components"]["syntax"]["keyword"] == "#AABBCCDD"
    definition["components"]["syntax"]["keyword"] = "red"
    assert client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition}).status_code == 422
    definition["components"]["syntax"]["keyword"] = "#aabbccdd"
    definition["components"]["syntax"]["unknown"] = "#123456"
    assert client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition}).status_code == 422


def test_theme_rows_permissions_versions_and_deletion(
    client: TestClient, auth_headers_user: dict[str, str], auth_headers_admin: dict[str, str]
) -> None:
    definition = complete_theme_definition()
    assert client.post("/api/themes", headers=auth_headers_user, json={"scope": "site", "definition": definition}).status_code == 403
    response = client.post("/api/themes", headers=auth_headers_admin, json={"scope": "site", "definition": definition})
    assert response.status_code == 201, response.text
    saved = response.json()
    theme_id = saved["id"]
    assert saved["version"] == 1
    assert client.get("/api/themes", headers=auth_headers_user).json()["themes"][0]["id"] == theme_id
    assert client.put(f"/api/themes/default/{theme_id}", headers=auth_headers_user).status_code == 403
    assert client.put(f"/api/themes/default/{theme_id}", headers=auth_headers_admin).status_code == 200
    assert (
        client.put("/api/auth/me/settings", headers=auth_headers_user, json={"field": "appearance.theme_id", "value": theme_id}).status_code
        == 200
    )
    definition["name"] = "Renamed theme"
    payload = {"scope": "site", "definition": definition, "version": 1}
    assert client.put(f"/api/themes/{theme_id}", headers=auth_headers_user, json=payload).status_code == 403
    assert client.put(f"/api/themes/{theme_id}", headers=auth_headers_admin, json=payload).json()["version"] == 2
    assert client.put(f"/api/themes/{theme_id}", headers=auth_headers_admin, json=payload).status_code == 409
    assert client.delete(f"/api/themes/{theme_id}?version=1", headers=auth_headers_admin).status_code == 409
    assert client.delete(f"/api/themes/{theme_id}?version=2", headers=auth_headers_admin).status_code == 204
    assert client.get("/api/themes", headers=auth_headers_user).json()["site_default_id"] == "sambee-light"
    assert client.get("/api/auth/me/settings", headers=auth_headers_user).json()["appearance"]["theme_id"] == "sambee-light"


def test_theme_validation_and_explicit_default_selection(
    client: TestClient, auth_headers_user: dict[str, str], auth_headers_admin: dict[str, str]
) -> None:
    definition = complete_theme_definition()
    definition["components"]["markdownViewer"]["document"].pop("headingBorder")
    response = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition})
    assert response.status_code == 422
    assert "headingBorder" in response.json()["detail"]
    definition["components"]["markdownViewer"]["document"]["headingBorder"] = "#not-hex"
    assert client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition}).status_code == 422
    definition["components"]["markdownViewer"]["document"]["headingBorder"] = "#aabbccdd"
    saved = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition})
    assert saved.status_code == 201
    assert saved.json()["definition"]["components"]["markdownViewer"]["document"]["headingBorder"] == "#AABBCCDD"
    assert client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition}).status_code == 409

    assert client.put("/api/themes/default/sambee-dark", headers=auth_headers_admin).status_code == 200
    appearance = client.get("/api/auth/me/settings", headers=auth_headers_user).json()["appearance"]
    assert appearance["theme_id"] == "sambee-dark"
    assert appearance["has_theme_override"] is False
    assert (
        client.put(
            "/api/auth/me/settings", headers=auth_headers_user, json={"field": "appearance.theme_id", "value": "sambee-light"}
        ).status_code
        == 200
    )
    assert client.get("/api/auth/me/settings", headers=auth_headers_user).json()["appearance"]["has_theme_override"] is True
    assert client.put("/api/themes/default/sambee-light", headers=auth_headers_admin).status_code == 200
    assert client.put("/api/themes/default/sambee-dark", headers=auth_headers_admin).status_code == 200
    assert client.get("/api/auth/me/settings", headers=auth_headers_user).json()["appearance"]["theme_id"] == "sambee-light"


def test_user_theme_is_private_and_cannot_become_site_default(
    client: TestClient, auth_headers_user: dict[str, str], auth_headers_admin: dict[str, str]
) -> None:
    created = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": complete_theme_definition()})
    assert created.status_code == 201
    theme_id = created.json()["id"]
    assert client.get("/api/themes", headers=auth_headers_admin).json()["themes"] == []
    assert client.put("/api/themes/default/" + theme_id, headers=auth_headers_admin).status_code == 400
    assert (
        client.put(
            "/api/auth/me/settings", headers=auth_headers_admin, json={"field": "appearance.theme_id", "value": theme_id}
        ).status_code
        == 400
    )
    payload = {"scope": "user", "definition": complete_theme_definition(), "version": 1}
    assert client.put(f"/api/themes/{theme_id}", headers=auth_headers_admin, json=payload).status_code == 404
    assert client.delete(f"/api/themes/{theme_id}?version=1", headers=auth_headers_admin).status_code == 404
    assert client.get("/api/themes", headers=auth_headers_user).json()["themes"][0]["id"] == theme_id


def test_generated_builtin_theme_id_collision_does_not_replace_existing_row(
    client: TestClient, auth_headers_user: dict[str, str], monkeypatch
) -> None:
    definition = complete_theme_definition()
    created = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition})
    assert created.status_code == 201
    definition["name"] = "Another theme"

    with monkeypatch.context() as patch:
        patch.setattr("app.api.themes.uuid", SimpleNamespace(uuid4=lambda: "sambee-light"))
        response = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition})
    assert response.status_code == 409
    listing = client.get("/api/themes", headers=auth_headers_user)
    assert listing.status_code == 200, listing.text
    rows = listing.json()["themes"]
    assert len(rows) == 1
    assert rows[0]["definition"]["name"] == "Test theme"


class TestCurrentUserSettingsApi:
    def test_loads_built_in_theme_ids_from_packaged_manifest_location(self, tmp_path, monkeypatch) -> None:
        missing_manifest = tmp_path / "source" / "built_in_theme_ids.json"
        packaged_manifest = tmp_path / "package" / "shared" / "built_in_theme_ids.json"
        packaged_manifest.parent.mkdir(parents=True)
        packaged_manifest.write_text(json.dumps(["sambee-light", "sambee-dark"]))
        monkeypatch.setattr(user_settings, "BUILT_IN_THEME_IDS_PATHS", (missing_manifest, packaged_manifest))

        assert user_settings._built_in_theme_ids() == {"sambee-dark", "sambee-light"}

    def test_user_gets_default_settings(self, client: TestClient, auth_headers_user: dict[str, str]) -> None:
        response = client.get("/api/auth/me/settings", headers=auth_headers_user)

        assert response.status_code == 200
        data = response.json()
        assert data["appearance"] == {"theme_id": "sambee-light", "has_theme_override": False, "custom_themes": []}
        assert data["localization"] == {"language": "browser", "regional_locale": "browser"}
        assert data["browser"]["quick_nav_include_dot_directories"] is False
        assert data["browser"]["touch_friendly_file_selection"] == "auto"
        assert data["browser"]["selected_connection_id"] is None
        assert data["text_editor"] == {"max_file_size_bytes": 52_428_800, "word_wrap_enabled": None}

    def test_user_updates_independent_settings(self, client: TestClient, auth_headers_user: dict[str, str], session: Session) -> None:
        created = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": complete_theme_definition()})
        assert created.status_code == 201
        theme_id = created.json()["id"]
        updates = (
            {"field": "appearance.theme_id", "value": theme_id},
            {"field": "localization.language", "value": "en"},
            {"field": "localization.regional_locale", "value": "en-GB"},
            {"field": "browser.quick_nav_include_dot_directories", "value": True},
            {"field": "browser.quick_bar_shortcut_hint_visibility", "value": "never"},
            {"field": "browser.touch_friendly_file_selection", "value": "always"},
            {"field": "browser.file_browser_view_mode", "value": "details"},
            {"field": "browser.pane_mode", "value": "dual"},
            {"field": "browser.selected_connection_id", "value": "conn-123"},
            {"field": "browser.viewer_associations", "value": {".MD": " markdown ", "application/pdf": "pdf"}},
            {"field": "text_editor.max_file_size_bytes", "value": 4_194_304},
            {"field": "text_editor.word_wrap_enabled", "value": True},
        )
        for payload in updates:
            response = client.put("/api/auth/me/settings", headers=auth_headers_user, json=payload)
            assert response.status_code == 200
            assert response.json()["field"] == payload["field"]

        data = client.get("/api/auth/me/settings", headers=auth_headers_user).json()
        assert data["appearance"]["theme_id"] == theme_id
        assert data["browser"]["viewer_associations"] == {".md": "markdown", "application/pdf": "pdf"}
        assert data["text_editor"]["max_file_size_bytes"] == 4_194_304
        keys = {row.key for row in session.exec(select(UserSetting)).all()}
        assert UserSettingKey.APPEARANCE_THEME_ID.value in keys
        assert UserSettingKey.TEXT_EDITOR_WORD_WRAP_ENABLED.value in keys

    def test_user_can_clear_compound_and_nullable_settings(
        self, client: TestClient, auth_headers_user: dict[str, str], session: Session
    ) -> None:
        for payload in (
            {"field": "browser.selected_connection_id", "value": "conn-123"},
            {"field": "browser.viewer_associations", "value": {".md": "markdown"}},
            {"field": "browser.selected_connection_id", "value": None},
            {"field": "browser.viewer_associations", "value": {}},
            {"field": "text_editor.word_wrap_enabled", "value": None},
        ):
            response = client.put("/api/auth/me/settings", headers=auth_headers_user, json=payload)
            assert response.status_code == 200

        keys = {row.key for row in session.exec(select(UserSetting)).all()}
        assert UserSettingKey.BROWSER_SELECTED_CONNECTION_ID.value not in keys
        assert UserSettingKey.BROWSER_VIEWER_ASSOCIATIONS.value not in keys
        assert UserSettingKey.TEXT_EDITOR_WORD_WRAP_ENABLED.value not in keys

    def test_user_settings_are_isolated_per_user(
        self, client: TestClient, auth_headers_user: dict[str, str], auth_headers_admin: dict[str, str]
    ) -> None:
        response = client.put(
            "/api/auth/me/settings", headers=auth_headers_user, json={"field": "appearance.theme_id", "value": "sambee-dark"}
        )
        assert response.status_code == 200
        assert client.get("/api/auth/me/settings", headers=auth_headers_admin).json()["appearance"]["theme_id"] == "sambee-light"

    def test_rejects_invalid_values_and_legacy_shapes(self, client: TestClient, auth_headers_user: dict[str, str]) -> None:
        invalid_values = (
            {"field": "appearance.theme_id", "value": "   "},
            {"field": "appearance.theme_id", "value": "unknown-theme"},
            {"field": "browser.viewer_associations", "value": {"   ": "markdown"}},
            {"field": "text_editor.max_file_size_bytes", "value": 1024},
            {"field": "localization.regional_locale", "value": "english_us"},
        )
        for payload in invalid_values:
            assert client.put("/api/auth/me/settings", headers=auth_headers_user, json=payload).status_code == 400

        for payload in (
            {"appearance": {"theme_id": "sambee-dark"}},
            {"field": "unknown", "value": True},
            {"field": "appearance.custom_themes", "value": []},
            {"field": "appearance.theme_id", "value": "sambee-dark", "unexpected": True},
        ):
            assert client.put("/api/auth/me/settings", headers=auth_headers_user, json=payload).status_code == 422

    def test_deleting_active_theme_clears_override(self, client: TestClient, auth_headers_user: dict[str, str]) -> None:
        created = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": complete_theme_definition()})
        theme_id = created.json()["id"]
        assert (
            client.put(
                "/api/auth/me/settings", headers=auth_headers_user, json={"field": "appearance.theme_id", "value": theme_id}
            ).status_code
            == 200
        )
        assert client.delete(f"/api/themes/{theme_id}?version=1", headers=auth_headers_user).status_code == 204
        appearance = client.get("/api/auth/me/settings", headers=auth_headers_user).json()["appearance"]
        assert appearance["theme_id"] == "sambee-light"
        assert appearance["has_theme_override"] is False
