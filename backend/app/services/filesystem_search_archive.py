"""Match the existing effective ZIP projection without walking virtual folders."""

from dataclasses import dataclass
from typing import Callable, Iterator, Literal

from app.core.filesystem_search_contract import LIMITS
from app.services.archive.zip_reader import ArchiveFormatError, EffectiveZipProjection, ZipEntry, ZipReader
from app.services.filesystem_search_matching import NameMatcher


@dataclass(frozen=True)
class ArchiveSearchMatch:
    path: str
    is_directory: bool
    entry: ZipEntry | None


class ArchiveSearchTooLarge(ArchiveFormatError):
    """The central directory exceeds the bounded search projection limit."""


async def read_search_entries(reader: ZipReader, check: Callable[[], None]) -> tuple[ZipEntry, ...]:
    """Read raw ZIP records for search after the metadata size check.

    Callers build the projection with ``build_effective_projection`` outside the event loop.
    """
    check()
    size = await reader.central_directory_size()
    check()
    if size > LIMITS["zip_central_directory_bytes"]:
        raise ArchiveSearchTooLarge("The ZIP has too much metadata to search. Search a smaller ZIP or browse it instead.")
    raw_entries = await reader.raw_entries()
    check()
    return raw_entries


def iter_archive_matches(
    projection: EffectiveZipProjection,
    root: str,
    depth: Literal["current", "recursive"],
    item_type: Literal["all", "files", "directories"],
    matcher: NameMatcher,
    check: Callable[[], None],
) -> Iterator[ArchiveSearchMatch]:
    """Yield distinct browse-visible entries below an archive folder."""
    check()
    if root and root not in projection.directories:
        raise ArchiveFormatError("The search folder is not in this archive. Select a folder and try again.")
    if depth not in ("current", "recursive") or item_type not in ("all", "files", "directories"):
        raise ValueError("Search options are invalid. Select the search options and try again.")
    prefix = f"{root}/" if root else ""

    def matches(path: str) -> bool:
        if not path.startswith(prefix):
            return False
        remainder = path[len(prefix) :]
        if not remainder or (depth == "current" and "/" in remainder):
            return False
        return matcher.matches(remainder.rsplit("/", 1)[-1])

    if item_type != "directories":
        for entry in projection.regular_entries:
            check()
            if matches(entry.path):
                yield ArchiveSearchMatch(entry.path, False, entry)
    if item_type != "files":
        explicit = {entry.path: entry for entry in projection.explicit_directories}
        for path in projection.directories:
            check()
            if matches(path):
                yield ArchiveSearchMatch(path, True, explicit.get(path))
