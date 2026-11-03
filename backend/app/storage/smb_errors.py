"""Translate expected SMB target errors without matching exception text."""

import errno
from typing import cast

from smbprotocol.exceptions import SMBOSError, SMBResponseException
from smbprotocol.header import NtStatus

SMB_RECOVERY_RETRY_SECONDS = 2


class SMBOperationTimeout(TimeoutError):
    """The caller deadline elapsed; dispatched work can still be active."""

    retry_after_seconds = SMB_RECOVERY_RETRY_SECONDS


class SMBConnectionRetired(RuntimeError):
    """The old generation is retained for cleanup and cannot accept work."""

    retry_after_seconds = SMB_RECOVERY_RETRY_SECONDS


class SMBConnectionCapacityError(SMBConnectionRetired):
    """Connection recovery capacity is reserved by existing work."""


class SMBMutationUncertain(SMBConnectionRetired):
    """A dispatched mutation lost confirmation; automatic replay is unsafe."""

    def __init__(self) -> None:
        super().__init__("SMB change confirmation was lost. Check the source before retrying; the change may already be applied.")


def translate_smb_target_error(error: Exception, path: str) -> Exception:
    """Keep connection failures distinct from missing or inaccessible items."""
    if not isinstance(error, (SMBOSError, SMBResponseException)):
        return error
    error_status = getattr(error, "ntstatus", getattr(error, "status", None))
    if error_status in (NtStatus.STATUS_OBJECT_NAME_NOT_FOUND, NtStatus.STATUS_OBJECT_PATH_NOT_FOUND):
        return FileNotFoundError(errno.ENOENT, "The item was not found", path)
    if error_status == NtStatus.STATUS_ACCESS_DENIED:
        return PermissionError(errno.EACCES, "Access to the item was denied", path)
    if error_status == NtStatus.STATUS_NOT_A_DIRECTORY:
        return NotADirectoryError(errno.ENOTDIR, "The item is not a directory", path)
    return cast(Exception, error)
