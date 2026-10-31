import hmac
import json
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError
from starlette.concurrency import run_in_threadpool

from jukelet.auth import SESSION_SECONDS, AuthService, cookie_name
from jukelet.config import Settings
from jukelet.ingress import IngressIdentity
from jukelet.storage import OwnerSession


class LoginInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    secret: SecretStr = Field(max_length=128)


class SessionView(BaseModel):
    authenticated: Literal[True] = True
    mode: Literal["read_only", "manage"] = "read_only"
    runtime: Literal["standalone", "ingress"] = "standalone"
    user_id: str | None = None
    expires_at: datetime
    csrf_token: str


def session_view(
    record: OwnerSession, settings: Settings, identity: IngressIdentity | None = None
) -> SessionView:
    return SessionView(
        mode=settings.mode,
        runtime=settings.runtime,
        user_id=identity.user_id if identity is not None else None,
        expires_at=datetime.fromtimestamp(record.expires_at, UTC),
        csrf_token=record.csrf_token,
    )


def require_session(request: Request, auth: AuthService) -> OwnerSession:
    record = auth.lookup(request.cookies.get(auth.cookie_name), request_identity(request, auth))
    if record is None:
        raise HTTPException(401, "Authentication required")
    return record


def request_identity(request: Request, auth: AuthService) -> IngressIdentity | None:
    if auth.runtime == "standalone":
        return None
    identity = getattr(request.state, "ingress_identity", None)
    if not isinstance(identity, IngressIdentity):
        raise HTTPException(403, "Ingress access denied")
    return identity


def set_session_cookie(
    response: Response, token: str, settings: Settings, identity: IngressIdentity | None = None
) -> None:
    response.set_cookie(
        cookie_name(settings.runtime),
        token,
        max_age=SESSION_SECONDS,
        httponly=True,
        secure=settings.secure_cookie,
        samesite="strict",
        path=identity.path if identity is not None else "/",
    )


def session_router(settings: Settings, auth: AuthService) -> APIRouter:
    router = APIRouter(prefix="/api/v1/session")

    @router.post("")
    async def login(request: Request, response: Response) -> SessionView:
        if settings.runtime == "ingress":
            raise HTTPException(
                405, "Use the Home Assistant Ingress session", headers={"Allow": "GET"}
            )
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
            auth.login, credentials.secret.get_secret_value(), request.cookies.get(auth.cookie_name)
        )
        if result is None:
            raise HTTPException(401, "Authentication failed")
        token, record = result
        set_session_cookie(response, token, settings)
        return session_view(record, settings)

    @router.get("")
    def current_session(request: Request, response: Response) -> SessionView:
        identity = request_identity(request, auth)
        record = auth.lookup(request.cookies.get(auth.cookie_name), identity)
        if record is None:
            if identity is None:
                raise HTTPException(401, "Authentication required")
            token, record = auth.ingress_login(identity, request.cookies.get(auth.cookie_name))
            set_session_cookie(response, token, settings, identity)
        return session_view(record, settings, identity)

    @router.delete("", status_code=204)
    def logout(request: Request) -> Response:
        if settings.runtime == "ingress":
            raise HTTPException(
                405, "Manage sign-in through Home Assistant", headers={"Allow": "GET"}
            )
        record = require_session(request, auth)
        csrf = request.headers.get("x-csrf-token", "")
        if not hmac.compare_digest(csrf.encode(), record.csrf_token.encode()):
            raise HTTPException(403, "Request verification failed")
        auth.revoke(record)
        response = Response(status_code=204)
        response.delete_cookie(
            auth.cookie_name,
            path="/",
            secure=settings.secure_cookie,
            httponly=True,
            samesite="strict",
        )
        return response

    return router
