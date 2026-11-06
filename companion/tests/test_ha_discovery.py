"""Synthetic public-release metadata; no network or HA dependencies."""

import unittest

from scripts.ha_compatibility import select_releases


def files(*, yanked: bool = False) -> list[dict[str, object]]:
    return [{"packagetype": "bdist_wheel", "yanked": yanked}]


class DiscoveryTests(unittest.TestCase):
    def test_latest_stable_and_upcoming_beta_discovered_without_source_edits(self) -> None:
        result = select_releases(
            {
                "2026.10.3": files(),
                "2026.10.4": files(),
                "2026.11.0b1": files(),
                "2026.11.0b2": files(),
                "2026.10.0b9": files(),
                "2026.11.0b3": files(yanked=True),
                "2026.12.0.dev0": files(),
                "2026.12.0": [],
                "garbage": files(),
            }
        )
        self.assertEqual(result["stable"], "2026.10.4")
        self.assertEqual(result["beta"], "2026.11.0b2")
        self.assertEqual(result["beta_status"], "available_early_warning")
        self.assertEqual(result["targets"], ["2026.10.3", "2026.10.4", "2026.11.0b2"])

    def test_absent_beta_is_not_a_passing_test_and_old_betas_are_ignored(self) -> None:
        result = select_releases({"2027.12.2": files(), "2027.12.0b9": files()})
        self.assertEqual(result["beta_status"], "not_available")
        self.assertIsNone(result["beta"])
        self.assertEqual(result["targets"], ["2026.10.3", "2026.10.4", "2027.12.2"])

    def test_new_year_beta_and_new_stable_need_no_allowlist_change(self) -> None:
        result = select_releases({"2027.12.2": files(), "2028.1.0b1": files()})
        self.assertEqual(result["beta"], "2028.1.0b1")

    def test_unavailable_or_below_minimum_stable_is_a_failure(self) -> None:
        for releases in ({}, {"2026.10.2": files()}, {"2026.11.0": files(yanked=True)}):
            with self.assertRaises(ValueError):
                select_releases(releases)


class InterpreterIsolationTests(unittest.TestCase):
    def test_runner_preserves_venv_python_symlink_for_upgrade_child(self) -> None:
        import hashlib
        import json
        import sys
        import tempfile
        from pathlib import Path
        from subprocess import CompletedProcess
        from unittest.mock import patch

        from scripts.ha_compatibility import run

        with tempfile.TemporaryDirectory(prefix="jukelet-compatibility-interpreter-") as root:
            directory = Path(root)
            python = directory / "owned-venv/bin/python"
            python.parent.mkdir(parents=True)
            python.symlink_to(sys.executable)
            archive = directory / "synthetic.zip"
            archive.touch()
            identity = {"core": "2026.10.4", "distribution": "2026.10.4", "dependencies": []}
            with (
                patch("scripts.package_integration.verify", return_value={}),
                patch("scripts.ha_compatibility.PROBES", ("distribution",)),
                patch(
                    "scripts.ha_compatibility.subprocess.check_output",
                    return_value=json.dumps(identity),
                ),
                patch(
                    "scripts.ha_compatibility.subprocess.run",
                    return_value=CompletedProcess([], 0, "", ""),
                ) as launch,
            ):
                run(python, python, archive, directory / "result", "uv")
            # Resolving the symlink changes sys.prefix and silently loses the venv's HA.
            self.assertEqual(launch.call_args.kwargs["env"]["JUKELET_BASELINE_PYTHON"], str(python))
            result = json.loads((directory / "result/result.json").read_text())
            source = Path("companion/standalone_diagnostics.py")
            self.assertIn(str(source), result["probe_sources"])
            self.assertEqual(
                result["probe_sources"][str(source)],
                hashlib.sha256(source.read_bytes()).hexdigest(),
            )


class PythonProvisioningTests(unittest.TestCase):
    def test_cli_reports_exact_upstream_python_for_setup_action(self) -> None:
        import base64
        import contextlib
        import io
        from unittest.mock import patch

        from scripts.ha_compatibility import main

        commit = "a" * 40
        output = io.StringIO()
        with (
            patch("sys.argv", ["ha_compatibility", "python-version", "--version", "2026.11.0b0"]),
            patch(
                "scripts.ha_compatibility.fetch",
                side_effect=[
                    {"object": {"sha": commit, "type": "commit"}},
                    {"content": base64.b64encode(b"3.14.10\n").decode()},
                ],
            ) as fetch,
            contextlib.redirect_stdout(output),
        ):
            main()
        self.assertEqual(output.getvalue(), "3.14.10\n")
        self.assertTrue(fetch.call_args.args[0].endswith("?ref=" + commit))
