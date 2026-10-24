"""Validate that every website raster source image has generated WebP files."""

from __future__ import annotations

from pathlib import Path

ASSETS_DIR = Path(__file__).parent.parent / "assets" / "images"


def find_source_images() -> list[Path]:
    """Return all raster source images that require generated WebP derivatives."""
    source_images: list[Path] = []

    for pattern in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG"):
        source_images.extend(ASSETS_DIR.rglob(pattern))

    return sorted(
        image
        for image in source_images
        if image.parent.name != "generated" and "_hu_" not in image.stem
    )


def has_generated_webp(source_image: Path) -> bool:
    """Return ``True`` when ``source_image`` has at least one sibling WebP derivative."""
    generated_dir = source_image.parent / "generated"
    if not generated_dir.exists():
        return False

    return any(generated_dir.glob(f"{source_image.stem}_*w.webp"))


def main() -> int:
    """Validate generated WebP coverage for all raster source images."""
    if not ASSETS_DIR.exists():
        print(f"No asset image directory found at {ASSETS_DIR}; nothing to validate.")
        return 0

    source_images = find_source_images()
    print(
        f"Validating generated WebP coverage for {len(source_images)} raster images..."
    )

    missing = [image for image in source_images if not has_generated_webp(image)]
    if not missing:
        print("All raster source images have generated WebP derivatives.")
        return 0

    print("Missing generated WebP derivatives for:")
    for image in missing:
        relative_path = image.relative_to(ASSETS_DIR.parent)
        print(f"  - {relative_path}")

    print(
        "\nRun 'python3 scripts/generate-webp.py' or start the website dev watcher to generate missing derivatives."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
