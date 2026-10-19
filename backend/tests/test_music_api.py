"""Synthetic owner-session music previews; never access a household."""

import sqlite3

from fastapi.testclient import TestClient

from jukelet.config import Settings
from jukelet.main import create_app

URI = "spotify:album:0123456789ABCDEFGHIJKL"


def test_manual_preview_without_provider_keeps_uri_and_never_saves(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        endpoint = "/api/v1/music/resolve"
        origin = {"Origin": settings.public_origin}
        payload = {"input": URI, "media_type": "album"}
        assert client.post(endpoint, json=payload, headers=origin).status_code == 401
        login = client.post(
            "/api/v1/session", json={"secret": settings.auth_secret.decode()}, headers=origin
        )
        headers = {**origin, "X-CSRF-Token": login.json()["csrf_token"]}
        with sqlite3.connect(settings.database_path) as db:
            before = list(db.iterdump())
        assert client.post(endpoint, json=payload, headers=origin).status_code == 403
        result = client.post(endpoint, json=payload, headers=headers)
        assert result.status_code == 503
        assert result.json()["uri"] == URI
        assert result.json()["error"] == "unsupported_operation"
        assert result.json()["item"] is None
        assert (
            client.post(
                endpoint, json={**payload, "media_type": "playlist"}, headers=headers
            ).status_code
            == 422
        )
        assert (
            client.post(
                endpoint,
                json={**payload, "input": "https://untrusted.example/album/abc"},
                headers=headers,
            ).status_code
            == 422
        )
        caps = client.get("/api/v1/music/capabilities").json()
        assert len(caps) == 6 and set(caps.values()) == {"unsupported"}
        with sqlite3.connect(settings.database_path) as db:
            assert list(db.iterdump()) == before


def test_music_reads_require_authentication_and_validate_bounds(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        for endpoint in (
            "/api/v1/music/library?media_type=album",
            "/api/v1/music/search?media_type=playlist&q=fixture",
            "/api/v1/music/capabilities",
        ):
            assert client.get(endpoint).status_code == 401
        client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        for endpoint in (
            "/api/v1/music/library?media_type=track",
            "/api/v1/music/library?media_type=album&offset=1001",
            "/api/v1/music/search?media_type=album&q=",
            "/api/v1/music/search?media_type=album&q=" + "a" * 201,
        ):
            assert client.get(endpoint).status_code == 422
        result = client.get("/api/v1/music/library?media_type=playlist")
        assert result.status_code == 503 and result.json()["error"] == "unsupported_operation"


def test_music_api_uses_discovered_allowlist_and_redacts_private_data(
    settings: Settings, monkeypatch: object
) -> None:
    from dataclasses import replace

    import httpx
    from pytest import MonkeyPatch

    from jukelet.ha.adapter import HAAdapter
    from jukelet.ha.models import Capability, Tag
    from jukelet.ha.rest import SERVICE_FIELDS, RestClient

    assert isinstance(monkeypatch, MonkeyPatch)
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "service_response": {
                    "user_profile": {"id": "HIDDEN_ACCOUNT"},
                    "result": {
                        "type": "album",
                        "uri": URI,
                        "name": "Synthetic album",
                        "images": [],
                    },
                }
            },
        )

    ha = HAAdapter(
        None,
        None,
        rest=RestClient(
            "https://ha.example", "HIDDEN_TOKEN", transport=httpx.MockTransport(handle)
        ),
    )
    ha.status.services = {
        name: Capability(state="supported", fields=sorted(fields), response=True)
        for name, fields in SERVICE_FIELDS.items()
    }
    ha.inventory = (Tag(id="exact/synthetic-tag", name="Synthetic tag"),)
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *args, **kwargs: ha)
    configured = replace(settings, spotifyplus_entity_id="media_player.synthetic")
    with TestClient(create_app(configured), base_url=settings.public_origin) as client:
        login = client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        headers = {"Origin": settings.public_origin, "X-CSRF-Token": login.json()["csrf_token"]}
        caps = client.get("/api/v1/music/capabilities")
        assert set(caps.json().values()) == {"supported"}
        response = client.post(
            "/api/v1/music/resolve", json={"input": URI, "media_type": "album"}, headers=headers
        )
        assert response.status_code == 200 and response.json()["item"]["title"] == "Synthetic album"
        assert response.headers["cache-control"] == "no-store"
        assert "HIDDEN" not in response.text and "media_player.synthetic" not in response.text
        assert len(requests) == 1 and requests[0].method == "POST"
        inventory_before = client.get("/api/v1/tags").json()
        assert (
            client.post(
                "/api/v1/music/resolve",
                json={"input": URI, "media_type": "album", "service": "play_media"},
                headers=headers,
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/v1/music/resolve",
                content="a" * 4097,
                headers={**headers, "Content-Type": "application/json"},
            ).status_code
            == 413
        )
        assert client.get("/api/v1/tags").json() == inventory_before
        assert len(requests) == 1


def test_malformed_unicode_refresh_keeps_last_good_api_preview(
    settings: Settings, monkeypatch: object
) -> None:
    import json
    from dataclasses import replace
    from typing import Any

    import httpx
    from pytest import MonkeyPatch

    from jukelet.ha.adapter import HAAdapter
    from jukelet.ha.models import Capability
    from jukelet.ha.rest import SERVICE_FIELDS, RestClient
    from jukelet.providers.spotifyplus import MediaType, SpotifyPlus

    assert isinstance(monkeypatch, MonkeyPatch)
    cases: list[tuple[MediaType, dict[str, Any]]] = [
        ("album", {"name": "Bad\ud800"}),
        ("album", {"artists": [{"name": "Bad\udfff"}]}),
        ("playlist", {"owner": {"display_name": "Bad\ud800"}}),
        ("album", {"images": [{"url": "https://i.scdn.co/image/bad\udfff"}]}),
    ]

    def scenario(media_type: MediaType, malformed: dict[str, Any]) -> None:
        now = [0.0]
        calls: list[httpx.Request] = []
        uri = URI.replace("album", media_type)
        item = {
            "type": media_type,
            "uri": uri,
            "name": "Synthetic Å 🎵",
            "artists": [{"name": "Fixture artist"}],
            "owner": {"display_name": "Fixture owner"},
            "images": [{"url": "https://i.scdn.co/image/synthetic"}],
        }

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            # Escaped unpaired surrogates are legal JSON syntax, but not UTF-8 text.
            payload = item if len(calls) == 1 else {**item, **malformed}
            return httpx.Response(
                200, content=json.dumps({"service_response": {"result": payload}})
            )

        ha = HAAdapter(
            None,
            None,
            rest=RestClient(
                "https://ha.example", "synthetic-token", transport=httpx.MockTransport(handle)
            ),
        )
        ha.status.services = {
            name: Capability(state="supported", fields=sorted(fields), response=True)
            for name, fields in SERVICE_FIELDS.items()
        }
        provider = SpotifyPlus(ha, "media_player.synthetic", clock=lambda: now[0])
        monkeypatch.setattr("jukelet.main.HAAdapter", lambda *args, **kwargs: ha)
        monkeypatch.setattr("jukelet.main.SpotifyPlus", lambda *args: provider)
        configured = replace(settings, spotifyplus_entity_id="media_player.synthetic")
        with TestClient(
            create_app(configured), base_url=settings.public_origin, raise_server_exceptions=False
        ) as client:
            login = client.post(
                "/api/v1/session",
                json={"secret": settings.auth_secret.decode()},
                headers={"Origin": settings.public_origin},
            )
            headers = {"Origin": settings.public_origin, "X-CSRF-Token": login.json()["csrf_token"]}
            payload = {"input": uri, "media_type": media_type}
            good = client.post("/api/v1/music/resolve", json=payload, headers=headers)
            assert good.status_code == 200 and good.json()["item"]["title"] == "Synthetic Å 🎵"
            now[0] = 301
            for _ in range(2):
                failed = client.post("/api/v1/music/resolve", json=payload, headers=headers)
                assert failed.status_code == 503
                assert failed.json()["error"] == "unsupported_response"
                assert failed.json()["state"] == "stale"
                assert failed.json()["item"] == good.json()["item"]
                assert failed.json()["uri"] == uri
                assert failed.json()["last_success_at"] == good.json()["last_success_at"]
                assert failed.json()["last_attempt_at"] != good.json()["last_attempt_at"]
            assert len(calls) == 2

    for media_type, malformed in cases:
        scenario(media_type, malformed)
