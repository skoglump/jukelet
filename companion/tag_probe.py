"""Actual supported HA tag producer into the installed bridge; synthetic/inert only."""

import socket
import sys
import tempfile
from pathlib import Path
from typing import Any, cast

from companion.custom_components.jukelet_bridge.protocol import checksum
from companion.dispatcher_probe import DispatcherRuntime
from companion.probe_support import install_probe_component, probe_ha_version
from companion.tests.fixtures import snapshot


def main() -> None:
    assert len(sys.argv) == 1, "No external target or configuration inputs allowed"
    probe_ha_version()
    with tempfile.TemporaryDirectory(prefix="jukelet-native-tag-") as temporary:
        directory = Path(temporary)
        install_probe_component(directory)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        runtime = DispatcherRuntime(directory, port)

        def native(
            events: list[dict[str, Any]], *, captures: int | None = None, settled: bool = True
        ) -> dict[str, Any]:
            wait = 0.4 if captures is None else 0
            runtime.pipe.send({"type": "native_scan", "events": events, "wait": wait})
            result = cast(dict[str, Any], runtime.receive())
            if captures is not None:
                result["captures"] = runtime.scan_until([], captures=captures, settled=settled)
            return result

        try:
            payload = snapshot()
            exact_tag = "  Tag e\u0301 / 🦊  "
            payload["payload"]["mappings"].append(
                {
                    **payload["payload"]["mappings"][0],
                    "tag_id": exact_tag,
                }
            )
            payload["payload_checksum"] = checksum(payload["payload"])
            assert runtime.request("publish", snapshot=payload)["success"]
            assert runtime.request(
                "configure_dispatch", profiles={"default": "script.synthetic_dispatch"}
            )["success"]
            assert runtime.request("dispatch", action="reconcile", confirmed_stopped=True)[
                "success"
            ]
            assert runtime.request("dispatch", action="enable")["success"]
            event = {"tag_id": "SYNTHETIC_Å", "device_id": " Reader e\u0301 "}
            scanned = native([event], captures=1)
            assert scanned["events"] == [{**event, "name": None}]
            assert len(scanned["captures"]) == 1, runtime.request("status")
            assert scanned["captures"][0]["tag_id"] == event["tag_id"]
            assert scanned["captures"][0]["reader_id"] == event["device_id"]
            assert (
                runtime.request("status")["result"]["dispatcher"]["diagnostics"][-1]["execution"]
                == "finished"
            )
            print("PASS actual tag.async_scan_tag -> installed integration -> inert script")

            named = native([{**event, "name": "script.synthetic_other"}])
            assert named["events"][0]["name"] == "script.synthetic_other"
            assert len(named["captures"]) == 1  # Name is not part of routing/duplicate identity.
            assert (
                runtime.request("status")["result"]["dispatcher"]["diagnostics"][-1]["reason"]
                == "ignored_duplicate"
            )
            nullable = native([{"tag_id": event["tag_id"], "device_id": None}], captures=2)
            assert nullable["events"][0]["device_id"] is None
            assert len(nullable["captures"]) == 2
            assert nullable["captures"][-1]["reader_id"] == "absent"
            absent = native([{"tag_id": exact_tag}], captures=3)
            assert absent["events"] == [{"tag_id": exact_tag, "name": None, "device_id": None}]
            assert len(absent["captures"]) == 3
            assert absent["captures"][-1]["tag_id"] == exact_tag
            assert absent["captures"][-1]["reader_id"] == "absent"
            assert (
                absent["captures"][-1]["spotify_uri"]
                == payload["payload"]["mappings"][0]["spotify_uri"]
            )
            print(
                "PASS names ignored, nullable/missing reader omitted, exact Unicode IDs preserved"
            )

            with runtime.hold_captures():
                busy = native(
                    [
                        {**event, "device_id": "synthetic-busy"},
                        {"tag_id": exact_tag, "device_id": "synthetic-dropped"},
                        {"tag_id": "synthetic-unknown"},
                    ],
                    captures=4,
                    settled=False,
                )
                assert len(busy["captures"]) == 4
                status = runtime.request("status")["result"]["dispatcher"]
                assert status["busy"]
                assert any(row["reason"] == "ignored_busy" for row in status["diagnostics"])
            assert len(runtime.scan_until([], captures=4)) == 4
            assert not runtime.request("status")["result"]["dispatcher"]["busy"]
            assert runtime.request("dispatch", action="disable")["success"]
            assert len(native([{**event, "device_id": "synthetic-disabled"}])["captures"]) == 4
            assert runtime.request("dispatch", action="enable")["success"]
            malformed: list[dict[str, Any]] = [
                {**event, "name": 123},
                {**event, "tag_id": None},
                {**event, "device_id": ""},
                {**event, "device_id": True},
                {**event, "extra": "unknown"},
                {**event, "playback_profile_id": "other"},
                {**event, "spotify_uri": "spotify:playlist:" + "B" * 22},
                {**event, "target": "script.synthetic_other"},
            ]
            assert len(runtime.scan(malformed)) == 4
            assert all(
                row["reason"] == "rejected_event"
                for row in runtime.request("status")["result"]["dispatcher"]["diagnostics"][
                    -len(malformed) :
                ]
            )
            print(
                "PASS disabled, malformed/unknown/override no effects; busy drops without a queue"
            )

            assert runtime.request("dispatch", action="disable")["success"]
            assert runtime.request(
                "configure_dispatch",
                profiles={"default": "script.synthetic_dispatch"},
                timeout_seconds=0.01,
            )["success"]
            assert runtime.request("dispatch", action="enable")["success"]
            assert (
                len(native([{**event, "device_id": "synthetic-timeout"}], captures=5)["captures"])
                == 5
            )
            status = runtime.request("status")["result"]
            assert not status["dispatch_enabled"] and status["dispatcher"]["execution_uncertain"]
            result = status["dispatcher"]["diagnostics"][-1]
            assert (result["execution"], result["error"]) == ("unknown", "timeout")
            assert not runtime.request("dispatch", action="enable")["success"]
            assert len(native([{**event, "device_id": "synthetic-no-replay"}])["captures"]) == 5
            print("PASS native scans retain timeout uncertainty and never replay")
        finally:
            runtime.close()


if __name__ == "__main__":
    main()
