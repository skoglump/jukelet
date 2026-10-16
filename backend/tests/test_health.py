from fastapi.testclient import TestClient

from jukelet.config import Settings
from jukelet.main import create_app


def test_minimal_health(settings: Settings) -> None:
    with TestClient(create_app(settings)) as client:
        assert client.get("/health/live").json() == {"status": "ok"}
