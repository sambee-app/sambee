"""
Image conversion service using libvips for high-performance processing.

Converts non-browser-native image formats to JPEG/PNG for viewing.
Examples::
- TIFF/TIF → JPEG
- ICO → PNG (preserves transparency)
- JPEG → preserved (browser-native)
- PSD/PSB → PNG (via ImageMagick preprocessor)

Uses libvips for:
- Fast conversion
- Low memory usage
- Streaming, tiled processing
- Automatic multi-threading

For formats libvips doesn't natively support (PSD, PSB), we use
ImageMagick-based preprocessors to convert directly to a browser-ready format.
"""

import hashlib
import logging
import os
import platform
import time
from pathlib import Path
from typing import Any, Optional

import pyvips

from app.core.image_settings import get_libvips_jpeg_kwargs, get_libvips_png_kwargs
from app.services.preprocessor import (
    PreprocessorError,
    PreprocessorFileTooLargeError,
    PreprocessorRegistry,
)

logger = logging.getLogger(__name__)
CGROUP_CPU_MAX_PATH = Path("/sys/fs/cgroup/cpu.max")
CGROUP_CPU_STAT_PATH = Path("/sys/fs/cgroup/cpu.stat")
CPU_STAT_FIELDS = frozenset({"usage_usec", "nr_throttled", "throttled_usec"})
MILLISECONDS_PER_SECOND = 1000


def _read_image_cpu_state() -> tuple[str | None, dict[str, int]]:
    """Read optional cgroup v2 counters without making conversion depend on them."""
    try:
        quota = CGROUP_CPU_MAX_PATH.read_text().strip()
    except OSError:
        quota = None
    try:
        counters = {}
        for line in CGROUP_CPU_STAT_PATH.read_text().splitlines():
            name, value = line.split()
            if name in CPU_STAT_FIELDS:
                counters[name] = int(value)
    except (OSError, ValueError):
        counters = {}
    return quota, counters


def _log_image_cpu_timing(filename: str, started_cpu: float, before: dict[str, int]) -> None:
    """Report process-wide CPU and cgroup-wide counters, not per-request CPU."""
    cpu_ms = (time.process_time() - started_cpu) * MILLISECONDS_PER_SECOND
    _, after = _read_image_cpu_state()
    deltas = {name: after[name] - value for name, value in before.items() if name in after and after[name] >= value}
    logger.debug("Image CPU timing: filename=%r process_cpu_ms=%.1f cgroup_delta=%s", filename, cpu_ms, deltas)


# Check libvips availability and configure
try:
    # Test basic vips functionality and configure cache
    pyvips.cache_set_max(100)  # 100MB cache
    # Note: libvips handles concurrency automatically
    VIPS_AVAILABLE = True
except Exception as e:
    from app.core.logging import setup_early_error_logging

    logger = setup_early_error_logging()
    logger.error(f"Failed to initialize libvips: {e}")
    logger.error("Please ensure libvips is installed.")
    VIPS_AVAILABLE = False


#
# convert_image_for_viewer
#
def convert_image_for_viewer(
    image_bytes: bytes,
    filename: str,
    max_width: Optional[int] = None,
    max_height: Optional[int] = None,
    output_format: str = "auto",
) -> tuple[bytes, str, str, float]:
    """
    Convert an image to browser-ready format (JPEG/PNG/WebP).

    For formats not natively supported by libvips (PSD, PSB), converts
    directly to final browser-ready format using external preprocessors.
    For other formats, uses libvips for conversion.

    Args:
        image_bytes: Raw image file bytes
        filename: Original filename (used to determine format)
        max_width: Maximum width in pixels (image scaled to fit if larger)
        max_height: Maximum height in pixels (image scaled to fit if larger)
        output_format: Output format - "webp", "jpeg", "png", or "auto" (default)
                      "auto" chooses based on transparency and file type

    Returns:
        Tuple of (converted_bytes, mime_type, converter_name, duration_ms)
        - converted_bytes: The converted image bytes
        - mime_type: MIME type of the output (e.g., "image/webp")
        - converter_name: Name of converter used ("ImageMagick" or "libvips")
        - duration_ms: Conversion duration in milliseconds

    Raises:
        ValueError: If the image cannot be converted
        ImportError: If HEIC support is needed but not available
    """

    if not VIPS_AVAILABLE:
        raise ImportError("libvips is not available")

    debug_enabled = logger.isEnabledFor(logging.DEBUG)
    started_cpu = time.process_time() if debug_enabled else 0.0
    cpu_before: dict[str, int] = {}
    if debug_enabled:
        quota, cpu_before = _read_image_cpu_state()
        logger.debug(
            "Image conversion start: filename=%r input_bytes=%d input_sha256=%s viewport=%sx%s "
            "requested_format=%s architecture=%s pyvips=%s libvips=%s cpu_count=%s available_cpu_count=%s "
            "cpu_max=%r VIPS_CONCURRENCY=%r VIPS_NOVECTOR=%r",
            filename,
            len(image_bytes),
            hashlib.sha256(image_bytes).hexdigest(),
            max_width,
            max_height,
            output_format,
            platform.machine(),
            pyvips.__version__,
            ".".join(str(pyvips.version(index)) for index in range(3)),
            os.cpu_count(),
            os.process_cpu_count(),
            quota,
            os.environ.get("VIPS_CONCURRENCY"),
            os.environ.get("VIPS_NOVECTOR"),
        )

    # Extract extension for format-specific handling
    extension = f".{filename.lower().rsplit('.', 1)[-1]}" if "." in filename else ""

    # Check if this format needs preprocessing (use registry)
    needs_preprocessing = PreprocessorRegistry.requires_preprocessing(extension)

    # Path 1: Direct conversion for preprocessed formats (e.g., PSD)
    if needs_preprocessing:
        try:
            start_time = time.perf_counter()

            # Get preprocessor
            preprocessor = PreprocessorRegistry.get_preprocessor_for_format(extension)

            # Get converter name from preprocessor class
            converter_name = preprocessor.__class__.__name__.replace("Preprocessor", "")

            # Convert DIRECTLY to final browser-ready format (in-memory)
            # PSD/PSB files don't have alpha channel, so use JPEG
            # Vector formats (EPS/AI) may have transparency, so use PNG
            if extension in {".eps", ".ai"}:
                output_format = "png"
            else:
                output_format = "jpeg"
            logger.debug(f"Direct conversion (in-memory): {filename} → {output_format.upper()}")

            # Convert bytes directly - no temp files!
            result_bytes = preprocessor.convert_to_final_format(image_bytes, filename, output_format=output_format)

            duration_ms = (time.perf_counter() - start_time) * 1000
            mime_type = f"image/{output_format}"

            logger.debug(
                f"Direct conversion (in-memory): {filename} → {mime_type} "
                f"({len(image_bytes) / 1024:.0f} → {len(result_bytes) / 1024:.0f} KB) "
                f"via {converter_name} in {duration_ms:.0f} ms"
            )
            if debug_enabled:
                _log_image_cpu_timing(filename, started_cpu, cpu_before)

            return result_bytes, mime_type, converter_name, duration_ms

        except PreprocessorFileTooLargeError:
            raise
        except PreprocessorError:
            file_type = extension.lstrip(".").upper()
            raise ValueError(f"Unable to preview this {file_type} file. The file may be invalid or corrupted.") from None
        except Exception:
            logger.exception("Unexpected error preparing %s for preview.", filename)
            file_type = extension.lstrip(".").upper()
            raise ValueError(f"Unable to preview this {file_type} file. The file may be invalid or corrupted.") from None

    # Path 2: libvips conversion for all other formats
    try:
        start_time = time.perf_counter()

        # Load image (lazy - only metadata read at this point)
        # The empty string tells vips to auto-detect format from buffer
        image = pyvips.Image.new_from_buffer(image_bytes, "")
        metadata_finished = time.perf_counter()
        source_width, source_height = image.width, image.height

        # Determine output format based on transparency, file type, and user preference
        has_alpha = image.hasalpha()  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

        if output_format == "auto":
            # Auto-select format based on image characteristics
            if extension == ".ico" and has_alpha:
                output_format = "png"
            else:
                # Default to WebP for better compression
                output_format = "webp"

        # Set MIME type
        if output_format == "webp":
            mime_type = "image/webp"
        elif output_format == "png":
            mime_type = "image/png"
        else:
            output_format = "jpeg"
            mime_type = "image/jpeg"

        # Build processing pipeline (operations queued, not executed yet)

        # Step 1: Handle transparency
        if has_alpha and output_format == "jpeg":
            # Flatten alpha channel onto white background
            image = image.flatten(background=[255, 255, 255])  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

        # Step 2: Handle color space conversions
        # libvips handles most conversions automatically, but ensure sRGB for web
        if image.interpretation != "srgb":  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            # Convert to sRGB if not already
            if image.interpretation in ["cmyk", "lab", "xyz"]:  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
                image = image.colourspace("srgb")  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

        # Step 3: Resize if needed (downscale only, never upscale)
        if max_width or max_height:
            # Only resize if image exceeds max dimensions
            current_width = image.width  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            current_height = image.height  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            needs_resize = (max_width and current_width > max_width) or (max_height and current_height > max_height)

            if needs_resize:
                # Resize to fit within max dimensions while maintaining aspect ratio
                # thumbnail_image handles None values - it will scale to fit the constraint
                image = image.thumbnail_image(max_width or 10000000, height=max_height or 10000000)  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

        # Step 4: Convert to output format
        # Pipeline executes NOW when we call save
        # Use centralized settings from IMAGE_SETTINGS
        pipeline_finished = time.perf_counter()
        if debug_enabled:
            logger.debug(
                "Image pipeline ready: filename=%r source=%sx%s output=%sx%s bands=%s format=%s "
                "metadata_ms=%.1f pipeline_setup_ms=%.1f evaluation=lazy",
                filename,
                source_width,
                source_height,
                image.width,
                image.height,
                image.bands,
                output_format,
                (metadata_finished - start_time) * MILLISECONDS_PER_SECOND,
                (pipeline_finished - metadata_finished) * MILLISECONDS_PER_SECOND,
            )
        evaluation_started = time.perf_counter()
        if output_format == "webp":
            # WebP: good compression, wide browser support
            # Q=80 provides good balance between quality and file size
            output_bytes = image.webpsave_buffer(Q=80, strip=True)  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        elif output_format == "jpeg":
            jpeg_kwargs = get_libvips_jpeg_kwargs()
            output_bytes = image.jpegsave_buffer(**jpeg_kwargs)  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        else:  # PNG
            png_kwargs = get_libvips_png_kwargs()
            output_bytes = image.pngsave_buffer(**png_kwargs)  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

        evaluation_finished = time.perf_counter()
        # Convert pyvips buffer to bytes
        result_bytes = bytes(output_bytes)
        duration_ms = (time.perf_counter() - start_time) * 1000
        if debug_enabled:
            logger.debug(
                "Image evaluation complete: filename=%r evaluate_encode_ms=%.1f output_bytes=%d total_ms=%.1f",
                filename,
                (evaluation_finished - evaluation_started) * MILLISECONDS_PER_SECOND,
                len(result_bytes),
                duration_ms,
            )
            _log_image_cpu_timing(filename, started_cpu, cpu_before)

        # Extract just the filename from the path
        basename = os.path.basename(filename)

        logger.debug(
            f"libvips: {basename} → {mime_type} ({len(image_bytes) / 1024:.0f} → {len(result_bytes) / 1024:.0f} KB, {duration_ms:.0f} ms)"
        )
        return result_bytes, mime_type, "libvips", duration_ms

    except pyvips.Error as e:
        error_msg = str(e)

        # Check for missing loader (e.g., HEIC support)
        # Distinguish between "format not supported" vs "corrupt data"
        if "no known loader" in error_msg.lower():
            # This is truly an unsupported format
            if extension in {".heic", ".heif"}:
                raise ImportError("HEIC/HEIF support requires libvips built with libheif. Please ensure libheif is installed.") from e
            raise ImportError(f"Image format {extension} not supported. libvips may be missing required loader.") from e
        elif "unable to load from buffer" in error_msg.lower() or "not in a known format" in error_msg.lower():
            # This is corrupt/invalid image data
            raise ValueError(f"Failed to convert image: {error_msg}") from e

        # Generic conversion error
        raise ValueError(f"Failed to convert image: {error_msg}") from e

    except Exception as e:
        raise ValueError(f"Failed to convert image: {str(e)}") from e


def get_image_info(image_bytes: bytes) -> dict[str, Any]:
    """
    Get information about an image without conversion.

    Args:
        image_bytes: Raw image file bytes

    Returns:
        Dictionary with image information (format, size, mode, etc.)
    """
    if not VIPS_AVAILABLE:
        raise ImportError("libvips is not available")

    try:
        # Load image metadata only (lazy loading)
        image = pyvips.Image.new_from_buffer(image_bytes, "")

        # Extract metadata
        return {
            "format": image.get("vips-loader")  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            if image.get_typeof("vips-loader") != 0  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            else "unknown",
            "mode": image.interpretation,  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            "size": (image.width, image.height),  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            "width": image.width,  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            "height": image.height,  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            "bands": image.bands,  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            "has_alpha": image.hasalpha(),  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            "info": {
                "interpretation": image.interpretation,  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
                "format": image.format,  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
                "coding": image.coding,  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
            },
        }
    except Exception as e:
        raise ValueError(f"Failed to read image info: {str(e)}") from e
