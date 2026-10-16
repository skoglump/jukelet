from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from jukelet.auth import COOKIE_NAME, SESSION_SECONDS, AuthService
from jukelet.config import Settings
from jukelet.main import create_app
from jukelet.storage import migrate, open_database


def login(client: TestClient, settings: Settings) -> dict[str, object]:
    response = client.post(
        "/api/v1/session",
        json={"secret": settings.auth_secret.decode()},
        headers={"Origin": settings.public_origin},
    )
    assert response.status_code == 200
    result: dict[str, object] = response.json()
    return result


def test_session_round_trip_and_revocation(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        assert client.get("/api/v1/session").status_code == 401
        payload = login(client, settings)
        token = client.cookies[COOKIE_NAME]
        assert payload["mode"] == "read_only"
        assert "secret" not in payload
        assert client.get("/api/v1/session").json() == payload
        assert (
            client.delete("/api/v1/session", headers={"Origin": settings.public_origin}).status_code
            == 403
        )
        response = client.delete(
            "/api/v1/session",
            headers={"Origin": settings.public_origin, "X-CSRF-Token": str(payload["csrf_token"])},
        )
        assert response.status_code == 204
        assert COOKIE_NAME not in client.cookies
        assert (
            client.get("/api/v1/session", headers={"Cookie": f"{COOKIE_NAME}={token}"}).status_code
            == 401
        )


def test_secure_cookie_and_redacted_validation(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        response = client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        cookie = response.headers["set-cookie"]
        assert all(value in cookie for value in ["HttpOnly", "Secure", "SameSite=strict", "Path=/"])
        assert response.headers["cache-control"] == "no-store"
        for body in [
            {"secret": {"private": settings.auth_secret.decode()}},
            {"secret": settings.auth_secret.decode(), "extra": "private"},
            {"secret": "x" * 129},
        ]:
            invalid = client.post(
                "/api/v1/session", json=body, headers={"Origin": settings.public_origin}
            )
            assert invalid.status_code == 422
            assert settings.auth_secret.decode() not in invalid.text
            assert "private" not in invalid.text


@pytest.mark.parametrize("origin", [None, "null", "https://other.example"])
def test_origin_required_for_login(settings: Settings, origin: str | None) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = {} if origin is None else {"Origin": origin}
        assert (
            client.post(
                "/api/v1/session", json={"secret": settings.auth_secret.decode()}, headers=headers
            ).status_code
            == 403
        )


def test_origin_and_csrf_are_both_required_for_logout(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        data = login(client, settings)
        assert (
            client.delete(
                "/api/v1/session", headers={"X-CSRF-Token": str(data["csrf_token"])}
            ).status_code
            == 403
        )
        assert (
            client.delete(
                "/api/v1/session",
                headers={"Origin": settings.public_origin, "X-CSRF-Token": "incorrect"},
            ).status_code
            == 403
        )
        assert client.get("/api/v1/session").status_code == 200


def test_host_and_unimplemented_routes(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        assert client.get("/api/v1/session", headers={"Host": "other.example"}).status_code == 400
        for path in ["/api/v1/tags", "/api/v1/status", "/docs", "/openapi.json"]:
            assert client.get(path).status_code == 404
        assert (
            client.post(
                "/api/v1/tags/tag/test-playback", headers={"Origin": settings.public_origin}
            ).status_code
            == 404
        )


def test_limits_and_malformed_requests(settings: Settings) -> None:
    now = [1000.0]
    with TestClient(
        create_app(settings, clock=lambda: now[0]), base_url=settings.public_origin
    ) as c:
        headers = {"Origin": settings.public_origin, "Content-Type": "application/json"}
        assert c.post("/api/v1/session", content=b"{bad", headers=headers).status_code == 422
        assert c.post("/api/v1/session", content=b"\xff", headers=headers).status_code == 422
        assert c.post("/api/v1/session", content=b"x" * 4097, headers=headers).status_code == 413
        assert (
            c.post(
                "/api/v1/session", content="secret", headers={"Origin": settings.public_origin}
            ).status_code
            == 415
        )
        for _ in range(6):
            assert (
                c.post("/api/v1/session", json={"secret": "wrong"}, headers=headers).status_code
                == 401
            )
        limited = c.post("/api/v1/session", json={"secret": "wrong"}, headers=headers)
        assert limited.status_code == 429
        assert limited.headers["retry-after"] == "60"
        now[0] += 61
        login(c, settings)


def test_expiry_and_login_replaces_previous_session(settings: Settings) -> None:
    now = [1000.0]
    with TestClient(
        create_app(settings, clock=lambda: now[0]), base_url=settings.public_origin
    ) as c:
        login(c, settings)
        old_token = c.cookies[COOKIE_NAME]
        login(c, settings)
        assert (
            c.get("/api/v1/session", headers={"Cookie": f"{COOKIE_NAME}={old_token}"}).status_code
            == 401
        )
        now[0] += SESSION_SECONDS
        assert c.get("/api/v1/session").status_code == 401


def test_restart_persistence_and_secret_rotation(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        login(client, settings)
        token = client.cookies[COOKIE_NAME]
    cookie = {"Cookie": f"{COOKIE_NAME}={token}"}
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        assert client.get("/api/v1/session", headers=cookie).status_code == 200
    rotated = replace(settings, auth_secret=b"another-synthetic-secret-for-rotation")
    with TestClient(create_app(rotated), base_url=settings.public_origin) as client:
        assert client.get("/api/v1/session", headers=cookie).status_code == 401
    engine = open_database(settings.database_path)
    with engine.connect() as connection:
        stored = str(connection.execute(text("SELECT * FROM owner_session")).all())
        assert token not in stored
        assert settings.auth_secret.decode() not in stored
    engine.dispose()


def test_concurrent_logins_and_limiter(settings: Settings) -> None:
    engine = open_database(settings.database_path)
    migrate(engine)
    auth = AuthService(engine, settings.auth_secret)
    with ThreadPoolExecutor(max_workers=4) as pool:
        outcomes = list(pool.map(lambda _: auth.allow_attempt(), range(20)))
        results = list(
            pool.map(lambda _: auth.login(settings.auth_secret.decode(), None), range(4))
        )
    assert sum(outcomes) == 10
    assert len({result[0] for result in results if result}) == 4
    assert all(result and auth.lookup(result[0]) for result in results)
    engine.dispose()


def test_unusable_database_fails_startup(settings: Settings) -> None:
    bad = replace(settings, database_path=settings.database_path.parent)
    with pytest.raises(OperationalError), TestClient(create_app(bad)):
        pass
