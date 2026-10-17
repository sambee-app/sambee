import hashlib
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network, ip_address, ip_network

from app.core.usernames import username_key

AUTHORIZATION_CAPACITY = 20
AUTHORIZATION_REFILL_SECONDS = 5 * 60
CALLBACK_CAPACITY = 60
CALLBACK_REFILL_SECONDS = 5 * 60
EXCHANGE_CAPACITY = 30
EXCHANGE_REFILL_SECONDS = 5 * 60
REFRESH_CAPACITY = 120
REFRESH_REFILL_SECONDS = 5 * 60
PASSWORD_IP_CAPACITY = 10
PASSWORD_IP_REFILL_SECONDS = 5 * 60
PASSWORD_USERNAME_CAPACITY = 10
PASSWORD_USERNAME_REFILL_SECONDS = 15 * 60
RATE_LIMIT_MAX_KEYS = 10_000


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after_seconds: int = 0


@dataclass
class _Bucket:
    tokens: float
    updated_at: float
    last_used_at: float


class _BucketStore:
    def __init__(self, capacity: int, refill_seconds: int, max_keys: int) -> None:
        self.capacity = capacity
        self.refill_rate = capacity / refill_seconds
        self.refill_seconds = refill_seconds
        self.max_keys = max_keys
        self.buckets: OrderedDict[str, _Bucket] = OrderedDict()

    def get(self, key: str, now: float) -> _Bucket:
        bucket = self.buckets.get(key)
        if bucket is None:
            self._make_room(now)
            bucket = _Bucket(tokens=float(self.capacity), updated_at=now, last_used_at=now)
            self.buckets[key] = bucket
        else:
            self._refill(bucket, now)
            bucket.last_used_at = now
            self.buckets.move_to_end(key)
        return bucket

    def retry_after(self, bucket: _Bucket) -> int:
        return max(1, math.ceil((1 - bucket.tokens) / self.refill_rate))

    def _refill(self, bucket: _Bucket, now: float) -> None:
        elapsed = max(0.0, now - bucket.updated_at)
        bucket.tokens = min(float(self.capacity), bucket.tokens + elapsed * self.refill_rate)
        bucket.updated_at = now

    def _make_room(self, now: float) -> None:
        if len(self.buckets) < self.max_keys:
            return
        for key, bucket in tuple(self.buckets.items()):
            self._refill(bucket, now)
            if bucket.tokens >= self.capacity and now - bucket.last_used_at >= self.refill_seconds:
                del self.buckets[key]
        while len(self.buckets) >= self.max_keys:
            self.buckets.popitem(last=False)


class AuthenticationRateLimiter:
    def __init__(self, *, clock: Callable[[], float] = time.monotonic, max_keys: int = RATE_LIMIT_MAX_KEYS) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._authorization = _BucketStore(AUTHORIZATION_CAPACITY, AUTHORIZATION_REFILL_SECONDS, max_keys)
        self._callback = _BucketStore(CALLBACK_CAPACITY, CALLBACK_REFILL_SECONDS, max_keys)
        self._exchange = _BucketStore(EXCHANGE_CAPACITY, EXCHANGE_REFILL_SECONDS, max_keys)
        self._refresh = _BucketStore(REFRESH_CAPACITY, REFRESH_REFILL_SECONDS, max_keys)
        self._password_ip = _BucketStore(PASSWORD_IP_CAPACITY, PASSWORD_IP_REFILL_SECONDS, max_keys)
        self._password_username = _BucketStore(PASSWORD_USERNAME_CAPACITY, PASSWORD_USERNAME_REFILL_SECONDS, max_keys)

    def check_authorization(self, source_ip: str) -> RateLimitDecision:
        return self._check_single(self._authorization, source_ip)

    def check_callback(self, source_ip: str) -> RateLimitDecision:
        return self._check_single(self._callback, source_ip)

    def check_exchange(self, source_ip: str) -> RateLimitDecision:
        return self._check_single(self._exchange, source_ip)

    def check_refresh(self, source_ip: str) -> RateLimitDecision:
        return self._check_single(self._refresh, source_ip)

    def check_password(self, source_ip: str, username: str) -> RateLimitDecision:
        normalized_username = hashlib.sha256(username_key(username).encode("utf-8")).hexdigest()
        with self._lock:
            now = self._clock()
            ip_bucket = self._password_ip.get(source_ip, now)
            username_bucket = self._password_username.get(normalized_username, now)
            if ip_bucket.tokens < 1 or username_bucket.tokens < 1:
                waits = [
                    store.retry_after(bucket)
                    for store, bucket in ((self._password_ip, ip_bucket), (self._password_username, username_bucket))
                    if bucket.tokens < 1
                ]
                return RateLimitDecision(allowed=False, retry_after_seconds=max(waits))
            ip_bucket.tokens -= 1
            username_bucket.tokens -= 1
            return RateLimitDecision(allowed=True)

    def reset(self) -> None:
        with self._lock:
            for store in (
                self._authorization,
                self._callback,
                self._exchange,
                self._refresh,
                self._password_ip,
                self._password_username,
            ):
                store.buckets.clear()

    def _check_single(self, store: _BucketStore, key: str) -> RateLimitDecision:
        with self._lock:
            bucket = store.get(key, self._clock())
            if bucket.tokens < 1:
                return RateLimitDecision(allowed=False, retry_after_seconds=store.retry_after(bucket))
            bucket.tokens -= 1
            return RateLimitDecision(allowed=True)


def resolve_source_ip(direct_peer: str | None, forwarded_for: str | None, trusted_proxy_cidrs: str) -> str:
    direct_address = _parse_address(direct_peer)
    if direct_address is None:
        return "unknown"
    trusted_networks = tuple(ip_network(value.strip(), strict=False) for value in trusted_proxy_cidrs.split(",") if value.strip())
    if not trusted_networks or not _is_trusted(direct_address, trusted_networks) or not forwarded_for:
        return str(direct_address)

    forwarded_addresses: list[IPv4Address | IPv6Address] = []
    for value in forwarded_for.split(","):
        address = _parse_address(value.strip())
        if address is None:
            return str(direct_address)
        forwarded_addresses.append(address)
    for address in reversed(forwarded_addresses):
        if not _is_trusted(address, trusted_networks):
            return str(address)
    return str(direct_address)


def _parse_address(value: str | None) -> IPv4Address | IPv6Address | None:
    if not value:
        return None
    try:
        return ip_address(value)
    except ValueError:
        return None


def _is_trusted(address: IPv4Address | IPv6Address, networks: tuple[IPv4Network | IPv6Network, ...]) -> bool:
    return any(address.version == network.version and address in network for network in networks)


authentication_rate_limiter = AuthenticationRateLimiter()
