"""Validate the committed Vitest shard matrix for CI and release reuse."""

import json
import os
import sys
from pathlib import Path
from typing import TypedDict

SHARD_FILE = Path(__file__).resolve().parents[1] / "frontend" / "ci-shards.json"


class ShardMatrix(TypedDict):
    index: list[int]
    total: list[int]


def unique_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Reject ambiguous JSON objects instead of silently keeping the last key."""
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key: {key}")
        result[key] = value
    return result


def load_shard_matrix(path: Path = SHARD_FILE) -> ShardMatrix:
    """Read the two matrix axes and require complete, unique shard coverage."""
    matrix = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_keys)
    if not isinstance(matrix, dict) or matrix.keys() != {"index", "total"}:
        raise ValueError('expected matrix axes "index" and "total"')
    # GitHub Actions requires an array for each axis, even the single total.
    indices, totals = matrix["index"], matrix["total"]
    if (
        not isinstance(totals, list)
        or len(totals) != 1
        or type(totals[0]) is not int
        or totals[0] <= 0
    ):
        raise ValueError('"total" must contain one positive integer')
    if not isinstance(indices, list) or any(
        type(index) is not int or index <= 0 for index in indices
    ):
        raise ValueError('"index" must be a list of positive integers')
    total = totals[0]
    if len(indices) != total or any(
        index != expected for expected, index in enumerate(sorted(indices), start=1)
    ):
        raise ValueError(f'"index" must contain each integer from 1 through {total} exactly once')
    return {"index": indices, "total": totals}


def main() -> int:
    """Write the validated matrix without changing either axis."""
    try:
        matrix = load_shard_matrix()
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"frontend_shards={json.dumps(matrix, separators=(',', ':'))}\n")
    except (KeyError, OSError, ValueError) as error:
        print(f"Cannot load or publish the matrix from {SHARD_FILE}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
