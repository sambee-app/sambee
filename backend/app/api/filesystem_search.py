"""Authenticated live-search endpoint for SMB connections."""

import asyncio
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session
from starlette.types import Receive, Scope, Send

from app.api._smb_helpers import build_smb_backend
from app.core.filesystem_search_contract import SearchRequest
from app.core.security import get_current_browser_authentication_with_auth_check, get_current_user_with_auth_check, oauth2_scheme_optional
from app.db.database import get_session
from app.models.connection import Connection
from app.models.user import User
from app.services.connection_access import get_accessible_connection_or_404
from app.services.directory_traversal import DirectoryTraversalError, validate_smb_search_path
from app.services.filesystem_search_admission import SearchAdmission, SearchAdmissionError
from app.services.filesystem_search_worker import SearchCapacityError, SearchPolicy, SmbSearchWorker
from app.services.system_settings import FilesystemSearchPolicyError, get_filesystem_search_policy

router = APIRouter()
logger = logging.getLogger(__name__)
_admission = SearchAdmission()


class _SearchStreamingResponse(StreamingResponse):
    def __init__(self, worker: SmbSearchWorker) -> None:
        self._worker = worker
        super().__init__(
            worker.stream(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._worker.stop()


def _source_revision(connection: Connection) -> tuple[object, ...]:
    return (
        connection.host,
        connection.port,
        connection.share_name,
        connection.username,
        connection.password_encrypted,
        connection.path_prefix,
        connection.scope,
        connection.owner_user_id,
        connection.type,
    )


@router.post("/{connection_id}/filesystem-search")
async def start_filesystem_search(
    connection_id: uuid.UUID,
    body: SearchRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
    token: str | None = Depends(oauth2_scheme_optional),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Start an independent search after validating the account and source."""
    try:
        source_id = uuid.UUID(body.source.id)
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Select a valid SMB connection and retry.") from error
    if body.source.kind != "smb" or source_id != connection_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="The search source does not match the selected connection."
        )
    try:
        validate_smb_search_path(body.root.path)
    except (ValueError, DirectoryTraversalError) as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error
    connection = get_accessible_connection_or_404(session, current_user, connection_id)
    if connection.type != "smb" or not connection.share_name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Select an SMB share and try again.")
    prefix = (connection.path_prefix or "").replace("\\", "/").strip("/")
    try:
        validate_smb_search_path("/".join(part for part in (prefix, body.root.path) if part))
    except (ValueError, DirectoryTraversalError) as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error
    backend = build_smb_backend(connection)
    try:
        policy = SearchPolicy(**get_filesystem_search_policy(session).model_dump())
    except FilesystemSearchPolicyError as error:
        logger.error("Search policy is invalid. An administrator must correct the stored policy.", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="File-system search settings are invalid. Ask an administrator to correct them, then retry.",
        ) from error
    try:
        lease = _admission.admit(str(current_user.id), str(connection_id), policy.concurrent_searches)
    except SearchAdmissionError as error:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": f"search_{error.reason.value}", "message": str(error)},
        ) from error

    account_id = current_user.id
    revision = _source_revision(connection)
    bind = session.get_bind()

    async def check_authorization() -> bool:
        try:
            with Session(bind) as check_session:
                authentication = await get_current_browser_authentication_with_auth_check(token, check_session)
                if authentication.user.id != account_id:
                    return False
                current = get_accessible_connection_or_404(check_session, authentication.user, connection_id)
                return _source_revision(current) == revision
        except HTTPException:
            return False
        except SQLAlchemyError:
            logger.exception("Could not verify search authorization. The search was stopped.")
            return False
        except Exception:
            logger.exception("Search authorization failed unexpectedly. The search was stopped.")
            return False

    async def authorize() -> bool:
        return await asyncio.to_thread(lambda: asyncio.run(check_authorization()))

    try:
        worker = SmbSearchWorker(body, policy, lease, backend, authorize)
        worker.start()
    except SearchCapacityError as error:
        lease.release()
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={"code": "search_capacity", "message": str(error)},
        ) from error
    except BaseException:
        lease.release()
        raise
    return _SearchStreamingResponse(worker)
