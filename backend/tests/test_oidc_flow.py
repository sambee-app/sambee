from datetime import datetime, timedelta, timezone

import pytest
from cryptography.fernet import Fernet
from sqlmodel import Session

from app.models.oidc import OidcFlow, OidcFlowStatus
from app.models.user import User, UserRole
from app.services.oidc_configuration import OidcSecretCipher
from app.services.oidc_flow import (
    OidcFlowError,
    claim_login_callback,
    complete_login_callback,
    consume_login_grant,
    hash_flow_secret,
    safe_return_path,
    start_login_flow,
)


def _cipher() -> OidcSecretCipher:
    return OidcSecretCipher(Fernet.generate_key().decode())


def _user(session: Session) -> User:
    user = User(username="oidc-user", role=UserRole.VIEWER, password_hash=None)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def test_safe_return_path_rejects_external_and_protocol_relative_values() -> None:
    assert safe_return_path("https://evil.example/path") == "/browse"
    assert safe_return_path("//evil.example/path") == "/browse"
    assert safe_return_path("/\\evil.example/path") == "/browse"
    assert safe_return_path("/login") == "/browse"
    assert safe_return_path("/login/") == "/browse"
    assert safe_return_path("/login?return_path=%2Fbrowse") == "/browse"
    assert safe_return_path("/login/oidc/callback") == "/browse"
    assert safe_return_path("/login/oidc/callback?grant=expired") == "/browse"
    assert safe_return_path("/browse/folder?view=grid#ignored") == "/browse/folder?view=grid"


def test_start_and_claim_flow_store_only_hashes_and_ciphertext(session: Session) -> None:
    cipher = _cipher()
    started = start_login_flow(
        session,
        configuration_revision=7,
        cipher=cipher,
        return_path="/browse/folder",
    )
    session.commit()
    stored = session.get(OidcFlow, started.flow_id)

    assert stored is not None
    assert stored.state_hash != started.state
    assert started.state not in stored.state_hash
    assert stored.encrypted_nonce is not None and started.nonce not in stored.encrypted_nonce
    assert stored.encrypted_verifier is not None and started.code_verifier not in stored.encrypted_verifier

    claimed = claim_login_callback(session, state=started.state, cipher=cipher)
    assert claimed.flow_id == started.flow_id
    assert claimed.nonce == started.nonce
    assert claimed.code_verifier == started.code_verifier

    with pytest.raises(OidcFlowError):
        claim_login_callback(session, state=started.state, cipher=cipher)


def test_expired_flow_cannot_be_claimed(session: Session) -> None:
    cipher = _cipher()
    now = datetime.now(timezone.utc)
    started = start_login_flow(
        session,
        configuration_revision=1,
        cipher=cipher,
        return_path=None,
        now=now - timedelta(minutes=10),
    )
    session.commit()

    with pytest.raises(OidcFlowError):
        claim_login_callback(session, state=started.state, cipher=cipher, now=now)


def test_login_flow_preserves_interactive_reauthentication_requirement(session: Session) -> None:
    cipher = _cipher()
    started = start_login_flow(
        session,
        configuration_revision=1,
        cipher=cipher,
        return_path=None,
        interactive_reauthentication_required=True,
    )
    session.commit()

    claimed = claim_login_callback(session, state=started.state, cipher=cipher)

    assert claimed.interactive_reauthentication_required is True


def test_callback_grant_is_hashed_single_use_and_deletes_flow(session: Session) -> None:
    cipher = _cipher()
    user = _user(session)
    started = start_login_flow(session, configuration_revision=1, cipher=cipher, return_path="/browse/private")
    session.commit()
    claimed = claim_login_callback(session, state=started.state, cipher=cipher)
    validated = complete_login_callback(session, flow_id=claimed.flow_id, user=user)
    stored = session.get(OidcFlow, claimed.flow_id)

    assert stored is not None
    assert stored.status == OidcFlowStatus.CALLBACK_VALIDATED
    assert stored.grant_hash != validated.grant
    assert stored.encrypted_nonce is None
    assert stored.encrypted_verifier is None

    consumed_user, return_path = consume_login_grant(session, grant=validated.grant, browser_states=[started.state])
    assert consumed_user.id == user.id
    assert return_path == "/browse/private"
    assert session.get(OidcFlow, claimed.flow_id) is None

    with pytest.raises(OidcFlowError):
        consume_login_grant(session, grant=validated.grant, browser_states=[started.state])


def test_login_grant_rejects_a_different_browser_state(session: Session) -> None:
    cipher = _cipher()
    user = _user(session)
    started = start_login_flow(session, configuration_revision=1, cipher=cipher, return_path=None)
    session.commit()
    claimed = claim_login_callback(session, state=started.state, cipher=cipher)
    validated = complete_login_callback(session, flow_id=claimed.flow_id, user=user)

    with pytest.raises(OidcFlowError):
        consume_login_grant(session, grant=validated.grant, browser_states=["another-browser"])

    assert consume_login_grant(session, grant=validated.grant, browser_states=[started.state]).user.id == user.id


@pytest.mark.parametrize("exchange_order", [(0, 1), (1, 0)])
def test_two_pending_login_flows_can_exchange_in_either_order(session: Session, exchange_order: tuple[int, int]) -> None:
    cipher = _cipher()
    user = _user(session)
    started_flows = [start_login_flow(session, configuration_revision=1, cipher=cipher, return_path=None) for _ in range(2)]
    session.commit()
    grants = []
    for started in reversed(started_flows):
        claimed = claim_login_callback(session, state=started.state, cipher=cipher)
        grants.append((started, complete_login_callback(session, flow_id=claimed.flow_id, user=user)))

    browser_states = [started.state for started in started_flows]
    for index in exchange_order:
        started, validated = grants[index]
        consumed = consume_login_grant(session, grant=validated.grant, browser_states=browser_states)
        assert consumed.user.id == user.id
        assert consumed.state_hash == hash_flow_secret(started.state)
        browser_states.remove(started.state)

    assert browser_states == []


def test_token_version_change_invalidates_and_consumes_grant(session: Session) -> None:
    cipher = _cipher()
    user = _user(session)
    started = start_login_flow(session, configuration_revision=1, cipher=cipher, return_path=None)
    session.commit()
    claimed = claim_login_callback(session, state=started.state, cipher=cipher)
    validated = complete_login_callback(session, flow_id=claimed.flow_id, user=user)
    user.token_version += 1
    session.add(user)
    session.commit()

    with pytest.raises(OidcFlowError):
        consume_login_grant(session, grant=validated.grant, browser_states=[started.state])

    assert session.get(OidcFlow, claimed.flow_id) is None
