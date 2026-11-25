"""Release checks are skipped only with matching, successful source CI."""

import sys
import urllib.error
from pathlib import Path
from typing import Any

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / ".github/scripts"))

import reuse_release_ci_tests as reuse_ci

SOURCE_SHA = "a" * 40
RUN = {
    "id": 42,
    "head_sha": SOURCE_SHA,
    "head_branch": "main",
    "event": "push",
    "status": "completed",
    "conclusion": "success",
}
FRONTEND_JOB = {
    "name": "frontend-checks",
    "conclusion": "success",
    "steps": [{"name": name, "conclusion": "success"} for name in reuse_ci.FRONTEND_REQUIRED_STEPS],
}
FRONTEND_COMMANDS = {
    "Run browser correctness contracts": "cd frontend && npm run test:browser:ci",
    "Verify frontend type correctness": "cd frontend && npm run typecheck",
}


def successful_shard(name: str) -> dict[str, Any]:
    return {"name": name, "conclusion": "success", "steps": [{"name": "Run Vitest shard", "conclusion": "success"}]}


SHARD_JOBS = [successful_shard(name) for name in sorted(reuse_ci.expected_shard_names())]
WRONG_TOTAL = len(SHARD_JOBS) + 1


def run_lookup(monkeypatch: pytest.MonkeyPatch, responses: list[dict[str, Any]]) -> set[str]:
    requested_urls: list[str] = []
    response_iterator = iter(responses)

    def github_get(url: str, _token: str) -> dict[str, Any]:
        requested_urls.append(url)
        return next(response_iterator)

    monkeypatch.setattr(reuse_ci, "github_get", github_get)
    result = reuse_ci.reusable_jobs("https://api.github.com", "owner/repo", SOURCE_SHA, "token")
    assert f"head_sha={SOURCE_SHA}" in requested_urls[0]
    assert "event=push" in requested_urls[0]
    assert "branch=main" in requested_urls[0]
    assert all("filter=latest" in url for url in requested_urls[1:])
    return result


def test_reuse_both_successful_jobs(monkeypatch: pytest.MonkeyPatch) -> None:
    assert run_lookup(
        monkeypatch,
        [
            {"workflow_runs": [RUN]},
            {"jobs": [{"name": "backend", "conclusion": "success"}, FRONTEND_JOB, *SHARD_JOBS]},
        ],
    ) == {"backend", "frontend"}


def test_skipped_or_failed_jobs_are_not_reused(monkeypatch: pytest.MonkeyPatch) -> None:
    assert run_lookup(
        monkeypatch,
        [
            {"workflow_runs": [RUN]},
            {"jobs": [{"name": "backend", "conclusion": "skipped"}, FRONTEND_JOB, *SHARD_JOBS]},
        ],
    ) == {"frontend"}


@pytest.mark.parametrize("conclusion", ["skipped", "failure", "cancelled", "missing"])
@pytest.mark.parametrize("required_step", FRONTEND_COMMANDS)
def test_frontend_reuse_requires_each_successful_gate(monkeypatch: pytest.MonkeyPatch, conclusion: str | None, required_step: str) -> None:
    job = {
        **FRONTEND_JOB,
        "steps": [
            {"name": name, "conclusion": conclusion if name == required_step else "success"}
            for name in FRONTEND_COMMANDS
            if name != required_step or conclusion != "missing"
        ],
    }
    assert run_lookup(monkeypatch, [{"workflow_runs": [RUN]}, {"jobs": [job, *SHARD_JOBS]}]) == set()


@pytest.mark.parametrize(
    "shards",
    [
        SHARD_JOBS[1:],
        [*SHARD_JOBS, successful_shard(f"frontend-tests (shard 0/{len(SHARD_JOBS)})")],
        [*SHARD_JOBS, SHARD_JOBS[0]],
        [successful_shard(f"frontend-tests (shard {index}/{WRONG_TOTAL})") for index in range(1, WRONG_TOTAL + 1)],
    ],
    ids=["missing", "extra", "duplicate", "wrong-total"],
)
def test_frontend_reuse_requires_exact_shard_names(monkeypatch: pytest.MonkeyPatch, shards: list[dict[str, Any]]) -> None:
    assert run_lookup(monkeypatch, [{"workflow_runs": [RUN]}, {"jobs": [FRONTEND_JOB, *shards]}]) == set()


@pytest.mark.parametrize("conclusion", ["failure", "skipped", "cancelled"])
def test_frontend_reuse_requires_successful_shard_steps(monkeypatch: pytest.MonkeyPatch, conclusion: str) -> None:
    shard = {**SHARD_JOBS[0], "steps": [{"name": "Run Vitest shard", "conclusion": conclusion}]}
    assert run_lookup(monkeypatch, [{"workflow_runs": [RUN]}, {"jobs": [FRONTEND_JOB, shard, *SHARD_JOBS[1:]]}]) == set()


@pytest.mark.parametrize("job", ["frontend-checks", "shard"])
@pytest.mark.parametrize("problem", ["missing", "failure"])
def test_frontend_reuse_requires_successful_jobs(monkeypatch: pytest.MonkeyPatch, job: str, problem: str) -> None:
    target, other_jobs = (FRONTEND_JOB, SHARD_JOBS) if job == "frontend-checks" else (SHARD_JOBS[0], [FRONTEND_JOB, *SHARD_JOBS[1:]])
    jobs = [*other_jobs, {**target, "conclusion": problem}] if problem == "failure" else other_jobs
    assert run_lookup(monkeypatch, [{"workflow_runs": [RUN]}, {"jobs": jobs}]) == set()


@pytest.mark.parametrize("conclusion", ["success", "failure"])
def test_legacy_advisory_type_check_is_not_release_evidence(monkeypatch: pytest.MonkeyPatch, conclusion: str) -> None:
    job = {
        **FRONTEND_JOB,
        "steps": [
            {"name": "Run browser correctness contracts", "conclusion": "success"},
            {"name": "TypeScript type check", "conclusion": conclusion},
        ],
    }
    assert run_lookup(monkeypatch, [{"workflow_runs": [RUN]}, {"jobs": [job, *SHARD_JOBS]}]) == set()


def test_legacy_single_frontend_job_is_not_reused(monkeypatch: pytest.MonkeyPatch) -> None:
    assert run_lookup(monkeypatch, [{"workflow_runs": [RUN]}, {"jobs": [{**FRONTEND_JOB, "name": "frontend"}]}]) == set()


@pytest.mark.parametrize("name,job", [("test.yml", "frontend-checks"), ("docker-image-preview-publish.yml", "validate-tests")])
def test_ci_and_release_require_the_same_browser_contract(name: str, job: str) -> None:
    assert reuse_ci.FRONTEND_REQUIRED_STEPS == FRONTEND_COMMANDS.keys()
    source = Path(__file__).resolve().parents[2] / ".github/workflows" / name
    steps = yaml.safe_load(source.read_text())["jobs"][job]["steps"]
    browser_npm = "npm" if job == "frontend-checks" else "HOME=/root npm"
    browser = f"cd frontend && {browser_npm} run test:browser:ci"
    required_commands = FRONTEND_COMMANDS | {"Run browser correctness contracts": browser}
    browser_steps = [step for step in steps if step.get("name") in reuse_ci.FRONTEND_REQUIRED_STEPS]
    assert len(browser_steps) == len(reuse_ci.FRONTEND_REQUIRED_STEPS)
    assert all(step["run"] == required_commands[step["name"]] and not step.get("continue-on-error") for step in browser_steps)
    commands = [step.get("run") for step in steps]
    typecheck = "cd frontend && npm run typecheck"
    build = "cd frontend && npm run build:assets" if job == "frontend-checks" else "cd frontend && npm run build"
    assert commands.index(typecheck) < commands.index(build) < commands.index(browser)
    assert f"cd frontend && {browser_npm} run test:e2e:install -- --with-deps" in commands
    assert any(step.get("with", {}).get("path") == "frontend/test-results/ci/" and step["with"]["retention-days"] == 7 for step in steps)


@pytest.mark.parametrize(
    "runs",
    [
        [],
        [{**RUN, "head_sha": "b" * 40}],
        [{**RUN, "event": "pull_request"}],
        [{**RUN, "head_branch": "feature"}],
        [{**RUN, "status": "in_progress", "conclusion": None}],
        [{**RUN, "conclusion": "failure"}],
    ],
)
def test_missing_or_untrusted_run_is_not_reused(monkeypatch: pytest.MonkeyPatch, runs: list[dict[str, Any]]) -> None:
    assert run_lookup(monkeypatch, [{"workflow_runs": runs}]) == set()


def test_api_failure_runs_both_suites(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    output = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("SOURCE_SHA", SOURCE_SHA)
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setenv("GITHUB_TOKEN", "token")

    def github_get(_url: str, _token: str) -> dict[str, Any]:
        raise urllib.error.URLError("API unavailable")

    monkeypatch.setattr(reuse_ci, "github_get", github_get)
    assert reuse_ci.main() == 0
    assert output.read_text(encoding="utf-8") == "backend=false\nfrontend=false\n"


def test_incomplete_job_list_does_not_reuse_partial_results(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    output = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setenv("SOURCE_SHA", SOURCE_SHA)
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setenv("GITHUB_TOKEN", "token")

    responses = iter(
        [
            {"workflow_runs": [RUN]},
            {"jobs": [{"name": "backend", "conclusion": "success"}] * reuse_ci.JOBS_PER_PAGE},
        ]
    )

    def github_get(_url: str, _token: str) -> dict[str, Any]:
        try:
            return next(responses)
        except StopIteration as error:
            raise urllib.error.URLError("job list interrupted") from error

    monkeypatch.setattr(reuse_ci, "github_get", github_get)
    assert reuse_ci.main() == 0
    assert output.read_text(encoding="utf-8") == "backend=false\nfrontend=false\n"
