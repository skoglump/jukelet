from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

ErrorCode = Literal[
    "unauthorized",
    "forbidden",
    "not_found",
    "rate_limited",
    "timeout",
    "unavailable",
    "unsupported_response",
    "unsupported_operation",
]
CapabilityState = Literal["unknown", "supported", "unsupported"]
MAX_BYTES = 4 * 1024 * 1024
DEADLINE = 10.0
MAX_TAGS = 10000
MAX_TAG_ID = 512


def exact_tag_id(value: str) -> str:
    if not value or len(value) > MAX_TAG_ID:
        raise ValueError("Unsupported tag ID")
    try:
        value.encode("utf-8")
    except UnicodeError:
        raise ValueError("Unsupported tag ID") from None
    return value


class HAError(Exception):
    def __init__(self, code: ErrorCode) -> None:
        self.code = code
        super().__init__(code)


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


class Capability(BaseModel):
    state: CapabilityState = "unknown"
    fields: list[str] = []
    response: bool = False


class HAStatus(BaseModel):
    mode: Literal["read_only", "manage"] = "read_only"
    connection: Literal[
        "not_configured", "connecting", "connected", "disconnected", "unauthorized"
    ] = "not_configured"
    version: str | None = None
    tag_list: CapabilityState = "unknown"
    scan_subscription: CapabilityState = "unknown"
    subscribed: bool = False
    services: dict[str, Capability] = {}
    inventory_stale: bool = True
    discovery_gap: bool = False
    last_attempt_at: str | None = None
    last_success_at: str | None = None
    inventory_updated_at: str | None = None
    services_updated_at: str | None = None
    error: ErrorCode | None = None


class Tag(BaseModel):
    model_config = ConfigDict(strict=True)
    id: str = Field(min_length=1, max_length=MAX_TAG_ID)
    name: str | None = Field(default=None, max_length=512)
    last_scanned: str | None = None

    _id = field_validator("id")(exact_tag_id)

    @field_validator("name")
    @classmethod
    def name_encoding(cls, value: str | None) -> str | None:
        if value is not None:
            value.encode("utf-8")
        return value

    @field_validator("last_scanned")
    @classmethod
    def scan_time(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError("Timestamp requires a timezone")
        try:
            return parsed.astimezone(UTC).isoformat()
        except OverflowError:
            raise ValueError("Timestamp is outside the supported UTC range") from None


class Scan(BaseModel):
    model_config = ConfigDict(strict=True)
    tag_id: str = Field(min_length=1, max_length=MAX_TAG_ID)
    device_id: str | None = Field(default=None, max_length=512)
    _id = field_validator("tag_id")(exact_tag_id)
    observed_at: str
