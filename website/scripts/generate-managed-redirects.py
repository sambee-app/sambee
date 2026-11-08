"""Generate configurable managed redirects in the built Cloudflare Pages artifact."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import tomllib
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path
from urllib.parse import urlparse

from docs_editor.migrations import (
    REGISTRY_PATH,
    UNVERSIONED,
    load_registry,
    transition_decisions,
)

WEBSITE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = WEBSITE_DIR / "data" / "managed-redirects.toml"
DEFAULT_LEGACY_REDIRECTS_PATH = WEBSITE_DIR / "platform-redirects.txt"
DEFAULT_OUTPUT_PATH = WEBSITE_DIR / "public" / "_redirects"
MANAGED_REDIRECT_PREFIX = "/mr/"
MANAGED_REDIRECT_STATUS = "302"
STATIC_LIMIT = 2000
DYNAMIC_LIMIT = 100
RULE_LENGTH_LIMIT = 1000


class ManagedRedirectError(ValueError):
    """Raised when the managed redirect registry cannot be safely generated."""


@dataclass(frozen=True)
class ManagedRedirect:
    """One immutable public source path and its configurable destination."""

    identifier: str
    source: str
    target: str


def validate_target(target: object, index: int) -> str:
    """Return a site-relative path or an external HTTPS target."""
    if (
        not isinstance(target, str)
        or not target
        or target != target.strip()
        or any(character.isspace() for character in target)
    ):
        raise ManagedRedirectError(
            f"redirects[{index}].target must be a non-empty URL without whitespace"
        )

    parsed = urlparse(target)
    if target.startswith("/") and not target.startswith("//"):
        if (
            parsed.netloc
            or any(segment in {".", ".."} for segment in parsed.path.split("/"))
            or any(character in target for character in "*\\")
        ):
            raise ManagedRedirectError(
                f"redirects[{index}].target is not a safe site-relative path"
            )
        return target
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ManagedRedirectError(
            f"redirects[{index}].target must be an absolute HTTPS URL without credentials"
        )
    return target


def load_manifest(path: Path) -> dict:
    """Load Hugo's authoritative route inventory and check its identity contract."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        raise ManagedRedirectError(f"Unsupported Hugo manifest schema in {path}")
    versions = [entry["slug"] for entry in data["versions"]]
    if len(versions) != len(set(versions)) or data["current"] not in versions:
        raise ManagedRedirectError(
            "Manifest versions must be unique and include current"
        )
    seen: set[str] = set()
    for route in data["routes"]:
        path_value = route["path"]
        version = route["version"]
        if version not in versions or route["sourceVersion"] not in versions:
            raise ManagedRedirectError(
                f"Unknown requested or source version at {path_value}"
            )
        if versions.index(route["sourceVersion"]) > versions.index(version):
            raise ManagedRedirectError(
                f"Route {path_value} inherits from a later declared version"
            )
        prefix = "/docs/" if route["space"] == "current" else f"/docs/{version}/"
        if (
            route["space"] not in {"current", "explicit"}
            or not path_value.startswith(prefix)
            or path_value == prefix
        ):
            raise ManagedRedirectError(f"Invalid route identity at {path_value}")
        if route["space"] == "current" and version != data["current"]:
            raise ManagedRedirectError(f"Current route has wrong version: {path_value}")
        if path_value in seen:
            raise ManagedRedirectError(f"Duplicate manifest route: {path_value}")
        seen.add(path_value)
    entry_sources = {entry["source"] for entry in data["entries"]}
    expected_entries = {"/docs/", *(f"/docs/{version}/" for version in versions)}
    if entry_sources != expected_entries or len(data["entries"]) != len(entry_sources):
        raise ManagedRedirectError(
            f"Manifest entry roots differ from known versions: {sorted(expected_entries ^ entry_sources)}"
        )
    return data


def complete_rules(
    manifest: dict,
    migrations: list[dict],
    managed: list[ManagedRedirect],
    platform: str,
    site_host: str,
) -> str:
    """Resolve and validate the complete Cloudflare rule set before publishing it."""
    pages = {route["path"] for route in manifest["routes"]} | set(
        manifest.get("siteRoutes", [])
    )
    rules: dict[str, tuple[str, str]] = {}

    def add(source: str, target: str, status: str) -> None:
        normalized = source.rstrip("/") + "/"
        if normalized in pages:
            raise ManagedRedirectError(
                f"Redirect {source} -> {target} overrides an HTTP 200 page"
            )
        if source in rules:
            raise ManagedRedirectError(
                f"Conflicting redirect source {source} -> {target}"
            )
        rules[source] = (target, status)

    def pair(source: str, target: str, status: str) -> None:
        add(source.rstrip("/"), target, status)
        add(source.rstrip("/") + "/", target, status)

    for entry in manifest["entries"]:
        pair(entry["source"], entry["target"], "302")
    versions = [entry["slug"] for entry in manifest["versions"]]
    current = manifest["current"]
    current_locations = {
        route["path"].removeprefix("/docs/")
        for route in manifest["routes"]
        if route["space"] == "current"
    }
    current_index = versions.index(current)
    if current_index:
        previous = versions[current_index - 1]
        previous_locations = {
            route["path"].removeprefix(f"/docs/{previous}/")
            for route in manifest["routes"]
            if route["space"] == "explicit" and route["version"] == previous
        }
        transition_decisions(previous_locations, current_locations, migrations)
    for migration in migrations:
        for scope in migration["scopes"]:
            if scope != UNVERSIONED and scope not in versions:
                raise ManagedRedirectError(
                    f"Unknown migration scope {scope} at {migration['source']}"
                )
            prefix = "/docs/" if scope == UNVERSIONED else f"/docs/{scope}/"
            source = prefix + migration["source"]
            if scope == UNVERSIONED and source in pages:
                continue
            target = migration.get("target")
            if target is not None:
                pair(source, prefix + target, "302" if scope == UNVERSIONED else "301")
            elif source in pages:
                raise ManagedRedirectError(f"Gone decision overrides page {source}")
    for line in platform.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split()
        if len(fields) != 3:
            raise ManagedRedirectError(f"Invalid platform rule: {line}")
        source, target, status = fields
        if (
            source == "/docs"
            or source.startswith("/docs/")
            or target == "/docs"
            or target.startswith("/docs/")
        ):
            raise ManagedRedirectError(
                f"Docs rule must be recorded in the migration registry: {line}"
            )
        if (
            not source.startswith("/")
            or source.startswith("//")
            or any(character in source for character in "?#\\")
        ):
            raise ManagedRedirectError(f"Invalid platform redirect source: {source}")
        add(source, validate_target(target, 0), status)

    def final_target(source: str) -> str:
        target = rules[source][0]
        visited = {source}
        while target in rules or target.rstrip("/") in rules:
            next_source = target if target in rules else target.rstrip("/")
            if next_source in visited:
                raise ManagedRedirectError(
                    f"Redirect loop at {source} -> {next_source}"
                )
            visited.add(next_source)
            target = rules[next_source][0]
        parsed_target = urlparse(target)
        if parsed_target.scheme:
            if parsed_target.hostname and parsed_target.hostname.lower().rstrip(
                "."
            ) in {site_host.lower().rstrip("."), "sambee.net", "www.sambee.net"}:
                raise ManagedRedirectError(
                    f"Redirect {source} uses the docs site host; use a site-relative target"
                )
            return target
        if target not in pages:
            raise ManagedRedirectError(
                f"Missing final page for {source} -> {target}; record a replacement or gone decision"
            )
        source_parts = source.strip("/").split("/")
        if len(source_parts) > 1 and source_parts[1] in versions:
            if not target.startswith(f"/docs/{source_parts[1]}/"):
                raise ManagedRedirectError(
                    f"Cross-version redirect {source} -> {target}"
                )
        elif source.startswith("/docs/") and any(
            target.startswith(f"/docs/{version}/") for version in versions
        ):
            raise ManagedRedirectError(
                f"Unversioned redirect targets an explicit page: {source} -> {target}"
            )
        return target

    rendered = [
        (source, final_target(source), status) for source, (_, status) in rules.items()
    ]
    for redirect in managed:
        target = redirect.target
        parsed = urlparse(target)
        if parsed.hostname and parsed.hostname.lower().rstrip(".") in {
            site_host.lower().rstrip("."),
            "sambee.net",
            "www.sambee.net",
        }:
            raise ManagedRedirectError(
                f"Managed source {redirect.source} uses the docs site host; use a site-relative target"
            )
        if not parsed.scheme:
            target_path = parsed.path
            if target_path in rules or target_path.rstrip("/") in rules:
                source = (
                    target_path if target_path in rules else target_path.rstrip("/")
                )
                raise ManagedRedirectError(
                    f"Managed source {redirect.source} targets redirect {target}; update the registry to {final_target(source)}"
                )
            if target_path not in pages:
                raise ManagedRedirectError(
                    f"Managed source {redirect.source} has missing target {target}"
                )
        add(redirect.source, target, MANAGED_REDIRECT_STATUS)
        rendered.append((redirect.source, target, MANAGED_REDIRECT_STATUS))

    def patterns_overlap(left: str, right: str) -> bool:
        left_parts, right_parts = left.split("/"), right.split("/")
        for left_part, right_part in zip(left_parts, right_parts):
            if "*" in left_part or "*" in right_part:
                if left_part.startswith(":") or right_part.startswith(":"):
                    return True
                left_prefix = left_part.split("*", 1)[0]
                right_prefix = right_part.split("*", 1)[0]
                if not (
                    left_prefix.startswith(right_prefix)
                    or right_prefix.startswith(left_prefix)
                ):
                    return False
                if "*" not in left_part:
                    return fnmatchcase(left_part, right_part)
                if "*" not in right_part:
                    return fnmatchcase(right_part, left_part)
                return True
            if (
                left_part != right_part
                and not left_part.startswith(":")
                and not right_part.startswith(":")
            ):
                return False
        return len(left_parts) == len(right_parts)

    static = [
        rule for rule in rendered if not any(character in rule[0] for character in "*:")
    ]
    dynamic = [rule for rule in rendered if rule not in static]
    if len(static) > STATIC_LIMIT or len(dynamic) > DYNAMIC_LIMIT:
        raise ManagedRedirectError(
            f"Cloudflare limits exceeded: {len(static)}/{STATIC_LIMIT} static, {len(dynamic)}/{DYNAMIC_LIMIT} dynamic; review an alternative"
        )
    for index, (source, target, status) in enumerate(rendered):
        if len(f"{source} {target} {status}") > RULE_LENGTH_LIMIT:
            raise ManagedRedirectError(
                f"Cloudflare rule length exceeded: {source} -> {target}"
            )
        if status not in {"301", "302", "303", "307", "308"}:
            raise ManagedRedirectError(
                f"Unsupported redirect status {status} at {source}"
            )
        pattern = "/".join(
            "*" if segment.startswith(":") else segment for segment in source.split("/")
        )
        for page in pages:
            if fnmatchcase(page, pattern) or fnmatchcase(page.rstrip("/"), pattern):
                raise ManagedRedirectError(
                    f"Redirect {source} -> {target} overrides an HTTP 200 page {page}"
                )
        for other_source, _, _ in rendered[index + 1 :]:
            if patterns_overlap(source, other_source):
                raise ManagedRedirectError(
                    f"Ambiguous redirect overlap: {source} and {other_source}"
                )
    return "# Generated HTTP redirects; do not edit.\n" + "".join(
        f"{source} {target} {status}\n"
        for source, target, status in sorted(static) + sorted(dynamic)
    )


def validate_source(source: object, index: int) -> str:
    """Return one canonical immutable managed redirect source path."""
    if not isinstance(source, str) or not source.startswith(MANAGED_REDIRECT_PREFIX):
        raise ManagedRedirectError(
            f"redirects[{index}].source must start with {MANAGED_REDIRECT_PREFIX}"
        )
    if (
        source.endswith("/")
        or "//" in source
        or "/./" in source
        or "/../" in source
        or any(character.isspace() for character in source)
        or any(character in source for character in "?#*:\\")
    ):
        raise ManagedRedirectError(
            f"redirects[{index}].source must be a canonical literal path without a trailing slash, query, fragment, or wildcard"
        )
    return source


def load_managed_redirects(config_path: Path) -> list[ManagedRedirect]:
    """Load and validate the managed redirect registry."""
    if not config_path.is_file():
        raise ManagedRedirectError(f"managed redirects file is missing: {config_path}")

    with config_path.open("rb") as file:
        data = tomllib.load(file)

    entries = data.get("redirects")
    if not isinstance(entries, list) or not entries:
        raise ManagedRedirectError(
            "managed redirects file must define at least one [[redirects]] entry"
        )

    redirects: list[ManagedRedirect] = []
    identifiers: set[str] = set()
    sources: set[str] = set()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ManagedRedirectError(f"redirects[{index}] must be a table")
        identifier = entry.get("id")
        if (
            not isinstance(identifier, str)
            or not identifier
            or identifier != identifier.strip()
        ):
            raise ManagedRedirectError(
                f"redirects[{index}].id must be a non-empty string"
            )
        if identifier in identifiers:
            raise ManagedRedirectError(
                f"redirects[{index}].id duplicates {identifier!r}"
            )

        source = validate_source(entry.get("source"), index)
        if source in sources:
            raise ManagedRedirectError(
                f"redirects[{index}].source duplicates {source!r}"
            )

        redirects.append(
            ManagedRedirect(
                identifier, source, validate_target(entry.get("target"), index)
            )
        )
        identifiers.add(identifier)
        sources.add(source)

    return sorted(redirects, key=lambda redirect: redirect.source)


def generate(
    config_path: Path,
    legacy_redirects_path: Path,
    output_path: Path,
    manifest_path: Path | None = None,
    migrations_path: Path | None = None,
    site_host: str = "sambee.net",
) -> list[ManagedRedirect]:
    """Generate the deployable redirect file and return its managed entries."""
    redirects = load_managed_redirects(config_path)
    legacy_redirects = legacy_redirects_path.read_text(encoding="utf-8")
    manifest = load_manifest(manifest_path or output_path.parent / "docs-routes.json")
    registry_path = migrations_path or WEBSITE_DIR / REGISTRY_PATH
    if not registry_path.is_file():
        raise ManagedRedirectError(f"Migration registry is missing: {registry_path}")
    content = complete_rules(
        manifest, load_registry(registry_path), redirects, legacy_redirects, site_host
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=output_path.parent, delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            temporary_file.write(content)
        os.replace(temporary_path, output_path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return redirects


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse generator paths for production, preview, and test builds."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument(
        "--legacy-redirects", type=Path, default=DEFAULT_LEGACY_REDIRECTS_PATH
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--migrations", type=Path, default=WEBSITE_DIR / REGISTRY_PATH)
    parser.add_argument(
        "--site-host",
        default=urlparse(os.environ.get("HUGO_BASEURL", "https://sambee.net/")).hostname
        or "sambee.net",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    """Generate managed redirects and report the output location."""
    try:
        args = parse_args(argv)
        redirects = generate(
            args.config,
            args.legacy_redirects,
            args.output,
            args.manifest,
            args.migrations,
            args.site_host,
        )
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f"Managed redirect generation failed: {error}", file=sys.stderr)
        return 1

    lines = [
        line
        for line in args.output.read_text().splitlines()
        if line and not line.startswith("#")
    ]
    dynamic_count = sum(
        any(character in line.split()[0] for character in "*:") for line in lines
    )
    print(
        f"Generated {len(lines) - dynamic_count} static and {dynamic_count} dynamic rules, including {len(redirects)} managed redirects, in {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
