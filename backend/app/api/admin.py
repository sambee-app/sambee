# mypy: disable-error-code="arg-type, assignment, attr-defined, call-overload, operator, union-attr"

import json
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, case, false, func, not_, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.core.authorization import Capability
from app.core.logging import get_logger, set_user
from app.core.secrets import generate_temporary_password
from app.core.security import get_password_hash, require_capability
from app.core.usernames import USERNAME_COLLISION_MESSAGE, is_username_collision, username_key
from app.db.database import get_session
from app.models.oidc import OidcIdentity, OidcPendingIdentityMapping, OidcProviderConfiguration, OidcRoleAssignmentMode
from app.models.theme import StoredTheme
from app.models.user import (
    AdminUserCreate,
    AdminUserCreateResult,
    AdminUserDirectoryAuthentication,
    AdminUserDirectoryOidcState,
    AdminUserDirectoryRoleSource,
    AdminUserDirectorySort,
    AdminUserDirectoryState,
    AdminUserListResponse,
    AdminUserListSummary,
    AdminUserOidcRead,
    AdminUserPasswordReset,
    AdminUserPasswordResetResult,
    AdminUserPendingOidcRead,
    AdminUserRead,
    AdminUserUpdate,
    SortDirection,
    User,
    UserRole,
    build_admin_user_read,
)
from app.models.user_settings import UserSetting
from app.services.audit import AuditDetails, AuditEventName, AuditResult, write_audit_event
from app.services.authentication_config import is_local_password_management_available
from app.services.oidc_identity import OidcIdentityError, resolve_oidc_role
from app.services.oidc_mapping import OidcMappingError, remove_user_oidc_state

router = APIRouter()
logger = get_logger(__name__)
OIDC_INHERITED_ROLE_UNAVAILABLE_DETAIL = "The inherited OIDC role is unavailable until the user signs in with OIDC"
OIDC_MANAGED_IDENTITY_FIELDS_DETAIL = "Full name and email are managed by OIDC"
USER_DIRECTORY_EXPIRING_SOON_DAYS = 30
USER_DIRECTORY_DEFAULT_PAGE_SIZE = 25
USER_DIRECTORY_MAX_PAGE_SIZE = 100


def _commit_user_change(session: Session) -> None:
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        if is_username_collision(error):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=USERNAME_COLLISION_MESSAGE) from error
        raise


def _username_conflicts(session: Session) -> list[list[str]]:
    duplicate_keys = select(User.username_key).group_by(User.username_key).having(func.count() > 1)
    users = session.exec(select(User).where(User.username_key.in_(duplicate_keys)).order_by(User.username_key, User.username)).all()
    groups: dict[str, list[str]] = {}
    for user in users:
        groups.setdefault(user.username_key, []).append(user.username)
    return list(groups.values())


def _count_active_admins(session: Session) -> int:
    admins = session.exec(select(User).where(User.role == UserRole.ADMIN)).all()
    return sum(1 for user in admins if user.is_active)


def _validate_user_update_guards(
    *,
    actor: User,
    target: User,
    session: Session,
    next_role: UserRole,
    next_is_active: bool,
    is_delete: bool = False,
) -> None:
    if target.id == actor.id and (is_delete or next_role != UserRole.ADMIN or not next_is_active):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot remove your own admin access")

    if target.role == UserRole.ADMIN and target.is_active and (is_delete or next_role != UserRole.ADMIN or not next_is_active):
        if _count_active_admins(session) <= 1:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot remove the last active admin")


def _resolve_inherited_oidc_role(configuration: OidcProviderConfiguration, identity: OidcIdentity) -> UserRole | None:
    try:
        groups = json.loads(identity.last_groups_json)
        if not isinstance(groups, list) or any(not isinstance(group, str) for group in groups):
            return None
        return resolve_oidc_role(configuration, tuple(groups))
    except (json.JSONDecodeError, OidcIdentityError, ValueError):
        return None


def _read_last_oidc_groups(identity: OidcIdentity) -> list[str]:
    try:
        groups = json.loads(identity.last_groups_json)
    except json.JSONDecodeError:
        return []
    return groups if isinstance(groups, list) and all(isinstance(group, str) for group in groups) else []


def _build_admin_user_reads_with_authentication(session: Session, users: list[User]) -> list[AdminUserRead]:
    if not users:
        return []

    configuration = session.get(OidcProviderConfiguration, 1)
    if configuration is None:
        return [build_admin_user_read(user) for user in users]

    user_ids = [user.id for user in users]
    identities = session.exec(select(OidcIdentity).where(OidcIdentity.user_id.in_(user_ids)).order_by(OidcIdentity.created_at.desc())).all()
    pending_mappings = session.exec(
        select(OidcPendingIdentityMapping).where(
            OidcPendingIdentityMapping.provider_configuration_id == configuration.id,
            OidcPendingIdentityMapping.target_user_id.in_(user_ids),
        )
    ).all()

    active_identity_by_user_id: dict[uuid.UUID, OidcIdentity] = {}
    fallback_identity_by_user_id: dict[uuid.UUID, OidcIdentity] = {}
    for identity in identities:
        fallback_identity_by_user_id.setdefault(identity.user_id, identity)
        if identity.issuer == configuration.issuer_url:
            active_identity_by_user_id.setdefault(identity.user_id, identity)

    pending_by_user_id = {mapping.target_user_id: mapping for mapping in pending_mappings}
    creator_ids = {mapping.created_by_user_id for mapping in pending_mappings if mapping.created_by_user_id is not None}
    creators_by_id = (
        {creator.id: creator for creator in session.exec(select(User).where(User.id.in_(creator_ids))).all()} if creator_ids else {}
    )

    results: list[AdminUserRead] = []
    for user in users:
        result = build_admin_user_read(user)
        active_identity = active_identity_by_user_id.get(user.id)
        identity = active_identity or fallback_identity_by_user_id.get(user.id)
        pending = pending_by_user_id.get(user.id)
        creator = creators_by_id.get(pending.created_by_user_id) if pending and pending.created_by_user_id is not None else None
        results.append(
            result.model_copy(
                update={
                    "oidc": (
                        AdminUserOidcRead(
                            identity_id=identity.id,
                            user_id=identity.user_id,
                            provider_display_name=configuration.display_name,
                            issuer=identity.issuer,
                            subject=identity.subject,
                            last_seen_username=identity.last_seen_username,
                            last_groups=_read_last_oidc_groups(identity),
                            created_at=identity.created_at,
                            last_login_at=identity.last_login_at,
                            inherited_role=_resolve_inherited_oidc_role(configuration, active_identity)
                            if active_identity is not None
                            else None,
                        )
                        if identity is not None
                        else None
                    ),
                    "pending_oidc": (
                        AdminUserPendingOidcRead(
                            expected_username=pending.expected_username,
                            created_by_username=creator.username if creator is not None else "Deleted user",
                            created_at=pending.created_at,
                        )
                        if pending is not None
                        else None
                    ),
                }
            )
        )
    return results


def _build_admin_user_read_with_authentication(session: Session, user: User) -> AdminUserRead:
    return _build_admin_user_reads_with_authentication(session, [user])[0]


def _directory_query_predicates(
    *,
    configuration: OidcProviderConfiguration | None,
    query: str | None,
    roles: list[UserRole],
    states: list[AdminUserDirectoryState],
    authentication: list[AdminUserDirectoryAuthentication],
    oidc_states: list[AdminUserDirectoryOidcState],
    role_sources: list[AdminUserDirectoryRoleSource],
    expiration: str | None,
) -> tuple[list[object], object, object]:
    now = datetime.now(timezone.utc)
    expiring_soon_at = now.replace(microsecond=0) + timedelta(days=USER_DIRECTORY_EXPIRING_SOON_DAYS)
    any_identity = select(OidcIdentity.id).where(OidcIdentity.user_id == User.id).exists()
    active_identity = (
        select(OidcIdentity.id).where(OidcIdentity.user_id == User.id, OidcIdentity.issuer == configuration.issuer_url).exists()
        if configuration is not None
        else any_identity
    )
    pending_mapping = (
        select(OidcPendingIdentityMapping.id)
        .where(
            OidcPendingIdentityMapping.provider_configuration_id == configuration.id,
            OidcPendingIdentityMapping.target_user_id == User.id,
        )
        .exists()
        if configuration is not None
        else False
    )
    active_identity_without_login = (
        select(OidcIdentity.id)
        .where(
            OidcIdentity.user_id == User.id,
            OidcIdentity.issuer == configuration.issuer_url,
            OidcIdentity.last_login_at.is_(None),
        )
        .exists()
        if configuration is not None
        else False
    )
    predicates: list[object] = []

    if query:
        escaped_query = f"%{query.strip().lower()}%"
        predicates.append(
            or_(
                func.lower(User.username).like(escaped_query),
                func.lower(func.coalesce(User.name, "")).like(escaped_query),
                func.lower(func.coalesce(User.email, "")).like(escaped_query),
            )
        )
    if roles:
        predicates.append(User.role.in_(roles))
    if states:
        state_predicates = []
        for directory_state in states:
            if directory_state == AdminUserDirectoryState.ACTIVE:
                state_predicates.append(and_(User.is_active.is_(True), or_(User.expires_at.is_(None), User.expires_at > now)))
            elif directory_state == AdminUserDirectoryState.DISABLED:
                state_predicates.append(User.is_active.is_(False))
            elif directory_state == AdminUserDirectoryState.EXPIRED:
                state_predicates.append(and_(User.expires_at.is_not(None), User.expires_at <= now))
            else:
                state_predicates.append(
                    and_(User.is_active.is_(True), User.expires_at.is_not(None), User.expires_at > now, User.expires_at <= expiring_soon_at)
                )
        predicates.append(or_(*state_predicates))
    if authentication:
        authentication_predicates = []
        for authentication_method in authentication:
            if authentication_method == AdminUserDirectoryAuthentication.PASSWORD:
                authentication_predicates.append(and_(User.password_hash.is_not(None), not_(any_identity)))
            elif authentication_method == AdminUserDirectoryAuthentication.OIDC:
                authentication_predicates.append(and_(User.password_hash.is_(None), any_identity))
            elif authentication_method == AdminUserDirectoryAuthentication.PASSWORD_AND_OIDC:
                authentication_predicates.append(and_(User.password_hash.is_not(None), any_identity))
            else:
                authentication_predicates.append(and_(User.password_hash.is_(None), not_(any_identity)))
        predicates.append(or_(*authentication_predicates))
    if oidc_states:
        oidc_state_predicates = []
        for oidc_state in oidc_states:
            if oidc_state == AdminUserDirectoryOidcState.LINKED:
                oidc_state_predicates.append(any_identity)
            elif oidc_state == AdminUserDirectoryOidcState.PENDING:
                oidc_state_predicates.append(pending_mapping)
            else:
                oidc_state_predicates.append(and_(not_(any_identity), not_(pending_mapping)))
        predicates.append(or_(*oidc_state_predicates))
    if role_sources:
        role_source_predicates = []
        for role_source in role_sources:
            if role_source == AdminUserDirectoryRoleSource.LOCAL_ASSIGNMENT:
                role_source_predicates.append(and_(not_(active_identity), not_(pending_mapping)))
            elif role_source == AdminUserDirectoryRoleSource.INDIVIDUAL_OVERRIDE:
                role_source_predicates.append(and_(active_identity, User.oidc_role_assignment.is_not(None)))
            elif role_source == AdminUserDirectoryRoleSource.AWAITING_OIDC_SIGN_IN:
                role_source_predicates.append(or_(pending_mapping, active_identity_without_login))
            elif role_source == AdminUserDirectoryRoleSource.OIDC_GROUPS:
                if configuration is not None and configuration.role_assignment_mode == OidcRoleAssignmentMode.GROUP_BASED:
                    role_source_predicates.append(
                        and_(active_identity, User.oidc_role_assignment.is_(None), not_(active_identity_without_login))
                    )
                else:
                    role_source_predicates.append(false())
            elif role_source == AdminUserDirectoryRoleSource.OIDC_DEFAULT:
                if configuration is not None and configuration.role_assignment_mode == OidcRoleAssignmentMode.UNIFORM:
                    role_source_predicates.append(
                        and_(active_identity, User.oidc_role_assignment.is_(None), not_(active_identity_without_login))
                    )
                else:
                    role_source_predicates.append(false())
        predicates.append(or_(*role_source_predicates))
    if expiration == "has_expiration":
        predicates.append(User.expires_at.is_not(None))
    elif expiration == "no_expiration":
        predicates.append(User.expires_at.is_(None))

    return predicates, any_identity, pending_mapping


def _count_directory_users(session: Session, predicates: list[object], additional_predicate: object | None = None) -> int:
    statement = select(func.count()).select_from(User).where(*predicates)
    if additional_predicate is not None:
        statement = statement.where(additional_predicate)
    return int(session.exec(statement).one())


@router.get("/users", response_model=AdminUserListResponse)
async def list_users(
    current_user: User = Depends(require_capability(Capability.MANAGE_USERS)),
    session: Session = Depends(get_session),
    q: str | None = Query(default=None, max_length=200),
    role: list[UserRole] = Query(default=[]),
    state: list[AdminUserDirectoryState] = Query(default=[]),
    auth: list[AdminUserDirectoryAuthentication] = Query(default=[]),
    oidc_state: list[AdminUserDirectoryOidcState] = Query(default=[]),
    role_source: list[AdminUserDirectoryRoleSource] = Query(default=[]),
    expiration: str | None = Query(default=None, pattern="^(has_expiration|no_expiration)$"),
    sort: AdminUserDirectorySort = AdminUserDirectorySort.USERNAME,
    direction: SortDirection = SortDirection.ASC,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=USER_DIRECTORY_DEFAULT_PAGE_SIZE, ge=1, le=USER_DIRECTORY_MAX_PAGE_SIZE),
) -> AdminUserListResponse:
    set_user(current_user.username)
    logger.debug("Listing users", extra={"page": page, "page_size": page_size})
    configuration = session.get(OidcProviderConfiguration, 1)
    predicates, any_identity, pending_mapping = _directory_query_predicates(
        configuration=configuration,
        query=q,
        roles=role,
        states=state,
        authentication=auth,
        oidc_states=oidc_state,
        role_sources=role_source,
        expiration=expiration,
    )
    now = datetime.now(timezone.utc)
    expiring_soon_at = now.replace(microsecond=0) + timedelta(days=USER_DIRECTORY_EXPIRING_SOON_DAYS)
    last_sign_in = (
        select(func.max(OidcIdentity.last_login_at))
        .where(
            OidcIdentity.user_id == User.id,
            OidcIdentity.issuer == configuration.issuer_url if configuration is not None else True,
        )
        .scalar_subquery()
    )
    active_identity = (
        select(OidcIdentity.id)
        .where(
            OidcIdentity.user_id == User.id,
            OidcIdentity.issuer == configuration.issuer_url if configuration is not None else True,
        )
        .exists()
    )
    active_identity_without_login = (
        select(OidcIdentity.id)
        .where(
            OidcIdentity.user_id == User.id,
            OidcIdentity.issuer == configuration.issuer_url if configuration is not None else True,
            OidcIdentity.last_login_at.is_(None),
        )
        .exists()
    )
    status_sort = case(
        (User.is_active.is_(False), "disabled"),
        (and_(User.expires_at.is_not(None), User.expires_at <= now), "expired"),
        (and_(User.expires_at.is_not(None), User.expires_at <= expiring_soon_at), "expiring soon"),
        else_="active",
    )
    sign_in_sort = case(
        (and_(User.password_hash.is_not(None), active_identity), "password and oidc"),
        (active_identity, "oidc"),
        (User.password_hash.is_not(None), "password"),
        else_="unavailable",
    )
    oidc_state_sort = case(
        (pending_mapping, "setup pending"),
        (active_identity, "linked"),
        else_="unlinked",
    )
    role_source_sort = case(
        (or_(pending_mapping, active_identity_without_login), "awaiting oidc sign-in"),
        (User.oidc_role_assignment.is_not(None), "individual override"),
        (
            active_identity,
            "oidc groups"
            if configuration is not None and configuration.role_assignment_mode == OidcRoleAssignmentMode.GROUP_BASED
            else "oidc default",
        ),
        else_="local assignment",
    )
    oidc_provider_sort = case(
        (active_identity, configuration.display_name if configuration is not None else "OIDC"),
        else_="not linked",
    )
    sort_columns = {
        AdminUserDirectorySort.USERNAME: func.lower(User.username),
        AdminUserDirectorySort.ROLE: User.role,
        AdminUserDirectorySort.STATUS: status_sort,
        AdminUserDirectorySort.SIGN_IN: sign_in_sort,
        AdminUserDirectorySort.LAST_SIGN_IN: last_sign_in,
        AdminUserDirectorySort.EXPIRATION: User.expires_at,
        AdminUserDirectorySort.EMAIL: func.lower(func.coalesce(User.email, "")),
        AdminUserDirectorySort.CREATED_AT: User.created_at,
        AdminUserDirectorySort.UPDATED_AT: User.updated_at,
        AdminUserDirectorySort.OIDC_STATE: oidc_state_sort,
        AdminUserDirectorySort.ROLE_SOURCE: role_source_sort,
        AdminUserDirectorySort.OIDC_PROVIDER: oidc_provider_sort,
    }
    sort_column = sort_columns[sort]
    ordering = sort_column.asc().nullslast() if direction == SortDirection.ASC else sort_column.desc().nullslast()
    total = _count_directory_users(session, predicates)
    users = session.exec(
        select(User)
        .where(*predicates)
        .order_by(ordering, User.username.asc(), User.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    summary = AdminUserListSummary(
        total=total,
        active_admins=_count_directory_users(session, predicates, and_(User.role == UserRole.ADMIN, User.is_active.is_(True))),
        disabled=_count_directory_users(session, predicates, User.is_active.is_(False)),
        expiring_soon=_count_directory_users(
            session,
            predicates,
            and_(User.is_active.is_(True), User.expires_at.is_not(None), User.expires_at > now, User.expires_at <= expiring_soon_at),
        ),
        pending_oidc=_count_directory_users(session, predicates, pending_mapping),
        unavailable_sign_in=_count_directory_users(session, predicates, and_(User.password_hash.is_(None), not_(any_identity))),
    )
    return AdminUserListResponse(
        items=_build_admin_user_reads_with_authentication(session, users),
        total=total,
        summary=summary,
        username_conflicts=_username_conflicts(session),
    )


@router.post("/users", response_model=AdminUserCreateResult, status_code=status.HTTP_201_CREATED)
async def create_user(
    user_data: AdminUserCreate,
    current_user: User = Depends(require_capability(Capability.MANAGE_USERS)),
    session: Session = Depends(get_session),
) -> AdminUserCreateResult:
    set_user(current_user.username)
    if not is_local_password_management_available(session):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Creating local users is unavailable because local-password authentication is disabled",
        )
    username = user_data.username.strip()
    name = user_data.name.strip() if user_data.name else None
    email = user_data.email.strip().lower() if user_data.email else None
    existing_user = session.exec(select(User).where(User.username_key == username_key(username))).first()
    if existing_user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=USERNAME_COLLISION_MESSAGE)

    if email:
        existing_email_user = session.exec(select(User).where(User.email == email)).first()
        if existing_email_user:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A user with that email address already exists")

    temporary_password: str | None = None
    password_to_store = user_data.password
    if not password_to_store:
        temporary_password = generate_temporary_password()
        password_to_store = temporary_password

    user = User(
        username=username,
        name=name,
        email=email,
        password_hash=get_password_hash(password_to_store),
        role=user_data.role,
        is_active=True,
        must_change_password=user_data.must_change_password,
        expires_at=user_data.expires_at,
    )
    session.add(user)
    _commit_user_change(session)
    session.refresh(user)

    logger.info(f"Created user: actor={current_user.username}, username={user.username}, role={user.role}")

    return AdminUserCreateResult(
        **_build_admin_user_read_with_authentication(session, user).model_dump(),
        temporary_password=temporary_password,
    )


@router.patch("/users/{user_id}", response_model=AdminUserRead)
async def update_user(
    user_id: uuid.UUID,
    user_data: AdminUserUpdate,
    current_user: User = Depends(require_capability(Capability.MANAGE_USERS)),
    session: Session = Depends(get_session),
) -> AdminUserRead:
    set_user(current_user.username)

    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    configuration = session.get(OidcProviderConfiguration, 1)
    active_identity = (
        session.exec(
            select(OidcIdentity).where(
                OidcIdentity.issuer == configuration.issuer_url,
                OidcIdentity.user_id == user.id,
            )
        ).first()
        if configuration is not None
        else None
    )
    identity = active_identity or session.exec(select(OidcIdentity).where(OidcIdentity.user_id == user.id)).first()
    if identity is not None and {"name", "email"}.intersection(user_data.model_fields_set):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=OIDC_MANAGED_IDENTITY_FIELDS_DETAIL)

    next_username = user_data.username.strip() if user_data.username is not None else user.username
    next_name = user_data.name.strip() if user_data.name is not None else user.name
    next_email = user_data.email.strip().lower() if user_data.email is not None else user.email
    next_role = user_data.role or user.role
    assignment_requested = "oidc_role_assignment" in user_data.model_fields_set
    next_oidc_role_assignment = user_data.oidc_role_assignment if assignment_requested else user.oidc_role_assignment
    if next_oidc_role_assignment is not None:
        next_role = next_oidc_role_assignment
    elif assignment_requested and user.oidc_role_assignment is not None:
        inherited_role = (
            _resolve_inherited_oidc_role(configuration, active_identity)
            if configuration is not None and active_identity is not None
            else None
        )
        if inherited_role is None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=OIDC_INHERITED_ROLE_UNAVAILABLE_DETAIL)
        next_role = inherited_role
    next_is_active = user.is_active if user_data.is_active is None else user_data.is_active
    next_expires_at = user.expires_at if user_data.expires_at is None else user_data.expires_at

    if username_key(next_username) != user.username_key:
        existing_user = session.exec(select(User).where(User.username_key == username_key(next_username))).first()
        if existing_user and existing_user.id != user.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=USERNAME_COLLISION_MESSAGE)

    if next_email != user.email and next_email:
        existing_email_user = session.exec(select(User).where(User.email == next_email)).first()
        if existing_email_user and existing_email_user.id != user.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A user with that email address already exists")

    _validate_user_update_guards(
        actor=current_user,
        target=user,
        session=session,
        next_role=next_role,
        next_is_active=next_is_active,
    )

    user.username = next_username
    user.name = next_name
    user.email = next_email
    user.role = next_role
    if assignment_requested and user.oidc_role_assignment != next_oidc_role_assignment:
        previous_assignment = user.oidc_role_assignment
        user.oidc_role_assignment = next_oidc_role_assignment
        user.token_version += 1
        write_audit_event(
            session,
            event_name=AuditEventName.USER_ROLE_ASSIGNMENT_CHANGED,
            result=AuditResult.SUCCEEDED,
            details=AuditDetails(
                selected_role=next_oidc_role_assignment.value if next_oidc_role_assignment is not None else None,
                changed_fields=(previous_assignment.value if previous_assignment is not None else "configured",),
            ),
            acting_user_id=current_user.id,
            affected_user_id=user.id,
        )
    user.is_active = next_is_active
    user.expires_at = next_expires_at
    user.updated_at = datetime.now(timezone.utc)
    session.add(user)
    _commit_user_change(session)
    session.refresh(user)

    logger.info(f"Updated user: actor={current_user.username}, username={user.username}, role={user.role}, active={user.is_active}")
    return _build_admin_user_read_with_authentication(session, user)


@router.post("/users/{user_id}/reset-password", response_model=AdminUserPasswordResetResult)
async def reset_user_password(
    user_id: uuid.UUID,
    reset_data: AdminUserPasswordReset,
    current_user: User = Depends(require_capability(Capability.MANAGE_USERS)),
    session: Session = Depends(get_session),
) -> AdminUserPasswordResetResult:
    set_user(current_user.username)
    if not is_local_password_management_available(session):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Resetting local passwords is unavailable because local-password authentication is disabled",
        )

    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if user.password_hash is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password reset requires an existing local password",
        )

    user.password_hash = get_password_hash(reset_data.new_password)
    user.must_change_password = reset_data.must_change_password
    user.token_version += 1
    write_audit_event(
        session,
        event_name=AuditEventName.PASSWORD_RESET,
        result=AuditResult.SUCCEEDED,
        acting_user_id=current_user.id,
        affected_user_id=user.id,
    )
    user.updated_at = datetime.now(timezone.utc)
    session.add(user)
    session.commit()

    logger.info(f"Reset password for user: actor={current_user.username}, username={user.username}")
    return AdminUserPasswordResetResult(
        message="Password reset successfully",
    )


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: uuid.UUID,
    current_user: User = Depends(require_capability(Capability.MANAGE_USERS)),
    session: Session = Depends(get_session),
) -> dict[str, str]:
    set_user(current_user.username)

    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    _validate_user_update_guards(
        actor=current_user,
        target=user,
        session=session,
        next_role=user.role,
        next_is_active=user.is_active,
        is_delete=True,
    )

    try:
        remove_user_oidc_state(session, user=user, acting_user_id=current_user.id)
    except OidcMappingError as error:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    for theme in session.exec(select(StoredTheme).where(StoredTheme.owner_user_id == user.id)):
        session.delete(theme)
    for setting in session.exec(select(UserSetting).where(UserSetting.user_id == user.id)):
        session.delete(setting)
    session.flush()
    session.delete(user)
    session.commit()

    logger.info(f"Deleted user: actor={current_user.username}, username={user.username}")
    return {"message": "User deleted successfully"}
