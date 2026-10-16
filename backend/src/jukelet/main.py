from fastapi import FastAPI


def create_app() -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health/live")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
