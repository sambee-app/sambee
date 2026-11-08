"""Tests for managed redirect registry validation and output generation."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

WEBSITE_DIR = Path(__file__).resolve().parent.parent
GENERATOR_PATH = WEBSITE_DIR / "scripts" / "generate-managed-redirects.py"
sys.path.insert(0, str(WEBSITE_DIR / "scripts"))


def load_generator_module():
    """Load the managed redirect generator from the website scripts directory."""
    spec = importlib.util.spec_from_file_location(
        "generate_managed_redirects", GENERATOR_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load generate-managed-redirects.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


GENERATOR = load_generator_module()


class ManagedRedirectGeneratorTests(unittest.TestCase):
    """Exercise managed redirect registry validation and artifact generation."""

    def write_file(self, root: Path, relative_path: str, content: str) -> Path:
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def manifest(self) -> dict:
        return {
            "schemaVersion": 1,
            "current": "2.0",
            "versions": [{"slug": "1.0"}, {"slug": "2.0"}],
            "routes": [
                {
                    "path": "/docs/guide/section/page/",
                    "version": "2.0",
                    "sourceVersion": "1.0",
                    "space": "current",
                },
                {
                    "path": "/docs/1.0/guide/section/page/",
                    "version": "1.0",
                    "sourceVersion": "1.0",
                    "space": "explicit",
                },
                {
                    "path": "/docs/2.0/guide/section/page/",
                    "version": "2.0",
                    "sourceVersion": "1.0",
                    "space": "explicit",
                },
            ],
            "entries": [
                {"source": "/docs/", "target": "/docs/guide/section/page/"},
                {"source": "/docs/1.0/", "target": "/docs/1.0/guide/section/page/"},
                {"source": "/docs/2.0/", "target": "/docs/2.0/guide/section/page/"},
            ],
        }

    def test_generates_deterministic_temporary_redirect_rules(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            config_path = self.write_file(
                root,
                "data/managed-redirects.toml",
                """[[redirects]]
id = "help-oidc-setup"
source = "/mr/help-oidc-setup"
target = "/docs/guide/section/page/"

[[redirects]]
id = "release-notes"
source = "/mr/release-notes"
target = "https://example.org/releases/"
""",
            )
            legacy_path = self.write_file(
                root, "static/_redirects", "# No platform redirects\n"
            )
            output_path = root / "public/_redirects"
            self.write_file(
                root, "public/docs-routes.json", json.dumps(self.manifest())
            )
            migrations_path = self.write_file(
                root,
                "data/docs-migrations.json",
                '{"schemaVersion": 1, "migrations": []}',
            )

            redirects = GENERATOR.generate(
                config_path, legacy_path, output_path, migrations_path=migrations_path
            )

            self.assertEqual(
                [redirect.source for redirect in redirects],
                ["/mr/help-oidc-setup", "/mr/release-notes"],
            )
            self.assertEqual(
                output_path.read_text(encoding="utf-8"),
                GENERATOR.complete_rules(
                    self.manifest(), [], redirects, "", "sambee.net"
                ),
            )

    def test_rejects_duplicate_managed_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            config_path = self.write_file(
                root,
                "data/managed-redirects.toml",
                """[[redirects]]
id = "first"
source = "/mr/shared"
target = "https://sambee.net/first"

[[redirects]]
id = "second"
source = "/mr/shared"
target = "https://sambee.net/second"
""",
            )

            with self.assertRaisesRegex(GENERATOR.ManagedRedirectError, "duplicates"):
                GENERATOR.load_managed_redirects(config_path)

    def test_rejects_noncanonical_source(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            config_path = self.write_file(
                root,
                "data/managed-redirects.toml",
                """[[redirects]]
id = "invalid"
source = "/mr/invalid/"
target = "https://sambee.net/docs/"
""",
            )

            with self.assertRaisesRegex(
                GENERATOR.ManagedRedirectError, "canonical literal path"
            ):
                GENERATOR.load_managed_redirects(config_path)

    def test_rejects_noncanonical_source_segments(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            config_path = self.write_file(
                root,
                "data/managed-redirects.toml",
                """[[redirects]]
id = "invalid"
source = "/mr//invalid"
target = "https://sambee.net/docs/"
""",
            )

            with self.assertRaisesRegex(
                GENERATOR.ManagedRedirectError, "canonical literal path"
            ):
                GENERATOR.load_managed_redirects(config_path)

    def test_rejects_insecure_target(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            config_path = self.write_file(
                root,
                "data/managed-redirects.toml",
                """[[redirects]]
id = "invalid"
source = "/mr/invalid"
target = "http://sambee.net/docs/"
""",
            )

            with self.assertRaisesRegex(
                GENERATOR.ManagedRedirectError, "absolute HTTPS URL"
            ):
                GENERATOR.load_managed_redirects(config_path)

    def test_rejects_source_matched_by_legacy_redirect(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            self.write_file(
                root,
                "data/managed-redirects.toml",
                """[[redirects]]
id = "help"
source = "/mr/help"
target = "https://sambee.net/docs/"
""",
            )
            legacy_path = self.write_file(
                root, "static/_redirects", "/mr/* https://example.org/help/ 301\n"
            )

            with self.assertRaisesRegex(
                GENERATOR.ManagedRedirectError, "Ambiguous redirect overlap"
            ):
                GENERATOR.complete_rules(
                    self.manifest(),
                    [],
                    [
                        GENERATOR.ManagedRedirect(
                            "help", "/mr/help", "/docs/guide/section/page/"
                        )
                    ],
                    legacy_path.read_text(),
                    "sambee.net",
                )

    def test_scoped_chains_resolve_in_one_hop(self) -> None:
        migrations = [
            {
                "source": "guide/old/",
                "target": "guide/intermediate/",
                "scopes": ["2.0", "unversioned"],
            },
            {
                "source": "guide/intermediate/",
                "target": "guide/section/page/",
                "scopes": ["2.0", "unversioned"],
            },
        ]
        output = GENERATOR.complete_rules(
            self.manifest(), migrations, [], "", "sambee.net"
        )
        self.assertIn("/docs/2.0/guide/old /docs/2.0/guide/section/page/ 301", output)
        self.assertIn("/docs/guide/old/ /docs/guide/section/page/ 302", output)
        self.assertNotIn("/docs/1.0/guide/old", output)

    def test_rejects_route_override_and_missing_target(self) -> None:
        for source, target, message in [
            ("guide/section/page/", "guide/missing/", "overrides"),
            ("guide/old/", "guide/missing/", "Missing final"),
        ]:
            with (
                self.subTest(source=source),
                self.assertRaisesRegex(ValueError, message),
            ):
                GENERATOR.complete_rules(
                    self.manifest(),
                    [{"source": source, "target": target, "scopes": ["2.0"]}],
                    [],
                    "",
                    "sambee.net",
                )

    def test_rejects_loop(self) -> None:
        with self.assertRaisesRegex(ValueError, "loop"):
            GENERATOR.complete_rules(
                self.manifest(),
                [{"source": "guide/old/", "target": "guide/old/", "scopes": ["2.0"]}],
                [],
                "",
                "sambee.net",
            )

    def test_unversioned_source_reuse_omits_alias(self) -> None:
        output = GENERATOR.complete_rules(
            self.manifest(),
            [
                {
                    "source": "guide/section/page/",
                    "target": "guide/missing/",
                    "scopes": ["unversioned"],
                }
            ],
            [],
            "",
            "sambee.net",
        )
        self.assertNotIn("/docs/guide/section/page/ /", output)

    def test_managed_target_must_be_final_relative_or_external(self) -> None:
        migrations = [
            {
                "source": "guide/old/",
                "target": "guide/section/page/",
                "scopes": ["unversioned"],
            }
        ]
        for target, message in [
            ("https://sambee.net/docs/guide/section/page/", "site-relative"),
            ("/docs/guide/old/", "update the registry to /docs/guide/section/page/"),
            ("/docs/missing/", "missing target"),
        ]:
            with (
                self.subTest(target=target),
                self.assertRaisesRegex(ValueError, message),
            ):
                GENERATOR.complete_rules(
                    self.manifest(),
                    migrations,
                    [GENERATOR.ManagedRedirect("help", "/mr/help", target)],
                    "",
                    "sambee.net",
                )

    def test_transition_requires_replacement_or_gone(self) -> None:
        manifest = self.manifest()
        manifest["routes"].append(
            {
                "path": "/docs/1.0/guide/removed/",
                "version": "1.0",
                "sourceVersion": "1.0",
                "space": "explicit",
            }
        )
        with self.assertRaisesRegex(ValueError, "needs a replacement or gone"):
            GENERATOR.complete_rules(manifest, [], [], "", "sambee.net")
        for target in [None, "guide/section/page/"]:
            with self.subTest(target=target):
                output = GENERATOR.complete_rules(
                    manifest,
                    [
                        {
                            "source": "guide/removed/",
                            "target": target,
                            "scopes": ["unversioned"],
                        }
                    ],
                    [],
                    "",
                    "sambee.net",
                )
                self.assertEqual("/docs/guide/removed " in output, target is not None)

    def test_preview_alias_activates_only_after_current_version_changes(self) -> None:
        manifest = self.manifest()
        manifest["versions"].append({"slug": "3.0"})
        manifest["entries"].append(
            {"source": "/docs/3.0/", "target": "/docs/3.0/guide/section/page/"}
        )
        for location in ["guide/section/page/", "guide/setup/"]:
            manifest["routes"].append(
                {
                    "path": "/docs/3.0/" + location,
                    "version": "3.0",
                    "sourceVersion": "3.0",
                    "space": "explicit",
                }
            )
        migrations = [
            {"source": "guide/install/", "target": "guide/setup/", "scopes": ["3.0"]}
        ]
        output = GENERATOR.complete_rules(manifest, migrations, [], "", "sambee.net")
        self.assertIn("/docs/3.0/guide/install /docs/3.0/guide/setup/ 301", output)
        self.assertNotIn("/docs/guide/install", output)
        manifest["current"] = "3.0"
        for route in manifest["routes"]:
            if route["space"] == "current":
                route["version"] = "3.0"
        manifest["routes"].append(
            {
                "path": "/docs/guide/setup/",
                "version": "3.0",
                "sourceVersion": "3.0",
                "space": "current",
            }
        )
        output = GENERATOR.complete_rules(manifest, migrations, [], "", "sambee.net")
        self.assertIn("/docs/guide/install /docs/guide/setup/ 302", output)
        self.assertIn("/docs/guide/install/ /docs/guide/setup/ 302", output)
        self.assertEqual(migrations[0]["scopes"], ["3.0"])

    def test_current_alias_supplies_transition_without_unversioned_record(self) -> None:
        manifest = self.manifest()
        manifest["routes"].append(
            {
                "path": "/docs/1.0/guide/removed/",
                "version": "1.0",
                "sourceVersion": "1.0",
                "space": "explicit",
            }
        )
        migrations = [
            {
                "source": "guide/removed/",
                "target": "guide/section/page/",
                "scopes": ["2.0"],
            }
        ]
        output = GENERATOR.complete_rules(manifest, migrations, [], "", "sambee.net")
        self.assertIn("/docs/guide/removed /docs/guide/section/page/ 302", output)
        migrations.append(
            {"source": "guide/removed/", "target": None, "scopes": ["unversioned"]}
        )
        output = GENERATOR.complete_rules(manifest, migrations, [], "", "sambee.net")
        self.assertNotIn("/docs/guide/removed ", output)
        self.assertIn(
            "/docs/2.0/guide/removed /docs/2.0/guide/section/page/ 301", output
        )

    def test_platform_limits_and_length(self) -> None:
        with self.assertRaisesRegex(ValueError, "limits exceeded"):
            GENERATOR.complete_rules(
                self.manifest(),
                [],
                [],
                "\n".join(
                    f"/old-{index} https://example.org/new 302"
                    for index in range(GENERATOR.STATIC_LIMIT)
                ),
                "sambee.net",
            )
        with self.assertRaisesRegex(ValueError, "length exceeded"):
            GENERATOR.complete_rules(
                self.manifest(),
                [],
                [],
                "/"
                + "long" * GENERATOR.RULE_LENGTH_LIMIT
                + " https://example.org/new 302",
                "sambee.net",
            )

    def test_failed_generation_preserves_existing_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            config = self.write_file(
                root,
                "managed.toml",
                '[[redirects]]\nid="help"\nsource="/mr/help"\ntarget="/docs/missing/"\n',
            )
            platform = self.write_file(root, "platform.txt", "")
            output = self.write_file(
                root, "public/_redirects", "previous valid rules\n"
            )
            self.write_file(
                root, "public/docs-routes.json", json.dumps(self.manifest())
            )
            registry = self.write_file(
                root, "migrations.json", '{"schemaVersion":1,"migrations":[]}'
            )
            with self.assertRaisesRegex(ValueError, "missing target"):
                GENERATOR.generate(config, platform, output, migrations_path=registry)
            self.assertEqual(output.read_text(), "previous valid rules\n")

    def test_dynamic_budget_and_symbolic_overlaps(self) -> None:
        with self.assertRaisesRegex(ValueError, "limits exceeded"):
            GENERATOR.complete_rules(
                self.manifest(),
                [],
                [],
                "\n".join(
                    f"/group-{index}/:item https://example.org/final 302"
                    for index in range(GENERATOR.DYNAMIC_LIMIT + 1)
                ),
                "sambee.net",
            )
        with self.assertRaisesRegex(ValueError, "Ambiguous redirect overlap"):
            GENERATOR.complete_rules(
                self.manifest(),
                [],
                [],
                "/other/:item/final https://example.org/final 302\n/other/fixed/:tail https://example.org/final 302",
                "sambee.net",
            )

    def test_platform_rules_cannot_override_assets_or_point_to_missing_pages(
        self,
    ) -> None:
        manifest = self.manifest()
        manifest["siteRoutes"] = ["/features/"]
        for platform, message in [
            ("/features* https://example.org/final 302", "overrides an HTTP 200 page"),
            ("/shortcut /missing/ 302", "Missing final page"),
        ]:
            with (
                self.subTest(platform=platform),
                self.assertRaisesRegex(ValueError, message),
            ):
                GENERATOR.complete_rules(manifest, [], [], platform, "sambee.net")
        result = GENERATOR.complete_rules(
            manifest,
            [],
            [GENERATOR.ManagedRedirect("feature", "/mr/feature", "/features/")],
            "",
            "sambee.net",
        )
        self.assertIn("/mr/feature /features/ 302", result)

    def test_registry_rejects_invalid_locations_and_duplicate_scopes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            for entry in [
                {"source": "guide/old/", "scopes": ["2.0"]},
                {"source": "../outside/", "target": "guide/page/", "scopes": ["2.0"]},
                {
                    "source": "guide/old/",
                    "target": "guide/page/",
                    "scopes": ["2.0", "2.0"],
                },
            ]:
                registry = self.write_file(
                    root,
                    "registry.json",
                    json.dumps({"schemaVersion": 1, "migrations": [entry]}),
                )
                with self.subTest(entry=entry), self.assertRaises(ValueError):
                    GENERATOR.load_registry(registry)
