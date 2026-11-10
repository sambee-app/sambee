"""Tests for image conversion service using libvips."""

import logging
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import pyvips

from app.core.system_setting_definitions import ImageConversionPreference
from app.services.image_converter import (
    convert_image_for_viewer,
    get_image_info,
)
from app.services.preprocessor import PreprocessorError, PreprocessorFileTooLargeError, PreprocessorRegistry
from app.utils.file_type_registry import (
    is_image_file,
    needs_processing,
)


class TestImageFormatDetection:
    """Test image format detection functions."""

    def test_is_image_file_supported_formats(self):
        """Test is_image_file recognizes all supported formats."""
        supported = [
            "photo.jpg",
            "photo.jpeg",
            "photo.png",
            "photo.gif",
            "photo.webp",
            "photo.svg",
            "photo.tif",
            "photo.tiff",
            "photo.heic",
            "photo.heif",
            "photo.bmp",
            "photo.ico",
        ]
        for filename in supported:
            assert is_image_file(filename) is True, f"{filename} should be recognized"

    def test_is_image_file_unsupported_formats(self):
        """Test is_image_file rejects unsupported formats."""
        unsupported = ["document.pdf", "video.mp4", "text.txt", "archive.zip"]
        for filename in unsupported:
            assert is_image_file(filename) is False, f"{filename} should not be recognized"

    @pytest.mark.parametrize(
        "filename,size,expected",
        [
            # Browser-native formats below threshold - no processing
            ("photo.jpg", 100 * 1024, False),  # 100 KB JPEG
            ("photo.png", 250 * 1024, False),  # 250 KB PNG
            ("photo.webp", 499 * 1024, False),  # 499 KB WebP (just under threshold)
            ("photo.gif", 100 * 1024, False),  # 100 KB GIF
            # Browser-native formats above threshold - needs processing
            ("photo.jpg", 500 * 1024, False),  # 500 KB JPEG (exactly at threshold, but not over)
            ("photo.jpg", 500 * 1024 + 1, True),  # 500 KB + 1 byte JPEG (over threshold)
            ("photo.png", 501 * 1024, True),  # 501 KB PNG (over threshold)
            ("photo.webp", 1024 * 1024, True),  # 1 MB WebP
            ("photo.gif", 2 * 1024 * 1024, True),  # 2 MB GIF
            ("photo.jpeg", 10 * 1024 * 1024, True),  # 10 MB JPEG
            # Formats requiring conversion regardless of size
            ("photo.tiff", 100 * 1024, True),  # 100 KB TIFF - still needs conversion
            ("photo.tif", 100 * 1024, True),  # 100 KB TIF - still needs conversion
            ("PHOTO.TIFF", 100 * 1024, True),  # Case insensitive
            ("photo.heic", 50 * 1024, True),  # 50 KB HEIC - still needs conversion
            ("photo.heif", 50 * 1024, True),  # 50 KB HEIF - still needs conversion
            ("IMG_1234.HEIC", 50 * 1024, True),  # Case insensitive
            ("photo.bmp", 200 * 1024, True),  # 200 KB BMP - still needs conversion
            ("image.dib", 200 * 1024, True),  # DIB format
            ("icon.ico", 50 * 1024, True),  # ICO format
            ("vector.eps", 100 * 1024, True),  # EPS format
            ("VECTOR.EPS", 100 * 1024, True),  # Case insensitive
            ("illustration.ai", 100 * 1024, True),  # AI format
            ("ILLUSTRATION.AI", 100 * 1024, True),  # Case insensitive
            ("photo.psd", 100 * 1024, True),  # 100 KB PSD - still needs conversion
            # Formats requiring conversion, also large
            ("photo.tiff", 1024 * 1024, True),  # 1 MB TIFF - needs conversion (both reasons)
            ("photo.heic", 2 * 1024 * 1024, True),  # 2 MB HEIC - needs conversion (both reasons)
            # No size specified (None)
            ("photo.jpg", None, False),  # JPEG, no size - no processing
            ("photo.jpeg", None, False),  # JPEG variant
            ("photo.png", None, False),  # PNG, no size - no processing
            ("photo.webp", None, False),  # WebP, no size - no processing
            ("logo.svg", None, False),  # SVG, no size - no processing
            ("photo.tiff", None, True),  # TIFF, no size - still needs conversion
            ("photo.heic", None, True),  # HEIC, no size - still needs conversion
            ("photo.bmp", None, True),  # BMP, no size - still needs conversion
            # Edge cases
            ("photo.jpg", 0, False),  # 0 bytes - no processing
            ("photo.jpg", 1, False),  # 1 byte - no processing
            ("photo.jpg", 499 * 1024 + 1023, False),  # Just under 500 KB - no processing
        ],
    )
    def test_needs_processing_with_size(self, filename: str, size: int | None, expected: bool):
        """Test needs_processing correctly handles size parameter."""
        result = needs_processing(filename, size=size)
        assert result == expected, f"needs_processing('{filename}', size={size}) should return {expected}, got {result}"


class TestImageConversion:
    """Test image conversion functionality."""

    def create_test_image(self, mode: str = "RGB", size: tuple = (100, 100)) -> bytes:
        """Create a test image in memory using pyvips."""
        width, height = size

        if mode == "RGB":
            # Create RGB image
            image = pyvips.Image.black(width, height, bands=3)  # pyright: ignore[reportAttributeAccessIssue]
            image = image + [255, 0, 0]  # Red color
        elif mode == "RGBA":
            # Create RGBA image with transparency
            image = pyvips.Image.black(width, height, bands=4)  # pyright: ignore[reportAttributeAccessIssue]
            image = image + [255, 0, 0, 255]  # Red with full opacity
        elif mode == "L":
            # Create grayscale image
            image = pyvips.Image.black(width, height, bands=1)  # pyright: ignore[reportAttributeAccessIssue]
            image = image + 128  # Mid-gray
        elif mode == "P":
            # Palette mode - create RGB and we'll handle it
            image = pyvips.Image.black(width, height, bands=3)  # pyright: ignore[reportAttributeAccessIssue]
            image = image + [100, 100, 100]  # Gray color
        else:
            raise ValueError(f"Unsupported mode: {mode}")

        # Save to buffer as PNG
        return bytes(image.pngsave_buffer())

    def create_test_bmp(self, size: tuple = (100, 100)) -> bytes:
        """Create a test BMP image."""
        width, height = size
        image = pyvips.Image.black(width, height, bands=3)  # pyright: ignore[reportAttributeAccessIssue]
        image = image + [0, 255, 0]  # Green color

        # Save as BMP via magick (ImageMagick backend)
        try:
            return bytes(image.magicksave_buffer(format="BMP"))
        except Exception:
            # Fallback: save as PNG and we'll test with that
            return bytes(image.pngsave_buffer())

    def test_convert_rgb_to_jpeg(self):
        """Speed mode converts opaque sources to JPEG."""
        test_image = self.create_test_image("RGB", (200, 150))

        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(test_image, "test.png")

        assert mime_type == "image/jpeg"
        assert len(result_bytes) > 0

        # Verify it's a valid WebP using pyvips
        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        assert result_img.width == 200  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert result_img.height == 150  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert result_img.bands >= 3  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]  # RGB or grayscale

    def test_convert_rgb_size_preference(self):
        """Size mode converts opaque sources to WebP."""
        test_image = self.create_test_image("RGB", (200, 150))

        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(
            test_image, "test.png", preference=ImageConversionPreference.SIZE
        )

        assert mime_type == "image/webp"
        assert len(result_bytes) > 0

        # Verify it's a valid JPEG using pyvips
        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        assert result_img.width == 200  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert result_img.height == 150  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert result_img.bands >= 3  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]  # RGB or grayscale

    @pytest.mark.parametrize("orientation", [6, 8])
    @pytest.mark.parametrize("viewport,expected_size", [((800, 1200), (500, 1000)), ((400, 600), (300, 600))])
    def test_jpeg_orientation_and_original(self, orientation, viewport, expected_size):
        image = pyvips.Image.black(1000, 500, bands=3).copy(interpretation="srgb")
        image.set_type(pyvips.GValue.gint_type, "orientation", orientation)
        source = bytes(image.jpegsave_buffer())
        with patch.object(pyvips.Image, "thumbnail_buffer", wraps=pyvips.Image.thumbnail_buffer) as thumbnail:
            output, mime, converter, _ = convert_image_for_viewer(source, "photo.jpg", *viewport)
        assert mime == "image/jpeg"
        result = pyvips.Image.new_from_buffer(output, "").autorot()
        assert (result.width, result.height) == expected_size
        if viewport == (800, 1200):
            assert output == source
            assert converter == "original"
            thumbnail.assert_not_called()
        else:
            assert output != source
            assert converter == "libvips"
            thumbnail.assert_called_once()

    @pytest.mark.parametrize("orientation", [6, 8])
    @pytest.mark.parametrize("viewport,expected_size", [((800, 1200), (500, 1000)), ((400, 600), (300, 600))])
    def test_explicit_format_applies_orientation(self, orientation, viewport, expected_size):
        image = pyvips.Image.black(1000, 500, bands=3).copy(interpretation="srgb")
        image.set_type(pyvips.GValue.gint_type, "orientation", orientation)
        source = bytes(image.jpegsave_buffer())
        output, mime, _, _ = convert_image_for_viewer(source, "photo.jpg", *viewport, preference=ImageConversionPreference.SIZE)
        assert mime == "image/webp"
        result = pyvips.Image.new_from_buffer(output, "")
        assert (result.width, result.height) == expected_size

    def test_jpeg_original_without_viewport(self, caplog):
        source = bytes(pyvips.Image.black(100, 50, bands=3).jpegsave_buffer())
        with caplog.at_level(logging.DEBUG, logger="app.services.image_converter"):
            output, mime, converter, _ = convert_image_for_viewer(source, "photo.jpeg")
        assert (output, mime, converter) == (source, "image/jpeg", "original")
        assert "path=original" in caplog.text

    def test_content_not_extension_selects_jpeg_output(self):
        source = bytes(pyvips.Image.black(100, 50, bands=3).jpegsave_buffer())
        assert convert_image_for_viewer(source, "wrong.png")[1] == "image/jpeg"
        source = self.create_test_image()
        assert convert_image_for_viewer(source, "wrong.jpg")[2] == "libvips"

    def test_debug_timings_preserve_conversion(self, caplog: pytest.LogCaptureFixture):
        """Debug diagnostics describe lazy evaluation without changing output bytes."""
        test_image = self.create_test_image("RGB", (200, 150))
        expected = convert_image_for_viewer(test_image, "test.png", max_width=100)
        with caplog.at_level(logging.DEBUG, logger="app.services.image_converter"):
            actual = convert_image_for_viewer(test_image, "test.png", max_width=100)

        assert actual[:3] == expected[:3]
        assert "source=200x150 output=100x75" in caplog.text
        assert len(caplog.records) == 1
        for field in ("path=libvips", "setup_ms=", "encode_ms=", "output_bytes=", "format=jpeg", "preference=speed", "webp_fallback=none"):
            assert field in caplog.text

    def test_info_logging_skips_expensive_diagnostics(self, caplog: pytest.LogCaptureFixture):
        """Normal logging only reads the clock for the public duration result."""
        test_image = self.create_test_image()
        with (
            caplog.at_level(logging.INFO, logger="app.services.image_converter"),
            patch("app.services.image_converter.time.perf_counter", side_effect=[1.0, 2.0]) as clock,
        ):
            result = convert_image_for_viewer(test_image, "test.png")

        assert result[3] == 1000
        assert clock.call_count == 2
        assert not caplog.records

    def test_convert_rgba_to_jpeg(self):
        """Test converting RGBA image to WebP (preserves or removes alpha based on format)."""
        test_image = self.create_test_image("RGBA", (100, 100))

        # Default output is WebP which can preserve alpha
        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(test_image, "test.png")

        assert mime_type == "image/webp"

        # Verify image is valid
        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        assert result_img.width == 100  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert result_img.height == 100  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

    def test_convert_rgba_size_preference(self):
        """An alpha band retains WebP in size mode, even when fully opaque."""
        test_image = self.create_test_image("RGBA", (100, 100))

        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(
            test_image, "test.png", preference=ImageConversionPreference.SIZE
        )

        assert mime_type == "image/webp"

        # WebP retains this fixture's alpha band.
        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        assert result_img.hasalpha()
        assert result_img.bands == 4

    def test_convert_bmp_to_jpeg(self):
        """Test converting BMP to WebP (default)."""
        test_bmp = self.create_test_bmp((150, 200))

        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(test_bmp, "test.bmp")

        assert mime_type == "image/jpeg"
        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        assert result_img.width == 150  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert result_img.height == 200  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

    def test_convert_with_max_dimensions(self):
        """Test image resizing with max_width and max_height."""
        test_image = self.create_test_image("RGB", (3000, 2000))

        # Resize to 1000x800 max dimensions
        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(
            test_image, "large.png", max_width=1000, max_height=800
        )

        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        # Image should fit within max dimensions while maintaining aspect ratio
        assert result_img.width <= 1000  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert result_img.height <= 800  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        # Should maintain aspect ratio (3000:2000 = 3:2 = 1.5)
        original_aspect = 3000 / 2000
        result_aspect = result_img.width / result_img.height  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert abs(result_aspect - original_aspect) < 0.01  # Within 1% of original

    def test_convert_with_single_dimension_constraint(self):
        """Test image resizing with only width or height constraint."""
        test_image = self.create_test_image("RGB", (2000, 1500))

        # Test with only max_width
        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(test_image, "large.png", max_width=800)
        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        assert result_img.width <= 800  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert max(result_img.width, result_img.height) <= 800  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

    def test_convert_uses_image_settings(self):
        """Test that conversion uses centralized IMAGE_SETTINGS."""
        test_image = self.create_test_image("RGB", (500, 500))

        # Convert image - should use IMAGE_SETTINGS (quality=85 for JPEG, Q=80 for WebP)
        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(test_image, "test.png")

        # Verify it's a valid WebP (default format)
        assert mime_type == "image/jpeg"
        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        assert result_img.width == 500  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert result_img.height == 500  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

        # File size should be reasonable (solid color image compresses well)
        # Expect roughly 1-15 KB for a 500x500 solid color image (WebP compresses better than JPEG)
        assert 500 < len(result_bytes) < 20_000

    @pytest.mark.parametrize("preference", list(ImageConversionPreference))
    @pytest.mark.parametrize("extension,alpha", [(".png", False), (".tiff", False), (".png", True), (".ico", True)])
    def test_format_policy_signatures(self, preference, extension, alpha):
        source = self.create_test_image("RGBA" if alpha else "RGB")
        if extension == ".tiff":
            source = bytes(pyvips.Image.new_from_buffer(source, "").tiffsave_buffer())
        elif extension == ".ico":
            source = subprocess.run(["magick", "png:-", "ico:-"], input=source, capture_output=True, check=True).stdout
        output, mime, _, _ = convert_image_for_viewer(source, f"image{extension}", preference=preference)
        expected = "png" if extension == ".ico" else "webp" if alpha or preference is ImageConversionPreference.SIZE else "jpeg"
        assert mime == f"image/{expected}"
        assert pyvips.Image.new_from_buffer(output, "").get("vips-loader").startswith(expected)

    @pytest.mark.parametrize("alpha", [False, True])
    @pytest.mark.parametrize("preference", list(ImageConversionPreference))
    def test_webp_dimension_fallback(self, alpha, preference, caplog):
        source = self.create_test_image("RGBA" if alpha else "RGB", (16_384, 1))
        with caplog.at_level(logging.DEBUG, logger="app.services.image_converter"):
            output, mime, _, _ = convert_image_for_viewer(source, "wide.png", preference=preference)
        assert mime == ("image/png" if alpha else "image/jpeg")
        result = pyvips.Image.new_from_buffer(output, "")
        assert (result.width, result.height) == (16_384, 1)
        if alpha or preference is ImageConversionPreference.SIZE:
            assert f"webp_fallback={'png' if alpha else 'jpeg'}" in caplog.text

    def test_fitting_jpeg_above_webp_limit_is_original(self):
        source = bytes(pyvips.Image.black(16_384, 1, bands=3).jpegsave_buffer())
        output, mime, converter, _ = convert_image_for_viewer(source, "wide.jpg", preference=ImageConversionPreference.SIZE)
        assert (output, mime, converter) == (source, "image/jpeg", "original")

    def test_fitting_jpeg_keeps_original_when_webp_is_not_smaller(self):
        source = bytes(pyvips.Image.black(1, 1, bands=3).jpegsave_buffer())
        with patch.object(pyvips.Image, "webpsave_buffer", return_value=b"x" * len(source)):
            output, mime, converter, _ = convert_image_for_viewer(source, "tiny.jpg", preference=ImageConversionPreference.SIZE)
        assert (output, mime, converter) == (source, "image/jpeg", "original")

    @pytest.mark.parametrize("extension", ["psd", "psb", "eps", "ai"])
    @pytest.mark.parametrize("preference", list(ImageConversionPreference))
    def test_imagemagick_format_policy(self, extension, preference):
        source = (
            Path("tests/test_data/images/cmyk/photoshop_cmyk.psd").read_bytes()
            if extension in {"psd", "psb"}
            else Path("tests/test_data/images/rgb/postscript_rgb.eps").read_bytes()
        )
        if extension == "psb":
            source = subprocess.run(["magick", "psd:-[0]", "psb:-"], input=source, capture_output=True, check=True).stdout
        output, mime, _, _ = convert_image_for_viewer(source, f"image.{extension}", preference=preference)
        expected = "png" if extension in {"eps", "ai"} else "webp" if preference is ImageConversionPreference.SIZE else "jpeg"
        assert mime == f"image/{expected}"
        assert pyvips.Image.new_from_buffer(output, "").get("vips-loader").startswith(expected)

    @pytest.mark.parametrize("metadata", [("Unknown", False), ("sRGB", False)])
    def test_psd_size_falls_back_to_jpeg(self, metadata):
        from app.services.preprocessor import ImageMagickPreprocessor

        source = Path("tests/test_data/images/cmyk/photoshop_cmyk.psd").read_bytes()
        with patch.object(ImageMagickPreprocessor, "inspect_image", return_value=metadata):
            output, mime, _, _ = convert_image_for_viewer(source, "image.psd", preference=ImageConversionPreference.SIZE)
        assert mime == "image/jpeg"
        assert output.startswith(b"\xff\xd8")

    def test_invalid_image_raises_error(self):
        """Test that invalid image data raises ValueError."""
        invalid_data = b"This is not an image"

        with pytest.raises(ValueError, match="Failed to convert image"):
            convert_image_for_viewer(invalid_data, "test.jpg")

    def test_preprocessor_error_hides_converter_details(self, caplog: pytest.LogCaptureFixture):
        """Preprocessor diagnostics must not be exposed in the image viewer."""
        preprocessor = MagicMock()
        preprocessor.convert_to_final_format.side_effect = PreprocessorError(
            "ImageMagick conversion failed: improper image header /tmp/private-file"
        )

        with (
            patch("app.services.image_converter.VIPS_AVAILABLE", True),
            patch.object(PreprocessorRegistry, "get_preprocessor_for_format", return_value=preprocessor),
            pytest.raises(ValueError) as error,
        ):
            convert_image_for_viewer(b"invalid PSD", "image.psd")

        assert str(error.value) == "Unable to preview this PSD file. The file may be invalid or corrupted."
        assert "ImageMagick" not in str(error.value)
        assert "/tmp/private-file" not in str(error.value)
        assert not caplog.records

    def test_preprocessor_file_size_error_reaches_the_viewer(self):
        """The viewer API recognizes the configured size limit."""
        preprocessor = MagicMock()
        preprocessor.convert_to_final_format.side_effect = PreprocessorFileTooLargeError(368_050_000, 104_857_600)

        with (
            patch("app.services.image_converter.VIPS_AVAILABLE", True),
            patch.object(PreprocessorRegistry, "get_preprocessor_for_format", return_value=preprocessor),
            pytest.raises(PreprocessorFileTooLargeError) as error,
        ):
            convert_image_for_viewer(b"large PSD", "image.psd")

        assert error.value.file_size == 368_050_000
        assert error.value.max_file_size == 104_857_600

    def test_get_image_info(self):
        """Test getting image information."""
        test_image = self.create_test_image("RGB", (300, 200))

        info = get_image_info(test_image)

        # libvips returns different metadata structure
        assert info["width"] == 300
        assert info["height"] == 200
        assert info["size"] == (300, 200)
        assert isinstance(info["info"], dict)

    def test_get_image_info_invalid_data(self):
        """Test get_image_info with invalid data."""
        with pytest.raises(ValueError, match="Failed to read image info"):
            get_image_info(b"invalid")


class TestEdgeCases:
    """Test edge cases and special scenarios."""

    def test_grayscale_image_preserved(self):
        """Test that grayscale images are preserved."""
        image = pyvips.Image.black(100, 100, bands=1)  # pyright: ignore[reportAttributeAccessIssue]
        image = image + 128  # Mid-gray
        image_bytes = bytes(image.pngsave_buffer())

        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(image_bytes, "gray.png")

        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        # Grayscale can be stored as 1 or 3 bands in JPEG
        assert result_img.bands in (1, 3)  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]

    def test_palette_mode_conversion(self):
        """Test palette mode (P) images are converted."""
        # Create a simple RGB image (pyvips doesn't have palette mode like PIL)
        image = pyvips.Image.black(100, 100, bands=3)  # pyright: ignore[reportAttributeAccessIssue]
        image = image + [100, 100, 100]
        image_bytes = bytes(image.pngsave_buffer())

        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(image_bytes, "palette.png")

        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        assert result_img.bands >= 3  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]  # RGB

    def test_convert_eps_to_jpeg(self):
        """Test converting EPS file to PNG."""
        from app.services.preprocessor import PreprocessorError, PreprocessorRegistry

        # Skip if no preprocessor available
        try:
            PreprocessorRegistry.get_preprocessor_for_format("eps")
        except PreprocessorError:
            pytest.skip("No preprocessor available for EPS")

        # Minimal valid EPS file (draws a filled circle)
        eps_data = b"""%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 100 100
newpath
50 50 40 0 360 arc
0 setgray
fill
showpage
"""
        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(eps_data, "test.eps")

        assert mime_type == "image/png"
        assert len(result_bytes) > 0
        assert result_bytes.startswith(b"\x89PNG")  # PNG magic number
        assert converter_name == "ImageMagick"
        assert duration_ms > 0

    def test_convert_ai_to_jpeg(self):
        """Test converting AI file to PNG."""
        from app.services.preprocessor import PreprocessorError, PreprocessorRegistry

        # Skip if no preprocessor available
        try:
            PreprocessorRegistry.get_preprocessor_for_format("ai")
        except PreprocessorError:
            pytest.skip("No preprocessor available for AI")

        # Modern AI files are PDF-based - use minimal PDF
        ai_data = b"""%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>
endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer
<< /Size 4 /Root 1 0 R >>
startxref
219
%%EOF
"""
        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(ai_data, "test.ai")

        assert mime_type == "image/png"
        assert len(result_bytes) > 0
        assert result_bytes.startswith(b"\x89PNG")  # PNG magic number
        assert converter_name == "ImageMagick"
        assert duration_ms > 0

    def test_small_image_no_downscaling(self):
        """Test that small images are not upscaled."""
        image = pyvips.Image.black(50, 50, bands=3)  # pyright: ignore[reportAttributeAccessIssue]
        image = image + [255, 0, 0]
        image_bytes = bytes(image.pngsave_buffer())

        result_bytes, mime_type, converter_name, duration_ms = convert_image_for_viewer(
            image_bytes, "small.png", max_width=1000, max_height=1000
        )

        result_img = pyvips.Image.new_from_buffer(result_bytes, "")
        # Should remain 50x50, not upscaled
        assert result_img.width == 50  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
        assert result_img.height == 50  # pyright: ignore[reportOptionalMemberAccess, reportAttributeAccessIssue]
