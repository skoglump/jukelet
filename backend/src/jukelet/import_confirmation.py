"""Bounded, expiring, session-bound proof that this server produced a preview."""

import secrets
import time
from dataclasses import dataclass
from typing import Literal

from pydantic import Field

from jukelet.assignments import Preferences
from jukelet.importers.legacy import MAX_SOURCE_BYTES, PreviewReport


class ConfirmInput(Preferences):
    source: Literal["upload", "configured"]
    format: Literal["json", "yaml"] = "yaml"
    content: str | None = Field(default=None, max_length=MAX_SOURCE_BYTES)
    fingerprint: str = Field(pattern="^[a-f0-9]{64}$")
    preview_token: str = Field(min_length=32, max_length=128)
    conflict_policy: Literal["skip", "replace", "reject"]


@dataclass(frozen=True)
class ReviewedPreview:
    session: str
    report: PreviewReport
    format: Literal["json", "yaml"]
    revision: int
    expires: float


class PreviewRegistry:
    def __init__(self) -> None:
        self.entries: dict[str, ReviewedPreview] = {}

    def add(
        self, session: str, report: PreviewReport, format: Literal["json", "yaml"], revision: int
    ) -> str:
        self.entries = {
            key: value for key, value in self.entries.items() if value.expires > time.monotonic()
        }
        while len(self.entries) >= 32:
            del self.entries[next(iter(self.entries))]
        token = secrets.token_urlsafe(32)
        self.entries[token] = ReviewedPreview(
            session, report.model_copy(deep=True), format, revision, time.monotonic() + 900
        )
        return token

    def get(self, token: str, session: str) -> ReviewedPreview | None:
        entry = self.entries.get(token)
        return (
            entry
            if entry and entry.session == session and entry.expires > time.monotonic()
            else None
        )
