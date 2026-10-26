"""Opt-in isolated HA processes, inert script execution and actual process restart.

No existing target, credential, configuration directory or management app is used.
"""

import asyncio
import copy
import functools
import hashlib
import json
import logging
import multiprocessing
import os
import socket
import sys
import tempfile
from importlib.metadata import version
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

from companion.probe_support import install_probe_component, probe_ha_version, start_probe_process
from companion.runtime_probe import Runtime
from companion.tests.fixtures import snapshot

from .custom_components.jukelet_bridge.protocol import PUBLISHER


def child(directory: str, port: int, pipe: Connection) -> None:
    logging.basicConfig(level=logging.ERROR)
    try:
        asyncio.run(serve(directory, port, pipe))
    except BaseException as exc:
        pipe.send(
            {
                "failure": type(exc).__name__,
                "missing_module": exc.name if isinstance(exc, ModuleNotFoundError) else None,
            }
        )
        raise


async def serve(directory: str, port: int, pipe: Connection) -> None:
    import aiohttp
    from homeassistant import bootstrap, config_entries, loader
    from homeassistant.core import HomeAssistant, ServiceCall, callback
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
    for name, result in (
        (
            "readiness_failure",
            "{{ dict(contract_version=1, correlation_id=correlation_id, "
            "snapshot_revision=snapshot_revision, execution='failed', error='readiness_failed') }}",
        ),
        (
            "mismatched_failure",
            "{{ dict(contract_version=1, correlation_id='different-attempt', "
            "snapshot_revision=snapshot_revision, execution='failed', error='readiness_failed') }}",
        ),
        (
            "invalid_failure",
            "{{ dict(contract_version=1, correlation_id=correlation_id, "
            "snapshot_revision=true, execution='failed', error='readiness_failed') }}",
        ),
    ):
        script = copy.deepcopy(config["script"]["synthetic_dispatch"])
        script["sequence"][-2] = {"variables": {"result": result}}
        config["script"]["synthetic_" + name] = script
    missing = copy.deepcopy(config["script"]["synthetic_dispatch"])
    missing["sequence"] = [
        *missing["sequence"][:2],
        {"stop": "Synthetic missing completion"},
    ]
    config["script"]["synthetic_missing_completion"] = missing
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
                    *(
                        [{"type": "jukelet_bridge/compatibility"}]
                        if "custom_components.jukelet_bridge.compatibility" in sys.modules
                        else []
                    ),
                    *(
                        [{"type": "jukelet_bridge/diagnostics", "diagnostics_version": 1}]
                        if hasattr(hass.data["jukelet_dispatcher"], "operational_diagnostics")
                        else []
                    ),
                ),
                1,
            ):
                await denied.send_json({"id": index, **cast(dict[str, Any], request)})
                assert (await denied.receive_json())["error"]["code"] == "unauthorized"
        async with session.ws_connect(f"http://127.0.0.1:{port}/api/websocket") as ws:
            await ws.receive_json()
            await ws.send_json({"type": "auth", "access_token": token})
            assert (await ws.receive_json())["type"] == "auth_ok"
            import homeassistant
            from homeassistant.const import __version__ as loaded_ha_version

            ha_module = Path(homeassistant.__file__).resolve()
            assert ha_module.is_relative_to(Path(sys.prefix).resolve())
            assert loaded_ha_version == version("homeassistant")
            has_compatibility = "custom_components.jukelet_bridge.compatibility" in sys.modules
            if has_compatibility:
                await ws.send_json({"id": 1, "type": "jukelet_bridge/compatibility"})
                assessment = await ws.receive_json()
                assert assessment["success"] and assessment["result"]["allowed"], assessment
                assert assessment["result"]["core_version"] == loaded_ha_version
                assert assessment["result"]["minimum"] == "2026.10.3"
                assert assessment["result"]["state"] in {"expected_compatible", "untested"}
            pipe.send(
                {
                    "ready": True,
                    "ha_version": loaded_ha_version,
                    "ha_distribution_version": version("homeassistant"),
                    "ha_module": str(ha_module),
                    "python_executable": sys.executable,
                    "python_prefix": sys.prefix,
                    "python_version": sys.version.split()[0],
                    "pid": os.getpid(),
                }
            )
            index = 1 if has_compatibility else 0
            while True:
                command = await asyncio.to_thread(pipe.recv)
                if command["type"] == "stop":
                    break
                if command["type"] == "distribution_state":
                    # Probe-only inspection of loaded code and companion-owned Stores.
                    # No credential stores or pre-existing configuration are accepted.
                    from custom_components.jukelet_bridge.ha_store import HAStore

                    integration = await loader.async_get_integration(hass, "jukelet_bridge")
                    root = Path(directory) / "custom_components/jukelet_bridge"
                    modules = {
                        name.removeprefix("custom_components.jukelet_bridge"): Path(module.__file__)
                        for name, module in sys.modules.items()
                        if (
                            name == "custom_components.jukelet_bridge"
                            or name.startswith("custom_components.jukelet_bridge.")
                        )
                        and getattr(module, "__file__", None)
                    }
                    assert all(path.is_relative_to(root) for path in modules.values())
                    files = {
                        path.relative_to(root).as_posix(): hashlib.sha256(
                            path.read_bytes()
                        ).hexdigest()
                        for path in root.rglob("*")
                        if path.is_file() and "__pycache__" not in path.parts
                    }
                    entry = hass.config_entries.async_entries("jukelet_bridge")[0]
                    info = root / "build_info.json"
                    pipe.send(
                        {
                            "version": integration.version,
                            "identity": json.loads(info.read_text()) if info.exists() else None,
                            "files": files,
                            "loaded_modules": sorted(modules),
                            "entry_id": entry.entry_id,
                            "entry_data": dict(entry.data),
                            "history": await HAStore(hass, "jukelet_bridge.history").load(),
                            "snapshot": await HAStore(hass).load(),
                            "fence": await HAStore(hass, "jukelet_bridge.execution").load(),
                        }
                    )
                elif command["type"] == "compatibility_contracts":
                    import probatio
                    from custom_components import jukelet_bridge
                    from custom_components.jukelet_bridge.compatibility import compatibility
                    from custom_components.jukelet_bridge.ha_store import HAStore
                    from homeassistant import config_entries, const, exceptions
                    from homeassistant.components.websocket_api import decorators
                    from homeassistant.helpers import storage

                    entry = hass.config_entries.async_entries("jukelet_bridge")[0]

                    async def preserved(entry: Any = entry) -> list[Any]:
                        return [
                            dict(entry.data),
                            *(
                                await asyncio.gather(
                                    *(
                                        HAStore(hass, key).load()
                                        for key in (
                                            "jukelet_bridge.history",
                                            "jukelet_bridge.snapshot",
                                            "jukelet_bridge.execution",
                                        )
                                    )
                                )
                            ),
                        ]

                    before = await preserved()
                    import importlib

                    original_import = importlib.import_module

                    def missing_storage(
                        name: str,
                        package: str | None = None,
                        original_import: Any = original_import,
                    ) -> Any:
                        if name == "homeassistant.helpers.storage":
                            raise ImportError("synthetic required API removed")
                        return original_import(name, package)

                    def sync_unique_id(
                        self: Any, unique_id: str | None = None, *, raise_on_progress: bool = True
                    ) -> None:
                        return None

                    def sync_reload(self: Any, entry_id: str) -> None:
                        return None

                    def narrow_form(self: Any, *, step_id: str | None = None) -> None:
                        return None

                    async def async_entry_factory(self: Any, *, title: str, data: Any) -> None:
                        return None

                    from companion.compatibility_probe import invocation_mode_cases

                    mode_faults = []
                    for owner, attribute, reason in invocation_mode_cases(hass):

                        @functools.wraps(getattr(owner, attribute))
                        async def replacement(*args: Any, **kwargs: Any) -> None:
                            return None

                        mode_faults.append((owner, attribute, replacement, reason))

                    for owner, attribute, replacement, reason in (
                        *mode_faults,
                        (
                            storage.Store,
                            "async_save",
                            lambda self, data: None,
                            "atomic_private_store",
                        ),
                        (decorators, "require_admin", None, "websocket_admin"),
                        (probatio, "Optional", None, "schema_validation"),
                        (probatio, "In", None, "schema_validation"),
                        (
                            config_entries.ConfigFlow,
                            "async_set_unique_id",
                            sync_unique_id,
                            "config_flow",
                        ),
                        (config_entries.ConfigEntries, "async_reload", sync_reload, "config_flow"),
                        (config_entries.ConfigFlow, "async_show_form", narrow_form, "config_flow"),
                        (
                            config_entries.ConfigFlow,
                            "async_create_entry",
                            async_entry_factory,
                            "config_flow",
                        ),
                        (config_entries.ConfigFlow, "async_abort", None, "config_flow"),
                        (config_entries.OptionsFlow, "async_abort", None, "config_flow"),
                        (exceptions, "HomeAssistantError", None, "script_error_contract"),
                        (importlib, "import_module", missing_storage, "required_core_imports"),
                        (
                            type(hass.services),
                            "async_call",
                            lambda self, domain, service, data, *, blocking: None,
                            "blocking_script_response",
                        ),
                        (const, "__version__", "2026.10.2", "minimum_core_2026_10_3"),
                        (const, "__version__", "2026.10." + "9" * 5000, "malformed_version"),
                    ):
                        with patch.object(owner, attribute, replacement):
                            assessment = compatibility(hass)
                            assert not assessment.allowed and assessment.reason == reason, (
                                assessment
                            )
                            assert not await jukelet_bridge.async_setup(hass, {})
                            assert not await jukelet_bridge.async_setup_entry(hass, entry)
                            rejected = await hass.config_entries.flow.async_init(
                                "jukelet_bridge", context={"source": "user"}
                            )
                            assert (
                                rejected["type"] == "abort"
                                and rejected["reason"] == "incompatible_core"
                            ), rejected
                            rejected = await hass.config_entries.options.async_init(entry.entry_id)
                            assert (
                                rejected["type"] == "abort"
                                and rejected["reason"] == "incompatible_core"
                            ), rejected
                        assert await preserved() == before
                    with patch.object(const, "__version__", "2027.1.99"):
                        assert compatibility(hass).state == "expected_compatible"
                        assert await hass.config_entries.async_reload(entry.entry_id)
                    assert await preserved() == before
                    pipe.send({"contracts_preserved": True, "future_version": "synthetic"})
                elif command["type"] == "distribution_recover":
                    entry = hass.config_entries.async_entries("jukelet_bridge")[0]
                    flow = await hass.config_entries.options.async_init(entry.entry_id)
                    if flow["type"] == "menu":
                        flow = await hass.config_entries.options.async_configure(
                            flow["flow_id"], {"next_step_id": "recovery"}
                        )
                    flow = await hass.config_entries.options.async_configure(
                        flow["flow_id"], {"snapshot_json": json.dumps(command["snapshot"])}
                    )
                    assert flow["step_id"] == "confirm", flow
                    flow = await hass.config_entries.options.async_configure(
                        flow["flow_id"], {"confirm_recovery": True}
                    )
                    pipe.send({"flow_type": flow["type"]})
                elif command["type"] == "distribution_damage_history":
                    from custom_components.jukelet_bridge.ha_store import HAStore

                    await HAStore(hass, "jukelet_bridge.history").save({"version": 999})
                    pipe.send({"damaged": True})
                elif command["type"] == "control_flow":
                    # Exercise HA's real admin-only HTTP options endpoints with
                    # generated in-process users; never accept credentials/targets.
                    assert await async_setup_component(hass, "config", {})
                    entry = hass.config_entries.async_entries("jukelet_bridge")[0]
                    path = "/api/config/config_entries/options/flow"
                    if command.get("flow_id"):
                        path += "/" + command["flow_id"]
                    data = command.get("data", {"handler": entry.entry_id})
                    auth = token if command.get("admin", True) else reader_token
                    async with session.request(
                        command.get("method", "POST"),
                        f"http://127.0.0.1:{port}" + path,
                        headers={"Authorization": "Bearer " + auth},
                        json=data,
                    ) as response:
                        body = (
                            await response.json()
                            if response.content_type == "application/json"
                            else None
                        )
                        pipe.send({"status": response.status, "body": body})
                elif command["type"] == "control_concurrency":
                    from custom_components.jukelet_bridge import DISPATCHER, FENCE_KEY
                    from custom_components.jukelet_bridge.protocol import ProtocolError

                    dispatcher = hass.data[DISPATCHER]
                    entry = hass.config_entries.async_entries("jukelet_bridge")[0]
                    path = f"http://127.0.0.1:{port}/api/config/config_entries/options/flow"

                    async def post(
                        data: dict[str, Any], flow_id: str = "", *, path: str = path
                    ) -> dict[str, Any]:
                        async with session.post(
                            path + ("/" + flow_id if flow_id else ""),
                            headers={"Authorization": "Bearer " + token},
                            json=data,
                        ) as response:
                            assert response.status == 200
                            return cast(dict[str, Any], await response.json())

                    async def prepare_reconcile(entry: Any = entry) -> dict[str, Any]:
                        page = await post({"handler": entry.entry_id})
                        page = await post({"next_step_id": "playback"}, page["flow_id"])
                        return await post({"next_step_id": "reconcile"}, page["flow_id"])

                    first_page, second_page = await prepare_reconcile(), await prepare_reconcile()
                    entered, release, rejected_busy = (
                        asyncio.Event(),
                        asyncio.Event(),
                        asyncio.Event(),
                    )
                    store_type = type(dispatcher.fence)
                    original_save, original_guard = store_type.save, dispatcher.guarded_control
                    saves = 0

                    async def hold_clear(
                        store: Any,
                        value: dict[str, Any],
                        *,
                        entered: asyncio.Event = entered,
                        release: asyncio.Event = release,
                        original_save: Any = original_save,
                    ) -> None:
                        nonlocal saves
                        if store.key == FENCE_KEY and value["uncertain"] is False:
                            saves += 1
                            entered.set()
                            await release.wait()
                        await original_save(store, value)

                    async def observed_guard(
                        *args: Any,
                        original_guard: Any = original_guard,
                        rejected_busy: asyncio.Event = rejected_busy,
                        **kwargs: Any,
                    ) -> Any:
                        try:
                            return await original_guard(*args, **kwargs)
                        except ProtocolError as exc:
                            if exc.code == "busy":
                                rejected_busy.set()
                            raise

                    with (
                        patch.object(store_type, "save", hold_clear),
                        patch.object(dispatcher, "guarded_control", observed_guard),
                    ):
                        first = asyncio.create_task(
                            post({"confirm_all_stopped": True}, first_page["flow_id"])
                        )
                        second: asyncio.Task[dict[str, Any]] | None = None
                        try:
                            await asyncio.wait_for(entered.wait(), 5)
                            second = asyncio.create_task(
                                post({"confirm_all_stopped": True}, second_page["flow_id"])
                            )
                            await asyncio.wait_for(rejected_busy.wait(), 5)
                            # Both responses wait for a truthful persistence readback,
                            # but the second mutation was already rejected, not queued.
                            assert not first.done() and not second.done()
                        finally:
                            release.set()
                            first_result = await first
                            second_result = await second if second is not None else None
                        assert saves == 1
                        assert "confirmed" in first_result["description_placeholders"]["outcome"]
                        assert second_result is not None
                        assert (
                            "Reason: busy" in second_result["description_placeholders"]["outcome"]
                        )
                        assert (
                            "Dispatch: disabled"
                            in second_result["description_placeholders"]["state"]
                        )
                    pipe.send({"one_write": True, "second_rejected_busy": True})
                elif command["type"] == "control_prepare_unavailable":
                    dispatcher = hass.data["jukelet_dispatcher"]
                    original_status = dispatcher.bridge.status

                    async def unavailable_prepare(
                        dispatcher: Any = dispatcher,
                        original_status: Any = original_status,
                    ) -> Any:
                        dispatcher.bridge.status = original_status
                        raise TimeoutError("synthetic unavailable confirmation readback")

                    dispatcher.bridge.status = unavailable_prepare
                    pipe.send({"installed": True})
                elif command["type"] == "control_fault":
                    from custom_components.jukelet_bridge import DISPATCHER

                    dispatcher = hass.data[DISPATCHER]
                    original = dispatcher.guarded_control
                    fault = command["fault"]

                    async def faulted_control(
                        *args: Any,
                        original: Any = original,
                        fault: str = fault,
                        dispatcher: Any = dispatcher,
                        **kwargs: Any,
                    ) -> Any:
                        dispatcher.guarded_control = original
                        result = await original(*args, **kwargs)
                        if fault == "lost_ack":
                            raise TimeoutError("synthetic lost acknowledgment")
                        if fault == "malformed_ack":
                            return {"dispatch_enabled": "false"}
                        if fault == "readback":
                            original_status = dispatcher.bridge.status

                            async def unavailable() -> Any:
                                dispatcher.bridge.status = original_status
                                raise TimeoutError("synthetic unavailable readback")

                            dispatcher.bridge.status = unavailable
                        return result

                    dispatcher.guarded_control = faulted_control
                    pipe.send({"installed": True})
                elif command["type"] == "scan":
                    for event in command["events"]:
                        hass.bus.async_fire("tag_scanned", event)
                    await asyncio.sleep(command.get("wait", 0.4))
                    pipe.send({"captures": captures})
                elif command["type"] == "native_scan":
                    from homeassistant.components import tag
                    from homeassistant.helpers import entity_registry as er

                    assert await async_setup_component(hass, "tag", {})
                    native_events: list[dict[str, Any]] = []

                    @callback
                    def observed(event: Any, events: list[dict[str, Any]] = native_events) -> None:
                        events.append(dict(event.data))

                    unsubscribe = hass.bus.async_listen("tag_scanned", observed)
                    try:
                        for event in command["events"]:
                            if "name" in event:
                                registry = er.async_get(hass)
                                entry = registry.async_get_or_create("tag", "tag", event["tag_id"])
                                registry.async_update_entity(entry.entity_id, name=event["name"])
                            await tag.async_scan_tag(hass, event["tag_id"], event.get("device_id"))
                        await asyncio.sleep(command.get("wait", 0.4))
                    finally:
                        unsubscribe()
                    assert not hass.config.components.intersection(
                        {
                            "automation",
                            "remote",
                            "media_player",
                            "spotifyplus",
                            "discovery",
                            "zeroconf",
                            "ssdp",
                            "bluetooth",
                            "dhcp",
                            "default_config",
                        }
                    )
                    pipe.send({"captures": captures, "events": native_events})
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
    def __init__(self, directory: Path, port: int, *, executable: Path | None = None) -> None:
        context = multiprocessing.get_context("spawn")
        self.pipe, remote = context.Pipe()
        self.process = context.Process(target=child, args=(str(directory), port, remote))
        start_probe_process(self.process, executable)
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
    probe_ha_version()
    with tempfile.TemporaryDirectory(prefix="jukelet-ha-dispatcher-") as temporary:
        directory = Path(temporary)
        install_probe_component(directory)
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
            assert runtime.request("status")["result"]["dispatch_enabled"]
            runtime.close()
            runtime = DispatcherRuntime(directory, port)
            recovered = runtime.request("status")["result"]
            assert recovered["active_revision"] == 1 and recovered["persistence"] == "healthy"
            assert recovered["dispatch_enabled"]
            assert runtime.scan([]) == [], "Restart must never invoke or replay work"
            assert len(runtime.scan([event])) == 1
            print(
                "PASS actual process restart: persisted snapshot/allowlist, "
                "remembered enabled choice, readiness checked, no replay"
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
                f"PASS non-admin control denial; synthetic HA {probe_ha_version()}, "
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
