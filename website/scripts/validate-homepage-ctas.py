"""Validate homepage and marketing CTA targets in built website output."""

from __future__ import annotations

from dataclasses import dataclass
import sys
from html.parser import HTMLParser
from pathlib import Path

EXPECTED_LINKS = frozenset(
    {
        "hero-primary",
        "companion-primary",
        "deployment-primary",
        "preview-support",
    }
)

EXPECTED_FILESTASH_MARKETING_LINKS = frozenset(
    {
        "hero-jump-matrix",
        "subnav-fit",
        "subnav-matrix",
        "subnav-pillars",
        "subnav-architecture",
        "subnav-test-drive",
        "subnav-faq",
        "test-drive-deploy-guide",
        "test-drive-github",
    }
)

EXTERNAL_PREFIXES = ("http://", "https://", "mailto:", "tel:")


@dataclass(frozen=True)
class PageLinkSpec:
    """Describe one built page and the link markers it must expose."""

    label: str
    relative_html_path: str
    marker_attribute: str
    expected_links: frozenset[str]


PAGE_SPECS: tuple[PageLinkSpec, ...] = (
    PageLinkSpec(
        label="homepage",
        relative_html_path="index.html",
        marker_attribute="data-homepage-link",
        expected_links=EXPECTED_LINKS,
    ),
    PageLinkSpec(
        label="filestash-alternative",
        relative_html_path="filestash-alternative/index.html",
        marker_attribute="data-marketing-link",
        expected_links=EXPECTED_FILESTASH_MARKETING_LINKS,
    ),
)


class LinkMarkerParser(HTMLParser):
    """Collect marked CTA anchors and in-page ids from built HTML."""

    def __init__(self, marker_attribute: str = "data-homepage-link") -> None:
        super().__init__()
        self.marker_attribute = marker_attribute
        self.anchor_ids: set[str] = set()
        self.links: dict[str, str] = {}
        self.duplicates: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {name: value or "" for name, value in attrs}

        element_id = attr_map.get("id", "")
        if element_id:
            self.anchor_ids.add(element_id)

        if tag != "a":
            return

        link_name = attr_map.get(self.marker_attribute, "")
        if not link_name:
            return

        if link_name in self.links:
            self.duplicates.add(link_name)
            return

        self.links[link_name] = attr_map.get("href", "")


class HomepageParser(LinkMarkerParser):
    """Backward-compatible parser for homepage CTA markers."""

    def __init__(self) -> None:
        super().__init__(marker_attribute="data-homepage-link")


def resolve_site_root(argv: list[str]) -> Path:
    if len(argv) > 2:
        raise SystemExit("Usage: validate-homepage-ctas.py [site_root]")

    if len(argv) == 2:
        return Path(argv[1]).resolve()

    return Path(__file__).resolve().parents[1] / "public"


def page_exists(site_root: Path, href_path: str) -> bool:
    normalized = href_path.rstrip("/") or "/"
    if normalized == "/":
        return (site_root / "index.html").is_file()

    relative_path = normalized.lstrip("/")
    candidate = site_root / relative_path

    if candidate.is_file():
        return True

    if candidate.is_dir() and (candidate / "index.html").is_file():
        return True

    if not candidate.suffix and (site_root / relative_path / "index.html").is_file():
        return True

    if not candidate.suffix and (site_root / f"{relative_path}.html").is_file():
        return True

    return False


def validate_href(
    link_name: str, href: str, anchor_ids: set[str], site_root: Path
) -> list[str]:
    errors: list[str] = []

    if not href:
        return [f"{link_name}: missing href"]

    if "/docs/1.0/" in href:
        errors.append(f"{link_name}: stale versioned docs link detected: {href}")

    if href.startswith("#"):
        anchor = href.removeprefix("#")
        if anchor not in anchor_ids:
            errors.append(f"{link_name}: missing in-page anchor #{anchor}")
        return errors

    if href.startswith(EXTERNAL_PREFIXES):
        return errors

    path_only = href.split("#", 1)[0].split("?", 1)[0]
    if not path_only.startswith("/"):
        errors.append(
            f"{link_name}: expected an absolute internal link or anchor, got: {href}"
        )
        return errors

    if not page_exists(site_root, path_only):
        errors.append(f"{link_name}: built page not found for {href}")

    return errors


def validate_page_spec(site_root: Path, spec: PageLinkSpec) -> list[str]:
    """Validate all marked links on one built HTML page."""
    html_path = site_root / spec.relative_html_path
    if not html_path.is_file():
        return [f"{spec.label}: build output not found: {html_path}"]

    parser = LinkMarkerParser(marker_attribute=spec.marker_attribute)
    parser.feed(html_path.read_text(encoding="utf-8"))

    errors: list[str] = []
    for duplicate in sorted(parser.duplicates):
        errors.append(
            f"{spec.label}: duplicate {spec.marker_attribute} value found: {duplicate}"
        )

    missing_links = sorted(spec.expected_links - parser.links.keys())
    for link_name in missing_links:
        errors.append(
            f"{spec.label}: missing required link marker ({spec.marker_attribute}): {link_name}"
        )

    for link_name in sorted(parser.links.keys()):
        for href_error in validate_href(
            link_name, parser.links[link_name], parser.anchor_ids, site_root
        ):
            errors.append(f"{spec.label}: {href_error}")

    return errors


def validate_site_ctas(
    site_root: Path, specs: tuple[PageLinkSpec, ...] = PAGE_SPECS
) -> tuple[list[str], int]:
    """Validate all configured homepage and marketing page CTA specs."""
    errors: list[str] = []
    validated_count = 0
    for spec in specs:
        errors.extend(validate_page_spec(site_root, spec))
        validated_count += len(spec.expected_links)
    return errors, validated_count


def main(argv: list[str]) -> int:
    site_root = resolve_site_root(argv)
    errors, validated_count = validate_site_ctas(site_root)

    if errors:
        print("CTA validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(
        f"Validated {validated_count} homepage and marketing links across {len(PAGE_SPECS)} pages in {site_root}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
