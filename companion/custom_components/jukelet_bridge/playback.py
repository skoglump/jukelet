"""Internal playback boundary; never connected to installation or publication."""

import asyncio
import math
import re
from dataclasses import dataclass
from typing import Any, Literal, NotRequired, Protocol, TypedDict, cast

from .protocol import MAX_REVISION, ProtocolError

REQUEST_FIELDS = {
    "tag_id",
    "media_type",
    "spotify_uri",
    "enabled",
    "shuffle",
    "playback_profile_id",
    "snapshot_revision",
    "correlation_id",
}
SCRIPT_ERRORS = frozenset(
    {"readiness_failed", "account_failed", "transfer_failed", "playback_failed"}
)


class PlaybackRequest(TypedDict):
    tag_id: str
    media_type: Literal["album", "playlist"]
    spotify_uri: str
    enabled: bool
    shuffle: bool
    playback_profile_id: Literal["default"]
    snapshot_revision: int
    correlation_id: str
    reader_id: NotRequired[str]


def _text(value: object) -> bool:
    if type(value) is not str:
        return False
    try:
        return 1 <= len(value.encode("utf-8")) <= 256 and not any(
            ord(char) < 32 or ord(char) == 127 for char in value
        )
    except UnicodeError:
        return False


def validate_request(value: object) -> PlaybackRequest:
    """Validate and detach a request before invoking a locally selected script."""
    if type(value) is not dict or set(value) not in (
        REQUEST_FIELDS,
        REQUEST_FIELDS | {"reader_id"},
    ):
        raise ProtocolError("invalid_request")
    kind = value["media_type"]
    uri = value["spotify_uri"]
    if (
        not all(_text(value[key]) for key in ("tag_id", "correlation_id"))
        or ("reader_id" in value and not _text(value["reader_id"]))
        or type(kind) is not str
        or kind not in {"album", "playlist"}
        or type(uri) is not str
        or re.fullmatch(r"spotify:" + kind + r":[A-Za-z0-9]{22}", uri) is None
        or type(value["enabled"]) is not bool
        or type(value["shuffle"]) is not bool
        or type(value["snapshot_revision"]) is not int
        or not 1 <= value["snapshot_revision"] <= MAX_REVISION
        or type(value["playback_profile_id"]) is not str
    ):
        raise ProtocolError("invalid_request")
    if value["playback_profile_id"] != "default":
        raise ProtocolError("unsupported_profile")
    # All fields are validated immutable scalars; copy before any await.
    return cast(PlaybackRequest, dict(value))


class ScriptUnavailable(Exception):
    """The allowlisted service was absent; no invocation was admitted."""


class ScriptFailed(Exception):
    """HA reported a service error, which may follow partial side effects."""


class ScriptTransport(Protocol):
    async def invoke(self, script: str, variables: dict[str, Any]) -> object:
        """Return the script response or raise a bounded transport exception."""
        ...


@dataclass(frozen=True)
class PlaybackResult:
    correlation_id: str
    snapshot_revision: int
    invocation: Literal["rejected", "accepted", "unknown"]
    execution: Literal["not_started", "finished", "failed", "unknown"]
    error: str | None
    # Script self-report is never independent playback evidence.
    playback_verification: Literal["unavailable"] = "unavailable"


class PlaybackAdapter:
    """One explicit attempt per call, no scheduling, retries or live configuration."""

    def __init__(
        self, transport: ScriptTransport, profiles: object, *, timeout: float = 30.0
    ) -> None:
        if type(profiles) is not dict or set(profiles) - {"default"}:
            raise ProtocolError("invalid_profiles")
        for script in profiles.values():
            if (
                type(script) is not str
                or len(script) > 128
                or re.fullmatch(r"script\.[a-z0-9_]+", script) is None
                or script in {"script.turn_on", "script.turn_off", "script.toggle", "script.reload"}
            ):
                raise ProtocolError("invalid_profiles")
        if (
            type(timeout) not in (int, float)
            or not math.isfinite(timeout)
            or not 0 < timeout <= 300
        ):
            raise ProtocolError("invalid_timeout")
        self._profiles = dict(profiles)
        self._transport = transport
        self._timeout = timeout

    async def execute(self, value: object) -> PlaybackResult:
        """Invalid input raises before I/O. Cancellation propagates; outcome is unknown."""
        request = validate_request(value)

        def result(
            invocation: Literal["rejected", "accepted", "unknown"],
            execution: Literal["not_started", "finished", "failed", "unknown"],
            error: str | None,
        ) -> PlaybackResult:
            return PlaybackResult(
                request["correlation_id"],
                request["snapshot_revision"],
                invocation,
                execution,
                error,
            )

        if not request["enabled"]:
            return result("rejected", "not_started", "disabled")
        script = self._profiles.get(request["playback_profile_id"])
        if script is None:
            return result("rejected", "not_started", "profile_unconfigured")
        try:
            async with asyncio.timeout(self._timeout):
                response = await self._transport.invoke(script, dict(request))
        except ScriptUnavailable:
            return result("rejected", "not_started", "script_unavailable")
        except ScriptFailed:
            return result("unknown", "failed", "script_failed")
        except TimeoutError:
            return result("unknown", "unknown", "timeout")
        except Exception:
            # Never expose upstream exception text, payloads or household identifiers.
            return result("unknown", "unknown", "transport_error")
        if response is None or response == {}:
            return result("accepted", "unknown", "completion_unavailable")
        fields = {"contract_version", "correlation_id", "snapshot_revision", "execution", "error"}
        if (
            type(response) is not dict
            or set(response) != fields
            or type(response["contract_version"]) is not int
            or response["contract_version"] != 1
            or type(response["correlation_id"]) is not str
            or response["correlation_id"] != request["correlation_id"]
            or type(response["snapshot_revision"]) is not int
            or response["snapshot_revision"] != request["snapshot_revision"]
            or type(response["execution"]) is not str
            or response["execution"] not in {"finished", "failed"}
            or (response["execution"] == "finished" and response["error"] is not None)
            or (
                response["execution"] == "failed"
                and (type(response["error"]) is not str or response["error"] not in SCRIPT_ERRORS)
            )
        ):
            return result("accepted", "unknown", "invalid_completion")
        if response["execution"] == "finished":
            return result("accepted", "finished", None)
        return result("accepted", "failed", response["error"])
