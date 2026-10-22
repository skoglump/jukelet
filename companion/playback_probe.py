"""Opt-in actual HA script-engine probe using only inert, generated fixtures.

No target, credential or existing configuration-directory arguments are accepted.
"""

import asyncio
import logging
import sys
import tempfile
from importlib.metadata import version
from typing import Any

from companion.tests.test_playback import request

from .custom_components.jukelet_bridge.playback import PlaybackAdapter
from .custom_components.jukelet_bridge.protocol import ProtocolError


async def probe(directory: str) -> None:
    from homeassistant import bootstrap, config_entries, loader
    from homeassistant.core import HomeAssistant, ServiceCall
    from homeassistant.core_config import async_process_ha_core_config
    from homeassistant.setup import async_setup_component

    from .custom_components.jukelet_bridge.ha_playback import HAScriptTransport

    assert version("homeassistant") == "2026.10.2"
    hass = HomeAssistant(directory)
    hass.config.skip_pip = True
    loader.async_setup(hass)
    captures: list[dict[str, Any]] = []
    started = asyncio.Event()

    async def capture(call: ServiceCall) -> None:
        captures.append(dict(call.data["request"]))
        started.set()

    hass.services.async_register("synthetic_probe", "capture", capture)
    # This sole fixture service only appends memory; it performs no external I/O.
    capture_step = {
        "action": "synthetic_probe.capture",
        "data": {
            "request": "{{ dict(tag_id=tag_id, media_type=media_type, "
            "spotify_uri=spotify_uri, enabled=enabled, shuffle=shuffle, "
            "playback_profile_id=playback_profile_id, snapshot_revision=snapshot_revision, "
            "correlation_id=correlation_id, "
            "**({'reader_id': reader_id} if reader_id is defined else {})) }}"
        },
    }
    finished = [
        {
            "variables": {
                "result": {
                    "contract_version": 1,
                    "correlation_id": "{{ correlation_id }}",
                    "snapshot_revision": "{{ snapshot_revision }}",
                    "execution": "finished",
                    "error": None,
                }
            }
        },
        {"stop": "Synthetic completion", "response_variable": "result"},
    ]
    config: dict[str, Any] = {
        "homeassistant": {
            "name": "Synthetic script probe",
            "latitude": 0,
            "longitude": 0,
            "elevation": 0,
            "unit_system": "metric",
            "time_zone": "UTC",
        },
        "script": {
            "synthetic_finished": {"sequence": [capture_step, *finished]},
            "synthetic_absent": {"sequence": [capture_step]},
            "synthetic_failed": {
                "sequence": [capture_step, {"stop": "Synthetic failure", "error": True}]
            },
            "synthetic_reported_failure": {
                "sequence": [
                    capture_step,
                    {
                        "variables": {
                            "result": {
                                "contract_version": 1,
                                "correlation_id": "{{ correlation_id }}",
                                "snapshot_revision": "{{ snapshot_revision }}",
                                "execution": "failed",
                                "error": "readiness_failed",
                            }
                        }
                    },
                    {"stop": "Synthetic reported failure", "response_variable": "result"},
                ]
            },
            "synthetic_nested_missing": {
                "sequence": [capture_step, {"action": "synthetic_probe.missing"}]
            },
            "synthetic_slow": {
                "mode": "single",
                "max_exceeded": "silent",
                "sequence": [
                    capture_step,
                    {"delay": {"milliseconds": 200}},
                    *finished,
                ],
            },
        },
    }
    hass.config_entries = config_entries.ConfigEntries(hass, config)
    try:
        assert await bootstrap.async_load_base_functionality(hass)
        await async_process_ha_core_config(hass, config["homeassistant"])
        assert await async_setup_component(hass, "script", config)
        forbidden = {
            "automation",
            "media_player",
            "spotifyplus",
            "tag",
            "default_config",
            "zeroconf",
            "ssdp",
            "bluetooth",
            "dhcp",
            "http",
            "websocket_api",
            "analytics",
        }
        assert not hass.config.components.intersection(forbidden)
        await hass.async_start()
        transport = HAScriptTransport(hass)

        def adapter(script: str, timeout: float = 2.0) -> PlaybackAdapter:
            return PlaybackAdapter(transport, {"default": "script." + script}, timeout=timeout)

        for kind, shuffle in (("album", False), ("playlist", True)):
            item = request(
                media_type=kind, spotify_uri=f"spotify:{kind}:" + "B" * 22, shuffle=shuffle
            )
            result = await adapter("synthetic_finished").execute(item)
            assert captures[-1] == item
            assert (result.invocation, result.execution, result.error) == (
                "accepted",
                "finished",
                None,
            ), result
            assert result.playback_verification == "unavailable"
        without_reader = request()
        del without_reader["reader_id"]
        assert (await adapter("synthetic_finished").execute(without_reader)).execution == "finished"
        assert captures[-1] == without_reader
        print(
            "PASS actual HA album/playlist scripts: exact IDs, preferences/context "
            "and correlated completion"
        )

        before = len(captures)
        missing = await adapter("synthetic_not_installed").execute(request())
        assert (missing.invocation, missing.execution, missing.error) == (
            "rejected",
            "not_started",
            "script_unavailable",
        ), missing
        unconfigured = await PlaybackAdapter(transport, {}).execute(request())
        assert unconfigured.error == "profile_unconfigured"
        disabled = await adapter("synthetic_finished").execute(request(enabled=False))
        assert disabled.error == "disabled"
        for item in (
            request(playback_profile_id="script.synthetic_finished"),
            request(media_type="track"),
        ):
            try:
                await adapter("synthetic_finished").execute(item)
            except ProtocolError:
                pass
            else:
                raise AssertionError("Invalid request admitted")
        assert len(captures) == before
        print("PASS missing, denied and disabled requests produce no script body effects")

        absent = await adapter("synthetic_absent").execute(request())
        assert (absent.invocation, absent.execution, absent.error) == (
            "accepted",
            "unknown",
            "completion_unavailable",
        ), absent
        assert absent.playback_verification == "unavailable"
        stopped = await adapter("synthetic_failed").execute(request())
        assert (stopped.invocation, stopped.execution, stopped.error) == (
            "accepted",
            "unknown",
            "completion_unavailable",
        ), stopped
        reported = await adapter("synthetic_reported_failure").execute(request())
        assert (reported.invocation, reported.execution, reported.error) == (
            "accepted",
            "failed",
            "readiness_failed",
        ), reported
        for name in ("synthetic_nested_missing",):
            before = len(captures)
            failed = await adapter(name).execute(request())
            assert (failed.invocation, failed.execution, failed.error) == (
                "unknown",
                "failed",
                "script_failed",
            ), failed
            assert len(captures) == before + 1
        print(
            "PASS absent/stop-error telemetry stays unknown; "
            "correlated failure and nested errors are bounded"
        )

        started.clear()
        before = len(captures)
        first = asyncio.create_task(
            adapter("synthetic_slow").execute(request(correlation_id="synthetic-first"))
        )
        await asyncio.wait_for(started.wait(), 2)
        second = await adapter("synthetic_slow").execute(request(correlation_id="synthetic-second"))
        assert (second.invocation, second.execution, second.error) == (
            "accepted",
            "unknown",
            "completion_unavailable",
        ), second
        assert (await first).execution == "finished"
        assert len(captures) == before + 1
        print("PASS actual single-mode refusal cannot be mistaken for execution completion")

        before = len(captures)
        timed_out = await adapter("synthetic_slow", timeout=0.01).execute(request())
        assert (timed_out.invocation, timed_out.execution, timed_out.error) == (
            "unknown",
            "unknown",
            "timeout",
        ), timed_out
        await asyncio.sleep(0.25)
        assert len(captures) == before + 1
        started.clear()
        before = len(captures)
        task = asyncio.create_task(adapter("synthetic_slow").execute(request()))
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        else:
            raise AssertionError("Cancellation did not propagate")
        await asyncio.sleep(0.25)
        assert len(captures) == before + 1
        assert not hass.config.components.intersection(forbidden)
        print("PASS timeout and cancellation preserve uncertainty and never replay an invocation")
    finally:
        await hass.async_stop()


def main() -> None:
    if len(sys.argv) != 1:
        raise SystemExit("This synthetic probe accepts no arguments.")
    logging.basicConfig(level=logging.CRITICAL)
    with tempfile.TemporaryDirectory(prefix="jukelet-synthetic-playback-") as directory:
        asyncio.run(probe(directory))


if __name__ == "__main__":
    main()
