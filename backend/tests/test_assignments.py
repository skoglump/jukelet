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


def test_confirmation_requires_reviewed_preview_and_preserves_rejected_rows(
    settings: Settings,
) -> None:
    settings = replace(settings, mode="manage")
    content = (
        '{"variables":{"tags":{"  Å/04:ab  ":{"media_content_type":"album","media_content_id":"'
        + URI
        + '"},"track":{"media_content_type":"track","media_content_id":"'
        'spotify:track:0123456789ABCDEFGHIJKL"}}}}'
    )
    source = {"source": "upload", "format": "json", "content": content}
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        report = client.post("/api/v1/imports/preview", json=source, headers=headers).json()
        assert report.get("preview_token"), "A source hash alone must not authorize an import"
        confirmation = {
            **source,
            "preview_token": report["preview_token"],
            "fingerprint": report["fingerprint"],
            "conflict_policy": "reject",
            "enabled": False,
            "shuffle": True,
            "playback_profile_id": "default",
        }
        result = client.post("/api/v1/imports/confirm", json=confirmation, headers=headers)
        assert result.status_code == 200
        assert (
            result.json()["imported"] == 1
            and result.json()["report"]["rows"][1]["accepted"] is False
        )
        assert client.get("/api/v1/assignments").json()["assignments"][0]["enabled"] is False
        assert (
            client.post("/api/v1/imports/confirm", json=confirmation, headers=headers).status_code
            == 409
        )


def test_import_revalidates_source_local_revision_policy_and_rolls_back(settings: Settings) -> None:
    import json

    settings = replace(settings, mode="manage")
    mapping = {"media_content_type": "album", "media_content_id": URI}
    source = {
        "source": "upload",
        "format": "json",
        "content": json.dumps({"variables": {"tags": {"new-first": mapping, TAG: mapping}}}),
    }
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        path = f"/api/v1/tags/{tag_key(TAG)}/assignment"
        client.put(path, json=payload(), headers=headers)

        def confirmation() -> dict[str, object]:
            report = client.post("/api/v1/imports/preview", json=source, headers=headers).json()
            return {
                **source,
                "preview_token": report["preview_token"],
                "fingerprint": report["fingerprint"],
                "conflict_policy": "reject",
                "enabled": True,
                "shuffle": False,
                "playback_profile_id": "default",
            }

        value = confirmation()
        assert (
            client.post(
                "/api/v1/imports/confirm",
                json={**value, "content": source["content"] + " "},
                headers=headers,
            ).status_code
            == 409
        )
        assert (
            client.post(
                "/api/v1/imports/confirm",
                json={**value, "preview_token": "f" * 43},
                headers=headers,
            ).status_code
            == 409
        )
        assert (
            client.post(
                "/api/v1/imports/confirm",
                json={key: item for key, item in value.items() if key != "conflict_policy"},
                headers=headers,
            ).status_code
            == 422
        )
        # First row would be new; the second conflict must roll the entire transaction back.
        assert (
            client.post("/api/v1/imports/confirm", json=value, headers=headers).status_code == 409
        )
        assert client.get("/api/v1/assignments").json()["total"] == 1
        assert client.get(f"/api/v1/tags/{tag_key('new-first')}/assignment").json()["version"] == 0
        client.put(path, json=payload(1), headers=headers)
        assert (
            client.post(
                "/api/v1/imports/confirm",
                json={**value, "conflict_policy": "replace"},
                headers=headers,
            ).status_code
            == 409
        )
        value = confirmation()
        result = client.post(
            "/api/v1/imports/confirm", json={**value, "conflict_policy": "skip"}, headers=headers
        )
        assert result.json()["imported"] == 1 and result.json()["skipped"] == 1
        assert client.get(path).json()["assignment"]["enabled"] is False
        value = confirmation()
        result = client.post(
            "/api/v1/imports/confirm", json={**value, "conflict_policy": "replace"}, headers=headers
        )
        assert result.json()["imported"] == 2
        assert client.get(path).json()["assignment"]["enabled"] is True


def test_configured_confirmation_rereads_source_and_only_calls_get(
    settings: Settings, monkeypatch: object
) -> None:
    import json

    import httpx
    from pytest import MonkeyPatch

    from jukelet.ha.adapter import HAAdapter
    from jukelet.ha.rest import RestClient

    assert isinstance(monkeypatch, MonkeyPatch)
    settings = replace(settings, mode="manage")
    raw = json.dumps(
        {
            "variables": {"tags": {TAG: {"media_content_type": "album", "media_content_id": URI}}},
            "private": "never-return",
        }
    )
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return (
            httpx.Response(200, json={"attributes": {"id": "synthetic"}})
            if "/states/" in request.url.path
            else httpx.Response(200, text=raw)
        )

    adapter = HAAdapter(
        None,
        None,
        rest=RestClient(
            "https://ha.example",
            "synthetic-token",
            legacy_entity="automation.synthetic",
            transport=httpx.MockTransport(handler),
        ),
    )
    monkeypatch.setattr("jukelet.main.HAAdapter", lambda *args, **kwargs: adapter)
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        report = client.post(
            "/api/v1/imports/preview", json={"source": "configured"}, headers=headers
        ).json()
        value = {
            "source": "configured",
            "preview_token": report["preview_token"],
            "fingerprint": report["fingerprint"],
            "conflict_policy": "reject",
            "enabled": True,
            "shuffle": False,
            "playback_profile_id": "default",
        }
        raw += " "
        assert (
            client.post("/api/v1/imports/confirm", json=value, headers=headers).status_code == 409
        )
        assert client.get("/api/v1/assignments").json()["total"] == 0
        report = client.post(
            "/api/v1/imports/preview", json={"source": "configured"}, headers=headers
        ).json()
        result = client.post(
            "/api/v1/imports/confirm",
            json={
                **value,
                "preview_token": report["preview_token"],
                "fingerprint": report["fingerprint"],
            },
            headers=headers,
        )
        assert result.status_code == 200 and "never-return" not in result.text
        assert len(requests) == 8 and all(request.method == "GET" for request in requests)


def test_preview_token_session_binding_expiry_and_import_security(
    settings: Settings, monkeypatch: object
) -> None:
    from pytest import MonkeyPatch

    assert isinstance(monkeypatch, MonkeyPatch)
    settings = replace(settings, mode="manage")
    source = {"source": "upload", "format": "json", "content": '{"variables":{"tags":{}}}'}
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        headers = login(client, settings)
        report = client.post("/api/v1/imports/preview", json=source, headers=headers).json()
        value = {
            **source,
            "preview_token": report["preview_token"],
            "fingerprint": report["fingerprint"],
            "conflict_policy": "reject",
            "enabled": True,
            "shuffle": False,
            "playback_profile_id": "default",
        }
        assert (
            client.post(
                "/api/v1/imports/confirm", json=value, headers={"Origin": settings.public_origin}
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/api/v1/imports/confirm",
                json=value,
                headers={"X-CSRF-Token": headers["X-CSRF-Token"]},
            ).status_code
            == 403
        )
        headers = login(client, settings)  # new owner session cannot reuse the earlier proof
        assert (
            client.post("/api/v1/imports/confirm", json=value, headers=headers).status_code == 409
        )
        report = client.post("/api/v1/imports/preview", json=source, headers=headers).json()
        value.update(preview_token=report["preview_token"], fingerprint=report["fingerprint"])
        from types import SimpleNamespace

        monkeypatch.setattr(
            "jukelet.import_confirmation.time", SimpleNamespace(monotonic=lambda: float("inf"))
        )
        assert (
            client.post("/api/v1/imports/confirm", json=value, headers=headers).status_code == 409
        )
        assert client.get("/api/v1/assignments").json()["total"] == 0
