"""Tests for admin user management endpoints."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.core.auth_methods import AuthenticationMode
from app.core.config import settings
from app.core.security import create_access_token, get_password_hash, verify_password
from app.core.user_setting_definitions import UserSettingKey
from app.models.oidc import (
    OidcFlow,
    OidcFlowPurpose,
    OidcFlowStatus,
    OidcIdentity,
    OidcPendingIdentityMapping,
    OidcProviderConfiguration,
    OidcRoleAssignmentMode,
    SignInMode,
)
from app.models.theme import StoredTheme
from app.models.user import User, UserRole
from app.models.user_settings import UserSetting
from app.services.authentication_config import set_ui_authentication_mode


@pytest.mark.integration
class TestAdminUsers:
    def test_reports_conflicts_independently_of_filters_and_clears_after_resolution(
        self, client: TestClient, session: Session, auth_headers_admin: dict, legacy_username_conflict: tuple[User, User]
    ):
        first, second = legacy_username_conflict
        second.is_active = False
        session.add(second)
        session.commit()
        response = client.get("/api/admin/users", headers=auth_headers_admin, params={"q": "no-matching-account", "page_size": 1})
        assert response.status_code == 200
        assert response.json()["items"] == []
        assert response.json()["username_conflicts"] == [["LegacyUser", "legacyuser"]]
        unchanged = client.patch(f"/api/admin/users/{first.id}", headers=auth_headers_admin, json={"name": "Updated Name"})
        assert unchanged.status_code == 200
        case_only = client.patch(f"/api/admin/users/{first.id}", headers=auth_headers_admin, json={"username": "LEGACYUSER"})
        assert case_only.status_code == 200
        duplicate = client.post("/api/admin/users", headers=auth_headers_admin, json={"username": "Legacyuser"})
        assert duplicate.status_code == 400
        renamed = client.patch(f"/api/admin/users/{second.id}", headers=auth_headers_admin, json={"username": "DistinctUser"})
        assert renamed.status_code == 200
        assert client.get("/api/admin/users", headers=auth_headers_admin).json()["username_conflicts"] == []

    def test_rejects_case_insensitive_creation_and_rename(
        self, client: TestClient, session: Session, auth_headers_admin: dict, regular_user: User
    ):
        created = client.post("/api/admin/users", headers=auth_headers_admin, json={"username": regular_user.username.upper()})
        assert created.status_code == 400
        other = User(username="AnotherUser", password_hash="hash")
        session.add(other)
        session.commit()
        renamed = client.patch(f"/api/admin/users/{other.id}", headers=auth_headers_admin, json={"username": regular_user.username.upper()})
        assert renamed.status_code == 400
        own_case = client.patch(f"/api/admin/users/{other.id}", headers=auth_headers_admin, json={"username": "ANOTHERUSER"})
        assert own_case.status_code == 200
        assert own_case.json()["username"] == "ANOTHERUSER"

    def test_list_users_as_admin(self, client: TestClient, auth_headers_admin: dict, admin_user: User, regular_user: User):
        response = client.get("/api/admin/users", headers=auth_headers_admin)

        assert response.status_code == 200
        data = response.json()
        usernames = {user["username"] for user in data["items"]}
        assert data["total"] >= 2
        assert {admin_user.username, regular_user.username}.issubset(usernames)
        assert data["summary"]["total"] == data["total"]

    def test_list_users_supports_search_role_filter_and_paging(
        self, client: TestClient, auth_headers_admin: dict, admin_user: User, regular_user: User
    ):
        response = client.get(
            "/api/admin/users",
            headers=auth_headers_admin,
            params={"q": regular_user.username, "role": "editor", "page": 1, "page_size": 1},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 1
        assert [user["username"] for user in data["items"]] == [regular_user.username]
        assert data["summary"]["total"] == 1
        assert data["summary"]["active_admins"] == 0

    def test_list_users_rejects_an_excessive_page_size(self, client: TestClient, auth_headers_admin: dict):
        response = client.get("/api/admin/users", headers=auth_headers_admin, params={"page_size": 101})

        assert response.status_code == 422

    @pytest.mark.parametrize(
        "sort",
        [
            "username",
            "role",
            "status",
            "sign_in",
            "last_sign_in",
            "expiration",
            "email",
            "created_at",
            "updated_at",
            "oidc_state",
            "role_source",
            "oidc_provider",
        ],
    )
    def test_list_users_supports_every_directory_sort(self, client: TestClient, auth_headers_admin: dict, sort: str):
        response = client.get("/api/admin/users", headers=auth_headers_admin, params={"sort": sort, "direction": "desc"})

        assert response.status_code == 200

    def test_list_users_filters_authentication_oidc_state_expiration_and_sorts(
        self, client: TestClient, auth_headers_admin: dict, admin_user: User, session: Session
    ):
        now = datetime.now(timezone.utc)
        configuration = OidcProviderConfiguration(
            display_name="Provider",
            issuer_url="https://issuer.example",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
        )
        oidc_only_user = User(username="directory-oidc", password_hash=None)
        hybrid_user = User(username="directory-hybrid", password_hash=get_password_hash("password"))
        unavailable_user = User(username="directory-unavailable", password_hash=None)
        pending_user = User(username="directory-pending", password_hash=get_password_hash("password"))
        expiring_user = User(
            username="directory-expiring",
            password_hash=get_password_hash("password"),
            expires_at=now + timedelta(days=2),
        )
        expired_user = User(
            username="directory-expired",
            password_hash=get_password_hash("password"),
            expires_at=now - timedelta(days=1),
        )
        session.add_all([configuration, oidc_only_user, hybrid_user, unavailable_user, pending_user, expiring_user, expired_user])
        session.flush()
        session.add_all(
            [
                OidcIdentity(user_id=oidc_only_user.id, issuer=configuration.issuer_url, subject="oidc-only", last_login_at=now),
                OidcIdentity(user_id=hybrid_user.id, issuer=configuration.issuer_url, subject="hybrid", last_login_at=now),
                OidcPendingIdentityMapping(
                    provider_configuration_id=configuration.id,
                    expected_username="pending-provider-user",
                    target_user_id=pending_user.id,
                    created_by_user_id=admin_user.id,
                ),
            ]
        )
        session.commit()

        def filtered_usernames(**params: str) -> set[str]:
            response = client.get("/api/admin/users", headers=auth_headers_admin, params=params)
            assert response.status_code == 200
            return {user["username"] for user in response.json()["items"]}

        assert filtered_usernames(auth="oidc") == {oidc_only_user.username}
        assert filtered_usernames(auth="password_and_oidc") == {hybrid_user.username}
        assert unavailable_user.username in filtered_usernames(auth="unavailable")
        assert filtered_usernames(oidc_state="pending") == {pending_user.username}
        assert filtered_usernames(expiration="has_expiration") == {expiring_user.username, expired_user.username}

        response = client.get(
            "/api/admin/users",
            headers=auth_headers_admin,
            params={"state": "expiring_soon", "sort": "username", "direction": "desc"},
        )

        assert response.status_code == 200
        data = response.json()
        assert [user["username"] for user in data["items"]] == [expiring_user.username]
        assert data["summary"]["total"] == 1
        assert data["summary"]["expiring_soon"] == 1

    @pytest.mark.parametrize(
        ("role_assignment_mode", "matching_source", "non_matching_source"),
        [
            (OidcRoleAssignmentMode.UNIFORM, "oidc_default", "oidc_groups"),
            (OidcRoleAssignmentMode.GROUP_BASED, "oidc_groups", "oidc_default"),
        ],
    )
    def test_list_users_role_source_respects_assignment_mode(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        regular_user: User,
        session: Session,
        role_assignment_mode: OidcRoleAssignmentMode,
        matching_source: str,
        non_matching_source: str,
    ):
        configuration = OidcProviderConfiguration(
            display_name="Provider",
            issuer_url="https://issuer.example",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
            role_assignment_mode=role_assignment_mode,
        )
        session.add_all(
            [
                configuration,
                OidcIdentity(
                    user_id=regular_user.id,
                    issuer=configuration.issuer_url,
                    subject="directory-role-source",
                    last_login_at=datetime.now(timezone.utc),
                ),
            ]
        )
        session.commit()

        matching_response = client.get("/api/admin/users", headers=auth_headers_admin, params={"role_source": matching_source})
        non_matching_response = client.get("/api/admin/users", headers=auth_headers_admin, params={"role_source": non_matching_source})

        assert matching_response.status_code == 200
        assert regular_user.username in {user["username"] for user in matching_response.json()["items"]}
        assert non_matching_response.status_code == 200
        assert non_matching_response.json()["total"] == 0

    def test_list_users_as_regular_user_forbidden(
        self,
        client: TestClient,
        auth_headers_user: dict,
        admin_user: User,
        regular_user: User,
    ):
        response = client.get("/api/admin/users", headers=auth_headers_user)

        assert response.status_code == 403

    @pytest.mark.parametrize("mode", (AuthenticationMode.PASSWORD_ONLY, AuthenticationMode.OIDC_OR_PASSWORD))
    def test_create_user_generates_temporary_password(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        admin_user: User,
        session: Session,
        mode: AuthenticationMode,
    ):
        set_ui_authentication_mode(session, mode=mode, updated_by_user_id=admin_user.id)
        session.commit()
        response = client.post(
            "/api/admin/users",
            headers=auth_headers_admin,
            json={
                "username": "newuser",
                "name": "New User",
                "email": "newuser@example.com",
                "role": "editor",
                "must_change_password": True,
                "expires_at": "2030-01-01T00:00:00Z",
            },
        )

        assert response.status_code == 201
        data = response.json()
        assert data["username"] == "newuser"
        assert data["name"] == "New User"
        assert data["email"] == "newuser@example.com"
        assert data["role"] == "editor"
        assert data["must_change_password"] is True
        assert data["expires_at"] == "2030-01-01T00:00:00Z"
        assert isinstance(data["temporary_password"], str)
        assert len(data["temporary_password"]) >= 12

        created_user = session.get(User, uuid.UUID(data["id"]))
        assert created_user is not None
        assert created_user.name == "New User"
        assert created_user.email == "newuser@example.com"
        assert created_user.role == UserRole.EDITOR
        assert created_user.must_change_password is True
        assert verify_password(data["temporary_password"], created_user.password_hash)

    @pytest.mark.parametrize("mode", (AuthenticationMode.OIDC_ONLY, AuthenticationMode.NONE))
    def test_create_user_rejected_when_local_password_authentication_is_disabled(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        admin_user: User,
        session: Session,
        mode: AuthenticationMode,
    ):
        if mode == AuthenticationMode.NONE:
            session.add(User(username=settings.admin_username, password_hash=get_password_hash("adminpass123"), role=UserRole.ADMIN))
        set_ui_authentication_mode(session, mode=mode, updated_by_user_id=admin_user.id)
        session.commit()

        response = client.post("/api/admin/users", headers=auth_headers_admin, json={"username": "unusable-local-user"})

        assert response.status_code == 409
        assert response.json()["detail"] == "Creating local users is unavailable because local-password authentication is disabled"
        assert session.exec(select(User).where(User.username == "unusable-local-user")).first() is None

    @pytest.mark.parametrize("mode", (AuthenticationMode.OIDC_ONLY, AuthenticationMode.NONE))
    def test_reset_password_rejected_when_local_password_authentication_is_disabled(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        admin_user: User,
        regular_user: User,
        session: Session,
        mode: AuthenticationMode,
    ):
        original_password_hash = regular_user.password_hash
        if mode == AuthenticationMode.NONE:
            session.add(User(username=settings.admin_username, password_hash=get_password_hash("adminpass123"), role=UserRole.ADMIN))
        set_ui_authentication_mode(session, mode=mode, updated_by_user_id=admin_user.id)
        session.commit()

        response = client.post(
            f"/api/admin/users/{regular_user.id}/reset-password",
            headers=auth_headers_admin,
            json={"new_password": "BrandNewPass123!", "must_change_password": False},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "Resetting local passwords is unavailable because local-password authentication is disabled"
        session.refresh(regular_user)
        assert regular_user.password_hash == original_password_hash

    def test_create_user_rejects_legacy_regular_role(self, client: TestClient, auth_headers_admin: dict):
        response = client.post(
            "/api/admin/users",
            headers=auth_headers_admin,
            json={
                "username": "legacyroleuser",
                "role": "regular",
            },
        )

        assert response.status_code == 422

    def test_update_user_role_and_active_state(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        regular_user: User,
        session: Session,
    ):
        response = client.patch(
            f"/api/admin/users/{regular_user.id}",
            headers=auth_headers_admin,
            json={
                "name": "Updated Test User",
                "email": "updated-testuser@example.com",
                "role": "admin",
                "is_active": False,
                "expires_at": "2031-02-03T04:05:06Z",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Updated Test User"
        assert data["email"] == "updated-testuser@example.com"
        assert data["role"] == "admin"
        assert data["is_active"] is False
        assert data["expires_at"] == "2031-02-03T04:05:06Z"

        session.refresh(regular_user)
        assert regular_user.name == "Updated Test User"
        assert regular_user.email == "updated-testuser@example.com"
        assert regular_user.role == UserRole.ADMIN
        assert regular_user.is_active is False

    def test_clearing_oidc_role_assignment_downgrades_stored_role(
        self, client: TestClient, auth_headers_admin: dict, regular_user: User, session: Session
    ):
        configuration = OidcProviderConfiguration(
            display_name="Provider",
            issuer_url="https://issuer.example",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
            uniform_role=UserRole.EDITOR,
        )
        regular_user.role = UserRole.ADMIN
        regular_user.oidc_role_assignment = UserRole.ADMIN
        identity = OidcIdentity(
            user_id=regular_user.id,
            issuer=configuration.issuer_url,
            subject="subject-1",
            last_groups_json='["Sambee Users"]',
        )
        session.add(configuration)
        session.add(identity)
        session.add(regular_user)
        session.commit()

        response = client.patch(
            f"/api/admin/users/{regular_user.id}",
            headers=auth_headers_admin,
            json={"role": "admin", "oidc_role_assignment": None},
        )

        assert response.status_code == 200
        assert response.json()["role"] == "editor"
        assert response.json()["oidc_role_assignment"] is None
        assert response.json()["oidc"]["inherited_role"] == "editor"
        session.refresh(regular_user)
        assert regular_user.role == UserRole.EDITOR
        assert regular_user.oidc_role_assignment is None
        assert regular_user.token_version == 1

    def test_clearing_oidc_role_assignment_requires_a_resolved_inherited_role(
        self, client: TestClient, auth_headers_admin: dict, regular_user: User, session: Session
    ):
        configuration = OidcProviderConfiguration(
            display_name="Provider",
            issuer_url="https://issuer.example",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
            role_assignment_mode=OidcRoleAssignmentMode.GROUP_BASED,
            role_mappings_json='{"admin":["Admins"],"editor":["Editors"],"viewer":["Viewers"]}',
        )
        regular_user.role = UserRole.ADMIN
        regular_user.oidc_role_assignment = UserRole.ADMIN
        identity = OidcIdentity(user_id=regular_user.id, issuer=configuration.issuer_url, subject="subject-1")
        session.add_all([configuration, identity, regular_user])
        session.commit()

        username_response = client.patch(
            f"/api/admin/users/{regular_user.id}",
            headers=auth_headers_admin,
            json={"username": "renamed-oidc-user"},
        )

        assert username_response.status_code == 200
        assert username_response.json()["username"] == "renamed-oidc-user"

        response = client.patch(
            f"/api/admin/users/{regular_user.id}",
            headers=auth_headers_admin,
            json={"oidc_role_assignment": None},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "The inherited OIDC role is unavailable until the user signs in with OIDC"
        session.refresh(regular_user)
        assert regular_user.role == UserRole.ADMIN
        assert regular_user.oidc_role_assignment == UserRole.ADMIN

    def test_clearing_pending_oidc_role_assignment_requires_a_linked_identity(
        self, client: TestClient, auth_headers_admin: dict, admin_user: User, regular_user: User, session: Session
    ):
        configuration = OidcProviderConfiguration(
            display_name="Provider",
            issuer_url="https://issuer.example",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
        )
        regular_user.role = UserRole.ADMIN
        regular_user.oidc_role_assignment = UserRole.ADMIN
        session.add_all([configuration, regular_user])
        session.flush()
        session.add(
            OidcPendingIdentityMapping(
                provider_configuration_id=configuration.id,
                expected_username="provider-user",
                target_user_id=regular_user.id,
                created_by_user_id=admin_user.id,
            )
        )
        session.commit()

        response = client.patch(
            f"/api/admin/users/{regular_user.id}",
            headers=auth_headers_admin,
            json={"oidc_role_assignment": None},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "The inherited OIDC role is unavailable until the user signs in with OIDC"
        session.refresh(regular_user)
        assert regular_user.role == UserRole.ADMIN
        assert regular_user.oidc_role_assignment == UserRole.ADMIN

    def test_update_rejects_oidc_managed_name_and_email(
        self, client: TestClient, auth_headers_admin: dict, regular_user: User, session: Session
    ):
        configuration = OidcProviderConfiguration(
            display_name="Provider",
            issuer_url="https://issuer.example",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
        )
        regular_user.name = "Provider Name"
        regular_user.email = "provider@example.test"
        identity = OidcIdentity(user_id=regular_user.id, issuer=configuration.issuer_url, subject="subject-1")
        session.add_all([configuration, identity, regular_user])
        session.commit()

        response = client.patch(
            f"/api/admin/users/{regular_user.id}",
            headers=auth_headers_admin,
            json={"name": "Manual Name", "email": "manual@example.test"},
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "Full name and email are managed by OIDC"
        session.refresh(regular_user)
        assert regular_user.name == "Provider Name"
        assert regular_user.email == "provider@example.test"

    def test_update_rejects_oidc_managed_name_and_email_during_issuer_migration(
        self, client: TestClient, auth_headers_admin: dict, regular_user: User, session: Session
    ):
        configuration = OidcProviderConfiguration(
            display_name="New Provider",
            issuer_url="https://new-issuer.example",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
        )
        regular_user.name = "Provider Name"
        regular_user.email = "provider@example.test"
        identity = OidcIdentity(user_id=regular_user.id, issuer="https://previous-issuer.example", subject="subject-1")
        session.add_all([configuration, identity, regular_user])
        session.commit()

        users_response = client.get("/api/admin/users", headers=auth_headers_admin)

        assert users_response.status_code == 200
        user_data = next(user for user in users_response.json()["items"] if user["id"] == str(regular_user.id))
        assert user_data["oidc"]["issuer"] == "https://previous-issuer.example"
        assert user_data["oidc"]["inherited_role"] is None

        response = client.patch(
            f"/api/admin/users/{regular_user.id}",
            headers=auth_headers_admin,
            json={"name": "Manual Name", "email": "manual@example.test"},
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "Full name and email are managed by OIDC"
        session.refresh(regular_user)
        assert regular_user.name == "Provider Name"
        assert regular_user.email == "provider@example.test"

    @pytest.mark.parametrize("mode", (AuthenticationMode.PASSWORD_ONLY, AuthenticationMode.OIDC_OR_PASSWORD))
    def test_reset_password_invalidates_existing_token(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        admin_user: User,
        regular_user: User,
        user_token: str,
        session: Session,
        mode: AuthenticationMode,
    ):
        set_ui_authentication_mode(session, mode=mode, updated_by_user_id=admin_user.id)
        session.commit()
        response = client.post(
            f"/api/admin/users/{regular_user.id}/reset-password",
            headers=auth_headers_admin,
            json={
                "new_password": "BrandNewPass123!",
                "must_change_password": False,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Password reset successfully"

        session.refresh(regular_user)
        assert regular_user.must_change_password is False
        assert regular_user.token_version == 1
        assert verify_password("BrandNewPass123!", regular_user.password_hash)

        old_token_response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {user_token}"})
        assert old_token_response.status_code == 401

    def test_reset_password_rejects_passwordless_user(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        session: Session,
    ):
        passwordless_user = User(username="passwordless-reset-user", role=UserRole.VIEWER)
        session.add(passwordless_user)
        session.commit()
        session.refresh(passwordless_user)

        response = client.post(
            f"/api/admin/users/{passwordless_user.id}/reset-password",
            headers=auth_headers_admin,
            json={"new_password": "BrandNewPass123!", "must_change_password": False},
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "Password reset requires an existing local password"
        session.refresh(passwordless_user)
        assert passwordless_user.password_hash is None

    def test_cannot_delete_last_active_admin(self, client: TestClient, auth_headers_admin: dict, admin_user: User):
        response = client.delete(f"/api/admin/users/{admin_user.id}", headers=auth_headers_admin)

        assert response.status_code == 400
        assert "admin" in response.json()["detail"].lower()

    def test_delete_regular_user(self, client: TestClient, auth_headers_admin: dict, regular_user: User, session: Session):
        response = client.delete(f"/api/admin/users/{regular_user.id}", headers=auth_headers_admin)

        assert response.status_code == 200
        assert response.json()["message"] == "User deleted successfully"
        assert session.get(User, regular_user.id) is None

    def test_delete_user_removes_personal_themes_and_settings(
        self, client: TestClient, auth_headers_admin: dict, regular_user: User, session: Session
    ):
        personal_themes = [
            StoredTheme(id="owned-theme-1", owner_user_id=regular_user.id, definition="{}"),
            StoredTheme(id="owned-theme-2", owner_user_id=regular_user.id, definition="{}"),
        ]
        site_theme = StoredTheme(id="site-theme", definition="{}")
        session.add_all([*personal_themes, site_theme])
        session.add(UserSetting(user_id=regular_user.id, key=UserSettingKey.APPEARANCE_THEME_ID.value, value=personal_themes[0].id))
        session.commit()

        response = client.delete(f"/api/admin/users/{regular_user.id}", headers=auth_headers_admin)

        assert response.status_code == 200
        assert session.get(User, regular_user.id) is None
        assert all(session.get(StoredTheme, theme.id) is None for theme in personal_themes)
        assert session.get(UserSetting, (regular_user.id, UserSettingKey.APPEARANCE_THEME_ID.value)) is None
        assert session.get(StoredTheme, site_theme.id) is not None

    def test_delete_mapped_user_removes_oidc_state(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        regular_user: User,
        session: Session,
    ):
        configuration = OidcProviderConfiguration(
            display_name="Provider",
            issuer_url="https://issuer.example",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
            identity_mapping_revision=7,
            updated_by_user_id=regular_user.id,
        )
        identity = OidcIdentity(user_id=regular_user.id, issuer=configuration.issuer_url, subject="subject-1")
        flow = OidcFlow(
            purpose=OidcFlowPurpose.LOGIN,
            status=OidcFlowStatus.STARTED,
            user_id=regular_user.id,
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        )
        session.add(configuration)
        session.add(identity)
        session.add(flow)
        session.commit()

        response = client.delete(f"/api/admin/users/{regular_user.id}", headers=auth_headers_admin)

        assert response.status_code == 200
        assert session.get(User, regular_user.id) is None
        assert session.exec(select(OidcIdentity).where(OidcIdentity.user_id == regular_user.id)).first() is None
        assert session.get(OidcFlow, flow.id) is None
        session.refresh(configuration)
        assert configuration.identity_mapping_revision == 8
        assert configuration.updated_by_user_id is None

    def test_delete_mapping_creator_preserves_unrelated_pending_mapping(
        self,
        client: TestClient,
        auth_headers_admin: dict,
        regular_user: User,
        admin_user: User,
        session: Session,
    ):
        configuration = OidcProviderConfiguration(
            display_name="Provider",
            issuer_url="https://issuer.example",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
            identity_mapping_revision=7,
        )
        session.add(configuration)
        session.flush()
        mapping = OidcPendingIdentityMapping(
            provider_configuration_id=configuration.id,
            expected_username="provider-user",
            target_user_id=regular_user.id,
            created_by_user_id=admin_user.id,
        )
        replacement_admin = User(
            username="replacement-admin",
            password_hash=get_password_hash("ReplacementAdmin123!"),
            role=UserRole.ADMIN,
        )
        session.add(mapping)
        session.add(replacement_admin)
        session.commit()

        replacement_headers = {"Authorization": f"Bearer {create_access_token(data={'sub': replacement_admin.username})}"}
        response = client.delete(f"/api/admin/users/{admin_user.id}", headers=replacement_headers)

        assert response.status_code == 200
        session.refresh(mapping)
        session.refresh(configuration)
        assert mapping.target_user_id == regular_user.id
        assert mapping.created_by_user_id is None
        assert configuration.identity_mapping_revision == 7
