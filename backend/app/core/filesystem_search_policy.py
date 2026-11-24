"""Defaults and conservative limits for the live search policy."""

import json
from dataclasses import dataclass
from typing import Final

from app.core.directory_index_contract import MAX_WIRE_INTEGER
from app.core.filesystem_search_contract import CONTRACT_PATH


@dataclass(frozen=True)
class PolicyBound:
    default: int
    minimum: int
    maximum: int


POLICY_FIELDS: Final = frozenset({"concurrent_searches", "max_seconds", "max_results"})


def _load_policy_bounds(document: object) -> dict[str, PolicyBound]:
    # Bounds are provisional. The shared ZIP measurement reached about 65 MB
    # for one Python projection; the directory fixture has 8,000 entries.
    error = "File-system search policy bounds or defaults are invalid. Restore the shared contract file."
    if not isinstance(document, dict) or type(document.get("version")) is not int or document["version"] != 1:
        raise ValueError(error)
    defaults = document.get("policy_defaults")
    bounds = document.get("policy_bounds")
    if not isinstance(defaults, dict) or not isinstance(bounds, dict) or set(defaults) != POLICY_FIELDS or set(bounds) != POLICY_FIELDS:
        raise ValueError(error)
    result = {}
    for name in sorted(POLICY_FIELDS):
        bound = bounds[name]
        default = defaults[name]
        if (
            not isinstance(bound, dict)
            or set(bound) != {"min", "max"}
            or type(default) is not int
            or type(bound["min"]) is not int
            or type(bound["max"]) is not int
            or not 1 <= bound["min"] <= default <= bound["max"] <= MAX_WIRE_INTEGER
        ):
            raise ValueError(error)
        result[name] = PolicyBound(default, bound["min"], bound["max"])
    return result


POLICY_BOUNDS: Final = _load_policy_bounds(json.loads(CONTRACT_PATH.read_text(encoding="utf-8")))
