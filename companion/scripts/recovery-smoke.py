"""Check a Windows verification package through its actual application startup."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

API_PORT = 21549
API_URL = f"http://127.0.0.1:{API_PORT}"
STARTUP_TIMEOUT_SECONDS = 45
RECOVERY_TIMEOUT_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 3
SHUTDOWN_TIMEOUT_SECONDS = 15
POLL_INTERVAL_SECONDS = 0.2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--report-dir", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    args.report_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "source_sha": args.source_sha,
        "run_id": args.run_id,
        "platform": "windows-x64",
        "checks": [],
        "passed": False,
    }
    process = None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    token = secrets.token_hex(32)

    def request(action: str):
        health = action == "health"
        url = (
            f"{API_URL}/api/health" if health else f"{API_URL}/__verification/{action}"
        )
        message = urllib.request.Request(
            url, method="GET" if health else "POST", headers={"x-recovery-token": token}
        )
        with opener.open(message, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return json.load(response)

    def wait_for(check, seconds: int):
        deadline = time.monotonic() + seconds
        last_error = None
        while time.monotonic() < deadline:
            try:
                result = check()
                if result:
                    return result
            except (OSError, urllib.error.URLError) as error:
                last_error = type(error).__name__
            time.sleep(POLL_INTERVAL_SECONDS)
        raise TimeoutError(
            f"Recovery check exceeded {seconds} seconds. Last request failure: {last_error}"
        )

    def record(name: str):
        report["checks"].append(name)

    try:
        if os.name != "nt":
            raise RuntimeError(
                "Run this packaged recovery check on Windows x64 CI only."
            )
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", API_PORT))
        with tempfile.TemporaryDirectory(prefix="sambee-recovery-") as temporary:
            source = Path(temporary) / "source"
            (source / "retained-reports").mkdir(parents=True)
            environment = {
                **os.environ,
                "SAMBEE_RECOVERY_ROOT": str(source),
                "SAMBEE_RECOVERY_TOKEN": token,
            }
            with (args.report_dir / "process.log").open(
                "w", encoding="utf-8"
            ) as output:
                process = subprocess.Popen(
                    [str(args.executable.resolve()), "--from-autostart"],
                    env=environment,
                    stdout=output,
                    stderr=output,
                )
                try:
                    wait_for(lambda: request("health"), STARTUP_TIMEOUT_SECONDS)
                    record("actual-application-startup")

                    def healthy_contains(path, *, require_complete=True):
                        response = request("search")
                        return (
                            response.get("monitoring_state") == "healthy"
                            and (
                                not require_complete
                                or response.get("coverage") == "complete"
                            )
                            and path in response["results"]
                        )

                    wait_for(
                        lambda: healthy_contains("retained-reports"),
                        RECOVERY_TIMEOUT_SECONDS,
                    )
                    record("initial-native-index-and-watcher")
                    assert request("subscribe")["subscriptions"] == 1
                    request("lose")
                    degraded = request("search")
                    assert degraded["monitoring_state"] == "unavailable", degraded
                    assert "retained-reports" in degraded["results"], degraded
                    record("watcher-loss-retains-results")
                    (source / "gap-reports").mkdir()
                    request("restore")
                    wait_for(
                        lambda: healthy_contains("gap-reports"),
                        RECOVERY_TIMEOUT_SECONDS,
                    )
                    record("event-gap-reconciled-before-healthy")
                    (source / "native-reports").mkdir()
                    wait_for(
                        lambda: healthy_contains(
                            "native-reports", require_complete=False
                        ),
                        RECOVERY_TIMEOUT_SECONDS,
                    )
                    record("native-events-after-recovery")
                    assert request("unsubscribe")["subscriptions"] == 0
                    record("unsubscribe-releases-watcher")
                    wait_for(
                        lambda: request("stop")["stopped"], SHUTDOWN_TIMEOUT_SECONDS
                    )
                    request("shutdown")
                    assert process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS) == 0
                    record("clean-shutdown")
                    report["passed"] = True
                finally:
                    if process.poll() is None:
                        try:
                            subprocess.run(
                                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                check=True,
                                capture_output=True,
                                timeout=SHUTDOWN_TIMEOUT_SECONDS,
                            )
                        finally:
                            if process.poll() is None:
                                process.kill()
                            process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
    except (
        AssertionError,
        OSError,
        RuntimeError,
        ValueError,
        subprocess.SubprocessError,
    ) as error:
        report["error"] = f"{type(error).__name__}: {error}"
    finally:
        (args.report_dir / "recovery.json").write_text(
            json.dumps(report, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
