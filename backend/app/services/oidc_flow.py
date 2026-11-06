import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Iterator, Sequence
from urllib.parse import urlsplit

from sqlalchemy import delete, update
from sqlmodel import Session, SQLModel, select

from app.models.oidc import OidcFlow, OidcFlowIntent, OidcFlowPurpose, OidcFlowStatus
from app.models.user import User
from app.services.oidc_browser_session import revoke_expired_pending_browser_sessions
from app.services.oidc_configuration import OidcSecretCipher
from app.services.oidc_http import LOGIN_GRANT_LIFETIME_SECONDS, PRE_CALLBACK_FLOW_LIFETIME_SECONDS, VALIDATED_TEST_FLOW_LIFETIME_SECONDS

_FLOW_TABLE = SQLModel.metadata.tables["oidcflow"]
_LOGIN_PATH = "/login"


class OidcFlowError(ValueError):
    pass


@dataclass(frozen=True)
class StartedOidcFlow:
    flow_id: uuid.UUID
    state: str
    nonce: str
    code_verifier: str
    return_path: str


@dataclass(frozen=True)
class ClaimedOidcFlow:
    flow_id: uuid.UUID
    purpose: OidcFlowPurpose
    nonce: str
    code_verifier: str
    configuration_revision: int | None
    return_path: str
    created_at: datetime
    interactive_reauthentication_required: bool
    initiating_admin_id: uuid.UUID | None
    encrypted_candidate_configuration: str | None


@dataclass(frozen=True)
class ValidatedLoginGrant:
    grant: str
    return_path: str


@dataclass(frozen=True)
class ConsumedLoginGrant:
    user: User
    return_path: str
    state_hash: str
    oidc_browser_session_id: uuid.UUID | None
    encrypted_browser_session_secret: str | None

    def __iter__(self) -> Iterator[User | str]:
        """Retain tuple-unpacking compatibility for existing callers."""

        yield self.user
        yield self.return_path


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def hash_flow_secret(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def safe_return_path(value: str | None) -> str:
    if not value or "\\" in value:
        return "/browse"
    parsed = urlsplit(value)
    if (
        parsed.scheme
        or parsed.netloc
        or not parsed.path.startswith("/")
        or parsed.path.startswith("//")
        or parsed.path == _LOGIN_PATH
        or parsed.path.startswith(f"{_LOGIN_PATH}/")
    ):
        return "/browse"
    return parsed.path + (f"?{parsed.query}" if parsed.query else "")


def start_login_flow(
    session: Session,
    *,
    configuration_revision: int,
    cipher: OidcSecretCipher,
    return_path: str | None,
    interactive_reauthentication_required: bool = False,
    now: datetime | None = None,
) -> StartedOidcFlow:
    current_time = now or _now_utc()
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)
    normalized_return_path = safe_return_path(return_path)
    flow = OidcFlow(
        purpose=OidcFlowPurpose.LOGIN,
        status=OidcFlowStatus.STARTED,
        state_hash=hash_flow_secret(state),
        encrypted_verifier=cipher.encrypt(code_verifier),
        encrypted_nonce=cipher.encrypt(nonce),
        configuration_revision=configuration_revision,
        return_path=normalized_return_path,
        interactive_reauthentication_required=interactive_reauthentication_required,
        expires_at=current_time + timedelta(seconds=PRE_CALLBACK_FLOW_LIFETIME_SECONDS),
    )
    session.add(flow)
    session.flush()
    return StartedOidcFlow(
        flow_id=flow.id,
        state=state,
        nonce=nonce,
        code_verifier=code_verifier,
        return_path=normalized_return_path,
    )


def start_test_flow(
    session: Session,
    *,
    initiating_admin_id: uuid.UUID,
    encrypted_candidate_configuration: str,
    active_configuration_revision: int | None,
    cipher: OidcSecretCipher,
    now: datetime | None = None,
) -> StartedOidcFlow:
    current_time = now or _now_utc()
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)
    flow = OidcFlow(
        purpose=OidcFlowPurpose.TEST,
        intent=OidcFlowIntent.CONFIGURE,
        status=OidcFlowStatus.STARTED,
        state_hash=hash_flow_secret(state),
        encrypted_verifier=cipher.encrypt(code_verifier),
        encrypted_nonce=cipher.encrypt(nonce),
        initiating_admin_id=initiating_admin_id,
        encrypted_candidate_configuration=encrypted_candidate_configuration,
        configuration_revision=active_configuration_revision,
        return_path="/settings/admin/authentication",
        expires_at=current_time + timedelta(seconds=PRE_CALLBACK_FLOW_LIFETIME_SECONDS),
    )
    session.add(flow)
    session.flush()
    return StartedOidcFlow(
        flow_id=flow.id,
        state=state,
        nonce=nonce,
        code_verifier=code_verifier,
        return_path=flow.return_path,
    )


def claim_oidc_callback(
    session: Session,
    *,
    state: str,
    cipher: OidcSecretCipher,
    now: datetime | None = None,
) -> ClaimedOidcFlow:
    current_time = now or _now_utc()
    statement = (
        update(_FLOW_TABLE)
        .where(
            _FLOW_TABLE.c.status == OidcFlowStatus.STARTED,
            _FLOW_TABLE.c.state_hash == hash_flow_secret(state),
            _FLOW_TABLE.c.expires_at > current_time,
        )
        .values(status=OidcFlowStatus.CALLBACK_PROCESSING)
        .returning(_FLOW_TABLE.c.id)
    )
    flow_id = session.connection().execute(statement).scalar_one_or_none()
    if flow_id is None:
        raise OidcFlowError("OIDC authorization state is invalid")
    flow = session.get(OidcFlow, flow_id)
    if flow is None or flow.encrypted_nonce is None or flow.encrypted_verifier is None:
        raise OidcFlowError("OIDC authorization state is invalid")
    session.commit()
    return ClaimedOidcFlow(
        flow_id=flow.id,
        purpose=flow.purpose,
        nonce=cipher.decrypt(flow.encrypted_nonce),
        code_verifier=cipher.decrypt(flow.encrypted_verifier),
        configuration_revision=flow.configuration_revision,
        return_path=flow.return_path,
        created_at=flow.created_at,
        interactive_reauthentication_required=flow.interactive_reauthentication_required,
        initiating_admin_id=flow.initiating_admin_id,
        encrypted_candidate_configuration=flow.encrypted_candidate_configuration,
    )


def claim_login_callback(
    session: Session,
    *,
    state: str,
    cipher: OidcSecretCipher,
    now: datetime | None = None,
) -> ClaimedOidcFlow:
    claimed = claim_oidc_callback(session, state=state, cipher=cipher, now=now)
    if claimed.purpose != OidcFlowPurpose.LOGIN:
        raise OidcFlowError("OIDC authorization state is invalid")
    return claimed


def complete_test_callback(
    session: Session,
    *,
    flow_id: uuid.UUID,
    encrypted_tested_identity: str,
    refresh_token_returned: bool = True,
    now: datetime | None = None,
) -> None:
    current_time = now or _now_utc()
    result = session.connection().execute(
        update(_FLOW_TABLE)
        .where(
            _FLOW_TABLE.c.id == flow_id,
            _FLOW_TABLE.c.purpose == OidcFlowPurpose.TEST,
            _FLOW_TABLE.c.status == OidcFlowStatus.CALLBACK_PROCESSING,
        )
        .values(
            status=OidcFlowStatus.CALLBACK_VALIDATED,
            encrypted_tested_identity=encrypted_tested_identity,
            test_refresh_token_returned=refresh_token_returned,
            encrypted_nonce=None,
            encrypted_verifier=None,
            expires_at=current_time + timedelta(seconds=VALIDATED_TEST_FLOW_LIFETIME_SECONDS),
        )
    )
    if result.rowcount != 1:
        raise OidcFlowError("OIDC test flow could not be completed")
    session.commit()


def fail_claimed_callback(session: Session, flow_id: uuid.UUID) -> bool:
    result = session.connection().execute(
        delete(_FLOW_TABLE).where(
            _FLOW_TABLE.c.id == flow_id,
            _FLOW_TABLE.c.status == OidcFlowStatus.CALLBACK_PROCESSING,
        )
    )
    deleted = result.rowcount == 1
    session.commit()
    return deleted


def complete_login_callback(
    session: Session,
    *,
    flow_id: uuid.UUID,
    user: User,
    oidc_browser_session_id: uuid.UUID | None = None,
    encrypted_browser_session_secret: str | None = None,
    now: datetime | None = None,
) -> ValidatedLoginGrant:
    current_time = now or _now_utc()
    grant = secrets.token_urlsafe(32)
    result = session.connection().execute(
        update(_FLOW_TABLE)
        .where(
            _FLOW_TABLE.c.id == flow_id,
            _FLOW_TABLE.c.status == OidcFlowStatus.CALLBACK_PROCESSING,
        )
        .values(
            status=OidcFlowStatus.CALLBACK_VALIDATED,
            grant_hash=hash_flow_secret(grant),
            user_id=user.id,
            user_token_version=user.token_version,
            oidc_browser_session_id=oidc_browser_session_id,
            encrypted_browser_session_secret=encrypted_browser_session_secret,
            encrypted_nonce=None,
            encrypted_verifier=None,
            grant_expires_at=current_time + timedelta(seconds=LOGIN_GRANT_LIFETIME_SECONDS),
        )
    )
    if result.rowcount != 1:
        raise OidcFlowError("OIDC callback flow could not be completed")
    flow = session.get(OidcFlow, flow_id)
    if flow is None:
        raise OidcFlowError("OIDC callback flow could not be completed")
    session.commit()
    return ValidatedLoginGrant(grant=grant, return_path=flow.return_path)


def consume_login_grant(
    session: Session,
    *,
    grant: str,
    browser_states: Sequence[str],
    now: datetime | None = None,
) -> ConsumedLoginGrant:
    current_time = now or _now_utc()
    if not browser_states:
        raise OidcFlowError("OIDC login grant is invalid")
    statement = (
        update(_FLOW_TABLE)
        .where(
            _FLOW_TABLE.c.purpose == OidcFlowPurpose.LOGIN,
            _FLOW_TABLE.c.status == OidcFlowStatus.CALLBACK_VALIDATED,
            _FLOW_TABLE.c.grant_hash == hash_flow_secret(grant),
            _FLOW_TABLE.c.state_hash.in_([hash_flow_secret(state) for state in browser_states]),
            _FLOW_TABLE.c.grant_expires_at > current_time,
        )
        .values(status=OidcFlowStatus.CONSUMED, grant_hash=None)
        .returning(_FLOW_TABLE.c.id, _FLOW_TABLE.c.state_hash)
    )
    matched_flow = session.connection().execute(statement).one_or_none()
    if matched_flow is None:
        raise OidcFlowError("OIDC login grant is invalid")
    flow = session.get(OidcFlow, matched_flow.id)
    if flow is None or flow.user_id is None or flow.user_token_version is None:
        raise OidcFlowError("OIDC login grant is invalid")
    user = session.get(User, flow.user_id)
    user_expired = user is not None and user.expires_at is not None and user.expires_at <= current_time
    if user is None or not user.is_active or user_expired or user.token_version != flow.user_token_version:
        session.delete(flow)
        session.commit()
        raise OidcFlowError("OIDC login grant is invalid")
    consumed = ConsumedLoginGrant(
        user=user,
        return_path=flow.return_path,
        state_hash=matched_flow.state_hash,
        oidc_browser_session_id=flow.oidc_browser_session_id,
        encrypted_browser_session_secret=flow.encrypted_browser_session_secret,
    )
    session.delete(flow)
    session.flush()
    return consumed


def cleanup_expired_flows(session: Session, *, now: datetime | None = None) -> int:
    current_time = now or _now_utc()
    revoke_expired_pending_browser_sessions(session, now=current_time)
    expired_ids = session.exec(select(OidcFlow.id).where(OidcFlow.expires_at <= current_time)).all()
    if not expired_ids:
        session.commit()
        return 0
    session.connection().execute(delete(_FLOW_TABLE).where(_FLOW_TABLE.c.id.in_(expired_ids)))
    session.commit()
    return len(expired_ids)
