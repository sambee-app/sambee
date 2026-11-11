"""
Image preprocessing service for formats not natively supported by libvips.

This module provides a preprocessing pipeline that converts exotic image formats
(like PSD, PSB, EPS, and AI) directly into browser-ready formats (JPEG, PNG, WebP).
The preprocessor uses ImageMagick to handle formats that libvips doesn't
natively support.

Architecture:
- PreprocessorInterface: Abstract base class for all preprocessors
- ImageMagickPreprocessor: ImageMagick-based implementation
- PreprocessorRegistry: Maps file formats to preprocessors
- PreprocessorFactory: Creates preprocessor instances based on configuration

Design Principles:
1. Direct conversion - preprocess straight to browser-ready format (no intermediate)
2. Centralized settings - all conversion settings from IMAGE_SETTINGS
3. Security first - validate inputs, sanitize paths, timeout operations
4. Performance matters - single conversion step, efficient temp file handling
5. Fail gracefully - return clear errors, don't crash the service
"""

import logging
import os
import subprocess
import tempfile
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from app.core.exceptions import SambeeError
from app.core.image_settings import (
    WEBP_MAX_DIMENSION,
    get_imagemagick_jpeg_args,
    get_imagemagick_png_args,
    get_imagemagick_webp_args,
)
from app.core.system_setting_definitions import SystemSettingKey
from app.services.system_settings import get_integer_setting_value

logger = logging.getLogger(__name__)
IMAGEMAGICK_7_VERSION_MARKER = b"ImageMagick 7."


class PreprocessorError(SambeeError):
    """Base exception for preprocessor errors."""

    pass


class PreprocessorFileTooLargeError(PreprocessorError):
    """Raised when a file exceeds the configured preprocessing size limit."""

    def __init__(self, file_size: int, max_file_size: int) -> None:
        self.file_size = file_size
        self.max_file_size = max_file_size
        super().__init__(f"File too large: {file_size} bytes (max: {max_file_size})")


class PreprocessorInterface(ABC):
    """
    Abstract base class for image preprocessors.

    Preprocessors convert exotic formats directly into browser-ready formats
    (JPEG, PNG, WebP). All conversion settings come from centralized IMAGE_SETTINGS.
    """

    # Formats this preprocessor can handle
    SUPPORTED_FORMATS: set[str] = set()
    MAX_FILE_SIZE_SETTING_KEY: SystemSettingKey
    TIMEOUT_SECONDS_SETTING_KEY: SystemSettingKey

    #
    # convert_to_final_format
    #
    @abstractmethod
    def convert_to_final_format(
        self, input_data: bytes, filename: str, output_format: str = "jpeg", *, colorspace: str | None = None
    ) -> bytes:
        """
        Convert an exotic format file directly to browser-ready format.

        Always applies browser-optimized settings from IMAGE_SETTINGS.
        This is a direct conversion with no intermediate steps.
        Operates entirely in memory - no disk I/O.

        Args:
            input_data: Raw image file bytes (e.g., PSD file contents)
            filename: Original filename (for logging and validation)
            output_format: Target browser format (jpeg, png, webp). Default: jpeg
            colorspace: Previously detected colorspace, if available.

        Returns:
            Converted image bytes (in-memory, not written to disk)

        Raises:
            PreprocessorError: If conversion fails
            ValueError: If file too large or format unsupported
        """
        pass

    #
    # check_availability
    #
    @abstractmethod
    def check_availability(self) -> bool:
        """
        Check if the preprocessor tool is available on the system.

        Returns:
            True if the tool is installed and accessible, False otherwise
        """
        pass

    #
    # validate_input
    #
    def validate_input(self, input_data: bytes, filename: str) -> None:
        """
        Validate input data before processing.

        Args:
            input_data: Raw image file bytes
            filename: Original filename (for extension validation)

        Raises:
            ValueError: If data is empty, file is too large, or has invalid extension
        """

        # Check for empty data
        if not input_data or len(input_data) == 0:
            raise PreprocessorError("Empty input data")

        # Check file size
        file_size = len(input_data)
        max_file_size = self.get_max_file_size()
        if file_size > max_file_size:
            raise PreprocessorFileTooLargeError(file_size, max_file_size)

        # Check extension from filename
        extension = Path(filename).suffix.lower().lstrip(".")
        if extension not in self.SUPPORTED_FORMATS:
            raise PreprocessorError(f"Unsupported format: {extension}. Supported: {', '.join(sorted(self.SUPPORTED_FORMATS))}")

    #
    # _create_temp_file
    #
    def _create_temp_file(self, suffix: str) -> Path:
        """
        Create a temporary file for intermediate output.

        Args:
            suffix: File suffix (e.g., '.png')

        Returns:
            Path to the temporary file
        """

        fd, temp_path = tempfile.mkstemp(suffix=suffix, prefix="sambee_preprocessed_")
        os.close(fd)  # Close the file descriptor, we only need the path
        return Path(temp_path)

    def get_max_file_size(self) -> int:
        return get_integer_setting_value(self.MAX_FILE_SIZE_SETTING_KEY)

    def get_timeout_seconds(self) -> int:
        return get_integer_setting_value(self.TIMEOUT_SECONDS_SETTING_KEY)

    @property
    def MAX_FILE_SIZE(self) -> int:
        return self.get_max_file_size()

    @property
    def TIMEOUT_SECONDS(self) -> int:
        return self.get_timeout_seconds()


class ImageMagickPreprocessor(PreprocessorInterface):
    """
    ImageMagick-based preprocessor for formats libvips cannot decode directly.

    ImageMagick advantages:
    - Better support for complex PSD features (adjustment layers, smart objects)
    - More actively maintained
    - Better font rendering

    Supported formats:
    - PSD, PSB (Photoshop Document, Photoshop Big)
    - EPS (Encapsulated PostScript)
    - AI (Adobe Illustrator)
    """

    SUPPORTED_FORMATS = {"psd", "psb", "eps", "ai"}
    MAX_FILE_SIZE_SETTING_KEY = SystemSettingKey.PREPROCESSOR_IMAGEMAGICK_MAX_FILE_SIZE_BYTES
    TIMEOUT_SECONDS_SETTING_KEY = SystemSettingKey.PREPROCESSOR_IMAGEMAGICK_TIMEOUT_SECONDS

    #
    # __init__
    #
    def __init__(self) -> None:
        """Initialize the ImageMagick preprocessor."""

        self.magick_command = "magick"

    #
    # check_availability
    #
    def check_availability(self) -> bool:
        """Check whether ImageMagick 7 is installed and accessible."""

        try:
            result = subprocess.run(
                [self.magick_command, "--version"],
                capture_output=True,
                timeout=5,
                check=False,
            )
            return result.returncode == 0 and IMAGEMAGICK_7_VERSION_MARKER in (result.stdout or b"")
        except (subprocess.SubprocessError, FileNotFoundError):
            return False

    #
    # _get_command
    #
    def _get_command(self) -> str:
        """Return the required ImageMagick 7 command."""

        if not self.check_availability():
            raise PreprocessorError("ImageMagick 7 is required but not available")

        return self.magick_command

    #
    # _detect_colorspace
    #
    def inspect_image(self, input_data: bytes, filename: str, *, dimensions: bool = False) -> tuple[str, bool]:
        """Use one tolerant identify probe for colorspace and optional WebP size eligibility."""

        try:
            command_name = self._get_command()
            extension = Path(filename).suffix.lower().lstrip(".")

            # Use ImageMagick to identify colorspace
            command = [
                command_name,
                "identify",
                "-format",
                "%[colorspace] %w %h" if dimensions else "%[colorspace]",
                f"{extension}:-[0]",
            ]

            try:
                result = subprocess.run(
                    command,
                    input=input_data,
                    capture_output=True,
                    timeout=30,
                    check=True,
                )
                metadata = result.stdout.decode().strip().split()
                colorspace = metadata[0] if metadata else "Unknown"
                fits_webp = False
                if dimensions and len(metadata) == 3:
                    try:
                        width, height = int(metadata[1]), int(metadata[2])
                        fits_webp = 0 < width <= WEBP_MAX_DIMENSION and 0 < height <= WEBP_MAX_DIMENSION
                    except ValueError:
                        pass
                return colorspace, fits_webp
            except subprocess.CalledProcessError:
                logger.debug("Could not detect colorspace for %s", filename)
                return "Unknown", False

        except subprocess.TimeoutExpired:
            logger.warning(f"Colorspace detection timed out for {filename}")
            return "Unknown", False
        except Exception as e:
            logger.warning(f"Error detecting colorspace for {filename}: {e}")
            return "Unknown", False

    def _detect_colorspace(self, input_data: bytes, filename: str) -> str:
        return self.inspect_image(input_data, filename)[0]

    #
    # convert_to_final_format
    #
    def convert_to_final_format(
        self, input_data: bytes, filename: str, output_format: str = "jpeg", *, colorspace: str | None = None
    ) -> bytes:
        """
        Convert PSD/PSB directly to browser-ready format using ImageMagick.

        Applies browser-optimized settings from IMAGE_SETTINGS.
        Returns image bytes in memory without writing to disk.
        Operates entirely in memory - no disk I/O.

        Args:
            input_data: Raw PSD/PSB file bytes
            filename: Original filename (for logging and validation)
            output_format: Browser format (jpeg, png, webp). Default: jpeg
            colorspace: Previously detected colorspace; avoids another identify call.

        Returns:
            Converted image bytes (in-memory)

        Raises:
            PreprocessorError: If conversion fails
        """
        # Validate input
        self.validate_input(input_data, filename)

        # Check tool availability
        if not self.check_availability():
            raise PreprocessorError("ImageMagick is not installed or not accessible. Install with: apt-get install imagemagick")

        # Validate output format
        valid_formats = {"png", "jpeg", "jpg", "webp"}
        if output_format.lower() not in valid_formats:
            raise PreprocessorError(f"Invalid output format: {output_format}. Valid formats: {', '.join(sorted(valid_formats))}")

        # Normalize format
        if output_format.lower() == "jpg":
            output_format = "jpeg"

        try:
            # Determine which command to use (IM6 vs IM7)
            command_name = self._get_command()

            # Get file extension for format hint
            extension = Path(filename).suffix.lower().lstrip(".")

            # Build ImageMagick command
            # Note: ImageMagick 7 requires input file BEFORE operations
            # {format}:- reads from stdin, {format}:- writes to stdout
            command = [command_name]

            # For vector formats (EPS, AI), set density for quality rendering
            # 300 DPI is standard for print quality and looks good on screen
            if extension in {"eps", "ai"}:
                command.extend(["-density", "300"])

            # Input from stdin with format hint
            command.append(f"{extension}:-[0]")  # [0] selects the flattened composite

            # Auto-orient first (before any transformations)
            command.append("-auto-orient")

            # Detect colorspace for proper CMYK→RGB conversion
            # Apply to PSD/PSB/EPS/AI files (all can be in CMYK for print workflows)
            if extension in {"psd", "psb", "eps", "ai"}:
                # Flatten layers for PSD/PSB (merge all layers)
                # Don't flatten EPS/AI to preserve transparency
                if extension in {"psd", "psb"}:
                    command.append("-flatten")

                # Detect colorspace to apply correct conversion
                if colorspace is None:
                    colorspace = self._detect_colorspace(input_data, filename)

                if colorspace == "CMYK":
                    # CMYK → sRGB with ICC profile conversion
                    # Apply CMYK profile, then convert to sRGB profile
                    # Note: Requires libgs-common package for ICC profiles
                    command.extend(
                        [
                            "-profile",
                            "/usr/share/color/icc/ghostscript/default_cmyk.icc",
                            "-profile",
                            "/usr/share/color/icc/ghostscript/srgb.icc",
                        ]
                    )
                else:
                    # RGB/sRGB/Other → sRGB with simple colorspace conversion
                    # This handles RGB, sRGB, Gray, etc. without color inversion
                    command.extend(["-colorspace", "sRGB"])

            # Add browser-optimized settings from centralized config
            if output_format == "jpeg":
                command.extend(get_imagemagick_jpeg_args())
            elif output_format == "png":
                command.extend(get_imagemagick_png_args())
            elif output_format == "webp":
                command.extend(get_imagemagick_webp_args())

            # Output to stdout in specified format
            command.append(f"{output_format}:-")

            # Execute conversion - pipe input via stdin, capture stdout
            try:
                result = subprocess.run(
                    command,
                    input=input_data,  # Send data via stdin
                    capture_output=True,
                    timeout=self.get_timeout_seconds(),
                    check=True,
                )
            except subprocess.CalledProcessError as e:
                error_msg = e.stderr.decode("utf-8", errors="replace") if e.stderr else "Unknown error"
                logger.debug("ImageMagick failed to convert %s: %s", filename, error_msg)
                raise PreprocessorError("The image could not be converted.") from None

            # Verify output was produced
            if not result.stdout or len(result.stdout) == 0:
                raise PreprocessorError("Conversion produced no output")

            output_bytes = result.stdout

            return output_bytes

        except subprocess.TimeoutExpired:
            timeout_seconds = self.get_timeout_seconds()
            raise PreprocessorError(f"Conversion timed out after {timeout_seconds} seconds. File may be too complex or corrupted.")


class PreprocessorRegistry:
    """
    Central registry for preprocessor format mappings.

    This registry provides a single source of truth for which file formats
    require preprocessing and which preprocessor implementation to use.

    Usage:
        # Check if format needs preprocessing
        if PreprocessorRegistry.requires_preprocessing("psd"):
            preprocessor = PreprocessorRegistry.get_preprocessor_for_format("psd")

        # Get all preprocessable formats
        formats = PreprocessorRegistry.get_supported_formats()
    """

    # Format-to-preprocessor-type mapping
    # This is the single source of truth for preprocessor registrations
    _FORMAT_REGISTRY: dict[str, type[PreprocessorInterface]] = {
        # Adobe Photoshop formats - handled by ImageMagick
        "psd": ImageMagickPreprocessor,
        "psb": ImageMagickPreprocessor,
        # PostScript-based vector formats - handled by ImageMagick via Ghostscript
        "eps": ImageMagickPreprocessor,  # Encapsulated PostScript
        "ai": ImageMagickPreprocessor,  # Adobe Illustrator
    }

    #
    # requires_preprocessing
    #
    @classmethod
    def requires_preprocessing(cls, extension: str) -> bool:
        """
        Check if a file extension requires preprocessing.

        Args:
            extension: File extension (with or without dot, case-insensitive)

        Returns:
            True if the format requires preprocessing, False otherwise
        """

        # Normalize extension (remove dot, lowercase)
        ext = extension.lower().lstrip(".")
        return ext in cls._FORMAT_REGISTRY

    #
    # get_preprocessor_for_format
    #
    @classmethod
    def get_preprocessor_for_format(cls, extension: str, preprocessor_type: Optional[str] = None) -> PreprocessorInterface:
        """
        Get a preprocessor instance for the given file format.

        Args:
            extension: File extension (with or without dot, case-insensitive)
            preprocessor_type: Optional override for preprocessor type
                              ("imagemagick", "auto")
                              If None, uses default for this format.

        Returns:
            PreprocessorInterface instance

        Raises:
            ValueError: If format is not registered for preprocessing
            PreprocessorError: If preprocessor is not available
        """

        # Normalize extension
        ext = extension.lower().lstrip(".")

        if ext not in cls._FORMAT_REGISTRY:
            raise PreprocessorError(
                f"Format '{ext}' is not registered for preprocessing. Supported formats: {', '.join(sorted(cls._FORMAT_REGISTRY.keys()))}"
            )

        # If specific preprocessor type requested, use PreprocessorFactory
        if preprocessor_type is not None:
            return PreprocessorFactory.create(preprocessor_type)

        # Otherwise, use the registered default for this format
        preprocessor_class = cls._FORMAT_REGISTRY[ext]

        # Create instance and check availability
        instance = preprocessor_class()
        if not instance.check_availability():
            raise PreprocessorError(f"No available preprocessor for format '{ext}'. Install ImageMagick.")

        return instance

    #
    # get_supported_formats
    #
    @classmethod
    def get_supported_formats(cls) -> set[str]:
        """
        Get all file formats that have registered preprocessors.

        Returns:
            Set of file extensions (lowercase, without dot) that can be preprocessed
        """

        return set(cls._FORMAT_REGISTRY.keys())

    #
    # register_format
    #
    @classmethod
    def register_format(cls, extension: str, preprocessor_class: type[PreprocessorInterface]) -> None:
        """
        Register a new format with a preprocessor.

        This allows dynamic registration of new preprocessors at runtime.

        Args:
            extension: File extension (without dot, case-insensitive)
            preprocessor_class: Preprocessor class to handle this format

        Example:
            # Register a custom preprocessor for CDR files
            PreprocessorRegistry.register_format("cdr", CorelDrawPreprocessor)
        """

        ext = extension.lower().lstrip(".")
        cls._FORMAT_REGISTRY[ext] = preprocessor_class
        logger.info(f"Registered preprocessor {preprocessor_class.__name__} for .{ext} files")


class PreprocessorFactory:
    """
    Factory for creating preprocessor instances based on configuration.

    Configuration is controlled by the PREPROCESSOR environment variable:
    - "imagemagick": Use ImageMagick
    - "auto": Auto-detect available tool

    Note: For format-specific preprocessing, use PreprocessorRegistry instead.
    This factory is primarily for manual preprocessor creation.

    Usage:
        # Recommended: Use registry for format-based lookup
        preprocessor = PreprocessorRegistry.get_preprocessor_for_format("psd")

        # Alternative: Manual creation with factory
        preprocessor = PreprocessorFactory.create("imagemagick")
    """

    #
    # create
    #
    @staticmethod
    def create(preprocessor_type: Optional[str] = None) -> PreprocessorInterface:
        """
        Create a preprocessor instance.

        Args:
            preprocessor_type: Type of preprocessor to create.
                              If None, reads from PREPROCESSOR env var.
                              Valid values: "imagemagick", "auto"

        Returns:
            PreprocessorInterface instance

        Raises:
            PreprocessorError: If requested preprocessor is not available
        """

        # Get configuration
        if preprocessor_type is None:
            preprocessor_type = os.getenv("PREPROCESSOR", "auto").lower()

        # Auto-detect the single supported preprocessor.
        if preprocessor_type == "auto":
            im = ImageMagickPreprocessor()
            if im.check_availability():
                logger.info("Using ImageMagick preprocessor (auto-detected)")
                return im

            raise PreprocessorError("No preprocessor available. Install ImageMagick: apt-get install imagemagick")

        # ImageMagick explicitly requested
        elif preprocessor_type == "imagemagick":
            im = ImageMagickPreprocessor()
            if not im.check_availability():
                raise PreprocessorError("ImageMagick not available. Install with: apt-get install imagemagick")
            logger.info("Using ImageMagick preprocessor")
            return im

        else:
            raise PreprocessorError(f"Invalid preprocessor type: {preprocessor_type}. Valid values: imagemagick, auto")

    #
    # get_supported_formats
    #
    @staticmethod
    def get_supported_formats() -> set[str]:
        """
        Get all formats supported by available preprocessors.

        Returns:
            Set of supported file extensions (lowercase, without dot)
        """

        formats = set()

        # Check ImageMagick
        im = ImageMagickPreprocessor()
        if im.check_availability():
            formats.update(im.SUPPORTED_FORMATS)

        return formats
