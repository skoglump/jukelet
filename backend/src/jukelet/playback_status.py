"""Bounded operational read model, separate from publication and HA controls."""

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from jukelet.api import require_session
from jukelet.auth import AuthService
from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import HAError
from jukelet.publication_protocol import MAX_REVISION

Readiness = Literal[
    "shutting_down",
    "snapshot_unavailable",
    "snapshot_invalid",
    "preference_conflict",
    "execution_uncertain",
    "profile_unconfigured",
    "script_unavailable_or_running",
]
Reason = Literal[
    "ignored_disabled",
    "ignored_busy",
    "ignored_duplicate",
    "rejected_event",
    "rejected_mapping",
    "shutting_down",
    "snapshot_unavailable",
    "snapshot_invalid",
    "preference_conflict",
    "execution_uncertain",
    "profile_unconfigured",
    "script_unavailable_or_running",
    "invocation_requested",
    "execution_result",
    "execution_cancelled",
    "execution_error",
]
AttemptError = Literal[
    "readiness_failed",
    "account_failed",
    "transfer_failed",
    "playback_failed",
    "disabled",
    "profile_unconfigured",
    "script_unavailable",
    "script_failed",
    "timeout",
    "transport_error",
    "completion_unavailable",
    "invalid_completion",
    "execution_cancelled",
    "execution_error",
]


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    @field_validator("*", mode="before")
    @classmethod
    def timestamp_shape(cls, value: Any, info: Any) -> Any:
        if info.field_name.endswith("_at") and value is not None:
            if type(value) is not str or len(value) > 40:
                raise ValueError("Unsupported timestamp")
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is None:
                raise ValueError("Timezone required")
            return parsed.astimezone(UTC).isoformat()
        return value


class Attempt(StrictModel):
    correlation_id: str = Field(min_length=1, max_length=36)
    snapshot_revision: int = Field(ge=1, le=MAX_REVISION)
    requested_at: str
    completed_at: str | None
    invocation: Literal["requested", "rejected", "accepted", "unknown"]
    execution: Literal["not_started", "finished", "failed", "unknown"]
    error: AttemptError | None
    playback_verification: Literal["unavailable"]

    @model_validator(mode="after")
    def coherent(self) -> Attempt:
        if str(UUID(self.correlation_id)) != self.correlation_id:
            raise ValueError("Unsupported correlation")
        script_errors = {"readiness_failed", "account_failed", "transfer_failed", "playback_failed"}
        if self.error in script_errors and (self.invocation, self.execution) != (
            "accepted",
            "failed",
        ):
            raise ValueError("Uncorrelated failure")
        if self.execution == "finished" and (
            self.invocation != "accepted" or self.error is not None
        ):
            raise ValueError("Invalid completion")
        if self.completed_at is None and (
            self.invocation != "requested" or self.execution != "unknown" or self.error is not None
        ):
            raise ValueError("Invalid pending attempt")
        if self.completed_at is not None and (
            self.completed_at < self.requested_at or self.invocation == "requested"
        ):
            raise ValueError("Invalid completion time")
        return self


class Diagnostic(StrictModel):
    observed_at: str
    reason: Reason


class Diagnostics(StrictModel):
    diagnostics_version: Literal[1]
    started_at: str
    observed_at: str
    dispatch_enabled: bool
    ready: bool
    readiness_error: Readiness | None
    busy: bool
    execution_uncertain: bool
    pause_reason: (
        Literal[
            "startup",
            "administrator_disabled",
            "snapshot_changed",
            "readiness_lost",
            "execution_uncertain",
            "shutting_down",
        ]
        | None
    )
    last_scan_at: str | None
    last_attempt: Attempt | None
    diagnostics: list[Diagnostic] = Field(max_length=32)
    playback_verification: Literal["unavailable"]

    @model_validator(mode="before")
    @classmethod
    def strict_version(cls, value: Any) -> Any:
        if type(value) is not dict or type(value.get("diagnostics_version")) is not int:
            raise ValueError("Integer version required")
        return value

    @model_validator(mode="after")
    def coherent(self) -> Diagnostics:
        if self.ready != (self.readiness_error is None):
            raise ValueError("Inconsistent readiness")
        times = [self.started_at, self.last_scan_at]
        times.extend(row.observed_at for row in self.diagnostics)
        if self.last_attempt:
            times.extend([self.last_attempt.requested_at, self.last_attempt.completed_at])
        if any(at and not self.started_at <= at <= self.observed_at for at in times):
            raise ValueError("Inconsistent diagnostic times")
        return self


class PlaybackStatus:
    def __init__(self, ha: HAAdapter) -> None:
        self.ha = ha
        self.lock = asyncio.Lock()
        self.last_good: Diagnostics | None = None
        self.checked_at: str | None = None

    async def refresh(self) -> dict[str, Any]:
        async with self.lock:
            error: str | None = None
            generation = self.ha.generation
            fresh = False
            try:
                if self.ha.status.connection != "connected":
                    raise HAError("unavailable")
                diagnostic = Diagnostics.model_validate(await self.ha.playback_diagnostics())
                now = datetime.now(UTC)
                age = now - datetime.fromisoformat(diagnostic.observed_at)
                if age > timedelta(seconds=30) or age < timedelta(seconds=-5):
                    raise ValueError("Stale diagnostics")
                if generation != self.ha.generation or self.ha.status.connection != "connected":
                    raise HAError("unavailable")
                self.last_good = diagnostic
                self.checked_at = now.isoformat()
                fresh = True
            except HAError as exc:
                error = exc.code
            except ValueError, OverflowError:
                error = "unsupported_response"
            return {
                "connection": self.ha.status.connection,
                "checked_at": self.checked_at,
                "stale": not fresh,
                "error": error,
                "diagnostics": self.last_good.model_dump() if self.last_good else None,
            }


def playback_status_router(auth: AuthService, status: PlaybackStatus) -> APIRouter:
    router = APIRouter()

    @router.get("/api/v1/playback-status")
    async def read(request: Request) -> dict[str, Any]:
        require_session(request, auth)
        return await status.refresh()

    return router
