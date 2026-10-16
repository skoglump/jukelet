# Development and Docker operation

JBM-002 implements the application foundation. It does not connect to Home Assistant or Spotify. The interface shows the actual read-only state and unavailable integrations; it contains no sample assignments presented as live data.

## Local Docker quick start

Prerequisites: Docker Engine with Compose, and Python 3 for the secret-generation helper. Run from the repository root:

```sh
python3 scripts/init_secret.py
docker compose -f compose.yaml -f compose.dev.yaml build
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait
```

Open `http://localhost:8000`. Read `.secrets/app-auth-token` locally and enter its value in the login form. Do not paste it into issues, logs, or chat. The helper never prints the secret or replaces an existing file. It creates a private directory (0700) containing a read-only secret file (0444), allowing the non-root container to read the individually mounted file without granting other host users access through that directory.

The development override explicitly permits HTTP for a loopback public origin, and Compose publishes only `127.0.0.1:8000`. Use `JUKELET_PORT` to change the published port; the development origin changes with it. The compiled frontend and API share one origin. Rebuild and recreate the container to apply code changes.

```sh
docker compose -f compose.yaml -f compose.dev.yaml down
```

Stopping or replacing the container preserves the named `jukelet_data` volume. `down --volumes` deletes it and is only used by the isolated smoke-test harness. The image runs as UID/GID 10001, with a read-only root filesystem and writable `/data` and `/tmp`. Bind-mounted data directories, if used instead of the default named volume, must be writable by UID 10001.

## HTTPS deployment

Use the base `compose.yaml` without the development override. Set `APP_PUBLIC_ORIGIN` to the exact external HTTPS origin, such as `https://jukelet.example`, and place an existing TLS reverse proxy in front of the loopback-published port. Preserve the external Host header, including a non-default port. The app does not trust forwarded headers and has no public-internet deployment configuration in this milestone.

HTTPS mode uses Secure cookies. Plain HTTP is rejected unless explicitly enabled with a loopback origin; do not expose the development configuration on a network. Reverse-proxy/TLS integration with a household deployment has not been live-tested.

## Configuration and session contract

| Setting | Behavior |
|---|---|
| `APP_PUBLIC_ORIGIN` | Required exact HTTP(S) origin; no path, credentials, query, or fragment |
| `APP_AUTH_TOKEN_FILE` | Required server-side file containing a 32–128 byte ASCII app secret; helper generates 32 random bytes encoded as hex |
| `APP_ALLOW_INSECURE_HTTP` | Defaults to `false`; `true` permits HTTP only for a loopback origin |
| `DATABASE_PATH` | SQLite path; `/data/jukelet.db` in Docker |
| `APP_STATIC_DIR` | Compiled frontend directory; `/app/frontend` in Docker |
| `APP_MODE` | Defaults to `read_only`; other values fail startup in M0 |
| `JUKELET_SECRET_FILE` | Compose host-side secret-file path; defaults to `.secrets/app-auth-token` |
| `JUKELET_PORT` | Compose loopback port; defaults to 8000 |
| `JUKELET_IMAGE` | Local image tag; defaults to `jukelet:local` |

No HA URL, HA token, Spotify token, or external service is required or read. Missing/unreadable secrets, invalid configuration and migration failures prevent startup. Configuration errors do not include input values.

- `GET /health/live` is public and reports only `{"status":"ok"}`. It does not contact upstream services. Docker may call it using its internal loopback host.
- `POST /api/v1/session` accepts JSON `{"secret":"..."}` and requires the configured Origin. Successful login returns `authenticated`, `mode`, `expires_at` (UTC), and `csrf_token`, and sets an opaque HttpOnly/SameSite=Strict cookie. Login replaces any session already presented by that browser.
- `GET /api/v1/session` requires the cookie and returns the same fields, or 401. This is the M0 session probe, not the planned M1 integration-status endpoint.
- `DELETE /api/v1/session` requires both the configured Origin and `X-CSRF-Token` from the session response. It revokes the session and clears the cookie with a 204 response.
- Errors use a bounded `{"detail":"..."}` response; invalid bodies do not echo values. Login bodies are limited to 4096 bytes. Incorrect credentials return 401, invalid origin/CSRF returns 403, malformed JSON/fields return 422, and throttled attempts return 429 with `Retry-After: 60`.
- Sessions expire after eight hours, survive container replacement, and become invalid when the secret changes and the app restarts. SQLite stores an HMAC of each session identifier, bound to the app secret; the cookie value and app secret are not stored in the database. Do not reuse an old secret when rotating.
- A thread-safe, in-memory global limit admits ten login attempts per rolling minute for this single-owner, single-worker deployment. Restarting resets this limit. Expired session rows are pruned on login.
- Browser code keeps the CSRF token only in memory and clears the entered app secret after each login attempt. No app credentials or session data are written to local/session storage. API access logging is disabled, responses use `Cache-Control: no-store`, and frontend assets contain no credentials.

## Reproducible development checks

Supported baseline: Node 24.22.0 with its npm 11.19.1, Python 3.14.8, and uv 0.13.1. Runtime selection is recorded in `.nvmrc`, `.python-version`, the Dockerfile and CI. Install these tools before running host development commands; `uv` is not bundled in the application image.

```sh
make bootstrap
make check
make build
make image
cd frontend
npx playwright install chromium
cd ..
make smoke
```

`make bootstrap` uses `uv sync --locked` and `npm ci`. `make check` runs Ruff lint/format checks, strict mypy, pytest, ESLint, TypeScript and Vitest. `make build` builds the Python distribution and frontend. `make smoke` runs real HTTP checks and a Chromium browser against isolated Docker containers with generated synthetic credentials and a temporary volume. It verifies session persistence across replacement, non-root execution, invalid startup configuration, secret isolation and login/logout. Cleanup removes only its uniquely named Compose project and volume.

Use `python3 scripts/smoke.py` for the same container checks without Chromium. The full browser run saves only the empty mobile login screen to the ignored `frontend/test-results` directory; traces and video are disabled. CI installs Chromium system dependencies and runs all checks on Ubuntu 24.04. CI does not publish an image or deploy an application.

Frontend libraries are React 19.3.1 and Vite 8.3.4. TypeScript is pinned to 6.0.3 because typescript-eslint 8.71.2 does not support TypeScript 7. The backend uses FastAPI 0.143.2, SQLAlchemy 2.1.4 and Alembic 1.20.0. Complete dependency versions and hashes live in the lockfiles; the Python build backend and container base-image digests are also pinned.

Version and packaging references checked during implementation: [Node release schedule](https://github.com/nodejs/Release), [Python 3.14.8](https://www.python.org/downloads/release/python-3148/), [Vite requirements](https://vite.dev/guide/), [uv locked installs](https://docs.astral.sh/uv/concepts/projects/sync/), and [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

## Limits

M0 supports one owner, one backend worker, one SQLite database and one container. Only the session schema is implemented. No tag inventory, assignment editing, HA transport, Spotify provider, companion, playback, or migration is included. No live household checks were performed. The local verification platform is Linux x86-64; other architectures are not yet verified.
