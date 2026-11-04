import base64
import hashlib
import time
from dataclasses import replace
from typing import Any
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from joserfc import jwt
from joserfc.jwk import RSAKey

from app.services.oidc_client import (
    OIDC_PROVIDER_CACHE_MAX_ENTRIES,
    NormalizedOidcClaims,
    OidcClaimMapping,
    OidcClientError,
    OidcClientErrorCode,
    OidcProviderMetadata,
    OidcRefreshError,
    OidcRefreshErrorCode,
    build_authorization_request,
    clear_oidc_provider_cache,
    exchange_and_validate_callback,
    exchange_and_validate_refresh_token,
    load_provider_metadata,
    refresh_provider_jwks,
)
from app.services.oidc_http import ValidatedOidcHttpClient

ISSUER = "https://idp.example.test"
CLIENT_ID = "sambee"
REDIRECT_URI = "https://sambee.example.test/api/auth/oidc/callback"


def _metadata_document(issuer: str = ISSUER, **overrides: Any) -> dict[str, Any]:
    document: dict[str, Any] = {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/authorize",
        "token_endpoint": f"{issuer}/token",
        "jwks_uri": f"{issuer}/jwks",
        "userinfo_endpoint": f"{issuer}/userinfo",
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["client_secret_basic"],
        "id_token_signing_alg_values_supported": ["RS256"],
    }
    document.update(overrides)
    return document


def _metadata() -> OidcProviderMetadata:
    return OidcProviderMetadata(
        issuer=ISSUER,
        authorization_endpoint=f"{ISSUER}/authorize",
        token_endpoint=f"{ISSUER}/token",
        jwks_uri=f"{ISSUER}/jwks",
        userinfo_endpoint=f"{ISSUER}/userinfo",
        id_token_signing_alg_values_supported=("RS256",),
        scopes_supported=("openid", "profile", "groups"),
    )


def _key_material(key_id: str) -> tuple[bytes, dict[str, Any]]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    public_jwk = RSAKey.import_key(public_pem, {"kid": key_id, "use": "sig", "alg": "RS256"}).as_dict()
    return private_pem, {"keys": [public_jwk]}


def _id_token(private_key: Any, key_id: str, *, nonce: str, now: int, claims: dict[str, Any] | None = None) -> str:
    payload: dict[str, Any] = {
        "iss": ISSUER,
        "sub": "provider-subject",
        "aud": CLIENT_ID,
        "exp": now + 300,
        "iat": now,
        "nonce": nonce,
        "preferred_username": "alice",
        "groups": ["sambee-users"],
    }
    payload.update(claims or {})
    signing_key = RSAKey.import_key(private_key, {"kid": key_id, "use": "sig", "alg": "RS256"})
    return jwt.encode({"alg": "RS256", "kid": key_id}, payload, signing_key)


def _access_token_hash(access_token: str) -> str:
    digest = hashlib.sha256(access_token.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest[: len(digest) // 2]).rstrip(b"=").decode("ascii")


async def _exchange_callback(
    token_response: dict[str, Any],
    *,
    jwks: dict[str, Any],
    refresh_jwks: Any,
    metadata: OidcProviderMetadata | None = None,
) -> NormalizedOidcClaims:
    transport = httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "application/json"}, json=token_response))
    async with ValidatedOidcHttpClient(transport=transport, development=False) as client:
        return await exchange_and_validate_callback(
            client,
            _metadata() if metadata is None else metadata,
            jwks,
            client_id=CLIENT_ID,
            client_secret="client-secret",
            redirect_uri=REDIRECT_URI,
            code="authorization-code",
            code_verifier="v" * 64,
            nonce="nonce-value",
            mapping=OidcClaimMapping(username="preferred_username", groups="groups", name="name", email="email"),
            refresh_jwks=refresh_jwks,
            now=int(time.time()),
        )


@pytest.mark.asyncio
async def test_refresh_marks_post_grant_token_validation_failure_uncertain() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"access_token": "provider-access-token", "id_token": "not-a-valid-jwt", "refresh_token": "rotated-token"},
        )
    )

    async def refresh_jwks() -> dict[str, Any]:
        return {"keys": []}

    async with ValidatedOidcHttpClient(transport=transport, development=False) as client:
        with pytest.raises(OidcRefreshError) as error:
            await exchange_and_validate_refresh_token(
                client,
                _metadata(),
                {"keys": []},
                client_id=CLIENT_ID,
                client_secret="client-secret",
                refresh_token="previous-token",
                expected_issuer=ISSUER,
                expected_subject="provider-subject",
                mapping=OidcClaimMapping(username="preferred_username", groups="groups", name="name", email="email"),
                refresh_jwks=refresh_jwks,
            )

    assert error.value.refresh_code == OidcRefreshErrorCode.AMBIGUOUS


@pytest.mark.asyncio
@pytest.mark.parametrize("issuer", [ISSUER, f"{ISSUER}/", f"{ISSUER}/application/o/storage/"])
async def test_metadata_requires_exact_issuer_and_loads_jwks_through_injected_transport(issuer: str) -> None:
    clear_oidc_provider_cache()
    requested_urls: list[str] = []
    endpoint_base = issuer.rstrip("/")

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        if request.url.path.endswith("openid-configuration"):
            return httpx.Response(
                200,
                headers={"content-type": "application/json"},
                json={
                    "issuer": issuer,
                    "authorization_endpoint": f"{endpoint_base}/authorize",
                    "token_endpoint": f"{endpoint_base}/token",
                    "jwks_uri": f"{endpoint_base}/jwks",
                    "userinfo_endpoint": f"{endpoint_base}/userinfo",
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "token_endpoint_auth_methods_supported": ["client_secret_basic"],
                    "id_token_signing_alg_values_supported": ["RS256"],
                },
            )
        return httpx.Response(200, headers={"content-type": "application/jwk-set+json"}, json={"keys": [{"kty": "RSA"}]})

    async with ValidatedOidcHttpClient(transport=httpx.MockTransport(handler), development=False) as client:
        metadata, jwks = await load_provider_metadata(client, issuer, development=False)

    assert metadata.issuer == issuer
    assert jwks["keys"] == [{"kty": "RSA"}]
    assert requested_urls == [f"{endpoint_base}/.well-known/openid-configuration", f"{endpoint_base}/jwks"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("issuer", "discovered_issuer"),
    [(ISSUER, f"{ISSUER}/different"), (ISSUER, f"{ISSUER}/"), (f"{ISSUER}/", ISSUER)],
)
async def test_metadata_rejects_issuer_mismatch(issuer: str, discovered_issuer: str) -> None:
    clear_oidc_provider_cache()
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={
                "issuer": discovered_issuer,
                "authorization_endpoint": f"{ISSUER}/authorize",
                "token_endpoint": f"{ISSUER}/token",
                "jwks_uri": f"{ISSUER}/jwks",
                "id_token_signing_alg_values_supported": ["RS256"],
            },
        )
    )
    async with ValidatedOidcHttpClient(transport=transport, development=False) as client:
        with patch("app.services.oidc_client.logger.warning") as log_warning:
            with pytest.raises(OidcClientError) as error:
                await load_provider_metadata(client, issuer, development=False)
    assert error.value.code == OidcClientErrorCode.INVALID_ISSUER
    assert str(error.value) == (
        f"OIDC discovery issuer does not exactly match the configured issuer: configured {issuer!r}, discovered {discovered_issuer!r}"
    )
    log_warning.assert_called_once_with(
        "OIDC discovery issuer does not match configured issuer: configured %r, discovered %r",
        issuer,
        discovered_issuer,
    )


@pytest.mark.asyncio
async def test_metadata_and_jwks_cache_honors_ttl_and_forced_key_refresh() -> None:
    clear_oidc_provider_cache()
    requested_paths: list[str] = []
    jwks_version = 1

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal jwks_version
        requested_paths.append(request.url.path)
        headers = {"content-type": "application/json", "cache-control": "public, max-age=7200"}
        if request.url.path.endswith("openid-configuration"):
            return httpx.Response(
                200,
                headers=headers,
                json={
                    "issuer": ISSUER,
                    "authorization_endpoint": f"{ISSUER}/authorize",
                    "token_endpoint": f"{ISSUER}/token",
                    "jwks_uri": f"{ISSUER}/jwks",
                    "id_token_signing_alg_values_supported": ["RS256"],
                },
            )
        return httpx.Response(200, headers=headers, json={"keys": [{"kty": "RSA", "kid": f"key-{jwks_version}"}]})

    async with ValidatedOidcHttpClient(transport=httpx.MockTransport(handler), development=False) as client:
        metadata, first_jwks = await load_provider_metadata(client, ISSUER, development=False)
        _, cached_jwks = await load_provider_metadata(client, ISSUER, development=False)
        jwks_version = 2
        refreshed_jwks = await refresh_provider_jwks(client, metadata)
        _, refreshed_cached_jwks = await load_provider_metadata(client, ISSUER, development=False)

    assert requested_paths == ["/.well-known/openid-configuration", "/jwks", "/jwks"]
    assert first_jwks == cached_jwks
    assert refreshed_jwks == refreshed_cached_jwks
    assert refreshed_jwks["keys"][0]["kid"] == "key-2"


def test_authorization_request_contains_state_nonce_and_pkce_s256() -> None:
    request = build_authorization_request(
        _metadata(),
        client_id=CLIENT_ID,
        redirect_uri=REDIRECT_URI,
        scopes=("openid", "profile", "groups"),
        state="state-value",
        nonce="nonce-value",
        code_verifier="v" * 64,
    )
    query = parse_qs(urlsplit(request.url).query)
    assert request.state == "state-value"
    assert query["state"] == ["state-value"]
    assert query["nonce"] == ["nonce-value"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"] != ["v" * 64]
    assert query["redirect_uri"] == [REDIRECT_URI]


@pytest.mark.asyncio
async def test_callback_uses_basic_auth_and_refreshes_unknown_key_once() -> None:
    now = int(time.time())
    private_key, current_jwks = _key_material("current-key")
    _, stale_jwks = _key_material("stale-key")
    encoded_token = _id_token(
        private_key,
        "current-key",
        nonce="nonce-value",
        now=now,
        claims={"at_hash": _access_token_hash("provider-access-token")},
    )
    refresh_count = 0

    async def refresh_jwks() -> dict[str, Any]:
        nonlocal refresh_count
        refresh_count += 1
        return current_jwks

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"].startswith("Basic ")
        body = parse_qs(request.content.decode())
        assert body["code_verifier"] == ["v" * 64]
        assert body["code"] == ["authorization-code"]
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"id_token": encoded_token, "access_token": "provider-access-token"},
        )

    async with ValidatedOidcHttpClient(transport=httpx.MockTransport(handler), development=False) as client:
        claims = await exchange_and_validate_callback(
            client,
            _metadata(),
            stale_jwks,
            client_id=CLIENT_ID,
            client_secret="client-secret",
            redirect_uri=REDIRECT_URI,
            code="authorization-code",
            code_verifier="v" * 64,
            nonce="nonce-value",
            mapping=OidcClaimMapping(username="preferred_username", groups="groups", name="name", email="email"),
            refresh_jwks=refresh_jwks,
            now=now,
        )

    assert refresh_count == 1
    assert claims.subject == "provider-subject"
    assert claims.username == "alice"
    assert claims.groups == ("sambee-users",)


@pytest.mark.asyncio
async def test_userinfo_is_called_once_and_must_match_id_token_subject() -> None:
    now = int(time.time())
    private_key, jwks = _key_material("current-key")
    encoded_token = _id_token(
        private_key,
        "current-key",
        nonce="nonce-value",
        now=now,
        claims={"preferred_username": None, "groups": None},
    )
    userinfo_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal userinfo_count
        if request.url.path == "/userinfo":
            userinfo_count += 1
            return httpx.Response(
                200,
                headers={"content-type": "application/json"},
                json={"sub": "different-subject", "preferred_username": "alice", "groups": ["sambee-users"]},
            )
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"id_token": encoded_token, "access_token": "provider-access-token"},
        )

    async def refresh_jwks() -> dict[str, Any]:
        raise AssertionError("known key must not refresh")

    async with ValidatedOidcHttpClient(transport=httpx.MockTransport(handler), development=False) as client:
        with pytest.raises(OidcClientError) as error:
            await exchange_and_validate_callback(
                client,
                _metadata(),
                jwks,
                client_id=CLIENT_ID,
                client_secret="client-secret",
                redirect_uri=REDIRECT_URI,
                code="authorization-code",
                code_verifier="v" * 64,
                nonce="nonce-value",
                mapping=OidcClaimMapping(username="preferred_username", groups="groups", name="name", email="email"),
                refresh_jwks=refresh_jwks,
                now=now,
            )

    assert error.value.code == OidcClientErrorCode.USERINFO_SUBJECT_MISMATCH
    assert userinfo_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("issuer", "token_issuer"),
    [(ISSUER, ISSUER), (f"{ISSUER}/", f"{ISSUER}/"), (ISSUER, f"{ISSUER}/"), (f"{ISSUER}/", ISSUER)],
)
async def test_callback_requires_exact_issuer_including_trailing_slash(issuer: str, token_issuer: str) -> None:
    now = int(time.time())
    private_key, jwks = _key_material("current-key")
    encoded_token = _id_token(private_key, "current-key", nonce="nonce-value", now=now, claims={"iss": token_issuer})

    async def refresh_jwks() -> dict[str, Any]:
        raise AssertionError("known key must not refresh")

    callback = _exchange_callback(
        {"id_token": encoded_token}, jwks=jwks, refresh_jwks=refresh_jwks, metadata=replace(_metadata(), issuer=issuer)
    )
    if token_issuer == issuer:
        claims = await callback
        assert claims.issuer == issuer
    else:
        with pytest.raises(OidcClientError) as error:
            await callback
        assert error.value.code == OidcClientErrorCode.INVALID_ID_TOKEN


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "claims",
    [
        {"iss": f"{ISSUER}/untrusted"},
        {"aud": "different-client"},
        {"exp": 0},
        {"nonce": "different-nonce"},
        {"auth_time": "not-a-timestamp"},
        {"amr": "not-a-list"},
        {"aud": [CLIENT_ID, "another-client"]},
        {"azp": None},
        {"at_hash": "invalid-access-token-hash"},
    ],
)
async def test_callback_rejects_invalid_oidc_claims(claims: dict[str, Any]) -> None:
    now = int(time.time())
    private_key, jwks = _key_material("current-key")
    encoded_token = _id_token(private_key, "current-key", nonce="nonce-value", now=now, claims=claims)

    async def refresh_jwks() -> dict[str, Any]:
        raise AssertionError("known key must not refresh")

    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"id_token": encoded_token, "access_token": "provider-access-token"},
        )
    )
    async with ValidatedOidcHttpClient(transport=transport, development=False) as client:
        with pytest.raises(OidcClientError) as error:
            await exchange_and_validate_callback(
                client,
                _metadata(),
                jwks,
                client_id=CLIENT_ID,
                client_secret="client-secret",
                redirect_uri=REDIRECT_URI,
                code="authorization-code",
                code_verifier="v" * 64,
                nonce="nonce-value",
                mapping=OidcClaimMapping(username="preferred_username", groups="groups", name="name", email="email"),
                refresh_jwks=refresh_jwks,
                now=now,
            )

    assert error.value.code == OidcClientErrorCode.INVALID_ID_TOKEN


@pytest.mark.asyncio
async def test_callback_rejects_invalid_id_token_signature() -> None:
    now = int(time.time())
    signing_key, _ = _key_material("current-key")
    _, jwks = _key_material("current-key")
    encoded_token = _id_token(signing_key, "current-key", nonce="nonce-value", now=now)

    async def refresh_jwks() -> dict[str, Any]:
        raise AssertionError("known key must not refresh")

    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"id_token": encoded_token, "access_token": "provider-access-token"},
        )
    )
    async with ValidatedOidcHttpClient(transport=transport, development=False) as client:
        with pytest.raises(OidcClientError) as error:
            await exchange_and_validate_callback(
                client,
                _metadata(),
                jwks,
                client_id=CLIENT_ID,
                client_secret="client-secret",
                redirect_uri=REDIRECT_URI,
                code="authorization-code",
                code_verifier="v" * 64,
                nonce="nonce-value",
                mapping=OidcClaimMapping(username="preferred_username", groups="groups", name="name", email="email"),
                refresh_jwks=refresh_jwks,
                now=now,
            )

    assert error.value.code == OidcClientErrorCode.INVALID_ID_TOKEN


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "overrides",
    [
        {"grant_types_supported": ["implicit"]},
        {"token_endpoint_auth_methods_supported": ["none"]},
        {"id_token_signing_alg_values_supported": ["ES256"]},
        {"grant_types_supported": "authorization_code"},
    ],
)
async def test_metadata_rejects_unsupported_or_malformed_capabilities(overrides: dict[str, Any]) -> None:
    clear_oidc_provider_cache()
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json=_metadata_document(**overrides),
        )
    )

    async with ValidatedOidcHttpClient(transport=transport, development=False) as client:
        with pytest.raises(OidcClientError) as error:
            await load_provider_metadata(client, ISSUER, development=False)

    assert error.value.code == OidcClientErrorCode.INVALID_METADATA


@pytest.mark.asyncio
async def test_metadata_rejects_invalid_jwks() -> None:
    clear_oidc_provider_cache()
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json=_metadata_document() if request.url.path.endswith("openid-configuration") else {"keys": []},
        )
    )

    async with ValidatedOidcHttpClient(transport=transport, development=False) as client:
        with pytest.raises(OidcClientError) as error:
            await load_provider_metadata(client, ISSUER, development=False)

    assert error.value.code == OidcClientErrorCode.INVALID_JWKS


@pytest.mark.asyncio
async def test_metadata_accepts_authorization_code_without_refresh_grant() -> None:
    clear_oidc_provider_cache()
    _, jwks = _key_material("code-only-key")
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json=jwks if request.url.path.endswith("/jwks") else _metadata_document(grant_types_supported=["authorization_code"]),
        )
    )

    async with ValidatedOidcHttpClient(transport=transport, development=False) as client:
        metadata, _ = await load_provider_metadata(client, ISSUER, development=False)

    assert metadata.grant_types_supported == ("authorization_code",)


@pytest.mark.asyncio
@pytest.mark.parametrize("cache_control", [None, "no-store", "private", "max-age=invalid"])
async def test_metadata_does_not_cache_without_a_valid_shared_cache_ttl(cache_control: str | None) -> None:
    clear_oidc_provider_cache()
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        headers = {"content-type": "application/json"}
        if cache_control is not None:
            headers["cache-control"] = cache_control
        return httpx.Response(
            200,
            headers=headers,
            json=_metadata_document() if request.url.path.endswith("openid-configuration") else {"keys": [{"kty": "RSA"}]},
        )

    async with ValidatedOidcHttpClient(transport=httpx.MockTransport(handler), development=False) as client:
        await load_provider_metadata(client, ISSUER, development=False)
        await load_provider_metadata(client, ISSUER, development=False)

    assert request_count == 4


@pytest.mark.asyncio
async def test_metadata_cache_evicts_the_least_recently_used_provider() -> None:
    clear_oidc_provider_cache()
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        request_count += 1
        issuer = str(request.url).removesuffix("/.well-known/openid-configuration")
        if request.url.path.endswith("openid-configuration"):
            return httpx.Response(
                200,
                headers={"content-type": "application/json", "cache-control": "max-age=600"},
                json=_metadata_document(issuer),
            )
        return httpx.Response(
            200,
            headers={"content-type": "application/json", "cache-control": "max-age=600"},
            json={"keys": [{"kty": "RSA"}]},
        )

    issuers = tuple(f"https://idp-{index}.example.test" for index in range(OIDC_PROVIDER_CACHE_MAX_ENTRIES + 1))
    async with ValidatedOidcHttpClient(transport=httpx.MockTransport(handler), development=False) as client:
        for issuer in issuers:
            await load_provider_metadata(client, issuer, development=False)
        await load_provider_metadata(client, issuers[0], development=False)

    assert request_count == 2 * (len(issuers) + 1)


@pytest.mark.asyncio
async def test_callback_rejects_malformed_header_and_failed_key_refresh() -> None:
    private_key, current_jwks = _key_material("current-key")
    _, stale_jwks = _key_material("stale-key")
    encoded_token = _id_token(private_key, "current-key", nonce="nonce-value", now=int(time.time()))

    async def refresh_stale_jwks() -> dict[str, Any]:
        return stale_jwks

    with pytest.raises(OidcClientError) as malformed_error:
        await _exchange_callback({"id_token": "not-a-jwt"}, jwks=current_jwks, refresh_jwks=refresh_stale_jwks)
    assert malformed_error.value.code == OidcClientErrorCode.INVALID_ID_TOKEN

    with pytest.raises(OidcClientError) as refresh_error:
        await _exchange_callback({"id_token": encoded_token}, jwks=stale_jwks, refresh_jwks=refresh_stale_jwks)
    assert refresh_error.value.code == OidcClientErrorCode.INVALID_ID_TOKEN


@pytest.mark.asyncio
async def test_callback_rejects_invalid_refreshed_jwks_and_token_response() -> None:
    private_key, current_jwks = _key_material("current-key")
    _, stale_jwks = _key_material("stale-key")
    encoded_token = _id_token(private_key, "current-key", nonce="nonce-value", now=int(time.time()))

    async def refresh_invalid_jwks() -> dict[str, Any]:
        return {"keys": []}

    with pytest.raises(OidcClientError) as jwks_error:
        await _exchange_callback({"id_token": encoded_token}, jwks=stale_jwks, refresh_jwks=refresh_invalid_jwks)
    assert jwks_error.value.code == OidcClientErrorCode.INVALID_JWKS

    async def refresh_jwks() -> dict[str, Any]:
        return current_jwks

    for response in ({}, {"id_token": 1}):
        with pytest.raises(OidcClientError) as token_error:
            await _exchange_callback(response, jwks=current_jwks, refresh_jwks=refresh_jwks)
        assert token_error.value.code == OidcClientErrorCode.TOKEN_EXCHANGE_FAILED


@pytest.mark.asyncio
async def test_callback_accepts_valid_oidc_optional_claims_and_multi_audience() -> None:
    now = int(time.time())
    private_key, jwks = _key_material("current-key")
    encoded_token = _id_token(
        private_key,
        "current-key",
        nonce="nonce-value",
        now=now,
        claims={"aud": [CLIENT_ID, "another-client"], "azp": CLIENT_ID, "auth_time": now - 10, "amr": ["pwd", "mfa"]},
    )

    async def refresh_jwks() -> dict[str, Any]:
        raise AssertionError("known key must not refresh")

    claims = await _exchange_callback({"id_token": encoded_token}, jwks=jwks, refresh_jwks=refresh_jwks)

    assert claims.subject == "provider-subject"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "claims",
    [
        {"sub": None},
        {"exp": None},
        {"iat": None},
        {"nbf": 2**31},
        {"iat": 2**31},
        {"at_hash": "invalid-access-token-hash"},
    ],
)
async def test_callback_rejects_missing_or_out_of_range_claims(claims: dict[str, Any]) -> None:
    private_key, jwks = _key_material("current-key")
    encoded_token = _id_token(private_key, "current-key", nonce="nonce-value", now=int(time.time()), claims=claims)

    async def refresh_jwks() -> dict[str, Any]:
        raise AssertionError("known key must not refresh")

    with pytest.raises(OidcClientError) as error:
        await _exchange_callback({"id_token": encoded_token}, jwks=jwks, refresh_jwks=refresh_jwks)

    assert error.value.code == OidcClientErrorCode.INVALID_ID_TOKEN


@pytest.mark.asyncio
async def test_userinfo_fallback_recovers_required_claims() -> None:
    now = int(time.time())
    private_key, jwks = _key_material("current-key")
    encoded_token = _id_token(
        private_key,
        "current-key",
        nonce="nonce-value",
        now=now,
        claims={"preferred_username": None, "groups": None},
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/userinfo":
            return httpx.Response(
                200,
                headers={"content-type": "application/json"},
                json={"sub": "provider-subject", "preferred_username": "alice", "groups": ["sambee-users"]},
            )
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"id_token": encoded_token, "access_token": "provider-access-token"},
        )

    async def refresh_jwks() -> dict[str, Any]:
        raise AssertionError("known key must not refresh")

    async with ValidatedOidcHttpClient(transport=httpx.MockTransport(handler), development=False) as client:
        claims = await exchange_and_validate_callback(
            client,
            _metadata(),
            jwks,
            client_id=CLIENT_ID,
            client_secret="client-secret",
            redirect_uri=REDIRECT_URI,
            code="authorization-code",
            code_verifier="v" * 64,
            nonce="nonce-value",
            mapping=OidcClaimMapping(username="preferred_username", groups="groups", name="name", email="email"),
            refresh_jwks=refresh_jwks,
            now=now,
        )

    assert claims.username == "alice"
    assert claims.groups == ("sambee-users",)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "metadata,access_token,expected_code",
    [
        (_metadata(), None, OidcClientErrorCode.USERINFO_UNAVAILABLE),
        (
            OidcProviderMetadata(
                issuer=ISSUER,
                authorization_endpoint=f"{ISSUER}/authorize",
                token_endpoint=f"{ISSUER}/token",
                jwks_uri=f"{ISSUER}/jwks",
                userinfo_endpoint=None,
                id_token_signing_alg_values_supported=("RS256",),
                scopes_supported=("openid",),
            ),
            "provider-access-token",
            OidcClientErrorCode.USERINFO_UNAVAILABLE,
        ),
    ],
)
async def test_userinfo_fallback_requires_an_endpoint_and_access_token(
    metadata: OidcProviderMetadata,
    access_token: str | None,
    expected_code: OidcClientErrorCode,
) -> None:
    now = int(time.time())
    private_key, jwks = _key_material("current-key")
    encoded_token = _id_token(
        private_key,
        "current-key",
        nonce="nonce-value",
        now=now,
        claims={"preferred_username": None, "groups": None},
    )

    async def refresh_jwks() -> dict[str, Any]:
        raise AssertionError("known key must not refresh")

    response = {"id_token": encoded_token}
    if access_token is not None:
        response["access_token"] = access_token
    with pytest.raises(OidcClientError) as error:
        await _exchange_callback(response, jwks=jwks, refresh_jwks=refresh_jwks, metadata=metadata)

    assert error.value.code == expected_code


@pytest.mark.asyncio
async def test_userinfo_fallback_rejects_missing_required_claims() -> None:
    now = int(time.time())
    private_key, jwks = _key_material("current-key")
    encoded_token = _id_token(
        private_key,
        "current-key",
        nonce="nonce-value",
        now=now,
        claims={"preferred_username": None, "groups": None},
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/userinfo":
            return httpx.Response(
                200,
                headers={"content-type": "application/json"},
                json={"sub": "provider-subject"},
            )
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"id_token": encoded_token, "access_token": "provider-access-token"},
        )

    async def refresh_jwks() -> dict[str, Any]:
        raise AssertionError("known key must not refresh")

    async with ValidatedOidcHttpClient(transport=httpx.MockTransport(handler), development=False) as client:
        with pytest.raises(OidcClientError) as error:
            await exchange_and_validate_callback(
                client,
                _metadata(),
                jwks,
                client_id=CLIENT_ID,
                client_secret="client-secret",
                redirect_uri=REDIRECT_URI,
                code="authorization-code",
                code_verifier="v" * 64,
                nonce="nonce-value",
                mapping=OidcClaimMapping(username="preferred_username", groups="groups", name="name", email="email"),
                refresh_jwks=refresh_jwks,
                now=now,
            )

    assert error.value.code == OidcClientErrorCode.REQUIRED_CLAIM_MISSING
