"""Create and verify immutable Companion package artifact manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, NoReturn

SCHEMA_VERSION = 1
ARTIFACT_MANIFEST_NAME = "companion-artifact-manifest.json"
RELEASE_MANIFEST_NAME = "companion-release-manifest.json"
RELEASE_PROVENANCE_NAME = "companion-release-provenance.json"
COMPLETION_MARKER_NAME = "companion-completion-marker.json"
NON_PACKAGE_ASSET_NAMES = {
    ARTIFACT_MANIFEST_NAME,
    RELEASE_MANIFEST_NAME,
    RELEASE_PROVENANCE_NAME,
    COMPLETION_MARKER_NAME,
}
UNSAFE_RELEASE_ASSET_CHARACTER = re.compile(r"[^A-Za-z0-9._-]+")

PLATFORM_REQUIREMENTS = {
    "linux-x64": {
        "target": "x86_64-unknown-linux-gnu",
        "roles": {
            "installer": [r"\.deb$"],
            "updater": [r"\.AppImage$"],
            "signature": [r"\.AppImage\.sig$"],
        },
    },
    "macos-arm64": {
        "target": "aarch64-apple-darwin",
        "roles": {
            "installer": [r"\.dmg$"],
            "updater": [r"\.app\.tar\.gz$"],
            "signature": [r"\.app\.tar\.gz\.sig$"],
        },
    },
    "windows-x64": {
        "target": "x86_64-pc-windows-msvc",
        "roles": {
            "installer": [r"x64-setup\.exe$"],
            "updater": [r"x64-setup\.exe$"],
            "signature": [r"x64-setup\.exe\.sig$"],
        },
    },
    "windows-arm64": {
        "target": "aarch64-pc-windows-msvc",
        "roles": {
            "installer": [r"arm64-setup\.exe$"],
            "updater": [r"arm64-setup\.exe$"],
            "signature": [r"arm64-setup\.exe\.sig$"],
        },
    },
}


def fail(message: str) -> NoReturn:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def canonical_digest(payload: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).hexdigest()


def matching_roles(name: str, platform: str) -> list[str]:
    roles = []
    for role, patterns in PLATFORM_REQUIREMENTS[platform]["roles"].items():
        if any(re.search(pattern, name, re.IGNORECASE) for pattern in patterns):
            roles.append(role)
    return roles


def normalized_release_asset_name(name: str) -> str:
    normalized = UNSAFE_RELEASE_ASSET_CHARACTER.sub(".", name).strip(".")
    if not normalized:
        fail(f"Companion package asset name cannot be normalized safely: {name}")
    return normalized


def normalize_release_asset_paths(artifact_dir: Path) -> None:
    package_paths = [
        path
        for path in sorted(artifact_dir.rglob("*"))
        if path.is_file() and path.name not in NON_PACKAGE_ASSET_NAMES
    ]
    destinations: dict[Path, Path] = {}
    for path in package_paths:
        destination = path.with_name(normalized_release_asset_name(path.name))
        existing_source = destinations.get(destination)
        if existing_source is not None and existing_source != path:
            fail(
                "Companion package asset names collide after GitHub-safe normalization: "
                f"{existing_source.name}, {path.name}"
            )
        if destination.exists() and destination != path:
            fail(
                "Companion package asset name collides with an existing file after "
                f"GitHub-safe normalization: {path.name}"
            )
        destinations[destination] = path
    for destination, source in destinations.items():
        if destination != source:
            source.rename(destination)


def create_manifest(
    artifact_dir: Path, platform: str, target: str, output: Path
) -> None:
    requirements = PLATFORM_REQUIREMENTS.get(platform)
    if requirements is None:
        fail(f"Unsupported Companion platform {platform}")
    if target != requirements["target"]:
        fail(f"Target {target} does not match platform {platform}")
    if not artifact_dir.is_dir():
        fail(f"Artifact directory does not exist: {artifact_dir}")

    normalize_release_asset_paths(artifact_dir)
    assets = []
    for path in sorted(artifact_dir.rglob("*")):
        if not path.is_file() or path.name in NON_PACKAGE_ASSET_NAMES:
            continue
        assets.append(
            {
                "name": path.name,
                "sha256": sha256(path),
                "size": path.stat().st_size,
                "roles": matching_roles(path.name, platform),
            }
        )
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "platform": platform,
        "target": target,
        "assets": assets,
    }
    validate_manifest(manifest, artifact_dir)
    output.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def validate_manifest(manifest: dict[str, Any], artifact_dir: Path) -> None:
    platform = manifest.get("platform")
    target = manifest.get("target")
    if (
        manifest.get("schema_version") != SCHEMA_VERSION
        or platform not in PLATFORM_REQUIREMENTS
    ):
        fail("Companion artifact manifest has an unsupported schema or platform")
    if target != PLATFORM_REQUIREMENTS[platform]["target"]:
        fail("Companion artifact manifest target does not match its platform")
    assets = manifest.get("assets")
    if not isinstance(assets, list) or not assets:
        fail("Companion artifact manifest defines no package assets")
    expected_names = set()
    roles = set()
    for asset in assets:
        if not isinstance(asset, dict):
            fail("Companion artifact manifest has an invalid asset record")
        name, digest, size, asset_roles = (
            asset.get("name"),
            asset.get("sha256"),
            asset.get("size"),
            asset.get("roles"),
        )
        if (
            not isinstance(name, str)
            or Path(name).name != name
            or name in expected_names
            or not isinstance(digest, str)
            or not isinstance(size, int)
            or not isinstance(asset_roles, list)
            or not all(isinstance(role, str) for role in asset_roles)
        ):
            fail("Companion artifact manifest has an incomplete asset record")
        path = next(
            (
                candidate
                for candidate in artifact_dir.rglob(name)
                if candidate.is_file()
            ),
            None,
        )
        if path is None or path.stat().st_size != size or sha256(path) != digest:
            fail(f"Companion artifact manifest checksum mismatch for {name}")
        expected_names.add(name)
        roles.update(asset_roles)
    actual_names = {
        path.name
        for path in artifact_dir.rglob("*")
        if path.is_file() and path.name not in NON_PACKAGE_ASSET_NAMES
    }
    if actual_names != expected_names:
        fail("Companion artifact manifest does not cover exactly its package assets")
    required_roles = set(PLATFORM_REQUIREMENTS[platform]["roles"])
    if not required_roles <= roles:
        fail(f"Companion artifact manifest is missing required roles for {platform}")


def verify_manifests(artifact_dir: Path, output: Path) -> None:
    manifests = sorted(artifact_dir.rglob(ARTIFACT_MANIFEST_NAME))
    if not manifests:
        fail("No Companion artifact manifests were retained")
    platforms = []
    asset_names = set()
    seen_platforms = set()
    for manifest_path in manifests:
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            fail(f"Invalid Companion artifact manifest {manifest_path}: {error}")
        if not isinstance(manifest, dict):
            fail(f"Invalid Companion artifact manifest {manifest_path}")
        validate_manifest(manifest, manifest_path.parent)
        identity = (manifest["platform"], manifest["target"])
        if identity in seen_platforms:
            fail("Retained Companion artifacts contain duplicate platform manifests")
        seen_platforms.add(identity)
        for asset in manifest["assets"]:
            if asset["name"] in asset_names:
                fail(
                    f"Retained Companion artifacts have a colliding release asset {asset['name']}"
                )
            asset_names.add(asset["name"])
        platforms.append(
            {
                "platform": manifest["platform"],
                "target": manifest["target"],
                "manifest_sha256": sha256(manifest_path),
                "assets": manifest["assets"],
            }
        )
    release_manifest = {"schema_version": SCHEMA_VERSION, "platforms": platforms}
    release_manifest["manifest_sha256"] = canonical_digest(release_manifest)
    output.write_text(
        json.dumps(release_manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--artifact-dir", type=Path, required=True)
    create.add_argument("--platform", required=True)
    create.add_argument("--target", required=True)
    create.add_argument("--output", type=Path, required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("--artifact-dir", type=Path, required=True)
    verify.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "create":
        create_manifest(args.artifact_dir, args.platform, args.target, args.output)
    else:
        verify_manifests(args.artifact_dir, args.output)


if __name__ == "__main__":
    main()
