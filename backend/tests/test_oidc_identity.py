import json

import pytest
from sqlmodel import Session, select

from app.models.audit import AuditEvent
from app.models.oidc import (
    OidcAdmissionMode,
    OidcIdentity,
    OidcPendingIdentityMapping,
    OidcProviderConfiguration,
    OidcRoleAssignmentMode,
)
from app.models.user import User, UserRole
from app.services.oidc_client import NormalizedOidcClaims
from app.services.oidc_identity import (
    OidcIdentityError,
    OidcIdentityErrorCode,
    evaluate_oidc_access,
    resolve_oidc_role,
    resolve_or_provision_oidc_user,
)


def _configuration(
    session: Session,
    *,
    auto_link_by_username: bool = True,
    admission_groups: list[str] | None = None,
    admin_groups: list[str] | None = None,
    editor_groups: list[str] | None = None,
    viewer_groups: list[str] | None = None,
) -> OidcProviderConfiguration:
    configuration = OidcProviderConfiguration(
        display_name="Example IDP",
        issuer_url="https://idp.example.test",
        client_id="sambee",
        admission_mode=OidcAdmissionMode.SELECTED_GROUPS,
        admission_groups_json=json.dumps(admission_groups or ["Sambee Users"]),
        role_assignment_mode=OidcRoleAssignmentMode.GROUP_BASED,
        role_mappings_json=json.dumps({"admin": admin_groups or [], "editor": editor_groups or [], "viewer": viewer_groups or []}),
        auto_link_by_username=auto_link_by_username,
    )
    session.add(configuration)
    session.commit()
    session.refresh(configuration)
    return configuration


def _claims(*, subject: str = "subject-1", username: str = "alice", groups: tuple[str, ...] = ("sambee users",)) -> NormalizedOidcClaims:
    return NormalizedOidcClaims(
        issuer="https://idp.example.test",
        subject=subject,
        username=username,
        groups=groups,
        name="Alice Example",
        email="alice@example.test",
    )


def test_role_resolution_normalizes_groups_and_uses_highest_privilege(session: Session) -> None:
    configuration = _configuration(
        session,
        admission_groups=["Ｓａｍｂｅｅ Ｕｓｅｒｓ"],
        admin_groups=["Platform Admins"],
        editor_groups=["Editors"],
    )

    role = resolve_oidc_role(configuration, ("sambee users", "editors", "PLATFORM ADMINS"))

    assert role == UserRole.ADMIN


def test_case_only_username_conflict_does_not_link_oidc_identity(session: Session) -> None:
    configuration = _configuration(session, editor_groups=["Editors"])
    local = User(username="Alice", password_hash="existing-hash")
    session.add(local)
    session.commit()
    with pytest.raises(OidcIdentityError) as error:
        resolve_or_provision_oidc_user(session, configuration=configuration, claims=_claims(groups=("sambee users", "Editors")))
    assert error.value.code == OidcIdentityErrorCode.USERNAME_COLLISION
    assert session.exec(select(OidcIdentity).where(OidcIdentity.user_id == local.id)).first() is None
    assert session.get(User, local.id).username == "Alice"


def test_role_resolution_grants_viewer_and_denies_nonmatching_groups(session: Session) -> None:
    configuration = _configuration(session, viewer_groups=["Viewers"])
    configuration.admission_mode = OidcAdmissionMode.ALL_IDP_USERS
    session.add(configuration)
    session.commit()

    assert resolve_oidc_role(configuration, ("viewers",)) == UserRole.VIEWER
    with pytest.raises(OidcIdentityError) as error:
        resolve_oidc_role(configuration, ("other users",))
    assert error.value.code == OidcIdentityErrorCode.NO_ROLE_ASSIGNMENT


def test_individual_role_assignment_allows_access_without_groups(session: Session) -> None:
    configuration = _configuration(session, admission_groups=[])
    configuration.admission_mode = OidcAdmissionMode.ALL_IDP_USERS
    session.add(configuration)
    session.commit()

    assert resolve_oidc_role(configuration, (), individual_role=UserRole.EDITOR) == UserRole.EDITOR


def test_uniform_role_assignment_applies_without_groups(session: Session) -> None:
    configuration = _configuration(session)
    configuration.admission_mode = OidcAdmissionMode.ALL_IDP_USERS
    configuration.role_assignment_mode = OidcRoleAssignmentMode.UNIFORM
    configuration.uniform_role = UserRole.EDITOR
    session.add(configuration)
    session.commit()

    assert resolve_oidc_role(configuration, ()) == UserRole.EDITOR


def test_individual_role_assignment_overrides_uniform_and_group_roles(session: Session) -> None:
    configuration = _configuration(session, admin_groups=["Administrators"])
    configuration.admission_mode = OidcAdmissionMode.ALL_IDP_USERS
    configuration.role_assignment_mode = OidcRoleAssignmentMode.UNIFORM
    configuration.uniform_role = UserRole.VIEWER
    session.add(configuration)
    session.commit()

    assert resolve_oidc_role(configuration, ("administrators",), individual_role=UserRole.EDITOR) == UserRole.EDITOR


def test_individual_role_assignment_does_not_bypass_selected_group_admission(session: Session) -> None:
    configuration = _configuration(session, admission_groups=["Sambee Users"])

    with pytest.raises(OidcIdentityError) as error:
        resolve_oidc_role(configuration, ("other users",), individual_role=UserRole.ADMIN)

    assert error.value.code == OidcIdentityErrorCode.NOT_ADMITTED


def test_all_provider_users_does_not_report_an_admission_group_match(session: Session) -> None:
    configuration = _configuration(
        session,
        admission_groups=["Sambee Users"],
        admin_groups=["Platform Admins"],
    )
    configuration.admission_mode = OidcAdmissionMode.ALL_IDP_USERS
    session.add(configuration)
    session.commit()

    evaluation = evaluate_oidc_access(configuration, ("Sambee Users", "Platform Admins"))

    assert evaluation.role == UserRole.ADMIN
    assert evaluation.matching_admission_group is None


def test_unmapped_identity_provisions_passwordless_user_and_audits(session: Session) -> None:
    configuration = _configuration(session, editor_groups=["Sambee Users"])

    user = resolve_or_provision_oidc_user(session, configuration=configuration, claims=_claims(), correlation_id="request-id")

    assert user.password_hash is None
    assert user.role == UserRole.EDITOR
    identity = session.exec(select(OidcIdentity).where(OidcIdentity.user_id == user.id)).one()
    assert identity.subject == "subject-1"
    assert identity.last_groups_json == '["sambee users"]'
    assert configuration.identity_mapping_revision == 1
    event_names = {event.event_name for event in session.exec(select(AuditEvent)).all()}
    assert "oidc.user.provisioned" in event_names
    assert "oidc.login.succeeded" in event_names


def test_unmapped_identity_auto_links_matching_local_username(session: Session) -> None:
    configuration = _configuration(session, viewer_groups=["Sambee Users"])
    local_user = User(username="alice", password_hash="local-password-hash")
    session.add(local_user)
    session.commit()

    resolved = resolve_or_provision_oidc_user(session, configuration=configuration, claims=_claims())

    assert resolved.id == local_user.id
    assert resolved.password_hash == "local-password-hash"
    assert resolved.token_version == 1
    identity = session.exec(select(OidcIdentity).where(OidcIdentity.user_id == local_user.id)).one()
    assert identity.subject == "subject-1"
    assert session.exec(select(AuditEvent).where(AuditEvent.event_name == "oidc.identity.relinked")).one().result == "succeeded"


def test_auto_link_rejection_for_last_admin_preserves_existing_identity(session: Session) -> None:
    configuration = _configuration(session, editor_groups=["Sambee Users"])
    administrator = User(username="alice", password_hash="local-password-hash", role=UserRole.ADMIN)
    session.add(administrator)
    session.commit()
    existing_identity = OidcIdentity(
        user_id=administrator.id,
        issuer=configuration.issuer_url,
        subject="previous-subject",
    )
    session.add(existing_identity)
    session.commit()

    with pytest.raises(OidcIdentityError) as error:
        resolve_or_provision_oidc_user(session, configuration=configuration, claims=_claims(subject="new-subject"))

    assert error.value.code == OidcIdentityErrorCode.LAST_ADMIN_ROLE_CONFLICT
    session.refresh(configuration)
    assert configuration.identity_mapping_revision == 0
    identities = session.exec(select(OidcIdentity).where(OidcIdentity.user_id == administrator.id)).all()
    assert [(identity.issuer, identity.subject) for identity in identities] == [(configuration.issuer_url, "previous-subject")]
    assert session.exec(select(AuditEvent).where(AuditEvent.event_name == "oidc.identity.relinked")).first() is None


def test_unmapped_identity_rejects_matching_local_username_when_auto_linking_is_disabled(session: Session) -> None:
    configuration = _configuration(session, auto_link_by_username=False, viewer_groups=["Sambee Users"])
    session.add(User(username="alice", password_hash="local-password-hash"))
    session.commit()

    with pytest.raises(OidcIdentityError) as error:
        resolve_or_provision_oidc_user(session, configuration=configuration, claims=_claims())

    assert error.value.code == OidcIdentityErrorCode.USERNAME_COLLISION
    assert session.exec(select(OidcIdentity)).first() is None


def test_pending_mapping_consumes_exact_username_and_preserves_local_password(session: Session) -> None:
    configuration = _configuration(session, admin_groups=["Sambee Users"])
    target = User(username="local-admin", password_hash="existing-hash", role=UserRole.ADMIN)
    actor = User(username="mapping-admin", password_hash="actor-hash", role=UserRole.ADMIN)
    session.add(target)
    session.add(actor)
    session.commit()
    pending = OidcPendingIdentityMapping(
        provider_configuration_id=configuration.id,
        expected_username="alice",
        target_user_id=target.id,
        created_by_user_id=actor.id,
    )
    session.add(pending)
    session.commit()

    resolved = resolve_or_provision_oidc_user(session, configuration=configuration, claims=_claims())

    assert resolved.id == target.id
    assert resolved.password_hash == "existing-hash"
    assert resolved.token_version == 1
    assert session.get(OidcPendingIdentityMapping, pending.id) is None
    assert session.exec(select(OidcIdentity).where(OidcIdentity.user_id == target.id)).one().subject == "subject-1"


def test_pending_mapping_rejection_for_last_admin_preserves_mapping(session: Session) -> None:
    configuration = _configuration(session, editor_groups=["Sambee Users"])
    administrator = User(username="local-admin", password_hash="local-password-hash", role=UserRole.ADMIN)
    session.add(administrator)
    session.commit()
    pending = OidcPendingIdentityMapping(
        provider_configuration_id=configuration.id,
        expected_username="alice",
        target_user_id=administrator.id,
    )
    session.add(pending)
    session.commit()

    with pytest.raises(OidcIdentityError) as error:
        resolve_or_provision_oidc_user(session, configuration=configuration, claims=_claims())

    assert error.value.code == OidcIdentityErrorCode.LAST_ADMIN_ROLE_CONFLICT
    session.refresh(configuration)
    assert configuration.identity_mapping_revision == 0
    assert session.get(OidcPendingIdentityMapping, pending.id) is not None
    assert session.exec(select(OidcIdentity)).first() is None


def test_last_admin_role_sync_is_blocked_and_revokes_sessions(session: Session) -> None:
    configuration = _configuration(session, editor_groups=["Sambee Users"])
    administrator = User(username="alice", password_hash=None, role=UserRole.ADMIN)
    session.add(administrator)
    session.commit()
    identity = OidcIdentity(
        user_id=administrator.id,
        issuer=configuration.issuer_url,
        subject="subject-1",
    )
    session.add(identity)
    session.commit()

    with pytest.raises(OidcIdentityError) as error:
        resolve_or_provision_oidc_user(session, configuration=configuration, claims=_claims())

    session.refresh(administrator)
    assert error.value.code == OidcIdentityErrorCode.LAST_ADMIN_ROLE_CONFLICT_NO_PASSWORD
    assert administrator.role == UserRole.ADMIN
    assert administrator.token_version == 1
    blocked_event = session.exec(select(AuditEvent).where(AuditEvent.event_name == "oidc.user.role_sync_blocked")).one()
    assert blocked_event.result == "blocked"
