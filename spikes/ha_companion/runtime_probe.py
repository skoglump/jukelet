"""Opt-in actual HA lifecycle/Store/WebSocket proof, with only generated local data.

Run as a module in the dedicated pinned environment. No target or credential inputs.
"""

import asyncio
import json
import logging
import multiprocessing
import shutil
import socket
import tempfile
import threading
from importlib.metadata import version
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any
from unittest.mock import patch

from .custom_components.jukelet_bridge.protocol import PUBLISHER
from .tests.test_bridge import snapshot


def child(config_dir: str, port: int, pipe: Connection) -> None:
    logging.basicConfig(level=logging.ERROR)
    try:
        asyncio.run(serve(config_dir, port, pipe))
    except BaseException as exc:
        # Exceptions are synthetic only; never send tokens or complete HA config.
        pipe.send({"failure": type(exc).__name__, "detail": str(exc)})
        raise


async def serve(config_dir: str, port: int, pipe: Connection) -> None:
    import aiohttp
    from homeassistant import bootstrap, config_entries, loader
    from homeassistant.core import HomeAssistant
    from homeassistant.core_config import async_process_ha_core_config
    from homeassistant.helpers import storage
    from homeassistant.setup import async_setup_component
    from homeassistant.util.file import WriteError

    hass = HomeAssistant(config_dir)
    hass.config.skip_pip = True
    loader.async_setup(hass)
    config = {
        "homeassistant": {
            "name": "Synthetic Jukelet spike",
            "latitude": 0,
            "longitude": 0,
            "elevation": 0,
            "unit_system": "metric",
            "time_zone": "UTC",
            "auth_mfa_modules": [],
        },
        "http": {"server_host": "127.0.0.1", "server_port": port},
        "jukelet_bridge": {"publisher_id": PUBLISHER},
    }
    hass.config_entries = config_entries.ConfigEntries(hass, config)
    assert await bootstrap.async_load_base_functionality(hass)
    await async_process_ha_core_config(hass, config["homeassistant"])
    assert await async_setup_component(hass, "jukelet_bridge", config)
    assert "jukelet_bridge" in hass.config.components
    assert not hass.config.components.intersection(
        {
            "default_config",
            "automation",
            "script",
            "media_player",
            "spotifyplus",
            "tag",
            "zeroconf",
            "ssdp",
            "bluetooth",
            "dhcp",
            "analytics",
        }
    )
    await hass.async_start()
    user = await hass.auth.async_create_system_user("Synthetic probe", group_ids=["system-admin"])
    refresh = await hass.auth.async_create_refresh_token(user)
    token = hass.auth.async_create_access_token(refresh)
    async with aiohttp.ClientSession() as session:
        reader = await hass.auth.async_create_system_user(
            "Synthetic non-admin", group_ids=["system-read-only"]
        )
        reader_refresh = await hass.auth.async_create_refresh_token(reader)
        reader_token = hass.auth.async_create_access_token(reader_refresh)
        async with session.ws_connect(f"http://127.0.0.1:{port}/api/websocket") as denied:
            await denied.receive_json()
            await denied.send_json({"type": "auth", "access_token": reader_token})
            assert (await denied.receive_json())["type"] == "auth_ok"
            for request_id, kind in enumerate(("status", "publish"), start=1):
                request = {"id": request_id, "type": "jukelet_bridge/" + kind}
                if kind == "publish":
                    request["snapshot"] = snapshot()
                await denied.send_json(request)
                assert (await denied.receive_json())["error"]["code"] == "unauthorized"
        async with session.ws_connect(f"http://127.0.0.1:{port}/api/websocket") as ws:
            assert (await ws.receive_json())["type"] == "auth_required"
            await ws.send_json({"type": "auth", "access_token": token})
            assert (await ws.receive_json())["type"] == "auth_ok"
            pipe.send({"ready": True, "version": version("homeassistant")})
            index = 0
            while True:
                command = await asyncio.to_thread(pipe.recv)
                if command["type"] == "stop":
                    break
                if command["type"] == "corrupt_record":
                    # Supported companion-owned Store, invalid schema fixture; never raw file edits.
                    from custom_components.jukelet_bridge.ha_store import HAStore

                    await HAStore(hass).save({"invalid": "synthetic schema corruption"})
                    pipe.send({"corrupt_record_saved": True})
                    continue
                fault = command.pop("fault", None)
                entered = threading.Event()
                release = threading.Event()
                original = storage.write_utf8_file_atomic

                def faulting_write(
                    filename: str,
                    data: Any,
                    private: bool = False,
                    *,
                    original: Any = original,
                    fault: str | None = fault,
                    entered: threading.Event = entered,
                    release: threading.Event = release,
                    **kwargs: Any,
                ) -> None:
                    if Path(filename).name != "jukelet_bridge.snapshot":
                        original(filename, data, private, **kwargs)
                        return
                    if fault == "write_error":
                        raise WriteError("synthetic injected write failure")
                    if fault == "before_write":
                        entered.set()
                        release.wait(30)
                    original(filename, data, private, **kwargs)
                    if fault == "after_write":
                        entered.set()
                        release.wait(30)

                index += 1
                with patch.object(storage, "write_utf8_file_atomic", faulting_write):
                    await ws.send_json({"id": index, **command})
                    if fault in {"before_write", "after_write"}:
                        assert await asyncio.to_thread(entered.wait, 10)
                        pipe.send({"paused": fault, "acknowledged": False})
                        await asyncio.to_thread(release.wait, 30)
                    response = await asyncio.wait_for(ws.receive_json(), 10)
                pipe.send(response)

    await hass.async_stop()
    pipe.send({"stopped": True})


class Runtime:
    def __init__(self, directory: Path, port: int) -> None:
        context = multiprocessing.get_context("spawn")
        self.pipe, remote = context.Pipe()
        self.process = context.Process(target=child, args=(str(directory), port, remote))
        self.process.start()
        try:
            assert self.receive().get("ready") is True
        except BaseException:
            self.close(crash=True)
            raise

    def receive(self) -> dict[str, Any]:
        if not self.pipe.poll(60):
            self.process.kill()
            self.process.join(10)
            raise TimeoutError("isolated runtime did not respond within 60 seconds")
        response: dict[str, Any] = self.pipe.recv()
        assert "failure" not in response, response
        return response

    def request(self, kind: str, **fields: Any) -> dict[str, Any]:
        self.pipe.send({"type": "jukelet_bridge/" + kind, **fields})
        return self.receive()

    def close(self, *, crash: bool = False) -> None:
        if not self.process.is_alive():
            return
        if crash:
            self.process.kill()
        else:
            self.pipe.send({"type": "stop"})
            assert self.receive() == {"stopped": True}
        self.process.join(10)
        assert not self.process.is_alive()
        self.pipe.close()


def main() -> None:
    assert version("homeassistant") == "2026.10.2", "Use the pinned isolated HA environment"
    with tempfile.TemporaryDirectory(prefix="jukelet-ha-spike-") as temporary:
        directory = Path(temporary)
        shutil.copytree(
            Path(__file__).parent / "custom_components", directory / "custom_components"
        )
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        runtime = Runtime(directory, port)
        try:
            initial = runtime.request("status")["result"]
            assert initial["persistence"] == "empty" and not initial["dispatch_enabled"]
            published = runtime.request("publish", snapshot=snapshot())["result"]
            assert published["active_revision"] == 1 and not published["dispatch_enabled"]
            assert runtime.request("status")["result"] == published
            runtime.close()
            runtime = Runtime(directory, port)
            assert runtime.request("status")["result"] == published
            print("PASS graceful actual HA process restart: exact revision/checksum recovered")
            second = runtime.request("publish", snapshot=snapshot(2, 1))["result"]
            runtime.close(crash=True)
            runtime = Runtime(directory, port)
            assert runtime.request("status")["result"] == second
            print("PASS SIGKILL after acknowledged publication: exact revision/checksum recovered")
            retry = runtime.request("publish", snapshot=snapshot(2, 1))["result"]
            assert retry == second and not retry["dispatch_enabled"]
            conflict = runtime.request("publish", snapshot=snapshot(3, 1))
            assert conflict["error"]["code"] == "base_conflict"
            assert runtime.request("status")["result"] == second
            print("PASS real WebSocket publish/status/retry/conflict; dispatch disabled")
            failure = runtime.request("publish", snapshot=snapshot(3, 2), fault="write_error")
            assert failure["error"]["code"] == "persistence_failed"
            assert runtime.request("status")["result"]["active_revision"] == 2
            print("PASS injected HA writer error: bridge denied success and retained old revision")
            paused = runtime.request("publish", snapshot=snapshot(3, 2), fault="before_write")
            assert paused == {"paused": "before_write", "acknowledged": False}
            runtime.close(crash=True)
            runtime = Runtime(directory, port)
            assert runtime.request("status")["result"] == second
            print("PASS SIGKILL before atomic write: previous revision recovered")
            paused = runtime.request("publish", snapshot=snapshot(3, 2), fault="after_write")
            assert paused == {"paused": "after_write", "acknowledged": False}
            runtime.close(crash=True)
            runtime = Runtime(directory, port)
            third = runtime.request("status")["result"]
            assert third["active_revision"] == 3 and not third["dispatch_enabled"]
            assert runtime.request("publish", snapshot=snapshot(3, 2))["result"] == third
            print(
                "PASS SIGKILL after atomic write before ACK: readback/retry reconciles new revision"
            )
            runtime.pipe.send({"type": "corrupt_record"})
            assert runtime.receive() == {"corrupt_record_saved": True}
            runtime.close()
            runtime = Runtime(directory, port)
            degraded = runtime.request("status")["result"]
            assert degraded["persistence"] == "degraded" and degraded["active_revision"] is None
            assert not degraded["dispatch_enabled"]
            assert (
                runtime.request("publish", snapshot=snapshot())["error"]["code"]
                == "recovery_required"
            )
            print(
                "PASS supported Store invalid-schema fixture: degraded startup, publication fenced"
            )
            print(
                json.dumps(
                    {
                        "ha_version": version("homeassistant"),
                        "synthetic": True,
                        "recovered_revision_before_corruption": third["active_revision"],
                        "checksum": third["active_checksum"],
                    },
                    sort_keys=True,
                )
            )
        finally:
            runtime.close()


if __name__ == "__main__":
    main()
