"""Opt-in actual HA lifecycle/Store/WebSocket proof, with only generated local data.

Run as a module in the dedicated pinned environment. No target or credential inputs.
"""

import asyncio
import hashlib
import json
import logging
import multiprocessing
import secrets
import shutil
import socket
import tempfile
import threading
from importlib.metadata import version
from multiprocessing.connection import Connection
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from companion.probe_support import probe_ha_version
from companion.tests.fixtures import snapshot

from .custom_components.jukelet_bridge.protocol import PUBLISHER


def child(config_dir: str, port: int, pipe: Connection) -> None:
    logging.basicConfig(level=logging.ERROR)
    try:
        from homeassistant.backup_restore import restore_backup

        # The same Core startup restore function consumes HA's own .HA_RESTORE instruction.
        restored = restore_backup(config_dir)
        asyncio.run(serve(config_dir, port, pipe, restored))
    except BaseException as exc:
        # Exceptions are synthetic only; never send tokens or complete HA config.
        pipe.send({"failure": type(exc).__name__, "detail": str(exc)})
        raise


async def serve(config_dir: str, port: int, pipe: Connection, restored: bool) -> None:
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
            "name": "Synthetic Jukelet companion",
            "latitude": 0,
            "longitude": 0,
            "elevation": 0,
            "unit_system": "metric",
            "time_zone": "UTC",
            "auth_mfa_modules": [],
        },
        "http": {"server_host": "127.0.0.1", "server_port": port},
    }
    hass.config_entries = config_entries.ConfigEntries(hass, config)
    assert await bootstrap.async_load_base_functionality(hass)
    await async_process_ha_core_config(hass, config["homeassistant"])
    assert await async_setup_component(hass, "jukelet_bridge", config)
    assert "jukelet_bridge" in hass.config.components
    assert await async_setup_component(hass, "homeassistant", config)
    assert await async_setup_component(hass, "backup", config)
    from homeassistant.components.homeassistant import async_set_stop_handler

    async_set_stop_handler(hass)
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
    # Exercise both public installation seams with independent bad-version inputs.
    # These hooks exist only in an owned probe process, never the shipped runtime.
    from custom_components import jukelet_bridge
    from homeassistant import const

    for unsupported in ("2026.10.4", "2026.11.0", "2026.10", "2026.10.3.dev0", None, True):
        with patch.object(const, "__version__", unsupported):
            rejected = await hass.config_entries.flow.async_init(
                "jukelet_bridge", context={"source": "user"}
            )
            assert rejected["type"] == "abort" and rejected["reason"] == "unsupported_version"
    for bad_entry_version in (2, None, True, "1"):
        assert not await jukelet_bridge.async_setup_entry(
            hass, SimpleNamespace(version=bad_entry_version)
        )
    entries = hass.config_entries.async_entries("jukelet_bridge")
    if restored:
        assert len(entries) == 1, "Full backup must restore the existing config entry"
    if not entries:
        result = await hass.config_entries.flow.async_init(
            "jukelet_bridge", context={"source": "user"}
        )
        assert result["type"] == "form", result
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {"publisher_id": PUBLISHER, "confirm_pairing": True}
        )
        assert result["type"] == "create_entry", result
        await hass.async_block_till_done()
    elif entries[0].state is not config_entries.ConfigEntryState.LOADED:
        assert await hass.config_entries.async_setup(entries[0].entry_id)
    entry = hass.config_entries.async_entries("jukelet_bridge")[0]
    assert "jukelet_bridge" in hass.data
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
            pipe.send(
                {
                    "ready": True,
                    "version": version("homeassistant"),
                    "restored": restored,
                    "entry_id": entry.entry_id,
                    "code_checksum": hashlib.sha256(
                        Path(
                            config_dir, "custom_components/jukelet_bridge/__init__.py"
                        ).read_bytes()
                    ).hexdigest(),
                }
            )
            index = 0
            while True:
                command = await asyncio.to_thread(pipe.recv)
                if command["type"] == "stop":
                    break
                if command["type"] == "app_connection":
                    # Generated only in this isolated child, sent over its private pipe.
                    # Never read HA credential stores or accept an external token/target.
                    pipe.send({"token": token})
                    continue
                if command["type"] == "delay_app_ack":
                    bridge = hass.data["jukelet_bridge"]
                    original_publish = bridge.publish

                    async def delayed_publish(
                        value: object,
                        *,
                        bridge: Any = bridge,
                        original_publish: Any = original_publish,
                    ) -> dict[str, Any]:
                        bridge.publish = original_publish
                        result = await original_publish(value)
                        await asyncio.sleep(12)
                        return result

                    bridge.publish = delayed_publish
                    pipe.send({"delayed_ack_installed": True})
                    continue
                if command["type"] == "corrupt_record":
                    # Supported companion-owned Store, invalid schema fixture; never raw file edits.
                    from custom_components.jukelet_bridge.ha_store import HAStore

                    invalid = snapshot()
                    invalid["schema_version"] = 2
                    await HAStore(hass).save(invalid)
                    pipe.send({"corrupt_record_saved": True})
                    continue
                if command["type"] == "reload":
                    assert await hass.config_entries.async_reload(entry.entry_id)
                    pipe.send({"reloaded": True})
                    continue
                if command["type"] == "remove_snapshot":
                    await storage.Store(hass, 1, "jukelet_bridge.snapshot").async_remove()
                    pipe.send({"removed": True})
                    continue
                if command["type"] == "recover":
                    flow = await hass.config_entries.options.async_init(entry.entry_id)
                    assert flow["type"] == "menu", flow
                    flow = await hass.config_entries.options.async_configure(
                        flow["flow_id"], {"next_step_id": "recovery"}
                    )
                    assert flow["step_id"] == "recovery", flow
                    flow = await hass.config_entries.options.async_configure(
                        flow["flow_id"], {"snapshot_json": json.dumps(command["snapshot"])}
                    )
                    assert flow["step_id"] == "confirm", flow
                    flow = await hass.config_entries.options.async_configure(
                        flow["flow_id"], {"confirm_recovery": True}
                    )
                    pipe.send({"flow_type": flow["type"]})
                    continue
                if command["type"] == "quarantine_snapshot":
                    from homeassistant.exceptions import HomeAssistantError

                    original_load = storage.json_util.load_json

                    def broken_load(
                        path: Any, *args: Any, original_load: Any = original_load, **kwargs: Any
                    ) -> Any:
                        if Path(path).name == "jukelet_bridge.snapshot":
                            raise HomeAssistantError(
                                "synthetic malformed JSON"
                            ) from json.JSONDecodeError("synthetic", "{", 1)
                        return original_load(path, *args, **kwargs)

                    with patch.object(storage.json_util, "load_json", broken_load):
                        assert await hass.config_entries.async_reload(entry.entry_id)
                    pipe.send({"quarantined": True})
                    continue
                if command["type"] == "corrupt_history":
                    await storage.Store(
                        hass, 1, "jukelet_bridge.history", atomic_writes=True
                    ).async_save({"invalid": True})
                    pipe.send({"history_corrupted": True})
                    continue
                if command["type"] == "remove_all_stores":
                    for key in ("jukelet_bridge.history", "jukelet_bridge.snapshot"):
                        await storage.Store(hass, 1, key).async_remove()
                    pipe.send({"stores_removed": True})
                    continue
                if command["type"] == "concurrent":
                    for candidate in (snapshot(10, 9), snapshot(11, 9)):
                        index += 1
                        await ws.send_json(
                            {"id": index, "type": "jukelet_bridge/publish", "snapshot": candidate}
                        )
                    results = [await ws.receive_json(), await ws.receive_json()]
                    assert sum(result["success"] for result in results) == 1
                    pipe.send({"one_winner": True})
                    continue
                if command["type"] == "reattach_entry":
                    publisher = (await hass.data["jukelet_bridge"].status())["publisher_id"]
                    assert await hass.config_entries.async_remove(entry.entry_id)
                    assert "jukelet_bridge" not in hass.data
                    flow = await hass.config_entries.flow.async_init(
                        "jukelet_bridge", context={"source": "user"}
                    )
                    flow = await hass.config_entries.flow.async_configure(
                        flow["flow_id"],
                        {
                            "publisher_id": publisher,
                            "confirm_pairing": True,
                            "reattach_existing": True,
                        },
                    )
                    assert flow["type"] == "create_entry", flow
                    await hass.async_block_till_done()
                    entry = hass.config_entries.async_entries("jukelet_bridge")[0]
                    pipe.send({"reattached": True})
                    continue
                if command["type"] == "unsupported_version":
                    from homeassistant import const

                    with patch.object(const, "__version__", "2026.11.0"):
                        assert not await hass.config_entries.async_reload(entry.entry_id)
                    assert "jukelet_bridge" not in hass.data
                    assert await hass.config_entries.async_reload(entry.entry_id)
                    pipe.send({"version_fenced": True})
                    continue
                if command["type"] == "backup_full":
                    index += 1
                    await ws.send_json(
                        {
                            "id": index,
                            "type": "backup/generate",
                            "agent_ids": ["backup.local"],
                            "include_homeassistant": True,
                            "include_database": True,
                            "name": "Synthetic companion recovery",
                            "password": command["password"],
                        }
                    )
                    generated = await ws.receive_json()
                    assert generated["success"], generated
                    await hass.async_block_till_done()
                    index += 1
                    await ws.send_json({"id": index, "type": "backup/info"})
                    info = await ws.receive_json()
                    assert info["success"] and info["result"]["state"] == "idle", info
                    backups = info["result"]["backups"]
                    assert len(backups) == 1, info
                    assert backups[0]["agents"]["backup.local"]["protected"] is True
                    pipe.send({"backup_id": backups[0]["backup_id"]})
                    continue
                if command["type"] == "restore_full":
                    # Remove the entry through HA so restoration must recover it, not reuse it.
                    assert await hass.config_entries.async_remove(entry.entry_id)
                    assert not hass.config_entries.async_entries("jukelet_bridge")
                    index += 1
                    await ws.send_json(
                        {
                            "id": index,
                            "type": "backup/restore",
                            "backup_id": command["backup_id"],
                            "agent_id": "backup.local",
                            "password": command["password"],
                            "restore_homeassistant": True,
                            "restore_database": True,
                        }
                    )
                    response = await ws.receive()
                    if response.type == aiohttp.WSMsgType.TEXT:
                        assert response.json()["success"], response.json()
                    else:
                        assert response.type == aiohttp.WSMsgType.CLOSE, response.type
                    from homeassistant.components.homeassistant import KEY_HA_STOP
                    from homeassistant.const import RESTART_EXIT_CODE

                    await hass.data[KEY_HA_STOP]
                    assert hass.exit_code == RESTART_EXIT_CODE
                    pipe.send({"restart_for_restore": True})
                    return
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
            self.ready = self.receive()
            assert self.ready.get("ready") is True
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
    probe_ha_version()
    with tempfile.TemporaryDirectory(prefix="jukelet-ha-companion-") as temporary:
        directory = Path(temporary)
        (directory / "configuration.yaml").write_text("homeassistant: {}\n", encoding="utf-8")
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
            runtime.pipe.send({"type": "reattach_entry"})
            assert runtime.receive() == {"reattached": True}
            assert runtime.request("status")["result"] == published
            runtime.pipe.send({"type": "unsupported_version"})
            assert runtime.receive() == {"version_fenced": True}
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
            assert failure["error"]["code"] == "persistence_uncertain"
            assert runtime.request("status")["result"]["active_revision"] == 2
            print("PASS injected HA writer error: bridge denied success and retained old revision")
            runtime.close()
            runtime = Runtime(directory, port)
            assert runtime.request("status")["result"]["persistence"] == "degraded"
            runtime.pipe.send({"type": "recover", "snapshot": snapshot(4, 2)})
            assert runtime.receive() == {"flow_type": "create_entry"}
            second = runtime.request("status")["result"]
            paused = runtime.request("publish", snapshot=snapshot(5, 4), fault="before_write")
            assert paused == {"paused": "before_write", "acknowledged": False}
            runtime.close(crash=True)
            runtime = Runtime(directory, port)
            assert runtime.request("status")["result"]["active_revision"] == 4
            assert runtime.request("status")["result"]["persistence"] == "degraded"
            runtime.pipe.send({"type": "recover", "snapshot": snapshot(6, 4)})
            assert runtime.receive() == {"flow_type": "create_entry"}
            print("PASS SIGKILL before snapshot write: history fences old revision; recovered")
            paused = runtime.request("publish", snapshot=snapshot(7, 6), fault="after_write")
            assert paused == {"paused": "after_write", "acknowledged": False}
            runtime.close(crash=True)
            runtime = Runtime(directory, port)
            third = runtime.request("status")["result"]
            assert third["active_revision"] == 7 and not third["dispatch_enabled"]
            assert runtime.request("publish", snapshot=snapshot(7, 6))["result"] == third
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
            runtime.pipe.send({"type": "recover", "snapshot": snapshot(8)})
            assert runtime.receive() == {"flow_type": "create_entry"}
            runtime.pipe.send({"type": "reload"})
            assert runtime.receive() == {"reloaded": True}
            assert runtime.request("status")["result"]["active_revision"] == 8
            runtime.pipe.send({"type": "remove_snapshot"})
            assert runtime.receive() == {"removed": True}
            runtime.close()
            runtime = Runtime(directory, port)
            assert runtime.request("status")["result"]["persistence"] == "degraded"
            runtime.pipe.send({"type": "recover", "snapshot": snapshot(9)})
            assert runtime.receive() == {"flow_type": "create_entry"}
            runtime.close()
            runtime = Runtime(directory, port)
            assert runtime.request("status")["result"]["active_revision"] == 9
            print("PASS config entry recovery, reload, missing snapshot and recovery restart")
            runtime.pipe.send({"type": "concurrent"})
            assert runtime.receive() == {"one_winner": True}
            runtime.pipe.send({"type": "quarantine_snapshot"})
            assert runtime.receive() == {"quarantined": True}
            assert runtime.request("status")["result"]["persistence"] == "degraded"
            runtime.close()
            runtime = Runtime(directory, port)
            assert runtime.request("status")["result"]["persistence"] == "degraded"
            runtime.pipe.send({"type": "recover", "snapshot": snapshot(12)})
            assert runtime.receive() == {"flow_type": "create_entry"}
            replacement = snapshot(13, 12)
            replacement["publisher_id"] = "00000000-0000-4000-8000-000000000025"
            runtime.pipe.send({"type": "recover", "snapshot": replacement})
            assert runtime.receive() == {"flow_type": "create_entry"}
            runtime.close()
            runtime = Runtime(directory, port)
            assert (
                runtime.request("status")["result"]["publisher_id"] == replacement["publisher_id"]
            )
            assert (
                runtime.request("publish", snapshot=snapshot(14, 13))["error"]["code"]
                == "publisher_mismatch"
            )
            print("PASS concurrent publication, HA quarantine, recovery and publisher replacement")
            saved_status = runtime.request("status")["result"]
            saved_entry = runtime.ready["entry_id"]
            saved_code = runtime.ready["code_checksum"]
            backup_password = secrets.token_urlsafe(32)
            runtime.pipe.send({"type": "backup_full", "password": backup_password})
            backup_id = runtime.receive()["backup_id"]
            # Harmless changed code fixture demonstrates that Core restores installed code too.
            installed_code = directory / "custom_components/jukelet_bridge/__init__.py"
            with installed_code.open("a", encoding="utf-8") as code:
                code.write("\n# Synthetic post-backup code change.\n")
            assert hashlib.sha256(installed_code.read_bytes()).hexdigest() != saved_code
            newer = {**replacement, "revision": 14, "expected_active_revision": 13}
            assert runtime.request("publish", snapshot=newer)["result"]["active_revision"] == 14
            runtime.pipe.send({"type": "corrupt_history"})
            assert runtime.receive() == {"history_corrupted": True}
            runtime.close()
            runtime = Runtime(directory, port)
            assert runtime.request("status")["result"]["persistence"] == "degraded"
            runtime.pipe.send({"type": "recover", "snapshot": snapshot(14)})
            assert runtime.receive() == {"flow_type": "abort"}
            runtime.pipe.send({"type": "remove_all_stores"})
            assert runtime.receive() == {"stores_removed": True}
            runtime.close()
            runtime = Runtime(directory, port)
            assert runtime.request("status")["result"]["persistence"] == "degraded"
            assert (
                runtime.request("publish", snapshot=snapshot())["error"]["code"]
                == "recovery_required"
            )
            print("PASS corrupt history denied; missing stores retain config-entry fence")
            runtime.pipe.send(
                {"type": "restore_full", "backup_id": backup_id, "password": backup_password}
            )
            assert runtime.receive() == {"restart_for_restore": True}
            runtime.process.join(10)
            assert runtime.process.exitcode == 0
            runtime = Runtime(directory, port)
            assert runtime.ready["restored"] is True
            assert runtime.ready["entry_id"] == saved_entry
            assert runtime.ready["code_checksum"] == saved_code
            restored = runtime.request("status")["result"]
            assert restored == saved_status
            assert restored["persistence"] == "healthy" and restored["active_revision"] == 13
            assert not restored["dispatch_enabled"]
            stale_base = {**replacement, "revision": 15, "expected_active_revision": 14}
            assert (
                runtime.request("publish", snapshot=stale_base)["error"]["code"] == "base_conflict"
            )
            reconciled = {**replacement, "revision": 15, "expected_active_revision": 13}
            runtime.pipe.send({"type": "recover", "snapshot": reconciled})
            assert runtime.receive() == {"flow_type": "create_entry"}
            assert runtime.request("status")["result"]["active_revision"] == 15
            print(
                "PASS protected full Core backup/restore: code, config entry, "
                "exact publisher/revision/checksum; "
                "base conflict and higher-revision recovery, dispatch disabled"
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
