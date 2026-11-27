"""Probe scheduling regressions; synthetic delayed state, no Home Assistant required."""

import subprocess
import sys
import time
import unittest
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import Mock, patch

from companion.dispatcher_probe import DispatcherRuntime
from companion.distribution_probe import seed
from companion.probe_support import wait_for_healthy_dispatch
from companion.standalone_diagnostics import trace_scan
from companion.standalone_probe import (
    ALBUM,
    PLAYLIST,
    PUBLISHER,
    SCRIPT,
    StandaloneRuntime,
    trace_duplicate_scan,
)


class DelayedRuntime:
    # Exercise the real parent-side synchronization against a delayed fake child.
    scan_until = DispatcherRuntime.scan_until
    hold_captures = DispatcherRuntime.hold_captures
    process: BaseProcess

    def __init__(self, *, uncertain: bool = False) -> None:
        self.pipe = cast(Connection, SimpleNamespace(send=self.send))
        self.command: dict[str, Any] = {}
        self.finished_at = 0.0
        self.uncertain = uncertain

    def send(self, command: dict[str, Any]) -> None:
        self.command = command

    def request(self, kind: str, **fields: Any) -> dict[str, Any]:
        return {"success": True, "result": {"dispatcher": {"busy": self.busy}}}

    @property
    def busy(self) -> bool:
        return time.monotonic() < self.finished_at

    def scan(self, events: list[dict[str, Any]], wait: float = 0.4) -> list[dict[str, Any]]:
        if events:
            # Invocation is observed before the completion Store write finishes.
            self.finished_at = time.monotonic() + 0.6
        time.sleep(wait)
        return [{"correlation_id": "synthetic-completed-invocation"}]

    def receive(self) -> dict[str, Any]:
        if self.command["type"] == "distribution_recover":
            return {"flow_type": "create_entry"}
        assert self.command["type"] == "distribution_state"
        return {"fence": {"version": 1, "uncertain": self.uncertain or self.busy}}


class DelayedStandaloneCompletion:
    """A capture/result is visible while the synthetic completion write stays busy."""

    def __init__(self, completion_delay: float = 0.6) -> None:
        self.completion_delay = completion_delay
        self.busy_until = 0.0
        self.submitted_at = 0.0
        self.captures: list[dict[str, Any]] = []
        self.reasons: list[str] = []
        self.duplicate_submissions: list[float] = []

    @property
    def busy(self) -> bool:
        return time.monotonic() < self.busy_until

    def status(self) -> dict[str, Any]:
        return {
            "publisher_id": PUBLISHER,
            "active_revision": 1,
            "active_checksum": "a" * 64,
            "persistence": "healthy",
            "dispatch_enabled": True,
            "dispatcher": {
                "busy": self.busy,
                "execution_uncertain": False,
                "ready": True,
                "readiness_error": None,
                "configured_profiles": {"default": SCRIPT},
                "playback_verification": "unavailable",
                "diagnostics": [{"reason": reason} for reason in self.reasons],
            },
        }

    def request(self, kind: str, **fields: Any) -> dict[str, Any]:
        assert kind == "status" and not fields
        return {"success": True, "result": self.status()}

    def local(self, kind: str, **fields: Any) -> dict[str, Any]:
        assert kind == "scan"
        events = fields["events"]
        if not self.captures:
            assert [event["tag_id"] for event in events] == [ALBUM, PLAYLIST]
            self.submitted_at = time.monotonic()
            self.busy_until = self.submitted_at + self.completion_delay
            self.captures.append({"route": "new", "request": dict(events[0])})
            self.reasons.extend(["ignored_busy", "invocation_requested", "execution_result"])
        else:
            assert len(events) == 1 and events[0]["tag_id"] == ALBUM
            submitted = time.monotonic()
            self.duplicate_submissions.append(submitted)
            if self.busy:
                self.reasons.append("ignored_busy")
            elif submitted - self.submitted_at < 2:
                self.reasons.append("ignored_duplicate")
            else:
                self.captures.append({"route": "new", "request": dict(events[0])})
                self.reasons.append("invocation_requested")
        time.sleep(0.25)  # Match the actual child scan response's existing fixed wait.
        return {"captures": self.captures}


class ProbeSynchronizationTests(unittest.TestCase):
    @staticmethod
    def dispatch_status(**changes: Any) -> dict[str, Any]:
        return {
            "dispatch_enabled": True,
            "dispatcher": {
                "busy": False,
                "execution_uncertain": False,
                "ready": True,
                "readiness_error": None,
                **changes,
            },
        }

    def test_duplicate_scan_waits_for_completion_idle_after_capture_and_result_are_visible(
        self,
    ) -> None:
        synthetic = DelayedStandaloneCompletion()
        runtime = cast(StandaloneRuntime, synthetic)
        before = synthetic.status()
        trace: list[tuple[str, int, int, int, int]] = []
        event = {"tag_id": ALBUM, "device_id": "Synthetic reader Å"}
        captures = trace_scan(
            runtime, "initial_pair", [event, {**event, "tag_id": PLAYLIST}], trace
        )
        self.assertEqual(len(captures), 1)
        self.assertIn("execution_result", synthetic.reasons)
        self.assertTrue(synthetic.busy)
        captured = trace_duplicate_scan(runtime, event, trace, before)
        self.assertEqual(len(captured), 1)
        self.assertIn("ignored_duplicate", synthetic.reasons)
        self.assertEqual(len(synthetic.duplicate_submissions), 1)
        self.assertLess(synthetic.duplicate_submissions[0] - synthetic.submitted_at, 2)
        self.assertEqual([row[0] for row in trace], ["initial_pair", "duplicate_album"])
        with self.assertRaises(AssertionError):
            trace_duplicate_scan(runtime, event, trace, before)
        self.assertEqual(len(synthetic.duplicate_submissions), 1)

    @staticmethod
    def initial_scan_trace(origin: float = 0) -> list[tuple[str, int, int, int, int]]:
        begin = int(origin * 1_000_000_000)
        return [("initial_pair", begin, begin + 250_000_000, 2, 1)]

    def test_duplicate_budget_is_remaining_from_initial_submission_not_a_new_wait_window(
        self,
    ) -> None:
        before = DelayedStandaloneCompletion().status()
        busy = {**before, "dispatcher": {**before["dispatcher"], "busy": True}}
        runtime = Mock(spec=StandaloneRuntime)
        clock = [1.9]  # The original pair has already consumed1.9s of its2s budget.

        def read(*args: Any, **fields: Any) -> dict[str, Any]:
            clock[0] += 0.04
            return {"success": True, "result": busy}

        runtime.request.side_effect = read
        trace = self.initial_scan_trace()
        with (
            patch("companion.standalone_probe.time.monotonic", side_effect=lambda: clock[0]),
            patch("companion.probe_support.time.sleep"),
            self.assertRaises(TimeoutError),
        ):
            trace_duplicate_scan(runtime, {"tag_id": ALBUM}, trace, before)
        self.assertLessEqual(runtime.request.call_count, 3)
        runtime.local.assert_not_called()
        self.assertEqual(len(trace), 1)

    def test_duplicate_after_exhausted_budget_does_not_read_or_submit_any_scan(self) -> None:
        runtime = Mock(spec=StandaloneRuntime)
        with (
            patch("companion.standalone_probe.time.monotonic", return_value=2),
            self.assertRaises(TimeoutError),
        ):
            trace_duplicate_scan(
                runtime,
                {"tag_id": ALBUM},
                self.initial_scan_trace(),
                DelayedStandaloneCompletion().status(),
            )
        runtime.request.assert_not_called()
        runtime.local.assert_not_called()

    def test_late_healthy_observation_does_not_submit_duplicate_after_original_deadline(
        self,
    ) -> None:
        before = DelayedStandaloneCompletion().status()
        for ticks in ([1.9, 1.9, 2.01], [1.9, 1.9, 1.99, 2.01]):
            # First case: status returns late. Second: it was timely, but the
            # original absolute budget expires immediately before submission.
            runtime = Mock(spec=StandaloneRuntime)
            runtime.request.return_value = {"success": True, "result": before}
            with (
                self.subTest(ticks=ticks),
                patch("companion.standalone_probe.time.monotonic", side_effect=ticks),
                self.assertRaises(TimeoutError),
            ):
                trace_duplicate_scan(runtime, {"tag_id": ALBUM}, self.initial_scan_trace(), before)
            self.assertEqual(runtime.request.call_count, 1)
            runtime.local.assert_not_called()

    def test_duplicate_wait_accepts_only_owned_pending_uncertainty_then_healthy_idle(self) -> None:
        before = DelayedStandaloneCompletion().status()
        admitted = {
            **before,
            "dispatcher": {
                **before["dispatcher"],
                "busy": True,
                "execution_uncertain": True,
                "ready": False,
                "readiness_error": "execution_uncertain",
            },
        }
        completing = {**before, "dispatcher": {**before["dispatcher"], "busy": True}}
        runtime = Mock(spec=StandaloneRuntime)
        runtime.request.side_effect = [
            {"success": True, "result": value} for value in (admitted, completing, before)
        ]
        runtime.local.return_value = {"captures": [{"route": "new"}]}
        trace = self.initial_scan_trace()
        with (
            patch("companion.standalone_probe.time.monotonic", return_value=0.5),
            patch("companion.probe_support.time.sleep"),
        ):
            captured = trace_duplicate_scan(runtime, {"tag_id": ALBUM}, trace, before)
        self.assertEqual(captured, [{"route": "new"}])
        self.assertEqual(runtime.request.call_count, 3)
        runtime.local.assert_called_once_with("scan", events=[{"tag_id": ALBUM}])

    def test_duplicate_wait_rejects_changed_context_lost_readiness_and_missing_facts_once(
        self,
    ) -> None:
        before = DelayedStandaloneCompletion().status()
        bad_statuses = [
            {**before, field: bad}
            for field, bad in (
                ("dispatch_enabled", False),
                ("publisher_id", "SYNTHETIC_OTHER"),
                ("active_revision", 2),
                ("active_checksum", "b" * 64),
                ("persistence", "empty"),
            )
        ]
        bad_statuses.extend(
            {**before, "dispatcher": {**before["dispatcher"], **bad}}
            for bad in (
                {"ready": False, "readiness_error": "script_unavailable_or_running"},
                {
                    "busy": True,
                    "ready": False,
                    "execution_uncertain": True,
                    "readiness_error": "profile_unconfigured",
                },
                {"busy": True, "execution_uncertain": True},
                {"busy": 1},
                {"ready": None},
                {"execution_uncertain": "false"},
                {"configured_profiles": {"default": "script.synthetic_other"}},
                {"playback_verification": "verified"},
            )
        )
        missing = {**before, "dispatcher": dict(before["dispatcher"])}
        del missing["dispatcher"]["execution_uncertain"]
        bad_statuses.append(missing)
        for status in bad_statuses:
            runtime = Mock(spec=StandaloneRuntime)
            runtime.request.return_value = {"success": True, "result": status}
            with (
                self.subTest(status=status),
                patch("companion.standalone_probe.time.monotonic", return_value=0.5),
                self.assertRaises((AssertionError, KeyError)),
            ):
                trace_duplicate_scan(runtime, {"tag_id": ALBUM}, self.initial_scan_trace(), before)
            self.assertEqual(runtime.request.call_count, 1)
            runtime.local.assert_not_called()

    def test_duplicate_wait_rejects_failed_or_missing_status_result_without_scan(self) -> None:
        before = DelayedStandaloneCompletion().status()
        for response in ({"success": False}, {"success": True}, {"result": before}):
            runtime = Mock(spec=StandaloneRuntime)
            runtime.request.return_value = response
            with (
                self.subTest(response=response),
                patch("companion.standalone_probe.time.monotonic", return_value=0.5),
                self.assertRaises((AssertionError, KeyError)),
            ):
                trace_duplicate_scan(runtime, {"tag_id": ALBUM}, self.initial_scan_trace(), before)
            self.assertEqual(runtime.request.call_count, 1)
            runtime.local.assert_not_called()

    def test_standalone_probe_sync_seam_import_needs_no_opt_in_ha_dependencies(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys; import companion.standalone_probe; "
                "assert 'aiohttp' not in sys.modules; assert 'homeassistant' not in sys.modules; "
                "assert 'companion.publication_probe' not in sys.modules",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_standalone_restart_waits_for_idle_and_completed_fence(self) -> None:
        admitted = self.dispatch_status(busy=True, execution_uncertain=True, ready=False)
        completing = self.dispatch_status(busy=True)
        idle = self.dispatch_status()
        # The old enabled-only observation accepts the admitted, unfinished case.
        self.assertTrue(admitted["dispatch_enabled"])
        request = Mock(side_effect=[{"result": state} for state in (admitted, completing, idle)])
        with (
            patch("companion.probe_support.time.sleep"),
            patch("companion.probe_support.time.monotonic", return_value=0),
        ):
            result = wait_for_healthy_dispatch(lambda: request("status")["result"])
        self.assertIs(result, idle)
        self.assertFalse(result["dispatcher"]["busy"])
        self.assertFalse(result["dispatcher"]["execution_uncertain"])
        self.assertEqual(request.call_count, 3)

    def test_standalone_restart_rejects_settled_uncertainty_or_lost_readiness(self) -> None:
        for status in (
            self.dispatch_status(execution_uncertain=True, ready=False),
            self.dispatch_status(ready=False, readiness_error="script_unavailable_or_running"),
            {**self.dispatch_status(), "dispatch_enabled": False},
        ):
            read = Mock(return_value=status)
            with self.subTest(status=status):
                with self.assertRaises(AssertionError):
                    wait_for_healthy_dispatch(read)
                self.assertEqual(read.call_count, 1)

    def test_standalone_restart_cannot_pass_after_observation_deadline(self) -> None:
        with (
            patch("companion.probe_support.time.monotonic", side_effect=[0, 6]),
            self.assertRaises(TimeoutError),
        ):
            wait_for_healthy_dispatch(lambda: self.dispatch_status(), timeout=5)

    def test_standalone_restart_fails_boundedly_when_work_never_settles(self) -> None:
        with (
            patch("companion.probe_support.time.sleep"),
            patch("companion.probe_support.time.monotonic", side_effect=[0, 0, 6]),
            self.assertRaises(TimeoutError),
        ):
            wait_for_healthy_dispatch(
                lambda: self.dispatch_status(busy=True, execution_uncertain=True, ready=False)
            )

    def test_upgrade_seed_samples_only_after_delayed_completion_persistence(self) -> None:
        runtime = DelayedRuntime()
        observed = seed(runtime, "script.synthetic_dispatch")
        self.assertEqual(observed["fence"], {"version": 1, "uncertain": False})
        self.assertFalse(runtime.busy)

    def test_settled_failure_preserves_uncertainty_instead_of_waiting_for_clear_fence(self) -> None:
        runtime = DelayedRuntime(uncertain=True)
        observed = seed(runtime, "script.synthetic_missing_completion")
        self.assertEqual(observed["fence"], {"version": 1, "uncertain": True})
        self.assertFalse(runtime.busy)

    def test_capture_wait_observes_delayed_admission_while_execution_stays_busy(self) -> None:
        runtime = DelayedRuntime()
        captured = [{"correlation_id": "synthetic-delayed-invocation"}]
        with patch.object(runtime, "scan", side_effect=[[], [], captured]):
            runtime.finished_at = time.monotonic() + 1
            self.assertEqual(
                runtime.scan_until([{"tag_id": "SYNTHETIC_Å"}], captures=1, settled=False),
                captured,
            )
            self.assertTrue(runtime.busy)

    def test_missing_capture_fails_at_bounded_deadline(self) -> None:
        runtime = DelayedRuntime()
        with patch.object(runtime, "scan", return_value=[]):
            with self.assertRaisesRegex(TimeoutError, "observed captures=0"):
                runtime.scan_until([], captures=1, timeout=0.02)

    def test_unfinished_persistence_fails_at_bounded_deadline(self) -> None:
        runtime = DelayedRuntime()
        runtime.finished_at = time.monotonic() + 1
        with self.assertRaisesRegex(TimeoutError, "busy=True"):
            runtime.scan_until([], captures=1, timeout=0.02)

    def test_extra_invocation_fails_instead_of_satisfying_expected_capture(self) -> None:
        runtime = DelayedRuntime()
        with patch.object(runtime, "scan", return_value=[{}, {}]):
            with self.assertRaises(AssertionError):
                runtime.scan_until([], captures=1)

    def test_late_successful_read_does_not_bypass_observation_deadline(self) -> None:
        runtime = DelayedRuntime()

        def delayed_status(*args: Any, **kwargs: Any) -> dict[str, Any]:
            time.sleep(0.03)
            return {"success": True, "result": {"dispatcher": {"busy": False}}}

        with patch.object(runtime, "request", side_effect=delayed_status):
            with self.assertRaises(TimeoutError):
                runtime.scan_until([], captures=1, timeout=0.01)

    def test_busy_capture_hold_is_released_even_when_assertion_fails(self) -> None:
        runtime = DelayedRuntime()
        runtime.process = cast(BaseProcess, SimpleNamespace(is_alive=lambda: True))
        with patch.object(runtime, "receive", side_effect=[{"held": True}, {"released": True}]):
            with self.assertRaisesRegex(AssertionError, "synthetic failed assertion"):
                with runtime.hold_captures():
                    self.assertEqual(runtime.command, {"type": "capture_hold"})
                    raise AssertionError("synthetic failed assertion")
        self.assertEqual(runtime.command, {"type": "capture_release"})
