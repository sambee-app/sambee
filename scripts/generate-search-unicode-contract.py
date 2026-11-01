#!/usr/bin/env python3
"""Generate the versioned search normalization data used outside Python."""

from __future__ import annotations

import argparse
import json
import unicodedata
from pathlib import Path

OUTPUT_PATH = (
    Path(__file__).resolve().parents[1] / "shared" / "directory-index" / "unicode.json"
)
MAX_UNICODE_CODEPOINT = 0x10FFFF
SURROGATE_START = 0xD800
SURROGATE_END = 0xDFFF
CONTRACT_VERSION = 1


def generate() -> str:
    mapping: list[list[str]] = []
    whitespace: list[str] = []
    word_ranges: list[list[int]] = []
    range_start: int | None = None
    for codepoint in range(MAX_UNICODE_CODEPOINT + 1):
        character = chr(codepoint)
        if not SURROGATE_START <= codepoint <= SURROGATE_END:
            decomposed = unicodedata.normalize("NFKD", character)
            normalized = "".join(
                part for part in decomposed if not unicodedata.combining(part)
            ).casefold()
            if normalized != character:
                mapping.append([character, normalized])
            if character.isspace():
                whitespace.append(character)
        if character.isalnum():
            if range_start is None:
                range_start = codepoint
        elif range_start is not None:
            word_ranges.append([range_start, codepoint - 1])
            range_start = None
    if range_start is not None:
        word_ranges.append([range_start, MAX_UNICODE_CODEPOINT])
    return (
        json.dumps(
            {
                "version": CONTRACT_VERSION,
                "unicode_version": unicodedata.unidata_version,
                "normalization": mapping,
                "whitespace": whitespace,
                "word_ranges": word_ranges,
            },
            ensure_ascii=True,
            separators=(",", ":"),
        )
        + "\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    content = generate()
    if arguments.check:
        if (
            not OUTPUT_PATH.is_file()
            or OUTPUT_PATH.read_text(encoding="utf-8") != content
        ):
            print(
                "Search Unicode contract is missing or stale. Run scripts/generate-search-unicode-contract.py with the backend interpreter."
            )
            return 1
        print("Search Unicode contract is current.")
        return 0
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(content, encoding="utf-8")
    print(
        f"Generated search Unicode contract {CONTRACT_VERSION} with Unicode {unicodedata.unidata_version}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
