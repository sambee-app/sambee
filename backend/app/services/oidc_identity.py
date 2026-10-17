import json
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import StrEnum
from typing import cast

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.core.usernames import is_username_collision, username_key
from app.models.oidc import (
    OidcAdmissionMode,
    OidcIdentity,
    OidcPendingIdentityMapping,
    OidcProviderConfiguration,
    OidcRoleAssignmentMode,
)
from app.models.user import User, UserRole
from app.services.audit import (
    AuditDetails,
    AuditEventName,
    AuditResult,
    diagnostic_subject_hash,
    write_audit_event,
)
from app.services.oidc_client import NormalizedOidcClaims
from app.services.oidc_configuration import normalize_group_key


class OidcIdentityErrorCode(StrEnum):
    NOT_ADMITTED = "oidc_not_admitted"
    NO_ROLE_ASSIGNMENT = "oidc_no_role_assignment"
    USERNAME_COLLISION = "oidc_username_collision"
    ACCOUNT_UNAVAILABLE = "oidc_account_unavailable"
    LAST_ADMIN_ROLE_CONFLICT = "oidc_last_administrator_role_conflict"
    LAST_ADMIN_ROLE_CONFLICT_NO_PASSWORD = "oidc_last_administrator_role_conflict_no_password"


class OidcIdentityError(ValueError):
    def __init__(self, code: OidcIdentityErrorCode) -> None:
        super().__init__(code.value)
        self.code = code


@dataclass(frozen=True)
class OidcAccessEvaluation:
    role: UserRole
    matching_admission_group: str | None


def _json_strings(value: str) -> list[str]:
    decoded = json.loads(value)
    if not isinstance(decoded, list) or any(not isinstance(item, str) for item in decoded):
        raise ValueError("Stored OIDC configuration contains an invalid string list")
    return cast(list[str], decoded)


def _role_mappings(value: str) -> dict[str, list[str]]:
    decoded = json.loads(value)
    if not isinstance(decoded, dict) or set(decoded) != {"admin", "editor", "viewer"}:
        raise ValueError("Stored OIDC role mappings are invalid")
    admin = decoded.get("admin")
    editor = decoded.get("editor")
    viewer = decoded.get("viewer")
    if not isinstance(admin, list) or not isinstance(editor, list) or not isinstance(viewer, list):
        raise ValueError("Stored OIDC role mappings are invalid")
    if any(not isinstance(item, str) for item in admin + editor + viewer):
        raise ValueError("Stored OIDC role mappings are invalid")
    return {"admin": cast(list[str], admin), "editor": cast(list[str], editor), "viewer": cast(list[str], viewer)}


def evaluate_oidc_access(
    configuration: OidcProviderConfiguration,
    groups: tuple[str, ...],
    *,
    individual_role: UserRole | None = None,
) -> OidcAccessEvaluation:
    normalized_groups = {normalize_group_key(group) for group in groups}
    configured_admission_groups = _json_strings(configuration.admission_groups_json)
    admission_groups = {normalize_group_key(group) for group in configured_admission_groups}
    mappings = _role_mappings(configuration.role_mappings_json)
    admin_groups = {normalize_group_key(group) for group in mappings["admin"]}
    editor_groups = {normalize_group_key(group) for group in mappings["editor"]}
    viewer_groups = {normalize_group_key(group) for group in mappings["viewer"]}

    if configuration.admission_mode == OidcAdmissionMode.SELECTED_GROUPS and not groups:
        raise OidcIdentityError(OidcIdentityErrorCode.NOT_ADMITTED)
    if configuration.admission_mode == OidcAdmissionMode.SELECTED_GROUPS and not normalized_groups.intersection(admission_groups):
        raise OidcIdentityError(OidcIdentityErrorCode.NOT_ADMITTED)
    matching_admission_group = (
        next(
            (group for group in configured_admission_groups if normalize_group_key(group) in normalized_groups),
            None,
        )
        if configuration.admission_mode == OidcAdmissionMode.SELECTED_GROUPS
        else None
    )
    if individual_role is not None:
        return OidcAccessEvaluation(role=individual_role, matching_admission_group=matching_admission_group)
    if configuration.role_assignment_mode == OidcRoleAssignmentMode.UNIFORM:
        return OidcAccessEvaluation(role=configuration.uniform_role, matching_admission_group=matching_admission_group)
    if not groups:
        raise OidcIdentityError(OidcIdentityErrorCode.NO_ROLE_ASSIGNMENT)
    if normalized_groups.intersection(admin_groups):
        return OidcAccessEvaluation(role=UserRole.ADMIN, matching_admission_group=matching_admission_group)
    if normalized_groups.intersection(editor_groups):
        return OidcAccessEvaluation(role=UserRole.EDITOR, matching_admission_group=matching_admission_group)
    if normalized_groups.intersection(viewer_groups):
        return OidcAccessEvaluation(role=UserRole.VIEWER, matching_admission_group=matching_admission_group)
    raise OidcIdentityError(OidcIdentityErrorCode.NO_ROLE_ASSIGNMENT)


def resolve_oidc_role(
    configuration: OidcProviderConfiguration,
    groups: tuple[str, ...],
    *,
    individual_role: UserRole | None = None,
) -> UserRole:
    return evaluate_oidc_access(configuration, groups, individual_role=individual_role).role


def _is_unexpired(user: User, now: datetime) -> bool:
    if user.expires_at is None:
        return True
    expires_at = user.expires_at.replace(tzinfo=timezone.utc) if user.expires_at.tzinfo is None else user.expires_at
    return expires_at > now


def _has_other_active_admin(session: Session, user_id: object, now: datetime) -> bool:
    administrators = session.exec(
        select(User).where(User.role == UserRole.ADMIN, User.is_active == True, User.id != user_id)  # noqa: E712
    ).all()
    return any(_is_unexpired(user, now) for user in administrators)


def _ensure_existing_user_sync_allowed(
    session: Session,
    *,
    user: User,
    role: UserRole,
    configuration: OidcProviderConfiguration,
    now: datetime,
    correlation_id: str | None,
) -> None:
    if not user.is_active or not _is_unexpired(user, now):
        raise OidcIdentityError(OidcIdentityErrorCode.ACCOUNT_UNAVAILABLE)
    if user.role == UserRole.ADMIN and role != UserRole.ADMIN and not _has_other_active_admin(session, user.id, now):
        user.token_version += 1
        session.add(user)
        write_audit_event(
            session,
            event_name=AuditEventName.USER_ROLE_SYNC_BLOCKED,
            result=AuditResult.BLOCKED,
            details=AuditDetails(selected_role=role.value, local_password_exists=user.password_hash is not None),
            affected_user_id=user.id,
            provider_configuration_id=configuration.id,
            correlation_id=correlation_id,
        )
        session.commit()
        code = (
            OidcIdentityErrorCode.LAST_ADMIN_ROLE_CONFLICT
            if user.password_hash is not None
            else OidcIdentityErrorCode.LAST_ADMIN_ROLE_CONFLICT_NO_PASSWORD
        )
        raise OidcIdentityError(code)


def _sync_existing_user(
    session: Session,
    *,
    user: User,
    identity: OidcIdentity,
    claims: NormalizedOidcClaims,
    role: UserRole,
    configuration: OidcProviderConfiguration,
    now: datetime,
    correlation_id: str | None,
) -> User:
    _ensure_existing_user_sync_allowed(
        session,
        user=user,
        role=role,
        configuration=configuration,
        now=now,
        correlation_id=correlation_id,
    )

    if user.role != role:
        previous_role = user.role
        user.role = role
        user.token_version += 1
        write_audit_event(
            session,
            event_name=AuditEventName.USER_ROLE_CHANGED,
            result=AuditResult.SUCCEEDED,
            details=AuditDetails(selected_role=role.value, changed_fields=(previous_role.value, role.value)),
            affected_user_id=user.id,
            provider_configuration_id=configuration.id,
            correlation_id=correlation_id,
        )
    if claims.name is not None:
        user.name = claims.name.strip() or user.name
    if claims.email is not None:
        user.email = claims.email.strip().lower() or user.email
    user.updated_at = now
    identity.last_seen_username = claims.username.strip()
    identity.last_groups_json = json.dumps(claims.groups)
    identity.last_login_at = now
    session.add(user)
    session.add(identity)
    return user


def _replace_user_identity(
    session: Session,
    *,
    user: User,
    claims: NormalizedOidcClaims,
    current_time: datetime,
) -> OidcIdentity:
    for previous_identity in session.exec(select(OidcIdentity).where(OidcIdentity.user_id == user.id)).all():
        session.delete(previous_identity)
    session.flush()
    identity = OidcIdentity(
        user_id=user.id,
        issuer=claims.issuer,
        subject=claims.subject,
        last_seen_username=claims.username.strip(),
        last_groups_json=json.dumps(claims.groups),
        last_login_at=current_time,
    )
    session.add(identity)
    return identity


def _cancel_user_pending_mappings(session: Session, user: User) -> None:
    for pending_mapping in session.exec(
        select(OidcPendingIdentityMapping).where(OidcPendingIdentityMapping.target_user_id == user.id)
    ).all():
        session.delete(pending_mapping)


def resolve_or_provision_oidc_user(
    session: Session,
    *,
    configuration: OidcProviderConfiguration,
    claims: NormalizedOidcClaims,
    correlation_id: str | None = None,
    now: datetime | None = None,
) -> User:
    current_time = now or datetime.now(timezone.utc)
    username = claims.username.strip()
    if not username:
        raise OidcIdentityError(OidcIdentityErrorCode.USERNAME_COLLISION)
    identity = session.exec(
        select(OidcIdentity).where(OidcIdentity.issuer == claims.issuer, OidcIdentity.subject == claims.subject)
    ).first()
    if identity is not None:
        user = session.get(User, identity.user_id)
        if user is None:
            raise OidcIdentityError(OidcIdentityErrorCode.ACCOUNT_UNAVAILABLE)
        role = resolve_oidc_role(configuration, claims.groups, individual_role=user.oidc_role_assignment)
        user = _sync_existing_user(
            session,
            user=user,
            identity=identity,
            claims=claims,
            role=role,
            configuration=configuration,
            now=current_time,
            correlation_id=correlation_id,
        )
        write_audit_event(
            session,
            event_name=AuditEventName.LOGIN_SUCCEEDED,
            result=AuditResult.SUCCEEDED,
            details=AuditDetails(
                username=user.username,
                selected_role=user.role.value,
                subject_hash=diagnostic_subject_hash(claims.issuer, claims.subject),
            ),
            affected_user_id=user.id,
            provider_configuration_id=configuration.id,
            correlation_id=correlation_id,
        )
        session.commit()
        session.refresh(user)
        return user

    pending = session.exec(
        select(OidcPendingIdentityMapping).where(
            OidcPendingIdentityMapping.provider_configuration_id == configuration.id,
            OidcPendingIdentityMapping.expected_username == username,
        )
    ).first()
    if pending is not None:
        user = session.get(User, pending.target_user_id)
        if user is None or not user.is_active or not _is_unexpired(user, current_time):
            raise OidcIdentityError(OidcIdentityErrorCode.ACCOUNT_UNAVAILABLE)
        role = resolve_oidc_role(configuration, claims.groups, individual_role=user.oidc_role_assignment)
        _ensure_existing_user_sync_allowed(
            session,
            user=user,
            role=role,
            configuration=configuration,
            now=current_time,
            correlation_id=correlation_id,
        )
        identity = _replace_user_identity(session, user=user, claims=claims, current_time=current_time)
        session.delete(pending)
        configuration.identity_mapping_revision += 1
        session.add(configuration)
        token_version_before_mapping = user.token_version
        user = _sync_existing_user(
            session,
            user=user,
            identity=identity,
            claims=claims,
            role=role,
            configuration=configuration,
            now=current_time,
            correlation_id=correlation_id,
        )
        if user.token_version == token_version_before_mapping:
            user.token_version += 1
            session.add(user)
        write_audit_event(
            session,
            event_name=AuditEventName.IDENTITY_MAPPED,
            result=AuditResult.SUCCEEDED,
            details=AuditDetails(username=user.username, selected_role=role.value),
            affected_user_id=user.id,
            provider_configuration_id=configuration.id,
            correlation_id=correlation_id,
        )
    else:
        user = session.exec(select(User).where(User.username == username)).first()
        if user is not None:
            if not configuration.auto_link_by_username:
                raise OidcIdentityError(OidcIdentityErrorCode.USERNAME_COLLISION)
            role = resolve_oidc_role(configuration, claims.groups, individual_role=user.oidc_role_assignment)
            _ensure_existing_user_sync_allowed(
                session,
                user=user,
                role=role,
                configuration=configuration,
                now=current_time,
                correlation_id=correlation_id,
            )
            identity = _replace_user_identity(session, user=user, claims=claims, current_time=current_time)
            _cancel_user_pending_mappings(session, user)
            configuration.identity_mapping_revision += 1
            session.add(configuration)
            token_version_before_relink = user.token_version
            user = _sync_existing_user(
                session,
                user=user,
                identity=identity,
                claims=claims,
                role=role,
                configuration=configuration,
                now=current_time,
                correlation_id=correlation_id,
            )
            if user.token_version == token_version_before_relink:
                user.token_version += 1
                session.add(user)
            write_audit_event(
                session,
                event_name=AuditEventName.IDENTITY_RELINKED,
                result=AuditResult.SUCCEEDED,
                details=AuditDetails(
                    username=user.username,
                    selected_role=role.value,
                    subject_hash=diagnostic_subject_hash(claims.issuer, claims.subject),
                ),
                affected_user_id=user.id,
                provider_configuration_id=configuration.id,
                correlation_id=correlation_id,
            )
        else:
            if session.exec(select(User).where(User.username_key == username_key(username))).first() is not None:
                raise OidcIdentityError(OidcIdentityErrorCode.USERNAME_COLLISION)
            role = resolve_oidc_role(configuration, claims.groups)
            user = User(
                username=username,
                name=claims.name,
                email=claims.email,
                password_hash=None,
                must_change_password=False,
                role=role,
                is_active=True,
            )
            session.add(user)
            try:
                session.flush()
            except IntegrityError as error:
                session.rollback()
                if is_username_collision(error):
                    raise OidcIdentityError(OidcIdentityErrorCode.USERNAME_COLLISION) from error
                raise
            identity = OidcIdentity(
                user_id=user.id,
                issuer=claims.issuer,
                subject=claims.subject,
                last_seen_username=username,
                last_groups_json=json.dumps(claims.groups),
                last_login_at=current_time,
            )
            session.add(identity)
            configuration.identity_mapping_revision += 1
            session.add(configuration)
            write_audit_event(
                session,
                event_name=AuditEventName.USER_PROVISIONED,
                result=AuditResult.SUCCEEDED,
                details=AuditDetails(username=user.username, selected_role=role.value),
                affected_user_id=user.id,
                provider_configuration_id=configuration.id,
                correlation_id=correlation_id,
            )
    write_audit_event(
        session,
        event_name=AuditEventName.LOGIN_SUCCEEDED,
        result=AuditResult.SUCCEEDED,
        details=AuditDetails(
            username=user.username,
            selected_role=user.role.value,
            subject_hash=diagnostic_subject_hash(claims.issuer, claims.subject),
        ),
        affected_user_id=user.id,
        provider_configuration_id=configuration.id,
        correlation_id=correlation_id,
    )
    session.commit()
    session.refresh(user)
    return user
