from sqlite3 import Connection as SqliteConnection
from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

USERNAME_KEY_FUNCTION = "sambee_username_key"
USERNAME_COLLISION_MESSAGE = "A user with that username already exists"
USERNAME_COLLISION_CONSTRAINT = "user_username_key_collision"


def username_key(username: str) -> str:
    """Use the same Unicode comparison for account lookup, writes, and throttling."""
    return username.strip().casefold()


def is_username_collision(error: IntegrityError) -> bool:
    return USERNAME_COLLISION_CONSTRAINT in str(error.orig) or "UNIQUE constraint failed: user.username" in str(error.orig)


@event.listens_for(Engine, "connect")
def register_username_key(connection: Any, _record: Any) -> None:
    """Make generated username keys available on every SQLite connection."""
    if isinstance(connection, SqliteConnection):
        connection.create_function(USERNAME_KEY_FUNCTION, 1, username_key, deterministic=True)
