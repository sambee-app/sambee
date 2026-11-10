"""Unit tests for packaged recovery polling without a native application."""

import importlib.util
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    "recovery_smoke", Path(__file__).with_name("recovery-smoke.py")
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Cannot load the recovery smoke script for testing.")
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


class RecoveryPollingTests(unittest.TestCase):
    def setUp(self):
        self.report = {}
        sleep_patch = mock.patch.object(smoke.time, "sleep")
        self.sleep = sleep_patch.start()
        self.addCleanup(sleep_patch.stop)
        clock_patch = mock.patch.object(smoke.time, "monotonic", return_value=0)
        clock_patch.start()
        self.addCleanup(clock_patch.stop)

    def test_ready_response_is_returned_and_phase_is_recorded(self):
        response = {"monitoring_state": "healthy"}
        result = smoke.wait_for(
            lambda: response, 1, phase="gap-recovery", report=self.report
        )
        self.assertIs(result, response)
        self.assertEqual(self.report["phase"], "gap-recovery")
        self.sleep.assert_not_called()

    def test_pending_response_is_retried(self):
        check = mock.Mock(side_effect=[False, True])
        self.assertTrue(
            smoke.wait_for(check, 1, phase="gap-recovery", report=self.report)
        )
        self.assertEqual(check.call_count, 2)
        self.sleep.assert_called_once_with(smoke.POLL_INTERVAL_SECONDS)

    def test_request_failure_is_retried(self):
        check = mock.Mock(side_effect=[urllib.error.URLError("not ready"), True])
        self.assertTrue(smoke.wait_for(check, 1, phase="startup", report=self.report))
        self.assertEqual(check.call_count, 2)

    def test_timeout_identifies_phase_and_last_response(self):
        self.report["last_response"] = {"monitoring_state": "recovering"}
        with mock.patch.object(smoke.time, "monotonic", side_effect=[0, 0, 2]):
            with self.assertRaises(TimeoutError) as failure:
                smoke.wait_for(
                    lambda: False, 1, phase="gap-recovery", report=self.report
                )
        self.assertIn("gap-recovery", str(failure.exception))
        self.assertIn("recovering", str(failure.exception))

    def test_timeout_keeps_request_error_details(self):
        check = mock.Mock(side_effect=urllib.error.URLError("connection refused"))
        with mock.patch.object(smoke.time, "monotonic", side_effect=[0, 0, 2]):
            with self.assertRaisesRegex(TimeoutError, "connection refused"):
                smoke.wait_for(check, 1, phase="startup", report=self.report)

    def test_process_exit_stops_polling_before_request(self):
        process = mock.Mock()
        process.poll.return_value = 7
        check = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "startup.*exited with code 7"):
            smoke.wait_for(
                check, 1, phase="startup", report=self.report, process=process
            )
        check.assert_not_called()
        self.sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
