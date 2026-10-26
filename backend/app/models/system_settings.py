from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import StrEnum
from typing import Annotated, Literal, Optional

from pydantic import field_validator, model_validator
from sqlmodel import Field, SQLModel
from sqlmodel._compat import SQLModelConfig

from app.core.system_setting_definitions import SystemSettingKey, SystemSettingSource


class SystemSetting(SQLModel, table=True):
    key: str = Field(primary_key=True)
    value: str
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_by_user_id: Optional[uuid.UUID] = Field(default=None, foreign_key="user.id", index=True)


class IntegerSystemSettingRead(SQLModel):
    key: SystemSettingKey
    label: str
    description: str
    value: int
    source: SystemSettingSource
    default_value: int
    min_value: int
    max_value: int
    step: int


class PreprocessorAdvancedSettingsRead(SQLModel):
    max_file_size_bytes: IntegerSystemSettingRead
    timeout_seconds: IntegerSystemSettingRead


class PdfAdvancedSettingsRead(SQLModel):
    cache_quota_bytes: IntegerSystemSettingRead
    cache_inactivity_ttl_seconds: IntegerSystemSettingRead
    max_source_size_bytes: IntegerSystemSettingRead
    max_output_size_bytes: IntegerSystemSettingRead
    address_space_bytes: IntegerSystemSettingRead
    temporary_disk_bytes: IntegerSystemSettingRead
    timeout_seconds: IntegerSystemSettingRead
    cpu_time_seconds: IntegerSystemSettingRead
    max_concurrent: IntegerSystemSettingRead
    queue_wait_seconds: IntegerSystemSettingRead
    screen_derivative_enabled: IntegerSystemSettingRead
    screen_max_decoded_pixels: IntegerSystemSettingRead


class AdvancedSystemSettingsRead(SQLModel):
    preprocessors: dict[str, PreprocessorAdvancedSettingsRead]
    pdf: PdfAdvancedSettingsRead
    temporary_archive_download_size_bytes: IntegerSystemSettingRead


class SmbAuthenticationMode(StrEnum):
    NEGOTIATE = "negotiate"
    KERBEROS_REQUIRED = "kerberos_required"


class SmbEncryptionMode(StrEnum):
    SIGNING_ONLY = "signing_only"
    ENCRYPTION_REQUIRED = "encryption_required"


class SmbPolicySettings(SQLModel):
    """Validated, administrator-managed policy for all SMB backends."""

    authentication_mode: SmbAuthenticationMode = SmbAuthenticationMode.NEGOTIATE
    encryption_mode: SmbEncryptionMode = SmbEncryptionMode.SIGNING_ONLY
    connection_timeout_seconds: int = Field(default=30, ge=5, le=120)


class SmbSettingsRead(SQLModel):
    read_chunk_size_bytes: IntegerSystemSettingRead
    policy: SmbPolicySettings
    require_signing: bool = True
    require_encryption: bool = False


class StrictSettingUpdate(SQLModel):
    model_config = SQLModelConfig(extra="forbid")


class AdvancedSystemSettingUpdate(StrictSettingUpdate):
    field: SystemSettingKey
    value: int

    @model_validator(mode="after")
    def validate_supported_field(self) -> "AdvancedSystemSettingUpdate":
        from app.core.system_setting_definitions import SYSTEM_SETTING_DEFINITIONS

        if self.field not in SYSTEM_SETTING_DEFINITIONS or self.field is SystemSettingKey.SMB_READ_CHUNK_SIZE_BYTES:
            raise ValueError("Field is not an editable advanced system setting")
        return self


class SmbReadChunkSizeUpdate(StrictSettingUpdate):
    field: Literal["read_chunk_size_bytes"]
    value: int


class SmbAuthenticationModeUpdate(StrictSettingUpdate):
    field: Literal["authentication_mode"]
    value: SmbAuthenticationMode


class SmbEncryptionModeUpdate(StrictSettingUpdate):
    field: Literal["encryption_mode"]
    value: SmbEncryptionMode


class SmbConnectionTimeoutUpdate(StrictSettingUpdate):
    field: Literal["connection_timeout_seconds"]
    value: int


SmbSettingsUpdate = Annotated[
    SmbReadChunkSizeUpdate | SmbAuthenticationModeUpdate | SmbEncryptionModeUpdate | SmbConnectionTimeoutUpdate,
    Field(discriminator="field"),
]
SmbSettingsUpdateResult = SmbSettingsUpdate


class PreprocessorAdvancedSettingsUpdate(SQLModel):
    max_file_size_bytes: Optional[int] = None
    timeout_seconds: Optional[int] = None


class AdvancedSystemSettingsPreprocessorsUpdate(SQLModel):
    imagemagick: Optional[PreprocessorAdvancedSettingsUpdate] = None


class PdfAdvancedSettingsUpdate(SQLModel):
    cache_quota_bytes: Optional[int] = None
    cache_inactivity_ttl_seconds: Optional[int] = None
    max_source_size_bytes: Optional[int] = None
    max_output_size_bytes: Optional[int] = None
    address_space_bytes: Optional[int] = None
    temporary_disk_bytes: Optional[int] = None
    timeout_seconds: Optional[int] = None
    cpu_time_seconds: Optional[int] = None
    max_concurrent: Optional[int] = None
    queue_wait_seconds: Optional[int] = None
    screen_derivative_enabled: Optional[int] = None
    screen_max_decoded_pixels: Optional[int] = None


class AdvancedSystemSettingsUpdate(SQLModel):
    preprocessors: Optional[AdvancedSystemSettingsPreprocessorsUpdate] = None
    pdf: Optional[PdfAdvancedSettingsUpdate] = None
    reset_keys: list[SystemSettingKey] = Field(default_factory=list)


FILE_SEARCH_POLICY_MAX_BYTES = 65_536
FILE_SEARCH_EXTENSION_MAX_LENGTH = 255


class FileSearchSettings(SQLModel):
    retention_limit: int = Field(default=200, ge=0, le=500)
    result_limit: int = Field(default=10, ge=1, le=50)
    excluded_categories: set[str] = Field(default_factory=lambda: {"images", "temporary_backup"})
    excluded_extensions: set[str] = Field(default_factory=set)

    @field_validator("excluded_categories")
    @classmethod
    def validate_categories(cls, value: set[str]) -> set[str]:
        unsupported = value.difference({"images", "temporary_backup"})
        if unsupported:
            raise ValueError(f"Unsupported file-search exclusion categories: {', '.join(sorted(unsupported))}")
        return value

    @field_validator("excluded_extensions")
    @classmethod
    def normalize_extensions(cls, value: set[str]) -> set[str]:
        normalized: set[str] = set()
        for extension in value:
            candidate = extension.strip().lower()
            if not candidate:
                continue
            if any(character in candidate for character in "*?[]{}") or "/" in candidate or "\\" in candidate:
                raise ValueError("File-search exclusions must be literal extensions, not glob patterns")
            candidate = candidate if candidate.startswith(".") else f".{candidate}"
            if len(candidate) > FILE_SEARCH_EXTENSION_MAX_LENGTH or candidate == ".":
                raise ValueError("File-search extension is invalid or too long")
            normalized.add(candidate)
        return normalized

    @model_validator(mode="after")
    def validate_serialized_size(self) -> "FileSearchSettings":
        if len(self.model_dump_json().encode("utf-8")) > FILE_SEARCH_POLICY_MAX_BYTES:
            raise ValueError("File-search policy is too large")
        return self


class FileSearchSettingsRead(SQLModel):
    settings: FileSearchSettings
    source: SystemSettingSource


class FileSearchRetentionLimitUpdate(StrictSettingUpdate):
    field: Literal["retention_limit"]
    value: int


class FileSearchResultLimitUpdate(StrictSettingUpdate):
    field: Literal["result_limit"]
    value: int


class FileSearchExcludedCategoriesUpdate(StrictSettingUpdate):
    field: Literal["excluded_categories"]
    value: set[str]


class FileSearchExcludedExtensionsUpdate(StrictSettingUpdate):
    field: Literal["excluded_extensions"]
    value: set[str]


FileSearchSettingsUpdate = Annotated[
    FileSearchRetentionLimitUpdate | FileSearchResultLimitUpdate | FileSearchExcludedCategoriesUpdate | FileSearchExcludedExtensionsUpdate,
    Field(discriminator="field"),
]
FileSearchSettingsUpdateResult = FileSearchSettingsUpdate


class NetworkSettingsRead(SQLModel):
    public_url: str
    trusted_proxy_cidrs: list[str]


class NetworkPublicUrlUpdate(StrictSettingUpdate):
    field: Literal["public_url"]
    value: str = Field(max_length=2048)


class NetworkTrustedProxyCidrsUpdate(StrictSettingUpdate):
    field: Literal["trusted_proxy_cidrs"]
    value: list[str] = Field(default_factory=list, max_length=100)


NetworkSettingsUpdate = Annotated[NetworkPublicUrlUpdate | NetworkTrustedProxyCidrsUpdate, Field(discriminator="field")]
NetworkSettingsUpdateResult = NetworkSettingsUpdate


class AboutSettingsRead(SQLModel):
    version: str
    build_time: str
    git_commit: str
    started_at: datetime
    architecture: str
    logical_cpu_count: Optional[int] = None
    memory_bytes: Optional[int] = None
    python_runtime: str


class PublicSupportReportRead(SQLModel):
    content: str
