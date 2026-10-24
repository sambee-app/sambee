from __future__ import annotations

import json
import re
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.core.security import get_current_user_with_auth_check
from app.core.user_setting_definitions import UserSettingKey
from app.db.database import get_immediate_session, get_session
from app.models.system_settings import SystemSetting
from app.models.theme import StoredTheme, ThemeDefinition, ThemeListRead, ThemeRead, ThemeWrite
from app.models.user import User, UserRole
from app.models.user_settings import UserSetting
from app.services.user_settings import _built_in_theme_ids

router = APIRouter()
DEFAULT_THEME_ID = "sambee-light"
SITE_DEFAULT_KEY = "appearance.site_default_theme_id"
HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$")

COLOR_SHAPE: dict[str, Any] = {
    "primary": ("main", "light", "dark", "contrastText"),
    "background": ("default", "chrome"),
    "text": ("primary", "secondary"),
    "action": ("selected",),
    "components": {
        "syntax": ("keyword", "string", "number", "comment", "type", "function", "operator", "punctuation"),
        "link": ("main", "hover"),
        "search": ("otherMatch", "currentMatch"),
        "pdfViewer": ("viewerBackground", "toolbarBackground", "toolbarText"),
        "imageViewer": ("viewerBackground", "toolbarBackground", "toolbarText"),
        "markdownViewer": {
            "viewerBackground": None,
            "toolbarBackground": None,
            "toolbarText": None,
            "viewerText": None,
            "secondaryToolbarSelected": None,
            "document": (
                "blockBackground",
                "inlineBackground",
                "blockBorder",
                "inlineBorder",
                "codeText",
                "activeLineGutterBackground",
                "tableBackground",
                "alternateRowBackground",
                "headerBackground",
                "headerText",
                "tableBorder",
                "blockquoteBorder",
                "blockquoteText",
                "headingBorder",
            ),
        },
        "alert": {kind: ("background", "text", "icon") for kind in ("info", "success", "warning", "error")},
    },
}


def _validate_colors(value: Any, shape: Any, path: str = "") -> None:
    if shape is None:
        if not isinstance(value, str) or not HEX_COLOR.fullmatch(value):
            raise ValueError(f"{path} must be #RRGGBB or #RRGGBBAA")
        return
    if isinstance(shape, tuple):
        shape = dict.fromkeys(shape)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain all color roles")
    for key, child_shape in shape.items():
        if path == "components" and key == "syntax" and key not in value:
            continue
        if key not in value:
            raise ValueError(f"Missing color role: {path}.{key}".lstrip("."))
        _validate_colors(value[key], child_shape, f"{path}.{key}".lstrip("."))
    # Compatibility-only roles are intentionally not exposed in the editor.
    allowed_extras = {"background": {"paper"}, "action": {"focus", "selectedDarker"}}
    for key in set(value) & allowed_extras.get(path, set()):
        _validate_colors(value[key], None, f"{path}.{key}")
    unknown = set(value) - set(shape) - allowed_extras.get(path, set())
    if unknown:
        raise ValueError(f"Unknown color role: {path}.{sorted(unknown)[0]}".lstrip("."))


def _validate_definition(definition: ThemeDefinition) -> dict[str, Any]:
    if not definition.name.strip():
        raise ValueError("Theme name cannot be empty")
    data = definition.model_dump()
    data["name"] = definition.name.strip()
    for key, shape in COLOR_SHAPE.items():
        _validate_colors(data[key], shape, key)

    def normalize_colors(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: normalize_colors(child) for key, child in value.items()}
        return value.upper() if isinstance(value, str) and HEX_COLOR.fullmatch(value) else value

    for key in COLOR_SHAPE:
        data[key] = normalize_colors(data[key])
    return data


def _read(row: StoredTheme) -> ThemeRead:
    return ThemeRead(
        id=row.id,
        scope="user" if row.owner_user_id is not None else "site",
        version=row.version,
        definition=ThemeDefinition.model_validate_json(row.definition),
    )


def _require_admin(user: User) -> None:
    if user.role != UserRole.ADMIN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only administrators can manage site themes")


def _writable(row: StoredTheme, user: User) -> None:
    if row.owner_user_id is None:
        _require_admin(user)
    elif row.owner_user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Theme not found")


def _check_version(row: StoredTheme, version: int) -> None:
    if row.version != version:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Theme changed in another tab. Refresh and try again")


@router.get("", response_model=ThemeListRead)
def list_themes(user: User = Depends(get_current_user_with_auth_check), session: Session = Depends(get_session)) -> ThemeListRead:
    rows = session.exec(select(StoredTheme).where((StoredTheme.owner_user_id == user.id) | (StoredTheme.owner_user_id == None))).all()  # noqa: E711
    default = session.get(SystemSetting, SITE_DEFAULT_KEY)
    return ThemeListRead(themes=[_read(row) for row in rows], site_default_id=default.value if default else DEFAULT_THEME_ID)


@router.post("", response_model=ThemeRead, status_code=status.HTTP_201_CREATED)
def create_theme(
    payload: ThemeWrite,
    user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_immediate_session),
) -> ThemeRead:
    if payload.version is not None:
        raise HTTPException(status_code=400, detail="New themes must not specify a version")
    if payload.scope == "site":
        _require_admin(user)
    try:
        definition = _validate_definition(payload.definition)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    rows = session.exec(select(StoredTheme).where(StoredTheme.owner_user_id == (user.id if payload.scope == "user" else None))).all()
    if any(json.loads(row.definition)["name"].casefold() == payload.definition.name.strip().casefold() for row in rows):
        raise HTTPException(status_code=409, detail="A theme with this name already exists in this group")
    theme_id = str(uuid.uuid4())
    if theme_id in _built_in_theme_ids():
        raise HTTPException(status_code=409, detail="Generated theme ID conflicts with a built-in theme. Try again")
    row = StoredTheme(id=theme_id, owner_user_id=user.id if payload.scope == "user" else None, definition=json.dumps(definition))
    session.add(row)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Generated theme ID already exists. Try again") from exc
    return _read(row)


@router.put("/{theme_id}", response_model=ThemeRead)
def update_theme(
    theme_id: str,
    payload: ThemeWrite,
    user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_immediate_session),
) -> ThemeRead:
    row = session.get(StoredTheme, theme_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Theme not found")
    _writable(row, user)
    if payload.version is None:
        raise HTTPException(status_code=428, detail="Theme version is required")
    _check_version(row, payload.version)
    if payload.scope != ("user" if row.owner_user_id else "site"):
        raise HTTPException(status_code=409, detail="Theme storage group cannot change during an update")
    try:
        definition = _validate_definition(payload.definition)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    rows = session.exec(select(StoredTheme).where(StoredTheme.owner_user_id == row.owner_user_id, StoredTheme.id != row.id)).all()
    if any(json.loads(other.definition)["name"].casefold() == payload.definition.name.strip().casefold() for other in rows):
        raise HTTPException(status_code=409, detail="A theme with this name already exists in this group")
    row.definition = json.dumps(definition)
    row.version += 1
    session.add(row)
    session.commit()
    return _read(row)


@router.delete("/{theme_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_theme(
    theme_id: str,
    version: int,
    user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_immediate_session),
) -> None:
    row = session.get(StoredTheme, theme_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Theme not found")
    _writable(row, user)
    _check_version(row, version)
    selections = session.exec(
        select(UserSetting).where(UserSetting.key == UserSettingKey.APPEARANCE_THEME_ID.value, UserSetting.value == theme_id)
    ).all()
    for selection in selections:
        session.delete(selection)
    default = session.get(SystemSetting, SITE_DEFAULT_KEY)
    if default is not None and default.value == theme_id:
        session.delete(default)
    session.delete(row)
    session.commit()


@router.put("/default/{theme_id}", response_model=ThemeListRead)
def set_site_default(
    theme_id: str,
    user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_immediate_session),
) -> ThemeListRead:
    _require_admin(user)
    row = session.get(StoredTheme, theme_id)
    if theme_id not in _built_in_theme_ids() and (row is None or row.owner_user_id is not None):
        raise HTTPException(status_code=400, detail="Site default must be a built-in or site theme")
    setting = session.get(SystemSetting, SITE_DEFAULT_KEY)
    if setting is None:
        setting = SystemSetting(key=SITE_DEFAULT_KEY, value=theme_id, updated_by_user_id=user.id)
    else:
        setting.value = theme_id
        setting.updated_by_user_id = user.id
    session.add(setting)
    session.commit()
    return list_themes(user, session)
