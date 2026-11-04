import base64
import json
import unicodedata
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, cast
from urllib.parse import urlparse, urlsplit, urlunparse

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from pydantic import SecretStr
from sqlmodel import Session, select

import app.core.config as config_module
from app.core.environment import IS_PRODUCTION
from app.models.oidc import OidcAdmissionMode, OidcProviderConfiguration, OidcRoleAssignmentMode, OidcSessionCipherKey, SignInMode
from app.models.oidc_api import (
    AuthenticationHealth,
    AuthenticationHealthReason,
    AuthenticationHealthStatus,
    OidcConfigurationCandidate,
    OidcReviewedPolicy,
    OidcRoleMappings,
    RedactedOidcConfiguration,
)
from app.models.user import UserRole
from app.services.oidc_http import validate_oidc_url

OIDC_CALLBACK_PATH = "/api/auth/oidc/callback"


class OidcSecretKeyError(ValueError):
    pass


class OidcSecretDecryptionError(ValueError):
    pass


class OidcSessionCipherKeyError(ValueError):
    pass


class OidcConfigurationError(ValueError):
    pass


@dataclass(frozen=True)
class NormalizedOidcCandidate:
    display_name: str
    issuer_url: str
    client_id: str
    client_secret: str | None = field(repr=False)
    scopes: tuple[str, ...]
    username_claim: str
    name_claim: str | None
    email_claim: str | None
    groups_claim: str | None
    sign_in_mode: SignInMode
    admission_mode: OidcAdmissionMode
    admission_groups: tuple[str, ...]
    admin_groups: tuple[str, ...]
    editor_groups: tuple[str, ...]
    configuration_revision: int
    identity_mapping_revision: int
    identity_namespace_changed: bool
    changed_fields: tuple[str, ...]
    viewer_groups: tuple[str, ...] = ()
    role_assignment_mode: OidcRoleAssignmentMode = OidcRoleAssignmentMode.UNIFORM
    uniform_role: UserRole = UserRole.EDITOR
    interactive_reauthentication_max_age_days: int = 30
    no_refresh_session_limit_hours: int = 8
    auto_link_by_username: bool = True


class OidcSecretCipher:
    def __init__(self, key: str) -> None:
        if not key:
            raise OidcSecretKeyError("OIDC secret key is not configured")
        try:
            self._fernet = Fernet(key.encode("ascii"))
        except (ValueError, UnicodeEncodeError) as exc:
            raise OidcSecretKeyError("OIDC secret key is invalid") from exc

    def encrypt(self, plaintext: str) -> str:
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("ascii")

    def decrypt(self, ciphertext: str) -> str:
        try:
            return self._fernet.decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError, UnicodeEncodeError) as exc:
            raise OidcSecretDecryptionError("OIDC secret could not be decrypted") from exc


@dataclass(frozen=True)
class ActiveOidcSessionCipher:
    key_id: str
    cipher: OidcSecretCipher


LEGACY_OIDC_SESSION_CIPHER_KEY_ID = "v1"
INITIAL_OIDC_SESSION_CIPHER_KEY_ID = "v2"


def get_oidc_secret_cipher() -> OidcSecretCipher:
    return _derive_oidc_cipher(b"sambee/oidc/v1")


def get_oidc_session_cipher() -> OidcSecretCipher:
    """Return the cipher dedicated to long-lived OIDC browser-session secrets."""

    return _derive_oidc_cipher(b"sambee/oidc-session/v1")


def _session_cipher_from_key_record(key: OidcSessionCipherKey) -> OidcSecretCipher:
    try:
        return OidcSecretCipher(get_oidc_secret_cipher().decrypt(key.encrypted_key))
    except (OidcSecretDecryptionError, OidcSecretKeyError) as error:
        raise OidcSessionCipherKeyError("OIDC session cipher key is unavailable") from error


def get_active_oidc_session_cipher(session: Session) -> ActiveOidcSessionCipher:
    """Return the active key, creating the first independently-rotatable key as needed."""

    key = session.exec(select(OidcSessionCipherKey).where(OidcSessionCipherKey.is_active)).one_or_none()
    if key is None:
        key = session.get(OidcSessionCipherKey, INITIAL_OIDC_SESSION_CIPHER_KEY_ID)
        if key is None:
            key = OidcSessionCipherKey(
                key_id=INITIAL_OIDC_SESSION_CIPHER_KEY_ID,
                encrypted_key=get_oidc_secret_cipher().encrypt(Fernet.generate_key().decode("ascii")),
                is_active=True,
            )
            session.add(key)
            session.flush()
        elif not key.is_active:
            key.is_active = True
            key.retired_at = None
            session.add(key)
            session.flush()
    return ActiveOidcSessionCipher(key_id=key.key_id, cipher=_session_cipher_from_key_record(key))


def get_oidc_session_cipher_for_key(session: Session, key_id: str) -> OidcSecretCipher:
    """Resolve an active or retired key without exposing its raw material."""

    key = session.get(OidcSessionCipherKey, key_id)
    if key is None:
        if key_id == LEGACY_OIDC_SESSION_CIPHER_KEY_ID:
            return get_oidc_session_cipher()
        raise OidcSessionCipherKeyError("OIDC session cipher key is unavailable")
    return _session_cipher_from_key_record(key)


def rotate_oidc_session_cipher_key(session: Session) -> ActiveOidcSessionCipher:
    """Create a new active key and retain all prior keys for decryption."""

    current_time = datetime.now(timezone.utc)
    for key in session.exec(select(OidcSessionCipherKey).where(OidcSessionCipherKey.is_active)).all():
        key.is_active = False
        key.retired_at = current_time
        session.add(key)
    key = OidcSessionCipherKey(
        key_id=f"key-{uuid.uuid4().hex}",
        encrypted_key=get_oidc_secret_cipher().encrypt(Fernet.generate_key().decode("ascii")),
        is_active=True,
    )
    session.add(key)
    session.flush()
    return ActiveOidcSessionCipher(key_id=key.key_id, cipher=_session_cipher_from_key_record(key))


def _derive_oidc_cipher(info: bytes) -> OidcSecretCipher:
    encryption_key = config_module.settings.encryption_key
    if not encryption_key:
        raise OidcSecretKeyError("Application encryption key is not loaded")
    derived_key = HKDF(
        algorithm=hashes.SHA256(),
        length=32,
        salt=None,
        info=info,
    ).derive(encryption_key.encode("ascii"))
    return OidcSecretCipher(base64.urlsafe_b64encode(derived_key).decode("ascii"))


def apply_reviewed_policy(
    tested: NormalizedOidcCandidate,
    reviewed: OidcReviewedPolicy,
    active: OidcProviderConfiguration | None,
    cipher: OidcSecretCipher,
) -> NormalizedOidcCandidate:
    if reviewed.sign_in_mode == SignInMode.PASSWORD_ONLY:
        raise OidcConfigurationError("Tested OIDC activation requires an OIDC sign-in mode")
    candidate = OidcConfigurationCandidate(
        display_name=tested.display_name,
        issuer_url=tested.issuer_url,
        client_id=tested.client_id,
        client_secret=SecretStr(tested.client_secret) if tested.client_secret is not None else None,
        scopes=list(tested.scopes),
        username_claim=tested.username_claim,
        name_claim=tested.name_claim,
        email_claim=tested.email_claim,
        groups_claim=tested.groups_claim,
        sign_in_mode=reviewed.sign_in_mode,
        interactive_reauthentication_max_age_days=reviewed.interactive_reauthentication_max_age_days,
        no_refresh_session_limit_hours=reviewed.no_refresh_session_limit_hours,
        admission_mode=reviewed.admission_mode,
        admission_groups=reviewed.admission_groups,
        role_assignment_mode=reviewed.role_assignment_mode,
        uniform_role=reviewed.uniform_role,
        role_mappings=reviewed.role_mappings,
        auto_link_by_username=tested.auto_link_by_username,
    )
    return normalize_candidate(candidate, active, cipher)


def normalize_group_key(value: str) -> str:
    return unicodedata.normalize("NFKC", value.strip()).casefold()


def _normalize_unique_strings(values: list[str], *, field_name: str) -> tuple[str, ...]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        displayed = value.strip()
        normalized = normalize_group_key(displayed)
        if not normalized:
            raise OidcConfigurationError(f"{field_name} contains an empty value")
        if normalized not in seen:
            seen.add(normalized)
            result.append(displayed)
    return tuple(result)


def _normalize_scopes(values: list[str]) -> tuple[str, ...]:
    scopes = _normalize_unique_strings(values, field_name="scopes")
    if "openid" not in scopes:
        raise OidcConfigurationError("OIDC scopes must include openid")
    return scopes


def _optional_claim(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def _active_values(active: OidcProviderConfiguration | None) -> dict[str, Any]:
    if active is None:
        return {}
    return {
        "display_name": active.display_name,
        "issuer_url": active.issuer_url,
        "client_id": active.client_id,
        "scopes": tuple(cast(list[str], json.loads(active.scopes_json))),
        "username_claim": active.username_claim,
        "name_claim": active.name_claim,
        "email_claim": active.email_claim,
        "groups_claim": active.groups_claim,
        "sign_in_mode": active.sign_in_mode,
        "interactive_reauthentication_max_age_days": active.interactive_reauthentication_max_age_days,
        "no_refresh_session_limit_hours": active.no_refresh_session_limit_hours,
        "admission_mode": active.admission_mode,
        "admission_groups": tuple(cast(list[str], json.loads(active.admission_groups_json))),
        "role_assignment_mode": active.role_assignment_mode,
        "uniform_role": active.uniform_role,
        "role_mappings": cast(dict[str, list[str]], json.loads(active.role_mappings_json)),
        "auto_link_by_username": active.auto_link_by_username,
    }


def normalize_candidate(
    candidate: OidcConfigurationCandidate,
    active: OidcProviderConfiguration | None,
    cipher: OidcSecretCipher,
    *,
    development: bool = not IS_PRODUCTION,
) -> NormalizedOidcCandidate:
    issuer_url = candidate.issuer_url.strip()
    try:
        validate_oidc_url(issuer_url, development=development)
    except ValueError as error:
        raise OidcConfigurationError("OIDC issuer URL is invalid") from error
    if urlsplit(issuer_url).query:
        raise OidcConfigurationError("OIDC issuer URL must not contain a query")
    client_id = candidate.client_id.strip()
    username_claim = candidate.username_claim.strip()
    if not client_id or not username_claim:
        raise OidcConfigurationError("OIDC client ID and username claim are required")
    display_name = candidate.display_name.strip() or cast(str, urlsplit(issuer_url).hostname)
    scopes = _normalize_scopes(candidate.scopes)
    admission_groups = _normalize_unique_strings(candidate.admission_groups, field_name="admission groups")
    admin_groups = _normalize_unique_strings(candidate.role_mappings.admin, field_name="administrator role groups")
    editor_groups = _normalize_unique_strings(candidate.role_mappings.editor, field_name="editor role groups")
    viewer_groups = _normalize_unique_strings(candidate.role_mappings.viewer, field_name="viewer role groups")
    if candidate.role_assignment_mode == OidcRoleAssignmentMode.GROUP_BASED:
        role_group_keys = [
            {normalize_group_key(group) for group in admin_groups},
            {normalize_group_key(group) for group in editor_groups},
            {normalize_group_key(group) for group in viewer_groups},
        ]
        if any(first.intersection(second) for index, first in enumerate(role_group_keys) for second in role_group_keys[index + 1 :]):
            raise OidcConfigurationError("One normalized group cannot map to more than one role")
    groups_claim = _optional_claim(candidate.groups_claim)
    groups_required = candidate.admission_mode == OidcAdmissionMode.SELECTED_GROUPS or (
        candidate.role_assignment_mode == OidcRoleAssignmentMode.GROUP_BASED and bool(admin_groups or editor_groups or viewer_groups)
    )
    if groups_required and groups_claim is None:
        raise OidcConfigurationError("A groups claim is required by the selected access policy")

    submitted_secret = candidate.client_secret.get_secret_value().strip() if candidate.client_secret is not None else None
    if candidate.client_secret is not None and not submitted_secret:
        raise OidcConfigurationError("OIDC client secret cannot be empty")
    client_secret = submitted_secret
    if client_secret is None and active is not None and active.encrypted_client_secret is not None:
        client_secret = cipher.decrypt(active.encrypted_client_secret)
    if candidate.sign_in_mode != SignInMode.PASSWORD_ONLY and client_secret is None:
        raise OidcConfigurationError("OIDC sign-in requires a configured client secret")

    namespace_changed = active is not None and (issuer_url != active.issuer_url or client_id != active.client_id)
    active_values = _active_values(active)
    candidate_values: dict[str, Any] = {
        "display_name": display_name,
        "issuer_url": issuer_url,
        "client_id": client_id,
        "scopes": scopes,
        "username_claim": username_claim,
        "name_claim": _optional_claim(candidate.name_claim),
        "email_claim": _optional_claim(candidate.email_claim),
        "groups_claim": groups_claim,
        "sign_in_mode": candidate.sign_in_mode,
        "interactive_reauthentication_max_age_days": candidate.interactive_reauthentication_max_age_days,
        "no_refresh_session_limit_hours": candidate.no_refresh_session_limit_hours,
        "admission_mode": candidate.admission_mode,
        "admission_groups": admission_groups,
        "role_assignment_mode": candidate.role_assignment_mode,
        "uniform_role": candidate.uniform_role,
        "role_mappings": {"admin": list(admin_groups), "editor": list(editor_groups), "viewer": list(viewer_groups)},
        "auto_link_by_username": candidate.auto_link_by_username,
    }
    changed_fields = tuple(key for key, value in candidate_values.items() if active_values.get(key) != value)
    if submitted_secret is not None:
        changed_fields += ("client_secret",)

    return NormalizedOidcCandidate(
        display_name=display_name,
        issuer_url=issuer_url,
        client_id=client_id,
        client_secret=client_secret,
        scopes=scopes,
        username_claim=username_claim,
        name_claim=_optional_claim(candidate.name_claim),
        email_claim=_optional_claim(candidate.email_claim),
        groups_claim=groups_claim,
        sign_in_mode=candidate.sign_in_mode,
        interactive_reauthentication_max_age_days=candidate.interactive_reauthentication_max_age_days,
        no_refresh_session_limit_hours=candidate.no_refresh_session_limit_hours,
        admission_mode=candidate.admission_mode,
        admission_groups=admission_groups,
        role_assignment_mode=candidate.role_assignment_mode,
        uniform_role=candidate.uniform_role,
        admin_groups=admin_groups,
        editor_groups=editor_groups,
        viewer_groups=viewer_groups,
        configuration_revision=(active.configuration_revision if active is not None else 0) + 1,
        identity_mapping_revision=active.identity_mapping_revision if active is not None else 0,
        identity_namespace_changed=namespace_changed,
        changed_fields=changed_fields,
        auto_link_by_username=candidate.auto_link_by_username,
    )


def encrypt_candidate_snapshot(candidate: NormalizedOidcCandidate, cipher: OidcSecretCipher) -> str:
    payload = asdict(candidate)
    payload["sign_in_mode"] = candidate.sign_in_mode.value
    payload["admission_mode"] = candidate.admission_mode.value
    return cipher.encrypt(json.dumps(payload, separators=(",", ":"), sort_keys=True))


def decrypt_candidate_snapshot(ciphertext: str, cipher: OidcSecretCipher) -> NormalizedOidcCandidate:
    try:
        data = json.loads(cipher.decrypt(ciphertext))
        data["sign_in_mode"] = SignInMode(data["sign_in_mode"])
        data["admission_mode"] = OidcAdmissionMode(data["admission_mode"])
        data["role_assignment_mode"] = OidcRoleAssignmentMode(data.get("role_assignment_mode", OidcRoleAssignmentMode.UNIFORM))
        data["uniform_role"] = UserRole(data.get("uniform_role", UserRole.EDITOR))
        for key in ("scopes", "admission_groups", "admin_groups", "editor_groups", "viewer_groups", "changed_fields"):
            data[key] = tuple(data[key])
        return NormalizedOidcCandidate(**data)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise OidcSecretDecryptionError("OIDC candidate snapshot is invalid") from error


def redacted_configuration(configuration: OidcProviderConfiguration) -> RedactedOidcConfiguration:
    role_mappings = cast(dict[str, list[str]], json.loads(configuration.role_mappings_json))
    return RedactedOidcConfiguration(
        display_name=configuration.display_name,
        issuer_url=configuration.issuer_url,
        client_id=configuration.client_id,
        client_secret_configured=configuration.encrypted_client_secret is not None,
        scopes=cast(list[str], json.loads(configuration.scopes_json)),
        username_claim=configuration.username_claim,
        name_claim=configuration.name_claim,
        email_claim=configuration.email_claim,
        groups_claim=configuration.groups_claim,
        sign_in_mode=configuration.sign_in_mode,
        interactive_reauthentication_max_age_days=configuration.interactive_reauthentication_max_age_days,
        no_refresh_session_limit_hours=configuration.no_refresh_session_limit_hours,
        admission_mode=configuration.admission_mode,
        admission_groups=cast(list[str], json.loads(configuration.admission_groups_json)),
        role_assignment_mode=configuration.role_assignment_mode,
        uniform_role=configuration.uniform_role,
        role_mappings=OidcRoleMappings(admin=role_mappings["admin"], editor=role_mappings["editor"], viewer=role_mappings["viewer"]),
        auto_link_by_username=configuration.auto_link_by_username,
        configuration_revision=configuration.configuration_revision,
        identity_mapping_revision=configuration.identity_mapping_revision,
    )


def redacted_candidate(candidate: NormalizedOidcCandidate) -> RedactedOidcConfiguration:
    return RedactedOidcConfiguration(
        display_name=candidate.display_name,
        issuer_url=candidate.issuer_url,
        client_id=candidate.client_id,
        client_secret_configured=candidate.client_secret is not None,
        scopes=list(candidate.scopes),
        username_claim=candidate.username_claim,
        name_claim=candidate.name_claim,
        email_claim=candidate.email_claim,
        groups_claim=candidate.groups_claim,
        sign_in_mode=candidate.sign_in_mode,
        interactive_reauthentication_max_age_days=candidate.interactive_reauthentication_max_age_days,
        no_refresh_session_limit_hours=candidate.no_refresh_session_limit_hours,
        admission_mode=candidate.admission_mode,
        admission_groups=list(candidate.admission_groups),
        role_assignment_mode=candidate.role_assignment_mode,
        uniform_role=candidate.uniform_role,
        role_mappings=OidcRoleMappings(
            admin=list(candidate.admin_groups),
            editor=list(candidate.editor_groups),
            viewer=list(candidate.viewer_groups),
        ),
        auto_link_by_username=candidate.auto_link_by_username,
        configuration_revision=candidate.configuration_revision,
        identity_mapping_revision=candidate.identity_mapping_revision,
    )


def canonicalize_public_url(value: str, *, production: bool = IS_PRODUCTION) -> str:
    normalized = value.strip()
    parsed = urlparse(normalized)
    if not parsed.scheme or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Public URL must be an absolute URL without credentials, query, or fragment")
    if production and parsed.scheme != "https":
        raise ValueError("Public URL must use HTTPS in production")
    if not production and parsed.scheme not in {"http", "https"}:
        raise ValueError("Public URL must use HTTP or HTTPS")
    path = parsed.path.rstrip("/")
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def derive_oidc_redirect_uri(public_url: str, *, production: bool = IS_PRODUCTION) -> str:
    return f"{canonicalize_public_url(public_url, production=production)}{OIDC_CALLBACK_PATH}"


def build_authentication_health(
    *,
    public_url: str,
    encrypted_client_secret: str | None,
    has_active_administrator: bool,
    production: bool = IS_PRODUCTION,
) -> AuthenticationHealth:
    reasons: list[AuthenticationHealthReason] = []
    public_url_configured = bool(public_url)
    canonical_public_url: str | None = None
    redirect_uri: str | None = None

    cipher: OidcSecretCipher | None = None
    try:
        cipher = get_oidc_secret_cipher()
    except OidcSecretKeyError:
        reasons.append(AuthenticationHealthReason.OIDC_SECRET_DECRYPTION_FAILED)

    if cipher is not None and encrypted_client_secret is not None:
        try:
            cipher.decrypt(encrypted_client_secret)
        except OidcSecretDecryptionError:
            reasons.append(AuthenticationHealthReason.OIDC_SECRET_DECRYPTION_FAILED)

    if not public_url_configured:
        reasons.append(AuthenticationHealthReason.PUBLIC_URL_MISSING)
    else:
        try:
            canonical_public_url = canonicalize_public_url(public_url, production=production)
            redirect_uri = derive_oidc_redirect_uri(canonical_public_url, production=production)
        except ValueError:
            reasons.append(AuthenticationHealthReason.PUBLIC_URL_INVALID)

    if not has_active_administrator:
        reasons.append(AuthenticationHealthReason.NO_ACTIVE_ADMINISTRATOR)

    status = AuthenticationHealthStatus.HEALTHY if not reasons else AuthenticationHealthStatus.UNHEALTHY
    return AuthenticationHealth(
        public_url_configured=public_url_configured,
        public_url=canonical_public_url,
        redirect_uri=redirect_uri,
        status=status,
        reasons=reasons,
    )
