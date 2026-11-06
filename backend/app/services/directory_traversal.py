"""Handle-bound SMB directory reads without automatic DFS redirection."""

import logging
import time
from collections.abc import Callable, Generator, Iterator
from dataclasses import dataclass
from datetime import datetime
from pathlib import PureWindowsPath
from struct import error as StructError
from threading import RLock
from typing import Any
from uuid import UUID

from smbclient._io import SMBFileTransaction, query_info
from smbclient._pool import get_smb_tree
from smbprotocol.exceptions import NoMoreFiles, NoSuchFile, SMBException, SMBResponseException
from smbprotocol.file_info import FileAllInformation, FileFsVolumeInformation, FileInformationClass, FileInternalInformation
from smbprotocol.header import NtStatus
from smbprotocol.open import (
    CreateDisposition,
    CreateOptions,
    DirectoryAccessMask,
    FileAttributes,
    ImpersonationLevel,
    Open,
    QueryDirectoryFlags,
    ShareAccess,
    SMB2QueryInfoRequest,
    SMB2QueryInfoResponse,
)

from app.core.directory_index_contract import DIRECTORY_INDEX_CONTRACT
from app.services.directory_index import validate_directory_path

DIRECTORY_READ_BUFFER_BYTES = 64 * 1024
SCAN_QUERY_BUFFER_MAX_BYTES = DIRECTORY_INDEX_CONTRACT.limits["scan_query_buffer_max_bytes"]
SMB_CREDIT_BYTES = 64 * 1024
COMPOUND_FIXED_CREDITS = 3
COMPOUND_DIRECTORY_QUERIES = 2
SCAN_PIPELINE_DEPTH = DIRECTORY_INDEX_CONTRACT.limits["scan_pipeline_depth"]
SCAN_CREDIT_RESERVE = DIRECTORY_INDEX_CONTRACT.limits["scan_credit_reserve"]
MAX_SOURCE_DEPTH = DIRECTORY_INDEX_CONTRACT.limits["max_source_depth"]
MAX_SOURCE_PATH_BYTES = DIRECTORY_INDEX_CONTRACT.limits["max_source_path_bytes"]
SOURCE_BINDING_ERROR = "Directory source binding changed or is unsupported. Reconnect the source and retry verification."
TRAVERSAL_LIMIT_ERROR = (
    "Directory path exceeds the supported traversal bounds. Shorten the path or reduce nesting, then reconnect the source."
)
UNSAFE_COMPONENT_CHARACTERS = frozenset('\\/:*?"<>|')
SMB_UNAVAILABLE_FILE_IDS = frozenset((0, 0xFFFFFFFFFFFFFFFF))
OPTIONAL_INFORMATION_UNAVAILABLE = frozenset(
    (NtStatus.STATUS_INVALID_INFO_CLASS, NtStatus.STATUS_NOT_SUPPORTED, NtStatus.STATUS_INVALID_PARAMETER)
)
logger = logging.getLogger(__name__)


class DirectoryTraversalError(OSError):
    """The directory source cannot establish safe traversal."""


class DirectoryBindingChangedError(DirectoryTraversalError):
    """The pinned source root cannot be reused."""


class DirectoryPipelineTimeout(TimeoutError):
    """In-flight scan responses require retirement of their connection generation."""


class DirectoryPipelineTransportError(ConnectionError):
    """A failed compound send can leave partially admitted requests on the connection."""


def _validate_traversal_path(path: str) -> None:
    if (
        len(path) > MAX_SOURCE_PATH_BYTES
        or len(path.encode("utf-8")) > MAX_SOURCE_PATH_BYTES
        or (bool(path) and path.count("/") >= MAX_SOURCE_DEPTH)
    ):
        raise DirectoryTraversalError(TRAVERSAL_LIMIT_ERROR)


def _component(name: str) -> None:
    validate_directory_path(name)
    if any(character in UNSAFE_COMPONENT_CHARACTERS or ord(character) < 32 for character in name) or name.endswith((".", " ")):
        raise DirectoryTraversalError("Directory name cannot be read safely through SMB. Rename the entry and retry verification.")


@dataclass(frozen=True)
class SmbDirectoryIdentity:
    server_guid: UUID
    session_id: int
    tree_id: int
    volume_serial: int | None
    volume_created: datetime | None
    file_id: int
    native_name: str

    def same_binding(self, other: "SmbDirectoryIdentity") -> bool:
        return (
            self.session_id,
            self.tree_id,
            self.native_name,
        ) == (
            other.session_id,
            other.tree_id,
            other.native_name,
        ) and (self.file_id in SMB_UNAVAILABLE_FILE_IDS or other.file_id in SMB_UNAVAILABLE_FILE_IDS or self.file_id == other.file_id)


@dataclass(frozen=True)
class SmbDirectoryEntryInformation:
    file_attributes: int


@dataclass(frozen=True)
class SmbDirectoryEntry:
    name: str | None
    smb_info: SmbDirectoryEntryInformation
    file_id: bytes | None = None


def _directory_tree(path: str, **session: Any) -> tuple[Any, str]:
    requested = PureWindowsPath(path)
    tree, native_path = get_smb_tree(path, **session)
    if (
        not requested.is_absolute()
        or not requested.drive.startswith("\\\\")
        or tree.is_dfs_share is not False
        or PureWindowsPath(tree.share_name) != PureWindowsPath(requested.drive)
        or native_path != "\\".join(requested.parts[1:])
    ):
        raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
    return tree, native_path


@dataclass(frozen=True)
class _SmbVolumeInformation:
    tree: Any
    connection: Any
    session_id: int
    tree_id: int
    serial: int | None
    created: datetime | None

    def matches(self, tree: Any) -> bool:
        return (
            self.tree is tree
            and self.connection is tree.session.connection
            and self.session_id == tree.session.session_id
            and self.tree_id == tree.tree_connect_id
        )


class SmbDirectoryIo:
    """Count scan-owned request groups, including failed send attempts."""

    def __init__(self) -> None:
        self._round_trips = 0
        self._lock = RLock()

    @property
    def round_trips(self) -> int:
        with self._lock:
            return self._round_trips

    def record_request(self) -> None:
        with self._lock:
            self._round_trips += 1


class SmbDirectoryHandle:
    """Own one no-follow handle; disconnected handles cannot reopen themselves."""

    def __init__(
        self,
        path: str,
        check: Callable[[], None],
        *,
        capabilities: dict[str, bool] | None = None,
        volume_cache: dict[int, _SmbVolumeInformation] | None = None,
        io: SmbDirectoryIo | None = None,
        **session: Any,
    ) -> None:
        check()
        self._capabilities = capabilities if capabilities is not None else {}
        self._volume_cache = volume_cache if volume_cache is not None else {}
        self._io = io if io is not None else SmbDirectoryIo()
        tree, native_path = _directory_tree(path, **session)
        self.fd = Open(tree, native_path)
        try:
            self._io.record_request()
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
        if not self.closed:
            self._io.record_request()
        self.fd.close()

    def identity(self, check: Callable[[], None]) -> SmbDirectoryIdentity:
        check()
        with SMBFileTransaction(self) as transaction:
            query_info(transaction, FileAllInformation, output_buffer_length=DIRECTORY_READ_BUFFER_BYTES)
            self._io.record_request()
        check()
        (information,) = transaction.results
        tree = self.fd.tree_connect
        cached_volume = self._volume_cache.get(id(tree))
        volume_serial = None
        volume_created = None
        if cached_volume is not None and cached_volume.matches(tree):
            volume_serial = cached_volume.serial
            volume_created = cached_volume.created
        elif self._capabilities.get("volume_information", True):
            try:
                with SMBFileTransaction(self) as volume_transaction:
                    query_info(volume_transaction, FileFsVolumeInformation, output_buffer_length=DIRECTORY_READ_BUFFER_BYTES)
                    self._io.record_request()
                (volume,) = volume_transaction.results
                volume_serial = volume["volume_serial_number"].get_value()
                volume_created = volume["volume_creation_time"].get_value()
            except SMBResponseException as error:
                if error.status not in OPTIONAL_INFORMATION_UNAVAILABLE:
                    raise
            check()
            self._volume_cache[id(tree)] = _SmbVolumeInformation(
                tree,
                tree.session.connection,
                tree.session.session_id,
                tree.tree_connect_id,
                volume_serial,
                volume_created,
            )
        check()
        internal = information["internal_information"].get_value()
        name = information["name_information"].get_value()
        standard = information["standard_information"].get_value()
        basic = information["basic_information"].get_value()
        tree = self.fd.tree_connect
        server_guid = self.fd.connection.server_guid
        native_name = name["file_name"].get_value()
        numbers = (
            tree.session.session_id,
            tree.tree_connect_id,
            internal["index_number"].get_value(),
        )
        if (
            self.closed
            or tree.is_dfs_share is not False
            or not standard["directory"].get_value()
            or standard["delete_pending"].get_value()
            or basic["file_attributes"].get_value() & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT
            or not isinstance(server_guid, UUID)
            or any(type(value) is not int for value in numbers)
            or not isinstance(native_name, str)
            or not native_name.startswith("\\")
            or native_name.startswith("\\\\")
        ):
            raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
        _validate_traversal_path(native_name.replace("\\", "/").lstrip("/"))
        native_name.encode("utf-16-le", errors="strict")
        for component in native_name.split("\\")[1:]:
            if component:
                _component(component)
            elif native_name != "\\":
                raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
        return SmbDirectoryIdentity(server_guid, numbers[0], numbers[1], volume_serial, volume_created, numbers[2], native_name)

    def records(self, check: Callable[[], None], *, pattern: str = "*") -> Generator[Any, None, None]:
        flags = QueryDirectoryFlags.SMB2_RESTART_SCANS | QueryDirectoryFlags.SMB2_REOPEN
        while True:
            check()
            if self.closed:
                raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
            connection = self.fd.connection
            maximum = min(connection.max_transact_size, SCAN_QUERY_BUFFER_MAX_BYTES)
            if connection.supports_multi_credit:
                with connection.sequence_lock:
                    available = connection.sequence_window["high"] - connection.sequence_window["low"]
                maximum = min(maximum, max(1, available - SCAN_CREDIT_RESERVE) * SMB_CREDIT_BYTES)
            else:
                maximum = min(maximum, SMB_CREDIT_BYTES)
            try:
                self._io.record_request()
                records = self.fd.query_directory(
                    pattern,
                    FileInformationClass.FILE_ID_FULL_DIRECTORY_INFORMATION,
                    flags=flags,
                    max_output=maximum,
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
    """Own a checked listing and any handles retained through scan and pruning."""

    def __init__(
        self,
        handles: list[SmbDirectoryHandle],
        identities: list[SmbDirectoryIdentity],
        check: Callable[[], None],
        *,
        retained: int = 0,
        safe_child_lookup: Callable[[str], bool] | None = None,
        local_verify: Callable[[], None] | None = None,
    ) -> None:
        self._handles = handles
        self._identities = identities
        self._check = check
        self._retained = retained
        self._safe_child_lookup = safe_child_lookup
        self._local_verify = local_verify
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
                if attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY:
                    parent = self._identities[-1].native_name.replace("\\", "/").lstrip("/")
                    _validate_traversal_path(f"{parent}/{name}" if parent else name)
            except (UnicodeError, ValueError, DirectoryTraversalError):
                if attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY:
                    return SmbDirectoryEntry(None, SmbDirectoryEntryInformation(attributes))
                continue
            try:
                file_id = record["file_id"].get_value()
            except KeyError:
                file_id = None
            if file_id is not None and (type(file_id) is not int or not 0 <= file_id <= 0xFFFFFFFFFFFFFFFF):
                raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
            expected_id = None if file_id is None or file_id in SMB_UNAVAILABLE_FILE_IDS else file_id.to_bytes(8, "little")
            return SmbDirectoryEntry(name, SmbDirectoryEntryInformation(attributes), expected_id)

    def verify_file_id(self, expected: bytes) -> None:
        self._check()
        if not self._identities or self._identities[-1].file_id.to_bytes(8, "little") != expected:
            raise DirectoryTraversalError("Directory FileId changed. Retry verification of its parent.")

    def verify(self) -> None:
        self._check()
        if self._local_verify is not None:
            self._local_verify()
            return
        if not self._handles or not self._handles[-1].identity(self._check).same_binding(self._identities[-1]):
            raise DirectoryTraversalError(SOURCE_BINDING_ERROR)

    def has_directory_child(self, name: str) -> bool:
        if self._safe_child_lookup is not None:
            return self._safe_child_lookup(name)
        _component(name)
        parent = self._identities[-1].native_name.replace("\\", "/").lstrip("/")
        _validate_traversal_path(f"{parent}/{name}" if parent else name)
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


class _NoFollowConnection:
    """Keep smbprotocol response callbacks from replaying a redirected CREATE."""

    def __init__(self, connection: Any, deadline: float | None = None) -> None:
        self._connection = connection
        self._deadline = deadline

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)

    def receive(self, request: Any) -> Any:
        if self._deadline is None:
            return self._connection.receive(request, resolve_symlinks=False)
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise DirectoryPipelineTimeout("Directory pipeline response timed out. Retry verification after the connection recovers.")
        try:
            return self._connection.receive(request, resolve_symlinks=False, timeout=remaining)
        except SMBException as error:
            if time.monotonic() >= self._deadline:
                raise DirectoryPipelineTimeout("Directory pipeline response timed out. Retry after the connection recovers.") from error
            raise


class SmbCompoundDirectoryReader(SmbDirectoryRead):
    """Read and close a known directory in one related compound, or request fallback."""

    def __init__(
        self,
        tree: Any,
        native_path: str,
        expected_id: bytes,
        check: Callable[[], None],
        *,
        safe_child_lookup: Callable[[str], bool] | None = None,
        deferred: bool = False,
        credit_reserve: int = 0,
        timeout: float | None = None,
        fallback: Callable[[], SmbDirectoryRead] | None = None,
        io: SmbDirectoryIo | None = None,
    ) -> None:
        self._check = check
        self._io = io if io is not None else SmbDirectoryIo()
        self._handles = []
        self._identities = []
        self._retained = 0
        self._safe_child_lookup = safe_child_lookup
        self._closed = False
        self.complete = False
        self._pending: tuple[Any, list[Any], list[Any], Any, str, bytes] | None = None
        self._fallback = fallback
        self.connection = tree.session.connection
        self._tree = tree
        self.sent = False
        self._records = self._checked_records(())
        if len(expected_id) != 8 or int.from_bytes(expected_id, "little") in SMB_UNAVAILABLE_FILE_IDS:
            raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
        check()
        connection = tree.session.connection
        maximum = min(connection.max_transact_size, SCAN_QUERY_BUFFER_MAX_BYTES)
        if not connection.supports_multi_credit:
            maximum = min(maximum, SMB_CREDIT_BYTES)
        with connection.sequence_lock:
            available = connection.sequence_window["high"] - connection.sequence_window["low"]
        full_charge = COMPOUND_FIXED_CREDITS + COMPOUND_DIRECTORY_QUERIES * ((maximum + SMB_CREDIT_BYTES - 1) // SMB_CREDIT_BYTES)
        self.credit_target = SCAN_PIPELINE_DEPTH * full_charge + credit_reserve
        query_credits = (available - credit_reserve - COMPOUND_FIXED_CREDITS) // COMPOUND_DIRECTORY_QUERIES
        maximum = min(maximum, query_credits * SMB_CREDIT_BYTES)
        if maximum < 1:
            return
        descriptor = Open(tree, native_path)
        descriptor.connection = _NoFollowConnection(connection, None if timeout is None else time.monotonic() + timeout)
        create = descriptor.create(
            ImpersonationLevel.Impersonation,
            DirectoryAccessMask.FILE_LIST_DIRECTORY | DirectoryAccessMask.FILE_READ_ATTRIBUTES,
            FileAttributes.FILE_ATTRIBUTE_DIRECTORY,
            ShareAccess.FILE_SHARE_READ | ShareAccess.FILE_SHARE_WRITE | ShareAccess.FILE_SHARE_DELETE,
            CreateDisposition.FILE_OPEN,
            CreateOptions.FILE_DIRECTORY_FILE | CreateOptions.FILE_OPEN_REPARSE_POINT,
            send=False,
        )
        information = FileInternalInformation()
        query = SMB2QueryInfoRequest()
        query["info_type"] = information.INFO_TYPE
        query["file_info_class"] = information.INFO_CLASS
        query["file_id"] = descriptor.file_id
        query["output_buffer_length"] = len(information)

        def receive_identity(request: Any) -> Any:
            response = descriptor.connection.receive(request)
            parsed = SMB2QueryInfoResponse()
            parsed.unpack(response["data"].get_value())
            return parsed.parse_buffer(FileInternalInformation)

        actions = [
            create,
            (query, receive_identity),
            descriptor.query_directory(
                "*",
                FileInformationClass.FILE_ID_FULL_DIRECTORY_INFORMATION,
                flags=QueryDirectoryFlags.SMB2_RESTART_SCANS,
                max_output=maximum,
                send=False,
            ),
            descriptor.query_directory(
                "*",
                FileInformationClass.FILE_ID_FULL_DIRECTORY_INFORMATION,
                flags=0,
                max_output=maximum,
                send=False,
            ),
            descriptor.close(send=False),
        ]
        check()
        messages = [message for message, _receive in actions]
        if credit_reserve:
            send_scan_compound = getattr(connection, "send_scan_compound", None)
            if not callable(send_scan_compound):
                return
            try:
                requests = send_scan_compound(
                    messages,
                    session_id=tree.session.session_id,
                    tree_id=tree.tree_connect_id,
                    reserve=credit_reserve,
                    credit_target=self.credit_target,
                )
            except Exception as error:
                self._io.record_request()
                raise DirectoryPipelineTransportError(
                    "Directory compound send failed. Reconnect the source and retry verification."
                ) from error
            if requests is None:
                return
            self._io.record_request()
        else:
            self._io.record_request()
            requests = connection.send_compound(messages, tree.session.session_id, tree.tree_connect_id, related=True)
        self.sent = True
        self._pending = (descriptor, actions, requests, tree, native_path, expected_id)
        if not deferred:
            self.finish()

    def grow_credits(self, timeout: float) -> None:
        """Use one bounded echo when no compound can fit and none is in flight."""
        with self.connection.sequence_lock:
            available = self.connection.sequence_window["high"] - self.connection.sequence_window["low"]
        if available > 0:
            self._io.record_request()
            self.connection.echo(sid=self._tree.session.session_id, timeout=timeout, credit_request=self.credit_target)

    def result(self) -> SmbDirectoryRead:
        self.finish()
        if self.complete:
            return self
        if self._fallback is None:
            raise DirectoryTraversalError("Directory read needs loop traversal. Retry source verification.")
        self.close()
        return self._fallback()

    def finish(self) -> None:
        """Drain this parent's responses exactly once before publishing its listing."""
        pending, self._pending = self._pending, None
        if pending is None:
            return
        descriptor, actions, requests, tree, native_path, expected_id = pending
        connection = tree.session.connection
        results: list[Any] = []
        exhausted: set[int] = set()
        failure: BaseException | None = None
        closed = False
        attributes = None
        for position, ((_message, receive), request) in enumerate(zip(actions, requests, strict=True)):
            result = None
            try:
                result = receive(request)
                if position == 0:
                    attributes = descriptor.file_attributes
                    if (
                        type(attributes) is not int
                        or not attributes & FileAttributes.FILE_ATTRIBUTE_DIRECTORY
                        or attributes & FileAttributes.FILE_ATTRIBUTE_REPARSE_POINT
                    ) and failure is None:
                        failure = DirectoryTraversalError(SOURCE_BINDING_ERROR)
                if position == 1:
                    actual_id = result["index_number"].get_value()
                    if (type(actual_id) is not int or actual_id != int.from_bytes(expected_id, "little")) and failure is None:
                        failure = DirectoryTraversalError("Directory FileId changed. Retry verification of its parent.")
                if position == len(actions) - 1:
                    closed = True
            except (NoMoreFiles, NoSuchFile) as error:
                if position in (2, 3):
                    exhausted.add(position)
                elif failure is None:
                    failure = error
            except (StructError, ValueError):
                if failure is None:
                    failure = DirectoryTraversalError(
                        "Directory enumeration returned invalid response data. Reconnect the source and retry verification."
                    )
            except BaseException as error:
                if failure is None or isinstance(error, TimeoutError):
                    failure = error
            results.append(result)
        if not closed and attributes is not None:
            try:
                close_message, receive_close = descriptor.close(send=False)
                self._io.record_request()
                receive_close(connection.send(close_message, tree.session.session_id, tree.tree_connect_id))
            except TimeoutError as error:
                failure = error
            except Exception as error:
                logger.warning("Directory compound cleanup failed (%s).", type(error).__name__)
        if failure is not None:
            raise failure
        self._check()
        actual_id = int.from_bytes(expected_id, "little")
        self._identities = [
            SmbDirectoryIdentity(
                connection.server_guid,
                tree.session.session_id,
                tree.tree_connect_id,
                None,
                None,
                actual_id,
                "\\" + native_path,
            )
        ]
        if not exhausted:
            if not results[2] or not results[3]:
                raise DirectoryTraversalError("Directory enumeration made no progress. Retry source verification.")
            return
        if 2 in exhausted and results[3]:
            raise DirectoryTraversalError("Directory enumeration changed after completion. Retry source verification.")
        if 2 not in exhausted and not results[2]:
            raise DirectoryTraversalError("Directory enumeration made no progress. Retry source verification.")
        self.complete = True
        self._records = self._checked_records(results[2] or ())

    def _checked_records(self, records: Any) -> Generator[Any, None, None]:
        for record in records:
            self.verify()
            yield record

    def __next__(self) -> SmbDirectoryEntry:
        self.finish()
        self.verify()
        return super().__next__()

    def verify(self) -> None:
        self._check()
        if self._closed or not self.complete:
            raise DirectoryTraversalError(SOURCE_BINDING_ERROR)

    def has_directory_child(self, name: str) -> bool:
        self.verify()
        if self._safe_child_lookup is None:
            raise DirectoryTraversalError("Directory child validation needs the bound root. Retry source verification.")
        return self._safe_child_lookup(name)

    def close(self) -> None:
        try:
            self.finish()
        finally:
            self._closed = True
            super().close()


class SmbDirectoryRoot:
    """Own no-delete root handles until source workers and shutdown finish."""

    def __init__(self, path: str) -> None:
        self._path = PureWindowsPath(path)
        self.io = SmbDirectoryIo()
        if not self._path.is_absolute() or not self._path.drive.startswith("\\\\") or self._path.drive.startswith(("\\\\?", "\\\\.")):
            raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
        self._prefix = self._path.parts[1:]
        _validate_traversal_path("/".join(self._prefix))
        for component in self._prefix:
            _component(component)
        self._binding: tuple[SmbDirectoryIdentity, ...] | None = None
        self._capabilities: dict[str, bool] = {}
        self._volume_cache: dict[int, _SmbVolumeInformation] = {}
        self._held_handles: list[SmbDirectoryHandle] = []
        self._verification_version = 0
        self._verified_version = 0
        self._closed = False
        self._lock = RLock()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            handles, self._held_handles = self._held_handles, []
        _close_handles(handles)

    def replacement(self) -> "SmbDirectoryRoot":
        """Bind fresh handles after a connection or root-binding change."""
        replacement = SmbDirectoryRoot(str(self._path))
        replacement.io = self.io
        self.close()
        return replacement

    def require_verification(self) -> None:
        """Require a full root probe after a source read fails."""
        with self._lock:
            self._verification_version += 1

    def read(self, parent: str, check: Callable[[], None], *, full_root_check: bool = True, **session: Any) -> SmbDirectoryRead:
        _validate_traversal_path(parent)
        _validate_traversal_path("/".join((*self._prefix, parent)) if parent else "/".join(self._prefix))
        if parent:
            validate_directory_path(parent)
        components = (*self._prefix, *(parent.split("/") if parent else ()))
        handles: list[SmbDirectoryHandle] = []
        identities: list[SmbDirectoryIdentity] = []
        retained = 0
        read_check = check

        def check_binding() -> None:
            self._observed_binding(check)

        try:
            with self._lock:
                check()
                if self._closed:
                    raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
                verification_version = self._verification_version
                full_root_check = full_root_check or verification_version != self._verified_version
                if not full_root_check and self._binding is not None:
                    check_binding()
                    handles.extend(self._held_handles)
                    identities.extend(self._binding)
                    retained = len(handles)
                    read_check = check_binding
                    components = tuple(parent.split("/")) if parent else ()
                else:
                    for held, expected in zip(self._held_handles, self._binding or (), strict=True):
                        try:
                            if not held.identity(check).same_binding(expected):
                                raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
                        except (OSError, SMBException, ValueError) as error:
                            if isinstance(error, InterruptedError):
                                raise
                            raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR) from error
            path = self._path if retained else PureWindowsPath(self._path.anchor)
            for position in range(1 if retained else 0, len(components) + 1):
                read_check()
                if position:
                    component = components[position - 1]
                    _component(component)
                    path /= component
                try:
                    handle = SmbDirectoryHandle(
                        str(path),
                        read_check,
                        capabilities=self._capabilities,
                        volume_cache=self._volume_cache,
                        io=self.io,
                        **session,
                    )
                    handles.append(handle)
                    if retained and handle.fd.connection is not self._held_handles[-1].fd.connection:
                        raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
                    identity = handle.identity(read_check)
                except (OSError, SMBException, ValueError) as error:
                    if not retained and position <= len(self._prefix) and not isinstance(error, InterruptedError):
                        raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR) from error
                    raise
                if identities and (
                    identity.session_id != identities[-1].session_id
                    or identity.tree_id != identities[-1].tree_id
                    or identity.native_name != identities[-1].native_name.rstrip("\\") + "\\" + components[position - 1]
                ):
                    raise DirectoryTraversalError(SOURCE_BINDING_ERROR)
                identities.append(identity)
            binding = tuple(identities[: len(self._prefix) + 1])
            with self._lock:
                read_check()
                if self._closed:
                    raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
                if full_root_check:
                    self._verified_version = verification_version
                if self._binding is None:
                    self._binding = binding
                    self._held_handles = handles[: len(binding)]
                    return SmbDirectoryRead(handles, identities, check, retained=len(binding))
                elif not all(current.same_binding(expected) for current, expected in zip(binding, self._binding, strict=True)):
                    raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
            return SmbDirectoryRead(
                handles,
                identities,
                read_check,
                retained=retained,
                local_verify=check_binding if retained and not parent else None,
            )
        except BaseException:
            self.require_verification()
            try:
                _close_handles(handles[retained:])
            except Exception as error:
                logger.warning("Directory handle cleanup failed (%s).", type(error).__name__)
            raise

    def _observed_binding(self, check: Callable[[], None]) -> SmbDirectoryIdentity:
        with self._lock:
            check()
            if self._closed or self._binding is None or not self._held_handles:
                raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
            for held, expected in zip(self._held_handles, self._binding, strict=True):
                tree = held.fd.tree_connect
                if (
                    held.closed
                    or tree.is_dfs_share is not False
                    or held.fd.connection is not tree.session.connection
                    or held.fd.connection.server_guid != expected.server_guid
                    or tree.session.session_id != expected.session_id
                    or tree.tree_connect_id != expected.tree_id
                ):
                    raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
            return self._binding[-1]

    def read_observed(
        self,
        parent: str,
        expected_id: bytes,
        check: Callable[[], None],
        *,
        deferred: bool = False,
        credit_reserve: int = 0,
        timeout: float | None = None,
        **session: Any,
    ) -> SmbDirectoryRead:
        """Read one known parent while observation protects ancestor changes."""
        validate_directory_path(parent)
        _validate_traversal_path("/".join((*self._prefix, parent)))
        for component in parent.split("/"):
            _component(component)
        root_identity = self._observed_binding(check)

        def observed_check() -> None:
            self._observed_binding(check)

        def safe_child_lookup(name: str) -> bool:
            read = self.read(parent, observed_check, full_root_check=False, **session)
            try:
                return read.has_directory_child(name)
            finally:
                read.close()

        with self._lock:
            needs_verification = self._verification_version != self._verified_version
        if needs_verification:
            self.read("", check, **session).close()
        tree, native_path = _directory_tree(str(self._path.joinpath(*parent.split("/"))), **session)
        with self._lock:
            self._observed_binding(check)
            if (
                tree.session.session_id != root_identity.session_id
                or tree.tree_connect_id != root_identity.tree_id
                or tree.session.connection is not self._held_handles[-1].fd.tree_connect.session.connection
            ):
                raise DirectoryBindingChangedError(SOURCE_BINDING_ERROR)
        compound = SmbCompoundDirectoryReader(
            tree,
            native_path,
            expected_id,
            observed_check,
            safe_child_lookup=safe_child_lookup,
            deferred=deferred,
            credit_reserve=credit_reserve,
            timeout=timeout,
            fallback=lambda: self._read_observed_loop(parent, expected_id, observed_check, safe_child_lookup, **session),
            io=self.io,
        )
        return compound if deferred else compound.result()

    def _read_observed_loop(
        self,
        parent: str,
        expected_id: bytes,
        observed_check: Callable[[], None],
        safe_child_lookup: Callable[[str], bool],
        **session: Any,
    ) -> SmbDirectoryRead:
        root_identity = self._observed_binding(observed_check)
        handle = SmbDirectoryHandle(
            str(self._path.joinpath(*parent.split("/"))),
            observed_check,
            capabilities=self._capabilities,
            volume_cache=self._volume_cache,
            io=self.io,
            **session,
        )
        try:
            identity = handle.identity(observed_check)
            if (
                identity.session_id != root_identity.session_id
                or identity.tree_id != root_identity.tree_id
                or identity.native_name != root_identity.native_name.rstrip("\\") + "\\" + parent.replace("/", "\\")
                or identity.file_id in SMB_UNAVAILABLE_FILE_IDS
                or identity.file_id.to_bytes(8, "little") != expected_id
            ):
                raise DirectoryTraversalError(SOURCE_BINDING_ERROR)

            return SmbDirectoryRead([handle], [identity], observed_check, safe_child_lookup=safe_child_lookup)
        except BaseException:
            try:
                handle.close()
            except Exception as error:
                logger.warning("Directory handle cleanup failed (%s).", type(error).__name__)
            raise
