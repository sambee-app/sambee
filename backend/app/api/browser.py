import asyncio
import json
import secrets
import unicodedata
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from time import monotonic
from typing import Literal, NoReturn, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.api._smb_helpers import build_smb_backend, disconnect_backend_safely, file_target_http_error, require_share_name
from app.api.companion import (
    COMPANION_ERROR_LOCK_LOST,
    _generate_lock_capability,
    _generate_operation_id,
    _get_current_companion_operation_user,
    _raise_companion_operation_error,
    _validate_operation_lock_scope,
)
from app.core.logging import get_logger, set_user
from app.core.security import (
    decrypt_password,
    get_current_user_for_token,
    get_current_user_with_auth_check,
    oauth2_scheme_optional,
)
from app.core.system_setting_definitions import SystemSettingKey
from app.db.database import get_session
from app.models.archive import ArchiveDirectoryListing, ArchiveEntryInfo, ArchiveIdentity
from app.models.connection import Connection
from app.models.edit_lock import HEARTBEAT_TIMEOUT_SECONDS, EditLock
from app.models.file import (
    ConflictInfo,
    ContentTransferEffects,
    ContentTransferError,
    ContentTransferResult,
    CopyMoveRequest,
    CreateItemRequest,
    DirectoryListing,
    DirectorySearchResult,
    FileInfo,
    FileType,
    RenameRequest,
)
from app.models.recent_directory import (
    RecentDirectoryClearRead,
    RecentDirectoryRead,
    RecentDirectoryRecordRequest,
    RecentDirectorySearchRead,
)
from app.models.recent_file import (
    RecentFile,
    RecentFileClearRead,
    RecentFileRead,
    RecentFileRecordRequest,
    RecentFileSearchRead,
    RecentFileValidationCode,
    RecentFileValidationError,
)
from app.models.transfer_operation import (
    TransferOperation,
    TransferOperationCreate,
    TransferOperationPhase,
    TransferOperationRead,
)
from app.models.user import User
from app.services.archive.execution import resolve_archive_inspection_topology_plan
from app.services.archive.temporary_download import (
    DOWNLOAD_FILENAME,
    TemporaryArchiveSizeLimitExceeded,
    create_temporary_download,
)
from app.services.archive.zip_creation_source import ZipArchiveCreationSource
from app.services.archive.zip_reader import ArchiveFormatError, ZipReader
from app.services.connection_access import get_accessible_connection_or_404, require_connection_write_access
from app.services.content_transfer import (
    RegularFileSourceSnapshot,
    SourceChangedError,
    SourceDeleteError,
    SourceDeletionOutcomeUnknown,
    TargetCollisionError,
    resolve_regular_file_transfer,
)
from app.services.cross_connection import (
    RegularFileTransferRequiredError,
    TransferCancelled,
    copy_regular_file_to_missing_target,
    cross_connection_copy,
    cross_connection_move,
    final_target_policy_check,
)
from app.services.history_common import (
    LOCAL_DRIVE_PREFIX,
    directory_match_rank,
    normalize_history_search_text,
    normalize_recent_history_path,
)
from app.services.lock_manager import remove_expired_file_locks
from app.services.recent_directories import (
    MAX_RECENT_DIRECTORY_RESULTS,
    clear_recent_directories,
    record_recent_directory,
    remove_recent_directory,
    search_recent_directories,
)
from app.services.recent_files import (
    clear_recent_files,
    get_recent_file,
    get_recent_file_result_limit,
    record_recent_file,
    remove_recent_file,
    search_recent_files,
    should_record_recent_file,
)
from app.services.system_settings import get_integer_setting_value
from app.services.target_resolution import TargetResolutionDisposition, TargetResolutionPolicy, TargetSnapshot, resolve_target_mutation
from app.storage.smb import SMBBackend

router = APIRouter()
logger = get_logger(__name__)

DIRECTORY_LIST_ROUTE_TIMEOUT_SECONDS = 35.0
TRANSFER_RECEIPT_TTL_SECONDS = 5 * 60
TRANSFER_OPERATION_TTL = timedelta(seconds=TRANSFER_RECEIPT_TTL_SECONDS)
TRANSFER_OPERATION_PROGRESS_PERSIST_INTERVAL_BYTES = 1024 * 1024
TRANSFER_UNAVAILABLE_DETAIL = "Transfers are unavailable in this release"
DOWNLOAD_SESSION_TTL_SECONDS = 90
MAX_COMPANION_DOWNLOAD_SESSIONS = 1024
EDIT_LOCK_LOST_CODE: Literal["edit_lock_lost"] = "edit_lock_lost"
EDIT_LOCK_LOST_MESSAGE = "Lock not found or expired"


class TransferOperationCancelled(RuntimeError):
    """Raised when a durable transfer observes a cooperative cancellation request."""


@dataclass(frozen=True)
class _TransferReceipt:
    """A replayable transfer response owned by one authenticated user and key."""

    expires_at: float
    fingerprint: str
    result: ContentTransferResult | None = None
    error_status: int | None = None
    error_detail: object | None = None


@dataclass(frozen=True)
class _InFlightTransferOutcome:
    """The completion value shared by concurrent requests with one idempotency key."""

    result: ContentTransferResult | None = None
    error_status: int | None = None
    error_detail: object | None = None


_transfer_receipts: dict[tuple[str, str], _TransferReceipt] = {}
_transfer_in_flight: dict[tuple[str, str], tuple[str, asyncio.Future[_InFlightTransferOutcome]]] = {}
_transfer_receipt_lock = asyncio.Lock()
_transfer_cancellations: dict[tuple[str, str], asyncio.Event] = {}
_transfer_cancellation_lock = asyncio.Lock()
_download_sessions: dict[str, tuple[float, str, str, int]] = {}
_download_session_lock = asyncio.Lock()


class CompanionDownloadSessionRequest(BaseModel):
    drive: str


class CompanionDownloadSessionResponse(BaseModel):
    token: str


class CompanionDownloadSessionLimit(BaseModel):
    size_limit_bytes: int


@router.post("/companion-download/session", response_model=CompanionDownloadSessionResponse)
async def issue_companion_download_session(
    body: CompanionDownloadSessionRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
) -> CompanionDownloadSessionResponse:
    """Issue a short-lived, single-use capability scoped to a local drive."""
    if not body.drive or len(body.drive) > 128:
        raise HTTPException(status_code=400, detail="Invalid local drive")
    token = secrets.token_urlsafe(32)
    size_limit = get_integer_setting_value(SystemSettingKey.TEMPORARY_ARCHIVE_DOWNLOAD_SIZE_BYTES)
    async with _download_session_lock:
        now = monotonic()
        _download_sessions.update({key: session for key, session in _download_sessions.items() if session[0] > now})
        if len(_download_sessions) >= MAX_COMPANION_DOWNLOAD_SESSIONS:
            raise HTTPException(status_code=429, detail="Too many active download sessions")
        _download_sessions[token] = (now + DOWNLOAD_SESSION_TTL_SECONDS, current_user.username, body.drive, size_limit)
    return CompanionDownloadSessionResponse(token=token)


@router.post("/companion-download/session/{token}/consume", response_model=CompanionDownloadSessionLimit)
async def consume_companion_download_session(
    token: str,
    body: CompanionDownloadSessionRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
) -> CompanionDownloadSessionLimit:
    """Return the configured cap once to the authenticated Companion session."""
    async with _download_session_lock:
        session = _download_sessions.get(token)
        if session is None or session[0] <= monotonic() or session[1:3] != (current_user.username, body.drive):
            raise HTTPException(status_code=403, detail="Download session expired or invalid")
        del _download_sessions[token]
    return CompanionDownloadSessionLimit(size_limit_bytes=session[3])


def _transfer_fingerprint(body: CopyMoveRequest) -> str:
    """Build a stable request fingerprint for idempotency-key reuse checks."""

    return json.dumps(
        body.model_dump(exclude={"idempotency_key", "transfer_attempt_id"}),
        sort_keys=True,
        default=str,
        separators=(",", ":"),
    )


async def _register_transfer_cancellation(current_user: User, body: CopyMoveRequest) -> asyncio.Event | None:
    if body.transfer_attempt_id is None:
        return None
    key = (current_user.username, str(body.transfer_attempt_id))
    async with _transfer_cancellation_lock:
        cancellation = _transfer_cancellations.get(key)
        if cancellation is None:
            cancellation = asyncio.Event()
            _transfer_cancellations[key] = cancellation
        return cancellation


async def _unregister_transfer_cancellation(current_user: User, body: CopyMoveRequest, cancellation: asyncio.Event | None) -> None:
    if body.transfer_attempt_id is None or cancellation is None:
        return
    key = (current_user.username, str(body.transfer_attempt_id))
    async with _transfer_cancellation_lock:
        if _transfer_cancellations.get(key) is cancellation:
            del _transfer_cancellations[key]


async def _find_transfer_receipt(current_user: User, body: CopyMoveRequest) -> ContentTransferResult | None:
    """Return a receipt or wait for the request that owns its idempotency key."""

    import time

    key = (current_user.username, body.idempotency_key)
    fingerprint = _transfer_fingerprint(body)
    in_flight: asyncio.Future[_InFlightTransferOutcome] | None = None
    async with _transfer_receipt_lock:
        now = time.monotonic()
        expired = [receipt_key for receipt_key, receipt in _transfer_receipts.items() if receipt.expires_at <= now]
        for receipt_key in expired:
            del _transfer_receipts[receipt_key]
        receipt = _transfer_receipts.get(key)
        if receipt is None:
            active = _transfer_in_flight.get(key)
            if active is None:
                _transfer_in_flight[key] = (fingerprint, asyncio.get_running_loop().create_future())
                return None
            existing_fingerprint, in_flight = active
        else:
            if receipt.fingerprint != fingerprint:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Idempotency key conflicts with its transfer request")
            if receipt.result is not None:
                return receipt.result.model_copy(deep=True)
            if receipt.error_status is not None:
                raise HTTPException(status_code=receipt.error_status, detail=receipt.error_detail)
            raise RuntimeError("Transfer receipt has no replayable outcome")

        if existing_fingerprint != fingerprint:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Idempotency key conflicts with its transfer request")

    outcome = await asyncio.shield(in_flight)
    if outcome.result is not None:
        return outcome.result.model_copy(deep=True)
    if outcome.error_status is not None:
        raise HTTPException(status_code=outcome.error_status, detail=outcome.error_detail)
    raise RuntimeError("In-flight transfer completed without a replayable outcome")


async def _record_transfer_receipt(current_user: User, body: CopyMoveRequest, result: ContentTransferResult) -> ContentTransferResult:
    """Retain one terminal factual result for a bounded retry window."""

    import time

    async with _transfer_receipt_lock:
        key = (current_user.username, body.idempotency_key)
        _transfer_receipts[key] = _TransferReceipt(
            expires_at=time.monotonic() + TRANSFER_RECEIPT_TTL_SECONDS,
            fingerprint=_transfer_fingerprint(body),
            result=result.model_copy(deep=True),
        )
        active = _transfer_in_flight.pop(key, None)
        if active is not None and not active[1].done():
            active[1].set_result(_InFlightTransferOutcome(result=result.model_copy(deep=True)))
    return result


async def _record_transfer_http_error(current_user: User, body: CopyMoveRequest, error: HTTPException) -> None:
    """Retain a known HTTP outcome and release waiters without changing its status."""

    import time

    key = (current_user.username, body.idempotency_key)
    async with _transfer_receipt_lock:
        active = _transfer_in_flight.pop(key, None)
        if active is None:
            return
        fingerprint, future = active
        _transfer_receipts[key] = _TransferReceipt(
            expires_at=time.monotonic() + TRANSFER_RECEIPT_TTL_SECONDS,
            fingerprint=fingerprint,
            error_status=error.status_code,
            error_detail=error.detail,
        )
        if not future.done():
            future.set_result(_InFlightTransferOutcome(error_status=error.status_code, error_detail=error.detail))


async def _record_unknown_transfer_outcome(current_user: User, body: CopyMoveRequest) -> None:
    """Release an unrecorded reservation without allowing a second mutation."""

    import time

    key = (current_user.username, body.idempotency_key)
    unknown_result = ContentTransferResult(
        status="outcome_unknown",
        effects=ContentTransferEffects(source="unknown", destination="unknown"),
    )
    async with _transfer_receipt_lock:
        active = _transfer_in_flight.pop(key, None)
        if active is None:
            return
        fingerprint, future = active
        _transfer_receipts[key] = _TransferReceipt(
            expires_at=time.monotonic() + TRANSFER_RECEIPT_TTL_SECONDS,
            fingerprint=fingerprint,
            result=unknown_result,
        )
        if not future.done():
            future.set_result(_InFlightTransferOutcome(result=unknown_result.model_copy(deep=True)))


async def _raise_recorded_transfer_http_error(
    current_user: User,
    body: CopyMoveRequest,
    *,
    status_code: int,
    detail: object,
) -> NoReturn:
    """Record a factual HTTP failure, then preserve its response for the owner."""

    error = HTTPException(status_code=status_code, detail=detail)
    await _record_transfer_http_error(current_user, body, error)
    raise error


async def _verify_remote_recent_history_target(
    *,
    connection_id: str,
    path: str,
    expected_type: FileType,
    target_label: str,
    history_label: str,
    current_user: User,
    session: Session,
) -> None:
    """Verify that a remote history target still exists with the required type."""

    if connection_id.startswith(LOCAL_DRIVE_PREFIX):
        return

    normalized_path = normalize_recent_history_path(path)
    connection = get_accessible_connection_or_404(session, current_user, uuid.UUID(connection_id))
    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    try:
        await backend.connect()
        target_info = await backend.get_file_info(normalized_path)
    finally:
        await disconnect_backend_safely(
            backend,
            logger=logger,
            context=f"recent-{history_label} record validation: connection_id={connection_id}, path='{path}'",
        )

    if target_info.type != expected_type:
        raise ValueError(f"Only {target_label} can be recorded in recent-{history_label} history")


@router.post("/recent-directories", response_model=RecentDirectoryRead | None)
async def create_recent_directory(
    payload: RecentDirectoryRecordRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> RecentDirectoryRead | None:
    """Record a directory only after the client successfully navigated to it."""

    set_user(current_user.username)
    try:
        await _verify_remote_recent_history_target(
            connection_id=payload.connection_id,
            path=payload.path,
            expected_type=FileType.DIRECTORY,
            target_label="directories",
            history_label="directory",
            current_user=current_user,
            session=session,
        )

        return record_recent_directory(
            connection_id=payload.connection_id,
            path=payload.path,
            current_user=current_user,
            session=session,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="The directory no longer exists") from exc
    except TimeoutError as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="The directory could not be verified because the connection timed out",
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(
            "Recent-directory record validation failed: connection_id=%s path=%s",
            payload.connection_id,
            payload.path,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The directory could not be verified because the connection is unavailable",
        ) from exc


@router.get("/recent-directories", response_model=RecentDirectorySearchRead)
async def get_recent_directories(
    q: str = Query("", max_length=1024),
    limit: int = Query(10, ge=1, le=MAX_RECENT_DIRECTORY_RESULTS),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> RecentDirectorySearchRead:
    set_user(current_user.username)
    try:
        results = search_recent_directories(query=q, limit=limit, current_user=current_user, session=session)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return RecentDirectorySearchRead(
        results=results,
        result_limit=get_recent_file_result_limit(limit=limit, session=session),
    )


@router.delete("/recent-directories/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recent_directory(
    record_id: uuid.UUID,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> None:
    set_user(current_user.username)
    remove_recent_directory(record_id=record_id, current_user=current_user, session=session)


@router.delete("/recent-directories", response_model=RecentDirectoryClearRead)
async def delete_all_recent_directories(
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> RecentDirectoryClearRead:
    set_user(current_user.username)
    return RecentDirectoryClearRead(deleted_count=clear_recent_directories(current_user=current_user, session=session))


@router.post("/recent-files", response_model=RecentFileRead | None)
async def create_recent_file(
    payload: RecentFileRecordRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> RecentFileRead | None:
    set_user(current_user.username)
    try:
        should_record = should_record_recent_file(
            connection_id=payload.connection_id,
            path=payload.path,
            is_regular_file=payload.is_regular_file,
            current_user=current_user,
            session=session,
        )
        if not should_record:
            return None

        await _verify_remote_recent_history_target(
            connection_id=payload.connection_id,
            path=payload.path,
            expected_type=FileType.FILE,
            target_label="regular files",
            history_label="file",
            current_user=current_user,
            session=session,
        )

        return record_recent_file(
            connection_id=payload.connection_id,
            path=payload.path,
            is_regular_file=payload.is_regular_file,
            current_user=current_user,
            session=session,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="The file no longer exists") from exc
    except TimeoutError as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="The file could not be verified because the connection timed out"
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(
            "Recent-file record validation failed: connection_id=%s path=%s",
            payload.connection_id,
            payload.path,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="The file could not be verified because the connection is unavailable"
        ) from exc


@router.get("/recent-files", response_model=RecentFileSearchRead)
async def get_recent_files(
    q: str = Query("", max_length=1024),
    limit: int = Query(10, ge=1, le=50),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> RecentFileSearchRead:
    set_user(current_user.username)
    result_limit = get_recent_file_result_limit(limit=limit, session=session)
    try:
        results = search_recent_files(query=q, limit=result_limit, current_user=current_user, session=session)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return RecentFileSearchRead(
        results=results,
        result_limit=result_limit,
    )


@router.delete("/recent-files/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_recent_file(
    record_id: uuid.UUID,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> None:
    set_user(current_user.username)
    remove_recent_file(record_id=record_id, current_user=current_user, session=session)


def _raise_recent_target_error(
    *,
    status_code: int,
    code: RecentFileValidationCode,
    message: str,
    record: RecentFile | None = None,
    session: Session,
) -> NoReturn:
    if record is not None and code in {
        "recent_file_target_missing",
        "recent_file_target_not_file",
        "recent_file_invalid_path",
        "recent_file_connection_removed",
    }:
        session.delete(record)
        session.commit()
    raise HTTPException(status_code=status_code, detail={"code": code, "message": message})


@router.get(
    "/recent-files/{record_id}/target",
    response_model=FileInfo,
    responses={
        400: {"model": RecentFileValidationError},
        403: {"model": RecentFileValidationError},
        404: {"model": RecentFileValidationError},
        409: {"model": RecentFileValidationError},
        503: {"model": RecentFileValidationError},
        504: {"model": RecentFileValidationError},
    },
)
async def validate_recent_file_target(
    record_id: uuid.UUID,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> FileInfo:
    """Authoritatively validate a remote recent target before opening it."""

    set_user(current_user.username)
    record = get_recent_file(record_id=record_id, current_user=current_user, session=session)
    if record.connection_id.startswith("local-drive:"):
        _raise_recent_target_error(
            status_code=status.HTTP_409_CONFLICT,
            code="recent_file_validation_transient",
            message="Local-drive targets must be validated by Companion.",
            session=session,
        )

    try:
        connection_id = uuid.UUID(record.connection_id)
    except ValueError:
        _raise_recent_target_error(
            status_code=status.HTTP_400_BAD_REQUEST,
            code="recent_file_invalid_path",
            message="The recent-file connection ID is invalid.",
            record=record,
            session=session,
        )

    connection = session.get(Connection, connection_id)
    if connection is None:
        _raise_recent_target_error(
            status_code=status.HTTP_404_NOT_FOUND,
            code="recent_file_connection_removed",
            message="The connection for this recent file no longer exists.",
            record=record,
            session=session,
        )

    try:
        get_accessible_connection_or_404(session, current_user, connection_id)
    except HTTPException:
        _raise_recent_target_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code="recent_file_access_denied",
            message="You no longer have access to this recent file's connection.",
            record=record,
            session=session,
        )

    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    try:
        await backend.connect()
        try:
            file_info = await backend.get_file_info(record.path)
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"recent-file validation: connection_id={record.connection_id}, path='{record.path}'",
            )
    except FileNotFoundError:
        _raise_recent_target_error(
            status_code=status.HTTP_404_NOT_FOUND,
            code="recent_file_target_missing",
            message="The recent file no longer exists.",
            record=record,
            session=session,
        )
    except PermissionError:
        _raise_recent_target_error(
            status_code=status.HTTP_403_FORBIDDEN,
            code="recent_file_access_denied",
            message="Access to this recent file was denied. Check your permissions and retry.",
            session=session,
        )
    except TimeoutError:
        _raise_recent_target_error(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            code="recent_file_validation_transient",
            message="The recent file could not be validated because the connection timed out.",
            session=session,
        )
    except Exception:
        logger.warning(
            "Recent-file target validation failed: connection_id=%s path=%s",
            record.connection_id,
            record.path,
            exc_info=True,
        )
        _raise_recent_target_error(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            code="recent_file_validation_transient",
            message="The recent file could not be validated because the connection is unavailable.",
            session=session,
        )

    if file_info.type != FileType.FILE:
        _raise_recent_target_error(
            status_code=status.HTTP_409_CONFLICT,
            code="recent_file_target_not_file",
            message="The recent target is no longer a regular file.",
            record=record,
            session=session,
        )
    return file_info


@router.delete("/recent-files", response_model=RecentFileClearRead)
async def delete_all_recent_files(
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> RecentFileClearRead:
    set_user(current_user.username)
    return RecentFileClearRead(deleted_count=clear_recent_files(current_user=current_user, session=session))


def _get_active_lock(connection_id: uuid.UUID, path: str, session: Session) -> EditLock | None:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)
    statement = (
        select(EditLock)
        .where(EditLock.connection_id == connection_id)
        .where(EditLock.file_path == path)
        .where(EditLock.last_heartbeat >= cutoff)
    )
    return session.exec(statement).first()


@router.get("/{connection_id}/archive/list", response_model=ArchiveDirectoryListing)
async def list_archive_directory(
    connection_id: uuid.UUID,
    archive_path: str = Query(..., min_length=1, description="Path to the ZIP archive within the share"),
    virtual_path: str = Query("", description="Virtual directory path within the archive"),
    cursor: str | None = Query(None, description="Opaque archive listing cursor"),
    page_size: int = Query(100, ge=1, le=500, description="Maximum virtual entries to return"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> ArchiveDirectoryListing:
    """Return one projected page from a virtual ZIP directory."""

    set_user(current_user.username)
    connection = _get_connection_or_404(session, current_user, connection_id)
    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    reader = None
    try:
        await backend.connect()
        archive_info = await backend.get_file_info(archive_path)
        if archive_info.type != FileType.FILE or archive_info.size is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Archive path must identify a regular file")
        reader = await backend.open_random_access_reader(archive_path)
        topology = resolve_archive_inspection_topology_plan(source_connection_id=str(connection_id))
        if topology.source_is_local:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Archive inspection requires the Companion coordinator"
            )
        zip_reader = ZipReader(reader, archive_info.size)
        directory_page = await zip_reader.list_directory(virtual_path, cursor, page_size)
        return ArchiveDirectoryListing(
            archive=ArchiveIdentity(path=archive_path, size=archive_info.size, modified_at=archive_info.modified_at),
            path=directory_page.path,
            items=[
                ArchiveEntryInfo(
                    name=entry.path.rsplit("/", 1)[-1],
                    path=entry.path,
                    type=FileType.DIRECTORY if entry.is_directory else FileType.FILE,
                    size=None if entry.is_directory else entry.uncompressed_size,
                    compressed_size=None if entry.is_directory else entry.compressed_size,
                    compression_method=None if entry.is_directory else entry.compression_method,
                    crc32=None if entry.is_directory else entry.crc32,
                    modified_at=entry.modified_at,
                    state=(
                        "readable"
                        if entry.is_directory
                        else "blocked"
                        if entry.encrypted
                        else "readable"
                        if entry.compression_method in {0, 8, 12}
                        else "unavailable"
                    ),
                    is_hidden=entry.path.rsplit("/", 1)[-1].startswith("."),
                )
                for entry in directory_page.entries
            ],
            next_cursor=directory_page.next_cursor,
            page_size=page_size,
        )
    except ArchiveFormatError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail={"code": "invalid_zip", "message": str(exc)}) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Archive file was not found") from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Archive read timed out") from exc
    finally:
        if reader is not None:
            await reader.close()
        await disconnect_backend_safely(
            backend,
            logger=logger,
            context=f"archive listing request: connection_id={connection_id}, archive_path={archive_path!r}",
        )


def _temporary_archive_response(artifact: Path) -> StreamingResponse:
    async def stream_artifact() -> AsyncIterator[bytes]:
        try:
            with artifact.open("rb") as handle:
                while chunk := await asyncio.to_thread(handle.read, 256 * 1024):
                    yield chunk
        finally:
            artifact.unlink(missing_ok=True)

    return StreamingResponse(
        stream_artifact(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{DOWNLOAD_FILENAME}"'},
    )


class ZipSelectionDownloadRequest(BaseModel):
    archive_path: str
    paths: list[str]


@router.post("/{connection_id}/archive/download-selection")
async def download_zip_selection_archive(
    connection_id: uuid.UUID,
    body: ZipSelectionDownloadRequest,
    request: Request,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Repackage selected safe ZIP members through the portable creator."""
    connection = _get_connection_or_404(session, current_user, connection_id)
    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    reader = None
    artifact = None
    try:
        await backend.connect()
        archive_info = await backend.get_file_info(body.archive_path)
        if archive_info.type != FileType.FILE or archive_info.size is None:
            raise ArchiveFormatError("Archive source must be a regular file")
        reader = await backend.open_random_access_reader(body.archive_path)
        source = ZipArchiveCreationSource(ZipReader(reader, archive_info.size))
        await source.validate_projection()
        artifact = await create_temporary_download(
            source, body.paths, get_integer_setting_value(SystemSettingKey.TEMPORARY_ARCHIVE_DOWNLOAD_SIZE_BYTES), request.is_disconnected
        )
        if await request.is_disconnected():
            raise asyncio.CancelledError()
    except (ArchiveFormatError, FileNotFoundError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TemporaryArchiveSizeLimitExceeded as exc:
        raise HTTPException(status_code=413, detail="temporary_archive_size_limit_exceeded") from exc
    except BaseException:
        if artifact is not None:
            artifact.unlink(missing_ok=True)
        raise
    finally:
        if reader is not None:
            await reader.close()
        await disconnect_backend_safely(backend, logger=logger, context=f"ZIP selection download {connection_id}")
    assert artifact is not None
    return _temporary_archive_response(artifact)


@router.post("/{connection_id}/download-selection")
async def download_selection_archive(
    connection_id: uuid.UUID,
    paths: list[str],
    request: Request,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Build a complete selected-root ZIP in private storage before streaming it."""
    connection = _get_connection_or_404(session, current_user, connection_id)
    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    artifact = None
    try:
        await backend.connect()
        artifact = await create_temporary_download(
            backend, paths, get_integer_setting_value(SystemSettingKey.TEMPORARY_ARCHIVE_DOWNLOAD_SIZE_BYTES), request.is_disconnected
        )
        if await request.is_disconnected():
            raise asyncio.CancelledError()
    except (ArchiveFormatError, FileNotFoundError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TemporaryArchiveSizeLimitExceeded as exc:
        raise HTTPException(status_code=413, detail="temporary_archive_size_limit_exceeded") from exc
    except BaseException:
        if artifact is not None:
            artifact.unlink(missing_ok=True)
        raise
    finally:
        await disconnect_backend_safely(backend, logger=logger, context=f"selection download {connection_id}")

    assert artifact is not None

    return _temporary_archive_response(artifact)


#
# list_directory
#
@router.get("/{connection_id}/list", response_model=DirectoryListing)
async def list_directory(
    connection_id: uuid.UUID,
    path: Optional[str] = Query("", description="Path within the share"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> DirectoryListing:
    """List contents of a directory"""

    # Set user context for logging
    set_user(current_user.username)

    connection = _get_connection_or_404(session, current_user, connection_id)

    try:
        backend = build_smb_backend(connection, backend_factory=SMBBackend)

        await backend.connect()
        try:
            listing = await asyncio.wait_for(backend.list_directory(path or ""), timeout=DIRECTORY_LIST_ROUTE_TIMEOUT_SECONDS)
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"list request: connection_id={connection_id}, path='{path}'",
            )

        # Feed discovered directories into the directory cache (if active)
        _update_directory_cache_from_listing(str(connection_id), listing)

        logger.debug(f"Successfully listed directory: connection_id={connection_id}, path='{path}', items={len(listing.items)}")
        return listing

    except FileNotFoundError as error:
        _remove_from_directory_cache(str(connection_id), path or "")
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "directory_not_found", "message": "The folder was not found. It may have been moved or deleted."},
        ) from error
    except NotADirectoryError as error:
        _remove_from_directory_cache(str(connection_id), path or "")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "not_a_directory", "message": "This item is not a folder."},
        ) from error
    except PermissionError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "directory_access_denied", "message": "You do not have permission to open this folder."},
        ) from error
    except asyncio.TimeoutError:
        logger.error(
            f"Timed out listing directory: connection_id={connection_id}, path='{path}', host={connection.host}, share={connection.share_name}"
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Directory listing timed out. The remote share did not respond in time.",
        )
    except Exception as e:
        logger.error(
            f"Failed to list directory: connection_id={connection_id}, path='{path}', "
            f"host={connection.host}, share={connection.share_name}, "
            f"error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "directory_unavailable", "message": "The folder could not be opened. Check the connection and try again."},
        )


#
# get_file_info
#
@router.get("/{connection_id}/info", response_model=FileInfo)
async def get_file_info(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to the file or directory"),
    operation_id: Optional[str] = Query(None, description="Active companion operation ID"),
    lock_id: Optional[str] = Query(None, description="Active companion lock ID"),
    lock_capability: Optional[str] = Query(None, description="Active companion lock capability"),
    token: Optional[str] = Depends(oauth2_scheme_optional),
    session: Session = Depends(get_session),
) -> FileInfo:
    """Get information about a specific file or directory"""

    if operation_id or lock_id or lock_capability:
        if not operation_id or not lock_id or not lock_capability or not token:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing companion operation context",
            )

        current_user = _get_current_companion_operation_user(
            token,
            connection_id=connection_id,
            path=path,
            operation_id=operation_id,
            lock_id=lock_id,
            session=session,
        )

        lock = _get_active_lock(connection_id, path, session)
        if not lock:
            _raise_companion_operation_error(
                status_code=status.HTTP_404_NOT_FOUND,
                code=COMPANION_ERROR_LOCK_LOST,
                message="The edit lock is no longer active for this file. Reopen the file from Sambee and try again.",
            )

        _validate_operation_lock_scope(
            lock,
            operation_id=operation_id,
            lock_id=lock_id,
            lock_capability=lock_capability,
        )
    else:
        current_user = await get_current_user_for_token(token, session)

    # Set user context for logging
    set_user(current_user.username)

    logger.debug(f"Getting file info: connection_id={connection_id}, path='{path}'")

    connection = _get_connection_or_404(session, current_user, connection_id)

    try:
        backend = build_smb_backend(connection, backend_factory=SMBBackend)

        await backend.connect()
        try:
            file_info = await backend.get_file_info(path)
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"file info request: connection_id={connection_id}, path='{path}'",
            )

        logger.debug(f"Successfully retrieved file info: connection_id={connection_id}, path='{path}', type={file_info.type}")
        return file_info

    except (FileNotFoundError, PermissionError, NotADirectoryError, TimeoutError) as error:
        raise file_target_http_error(error, requires_file=False) from error
    except Exception as e:
        logger.error(
            f"Failed to get file info: connection_id={connection_id}, path='{path}', "
            f"host={connection.host}, share={connection.share_name}, "
            f"error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise file_target_http_error(e, requires_file=False) from e


#
# search_directories
#
@router.get("/{connection_id}/directories", response_model=DirectorySearchResult)
async def search_directories(
    connection_id: uuid.UUID,
    q: str = Query("", description="Search query for directory names"),
    include_dot_directories: bool = Query(False, description="Whether to include directories whose path contains dot-prefixed segments"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> DirectorySearchResult:
    """Search for directories across the entire connection.

    Returns matching directory paths from the in-memory cache.
    If the cache is not yet built, triggers an initial scan and returns
    partial results. The cache_state field indicates indexing status.
    """

    # Set user context for logging
    set_user(current_user.username)

    connection = _get_connection_or_404(session, current_user, connection_id)

    try:
        from app.services.directory_cache import get_directory_cache_manager

        cache_manager = get_directory_cache_manager()
        cache = await cache_manager.get_or_create_cache(
            connection_id=str(connection_id),
            host=connection.host,
            share_name=require_share_name(connection),
            username=connection.username,
            password=decrypt_password(connection.password_encrypted),
            port=connection.port or 445,
            path_prefix=connection.path_prefix or "/",
            source_revision=connection.updated_at.isoformat(),
        )

        results, total_matches = cache.search(q, include_dot_directories=include_dot_directories) if q else ([], 0)
        normalized_query = normalize_history_search_text(q.replace("\\", "/").strip())

        return DirectorySearchResult(
            results=results,
            match_ranks={path: directory_match_rank(path, normalized_query) for path in results},
            total_matches=total_matches,
            cache_state=cache.state.value,
            directory_count=cache.directory_count,
        )

    except Exception as e:
        logger.error(
            f"Failed to search directories: connection_id={connection_id}, query='{q}', include_dot_directories={include_dot_directories}, error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to search directories: {str(e)}",
        )


# ============================================================================
# Upload file
# ============================================================================


class UploadResponse(BaseModel):
    """Response for successful file upload."""

    status: str
    path: str
    size: int
    last_modified: str | None


class BrowserEditLockResponse(BaseModel):
    """Response for browser-authenticated edit lock operations."""

    lock_id: str
    lock_capability: str
    operation_id: str
    file_path: str
    locked_by: str
    locked_at: str


class BrowserEditLockControlRequest(BaseModel):
    """Request body for browser-authenticated lock heartbeat and release."""

    operation_id: str
    lock_id: str
    lock_capability: str


class BrowserEditLockStatusResponse(BaseModel):
    """Response for browser-authenticated edit lock status queries."""

    locked: bool
    locked_by: str | None = None
    locked_at: str | None = None


class BrowserEditLockErrorDetail(BaseModel):
    """Stable error payload for browser edit-lock lifecycle failures."""

    code: Literal["edit_lock_lost"]
    message: str


def _raise_browser_edit_lock_lost() -> NoReturn:
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=BrowserEditLockErrorDetail(code=EDIT_LOCK_LOST_CODE, message=EDIT_LOCK_LOST_MESSAGE).model_dump(),
    )


def _validate_browser_lock_control(lock: EditLock, body: BrowserEditLockControlRequest) -> None:
    """Require a browser edit-lock control request to match the active lock."""

    if lock.operation_id != body.operation_id or lock.lock_capability != body.lock_capability:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Edit lock context mismatch",
        )

    if str(lock.id) != body.lock_id:
        _raise_browser_edit_lock_lost()


@router.post("/{connection_id}/lock", response_model=BrowserEditLockResponse)
async def acquire_browser_edit_lock(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to the file to lock"),
    check_write_access: bool = Query(False, description="Verify existing-file write permission before acquiring a lock"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> BrowserEditLockResponse:
    """Acquire an exclusive edit lock for in-browser markdown editing."""

    set_user(current_user.username)

    connection = _get_connection_or_404(session, current_user, connection_id)
    require_connection_write_access(current_user, connection, action="acquire_browser_lock", path=path)

    if check_write_access:
        backend = build_smb_backend(connection, backend_factory=SMBBackend)
        try:
            await backend.connect()
            await backend.check_write_access(path)
        except (FileNotFoundError, PermissionError, NotADirectoryError, IsADirectoryError, TimeoutError) as error:
            raise file_target_http_error(error) from error
        except Exception as error:
            logger.exception("Failed to check file write access: connection_id=%s, path=%s", connection_id, path)
            raise file_target_http_error(error) from error
        finally:
            await disconnect_backend_safely(
                backend, logger=logger, context=f"write access check: connection_id={connection_id}, path='{path}'"
            )

    remove_expired_file_locks(session, connection_id, path)
    existing = _get_active_lock(connection_id, path, session)
    if existing:
        if existing.locked_by == current_user.username and (not existing.lock_capability or not existing.operation_id):
            session.delete(existing)
            session.commit()

            replacement_lock = EditLock(
                file_path=path,
                connection_id=connection_id,
                locked_by=current_user.username,
                operation_id=_generate_operation_id(),
                lock_capability=_generate_lock_capability(),
            )
            session.add(replacement_lock)
            session.commit()
            session.refresh(replacement_lock)

            return BrowserEditLockResponse(
                lock_id=str(replacement_lock.id),
                lock_capability=replacement_lock.lock_capability,
                operation_id=replacement_lock.operation_id,
                file_path=replacement_lock.file_path,
                locked_by=replacement_lock.locked_by,
                locked_at=replacement_lock.locked_at.isoformat(),
            )

        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"File is locked for editing by {existing.locked_by}",
        )

    lock = EditLock(
        file_path=path,
        connection_id=connection_id,
        locked_by=current_user.username,
        operation_id=_generate_operation_id(),
        lock_capability=_generate_lock_capability(),
    )
    session.add(lock)
    try:
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="File is already locked for editing") from error
    session.refresh(lock)

    return BrowserEditLockResponse(
        lock_id=str(lock.id),
        lock_capability=lock.lock_capability,
        operation_id=lock.operation_id,
        file_path=lock.file_path,
        locked_by=lock.locked_by,
        locked_at=lock.locked_at.isoformat(),
    )


@router.post("/{connection_id}/lock/heartbeat")
async def heartbeat_browser_edit_lock(
    connection_id: uuid.UUID,
    body: BrowserEditLockControlRequest,
    path: str = Query(..., description="Path to the locked file"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> dict[str, str]:
    """Refresh an active browser edit lock."""

    set_user(current_user.username)

    lock = _get_active_lock(connection_id, path, session)
    if not lock:
        _raise_browser_edit_lock_lost()

    _validate_browser_lock_control(lock, body)

    if lock.locked_by != current_user.username:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Lock is held by another user",
        )

    lock.last_heartbeat = datetime.now(timezone.utc)
    session.add(lock)
    session.commit()

    return {"status": "ok"}


@router.delete("/{connection_id}/lock")
async def release_browser_edit_lock(
    connection_id: uuid.UUID,
    body: BrowserEditLockControlRequest,
    path: str = Query(..., description="Path to the locked file"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> dict[str, str]:
    """Release an active browser edit lock."""

    set_user(current_user.username)

    lock = _get_active_lock(connection_id, path, session)
    if not lock:
        return {"status": "ok"}

    _validate_browser_lock_control(lock, body)

    if lock.locked_by != current_user.username:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Lock is held by another user",
        )

    session.delete(lock)
    session.commit()

    return {"status": "ok"}


@router.get("/{connection_id}/lock-status", response_model=BrowserEditLockStatusResponse)
async def get_browser_edit_lock_status(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to check"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> BrowserEditLockStatusResponse:
    """Return whether the file is actively locked for browser editing."""

    set_user(current_user.username)

    lock = _get_active_lock(connection_id, path, session)
    if not lock:
        return BrowserEditLockStatusResponse(locked=False)

    return BrowserEditLockStatusResponse(
        locked=True,
        locked_by=lock.locked_by,
        locked_at=lock.locked_at.isoformat(),
    )


#
# upload_file
#
@router.post("/{connection_id}/upload", response_model=UploadResponse)
async def upload_file(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Destination path on the share"),
    editor_operation_id: Optional[str] = Query(None, description="Active browser editor operation ID"),
    editor_lock_id: Optional[str] = Query(None, description="Active browser editor lock ID"),
    editor_lock_capability: Optional[str] = Query(None, description="Active browser editor lock capability"),
    operation_id: Optional[str] = Query(None, description="Active companion operation ID"),
    lock_id: Optional[str] = Query(None, description="Active companion lock ID"),
    lock_capability: Optional[str] = Query(None, description="Active companion lock capability"),
    file: UploadFile = File(...),
    token: Optional[str] = Depends(oauth2_scheme_optional),
    session: Session = Depends(get_session),
) -> UploadResponse:
    """Upload a file to the SMB share.

    Accepts a multipart file upload and writes it to the specified path,
    overwriting the existing file.  Used by both the companion app (writing
    back edited files) and the web UI (future upload feature).
    """

    if editor_operation_id or editor_lock_id or editor_lock_capability:
        if not editor_operation_id or not editor_lock_id or not editor_lock_capability:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing browser editor lock context")
        current_user = await get_current_user_for_token(token, session)
        lock = _get_active_lock(connection_id, path, session)
        if not lock:
            _raise_browser_edit_lock_lost()
        _validate_browser_lock_control(
            lock,
            BrowserEditLockControlRequest(
                operation_id=editor_operation_id,
                lock_id=editor_lock_id,
                lock_capability=editor_lock_capability,
            ),
        )
        if lock.locked_by != current_user.username:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Lock is held by another user")
    elif operation_id or lock_id or lock_capability:
        if not operation_id or not lock_id or not lock_capability or not token:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing companion operation context",
            )

        current_user = _get_current_companion_operation_user(
            token,
            connection_id=connection_id,
            path=path,
            operation_id=operation_id,
            lock_id=lock_id,
            session=session,
        )

        lock = _get_active_lock(connection_id, path, session)
        if not lock:
            _raise_companion_operation_error(
                status_code=status.HTTP_404_NOT_FOUND,
                code=COMPANION_ERROR_LOCK_LOST,
                message="The edit lock is no longer active for this file. Reopen the file from Sambee and try again.",
            )

        _validate_operation_lock_scope(
            lock,
            operation_id=operation_id,
            lock_id=lock_id,
            lock_capability=lock_capability,
        )
    else:
        current_user = await get_current_user_for_token(token, session)

    set_user(current_user.username)
    logger.info(f"Upload file: connection_id={connection_id}, path='{path}'")

    connection = _get_connection_or_404(session, current_user, connection_id)
    require_connection_write_access(current_user, connection, action="upload", path=path)

    try:
        backend = build_smb_backend(connection, backend_factory=SMBBackend)

        await backend.connect()
        try:
            if editor_operation_id:
                try:
                    bytes_written = await backend.write_file(path, file.file)
                except Exception as error:
                    raise file_target_http_error(error) from error
            else:
                bytes_written = await backend.write_file(path, file.file)

            last_modified = None
            try:
                updated_info = await backend.get_file_info(path)
                last_modified = updated_info.modified_at.isoformat() if updated_info.modified_at else None
            except Exception:
                logger.warning("Upload completed, but updated file metadata is unavailable", exc_info=True)
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"upload request: connection_id={connection_id}, path='{path}'",
            )

        logger.info(f"Upload complete: connection_id={connection_id}, path='{path}', size={bytes_written}")
        return UploadResponse(
            status="ok",
            path=path,
            size=bytes_written,
            last_modified=last_modified,
        )
    except HTTPException:
        raise
    except TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Upload timed out. The remote share did not respond in time.",
        )
    except IOError as e:
        logger.warning(f"Upload blocked (file locked): connection_id={connection_id}, path='{path}'")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        )
    except Exception as e:
        logger.error(
            f"Failed to upload file: connection_id={connection_id}, path='{path}', error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to upload file: {e}",
        )


def _parse_transfer_stream_source_modified_at(value: str | None) -> datetime | None:
    """Return a UTC RFC 3339 timestamp, treating malformed values as unavailable."""

    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        return None
    return parsed


@router.post("/{connection_id}/transfer-stream", response_model=ContentTransferResult)
async def stream_transfer_to_new_item(
    connection_id: uuid.UUID,
    request: Request,
    path: str = Query(..., description="New destination path on the share"),
    expected_size: int = Query(..., ge=0, description="Expected source byte count"),
    target_resolution_policy: TargetResolutionPolicy = Query(TargetResolutionPolicy.ASK),
    source_modified_at: str | None = Query(None, description="Observed RFC 3339 UTC source modification time"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> ContentTransferResult:
    """Publish a cross-provider regular file from a streamed request body.

    The endpoint has destination authority only. It stages the complete body
    privately and uses an exclusive final promotion, so an interrupted browser
    relay cannot expose partial output or replace an existing target.
    """

    target_path = _canonicalize_destination_path(path)
    if not target_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Destination path must not be empty")
    set_user(current_user.username)
    connection = _get_connection_or_404(session, current_user, connection_id)
    require_connection_write_access(current_user, connection, action="transfer_destination", path=target_path)
    parsed_source_modified_at = _parse_transfer_stream_source_modified_at(source_modified_at)

    received_size = 0

    async def request_stream() -> AsyncIterator[bytes]:
        nonlocal received_size
        async for chunk in request.stream():
            if chunk:
                received_size += len(chunk)
                if received_size > expected_size:
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                        detail=f"Transfer source size mismatch: expected {expected_size} bytes but received more",
                    )
                yield chunk

    class SkipDestinationCommit(Exception):
        """Stop staged publication when replace-older no longer authorizes it."""

    committed_replaced = False

    async def before_commit() -> bool:
        nonlocal committed_replaced
        if received_size != expected_size:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"Transfer source size mismatch: expected {expected_size} bytes but received {received_size} bytes",
            )
        try:
            current_target = await backend.get_file_info(target_path)
        except FileNotFoundError:
            current_target = None
        disposition = resolve_target_mutation(
            target_resolution_policy,
            parsed_source_modified_at,
            TargetSnapshot.missing() if current_target is None else TargetSnapshot.from_file_info(current_target),
        )
        if disposition == TargetResolutionDisposition.SKIP:
            raise SkipDestinationCommit()
        if disposition == TargetResolutionDisposition.AWAIT_COLLISION:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Destination already exists: {target_path}")
        committed_replaced = disposition == TargetResolutionDisposition.REPLACE_EXISTING
        return committed_replaced

    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    try:
        await backend.connect()
        try:
            try:
                existing_target = await backend.get_file_info(target_path)
            except FileNotFoundError:
                existing_target = None
            disposition = resolve_target_mutation(
                target_resolution_policy,
                parsed_source_modified_at,
                TargetSnapshot.missing() if existing_target is None else TargetSnapshot.from_file_info(existing_target),
            )
            if disposition == TargetResolutionDisposition.SKIP:
                return ContentTransferResult(
                    status="skipped",
                    effects=ContentTransferEffects(source="unchanged", destination="unchanged"),
                )
            if disposition == TargetResolutionDisposition.AWAIT_COLLISION:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Destination already exists: {target_path}")
            bytes_written = await backend.stage_and_commit_new_file_from_stream(
                target_path,
                request_stream(),
                before_commit=before_commit,
                source_mtime=parsed_source_modified_at,
                overwrite=disposition == TargetResolutionDisposition.REPLACE_EXISTING,
            )
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"cross-provider destination stream: connection_id={connection_id}, path='{target_path}'",
            )
        _add_to_directory_cache(str(connection_id), target_path)
        logger.info(
            "Published cross-provider transfer destination: connection_id=%s, path='%s', bytes=%s, user=%s",
            connection_id,
            target_path,
            bytes_written,
            current_user.username,
        )
        return ContentTransferResult(
            status="completed",
            effects=ContentTransferEffects(source="unchanged", destination="mutated"),
            replaced=committed_replaced,
        )
    except SkipDestinationCommit:
        return ContentTransferResult(
            status="skipped",
            effects=ContentTransferEffects(source="unchanged", destination="unchanged"),
        )
    except FileExistsError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Destination already exists: {target_path}") from None
    except TimeoutError as error:
        raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Transfer destination timed out") from error
    except OSError as error:
        logger.error("Failed to publish cross-provider destination '%s': %s", target_path, error, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Transfer destination failed: {error}") from error


def _transfer_operation_fingerprint(body: TransferOperationCreate, destination_connection_id: uuid.UUID) -> str:
    """Return the immutable plan fingerprint used for idempotent operation creation."""

    return json.dumps(
        {**body.model_dump(exclude={"idempotency_key"}), "destination_connection_id": str(destination_connection_id)},
        sort_keys=True,
        separators=(",", ":"),
    )


def _transfer_operation_read(operation: TransferOperation) -> TransferOperationRead:
    """Project the durable operation without exposing its internal request fingerprint."""

    return TransferOperationRead.model_validate(operation)


def _transfer_operation_result(operation: TransferOperation) -> ContentTransferResult | None:
    """Decode a previously persisted factual result, failing closed on corrupt state."""

    return _transfer_operation_read(operation).result


def _record_transfer_operation_result(
    session: Session,
    operation: TransferOperation,
    result: ContentTransferResult,
) -> TransferOperation:
    """Persist one terminal result before returning it to a retried caller."""

    if result.status in {"completed", "skipped", "completed_with_source_retained"}:
        operation.phase = TransferOperationPhase.COMPLETED
    elif result.status == "cancelled":
        operation.phase = TransferOperationPhase.CANCELLED
    else:
        operation.phase = TransferOperationPhase.FAILED
    operation.bytes_transferred = operation.source_size if result.effects.destination == "mutated" else 0
    operation.result_json = result.model_dump_json()
    operation.updated_at = datetime.now(timezone.utc)
    session.add(operation)
    session.commit()
    session.refresh(operation)
    return operation


def _record_transfer_operation_progress(session: Session, operation: TransferOperation, bytes_transferred: int) -> None:
    """Persist monotonic copy progress for reload recovery without changing commit state."""

    if bytes_transferred <= operation.bytes_transferred:
        return
    operation.bytes_transferred = bytes_transferred
    operation.updated_at = datetime.now(timezone.utc)
    session.add(operation)
    session.commit()


def _repair_corrupt_terminal_transfer_operation(session: Session, operation: TransferOperation) -> TransferOperation:
    """Replace an unreadable terminal receipt with a conservative recovery outcome."""

    if (
        operation.phase
        not in {
            TransferOperationPhase.COMPLETED,
            TransferOperationPhase.FAILED,
            TransferOperationPhase.CANCELLED,
        }
        or _transfer_operation_result(operation) is not None
    ):
        return operation
    logger.error("Repairing corrupt terminal transfer receipt: operation_id=%s", operation.id)
    return _record_transfer_operation_result(
        session,
        operation,
        ContentTransferResult(
            status="outcome_unknown",
            effects=ContentTransferEffects(source="unknown", destination="unknown"),
        ),
    )


def _transfer_operation_is_expired(operation: TransferOperation) -> bool:
    """Compare SQLite's potentially naive timestamps safely against UTC now."""

    expires_at = operation.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= datetime.now(timezone.utc)


def _expire_transfer_operation(session: Session, operation: TransferOperation) -> TransferOperation:
    """Expire an uncompleted operation without claiming its destination is unchanged."""

    if operation.phase in {TransferOperationPhase.COMPLETED, TransferOperationPhase.FAILED, TransferOperationPhase.CANCELLED}:
        return operation
    result = ContentTransferResult(
        status="outcome_unknown" if operation.phase == TransferOperationPhase.STREAMING else "cancelled",
        effects=ContentTransferEffects(
            source="unknown" if operation.phase == TransferOperationPhase.STREAMING else "unchanged",
            destination="unknown" if operation.phase == TransferOperationPhase.STREAMING else "unchanged",
        ),
    )
    operation.phase = (
        TransferOperationPhase.FAILED if operation.phase == TransferOperationPhase.STREAMING else TransferOperationPhase.CANCELLED
    )
    operation.result_json = result.model_dump_json()
    operation.updated_at = datetime.now(timezone.utc)
    session.add(operation)
    session.commit()
    session.refresh(operation)
    return operation


def _get_owned_transfer_operation(
    session: Session,
    current_user: User,
    operation_id: uuid.UUID,
    destination_connection_id: uuid.UUID,
) -> TransferOperation:
    """Load a destination-owned durable operation or return an authorization-safe error."""

    operation = session.get(TransferOperation, operation_id)
    if operation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer operation not found")
    if operation.user_id != current_user.id or operation.destination_connection_id != str(destination_connection_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer operation not found")
    if _transfer_operation_is_expired(operation):
        return _expire_transfer_operation(session, operation)
    return _repair_corrupt_terminal_transfer_operation(session, operation)


@router.post("/{connection_id}/transfer-operations", response_model=TransferOperationRead)
async def prepare_transfer_operation(
    connection_id: uuid.UUID,
    body: TransferOperationCreate,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> TransferOperationRead:
    """Persist a regular SMB transfer plan and capture its source identity before streaming."""

    source_path, destination_path = _validate_copy_move_paths(body.source_path, body.destination_path)
    try:
        source_connection_id = uuid.UUID(body.source_connection_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Source connection must be an SMB connection"
        ) from exc
    destination_connection = _get_connection_or_404(session, current_user, connection_id)
    source_connection = _get_connection_or_404(session, current_user, source_connection_id)
    require_connection_write_access(current_user, destination_connection, action="transfer_destination", path=destination_path)
    fingerprint = _transfer_operation_fingerprint(body, connection_id)
    existing = session.exec(
        select(TransferOperation).where(
            TransferOperation.user_id == current_user.id,
            TransferOperation.idempotency_key == body.idempotency_key,
        )
    ).first()
    if existing is not None:
        if existing.request_fingerprint != fingerprint:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Idempotency key conflicts with its transfer operation")
        return _transfer_operation_read(
            _expire_transfer_operation(session, existing) if _transfer_operation_is_expired(existing) else existing
        )
    source_backend = build_smb_backend(source_connection, backend_factory=SMBBackend)
    try:
        await source_backend.connect()
        source_info = await source_backend.get_file_info(source_path)
    finally:
        await disconnect_backend_safely(
            source_backend,
            logger=logger,
            context=f"prepare transfer operation source: connection_id={source_connection_id}, path='{source_path}'",
        )
    if source_info.type != FileType.FILE or source_info.size is None or not source_info.stable_id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Transfer source must be an identified regular file")
    now = datetime.now(timezone.utc)
    operation = TransferOperation(
        user_id=current_user.id,
        idempotency_key=body.idempotency_key,
        request_fingerprint=fingerprint,
        kind=body.kind,
        source_connection_id=str(source_connection_id),
        source_path=source_path,
        destination_connection_id=str(connection_id),
        destination_path=destination_path,
        target_resolution_policy=body.target_resolution_policy,
        source_size=source_info.size,
        source_modified_at=source_info.modified_at,
        source_stable_id=source_info.stable_id,
        expires_at=now + TRANSFER_OPERATION_TTL,
        created_at=now,
        updated_at=now,
    )
    try:
        session.add(operation)
        session.commit()
        session.refresh(operation)
    except IntegrityError as exc:
        session.rollback()
        existing = session.exec(
            select(TransferOperation).where(
                TransferOperation.user_id == current_user.id,
                TransferOperation.idempotency_key == body.idempotency_key,
            )
        ).first()
        if existing is not None and existing.request_fingerprint == fingerprint:
            return _transfer_operation_read(
                _expire_transfer_operation(session, existing) if _transfer_operation_is_expired(existing) else existing
            )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Idempotency key conflicts with its transfer operation") from exc
    return _transfer_operation_read(operation)


@router.get("/{connection_id}/transfer-operations/{operation_id}", response_model=TransferOperationRead)
async def get_transfer_operation(
    connection_id: uuid.UUID,
    operation_id: uuid.UUID,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> TransferOperationRead:
    """Return an authenticated destination-owned transfer receipt for reload recovery."""

    return _transfer_operation_read(_get_owned_transfer_operation(session, current_user, operation_id, connection_id))


@router.post("/{connection_id}/transfer-operations/{operation_id}/cancel", response_model=TransferOperationRead)
async def cancel_transfer_operation(
    connection_id: uuid.UUID,
    operation_id: uuid.UUID,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> TransferOperationRead:
    """Cancel a prepared operation or record an in-flight cancellation request."""

    operation = _get_owned_transfer_operation(session, current_user, operation_id, connection_id)
    if _transfer_operation_result(operation) is not None:
        return _transfer_operation_read(operation)
    operation.cancellation_requested = True
    operation.updated_at = datetime.now(timezone.utc)
    if operation.phase == TransferOperationPhase.PREPARED:
        result = ContentTransferResult(
            status="cancelled",
            effects=ContentTransferEffects(source="unchanged", destination="unchanged"),
        )
        _record_transfer_operation_result(session, operation, result)
    else:
        session.add(operation)
        session.commit()
        session.refresh(operation)
    return _transfer_operation_read(operation)


@router.post("/{connection_id}/transfer-operations/{operation_id}/execute", response_model=ContentTransferResult)
async def execute_transfer_operation(
    connection_id: uuid.UUID,
    operation_id: uuid.UUID,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> ContentTransferResult:
    """Execute one durable SMB regular-file copy through destination-owned staging."""

    operation = _get_owned_transfer_operation(session, current_user, operation_id, connection_id)
    existing_result = _transfer_operation_result(operation)
    if existing_result is not None:
        return existing_result
    if operation.cancellation_requested:
        result = ContentTransferResult(
            status="cancelled",
            effects=ContentTransferEffects(source="unchanged", destination="unchanged"),
        )
        _record_transfer_operation_result(session, operation, result)
        return result
    if operation.phase != TransferOperationPhase.PREPARED:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Transfer operation is already streaming")
    source_connection = _get_connection_or_404(session, current_user, uuid.UUID(operation.source_connection_id))
    destination_connection = _get_connection_or_404(session, current_user, connection_id)
    source_backend = build_smb_backend(source_connection, backend_factory=SMBBackend)
    destination_backend = build_smb_backend(destination_connection, backend_factory=SMBBackend)
    operation.phase = TransferOperationPhase.STREAMING
    operation.updated_at = datetime.now(timezone.utc)
    session.add(operation)
    session.commit()
    try:
        await source_backend.connect()
        await destination_backend.connect()
        expected_source = RegularFileSourceSnapshot(
            path=operation.source_path,
            size=operation.source_size,
            modified_at=operation.source_modified_at,
            stable_id=operation.source_stable_id,
        )
        current_source = await source_backend.get_file_info(operation.source_path)
        if not expected_source.matches(current_source):
            raise SourceChangedError(f"Source changed before durable transfer execution: {operation.source_path}")

        last_persisted_progress = 0

        def check_cancellation() -> None:
            session.refresh(operation)
            if operation.cancellation_requested:
                raise TransferOperationCancelled()

        def persist_progress(bytes_transferred: int, total_bytes: int | None) -> None:
            nonlocal last_persisted_progress
            check_cancellation()
            if (
                bytes_transferred - last_persisted_progress < TRANSFER_OPERATION_PROGRESS_PERSIST_INTERVAL_BYTES
                and bytes_transferred != total_bytes
            ):
                return
            _record_transfer_operation_progress(session, operation, bytes_transferred)
            last_persisted_progress = bytes_transferred

        async def check_cancellation_before_commit() -> None:
            check_cancellation()

        def cancellation_requested() -> bool:
            session.refresh(operation)
            return operation.cancellation_requested

        if operation.kind == "move":
            transfer_result = await cross_connection_move(
                source_backend,
                destination_backend,
                operation.source_path,
                operation.destination_path,
                on_progress=persist_progress,
                before_destination_commit=check_cancellation_before_commit,
                cancellation=cancellation_requested,
                target_resolution_policy=TargetResolutionPolicy(operation.target_resolution_policy),
            )
        else:
            transfer_result = await cross_connection_copy(
                source_backend,
                destination_backend,
                operation.source_path,
                operation.destination_path,
                on_progress=persist_progress,
                before_destination_commit=check_cancellation_before_commit,
                target_resolution_policy=TargetResolutionPolicy(operation.target_resolution_policy),
            )
        if transfer_result.bytes_written is None:
            result = ContentTransferResult(
                status="skipped",
                effects=ContentTransferEffects(source="unchanged", destination="unchanged"),
            )
        else:
            result = ContentTransferResult(
                status="completed",
                effects=ContentTransferEffects(
                    source="mutated" if operation.kind == "move" else "unchanged",
                    destination="mutated",
                ),
                replaced=transfer_result.replaced,
            )
        if operation.kind == "move" and result.status == "completed":
            _remove_from_directory_cache(operation.source_connection_id, operation.source_path)
        _add_to_directory_cache(str(connection_id), operation.destination_path)
    except TargetCollisionError as exc:
        result = ContentTransferResult(
            status="failed",
            effects=ContentTransferEffects(source="unchanged", destination="unchanged"),
            error=ContentTransferError(code="conflict", detail=str(exc)),
        )
    except SourceChangedError as exc:
        result = ContentTransferResult(
            status="failed",
            effects=ContentTransferEffects(
                source="unchanged",
                destination="mutated" if exc.destination_mutated else "unchanged",
            ),
            replaced=exc.replaced,
            error=ContentTransferError(code="source_changed", detail=str(exc)),
        )
    except SourceDeleteError as exc:
        result = ContentTransferResult(
            status="completed_with_source_retained" if exc.destination_mutated else "failed",
            effects=ContentTransferEffects(
                source="unchanged",
                destination="mutated" if exc.destination_mutated else "unchanged",
            ),
            replaced=exc.replaced,
            error=ContentTransferError(code="source_delete_failed", detail=str(exc)),
        )
    except SourceDeletionOutcomeUnknown as exc:
        result = ContentTransferResult(
            status="outcome_unknown",
            effects=ContentTransferEffects(source="unknown", destination="mutated"),
            replaced=exc.replaced,
        )
    except (TransferOperationCancelled, TransferCancelled):
        result = ContentTransferResult(
            status="cancelled",
            effects=ContentTransferEffects(source="unchanged", destination="unchanged"),
        )
    except Exception:
        logger.exception("Durable transfer operation outcome is unknown: operation_id=%s", operation.id)
        result = ContentTransferResult(
            status="outcome_unknown",
            effects=ContentTransferEffects(source="unknown", destination="unknown"),
        )
    finally:
        await disconnect_backend_safely(source_backend, logger=logger, context=f"transfer operation source {operation.id}")
        await disconnect_backend_safely(destination_backend, logger=logger, context=f"transfer operation destination {operation.id}")
    if result.effects.destination == "mutated":
        _add_to_directory_cache(str(connection_id), operation.destination_path)
    logger.info(
        "Transfer outcome: operation_id=%s source_connection=%s destination_connection=%s source=%s destination=%s status=%s effects=%s",
        operation.id,
        operation.source_connection_id,
        connection_id,
        operation.source_path,
        operation.destination_path,
        result.status,
        result.effects.model_dump(),
    )
    _record_transfer_operation_result(session, operation, result)
    return result


# ============================================================================
# Delete file or empty directory
# ============================================================================


#
# delete_item
#
@router.delete("/{connection_id}/item", status_code=status.HTTP_204_NO_CONTENT)
async def delete_item(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to the file or directory to delete"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> None:
    """Delete a file or directory.

    Directories are deleted recursively — all contents are removed first.
    """

    # Set user context for logging
    set_user(current_user.username)

    connection = _get_connection_or_404(session, current_user, connection_id)
    require_connection_write_access(current_user, connection, action="delete", path=path)

    if not path or path.strip("/") == "":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete the share root",
        )

    try:
        # Stop any active directory monitor for this path (and its
        # children) before deleting.  The monitor holds a persistent
        # SMB directory handle; if it's still open when rmdir runs,
        # the server can only mark the directory as "delete pending"
        # instead of removing it immediately.
        _stop_monitors_for_path(str(connection_id), path)

        backend = build_smb_backend(connection, backend_factory=SMBBackend)

        await backend.connect()
        try:
            await backend.delete_item(path)
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"delete request: connection_id={connection_id}, path='{path}'",
            )

        # Remove from directory cache if it was a directory
        _remove_from_directory_cache(str(connection_id), path)

        logger.info(f"Deleted item: connection_id={connection_id}, path='{path}', user={current_user.username}")

    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Item not found: {path}",
        )
    except TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Delete timed out. The remote share did not respond in time.",
        )
    except OSError as e:
        logger.error(
            f"Failed to delete item: connection_id={connection_id}, path='{path}', error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete item: {str(e)}",
        )
    except Exception as e:
        logger.error(
            f"Failed to delete item: connection_id={connection_id}, path='{path}', error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete item: {str(e)}",
        )


@router.delete("/{connection_id}/empty-directory", status_code=status.HTTP_204_NO_CONTENT)
async def remove_empty_directory(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Empty directory path to remove"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> None:
    """Remove an empty directory, returning 409 without deleting non-empty content."""

    if not path or path.strip("/") == "":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete the share root")
    connection = _get_connection_or_404(session, current_user, connection_id)
    require_connection_write_access(current_user, connection, action="delete", path=path)
    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    try:
        await backend.connect()
        info = await backend.get_file_info(path)
        if info.type != FileType.DIRECTORY:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Target is not a directory: {path}")
        await backend.remove_empty_directory(path)
    except FileNotFoundError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Item not found: {path}") from None
    except OSError as error:
        error_text = str(error).lower()
        if "not empty" in error_text or "0xc0000101" in error_text:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Directory is not empty: {path}") from error
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Failed to remove empty directory: {error}"
        ) from error
    finally:
        await disconnect_backend_safely(
            backend,
            logger=logger,
            context=f"remove empty directory: connection_id={connection_id}, path='{path}'",
        )


# ============================================================================
# Rename file or directory
# ============================================================================

# Characters forbidden in SMB/NTFS file names
_INVALID_NAME_CHARS = frozenset('\\/:*?"<>|')
_UNICODE_NFC_NORMALIZATION_FORM: Literal["NFC"] = "NFC"


def _validate_item_name(raw_name: str) -> str:
    """Canonicalize, validate, and return an SMB item name, or raise HTTPException.

    Checks for empty names, reserved names (`.`, `..`), invalid NTFS
    characters, and terminal whitespace or periods. Canonical NFC
    normalization prevents Sambee from creating decomposed Unicode names.
    Leading whitespace is preserved because it is valid in SMB file and
    directory names.

    Args:
        raw_name: The raw name string to validate.

    Returns:
        The NFC-normalized, validated name.

    Raises:
        HTTPException: 400 if the name is invalid.
    """

    name = unicodedata.normalize(_UNICODE_NFC_NORMALIZATION_FORM, raw_name)
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Name must not be empty",
        )
    if name in (".", ".."):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Name must not be '.' or '..'",
        )
    if any(ch in _INVALID_NAME_CHARS for ch in name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Name contains invalid characters",
        )
    if name[-1].isspace() or name.endswith("."):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Name must not end with a space or period",
        )
    return name


def _canonicalize_destination_path(raw_path: str) -> str:
    """Return a stripped destination path with only its leaf name normalized.

    Source paths must preserve their original Unicode representation so
    existing non-NFC entries on an SMB share remain addressable.
    """

    path = raw_path.strip("/") if raw_path else ""
    if not path:
        return ""
    parent, separator, raw_name = path.rpartition("/")
    name = _validate_item_name(raw_name)
    return f"{parent}{separator}{name}"


#
# rename_item
#
@router.post("/{connection_id}/rename", response_model=FileInfo)
async def rename_item(
    connection_id: uuid.UUID,
    body: RenameRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> FileInfo:
    """Rename a file or directory.

    The item stays in its current parent directory — only the name changes.
    Returns the updated FileInfo for the renamed item.
    """

    set_user(current_user.username)

    # --- Validate new_name ------------------------------------------------
    new_name = _validate_item_name(body.new_name)

    # --- Validate path ----------------------------------------------------
    path = body.path
    if not path or path.strip("/") == "":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot rename the share root",
        )

    # --- Look up connection -----------------------------------------------
    connection = _get_connection_or_404(session, current_user, connection_id)
    require_connection_write_access(current_user, connection, action="rename", path=path)

    try:
        backend = build_smb_backend(connection, backend_factory=SMBBackend)

        await backend.connect()
        try:
            await backend.rename_item(path, new_name)

            # Build the new path (same parent, different leaf)
            parent = path.rsplit("/", 1)[0] if "/" in path else ""
            new_path = f"{parent}/{new_name}" if parent else new_name

            # Fetch updated file info for the response
            file_info = await backend.get_file_info(new_path)
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"rename request: connection_id={connection_id}, path='{path}', new_name='{new_name}'",
            )

        # Update directory cache if renamed item was a directory
        _rename_in_directory_cache(str(connection_id), path, new_path)

        logger.info(f"Renamed item: connection_id={connection_id}, '{path}' -> '{new_name}', user={current_user.username}")
        return file_info

    except FileNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Item not found: {path}",
        )
    except FileExistsError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Rename timed out. The remote share did not respond in time.",
        )
    except OSError as e:
        logger.error(
            f"Failed to rename item: connection_id={connection_id}, path='{path}', new_name='{new_name}', error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to rename item: {str(e)}",
        )
    except Exception as e:
        logger.error(
            f"Failed to rename item: connection_id={connection_id}, path='{path}', new_name='{new_name}', error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to rename item: {str(e)}",
        )


# ============================================================================
# Create new file or directory
# ============================================================================


#
# create_item
#
@router.post("/{connection_id}/create", response_model=FileInfo)
async def create_item(
    connection_id: uuid.UUID,
    body: CreateItemRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> FileInfo:
    """Create a new file or directory.

    Creates the item inside the specified parent directory.
    Returns the FileInfo for the newly created item.
    """

    set_user(current_user.username)

    # --- Validate name ----------------------------------------------------
    name = _validate_item_name(body.name)

    # --- Build the full path for the new item -----------------------------
    parent_path = body.parent_path.strip("/") if body.parent_path else ""
    new_item_path = f"{parent_path}/{name}" if parent_path else name

    # --- Look up connection -----------------------------------------------
    connection = _get_connection_or_404(session, current_user, connection_id)
    require_connection_write_access(current_user, connection, action="create", path=new_item_path)

    try:
        backend = build_smb_backend(connection, backend_factory=SMBBackend)

        await backend.connect()
        try:
            if body.type == FileType.DIRECTORY:
                await backend.create_directory(new_item_path)
            else:
                await backend.create_file(new_item_path)

            # Fetch file info for the response
            file_info = await backend.get_file_info(new_item_path)
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"create request: connection_id={connection_id}, path='{new_item_path}'",
            )

        # Update directory cache if a new directory was created
        if body.type == FileType.DIRECTORY:
            _add_to_directory_cache(str(connection_id), new_item_path)

        logger.info(f"Created {body.type}: connection_id={connection_id}, path='{new_item_path}', user={current_user.username}")
        return file_info

    except FileExistsError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(e),
        )
    except FileNotFoundError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Create timed out. The remote share did not respond in time.",
        )
    except OSError as e:
        logger.error(
            f"Failed to create item: connection_id={connection_id}, path='{new_item_path}', error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create item: {str(e)}",
        )
    except Exception as e:
        logger.error(
            f"Failed to create item: connection_id={connection_id}, path='{new_item_path}', error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create item: {str(e)}",
        )


# ============================================================================
# Copy file or directory
# ============================================================================
def _validate_copy_move_paths(source_path: str, dest_path: str) -> tuple[str, str]:
    """Validate and normalize source and dest paths for copy/move.

    Raises HTTPException on invalid input. Returns (source, dest) with
    leading/trailing slashes stripped.
    """

    source = source_path.strip("/") if source_path else ""
    dest = _canonicalize_destination_path(dest_path)

    if not source:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Source path must not be empty",
        )
    if not dest:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Destination path must not be empty",
        )
    if source == dest:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Source and destination paths must be different",
        )
    # Prevent copying/moving a directory into itself
    if dest.startswith(source + "/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot copy or move a directory into itself",
        )
    return source, dest


async def _conflict_response(
    connection: Connection,
    body: CopyMoveRequest,
    connection_id: uuid.UUID,
    source: str,
    dest: str,
    current_user: User,
    session: Session,
    *,
    source_info: FileInfo | None = None,
    target_info: FileInfo | None = None,
) -> HTTPException:
    """Build a 409 response with ``ConflictInfo`` for overwrite prompts.

    Fetches metadata for both the existing destination and the incoming
    source so the frontend can display a meaningful comparison dialog.
    Falls back to a plain 409 if metadata retrieval fails.
    """

    if source_info is not None and target_info is not None:
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=ConflictInfo(existing_file=target_info, incoming_file=source_info).model_dump(mode="json"),
        )

    try:
        # Determine which backend to use for each path
        source_backend = build_smb_backend(connection, backend_factory=SMBBackend)
        await source_backend.connect()

        is_cross = bool(body.dest_connection_id and str(body.dest_connection_id) != str(connection_id))
        if is_cross:
            dest_connection = _get_connection_or_404(session, current_user, uuid.UUID(str(body.dest_connection_id)))
            dest_backend = build_smb_backend(dest_connection, backend_factory=SMBBackend)
            await dest_backend.connect()
        else:
            dest_backend = source_backend

        try:
            source_info = await source_backend.get_file_info(source)
            existing_info = await dest_backend.get_file_info(dest)

            conflict = ConflictInfo(
                existing_file=existing_info,
                incoming_file=source_info,
            )

            return HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=conflict.model_dump(mode="json"),
            )
        finally:
            await disconnect_backend_safely(
                source_backend,
                logger=logger,
                context=f"conflict metadata lookup for source '{source}'",
            )
            if is_cross:
                await disconnect_backend_safely(
                    dest_backend,
                    logger=logger,
                    context=f"conflict metadata lookup for destination '{dest}'",
                )

    except Exception as info_err:
        # If we can't fetch metadata, fall back to a plain 409
        logger.warning(f"Could not fetch conflict metadata: {info_err}")
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Destination already exists: {dest}",
        )


async def _resolve_direct_regular_file_transfer(
    *,
    backend: SMBBackend,
    source: str,
    dest: str,
    policy: TargetResolutionPolicy,
    operation: Callable[[FileInfo, TargetResolutionDisposition], Awaitable[object]],
) -> TargetResolutionDisposition:
    """Resolve one SMB regular-file transfer through guarded target promotion."""

    source_info = await backend.get_file_info(source)
    if source_info.type != FileType.FILE:
        raise RegularFileTransferRequiredError("Directory transfers must be coordinated by the client")

    resolution = await resolve_regular_file_transfer(
        source=source_info,
        target_path=dest,
        policy=policy,
        observe_target=lambda: backend.get_file_info(dest),
        attempt_create=lambda disposition: operation(source_info, disposition),
        replacement_supported=True,
    )
    return resolution.disposition


def _get_connection_or_404(session: Session, current_user: User, connection_id: uuid.UUID) -> Connection:
    """Look up a connection by ID, raising 404 if not found or misconfigured."""

    connection = get_accessible_connection_or_404(session, current_user, connection_id)

    if not connection.share_name:
        logger.warning(f"Connection has no share name: connection_id={connection_id}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Connection has no share name configured",
        )
    return connection


#
# copy_item
#
@router.post("/{connection_id}/transfer-attempts/{attempt_id}/cancel", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_transfer_attempt(
    connection_id: uuid.UUID,
    attempt_id: uuid.UUID,
    current_user: User = Depends(get_current_user_with_auth_check),
) -> None:
    """Request cooperative cancellation of an active, non-durable transfer."""

    key = (current_user.username, str(attempt_id))
    async with _transfer_cancellation_lock:
        cancellation = _transfer_cancellations.get(key)
        if cancellation is not None:
            cancellation.set()


@router.post("/{connection_id}/copy", response_model=ContentTransferResult)
async def copy_item(
    connection_id: uuid.UUID,
    body: CopyMoveRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> ContentTransferResult:
    """Copy a regular file.

    Copies the source item to the destination path.  When
    ``dest_connection_id`` differs from the source connection, a
    cross-connection copy is performed by streaming data through the
    backend.  Byte-level progress is broadcast over WebSocket as
    ``transfer_progress`` events.

    When ``overwrite`` is ``True``, the destination is replaced if it
    exists.  Otherwise a 409 response is returned with ``ConflictInfo``
    containing metadata for both the existing and incoming items.
    """

    set_user(current_user.username)

    source, dest = _validate_copy_move_paths(body.source_path, body.dest_path)

    is_cross_connection = bool(body.dest_connection_id and str(body.dest_connection_id) != str(connection_id))
    policy = TargetResolutionPolicy(body.normalized_target_resolution_policy)

    connection = _get_connection_or_404(session, current_user, connection_id)

    cached_result = await _find_transfer_receipt(current_user, body)
    if cached_result is not None:
        return cached_result
    cancellation = await _register_transfer_cancellation(current_user, body)

    try:
        if is_cross_connection:
            dest_connection = _get_connection_or_404(
                session,
                current_user,
                uuid.UUID(str(body.dest_connection_id)),
            )
            require_connection_write_access(current_user, dest_connection, action="copy_destination", path=dest)
            result = await _cross_connection_copy(
                connection,
                dest_connection,
                source,
                dest,
                str(body.dest_connection_id),
                overwrite=False,
                target_resolution_policy=policy,
                cancellation=cancellation.is_set if cancellation is not None else None,
                transfer_attempt_id=str(body.transfer_attempt_id) if body.transfer_attempt_id else None,
            )
        else:
            require_connection_write_access(current_user, connection, action="copy_destination", path=dest)
            backend = build_smb_backend(connection, backend_factory=SMBBackend)
            await backend.connect()
            try:

                async def copy_direct(source_info: FileInfo, disposition: TargetResolutionDisposition) -> object:
                    return await copy_regular_file_to_missing_target(
                        backend,
                        backend,
                        source,
                        dest,
                        source_info,
                        cancellation=cancellation.is_set if cancellation is not None else None,
                        overwrite=disposition == TargetResolutionDisposition.REPLACE_EXISTING,
                        target_resolution_policy=policy,
                        expected_disposition=disposition,
                    )

                disposition = await _resolve_direct_regular_file_transfer(
                    backend=backend,
                    source=source,
                    dest=dest,
                    policy=policy,
                    operation=copy_direct,
                )
                if disposition == TargetResolutionDisposition.AWAIT_COLLISION:
                    raise FileExistsError(f"Destination already exists: {dest}")
                result = ContentTransferResult(
                    status="skipped" if disposition == TargetResolutionDisposition.SKIP else "completed",
                    effects=ContentTransferEffects(
                        source="unchanged",
                        destination="unchanged" if disposition == TargetResolutionDisposition.SKIP else "mutated",
                    ),
                    replaced=disposition == TargetResolutionDisposition.REPLACE_EXISTING,
                )
            finally:
                await disconnect_backend_safely(
                    backend,
                    logger=logger,
                    context=f"copy request: connection_id={connection_id}, source='{source}', dest='{dest}'",
                )

            if result.effects.destination == "mutated":
                _add_to_directory_cache(str(connection_id), dest)

        logger.info(f"Copied item: connection_id={connection_id}, '{source}' -> '{dest}', user={current_user.username}")
        return await _record_transfer_receipt(current_user, body, result)

    except TransferCancelled:
        return await _record_transfer_receipt(
            current_user,
            body,
            ContentTransferResult(status="cancelled", effects=ContentTransferEffects(source="unchanged", destination="unchanged")),
        )
    except TargetCollisionError as exc:
        conflict = await _conflict_response(
            connection,
            body,
            connection_id,
            source,
            dest,
            current_user,
            session,
            source_info=exc.source,
            target_info=exc.target,
        )
        await _record_transfer_http_error(current_user, body, conflict)
        raise conflict
    except SourceChangedError as exc:
        if exc.destination_mutated:
            _add_to_directory_cache(str(body.dest_connection_id) if is_cross_connection else str(connection_id), dest)
        return await _record_transfer_receipt(
            current_user,
            body,
            ContentTransferResult(
                status="failed",
                effects=ContentTransferEffects(
                    source="unchanged",
                    destination="mutated" if exc.destination_mutated else "unchanged",
                ),
                replaced=exc.replaced,
                error=ContentTransferError(code="source_changed", detail=str(exc)),
            ),
        )
    except RegularFileTransferRequiredError as exc:
        unsupported = HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc))
        await _record_transfer_http_error(current_user, body, unsupported)
        raise unsupported
    except FileNotFoundError:
        missing_source = HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Source not found: {source}",
        )
        await _record_transfer_http_error(current_user, body, missing_source)
        raise missing_source
    except FileExistsError:
        conflict = await _conflict_response(connection, body, connection_id, source, dest, current_user, session)
        await _record_transfer_http_error(current_user, body, conflict)
        raise conflict
    except HTTPException as error:
        await _record_transfer_http_error(current_user, body, error)
        raise
    except TimeoutError:
        await _raise_recorded_transfer_http_error(
            current_user,
            body,
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Copy timed out. The remote share did not respond in time.",
        )
    except OSError as e:
        logger.error(
            f"Failed to copy item: connection_id={connection_id}, '{source}' -> '{dest}', error={type(e).__name__}: {e}",
            exc_info=True,
        )
        await _raise_recorded_transfer_http_error(
            current_user,
            body,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to copy item: {str(e)}",
        )
    except Exception as e:
        logger.error(
            f"Failed to copy item: connection_id={connection_id}, '{source}' -> '{dest}', error={type(e).__name__}: {e}",
            exc_info=True,
        )
        await _raise_recorded_transfer_http_error(
            current_user,
            body,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to copy item: {str(e)}",
        )
    finally:
        await _record_unknown_transfer_outcome(current_user, body)
        await _unregister_transfer_cancellation(current_user, body, cancellation)


# ============================================================================
# Move file or directory
# ============================================================================


#
# move_item
#
@router.post("/{connection_id}/move", response_model=ContentTransferResult)
async def move_item(
    connection_id: uuid.UUID,
    body: CopyMoveRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> ContentTransferResult:
    """Move a regular file within one SMB connection using staged replacement."""

    set_user(current_user.username)

    source, dest = _validate_copy_move_paths(body.source_path, body.dest_path)
    is_cross_connection = bool(body.dest_connection_id and str(body.dest_connection_id) != str(connection_id))
    connection = _get_connection_or_404(session, current_user, connection_id)
    cached_result = await _find_transfer_receipt(current_user, body)
    if cached_result is not None:
        return cached_result
    cancellation = await _register_transfer_cancellation(current_user, body)

    try:
        if is_cross_connection:
            dest_connection = _get_connection_or_404(session, current_user, uuid.UUID(str(body.dest_connection_id)))
            require_connection_write_access(current_user, connection, action="move_source", path=source)
            require_connection_write_access(current_user, dest_connection, action="move_destination", path=dest)
            copied = await _cross_connection_move(
                connection,
                dest_connection,
                source,
                dest,
                str(body.dest_connection_id),
                target_resolution_policy=TargetResolutionPolicy(body.normalized_target_resolution_policy),
                cancellation=cancellation.is_set if cancellation is not None else None,
                transfer_attempt_id=str(body.transfer_attempt_id) if body.transfer_attempt_id else None,
            )
            return await _record_transfer_receipt(current_user, body, copied)

        require_connection_write_access(current_user, connection, action="move", path=source)
        backend = build_smb_backend(connection, backend_factory=SMBBackend)
        await backend.connect()
        try:
            policy = TargetResolutionPolicy(body.normalized_target_resolution_policy)

            async def move_direct(source_info: FileInfo, disposition: TargetResolutionDisposition) -> object:
                if cancellation is not None and cancellation.is_set():
                    raise TransferCancelled("Transfer cancelled before source move")
                await final_target_policy_check(
                    source=source_info,
                    dest=backend,
                    dest_path=dest,
                    policy=policy,
                    expected_disposition=disposition,
                    before_destination_commit=None,
                )()
                await backend.move_item(
                    source,
                    dest,
                    overwrite=disposition == TargetResolutionDisposition.REPLACE_EXISTING,
                )
                return None

            disposition = await _resolve_direct_regular_file_transfer(
                backend=backend,
                source=source,
                dest=dest,
                policy=policy,
                operation=move_direct,
            )
            if disposition == TargetResolutionDisposition.AWAIT_COLLISION:
                raise FileExistsError(f"Destination already exists: {dest}")
        finally:
            await disconnect_backend_safely(
                backend,
                logger=logger,
                context=f"move request: connection_id={connection_id}, source='{source}', dest='{dest}'",
            )

        result = ContentTransferResult(
            status="skipped" if disposition == TargetResolutionDisposition.SKIP else "completed",
            effects=ContentTransferEffects(
                source="unchanged" if disposition == TargetResolutionDisposition.SKIP else "mutated",
                destination="unchanged" if disposition == TargetResolutionDisposition.SKIP else "mutated",
            ),
            replaced=disposition == TargetResolutionDisposition.REPLACE_EXISTING,
        )
        if disposition != TargetResolutionDisposition.SKIP:
            _remove_from_directory_cache(str(connection_id), source)
            _add_to_directory_cache(str(connection_id), dest)
            logger.info(f"Moved item: connection_id={connection_id}, '{source}' -> '{dest}', user={current_user.username}")
        return await _record_transfer_receipt(current_user, body, result)
    except TransferCancelled:
        return await _record_transfer_receipt(
            current_user,
            body,
            ContentTransferResult(status="cancelled", effects=ContentTransferEffects(source="unchanged", destination="unchanged")),
        )
    except SourceChangedError as exc:
        if exc.destination_mutated:
            _add_to_directory_cache(str(body.dest_connection_id) if is_cross_connection else str(connection_id), dest)
        return await _record_transfer_receipt(
            current_user,
            body,
            ContentTransferResult(
                status="failed",
                effects=ContentTransferEffects(
                    source="unchanged",
                    destination="mutated" if exc.destination_mutated else "unchanged",
                ),
                replaced=exc.replaced,
                error=ContentTransferError(code="source_changed", detail=str(exc)),
            ),
        )
    except RegularFileTransferRequiredError as exc:
        unsupported = HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc))
        await _record_transfer_http_error(current_user, body, unsupported)
        raise unsupported
    except FileNotFoundError:
        missing_source = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Source not found: {source}")
        await _record_transfer_http_error(current_user, body, missing_source)
        raise missing_source
    except FileExistsError:
        conflict = await _conflict_response(connection, body, connection_id, source, dest, current_user, session)
        await _record_transfer_http_error(current_user, body, conflict)
        raise conflict
    except HTTPException as error:
        await _record_transfer_http_error(current_user, body, error)
        raise
    except TimeoutError:
        await _raise_recorded_transfer_http_error(
            current_user,
            body,
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Move timed out. The remote share did not respond in time.",
        )
    except OSError as error:
        logger.error(
            f"Failed to move item: connection_id={connection_id}, '{source}' -> '{dest}', error={type(error).__name__}: {error}",
            exc_info=True,
        )
        await _raise_recorded_transfer_http_error(
            current_user,
            body,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to move item: {str(error)}",
        )
    except Exception as error:
        logger.error(
            f"Failed to move item: connection_id={connection_id}, '{source}' -> '{dest}', error={type(error).__name__}: {error}",
            exc_info=True,
        )
        await _raise_recorded_transfer_http_error(
            current_user,
            body,
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to move item: {str(error)}",
        )
    finally:
        await _record_unknown_transfer_outcome(current_user, body)
        await _unregister_transfer_cancellation(current_user, body, cancellation)


# ============================================================================
# Cross-connection copy/move helpers
# ============================================================================

CROSS_CONNECTION_PROGRESS_INTERVAL_SECONDS = 0.25


def _cross_connection_progress(
    dst_conn_id: str, dest_path: str, transfer_attempt_id: str | None, pending: set[asyncio.Task[None]]
) -> Callable[[int, int | None], None]:
    from app.api.websocket import notify_transfer_progress

    dest_parent = str(PurePosixPath(dest_path).parent)
    if dest_parent == ".":
        dest_parent = ""
    item_name = PurePosixPath(dest_path).name
    last_broadcast = 0.0

    def on_progress(bytes_transferred: int, total_bytes: int | None) -> None:
        nonlocal last_broadcast
        now = monotonic()
        if pending or now - last_broadcast < CROSS_CONNECTION_PROGRESS_INTERVAL_SECONDS:
            return
        last_broadcast = now
        task = asyncio.get_running_loop().create_task(
            notify_transfer_progress(dst_conn_id, dest_parent, bytes_transferred, total_bytes, item_name, transfer_attempt_id)
        )
        pending.add(task)

        def on_done(completed: asyncio.Task[None]) -> None:
            pending.discard(completed)
            if not completed.cancelled() and (error := completed.exception()) is not None:
                logger.warning("Transfer byte progress notification failed for destination %s: %s", dest_path, error)

        task.add_done_callback(on_done)

    return on_progress


def _notify_cross_connection_complete(
    dst_conn_id: str, dest_path: str, transfer_attempt_id: str | None, pending: set[asyncio.Task[None]]
) -> None:
    from app.api.websocket import notify_transfer_progress

    dest_parent = str(PurePosixPath(dest_path).parent)
    in_flight = tuple(pending)

    async def send_completion() -> None:
        if in_flight:
            await asyncio.gather(*in_flight, return_exceptions=True)
        try:
            await notify_transfer_progress(
                dst_conn_id, "" if dest_parent == "." else dest_parent, -1, -1, PurePosixPath(dest_path).name, transfer_attempt_id
            )
        except Exception as error:
            logger.warning("Transfer completion notification failed for destination %s: %s", dest_path, error)

    task = asyncio.get_running_loop().create_task(send_completion())
    pending.add(task)
    task.add_done_callback(pending.discard)


async def _cross_connection_copy(
    src_conn: Connection,
    dst_conn: Connection,
    source_path: str,
    dest_path: str,
    dst_conn_id: str,
    *,
    overwrite: bool = False,
    target_resolution_policy: TargetResolutionPolicy | None = None,
    cancellation: Callable[[], bool] | None = None,
    transfer_attempt_id: str | None = None,
) -> ContentTransferResult:
    """Perform a cross-connection copy with WebSocket progress reporting.

    Builds two separate SMB backends, streams data from source to
    destination, and broadcasts byte-level progress via WebSocket.
    """

    source_backend = build_smb_backend(src_conn, backend_factory=SMBBackend)
    dest_backend = build_smb_backend(dst_conn, backend_factory=SMBBackend)
    pending: set[asyncio.Task[None]] = set()

    await source_backend.connect()
    await dest_backend.connect()

    try:
        transfer_result = await cross_connection_copy(
            source_backend,
            dest_backend,
            source_path,
            dest_path,
            on_progress=_cross_connection_progress(dst_conn_id, dest_path, transfer_attempt_id, pending),
            overwrite=overwrite,
            target_resolution_policy=target_resolution_policy,
            cancellation=cancellation,
        )
        if transfer_result.bytes_written is None:
            return ContentTransferResult(
                status="skipped",
                effects=ContentTransferEffects(source="unchanged", destination="unchanged"),
            )

        # Send a final 100 % broadcast
        _notify_cross_connection_complete(dst_conn_id, dest_path, transfer_attempt_id, pending)

        # Update directory cache for the destination connection
        _add_to_directory_cache(dst_conn_id, dest_path)
        return ContentTransferResult(
            status="completed",
            effects=ContentTransferEffects(source="unchanged", destination="mutated"),
            replaced=transfer_result.replaced,
        )

    finally:
        await disconnect_backend_safely(
            source_backend,
            logger=logger,
            context=f"cross-connection copy source cleanup: '{source_path}' -> '{dest_path}'",
        )
        await disconnect_backend_safely(
            dest_backend,
            logger=logger,
            context=f"cross-connection copy destination cleanup: '{source_path}' -> '{dest_path}'",
        )


async def _cross_connection_move(
    src_conn: Connection,
    dst_conn: Connection,
    source_path: str,
    dest_path: str,
    dst_conn_id: str,
    *,
    target_resolution_policy: TargetResolutionPolicy | None = None,
    cancellation: Callable[[], bool] | None = None,
    transfer_attempt_id: str | None = None,
) -> ContentTransferResult:
    """Move across SMB connections using a retained source handle when available."""

    source_backend = build_smb_backend(src_conn, backend_factory=SMBBackend)
    dest_backend = build_smb_backend(dst_conn, backend_factory=SMBBackend)
    pending: set[asyncio.Task[None]] = set()
    await source_backend.connect()
    await dest_backend.connect()
    try:
        try:
            transfer_result = await cross_connection_move(
                source_backend,
                dest_backend,
                source_path,
                dest_path,
                on_progress=_cross_connection_progress(dst_conn_id, dest_path, transfer_attempt_id, pending),
                target_resolution_policy=target_resolution_policy,
                cancellation=cancellation,
            )
        except SourceDeleteError as error:
            if not error.destination_mutated:
                raise
            logger.warning(
                "Move source retained: source_connection=%s destination_connection=%s source=%s destination=%s attempt_id=%s phase=source_delete effects=unchanged/mutated replaced=%s detail=%s",
                src_conn.id,
                dst_conn.id,
                source_path,
                dest_path,
                transfer_attempt_id,
                error.replaced,
                error,
            )
            _add_to_directory_cache(dst_conn_id, dest_path)
            _notify_cross_connection_complete(dst_conn_id, dest_path, transfer_attempt_id, pending)
            return ContentTransferResult(
                status="completed_with_source_retained",
                effects=ContentTransferEffects(source="unchanged", destination="mutated"),
                replaced=error.replaced,
                error=ContentTransferError(code="source_delete_failed", detail=str(error)),
            )
        except SourceDeletionOutcomeUnknown as error:
            logger.warning(
                "Move source deletion uncertain: source_connection=%s destination_connection=%s source=%s destination=%s attempt_id=%s phase=source_delete effects=unknown/mutated replaced=%s; inspect both locations before another move",
                src_conn.id,
                dst_conn.id,
                source_path,
                dest_path,
                transfer_attempt_id,
                error.replaced,
            )
            _add_to_directory_cache(dst_conn_id, dest_path)
            _notify_cross_connection_complete(dst_conn_id, dest_path, transfer_attempt_id, pending)
            return ContentTransferResult(
                status="outcome_unknown",
                effects=ContentTransferEffects(source="unknown", destination="mutated"),
                replaced=error.replaced,
            )
        if transfer_result.bytes_written is None:
            return ContentTransferResult(
                status="skipped",
                effects=ContentTransferEffects(source="unchanged", destination="unchanged"),
            )
        _notify_cross_connection_complete(dst_conn_id, dest_path, transfer_attempt_id, pending)
        _remove_from_directory_cache(str(src_conn.id), source_path)
        _add_to_directory_cache(dst_conn_id, dest_path)
        return ContentTransferResult(
            status="completed",
            effects=ContentTransferEffects(source="mutated", destination="mutated"),
            replaced=transfer_result.replaced,
        )
    finally:
        await disconnect_backend_safely(
            source_backend,
            logger=logger,
            context=f"cross-connection move source cleanup: '{source_path}' -> '{dest_path}'",
        )
        await disconnect_backend_safely(
            dest_backend,
            logger=logger,
            context=f"cross-connection move destination cleanup: '{source_path}' -> '{dest_path}'",
        )


# ============================================================================
# Helper: feed directory cache from existing operations
# ============================================================================


#
# _update_directory_cache_from_listing
#
def _update_directory_cache_from_listing(connection_id: str, listing: DirectoryListing) -> None:
    """Feed discovered directories from a list_directory call into the cache.

    This implements the plan requirement: "Use any update mechanism we already
    have (watching the currently displayed directory, user presses F5, ...) to
    also update the cache."

    Only updates the cache if it already exists for this connection (i.e.,
    the user has triggered a directory search at least once). Does not create
    a new cache — that's done on first search request.
    """

    from app.models.file import FileType
    from app.services.directory_cache import get_directory_cache_manager

    try:
        cache_manager = get_directory_cache_manager()
        cache = cache_manager.get_cache(connection_id)
        if cache is None:
            return  # No active cache for this connection

        # Extract directory paths from the listing
        dir_paths = [item.path for item in listing.items if item.type == FileType.DIRECTORY]
        if dir_paths:
            cache.add_directories(dir_paths)
    except Exception:
        # Never let cache updates break the main flow
        pass


#
# _stop_monitors_for_path
#
def _stop_monitors_for_path(connection_id: str, path: str) -> None:
    """Stop directory monitors for *path* and any of its children.

    Before deleting a directory we must release the SMB handles held by
    the directory monitor.  Without this, ``rmdir`` marks the directory
    as "delete pending" instead of removing it immediately, because
    the server sees an outstanding open handle.

    Silently ignores errors — monitor cleanup must never break the
    delete flow.
    """

    from app.api.websocket import manager
    from app.services.directory_monitor import get_monitor

    try:
        monitor = get_monitor()
        prefix = f"{connection_id}:{path}"

        # Snapshot keys to avoid mutating while iterating
        keys_to_stop = [key for key in list(manager.active_connections.keys()) if key == prefix or key.startswith(f"{prefix}/")]

        for key in keys_to_stop:
            try:
                conn_id, sub_path = key.split(":", 1)
                resolved = manager._resolved_paths.pop(key, sub_path)
                monitor.stop_monitoring(conn_id, resolved)

                # Also clean up the subscription bookkeeping so the
                # manager doesn't try to stop it again on disconnect.
                manager.active_connections.pop(key, None)
                for ws_subs in manager.subscriptions.values():
                    ws_subs.discard(key)

                logger.info(f"Stopped monitor before delete: {key}")
            except Exception as e:
                logger.warning(f"Failed to stop monitor {key} before delete: {e}")
    except Exception:
        pass


#
# _remove_from_directory_cache
#
def _remove_from_directory_cache(connection_id: str, path: str) -> None:
    """Remove a deleted directory from the directory cache, if it exists.

    Silently ignores errors — cache updates must never break the main flow.
    """

    from app.services.directory_cache import get_directory_cache_manager

    try:
        cache_manager = get_directory_cache_manager()
        cache = cache_manager.get_cache(connection_id)
        if cache is None:
            return

        cache.remove_directory(path)
    except Exception:
        pass


#
# _rename_in_directory_cache
#
def _rename_in_directory_cache(connection_id: str, old_path: str, new_path: str) -> None:
    """Update a renamed directory in the directory cache, if it exists.

    Silently ignores errors — cache updates must never break the main flow.
    """

    from app.services.directory_cache import get_directory_cache_manager

    try:
        cache_manager = get_directory_cache_manager()
        cache = cache_manager.get_cache(connection_id)
        if cache is None:
            return

        cache.rename_directory(old_path, new_path)
    except Exception:
        pass


#
# _add_to_directory_cache
#
def _add_to_directory_cache(connection_id: str, path: str) -> None:
    """Add a newly created directory to the directory cache, if it exists.

    Silently ignores errors — cache updates must never break the main flow.
    """

    from app.services.directory_cache import get_directory_cache_manager

    try:
        cache_manager = get_directory_cache_manager()
        cache = cache_manager.get_cache(connection_id)
        if cache is None:
            return

        cache.add_directories([path])
    except Exception:
        pass
