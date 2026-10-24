"""Validate website docs navigation, content bundles, and inheritance markers."""

from __future__ import annotations

import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

WEBSITE_DIR = Path(__file__).resolve().parent.parent
DOCS_CONTENT_DIR = WEBSITE_DIR / "content" / "docs"
DOCS_NAV_DIR = WEBSITE_DIR / "data" / "docs-nav"
DOCS_VERSIONS_FILE = WEBSITE_DIR / "data" / "docs-versions.toml"

INDEX_FILE = "index.md"
INHERIT_FILE = "inherit.md"
BRANCH_INDEX_FILE = "_index.md"
BRANCH_INHERIT_FILE = "_inherit.md"
README_NAV_FILE = "README.toml"

LEGACY_FRONT_MATTER_KEYS = ("doc_id", "product_version")
DISALLOWED_FRONT_MATTER_KEYS = ("aliases",)


@dataclass(frozen=True)
class DocsIssue:
    """A validation issue with an actionable path-oriented message."""

    path: Path
    message: str

    def format(self) -> str:
        """Return a concise, workspace-relative issue string."""
        try:
            relative_path = self.path.relative_to(WEBSITE_DIR)
        except ValueError:
            relative_path = self.path
        return f"{relative_path}: {self.message}"


@dataclass(frozen=True)
class SectionEntry:
    """Navigation section metadata."""

    slug: str
    title: str


@dataclass(frozen=True)
class NavData:
    """Parsed docs navigation data for one version."""

    version: str
    path: Path
    books: list[str]
    sections: dict[str, list[SectionEntry]]
    pages: dict[str, dict[str, list[str]]]


@dataclass(frozen=True)
class VersionMetadata:
    """Parsed docs version metadata from docs-versions.toml."""

    current: str
    slugs: list[str]


def load_toml(path: Path) -> dict[str, Any]:
    """Load TOML data from ``path``."""
    with path.open("rb") as file:
        return tomllib.load(file)


def load_version_metadata() -> tuple[VersionMetadata | None, list[DocsIssue]]:
    """Return canonical docs version metadata and validation issues."""
    issues: list[DocsIssue] = []

    if not DOCS_VERSIONS_FILE.exists():
        return None, [DocsIssue(DOCS_VERSIONS_FILE, "docs versions file is missing")]

    data = load_toml(DOCS_VERSIONS_FILE)
    versions = data.get("versions", [])
    current = data.get("current")
    version_slugs: list[str] = []

    if not isinstance(versions, list):
        return None, [DocsIssue(DOCS_VERSIONS_FILE, "versions must be an array")]

    if not isinstance(current, str) or not current.strip():
        issues.append(
            DocsIssue(DOCS_VERSIONS_FILE, "current must be a non-empty string")
        )

    for index, entry in enumerate(versions):
        if not isinstance(entry, dict):
            issues.append(
                DocsIssue(DOCS_VERSIONS_FILE, f"versions[{index}] must be a table")
            )
            continue

        slug = entry.get("slug")
        if not isinstance(slug, str) or not slug.strip():
            issues.append(
                DocsIssue(DOCS_VERSIONS_FILE, f"versions[{index}].slug is required")
            )
            continue

        version_slugs.append(slug)

    issues.extend(find_duplicates(DOCS_VERSIONS_FILE, "version slug", version_slugs))

    if isinstance(current, str) and current.strip() and current not in version_slugs:
        issues.append(
            DocsIssue(
                DOCS_VERSIONS_FILE,
                f"current references undeclared version slug: {current}",
            )
        )

    if issues:
        return None, issues

    return VersionMetadata(current=current, slugs=version_slugs), issues


def load_version_order() -> tuple[list[str], list[DocsIssue]]:
    """Return canonical docs versions in release order."""
    metadata, issues = load_version_metadata()
    if metadata is None:
        return [], issues
    return metadata.slugs, issues


def parse_nav_file(path: Path) -> tuple[NavData | None, list[DocsIssue]]:
    """Parse and validate one docs navigation TOML file."""
    issues: list[DocsIssue] = []
    version = path.stem
    data = load_toml(path)

    raw_books = data.get("books")
    books: list[str] = []
    if isinstance(raw_books, list):
        for index, value in enumerate(raw_books):
            if isinstance(value, str) and value.strip():
                books.append(value)
            else:
                issues.append(
                    DocsIssue(path, f"books[{index}] must be a non-empty string")
                )
    else:
        issues.append(DocsIssue(path, "books must be a required array of strings"))

    issues.extend(find_duplicates(path, "book slug", books))

    sections: dict[str, list[SectionEntry]] = {}
    raw_sections = data.get("sections", {})
    if raw_sections and not isinstance(raw_sections, dict):
        issues.append(DocsIssue(path, "sections must be a table keyed by book slug"))
    elif isinstance(raw_sections, dict):
        for book_slug, section_table in raw_sections.items():
            if not isinstance(section_table, dict):
                issues.append(DocsIssue(path, f"sections.{book_slug} must be a table"))
                continue

            raw_items = section_table.get("items", [])
            if not isinstance(raw_items, list):
                issues.append(
                    DocsIssue(
                        path, f"sections.{book_slug}.items must be an array of tables"
                    )
                )
                continue

            parsed_items: list[SectionEntry] = []
            for index, item in enumerate(raw_items):
                if not isinstance(item, dict):
                    issues.append(
                        DocsIssue(
                            path, f"sections.{book_slug}.items[{index}] must be a table"
                        )
                    )
                    continue

                slug = item.get("slug")
                title = item.get("title")
                if not isinstance(slug, str) or not slug.strip():
                    issues.append(
                        DocsIssue(
                            path,
                            f"sections.{book_slug}.items[{index}].slug must be a non-empty string",
                        )
                    )
                    continue
                if not isinstance(title, str) or not title.strip():
                    issues.append(
                        DocsIssue(
                            path,
                            f"sections.{book_slug}.items[{index}].title must be a non-empty string",
                        )
                    )
                    continue

                parsed_items.append(SectionEntry(slug=slug, title=title))

            issues.extend(
                find_duplicates(
                    path,
                    f"section slug under {book_slug}",
                    [item.slug for item in parsed_items],
                )
            )
            sections[book_slug] = parsed_items

    pages: dict[str, dict[str, list[str]]] = {}
    raw_pages = data.get("pages", {})
    if raw_pages and not isinstance(raw_pages, dict):
        issues.append(
            DocsIssue(path, "pages must be a table keyed by book and section slug")
        )
    elif isinstance(raw_pages, dict):
        for book_slug, book_pages in raw_pages.items():
            if not isinstance(book_pages, dict):
                issues.append(DocsIssue(path, f"pages.{book_slug} must be a table"))
                continue

            pages[book_slug] = {}
            for section_slug, section_pages in book_pages.items():
                if not isinstance(section_pages, dict):
                    issues.append(
                        DocsIssue(
                            path, f"pages.{book_slug}.{section_slug} must be a table"
                        )
                    )
                    continue

                raw_items = section_pages.get("items", [])
                page_slugs: list[str] = []
                if isinstance(raw_items, list):
                    for index, value in enumerate(raw_items):
                        if isinstance(value, str) and value.strip():
                            page_slugs.append(value)
                        else:
                            issues.append(
                                DocsIssue(
                                    path,
                                    f"pages.{book_slug}.{section_slug}.items[{index}] must be a non-empty string",
                                )
                            )
                else:
                    issues.append(
                        DocsIssue(
                            path,
                            f"pages.{book_slug}.{section_slug}.items must be an array",
                        )
                    )

                issues.extend(
                    find_duplicates(
                        path,
                        f"page slug under {book_slug}/{section_slug}",
                        page_slugs,
                    )
                )
                pages[book_slug][section_slug] = page_slugs

    if issues:
        return None, issues

    return NavData(
        version=version, path=path, books=books, sections=sections, pages=pages
    ), issues


def find_duplicates(path: Path, label: str, values: list[str]) -> list[DocsIssue]:
    """Return issues for duplicated string values."""
    issues: list[DocsIssue] = []
    seen: set[str] = set()
    duplicates: set[str] = set()

    for value in values:
        if value in seen:
            duplicates.add(value)
        seen.add(value)

    for duplicate in sorted(duplicates):
        issues.append(DocsIssue(path, f"duplicate {label}: {duplicate}"))

    return issues


def validate_branch_bundle(path: Path, required: bool) -> list[DocsIssue]:
    """Validate `_index.md` and `_inherit.md` branch-bundle marker rules."""
    issues: list[DocsIssue] = []
    has_index = (path / BRANCH_INDEX_FILE).exists()
    has_inherit = (path / BRANCH_INHERIT_FILE).exists()

    if has_index and has_inherit:
        issues.append(
            DocsIssue(
                path,
                f"must not contain both {BRANCH_INDEX_FILE} and {BRANCH_INHERIT_FILE}",
            )
        )
    elif required and not has_index and not has_inherit:
        issues.append(
            DocsIssue(
                path,
                f"must contain either {BRANCH_INDEX_FILE} or {BRANCH_INHERIT_FILE}",
            )
        )

    if has_inherit:
        issues.extend(validate_empty_marker(path / BRANCH_INHERIT_FILE))

    return issues


def validate_page_bundle(path: Path) -> list[DocsIssue]:
    """Validate `index.md` and `inherit.md` page-bundle marker rules."""
    issues: list[DocsIssue] = []
    has_index = (path / INDEX_FILE).exists()
    has_inherit = (path / INHERIT_FILE).exists()

    if has_index and has_inherit:
        issues.append(
            DocsIssue(path, f"must not contain both {INDEX_FILE} and {INHERIT_FILE}")
        )
    elif not has_index and not has_inherit:
        issues.append(
            DocsIssue(path, f"must contain either {INDEX_FILE} or {INHERIT_FILE}")
        )

    if has_inherit:
        issues.extend(validate_empty_marker(path / INHERIT_FILE))

    return issues


def validate_empty_marker(path: Path) -> list[DocsIssue]:
    """Validate that inheritance marker files are empty."""
    if path.read_text(encoding="utf-8").strip():
        return [
            DocsIssue(
                path, "inheritance marker must be empty and contain no front matter"
            )
        ]
    return []


def validate_legacy_front_matter() -> list[DocsIssue]:
    """Reject front matter keys that are no longer part of docs identity."""
    issues: list[DocsIssue] = []
    markdown_files = sorted(DOCS_CONTENT_DIR.rglob("*.md"))

    for path in markdown_files:
        text = path.read_text(encoding="utf-8")
        for key in LEGACY_FRONT_MATTER_KEYS:
            if f"{key} =" in text or f"{key}:" in text:
                issues.append(
                    DocsIssue(
                        path,
                        f"remove legacy `{key}` metadata; identity comes from the path",
                    )
                )

        for key in DISALLOWED_FRONT_MATTER_KEYS:
            if f"{key} =" in text or f"{key}:" in text:
                issues.append(
                    DocsIssue(
                        path,
                        f"remove `{key}` from docs content; docs paths must map to exactly one public URL",
                    )
                )

    return issues


def validate_nav_hierarchy(nav_data: NavData) -> list[DocsIssue]:
    """Validate that nav sections/pages only reference declared parent nodes."""
    issues: list[DocsIssue] = []
    declared_books = set(nav_data.books)

    for book_slug in sorted(nav_data.sections):
        if book_slug not in declared_books:
            issues.append(
                DocsIssue(
                    nav_data.path,
                    f"sections table references undeclared book slug: {book_slug}",
                )
            )

    for book_slug, section_pages in sorted(nav_data.pages.items()):
        if book_slug not in declared_books:
            issues.append(
                DocsIssue(
                    nav_data.path,
                    f"pages table references undeclared book slug: {book_slug}",
                )
            )
            continue

        declared_sections = {
            entry.slug for entry in nav_data.sections.get(book_slug, [])
        }
        for section_slug in sorted(section_pages):
            if section_slug not in declared_sections:
                issues.append(
                    DocsIssue(
                        nav_data.path,
                        f"pages table references undeclared section slug under {book_slug}: {section_slug}",
                    )
                )

    return issues


def resolve_page_inheritance(
    version_order: list[str], version: str, relative_parts: tuple[str, ...]
) -> bool:
    """Return true when a page inheritance chain resolves to a real index page."""
    try:
        start_index = version_order.index(version)
    except ValueError:
        return False

    for candidate_version in reversed(version_order[: start_index + 1]):
        candidate = DOCS_CONTENT_DIR / candidate_version / Path(*relative_parts)
        if (candidate / INDEX_FILE).exists():
            return True
        if (candidate / INHERIT_FILE).exists():
            continue
        return False

    return False


def resolve_branch_inheritance(
    version_order: list[str], version: str, relative_parts: tuple[str, ...]
) -> bool:
    """Return true when a branch inheritance chain resolves to a real `_index.md`."""
    try:
        start_index = version_order.index(version)
    except ValueError:
        return False

    for candidate_version in reversed(version_order[: start_index + 1]):
        candidate = DOCS_CONTENT_DIR / candidate_version / Path(*relative_parts)
        if (candidate / BRANCH_INDEX_FILE).exists():
            return True
        if (candidate / BRANCH_INHERIT_FILE).exists():
            continue
        return False

    return False


def validate_nav_content(
    nav_data: NavData, version_order: list[str]
) -> list[DocsIssue]:
    """Validate one nav file against the matching docs content tree."""
    issues: list[DocsIssue] = []
    version_dir = DOCS_CONTENT_DIR / nav_data.version

    if nav_data.version not in version_order:
        issues.append(
            DocsIssue(
                nav_data.path, "nav filename must match a declared docs version slug"
            )
        )

    issues.extend(validate_nav_hierarchy(nav_data))

    if not version_dir.exists():
        return [
            DocsIssue(version_dir, "version folder referenced by nav file is missing")
        ]

    issues.extend(validate_branch_bundle(version_dir, required=True))
    if (version_dir / BRANCH_INHERIT_FILE).exists() and not resolve_branch_inheritance(
        version_order, nav_data.version, tuple()
    ):
        issues.append(
            DocsIssue(
                version_dir,
                "version landing inheritance does not resolve to `_index.md`",
            )
        )

    for book_slug in nav_data.books:
        book_dir = version_dir / book_slug
        if not book_dir.exists():
            issues.append(DocsIssue(book_dir, "book folder listed in nav is missing"))
            continue

        issues.extend(validate_branch_bundle(book_dir, required=False))
        if (book_dir / BRANCH_INHERIT_FILE).exists() and not resolve_branch_inheritance(
            version_order, nav_data.version, (book_slug,)
        ):
            issues.append(
                DocsIssue(book_dir, "book inheritance does not resolve to `_index.md`")
            )

        for section in nav_data.sections.get(book_slug, []):
            section_dir = book_dir / section.slug
            if not section_dir.exists():
                issues.append(
                    DocsIssue(section_dir, "section folder listed in nav is missing")
                )
                continue

            issues.extend(validate_branch_bundle(section_dir, required=False))
            if (
                section_dir / BRANCH_INHERIT_FILE
            ).exists() and not resolve_branch_inheritance(
                version_order, nav_data.version, (book_slug, section.slug)
            ):
                issues.append(
                    DocsIssue(
                        section_dir,
                        "section inheritance does not resolve to `_index.md`",
                    )
                )

            for page_slug in nav_data.pages.get(book_slug, {}).get(section.slug, []):
                page_dir = section_dir / page_slug
                if not page_dir.exists():
                    issues.append(
                        DocsIssue(page_dir, "page folder listed in nav is missing")
                    )
                    continue

                issues.extend(validate_page_bundle(page_dir))
                if (page_dir / INHERIT_FILE).exists() and not resolve_page_inheritance(
                    version_order,
                    nav_data.version,
                    (book_slug, section.slug, page_slug),
                ):
                    issues.append(
                        DocsIssue(
                            page_dir, "page inheritance does not resolve to `index.md`"
                        )
                    )

    return issues


def child_dirs(path: Path) -> list[Path]:
    """Return sorted direct child directories."""
    if not path.exists():
        return []
    return sorted(child for child in path.iterdir() if child.is_dir())


def child_files(path: Path) -> list[Path]:
    """Return sorted direct child files."""
    if not path.exists():
        return []
    return sorted(child for child in path.iterdir() if child.is_file())


def validate_expected_bundle_files(
    path: Path,
    *,
    allowed_names: set[str],
    label: str,
) -> list[DocsIssue]:
    """Reject unexpected direct files inside one docs bundle directory."""
    issues: list[DocsIssue] = []
    for file_path in child_files(path):
        if file_path.name not in allowed_names:
            issues.append(
                DocsIssue(path, f"unexpected file in {label}: {file_path.name}")
            )
    return issues


def validate_version_tree(nav_data: NavData) -> list[DocsIssue]:
    """Validate that the docs filesystem contains no orphan content for one version."""
    issues: list[DocsIssue] = []
    version_dir = DOCS_CONTENT_DIR / nav_data.version
    declared_books = set(nav_data.books)

    issues.extend(
        validate_expected_bundle_files(
            version_dir,
            allowed_names={BRANCH_INDEX_FILE, BRANCH_INHERIT_FILE},
            label=f"version bundle {nav_data.version}",
        )
    )

    for book_dir in child_dirs(version_dir):
        if book_dir.name not in declared_books:
            issues.append(
                DocsIssue(
                    book_dir, "book folder exists on disk but is not listed in nav"
                )
            )
            continue

        issues.extend(
            validate_expected_bundle_files(
                book_dir,
                allowed_names={BRANCH_INDEX_FILE, BRANCH_INHERIT_FILE},
                label=f"book bundle {nav_data.version}/{book_dir.name}",
            )
        )

        declared_sections = {
            entry.slug for entry in nav_data.sections.get(book_dir.name, [])
        }
        for section_dir in child_dirs(book_dir):
            if section_dir.name not in declared_sections:
                issues.append(
                    DocsIssue(
                        section_dir,
                        "section folder exists on disk but is not listed in nav",
                    )
                )
                continue

            issues.extend(
                validate_expected_bundle_files(
                    section_dir,
                    allowed_names={BRANCH_INDEX_FILE, BRANCH_INHERIT_FILE},
                    label=(
                        f"section bundle {nav_data.version}/{book_dir.name}/{section_dir.name}"
                    ),
                )
            )

            declared_pages = set(
                nav_data.pages.get(book_dir.name, {}).get(section_dir.name, [])
            )
            for page_dir in child_dirs(section_dir):
                if page_dir.name not in declared_pages:
                    issues.append(
                        DocsIssue(
                            page_dir,
                            "page folder exists on disk but is not listed in nav",
                        )
                    )
                    continue

                issues.extend(
                    validate_expected_bundle_files(
                        page_dir,
                        allowed_names={INDEX_FILE, INHERIT_FILE},
                        label=(
                            f"page bundle {nav_data.version}/{book_dir.name}/{section_dir.name}/{page_dir.name}"
                        ),
                    )
                )

    return issues


def validate_declared_versions(
    version_order: list[str],
    nav_versions: set[str],
    content_versions: set[str],
) -> list[DocsIssue]:
    """Validate declared versions against nav files and content directories."""
    issues: list[DocsIssue] = []

    for version in version_order:
        nav_path = DOCS_NAV_DIR / f"{version}.toml"
        version_dir = DOCS_CONTENT_DIR / version
        if version not in nav_versions:
            issues.append(
                DocsIssue(nav_path, "declared docs version is missing its nav file")
            )
        if version not in content_versions:
            issues.append(
                DocsIssue(
                    version_dir,
                    "declared docs version is missing its content directory",
                )
            )

    for version in sorted(nav_versions - set(version_order)):
        issues.append(
            DocsIssue(
                DOCS_NAV_DIR / f"{version}.toml",
                "nav file exists for undeclared docs version",
            )
        )

    for version in sorted(content_versions - set(version_order)):
        issues.append(
            DocsIssue(
                DOCS_CONTENT_DIR / version,
                "content directory exists for undeclared docs version",
            )
        )

    return issues


def validate_all() -> list[DocsIssue]:
    """Run all docs content validation checks."""
    issues: list[DocsIssue] = []
    version_order, version_issues = load_version_order()
    issues.extend(version_issues)

    if not DOCS_CONTENT_DIR.exists():
        issues.append(DocsIssue(DOCS_CONTENT_DIR, "docs content directory is missing"))
        return issues

    if not DOCS_NAV_DIR.exists():
        issues.append(DocsIssue(DOCS_NAV_DIR, "docs nav directory is missing"))
        return issues

    issues.extend(validate_legacy_front_matter())

    nav_files = sorted(
        path for path in DOCS_NAV_DIR.glob("*.toml") if path.name != README_NAV_FILE
    )
    if not nav_files:
        issues.append(DocsIssue(DOCS_NAV_DIR, "no docs nav files found"))
        return issues

    nav_versions = {path.stem for path in nav_files}
    content_versions = {
        path.name for path in child_dirs(DOCS_CONTENT_DIR) if path.name != "_index.md"
    }
    issues.extend(
        validate_declared_versions(version_order, nav_versions, content_versions)
    )

    for nav_file in nav_files:
        nav_data, nav_issues = parse_nav_file(nav_file)
        issues.extend(nav_issues)
        if nav_data is not None:
            issues.extend(validate_nav_content(nav_data, version_order))
            issues.extend(validate_version_tree(nav_data))

    return issues


def main() -> int:
    """Validate the docs content tree and print actionable failures."""
    issues = validate_all()

    if not issues:
        print("Docs content validation passed.")
        return 0

    print("Docs content validation failed:", file=sys.stderr)
    for issue in issues:
        print(f"  - {issue.format()}", file=sys.stderr)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
