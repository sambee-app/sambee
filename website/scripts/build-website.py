"""Build matching website pages, route manifest, redirects, and search output."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

WEBSITE = Path(__file__).resolve().parent.parent
BUILD_TIMEOUT = 600


def main() -> int:
    """Use one ordered pipeline for production, preview, and development builds."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--environment",
        default="production",
        choices=["production", "preview", "development"],
    )
    parser.add_argument("--destination", type=Path, default=Path("public"))
    args = parser.parse_args()
    destination = (
        args.destination.resolve()
        if args.destination.is_absolute()
        else WEBSITE / args.destination
    )
    commands = [
        ["node", "scripts/themeGenerator.js"],
        ["python3", "scripts/validate-docs-content.py"],
        ["python3", "scripts/materialize-inherited-docs.py"],
        [
            "hugo",
            "--source",
            ".",
            "--environment",
            args.environment,
            "--destination",
            str(destination),
            "--cleanDestinationDir",
            "--gc",
            "--minify",
            "--baseURL",
            os.environ.get("HUGO_BASEURL", "https://sambee.net/"),
        ],
        [
            "python3",
            "scripts/generate-managed-redirects.py",
            "--output",
            str(destination / "_redirects"),
        ],
        ["npx", "--no-install", "pagefind", "--site", str(destination)],
        ["python3", "scripts/validate-homepage-ctas.py", str(destination)],
        [
            "python3",
            "scripts/validate-docs-output.py",
            str(destination),
            "--environment",
            args.environment,
        ],
    ]
    try:
        for command in commands:
            print("Running " + " ".join(command), flush=True)
            subprocess.run(command, cwd=WEBSITE, check=True, timeout=BUILD_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as error:
        print(f"Website build failed at {command!r}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
