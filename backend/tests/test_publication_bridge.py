"""Authenticated app API -> real HA WebSocket adapter -> supported companion.

Only loopback, generated SQLite state and synthetic in-memory bridge stores.
The command allowlist refuses dispatch, playback, automation and scan operations.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import replace
from typing import Any, cast

import httpx
import pytest
from sqlalchemy import text
from test_assignments import TAG, payload
from websockets.asyncio.server import ServerConnection, serve

from companion.custom_components.jukelet_bridge.bridge import Bridge
from companion.custom_components.jukelet_bridge.protocol import ProtocolError
from companion.tests.fixtures import MemoryStore
from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.ha.rest import RestClient
from jukelet.inventory import tag_key
from jukelet.main import create_app
from jukelet.storage import migrate, open_database


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class Fixture:
    def __init__(self, publisher: str) -> None:
        self.bridge = Bridge(publisher, MemoryStore(), lambda: False, MemoryStore())
        self.commands: list[str] = []
        self.payloads: list[dict[str, Any]] = []
        self.name = "Synthetic label"
        self.rename_error = False
        self.reject: str | None = None
        self.drop = False
        self.drop_before_commit = False
        self.delay = False
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.override: dict[str, Any] = {}

    async def server(self, socket: ServerConnection) -> None:
        await socket.send(json.dumps({"type": "auth_required"}))
        assert json.loads(await socket.recv()) == {
            "type": "auth",
            "access_token": "synthetic-token",
        }
        await socket.send(json.dumps({"type": "auth_ok"}))
        async for raw in socket:
            message = json.loads(raw)
            operation = message["type"]
            assert operation in {
                "tag/list",
                "tag/update",
                "subscribe_events",
                "jukelet_bridge/status",
                "jukelet_bridge/publish",
            }
            self.commands.append(operation)
            try:
                result: Any = None
                if operation == "tag/list":
                    result = [{"id": TAG, "name": self.name}]
                elif operation == "tag/update":
                    if self.rename_error:
                        raise ProtocolError("unauthorized")
                    assert message["tag_id"] == TAG
                    self.name = message["name"]
                elif operation == "jukelet_bridge/status":
                    result = {**await self.bridge.status(), **self.override}
                    assert result["dispatch_enabled"] is False
                elif operation == "jukelet_bridge/publish":
                    self.payloads.append(message["snapshot"])
                    if self.reject:
                        raise ProtocolError(self.reject)
                    self.entered.set()
                    if self.delay:
                        await self.release.wait()
                    if self.drop_before_commit:
                        self.drop_before_commit = False
                        await socket.close()
                        return
                    result = await self.bridge.publish(message["snapshot"])
                    if self.drop:
                        self.drop = False
                        await socket.close()
                        return
                await socket.send(
                    json.dumps(
                        {"id": message["id"], "type": "result", "success": True, "result": result}
                    )
                )
            except ProtocolError as error:
                await socket.send(
                    json.dumps(
                        {
                            "id": message["id"],
                            "type": "result",
                            "success": False,
                            "error": {"code": error.code},
                        }
                    )
                )


@asynccontextmanager
async def fixture(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, existing: Fixture | None = None
) -> AsyncIterator[tuple[httpx.AsyncClient, Fixture, dict[str, str]]]:
    engine = open_database(settings.database_path)
    migrate(engine)
    with engine.connect() as connection:
        publisher = str(connection.scalar(text("SELECT publisher_id FROM recovery_state")))
    engine.dispose()
    fake = existing or Fixture(publisher)
    if existing is None:
        await fake.bridge.initialize()
    async with serve(fake.server, "127.0.0.1", 0) as listener:
        origin = f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}"

        async def backoff(delay: float) -> None:
            await asyncio.sleep(0.01)

        adapter = HAAdapter(
            origin,
            "synthetic-token",
            timeout=0.3,
            sleep=backoff,
            rest=RestClient(
                origin,
                "synthetic-token",
                transport=httpx.MockTransport(
                    lambda request: httpx.Response(
                        200,
                        json={"version": "2026.10.2"} if request.url.path == "/api/config" else [],
                    )
                ),
            ),
        )
        monkeypatch.setattr("jukelet.main.HAAdapter", lambda *args, **kwargs: adapter)
        app = create_app(replace(settings, mode="manage"))
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url=settings.public_origin
            ) as client,
        ):
            response = await client.post(
                "/api/v1/session",
                json={"secret": settings.auth_secret.decode()},
                headers={"Origin": settings.public_origin},
            )
            headers = {
                "Origin": settings.public_origin,
                "X-CSRF-Token": response.json()["csrf_token"],
            }
            async with asyncio.timeout(4):
                while not (await client.get("/api/v1/publication")).json()["healthy"]:
                    # Existing restored/foreign fixtures deliberately never become healthy.
                    if existing:
                        break
                    await asyncio.sleep(0.01)
            yield client, fake, headers


async def save(
    client: httpx.AsyncClient, headers: dict[str, str], version: int = 0, **changes: Any
) -> None:
    value = {**payload(version), "enabled": True, "shuffle": False, **changes}
    response = await client.put(
        f"/api/v1/tags/{tag_key(str(value['ha_tag_id']))}/assignment", json=value, headers=headers
    )
    assert response.status_code == 200, response.text


async def reviewed(
    client: httpx.AsyncClient, headers: dict[str, str], action: str = "publish", **confirmation: Any
) -> httpx.Response:
    response = await client.post(
        "/api/v1/publication/review", json={"action": action}, headers=headers
    )
    assert response.status_code == 200, response.text
    return await client.post(
        "/api/v1/publication/confirm",
        json={"review_token": response.json()["review_token"], "confirmed": True, **confirmation},
        headers=headers,
    )


async def until(client: httpx.AsyncClient, predicate: Any) -> dict[str, Any]:
    async with asyncio.timeout(6):
        while True:
            status = (await client.get("/api/v1/publication")).json()
            if predicate(status):
                return cast(dict[str, Any], status)
            await asyncio.sleep(0.025)


@pytest.mark.anyio
async def test_verified_publish_lost_response_and_concurrent_newer_edit(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with fixture(settings, monkeypatch) as (client, fake, headers):
        await save(client, headers)
        fake.delay, fake.drop = True, True
        assert (await reviewed(client, headers)).status_code == 200
        await asyncio.wait_for(fake.entered.wait(), 3)
        await save(client, headers, 1, input="spotify:album:" + "B" * 22)
        fake.release.set()
        status = await until(
            client, lambda row: row["active_revision"] == 1 and not row["actual_stale"]
        )
        assert status["desired_version"] == 2 and status["active_desired_version"] == 1
        assert status["verified"] is False
        assert len(fake.payloads) == 1
        assert fake.payloads[0]["payload"]["mappings"][0]["spotify_uri"] == payload()["input"]
        assert (await reviewed(client, headers)).status_code == 200
        status = await until(client, lambda row: row["verified"])
        assert status["active_revision"] == 2
        assert status["actual"]["dispatch_enabled"] is False and status["playback_verified"] is None
        assert fake.commands.index("jukelet_bridge/status") < fake.commands.index(
            "jukelet_bridge/publish"
        )


@pytest.mark.anyio
async def test_explicit_persistent_activation_auto_saves_empty_confirmation_and_pending_removals(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with fixture(settings, monkeypatch) as (client, fake, headers):
        await save(client, headers)
        await asyncio.sleep(1.05)
        assert not fake.payloads, "Existing saves must never publish implicitly"
        assert (await reviewed(client, headers)).status_code == 200
        await until(client, lambda row: row["verified"])
        missing = await reviewed(client, headers, "activate")
        assert missing.json()["detail"]["code"] == "migration_attestation_required"
        assert (
            await reviewed(client, headers, "activate", migration_attested=True)
        ).status_code == 200
        await save(client, headers, 1, enabled=False)
        status = (await client.get("/api/v1/publication")).json()
        assert status["pending_removals"] == [payload()["ha_tag_id"]]
        await until(client, lambda row: row["verified"])
        assert (
            await client.request(
                "DELETE",
                f"/api/v1/tags/{tag_key(str(payload()['ha_tag_id']))}/assignment",
                json={"expected_version": 2},
                headers=headers,
            )
        ).status_code == 200
        status = (await client.get("/api/v1/publication")).json()
        assert len(fake.payloads) == 2 and status["verified"] is False
        assert (await reviewed(client, headers)).json()["detail"][
            "code"
        ] == "empty_confirmation_required"
        assert (await reviewed(client, headers, confirm_empty=True)).status_code == 200
        await until(client, lambda row: row["verified"])
    async with fixture(settings, monkeypatch, fake) as (client, fake, headers):
        status = await until(client, lambda row: row["healthy"])
        assert status["automatic_enabled"] is True and status["active_revision"] == 3


@pytest.mark.anyio
async def test_stale_review_foreign_degraded_and_restore_guard_never_clear_implicitly(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with fixture(settings, monkeypatch) as (client, fake, headers):
        await save(client, headers)
        review = (
            await client.post(
                "/api/v1/publication/review", json={"action": "publish"}, headers=headers
            )
        ).json()
        await save(client, headers, 1)
        response = await client.post(
            "/api/v1/publication/confirm",
            json={"review_token": review["review_token"], "confirmed": True},
            headers=headers,
        )
        assert response.status_code == 409 and response.json()["detail"]["code"] == "review_stale"
        assert (await reviewed(client, headers)).status_code == 200
        await until(client, lambda row: row["verified"])
        original = await fake.bridge.status()
        for changed in (
            {"publisher_id": "00000000-0000-4000-8000-000000000999"},
            {"persistence": "degraded"},
            {"active_checksum": "f" * 64},
            {"active_revision": 100},
        ):
            fake.override = changed
            status = (await client.get("/api/v1/publication")).json()
            assert status["reconciliation_required"] and not status["verified"]
            assert not status["automatic_enabled"]
            assert (
                await client.post(
                    "/api/v1/publication/review", json={"action": "publish"}, headers=headers
                )
            ).status_code == 409
        fake.override = {}
        status = (await client.get("/api/v1/publication")).json()
        assert status["reconciliation_required"], (
            "Matching readback alone must not clear durable guard"
        )
        assert (await reviewed(client, headers, "recover")).status_code == 200
        status = await until(client, lambda row: row["verified"])
        assert status["active_revision"] > int(original["active_revision"])
        assert not status["reconciliation_required"]


@pytest.mark.anyio
async def test_restart_uncertain_retry_requires_actual_base_and_reuses_exact_payload(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with fixture(settings, monkeypatch) as (client, fake, headers):
        await save(client, headers)
        fake.drop_before_commit = True
        assert (await reviewed(client, headers)).status_code == 200
        status = await until(client, lambda row: row["verified"])
        assert status["active_revision"] == 1
        assert len(fake.payloads) == 2 and fake.payloads[0] == fake.payloads[1]
        publish_indices = [
            i for i, value in enumerate(fake.commands) if value == "jukelet_bridge/publish"
        ]
        assert "jukelet_bridge/status" in fake.commands[publish_indices[0] + 1 : publish_indices[1]]
        await save(client, headers, 1, input="spotify:album:" + "C" * 22)
        assert (await reviewed(client, headers)).status_code == 200
        # Queue is durable even if the management app stops before it is sent.
    async with fixture(settings, monkeypatch, fake) as (client, fake, headers):
        status = await until(client, lambda row: row["verified"])
        assert status["active_revision"] == 2
        assert fake.payloads[-1]["payload"]["mappings"][0]["spotify_uri"].endswith("C" * 22)


@pytest.mark.anyio
async def test_app_and_ha_restore_matrix_and_revision_high_water(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    import copy
    from pathlib import Path

    from jukelet.backup import copy_database

    # Capture a coherent app and HA state, advance, then restore each side separately.
    async with fixture(settings, monkeypatch) as (client, fake, headers):
        await save(client, headers)
        assert (await reviewed(client, headers)).status_code == 200
        await until(client, lambda row: row["verified"])
        old_snapshot, old_history = (
            copy.deepcopy(fake.bridge.store.data),
            copy.deepcopy(fake.bridge.history.data),
        )
    app_backup = Path(str(settings.database_path) + ".backup")
    copy_database(settings.database_path, app_backup, recover=False)
    async with fixture(settings, monkeypatch, fake) as (client, fake, headers):
        await until(client, lambda row: row["healthy"])
        await save(client, headers, 1, input="spotify:album:" + "D" * 22)
        assert (await reviewed(client, headers)).status_code == 200
        await until(client, lambda row: row["verified"])
    # Restore only the older app. HA is ahead: guard survives app restart.
    import shutil

    shutil.copyfile(app_backup, settings.database_path)
    async with fixture(settings, monkeypatch, fake) as (client, fake, headers):
        status = await until(client, lambda row: row["reconciliation_required"])
        assert not status["automatic_enabled"] and len(fake.payloads) == 2
        assert (await reviewed(client, headers, "recover")).status_code == 200
        status = await until(client, lambda row: row["verified"])
        assert status["active_revision"] == 3
        fake.bridge.store.data, fake.bridge.history.data = old_snapshot, old_history
        await fake.bridge.start()
        status = (await client.get("/api/v1/publication")).json()
        assert status["reconciliation_required"]
        assert (await reviewed(client, headers, "recover")).status_code == 200
        status = await until(client, lambda row: row["verified"])
        assert status["active_revision"] == 4
        # Fresh-looking paired bridge must not reset an established app's history.
        fake.bridge = Bridge(fake.bridge.publisher, MemoryStore(), lambda: False, MemoryStore())
        await fake.bridge.initialize()
        status = (await client.get("/api/v1/publication")).json()
        assert status["reconciliation_required"] and len(fake.payloads) == 4
        assert (await reviewed(client, headers, "recover")).status_code == 200
        assert (await until(client, lambda row: row["verified"]))["active_revision"] == 5


@pytest.mark.anyio
async def test_new_restore_during_recovery_cannot_be_cleared_by_older_completion(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with fixture(settings, monkeypatch) as (client, fake, headers):
        await save(client, headers)
        assert (await reviewed(client, headers)).status_code == 200
        await until(client, lambda row: row["verified"])
        export = (await client.get("/api/v1/export")).json()

        async def restore() -> None:
            response = await client.post(
                "/api/v1/restores/preview", json={"document": export}, headers=headers
            )
            assert response.status_code == 200
            response = await client.post(
                "/api/v1/restores/confirm",
                json={
                    "preview_token": response.json()["preview_token"],
                    "conflict_policy": "replace",
                    "confirmed": True,
                },
                headers=headers,
            )
            assert response.status_code == 200

        await restore()
        fake.delay = True
        fake.entered.clear()
        assert (await reviewed(client, headers, "recover")).status_code == 200
        await asyncio.wait_for(fake.entered.wait(), 3)
        await restore()
        fake.release.set()
        status = await until(client, lambda row: row["active_revision"] == 2)
        assert status["reconciliation_required"] and not status["verified"]
        assert status["active_desired_version"] != status["desired_version"]
        assert (await reviewed(client, headers, "recover")).status_code == 200
        status = await until(client, lambda row: row["verified"])
        assert status["active_revision"] == 3 and not status["reconciliation_required"]


@pytest.mark.anyio
async def test_malformed_telemetry_and_shuffle_conflicts_never_imply_activation(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with fixture(settings, monkeypatch) as (client, fake, headers):
        await save(client, headers, shuffle=True)
        assert (await reviewed(client, headers)).status_code == 200
        status = await until(client, lambda row: row["verified"])
        assert status["shuffle_conflict"]
        response = await client.post(
            "/api/v1/publication/review", json={"action": "activate"}, headers=headers
        )
        assert (
            response.status_code == 409 and response.json()["detail"]["code"] == "shuffle_conflict"
        )
        for changed in (
            {"active_revision": True},
            {"dispatch_enabled": "false"},
            {"schema_version": True},
            {"active_checksum": None},
        ):
            fake.override = changed
            status = (await client.get("/api/v1/publication")).json()
            assert status["actual_stale"] and not status["verified"]
            assert status["playback_verified"] is None
            assert (
                await client.post(
                    "/api/v1/publication/review", json={"action": "publish"}, headers=headers
                )
            ).status_code == 409
        fake.override = {}
        assert (await client.get("/api/v1/publication")).json()["verified"]


@pytest.mark.anyio
async def test_known_protocol_rejection_is_visible_and_never_retried(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with fixture(settings, monkeypatch) as (client, fake, headers):
        await save(client, headers)
        fake.reject = "invalid_snapshot"
        assert (await reviewed(client, headers)).status_code == 200
        status = await until(client, lambda row: row["reconciliation_required"])
        assert status["error"] == "invalid_snapshot"
        await asyncio.sleep(1.1)
        status = (await client.get("/api/v1/publication")).json()
        assert len(fake.payloads) == 1 and status["error"] == "invalid_snapshot"
        assert status["jobs"][0]["state"] == "fenced"


@pytest.mark.anyio
async def test_rename_and_publication_keep_independent_success_and_failure(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    async with fixture(settings, monkeypatch) as (client, fake, headers):
        await save(client, headers)
        assert (await reviewed(client, headers)).status_code == 200
        await until(client, lambda row: row["verified"])
        path = f"/api/v1/tags/{tag_key(TAG)}/name"
        rename = {"ha_tag_id": TAG, "expected_name": "Synthetic label", "name": "Renamed label"}
        fake.rename_error = True
        assert (await client.patch(path, json=rename, headers=headers)).status_code == 403
        assert (await client.get("/api/v1/publication")).json()["verified"]
        fake.rename_error = False
        response = await client.patch(path, json=rename, headers=headers)
        assert response.status_code == 200 and response.json()["state"] == "verified"
        await save(client, headers, 1, input="spotify:album:" + "F" * 22)
        fake.reject = "invalid_snapshot"
        assert (await reviewed(client, headers)).status_code == 200
        await until(client, lambda row: row["reconciliation_required"])
        assert (await client.get(path)).json()["name"] == "Renamed label"
        assert (
            (await client.get(f"/api/v1/tags/{tag_key(TAG)}/assignment"))
            .json()["assignment"]["spotify_uri"]
            .endswith("F" * 22)
        )
