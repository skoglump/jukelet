"""Authenticated, reviewed publication controls. Never dispatch or playback."""

from fastapi import APIRouter, HTTPException, Request

from jukelet.api import require_session
from jukelet.assignment_api import read_input, verify_write
from jukelet.auth import AuthService
from jukelet.config import Settings
from jukelet.publication import ConfirmInput, PublicationError, Publisher, ReviewInput


def publication_router(settings: Settings, auth: AuthService, publisher: Publisher) -> APIRouter:
    router = APIRouter(prefix="/api/v1/publication")

    @router.get("")
    async def status(request: Request) -> dict[str, object]:
        require_session(request, auth)
        return await publisher.refresh()

    @router.post("/review")
    async def review(request: Request) -> dict[str, object]:
        session = verify_write(request, auth, settings)
        value = await read_input(request, ReviewInput)
        try:
            return await publisher.review(value.action, session.token_hash)
        except PublicationError as error:
            raise HTTPException(409, {"code": error.code}) from None

    @router.post("/confirm")
    async def confirm(request: Request) -> dict[str, object]:
        session = verify_write(request, auth, settings)
        value = await read_input(request, ConfirmInput)
        try:
            return await publisher.confirm(value, session.token_hash)
        except PublicationError as error:
            raise HTTPException(409, {"code": error.code}) from None

    @router.post("/suspend")
    async def suspend(request: Request) -> dict[str, object]:
        verify_write(request, auth, settings)
        return await publisher.disable_automatic()

    return router
