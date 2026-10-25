"""Probe isolation regressions; do not require an HA installation."""

import sys
import tempfile
import unittest
from multiprocessing import spawn
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import cast
from unittest.mock import patch

from companion.probe_support import probe_ha_version, start_probe_process


class ProbeSupportTests(unittest.TestCase):
    def test_unknown_probe_environment_is_rejected(self) -> None:
        with patch("companion.probe_support.version", return_value="2026.10.2"):
            with self.assertRaises(AssertionError):
                probe_ha_version()

    def test_child_uses_its_own_import_paths_and_parent_is_restored(self) -> None:
        self.check_start(False)

    def test_failed_launch_still_restores_parent_interpreter_and_import_paths(self) -> None:
        self.check_start(True)

    def check_start(self, fail: bool) -> None:
        original_path = list(sys.path)
        original_executable = spawn.get_executable()
        with tempfile.TemporaryDirectory(prefix="jukelet-probe-start-") as directory:
            executable = Path(directory) / "synthetic-python"
            executable.touch()
            observed: dict[str, object] = {}

            class Process:
                def start(self) -> None:
                    observed["executable"] = spawn.get_executable()
                    observed["path"] = list(sys.path)
                    if fail:
                        raise RuntimeError("synthetic launch failure")

            with patch(
                "companion.probe_support.subprocess.check_output",
                return_value='["/synthetic-child/stdlib", "/synthetic-child/site-packages"]',
            ):
                if fail:
                    with self.assertRaisesRegex(RuntimeError, "synthetic launch failure"):
                        start_probe_process(cast(BaseProcess, Process()), executable)
                else:
                    start_probe_process(cast(BaseProcess, Process()), executable)
            self.assertEqual(observed["executable"], str(executable).encode())
            child_path = cast(list[str], observed["path"])
            self.assertEqual(
                child_path[1:], ["/synthetic-child/stdlib", "/synthetic-child/site-packages"]
            )
            self.assertEqual(sys.path, original_path)
            self.assertEqual(spawn.get_executable(), original_executable)
