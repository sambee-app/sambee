"""Reload backend code and the active config without watching website output."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable
from pathlib import Path
from socket import socket

from uvicorn import Config, Server
from uvicorn.supervisors.basereload import BaseReload
from watchfiles import PythonFilter, watch

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
        self.watcher = watch(
            *config.reload_dirs,
            watch_filter=PythonFilter(),
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

    def should_restart(self) -> list[Path] | None:
        self.pause()
        try:
            paths = {Path(path) for _, path in next(self.watcher)}
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
