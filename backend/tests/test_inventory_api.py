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


def test_upload_preview_preserves_exact_ids_and_marks_unknown_join(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        login = client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        response = client.post(
            "/api/v1/imports/preview",
            headers={"Origin": settings.public_origin, "X-CSRF-Token": login.json()["csrf_token"]},
            json={
                "source": "upload",
                "format": "yaml",
                "content": """variables:
  tags:
    "  Å/04:ab  ":
      media_content_type: album
      media_content_id: spotify:album:0123456789ABCDEFGHIJKL
""",
            },
        )
        assert response.status_code == 200
        report = response.json()
        assert report["counts"] == {
            "mappings": 1,
            "accepted": 1,
            "rejected": 0,
            "matched": None,
            "unassigned": None,
            "orphaned": None,
        }
        assert report["rows"][0]["ha_tag_id"] == "  Å/04:ab  "
        assert report["rows"][0]["registry_state"] == "unknown"
        assert "registry_unavailable" in report["warnings"]


def test_preview_security_no_writes_and_source_drift(settings: Settings) -> None:
    import sqlite3

    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        endpoint = "/api/v1/imports/preview"
        payload = {"source": "upload", "format": "json", "content": '{"variables":{"tags":{}}}'}
        origin = {"Origin": settings.public_origin}
        assert client.post(endpoint, json=payload, headers=origin).status_code == 401
        login = client.post(
            "/api/v1/session", json={"secret": settings.auth_secret.decode()}, headers=origin
        )
        headers = {**origin, "X-CSRF-Token": login.json()["csrf_token"]}
        with sqlite3.connect(settings.database_path) as database:
            before = list(database.iterdump())
        assert client.post(endpoint, json=payload, headers=origin).status_code == 403
        assert (
            client.post(
                endpoint, json=payload, headers={"X-CSRF-Token": headers["X-CSRF-Token"]}
            ).status_code
            == 403
        )
        original = client.post(endpoint, json=payload, headers=headers)
        assert original.status_code == 200
        drift = client.post(
            endpoint,
            json={
                **payload,
                "content": payload["content"] + " ",
                "expected_fingerprint": original.json()["fingerprint"],
            },
            headers=headers,
        )
        assert drift.json()["source_changed"] is True
        assert (
            client.post(endpoint, json={"source": "configured"}, headers=headers).status_code == 503
        )
        assert (
            client.post(
                endpoint, json={**payload, "url": "https://arbitrary.example"}, headers=headers
            ).status_code
            == 422
        )
        assert client.post(endpoint, json={"source": "upload"}, headers=headers).status_code == 422
        assert (
            client.post("/api/v1/imports/confirm", json=payload, headers=headers).status_code == 404
        )
        assert (
            client.put("/api/v1/tags/arbitrary/assignment", json={}, headers=headers).status_code
            == 404
        )
        with sqlite3.connect(settings.database_path) as database:
            assert list(database.iterdump()) == before


def test_configured_source_preview_reports_duplicates_and_never_returns_raw_config(
    settings: Settings,
    monkeypatch: object,
) -> None:
    # Replaced below with a narrowly configured synthetic adapter, never a live URL.
    import httpx
    from pytest import MonkeyPatch

    from jukelet.ha.adapter import HAAdapter
    from jukelet.ha.models import Tag
    from jukelet.ha.rest import RestClient

    assert isinstance(monkeypatch, MonkeyPatch)
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/api/states/automation.synthetic":
            return httpx.Response(200, json={"attributes": {"id": "synthetic"}})
        return httpx.Response(
            200, text="""{"variables":{"tags":{"a/b":{},"a/b":{}}},"private":"HIDDEN_CONFIG"}"""
        )

    rest = RestClient(
        "https://ha.example",
        "fixture-token",
        legacy_entity="automation.synthetic",
        transport=httpx.MockTransport(handler),
    )
    adapter = HAAdapter(None, None, rest=rest)
    adapter.inventory = (Tag(id="a/b", name="Synthetic"), Tag(id="free"))
    adapter.status.inventory_updated_at = "2026-10-19T12:00:00+00:00"
    adapter.status.inventory_stale = False
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *args, **kwargs: adapter)
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        login = client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        response = client.post(
            "/api/v1/imports/preview",
            json={"source": "configured"},
            headers={"Origin": settings.public_origin, "X-CSRF-Token": login.json()["csrf_token"]},
        )
        assert response.status_code == 200
        assert response.json()["counts"] == {
            "mappings": 2,
            "accepted": 0,
            "rejected": 2,
            "matched": 1,
            "unassigned": 1,
            "orphaned": 0,
        }
        assert "HIDDEN_CONFIG" not in response.text and "fixture-token" not in response.text
        assert [request.method for request in requests] == ["GET", "GET"]
        page = client.get("/api/v1/tags?offset=1&limit=1").json()
        assert page["total"] == 2 and page["tags"][0]["ha_tag_id"] == "free"
        assert client.get("/api/v1/tags?limit=201").status_code == 422
