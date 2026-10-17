import uuid
from datetime import datetime, timezone
from enum import StrEnum
from typing import overload

from pydantic import model_validator
from sqlalchemy import Column, Computed, String
from sqlalchemy import Enum as SqlEnum
from sqlmodel import Field, SQLModel

from app.core.usernames import USERNAME_KEY_FUNCTION


class UserRole(StrEnum):
    EDITOR = "editor"
    VIEWER = "viewer"
    ADMIN = "admin"


class AdminUserDirectoryState(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"
    EXPIRED = "expired"
    EXPIRING_SOON = "expiring_soon"


class AdminUserDirectoryAuthentication(StrEnum):
    PASSWORD = "password"
    OIDC = "oidc"
    PASSWORD_AND_OIDC = "password_and_oidc"
    UNAVAILABLE = "unavailable"


class AdminUserDirectoryOidcState(StrEnum):
    LINKED = "linked"
    PENDING = "pending"
    UNLINKED = "unlinked"


class AdminUserDirectoryRoleSource(StrEnum):
    LOCAL_ASSIGNMENT = "local_assignment"
    INDIVIDUAL_OVERRIDE = "individual_override"
    OIDC_DEFAULT = "oidc_default"
    OIDC_GROUPS = "oidc_groups"
    AWAITING_OIDC_SIGN_IN = "awaiting_oidc_sign_in"


class AdminUserDirectorySort(StrEnum):
    USERNAME = "username"
    ROLE = "role"
    STATUS = "status"
    SIGN_IN = "sign_in"
    LAST_SIGN_IN = "last_sign_in"
    EXPIRATION = "expiration"
    EMAIL = "email"
    CREATED_AT = "created_at"
    UPDATED_AT = "updated_at"
    OIDC_STATE = "oidc_state"
    ROLE_SOURCE = "role_source"
    OIDC_PROVIDER = "oidc_provider"


class SortDirection(StrEnum):
    ASC = "asc"
    DESC = "desc"


class AccountIdentitySource(StrEnum):
    LOCAL = "local"
    OIDC = "oidc"


class AccountSessionKind(StrEnum):
    PASSWORD = "password"
    OIDC = "oidc"


class User(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    username: str = Field(unique=True, index=True)
    username_key: str = Field(default=None, sa_column=Column(String, Computed(f"{USERNAME_KEY_FUNCTION}(username)"), index=True))
    name: str | None = Field(default=None)
    email: str | None = Field(default=None, index=True)
    password_hash: str | None = Field(default=None)
    role: UserRole = Field(
        default=UserRole.EDITOR,
        sa_column=Column(
            SqlEnum(
                UserRole,
                values_callable=lambda enum_cls: [member.value for member in enum_cls],
                native_enum=False,
                validate_strings=True,
            ),
            nullable=False,
            default=UserRole.EDITOR,
        ),
    )
    oidc_role_assignment: UserRole | None = Field(
        default=None,
        sa_column=Column(
            SqlEnum(
                UserRole,
                values_callable=lambda enum_cls: [member.value for member in enum_cls],
                native_enum=False,
                validate_strings=True,
            ),
            nullable=True,
        ),
    )
    is_active: bool = Field(default=True, index=True)
    must_change_password: bool = Field(default=False)
    token_version: int = Field(default=0)
    expires_at: datetime | None = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @model_validator(mode="before")
    @classmethod
    def normalize_user_fields(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data

        normalized = dict(data)
        if "username" in normalized and isinstance(normalized["username"], str):
            normalized["username"] = normalized["username"].strip()
        if "name" in normalized and isinstance(normalized["name"], str):
            normalized["name"] = normalized["name"].strip() or None
        if "email" in normalized and isinstance(normalized["email"], str):
            normalized["email"] = normalized["email"].strip().lower() or None

        return normalized


class CurrentUserRead(SQLModel):
    id: uuid.UUID
    username: str
    name: str | None
    email: str | None
    role: UserRole
    is_active: bool
    must_change_password: bool
    expires_at: datetime | None
    created_at: datetime


class CurrentAccountRead(CurrentUserRead):
    has_local_password: bool
    identity_source: AccountIdentitySource
    password_change_available: bool
    password_change_required: bool
    browser_session_management_available: bool
    oidc_provider_name: str | None
    current_session: "CurrentAccountSessionRead | None"


class CurrentAccountSessionRead(SQLModel):
    kind: AccountSessionKind
    id: uuid.UUID | None
    started_at: datetime | None
    last_active_at: datetime | None
    browser_name: str | None
    operating_system: str | None


class AdminUserOidcRead(SQLModel):
    identity_id: uuid.UUID
    user_id: uuid.UUID
    provider_display_name: str
    issuer: str
    subject: str
    last_seen_username: str | None
    last_groups: list[str]
    created_at: datetime
    last_login_at: datetime | None
    inherited_role: UserRole | None


class AdminUserPendingOidcRead(SQLModel):
    expected_username: str
    created_by_username: str
    created_at: datetime


class AdminUserRead(CurrentUserRead):
    updated_at: datetime
    has_local_password: bool
    oidc_role_assignment: UserRole | None = None
    oidc: AdminUserOidcRead | None = None
    pending_oidc: AdminUserPendingOidcRead | None = None


class AdminUserListSummary(SQLModel):
    total: int
    active_admins: int
    disabled: int
    expiring_soon: int
    pending_oidc: int
    unavailable_sign_in: int


class AdminUserListResponse(SQLModel):
    items: list[AdminUserRead]
    total: int
    summary: AdminUserListSummary
    username_conflicts: list[list[str]] = Field(default_factory=list)


class AdminUserCreate(SQLModel):
    username: str
    name: str | None = None
    email: str | None = None
    role: UserRole = UserRole.EDITOR
    password: str | None = None
    must_change_password: bool = True
    expires_at: datetime | None = None


class AdminUserUpdate(SQLModel):
    username: str | None = None
    name: str | None = None
    email: str | None = None
    role: UserRole | None = None
    oidc_role_assignment: UserRole | None = None
    is_active: bool | None = None
    expires_at: datetime | None = None


class AdminUserPasswordReset(SQLModel):
    new_password: str
    must_change_password: bool = True


class AdminUserCreateResult(AdminUserRead):
    temporary_password: str | None = None


class AdminUserPasswordResetResult(SQLModel):
    message: str


class PasswordChangeRequest(SQLModel):
    current_password: str
    new_password: str


@overload
def normalize_utc_datetime(value: datetime) -> datetime: ...


@overload
def normalize_utc_datetime(value: None) -> None: ...


def normalize_utc_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def build_current_user_read(user: User) -> CurrentUserRead:
    return CurrentUserRead(
        id=user.id,
        username=user.username,
        name=user.name,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
        must_change_password=user.must_change_password,
        expires_at=normalize_utc_datetime(user.expires_at),
        created_at=normalize_utc_datetime(user.created_at),
    )


def build_admin_user_read(user: User) -> AdminUserRead:
    return AdminUserRead(
        id=user.id,
        username=user.username,
        name=user.name,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
        must_change_password=user.must_change_password,
        expires_at=normalize_utc_datetime(user.expires_at),
        created_at=normalize_utc_datetime(user.created_at),
        updated_at=normalize_utc_datetime(user.updated_at),
        has_local_password=user.password_hash is not None,
        oidc_role_assignment=user.oidc_role_assignment,
    )
