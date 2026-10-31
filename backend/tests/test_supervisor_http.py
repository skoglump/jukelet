"""Actual local HTTP requests with synthetic SpotifyPlus payloads and failures.

The request bytes come from the production client. The bounded server implements
only the fixture's HTTP envelope; it is not a Supervisor/Core compatibility test.
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import pytest
from test_ha_rest import service_fixture
from test_ha_supervisor import TOKEN, resolve_supervisor
from test_spotifyplus import ALBUM, ID, URI

from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import HAError
from jukelet.ha.rest import RestClient, capabilities
from jukelet.ha.transport import HAConnection
from jukelet.providers.spotifyplus import SpotifyPlus


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@dataclass
class Request:
    method: str
    target: str
    headers: dict[str, str]
    body: bytes


Reply = tuple[int, dict[str, str], bytes]


@asynccontextmanager
async def http_fixture(
    monkeypatch: pytest.MonkeyPatch, respond: Callable[[Request], Awaitable[Reply]]
) -> AsyncIterator[list[Request]]:
    requests: list[Request] = []
    pending: set[asyncio.Task[Any]] = set()
    errors: list[Exception] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        assert task is not None
        pending.add(task)
        try:
            async with asyncio.timeout(1):
                lines = (await reader.readuntil(b"\r\n\r\n")).decode("ascii").split("\r\n")
                method, target, version = lines[0].split(" ")
                assert version == "HTTP/1.1"
                headers = {
                    key.lower(): value.strip()
                    for key, value in (line.split(":", 1) for line in lines[1:] if line)
                }
                length = int(headers.get("content-length", "0"))
                assert 0 <= length <= 8192
                request = Request(method, target, headers, await reader.readexactly(length))
                requests.append(request)
                status, response_headers, body = await respond(request)
                response_headers = {
                    "Content-Length": str(len(body)),
                    "Connection": "close",
                    **response_headers,
                }
                envelope = f"HTTP/1.1 {status} Synthetic\r\n" + "".join(
                    f"{key}: {value}\r\n" for key, value in response_headers.items()
                )
                writer.write(envelope.encode("ascii") + b"\r\n" + body)
                await writer.drain()
        except BrokenPipeError, ConnectionResetError:
            pass  # A deliberate client deadline can close its socket first.
        except Exception as error:
            errors.append(error)
        finally:
            writer.close()
            await writer.wait_closed()
            pending.discard(task)

    async with await asyncio.start_server(handle, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        resolve_supervisor(monkeypatch, port)
        # If environment proxies were honored, this server would see an absolute
        # request target instead of the asserted fixed origin-form path.
        for variable in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            monkeypatch.setenv(variable, f"http://127.0.0.1:{port}")
        monkeypatch.setenv("NO_PROXY", "")
        try:
            yield requests
        finally:
            for task in tuple(pending):
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
    assert errors == [], f"Synthetic HTTP fixture failures: {errors!r}"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("fault", "expected"),
    [
        ("401", "unauthorized"),
        ("403", "forbidden"),
        ("404", "not_found"),
        ("429", "rate_limited"),
        ("503", "unavailable"),
        ("redirect", "unavailable"),
        ("malformed", "unsupported_response"),
        ("deadline", "timeout"),
    ],
)
async def test_supervisor_spotify_http_preserves_last_good_on_bounded_failure(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    fault: str,
    expected: str,
) -> None:
    phase = "success"
    now = [0.0]

    async def respond(request: Request) -> Reply:
        assert request.method == "POST"
        assert request.target == "/core/api/services/spotifyplus/get_album?return_response"
        assert request.headers["host"] == "supervisor"
        assert request.headers["authorization"] == f"Bearer {TOKEN}"
        assert json.loads(request.body) == {
            "entity_id": "media_player.synthetic",
            "album_id": ID,
        }
        if phase == "success":
            return (
                200,
                {"Content-Type": "application/json"},
                json.dumps(
                    {"service_response": {"result": ALBUM, "user_profile": {"private": TOKEN}}}
                ).encode(),
            )
        if phase == "deadline":
            await asyncio.Event().wait()
        if phase == "redirect":
            return (
                302,
                {"Location": "http://supervisor/unexpected-route"},
                f"PRIVATE {TOKEN}".encode(),
            )
        if phase == "malformed":
            return 200, {}, f"PRIVATE not JSON {TOKEN}".encode()
        return int(phase), {}, f"PRIVATE {TOKEN}".encode()

    caplog.set_level(logging.DEBUG)
    async with http_fixture(monkeypatch, respond) as requests:
        selected = HAConnection.supervisor(TOKEN)
        adapter = HAAdapter(selected, rest=RestClient(selected, timeout=0.1))
        adapter.status.services = capabilities(service_fixture())
        provider = SpotifyPlus(adapter, "media_player.synthetic", clock=lambda: now[0])
        try:
            fresh = await provider.resolve(URI, "album")
            assert fresh.state == "fresh" and fresh.error is None
            assert fresh.item is not None and fresh.item.title == "Synthetic album"
            assert fresh.item.artwork_url == "https://i.scdn.co/image/synthetic"
            assert len(requests) == 1
            phase, now[0] = fault, 301
            failed = await provider.resolve(URI, "album")
            assert failed.state == "stale" and failed.error == expected
            assert failed.uri == URI and failed.item == fresh.item
            assert failed.last_success_at == fresh.last_success_at
            assert failed.retry_after is not None and failed.retry_after > 0
            assert len(requests) == 2, "Redirects and uncertain failures must not replay requests"
            await provider.resolve(URI, "album")
            assert len(requests) == 2, "The existing provider cooldown remains effective"
            assert TOKEN not in failed.model_dump_json()
            assert "PRIVATE" not in failed.model_dump_json()
            assert adapter.rest is not None
            with pytest.raises(HAError, match="unsupported_operation"):
                await adapter.rest.read("addons")
            with pytest.raises(HAError, match="unsupported_operation"):
                await adapter.rest.metadata("turn_on", {}, adapter.status.services)
            assert len(requests) == 2
        finally:
            await adapter.close()
    assert TOKEN not in caplog.text
    assert "PRIVATE" not in caplog.text
