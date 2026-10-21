"""Synthetic API fixtures only; no household or Spotify access."""

from dataclasses import replace

from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import Scan, Tag
from jukelet.inventory import tag_key
from jukelet.main import create_app


def test_inbox_joins_local_membership_before_paging_and_retains_observation_provenance(
    settings: Settings, monkeypatch: MonkeyPatch
) -> None:
    adapter = HAAdapter(None, None)
    adapter.inventory = tuple(Tag(id=f"fixture-{i:03}") for i in range(105))
    adapter.status.inventory_updated_at = "2026-10-21T12:00:00+00:00"
    adapter.status.inventory_stale = False
    adapter.observations["pending"] = Scan(
        tag_id="pending", device_id="synthetic-reader", observed_at="2026-10-21T12:01:00+00:00"
    )
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *a, **kw: adapter)
    with TestClient(
        create_app(replace(settings, mode="manage")), base_url=settings.public_origin
    ) as client:
        login = client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        headers = {"Origin": settings.public_origin, "X-CSRF-Token": login.json()["csrf_token"]}
        for i, enabled in ((0, True), (100, False)):
            response = client.put(
                f"/api/v1/tags/{tag_key(f'fixture-{i:03}')}/assignment",
                headers=headers,
                json={
                    "ha_tag_id": f"fixture-{i:03}",
                    "input": "spotify:album:0123456789ABCDEFGHIJKL",
                    "media_type": "album",
                    "enabled": enabled,
                    "shuffle": False,
                    "playback_profile_id": "default",
                    "expected_version": 0,
                },
            )
            assert response.status_code == 200
        page = client.get("/api/v1/tags/inbox?offset=99&limit=5").json()
        assert page["total"] == 104
        assert [tag["ha_tag_id"] for tag in page["tags"]] == [
            "fixture-101",
            "fixture-102",
            "fixture-103",
            "fixture-104",
            "pending",
        ]
        assert page["tags"][0]["observed_at"] is None
        assert page["tags"][-1]["observed_at"] == "2026-10-21T12:01:00+00:00"
        assert page["tags"][-1]["state"] == "pending_discovery"
        observed = client.get("/api/v1/tags/inbox?view=observed").json()
        assert observed["total"] == 1
        assert observed["tags"][0]["last_reader"] == "synthetic-reader"


def test_rename_boundary_rejects_without_dispatch(
    settings: Settings, monkeypatch: MonkeyPatch
) -> None:
    adapter = HAAdapter(None, None)
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *a, **kw: adapter)
    endpoint = f"/api/v1/tags/{tag_key('  Å/fixture  ')}/name"
    value = {"ha_tag_id": "  Å/fixture  ", "expected_name": None, "name": "Dinner"}
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        origin = {"Origin": settings.public_origin}
        assert client.patch(endpoint, json=value, headers=origin).status_code == 401
        login = client.post(
            "/api/v1/session", json={"secret": settings.auth_secret.decode()}, headers=origin
        )
        headers = {**origin, "X-CSRF-Token": login.json()["csrf_token"]}
        assert client.patch(endpoint, json=value, headers=headers).status_code == 403
        assert client.get(endpoint).status_code == 503
    with TestClient(
        create_app(replace(settings, mode="manage")), base_url=settings.public_origin
    ) as client:
        login = client.post(
            "/api/v1/session", json={"secret": settings.auth_secret.decode()}, headers=origin
        )
        headers = {**origin, "X-CSRF-Token": login.json()["csrf_token"]}
        assert client.patch(endpoint, json=value).status_code == 403
        assert client.patch(endpoint, json=value, headers=origin).status_code == 403
        for invalid in (
            {**value, "name": " "},
            {**value, "name": "x" * 513},
            {**value, "name": 2},
            {**value, "expected_name": 2},
            {**value, "extra": True},
            {**value, "ha_tag_id": "different"},
        ):
            assert client.patch(endpoint, json=invalid, headers=headers).status_code == 422
        assert client.patch(endpoint, json=value, headers=headers).status_code == 503
        assert not adapter._pending


def test_membership_failure_is_unknown_and_registry_history_does_not_invent_observed_reader(
    settings: Settings, monkeypatch: MonkeyPatch
) -> None:
    from sqlalchemy.exc import OperationalError

    from jukelet.assignments import AssignmentStore

    adapter = HAAdapter(None, None)
    adapter.inventory = (Tag(id="fixture", last_scanned="2026-10-21T13:00:00+00:00"),)
    adapter.status.inventory_updated_at = "2026-10-21T13:00:00+00:00"
    adapter.observations["fixture"] = Scan(
        tag_id="fixture", device_id="synthetic-reader", observed_at="2026-10-21T12:00:00+00:00"
    )
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *a, **kw: adapter)

    def unavailable(self: AssignmentStore) -> dict[str, bool]:
        raise OperationalError("synthetic unavailable", {}, Exception())

    monkeypatch.setattr(AssignmentStore, "membership", unavailable)
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        inbox = client.get("/api/v1/tags/inbox").json()
        assert inbox["assignments_available"] is False
        assert inbox["tags"][0]["local_assignment"] == "unknown"
        assert inbox["tags"][0]["observed_at"] == "2026-10-21T12:00:00+00:00"
        assert inbox["tags"][0]["observed_reader"] == "synthetic-reader"
        assert inbox["tags"][0]["last_reader"] is None
        assert inbox["tags"][0]["last_scanned"] == "2026-10-21T13:00:00+00:00"
        assert client.get("/api/v1/tags/inbox?view=invalid").status_code == 422
        assert client.get("/api/v1/tags/inbox?limit=201").status_code == 422


def test_manage_api_dispatches_only_exact_rename_and_preserves_local_database(
    settings: Settings, monkeypatch: MonkeyPatch
) -> None:
    import sqlite3

    adapter = HAAdapter(None, None)
    adapter.inventory = (Tag(id="  Å/fixture  ", name="Before"),)
    updates: list[tuple[str, str]] = []

    async def refresh() -> None:
        adapter.status.inventory_stale = False

    async def update(tag_id: str, name: str) -> None:
        updates.append((tag_id, name))
        adapter.inventory = (Tag(id=tag_id, name=name),)

    monkeypatch.setattr(adapter, "refresh_inventory", refresh)
    monkeypatch.setattr(adapter, "update_tag_name", update)
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *a, **kw: adapter)
    with TestClient(
        create_app(replace(settings, mode="manage")), base_url=settings.public_origin
    ) as client:
        login = client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        assert client.get("/api/v1/status").json()["mode"] == "manage"
        headers = {"Origin": settings.public_origin, "X-CSRF-Token": login.json()["csrf_token"]}
        with sqlite3.connect(settings.database_path) as database:
            before = list(database.iterdump())
        endpoint = f"/api/v1/tags/{tag_key('  Å/fixture  ')}/name"
        value = {"ha_tag_id": "  Å/fixture  ", "expected_name": "Before", "name": "  Middag Å  "}
        result = client.patch(endpoint, json=value, headers=headers)
        assert result.status_code == 200
        assert result.json()["state"] == "verified"
        assert result.json()["name"] == "  Middag Å  "
        assert updates == [("  Å/fixture  ", "  Middag Å  ")]
        conflict = client.patch(endpoint, json=value, headers=headers)
        assert conflict.status_code == 409
        assert len(updates) == 1
        assert client.get(endpoint).json()["name"] == "  Middag Å  "
        with sqlite3.connect(settings.database_path) as database:
            assert list(database.iterdump()) == before


def test_connected_inbox_rechecks_delayed_registration_without_inventing_scan_history(
    settings: Settings, monkeypatch: MonkeyPatch
) -> None:
    adapter = HAAdapter(None, None)
    adapter.status.connection = "connected"
    adapter.status.inventory_updated_at = "2026-10-21T12:00:00+00:00"
    adapter.observations["pending"] = Scan(
        tag_id="pending", device_id="reader-fixture", observed_at="2026-10-21T12:00:00+00:00"
    )
    reads = 0

    async def refresh() -> None:
        nonlocal reads
        reads += 1
        if reads > 1:
            adapter.inventory = (
                Tag(id="pending", name="Registered later"),
                Tag(id="registry-only", last_scanned="2026-10-21T12:01:00+00:00"),
            )
        adapter.status.inventory_stale = False

    monkeypatch.setattr(adapter, "refresh_inventory", refresh)
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *a, **kw: adapter)
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        client.post(
            "/api/v1/session",
            json={"secret": settings.auth_secret.decode()},
            headers={"Origin": settings.public_origin},
        )
        first = client.get("/api/v1/tags/inbox").json()
        assert first["tags"][0]["state"] == "pending_discovery"
        second = client.get("/api/v1/tags/inbox").json()
        assert reads == 2
        assert second["tags"][0]["state"] == "registered"
        assert second["tags"][0]["observed_reader"] == "reader-fixture"
        assert second["tags"][1]["observed_at"] is None
        assert second["tags"][1]["observed_reader"] is None
