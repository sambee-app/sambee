"""Validate that Tauri JavaScript packages align with Rust crate minors."""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
COMPANION_DIR = REPO_ROOT / "companion"
PACKAGE_LOCK_PATH = COMPANION_DIR / "package-lock.json"
CARGO_LOCK_PATH = COMPANION_DIR / "src-tauri" / "Cargo.lock"

TAURI_API_PACKAGE = "@tauri-apps/api"
TAURI_API_CRATE = "tauri"
TAURI_PLUGIN_PREFIX = "@tauri-apps/plugin-"
RUST_PLUGIN_PREFIX = "tauri-plugin-"


def read_package_lock() -> dict:
    with PACKAGE_LOCK_PATH.open("rb") as package_lock_file:
        return json.load(package_lock_file)


def read_cargo_lock() -> dict:
    with CARGO_LOCK_PATH.open("rb") as cargo_lock_file:
        return tomllib.load(cargo_lock_file)


def get_minor_version(version: str) -> tuple[int, int]:
    parts = version.split(".")
    if len(parts) < 2:
        raise ValueError(f"Expected a semver version, got {version!r}")
    return int(parts[0]), int(parts[1])


def collect_js_versions(package_lock: dict) -> dict[str, str]:
    packages = package_lock.get("packages")
    if not isinstance(packages, dict):
        raise ValueError("package-lock.json is missing the top-level 'packages' map")

    js_versions: dict[str, str] = {}
    for package_path, metadata in packages.items():
        if not isinstance(metadata, dict):
            continue

        if package_path == f"node_modules/{TAURI_API_PACKAGE}":
            version = metadata.get("version")
            if isinstance(version, str):
                js_versions[TAURI_API_PACKAGE] = version
            continue

        if not package_path.startswith(f"node_modules/{TAURI_PLUGIN_PREFIX}"):
            continue

        package_name = package_path.removeprefix("node_modules/")
        version = metadata.get("version")
        if isinstance(version, str):
            js_versions[package_name] = version

    return js_versions


def collect_rust_versions(cargo_lock: dict) -> dict[str, str]:
    packages = cargo_lock.get("package")
    if not isinstance(packages, list):
        raise ValueError("Cargo.lock is missing the top-level 'package' array")

    rust_versions: dict[str, str] = {}
    for package in packages:
        if not isinstance(package, dict):
            continue

        name = package.get("name")
        version = package.get("version")
        if isinstance(name, str) and isinstance(version, str):
            rust_versions[name] = version

    return rust_versions


def map_js_package_to_rust_crate(package_name: str) -> str:
    if package_name == TAURI_API_PACKAGE:
        return TAURI_API_CRATE

    if not package_name.startswith(TAURI_PLUGIN_PREFIX):
        raise ValueError(f"Unsupported Tauri package name: {package_name}")

    return package_name.replace("@tauri-apps/", "tauri-", 1)


def find_mismatches(
    js_versions: dict[str, str], rust_versions: dict[str, str]
) -> list[str]:
    mismatches: list[str] = []

    for package_name in sorted(js_versions):
        rust_crate = map_js_package_to_rust_crate(package_name)
        rust_version = rust_versions.get(rust_crate)
        js_version = js_versions[package_name]

        if rust_version is None:
            mismatches.append(
                f"{package_name} is locked to {js_version}, but {rust_crate} is not present in companion/src-tauri/Cargo.lock"
            )
            continue

        if get_minor_version(js_version) != get_minor_version(rust_version):
            mismatches.append(
                f"{package_name} ({js_version}) does not match {rust_crate} ({rust_version}); keep them on the same major.minor release"
            )

    return mismatches


def main() -> int:
    try:
        js_versions = collect_js_versions(read_package_lock())
        rust_versions = collect_rust_versions(read_cargo_lock())
        mismatches = find_mismatches(js_versions, rust_versions)
    except (OSError, ValueError, tomllib.TOMLDecodeError, json.JSONDecodeError) as exc:
        print(
            f"Tauri version alignment check failed to read lockfiles: {exc}",
            file=sys.stderr,
        )
        return 2

    if mismatches:
        print("Tauri JavaScript/Rust version alignment failed:", file=sys.stderr)
        for mismatch in mismatches:
            print(f"- {mismatch}", file=sys.stderr)
        print(
            "Update the companion npm and Cargo lockfiles together so @tauri-apps packages and tauri crates stay on matching major.minor versions.",
            file=sys.stderr,
        )
        return 1

    checked_packages = ", ".join(sorted(js_versions))
    print(f"Tauri version alignment OK: {checked_packages}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
