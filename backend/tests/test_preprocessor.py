"""Tests for the ImageMagick-based preprocessing service."""

import os
import subprocess
from unittest.mock import MagicMock, patch

import pytest

from app.services.preprocessor import (
    ImageMagickPreprocessor,
    PreprocessorError,
    PreprocessorFactory,
    PreprocessorRegistry,
)


class TestPreprocessorRegistry:
    """Test the preprocessor registry functionality."""

    def test_requires_preprocessing_psd(self):
        """Test that PSD format is recognized as requiring preprocessing."""
        assert PreprocessorRegistry.requires_preprocessing("psd") is True
        assert PreprocessorRegistry.requires_preprocessing(".psd") is True
        assert PreprocessorRegistry.requires_preprocessing("PSD") is True
        assert PreprocessorRegistry.requires_preprocessing(".PSD") is True

    def test_requires_preprocessing_psb(self):
        """Test that PSB format is recognized as requiring preprocessing."""
        assert PreprocessorRegistry.requires_preprocessing("psb") is True
        assert PreprocessorRegistry.requires_preprocessing(".psb") is True

    def test_requires_preprocessing_non_preprocessed_format(self):
        """Test that non-preprocessed formats return False."""
        assert PreprocessorRegistry.requires_preprocessing("jpg") is False
        assert PreprocessorRegistry.requires_preprocessing("png") is False
        assert PreprocessorRegistry.requires_preprocessing("gif") is False
        assert PreprocessorRegistry.requires_preprocessing("unknown") is False

    def test_get_supported_formats(self):
        """Test that get_supported_formats returns all registered formats."""
        formats = PreprocessorRegistry.get_supported_formats()
        assert isinstance(formats, set)
        assert "psd" in formats
        assert "psb" in formats
        # Should be at least these two
        assert len(formats) >= 2

    def test_get_preprocessor_for_format_psd(self):
        """Test getting preprocessor for PSD format."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=True):
            preprocessor = PreprocessorRegistry.get_preprocessor_for_format("psd")
        assert isinstance(preprocessor, ImageMagickPreprocessor)
        assert hasattr(preprocessor, "convert_to_final_format")

    def test_get_preprocessor_for_format_invalid(self):
        """Test that invalid format raises PreprocessorError."""
        with pytest.raises(PreprocessorError, match="not registered for preprocessing"):
            PreprocessorRegistry.get_preprocessor_for_format("jpg")

    def test_get_preprocessor_for_format_with_override(self):
        """Test that preprocessor_type override works."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=True):
            preprocessor = PreprocessorRegistry.get_preprocessor_for_format("psd", preprocessor_type="imagemagick")
        assert isinstance(preprocessor, ImageMagickPreprocessor)

    def test_register_format_dynamic(self):
        """Test dynamic format registration."""

        # Create a mock preprocessor class
        class MockPreprocessor(ImageMagickPreprocessor):
            SUPPORTED_FORMATS = {"mock"}

        # Register new format
        PreprocessorRegistry.register_format("mock", MockPreprocessor)

        # Verify it's registered
        assert PreprocessorRegistry.requires_preprocessing("mock") is True
        assert "mock" in PreprocessorRegistry.get_supported_formats()

        # Clean up - remove the mock format
        if "mock" in PreprocessorRegistry._FORMAT_REGISTRY:
            del PreprocessorRegistry._FORMAT_REGISTRY["mock"]

    def test_requires_preprocessing_eps(self):
        """Test that EPS format is recognized as requiring preprocessing."""
        assert PreprocessorRegistry.requires_preprocessing("eps") is True
        assert PreprocessorRegistry.requires_preprocessing(".eps") is True
        assert PreprocessorRegistry.requires_preprocessing("EPS") is True

    def test_requires_preprocessing_ai(self):
        """Test that AI format is recognized as requiring preprocessing."""
        assert PreprocessorRegistry.requires_preprocessing("ai") is True
        assert PreprocessorRegistry.requires_preprocessing(".ai") is True
        assert PreprocessorRegistry.requires_preprocessing("AI") is True

    def test_get_preprocessor_for_eps(self):
        """Test getting preprocessor for EPS format."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=True):
            preprocessor = PreprocessorRegistry.get_preprocessor_for_format("eps")
        assert isinstance(preprocessor, ImageMagickPreprocessor)
        assert "eps" in preprocessor.SUPPORTED_FORMATS

    def test_get_preprocessor_for_ai(self):
        """Test getting preprocessor for AI format."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=True):
            preprocessor = PreprocessorRegistry.get_preprocessor_for_format("ai")
        assert isinstance(preprocessor, ImageMagickPreprocessor)
        assert "ai" in preprocessor.SUPPORTED_FORMATS

    def test_no_preprocessor_available_raises_error(self):
        """Test that PreprocessorError is raised when no preprocessor is available."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=False):
            with pytest.raises(PreprocessorError, match="No available preprocessor"):
                PreprocessorRegistry.get_preprocessor_for_format("psd")


class TestPreprocessorInterface:
    """Test the abstract base class functionality."""

    def test_validate_input_file_not_found(self, tmp_path):
        """Test that validate_input raises PreprocessorError for empty bytes."""
        preprocessor = ImageMagickPreprocessor()
        empty_bytes = b""

        with pytest.raises(PreprocessorError, match="Empty input data"):
            preprocessor.validate_input(empty_bytes, "test.psd")

    def test_validate_input_file_too_large(self, tmp_path):
        """Test that validate_input raises PreprocessorError for data exceeding MAX_FILE_SIZE."""
        preprocessor = ImageMagickPreprocessor()

        # Create data that exceeds max size
        large_data = b"x" * (preprocessor.MAX_FILE_SIZE + 1)

        with pytest.raises(PreprocessorError, match="File too large"):
            preprocessor.validate_input(large_data, "large.psd")

    def test_validate_input_unsupported_format(self, tmp_path):
        """Test that validate_input raises PreprocessorError for unsupported formats."""
        preprocessor = ImageMagickPreprocessor()

        # Test with unsupported extension
        test_data = b"test content"

        with pytest.raises(PreprocessorError, match="Unsupported format"):
            preprocessor.validate_input(test_data, "test.txt")

    def test_validate_input_success(self, tmp_path):
        """Test that validate_input passes for valid files."""
        preprocessor = ImageMagickPreprocessor()

        # Create valid PSD data
        valid_data = b"8BPS" + b"x" * 100  # PSD signature + data

        # Should not raise
        preprocessor.validate_input(valid_data, "test.psd")

    def test_create_temp_file(self):
        """Test that _create_temp_file creates a temporary file with correct suffix."""
        preprocessor = ImageMagickPreprocessor()

        temp_file = preprocessor._create_temp_file(".png")

        try:
            assert temp_file.exists()
            assert temp_file.suffix == ".png"
            assert "sambee_preprocessed_" in temp_file.name
        finally:
            # Cleanup
            if temp_file.exists():
                temp_file.unlink()


class TestImageMagickPreprocessor:
    """Test ImageMagick preprocessor implementation."""

    def test_supported_formats(self):
        """Test that ImageMagick supports PSD, PSB, EPS, and AI formats."""
        preprocessor = ImageMagickPreprocessor()
        assert preprocessor.SUPPORTED_FORMATS == {"psd", "psb", "eps", "ai"}

    def test_check_availability_v7_installed(self):
        """Test availability check with ImageMagick 7 (magick command)."""
        preprocessor = ImageMagickPreprocessor()

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = b"Version: ImageMagick 7.1.1-43 Q16"

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            assert preprocessor.check_availability() is True
            assert mock_run.call_args[0][0][0] == "magick"

    def test_check_availability_rejects_v6(self):
        """Test availability check rejects ImageMagick 6."""
        preprocessor = ImageMagickPreprocessor()

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = b"Version: ImageMagick 6.9.12-98 Q16"

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            assert preprocessor.check_availability() is False
            assert mock_run.call_args[0][0][0] == "magick"

    def test_check_availability_not_installed(self):
        """Test availability check when ImageMagick is not installed."""
        preprocessor = ImageMagickPreprocessor()

        with patch("subprocess.run", side_effect=FileNotFoundError):
            assert preprocessor.check_availability() is False

    def test_get_command_returns_v7_command(self):
        """Test command resolution returns the ImageMagick 7 command."""
        preprocessor = ImageMagickPreprocessor()

        with patch.object(preprocessor, "check_availability", return_value=True):
            assert preprocessor._get_command() == "magick"

    def test_get_command_requires_v7(self):
        """Test command resolution rejects a missing ImageMagick 7."""
        preprocessor = ImageMagickPreprocessor()

        with patch.object(preprocessor, "check_availability", return_value=False):
            with pytest.raises(PreprocessorError, match="ImageMagick 7 is required"):
                preprocessor._get_command()

    @pytest.mark.parametrize(
        "metadata,expected",
        [
            (b"CMYK 16383 100", ("CMYK", True)),
            (b"sRGB 100 16384", ("sRGB", False)),
            (b"sRGB 0 100", ("sRGB", False)),
            (b"sRGB invalid 100", ("sRGB", False)),
            (b"sRGB", ("sRGB", False)),
        ],
    )
    def test_dimension_probe_reuses_colorspace_identification(self, metadata, expected):
        preprocessor = ImageMagickPreprocessor()
        with (
            patch.object(preprocessor, "_get_command", return_value="magick"),
            patch("subprocess.run", return_value=MagicMock(stdout=metadata)) as run,
        ):
            assert preprocessor.inspect_image(b"PSD", "image.psd", dimensions=True) == expected
        run.assert_called_once()
        assert run.call_args.args[0] == ["magick", "identify", "-format", "%[colorspace] %w %h", "psd:-[0]"]

    def test_dimension_probe_failure_is_tolerant(self):
        preprocessor = ImageMagickPreprocessor()
        with (
            patch.object(preprocessor, "_get_command", return_value="magick"),
            patch("subprocess.run", side_effect=subprocess.CalledProcessError(1, "magick")),
        ):
            assert preprocessor.inspect_image(b"PSD", "image.psd", dimensions=True) == ("Unknown", False)

    def test_colorspace_probe_failure_does_not_log_imagemagick_stderr_at_warning_level(self, caplog: pytest.LogCaptureFixture):
        """Expected malformed files must not expose ImageMagick diagnostics in normal logs."""
        preprocessor = ImageMagickPreprocessor()
        process_error = subprocess.CalledProcessError(
            1,
            "magick",
            stderr=b"improper image header /tmp/private-file",
        )

        with (
            patch.object(preprocessor, "check_availability", return_value=True),
            patch("subprocess.run", side_effect=process_error),
        ):
            assert preprocessor._detect_colorspace(b"invalid PSD", "image.psd") == "Unknown"

        assert not caplog.records


class TestPreprocessorFactory:
    """Test the preprocessor factory."""

    def test_create_auto_uses_imagemagick(self):
        """Test that auto mode returns ImageMagick when available."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=True):
            preprocessor = PreprocessorFactory.create("auto")
            assert isinstance(preprocessor, ImageMagickPreprocessor)

    def test_create_auto_fails_if_none_available(self):
        """Test that auto mode raises error if no preprocessor available."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=False):
            with pytest.raises(PreprocessorError, match="No preprocessor available"):
                PreprocessorFactory.create("auto")

    def test_create_imagemagick_explicit(self):
        """Test creating ImageMagick preprocessor explicitly."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=True):
            preprocessor = PreprocessorFactory.create("imagemagick")
            assert isinstance(preprocessor, ImageMagickPreprocessor)

    def test_create_imagemagick_not_available(self):
        """Test error when ImageMagick explicitly requested but not available."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=False):
            with pytest.raises(PreprocessorError, match="ImageMagick not available"):
                PreprocessorFactory.create("imagemagick")

    def test_create_invalid_type(self):
        """Test error for invalid preprocessor type."""
        with pytest.raises(PreprocessorError, match="Invalid preprocessor type"):
            PreprocessorFactory.create("invalid")

    def test_create_from_env_var(self):
        """Test creating preprocessor from PREPROCESSOR environment variable."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=True):
            with patch.dict(os.environ, {"PREPROCESSOR": "imagemagick"}):
                preprocessor = PreprocessorFactory.create()
                assert isinstance(preprocessor, ImageMagickPreprocessor)

    def test_get_supported_formats_available(self):
        """Test getting supported formats when ImageMagick is available."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=True):
            formats = PreprocessorFactory.get_supported_formats()
            assert formats == {"psd", "psb", "eps", "ai"}

    def test_get_supported_formats_none_available(self):
        """Test getting supported formats when no tools are available."""
        with patch.object(ImageMagickPreprocessor, "check_availability", return_value=False):
            formats = PreprocessorFactory.get_supported_formats()
            assert formats == set()
