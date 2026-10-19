"""SpotifyPlus preview boundary. No direct Spotify requests or assignment writes."""

import asyncio
import math
import re
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import parse_qsl, urlsplit

from pydantic import BaseModel

from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import CapabilityState, ErrorCode, HAError, timestamp

MediaType = Literal["album", "playlist"]
SERVICES = {
    "album_detail": "get_album",
    "playlist_detail": "get_playlist",
    "album_library": "get_album_favorites",
    "playlist_library": "get_playlist_favorites",
    "album_search": "search_albums",
    "playlist_search": "search_playlists",
}


def parse_uri(value: str, media_type: MediaType) -> str:
    if len(value) > 512 or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("Unsupported Spotify URI or link")
    match = re.fullmatch(r"spotify:(album|playlist):([A-Za-z0-9]{22})", value)
    if match is None:
        link = urlsplit(value)
        if (
            link.scheme != "https"
            or link.netloc != "open.spotify.com"
            or link.fragment
            or any(
                key not in {"si", "utm_source"}
                for key, _ in parse_qsl(link.query, keep_blank_values=True)
            )
        ):
            raise ValueError("Unsupported Spotify URI or link")
        match = re.fullmatch(r"/(album|playlist)/([A-Za-z0-9]{22})", link.path)
    if match is None or match[1] != media_type:
        raise ValueError("Unsupported Spotify URI or media type mismatch")
    return f"spotify:{match[1]}:{match[2]}"


class MusicItem(BaseModel):
    uri: str
    media_type: MediaType
    title: str
    subtitle: str | None = None
    artwork_url: str | None = None


class MusicResult(BaseModel):
    uri: str | None = None
    item: MusicItem | None = None
    items: list[MusicItem] = []
    total: int | None = None
    next_offset: int | None = None
    state: Literal["fresh", "stale", "unavailable"] = "unavailable"
    last_attempt_at: str | None = None
    last_success_at: str | None = None
    error: ErrorCode | None = None
    retry_after: int | None = None


CACHE_SIZE = 128
FRESH_SECONDS = 300
RETENTION_SECONDS = 86400
MAX_PENDING = 8
MAX_OFFSET = 1000
PAGE_SIZE = 20


def object_value(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HAError("unsupported_response")
    return value


def text_value(value: Any, max_length: int = 512) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > max_length:
        raise HAError("unsupported_response")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise HAError("unsupported_response") from None
    return value


def normalize_item(value: Any, media_type: MediaType) -> MusicItem:
    data = object_value(value)
    try:
        uri = parse_uri(text_value(data.get("uri")), media_type)
    except ValueError:
        raise HAError("unsupported_response") from None
    if data.get("type") != media_type:
        raise HAError("unsupported_response")
    subtitle = None
    if media_type == "album" and data.get("artists") is not None:
        artists = data["artists"]
        if not isinstance(artists, list) or len(artists) > 50:
            raise HAError("unsupported_response")
        subtitle = (
            ", ".join(text_value(object_value(artist).get("name")) for artist in artists)[:512]
            or None
        )
    if media_type == "playlist" and data.get("owner") is not None:
        owner = object_value(data["owner"])
        if owner.get("display_name") is not None:
            subtitle = text_value(owner["display_name"])
    artwork = None
    images = data.get("images", [])
    if not isinstance(images, list) or len(images) > 20:
        raise HAError("unsupported_response")
    for image in images:
        url = text_value(object_value(image).get("url"), max_length=2048)
        # Preserve only Spotify's image CDN; no arbitrary third-party browser fetches.
        try:
            parsed = urlsplit(url)
        except ValueError:
            raise HAError("unsupported_response") from None
        if (
            parsed.scheme == "https"
            and parsed.netloc
            in {
                "i.scdn.co",
                "mosaic.scdn.co",
                "image-cdn-ak.spotifycdn.com",
                "image-cdn-fa.spotifycdn.com",
            }
            and not parsed.fragment
            and not any(c.isspace() for c in url)
        ):
            artwork = artwork or url
    return MusicItem(
        uri=uri,
        media_type=media_type,
        title=text_value(data.get("name")),
        subtitle=subtitle,
        artwork_url=artwork,
    )


@dataclass
class CacheEntry:
    result: MusicResult
    success_time: float | None
    attempt_time: float
    failures: int = 0
    retry_at: float = 0


class SpotifyPlus:
    def __init__(
        self, ha: HAAdapter, entity: str | None, *, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.ha = ha
        self.entity = entity
        self.clock = clock
        # Private per-instance cache: a configuration restart constructs a new owner.
        self._context = ("spotifyplus", ha.origin, entity)
        self._cache: OrderedDict[tuple[Any, ...], CacheEntry] = OrderedDict()
        self._lock = asyncio.Lock()
        self._pending = 0
        self._cooldown = 0.0
        self._rate_failures = 0

    def capabilities(self) -> dict[str, CapabilityState]:
        result: dict[str, CapabilityState] = {}
        for name, service in SERVICES.items():
            cap = self.ha.status.services.get(service)
            state: CapabilityState = (
                cap.state
                if self.entity and cap and (self.ha.origin or self.ha.rest)
                else "unsupported"
            )
            # A usable bounded library needs both paging inputs; bounded search needs limit.
            required = (
                {"limit", "offset"}
                if name.endswith("library")
                else {"limit"}
                if name.endswith("search")
                else set()
            )
            if state == "supported" and cap and not required <= set(cap.fields):
                state = "unsupported"
            result[name] = state
        return result

    async def resolve(self, value: str, media_type: MediaType) -> MusicResult:
        uri = parse_uri(value, media_type)
        data: dict[str, Any] = {f"{media_type}_id": uri.rsplit(":", 1)[1]}
        cap = self.ha.status.services.get("get_playlist")
        if media_type == "playlist" and cap and "exclude_items" in cap.fields:
            data["exclude_items"] = True
        return await self._request(f"{media_type}_detail", data, media_type, uri=uri)

    async def library(self, media_type: MediaType, offset: int = 0) -> MusicResult:
        if type(offset) is not int or not 0 <= offset <= MAX_OFFSET:
            raise ValueError("Unsupported library offset")
        return await self._request(
            f"{media_type}_library",
            {"offset": offset, "limit": PAGE_SIZE},
            media_type,
            offset=offset,
        )

    async def search(self, media_type: MediaType, query: str) -> MusicResult:
        if not query.strip() or len(query) > 200:
            raise ValueError("Search requires 1–200 characters")
        return await self._request(
            f"{media_type}_search", {"criteria": query, "limit": PAGE_SIZE}, media_type
        )

    def _cached(self, key: tuple[Any, ...]) -> CacheEntry | None:
        now = self.clock()
        for old_key, old_entry in list(self._cache.items()):
            if (
                now
                - (
                    old_entry.success_time
                    if old_entry.success_time is not None
                    else old_entry.attempt_time
                )
                >= RETENTION_SECONDS
            ):
                del self._cache[old_key]
        entry = self._cache.get(key)
        if entry:
            self._cache.move_to_end(key)
        return entry

    def _failure(
        self, uri: str | None, old: CacheEntry | None, code: ErrorCode, retry: int | None = None
    ) -> MusicResult:
        result = old.result.model_copy(deep=True) if old else MusicResult(uri=uri)
        result.error = code
        result.state = "stale" if result.last_success_at else "unavailable"
        result.last_attempt_at = timestamp()
        result.retry_after = retry
        return result

    async def _request(
        self,
        operation: str,
        data: dict[str, Any],
        media_type: MediaType,
        *,
        uri: str | None = None,
        offset: int = 0,
    ) -> MusicResult:
        key = (*self._context, operation, *sorted(data.items()))
        old = self._cached(key)
        if self._pending >= MAX_PENDING:
            return self._failure(uri, old, "unavailable", 1)
        self._pending += 1
        try:
            # One upstream call at a time; at most seven waiters and a total deadline.
            async with asyncio.timeout(12), self._lock:
                old = self._cached(key)
                now = self.clock()
                if self.capabilities()[operation] != "supported":
                    return self._failure(uri, old, "unsupported_operation")
                if old and now < old.retry_at:
                    result = old.result.model_copy(deep=True)
                    result.retry_after = max(1, math.ceil(old.retry_at - now))
                    return result
                if (
                    old
                    and old.result.error is None
                    and old.success_time is not None
                    and now - old.success_time < FRESH_SECONDS
                ):
                    return old.result.model_copy(deep=True)
                if now < self._cooldown:
                    return self._failure(uri, old, "rate_limited", math.ceil(self._cooldown - now))
                try:
                    if self.ha.rest is None or self.entity is None:
                        raise HAError("unavailable")
                    payload = object_value(
                        await self.ha.rest.metadata(
                            SERVICES[operation],
                            {"entity_id": self.entity, **data},
                            self.ha.status.services,
                        )
                    )
                    # HA entity-service responses may be keyed by the configured entity.
                    if set(payload) == {self.entity}:
                        payload = object_value(payload[self.entity])
                    result = self._normalize(payload, operation, media_type, uri, offset)
                    result.last_attempt_at = result.last_success_at = timestamp()
                    entry = CacheEntry(result, self.clock(), self.clock())
                    self._rate_failures = 0
                except HAError as error:
                    failures = min(5, old.failures + 1 if old else 1)
                    retry = min(300, 30 * 2 ** (failures - 1))
                    if error.code == "rate_limited":
                        self._rate_failures = min(5, self._rate_failures + 1)
                        retry = min(300, 30 * 2 ** (self._rate_failures - 1))
                        self._cooldown = self.clock() + retry
                    result = self._failure(uri, old, error.code, retry)
                    entry = CacheEntry(
                        result,
                        old.success_time if old else None,
                        self.clock(),
                        failures,
                        self.clock() + retry,
                    )
                self._cache[key] = entry
                self._cache.move_to_end(key)
                while len(self._cache) > CACHE_SIZE:
                    self._cache.popitem(last=False)
                return result.model_copy(deep=True)
        except TimeoutError:
            return self._failure(uri, old, "timeout", 1)
        finally:
            self._pending -= 1

    def _normalize(
        self,
        payload: dict[str, Any],
        operation: str,
        media_type: MediaType,
        uri: str | None,
        offset: int,
    ) -> MusicResult:
        data = object_value(payload.get("result"))
        if operation.endswith("detail"):
            item = normalize_item(data, media_type)
            if item.uri != uri:
                raise HAError("unsupported_response")
            return MusicResult(uri=uri, item=item, state="fresh")
        # SearchResponse wraps a Page under its type; direct Page is also documented.
        if operation.endswith("search") and f"{media_type}s" in data:
            data = object_value(data[f"{media_type}s"])
        items, total, actual_offset, limit = (
            data.get(k) for k in ("items", "total", "offset", "limit")
        )
        if (
            not isinstance(items, list)
            or len(items) > PAGE_SIZE
            or type(total) is not int
            or total < 0
            or type(actual_offset) is not int
            or actual_offset != offset
            or type(limit) is not int
            or not 1 <= limit <= PAGE_SIZE
            or len(items) > limit
            or total < offset + len(items)
            and items
            or not items
            and total > offset
        ):
            raise HAError("unsupported_response")
        normalized = []
        for raw_item in items:
            if operation == "album_library":
                raw_item = object_value(raw_item).get("album")
            normalized.append(normalize_item(raw_item, media_type))
        next_offset = offset + len(items)
        return MusicResult(
            items=normalized,
            total=total,
            state="fresh",
            next_offset=next_offset
            if operation.endswith("library") and next_offset < total and next_offset <= MAX_OFFSET
            else None,
        )
