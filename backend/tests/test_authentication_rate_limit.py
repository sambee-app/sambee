from app.services.authentication_rate_limit import AuthenticationRateLimiter, resolve_source_ip


def test_password_limit_is_atomic_and_refills_continuously() -> None:
    now = [0.0]
    limiter = AuthenticationRateLimiter(clock=lambda: now[0])

    for _ in range(10):
        assert limiter.check_password("192.0.2.1", " Alice ").allowed

    rejected = limiter.check_password("192.0.2.1", "Alice")
    assert not rejected.allowed
    assert rejected.retry_after_seconds == 90

    now[0] = 90.0
    assert limiter.check_password("192.0.2.1", "Alice").allowed
    assert not limiter.check_password("192.0.2.2", "Alice").allowed


def test_single_bucket_rejects_without_consuming_and_evicts_at_capacity() -> None:
    now = [0.0]
    limiter = AuthenticationRateLimiter(clock=lambda: now[0], max_keys=1)

    for _ in range(20):
        assert limiter.check_authorization("192.0.2.1").allowed
    first_rejection = limiter.check_authorization("192.0.2.1")
    second_rejection = limiter.check_authorization("192.0.2.1")
    assert first_rejection == second_rejection

    assert limiter.check_authorization("192.0.2.2").allowed


def test_password_limit_shares_unicode_case_variants() -> None:
    limiter = AuthenticationRateLimiter()
    for attempt in range(10):
        assert limiter.check_password(f"192.0.2.{attempt + 1}", " Straße ").allowed
    assert not limiter.check_password("198.51.100.1", "STRASSE").allowed


def test_source_ip_uses_only_strict_forwarding_from_trusted_peers() -> None:
    trusted = "10.0.0.0/8, 2001:db8::/32"

    assert resolve_source_ip("192.0.2.10", "198.51.100.7", trusted) == "192.0.2.10"
    assert resolve_source_ip("10.0.0.2", "198.51.100.7, 10.0.0.3", trusted) == "198.51.100.7"
    assert resolve_source_ip("10.0.0.2", "invalid, 10.0.0.3", trusted) == "10.0.0.2"
    assert resolve_source_ip("10.0.0.2", "10.0.0.3", trusted) == "10.0.0.2"
    assert resolve_source_ip("2001:db8::2", "2001:4860::1, 2001:db8::3", trusted) == "2001:4860::1"
