import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / ".github/scripts/ensure_candidate_signature.sh"
IMAGE_REF = "example.test/sambee@sha256:" + "a" * 64
SIGN_ATTEMPTS = 3
SIGN_RETRY_DELAY_SECONDS = 15
REKOR_ERROR = 'Post "https://rekor.sigstore.dev/api/v1/log/entries": POST giving up after 4 attempt(s)'


def write_fake_cosign(directory: Path) -> None:
    fake_cosign = directory / "cosign"
    fake_cosign.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
command="$1"
shift
printf '%s\n' "${COSIGN_REPOSITORY:-}" >> "${COSIGN_REPOSITORY_LOG}"
printf '%s %s\n' "$command" "$*" >> "${COSIGN_COMMAND_LOG}"
case "$command" in
  verify)
        [[ "${COSIGN_MODE}" == "reuse" ]] && exit 0
        if [[ -f "${COSIGN_SIGN_MARKER}" ]]; then
            case "${COSIGN_MODE}" in
                conflict-after-sign|unverified) exit 1 ;;
                delayed)
                    [[ -f "${COSIGN_VERIFY_ATTEMPT_MARKER}" ]] && exit 0
                    touch "${COSIGN_VERIFY_ATTEMPT_MARKER}"
                    exit 1
                    ;;
                *) exit 0 ;;
            esac
        fi
    exit 1
    ;;
  download)
        if [[ -f "${COSIGN_INSPECTION_ERROR_MARKER}" ]]; then
            printf 'registry unavailable\n' >&2
            exit 2
        fi
        if [[ "${COSIGN_MODE}" == "download-error-after-sign" && -f "${COSIGN_SIGN_ATTEMPT_MARKER}" ]]; then
            printf 'registry unavailable\n' >&2
            exit 2
        fi
        if [[ "${COSIGN_MODE}" == "conflict-after-sign" && -f "${COSIGN_SIGN_MARKER}" ]]; then
            printf '{"signature":"conflict"}\n'
            exit 0
        fi
    case "${COSIGN_MODE}" in
      missing-associated) printf 'Error: %s: no signatures associated\n' "$*" >&2; exit 1 ;;
      conflict) printf '{"signature":"conflict"}\\n' ;;
      download-error) printf 'registry unavailable\\n' >&2; exit 2 ;;
            *) printf 'Error: no signatures found\nerror during command execution: no signatures found\n' >&2; exit 1 ;;
    esac
    ;;
  sign)
        attempt=0
        [[ ! -f "${COSIGN_SIGN_ATTEMPT_MARKER}" ]] || read -r attempt < "${COSIGN_SIGN_ATTEMPT_MARKER}"
        attempt=$((attempt + 1))
        printf '%s\n' "$attempt" > "${COSIGN_SIGN_ATTEMPT_MARKER}"
        if (( attempt <= COSIGN_SIGN_FAILURES )); then
            [[ "${COSIGN_PUBLISH_ON_FAILURE}" != "true" ]] || touch "${COSIGN_SIGN_MARKER}"
            printf '%s\n' "${COSIGN_SIGN_ERROR}" >&2
            exit 1
        fi
    touch "${COSIGN_SIGN_MARKER}"
    ;;
  *) exit 1 ;;
esac
""",
        encoding="utf-8",
    )
    fake_cosign.chmod(0o755)
    fake_sleep = directory / "sleep"
    fake_sleep.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >> "${COSIGN_SLEEP_LOG}"
if (( $1 > 0 )); then
    case "${COSIGN_DELAY_ACTION}" in
        publish) touch "${COSIGN_SIGN_MARKER}" ;;
        inspection-error) touch "${COSIGN_INSPECTION_ERROR_MARKER}" ;;
    esac
fi
""",
        encoding="utf-8",
    )
    fake_sleep.chmod(0o755)


def run_script(tmp_path: Path, mode: str, extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    write_fake_cosign(bin_dir)
    sign_marker = tmp_path / "sign"
    repository_log = tmp_path / "cosign-repositories"
    command_log = tmp_path / "cosign-commands"
    return subprocess.run(
        [
            "bash",
            str(SCRIPT),
            "--image-ref",
            IMAGE_REF,
            "--signature-repository",
            "example.test/sambee-signatures",
            "--github-repository",
            "example/sambee",
        ],
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "COSIGN_MODE": mode,
            "COSIGN_SIGN_MARKER": str(sign_marker),
            "COSIGN_VERIFY_ATTEMPT_MARKER": str(tmp_path / "verify-attempt"),
            "COSIGN_SIGN_ATTEMPT_MARKER": str(tmp_path / "sign-attempt"),
            "COSIGN_SIGN_FAILURES": "0",
            "COSIGN_SIGN_ERROR": REKOR_ERROR,
            "COSIGN_PUBLISH_ON_FAILURE": "false",
            "COSIGN_DELAY_ACTION": "none",
            "COSIGN_SLEEP_LOG": str(tmp_path / "sleep-log"),
            "COSIGN_INSPECTION_ERROR_MARKER": str(tmp_path / "inspection-error"),
            "COSIGN_REPOSITORY_LOG": str(repository_log),
            "COSIGN_COMMAND_LOG": str(command_log),
            "SIGNATURE_VERIFY_ATTEMPTS": "2",
            "SIGNATURE_VERIFY_RETRY_DELAY_SECONDS": "0",
            "SIGNATURE_SIGN_ATTEMPTS": str(SIGN_ATTEMPTS),
            "SIGNATURE_SIGN_RETRY_DELAY_SECONDS": "0",
            **(extra_env or {}),
        },
    )


def test_reuses_existing_valid_signature(tmp_path: Path) -> None:
    result = run_script(tmp_path, "reuse")

    assert result.returncode == 0, result.stderr
    assert "Reused verified candidate signature" in result.stdout
    assert not (tmp_path / "sign").exists()


def test_signs_and_verifies_when_no_signature_exists(tmp_path: Path) -> None:
    result = run_script(tmp_path, "missing")

    assert result.returncode == 0, result.stderr
    assert "Published and verified candidate signature" in result.stdout
    assert (tmp_path / "sign").exists()
    assert set((tmp_path / "cosign-repositories").read_text(encoding="utf-8").splitlines()) == {"example.test/sambee-signatures"}
    command_log = (tmp_path / "cosign-commands").read_text(encoding="utf-8")
    assert "sign --new-bundle-format=false --registry-referrers-mode legacy --use-signing-config=false --yes" in command_log
    assert "verify --certificate-identity" in command_log
    assert "--new-bundle-format=false" in command_log
    assert "--new-bundle-format false" not in command_log
    assert "--use-signing-config=false" in command_log


def test_signs_when_cosign_reports_no_signatures_associated(tmp_path: Path) -> None:
    result = run_script(tmp_path, "missing-associated")

    assert result.returncode == 0, result.stderr
    assert "Published and verified candidate signature" in result.stdout
    assert (tmp_path / "sign").exists()


def test_retries_post_sign_verification_until_signature_is_visible(tmp_path: Path) -> None:
    result = run_script(tmp_path, "delayed")

    assert result.returncode == 0, result.stderr
    assert "retrying verification" in result.stderr
    assert "Published and verified candidate signature" in result.stdout


def test_rejects_existing_signature_that_fails_policy(tmp_path: Path) -> None:
    result = run_script(tmp_path, "conflict")

    assert result.returncode != 0
    assert "do not satisfy the required GitHub Actions identity policy" in result.stderr
    assert not (tmp_path / "sign").exists()


def test_rejects_signature_registry_inspection_error(tmp_path: Path) -> None:
    result = run_script(tmp_path, "download-error")

    assert result.returncode != 0
    assert "Unable to inspect existing signatures" in result.stderr
    assert not (tmp_path / "sign").exists()


@pytest.mark.parametrize(
    "error",
    [
        REKOR_ERROR,
        "context deadline exceeded",
        "connection reset by peer",
        "TLS handshake timeout",
        "unexpected EOF",
        "408 Request Timeout",
        "HTTP/2 408: context deadline exceeded",
        "status code: 408: context deadline exceeded",
        'Post "https://rekor.sigstore.dev/api/v1/log/entries": dial tcp 34.96.123.1:443: i/o timeout',
        "429 Too Many Requests",
        "503 Service Unavailable",
    ],
)
def test_retries_temporary_signing_failure(tmp_path: Path, error: str) -> None:
    result = run_script(tmp_path, "missing", {"COSIGN_SIGN_FAILURES": "1", "COSIGN_SIGN_ERROR": error})

    assert result.returncode == 0, result.stderr
    assert "Temporary signing failure; retrying" in result.stderr
    assert (tmp_path / "sign-attempt").read_text().strip() == "2"
    commands = (tmp_path / "cosign-commands").read_text().splitlines()
    sign_positions = [position for position, command in enumerate(commands) if command.startswith("sign ")]
    between_attempts = commands[sign_positions[0] + 1 : sign_positions[1]]
    assert any(command.startswith("verify ") for command in between_attempts)
    assert any(command.startswith("download ") for command in between_attempts)


def test_stops_after_signing_retry_limit(tmp_path: Path) -> None:
    result = run_script(tmp_path, "missing", {"COSIGN_SIGN_FAILURES": str(SIGN_ATTEMPTS)})

    assert result.returncode != 0
    assert (tmp_path / "sign-attempt").read_text().strip() == str(SIGN_ATTEMPTS)
    assert f"Candidate signing failed after {SIGN_ATTEMPTS} attempts" in result.stderr
    assert "https://status.sigstore.dev/" in result.stderr
    assert "Rerun failed jobs after recovery if the staging image still exists" in result.stderr
    assert "same build version. Publication remains blocked" in result.stderr
    assert not (tmp_path / "sign").exists()


@pytest.mark.parametrize(
    "error",
    [
        "401 Unauthorized",
        "403 Forbidden",
        "400 Bad Request",
        "404 Not Found",
        "422 Unprocessable Entity: context deadline exceeded",
        "HTTP/2 404: context deadline exceeded",
        "status code: 404: context deadline exceeded",
        "permission denied",
        "invalid identity",
        "certificate has expired",
        "signature policy rejected",
        "unknown signing error",
        f"403 Forbidden: {REKOR_ERROR}",
        f"400 Bad Request: {REKOR_ERROR}",
    ],
)
def test_does_not_retry_permanent_or_unknown_signing_failure(tmp_path: Path, error: str) -> None:
    result = run_script(tmp_path, "missing", {"COSIGN_SIGN_FAILURES": "1", "COSIGN_SIGN_ERROR": error})

    assert result.returncode != 0
    assert (tmp_path / "sign-attempt").read_text().strip() == "1"
    assert "refusing to retry" in result.stderr
    assert "Temporary signing failure; retrying" not in result.stderr


@pytest.mark.parametrize("mode", ["missing", "delayed"])
def test_reuses_signature_published_by_failed_signing_command(tmp_path: Path, mode: str) -> None:
    result = run_script(tmp_path, mode, {"COSIGN_SIGN_FAILURES": "1", "COSIGN_PUBLISH_ON_FAILURE": "true"})

    assert result.returncode == 0, result.stderr
    assert "after signing reported a temporary failure" in result.stdout
    assert (tmp_path / "sign-attempt").read_text().strip() == "1"


def test_rejects_conflicting_signature_after_failed_signing_command(tmp_path: Path) -> None:
    result = run_script(tmp_path, "conflict-after-sign", {"COSIGN_SIGN_FAILURES": "1", "COSIGN_PUBLISH_ON_FAILURE": "true"})

    assert result.returncode != 0
    assert "refusing to add another signature" in result.stderr
    assert (tmp_path / "sign-attempt").read_text().strip() == "1"


def test_rejects_registry_inspection_failure_after_failed_signing_command(tmp_path: Path) -> None:
    result = run_script(tmp_path, "download-error-after-sign", {"COSIGN_SIGN_FAILURES": "1"})

    assert result.returncode != 0
    assert "Unable to inspect existing signatures" in result.stderr
    assert (tmp_path / "sign-attempt").read_text().strip() == "1"


def test_does_not_sign_again_when_post_sign_verification_fails(tmp_path: Path) -> None:
    result = run_script(tmp_path, "unverified")

    assert result.returncode != 0
    assert "Signing succeeded, but candidate signature" in result.stderr
    assert "publication remains blocked" in result.stderr
    assert (tmp_path / "sign-attempt").read_text().strip() == "1"


@pytest.mark.parametrize(
    "extra_env",
    [
        {"SIGNATURE_SIGN_ATTEMPTS": "0"},
        {"SIGNATURE_SIGN_ATTEMPTS": "invalid"},
        {"SIGNATURE_SIGN_RETRY_DELAY_SECONDS": "-1"},
        {"SIGNATURE_SIGN_RETRY_DELAY_SECONDS": "1.5"},
    ],
)
def test_rejects_invalid_signing_retry_configuration(tmp_path: Path, extra_env: dict[str, str]) -> None:
    result = run_script(tmp_path, "missing", extra_env)

    assert result.returncode != 0
    assert "Signature retry configuration" in result.stderr
    assert not (tmp_path / "sign-attempt").exists()


def test_signing_retries_use_increasing_delays(tmp_path: Path) -> None:
    result = run_script(
        tmp_path,
        "missing",
        {"COSIGN_SIGN_FAILURES": "2", "SIGNATURE_SIGN_RETRY_DELAY_SECONDS": str(SIGN_RETRY_DELAY_SECONDS)},
    )

    assert result.returncode == 0, result.stderr
    delays = [int(delay) for delay in (tmp_path / "sleep-log").read_text().splitlines() if int(delay) > 0]
    assert delays == [SIGN_RETRY_DELAY_SECONDS, SIGN_RETRY_DELAY_SECONDS * 2]
    assert (tmp_path / "sign-attempt").read_text().strip() == str(SIGN_ATTEMPTS)


@pytest.mark.parametrize("mode", ["missing", "delayed"])
def test_rechecks_signature_published_during_retry_delay(tmp_path: Path, mode: str) -> None:
    result = run_script(
        tmp_path,
        mode,
        {"COSIGN_SIGN_FAILURES": "1", "SIGNATURE_SIGN_RETRY_DELAY_SECONDS": "1", "COSIGN_DELAY_ACTION": "publish"},
    )

    assert result.returncode == 0, result.stderr
    assert "before signing retry" in result.stdout
    assert (tmp_path / "sign-attempt").read_text().strip() == "1"


def test_rejects_conflicting_signature_published_during_retry_delay(tmp_path: Path) -> None:
    result = run_script(
        tmp_path,
        "conflict-after-sign",
        {"COSIGN_SIGN_FAILURES": "1", "SIGNATURE_SIGN_RETRY_DELAY_SECONDS": "1", "COSIGN_DELAY_ACTION": "publish"},
    )

    assert result.returncode != 0
    assert "refusing to add another signature" in result.stderr
    assert (tmp_path / "sign-attempt").read_text().strip() == "1"


def test_rejects_inspection_error_during_retry_delay(tmp_path: Path) -> None:
    result = run_script(
        tmp_path,
        "missing",
        {"COSIGN_SIGN_FAILURES": "1", "SIGNATURE_SIGN_RETRY_DELAY_SECONDS": "1", "COSIGN_DELAY_ACTION": "inspection-error"},
    )

    assert result.returncode != 0
    assert "Unable to inspect existing signatures" in result.stderr
    assert (tmp_path / "sign-attempt").read_text().strip() == "1"


def test_accepts_whole_second_delay_with_leading_zero(tmp_path: Path) -> None:
    result = run_script(tmp_path, "missing", {"COSIGN_SIGN_FAILURES": "1", "SIGNATURE_SIGN_RETRY_DELAY_SECONDS": "08"})

    assert result.returncode == 0, result.stderr
    assert "retrying in 8 seconds" in result.stderr
