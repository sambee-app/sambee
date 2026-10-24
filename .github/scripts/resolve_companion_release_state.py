"""Resolve the immutable publication state for a Companion release tag."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

PROVENANCE_ASSET = "companion-release-provenance.json"
COMPLETION_ASSET = "companion-completion-marker.json"
RECOVERY_PROVENANCE_PREFIX = "<!-- sambee-companion-recovery-v1:"
RECOVERY_PROVENANCE_SUFFIX = " -->"
UNSAFE_RELEASE_ASSET_CHARACTER = re.compile(r"[^A-Za-z0-9._-]+")
NEW_CANDIDATE_INSTRUCTIONS = (
    "Increment the third build-sequence component in VERSION, run ./scripts/sync-version, "
    "commit the synchronized changes on main, and rerun."
)


def fail(message: str) -> NoReturn:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


def fail_new_candidate(message: str) -> NoReturn:
    fail(f"{message} {NEW_CANDIDATE_INSTRUCTIONS}")


class GitHubApiError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def request_json(url: str, token: str) -> Any:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "sambee-companion-build-workflow",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise GitHubApiError(error.code, error.reason) from error


def request_asset_bytes(asset: dict[str, Any], token: str) -> bytes:
    url = asset.get("url") or asset.get("browser_download_url")
    if not isinstance(url, str):
        fail(f"Release asset {asset.get('name')} has no download URL")
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/octet-stream",
            "Authorization": f"Bearer {token}",
            "User-Agent": "sambee-companion-build-workflow",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        fail(f"Unable to read release asset {asset.get('name')}: {error}")


def request_asset_json(asset: dict[str, Any], token: str) -> dict[str, Any]:
    try:
        payload = json.loads(request_asset_bytes(asset, token).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"Unable to read release asset {asset.get('name')}: {error}")
    if not isinstance(payload, dict):
        fail(f"Release asset {asset.get('name')} must contain a JSON object")
    return payload


def find_asset(release: dict[str, Any], name: str) -> dict[str, Any] | None:
    for asset in release.get("assets", []):
        if isinstance(asset, dict) and asset.get("name") == name:
            return asset
    return None


def embedded_recovery_provenance_bytes(release: dict[str, Any]) -> bytes | None:
    body = release.get("body")
    if not isinstance(body, str):
        return None
    start = body.find(RECOVERY_PROVENANCE_PREFIX)
    if start == -1:
        return None
    encoded_start = start + len(RECOVERY_PROVENANCE_PREFIX)
    end = body.find(RECOVERY_PROVENANCE_SUFFIX, encoded_start)
    if end == -1 or body.find(RECOVERY_PROVENANCE_PREFIX, encoded_start) != -1:
        fail("Existing Companion draft has invalid embedded recovery provenance")
    encoded = body[encoded_start:end]
    try:
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        fail(
            f"Existing Companion draft has invalid embedded recovery provenance: {error}"
        )


def draft_matches_embedded_release_tag(release: dict[str, Any], tag: str) -> bool:
    """Return whether an untagged draft's embedded provenance records ``tag``."""
    if not release.get("draft", False):
        return False
    body = release.get("body")
    if not isinstance(body, str):
        return False
    start = body.find(RECOVERY_PROVENANCE_PREFIX)
    if start == -1:
        return False
    encoded_start = start + len(RECOVERY_PROVENANCE_PREFIX)
    end = body.find(RECOVERY_PROVENANCE_SUFFIX, encoded_start)
    if end == -1 or body.find(RECOVERY_PROVENANCE_PREFIX, encoded_start) != -1:
        return False
    try:
        provenance = json.loads(
            base64.b64decode(body[encoded_start:end], validate=True).decode("utf-8")
        )
    except (binascii.Error, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return False
    return isinstance(provenance, dict) and provenance.get("release_tag") == tag


def release_provenance_bytes(release: dict[str, Any], token: str) -> bytes:
    provenance_asset = find_asset(release, PROVENANCE_ASSET)
    if provenance_asset is not None:
        return request_asset_bytes(provenance_asset, token)
    embedded_provenance = embedded_recovery_provenance_bytes(release)
    if release.get("draft", False) and embedded_provenance is not None:
        return embedded_provenance
    fail_new_candidate(
        "Existing Companion release has no provenance asset or embedded recovery provenance "
        "and cannot be safely resumed."
    )


def expected_asset_set_digest(expected_assets: list[dict[str, Any]]) -> str:
    encoded = json.dumps(
        sorted(expected_assets, key=lambda asset: str(asset.get("name"))),
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def normalized_release_asset_name(name: str) -> str:
    return UNSAFE_RELEASE_ASSET_CHARACTER.sub(".", name).strip(".")


def normalized_asset_name_set(names: list[str], description: str) -> set[str]:
    normalized_names = {normalized_release_asset_name(name) for name in names}
    if len(normalized_names) != len(names):
        fail(f"{description} contains colliding asset names after GitHub normalization")
    return normalized_names


@dataclass(frozen=True)
class ReleaseIdentity:
    version: str
    build_tag: str
    source_sha: str
    release_tag: str


def require_matching_identity(
    provenance: dict[str, Any], identity: ReleaseIdentity
) -> None:
    expected = {
        "version": identity.version,
        "build_tag": identity.build_tag,
        "source_sha": identity.source_sha,
        "release_tag": identity.release_tag,
    }
    for key, value in expected.items():
        if provenance.get(key) != value:
            fail_new_candidate(
                f"Existing Companion release provenance {key} does not match the selected "
                "canonical candidate."
            )


def validate_recovery_metadata(provenance: dict[str, Any]) -> None:
    workflow_run = provenance.get("workflow_run")
    artifacts = provenance.get("actions_artifacts")
    platforms = provenance.get("platforms")
    if (
        not isinstance(workflow_run, dict)
        or not isinstance(artifacts, list)
        or not artifacts
        or not isinstance(platforms, list)
        or not platforms
        or not isinstance(provenance.get("artifact_manifest_sha256"), str)
    ):
        fail_new_candidate(
            "Existing Companion draft does not record recovery artifact identities. "
        )
    if not isinstance(workflow_run.get("id"), int) or not isinstance(
        workflow_run.get("attempt"), int
    ):
        fail("Existing Companion draft has invalid workflow recovery metadata")
    for artifact in artifacts:
        if (
            not isinstance(artifact, dict)
            or not isinstance(artifact.get("id"), int)
            or not isinstance(artifact.get("platform"), str)
            or not isinstance(artifact.get("target"), str)
            or not isinstance(artifact.get("name"), str)
            or not isinstance(artifact.get("digest"), str)
            or not artifact["digest"]
        ):
            fail("Existing Companion draft has invalid retained artifact metadata")


def resolve_state(
    release: dict[str, Any] | None, identity: ReleaseIdentity, token: str
) -> str:
    if release is None:
        return "build"

    provenance_bytes = release_provenance_bytes(release, token)
    try:
        provenance = json.loads(provenance_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"Unable to read Companion release provenance: {error}")
    if not isinstance(provenance, dict):
        fail("Companion release provenance must contain a JSON object")
    require_matching_identity(provenance, identity)
    if provenance.get("schema_version") != 1:
        fail("Existing Companion release provenance has an unsupported schema version")

    completion_asset = find_asset(release, COMPLETION_ASSET)
    if completion_asset is not None:
        completion = request_asset_json(completion_asset, token)
        if completion.get("schema_version") != 1:
            fail(
                "Existing Companion completion marker has an unsupported schema version"
            )
        if (
            completion.get("provenance_sha256")
            != hashlib.sha256(provenance_bytes).hexdigest()
        ):
            fail(
                "Existing Companion completion marker does not match release provenance"
            )
        expected_assets = provenance.get("assets")
        if (
            not isinstance(expected_assets, list)
            or completion.get("expected_assets") != expected_assets
        ):
            fail(
                "Existing Companion completion marker does not match release provenance"
            )
        if completion.get("expected_assets_sha256") != expected_asset_set_digest(
            expected_assets
        ):
            fail("Existing Companion completion marker has an invalid asset-set digest")
        expected_names = []
        for expected_asset in expected_assets:
            if not isinstance(expected_asset, dict) or not isinstance(
                expected_asset.get("name"), str
            ):
                fail("Existing Companion completion marker has an invalid asset record")
            expected_names.append(expected_asset["name"])
        release_assets = release.get("assets")
        if not isinstance(release_assets, list):
            fail("Existing Companion release has an invalid asset list")
        actual_names = [
            asset.get("name")
            for asset in release_assets
            if isinstance(asset, dict) and isinstance(asset.get("name"), str)
        ]
        required_names = normalized_asset_name_set(
            expected_names + [PROVENANCE_ASSET, COMPLETION_ASSET],
            "Existing Companion completion marker",
        )
        actual_names_set = normalized_asset_name_set(
            actual_names, "Existing Companion release"
        )
        unexpected_names = actual_names_set - required_names
        missing_names = required_names - actual_names_set
        if unexpected_names:
            fail_new_candidate(
                "Existing Companion release contains unexpected assets: "
                f"{', '.join(sorted(unexpected_names))}."
            )
        if not missing_names:
            if release.get("draft", False):
                validate_recovery_metadata(provenance)
                return "recover-finalizer"
            return "complete"
        if not release.get("draft", False):
            fail_new_candidate(
                "Published Companion release is missing expected assets: "
                f"{', '.join(sorted(missing_names))}."
            )
        validate_recovery_metadata(provenance)
        return "recover-finalizer"
    if not release.get("draft", False):
        fail_new_candidate(
            "Published Companion release has no completion marker and is conflicting state. "
        )

    validate_recovery_metadata(provenance)
    return "recover-finalizer"


def fetch_release(owner: str, repo: str, tag: str, token: str) -> dict[str, Any] | None:
    release_by_tag_url = (
        f"https://api.github.com/repos/{owner}/{repo}/releases/tags/"
        f"{urllib.parse.quote(tag, safe='')}"
    )
    try:
        payload = request_json(release_by_tag_url, token)
    except GitHubApiError as error:
        if error.status_code != 404:
            fail(
                f"Unable to fetch Companion release {tag} from {owner}/{repo}: "
                f"HTTP {error.status_code} {error.message}"
            )
    else:
        if not isinstance(payload, dict):
            fail("Unexpected API response while resolving Companion release state")
        return payload

    # Draft releases have neither a Git tag nor their requested tag as tag_name.
    # The list response may omit their body, so use the deterministic title to
    # locate a candidate and retrieve its complete record before validation.
    expected_title = f"Sambee Companion v{tag.removeprefix('companion-v')}"
    page = 1
    while True:
        releases_url = f"https://api.github.com/repos/{owner}/{repo}/releases?per_page=100&page={page}"
        try:
            releases = request_json(releases_url, token)
        except GitHubApiError as error:
            fail(
                f"Unable to list Companion releases from {owner}/{repo}: "
                f"HTTP {error.status_code} {error.message}"
            )
        if not isinstance(releases, list):
            fail("Unexpected API response while listing Companion releases")
        for release in releases:
            if isinstance(release, dict) and (
                release.get("tag_name") == tag
                or release.get("name") == expected_title
                or draft_matches_embedded_release_tag(release, tag)
            ):
                release_id = release.get("id")
                if not isinstance(release_id, int):
                    fail("Companion release list returned a release without an ID")
                release_url = (
                    f"https://api.github.com/repos/{owner}/{repo}/releases/{release_id}"
                )
                try:
                    resolved_release = request_json(release_url, token)
                except GitHubApiError as error:
                    fail(
                        f"Unable to fetch Companion release {release_id} from {owner}/{repo}: "
                        f"HTTP {error.status_code} {error.message}"
                    )
                if not isinstance(resolved_release, dict):
                    fail("Unexpected API response while resolving Companion release")
                return resolved_release
        if len(releases) < 100:
            return None
        page += 1


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--build-tag", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--release-tag", required=True)
    parser.add_argument("--recovery-provenance-output")
    args = parser.parse_args()
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        fail("GITHUB_TOKEN environment variable is required")

    identity = ReleaseIdentity(
        version=args.version,
        build_tag=args.build_tag,
        source_sha=args.source_sha,
        release_tag=args.release_tag,
    )
    release = fetch_release(args.owner, args.repo, args.release_tag, token)
    state = resolve_state(release, identity, token)
    if args.recovery_provenance_output:
        if release is None or state != "recover-finalizer":
            fail(
                "Recovery provenance can only be written for a recoverable draft release"
            )
        Path(args.recovery_provenance_output).write_bytes(
            release_provenance_bytes(release, token)
        )
    print(f"state={state}")
    if release is not None and isinstance(release.get("id"), int):
        print(f"release_id={release['id']}")


if __name__ == "__main__":
    main()
