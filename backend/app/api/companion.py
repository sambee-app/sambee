"""
Companion app API endpoints.

Provides all endpoints needed by the Sambee Companion desktop application:
- URI token generation (short-lived token embedded in sambee:// URIs)
- Companion token exchange (exchange URI token for a bootstrap token)
- Edit lock management (acquire, heartbeat, release, force-unlock)
- Lock status query (for web UI display)
- Version compatibility check

Authentication flow:
  1. User clicks "Open in app…" in the web UI.
  2. The frontend requests a short-lived, single-use URI token (POST /uri-token).
  3. The token is embedded in a sambee:// deep-link URI and opened.
  4. The companion app receives the URI, extracts the token, and exchanges it
      for a scoped bootstrap token (POST /token).
  5. Lock acquisition then mints the operation token for the active edit session.

Edit locking:
  The companion acquires a Tier 1 application-level lock (POST /{connection_id}/lock)
  when it opens a file for editing. While the file is open, the companion sends
  heartbeats every 30 seconds. If heartbeats stop (crash, network loss), a
  background task releases the orphaned lock after a timeout. Admins and lock
  holders can force-unlock via DELETE /{connection_id}/lock/force.
"""

import uuid
from datetime import datetime, timedelta, timezone
from secrets import token_urlsafe
from typing import Any, Literal, NoReturn

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from joserfc.errors import ExpiredTokenError, JoseError
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.api._smb_helpers import build_smb_backend, disconnect_backend_safely, file_target_http_error, prepare_file_streamer
from app.core.logging import format_audit_fields, get_logger, set_user
from app.core.security import create_access_token, decode_access_token, get_current_user_with_auth_check, is_user_expired, oauth2_scheme
from app.db.database import get_session
from app.models.companion_uri_token_jti import CompanionUriTokenJti
from app.models.edit_lock import HEARTBEAT_TIMEOUT_SECONDS, EditLock
from app.models.file import FileInfo, FileType
from app.models.user import User, UserRole
from app.services.companion_downloads import (
    CompanionDownloadResolutionError,
    resolve_companion_download_metadata,
)
from app.services.connection_access import get_accessible_connection_or_404, require_connection_write_access
from app.services.lock_manager import remove_expired_file_locks
from app.storage.smb import SMBBackend
from app.utils.content_disposition import build_content_disposition

router = APIRouter()
logger = get_logger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

# URI tokens are single-use but must survive an interactive reverse-proxy login.
URI_TOKEN_EXPIRE_SECONDS = 300
URI_TOKEN_CLASS = "uri_bootstrap"
URI_TOKEN_PURPOSE = "open_in_companion"

# Companion bootstrap tokens are short-lived and non-renewable.
COMPANION_TOKEN_EXPIRE_MINUTES = 5
OPERATION_TOKEN_EXPIRE_MINUTES = 15
OPERATION_TOKEN_RENEW_AFTER_SECONDS = 600
OPERATION_TOKEN_RENEWABLE_WINDOW_SECONDS = (OPERATION_TOKEN_EXPIRE_MINUTES * 60) - OPERATION_TOKEN_RENEW_AFTER_SECONDS
OPERATION_TOKEN_RENEWAL_REQUIRED_SECONDS = 120

# JWT claim key that marks a token as a companion URI token
URI_TOKEN_CLAIM = "companion_uri"

# JWT claim key that marks a token as a companion bootstrap or operation token
COMPANION_TOKEN_CLAIM = "companion_session"
COMPANION_TOKEN_CLASS = "companion_session"
COMPANION_BOOTSTRAP_PURPOSE = "bootstrap"
COMPANION_OPERATION_PURPOSE = "edit_operation"
CompanionOperationErrorCode = Literal["renewal_required", "auth_failed", "lock_lost", "recovery_required", "capability_mismatch"]
COMPANION_ERROR_RENEWAL_REQUIRED: CompanionOperationErrorCode = "renewal_required"
COMPANION_ERROR_AUTH_FAILED: CompanionOperationErrorCode = "auth_failed"
COMPANION_ERROR_LOCK_LOST: CompanionOperationErrorCode = "lock_lost"
COMPANION_ERROR_RECOVERY_REQUIRED: CompanionOperationErrorCode = "recovery_required"
COMPANION_ERROR_CAPABILITY_MISMATCH: CompanionOperationErrorCode = "capability_mismatch"


def _cleanup_expired_uri_token_jtis(session: Session) -> None:
    """Remove expired consumed URI token JTIs from the durable registry."""

    now = datetime.now(timezone.utc)
    expired_records = session.exec(select(CompanionUriTokenJti).where(CompanionUriTokenJti.expires_at < now)).all()
    for record in expired_records:
        session.delete(record)

    if expired_records:
        session.commit()


def _raise_companion_operation_error(
    *,
    status_code: int,
    code: CompanionOperationErrorCode,
    message: str,
) -> NoReturn:
    """Raise a structured companion lifecycle error for native edit flows."""

    raise HTTPException(
        status_code=status_code,
        detail=CompanionErrorDetail(code=code, message=message).model_dump(),
    )


def _companion_audit_fields(**fields: Any) -> str:
    """Format audit-safe companion log fields."""

    return format_audit_fields(**fields)


def _mark_uri_token_used(
    session: Session,
    *,
    jti: str,
    expires_at: datetime,
    user: User,
    connection_id: str | None,
    path: str | None,
) -> bool:
    """Mark a URI token as consumed in the durable registry."""

    _cleanup_expired_uri_token_jtis(session)

    record = CompanionUriTokenJti(
        jti=jti,
        user_id=user.id,
        connection_id=uuid.UUID(connection_id) if connection_id else None,
        path=path or "",
        expires_at=expires_at,
    )
    session.add(record)

    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        return False

    return True


# ──────────────────────────────────────────────────────────────────────────────
# Request / Response schemas
# ──────────────────────────────────────────────────────────────────────────────


class URITokenRequest(BaseModel):
    """Request body for generating a URI token."""

    connection_id: str
    path: str


class URITokenResponse(BaseModel):
    """Response for URI token generation."""

    uri_token: str
    expires_in: int


class CompanionBootstrapTokenResponse(BaseModel):
    """Response for companion bootstrap-token exchange."""

    token: str
    expires_in: int
    token_class: str
    purpose: str
    connection_id: str
    path: str


class CompanionBootstrapTokenExchangeRequest(BaseModel):
    """Request body for exchanging a URI token for a bootstrap token."""

    token: str


class LockResponse(BaseModel):
    """Response for lock operations."""

    lock_id: str
    lock_capability: str
    operation_id: str
    operation_token: str
    operation_expires_in: int
    renew_after_seconds: int
    file_path: str
    locked_by: str
    locked_at: str


class LockControlRequest(BaseModel):
    """Request body for heartbeat and release operations."""

    operation_id: str
    lock_id: str
    lock_capability: str


class LockStatusResponse(BaseModel):
    """Response for lock status queries."""

    lock_id: str | None = None
    operation_id: str | None = None
    locked_by_current_user: bool
    lock_active: bool
    expires_in: int


class HeartbeatResponse(BaseModel):
    """Response for lock heartbeat requests."""

    ok: bool
    lock_expires_in: int
    operation_expires_in: int


class ReleaseResponse(BaseModel):
    """Response for lock release requests."""

    released: bool


class OperationSessionRenewResponse(BaseModel):
    """Response for operation-session renewal."""

    token: str
    expires_in: int
    renew_after_seconds: int


class VersionCheckResponse(BaseModel):
    """Response for companion version compatibility check."""

    compatible: bool
    min_companion_version: str
    latest_version: str


class CompanionDownloadMetadataResponse(BaseModel):
    """Resolved installer metadata used by Sambee to render Companion downloads."""

    source: Literal["feed", "pin"]
    version: str
    published_at: str | None = None
    notes: str
    assets: dict[str, str]


class ProxyAuthCheckResponse(BaseModel):
    """Response for Companion reverse-proxy authentication probing."""

    status: Literal["ok"]


class CompanionErrorDetail(BaseModel):
    """Machine-readable companion lifecycle error payload."""

    code: Literal["renewal_required", "auth_failed", "lock_lost", "recovery_required", "capability_mismatch"]
    message: str


class CompanionUploadResponse(BaseModel):
    """Response for companion upload finalization."""

    status: str
    path: str
    size: int
    last_modified: str | None


# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────


#
# _get_active_lock
#
def _get_active_lock(connection_id: uuid.UUID, path: str, session: Session) -> EditLock | None:
    """Return the active (non-expired) lock for a file, or None."""

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)
    statement = (
        select(EditLock)
        .where(EditLock.connection_id == connection_id)
        .where(EditLock.file_path == path)
        .where(EditLock.last_heartbeat >= cutoff)
    )
    return session.exec(statement).first()


def _get_active_lock_by_id(connection_id: uuid.UUID, lock_id: str, session: Session) -> EditLock | None:
    """Return the active (non-expired) lock for a lock ID, or None."""

    try:
        lock_uuid = uuid.UUID(lock_id)
    except ValueError:
        return None

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)
    statement = (
        select(EditLock)
        .where(EditLock.id == lock_uuid)
        .where(EditLock.connection_id == connection_id)
        .where(EditLock.last_heartbeat >= cutoff)
    )
    return session.exec(statement).first()


def _lock_expires_in_seconds(lock: EditLock) -> int:
    """Return the remaining lock lifetime in seconds."""

    last_heartbeat = lock.last_heartbeat
    if last_heartbeat.tzinfo is None:
        last_heartbeat = last_heartbeat.replace(tzinfo=timezone.utc)

    expires_at = last_heartbeat + timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)
    remaining = int((expires_at - datetime.now(timezone.utc)).total_seconds())
    return max(0, remaining)


def _get_current_companion_bootstrap_user(
    companion_bootstrap_token: str,
    *,
    connection_id: uuid.UUID,
    path: str,
    session: Session,
) -> User:
    """Validate a companion bootstrap token and return the authenticated user."""

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired companion bootstrap token",
    )

    try:
        payload = decode_access_token(companion_bootstrap_token)
    except JoseError:
        logger.warning("Companion lock bootstrap failed: invalid JWT")
        raise credentials_exception

    if not payload.get(COMPANION_TOKEN_CLAIM):
        logger.warning("Companion lock bootstrap failed: missing companion token marker")
        raise credentials_exception

    if payload.get("token_class") != COMPANION_TOKEN_CLASS:
        logger.warning("Companion lock bootstrap failed: wrong token class")
        raise credentials_exception

    if payload.get("purpose") != COMPANION_BOOTSTRAP_PURPOSE:
        logger.warning("Companion lock bootstrap failed: wrong token purpose")
        raise credentials_exception

    subject: str | None = payload.get("sub")
    if not subject:
        logger.warning("Companion lock bootstrap failed: missing subject")
        raise credentials_exception

    statement = select(User).where(User.username == subject)
    user = session.exec(statement).first()
    if not user or not user.is_active or is_user_expired(user):
        logger.warning("Companion lock bootstrap failed: user missing or inactive")
        raise credentials_exception

    token_version = int(payload.get("tv", -1))
    if token_version != user.token_version:
        logger.warning("Companion lock bootstrap failed: token version mismatch")
        raise credentials_exception

    if payload.get("conn_id") != str(connection_id) or payload.get("path") != path:
        logger.warning(
            f"Companion lock bootstrap failed: scope mismatch for user={user.username}, "
            f"token_conn_id={payload.get('conn_id')}, request_conn_id={connection_id}, "
            f"token_path={payload.get('path')}, request_path='{path}'"
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Companion bootstrap token scope mismatch",
        )

    return user


def _generate_lock_capability() -> str:
    """Create an opaque secret used for strong lock control."""

    return token_urlsafe(32)


def _generate_operation_id() -> str:
    """Create an opaque identifier for one active native edit operation."""

    return uuid.uuid4().hex


def _create_operation_token(
    *,
    user: User,
    connection_id: uuid.UUID,
    path: str,
    lock_id: uuid.UUID,
    operation_id: str,
) -> str:
    """Create an operation-scoped companion token bound to one lock lifecycle."""

    return create_access_token(
        data={
            "sub": user.username,
            "tv": user.token_version,
            "jti": uuid.uuid4().hex,
            COMPANION_TOKEN_CLAIM: True,
            "token_class": COMPANION_TOKEN_CLASS,
            "purpose": COMPANION_OPERATION_PURPOSE,
            "conn_id": str(connection_id),
            "path": path,
            "lock_id": str(lock_id),
            "op_id": operation_id,
        },
        expires_delta=timedelta(minutes=OPERATION_TOKEN_EXPIRE_MINUTES),
    )


def _get_current_companion_operation_claims(
    operation_session: str,
    *,
    connection_id: uuid.UUID,
    path: str | None,
    operation_id: str,
    lock_id: str,
    session: Session,
    allow_renewal_required_window: bool = False,
) -> tuple[User, dict[str, Any]]:
    """Validate an operation-scoped companion token and return the user plus decoded claims."""

    try:
        payload = decode_access_token(operation_session)
    except ExpiredTokenError:
        logger.warning("Companion operation request failed: operation token expired")
        _raise_companion_operation_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code=COMPANION_ERROR_RECOVERY_REQUIRED,
            message="The companion edit session expired and can no longer be resumed. Reopen the file from Sambee and try again.",
        )
    except JoseError:
        logger.warning("Companion operation request failed: invalid JWT")
        _raise_companion_operation_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code=COMPANION_ERROR_AUTH_FAILED,
            message="The companion edit session is no longer authorized. Reopen the file from Sambee and try again.",
        )

    if not payload.get(COMPANION_TOKEN_CLAIM):
        logger.warning("Companion operation request failed: missing companion token marker")
        _raise_companion_operation_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code=COMPANION_ERROR_AUTH_FAILED,
            message="The companion edit session is no longer authorized. Reopen the file from Sambee and try again.",
        )

    if payload.get("token_class") != COMPANION_TOKEN_CLASS:
        logger.warning("Companion operation request failed: wrong token class")
        _raise_companion_operation_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code=COMPANION_ERROR_AUTH_FAILED,
            message="The companion edit session is no longer authorized. Reopen the file from Sambee and try again.",
        )

    if payload.get("purpose") != COMPANION_OPERATION_PURPOSE:
        logger.warning("Companion operation request failed: wrong token purpose")
        _raise_companion_operation_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code=COMPANION_ERROR_AUTH_FAILED,
            message="The companion edit session is no longer authorized. Reopen the file from Sambee and try again.",
        )

    subject: str | None = payload.get("sub")
    if not subject:
        logger.warning("Companion operation request failed: missing subject")
        _raise_companion_operation_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code=COMPANION_ERROR_AUTH_FAILED,
            message="The companion edit session is no longer authorized. Reopen the file from Sambee and try again.",
        )

    statement = select(User).where(User.username == subject)
    user = session.exec(statement).first()
    if not user or not user.is_active or is_user_expired(user):
        logger.warning("Companion operation request failed: user missing or inactive")
        _raise_companion_operation_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code=COMPANION_ERROR_AUTH_FAILED,
            message="The companion edit session is no longer authorized. Reopen the file from Sambee and try again.",
        )

    token_version = int(payload.get("tv", -1))
    if token_version != user.token_version:
        logger.warning("Companion operation request failed: token version mismatch")
        _raise_companion_operation_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code=COMPANION_ERROR_AUTH_FAILED,
            message="The companion edit session is no longer authorized. Reopen the file from Sambee and try again.",
        )

    if payload.get("conn_id") != str(connection_id):
        logger.warning(
            f"Companion operation request failed: scope mismatch for user={user.username}, "
            f"token_conn_id={payload.get('conn_id')}, request_conn_id={connection_id}, "
            f"token_path={payload.get('path')}, request_path='{path}'"
        )
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
        )

    token_path = payload.get("path")
    if path is not None and token_path != path:
        logger.warning(
            f"Companion operation request failed: scope mismatch for user={user.username}, "
            f"token_conn_id={payload.get('conn_id')}, request_conn_id={connection_id}, "
            f"token_path={token_path}, request_path='{path}'"
        )
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
        )

    if payload.get("op_id") != operation_id:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
        )

    if payload.get("lock_id") != lock_id:
        _raise_companion_operation_error(
            status_code=status.HTTP_404_NOT_FOUND,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer active for this file. Reopen the file from Sambee and try again.",
        )

    remaining_seconds = _get_operation_token_remaining_seconds(payload)
    if not allow_renewal_required_window and 0 < remaining_seconds <= OPERATION_TOKEN_RENEWAL_REQUIRED_SECONDS:
        _raise_companion_operation_error(
            status_code=status.HTTP_409_CONFLICT,
            code=COMPANION_ERROR_RENEWAL_REQUIRED,
            message="The companion edit session must be renewed before retrying this request.",
        )

    return user, payload


def _get_current_companion_operation_user(
    operation_session: str,
    *,
    connection_id: uuid.UUID,
    path: str | None,
    operation_id: str,
    lock_id: str,
    session: Session,
    allow_renewal_required_window: bool = False,
) -> User:
    """Validate an operation-scoped companion token and return the authenticated user."""

    user, _payload = _get_current_companion_operation_claims(
        operation_session,
        connection_id=connection_id,
        path=path,
        operation_id=operation_id,
        lock_id=lock_id,
        session=session,
        allow_renewal_required_window=allow_renewal_required_window,
    )
    return user


def _get_operation_token_remaining_seconds(payload: dict[str, Any]) -> int:
    """Return the remaining lifetime of an operation token in whole seconds."""

    exp_claim = payload.get("exp")
    if isinstance(exp_claim, datetime):
        expires_at = exp_claim.astimezone(timezone.utc)
    elif isinstance(exp_claim, (int, float)):
        expires_at = datetime.fromtimestamp(exp_claim, tz=timezone.utc)
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired operation token",
        )

    remaining = int((expires_at - datetime.now(timezone.utc)).total_seconds())
    return max(0, remaining)


def _validate_lock_control(lock: EditLock, body: LockControlRequest) -> None:
    """Require both lock identity and lock capability for lock-control endpoints."""

    if lock.operation_id != body.operation_id:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
        )

    if str(lock.id) != body.lock_id:
        _raise_companion_operation_error(
            status_code=status.HTTP_404_NOT_FOUND,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer active for this file. Reopen the file from Sambee and try again.",
        )

    if lock.lock_capability != body.lock_capability:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_CAPABILITY_MISMATCH,
            message="The supplied lock capability is no longer valid for this edit session. Reopen the file from Sambee and try again.",
        )


def _validate_operation_lock_scope(
    lock: EditLock,
    *,
    operation_id: str,
    lock_id: str,
    lock_capability: str,
) -> None:
    """Require the active lock to match the requested operation and lock identity."""

    if lock.operation_id != operation_id:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
        )

    if str(lock.id) != lock_id:
        _raise_companion_operation_error(
            status_code=status.HTTP_404_NOT_FOUND,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer active for this file. Reopen the file from Sambee and try again.",
        )

    if lock.lock_capability != lock_capability:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_CAPABILITY_MISMATCH,
            message="The supplied lock capability is no longer valid for this edit session. Reopen the file from Sambee and try again.",
        )


# ──────────────────────────────────────────────────────────────────────────────
# 1. URI token generation (called by the web frontend)
# ──────────────────────────────────────────────────────────────────────────────


@router.post("/uri-token", response_model=URITokenResponse)
async def create_uri_token(
    body: URITokenRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
) -> URITokenResponse:
    """Generate a short-lived, single-use token for embedding in sambee:// URIs.

    The web frontend calls this when the user clicks "Open in app…". The token
    is placed in the URI and the companion exchanges it for a bootstrap token.
    """

    set_user(current_user.username)
    jti = uuid.uuid4().hex
    expires_delta = timedelta(seconds=URI_TOKEN_EXPIRE_SECONDS)
    token = create_access_token(
        data={
            "sub": current_user.username,
            URI_TOKEN_CLAIM: True,
            "token_class": URI_TOKEN_CLASS,
            "purpose": URI_TOKEN_PURPOSE,
            "jti": jti,
            "conn_id": body.connection_id,
            "path": body.path,
        },
        expires_delta=expires_delta,
    )

    logger.info(
        f"URI token created: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=body.connection_id, path=body.path, uri_token_jti=jti)}"
    )
    return URITokenResponse(uri_token=token, expires_in=URI_TOKEN_EXPIRE_SECONDS)


# ──────────────────────────────────────────────────────────────────────────────
# 2. Companion token exchange
# ──────────────────────────────────────────────────────────────────────────────


@router.post("/token", response_model=CompanionBootstrapTokenResponse)
async def exchange_companion_token(
    session: Session = Depends(get_session),
    body: CompanionBootstrapTokenExchangeRequest = Body(...),
) -> CompanionBootstrapTokenResponse:
    """Exchange a short-lived URI token for a longer-lived companion bootstrap token.

    The companion calls this immediately after receiving a sambee:// URI.
    The URI token is validated, marked as consumed (single-use), and a new
    bootstrap token is returned.
    """

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired URI token",
    )

    try:
        payload = decode_access_token(body.token)
    except JoseError:
        logger.warning("Companion token exchange failed: invalid JWT")
        raise credentials_exception

    # Validate this is actually a URI token (not a normal browser access token)
    if not payload.get(URI_TOKEN_CLAIM):
        logger.warning("Companion token exchange failed: not a URI token")
        raise credentials_exception

    if payload.get("token_class") != URI_TOKEN_CLASS or payload.get("purpose") != URI_TOKEN_PURPOSE:
        logger.warning("Companion token exchange failed: wrong URI token class or purpose")
        raise credentials_exception

    username: str | None = payload.get("sub")
    jti: str | None = payload.get("jti")
    if not username or not jti:
        logger.warning("Companion token exchange failed: missing claims")
        raise credentials_exception

    # Verify user still exists
    statement = select(User).where(User.username == username)
    user = session.exec(statement).first()
    if not user:
        logger.warning(f"Companion token exchange failed: user '{username}' not found")
        raise credentials_exception
    user_id = user.id

    connection_id = payload.get("conn_id")
    path = payload.get("path")
    if not isinstance(connection_id, str) or not isinstance(path, str):
        logger.warning("Companion token exchange failed: malformed connection or path claim")
        raise credentials_exception

    # Enforce single-use
    exp_timestamp = payload.get("exp", 0)
    token_expiry = datetime.fromtimestamp(exp_timestamp, tz=timezone.utc)
    if not _mark_uri_token_used(
        session,
        jti=jti,
        expires_at=token_expiry,
        user=user,
        connection_id=connection_id,
        path=path,
    ):
        logger.warning(
            f"Companion token exchange failed: {_companion_audit_fields(user_id=user_id, username=username, connection_id=connection_id, path=path, uri_token_jti=jti, outcome='replayed_token')}"
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Token has already been used",
        )

    # Issue companion bootstrap token
    expires_delta = timedelta(minutes=COMPANION_TOKEN_EXPIRE_MINUTES)
    session_token = create_access_token(
        data={
            "sub": username,
            COMPANION_TOKEN_CLAIM: True,
            "token_class": COMPANION_TOKEN_CLASS,
            "purpose": COMPANION_BOOTSTRAP_PURPOSE,
            "tv": user.token_version,
            "conn_id": connection_id,
            "path": path,
        },
        expires_delta=expires_delta,
    )

    logger.info(
        f"Companion token exchanged: {_companion_audit_fields(user_id=user.id, username=user.username, connection_id=connection_id, path=path, uri_token_jti=jti)}"
    )
    return CompanionBootstrapTokenResponse(
        token=session_token,
        expires_in=COMPANION_TOKEN_EXPIRE_MINUTES * 60,
        token_class=COMPANION_TOKEN_CLASS,
        purpose=COMPANION_BOOTSTRAP_PURPOSE,
        connection_id=connection_id,
        path=path,
    )


@router.get("/{connection_id}/file-info", response_model=FileInfo)
async def get_companion_file_info(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to the file or directory"),
    operation_id: str | None = Query(None, description="Active companion operation ID"),
    lock_id: str | None = Query(None, description="Active companion lock ID"),
    companion_token: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> FileInfo:
    """Return file metadata for companion bootstrap or operation-scoped flows."""

    if operation_id or lock_id:
        if not operation_id or not lock_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing companion operation context")

        current_user = _get_current_companion_operation_user(
            companion_token,
            connection_id=connection_id,
            path=path,
            operation_id=operation_id,
            lock_id=lock_id,
            session=session,
        )
        lock = _get_active_lock_by_id(connection_id, lock_id, session)
        if not lock:
            _raise_companion_operation_error(
                status_code=status.HTTP_404_NOT_FOUND,
                code=COMPANION_ERROR_LOCK_LOST,
                message="The edit lock is no longer active for this file. Reopen the file from Sambee and try again.",
            )
        if lock.file_path != path:
            _raise_companion_operation_error(
                status_code=status.HTTP_403_FORBIDDEN,
                code=COMPANION_ERROR_LOCK_LOST,
                message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
            )
        if lock.operation_id != operation_id:
            _raise_companion_operation_error(
                status_code=status.HTTP_403_FORBIDDEN,
                code=COMPANION_ERROR_LOCK_LOST,
                message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
            )
    else:
        current_user = _get_current_companion_bootstrap_user(
            companion_token,
            connection_id=connection_id,
            path=path,
            session=session,
        )

    set_user(current_user.username)
    connection = get_accessible_connection_or_404(session, current_user, connection_id)

    try:
        backend = build_smb_backend(connection, backend_factory=SMBBackend)
        await backend.connect()
        try:
            return await backend.get_file_info(path)
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"companion file info request: connection_id={connection_id}, path='{path}'",
            )
    except (FileNotFoundError, PermissionError, NotADirectoryError, TimeoutError) as error:
        raise file_target_http_error(error, requires_file=False) from error
    except Exception as error:
        logger.error(
            f"Failed to get companion file info: connection_id={connection_id}, path='{path}', error={type(error).__name__}: {error}",
            exc_info=True,
        )
        raise file_target_http_error(error, requires_file=False) from error


@router.get("/{connection_id}/download")
async def download_file_for_companion(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to the file"),
    operation_id: str = Query(..., description="Active companion operation ID"),
    lock_id: str = Query(..., description="Active companion lock ID"),
    operation_session: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Download a file for an active companion edit session."""

    current_user = _get_current_companion_operation_user(
        operation_session,
        connection_id=connection_id,
        path=path,
        operation_id=operation_id,
        lock_id=lock_id,
        session=session,
    )
    set_user(current_user.username)

    lock = _get_active_lock_by_id(connection_id, lock_id, session)
    if not lock:
        _raise_companion_operation_error(
            status_code=status.HTTP_404_NOT_FOUND,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer active for this file. Reopen the file from Sambee and try again.",
        )
    if lock.operation_id != operation_id or lock.file_path != path:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
        )

    connection = get_accessible_connection_or_404(session, current_user, connection_id)
    if not connection.share_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Connection has no share name configured")

    backend = build_smb_backend(connection, backend_factory=SMBBackend)

    try:
        await backend.connect()
        file_info = await backend.get_file_info(path)
    except Exception as error:
        await disconnect_backend_safely(
            backend,
            logger=logger,
            context=f"companion download metadata request: connection_id={connection_id}, path='{path}'",
        )
        raise file_target_http_error(error) from error

    if file_info.type != FileType.FILE:
        await disconnect_backend_safely(backend, logger=logger, context="companion download wrong type")
        raise file_target_http_error(IsADirectoryError())

    headers = {"Content-Disposition": build_content_disposition("attachment", file_info.name)}
    return StreamingResponse(
        await prepare_file_streamer(backend, path), media_type=file_info.mime_type or "application/octet-stream", headers=headers
    )


@router.post("/{connection_id}/upload", response_model=CompanionUploadResponse)
async def upload_file_for_companion(
    connection_id: uuid.UUID,
    operation_id: str = Form(...),
    lock_id: str = Form(...),
    lock_capability: str = Form(...),
    file: UploadFile = File(...),
    operation_session: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> CompanionUploadResponse:
    """Upload an edited file for an active companion edit session."""

    current_user, payload = _get_current_companion_operation_claims(
        operation_session,
        connection_id=connection_id,
        path=None,
        operation_id=operation_id,
        lock_id=lock_id,
        session=session,
    )
    path = str(payload.get("path") or "")
    if not path:
        _raise_companion_operation_error(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code=COMPANION_ERROR_AUTH_FAILED,
            message="The companion edit session is no longer authorized. Reopen the file from Sambee and try again.",
        )

    set_user(current_user.username)

    lock = _get_active_lock_by_id(connection_id, lock_id, session)
    if not lock:
        _raise_companion_operation_error(
            status_code=status.HTTP_404_NOT_FOUND,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer active for this file. Reopen the file from Sambee and try again.",
        )

    _validate_operation_lock_scope(
        lock,
        operation_id=operation_id,
        lock_id=lock_id,
        lock_capability=lock_capability,
    )

    if lock.file_path != path:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
        )
    if lock.locked_by != current_user.username:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer owned by this edit session. Reopen the file from Sambee and try again.",
        )

    connection = get_accessible_connection_or_404(session, current_user, connection_id)
    require_connection_write_access(current_user, connection, action="upload", path=path)

    try:
        backend = build_smb_backend(connection, backend_factory=SMBBackend)
        await backend.connect()
        try:
            bytes_written = await backend.write_file(path, file.file)
            updated_info = await backend.get_file_info(path)
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"companion upload request: connection_id={connection_id}, path='{path}'",
            )

        logger.info(f"Companion upload complete: connection_id={connection_id}, path='{path}', size={bytes_written}")
        return CompanionUploadResponse(
            status="ok",
            path=path,
            size=bytes_written,
            last_modified=updated_info.modified_at.isoformat() if updated_info.modified_at else None,
        )
    except TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Upload timed out. The remote share did not respond in time.",
        )
    except IOError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error))
    except Exception as error:
        logger.error(
            f"Failed to upload companion file: connection_id={connection_id}, path='{path}', error={type(error).__name__}: {error}",
            exc_info=True,
        )
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to upload file: {error}")


# ──────────────────────────────────────────────────────────────────────────────
# 3. Reverse-proxy authentication probe
# ──────────────────────────────────────────────────────────────────────────────


@router.get("/proxy-auth-check", response_model=ProxyAuthCheckResponse)
async def proxy_auth_check(
    current_user: User = Depends(get_current_user_with_auth_check),
) -> ProxyAuthCheckResponse:
    """Confirm that a Companion-owned webview has passed reverse-proxy auth.

    The Companion opens this URL in an embedded Tauri webview when a reverse
    proxy or SSO layer intercepts token exchange. The endpoint has no side
    effects and does not consume URI tokens; it only gives the webview a stable
    backend-origin success URL from which Companion can read proxy cookies.
    """

    set_user(current_user.username)
    logger.info(f"Companion proxy auth check succeeded: {_companion_audit_fields(user_id=current_user.id, username=current_user.username)}")
    return ProxyAuthCheckResponse(status="ok")


# ──────────────────────────────────────────────────────────────────────────────
# 4. Lock management endpoints
# ──────────────────────────────────────────────────────────────────────────────


@router.post("/{connection_id}/lock", response_model=LockResponse)
async def acquire_lock(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to the file to lock"),
    companion_bootstrap_token: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> LockResponse:
    """Acquire an edit lock on a file.

    Creates a Tier 1 (application-level) lock in the database. The companion
    must send heartbeats to keep the lock alive. If another user already holds
    an active lock, returns 409 Conflict.
    """

    current_user = _get_current_companion_bootstrap_user(
        companion_bootstrap_token,
        connection_id=connection_id,
        path=path,
        session=session,
    )

    set_user(current_user.username)
    logger.info(
        f"Lock acquire requested: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path)}"
    )

    connection = get_accessible_connection_or_404(session, current_user, connection_id)
    require_connection_write_access(current_user, connection, action="acquire_lock", path=path)

    remove_expired_file_locks(session, connection_id, path)
    existing = _get_active_lock(connection_id, path, session)
    if existing:
        if existing.locked_by == current_user.username:
            # Replace malformed legacy rows instead of carrying cutover-only
            # compatibility state forward in the active lock contract.
            if not existing.lock_capability or not existing.operation_id:
                logger.warning(
                    f"Replacing malformed active lock during re-lock: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path, lock_id=existing.id, operation_id=existing.operation_id or None)}"
                )
                session.delete(existing)
                session.commit()

                replacement_lock = EditLock(
                    file_path=path,
                    connection_id=connection_id,
                    locked_by=current_user.username,
                    operation_id=_generate_operation_id(),
                    lock_capability=_generate_lock_capability(),
                )
                session.add(replacement_lock)
                session.commit()
                session.refresh(replacement_lock)

                replacement_token = _create_operation_token(
                    user=current_user,
                    connection_id=connection_id,
                    path=path,
                    lock_id=replacement_lock.id,
                    operation_id=replacement_lock.operation_id,
                )
                logger.info(
                    f"Malformed lock replaced during re-lock: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path, lock_id=replacement_lock.id, operation_id=replacement_lock.operation_id)}"
                )
                return LockResponse(
                    lock_id=str(replacement_lock.id),
                    lock_capability=replacement_lock.lock_capability,
                    operation_id=replacement_lock.operation_id,
                    operation_token=replacement_token,
                    operation_expires_in=OPERATION_TOKEN_EXPIRE_MINUTES * 60,
                    renew_after_seconds=OPERATION_TOKEN_RENEW_AFTER_SECONDS,
                    file_path=replacement_lock.file_path,
                    locked_by=replacement_lock.locked_by,
                    locked_at=replacement_lock.locked_at.isoformat(),
                )

        logger.warning(
            f"Lock conflict: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path, lock_owner=existing.locked_by, lock_id=existing.id, operation_id=existing.operation_id)}"
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"File is locked for editing by {existing.locked_by}",
        )

    # Create new lock
    lock = EditLock(
        file_path=path,
        connection_id=connection_id,
        locked_by=current_user.username,
        operation_id=_generate_operation_id(),
        lock_capability=_generate_lock_capability(),
    )
    session.add(lock)
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="File is already locked for editing") from error
    session.refresh(lock)

    operation_token = _create_operation_token(
        user=current_user,
        connection_id=connection_id,
        path=path,
        lock_id=lock.id,
        operation_id=lock.operation_id,
    )

    logger.info(
        f"Lock acquired: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path, lock_id=lock.id, operation_id=lock.operation_id)}"
    )
    return LockResponse(
        lock_id=str(lock.id),
        lock_capability=lock.lock_capability,
        operation_id=lock.operation_id,
        operation_token=operation_token,
        operation_expires_in=OPERATION_TOKEN_EXPIRE_MINUTES * 60,
        renew_after_seconds=OPERATION_TOKEN_RENEW_AFTER_SECONDS,
        file_path=lock.file_path,
        locked_by=lock.locked_by,
        locked_at=lock.locked_at.isoformat(),
    )


@router.post("/{connection_id}/lock/heartbeat", response_model=HeartbeatResponse)
async def heartbeat_lock(
    connection_id: uuid.UUID,
    body: LockControlRequest,
    operation_session: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> HeartbeatResponse:
    """Refresh the heartbeat on an active edit lock.

    The companion calls this every 30 seconds to keep the lock alive.
    Returns 404 if the lock no longer exists (e.g., force-unlocked by admin).
    """

    current_user, payload = _get_current_companion_operation_claims(
        operation_session,
        connection_id=connection_id,
        path=None,
        operation_id=body.operation_id,
        lock_id=body.lock_id,
        session=session,
    )
    path = str(payload.get("path") or "")

    set_user(current_user.username)

    lock = _get_active_lock_by_id(connection_id, body.lock_id, session)
    if not lock:
        logger.warning(
            f"Heartbeat for non-existent lock: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path, lock_id=body.lock_id, operation_id=body.operation_id)}"
        )
        _raise_companion_operation_error(
            status_code=status.HTTP_404_NOT_FOUND,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer active for this file. Reopen the file from Sambee and try again.",
        )

    _validate_lock_control(lock, body)

    if lock.file_path != path:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
        )

    if lock.locked_by != current_user.username:
        logger.warning(
            f"Heartbeat from wrong user: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path, lock_owner=lock.locked_by, lock_id=lock.id, operation_id=lock.operation_id)}"
        )
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer owned by this edit session. Reopen the file from Sambee and try again.",
        )

    lock.last_heartbeat = datetime.now(timezone.utc)
    session.add(lock)
    session.commit()

    return HeartbeatResponse(
        ok=True,
        lock_expires_in=HEARTBEAT_TIMEOUT_SECONDS,
        operation_expires_in=_get_operation_token_remaining_seconds(payload),
    )


@router.delete("/{connection_id}/lock", response_model=ReleaseResponse)
async def release_lock(
    connection_id: uuid.UUID,
    body: LockControlRequest,
    operation_session: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> ReleaseResponse:
    """Release an edit lock on a file.

    Called by the companion when the user clicks "Done Editing" or
    "Discard Changes".  Only the lock holder can release their own lock.
    """

    current_user, payload = _get_current_companion_operation_claims(
        operation_session,
        connection_id=connection_id,
        path=None,
        operation_id=body.operation_id,
        lock_id=body.lock_id,
        session=session,
    )
    path = str(payload.get("path") or "")

    set_user(current_user.username)
    logger.info(
        f"Lock release requested: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path, lock_id=body.lock_id, operation_id=body.operation_id)}"
    )

    lock = _get_active_lock_by_id(connection_id, body.lock_id, session)
    if not lock:
        # Lock already gone — idempotent success
        return ReleaseResponse(released=True)

    _validate_lock_control(lock, body)

    if lock.file_path != path:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
        )

    if lock.locked_by != current_user.username:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer owned by this edit session. Reopen the file from Sambee and try again.",
        )

    session.delete(lock)
    session.commit()

    logger.info(
        f"Lock released: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path, lock_id=lock.id, operation_id=lock.operation_id)}"
    )
    return ReleaseResponse(released=True)


@router.post("/{connection_id}/session/renew", response_model=OperationSessionRenewResponse)
async def renew_operation_session(
    connection_id: uuid.UUID,
    body: LockControlRequest,
    operation_session: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> OperationSessionRenewResponse:
    """Mint a fresh operation-scoped companion token for an active lock."""

    current_user, payload = _get_current_companion_operation_claims(
        operation_session,
        connection_id=connection_id,
        path=None,
        operation_id=body.operation_id,
        lock_id=body.lock_id,
        session=session,
        allow_renewal_required_window=True,
    )
    path = str(payload.get("path") or "")

    set_user(current_user.username)

    remaining_seconds = _get_operation_token_remaining_seconds(payload)
    if remaining_seconds > OPERATION_TOKEN_RENEWABLE_WINDOW_SECONDS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Operation session is not yet eligible for renewal",
        )

    lock = _get_active_lock_by_id(connection_id, body.lock_id, session)
    if not lock:
        _raise_companion_operation_error(
            status_code=status.HTTP_404_NOT_FOUND,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer active for this file. Reopen the file from Sambee and try again.",
        )

    _validate_lock_control(lock, body)

    if lock.file_path != path:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The active edit lock no longer matches this file session. Reopen the file from Sambee and try again.",
        )

    if lock.locked_by != current_user.username:
        _raise_companion_operation_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code=COMPANION_ERROR_LOCK_LOST,
            message="The edit lock is no longer owned by this edit session. Reopen the file from Sambee and try again.",
        )

    token = _create_operation_token(
        user=current_user,
        connection_id=connection_id,
        path=path,
        lock_id=lock.id,
        operation_id=lock.operation_id,
    )

    logger.info(
        f"Operation session renewed: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path, lock_id=lock.id, operation_id=lock.operation_id)}"
    )
    return OperationSessionRenewResponse(
        token=token,
        expires_in=OPERATION_TOKEN_EXPIRE_MINUTES * 60,
        renew_after_seconds=OPERATION_TOKEN_RENEW_AFTER_SECONDS,
    )


@router.delete("/{connection_id}/lock/force")
async def force_unlock(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to the locked file"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> dict[str, str]:
    """Force-unlock a file, bypassing ownership check.

    Only the lock holder and admin users can force-unlock.  This is the
    escape hatch for erroneously locked files.
    """

    set_user(current_user.username)
    logger.info(
        f"Force unlock requested: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path)}"
    )

    lock = _get_active_lock(connection_id, path, session)
    if not lock:
        return {"status": "ok"}

    # Only admins and the lock holder can force-unlock
    is_owner = lock.locked_by == current_user.username
    if not is_owner and current_user.role != UserRole.ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins and the lock holder can force-unlock",
        )

    former_holder = lock.locked_by
    session.delete(lock)
    session.commit()

    logger.info(
        f"Lock force-released: {_companion_audit_fields(user_id=current_user.id, username=current_user.username, connection_id=connection_id, path=path, lock_id=lock.id, operation_id=lock.operation_id, former_holder=former_holder)}"
    )
    return {"status": "ok"}


# ──────────────────────────────────────────────────────────────────────────────
# 4. Lock status query (for web UI)
# ──────────────────────────────────────────────────────────────────────────────


@router.get("/{connection_id}/lock-status", response_model=LockStatusResponse)
async def get_lock_status(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to check"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> LockStatusResponse:
    """Check whether a file is currently locked for editing.

    Used by the web UI to show lock indicators in the file browser.
    """

    set_user(current_user.username)

    lock = _get_active_lock(connection_id, path, session)
    if not lock:
        return LockStatusResponse(
            lock_id=None,
            operation_id=None,
            locked_by_current_user=False,
            lock_active=False,
            expires_in=0,
        )

    return LockStatusResponse(
        lock_id=str(lock.id),
        operation_id=lock.operation_id,
        locked_by_current_user=lock.locked_by == current_user.username,
        lock_active=True,
        expires_in=_lock_expires_in_seconds(lock),
    )


# ──────────────────────────────────────────────────────────────────────────────
# 5. Companion download metadata for Sambee
# ──────────────────────────────────────────────────────────────────────────────


@router.get("/downloads", response_model=CompanionDownloadMetadataResponse)
async def get_companion_downloads(
    current_user: User = Depends(get_current_user_with_auth_check),
) -> CompanionDownloadMetadataResponse:
    """Resolve Companion installer metadata for the Sambee frontend."""

    set_user(current_user.username)

    try:
        metadata = resolve_companion_download_metadata()
    except CompanionDownloadResolutionError as error:
        logger.warning(f"Failed to resolve companion downloads for user={current_user.username}: {error}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(error),
        ) from error

    return CompanionDownloadMetadataResponse(
        source=metadata.source,
        version=metadata.version,
        published_at=metadata.published_at,
        notes=metadata.notes,
        assets=metadata.assets,
    )


# ──────────────────────────────────────────────────────────────────────────────
# 6. Version compatibility check
# ──────────────────────────────────────────────────────────────────────────────

# Minimum companion version that this backend supports
MIN_COMPANION_VERSION = "0.1.0"

# Latest companion version available (updated during releases)
LATEST_COMPANION_VERSION = "0.1.0"


@router.get("/version-check", response_model=VersionCheckResponse)
async def version_check(
    companion_version: str = Query(..., description="Companion app version"),
) -> VersionCheckResponse:
    """Check companion version compatibility with this backend.

    The companion calls this on startup to verify it can work with this
    backend version and to check for available updates.
    """

    compatible = _is_version_compatible(companion_version, MIN_COMPANION_VERSION)

    if not compatible:
        logger.warning(f"Incompatible companion version: {companion_version} (minimum: {MIN_COMPANION_VERSION})")

    return VersionCheckResponse(
        compatible=compatible,
        min_companion_version=MIN_COMPANION_VERSION,
        latest_version=LATEST_COMPANION_VERSION,
    )


#
# _is_version_compatible
#
def _is_version_compatible(version: str, min_version: str) -> bool:
    """Check if a version string meets the minimum requirement.

    Simple semver comparison (major.minor.patch).  Returns True if
    *version* >= *min_version*.
    """

    try:
        v_parts = [int(p) for p in version.split(".")]
        m_parts = [int(p) for p in min_version.split(".")]
        return v_parts >= m_parts
    except (ValueError, AttributeError):
        return False
