"""
Tests for authentication and authorization.
Tests login, token generation/validation, password hashing, and encryption.
"""

import hashlib
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, delete, select
from starlette.requests import Request

import app.api.auth as auth_module
from app.core.security import (
    build_user_access_token,
    create_access_token,
    decode_access_token,
    decrypt_password,
    encrypt_password,
    get_password_hash,
    verify_password,
)
from app.middleware.authentication import PASSWORD_FORM_BODY_LIMIT_BYTES
from app.models.oidc import (
    OidcBrowserSession,
    OidcBrowserSessionStatus,
    OidcFlow,
    OidcFlowStatus,
    OidcProviderConfiguration,
    OidcSessionCapability,
    OidcSessionCipherKey,
    SignInMode,
)
from app.models.oidc_api import OidcConfigurationCandidate
from app.models.user import User, UserRole
from app.services.oidc_browser_session import OIDC_BROWSER_SESSION_COOKIE_NAME, build_cookie_value
from app.services.oidc_client import NormalizedOidcClaims, OidcClientError, OidcClientErrorCode, ValidatedOidcTokenSet
from app.services.oidc_configuration import encrypt_candidate_snapshot, get_oidc_secret_cipher, normalize_candidate
from app.services.oidc_flow import start_login_flow, start_test_flow


def test_pending_oidc_login_cookies_keep_parallel_flows_separate() -> None:
    first_state, second_state = "first-state", "second-state"
    first_cookie = auth_module._oidc_login_flow_cookie_name(first_state)
    second_cookie = auth_module._oidc_login_flow_cookie_name(second_state)
    assert first_cookie != second_cookie

    cookie_header = f"{first_cookie}={first_state}; {second_cookie}={second_state}; {auth_module.OIDC_LOGIN_FLOW_COOKIE_NAME}_invalid=wrong"
    request = Request({"type": "http", "headers": [(b"cookie", cookie_header.encode())]})
    assert auth_module._pending_oidc_login_states(request) == [first_state, second_state]


@pytest.mark.parametrize(
    ("error_code", "expected_category"),
    (
        (OidcClientErrorCode.USERINFO_UNAVAILABLE, "user_info_unavailable"),
        (OidcClientErrorCode.USERINFO_SUBJECT_MISMATCH, "user_info_subject_mismatch"),
        (OidcClientErrorCode.REQUIRED_CLAIM_MISSING, "required_claim_missing_after_user_info"),
        (OidcClientErrorCode.INVALID_ID_TOKEN, "oidc_sign_in_failed"),
    ),
)
def test_oidc_failure_category_uses_safe_userinfo_reason(error_code: OidcClientErrorCode, expected_category: str) -> None:
    error = OidcClientError(error_code, "provider detail must not be logged")

    assert auth_module._oidc_failure_category(error) == expected_category


def test_authorization_scopes_preserves_stored_configuration() -> None:
    assert auth_module._authorization_scopes('["openid", "profile", "email"]') == (
        "openid",
        "profile",
        "email",
    )


@pytest.mark.parametrize("has_refresh_token", [False, True])
@pytest.mark.parametrize(("age_days", "succeeds"), [(0, True), (3, False), (None, False)])
def test_oidc_test_callback_requires_recent_auth_time_with_or_without_refresh_token(
    client: TestClient,
    session: Session,
    admin_user: User,
    monkeypatch: pytest.MonkeyPatch,
    has_refresh_token: bool,
    age_days: int | None,
    succeeds: bool,
) -> None:
    cipher = get_oidc_secret_cipher()
    candidate = normalize_candidate(
        OidcConfigurationCandidate(
            issuer_url="https://idp.example.test",
            client_id="sambee",
            client_secret="secret",
            sign_in_mode="oidc_only",
            interactive_reauthentication_max_age_days=2,
        ),
        None,
        cipher,
    )
    started = start_test_flow(
        session,
        initiating_admin_id=admin_user.id,
        encrypted_candidate_configuration=encrypt_candidate_snapshot(candidate, cipher),
        active_configuration_revision=None,
        cipher=cipher,
    )
    session.commit()

    async def metadata(*_args: object, **_kwargs: object) -> tuple[object, dict[str, object]]:
        return object(), {}

    async def token_set(*_args: object, **_kwargs: object) -> ValidatedOidcTokenSet:
        return ValidatedOidcTokenSet(
            claims=NormalizedOidcClaims(
                issuer=candidate.issuer_url,
                subject="subject",
                username="admin",
                groups=(),
                name=None,
                email=None,
            ),
            authenticated_at=int((datetime.now(timezone.utc) - timedelta(days=age_days)).timestamp()) if age_days is not None else None,
            provider_access_token=None,
            refresh_token="provider-refresh-token" if has_refresh_token else None,
        )

    monkeypatch.setattr(auth_module, "load_provider_metadata", metadata)
    monkeypatch.setattr(auth_module, "exchange_and_validate_callback", token_set)
    monkeypatch.setattr(auth_module, "derive_oidc_redirect_uri", lambda _url: "http://testserver/api/auth/oidc/callback")
    response = client.get("/api/auth/oidc/callback", params={"state": started.state, "code": "code"}, follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"].startswith("/browse?settings=admin-authentication") is succeeds
    flow = session.get(OidcFlow, started.flow_id)
    if succeeds:
        assert flow is not None and flow.status == OidcFlowStatus.CALLBACK_VALIDATED
        assert flow.test_refresh_token_returned is has_refresh_token


def test_oidc_login_callback_without_refresh_token_creates_fixed_session(
    client: TestClient,
    session: Session,
    admin_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cipher = get_oidc_secret_cipher()
    configuration = OidcProviderConfiguration(
        display_name="IdP",
        issuer_url="https://idp.example.test",
        client_id="sambee",
        encrypted_client_secret=cipher.encrypt("secret"),
        sign_in_mode=SignInMode.OIDC_ONLY,
    )
    session.add(configuration)
    session.commit()
    started = start_login_flow(session, configuration_revision=configuration.configuration_revision, cipher=cipher, return_path="/browse")
    session.commit()

    async def metadata(*_args: object, **_kwargs: object) -> tuple[object, dict[str, object]]:
        return object(), {}

    async def token_set(*_args: object, **_kwargs: object) -> ValidatedOidcTokenSet:
        return ValidatedOidcTokenSet(
            claims=NormalizedOidcClaims(
                issuer=configuration.issuer_url,
                subject="subject",
                username=admin_user.username,
                groups=(),
                name=None,
                email=None,
            ),
            authenticated_at=int(datetime.now(timezone.utc).timestamp()),
            provider_access_token=None,
            refresh_token=None,
        )

    monkeypatch.setattr(auth_module, "load_provider_metadata", metadata)
    monkeypatch.setattr(auth_module, "exchange_and_validate_callback", token_set)
    monkeypatch.setattr(auth_module, "derive_oidc_redirect_uri", lambda _url: "http://testserver/api/auth/oidc/callback")
    monkeypatch.setattr(auth_module, "get_effective_authentication_mode", lambda _session: SignInMode.OIDC_ONLY)
    monkeypatch.setattr(auth_module, "resolve_or_provision_oidc_user", lambda *_args, **_kwargs: admin_user)
    client.cookies.set(auth_module._oidc_login_flow_cookie_name(started.state), started.state)
    response = client.get("/api/auth/oidc/callback", params={"state": started.state, "code": "code"}, follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"].startswith("/login/oidc/callback#grant=")
    browser_session = session.exec(select(OidcBrowserSession)).one()
    assert browser_session.capability == OidcSessionCapability.REAUTHORIZATION_ONLY
    assert browser_session.encrypted_refresh_token is None
    assert session.exec(select(OidcSessionCipherKey)).all() == []


@pytest.mark.parametrize("scopes_json", ('{"openid": true}', '["openid", 1]', "not-json"))
def test_authorization_scopes_rejects_invalid_stored_configuration(scopes_json: str) -> None:
    with pytest.raises(ValueError, match="invalid scopes"):
        auth_module._authorization_scopes(scopes_json)


def test_oidc_session_controls_revoke_only_owned_sessions(client: TestClient, session: Session) -> None:
    configuration = OidcProviderConfiguration(
        display_name="Example identity",
        issuer_url="https://id.example.test",
        client_id="sambee",
    )
    current_user = User(username="oidc-current", role=UserRole.EDITOR, password_hash=None)
    other_user = User(username="oidc-other", role=UserRole.EDITOR, password_hash=None)
    session.add_all([configuration, current_user, other_user])
    session.commit()
    now = datetime.now(timezone.utc)
    current_session = OidcBrowserSession(
        user_id=current_user.id,
        user_token_version=current_user.token_version,
        provider_configuration_id=configuration.id,
        configuration_revision=configuration.session_validation_revision,
        identity_mapping_revision=configuration.identity_mapping_revision,
        issuer=configuration.issuer_url,
        subject="current-subject",
        secret_hash=hashlib.sha256(b"current-secret").hexdigest(),
        encrypted_refresh_token="encrypted",
        status=OidcBrowserSessionStatus.ACTIVE,
        browser_name="Firefox",
        operating_system="Linux",
        authenticated_at=now,
        absolute_expires_at=now + timedelta(days=30),
    )
    other_session = OidcBrowserSession(
        user_id=other_user.id,
        user_token_version=other_user.token_version,
        provider_configuration_id=configuration.id,
        configuration_revision=configuration.session_validation_revision,
        identity_mapping_revision=configuration.identity_mapping_revision,
        issuer=configuration.issuer_url,
        subject="other-subject",
        secret_hash=hashlib.sha256(b"other-secret").hexdigest(),
        encrypted_refresh_token="encrypted",
        status=OidcBrowserSessionStatus.ACTIVE,
        authenticated_at=now,
        absolute_expires_at=now + timedelta(days=30),
    )
    session.add_all([current_session, other_session])
    session.commit()
    token = build_user_access_token(current_user, oidc_browser_session_id=current_session.id)
    headers = {"Authorization": f"Bearer {token}"}
    client.cookies.set(OIDC_BROWSER_SESSION_COOKIE_NAME, build_cookie_value(current_session.id, "current-secret"))

    account = client.get("/api/auth/account", headers=headers)
    assert account.status_code == 200
    assert account.json()["current_session"] == {
        "kind": "oidc",
        "id": str(current_session.id),
        "started_at": account.json()["current_session"]["started_at"],
        "last_active_at": account.json()["current_session"]["last_active_at"],
        "browser_name": "Firefox",
        "operating_system": "Linux",
    }

    listed = client.get("/api/auth/oidc/sessions", headers=headers)
    assert listed.status_code == 200
    sessions = listed.json()["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["id"] == str(current_session.id)
    assert sessions[0]["status"] == "active"
    assert sessions[0]["browser_name"] == "Firefox"
    assert sessions[0]["operating_system"] == "Linux"
    assert sessions[0]["current"] is True

    rejected = client.post(f"/api/auth/oidc/sessions/{other_session.id}/revoke", headers=headers)
    assert rejected.status_code == 200
    assert rejected.json() == {"revoked_count": 0}
    session.refresh(other_session)
    assert other_session.status == OidcBrowserSessionStatus.ACTIVE

    # The bearer token identifies the session being revoked. A later browser login
    # can replace the shared cookie with a session for another user.
    client.cookies.set(OIDC_BROWSER_SESSION_COOKIE_NAME, build_cookie_value(other_session.id, "other-secret"))
    revoked = client.post(f"/api/auth/oidc/sessions/{current_session.id}/revoke", headers=headers)
    assert revoked.status_code == 200
    assert revoked.json() == {"revoked_count": 1}
    session.refresh(current_session)
    session.refresh(other_session)
    assert current_session.status == OidcBrowserSessionStatus.REVOKED
    assert other_session.status == OidcBrowserSessionStatus.ACTIVE
    assert client.get("/api/auth/me", headers=headers).status_code == 401


@pytest.mark.unit
class TestPasswordHashing:
    """Test password hashing and verification."""

    def test_password_hash_and_verify(self):
        """Test that password hashing and verification work correctly."""
        password = "mysecretpassword123"
        hashed = get_password_hash(password)

        # Hash should not be the plaintext password
        assert hashed != password
        # Hash should be long enough (argon2 produces long hashes)
        assert len(hashed) > 50

        # Verify correct password
        assert verify_password(password, hashed) is True

        # Verify incorrect password
        assert verify_password("wrongpassword", hashed) is False

    def test_same_password_different_hashes(self):
        """Test that hashing the same password twice produces different hashes (salted)."""
        password = "samepassword"
        hash1 = get_password_hash(password)
        hash2 = get_password_hash(password)

        # Different hashes due to random salt
        assert hash1 != hash2

        # But both verify correctly
        assert verify_password(password, hash1) is True
        assert verify_password(password, hash2) is True


@pytest.mark.unit
class TestPasswordEncryption:
    """Test Fernet password encryption and decryption."""

    def test_encrypt_and_decrypt(self):
        """Test that password encryption and decryption work correctly."""
        password = "my_smb_password_123"
        encrypted = encrypt_password(password)

        # Encrypted should not be the plaintext
        assert encrypted != password
        # Should be base64 encoded Fernet token
        assert len(encrypted) > 50

        # Decrypt should return original password
        decrypted = decrypt_password(encrypted)
        assert decrypted == password

    def test_same_password_different_encryption(self):
        """Test that encrypting the same password twice produces different ciphertext."""
        password = "same_smb_password"
        encrypted1 = encrypt_password(password)
        encrypted2 = encrypt_password(password)

        # Different due to random IV in Fernet
        assert encrypted1 != encrypted2

        # But both decrypt to same value
        assert decrypt_password(encrypted1) == password
        assert decrypt_password(encrypted2) == password

    def test_decrypt_invalid_token(self):
        """Test that decrypting invalid token raises exception."""
        with pytest.raises(Exception):
            decrypt_password("invalid_token_123")


@pytest.mark.unit
class TestTokenGeneration:
    """Test JWT token generation and validation."""

    def test_create_access_token(self):
        """Test that access token is created correctly."""
        username = "testuser"
        token = create_access_token(data={"sub": username})

        # Token should be a string
        assert isinstance(token, str)
        # JWT tokens have 3 parts separated by dots
        assert token.count(".") == 2

    def test_token_contains_username(self):
        """Test that token can be decoded to retrieve username."""

        username = "testuser"
        token = create_access_token(data={"sub": username})

        payload = decode_access_token(token)
        assert payload["sub"] == username


@pytest.mark.integration
class TestLoginEndpoint:
    """Test the login endpoint."""

    def test_login_success(self, client: TestClient, admin_user: User):
        """Test successful login with correct credentials."""
        response = client.post(
            "/api/auth/token",
            data={
                "username": "testadmin",
                "password": "adminpass123",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert data["role"] == "admin"

    def test_auth_config_uses_canonical_database_mode(self, client: TestClient, session: Session):
        from app.core.auth_methods import AuthenticationMode
        from app.models.oidc import OidcProviderConfiguration, SignInMode
        from app.services.authentication_config import set_ui_authentication_mode

        configuration = OidcProviderConfiguration(
            display_name="Company SSO",
            issuer_url="https://idp.example.com",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
        )
        session.add(configuration)
        session.flush()

        try:
            response = client.get("/api/auth/config")

            assert response.status_code == 200
            assert response.json() == {"sign_in_mode": "password_only", "oidc": None}

            set_ui_authentication_mode(session, mode=AuthenticationMode.OIDC_OR_PASSWORD, updated_by_user_id=None)
            session.commit()
            response = client.get("/api/auth/config")

            assert response.status_code == 200
            assert response.json() == {
                "sign_in_mode": "oidc_or_password",
                "oidc": {
                    "display_name": "Company SSO",
                    "authorization_path": "/api/auth/oidc/authorize",
                },
            }
        finally:
            session.exec(delete(OidcProviderConfiguration))
            session.flush()
            assert session.exec(select(OidcProviderConfiguration)).first() is None

    def test_enforcement_override_does_not_replace_configured_ui_mode(
        self, client: TestClient, session: Session, admin_token: str, monkeypatch
    ) -> None:
        from app.core.auth_methods import AuthenticationMode
        from app.core.config import settings
        from app.core.security import get_password_hash
        from app.services.authentication_config import set_ui_authentication_mode

        session.add(User(username=settings.admin_username, password_hash=get_password_hash("adminpass123"), role=UserRole.ADMIN))
        set_ui_authentication_mode(session, mode=AuthenticationMode.OIDC_ONLY, updated_by_user_id=None)
        session.commit()
        monkeypatch.setattr(settings, "disable_auth_enforcement", True)

        assert client.get("/api/auth/config").json() == {"sign_in_mode": "none", "oidc": None}

        response = client.get("/api/admin/auth/oidc", headers={"Authorization": f"Bearer {admin_token}"})

        assert response.status_code == 200
        assert response.json()["auth_mode"] == "oidc_only"
        assert response.json()["auth_enforcement_disabled"] is True

    def test_oidc_only_password_login_returns_404_before_form_validation(self, client: TestClient, session: Session):
        from app.core.auth_methods import AuthenticationMode
        from app.models.oidc import OidcProviderConfiguration, SignInMode
        from app.services.authentication_config import set_ui_authentication_mode

        configuration = OidcProviderConfiguration(
            display_name="Company SSO",
            issuer_url="https://idp.example.com",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_ONLY,
        )
        session.add(configuration)
        set_ui_authentication_mode(session, mode=AuthenticationMode.OIDC_ONLY, updated_by_user_id=None)
        session.commit()

        try:
            response = client.post(
                "/api/auth/token",
                content=b"not-a-valid-form",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )

            assert response.status_code == 404
            assert response.json()["detail"] == "Password authentication is not enabled"
        finally:
            session.exec(delete(OidcProviderConfiguration))
            session.flush()
            assert session.exec(select(OidcProviderConfiguration)).first() is None

    def test_password_form_body_limit_accepts_exact_limit_and_rejects_one_byte_over(self, client: TestClient):
        prefix = b"username=missing-user&password="
        exact_body = prefix + b"x" * (PASSWORD_FORM_BODY_LIMIT_BYTES - len(prefix))

        exact_response = client.post(
            "/api/auth/token",
            content=exact_body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        oversized_response = client.post(
            "/api/auth/token",
            content=exact_body + b"x",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

        assert exact_response.status_code == 401
        assert exact_response.json()["detail"] == "Incorrect username or password"
        assert oversized_response.status_code == 413
        assert oversized_response.json() == {"detail": "Request body too large"}

    def test_login_wrong_password(self, client: TestClient, admin_user: User):
        """Test login fails with incorrect password."""
        response = client.post(
            "/api/auth/token",
            data={
                "username": "testadmin",
                "password": "wrongpassword",
            },
        )

        assert response.status_code == 401
        assert "Incorrect username or password" in response.json()["detail"]

    def test_login_nonexistent_user(self, client: TestClient):
        """Test login fails with non-existent user."""
        response = client.post(
            "/api/auth/token",
            data={
                "username": "nonexistent",
                "password": "password123",
            },
        )

        assert response.status_code == 401
        assert "Incorrect username or password" in response.json()["detail"]

    def test_password_login_rate_limit_returns_generic_429(self, client: TestClient, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(auth_module.authentication_rate_limiter, "_clock", lambda: 0.0)
        for _ in range(10):
            response = client.post("/api/auth/token", data={"username": "missing", "password": "wrong"})
            assert response.status_code == 401

        response = client.post("/api/auth/token", data={"username": "missing", "password": "wrong"})

        assert response.status_code == 429
        assert response.json() == {"detail": "Incorrect username or password"}
        assert response.headers["Retry-After"] == "90"

    def test_oidc_exchange_rate_limit_returns_generic_429(self, client: TestClient, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(auth_module.authentication_rate_limiter, "_clock", lambda: 0.0)
        for _ in range(30):
            response = client.post("/api/auth/oidc/exchange", json={"grant": "x" * 32})
            assert response.status_code == 401

        response = client.post("/api/auth/oidc/exchange", json={"grant": "x" * 32})

        assert response.status_code == 429
        assert response.json() == {"detail": "OIDC login grant is invalid"}
        assert response.headers["Retry-After"] == "10"

    def test_oidc_authorization_rate_limit_uses_fixed_redirect(self, client: TestClient, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(auth_module.authentication_rate_limiter, "_clock", lambda: 0.0)
        for _ in range(20):
            response = client.get("/api/auth/oidc/authorize", follow_redirects=False)
            assert response.status_code == 404

        response = client.get("/api/auth/oidc/authorize", follow_redirects=False)

        assert response.status_code == 303
        assert response.headers["location"] == "/login#error=oidc_rate_limited"
        assert response.headers["Retry-After"] == "15"

    def test_oidc_callback_rate_limit_uses_fixed_redirect(self, client: TestClient, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(auth_module.authentication_rate_limiter, "_clock", lambda: 0.0)
        for _ in range(60):
            response = client.get(
                "/api/auth/oidc/callback",
                params={"state": "invalid-state", "code": "provider-code"},
                follow_redirects=False,
            )
            assert response.status_code == 303
            assert response.headers["location"] == "/login#error=oidc_authorization_state_invalid"

        response = client.get(
            "/api/auth/oidc/callback",
            params={"state": "invalid-state", "code": "provider-code"},
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/login#error=oidc_rate_limited"
        assert response.headers["Retry-After"] == "5"

    def test_invalid_oidc_callback_uses_stable_error_redirect(self, client: TestClient):
        response = client.get(
            "/api/auth/oidc/callback",
            params={"state": "invalid-state", "code": "provider-code"},
            follow_redirects=False,
        )

        assert response.status_code == 303
        assert response.headers["location"] == "/login#error=oidc_authorization_state_invalid"
        assert response.headers["Cache-Control"] == "no-store"

    def test_oidc_authorization_failure_uses_stable_error_redirect(self, client: TestClient, session: Session):
        from app.core.auth_methods import AuthenticationMode
        from app.models.oidc import OidcProviderConfiguration, SignInMode
        from app.services.authentication_config import set_ui_authentication_mode

        session.add(
            OidcProviderConfiguration(
                display_name="Company SSO",
                issuer_url="https://idp.example.com",
                client_id="sambee",
                sign_in_mode=SignInMode.OIDC_ONLY,
            )
        )
        set_ui_authentication_mode(session, mode=AuthenticationMode.OIDC_ONLY, updated_by_user_id=None)
        session.commit()

        response = client.get("/api/auth/oidc/authorize", follow_redirects=False)

        assert response.status_code == 303
        assert response.headers["location"] == "/login#error=oidc_provider_unavailable"

    def test_login_passwordless_user_fails_generically(self, client: TestClient, session: Session):
        passwordless_user = User(username="passwordless-user", role=UserRole.VIEWER)
        session.add(passwordless_user)
        session.commit()

        response = client.post(
            "/api/auth/token",
            data={"username": passwordless_user.username, "password": "irrelevant"},
        )

        assert response.status_code == 401
        assert response.json()["detail"] == "Incorrect username or password"

    def test_login_missing_fields(self, client: TestClient):
        """Test login fails with missing fields."""
        response = client.post(
            "/api/auth/token",
            data={"username": "testadmin"},
        )

        assert response.status_code == 422  # Unprocessable entity

    def test_regular_user_login(self, client: TestClient, regular_user: User):
        """Test that regular users can login."""
        response = client.post(
            "/api/auth/token",
            data={
                "username": "testuser",
                "password": "userpass123",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert data["role"] == "editor"

    def test_expired_user_login_rejected(self, client: TestClient, session: Session):
        """Test that expired users cannot login."""
        expired_user = User(
            username="expired-user",
            password_hash=get_password_hash("expiredpass123"),
            role=UserRole.EDITOR,
            expires_at=datetime.now(timezone.utc) - timedelta(minutes=5),
        )
        session.add(expired_user)
        session.commit()

        response = client.post(
            "/api/auth/token",
            data={
                "username": "expired-user",
                "password": "expiredpass123",
            },
        )

        assert response.status_code == 401
        assert "incorrect username or password" in response.json()["detail"].lower()


@pytest.mark.integration
class TestAuthenticationMiddleware:
    """Test authentication middleware and protected endpoints."""

    def test_access_protected_endpoint_with_valid_token(self, client: TestClient, auth_headers_admin: dict):
        """Test accessing protected endpoint with valid token."""
        response = client.get("/api/connections", headers=auth_headers_admin)
        # Should not get 401 (actual response depends on data, but not auth error)
        assert response.status_code != 401

    def test_access_protected_endpoint_without_token(self, client: TestClient):
        """Test accessing protected endpoint without token fails."""
        response = client.get("/api/connections")
        assert response.status_code == 401
        assert "Not authenticated" in response.json()["detail"]

    def test_access_protected_endpoint_with_invalid_token(self, client: TestClient):
        """Test accessing protected endpoint with invalid token fails."""
        response = client.get(
            "/api/connections",
            headers={"Authorization": "Bearer invalid_token_12345"},
        )
        assert response.status_code == 401

    def test_access_protected_endpoint_with_malformed_header(self, client: TestClient):
        """Test accessing protected endpoint with malformed auth header."""
        response = client.get(
            "/api/connections",
            headers={"Authorization": "InvalidFormat"},
        )
        assert response.status_code == 401


@pytest.mark.integration
class TestAdminAuthorization:
    """Test admin-only endpoints remain restricted while connection listing is user-visible."""

    def test_admin_can_access_admin_endpoint(self, client: TestClient, auth_headers_admin: dict):
        """Test that admin users can access admin endpoints."""
        response = client.get("/api/admin/users", headers=auth_headers_admin)
        # Should not get 403 (may get 200 with empty list)
        assert response.status_code != 403

    def test_regular_user_cannot_access_admin_endpoint(self, client: TestClient, auth_headers_user: dict):
        """Test that regular users cannot access admin endpoints."""
        response = client.get("/api/admin/users", headers=auth_headers_user)
        assert response.status_code == 403
        assert "permission" in response.json()["detail"].lower()

    def test_regular_user_can_access_connection_endpoint(self, client: TestClient, auth_headers_user: dict):
        """Test that regular users can list visible connections."""
        response = client.get("/api/connections", headers=auth_headers_user)
        assert response.status_code == 200

    def test_regular_user_can_access_non_admin_endpoint(self, client: TestClient, auth_headers_user: dict, test_connection):
        """Test that regular users can access non-admin endpoints."""
        # Browser endpoint should be accessible to all authenticated users
        response = client.get(
            f"/api/browser/{test_connection.id}/list",
            headers=auth_headers_user,
            params={"path": ""},
        )
        # May fail due to SMB connection, but should not be 403
        assert response.status_code != 403


@pytest.mark.integration
class TestGetCurrentUserEndpoint:
    """Test /me endpoint for getting current user info."""

    def test_get_current_user_info_admin(self, client: TestClient, auth_headers_admin: dict):
        """Test getting current user info as admin."""
        response = client.get("/api/auth/me", headers=auth_headers_admin)
        assert response.status_code == 200
        data = response.json()
        assert data["username"] == "testadmin"  # From fixture
        assert data["role"] == "admin"
        assert "created_at" in data

    def test_get_current_user_info_regular_user(self, client: TestClient, auth_headers_user: dict):
        """Test getting current user info as regular user."""
        response = client.get("/api/auth/me", headers=auth_headers_user)
        assert response.status_code == 200
        data = response.json()
        assert data["username"] == "testuser"
        assert data["role"] == "editor"
        assert "created_at" in data

    def test_get_current_user_info_without_auth(self, client: TestClient):
        """Test that /me endpoint requires authentication."""
        response = client.get("/api/auth/me")
        assert response.status_code == 401

    def test_get_current_account_reports_password_capabilities(self, client: TestClient, auth_headers_user: dict):
        response = client.get("/api/auth/account", headers=auth_headers_user)

        assert response.status_code == 200
        assert response.json() == {
            "id": response.json()["id"],
            "username": "testuser",
            "name": None,
            "email": None,
            "role": "editor",
            "is_active": True,
            "must_change_password": False,
            "expires_at": None,
            "created_at": response.json()["created_at"],
            "has_local_password": True,
            "identity_source": "local",
            "password_change_available": True,
            "password_change_required": False,
            "browser_session_management_available": False,
            "oidc_provider_name": None,
            "current_session": {
                "kind": "password",
                "id": None,
                "started_at": None,
                "last_active_at": None,
                "browser_name": None,
                "operating_system": None,
            },
        }

    def test_get_current_account_reports_oidc_session_capabilities(self, client: TestClient, session: Session, auth_headers_user: dict):
        from app.core.auth_methods import AuthenticationMode
        from app.models.oidc import OidcProviderConfiguration, SignInMode
        from app.services.authentication_config import set_ui_authentication_mode

        configuration = OidcProviderConfiguration(
            display_name="Company SSO",
            issuer_url="https://idp.example.com",
            client_id="sambee",
            sign_in_mode=SignInMode.OIDC_ONLY,
        )
        session.add(configuration)
        set_ui_authentication_mode(session, mode=AuthenticationMode.OIDC_ONLY, updated_by_user_id=None)
        session.commit()

        try:
            response = client.get("/api/auth/account", headers=auth_headers_user)

            assert response.status_code == 200
            assert response.json()["password_change_available"] is False
            assert response.json()["identity_source"] == "local"
            assert response.json()["browser_session_management_available"] is True
            assert response.json()["oidc_provider_name"] == "Company SSO"
        finally:
            set_ui_authentication_mode(session, mode=AuthenticationMode.PASSWORD_ONLY, updated_by_user_id=None)
            session.exec(delete(OidcProviderConfiguration))
            session.commit()

    def test_get_current_account_reports_oidc_identity_source(
        self, client: TestClient, session: Session, regular_user: User, auth_headers_user: dict
    ):
        from app.models.oidc import OidcIdentity

        session.add(OidcIdentity(user_id=regular_user.id, issuer="https://idp.example.com", subject="user-subject"))
        session.commit()

        response = client.get("/api/auth/account", headers=auth_headers_user)

        assert response.status_code == 200
        assert response.json()["identity_source"] == "oidc"


@pytest.mark.integration
class TestChangePasswordEndpoint:
    """Test password change functionality."""

    @pytest.mark.parametrize(
        ("mode", "enforced", "oidc_session", "expected"),
        [
            ("password_only", True, False, True),
            ("oidc_or_password", True, False, True),
            ("oidc_or_password", True, True, False),
            ("oidc_only", True, False, False),
            ("password_only", False, False, False),
        ],
    )
    def test_password_change_requirement_respects_authentication_context(
        self, session: Session, regular_user: User, mode: str, enforced: bool, oidc_session: bool, expected: bool
    ):
        import uuid

        from app.core.auth_methods import AuthenticationMode
        from app.core.security import BrowserAuthentication, password_change_required
        from app.services.authentication_config import set_ui_authentication_mode

        set_ui_authentication_mode(session, mode=AuthenticationMode(mode), updated_by_user_id=None)
        regular_user.must_change_password = True
        authentication = BrowserAuthentication(
            user=regular_user,
            token_version_current=True,
            oidc_browser_session_id=uuid.uuid4() if oidc_session else None,
            authentication_enforced=enforced,
        )
        assert password_change_required(authentication, session) is expected

    def test_required_password_change_blocks_access_until_completed(
        self, client: TestClient, session: Session, regular_user: User, auth_headers_user: dict
    ):
        regular_user.must_change_password = True
        session.add(regular_user)
        session.commit()

        assert client.get("/api/auth/me", headers=auth_headers_user).status_code == 200
        account = client.get("/api/auth/account", headers=auth_headers_user)
        assert account.status_code == 200
        assert account.json()["password_change_required"] is True
        blocked = client.get("/api/auth/me/settings", headers=auth_headers_user)
        assert blocked.status_code == 403
        assert blocked.json()["detail"] == {"code": "password_change_required"}

        rejected = client.post(
            "/api/auth/change-password",
            headers=auth_headers_user,
            json={"current_password": "incorrect", "new_password": "newpass123"},
        )
        assert rejected.status_code == 400
        session.refresh(regular_user)
        assert regular_user.must_change_password is True

        response = client.post(
            "/api/auth/change-password",
            headers=auth_headers_user,
            json={"current_password": "userpass123", "new_password": "newpass123"},
        )
        assert response.status_code == 200
        session.refresh(regular_user)
        assert regular_user.must_change_password is False
        assert client.get("/api/auth/me", headers=auth_headers_user).status_code == 401

    def test_change_password_rejects_current_password(self, client: TestClient, auth_headers_user: dict):
        response = client.post(
            "/api/auth/change-password",
            headers=auth_headers_user,
            json={"current_password": "userpass123", "new_password": "userpass123"},
        )
        assert response.status_code == 400
        assert "different" in response.json()["detail"]

    def test_change_password_success(self, client: TestClient, session: Session):
        """Test successful password change."""
        from app.core.security import create_access_token, get_password_hash
        from app.models.user import User

        # Create a fresh user for this test
        test_user = User(
            username="password_change_user",
            password_hash=get_password_hash("oldpass123"),
            role=UserRole.EDITOR,
        )
        session.add(test_user)
        session.commit()
        session.refresh(test_user)

        # Create token for this user
        token = create_access_token(data={"sub": test_user.username})
        headers = {"Authorization": f"Bearer {token}"}

        response = client.post(
            "/api/auth/change-password?current_password=oldpass123&new_password=newpass123",
            headers=headers,
        )
        assert response.status_code == 200
        assert "success" in response.json()["message"].lower()

        # Verify can login with new password
        login_response = client.post(
            "/api/auth/token",
            data={"username": "password_change_user", "password": "newpass123"},
        )
        assert login_response.status_code == 200

    def test_change_password_wrong_current_password(self, client: TestClient, auth_headers_user: dict):
        """Test password change fails with wrong current password."""
        response = client.post(
            "/api/auth/change-password?current_password=wrongpassword&new_password=newpass123",
            headers=auth_headers_user,
        )
        assert response.status_code == 400
        assert "incorrect" in response.json()["detail"].lower()

    def test_change_password_rejects_passwordless_user(self, client: TestClient, session: Session):
        from app.core.security import build_user_access_token

        passwordless_user = User(username="passwordless-change-user", role=UserRole.VIEWER)
        session.add(passwordless_user)
        session.commit()
        session.refresh(passwordless_user)
        headers = {"Authorization": f"Bearer {build_user_access_token(passwordless_user)}"}

        response = client.post(
            "/api/auth/change-password",
            headers=headers,
            json={"current_password": "irrelevant", "new_password": "newpass123"},
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "Password changes require an existing local password"
        session.refresh(passwordless_user)
        assert passwordless_user.password_hash is None

    def test_change_password_without_auth(self, client: TestClient):
        """Test that password change requires authentication."""
        response = client.post("/api/auth/change-password?current_password=testpass&new_password=newpass123")
        assert response.status_code == 401


@pytest.mark.integration
class TestTokenExpiration:
    """Test token expiration and validation."""

    def test_expired_token_rejected(self, client: TestClient):
        """Test that expired tokens are rejected."""
        from datetime import timedelta

        from app.core.security import create_access_token

        # Create token that expires immediately
        expired_token = create_access_token(data={"sub": "testuser"}, expires_delta=timedelta(seconds=-1))

        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired_token}"})
        assert response.status_code == 401

    def test_token_with_invalid_signature(self, client: TestClient):
        """Test that tokens with invalid signatures are rejected."""
        # Create a token with wrong signature
        invalid_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0dXNlciJ9.invalid_signature"

        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {invalid_token}"})
        assert response.status_code == 401

    def test_token_with_missing_subject(self, client: TestClient):
        """Test that tokens without 'sub' claim are rejected."""
        from app.core.security import create_access_token

        # Create token without username in 'sub'
        token_no_sub = create_access_token(data={"other": "data"})

        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_no_sub}"})
        assert response.status_code == 401

    def test_token_with_nonexistent_user(self, client: TestClient):
        """Test that tokens for non-existent users are rejected."""
        from app.core.security import create_access_token

        # Create token for user that doesn't exist
        token_fake_user = create_access_token(data={"sub": "nonexistentuser"})

        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token_fake_user}"})
        assert response.status_code == 401

    def test_token_for_expired_user_rejected(self, client: TestClient, session: Session):
        """Test that existing tokens stop working after account expiration."""
        expired_user = User(
            username="expired-token-user",
            password_hash=get_password_hash("expiredpass123"),
            role=UserRole.EDITOR,
            expires_at=datetime.now(timezone.utc) - timedelta(minutes=5),
        )
        session.add(expired_user)
        session.commit()

        expired_user_token = create_access_token(data={"sub": expired_user.username})
        response = client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired_user_token}"})
        assert response.status_code == 401


@pytest.mark.integration
class TestPasswordHashingEdgeCases:
    """Test password hashing edge cases."""

    def test_empty_password_handling(self):
        """Test that empty passwords can be hashed and verified."""
        from app.core.security import get_password_hash, verify_password

        hashed = get_password_hash("")
        assert verify_password("", hashed)
        assert not verify_password("not empty", hashed)

    def test_very_long_password(self):
        """Test handling of very long passwords."""
        from app.core.security import get_password_hash, verify_password

        long_password = "a" * 1000
        hashed = get_password_hash(long_password)
        assert verify_password(long_password, hashed)

    def test_unicode_password(self):
        """Test handling of unicode characters in passwords."""
        from app.core.security import get_password_hash, verify_password

        unicode_password = "пароль密码🔐"
        hashed = get_password_hash(unicode_password)
        assert verify_password(unicode_password, hashed)


@pytest.mark.integration
class TestAuthenticationEnforcementOverride:
    """Test authentication behavior when configuration disables enforcement."""

    @pytest.fixture
    def config_admin_user(self, session: Session):
        """Create admin user with username matching settings.admin_username."""
        from app.core.config import settings

        user = User(
            username=settings.admin_username,
            password_hash=get_password_hash("admin123"),
            role=UserRole.ADMIN,
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        return user

    def test_auth_config_returns_none(self, client: TestClient, monkeypatch):
        """Test /api/auth/config returns 'none' while enforcement is disabled."""
        from app.core.config import settings

        monkeypatch.setattr(settings, "disable_auth_enforcement", True)

        response = client.get("/api/auth/config")
        assert response.status_code == 200
        assert response.json() == {"sign_in_mode": "none", "oidc": None}

    def test_login_endpoint_disabled_with_override(self, client: TestClient, config_admin_user: User, monkeypatch):
        """Test that login endpoint returns 404 when enforcement is disabled."""
        from app.core.config import settings

        monkeypatch.setattr(settings, "disable_auth_enforcement", True)

        response = client.post(
            "/api/auth/token",
            data={
                "username": config_admin_user.username,
                "password": "admin123",
            },
        )

        assert response.status_code == 404
        assert "not enabled" in response.json()["detail"].lower()

    def test_change_password_remains_available_with_override(
        self, client: TestClient, config_admin_user: User, session: Session, monkeypatch
    ):
        """Test that a configured local password can change while enforcement is bypassed."""
        from app.core.config import settings
        from app.core.security import verify_password

        monkeypatch.setattr(settings, "disable_auth_enforcement", True)

        response = client.post(
            "/api/auth/change-password",
            params={"current_password": "admin123", "new_password": "newpass123"},
        )

        assert response.status_code == 200
        session.refresh(config_admin_user)
        assert verify_password("newpass123", config_admin_user.password_hash)

    def test_account_reports_configured_password_capability_with_override(
        self, client: TestClient, config_admin_user: User, monkeypatch
    ) -> None:
        from app.core.config import settings

        monkeypatch.setattr(settings, "disable_auth_enforcement", True)

        response = client.get("/api/auth/account")

        assert response.status_code == 200
        assert response.json()["password_change_available"] is True
        assert response.json()["current_session"] is None

    def test_me_endpoint_returns_admin_without_token(self, client: TestClient, config_admin_user: User, monkeypatch):
        """Test /api/auth/me returns admin user without token while enforcement is disabled."""
        from app.core.config import settings

        monkeypatch.setattr(settings, "disable_auth_enforcement", True)

        response = client.get("/api/auth/me")
        assert response.status_code == 200
        data = response.json()
        assert data["username"] == settings.admin_username
        assert data["role"] == "admin"

    def test_me_endpoint_rejects_expired_admin_without_token(
        self, client: TestClient, config_admin_user: User, session: Session, monkeypatch
    ):
        """Test the override still rejects an expired configured admin user."""
        from app.core.config import settings

        monkeypatch.setattr(settings, "disable_auth_enforcement", True)
        config_admin_user.expires_at = datetime.now(timezone.utc) - timedelta(minutes=5)
        session.add(config_admin_user)
        session.commit()

        response = client.get("/api/auth/me")
        assert response.status_code == 401

    def test_protected_endpoint_accessible_without_token(self, client: TestClient, config_admin_user: User, monkeypatch):
        """Test that protected endpoints are accessible without token while enforcement is disabled."""
        from app.core.config import settings

        monkeypatch.setattr(settings, "disable_auth_enforcement", True)

        # Test connection endpoint (should be accessible as we're treated as admin)
        response = client.get("/api/connections")
        assert response.status_code == 200

    def test_browser_endpoint_accessible_without_token(self, client: TestClient, config_admin_user: User, test_connection, monkeypatch):
        """Test that browser endpoints are accessible without token while enforcement is disabled."""
        from app.core.config import settings

        monkeypatch.setattr(settings, "disable_auth_enforcement", True)

        response = client.get(
            f"/api/browser/{test_connection.id}/list",
            params={"path": ""},
        )
        # Should not get 401 (may fail due to SMB connection, but not auth error)
        assert response.status_code != 401

    def test_enforcement_enabled_requires_token(self, client: TestClient, admin_user: User, monkeypatch):
        """Test that disabled override still requires a token when set to false."""
        from app.core.config import settings

        monkeypatch.setattr(settings, "disable_auth_enforcement", False)

        # Without token should fail
        response = client.get("/api/auth/me")
        assert response.status_code == 401
