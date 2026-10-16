import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import JSONResponse, Response
from starlette.staticfiles import StaticFiles

from jukelet.api import require_session, session_router
from jukelet.auth import AuthService
from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import HAStatus
from jukelet.storage import migrate, open_database


def create_app(settings: Settings | None = None, clock: Callable[[], float] = time.time) -> FastAPI:
    settings = settings or Settings.load()
    engine = open_database(settings.database_path)
    auth = AuthService(engine, settings.auth_secret, clock)

    ha = HAAdapter(settings.ha_url, settings.ha_token)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            migrate(engine)
            ha.start()
            yield
        finally:
            await ha.close()
            engine.dispose()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    expected_host = urlsplit(settings.public_origin).netloc.lower()
    public_origin = settings.public_origin

    @app.middleware("http")
    async def boundaries(request: Request, call_next: RequestResponseEndpoint) -> Response:
        if (
            request.url.path != "/health/live"
            and request.headers.get("host", "").lower() != expected_host
        ):
            response: Response = JSONResponse({"detail": "Invalid host"}, status_code=400)
        elif request.method in {"POST", "PUT", "PATCH", "DELETE"} and (
            request.headers.get("origin") != public_origin
        ):
            response = JSONResponse({"detail": "Request verification failed"}, status_code=403)
        else:
            response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"detail": "Invalid request"}, status_code=422)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(
            {"detail": exc.detail}, status_code=exc.status_code, headers=exc.headers
        )

    @app.get("/health/live")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/v1/status")
    def integration_status(request: Request) -> HAStatus:
        require_session(request, auth)
        return ha.snapshot()

    app.include_router(session_router(settings, auth))
    if settings.static_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="frontend")
    return app
