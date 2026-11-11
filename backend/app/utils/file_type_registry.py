"""
File Type Registry - Single source of truth for file type information.

This module provides centralized file type definitions including:
- File extensions
- MIME types
- Category classification
- Image conversion requirements
- Descriptive names

This is the backend equivalent of frontend/src/utils/FileTypeRegistry.ts
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Optional

from app.core.system_setting_definitions import SystemSettingKey


class FileCategory(StrEnum):
    """Valid file type categories."""

    IMAGE = "image"
    DOCUMENT = "document"
    TEXT = "text"
    VIDEO = "video"
    AUDIO = "audio"
    ARCHIVE = "archive"
    CODE = "code"
    SPREADSHEET = "spreadsheet"
    DIRECTORY = "directory"
    OTHER = "other"


@dataclass(frozen=True)
class FileTypeDefinition:
    """
    Complete definition of a file type.

    Attributes:
        extensions: List of file extensions (including dot, e.g., [".jpg", ".jpeg"])
        mime_types: List of MIME types for this file type
        category: Category (image, document, text, video, audio, archive, code, other)
        requires_conversion: Whether image needs server-side conversion for browser display
        description: Human-readable description
    """

    extensions: tuple[str, ...]
    mime_types: tuple[str, ...]
    category: FileCategory
    requires_conversion: bool = False
    description: str = ""


# ============================================================================
# File Type Registry
# ============================================================================

FILE_TYPE_REGISTRY: list[FileTypeDefinition] = [
    # ========================================================================
    # Images - Browser-Native Formats
    # ========================================================================
    FileTypeDefinition(
        extensions=(".jpg", ".jpeg"),
        mime_types=("image/jpeg",),
        category=FileCategory.IMAGE,
        requires_conversion=False,
        description="JPEG Image",
    ),
    FileTypeDefinition(
        extensions=(".png",),
        mime_types=("image/png",),
        category=FileCategory.IMAGE,
        requires_conversion=False,
        description="PNG Image",
    ),
    FileTypeDefinition(
        extensions=(".gif",),
        mime_types=("image/gif",),
        category=FileCategory.IMAGE,
        requires_conversion=False,
        description="GIF Image",
    ),
    FileTypeDefinition(
        extensions=(".webp",),
        mime_types=("image/webp",),
        category=FileCategory.IMAGE,
        requires_conversion=False,
        description="WebP Image",
    ),
    FileTypeDefinition(
        extensions=(".svg",),
        mime_types=("image/svg+xml",),
        category=FileCategory.IMAGE,
        requires_conversion=False,
        description="SVG Vector",
    ),
    FileTypeDefinition(
        extensions=(".avif",),
        mime_types=("image/avif",),
        category=FileCategory.IMAGE,
        requires_conversion=False,
        description="AVIF Image",
    ),
    # ========================================================================
    # Images - Standard Formats (Require Conversion)
    # ========================================================================
    FileTypeDefinition(
        extensions=(".tif", ".tiff"),
        mime_types=("image/tiff",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="TIFF Image",
    ),
    FileTypeDefinition(
        extensions=(".heic",),
        mime_types=("image/heic",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="HEIC Image (iPhone)",
    ),
    FileTypeDefinition(
        extensions=(".heif",),
        mime_types=("image/heif",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="HEIF Image",
    ),
    FileTypeDefinition(
        extensions=(".bmp", ".dib"),
        mime_types=("image/bmp",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Windows Bitmap",
    ),
    FileTypeDefinition(
        extensions=(".ico",),
        mime_types=("image/vnd.microsoft.icon", "image/x-icon"),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Windows Icon",
    ),
    FileTypeDefinition(
        extensions=(".cur",),
        mime_types=("image/x-win-bitmap",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Windows Cursor",
    ),
    FileTypeDefinition(
        extensions=(".pcx",),
        mime_types=("image/x-pcx",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="PC Paintbrush",
    ),
    FileTypeDefinition(
        extensions=(".tga",),
        mime_types=("image/x-tga",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Truevision TGA/TARGA",
    ),
    FileTypeDefinition(
        extensions=(".ppm",),
        mime_types=("image/x-portable-pixmap",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Portable Pixmap (Netpbm)",
    ),
    FileTypeDefinition(
        extensions=(".pgm",),
        mime_types=("image/x-portable-graymap",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Portable Graymap (Netpbm)",
    ),
    FileTypeDefinition(
        extensions=(".pbm",),
        mime_types=("image/x-portable-bitmap",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Portable Bitmap (Netpbm)",
    ),
    FileTypeDefinition(
        extensions=(".pnm",),
        mime_types=("image/x-portable-anymap",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Portable Anymap (Netpbm)",
    ),
    FileTypeDefinition(
        extensions=(".xbm",),
        mime_types=("image/x-xbitmap",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="X11 Bitmap",
    ),
    FileTypeDefinition(
        extensions=(".xpm",),
        mime_types=("image/x-xpixmap",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="X11 Pixmap",
    ),
    # ========================================================================
    # Images - Advanced Formats (High Priority)
    # ========================================================================
    FileTypeDefinition(
        extensions=(".psd", ".psb"),
        mime_types=("image/vnd.adobe.photoshop", "image/x-photoshop"),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Adobe Photoshop Document",
    ),
    FileTypeDefinition(
        extensions=(".eps",),
        mime_types=("application/postscript", "image/x-eps"),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Encapsulated PostScript",
    ),
    FileTypeDefinition(
        extensions=(".ai",),
        mime_types=("application/postscript", "application/illustrator"),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Adobe Illustrator",
    ),
    FileTypeDefinition(
        extensions=(".jp2", ".j2k", ".jpt", ".j2c", ".jpc"),
        mime_types=("image/jp2", "image/jpx", "image/jpm"),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="JPEG 2000",
    ),
    FileTypeDefinition(
        extensions=(".jxl",),
        mime_types=("image/jxl",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="JPEG XL",
    ),
    FileTypeDefinition(
        extensions=(".exr",),
        mime_types=("image/x-exr",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="OpenEXR HDR",
    ),
    FileTypeDefinition(
        extensions=(".hdr",),
        mime_types=("image/vnd.radiance",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Radiance HDR",
    ),
    # ========================================================================
    # Images - Scientific/Medical Formats (Medium Priority)
    # ========================================================================
    FileTypeDefinition(
        extensions=(".fits", ".fit", ".fts"),
        mime_types=("image/fits", "application/fits"),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="FITS Astronomy",
    ),
    FileTypeDefinition(
        extensions=(".svs", ".ndpi", ".scn", ".mrxs", ".vms", ".vmu", ".bif"),
        mime_types=("image/x-whole-slide",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Whole-Slide Image",
    ),
    FileTypeDefinition(
        extensions=(".img",),
        mime_types=("image/x-img", "application/x-analyze"),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="Medical Imaging",
    ),
    FileTypeDefinition(
        extensions=(".mat",),
        mime_types=("application/x-matlab-data",),
        category=FileCategory.IMAGE,
        requires_conversion=True,
        description="MATLAB Image Data",
    ),
    # ========================================================================
    # Documents
    # ========================================================================
    FileTypeDefinition(
        extensions=(".pdf",),
        mime_types=("application/pdf",),
        category=FileCategory.DOCUMENT,
        description="PDF Document",
    ),
    FileTypeDefinition(
        extensions=(".doc",),
        mime_types=("application/msword",),
        category=FileCategory.DOCUMENT,
        description="Word Document",
    ),
    FileTypeDefinition(
        extensions=(".docx",),
        mime_types=("application/vnd.openxmlformats-officedocument.wordprocessingml.document",),
        category=FileCategory.DOCUMENT,
        description="Word Document",
    ),
    # ========================================================================
    # Text/Markdown
    # ========================================================================
    FileTypeDefinition(
        extensions=(".md", ".markdown"),
        mime_types=("text/markdown", "text/x-markdown"),
        category=FileCategory.TEXT,
        description="Markdown",
    ),
    FileTypeDefinition(
        extensions=(".txt",),
        mime_types=("text/plain",),
        category=FileCategory.TEXT,
        description="Text File",
    ),
    # ========================================================================
    # Archives
    # ========================================================================
    FileTypeDefinition(
        extensions=(".zip",),
        mime_types=("application/zip",),
        category=FileCategory.ARCHIVE,
        description="ZIP Archive",
    ),
    FileTypeDefinition(
        extensions=(".tar",),
        mime_types=("application/x-tar",),
        category=FileCategory.ARCHIVE,
        description="TAR Archive",
    ),
    FileTypeDefinition(
        extensions=(".gz",),
        mime_types=("application/gzip",),
        category=FileCategory.ARCHIVE,
        description="GZip Archive",
    ),
    FileTypeDefinition(
        extensions=(".7z",),
        mime_types=("application/x-7z-compressed",),
        category=FileCategory.ARCHIVE,
        description="7-Zip Archive",
    ),
    FileTypeDefinition(
        extensions=(".rar",),
        mime_types=("application/vnd.rar",),
        category=FileCategory.ARCHIVE,
        description="RAR Archive",
    ),
]

# ============================================================================
# Index Maps (for fast lookups)
# ============================================================================

_extension_map: dict[str, FileTypeDefinition] = {}
_mime_type_map: dict[str, FileTypeDefinition] = {}

# Build indexes
for file_type in FILE_TYPE_REGISTRY:
    for ext in file_type.extensions:
        _extension_map[ext.lower()] = file_type
    for mime in file_type.mime_types:
        _mime_type_map[mime.lower()] = file_type


# ============================================================================
# Query Functions
# ============================================================================


#
# get_file_type_by_extension
#
def get_file_type_by_extension(filename: str) -> Optional[FileTypeDefinition]:
    """
    Get file type definition by filename/extension.

    Args:
        filename: The filename or path

    Returns:
        FileTypeDefinition if found, None otherwise
    """

    if "." not in filename:
        return None
    ext = f".{filename.lower().rsplit('.', 1)[-1]}"
    return _extension_map.get(ext)


#
# get_file_type_by_mime
#
def get_file_type_by_mime(mime_type: str) -> Optional[FileTypeDefinition]:
    """
    Get file type definition by MIME type.

    Args:
        mime_type: The MIME type string

    Returns:
        FileTypeDefinition if found, None otherwise
    """

    return _mime_type_map.get(mime_type.lower())


#
# get_mime_type
#
def get_mime_type(filename: str, fallback: str = "application/octet-stream") -> str:
    """
    Get MIME type for a filename.

    First checks the registry, then falls back to Python's mimetypes module,
    then returns the fallback value.

    Args:
        filename: The filename or path
        fallback: Default MIME type if no match found

    Returns:
        MIME type string
    """

    # Try registry first
    file_type = get_file_type_by_extension(filename)
    if file_type:
        return file_type.mime_types[0]

    # Fall back to Python's mimetypes module
    import mimetypes

    mime_type, _ = mimetypes.guess_type(filename)
    if mime_type:
        return mime_type

    return fallback


#
# is_image_file
#
def is_image_file(filename: str) -> bool:
    """
    Check if a file is an image.

    Args:
        filename: The filename or path

    Returns:
        True if the file is an image format
    """

    file_type = get_file_type_by_extension(filename)
    return file_type is not None and file_type.category == FileCategory.IMAGE


#
# needs_processing
#
def needs_processing(filename: str, size: Optional[int] = None) -> bool:
    """
    Check if an image file needs conversion for browser display.

    Args:
        filename: The filename or path
        size: Optional size of the file in bytes

    Returns:
        True if the file needs conversion, False otherwise
    """

    # Check file type
    file_type = get_file_type_by_extension(filename)

    # Only process images - skip PDFs and other non-image files
    if file_type is None or file_type.category != FileCategory.IMAGE:
        return False

    # Image formats that require conversion (e.g., TIFF, HEIC)
    if file_type.requires_conversion:
        return True

    # Check file size against configured threshold (only for images)
    if size is not None:
        from app.services.system_settings import get_integer_setting_value

        return size > get_integer_setting_value(SystemSettingKey.IMAGE_CONVERSION_THRESHOLD_BYTES)

    return False


#
# get_image_formats_requiring_conversion
#
def get_image_formats_requiring_conversion() -> set[str]:
    """
    Get set of image file extensions that require conversion.

    Returns:
        Set of lowercase extensions with leading dot (e.g., {".tiff", ".heic"})
    """

    return {
        ext
        for file_type in FILE_TYPE_REGISTRY
        if file_type.category == FileCategory.IMAGE and file_type.requires_conversion
        for ext in file_type.extensions
    }


#
# get_browser_native_image_formats
#
def get_browser_native_image_formats() -> set[str]:
    """
    Get set of browser-native image file extensions.

    Returns:
        Set of lowercase extensions with leading dot (e.g., {".jpg", ".png"})
    """

    return {
        ext
        for file_type in FILE_TYPE_REGISTRY
        if file_type.category == FileCategory.IMAGE and not file_type.requires_conversion
        for ext in file_type.extensions
    }
