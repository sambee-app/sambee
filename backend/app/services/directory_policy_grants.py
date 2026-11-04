"""Separate-purpose, single-use policy grants with current administrator checks."""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from joserfc.errors import JoseError
from sqlalchemy import delete, func, update
from sqlmodel import Session, col, select

from app.core.authorization import Capability, user_has_capability
from app.core.config import settings
from app.core.directory_index_contract import (
    DIRECTORY_POLICY_GRANT_SECONDS,
    DIRECTORY_POLICY_TOKEN_CLAIM,
    DIRECTORY_POLICY_TOKEN_CLASS,
    DIRECTORY_POLICY_TOKEN_PURPOSE,
    MAX_DIRECTORY_POLICY_GRANTS,
    MAX_DIRECTORY_POLICY_GRANTS_PER_USER,
)
from app.core.security import create_access_token, decode_access_token, is_user_expired
from app.core.system_setting_definitions import DirectoryIndexPolicyScope
from app.models.companion_settings import SettingsGrantBinding, SettingsGrantRead, SettingsGrantRedeem, SettingsReceipt
from app.models.companion_uri_token_jti import CompanionDirectoryPolicyGrant
from app.models.system_settings import (
    DirectoryPolicyGrantBinding,
    DirectoryPolicyGrantRead,
    DirectoryPolicyGrantReceipt,
    DirectoryPolicyGrantRedeem,
)
from app.models.user import User
from app.services.system_settings import build_directory_index_settings_read


def backend_policy_identity() -> str:
    if not settings.secret_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Policy signing is unavailable. Check backend secret initialization."
        )
    return hashlib.sha256((DIRECTORY_POLICY_TOKEN_PURPOSE + ":" + settings.secret_key).encode("utf-8")).hexdigest()


def _administrator(session: Session, user_id: uuid.UUID) -> User:
    user = session.get(User, user_id, populate_existing=True)
    if user is None or not user.is_active or is_user_expired(user) or not user_has_capability(user, Capability.ACCESS_ADMIN_SETTINGS):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Policy approval is no longer authorized. Sign in as a current administrator and request a new grant.",
        )
    return user


def _delivery_user(session: Session, user_id: uuid.UUID) -> User:
    user = session.get(User, user_id, populate_existing=True)
    if user is None or not user.is_active or is_user_expired(user):
        raise HTTPException(status_code=403, detail="Companion delivery is no longer authorized. Sign in with an active account.")
    return user


def issue_directory_policy_grant(
    binding: DirectoryPolicyGrantBinding, administrator: User, session: Session, *, browser_session_id: uuid.UUID | None = None
) -> DirectoryPolicyGrantRead | SettingsGrantRead:
    shared = isinstance(binding, SettingsGrantBinding)
    user = _delivery_user(session, administrator.id) if shared else _administrator(session, administrator.id)
    now = datetime.now(timezone.utc)
    session.exec(delete(CompanionDirectoryPolicyGrant).where(col(CompanionDirectoryPolicyGrant.expires_at) <= now))
    count = session.exec(select(func.count()).select_from(CompanionDirectoryPolicyGrant)).one()
    if count >= MAX_DIRECTORY_POLICY_GRANTS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Companion grant capacity is temporarily full. Wait one minute and request a new grant.",
        )
    user_count = session.exec(
        select(func.count()).select_from(CompanionDirectoryPolicyGrant).where(col(CompanionDirectoryPolicyGrant.user_id) == user.id)
    ).one()
    if user_count >= MAX_DIRECTORY_POLICY_GRANTS_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Your Companion grant limit was reached. Wait one minute and request a new grant.",
        )
    policy = build_directory_index_settings_read(DirectoryIndexPolicyScope.COMPANION, session)
    identity = backend_policy_identity()
    jti = uuid.uuid4()
    expires = now + timedelta(seconds=DIRECTORY_POLICY_GRANT_SECONDS)
    section_claims: dict[str, object] = {}
    if isinstance(binding, SettingsGrantBinding):
        from app.services.companion_settings import build_settings_metadata

        metadata = build_settings_metadata(user, session)
        section_claims = {
            "settings_version": binding.version,
            "sections": {name: getattr(metadata, name).model_dump() for name in set(binding.sections)},
            "switch_user": binding.switch_user,
            "browser_session_id": str(browser_session_id) if browser_session_id else None,
        }
    token = create_access_token(
        data={
            **section_claims,
            "sub": str(user.id),
            "jti": str(jti),
            "token_class": DIRECTORY_POLICY_TOKEN_CLASS,
            "purpose": DIRECTORY_POLICY_TOKEN_PURPOSE,
            DIRECTORY_POLICY_TOKEN_CLAIM: True,
            "scope": DirectoryIndexPolicyScope.COMPANION.value,
            "companion_id": str(binding.companion_id),
            "challenge": binding.challenge,
            "origin": binding.origin,
            "backend_identity": identity,
            "revision": policy.revision,
            "token_version": user.token_version,
        },
        expires_delta=timedelta(seconds=DIRECTORY_POLICY_GRANT_SECONDS),
    )
    session.add(
        CompanionDirectoryPolicyGrant(
            jti=jti,
            user_id=user.id,
            companion_id=binding.companion_id,
            challenge=binding.challenge,
            origin=binding.origin,
            backend_identity=identity,
            revision=policy.revision,
            token_version=user.token_version,
            expires_at=expires,
        )
    )
    session.commit()
    if shared:
        return SettingsGrantRead(**metadata.model_dump(), grant=token, expires_in_seconds=DIRECTORY_POLICY_GRANT_SECONDS)
    return DirectoryPolicyGrantRead(
        grant=token, expires_in_seconds=DIRECTORY_POLICY_GRANT_SECONDS, revision=policy.revision, backend_identity=identity
    )


def redeem_directory_policy_grant(binding: DirectoryPolicyGrantRedeem, session: Session) -> DirectoryPolicyGrantReceipt | SettingsReceipt:
    try:
        claims = decode_access_token(binding.grant)
        if claims is None:
            raise ValueError("Missing policy claims")
        jti = uuid.UUID(str(claims.get("jti")))
    except (JoseError, ValueError, TypeError) as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Companion grant is invalid or expired. Request a new grant."
        ) from error
    identity = backend_policy_identity()
    shared = isinstance(binding, SettingsGrantRedeem)
    if shared != (claims.get("settings_version") == 1):
        raise HTTPException(status_code=426, detail="Companion settings protocol changed. Update the browser and Companion, then retry.")
    if (
        claims.get("token_class") != DIRECTORY_POLICY_TOKEN_CLASS
        or claims.get("purpose") != DIRECTORY_POLICY_TOKEN_PURPOSE
        or claims.get(DIRECTORY_POLICY_TOKEN_CLAIM) is not True
        or claims.get("scope") != DirectoryIndexPolicyScope.COMPANION.value
        or claims.get("companion_id") != str(binding.companion_id)
        or claims.get("challenge") != binding.challenge
        or claims.get("origin") != binding.origin
        or claims.get("backend_identity") != identity
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Companion grant does not match this Companion, challenge, or origin. Request a new grant.",
        )
    record = session.get(CompanionDirectoryPolicyGrant, jti, populate_existing=True)
    now = datetime.now(timezone.utc)
    if record is None or record.consumed_at is not None or record.expires_at.replace(tzinfo=timezone.utc) <= now:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Companion grant was used or expired. Request a new grant.")
    if (
        record.companion_id != binding.companion_id
        or record.challenge != binding.challenge
        or record.origin != binding.origin
        or record.backend_identity != identity
        or claims.get("sub") != str(record.user_id)
        or type(claims.get("revision")) is not int
        or claims.get("revision") != record.revision
        or type(claims.get("token_version")) is not int
        or claims.get("token_version") != record.token_version
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Companion grant binding is invalid. Request a new grant.")
    user = _delivery_user(session, record.user_id) if shared else _administrator(session, record.user_id)
    if user.token_version != record.token_version:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="User credentials changed. Sign in again and request a new Companion grant."
        )
    if shared and claims.get("browser_session_id") is not None:
        from app.models.oidc import OidcBrowserSession
        from app.services.oidc_browser_session import OidcBrowserSessionError, validate_browser_session

        try:
            browser_session_id = uuid.UUID(str(claims["browser_session_id"]))
            browser_session = session.get(OidcBrowserSession, browser_session_id, populate_existing=True)
            if browser_session is None:
                raise ValueError("Session no longer exists")
            validate_browser_session(session, browser_session=browser_session, expected_user_id=user.id, allow_refresh_uncertain=True)
        except (ValueError, OidcBrowserSessionError) as error:
            raise HTTPException(
                status_code=403, detail="The issuing sign-in session is no longer valid. Sign in again and retry delivery."
            ) from error
    current = build_directory_index_settings_read(DirectoryIndexPolicyScope.COMPANION, session)
    receipt = None
    if shared:
        from app.services.companion_settings import build_settings_sections

        theme, localization, directory = build_settings_sections(user, session)
        available = {"theme": theme, "localization": localization, "directory_index": directory}
        selected = claims.get("sections")
        if (
            not isinstance(selected, dict)
            or not selected
            or not set(selected).issubset(available)
            or type(claims.get("switch_user")) is not bool
        ):
            raise HTTPException(status_code=403, detail="Settings grant sections are invalid. Request a new Companion grant.")
        for name, marker in selected.items():
            if marker != available[name].model_dump(exclude={"payload"}):
                raise HTTPException(status_code=409, detail="Companion settings changed during delivery. Request a new grant.")
        receipt = SettingsReceipt(
            companion_id=binding.companion_id,
            challenge=binding.challenge,
            origin=binding.origin,
            backend_identity=identity,
            switch_user=claims["switch_user"],
            theme=theme if "theme" in selected else None,
            localization=localization if "localization" in selected else None,
            directory_index=directory if "directory_index" in selected else None,
        )
    elif current.revision != record.revision:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Companion policy changed. Request a new approval grant for the current revision."
        )
    consumed = session.execute(
        update(CompanionDirectoryPolicyGrant)
        .where(
            col(CompanionDirectoryPolicyGrant.jti) == jti,
            col(CompanionDirectoryPolicyGrant.consumed_at).is_(None),
            col(CompanionDirectoryPolicyGrant.expires_at) > now,
        )
        .values(consumed_at=now)
        .returning(col(CompanionDirectoryPolicyGrant.jti))
    ).first()
    if consumed is None:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Companion grant was used or expired. Request a new grant.")
    session.commit()
    if receipt is not None:
        return receipt
    return DirectoryPolicyGrantReceipt(
        companion_id=binding.companion_id,
        challenge=binding.challenge,
        origin=binding.origin,
        backend_identity=identity,
        revision=current.revision,
        policy=current.policy,
    )
