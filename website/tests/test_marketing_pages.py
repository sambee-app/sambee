"""Built-output and CTA validation tests for standalone marketing comparison pages."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path

WEBSITE_DIR = Path(__file__).resolve().parent.parent
CTA_VALIDATOR_PATH = WEBSITE_DIR / "scripts" / "validate-homepage-ctas.py"
BUILD_TIMEOUT = 120

SEMANTIC_TYPE_UTILITIES = frozenset(
    {
        "type-section-title",
        "type-copy",
        "type-label-sm",
        "type-label-strong",
        "type-label-eyebrow",
        "type-label-eyebrow-strong",
        "type-label-xs",
        "type-list-item-label",
        "type-list-item-title",
        "type-docs-nav",
        "type-hero",
        "type-title-xl",
        "type-hero-subtitle",
        "type-title-md",
        "type-title-md-tight",
        "type-title-sm-tight",
        "type-list-index",
    }
)


def load_cta_validator():
    """Load validate-homepage-ctas.py for direct unit testing."""
    spec = importlib.util.spec_from_file_location(
        "validate_homepage_ctas", CTA_VALIDATOR_PATH
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Cannot load validate-homepage-ctas.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


CTA_VALIDATOR = load_cta_validator()


class MarketingHTMLInspector(HTMLParser):
    """Collect document metadata, JSON-LD scripts, CTA classes, and typography classes."""

    def __init__(self) -> None:
        super().__init__()
        self._in_head = False
        self._in_title = False
        self._in_json_ld = False
        self._title_parts: list[str] = []
        self._current_json_ld: list[str] = []
        self.json_ld_blocks: list[str] = []
        self.canonicals: list[str] = []
        self.pagefind_filters: list[str] = []
        self.body_ignored = False
        self.has_marketing_pagefind_body = False
        self.marketing_links: dict[str, dict[str, str]] = {}
        self.stacked_type_elements: list[tuple[str, list[str]]] = []
        self.nav_labels: dict[str, str] = {}
        self.has_marketing_code_surface = False
        self.has_highlighted_yaml = False
        self.body_images: list[str] = []
        self._inside_code_surface_depth = 0

    @property
    def title(self) -> str:
        return "".join(self._title_parts).strip()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {name: value or "" for name, value in attrs}
        classes = set(attr_map.get("class", "").split())

        matched_types = sorted(classes & SEMANTIC_TYPE_UTILITIES)
        if len(matched_types) > 1:
            self.stacked_type_elements.append((tag, matched_types))

        if tag == "head":
            self._in_head = True

        if tag == "title" and self._in_head:
            self._in_title = True

        if tag == "script" and attr_map.get("type") == "application/ld+json":
            self._in_json_ld = True
            self._current_json_ld = []

        if tag == "link" and attr_map.get("rel") == "canonical":
            self.canonicals.append(attr_map.get("href", ""))

        if tag == "meta" and "data-pagefind-filter" in attr_map:
            self.pagefind_filters.append(attr_map["data-pagefind-filter"])

        if tag == "body" and "data-pagefind-ignore" in attr_map:
            self.body_ignored = True

        if tag == "img" and not self._in_head:
            self.body_images.append(attr_map.get("src", ""))

        if "marketing-shell" in classes and "data-pagefind-body" in attr_map:
            self.has_marketing_pagefind_body = True

        if tag == "nav" and attr_map.get("class"):
            for cls in classes:
                if cls.startswith("site-footer-"):
                    self.nav_labels[cls] = attr_map.get("aria-label", "")

        if tag == "a" and attr_map.get("data-marketing-link"):
            self.marketing_links[attr_map["data-marketing-link"]] = {
                "href": attr_map.get("href", ""),
                "class": attr_map.get("class", ""),
            }

        if self._inside_code_surface_depth > 0:
            self._inside_code_surface_depth += 1
            if "highlight" in classes:
                self.has_highlighted_yaml = True
        elif "marketing-code-surface" in classes and "content" in classes:
            self.has_marketing_code_surface = True
            self._inside_code_surface_depth = 1

    def handle_endtag(self, tag: str) -> None:
        if tag == "head":
            self._in_head = False
        if tag == "title":
            self._in_title = False
        if tag == "script" and self._in_json_ld:
            self._in_json_ld = False
            self.json_ld_blocks.append("".join(self._current_json_ld).strip())
        if self._inside_code_surface_depth > 0:
            self._inside_code_surface_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)
        if self._in_json_ld:
            self._current_json_ld.append(data)


class FilestashAlternativeBuildTests(unittest.TestCase):
    """Verify the built /filestash-alternative/ page against architectural contracts."""

    _tempdir: tempfile.TemporaryDirectory[str]
    build_dir: Path
    page_html: str
    inspector: MarketingHTMLInspector

    @classmethod
    def setUpClass(cls) -> None:
        cls._tempdir = tempfile.TemporaryDirectory()
        cls.build_dir = Path(cls._tempdir.name) / "public"
        build_env = os.environ.copy()
        node_bin = WEBSITE_DIR / "node_modules" / ".bin"
        build_env["PATH"] = os.pathsep.join(
            [str(node_bin), build_env.get("PATH", "")]
        ).rstrip(os.pathsep)
        commands = [
            ["python3", "scripts/materialize-inherited-docs.py"],
            [
                "hugo",
                "--source",
                ".",
                "--environment",
                "production",
                "--destination",
                str(cls.build_dir),
                "--baseURL",
                "https://sambee.net/",
            ],
        ]
        for command in commands:
            result = subprocess.run(
                command,
                cwd=WEBSITE_DIR,
                capture_output=True,
                text=True,
                timeout=BUILD_TIMEOUT,
                check=False,
                env=build_env,
            )
            if result.returncode != 0:
                cls._tempdir.cleanup()
                raise AssertionError(
                    f"Command {command!r} failed:\n{result.stdout}\n{result.stderr}"
                )

        page_path = cls.build_dir / "filestash-alternative" / "index.html"
        if not page_path.is_file():
            cls._tempdir.cleanup()
            raise AssertionError(f"Expected built page at {page_path}")

        cls.page_html = page_path.read_text(encoding="utf-8")
        cls.inspector = MarketingHTMLInspector()
        cls.inspector.feed(cls.page_html)

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tempdir.cleanup()

    def test_title_and_canonical_metadata_have_no_duplicate_brand_suffix(self) -> None:
        self.assertEqual(
            self.inspector.title,
            "Filestash Alternative for SMB Shares & Local Drives | Sambee",
        )
        self.assertNotIn("| Sambee | Sambee", self.page_html)
        self.assertEqual(
            self.inspector.canonicals,
            ["https://sambee.net/filestash-alternative/"],
        )

    def test_sitemap_and_pagefind_indexing_include_filestash_page(self) -> None:
        self.assertFalse(self.inspector.body_ignored)
        self.assertTrue(self.inspector.has_marketing_pagefind_body)
        self.assertIn("page_kind:site", self.inspector.pagefind_filters)

        sitemap = ET.parse(self.build_dir / "sitemap.xml")
        locs = {
            element.text
            for element in sitemap.findall(
                ".//{http://www.sitemaps.org/schemas/sitemap/0.9}loc"
            )
        }
        self.assertIn("https://sambee.net/filestash-alternative/", locs)

    def test_faq_json_ld_is_valid_unquoted_schema_object(self) -> None:
        self.assertEqual(len(self.inspector.json_ld_blocks), 1)
        payload = json.loads(self.inspector.json_ld_blocks[0])
        self.assertIsInstance(payload, dict)
        self.assertEqual(payload["@context"], "https://schema.org")
        self.assertEqual(payload["@type"], "FAQPage")
        entities = payload["mainEntity"]
        self.assertEqual(len(entities), 6)
        for entity in entities:
            self.assertEqual(entity["@type"], "Question")
            self.assertTrue(entity["name"])
            answer = entity["acceptedAnswer"]
            self.assertEqual(answer["@type"], "Answer")
            self.assertTrue(answer["text"])
            self.assertIsNone(re.search(r"<[a-zA-Z][^>]*>", answer["text"]))

    def test_cta_button_variants_and_code_highlight_surface(self) -> None:
        self.assertNotIn("hero-deploy-docker", self.inspector.marketing_links)
        self.assertIn(
            "btn-outline-secondary",
            self.inspector.marketing_links["hero-jump-matrix"]["class"],
        )
        self.assertIn(
            "btn-bg-secondary",
            self.inspector.marketing_links["test-drive-deploy-guide"]["class"],
        )
        self.assertIn(
            "btn-outline-secondary",
            self.inspector.marketing_links["test-drive-github"]["class"],
        )
        self.assertTrue(self.inspector.has_marketing_code_surface)
        self.assertTrue(self.inspector.has_highlighted_yaml)
        self.assertIn("ghcr.io/sambee-app/sambee:stable", self.page_html)
        self.assertIn("marketing-band", self.page_html)
        self.assertIn("marketing-frame", self.page_html)
        self.assertEqual(self.inspector.body_images, [])
        self.assertIn("ledger-shell", self.page_html)
        self.assertNotRegex(
            self.page_html,
            r'class="marketing-matrix-text[^"]*"[^>]*>[\s\S]*?<ul>',
        )

    def test_single_semantic_type_utility_per_element_and_footer_nav(self) -> None:
        self.assertEqual(self.inspector.stacked_type_elements, [])
        self.assertEqual(
            self.inspector.nav_labels.get("site-footer-compare"), "Comparisons"
        )
        self.assertEqual(
            self.inspector.nav_labels.get("site-footer-legal"), "Legal links"
        )

    def test_cta_validator_passes_on_production_build(self) -> None:
        errors, count = CTA_VALIDATOR.validate_site_ctas(self.build_dir)
        self.assertEqual(errors, [])
        self.assertGreaterEqual(count, 13)


class MarketingCTAValidatorUnitTests(unittest.TestCase):
    """Test error reporting for broken anchors, duplicate markers, and missing pages."""

    def test_reports_missing_anchor_and_duplicate_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            site_root = Path(tempdir)
            page_dir = site_root / "filestash-alternative"
            page_dir.mkdir(parents=True)
            (page_dir / "index.html").write_text(
                """<!DOCTYPE html>
<html><body>
  <section id="fit"></section>
  <a data-marketing-link="subnav-fit" href="#fit">Fit</a>
  <a data-marketing-link="subnav-fit" href="#fit">Duplicate</a>
  <a data-marketing-link="subnav-matrix" href="#missing-section">Matrix</a>
</body></html>""",
                encoding="utf-8",
            )
            spec = CTA_VALIDATOR.PageLinkSpec(
                label="filestash-alternative",
                relative_html_path="filestash-alternative/index.html",
                marker_attribute="data-marketing-link",
                expected_links=frozenset(
                    {"subnav-fit", "subnav-matrix", "hero-deploy-docker"}
                ),
            )
            errors = CTA_VALIDATOR.validate_page_spec(site_root, spec)
            self.assertTrue(
                any("duplicate data-marketing-link" in err for err in errors),
                errors,
            )
            self.assertTrue(
                any("missing required link marker" in err for err in errors),
                errors,
            )
            self.assertTrue(
                any("missing in-page anchor #missing-section" in err for err in errors),
                errors,
            )


if __name__ == "__main__":
    unittest.main()
