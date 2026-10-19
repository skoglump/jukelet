# Development and Docker operation

JBM-002 implements the application foundation; issue #4 adds optional read-only Home Assistant transport and connection/capability status. Issue #9 adds tag inventory and read-only legacy mapping preview. The interface contains no sample assignments presented as live data.

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
| `APP_MODE` | Defaults to `read_only`; other values fail startup |
| `HA_URL` | Optional exact HTTP(S) origin, including optional port; no trailing slash, path, user credentials, query or fragment |
| `HA_TOKEN` | Server-side HA access token; required with `HA_URL`, supplied through the environment |
| `LEGACY_AUTOMATION_ENTITY_ID` | Optional configured read-only source, matching `automation.[a-z0-9_]{1,128}`; no per-request entity/URL override |
| `JUKELET_SECRET_FILE` | Compose host-side secret-file path; defaults to `.secrets/app-auth-token` |
| `JUKELET_PORT` | Compose loopback port; defaults to 8000 |
| `JUKELET_IMAGE` | Local image tag; defaults to `jukelet:local` |

Leave both HA settings empty for fixture/default operation with no upstream traffic. Set both to enable HA; partial or invalid settings fail startup. Compose references `${HA_URL:-}` and `${HA_TOKEN:-}` without committing values. Keep environment files outside Git and do not print Compose configuration with secrets. Docker users can inspect container environment variables. No Spotify token is read. Missing/unreadable secrets, invalid configuration and migration failures prevent startup. Configuration errors do not include input values.

- `GET /health/live` is public and reports only `{"status":"ok"}`. It does not contact upstream services. Docker may call it using its internal loopback host.
- `POST /api/v1/session` accepts JSON `{"secret":"..."}` and requires the configured Origin. Successful login returns `authenticated`, `mode`, `expires_at` (UTC), and `csrf_token`, and sets an opaque HttpOnly/SameSite=Strict cookie. Login replaces any session already presented by that browser.
- `GET /api/v1/session` requires the cookie and returns the same fields, or 401. This is the session probe.
- `GET /api/v1/status` requires the session cookie and returns cached read-only mode, connection/version, separate tag/subscription capabilities, six SpotifyPlus capability summaries (recognized field names and response support), freshness timestamps and bounded error codes. It never contacts HA per request or returns raw config, tags, entity IDs, URL or token. The signed-in UI polls every 10 seconds after each completed request and cancels on logout.
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

`make bootstrap` uses `uv sync --locked` and `npm ci`. `make check` runs Ruff lint/format checks, strict mypy, pytest, ESLint, TypeScript and Vitest. `make build` builds the Python distribution and frontend. `make smoke` runs real HTTP checks and a Chromium browser against isolated Docker containers with generated synthetic credentials and a temporary volume. It verifies session persistence across replacement, non-root execution, invalid startup configuration, secret isolation, login/logout and synthetic uploaded preview/report download. The harness explicitly clears inherited `HA_URL`, `HA_TOKEN` and `LEGACY_AUTOMATION_ENTITY_ID` (also overriding Compose environment files), so it cannot connect to a household deployment. Cleanup removes only its uniquely named Compose project and volume.

Use `python3 scripts/smoke.py` for the same container checks without Chromium. The full browser run saves only the empty mobile login screen to the ignored `frontend/test-results` directory; traces and video are disabled. CI installs Chromium system dependencies and runs all checks on Ubuntu 24.04. CI does not publish an image or deploy an application.

Frontend libraries are React 19.3.1 and Vite 8.3.4. TypeScript is pinned to 6.0.3 because typescript-eslint 8.71.2 does not support TypeScript 7. The backend uses FastAPI 0.143.2, SQLAlchemy 2.1.4 and Alembic 1.20.0. Complete dependency versions and hashes live in the lockfiles; the Python build backend and container base-image digests are also pinned.

Version and packaging references checked during implementation: [Node release schedule](https://github.com/nodejs/Release), [Python 3.14.8](https://www.python.org/downloads/release/python-3148/), [Vite requirements](https://vite.dev/guide/), [uv locked installs](https://docs.astral.sh/uv/concepts/projects/sync/), and [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

## Limits

This release supports one owner, one backend worker, one SQLite database and one container. Only the session database schema is implemented. HA inventory and scan observations are cached in memory and displayed with freshness; they are refreshed after restart. Preview reports are generated per request and retained only in browser memory unless explicitly downloaded. No assignment editing/commit, Spotify provider normalization/browsing, companion, playback, or migration is included. No live household checks were performed. The local verification platform is Linux x86-64; other architectures are not yet verified.

## HA connection behavior

HA is optional and public health remains independent of HA availability. Connection states are `not_configured`, `connecting`, `connected`, `disconnected`, and `unauthorized`. Capability states are `unknown`, `supported`, and `unsupported`; installed service schemas must expose the required known fields and response support. Available services do not prove metadata lookup or playback success. The six read-intent metadata methods are internal transport APIs only.

One persistent WebSocket authenticates, subscribes to `tag_scanned` and reads `tag/list`; REST reads `/api/config` and `/api/services`. Automatic reconnect restores subscription and refreshes the registry/services. A failed refresh retains the last good inventory and its timestamp, marked stale. `last_success_at` advances only when config read, service discovery, scan subscription and inventory refresh all succeed in one discovery pass; partial or total failure preserves the previous value (initially null). Individual capability and cache timestamps still update independently. No historical scan replay is claimed. Authentication rejection requires a restart with corrected configuration. Other failures retry with jittered exponential delays capped at 30 seconds.

Transport limits: 10 seconds per request including slot wait, 32 simultaneous WebSocket commands, 32 REST requests, 4 MiB per response/frame and 128 queued scan notifications. Queue overflow drops the oldest notification, records a gap and schedules registry reconciliation. Connections never follow redirects or environment proxies and verify TLS normally. Do not enable transport wire logging. Supported normalized errors are `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `timeout`, `unavailable`, `unsupported_response`, and `unsupported_operation`.

Tests use synthetic HTTP fixtures and a local fake WebSocket server, including auth rejection, deadlines, malformed/oversized responses, concurrency/correlation, disconnect/reconnect, subscription restoration and last-good cache preservation. No live HA handshake, service lookup, scan or playback verification has been performed.

## Inventory and legacy preview (#9)

The signed-in inventory polls `GET /api/v1/tags?offset=0&limit=100` every five seconds after a completed request. The endpoint accepts offsets 0–20,000 and page sizes 1–200. It returns normalized tags, exact total, registry availability, staleness, last successful registry timestamp and discovery-gap status. IDs are exact nonempty strings of at most 512 Unicode characters with valid UTF-8 encoding. Case, separators, whitespace and Unicode normalization are never changed. Browser keys are SHA-256 of the exact UTF-8 ID, so they remain stable after restart without an additional database table. Names/readers are bounded to 512 characters. HA timestamps must include a timezone and are normalized to UTC; malformed snapshots retain the last good cache.

A scan is visible immediately as pending discovery when absent from the registry. Scan receipt timestamps are local observations rather than replayed event history. Observations are merged by exact ID; registry names replace the pending display without creating another row. Each coalesced scan burst triggers at most three registry reads (immediately, after 250 ms, after another second); scans arriving during a read schedule a subsequent bounded pass. Unresolved discoveries remain explicitly pending until another scan or reconnection reconciles them. There is no `tag/create`, scan simulation or playback call. The registry and observation caches each hold at most 10,000 entries; observation overflow evicts the oldest retained ID and records a discovery gap. Registry deletion/history persistence and historical scan replay are outside this slice.

`POST /api/v1/imports/preview` requires an owner session, configured Origin and `X-CSRF-Token`. Send one of these JSON envelopes (synthetic examples):

```json
{"source":"configured"}
```

```json
{"source":"upload","format":"yaml","content":"variables: {tags: {}}"}
```

The UI decodes a selected JSON/YAML file as strict UTF-8 into that envelope (invalid byte sequences are rejected). Uploads do not require HA configuration. Configured previews perform only `GET /api/states/<configured entity>` followed by `GET /api/config/automation/config/<resolved id>`. Resolved IDs must match `[a-zA-Z0-9_-]{1,128}`. This version-sensitive HA endpoint may be unavailable or forbidden; errors explicitly offer the upload fallback. Redirects, arbitrary URLs/entities and mutations are not supported. Raw automation content is transient server input and is never returned, persisted or logged.

The source must contain one literal `variables.tags` mapping. Only exact string keys and static `media_content_id`/`media_content_type` fields are accepted. Album/playlist URIs must match `spotify:(album|playlist):[A-Za-z0-9]{22}` and agree with the declared type. Links, tracks, templates, extra mapping fields, duplicate mapping IDs/fields and malformed rows are rejected with explicit row diagnostics. Missing registry tags are warnings: otherwise valid orphaned rows remain accepted for preview. Unsupported rows retain their row number, exact string ID (or non-string scalar key literal), selected media fields and diagnostics in the report. Unrelated automation fields are excluded. No template is evaluated or URL fetched.

JSON and YAML duplicate mapping keys are retained and **all** occurrences rejected, including configured JSON before ordinary dictionary conversion. Ambiguous duplicate `variables`/`tags` containers reject the whole document. YAML uses safe node composition with no object construction; custom tags, aliases and anchors are rejected. Numeric, boolean, null and timestamp keys are rejected rather than converted to tag IDs; quote those IDs in YAML. Limits: 1 MiB UTF-8 source, 32 collection nesting levels, 100,000 parser events and 10,000 mappings. The JSON request envelope is capped at 6 MiB + 4 KiB to accommodate escaping. Limit/syntax errors return bounded 422 diagnostics (oversized envelopes return 413).

Reports contain a SHA-256 fingerprint of the exact UTF-8 source bytes, all normalized rows, source-row counts, join counts and registry freshness. Supply `expected_fingerprint` from the prior report to get `source_changed: true` and `source_changed_review_again` when any source bytes differ, including comments/formatting. The UI automatically compares consecutive previews of the same source kind. This is a review warning, not a commit precondition: there is no confirm/save endpoint in M1.

Count definitions:

- `mappings` is the number of source entries, including duplicates and rejected rows; `accepted + rejected = mappings`.
- `matched` is the number of distinct supported exact tag IDs present in both source mapping keys and the latest successful registry snapshot.
- `unassigned` is the number of registry IDs absent from all source mapping keys. It describes legacy-source membership, not saved app assignments.
- `orphaned` is the number of distinct supported exact source IDs absent from that registry snapshot.
- Join counts include rejected mappings with valid literal IDs; pending discoveries are not registered tags. With no successful registry read, all three join counts are `null` (unknown), not verified zero. A known empty registry gives concrete counts. Failed refreshes retain snapshot-based counts with a stale warning.

Download produces a versioned normalized preview report with exact IDs, warnings and rejected rows. It is not an M2 assignment backup/export or restore format. Browser failure retains the previous report with an explicit warning; the server does not persist reports or assignments. All regression fixtures and the browser upload are synthetic. No live HA/Spotify read or playback has been verified for this issue.
