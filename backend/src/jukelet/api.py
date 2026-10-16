import hmac
import json
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError
from starlette.concurrency import run_in_threadpool

from jukelet.auth import COOKIE_NAME, SESSION_SECONDS, AuthService
from jukelet.config import Settings
from jukelet.storage import OwnerSession


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    secret: SecretStr = Field(max_length=128)


class SessionView(BaseModel):
    authenticated: Literal[True] = True
    mode: Literal["read_only"] = "read_only"
    expires_at: datetime
    csrf_token: str


def session_view(record: OwnerSession) -> SessionView:
    return SessionView(
        expires_at=datetime.fromtimestamp(record.expires_at, UTC), csrf_token=record.csrf_token
    )


def require_session(request: Request, auth: AuthService) -> OwnerSession:
    record = auth.lookup(request.cookies.get(COOKIE_NAME))
    if record is None:
        raise HTTPException(401, "Authentication required")
    return record


def session_router(settings: Settings, auth: AuthService) -> APIRouter:
    router = APIRouter(prefix="/api/v1/session")

    @router.post("")
    async def login(request: Request, response: Response) -> SessionView:
        if not auth.allow_attempt():
            raise HTTPException(429, "Too many login attempts", headers={"Retry-After": "60"})
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise HTTPException(415, "JSON required")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 4096:
                raise HTTPException(413, "Request too large")
        try:
            credentials = LoginInput.model_validate(json.loads(body))
        except ValueError, ValidationError:
            raise HTTPException(422, "Invalid login request") from None
        result = await run_in_threadpool(
            auth.login, credentials.secret.get_secret_value(), request.cookies.get(COOKIE_NAME)
        )
        if result is None:
            raise HTTPException(401, "Authentication failed")
        token, record = result
        response.set_cookie(
            COOKIE_NAME,
            token,
            max_age=SESSION_SECONDS,
            httponly=True,
            secure=settings.secure_cookie,
            samesite="strict",
            path="/",
        )
        return session_view(record)

    @router.get("")
    def current_session(request: Request) -> SessionView:
        return session_view(require_session(request, auth))

    @router.delete("", status_code=204)
    def logout(request: Request) -> Response:
        record = require_session(request, auth)
        csrf = request.headers.get("x-csrf-token", "")
        if not hmac.compare_digest(csrf.encode(), record.csrf_token.encode()):
            raise HTTPException(403, "Request verification failed")
        auth.revoke(record)
        response = Response(status_code=204)
        response.delete_cookie(
            COOKIE_NAME, path="/", secure=settings.secure_cookie, httponly=True, samesite="strict"
        )
        return response

    return router
