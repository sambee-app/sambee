import uuid
from datetime import datetime, timezone
from typing import ClassVar

from sqlmodel import Field, SQLModel


class CompanionUriTokenJti(SQLModel, table=True):
    """Durable registry of consumed companion URI bootstrap token JTIs."""

    __tablename__: ClassVar[str] = "companion_uri_token_jti"

    jti: str = Field(primary_key=True)
    user_id: uuid.UUID | None = Field(default=None, index=True)
    connection_id: uuid.UUID | None = Field(default=None, index=True)
    path: str = Field(index=True)
    expires_at: datetime = Field(index=True)
    consumed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


class CompanionDirectoryPolicyGrant(SQLModel, table=True):
    """Bounded, expiring registry of separately scoped administration grants."""

    __tablename__: ClassVar[str] = "companion_directory_policy_grant"

    jti: uuid.UUID = Field(primary_key=True)
    user_id: uuid.UUID = Field(index=True)
    companion_id: uuid.UUID
    challenge: str
    origin: str
    backend_identity: str
    revision: int
    token_version: int
    expires_at: datetime = Field(index=True)
    consumed_at: datetime | None = None
