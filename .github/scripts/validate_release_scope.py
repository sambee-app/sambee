"""Validate a public Sambee release's component-promotion scope."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

VALID_SCOPES = {"docker", "companion", "both"}


def fail(message: str) -> None:
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


def validate_scope(
    metadata: dict, component: str, version: str, build_tag: str, source_sha: str
) -> None:
    if metadata.get("schema_version") != 1:
        fail("sambee-release.json has an unsupported schema version")
    scope = metadata.get("component_scope")
    if scope not in VALID_SCOPES:
        fail("sambee-release.json has an invalid component_scope")
    if scope not in {component, "both"}:
        fail(f"sambee-release.json scope {scope} does not allow {component} promotion")
    expected = {"version": version, "build_tag": build_tag, "source_sha": source_sha}
    for key, value in expected.items():
        if metadata.get(key) != value:
            fail(f"sambee-release.json {key} does not match the selected build")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--metadata-file", required=True, type=Path)
    parser.add_argument("--component", required=True, choices=("docker", "companion"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--build-tag", required=True)
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    try:
        metadata = json.loads(args.metadata_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"Unable to read sambee-release.json: {error}")
    if not isinstance(metadata, dict):
        fail("sambee-release.json must contain a JSON object")
    validate_scope(
        metadata, args.component, args.version, args.build_tag, args.source_sha
    )


if __name__ == "__main__":
    main()
