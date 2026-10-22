"""App-owned implementation of the strict companion v1 wire contract.

No runtime imports from the separately distributed HA integration. The golden
vectors in spikes/ha_companion are the shared compatibility test oracle.
"""

import hashlib
import json
import re
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_REVISION = 2**53 - 1
MAX_BYTES = 262144


def canonical(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


class Mapping(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    tag_id: str
    media_type: Literal["album", "playlist"]
    spotify_uri: str
    enabled: bool
    shuffle: bool
    playback_profile_id: Literal["default"]

    @model_validator(mode="after")
    def valid(self) -> Mapping:
        if not 1 <= len(self.tag_id.encode("utf-8")) <= 256 or any(
            ord(c) < 32 or ord(c) == 127 for c in self.tag_id
        ):
            raise ValueError("Unsupported exact tag ID")
        if (
            re.fullmatch("spotify:" + self.media_type + r":[A-Za-z0-9]{22}", self.spotify_uri)
            is None
        ):
            raise ValueError("Unsupported URI")
        return self


def payload(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if len(rows) > 1000:
        raise ValueError("Snapshot mapping limit exceeded")
    mappings = [Mapping.model_validate(row).model_dump() for row in rows]
    if len({row["tag_id"] for row in mappings}) != len(mappings):
        raise ValueError("Duplicate exact tag ID")
    result = {"mappings": sorted(mappings, key=lambda row: row["tag_id"])}
    # Include the maximum-size envelope overhead, avoiding a late reservation failure.
    if len(canonical(result)) + 350 > MAX_BYTES:
        raise ValueError("Snapshot byte limit exceeded")
    return result


def checksum(value: dict[str, Any]) -> str:
    return hashlib.sha256(
        canonical({"schema_version": 1, "payload": payload(value["mappings"])})
    ).hexdigest()


class BridgeStatus(BaseModel):
    model_config = ConfigDict(strict=True, extra="ignore")
    protocol_version: Literal[1]
    schema_version: Literal[1]
    publisher_id: str
    active_revision: int | None = Field(ge=1, le=MAX_REVISION)
    active_checksum: str | None = Field(pattern="^[a-f0-9]{64}$")
    mapping_count: int = Field(ge=0, le=1000)
    persistence: Literal["empty", "healthy", "degraded", "uncertain"]
    last_error: str | None = Field(max_length=64)
    dispatch_enabled: bool
    supported_media: list[str]
    supported_preferences: list[str]
    playback_profiles: list[str]

    @model_validator(mode="before")
    @classmethod
    def strict_versions(cls, value: Any) -> Any:
        if isinstance(value, dict) and (
            type(value.get("protocol_version")) is not int
            or type(value.get("schema_version")) is not int
        ):
            raise ValueError("Integer versions required")
        return value

    @model_validator(mode="after")
    def coherent(self) -> BridgeStatus:
        if str(UUID(self.publisher_id)) != self.publisher_id:
            raise ValueError("Invalid publisher")
        if (self.active_revision is None) != (self.active_checksum is None):
            raise ValueError("Incomplete active identity")
        if self.persistence == "healthy" and self.active_revision is None:
            raise ValueError("Missing healthy snapshot")
        if self.persistence == "empty" and (
            self.active_revision is not None or self.mapping_count != 0
        ):
            raise ValueError("Invalid empty snapshot")
        if (
            self.supported_media != ["album", "playlist"]
            or self.supported_preferences != ["enabled", "shuffle"]
            or self.playback_profiles != ["default"]
        ):
            raise ValueError("Unsupported bridge capabilities")
        return self

    def identity(self) -> tuple[int | None, str | None]:
        return self.active_revision, self.active_checksum

    def review_identity(self) -> tuple[object, ...]:
        return (
            self.publisher_id,
            self.active_revision,
            self.active_checksum,
            self.persistence,
            self.last_error,
        )
