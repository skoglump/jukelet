"""Synthetic local drafts; the HA adapter is unconfigured throughout."""

from dataclasses import replace

from fastapi.testclient import TestClient

from jukelet.config import Settings
from jukelet.inventory import tag_key
from jukelet.main import create_app

TAG = "  Å/04:ab  "
URI = "spotify:album:0123456789ABCDEFGHIJKL"


def login(client: TestClient, settings: Settings) -> dict[str, str]:
    origin = {"Origin": settings.public_origin}
    result = client.post(
        "/api/v1/session", json={"secret": settings.auth_secret.decode()}, headers=origin
    )
    return {**origin, "X-CSRF-Token": result.json()["csrf_token"]}


def payload(version: int = 0) -> dict[str, object]:
    return {
        "ha_tag_id": TAG,
        "input": URI,
        "media_type": "album",
        "enabled": False,
        "shuffle": True,
        "playback_profile_id": "default",
        "expected_version": version,
    }


def test_draft_persists_exact_id_and_explicit_preferences_without_metadata(
    settings: Settings,
) -> None:
    # Enabling local management must never require an upstream connection.
    settings = replace(settings, mode="manage")
    path = f"/api/v1/tags/{tag_key(TAG)}/assignment"
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        saved = client.put(path, json=payload(), headers=headers)
        assert saved.status_code == 200
        assert saved.json()["assignment"]["spotify_uri"] == URI
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        login(client, settings)
        row = client.get(path).json()["assignment"]
        assert row["ha_tag_id"] == TAG
        assert row["enabled"] is False and row["shuffle"] is True
        assert row["playback_profile_id"] == "default"
        assert client.get("/api/v1/assignments").json()["total"] == 1


def test_concurrent_edits_delete_recreate_and_validation(settings: Settings) -> None:
    import json
    from concurrent.futures import ThreadPoolExecutor

    settings = replace(settings, mode="manage")
    path = f"/api/v1/tags/{tag_key(TAG)}/assignment"
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        assert client.get(path).status_code == 401
        headers = login(client, settings)
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(
                pool.map(lambda _: client.put(path, json=payload(), headers=headers), range(2))
            )
        assert sorted(response.status_code for response in responses) == [200, 409]
        assert (
            client.put(path, json=payload(), headers=headers).json()["detail"]["current_version"]
            == 1
        )
        assert (
            client.request("DELETE", path, json={"expected_version": 1}, headers=headers).json()[
                "version"
            ]
            == 2
        )
        assert client.put(path, json=payload(), headers=headers).status_code == 409
        assert client.put(path, json=payload(2), headers=headers).json()["version"] == 3
        for bad in (
            {"shuffle": "true"},
            {"enabled": 1},
            {"playback_profile_id": "script.play"},
            {"media_type": "track"},
            {"input": "spotify:playlist:0123456789ABCDEFGHIJKL"},
            {"ha_tag_id": ""},
            {"ha_tag_id": "different"},
            {"ha_tag_id": "\ud800"},
            {"expected_version": True},
        ):
            assert (
                client.put(
                    path,
                    content=json.dumps({**payload(3), **bad}),
                    headers={**headers, "Content-Type": "application/json"},
                ).status_code
                == 422
            )
        assert (
            client.put(
                path, json=payload(3), headers={"Origin": settings.public_origin}
            ).status_code
            == 403
        )
        assert (
            client.put(
                path, json=payload(3), headers={"X-CSRF-Token": headers["X-CSRF-Token"]}
            ).status_code
            == 403
        )
        assert (
            client.put(
                path, content="x" * 9000, headers={**headers, "Content-Type": "application/json"}
            ).status_code
            == 413
        )
        link = "https://open.spotify.com/album/0123456789ABCDEFGHIJKL?si=synthetic"
        assert (
            client.put(path, json={**payload(3), "input": link}, headers=headers).json()[
                "assignment"
            ]["spotify_uri"]
            == URI
        )


def test_read_only_enforced_and_audit_sanitized(settings: Settings) -> None:
    from sqlalchemy import text

    from jukelet.assignments import AssignmentInput, AssignmentStore
    from jukelet.storage import migrate, open_database

    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        assert (
            client.put(
                f"/api/v1/tags/{tag_key(TAG)}/assignment", json=payload(), headers=headers
            ).status_code
            == 403
        )
    engine = open_database(settings.database_path)
    migrate(engine)
    store = AssignmentStore(engine)
    for version in range(1002):
        store.put(AssignmentInput.model_validate(payload(version)))
    with engine.connect() as connection:
        rows = connection.execute(text("SELECT * FROM assignment_audit")).mappings().all()
        assert len(rows) == 1000
        assert TAG not in str(rows) and URI not in str(rows)
        assert {row["action"] for row in rows} == {"save"}
    engine.dispose()
