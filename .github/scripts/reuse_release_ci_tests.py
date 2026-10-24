#!/usr/bin/env python3
"""Reuse successful source checks from CI on the exact release commit."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

COMPONENTS = ("backend", "frontend")
CI_WORKFLOW = "test.yml"
API_TIMEOUT_SECONDS = 10
JOBS_PER_PAGE = 100
FRONTEND_REQUIRED_STEPS = frozenset({"Run browser correctness contracts"})


def github_get(url: str, token: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "sambee-release-ci-reuse",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=API_TIMEOUT_SECONDS) as response:
        payload = json.load(response)
    if not isinstance(payload, dict):
        raise ValueError("GitHub API response is not an object")
    return payload


def reusable_jobs(api_url: str, repository: str, sha: str, token: str) -> set[str]:
    query = urllib.parse.urlencode(
        {"head_sha": sha, "event": "push", "branch": "main", "per_page": 1}
    )
    workflow_url = f"{api_url}/repos/{repository}/actions/workflows/{CI_WORKFLOW}/runs"
    runs = github_get(f"{workflow_url}?{query}", token).get("workflow_runs")
    if not isinstance(runs, list):
        raise ValueError("CI workflow runs response is missing workflow_runs")
    if not runs:
        return set()

    run = runs[0]
    if not isinstance(run, dict):
        raise ValueError("CI workflow run is not an object")
    if (
        run.get("head_sha") != sha
        or run.get("event") != "push"
        or run.get("head_branch") != "main"
        or run.get("status") != "completed"
        or run.get("conclusion") != "success"
    ):
        return set()
    run_id = run.get("id")
    if not isinstance(run_id, int) or isinstance(run_id, bool) or run_id <= 0:
        raise ValueError("CI workflow run is missing a valid id")

    successful: set[str] = set()
    page = 1
    while True:
        jobs_url = (
            f"{api_url}/repos/{repository}/actions/runs/{run_id}/jobs?"
            f"filter=latest&per_page={JOBS_PER_PAGE}&page={page}"
        )
        jobs = github_get(jobs_url, token).get("jobs")
        if not isinstance(jobs, list):
            raise ValueError("CI workflow jobs response is missing jobs")
        for job in jobs:
            if not isinstance(job, dict):
                raise ValueError("CI workflow job is not an object")
            if job.get("name") in COMPONENTS and job.get("conclusion") == "success":
                if job["name"] == "frontend":
                    steps = job.get("steps", [])
                    if not isinstance(steps, list):
                        raise ValueError("Frontend CI job steps are not a list")
                    successful_steps = {
                        step.get("name")
                        for step in steps
                        if isinstance(step, dict)
                        and step.get("conclusion") == "success"
                        and isinstance(step.get("name"), str)
                    }
                    if not FRONTEND_REQUIRED_STEPS <= successful_steps:
                        continue
                successful.add(job["name"])
        if len(jobs) < JOBS_PER_PAGE:
            return successful
        page += 1


def main() -> int:
    successful: set[str] = set()
    try:
        sha = os.environ["SOURCE_SHA"]
        if len(sha) != 40 or any(
            character not in "0123456789abcdefABCDEF" for character in sha
        ):
            raise ValueError("release source SHA is not a full commit hash")
        successful = reusable_jobs(
            os.environ.get("GITHUB_API_URL", "https://api.github.com"),
            os.environ["GITHUB_REPOSITORY"],
            sha,
            os.environ["GITHUB_TOKEN"],
        )
    except (KeyError, OSError, ValueError, urllib.error.URLError) as error:
        print(
            f"Cannot verify source CI; running release tests: {error}", file=sys.stderr
        )

    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        for component in COMPONENTS:
            reuse = component in successful
            output.write(f"{component}={'true' if reuse else 'false'}\n")
            print(
                f"{component}: {'reuse successful source CI' if reuse else 'run release checks'}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
