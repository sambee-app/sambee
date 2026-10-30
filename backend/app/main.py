import asyncio
import logging
import sys
import threading
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime
from os import PathLike
from os import stat_result as os_stat_result
from pathlib import Path
from time import monotonic
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlmodel import Session, select
from starlette.types import Scope

from app import __version__
from app.api import (
    admin,
    admin_auth,
    archive_operations,
    auth,
    browser,
    companion,
    connections,
    logs,
    system_settings,
    themes,
    viewer,
    websocket,
)
from app.api.archive_v2_errors import archive_v2_http_exception_handler, archive_v2_request_validation_exception_handler
from app.core.config import consume_unsupported_config_settings, settings
from app.core.environment import DEV_CORS_ORIGINS, IS_DEVELOPMENT, IS_PRODUCTION
from app.core.exceptions import ConfigurationError, SambeeError
from app.core.logging import SensitiveDataLogFilter, configure_uvicorn_loggers, log_error, set_request_id
from app.core.secrets import generate_admin_password
from app.core.security import get_password_hash
from app.db.database import DATABASE_FILE_PATH, engine, init_db
from app.middleware.authentication import PasswordFormBodyLimitMiddleware
from app.models.oidc import OidcProviderConfiguration
from app.models.user import User, UserRole
from app.services.system_settings import store as system_settings_store
from app.storage.smb_pool import shutdown_connection_pool

#
# Logging
#

# Log targets:
# Always log to stdout (for Docker/container logging)
handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
if IS_DEVELOPMENT:
    # In development, also log to file for easier debugging
    handlers.append(logging.FileHandler("/tmp/backend.log", mode="a"))

for handler in handlers:
    handler.addFilter(SensitiveDataLogFilter())

# Configure logging (no timestamp - Docker adds them automatically)
log_format = "%(name)s - %(levelname)s - %(message)s"


def bootstrap_admin_if_pristine(session: Session) -> tuple[User | None, str | None]:
    existing_user_id = session.exec(select(User.id).limit(1)).first()
    existing_auth_configuration = session.get(OidcProviderConfiguration, 1)
    if existing_user_id is not None or existing_auth_configuration is not None:
        return None, None

    admin_password = generate_admin_password(IS_PRODUCTION)
    admin = User(
        username=settings.admin_username,
        password_hash=get_password_hash(admin_password),
        role=UserRole.ADMIN,
    )
    session.add(admin)
    session.commit()
    return admin, admin_password


# Convert log level string (e.g., "INFO") to Python logging constant (e.g., logging.INFO = 20)
# This allows config.toml to use human-readable strings like "DEBUG" or "ERROR"
log_level = getattr(logging, settings.log_level)
logging.basicConfig(level=log_level, format=log_format, handlers=handlers)

configure_uvicorn_loggers(
    handlers=handlers,
    log_format=log_format,
    application_log_level=log_level,
    access_log_level=getattr(logging, settings.access_log_level),
    protocol_log_level=getattr(logging, settings.protocol_log_level),
)

# Reduce noise from third-party libraries (only show warnings/errors)
logging.getLogger("smbprotocol").setLevel(logging.WARNING)
logging.getLogger("sqlalchemy.engine.Engine").setLevel(logging.WARNING)
logging.getLogger("pyvips").setLevel(logging.WARNING)

# Logger for this module
logger = logging.getLogger(__name__)

SPA_DOCUMENT_CACHE_CONTROL = "no-store"
REVALIDATED_STATIC_CACHE_CONTROL = "no-cache, max-age=0, must-revalidate"
IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
LEGACY_NO_CACHE_HEADER_VALUE = "no-cache"
LEGACY_EXPIRES_HEADER_VALUE = "0"
APP_ROOT = Path(__file__).resolve().parents[2]


def apply_cache_headers(response: Response, cache_control: str) -> Response:
    """Apply cache-control headers to a static response."""

    response.headers["Cache-Control"] = cache_control

    if "no-store" in cache_control or "no-cache" in cache_control:
        response.headers["Pragma"] = LEGACY_NO_CACHE_HEADER_VALUE
        response.headers["Expires"] = LEGACY_EXPIRES_HEADER_VALUE
    else:
        if "Pragma" in response.headers:
            del response.headers["Pragma"]
        if "Expires" in response.headers:
            del response.headers["Expires"]

    return response


def read_first_available_text(paths: list[Path], fallback: str = "unknown") -> str:
    """Read and return the first non-empty text value from the given paths."""

    for path in paths:
        if not path.exists():
            continue

        try:
            value = path.read_text().strip()
        except (OSError, ValueError):
            continue

        if value:
            return value

    return fallback


class CacheControlledStaticFiles(StaticFiles):
    """Static file handler that applies explicit cache headers."""

    def __init__(
        self,
        directory: str | PathLike[str] | None = None,
        packages: list[str | tuple[str, str]] | None = None,
        html: bool = False,
        check_dir: bool = True,
        follow_symlink: bool = False,
        *,
        cache_control: str,
    ) -> None:
        super().__init__(
            directory=directory,
            packages=packages,
            html=html,
            check_dir=check_dir,
            follow_symlink=follow_symlink,
        )
        self._cache_control = cache_control

    def file_response(
        self,
        full_path: str | PathLike[str],
        stat_result: os_stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        return apply_cache_headers(response, self._cache_control)


def mount_production_static_files(application: FastAPI, static_directory: Path) -> None:
    """Mount production frontend resources with their required cache policies."""

    application.mount(
        "/assets",
        CacheControlledStaticFiles(directory=static_directory / "assets", cache_control=IMMUTABLE_ASSET_CACHE_CONTROL),
        name="assets",
    )
    application.mount(
        "/icons",
        CacheControlledStaticFiles(directory=static_directory / "icons", cache_control=REVALIDATED_STATIC_CACHE_CONTROL),
        name="icons",
    )
    application.mount(
        "/pdfjs",
        CacheControlledStaticFiles(directory=static_directory / "pdfjs", cache_control=REVALIDATED_STATIC_CACHE_CONTROL),
        name="pdfjs",
    )


# ---------------------------------------------------------------------------
# Work around a known smbprotocol bug: when an SMB connection times out, the
# library's internal message-worker thread calls self.disconnect() which tries
# to join the *current* thread, raising RuntimeError("cannot join current
# thread"). Since this happens inside a daemon thread we cannot catch it
# directly — but we can suppress the noisy traceback via threading.excepthook.
# ---------------------------------------------------------------------------
_default_excepthook = threading.excepthook

SMB_WORKER_THREAD_PREFIX = "msg_worker-"


#
# _smb_threading_excepthook
#
def _smb_threading_excepthook(args: threading.ExceptHookArgs) -> None:
    """Custom threading excepthook that suppresses the known smbprotocol
    RuntimeError('cannot join current thread') from its internal worker
    threads and logs a clean warning instead."""

    thread_name = args.thread.name if args.thread else ""
    is_smb_worker = thread_name.startswith(SMB_WORKER_THREAD_PREFIX)
    is_join_error = args.exc_type is RuntimeError and args.exc_value is not None and "cannot join current thread" in str(args.exc_value)

    if is_smb_worker and is_join_error:
        # Extract the server name from the thread name (e.g. "msg_worker-fs1.ad.internal:445")
        server = thread_name[len(SMB_WORKER_THREAD_PREFIX) :]
        logger.warning(f"SMB connection timed out for {server} — the watcher will reconnect automatically")
        return

    # Fall through to default handler for all other thread exceptions
    _default_excepthook(args)


threading.excepthook = _smb_threading_excepthook

# Log startup info (skip during tests to reduce noise)
if "pytest" not in sys.modules:
    # Read build metadata if available
    build_time = "unknown"
    build_time_file = Path("/BUILD_TIME")
    if build_time_file.exists():
        try:
            build_time = build_time_file.read_text().strip()
        except (OSError, ValueError):
            pass

    git_commit = "unknown"
    git_commit_file = Path("/GIT_COMMIT")
    if git_commit_file.exists():
        try:
            git_commit = git_commit_file.read_text().strip()
        except (OSError, ValueError):
            pass

    logger.info("=" * 80)
    logger.info("Sambee Backend Starting")
    logger.info(f"Version: {__version__} (commit: {git_commit})")
    logger.info(f"Built: {build_time}")
    logger.info(f"Environment: {'PRODUCTION' if IS_PRODUCTION else 'DEVELOPMENT'}")
    logger.info(f"Python: {sys.version}")
    logger.info(f"Working Directory: {Path.cwd()}")
    logger.info("=" * 80)


#
# lifespan
#
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Initialize application on startup"""

    try:
        unsupported_settings = consume_unsupported_config_settings()
        if unsupported_settings is not None:
            config_file, ignored_paths = unsupported_settings
            logger.warning("Ignoring unsupported configuration settings in '%s': %s", config_file, ", ".join(ignored_paths))

        logger.info("Starting Sambee application...")
        if settings.disable_auth_enforcement:
            logger.warning(
                "Authentication enforcement is disabled by configuration; all requests are treated as the configured administrator"
            )

        # Initialize database
        logger.info(f"Initializing database: {DATABASE_FILE_PATH.absolute()}")
        init_db()
        logger.info("Database initialized")
        system_settings_store.warm_cache()
        logger.info("System settings cache warmed")

        from app.services.archive.temporary_download import cleanup_stale_artifacts

        await asyncio.to_thread(cleanup_stale_artifacts)

        logger.info("Checking first-run administrator bootstrap state...")
        with Session(engine) as session:
            admin, admin_password = bootstrap_admin_if_pristine(session)
            if admin is not None and admin_password is not None:
                if IS_PRODUCTION:
                    logger.warning("=" * 80)
                    logger.warning("FIRST-TIME SETUP - SAVE THESE CREDENTIALS")
                    logger.warning(f"   Username: {settings.admin_username}")
                    logger.warning(f"   Password: {admin_password}")
                    logger.warning("   Change password immediately after first login!")
                    logger.warning("   Credentials will not be displayed again.")
                    logger.warning("=" * 80)
                else:
                    logger.info(f"Created admin user: {settings.admin_username} / {admin_password}")
            else:
                logger.info("Database already initialized; administrator bootstrap skipped")

        logger.info("Sambee application startup complete!")

        # Start background lock monitor for orphaned edit locks
        from app.services.lock_manager import start_lock_monitor

        start_lock_monitor()
        logger.info("Lock monitor started")

        from app.services.archive.operation_monitor import start_archive_operation_monitor

        start_archive_operation_monitor()
        logger.info("Archive operation monitor started")

    except ConfigurationError as e:
        log_error(logger, f"Configuration error: {e}")
        log_error(logger, "Application startup failed. Exiting.")
        sys.exit(1)
    except Exception as e:
        log_error(logger, f"Startup failed: {e}")
        log_error(logger, "Application startup failed. Exiting.")
        sys.exit(1)

    yield

    # Shutdown
    logger.info("Shutting down Sambee application...")

    # Stop lock monitor background task
    try:
        from app.services.lock_manager import stop_lock_monitor

        logger.info("Stopping lock monitor...")
        stop_lock_monitor()
        logger.info("Lock monitor stopped")
    except Exception as e:
        log_error(logger, f"Error stopping lock monitor: {e}")

    try:
        from app.services.archive.operation_monitor import stop_archive_operation_monitor

        logger.info("Stopping archive operation monitor...")
        stop_archive_operation_monitor()
        logger.info("Archive operation monitor stopped")
    except Exception as e:
        log_error(logger, f"Error stopping archive operation monitor: {e}")

    # Stop directory caches (CHANGE_NOTIFY watchers + rescan tasks)
    try:
        from app.services.directory_cache import shutdown_directory_cache

        logger.info("Stopping directory caches...")
        shutdown_directory_cache()
        logger.info("Directory caches stopped")
    except Exception as e:
        log_error(logger, f"Error stopping directory caches: {e}")

    # Close all SMB connection pool connections
    logger.info("Stopping live archive creation writers...")
    await archive_operations.shutdown_local_to_smb_creation_writers()
    logger.info("Live archive creation writers stopped")

    logger.info("Stopping live archive extraction sessions...")
    await archive_operations.shutdown_live_extraction_sessions()
    logger.info("Live archive extraction sessions stopped")

    logger.info("Closing SMB connection pool...")
    await shutdown_connection_pool()
    logger.info("SMB connection pool closed")

    logger.info("Sambee application shutdown complete")

    # Stop all directory monitors and clean up SMB handles
    try:
        from app.services.directory_monitor import shutdown_monitor

        logger.info("Stopping directory monitors...")
        shutdown_monitor()
        logger.info("Directory monitors stopped")
    except Exception as e:
        log_error(logger, f"Error stopping directory monitors: {e}")

    logger.info(f"Shutdown complete - {datetime.now().isoformat()}")


# FastAPI application instance
app = FastAPI(
    title="Sambee",
    description="Modern SMB share file browser",
    version=__version__,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(PasswordFormBodyLimitMiddleware)
app.add_exception_handler(HTTPException, archive_v2_http_exception_handler)
app.add_exception_handler(RequestValidationError, archive_v2_request_validation_exception_handler)


#
# sambee_error_handler
#
@app.exception_handler(SambeeError)
async def sambee_error_handler(request: Request, exc: SambeeError) -> JSONResponse:
    """Handle SambeeError exceptions with clean error messages."""

    log_error(logger, f"Error handling request: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
    )


#
# log_requests
#
@app.middleware("http")
async def log_requests(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
    """Log all HTTP requests with request ID and user context"""

    start_time = monotonic()

    # Set request ID for this request context
    request_id = set_request_id()

    # Extract filename from query params for viewer/download endpoints
    path_suffix = ""
    if request.url.path.startswith("/api/viewer/") or request.url.path.startswith("/api/browse/"):
        file_path = request.query_params.get("path")
        if file_path:
            from pathlib import PurePosixPath

            filename = PurePosixPath(file_path).name
            path_suffix = f" ({filename})"

    try:
        response = await call_next(request)

        # Add request ID to response headers for client-side correlation
        response.headers["X-Request-ID"] = request_id

        return response
    except Exception as e:
        duration = (monotonic() - start_time) * 1000
        logger.error(
            f"❌ {request.method} {request.url.path} failed after {duration:.0f}ms: {e}{path_suffix}",
            exc_info=True,
        )
        raise


# CORS configuration - only needed in development when frontend runs on separate server
# Production: frontend served from same origin (no CORS needed)
if IS_DEVELOPMENT:
    logger.info(f"CORS enabled for development: {DEV_CORS_ORIGINS}")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=DEV_CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    logger.info("CORS disabled (production mode - frontend served from same origin)")

# Include routers
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(themes.router, prefix="/api/themes", tags=["themes"])
app.include_router(connections.router, prefix="/api", tags=["connections"])
app.include_router(admin.router, prefix="/api/admin", tags=["admin"])
app.include_router(admin_auth.router, prefix="/api/admin", tags=["admin-auth"])
app.include_router(system_settings.router, prefix="/api/admin", tags=["admin-settings"])
app.include_router(browser.router, prefix="/api/browse", tags=["browse"])
app.include_router(viewer.router, prefix="/api/viewer", tags=["viewer"])
app.include_router(archive_operations.v2_router, prefix="/api/archive", tags=["archive"])
app.include_router(companion.router, prefix="/api/companion", tags=["companion"])
app.include_router(logs.router, prefix="/api/logs", tags=["logs"])
app.include_router(websocket.router, prefix="/api", tags=["websocket"])


#
# health_check
#
@app.get("/api/health")
async def health_check() -> dict[str, str]:
    """Health check endpoint"""

    return {"status": "healthy"}


#
# version_info
#
@app.get("/api/version")
async def version_info() -> dict[str, str]:
    """Return version and build information"""

    build_time = read_first_available_text([Path("/BUILD_TIME")])
    git_commit = read_first_available_text([Path("/GIT_COMMIT"), APP_ROOT / "GIT_COMMIT"])

    return {
        "version": __version__,
        "build_time": build_time,
        "git_commit": git_commit,
    }


# Serve static files in production
static_path = Path("/app/static")
if static_path.exists():
    mount_production_static_files(app, static_path)

    #
    # serve_spa
    #
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str) -> Response:
        """Serve React SPA for all non-API routes"""

        # Serve manifest.json and other root-level files
        if full_path in ["manifest.json", "robots.txt"]:
            file_path = static_path / full_path
            if file_path.exists():
                return apply_cache_headers(FileResponse(file_path), REVALIDATED_STATIC_CACHE_CONTROL)

        # Only serve for non-API routes (API routes are registered with higher priority)
        return apply_cache_headers(FileResponse(static_path / "index.html"), SPA_DOCUMENT_CACHE_CONTROL)
