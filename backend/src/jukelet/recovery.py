"""Portable logical mappings; runtime identity and versions remain local."""

import json
import math
import secrets
import time
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from threading import Lock
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError, field_validator
from sqlalchemy import text

from jukelet.assignments import AssignmentConflict, AssignmentInput, AssignmentStore, Preferences
from jukelet.ha.models import exact_tag_id
from jukelet.inventory import tag_key
from jukelet.providers.spotifyplus import MediaType, parse_uri

MAX_BYTES = 4 * 1024 * 1024
MAX_ROWS = 10000


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class ExportRow(Preferences):
    ha_tag_id: str = Field(min_length=1, max_length=512)
    spotify_uri: str = Field(min_length=1, max_length=64)
    media_type: MediaType
    name: str | None = Field(default=None, max_length=512)

    @field_validator("ha_tag_id")
    @classmethod
    def valid_id(cls, value: str) -> str:
        return exact_tag_id(value)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str | None) -> str | None:
        if value is not None:
            value.encode("utf-8")
        return value

    def assignment(self) -> AssignmentInput:
        if parse_uri(self.spotify_uri, self.media_type) != self.spotify_uri:
            raise ValueError("Canonical URI required")
        return AssignmentInput(
            **self.model_dump(exclude={"spotify_uri", "name"}),
            input=self.spotify_uri,
            expected_version=0,
        )


class Provenance(StrictModel):
    application: Literal["jukelet"]
    exported_at: str = Field(min_length=1, max_length=40)
    local_revision: int = Field(ge=0, le=2**53 - 1)
    names_updated_at: str | None = Field(max_length=40)
    names_stale: bool


class ExportDocument(StrictModel):
    schema_version: Literal[1]
    provenance: Provenance
    assignments: list[dict[str, JsonValue]] = Field(max_length=MAX_ROWS)

    @field_validator("schema_version", mode="before")
    @classmethod
    def strict_version(cls, value: object) -> object:
        if type(value) is not int:
            raise ValueError("Integer schema version required")
        return value


class PreviewInput(StrictModel):
    document: ExportDocument


class ConfirmInput(StrictModel):
    preview_token: str = Field(min_length=32, max_length=128)
    conflict_policy: Literal["reject", "skip", "replace"]
    confirmed: bool


class RestoreRow(StrictModel):
    row: int
    source: dict[str, JsonValue]
    accepted: bool
    conflict: bool
    diagnostics: list[str]


class RestoreReport(StrictModel):
    rows: list[RestoreRow]
    accepted: int
    rejected: int
    conflicts: int
    local_revision: int
    preview_token: str


@dataclass
class ReviewedRestore:
    session: str
    report: RestoreReport
    values: list[AssignmentInput]
    expires: float


def encoded(document: ExportDocument) -> bytes:
    return document.model_dump_json().encode("utf-8")


class RecoveryService:
    def __init__(self, store: AssignmentStore) -> None:
        self.store = store
        self.entries: dict[str, ReviewedRestore] = {}
        self.lock = Lock()

    def status(self) -> dict[str, bool]:
        with self.store.engine.connect() as connection:
            return {
                "reconciliation_required": bool(
                    connection.scalar(
                        text("SELECT reconciliation_required FROM recovery_state WHERE id=1")
                    )
                )
            }

    def export(
        self, names: dict[str, str | None], updated_at: str | None, stale: bool
    ) -> ExportDocument:
        with self.store.engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            rows = (
                connection.execute(
                    text(
                        "SELECT * FROM assignment WHERE deleted=0 ORDER BY ha_tag_id LIMIT :limit"
                    ),
                    {"limit": MAX_ROWS + 1},
                )
                .mappings()
                .all()
            )
            if len(rows) > MAX_ROWS:
                raise ValueError("Export exceeds row limit; use protected database backup")
            assignments = [
                ExportRow(
                    **{
                        key: row[key]
                        for key in ("ha_tag_id", "spotify_uri", "media_type", "playback_profile_id")
                    },
                    enabled=bool(row["enabled"]),
                    shuffle=bool(row["shuffle"]),
                    name=names.get(row["ha_tag_id"]),
                ).model_dump(mode="json")
                for row in rows
            ]
            document = ExportDocument(
                schema_version=1,
                provenance=Provenance(
                    application="jukelet",
                    exported_at=datetime.now(UTC).isoformat(),
                    local_revision=int(
                        connection.scalar(text("SELECT revision FROM assignment_revision")) or 0
                    ),
                    names_updated_at=updated_at,
                    names_stale=stale,
                ),
                assignments=assignments,
            )
            if len(encoded(document)) > MAX_BYTES:
                raise ValueError("Export exceeds byte limit; use protected database backup")
            return document

    def preview(self, document: ExportDocument, session: str) -> RestoreReport:
        if len(encoded(document)) > MAX_BYTES:
            raise ValueError("Logical export exceeds byte limit")
        # A single consistent read captures conflicts and the confirmation precondition.
        with self.store.engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            revision = int(connection.scalar(text("SELECT revision FROM assignment_revision")) or 0)
            existing = set(
                connection.scalars(text("SELECT ha_tag_id FROM assignment WHERE deleted=0"))
            )
        ids = Counter(
            row.get("ha_tag_id")
            for row in document.assignments
            if isinstance(row.get("ha_tag_id"), str)
        )
        rows: list[RestoreRow] = []
        values = []
        for number, source in enumerate(document.assignments, 1):
            diagnostics: list[str] = []
            try:
                row = ExportRow.model_validate(source)
                value = row.assignment()
                if ids[row.ha_tag_id] > 1:
                    diagnostics.append("duplicate_tag_id")
                if not diagnostics:
                    values.append(value)
            except ValueError, ValidationError:
                diagnostics.append("unsupported_or_invalid_row")
            identifier = source.get("ha_tag_id")
            rows.append(
                RestoreRow(
                    row=number,
                    source=source,
                    accepted=not diagnostics,
                    conflict=isinstance(identifier, str) and identifier in existing,
                    diagnostics=diagnostics,
                )
            )
        token = secrets.token_urlsafe(32)
        report = RestoreReport(
            rows=rows,
            accepted=len(values),
            rejected=len(rows) - len(values),
            conflicts=sum(row.conflict and row.accepted for row in rows),
            local_revision=revision,
            preview_token=token,
        )
        with self.lock:
            self.entries = {
                key: entry
                for key, entry in self.entries.items()
                if entry.expires > time.monotonic()
            }
            # Retain at most four bounded documents to cap user-controlled memory.
            while len(self.entries) >= 4:
                del self.entries[next(iter(self.entries))]
            self.entries[token] = ReviewedRestore(session, report, values, time.monotonic() + 900)
        return report

    def confirm(self, value: ConfirmInput, session: str) -> dict[str, object]:
        with self.lock:
            entry = self.entries.get(value.preview_token)
        if (
            not value.confirmed
            or not entry
            or entry.session != session
            or entry.expires <= time.monotonic()
        ):
            raise AssignmentConflict(self.store.revision())
        with self.store.engine.begin() as connection:
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            revision = int(connection.scalar(text("SELECT revision FROM assignment_revision")) or 0)
            if revision != entry.report.local_revision:
                raise AssignmentConflict(revision)
            restored = skipped = 0
            for assignment in entry.values:
                current = self.store._state(connection, tag_key(assignment.ha_tag_id))
                if current.assignment:
                    if value.conflict_policy == "reject":
                        raise AssignmentConflict(revision)
                    if value.conflict_policy == "skip":
                        skipped += 1
                        continue
                self.store._put(
                    connection, assignment.model_copy(update={"expected_version": current.version})
                )
                restored += 1
            self.store._audit(connection, "restore", None, restored)
            connection.execute(
                text("UPDATE recovery_state SET reconciliation_required=1 WHERE id=1")
            )
        with self.lock:
            self.entries.pop(value.preview_token, None)
        return {
            "restored": restored,
            "skipped": skipped,
            "report": entry.report.model_dump(),
            "reconciliation_required": True,
        }


def unique_object(pairs: list[tuple[str, JsonValue]]) -> dict[str, JsonValue]:
    result: dict[str, JsonValue] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def parse_document_request(body: bytes) -> PreviewInput:
    raw = json.loads(
        body,
        object_pairs_hook=unique_object,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite number")),
    )
    pending = [(raw, 0)]
    while pending:
        item, depth = pending.pop()
        if depth > 16:
            raise ValueError("Too deeply nested")
        if isinstance(item, float) and not math.isfinite(item):
            raise ValueError("Nonfinite number")
        if isinstance(item, dict):
            pending.extend((value, depth + 1) for value in item.values())
        elif isinstance(item, list):
            pending.extend((value, depth + 1) for value in item)
    return PreviewInput.model_validate(raw)
