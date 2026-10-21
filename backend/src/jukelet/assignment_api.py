"""Authenticated local-only assignment operations with bounded strict requests."""

import hmac
import json
import re

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from jukelet.api import require_session
from jukelet.assignments import (
    AssignmentConflict,
    AssignmentInput,
    AssignmentPage,
    AssignmentState,
    AssignmentStore,
    DeleteInput,
)
from jukelet.auth import AuthService
from jukelet.config import Settings
from jukelet.inventory import tag_key
from jukelet.storage import OwnerSession


def verify_write(request: Request, auth: AuthService, settings: Settings) -> OwnerSession:
    session = require_session(request, auth)
    if not hmac.compare_digest(
        request.headers.get("x-csrf-token", "").encode(), session.csrf_token.encode()
    ):
        raise HTTPException(403, "Request verification failed")
    if settings.mode != "manage":
        raise HTTPException(403, "Management writes require APP_MODE=manage")
    return session


async def read_input[T: BaseModel](request: Request, model: type[T], limit: int = 8192) -> T:
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415, "JSON required")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise HTTPException(413, "Request too large")
    try:
        return model.model_validate(json.loads(body))
    except ValueError, RecursionError:
        raise HTTPException(422, "Invalid request") from None


def conflict(error: AssignmentConflict) -> HTTPException:
    return HTTPException(409, {"code": "assignment_conflict", "current_version": error.version})


def assignment_router(settings: Settings, auth: AuthService, store: AssignmentStore) -> APIRouter:
    router = APIRouter(prefix="/api/v1")

    def valid_key(key: str) -> None:
        if not re.fullmatch("[a-f0-9]{64}", key):
            raise HTTPException(422, "Invalid tag key")

    @router.get("/assignments")
    def assignments(
        request: Request,
        offset: int = Query(0, ge=0, le=1000000),
        limit: int = Query(100, ge=1, le=200),
    ) -> AssignmentPage:
        require_session(request, auth)
        return store.page(offset, limit)

    @router.get("/tags/{key}/assignment")
    def assignment(request: Request, key: str) -> AssignmentState:
        require_session(request, auth)
        valid_key(key)
        return store.state(key)

    @router.put("/tags/{key}/assignment")
    async def put(request: Request, key: str) -> AssignmentState:
        verify_write(request, auth, settings)
        valid_key(key)
        value = await read_input(request, AssignmentInput)
        if tag_key(value.ha_tag_id) != key:
            raise HTTPException(422, "Tag key and exact ID disagree")
        try:
            return await run_in_threadpool(store.put, value)
        except AssignmentConflict as error:
            raise conflict(error) from None

    @router.delete("/tags/{key}/assignment")
    async def delete(request: Request, key: str) -> AssignmentState:
        verify_write(request, auth, settings)
        valid_key(key)
        value = await read_input(request, DeleteInput)
        try:
            return await run_in_threadpool(store.delete, key, value.expected_version)
        except AssignmentConflict as error:
            raise conflict(error) from None

    return router
