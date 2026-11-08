"""Shared migration registry contract for the docs editor and HTTP generator."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
UNVERSIONED = "unversioned"
REGISTRY_PATH = Path("data/docs-migrations.json")


def location(value: Any) -> str:
    """Validate a logical book, section, or article location."""
    if (
        not isinstance(value, str)
        or not value.endswith("/")
        or value.startswith("/")
        or any(part in {"", ".", ".."} for part in value[:-1].split("/"))
        or any(character.isspace() or character in "?#*:\\%" for character in value)
    ):
        raise ValueError(
            f"Invalid docs migration location {value!r}; use book/section/page/."
        )
    return value


def load_registry(path: Path) -> list[dict[str, Any]]:
    """Load explicit migration decisions, rejecting duplicate scoped sources."""
    if not path.exists():
        return []
    document = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(document, dict)
        or document.get("schemaVersion") != SCHEMA_VERSION
    ):
        raise ValueError(f"Unsupported migration schema in {path}.")
    entries = document.get("migrations")
    if not isinstance(entries, list):
        raise TypeError(f"{path} must contain a migrations list.")
    seen: set[tuple[str, str]] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise TypeError(f"Invalid migration entry in {path}: {entry!r}.")
        source = location(entry.get("source"))
        if "target" not in entry:
            raise ValueError(
                f"Migration {source} must declare a target or explicit null gone decision."
            )
        if entry.get("target") is not None:
            location(entry["target"])
        scopes = entry.get("scopes")
        if (
            not isinstance(scopes, list)
            or not scopes
            or any(not isinstance(scope, str) or not scope for scope in scopes)
        ):
            raise ValueError(f"Migration {source} must declare non-empty scopes.")
        for scope in scopes:
            key = (scope, source)
            if key in seen:
                raise ValueError(f"Duplicate migration for {scope}: {source}.")
            seen.add(key)
    return entries


def render_registry(entries: list[dict[str, Any]]) -> str:
    """Render the registry in a stable order."""
    return (
        json.dumps(
            {
                "schemaVersion": SCHEMA_VERSION,
                "migrations": sorted(
                    entries, key=lambda entry: (entry["source"], entry["scopes"])
                ),
            },
            indent=2,
        )
        + "\n"
    )


def transition_decisions(
    previous: set[str], current: set[str], entries: list[dict[str, Any]]
) -> dict[str, str | None]:
    """Require a final current replacement or a gone decision for removed routes."""
    aliases = {
        entry["source"]: entry.get("target")
        for entry in entries
        if UNVERSIONED in entry["scopes"]
    }
    decisions: dict[str, str | None] = {}
    missing: list[str] = []
    for source in sorted(previous - current):
        target = source
        visited: set[str] = set()
        while target not in current:
            if target in visited:
                raise ValueError(f"Migration loop for {source}: {target}.")
            visited.add(target)
            if target not in aliases:
                missing.append(f"/docs/{source} (unresolved target /docs/{target})")
                break
            replacement = aliases[target]
            if replacement is None:
                target = None
                break
            target = replacement
        decisions[source] = target
    if missing:
        raise ValueError(
            f"Each removed unversioned route needs a replacement or gone decision in {REGISTRY_PATH}:\n"
            + "\n".join(missing)
        )
    return decisions
