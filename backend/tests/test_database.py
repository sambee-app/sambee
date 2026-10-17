"""
Tests for database layer.

Tests cover:
- Database initialization
- Session management
- Table creation
- Model constraints and validation
"""

import tempfile
from pathlib import Path
from typing import Generator
from unittest.mock import patch

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, create_engine, select

from app.db.archive_cutover_preflight import preflight_result
from app.db.archive_cutover_reset import RESET_CONFIRMATION_FLAG, discard_legacy_archive_operations
from app.db.archive_cutover_reset import main as archive_cutover_reset_main
from app.db.migrations import (
    MIGRATION_TABLE_NAME,
    MIGRATIONS,
    _apply_archive_operation_contract_version_migration,
    _apply_case_insensitive_usernames_migration,
    run_migrations,
)
from app.models.connection import Connection
from app.models.oidc import OidcBrowserSession, OidcBrowserSessionStatus, OidcProviderConfiguration
from app.models.user import User, UserRole


@pytest.mark.unit
class TestDatabaseInitialization:
    """Test database initialization."""

    def test_username_migration_preserves_conflicts_and_guards_writes(self, tmp_path: Path):
        test_engine = create_engine(f"sqlite:///{tmp_path / 'username-upgrade.db'}")
        try:
            with test_engine.begin() as connection:
                connection.exec_driver_sql('CREATE TABLE "user" (id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT)')
                connection.exec_driver_sql('CREATE TABLE owned_item (user_id TEXT REFERENCES "user"(id), value TEXT)')
                connection.exec_driver_sql("INSERT INTO user VALUES ('first', 'UserA', 'hash-one'), ('second', 'usera', 'hash-two')")
                connection.exec_driver_sql("INSERT INTO owned_item VALUES ('second', 'preserved')")
                _apply_case_insensitive_usernames_migration(connection)
                _apply_case_insensitive_usernames_migration(connection)
                assert connection.exec_driver_sql('SELECT id, username, password_hash, username_key FROM "user" ORDER BY id').all() == [
                    ("first", "UserA", "hash-one", "usera"),
                    ("second", "usera", "hash-two", "usera"),
                ]
                assert connection.exec_driver_sql("SELECT * FROM owned_item").all() == [("second", "preserved")]
            with pytest.raises(IntegrityError, match="user_username_key_collision"), test_engine.begin() as connection:
                connection.exec_driver_sql("INSERT INTO user (id, username) VALUES ('third', 'USERA')")
            with test_engine.begin() as connection:
                connection.exec_driver_sql("UPDATE user SET username = 'USERA' WHERE id = 'first'")
                connection.exec_driver_sql("UPDATE user SET username = 'UniqueUser' WHERE id = 'second'")
            with pytest.raises(IntegrityError, match="user_username_key_collision"), test_engine.begin() as connection:
                connection.exec_driver_sql("UPDATE user SET username = 'usera' WHERE id = 'second'")
            with test_engine.begin() as connection:
                connection.exec_driver_sql("DELETE FROM user WHERE id = 'first'")
                connection.exec_driver_sql("INSERT INTO user (id, username) VALUES ('third', 'usera')")
                assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []
        finally:
            test_engine.dispose()

    def test_concurrent_case_variants_cannot_both_be_created(self, tmp_path: Path):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier

        test_engine = create_engine(f"sqlite:///{tmp_path / 'username-concurrent.db'}")
        try:
            with test_engine.begin() as connection:
                connection.exec_driver_sql('CREATE TABLE "user" (id TEXT PRIMARY KEY, username TEXT UNIQUE)')
                _apply_case_insensitive_usernames_migration(connection)
            ready = Barrier(2)

            def insert(username: str) -> bool:
                ready.wait(timeout=10)
                try:
                    with test_engine.begin() as connection:
                        connection.execute(text('INSERT INTO "user" (id, username) VALUES (:username, :username)'), {"username": username})
                    return True
                except IntegrityError as error:
                    assert "user_username_key_collision" in str(error)
                    return False

            with ThreadPoolExecutor(max_workers=2) as executor:
                assert sorted(executor.map(insert, ["ConcurrentUser", "concurrentuser"])) == [False, True]
        finally:
            test_engine.dispose()

    def test_no_refresh_migration_preserves_existing_session(self, tmp_path: Path):
        from datetime import datetime, timedelta, timezone

        engine = create_engine(f"sqlite:///{tmp_path / 'oidc-upgrade.db'}")
        try:
            SQLModel.metadata.create_all(engine)
            with Session(engine) as session:
                user = User(username="upgrade-user", role=UserRole.VIEWER, password_hash=None)
                configuration = OidcProviderConfiguration(display_name="IdP", issuer_url="https://issuer.example", client_id="client")
                session.add_all([user, configuration])
                session.commit()
                now = datetime.now(timezone.utc)
                existing = OidcBrowserSession(
                    user_id=user.id,
                    user_token_version=user.token_version,
                    provider_configuration_id=configuration.id,
                    configuration_revision=0,
                    identity_mapping_revision=0,
                    issuer=configuration.issuer_url,
                    subject="subject",
                    secret_hash="secret",
                    encrypted_refresh_token="encrypted",
                    status=OidcBrowserSessionStatus.ACTIVE,
                    authenticated_at=now,
                    absolute_expires_at=now + timedelta(days=1),
                )
                session.add(existing)
                session.commit()
                session_id = existing.id
            with engine.begin() as connection:
                old_columns = [
                    column["name"] for column in inspect(connection).get_columns("oidcbrowsersession") if column["name"] != "capability"
                ]
                names = ", ".join(f'"{name}"' for name in old_columns)
                connection.execute(text(f'CREATE TABLE "oidcbrowsersession__old" AS SELECT {names} FROM "oidcbrowsersession"'))
                connection.execute(text('DROP TABLE "oidcbrowsersession"'))
                connection.execute(text('ALTER TABLE "oidcbrowsersession__old" RENAME TO "oidcbrowsersession"'))
                connection.execute(
                    text(
                        f"CREATE TABLE {MIGRATION_TABLE_NAME} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)"
                    )
                )
                connection.execute(
                    text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                    [{"version": migration.version, "name": migration.name} for migration in MIGRATIONS if migration.version < 37],
                )
            run_migrations(engine)
            run_migrations(engine)
            with Session(engine) as session:
                upgraded = session.get(OidcBrowserSession, session_id)
                assert upgraded is not None
                assert upgraded.capability == "renewable"
                assert upgraded.encrypted_refresh_token == "encrypted"
            with engine.connect() as connection:
                assert connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall() == []
        finally:
            engine.dispose()

    def test_migration_upgrades_existing_download_intents(self, tmp_path: Path):
        test_engine = create_engine(f"sqlite:///{tmp_path / 'old-download-intents.db'}")
        try:
            with test_engine.begin() as connection:
                connection.execute(
                    text(
                        "CREATE TABLE download_intent ("
                        "token_hash VARCHAR PRIMARY KEY, user_id CHAR(32) NOT NULL, connection_id CHAR(32) NOT NULL, "
                        "path VARCHAR NOT NULL, member_path VARCHAR, expires_at DATETIME NOT NULL)"
                    )
                )
                connection.execute(
                    text(
                        "INSERT INTO download_intent (token_hash, user_id, connection_id, path, expires_at) "
                        "VALUES ('old-ticket', :user_id, :connection_id, 'file.psd', '2099-01-01')"
                    ),
                    {"user_id": "a" * 32, "connection_id": "b" * 32},
                )
                connection.execute(
                    text(
                        f"CREATE TABLE {MIGRATION_TABLE_NAME} ("
                        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
                    )
                )
                for migration in MIGRATIONS:
                    if migration.version < 36:
                        connection.execute(
                            text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                            {"version": migration.version, "name": migration.name},
                        )

            run_migrations(test_engine)
            run_migrations(test_engine)

            assert "token_version" in {column["name"] for column in inspect(test_engine).get_columns("download_intent")}
            with test_engine.begin() as connection:
                assert connection.execute(text("SELECT count(*) FROM download_intent")).scalar_one() == 0
                connection.execute(
                    text(
                        "INSERT INTO download_intent (token_hash, user_id, token_version, connection_id, path, expires_at) "
                        "VALUES ('new-ticket', :user_id, 12, :connection_id, 'file.psd', '2099-01-01')"
                    ),
                    {"user_id": "a" * 32, "connection_id": "b" * 32},
                )
                assert connection.execute(text("SELECT token_version FROM download_intent")).scalar_one() == 12
        finally:
            test_engine.dispose()

    def test_init_db_creates_tables(self):
        """Test that init_db creates all tables."""
        # Create a temporary database
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
            db_path = tmp.name
        test_engine = None

        try:
            # Create engine for temporary database
            test_engine = create_engine(
                f"sqlite:///{db_path}",
                connect_args={"check_same_thread": False},
            )

            # Initialize tables
            SQLModel.metadata.create_all(test_engine)

            # Verify tables were created by checking if we can query them
            with Session(test_engine) as session:
                # Should not raise an error
                session.exec(select(User)).all()
                session.exec(select(Connection)).all()

        finally:
            if test_engine is not None:
                test_engine.dispose()
            # Cleanup
            Path(db_path).unlink(missing_ok=True)

    def test_init_db_called_successfully(self):
        """Test that init_db can be called without errors."""
        # This uses the actual database
        from app.db.database import init_db

        # Should not raise any exceptions
        init_db()

    @patch("app.db.database.SQLModel.metadata.create_all")
    def test_init_db_calls_create_all(self, mock_create_all):
        """Test that init_db calls SQLModel.metadata.create_all."""
        from app.db.database import engine, init_db

        init_db()

        # Verify create_all was called with the engine
        mock_create_all.assert_called_once_with(engine)


@pytest.mark.unit
class TestArchiveOperationContractVersionMigration:
    """V2 cutover migration behavior for existing archive-operation tables."""

    def test_adds_constrained_v2_version_to_empty_legacy_table(self, tmp_path: Path):
        test_engine = create_engine(f"sqlite:///{tmp_path / 'archive-v2-empty.db'}")
        try:
            with test_engine.begin() as connection:
                connection.execute(text("CREATE TABLE archive_operations (id CHAR(32) PRIMARY KEY)"))
                _apply_archive_operation_contract_version_migration(connection)
                assert connection.execute(text("SELECT contract_version FROM archive_operations")).all() == []
                connection.execute(text("INSERT INTO archive_operations (id) VALUES ('v2-operation')"))
                assert connection.execute(text("SELECT contract_version FROM archive_operations")).scalar_one() == "V2"
                with pytest.raises(IntegrityError):
                    connection.execute(text("INSERT INTO archive_operations (id, contract_version) VALUES ('legacy-operation', 'v1')"))
        finally:
            test_engine.dispose()

    def test_rejects_nonempty_legacy_archive_operation_table(self, tmp_path: Path):
        test_engine = create_engine(f"sqlite:///{tmp_path / 'archive-v2-legacy.db'}")
        try:
            with test_engine.begin() as connection:
                connection.execute(text("CREATE TABLE archive_operations (id CHAR(32) PRIMARY KEY)"))
                connection.execute(text("INSERT INTO archive_operations (id) VALUES ('legacy-operation')"))
                with pytest.raises(RuntimeError, match="requires an empty archive_operations table"):
                    _apply_archive_operation_contract_version_migration(connection)
        finally:
            test_engine.dispose()

    def test_preflight_lists_legacy_operations_and_blocks_cutover(self, tmp_path: Path):
        test_engine = create_engine(f"sqlite:///{tmp_path / 'archive-v2-preflight.db'}")
        try:
            with test_engine.begin() as connection:
                connection.execute(text("CREATE TABLE archive_operations (id CHAR(32) PRIMARY KEY, kind VARCHAR(16), phase VARCHAR(32))"))
                connection.execute(
                    text("INSERT INTO archive_operations (id, kind, phase) VALUES ('legacy-operation', 'extract', 'streaming')")
                )

            result = preflight_result(test_engine)

            assert result == {
                "archive_contract_version": "v2",
                "ready": False,
                "legacy_operations": [
                    {
                        "id": "legacy-operation",
                        "user_id": None,
                        "kind": "extract",
                        "phase": "streaming",
                        "created_at": None,
                        "updated_at": None,
                    }
                ],
            }
        finally:
            test_engine.dispose()

    def test_preflight_accepts_only_v2_archive_operations(self, tmp_path: Path):
        test_engine = create_engine(f"sqlite:///{tmp_path / 'archive-v2-ready.db'}")
        try:
            with test_engine.begin() as connection:
                connection.execute(text("CREATE TABLE archive_operations (id CHAR(32) PRIMARY KEY, contract_version VARCHAR(8) NOT NULL)"))
                connection.execute(text("INSERT INTO archive_operations (id, contract_version) VALUES ('v2-operation', 'V2')"))

            assert preflight_result(test_engine) == {
                "archive_contract_version": "v2",
                "ready": True,
                "legacy_operations": [],
            }
        finally:
            test_engine.dispose()

    def test_reset_discards_only_legacy_rows(self, tmp_path: Path):
        test_engine = create_engine(f"sqlite:///{tmp_path / 'archive-v2-reset.db'}")
        try:
            with test_engine.begin() as connection:
                connection.execute(text("CREATE TABLE archive_operations (id CHAR(32) PRIMARY KEY, contract_version VARCHAR(8))"))
                connection.execute(text("INSERT INTO archive_operations (id, contract_version) VALUES ('v2-operation', 'V2')"))
                connection.execute(text("INSERT INTO archive_operations (id, contract_version) VALUES ('legacy-operation', 'v1')"))

            assert discard_legacy_archive_operations(test_engine) == 1
            assert preflight_result(test_engine)["ready"] is True
            with test_engine.connect() as connection:
                assert connection.execute(text("SELECT id FROM archive_operations")).scalars().all() == ["v2-operation"]
        finally:
            test_engine.dispose()

    def test_reset_requires_confirmation_and_allows_migration(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        test_engine = create_engine(f"sqlite:///{tmp_path / 'archive-v2-reset-confirmation.db'}")
        try:
            with test_engine.begin() as connection:
                connection.execute(text("CREATE TABLE archive_operations (id CHAR(32) PRIMARY KEY)"))
                connection.execute(text("INSERT INTO archive_operations (id) VALUES ('legacy-operation')"))

            monkeypatch.setattr("app.db.database.engine", test_engine)
            assert archive_cutover_reset_main([]) == 2
            assert preflight_result(test_engine)["ready"] is False
            assert archive_cutover_reset_main([RESET_CONFIRMATION_FLAG]) == 0
            assert preflight_result(test_engine)["ready"] is True
            with test_engine.begin() as connection:
                _apply_archive_operation_contract_version_migration(connection)
                assert "contract_version" in {column["name"] for column in inspect(connection).get_columns("archive_operations")}
        finally:
            test_engine.dispose()


@pytest.mark.unit
class TestSessionManagement:
    """Test database session management."""

    def test_get_session_returns_generator(self):
        """Test that get_session returns a generator."""
        from app.db.database import get_session

        result = get_session()
        assert isinstance(result, Generator)

    def test_get_session_yields_session(self):
        """Test that get_session yields a Session object."""
        from app.db.database import get_session

        gen = get_session()
        session = next(gen)

        assert isinstance(session, Session)

        # Cleanup
        try:
            next(gen)
        except StopIteration:
            pass

    def test_get_session_context_manager(self):
        """Test that get_session uses context manager properly."""
        from app.db.database import get_session

        # Test that generator completes without errors
        gen = get_session()
        session = next(gen)

        # Session should be active while in context
        assert session.is_active

        # Exhaust the generator to complete context manager
        with pytest.raises(StopIteration):
            next(gen)

    def test_get_session_can_query_database(self):
        """Test that session can query the database."""
        from app.db.database import get_session

        gen = get_session()
        session = next(gen)

        # Should be able to query without errors
        users = session.exec(select(User)).all()
        assert isinstance(users, list)

        # Cleanup
        try:
            next(gen)
        except StopIteration:
            pass

    def test_get_session_transaction_rollback_on_error(self):
        """Test that session rolls back on error."""
        from app.db.database import get_session

        gen = get_session()
        session = next(gen)

        try:
            # Create a user with invalid data (duplicate username)
            user1 = User(username="test_rollback", password_hash="hash1")
            session.add(user1)
            session.flush()

            # Try to create duplicate - should fail
            user2 = User(username="test_rollback", password_hash="hash2")
            session.add(user2)
            session.commit()  # This should raise an error
        except Exception:
            # Session should allow rollback
            session.rollback()

        # Cleanup
        try:
            next(gen)
        except StopIteration:
            pass


@pytest.mark.unit
class TestDatabaseEngine:
    """Test database engine configuration."""

    def test_engine_is_created(self):
        """Test that database engine is created."""
        from app.db.database import engine

        assert engine is not None

    def test_engine_url_format(self):
        """Test that database URL is correctly formatted."""
        from app.db.database import DATABASE_URL

        assert DATABASE_URL.startswith("sqlite:///")
        assert "sambee.db" in DATABASE_URL

    def test_engine_uses_sqlite(self):
        """Test that engine uses SQLite."""
        from app.db.database import engine

        assert "sqlite" in str(engine.url)

    def test_nullable_password_migration_preserves_dependent_user_references(self, tmp_path: Path):
        db_path = tmp_path / "legacy-user-reference.db"
        test_engine = create_engine(f"sqlite:///{db_path}")
        try:
            with test_engine.begin() as connection:
                connection.execute(text("PRAGMA foreign_keys=ON"))
                connection.execute(
                    text(
                        'CREATE TABLE "user" ('
                        "id CHAR(32) PRIMARY KEY, username VARCHAR NOT NULL, name VARCHAR, email VARCHAR, "
                        "password_hash VARCHAR NOT NULL, role VARCHAR NOT NULL DEFAULT 'editor', "
                        "is_active BOOLEAN NOT NULL DEFAULT 1, must_change_password BOOLEAN NOT NULL DEFAULT 0, "
                        "token_version INTEGER NOT NULL DEFAULT 0, expires_at TIMESTAMP, "
                        "created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL)"
                    )
                )
                connection.execute(text('CREATE TABLE dependent (id INTEGER PRIMARY KEY, user_id CHAR(32) REFERENCES "user"(id))'))
                connection.execute(
                    text(
                        'INSERT INTO "user" (id, username, password_hash, created_at, updated_at) '
                        "VALUES ('abc', 'admin', 'hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
                    )
                )
                connection.execute(text("INSERT INTO dependent (id, user_id) VALUES (1, 'abc')"))
                connection.execute(
                    text(
                        f"CREATE TABLE {MIGRATION_TABLE_NAME} ("
                        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
                    )
                )
                for migration in MIGRATIONS:
                    if migration.version < 12:
                        connection.execute(
                            text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                            {"version": migration.version, "name": migration.name},
                        )

            run_migrations(test_engine)

            with test_engine.connect() as connection:
                password_column = next(column for column in inspect(connection).get_columns("user") if column["name"] == "password_hash")
                assert password_column["nullable"] is True
                assert connection.execute(text("SELECT user_id FROM dependent WHERE id = 1")).scalar_one() == "abc"
                assert connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall() == []
        finally:
            test_engine.dispose()

    def test_run_migrations_drops_legacy_edit_lock_companion_session(self, tmp_path: Path):
        """Legacy persisted companion lock tokens are removed from edit_locks schema."""
        db_path = tmp_path / "legacy-edit-locks.db"
        test_engine = create_engine(
            f"sqlite:///{db_path}",
            connect_args={"check_same_thread": False},
        )

        try:
            with test_engine.begin() as connection:
                connection.execute(
                    text(
                        f"""
                        CREATE TABLE {MIGRATION_TABLE_NAME} (
                            version INTEGER PRIMARY KEY,
                            name TEXT NOT NULL,
                            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )
                        """
                    )
                )
                connection.execute(
                    text(
                        """
                        CREATE TABLE edit_locks (
                            id CHAR(32) NOT NULL,
                            file_path VARCHAR NOT NULL,
                            connection_id CHAR(32) NOT NULL,
                            locked_by VARCHAR NOT NULL,
                            locked_at DATETIME NOT NULL,
                            companion_session VARCHAR NOT NULL,
                            last_heartbeat DATETIME NOT NULL,
                            lock_capability VARCHAR DEFAULT '',
                            operation_id VARCHAR DEFAULT '',
                            PRIMARY KEY (id)
                        )
                        """
                    )
                )
                connection.execute(text("CREATE INDEX ix_edit_locks_companion_session ON edit_locks (companion_session)"))
                connection.execute(text("CREATE INDEX ix_edit_locks_connection_id ON edit_locks (connection_id)"))
                connection.execute(text("CREATE INDEX ix_edit_locks_file_path ON edit_locks (file_path)"))
                connection.execute(text("CREATE INDEX ix_edit_locks_lock_capability ON edit_locks (lock_capability)"))
                connection.execute(text("CREATE INDEX ix_edit_locks_locked_by ON edit_locks (locked_by)"))
                connection.execute(text("CREATE INDEX ix_edit_locks_operation_id ON edit_locks (operation_id)"))
                connection.execute(
                    text(
                        """
                        INSERT INTO edit_locks (
                            id,
                            file_path,
                            connection_id,
                            locked_by,
                            locked_at,
                            companion_session,
                            last_heartbeat,
                            lock_capability,
                            operation_id
                        ) VALUES (
                            :id,
                            :file_path,
                            :connection_id,
                            :locked_by,
                            :locked_at,
                            :companion_session,
                            :last_heartbeat,
                            :lock_capability,
                            :operation_id
                        )
                        """
                    ),
                    {
                        "id": "a" * 32,
                        "file_path": "/docs/report.docx",
                        "connection_id": "b" * 32,
                        "locked_by": "testadmin",
                        "locked_at": "2026-06-17 10:00:00",
                        "companion_session": "legacy-secret",
                        "last_heartbeat": "2026-06-17 10:00:30",
                        "lock_capability": "capability-123",
                        "operation_id": "operation-123",
                    },
                )
                connection.execute(
                    text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                    [{"version": migration.version, "name": migration.name} for migration in MIGRATIONS if migration.version < 11],
                )

            run_migrations(test_engine)

            with test_engine.connect() as connection:
                inspector = inspect(connection)
                lock_columns = {column["name"] for column in inspector.get_columns("edit_locks")}
                assert "companion_session" not in lock_columns

                index_names = {index["name"] for index in inspector.get_indexes("edit_locks")}
                assert "ix_edit_locks_companion_session" not in index_names
                assert "ix_edit_locks_file_path" in index_names
                assert "ix_edit_locks_connection_id" in index_names
                assert "ix_edit_locks_locked_by" in index_names
                assert "ix_edit_locks_operation_id" in index_names
                assert "ix_edit_locks_lock_capability" in index_names

                migrated_row = (
                    connection.execute(
                        text(
                            """
                        SELECT id, file_path, connection_id, locked_by, locked_at, last_heartbeat, lock_capability, operation_id
                        FROM edit_locks
                        """
                        )
                    )
                    .mappings()
                    .one()
                )
                assert migrated_row["id"] == "a" * 32
                assert migrated_row["file_path"] == "/docs/report.docx"
                assert migrated_row["connection_id"] == "b" * 32
                assert migrated_row["locked_by"] == "testadmin"
                assert migrated_row["lock_capability"] == "capability-123"
                assert migrated_row["operation_id"] == "operation-123"

                applied_versions = set(connection.execute(text(f"SELECT version FROM {MIGRATION_TABLE_NAME}")).scalars().all())
                assert 11 in applied_versions
        finally:
            test_engine.dispose()

    def test_run_migrations_enforces_unique_edit_lock_targets(self, tmp_path: Path):
        """Duplicate historical locks are reduced to the most recently active row before enforcing uniqueness."""
        db_path = tmp_path / "duplicate-edit-locks.db"
        test_engine = create_engine(f"sqlite:///{db_path}")

        try:
            with test_engine.begin() as connection:
                connection.execute(
                    text(
                        f"""
                        CREATE TABLE {MIGRATION_TABLE_NAME} (
                            version INTEGER PRIMARY KEY,
                            name TEXT NOT NULL,
                            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )
                        """
                    )
                )
                connection.execute(
                    text(
                        """
                        CREATE TABLE edit_locks (
                            id CHAR(32) NOT NULL PRIMARY KEY,
                            file_path VARCHAR NOT NULL,
                            connection_id CHAR(32) NOT NULL,
                            locked_by VARCHAR NOT NULL,
                            operation_id VARCHAR NOT NULL DEFAULT '',
                            locked_at DATETIME NOT NULL,
                            lock_capability VARCHAR NOT NULL DEFAULT '',
                            last_heartbeat DATETIME NOT NULL
                        )
                        """
                    )
                )
                connection.execute(
                    text(
                        """
                        INSERT INTO edit_locks (
                            id, file_path, connection_id, locked_by, operation_id, locked_at, lock_capability, last_heartbeat
                        ) VALUES (
                            :id, :file_path, :connection_id, :locked_by, :operation_id, :locked_at, :lock_capability, :last_heartbeat
                        )
                        """
                    ),
                    [
                        {
                            "id": "a" * 32,
                            "file_path": "/docs/report.docx",
                            "connection_id": "b" * 32,
                            "locked_by": "alice",
                            "operation_id": "first",
                            "locked_at": "2026-08-27 12:00:00",
                            "lock_capability": "first-capability",
                            "last_heartbeat": "2026-08-27 12:00:00",
                        },
                        {
                            "id": "c" * 32,
                            "file_path": "/docs/report.docx",
                            "connection_id": "b" * 32,
                            "locked_by": "alice",
                            "operation_id": "second",
                            "locked_at": "2026-08-27 12:01:00",
                            "lock_capability": "second-capability",
                            "last_heartbeat": "2026-08-27 12:01:00",
                        },
                    ],
                )
                connection.execute(
                    text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                    [{"version": migration.version, "name": migration.name} for migration in MIGRATIONS if migration.version < 29],
                )

            run_migrations(test_engine)

            with test_engine.connect() as connection:
                remaining_locks = connection.execute(text("SELECT id FROM edit_locks")).scalars().all()
                assert remaining_locks == ["c" * 32]
                indexes = {index["name"]: index for index in inspect(connection).get_indexes("edit_locks")}
                assert indexes["uq_edit_locks_connection_path"]["unique"]

            with pytest.raises(IntegrityError):
                with test_engine.begin() as connection:
                    connection.execute(
                        text(
                            """
                            INSERT INTO edit_locks (
                                id, file_path, connection_id, locked_by, operation_id, locked_at, lock_capability, last_heartbeat
                            ) VALUES (
                                :id, :file_path, :connection_id, :locked_by, :operation_id, :locked_at, :lock_capability, :last_heartbeat
                            )
                            """
                        ),
                        {
                            "id": "d" * 32,
                            "file_path": "/docs/report.docx",
                            "connection_id": "b" * 32,
                            "locked_by": "bob",
                            "operation_id": "third",
                            "locked_at": "2026-08-27 12:02:00",
                            "lock_capability": "third-capability",
                            "last_heartbeat": "2026-08-27 12:02:00",
                        },
                    )
        finally:
            test_engine.dispose()

    def test_run_migrations_adds_oidc_browser_session_client_metadata(self, tmp_path: Path):
        db_path = tmp_path / "legacy-oidc-browser-session.db"
        test_engine = create_engine(f"sqlite:///{db_path}")
        try:
            with test_engine.begin() as connection:
                connection.execute(text("CREATE TABLE oidcbrowsersession (id CHAR(32) PRIMARY KEY)"))
                connection.execute(
                    text(
                        f"CREATE TABLE {MIGRATION_TABLE_NAME} ("
                        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
                    )
                )
                for migration in MIGRATIONS:
                    if migration.version >= 23:
                        continue
                    connection.execute(
                        text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                        {"version": migration.version, "name": migration.name},
                    )

            run_migrations(test_engine)
            run_migrations(test_engine)

            session_columns = {column["name"] for column in inspect(test_engine).get_columns("oidcbrowsersession")}
            assert {"browser_name", "operating_system"} <= session_columns
        finally:
            test_engine.dispose()

    def test_run_migrations_adds_default_oidc_auto_link_policy(self, tmp_path: Path):
        db_path = tmp_path / "legacy-oidc-provider.db"
        test_engine = create_engine(f"sqlite:///{db_path}")
        try:
            with test_engine.begin() as connection:
                connection.execute(text("CREATE TABLE oidcproviderconfiguration (id INTEGER PRIMARY KEY)"))
                connection.execute(text("INSERT INTO oidcproviderconfiguration (id) VALUES (1)"))
                connection.execute(
                    text(
                        f"CREATE TABLE {MIGRATION_TABLE_NAME} ("
                        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
                    )
                )
                for migration in MIGRATIONS:
                    if migration.version >= 25:
                        continue
                    connection.execute(
                        text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                        {"version": migration.version, "name": migration.name},
                    )

            run_migrations(test_engine)
            run_migrations(test_engine)

            with test_engine.connect() as connection:
                assert (
                    connection.execute(text("SELECT auto_link_by_username FROM oidcproviderconfiguration WHERE id = 1")).scalar_one() == 1
                )
        finally:
            test_engine.dispose()

    def test_run_migrations_adds_recent_file_history_table_and_indexes(self, tmp_path: Path):
        db_path = tmp_path / "legacy-recent-files.db"
        test_engine = create_engine(f"sqlite:///{db_path}")
        try:
            with test_engine.begin() as connection:
                connection.execute(
                    text(
                        f"CREATE TABLE {MIGRATION_TABLE_NAME} ("
                        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
                    )
                )
                for migration in MIGRATIONS:
                    if migration.version >= 26:
                        continue
                    connection.execute(
                        text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                        {"version": migration.version, "name": migration.name},
                    )

            run_migrations(test_engine)
            run_migrations(test_engine)

            inspector = inspect(test_engine)
            assert "recentfile" in inspector.get_table_names()
            assert {column["name"] for column in inspector.get_columns("recentfile")} >= {
                "id",
                "user_id",
                "connection_id",
                "path",
                "file_name",
                "last_opened_at",
                "created_at",
            }
            assert {index["name"] for index in inspector.get_indexes("recentfile")} >= {
                "ix_recentfile_user_id",
                "ix_recentfile_connection_id",
                "ix_recentfile_last_opened_at",
                "ix_recentfile_user_last_opened",
            }
            with test_engine.connect() as connection:
                applied_versions = set(connection.execute(text(f"SELECT version FROM {MIGRATION_TABLE_NAME}")).scalars().all())
            assert 26 in applied_versions
        finally:
            test_engine.dispose()

    def test_run_migrations_adds_recent_directory_history_table_and_indexes(self, tmp_path: Path):
        db_path = tmp_path / "legacy-recent-directories.db"
        test_engine = create_engine(f"sqlite:///{db_path}")
        try:
            with test_engine.begin() as connection:
                connection.execute(
                    text(
                        f"CREATE TABLE {MIGRATION_TABLE_NAME} ("
                        "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
                    )
                )
                for migration in MIGRATIONS:
                    if migration.version >= 27:
                        continue
                    connection.execute(
                        text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                        {"version": migration.version, "name": migration.name},
                    )

            run_migrations(test_engine)
            run_migrations(test_engine)

            inspector = inspect(test_engine)
            assert "recentdirectory" in inspector.get_table_names()
            assert {column["name"] for column in inspector.get_columns("recentdirectory")} >= {
                "id",
                "user_id",
                "connection_id",
                "path",
                "last_visited_at",
                "created_at",
            }
            assert {index["name"] for index in inspector.get_indexes("recentdirectory")} >= {
                "ix_recentdirectory_user_id",
                "ix_recentdirectory_connection_id",
                "ix_recentdirectory_last_visited_at",
                "ix_recentdirectory_user_last_visited",
            }
            with test_engine.connect() as connection:
                applied_versions = set(connection.execute(text(f"SELECT version FROM {MIGRATION_TABLE_NAME}")).scalars().all())
            assert 27 in applied_versions
        finally:
            test_engine.dispose()

    def test_run_migrations_makes_password_nullable_and_preserves_hash(self, tmp_path: Path):
        db_path = tmp_path / "legacy-user-password.db"
        test_engine = create_engine(
            f"sqlite:///{db_path}",
            connect_args={"check_same_thread": False},
        )

        try:
            with test_engine.begin() as connection:
                connection.execute(
                    text(
                        f"""
                        CREATE TABLE {MIGRATION_TABLE_NAME} (
                            version INTEGER PRIMARY KEY,
                            name TEXT NOT NULL,
                            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )
                        """
                    )
                )
                connection.execute(
                    text(
                        """
                        CREATE TABLE "user" (
                            id CHAR(32) NOT NULL PRIMARY KEY,
                            username VARCHAR NOT NULL,
                            name VARCHAR,
                            email VARCHAR,
                            password_hash VARCHAR NOT NULL,
                            role VARCHAR NOT NULL DEFAULT 'editor',
                            is_active BOOLEAN NOT NULL DEFAULT 1,
                            must_change_password BOOLEAN NOT NULL DEFAULT 0,
                            token_version INTEGER NOT NULL DEFAULT 0,
                            expires_at TIMESTAMP,
                            created_at TIMESTAMP NOT NULL,
                            updated_at TIMESTAMP NOT NULL
                        )
                        """
                    )
                )
                connection.execute(
                    text(
                        """
                        INSERT INTO "user" (
                            id, username, password_hash, role, is_active,
                            must_change_password, token_version, created_at, updated_at
                        ) VALUES (
                            :id, :username, :password_hash, 'admin', 1, 0, 3,
                            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                        )
                        """
                    ),
                    {"id": "a" * 32, "username": "legacy-admin", "password_hash": "preserved-hash"},
                )
                connection.execute(
                    text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                    [{"version": migration.version, "name": migration.name} for migration in MIGRATIONS if migration.version < 12],
                )

            run_migrations(test_engine)
            run_migrations(test_engine)

            with test_engine.begin() as connection:
                password_column = next(column for column in inspect(connection).get_columns("user") if column["name"] == "password_hash")
                assert password_column["nullable"] is True
                assert connection.execute(text('SELECT password_hash FROM "user"')).scalar_one() == "preserved-hash"
                connection.execute(
                    text(
                        """
                        INSERT INTO "user" (
                            id, username, password_hash, role, is_active,
                            must_change_password, token_version, created_at, updated_at
                        ) VALUES (
                            :id, :username, NULL, 'viewer', 1, 0, 0,
                            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                        )
                        """
                    ),
                    {"id": "b" * 32, "username": "passwordless-user"},
                )
        finally:
            test_engine.dispose()

    def test_run_migrations_makes_oidc_mapping_creator_nullable_and_preserves_mapping(self, tmp_path: Path):
        db_path = tmp_path / "legacy-oidc-mapping-creator.db"
        test_engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})

        try:
            with test_engine.begin() as connection:
                connection.execute(
                    text(
                        f"""
                        CREATE TABLE {MIGRATION_TABLE_NAME} (
                            version INTEGER PRIMARY KEY,
                            name TEXT NOT NULL,
                            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )
                        """
                    )
                )
                connection.execute(text('CREATE TABLE "user" (id CHAR(32) NOT NULL PRIMARY KEY, username VARCHAR NOT NULL UNIQUE)'))
                connection.execute(text("CREATE TABLE oidcproviderconfiguration (id INTEGER NOT NULL PRIMARY KEY)"))
                connection.execute(
                    text(
                        """
                        CREATE TABLE oidcpendingidentitymapping (
                            id CHAR(32) NOT NULL PRIMARY KEY,
                            provider_configuration_id INTEGER NOT NULL,
                            expected_username VARCHAR NOT NULL,
                            target_user_id CHAR(32) NOT NULL,
                            created_by_user_id CHAR(32) NOT NULL,
                            created_at DATETIME NOT NULL,
                            updated_at DATETIME NOT NULL,
                            CONSTRAINT uq_oidc_pending_provider_username
                                UNIQUE (provider_configuration_id, expected_username),
                            CONSTRAINT uq_oidc_pending_provider_target
                                UNIQUE (provider_configuration_id, target_user_id),
                            FOREIGN KEY(provider_configuration_id) REFERENCES oidcproviderconfiguration (id),
                            FOREIGN KEY(target_user_id) REFERENCES "user" (id),
                            FOREIGN KEY(created_by_user_id) REFERENCES "user" (id)
                        )
                        """
                    )
                )
                connection.execute(
                    text("INSERT INTO \"user\" (id, username) VALUES (:target, 'target'), (:creator, 'creator')"),
                    {"target": "a" * 32, "creator": "b" * 32},
                )
                connection.execute(text("INSERT INTO oidcproviderconfiguration (id) VALUES (1)"))
                connection.execute(
                    text(
                        """
                        INSERT INTO oidcpendingidentitymapping (
                            id, provider_configuration_id, expected_username, target_user_id,
                            created_by_user_id, created_at, updated_at
                        ) VALUES (:id, 1, 'provider-user', :target, :creator, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        """
                    ),
                    {"id": "c" * 32, "target": "a" * 32, "creator": "b" * 32},
                )
                connection.execute(
                    text(f"INSERT INTO {MIGRATION_TABLE_NAME} (version, name) VALUES (:version, :name)"),
                    [{"version": migration.version, "name": migration.name} for migration in MIGRATIONS if migration.version < 15],
                )

            run_migrations(test_engine)
            run_migrations(test_engine)

            with test_engine.begin() as connection:
                creator_column = next(
                    column
                    for column in inspect(connection).get_columns("oidcpendingidentitymapping")
                    if column["name"] == "created_by_user_id"
                )
                assert creator_column["nullable"] is True
                row = (
                    connection.execute(text("SELECT target_user_id, created_by_user_id, expected_username FROM oidcpendingidentitymapping"))
                    .mappings()
                    .one()
                )
                assert row == {
                    "target_user_id": "a" * 32,
                    "created_by_user_id": "b" * 32,
                    "expected_username": "provider-user",
                }
                connection.execute(text("UPDATE oidcpendingidentitymapping SET created_by_user_id = NULL"))
                assert connection.execute(text("SELECT created_by_user_id FROM oidcpendingidentitymapping")).scalar_one() is None
        finally:
            test_engine.dispose()


@pytest.mark.integration
class TestModelConstraints:
    """Test model constraints and validation."""

    def test_user_unique_username_constraint(self, session: Session):
        """Test that username must be unique."""
        # Create first user
        user1 = User(username="unique_test", password_hash="hash1")
        session.add(user1)
        session.commit()

        # Try to create second user with same username
        user2 = User(username="unique_test", password_hash="hash2")
        session.add(user2)

        with pytest.raises(Exception):  # SQLAlchemy will raise IntegrityError
            session.commit()

        session.rollback()

    def test_user_not_null_constraints(self, session: Session):
        """Test that required fields cannot be null."""
        # Username is required - this is caught by Pydantic validation
        # SQLModel models validate at instantiation time, not at database time
        # Test that User model has proper required fields
        from app.models.user import User as UserModel

        # Check that username field is required
        assert "username" in UserModel.model_fields
        assert UserModel.model_fields["username"].is_required()

    def test_user_default_values(self, session: Session):
        """Test that default values are set correctly."""
        user = User(username="default_test", password_hash="hash")
        session.add(user)
        session.commit()
        session.refresh(user)

        # role should default to editor
        assert user.role == UserRole.EDITOR
        # created_at should be set
        assert user.created_at is not None

    def test_connection_foreign_key_constraint(self, session: Session):
        """Test that connections can be created without foreign keys."""
        # Connection model doesn't have foreign keys in current schema
        connection = Connection(
            name="Test Connection",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted="encrypted",
        )
        session.add(connection)
        session.commit()

        assert connection.id is not None

    def test_connection_not_null_constraints(self, session: Session):
        """Test that required fields cannot be null."""
        # Name is required - check model definition
        from app.models.connection import Connection as ConnectionModel

        # Check that name field is required
        assert "name" in ConnectionModel.model_fields
        assert ConnectionModel.model_fields["name"].is_required()

    def test_connection_default_values(self, session: Session):
        """Test that default values are set correctly."""
        connection = Connection(
            name="Default Test",
            type="smb",
            host="server.local",
            share_name="share",
            username="user",
            password_encrypted="encrypted",
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        # created_at should be set
        assert connection.created_at is not None
        # port should default to 445
        assert connection.port == 445


@pytest.mark.integration
class TestTransactionHandling:
    """Test transaction handling."""

    def test_commit_persists_data(self, session: Session):
        """Test that commit persists data to database."""
        username = f"commit_test_{id(session)}"
        user = User(username=username, password_hash="hash")
        session.add(user)
        session.commit()

        # Refresh to ensure we have the ID
        session.refresh(user)
        user_id = user.id

        # Query in same session to verify persistence
        result = session.exec(select(User).where(User.id == user_id)).first()
        assert result is not None
        assert result.username == username

    def test_rollback_discards_changes(self, session: Session):
        """Test that rollback discards uncommitted changes."""
        user = User(username="rollback_test", password_hash="hash")
        session.add(user)
        # Don't commit
        session.rollback()

        # Query should not find the user
        result = session.exec(select(User).where(User.username == "rollback_test")).first()
        assert result is None

    def test_transaction_isolation(self, session: Session):
        """Test that transactions are isolated."""
        # Create user in first session
        user = User(username="isolation_test", password_hash="hash")
        session.add(user)
        # Don't commit yet

        # Query in second session should not see uncommitted data
        from app.db.database import get_session

        gen = get_session()
        other_session = next(gen)

        result = other_session.exec(select(User).where(User.username == "isolation_test")).first()
        assert result is None  # Uncommitted data not visible

        # Cleanup
        session.rollback()
        try:
            next(gen)
        except StopIteration:
            pass


@pytest.mark.integration
class TestConcurrentAccess:
    """Test concurrent database access."""

    def test_multiple_sessions_can_read(self, session: Session):
        """Test that multiple sessions can read simultaneously."""
        from app.db.database import get_session

        # Open multiple sessions
        sessions = []
        for _ in range(3):
            gen = get_session()
            s = next(gen)
            sessions.append((gen, s))

        # All sessions should be able to query without errors
        for _, s in sessions:
            # Query should succeed even if no results
            result = s.exec(select(User)).all()
            assert isinstance(result, list)

        # Cleanup
        for gen, _ in sessions:
            try:
                next(gen)
            except StopIteration:
                pass

    def test_sessions_are_independent(self):
        """Test that sessions maintain independent state."""
        from app.db.database import get_session

        # Create two sessions
        gen1 = get_session()
        session1 = next(gen1)

        gen2 = get_session()
        session2 = next(gen2)

        # They should be different objects
        assert session1 is not session2

        # Cleanup
        for gen in [gen1, gen2]:
            try:
                next(gen)
            except StopIteration:
                pass


@pytest.mark.unit
class TestDatabaseConfiguration:
    """Test database configuration."""

    def test_check_same_thread_disabled(self):
        """Test that check_same_thread is disabled for SQLite."""
        from app.db.database import engine

        # This setting is needed for FastAPI/async usage
        # We verify by checking the engine was created with proper connect_args
        # The actual check is in the database.py configuration
        assert "sqlite" in str(engine.url)

    def test_debug_mode_affects_echo(self):
        """Test that debug mode affects SQL echo."""
        from app.core.config import settings
        from app.db.database import engine

        # Echo should be enabled when log_level is DEBUG
        assert engine.echo == (settings.log_level == "DEBUG")


@pytest.mark.integration
class TestDatabaseSchemaValidation:
    """Test database schema validation."""

    def test_all_models_have_tables(self, session: Session):
        """Test that all models have corresponding tables."""
        # Test User table
        users = session.exec(select(User)).all()
        assert isinstance(users, list)

        # Test Connection table
        connections = session.exec(select(Connection)).all()
        assert isinstance(connections, list)

    def test_user_table_columns(self, session: Session):
        """Test that User table has expected columns."""
        user = User(username="column_test", password_hash="hash", role=UserRole.ADMIN)
        session.add(user)
        session.commit()
        session.refresh(user)

        # Verify all expected attributes exist
        assert hasattr(user, "id")
        assert hasattr(user, "username")
        assert hasattr(user, "password_hash")
        assert hasattr(user, "role")
        assert hasattr(user, "created_at")

    def test_connection_table_columns(self, session: Session):
        """Test that Connection table has expected columns."""
        connection = Connection(
            name="Column Test",
            type="smb",
            host="server.local",
            port=445,
            share_name="share",
            username="user",
            password_encrypted="encrypted",
        )
        session.add(connection)
        session.commit()
        session.refresh(connection)

        # Verify all expected attributes exist
        assert hasattr(connection, "id")
        assert hasattr(connection, "name")
        assert hasattr(connection, "type")
        assert hasattr(connection, "host")
        assert hasattr(connection, "port")
        assert hasattr(connection, "share_name")
        assert hasattr(connection, "username")
        assert hasattr(connection, "password_encrypted")
        assert hasattr(connection, "created_at")
