"""Generate committed social preview assets for the website.

This script keeps social media preview images out of Hugo's ``resources/_gen``
pipeline and instead writes them into the same committed ``assets/images``
tree used by the rest of the site.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ASSETS_DIR = Path(__file__).parent.parent / "assets" / "images"
SOURCE_IMAGE = ASSETS_DIR / "home" / "sambee-screenshot.png"
OUTPUT_IMAGE = ASSETS_DIR / "home" / "generated" / "sambee-screenshot_1200w.png"
TARGET_WIDTH = 1200
TARGET_HEIGHT = 630
MAGICK_CMD = "magick"


def ensure_magick() -> bool:
    """Return ``True`` when ImageMagick is available and usable."""
    try:
        result = subprocess.run(
            [MAGICK_CMD, "--version"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("Error: ImageMagick 'magick' command not found")
        return False

    print(f"Using: {result.stdout.splitlines()[0]}")
    return True


def get_image_dimensions(image_path: Path) -> tuple[int, int] | None:
    """Return image dimensions as ``(width, height)`` or ``None`` on failure."""
    try:
        result = subprocess.run(
            [MAGICK_CMD, "identify", "-format", "%w %h", str(image_path)],
            capture_output=True,
            text=True,
            check=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None

    try:
        width, height = map(int, result.stdout.strip().split())
    except ValueError:
        return None
    return width, height


def output_is_current() -> bool:
    """Return ``True`` when the generated asset exists and is up to date."""
    if not OUTPUT_IMAGE.exists():
        return False

    if OUTPUT_IMAGE.stat().st_mtime < SOURCE_IMAGE.stat().st_mtime:
        return False

    return get_image_dimensions(OUTPUT_IMAGE) == (TARGET_WIDTH, TARGET_HEIGHT)


def generate_social_card() -> None:
    """Generate the PNG social card from the homepage screenshot."""
    OUTPUT_IMAGE.parent.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(
            [
                MAGICK_CMD,
                str(SOURCE_IMAGE),
                "-resize",
                f"{TARGET_WIDTH}x{TARGET_HEIGHT}^",
                "-gravity",
                "center",
                "-extent",
                f"{TARGET_WIDTH}x{TARGET_HEIGHT}",
                "-strip",
                f"PNG24:{OUTPUT_IMAGE}",
            ],
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        detail = error.stderr.strip() or error.stdout.strip() or str(error)
        raise RuntimeError(
            f"Failed to generate social card {OUTPUT_IMAGE}: {detail}"
        ) from error

    dimensions = get_image_dimensions(OUTPUT_IMAGE)
    if dimensions != (TARGET_WIDTH, TARGET_HEIGHT):
        raise RuntimeError(
            f"Generated social card has invalid dimensions {dimensions}; "
            f"expected {(TARGET_WIDTH, TARGET_HEIGHT)}"
        )


def main() -> int:
    """Generate the website social card when needed."""
    force = "--force" in sys.argv

    if not SOURCE_IMAGE.exists():
        print(f"Error: missing social card source image {SOURCE_IMAGE}")
        return 1

    if not ensure_magick():
        return 1

    if output_is_current() and not force:
        print(f"Social card is up to date: {OUTPUT_IMAGE}")
        return 0

    try:
        generate_social_card()
    except RuntimeError as error:
        print(f"Error: {error}")
        return 1

    print(f"Generated social card: {OUTPUT_IMAGE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
