from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT, MAX_WIRE_INTEGER, POLICY_FIELDS


class SystemSettingKey(StrEnum):
    DIRECTORY_INDEX_BACKEND_POLICY_REVISION = "directory_index.backend.policy_revision"
    DIRECTORY_INDEX_COMPANION_POLICY_REVISION = "directory_index.companion.policy_revision"
    DIRECTORY_INDEX_BACKEND_DISK_BUDGET_BYTES = "directory_index.backend.disk_budget_bytes"
    DIRECTORY_INDEX_BACKEND_INACTIVE_RETENTION_SECONDS = "directory_index.backend.inactive_retention_seconds"
    DIRECTORY_INDEX_BACKEND_MAX_RETAINED_INACTIVE_SOURCES = "directory_index.backend.max_retained_inactive_sources"
    DIRECTORY_INDEX_BACKEND_PAGE_CACHE_KIB = "directory_index.backend.page_cache_kib"
    DIRECTORY_INDEX_BACKEND_HEALTHY_VERIFICATION_SECONDS = "directory_index.backend.healthy_verification_seconds"
    DIRECTORY_INDEX_BACKEND_DEGRADED_VERIFICATION_SECONDS = "directory_index.backend.degraded_verification_seconds"
    DIRECTORY_INDEX_COMPANION_DISK_BUDGET_BYTES = "directory_index.companion.disk_budget_bytes"
    DIRECTORY_INDEX_COMPANION_INACTIVE_RETENTION_SECONDS = "directory_index.companion.inactive_retention_seconds"
    DIRECTORY_INDEX_COMPANION_MAX_RETAINED_INACTIVE_SOURCES = "directory_index.companion.max_retained_inactive_sources"
    DIRECTORY_INDEX_COMPANION_PAGE_CACHE_KIB = "directory_index.companion.page_cache_kib"
    DIRECTORY_INDEX_COMPANION_HEALTHY_VERIFICATION_SECONDS = "directory_index.companion.healthy_verification_seconds"
    DIRECTORY_INDEX_COMPANION_DEGRADED_VERIFICATION_SECONDS = "directory_index.companion.degraded_verification_seconds"
    TEMPORARY_ARCHIVE_DOWNLOAD_SIZE_BYTES = "archive.temporary_download_size_bytes"
    SMB_READ_CHUNK_SIZE_BYTES = "smb.read_chunk_size_bytes"
    SMB_AUTHENTICATION_MODE = "smb.authentication_mode"
    SMB_ENCRYPTION_MODE = "smb.encryption_mode"
    SMB_CONNECTION_TIMEOUT_SECONDS = "smb.connection_timeout_seconds"
    PREPROCESSOR_IMAGEMAGICK_MAX_FILE_SIZE_BYTES = "preprocessors.imagemagick.max_file_size_bytes"
    PREPROCESSOR_IMAGEMAGICK_TIMEOUT_SECONDS = "preprocessors.imagemagick.timeout_seconds"
    IMAGE_CONVERSION_PREFERENCE = "image_viewer.conversion_preference"
    IMAGE_CONVERSION_THRESHOLD_BYTES = "image_viewer.conversion_threshold_bytes"
    PDF_VIEWER_CACHE_QUOTA_BYTES = "pdf.viewer.cache_quota_bytes"
    PDF_VIEWER_CACHE_INACTIVITY_TTL_SECONDS = "pdf.viewer.cache_inactivity_ttl_seconds"
    PDF_NORMALIZER_MAX_SOURCE_SIZE_BYTES = "pdf.normalizer.max_source_size_bytes"
    PDF_NORMALIZER_MAX_OUTPUT_SIZE_BYTES = "pdf.normalizer.max_output_size_bytes"
    PDF_NORMALIZER_ADDRESS_SPACE_BYTES = "pdf.normalizer.address_space_bytes"
    PDF_NORMALIZER_TEMPORARY_DISK_BYTES = "pdf.normalizer.temporary_disk_bytes"
    PDF_NORMALIZER_TIMEOUT_SECONDS = "pdf.normalizer.timeout_seconds"
    PDF_NORMALIZER_CPU_TIME_SECONDS = "pdf.normalizer.cpu_time_seconds"
    PDF_NORMALIZER_MAX_CONCURRENT = "pdf.normalizer.max_concurrent"
    PDF_NORMALIZER_QUEUE_WAIT_SECONDS = "pdf.normalizer.queue_wait_seconds"
    PDF_SCREEN_DERIVATIVE_ENABLED = "pdf.screen_derivative.enabled"
    PDF_SCREEN_MAX_DECODED_PIXELS = "pdf.screen_derivative.max_decoded_pixels"
    FILE_SEARCH_RETENTION_LIMIT = "file_search.retention_limit"
    FILE_SEARCH_RESULT_LIMIT = "file_search.result_limit"
    FILE_SEARCH_EXCLUDED_CATEGORIES = "file_search.excluded_categories"
    FILE_SEARCH_EXCLUDED_EXTENSIONS = "file_search.excluded_extensions"
    HEALTH_MONITORING_ENABLED = "health_monitoring.enabled"
    HEALTH_MONITORING_AUDIENCE = "health_monitoring.audience"
    HEALTH_MONITORING_MEMORY_WARNING_TENTHS_PERCENT = "health_monitoring.memory_warning_tenths_percent"
    HEALTH_MONITORING_MEMORY_ERROR_TENTHS_PERCENT = "health_monitoring.memory_error_tenths_percent"
    HEALTH_MONITORING_LOAD_WARNING_HUNDREDTHS = "health_monitoring.load_warning_hundredths"
    HEALTH_MONITORING_LOAD_ERROR_HUNDREDTHS = "health_monitoring.load_error_hundredths"
    HEALTH_MONITORING_AVAILABLE_SPACE_WARNING_TENTHS_PERCENT = "health_monitoring.available_space_warning_tenths_percent"
    HEALTH_MONITORING_AVAILABLE_SPACE_ERROR_TENTHS_PERCENT = "health_monitoring.available_space_error_tenths_percent"


class SystemSettingSource(StrEnum):
    DATABASE = "database"
    CONFIG_FILE = "config_file"
    DEFAULT = "default"


class ImageConversionPreference(StrEnum):
    SPEED = "speed"
    SIZE = "size"


DEFAULT_IMAGE_CONVERSION_PREFERENCE = ImageConversionPreference.SPEED


class HealthMonitoringAudience(StrEnum):
    ADMINS = "admins"
    EDITORS = "editors"
    BOTH = "both"


DEFAULT_HEALTH_MONITORING_ENABLED = True
DEFAULT_HEALTH_MONITORING_AUDIENCE = HealthMonitoringAudience.ADMINS
HEALTH_MONITORING_CPU_OVERRIDE_KEY_PREFIX = "health_monitoring.cpu_temp_override."
HEALTH_MONITORING_SETTING_KEYS = {
    "memory_warning_tenths_percent": SystemSettingKey.HEALTH_MONITORING_MEMORY_WARNING_TENTHS_PERCENT,
    "memory_error_tenths_percent": SystemSettingKey.HEALTH_MONITORING_MEMORY_ERROR_TENTHS_PERCENT,
    "load_warning_hundredths": SystemSettingKey.HEALTH_MONITORING_LOAD_WARNING_HUNDREDTHS,
    "load_error_hundredths": SystemSettingKey.HEALTH_MONITORING_LOAD_ERROR_HUNDREDTHS,
    "available_space_warning_tenths_percent": SystemSettingKey.HEALTH_MONITORING_AVAILABLE_SPACE_WARNING_TENTHS_PERCENT,
    "available_space_error_tenths_percent": SystemSettingKey.HEALTH_MONITORING_AVAILABLE_SPACE_ERROR_TENTHS_PERCENT,
}
HEALTH_MONITORING_ALL_SETTING_KEYS = frozenset(
    {
        SystemSettingKey.HEALTH_MONITORING_ENABLED,
        SystemSettingKey.HEALTH_MONITORING_AUDIENCE,
        *HEALTH_MONITORING_SETTING_KEYS.values(),
    }
)


class DirectoryIndexPolicyScope(StrEnum):
    BACKEND = "backend"
    COMPANION = "companion"


DIRECTORY_INDEX_SETTING_KEYS = {
    scope: {field: SystemSettingKey(f"directory_index.{scope.value}.{field}") for field in POLICY_FIELDS}
    for scope in DirectoryIndexPolicyScope
}
DIRECTORY_INDEX_ALL_SETTING_KEYS = frozenset(key for fields in DIRECTORY_INDEX_SETTING_KEYS.values() for key in fields.values())
DIRECTORY_INDEX_REVISION_KEYS = {
    DirectoryIndexPolicyScope.BACKEND: SystemSettingKey.DIRECTORY_INDEX_BACKEND_POLICY_REVISION,
    DirectoryIndexPolicyScope.COMPANION: SystemSettingKey.DIRECTORY_INDEX_COMPANION_POLICY_REVISION,
}


@dataclass(frozen=True)
class IntegerSystemSettingDefinition:
    key: SystemSettingKey
    config_attr: str | None
    label: str
    description: str
    default_value: int
    min_value: int
    max_value: int
    step: int


SYSTEM_SETTING_DEFINITIONS: dict[SystemSettingKey, IntegerSystemSettingDefinition] = {
    SystemSettingKey.IMAGE_CONVERSION_THRESHOLD_BYTES: IntegerSystemSettingDefinition(
        key=SystemSettingKey.IMAGE_CONVERSION_THRESHOLD_BYTES,
        config_attr=None,
        label="Image conversion threshold",
        description="Resize browser-native images larger than this size for backend previews. Formats requiring conversion always convert.",
        default_value=5 * 1024 * 1024,
        min_value=0,
        max_value=1024 * 1024 * 1024,
        step=1,
    ),
    SystemSettingKey.TEMPORARY_ARCHIVE_DOWNLOAD_SIZE_BYTES: IntegerSystemSettingDefinition(
        key=SystemSettingKey.TEMPORARY_ARCHIVE_DOWNLOAD_SIZE_BYTES,
        config_attr=None,
        label="Temporary archive download size limit",
        description="Largest generated ZIP download artifact stored temporarily on this server.",
        default_value=250 * 1024 * 1024,
        min_value=1 * 1024 * 1024,
        max_value=2 * 1024 * 1024 * 1024,
        step=1024 * 1024,
    ),
    SystemSettingKey.SMB_READ_CHUNK_SIZE_BYTES: IntegerSystemSettingDefinition(
        key=SystemSettingKey.SMB_READ_CHUNK_SIZE_BYTES,
        config_attr=None,
        label="SMB read chunk size",
        description="Chunk size used when streaming files from SMB shares.",
        default_value=4 * 1024 * 1024,
        min_value=64 * 1024,
        max_value=16 * 1024 * 1024,
        step=64 * 1024,
    ),
    SystemSettingKey.PREPROCESSOR_IMAGEMAGICK_MAX_FILE_SIZE_BYTES: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PREPROCESSOR_IMAGEMAGICK_MAX_FILE_SIZE_BYTES,
        config_attr="preprocessor_imagemagick_max_file_size_bytes",
        label="ImageMagick maximum file size",
        description="Largest input file ImageMagick is allowed to preprocess.",
        default_value=100 * 1024 * 1024,
        min_value=1 * 1024 * 1024,
        max_value=1024 * 1024 * 1024,
        step=1 * 1024 * 1024,
    ),
    SystemSettingKey.PREPROCESSOR_IMAGEMAGICK_TIMEOUT_SECONDS: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PREPROCESSOR_IMAGEMAGICK_TIMEOUT_SECONDS,
        config_attr="preprocessor_imagemagick_timeout_seconds",
        label="ImageMagick conversion timeout",
        description="Maximum time allowed for an ImageMagick preprocessing run.",
        default_value=30,
        min_value=5,
        max_value=600,
        step=1,
    ),
    SystemSettingKey.PDF_VIEWER_CACHE_QUOTA_BYTES: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_VIEWER_CACHE_QUOTA_BYTES,
        config_attr=None,
        label="PDF normalization cache quota",
        description="Maximum local storage for normalized PDFs per user. The original PDF is unchanged. Zero disables the cache.",
        default_value=50 * 1024 * 1024,
        min_value=0,
        max_value=1024 * 1024 * 1024,
        step=1024 * 1024,
    ),
    SystemSettingKey.PDF_VIEWER_CACHE_INACTIVITY_TTL_SECONDS: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_VIEWER_CACHE_INACTIVITY_TTL_SECONDS,
        config_attr=None,
        label="PDF normalization cache inactivity TTL",
        description="Delete an unused normalized PDF after this many seconds.",
        default_value=7 * 24 * 60 * 60,
        min_value=60,
        max_value=90 * 24 * 60 * 60,
        step=60,
    ),
    SystemSettingKey.PDF_NORMALIZER_MAX_SOURCE_SIZE_BYTES: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_NORMALIZER_MAX_SOURCE_SIZE_BYTES,
        config_attr=None,
        label="PDF normalization source-size limit",
        description="Largest source PDF that normalization may read.",
        default_value=250 * 1024 * 1024,
        min_value=1 * 1024 * 1024,
        max_value=2 * 1024 * 1024 * 1024,
        step=1024 * 1024,
    ),
    SystemSettingKey.PDF_NORMALIZER_MAX_OUTPUT_SIZE_BYTES: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_NORMALIZER_MAX_OUTPUT_SIZE_BYTES,
        config_attr=None,
        label="PDF normalization output-size limit",
        description="Largest normalized PDF Ghostscript may write.",
        default_value=512 * 1024 * 1024,
        min_value=1 * 1024 * 1024,
        max_value=2 * 1024 * 1024 * 1024,
        step=1024 * 1024,
    ),
    SystemSettingKey.PDF_NORMALIZER_ADDRESS_SPACE_BYTES: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_NORMALIZER_ADDRESS_SPACE_BYTES,
        config_attr=None,
        label="PDF normalization address-space limit",
        description="Maximum virtual memory available to one Ghostscript PDF normalization.",
        default_value=512 * 1024 * 1024,
        min_value=128 * 1024 * 1024,
        max_value=8 * 1024 * 1024 * 1024,
        step=64 * 1024 * 1024,
    ),
    SystemSettingKey.PDF_NORMALIZER_TEMPORARY_DISK_BYTES: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_NORMALIZER_TEMPORARY_DISK_BYTES,
        config_attr=None,
        label="PDF normalization temporary-disk limit",
        description="Maximum temporary space reserved for one PDF normalization input and output.",
        default_value=1024 * 1024 * 1024,
        min_value=128 * 1024 * 1024,
        max_value=8 * 1024 * 1024 * 1024,
        step=64 * 1024 * 1024,
    ),
    SystemSettingKey.PDF_NORMALIZER_TIMEOUT_SECONDS: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_NORMALIZER_TIMEOUT_SECONDS,
        config_attr=None,
        label="PDF normalization timeout",
        description="Maximum time allowed for one Ghostscript PDF normalization.",
        default_value=60,
        min_value=5,
        max_value=600,
        step=1,
    ),
    SystemSettingKey.PDF_NORMALIZER_CPU_TIME_SECONDS: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_NORMALIZER_CPU_TIME_SECONDS,
        config_attr=None,
        label="PDF normalization CPU-time limit",
        description="Maximum CPU time allocated to one Ghostscript PDF normalization.",
        default_value=60,
        min_value=5,
        max_value=600,
        step=1,
    ),
    SystemSettingKey.PDF_NORMALIZER_MAX_CONCURRENT: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_NORMALIZER_MAX_CONCURRENT,
        config_attr=None,
        label="Concurrent PDF normalizations",
        description="Maximum Ghostscript PDF normalizations running in this backend process.",
        default_value=2,
        min_value=1,
        max_value=16,
        step=1,
    ),
    SystemSettingKey.PDF_NORMALIZER_QUEUE_WAIT_SECONDS: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_NORMALIZER_QUEUE_WAIT_SECONDS,
        config_attr=None,
        label="PDF normalization queue wait",
        description="Maximum time a PDF normalization request waits for a Ghostscript slot.",
        default_value=15,
        min_value=0,
        max_value=120,
        step=1,
    ),
    SystemSettingKey.PDF_SCREEN_DERIVATIVE_ENABLED: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_SCREEN_DERIVATIVE_ENABLED,
        config_attr=None,
        label="Enable screen-optimized PDF normalization",
        description="Allow screen-optimized normalization for PDFs with oversized image placements. Zero keeps the feature disabled.",
        default_value=0,
        min_value=0,
        max_value=1,
        step=1,
    ),
    SystemSettingKey.PDF_SCREEN_MAX_DECODED_PIXELS: IntegerSystemSettingDefinition(
        key=SystemSettingKey.PDF_SCREEN_MAX_DECODED_PIXELS,
        config_attr=None,
        label="Screen-normalization decoded-pixel budget",
        description="Image decoded-pixel budget before screen-optimized PDF normalization is considered.",
        default_value=64 * 1024 * 1024,
        min_value=4 * 1024 * 1024,
        max_value=1024 * 1024 * 1024,
        step=1024 * 1024,
    ),
    SystemSettingKey.HEALTH_MONITORING_MEMORY_WARNING_TENTHS_PERCENT: IntegerSystemSettingDefinition(
        key=SystemSettingKey.HEALTH_MONITORING_MEMORY_WARNING_TENTHS_PERCENT,
        config_attr=None,
        label="Memory warning threshold",
        description="Trigger a memory warning at or above this used percentage for 60 seconds (tenths of a percent).",
        default_value=850,
        min_value=1,
        max_value=1000,
        step=1,
    ),
    SystemSettingKey.HEALTH_MONITORING_MEMORY_ERROR_TENTHS_PERCENT: IntegerSystemSettingDefinition(
        key=SystemSettingKey.HEALTH_MONITORING_MEMORY_ERROR_TENTHS_PERCENT,
        config_attr=None,
        label="Memory error threshold",
        description="Trigger a memory error at or above this used percentage for 60 seconds (tenths of a percent).",
        default_value=950,
        min_value=1,
        max_value=1000,
        step=1,
    ),
    SystemSettingKey.HEALTH_MONITORING_LOAD_WARNING_HUNDREDTHS: IntegerSystemSettingDefinition(
        key=SystemSettingKey.HEALTH_MONITORING_LOAD_WARNING_HUNDREDTHS,
        config_attr=None,
        label="Normalized 5-minute load warning threshold",
        description="Trigger a system-load warning when normalized 5-minute load is at or above this value (hundredths).",
        default_value=75,
        min_value=1,
        max_value=MAX_WIRE_INTEGER,
        step=1,
    ),
    SystemSettingKey.HEALTH_MONITORING_LOAD_ERROR_HUNDREDTHS: IntegerSystemSettingDefinition(
        key=SystemSettingKey.HEALTH_MONITORING_LOAD_ERROR_HUNDREDTHS,
        config_attr=None,
        label="Normalized 5-minute load error threshold",
        description="Trigger a system-load error when normalized 5-minute load is at or above this value (hundredths).",
        default_value=90,
        min_value=1,
        max_value=MAX_WIRE_INTEGER,
        step=1,
    ),
    SystemSettingKey.HEALTH_MONITORING_AVAILABLE_SPACE_WARNING_TENTHS_PERCENT: IntegerSystemSettingDefinition(
        key=SystemSettingKey.HEALTH_MONITORING_AVAILABLE_SPACE_WARNING_TENTHS_PERCENT,
        config_attr=None,
        label="Available-space warning threshold",
        description="Trigger a storage warning at or below this available percentage (tenths of a percent).",
        default_value=100,
        min_value=0,
        max_value=999,
        step=1,
    ),
    SystemSettingKey.HEALTH_MONITORING_AVAILABLE_SPACE_ERROR_TENTHS_PERCENT: IntegerSystemSettingDefinition(
        key=SystemSettingKey.HEALTH_MONITORING_AVAILABLE_SPACE_ERROR_TENTHS_PERCENT,
        config_attr=None,
        label="Available-space error threshold",
        description="Trigger a storage error at or below this available percentage or when zero bytes remain (tenths of a percent).",
        default_value=50,
        min_value=0,
        max_value=999,
        step=1,
    ),
}

for policy_scope, policy_keys in DIRECTORY_INDEX_SETTING_KEYS.items():
    for policy_field_name, policy_key in policy_keys.items():
        policy_field = DIRECTORY_INDEX_CONTRACT.policy[policy_field_name]
        SYSTEM_SETTING_DEFINITIONS[policy_key] = IntegerSystemSettingDefinition(
            key=policy_key,
            config_attr=None,
            label=policy_field.label,
            description=policy_field.description,
            default_value=policy_field.default,
            min_value=policy_field.minimum,
            max_value=policy_field.maximum,
            step=policy_field.step,
        )
