from __future__ import annotations

from enum import StrEnum


class UserSettingKey(StrEnum):
    APPEARANCE_THEME_ID = "appearance.theme_id"
    APPEARANCE_CUSTOM_THEMES = "appearance.custom_themes"
    LOCALIZATION_LANGUAGE = "localization.language"
    LOCALIZATION_REGIONAL_LOCALE = "localization.regional_locale"
    BROWSER_QUICK_NAV_INCLUDE_DOT_DIRECTORIES = "browser.quick_nav_include_dot_directories"
    BROWSER_QUICK_BAR_SHORTCUT_HINT_VISIBILITY = "browser.quick_bar_shortcut_hint_visibility"
    BROWSER_TOUCH_FRIENDLY_FILE_SELECTION = "browser.touch_friendly_file_selection"
    BROWSER_FILE_BROWSER_VIEW_MODE = "browser.file_browser_view_mode"
    BROWSER_PANE_MODE = "browser.pane_mode"
    BROWSER_SELECTED_CONNECTION_ID = "browser.selected_connection_id"
    BROWSER_VIEWER_ASSOCIATIONS = "browser.viewer_associations"
    TEXT_EDITOR_MAX_FILE_SIZE_BYTES = "text_editor.max_file_size_bytes"
    TEXT_EDITOR_WORD_WRAP_ENABLED = "text_editor.word_wrap_enabled"
    IMAGE_VIEWER_TRANSITION = "image_viewer.transition"


DEFAULT_THEME_ID = "sambee-light"
DEFAULT_LANGUAGE_PREFERENCE = "browser"
DEFAULT_REGIONAL_LOCALE_PREFERENCE = "browser"
DEFAULT_QUICK_NAV_INCLUDE_DOT_DIRECTORIES = False
DEFAULT_QUICK_BAR_SHORTCUT_HINT_VISIBILITY = "auto"
DEFAULT_TOUCH_FRIENDLY_FILE_SELECTION = "auto"
DEFAULT_FILE_BROWSER_VIEW_MODE = "list"
DEFAULT_PANE_MODE = "single"
DEFAULT_TEXT_EDITOR_MAX_FILE_SIZE_BYTES = 52_428_800
DEFAULT_IMAGE_VIEWER_TRANSITION = "none"
