"""Strict, independent bridge wire contract. All examples are synthetic."""

import hashlib
import json
import re
from typing import Any
from uuid import UUID

MAX_BYTES = 262_144
MAX_MAPPINGS = 1_000
MAX_REVISION = 2**53 - 1
PUBLISHER = "00000000-0000-4000-8000-000000000019"
ENVELOPE = {
    "schema_version",
    "publisher_id",
    "revision",
    "expected_active_revision",
    "payload_checksum",
    "payload",
}
ROW = {"tag_id", "media_type", "spotify_uri", "enabled", "shuffle", "playback_profile_id"}


class ProtocolError(ValueError):
    """Safe bounded protocol failure; never echo caller data."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def canonical(value: object) -> bytes:
    """Sorted keys, UTF-8 scalars, shortest integer JSON, no insignificant spaces."""
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise ProtocolError("invalid_snapshot") from exc


def checksum(payload: dict[str, Any]) -> str:
    """Caller must validate first; array order is canonicalized by exact scalar ID."""
    ordered = {"mappings": sorted(payload["mappings"], key=lambda row: row["tag_id"])}
    return hashlib.sha256(canonical({"schema_version": 1, "payload": ordered})).hexdigest()


def valid_publisher(value: object) -> bool:
    try:
        return type(value) is str and str(UUID(value)) == value
    except ValueError:
        return False


def _integer(value: object) -> bool:
    return type(value) is int and 1 <= value <= MAX_REVISION


def validate_snapshot(value: object) -> dict[str, Any]:
    """Return a detached canonical envelope or fail without repairing opaque IDs."""
    if type(value) is not dict or set(value) != ENVELOPE:
        raise ProtocolError("invalid_snapshot")
    if len(canonical(value)) > MAX_BYTES:
        raise ProtocolError("snapshot_too_large")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        raise ProtocolError("unsupported_schema")
    if not valid_publisher(value["publisher_id"]) or not _integer(value["revision"]):
        raise ProtocolError("invalid_snapshot")
    expected = value["expected_active_revision"]
    if expected is not None and not _integer(expected):
        raise ProtocolError("invalid_snapshot")
    payload = value["payload"]
    if type(payload) is not dict or set(payload) != {"mappings"}:
        raise ProtocolError("invalid_snapshot")
    mappings = payload["mappings"]
    if type(mappings) is not list or len(mappings) > MAX_MAPPINGS:
        raise ProtocolError("invalid_snapshot")
    ids: set[str] = set()
    for row in mappings:
        if type(row) is not dict or set(row) != ROW:
            raise ProtocolError("invalid_snapshot")
        tag = row["tag_id"]
        if (
            type(tag) is not str
            or not 1 <= len(tag.encode("utf-8")) <= 256
            or any(ord(char) < 32 or ord(char) == 127 for char in tag)
            or tag in ids
        ):
            raise ProtocolError("invalid_snapshot")
        ids.add(tag)
        kind = row["media_type"]
        uri = row["spotify_uri"]
        if (
            type(kind) is not str
            or kind not in {"album", "playlist"}
            or type(uri) is not str
            or re.fullmatch(r"spotify:" + kind + r":[A-Za-z0-9]{22}", uri) is None
        ):
            raise ProtocolError("invalid_snapshot")
        if (
            type(row["enabled"]) is not bool
            or type(row["shuffle"]) is not bool
            or row["playback_profile_id"] != "default"
        ):
            raise ProtocolError("invalid_snapshot")
    digest = value["payload_checksum"]
    if type(digest) is not str or digest != checksum(payload):
        raise ProtocolError("checksum_mismatch")
    # JSON detaches all caller-owned containers before any await/executor serialization.
    result: dict[str, Any] = json.loads(canonical(value))
    result["payload"]["mappings"].sort(key=lambda row: row["tag_id"])
    return result
