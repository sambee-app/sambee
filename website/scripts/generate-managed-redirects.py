"""Generate configurable managed redirects in the built Cloudflare Pages artifact."""

from __future__ import annotations

import argparse
import sys
import tomllib
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path
from urllib.parse import urlparse

WEBSITE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = WEBSITE_DIR / "data" / "managed-redirects.toml"
DEFAULT_LEGACY_REDIRECTS_PATH = WEBSITE_DIR / "static" / "_redirects"
DEFAULT_OUTPUT_PATH = WEBSITE_DIR / "public" / "_redirects"
MANAGED_REDIRECT_PREFIX = "/mr/"
MANAGED_REDIRECT_STATUS = "302"
GENERATED_HEADER = (
    "# Managed redirects. Generated from data/managed-redirects.toml; do not edit."
)


class ManagedRedirectError(ValueError):
    """Raised when the managed redirect registry cannot be safely generated."""


@dataclass(frozen=True)
class ManagedRedirect:
    """One immutable public source path and its configurable destination."""

    identifier: str
    source: str
    target: str


def parse_redirect_sources(redirects_path: Path) -> list[str]:
    """Return source patterns from existing redirect rules."""
    if not redirects_path.is_file():
        raise ManagedRedirectError(
            f"legacy redirects file is missing: {redirects_path}"
        )

    sources: list[str] = []
    for line_number, line in enumerate(
        redirects_path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        fields = stripped.split()
        if len(fields) < 3:
            raise ManagedRedirectError(
                f"{redirects_path}:{line_number}: expected source, target, and status"
            )
        sources.append(fields[0])
    return sources


def validate_target(target: object, index: int) -> str:
    """Return a safe absolute HTTPS redirect target."""
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


def validate_no_legacy_conflicts(
    redirects: list[ManagedRedirect], legacy_sources: list[str]
) -> None:
    """Reject managed source paths already matched by a legacy redirect rule."""
    for redirect in redirects:
        for legacy_source in legacy_sources:
            if fnmatchcase(redirect.source, legacy_source):
                raise ManagedRedirectError(
                    f"managed source {redirect.source!r} conflicts with legacy redirect source {legacy_source!r}"
                )


def render_redirects(
    legacy_redirects: str, managed_redirects: list[ManagedRedirect]
) -> str:
    """Append managed redirect rules to existing static rules deterministically."""
    legacy = legacy_redirects.rstrip()
    managed = "\n".join(
        f"{redirect.source} {redirect.target} {MANAGED_REDIRECT_STATUS}"
        for redirect in managed_redirects
    )
    return f"{legacy}\n\n{GENERATED_HEADER}\n{managed}\n"


def generate(
    config_path: Path, legacy_redirects_path: Path, output_path: Path
) -> list[ManagedRedirect]:
    """Generate the deployable redirect file and return its managed entries."""
    redirects = load_managed_redirects(config_path)
    legacy_redirects = legacy_redirects_path.read_text(encoding="utf-8")
    validate_no_legacy_conflicts(
        redirects, parse_redirect_sources(legacy_redirects_path)
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        render_redirects(legacy_redirects, redirects), encoding="utf-8"
    )
    return redirects


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse generator paths for production, preview, and test builds."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    parser.add_argument(
        "--legacy-redirects", type=Path, default=DEFAULT_LEGACY_REDIRECTS_PATH
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    """Generate managed redirects and report the output location."""
    try:
        args = parse_args(argv)
        redirects = generate(args.config, args.legacy_redirects, args.output)
    except (ManagedRedirectError, OSError, tomllib.TOMLDecodeError) as error:
        print(f"Managed redirect generation failed: {error}", file=sys.stderr)
        return 1

    print(f"Generated {len(redirects)} managed redirects in {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
