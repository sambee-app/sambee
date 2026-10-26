"""Install hash-locked build pip without running the interpreter's bundled pip."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import ssl
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen

PYPI_API = "https://pypi.org/pypi/pip/{version}/json"
WHEEL_HOST = "files.pythonhosted.org"
DOWNLOAD_TIMEOUT_SECONDS = 60
MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024
REQUIREMENT_PATTERN = re.compile(
    r"pip==(?P<version>[0-9]+(?:\.[0-9]+){1,2})(?P<hashes>(?:\s+--hash=sha256:[0-9a-f]{64})+)"
)
HASH_PATTERN = re.compile(r"--hash=sha256:([0-9a-f]{64})")
WHEEL_ENTRYPOINT = "import runpy, sys; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module('pip', run_name='__main__')"


def read_requirement(requirements: Path) -> tuple[str, set[str]]:
    """Accept only one exact pip pin with SHA-256 hashes."""
    logical_lines = " ".join(
        line.split("#", 1)[0].strip().removesuffix("\\")
        for line in requirements.read_text(encoding="utf-8").splitlines()
    )
    match = REQUIREMENT_PATTERN.fullmatch(logical_lines.strip())
    if match is None:
        raise ValueError(
            "Build requirements must contain only pip==<version> and SHA-256 hashes."
        )
    return match.group("version"), set(HASH_PATTERN.findall(match.group("hashes")))


def download(url: str, expected_host: str) -> bytes:
    """Use the system CA store and limit network response size."""
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.netloc != expected_host:
        raise ValueError(f"Expected an HTTPS download from {expected_host}.")
    with urlopen(
        url, context=ssl.create_default_context(), timeout=DOWNLOAD_TIMEOUT_SECONDS
    ) as response:
        final_url = urlsplit(response.url)
        if final_url.scheme != "https" or final_url.netloc != expected_host:
            raise ValueError(f"Download redirected outside {expected_host}.")
        data = bytes(response.read(MAX_DOWNLOAD_BYTES + 1))
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise ValueError(f"Download exceeds {MAX_DOWNLOAD_BYTES} bytes.")
    return data


def bootstrap(requirements: Path) -> None:
    version, hashes = read_requirement(requirements)
    filename = f"pip-{version}-py3-none-any.whl"
    metadata = json.loads(download(PYPI_API.format(version=version), "pypi.org"))
    wheels = [
        item
        for item in metadata["urls"]
        if item["filename"] == filename and item["packagetype"] == "bdist_wheel"
    ]
    if len(wheels) != 1 or wheels[0].get("yanked"):
        raise ValueError(f"Expected one non-yanked universal wheel for pip {version}.")
    wheel_data = download(wheels[0]["url"], WHEEL_HOST)
    if hashlib.sha256(wheel_data).hexdigest() not in hashes:
        raise ValueError(
            f"SHA-256 mismatch for {filename}; check the build requirements before retrying."
        )
    with TemporaryDirectory(prefix="sambee-build-pip-") as directory:
        wheel = Path(directory) / filename
        wheel.write_bytes(wheel_data)
        subprocess.run(
            [
                sys.executable,
                "-I",
                "-c",
                WHEEL_ENTRYPOINT,
                str(wheel),
                "install",
                "--upgrade",
                "--no-index",
                "--no-deps",
                "--only-binary=:all:",
                "--require-hashes",
                "--disable-pip-version-check",
                "--root-user-action=ignore",
                "--find-links",
                directory,
                "-r",
                str(requirements.resolve()),
            ],
            check=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("requirements", type=Path)
    arguments = parser.parse_args()
    try:
        bootstrap(arguments.requirements)
    except (
        OSError,
        URLError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.CalledProcessError,
    ) as error:
        parser.exit(1, f"Build pip bootstrap failed: {error}\n")


if __name__ == "__main__":
    main()
