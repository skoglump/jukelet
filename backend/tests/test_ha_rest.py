"""Synthetic fixtures only: no household addresses, tokens, or metadata."""

import asyncio
from typing import Any

import httpx
import pytest

from jukelet.ha.models import MAX_BYTES, HAError
from jukelet.ha.rest import SERVICE_FIELDS, RestClient, capabilities


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def service_fixture() -> list[dict[str, Any]]:
    return [
        {
            "domain": "spotifyplus",
            "services": {
                name: {"fields": {field: {} for field in fields}, "response": {"optional": False}}
                for name, fields in SERVICE_FIELDS.items()
            },
        }
    ]


@pytest.mark.anyio
async def test_allowlist_metadata_and_response_boundary() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"service_response": {"result": "synthetic"}})

    rest = RestClient(
        "https://ha.example", "synthetic-token", transport=httpx.MockTransport(handler)
    )
    caps = capabilities(service_fixture())
    for operation in (
        "tag/update",
        "config/automation",
        "media_player/play_media",
        "switch/turn_on",
        "media_player/volume_set",
        "tag_scanned",
    ):
        with pytest.raises(HAError, match="unsupported_operation"):
            await rest.read(operation)
        with pytest.raises(HAError, match="unsupported_operation"):
            await rest.metadata(operation, {}, caps)
    for data in (
        {"entity_id": "synthetic"},
        {"entity_id": "synthetic", "album_id": ""},
        {"entity_id": "synthetic", "album_id": "explicit", "arbitrary": True},
    ):
        with pytest.raises(HAError, match="unsupported_operation"):
            await rest.metadata("get_album", data, caps)
    assert requests == []
    assert await rest.metadata(
        "get_album", {"entity_id": "media_player.synthetic", "album_id": "explicit"}, caps
    ) == {"result": "synthetic"}
    assert (
        requests[0].url == "https://ha.example/api/services/spotifyplus/get_album?return_response"
    )
    assert requests[0].headers["Authorization"] == "Bearer synthetic-token"
    await rest.close()


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "unauthorized"),
        (403, "forbidden"),
        (404, "not_found"),
        (429, "rate_limited"),
        (500, "unavailable"),
        (302, "unavailable"),
    ],
)
async def test_normalized_errors_and_no_redirect(status: int, code: str) -> None:
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            status, headers={"Location": "https://other.example"}, text="PRIVATE raw error"
        )

    rest = RestClient("https://ha.example", "synthetic", transport=httpx.MockTransport(handler))
    with pytest.raises(HAError, match=code) as error:
        await rest.read("config")
    assert "PRIVATE" not in str(error.value)
    assert len(requests) == 1
    await rest.close()


@pytest.mark.anyio
@pytest.mark.parametrize("body", [b"not JSON", b"[" * 2000, b" " * (MAX_BYTES + 1)])
async def test_malformed_and_oversized_rest(body: bytes) -> None:
    rest = RestClient(
        "https://ha.example",
        "synthetic",
        transport=httpx.MockTransport(lambda _: httpx.Response(200, content=body)),
    )
    with pytest.raises(HAError, match="unsupported_response"):
        await rest.read("config")
    await rest.close()


@pytest.mark.anyio
async def test_total_rest_deadline() -> None:
    async def delayed(_: httpx.Request) -> httpx.Response:
        await asyncio.sleep(1)
        return httpx.Response(200, json={})

    rest = RestClient(
        "https://ha.example", "synthetic", timeout=0.01, transport=httpx.MockTransport(delayed)
    )
    with pytest.raises(HAError, match="timeout"):
        await rest.read("config")
    await rest.close()


def test_capability_contracts_are_independent_and_sanitized() -> None:
    fixture = service_fixture()
    services = fixture[0]["services"]
    services.pop("get_album")
    services["get_playlist"].pop("response")
    services["search_albums"]["fields"]["private_argument"] = {"required": True}
    services["search_playlists"]["description"] = "PRIVATE"
    result = capabilities(fixture)
    assert result["get_album"].state == "unsupported"
    assert result["get_playlist"].state == "unsupported"
    assert result["search_albums"].state == "unsupported"
    assert result["search_playlists"].state == "supported"
    assert "PRIVATE" not in str(result)
    invalid_values: list[Any] = [{}, [None], [{"domain": "spotifyplus", "services": []}]]
    for invalid in invalid_values:
        with pytest.raises(HAError, match="unsupported_response"):
            capabilities(invalid)


@pytest.mark.anyio
async def test_configured_automation_uses_only_narrow_gets_and_keeps_duplicates() -> None:
    requests: list[httpx.Request] = []
    source = '{"variables":{"tags":{"exact":{},"exact":{}}},"private":"SECRET"}'

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/api/states/automation.synthetic_jukebox":
            return httpx.Response(200, json={"attributes": {"id": "synthetic_123"}})
        assert request.url.path == "/api/config/automation/config/synthetic_123"
        return httpx.Response(200, text=source)

    rest = RestClient(
        "https://ha.example",
        "synthetic-token",
        transport=httpx.MockTransport(handler),
        legacy_entity="automation.synthetic_jukebox",
    )
    assert await rest.legacy_configuration() == source
    assert all(request.method == "GET" for request in requests)
    assert len(requests) == 2
    await rest.close()


@pytest.mark.anyio
@pytest.mark.parametrize("config_id", ["../secrets", "a/b", "a?query", "", 123, None])
async def test_legacy_config_id_never_becomes_arbitrary_path(config_id: Any) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"attributes": {"id": config_id}})

    rest = RestClient(
        "https://ha.example",
        "synthetic",
        legacy_entity="automation.synthetic",
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(HAError, match="unsupported_response"):
        await rest.legacy_configuration()
    assert len(requests) == 1
    await rest.close()
