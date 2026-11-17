"""Small, dependency-free integration checks using the real Hugo route templates."""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
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

    def test_navigation_cache_preserves_routes_and_refreshes_during_watch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.write(
                root,
                "hugo.toml",
                """baseURL = "https://example.org/"
ignoreFiles = ["(^|/)inherit\\\\.md$", "(^|/)_inherit\\\\.md$"]
[[module.mounts]]
source = "content"
target = "content"
[[module.mounts]]
source = ".generated/content"
target = "content"
""",
            )
            for name in ["docs", "icons"]:
                shutil.copytree(
                    WEBSITE / f"themes/sambee/layouts/partials/{name}",
                    root / f"layouts/partials/{name}",
                )
            layout = """{{ $data := partial "docs/render-data.html" . }}
{{ if $data.docsContext.book }}
{{ range slice "sidebar" "drawer" }}
{{ partial "docs/nav-tree.html" (dict "page" $data.page "version" $data.docsContext.version "book" $data.docsContext.book "navData" (index (index hugo.Data "docs-nav") $data.docsContext.version) "mode" .) }}
{{ end }}
{{ $nav := partial "docs/sequential-nav-data.html" . }}
<script id="sequence">{{ dict "previous" $nav.previous "next" $nav.next | jsonify | safeJS }}</script>
<article>{{ $data.effectivePage.Title }} {{ $data.effectivePage.Content }}</article>
{{ end }}"""
            for name in ["index.html", "_default/list.html", "_default/single.html"]:
                self.write(root, f"layouts/{name}", layout)
            versions = """current = "2.0"
[[versions]]
slug = "1.0"
searchable = true
[[versions]]
slug = "2.0"
searchable = true
"""
            self.write(root, "data/docs-versions.toml", versions)
            nav = """books = ["guide"]
[[sections.guide.items]]
slug = "start"
title = "Getting Started"
[pages.guide.start]
items = ["alpha", "beta"]
"""
            for version in ["1.0", "2.0"]:
                self.write(root, f"data/docs-nav/{version}.toml", nav)
                self.write(
                    root,
                    f"content/docs/{version}/guide/_index.md",
                    '+++\ntitle="Guide"\n+++\n',
                )
                self.write(
                    root,
                    f"content/docs/{version}/guide/start/_index.md",
                    '+++\ntitle="Start"\n+++\n',
                )
                self.write(
                    root,
                    f"content/docs/{version}/guide/start/beta/index.md",
                    f'+++\ntitle="Beta {version}"\n+++\n',
                )
            alpha_source = "content/docs/1.0/guide/start/alpha/index.md"
            self.write(root, alpha_source, '+++\ntitle="Alpha"\n+++\nOriginal body\n')
            self.write(root, "content/docs/2.0/guide/start/alpha/inherit.md", "")
            materializer = load_script("materialize-inherited-docs")
            materializer.DOCS_CONTENT_DIR = root / "content/docs"
            materializer.GENERATED_CONTENT_DIR = root / ".generated/content/docs"
            materializer.DOCS_VERSIONS_FILE = root / "data/docs-versions.toml"
            materializer.main()
            stable = root / "public/docs/guide/start/alpha/index.html"
            explicit = root / "public/docs/2.0/guide/start/alpha/index.html"
            beta = root / "public/docs/guide/start/beta/index.html"

            def wait_for_text(paths: list[Path], text: str) -> None:
                deadline = time.monotonic() + COMMAND_TIMEOUT
                while time.monotonic() < deadline:
                    if all(
                        path.exists() and text in path.read_text() for path in paths
                    ):
                        return
                    if process.poll() is not None:
                        break
                    time.sleep(0.05)
                log.seek(0)
                self.fail(
                    f"Watch build did not produce {text!r} in {paths}:\n{log.read()}"
                )

            def sequence(path: Path) -> dict:
                match = re.search(
                    r'<script id="sequence">(.*?)</script>', path.read_text(), re.DOTALL
                )
                self.assertIsNotNone(match)
                assert match is not None
                return json.loads(match.group(1))

            with tempfile.TemporaryFile(mode="w+") as log:
                process = subprocess.Popen(
                    ["hugo", "--watch", "--environment", "development"],
                    cwd=root,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    text=True,
                )
                try:
                    wait_for_text([stable, explicit, beta], "Alpha")
                    for page, prefix in [(stable, "/docs/"), (explicit, "/docs/2.0/")]:
                        html = page.read_text()
                        self.assertEqual(
                            re.findall(r"docs-sidebar-link-current[^>]*>([^<]+)", html),
                            ["Alpha", "Alpha"],
                        )
                        self.assertIn('id="docs-sidebar-book-sidebar-', html)
                        self.assertIn('id="docs-sidebar-book-drawer-', html)
                        self.assertEqual(
                            sequence(page)["next"]["url"], prefix + "guide/start/beta/"
                        )
                    self.write(
                        root,
                        alpha_source,
                        '+++\ntitle="Alpha Revised"\n+++\nChanged inherited body\n',
                    )
                    wait_for_text([stable, explicit, beta], "Alpha Revised")
                    wait_for_text([stable, explicit], "Changed inherited body")
                    self.write(
                        root,
                        "data/docs-nav/2.0.toml",
                        nav.replace("Getting Started", "Revised Section").replace(
                            '["alpha", "beta"]', '["beta", "alpha"]'
                        ),
                    )
                    wait_for_text([stable, explicit, beta], "Revised Section")
                    self.assertFalse(sequence(stable)["next"])
                    self.assertEqual(
                        sequence(stable)["previous"]["url"], "/docs/guide/start/beta/"
                    )
                    self.write(
                        root,
                        "content/docs/2.0/guide/start/alpha/index.md",
                        '+++\ntitle="Alpha Override"\n+++\nOverride body\n',
                    )
                    (root / "content/docs/2.0/guide/start/alpha/inherit.md").unlink()
                    materializer.main()
                    wait_for_text([stable, explicit, beta], "Alpha Override")
                    self.write(
                        root,
                        "data/docs-versions.toml",
                        versions.replace('current = "2.0"', 'current = "1.0"'),
                    )
                    materializer.main()
                    wait_for_text([stable, beta], "Beta 1.0")
                    wait_for_text([explicit], "Alpha Override")
                    self.assertEqual(
                        sequence(explicit)["previous"]["url"],
                        "/docs/2.0/guide/start/beta/",
                    )
                finally:
                    process.terminate()
                    try:
                        process.wait(timeout=COMMAND_TIMEOUT)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=COMMAND_TIMEOUT)

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
