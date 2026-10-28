"""Probe scheduling regressions; synthetic delayed state, no Home Assistant required."""

import time
import unittest
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import patch

from companion.dispatcher_probe import DispatcherRuntime
from companion.distribution_probe import seed


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


class ProbeSynchronizationTests(unittest.TestCase):
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
