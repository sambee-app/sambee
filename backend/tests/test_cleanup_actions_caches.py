"""Regression tests for the Actions cache retention policy."""

import json
import sys
from pathlib import Path
from urllib.error import HTTPError

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / ".github" / "scripts"))

import cleanup_actions_caches as cleanup


def cache(cache_id: int, ref: str, key: str, created_at: str = "2026-10-03T00:00:00Z") -> dict:
    return {"id": cache_id, "ref": ref, "key": key, "created_at": created_at, "size_in_bytes": 100}


RUST_OLD = "v0-rust-companion-Linux-x64-c7b3ef7d-fa4e0e5f"
RUST_NEW = "v0-rust-companion-Linux-x64-c7b3ef7d-cd520792"
LINT = "v0-rust-lint-companion-Linux-x64-c7b3ef7d-cd520792"


def test_rust_toolchain_changes_supersede_old_main_cache() -> None:
    older_toolchain = cache(1, cleanup.MAIN_REF, RUST_OLD)
    newer_toolchain = cache(
        2,
        cleanup.MAIN_REF,
        "v0-rust-companion-Linux-x64-12345678-cd520792",
        "2026-10-03T01:00:00Z",
    )

    decisions = cleanup.classify_caches([older_toolchain, newer_toolchain], set(), set())

    assert [entry["reason"] for entry in decisions] == [
        "delete: superseded cache",
        "protected: current cache",
    ]


def test_retains_latest_per_ref_and_family_but_removes_closed_pr() -> None:
    caches = [
        cache(1, cleanup.MAIN_REF, RUST_OLD),
        cache(2, cleanup.MAIN_REF, RUST_NEW, "2026-10-03T01:00:00Z"),
        cache(3, cleanup.MAIN_REF, LINT),
        cache(4, "refs/pull/42/merge", RUST_NEW),
        cache(5, "refs/pull/43/merge", RUST_NEW),
        cache(6, "refs/pull/43/merge", "buildkit-blob-1-sha256:abc"),
        cache(7, cleanup.MAIN_REF, "buildkit-blob-1-sha256:abc"),
    ]
    reasons = {entry["id"]: entry["reason"] for entry in cleanup.classify_caches(caches, {42}, set())}

    assert reasons == {
        1: "delete: superseded cache",
        2: "protected: current cache",
        3: "protected: current cache",
        4: "protected: current cache",
        5: "delete: closed pull request",
        6: "delete: closed pull request",
        7: "protected: unclassified",
    }


def test_in_progress_and_unidentified_pr_runs_protect_caches() -> None:
    caches = [cache(1, cleanup.MAIN_REF, RUST_OLD), cache(2, cleanup.MAIN_REF, RUST_NEW), cache(3, "refs/pull/42/merge", RUST_OLD)]
    reasons = {entry["id"]: entry["reason"] for entry in cleanup.classify_caches(caches, set(), {cleanup.MAIN_REF}, protect_all_prs=True)}
    assert reasons[1] == "protected: build in progress"
    assert reasons[3] == "protected: unidentified pull request build"


def test_paginates_all_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    urls = []

    def response(path: str, _token: str) -> dict:
        urls.append(path)
        return {"actions_caches": [{}] * (100 if len(urls) == 1 else 1)}

    monkeypatch.setattr(cleanup, "api_request", response)
    assert len(cleanup.list_pages("/repos/example/project/actions/caches", "actions_caches", "token")) == 101
    assert urls[-1].endswith("page=2")


def test_unrecognized_api_response_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cleanup, "api_request", lambda *_args: {"actions_caches": None})
    with pytest.raises(RuntimeError, match="Unexpected GitHub API response"):
        cleanup.list_pages("/repos/example/project/actions/caches", "actions_caches", "token")


def test_unknown_pull_request_state_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cleanup, "api_request", lambda *_args: {"state": "unknown"})
    with pytest.raises(RuntimeError, match="Cannot determine state"):
        cleanup.open_pull_requests("example/project", [cache(1, "refs/pull/43/merge", RUST_OLD)], "token")


def test_active_runs_protect_their_refs(monkeypatch: pytest.MonkeyPatch) -> None:
    runs = [
        {"id": 1, "name": "CI: Test", "event": "pull_request", "pull_requests": [{"number": 42}], "head_branch": "feature"},
        {"id": 2, "name": "CI: Lint", "event": "push", "pull_requests": [], "head_branch": "main"},
        {"id": 3, "name": "CI: Test", "event": "pull_request", "pull_requests": [], "head_branch": "feature"},
    ]
    monkeypatch.setattr(cleanup, "list_pages", lambda path, *_args: runs if "status=in_progress" in path else [])
    refs, unknown_pr = cleanup.active_build_refs("example/project", "token", 999)
    assert refs == {cleanup.MAIN_REF, "refs/pull/42/merge"}
    assert unknown_pr


@pytest.mark.parametrize("apply", [False, True])
@pytest.mark.parametrize("missing_cache", [False, True])
def test_dry_run_and_apply_delete_only_eligible_ids(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path, apply: bool, missing_cache: bool
) -> None:
    entries = [
        cache(1, cleanup.MAIN_REF, RUST_OLD),
        cache(2, cleanup.MAIN_REF, RUST_NEW, "2026-10-03T01:00:00Z"),
        cache(3, "refs/pull/43/merge", "buildkit-blob-1-sha256:abc"),
    ]
    calls = []

    def request(path: str, _token: str, method: str = "GET") -> object:
        calls.append((method, path))
        if missing_cache and method == "DELETE" and path.endswith("/caches/1"):
            raise HTTPError(path, 404, "Not Found", None, None)
        if path.endswith("/pulls/43"):
            return {"state": "closed"}
        return None

    monkeypatch.setattr(cleanup, "api_request", request)
    monkeypatch.setattr(cleanup, "list_pages", lambda *_args: entries)
    monkeypatch.setattr(cleanup, "active_build_refs", lambda *_args: (set(), False))
    monkeypatch.setenv("GITHUB_TOKEN", "test-token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "example/project")
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    summary_path = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary_path))
    monkeypatch.setattr(sys, "argv", ["cleanup_actions_caches.py", *(["--apply"] if apply else [])])

    assert cleanup.main() == 0
    assert [path for method, path in calls if method == "DELETE"] == (
        ["/repos/example/project/actions/caches/1", "/repos/example/project/actions/caches/3"] if apply else []
    )
    output = capsys.readouterr().out.splitlines()
    assert json.loads(output[1])["reason"] == "protected: current cache"
    expected_deleted_bytes = (100 if missing_cache else 200) if apply else 0
    assert f"{expected_deleted_bytes} bytes deleted" in output[-1]
    if apply and missing_cache:
        assert json.loads(output[0])["reason"] == "absent: cache already removed"
        assert "100 bytes already absent" in output[-1]
        assert "200 bytes eligible" in output[-1]
        summary = summary_path.read_text()
        assert "absent: cache already removed" in summary
        assert "delete: superseded cache" not in summary


@pytest.mark.parametrize("status", [401, 403, 429, 500])
def test_cache_deletion_errors_other_than_not_found_still_fail(monkeypatch: pytest.MonkeyPatch, status: int) -> None:
    error = HTTPError("https://api.github.com/repos/example/project/actions/caches/1", status, "Failure", None, None)

    def request(*_args: object, **_kwargs: object) -> object:
        raise error

    monkeypatch.setattr(cleanup, "api_request", request)
    monkeypatch.setattr(cleanup, "list_pages", lambda *_args: [cache(1, cleanup.MAIN_REF, RUST_OLD), cache(2, cleanup.MAIN_REF, RUST_NEW)])
    monkeypatch.setattr(cleanup, "active_build_refs", lambda *_args: (set(), False))
    monkeypatch.setenv("GITHUB_TOKEN", "test-token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "example/project")
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.setattr(sys, "argv", ["cleanup_actions_caches.py", "--apply"])

    with pytest.raises(HTTPError) as raised:
        cleanup.main()
    assert raised.value is error


def test_api_reads_do_not_ignore_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    error = HTTPError("https://api.github.com/repos/example/project/pulls/43", 404, "Not Found", None, None)

    def open_url(_request: object) -> object:
        raise error

    monkeypatch.setattr(cleanup.urllib.request, "urlopen", open_url)
    try:
        with pytest.raises(HTTPError) as raised:
            cleanup.api_request("/repos/example/project/pulls/43", "test-token")
        assert raised.value is error
    finally:
        error.close()


@pytest.mark.parametrize(
    ("remaining_bytes", "expected_message"),
    [
        (cleanup.WARN_BYTES - 1, None),
        (cleanup.WARN_BYTES, "Warning: active caches still exceed 8 GiB"),
        (cleanup.CRITICAL_BYTES, "Critical: active caches still exceed 9 GiB"),
    ],
)
@pytest.mark.parametrize("missing_cache", [False, True])
def test_storage_thresholds_emit_annotations(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    remaining_bytes: int,
    expected_message: str | None,
    missing_cache: bool,
) -> None:
    entry = cache(1, cleanup.MAIN_REF, RUST_NEW)
    entry["size_in_bytes"] = remaining_bytes
    entries = [entry]
    if missing_cache:
        entries.append(cache(0, cleanup.MAIN_REF, RUST_OLD))

    def request(*_args: object, **_kwargs: object) -> object:
        raise HTTPError("https://api.github.com/repos/example/project/actions/caches/0", 404, "Not Found", None, None)

    monkeypatch.setattr(cleanup, "api_request", request)
    monkeypatch.setattr(cleanup, "list_pages", lambda *_args: entries)
    monkeypatch.setattr(cleanup, "active_build_refs", lambda *_args: (set(), False))
    monkeypatch.setenv("GITHUB_TOKEN", "test-token")
    monkeypatch.setenv("GITHUB_REPOSITORY", "example/project")
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    monkeypatch.setattr(sys, "argv", ["cleanup_actions_caches.py", *(["--apply"] if missing_cache else [])])

    assert cleanup.main() == 0
    annotations = [line for line in capsys.readouterr().out.splitlines() if line.startswith("::warning")]
    if expected_message is None:
        assert not annotations
    else:
        assert len(annotations) == 1
        assert expected_message in annotations[0]
