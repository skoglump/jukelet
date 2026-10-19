"""Authenticated, bounded preview reads. No assignment repository or mutation routes."""

import hmac
import json
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from jukelet.api import require_session
from jukelet.auth import AuthService
from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import HAError
from jukelet.importers.legacy import MAX_SOURCE_BYTES, PreviewError, PreviewReport, preview


class PreviewInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source: Literal["upload", "configured"]
    format: Literal["json", "yaml"] = "yaml"
    content: str | None = Field(default=None, max_length=MAX_SOURCE_BYTES)
    expected_fingerprint: str | None = Field(default=None, pattern="^[a-f0-9]{64}$")


def import_router(auth: AuthService, ha: HAAdapter) -> APIRouter:
    router = APIRouter(prefix="/api/v1/imports")

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
            return await run_in_threadpool(
                preview,
                content,
                "json" if value.source == "configured" else value.format,
                source=value.source,
                registry=ha.inventory,
                registry_updated_at=ha.status.inventory_updated_at,
                registry_stale=ha.status.inventory_stale,
                expected_fingerprint=value.expected_fingerprint,
            )
        except PreviewError as error:
            raise HTTPException(422, str(error)) from None

    return router
