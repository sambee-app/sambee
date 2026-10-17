import hashlib
import json
import uuid
from enum import StrEnum

from pydantic import BaseModel, ConfigDict
from sqlmodel import Session

from app.models.audit import AuditEvent


class AuditEventName(StrEnum):
    PASSWORD_CHANGED = "auth.password.changed"
    PASSWORD_RESET = "auth.password.reset"
    CONFIG_VALIDATED = "oidc.config.validated"
    CONFIG_UPDATED = "oidc.config.updated"
    AUTHORIZATION_STARTED = "oidc.authorization.started"
    LOGIN_SUCCEEDED = "oidc.login.succeeded"
    LOGIN_FAILED = "oidc.login.failed"
    BROWSER_SESSION_CREATED = "oidc.browser_session.created"
    BROWSER_SESSION_REFRESHED = "oidc.browser_session.refreshed"
    BROWSER_SESSION_REVOKED = "oidc.browser_session.revoked"
    BROWSER_SESSION_REVOKED_OTHERS = "oidc.browser_session.revoked_others"
    BROWSER_SESSION_REFRESH_UNCERTAIN = "oidc.browser_session.refresh_uncertain"
    BROWSER_SESSION_CIPHER_KEY_ROTATED = "oidc.browser_session.cipher_key_rotated"
    USER_PROVISIONED = "oidc.user.provisioned"
    PENDING_MAPPING_CREATED = "oidc.identity.pending_mapping_created"
    PENDING_MAPPING_BATCH_CREATED = "oidc.identity.pending_mapping_batch_created"
    PENDING_MAPPING_CANCELED = "oidc.identity.pending_mapping_canceled"
    IDENTITY_MAPPED = "oidc.identity.mapped"
    IDENTITY_RELINKED = "oidc.identity.relinked"
    IDENTITY_UNMAPPED = "oidc.identity.unmapped"
    IDENTITY_REASSIGNED = "oidc.identity.reassigned"
    IDENTITY_MAPPING_CHANGED = "oidc.identity.mapping_changed"
    IDENTITY_NAMESPACE_REPLACED = "oidc.provider.identity_namespace_replaced"
    USER_ROLE_CHANGED = "oidc.user.role_changed"
    USER_ROLE_ASSIGNMENT_CHANGED = "oidc.user.role_assignment_changed"
    USER_ROLE_SYNC_BLOCKED = "oidc.user.role_sync_blocked"
    ARCHIVE_OPERATION_LIFECYCLE = "archive.operation.lifecycle"
    ARCHIVE_OPERATION_DECISION = "archive.operation.decision"


class AuditResult(StrEnum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    BLOCKED = "blocked"


class AuditDetails(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str | None = None
    selected_role: str | None = None
    failure_category: str | None = None
    subject_hash: str | None = None
    changed_fields: tuple[str, ...] | None = None
    local_password_exists: bool | None = None
    mapping_count: int | None = None
    archive_operation_kind: str | None = None
    archive_phase: str | None = None
    archive_previous_phase: str | None = None
    archive_decision: str | None = None


def diagnostic_subject_hash(issuer: str, subject: str) -> str:
    return hashlib.sha256(f"{issuer}\0{subject}".encode()).hexdigest()


def write_audit_event(
    session: Session,
    *,
    event_name: AuditEventName,
    result: AuditResult,
    details: AuditDetails | None = None,
    acting_user_id: uuid.UUID | None = None,
    affected_user_id: uuid.UUID | None = None,
    provider_configuration_id: int | None = None,
    correlation_id: str | None = None,
) -> AuditEvent:
    serialized_details = json.dumps(
        (details or AuditDetails()).model_dump(mode="json", exclude_none=True),
        separators=(",", ":"),
        sort_keys=True,
    )
    event = AuditEvent(
        event_name=event_name.value,
        result=result.value,
        acting_user_id=acting_user_id,
        affected_user_id=affected_user_id,
        provider_configuration_id=provider_configuration_id,
        correlation_id=correlation_id,
        safe_details_json=serialized_details,
    )
    session.add(event)
    return event
