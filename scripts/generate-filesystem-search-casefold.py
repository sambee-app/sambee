#!/usr/bin/env python3
"""Generate the locale-independent Unicode case-folding table for file search."""

import argparse
import json
import unicodedata
from pathlib import Path

OUTPUT = (
    Path(__file__).resolve().parents[1]
    / "shared"
    / "filesystem-search"
    / "casefold.json"
)
UNICODE_LIMIT = 0x110000
SURROGATE_START = 0xD800
SURROGATE_END = 0xDFFF


def generate() -> str:
    mapping = []
    for codepoint in range(UNICODE_LIMIT):
        if SURROGATE_START <= codepoint <= SURROGATE_END:
            continue
        character = chr(codepoint)
        folded = character.casefold()
        if folded != character:
            mapping.append([character, folded])
    return (
        json.dumps(
            {
                "version": 1,
                "unicode_version": unicodedata.unidata_version,
                "casefold": mapping,
            },
            ensure_ascii=True,
            separators=(",", ":"),
        )
        + "\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = generate()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != content:
            print(
                "File-search case-folding data is stale. Run this script with the backend interpreter."
            )
            return 1
        print("File-search case-folding data is current.")
        return 0
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(content, encoding="utf-8")
    print(
        f"Generated file-search case-folding data with Unicode {unicodedata.unidata_version}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
