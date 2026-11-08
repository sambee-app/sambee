"""Integration tests for docs editor operations and fixture scenarios."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path
from typing import Any

WEBSITE_DIR = Path(__file__).resolve().parent.parent
DOCS_EDITOR_PACKAGE_DIR = WEBSITE_DIR / "scripts" / "docs_editor"
DOCS_EDITOR_PATH = DOCS_EDITOR_PACKAGE_DIR / "__init__.py"


def load_docs_editor_module():
    """Load the docs editor module from the workspace."""
    spec = importlib.util.spec_from_file_location(
        "docs_editor",
        DOCS_EDITOR_PATH,
        submodule_search_locations=[str(DOCS_EDITOR_PACKAGE_DIR)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load docs_editor package")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


DOCS_EDITOR = load_docs_editor_module()


class DocsEditorTestCase(unittest.TestCase):
    """Shared helpers for docs editor integration tests."""

    def docs_content_path(self, root: Path, version: str, *relative_parts: str) -> Path:
        """Build a path under content/docs for concise test assertions."""
        return root / "content" / "docs" / version / Path(*relative_parts)

    def assert_paths_exist(self, *paths: Path) -> None:
        """Assert that each provided filesystem path exists."""
        for path in paths:
            self.assertTrue(path.exists(), msg=f"expected path to exist: {path}")

    def assert_paths_missing(self, *paths: Path) -> None:
        """Assert that each provided filesystem path does not exist."""
        for path in paths:
            self.assertFalse(path.exists(), msg=f"expected path to be absent: {path}")

    def build_temp_website(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        """Create a deterministic docs-editor fixture independent of live docs."""
        tempdir = tempfile.TemporaryDirectory()
        root = Path(tempdir.name)

        docs_root = root / "content" / "docs"
        nav_root = root / "data" / "docs-nav"
        docs_root.mkdir(parents=True)
        nav_root.mkdir(parents=True)
        (docs_root / "_index.md").write_text(
            '+++\ntitle = "Documentation"\n+++\n', encoding="utf-8"
        )
        (root / "data" / "docs-versions.toml").write_text(
            """current = "1.0"

[[versions]]
slug = "0.9"
label = "0.9"
visible = true
searchable = false

[[versions]]
slug = "1.0"
label = "1.0"
visible = true
searchable = false

[[versions]]
slug = "1.1"
label = "1.1"
visible = true
searchable = false

[[versions]]
slug = "2.0"
label = "2.0"
visible = true
searchable = false
""",
            encoding="utf-8",
        )

        for version in ("0.9", "1.0", "2.0"):
            version_dir = docs_root / version
            version_dir.mkdir()
            (version_dir / "_index.md").write_text(
                f'+++\ntitle = "{version}"\n+++\n', encoding="utf-8"
            )

        website_dev_nav = """books = [
  "website-dev-guide",
]

[[sections.website-dev-guide.items]]
slug = "docs-platform"
title = "Docs Platform"

[pages.website-dev-guide.docs-platform]
items = [
  "website-and-docs-architecture-overview",
]
"""
        (nav_root / "0.9.toml").write_text(website_dev_nav, encoding="utf-8")
        (nav_root / "1.0.toml").write_text(website_dev_nav, encoding="utf-8")
        (nav_root / "2.0.toml").write_text("books = [\n]\n", encoding="utf-8")

        authored_page_dir = (
            docs_root
            / "0.9"
            / "website-dev-guide"
            / "docs-platform"
            / "website-and-docs-architecture-overview"
        )
        authored_page_dir.mkdir(parents=True)
        (docs_root / "0.9" / "website-dev-guide" / "_index.md").write_text(
            '+++\ntitle = "Website Dev Guide"\n+++\n', encoding="utf-8"
        )
        (authored_page_dir / "index.md").write_text(
            '+++\ntitle = "Website and Docs Architecture Overview"\n+++\n',
            encoding="utf-8",
        )
        inherited_page_dir = (
            docs_root
            / "1.0"
            / "website-dev-guide"
            / "docs-platform"
            / "website-and-docs-architecture-overview"
        )
        inherited_page_dir.mkdir(parents=True)
        (docs_root / "1.0" / "website-dev-guide" / "_inherit.md").write_text(
            "", encoding="utf-8"
        )
        (inherited_page_dir / "inherit.md").write_text("", encoding="utf-8")

        version_dir = docs_root / "1.1"
        version_dir.mkdir()
        (version_dir / "_inherit.md").write_text("", encoding="utf-8")
        (nav_root / "1.1.toml").write_text(
            """books = [
  "end-user",
  "admin",
  "developer",
]

[[sections.end-user.items]]
slug = "getting-started"
title = "Getting Started"

[pages.end-user.getting-started]
items = [
  "install",
]

[[sections.admin.items]]
slug = "configuration"
title = "Configuration"
""",
            encoding="utf-8",
        )
        for book, title in (
            ("end-user", "End User"),
            ("admin", "Admin"),
            ("developer", "Developer"),
        ):
            book_dir = version_dir / book
            book_dir.mkdir()
            (book_dir / "_index.md").write_text(
                f'+++\ntitle = "{title}"\n+++\n', encoding="utf-8"
            )

        install_dir = version_dir / "end-user" / "getting-started" / "install"
        install_dir.mkdir(parents=True)
        (install_dir / "index.md").write_text(
            '+++\ntitle = "Install"\n+++\n', encoding="utf-8"
        )
        (version_dir / "admin" / "configuration").mkdir()
        (version_dir / "admin" / "configuration" / "_index.md").write_text(
            '+++\ntitle = "Configuration"\n+++\n', encoding="utf-8"
        )

        (root / "scripts").mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            WEBSITE_DIR / "scripts" / "validate-docs-content.py",
            root / "scripts" / "validate-docs-content.py",
        )
        shutil.copytree(
            WEBSITE_DIR / "scripts" / "docs_editor",
            root / "scripts" / "docs_editor",
        )
        shutil.copy2(
            WEBSITE_DIR / "scripts" / "docs-editor.py",
            root / "scripts" / "docs-editor.py",
        )

        return tempdir, root

    def make_empty_docs_workspace(self, root: Path) -> None:
        """Rewrite one temporary website into a valid scratch docs workspace."""
        docs_root = root / "content" / "docs"
        for child in list(docs_root.iterdir()):
            if child.name == "_index.md":
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()

        nav_dir = root / "data" / "docs-nav"
        for child in list(nav_dir.iterdir()):
            if child.name == "README.toml":
                continue
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()

        (root / "data" / "docs-versions.toml").write_text(
            "# Canonical docs version metadata used by Hugo templates for labels, switchers,\n",
            encoding="utf-8",
        )

    def make_editor(self, root: Path):
        """Create a docs editor bound to one temporary website root."""
        return DOCS_EDITOR.DocsEditor(root)

    def run_cli(self, root: Path, *args: str) -> subprocess.CompletedProcess[str]:
        """Run the docs editor wrapper script inside one temporary website root."""
        return subprocess.run(
            [sys.executable, str(root / "scripts" / "docs-editor.py"), *args],
            cwd=root,
            check=False,
            text=True,
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=30,
        )

    def load_versions_data(self, root: Path) -> dict[str, Any]:
        """Load docs version metadata from one temporary website root."""
        return tomllib.loads(
            (root / "data" / "docs-versions.toml").read_text(encoding="utf-8")
        )

    def load_nav_data(self, root: Path, version: str) -> dict[str, Any]:
        """Load docs navigation metadata for one version from a temporary website root."""
        return tomllib.loads(
            (root / "data" / "docs-nav" / f"{version}.toml").read_text(encoding="utf-8")
        )

    def nav_book_slugs(self, root: Path, version: str) -> list[str]:
        """Return the ordered book slugs for one docs version."""
        return list(self.load_nav_data(root, version)["books"])

    def nav_section_slugs(self, root: Path, version: str, book: str) -> list[str]:
        """Return the ordered section slugs for one docs book."""
        nav = self.load_nav_data(root, version)
        return [
            entry["slug"]
            for entry in nav.get("sections", {}).get(book, {}).get("items", [])
        ]

    def nav_page_slugs(
        self, root: Path, version: str, book: str, section: str
    ) -> list[str]:
        """Return the ordered page slugs for one docs section."""
        nav = self.load_nav_data(root, version)
        return list(
            nav.get("pages", {}).get(book, {}).get(section, {}).get("items", [])
        )

    def assert_versions_state(
        self,
        root: Path,
        *,
        current: str | None = None,
        slugs: list[str] | None = None,
    ) -> dict[str, Any]:
        """Assert selected docs version metadata fields and return the parsed document."""
        versions_data = self.load_versions_data(root)
        if current is not None:
            self.assertEqual(versions_data["current"], current)
        if slugs is not None:
            self.assertEqual(
                [entry["slug"] for entry in versions_data["versions"]],
                slugs,
            )
        return versions_data

    def write_versions_document(self, root: Path, document: Any) -> None:
        """Persist one versions document into the temporary website root."""
        editor = self.make_editor(root)
        (root / "data" / "docs-versions.toml").write_text(
            editor.render_versions_document(document),
            encoding="utf-8",
        )

    def rewrite_versions_document(
        self,
        root: Path,
        *,
        current: str | None = None,
        include_slugs: list[str] | None = None,
    ) -> None:
        """Rewrite docs version metadata with a new current slug and/or filtered version list."""
        editor = self.make_editor(root)
        document = editor.load_versions_document()
        versions = list(document.versions)
        if include_slugs is not None:
            versions = [entry for entry in versions if entry.slug in include_slugs]
        updated_document = DOCS_EDITOR.VersionsDocument(
            preamble=document.preamble,
            current=current or document.current,
            versions=versions,
        )
        self.write_versions_document(root, updated_document)

    def assert_cli_refusal(
        self,
        result: subprocess.CompletedProcess[str],
        *,
        returncode: int,
        stderr_fragment: str,
        stdout: str | None = None,
    ) -> None:
        """Assert a CLI refusal with the expected exit code and stderr text."""
        self.assertEqual(result.returncode, returncode)
        if stdout is not None:
            self.assertEqual(result.stdout, stdout)
        self.assertIn(stderr_fragment, result.stderr)

    def assert_preview_json_payload(
        self,
        result: subprocess.CompletedProcess[str],
        *,
        destructive: bool,
        entity: str,
        operation: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Assert the common JSON preview payload shape and return the decoded payload."""
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["result"], "preview")
        self.assertEqual(payload["destructive"], destructive)
        self.assertFalse(payload["apply"])
        self.assertEqual(payload["metadata"]["entity"], entity)
        self.assertEqual(payload["metadata"]["operation"], operation)
        for key, value in (metadata or {}).items():
            self.assertEqual(payload["metadata"][key], value)
        return payload

    def promote_inherited_page_to_real_content(
        self,
        root: Path,
        *,
        version: str,
        book: str,
        section: str,
        page: str,
        title: str,
        body: str,
    ) -> None:
        """Replace an inherited page marker with real authored content."""
        page_dir = root / "content" / "docs" / version / book / section / page
        inherit_path = page_dir / "inherit.md"
        index_path = page_dir / "index.md"

        if inherit_path.exists():
            inherit_path.unlink()

        index_path.write_text(
            f'+++\ntitle = "{title}"\n+++\n\n{body}\n',
            encoding="utf-8",
        )

    def create_inherited_version(
        self, root: Path, *, source_version: str, new_version: str
    ) -> None:
        """Create a derived version using the docs editor itself."""
        editor = self.make_editor(root)
        plan = editor.plan_version_create(
            new_version,
            after=source_version,
            latest=False,
            label=None,
            status=None,
            visible=None,
            searchable=None,
            set_current=False,
        )
        editor.apply_plan(plan)

    def create_modified_branch_descendant(
        self,
        root: Path,
        *,
        relative_parts: tuple[str, ...],
        title: str,
        body: str = "",
        source_version: str = "1.1",
        new_version: str = "1.2",
    ) -> None:
        """Create an inherited later version and promote one branch node to real content."""
        self.create_inherited_version(
            root, source_version=source_version, new_version=new_version
        )
        self.promote_inherited_branch_to_real_content(
            root,
            version=new_version,
            relative_parts=relative_parts,
            title=title,
            body=body,
        )

    def create_modified_page_descendant(
        self,
        root: Path,
        *,
        book: str,
        section: str,
        page: str,
        title: str,
        body: str,
        source_version: str = "1.1",
        new_version: str = "1.2",
    ) -> None:
        """Create an inherited later version and promote one page node to real content."""
        self.create_inherited_version(
            root, source_version=source_version, new_version=new_version
        )
        self.promote_inherited_page_to_real_content(
            root,
            version=new_version,
            book=book,
            section=section,
            page=page,
            title=title,
            body=body,
        )

    def promote_inherited_branch_to_real_content(
        self,
        root: Path,
        *,
        version: str,
        relative_parts: tuple[str, ...],
        title: str,
        body: str = "",
    ) -> None:
        """Replace an inherited branch marker with real authored landing content."""
        branch_dir = root / "content" / "docs" / version / Path(*relative_parts)
        inherit_path = branch_dir / "_inherit.md"
        index_path = branch_dir / "_index.md"

        if inherit_path.exists():
            inherit_path.unlink()

        rendered = f'+++\ntitle = "{title}"\n+++\n'
        if body:
            rendered += f"\n{body}\n"
        else:
            rendered += "\n"

        index_path.write_text(rendered, encoding="utf-8")


class DocsEditorVersionTests(DocsEditorTestCase):
    """Exercise the initial version create/delete feature set."""

    def test_create_version_after_existing_version(self) -> None:
        """Creating a version after an authored version should create inherited content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = DOCS_EDITOR.DocsEditor(root)
        plan = editor.plan_version_create(
            "1.2",
            after="1.1",
            latest=False,
            label=None,
            status=None,
            visible=None,
            searchable=None,
            set_current=False,
        )
        editor.apply_plan(plan)

        versions_data = tomllib.loads(
            (root / "data" / "docs-versions.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            [entry["slug"] for entry in versions_data["versions"]],
            ["0.9", "1.0", "1.1", "1.2", "2.0"],
        )
        self.assertEqual(versions_data["current"], "1.0")

        self.assertTrue((root / "data" / "docs-nav" / "1.2.toml").exists())
        self.assertEqual(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8"),
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8"),
        )

        self.assertEqual(
            (root / "content" / "docs" / "1.2" / "_inherit.md").read_text(
                encoding="utf-8"
            ),
            "",
        )
        self.assertEqual(
            (root / "content" / "docs" / "1.2" / "end-user" / "_inherit.md").read_text(
                encoding="utf-8"
            ),
            "",
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "_inherit.md"
            )
        )
        self.assertEqual(
            (
                root
                / "content"
                / "docs"
                / "1.2"
                / "end-user"
                / "getting-started"
                / "install"
                / "inherit.md"
            ).read_text(encoding="utf-8"),
            "",
        )
        self.assertEqual(editor.validate(), [])

    def test_delete_version_removes_nav_and_content(self) -> None:
        """Deleting a non-current version should update metadata and remove files."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = DOCS_EDITOR.DocsEditor(root)
        plan = editor.plan_version_delete("1.1", new_current=None)
        editor.apply_plan(plan)

        versions_data = tomllib.loads(
            (root / "data" / "docs-versions.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            [entry["slug"] for entry in versions_data["versions"]],
            ["0.9", "1.0", "2.0"],
        )
        self.assertFalse((root / "data" / "docs-nav" / "1.1.toml").exists())
        self.assert_paths_missing(self.docs_content_path(root, "1.1"))
        self.assertEqual(editor.validate(), [])

    def test_delete_current_version_requires_replacement_current(self) -> None:
        """Deleting the current version should require an explicit replacement."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        with self.assertRaises(DOCS_EDITOR.DocsEditorError):
            editor.plan_version_delete("1.0", new_current=None)

    def test_delete_current_version_preserves_newer_inherited_versions(
        self,
    ) -> None:
        """Deleting the current version should preserve descendants with a resolvable earlier source."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.rewrite_versions_document(root, include_slugs=["0.9", "1.0"])
        for version in ("1.1", "2.0"):
            shutil.rmtree(root / "content" / "docs" / version)
            (root / "data" / "docs-nav" / f"{version}.toml").unlink()
        self.create_inherited_version(root, source_version="1.0", new_version="1.1")
        editor = self.make_editor(root)
        plan = editor.plan_version_delete("1.0", new_current="1.1")
        editor.apply_plan(plan)

        self.assert_paths_missing(self.docs_content_path(root, "1.0"))
        self.assertEqual(editor.validate(), [])

    def test_create_latest_refuses_missing_latest_content_tree(self) -> None:
        """Appending after the latest declared version should fail if the latest tree is absent."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        shutil.rmtree(root / "content" / "docs" / "2.0")
        editor = DOCS_EDITOR.DocsEditor(root)
        with self.assertRaises(DOCS_EDITOR.DocsEditorError):
            editor.plan_version_create(
                "2.1",
                after=None,
                latest=True,
                label=None,
                status=None,
                visible=None,
                searchable=None,
                set_current=False,
            )

    def test_create_first_version_with_latest_bootstraps_empty_workspace(self) -> None:
        """Creating the first version with --latest should bootstrap an empty docs workspace."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.make_empty_docs_workspace(root)
        editor = self.make_editor(root)

        plan = editor.plan_version_create(
            "0.7",
            after=None,
            latest=True,
            label=None,
            status=None,
            visible=None,
            searchable=None,
            set_current=False,
        )
        editor.apply_plan(plan)

        versions_data = tomllib.loads(
            (root / "data" / "docs-versions.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(versions_data["current"], "0.7")
        self.assertEqual(
            [entry["slug"] for entry in versions_data["versions"]],
            ["0.7"],
        )
        self.assertEqual(
            (root / "data" / "docs-nav" / "0.7.toml").read_text(encoding="utf-8"),
            "books = [\n]\n",
        )
        self.assertEqual(
            (root / "content" / "docs" / "0.7" / "_index.md").read_text(
                encoding="utf-8"
            ),
            '+++\ntitle = "0.7"\n+++\n\n',
        )
        self.assertEqual(editor.validate(), [])

    def test_create_first_version_refuses_when_version_files_still_exist_on_disk(
        self,
    ) -> None:
        """Bootstrapping the first version should refuse when old version files still exist on disk."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.make_empty_docs_workspace(root)
        (root / "data" / "docs-versions.toml").write_text(
            "# Canonical docs version metadata used by Hugo templates for labels, switchers,\n",
            encoding="utf-8",
        )
        (root / "content" / "docs" / "1.0").mkdir(parents=True, exist_ok=True)
        (root / "data" / "docs-nav" / "1.0.toml").write_text(
            "books = [\n]\n",
            encoding="utf-8",
        )
        editor = self.make_editor(root)

        with self.assertRaises(DOCS_EDITOR.DocsEditorError) as context:
            editor.plan_version_create(
                "0.7",
                after=None,
                latest=True,
                label=None,
                status=None,
                visible=None,
                searchable=None,
                set_current=False,
            )

        self.assertIn(
            "cannot bootstrap first version while undeclared docs versions still exist on disk: 1.0",
            str(context.exception),
        )


class DocsEditorForwardImpactFixtureTests(DocsEditorTestCase):
    """Codify forward-impact scenarios before implementing deeper mutations."""

    def test_book_rename_propagates_into_inherited_only_descendants(self) -> None:
        """Inherited-only descendants should follow a book rename automatically."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        editor = self.make_editor(root)

        plan = editor.plan_book_rename(
            "1.1",
            old_book="end-user",
            new_book="user-guide",
            title=None,
        )
        editor.apply_plan(plan)

        nav_11 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertIn("user-guide", nav_11["books"])
        self.assertIn("user-guide", nav_12["books"])
        self.assertNotIn("end-user", nav_11["books"])
        self.assertNotIn("end-user", nav_12["books"])
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "user-guide"),
            self.docs_content_path(root, "1.2", "user-guide"),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "end-user"),
            self.docs_content_path(root, "1.2", "end-user"),
        )
        self.assertEqual(
            (
                root
                / "content"
                / "docs"
                / "1.2"
                / "user-guide"
                / "getting-started"
                / "install"
                / "inherit.md"
            ).read_text(encoding="utf-8"),
            "",
        )
        self.assertEqual(editor.validate(), [])

    def test_book_rename_materializes_inherited_target_and_preserves_descendant_markers(
        self,
    ) -> None:
        """Renaming an inherited book should materialize the target version and keep later descendants inherited."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        self.create_inherited_version(root, source_version="1.2", new_version="1.3")
        editor = self.make_editor(root)

        plan = editor.plan_book_rename(
            "1.2",
            old_book="end-user",
            new_book="user-guide",
            title=None,
        )
        editor.apply_plan(plan)

        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        nav_13 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.3.toml").read_text(encoding="utf-8")
        )
        self.assertIn("user-guide", nav_12["books"])
        self.assertIn("user-guide", nav_13["books"])
        self.assertNotIn("end-user", nav_12["books"])
        self.assertNotIn("end-user", nav_13["books"])
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.2", "user-guide", DOCS_EDITOR.DOCS_ROOT_INDEX
            ),
            self.docs_content_path(
                root,
                "1.2",
                "user-guide",
                "getting-started",
                "install",
                DOCS_EDITOR.PAGE_INDEX,
            ),
            self.docs_content_path(
                root, "1.3", "user-guide", DOCS_EDITOR.BRANCH_INHERIT
            ),
            self.docs_content_path(
                root,
                "1.3",
                "user-guide",
                "getting-started",
                "install",
                DOCS_EDITOR.PAGE_INHERIT,
            ),
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.2", "user-guide", DOCS_EDITOR.BRANCH_INHERIT
            ),
            self.docs_content_path(
                root, "1.3", "user-guide", DOCS_EDITOR.DOCS_ROOT_INDEX
            ),
            self.docs_content_path(
                root,
                "1.3",
                "user-guide",
                "getting-started",
                "install",
                DOCS_EDITOR.PAGE_INDEX,
            ),
            self.docs_content_path(root, "1.2", "end-user"),
            self.docs_content_path(root, "1.3", "end-user"),
        )
        self.assertEqual(editor.validate(), [])


class DocsEditorBookTests(DocsEditorTestCase):
    """Exercise book-level create, delete, and rename behavior."""

    def test_book_materialize_replaces_inherited_marker_with_real_content(self) -> None:
        """Materializing an inherited book should preserve its resolved landing content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        plan = editor.plan_book_materialize(
            "1.0", book="website-dev-guide", title="Website Dev Guide 1.0"
        )
        editor.apply_plan(plan)

        book_dir = self.docs_content_path(root, "1.0", "website-dev-guide")
        self.assert_paths_missing(book_dir / DOCS_EDITOR.BRANCH_INHERIT)
        self.assertIn(
            'title = "Website Dev Guide 1.0"',
            (book_dir / DOCS_EDITOR.DOCS_ROOT_INDEX).read_text(encoding="utf-8"),
        )
        self.assertEqual(editor.validate(), [])

    def test_book_create_adds_nav_and_real_landing_content(self) -> None:
        """Creating a real-content book should add nav and _index.md."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        plan = editor.plan_book_create(
            "1.1",
            book="tutorials",
            title="Tutorials",
            position="end",
            inherit=False,
        )
        editor.apply_plan(plan)

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(nav["books"][-1], "tutorials")
        self.assertEqual(
            (root / "content" / "docs" / "1.1" / "tutorials" / "_index.md").read_text(
                encoding="utf-8"
            ),
            '+++\ntitle = "Tutorials"\n+++\n\n',
        )
        self.assertEqual(editor.validate(), [])

    def test_structural_only_book_create_keeps_nav_and_tree_valid(self) -> None:
        """Structural-only books should update nav without creating landing files."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        plan = editor.plan_book_create(
            "1.1",
            book="tutorials",
            title=None,
            position="end",
            inherit=False,
            structural_only=True,
        )
        editor.apply_plan(plan)

        self.assertEqual(self.nav_book_slugs(root, "1.1")[-1], "tutorials")
        self.assert_paths_exist(self.docs_content_path(root, "1.1", "tutorials"))
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "tutorials", "_index.md"),
            self.docs_content_path(root, "1.1", "tutorials", "_inherit.md"),
        )
        self.assertEqual(editor.validate(), [])

    def test_structural_only_book_create_rejects_title_and_inherit(self) -> None:
        """Structural books cannot have either landing metadata or inheritance."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        with self.assertRaisesRegex(DOCS_EDITOR.DocsEditorError, "--title"):
            editor.plan_book_create(
                "1.1",
                book="tutorials",
                title="Tutorials",
                position=None,
                inherit=False,
                structural_only=True,
            )
        with self.assertRaisesRegex(DOCS_EDITOR.DocsEditorError, "--inherit"):
            editor.plan_book_create(
                "1.1",
                book="tutorials",
                title=None,
                position=None,
                inherit=True,
                structural_only=True,
            )

    def test_structural_only_book_is_preserved_in_inherited_version(self) -> None:
        """A later inherited version must retain a markerless structural book."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        editor.apply_plan(
            editor.plan_book_create(
                "1.1",
                book="tutorials",
                title=None,
                position="end",
                inherit=False,
                structural_only=True,
            )
        )
        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        self.assert_paths_exist(self.docs_content_path(root, "1.2", "tutorials"))
        self.assert_paths_missing(
            self.docs_content_path(root, "1.2", "tutorials", "_index.md"),
            self.docs_content_path(root, "1.2", "tutorials", "_inherit.md"),
        )
        self.assertEqual(self.make_editor(root).validate(), [])

    def test_structural_only_book_rename_preserves_markerless_root(self) -> None:
        """Renaming a structural book must not materialize a landing page."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        editor.apply_plan(
            editor.plan_book_create(
                "1.1",
                book="tutorials",
                title=None,
                position="end",
                inherit=False,
                structural_only=True,
            )
        )
        editor.apply_plan(
            editor.plan_book_rename(
                "1.1",
                old_book="tutorials",
                new_book="learning",
                title=None,
            )
        )

        self.assert_paths_exist(self.docs_content_path(root, "1.1", "learning"))
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "learning", "_index.md"),
            self.docs_content_path(root, "1.1", "learning", "_inherit.md"),
            self.docs_content_path(root, "1.1", "tutorials"),
        )
        with self.assertRaisesRegex(DOCS_EDITOR.DocsEditorError, "--title"):
            editor.plan_book_rename(
                "1.1",
                old_book="learning",
                new_book="training",
                title="Training",
            )
        self.assertEqual(editor.validate(), [])

    def test_book_delete_removes_nav_and_content(self) -> None:
        """Deleting a book should remove its directory and nav entries."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        create_plan = editor.plan_book_create(
            "1.1",
            book="tutorials",
            title="Tutorials",
            position="end",
            inherit=False,
        )
        editor.apply_plan(create_plan)

        delete_plan = editor.plan_book_delete("1.1", book="tutorials")
        editor.apply_plan(delete_plan)

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertNotIn("tutorials", nav["books"])
        self.assert_paths_missing(self.docs_content_path(root, "1.1", "tutorials"))
        self.assertEqual(editor.validate(), [])

    def test_book_delete_propagates_into_inherited_only_descendants(self) -> None:
        """Deleting an older book should remove inherited-only descendants automatically."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        editor = self.make_editor(root)

        delete_plan = editor.plan_book_delete("1.1", book="end-user")
        editor.apply_plan(delete_plan)

        nav_11 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertNotIn("end-user", nav_11["books"])
        self.assertNotIn("end-user", nav_12["books"])
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "end-user"),
            self.docs_content_path(root, "1.2", "end-user"),
        )
        self.assertEqual(editor.validate(), [])

    def test_book_delete_refuses_when_later_version_has_real_content(self) -> None:
        """Deleting an older book should fail if a later descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_branch_descendant(
            root,
            relative_parts=("end-user",),
            title="User Guide 1.2",
            body="This version has diverged from the inherited book landing page.",
        )

        editor = self.make_editor(root)
        with self.assertRaises(DOCS_EDITOR.DocsEditorError):
            editor.plan_book_delete("1.1", book="end-user")

    def test_book_create_inherit_requires_earlier_resolution(self) -> None:
        """Creating an inherited book should require an earlier real book landing page."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        with self.assertRaises(DOCS_EDITOR.DocsEditorError):
            editor.plan_book_create(
                "1.1",
                book="tutorials",
                title=None,
                position=None,
                inherit=True,
            )


class DocsEditorSectionTests(DocsEditorTestCase):
    """Exercise section-level create, delete, and rename behavior."""

    def test_section_create_adds_nav_and_real_landing_content(self) -> None:
        """Creating a real-content section should add nav and _index.md."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        plan = editor.plan_section_create(
            "1.1",
            book="admin",
            section="authentication",
            title="Authentication",
            position="end",
            inherit=False,
            structural_only=False,
        )
        editor.apply_plan(plan)

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            nav["sections"]["admin"]["items"][-1]["slug"], "authentication"
        )
        self.assertEqual(nav["pages"]["admin"]["authentication"]["items"], [])
        self.assertEqual(
            (
                root
                / "content"
                / "docs"
                / "1.1"
                / "admin"
                / "authentication"
                / "_index.md"
            ).read_text(encoding="utf-8"),
            '+++\ntitle = "Authentication"\n+++\n\n',
        )
        self.assertEqual(editor.validate(), [])

    def test_section_delete_removes_nav_and_content(self) -> None:
        """Deleting a section should remove its directory and nav entries."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        create_plan = editor.plan_section_create(
            "1.1",
            book="admin",
            section="authentication",
            title="Authentication",
            position="end",
            inherit=False,
            structural_only=False,
        )
        editor.apply_plan(create_plan)

        delete_plan = editor.plan_section_delete(
            "1.1", book="admin", section="authentication"
        )
        editor.apply_plan(delete_plan)

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertNotIn(
            "authentication",
            [entry["slug"] for entry in nav["sections"]["admin"]["items"]],
        )
        self.assertNotIn("admin", nav["pages"])
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication")
        )
        self.assertEqual(editor.validate(), [])

    def test_section_delete_propagates_into_inherited_only_descendants(self) -> None:
        """Deleting an older section should remove inherited-only descendants automatically."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        editor = self.make_editor(root)

        delete_plan = editor.plan_section_delete(
            "1.1", book="admin", section="configuration"
        )
        editor.apply_plan(delete_plan)

        nav_11 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertNotIn("admin", nav_11.get("sections", {}))
        self.assertNotIn("admin", nav_12.get("sections", {}))
        self.assertNotIn("admin", nav_11.get("pages", {}))
        self.assertNotIn("admin", nav_12.get("pages", {}))
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "configuration"),
            self.docs_content_path(root, "1.2", "admin", "configuration"),
        )
        self.assertEqual(editor.validate(), [])

    def test_section_delete_refuses_when_later_version_has_real_content(self) -> None:
        """Deleting an older section should fail if a later descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_branch_descendant(
            root,
            relative_parts=("admin", "configuration"),
            title="Configuration 1.2",
            body="This version has diverged from the inherited section landing page.",
        )

        editor = self.make_editor(root)
        with self.assertRaises(DOCS_EDITOR.DocsEditorError):
            editor.plan_section_delete("1.1", book="admin", section="configuration")

    def test_section_rename_propagates_into_inherited_only_descendants(self) -> None:
        """Inherited-only descendants should follow a section rename automatically."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        editor = self.make_editor(root)

        plan = editor.plan_section_rename(
            "1.1",
            book="admin",
            old_section="configuration",
            new_section="authentication",
            title="Authentication",
        )
        editor.apply_plan(plan)

        nav_11 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertIn(
            "authentication",
            [entry["slug"] for entry in nav_11["sections"]["admin"]["items"]],
        )
        self.assertIn(
            "authentication",
            [entry["slug"] for entry in nav_12["sections"]["admin"]["items"]],
        )
        self.assertNotIn(
            "configuration",
            [entry["slug"] for entry in nav_11["sections"]["admin"]["items"]],
        )
        self.assertNotIn(
            "configuration",
            [entry["slug"] for entry in nav_12["sections"]["admin"]["items"]],
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "admin", "authentication"),
            self.docs_content_path(root, "1.2", "admin", "authentication"),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "configuration"),
            self.docs_content_path(root, "1.2", "admin", "configuration"),
        )
        self.assertEqual(editor.validate(), [])

    def test_section_rename_materializes_inherited_target_and_preserves_descendant_markers(
        self,
    ) -> None:
        """Renaming an inherited section should materialize the target version and keep later descendants inherited."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        self.create_inherited_version(root, source_version="1.2", new_version="1.3")
        editor = self.make_editor(root)

        plan = editor.plan_section_rename(
            "1.2",
            book="admin",
            old_section="configuration",
            new_section="authentication",
            title="Authentication",
        )
        editor.apply_plan(plan)

        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        nav_13 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.3.toml").read_text(encoding="utf-8")
        )
        self.assertIn(
            "authentication",
            [entry["slug"] for entry in nav_12["sections"]["admin"]["items"]],
        )
        self.assertIn(
            "authentication",
            [entry["slug"] for entry in nav_13["sections"]["admin"]["items"]],
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.2", "admin", "authentication", DOCS_EDITOR.DOCS_ROOT_INDEX
            ),
            self.docs_content_path(
                root, "1.3", "admin", "authentication", DOCS_EDITOR.BRANCH_INHERIT
            ),
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.2", "admin", "authentication", DOCS_EDITOR.BRANCH_INHERIT
            ),
            self.docs_content_path(
                root, "1.3", "admin", "authentication", DOCS_EDITOR.DOCS_ROOT_INDEX
            ),
            self.docs_content_path(root, "1.2", "admin", "configuration"),
            self.docs_content_path(root, "1.3", "admin", "configuration"),
        )
        self.assertEqual(editor.validate(), [])

    def test_page_delete_refuses_when_newer_version_has_real_content(self) -> None:
        """Deleting an older page should fail if a later descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_page_descendant(
            root,
            book="end-user",
            section="getting-started",
            page="install",
            title="Install Sambee 1.2",
            body="This version has diverged from the inherited install instructions.",
        )

        editor = self.make_editor(root)
        self.assertEqual(editor.validate(), [])
        with self.assertRaises(DOCS_EDITOR.DocsEditorError):
            editor.plan_page_delete(
                "1.1", book="end-user", section="getting-started", page="install"
            )

    def test_structural_only_section_create_keeps_nav_and_tree_valid(self) -> None:
        """Structural-only sections should update nav without creating landing content files."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        plan = editor.plan_section_create(
            "1.1",
            book="developer",
            section="testing",
            title="Testing",
            position="end",
            inherit=False,
            structural_only=True,
        )
        editor.apply_plan(plan)

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertIn(
            "testing",
            [entry["slug"] for entry in nav["sections"]["developer"]["items"]],
        )
        self.assertEqual(nav["pages"]["developer"]["testing"]["items"], [])
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "developer", "testing")
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "developer", "testing", "_index.md"),
            self.docs_content_path(root, "1.1", "developer", "testing", "_inherit.md"),
        )
        self.assertEqual(editor.validate(), [])


class DocsEditorPageTests(DocsEditorTestCase):
    """Exercise page-level create, delete, and rename behavior."""

    def test_page_create_adds_nav_and_real_content(self) -> None:
        """Creating a real-content page should add nav and index.md."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        plan = editor.plan_page_create(
            "1.1",
            book="end-user",
            section="getting-started",
            page="upgrade",
            title="Upgrade Sambee",
            position="end",
            inherit=False,
        )
        editor.apply_plan(plan)

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            nav["pages"]["end-user"]["getting-started"]["items"][-1], "upgrade"
        )
        self.assertEqual(
            (
                root
                / "content"
                / "docs"
                / "1.1"
                / "end-user"
                / "getting-started"
                / "upgrade"
                / "index.md"
            ).read_text(encoding="utf-8"),
            '+++\ntitle = "Upgrade Sambee"\n+++\n\n',
        )
        self.assertEqual(editor.validate(), [])

    def test_page_delete_removes_nav_and_content(self) -> None:
        """Deleting a page should remove its directory and nav entry."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        create_plan = editor.plan_page_create(
            "1.1",
            book="end-user",
            section="getting-started",
            page="upgrade",
            title="Upgrade Sambee",
            position="end",
            inherit=False,
        )
        editor.apply_plan(create_plan)

        delete_plan = editor.plan_page_delete(
            "1.1", book="end-user", section="getting-started", page="upgrade"
        )
        editor.apply_plan(delete_plan)

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertNotIn(
            "upgrade", nav["pages"]["end-user"]["getting-started"]["items"]
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "upgrade"
            )
        )
        self.assertEqual(editor.validate(), [])

    def test_page_delete_propagates_into_inherited_only_descendants(self) -> None:
        """Deleting an older page should remove inherited-only descendants automatically."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        editor = self.make_editor(root)

        delete_plan = editor.plan_page_delete(
            "1.1", book="end-user", section="getting-started", page="install"
        )
        editor.apply_plan(delete_plan)

        nav_11 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertNotIn(
            "install", nav_11["pages"]["end-user"]["getting-started"]["items"]
        )
        self.assertNotIn(
            "install", nav_12["pages"]["end-user"]["getting-started"]["items"]
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "install"
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "install"
            ),
        )
        self.assertEqual(editor.validate(), [])

    def test_page_rename_propagates_into_inherited_only_descendants(self) -> None:
        """Inherited-only descendants should follow a page rename automatically."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        editor = self.make_editor(root)

        plan = editor.plan_page_rename(
            "1.1",
            book="end-user",
            section="getting-started",
            old_page="install",
            new_page="setup",
            title="Setup Sambee",
        )
        editor.apply_plan(plan)

        nav_11 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertIn("setup", nav_11["pages"]["end-user"]["getting-started"]["items"])
        self.assertIn("setup", nav_12["pages"]["end-user"]["getting-started"]["items"])
        self.assertNotIn(
            "install", nav_11["pages"]["end-user"]["getting-started"]["items"]
        )
        self.assertNotIn(
            "install", nav_12["pages"]["end-user"]["getting-started"]["items"]
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "setup", "index.md"
            )
        )
        self.assertEqual(
            (
                root
                / "content"
                / "docs"
                / "1.2"
                / "end-user"
                / "getting-started"
                / "setup"
                / "inherit.md"
            ).read_text(encoding="utf-8"),
            "",
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "install"
            )
        )
        self.assertEqual(editor.validate(), [])

    def test_page_move_propagates_into_inherited_only_descendants(self) -> None:
        """Moving a page should preserve content and move inherited descendants."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        editor.apply_plan(
            editor.plan_section_create(
                "1.1",
                book="end-user",
                section="reference",
                title="Reference",
                position="end",
                inherit=False,
                structural_only=True,
            )
        )
        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        plan = editor.plan_page_move(
            "1.1",
            book="end-user",
            from_section="getting-started",
            to_section="reference",
            old_page="install",
            new_page="setup",
            title="Setup Sambee",
            position="start",
        )
        editor.apply_plan(plan)

        for version in ("1.1", "1.2"):
            nav = tomllib.loads(
                (root / "data" / "docs-nav" / f"{version}.toml").read_text(
                    encoding="utf-8"
                )
            )
            self.assertNotIn(
                "install", nav["pages"]["end-user"]["getting-started"]["items"]
            )
            self.assertIn("setup", nav["pages"]["end-user"]["reference"]["items"])
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.1", "end-user", "reference", "setup", "index.md"
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "reference", "setup", "inherit.md"
            ),
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "install"
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "install"
            ),
        )
        self.assertEqual(editor.validate(), [])

    def test_page_move_refuses_when_later_descendant_has_real_content(self) -> None:
        """A move must not silently relocate a later authored page."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        editor.apply_plan(
            editor.plan_section_create(
                "1.1",
                book="end-user",
                section="reference",
                title="Reference",
                position="end",
                inherit=False,
                structural_only=True,
            )
        )
        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        self.promote_inherited_page_to_real_content(
            root,
            version="1.2",
            book="end-user",
            section="getting-started",
            page="install",
            title="Install Sambee 1.2",
            body="Version-specific instructions.",
        )

        with self.assertRaisesRegex(
            DOCS_EDITOR.DocsEditorError,
            "cannot move page across later versions with real content: 1.2",
        ):
            editor.plan_page_move(
                "1.1",
                book="end-user",
                from_section="getting-started",
                to_section="reference",
                old_page="install",
                new_page="setup",
                title="Setup Sambee",
                position=None,
            )

    def test_cli_page_move_preview_reports_destination_and_propagation(self) -> None:
        """CLI preview should describe an inherited page move without writing files."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        editor.apply_plan(
            editor.plan_section_create(
                "1.1",
                book="end-user",
                section="reference",
                title="Reference",
                position="end",
                inherit=False,
                structural_only=True,
            )
        )
        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--json",
            "page",
            "move",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--from-section",
            "getting-started",
            "--to-section",
            "reference",
            "--page",
            "install",
        )

        self.assert_preview_json_payload(
            result,
            destructive=True,
            entity="page",
            operation="move",
            metadata={
                "version": "1.1",
                "book": "end-user",
                "from_section": "getting-started",
                "to_section": "reference",
                "page": "install",
                "new_page": "install",
                "propagated_versions": ["1.2"],
            },
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "install"
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "install"
            ),
        )

    def test_cli_book_materialize_apply_writes_real_content(self) -> None:
        """CLI apply should replace an inherited book marker with an index page."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--apply",
            "book",
            "materialize",
            "--version",
            "1.0",
            "--book",
            "website-dev-guide",
            "--title",
            "Website Dev Guide 1.0",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Materialize inherited book website-dev-guide in docs version 1.0",
            result.stdout,
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.0", "website-dev-guide", DOCS_EDITOR.DOCS_ROOT_INDEX
            )
        )

    def test_page_rename_materializes_inherited_target_and_preserves_descendant_markers(
        self,
    ) -> None:
        """Renaming an inherited page should materialize the target version and keep later descendants inherited."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        self.create_inherited_version(root, source_version="1.2", new_version="1.3")
        editor = self.make_editor(root)

        plan = editor.plan_page_rename(
            "1.2",
            book="end-user",
            section="getting-started",
            old_page="install",
            new_page="setup",
            title="Setup Sambee",
        )
        editor.apply_plan(plan)

        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        nav_13 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.3.toml").read_text(encoding="utf-8")
        )
        self.assertIn("setup", nav_12["pages"]["end-user"]["getting-started"]["items"])
        self.assertIn("setup", nav_13["pages"]["end-user"]["getting-started"]["items"])
        self.assert_paths_exist(
            self.docs_content_path(
                root,
                "1.2",
                "end-user",
                "getting-started",
                "setup",
                DOCS_EDITOR.PAGE_INDEX,
            ),
            self.docs_content_path(
                root,
                "1.3",
                "end-user",
                "getting-started",
                "setup",
                DOCS_EDITOR.PAGE_INHERIT,
            ),
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root,
                "1.2",
                "end-user",
                "getting-started",
                "setup",
                DOCS_EDITOR.PAGE_INHERIT,
            ),
            self.docs_content_path(
                root,
                "1.3",
                "end-user",
                "getting-started",
                "setup",
                DOCS_EDITOR.PAGE_INDEX,
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "install"
            ),
            self.docs_content_path(
                root, "1.3", "end-user", "getting-started", "install"
            ),
        )
        self.assertEqual(editor.validate(), [])

    def test_page_rename_allows_later_non_overlapping_target_page(self) -> None:
        """An older rename may safely precede a later version that already uses the new slug."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        later_old_page = self.docs_content_path(
            root, "1.2", "end-user", "getting-started", "install"
        )
        later_new_page = self.docs_content_path(
            root, "1.2", "end-user", "getting-started", "setup"
        )
        later_old_page.rename(later_new_page)
        nav_path = root / "data" / "docs-nav" / "1.2.toml"
        nav_path.write_text(
            nav_path.read_text(encoding="utf-8").replace('"install"', '"setup"'),
            encoding="utf-8",
        )

        editor = self.make_editor(root)
        plan = editor.plan_page_rename(
            "1.1",
            book="end-user",
            section="getting-started",
            old_page="install",
            new_page="setup",
            title="Setup Sambee",
        )
        editor.apply_plan(plan)

        self.assertEqual(plan.metadata["propagated_versions"], [])
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "setup", "index.md"
            ),
            later_new_page / "inherit.md",
        )
        self.assertEqual(editor.validate(), [])

    def test_page_rename_refuses_later_overlapping_target_page(self) -> None:
        """A later version that contains both slugs remains an unsafe collision."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        later_new_page = self.docs_content_path(
            root, "1.2", "end-user", "getting-started", "setup"
        )
        later_new_page.mkdir()
        (later_new_page / "index.md").write_text(
            '+++\ntitle = "Different Setup"\n+++\n', encoding="utf-8"
        )
        nav_path = root / "data" / "docs-nav" / "1.2.toml"
        nav_path.write_text(
            nav_path.read_text(encoding="utf-8").replace(
                '  "install",', '  "install",\n  "setup",'
            ),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(
            DOCS_EDITOR.DocsEditorError, "contains both page slugs"
        ):
            self.make_editor(root).plan_page_rename(
                "1.1",
                book="end-user",
                section="getting-started",
                old_page="install",
                new_page="setup",
                title="Setup Sambee",
            )

    def test_page_rename_coordinates_selected_authored_versions(self) -> None:
        """Selected independently authored versions are renamed as one atomic plan."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        self.create_inherited_version(root, source_version="1.2", new_version="1.3")
        self.promote_inherited_page_to_real_content(
            root,
            version="1.3",
            book="end-user",
            section="getting-started",
            page="install",
            title="Install Sambee 1.3",
            body="Version-specific instructions.",
        )

        editor = self.make_editor(root)
        plan = editor.plan_page_coordinated_rename(
            ["1.1", "1.3"],
            book="end-user",
            section="getting-started",
            old_page="install",
            new_page="setup",
            title="Setup Sambee",
        )
        editor.apply_plan(plan)

        self.assertEqual(plan.metadata["versions"], ["1.1", "1.3"])
        self.assertEqual(plan.metadata["propagated_versions"], ["1.2"])
        for version in ("1.1", "1.2", "1.3"):
            page_slugs = self.nav_page_slugs(
                root, version, "end-user", "getting-started"
            )
            self.assertIn("setup", page_slugs)
            self.assertNotIn("install", page_slugs)
        self.assertEqual(editor.validate(), [])

    def test_page_create_inherit_requires_earlier_resolution(self) -> None:
        """Creating an inherited page should require an earlier real page."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        with self.assertRaises(DOCS_EDITOR.DocsEditorError):
            editor.plan_page_create(
                "1.1",
                book="admin",
                section="configuration",
                page="advanced",
                title=None,
                position=None,
                inherit=True,
            )

    def test_page_materialize_replaces_inherited_marker_with_real_content(
        self,
    ) -> None:
        """Materializing a page should replace inherit.md with a real index.md."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)
        expected_text = editor.replace_title_in_markdown(
            editor.resolve_page_source_file(
                "1.0",
                (
                    "website-dev-guide",
                    "docs-platform",
                    "website-and-docs-architecture-overview",
                ),
            ).read_text(encoding="utf-8"),
            "Website and Docs Architecture Overview for 1.0",
        )

        plan = editor.plan_page_materialize(
            "1.0",
            book="website-dev-guide",
            section="docs-platform",
            page="website-and-docs-architecture-overview",
            title="Website and Docs Architecture Overview for 1.0",
        )
        editor.apply_plan(plan)

        self.assert_paths_missing(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INHERIT,
            )
        )
        self.assertEqual(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INDEX,
            ).read_text(encoding="utf-8"),
            expected_text,
        )
        self.assertEqual(editor.validate(), [])

    def test_page_materialize_refuses_when_page_is_already_authored(self) -> None:
        """Materializing should fail when the target page already has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)

        with self.assertRaisesRegex(
            DOCS_EDITOR.DocsEditorError,
            "page already has real content: 0.9/website-dev-guide/docs-platform/website-and-docs-architecture-overview",
        ):
            editor.plan_page_materialize(
                "0.9",
                book="website-dev-guide",
                section="docs-platform",
                page="website-and-docs-architecture-overview",
                title=None,
            )

    def test_page_inherit_replaces_real_content_with_inherited_marker(self) -> None:
        """Converting a page back to inherited should replace index.md with inherit.md."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.promote_inherited_page_to_real_content(
            root,
            version="1.0",
            book="website-dev-guide",
            section="docs-platform",
            page="website-and-docs-architecture-overview",
            title="Website and Docs Architecture Overview for 1.0",
            body="Version-specific override.",
        )

        editor = self.make_editor(root)
        plan = editor.plan_page_inherit(
            "1.0",
            book="website-dev-guide",
            section="docs-platform",
            page="website-and-docs-architecture-overview",
        )
        editor.apply_plan(plan)

        self.assert_paths_missing(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INDEX,
            )
        )
        self.assertEqual(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INHERIT,
            ).read_text(encoding="utf-8"),
            "",
        )
        self.assertEqual(editor.validate(), [])

    def test_page_inherit_refuses_without_earlier_authored_source(self) -> None:
        """Converting a page to inherited should fail when no earlier real page exists."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        editor = self.make_editor(root)

        with self.assertRaisesRegex(
            DOCS_EDITOR.DocsEditorError,
            "cannot inherit page 0.9/website-dev-guide/docs-platform/website-and-docs-architecture-overview: no earlier version resolves to index.md",
        ):
            editor.plan_page_inherit(
                "0.9",
                book="website-dev-guide",
                section="docs-platform",
                page="website-and-docs-architecture-overview",
            )


class DocsEditorMigrationTests(DocsEditorTestCase):
    """Verify that preview, apply, and release operations preserve URL decisions."""

    def test_rename_records_inherited_and_unversioned_aliases_and_repeated_moves(
        self,
    ) -> None:
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)
        editor = DOCS_EDITOR.DocsEditor(root)
        source = "website-and-docs-architecture-overview"
        plan = editor.plan_page_rename(
            "0.9",
            book="website-dev-guide",
            section="docs-platform",
            old_page=source,
            new_page="renamed",
            title=None,
        )
        registry_path = root / "data/docs-migrations.json"
        self.assertFalse(registry_path.exists())
        self.assertEqual(
            {scope for alias in plan.metadata["aliases"] for scope in alias["scopes"]},
            {"0.9", "1.0", "unversioned"},
        )
        editor.apply_plan(plan)
        second = editor.plan_page_rename(
            "0.9",
            book="website-dev-guide",
            section="docs-platform",
            old_page="renamed",
            new_page="final",
            title=None,
        )
        editor.apply_plan(second)
        entries = json.loads(registry_path.read_text())["migrations"]
        self.assertTrue(
            any(
                entry["source"].endswith(source + "/")
                and entry["target"].endswith("renamed/")
                for entry in entries
            )
        )
        self.assertTrue(
            any(
                entry["source"].endswith("renamed/")
                and entry["target"].endswith("final/")
                for entry in entries
            )
        )

    def test_structural_book_records_only_previously_routable_descendants(self) -> None:
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)
        (root / "content/docs/0.9/website-dev-guide/_index.md").unlink()
        (root / "content/docs/1.0/website-dev-guide/_inherit.md").unlink()
        plan = DOCS_EDITOR.DocsEditor(root).plan_book_rename(
            "0.9", old_book="website-dev-guide", new_book="web-guide", title=None
        )
        self.assertTrue(plan.metadata["aliases"])
        self.assertTrue(
            all(
                alias["source"] != "website-dev-guide/"
                for alias in plan.metadata["aliases"]
            )
        )

    def test_new_version_carries_scoped_aliases(self) -> None:
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)
        editor = DOCS_EDITOR.DocsEditor(root)
        renamed = editor.plan_page_rename(
            "0.9",
            book="website-dev-guide",
            section="docs-platform",
            old_page="website-and-docs-architecture-overview",
            new_page="renamed",
            title=None,
        )
        editor.apply_plan(renamed)
        created = editor.plan_version_create(
            "new",
            after="1.0",
            latest=False,
            label=None,
            status=None,
            visible=None,
            searchable=None,
            set_current=False,
        )
        self.assertTrue(created.metadata["aliases"])
        editor.apply_plan(created)
        entries = json.loads((root / "data/docs-migrations.json").read_text())[
            "migrations"
        ]
        self.assertTrue(any("new" in entry["scopes"] for entry in entries))

    def test_current_transition_refuses_missing_decisions_and_skipped_versions(
        self,
    ) -> None:
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)
        editor = DOCS_EDITOR.DocsEditor(root)
        with self.assertRaisesRegex(
            DOCS_EDITOR.DocsEditorError, "one declared version"
        ):
            editor.plan_version_set_current("2.0")
        with self.assertRaisesRegex(DOCS_EDITOR.DocsEditorError, "replacement or gone"):
            editor.plan_version_set_current("1.1")
        locations = editor.routable_locations("1.0") - editor.routable_locations("1.1")
        (root / "data/docs-migrations.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "migrations": [
                        {"source": source, "target": None, "scopes": ["unversioned"]}
                        for source in locations
                    ],
                }
            )
        )
        plan = editor.plan_version_set_current("1.1")
        self.assertEqual(set(plan.metadata["release_decisions"]), locations)
        self.assertEqual(editor.load_versions_document().current, "1.0")
        editor.apply_plan(plan)
        self.assertEqual(editor.load_versions_document().current, "1.1")

    def test_version_creation_omits_reused_source_and_refuses_missing_target(
        self,
    ) -> None:
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)
        editor = DOCS_EDITOR.DocsEditor(root)
        existing = (
            "website-dev-guide/docs-platform/website-and-docs-architecture-overview/"
        )
        registry = root / "data/docs-migrations.json"
        registry.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "migrations": [
                        {
                            "source": existing,
                            "target": "website-dev-guide/missing/",
                            "scopes": ["1.0"],
                        }
                    ],
                }
            )
        )
        plan = editor.plan_version_create(
            "new",
            after="1.0",
            latest=False,
            label=None,
            status=None,
            visible=None,
            searchable=None,
            set_current=False,
        )
        self.assertEqual(plan.metadata["aliases"], [])
        registry.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "migrations": [
                        {
                            "source": "website-dev-guide/old/",
                            "target": "website-dev-guide/missing/",
                            "scopes": ["1.0"],
                        }
                    ],
                }
            )
        )
        with self.assertRaisesRegex(DOCS_EDITOR.DocsEditorError, "missing replacement"):
            editor.plan_version_create(
                "new",
                after="1.0",
                latest=False,
                label=None,
                status=None,
                visible=None,
                searchable=None,
                set_current=False,
            )


class DocsEditorCliTests(DocsEditorTestCase):
    """Exercise the public CLI entrypoint and its user-facing output."""

    def test_cli_preview_json_create_outputs_plan_without_writing(self) -> None:
        """Preview mode should emit JSON without mutating the workspace."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root, "--json", "version", "create", "1.2", "--after", "1.1"
        )

        self.assert_preview_json_payload(
            result,
            destructive=False,
            entity="version",
            operation="create",
            metadata={"new_version": "1.2", "source_version": "1.1"},
        )
        self.assertFalse((root / "content" / "docs" / "1.2").exists())
        self.assert_versions_state(
            root, current="1.0", slugs=["0.9", "1.0", "1.1", "2.0"]
        )

    def test_cli_version_create_preview_text_includes_metadata(self) -> None:
        """Human-readable preview should show the operation metadata before file changes."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(root, "version", "create", "1.2", "--after", "1.1")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Metadata:\n- Entity: version", result.stdout)
        self.assertIn("- New version: 1.2", result.stdout)
        self.assertIn("- Source version: 1.1", result.stdout)
        self.assertIn("Run again with --apply to write these changes.", result.stdout)

    def test_cli_version_create_with_latest_bootstraps_first_version(self) -> None:
        """CLI apply should bootstrap the first docs version when metadata is empty."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.make_empty_docs_workspace(root)

        result = self.run_cli(root, "--apply", "version", "create", "0.7", "--latest")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Applied: Create initial docs version 0.7", result.stdout)
        self.assert_versions_state(root, current="0.7", slugs=["0.7"])
        self.assertEqual(
            (root / "data" / "docs-nav" / "0.7.toml").read_text(encoding="utf-8"),
            "books = [\n]\n",
        )
        self.assertEqual(
            self.docs_content_path(root, "0.7", "_index.md").read_text(
                encoding="utf-8"
            ),
            '+++\ntitle = "0.7"\n+++\n\n',
        )

    def test_cli_version_create_refuses_missing_insert_selector(self) -> None:
        """CLI create should fail in argparse when neither --after nor --latest is provided."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(root, "version", "create", "1.2")

        self.assert_cli_refusal(
            result,
            returncode=2,
            stderr_fragment="one of the arguments --after --latest is required",
        )
        self.assert_paths_missing(self.docs_content_path(root, "1.2"))

    def test_cli_version_create_refuses_invalid_visible_boolean(self) -> None:
        """CLI create should fail in argparse when --visible is not a valid boolean."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "version",
            "create",
            "1.2",
            "--after",
            "1.1",
            "--visible",
            "maybe",
        )

        self.assert_cli_refusal(
            result,
            returncode=2,
            stderr_fragment="argument --visible: expected a boolean value, got: maybe",
        )
        self.assert_paths_missing(self.docs_content_path(root, "1.2"))
        self.assert_versions_state(root, slugs=["0.9", "1.0", "1.1", "2.0"])

    def test_cli_version_create_refuses_invalid_searchable_boolean(self) -> None:
        """CLI create should fail in argparse when --searchable is not a valid boolean."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "version",
            "create",
            "1.2",
            "--after",
            "1.1",
            "--searchable",
            "maybe",
        )

        self.assert_cli_refusal(
            result,
            returncode=2,
            stderr_fragment="argument --searchable: expected a boolean value, got: maybe",
        )
        self.assert_paths_missing(self.docs_content_path(root, "1.2"))
        self.assert_versions_state(root, slugs=["0.9", "1.0", "1.1", "2.0"])

    def test_cli_version_create_accepts_truthy_boolean_spellings(self) -> None:
        """CLI create should accept documented truthy spellings for version booleans."""
        for value in ("true", "yes", "1"):
            with self.subTest(value=value):
                tempdir, root = self.build_temp_website()
                self.addCleanup(tempdir.cleanup)

                result = self.run_cli(
                    root,
                    "--apply",
                    "version",
                    "create",
                    "1.2",
                    "--after",
                    "1.1",
                    "--visible",
                    value,
                    "--searchable",
                    value,
                )

                self.assertEqual(result.returncode, 0, msg=result.stderr)
                versions_data = self.assert_versions_state(root)
                new_entry = next(
                    entry
                    for entry in versions_data["versions"]
                    if entry["slug"] == "1.2"
                )
                self.assertTrue(new_entry["visible"])
                self.assertTrue(new_entry["searchable"])
                self.assert_paths_exist(
                    self.docs_content_path(root, "1.2"),
                    root / "data" / "docs-nav" / "1.2.toml",
                )

    def test_cli_version_create_accepts_falsy_boolean_spellings(self) -> None:
        """CLI create should accept documented falsy spellings for version booleans."""
        for value in ("false", "no", "0"):
            with self.subTest(value=value):
                tempdir, root = self.build_temp_website()
                self.addCleanup(tempdir.cleanup)

                result = self.run_cli(
                    root,
                    "--apply",
                    "version",
                    "create",
                    "1.2",
                    "--after",
                    "1.1",
                    "--visible",
                    value,
                    "--searchable",
                    value,
                )

                self.assertEqual(result.returncode, 0, msg=result.stderr)
                versions_data = self.assert_versions_state(root)
                new_entry = next(
                    entry
                    for entry in versions_data["versions"]
                    if entry["slug"] == "1.2"
                )
                self.assertFalse(new_entry["visible"])
                self.assertFalse(new_entry["searchable"])
                self.assert_paths_exist(
                    self.docs_content_path(root, "1.2"),
                    root / "data" / "docs-nav" / "1.2.toml",
                )

    def test_cli_version_create_apply_honors_label_status_and_set_current(self) -> None:
        """CLI apply should persist custom version metadata and update the current version."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--apply",
            "version",
            "create",
            "1.2",
            "--after",
            "1.0",
            "--label",
            "Release 1.2",
            "--status",
            "beta",
            "--set-current",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Create docs version 1.2 after 1.0 with inherited content",
            result.stdout,
        )

        versions_data = self.assert_versions_state(
            root,
            current="1.2",
            slugs=["0.9", "1.0", "1.2", "1.1", "2.0"],
        )

        new_entry = next(
            entry for entry in versions_data["versions"] if entry["slug"] == "1.2"
        )
        self.assertEqual(new_entry["label"], "Release 1.2")
        self.assertEqual(new_entry["status"], "beta")
        self.assertTrue(new_entry["visible"])
        self.assertFalse(new_entry["searchable"])
        self.assert_paths_exist(
            self.docs_content_path(root, "1.2"),
            root / "data" / "docs-nav" / "1.2.toml",
        )

    def test_cli_version_create_apply_with_latest_appends_after_declared_latest(
        self,
    ) -> None:
        """CLI apply should append a new version after the latest declared version."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.rewrite_versions_document(root, include_slugs=["0.9", "1.0", "1.1"])
        shutil.rmtree(root / "content" / "docs" / "2.0")
        (root / "data" / "docs-nav" / "2.0.toml").unlink()

        result = self.run_cli(root, "--apply", "version", "create", "1.2", "--latest")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Create docs version 1.2 after 1.1 with inherited content",
            result.stdout,
        )

        versions_data = self.assert_versions_state(
            root,
            slugs=["0.9", "1.0", "1.1", "1.2"],
        )
        new_entry = next(
            entry for entry in versions_data["versions"] if entry["slug"] == "1.2"
        )
        self.assertEqual(new_entry["label"], "1.2")
        self.assertTrue(new_entry["visible"])
        self.assertFalse(new_entry["searchable"])
        self.assert_paths_exist(
            self.docs_content_path(root, "1.2"),
            root / "data" / "docs-nav" / "1.2.toml",
        )

    def test_cli_version_create_with_latest_refuses_when_latest_content_is_missing(
        self,
    ) -> None:
        """CLI create should fail when --latest points at a declared version missing content on disk."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        shutil.rmtree(root / "content" / "docs" / "2.0")
        shutil.copy2(
            root / "data" / "docs-nav" / "1.1.toml",
            root / "data" / "docs-nav" / "2.0.toml",
        )

        result = self.run_cli(root, "version", "create", "2.1", "--latest")

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment=(
                "cannot append after latest version 2.0: content directory is missing; use --after on an existing authored version"
            ),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "2.0"),
            self.docs_content_path(root, "2.1"),
            root / "data" / "docs-nav" / "2.1.toml",
        )
        self.assert_paths_exist(root / "data" / "docs-nav" / "2.0.toml")
        self.assert_versions_state(root, slugs=["0.9", "1.0", "1.1", "2.0"])

    def test_cli_version_create_refuses_duplicate_slug(self) -> None:
        """CLI create should fail when the requested version slug already exists."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(root, "version", "create", "1.1", "--after", "1.0")

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="docs version already exists",
        )
        self.assert_versions_state(root, slugs=["0.9", "1.0", "1.1", "2.0"])

    def test_cli_version_delete_preview_json_outputs_plan_without_writing(self) -> None:
        """CLI preview should report the version delete plan without mutating the workspace."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(root, "--json", "version", "delete", "1.1")

        payload = self.assert_preview_json_payload(
            result,
            destructive=True,
            entity="version",
            operation="delete",
            metadata={"version": "1.1"},
        )
        self.assertIn(
            {
                "action": "delete_file",
                "path": "data/docs-nav/1.1.toml",
                "description": "Delete nav file for version 1.1",
                "target": None,
            },
            payload["changes"],
        )
        self.assertIn(
            {
                "action": "delete_dir",
                "path": "content/docs/1.1",
                "description": "Delete content tree for version 1.1",
                "target": None,
            },
            payload["changes"],
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1"),
            root / "data" / "docs-nav" / "1.1.toml",
        )
        self.assert_versions_state(
            root,
            current="1.0",
            slugs=["0.9", "1.0", "1.1", "2.0"],
        )

    def test_cli_version_delete_preview_json_current_delete_with_new_current(
        self,
    ) -> None:
        """CLI preview should allow deleting the current version with a valid replacement current version."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.rewrite_versions_document(root, current="1.1")

        result = self.run_cli(
            root,
            "--json",
            "version",
            "delete",
            "1.1",
            "--new-current",
            "1.0",
        )

        payload = self.assert_preview_json_payload(
            result,
            destructive=True,
            entity="version",
            operation="delete",
            metadata={"version": "1.1"},
        )
        self.assertIn(
            {
                "action": "delete_file",
                "path": "data/docs-nav/1.1.toml",
                "description": "Delete nav file for version 1.1",
                "target": None,
            },
            payload["changes"],
        )
        self.assertIn(
            {
                "action": "delete_dir",
                "path": "content/docs/1.1",
                "description": "Delete content tree for version 1.1",
                "target": None,
            },
            payload["changes"],
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1"),
            root / "data" / "docs-nav" / "1.1.toml",
        )
        self.assert_versions_state(
            root,
            current="1.1",
            slugs=["0.9", "1.0", "1.1", "2.0"],
        )

    def test_cli_version_delete_preview_json_refuses_current_without_new_current(
        self,
    ) -> None:
        """CLI preview should fail with stderr when deleting the current version without --new-current."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(root, "--json", "version", "delete", "1.0")

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="refusing to delete current version 1.0 without --new-current",
            stdout="",
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.0"),
            root / "data" / "docs-nav" / "1.0.toml",
        )
        self.assert_versions_state(root, current="1.0")

    def test_cli_version_delete_preview_json_refuses_new_current_for_non_current_delete(
        self,
    ) -> None:
        """CLI preview should fail with stderr when --new-current is supplied for a non-current delete."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--json",
            "version",
            "delete",
            "1.1",
            "--new-current",
            "0.9",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="--new-current is only valid when deleting the current version",
            stdout="",
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1"),
            root / "data" / "docs-nav" / "1.1.toml",
        )
        self.assert_versions_state(root, current="1.0")

    def test_cli_version_delete_preview_json_refuses_matching_replacement_current(
        self,
    ) -> None:
        """CLI preview should fail with stderr when --new-current matches the version being deleted."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--json",
            "version",
            "delete",
            "1.0",
            "--new-current",
            "1.0",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="--new-current must point to a different version",
            stdout="",
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.0"),
            root / "data" / "docs-nav" / "1.0.toml",
        )
        self.assert_versions_state(root, current="1.0")

    def test_cli_version_delete_preview_json_refuses_missing_replacement_current(
        self,
    ) -> None:
        """CLI preview should fail with stderr when --new-current does not exist after deletion."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--json",
            "version",
            "delete",
            "1.0",
            "--new-current",
            "9.9",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="replacement current version does not exist after deletion: 9.9",
            stdout="",
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.0"),
            root / "data" / "docs-nav" / "1.0.toml",
        )
        self.assert_versions_state(root, current="1.0")

    def test_cli_apply_delete_with_yes_prints_success_and_mutates_tree(self) -> None:
        """Apply mode should perform the delete and print the success summary."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(root, "--apply", "--yes", "version", "delete", "1.1")

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Applied: Delete docs version 1.1", result.stdout)
        self.assertFalse((root / "content" / "docs" / "1.1").exists())
        self.assertFalse((root / "data" / "docs-nav" / "1.1.toml").exists())

    def test_cli_version_delete_apply_with_new_current_updates_current(self) -> None:
        """CLI apply should allow deleting the current version when --new-current is valid."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.rewrite_versions_document(root, current="1.1")

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "version",
            "delete",
            "1.1",
            "--new-current",
            "1.0",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Applied: Delete docs version 1.1", result.stdout)
        self.assertFalse((root / "content" / "docs" / "1.1").exists())
        self.assertFalse((root / "data" / "docs-nav" / "1.1.toml").exists())
        self.assert_versions_state(root, current="1.0", slugs=["0.9", "1.0", "2.0"])

    def test_cli_version_delete_refuses_current_without_new_current(self) -> None:
        """CLI delete should fail when deleting the current version without --new-current."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(root, "version", "delete", "1.0")

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="refusing to delete current version 1.0 without --new-current",
        )
        self.assertTrue((root / "content" / "docs" / "1.0").exists())
        self.assertTrue((root / "data" / "docs-nav" / "1.0.toml").exists())
        self.assert_versions_state(root, current="1.0")

    def test_cli_version_delete_refuses_new_current_matching_deleted_version(
        self,
    ) -> None:
        """CLI delete should fail when --new-current points to the version being deleted."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "version",
            "delete",
            "1.0",
            "--new-current",
            "1.0",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="--new-current must point to a different version",
        )
        self.assertTrue((root / "content" / "docs" / "1.0").exists())
        self.assertTrue((root / "data" / "docs-nav" / "1.0.toml").exists())

    def test_cli_version_delete_refuses_missing_replacement_current(self) -> None:
        """CLI delete should fail when --new-current does not exist after deletion."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "version",
            "delete",
            "1.0",
            "--new-current",
            "9.9",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="replacement current version does not exist after deletion: 9.9",
        )
        self.assertTrue((root / "content" / "docs" / "1.0").exists())
        self.assertTrue((root / "data" / "docs-nav" / "1.0.toml").exists())

    def test_cli_version_delete_refuses_new_current_for_non_current_delete(
        self,
    ) -> None:
        """CLI delete should fail when --new-current is supplied for a non-current version."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "version",
            "delete",
            "1.1",
            "--new-current",
            "0.9",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="--new-current is only valid when deleting the current version",
        )
        self.assertTrue((root / "content" / "docs" / "1.1").exists())
        self.assertTrue((root / "data" / "docs-nav" / "1.1.toml").exists())

    def test_cli_delete_apply_without_yes_fails_in_noninteractive_mode(self) -> None:
        """Destructive apply operations should require --yes when stdin is non-interactive."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(root, "--apply", "version", "delete", "1.1")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("require --yes", result.stderr)
        self.assertTrue((root / "content" / "docs" / "1.1").exists())
        self.assertTrue((root / "data" / "docs-nav" / "1.1.toml").exists())

    def test_cli_book_create_apply_writes_nav_and_content(self) -> None:
        """CLI apply should create a book and update nav in one operation."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--apply",
            "book",
            "create",
            "--version",
            "1.1",
            "--book",
            "tutorials",
            "--title",
            "Tutorials",
            "--position",
            "end",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Create book tutorials in docs version 1.1",
            result.stdout,
        )

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(nav["books"][-1], "tutorials")
        self.assertEqual(
            self.docs_content_path(root, "1.1", "tutorials", "_index.md").read_text(
                encoding="utf-8"
            ),
            '+++\ntitle = "Tutorials"\n+++\n\n',
        )

    def test_cli_book_create_preview_json_outputs_plan_without_writing(self) -> None:
        """CLI preview should emit JSON for book creation without mutating the workspace."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--json",
            "book",
            "create",
            "--version",
            "1.1",
            "--book",
            "tutorials",
            "--title",
            "Tutorials",
            "--position",
            "end",
        )

        payload = self.assert_preview_json_payload(
            result,
            destructive=False,
            entity="book",
            operation="create",
            metadata={"book": "tutorials"},
        )
        self.assertIn(
            {
                "action": "create_dir",
                "path": "content/docs/1.1/tutorials",
                "description": "Create book directory 1.1/tutorials",
                "target": None,
            },
            payload["changes"],
        )
        self.assert_paths_missing(self.docs_content_path(root, "1.1", "tutorials"))

    def test_cli_book_create_apply_with_inherit_writes_marker(self) -> None:
        """CLI apply should create an inherited book marker when an earlier version resolves it."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        editor = self.make_editor(root)
        editor.apply_plan(
            editor.plan_book_create(
                "1.1",
                book="tutorials",
                title="Tutorials",
                position="end",
                inherit=False,
            )
        )

        result = self.run_cli(
            root,
            "--apply",
            "book",
            "create",
            "--version",
            "1.2",
            "--book",
            "tutorials",
            "--position",
            "end",
            "--inherit",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Create book tutorials in docs version 1.2",
            result.stdout,
        )

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(nav["books"][-1], "tutorials")
        self.assertEqual(
            self.docs_content_path(root, "1.2", "tutorials", "_inherit.md").read_text(
                encoding="utf-8"
            ),
            "",
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.2", "tutorials", "_index.md")
        )

    def test_cli_book_create_with_inherit_refuses_unresolved_lineage(self) -> None:
        """CLI create should fail when inherited book content has no earlier source."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "book",
            "create",
            "--version",
            "1.1",
            "--book",
            "tutorials",
            "--inherit",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment=(
                "cannot create inherited book 1.1/tutorials: no earlier version resolves to _index.md"
            ),
        )
        self.assertNotIn("tutorials", self.nav_book_slugs(root, "1.1"))
        self.assert_paths_missing(self.docs_content_path(root, "1.1", "tutorials"))

    def test_cli_book_create_refuses_missing_required_book_argument(self) -> None:
        """CLI create should fail in argparse when the book slug is omitted."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(root, "book", "create", "--version", "1.1")

        self.assert_cli_refusal(
            result,
            returncode=2,
            stderr_fragment="the following arguments are required: --book",
        )
        self.assertIn("usage: docs-editor.py book create", result.stderr)
        self.assert_paths_missing(self.docs_content_path(root, "1.1", "tutorials"))

    def test_cli_book_create_refuses_existing_book_collision(self) -> None:
        """CLI create should fail when the destination book already exists."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "book",
            "create",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--title",
            "User Guide",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="book folder already exists",
        )
        self.assert_paths_exist(self.docs_content_path(root, "1.1", "end-user"))
        self.assert_paths_missing(self.docs_content_path(root, "1.1", "user-guide"))

    def test_cli_book_create_refuses_unknown_position_anchor(self) -> None:
        """CLI create should fail when the requested book position anchor is unknown."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "book",
            "create",
            "--version",
            "1.1",
            "--book",
            "tutorials",
            "--title",
            "Tutorials",
            "--position",
            "before:missing-book",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="unknown position anchor: missing-book",
        )
        self.assert_paths_missing(self.docs_content_path(root, "1.1", "tutorials"))

    def test_cli_book_create_refuses_unsupported_position_value(self) -> None:
        """CLI create should fail when the requested book position value is unsupported."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "book",
            "create",
            "--version",
            "1.1",
            "--book",
            "tutorials",
            "--title",
            "Tutorials",
            "--position",
            "middle",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="unsupported position value: middle",
        )
        self.assertNotIn("tutorials", self.nav_book_slugs(root, "1.1"))
        self.assert_paths_missing(self.docs_content_path(root, "1.1", "tutorials"))

    def test_cli_book_create_refuses_negative_position_index(self) -> None:
        """CLI create should fail when the requested book position index is negative."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "book",
            "create",
            "--version",
            "1.1",
            "--book",
            "tutorials",
            "--title",
            "Tutorials",
            "--position",
            "-1",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="position index out of range: -1",
        )
        self.assertNotIn("tutorials", self.nav_book_slugs(root, "1.1"))
        self.assert_paths_missing(self.docs_content_path(root, "1.1", "tutorials"))

    def test_cli_book_create_refuses_out_of_range_position_index(self) -> None:
        """CLI create should fail when the requested book position index is out of range."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "book",
            "create",
            "--version",
            "1.1",
            "--book",
            "tutorials",
            "--title",
            "Tutorials",
            "--position",
            "99",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="position index out of range: 99",
        )
        self.assertNotIn("tutorials", self.nav_book_slugs(root, "1.1"))
        self.assert_paths_missing(self.docs_content_path(root, "1.1", "tutorials"))

    def test_cli_book_delete_apply_with_yes_propagates_to_inherited_descendants(
        self,
    ) -> None:
        """CLI apply should delete inherited-only descendant books as part of one operation."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "book",
            "delete",
            "--version",
            "1.1",
            "--book",
            "end-user",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Delete book end-user from docs version 1.1", result.stdout
        )

        nav_11 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertNotIn("end-user", nav_11["books"])
        self.assertNotIn("end-user", nav_12["books"])
        self.assertFalse((root / "content" / "docs" / "1.1" / "end-user").exists())
        self.assertFalse((root / "content" / "docs" / "1.2" / "end-user").exists())

    def test_cli_book_delete_preview_json_reports_propagation_metadata(self) -> None:
        """CLI preview should report propagated descendant versions for book delete."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--json",
            "book",
            "delete",
            "--version",
            "1.1",
            "--book",
            "end-user",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["result"], "preview")
        self.assertTrue(payload["destructive"])
        self.assertFalse(payload["apply"])
        self.assertEqual(payload["metadata"]["operation"], "delete")
        self.assertEqual(payload["metadata"]["entity"], "book")
        self.assertEqual(payload["metadata"]["book"], "end-user")
        self.assertEqual(payload["metadata"]["propagated_versions"], ["1.2"])
        self.assertIn(
            {
                "action": "delete_dir",
                "path": "content/docs/1.2/end-user",
                "description": "Delete inherited-only descendant book directory 1.2/end-user",
                "target": None,
            },
            payload["changes"],
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "end-user"),
            self.docs_content_path(root, "1.2", "end-user"),
        )

    def test_cli_book_delete_refuses_when_later_descendant_has_real_content(
        self,
    ) -> None:
        """CLI delete should fail before writing when a later book descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_branch_descendant(
            root,
            relative_parts=("end-user",),
            title="User Guide 1.2",
            body="This version has diverged from the inherited book landing page.",
        )

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "book",
            "delete",
            "--version",
            "1.1",
            "--book",
            "end-user",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "cannot delete book across later versions with real content", result.stderr
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "end-user"),
            self.docs_content_path(root, "1.2", "end-user"),
        )

    def test_cli_book_rename_preview_json_reports_propagation_metadata(self) -> None:
        """CLI preview should report propagated descendant versions for book rename."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--json",
            "book",
            "rename",
            "--version",
            "1.1",
            "--from",
            "end-user",
            "--to",
            "user-guide",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["result"], "preview")
        self.assertTrue(payload["destructive"])
        self.assertFalse(payload["apply"])
        self.assertEqual(payload["metadata"]["operation"], "rename")
        self.assertEqual(payload["metadata"]["entity"], "book")
        self.assertEqual(payload["metadata"]["book"], "end-user")
        self.assertEqual(payload["metadata"]["new_book"], "user-guide")
        self.assertEqual(payload["metadata"]["propagated_versions"], ["1.2"])
        self.assertIn(
            {
                "action": "rename_path",
                "path": "content/docs/1.2/end-user",
                "description": "Rename inherited-only descendant book directory 1.2/end-user to user-guide",
                "target": "content/docs/1.2/user-guide",
            },
            payload["changes"],
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "end-user"),
            self.docs_content_path(root, "1.2", "end-user"),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "user-guide"),
            self.docs_content_path(root, "1.2", "user-guide"),
        )

    def test_cli_book_rename_refuses_when_later_descendant_has_real_content(
        self,
    ) -> None:
        """CLI rename should fail before writing when a later book descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_branch_descendant(
            root,
            relative_parts=("end-user",),
            title="User Guide 1.2",
            body="This version has diverged from the inherited book landing page.",
        )

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "book",
            "rename",
            "--version",
            "1.1",
            "--from",
            "end-user",
            "--to",
            "user-guide",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "cannot rename book across later versions with real content",
            result.stderr,
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "end-user"),
            self.docs_content_path(root, "1.2", "end-user"),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "user-guide"),
            self.docs_content_path(root, "1.2", "user-guide"),
        )

    def test_cli_book_rename_preview_refuses_when_later_descendant_has_real_content(
        self,
    ) -> None:
        """CLI preview should fail when a later book descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_branch_descendant(
            root,
            relative_parts=("end-user",),
            title="User Guide 1.2",
            body="This version has diverged from the inherited book landing page.",
        )

        result = self.run_cli(
            root,
            "--json",
            "book",
            "rename",
            "--version",
            "1.1",
            "--from",
            "end-user",
            "--to",
            "user-guide",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "cannot rename book across later versions with real content",
            result.stderr,
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "end-user"),
            self.docs_content_path(root, "1.2", "end-user"),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "user-guide"),
            self.docs_content_path(root, "1.2", "user-guide"),
        )

    def test_cli_section_delete_apply_with_yes_propagates_to_inherited_descendants(
        self,
    ) -> None:
        """CLI apply should delete inherited-only descendant sections as part of one operation."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "section",
            "delete",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "configuration",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Delete section admin/configuration from docs version 1.1",
            result.stdout,
        )

        nav_11 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertNotIn("admin", nav_11.get("sections", {}))
        self.assertNotIn("admin", nav_12.get("sections", {}))
        self.assertFalse(
            (root / "content" / "docs" / "1.1" / "admin" / "configuration").exists()
        )
        self.assertFalse(
            (root / "content" / "docs" / "1.2" / "admin" / "configuration").exists()
        )

    def test_cli_section_create_apply_writes_nav_and_content(self) -> None:
        """CLI apply should create a section and update nav in one operation."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--apply",
            "section",
            "create",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "authentication",
            "--title",
            "Authentication",
            "--position",
            "end",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Create section admin/authentication in docs version 1.1",
            result.stdout,
        )

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            nav["sections"]["admin"]["items"][-1]["slug"], "authentication"
        )
        self.assertEqual(nav["pages"]["admin"]["authentication"]["items"], [])
        self.assertEqual(
            self.docs_content_path(
                root, "1.1", "admin", "authentication", "_index.md"
            ).read_text(encoding="utf-8"),
            '+++\ntitle = "Authentication"\n+++\n\n',
        )

    def test_cli_section_create_preview_json_outputs_plan_without_writing(self) -> None:
        """CLI preview should emit JSON for section creation without mutating the workspace."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--json",
            "section",
            "create",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "authentication",
            "--title",
            "Authentication",
            "--position",
            "end",
        )

        payload = self.assert_preview_json_payload(
            result,
            destructive=False,
            entity="section",
            operation="create",
            metadata={"book": "admin", "section": "authentication"},
        )
        self.assertIn(
            {
                "action": "create_dir",
                "path": "content/docs/1.1/admin/authentication",
                "description": "Create section directory 1.1/admin/authentication",
                "target": None,
            },
            payload["changes"],
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication")
        )

    def test_cli_section_create_apply_with_inherit_writes_marker(self) -> None:
        """CLI apply should create an inherited section marker when an earlier version resolves it."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        editor = self.make_editor(root)
        editor.apply_plan(
            editor.plan_section_create(
                "1.1",
                book="admin",
                section="authentication",
                title="Authentication",
                position="end",
                inherit=False,
                structural_only=False,
            )
        )

        result = self.run_cli(
            root,
            "--apply",
            "section",
            "create",
            "--version",
            "1.2",
            "--book",
            "admin",
            "--section",
            "authentication",
            "--position",
            "end",
            "--inherit",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Create section admin/authentication in docs version 1.2",
            result.stdout,
        )

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            nav["sections"]["admin"]["items"][-1]["slug"], "authentication"
        )
        self.assertEqual(nav["pages"]["admin"]["authentication"]["items"], [])
        self.assertEqual(
            self.docs_content_path(
                root, "1.2", "admin", "authentication", "_inherit.md"
            ).read_text(encoding="utf-8"),
            "",
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.2", "admin", "authentication", "_index.md")
        )

    def test_cli_section_create_with_inherit_refuses_unresolved_lineage(self) -> None:
        """CLI create should fail when inherited section content has no earlier source."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "section",
            "create",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "authentication",
            "--inherit",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment=(
                "cannot create inherited section 1.1/admin/authentication: no earlier version resolves to _index.md"
            ),
        )
        self.assertNotIn("authentication", self.nav_section_slugs(root, "1.1", "admin"))
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication")
        )

    def test_cli_section_create_refuses_missing_required_section_argument(self) -> None:
        """CLI create should fail in argparse when the section slug is omitted."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "section",
            "create",
            "--version",
            "1.1",
            "--book",
            "admin",
        )

        self.assert_cli_refusal(
            result,
            returncode=2,
            stderr_fragment="the following arguments are required: --section",
        )
        self.assertIn("usage: docs-editor.py section create", result.stderr)
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication")
        )

    def test_cli_section_create_apply_with_structural_only_keeps_tree_valid(
        self,
    ) -> None:
        """CLI apply should create a structural-only section without landing files."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--apply",
            "section",
            "create",
            "--version",
            "1.1",
            "--book",
            "developer",
            "--section",
            "testing",
            "--title",
            "Testing",
            "--position",
            "end",
            "--structural-only",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Create section developer/testing in docs version 1.1",
            result.stdout,
        )

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(nav["pages"]["developer"]["testing"]["items"], [])
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "developer", "testing")
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "developer", "testing", "_index.md"),
            self.docs_content_path(root, "1.1", "developer", "testing", "_inherit.md"),
        )

    def test_cli_section_create_refuses_inherit_with_structural_only(self) -> None:
        """CLI create should reject combining inherited and structural-only section modes."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "section",
            "create",
            "--version",
            "0.9",
            "--book",
            "website-dev-guide",
            "--section",
            "testing",
            "--inherit",
            "--structural-only",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="--inherit and --structural-only cannot be combined",
        )
        self.assertNotIn(
            "testing", self.nav_section_slugs(root, "0.9", "website-dev-guide")
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "0.9", "website-dev-guide", "testing")
        )

    def test_cli_section_create_refuses_existing_section_collision(self) -> None:
        """CLI create should fail when the destination section already exists."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "section",
            "create",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "configuration",
            "--title",
            "Configuration",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="section folder already exists",
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "admin", "configuration")
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication")
        )

    def test_cli_section_create_refuses_unknown_position_anchor(self) -> None:
        """CLI create should fail when the requested section position anchor is unknown."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "section",
            "create",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "authentication",
            "--title",
            "Authentication",
            "--position",
            "before:missing-section",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="unknown position anchor: missing-section",
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication")
        )

    def test_cli_section_create_refuses_unsupported_position_value(self) -> None:
        """CLI create should fail when the requested section position value is unsupported."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "section",
            "create",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "authentication",
            "--title",
            "Authentication",
            "--position",
            "middle",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="unsupported position value: middle",
        )
        self.assertNotIn("authentication", self.nav_section_slugs(root, "1.1", "admin"))
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication")
        )

    def test_cli_section_create_refuses_negative_position_index(self) -> None:
        """CLI create should fail when the requested section position index is negative."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "section",
            "create",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "authentication",
            "--title",
            "Authentication",
            "--position",
            "-1",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="position index out of range: -1",
        )
        self.assertNotIn("authentication", self.nav_section_slugs(root, "1.1", "admin"))
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication")
        )

    def test_cli_section_create_refuses_out_of_range_position_index(self) -> None:
        """CLI create should fail when the requested section position index is out of range."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "section",
            "create",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "authentication",
            "--title",
            "Authentication",
            "--position",
            "99",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="position index out of range: 99",
        )
        self.assertNotIn("authentication", self.nav_section_slugs(root, "1.1", "admin"))
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication")
        )

    def test_cli_section_delete_preview_json_reports_propagation_metadata(self) -> None:
        """CLI preview should report propagated descendant versions for section delete."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--json",
            "section",
            "delete",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "configuration",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["result"], "preview")
        self.assertTrue(payload["destructive"])
        self.assertFalse(payload["apply"])
        self.assertEqual(payload["metadata"]["operation"], "delete")
        self.assertEqual(payload["metadata"]["entity"], "section")
        self.assertEqual(payload["metadata"]["book"], "admin")
        self.assertEqual(payload["metadata"]["section"], "configuration")
        self.assertEqual(payload["metadata"]["propagated_versions"], ["1.2"])
        self.assertIn(
            {
                "action": "delete_dir",
                "path": "content/docs/1.2/admin/configuration",
                "description": "Delete inherited-only descendant section directory 1.2/admin/configuration",
                "target": None,
            },
            payload["changes"],
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "admin", "configuration"),
            self.docs_content_path(root, "1.2", "admin", "configuration"),
        )

    def test_cli_section_delete_refuses_when_later_descendant_has_real_content(
        self,
    ) -> None:
        """CLI delete should fail before writing when a later section descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_branch_descendant(
            root,
            relative_parts=("admin", "configuration"),
            title="Configuration 1.2",
            body="This version has diverged from the inherited section landing page.",
        )

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "section",
            "delete",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "configuration",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "cannot delete section across later versions with real content",
            result.stderr,
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "admin", "configuration"),
            self.docs_content_path(root, "1.2", "admin", "configuration"),
        )

    def test_cli_section_rename_preview_json_reports_propagation_metadata(
        self,
    ) -> None:
        """CLI preview should report propagated descendant versions for section rename."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--json",
            "section",
            "rename",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--from",
            "configuration",
            "--to",
            "authentication",
            "--title",
            "Authentication",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["result"], "preview")
        self.assertTrue(payload["destructive"])
        self.assertFalse(payload["apply"])
        self.assertEqual(payload["metadata"]["operation"], "rename")
        self.assertEqual(payload["metadata"]["entity"], "section")
        self.assertEqual(payload["metadata"]["book"], "admin")
        self.assertEqual(payload["metadata"]["section"], "configuration")
        self.assertEqual(payload["metadata"]["new_section"], "authentication")
        self.assertEqual(payload["metadata"]["propagated_versions"], ["1.2"])
        self.assertIn(
            {
                "action": "rename_path",
                "path": "content/docs/1.2/admin/configuration",
                "description": "Rename inherited-only descendant section directory 1.2/admin/configuration to authentication",
                "target": "content/docs/1.2/admin/authentication",
            },
            payload["changes"],
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "admin", "configuration"),
            self.docs_content_path(root, "1.2", "admin", "configuration"),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication"),
            self.docs_content_path(root, "1.2", "admin", "authentication"),
        )

    def test_cli_section_rename_refuses_when_later_descendant_has_real_content(
        self,
    ) -> None:
        """CLI rename should fail before writing when a later section descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_branch_descendant(
            root,
            relative_parts=("admin", "configuration"),
            title="Configuration 1.2",
            body="This version has diverged from the inherited section landing page.",
        )

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "section",
            "rename",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--from",
            "configuration",
            "--to",
            "authentication",
            "--title",
            "Authentication",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "cannot rename section across later versions with real content",
            result.stderr,
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "admin", "configuration"),
            self.docs_content_path(root, "1.2", "admin", "configuration"),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication"),
            self.docs_content_path(root, "1.2", "admin", "authentication"),
        )

    def test_cli_section_rename_preview_refuses_when_later_descendant_has_real_content(
        self,
    ) -> None:
        """CLI preview should fail when a later section descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_branch_descendant(
            root,
            relative_parts=("admin", "configuration"),
            title="Configuration 1.2",
            body="This version has diverged from the inherited section landing page.",
        )

        result = self.run_cli(
            root,
            "--json",
            "section",
            "rename",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--from",
            "configuration",
            "--to",
            "authentication",
            "--title",
            "Authentication",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "cannot rename section across later versions with real content",
            result.stderr,
        )
        self.assert_paths_exist(
            self.docs_content_path(root, "1.1", "admin", "configuration"),
            self.docs_content_path(root, "1.2", "admin", "configuration"),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "authentication"),
            self.docs_content_path(root, "1.2", "admin", "authentication"),
        )

    def test_cli_page_create_apply_writes_nav_and_content(self) -> None:
        """CLI apply should create a page and update nav in one operation."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--apply",
            "page",
            "create",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--page",
            "upgrade",
            "--title",
            "Upgrade Sambee",
            "--position",
            "end",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Create page end-user/getting-started/upgrade in docs version 1.1",
            result.stdout,
        )

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            nav["pages"]["end-user"]["getting-started"]["items"][-1], "upgrade"
        )
        self.assertEqual(
            (
                root
                / "content"
                / "docs"
                / "1.1"
                / "end-user"
                / "getting-started"
                / "upgrade"
                / "index.md"
            ).read_text(encoding="utf-8"),
            '+++\ntitle = "Upgrade Sambee"\n+++\n\n',
        )

    def test_cli_page_create_preview_json_outputs_plan_without_writing(self) -> None:
        """CLI preview should emit JSON for page creation without mutating the workspace."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--json",
            "page",
            "create",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--page",
            "upgrade",
            "--title",
            "Upgrade Sambee",
            "--position",
            "end",
        )

        payload = self.assert_preview_json_payload(
            result,
            destructive=False,
            entity="page",
            operation="create",
            metadata={
                "book": "end-user",
                "section": "getting-started",
                "page": "upgrade",
            },
        )
        self.assertIn(
            {
                "action": "create_dir",
                "path": "content/docs/1.1/end-user/getting-started/upgrade",
                "description": "Create page directory 1.1/end-user/getting-started/upgrade",
                "target": None,
            },
            payload["changes"],
        )
        self.assertFalse(
            (
                root
                / "content"
                / "docs"
                / "1.1"
                / "end-user"
                / "getting-started"
                / "upgrade"
            ).exists()
        )

    def test_cli_page_create_apply_with_inherit_writes_marker(self) -> None:
        """CLI apply should create an inherited page marker when an earlier version resolves it."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")
        editor = self.make_editor(root)
        editor.apply_plan(
            editor.plan_page_create(
                "1.1",
                book="end-user",
                section="getting-started",
                page="upgrade",
                title="Upgrade Sambee",
                position="end",
                inherit=False,
            )
        )

        result = self.run_cli(
            root,
            "--apply",
            "page",
            "create",
            "--version",
            "1.2",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--page",
            "upgrade",
            "--position",
            "end",
            "--inherit",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Create page end-user/getting-started/upgrade in docs version 1.2",
            result.stdout,
        )

        nav = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            nav["pages"]["end-user"]["getting-started"]["items"][-1], "upgrade"
        )
        self.assertEqual(
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "upgrade", "inherit.md"
            ).read_text(encoding="utf-8"),
            "",
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "upgrade", "index.md"
            )
        )

    def test_cli_page_materialize_preview_json_outputs_plan_without_writing(
        self,
    ) -> None:
        """CLI preview should emit JSON for page materialization without mutating the workspace."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--json",
            "page",
            "materialize",
            "--version",
            "1.0",
            "--book",
            "website-dev-guide",
            "--section",
            "docs-platform",
            "--page",
            "website-and-docs-architecture-overview",
        )

        payload = self.assert_preview_json_payload(
            result,
            destructive=False,
            entity="page",
            operation="materialize",
            metadata={
                "version": "1.0",
                "book": "website-dev-guide",
                "section": "docs-platform",
                "page": "website-and-docs-architecture-overview",
            },
        )
        self.assertIn(
            {
                "action": "delete_file",
                "path": "content/docs/1.0/website-dev-guide/docs-platform/website-and-docs-architecture-overview/inherit.md",
                "description": "Remove inherited page marker for 1.0/website-dev-guide/docs-platform/website-and-docs-architecture-overview",
                "target": None,
            },
            payload["changes"],
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INHERIT,
            )
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INDEX,
            )
        )

    def test_cli_page_materialize_apply_writes_real_content(self) -> None:
        """CLI apply should replace inherit.md with a real index.md for a page."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "--apply",
            "page",
            "materialize",
            "--version",
            "1.0",
            "--book",
            "website-dev-guide",
            "--section",
            "docs-platform",
            "--page",
            "website-and-docs-architecture-overview",
            "--title",
            "Website and Docs Architecture Overview for 1.0",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Materialize inherited page website-dev-guide/docs-platform/website-and-docs-architecture-overview in docs version 1.0",
            result.stdout,
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INHERIT,
            )
        )
        materialized_text = self.docs_content_path(
            root,
            "1.0",
            "website-dev-guide",
            "docs-platform",
            "website-and-docs-architecture-overview",
            DOCS_EDITOR.PAGE_INDEX,
        ).read_text(encoding="utf-8")
        self.assertIn(
            'title = "Website and Docs Architecture Overview for 1.0"',
            materialized_text,
        )

    def test_cli_page_inherit_preview_json_outputs_plan_without_writing(
        self,
    ) -> None:
        """CLI preview should emit JSON for page inheritance without mutating the workspace."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.promote_inherited_page_to_real_content(
            root,
            version="1.0",
            book="website-dev-guide",
            section="docs-platform",
            page="website-and-docs-architecture-overview",
            title="Website and Docs Architecture Overview for 1.0",
            body="Version-specific override.",
        )

        result = self.run_cli(
            root,
            "--json",
            "page",
            "inherit",
            "--version",
            "1.0",
            "--book",
            "website-dev-guide",
            "--section",
            "docs-platform",
            "--page",
            "website-and-docs-architecture-overview",
        )

        payload = self.assert_preview_json_payload(
            result,
            destructive=True,
            entity="page",
            operation="inherit",
            metadata={
                "version": "1.0",
                "book": "website-dev-guide",
                "section": "docs-platform",
                "page": "website-and-docs-architecture-overview",
            },
        )
        self.assertIn(
            {
                "action": "delete_file",
                "path": "content/docs/1.0/website-dev-guide/docs-platform/website-and-docs-architecture-overview/index.md",
                "description": "Remove real page content for 1.0/website-dev-guide/docs-platform/website-and-docs-architecture-overview",
                "target": None,
            },
            payload["changes"],
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INDEX,
            )
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INHERIT,
            )
        )

    def test_cli_page_inherit_apply_writes_inherited_marker(self) -> None:
        """CLI apply should replace index.md with inherit.md for a page."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.promote_inherited_page_to_real_content(
            root,
            version="1.0",
            book="website-dev-guide",
            section="docs-platform",
            page="website-and-docs-architecture-overview",
            title="Website and Docs Architecture Overview for 1.0",
            body="Version-specific override.",
        )

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "page",
            "inherit",
            "--version",
            "1.0",
            "--book",
            "website-dev-guide",
            "--section",
            "docs-platform",
            "--page",
            "website-and-docs-architecture-overview",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Convert page website-dev-guide/docs-platform/website-and-docs-architecture-overview to inherited content in docs version 1.0",
            result.stdout,
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INDEX,
            )
        )
        self.assertEqual(
            self.docs_content_path(
                root,
                "1.0",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
                DOCS_EDITOR.PAGE_INHERIT,
            ).read_text(encoding="utf-8"),
            "",
        )

    def test_cli_page_create_with_inherit_refuses_unresolved_lineage(self) -> None:
        """CLI create should fail when inherited page content has no earlier source."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "page",
            "create",
            "--version",
            "1.1",
            "--book",
            "admin",
            "--section",
            "configuration",
            "--page",
            "advanced",
            "--inherit",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment=(
                "cannot create inherited page 1.1/admin/configuration/advanced: no earlier version resolves to index.md"
            ),
        )
        self.assertNotIn(
            "advanced", self.nav_page_slugs(root, "1.1", "admin", "configuration")
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "admin", "configuration", "advanced")
        )

    def test_cli_page_create_refuses_missing_required_page_argument(self) -> None:
        """CLI create should fail in argparse when the page slug is omitted."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "page",
            "create",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
        )

        self.assert_cli_refusal(
            result,
            returncode=2,
            stderr_fragment="the following arguments are required: --page",
        )
        self.assertIn("usage: docs-editor.py page create", result.stderr)
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "upgrade"
            )
        )

    def test_cli_page_create_refuses_existing_page_collision(self) -> None:
        """CLI create should fail when the destination page already exists."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "page",
            "create",
            "--version",
            "0.9",
            "--book",
            "website-dev-guide",
            "--section",
            "docs-platform",
            "--page",
            "website-and-docs-architecture-overview",
            "--title",
            "Docs Editor Tool",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="page folder already exists",
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root,
                "0.9",
                "website-dev-guide",
                "docs-platform",
                "website-and-docs-architecture-overview",
            )
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root,
                "0.9",
                "website-dev-guide",
                "docs-platform",
                "docs-editor-tool-setup",
            )
        )

    def test_cli_page_create_refuses_existing_inherited_page_with_guidance(
        self,
    ) -> None:
        """CLI create should explain how to materialize a page that already exists as inherit.md."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "page",
            "create",
            "--version",
            "1.0",
            "--book",
            "website-dev-guide",
            "--section",
            "docs-platform",
            "--page",
            "website-and-docs-architecture-overview",
            "--title",
            "Website and Docs Architecture Overview",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="page already exists as an inherited marker",
        )
        self.assertIn("use page materialize instead", result.stderr)
        self.assertIn("python3 scripts/docs-editor.py page materialize", result.stderr)

    def test_cli_page_create_refuses_unknown_position_anchor(self) -> None:
        """CLI create should fail when the requested page position anchor is unknown."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "page",
            "create",
            "--version",
            "0.9",
            "--book",
            "website-dev-guide",
            "--section",
            "docs-platform",
            "--page",
            "docs-editor-quickstart",
            "--title",
            "Docs Editor Quickstart",
            "--position",
            "before:missing-page",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="unknown position anchor: missing-page",
        )
        self.assertIn("choose one of:", result.stderr)
        self.assert_paths_missing(
            self.docs_content_path(
                root,
                "0.9",
                "website-dev-guide",
                "docs-platform",
                "docs-editor-quickstart",
            )
        )

    def test_cli_page_create_refuses_unsupported_position_value(self) -> None:
        """CLI create should fail when the requested page position value is unsupported."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "page",
            "create",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--page",
            "upgrade",
            "--title",
            "Upgrade Sambee",
            "--position",
            "middle",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="unsupported position value: middle",
        )
        self.assertNotIn(
            "upgrade",
            self.nav_page_slugs(root, "1.1", "end-user", "getting-started"),
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "upgrade"
            )
        )

    def test_cli_page_create_refuses_negative_position_index(self) -> None:
        """CLI create should fail when the requested page position index is negative."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "page",
            "create",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--page",
            "upgrade",
            "--title",
            "Upgrade Sambee",
            "--position",
            "-1",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="position index out of range: -1",
        )
        self.assertNotIn(
            "upgrade",
            self.nav_page_slugs(root, "1.1", "end-user", "getting-started"),
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "upgrade"
            )
        )

    def test_cli_page_create_refuses_out_of_range_position_index(self) -> None:
        """CLI create should fail when the requested page position index is out of range."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        result = self.run_cli(
            root,
            "page",
            "create",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--page",
            "upgrade",
            "--title",
            "Upgrade Sambee",
            "--position",
            "99",
        )

        self.assert_cli_refusal(
            result,
            returncode=1,
            stderr_fragment="position index out of range: 99",
        )
        self.assertNotIn(
            "upgrade",
            self.nav_page_slugs(root, "1.1", "end-user", "getting-started"),
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "upgrade"
            )
        )

    def test_cli_page_delete_apply_with_yes_propagates_to_inherited_descendants(
        self,
    ) -> None:
        """CLI apply should delete inherited-only descendant pages as part of one operation."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "page",
            "delete",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--page",
            "install",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Delete page end-user/getting-started/install from docs version 1.1",
            result.stdout,
        )

        nav_11 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertNotIn(
            "install", nav_11["pages"]["end-user"]["getting-started"]["items"]
        )
        self.assertNotIn(
            "install", nav_12["pages"]["end-user"]["getting-started"]["items"]
        )
        self.assert_paths_missing(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "install"
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "install"
            ),
        )

    def test_cli_page_delete_preview_json_reports_propagation_metadata(self) -> None:
        """CLI preview should report propagated descendant versions for page delete."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--json",
            "page",
            "delete",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--page",
            "install",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["result"], "preview")
        self.assertTrue(payload["destructive"])
        self.assertFalse(payload["apply"])
        self.assertEqual(payload["metadata"]["operation"], "delete")
        self.assertEqual(payload["metadata"]["entity"], "page")
        self.assertEqual(payload["metadata"]["book"], "end-user")
        self.assertEqual(payload["metadata"]["section"], "getting-started")
        self.assertEqual(payload["metadata"]["page"], "install")
        self.assertEqual(payload["metadata"]["propagated_versions"], ["1.2"])
        self.assertIn(
            {
                "action": "delete_dir",
                "path": "content/docs/1.2/end-user/getting-started/install",
                "description": "Delete inherited-only descendant page directory 1.2/end-user/getting-started/install",
                "target": None,
            },
            payload["changes"],
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "install"
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "install"
            ),
        )

    def test_cli_page_delete_refuses_when_later_descendant_has_real_content(
        self,
    ) -> None:
        """CLI delete should fail before writing when a later page descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_page_descendant(
            root,
            book="end-user",
            section="getting-started",
            page="install",
            title="Install Sambee 1.2",
            body="This version has diverged from the inherited install instructions.",
        )

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "page",
            "delete",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--page",
            "install",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "cannot delete page across later versions with real content",
            result.stderr,
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "install"
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "install"
            ),
        )

    def test_cli_page_rename_preview_json_reports_propagation_metadata(self) -> None:
        """CLI preview should report propagated descendant versions for page rename."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--json",
            "page",
            "rename",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--from",
            "install",
            "--to",
            "setup",
            "--title",
            "Setup Sambee",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["result"], "preview")
        self.assertTrue(payload["destructive"])
        self.assertFalse(payload["apply"])
        self.assertEqual(payload["metadata"]["operation"], "rename")
        self.assertEqual(payload["metadata"]["entity"], "page")
        self.assertEqual(payload["metadata"]["book"], "end-user")
        self.assertEqual(payload["metadata"]["section"], "getting-started")
        self.assertEqual(payload["metadata"]["page"], "install")
        self.assertEqual(payload["metadata"]["new_page"], "setup")
        self.assertEqual(payload["metadata"]["propagated_versions"], ["1.2"])
        self.assertIn(
            {
                "action": "rename_path",
                "path": "content/docs/1.2/end-user/getting-started/install",
                "description": "Rename inherited-only descendant page directory 1.2/end-user/getting-started/install to setup",
                "target": "content/docs/1.2/end-user/getting-started/setup",
            },
            payload["changes"],
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "install"
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "install"
            ),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "end-user", "getting-started", "setup"),
            self.docs_content_path(root, "1.2", "end-user", "getting-started", "setup"),
        )

    def test_cli_page_rename_refuses_when_later_descendant_has_real_content(
        self,
    ) -> None:
        """CLI rename should fail before writing when a later page descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_page_descendant(
            root,
            book="end-user",
            section="getting-started",
            page="install",
            title="Install Sambee 1.2",
            body="This version has diverged from the inherited install instructions.",
        )

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "page",
            "rename",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--from",
            "install",
            "--to",
            "setup",
            "--title",
            "Setup Sambee",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "cannot rename page across later versions with real content",
            result.stderr,
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "install"
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "install"
            ),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "end-user", "getting-started", "setup"),
            self.docs_content_path(root, "1.2", "end-user", "getting-started", "setup"),
        )

    def test_cli_page_rename_preview_refuses_when_later_descendant_has_real_content(
        self,
    ) -> None:
        """CLI preview should fail when a later page descendant has real content."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_modified_page_descendant(
            root,
            book="end-user",
            section="getting-started",
            page="install",
            title="Install Sambee 1.2",
            body="This version has diverged from the inherited install instructions.",
        )

        result = self.run_cli(
            root,
            "--json",
            "page",
            "rename",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--from",
            "install",
            "--to",
            "setup",
            "--title",
            "Setup Sambee",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "cannot rename page across later versions with real content",
            result.stderr,
        )
        self.assert_paths_exist(
            self.docs_content_path(
                root, "1.1", "end-user", "getting-started", "install"
            ),
            self.docs_content_path(
                root, "1.2", "end-user", "getting-started", "install"
            ),
        )
        self.assert_paths_missing(
            self.docs_content_path(root, "1.1", "end-user", "getting-started", "setup"),
            self.docs_content_path(root, "1.2", "end-user", "getting-started", "setup"),
        )

    def test_cli_page_rename_apply_with_yes_propagates_to_inherited_descendants(
        self,
    ) -> None:
        """CLI apply should rename inherited-only descendant pages as part of one operation."""
        tempdir, root = self.build_temp_website()
        self.addCleanup(tempdir.cleanup)

        self.create_inherited_version(root, source_version="1.1", new_version="1.2")

        result = self.run_cli(
            root,
            "--apply",
            "--yes",
            "page",
            "rename",
            "--version",
            "1.1",
            "--book",
            "end-user",
            "--section",
            "getting-started",
            "--from",
            "install",
            "--to",
            "setup",
            "--title",
            "Setup Sambee",
        )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn(
            "Applied: Rename page end-user/getting-started/install to setup in docs version 1.1",
            result.stdout,
        )

        nav_11 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.1.toml").read_text(encoding="utf-8")
        )
        nav_12 = tomllib.loads(
            (root / "data" / "docs-nav" / "1.2.toml").read_text(encoding="utf-8")
        )
        self.assertIn("setup", nav_11["pages"]["end-user"]["getting-started"]["items"])
        self.assertIn("setup", nav_12["pages"]["end-user"]["getting-started"]["items"])
        self.assertNotIn(
            "install", nav_11["pages"]["end-user"]["getting-started"]["items"]
        )
        self.assertNotIn(
            "install", nav_12["pages"]["end-user"]["getting-started"]["items"]
        )
        self.assertTrue(
            (
                root
                / "content"
                / "docs"
                / "1.1"
                / "end-user"
                / "getting-started"
                / "setup"
                / "index.md"
            ).exists()
        )
        self.assertEqual(
            (
                root
                / "content"
                / "docs"
                / "1.2"
                / "end-user"
                / "getting-started"
                / "setup"
                / "inherit.md"
            ).read_text(encoding="utf-8"),
            "",
        )
        self.assertFalse(
            (
                root
                / "content"
                / "docs"
                / "1.1"
                / "end-user"
                / "getting-started"
                / "install"
            ).exists()
        )
        self.assertFalse(
            (
                root
                / "content"
                / "docs"
                / "1.2"
                / "end-user"
                / "getting-started"
                / "install"
            ).exists()
        )


if __name__ == "__main__":
    unittest.main()
