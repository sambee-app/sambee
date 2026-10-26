import hashlib
import importlib.util
import io
import json
import shlex
import subprocess
import sys
import sysconfig
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest.mock import Mock

import pytest
import yaml

SCRIPT = Path(__file__).parents[2] / "scripts/bootstrap-build-pip.py"
SPEC = spec_from_file_location("bootstrap_build_pip", SCRIPT)
assert SPEC and SPEC.loader
MODULE = module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

VERSION = "26.2.2"
WHEEL_NAME = f"pip-{VERSION}-py3-none-any.whl"
WHEEL_URL = f"https://files.pythonhosted.org/packages/{WHEEL_NAME}"
WHEEL_BYTES = b"verified wheel fixture"
WHEEL_HASH = hashlib.sha256(WHEEL_BYTES).hexdigest()


@pytest.fixture
def requirements(tmp_path: Path) -> Path:
    path = tmp_path / "requirements.txt"
    path.write_text(f"pip=={VERSION} \\\n    --hash=sha256:{WHEEL_HASH}\n", encoding="utf-8")
    return path


def metadata(**overrides: object) -> bytes:
    wheel = {"filename": WHEEL_NAME, "packagetype": "bdist_wheel", "url": WHEEL_URL, "yanked": False}
    wheel.update(overrides)
    return json.dumps({"urls": [wheel]}).encode()


def test_reads_hash_locked_requirement(requirements: Path) -> None:
    assert MODULE.read_requirement(requirements) == (VERSION, {WHEEL_HASH})


def test_reads_comments_and_multiple_hashes(requirements: Path) -> None:
    other_hash = "a" * 64
    requirements.write_text(
        f"# Build installer\npip=={VERSION} \\\n    --hash=sha256:{WHEEL_HASH} \\\n    --hash=sha256:{other_hash}\n",
        encoding="utf-8",
    )
    assert MODULE.read_requirement(requirements) == (VERSION, {WHEEL_HASH, other_hash})


@pytest.mark.parametrize("content", ["", "pip>=26.2.2", "pip==26.2.2", "pip==26.2.2 --hash=sha256:bad", "--index-url https://example.com"])
def test_rejects_unsafe_requirements(requirements: Path, content: str) -> None:
    requirements.write_text(content, encoding="utf-8")
    with pytest.raises(ValueError, match="only pip=="):
        MODULE.read_requirement(requirements)


def test_rejects_additional_packages(requirements: Path) -> None:
    with requirements.open("a") as stream:
        stream.write(f"other==1.0 --hash=sha256:{WHEEL_HASH}\n")
    with pytest.raises(ValueError, match="only pip=="):
        MODULE.read_requirement(requirements)


def test_executes_only_verified_wheel_offline(requirements: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    downloader = Mock(side_effect=[metadata(), WHEEL_BYTES])
    monkeypatch.setattr(MODULE, "download", downloader)

    def run(command: list[str], *, check: bool) -> None:
        assert check
        assert command[:4] == [sys.executable, "-I", "-c", MODULE.WHEEL_ENTRYPOINT]
        wheel = Path(command[4])
        assert wheel.read_bytes() == WHEEL_BYTES
        assert wheel.name == WHEEL_NAME
        for flag in ("--no-index", "--no-deps", "--require-hashes", "--upgrade"):
            assert flag in command
        assert command[-2:] == ["-r", str(requirements.resolve())]

    runner = Mock(side_effect=run)
    monkeypatch.setattr(MODULE.subprocess, "run", runner)
    MODULE.bootstrap(requirements)
    runner.assert_called_once()
    assert not Path(runner.call_args.args[0][4]).exists()


def test_hash_mismatch_does_not_execute_wheel(requirements: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(MODULE, "download", Mock(side_effect=[metadata(), b"tampered wheel"]))
    runner = Mock()
    monkeypatch.setattr(MODULE.subprocess, "run", runner)
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        MODULE.bootstrap(requirements)
    runner.assert_not_called()


@pytest.mark.parametrize("changes", [{"yanked": True}, {"filename": "unexpected.whl"}])
def test_rejects_unusable_release(requirements: Path, monkeypatch: pytest.MonkeyPatch, changes: dict[str, object]) -> None:
    monkeypatch.setattr(MODULE, "download", Mock(return_value=metadata(**changes)))
    with pytest.raises(ValueError, match="non-yanked universal wheel"):
        MODULE.bootstrap(requirements)


@pytest.mark.parametrize("url", ["http://files.pythonhosted.org/pip.whl", "https://example.com/pip.whl"])
def test_rejects_untrusted_download_url(url: str) -> None:
    with pytest.raises(ValueError, match="HTTPS download"):
        MODULE.download(url, MODULE.WHEEL_HOST)


def test_download_uses_system_tls_and_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    response = io.BytesIO(WHEEL_BYTES)
    response.url = WHEEL_URL
    opener = Mock(return_value=response)
    context = object()
    monkeypatch.setattr(MODULE, "urlopen", opener)
    monkeypatch.setattr(MODULE.ssl, "create_default_context", Mock(return_value=context))
    assert MODULE.download(WHEEL_URL, MODULE.WHEEL_HOST) == WHEEL_BYTES
    opener.assert_called_once_with(WHEEL_URL, context=context, timeout=MODULE.DOWNLOAD_TIMEOUT_SECONDS)


def test_rejects_redirect_to_untrusted_host(monkeypatch: pytest.MonkeyPatch) -> None:
    response = io.BytesIO(WHEEL_BYTES)
    response.url = "https://example.com/pip.whl"
    monkeypatch.setattr(MODULE, "urlopen", Mock(return_value=response))
    with pytest.raises(ValueError, match="redirected outside"):
        MODULE.download(WHEEL_URL, MODULE.WHEEL_HOST)


def test_rejects_oversized_download(monkeypatch: pytest.MonkeyPatch) -> None:
    response = io.BytesIO(WHEEL_BYTES)
    response.url = WHEEL_URL
    monkeypatch.setattr(MODULE, "MAX_DOWNLOAD_BYTES", 1)
    monkeypatch.setattr(MODULE, "urlopen", Mock(return_value=response))
    with pytest.raises(ValueError, match="exceeds"):
        MODULE.download(WHEEL_URL, MODULE.WHEEL_HOST)


def test_cli_reports_invalid_requirement(tmp_path: Path) -> None:
    requirements = tmp_path / "requirements.txt"
    requirements.write_text("pip==26.2.2", encoding="utf-8")
    result = subprocess.run([sys.executable, str(SCRIPT), str(requirements)], capture_output=True, text=True, check=False)
    assert result.returncode == 1
    assert "Build pip bootstrap failed:" in result.stderr


def test_docker_build_upgrades_before_downloads_and_removes_runtime_pip() -> None:
    dockerfile = (SCRIPT.parents[1] / "Dockerfile").read_text(encoding="utf-8")
    runtime = dockerfile.split("AS runtime-base", 1)[1].split("FROM runtime-base AS devcontainer", 1)[0]
    wheel_builder = dockerfile.split("AS pyvips-wheel-builder", 1)[1].split("FROM runtime-base AS backend-test", 1)[0]
    backend_test = dockerfile.split("FROM runtime-base AS backend-test", 1)[1].split("FROM runtime-base AS production", 1)[0]
    production = dockerfile.split("FROM runtime-base AS production", 1)[1]
    assert "bootstrap-build-pip.py" in runtime
    assert wheel_builder.index("python /tmp/build-pip/bootstrap-build-pip.py") < wheel_builder.index("pip wheel")
    assert backend_test.index("/bin/python /tmp/build-pip/bootstrap-build-pip.py") < backend_test.index("/bin/python -m pip install")
    assert production.index("pip install") < production.index("python -m pip check") < production.index("uninstall --yes")
    assert 'shutil.rmtree(Path(sysconfig.get_path("stdlib")) / "ensurepip")' in production
    assert production.index("uninstall --yes") < production.index("COPY --link backend/app")


def test_committed_build_requirement_is_valid() -> None:
    version, hashes = MODULE.read_requirement(SCRIPT.parents[1] / "backend/build-tools/requirements.txt")
    assert version
    assert hashes


def test_dependabot_manages_build_requirements() -> None:
    configuration = yaml.safe_load((SCRIPT.parents[1] / ".github/dependabot.yml").read_text(encoding="utf-8"))
    assert any(
        update["package-ecosystem"] == "pip" and update["directory"] == "/backend/build-tools" for update in configuration["updates"]
    )


@pytest.mark.parametrize("remaining", [None, "module", "launcher", "metadata", "ensurepip"])
def test_production_ci_check_rejects_packaging_tools(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, remaining: str | None) -> None:
    configuration = yaml.safe_load((SCRIPT.parents[1] / ".github/workflows/docker-image-validate.yml").read_text(encoding="utf-8"))
    step = next(
        step for step in configuration["jobs"]["validate"]["steps"] if step.get("name") == "Verify production packaging tools are absent"
    )
    code = shlex.split(step["run"])[-1]
    directories = {name: tmp_path / name for name in ("scripts", "purelib", "stdlib")}
    for directory in directories.values():
        directory.mkdir()
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: object() if remaining == "module" and name == "pip" else None)
    monkeypatch.setattr(sysconfig, "get_path", lambda name: str(directories[name]))
    if remaining == "launcher":
        (directories["scripts"] / "pip3").touch()
    elif remaining == "metadata":
        (directories["purelib"] / f"pip-{VERSION}.dist-info").mkdir()
    elif remaining == "ensurepip":
        (directories["stdlib"] / "ensurepip").mkdir()
    if remaining is None:
        exec(compile(code, "production-packaging-check", "exec"), {})
    else:
        with pytest.raises(SystemExit, match="Production packaging tools remain"):
            exec(compile(code, "production-packaging-check", "exec"), {})
