"""Admission remains occupied while search workers are stopping."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from app.services.filesystem_search_admission import SearchAdmission, SearchAdmissionError, SearchAdmissionReason, SearchLease


def test_stopping_worker_keeps_slot_until_cleanup() -> None:
    admission = SearchAdmission()
    lease = admission.admit("account", "connection", 1)
    stop = lease.stop_handle()
    with pytest.raises(SearchAdmissionError) as error:
        admission.admit("account", "connection", 1)
    assert error.value.reason is SearchAdmissionReason.RUNNING
    assert stop.stopping()
    with pytest.raises(SearchAdmissionError) as error:
        admission.admit("account", "connection", 1)
    assert error.value.reason is SearchAdmissionReason.STOPPING
    lease.release()
    lease.release()
    replacement = admission.admit("account", "connection", 1)
    assert not stop.stopping()
    with pytest.raises(SearchAdmissionError) as error:
        admission.admit("account", "connection", 1)
    assert error.value.reason is SearchAdmissionReason.RUNNING
    replacement.release()


def test_slots_are_per_account_and_connection_and_use_current_limit() -> None:
    admission = SearchAdmission()
    leases = [
        admission.admit("account", "connection", 2),
        admission.admit("account", "connection", 2),
        admission.admit("other", "connection", 1),
        admission.admit("account", "other", 1),
    ]
    leases[0].stop_handle().stopping()
    with pytest.raises(SearchAdmissionError) as error:
        admission.admit("account", "connection", 1)
    assert error.value.reason is SearchAdmissionReason.RUNNING
    leases[1].stop_handle().stopping()
    with pytest.raises(SearchAdmissionError) as error:
        admission.admit("account", "connection", 1)
    assert error.value.reason is SearchAdmissionReason.STOPPING
    for lease in leases:
        lease.release()


def test_simultaneous_starts_are_atomic() -> None:
    admission = SearchAdmission()
    gate = Barrier(8)

    def start() -> SearchLease | None:
        gate.wait()
        try:
            return admission.admit("account", "connection", 1)
        except SearchAdmissionError:
            return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        admitted = [lease for lease in pool.map(lambda _: start(), range(8)) if lease is not None]
    assert len(admitted) == 1
    admitted[0].release()


@pytest.mark.parametrize("account,connection,limit", [("", "c", 1), ("a", "", 1), ("a", "c", 0), ("a", "c", True)])
def test_invalid_admission_inputs_fail(account: str, connection: str, limit: int) -> None:
    with pytest.raises(ValueError):
        SearchAdmission().admit(account, connection, limit)
