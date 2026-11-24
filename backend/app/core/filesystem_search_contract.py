"""Shared limits and wire models for live file-system search."""

import json
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.search_scope import validate_directory_path
from app.models.file import FileInfo
from app.services.filesystem_search_matching import NameMatcher

CONTRACT_PATHS = tuple(Path(__file__).resolve().parents[level] / "shared" / "filesystem-search" / "contract.json" for level in (3, 2))
CONTRACT_PATH = next((path for path in CONTRACT_PATHS if path.is_file()), CONTRACT_PATHS[0])


def _load_limits() -> dict[str, int]:
    document = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or document.get("version") != 1 or type(document.get("version")) is not int:
        raise ValueError("File-system search contract version is unsupported. Restore the shared contract file.")
    limits = document.get("limits")
    keys = {
        "query_utf8_bytes",
        "zip_central_directory_bytes",
        "pending_directory_bytes",
        "pending_directory_entry_bytes",
        "result_batch_items",
        "stream_record_bytes",
        "queued_batches",
        "skip_reason_types",
    }
    if not isinstance(limits, dict) or set(limits) != keys or any(type(value) is not int or value < 1 for value in limits.values()):
        raise ValueError("File-system search contract limits are invalid. Restore the shared contract file.")
    return limits


LIMITS = _load_limits()


class _WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class SearchSource(_WireModel):
    kind: Literal["smb", "local"]
    id: str = Field(min_length=1, max_length=256)


class DirectoryRoot(_WireModel):
    kind: Literal["directory"]
    path: str


class ArchiveRoot(_WireModel):
    kind: Literal["archive"]
    path: str = Field(min_length=1)
    member_path: str


SearchRoot = Annotated[DirectoryRoot | ArchiveRoot, Field(discriminator="kind")]


class SearchRequest(_WireModel):
    version: Literal[1]
    source: SearchSource
    root: SearchRoot
    query: str
    case_sensitive: bool
    folder_depth: Literal["current", "recursive"]
    item_type: Literal["all", "files", "directories"]
    search_archives: bool

    @field_validator("version", mode="before")
    @classmethod
    def validate_version(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("File-system search version is invalid. Update the client and retry.")
        return value

    @model_validator(mode="after")
    def validate_request(self) -> "SearchRequest":
        if len(self.query.encode("utf-8", errors="strict")) > LIMITS["query_utf8_bytes"]:
            raise ValueError("Search term is too long. Use a shorter term and retry.")
        NameMatcher(self.query, case_sensitive=self.case_sensitive)
        paths = (self.root.path, self.root.member_path) if isinstance(self.root, ArchiveRoot) else (self.root.path,)
        for path in paths:
            if path:
                validate_directory_path(path)
        return self


class PhysicalTarget(_WireModel):
    kind: Literal["physical"]
    path: str = Field(min_length=1)


class ArchiveTarget(_WireModel):
    kind: Literal["archive"]
    archive_path: str = Field(min_length=1)
    member_path: str = Field(min_length=1)


SearchTarget = Annotated[PhysicalTarget | ArchiveTarget, Field(discriminator="kind")]


class SearchItem(_WireModel):
    entry: FileInfo
    target: SearchTarget
    archive_state: Literal["readable", "blocked", "unavailable"] | None = None

    @model_validator(mode="after")
    def validate_archive_state(self) -> "SearchItem":
        if isinstance(self.target, ArchiveTarget):
            path = self.target.member_path
            validate_directory_path(self.target.archive_path)
            if self.archive_state is None or self.entry.is_readable != (self.archive_state == "readable"):
                raise ValueError("Archive result state is invalid.")
        else:
            path = self.target.path
            if self.archive_state is not None:
                raise ValueError("Physical search results cannot have an archive state.")
        validate_directory_path(path)
        if self.entry.path != path or self.entry.name != path.rsplit("/", 1)[-1]:
            raise ValueError("Search result metadata does not match its target.")
        return self


class SearchLimits(_WireModel):
    max_seconds: int = Field(gt=0)
    max_results: int = Field(gt=0)


class SearchStart(_WireModel):
    type: Literal["start"]
    version: Literal[1]
    request_id: UUID
    limits: SearchLimits


class SearchBatch(_WireModel):
    type: Literal["batch"]
    results: list[SearchItem] = Field(max_length=LIMITS["result_batch_items"])


class SearchCounts(_WireModel):
    matches: int = Field(ge=0)
    scanned_directories: int = Field(ge=0)
    skipped: int = Field(ge=0)


class SearchSkip(_WireModel):
    reason: Literal["unreadable_directory", "unsafe_name", "archive_too_large", "archive_unreadable", "queue_limit"]
    count: int = Field(gt=0)


class SearchTerminal(_WireModel):
    type: Literal["terminal"]
    reason: Literal["complete", "partial_coverage", "time_limit", "result_limit", "source_failure"]
    counts: SearchCounts
    skips: list[SearchSkip] = Field(max_length=LIMITS["skip_reason_types"])
