"""Versioned, section-specific Companion settings delivery contract."""

from typing import Final, Literal

from sqlmodel import Field

from app.models.system_settings import DirectoryIndexPolicy, DirectoryPolicyGrantBinding, DirectoryPolicyGrantRedeem, StrictSettingUpdate
from app.models.user_settings import LocalizationUserSettingsRead

SETTINGS_VERSION: Final[Literal[1]] = 1
SectionName = Literal["theme", "localization", "directory_index"]


class CompanionPrimaryColor(StrictSettingUpdate):
    main: str = Field(regex=r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")


class CompanionTheme(StrictSettingUpdate):
    id: str = Field(min_length=1, max_length=128)
    mode: Literal["light", "dark"]
    primary: CompanionPrimaryColor


class SectionMarker(StrictSettingUpdate):
    version: Literal[1] = SETTINGS_VERSION
    marker: str
    user_scope: str | None = None


class ThemeSection(SectionMarker):
    payload: CompanionTheme


class LocalizationSection(SectionMarker):
    payload: LocalizationUserSettingsRead


class DirectoryIndexSection(SectionMarker):
    payload: DirectoryIndexPolicy


class SettingsMetadata(StrictSettingUpdate):
    version: Literal[1] = SETTINGS_VERSION
    backend_identity: str
    theme: SectionMarker
    localization: SectionMarker
    directory_index: SectionMarker


class SettingsGrantBinding(DirectoryPolicyGrantBinding):
    version: Literal[1] = SETTINGS_VERSION
    sections: list[SectionName] = Field(default_factory=lambda: ["theme", "localization", "directory_index"], min_length=1, max_length=3)
    switch_user: bool = False


class SettingsGrantRead(SettingsMetadata):
    grant: str
    expires_in_seconds: int


class SettingsGrantRedeem(DirectoryPolicyGrantRedeem):
    version: Literal[1] = SETTINGS_VERSION


class SettingsReceipt(DirectoryPolicyGrantBinding):
    version: Literal[1] = SETTINGS_VERSION
    backend_identity: str
    switch_user: bool
    theme: ThemeSection | None = None
    localization: LocalizationSection | None = None
    directory_index: DirectoryIndexSection | None = None
