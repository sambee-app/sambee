"""Check generated docs HTML and indexing against Hugo's route manifest."""

from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


class PageMetadata(HTMLParser):
    """Collect generated metadata using the standard HTML parser."""

    def __init__(self, html: str):
        super().__init__()
        self.canonicals: list[str] = []
        self.robots: list[str] = []
        self.refresh = False
        self.ignored = False
        self.search_body = False
        self.links: list[str] = []
        self.feed(html)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "a" and values.get("href"):
            self.links.append(values["href"] or "")
        if tag == "link" and values.get("rel") == "canonical":
            self.canonicals.append(values.get("href") or "")
        if tag == "meta":
            if values.get("name") == "robots":
                self.robots.append(values.get("content") or "")
            self.refresh |= (values.get("http-equiv") or "").lower() == "refresh"
        if tag == "body":
            self.ignored = "data-pagefind-ignore" in values
        self.search_body |= "data-pagefind-body" in values


def validate(destination: Path, environment: str) -> int:
    """Fail when route assets or their indexing contract differ from the manifest."""
    manifest = json.loads((destination / "docs-routes.json").read_text())
    sitemap = ET.parse(destination / "sitemap.xml")
    sitemap_paths = {
        urlparse(element.text or "").path
        for element in sitemap.findall(
            ".//{http://www.sitemaps.org/schemas/sitemap/0.9}loc"
        )
    }
    errors: list[str] = []
    expected_paths = {route["path"] for route in manifest["routes"]} | {
        entry["source"] for entry in manifest["entries"]
    }
    actual_paths = {
        "/" + path.parent.relative_to(destination).as_posix() + "/"
        for path in (destination / "docs").rglob("index.html")
    }
    if actual_paths != expected_paths:
        errors.append(
            f"Docs asset paths differ from the manifest: missing={sorted(expected_paths - actual_paths)}, extra={sorted(actual_paths - expected_paths)}"
        )
    for route in manifest["routes"] + manifest["entries"]:
        path = route.get("path", route.get("source"))
        html = (destination / path.lstrip("/") / "index.html").read_text()
        metadata = PageMetadata(html)
        is_entry = "source" in route
        if is_entry and route["target"] not in metadata.links:
            errors.append(
                f"{path}: entry fallback lacks an accessible link to {route['target']}"
            )
        indexable = route.get("indexable", False)
        if environment != "development" and (
            metadata.refresh or "window.location.replace(" in html
        ):
            errors.append(f"{path}: production or preview page forwards in the browser")
        if indexable:
            if (
                len(metadata.canonicals) != 1
                or urlparse(metadata.canonicals[0]).path != path
                or any("noindex" in robot for robot in metadata.robots)
            ):
                errors.append(
                    f"{path}: current page must be self-canonical and indexable"
                )
        elif metadata.canonicals or metadata.robots != ["noindex,follow"]:
            errors.append(
                f"{path}: explicit or entry page must have no canonical and noindex,follow"
            )
        if (path in sitemap_paths) != indexable:
            errors.append(f"{path}: sitemap inclusion differs from indexing policy")
        searchable = route.get("searchable", False) and not is_entry
        if searchable != (not metadata.ignored and metadata.search_body):
            errors.append(
                f"{path}: Pagefind body or exclusion differs from searchable state"
            )
    if not (destination / "pagefind/pagefind.js").is_file():
        errors.append("Pagefind index is missing; run the complete build")
    if errors:
        print("Docs output validation failed:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    print(
        f"Validated HTML, sitemap, and search inclusion for {len(manifest['routes'])} docs routes."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--environment", default="production")
    args = parser.parse_args()
    try:
        return validate(args.destination, args.environment)
    except (OSError, ValueError, KeyError, ET.ParseError) as error:
        print(f"Docs output validation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
