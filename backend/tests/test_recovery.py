"""Logical exports and recovery use synthetic isolated databases, never HA."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from test_assignments import TAG, URI, login, payload

from jukelet.config import Settings
from jukelet.inventory import tag_key
from jukelet.main import create_app


def test_export_and_restore_round_trip(settings: Settings) -> None:
    settings = replace(settings, mode="manage")
    path = f"/api/v1/tags/{tag_key(TAG)}/assignment"
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        client.put(path, json=payload(), headers=headers)
        response = client.get("/api/v1/export")
        assert response.status_code == 200
        document = response.json()
        assert document["schema_version"] == 1
        assert document["assignments"][0]["ha_tag_id"] == TAG
        assert settings.auth_secret.decode() not in response.text
        assert "csrf" not in response.text and "publisher_id" not in response.text
        client.request("DELETE", path, json={"expected_version": 1}, headers=headers)
        preview = client.post(
            "/api/v1/restores/preview", json={"document": document}, headers=headers
        )
        assert preview.status_code == 200
        report = preview.json()
        assert report["accepted"] == 1 and report["conflicts"] == 0
        confirmation = {
            "preview_token": report["preview_token"],
            "conflict_policy": "reject",
            "confirmed": True,
        }
        restored = client.post("/api/v1/restores/confirm", json=confirmation, headers=headers)
        assert restored.status_code == 200
        assert restored.json()["reconciliation_required"] is True
        row = client.get(path).json()["assignment"]
        assert row["ha_tag_id"] == TAG and row["spotify_uri"] == URI
        assert row["shuffle"] is True and row["enabled"] is False
        assert row["playback_profile_id"] == "default" and row["version"] == 3
        assert (
            client.post("/api/v1/restores/confirm", json=confirmation, headers=headers).status_code
            == 409
        )
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        login(client, settings)
        assert client.get("/api/v1/recovery").json()["reconciliation_required"] is True


def test_preview_reports_unsupported_rows_and_rejects_corruption(settings: Settings) -> None:
    import json

    settings = replace(settings, mode="manage")
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        client.put(f"/api/v1/tags/{tag_key(TAG)}/assignment", json=payload(), headers=headers)
        document = client.get("/api/v1/export").json()
        good = document["assignments"][0]
        good["name"] = "Kvällsmusik Å 日本語"
        bad = {
            **good,
            "ha_tag_id": "unsupported",
            "media_type": "track",
            "spotify_uri": "spotify:track:0123456789ABCDEFGHIJKL",
        }
        document["assignments"] += [
            bad,
            {**good, "ha_tag_id": "duplicate"},
            {**good, "ha_tag_id": "duplicate"},
        ]
        result = client.post(
            "/api/v1/restores/preview", json={"document": document}, headers=headers
        )
        assert result.status_code == 200
        report = result.json()
        assert (report["accepted"], report["rejected"], report["conflicts"]) == (1, 3, 1)
        assert report["rows"][1]["source"] == bad
        assert report["rows"][2]["diagnostics"] == ["duplicate_tag_id"]
        assert report["rows"][0]["source"]["name"] == "Kvällsmusik Å 日本語"
        for change in (
            {"schema_version": 2},
            {"schema_version": True},
            {"publisher_id": "foreign"},
            {"assignments": "broken"},
        ):
            assert (
                client.post(
                    "/api/v1/restores/preview",
                    json={"document": {**document, **change}},
                    headers=headers,
                ).status_code
                == 422
            )
        for raw in (
            "{broken",
            '{"document":{},"document":{}}',
            json.dumps({"document": document}).replace(
                '"schema_version": 1', '"schema_version": 1, "schema_version": 1'
            ),
        ):
            assert (
                client.post(
                    "/api/v1/restores/preview",
                    content=raw,
                    headers={**headers, "Content-Type": "application/json"},
                ).status_code
                == 422
            )
        assert (
            client.post(
                "/api/v1/restores/preview",
                content="x" * (4 * 1024 * 1024 + 4097),
                headers={**headers, "Content-Type": "application/json"},
            ).status_code
            == 413
        )
        assert client.get("/api/v1/recovery").json()["reconciliation_required"] is False


def test_restore_policy_atomicity_staleness_identity_and_security(settings: Settings) -> None:
    from concurrent.futures import ThreadPoolExecutor

    from sqlalchemy import text

    from jukelet.storage import open_database

    settings = replace(settings, mode="manage")
    path = f"/api/v1/tags/{tag_key(TAG)}/assignment"
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        assert client.get("/api/v1/export").status_code == 401
        assert (
            client.post(
                "/api/v1/restores/confirm", json={}, headers={"Origin": settings.public_origin}
            ).status_code
            == 401
        )
        headers = login(client, settings)
        client.put(path, json=payload(), headers=headers)
        document = client.get("/api/v1/export").json()
        document["assignments"].insert(0, {**document["assignments"][0], "ha_tag_id": "first-new"})
        document["provenance"]["local_revision"] = 9000

        def confirmation() -> dict[str, object]:
            report = client.post(
                "/api/v1/restores/preview", json={"document": document}, headers=headers
            ).json()
            return {
                "preview_token": report["preview_token"],
                "confirmed": True,
                "conflict_policy": "reject",
            }

        value = confirmation()
        assert (
            client.post("/api/v1/restores/confirm", json=value, headers=headers).status_code == 409
        )
        assert client.get("/api/v1/assignments").json()["total"] == 1
        assert client.get("/api/v1/recovery").json()["reconciliation_required"] is False
        client.put(path, json=payload(1), headers=headers)
        assert (
            client.post(
                "/api/v1/restores/confirm",
                json={**value, "conflict_policy": "replace"},
                headers=headers,
            ).status_code
            == 409
        )
        value = confirmation()
        for missing in ("confirmed", "conflict_policy"):
            assert (
                client.post(
                    "/api/v1/restores/confirm",
                    json={key: item for key, item in value.items() if key != missing},
                    headers=headers,
                ).status_code
                == 422
            )
        assert (
            client.post(
                "/api/v1/restores/confirm", json={**value, "confirmed": False}, headers=headers
            ).status_code
            == 409
        )
        assert (
            client.post(
                "/api/v1/restores/confirm", json=value, headers={"Origin": settings.public_origin}
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/v1/restores/preview",
                json={"document": document},
                headers={"Origin": settings.public_origin},
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/v1/restores/confirm",
                json=value,
                headers={"X-CSRF-Token": headers["X-CSRF-Token"]},
            ).status_code
            == 403
        )
        headers = login(client, settings)
        assert (
            client.post("/api/v1/restores/confirm", json=value, headers=headers).status_code == 409
        )
        value = {**confirmation(), "conflict_policy": "skip"}
        result = client.post("/api/v1/restores/confirm", json=value, headers=headers).json()
        assert result["restored"] == 1 and result["skipped"] == 1
        engine = open_database(settings.database_path)
        with engine.connect() as connection:
            identity = connection.scalar(text("SELECT publisher_id FROM recovery_state"))
        value = {**confirmation(), "conflict_policy": "replace"}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(
                pool.map(
                    lambda _: client.post("/api/v1/restores/confirm", json=value, headers=headers),
                    range(2),
                )
            )
        assert sorted(result.status_code for result in results) == [200, 409]
        assert client.get("/api/v1/assignments").json()["revision"] == 4
        with engine.connect() as connection:
            assert connection.scalar(text("SELECT publisher_id FROM recovery_state")) == identity
        engine.dispose()
    with TestClient(
        create_app(replace(settings, mode="read_only")), base_url=settings.public_origin
    ) as client:
        headers = login(client, settings)
        report = client.post(
            "/api/v1/restores/preview", json={"document": document}, headers=headers
        )
        assert report.status_code == 200
        assert (
            client.post(
                "/api/v1/restores/confirm",
                json={**value, "preview_token": report.json()["preview_token"]},
                headers=headers,
            ).status_code
            == 403
        )


def test_preview_expiry_and_export_limits(settings: Settings, monkeypatch: object) -> None:
    from types import SimpleNamespace

    from pytest import MonkeyPatch

    assert isinstance(monkeypatch, MonkeyPatch)
    settings = replace(settings, mode="manage")
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        client.put(f"/api/v1/tags/{tag_key(TAG)}/assignment", json=payload(), headers=headers)
        document = client.get("/api/v1/export").json()
        report = client.post(
            "/api/v1/restores/preview", json={"document": document}, headers=headers
        ).json()
        monkeypatch.setattr(
            "jukelet.recovery.time", SimpleNamespace(monotonic=lambda: float("inf"))
        )
        assert (
            client.post(
                "/api/v1/restores/confirm",
                json={
                    "preview_token": report["preview_token"],
                    "confirmed": True,
                    "conflict_policy": "replace",
                },
                headers=headers,
            ).status_code
            == 409
        )
        monkeypatch.setattr("jukelet.recovery.MAX_BYTES", 1)
        assert client.get("/api/v1/export").status_code == 422


def test_export_names_are_informational_and_restore_never_calls_ha(
    settings: Settings, monkeypatch: object
) -> None:
    from pytest import MonkeyPatch

    from jukelet.ha.adapter import HAAdapter
    from jukelet.ha.models import Tag

    assert isinstance(monkeypatch, MonkeyPatch)
    adapter = HAAdapter(None, None)
    adapter.inventory = (Tag(id=TAG, name="Kväll Å 日本語"),)
    adapter.status.inventory_updated_at = "2026-10-22T00:00:00+00:00"
    adapter.status.inventory_stale = True
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *args, **kwargs: adapter)

    async def prohibit(*args: object, **kwargs: object) -> None:
        raise AssertionError("Recovery must not send HA commands")

    monkeypatch.setattr(adapter, "command", prohibit)
    settings = replace(settings, mode="manage")
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        client.put(f"/api/v1/tags/{tag_key(TAG)}/assignment", json=payload(), headers=headers)
        document = client.get("/api/v1/export").json()
        assert set(document) == {"schema_version", "provenance", "assignments"}
        assert document["provenance"]["names_stale"] is True
        assert document["assignments"][0]["name"] == "Kväll Å 日本語"
        assert set(document["assignments"][0]) == {
            "ha_tag_id",
            "spotify_uri",
            "media_type",
            "enabled",
            "shuffle",
            "playback_profile_id",
            "name",
        }
        document["assignments"][0]["name"] = "Informational foreign name"
        report = client.post(
            "/api/v1/restores/preview", json={"document": document}, headers=headers
        ).json()
        assert (
            client.post(
                "/api/v1/restores/confirm",
                json={
                    "preview_token": report["preview_token"],
                    "confirmed": True,
                    "conflict_policy": "replace",
                },
                headers=headers,
            ).status_code
            == 200
        )
        assert client.get("/api/v1/export").json()["assignments"][0]["name"] == "Kväll Å 日本語"


@pytest.mark.parametrize("number", ["1e999", "-1e999", "NaN", "Infinity", "-Infinity"])
@pytest.mark.parametrize("nested", [False, True])
def test_restore_rejects_nonfinite_numbers_without_changing_source(
    settings: Settings, number: str, nested: bool
) -> None:
    import json

    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        document = client.get("/api/v1/export").json()
        extra = {"values": ["NUMBER"]} if nested else "NUMBER"
        document["assignments"] = [{"ha_tag_id": TAG, "extra": extra}]
        # Raw bytes exercise overflow from JSON numeric syntax, not Python's NaN encoder.
        body = json.dumps({"document": document}).replace('"NUMBER"', number)
        response = client.post(
            "/api/v1/restores/preview",
            content=body,
            headers={**headers, "Content-Type": "application/json"},
        )
        assert response.status_code == 422
        assert client.get("/api/v1/assignments").json()["revision"] == 0
        assert client.get("/api/v1/recovery").json()["reconciliation_required"] is False


def test_restore_report_preserves_large_finite_numbers(settings: Settings) -> None:
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        document = client.get("/api/v1/export").json()
        source = {"ha_tag_id": TAG, "extra": {"values": [1e308, -1e308]}}
        document["assignments"] = [source]
        response = client.post(
            "/api/v1/restores/preview", json={"document": document}, headers=headers
        )
        assert response.status_code == 200
        report = response.json()
        assert report["rejected"] == 1
        assert report["rows"][0]["source"] == source
