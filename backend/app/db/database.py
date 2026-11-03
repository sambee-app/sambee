import os
from typing import Any, Generator

from fastapi import Depends
from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.core.config import settings, static
from app.db.migrations import run_migrations

# Database file path
DATABASE_FILE_PATH = static.data_dir / "sambee.db"
DATABASE_URL = f"sqlite:///{DATABASE_FILE_PATH}"

# Detect if we're in a testing/CI environment
# In these environments, use StaticPool or NullPool to avoid threading issues
is_testing = os.getenv("PYTEST_CURRENT_TEST") is not None or os.getenv("GITHUB_ACTIONS") is not None

# Create engine with appropriate pooling strategy
if is_testing:
    # Use StaticPool for testing - single connection shared across all threads
    # This avoids SQLite threading issues in pytest
    engine = create_engine(
        DATABASE_URL,
        connect_args={
            "check_same_thread": False,
        },
        poolclass=StaticPool,
        echo=False,  # Disable SQL logging (use application logs instead)
    )
else:
    # Use connection pooling for production/development
    engine = create_engine(
        DATABASE_URL,
        connect_args={
            "check_same_thread": False,  # Required for FastAPI async/threading
            "timeout": 30.0,  # Wait up to 30 seconds for database locks
        },
        pool_size=20,  # Maintain 20 connections in pool
        max_overflow=40,  # Allow up to 60 total connections (20 + 40)
        pool_pre_ping=True,  # Verify connections are alive before using
        pool_recycle=3600,  # Recycle connections after 1 hour
        echo=False,  # Disable SQL logging (use application logs instead)
    )


# Enable WAL mode and other performance optimizations for SQLite
# Only in non-testing environments to avoid threading issues
#
# set_sqlite_pragma
#
@event.listens_for(Engine, "connect")
def set_sqlite_pragma(dbapi_conn: Any, connection_record: Any) -> None:
    """Configure SQLite connection for better concurrency and performance."""

    cursor = dbapi_conn.cursor()

    if not is_testing:
        # WAL mode: Allows concurrent reads while writing, and writes while reading
        # This is the single most important setting for concurrent applications
        # Disabled in testing to avoid threading issues with StaticPool
        cursor.execute("PRAGMA journal_mode=WAL")

        # NORMAL synchronous mode is safe with WAL and much faster than FULL
        cursor.execute("PRAGMA synchronous=NORMAL")

        # Busy timeout: Wait up to 30 seconds when database is locked
        # Prevents immediate SQLITE_BUSY errors during concurrent writes
        cursor.execute("PRAGMA busy_timeout=30000")

        # Cache size: ~40MB cache for better performance
        # Negative value means KB (10000 * 4KB = ~40MB)
        cursor.execute("PRAGMA cache_size=-40000")

    # Foreign keys: Always enabled for referential integrity
    cursor.execute("PRAGMA foreign_keys=ON")

    cursor.close()


#
# init_db
#
def init_db() -> None:
    """Initialize database tables and load application secrets"""

    # Import here to avoid circular dependency
    from app.core.secrets import get_or_create_app_secrets
    from app.models.app_secret import AppSecret  # noqa: F401 - Required for table creation
    from app.models.archive_operation import ArchiveOperation  # noqa: F401 - Required for table creation
    from app.models.audit import AuditEvent  # noqa: F401 - Required for table creation
    from app.models.companion_uri_token_jti import CompanionDirectoryPolicyGrant, CompanionUriTokenJti  # noqa: F401 - Required for table creation
    from app.models.download_intent import DownloadIntent  # noqa: F401 - Required for table creation
    from app.models.edit_lock import EditLock  # noqa: F401 - Required for table creation
    from app.models.oidc import (  # noqa: F401 - Required for table creation
        OidcBrowserSession,
        OidcFlow,
        OidcIdentity,
        OidcPendingIdentityMapping,
        OidcProviderConfiguration,
        OidcSessionCipherKey,
    )
    from app.models.recent_directory import RecentDirectory  # noqa: F401 - Required for table creation
    from app.models.recent_file import RecentFile  # noqa: F401 - Required for table creation
    from app.models.system_settings import SystemSetting  # noqa: F401 - Required for table creation
    from app.models.theme import StoredTheme  # noqa: F401 - Required for table creation
    from app.models.transfer_operation import TransferOperation  # noqa: F401 - Required for table creation
    from app.models.user_settings import UserSetting  # noqa: F401 - Required for table creation

    # Create all tables
    SQLModel.metadata.create_all(engine)
    run_migrations(engine)

    # Load or generate app secrets
    with Session(engine) as session:
        app_secret = get_or_create_app_secrets(session)

        # Store secrets in settings for application use
        # (These will be accessed by security.py and other modules)
        settings.secret_key = app_secret.secret_key
        settings.encryption_key = app_secret.encryption_key


#
# get_session
#
def get_session() -> Generator[Session, None, None]:
    """Dependency to get database session"""

    with Session(engine) as session:
        yield session


def get_immediate_session(session: Session = Depends(get_session)) -> Session:
    bind = session.get_bind()
    bind_engine = bind if isinstance(bind, Engine) else bind.engine
    if bind.dialect.name == "sqlite" and not isinstance(bind_engine.pool, StaticPool):
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    return session
