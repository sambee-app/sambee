#!/usr/bin/env python3
"""Select CI components from changed repository paths."""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from collections.abc import Iterable
from typing import TextIO

BACKEND_EXTRAS = frozenset(
    {
        ".dockerignore",
        "Dockerfile",
        ".github/scripts/cleanup_actions_caches.py",
        ".github/workflows/cleanup-actions-caches.yml",
        ".github/workflows/signal-closed-pr-cache-cleanup.yml",
        "scripts/install-system-deps",
        "scripts/setup-test-images",
        "scripts/verify-python-runtime-image.py",
        ".github/actions/setup-runtime-python/action.yml",
        ".github/scripts/reuse_release_ci_tests.py",
        "scripts/check_ci_test_gate.py",
    }
)
FRONTEND_EXTRAS = frozenset(
    {
        "VERSION",
        "scripts/sync-version",
        "scripts/ci_change_detector.py",
        "scripts/check_ci_test_gate.py",
        ".github/workflows/test.yml",
        ".github/workflows/lint.yml",
        ".github/workflows/docker-image-preview-publish.yml",
        ".github/scripts/reuse_release_ci_tests.py",
        ".github/actions/sync-version-check/action.yml",
    }
)
COMPANION_EXTRAS = frozenset({"VERSION", "scripts/sync-version"})
WEBSITE_EXTRAS = frozenset({"VERSION"})
FULL_TREE_DIFF_BASE = "__empty_tree__"
ARCHIVE_TOPOLOGY_PREFIXES = (
    "archive-contract/",
    "backend/app/services/archive/",
    "backend/tests/test_archive",
    "companion/src-tauri/src/server/archive",
)
ARCHIVE_TOPOLOGY_PATHS = frozenset(
    {
        "backend/app/api/archive_operations.py",
        "backend/app/api/browser.py",
        "backend/app/api/viewer.py",
        "backend/tests/test_archive_conformance.py",
        "backend/tests/test_archive_operations.py",
        "backend/tests/test_archive_topology_conformance_harness.py",
        "companion/src-tauri/src/server/archive.rs",
        "companion/src-tauri/src/server/archive_sessions.rs",
        "companion/src-tauri/src/server/handlers.rs",
        "scripts/test",
        "scripts/test-archive-topology-conformance",
        "scripts/ci_change_detector.py",
        "backend/tests/test_ci_change_detector.py",
        ".github/workflows/test.yml",
    }
)


def classify_paths(filenames: Iterable[str]) -> dict[str, bool]:
    """Return the CI jobs required for the supplied changed paths."""

    paths = frozenset(filenames)
    archive_topology = any(
        path.startswith(ARCHIVE_TOPOLOGY_PREFIXES) or path in ARCHIVE_TOPOLOGY_PATHS
        for path in paths
    )
    return {
        "backend": archive_topology
        or any(path.startswith("backend/") or path in BACKEND_EXTRAS for path in paths),
        "frontend": any(
            path.startswith("frontend/") or path in FRONTEND_EXTRAS for path in paths
        ),
        "companion": archive_topology
        or any(
            path.startswith("companion/") or path in COMPANION_EXTRAS for path in paths
        ),
        "website": any(
            path.startswith("website/")
            or path.startswith("website-meta/")
            or path in WEBSITE_EXTRAS
            for path in paths
        ),
    }


def write_output(output: TextIO, name: str, value: str | bool) -> None:
    """Write one GitHub Actions step output."""

    rendered_value = "true" if value is True else "false" if value is False else value
    output.write(f"{name}={rendered_value}\n")


def github_api_request(url: str, headers: dict[str, str]) -> object:
    """Fetch and decode one GitHub REST API response."""

    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def pull_request_filenames(
    event: dict[str, object], *, api_url: str, repository: str, headers: dict[str, str]
) -> list[str]:
    """Fetch every changed filename for a pull request."""

    pull_request = event.get("pull_request")
    if not isinstance(pull_request, dict) or not isinstance(
        pull_request.get("number"), int
    ):
        raise ValueError("pull_request event payload is missing pull_request.number")

    filenames: list[str] = []
    page = 1
    while True:
        files = github_api_request(
            f"{api_url}/repos/{repository}/pulls/{pull_request['number']}/files?per_page=100&page={page}",
            headers,
        )
        if not isinstance(files, list):
            raise ValueError("GitHub pull-request files response is not a list")
        if not files:
            return filenames
        for file in files:
            if not isinstance(file, dict) or not isinstance(file.get("filename"), str):
                raise ValueError(
                    "GitHub pull-request files response contains an invalid filename"
                )
            filenames.append(file["filename"])
        if len(files) < 100:
            return filenames
        page += 1


def push_filenames(
    before: str, after: str, *, api_url: str, repository: str, headers: dict[str, str]
) -> list[str]:
    """Fetch every changed filename for a push comparison."""

    comparison = github_api_request(
        f"{api_url}/repos/{repository}/compare/{before}...{after}", headers
    )
    if not isinstance(comparison, dict) or not isinstance(
        comparison.get("files"), list
    ):
        raise ValueError("GitHub comparison response is missing files")
    filenames: list[str] = []
    for file in comparison["files"]:
        if not isinstance(file, dict) or not isinstance(file.get("filename"), str):
            raise ValueError("GitHub comparison response contains an invalid filename")
        filenames.append(file["filename"])
    return filenames


def main() -> int:
    output_path = os.environ["GITHUB_OUTPUT"]
    event_name = os.environ["GITHUB_EVENT_NAME"]
    with open(output_path, "a", encoding="utf-8") as output:
        if event_name == "workflow_dispatch":
            for component in ("backend", "frontend", "companion", "website"):
                write_output(output, component, True)
            write_output(output, "diff_base", FULL_TREE_DIFF_BASE)
            return 0

        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as event_file:
            event = json.load(event_file)
        if not isinstance(event, dict):
            raise ValueError("GitHub event payload is not an object")

        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
            "User-Agent": "sambee-ci-change-detector",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        api_url = os.environ.get("GITHUB_API_URL", "https://api.github.com")
        repository = os.environ["GITHUB_REPOSITORY"]
        diff_base = ""
        if event_name == "pull_request":
            pull_request = event.get("pull_request")
            if not isinstance(pull_request, dict) or not isinstance(
                pull_request.get("base"), dict
            ):
                raise ValueError(
                    "pull_request event payload is missing pull_request.base"
                )
            base = pull_request["base"].get("sha")
            if not isinstance(base, str) or not base:
                raise ValueError(
                    "pull_request event payload is missing pull_request.base.sha"
                )
            diff_base = base
            filenames = pull_request_filenames(
                event, api_url=api_url, repository=repository, headers=headers
            )
        elif event_name == "push":
            before = event.get("before")
            if not isinstance(before, str) or not before or set(before) == {"0"}:
                selections = {
                    component: True
                    for component in ("backend", "frontend", "companion", "website")
                }
                filenames = []
                diff_base = FULL_TREE_DIFF_BASE
                print(
                    "Push event is missing a valid 'before' SHA; running all components"
                )
            else:
                diff_base = before
                filenames = push_filenames(
                    before,
                    os.environ["GITHUB_SHA"],
                    api_url=api_url,
                    repository=repository,
                    headers=headers,
                )
                selections = classify_paths(filenames)
        else:
            raise ValueError(f"Unsupported event for change detection: {event_name}")

        if event_name == "pull_request":
            selections = classify_paths(filenames)
        print(f"Detected {len(filenames)} changed files")
        print(
            " ".join(
                f"{component}={enabled}" for component, enabled in selections.items()
            )
        )
        for component, enabled in selections.items():
            write_output(output, component, enabled)
        write_output(output, "diff_base", diff_base)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyError, OSError, ValueError, urllib.error.URLError) as error:
        print(f"CI change detection failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
