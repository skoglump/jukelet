"""Narrow, authenticated metadata previews. The POST has no persistence effects."""

import hmac
import json

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.responses import JSONResponse

from jukelet.api import require_session
from jukelet.auth import AuthService
from jukelet.ha.models import CapabilityState
from jukelet.providers.spotifyplus import MediaType, MusicResult, SpotifyPlus


class ResolveInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    input: str = Field(min_length=1, max_length=512)
    media_type: MediaType


def result_response(result: MusicResult) -> JSONResponse:
    return JSONResponse(
        result.model_dump(),
        status_code=200 if result.error is None else 503,
        headers={"Retry-After": str(result.retry_after)} if result.retry_after else None,
    )


def music_router(auth: AuthService, provider: SpotifyPlus) -> APIRouter:
    router = APIRouter(prefix="/api/v1/music")

    @router.get("/capabilities")
    def capabilities(request: Request) -> dict[str, CapabilityState]:
        require_session(request, auth)
        return provider.capabilities()

    @router.post("/resolve")
    async def resolve(request: Request) -> JSONResponse:
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
            if len(body) > 4096:
                raise HTTPException(413, "Request too large")
        try:
            value = ResolveInput.model_validate(json.loads(body))
            result = await provider.resolve(value.input, value.media_type)
        except ValueError, ValidationError, RecursionError:
            raise HTTPException(422, "Unsupported Spotify URI, link or media type") from None
        return result_response(result)

    @router.get("/library")
    async def library(
        request: Request, media_type: MediaType, offset: int = Query(0, ge=0, le=1000)
    ) -> JSONResponse:
        require_session(request, auth)
        return result_response(await provider.library(media_type, offset))

    @router.get("/search")
    async def search(
        request: Request, media_type: MediaType, q: str = Query(min_length=1, max_length=200)
    ) -> JSONResponse:
        require_session(request, auth)
        if not q.strip():
            raise HTTPException(422, "Search requires 1–200 characters")
        return result_response(await provider.search(media_type, q))

    return router
