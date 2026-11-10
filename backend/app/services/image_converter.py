"""
Image conversion service using libvips for high-performance processing.

Converts backend image previews according to the administrator preference.
Examples::
- Opaque raster → JPEG (speed) or WebP (size)
- ICO → PNG (preserves transparency)
- Fitting JPEG → original (speed) or smaller WebP (size)
- PSD/PSB → JPEG or WebP (via ImageMagick preprocessor)

Uses libvips for:
- Fast conversion
- Low memory usage
- Streaming, tiled processing
- Automatic multi-threading

For formats libvips doesn't natively support (PSD, PSB), we use
ImageMagick-based preprocessors to convert directly to a browser-ready format.
"""

import logging
import os
import platform
import time
from typing import Any, Optional

import pyvips

from app.core.image_settings import (
    ROTATED_EXIF_ORIENTATIONS,
    SOURCE_LOADER_OUTPUT_FORMATS,
    WEBP_MAX_DIMENSION,
    get_libvips_jpeg_kwargs,
    get_libvips_png_kwargs,
    get_libvips_webp_kwargs,
    select_viewer_output_format,
)
from app.core.system_setting_definitions import ImageConversionPreference
from app.services.preprocessor import (
    ImageMagickPreprocessor,
    PreprocessorError,
    PreprocessorFileTooLargeError,
    PreprocessorRegistry,
)

logger = logging.getLogger(__name__)
MILLISECONDS_PER_SECOND = 1000


def log_image_environment() -> None:
    """Log fixed converter diagnostics after application logging is configured."""
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(
            "Image environment: architecture=%s pyvips=%s libvips=%s cpu_count=%s available_cpu_count=%s "
            "VIPS_CONCURRENCY=%r VIPS_NOVECTOR=%r",
            platform.machine(),
            pyvips.__version__,
            ".".join(str(pyvips.version(index)) for index in range(3)),
            os.cpu_count(),
            os.process_cpu_count(),
            os.environ.get("VIPS_CONCURRENCY"),
            os.environ.get("VIPS_NOVECTOR"),
        )


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
    preference: ImageConversionPreference = ImageConversionPreference.SPEED,
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
        preference: Prefer encoding speed (default) or smaller transfer size.

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
            output_format = select_viewer_output_format(extension, False, preference)
            webp_fallback = "none"
            colorspace = None
            if output_format == "webp" and isinstance(preprocessor, ImageMagickPreprocessor):
                preprocessor.validate_input(image_bytes, filename)
                colorspace, fits_webp = preprocessor.inspect_image(image_bytes, filename, dimensions=True)
                if not fits_webp:
                    output_format = "jpeg"
                    webp_fallback = "jpeg"

            # Convert bytes directly - no temp files!
            if colorspace is None:
                result_bytes = preprocessor.convert_to_final_format(image_bytes, filename, output_format=output_format)
            else:
                result_bytes = preprocessor.convert_to_final_format(
                    image_bytes, filename, output_format=output_format, colorspace=colorspace
                )

            duration_ms = (time.perf_counter() - start_time) * MILLISECONDS_PER_SECOND
            mime_type = f"image/{output_format}"

            if debug_enabled:
                logger.debug(
                    "Image conversion: filename=%r path=preprocessor source=unknown output=unknown "
                    "format=%s output_bytes=%d setup_ms=0 encode_ms=%.1f preference=%s webp_fallback=%s",
                    filename,
                    output_format,
                    len(result_bytes),
                    duration_ms,
                    preference.value,
                    webp_fallback,
                )

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
        source_width, source_height = image.width, image.height
        orientation = image.get("orientation") if image.get_typeof("orientation") else None
        if orientation in ROTATED_EXIF_ORIENTATIONS:
            source_width, source_height = source_height, source_width
        needs_resize = bool((max_width and source_width > max_width) or (max_height and source_height > max_height))
        source_loader = image.get("vips-loader") if image.get_typeof("vips-loader") else ""
        source_output_format = SOURCE_LOADER_OUTPUT_FORMATS.get(source_loader)
        fitting_jpeg = source_output_format == "jpeg" and not needs_resize
        webp_fallback = "none"
        if fitting_jpeg and (preference is ImageConversionPreference.SPEED or max(source_width, source_height) > WEBP_MAX_DIMENSION):
            if preference is ImageConversionPreference.SIZE:
                webp_fallback = "original"
            duration_ms = (time.perf_counter() - start_time) * MILLISECONDS_PER_SECOND
            if debug_enabled:
                logger.debug(
                    "Image conversion: filename=%r path=original source=%sx%s output=%sx%s "
                    "format=jpeg output_bytes=%d setup_ms=%.1f encode_ms=0 preference=%s webp_fallback=%s",
                    filename,
                    source_width,
                    source_height,
                    source_width,
                    source_height,
                    len(image_bytes),
                    duration_ms,
                    preference.value,
                    webp_fallback,
                )
            return image_bytes, "image/jpeg", "original", duration_ms

        if needs_resize:
            image = pyvips.Image.thumbnail_buffer(image_bytes, max_width or source_width, height=max_height or source_height, size="down")
        else:
            image = image.autorot()

        # Determine output format based on transparency, file type, and user preference
        has_alpha = image.hasalpha()  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

        output_format = select_viewer_output_format(extension, has_alpha, preference)
        if output_format == "webp" and max(image.width, image.height) > WEBP_MAX_DIMENSION:
            output_format = "png" if has_alpha else "jpeg"
            webp_fallback = output_format

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

        # Step 4: Convert to output format
        # Pipeline executes NOW when we call save
        # Use centralized settings from IMAGE_SETTINGS
        evaluation_started = time.perf_counter() if debug_enabled else 0.0
        if output_format == "webp":
            # WebP: good compression, wide browser support
            # Q=80 provides good balance between quality and file size
            output_bytes = image.webpsave_buffer(**get_libvips_webp_kwargs())
        elif output_format == "jpeg":
            jpeg_kwargs = get_libvips_jpeg_kwargs()
            output_bytes = image.jpegsave_buffer(**jpeg_kwargs)  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        else:  # PNG
            png_kwargs = get_libvips_png_kwargs()
            output_bytes = image.pngsave_buffer(**png_kwargs)  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

        # Convert pyvips buffer to bytes
        result_bytes = bytes(output_bytes)
        converter_name = "libvips"
        if fitting_jpeg and len(result_bytes) >= len(image_bytes):
            result_bytes = image_bytes
            mime_type = "image/jpeg"
            output_format = "jpeg"
            converter_name = "original"
        duration_ms = (time.perf_counter() - start_time) * MILLISECONDS_PER_SECOND
        if debug_enabled:
            logger.debug(
                "Image conversion: filename=%r path=%s source=%sx%s output=%sx%s "
                "format=%s output_bytes=%d setup_ms=%.1f encode_ms=%.1f preference=%s webp_fallback=%s",
                filename,
                converter_name,
                source_width,
                source_height,
                image.width,
                image.height,
                output_format,
                len(result_bytes),
                (evaluation_started - start_time) * MILLISECONDS_PER_SECOND,
                (time.perf_counter() - evaluation_started) * MILLISECONDS_PER_SECOND,
                preference.value,
                webp_fallback,
            )
        return result_bytes, mime_type, converter_name, duration_ms

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
