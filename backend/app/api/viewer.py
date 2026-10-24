import asyncio
import hashlib
import secrets
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime, timedelta, timezone
from functools import partial
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import delete
from sqlmodel import Session, col, select

from app.api._smb_helpers import build_smb_backend, disconnect_backend_safely
from app.api.companion import (
    COMPANION_ERROR_LOCK_LOST,
    _get_current_companion_operation_user,
    _raise_companion_operation_error,
    _validate_operation_lock_scope,
)
from app.core.logging import get_logger, set_user
from app.core.security import get_current_user_for_token, get_current_user_with_auth_check, oauth2_scheme_optional
from app.core.system_setting_definitions import SystemSettingKey
from app.db.database import get_session
from app.models.connection import Connection
from app.models.download_intent import DownloadIntent
from app.models.edit_lock import HEARTBEAT_TIMEOUT_SECONDS, EditLock
from app.models.file import FileInfo, FileType
from app.models.user import User
from app.services.archive.coordinator import (
    ArchiveMemberReadPresentation,
    SmbArchiveInspectionSource,
)
from app.services.archive.execution import ArchiveExecutionDriver, resolve_archive_inspection_topology_plan
from app.services.archive.zip_reader import ArchiveFormatError, ArchiveInspectionManifestMember, ZipEntry, ZipReader
from app.services.connection_access import get_accessible_connection_or_404
from app.services.image_converter import convert_image_for_viewer
from app.services.pdf_derivative_cache import PDFDerivativeCachePolicy, PDFSourceRevision, pdf_derivative_cache
from app.services.pdf_inspector import PDFScreenProfile, analyze_pdf_for_screen
from app.services.pdf_normalizer import (
    PDFNormalizationError,
    PDFNormalizationLimits,
    is_pdf_normalization_available,
    needs_pdf_normalization,
    normalize_pdf_with_queue,
)
from app.services.preprocessor import PreprocessorFileTooLargeError
from app.services.system_settings import get_integer_setting_value
from app.storage.smb import SMBBackend
from app.utils.content_disposition import build_content_disposition, is_active_document_mime_type
from app.utils.file_type_registry import needs_processing

router = APIRouter()
logger = get_logger(__name__)
DOWNLOAD_INTENT_TTL = timedelta(seconds=90)


class DownloadIntentRequest(BaseModel):
    connection_id: uuid.UUID
    path: str
    member_path: str | None = None


class DownloadIntentResponse(BaseModel):
    url: str


@router.post("/download-intents", response_model=DownloadIntentResponse)
async def create_download_intent(
    body: DownloadIntentRequest,
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> DownloadIntentResponse:
    """Authorize one browser-native download without exposing the bearer token."""
    if not body.path or body.member_path == "":
        raise HTTPException(status_code=422, detail="A file path and nonempty member path are required")
    connection = get_accessible_connection_or_404(session, current_user, body.connection_id)
    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    reader = None
    try:
        await backend.connect()
        file_info = await backend.get_file_info(body.path)
        if file_info.type != FileType.FILE:
            raise HTTPException(status_code=422, detail="Download source must be a regular file")
        if body.member_path is not None:
            if file_info.size is None:
                raise HTTPException(status_code=422, detail="Archive size is unavailable")
            reader = await backend.open_random_access_reader(body.path)
            await ZipReader(reader, file_info.size).validate_member_in_record_order(body.member_path)
    except (ArchiveFormatError, FileNotFoundError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    finally:
        if reader is not None:
            await reader.close()
        await disconnect_backend_safely(backend, logger=logger, context="download intent preparation")
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    session.exec(delete(DownloadIntent).where(col(DownloadIntent.expires_at) < now))
    session.add(
        DownloadIntent(
            token_hash=hashlib.sha256(token.encode()).hexdigest(),
            user_id=current_user.id,
            token_version=current_user.token_version,
            connection_id=body.connection_id,
            path=body.path,
            member_path=body.member_path,
            expires_at=now + DOWNLOAD_INTENT_TTL,
        )
    )
    session.commit()
    return DownloadIntentResponse(url=f"/api/viewer/download-intents/{token}")


@router.get("/download-intents/{token}", response_model=None)
async def redeem_download_intent(token: str, session: Session = Depends(get_session)) -> Response | StreamingResponse:
    """Atomically consume a scoped capability before opening its source stream."""
    intent = session.execute(
        delete(DownloadIntent)
        .where(col(DownloadIntent.token_hash) == hashlib.sha256(token.encode()).hexdigest())
        .returning(
            col(DownloadIntent.expires_at),
            col(DownloadIntent.user_id),
            col(DownloadIntent.token_version),
            col(DownloadIntent.connection_id),
            col(DownloadIntent.path),
            col(DownloadIntent.member_path),
        )
    ).one_or_none()
    session.commit()
    if intent is None or intent.expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        raise HTTPException(status_code=404, detail="Download expired or unavailable")
    current_user = session.get(User, intent.user_id)
    if current_user is None or not current_user.is_active or current_user.token_version != intent.token_version:
        raise HTTPException(status_code=404, detail="Download expired or unavailable")
    get_accessible_connection_or_404(session, current_user, intent.connection_id)
    if intent.member_path is None:
        response: Response | StreamingResponse = await _stream_download_file(intent.connection_id, intent.path, current_user, session)
    else:
        response = await stream_archive_member(
            intent.connection_id,
            intent.path,
            intent.member_path,
            True,
            "raw",
            "original",
            None,
            None,
            False,
            None,
            None,
            200,
            current_user,
            session,
        )
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


def _inspection_member(entry: ZipEntry) -> ArchiveInspectionManifestMember:
    """Map one record-order entry to existing viewer presentation metadata."""

    return ArchiveInspectionManifestMember(
        path=entry.path,
        is_directory=entry.is_directory,
        compressed_size=entry.compressed_size,
        uncompressed_size=entry.uncompressed_size,
        compression_method=entry.compression_method,
        crc32=entry.crc32,
        modified_at=entry.modified_at,
        encrypted=entry.encrypted,
        is_safe=entry.is_safe,
        has_supported_file_type=entry.has_supported_file_type,
    )


def archive_member_pdf_revision(
    archive_path: str, member_path: str, archive_info: FileInfo, member: ZipEntry, content_digest: str | None = None
) -> PDFSourceRevision:
    """Build a cache identity that changes when either the archive or member changes."""

    return PDFSourceRevision(
        path=f"zip:{archive_path}!{member_path}",
        size=member.uncompressed_size,
        modified_at=archive_info.modified_at.isoformat() if archive_info.modified_at else None,
        created_at=archive_info.created_at.isoformat() if archive_info.created_at else None,
        stable_id=f"{archive_info.stable_id or ''}:{member.crc32}:{member.compressed_size}:{member.local_header_offset}",
        content_digest=content_digest,
    )


@router.get("/{connection_id}/archive/member", response_model=None)
async def stream_archive_member(
    connection_id: uuid.UUID,
    archive_path: str = Query(..., min_length=1, description="Path to the ZIP archive"),
    member_path: str = Query(..., min_length=1, description="Virtual archive member path"),
    download: bool = Query(False, description="Return an attachment instead of inline content"),
    view_kind: Literal["raw", "text", "image", "pdf"] = Query("raw", description="Viewer content purpose"),
    pdf_variant: Literal["original", "normalized"] = Query("original", description="PDF viewer source variant"),
    viewport_width: int | None = Query(None, description="Viewport width in pixels (including DPR)"),
    viewport_height: int | None = Query(None, description="Viewport height in pixels (including DPR)"),
    no_resizing: bool = Query(False, description="Return original image dimensions"),
    screen_width: int | None = Query(None, ge=320, le=16384, description="Physical display width in pixels"),
    screen_height: int | None = Query(None, ge=320, le=16384, description="Physical display height in pixels"),
    screen_zoom_percent: int = Query(200, ge=100, le=400, description="Maximum requested viewing zoom"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> Response | StreamingResponse:
    """Open one validated archive member using the requested viewer semantics."""

    connection = get_accessible_connection_or_404(session, current_user, connection_id)
    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    reader = None
    try:
        await backend.connect()
        archive_info = await backend.get_file_info(archive_path)
        if archive_info.type != FileType.FILE or archive_info.size is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Archive path must identify a regular file")
        reader = await backend.open_random_access_reader(archive_path)
        source = SmbArchiveInspectionSource(ZipReader(reader, archive_info.size))
        topology = resolve_archive_inspection_topology_plan(source_connection_id=str(connection_id))
        if topology.driver != ArchiveExecutionDriver.BACKEND:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Archive inspection requires the Companion coordinator"
            )
        presentation = ArchiveMemberReadPresentation(
            member_path=member_path,
            download=download,
            view_kind=view_kind,
            pdf_variant=pdf_variant,
            viewport_width=viewport_width,
            viewport_height=viewport_height,
            no_resizing=no_resizing,
            screen_width=screen_width,
            screen_height=screen_height,
            screen_zoom_percent=screen_zoom_percent,
        )
        validated_member = await source.validate_member_in_record_order(member_path)
        member = validated_member.entry
        inspection_member = _inspection_member(member)
        inspection_projection = presentation.project_member(inspection_member)
        if inspection_projection.delivery == "preview_unavailable":
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Archive member exceeds the inline preview size limit"
            )
        member_name = inspection_member.path.rsplit("/", 1)[-1]

        async def read_member_source() -> tuple[bytes, PDFSourceRevision]:
            chunks: list[bytes] = []
            async for chunk in source.stream_validated_member(validated_member):
                chunks.append(chunk)
            refreshed_archive = await backend.get_file_info(archive_path)
            if (
                refreshed_archive.size != archive_info.size
                or refreshed_archive.modified_at != archive_info.modified_at
                or refreshed_archive.created_at != archive_info.created_at
                or refreshed_archive.stable_id != archive_info.stable_id
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="The archive changed while compatibility processing was being prepared. Try again.",
                )
            member_bytes = b"".join(chunks)
            return member_bytes, archive_member_pdf_revision(
                archive_path, member_path, archive_info, member, hashlib.sha256(member_bytes).hexdigest()
            )

        metadata_revision = archive_member_pdf_revision(archive_path, member_path, archive_info, member)

        if inspection_projection.delivery == "image":
            try:
                image_bytes, _ = await read_member_source()
                return await create_converted_image_response(
                    image_bytes=image_bytes,
                    filename=member_name,
                    max_width=inspection_projection.viewport_width,
                    max_height=inspection_projection.viewport_height,
                    no_resizing=inspection_projection.no_resizing,
                )
            finally:
                await reader.close()
                reader = None
                await disconnect_backend_safely(backend, logger=logger, context=f"archive image view: {archive_path!r}")

        if inspection_projection.delivery == "normalized_pdf":
            try:
                return await create_normalized_pdf_response_for_source(
                    filename=member_name,
                    metadata_revision=metadata_revision,
                    connection_id=connection_id,
                    user_id=current_user.id,
                    screen_profile=(
                        PDFScreenProfile(
                            inspection_projection.screen_width,
                            inspection_projection.screen_height,
                            inspection_projection.screen_zoom_percent,
                        )
                        if inspection_projection.screen_width is not None and inspection_projection.screen_height is not None
                        else None
                    ),
                    read_source=read_member_source,
                )
            finally:
                await reader.close()
                reader = None
                await disconnect_backend_safely(backend, logger=logger, context=f"archive PDF derivative: {archive_path!r}")

        async def stream_member() -> AsyncIterator[bytes]:
            try:
                async for chunk in source.stream_validated_member(validated_member):
                    yield chunk
            finally:
                await reader.close()
                await disconnect_backend_safely(
                    backend,
                    logger=logger,
                    context=f"archive member stream: connection_id={connection_id}, archive_path={archive_path!r}",
                )

        return StreamingResponse(
            stream_member(),
            media_type=inspection_projection.content_type,
            headers={
                "Content-Disposition": (
                    build_content_disposition("attachment", member_name)
                    if is_active_document_mime_type(inspection_projection.content_type)
                    else inspection_projection.content_disposition
                ),
                "X-Content-Type-Options": "nosniff",
            },
        )
    except ArchiveFormatError as exc:
        if reader is not None:
            await reader.close()
        await disconnect_backend_safely(backend, logger=logger, context=f"invalid archive member request: {archive_path!r}")
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail={"code": "invalid_zip", "message": str(exc)}) from exc
    except Exception:
        if reader is not None:
            await reader.close()
        await disconnect_backend_safely(backend, logger=logger, context=f"failed archive member request: {archive_path!r}")
        raise


@router.delete("/{connection_id}/archive/member/pdf-derivative", status_code=status.HTTP_204_NO_CONTENT)
async def invalidate_archive_member_pdf_derivative(
    connection_id: uuid.UUID,
    archive_path: str = Query(..., min_length=1, description="Path to the ZIP archive"),
    member_path: str = Query(..., min_length=1, description="Virtual archive member path"),
    screen_width: int | None = Query(None, ge=320, le=16384),
    screen_height: int | None = Query(None, ge=320, le=16384),
    screen_zoom_percent: int = Query(200, ge=100, le=400),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> Response:
    """Discard the current user's PDF derivative for one ZIP member."""

    connection = get_accessible_connection_or_404(session, current_user, connection_id)
    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    reader = None
    try:
        await backend.connect()
        archive_info = await backend.get_file_info(archive_path)
        if archive_info.type != FileType.FILE or archive_info.size is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Archive path must identify a regular file")
        reader = await backend.open_random_access_reader(archive_path)
        topology = resolve_archive_inspection_topology_plan(source_connection_id=str(connection_id))
        source = SmbArchiveInspectionSource(ZipReader(reader, archive_info.size))
        if topology.driver != ArchiveExecutionDriver.BACKEND:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Archive inspection requires the Companion coordinator"
            )
        member = (await source.validate_member_in_record_order(member_path)).entry
        member_name = member_path.replace("\\", "/").rsplit("/", 1)[-1]
        if not needs_pdf_normalization(member_name):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="PDF derivative invalidation requires a PDF file")
        await invalidate_pdf_derivative_for_revision(
            connection_id=connection_id,
            user_id=current_user.id,
            revision=archive_member_pdf_revision(archive_path, member_path, archive_info, member),
            screen_profile=(
                PDFScreenProfile(screen_width, screen_height, screen_zoom_percent)
                if screen_width is not None and screen_height is not None
                else None
            ),
        )
    except ArchiveFormatError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail={"code": "invalid_zip", "message": str(exc)}) from exc
    finally:
        if reader is not None:
            await reader.close()
        await disconnect_backend_safely(backend, logger=logger, context=f"archive PDF derivative invalidation: {archive_path!r}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _get_active_lock(connection_id: uuid.UUID, path: str, session: Session) -> EditLock | None:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)
    statement = (
        select(EditLock)
        .where(EditLock.connection_id == connection_id)
        .where(EditLock.file_path == path)
        .where(EditLock.last_heartbeat >= cutoff)
    )
    return session.exec(statement).first()


#
# create_file_streamer
#
def create_file_streamer(backend: SMBBackend, path: str) -> AsyncIterator[bytes]:
    """Create an async generator that streams file contents from SMB backend

    Handles error cases during streaming and ensures backend disconnection.
    """

    async def file_streamer() -> AsyncIterator[bytes]:
        try:
            async for chunk in backend.read_file(path):
                yield chunk
        except TimeoutError as e:
            logger.error(f"Timeout reading file during streaming: {path} - {e}")
            # Can't raise HTTPException mid-stream, connection will be closed
            # Client will see incomplete response
            raise
        except FileNotFoundError as e:
            logger.warning(f"File not found during streaming: {path} - {e}")
            # Can't raise HTTPException mid-stream, connection will be closed
            # Client will see incomplete response
            raise
        except IOError as e:
            logger.warning(f"File access error during streaming: {path} - {e}")
            # Can't raise HTTPException mid-stream, connection will be closed
            raise
        finally:
            await disconnect_backend_safely(backend, logger=logger, context=f"streaming '{path}'")

    return file_streamer()


async def read_pdf_derivative_source(
    backend: SMBBackend,
    path: str,
    initial_size: int | None,
    initial_modified_at: datetime | None,
    initial_created_at: datetime | None,
    initial_stable_id: str | None,
) -> tuple[bytes, PDFSourceRevision]:
    """Read one PDF snapshot and reject it when SMB metadata changes mid-read."""

    chunks: list[bytes] = []
    async for chunk in backend.read_file(path):
        chunks.append(chunk)
    refreshed_info = await backend.get_file_info(path)

    if (
        refreshed_info.size != initial_size
        or refreshed_info.modified_at != initial_modified_at
        or refreshed_info.created_at != initial_created_at
        or refreshed_info.stable_id != initial_stable_id
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The PDF changed while compatibility processing was being prepared. Try again.",
        )
    pdf_bytes = b"".join(chunks)
    return pdf_bytes, PDFSourceRevision(
        path=path,
        size=initial_size,
        modified_at=initial_modified_at.isoformat() if initial_modified_at else None,
        created_at=initial_created_at.isoformat() if initial_created_at else None,
        stable_id=initial_stable_id,
        content_digest=hashlib.sha256(pdf_bytes).hexdigest(),
    )


async def create_normalized_pdf_response(
    *,
    backend: SMBBackend,
    path: str,
    filename: str,
    initial_size: int | None,
    initial_modified_at: datetime | None,
    initial_created_at: datetime | None,
    initial_stable_id: str | None,
    connection_id: uuid.UUID,
    user_id: uuid.UUID,
    screen_profile: PDFScreenProfile | None,
) -> Response:
    """Return an explicitly requested cached compatibility derivative."""

    metadata_revision = PDFSourceRevision(
        path=path,
        size=initial_size,
        modified_at=initial_modified_at.isoformat() if initial_modified_at else None,
        created_at=initial_created_at.isoformat() if initial_created_at else None,
        stable_id=initial_stable_id,
    )
    try:
        return await create_normalized_pdf_response_for_source(
            filename=filename,
            metadata_revision=metadata_revision,
            connection_id=connection_id,
            user_id=user_id,
            screen_profile=screen_profile,
            read_source=lambda: read_pdf_derivative_source(
                backend, path, initial_size, initial_modified_at, initial_created_at, initial_stable_id
            ),
        )
    finally:
        await disconnect_backend_safely(backend, logger=logger, context=f"PDF derivative for '{path}'")


async def create_normalized_pdf_response_for_source(
    *,
    filename: str,
    metadata_revision: PDFSourceRevision,
    connection_id: uuid.UUID,
    user_id: uuid.UUID,
    screen_profile: PDFScreenProfile | None,
    read_source: Callable[[], Awaitable[tuple[bytes, PDFSourceRevision]]],
) -> Response:
    """Normalize a revisioned PDF source, regardless of its backing provider."""

    if not is_pdf_normalization_available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="PDF compatibility processing is unavailable")

    max_source_size = get_integer_setting_value(SystemSettingKey.PDF_NORMALIZER_MAX_SOURCE_SIZE_BYTES)
    if metadata_revision.size is not None and metadata_revision.size > max_source_size:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="This PDF exceeds the configured compatibility-processing size limit.",
        )

    policy = PDFDerivativeCachePolicy(
        quota_bytes=get_integer_setting_value(SystemSettingKey.PDF_VIEWER_CACHE_QUOTA_BYTES),
        inactivity_ttl_seconds=get_integer_setting_value(SystemSettingKey.PDF_VIEWER_CACHE_INACTIVITY_TTL_SECONDS),
    )
    limits = PDFNormalizationLimits(
        timeout_seconds=get_integer_setting_value(SystemSettingKey.PDF_NORMALIZER_TIMEOUT_SECONDS),
        cpu_time_seconds=get_integer_setting_value(SystemSettingKey.PDF_NORMALIZER_CPU_TIME_SECONDS),
        address_space_bytes=get_integer_setting_value(SystemSettingKey.PDF_NORMALIZER_ADDRESS_SPACE_BYTES),
        output_size_bytes=get_integer_setting_value(SystemSettingKey.PDF_NORMALIZER_MAX_OUTPUT_SIZE_BYTES),
        temporary_disk_bytes=get_integer_setting_value(SystemSettingKey.PDF_NORMALIZER_TEMPORARY_DISK_BYTES),
    )
    loop = asyncio.get_running_loop()
    screen_enabled = get_integer_setting_value(SystemSettingKey.PDF_SCREEN_DERIVATIVE_ENABLED) == 1
    screen_variant = f"screen-{screen_profile.cache_suffix()}" if screen_enabled and screen_profile else None
    # With a screen profile, a normalized cache entry cannot establish the
    # variant selection. Inspect after a screen-cache miss so oversized PDFs
    # always use their profile-specific derivative.
    cached_variants = (screen_variant,) if screen_variant else ("normalized",)
    for cached_variant in cached_variants:
        cached_derivative = await loop.run_in_executor(
            None,
            partial(
                pdf_derivative_cache.get,
                user_id=str(user_id),
                connection_id=str(connection_id),
                revision=metadata_revision,
                variant=cached_variant,
                policy=policy,
            ),
        )
        if cached_derivative is None:
            continue
        logger.info(
            "pdf_derivative outcome=cache_hit connection_id=%s path=%r variant=%s derivative_bytes=%d",
            connection_id,
            metadata_revision.path,
            cached_variant,
            len(cached_derivative),
        )
        return Response(
            content=cached_derivative,
            media_type="application/pdf",
            headers={
                "Content-Disposition": build_content_disposition("inline", filename),
                "X-PDF-Variant": cached_variant,
                "X-PDF-Derivative-Cache": "hit",
                "Cache-Control": "private, no-store",
            },
        )

    pdf_bytes, revision = await read_source()
    if len(pdf_bytes) > max_source_size:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="This PDF exceeds the configured compatibility-processing size limit.",
        )

    selected_variant = "normalized"
    screen_resolution_dpi: int | None = None
    if screen_variant and screen_profile:
        analysis = await loop.run_in_executor(
            None,
            partial(
                analyze_pdf_for_screen,
                pdf_bytes,
                screen_profile,
                get_integer_setting_value(SystemSettingKey.PDF_SCREEN_MAX_DECODED_PIXELS),
            ),
        )
        logger.info(
            "pdf_derivative outcome=screen_analysis connection_id=%s path=%r oversized=%s max_image_pixels=%d max_required_pixels=%d",
            connection_id,
            revision.path,
            analysis.is_oversized,
            analysis.maximum_image_pixels,
            analysis.maximum_required_pixels,
        )
        if analysis.is_oversized and analysis.screen_resolution_dpi > 0:
            selected_variant = screen_variant
            screen_resolution_dpi = analysis.screen_resolution_dpi

    try:
        derivative, cache_hit = await loop.run_in_executor(
            None,
            partial(
                pdf_derivative_cache.get_or_create,
                user_id=str(user_id),
                connection_id=str(connection_id),
                revision=revision,
                variant=selected_variant,
                policy=policy,
                create=lambda: normalize_pdf_with_queue(
                    pdf_bytes,
                    filename,
                    limits,
                    maximum_concurrent=get_integer_setting_value(SystemSettingKey.PDF_NORMALIZER_MAX_CONCURRENT),
                    queue_wait_seconds=get_integer_setting_value(SystemSettingKey.PDF_NORMALIZER_QUEUE_WAIT_SECONDS),
                    screen_resolution_dpi=screen_resolution_dpi,
                ),
            ),
        )
    except PDFNormalizationError as exc:
        logger.warning(
            "pdf_derivative outcome=failed connection_id=%s path=%r variant=%s code=%s",
            connection_id,
            revision.path,
            selected_variant,
            exc.code,
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="PDF compatibility processing could not make this file viewable.",
        ) from exc

    logger.info(
        "pdf_derivative outcome=%s connection_id=%s path=%r variant=%s derivative_bytes=%d",
        "cache_hit" if cache_hit else "created",
        connection_id,
        revision.path,
        selected_variant,
        len(derivative),
    )
    return Response(
        content=derivative,
        media_type="application/pdf",
        headers={
            "Content-Disposition": build_content_disposition("inline", filename),
            "X-PDF-Variant": selected_variant,
            "X-PDF-Derivative-Cache": "hit" if cache_hit else "miss",
            "Cache-Control": "private, no-store",
        },
    )


async def invalidate_pdf_derivative_for_revision(
    *,
    connection_id: uuid.UUID,
    user_id: uuid.UUID,
    revision: PDFSourceRevision,
    screen_profile: PDFScreenProfile | None,
) -> None:
    """Discard all applicable cached PDF derivatives for one resolved source revision."""

    variants = ["normalized"]
    if screen_profile is not None:
        variants.append(f"screen-{screen_profile.cache_suffix()}")
    loop = asyncio.get_running_loop()
    for variant in variants:
        await loop.run_in_executor(
            None,
            partial(
                pdf_derivative_cache.invalidate,
                user_id=str(user_id),
                connection_id=str(connection_id),
                revision=revision,
                variant=variant,
            ),
        )


@router.delete("/{connection_id}/pdf-derivative", status_code=status.HTTP_204_NO_CONTENT)
async def invalidate_pdf_derivative(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to the PDF source"),
    screen_width: int | None = Query(None, ge=320, le=16384),
    screen_height: int | None = Query(None, ge=320, le=16384),
    screen_zoom_percent: int = Query(200, ge=100, le=400),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> Response:
    """Discard the current user's compatibility derivative after PDF.js rejects it."""

    connection = get_accessible_connection_or_404(session, current_user, connection_id)
    backend = build_smb_backend(connection, backend_factory=SMBBackend)
    try:
        await backend.connect()
        file_info = await backend.get_file_info(path)
        if file_info.type == FileType.DIRECTORY or not needs_pdf_normalization(file_info.name):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="PDF derivative invalidation requires a PDF file")
        revision = PDFSourceRevision(
            path=path,
            size=file_info.size,
            modified_at=file_info.modified_at.isoformat() if file_info.modified_at else None,
            created_at=file_info.created_at.isoformat() if file_info.created_at else None,
            stable_id=file_info.stable_id,
        )
        await invalidate_pdf_derivative_for_revision(
            connection_id=connection_id,
            user_id=current_user.id,
            revision=revision,
            screen_profile=(
                PDFScreenProfile(screen_width, screen_height, screen_zoom_percent)
                if screen_width is not None and screen_height is not None
                else None
            ),
        )
    finally:
        await disconnect_backend_safely(backend, logger=logger, context=f"PDF derivative invalidation for '{path}'")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


#
# read_and_convert_image
#
async def create_converted_image_response(
    *,
    image_bytes: bytes,
    filename: str,
    max_width: int | None = None,
    max_height: int | None = None,
    no_resizing: bool = False,
) -> Response:
    """Convert already-resolved image bytes into a browser-compatible response."""

    try:
        loop = asyncio.get_running_loop()
        converted_bytes, converted_mime, converter_name, duration_ms = await loop.run_in_executor(
            None,
            partial(
                convert_image_for_viewer,
                image_bytes,
                filename,
                max_width=None if no_resizing else max_width,
                max_height=None if no_resizing else max_height,
                output_format="auto",
            ),
        )
        logger.info(
            "Image converted: %s -> %s (%d -> %d KB) via %s in %.0f ms",
            filename,
            converted_mime,
            len(image_bytes) // 1024,
            len(converted_bytes) // 1024,
            converter_name,
            duration_ms,
        )
        return Response(
            content=converted_bytes,
            media_type=converted_mime,
            headers={"Content-Disposition": build_content_disposition("inline", filename)},
        )
    except ImportError as exc:
        logger.error("Image conversion failed - missing dependency: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Image format not supported: HEIC/HEIF requires additional system libraries",
        ) from exc
    except PreprocessorFileTooLargeError as exc:
        file_size_mb = exc.file_size / (1024 * 1024)
        max_file_size_mb = exc.max_file_size / (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail={
                "code": "image_preview_too_large",
                "message": f"This image is too large to preview ({file_size_mb:.0f} MB; maximum {max_file_size_mb:.0f} MB).",
            },
        ) from exc
    except ValueError as exc:
        import re

        error_message = re.sub(r"\.(\s*\.)+", ".", re.sub(r"[ \t]+", " ", re.sub(r"\r?\n", ". ", str(exc)))).strip()
        logger.error("Image conversion failed: filename=%r error=%s", filename, error_message)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=error_message) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Unexpected error during image conversion: filename=%r error=%s: %s", filename, type(exc).__name__, exc, exc_info=True)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to process image") from exc


async def read_and_convert_image(
    backend: SMBBackend,
    path: str,
    filename: str,
    connection_id: uuid.UUID,
    max_width: int | None = None,
    max_height: int | None = None,
    no_resizing: bool = False,
) -> Response:
    """Read an image file from SMB backend and convert it to browser-compatible format

    Handles the complete workflow of:
    - Reading file chunks from SMB
    - Converting to browser-ready format (WebP/PNG/JPEG)
    - Optionally resizing based on viewport dimensions
    - Error handling for conversion failures
    """

    try:
        # Read file into memory
        chunks = []
        try:
            async for chunk in backend.read_file(path):
                chunks.append(chunk)
        finally:
            await disconnect_backend_safely(backend, logger=logger, context=f"image conversion read for '{path}'")
        image_bytes = b"".join(chunks)

        return await create_converted_image_response(
            image_bytes=image_bytes,
            filename=filename,
            max_width=max_width,
            max_height=max_height,
            no_resizing=no_resizing,
        )

    except HTTPException:
        raise
    except TimeoutError as e:
        logger.error(
            f"Timeout reading file: connection_id={connection_id}, path='{path}', error={e}",
        )
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Timeout reading file from network share",
        )
    except Exception as e:
        logger.error(
            f"Unexpected error during image conversion: connection_id={connection_id}, path='{path}', error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to process image",
        )


#
# validate_connection
#
def validate_connection(connection: Connection) -> None:
    """Validate connection has required fields"""

    if not connection.share_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Connection has no share name configured",
        )


#
# view_file
#
@router.get("/{connection_id}/file", response_model=None)
async def view_file(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to the file"),
    pdf_variant: Literal["original", "normalized"] = Query("original", description="PDF viewer source variant"),
    screen_width: int | None = Query(None, ge=320, le=16384, description="Physical display width in pixels"),
    screen_height: int | None = Query(None, ge=320, le=16384, description="Physical display height in pixels"),
    screen_zoom_percent: int = Query(200, ge=100, le=400, description="Maximum requested viewing zoom"),
    viewport_width: int | None = Query(None, description="Viewport width in pixels (including DPR)"),
    viewport_height: int | None = Query(None, description="Viewport height in pixels (including DPR)"),
    no_resizing: bool = Query(False, description="Return original image without resizing"),
    current_user: User = Depends(get_current_user_with_auth_check),
    session: Session = Depends(get_session),
) -> Response | StreamingResponse:
    """Stream file contents for viewing"""

    # Set the user for logging
    set_user(current_user.username)

    # Get the storage connection
    connection = get_accessible_connection_or_404(session, current_user, connection_id)

    # Verify the connection configuration
    if not connection.share_name:
        logger.warning(f"Connection has no share name: connection_id={connection_id}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Connection has no share name configured")

    try:
        # Create SMB backend...
        backend = build_smb_backend(connection, backend_factory=SMBBackend)
        # ...and connect
        await backend.connect()

        # Get file info and ensure path points to a file (not a directory)
        try:
            file_info = await backend.get_file_info(path)
            if file_info.type == FileType.DIRECTORY:
                await disconnect_backend_safely(backend, logger=logger, context=f"view file directory check for '{path}'")
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot view a directory")
        except HTTPException:
            raise
        except TimeoutError as e:
            await disconnect_backend_safely(backend, logger=logger, context=f"view file info timeout for '{path}'")
            logger.error(f"Timeout getting file info: connection_id={connection_id}, path='{path}', error={e}")
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail="Timeout reading file from network share",
            )
        except FileNotFoundError:
            await disconnect_backend_safely(backend, logger=logger, context=f"view file missing path '{path}'")
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")
        except Exception as e:
            await disconnect_backend_safely(backend, logger=logger, context=f"view file info failure for '{path}'")
            logger.error(f"Failed to get file info: connection_id={connection_id}, path='{path}', error={type(e).__name__}: {e}")
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")

        # Check if image needs processing for browser compatibility and viewing speed
        if needs_processing(file_info.name, file_info.size):
            size_string = f"{file_info.size / 1024:.0f} KB" if file_info.size else "unknown"
            logger.debug(f"Image requires processing: connection_id={connection_id}, path='{path}', size={size_string}")
            return await read_and_convert_image(
                backend=backend,
                path=path,
                filename=file_info.name,
                connection_id=connection_id,
                max_width=viewport_width,
                max_height=viewport_height,
                no_resizing=no_resizing,
            )

        if pdf_variant == "normalized":
            if not needs_pdf_normalization(file_info.name):
                await disconnect_backend_safely(backend, logger=logger, context=f"non-PDF derivative request for '{path}'")
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="PDF compatibility processing requires a PDF file")
            return await create_normalized_pdf_response(
                backend=backend,
                path=path,
                filename=file_info.name,
                initial_size=file_info.size,
                initial_modified_at=file_info.modified_at,
                initial_created_at=file_info.created_at,
                initial_stable_id=file_info.stable_id,
                connection_id=connection_id,
                user_id=current_user.id,
                screen_profile=(
                    PDFScreenProfile(screen_width, screen_height, screen_zoom_percent)
                    if screen_width is not None and screen_height is not None
                    else None
                ),
            )

        # Stream the file (browser-native format or non-image/non-PDF)
        logger.debug(f"Streaming file for viewing: connection_id={connection_id}, path='{path}', mime_type={file_info.mime_type}")
        return StreamingResponse(
            create_file_streamer(backend, path),
            media_type=file_info.mime_type,
            headers={
                "Content-Disposition": build_content_disposition(
                    "attachment" if is_active_document_mime_type(file_info.mime_type) else "inline", file_info.name
                ),
                "X-Content-Type-Options": "nosniff",
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Failed to view file: connection_id={connection_id}, path='{path}', "
            f"host={connection.host}, share={connection.share_name}, "
            f"error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to read file: {str(e)}",
        )


#
# download_file
#
@router.get("/{connection_id}/download")
async def download_file(
    connection_id: uuid.UUID,
    path: str = Query(..., description="Path to the file"),
    operation_id: Optional[str] = Query(None, description="Active companion operation ID"),
    lock_id: Optional[str] = Query(None, description="Active companion lock ID"),
    lock_capability: Optional[str] = Query(None, description="Active companion lock capability"),
    token: Optional[str] = Depends(oauth2_scheme_optional),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    """Download a file"""

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

    return await _stream_download_file(connection_id, path, current_user, session)


async def _stream_download_file(connection_id: uuid.UUID, path: str, current_user: User, session: Session) -> StreamingResponse:
    """Stream an authorized physical file for both bearer and intent requests."""
    set_user(current_user.username)
    logger.info(f"Download file: connection_id={connection_id}, path='{path}'")

    connection = get_accessible_connection_or_404(session, current_user, connection_id)

    if not connection.share_name:
        logger.warning(f"Connection has no share name: connection_id={connection_id}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Connection has no share name configured",
        )

    try:
        backend = build_smb_backend(connection, backend_factory=SMBBackend)

        await backend.connect()

        # Get file info
        try:
            file_info = await backend.get_file_info(path)
        except TimeoutError as e:
            await disconnect_backend_safely(backend, logger=logger, context=f"download file info timeout for '{path}'")
            logger.error(f"Timeout getting download file info: connection_id={connection_id}, path='{path}', error={e}")
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail="Timeout reading file from network share",
            )
        except FileNotFoundError:
            await disconnect_backend_safely(backend, logger=logger, context=f"download missing path '{path}'")
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"File not found: {path}")

        if file_info.type != "file":
            logger.warning(f"Path is not a file: connection_id={connection_id}, path='{path}', type={file_info.type}")
            await disconnect_backend_safely(backend, logger=logger, context=f"download directory check for '{path}'")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Path is not a file")

        # Stream the file
        headers = {"Content-Disposition": build_content_disposition("attachment", file_info.name)}
        if file_info.size:
            headers["Content-Length"] = str(file_info.size)

        logger.info(f"Streaming file for download: connection_id={connection_id}, path='{path}', size={file_info.size}")
        return StreamingResponse(
            create_file_streamer(backend, path),
            media_type="application/octet-stream",
            headers=headers,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Failed to download file: connection_id={connection_id}, path='{path}', "
            f"host={connection.host}, share={connection.share_name}, "
            f"error={type(e).__name__}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to download file: {str(e)}",
        )
