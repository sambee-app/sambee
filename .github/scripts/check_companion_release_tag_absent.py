from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, NoReturn

API_VERSION = "2022-11-28"
PER_PAGE = 100


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
            "User-Agent": "sambee-companion-build-workflow",
            "X-GitHub-Api-Version": API_VERSION,
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


def iter_releases(owner: str, repo: str, token: str) -> list[dict[str, Any]]:
    page = 1
    releases: list[dict[str, Any]] = []

    while True:
        url = (
            f"https://api.github.com/repos/{owner}/{repo}/releases"
            f"?per_page={PER_PAGE}&page={page}"
        )
        payload = request_json(url, token)
        if not isinstance(payload, list):
            fail(f"Unexpected API response while listing releases for {owner}/{repo}")
        if not payload:
            return releases

        for release in payload:
            if isinstance(release, dict):
                releases.append(release)

        if len(payload) < PER_PAGE:
            return releases
        page += 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        fail("GITHUB_TOKEN environment variable is required")

    try:
        releases = iter_releases(args.owner, args.repo, token)
    except GitHubApiError as error:
        fail(
            f"Unable to list releases in {args.owner}/{args.repo}: "
            f"HTTP {error.status_code} {error.message}"
        )

    for release in releases:
        if release.get("tag_name") != args.tag:
            continue

        state = "draft" if release.get("draft") else "published"
        fail(
            f"Release tag {args.tag} already exists in {args.owner}/{args.repo} as a {state} release. "
            "Choose a distinct version, for example by adding a beta or rc suffix."
        )

    print(f"Release tag {args.tag} is available in {args.owner}/{args.repo}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
