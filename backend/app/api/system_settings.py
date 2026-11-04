from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlmodel import Session

from app.core.authorization import Capability
from app.core.logging import set_user
from app.core.security import (
    BrowserAuthentication,
    get_current_browser_authentication_with_auth_check,
    get_current_user_with_auth_check,
    require_capability,
)
from app.core.system_setting_definitions import DirectoryIndexPolicyScope
from app.db.database import get_immediate_session, get_session
from app.models.companion_settings import SettingsGrantBinding, SettingsGrantRead, SettingsGrantRedeem, SettingsMetadata, SettingsReceipt
from app.models.system_settings import (
    AboutSettingsRead,
    AdvancedSystemSettingsRead,
    AdvancedSystemSettingUpdate,
    DirectoryIndexSettingsRead,
    DirectoryIndexSettingUpdate,
    DirectoryPolicyGrantBinding,
    DirectoryPolicyGrantRead,
    DirectoryPolicyGrantReceipt,
    DirectoryPolicyGrantRedeem,
    FileSearchSettingsRead,
    FileSearchSettingsUpdate,
    FileSearchSettingsUpdateResult,
    NetworkSettingsRead,
    NetworkSettingsUpdate,
    NetworkSettingsUpdateResult,
    PublicSupportReportRead,
    SmbSettingsRead,
    SmbSettingsUpdate,
    SmbSettingsUpdateResult,
)
from app.models.user import User
from app.services.system_settings import (
    build_about_settings_read,
    build_advanced_system_settings_read,
    build_directory_index_settings_read,
    build_file_search_settings_read,
    build_network_settings_read,
    build_public_support_report_read,
    build_smb_settings_read,
    refresh_smb_runtime_policy,
    retire_smb_runtime_policy,
    smb_policy_will_change,
    update_advanced_system_settings,
    update_directory_index_settings,
    update_file_search_settings,
    update_network_settings,
    update_smb_settings,
)

router = APIRouter()


@router.get("/settings/companion", response_model=SettingsMetadata)
def get_companion_settings(
    current_user: User = Depends(get_current_user_with_auth_check), session: Session = Depends(get_session)
) -> SettingsMetadata:
    from app.services.companion_settings import build_settings_metadata

    return build_settings_metadata(current_user, session)


@router.post("/settings/companion/grants", response_model=SettingsGrantRead)
def post_companion_settings_grant(
    payload: SettingsGrantBinding,
    request: Request,
    authentication: BrowserAuthentication = Depends(get_current_browser_authentication_with_auth_check),
    session: Session = Depends(get_immediate_session),
) -> SettingsGrantRead:
    from app.services.directory_policy_grants import issue_directory_policy_grant

    if request.headers.get("origin") != payload.origin:
        raise HTTPException(status_code=403, detail="Settings origin does not match the browser. Retry from the paired server.")
    result = issue_directory_policy_grant(payload, authentication.user, session, browser_session_id=authentication.oidc_browser_session_id)
    assert isinstance(result, SettingsGrantRead)
    return result


@router.post("/settings/companion/grants/redeem", response_model=SettingsReceipt)
def post_companion_settings_redemption(payload: SettingsGrantRedeem, session: Session = Depends(get_immediate_session)) -> SettingsReceipt:
    from app.services.directory_policy_grants import redeem_directory_policy_grant

    result = redeem_directory_policy_grant(payload, session)
    assert isinstance(result, SettingsReceipt)
    return result


@router.post("/settings/directory-index/companion/grants", response_model=DirectoryPolicyGrantRead)
async def post_directory_policy_grant(
    payload: DirectoryPolicyGrantBinding,
    request: Request,
    session: Session = Depends(get_immediate_session),
    current_user: User = Depends(get_current_user_with_auth_check),
) -> DirectoryPolicyGrantRead:
    raise HTTPException(status_code=426, detail="Separate policy approval is no longer supported. Update Sambee and Companion.")


@router.post("/settings/directory-index/companion/grants/redeem", response_model=DirectoryPolicyGrantReceipt)
async def post_directory_policy_grant_redemption(
    payload: DirectoryPolicyGrantRedeem,
    session: Session = Depends(get_immediate_session),
) -> DirectoryPolicyGrantReceipt:
    raise HTTPException(status_code=426, detail="Separate policy delivery is no longer supported. Update Sambee and Companion.")


@router.get("/settings/directory-index/{scope}", response_model=DirectoryIndexSettingsRead)
async def get_directory_index_settings(
    scope: DirectoryIndexPolicyScope,
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
    session: Session = Depends(get_session),
) -> DirectoryIndexSettingsRead:
    set_user(current_user.username)
    try:
        return build_directory_index_settings_read(scope, session)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error


@router.put("/settings/directory-index/{scope}", response_model=DirectoryIndexSettingUpdate)
async def put_directory_index_settings(
    scope: DirectoryIndexPolicyScope,
    payload: DirectoryIndexSettingUpdate,
    session: Session = Depends(get_immediate_session),
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
) -> DirectoryIndexSettingUpdate:
    set_user(current_user.username)
    try:
        updated = update_directory_index_settings(scope, payload, updated_by_user_id=current_user.id, session=session)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    if scope is DirectoryIndexPolicyScope.BACKEND:
        from app.services.directory_cache import get_directory_cache_manager

        policy = build_directory_index_settings_read(scope, session).policy
        await asyncio.to_thread(get_directory_cache_manager().apply_policy, policy)
    return updated


@router.get("/settings/file-search", response_model=FileSearchSettingsRead)
async def get_file_search_settings(
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
    session: Session = Depends(get_session),
) -> FileSearchSettingsRead:
    set_user(current_user.username)
    return build_file_search_settings_read(session)


@router.put("/settings/file-search", response_model=FileSearchSettingsUpdateResult)
async def put_file_search_settings(
    payload: FileSearchSettingsUpdate,
    session: Session = Depends(get_immediate_session),
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
) -> FileSearchSettingsUpdateResult:
    set_user(current_user.username)
    try:
        return update_file_search_settings(payload, updated_by_user_id=current_user.id, session=session)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/settings/about", response_model=AboutSettingsRead)
async def get_about_settings(
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
) -> AboutSettingsRead:
    set_user(current_user.username)
    return build_about_settings_read()


@router.get("/settings/support-report", response_model=PublicSupportReportRead)
async def get_public_support_report(
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
    session: Session = Depends(get_session),
) -> PublicSupportReportRead:
    set_user(current_user.username)
    return build_public_support_report_read(session)


@router.get("/settings/advanced", response_model=AdvancedSystemSettingsRead)
async def get_advanced_system_settings(
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
) -> AdvancedSystemSettingsRead:
    set_user(current_user.username)
    return build_advanced_system_settings_read()


@router.put("/settings/advanced", response_model=AdvancedSystemSettingUpdate)
async def put_advanced_system_settings(
    payload: AdvancedSystemSettingUpdate,
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
    session: Session = Depends(get_session),
) -> AdvancedSystemSettingUpdate:
    set_user(current_user.username)
    try:
        return update_advanced_system_settings(payload, updated_by_user_id=current_user.id, session=session)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.get("/settings/smb", response_model=SmbSettingsRead)
async def get_smb_settings(
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
) -> SmbSettingsRead:
    set_user(current_user.username)
    return build_smb_settings_read()


@router.put("/settings/smb", response_model=SmbSettingsUpdateResult)
async def put_smb_settings(
    payload: SmbSettingsUpdate,
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
    session: Session = Depends(get_session),
) -> SmbSettingsUpdateResult:
    set_user(current_user.username)
    try:
        policy_changed = smb_policy_will_change(payload, session)
        updated_settings = update_smb_settings(payload, updated_by_user_id=current_user.id, session=session)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if policy_changed:
        await retire_smb_runtime_policy()
        await refresh_smb_runtime_policy()
    return updated_settings


@router.get("/settings/network", response_model=NetworkSettingsRead)
async def get_network_settings(
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
    session: Session = Depends(get_session),
) -> NetworkSettingsRead:
    set_user(current_user.username)
    return build_network_settings_read(session)


@router.put("/settings/network", response_model=NetworkSettingsUpdateResult)
async def put_network_settings(
    payload: NetworkSettingsUpdate,
    current_user: User = Depends(require_capability(Capability.ACCESS_ADMIN_SETTINGS)),
    session: Session = Depends(get_session),
) -> NetworkSettingsUpdateResult:
    set_user(current_user.username)
    try:
        return update_network_settings(payload, updated_by_user_id=current_user.id, session=session)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
