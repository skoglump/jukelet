"""Cookie-jar and wire regressions using synthetic state, never household HA."""

import json
import socket
import threading
import time
from dataclasses import replace
from unittest.mock import patch

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient
from starlette.types import ASGIApp, Receive, Scope, Send

from jukelet.auth import COOKIE_NAME, INGRESS_COOKIE_NAME, AuthService
from jukelet.config import Settings
from jukelet.ingress import IngressIdentity
from jukelet.main import create_app
from jukelet.storage import open_database

PREFIX = "/api/hassio_ingress/synthetic-cookie-probe"
USER_ID = "a" * 32


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class PrefixProxy:
    """Strip a browser prefix and supply synthetic authenticated proxy metadata."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        assert scope["path"].startswith(PREFIX + "/")
        forwarded = dict(scope)
        forwarded["path"] = scope["path"][len(PREFIX) :]
        forwarded["raw_path"] = forwarded["path"].encode()
        forwarded["headers"] = [
            *scope["headers"],
            (b"x-ingress-path", PREFIX.encode()),
            (b"x-remote-user-id", USER_ID.encode()),
            (b"x-remote-user-groups", b"system-admin"),
        ]
        await self.app(forwarded, receive, send)


@pytest.mark.anyio
async def test_root_and_ingress_cookies_coexist_on_same_host_different_ports(
    settings: Settings,
) -> None:
    standalone_settings = replace(settings, public_origin="https://jukelet.example:8443")
    standalone = create_app(standalone_settings)
    async with (
        standalone.router.lifespan_context(standalone),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=standalone),
            base_url=standalone_settings.public_origin,
        ) as client,
    ):
        login = await client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": standalone_settings.public_origin},
        )
        assert login.status_code == 200
        root_cookie = client.cookies[COOKIE_NAME]
        jar = client.cookies

    ingress_settings = replace(
        settings, runtime="ingress", public_origin="https://jukelet.example:8123"
    )
    ingress = create_app(ingress_settings)
    async with (
        ingress.router.lifespan_context(ingress),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=PrefixProxy(ingress), client=("172.30.32.2", 43210)),
            base_url=ingress_settings.public_origin,
            cookies=jar,
        ) as client,
    ):
        bootstrap = await client.get(PREFIX + "/api/v1/session")
        assert bootstrap.status_code == 200
        first_csrf = bootstrap.json()["csrf_token"]
        for _ in range(3):
            # No manual Cookie header: use the actual jar's path/order/port semantics.
            response = await client.get(PREFIX + "/api/v1/assignments")
            assert response.status_code == 200
            current = await client.get(PREFIX + "/api/v1/session")
            assert current.status_code == 200
            assert current.json()["csrf_token"] == first_csrf
            assert "set-cookie" not in current.headers
        assert client.cookies.get(COOKIE_NAME, path="/") == root_cookie
        assert client.cookies.get(INGRESS_COOKIE_NAME, path=PREFIX) is not None
        jar = client.cookies

    # A return to standalone retains its pre-existing session and root cookie.
    standalone = create_app(standalone_settings)
    async with (
        standalone.router.lifespan_context(standalone),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=standalone),
            base_url=standalone_settings.public_origin,
            cookies=jar,
        ) as client,
    ):
        response = await client.get("/api/v1/session")
        assert response.status_code == 200
        assert response.json()["csrf_token"] == login.json()["csrf_token"]
        assert client.cookies.get(COOKIE_NAME, path="/") == root_cookie


def test_ascii_quoted_ingress_hmac_message_is_not_a_standalone_cookie(
    settings: Settings,
) -> None:
    short_path = "/api/hassio_ingress/a"
    with TestClient(
        create_app(replace(settings, runtime="ingress")),
        base_url=settings.public_origin,
        client=("172.30.32.2", 43210),
    ) as ingress:
        bootstrap = ingress.get(
            "/api/v1/session",
            headers={
                "X-Ingress-Path": short_path,
                "X-Remote-User-Id": USER_ID,
                "X-Remote-User-Groups": "system-admin",
            },
        )
        assert bootstrap.status_code == 200
        token = next(iter(bootstrap.cookies.values()))
    material = "ingress\x00" + json.dumps([USER_ID, short_path, token], separators=(",", ":"))
    assert len(material) <= 128  # The previously accepted standalone length bound.
    # Encode the malicious input ourselves: newer SimpleCookie writers forbid
    # control characters, but the request parser still accepts this ASCII wire form.
    quoted = material.replace("\\", "\\\\").replace('"', '\\"').replace("\x00", "\\000")
    encoded_cookie = f'{COOKIE_NAME}="{quoted}"'
    assert encoded_cookie.isascii() and "\\000" in encoded_cookie
    assert "\x00" not in encoded_cookie

    # Real TCP/Uvicorn parsing proves ASCII quoted/octal wire input is decoded to
    # the same malicious message, rather than relying on an ASGI-only header seam.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        app = create_app(replace(settings, public_origin=origin))
        server = uvicorn.Server(
            uvicorn.Config(app, log_level="critical", access_log=False, proxy_headers=False)
        )
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 5
            while not server.started:
                assert thread.is_alive() and time.monotonic() < deadline
                time.sleep(0.01)
            with httpx.Client(base_url=origin, trust_env=False, timeout=5) as client:
                raw = client.get(
                    "/api/v1/assignments", headers={"Cookie": f"{COOKIE_NAME}={token}"}
                )
                assert raw.status_code == 401
                response = client.get("/api/v1/assignments", headers={"Cookie": encoded_cookie})
                assert response.status_code == 401
                assert "set-cookie" not in response.headers
                assert token not in response.text and USER_ID not in response.text
        finally:
            server.should_exit = True
            thread.join(timeout=10)
            assert not thread.is_alive()


@pytest.mark.parametrize(
    "token",
    [None, "", "a" * 42, "a" * 44, "a" * 129, "a" * 42 + "!", "a" * 42 + "\x00", "Å" * 43],
)
def test_malformed_opaque_tokens_are_rejected_before_session_storage(
    settings: Settings, token: str | None
) -> None:
    engine = open_database(settings.database_path)
    try:
        standalone = AuthService(engine, settings.auth_secret)
        ingress = AuthService(engine, settings.auth_secret, runtime="ingress")
        identity = IngressIdentity(user_id=USER_ID, path=PREFIX)
        with patch("jukelet.auth.Session", side_effect=AssertionError("Invalid token queried DB")):
            assert standalone.lookup(token) is None
            assert ingress.lookup(token, identity) is None
    finally:
        engine.dispose()
