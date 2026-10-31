import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from starlette.concurrency import run_in_threadpool
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
from jukelet.ingress import verified_identity
from jukelet.inventory import inventory_view
from jukelet.music_api import music_router
from jukelet.playback_status import PlaybackStatus, playback_status_router
from jukelet.providers.spotifyplus import SpotifyPlus
from jukelet.publication import Publisher
from jukelet.publication_api import publication_router
from jukelet.publication_store import PublicationStore
from jukelet.recovery_api import recovery_router
from jukelet.saved_inventory import SavedInventoryView, saved_inventory
from jukelet.storage import migrate, open_database
from jukelet.tag_onboarding import onboarding_router


def create_app(settings: Settings | None = None, clock: Callable[[], float] = time.time) -> FastAPI:
    settings = settings or Settings.load()
    engine = open_database(settings.database_path)
    auth = AuthService(engine, settings.auth_secret, clock)

    ha = HAAdapter(settings.ha_url, settings.ha_token)

    ha.status.mode = settings.mode
    publication = PublicationStore(engine)
    publisher = Publisher(publication, ha, settings.mode == "manage")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            migrate(engine)
            ha.start()
            publisher.start()
            yield
        finally:
            await publisher.close()
            await ha.close()
            engine.dispose()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    origins_by_host = {
        urlsplit(origin).netloc.lower(): origin for origin in settings.allowed_origins
    }

    @app.middleware("http")
    async def boundaries(request: Request, call_next: RequestResponseEndpoint) -> Response:
        response: Response
        try:
            # This sole exemption exposes no application state and cannot mint a session.
            if request.method not in {"GET", "HEAD"} or request.url.path != "/health/live":
                if settings.runtime == "ingress":
                    request.state.ingress_identity = verified_identity(request)
                hosts = request.headers.getlist("host")
                origin = origins_by_host.get(hosts[0].lower()) if len(hosts) == 1 else None
                if origin is None:
                    raise HTTPException(400, "Invalid host")
                if request.method in {"POST", "PUT", "PATCH", "DELETE"} and (
                    request.headers.getlist("origin") != [origin]
                ):
                    raise HTTPException(403, "Request verification failed")
            response = await call_next(request)
        except HTTPException as exc:
            response = JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        frame_ancestors = "'self'" if settings.runtime == "ingress" else "'none'"
        response.headers["Content-Security-Policy"] = (
            f"default-src 'self'; frame-ancestors {frame_ancestors}; "
            "base-uri 'none'; form-action 'self'; "
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
    ) -> SavedInventoryView:
        require_session(request, auth)
        return await run_in_threadpool(saved_inventory, inventory_view(ha, offset, limit), store)

    store = AssignmentStore(engine)
    app.include_router(publication_router(settings, auth, publisher))
    app.include_router(playback_status_router(auth, PlaybackStatus(ha)))
    app.include_router(onboarding_router(settings, auth, ha, store))
    app.include_router(assignment_router(settings, auth, store))
    app.include_router(recovery_router(settings, auth, store, ha, publication))
    app.include_router(music_router(auth, SpotifyPlus(ha, settings.spotifyplus_entity_id)))

    @app.post("/api/v1/imports/preview")
    @app.post("/api/v1/imports/confirm")
    def retired_automation_import(request: Request) -> JSONResponse:
        # Tombstones only: never parse source data, contact HA, or open a write transaction.
        require_session(request, auth)
        return JSONResponse({"detail": {"code": "automation_import_retired"}}, status_code=410)

    app.include_router(session_router(settings, auth))
    if settings.static_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.static_dir, html=True), name="frontend")
    return app
