"""Shared quick-navigation folder scope validation."""

from dataclasses import dataclass
from enum import Enum


class SearchScopeMode(str, Enum):
    SUBTREE = "subtree"
    DESCENDANTS_ONLY = "descendants_only"


@dataclass(frozen=True)
class SearchScope:
    path: str
    mode: SearchScopeMode


def validate_directory_path(path: str) -> None:
    path.encode("utf-8", errors="strict")
    if "\x00" in path or any(component in {"", ".", ".."} for component in path.split("/")):
        raise ValueError("Directory path must be relative and must not contain empty, dot, parent, or NUL components.")


def parse_search_scope(scope_path: str | None, scope_mode: str | None) -> SearchScope | None:
    """Validate the paired folder-scope parameters; an empty path is the source root."""
    if scope_path is None and scope_mode is None:
        return None
    if scope_path is None or scope_mode is None:
        raise ValueError("Provide both scope_path and scope_mode, or omit both.")
    try:
        mode = SearchScopeMode(scope_mode)
    except ValueError as exc:
        raise ValueError("Invalid scope_mode. Use subtree or descendants_only.") from exc
    path = scope_path
    if path:
        if any(ord(character) < 32 for character in path):
            raise ValueError("Scope path cannot contain control characters.")
        validate_directory_path(path)
    return SearchScope(path, mode)
