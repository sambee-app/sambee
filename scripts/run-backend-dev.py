"""Reload backend code and the active config without watching website output."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from pathlib import Path
from socket import socket

from uvicorn import Config, Server
from uvicorn.supervisors.basereload import BaseReload
from watchfiles import Change, DefaultFilter, PythonFilter, watch

ROOT = Path(__file__).resolve().parent.parent
APP_DIRECTORY = ROOT / "backend" / "app"
WATCH_TIMEOUT_MS = 250
BACKEND_PORT = 8000
logger = logging.getLogger("uvicorn.error")


class BackendReload(BaseReload):
    """Watch only Python sources and stat the external config file."""

    def __init__(
        self,
        config: Config,
        target: Callable[[list[socket] | None], None],
        sockets: list[socket],
        config_path: Path,
    ) -> None:
        super().__init__(config, target, sockets)
        self.reloader_name = "BackendReload"
        self.config_path = config_path
        self.config_signature = self.read_config_signature()
        self.failed = False
        self.directory_filter = DefaultFilter()
        self.python_filter = PythonFilter()
        self.watcher = watch(
            *config.reload_dirs,
            watch_filter=self.directory_filter,
            stop_event=self.should_exit,
            yield_on_timeout=True,
            rust_timeout=WATCH_TIMEOUT_MS,
        )

    def read_config_signature(self) -> tuple[int, int, int] | None:
        """Detect edits, atomic replacements, deletion, and recreation."""
        try:
            stat = self.config_path.stat()
        except FileNotFoundError:
            return None
        return stat.st_ino, stat.st_mtime_ns, stat.st_size

    def read_directory_sources(self, directory: Path) -> set[Path]:
        """Find sources created before native watches attach to a new directory."""
        try:
            entries = os.scandir(directory)
        except (FileNotFoundError, NotADirectoryError):
            return set()
        paths: set[Path] = set()
        with entries:
            for entry in entries:
                if not self.directory_filter(Change.added, entry.path):
                    continue
                if entry.is_dir(follow_symlinks=False):
                    paths.update(self.read_directory_sources(Path(entry.path)))
                elif self.python_filter(Change.added, entry.path):
                    paths.add(Path(entry.path))
        return paths

    def should_restart(self) -> list[Path] | None:
        self.pause()
        try:
            paths: set[Path] = set()
            for change, path in next(self.watcher):
                if change == Change.added and Path(path).is_dir():
                    paths.update(self.read_directory_sources(Path(path)))
                elif self.python_filter(change, path):
                    paths.add(Path(path))
            signature = self.read_config_signature()
        except OSError:
            logger.exception("Backend reload monitoring failed. Correct file access and restart the backend dev task.")
            self.failed = True
            self.should_exit.set()
            return None
        if signature != self.config_signature:
            self.config_signature = signature
            paths.add(self.config_path)
        return sorted(paths) or None

    def shutdown(self) -> None:
        self.watcher.close()
        super().shutdown()


def main() -> int:
    config = Config(
        "app.main:app",
        host="0.0.0.0",
        port=BACKEND_PORT,
        proxy_headers=False,
        reload=True,
        reload_dirs=[str(APP_DIRECTORY)],
    )
    config_path = Path(os.environ.get("SAMBEE_CONFIG_PATH") or ROOT / "config.toml").absolute()
    try:
        with config.bind_socket() as listening_socket:
            reloader = BackendReload(config, Server(config).run, [listening_socket], config_path)
            reloader.run()
    except OSError:
        logger.exception("Cannot start the backend dev server. Check file access and whether port %s is free.", BACKEND_PORT)
        return 1
    return int(reloader.failed)


if __name__ == "__main__":
    raise SystemExit(main())
