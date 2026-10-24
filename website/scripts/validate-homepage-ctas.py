"""Validate homepage CTA targets in built website output."""

from __future__ import annotations

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

EXTERNAL_PREFIXES = ("http://", "https://", "mailto:", "tel:")


class HomepageParser(HTMLParser):
    """Collect homepage CTA anchors and in-page ids from built HTML."""

    def __init__(self) -> None:
        super().__init__()
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

        link_name = attr_map.get("data-homepage-link", "")
        if not link_name:
            return

        if link_name in self.links:
            self.duplicates.add(link_name)
            return

        self.links[link_name] = attr_map.get("href", "")


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


def main(argv: list[str]) -> int:
    site_root = resolve_site_root(argv)
    homepage_path = site_root / "index.html"
    if not homepage_path.is_file():
        print(f"Homepage build output not found: {homepage_path}", file=sys.stderr)
        return 1

    parser = HomepageParser()
    parser.feed(homepage_path.read_text(encoding="utf-8"))

    errors: list[str] = []
    for duplicate in sorted(parser.duplicates):
        errors.append(f"Duplicate data-homepage-link value found: {duplicate}")

    missing_links = sorted(EXPECTED_LINKS - parser.links.keys())
    for link_name in missing_links:
        errors.append(f"Missing required homepage link marker: {link_name}")

    for link_name in sorted(EXPECTED_LINKS & parser.links.keys()):
        errors.extend(
            validate_href(
                link_name, parser.links[link_name], parser.anchor_ids, site_root
            )
        )

    if errors:
        print("Homepage CTA validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print(f"Validated {len(EXPECTED_LINKS)} homepage links in {site_root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
