"""Reject shard matrices that could leave part of the frontend suite untested."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from ci_frontend_shards import load_shard_matrix


def test_valid_matrix_preserves_shard_order(tmp_path: Path) -> None:
    path = tmp_path / "matrix.json"
    matrix = {"index": [2, 1, 3], "total": [3]}
    path.write_text(json.dumps(matrix), encoding="utf-8")
    assert load_shard_matrix(path) == matrix


@pytest.mark.parametrize(
    "contents",
    [
        "{",
        "[]",
        '{"index": [1], "total": [1], "extra": true}',
        '{"index": [1], "index": [1], "total": [1]}',
        '{"index": [], "total": [3]}',
        '{"index": [1], "total": [0]}',
        '{"index": [1], "total": [1.0]}',
        '{"index": [1], "total": [true]}',
        '{"index": [1.5], "total": [1]}',
        '{"index": [true], "total": [1]}',
        '{"index": [0], "total": [1]}',
        '{"index": [1, 3], "total": [3]}',
        '{"index": [1, 1, 3], "total": [3]}',
        '{"index": [1, 2, 4], "total": [3]}',
        '{"index": [1, 2, 3, 4], "total": [3]}',
    ],
)
def test_rejects_invalid_matrix(tmp_path: Path, contents: str) -> None:
    path = tmp_path / "matrix.json"
    path.write_text(contents, encoding="utf-8")
    with pytest.raises(ValueError):
        load_shard_matrix(path)
