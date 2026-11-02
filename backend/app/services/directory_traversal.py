"""Handle-bound SMB directory reads without automatic DFS redirection."""

import logging
from collections.abc import Callable, Generator, Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PureWindowsPath
from threading import Lock
from typing import Any
from uuid import UUID

from smbclient._io import SMBFileTransaction, query_info
from smbclient._pool import get_smb_tree
from smbprotocol.exceptions import NoMoreFiles, NoSuchFile, SMBException
from smbprotocol.file_info import FileAllInformation, FileFsVolumeInformation, FileInformationClass
from smbprotocol.open import (
    CreateDisposition,
    CreateOptions,
    DirectoryAccessMask,
    FileAttributes,
    ImpersonationLevel,
    Open,
    QueryDirectoryFlags,
    ShareAccess,
)

from app.services.directory_index import validate_directory_path

DIRECTORY_READ_BUFFER_BYTES = 64 * 1024
SOURCE_BINDING_ERROR = "Directory source binding changed or is unsupported. Reconnect the source and retry verification."
UNSAFE_COMPONENT_CHARACTERS = frozenset('\\/:*?"<>|')
SMB_TIME_ORIGIN = datetime(1601, 1, 1, tzinfo=timezone.utc)
logger = logging.getLogger(__name__)


class DirectoryTraversalError(OSError):
    """The directory source cannot establish safe traversal."""


class DirectoryBindingChangedError(DirectoryTraversalError):
    """The pinned source root cannot be reused."""


def _component(name: str) -> None:
    validate_directory_path(name)
    if any(character in UNSAFE_COMPONENT_CHARACTERS or ord(character) < 32 for character in name) or name.endswith((".", " ")):
        raise DirectoryTraversalError("Directory name cannot be read safely through SMB. Rename the entry and retry verification.")


@dataclass(frozen=True)
class SmbDirectoryIdentity:
    server_guid: UUID
    session_id: int
    tree_id: int
    volume_serial: int
    volume_created: datetime
    file_id: int
    native_name: str

    def same_volume(self, other: "SmbDirectoryIdentity") -> bool:
        return (
            self.server_guid,
            self.session_id,
            self.tree_id,
            self.volume_serial,
            self.volume_created,
        ) == (
            other.server_guid,
            other.session_id,
            other.tree_id,
            other.volume_serial,
            other.volume_created,
        )


@dataclass(frozen=True)
class SmbDirectoryEntryInformation:
    file_attributes: int


@dataclass(frozen=True)
class SmbDirectoryEntry:
    name: str | None
    smb_info: SmbDirectoryEntryInformation


class SmbDirectoryHandle:
    """Own one no-follow handle; disconnected handles cannot reopen themselves."""

    def __init__(self, path: str, check: Callable[[], None], **session: Any) -> None:
        check()
        requested = PureWindowsPath(path)
        tree, native_path = get_smb_tree(path, **session)
        expected_native = "\\".join(requested.parts[1:])
        if (
            not requested.is_absolute()
            or not requested.drive.startswith("\\\\")
            or tree.is_dfs_share is not False
            or PureWindowsPath(tree.share_name) != PureWindowsPath(requested.drive)
            or native_path != expected_native
        ):
            raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
        self.fd = Open(tree, native_path)
        try:
            self.fd.create(
                ImpersonationLevel.Impersonation,
                DirectoryAccessMask.FILE_LIST_DIRECTORY | DirectoryAccessMask.FILE_READ_ATTRIBUTES,
                FileAttributes.FILE_ATTRIBUTE_DIRECTORY,
                ShareAccess.FILE_SHARE_READ | ShareAccess.FILE_SHARE_WRITE,
                CreateDisposition.FILE_OPEN,
                CreateOptions.FILE_DIRECTORY_FILE | CreateOptions.FILE_OPEN_REPARSE_POINT,
            )
            check()
            if self.fd.file_attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT:
                raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
        except BaseException:
            try:
                if not self.closed:
                    self.close()
            except Exception as error:
                logger.warning("Directory handle cleanup failed (%s).", type(error).__name__)
            raise

    @property
    def closed(self) -> bool:
        return not self.fd.connected

    @property
    def name(self) -> str:
        return "Directory index source"

    def open(self, **kwargs: Any) -> None:
        raise DirectoryTraversalError(SOURCE_BINDING_ERROR)

    def close(self) -> None:
        self.fd.close()

    def identity(self, check: Callable[[], None]) -> SmbDirectoryIdentity:
        check()
        with SMBFileTransaction(self) as transaction:
            query_info(transaction, FileFsVolumeInformation, output_buffer_length=DIRECTORY_READ_BUFFER_BYTES)
            query_info(transaction, FileAllInformation, output_buffer_length=DIRECTORY_READ_BUFFER_BYTES)
        check()
        volume, information = transaction.results
        internal = information["internal_information"].get_value()
        name = information["name_information"].get_value()
        standard = information["standard_information"].get_value()
        basic = information["basic_information"].get_value()
        tree = self.fd.tree_connect
        server_guid = self.fd.connection.server_guid
        volume_created = volume["volume_creation_time"].get_value()
        native_name = name["file_name"].get_value()
        numbers = (
            tree.session.session_id,
            tree.tree_connect_id,
            volume["volume_serial_number"].get_value(),
            internal["index_number"].get_value(),
        )
        if (
            self.closed
            or tree.is_dfs_share is not False
            or not standard["directory"].get_value()
            or standard["delete_pending"].get_value()
            or basic["file_attributes"].get_value() & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT
            or not isinstance(server_guid, UUID)
            or not server_guid.int
            or any(type(value) is not int or value <= 0 for value in numbers)
            or not isinstance(volume_created, datetime)
            or volume_created.tzinfo is None
            or volume_created <= SMB_TIME_ORIGIN
            or not isinstance(native_name, str)
            or not native_name.startswith("\\")
            or native_name.startswith("\\\\")
        ):
            raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
        native_name.encode("utf-16-le", errors="strict")
        for component in native_name.split("\\")[1:]:
            if component:
                _component(component)
            elif native_name != "\\":
                raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
        return SmbDirectoryIdentity(server_guid, numbers[0], numbers[1], numbers[2], volume_created, numbers[3], native_name)

    def records(self, check: Callable[[], None], *, pattern: str = "*") -> Generator[Any, None, None]:
        flags = QueryDirectoryFlags.SMB2_RESTART_SCANS | QueryDirectoryFlags.SMB2_REOPEN
        while True:
            check()
            if self.closed:
                raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
            try:
                records = self.fd.query_directory(
                    pattern,
                    FileInformationClass.FILE_ID_FULL_DIRECTORY_INFORMATION,
                    flags=flags,
                    max_output=DIRECTORY_READ_BUFFER_BYTES,
                )
            except (NoMoreFiles, NoSuchFile):
                check()
                return
            check()
            if not records:
                raise DirectoryTraversalError("Directory enumeration made no progress. Reconnect the source and retry verification.")
            flags = 0
            for record in records:
                check()
                yield record


class SmbDirectoryRead(Iterator[SmbDirectoryEntry]):
    """Keep the complete parent chain held until the scan and pruning exit."""

    def __init__(
        self,
        handles: list[SmbDirectoryHandle],
        identities: list[SmbDirectoryIdentity],
        check: Callable[[], None],
        *,
        retained: int = 0,
    ) -> None:
        self._handles = handles
        self._identities = identities
        self._check = check
        self._retained = retained
        self._records = handles[-1].records(check)

    def __next__(self) -> SmbDirectoryEntry:
        while True:
            record = next(self._records)
            attributes = record["file_attributes"].get_value()
            if type(attributes) is not int or attributes < 0:
                raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
            try:
                name = record["file_name"].get_value().decode("utf-16-le", errors="strict")
                if name in (".", ".."):
                    continue
                _component(name)
            except (UnicodeError, ValueError, DirectoryTraversalError):
                if attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY:
                    return SmbDirectoryEntry(None, SmbDirectoryEntryInformation(attributes))
                continue
            return SmbDirectoryEntry(name, SmbDirectoryEntryInformation(attributes))

    def verify(self) -> None:
        self._check()
        if not self._handles or self._handles[-1].identity(self._check) != self._identities[-1]:
            raise DirectoryTraversalError(SOURCE_BINDING_ERROR)

    def has_directory_child(self, name: str) -> bool:
        _component(name)
        native_name = name.encode("utf-16-le", errors="strict")
        self.verify()
        records = self._handles[-1].records(self._check, pattern=name)
        try:
            for record in records:
                if record["file_name"].get_value() != native_name:
                    continue
                attributes = record["file_attributes"].get_value()
                if attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT:
                    raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
                self.verify()
                return bool(attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY)
        finally:
            records.close()
        self.verify()
        return False

    def close(self) -> None:
        self._records.close()
        handles, self._handles = self._handles, []
        _close_handles(handles[self._retained :])


def _close_handles(handles: list[SmbDirectoryHandle]) -> None:
    failure: Exception | None = None
    for handle in reversed(handles):
        try:
            handle.close()
        except Exception as error:
            if failure is None:
                failure = error
            else:
                logger.warning("Directory handle cleanup failed (%s).", type(error).__name__)
    if failure is not None:
        raise failure


class SmbDirectoryRoot:
    """Own no-delete root handles until source workers and shutdown finish."""

    def __init__(self, path: str) -> None:
        self._path = PureWindowsPath(path)
        if not self._path.is_absolute() or not self._path.drive.startswith("\\\\") or self._path.drive.startswith(("\\\\?", "\\\\.")):
            raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
        self._prefix = self._path.parts[1:]
        for component in self._prefix:
            _component(component)
        self._binding: tuple[SmbDirectoryIdentity, ...] | None = None
        self._held_handles: list[SmbDirectoryHandle] = []
        self._closed = False
        self._lock = Lock()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            handles, self._held_handles = self._held_handles, []
        _close_handles(handles)

    def read(self, parent: str, check: Callable[[], None], **session: Any) -> SmbDirectoryRead:
        if parent:
            validate_directory_path(parent)
        components = (*self._prefix, *(parent.split("/") if parent else ()))
        handles: list[SmbDirectoryHandle] = []
        identities: list[SmbDirectoryIdentity] = []
        try:
            with self._lock:
                check()
                if self._closed:
                    raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
                for held, expected in zip(self._held_handles, self._binding or (), strict=True):
                    try:
                        if held.identity(check) != expected:
                            raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
                    except (OSError, SMBException, ValueError) as error:
                        if isinstance(error, InterruptedError):
                            raise
                        raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR) from error
            path = PureWindowsPath(self._path.anchor)
            for position in range(len(components) + 1):
                check()
                if position:
                    component = components[position - 1]
                    _component(component)
                    path /= component
                try:
                    handle = SmbDirectoryHandle(str(path), check, **session)
                    handles.append(handle)
                    identity = handle.identity(check)
                except (OSError, SMBException, ValueError) as error:
                    if position <= len(self._prefix) and not isinstance(error, InterruptedError):
                        raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR) from error
                    raise
                if identities and (
                    not identity.same_volume(identities[-1])
                    or identity.native_name != identities[-1].native_name.rstrip("\\") + "\\" + components[position - 1]
                ):
                    raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
                identities.append(identity)
            binding = tuple(identities[: len(self._prefix) + 1])
            with self._lock:
                check()
                if self._closed:
                    raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
                if self._binding is None:
                    self._binding = binding
                    self._held_handles = handles[: len(binding)]
                    return SmbDirectoryRead(handles, identities, check, retained=len(binding))
                elif binding != self._binding:
                    raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
            return SmbDirectoryRead(handles, identities, check)
        except BaseException:
            try:
                _close_handles(handles)
            except Exception as error:
                logger.warning("Directory handle cleanup failed (%s).", type(error).__name__)
            raise
