"""Generate responsive WebP derivatives for website asset images.

Source images live under ``website/assets/images``. For each JPG or PNG source,
this script writes WebP variants into a sibling ``generated/`` directory using
the naming scheme ``{stem}_{width}w.webp``.

The shared Hugo partial ``components/responsive-image.html`` resolves these
derivatives and emits fingerprinted ``srcset`` markup at render time.
"""

from __future__ import annotations

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ASSETS_DIR = Path(__file__).parent.parent / "assets" / "images"
TARGET_WIDTHS = [372, 500, 744, 852, 1000, 1280, 1704]
WEBP_PHOTO_QUALITY = 82
MAX_WORKERS = 4
MAGICK_CMD = "magick"
VALID_EXTENSIONS = {".jpg", ".jpeg", ".png"}


def build_webp_encode_args(source_path: Path) -> list[str]:
    """Return ImageMagick WebP encoding arguments for the source asset type."""
    if source_path.suffix.lower() == ".png":
        return [
            "-define",
            "webp:lossless=true",
            "-define",
            "webp:method=6",
        ]

    return [
        "-quality",
        str(WEBP_PHOTO_QUALITY),
        "-define",
        "webp:method=6",
    ]


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


def generate_webp(
    source_path: Path,
    target_width: int,
    force: bool = False,
    dimensions: tuple[int, int] | None = None,
) -> Path | None:
    """Generate a single WebP derivative for ``source_path`` at ``target_width``."""
    generated_dir = source_path.parent / "generated"
    output_path = generated_dir / f"{source_path.stem}_{target_width}w.webp"

    if output_path.exists() and not force:
        return None

    dimensions = dimensions or get_image_dimensions(source_path)
    if not dimensions:
        print(f"  Warning: could not read dimensions for {source_path}")
        return None

    source_width, _ = dimensions
    if source_width < target_width:
        return None

    output_path.parent.mkdir(parents=True, exist_ok=True)
    encode_args = build_webp_encode_args(source_path)

    try:
        subprocess.run(
            [
                MAGICK_CMD,
                str(source_path),
                "-resize",
                f"{target_width}x",
                *encode_args,
                str(output_path),
            ],
            capture_output=True,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        stderr = (
            error.stderr.decode() if isinstance(error.stderr, bytes) else error.stderr
        )
        print(f"  Error converting {source_path}: {stderr}")
        return None

    return output_path


def get_target_widths(source_width: int) -> list[int]:
    """Return configured widths plus the original width when needed."""
    target_widths = [width for width in TARGET_WIDTHS if width <= source_width]
    if source_width not in target_widths:
        target_widths.append(source_width)
    return target_widths


def process_image(image_path: Path, force: bool = False) -> list[Path]:
    """Generate all configured derivatives for a single source image."""
    dimensions = get_image_dimensions(image_path)
    if not dimensions:
        print(f"  Warning: could not read dimensions for {image_path}")
        return []

    source_width, _ = dimensions
    generated_files: list[Path] = []
    for width in get_target_widths(source_width):
        result = generate_webp(image_path, width, force, dimensions)
        if result:
            generated_files.append(result)
    return generated_files


def find_source_images() -> list[Path]:
    """Return JPG and PNG sources, excluding already-generated derivative files."""
    images: list[Path] = []
    for pattern in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG"):
        images.extend(ASSETS_DIR.rglob(pattern))

    return sorted(
        image
        for image in images
        if image.parent.name != "generated"
        and not any(f"_{width}w" in image.stem for width in TARGET_WIDTHS)
        and "_hu_" not in image.stem
    )


def resolve_requested_source_images(path_args: list[str]) -> list[Path]:
    """Return validated source images requested explicitly on the command line."""
    resolved_images: dict[Path, None] = {}

    for raw_path in path_args:
        candidate = Path(raw_path)
        if not candidate.is_absolute():
            candidate = (Path.cwd() / candidate).resolve()
        else:
            candidate = candidate.resolve()

        if not candidate.exists() or not candidate.is_file():
            print(f"  Warning: requested image does not exist: {raw_path}")
            continue

        try:
            candidate.relative_to(ASSETS_DIR)
        except ValueError:
            print(f"  Warning: requested image is outside {ASSETS_DIR}: {raw_path}")
            continue

        if candidate.parent.name == "generated":
            print(f"  Warning: ignoring generated derivative path: {raw_path}")
            continue

        if candidate.suffix.lower() not in VALID_EXTENSIONS:
            print(f"  Warning: ignoring unsupported file type: {raw_path}")
            continue

        if any(f"_{width}w" in candidate.stem for width in TARGET_WIDTHS):
            print(f"  Warning: ignoring derivative-like filename: {raw_path}")
            continue

        if "_hu_" in candidate.stem:
            print(f"  Warning: ignoring Hugo-generated asset: {raw_path}")
            continue

        resolved_images[candidate] = None

    return sorted(resolved_images)


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


def main() -> int:
    """Generate missing WebP derivatives for site assets."""
    force = "--force" in sys.argv
    path_args = [arg for arg in sys.argv[1:] if arg != "--force"]

    if not ASSETS_DIR.exists():
        print(f"No asset image directory found at {ASSETS_DIR}; nothing to do.")
        return 0

    if not ensure_magick():
        return 1

    if path_args:
        source_images = resolve_requested_source_images(path_args)
        print(f"Processing requested source images in {ASSETS_DIR}...")
    else:
        source_images = find_source_images()
        print(f"Scanning for source images in {ASSETS_DIR}...")
    print(f"Found {len(source_images)} source images")

    if not source_images:
        print("No images to process")
        return 0

    total_generated = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {
            executor.submit(process_image, image, force): image
            for image in source_images
        }
        for future in as_completed(futures):
            image_path = futures[future]
            try:
                generated = future.result()
            except (
                Exception
            ) as error:  # pragma: no cover - defensive top-level reporting
                print(f"  Error processing {image_path}: {error}")
                continue

            if generated:
                total_generated += len(generated)
                print(f"  Generated {len(generated)} WebP files for {image_path.name}")

    print(f"\nDone! Generated {total_generated} WebP files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
