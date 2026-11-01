"""Separate-purpose, single-use policy grants with current administrator checks."""

from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from joserfc.errors import JoseError
from sqlalchemy import delete, func
from sqlmodel import Session, col, select

from app.core.authorization import Capability, user_has_capability
from app.core.config import settings
from app.core.directory_index_contract import (
    DIRECTORY_POLICY_GRANT_SECONDS,
    DIRECTORY_POLICY_TOKEN_CLAIM,
    DIRECTORY_POLICY_TOKEN_CLASS,
    DIRECTORY_POLICY_TOKEN_PURPOSE,
    MAX_DIRECTORY_POLICY_GRANTS,
)
from app.core.security import create_access_token, decode_access_token, is_user_expired
from app.core.system_setting_definitions import DirectoryIndexPolicyScope
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


def issue_directory_policy_grant(binding: DirectoryPolicyGrantBinding, administrator: User, session: Session) -> DirectoryPolicyGrantRead:
    user = _administrator(session, administrator.id)
    now = datetime.now(timezone.utc)
    session.exec(delete(CompanionDirectoryPolicyGrant).where(col(CompanionDirectoryPolicyGrant.expires_at) <= now))
    count = session.exec(select(func.count()).select_from(CompanionDirectoryPolicyGrant)).one()
    if count >= MAX_DIRECTORY_POLICY_GRANTS:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Policy approval capacity is temporarily full. Wait one minute and request a new grant.",
        )
    policy = build_directory_index_settings_read(DirectoryIndexPolicyScope.COMPANION, session)
    identity = backend_policy_identity()
    jti = uuid.uuid4()
    expires = now + timedelta(seconds=DIRECTORY_POLICY_GRANT_SECONDS)
    token = create_access_token(
        data={
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
    return DirectoryPolicyGrantRead(
        grant=token, expires_in_seconds=DIRECTORY_POLICY_GRANT_SECONDS, revision=policy.revision, backend_identity=identity
    )


def redeem_directory_policy_grant(binding: DirectoryPolicyGrantRedeem, session: Session) -> DirectoryPolicyGrantReceipt:
    try:
        claims = decode_access_token(binding.grant)
        if claims is None:
            raise ValueError("Missing policy claims")
        jti = uuid.UUID(str(claims.get("jti")))
    except (JoseError, ValueError, TypeError) as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Policy grant is invalid or expired. Request a new approval grant."
        ) from error
    identity = backend_policy_identity()
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
            detail="Policy grant does not match this companion, challenge or origin. Request a new approval grant.",
        )
    record = session.get(CompanionDirectoryPolicyGrant, jti, populate_existing=True)
    now = datetime.now(timezone.utc)
    if record is None or record.consumed_at is not None or record.expires_at.replace(tzinfo=timezone.utc) <= now:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Policy grant was used or expired. Request a new approval grant.")
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
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Policy grant binding is invalid. Request a new approval grant.")
    user = _administrator(session, record.user_id)
    if user.token_version != record.token_version:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Administrator credentials changed. Request a new approval grant."
        )
    current = build_directory_index_settings_read(DirectoryIndexPolicyScope.COMPANION, session)
    if current.revision != record.revision:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Companion policy changed. Request a new approval grant for the current revision."
        )
    record.consumed_at = now
    session.add(record)
    session.commit()
    return DirectoryPolicyGrantReceipt(
        companion_id=binding.companion_id,
        challenge=binding.challenge,
        origin=binding.origin,
        backend_identity=identity,
        revision=current.revision,
        policy=current.policy,
    )
