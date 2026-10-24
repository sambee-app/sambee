"""Regression tests for CI component selection."""

import ast
import json
import re
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import ci_change_detector
from check_ci_test_gate import COMPONENT_JOBS, gate_errors
from ci_change_detector import ARCHIVE_TOPOLOGY_PATHS, FULL_TREE_DIFF_BASE, classify_paths


@pytest.mark.parametrize(
    "path",
    [
        "archive-contract/v2/fixtures/topology-execution-traces-v2.json",
        "backend/app/services/archive/coordinator.py",
        "backend/tests/test_archive_future.py",
        "companion/src-tauri/src/server/archive_new_adapter.rs",
        *sorted(ARCHIVE_TOPOLOGY_PATHS),
    ],
)
def test_archive_topology_paths_schedule_both_runtime_jobs(path: str) -> None:
    selections = classify_paths([path])

    assert selections["backend"]
    assert selections["companion"]


def test_non_topology_component_changes_remain_selective() -> None:
    assert classify_paths(["backend/app/api/auth.py"]) == {
        "backend": True,
        "frontend": False,
        "companion": False,
        "website": False,
    }
    assert classify_paths(["companion/src/lib.rs"]) == {
        "backend": False,
        "frontend": False,
        "companion": True,
        "website": False,
    }
    assert classify_paths(["frontend/src/App.tsx"]) == {
        "backend": False,
        "frontend": True,
        "companion": False,
        "website": False,
    }


@pytest.mark.parametrize("path", sorted(ci_change_detector.FRONTEND_EXTRAS))
def test_frontend_ci_infrastructure_runs_frontend_checks(path: str) -> None:
    assert classify_paths([path])["frontend"]


def test_workflows_use_latest_x64_and_supported_arm_ubuntu_labels() -> None:
    workflows = Path(__file__).resolve().parents[2] / ".github/workflows"
    allowed = {"ubuntu-latest", "ubuntu-26.04-arm"}
    for workflow in workflows.glob("*.yml"):
        source = workflow.read_text()
        assert isinstance(yaml.safe_load(source)["jobs"], dict), workflow.name
        labels = set(re.findall(r"ubuntu-[\w.-]+", source))
        assert labels <= allowed, f"{workflow.name}: unexpected Ubuntu labels {labels - allowed}"


@pytest.mark.parametrize(
    ("path", "requires_lint"),
    [
        ("backend/app/main.py", True),
        (".github/scripts/promote_companion_release.py", True),
        ("website/scripts/validate-docs-content.py", True),
        ("scripts/ci_change_detector.py", True),
        (".github/workflows/lint.yml", True),
        ("scripts/test", True),
        ("frontend/src/App.tsx", False),
    ],
)
def test_python_and_lint_infrastructure_changes_schedule_backend_lint(path: str, requires_lint: bool) -> None:
    workflow_path = Path(__file__).resolve().parents[2] / ".github/workflows/lint.yml"
    workflow = yaml.safe_load(workflow_path.read_text())
    detector = ast.parse(workflow["jobs"]["changes"]["steps"][0]["run"].split("\n", 1)[1].rsplit("\nPY", 1)[0])
    selection = ast.Module(
        body=[
            statement
            for statement in detector.body
            if isinstance(statement, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id in {"backend_extras", "backend"} for target in statement.targets)
        ],
        type_ignores=[],
    )
    namespace: dict[str, Any] = {"filenames": [path]}
    exec(compile(selection, str(workflow_path), "exec"), namespace)
    assert namespace["backend"] is requires_lint


def test_executable_script_lint_is_required_in_ci_and_local_validation() -> None:
    workspace = Path(__file__).resolve().parents[2]
    workflow = yaml.safe_load((workspace / ".github/workflows/lint.yml").read_text())
    steps = workflow["jobs"]["lint-backend"]["steps"]
    executable_check = next(step for step in steps if step.get("name") == "Ruff executable-script check")
    assert executable_check["run"] == "python -m ruff check --select EXE . .github"
    assert not executable_check.get("continue-on-error", False)
    local_runner = (workspace / "scripts/test").read_text()
    assert 'run_check "Ruff executable-script checks passed" "Ruff executable-script checks failed"' in local_runner
    assert '"$BACKEND_PYTHON" -m ruff check --select EXE "$REPO_ROOT" "$REPO_ROOT/.github"' in local_runner


def test_gate_requires_selected_components_and_allows_intentional_skips() -> None:
    needs = {"changes": {"result": "success", "outputs": {component: "false" for component in COMPONENT_JOBS}}}
    needs.update({job: {"result": "skipped"} for job in COMPONENT_JOBS.values()})
    assert gate_errors(needs, "pull_request") == []
    needs["changes"]["outputs"]["frontend"] = "true"
    assert gate_errors(needs, "pull_request") == ["Required frontend job did not succeed: skipped"]
    needs["frontend"]["result"] = "success"
    assert gate_errors(needs, "pull_request") == []
    assert gate_errors(needs, "workflow_dispatch")


@pytest.mark.parametrize("name", ["test.yml", "lint.yml"])
def test_only_superseded_pr_checks_are_cancelled(name: str) -> None:
    source = Path(__file__).resolve().parents[2] / ".github/workflows" / name
    concurrency = yaml.safe_load(source.read_text())["concurrency"]
    assert "github.event.pull_request.number || github.run_id" in concurrency["group"]
    assert concurrency["cancel-in-progress"] == "${{ github.event_name == 'pull_request' }}"


@pytest.mark.parametrize("result", ["failure", "cancelled", "skipped", None])
def test_gate_rejects_failed_change_detection(result: str | None) -> None:
    assert gate_errors({"changes": {"result": result}}, "push")


def test_gate_rejects_missing_outputs_and_unselected_failures() -> None:
    assert gate_errors({"changes": {"result": "success"}}, "push")
    needs = {"changes": {"result": "success", "outputs": {component: "false" for component in COMPONENT_JOBS}}}
    needs.update({job: {"result": "cancelled"} for job in COMPONENT_JOBS.values()})
    assert len(gate_errors(needs, "push")) == len(COMPONENT_JOBS)


@pytest.mark.parametrize(
    "path",
    [
        ".github/scripts/cleanup_actions_caches.py",
        ".github/workflows/cleanup-actions-caches.yml",
        ".github/workflows/signal-closed-pr-cache-cleanup.yml",
    ],
)
def test_cache_cleanup_changes_schedule_backend_tests(path: str) -> None:
    assert classify_paths([path]) == {
        "backend": True,
        "frontend": False,
        "companion": False,
        "website": False,
    }


def _run_detector(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    event_name: str,
    event: dict[str, Any] | None = None,
    api_responses: list[object] | None = None,
) -> dict[str, str]:
    output_path = tmp_path / "github-output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output_path))
    monkeypatch.setenv("GITHUB_EVENT_NAME", event_name)
    monkeypatch.setenv("GITHUB_TOKEN", "test-token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "sambee/sambee")
    monkeypatch.setenv("GITHUB_SHA", "head-sha")
    if event is not None:
        event_path = tmp_path / "event.json"
        event_path.write_text(json.dumps(event), encoding="utf-8")
        monkeypatch.setenv("GITHUB_EVENT_PATH", str(event_path))
    responses = iter(api_responses or [])
    monkeypatch.setattr(ci_change_detector, "github_api_request", lambda _url, _headers: next(responses))

    assert ci_change_detector.main() == 0
    return dict(line.split("=", 1) for line in output_path.read_text(encoding="utf-8").splitlines())


def test_manual_dispatch_runs_all_components_and_checks_the_full_tree(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    assert _run_detector(monkeypatch, tmp_path, event_name="workflow_dispatch") == {
        "backend": "true",
        "frontend": "true",
        "companion": "true",
        "website": "true",
        "diff_base": FULL_TREE_DIFF_BASE,
    }


def test_push_uses_comparison_paths_and_before_sha(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    outputs = _run_detector(
        monkeypatch,
        tmp_path,
        event_name="push",
        event={"before": "base-sha"},
        api_responses=[{"files": [{"filename": "archive-contract/v2/fixtures/topology-execution-traces-v2.json"}]}],
    )

    assert outputs == {
        "backend": "true",
        "frontend": "false",
        "companion": "true",
        "website": "false",
        "diff_base": "base-sha",
    }


def test_zero_base_push_runs_all_components_and_checks_the_full_tree(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    outputs = _run_detector(monkeypatch, tmp_path, event_name="push", event={"before": "0" * 40})

    assert outputs == {
        "backend": "true",
        "frontend": "true",
        "companion": "true",
        "website": "true",
        "diff_base": FULL_TREE_DIFF_BASE,
    }


def test_pull_request_paginates_changed_paths_and_uses_the_base_sha(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    outputs = _run_detector(
        monkeypatch,
        tmp_path,
        event_name="pull_request",
        event={"pull_request": {"number": 42, "base": {"sha": "base-sha"}}},
        api_responses=[
            [{"filename": "frontend/src/App.tsx"}] * 100,
            [{"filename": "companion/src-tauri/src/server/archive_future.rs"}],
        ],
    )

    assert outputs == {
        "backend": "true",
        "frontend": "true",
        "companion": "true",
        "website": "false",
        "diff_base": "base-sha",
    }
