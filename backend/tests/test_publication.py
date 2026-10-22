"""Synthetic app publication; no household transport or playback is allowed."""

from dataclasses import replace

from fastapi.testclient import TestClient
from test_assignments import login, payload

from jukelet.config import Settings
from jukelet.inventory import tag_key
from jukelet.main import create_app


def test_publication_exposes_saved_content_without_implicitly_publishing(
    settings: Settings,
) -> None:
    settings = replace(settings, mode="manage")
    with TestClient(create_app(settings), base_url=settings.public_origin) as client:
        assert client.get("/api/v1/publication").status_code == 401
        headers = login(client, settings)
        client.put(
            f"/api/v1/tags/{tag_key(str(payload()['ha_tag_id']))}/assignment",
            json=payload(),
            headers=headers,
        )
        response = client.get("/api/v1/publication")
        assert response.status_code == 200
        status = response.json()
        assert status["desired_version"] == 1
        assert status["automatic_enabled"] is False
        assert status["jobs"] == []
        assert status["verified"] is False
        assert status["playback_verified"] is None


def test_canonical_golden_vectors_and_invalid_publication_ids() -> None:
    import json
    from pathlib import Path

    import pytest

    from jukelet.publication_protocol import canonical, checksum
    from jukelet.publication_protocol import payload as snapshot_payload

    vectors = json.loads(
        (Path(__file__).parents[2] / "spikes/ha_companion/vectors/checksums.json").read_text()
    )
    for vector in vectors:
        assert checksum(vector["payload"]) == vector["sha256"]
        assert (
            canonical(
                {
                    "schema_version": 1,
                    "payload": snapshot_payload(list(reversed(vector["payload"]["mappings"]))),
                }
            ).decode()
            == vector["canonical_utf8"]
        )
    row = vectors[1]["payload"]["mappings"][0]
    for changed in (
        {"tag_id": "Å" * 129},
        {"tag_id": "a\nb"},
        {"tag_id": "\ud800"},
        {"shuffle": 1},
        {"enabled": "true"},
        {"media_type": "track"},
        {"spotify_uri": "spotify:playlist:" + "A" * 22},
        {"playback_profile_id": "script.other"},
    ):
        with pytest.raises(ValueError):
            snapshot_payload([{**row, **changed}])
    with pytest.raises(ValueError):
        snapshot_payload([row, row])
