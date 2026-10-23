"""Opt-in isolated HA processes, inert script execution and actual process restart.

No existing target, credential, configuration directory or management app is used.
"""

import asyncio
import copy
import logging
import multiprocessing
import shutil
import socket
import sys
import tempfile
from importlib.metadata import version
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

from companion.runtime_probe import Runtime
from companion.tests.fixtures import snapshot

from .custom_components.jukelet_bridge.protocol import PUBLISHER


def child(directory: str, port: int, pipe: Connection) -> None:
    logging.basicConfig(level=logging.ERROR)
    try:
        asyncio.run(serve(directory, port, pipe))
    except BaseException as exc:
        pipe.send({"failure": type(exc).__name__})
        raise


async def serve(directory: str, port: int, pipe: Connection) -> None:
    import aiohttp
    from homeassistant import bootstrap, config_entries, loader
    from homeassistant.core import HomeAssistant, ServiceCall
    from homeassistant.core_config import async_process_ha_core_config
    from homeassistant.setup import async_setup_component

    hass = HomeAssistant(directory)
    hass.config.skip_pip = True
    loader.async_setup(hass)
    captures: list[dict[str, Any]] = []

    async def capture(call: ServiceCall) -> None:
        captures.append(dict(call.data["request"]))

    hass.services.async_register("synthetic_probe", "capture", capture)
    config: dict[str, Any] = {
        "homeassistant": {
            "name": "Synthetic dispatcher",
            "latitude": 0,
            "longitude": 0,
            "elevation": 0,
            "unit_system": "metric",
            "time_zone": "UTC",
            "auth_mfa_modules": [],
        },
        "http": {"server_host": "127.0.0.1", "server_port": port},
        "script": {
            "synthetic_dispatch": {
                "mode": "single",
                "max_exceeded": "silent",
                "sequence": [
                    {
                        "action": "synthetic_probe.capture",
                        "data": {
                            "request": "{{ dict(tag_id=tag_id, "
                            "reader_id=reader_id|default('absent'), "
                            "snapshot_revision=snapshot_revision, correlation_id=correlation_id, "
                            "spotify_uri=spotify_uri, shuffle=shuffle) }}"
                        },
                    },
                    {"delay": {"milliseconds": 200}},
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
                ],
            }
        },
    }
    slow = copy.deepcopy(config["script"]["synthetic_dispatch"])
    slow["sequence"][1] = {"delay": {"seconds": 31}}
    config["script"]["synthetic_slow"] = slow
    hass.config_entries = config_entries.ConfigEntries(hass, config)
    assert await bootstrap.async_load_base_functionality(hass)
    await async_process_ha_core_config(hass, config["homeassistant"])
    assert await async_setup_component(hass, "script", config)
    assert await async_setup_component(hass, "jukelet_bridge", config)
    assert not hass.config.components.intersection(
        {
            "automation",
            "tag",
            "media_player",
            "remote",
            "spotifyplus",
            "default_config",
            "zeroconf",
            "ssdp",
            "bluetooth",
            "dhcp",
            "discovery",
        }
    )
    await hass.async_start()
    entries = hass.config_entries.async_entries("jukelet_bridge")
    if not entries:
        flow = await hass.config_entries.flow.async_init(
            "jukelet_bridge", context={"source": "user"}
        )
        result = await hass.config_entries.flow.async_configure(
            flow["flow_id"], {"publisher_id": PUBLISHER, "confirm_pairing": True}
        )
        assert result["type"] == "create_entry"
        await hass.async_block_till_done()
    elif entries[0].state is not config_entries.ConfigEntryState.LOADED:
        assert await hass.config_entries.async_setup(entries[0].entry_id)
    user = await hass.auth.async_create_system_user("Synthetic admin", group_ids=["system-admin"])
    refresh = await hass.auth.async_create_refresh_token(user)
    token = hass.auth.async_create_access_token(refresh)

    async def reconcile_reload_race() -> None:
        from .custom_components.jukelet_bridge import DISPATCHER, FENCE_KEY

        async def check_race(scenario: str) -> None:
            dispatcher = hass.data[DISPATCHER]
            entered, release = asyncio.Event(), asyncio.Event()
            store_type = type(dispatcher.fence)
            original_save = store_type.save

            async def delayed_save(store: Any, value: dict[str, Any]) -> None:
                if store.key == FENCE_KEY and not value["uncertain"] and not entered.is_set():
                    entered.set()
                    await release.wait()
                await original_save(store, value)

            with patch.object(store_type, "save", delayed_save):
                if scenario == "cancelled_execution_clear":
                    await dispatcher.control("enable")
                    hass.bus.async_fire("tag_scanned", {"tag_id": "SYNTHETIC_Å"})
                    await asyncio.wait_for(entered.wait(), 5)
                    waiter = dispatcher.task
                else:
                    waiter = asyncio.create_task(dispatcher.control("reconcile", True))
                    await asyncio.wait_for(entered.wait(), 5)
                if scenario.startswith("cancelled"):
                    waiter.cancel()
                    await asyncio.gather(waiter, return_exceptions=True)
                entry = hass.config_entries.async_entries("jukelet_bridge")[0]
                reload = asyncio.create_task(hass.config_entries.async_reload(entry.entry_id))
                try:
                    await asyncio.sleep(0.05)
                    assert not reload.done(), "Actual HA reload overtook the pending fence write"
                    assert hass.data[DISPATCHER] is dispatcher
                finally:
                    release.set()
                    await asyncio.gather(waiter, return_exceptions=True)
                    assert await reload
            replacement = hass.data[DISPATCHER]
            assert replacement is not dispatcher
            assert not replacement.enabled and not replacement.uncertain
            assert await replacement.fence.load() == {"version": 1, "uncertain": False}

        for scenario in ("reconcile", "cancelled_reconcile", "cancelled_execution_clear"):
            await check_race(scenario)

    async with aiohttp.ClientSession() as session:
        reader = await hass.auth.async_create_system_user(
            "Synthetic reader", group_ids=["system-read-only"]
        )
        reader_refresh = await hass.auth.async_create_refresh_token(reader)
        reader_token = hass.auth.async_create_access_token(reader_refresh)
        async with session.ws_connect(f"http://127.0.0.1:{port}/api/websocket") as denied:
            await denied.receive_json()
            await denied.send_json({"type": "auth", "access_token": reader_token})
            assert (await denied.receive_json())["type"] == "auth_ok"
            for index, request in enumerate(
                (
                    {"type": "jukelet_bridge/dispatch", "action": "enable"},
                    {"type": "jukelet_bridge/dispatch", "action": "disable"},
                    {
                        "type": "jukelet_bridge/dispatch",
                        "action": "reconcile",
                        "confirmed_stopped": True,
                    },
                    {"type": "jukelet_bridge/configure_dispatch", "profiles": {}},
                    {"type": "jukelet_bridge/dispatch_config"},
                ),
                1,
            ):
                await denied.send_json({"id": index, **cast(dict[str, Any], request)})
                assert (await denied.receive_json())["error"]["code"] == "unauthorized"
        async with session.ws_connect(f"http://127.0.0.1:{port}/api/websocket") as ws:
            await ws.receive_json()
            await ws.send_json({"type": "auth", "access_token": token})
            assert (await ws.receive_json())["type"] == "auth_ok"
            pipe.send({"ready": True})
            index = 0
            while True:
                command = await asyncio.to_thread(pipe.recv)
                if command["type"] == "stop":
                    break
                if command["type"] == "scan":
                    for event in command["events"]:
                        hass.bus.async_fire("tag_scanned", event)
                    await asyncio.sleep(command.get("wait", 0.4))
                    pipe.send({"captures": captures})
                elif command["type"] == "reconcile_reload_race":
                    await reconcile_reload_race()
                    pipe.send({"drained": True})
                elif command["type"] == "reload":
                    entry = hass.config_entries.async_entries("jukelet_bridge")[0]
                    assert await hass.config_entries.async_reload(entry.entry_id)
                    pipe.send({"reloaded": True})
                elif command["type"] == "invalid_persisted_timeout":
                    # Supported config-entry API, on this generated fixture only.
                    entry = hass.config_entries.async_entries("jukelet_bridge")[0]
                    original = dict(entry.data)
                    for value in (None, True, "45", 0, -1, 301, float("inf"), float("nan")):
                        hass.config_entries.async_update_entry(
                            entry, data={**original, "playback_timeout": value}
                        )
                        assert not await hass.config_entries.async_reload(entry.entry_id)
                        assert "jukelet_dispatcher" not in hass.data
                        assert "jukelet_bridge" not in hass.data
                    hass.config_entries.async_update_entry(entry, data=original)
                    assert await hass.config_entries.async_reload(entry.entry_id)
                    pipe.send({"rejected": True})
                elif command["type"] == "nonfinite_timeout":
                    # HA rejects non-JSON numbers at transport level by closing
                    # that socket. Keep the primary observer connection intact.
                    for value in (float("inf"), float("nan")):
                        async with session.ws_connect(
                            f"http://127.0.0.1:{port}/api/websocket"
                        ) as malformed:
                            await malformed.receive_json()
                            await malformed.send_json({"type": "auth", "access_token": token})
                            assert (await malformed.receive_json())["type"] == "auth_ok"
                            await malformed.send_json(
                                {
                                    "id": 1,
                                    "type": "jukelet_bridge/configure_dispatch",
                                    "profiles": {},
                                    "timeout_seconds": value,
                                }
                            )
                            assert (await malformed.receive()).type == aiohttp.WSMsgType.CLOSE
                    pipe.send({"rejected": True})
                else:
                    index += 1
                    await ws.send_json({"id": index, **command})
                    pipe.send(await ws.receive_json())
    await hass.async_stop()
    pipe.send({"stopped": True})


class DispatcherRuntime(Runtime):
    def __init__(self, directory: Path, port: int) -> None:
        context = multiprocessing.get_context("spawn")
        self.pipe, remote = context.Pipe()
        self.process = context.Process(target=child, args=(str(directory), port, remote))
        self.process.start()
        try:
            self.ready = self.receive()
            assert self.ready.get("ready") is True
        except BaseException:
            self.close(crash=True)
            raise

    def scan(self, events: list[dict[str, Any]], wait: float = 0.4) -> list[dict[str, Any]]:
        self.pipe.send({"type": "scan", "events": events, "wait": wait})
        return self.receive()["captures"]  # type: ignore[no-any-return]


def main() -> None:
    assert len(sys.argv) == 1, "No external target or configuration inputs allowed"
    assert version("homeassistant") == "2026.10.2"
    with tempfile.TemporaryDirectory(prefix="jukelet-ha-dispatcher-") as temporary:
        directory = Path(temporary)
        shutil.copytree(
            Path(__file__).parent / "custom_components", directory / "custom_components"
        )
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        runtime = DispatcherRuntime(directory, port)
        event = {"tag_id": "SYNTHETIC_Å", "device_id": " Reader e\u0301 "}
        try:
            assert not runtime.request("publish", snapshot=snapshot())["result"]["dispatch_enabled"]
            assert runtime.scan([event]) == []
            configured = runtime.request(
                "configure_dispatch", profiles={"default": "script.synthetic_dispatch"}
            )
            assert not configured["result"]["dispatch_enabled"]
            assert not runtime.request("dispatch", action="enable")["success"]
            assert runtime.request("dispatch", action="reconcile", confirmed_stopped=True)[
                "success"
            ]
            assert not runtime.request("status")["result"]["dispatch_enabled"]
            assert runtime.request("dispatch", action="enable")["success"]
            assert runtime.request("status")["result"]["dispatch_enabled"]
            captures = runtime.scan([event, event, {"tag_id": "unknown"}])
            assert len(captures) == 1 and captures[0]["snapshot_revision"] == 1
            assert captures[0]["reader_id"] == event["device_id"]
            status = runtime.request("status")["result"]
            assert status["dispatcher"]["diagnostics"][-1]["execution"] == "finished"
            assert status["dispatcher"]["playback_verification"] == "unavailable"
            assert len(runtime.scan([event])) == 1
            print(
                "PASS app-absent actual tag event, inert script, "
                "exact context, single overflow and duplicate"
            )
            runtime.pipe.send({"type": "reload"})
            assert runtime.receive() == {"reloaded": True}
            assert not runtime.request("status")["result"]["dispatch_enabled"]
            runtime.close()
            runtime = DispatcherRuntime(directory, port)
            recovered = runtime.request("status")["result"]
            assert recovered["active_revision"] == 1 and recovered["persistence"] == "healthy"
            assert not recovered["dispatch_enabled"]
            assert runtime.scan([event]) == []
            assert runtime.request("dispatch", action="enable")["success"]
            assert len(runtime.scan([event])) == 1
            print(
                "PASS actual process restart: persisted snapshot/allowlist, "
                "disabled until explicit enable"
            )
            # A different exact reader admits an intentional attempt without expiry wait.
            assert len(runtime.scan([{**event, "device_id": "crash-reader"}], wait=0.02)) == 2
            assert runtime.request("status")["result"]["dispatcher"]["busy"]
            runtime.close(crash=True)
            runtime = DispatcherRuntime(directory, port)
            assert runtime.request("status")["result"]["dispatcher"]["execution_uncertain"]
            assert not runtime.request("dispatch", action="enable")["success"]
            assert runtime.scan([event]) == []
            assert runtime.request("dispatch", action="reconcile", confirmed_stopped=True)[
                "success"
            ]
            assert not runtime.request("status")["result"]["dispatch_enabled"]
            assert runtime.request("dispatch", action="enable")["success"]
            assert len(runtime.scan([event])) == 1
            assert runtime.request("dispatch", action="disable")["success"]
            assert not runtime.request("status")["result"]["dispatch_enabled"]
            print(
                "PASS crash during startup: durable uncertainty, no replay; "
                "admin reconciliation and state readback"
            )
            print(
                "PASS non-admin control denial; synthetic HA 2026.10.2 only, "
                "no independently verified playback"
            )
            runtime.pipe.send({"type": "reconcile_reload_race"})
            assert runtime.receive() == {"drained": True}
            assert not runtime.request("status")["result"]["dispatch_enabled"]
            print(
                "PASS actual HA reload drains delayed and cancelled control/execution fence writes"
            )
        finally:
            runtime.close()


if __name__ == "__main__":
    main()
