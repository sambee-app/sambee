"""Refresh committed docs-derived artifacts when relevant docs inputs change."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DOCS_REPORT_SCRIPT = REPO_ROOT / "website" / "scripts" / "docs-report.py"
DOCS_REPORT_OUTPUT = (
    REPO_ROOT / "website-meta" / "docs-reports" / "docs-structure-report.html"
)

RELEVANT_PREFIXES = (
    "website/content/docs/",
    "website/data/docs-nav/",
    "website/scripts/docs_editor/",
)

RELEVANT_FILES = {
    "website/data/docs-versions.toml",
    "website/scripts/docs-report.py",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Refresh committed docs-derived artifacts when relevant docs inputs change."
    )
    parser.add_argument(
        "--staged-only",
        action="store_true",
        help="only run when staged changes include docs-report inputs",
    )
    parser.add_argument(
        "--stage-output",
        action="store_true",
        help="stage generated outputs after a successful refresh",
    )
    return parser.parse_args()


def git_lines(*args: str) -> list[str]:
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def is_relevant_path(path: str) -> bool:
    return path in RELEVANT_FILES or path.startswith(RELEVANT_PREFIXES)


def relevant_paths(paths: list[str]) -> list[str]:
    return [path for path in paths if is_relevant_path(path)]


def ensure_no_unstaged_relevant_changes() -> None:
    unstaged = relevant_paths(git_lines("diff", "--name-only"))
    if not unstaged:
        return

    joined = "\n".join(f"- {path}" for path in unstaged)
    raise SystemExit(
        "Refusing to refresh docs-derived artifacts with unstaged docs changes. "
        "Stage or stash these files first:\n"
        f"{joined}"
    )


def run_docs_report() -> None:
    subprocess.run(
        [sys.executable, str(DOCS_REPORT_SCRIPT)],
        cwd=REPO_ROOT,
        check=True,
    )


def stage_output() -> None:
    subprocess.run(
        ["git", "add", str(DOCS_REPORT_OUTPUT.relative_to(REPO_ROOT))],
        cwd=REPO_ROOT,
        check=True,
    )


def main() -> int:
    args = parse_args()

    if args.staged_only:
        staged = relevant_paths(
            git_lines("diff", "--cached", "--name-only", "--diff-filter=ACMR")
        )
        if not staged:
            print(
                "No staged docs-report inputs detected; skipping docs-derived artifact refresh."
            )
            return 0

        ensure_no_unstaged_relevant_changes()

    run_docs_report()

    if args.stage_output:
        stage_output()
        print(
            "Staged refreshed docs-derived artifact: "
            f"{DOCS_REPORT_OUTPUT.relative_to(REPO_ROOT)}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
