"""Synthetic application fixtures: no upstream or household access."""

from fastapi.testclient import TestClient

from jukelet.config import Settings
from jukelet.main import create_app


def test_inventory_requires_login_and_unknown_registry_is_not_empty(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        assert client.get("/api/v1/tags").status_code == 401
        client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        inventory = client.get("/api/v1/tags").json()
        assert inventory["total"] == 0
        assert inventory["registry_available"] is False
        assert inventory["stale"] is True
        assert inventory["updated_at"] is None
