"""Manager-wide disk accounting and admission for disposable directory indexes."""

from __future__ import annotations

import heapq
import logging
import os
import re
import shutil
import sqlite3
import stat
import threading
import time
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator
from uuid import UUID

from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT
from app.models.system_settings import DirectoryIndexPolicy
from app.services.directory_index import (
    APPLICATION_ID,
    SCHEMA_VERSION,
    STORAGE_FILE_SUFFIXES,
    DirectoryIndex,
    connect_directory_database,
    validate_storage_ancestors,
)

WRITE_HEADROOM_BYTES = DIRECTORY_INDEX_CONTRACT.limits["write_headroom_bytes"]
LEASE_CLEANUP_BATCH = DIRECTORY_INDEX_CONTRACT.limits["lease_cleanup_batch"]
LEGACY_SNAPSHOT_SUFFIXES = frozenset({".idx", ".bak"})
LEGACY_STORAGE_SUFFIXES = LEGACY_SNAPSHOT_SUFFIXES | {".tmp"}
LEGACY_TEMP_NAME = re.compile(r"\.[0-9a-f]{8}_[a-z0-9_]{8}\.tmp")
logger = logging.getLogger(__name__)


class DirectoryDiskBudgetError(RuntimeError):
    """Growth cannot proceed without the configured operation headroom."""


@dataclass(frozen=True)
class DirectoryDiskUsage:
    managed_bytes: int
    reserved_bytes: int
    budget_bytes: int
    growth_paused: bool

    @property
    def over_budget(self) -> bool:
        return self.managed_bytes + self.reserved_bytes > self.budget_bytes


class DirectoryIndexResources:
    """Reserve bounded operations without trimming active catalogue rows."""

    def __init__(self, namespace: Path, policy: DirectoryIndexPolicy | None = None) -> None:
        self.namespace = namespace.absolute()
        self.policy = DirectoryIndexPolicy() if policy is None else DirectoryIndexPolicy.model_validate(policy.model_dump())
        self.lock = threading.RLock()
        self.reserved_bytes = 0
        self.growth_paused = False
        self.active_paths: dict[Path, int] = {}
        self._next_cleanup_at = 0.0

    def register_source(self, path: Path) -> None:
        with self.lock:
            absolute = path.absolute()
            self.active_paths[absolute] = self.active_paths.get(absolute, 0) + 1

    def release_source(self, path: Path) -> None:
        with self.lock:
            absolute = path.absolute()
            owners = self.active_paths.get(absolute, 0)
            if owners > 1:
                self.active_paths[absolute] = owners - 1
            else:
                self.active_paths.pop(absolute, None)
            self._next_cleanup_at = 0.0

    def _inactive_access(self, path: Path) -> int | None:
        if path in self.active_paths or not path.is_file():
            return None
        descriptor = DirectoryIndex.acquire_storage_lease(path)
        try:
            with closing(connect_directory_database(path, readonly=True)) as connection:
                if connection.execute("PRAGMA application_id").fetchone() != (APPLICATION_ID,):
                    return None
                if connection.execute("PRAGMA user_version").fetchone() != (SCHEMA_VERSION,):
                    return None
                metadata = connection.execute("SELECT source_kind, last_access_at_ms FROM source_metadata WHERE id = 1").fetchone()
                if metadata is None or metadata[0] != "smb" or type(metadata[1]) is not int or metadata[1] < 0:
                    return None
                return metadata[1]
        finally:
            os.close(descriptor)

    def _delete_inactive(self, path: Path, expected_access: int) -> bool:
        if path in self.active_paths:
            return False
        validate_storage_ancestors(path.parent)
        directory_descriptor = (
            os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)) if os.name == "posix" else None
        )
        try:
            directory_identity = os.fstat(directory_descriptor) if directory_descriptor is not None else path.parent.lstat()
            descriptor = DirectoryIndex.acquire_storage_lease(path)
            try:
                if not path.is_file():
                    return False
                database_identity = path.lstat()
                with closing(connect_directory_database(path)) as connection:
                    if connection.execute("PRAGMA application_id").fetchone() != (APPLICATION_ID,):
                        return False
                    if connection.execute("SELECT last_access_at_ms FROM source_metadata WHERE id = 1").fetchone() != (expected_access,):
                        return False
                    checkpoint = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                    if checkpoint is None or checkpoint[0] or checkpoint[1] != checkpoint[2]:
                        return False
                validate_storage_ancestors(path.parent)
                current_directory = path.parent.lstat()
                current_database = (
                    os.stat(path.name, dir_fd=directory_descriptor, follow_symlinks=False)
                    if directory_descriptor is not None
                    else path.lstat()
                )
                if (directory_identity.st_dev, directory_identity.st_ino) != (current_directory.st_dev, current_directory.st_ino) or (
                    database_identity.st_dev,
                    database_identity.st_ino,
                ) != (current_database.st_dev, current_database.st_ino):
                    raise PermissionError("Directory storage changed during cleanup. Restore the private namespace and retry cleanup.")
                DirectoryIndex._validate_storage_files(path)
                for suffix in STORAGE_FILE_SUFFIXES:
                    if suffix == ".lease":
                        continue
                    candidate = Path(str(path) + suffix)
                    try:
                        if directory_descriptor is not None:
                            os.unlink(candidate.name, dir_fd=directory_descriptor)
                        else:
                            candidate.unlink()
                    except FileNotFoundError:
                        pass
                logger.debug("Inactive directory storage removed.", extra={"event": "directory_inactive_evicted"})
                return True
            finally:
                os.close(descriptor)
        finally:
            if directory_descriptor is not None:
                os.close(directory_descriptor)

    def cleanup_orphan_leases(self) -> int:
        """Remove a bounded set of unowned leases with no database or sidecars."""
        with self.lock:
            removed = 0
            try:
                entries = os.scandir(self.namespace)
            except FileNotFoundError:
                return 0
            with entries:
                for entry in entries:
                    if removed >= LEASE_CLEANUP_BATCH:
                        break
                    if not entry.name.endswith(".sqlite3.lease"):
                        continue
                    stem = entry.name.removesuffix(".sqlite3.lease")
                    if len(stem) != 64 or any(character not in "0123456789abcdef" for character in stem):
                        continue
                    path = self.namespace / entry.name.removesuffix(".lease")
                    if path in self.active_paths:
                        continue
                    try:
                        removed += DirectoryIndex.remove_orphan_lease(path)
                    except OSError:
                        continue
            return removed

    def cleanup_legacy(self, *, now_ms: int | None = None) -> int:
        """Retire bounded obsolete snapshots without reading them or touching recent writer work."""
        if os.name != "posix":
            return 0
        with self.lock:
            validate_storage_ancestors(self.namespace)
            try:
                descriptor = os.open(self.namespace.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            except FileNotFoundError:
                return 0
            try:
                parent = os.fstat(descriptor)
                if parent.st_uid != os.getuid() or parent.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
                    logger.warning(
                        "Legacy directory-cache cleanup was skipped. Use a cache root owned by the service account "
                        "without group/public write access to permit legacy cleanup."
                    )
                    return 0
                now = int(time.time() * 1000) if now_ms is None else now_ms
                removed = 0
                with os.scandir(descriptor) as entries:
                    for entry in entries:
                        if removed >= LEASE_CLEANUP_BATCH:
                            break
                        path = Path(entry.name)
                        temporary = LEGACY_TEMP_NAME.fullmatch(entry.name) is not None
                        if not temporary:
                            if path.suffix not in LEGACY_SNAPSHOT_SUFFIXES:
                                continue
                            try:
                                if str(UUID(path.stem)) != path.stem:
                                    continue
                            except ValueError:
                                continue
                        try:
                            metadata = entry.stat(follow_symlinks=False)
                            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_nlink != 1:
                                continue
                            if temporary and now - int(metadata.st_mtime * 1000) < self.policy.inactive_retention_seconds * 1000:
                                continue
                            current = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
                            if current != metadata:
                                continue
                            os.unlink(entry.name, dir_fd=descriptor)
                            removed += 1
                        except OSError:
                            continue
                return removed
            finally:
                os.close(descriptor)

    def cleanup_inactive(self, *, now_ms: int | None = None, pressure: bool = False) -> int:
        """Keep bounded recent inactive databases; never delete an owned source."""
        with self.lock:
            self.usage()
            if pressure:
                try:
                    DirectoryIndex.discard_quarantine(self.namespace)
                except OSError:
                    pass
            now = int(time.time() * 1000) if now_ms is None else now_ms
            retained: list[tuple[int, Path, int]] = []
            legacy_removed = self.cleanup_legacy(now_ms=now)
            removed = legacy_removed
            try:
                entries = os.scandir(self.namespace)
            except FileNotFoundError:
                return removed
            with entries:
                for entry in entries:
                    if not entry.name.endswith(".sqlite3"):
                        continue
                    stem = entry.name.removesuffix(".sqlite3")
                    if len(stem) != 64 or any(character not in "0123456789abcdef" for character in stem):
                        continue
                    path = self.namespace / entry.name
                    try:
                        accessed = self._inactive_access(path)
                        if accessed is None:
                            continue
                        effective_access = accessed if accessed <= now else 0
                        if now - effective_access >= self.policy.inactive_retention_seconds * 1000:
                            removed += self._delete_inactive(path, accessed)
                            continue
                        heapq.heappush(retained, (effective_access, path, accessed))
                        if len(retained) > self.policy.max_retained_inactive_sources:
                            _, old_path, old_access = heapq.heappop(retained)
                            removed += self._delete_inactive(old_path, old_access)
                    except (OSError, sqlite3.Error):
                        continue
            while pressure and retained:
                usage = self.usage()
                if (
                    usage.managed_bytes + usage.reserved_bytes + WRITE_HEADROOM_BYTES <= usage.budget_bytes
                    and usage.reserved_bytes + WRITE_HEADROOM_BYTES <= self._available_disk_bytes()
                ):
                    break
                _, path, accessed = heapq.heappop(retained)
                try:
                    removed += self._delete_inactive(path, accessed)
                except (OSError, sqlite3.Error):
                    continue
            self.cleanup_orphan_leases()
            self._next_cleanup_at = (
                0.0
                if legacy_removed == LEASE_CLEANUP_BATCH
                else time.monotonic()
                + min(self.policy.inactive_retention_seconds, DIRECTORY_INDEX_CONTRACT.policy["inactive_retention_seconds"].minimum)
            )
            return removed

    def _directory_bytes(self, directory: Path, *, legacy_only: bool = False) -> int:
        for ancestor in (directory, *directory.parents):
            try:
                metadata = ancestor.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(metadata.st_mode):
                raise ValueError("Directory-index storage must not use symbolic links. Select private local storage.")
        try:
            entries = os.scandir(directory)
        except FileNotFoundError:
            return 0
        total = 0
        with entries:
            for entry in entries:
                if legacy_only and Path(entry.name).suffix not in LEGACY_STORAGE_SUFFIXES:
                    continue
                try:
                    metadata = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if not stat.S_ISREG(metadata.st_mode):
                    raise ValueError("Managed directory-index storage contains unsupported entries. Remove links and non-file entries.")
                total += metadata.st_size
        return total

    def usage(self) -> DirectoryDiskUsage:
        with self.lock:
            managed = self._directory_bytes(self.namespace) + self._directory_bytes(self.namespace.parent, legacy_only=True)
            return DirectoryDiskUsage(managed, self.reserved_bytes, self.policy.disk_budget_bytes, self.growth_paused)

    def _available_disk_bytes(self) -> int:
        for ancestor in (self.namespace, *self.namespace.parents):
            try:
                metadata = ancestor.lstat()
            except FileNotFoundError:
                continue
            if not stat.S_ISDIR(metadata.st_mode):
                raise ValueError("Directory-index storage must use a real directory without links. Select private local storage.")
            return shutil.disk_usage(ancestor).free
        raise ValueError("Directory-index filesystem is unavailable. Restore the cache location before retrying.")

    def apply_policy(self, policy: DirectoryIndexPolicy) -> None:
        validated = DirectoryIndexPolicy.model_validate(policy.model_dump())
        with self.lock:
            self.policy = validated
            self._next_cleanup_at = 0.0
            usage = self.usage()
            self.growth_paused = usage.managed_bytes + usage.reserved_bytes + WRITE_HEADROOM_BYTES > validated.disk_budget_bytes

    @contextmanager
    def reserve_growth(self) -> Iterator[None]:
        with self.lock:
            usage = self.usage()
            pressure = (
                usage.managed_bytes + usage.reserved_bytes + WRITE_HEADROOM_BYTES > self.policy.disk_budget_bytes
                or usage.reserved_bytes + WRITE_HEADROOM_BYTES > self._available_disk_bytes()
            )
            if pressure or time.monotonic() >= self._next_cleanup_at:
                self.cleanup_inactive(pressure=pressure)
                usage = self.usage()
            if usage.managed_bytes + usage.reserved_bytes + WRITE_HEADROOM_BYTES > self.policy.disk_budget_bytes:
                self.growth_paused = True
                raise DirectoryDiskBudgetError(
                    "Directory-index disk headroom is unavailable. Increase the host disk budget or remove eligible inactive indexes, then retry."
                )
            if self.reserved_bytes + WRITE_HEADROOM_BYTES > self._available_disk_bytes():
                self.growth_paused = True
                raise DirectoryDiskBudgetError(
                    "Directory-index filesystem has insufficient free space. Free disk space or select another cache location, then retry."
                )
            self.reserved_bytes += WRITE_HEADROOM_BYTES
            self.growth_paused = False
        try:
            yield
        finally:
            with self.lock:
                self.reserved_bytes -= WRITE_HEADROOM_BYTES
