from fastapi.testclient import TestClient

from jukelet.config import Settings
from jukelet.main import create_app


def test_status_requires_session_and_defaults_to_no_ha(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        assert client.get("/api/v1/status").status_code == 401
        login = client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        assert login.status_code == 200
        response = client.get("/api/v1/status")
        assert response.status_code == 200
        status = response.json()
        assert status["connection"] == "not_configured"
        assert status["mode"] == "read_only"
        assert len(status["services"]) == 6
        assert all(cap["state"] == "unknown" for cap in status["services"].values())
        assert not any(key in status for key in ("ha_url", "token", "inventory", "entity_id"))
        assert client.get("/health/live").json() == {"status": "ok"}
        assert (
            client.post("/api/v1/status", headers={"Origin": settings.public_origin}).status_code
            == 405
        )
        client.delete(
            "/api/v1/session",
            headers={"Origin": settings.public_origin, "X-CSRF-Token": login.json()["csrf_token"]},
        )
        assert client.get("/api/v1/status").status_code == 401
