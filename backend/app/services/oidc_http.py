import ipaddress
import json
import logging
import socket
import ssl
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from dataclasses import dataclass
from enum import IntEnum
from time import monotonic
from types import TracebackType
from typing import Any, Final, Protocol, cast
from urllib.parse import urlsplit

import anyio
import httpcore
import httpx

from app.core.environment import IS_DEVELOPMENT
from app.core.logging import http_summary_active

logger = logging.getLogger("app.protocol.http")
MILLISECONDS_PER_SECOND: Final = 1000
CONNECT_TIMEOUT_SECONDS: Final = 3.0
READ_TIMEOUT_SECONDS: Final = 5.0
DISCOVERY_RESPONSE_LIMIT_BYTES: Final = 1024 * 1024
JWKS_RESPONSE_LIMIT_BYTES: Final = 1024 * 1024
TOKEN_RESPONSE_LIMIT_BYTES: Final = 256 * 1024
USERINFO_RESPONSE_LIMIT_BYTES: Final = 256 * 1024
MAX_CONCURRENT_OIDC_REQUESTS: Final = 4
OIDC_CACHE_MAX_AGE_SECONDS: Final = 60 * 60
ID_TOKEN_CLOCK_SKEW_SECONDS: Final = 60
MAX_FUTURE_IAT_SECONDS: Final = 60
PRE_CALLBACK_FLOW_LIFETIME_SECONDS: Final = 5 * 60
VALIDATED_TEST_FLOW_LIFETIME_SECONDS: Final = 30 * 60
LOGIN_GRANT_LIFETIME_SECONDS: Final = 60
OIDC_SESSION_LIFETIME_MINUTES: Final = 60

_OIDC_REQUEST_LIMITER = anyio.CapacityLimiter(MAX_CONCURRENT_OIDC_REQUESTS)

SocketOption = tuple[int, int, int] | tuple[int, int, bytes | bytearray] | tuple[int, int, None, int]
AddressResolver = Callable[[str, int], Awaitable[list[str]]]


class _CoreAsyncByteStream(Protocol):
    def __aiter__(self) -> AsyncIterator[bytes]: ...

    async def aclose(self) -> None: ...


class OidcHttpErrorCode(IntEnum):
    INVALID_URL = 1
    FORBIDDEN_ADDRESS = 2
    DNS_FAILURE = 3
    REDIRECT_REJECTED = 4
    RESPONSE_TOO_LARGE = 5
    INVALID_CONTENT_TYPE = 6
    INVALID_JSON = 7
    REQUEST_FAILED = 8


class OidcHttpError(Exception):
    def __init__(self, code: OidcHttpErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class OidcJsonResponse:
    data: dict[str, Any]
    headers: httpx.Headers
    status_code: int


def _is_literal_loopback(hostname: str) -> bool:
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return hostname.lower() == "localhost"


def validate_oidc_url(url: str, *, development: bool = IS_DEVELOPMENT) -> None:
    parsed = urlsplit(url)
    if not parsed.scheme or not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise OidcHttpError(OidcHttpErrorCode.INVALID_URL, "OIDC URL must be absolute and must not contain user information")
    if parsed.fragment:
        raise OidcHttpError(OidcHttpErrorCode.INVALID_URL, "OIDC URL must not contain a fragment")
    if parsed.scheme == "https":
        return
    if parsed.scheme == "http" and development and _is_literal_loopback(parsed.hostname):
        return
    raise OidcHttpError(OidcHttpErrorCode.INVALID_URL, "OIDC URL must use HTTPS")


def validate_resolved_address(address: str, *, development: bool = IS_DEVELOPMENT) -> None:
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError as error:
        raise OidcHttpError(OidcHttpErrorCode.DNS_FAILURE, "OIDC hostname resolved to an invalid address") from error

    forbidden = parsed.is_unspecified or parsed.is_multicast or parsed.is_link_local or parsed.is_reserved
    if parsed.is_loopback and not development:
        forbidden = True
    if forbidden:
        raise OidcHttpError(OidcHttpErrorCode.FORBIDDEN_ADDRESS, "OIDC hostname resolved to a forbidden address")


async def resolve_addresses(host: str, port: int) -> list[str]:
    try:
        results = await anyio.to_thread.run_sync(socket.getaddrinfo, host, port, 0, socket.SOCK_STREAM)
    except OSError as error:
        raise OidcHttpError(OidcHttpErrorCode.DNS_FAILURE, "OIDC hostname could not be resolved") from error
    addresses = list(dict.fromkeys(cast(tuple[Any, ...], result)[4][0] for result in results))
    if not addresses:
        raise OidcHttpError(OidcHttpErrorCode.DNS_FAILURE, "OIDC hostname did not resolve to an address")
    return addresses


class ValidatedNetworkBackend(httpcore.AsyncNetworkBackend):
    def __init__(
        self,
        *,
        resolver: AddressResolver = resolve_addresses,
        development: bool = IS_DEVELOPMENT,
    ) -> None:
        self._resolver = resolver
        self._development = development
        self._backend = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[SocketOption] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        addresses = await self._resolver(host, port)
        for address in addresses:
            validate_resolved_address(address, development=self._development)
        return await self._backend.connect_tcp(addresses[0], port, timeout, local_address, socket_options)

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[SocketOption] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise OidcHttpError(OidcHttpErrorCode.INVALID_URL, "Unix sockets are not valid OIDC destinations")

    async def sleep(self, seconds: float) -> None:
        await self._backend.sleep(seconds)


class ValidatedOidcTransport(httpx.AsyncBaseTransport):
    def __init__(self, *, resolver: AddressResolver = resolve_addresses, development: bool = IS_DEVELOPMENT) -> None:
        ssl_context = ssl.create_default_context()
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl_context,
            network_backend=ValidatedNetworkBackend(resolver=resolver, development=development),
            max_connections=MAX_CONCURRENT_OIDC_REQUESTS,
            max_keepalive_connections=MAX_CONCURRENT_OIDC_REQUESTS,
            retries=0,
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._pool.handle_async_request(
            httpcore.Request(
                method=request.method,
                url=httpcore.URL(
                    scheme=request.url.raw_scheme,
                    host=request.url.raw_host,
                    port=request.url.port,
                    target=request.url.raw_path,
                ),
                headers=request.headers.raw,
                content=request.stream,
                extensions=request.extensions,
            )
        )
        return httpx.Response(
            status_code=response.status,
            headers=response.headers,
            stream=_HttpcoreAsyncByteStream(cast(_CoreAsyncByteStream, response.stream)),
            extensions=response.extensions,
        )

    async def aclose(self) -> None:
        await self._pool.aclose()


class _HttpcoreAsyncByteStream(httpx.AsyncByteStream):
    """Bridge HTTPCore's stream protocol to the interface HTTPX enforces."""

    def __init__(self, stream: _CoreAsyncByteStream) -> None:
        self._stream = stream

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self._stream:
            yield chunk

    async def aclose(self) -> None:
        await self._stream.aclose()


class ValidatedOidcHttpClient:
    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        resolver: AddressResolver = resolve_addresses,
        development: bool = IS_DEVELOPMENT,
    ) -> None:
        self._client = httpx.AsyncClient(
            transport=transport or ValidatedOidcTransport(resolver=resolver, development=development),
            follow_redirects=False,
            timeout=httpx.Timeout(READ_TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS),
        )
        self._development = development

    async def __aenter__(self) -> "ValidatedOidcHttpClient":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request_json(
        self,
        method: str,
        url: str,
        *,
        response_limit: int,
        headers: dict[str, str] | None = None,
        data: dict[str, str] | None = None,
        auth: httpx.Auth | None = None,
        accepted_error_statuses: frozenset[int] = frozenset(),
    ) -> OidcJsonResponse:
        started = monotonic()
        context_token = http_summary_active.set(True)
        response: OidcJsonResponse | None = None
        response_status: int | None = None
        error_code: OidcHttpErrorCode | None = None
        error_type: str | None = None

        def capture_response_status(status_code: int) -> None:
            nonlocal response_status
            response_status = status_code

        try:
            response = await self._request_json(
                method,
                url,
                response_limit=response_limit,
                headers=headers,
                data=data,
                auth=auth,
                accepted_error_statuses=accepted_error_statuses,
                on_response_status=capture_response_status,
            )
            return response
        except OidcHttpError as error:
            error_code = error.code
            error_type = type(error).__name__
            raise
        except BaseException as error:
            error_type = type(error).__name__
            raise
        finally:
            http_summary_active.reset(context_token)
            if logger.isEnabledFor(logging.INFO):
                try:
                    destination = urlsplit(url)
                    host, path = destination.hostname, destination.path
                except ValueError:
                    host, path = None, None
                logger.info(
                    "event=http_client method=%r host=%r path=%r status=%s duration_ms=%.1f outcome=%s error_code=%s error_type=%r",
                    method,
                    host,
                    path,
                    response_status,
                    (monotonic() - started) * MILLISECONDS_PER_SECOND,
                    "success" if response else "failed",
                    error_code.name if error_code else None,
                    error_type,
                )

    async def _request_json(
        self,
        method: str,
        url: str,
        *,
        response_limit: int,
        headers: dict[str, str] | None,
        data: dict[str, str] | None,
        auth: httpx.Auth | None,
        accepted_error_statuses: frozenset[int],
        on_response_status: Callable[[int], None],
    ) -> OidcJsonResponse:
        validate_oidc_url(url, development=self._development)
        try:
            async with _OIDC_REQUEST_LIMITER:
                async with self._client.stream(method, url, headers=headers, data=data, auth=auth) as response:
                    on_response_status(response.status_code)
                    if response.is_redirect:
                        raise OidcHttpError(OidcHttpErrorCode.REDIRECT_REJECTED, "OIDC endpoint redirects are not allowed")
                    if response.status_code not in accepted_error_statuses:
                        response.raise_for_status()
                    content_type = response.headers.get("content-type", "").partition(";")[0].strip().lower()
                    if content_type not in {"application/json", "application/jwk-set+json"}:
                        raise OidcHttpError(OidcHttpErrorCode.INVALID_CONTENT_TYPE, "OIDC endpoint returned a non-JSON response")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > response_limit:
                            raise OidcHttpError(OidcHttpErrorCode.RESPONSE_TOO_LARGE, "OIDC response exceeded its size limit")
        except OidcHttpError:
            raise
        except (httpx.HTTPError, OSError) as error:
            raise OidcHttpError(OidcHttpErrorCode.REQUEST_FAILED, "OIDC endpoint request failed") from error

        try:
            decoded = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise OidcHttpError(OidcHttpErrorCode.INVALID_JSON, "OIDC endpoint returned invalid JSON") from error
        if not isinstance(decoded, dict):
            raise OidcHttpError(OidcHttpErrorCode.INVALID_JSON, "OIDC endpoint JSON must be an object")
        return OidcJsonResponse(data=decoded, headers=response.headers, status_code=response.status_code)
