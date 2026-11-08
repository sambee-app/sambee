"""Small, dependency-free integration checks using the real Hugo route templates."""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WEBSITE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WEBSITE / "scripts"))
HUGO_VERSION = "0.166.0"
COMMAND_TIMEOUT = 30


def load_script(name: str):
    """Load a real build script without replacing its route logic."""
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), WEBSITE / "scripts" / f"{name}.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class HugoDocsRouteTests(unittest.TestCase):
    """Check authored, inherited, structural, and stable routes across releases."""

    def run_command(self, command: list[str], root: Path) -> str:
        try:
            result = subprocess.run(
                command,
                cwd=root,
                capture_output=True,
                text=True,
                timeout=COMMAND_TIMEOUT,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            self.fail(
                f"Command {command!r} timed out: {error}\n{error.stdout or ''}\n{error.stderr or ''}"
            )
        except OSError as error:
            self.fail(f"Command {command!r} failed: {error}")
        self.assertEqual(
            result.returncode,
            0,
            f"Command {command!r}:\n{result.stdout}\n{result.stderr}",
        )
        return result.stdout

    def write(self, root: Path, path: str, content: str) -> None:
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def test_consecutive_current_versions_keep_explicit_routes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.assertIn(
                f"v{HUGO_VERSION}-",
                self.run_command(["hugo", "version"], root),
                "Use the deployment Hugo version",
            )
            self.write(
                root,
                "hugo.toml",
                """baseURL = "https://example.org/"
ignoreFiles = ["(^|/)inherit\\\\.md$", "(^|/)_inherit\\\\.md$"]
[outputs]
home = ["HTML", "DocsRoutes"]
[outputFormats.DocsRoutes]
mediaType = "application/json"
baseName = "docs-routes"
isPlainText = true
notAlternative = true
[[module.mounts]]
source = "content"
target = "content"
[[module.mounts]]
source = ".generated/content"
target = "content"
""",
            )
            shutil.copytree(
                WEBSITE / "themes/sambee/layouts/partials/docs",
                root / "layouts/partials/docs",
            )
            shutil.copy2(
                WEBSITE / "themes/sambee/layouts/index.docsroutes.json",
                root / "layouts/index.docsroutes.json",
            )
            layout = """{{ $data := partial "docs/render-data.html" . }}
{{ if $data.redirectTarget }}<a href="{{ $data.redirectTarget }}">Continue</a>
{{ else }}<h1>{{ $data.effectivePage.Title }}</h1>{{ $data.effectivePage.Content }}{{ end }}"""
            for path in [
                "layouts/index.html",
                "layouts/_default/list.html",
                "layouts/_default/single.html",
            ]:
                self.write(root, path, layout)
            self.write(root, "content/docs/_index.md", '+++\ntitle="Docs"\n+++\n')
            nav = """books = ["structural", "landing"]
[[sections.structural.items]]
slug = "group"
title = "Group"
[pages.structural.group]
items = ["article"]
[[sections.landing.items]]
slug = "section"
title = "Section"
[pages.landing.section]
items = ["inherited"]
"""
            for version in ["1.0", "2.0", "3.0"]:
                self.write(root, f"data/docs-nav/{version}.toml", nav)
                self.write(
                    root,
                    f"content/docs/{version}/_index.md",
                    f'+++\ntitle="{version}"\n+++\n',
                )
                for branch in ["landing", "landing/section"]:
                    self.write(
                        root,
                        f"content/docs/{version}/{branch}/_index.md",
                        f'+++\ntitle="Landing {version}"\n+++\n',
                    )
                self.write(
                    root,
                    f"content/docs/{version}/structural/group/article/index.md",
                    f'+++\ntitle="Article {version}"\n+++\nBody {version}\n',
                )
                inherited = f"content/docs/{version}/landing/section/inherited/"
                self.write(
                    root,
                    inherited + ("index.md" if version == "1.0" else "inherit.md"),
                    '+++\ntitle="Original"\n+++\nInherited body\n'
                    if version == "1.0"
                    else "",
                )
            materializer = load_script("materialize-inherited-docs")
            materializer.WEBSITE_DIR = root
            materializer.DOCS_CONTENT_DIR = root / "content/docs"
            materializer.GENERATED_CONTENT_DIR = root / ".generated/content/docs"
            materializer.DOCS_VERSIONS_FILE = root / "data/docs-versions.toml"
            generator = load_script("generate-managed-redirects")
            for current in ["1.0", "2.0", "3.0"]:
                with self.subTest(current=current):
                    self.write(
                        root,
                        "data/docs-versions.toml",
                        f'current="{current}"\n'
                        + "".join(
                            f'[[versions]]\nslug="{version}"\nlabel="{version}"\nsearchable=true\n'
                            for version in ["1.0", "2.0", "3.0"]
                        ),
                    )
                    materializer.main()
                    self.run_command(
                        [
                            "hugo",
                            "--environment",
                            "production",
                            "--cleanDestinationDir",
                        ],
                        root,
                    )
                    manifest = generator.load_manifest(root / "public/docs-routes.json")
                    paths = {route["path"] for route in manifest["routes"]}
                    for route in manifest["routes"]:
                        self.assertTrue(
                            (
                                root
                                / "public"
                                / route["path"].lstrip("/")
                                / "index.html"
                            ).is_file(),
                            route["path"],
                        )
                        self.assertEqual(
                            route["indexable"], route["space"] == "current"
                        )
                        self.assertEqual(
                            route["searchable"],
                            route["space"] == "current" or route["version"] != current,
                        )
                        if route["path"].endswith("/inherited/"):
                            self.assertEqual(route["sourceVersion"], "1.0")
                            self.assertIn(
                                "Inherited body",
                                (
                                    root
                                    / "public"
                                    / route["path"].lstrip("/")
                                    / "index.html"
                                ).read_text(),
                            )
                    self.assertNotIn("/docs/structural/", paths)
                    self.assertNotIn(f"/docs/{current}/structural/group/", paths)
                    stable = root / "public/docs/structural/group/article/index.html"
                    self.assertIn(f"Body {current}", stable.read_text())
                    for version in ["1.0", "2.0", "3.0"]:
                        explicit = (
                            root
                            / f"public/docs/{version}/structural/group/article/index.html"
                        )
                        self.assertIn(f"Body {version}", explicit.read_text())
                    rules = generator.complete_rules(
                        manifest, [], [], "", "example.org"
                    )
                    self.assertIn("/docs /docs/structural/group/article/ 302", rules)
                    self.assertIn(
                        "/docs/3.0/ /docs/3.0/structural/group/article/ 302", rules
                    )
                    self.assertEqual(len(rules.splitlines()) - 1, 8)
                    actual = {
                        "/" + path.parent.relative_to(root / "public").as_posix() + "/"
                        for path in (root / "public/docs").rglob("index.html")
                    }
                    self.assertEqual(
                        actual,
                        paths | {entry["source"] for entry in manifest["entries"]},
                    )
