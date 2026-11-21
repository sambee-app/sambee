"""Regional locale syntax shared by browser preferences and Companion receipts."""

import re

from app.core.directory_index_contract import CONTRACT_PATH
from app.core.user_setting_definitions import DEFAULT_REGIONAL_LOCALE_PREFERENCE

MAX_REGIONAL_LOCALE_LENGTH = 128
_PATTERN = re.compile((CONTRACT_PATH.parent.parent / "regional-locale-pattern.txt").read_text(encoding="utf-8").strip())


def require_regional_locale(locale: str) -> str:
    """Require a concrete locale tag with no duplicate variants or extension identifiers."""
    match = _PATTERN.fullmatch(locale) if len(locale) <= MAX_REGIONAL_LOCALE_LENGTH else None
    if locale.lower() == DEFAULT_REGIONAL_LOCALE_PREFERENCE or match is None:
        raise ValueError("Regional locale must be a valid locale identifier like en-US")
    variants = match[1].lower().split("-")[1:]
    extensions = [part for part in match[2].lower().split("-") if len(part) == 1]
    if len(variants) != len(set(variants)) or len(extensions) != len(set(extensions)):
        raise ValueError("Regional locale cannot repeat variants or extension identifiers")
    return locale
