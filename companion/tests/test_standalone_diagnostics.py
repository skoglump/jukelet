"""Pure diagnostic projection controls; no HA process, app, scan or credentials."""

import io
import json
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import Mock, patch

from companion.standalone_diagnostics import scan_diagnostic, trace_scan


class StandaloneDiagnosticTests(unittest.TestCase):
    def test_helper_import_needs_only_the_standard_library(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-S",
                "-c",
                "import sys; import companion.standalone_diagnostics; "
                "assert 'aiohttp' not in sys.modules; assert 'homeassistant' not in sys.modules",
            ],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_only_finite_reason_state_and_elapsed_counts_leave_observed_status(self) -> None:
        status = {
            "publisher_id": "SECRET_PUBLISHER",
            "dispatcher": {
                "ready": False,
                "busy": True,
                "execution_uncertain": False,
                "readiness_error": None,
                "diagnostics": [
                    {"reason": "ignored_busy", "tag_id": "SECRET_TAG"},
                    {"reason": "SECRET_REASON", "correlation_id": "SECRET_CORRELATION"},
                ],
            },
        }
        result = scan_diagnostic(status, status, [("initial_pair", 100, 250_000_100, 2, 1)])
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertEqual(result["after"]["reason_order"], ["ignored_busy", "unknown_reason"])
        self.assertEqual(result["after"]["unknown_reason_count"], 1)
        self.assertEqual(result["trace"][0]["elapsed_ms"], 250)
        self.assertEqual(result["after"]["reason_tags"], ["other", "missing"])
        self.assertEqual(
            result["missing_required_reasons"], ["ignored_duplicate", "rejected_mapping"]
        )

    @staticmethod
    def status() -> dict[str, Any]:
        return {
            "dispatcher": {
                "busy": False,
                "ready": True,
                "execution_uncertain": False,
                "readiness_error": None,
                "diagnostics": [],
            }
        }

    def test_missing_reason_assessment_uses_the_same_final_status_and_preserves_order(self) -> None:
        before, after = self.status(), self.status()
        before["dispatcher"]["diagnostics"] = [{"reason": "ignored_duplicate"}]
        order = [
            "ignored_busy",
            "invocation_requested",
            "execution_result",
            "ignored_busy",
            "rejected_mapping",
        ]
        after["dispatcher"]["diagnostics"] = [{"reason": reason} for reason in order]
        result = scan_diagnostic(
            before,
            after,
            [
                ("initial_pair", 1, 250_000_001, 2, 1),
                ("duplicate_album", 251_000_001, 502_000_001, 1, 1),
            ],
        )
        self.assertEqual(result["after"]["reason_order"], order)
        self.assertEqual(result["missing_required_reasons"], ["ignored_duplicate"])
        self.assertEqual(result["trace"][1]["started_ms"], 251)
        self.assertEqual(result["trace"][1]["captures"], 1)

    def test_trace_calls_original_scan_once_preserves_objects_and_does_not_emit_between_scans(
        self,
    ) -> None:
        events, captures = [{"tag_id": "SECRET_TAG"}], [{"request": "SECRET_REQUEST"}]
        trace: list[tuple[str, int, int, int, int]] = []
        runtime = SimpleNamespace(local=Mock(return_value={"captures": captures}))
        output = io.StringIO()
        with (
            patch(
                "companion.standalone_diagnostics.time.monotonic_ns", side_effect=[100, 250_000_100]
            ),
            redirect_stdout(output),
        ):
            result = trace_scan(runtime, "initial_pair", events, trace)
        self.assertIs(result, captures)
        runtime.local.assert_called_once_with("scan", events=events)
        self.assertIs(runtime.local.call_args.kwargs["events"], events)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(trace, [("initial_pair", 100, 250_000_100, 1, 1)])

    def test_unknown_readiness_and_associated_tag_are_classified_without_copying_values(
        self,
    ) -> None:
        status = self.status()
        status["dispatcher"]["readiness_error"] = "SECRET_READINESS"
        status["dispatcher"]["diagnostics"] = [
            {"reason": "ignored_busy", "tag_id": {"secret": "SECRET_TAG"}}
        ]
        result = scan_diagnostic(status, status, [("duplicate_album", 100, 200, 1, 1)])
        self.assertEqual(result["after"]["readiness_error"], "unknown_reason")
        self.assertEqual(result["after"]["reason_tags"], ["other"])
        self.assertNotIn("SECRET", json.dumps(result))

    def test_projection_refuses_unbounded_or_malformed_diagnostic_inputs(self) -> None:
        trace = [("initial_pair", 100, 200, 2, 1)]
        for field, value in (("busy", "SECRET"), ("diagnostics", [{}] * 33)):
            status = self.status()
            status["dispatcher"][field] = value
            with self.subTest(field=field), self.assertRaises(AssertionError):
                scan_diagnostic(status, status, trace)
        for bad in (
            [],
            trace * 8,
            [("SECRET_LABEL", 100, 200, 2, 1)],
            [("initial_pair", 100, 200, True, 1)],
            [("initial_pair", 100, 99, 1, 1)],
            [("initial_pair", 100, 600_000_000_101, 1, 1)],
            [("initial_pair", 100, 200, 1, 1001)],
        ):
            with self.subTest(trace=bad), self.assertRaises(AssertionError):
                scan_diagnostic(
                    self.status(), self.status(), cast(list[tuple[str, int, int, int, int]], bad)
                )


if __name__ == "__main__":
    unittest.main()
