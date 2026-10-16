from fastapi.testclient import TestClient

from jukelet.main import create_app


def test_minimal_health() -> None:
    with TestClient(create_app()) as client:
        assert client.get("/health/live").json() == {"status": "ok"}
