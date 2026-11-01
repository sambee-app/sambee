import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlmodel import Session, create_engine, select
from sqlmodel.pool import StaticPool

import app.api.system_settings as system_settings_api
import app.db.database as database_module
from app.core.system_setting_definitions import SystemSettingKey
from app.db.migrations import _apply_per_field_system_settings_migration
from app.models.connection import Connection
from app.models.oidc import OidcFlow, OidcFlowPurpose, OidcFlowStatus, OidcProviderConfiguration
from app.models.system_settings import SmbAuthenticationModeUpdate, SmbPolicySettings, SystemSetting
from app.models.user import User, UserRole
from app.services.system_settings import (
    SmbPolicyConfigurationError,
    get_integer_setting_value,
    get_smb_policy_settings,
    get_smbclient_policy_kwargs,
    refresh_smb_runtime_policy,
    retire_smb_runtime_policy,
)
from app.services.system_settings import store as system_settings_store


def _create_system_settings_table(connection) -> None:
    connection.execute(
        text(
            """
            CREATE TABLE systemsetting (
                key VARCHAR PRIMARY KEY,
                value VARCHAR NOT NULL,
                updated_at TIMESTAMP NOT NULL,
                updated_by_user_id CHAR(32)
            )
            """
        )
    )


@pytest.mark.parametrize("scope", ["backend", "companion"])
def test_directory_index_policy_settings_require_administrator(client, auth_headers_user, scope):
    assert client.get(f"/api/admin/settings/directory-index/{scope}", headers=auth_headers_user).status_code == 403
    response = client.put(
        f"/api/admin/settings/directory-index/{scope}", headers=auth_headers_user, json={"field": "page_cache_kib", "value": 1024}
    )
    assert response.status_code == 403


def test_directory_index_policy_updates_are_scoped_and_revisioned(client, auth_headers_admin):
    response = client.put(
        "/api/admin/settings/directory-index/backend", headers=auth_headers_admin, json={"field": "page_cache_kib", "value": 1024}
    )
    assert response.status_code == 200
    assert response.json() == {"field": "page_cache_kib", "value": 1024}
    backend = client.get("/api/admin/settings/directory-index/backend", headers=auth_headers_admin).json()
    companion = client.get("/api/admin/settings/directory-index/companion", headers=auth_headers_admin).json()
    assert backend["policy"]["page_cache_kib"] == 1024
    assert backend["revision"] == 1
    assert companion["policy"]["page_cache_kib"] == 2048
    assert companion["revision"] == 0
    assert client.put("/api/admin/settings/directory-index/backend", headers=auth_headers_admin, json=response.json()).status_code == 200
    assert client.get("/api/admin/settings/directory-index/backend", headers=auth_headers_admin).json()["revision"] == 1


def test_directory_index_policy_correlated_update_rolls_back(client, auth_headers_admin):
    response = client.put(
        "/api/admin/settings/directory-index/backend",
        headers=auth_headers_admin,
        json={"field": "healthy_verification_seconds", "value": 60},
    )
    assert response.status_code == 400
    policy = client.get("/api/admin/settings/directory-index/backend", headers=auth_headers_admin).json()
    assert policy["revision"] == 0
    assert policy["policy"]["healthy_verification_seconds"] == 900


def test_directory_index_policy_rejects_extra_browser_values(client, auth_headers_admin):
    response = client.put(
        "/api/admin/settings/directory-index/companion",
        headers=auth_headers_admin,
        json={"field": "page_cache_kib", "value": 1024, "policy": {"disk_budget_bytes": 1}},
    )
    assert response.status_code == 422


def _policy_grant_binding():
    import uuid

    return {"companion_id": str(uuid.uuid4()), "challenge": "challenge_" + "a" * 32, "origin": "https://sambee.example"}


@pytest.mark.parametrize("origin", ["https://" + ".".join(["\u00e9" * 20] * 50), "https://" + ".".join(["\u00e9"] * 256)])
def test_directory_policy_origin_limits_input_and_canonical_utf8_bytes(origin):
    from pydantic import ValidationError

    from app.models.system_settings import DirectoryPolicyGrantBinding

    with pytest.raises(ValidationError, match="2048 UTF-8 bytes"):
        DirectoryPolicyGrantBinding(**{**_policy_grant_binding(), "origin": origin})


def test_directory_policy_origin_accepts_exact_utf8_byte_limit():
    from app.core.directory_index_contract import MAX_DIRECTORY_POLICY_ORIGIN_BYTES
    from app.models.system_settings import DirectoryPolicyGrantBinding

    prefix = "https://"
    origin = prefix + "a" * (MAX_DIRECTORY_POLICY_ORIGIN_BYTES - len(prefix))
    binding = DirectoryPolicyGrantBinding(**{**_policy_grant_binding(), "origin": origin})
    assert len(binding.origin.encode("utf-8")) == MAX_DIRECTORY_POLICY_ORIGIN_BYTES


def test_directory_policy_grant_is_single_use_and_returns_backend_policy(client, auth_headers_admin):
    binding = _policy_grant_binding()
    issued = client.post(
        "/api/admin/settings/directory-index/companion/grants", headers={**auth_headers_admin, "Origin": binding["origin"]}, json=binding
    )
    assert issued.status_code == 200
    redeem = {**binding, "grant": issued.json()["grant"]}
    desired = client.get("/api/admin/settings/directory-index/companion", headers=auth_headers_admin)
    assert desired.status_code == 200
    assert desired.json()["backend_identity"] == issued.json()["backend_identity"]
    accepted = client.post("/api/admin/settings/directory-index/companion/grants/redeem", json=redeem)
    assert accepted.status_code == 200
    assert accepted.json()["policy"]["disk_budget_bytes"] == 2147483648
    assert accepted.json()["backend_identity"] == issued.json()["backend_identity"]
    assert client.post("/api/admin/settings/directory-index/companion/grants/redeem", json=redeem).status_code == 409


def test_directory_policy_revisions_are_safe_wire_integers():
    from app.core.directory_index_contract import MAX_WIRE_INTEGER
    from app.models.system_settings import DirectoryIndexPolicy, DirectoryIndexSettingsRead

    values = {"scope": "companion", "policy": DirectoryIndexPolicy(), "backend_identity": "a" * 64, "fields": {}}
    assert DirectoryIndexSettingsRead(**values, revision=MAX_WIRE_INTEGER).revision == MAX_WIRE_INTEGER
    with pytest.raises(ValueError):
        DirectoryIndexSettingsRead(**values, revision=MAX_WIRE_INTEGER + 1)


@pytest.mark.parametrize("permission_change", ["role", "disabled", "expired", "token_version"])
def test_directory_policy_grant_rechecks_current_administrator(client, auth_headers_admin, admin_user, session, permission_change):
    from app.models.companion_uri_token_jti import CompanionDirectoryPolicyGrant

    binding = _policy_grant_binding()
    issued = client.post(
        "/api/admin/settings/directory-index/companion/grants", headers={**auth_headers_admin, "Origin": binding["origin"]}, json=binding
    )
    assert issued.status_code == 200
    if permission_change == "role":
        admin_user.role = UserRole.EDITOR
    elif permission_change == "disabled":
        admin_user.is_active = False
    elif permission_change == "expired":
        admin_user.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    else:
        admin_user.token_version += 1
    session.add(admin_user)
    session.commit()
    response = client.post("/api/admin/settings/directory-index/companion/grants/redeem", json={**binding, "grant": issued.json()["grant"]})
    assert response.status_code == 403
    assert session.exec(select(CompanionDirectoryPolicyGrant)).one().consumed_at is None


def test_directory_policy_grant_ledger_expiry_and_browser_tokens_are_refused(client, auth_headers_admin, admin_token, session):
    from app.models.companion_uri_token_jti import CompanionDirectoryPolicyGrant

    binding = _policy_grant_binding()
    issued = client.post(
        "/api/admin/settings/directory-index/companion/grants", headers={**auth_headers_admin, "Origin": binding["origin"]}, json=binding
    )
    assert issued.status_code == 200
    ordinary = client.post("/api/admin/settings/directory-index/companion/grants/redeem", json={**binding, "grant": admin_token})
    assert ordinary.status_code in {401, 403}
    record = session.exec(select(CompanionDirectoryPolicyGrant)).one()
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    session.add(record)
    session.commit()
    expired = client.post("/api/admin/settings/directory-index/companion/grants/redeem", json={**binding, "grant": issued.json()["grant"]})
    assert expired.status_code == 409
    session.refresh(record)
    assert record.consumed_at is None


@pytest.mark.parametrize(
    "field,value", [("challenge", "b" * 32), ("companion_id", "00000000-0000-0000-0000-000000000000"), ("origin", "https://other.example")]
)
def test_directory_policy_grant_rejects_changed_bindings(client, auth_headers_admin, field, value):
    binding = _policy_grant_binding()
    issued = client.post(
        "/api/admin/settings/directory-index/companion/grants", headers={**auth_headers_admin, "Origin": binding["origin"]}, json=binding
    ).json()
    binding[field] = value
    assert (
        client.post("/api/admin/settings/directory-index/companion/grants/redeem", json={**binding, "grant": issued["grant"]}).status_code
        == 403
    )


def test_directory_policy_grant_cannot_authenticate_browser_or_deliver_extra_policy(client, auth_headers_admin):
    binding = _policy_grant_binding()
    issued = client.post(
        "/api/admin/settings/directory-index/companion/grants", headers={**auth_headers_admin, "Origin": binding["origin"]}, json=binding
    ).json()
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer " + issued["grant"]}).status_code == 401
    assert (
        client.post(
            "/api/admin/settings/directory-index/companion/grants/redeem",
            json={**binding, "grant": issued["grant"], "policy": {"disk_budget_bytes": 1}},
        ).status_code
        == 422
    )


def test_directory_policy_grant_rejects_nonadministrator_and_nonloopback_http(client, auth_headers_user):
    binding = _policy_grant_binding()
    assert (
        client.post(
            "/api/admin/settings/directory-index/companion/grants", headers={**auth_headers_user, "Origin": binding["origin"]}, json=binding
        ).status_code
        == 403
    )
    binding["origin"] = "http://untrusted.example"
    assert (
        client.post("/api/admin/settings/directory-index/companion/grants/redeem", json={**binding, "grant": "invalid"}).status_code == 422
    )


def test_directory_policy_grant_rejects_changed_desired_revision(client, auth_headers_admin):
    binding = _policy_grant_binding()
    issued = client.post(
        "/api/admin/settings/directory-index/companion/grants", headers={**auth_headers_admin, "Origin": binding["origin"]}, json=binding
    ).json()
    client.put("/api/admin/settings/directory-index/companion", headers=auth_headers_admin, json={"field": "page_cache_kib", "value": 1024})
    assert (
        client.post("/api/admin/settings/directory-index/companion/grants/redeem", json={**binding, "grant": issued["grant"]}).status_code
        == 409
    )


def test_policy_blob_migration_materializes_missing_keys_and_keeps_existing_values() -> None:
    engine = create_engine("sqlite://")
    try:
        with engine.begin() as connection:
            _create_system_settings_table(connection)
            connection.execute(
                text("INSERT INTO systemsetting (key, value, updated_at, updated_by_user_id) VALUES (:key, :value, :updated_at, :user_id)"),
                {
                    "key": "file_search.policy",
                    "value": '{"retention_limit":25,"result_limit":12,"excluded_categories":["images"],"excluded_extensions":[".tmp"]}',
                    "updated_at": "2025-01-02T03:04:05+00:00",
                    "user_id": "legacy-user",
                },
            )
            connection.execute(
                text(
                    "INSERT INTO systemsetting (key, value, updated_at, updated_by_user_id) VALUES ('file_search.result_limit', '33', CURRENT_TIMESTAMP, 'new-user')"
                )
            )
            _apply_per_field_system_settings_migration(connection)

            rows = connection.execute(text("SELECT key, value, updated_by_user_id FROM systemsetting")).mappings().all()
        values = {row["key"]: row for row in rows}
        assert "file_search.policy" not in values
        assert values["file_search.retention_limit"]["value"] == "25"
        assert values["file_search.retention_limit"]["updated_by_user_id"] == "legacy-user"
        assert values["file_search.result_limit"]["value"] == "33"
        assert values["file_search.result_limit"]["updated_by_user_id"] == "new-user"
        assert values["file_search.excluded_categories"]["value"] == '["images"]'
        assert values["file_search.excluded_extensions"]["value"] == '[".tmp"]'
    finally:
        engine.dispose()


def test_policy_blob_migration_rolls_back_invalid_legacy_json() -> None:
    engine = create_engine("sqlite://")
    try:
        with engine.begin() as connection:
            _create_system_settings_table(connection)
            connection.execute(
                text("INSERT INTO systemsetting (key, value, updated_at) VALUES ('file_search.policy', 'not-json', CURRENT_TIMESTAMP)")
            )

        with pytest.raises(RuntimeError, match="Cannot migrate invalid legacy system setting file_search.policy"):
            with engine.begin() as connection:
                _apply_per_field_system_settings_migration(connection)

        with engine.connect() as connection:
            rows = connection.execute(text("SELECT key FROM systemsetting")).scalars().all()
        assert rows == ["file_search.policy"]
    finally:
        engine.dispose()


class TestAboutSettingsApi:
    def test_admin_can_fetch_safe_about_information(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        response = client.get("/api/admin/settings/about", headers=auth_headers_admin)

        assert response.status_code == 200
        data = response.json()
        assert data["version"]
        assert data["started_at"]
        assert data["architecture"]
        assert data["python_runtime"]
        assert "database_version" not in data
        assert {"containerized", "environment", "hostname", "mounts", "network", "operating_system"}.isdisjoint(data)

    def test_regular_user_cannot_fetch_about_information(self, client: TestClient, auth_headers_user: dict[str, str]) -> None:
        response = client.get("/api/admin/settings/about", headers=auth_headers_user)

        assert response.status_code == 403


class TestPublicSupportReportApi:
    def test_admin_can_fetch_public_safe_report(self, client: TestClient, auth_headers_admin: dict[str, str], session: Session) -> None:
        public_url = "https://files.northwind.example"
        trusted_proxy = "10.42.0.0/16"
        issuer_url = "https://login.northwind.example/tenant-a"
        client_id = "northwind-sambee-client"
        client_secret = "northwind-oidc-super-secret"
        group_name = "Northwind-Administrators"
        connection_name = "Northwind Finance"
        connection_host = "fileserver.northwind.internal"
        connection_share = "Finance"
        connection_username = "northwind-service"
        connection_password = "encrypted-northwind-password"

        session.add_all(
            [
                SystemSetting(key="network.public_url", value=public_url),
                SystemSetting(key="network.trusted_proxy_cidrs", value=trusted_proxy),
                SystemSetting(key="auth.mode", value="oidc_or_password"),
                OidcProviderConfiguration(
                    display_name="Northwind Identity",
                    issuer_url=issuer_url,
                    client_id=client_id,
                    encrypted_client_secret=client_secret,
                    scopes_json='["openid", "northwind.files.read"]',
                    admission_groups_json=f'["{group_name}"]',
                    role_mappings_json=f'{{"admin":["{group_name}"],"editor":[],"viewer":[]}}',
                ),
                Connection(
                    name=connection_name,
                    host=connection_host,
                    share_name=connection_share,
                    username=connection_username,
                    password_encrypted=connection_password,
                ),
            ]
        )
        session.commit()

        response = client.get("/api/admin/settings/support-report", headers=auth_headers_admin)

        assert response.status_code == 200
        report = response.json()["content"]
        assert "# Sambee public support report" in report
        assert 'public_url = "https://public-endpoint-1.invalid"' in report
        assert 'trusted_proxy_cidrs = ["ipv4-network-1/16"]' in report
        assert 'oidc.provider = "oidc-provider-1"' in report
        assert 'oidc.issuer_url = "https://oidc-provider-1.invalid/oidc-provider-path-1"' in report
        assert 'oidc.client_id = "oidc-client-1"' in report
        assert 'oidc.admission_groups = ["oidc-group-1"]' in report
        assert 'oidc.role_mappings.admin = ["oidc-group-1"]' in report
        assert "total = 1 # source: ui" in report
        assert 'by_type = {"smb": 1} # source: ui' in report

        for sensitive_value in (
            public_url,
            trusted_proxy,
            issuer_url,
            client_id,
            client_secret,
            group_name,
            connection_name,
            connection_host,
            connection_share,
            connection_username,
            connection_password,
        ):
            assert sensitive_value not in report

    def test_regular_user_cannot_fetch_public_support_report(self, client: TestClient, auth_headers_user: dict[str, str]) -> None:
        response = client.get("/api/admin/settings/support-report", headers=auth_headers_user)

        assert response.status_code == 403


class TestAdvancedSystemSettingsApi:
    def test_returns_default_when_system_settings_table_is_missing(self, tmp_path: Path, monkeypatch) -> None:
        test_engine = create_engine(
            f"sqlite:///{tmp_path / 'missing-system-settings.db'}",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )

        try:
            monkeypatch.setattr(database_module, "engine", test_engine)
            system_settings_store._cache = {}
            system_settings_store._loaded = False

            assert get_integer_setting_value(SystemSettingKey.SMB_READ_CHUNK_SIZE_BYTES) == 4 * 1024 * 1024
            assert system_settings_store._loaded is False
        finally:
            test_engine.dispose()

    def test_admin_can_fetch_advanced_settings(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        response = client.get("/api/admin/settings/advanced", headers=auth_headers_admin)

        assert response.status_code == 200
        data = response.json()
        assert data["preprocessors"]["imagemagick"]["timeout_seconds"]["value"] == 30
        assert data["pdf"]["screen_derivative_enabled"]["value"] == 0
        assert data["pdf"]["cpu_time_seconds"]["value"] == 60

    def test_regular_user_cannot_fetch_advanced_settings(self, client: TestClient, auth_headers_user: dict[str, str]) -> None:
        response = client.get("/api/admin/settings/advanced", headers=auth_headers_user)

        assert response.status_code == 403

    def test_admin_can_update_advanced_settings(self, client: TestClient, auth_headers_admin: dict[str, str], session: Session) -> None:
        response = client.put(
            "/api/admin/settings/advanced",
            headers=auth_headers_admin,
            json={"field": "preprocessors.imagemagick.timeout_seconds", "value": 45},
        )

        assert response.status_code == 200
        assert response.json() == {"field": "preprocessors.imagemagick.timeout_seconds", "value": 45}

    def test_admin_can_update_pdf_rollout_and_cpu_limits(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        response = client.put(
            "/api/admin/settings/advanced",
            headers=auth_headers_admin,
            json={"field": "pdf.screen_derivative.enabled", "value": 1},
        )

        assert response.status_code == 200
        assert response.json() == {"field": "pdf.screen_derivative.enabled", "value": 1}

    def test_update_rejects_out_of_range_values(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        response = client.put(
            "/api/admin/settings/advanced",
            headers=auth_headers_admin,
            json={"field": "preprocessors.imagemagick.timeout_seconds", "value": 1},
        )

        assert response.status_code == 400
        assert "between" in response.json()["detail"]


class TestSmbSettingsApi:
    def test_admin_can_fetch_default_smb_settings(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        response = client.get("/api/admin/settings/smb", headers=auth_headers_admin)

        assert response.status_code == 200
        data = response.json()
        assert data["read_chunk_size_bytes"]["value"] == 4 * 1024 * 1024
        assert data["policy"] == {
            "authentication_mode": "negotiate",
            "encryption_mode": "signing_only",
            "connection_timeout_seconds": 30,
        }
        assert data["require_signing"] is True
        assert data["require_encryption"] is False

    def test_admin_can_update_independent_smb_fields(
        self, client: TestClient, auth_headers_admin: dict[str, str], session: Session
    ) -> None:
        for payload in (
            {"field": "read_chunk_size_bytes", "value": 2 * 1024 * 1024},
            {"field": "authentication_mode", "value": "kerberos_required"},
            {"field": "encryption_mode", "value": "encryption_required"},
            {"field": "connection_timeout_seconds", "value": 45},
        ):
            response = client.put("/api/admin/settings/smb", headers=auth_headers_admin, json=payload)
            assert response.status_code == 200
            assert response.json() == payload

        data = client.get("/api/admin/settings/smb", headers=auth_headers_admin).json()
        assert data["policy"] == {
            "authentication_mode": "kerberos_required",
            "encryption_mode": "encryption_required",
            "connection_timeout_seconds": 45,
        }
        assert data["require_encryption"] is True
        assert session.get(SystemSetting, SystemSettingKey.SMB_AUTHENTICATION_MODE.value) is not None

    def test_smb_update_rejects_legacy_policy_payload(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        response = client.put(
            "/api/admin/settings/smb",
            headers=auth_headers_admin,
            json={
                "policy": {
                    "authentication_mode": "negotiate",
                    "enforce_target_allowlist": True,
                    "allowed_target_hostnames": [],
                    "allowed_target_cidrs": [],
                    "allowed_ports": [445],
                    "connection_timeout_seconds": 30,
                }
            },
        )

        assert response.status_code == 422

    def test_regular_user_cannot_update_smb_settings(self, client: TestClient, auth_headers_user: dict[str, str]) -> None:
        response = client.put(
            "/api/admin/settings/smb", headers=auth_headers_user, json={"field": "authentication_mode", "value": "negotiate"}
        )

        assert response.status_code == 403

    def test_policy_update_retires_existing_smb_runtime_state(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        with patch("app.api.system_settings.refresh_smb_runtime_policy", new_callable=AsyncMock) as mock_refresh:
            response = client.put(
                "/api/admin/settings/smb",
                headers=auth_headers_admin,
                json={"field": "authentication_mode", "value": "kerberos_required"},
            )

        assert response.status_code == 200
        mock_refresh.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_policy_update_waits_for_runtime_refresh(self, session: Session, admin_user: User) -> None:
        refresh_started = asyncio.Event()
        allow_refresh_to_finish = asyncio.Event()

        async def wait_for_refresh_completion() -> None:
            refresh_started.set()
            await allow_refresh_to_finish.wait()

        with (
            patch("app.api.system_settings.retire_smb_runtime_policy", new_callable=AsyncMock) as mock_retire,
            patch("app.api.system_settings.refresh_smb_runtime_policy", side_effect=wait_for_refresh_completion) as mock_refresh,
        ):
            update_task = asyncio.create_task(
                system_settings_api.put_smb_settings(
                    SmbAuthenticationModeUpdate(field="authentication_mode", value="kerberos_required"),
                    current_user=admin_user,
                    session=session,
                )
            )

            await asyncio.wait_for(refresh_started.wait(), timeout=1)
            assert not update_task.done()

            allow_refresh_to_finish.set()
            response = await update_task

        assert response.field == "authentication_mode"
        assert response.value == "kerberos_required"
        mock_retire.assert_awaited_once()
        mock_refresh.assert_awaited_once()

    def test_invalid_policy_update_does_not_retire_smb_runtime_state(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        with patch("app.api.system_settings.refresh_smb_runtime_policy", new_callable=AsyncMock) as mock_refresh:
            response = client.put(
                "/api/admin/settings/smb",
                headers=auth_headers_admin,
                json={"field": "connection_timeout_seconds", "value": 1},
            )

        assert response.status_code == 400
        mock_refresh.assert_not_awaited()

    def test_read_chunk_update_does_not_refresh_smb_runtime_state(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        with patch("app.api.system_settings.refresh_smb_runtime_policy", new_callable=AsyncMock) as mock_refresh:
            response = client.put(
                "/api/admin/settings/smb",
                headers=auth_headers_admin,
                json={"field": "read_chunk_size_bytes", "value": 2 * 1024 * 1024},
            )

        assert response.status_code == 200
        mock_refresh.assert_not_awaited()

    def test_default_policy_save_does_not_refresh_smb_runtime_state(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        with patch("app.api.system_settings.refresh_smb_runtime_policy", new_callable=AsyncMock) as mock_refresh:
            response = client.put(
                "/api/admin/settings/smb",
                headers=auth_headers_admin,
                json={"field": "authentication_mode", "value": "negotiate"},
            )

        assert response.status_code == 200
        mock_refresh.assert_not_awaited()


@pytest.mark.asyncio
async def test_refresh_smb_runtime_policy_restarts_directory_services() -> None:
    cache_manager = MagicMock()
    monitor = MagicMock()
    cache_manager.stop_all_async = AsyncMock()
    monitor.restart_all_async = AsyncMock()

    with (
        patch("app.services.directory_cache.get_directory_cache_manager", return_value=cache_manager),
        patch("app.services.directory_monitor.get_monitor", return_value=monitor),
    ):
        await refresh_smb_runtime_policy()

    cache_manager.stop_all_async.assert_awaited_once()
    monitor.restart_all_async.assert_awaited_once()


@pytest.mark.asyncio
async def test_retire_smb_runtime_policy_retires_contexts_immediately() -> None:
    with patch("app.storage.smb_pool.retire_all_smb_connection_contexts", new_callable=AsyncMock) as mock_retire:
        await retire_smb_runtime_policy()

    mock_retire.assert_awaited_once_with("SMB policy updated")


def test_invalid_persisted_smb_policy_disables_smb_access(monkeypatch) -> None:
    monkeypatch.setattr(system_settings_store, "get_override", lambda key: "not-json")

    with pytest.raises(SmbPolicyConfigurationError):
        get_smb_policy_settings()


def test_smbclient_policy_requires_encryption_only_for_strict_mode() -> None:
    signing_only_policy = SmbPolicySettings()
    strict_policy = SmbPolicySettings(encryption_mode="encryption_required")

    with patch("app.services.system_settings.get_smb_policy_settings", return_value=signing_only_policy):
        assert get_smbclient_policy_kwargs()["encrypt"] is False

    with patch("app.services.system_settings.get_smb_policy_settings", return_value=strict_policy):
        assert get_smbclient_policy_kwargs()["encrypt"] is True


class TestNetworkSettingsApi:
    def test_admin_can_update_network_settings(self, client: TestClient, auth_headers_admin: dict[str, str], session: Session) -> None:
        public_url_response = client.put(
            "/api/admin/settings/network",
            headers=auth_headers_admin,
            json={"field": "public_url", "value": "https://files.example.test/"},
        )
        cidrs_response = client.put(
            "/api/admin/settings/network",
            headers=auth_headers_admin,
            json={"field": "trusted_proxy_cidrs", "value": ["10.0.0.4/24", "2001:db8::1/64", "10.0.0.0/24"]},
        )

        assert public_url_response.json() == {"field": "public_url", "value": "https://files.example.test"}
        assert cidrs_response.json() == {"field": "trusted_proxy_cidrs", "value": ["10.0.0.0/24", "2001:db8::/64"]}
        stored_public_url = session.get(SystemSetting, "network.public_url")
        assert stored_public_url is not None
        assert stored_public_url.value == "https://files.example.test"

    def test_network_settings_reject_public_url_path(self, client: TestClient, auth_headers_admin: dict[str, str]) -> None:
        response = client.put(
            "/api/admin/settings/network",
            headers=auth_headers_admin,
            json={"field": "public_url", "value": "https://files.example.test/sambee"},
        )

        assert response.status_code == 400
        assert "must not include a path" in response.json()["detail"]

    def test_regular_user_cannot_update_network_settings(self, client: TestClient, auth_headers_user: dict[str, str]) -> None:
        response = client.put(
            "/api/admin/settings/network",
            headers=auth_headers_user,
            json={"field": "public_url", "value": "https://files.example.test"},
        )

        assert response.status_code == 403

    def test_public_url_change_invalidates_oidc_flows(
        self, client: TestClient, auth_headers_admin: dict[str, str], session: Session
    ) -> None:
        session.add(
            OidcFlow(
                purpose=OidcFlowPurpose.LOGIN,
                status=OidcFlowStatus.STARTED,
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
            )
        )
        session.add(SystemSetting(key="network.public_url", value="https://old.example.test"))
        session.commit()

        response = client.put(
            "/api/admin/settings/network",
            headers=auth_headers_admin,
            json={"field": "public_url", "value": "https://new.example.test"},
        )

        assert response.status_code == 200
        assert session.exec(select(OidcFlow)).first() is None
