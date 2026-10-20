"""Safe source preview and explicit local-only confirmation."""

import hmac
import json
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from jukelet.api import require_session
from jukelet.assignment_api import conflict, read_input, verify_write
from jukelet.assignments import AssignmentConflict, AssignmentInput, AssignmentStore
from jukelet.auth import AuthService
from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import HAError
from jukelet.import_confirmation import ConfirmInput, PreviewRegistry
from jukelet.importers.legacy import MAX_SOURCE_BYTES, PreviewError, PreviewReport, preview


class PreviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source: Literal["upload", "configured"]
    format: Literal["json", "yaml"] = "yaml"
    content: str | None = Field(default=None, max_length=MAX_SOURCE_BYTES)
    expected_fingerprint: str | None = Field(default=None, pattern="^[a-f0-9]{64}$")


def import_router(
    auth: AuthService, ha: HAAdapter, settings: Settings, store: AssignmentStore
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/imports")
    reviewed = PreviewRegistry()

    @router.post("/preview")
    async def import_preview(request: Request) -> PreviewReport:
        session = require_session(request, auth)
        csrf = request.headers.get("x-csrf-token", "")
        if not hmac.compare_digest(csrf.encode(), session.csrf_token.encode()):
            raise HTTPException(403, "Request verification failed")
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise HTTPException(415, "JSON envelope required")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            # JSON escaping can expand each source byte sixfold.
            if len(body) > 6 * MAX_SOURCE_BYTES + 4096:
                raise HTTPException(413, "Request too large")
        try:
            value = PreviewInput.model_validate(json.loads(body))
            if (value.source == "upload") != (value.content is not None):
                raise ValueError
        except ValueError, ValidationError, RecursionError:
            raise HTTPException(422, "Invalid preview request") from None
        content = value.content
        if value.source == "configured":
            if ha.rest is None:
                raise HTTPException(503, "source_not_configured: use uploaded JSON/YAML")
            try:
                content = await ha.rest.legacy_configuration()
            except HAError as error:
                raise HTTPException(503, f"source_{error.code}: use uploaded JSON/YAML") from None
        assert content is not None
        try:
            # Snapshot before yielding; each report uses one consistent inventory generation.
            revision = await run_in_threadpool(store.revision)
            report = await run_in_threadpool(
                preview,
                content,
                "json" if value.source == "configured" else value.format,
                source=value.source,
                registry=ha.inventory,
                registry_updated_at=ha.status.inventory_updated_at,
                registry_stale=ha.status.inventory_stale,
                expected_fingerprint=value.expected_fingerprint,
            )
            report.local_revision = revision
            report.preview_token = reviewed.add(
                session.token_hash,
                report,
                "json" if value.source == "configured" else value.format,
                revision,
            )
            return report
        except PreviewError as error:
            raise HTTPException(422, str(error)) from None

    @router.post("/confirm")
    async def confirm(request: Request) -> dict[str, object]:
        session = verify_write(request, auth, settings)
        value = await read_input(request, ConfirmInput, 6 * MAX_SOURCE_BYTES + 4096)
        if (value.source == "upload") != (value.content is not None):
            raise HTTPException(422, "Invalid confirmation request")
        entry = reviewed.get(value.preview_token, session.token_hash)
        if (
            entry is None
            or entry.report.source != value.source
            or entry.report.fingerprint != value.fingerprint
            or (value.source == "upload" and entry.format != value.format)
        ):
            raise HTTPException(409, "preview_expired_or_changed: preview and review again")
        content = value.content
        if value.source == "configured":
            if ha.rest is None:
                raise HTTPException(503, "source_not_configured")
            try:
                content = await ha.rest.legacy_configuration()
            except HAError as error:
                raise HTTPException(503, f"source_{error.code}") from None
        assert content is not None
        try:
            current = await run_in_threadpool(preview, content, entry.format, source=value.source)
        except PreviewError as error:
            raise HTTPException(422, str(error)) from None
        if current.fingerprint != entry.report.fingerprint:
            raise HTTPException(409, "source_changed_review_again")
        values = [
            AssignmentInput(
                ha_tag_id=row.ha_tag_id,
                input=row.media_content_id,
                media_type="album" if row.media_content_type == "album" else "playlist",
                expected_version=0,
                enabled=value.enabled,
                shuffle=value.shuffle,
                playback_profile_id=value.playback_profile_id,
            )
            for row in current.rows
            if row.accepted
            and row.ha_tag_id is not None
            and row.media_content_id is not None
            and row.media_content_type in {"album", "playlist"}
        ]
        try:
            imported, skipped = await run_in_threadpool(
                store.import_rows, values, entry.revision, value.conflict_policy
            )
        except AssignmentConflict as error:
            raise conflict(error) from None
        reviewed.entries.pop(value.preview_token, None)
        return {"imported": imported, "skipped": skipped, "report": entry.report.model_dump()}

    return router
