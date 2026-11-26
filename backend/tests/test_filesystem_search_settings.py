import json
from copy import deepcopy

import pytest

from app.core.filesystem_search_contract import CONTRACT_PATH
from app.core.filesystem_search_policy import POLICY_BOUNDS, _load_policy_bounds
from app.core.system_setting_definitions import SystemSettingKey
from app.models.system_settings import SystemSetting
from app.services.system_settings import get_filesystem_search_policy
from tests.test_system_settings import _policy_grant_binding

URL = "/api/admin/settings/filesystem-search"
COMPANION_URL = "/api/admin/settings/companion"
LOCALE = {"browser_regional_locale": "en-US"}
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))


def test_policy_bounds_are_loaded_from_shared_contract():
    changed = deepcopy(CONTRACT)
    changed["policy_bounds"]["max_seconds"] = {"min": 5, "max": 45}
    changed["policy_defaults"]["max_seconds"] = 20
    result = _load_policy_bounds(changed)
    assert (result["max_seconds"].minimum, result["max_seconds"].maximum, result["max_seconds"].default) == (5, 45, 20)
    for name, bound in POLICY_BOUNDS.items():
        assert (bound.minimum, bound.maximum, bound.default) == (
            CONTRACT["policy_bounds"][name]["min"],
            CONTRACT["policy_bounds"][name]["max"],
            CONTRACT["policy_defaults"][name],
        )


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("policy_bounds", "max_seconds", {"min": True, "max": 60}),
        ("policy_bounds", "max_seconds", {"min": 0, "max": 60}),
        ("policy_bounds", "max_seconds", {"min": 61, "max": 60}),
        ("policy_bounds", "max_seconds", {"min": 1, "max": 59}),
        ("policy_bounds", "max_seconds", {"min": 1, "max": 2**53}),
        ("policy_bounds", "max_seconds", {"min": 1, "max": 60, "extra": 1}),
        ("policy_bounds", "max_seconds", None),
        ("policy_defaults", "max_seconds", 60.0),
        ("policy_defaults", "extra", 1),
    ],
)
def test_policy_contract_rejects_invalid_bounds(section, field, value):
    changed = deepcopy(CONTRACT)
    changed[section][field] = value
    with pytest.raises(ValueError, match="policy bounds or defaults are invalid"):
        _load_policy_bounds(changed)


def test_policy_contract_requires_version_and_every_field():
    changed = deepcopy(CONTRACT)
    del changed["policy_bounds"]["max_seconds"]
    with pytest.raises(ValueError, match="policy bounds or defaults are invalid"):
        _load_policy_bounds(changed)
    changed = deepcopy(CONTRACT)
    changed["version"] = True
    with pytest.raises(ValueError, match="policy bounds or defaults are invalid"):
        _load_policy_bounds(changed)


def test_settings_are_admin_only_persisted_and_used_by_runtime(client, session, auth_headers_admin, auth_headers_user):
    assert client.get(URL, headers=auth_headers_user).status_code == 403
    assert client.put(URL, headers=auth_headers_user, json={"field": "max_results", "value": 700}).status_code == 403
    initial = client.get(URL, headers=auth_headers_admin).json()
    assert initial["policy"] == {name: bound.default for name, bound in POLICY_BOUNDS.items()}
    assert initial["policy"]["max_seconds"] == 60
    for name in POLICY_BOUNDS:
        assert initial["fields"][name]["min_value"] == CONTRACT["policy_bounds"][name]["min"]
        assert initial["fields"][name]["max_value"] == CONTRACT["policy_bounds"][name]["max"]
    snapshot = get_filesystem_search_policy(session)
    for field, value in (("concurrent_searches", 2), ("max_seconds", 30), ("max_results", 1000)):
        assert client.put(URL, headers=auth_headers_admin, json={"field": field, "value": value}).status_code == 200
    current = client.get(URL, headers=auth_headers_admin).json()
    assert current["policy"] == {"concurrent_searches": 2, "max_seconds": 30, "max_results": 1000}
    assert all(field["source"] == "database" for field in current["fields"].values())
    assert get_filesystem_search_policy(session).model_dump() == current["policy"]
    assert snapshot.model_dump() == initial["policy"]
    row = session.get(SystemSetting, SystemSettingKey.FILESYSTEM_SEARCH_POLICY.value)
    assert row is not None
    assert json.loads(row.value) == current["policy"]


@pytest.mark.parametrize("field", list(POLICY_BOUNDS))
def test_policy_validates_boundaries_and_strict_types(client, auth_headers_admin, field):
    bound = POLICY_BOUNDS[field]
    for value in (0, bound.maximum + 1, True, 1.0, "1", None):
        assert client.put(URL, headers=auth_headers_admin, json={"field": field, "value": value}).status_code == 422
    for value in (bound.minimum, bound.maximum):
        assert client.put(URL, headers=auth_headers_admin, json={"field": field, "value": value}).status_code == 200
    assert client.put(URL, headers=auth_headers_admin, json={"field": field, "value": 1, "extra": 1}).status_code == 422
    assert client.put(URL, headers=auth_headers_admin, json={"field": "other", "value": 1}).status_code == 422


@pytest.mark.parametrize("invalid", ['{"max_seconds": true}', '{"max_results": 1001}', '{"extra": 1}', "[]", "not-json"])
def test_invalid_stored_policy_fails_closed(session, invalid):
    session.add(SystemSetting(key=SystemSettingKey.FILESYSTEM_SEARCH_POLICY.value, value=invalid))
    session.commit()
    with pytest.raises(ValueError, match="Stored file-system search policy is invalid"):
        get_filesystem_search_policy(session)


def test_invalid_stored_policy_reports_actionable_error(client, session, auth_headers_admin, auth_headers_user):
    session.add(SystemSetting(key=SystemSettingKey.FILESYSTEM_SEARCH_POLICY.value, value='{"max_seconds": false}'))
    session.commit()
    response = client.get(URL, headers=auth_headers_admin)
    assert response.status_code == 503
    assert "filesystem_search.policy database entry" in response.json()["detail"]
    response = client.get(COMPANION_URL, headers=auth_headers_user, params={**LOCALE, "include_filesystem_search": "true"})
    assert response.status_code == 503
    assert client.get(COMPANION_URL, headers=auth_headers_user, params=LOCALE).status_code == 200


def test_companion_opt_in_delivery_and_stale_grants(client, auth_headers_admin, auth_headers_user):
    headers = {**auth_headers_user, "Origin": "https://sambee.example"}
    legacy = client.get(COMPANION_URL, headers=headers, params=LOCALE).json()
    assert "filesystem_search" not in legacy
    extended = client.get(COMPANION_URL, headers=headers, params={**LOCALE, "include_filesystem_search": "true"}).json()
    marker = extended["filesystem_search"]
    assert marker["user_scope"] is None
    binding = {**_policy_grant_binding(), "version": 1, "sections": ["filesystem_search"]}
    issued = client.post(f"{COMPANION_URL}/grants", headers=headers, params=LOCALE, json=binding)
    assert issued.status_code == 200
    assert issued.json()["filesystem_search"] == marker
    redeem = {key: value for key, value in binding.items() if key != "sections"}
    response = client.post(f"{COMPANION_URL}/grants/redeem", json={**redeem, "grant": issued.json()["grant"]})
    assert response.status_code == 200
    assert response.json()["filesystem_search"] == {
        **marker,
        "payload": {name: bound.default for name, bound in POLICY_BOUNDS.items()},
    }

    issued = client.post(f"{COMPANION_URL}/grants", headers=headers, params=LOCALE, json=binding).json()
    assert client.put(URL, headers=auth_headers_admin, json={"field": "max_results", "value": 750}).status_code == 200
    assert client.post(f"{COMPANION_URL}/grants/redeem", json={**redeem, "grant": issued["grant"]}).status_code == 409
    updated = client.get(COMPANION_URL, headers=headers, params={**LOCALE, "include_filesystem_search": "true"}).json()
    assert updated["filesystem_search"]["marker"] != marker["marker"]

    binding["sections"] = ["theme"]
    issued = client.post(f"{COMPANION_URL}/grants", headers=headers, params=LOCALE, json=binding).json()
    assert "filesystem_search" not in issued
    assert client.put(URL, headers=auth_headers_admin, json={"field": "max_results", "value": 800}).status_code == 200
    response = client.post(f"{COMPANION_URL}/grants/redeem", json={**redeem, "grant": issued["grant"]})
    assert response.status_code == 200
    assert "filesystem_search" not in response.json()

    invalid = {**binding, "sections": ["filesystem_search"], "policy": {"max_results": 1000}}
    assert client.post(f"{COMPANION_URL}/grants", headers=headers, params=LOCALE, json=invalid).status_code == 422
