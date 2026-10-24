"""Opt-in admin timeout rehearsal in fresh synthetic HA processes only."""

import shutil
import socket
import sys
import tempfile
import time
from importlib.metadata import version
from pathlib import Path

from companion.dispatcher_probe import DispatcherRuntime
from companion.tests.fixtures import snapshot


def main() -> None:
    assert len(sys.argv) == 1, "No external target or configuration inputs allowed"
    assert version("homeassistant") == "2026.10.2"
    with tempfile.TemporaryDirectory(prefix="jukelet-ha-timeout-") as temporary:
        directory = Path(temporary)
        shutil.copytree(
            Path(__file__).parent / "custom_components", directory / "custom_components"
        )
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        runtime = DispatcherRuntime(directory, port)
        try:
            response = runtime.request("dispatch_config")
            assert response["success"], response
            assert response["result"] == {"profiles": {}, "timeout_seconds": 30.0}
            profiles = {"default": "script.synthetic_slow"}
            original = runtime.request("publish", snapshot=snapshot())["result"]
            assert runtime.request("configure_dispatch", profiles=profiles)["success"]
            assert runtime.request("dispatch_config")["result"]["timeout_seconds"] == 30
            assert runtime.request("dispatch", action="reconcile", confirmed_stopped=True)[
                "success"
            ]
            assert runtime.request("dispatch", action="enable")["success"]
            event = {"tag_id": "SYNTHETIC_Å"}
            started = time.monotonic()
            assert len(runtime.scan([event], wait=0.1)) == 1
            assert runtime.request("status")["result"]["dispatcher"]["busy"]
            # Enabled configuration and disabled-but-busy configuration cannot mutate.
            assert (
                runtime.request("configure_dispatch", profiles={}, timeout_seconds=45)["error"][
                    "code"
                ]
                == "busy"
            )
            assert runtime.request("dispatch", action="disable")["success"]
            assert (
                runtime.request("configure_dispatch", profiles={}, timeout_seconds=45)["error"][
                    "code"
                ]
                == "busy"
            )
            assert runtime.request("dispatch_config")["result"] == {
                "profiles": profiles,
                "timeout_seconds": 30.0,
            }
            assert len(runtime.scan([event], wait=32)) == 1
            timed_out = runtime.request("status")["result"]
            assert time.monotonic() - started >= 30
            assert not timed_out["dispatch_enabled"]
            assert timed_out["dispatcher"]["execution_uncertain"]
            result = timed_out["dispatcher"]["diagnostics"][-1]
            assert (result["execution"], result["error"]) == ("unknown", "timeout"), result
            assert not runtime.request("dispatch", action="enable")["success"]
            print("PASS default30 real deadline, enabled/busy rejection, durable unknown/no replay")

            configured = runtime.request(
                "configure_dispatch", profiles=profiles, timeout_seconds=45
            )
            assert configured["success"], configured
            expected = {"profiles": profiles, "timeout_seconds": 45}
            assert runtime.request("dispatch_config")["result"] == expected
            assert not runtime.request("status")["result"]["dispatch_enabled"]
            assert runtime.request("status")["result"]["dispatcher"]["execution_uncertain"]
            # All rejected input leaves both live configuration and persistent entry untouched.
            for invalid in (None, True, False, "45", 0, -1, 300.01):
                rejected = runtime.request(
                    "configure_dispatch", profiles={}, timeout_seconds=invalid
                )
                assert not rejected["success"], (invalid, rejected)
                assert runtime.request("dispatch_config")["result"] == expected
            runtime.pipe.send({"type": "nonfinite_timeout"})
            assert runtime.receive() == {"rejected": True}
            assert runtime.request("dispatch_config")["result"] == expected
            assert not runtime.request(
                "configure_dispatch",
                profiles={"other": "script.synthetic_dispatch"},
                timeout_seconds=60,
            )["success"]
            assert runtime.request("dispatch_config")["result"] == expected
            assert runtime.request("configure_dispatch", profiles=profiles)["success"]
            assert runtime.request("dispatch_config")["result"] == expected
            runtime.pipe.send({"type": "invalid_persisted_timeout"})
            assert runtime.receive() == {"rejected": True}
            assert runtime.request("dispatch_config")["result"] == expected
            previous_pid = runtime.process.pid
            runtime.close()
            runtime = DispatcherRuntime(directory, port)
            assert runtime.process.pid != previous_pid
            assert runtime.request("dispatch_config")["result"] == expected
            recovered = runtime.request("status")["result"]
            assert not recovered["dispatch_enabled"]
            assert recovered["dispatcher"]["execution_uncertain"]
            assert runtime.scan([event]) == []
            assert not runtime.request("dispatch", action="enable")["success"]
            assert set(recovered) == set(original)
            assert set(recovered["dispatcher"]) == set(original["dispatcher"])
            for field in ("active_revision", "active_checksum", "publisher_id"):
                assert recovered[field] == original[field]
            print("PASS admin readback, invalid config, omission, reload and distinct PID restart")

            assert runtime.request("dispatch", action="reconcile", confirmed_stopped=True)[
                "success"
            ]
            assert runtime.request("dispatch", action="enable")["success"]
            started = time.monotonic()
            assert len(runtime.scan([event, event], wait=0.1)) == 1
            assert runtime.request("status")["result"]["dispatcher"]["busy"]
            assert len(runtime.scan([event], wait=32)) == 1
            completed = runtime.request("status")["result"]
            assert time.monotonic() - started > 30
            assert not completed["dispatcher"]["execution_uncertain"]
            result = completed["dispatcher"]["diagnostics"][-1]
            assert result["execution"] == "finished" and result["error"] is None, result
            assert result["snapshot_revision"] == original["active_revision"]
            assert result["playback_verification"] == "unavailable"
            assert runtime.request("dispatch", action="disable")["success"]
            assert len(runtime.scan([], wait=0.2)) == 1
            # Numeric boundary values are accepted without activation or invocation.
            for timeout in (0.01, 300):
                assert runtime.request(
                    "configure_dispatch", profiles=profiles, timeout_seconds=timeout
                )["success"]
                assert runtime.request("dispatch_config")["result"]["timeout_seconds"] == timeout
                assert not runtime.request("status")["result"]["dispatch_enabled"]
            print("PASS explicit45 completes inert31s startup, busy drop/no replay, v1 unchanged")
        finally:
            runtime.close()


if __name__ == "__main__":
    main()
