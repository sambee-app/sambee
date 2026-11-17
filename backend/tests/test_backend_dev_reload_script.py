"""Check scoped backend reloads without starting application services."""

import os
import sys
import time
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest
from uvicorn import Config

SCRIPT = Path(__file__).parents[2] / "scripts/run-backend-dev.py"
SPEC = spec_from_file_location("run_backend_dev", SCRIPT)
assert SPEC and SPEC.loader
MODULE = module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)
CHANGE_TIMEOUT = 5


def test_scoped_reload_keeps_python_and_atomic_config_updates(tmp_path: Path) -> None:
    app = tmp_path / "backend/app"
    app.mkdir(parents=True)
    config_path = tmp_path / "config.toml"
    config_path.write_text("initial")
    config = Config("app.main:app", reload=True, reload_dirs=[str(app)], reload_delay=0)
    reloader = MODULE.BackendReload(config, lambda sockets: None, [], config_path)

    def expect_change(path: Path) -> None:
        deadline = time.monotonic() + CHANGE_TIMEOUT
        while time.monotonic() < deadline:
            changes = reloader.should_restart()
            if changes and path in changes:
                return
        pytest.fail(f"No reload was requested for {path}")

    try:
        assert reloader.should_restart() is None
        website = tmp_path / "website"
        website.mkdir()
        (website / "output.html").write_text("unrelated website output")
        (app / "__pycache__").mkdir()
        (app / "__pycache__/module.pyc").write_bytes(b"cache")
        assert reloader.should_restart() is None

        source = app / "nested/module.py"
        source.parent.mkdir()
        source.write_text("VALUE = 1")
        expect_change(source)
        source.write_text("VALUE = 2")
        # Watchfiles can use whole-second mtimes when the host requires polling.
        updated_time = source.stat().st_mtime + 2
        os.utime(source, (updated_time, updated_time))
        expect_change(source)
        source.unlink()
        expect_change(source)

        for value in ["first save", "second save"]:
            replacement = tmp_path / "replacement.toml"
            replacement.write_text(value)
            os.replace(replacement, config_path)
            expect_change(config_path)
        config_path.unlink()
        expect_change(config_path)
        config_path.write_text("recreated")
        expect_change(config_path)
        assert not reloader.failed
    finally:
        reloader.should_exit.set()
        reloader.watcher.close()


def test_reload_monitoring_error_is_reported(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    config = Config("app.main:app", reload=True, reload_dirs=[str(tmp_path)], reload_delay=0)
    reloader = MODULE.BackendReload(config, lambda sockets: None, [], tmp_path / "config.toml")

    def fail_signature() -> None:
        raise PermissionError("config cannot be read")

    monkeypatch.setattr(reloader, "read_config_signature", fail_signature)
    try:
        assert reloader.should_restart() is None
        assert reloader.failed
        assert reloader.should_exit.is_set()
        assert "Correct file access and restart" in capsys.readouterr().err
    finally:
        reloader.watcher.close()
