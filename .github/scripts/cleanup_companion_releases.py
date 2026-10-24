"""Delete obsolete Companion GitHub Releases after validating every feed marker."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

GITHUB_API_URL = "https://api.github.com"
GITHUB_WEB_HOST = "github.com"
VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
RELEASE_TAG_RE = re.compile(
    r"^companion-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$"
)
MARKER_PATHS = {
    "test": Path("docs/feeds/companion/tauri/test/latest.json"),
    "beta": Path("docs/feeds/companion/tauri/beta/latest.json"),
    "stable": Path("docs/feeds/companion/tauri/stable/latest.json"),
    "sambee": Path("docs/feeds/sambee/companion/latest.json"),
}


@dataclass(frozen=True)
class Marker:
    channel: str
    version: tuple[int, int, int]
    release_tag: str
    asset_names: frozenset[str]


@dataclass(frozen=True)
class Release:
    release_id: int
    tag_name: str | None
    draft: bool
    prerelease: bool
    created_at: str


def fail(message: str) -> None:
    raise RuntimeError(message)


def parse_version(value: object, description: str) -> tuple[int, int, int]:
    if not isinstance(value, str):
        fail(f"{description} must be a plain numeric X.Y.Z version")
    match = VERSION_RE.fullmatch(value)
    if match is None:
        fail(f"{description} must be a plain numeric X.Y.Z version")
    return tuple(int(component) for component in match.groups())


def parse_release_tag(
    tag_name: object, description: str
) -> tuple[str, tuple[int, int, int]]:
    if not isinstance(tag_name, str):
        fail(f"{description} must be a canonical Companion release tag")
    match = RELEASE_TAG_RE.fullmatch(tag_name)
    if match is None:
        fail(f"{description} must be a canonical Companion release tag")
    return tag_name, parse_version(match.group(1), description)


def api_request(url: str, token: str, method: str = "GET") -> object | None:
    request = urllib.request.Request(url, method=method)
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("User-Agent", "sambee-companion-release-cleanup")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    with urllib.request.urlopen(request) as response:
        if response.status == 204:
            return None
        payload = response.read()
        if not payload:
            return None
        return json.loads(payload)


def paginated_api_list(url: str, token: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    page = 1
    while True:
        separator = "&" if "?" in url else "?"
        payload = api_request(f"{url}{separator}per_page=100&page={page}", token)
        if not isinstance(payload, list):
            fail("GitHub API returned an unexpected paginated response")
        for item in payload:
            if not isinstance(item, dict):
                fail("GitHub API returned an invalid list item")
            result.append(item)
        if len(payload) < 100:
            return result
        page += 1


def parse_release_asset_url(
    value: object, owner: str, repo: str, description: str
) -> tuple[str, str]:
    if not isinstance(value, str) or not value:
        fail(f"{description} must contain a GitHub Release asset URL")
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "https" or parsed.netloc.casefold() != GITHUB_WEB_HOST:
        fail(f"{description} must use https://github.com")
    path = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
    if (
        len(path) != 6
        or path[0].casefold() != owner.casefold()
        or path[1].casefold() != repo.casefold()
        or path[2] != "releases"
        or path[3] != "download"
    ):
        fail(f"{description} must reference {owner}/{repo} release assets")
    release_tag, _version = parse_release_tag(path[4], description)
    asset_name = path[5]
    if not asset_name or "/" in asset_name or "\\" in asset_name:
        fail(f"{description} has an invalid release asset name")
    return release_tag, asset_name


def parse_tauri_marker(
    path: Path, payload: dict[str, Any], owner: str, repo: str
) -> Marker:
    version = parse_version(payload.get("version"), f"Tauri marker {path}")
    platforms = payload.get("platforms")
    if not isinstance(platforms, dict) or not platforms:
        fail(f"Tauri marker {path} must contain a non-empty platforms object")
    references = [
        parse_release_asset_url(
            platform.get("url") if isinstance(platform, dict) else None,
            owner,
            repo,
            f"Tauri marker {path} platform {platform_name}",
        )
        for platform_name, platform in platforms.items()
    ]
    tags = {tag for tag, _asset_name in references}
    if len(tags) != 1:
        fail(f"Tauri marker {path} references multiple Companion releases")
    release_tag = tags.pop()
    _tag, tag_version = parse_release_tag(release_tag, f"Tauri marker {path}")
    if tag_version != version:
        fail(f"Tauri marker {path} version does not match its release tag")
    return Marker(
        path.parent.name,
        version,
        release_tag,
        frozenset(asset for _tag, asset in references),
    )


def parse_sambee_marker(
    path: Path, payload: dict[str, Any], owner: str, repo: str
) -> Marker:
    version = parse_version(payload.get("version"), f"Sambee marker {path}")
    assets = payload.get("assets")
    if not isinstance(assets, dict) or not assets:
        fail(f"Sambee marker {path} must contain a non-empty assets object")
    references = [
        parse_release_asset_url(
            url, owner, repo, f"Sambee marker {path} asset {platform}"
        )
        for platform, url in assets.items()
    ]
    tags = {tag for tag, _asset_name in references}
    if len(tags) != 1:
        fail(f"Sambee marker {path} references multiple Companion releases")
    release_tag = tags.pop()
    _tag, tag_version = parse_release_tag(release_tag, f"Sambee marker {path}")
    if tag_version != version:
        fail(f"Sambee marker {path} version does not match its release tag")
    return Marker(
        "sambee", version, release_tag, frozenset(asset for _tag, asset in references)
    )


def load_markers(release_repo_path: Path, owner: str, repo: str) -> list[Marker]:
    markers: list[Marker] = []
    for channel, relative_path in MARKER_PATHS.items():
        path = release_repo_path / relative_path
        if not path.exists():
            continue
        if not path.is_file():
            fail(f"Companion marker {path} is not a file")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            fail(f"Companion marker {path} is not valid JSON: {error}")
        if not isinstance(payload, dict):
            fail(f"Companion marker {path} must contain a JSON object")
        if channel == "sambee":
            markers.append(parse_sambee_marker(path, payload, owner, repo))
        else:
            markers.append(parse_tauri_marker(path, payload, owner, repo))
    return markers


def load_releases(owner: str, repo: str, token: str) -> list[Release]:
    payload = paginated_api_list(
        f"{GITHUB_API_URL}/repos/{owner}/{repo}/releases", token
    )
    releases: list[Release] = []
    for item in payload:
        release_id = item.get("id")
        tag_name = item.get("tag_name")
        draft = item.get("draft")
        prerelease = item.get("prerelease")
        created_at = item.get("created_at")
        if (
            not isinstance(release_id, int)
            or release_id <= 0
            or tag_name is not None
            and not isinstance(tag_name, str)
            or not isinstance(draft, bool)
            or not isinstance(prerelease, bool)
            or not isinstance(created_at, str)
        ):
            fail("GitHub Releases API returned an invalid release record")
        releases.append(Release(release_id, tag_name, draft, prerelease, created_at))
    return releases


def find_marker_releases(
    markers: list[Marker], releases: list[Release]
) -> dict[str, Release]:
    by_tag: dict[str, list[Release]] = {}
    for release in releases:
        if release.tag_name:
            by_tag.setdefault(release.tag_name, []).append(release)
    duplicate_tags = sorted(
        tag_name for tag_name, candidates in by_tag.items() if len(candidates) > 1
    )
    if duplicate_tags:
        fail(
            f"GitHub Releases API returned duplicate release tags: {', '.join(duplicate_tags)}"
        )
    resolved: dict[str, Release] = {}
    for marker in markers:
        candidates = by_tag.get(marker.release_tag, [])
        if len(candidates) != 1:
            fail(
                f"Marker {marker.channel} does not resolve to exactly one GitHub Release"
            )
        release = candidates[0]
        if release.draft or release.prerelease:
            fail(
                f"Marker {marker.channel} references a draft or prerelease GitHub Release"
            )
        resolved[marker.channel] = release
    return resolved


def load_release_asset_names(
    owner: str, repo: str, release_id: int, token: str
) -> set[str]:
    assets = paginated_api_list(
        f"{GITHUB_API_URL}/repos/{owner}/{repo}/releases/{release_id}/assets", token
    )
    names: set[str] = set()
    for asset in assets:
        name = asset.get("name")
        if not isinstance(name, str) or not name or name in names:
            fail("GitHub Release assets API returned an invalid asset record")
        names.add(name)
    return names


def validate_marker_assets(
    markers: list[Marker],
    resolved_releases: dict[str, Release],
    owner: str,
    repo: str,
    token: str,
) -> None:
    for marker in markers:
        asset_names = load_release_asset_names(
            owner, repo, resolved_releases[marker.channel].release_id, token
        )
        missing_assets = marker.asset_names - asset_names
        if missing_assets:
            fail(
                f"Marker {marker.channel} references missing release assets: "
                f"{', '.join(sorted(missing_assets))}"
            )


def classify_releases(
    releases: list[Release], protected_ids: set[int]
) -> dict[int, str]:
    latest_by_series: dict[tuple[int, int], tuple[tuple[int, int, int], int]] = {}
    for release in releases:
        if release.draft or release.prerelease or release.tag_name is None:
            continue
        match = RELEASE_TAG_RE.fullmatch(release.tag_name)
        if match is None:
            continue
        version = parse_version(match.group(1), f"GitHub Release {release.release_id}")
        series = version[:2]
        current = latest_by_series.get(series)
        if current is None or version > current[0]:
            latest_by_series[series] = (version, release.release_id)

    latest_ids = {release_id for _version, release_id in latest_by_series.values()}
    classification: dict[int, str] = {}
    for release in releases:
        if release.release_id in protected_ids:
            classification[release.release_id] = "marker-protected"
        elif release.release_id in latest_ids:
            classification[release.release_id] = "latest-series"
        else:
            classification[release.release_id] = "deletable"
    return classification


def emit_log(release: Release, classification: str, action: str) -> None:
    print(
        json.dumps(
            {
                "release_id": release.release_id,
                "tag_name": release.tag_name,
                "draft": release.draft,
                "prerelease": release.prerelease,
                "created_at": release.created_at,
                "classification": classification,
                "action": action,
            },
            sort_keys=True,
        )
    )


def delete_release(owner: str, repo: str, release_id: int, token: str) -> None:
    api_request(
        f"{GITHUB_API_URL}/repos/{owner}/{repo}/releases/{release_id}",
        token,
        method="DELETE",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-repo-path", required=True)
    parser.add_argument("--release-owner", required=True)
    parser.add_argument("--release-repo", required=True)
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        fail("GITHUB_TOKEN is required")

    markers = load_markers(
        Path(args.release_repo_path), args.release_owner, args.release_repo
    )
    releases = load_releases(args.release_owner, args.release_repo, token)
    resolved_releases = find_marker_releases(markers, releases)
    validate_marker_assets(
        markers, resolved_releases, args.release_owner, args.release_repo, token
    )
    classifications = classify_releases(
        releases, {release.release_id for release in resolved_releases.values()}
    )

    for release in releases:
        emit_log(
            release,
            classifications[release.release_id],
            "delete-candidate"
            if classifications[release.release_id] == "deletable"
            else "protect",
        )
    for release in sorted(releases, key=lambda item: item.created_at, reverse=True):
        if classifications[release.release_id] != "deletable":
            continue
        delete_release(args.release_owner, args.release_repo, release.release_id, token)
        emit_log(release, "deletable", "delete")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, urllib.error.HTTPError, urllib.error.URLError) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
