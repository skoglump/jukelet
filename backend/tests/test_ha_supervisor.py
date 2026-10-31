"""Synthetic Supervisor wire contracts over local HTTP and WebSocket sockets.

Only test socket routing maps the fixed Supervisor hostname/port to loopback.
The production URLs, real clients, request paths and credentials are exercised.
This is not evidence of permissions or custom-command support in actual HA OS.
"""

import asyncio
import json
import logging
import socket
from dataclasses import replace
from typing import Any

import httpx
import pytest
from test_ha_adapter import until
from websockets.asyncio.server import ServerConnection, serve
from websockets.http11 import Request, Response

from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.main import create_app

TOKEN = "synthetic-supervisor-credential-not-for-real-use"
TAG = "  Opaque:Å/synthetic  "
SERVER_LOGGER = logging.Logger("synthetic.supervisor.wire")
SERVER_LOGGER.disabled = True


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def resolve_supervisor(monkeypatch: pytest.MonkeyPatch, port: int) -> None:
    original = socket.getaddrinfo
    original_connect = socket.socket.connect

    def resolve(host: Any, service: Any, *args: Any, **kwargs: Any) -> Any:
        if host in {"supervisor", b"supervisor"}:
            assert service == 80
            return original("127.0.0.1", port, *args, **kwargs)
        return original(host, service, *args, **kwargs)

    def connect(stream: socket.socket, address: Any) -> Any:
        # AnyIO retains the requested port after resolving the hostname, while
        # asyncio's WebSocket dialer uses the address returned by getaddrinfo.
        if address == ("127.0.0.1", 80):
            address = ("127.0.0.1", port)
        return original_connect(stream, address)

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    monkeypatch.setattr(socket.socket, "connect", connect)


@pytest.mark.anyio
async def test_supervisor_lifespan_uses_fixed_routes_and_service_credential(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    requests: list[tuple[str, str]] = []
    websocket_paths: list[str] = []
    commands: list[dict[str, Any]] = []

    async def http(connection: ServerConnection, request: Request) -> Response | None:
        if request.headers.get("Upgrade", "").lower() == "websocket":
            websocket_paths.append(request.path)
            assert request.path == "/core/websocket"
            assert "Authorization" not in request.headers
            return None
        requests.append((request.path, request.headers.get("Authorization", "")))
        assert request.path in {"/core/api/config", "/core/api/services"}
        assert request.headers.get("Authorization") == f"Bearer {TOKEN}"
        return connection.respond(
            200,
            json.dumps({"version": "2026.10.4"} if request.path.endswith("/config") else []),
        )

    async def websocket(connection: ServerConnection) -> None:
        await connection.send(json.dumps({"type": "auth_required"}))
        assert json.loads(await connection.recv()) == {"type": "auth", "access_token": TOKEN}
        await connection.send(json.dumps({"type": "auth_ok"}))
        async for raw in connection:
            message = json.loads(raw)
            commands.append(message)
            if message["type"] in {"tag/list", "subscribe_events"}:
                result: dict[str, Any] = {
                    "success": True,
                    "result": [{"id": TAG, "name": "Synthetic tag"}]
                    if message["type"] == "tag/list"
                    else None,
                }
            else:
                # This bounded fixture has no bridge; no command is executed.
                result = {"success": False, "error": {"code": "unknown_command"}}
            await connection.send(json.dumps({"id": message["id"], "type": "result", **result}))

    caplog.set_level(logging.DEBUG)
    async with serve(
        websocket, "127.0.0.1", 0, process_request=http, logger=SERVER_LOGGER
    ) as listener:
        resolve_supervisor(monkeypatch, listener.sockets[0].getsockname()[1])
        app = create_app(replace(settings, ha_transport="supervisor", supervisor_token=TOKEN))
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url=settings.public_origin
            ) as client,
        ):
            # A working backend service credential never establishes browser authority.
            assert (
                await client.get("/api/v1/status", headers={"Authorization": f"Bearer {TOKEN}"})
            ).status_code == 401
            login = await client.post(
                "/api/v1/session",
                json={"secret": settings.auth_secret.decode()},
                headers={"Origin": settings.public_origin},
            )
            assert login.status_code == 200
            await until(
                lambda: len(requests) == 2 and any(c["type"] == "tag/list" for c in commands)
            )
            status = (await client.get("/api/v1/status")).json()
            assert status["connection"] == "connected" and status["mode"] == "read_only"
            assert status["version"] == "2026.10.4"
            assert status["subscribed"]
            tags = (await client.get("/api/v1/tags")).json()
            assert tags["tags"][0]["ha_tag_id"] == TAG
            assert TOKEN not in json.dumps(status)
            assert TOKEN not in login.text
        assert requests == [
            ("/core/api/config", f"Bearer {TOKEN}"),
            ("/core/api/services", f"Bearer {TOKEN}"),
        ]
        assert websocket_paths == ["/core/websocket"]
        assert commands[0] == {"id": 1, "type": "subscribe_events", "event_type": "tag_scanned"}
    assert TOKEN not in caplog.text


@pytest.mark.anyio
@pytest.mark.parametrize("rejection", ["auth_invalid", "rest401", "upgrade401", "upgrade403"])
async def test_supervisor_rejection_is_terminal_and_redacted(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    rejection: str,
) -> None:
    upgrades: list[str] = []
    requests: list[str] = []
    retries: list[float] = []

    async def http(connection: ServerConnection, request: Request) -> Response | None:
        if request.headers.get("Upgrade", "").lower() == "websocket":
            upgrades.append(request.path)
            if rejection.startswith("upgrade"):
                return connection.respond(int(rejection[-3:]), f"PRIVATE {TOKEN}")
            return None
        requests.append(request.path)
        assert rejection == "rest401"
        assert request.headers.get("Authorization") == f"Bearer {TOKEN}"
        return connection.respond(401, f"PRIVATE {TOKEN}")

    async def websocket(connection: ServerConnection) -> None:
        await connection.send(json.dumps({"type": "auth_required"}))
        assert json.loads(await connection.recv()) == {"type": "auth", "access_token": TOKEN}
        await connection.send(
            json.dumps(
                {"type": "auth_invalid", "message": f"PRIVATE {TOKEN}"}
                if rejection == "auth_invalid"
                else {"type": "auth_ok"}
            )
        )
        await connection.wait_closed()

    async def backoff(delay: float) -> None:
        retries.append(delay)
        await asyncio.Event().wait()

    caplog.set_level(logging.DEBUG)
    async with serve(
        websocket, "127.0.0.1", 0, process_request=http, logger=SERVER_LOGGER
    ) as listener:
        resolve_supervisor(monkeypatch, listener.sockets[0].getsockname()[1])
        adapter = HAAdapter(
            replace(settings, ha_transport="supervisor", supervisor_token=TOKEN).ha_connection,
            sleep=backoff,
        )
        adapter.start()
        try:
            await until(lambda: adapter.status.connection == "unauthorized")
            assert adapter.status.error == (
                "forbidden" if rejection == "upgrade403" else "unauthorized"
            )
            assert adapter._task is not None and adapter._task.done()
            assert upgrades == ["/core/websocket"]
            assert requests == (["/core/api/config"] if rejection == "rest401" else [])
            assert retries == []
            assert TOKEN not in adapter.snapshot().model_dump_json()
            assert "PRIVATE" not in adapter.snapshot().model_dump_json()
        finally:
            await adapter.close()
    assert TOKEN not in caplog.text
    assert "PRIVATE" not in caplog.text
