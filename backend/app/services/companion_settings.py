"""Canonical settings built from server policy and the requesting user's preferences."""

import hashlib
import json

from sqlmodel import Session

from app.core.directory_index_contract import CONTRACT_PATH
from app.core.system_setting_definitions import DirectoryIndexPolicyScope
from app.core.user_setting_definitions import DEFAULT_THEME_ID
from app.models.companion_settings import (
    CompanionTheme,
    DirectoryIndexSection,
    LocalizationSection,
    SectionMarker,
    SettingsMetadata,
    ThemeSection,
)
from app.models.theme import StoredTheme, ThemeDefinition
from app.models.user import User
from app.services.directory_policy_grants import backend_policy_identity
from app.services.system_settings import build_directory_index_settings_read
from app.services.user_settings import build_current_user_settings_read

BUILT_IN_THEMES = {
    key: CompanionTheme.model_validate(value)
    for key, value in json.loads((CONTRACT_PATH.parent.parent / "companion-themes.json").read_text(encoding="utf-8")).items()
}


def section_digest(payload: CompanionTheme | object) -> str:
    from pydantic import BaseModel

    if not isinstance(payload, BaseModel):
        raise TypeError("Settings digest requires a validated section payload.")
    canonical = json.dumps(payload.model_dump(), sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_settings_sections(user: User, session: Session) -> tuple[ThemeSection, LocalizationSection, DirectoryIndexSection]:
    preferences = build_current_user_settings_read(user_id=user.id, session=session)
    theme_id = preferences.appearance.theme_id
    theme = BUILT_IN_THEMES.get(theme_id)
    if theme is None:
        row = session.get(StoredTheme, theme_id)
        if row is not None and row.owner_user_id in (None, user.id):
            definition = ThemeDefinition.model_validate_json(row.definition)
            theme = CompanionTheme.model_validate(
                {"id": theme_id, "mode": definition.mode, "primary": {"main": definition.primary["main"]}}
            )
        else:
            theme = BUILT_IN_THEMES[DEFAULT_THEME_ID]
    scope = str(user.id)
    directory = build_directory_index_settings_read(DirectoryIndexPolicyScope.COMPANION, session)
    return (
        ThemeSection(marker=section_digest(theme), user_scope=scope, payload=theme),
        LocalizationSection(marker=section_digest(preferences.localization), user_scope=scope, payload=preferences.localization),
        DirectoryIndexSection(marker=str(directory.revision), payload=directory.policy),
    )


def build_settings_metadata(user: User, session: Session) -> SettingsMetadata:
    theme, localization, directory = build_settings_sections(user, session)
    return SettingsMetadata(
        backend_identity=backend_policy_identity(),
        theme=SectionMarker.model_validate(theme.model_dump(exclude={"payload"})),
        localization=SectionMarker.model_validate(localization.model_dump(exclude={"payload"})),
        directory_index=SectionMarker.model_validate(directory.model_dump(exclude={"payload"})),
    )
