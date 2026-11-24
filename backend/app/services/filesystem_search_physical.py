"""Independent breadth-first live traversal through the safe SMB reader."""

from dataclasses import dataclass
from typing import Any, Callable, Literal, Mapping

from smbprotocol.exceptions import SMBOSError, SMBResponseException
from smbprotocol.header import NtStatus
from smbprotocol.open import FileAttributes

from app.services.directory_traversal import DirectoryBindingChangedError, DirectoryTraversalError, SmbDirectoryEntry, SmbDirectoryRoot
from app.services.filesystem_search_frontier import SearchFrontier, SearchFrontierFull
from app.services.filesystem_search_matching import NameMatcher
from app.storage.smb import SMB_LIST_DIRECTORY_TIMEOUT_SECONDS

ZIP_EXTENSION = "zip"


@dataclass(frozen=True)
class PhysicalSearchEvent:
    kind: Literal["directory", "file", "archive", "issue"]
    path: str
    entry: SmbDirectoryEntry | None = None
    issue: Literal["access_denied", "unreadable_directory", "unsafe_name"] | None = None


@dataclass
class PhysicalSearchSummary:
    scanned_directories: int = 0
    skipped: int = 0
    queue_limit_reached: bool = False


@dataclass(frozen=True)
class PhysicalSearchOptions:
    root: str
    folder_depth: Literal["current", "recursive"]
    item_type: Literal["all", "files", "directories"]
    search_archives: bool
    matcher: NameMatcher


def _archive_name(name: str) -> bool:
    _stem, separator, extension = name.rpartition(".")
    return bool(separator) and extension.lower() == ZIP_EXTENSION


def _descendant_issue(error: Exception) -> Literal["access_denied", "unreadable_directory"] | None:
    if isinstance(error, DirectoryBindingChangedError):
        return None
    status = error.ntstatus if isinstance(error, SMBOSError) else error.status if isinstance(error, SMBResponseException) else None
    if isinstance(error, PermissionError) or status == NtStatus.STATUS_ACCESS_DENIED:
        return "access_denied"
    if isinstance(error, (FileNotFoundError, NotADirectoryError, DirectoryTraversalError)) or status in (
        NtStatus.STATUS_OBJECT_NAME_NOT_FOUND,
        NtStatus.STATUS_OBJECT_PATH_NOT_FOUND,
        NtStatus.STATUS_NOT_A_DIRECTORY,
    ):
        return "unreadable_directory"
    return None


def search_physical(
    source: SmbDirectoryRoot,
    options: PhysicalSearchOptions,
    session: Mapping[str, Any],
    check: Callable[[], None],
    receive: Callable[[PhysicalSearchEvent], None],
    *,
    summary: PhysicalSearchSummary | None = None,
) -> PhysicalSearchSummary:
    """Scan one authorized source; callers own the root and session cleanup."""
    if options.folder_depth not in ("current", "recursive") or options.item_type not in ("all", "files", "directories"):
        raise ValueError("Search options are invalid. Select the search options and try again.")
    frontier = SearchFrontier()
    frontier.enqueue(options.root)
    if summary is None:
        summary = PhysicalSearchSummary()
    is_root = True
    while frontier:
        pending = frontier.pop()
        check()

        def report_issue(error: Exception) -> bool:
            issue = None if is_root else _descendant_issue(error)
            if issue is None:
                return False
            summary.skipped += 1
            receive(PhysicalSearchEvent("issue", pending.path, issue=issue))
            return True

        try:
            held_reader = source.read(pending.path, check, full_root_check=is_root, include_files=True, **session)
        except (OSError, SMBOSError, SMBResponseException) as error:
            if not report_issue(error):
                raise
            continue
        reader = held_reader
        try:
            try:
                if pending.expected_id is not None:
                    held_reader.verify_file_id(pending.expected_id)
                reader = held_reader.compound_for_search(timeout=SMB_LIST_DIRECTORY_TIMEOUT_SECONDS)
            except (OSError, SMBOSError, SMBResponseException) as error:
                if not report_issue(error):
                    raise
                continue
            read_failed = False
            while True:
                try:
                    entry = next(reader)
                except StopIteration:
                    break
                except (OSError, SMBOSError, SMBResponseException) as error:
                    if not report_issue(error):
                        raise
                    read_failed = True
                    break
                check()
                if entry.name is None:
                    summary.skipped += 1
                    receive(PhysicalSearchEvent("issue", pending.path, issue="unsafe_name"))
                    continue
                attributes = entry.smb_info.file_attributes
                if attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT:
                    continue
                path = f"{pending.path}/{entry.name}" if pending.path else entry.name
                if attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY:
                    if options.item_type != "files" and options.matcher.matches(entry.name):
                        receive(PhysicalSearchEvent("directory", path, entry))
                    if options.folder_depth == "recursive":
                        try:
                            frontier.enqueue(path, entry.file_id)
                        except SearchFrontierFull:
                            summary.queue_limit_reached = True
                            return summary
                else:
                    if options.item_type != "directories" and options.matcher.matches(entry.name):
                        receive(PhysicalSearchEvent("file", path, entry))
                    if options.search_archives and _archive_name(entry.name):
                        receive(PhysicalSearchEvent("archive", path, entry))
            if not read_failed:
                try:
                    reader.verify()
                    if reader is not held_reader:
                        held_reader.verify()
                except (OSError, SMBOSError, SMBResponseException) as error:
                    if not report_issue(error):
                        raise
                else:
                    summary.scanned_directories += 1
        finally:
            try:
                if reader is not held_reader:
                    reader.close()
            finally:
                held_reader.close()
        is_root = False
    return summary
