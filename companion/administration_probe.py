"""Actual isolated HA administrator options HTTP flow with inert startup scripts."""

import shutil
import socket
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path
from typing import Any

from companion.dispatcher_probe import DispatcherRuntime
from companion.tests.fixtures import snapshot


def main() -> None:
    assert len(sys.argv) == 1, "No external target/configuration/credentials accepted"
    assert version("homeassistant") == "2026.10.2"
    with tempfile.TemporaryDirectory(prefix="jukelet-ha-administration-") as temporary:
        directory = Path(temporary)
        shutil.copytree(
            Path(__file__).parent / "custom_components", directory / "custom_components"
        )
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        runtime = DispatcherRuntime(directory, port)

        def flow(
            data: dict[str, Any] | None = None,
            flow_id: str | None = None,
            *,
            admin: bool = True,
            method: str = "POST",
            status: int = 200,
        ) -> dict[str, Any]:
            request: dict[str, Any] = {"type": "control_flow", "admin": admin, "method": method}
            if data is not None:
                request["data"] = data
            if flow_id is not None:
                request["flow_id"] = flow_id
            runtime.pipe.send(request)
            result = runtime.receive()
            assert result["status"] == status, result
            return result["body"] or {}

        def prepare(action: str) -> dict[str, Any]:
            initial = flow()
            assert initial["type"] == "menu" and initial["step_id"] == "init", initial
            page = flow({"next_step_id": "playback"}, initial["flow_id"])
            assert page["step_id"] == "playback", page
            page = flow({"next_step_id": action}, page["flow_id"])
            assert page["step_id"] == action, page
            return page

        def confirm(page: dict[str, Any], action: str, value: bool = True) -> dict[str, Any]:
            field = {
                "enable": "confirm_legacy_disabled",
                "reconcile": "confirm_all_stopped",
                "disable": "confirm_disable",
            }[action]
            return flow({field: value}, page["flow_id"])

        def actual() -> dict[str, Any]:
            response = runtime.request("diagnostics", diagnostics_version=1)
            assert response["success"], response
            return response["result"]

        def result(page: dict[str, Any], outcome: str) -> None:
            assert page["step_id"] == "control_result", page
            assert outcome in page["description_placeholders"]["outcome"], page
            assert "Observed " in page["description_placeholders"]["state"], page

        try:
            assert runtime.request("publish", snapshot=snapshot())["success"]
            assert runtime.request(
                "configure_dispatch", profiles={"default": "script.synthetic_dispatch"}
            )["success"]
            flow(admin=False, status=401)
            initial = flow()
            page = flow({"next_step_id": "playback"}, initial["flow_id"])
            runtime.pipe.send({"type": "control_prepare_unavailable"})
            assert runtime.receive() == {"installed": True}
            unavailable = flow({"next_step_id": "enable"}, page["flow_id"])
            assert unavailable["type"] == "abort" and unavailable["reason"] == "control_not_ready"
            assert not actual()["dispatch_enabled"]
            enable = prepare("enable")
            for method in ("GET", "POST"):
                flow(
                    {"confirm_legacy_disabled": True},
                    enable["flow_id"],
                    admin=False,
                    method=method,
                    status=401,
                )
            assert not actual()["dispatch_enabled"]
            declined = confirm(enable, "enable", False)
            assert declined["errors"] == {"base": "confirmation_required"}
            assert not actual()["dispatch_enabled"]
            result(confirm(declined, "enable"), "rejected")
            assert actual()["execution_uncertain"]
            reconcile = prepare("reconcile")
            declined = confirm(reconcile, "reconcile", False)
            assert declined["errors"] == {"base": "confirmation_required"}
            assert actual()["execution_uncertain"]
            result(confirm(declined, "reconcile"), "confirmed")
            assert not actual()["execution_uncertain"] and not actual()["dispatch_enabled"]
            enable = prepare("enable")
            result(confirm(enable, "enable"), "confirmed")
            assert actual()["dispatch_enabled"]
            assert runtime.scan([]) == [], "Controls must not invoke startup"
            result(confirm(prepare("disable"), "disable"), "confirmed")
            print(
                "PASS real HA options HTTP: nonadmin init/forged "
                "continuation/read denied; declined confirmations; separate reconciliation "
                "and legacy-attested enable; no invocation"
            )

            first, stale = prepare("enable"), prepare("enable")
            result(confirm(first, "enable"), "confirmed")
            rejected = confirm(stale, "enable")
            result(rejected, "rejected")
            assert "stale state" in rejected["description_placeholders"]["outcome"]
            result(confirm(prepare("disable"), "disable"), "confirmed")
            for fault in ("lost_ack", "malformed_ack", "readback"):
                page = prepare("enable")
                runtime.pipe.send({"type": "control_fault", "fault": fault})
                assert runtime.receive() == {"installed": True}
                page = confirm(page, "enable")
                assert "uncertain" in page["description_placeholders"]["outcome"]
                if fault == "readback":
                    assert "unavailable" in page["description_placeholders"]["state"]
                else:
                    result(page, "uncertain")
                    assert "Dispatch: enabled" in page["description_placeholders"]["state"]
                assert actual()["dispatch_enabled"]
                assert runtime.scan([]) == []
                result(confirm(prepare("disable"), "disable"), "confirmed")
            print(
                "PASS competing reviewed intents reject stale state; "
                "lost/malformed action acknowledgments and unavailable readback "
                "remain uncertain without retry"
            )

            runtime.pipe.send({"type": "control_concurrency"})
            assert runtime.receive() == {"one_write": True, "second_rejected_busy": True}
            assert not actual()["dispatch_enabled"] and not actual()["execution_uncertain"]
            print(
                "PASS actual overlapping HA HTTP reconciliations: second rejects busy "
                "before release; one fence write; independent final readbacks"
            )

            old_pid = runtime.process.pid
            runtime.close()
            runtime = DispatcherRuntime(directory, port)
            assert runtime.process.pid != old_pid
            assert not actual()["dispatch_enabled"] and actual()["ready"]
            enable = prepare("enable")
            assert "Disabled after startup" in enable["description_placeholders"]["state"]
            result(confirm(enable, "enable"), "confirmed")
            captures = runtime.scan([{"tag_id": "SYNTHETIC_Å"}], wait=0.02)
            assert len(captures) == 1
            busy = prepare("enable")
            assert "Busy: True" in busy["description_placeholders"]["state"]
            result(confirm(busy, "enable"), "rejected")
            assert len(runtime.scan([], wait=0.4)) == 1
            result(confirm(prepare("disable"), "disable"), "confirmed")
            print(
                "PASS actual clean HA restart disabled-ready; explicit enable "
                "does not replay; actual inert busy execution rejects control"
            )

            for script in ("missing_completion", "invalid_failure"):
                assert runtime.request(
                    "configure_dispatch", profiles={"default": "script.synthetic_" + script}
                )["success"]
                result(confirm(prepare("reconcile"), "reconcile"), "confirmed")
                result(confirm(prepare("enable"), "enable"), "confirmed")
                before = len(runtime.scan([]))
                assert len(runtime.scan([{"tag_id": "SYNTHETIC_Å"}])) == before + 1
                assert actual()["execution_uncertain"] and not actual()["dispatch_enabled"]
                result(confirm(prepare("enable"), "enable"), "rejected")
                assert len(runtime.scan([])) == before + 1
            runtime.close()
            runtime = DispatcherRuntime(directory, port)
            assert actual()["execution_uncertain"] and not actual()["dispatch_enabled"]
            result(confirm(prepare("enable"), "enable"), "rejected")
            result(confirm(prepare("reconcile"), "reconcile"), "confirmed")
            assert not actual()["dispatch_enabled"]
            print(
                "PASS actual missing/malformed completion fence and failure "
                "restart; enable blocked until explicit stopped-work reconciliation, "
                "still disabled, no replay"
            )
        finally:
            runtime.close()


if __name__ == "__main__":
    main()
