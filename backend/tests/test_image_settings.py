"""Tests for image conversion settings module."""

import pytest

from app.core.image_settings import (
    IMAGE_SETTINGS,
    ImageConversionSettings,
    get_imagemagick_jpeg_args,
    get_imagemagick_png_args,
    get_imagemagick_webp_args,
    get_libvips_jpeg_kwargs,
    get_libvips_png_kwargs,
    get_libvips_webp_kwargs,
)


class TestImageConversionSettings:
    """Test the ImageConversionSettings dataclass."""

    def test_default_settings(self):
        """Verify default settings values."""
        settings = ImageConversionSettings()
        assert settings.jpeg_quality == 85
        assert settings.jpeg_optimize_coding is True
        assert settings.jpeg_progressive is False
        assert settings.png_compression == 6
        assert settings.strip_metadata is True
        assert settings.color_space == "srgb"
        assert settings.jpeg_background == (255, 255, 255)

    def test_settings_immutable(self):
        """Settings should be frozen (immutable)."""
        settings = ImageConversionSettings()
        with pytest.raises(AttributeError):
            settings.jpeg_quality = 90  # type: ignore

    def test_global_instance_exists(self):
        """Global IMAGE_SETTINGS instance should exist."""
        assert IMAGE_SETTINGS is not None
        assert isinstance(IMAGE_SETTINGS, ImageConversionSettings)


class TestImageMagickArgs:
    """Test ImageMagick command argument generation."""

    def test_jpeg_args_default(self):
        """Verify default JPEG arguments."""
        args = get_imagemagick_jpeg_args()
        assert "-quality" in args
        assert "85" in args
        assert "-strip" in args

    def test_jpeg_args_custom_quality(self):
        """Verify custom quality setting."""
        settings = ImageConversionSettings(jpeg_quality=95)
        args = get_imagemagick_jpeg_args(settings)
        assert "-quality" in args
        assert "95" in args

    def test_jpeg_args_no_strip(self):
        """Verify metadata stripping can be disabled."""
        settings = ImageConversionSettings(strip_metadata=False)
        args = get_imagemagick_jpeg_args(settings)
        assert "-strip" not in args

    def test_png_args_default(self):
        """Verify default PNG arguments."""
        args = get_imagemagick_png_args()
        assert "-quality" in args
        assert "92" in args  # Maps to compression 6
        assert "-strip" in args

    def test_png_args_no_strip(self):
        """Verify metadata stripping can be disabled for PNG."""
        settings = ImageConversionSettings(strip_metadata=False)
        args = get_imagemagick_png_args(settings)
        assert "-strip" not in args


class TestLibvipsKwargs:
    """Test libvips keyword argument generation."""

    def test_jpeg_kwargs_default(self):
        """Verify default JPEG kwargs for libvips."""
        kwargs = get_libvips_jpeg_kwargs()
        assert kwargs["Q"] == 85
        assert kwargs["optimize_coding"] is True
        assert kwargs["keep"] == 0  # Strip metadata
        assert kwargs["interlace"] is False  # Not progressive

    def test_jpeg_kwargs_custom_quality(self):
        """Verify custom quality setting for libvips."""
        settings = ImageConversionSettings(jpeg_quality=90)
        kwargs = get_libvips_jpeg_kwargs(settings)
        assert kwargs["Q"] == 90

    def test_jpeg_kwargs_progressive(self):
        """Verify progressive JPEG setting."""
        settings = ImageConversionSettings(jpeg_progressive=True)
        kwargs = get_libvips_jpeg_kwargs(settings)
        assert kwargs["interlace"] is True

    def test_jpeg_kwargs_keep_metadata(self):
        """Verify metadata can be kept."""
        settings = ImageConversionSettings(strip_metadata=False)
        kwargs = get_libvips_jpeg_kwargs(settings)
        assert kwargs["keep"] == 1  # Keep metadata

    def test_png_kwargs_default(self):
        """Verify default PNG kwargs for libvips."""
        kwargs = get_libvips_png_kwargs()
        assert kwargs["compression"] == 6
        assert kwargs["keep"] == 0  # Strip metadata

    def test_png_kwargs_custom_compression(self):
        """Verify custom compression setting."""
        settings = ImageConversionSettings(png_compression=9)
        kwargs = get_libvips_png_kwargs(settings)
        assert kwargs["compression"] == 9

    def test_png_kwargs_keep_metadata(self):
        """Verify PNG metadata can be kept."""
        settings = ImageConversionSettings(strip_metadata=False)
        kwargs = get_libvips_png_kwargs(settings)
        assert kwargs["keep"] == 1


class TestSettingsConsistency:
    """Test consistency across different conversion backends."""

    def test_webp_settings_match_measured_encoding(self):
        assert get_libvips_webp_kwargs() == {"Q": 80, "strip": True}
        assert get_imagemagick_webp_args() == ["-quality", "80", "-define", "webp:method=4", "-strip"]

    def test_jpeg_quality_consistent(self):
        """JPEG quality should be same across supported backends."""
        im_args = get_imagemagick_jpeg_args()
        vips_kwargs = get_libvips_jpeg_kwargs()

        # Extract quality values
        im_quality = im_args[im_args.index("-quality") + 1]
        vips_quality = str(vips_kwargs["Q"])

        assert im_quality == vips_quality == "85"

    def test_metadata_stripping_consistent(self):
        """Metadata stripping should be consistent across supported backends."""
        im_args = get_imagemagick_jpeg_args()
        vips_kwargs = get_libvips_jpeg_kwargs()

        # All should strip metadata by default
        assert "-strip" in im_args
        assert vips_kwargs["keep"] == 0

    def test_custom_settings_applied_consistently(self):
        """Custom settings should apply to all supported backends."""
        custom = ImageConversionSettings(jpeg_quality=90, strip_metadata=False)

        im_args = get_imagemagick_jpeg_args(custom)
        vips_kwargs = get_libvips_jpeg_kwargs(custom)

        # Quality should be 90 everywhere
        assert "90" in im_args
        assert vips_kwargs["Q"] == 90

        # Metadata should be kept everywhere
        assert "-strip" not in im_args
        assert vips_kwargs["keep"] == 1
