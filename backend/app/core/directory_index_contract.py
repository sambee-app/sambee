"""Validated language-neutral directory-index limits and resource-policy fields."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Final, Literal, Mapping

CONTRACT_VERSION: Final[Literal[1]] = 1
MAX_SQL_INTEGER: Final = (1 << 63) - 1
MAX_WIRE_INTEGER: Final = (1 << 53) - 1
DIRECTORY_POLICY_TOKEN_CLASS: Final = "directory_index_policy_grant"
DIRECTORY_POLICY_TOKEN_PURPOSE: Final = "approve_directory_index_policy"
DIRECTORY_POLICY_TOKEN_CLAIM: Final = "companion_directory_policy"
DIRECTORY_POLICY_GRANT_SECONDS: Final = 60
MAX_DIRECTORY_POLICY_GRANTS: Final = 4096
MAX_DIRECTORY_POLICY_ORIGIN_BYTES: Final = 2048
MIN_DIRECTORY_POLICY_CHALLENGE_BYTES: Final = 32
MAX_DIRECTORY_POLICY_CHALLENGE_BYTES: Final = 128
MAX_DIRECTORY_POLICY_TOKEN_BYTES: Final = 8192
CONTRACT_PATH_CANDIDATES = tuple(
    Path(__file__).resolve().parents[level] / "shared" / "directory-index" / "contract.json" for level in (3, 2)
)
CONTRACT_PATH = next((path for path in CONTRACT_PATH_CANDIDATES if path.is_file()), CONTRACT_PATH_CANDIDATES[0])
POLICY_FIELDS = (
    "disk_budget_bytes",
    "inactive_retention_seconds",
    "max_retained_inactive_sources",
    "page_cache_kib",
    "healthy_verification_seconds",
    "degraded_verification_seconds",
)
LIMIT_FIELDS = frozenset(
    {
        "schema_version",
        "normalization_version",
        "traversal_version",
        "max_query_bytes",
        "max_query_terms",
        "max_result_limit",
        "row_batch_size",
        "query_workers",
        "scan_workers",
        "busy_timeout_ms",
        "progress_steps",
        "query_timeout_seconds",
        "status_publication_ms",
        "event_coalescing_ms",
        "idle_release_seconds",
        "max_pending_observations",
        "max_observation_bytes",
        "minimum_sqlite_version_number",
        "write_headroom_bytes",
        "maintenance_page_batch",
        "checkpoint_wal_bytes",
        "lease_cleanup_batch",
    }
)


@dataclass(frozen=True)
class DirectoryPolicyField:
    label: str
    description: str
    default: int
    minimum: int
    maximum: int
    step: int

    def validate(self, value: int) -> int:
        if type(value) is not int or not self.minimum <= value <= self.maximum:
            raise ValueError(f"{self.label} must be an integer between {self.minimum} and {self.maximum}.")
        return value


@dataclass(frozen=True)
class DirectoryIndexContract:
    limits: Mapping[str, int]
    policy: Mapping[str, DirectoryPolicyField]


def load_directory_index_contract(path: Path = CONTRACT_PATH) -> DirectoryIndexContract:
    document = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or document.get("version") != CONTRACT_VERSION or type(document.get("version")) is not int:
        raise ValueError("Directory-index contract version is unsupported. Restore the shared contract file.")
    limits = document.get("limits")
    policy = document.get("policy")
    if not isinstance(limits, dict) or set(limits) != LIMIT_FIELDS or any(type(value) is not int or value < 1 for value in limits.values()):
        raise ValueError("Directory-index limits are invalid. Restore the shared contract file.")
    if not isinstance(policy, dict) or set(policy) != set(POLICY_FIELDS):
        raise ValueError("Directory-index policy fields are invalid. Restore the shared contract file.")
    parsed: dict[str, DirectoryPolicyField] = {}
    for name in POLICY_FIELDS:
        entry = policy[name]
        if not isinstance(entry, dict) or set(entry) != {"label", "description", "default", "minimum", "maximum", "step"}:
            raise ValueError("Directory-index policy definition is invalid. Restore the shared contract file.")
        if any(type(entry[key]) is not int or entry[key] < 1 for key in ("default", "minimum", "maximum", "step")):
            raise ValueError("Directory-index policy bounds must be positive integers. Restore the shared contract file.")
        if any(not isinstance(entry[key], str) or not entry[key] for key in ("label", "description")):
            raise ValueError("Directory-index policy descriptions are missing. Restore the shared contract file.")
        field = DirectoryPolicyField(**entry)
        field.validate(field.default)
        if field.minimum > field.maximum or field.step > field.maximum - field.minimum:
            raise ValueError("Directory-index policy bounds are inconsistent. Restore the shared contract file.")
        parsed[name] = field
    if parsed["degraded_verification_seconds"].default > parsed["healthy_verification_seconds"].default:
        raise ValueError("Degraded verification must not exceed healthy verification. Restore the shared contract file.")
    return DirectoryIndexContract(MappingProxyType(limits), MappingProxyType(parsed))


DIRECTORY_INDEX_CONTRACT = load_directory_index_contract()
