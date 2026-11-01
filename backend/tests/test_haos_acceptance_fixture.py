"""Synthetic fixture contract against app interfaces; not native HA evidence."""

import asyncio
import copy
import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import Capability
from jukelet.ha.rest import RestClient
from jukelet.providers.spotifyplus import SpotifyPlus
from scripts.haos_acceptance.fixture.custom_components.jukelet_acceptance import async_setup
from scripts.haos_acceptance.fixture.custom_components.jukelet_acceptance.policy import (
    ALBUM_ID,
    ENTITY_ID,
    FIXTURE,
    PLAYLIST_ID,
    READER_ID,
    SERVICES,
    TAG_ALBUM,
    TAG_INBOX,
    TAG_PLAYLIST,
    FixtureState,
    SyntheticUnavailable,
    control_request,
    digest,
    fixture_config,
    script_document,
)


def test_fixture_requires_an_explicit_exact_synthetic_configuration() -> None:
    assert fixture_config({"fixture": FIXTURE, "synthetic": True})
    for value in (
        {},
        {"fixture": FIXTURE, "synthetic": 1},
        {"fixture": "household", "synthetic": True},
    ):
        assert not fixture_config(value)


def test_ha_adapter_refuses_missing_opt_in_and_foreign_services_before_loading_ha() -> None:
    async def scenario() -> None:
        def fake(*, services: dict[str, Any] | None = None, entity: Any = None) -> Any:
            return SimpleNamespace(
                services=SimpleNamespace(async_services=lambda: services or {}),
                states=SimpleNamespace(get=lambda _: entity),
                data={},
            )

        opted_in = {"jukelet_acceptance": {"fixture": FIXTURE, "synthetic": True}}
        assert not await async_setup(fake(), {})
        assert not await async_setup(
            fake(services={"spotifyplus": {"existing": object()}}), opted_in
        )
        assert not await async_setup(fake(entity=object()), opted_in)

    asyncio.run(scenario())


def test_only_fixed_synthetic_tag_scans_and_bounded_metadata_controls_are_accepted() -> None:
    assert control_request({"action": "status"}) == {"action": "status"}
    assert control_request({"action": "metadata", "mode": "unavailable"}) == {
        "action": "metadata",
        "mode": "unavailable",
    }
    for tag in (TAG_ALBUM, TAG_PLAYLIST, TAG_INBOX):
        assert control_request({"action": "scan", "tag_id": tag}) == {
            "action": "scan",
            "tag_id": tag,
            "reader_id": READER_ID,
        }
    for value in (
        {"action": "scan", "tag_id": TAG_ALBUM.strip()},
        {"action": "scan", "tag_id": TAG_ALBUM, "reader_id": "other"},
        {"action": "scan", "tag_id": "household"},
        {"action": "metadata", "mode": "https://provider.example"},
        {"action": "status", "script": "script.unrelated"},
        {"action": "publish"},
    ):
        with pytest.raises(ValueError):
            control_request(value)


def test_synthetic_metadata_shapes_work_through_the_existing_provider_boundary() -> None:
    async def scenario() -> None:
        state = FixtureState()

        def respond(request: httpx.Request) -> httpx.Response:
            service = request.url.path.rsplit("/", 1)[1]
            assert request.url.host == "synthetic.invalid"
            try:
                body = state.metadata(service, json.loads(request.content))
            except SyntheticUnavailable:
                return httpx.Response(500, json={"message": "synthetic unavailable"})
            return httpx.Response(200, json={"service_response": body})

        rest = RestClient(
            "https://synthetic.invalid",
            "synthetic-local-token",
            transport=httpx.MockTransport(respond),
        )
        ha = HAAdapter(None, None, rest=rest)
        ha.status.services = {
            name: Capability(state="supported", fields=sorted(fields), response=True)
            for name, fields in SERVICES.items()
        }
        now = [0.0]
        provider = SpotifyPlus(ha, ENTITY_ID, clock=lambda: now[0])
        try:
            album = await provider.resolve("spotify:album:" + ALBUM_ID, "album")
            playlist = await provider.resolve("spotify:playlist:" + PLAYLIST_ID, "playlist")
            assert album.state == playlist.state == "fresh"
            assert album.item is not None and album.item.title == "Synthetic Jukelet62 album"
            assert (
                playlist.item is not None and playlist.item.title == "Synthetic Jukelet62 playlist"
            )
            assert album.item.artwork_url is playlist.item.artwork_url is None
            assert (await provider.library("album")).items == [album.item]
            assert (await provider.library("playlist")).items == [playlist.item]
            assert (await provider.search("album", "synthetic Å & fixture")).items == [album.item]
            assert (await provider.search("playlist", "synthetic Å & fixture")).items == [
                playlist.item
            ]
            state.mode = "unavailable"
            now[0] = 301
            fallback = await provider.resolve("spotify:album:" + ALBUM_ID, "album")
            assert fallback.state == "stale" and fallback.item == album.item
            assert fallback.uri == album.uri and fallback.error == "unavailable"
            state.mode = "malformed"
            malformed = await provider.resolve("spotify:playlist:" + PLAYLIST_ID, "playlist")
            assert malformed.state == "stale" and malformed.item == playlist.item
            assert malformed.error == "unsupported_response"
            assert state.metadata_calls == 8
        finally:
            await ha.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("service", "data"),
    [
        ("play_media", {"entity_id": ENTITY_ID}),
        ("get_album", {"entity_id": "media_player.household", "album_id": ALBUM_ID}),
        ("get_album", {"entity_id": ENTITY_ID, "album_id": "not-synthetic"}),
        ("get_album", {"entity_id": ENTITY_ID, "album_id": ALBUM_ID, "template": "unsafe"}),
        ("search_albums", {"entity_id": ENTITY_ID, "criteria": "", "limit": 20}),
        ("search_albums", {"entity_id": ENTITY_ID, "criteria": "synthetic", "limit": True}),
        ("get_album_favorites", {"entity_id": ENTITY_ID, "offset": -1, "limit": 20}),
    ],
)
def test_fixture_provider_refuses_other_accounts_actions_and_unbounded_inputs(
    service: str, data: dict[str, Any]
) -> None:
    state = FixtureState()
    with pytest.raises(ValueError):
        state.metadata(service, data)
    assert state.metadata_calls == 0


def request() -> dict[str, Any]:
    return {
        "tag_id": TAG_ALBUM,
        "media_type": "album",
        "spotify_uri": "spotify:album:" + ALBUM_ID,
        "enabled": True,
        "shuffle": False,
        "playback_profile_id": "default",
        "snapshot_revision": 17,
        "correlation_id": "7a2f78d0-0f01-4ec9-8372-bb60b918ba56",
        "reader_id": READER_ID,
    }


def test_independent_fixture_observer_counts_exact_requests_without_claiming_playback() -> None:
    state = FixtureState()
    value = request()
    original = copy.deepcopy(value)
    state.observe_script_call(value)
    value["tag_id"] = "changed"
    status = state.status()
    assert status["script_invocations"] == 1 and status["unexpected_script_calls"] == 0
    assert status["captures"] == [{"request": original, "request_sha256": digest(original)}]
    assert status["independent_playback_verification"] == "unavailable"
    status["captures"][0]["request"]["tag_id"] = "changed again"
    assert state.status()["captures"][0]["request"]["tag_id"] == TAG_ALBUM
    for _ in range(40):
        state.observe_script_call(original)
    assert state.script_invocations == 41 and len(state.status()["captures"]) == 32


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("tag_id", TAG_ALBUM.strip()),
        ("spotify_uri", "spotify:album:" + "X" * 22),
        ("media_type", "playlist"),
        ("enabled", 1),
        ("shuffle", 1),
        ("snapshot_revision", True),
        ("snapshot_revision", 0),
        ("playback_profile_id", "other"),
        ("reader_id", "other"),
        ("correlation_id", "not-a-uuid"),
        ("token", "SYNTHETIC_PRIVATE_SENTINEL"),
    ],
)
def test_observer_does_not_retain_invalid_or_foreign_script_input(key: str, value: Any) -> None:
    state = FixtureState()
    data = request()
    data[key] = value
    state.observe_script_call(data)
    report = state.status()
    assert report["script_invocations"] == report["unexpected_script_calls"] == 1
    assert report["captures"] == []
    assert "SYNTHETIC_PRIVATE_SENTINEL" not in json.dumps(report)


def test_inert_script_has_only_variables_and_correlated_stop_response() -> None:
    script = script_document()
    assert script["mode"] == "single"
    assert [set(step) for step in script["sequence"]] == [
        {"variables"},
        {"stop", "response_variable"},
    ]
    assert script["sequence"][-1]["response_variable"] == "result"
    assert "correlation_id=correlation_id" in script["sequence"][0]["variables"]["result"]
