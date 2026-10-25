"""Execute the synthetic preservation worksheet with inert real HA scripts only."""

import asyncio
import json
import logging
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import yaml

from companion.custom_components.jukelet_bridge.playback import PlaybackAdapter
from companion.probe_support import probe_ha_version
from companion.tests.test_playback import request


async def probe(directory: str) -> None:
    from homeassistant import bootstrap, config_entries, loader
    from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
    from homeassistant.core_config import async_process_ha_core_config
    from homeassistant.exceptions import HomeAssistantError
    from homeassistant.setup import async_setup_component

    from .custom_components.jukelet_bridge.ha_playback import HAScriptTransport

    hass = HomeAssistant(directory)
    hass.config.skip_pip = True
    loader.async_setup(hass)
    captures: list[tuple[float, dict[str, Any]]] = []
    lookup_count: int | None = 3
    refreshes = 0
    allow_device_ready = True

    async def step(call: ServiceCall) -> None:
        nonlocal refreshes
        captures.append((time.monotonic(), json.loads(json.dumps(dict(call.data)))))
        if call.data["step"] == "refresh":
            refreshes += 1
            if allow_device_ready and refreshes == 2:
                hass.states.async_set("sensor.synthetic_device_ready", "on")

    async def playlist(call: ServiceCall) -> dict[str, Any]:
        captures.append((time.monotonic(), {"step": "lookup", **dict(call.data)}))
        if lookup_count is None:
            raise HomeAssistantError("Synthetic unavailable metadata")
        return {"tracks": {"total": lookup_count}, "name": "Synthetic", "uri": call.data["uri"]}

    hass.services.async_register("synthetic_probe", "step", step)
    hass.services.async_register(
        "synthetic_probe", "playlist", playlist, supports_response=SupportsResponse.ONLY
    )
    config: dict[str, Any] = {
        "homeassistant": {
            "name": "Synthetic preservation",
            "latitude": 0,
            "longitude": 0,
            "elevation": 0,
            "unit_system": "metric",
            "time_zone": "UTC",
        },
        "script": yaml.safe_load(
            (Path(__file__).parent / "examples/synthetic_preservation.yaml").read_text()
        ),
    }
    hass.config_entries = config_entries.ConfigEntries(hass, config)
    try:
        assert await bootstrap.async_load_base_functionality(hass)
        await async_process_ha_core_config(hass, config["homeassistant"])
        assert await async_setup_component(hass, "script", config)
        assert not hass.config.components.intersection(
            {
                "automation",
                "tag",
                "remote",
                "media_player",
                "spotifyplus",
                "default_config",
                "zeroconf",
                "ssdp",
                "bluetooth",
                "dhcp",
                "discovery",
                "http",
                "websocket_api",
            }
        )
        await hass.async_start()
        for name in ("music_ready", "account_ready", "device_ready", "needs_music", "needs_volume"):
            hass.states.async_set("sensor.synthetic_" + name, "on")
        adapter = PlaybackAdapter(
            HAScriptTransport(hass), {"default": "script.synthetic_preservation"}, timeout=45
        )
        assert hass.states.get("script.synthetic_preservation").attributes["mode"] == "single"
        helper = hass.states.get("script.synthetic_preparation")
        assert helper.attributes["mode"] == "queued" and helper.attributes["max"] == 3

        for kind, count in (("playlist", 3), ("playlist", 0), ("playlist", None), ("album", 3)):
            lookup_count = count
            captures.clear()
            item = request(
                media_type=kind,
                spotify_uri=f"spotify:{kind}:" + "A" * 22,
                shuffle=kind == "playlist",
                correlation_id=f"synthetic-{kind}-{count}",
            )
            if kind == "album":
                hass.states.async_set("sensor.synthetic_needs_music", "off")
                hass.states.async_set("sensor.synthetic_needs_volume", "off")
            elif count == 3:
                hass.states.async_set("sensor.synthetic_device_ready", "off")
            result = await adapter.execute(item)
            assert result.execution == "finished" and result.error is None, result
            assert result.correlation_id == item["correlation_id"]
            assert result.snapshot_revision == item["snapshot_revision"]
            assert result.playback_verification == "unavailable"
            steps = [data["step"] for _, data in captures]
            transfer = next(data for _, data in captures if data["step"] == "transfer")
            assert transfer["play"] is False and transfer["force_activate"] is False
            context_index = steps.index("context")
            context_time, context = captures[context_index]
            transfer_time = captures[steps.index("transfer")][0]
            assert context_time - transfer_time >= 1.9
            assert context["uri"] == item["spotify_uri"] and context["position"] == 0
            if kind == "playlist":
                expected = ["harmony_music", "volume", "preparation"]
                if count == 3:
                    expected += ["activate", "refresh", "activate", "refresh"]
                assert steps == expected + ["transfer", "lookup", "context", "shuffle"], steps
                assert (
                    captures[steps.index("preparation")][0] - captures[steps.index("volume")][0]
                    >= 0.9
                )
                lookup = captures[steps.index("lookup")][1]
                assert lookup["fields"] == "tracks(total),name,uri"
                assert context["synthetic_count"] == (50 if count is None else count)
                assert 0 <= context["offset"] < max(50 if count is None else count, 1)
                shuffle_time, shuffle = captures[-1]
                assert shuffle["state"] is True and shuffle_time - context_time >= 0.45
                assert time.monotonic() - shuffle_time >= 4.2  # .25 then postbranch4
            else:
                assert steps == ["preparation", "transfer", "context", "shuffle"], steps
                assert captures[-1][1]["state"] is False
                assert context["shuffle"] is False
                assert captures[-1][0] - context_time >= 4.9  # branch1 + postbranch4
            print(f"PASS synthetic {kind} count={count}: order/timing and correlated completion")

        # Exhaustion is only the known bounded loop, not an invented household
        # post-exhaustion policy. Call the inert helper directly to inspect its bound.
        captures.clear()
        allow_device_ready = False
        hass.states.async_set("sensor.synthetic_device_ready", "off")
        await hass.services.async_call("script", "synthetic_preparation", {}, blocking=True)
        assert [data["step"] for _, data in captures] == ["preparation"] + [
            "activate",
            "refresh",
        ] * 12
        hass.states.async_set("sensor.synthetic_device_ready", "on")
        print("PASS synthetic queued/max3 helper bounds activation/refresh to12 iterations")

        captures.clear()
        conflict = await adapter.execute(request(shuffle=True))
        assert conflict.execution != "finished" and not captures
        print("PASS preference conflict: no fixture service effects or assignment edits")

        # A real readiness wait fails before volume/account/context; it cannot report finished.
        hass.states.async_set("sensor.synthetic_needs_music", "on")
        hass.states.async_set("sensor.synthetic_music_ready", "off")
        started = time.monotonic()
        failure = await adapter.execute(request())
        assert failure.execution != "finished"
        assert 24.9 <= time.monotonic() - started < 40
        assert [data["step"] for _, data in captures] == ["harmony_music"]
        print("PASS actual25s readiness timeout stops before preparation/transfer/context")
    finally:
        await hass.async_stop()


def main() -> None:
    assert len(sys.argv) == 1, "No external target or configuration inputs allowed"
    probe_ha_version()
    logging.basicConfig(level=logging.ERROR)
    with tempfile.TemporaryDirectory(prefix="jukelet-ha-preservation-") as directory:
        asyncio.run(probe(directory))


if __name__ == "__main__":
    main()
