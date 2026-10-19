"""Synthetic SpotifyPlus service fixtures, based on public model ToDictionary shapes.

No captured account data. See docs/13-spotifyplus-preview.md for provenance.
"""

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx

from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import Capability
from jukelet.ha.rest import SERVICE_FIELDS, RestClient
from jukelet.providers.spotifyplus import SpotifyPlus

ID = "0123456789ABCDEFGHIJKL"
URI = f"spotify:album:{ID}"
ALBUM = {
    "uri": URI,
    "type": "album",
    "name": "Synthetic album",
    "artists": [{"name": "Fixture artist"}],
    "images": [{"url": "https://i.scdn.co/image/synthetic"}],
}


def fixture(handler: Callable[[httpx.Request], httpx.Response]) -> HAAdapter:
    ha = HAAdapter(
        None,
        None,
        rest=RestClient(
            "https://ha.example", "synthetic-token", transport=httpx.MockTransport(handler)
        ),
    )
    ha.status.services = {
        name: Capability(state="supported", fields=sorted(fields), response=True)
        for name, fields in SERVICE_FIELDS.items()
    }
    return ha


def response_fixture(payload: Any) -> HAAdapter:
    return fixture(lambda request: httpx.Response(200, json={"service_response": payload}))


def test_detail_normalizes_and_preserves_last_good_after_lookup_failure() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []
        now = [0.0]

        def handle(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if len(requests) > 1:
                return httpx.Response(404, json={"private": "not returned"})
            return httpx.Response(
                200,
                json={"service_response": {"result": ALBUM, "user_profile": {"private": "hidden"}}},
            )

        ha = fixture(handle)
        provider = SpotifyPlus(ha, "media_player.synthetic", clock=lambda: now[0])
        first = await provider.resolve(URI, "album")
        assert first.state == "fresh" and first.item is not None
        assert first.item.title == "Synthetic album" and first.item.subtitle == "Fixture artist"
        assert first.item.artwork_url == "https://i.scdn.co/image/synthetic"
        assert await provider.resolve(URI, "album") == first
        assert len(requests) == 1
        now[0] = 301
        failed = await provider.resolve(URI, "album")
        assert failed.state == "stale" and failed.error == "not_found"
        assert failed.uri == URI and failed.item == first.item
        assert failed.last_success_at == first.last_success_at
        assert failed.last_attempt_at != first.last_attempt_at
        assert "private" not in failed.model_dump_json()
        assert json.loads(requests[0].content) == {
            "entity_id": "media_player.synthetic",
            "album_id": ID,
        }
        assert requests[0].url.path == "/api/services/spotifyplus/get_album"
        await ha.close()

    asyncio.run(scenario())


def test_library_and_nested_search_pages_and_independent_capabilities() -> None:
    async def scenario() -> None:
        requests: list[httpx.Request] = []
        playlist = {
            "uri": f"spotify:playlist:{ID}",
            "type": "playlist",
            "name": "Synthetic playlist",
            "owner": {"display_name": "Fixture owner"},
            "images": [],
        }

        def handle(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            service = request.url.path.rsplit("/", 1)[1]
            params = json.loads(request.content)
            offset = params.get("offset", 0)
            item = (
                {"album": ALBUM, "added_at": "2026-10-19T00:00:00Z"}
                if service == "get_album_favorites"
                else playlist
            )
            page = {
                "items": [item] if offset == 0 else [],
                "total": 1,
                "offset": offset,
                "limit": 20,
            }
            result = {"playlists": page} if service == "search_playlists" else page
            return httpx.Response(
                200, json={"service_response": {"media_player.synthetic": {"result": result}}}
            )

        ha = fixture(handle)
        provider = SpotifyPlus(ha, "media_player.synthetic")
        assert set(provider.capabilities().values()) == {"supported"}
        ha.status.services["search_albums"].fields.remove("limit")
        assert provider.capabilities()["album_search"] == "unsupported"
        assert provider.capabilities()["playlist_search"] == "supported"
        assert (await provider.search("album", "fixture")).error == "unsupported_operation"
        library = await provider.library("album")
        assert library.items[0].uri == URI and library.total == 1 and library.next_offset is None
        search = await provider.search("playlist", "fixture")
        assert search.items[0].subtitle == "Fixture owner"
        empty = await provider.library("playlist", 1)
        assert empty.items == [] and empty.total == 1 and empty.error is None
        assert len(requests) == 3
        assert json.loads(requests[0].content) == {
            "entity_id": "media_player.synthetic",
            "offset": 0,
            "limit": 20,
        }
        await ha.close()

    asyncio.run(scenario())


def test_malformed_results_are_explicit_failures_not_empty_successes() -> None:
    async def scenario() -> None:
        cases: list[Any] = [
            {},
            {"unknown": {"items": []}},
            {"result": {}},
            {"result": {"items": []}},
            {"result": {"items": [], "total": 3, "offset": 0, "limit": 20}},
            {"result": {"items": [], "total": False, "offset": 0, "limit": 20}},
            {"result": {"items": [None], "total": 1, "offset": 0, "limit": 20}},
            {"result": {"items": [ALBUM], "total": 1, "offset": 1, "limit": 20}},
            {"result": {"items": [ALBUM] * 21, "total": 21, "offset": 0, "limit": 21}},
        ]
        for payload in cases:
            ha = response_fixture(payload)
            result = await SpotifyPlus(ha, "media_player.synthetic").search("album", "fixture")
            assert result.error == "unsupported_response" and result.state == "unavailable"
            assert result.last_success_at is None
            await ha.close()
        for item in (
            {**ALBUM, "name": None},
            {**ALBUM, "uri": f"spotify:album:{'Z' * 22}"},
            {**ALBUM, "type": "playlist"},
        ):
            ha = response_fixture({"result": item})
            assert (
                await SpotifyPlus(ha, "media_player.synthetic").resolve(URI, "album")
            ).error == "unsupported_response"
            await ha.close()

    asyncio.run(scenario())


def test_rate_limit_has_bounded_global_backoff_and_no_automatic_retries() -> None:
    async def scenario() -> None:
        now = [0.0]
        calls = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(429, json={"secret": "never exposed"})

        ha = fixture(handle)
        provider = SpotifyPlus(ha, "media_player.synthetic", clock=lambda: now[0])
        for delay in [30, 60, 120, 240, 300, 300]:
            result = await provider.resolve(URI, "album")
            assert result.error == "rate_limited" and result.retry_after == delay
            count = len(calls)
            assert (await provider.search("album", "other request")).error == "rate_limited"
            assert len(calls) == count
            assert (await provider.resolve(URI, "album")).retry_after == delay
            now[0] += delay
        assert len(calls) == 6
        await ha.close()

    asyncio.run(scenario())


def test_cache_eviction_retention_and_account_isolation() -> None:
    async def scenario() -> None:
        now = [0.0]
        calls = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(
                200,
                json={
                    "service_response": {
                        "result": {"items": [], "total": 0, "offset": 0, "limit": 20}
                    }
                },
            )

        ha = fixture(handle)
        first = SpotifyPlus(ha, "media_player.first", clock=lambda: now[0])
        second = SpotifyPlus(ha, "media_player.second", clock=lambda: now[0])
        await first.search("album", "shared")
        await first.search("album", "shared")
        await second.search("album", "shared")
        assert len(calls) == 2
        assert json.loads(calls[-1].content)["entity_id"] == "media_player.second"
        for i in range(128):
            await first.search("album", str(i))
        await first.search("album", "shared")
        assert len(calls) == 131
        now[0] = 86401
        ha.status.services["search_albums"].state = "unsupported"
        expired = await first.search("album", "shared")
        assert expired.last_success_at is None and expired.state == "unavailable"
        await ha.close()

    asyncio.run(scenario())


def test_concurrent_requests_are_coalesced_and_admission_is_bounded() -> None:
    async def scenario() -> None:
        entered, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def handle(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            return httpx.Response(200, json={"service_response": {"result": ALBUM}})

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
        provider = SpotifyPlus(ha, "media_player.synthetic")
        tasks = [asyncio.create_task(provider.resolve(URI, "album")) for _ in range(8)]
        await entered.wait()
        overflow = await provider.resolve(URI, "album")
        assert overflow.error == "unavailable" and overflow.retry_after == 1
        release.set()
        results = await asyncio.gather(*tasks)
        assert all(result.state == "fresh" for result in results) and calls == 1
        await ha.close()

    asyncio.run(scenario())


def test_uri_validation_never_fetches_supplied_links() -> None:
    from jukelet.providers.spotifyplus import parse_uri

    assert (
        parse_uri(f"https://open.spotify.com/album/{ID}?si=fixture&utm_source=test", "album") == URI
    )
    assert parse_uri(URI, "album") == URI
    invalid = [
        URI + " ",
        URI.replace("album", "track"),
        URI[:-1],
        URI + "A",
        URI.lower() + "?si=x",
        f"http://open.spotify.com/album/{ID}",
        f"https://open.spotify.com:443/album/{ID}",
        f"https://user@open.spotify.com/album/{ID}",
        f"https://open.spotify.com.evil/album/{ID}",
        f"https://open.spotify.com/album/{ID}#fragment",
        f"https://open.spotify.com/album/{ID}?unknown=x",
        f"https://open.spotify.com/album/{ID}/",
        f"https://open.spotify.com/intl-sv/album/{ID}",
        "https://spotify.link/short",
        "file:///etc/passwd",
        f"\x00https://open.spotify.com/album/{ID}",
        f"\x1fhttps://open.spotify.com/album/{ID}",
        f"spotify:playlist:{ID}",
        f"https://open.spotify.com/album/%30{ID[1:]}",
        f"https://open.spotify.com/album/{ID}\n",
    ]

    async def scenario() -> None:
        calls = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(200, json={"service_response": {"result": ALBUM}})

        ha = fixture(handle)
        provider = SpotifyPlus(ha, "media_player.synthetic")
        for value in invalid:
            try:
                await provider.resolve(value, "album")
            except ValueError:
                pass
            else:
                raise AssertionError(f"Accepted unsupported fixture input: {value}")
        assert calls == []
        assert (
            await provider.resolve(f"https://open.spotify.com/album/{ID}?si=synthetic", "album")
        ).state == "fresh"
        assert len(calls) == 1 and calls[0].url.host == "ha.example"
        await ha.close()

    asyncio.run(scenario())


def test_failure_categories_preserve_playlist_mix_and_artwork() -> None:
    async def scenario() -> None:
        playlist: dict[str, Any] = {
            **ALBUM,
            "type": "playlist",
            "uri": f"spotify:playlist:{ID}",
            "name": "Synthetic Mix",
        }
        for status, code in (
            (401, "unauthorized"),
            (403, "forbidden"),
            (404, "not_found"),
            (429, "rate_limited"),
            (500, "unavailable"),
        ):
            now = [0.0]
            calls: list[httpx.Request] = []

            def handle(
                request: httpx.Request, status: int = status, calls: list[httpx.Request] = calls
            ) -> httpx.Response:
                calls.append(request)
                return (
                    httpx.Response(200, json={"service_response": {"result": playlist}})
                    if len(calls) == 1
                    else httpx.Response(status, json={"private": "hidden"})
                )

            ha = fixture(handle)

            def clock(now: list[float] = now) -> float:
                return now[0]

            provider = SpotifyPlus(ha, "media_player.synthetic", clock=clock)
            success = await provider.resolve(playlist["uri"], "playlist")
            assert success.item is not None
            now[0] = 301
            failure = await provider.resolve(playlist["uri"], "playlist")
            assert (
                failure.error == code and failure.state == "stale" and failure.item == success.item
            )
            assert failure.uri == playlist["uri"]
            assert json.loads(calls[0].content)["exclude_items"] is True
            await ha.close()

    asyncio.run(scenario())


def test_pagination_stops_at_bound_and_never_follows_next_urls() -> None:
    async def scenario() -> None:
        calls = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            offset = json.loads(request.content)["offset"]
            return httpx.Response(
                200,
                json={
                    "service_response": {
                        "result": {
                            "items": [{"album": ALBUM}] * 20,
                            "total": 5000,
                            "offset": offset,
                            "limit": 20,
                            "next": "https://untrusted.example/private",
                        }
                    }
                },
            )

        ha = fixture(handle)
        provider = SpotifyPlus(ha, "media_player.synthetic")
        assert (await provider.library("album", 980)).next_offset == 1000
        assert (await provider.library("album", 1000)).next_offset is None
        for offset in (-1, 1001, True):
            try:
                await provider.library("album", offset)
            except ValueError:
                pass
            else:
                raise AssertionError("Unsupported offset accepted")
        assert len(calls) == 2 and all(call.url.host == "ha.example" for call in calls)
        await ha.close()

    asyncio.run(scenario())


def test_timeout_and_untrusted_artwork_are_bounded() -> None:
    async def scenario() -> None:
        def timeout(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("synthetic private detail")

        ha = fixture(timeout)
        failed = await SpotifyPlus(ha, "media_player.synthetic").resolve(URI, "album")
        assert failed.error == "timeout" and failed.uri == URI and failed.item is None
        assert "private" not in failed.model_dump_json()
        await ha.close()
        untrusted = response_fixture(
            {"result": {**ALBUM, "images": [{"url": "https://untrusted.example/track-user"}]}}
        )
        value = await SpotifyPlus(untrusted, "media_player.synthetic").resolve(URI, "album")
        assert value.item is not None and value.item.artwork_url is None
        await untrusted.close()
        malformed = response_fixture({"result": {**ALBUM, "images": [{"url": "https://[invalid"}]}})
        assert (
            await SpotifyPlus(malformed, "media_player.synthetic").resolve(URI, "album")
        ).error == "unsupported_response"
        await malformed.close()

    asyncio.run(scenario())
