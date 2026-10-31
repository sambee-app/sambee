"""Select obsolete Actions caches without sacrificing active CI cache hits."""

from __future__ import annotations

import argparse
import json
import os
import re
import urllib.error
import urllib.request
from collections.abc import Iterable
from http import HTTPStatus
from typing import Any

PR_REF = re.compile(r"^refs/pull/(\d+)/merge$")
RUST_KEY = re.compile(
    r"^(v\d+-rust-(?:lint-companion|companion)-[^-]+-[^-]+)-[0-9a-f]{8}-[0-9a-f]{8}$"
)
MAIN_REF = "refs/heads/main"
API_URL = "https://api.github.com"
ACTIVE_STATUSES = ("queued", "in_progress", "waiting", "requested", "pending")
CLEANUP_WORKFLOW = "Maintenance: Clean Up Actions Caches"
WARN_BYTES = 8 * 1024**3
CRITICAL_BYTES = 9 * 1024**3
ABSENT_CACHE_REASON = "absent: cache already removed"


def cache_family(key: str) -> str | None:
    """Only group keys whose changing suffix is known to represent a new snapshot."""
    rust = RUST_KEY.fullmatch(key)
    if rust:
        return rust.group(1)
    if key.startswith("website-lfs-"):
        return "website-lfs"
    if key.startswith("website-hugo-resources-"):
        return "website-hugo-resources"
    return None


def classify_caches(
    caches: Iterable[dict[str, Any]],
    open_prs: set[int],
    active_refs: set[str],
    protect_all_prs: bool = False,
) -> list[dict[str, Any]]:
    """Return decisions sorted by ID; unknown refs and cache formats fail closed."""
    entries = list(caches)
    newest: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in entries:
        family = cache_family(entry["key"])
        if family:
            group = (entry["ref"], family)
            if group not in newest or (entry["created_at"], entry["id"]) > (
                newest[group]["created_at"],
                newest[group]["id"],
            ):
                newest[group] = entry

    decisions = []
    for entry in sorted(entries, key=lambda cache: cache["id"]):
        ref = entry["ref"]
        match = PR_REF.fullmatch(ref)
        reason = "protected: unclassified"
        if ref in active_refs:
            reason = "protected: build in progress"
        elif match and protect_all_prs:
            reason = "protected: unidentified pull request build"
        elif match and int(match.group(1)) not in open_prs:
            reason = "delete: closed pull request"
        elif ref == MAIN_REF or match:
            family = cache_family(entry["key"])
            if family and newest[(ref, family)]["id"] != entry["id"]:
                reason = "delete: superseded cache"
            else:
                reason = "protected: current cache" if family else reason
        decisions.append({**entry, "reason": reason})
    return decisions


def api_request(path: str, token: str, method: str = "GET") -> Any:
    request = urllib.request.Request(f"{API_URL}{path}", method=method)
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("User-Agent", "sambee-actions-cache-cleanup")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    with urllib.request.urlopen(request) as response:
        return json.load(response) if response.status != 204 else None


def list_pages(path: str, field: str, token: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 1
    while True:
        separator = "&" if "?" in path else "?"
        result = api_request(f"{path}{separator}per_page=100&page={page}", token)
        batch = result[field]
        if not isinstance(batch, list) or any(
            not isinstance(item, dict) for item in batch
        ):
            raise RuntimeError(f"Unexpected GitHub API response for {path}")
        items.extend(batch)
        if len(batch) < 100:
            return items
        page += 1


def active_build_refs(
    repository: str, token: str, own_run_id: int
) -> tuple[set[str], bool]:
    refs: set[str] = set()
    unknown_pr = False
    for status in ACTIVE_STATUSES:
        runs = list_pages(
            f"/repos/{repository}/actions/runs?status={status}", "workflow_runs", token
        )
        for run in runs:
            if run["id"] == own_run_id or run["name"] == CLEANUP_WORKFLOW:
                continue
            if run["event"] == "pull_request":
                pull_requests = run.get("pull_requests") or []
                if not pull_requests:
                    unknown_pr = True
                for pull in pull_requests:
                    refs.add(f"refs/pull/{pull['number']}/merge")
            elif run["head_branch"] == "main":
                refs.add(MAIN_REF)
    return refs, unknown_pr


def open_pull_requests(
    repository: str, caches: list[dict[str, Any]], token: str
) -> set[int]:
    numbers = {
        int(match.group(1))
        for entry in caches
        if (match := PR_REF.fullmatch(entry["ref"]))
    }
    open_prs = set()
    for number in numbers:
        pull = api_request(f"/repos/{repository}/pulls/{number}", token)
        if not isinstance(pull, dict) or pull.get("state") not in {"open", "closed"}:
            raise RuntimeError(f"Cannot determine state of pull request #{number}")
        if pull["state"] == "open":
            open_prs.add(number)
    return open_prs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true", help="Delete selected caches (default: dry run)"
    )
    args = parser.parse_args()
    token = os.environ["GITHUB_TOKEN"]
    repository = os.environ["GITHUB_REPOSITORY"]
    base = f"/repos/{repository}"
    caches = list_pages(f"{base}/actions/caches", "actions_caches", token)
    open_prs = open_pull_requests(repository, caches, token)
    active_refs, unknown_pr = active_build_refs(
        repository, token, int(os.environ["GITHUB_RUN_ID"])
    )
    decisions = classify_caches(caches, open_prs, active_refs, unknown_pr)
    deleted_bytes = 0
    absent_bytes = 0
    for entry in decisions:
        reason = entry["reason"]
        if args.apply and reason.startswith("delete:"):
            try:
                api_request(
                    f"{base}/actions/caches/{entry['id']}", token, method="DELETE"
                )
            except urllib.error.HTTPError as error:
                error.close()
                if error.code != HTTPStatus.NOT_FOUND:
                    raise
                entry["reason"] = ABSENT_CACHE_REASON
                absent_bytes += entry["size_in_bytes"]
            else:
                deleted_bytes += entry["size_in_bytes"]
        print(
            json.dumps(
                {
                    field: entry[field]
                    for field in ("id", "ref", "key", "size_in_bytes", "reason")
                }
            )
        )
    total_bytes = sum(entry["size_in_bytes"] for entry in caches)
    eligible_bytes = sum(
        entry["size_in_bytes"]
        for entry in decisions
        if entry["reason"].startswith("delete:")
        or entry["reason"] == ABSENT_CACHE_REASON
    )
    remaining_bytes = total_bytes - (
        deleted_bytes + absent_bytes if args.apply else eligible_bytes
    )
    message = (
        f"Actions cache cleanup: {len(caches)} entries, "
        f"{total_bytes} bytes before cleanup, {eligible_bytes} bytes eligible, "
        f"{deleted_bytes} bytes deleted, mode={'apply' if args.apply else 'dry-run'}."
    )
    if absent_bytes:
        message += f" {absent_bytes} bytes already absent when deletion was attempted."
    if remaining_bytes >= CRITICAL_BYTES:
        message += (
            " Critical: active caches still exceed 9 GiB; review the cache limit."
        )
    elif remaining_bytes >= WARN_BYTES:
        message += (
            " Warning: active caches still exceed 8 GiB; monitor cache evictions."
        )
    if remaining_bytes >= WARN_BYTES:
        print(f"::warning title=Actions cache storage::{message}")
    print(message)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write(f"## Actions cache cleanup\n\n{message}\n\n")
            for entry in decisions:
                if (
                    entry["reason"].startswith("delete:")
                    or entry["reason"] == ABSENT_CACHE_REASON
                ):
                    summary.write(
                        f"- {entry['reason']}: `{entry['ref']}` / `{entry['key']}` ({entry['size_in_bytes']} bytes)\n"
                    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
