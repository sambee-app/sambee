from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, NoReturn

TAURI_PLATFORM_PATTERNS = {
    "windows-x86_64": {
        "bundle": [r"x64-setup\.exe$"],
        "signature": [r"x64-setup\.exe\.sig$"],
    },
    "windows-aarch64": {
        "bundle": [r"arm64-setup\.exe$"],
        "signature": [r"arm64-setup\.exe\.sig$"],
    },
    "darwin-aarch64": {
        "bundle": [r"(aarch64|arm64).*\.app\.tar\.gz$", r"\.app\.tar\.gz$"],
        "signature": [
            r"(aarch64|arm64).*\.app\.tar\.gz\.sig$",
            r"\.app\.tar\.gz\.sig$",
        ],
    },
    "linux-x86_64": {
        "bundle": [r"(amd64|x86_64).*\.AppImage$", r"\.AppImage$"],
        "signature": [r"(amd64|x86_64).*\.AppImage\.sig$", r"\.AppImage\.sig$"],
    },
}

SAMBEE_DOWNLOAD_PATTERNS = {
    "windows-x64": [r"x64-setup\.exe$"],
    "windows-arm64": [r"arm64-setup\.exe$"],
    "macos-arm64": [r"(aarch64|arm64).*\.dmg$", r"\.dmg$"],
    "linux-x64": [r"(amd64|x86_64).*\.AppImage$", r"\.AppImage$"],
}

PROVENANCE_ASSET_NAME = "companion-release-provenance.json"
COMPLETION_MARKER_ASSET_NAME = "companion-completion-marker.json"
RELEASE_MANIFEST_ASSET_NAME = "companion-release-manifest.json"
UNSAFE_RELEASE_ASSET_CHARACTER = re.compile(r"[^A-Za-z0-9._-]+")
PROMOTED_RELEASES_SCHEMA_VERSION = 1
PROMOTED_RELEASES_FILE = Path("companion") / "promoted.json"
ASSET_DOWNLOAD_MAX_ATTEMPTS = 3
ASSET_DOWNLOAD_INITIAL_RETRY_DELAY_SECONDS = 1
RETRYABLE_ASSET_DOWNLOAD_STATUS_CODES = {408, 429}
PROMOTION_FEED_SOURCES = (
    (
        "test",
        Path("companion") / "tauri" / "test" / "latest.json",
        "pub_date",
    ),
    (
        "beta",
        Path("companion") / "tauri" / "beta" / "latest.json",
        "pub_date",
    ),
    (
        "stable",
        Path("companion") / "tauri" / "stable" / "latest.json",
        "pub_date",
    ),
    ("sambee", Path("sambee") / "companion" / "latest.json", "published_at"),
)


def expected_asset_set_digest(expected_assets: list[dict]) -> str:
    canonical_assets = sorted(expected_assets, key=lambda asset: str(asset.get("name")))
    encoded = json.dumps(
        canonical_assets, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def canonical_manifest_digest(payload: dict) -> str:
    canonical_payload = dict(payload)
    canonical_payload.pop("manifest_sha256", None)
    return hashlib.sha256(
        json.dumps(canonical_payload, separators=(",", ":"), sort_keys=True).encode(
            "utf-8"
        )
    ).hexdigest()


def normalized_release_asset_name(name: str) -> str:
    return UNSAFE_RELEASE_ASSET_CHARACTER.sub(".", name).strip(".")


def fail(message: str) -> NoReturn:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


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
            "User-Agent": "sambee-promotion-workflow",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        error_body = error.read().decode("utf-8", errors="replace")
        message = error.reason
        if error_body:
            try:
                payload = json.loads(error_body)
            except json.JSONDecodeError:
                payload = None
            if isinstance(payload, dict) and payload.get("message"):
                message = str(payload["message"])
        raise GitHubApiError(error.code, message) from error


def request_text(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "sambee-promotion-workflow"},
    )
    with urllib.request.urlopen(request) as response:
        return response.read().decode("utf-8").strip()


def request_bytes(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "sambee-promotion-workflow"},
    )
    with urllib.request.urlopen(request) as response:
        return response.read()


def is_retryable_asset_download_error(error: urllib.error.URLError) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return (
            error.code in RETRYABLE_ASSET_DOWNLOAD_STATUS_CODES
            or 500 <= error.code < 600
        )
    return isinstance(error.reason, OSError)


def request_asset_bytes(asset: dict, token: str | None = None) -> bytes:
    if token and isinstance(asset.get("url"), str):
        request = urllib.request.Request(
            asset["url"],
            headers={
                "Accept": "application/octet-stream",
                "Authorization": f"Bearer {token}",
                "User-Agent": "sambee-promotion-workflow",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        for attempt in range(ASSET_DOWNLOAD_MAX_ATTEMPTS):
            try:
                with urllib.request.urlopen(request) as response:
                    return response.read()
            except urllib.error.URLError as error:
                if isinstance(error, urllib.error.HTTPError):
                    error.close()
                if (
                    not is_retryable_asset_download_error(error)
                    or attempt == ASSET_DOWNLOAD_MAX_ATTEMPTS - 1
                ):
                    fail(
                        f"Unable to read release asset {asset.get('name')} after "
                        f"{attempt + 1} attempt(s): {error}"
                    )
                time.sleep(ASSET_DOWNLOAD_INITIAL_RETRY_DELAY_SECONDS * (2**attempt))
    return request_bytes(asset["browser_download_url"])


def parse_release_reference(
    release_ref: str, owner: str, repo: str
) -> tuple[int | None, str | None]:
    normalized_ref = release_ref.strip()
    if not normalized_ref:
        fail("Release reference must not be empty")
    if normalized_ref.isdigit():
        return int(normalized_ref), None

    parsed_url = urllib.parse.urlparse(normalized_ref)
    if not parsed_url.scheme and not parsed_url.netloc:
        return None, normalized_ref
    if parsed_url.scheme != "https" or parsed_url.netloc.casefold() != "github.com":
        fail("GitHub release URLs must use https://github.com")

    path_parts = [part for part in parsed_url.path.split("/") if part]
    if (
        len(path_parts) < 4
        or path_parts[0].casefold() != owner.casefold()
        or path_parts[1].casefold() != repo.casefold()
        or path_parts[2] != "releases"
    ):
        fail(f"Release URL must refer to https://github.com/{owner}/{repo}")
    if path_parts[3] == "tag":
        if len(path_parts) < 5:
            fail("GitHub release tag URLs must include a tag name")
        tag_name = urllib.parse.unquote("/".join(path_parts[4:]))
        if not tag_name or "\r" in tag_name or "\n" in tag_name:
            fail("GitHub release tag URL contains an invalid tag name")
        return None, tag_name
    if len(path_parts) == 4 and path_parts[3].isdigit():
        return int(path_parts[3]), None
    fail("GitHub release URL must identify a release tag or numeric release ID")


def normalize_version(tag_name: str) -> str:
    if tag_name.startswith("companion-v"):
        return tag_name[len("companion-v") :]
    if tag_name.startswith("v"):
        return tag_name[1:]
    return tag_name


def find_asset(assets: list[dict], patterns: list[str]) -> dict | None:
    for pattern in patterns:
        regex = re.compile(pattern, re.IGNORECASE)
        for asset in assets:
            if regex.search(asset["name"]):
                return asset
    return None


def require_asset(assets: list[dict], patterns: list[str], description: str) -> dict:
    asset = find_asset(assets, patterns)
    if asset is None:
        fail(f"Missing asset for {description}. Expected patterns: {patterns}")
    return asset


def asset_by_name(assets: list[dict], name: str) -> dict:
    for asset in assets:
        if asset.get("name") == name:
            return asset
    fail(f"Release is missing required integrity asset {name}")


def fetch_json_asset(asset: dict, token: str | None = None) -> dict:
    try:
        payload = json.loads(request_asset_bytes(asset, token).decode("utf-8"))
    except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"Integrity asset {asset.get('name')} is not valid JSON: {error}")
    if not isinstance(payload, dict):
        fail(f"Integrity asset {asset.get('name')} must contain a JSON object")
    return payload


def verify_release_integrity(
    release: dict, assets: list[dict], token: str | None = None
) -> None:
    provenance_asset = asset_by_name(assets, PROVENANCE_ASSET_NAME)
    completion_asset = asset_by_name(assets, COMPLETION_MARKER_ASSET_NAME)
    release_manifest_asset = asset_by_name(assets, RELEASE_MANIFEST_ASSET_NAME)
    provenance_bytes = request_asset_bytes(provenance_asset, token)
    try:
        provenance = json.loads(provenance_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"Integrity asset {PROVENANCE_ASSET_NAME} is not valid JSON: {error}")
    if not isinstance(provenance, dict):
        fail(f"Integrity asset {PROVENANCE_ASSET_NAME} must contain a JSON object")
    completion = fetch_json_asset(completion_asset, token)
    release_manifest_bytes = request_asset_bytes(release_manifest_asset, token)
    try:
        release_manifest = json.loads(release_manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(
            f"Integrity asset {RELEASE_MANIFEST_ASSET_NAME} is not valid JSON: {error}"
        )
    if not isinstance(release_manifest, dict):
        fail(
            f"Integrity asset {RELEASE_MANIFEST_ASSET_NAME} must contain a JSON object"
        )

    version = normalize_version(str(release.get("tag_name") or ""))
    expected_tag = str(release.get("tag_name") or "")
    if provenance.get("schema_version") != 1:
        fail("Companion release provenance has an unsupported schema version")
    if (
        provenance.get("release_tag") != expected_tag
        or provenance.get("version") != version
    ):
        fail(
            "Companion release provenance does not match the selected release tag and version"
        )
    if completion.get("schema_version") != 1:
        fail("Companion completion marker has an unsupported schema version")
    if completion.get("release_tag") != expected_tag:
        fail("Companion completion marker does not match the release tag")
    if (
        completion.get("provenance_sha256")
        != hashlib.sha256(provenance_bytes).hexdigest()
    ):
        fail("Companion completion marker does not match the release provenance")

    expected_assets = provenance.get("assets")
    if not isinstance(expected_assets, list) or not expected_assets:
        fail("Companion release provenance does not define any assets")
    if completion.get("expected_assets") != expected_assets:
        fail(
            "Companion completion marker asset set does not match the release provenance"
        )
    if completion.get("expected_assets_sha256") != expected_asset_set_digest(
        expected_assets
    ):
        fail("Companion completion marker asset-set digest does not match provenance")
    if (
        provenance.get("artifact_manifest_sha256")
        != hashlib.sha256(release_manifest_bytes).hexdigest()
    ):
        fail("Companion release provenance does not match the artifact manifest")
    if completion.get("artifact_manifest_sha256") != provenance.get(
        "artifact_manifest_sha256"
    ):
        fail("Companion completion marker does not match the artifact manifest")
    if release_manifest.get("schema_version") != 1 or release_manifest.get(
        "manifest_sha256"
    ) != canonical_manifest_digest(release_manifest):
        fail("Companion release manifest has an unsupported schema or invalid digest")
    if release_manifest.get("platforms") != provenance.get("platforms"):
        fail("Companion release manifest platform matrix does not match provenance")

    expected_by_name: dict[str, dict] = {}
    expected_by_normalized_name: dict[str, dict] = {}
    for expected_asset in expected_assets:
        if not isinstance(expected_asset, dict):
            fail("Companion release provenance has an invalid asset record")
        name = expected_asset.get("name")
        digest = expected_asset.get("sha256")
        size = expected_asset.get("size")
        if (
            not isinstance(name, str)
            or not isinstance(digest, str)
            or not isinstance(size, int)
        ):
            fail("Companion release provenance has an incomplete asset record")
        if name in expected_by_name:
            fail(f"Companion release provenance lists duplicate asset {name}")
        normalized_name = normalized_release_asset_name(name)
        if normalized_name in expected_by_normalized_name:
            fail(
                "Companion release provenance contains colliding asset names after "
                "GitHub normalization"
            )
        expected_by_name[name] = expected_asset
        expected_by_normalized_name[normalized_name] = expected_asset

    actual_by_normalized_name: dict[str, dict] = {}
    for asset in assets:
        actual_name = str(asset.get("name") or "")
        normalized_name = normalized_release_asset_name(actual_name)
        if normalized_name in actual_by_normalized_name:
            fail(
                "Companion release contains colliding asset names after GitHub normalization"
            )
        actual_by_normalized_name[normalized_name] = asset
    allowed_names = set(expected_by_normalized_name) | {
        PROVENANCE_ASSET_NAME,
        COMPLETION_MARKER_ASSET_NAME,
    }
    actual_names = set(actual_by_normalized_name)
    if actual_names != allowed_names:
        missing_names = sorted(allowed_names - actual_names)
        unexpected_names = sorted(actual_names - allowed_names)
        details = []
        if missing_names:
            details.append(f"missing: {', '.join(missing_names)}")
        if unexpected_names:
            details.append(f"unexpected: {', '.join(unexpected_names)}")
        fail(
            "Companion release contains unexpected or missing assets "
            f"({'; '.join(details)})"
        )
    for name, expected_asset in expected_by_name.items():
        normalized_name = normalized_release_asset_name(name)
        asset = actual_by_normalized_name[normalized_name]
        content = request_asset_bytes(asset, token)
        if (
            asset.get("size") != expected_asset["size"]
            or len(content) != expected_asset["size"]
        ):
            fail(f"Companion release asset size mismatch for {name}")
        if hashlib.sha256(content).hexdigest() != expected_asset["sha256"]:
            fail(f"Companion release asset checksum mismatch for {name}")

    manifested_names = set()
    platforms = release_manifest.get("platforms")
    if not isinstance(platforms, list) or not platforms:
        fail("Companion release manifest does not define a platform matrix")
    for platform in platforms:
        if not isinstance(platform, dict) or not isinstance(
            platform.get("assets"), list
        ):
            fail("Companion release manifest has an invalid platform record")
        roles = set()
        for asset in platform["assets"]:
            if not isinstance(asset, dict) or not isinstance(asset.get("name"), str):
                fail("Companion release manifest has an invalid platform asset")
            name = asset["name"]
            if name not in expected_by_name or name in manifested_names:
                fail(
                    "Companion release manifest has an unexpected or duplicate platform asset"
                )
            expected_asset = expected_by_name[name]
            if (
                asset.get("sha256") != expected_asset["sha256"]
                or asset.get("size") != expected_asset["size"]
                or not isinstance(asset.get("roles"), list)
            ):
                fail(f"Companion release manifest does not match provenance for {name}")
            manifested_names.add(name)
            roles.update(asset["roles"])
        if not {"installer", "updater", "signature"} <= roles:
            fail(
                "Companion release manifest is missing an installer, updater, or signature"
            )
    if manifested_names != set(expected_by_name) - {RELEASE_MANIFEST_ASSET_NAME}:
        fail("Companion release manifest does not cover every package asset")


def build_tauri_feed(release: dict, assets: list[dict]) -> dict:
    feed = {
        "version": normalize_version(release["tag_name"]),
        "notes": release.get("body") or "",
        "pub_date": release.get("published_at") or release.get("created_at"),
        "platforms": {},
    }

    for platform_key, pattern_group in TAURI_PLATFORM_PATTERNS.items():
        bundle_asset = find_asset(assets, pattern_group["bundle"])
        signature_asset = find_asset(assets, pattern_group["signature"])

        if bundle_asset is None and signature_asset is None:
            continue
        if bundle_asset is None:
            fail(
                f"Missing asset for {platform_key} updater bundle. Expected patterns: "
                f"{pattern_group['bundle']}"
            )
        if signature_asset is None:
            fail(
                f"Missing asset for {platform_key} updater signature. Expected patterns: "
                f"{pattern_group['signature']}"
            )

        feed["platforms"][platform_key] = {
            "url": bundle_asset["browser_download_url"],
            "signature": request_text(signature_asset["browser_download_url"]),
        }

    if not feed["platforms"]:
        fail("No complete updater asset pairs were discovered for the Tauri feed")

    return feed


def build_sambee_metadata(release: dict, assets: list[dict]) -> dict:
    asset_map: dict[str, str] = {}
    for platform_key, patterns in SAMBEE_DOWNLOAD_PATTERNS.items():
        asset = find_asset(assets, patterns)
        if asset is not None:
            asset_map[platform_key] = asset["browser_download_url"]

    if not asset_map:
        fail("No downloadable installer assets were discovered for Sambee metadata")

    return {
        "version": normalize_version(release["tag_name"]),
        "published_at": release.get("published_at") or release.get("created_at"),
        "notes": release.get("body") or "",
        "assets": asset_map,
    }


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def build_promoted_releases_feed(output_root: Path) -> dict:
    """Build a normalized index of every currently promoted release."""

    channels: dict[str, dict[str, str]] = {}
    for channel, relative_path, published_at_field in PROMOTION_FEED_SOURCES:
        feed_path = output_root / relative_path
        if not feed_path.exists():
            continue
        if not feed_path.is_file():
            fail(f"Promotion feed {feed_path} is not a file")

        try:
            payload = json.loads(feed_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            fail(f"Promotion feed {feed_path} is not valid JSON: {error}")
        if not isinstance(payload, dict):
            fail(f"Promotion feed {feed_path} must contain a JSON object")

        version = payload.get("version")
        if not isinstance(version, str) or not version.strip():
            fail(f"Promotion feed {feed_path} is missing a version")

        promotion = {"version": version.strip()}
        published_at = payload.get(published_at_field)
        if published_at is not None:
            if not isinstance(published_at, str) or not published_at.strip():
                fail(f"Promotion feed {feed_path} has an invalid {published_at_field}")
            promotion["published_at"] = published_at.strip()
        channels[channel] = promotion

    return {
        "schema_version": PROMOTED_RELEASES_SCHEMA_VERSION,
        "channels": channels,
    }


def fetch_release(release_ref: str, owner: str, repo: str, token: str) -> dict:
    release_id, tag_name = parse_release_reference(release_ref, owner, repo)
    if release_id is not None:
        release_url = (
            f"https://api.github.com/repos/{owner}/{repo}/releases/{release_id}"
        )
        try:
            release = request_json(release_url, token)
        except GitHubApiError as error:
            fail(
                f"Unable to fetch release ID {release_id} from {owner}/{repo}: "
                f"HTTP {error.status_code} {error.message}"
            )
        if not isinstance(release, dict):
            fail(f"Unexpected API response while fetching release ID {release_id}")
        return release

    assert tag_name is not None
    release_url = (
        f"https://api.github.com/repos/{owner}/{repo}/releases/tags/"
        f"{urllib.parse.quote(tag_name, safe='')}"
    )
    try:
        release = request_json(release_url, token)
    except GitHubApiError as error:
        if error.status_code != 404:
            fail(
                f"Unable to fetch release {tag_name} from {owner}/{repo}: "
                f"HTTP {error.status_code} {error.message}"
            )

        releases_url = (
            f"https://api.github.com/repos/{owner}/{repo}/releases?per_page=100"
        )
        try:
            releases = request_json(releases_url, token)
        except GitHubApiError as list_error:
            fail(
                f"Unable to list releases in {owner}/{repo} while resolving {tag_name}: "
                f"HTTP {list_error.status_code} {list_error.message}"
            )
        if not isinstance(releases, list):
            fail(f"Unexpected API response while listing releases for {owner}/{repo}")
        for release_candidate in releases:
            if release_candidate.get("tag_name") == tag_name:
                return release_candidate
        fail(
            f"Release {tag_name} was not found in {owner}/{repo}. "
            "If it is a draft, ensure the workflow token has push access to that repository."
        )

    if not isinstance(release, dict):
        fail(f"Unexpected API response while fetching release {tag_name}")
    return release


def release_identity(release: dict) -> tuple[int, str]:
    release_id = release.get("id")
    tag_name = release.get("tag_name")
    if not isinstance(release_id, int) or release_id <= 0:
        fail("GitHub release has an invalid ID")
    if (
        not isinstance(tag_name, str)
        or not tag_name
        or "\r" in tag_name
        or "\n" in tag_name
    ):
        fail("GitHub release has an invalid tag name")
    return release_id, tag_name


def validate_release_eligibility(
    release: dict, tag_name: str, allow_draft: bool
) -> None:
    if release.get("prerelease"):
        fail(f"Release {tag_name} is a GitHub prerelease")
    if release.get("draft") and not allow_draft:
        fail(f"Release {tag_name} is still a draft")


def required_provenance_string(provenance: dict, field_name: str) -> str:
    value = provenance.get(field_name)
    if not isinstance(value, str) or not value or "\r" in value or "\n" in value:
        fail(f"Companion release provenance has an invalid {field_name}")
    return value


def resolve_release(
    release_ref: str, owner: str, repo: str, token: str
) -> dict[str, int | str]:
    release = fetch_release(release_ref, owner, repo, token)
    release_id, tag_name = release_identity(release)
    validate_release_eligibility(release, tag_name, allow_draft=False)
    assets = release.get("assets")
    if not isinstance(assets, list) or not assets:
        fail(f"Release {tag_name} has no assets")
    provenance = fetch_json_asset(asset_by_name(assets, PROVENANCE_ASSET_NAME), token)
    return {
        "release_id": release_id,
        "release_tag": tag_name,
        "build_tag": required_provenance_string(provenance, "build_tag"),
        "source_sha": required_provenance_string(provenance, "source_sha"),
    }


def validate_expected_release_identity(
    release_id: int,
    tag_name: str,
    expected_release_id: int | None,
    expected_release_tag: str | None,
) -> None:
    if expected_release_id is not None and release_id != expected_release_id:
        fail(
            f"Resolved release ID {release_id} does not match expected release ID "
            f"{expected_release_id}"
        )
    if expected_release_tag is not None and tag_name != expected_release_tag:
        fail(
            f"Resolved release tag {tag_name} does not match expected release tag "
            f"{expected_release_tag}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-ref")
    parser.add_argument("--release-owner")
    parser.add_argument("--release-repo")
    parser.add_argument("--release-repo-path")
    parser.add_argument("--build-promoted-releases-index", action="store_true")
    parser.add_argument("--resolve-release", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--allow-draft", action="store_true")
    parser.add_argument("--expected-release-id", type=int)
    parser.add_argument("--expected-release-tag")
    parser.add_argument("--companion-channel-test", action="store_true")
    parser.add_argument("--companion-channel-beta", action="store_true")
    parser.add_argument("--companion-channel-stable", action="store_true")
    parser.add_argument("--sambee", action="store_true")
    args = parser.parse_args()

    selected_promotion_target = any(
        [
            args.companion_channel_test,
            args.companion_channel_beta,
            args.companion_channel_stable,
            args.sambee,
        ]
    )

    if args.build_promoted_releases_index:
        if (
            args.resolve_release
            or args.verify_only
            or args.allow_draft
            or args.expected_release_id is not None
            or args.expected_release_tag is not None
            or selected_promotion_target
        ):
            fail(
                "--build-promoted-releases-index cannot be combined with release "
                "verification or promotion targets"
            )
        if not args.release_repo_path:
            fail(
                "--release-repo-path is required when building the promoted "
                "releases index"
            )

        output_root = Path(args.release_repo_path) / "docs" / "feeds"
        write_json(
            output_root / PROMOTED_RELEASES_FILE,
            build_promoted_releases_feed(output_root),
        )
        print("Prepared current Companion promotion index")
        return

    if not args.release_ref or not args.release_owner or not args.release_repo:
        fail(
            "--release-ref, --release-owner, and --release-repo are required "
            "for release verification or promotion"
        )

    if args.resolve_release:
        if (
            args.verify_only
            or args.allow_draft
            or args.expected_release_id is not None
            or args.expected_release_tag is not None
            or args.release_repo_path
            or selected_promotion_target
        ):
            fail(
                "--resolve-release cannot be combined with verification or promotion options"
            )
    elif not args.verify_only and not selected_promotion_target:
        fail("At least one promotion target must be selected")

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        fail("GITHUB_TOKEN environment variable is required")

    if args.allow_draft and not args.verify_only:
        fail("--allow-draft may only be used with --verify-only")

    if args.resolve_release:
        print(
            json.dumps(
                resolve_release(
                    args.release_ref,
                    args.release_owner,
                    args.release_repo,
                    token,
                ),
                separators=(",", ":"),
                sort_keys=True,
            )
        )
        return

    release = fetch_release(
        args.release_ref,
        args.release_owner,
        args.release_repo,
        token,
    )
    release_id, tag_name = release_identity(release)
    validate_expected_release_identity(
        release_id,
        tag_name,
        args.expected_release_id,
        args.expected_release_tag,
    )
    validate_release_eligibility(release, tag_name, args.allow_draft)

    assets = release.get("assets", [])
    if not isinstance(assets, list) or not assets:
        fail(f"Release {tag_name} has no assets")

    verify_release_integrity(release, assets, token)

    if args.verify_only:
        print(f"Verified immutable Companion release {tag_name}")
        return

    if not args.release_repo_path:
        fail("--release-repo-path is required unless --verify-only is used")

    output_root = Path(args.release_repo_path) / "docs" / "feeds"

    if any(
        [
            args.companion_channel_test,
            args.companion_channel_beta,
            args.companion_channel_stable,
        ]
    ):
        tauri_feed = build_tauri_feed(release, assets)
        if args.companion_channel_test:
            write_json(
                output_root / "companion" / "tauri" / "test" / "latest.json", tauri_feed
            )
        if args.companion_channel_beta:
            write_json(
                output_root / "companion" / "tauri" / "beta" / "latest.json", tauri_feed
            )
        if args.companion_channel_stable:
            write_json(
                output_root / "companion" / "tauri" / "stable" / "latest.json",
                tauri_feed,
            )

    if args.sambee:
        sambee_metadata = build_sambee_metadata(release, assets)
        write_json(
            output_root / "sambee" / "companion" / "latest.json", sambee_metadata
        )

    write_json(
        output_root / PROMOTED_RELEASES_FILE,
        build_promoted_releases_feed(output_root),
    )

    print(f"Prepared promotion payloads for {tag_name}")


if __name__ == "__main__":
    main()
