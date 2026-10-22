"""Authenticated recovery routes; no HA mutations or metadata requests."""

import hmac

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

from jukelet.api import require_session
from jukelet.assignment_api import conflict, read_input, verify_write
from jukelet.assignments import AssignmentConflict, AssignmentStore
from jukelet.auth import AuthService
from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.publication_store import PublicationStore
from jukelet.recovery import (
    MAX_BYTES,
    ConfirmInput,
    RecoveryService,
    RestoreReport,
    encoded,
    parse_document_request,
)


def recovery_router(
    settings: Settings,
    auth: AuthService,
    store: AssignmentStore,
    ha: HAAdapter,
    publication: PublicationStore,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1")
    service = RecoveryService(store, publication)

    @router.get("/export")
    async def export(request: Request) -> Response:
        require_session(request, auth)
        names = {tag.id: tag.name for tag in ha.inventory}
        try:
            document = await run_in_threadpool(
                service.export, names, ha.status.inventory_updated_at, ha.status.inventory_stale
            )
        except ValueError:
            raise HTTPException(
                422, "Export exceeds supported limits; use protected database backup"
            ) from None
        return Response(
            encoded(document),
            media_type="application/json",
            headers={
                "Content-Disposition": 'attachment; filename="jukelet-export-v1.json"',
            },
        )

    @router.get("/recovery")
    def status(request: Request) -> dict[str, bool]:
        require_session(request, auth)
        return service.status()

    @router.post("/restores/preview")
    async def preview(request: Request) -> RestoreReport:
        session = require_session(request, auth)
        if not hmac.compare_digest(
            request.headers.get("x-csrf-token", "").encode(), session.csrf_token.encode()
        ):
            raise HTTPException(403, "Request verification failed")
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise HTTPException(415, "JSON required")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_BYTES + 4096:
                raise HTTPException(413, "Request too large")
        try:
            value = parse_document_request(bytes(body))
            # Database work must not block unrelated inventory and metadata requests.
            return await run_in_threadpool(service.preview, value.document, session.token_hash)
        except ValueError, RecursionError:
            raise HTTPException(422, "Invalid or unsupported export document") from None

    @router.post("/restores/confirm")
    async def confirm(request: Request) -> dict[str, object]:
        session = verify_write(request, auth, settings)
        value = await read_input(request, ConfirmInput)
        try:
            return await run_in_threadpool(service.confirm, value, session.token_hash)
        except AssignmentConflict as error:
            raise conflict(error) from None

    return router
