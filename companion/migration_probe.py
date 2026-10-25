"""Opt-in synthetic migration rehearsal; never accepts an existing installation.

Uses real app HTTP publication, HA scripts/automation, WebSocket controls and HA
process restarts. Both dispatch paths only capture generated values in memory.
This is an operator-procedure probe, not household or Spotify playback evidence.
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
from companion.probe_support import install_probe_component, probe_ha_version
from companion.publication_probe import App, Client, app_command, free_port
from companion.runtime_probe import Runtime

ROOT = Path(__file__).resolve().parents[1]
ALBUM = " Synthetic migration:Å/😀 "
PLAYLIST = "Synthetic e\u0301 playlist"
DISABLED = "Synthetic disabled"
TRACK = "Synthetic excluded track"
LEGACY = "automation.synthetic_legacy"
SCRIPT = "script.synthetic_migration"
LEGACY_MAPPINGS = {
    ALBUM: {"media_content_id": "spotify:album:" + "A" * 22, "media_content_type": "album"},
    PLAYLIST: {
        "media_content_id": "spotify:playlist:" + "P" * 22,
        "media_content_type": "playlist",
    },
    TRACK: {"media_content_id": "spotify:track:" + "T" * 22, "media_content_type": "track"},
}


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

    async def capture(call: ServiceCall) -> None:
        # HA wraps rendered nested dictionaries; detach before crossing the
        # multiprocessing pipe, which cannot pickle local template wrappers.
        captures.append(json.loads(json.dumps(dict(call.data))))

    hass.services.async_register("synthetic_probe", "capture", capture)
    config: dict[str, Any] = {
        "homeassistant": {
            "name": "Synthetic migration",
            "latitude": 0,
            "longitude": 0,
            "elevation": 0,
            "unit_system": "metric",
            "time_zone": "UTC",
            "auth_mfa_modules": [],
        },
        "http": {"server_host": "127.0.0.1", "server_port": port},
        "automation": [
            {
                "id": "synthetic_legacy",
                "alias": "Synthetic legacy",
                "initial_state": False,
                "mode": "single",
                "max_exceeded": "silent",
                "triggers": [{"trigger": "event", "event_type": "tag_scanned"}],
                "conditions": [
                    {
                        "condition": "template",
                        "value_template": "{{ trigger.event.data.get('tag_id') in tags }}",
                    }
                ],
                "variables": {"tags": LEGACY_MAPPINGS},
                "actions": [
                    {
                        "action": "synthetic_probe.capture",
                        "data": {"route": "legacy", "tag_id": "{{ trigger.event.data.tag_id }}"},
                    }
                ],
            }
        ],
        "script": {
            "synthetic_migration": {
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
    for domain in ("script", "automation", "jukelet_bridge"):
        assert await async_setup_component(hass, domain, config)
    assert not hass.config.components.intersection(
        {"tag", "media_player", "spotifyplus", "default_config"}
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
                elif kind == "legacy":
                    await hass.services.async_call(
                        "automation",
                        "turn_on" if command["enabled"] else "turn_off",
                        {"entity_id": LEGACY},
                        blocking=True,
                    )
                    pipe.send({"acknowledged": True})
                elif kind == "observe":
                    state = hass.states.get(LEGACY)
                    assert state is not None and state.state in {"on", "off"}
                    pipe.send({"legacy_enabled": state.state == "on", "captures": captures})
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


class MigrationRuntime(Runtime):
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


def observe(runtime: MigrationRuntime, label: str, *, legacy: bool, new: bool) -> dict[str, Any]:
    # Separate actual state reads, never command acknowledgments. The probe has
    # one serialized operator; there is no production cross-dispatcher interlock.
    actual = runtime.request("status")["result"]
    old = runtime.local("observe")
    assert old["legacy_enabled"] is legacy and actual["dispatch_enabled"] is new
    assert not (legacy and new)
    assert actual["publisher_id"] == PUBLISHER
    assert actual["dispatcher"]["playback_verification"] == "unavailable"
    if actual["active_revision"] is not None:
        assert actual["persistence"] == "healthy" and len(actual["active_checksum"]) == 64
    print(
        json.dumps(
            {
                "step": label,
                "legacy": legacy,
                "new": new,
                "publisher_id": actual["publisher_id"],
                "revision": actual["active_revision"],
                "checksum": actual["active_checksum"],
                "persistence": actual["persistence"],
            },
            sort_keys=True,
        )
    )
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


async def source_review(client: Client) -> None:
    source = json.dumps({"variables": {"tags": LEGACY_MAPPINGS}}, ensure_ascii=False)
    report = await client.request(
        "POST",
        "imports/preview",
        {
            "source": "upload",
            "format": "json",
            "content": source,
        },
    )
    assert report["fingerprint"] == hashlib.sha256(source.encode()).hexdigest()
    excluded = [row for row in report["rows"] if not row["accepted"]]
    assert len(excluded) == 1 and excluded[0]["ha_tag_id"] == TRACK
    assert "unsupported_media_type" in excluded[0]["diagnostics"]
    changed = await client.request(
        "POST",
        "imports/preview",
        {
            "source": "upload",
            "format": "json",
            "content": source + "\n",
            "expected_fingerprint": report["fingerprint"],
        },
    )
    assert changed["source_changed"] and changed["fingerprint"] != report["fingerprint"]
    # Even whitespace changes invalidate the reviewed source. No stale import occurs.
    async with client.http.post(
        client.app.origin + "/api/v1/imports/confirm",
        headers=client.headers,
        json={
            "source": "upload",
            "format": "json",
            "content": source + "\n",
            "fingerprint": report["fingerprint"],
            "preview_token": report["preview_token"],
            "conflict_policy": "reject",
            "enabled": True,
            "shuffle": False,
            "playback_profile_id": "default",
        },
    ) as response:
        assert response.status == 409
    print(
        "PASS synthetic source fingerprint change rejected; excluded legacy track remains visible"
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
    runtime = MigrationRuntime(ha_dir, ha_port)
    app: App | None = None
    client: Client | None = None
    try:
        token = runtime.local("app_connection")["token"]
        app = App(app_dir, ha_port, token, app_port)
        client = Client(app, secret)
        await client.login()
        await client.status()
        await source_review(client)
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
        print("PASS both shuffle conflicts visible; only explicit versioned app edits resolve them")
        runtime.local("legacy", enabled=True)
        observe(runtime, "legacy baseline", legacy=True, new=False)
        await client.publish()
        status = await settled(client)
        published = observe(runtime, "disabled publication", legacy=True, new=False)
        assert published["active_revision"] == 1
        assert published["active_checksum"] == status["desired_checksum"]
        assert not status["automatic_enabled"]
        app_command("-m", "jukelet.backup", "backup", str(database), str(app_dir / "backup.db"))
        assert runtime.request("configure_dispatch", profiles={"default": SCRIPT})["success"]
        observe(runtime, "configured disabled", legacy=True, new=False)
        assert runtime.request("dispatch", action="reconcile", confirmed_stopped=True)["success"]
        observe(runtime, "reviewed inert work stopped", legacy=True, new=False)
        runtime.local("legacy", enabled=False)
        observe(runtime, "legacy disabled before cutover", legacy=False, new=False)
        assert runtime.request("dispatch", action="enable")["success"]
        observe(runtime, "new enabled", legacy=False, new=True)
        event = {"tag_id": ALBUM, "device_id": "Synthetic reader Å"}
        captures = runtime.local("scan", events=[event, {**event, "tag_id": PLAYLIST}])["captures"]
        assert len(captures) == 1 and captures[0]["route"] == "new"
        request = captures[0]["request"]
        assert request["tag_id"] == ALBUM and request["reader_id"] == event["device_id"]
        assert request["snapshot_revision"] == 1 and request["shuffle"] is False
        runtime.local("scan", events=[event])
        for tag in ("Synthetic unknown", "Synthetic registered unassigned", DISABLED, TRACK):
            assert len(runtime.local("scan", events=[{**event, "tag_id": tag}])["captures"]) == 1
        captures = runtime.local("scan", events=[{**event, "tag_id": PLAYLIST}])["captures"]
        assert len(captures) == 2 and captures[1]["request"]["shuffle"] is True
        diagnostics = runtime.request("status")["result"]["dispatcher"]["diagnostics"]
        assert {"ignored_busy", "ignored_duplicate", "rejected_mapping"} <= {
            row["reason"] for row in diagnostics
        }
        print(
            "PASS exact IDs, album/playlist, unknown/unmapped/disabled/excluded, busy and duplicate"
        )
        # This opt-in is a distinct, reviewed synthetic step after cutover checks.
        await client.publish("activate")
        assert (await settled(client))["automatic_enabled"]
        await save(client, ALBUM, "album", "B", version=2)
        assert (await settled(client))["active_revision"] == 2
        observe(runtime, "separate automatic opt-in", legacy=False, new=True)
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
        before_restart = observe(runtime, "app stopped inert invocation", legacy=False, new=True)
        pid = runtime.ready["pid"]
        runtime.close()
        runtime = MigrationRuntime(ha_dir, ha_port)
        assert runtime.ready["pid"] != pid
        restarted = observe(runtime, "actual HA restart disabled", legacy=False, new=False)
        for field in ("publisher_id", "active_revision", "active_checksum", "persistence"):
            assert restarted[field] == before_restart[field]
        assert runtime.local("scan", events=[event])["captures"] == []
        assert (
            restarted["dispatcher"]["ready"] and not restarted["dispatcher"]["execution_uncertain"]
        )
        assert runtime.request("dispatch", action="enable")["success"]
        observe(runtime, "explicit readiness review and re-enable", legacy=False, new=True)
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
        observe(runtime, "automatic suspended and jobs drained", legacy=False, new=True)
        assert runtime.request("dispatch", action="disable")["success"]
        observe(runtime, "rollback new disabled first", legacy=False, new=False)
        assert not runtime.request("status")["result"]["dispatcher"]["busy"]
        runtime.local("legacy", enabled=True)
        final = observe(runtime, "rollback final legacy enabled", legacy=True, new=False)
        captures = runtime.local("scan", events=[event])["captures"]
        assert len(captures) == 2 and captures[-1]["route"] == "legacy"
        assert final["active_revision"] == 2 and not (await settled(client))["automatic_enabled"]
        print(
            "PASS rollback: single inert legacy dispatcher; new disabled; automatic suspended; "
            "legacy album A differs from app album B; excluded track remains legacy-only"
        )
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
                            "companion/migration_probe.py",
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
    with tempfile.TemporaryDirectory(prefix="jukelet-migration-") as temporary:
        asyncio.run(run(Path(temporary)))


if __name__ == "__main__":
    main()
