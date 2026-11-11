import asyncio
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session, select

from app.api._smb_helpers import build_smb_backend_from_details, disconnect_backend_safely
from app.core.logging import get_logger, set_user
from app.core.security import decrypt_password, encrypt_password, get_current_user_with_auth_check
from app.db.database import get_session
from app.models.connection import (
    Connection,
    ConnectionCreate,
    ConnectionRead,
    ConnectionUpdate,
    ConnectionVisibilityOptionRead,
    generate_unique_connection_slug,
)
from app.models.user import User
from app.services.connection_access import (
    build_connection_read,
    get_accessible_connection_or_404,
    list_accessible_connections,
    list_connection_visibility_options,
    require_manageable_connection,
    require_user_write_access,
    resolve_connection_scope_for_create,
    resolve_connection_scope_for_update,
)
from app.services.directory_cache import get_directory_cache_manager
from app.services.directory_monitor import get_monitor
from app.storage.smb import SMBBackend
from app.storage.smb_pool import retire_smb_connection_context

router = APIRouter()
logger = get_logger(__name__)


async def _test_connection_details(
    *,
    host: str,
    share_name: str,
    username: str,
    password: str,
    port: int,
    path_prefix: str | None,
) -> int:
    """Validate that a connection can authenticate and list its base directory."""

    backend = build_smb_backend_from_details(
        host=host,
        share_name=share_name,
        username=username,
        password=password,
        port=port,
        path_prefix=path_prefix,
        backend_factory=SMBBackend,
    )
    await backend.connect()
    try:
        listing = await backend.list_directory("")
    finally:
        await disconnect_backend_safely(
            backend,
            logger=logger,
            context=f"connection validation for //{host}:{port}/{share_name}",
        )

    total = getattr(listing, "total", None)
    if isinstance(total, int):
        return total
    if hasattr(listing, "__len__"):
        return len(listing)
    return 0


def _resolve_connection_test_details(
    connection: Connection,
    connection_data: ConnectionUpdate | None = None,
) -> tuple[str, str, str, str, int, str | None]:
    """Merge an optional connection draft with stored values for an SMB test."""

    update_data = connection_data.model_dump(exclude_unset=True) if connection_data else {}
    share_name = update_data.get("share_name") or connection.share_name
    if not share_name:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Share name is required")

    password = update_data.get("password") or decrypt_password(connection.password_encrypted)
    return (
        update_data.get("host") or connection.host,
        share_name,
        update_data.get("username") or connection.username,
        password,
        update_data.get("port") or connection.port,
        update_data.get("path_prefix", connection.path_prefix),
    )


@router.get("/connections", response_model=list[ConnectionRead])
async def list_connections(
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> list[ConnectionRead]:
    """List all configured connections visible to the current user."""

    set_user(current_user.username)

    connections = list_accessible_connections(session, current_user)
    logger.debug("event=connections_listed count=%s", len(connections))
    return [build_connection_read(connection, current_user) for connection in connections]


@router.get("/connections/visibility-options", response_model=list[ConnectionVisibilityOptionRead])
async def list_visibility_options(
    current_user: User = Depends(get_current_user_with_auth_check),
) -> list[ConnectionVisibilityOptionRead]:
    """Return connection visibility options supported by the system for the current user."""

    set_user(current_user.username)
    logger.debug(f"Listing connection visibility options: user={current_user.username}")
    return list_connection_visibility_options(current_user)


@router.post("/connections/test-config")
async def test_connection_config(
    connection_data: ConnectionCreate,
    current_user: User = Depends(get_current_user_with_auth_check),
) -> dict[str, str]:
    """Test a connection definition without persisting it."""

    set_user(current_user.username)
    require_user_write_access(current_user, action="test_connection_config")

    try:
        await _test_connection_details(
            host=connection_data.host,
            share_name=connection_data.share_name,
            username=connection_data.username,
            password=connection_data.password,
            port=connection_data.port,
            path_prefix=connection_data.path_prefix,
        )
    except TimeoutError as error:
        logger.error(
            f"Connection test timed out: host={connection_data.host}, share={connection_data.share_name}, user={current_user.username}, error={error}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Connection test timed out. The remote share did not respond in time.",
        )
    except Exception as error:
        logger.error(
            f"Connection test failed: host={connection_data.host}, share={connection_data.share_name}, user={current_user.username}, error={type(error).__name__}: {error}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to connect to SMB share: {str(error)}",
        )

    return {"status": "success", "message": "Successfully connected to the SMB share."}


@router.post("/connections", response_model=ConnectionRead)
async def create_connection(
    connection_data: ConnectionCreate,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> ConnectionRead:
    """Create a new SMB connection."""

    set_user(current_user.username)
    require_user_write_access(current_user, action="create_connection")
    logger.info(
        f"Creating connection: name={connection_data.name}, host={connection_data.host}, "
        f"share={connection_data.share_name}, scope={connection_data.scope}, user={current_user.username}"
    )

    try:
        await _test_connection_details(
            host=connection_data.host,
            share_name=connection_data.share_name,
            username=connection_data.username,
            password=connection_data.password,
            port=connection_data.port,
            path_prefix=connection_data.path_prefix,
        )
        logger.info(f"Connection test successful: name={connection_data.name}")
    except TimeoutError as error:
        logger.error(
            f"Connection test timed out: name={connection_data.name}, host={connection_data.host}, share={connection_data.share_name}, error={error}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Connection test timed out. The remote share did not respond in time.",
        )
    except Exception as error:
        logger.error(
            f"Connection test failed: name={connection_data.name}, host={connection_data.host}, "
            f"share={connection_data.share_name}, error={type(error).__name__}: {error}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to connect to SMB share: {str(error)}",
        )

    existing_slugs = set(session.exec(select(Connection.slug)).all())
    resolved_scope, owner_user_id = resolve_connection_scope_for_create(current_user, connection_data.scope)
    connection = Connection(
        name=connection_data.name,
        slug=generate_unique_connection_slug(connection_data.name, existing_slugs),
        type=connection_data.type,
        host=connection_data.host,
        port=connection_data.port,
        share_name=connection_data.share_name,
        username=connection_data.username,
        password_encrypted=encrypt_password(connection_data.password),
        path_prefix=connection_data.path_prefix,
        scope=resolved_scope,
        access_mode=connection_data.access_mode,
        owner_user_id=owner_user_id,
    )

    try:
        session.add(connection)
        session.commit()
        session.refresh(connection)
    except Exception as error:
        session.rollback()
        if "UNIQUE constraint failed" in str(error) or "duplicate key" in str(error).lower():
            logger.error(f"Duplicate connection slug: slug={connection.slug}, name={connection_data.name}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Failed to create a unique connection slug",
            )
        logger.error(f"Failed to save connection: error={type(error).__name__}: {error}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to save connection to database",
        )

    return build_connection_read(connection, current_user)


@router.put("/connections/{connection_id}", response_model=ConnectionRead)
async def update_connection(
    connection_id: uuid.UUID,
    connection_data: ConnectionUpdate,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> ConnectionRead:
    """Update an existing connection."""

    require_user_write_access(current_user, action="update_connection")
    connection = get_accessible_connection_or_404(session, current_user, connection_id)
    require_manageable_connection(connection, current_user)

    update_dict = connection_data.model_dump(exclude_unset=True)
    requested_scope = update_dict.pop("scope", None)
    new_password = update_dict.pop("password", None) if "password" in update_dict else None

    if any(key in update_dict for key in ["host", "share_name", "username", "port", "path_prefix"]) or new_password is not None:
        try:
            test_host, test_share, test_username, password_to_test, test_port, test_path_prefix = _resolve_connection_test_details(
                connection,
                connection_data,
            )
            await _test_connection_details(
                host=test_host,
                share_name=test_share,
                username=test_username,
                password=password_to_test,
                port=test_port,
                path_prefix=test_path_prefix,
            )
        except TimeoutError:
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail="Connection test timed out. The remote share did not respond in time.",
            )
        except Exception as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Failed to connect to SMB share: {str(error)}",
            )

    next_scope, next_owner_user_id = resolve_connection_scope_for_update(current_user, connection, requested_scope)

    for key, value in update_dict.items():
        setattr(connection, key, value)
    if new_password is not None:
        connection.password_encrypted = encrypt_password(new_password)

    connection.scope = next_scope
    connection.owner_user_id = next_owner_user_id
    connection.updated_at = datetime.now(timezone.utc)

    try:
        session.add(connection)
        session.commit()
        session.refresh(connection)
    except Exception as error:
        session.rollback()
        if "UNIQUE constraint failed" in str(error) or "duplicate key" in str(error).lower():
            logger.error(f"Duplicate connection slug during update: slug={connection.slug}, id={connection.id}")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Connection slug conflict detected",
            )
        logger.error(f"Failed to update connection: error={type(error).__name__}: {error}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update connection in database",
        )

    connection_key = str(connection.id)
    await retire_smb_connection_context(connection_key, "connection updated")
    await asyncio.gather(
        get_directory_cache_manager().remove_cache_async(connection_key),
        get_monitor().stop_connection_async(connection_key),
    )

    return build_connection_read(connection, current_user)


@router.delete("/connections/{connection_id}")
async def delete_connection(
    connection_id: uuid.UUID,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> dict[str, str]:
    """Delete a connection."""

    require_user_write_access(current_user, action="delete_connection")
    connection = get_accessible_connection_or_404(session, current_user, connection_id)
    require_manageable_connection(connection, current_user)

    session.delete(connection)
    session.commit()

    connection_key = str(connection.id)
    await retire_smb_connection_context(connection_key, "connection deleted")
    await asyncio.gather(
        get_directory_cache_manager().remove_cache_async(connection_key),
        get_monitor().stop_connection_async(connection_key),
    )

    return {"message": "Connection deleted successfully"}


@router.post("/connections/{connection_id}/test")
async def test_connection(
    connection_id: uuid.UUID,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
    connection_data: ConnectionUpdate | None = None,
) -> dict[str, str]:
    """Test a persisted connection, optionally using unsaved draft values."""

    require_user_write_access(current_user, action="test_connection")
    connection = get_accessible_connection_or_404(session, current_user, connection_id)
    require_manageable_connection(connection, current_user)

    if not connection.share_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Connection has no share name configured",
        )

    try:
        test_host, test_share, test_username, test_password, test_port, test_path_prefix = _resolve_connection_test_details(
            connection,
            connection_data,
        )
        listing_total = await _test_connection_details(
            host=test_host,
            share_name=test_share,
            username=test_username,
            password=test_password,
            port=test_port,
            path_prefix=test_path_prefix,
        )

        return {
            "status": "success",
            "message": f"Successfully connected. Found {listing_total} items in root directory.",
        }
    except TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Connection test timed out. The remote share did not respond in time.",
        )
    except Exception as error:
        return {"status": "error", "message": str(error)}
