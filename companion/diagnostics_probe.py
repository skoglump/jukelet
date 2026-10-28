"""Actual isolated HA diagnostics with inert scripts and generated loopback auth only."""

import socket
import sys
import tempfile
from pathlib import Path
from typing import Any

from companion.dispatcher_probe import DispatcherRuntime
from companion.probe_support import install_probe_component, probe_ha_version
from companion.tests.fixtures import snapshot


def main() -> None:
    assert len(sys.argv) == 1, "No external target or configuration inputs allowed"
    probe_ha_version()
    with tempfile.TemporaryDirectory(prefix="jukelet-ha-diagnostics-") as temporary:
        directory = Path(temporary)
        install_probe_component(directory)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        runtime = DispatcherRuntime(directory, port)

        def read() -> dict[str, Any]:
            response = runtime.request("diagnostics", diagnostics_version=1)
            assert response["success"], response
            result: dict[str, Any] = response["result"]
            assert result["playback_verification"] == "unavailable"
            assert "SYNTHETIC_Å" not in str(result)
            assert "spotify:" not in str(result) and "script.synthetic" not in str(result)
            assert "configured_profiles" not in result
            return result

        event = {"tag_id": "SYNTHETIC_Å"}
        try:
            initial = read()
            assert initial["pause_reason"] == "startup" and initial["last_scan_at"] is None
            assert initial["last_attempt"] is None and not initial["dispatch_enabled"]
            for bad_version in (True, 1.0, 2):
                assert not runtime.request("diagnostics", diagnostics_version=bad_version)[
                    "success"
                ]
            assert runtime.request("publish", snapshot=snapshot())["success"]
            assert runtime.request(
                "configure_dispatch", profiles={"default": "script.synthetic_dispatch"}
            )["success"]
            assert runtime.request("dispatch", action="reconcile", confirmed_stopped=True)[
                "success"
            ]
            idle = read()
            assert idle["ready"] and not idle["dispatch_enabled"]
            assert runtime.scan([]) == []
            assert runtime.request("dispatch", action="enable")["success"]
            with runtime.hold_captures():
                captures = runtime.scan_until([event], captures=1, settled=False)
                assert len(captures) == 1
                busy = read()
                assert busy["busy"] and busy["last_attempt"]["invocation"] == "requested"
                assert busy["last_attempt"]["correlation_id"] == captures[0]["correlation_id"]
                assert len(runtime.scan([event])) == 1
            assert len(runtime.scan_until([], captures=1)) == 1
            finished = read()
            assert finished["dispatch_enabled"] and finished["ready"] and not finished["busy"]
            assert finished["last_attempt"]["execution"] == "finished"
            assert finished["last_attempt"]["completed_at"] is not None
            assert finished["last_scan_at"] is not None
            assert any(row["reason"] == "ignored_busy" for row in finished["diagnostics"])
            print(
                "PASS fresh read-only readiness, absent scan, busy drop "
                "and correlated script completion; app absent"
            )

            old_pid = runtime.process.pid
            runtime.close()
            runtime = DispatcherRuntime(directory, port)
            assert runtime.process.pid != old_pid
            restarted = read()
            assert restarted["pause_reason"] is None and restarted["ready"]
            assert restarted["dispatch_enabled"] and restarted["last_attempt"] is None
            assert restarted["last_scan_at"] is None and restarted["diagnostics"] == []
            assert runtime.scan([]) == []
            print(
                "PASS actual process restart: remembered enabled and ready, "
                "fresh empty volatile diagnostic window; no replay"
            )
            # Configuration changes still require an explicit maintenance pause.
            assert runtime.request("dispatch", action="disable")["success"]

            for name, expected_execution, expected_error in (
                ("readiness_failure", "failed", "readiness_failed"),
                ("missing_completion", "unknown", "completion_unavailable"),
                ("mismatched_failure", "unknown", "invalid_completion"),
                ("invalid_failure", "unknown", "invalid_completion"),
            ):
                assert runtime.request(
                    "configure_dispatch",
                    profiles={"default": "script.synthetic_" + name},
                )["success"]
                assert runtime.request("dispatch", action="reconcile", confirmed_stopped=True)[
                    "success"
                ]
                assert runtime.request("dispatch", action="enable")["success"]
                before = len(runtime.scan([]))
                captures = runtime.scan_until([event], captures=before + 1)
                assert len(captures) == before + 1
                failure = read()
                assert failure["last_attempt"]["correlation_id"] == captures[-1]["correlation_id"]
                assert (
                    failure["last_attempt"]["execution"],
                    failure["last_attempt"]["error"],
                ) == (expected_execution, expected_error)
                assert failure["execution_uncertain"] and not failure["dispatch_enabled"]
                # Repeated diagnostic reads cannot clear uncertainty or enable/retry.
                for _ in range(3):
                    assert read()["execution_uncertain"]
                assert not runtime.request("dispatch", action="enable")["success"]
                assert len(runtime.scan([event])) == before + 1
            print(
                "PASS trustworthy preparation failure vs missing/mismatched/boolean completion; "
                "fence retained, no retry"
            )
            runtime.close()
            runtime = DispatcherRuntime(directory, port)
            failure_restart = read()
            assert (
                failure_restart["execution_uncertain"] and failure_restart["last_attempt"] is None
            )
            assert not failure_restart["dispatch_enabled"]
            assert not runtime.request("dispatch", action="enable")["success"]
            assert runtime.scan([event]) == []
            print(
                "PASS uncertainty survives actual restart while historical failure detail "
                "becomes unknown; non-admin diagnostics denied"
            )
        finally:
            runtime.close()


if __name__ == "__main__":
    main()
