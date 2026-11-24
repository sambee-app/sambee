"""In-process admission for live-search workers."""

from enum import StrEnum
from threading import Lock


class SearchAdmissionReason(StrEnum):
    RUNNING = "running"
    STOPPING = "stopping"


class SearchAdmissionError(RuntimeError):
    def __init__(self, reason: SearchAdmissionReason) -> None:
        self.reason = reason
        if reason is SearchAdmissionReason.RUNNING:
            message = "A search is already running for this source. Stop it or try again shortly."
        else:
            message = "The previous search is still stopping. Try again shortly."
        super().__init__(message)


class SearchAdmission:
    """Track slots by authoritative account and connection until worker cleanup."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._active: dict[tuple[str, str], dict[object, bool]] = {}

    def admit(self, account_id: str, connection_id: str, limit: int) -> "SearchLease":
        if not account_id or not connection_id or type(limit) is not int or limit <= 0:
            raise ValueError("Search admission requires an account, a connection, and a positive limit.")
        key = (account_id, connection_id)
        with self._lock:
            active = self._active.setdefault(key, {})
            if len(active) >= limit:
                reason = SearchAdmissionReason.STOPPING if all(active.values()) else SearchAdmissionReason.RUNNING
                raise SearchAdmissionError(reason)
            identifier = object()
            active[identifier] = False
        return SearchLease(self, key, identifier)

    def _stop(self, key: tuple[str, str], identifier: object) -> bool:
        with self._lock:
            active = self._active.get(key)
            if active is None or identifier not in active:
                return False
            active[identifier] = True
            return True

    def _release(self, key: tuple[str, str], identifier: object) -> None:
        with self._lock:
            active = self._active.get(key)
            if active is None or identifier not in active:
                return
            del active[identifier]
            if not active:
                del self._active[key]


class SearchLease:
    """The worker retains this lease until all its storage cleanup is complete."""

    def __init__(self, admission: SearchAdmission, key: tuple[str, str], identifier: object) -> None:
        self._admission = admission
        self._key = key
        self._identifier = identifier

    def stop_handle(self) -> "SearchStopHandle":
        return SearchStopHandle(self._admission, self._key, self._identifier)

    def release(self) -> None:
        self._admission._release(self._key, self._identifier)


class SearchStopHandle:
    """Mark a worker as stopping without releasing its admission slot."""

    def __init__(self, admission: SearchAdmission, key: tuple[str, str], identifier: object) -> None:
        self._admission = admission
        self._key = key
        self._identifier = identifier

    def stopping(self) -> bool:
        return self._admission._stop(self._key, self._identifier)
