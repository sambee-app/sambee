"""Generate Hugo routing anchors for inherited and stable current docs routes."""

from __future__ import annotations

import tomllib
from pathlib import Path

WEBSITE_DIR = Path(__file__).resolve().parent.parent
DOCS_CONTENT_DIR = WEBSITE_DIR / "content" / "docs"
GENERATED_CONTENT_DIR = WEBSITE_DIR / ".generated" / "content" / "docs"
DOCS_VERSIONS_FILE = WEBSITE_DIR / "data" / "docs-versions.toml"

BRANCH_MARKER = "_inherit.md"
BRANCH_ANCHOR = "_index.md"
PAGE_MARKER = "inherit.md"
PAGE_ANCHOR = "index.md"
BRANCH_SOURCE = "_index.md"
PAGE_SOURCE = "index.md"

ANCHOR_CONTENT = """+++
title = "Inherited Documentation"
inherit = true
+++
"""

CURRENT_ROUTE_ANCHOR_TEMPLATE = """+++
title = "Current Documentation"
current_route = true
source_docs_path = "{source_docs_path}"
+++
"""


def load_current_version() -> str:
    """Return the current docs version slug declared in docs metadata."""
    with DOCS_VERSIONS_FILE.open("rb") as file:
        data = tomllib.load(file)

    current_version = data.get("current", "")
    return current_version if isinstance(current_version, str) else ""


def add_inherited_anchor(
    anchors: dict[Path, str], source_marker: Path, anchor_name: str
) -> None:
    """Record a generated Hugo page anchor for one inheritance marker."""
    relative_parent = source_marker.parent.relative_to(DOCS_CONTENT_DIR)
    anchors[relative_parent / anchor_name] = ANCHOR_CONTENT


def add_current_route_anchor(
    anchors: dict[Path, str],
    source_directory: Path,
    anchor_name: str,
    current_version: str,
) -> None:
    """Record a stable current-docs route anchor for one current-version page."""
    version_root = DOCS_CONTENT_DIR / current_version
    relative_parent = source_directory.relative_to(version_root)
    if not relative_parent.parts:
        return

    source_docs_path = "/docs/" + "/".join((current_version, *relative_parent.parts))
    anchors[relative_parent / anchor_name] = CURRENT_ROUTE_ANCHOR_TEMPLATE.format(
        source_docs_path=source_docs_path
    )


def collect_inherited_anchors() -> dict[Path, str]:
    """Return the generated anchor files needed for inherited docs routes."""
    anchors: dict[Path, str] = {}

    for marker in sorted(DOCS_CONTENT_DIR.rglob(BRANCH_MARKER)):
        add_inherited_anchor(anchors, marker, BRANCH_ANCHOR)

    for marker in sorted(DOCS_CONTENT_DIR.rglob(PAGE_MARKER)):
        add_inherited_anchor(anchors, marker, PAGE_ANCHOR)

    return anchors


def collect_current_route_anchors(current_version: str) -> dict[Path, str]:
    """Return the generated anchor files needed for stable current-docs routes."""
    anchors: dict[Path, str] = {}
    if not current_version:
        return anchors

    current_version_dir = DOCS_CONTENT_DIR / current_version
    if not current_version_dir.exists():
        return anchors

    for directory in sorted(
        path for path in current_version_dir.rglob("*") if path.is_dir()
    ):
        if (directory / BRANCH_SOURCE).exists() or (directory / BRANCH_MARKER).exists():
            add_current_route_anchor(anchors, directory, BRANCH_ANCHOR, current_version)
            continue

        if (directory / PAGE_SOURCE).exists() or (directory / PAGE_MARKER).exists():
            add_current_route_anchor(anchors, directory, PAGE_ANCHOR, current_version)

    return anchors


def collect_existing_anchors() -> dict[Path, str]:
    """Return generated anchor files currently on disk."""
    if not GENERATED_CONTENT_DIR.exists():
        return {}

    return {
        anchor_path.relative_to(GENERATED_CONTENT_DIR): anchor_path.read_text(
            encoding="utf-8"
        )
        for anchor_path in GENERATED_CONTENT_DIR.rglob("*.md")
    }


def remove_empty_generated_directories() -> None:
    """Remove empty directories left behind by obsolete generated anchors."""
    if not GENERATED_CONTENT_DIR.exists():
        return

    for directory in sorted(
        (path for path in GENERATED_CONTENT_DIR.rglob("*") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    ):
        try:
            directory.rmdir()
        except OSError:
            continue


def reconcile_anchors(desired_anchors: dict[Path, str]) -> tuple[int, int, int]:
    """Apply only generated-anchor changes required to match desired content."""
    existing_anchors = collect_existing_anchors()
    deleted_paths = sorted(existing_anchors.keys() - desired_anchors.keys())
    written_paths = sorted(
        path
        for path, content in desired_anchors.items()
        if existing_anchors.get(path) != content
    )

    for relative_path in deleted_paths:
        (GENERATED_CONTENT_DIR / relative_path).unlink()

    for relative_path in written_paths:
        anchor_path = GENERATED_CONTENT_DIR / relative_path
        anchor_path.parent.mkdir(parents=True, exist_ok=True)
        anchor_path.write_text(desired_anchors[relative_path], encoding="utf-8")

    remove_empty_generated_directories()
    return len(written_paths), len(deleted_paths), len(desired_anchors)


def main() -> int:
    """Generate inherited docs anchors for the Hugo build."""
    if not DOCS_CONTENT_DIR.exists():
        print(
            f"Docs content directory not found at {DOCS_CONTENT_DIR}; no anchors generated."
        )
        return 0

    current_version = load_current_version()
    inherited_anchors = collect_inherited_anchors()
    current_route_anchors = collect_current_route_anchors(current_version)
    desired_anchors = inherited_anchors | current_route_anchors
    written_count, deleted_count, desired_count = reconcile_anchors(desired_anchors)
    print(
        "Reconciled "
        f"{desired_count} docs route anchor(s): {written_count} written, "
        f"{deleted_count} deleted."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
