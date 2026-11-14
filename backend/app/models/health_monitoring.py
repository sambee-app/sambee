from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import Field as PydanticField
from pydantic import field_validator, model_validator
from sqlmodel import Field, SQLModel

from app.core.directory_index_contract import MAX_WIRE_INTEGER
from app.core.system_setting_definitions import (
    DEFAULT_HEALTH_MONITORING_AUDIENCE,
    DEFAULT_HEALTH_MONITORING_ENABLED,
    HEALTH_MONITORING_SETTING_KEYS,
    SYSTEM_SETTING_DEFINITIONS,
    HealthMonitoringAudience,
    SystemSettingSource,
)
from app.models.system_settings import IntegerSystemSettingRead, StrictSettingUpdate

CPU_TEMP_STEP_MILLIDEGREES = 100
MIN_CPU_TEMP_OVERRIDE_MILLIDEGREES = 100
MAX_CPU_TEMP_OVERRIDE_MILLIDEGREES = (MAX_WIRE_INTEGER // CPU_TEMP_STEP_MILLIDEGREES) * CPU_TEMP_STEP_MILLIDEGREES
MAX_CPU_SOURCE_ID_LENGTH = 512

HOST_SAMPLE_INTERVAL_SECONDS = 5
SUMMARY_POLL_INTERVAL_SECONDS = 15
DIALOG_POLL_INTERVAL_SECONDS = 5
STORAGE_REFRESH_INTERVAL_SECONDS = 60
HOST_STALE_SECONDS = 15
STORAGE_STALE_SECONDS = 180


class AggregateHealthSeverity(StrEnum):
    OK = "ok"
    WARNING = "warning"
    ERROR = "error"
    UNKNOWN = "unknown"


class HealthSeverity(StrEnum):
    OK = "ok"
    WARNING = "warning"
    ERROR = "error"
    UNKNOWN = "unknown"
    INFORMATIONAL = "informational"


class MetricAvailability(StrEnum):
    AVAILABLE = "available"
    COLLECTING = "collecting"
    NOT_MOUNTED = "not_mounted"
    UNSUPPORTED = "unsupported"
    PERMISSION_DENIED = "permission_denied"
    OFFLINE = "offline"
    TIMEOUT = "timeout"
    STALE = "stale"
    INVALID = "invalid"
    UNAVAILABLE = "unavailable"


class StorageSpaceSemantics(StrEnum):
    POSIX_UNPRIVILEGED_BLOCKS = "posix_unprivileged_blocks"
    CALLER_QUOTA = "caller_quota"


class ContainerMemoryLimitState(StrEnum):
    FINITE = "finite"
    UNLIMITED = "unlimited"
    UNKNOWN = "unknown"


class CpuTemperatureLimitOrigin(StrEnum):
    HARDWARE = "hardware"
    KERNEL_POLICY = "kernel_policy"
    ADMIN_OVERRIDE = "admin_override"


class CpuTemperatureOverrideState(StrEnum):
    NONE = "none"
    ACTIVE = "active"
    REVIEW_REQUIRED = "review_required"
    CONFLICT = "conflict"


def _validate_strict_int(value: object, *, label: str) -> int:
    if type(value) is not int:
        raise ValueError(f"{label} must be an exact scaled integer without fractions or rounding.")
    return value


def _validate_strict_bool(value: object, *, label: str) -> bool:
    if type(value) is not bool:
        raise ValueError(f"{label} must be a boolean.")
    return value


def _validate_cpu_override_millidegrees(value: object) -> int | None:
    if value is None:
        return None
    parsed = _validate_strict_int(value, label="CPU temperature override")
    if parsed < MIN_CPU_TEMP_OVERRIDE_MILLIDEGREES or parsed > MAX_CPU_TEMP_OVERRIDE_MILLIDEGREES:
        raise ValueError("CPU temperature override must be a positive temperature within the safe integer range (at least 0.1 °C).")
    if parsed % CPU_TEMP_STEP_MILLIDEGREES != 0:
        raise ValueError("CPU temperature override must use 0.1 °C steps (multiples of 100 millidegrees).")
    return parsed


def format_tenths_percent(value: int) -> str:
    return f"{value / 10:.1f}%"


def format_hundredths(value: int) -> str:
    return f"{value / 100:.2f}"


def format_millidegrees_celsius(value: int) -> str:
    return f"{value / 1000:.1f} °C"


class HealthMonitoringThresholdsRead(SQLModel):
    memory_warning_tenths_percent: int = Field(
        default=SYSTEM_SETTING_DEFINITIONS[HEALTH_MONITORING_SETTING_KEYS["memory_warning_tenths_percent"]].default_value,
        ge=1,
        le=1000,
    )
    memory_error_tenths_percent: int = Field(
        default=SYSTEM_SETTING_DEFINITIONS[HEALTH_MONITORING_SETTING_KEYS["memory_error_tenths_percent"]].default_value,
        ge=1,
        le=1000,
    )
    load_warning_hundredths: int = Field(
        default=SYSTEM_SETTING_DEFINITIONS[HEALTH_MONITORING_SETTING_KEYS["load_warning_hundredths"]].default_value,
        ge=1,
        le=MAX_WIRE_INTEGER,
    )
    load_error_hundredths: int = Field(
        default=SYSTEM_SETTING_DEFINITIONS[HEALTH_MONITORING_SETTING_KEYS["load_error_hundredths"]].default_value,
        ge=1,
        le=MAX_WIRE_INTEGER,
    )
    available_space_warning_tenths_percent: int = Field(
        default=SYSTEM_SETTING_DEFINITIONS[HEALTH_MONITORING_SETTING_KEYS["available_space_warning_tenths_percent"]].default_value,
        ge=0,
        le=999,
    )
    available_space_error_tenths_percent: int = Field(
        default=SYSTEM_SETTING_DEFINITIONS[HEALTH_MONITORING_SETTING_KEYS["available_space_error_tenths_percent"]].default_value,
        ge=0,
        le=999,
    )

    @field_validator(
        "memory_warning_tenths_percent",
        "memory_error_tenths_percent",
        "load_warning_hundredths",
        "load_error_hundredths",
        "available_space_warning_tenths_percent",
        "available_space_error_tenths_percent",
        mode="before",
    )
    @classmethod
    def validate_scaled_integer(cls, value: object) -> int:
        return _validate_strict_int(value, label="Health monitoring threshold")

    @model_validator(mode="after")
    def validate_pairs(self) -> "HealthMonitoringThresholdsRead":
        if self.memory_warning_tenths_percent > self.memory_error_tenths_percent:
            raise ValueError(
                f"Memory warning threshold ({format_tenths_percent(self.memory_warning_tenths_percent)}) cannot exceed "
                f"the memory error threshold ({format_tenths_percent(self.memory_error_tenths_percent)})."
            )
        if self.load_warning_hundredths > self.load_error_hundredths:
            raise ValueError(
                f"Normalized load warning threshold ({format_hundredths(self.load_warning_hundredths)}) cannot exceed "
                f"the normalized load error threshold ({format_hundredths(self.load_error_hundredths)})."
            )
        if self.available_space_warning_tenths_percent < self.available_space_error_tenths_percent:
            raise ValueError(
                f"Available-space warning threshold ({format_tenths_percent(self.available_space_warning_tenths_percent)}) "
                f"cannot be below the available-space error threshold ({format_tenths_percent(self.available_space_error_tenths_percent)})."
            )
        return self


class HealthMonitoringPolicy(HealthMonitoringThresholdsRead):
    enabled: bool = DEFAULT_HEALTH_MONITORING_ENABLED
    audience: HealthMonitoringAudience = DEFAULT_HEALTH_MONITORING_AUDIENCE

    @field_validator("enabled", mode="before")
    @classmethod
    def validate_enabled(cls, value: object) -> bool:
        return _validate_strict_bool(value, label="Enable health monitoring")


class PersistedCpuTempOverride(SQLModel):
    source_id: str = Field(min_length=1, max_length=MAX_CPU_SOURCE_ID_LENGTH)
    label: str = ""
    driver: str = ""
    device_path: str = ""
    warning_override_millidegrees: int | None = None
    error_override_millidegrees: int | None = None
    observed_max_millidegrees: int | None = None
    observed_crit_millidegrees: int | None = None

    @field_validator("warning_override_millidegrees", "error_override_millidegrees", mode="before")
    @classmethod
    def validate_override_values(cls, value: object) -> int | None:
        return _validate_cpu_override_millidegrees(value)


class CpuTemperatureSourceSettingsRead(SQLModel):
    source_id: str
    label: str
    driver: str
    device_path: str
    discovered: bool
    availability: MetricAvailability
    detected_warning_millidegrees: int | None = None
    detected_error_millidegrees: int | None = None
    detected_limit_origin: CpuTemperatureLimitOrigin | None = None
    warning_override_millidegrees: int | None = None
    error_override_millidegrees: int | None = None
    effective_warning_millidegrees: int | None = None
    effective_warning_origin: CpuTemperatureLimitOrigin | None = None
    effective_error_millidegrees: int | None = None
    effective_error_origin: CpuTemperatureLimitOrigin | None = None
    warning_exceeds_detected: bool = False
    error_exceeds_detected: bool = False
    override_state: CpuTemperatureOverrideState = CpuTemperatureOverrideState.NONE
    override_notice: str | None = None
    unusable_attributes: list[str] = Field(default_factory=list)


class HealthMonitoringSettingsRead(SQLModel):
    enabled: bool
    enabled_source: SystemSettingSource
    audience: HealthMonitoringAudience
    audience_source: SystemSettingSource
    policy: HealthMonitoringPolicy
    fields: dict[str, IntegerSystemSettingRead]
    cpu_sources: list[CpuTemperatureSourceSettingsRead] = Field(default_factory=list)
    cpu_sensor_discovery_status: MetricAvailability = MetricAvailability.NOT_MOUNTED
    cpu_sensor_discovery_message: str | None = None


class HealthMonitoringEnabledUpdate(StrictSettingUpdate):
    field: Literal["enabled"]
    value: bool

    @field_validator("value", mode="before")
    @classmethod
    def validate_bool(cls, value: object) -> bool:
        return _validate_strict_bool(value, label="Enable health monitoring")


class HealthMonitoringAudienceUpdate(StrictSettingUpdate):
    field: Literal["audience"]
    value: HealthMonitoringAudience


class HealthMonitoringIntegerThresholdUpdate(StrictSettingUpdate):
    field: Literal[
        "memory_warning_tenths_percent",
        "memory_error_tenths_percent",
        "load_warning_hundredths",
        "load_error_hundredths",
        "available_space_warning_tenths_percent",
        "available_space_error_tenths_percent",
    ]
    value: int

    @field_validator("value", mode="before")
    @classmethod
    def validate_int(cls, value: object) -> int:
        return _validate_strict_int(value, label="Threshold value")

    @model_validator(mode="after")
    def validate_bounds(self) -> "HealthMonitoringIntegerThresholdUpdate":
        definition = SYSTEM_SETTING_DEFINITIONS[HEALTH_MONITORING_SETTING_KEYS[self.field]]
        if self.value < definition.min_value or self.value > definition.max_value:
            raise ValueError(f"{definition.label} must be between {definition.min_value} and {definition.max_value}.")
        return self


class HealthMonitoringCpuTempWarningOverrideUpdate(StrictSettingUpdate):
    field: Literal["cpu_temp_warning_override"]
    source_id: str = Field(min_length=1, max_length=MAX_CPU_SOURCE_ID_LENGTH)
    value_millidegrees: int | None

    @field_validator("value_millidegrees", mode="before")
    @classmethod
    def validate_millidegrees(cls, value: object) -> int | None:
        return _validate_cpu_override_millidegrees(value)


class HealthMonitoringCpuTempErrorOverrideUpdate(StrictSettingUpdate):
    field: Literal["cpu_temp_error_override"]
    source_id: str = Field(min_length=1, max_length=MAX_CPU_SOURCE_ID_LENGTH)
    value_millidegrees: int | None

    @field_validator("value_millidegrees", mode="before")
    @classmethod
    def validate_millidegrees(cls, value: object) -> int | None:
        return _validate_cpu_override_millidegrees(value)


HealthMonitoringSettingsUpdate = Annotated[
    HealthMonitoringEnabledUpdate
    | HealthMonitoringAudienceUpdate
    | HealthMonitoringIntegerThresholdUpdate
    | HealthMonitoringCpuTempWarningOverrideUpdate
    | HealthMonitoringCpuTempErrorOverrideUpdate,
    PydanticField(discriminator="field"),
]
HealthMonitoringSettingsUpdateResult = HealthMonitoringSettingsUpdate


class HealthMonitoringClientPolicyRead(SQLModel):
    enabled: bool
    permitted: bool
    thresholds: HealthMonitoringThresholdsRead | None = None
    summary_poll_seconds: int = SUMMARY_POLL_INTERVAL_SECONDS
    dialog_poll_seconds: int = DIALOG_POLL_INTERVAL_SECONDS
    host_stale_seconds: int = HOST_STALE_SECONDS
    storage_stale_seconds: int = STORAGE_STALE_SECONDS


class HealthSummaryRead(SQLModel):
    severity: AggregateHealthSeverity
    headline: str
    incomplete_coverage: bool = False
    coverage_notes: list[str] = Field(default_factory=list)
    last_updated_at: datetime | None = None


class MemoryMetricRead(SQLModel):
    severity: HealthSeverity
    availability: MetricAvailability
    source: str
    used_bytes: int | None = None
    available_bytes: int | None = None
    total_bytes: int | None = None
    used_tenths_percent: int | None = None
    used_percent: float | None = None
    warning_tenths_percent: int
    error_tenths_percent: int
    recovery_pending: bool = False
    sampled_at: datetime | None = None
    age_seconds: float | None = None
    is_stale: bool = False
    message: str | None = None
    action: str | None = None


class SystemLoadMetricRead(SQLModel):
    severity: HealthSeverity
    availability: MetricAvailability
    source: str
    logical_cpu_count: int | None = None
    normalized_1m: float | None = None
    normalized_5m: float | None = None
    normalized_15m: float | None = None
    evaluated_window: Literal["5m"] = "5m"
    warning_hundredths: int
    error_hundredths: int
    recovery_pending: bool = False
    sampled_at: datetime | None = None
    age_seconds: float | None = None
    is_stale: bool = False
    message: str | None = None
    action: str | None = None


class CpuTemperatureSummaryRead(SQLModel):
    severity: HealthSeverity
    availability: MetricAvailability
    source_id: str | None = None
    label: str | None = None
    driver: str | None = None
    source: str
    package_count: int = 0
    assessed_package_count: int = 0
    incomplete_coverage: bool = False
    current_millidegrees: int | None = None
    detected_warning_millidegrees: int | None = None
    detected_error_millidegrees: int | None = None
    detected_limit_origin: CpuTemperatureLimitOrigin | None = None
    effective_warning_millidegrees: int | None = None
    effective_warning_origin: CpuTemperatureLimitOrigin | None = None
    effective_error_millidegrees: int | None = None
    effective_error_origin: CpuTemperatureLimitOrigin | None = None
    warning_override_millidegrees: int | None = None
    error_override_millidegrees: int | None = None
    warning_exceeds_detected: bool = False
    error_exceeds_detected: bool = False
    override_state: CpuTemperatureOverrideState = CpuTemperatureOverrideState.NONE
    unusable_attributes: list[str] = Field(default_factory=list)
    recovery_pending: bool = False
    sampled_at: datetime | None = None
    age_seconds: float | None = None
    is_stale: bool = False
    message: str | None = None
    action: str | None = None


class ContainerMemoryMetricRead(SQLModel):
    severity: HealthSeverity
    availability: MetricAvailability
    limit_state: ContainerMemoryLimitState
    source: str
    used_bytes: int | None = None
    cache_bytes: int | None = None
    working_set_bytes: int | None = None
    limit_bytes: int | None = None
    used_tenths_percent: int | None = None
    used_percent: float | None = None
    warning_tenths_percent: int | None = None
    error_tenths_percent: int | None = None
    recovery_pending: bool = False
    sampled_at: datetime | None = None
    age_seconds: float | None = None
    is_stale: bool = False
    message: str | None = None
    action: str | None = None


class StorageMetricRead(SQLModel):
    id: str
    kind: Literal["application_data", "application_temp", "application_combined", "smb"]
    connection_id: uuid.UUID | None = None
    label: str
    source: str
    semantics: StorageSpaceSemantics
    severity: HealthSeverity
    availability: MetricAvailability
    available_bytes: int | None = None
    total_bytes: int | None = None
    actual_free_bytes: int | None = None
    available_tenths_percent: int | None = None
    available_percent: float | None = None
    warning_tenths_percent: int
    error_tenths_percent: int
    recovery_pending: bool = False
    sampled_at: datetime | None = None
    age_seconds: float | None = None
    is_stale: bool = False
    message: str | None = None
    action: str | None = None


class HealthMonitoringSnapshotRead(SQLModel):
    generated_at: datetime
    thresholds: HealthMonitoringThresholdsRead
    summary: HealthSummaryRead
    host_memory: MemoryMetricRead
    system_load: SystemLoadMetricRead
    cpu_temperature: CpuTemperatureSummaryRead
    container_memory: ContainerMemoryMetricRead
    application_storage: list[StorageMetricRead] = Field(default_factory=list)
    smb_storage: list[StorageMetricRead] = Field(default_factory=list)
