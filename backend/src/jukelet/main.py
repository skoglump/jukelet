import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import JSONResponse, Response
from starlette.staticfiles import StaticFiles

from jukelet.api import require_session, session_router
from jukelet.assignment_api import assignment_router
from jukelet.assignments import AssignmentStore
from jukelet.auth import AuthService
from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.ha.models import HAStatus
from jukelet.import_api import import_router
from jukelet.inventory import InventoryView, inventory_view
from jukelet.music_api import music_router
from jukelet.providers.spotifyplus import SpotifyPlus
from jukelet.storage import migrate, open_database
from jukelet.tag_onboarding import onboarding_router


def create_app(settings: Settings | None = None, clock: Callable[[], float] = time.time) -> FastAPI:
    settings = settings or Settings.load()
    engine = open_database(settings.database_path)
    auth = AuthService(engine, settings.auth_secret, clock)

    ha = HAAdapter(
        settings.ha_url, settings.ha_token, legacy_entity=settings.legacy_automation_entity_id
    )

    ha.status.mode = settings.mode

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
            "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; "
            "img-src 'self' https://i.scdn.co https://mosaic.scdn.co "
            "https://image-cdn-ak.spotifycdn.com https://image-cdn-fa.spotifycdn.com"
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

    @app.get("/api/v1/tags")
    async def tags(
        request: Request,
        offset: int = Query(0, ge=0, le=20000),
        limit: int = Query(100, ge=1, le=200),
    ) -> InventoryView:
        require_session(request, auth)
        return inventory_view(ha, offset, limit)

    store = AssignmentStore(engine)
    app.include_router(onboarding_router(settings, auth, ha, store))
    app.include_router(assignment_router(settings, auth, store))
    app.include_router(music_router(auth, SpotifyPlus(ha, settings.spotifyplus_entity_id)))
    app.include_router(import_router(auth, ha, settings, store))
    app.include_router(session_router(settings, auth))
    if settings.static_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="frontend")
    return app
