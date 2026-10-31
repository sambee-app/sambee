"""Tests for the standalone docs structure report generator."""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WEBSITE_DIR = Path(__file__).resolve().parent.parent
DOCS_EDITOR_PACKAGE_DIR = WEBSITE_DIR / "scripts" / "docs_editor"
DOCS_EDITOR_PATH = DOCS_EDITOR_PACKAGE_DIR / "__init__.py"
DOCS_REPORT_MODULE_PATH = DOCS_EDITOR_PACKAGE_DIR / "report.py"


def load_package_module(name: str, path: Path):
    """Load one package-backed module from the workspace."""
    spec = importlib.util.spec_from_file_location(
        name,
        path,
        submodule_search_locations=[str(DOCS_EDITOR_PACKAGE_DIR)]
        if path.name == "__init__.py"
        else None,
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


DOCS_EDITOR = load_package_module("docs_editor", DOCS_EDITOR_PATH)
DOCS_REPORT = load_package_module("docs_editor.report", DOCS_REPORT_MODULE_PATH)


class DocsReportTests(unittest.TestCase):
    """Validate the standalone docs structure report behavior."""

    def build_temp_website(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        """Create a temporary copy of the website docs inputs for report tests."""
        tempdir = tempfile.TemporaryDirectory()
        root = Path(tempdir.name)
        shutil.copytree(WEBSITE_DIR / "content" / "docs", root / "content" / "docs")
        shutil.copytree(WEBSITE_DIR / "data" / "docs-nav", root / "data" / "docs-nav")
        (root / "scripts").mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            WEBSITE_DIR / "data" / "docs-versions.toml",
            root / "data" / "docs-versions.toml",
        )
        shutil.copy2(
            WEBSITE_DIR / "scripts" / "validate-docs-content.py",
            root / "scripts" / "validate-docs-content.py",
        )
        shutil.copytree(
            WEBSITE_DIR / "scripts" / "docs_editor",
            root / "scripts" / "docs_editor",
        )
        shutil.copy2(
            WEBSITE_DIR / "scripts" / "docs-report.py",
            root / "scripts" / "docs-report.py",
        )
        return tempdir, root

    def current_version(self, root: Path) -> str:
        """Return the metadata-declared current docs version for one fixture."""
        return DOCS_EDITOR.DocsEditor(root).load_versions_document().current

    def promote_inherited_page_to_branched(
        self, root: Path
    ) -> tuple[str, str, str, str, str]:
        """Turn one inherited current-version page into real content with a diff."""
        editor = DOCS_EDITOR.DocsEditor(root)
        current_version = editor.load_versions_document().current
        version_root = root / "content" / "docs" / current_version
        for marker in sorted(version_root.rglob("inherit.md")):
            relative = marker.relative_to(version_root)
            if len(relative.parts) != 4:
                continue
            book, section, page, _ = relative.parts
            page_dir = marker.parent
            source_version = DOCS_REPORT.resolve_page_source_version(
                editor,
                current_version,
                (book, section, page),
                include_current=True,
            )
            if source_version is None:
                continue
            source_path = editor.resolve_page_source_file(
                current_version, (book, section, page)
            )
            marker.unlink()
            source_text = source_path.read_text(encoding="utf-8")
            page_dir.joinpath("index.md").write_text(
                source_text.rstrip()
                + "\n\nStandalone report branch test line.\nSecond branch-only line.\n",
                encoding="utf-8",
            )
            return book, section, page, current_version, source_version
        raise AssertionError(
            "expected at least one inherited current-version page fixture"
        )

    def test_build_report_data_marks_branched_page_and_diff_counts(self) -> None:
        """Branched page versions should be labeled and diffed against predecessors."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        book, section, page, current_version, source_version = (
            self.promote_inherited_page_to_branched(root)
        )

        report_data = DOCS_REPORT.build_report_data(root)
        self.assertEqual(report_data["meta"]["current_version"], current_version)

        row = next(
            item
            for item in report_data["rows"]
            if item.get("kind") == "page"
            and item.get("path") == f"{book}/{section}/{page}"
        )
        page_cell = row["version_cells"][current_version]
        self.assertEqual(page_cell["state"], "branched")
        self.assertEqual(page_cell["source_version"], source_version)
        self.assertGreaterEqual(page_cell["diff_added"], 2)
        self.assertEqual(page_cell["diff_removed"], 0)
        self.assertNotIn("summary", report_data)

    def test_build_report_data_marks_inherited_book_content(self) -> None:
        """Book rows should carry inherited predecessor state when no local landing content remains."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = DOCS_EDITOR.DocsEditor(root)
        current_version = self.current_version(root)
        book_dir = editor.book_root(current_version, "user-guide")
        book_dir.joinpath("_index.md").unlink(missing_ok=True)
        book_dir.joinpath("_inherit.md").write_text("", encoding="utf-8")
        source_version = DOCS_REPORT.resolve_branch_source_version(
            editor,
            current_version,
            ("user-guide",),
            include_current=True,
        )
        if source_version is None:
            self.fail("expected user-guide to resolve to a content source")

        report_data = DOCS_REPORT.build_report_data(root)

        row = next(
            item
            for item in report_data["rows"]
            if item.get("kind") == "book" and item.get("path") == "user-guide"
        )
        book_cell = row["version_cells"][current_version]
        self.assertEqual(book_cell["state"], "inherited")
        self.assertEqual(book_cell["source_version"], source_version)
        self.assertIn(source_version, row["content_versions"])
        self.assertIn(current_version, row["content_versions"])

    def test_build_report_data_marks_structural_book(self) -> None:
        """Structural books should use the common structural-only report state."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = DOCS_EDITOR.DocsEditor(root)
        current_version = self.current_version(root)
        editor.apply_plan(
            editor.plan_book_create(
                current_version,
                book="structural-book",
                title=None,
                position="end",
                inherit=False,
                structural_only=True,
            )
        )

        report_data = DOCS_REPORT.build_report_data(root)
        row = next(
            item
            for item in report_data["rows"]
            if item.get("kind") == "book" and item.get("path") == "structural-book"
        )
        self.assertEqual(
            row["version_cells"][current_version]["state"], "structural-only"
        )
        self.assertTrue(row["flags"]["has_structural"])

    def test_render_report_html_embeds_json_not_html_entities(self) -> None:
        """Embedded report JSON should remain valid JSON in the HTML payload script tag."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        report_data = DOCS_REPORT.build_report_data(root)
        html_text = DOCS_REPORT.render_report_html(report_data)

        self.assertIn(
            '<script id="report-data" type="application/json">{"meta":', html_text
        )
        self.assertNotIn("&quot;meta&quot;", html_text)
        self.assertIn('id="diff-modal"', html_text)
        self.assertNotIn("Branch diff", html_text)
        self.assertIn(
            "grid-template-rows: auto auto minmax(0, 1fr)",
            html_text,
        )
        self.assertIn('class="diff-meta__versions"', html_text)
        self.assertIn('class="diff-line__code">No diff available.</div>', html_text)
        self.assertIn("function tokenizeInlineText", html_text)
        self.assertIn('class="brand-wordmark">Sambee Docs Report</p>', html_text)
        self.assertNotIn("Documentation structure", html_text)
        self.assertIn('class="brand-mark"', html_text)
        self.assertIn('Segoe UI", "Helvetica Neue", Arial, sans-serif', html_text)
        self.assertIn('Georgia, "Times New Roman", serif', html_text)
        self.assertNotIn('id="summary-cards"', html_text)
        self.assertIn('id="warnings-panel" hidden', html_text)
        self.assertIn("Validator issues", html_text)
        self.assertNotIn("Validator warnings", html_text)
        self.assertIn(
            "background: linear-gradient(90deg, #f6efe5 0 88px, #e6dac8 88px 89px, #fffdf9 89px 100%)",
            html_text,
        )
        self.assertIn("showDiffCount: true", html_text)
        self.assertNotIn('"summary":', html_text)
        self.assertNotIn("branched_page_versions", html_text)
        self.assertNotIn("branched_content_versions", html_text)
        self.assertIn("row.has_children", html_text)
        self.assertIn("onlyChanges: true", html_text)
        self.assertIn("Only show changes", html_text)
        self.assertIn("diff-modal-pill", html_text)
        self.assertIn("diff-modal__toolbar", html_text)
        self.assertIn("Content diff", html_text)
        self.assertIn("View Controls", html_text)
        self.assertIn("Signals to surface", html_text)
        self.assertIn("Only branched", html_text)
        self.assertNotIn("Only branched pages", html_text)
        self.assertIn(
            "state.toggles.onlyBranched && !row.flags.has_branched", html_text
        )
        self.assertIn("onlyStructuralNodes", html_text)
        self.assertIn("Only structural-only nodes", html_text)
        self.assertNotIn("onlyStructuralSections", html_text)
        self.assertIn("Expanded version chips", html_text)
        self.assertIn("Expand all", html_text)
        self.assertIn("version-chip--placeholder", html_text)
        self.assertIn("function hasExclusiveRowFilter()", html_text)
        self.assertNotIn('id="version-legend"', html_text)

    def test_cli_generates_report_and_check_detects_staleness(self) -> None:
        """The wrapper script should generate the report and fail check mode when stale."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        output_path = (
            root / "website-meta" / "docs-reports" / "docs-structure-report.html"
        )
        generate = subprocess.run(
            [
                sys.executable,
                str(root / "scripts" / "docs-report.py"),
                "--website-dir",
                str(root),
                "--output",
                str(output_path),
            ],
            cwd=root,
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(generate.returncode, 0, msg=generate.stderr)
        self.assertTrue(output_path.exists())
        self.assertIn("Docs Structure Report", output_path.read_text(encoding="utf-8"))

        check_ok = subprocess.run(
            [
                sys.executable,
                str(root / "scripts" / "docs-report.py"),
                "--website-dir",
                str(root),
                "--output",
                str(output_path),
                "--check",
            ],
            cwd=root,
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(check_ok.returncode, 0, msg=check_ok.stderr)

        self.promote_inherited_page_to_branched(root)

        check_stale = subprocess.run(
            [
                sys.executable,
                str(root / "scripts" / "docs-report.py"),
                "--website-dir",
                str(root),
                "--output",
                str(output_path),
                "--check",
            ],
            cwd=root,
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(check_stale.returncode, 1)
        self.assertIn("stale", check_stale.stdout.lower())


if __name__ == "__main__":
    unittest.main()
