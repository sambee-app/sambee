import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.fernet import Fernet
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from joserfc import jwt
from joserfc.errors import JoseError
from joserfc.jwk import OctKey
from joserfc.jwt import JWTClaimsRegistry
from sqlmodel import Session, select

from app.core.authorization import Capability, user_has_capability
from app.core.config import settings, static
from app.core.exceptions import ConfigurationError
from app.core.logging import get_logger
from app.db.database import get_session
from app.models.user import User
from app.services.authentication_config import get_effective_authentication_mode, is_password_change_available

logger = get_logger(__name__)

_COMPANION_URI_TOKEN_CLAIM = "companion_uri"
_COMPANION_SESSION_TOKEN_CLAIM = "companion_session"
_COMPANION_SESSION_TOKEN_CLASS = "companion_session"

# Use argon2-cffi directly instead of passlib to avoid deprecation warnings
_password_hasher = PasswordHasher()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")

# OAuth2 scheme that doesn't auto-error on missing tokens
# Used for endpoints that need to handle both password and 'none' auth methods
oauth2_scheme_optional = OAuth2PasswordBearer(tokenUrl="/api/auth/token", auto_error=False)

# Fernet cipher for password encryption (initialized lazily)
_fernet: Fernet | None = None


@dataclass(frozen=True)
class BrowserAuthentication:
    user: User
    token_version_current: bool
    oidc_browser_session_id: uuid.UUID | None = None
    authentication_enforced: bool = True


def password_change_required(authentication: BrowserAuthentication, session: Session) -> bool:
    return (
        authentication.authentication_enforced
        and authentication.oidc_browser_session_id is None
        and authentication.user.password_hash is not None
        and authentication.user.must_change_password
        and is_password_change_available(session)
    )


def require_password_change_completed(authentication: BrowserAuthentication, session: Session) -> None:
    if password_change_required(authentication, session):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"code": "password_change_required"})


def is_user_expired(user: User, now: datetime | None = None) -> bool:
    expires_at = user.expires_at
    if expires_at is None:
        return False

    current_time = now or datetime.now(timezone.utc)
    expires_at_utc = expires_at.replace(tzinfo=timezone.utc) if expires_at.tzinfo is None else expires_at.astimezone(timezone.utc)
    return expires_at_utc <= current_time


def _build_credentials_exception(detail: str = "Could not validate credentials") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _build_oidc_reauthentication_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": "oidc_reauthentication_required"},
        headers={"WWW-Authenticate": "Bearer"},
    )


def _ensure_user_is_current(user: User | None, failure_exception: HTTPException) -> User:
    if user is None:
        raise failure_exception

    if not user.is_active:
        logger.info(f"Rejected inactive user during auth validation: username={user.username}")
        raise failure_exception

    if is_user_expired(user):
        logger.info(f"Rejected expired user during auth validation: username={user.username}")
        raise failure_exception

    return user


def _reject_non_browser_token(payload: dict[str, Any], failure_exception: HTTPException) -> None:
    if payload.get(_COMPANION_URI_TOKEN_CLAIM):
        raise failure_exception

    if payload.get(_COMPANION_SESSION_TOKEN_CLAIM) or payload.get("token_class") == _COMPANION_SESSION_TOKEN_CLASS:
        raise failure_exception


#
# get_fernet
#
def get_fernet() -> Fernet:
    """
    Get or initialize the Fernet cipher.

    Lazy initialization ensures encryption_key is loaded from database first.
    """
    global _fernet
    if _fernet is None:
        if not settings.encryption_key:
            raise ConfigurationError("Encryption key not loaded from database yet")
        _fernet = Fernet(settings.encryption_key.encode())
    return _fernet


#
# verify_password
#
def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a plain password against a hashed password."""

    try:
        _password_hasher.verify(hashed_password, plain_password)
        return True
    except VerifyMismatchError:
        return False


#
# get_password_hash
#
def get_password_hash(password: str) -> str:
    """Hash a password for storage."""

    return _password_hasher.hash(password)


#
# encrypt_password
#
def encrypt_password(password: str) -> str:
    """Encrypt password for storage"""

    try:
        return get_fernet().encrypt(password.encode()).decode()
    except Exception as e:
        raise ConfigurationError(f"Failed to encrypt password: {e}") from e


#
# decrypt_password
#
def decrypt_password(encrypted_password: str) -> str:
    """Decrypt stored password"""

    try:
        return get_fernet().decrypt(encrypted_password.encode()).decode()
    except Exception as e:
        raise ConfigurationError(f"Failed to decrypt password. Data may be corrupted or encryption key changed: {e}") from e


#
# create_access_token
#
def create_access_token(data: dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT access token"""

    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    return jwt.encode(
        {"alg": static.algorithm},
        to_encode,
        OctKey.import_key(settings.secret_key),
        algorithms=[static.algorithm],
    )


def decode_access_token(token: str) -> dict[str, Any]:
    """Decode and validate a locally issued JWT."""

    decoded = jwt.decode(
        token,
        OctKey.import_key(settings.secret_key),
        algorithms=[static.algorithm],
    )
    claims = dict(decoded.claims)
    JWTClaimsRegistry().validate(claims)
    return claims


def build_user_access_token(
    user: User,
    expires_delta: Optional[timedelta] = None,
    *,
    oidc_browser_session_id: uuid.UUID | None = None,
) -> str:
    claims: dict[str, Any] = {
        "sub": str(user.id),
        "tv": user.token_version,
    }
    if oidc_browser_session_id is not None:
        claims["sid"] = str(oidc_browser_session_id)
    return create_access_token(
        data=claims,
        expires_delta=expires_delta,
    )


def _get_user_from_subject(subject: str, session: Session) -> User | None:
    try:
        user_id = uuid.UUID(subject)
        return session.get(User, user_id)
    except ValueError:
        statement = select(User).where(User.username == subject)
        return session.exec(statement).first()


#
# get_current_user
#
async def get_current_user(token: str = Depends(oauth2_scheme), session: Session = Depends(get_session)) -> User:
    """Get the current authenticated user from token"""

    authentication = _authenticate_browser_token(token, session)
    if not authentication.token_version_current:
        raise _build_credentials_exception()
    require_password_change_completed(authentication, session)
    return authentication.user


def _authenticate_browser_token(token: str, session: Session) -> BrowserAuthentication:
    """Validate a browser JWT while reporting token-version freshness separately."""

    credentials_exception = _build_credentials_exception()

    try:
        payload = decode_access_token(token)
        subject: str | None = payload.get("sub")
        if subject is None:
            raise credentials_exception
    except JoseError:
        raise credentials_exception

    _reject_non_browser_token(payload, credentials_exception)

    user = _get_user_from_subject(subject, session)
    user = _ensure_user_is_current(user, credentials_exception)

    oidc_browser_session_id: uuid.UUID | None = None
    session_id = payload.get("sid")
    if session_id is not None:
        try:
            from app.models.oidc import OidcBrowserSession
            from app.services.oidc_browser_session import OidcBrowserSessionError, validate_browser_session

            oidc_browser_session_id = uuid.UUID(str(session_id))
            browser_session = session.get(OidcBrowserSession, oidc_browser_session_id)
            if browser_session is None:
                raise _build_oidc_reauthentication_exception()
            validate_browser_session(
                session,
                browser_session=browser_session,
                expected_user_id=user.id,
                allow_refresh_uncertain=True,
            )
        except HTTPException:
            raise
        except (ValueError, OidcBrowserSessionError):
            raise _build_oidc_reauthentication_exception()

    try:
        token_version = int(payload.get("tv", 0))
    except (TypeError, ValueError):
        raise credentials_exception
    return BrowserAuthentication(
        user=user,
        token_version_current=token_version == user.token_version,
        oidc_browser_session_id=oidc_browser_session_id,
    )


async def get_admin_browser_authentication_allowing_stale_token(
    token: Optional[str] = Depends(oauth2_scheme_optional),
    session: Session = Depends(get_session),
) -> BrowserAuthentication:
    """Authenticate an administrator while exposing, but not rejecting, stale token versions."""

    if token:
        authentication = _authenticate_browser_token(token, session)
    else:
        authentication = BrowserAuthentication(
            user=await get_current_user_for_token(token, session),
            token_version_current=True,
        )
    if not user_has_capability(authentication.user, Capability.ACCESS_ADMIN_SETTINGS):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not enough permissions")
    require_password_change_completed(authentication, session)
    return authentication


#
# get_current_user_with_auth_check
#
async def get_current_user_with_auth_check(
    token: Optional[str] = Depends(oauth2_scheme_optional),
    session: Session = Depends(get_session),
) -> User:
    """Get the current authenticated user based on the effective authentication mode.

    Authentication enforcement can be disabled at runtime by configuration, in
    which case requests resolve to the configured administrator without a token.
    """

    return (await get_current_browser_authentication_with_auth_check(token, session)).user


async def get_current_browser_authentication_with_auth_check(
    token: Optional[str] = Depends(oauth2_scheme_optional),
    session: Session = Depends(get_session),
) -> BrowserAuthentication:
    authentication = await get_password_change_authentication(token, session)
    require_password_change_completed(authentication, session)
    return authentication


async def get_password_change_authentication(
    token: Optional[str] = Depends(oauth2_scheme_optional),
    session: Session = Depends(get_session),
) -> BrowserAuthentication:
    """Return the validated browser authentication context for account session views."""

    if get_effective_authentication_mode(session).value == "none":
        return BrowserAuthentication(
            user=await get_current_user_for_token(token, session),
            token_version_current=True,
            authentication_enforced=False,
        )
    if token is None:
        await get_current_user_for_token(token, session)
        raise AssertionError("Missing browser token was not rejected")
    authentication = _authenticate_browser_token(token, session)
    if not authentication.token_version_current:
        raise _build_credentials_exception()
    return authentication


async def get_current_user_for_password_change(
    authentication: BrowserAuthentication = Depends(get_password_change_authentication),
) -> User:
    return authentication.user


async def get_current_user_for_token(token: Optional[str], session: Session) -> User:
    """Resolve the authenticated user for explicit token values.

    This is used by both HTTP dependency-based flows and WebSocket
    authentication where FastAPI dependencies are not available.
    """

    # When enforcement is disabled or the UI-selected mode is none, return the administrator.
    if get_effective_authentication_mode(session).value == "none":
        logger.debug("Authentication is not enforced - returning admin user")
        statement = select(User).where(User.username == settings.admin_username)
        user = session.exec(statement).first()
        if not user:
            # This should not happen if database is properly initialized
            logger.error(f"Admin user '{settings.admin_username}' not found in database")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Authentication configuration error",
            )
        return _ensure_user_is_current(user, _build_credentials_exception(detail="Not authenticated"))

    # All other modes require a valid token.
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Validate JWT token
    return await get_current_user(token=token, session=session)


#
# get_current_admin_user
#
async def get_current_admin_user(
    current_user: User = Depends(get_current_user_with_auth_check),
) -> User:
    """Ensure the current user is an admin"""

    if not user_has_capability(current_user, Capability.ACCESS_ADMIN_SETTINGS):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not enough permissions")
    return current_user


def require_capability(capability: Capability) -> Callable[..., Any]:
    async def dependency(current_user: User = Depends(get_current_user_with_auth_check)) -> User:
        if not user_has_capability(current_user, capability):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not enough permissions")
        return current_user

    return dependency
