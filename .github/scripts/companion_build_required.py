"""Decide whether a pull request needs the expensive companion package build."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from collections.abc import Callable, Iterable

ROOT_VERSION_FILE = "VERSION"
SYNCED_VERSION_FILES = frozenset(
    {
        ROOT_VERSION_FILE,
        "frontend/package.json",
        "frontend/package-lock.json",
        "companion/package.json",
        "companion/package-lock.json",
        "companion/src-tauri/Cargo.toml",
        "companion/src-tauri/Cargo.lock",
        "companion/src-tauri/tauri.conf.json",
    }
)
PACKAGE_JSON_FILES = frozenset(
    {
        "frontend/package.json",
        "companion/package.json",
    }
)
PACKAGE_LOCK_FILES = frozenset(
    {
        "frontend/package-lock.json",
        "companion/package-lock.json",
    }
)
COMPANION_BUILD_INPUT_FILES = frozenset(
    {
        "scripts/sync-version",
        "scripts/check_tauri_version_alignment.py",
        ".github/workflows/verify-companion-build.yml",
    }
)
COMPANION_BUILD_INPUT_PREFIXES = (
    "companion/",
    ".github/actions/sync-version-check/",
)
CARGO_PACKAGE_VERSION = re.compile(r'^version\s*=\s*"[^"]*"\s*$')


def normalize_json_version(path: str, contents: str) -> object:
    payload = json.loads(contents)
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")

    payload["version"] = "<version>"
    if path in PACKAGE_LOCK_FILES:
        packages = payload.get("packages")
        if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
            raise ValueError(f"{path} is missing packages['']")
        packages[""]["version"] = "<version>"
    return payload


def normalize_cargo_toml(contents: str) -> list[str]:
    lines = contents.splitlines()
    in_package = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "[package]":
            in_package = True
        elif stripped.startswith("["):
            in_package = False
        elif in_package and CARGO_PACKAGE_VERSION.fullmatch(stripped):
            lines[index] = 'version = "<version>"'
            return lines
    raise ValueError("Cargo.toml is missing [package].version")


def normalize_cargo_lock(contents: str) -> list[str]:
    lines = contents.splitlines()
    in_companion_package = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "[[package]]":
            in_companion_package = False
        elif stripped == 'name = "sambee-companion"':
            in_companion_package = True
        elif in_companion_package and CARGO_PACKAGE_VERSION.fullmatch(stripped):
            lines[index] = 'version = "<version>"'
            return lines
    raise ValueError("Cargo.lock is missing the sambee-companion package version")


def normalize_version_metadata(path: str, contents: str) -> object:
    if path in PACKAGE_JSON_FILES | PACKAGE_LOCK_FILES | {
        "companion/src-tauri/tauri.conf.json"
    }:
        return normalize_json_version(path, contents)
    if path == "companion/src-tauri/Cargo.toml":
        return normalize_cargo_toml(contents)
    if path == "companion/src-tauri/Cargo.lock":
        return normalize_cargo_lock(contents)
    raise ValueError(f"{path} is not version metadata")


def is_companion_build_input(path: str) -> bool:
    return path in COMPANION_BUILD_INPUT_FILES or path.startswith(
        COMPANION_BUILD_INPUT_PREFIXES
    )


def requires_companion_build(
    changed_paths: Iterable[str],
    read_file: Callable[[str, str], str],
    base_revision: str,
    head_revision: str,
) -> bool:
    build_input_paths = {
        path for path in changed_paths if is_companion_build_input(path)
    }
    if not build_input_paths:
        return False

    if not build_input_paths <= SYNCED_VERSION_FILES:
        return True

    for path in build_input_paths - {ROOT_VERSION_FILE}:
        try:
            base_contents = read_file(base_revision, path)
            head_contents = read_file(head_revision, path)
            if normalize_version_metadata(
                path, base_contents
            ) != normalize_version_metadata(path, head_contents):
                return True
        except (OSError, ValueError, json.JSONDecodeError):
            return True
    return False


def git_file(revision: str, path: str) -> str:
    return subprocess.run(
        ["git", "show", f"{revision}:{path}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def changed_paths(base_revision: str, head_revision: str) -> set[str]:
    result = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", base_revision, head_revision],
        check=True,
        capture_output=True,
        text=True,
    )
    return {path for path in result.stdout.splitlines() if path}


def main() -> int:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} BASE_REVISION HEAD_REVISION", file=sys.stderr)
        return 2

    base_revision, head_revision = sys.argv[1:]
    try:
        build_required = requires_companion_build(
            changed_paths(base_revision, head_revision),
            git_file,
            base_revision,
            head_revision,
        )
    except subprocess.CalledProcessError as error:
        print(f"Could not inspect pull request changes: {error}", file=sys.stderr)
        return 1

    print(str(build_required).lower())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
