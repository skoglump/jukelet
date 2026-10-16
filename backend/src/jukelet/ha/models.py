from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

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
    mode: Literal["read_only"] = "read_only"
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
    id: str = Field(min_length=1)
    name: str | None = None
    last_scanned: str | None = None


class Scan(BaseModel):
    model_config = ConfigDict(strict=True)
    tag_id: str = Field(min_length=1)
    device_id: str | None = None
    observed_at: str
