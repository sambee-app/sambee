from app.models.companion_settings import CompanionTheme
from app.services.companion_settings import BUILT_IN_THEMES, build_settings_metadata, section_digest
from tests.test_system_settings import _policy_grant_binding
from tests.test_user_settings import complete_theme_definition


def test_settings_metadata_sections_are_independent(admin_user, session):
    metadata = build_settings_metadata(admin_user, session)
    assert metadata.version == 1
    assert metadata.directory_index.marker == "0"
    assert metadata.directory_index.user_scope is None
    assert metadata.theme.user_scope == str(admin_user.id)
    assert metadata.localization.user_scope == str(admin_user.id)
    assert len(metadata.theme.marker) == 64


def test_shared_themes_and_digests():
    light = BUILT_IN_THEMES["sambee-light"]
    assert light.primary.main == "#F4C430"
    assert section_digest(light) != section_digest(BUILT_IN_THEMES["sambee-dark"])
    assert section_digest(light) == section_digest(CompanionTheme.model_validate(light.model_dump()))


def test_nonadmin_settings_delivery_is_canonical_and_single_use(client, auth_headers_user, regular_user):
    binding = {**_policy_grant_binding(), "version": 1, "sections": ["theme", "localization", "directory_index"], "switch_user": True}
    headers = {**auth_headers_user, "Origin": binding["origin"]}
    issued = client.post("/api/admin/settings/companion/grants", headers=headers, json=binding)
    assert issued.status_code == 200
    redeem = {key: value for key, value in binding.items() if key not in ("sections", "switch_user")}
    redeem["grant"] = issued.json()["grant"]
    response = client.post("/api/admin/settings/companion/grants/redeem", json=redeem)
    assert response.status_code == 200
    payload = response.json()
    assert payload["theme"]["payload"]["id"] == "sambee-light"
    assert payload["theme"]["user_scope"] == str(regular_user.id)
    assert payload["localization"]["payload"] == {"language": "browser", "regional_locale": "browser"}
    assert payload["directory_index"]["marker"] == "0"
    assert client.post("/api/admin/settings/companion/grants/redeem", json=redeem).status_code == 409


def test_settings_grant_rejects_changed_section_but_not_unselected_policy(client, auth_headers_user, auth_headers_admin):
    binding = {**_policy_grant_binding(), "version": 1, "sections": ["theme"]}
    headers = {**auth_headers_user, "Origin": binding["origin"]}
    issued = client.post("/api/admin/settings/companion/grants", headers=headers, json=binding).json()
    client.put("/api/admin/settings/directory-index/companion", headers=auth_headers_admin, json={"field": "page_cache_kib", "value": 1024})
    redeem = {key: value for key, value in binding.items() if key != "sections"}
    response = client.post("/api/admin/settings/companion/grants/redeem", json={**redeem, "grant": issued["grant"]})
    assert response.status_code == 200
    assert response.json()["directory_index"] is None
    issued = client.post("/api/admin/settings/companion/grants", headers=headers, json=binding).json()
    assert (
        client.put(
            "/api/auth/me/settings", headers=auth_headers_user, json={"field": "appearance.theme_id", "value": "sambee-dark"}
        ).status_code
        == 200
    )
    assert client.post("/api/admin/settings/companion/grants/redeem", json={**redeem, "grant": issued["grant"]}).status_code == 409


def test_settings_grant_rechecks_issuing_oidc_session(client, auth_headers_user, regular_user, session):
    import uuid

    import pytest
    from fastapi import HTTPException

    from app.models.companion_settings import SettingsGrantBinding, SettingsGrantRedeem
    from app.services.directory_policy_grants import issue_directory_policy_grant, redeem_directory_policy_grant

    assert client.get("/api/admin/settings/companion", headers=auth_headers_user).status_code == 200
    binding = SettingsGrantBinding(**_policy_grant_binding(), sections=["theme"])
    grant = issue_directory_policy_grant(binding, regular_user, session, browser_session_id=uuid.uuid4())
    redeem = SettingsGrantRedeem(companion_id=binding.companion_id, challenge=binding.challenge, origin=binding.origin, grant=grant.grant)
    with pytest.raises(HTTPException, match="issuing sign-in session") as failure:
        redeem_directory_policy_grant(redeem, session)
    assert failure.value.status_code == 403


def test_site_default_and_theme_edits_change_only_theme_digest(client, auth_headers_user, auth_headers_admin):
    endpoint = "/api/admin/settings/companion"
    before = client.get(endpoint, headers=auth_headers_user).json()
    assert client.put("/api/themes/default/sambee-dark", headers=auth_headers_admin).status_code == 200
    dark = client.get(endpoint, headers=auth_headers_user).json()
    assert before["theme"]["marker"] != dark["theme"]["marker"]
    assert before["localization"] == dark["localization"]
    assert before["directory_index"] == dark["directory_index"]
    definition = complete_theme_definition()
    created = client.post("/api/themes", headers=auth_headers_admin, json={"scope": "site", "definition": definition})
    assert created.status_code == 201
    theme = created.json()
    assert client.put(f"/api/themes/default/{theme['id']}", headers=auth_headers_admin).status_code == 200
    custom = client.get(endpoint, headers=auth_headers_user).json()
    assert custom["theme"]["marker"] != dark["theme"]["marker"]
    definition["primary"]["main"] = "#ABCDEF"
    assert (
        client.put(
            f"/api/themes/{theme['id']}",
            headers=auth_headers_admin,
            json={"scope": "site", "definition": definition, "version": theme["version"]},
        ).status_code
        == 200
    )
    edited = client.get(endpoint, headers=auth_headers_user).json()
    assert edited["theme"]["marker"] != custom["theme"]["marker"]
    assert edited["directory_index"] == before["directory_index"]


def test_private_theme_delivery_is_scoped_to_its_user(client, auth_headers_user, auth_headers_admin, regular_user):
    definition = complete_theme_definition()
    theme = client.post("/api/themes", headers=auth_headers_user, json={"scope": "user", "definition": definition}).json()
    assert (
        client.put(
            "/api/auth/me/settings", headers=auth_headers_user, json={"field": "appearance.theme_id", "value": theme["id"]}
        ).status_code
        == 200
    )
    metadata = client.get("/api/admin/settings/companion", headers=auth_headers_user).json()
    other = client.get("/api/admin/settings/companion", headers=auth_headers_admin).json()
    assert metadata["theme"]["marker"] != other["theme"]["marker"]
    assert metadata["theme"]["user_scope"] == str(regular_user.id)
    binding = {**_policy_grant_binding(), "sections": ["theme"]}
    issued = client.post("/api/admin/settings/companion/grants", headers={**auth_headers_user, "Origin": binding["origin"]}, json=binding)
    assert issued.status_code == 200
    redeem = {key: value for key, value in binding.items() if key != "sections"}
    result = client.post("/api/admin/settings/companion/grants/redeem", json={**redeem, "grant": issued.json()["grant"]})
    assert result.status_code == 200
    assert result.json()["theme"]["payload"] == {"id": theme["id"], "mode": "dark", "primary": {"main": definition["primary"]["main"]}}


def test_localization_changes_only_its_marker(client, auth_headers_user):
    endpoint = "/api/admin/settings/companion"
    before = client.get(endpoint, headers=auth_headers_user).json()
    assert (
        client.put(
            "/api/auth/me/settings", headers=auth_headers_user, json={"field": "localization.regional_locale", "value": "en-GB"}
        ).status_code
        == 200
    )
    after = client.get(endpoint, headers=auth_headers_user).json()
    assert after["localization"]["marker"] != before["localization"]["marker"]
    assert after["theme"] == before["theme"]
    assert after["directory_index"] == before["directory_index"]


def test_retired_policy_delivery_requires_update(client, auth_headers_user):
    binding = _policy_grant_binding()
    endpoint = "/api/admin/settings/directory-index/companion/grants"
    assert client.post(endpoint, headers=auth_headers_user, json=binding).status_code == 426
    assert client.post(endpoint + "/redeem", json={**binding, "grant": "obsolete"}).status_code == 426
