"""Retired migration inputs are inert; saved data needs no source report."""

import sqlite3
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import Tag
from jukelet.ha.rest import RestClient
from jukelet.inventory import tag_key
from jukelet.main import create_app


@pytest.mark.parametrize("mode", ["read_only", "manage"])
def test_retired_requests_never_contact_ha_or_write_domain(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    settings = replace(settings, mode=mode)  # type: ignore[arg-type]
    requests: list[httpx.Request] = []

    def capture(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(500)

    adapter = HAAdapter(
        None,
        None,
        rest=RestClient(
            "https://synthetic.invalid", "synthetic-token", transport=httpx.MockTransport(capture)
        ),
    )
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *args, **kwargs: adapter)
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        origin = {"Origin": settings.public_origin}
        login = client.post(
            "/api/v1/session", json={"secret": settings.auth_secret.decode()}, headers=origin
        )
        headers = {**origin, "X-CSRF-Token": login.json()["csrf_token"]}
        with sqlite3.connect(settings.database_path) as database:
            before = list(database.iterdump())
        for endpoint in ("preview", "confirm"):
            for content in (
                '{"source":"configured"}',
                '{"source":"upload","format":"yaml","content":"variables: {tags: {}}"}',
                '{"preview_token":"stale","confirmed":true}',
                "not json",
            ):
                response = client.post(
                    f"/api/v1/imports/{endpoint}",
                    content=content,
                    headers={**headers, "Content-Type": "application/json"},
                )
                assert response.status_code == 410
                assert response.json()["detail"]["code"] == "automation_import_retired"
        with sqlite3.connect(settings.database_path) as database:
            assert list(database.iterdump()) == before
        assert requests == []


def test_inventory_shows_saved_disabled_assignment_without_preview(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = replace(settings, mode="manage")
    opaque_id = "  Å/04:ab  "
    adapter = HAAdapter(None, None)
    adapter.inventory = (Tag(id=opaque_id, name="Synthetic"), Tag(id="free"))
    adapter.status.inventory_updated_at = "2026-10-28T12:00:00+00:00"
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *args, **kwargs: adapter)
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        login = client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        headers = {"Origin": settings.public_origin, "X-CSRF-Token": login.json()["csrf_token"]}
        value = {
            "ha_tag_id": opaque_id,
            "input": "spotify:album:0123456789ABCDEFGHIJKL",
            "media_type": "album",
            "enabled": False,
            "shuffle": True,
            "playback_profile_id": "default",
            "expected_version": 0,
        }
        assert (
            client.put(
                f"/api/v1/tags/{tag_key(opaque_id)}/assignment", json=value, headers=headers
            ).status_code
            == 200
        )
        page = client.get("/api/v1/tags?offset=0&limit=1").json()
        assert page["total"] == 2
        saved = page["tags"][0]["saved_assignment"]
        assert saved["ha_tag_id"] == opaque_id and saved["enabled"] is False
        assert saved["spotify_uri"] == value["input"] and saved["version"] == 1
        assert (
            client.get("/api/v1/tags?offset=1&limit=1").json()["tags"][0]["saved_assignment"]
            is None
        )
        assert client.get("/api/v1/tags?limit=201").status_code == 422


def test_stale_migration_consent_is_not_new_publication_consent() -> None:
    from pydantic import ValidationError

    from jukelet.publication import ConfirmInput

    with pytest.raises(ValidationError):
        ConfirmInput.model_validate(
            {"review_token": "a" * 43, "confirmed": True, "migration_attested": True}
        )
