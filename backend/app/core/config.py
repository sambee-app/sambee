import sys
import tomllib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

from pydantic import BaseModel, field_validator, model_validator

from app.core.environment import IS_DEVELOPMENT
from app.core.exceptions import ConfigurationError
from app.core.system_setting_definitions import SYSTEM_SETTING_DEFINITIONS, SystemSettingKey

configured_setting_keys: frozenset[str] = frozenset()
unsupported_config_settings: tuple[Path, tuple[str, ...]] | None = None
DEFAULT_COMPANION_METADATA_FEED_URL = "https://release-feeds.sambee.net/feeds/sambee/companion/latest.json"

_SUPPORTED_CONFIG_PATHS = frozenset(
    {
        ("app", "log_level"),
        ("app", "access_log_level"),
        ("app", "protocol_log_level"),
        ("auth", "disable_enforcement"),
        ("security", "access_token_expire_minutes"),
        ("admin", "username"),
        ("image_viewer", "conv_size_thresh"),
        ("frontend_logging", "logging_enabled"),
        ("frontend_logging", "log_level"),
        ("frontend_logging", "tracing_enabled"),
        ("frontend_logging", "tracing_retention_hours"),
        ("frontend_logging", "tracing_level"),
        ("frontend_logging", "tracing_components"),
        ("frontend_logging", "tracing_username_regex"),
        ("directory_cache", "location"),
        ("directory_cache", "coalesce_interval_seconds"),
        ("directory_cache", "max_staleness_minutes"),
        ("preprocessors", "imagemagick", "max_file_size_bytes"),
        ("preprocessors", "imagemagick", "timeout_seconds"),
        ("companion_downloads", "metadata_feed_url"),
        ("companion_downloads", "pin", "version"),
        ("companion_downloads", "pin", "published_at"),
        ("companion_downloads", "pin", "notes"),
        ("companion_downloads", "pin", "windows_x64_url"),
        ("companion_downloads", "pin", "windows_arm64_url"),
        ("companion_downloads", "pin", "macos_arm64_url"),
        ("companion_downloads", "pin", "linux_x64_url"),
    }
)


def _iter_config_paths(config: dict[str, Any], prefix: tuple[str, ...] = ()) -> Iterator[tuple[str, ...]]:
    """Yield the paths to every configured TOML value."""

    for key, value in config.items():
        path = (*prefix, key)
        if isinstance(value, dict):
            yield from _iter_config_paths(value, path)
        else:
            yield path


def consume_unsupported_config_settings() -> tuple[Path, tuple[str, ...]] | None:
    """Return and clear unsupported settings found during configuration loading."""

    global unsupported_config_settings

    pending_settings = unsupported_config_settings
    unsupported_config_settings = None
    return pending_settings


#
# load_toml_config
#
def load_toml_config(config_file: Path) -> dict[str, Any]:
    """Load configuration from TOML file if it exists.

    Returns:
        Dictionary with flattened config values for Pydantic.
        Returns empty dict if file doesn't exist.
    """

    global unsupported_config_settings

    unsupported_config_settings = None

    if not config_file.exists():
        return {}

    # Check if config_file is actually a directory (common Docker mount issue)
    if config_file.is_dir():
        raise ConfigurationError(
            f"'{config_file}' is a directory, not a file. Common cause: Docker created a directory because the file doesn't exist on the host."
        )

    try:
        with open(config_file, "rb") as f:
            toml_data = tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        raise ConfigurationError(f"Invalid TOML syntax in '{config_file}': {e}") from e

    ignored_paths = tuple(sorted(".".join(path) for path in _iter_config_paths(toml_data) if path not in _SUPPORTED_CONFIG_PATHS))
    if ignored_paths:
        unsupported_config_settings = (config_file, ignored_paths)

    # Flatten nested TOML structure for Pydantic
    # Convert sections like [security] to flat keys like SECRET_KEY
    flat_config = {}

    # App settings
    if "app" in toml_data:
        app = toml_data["app"]
        if "log_level" in app:
            flat_config["log_level"] = app["log_level"]
        if "access_log_level" in app:
            flat_config["access_log_level"] = app["access_log_level"]
        if "protocol_log_level" in app:
            flat_config["protocol_log_level"] = app["protocol_log_level"]

    # Authentication enforcement override
    if "auth" in toml_data:
        auth = toml_data["auth"]
        if "auth_method" in auth:
            raise ConfigurationError(
                "'auth.auth_method' is no longer supported; use 'auth.disable_enforcement = true' only for a runtime override"
            )
        if "disable_enforcement" in auth:
            flat_config["disable_auth_enforcement"] = auth["disable_enforcement"]

    # Security settings
    if "security" in toml_data:
        security = toml_data["security"]
        if "access_token_expire_minutes" in security:
            flat_config["access_token_expire_minutes"] = security["access_token_expire_minutes"]
        if "auth_method" in security:
            raise ConfigurationError(
                "'security.auth_method' is no longer supported; use 'auth.disable_enforcement = true' only for a runtime override"
            )

    # Admin settings
    if "admin" in toml_data:
        admin = toml_data["admin"]
        if "username" in admin:
            flat_config["admin_username"] = admin["username"]

    # Frontend logging settings
    if "frontend_logging" in toml_data:
        frontend_logging = toml_data["frontend_logging"]
        # Console logging settings
        if "logging_enabled" in frontend_logging:
            flat_config["frontend_logging_enabled"] = frontend_logging["logging_enabled"]
        if "log_level" in frontend_logging:
            flat_config["frontend_log_level"] = frontend_logging["log_level"]
        # Backend tracing settings
        if "tracing_enabled" in frontend_logging:
            flat_config["frontend_tracing_enabled"] = frontend_logging["tracing_enabled"]
        if "tracing_retention_hours" in frontend_logging:
            flat_config["frontend_tracing_retention_hours"] = frontend_logging["tracing_retention_hours"]
        if "tracing_level" in frontend_logging:
            flat_config["frontend_tracing_level"] = frontend_logging["tracing_level"]
        if "tracing_components" in frontend_logging:
            flat_config["frontend_tracing_components"] = frontend_logging["tracing_components"]
        if "tracing_username_regex" in frontend_logging:
            flat_config["frontend_tracing_username_regex"] = frontend_logging["tracing_username_regex"]

    # Directory cache persistence settings
    if "directory_cache" in toml_data:
        dc = toml_data["directory_cache"]
        if "location" in dc:
            flat_config["directory_cache_location"] = dc["location"]
        if "coalesce_interval_seconds" in dc:
            flat_config["directory_cache_coalesce_interval_seconds"] = dc["coalesce_interval_seconds"]
        if "max_staleness_minutes" in dc:
            flat_config["directory_cache_max_staleness_minutes"] = dc["max_staleness_minutes"]

    # Preprocessor settings
    if "preprocessors" in toml_data:
        preprocessors = toml_data["preprocessors"]

        imagemagick = preprocessors.get("imagemagick")
        if isinstance(imagemagick, dict):
            if "max_file_size_bytes" in imagemagick:
                flat_config["preprocessor_imagemagick_max_file_size_bytes"] = imagemagick["max_file_size_bytes"]
            if "timeout_seconds" in imagemagick:
                flat_config["preprocessor_imagemagick_timeout_seconds"] = imagemagick["timeout_seconds"]

    # Companion download metadata settings
    if "companion_downloads" in toml_data:
        companion_downloads = toml_data["companion_downloads"]
        if "metadata_feed_url" in companion_downloads:
            flat_config["companion_metadata_feed_url"] = companion_downloads["metadata_feed_url"]

        pin = companion_downloads.get("pin")
        if isinstance(pin, dict):
            if "version" in pin:
                flat_config["companion_pin_version"] = pin["version"]
            if "published_at" in pin:
                flat_config["companion_pin_published_at"] = pin["published_at"]
            if "notes" in pin:
                flat_config["companion_pin_notes"] = pin["notes"]
            if "windows_x64_url" in pin:
                flat_config["companion_pin_windows_x64_url"] = pin["windows_x64_url"]
            if "windows_arm64_url" in pin:
                flat_config["companion_pin_windows_arm64_url"] = pin["windows_arm64_url"]
            if "macos_arm64_url" in pin:
                flat_config["companion_pin_macos_arm64_url"] = pin["macos_arm64_url"]
            if "linux_x64_url" in pin:
                flat_config["companion_pin_linux_x64_url"] = pin["linux_x64_url"]

    return flat_config


#
# Static settings - immutable, type-safe constants
#
@dataclass(frozen=True)
class StaticSettings:
    """Static application settings that cannot be overridden"""

    app_name: str = "Sambee"
    algorithm: str = "HS256"
    data_dir: Path = Path("data")


#
# User-configurable settings
#
class Settings(BaseModel):
    """Application settings with validation"""

    # App settings
    log_level: str = "INFO"
    access_log_level: str = "WARNING"
    protocol_log_level: str = "WARNING"

    # Disables all application authentication checks; intended only for trusted development or perimeter-controlled deployments.
    disable_auth_enforcement: bool = False

    @field_validator("log_level", "access_log_level", "protocol_log_level", "frontend_log_level", "frontend_tracing_level")
    @classmethod
    def validate_log_level(cls, v: str) -> str:
        """Validate and normalize log level to uppercase.

        Args:
            v: Log level string (case-insensitive)

        Returns:
            Normalized uppercase log level

        Raises:
            ValueError: If log level is invalid
        """

        valid_levels = {"DEBUG", "INFO", "WARNING", "ERROR"}
        normalized = v.upper()

        if normalized not in valid_levels:
            raise ValueError(f"Invalid log level: '{v}'. Must be one of: {', '.join(sorted(valid_levels))}")

        return normalized

    # Security settings
    access_token_expire_minutes: int = 1440
    secret_key: str = ""  # Set dynamically from database
    encryption_key: str = ""  # Set dynamically from database

    # Admin settings
    admin_username: str = "admin"

    # Frontend console logging settings
    frontend_logging_enabled: bool = False
    frontend_log_level: str = "WARNING"  # Console log level: DEBUG, INFO, WARNING, ERROR

    # Frontend backend tracing settings
    frontend_tracing_enabled: bool = False
    frontend_tracing_retention_hours: int = 1
    frontend_tracing_level: str = "ERROR"  # Tracing log level: DEBUG, INFO, WARNING, ERROR
    frontend_tracing_components: str = ""
    frontend_tracing_username_regex: str = ""

    # Directory cache persistence settings
    directory_cache_location: str = ""  # Empty = default (data_dir / directory_cache)
    directory_cache_coalesce_interval_seconds: int = 30  # Min time between disk writes
    directory_cache_max_staleness_minutes: int = 43200  # 30 days — ignore snapshots older than this

    # Preprocessor settings
    preprocessor_imagemagick_max_file_size_bytes: int = SYSTEM_SETTING_DEFINITIONS[
        SystemSettingKey.PREPROCESSOR_IMAGEMAGICK_MAX_FILE_SIZE_BYTES
    ].default_value
    preprocessor_imagemagick_timeout_seconds: int = SYSTEM_SETTING_DEFINITIONS[
        SystemSettingKey.PREPROCESSOR_IMAGEMAGICK_TIMEOUT_SECONDS
    ].default_value

    # Companion download metadata settings
    companion_metadata_feed_url: str = DEFAULT_COMPANION_METADATA_FEED_URL
    companion_pin_version: str | None = None
    companion_pin_published_at: str | None = None
    companion_pin_notes: str = ""
    companion_pin_windows_x64_url: str | None = None
    companion_pin_windows_arm64_url: str | None = None
    companion_pin_macos_arm64_url: str | None = None
    companion_pin_linux_x64_url: str | None = None

    @field_validator(
        "preprocessor_imagemagick_max_file_size_bytes",
        "preprocessor_imagemagick_timeout_seconds",
    )
    @classmethod
    def validate_integer_system_setting(cls, value: int, info: Any) -> int:
        definition_by_attr = {definition.config_attr: definition for definition in SYSTEM_SETTING_DEFINITIONS.values()}
        definition = definition_by_attr.get(info.field_name)
        if definition is None:
            return value
        if value < definition.min_value or value > definition.max_value:
            raise ValueError(f"{definition.config_attr} must be between {definition.min_value} and {definition.max_value}")
        return value

    @field_validator(
        "companion_metadata_feed_url",
        "companion_pin_windows_x64_url",
        "companion_pin_windows_arm64_url",
        "companion_pin_macos_arm64_url",
        "companion_pin_linux_x64_url",
    )
    @classmethod
    def validate_companion_urls(cls, value: str | None, info: Any) -> str | None:
        if value is None:
            return None

        normalized = value.strip()
        if not normalized:
            if info.field_name == "companion_metadata_feed_url":
                raise ValueError("companion_metadata_feed_url cannot be empty")
            return None

        parsed = urlparse(normalized)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError(f"{info.field_name} must be an absolute http or https URL")
        if parsed.username or parsed.password:
            raise ValueError(f"{info.field_name} must not include embedded credentials")

        return urlunparse((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.params, parsed.query, ""))

    @model_validator(mode="after")
    def validate_companion_pin_configuration(self) -> "Settings":
        pin_asset_urls = [
            self.companion_pin_windows_x64_url,
            self.companion_pin_windows_arm64_url,
            self.companion_pin_macos_arm64_url,
            self.companion_pin_linux_x64_url,
        ]
        has_pin_assets = any(pin_asset_urls)
        has_pin_configuration = has_pin_assets or bool(self.companion_pin_version) or bool(self.companion_pin_published_at)

        if has_pin_configuration and not self.companion_pin_version:
            raise ValueError("companion_downloads.pin.version is required when a companion pin override is configured")
        if self.companion_pin_version and not has_pin_assets:
            raise ValueError("companion_downloads.pin must define at least one asset URL when a companion pin override is configured")

        return self


#
# load_settings
#
def load_settings() -> Settings:
    """Load settings from config.toml file."""

    # Allow tests to override config path via environment variable
    import os

    env_config_path = os.environ.get("SAMBEE_CONFIG_PATH")
    if env_config_path:
        config_path = Path(env_config_path)
    # Determine config file location based on environment
    elif IS_DEVELOPMENT:
        # DEV mode: running in devcontainer
        config_path = Path("/workspace/config.toml")
    else:
        # PROD mode: running in Docker
        config_path = Path("/app/config.toml")

    global configured_setting_keys

    toml_config = load_toml_config(config_path)
    configured_setting_keys = frozenset(toml_config.keys())
    return Settings(**toml_config)


# Create global instances
static = StaticSettings()

try:
    settings = load_settings()
except Exception as e:
    # Catch all config errors (TOML syntax, validation errors, etc.)
    from app.core.logging import setup_early_error_logging

    startup_logger = setup_early_error_logging()
    startup_logger.error(f"Configuration Error: {e}")
    sys.exit(1)

# Ensure data directory exists
try:
    static.data_dir.mkdir(parents=True, exist_ok=True)
except (PermissionError, OSError) as e:
    from app.core.logging import setup_early_error_logging

    startup_logger = setup_early_error_logging()
    startup_logger.error(f"Failed to create data directory '{static.data_dir}': {e}")
    sys.exit(1)
