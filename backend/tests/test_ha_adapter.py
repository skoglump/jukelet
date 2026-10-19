"""A local synthetic WebSocket server exercises the actual wire lifecycle."""

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import HAError
from jukelet.ha.rest import RestClient


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def until(predicate: Callable[[], bool]) -> None:
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0.005)


async def authenticate(socket: ServerConnection, reject: bool = False) -> None:
    await socket.send(json.dumps({"type": "auth_required", "ha_version": "2026.10.1"}))
    auth = json.loads(await socket.recv())
    assert auth == {"type": "auth", "access_token": "synthetic-token"}
    await socket.send(json.dumps({"type": "auth_invalid" if reject else "auth_ok"}))


def rest_fixture() -> RestClient:
    return RestClient(
        "http://ha.example",
        "synthetic-token",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json={"version": "2026.10.1", "private": "PRIVATE"}
                if request.url.path == "/api/config"
                else [],
            )
        ),
    )


@pytest.mark.anyio
async def test_reconnect_restores_subscription_inventory_and_preserves_ids() -> None:
    connections = 0
    commands: list[dict[str, Any]] = []
    release = asyncio.Event()

    async def server(socket: ServerConnection) -> None:
        nonlocal connections
        connections += 1
        generation = connections
        await authenticate(socket)
        async for raw in socket:
            message = json.loads(raw)
            commands.append(message)
            result: Any = (
                None
                if message["type"] == "subscribe_events"
                else [{"id": "  Opaque:Å/01  ", "name": f"Synthetic {generation}"}]
            )
            await socket.send(
                json.dumps(
                    {"id": message["id"], "type": "result", "success": True, "result": result}
                )
            )
            if message["type"] == "tag/list" and generation == 1:
                await release.wait()
                await socket.close()

    async with serve(server, "127.0.0.1", 0) as listener:
        origin = f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}"
        delays = []

        async def backoff(delay: float) -> None:
            delays.append(delay)
            await asyncio.sleep(0.01)

        adapter = HAAdapter(origin, "synthetic-token", rest=rest_fixture(), sleep=backoff)
        adapter.start()
        task = adapter._task
        adapter.start()
        assert adapter._task is task
        await until(lambda: adapter.status.inventory_updated_at is not None)
        assert adapter.inventory[0].id == "  Opaque:Å/01  "
        release.set()
        await until(
            lambda: len(adapter.inventory) == 1 and adapter.inventory[0].name == "Synthetic 2"
        )
        assert [item["type"] for item in commands] == ["subscribe_events", "tag/list"] * 2
        assert adapter.status.subscribed
        with pytest.raises(HAError, match="unsupported_operation"):
            await adapter.command("subscribe_scans")
        assert adapter.status.discovery_gap
        assert not adapter.status.inventory_stale
        assert len(delays) == 1 and 0.5 <= delays[0] <= 1.0
        assert "PRIVATE" not in adapter.snapshot().model_dump_json()
        await adapter.close()
        assert task is not None and task.done()
        assert adapter._pending == {}


@pytest.mark.anyio
async def test_auth_rejection_stops_retries_and_no_leak() -> None:
    count = 0

    async def server(socket: ServerConnection) -> None:
        nonlocal count
        count += 1
        await authenticate(socket, reject=True)

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
        )
        adapter.start()
        await until(lambda: adapter.status.connection == "unauthorized")
        await asyncio.sleep(0.02)
        assert count == 1
        assert "synthetic-token" not in adapter.snapshot().model_dump_json()
        await adapter.close()


@pytest.mark.anyio
async def test_correlation_deadlines_late_results_and_shutdown() -> None:
    waiting: list[dict[str, Any]] = []
    socket_ready: list[ServerConnection] = []

    async def server(socket: ServerConnection) -> None:
        socket_ready.append(socket)
        await authenticate(socket)
        async for raw in socket:
            message = json.loads(raw)
            if message["id"] <= 2:
                await socket.send(
                    json.dumps(
                        {
                            "type": "result",
                            "id": message["id"],
                            "success": True,
                            "result": [] if message["type"] == "tag/list" else None,
                        }
                    )
                )
            else:
                waiting.append(message)

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
            timeout=0.2,
        )
        adapter.start()
        await until(lambda: adapter.status.inventory_updated_at is not None)
        one = asyncio.create_task(adapter.command("tag/list"))
        two = asyncio.create_task(adapter.command("tag/list"))
        await until(lambda: len(waiting) == 2)
        for message in reversed(waiting):
            await socket_ready[0].send(
                json.dumps(
                    {
                        "type": "result",
                        "id": message["id"],
                        "success": True,
                        "result": message["id"],
                    }
                )
            )
        assert await one == 3
        assert await two == 4
        with pytest.raises(HAError, match="timeout"):
            await adapter.command("tag/list")
        assert not adapter._pending
        await socket_ready[0].send(
            json.dumps({"type": "result", "id": 5, "success": True, "result": "late"})
        )
        for name in (
            "tag/update",
            "tag/create",
            "tag/delete",
            "call_service",
            "fire_event",
            "config/automation",
        ):
            with pytest.raises(HAError, match="unsupported_operation"):
                await adapter.command(name)
        pending = [asyncio.create_task(adapter.command("tag/list")) for _ in range(40)]
        await until(lambda: len(adapter._pending) == 32)
        await adapter.close()
        results = await asyncio.gather(*pending, return_exceptions=True)
        assert all(isinstance(result, HAError) for result in results)
        assert not adapter._pending


@pytest.mark.anyio
async def test_queue_overflow_refreshes_and_malformed_inventory_keeps_last_good() -> None:
    scans_sent = asyncio.Event()
    inventory_reads = 0

    async def server(socket: ServerConnection) -> None:
        nonlocal inventory_reads
        subscription = 0
        await authenticate(socket)
        async for raw in socket:
            message = json.loads(raw)
            if message["type"] == "subscribe_events":
                subscription = message["id"]
                result: Any = None
            else:
                inventory_reads += 1
                result = [{"id": "Exact-ID"}] if inventory_reads == 1 else [{"id": 123}]
            await socket.send(
                json.dumps(
                    {"type": "result", "id": message["id"], "success": True, "result": result}
                )
            )
            if inventory_reads == 1 and not scans_sent.is_set():
                scans_sent.set()
                for i in range(130):
                    await socket.send(
                        json.dumps(
                            {
                                "type": "event",
                                "id": subscription,
                                "event": {
                                    "event_type": "tag_scanned",
                                    "data": {"tag_id": f" Synthetic {i} "},
                                },
                            }
                        )
                    )

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
        )
        adapter.start()
        await until(lambda: adapter.status.error == "unsupported_response")
        assert adapter.status.discovery_gap and adapter.status.inventory_stale
        assert adapter.scans.qsize() == 128
        assert adapter.inventory[0].id == "Exact-ID"
        assert adapter.status.inventory_updated_at is not None
        assert inventory_reads >= 2
        await adapter.close()


@pytest.mark.anyio
async def test_websocket_redirect_never_followed() -> None:
    requests = 0

    async def process(socket: ServerConnection, request: Any) -> Response:
        nonlocal requests
        requests += 1
        return Response(302, "Found", Headers({"Location": "ws://127.0.0.1:1/private"}))

    async def handler(socket: ServerConnection) -> None:
        raise AssertionError("Redirect must not complete handshake")

    async def no_retry(_: float) -> None:
        await asyncio.Event().wait()

    async with serve(handler, "127.0.0.1", 0, process_request=process) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
            sleep=no_retry,
        )
        adapter.start()
        await until(lambda: adapter.status.connection == "disconnected")
        assert requests == 1
        await adapter.close()


@pytest.mark.anyio
@pytest.mark.parametrize(
    "payload", ["invalid JSON", "[]", '{"type":"result","id":true}', "x" * (4 * 1024 * 1024 + 1)]
)
async def test_bad_websocket_frames_disconnect_without_leaking(payload: str) -> None:
    async def server(socket: ServerConnection) -> None:
        await authenticate(socket)
        await socket.recv()
        await socket.send(payload)
        await socket.wait_closed()

    async def no_retry(_: float) -> None:
        await asyncio.Event().wait()

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
            sleep=no_retry,
        )
        adapter.start()
        await until(lambda: adapter.status.connection == "disconnected")
        assert adapter.status.error in {"unsupported_response", "unavailable"}
        assert adapter.status.inventory_stale
        assert not adapter._pending
        await adapter.close()


@pytest.mark.anyio
async def test_handshake_timeout_and_cancel() -> None:
    async def server(socket: ServerConnection) -> None:
        await socket.wait_closed()

    async def no_retry(_: float) -> None:
        await asyncio.Event().wait()

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            timeout=0.02,
            rest=rest_fixture(),
            sleep=no_retry,
        )
        adapter.start()
        await until(lambda: adapter.status.error == "timeout")
        await adapter.close()


@pytest.mark.anyio
async def test_partial_tag_capabilities_do_not_hide_version_or_inventory() -> None:
    async def server(socket: ServerConnection) -> None:
        await authenticate(socket)
        async for raw in socket:
            message = json.loads(raw)
            if message["type"] == "subscribe_events":
                result = {"success": False, "error": {"code": "unauthorized", "message": "PRIVATE"}}
            else:
                result = {"success": True, "result": [{"id": "Synthetic"}]}
            await socket.send(json.dumps({"type": "result", "id": message["id"], **result}))

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
        )
        adapter.start()
        await until(lambda: adapter.status.inventory_updated_at is not None)
        assert adapter.status.scan_subscription == "unsupported"
        assert adapter.status.tag_list == "supported"
        assert adapter.status.version == "2026.10.1"
        assert adapter.status.error == "forbidden"
        assert "PRIVATE" not in adapter.snapshot().model_dump_json()
        await adapter.close()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("wire_code", "expected"),
    [
        ("unauthorized", "forbidden"),
        ("not_allowed", "forbidden"),
        ("not_supported", "unsupported_operation"),
        ("unknown_command", "unsupported_operation"),
        ("not_found", "not_found"),
        ("timeout", "timeout"),
        ("rate_limited", "rate_limited"),
        ("unknown_fixture_error", "unavailable"),
    ],
)
async def test_websocket_result_error_categories(wire_code: str, expected: str) -> None:
    async def server(socket: ServerConnection) -> None:
        await authenticate(socket)
        async for raw in socket:
            message = json.loads(raw)
            if message["id"] <= 2:
                result: dict[str, Any] = {
                    "success": True,
                    "result": [] if message["type"] == "tag/list" else None,
                }
            else:
                result = {"success": False, "error": {"code": wire_code, "message": "PRIVATE"}}
            await socket.send(json.dumps({"type": "result", "id": message["id"], **result}))

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
        )
        adapter.start()
        await until(lambda: adapter.status.last_success_at is not None)
        with pytest.raises(HAError) as error:
            await adapter.command("tag/list")
        assert error.value.code == expected
        assert "PRIVATE" not in str(error.value)
        await adapter.close()


@pytest.mark.anyio
async def test_server_subscription_timeout_closes_before_reconnect() -> None:
    commands = []
    closed = asyncio.Event()

    async def server(socket: ServerConnection) -> None:
        await authenticate(socket)
        message = json.loads(await socket.recv())
        commands.append(message)
        await socket.send(
            json.dumps(
                {
                    "id": message["id"],
                    "type": "result",
                    "success": False,
                    "error": {"code": "timeout"},
                }
            )
        )
        await socket.wait_closed()
        closed.set()

    async def backoff(_: float) -> None:
        await closed.wait()
        await asyncio.Event().wait()

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
            sleep=backoff,
        )
        adapter.start()
        await until(lambda: closed.is_set() and adapter.status.connection == "disconnected")
        assert adapter.status.error == "timeout"
        assert adapter.status.last_success_at is None
        assert [command["type"] for command in commands] == ["subscribe_events"]
        assert not adapter.status.subscribed and not adapter._pending
        await adapter.close()


@pytest.mark.anyio
async def test_discovery_success_requires_every_stage_and_keeps_last_success() -> None:
    failures = {"config", "services", "subscribe_scans", "tag/list"}

    def http(request: httpx.Request) -> httpx.Response:
        operation = request.url.path.rsplit("/", 1)[-1]
        return (
            httpx.Response(503)
            if operation in failures
            else httpx.Response(200, json={"version": "2026.10.1"} if operation == "config" else [])
        )

    class FixtureAdapter(HAAdapter):
        async def command(self, operation: str) -> Any:
            if operation in failures:
                raise HAError("unavailable")
            return [{"id": "Synthetic"}] if operation == "tag/list" else None

    rest = RestClient("http://ha.example", "synthetic-token", transport=httpx.MockTransport(http))
    adapter = FixtureAdapter("http://ha.example", "synthetic-token", rest=rest)
    await adapter._discover()
    assert adapter.status.last_success_at is None
    failures.clear()
    await adapter._discover()
    last_success = adapter.status.last_success_at
    assert last_success is not None
    for stage in ("config", "services", "subscribe_scans", "tag/list"):
        failures.clear()
        failures.add(stage)
        await adapter._discover()
        assert adapter.status.last_success_at == last_success
    failures.update({"config", "services", "subscribe_scans", "tag/list"})
    await adapter._discover()
    assert adapter.status.last_success_at == last_success
    assert adapter.inventory[0].id == "Synthetic"
    assert adapter.status.inventory_stale
    await adapter.close()


@pytest.mark.anyio
async def test_empty_inventory_id_preserves_last_good_snapshot() -> None:
    class FixtureAdapter(HAAdapter):
        raw: Any = [{"id": "  Opaque:Å/01  "}]

        async def command(self, operation: str) -> Any:
            return self.raw

    adapter = FixtureAdapter(None, None)
    assert await adapter._inventory()
    previous = adapter.inventory
    updated = adapter.status.inventory_updated_at
    adapter.raw = [{"id": ""}]
    assert not await adapter._inventory()
    assert adapter.inventory == previous
    assert adapter.inventory[0].id == "  Opaque:Å/01  "
    assert adapter.status.inventory_updated_at == updated
    assert adapter.status.inventory_stale
    assert adapter.status.error == "unsupported_response"


@pytest.mark.anyio
async def test_empty_scan_id_rejects_frame_without_enqueueing() -> None:
    async def server(socket: ServerConnection) -> None:
        await authenticate(socket)
        subscription = json.loads(await socket.recv())
        await socket.send(
            json.dumps(
                {"type": "result", "id": subscription["id"], "success": True, "result": None}
            )
        )
        await socket.send(
            json.dumps(
                {
                    "type": "event",
                    "id": subscription["id"],
                    "event": {"event_type": "tag_scanned", "data": {"tag_id": ""}},
                }
            )
        )
        await socket.wait_closed()

    async def no_retry(_: float) -> None:
        await asyncio.Event().wait()

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
            sleep=no_retry,
        )
        adapter.start()
        await until(lambda: adapter.status.connection == "disconnected")
        assert adapter.status.error == "unsupported_response"
        assert adapter.scans.empty()
        await adapter.close()


@pytest.mark.parametrize(
    ("origin", "expected"),
    [
        ("HTTP://ha.example:8123", "ws://ha.example:8123/api/websocket"),
        ("HtTpS://HA.example:8443", "wss://HA.example:8443/api/websocket"),
        ("HTTPS://[::1]:8123", "wss://[::1]:8123/api/websocket"),
    ],
)
def test_websocket_scheme_uses_parsed_origin(origin: str, expected: str) -> None:
    from jukelet.ha.adapter import websocket_endpoint

    assert websocket_endpoint(origin) == expected


@pytest.mark.anyio
async def test_scan_before_registry_is_immediate_and_reconciles_once() -> None:
    from jukelet.inventory import inventory_view, tag_key

    allow_registry = asyncio.Event()
    reads = 0
    exact_id = "  Synthetic:Å/01  "

    async def server(socket: ServerConnection) -> None:
        nonlocal reads
        await authenticate(socket)
        subscription = 0
        async for raw in socket:
            message = json.loads(raw)
            if message["type"] == "subscribe_events":
                subscription = message["id"]
                result: Any = None
            else:
                assert message["type"] == "tag/list"
                reads += 1
                result = [{"id": exact_id, "name": "Registered"}] if reads >= 3 else []
                if reads == 3:
                    await allow_registry.wait()
            await socket.send(
                json.dumps(
                    {
                        "type": "result",
                        "id": message["id"],
                        "success": True,
                        "result": result,
                    }
                )
            )
            if reads == 1:
                for reader in ("reader-a", "reader-b"):
                    await socket.send(
                        json.dumps(
                            {
                                "type": "event",
                                "id": subscription,
                                "event": {
                                    "event_type": "tag_scanned",
                                    "data": {
                                        "tag_id": exact_id,
                                        "device_id": reader,
                                    },
                                },
                            }
                        )
                    )

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
        )
        adapter.start()
        await until(lambda: reads >= 3)
        pending = inventory_view(adapter)
        assert pending.total == 1
        assert pending.tags[0].state == "pending_discovery"
        assert pending.tags[0].ha_tag_id == exact_id
        assert pending.tags[0].last_reader == "reader-b"
        allow_registry.set()
        await until(lambda: bool(adapter.inventory))
        registered = inventory_view(adapter)
        assert registered.total == 1
        assert registered.tags[0].state == "registered"
        assert registered.tags[0].name == "Registered"
        assert registered.tags[0].tag_key == pending.tags[0].tag_key == tag_key(exact_id)
        await asyncio.sleep(0.3)
        assert reads == 3
        await adapter.close()


@pytest.mark.anyio
async def test_unknown_scan_retries_are_bounded_and_concurrent_scan_is_not_lost() -> None:
    from jukelet.inventory import inventory_view

    reads = 0
    subscription = 0

    async def server(socket: ServerConnection) -> None:
        nonlocal reads, subscription
        await authenticate(socket)
        async for raw in socket:
            message = json.loads(raw)
            if message["type"] == "subscribe_events":
                subscription = message["id"]
                result: Any = None
            else:
                reads += 1
                result = []
                if reads == 2:
                    # A new scan while the first registry read is in flight.
                    await socket.send(
                        json.dumps(
                            {
                                "type": "event",
                                "id": subscription,
                                "event": {
                                    "event_type": "tag_scanned",
                                    "data": {"tag_id": "second"},
                                },
                            }
                        )
                    )
            await socket.send(
                json.dumps(
                    {
                        "type": "result",
                        "id": message["id"],
                        "success": True,
                        "result": result,
                    }
                )
            )
            if reads == 1:
                await socket.send(
                    json.dumps(
                        {
                            "type": "event",
                            "id": subscription,
                            "event": {"event_type": "tag_scanned", "data": {"tag_id": "first"}},
                        }
                    )
                )

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
        )
        adapter.start()
        await until(lambda: reads == 7)  # Initial read plus two coalesced three-read bursts.
        snapshot = inventory_view(adapter)
        assert {row.ha_tag_id for row in snapshot.tags} == {"first", "second"}
        assert all(row.state == "pending_discovery" for row in snapshot.tags)
        await asyncio.sleep(0.3)
        assert reads == 7
        await adapter.close()


@pytest.mark.anyio
@pytest.mark.parametrize(
    "out_of_range",
    ["9999-12-31T23:59:59-01:00", "0001-01-01T00:00:00+01:00"],
)
async def test_scan_reconciliation_survives_timestamp_overflow(out_of_range: str) -> None:
    release_scan = asyncio.Event()
    reads = 0
    connections = 0

    async def server(socket: ServerConnection) -> None:
        nonlocal reads, connections
        connections += 1
        subscription = 0
        await authenticate(socket)
        async for raw in socket:
            message = json.loads(raw)
            if message["type"] == "subscribe_events":
                subscription = message["id"]
                result: Any = None
            else:
                assert message["type"] == "tag/list"
                reads += 1
                result = [{"id": "synthetic", "name": "Last good"}]
                if reads == 2:
                    result = [{"id": "synthetic", "last_scanned": out_of_range}]
                elif reads >= 3:
                    result = [{"id": "synthetic", "name": "Recovered"}]
            await socket.send(
                json.dumps(
                    {
                        "type": "result",
                        "id": message["id"],
                        "success": True,
                        "result": result,
                    }
                )
            )
            if reads == 1:
                await release_scan.wait()
                await socket.send(
                    json.dumps(
                        {
                            "type": "event",
                            "id": subscription,
                            "event": {"event_type": "tag_scanned", "data": {"tag_id": "synthetic"}},
                        }
                    )
                )

    async with serve(server, "127.0.0.1", 0) as listener:
        adapter = HAAdapter(
            f"http://127.0.0.1:{listener.sockets[0].getsockname()[1]}",
            "synthetic-token",
            rest=rest_fixture(),
        )
        adapter.start()
        try:
            await until(lambda: adapter.status.inventory_updated_at is not None)
            previous, updated = adapter.inventory, adapter.status.inventory_updated_at
            worker = adapter._task
            release_scan.set()
            await until(lambda: adapter.status.error == "unsupported_response")
            assert adapter.inventory == previous
            assert adapter.status.inventory_updated_at == updated
            assert adapter.status.inventory_stale
            await until(lambda: adapter.inventory[0].name == "Recovered")
            assert not adapter.status.inventory_stale
            assert adapter.status.inventory_updated_at != updated
            assert adapter._task is worker and worker is not None and not worker.done()
            assert reads == 3 and connections == 1
        finally:
            release_scan.set()
            await adapter.close()
