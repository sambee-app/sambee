"""Memory-bounded breadth-first queue for live-search directories."""

from collections import deque
from dataclasses import dataclass

from app.core.filesystem_search_contract import LIMITS
from app.core.search_scope import validate_directory_path


class SearchFrontierFull(RuntimeError):
    """The search must stop with partial coverage instead of dropping a folder."""


@dataclass(frozen=True)
class PendingDirectory:
    path: str
    expected_id: bytes | None
    cost: int


class SearchFrontier:
    def __init__(self) -> None:
        self._pending: deque[PendingDirectory] = deque()
        self._bytes = 0

    def enqueue(self, path: str, expected_id: bytes | None = None) -> None:
        if path:
            validate_directory_path(path)
        cost = len(path.encode("utf-8", errors="strict")) + len(expected_id or b"") + LIMITS["pending_directory_entry_bytes"]
        if cost > LIMITS["pending_directory_bytes"] - self._bytes:
            raise SearchFrontierFull("The search reached its folder queue limit. Search a smaller folder and try again.")
        self._pending.append(PendingDirectory(path, expected_id, cost))
        self._bytes += cost

    def pop(self) -> PendingDirectory:
        pending = self._pending.popleft()
        self._bytes -= pending.cost
        return pending

    def __bool__(self) -> bool:
        return bool(self._pending)

    @property
    def pending_bytes(self) -> int:
        return self._bytes
