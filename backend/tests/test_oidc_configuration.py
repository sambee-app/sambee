import pytest
from cryptography.fernet import Fernet
from sqlmodel import Session

from app.models.oidc import OidcProviderConfiguration, OidcRoleAssignmentMode, SignInMode
from app.models.oidc_api import (
    AuthenticationHealthReason,
    AuthenticationHealthStatus,
    OidcConfigurationCandidate,
    OidcRoleMappings,
)
from app.models.user import UserRole
from app.services.oidc_configuration import (
    OidcConfigurationError,
    OidcSecretCipher,
    OidcSecretDecryptionError,
    OidcSecretKeyError,
    build_authentication_health,
    decrypt_candidate_snapshot,
    derive_oidc_redirect_uri,
    encrypt_candidate_snapshot,
    get_active_oidc_session_cipher,
    get_oidc_secret_cipher,
    get_oidc_session_cipher_for_key,
    normalize_candidate,
    redacted_configuration,
    rotate_oidc_session_cipher_key,
)


def _active_configuration(cipher: OidcSecretCipher) -> OidcProviderConfiguration:
    return OidcProviderConfiguration(
        display_name="Example IDP",
        issuer_url="https://idp.example.test",
        client_id="sambee",
        encrypted_client_secret=cipher.encrypt("existing-secret"),
        sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
        configuration_revision=4,
        identity_mapping_revision=2,
    )


def test_oidc_secret_cipher_round_trip_and_wrong_key() -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    ciphertext = cipher.encrypt("client-secret")

    assert ciphertext != "client-secret"
    assert cipher.decrypt(ciphertext) == "client-secret"

    wrong_cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    try:
        wrong_cipher.decrypt(ciphertext)
    except OidcSecretDecryptionError:
        pass
    else:
        raise AssertionError("Wrong OIDC key must not decrypt ciphertext")


def test_oidc_secret_cipher_rejects_missing_and_invalid_keys() -> None:
    for key in ("", "not-a-fernet-key"):
        try:
            OidcSecretCipher(key)
        except OidcSecretKeyError:
            pass
        else:
            raise AssertionError("Invalid OIDC key must be rejected")


def test_oidc_session_cipher_keyring_rotates_and_retains_old_keys(session: Session) -> None:
    first = get_active_oidc_session_cipher(session)
    ciphertext = first.cipher.encrypt("refresh-token")
    second = rotate_oidc_session_cipher_key(session)

    assert first.key_id != second.key_id
    assert get_oidc_session_cipher_for_key(session, first.key_id).decrypt(ciphertext) == "refresh-token"
    assert get_active_oidc_session_cipher(session).key_id == second.key_id


def test_redirect_uri_uses_canonical_deployment_url() -> None:
    assert derive_oidc_redirect_uri("https://sambee.example.com/", production=True) == ("https://sambee.example.com/api/auth/oidc/callback")


def test_authentication_health_reason_order_is_stable() -> None:
    health = build_authentication_health(
        public_url="http://sambee.example.com?unsafe=true",
        encrypted_client_secret="invalid-ciphertext",
        has_active_administrator=False,
        production=True,
    )

    assert health.status == AuthenticationHealthStatus.UNHEALTHY
    assert health.reasons == [
        AuthenticationHealthReason.OIDC_SECRET_DECRYPTION_FAILED,
        AuthenticationHealthReason.PUBLIC_URL_INVALID,
        AuthenticationHealthReason.NO_ACTIVE_ADMINISTRATOR,
    ]


def test_authentication_health_is_healthy_for_valid_inputs() -> None:
    ciphertext = get_oidc_secret_cipher().encrypt("client-secret")

    health = build_authentication_health(
        public_url="https://sambee.example.com",
        encrypted_client_secret=ciphertext,
        has_active_administrator=True,
        production=True,
    )

    assert health.status == AuthenticationHealthStatus.HEALTHY
    assert health.reasons == []
    assert health.redirect_uri == "https://sambee.example.com/api/auth/oidc/callback"


def test_candidate_omitted_secret_preserves_existing_ciphertext_value() -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    active = _active_configuration(cipher)
    candidate = OidcConfigurationCandidate(
        issuer_url=active.issuer_url,
        client_id=active.client_id,
        sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
    )

    normalized = normalize_candidate(candidate, active, cipher, development=False)

    assert normalized.client_secret == "existing-secret"
    assert "client_secret" not in normalized.changed_fields
    assert "existing-secret" not in repr(normalized)


@pytest.mark.parametrize("issuer_url", ["https://idp.example.test", "https://auth.example.test/application/o/storage/"])
def test_candidate_preserves_issuer_and_trims_surrounding_whitespace(issuer_url: str) -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    active = _active_configuration(cipher)
    active.issuer_url = issuer_url
    candidate = OidcConfigurationCandidate(
        issuer_url=f"  {issuer_url}  ",
        client_id=active.client_id,
        sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
    )

    normalized = normalize_candidate(candidate, active, cipher, development=False)

    assert normalized.issuer_url == issuer_url
    assert normalized.identity_namespace_changed is False
    assert "issuer_url" not in normalized.changed_fields
    assert decrypt_candidate_snapshot(encrypt_candidate_snapshot(normalized, cipher), cipher) == normalized


def test_candidate_trailing_slash_changes_the_identity_namespace() -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    active = _active_configuration(cipher)
    candidate = OidcConfigurationCandidate(
        issuer_url=f"{active.issuer_url}/",
        client_id=active.client_id,
        sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
    )

    normalized = normalize_candidate(candidate, active, cipher, development=False)

    assert normalized.issuer_url == candidate.issuer_url
    assert normalized.identity_namespace_changed is True
    assert "issuer_url" in normalized.changed_fields


def test_candidate_defaults_uniform_role_to_editor() -> None:
    candidate = OidcConfigurationCandidate(
        issuer_url="https://idp.example.test",
        client_id="sambee",
    )

    assert candidate.uniform_role == UserRole.EDITOR


def test_oidc_candidate_accepts_scopes_without_offline_access() -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    candidate = OidcConfigurationCandidate(
        issuer_url="https://idp.example.test",
        client_id="sambee",
        client_secret="secret",
        scopes=["openid", "profile", "email"],
        sign_in_mode=SignInMode.OIDC_ONLY,
    )

    assert normalize_candidate(candidate, None, cipher, development=False).scopes == ("openid", "profile", "email")


def test_candidate_replacement_secret_is_tracked_and_snapshot_is_encrypted() -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    active = _active_configuration(cipher)
    candidate = OidcConfigurationCandidate(
        issuer_url=active.issuer_url,
        client_id=active.client_id,
        client_secret="replacement-secret",
        sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
    )

    normalized = normalize_candidate(candidate, active, cipher, development=False)
    ciphertext = encrypt_candidate_snapshot(normalized, cipher)
    restored = decrypt_candidate_snapshot(ciphertext, cipher)

    assert "client_secret" in normalized.changed_fields
    assert "replacement-secret" not in ciphertext
    assert restored == normalized


def test_candidate_rejects_normalized_cross_role_group_collision() -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    candidate = OidcConfigurationCandidate(
        issuer_url="https://idp.example.test",
        client_id="sambee",
        role_assignment_mode=OidcRoleAssignmentMode.GROUP_BASED,
        role_mappings=OidcRoleMappings(admin=["Admin"], editor=["Ａｄｍｉｎ"], viewer=[]),
    )

    with pytest.raises(OidcConfigurationError):
        normalize_candidate(candidate, None, cipher, development=False)


def test_namespace_change_resets_revision_basis_and_is_detected() -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    active = _active_configuration(cipher)
    candidate = OidcConfigurationCandidate(
        issuer_url="https://replacement.example.test",
        client_id=active.client_id,
        sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
    )

    normalized = normalize_candidate(candidate, active, cipher, development=False)

    assert normalized.identity_namespace_changed is True
    assert normalized.configuration_revision == 5
    assert normalized.identity_mapping_revision == 2


def test_username_claim_change_preserves_identity_namespace() -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    active = _active_configuration(cipher)
    candidate = OidcConfigurationCandidate(
        issuer_url=active.issuer_url,
        client_id=active.client_id,
        username_claim="email",
        sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
    )

    normalized = normalize_candidate(candidate, active, cipher, development=False)

    assert normalized.identity_namespace_changed is False


def test_username_claim_change_does_not_require_an_acknowledgement() -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    active = _active_configuration(cipher)
    candidate = OidcConfigurationCandidate(
        issuer_url=active.issuer_url,
        client_id=active.client_id,
        username_claim="email",
        sign_in_mode=SignInMode.OIDC_OR_PASSWORD,
    )

    normalized = normalize_candidate(candidate, active, cipher, development=False)

    assert normalized.username_claim == "email"


def test_redacted_configuration_never_contains_secret() -> None:
    cipher = OidcSecretCipher(Fernet.generate_key().decode("ascii"))
    active = _active_configuration(cipher)

    payload = redacted_configuration(active).model_dump(mode="json")

    assert payload["client_secret_configured"] is True
    assert "client_secret" not in payload
    assert "encrypted_client_secret" not in payload
