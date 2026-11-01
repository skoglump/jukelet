"""Fixed synthetic provider/tag/script policy; no network or HA imports."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

FIXTURE = "jukelet-m5-issue62-matrix-kvm"
DOMAIN = "jukelet_acceptance"
ENTITY_ID = "media_player.jukelet_acceptance"
SCRIPT_ID = "script.jukelet_issue62_inert"
TAG_ALBUM = "  Jukelet62:Å/e\u0301 album  "
TAG_PLAYLIST = "Jukelet62:playlist/🦊"
TAG_INBOX = "Jukelet62:observed-only"
TAGS = (TAG_ALBUM, TAG_PLAYLIST, TAG_INBOX)
READER_ID = "Jukelet62 synthetic reader"
ALBUM_ID = "0123456789ABCDEFGHIJKL"
PLAYLIST_ID = "ABCDEFGHIJKLMNOPQRSTUV"
SERVICES = {
    "get_album": {"entity_id", "album_id"},
    "get_playlist": {"entity_id", "playlist_id", "exclude_items"},
    "get_album_favorites": {"entity_id", "limit", "offset"},
    "get_playlist_favorites": {"entity_id", "limit", "offset"},
    "search_albums": {"entity_id", "criteria", "limit"},
    "search_playlists": {"entity_id", "criteria", "limit"},
}
MODES = ("fresh", "unavailable", "malformed")


class SyntheticUnavailable(Exception):
    """An intentional, bounded synthetic provider outage."""


def digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()
    ).hexdigest()


def fixture_config(value: Any) -> bool:
    return (
        type(value) is dict
        and set(value) == {"fixture", "synthetic"}
        and value["fixture"] == FIXTURE
        and value["synthetic"] is True
    )


def control_request(value: Any) -> dict[str, str]:
    if type(value) is dict:
        if value == {"action": "status"}:
            return {"action": "status"}
        if set(value) == {"action", "mode"} and value["action"] == "metadata":
            if type(value["mode"]) is str and value["mode"] in MODES:
                return dict(value)
        if set(value) == {"action", "tag_id"} and value["action"] == "scan":
            if type(value["tag_id"]) is str and value["tag_id"] in TAGS:
                return {**value, "reader_id": READER_ID}
    raise ValueError("Unsupported synthetic fixture control")


def script_document() -> dict[str, Any]:
    """Only local variables and correlated completion; no invocation or playback."""
    return {
        "alias": "Jukelet62 synthetic inert completion",
        "mode": "single",
        "max_exceeded": "silent",
        "sequence": [
            {
                "variables": {
                    "result": "{{ dict(contract_version=1, correlation_id=correlation_id, "
                    "snapshot_revision=snapshot_revision, execution='finished', error=none) }}"
                }
            },
            {"stop": "Synthetic completion; no playback", "response_variable": "result"},
        ],
    }


def _item(kind: str) -> dict[str, Any]:
    return {
        "uri": f"spotify:{kind}:{ALBUM_ID if kind == 'album' else PLAYLIST_ID}",
        "type": kind,
        "name": "Synthetic Jukelet62 " + kind,
        **(
            {"artists": [{"name": "Synthetic fixture artist"}]}
            if kind == "album"
            else {"owner": {"display_name": "Synthetic fixture owner"}}
        ),
        "images": [],  # No image/CDN request is needed or permitted by this fixture.
    }


def _metadata_input(service: str, data: Any) -> str:
    if service not in SERVICES or type(data) is not dict:
        raise ValueError("Unsupported synthetic metadata request")
    required = SERVICES[service] - {"exclude_items"}
    if not required <= set(data) <= SERVICES[service] or data["entity_id"] != ENTITY_ID:
        raise ValueError("Unsupported synthetic metadata request")
    kind = "album" if "album" in service else "playlist"
    if service in ("get_album", "get_playlist"):
        if data[kind + "_id"] != (ALBUM_ID if kind == "album" else PLAYLIST_ID):
            raise ValueError("Unsupported synthetic metadata request")
        if "exclude_items" in data and type(data["exclude_items"]) is not bool:
            raise ValueError("Unsupported synthetic metadata request")
    else:
        if type(data["limit"]) is not int or data["limit"] != 20:
            raise ValueError("Unsupported synthetic metadata request")
        if service.startswith("search_"):
            criteria = data["criteria"]
            if (
                type(criteria) is not str
                or not criteria.strip()
                or len(criteria) > 200
                or any(ord(character) < 32 or ord(character) == 127 for character in criteria)
            ):
                raise ValueError("Unsupported synthetic metadata request")
        elif type(data["offset"]) is not int or not 0 <= data["offset"] <= 1000:
            raise ValueError("Unsupported synthetic metadata request")
    return kind


def _capture(value: Any) -> dict[str, Any]:
    fields = {
        "tag_id",
        "media_type",
        "spotify_uri",
        "enabled",
        "shuffle",
        "playback_profile_id",
        "snapshot_revision",
        "correlation_id",
    }
    if type(value) is not dict or set(value) not in (fields, fields | {"reader_id"}):
        raise ValueError("Unexpected synthetic script request")
    kind = "album" if value["tag_id"] == TAG_ALBUM else "playlist"
    if (
        value["tag_id"] not in (TAG_ALBUM, TAG_PLAYLIST)
        or value["media_type"] != kind
        or value["spotify_uri"] != _item(kind)["uri"]
        or value["enabled"] is not True
        or type(value["shuffle"]) is not bool
        or value["playback_profile_id"] != "default"
        or type(value["snapshot_revision"]) is not int
        or not 1 <= value["snapshot_revision"] <= 2**63 - 1
        or ("reader_id" in value and value["reader_id"] != READER_ID)
        or type(value["correlation_id"]) is not str
    ):
        raise ValueError("Unexpected synthetic script request")
    try:
        if str(UUID(value["correlation_id"])) != value["correlation_id"]:
            raise ValueError("Unexpected synthetic script request")
    except ValueError, AttributeError:
        raise ValueError("Unexpected synthetic script request") from None
    return dict(value)


@dataclass
class FixtureState:
    mode: str = "fresh"
    instance: str = field(default_factory=lambda: str(uuid4()))
    metadata_calls: int = 0
    script_invocations: int = 0
    unexpected_script_calls: int = 0
    captures: list[dict[str, Any]] = field(default_factory=list)

    def metadata(self, service: str, data: Any) -> dict[str, Any]:
        kind = _metadata_input(service, data)
        self.metadata_calls += 1
        if self.mode == "unavailable":
            raise SyntheticUnavailable("Synthetic metadata unavailable")
        if self.mode == "malformed":
            return {"result": {"synthetic_fixture": "malformed"}}
        item = _item(kind)
        if service in ("get_album", "get_playlist"):
            return {"result": item}
        offset = data.get("offset", 0)
        rows = [{"album": item}] if service == "get_album_favorites" else [item]
        page = {"items": rows if offset == 0 else [], "total": 1, "offset": offset, "limit": 20}
        return {"result": {kind + "s": page} if service.startswith("search_") else page}

    def observe_script_call(self, value: Any) -> None:
        """Read-only service-event observation, independent of bridge completion."""
        self.script_invocations += 1
        try:
            request = _capture(value)
        except ValueError:
            self.unexpected_script_calls += 1
            return
        self.captures.append({"request": request, "request_sha256": digest(request)})
        del self.captures[:-32]

    def status(self) -> dict[str, Any]:
        return {
            "fixture": FIXTURE,
            "synthetic": True,
            "instance": self.instance,
            "metadata_mode": self.mode,
            "metadata_calls": self.metadata_calls,
            "script_invocations": self.script_invocations,
            "unexpected_script_calls": self.unexpected_script_calls,
            "captures": [
                {"request": dict(row["request"]), "request_sha256": row["request_sha256"]}
                for row in self.captures
            ],
            "independent_playback_verification": "unavailable",
        }
