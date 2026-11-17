"""Check development preparation and complete deployment pipeline selection."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_docs_routes import load_script


class WebsiteBuildTests(unittest.TestCase):
    def test_development_skips_expensive_steps_and_removes_stale_search(self) -> None:
        builder = load_script("build-website")
        with tempfile.TemporaryDirectory() as temporary_directory:
            destination = Path(temporary_directory)
            search = destination / "pagefind"
            search.mkdir()
            (search / "pagefind.js").write_text("stale index", encoding="utf-8")
            with (
                patch(
                    "sys.argv",
                    [
                        "build-website.py",
                        "--environment",
                        "development",
                        "--destination",
                        str(destination),
                    ],
                ),
                patch.object(builder.subprocess, "run") as run,
            ):
                self.assertEqual(builder.main(), 0)
            self.assertFalse(search.exists())
            commands = [call.args[0] for call in run.call_args_list]
            self.assertFalse(
                any("scripts/build-search.js" in command for command in commands)
            )
            self.assertFalse(
                any(
                    "scripts/validate-docs-output.py" in command for command in commands
                )
            )
            hugo = next(command for command in commands if command[0] == "hugo")
            self.assertNotIn("--minify", hugo)
            self.assertNotIn("--gc", hugo)
            self.assertTrue(
                any(
                    "scripts/validate-docs-content.py" in command
                    for command in commands
                )
            )
            self.assertTrue(
                any(
                    "scripts/generate-managed-redirects.py" in command
                    for command in commands
                )
            )
            self.assertTrue(
                any(
                    "scripts/validate-homepage-ctas.py" in command
                    for command in commands
                )
            )

    def test_search_is_opt_in_and_deployment_checks_remain_complete(self) -> None:
        builder = load_script("build-website")
        for arguments, full in [
            (["--environment", "development", "--with-search"], False),
            (["--environment", "development", "--full"], True),
            (["--environment", "preview"], True),
            ([], True),
        ]:
            with (
                self.subTest(arguments=arguments),
                patch("sys.argv", ["build-website.py", *arguments]),
                patch.object(builder.subprocess, "run") as run,
            ):
                self.assertEqual(builder.main(), 0)
                commands = [call.args[0] for call in run.call_args_list]
                search = next(
                    command
                    for command in commands
                    if "scripts/build-search.js" in command
                )
                self.assertEqual("--development" in search, "development" in arguments)
                self.assertEqual(
                    any(
                        "scripts/validate-docs-output.py" in command
                        for command in commands
                    ),
                    full,
                )
                hugo = next(command for command in commands if command[0] == "hugo")
                self.assertEqual("--minify" in hugo, full)
                self.assertEqual("--gc" in hugo, full)

    def test_failed_step_stops_preparation(self) -> None:
        builder = load_script("build-website")
        with (
            patch("sys.argv", ["build-website.py"]),
            patch.object(
                builder.subprocess,
                "run",
                side_effect=subprocess.CalledProcessError(1, ["node"]),
            ) as run,
        ):
            self.assertEqual(builder.main(), 1)
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()
