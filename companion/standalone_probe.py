"""Opt-in standalone app publication and app-stopped playback with inert HA scripts.

Owned synthetic processes only, without an automation integration or old mapping source.
"""

import asyncio
import hashlib
import json
import logging
import multiprocessing
import secrets
import sqlite3
import sys
import tempfile
from importlib.metadata import version
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any

import aiohttp

from companion.custom_components.jukelet_bridge.protocol import PUBLISHER
from companion.probe_support import (
    install_probe_component,
    probe_ha_version,
    wait_for_healthy_dispatch,
)
from companion.publication_probe import App, Client, app_command, free_port
from companion.runtime_probe import Runtime
from companion.standalone_diagnostics import ALBUM, PLAYLIST, scan_diagnostic, trace_scan

ROOT = Path(__file__).resolve().parents[1]
DISABLED = "Synthetic disabled"
TRACK = "Synthetic excluded track"
SCRIPT = "script.synthetic_standalone"


def child(directory: str, port: int, pipe: Connection) -> None:
    logging.basicConfig(level=logging.ERROR)
    try:
        asyncio.run(serve(directory, port, pipe))
    except BaseException as exc:
        pipe.send({"failure": type(exc).__name__})
        raise


async def serve(directory: str, port: int, pipe: Connection) -> None:
    from homeassistant import bootstrap, config_entries, loader
    from homeassistant.core import HomeAssistant, ServiceCall
    from homeassistant.core_config import async_process_ha_core_config
    from homeassistant.setup import async_setup_component

    hass = HomeAssistant(directory)
    hass.config.skip_pip = True
    loader.async_setup(hass)
    captures: list[dict[str, Any]] = []
    http_requests: list[tuple[str, str]] = []

    async def capture(call: ServiceCall) -> None:
        # HA wraps rendered nested dictionaries; detach before crossing the
        # multiprocessing pipe, which cannot pickle local template wrappers.
        captures.append(json.loads(json.dumps(dict(call.data))))

    hass.services.async_register("synthetic_probe", "capture", capture)
    config: dict[str, Any] = {
        "homeassistant": {
            "name": "Synthetic standalone",
            "latitude": 0,
            "longitude": 0,
            "elevation": 0,
            "unit_system": "metric",
            "time_zone": "UTC",
            "auth_mfa_modules": [],
        },
        "http": {"server_host": "127.0.0.1", "server_port": port},
        "script": {
            "synthetic_standalone": {
                "mode": "single",
                "max_exceeded": "silent",
                "sequence": [
                    {
                        "action": "synthetic_probe.capture",
                        "data": {
                            "route": "new",
                            "request": "{{ dict(tag_id=tag_id, reader_id=reader_id, "
                            "snapshot_revision=snapshot_revision, correlation_id=correlation_id, "
                            "spotify_uri=spotify_uri, media_type=media_type, shuffle=shuffle) }}",
                        },
                    },
                    {"delay": {"milliseconds": 150}},
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
    hass.config_entries = config_entries.ConfigEntries(hass, config)
    assert await bootstrap.async_load_base_functionality(hass)
    await async_process_ha_core_config(hass, config["homeassistant"])
    for domain in ("script", "tag", "jukelet_bridge"):
        assert await async_setup_component(hass, domain, config)
    assert not hass.config.components.intersection(
        {"automation", "media_player", "spotifyplus", "default_config"}
    )

    async def record_request(request: Any, response: Any) -> None:
        # Paths/methods only: never capture headers, tokens, bodies or query values.
        http_requests.append((request.method, request.path))

    hass.http.app.on_response_prepare.append(record_request)
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
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(f"http://127.0.0.1:{port}/api/websocket") as ws:
            await ws.receive_json()
            await ws.send_json({"type": "auth", "access_token": token})
            assert (await ws.receive_json())["type"] == "auth_ok"
            pipe.send({"ready": True, "pid": multiprocessing.current_process().pid})
            index = 0
            while True:
                command = await asyncio.to_thread(pipe.recv)
                kind = command["type"]
                if kind == "stop":
                    break
                if kind == "app_connection":
                    pipe.send({"token": token})
                elif kind == "observe":
                    pipe.send({"captures": captures, "http_requests": http_requests})
                elif kind == "native_scan":
                    from homeassistant.components import tag

                    await tag.async_scan_tag(hass, command["tag_id"], "Synthetic onboarding reader")
                    pipe.send({"registered": True})
                elif kind == "scan":
                    for event in command["events"]:
                        hass.bus.async_fire("tag_scanned", event)
                    await asyncio.sleep(0.25)
                    await hass.async_block_till_done()
                    pipe.send({"captures": captures})
                else:
                    index += 1
                    await ws.send_json({"id": index, **command})
                    pipe.send(await ws.receive_json())
    await hass.async_stop()
    pipe.send({"stopped": True})


class StandaloneRuntime(Runtime):
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

    def local(self, kind: str, **fields: Any) -> dict[str, Any]:
        self.pipe.send({"type": kind, **fields})
        return self.receive()


def observe(runtime: StandaloneRuntime, label: str, *, enabled: bool) -> dict[str, Any]:
    # Separate actual state reads, never command acknowledgments. The probe has
    # one serialized operator; there is no production cross-dispatcher interlock.
    actual = runtime.request("status")["result"]
    print(
        json.dumps(
            {
                "step": label,
                "enabled": actual["dispatch_enabled"],
                "busy": actual["dispatcher"]["busy"],
                "execution_uncertain": actual["dispatcher"]["execution_uncertain"],
                "ready": actual["dispatcher"]["ready"],
                "readiness_error": actual["dispatcher"]["readiness_error"],
                "publisher_id": actual["publisher_id"],
                "revision": actual["active_revision"],
                "checksum": actual["active_checksum"],
                "persistence": actual["persistence"],
            },
            sort_keys=True,
        )
    )
    assert actual["dispatch_enabled"] is enabled
    assert actual["publisher_id"] == PUBLISHER
    assert actual["dispatcher"]["playback_verification"] == "unavailable"
    if actual["active_revision"] is not None:
        assert actual["persistence"] == "healthy" and len(actual["active_checksum"]) == 64
    return actual


async def settled(client: Client) -> dict[str, Any]:
    async with asyncio.timeout(35):
        while True:
            status: dict[str, Any] = await client.request("GET", "publication")
            assert status["playback_verified"] is None
            if status["verified"] and not status["actual_stale"]:
                assert not any(
                    job["state"] in {"queued", "in_flight", "uncertain"} for job in status["jobs"]
                )
                return status
            await asyncio.sleep(0.1)


async def save(
    client: Client,
    tag: str,
    kind: str,
    suffix: str,
    *,
    version: int = 0,
    enabled: bool = True,
    shuffle: bool = False,
) -> None:
    await client.request(
        "PUT",
        f"tags/{hashlib.sha256(tag.encode()).hexdigest()}/assignment",
        {
            "ha_tag_id": tag,
            "input": f"spotify:{kind}:" + suffix * 22,
            "media_type": kind,
            "enabled": enabled,
            "shuffle": shuffle,
            "playback_profile_id": "default",
            "expected_version": version,
        },
    )


async def run(directory: Path) -> None:
    ha_dir, app_dir = directory / "ha", directory / "app"
    ha_dir.mkdir()
    app_dir.mkdir()
    (ha_dir / "configuration.yaml").write_text("homeassistant: {}\n")
    install_probe_component(ha_dir)
    secret = secrets.token_urlsafe(40)
    (app_dir / "app-secret").write_text(secret)
    (app_dir / "app-secret").chmod(0o600)
    database = app_dir / "app.db"
    app_command(
        "-c",
        "from pathlib import Path; from jukelet.storage import open_database,migrate; "
        "import sys; e=open_database(Path(sys.argv[1])); migrate(e); e.dispose()",
        str(database),
    )
    # Fixture pairing only; this is never a production identity-changing procedure.
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE recovery_state SET publisher_id=?", (PUBLISHER,))
    ha_port, app_port = free_port(), free_port()
    runtime = StandaloneRuntime(ha_dir, ha_port)
    app: App | None = None
    client: Client | None = None
    try:
        token = runtime.local("app_connection")["token"]
        app = App(app_dir, ha_port, token, app_port)
        client = Client(app, secret)
        await client.login()
        await client.status()
        assert runtime.local("native_scan", tag_id=ALBUM)["registered"]
        async with asyncio.timeout(15):
            while True:
                inbox = await client.request("GET", "tags/inbox")
                found = next((row for row in inbox["tags"] if row["ha_tag_id"] == ALBUM), None)
                if found and found["state"] == "registered":
                    break
                await asyncio.sleep(0.1)
        assert found["local_assignment"] == "unassigned"
        renamed = await client.request(
            "PATCH",
            f"tags/{found['tag_key']}/name",
            {
                "ha_tag_id": ALBUM,
                "expected_name": found["name"],
                "name": "Synthetic standalone album",
            },
        )
        assert renamed["state"] == "verified" and renamed["name"] == "Synthetic standalone album"
        for obsolete in ("preview", "confirm"):
            async with client.http.post(
                client.app.origin + "/api/v1/imports/" + obsolete,
                headers=client.headers,
                json={"source": "configured"},
            ) as response:
                assert response.status == 410
        print(
            "PASS actual native tag onboarding, app inventory and independent rename readback; "
            "retired requests rejected"
        )
        await save(client, ALBUM, "album", "A", shuffle=True)
        await save(client, PLAYLIST, "playlist", "P", shuffle=False)
        review = await client.request("POST", "publication/review", {"action": "publish"})
        assert review["shuffle_conflict"] and len(review["mappings"]) == 2
        assert (await client.request("GET", "publication"))["jobs"] == []
        # Explicit synthetic owner edits, never inferred preference conversion.
        await save(client, ALBUM, "album", "A", version=1, shuffle=False)
        await save(client, PLAYLIST, "playlist", "P", version=1, shuffle=True)
        await save(client, DISABLED, "album", "D", enabled=False)
        assert not (await client.request("GET", "publication"))["shuffle_conflict"]
        inventory = await client.request("GET", "tags")
        saved = next(row for row in inventory["tags"] if row["ha_tag_id"] == ALBUM)
        assert saved["saved_assignment"]["spotify_uri"] == "spotify:album:" + "A" * 22
        assert saved["name"] == "Synthetic standalone album"
        print("PASS both shuffle conflicts visible; only explicit versioned app edits resolve them")
        observe(runtime, "standalone baseline", enabled=False)
        await client.publish()
        status = await settled(client)
        published = observe(runtime, "disabled publication", enabled=False)
        assert published["active_revision"] == 1
        assert published["active_checksum"] == status["desired_checksum"]
        assert not status["automatic_enabled"]
        app_command("-m", "jukelet.backup", "backup", str(database), str(app_dir / "backup.db"))
        assert runtime.request("configure_dispatch", profiles={"default": SCRIPT})["success"]
        observe(runtime, "configured disabled", enabled=False)
        assert runtime.request("dispatch", action="reconcile", confirmed_stopped=True)["success"]
        observe(runtime, "reviewed inert work stopped", enabled=False)
        observe(runtime, "review before enable", enabled=False)
        assert runtime.request("dispatch", action="enable")["success"]
        scan_before = observe(runtime, "new enabled", enabled=True)
        scan_trace: list[tuple[str, int, int, int, int]] = []
        event = {"tag_id": ALBUM, "device_id": "Synthetic reader Å"}
        captures = trace_scan(
            runtime, "initial_pair", [event, {**event, "tag_id": PLAYLIST}], scan_trace
        )
        assert len(captures) == 1 and captures[0]["route"] == "new"
        request = captures[0]["request"]
        assert request["tag_id"] == ALBUM and request["reader_id"] == event["device_id"]
        assert request["snapshot_revision"] == 1 and request["shuffle"] is False
        trace_scan(runtime, "duplicate_album", [event], scan_trace)
        for label, tag in (
            ("unknown", "Synthetic unknown"),
            ("unassigned", "Synthetic registered unassigned"),
            ("disabled", DISABLED),
            ("excluded_track", TRACK),
        ):
            assert len(trace_scan(runtime, label, [{**event, "tag_id": tag}], scan_trace)) == 1
        captures = trace_scan(runtime, "playlist", [{**event, "tag_id": PLAYLIST}], scan_trace)
        assert len(captures) == 2 and captures[1]["request"]["shuffle"] is True
        scan_after = runtime.request("status")["result"]
        print(
            json.dumps(scan_diagnostic(scan_before, scan_after, scan_trace), sort_keys=True),
            flush=True,
        )
        diagnostics = scan_after["dispatcher"]["diagnostics"]
        assert {"ignored_busy", "ignored_duplicate", "rejected_mapping"} <= {
            row["reason"] for row in diagnostics
        }
        print(
            "PASS exact IDs, album/playlist, unknown/unmapped/disabled/excluded, busy and duplicate"
        )
        # This opt-in is a distinct, reviewed synthetic step after independent readiness review.
        await client.publish("activate")
        assert (await settled(client))["automatic_enabled"]
        await save(client, ALBUM, "album", "B", version=2)
        assert (await settled(client))["active_revision"] == 2
        observe(runtime, "separate automatic opt-in", enabled=True)
        await client.close()
        client = None
        app.close()
        app = None
        assert (
            len(
                runtime.local("scan", events=[{**event, "device_id": "Synthetic app stopped"}])[
                    "captures"
                ]
            )
            == 3
        )
        wait_for_healthy_dispatch(lambda: runtime.request("status")["result"])
        before_restart = observe(runtime, "app stopped inert invocation", enabled=True)
        request_capture = runtime.local("observe")["http_requests"]
        assert not any(
            "/config/automation/" in path or "/states/automation." in path
            for _, path in request_capture
        )
        print(
            "PASS captured HA HTTP paths contain no automation-configuration fetches",
            request_capture,
        )
        pid = runtime.ready["pid"]
        runtime.close()
        runtime = StandaloneRuntime(ha_dir, ha_port)
        assert runtime.ready["pid"] != pid
        restarted = observe(runtime, "actual HA restart remembered enabled", enabled=True)
        for field in ("publisher_id", "active_revision", "active_checksum", "persistence"):
            assert restarted[field] == before_restart[field]
        assert runtime.local("scan", events=[])["captures"] == []
        assert (
            restarted["dispatcher"]["ready"] and not restarted["dispatcher"]["execution_uncertain"]
        )
        captures = runtime.local("scan", events=[event])["captures"]
        assert (
            len(captures) == 1
            and captures[0]["request"]["spotify_uri"] == "spotify:album:" + "B" * 22
        )
        app = App(app_dir, ha_port, runtime.local("app_connection")["token"], app_port)
        client = Client(app, secret)
        await client.login()
        assert (await settled(client))["automatic_enabled"]
        await client.request("POST", "publication/suspend", {})
        status = await settled(client)
        assert not status["automatic_enabled"]  # settled also proves no queued/in-flight work.
        observe(runtime, "automatic suspended and jobs drained", enabled=True)
        assert runtime.request("dispatch", action="disable")["success"]
        before_disabled = observe(runtime, "explicit disabled choice", enabled=False)
        await client.close()
        client = None
        app.close()
        app = None
        request_capture = runtime.local("observe")["http_requests"]
        assert not any(
            "/config/automation/" in path or "/states/automation." in path
            for _, path in request_capture
        )
        print(
            "PASS captured HA HTTP paths contain no automation-configuration fetches",
            request_capture,
        )
        pid = runtime.ready["pid"]
        runtime.close()
        runtime = StandaloneRuntime(ha_dir, ha_port)
        assert runtime.ready["pid"] != pid
        final = observe(runtime, "actual restart remembers disabled", enabled=False)
        assert final["active_revision"] == before_disabled["active_revision"]
        assert final["active_checksum"] == before_disabled["active_checksum"]
        assert runtime.local("scan", events=[event])["captures"] == []
        print("PASS app-stopped playback; healthy enabled/disabled restarts; no replay")
        print(
            json.dumps(
                {
                    "synthetic": True,
                    "ha_version": version("homeassistant"),
                    "python": sys.version.split()[0],
                    "playback_verified": False,
                    "source_sha256": {
                        path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest()
                        for path in (
                            "companion/standalone_probe.py",
                            "companion/publication_probe.py",
                            "companion/custom_components/jukelet_bridge/__init__.py",
                        )
                    },
                },
                sort_keys=True,
            )
        )
    finally:
        if client:
            await client.close()
        if app:
            app.close()
        runtime.close()


def main() -> None:
    assert len(sys.argv) == 1, "No target, credential or configuration arguments allowed"
    probe_ha_version()
    with tempfile.TemporaryDirectory(prefix="jukelet-standalone-") as temporary:
        asyncio.run(run(Path(temporary)))


if __name__ == "__main__":
    main()
