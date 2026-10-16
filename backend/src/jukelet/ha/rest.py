"""A fixed-origin transport. There is deliberately no arbitrary request method."""

import asyncio
import json
from typing import Any

import httpx

from jukelet.ha.models import MAX_BYTES, Capability, HAError

# Only recognized fields are exposed or accepted. Presence alone is not a capability.
SERVICE_FIELDS: dict[str, frozenset[str]] = {
    "get_album": frozenset({"entity_id", "album_id"}),
    "get_playlist": frozenset({"entity_id", "playlist_id", "exclude_items"}),
    "get_album_favorites": frozenset({"entity_id", "limit", "offset"}),
    "get_playlist_favorites": frozenset({"entity_id", "limit", "offset"}),
    "search_albums": frozenset({"entity_id", "criteria", "limit"}),
    "search_playlists": frozenset({"entity_id", "criteria", "limit"}),
}
REQUIRED_FIELDS = {
    "get_album": {"entity_id", "album_id"},
    "get_playlist": {"entity_id", "playlist_id"},
    "get_album_favorites": {"entity_id"},
    "get_playlist_favorites": {"entity_id"},
    "search_albums": {"entity_id", "criteria"},
    "search_playlists": {"entity_id", "criteria"},
}


def capabilities(payload: Any) -> dict[str, Capability]:
    if not isinstance(payload, list):
        raise HAError("unsupported_response")
    definitions: dict[str, Any] = {}
    for domain in payload:
        if (
            not isinstance(domain, dict)
            or not isinstance(domain.get("domain"), str)
            or not isinstance(domain.get("services"), dict)
        ):
            raise HAError("unsupported_response")
        if domain["domain"] == "spotifyplus":
            definitions = domain["services"]
    result = {}
    for name, recognized in SERVICE_FIELDS.items():
        definition = definitions.get(name, {})
        if not isinstance(definition, dict) or not isinstance(definition.get("fields", {}), dict):
            raise HAError("unsupported_response")
        fields = definition.get("fields", {})
        if any(not isinstance(value, dict) for value in fields.values()):
            raise HAError("unsupported_response")
        response = definition.get("response")
        supports_response = isinstance(response, dict) and isinstance(
            response.get("optional"), bool
        )
        # Unknown mandatory arguments cannot safely be invented by this adapter.
        unknown_required = any(
            isinstance(value, dict) and value.get("required") is True and key not in recognized
            for key, value in fields.items()
        )
        supported = (
            REQUIRED_FIELDS[name] <= fields.keys() and supports_response and not unknown_required
        )
        result[name] = Capability(
            state="supported" if supported else "unsupported",
            fields=sorted(recognized & fields.keys()),
            response=supports_response,
        )
    return result


class RestClient:
    def __init__(
        self,
        origin: str,
        token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 10.0,
    ) -> None:
        self.timeout = timeout
        self.client = httpx.AsyncClient(
            base_url=origin,
            headers={"Authorization": f"Bearer {token}"},
            timeout=timeout,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )
        self.slots = asyncio.Semaphore(32)

    async def close(self) -> None:
        await self.client.aclose()

    async def read(self, operation: str) -> Any:
        routes = {"config": "/api/config", "services": "/api/services"}
        if operation not in routes:
            raise HAError("unsupported_operation")
        return await self._request("GET", routes[operation])

    async def metadata(
        self, service: str, data: dict[str, Any], installed: dict[str, Capability]
    ) -> Any:
        if service not in SERVICE_FIELDS:
            raise HAError("unsupported_operation")
        cap = installed.get(service)
        if (
            cap is None
            or cap.state != "supported"
            or not REQUIRED_FIELDS[service] <= data.keys()
            or not data.keys() <= set(cap.fields)
        ):
            raise HAError("unsupported_operation")
        for key, value in data.items():
            if key in {"entity_id", "album_id", "playlist_id", "criteria"}:
                if not isinstance(value, str) or not value.strip() or len(value) > 512:
                    raise HAError("unsupported_operation")
            elif key in {"limit", "offset"}:
                if (
                    type(value) is not int
                    or not 0 <= value <= (50 if key == "limit" else 10000)
                    or (key == "limit" and value == 0)
                ):
                    raise HAError("unsupported_operation")
            elif key == "exclude_items" and type(value) is not bool:
                raise HAError("unsupported_operation")
        result = await self._request(
            "POST", f"/api/services/spotifyplus/{service}?return_response", data
        )
        if not isinstance(result, dict) or not isinstance(result.get("service_response"), dict):
            raise HAError("unsupported_response")
        return result["service_response"]

    async def _request(self, method: str, path: str, data: dict[str, Any] | None = None) -> Any:
        try:
            async with (
                asyncio.timeout(self.timeout),
                self.slots,
                self.client.stream(method, path, json=data) as response,
            ):
                errors = {
                    401: "unauthorized",
                    403: "forbidden",
                    404: "not_found",
                    429: "rate_limited",
                }
                if response.status_code in errors:
                    # Keep the finite error mapping typed without exposing response bodies.
                    if response.status_code == 401:
                        raise HAError("unauthorized")
                    if response.status_code == 403:
                        raise HAError("forbidden")
                    if response.status_code == 404:
                        raise HAError("not_found")
                    raise HAError("rate_limited")
                if response.status_code != 200:
                    raise HAError("unavailable")
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_BYTES:
                        raise HAError("unsupported_response")
                try:
                    return json.loads(body)
                except ValueError, UnicodeError, RecursionError:
                    raise HAError("unsupported_response") from None
        except TimeoutError, httpx.TimeoutException:
            raise HAError("timeout") from None
        except httpx.HTTPError:
            raise HAError("unavailable") from None
