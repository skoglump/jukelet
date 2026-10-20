# Development and Docker operation

JBM-002 implements the application foundation; issue #4 adds optional read-only Home Assistant transport and connection/capability status. Issue #9 adds tag inventory and read-only legacy mapping preview. Issue #11 adds [SpotifyPlus music previews](13-spotifyplus-preview.md). The interface contains no sample assignments presented as live data.

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
| `APP_MODE` | Defaults to `read_only`; `manage` enables only local draft writes; other values fail startup |
| `HA_URL` | Optional exact HTTP(S) origin, including optional port; no trailing slash, path, user credentials, query or fragment |
| `HA_TOKEN` | Server-side HA access token; required with `HA_URL`, supplied through the environment |
| `LEGACY_AUTOMATION_ENTITY_ID` | Optional configured read-only source, matching `automation.[a-z0-9_]{1,128}`; no per-request entity/URL override |
| `SPOTIFYPLUS_ENTITY_ID` | Optional metadata account, matching `media_player.[a-z0-9_]{1,128}`; restart to apply account changes |
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

`make bootstrap` uses `uv sync --locked` and `npm ci`. `make check` runs Ruff lint/format checks, strict mypy, pytest, ESLint, TypeScript and Vitest. `make build` builds the Python distribution and frontend. `make smoke` runs real HTTP checks and a Chromium browser against isolated Docker containers with generated synthetic credentials and a temporary volume. It verifies session persistence across replacement, non-root execution, invalid startup configuration, secret isolation, login/logout and synthetic uploaded preview/report download. The harness explicitly clears inherited `HA_URL`, `HA_TOKEN`, `LEGACY_AUTOMATION_ENTITY_ID` and `SPOTIFYPLUS_ENTITY_ID` (also overriding Compose environment files), so it cannot connect to a household deployment. Cleanup removes only its uniquely named Compose project and volume.

Use `python3 scripts/smoke.py` for the same container checks without Chromium. The full browser run saves only the empty mobile login screen to the ignored `frontend/test-results` directory; traces and video are disabled. CI installs Chromium system dependencies and runs all checks on Ubuntu 24.04. CI does not publish an image or deploy an application.

Frontend libraries are React 19.3.1 and Vite 8.3.4. TypeScript is pinned to 6.0.3 because typescript-eslint 8.71.2 does not support TypeScript 7. The backend uses FastAPI 0.143.2, SQLAlchemy 2.1.4 and Alembic 1.20.0. Complete dependency versions and hashes live in the lockfiles; the Python build backend and container base-image digests are also pinned.

Version and packaging references checked during implementation: [Node release schedule](https://github.com/nodejs/Release), [Python 3.14.8](https://www.python.org/downloads/release/python-3148/), [Vite requirements](https://vite.dev/guide/), [uv locked installs](https://docs.astral.sh/uv/concepts/projects/sync/), and [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

## Limits

This release supports one owner, one backend worker, one SQLite database and one container. Only the session database schema is implemented. HA inventory and scan observations are cached in memory and displayed with freshness; they are refreshed after restart. Preview reports are generated per request and retained only in browser memory unless explicitly downloaded. Music metadata/search/library previews use a bounded private in-memory cache. No assignment editing/commit, companion, playback, or migration is included. No live household checks were performed. The local verification platform is Linux x86-64; other architectures are not yet verified.

## HA connection behavior

HA is optional and public health remains independent of HA availability. Connection states are `not_configured`, `connecting`, `connected`, `disconnected`, and `unauthorized`. Capability states are `unknown`, `supported`, and `unsupported`; installed service schemas must expose the required known fields and response support. Available services do not prove metadata lookup or playback success. The six read-intent metadata methods remain internal allowlisted transport APIs, consumed by the narrow music-preview routes; no generic service proxy is exposed.

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

## Read-only manager and isolated browser fixtures (#13)

The manager combines the existing inventory/import and music APIs. Open a tag to inspect its exact ID, HA label, scan/reader and source mapping separately from the music title. Metadata lookup is explicit per recognized mapping; opening inventory or detail never requests an entire library or looks up every tag. Back to tag list restores keyboard focus. The section links and responsive single-column layout support mobile browsing.

Mapping status is unknown until a configured source or uploaded file is previewed. Assigned/unassigned filters mean membership in that specific preview, including rejected source rows. Rejected mappings remain marked for review and cannot trigger lookup; missing-registry rows remain in the report. This is not an app assignment database or evidence of active playback. Tag search and filters apply to the current page of at most 100 tags; paging stays available when filters match nothing. Search includes HA label, exact ID, source label/URI and explicitly loaded music titles. A failed next-page request identifies the retained page rather than presenting it as the new page.

Source reports, inventory and music have independent loading/failure/freshness states. HTTP 503 provider errors and network failures retain mapping URIs, last-good music titles/artwork and timestamps with stale/error labels. Per-mapping display state survives closing/reopening detail during the session. The browser keeps at most 128 explicitly requested mapping metadata results in memory, never persistent browser storage. App-session expiry returns to login; an upstream authentication rejection leaves the app session intact.

Run the actual React UI against a development-only server with synthetic normalized API responses:

```sh
npm --prefix frontend run dev:fixture
# Open http://127.0.0.1:4175; any synthetic app secret signs in.
```

A persistent yellow **Synthetic fixture demo** banner labels simulated tags, music, connections and authentication. Fixture mode binds loopback, disables Vite's backend proxies and terminates every API/health request in the local fixture handler, including unknown operations. It never reads HA/Spotify settings or contacts a household backend. It is a frontend demonstration, not a backend integration/authentication proof. The fixture handler and scenario-control endpoint exist only in Vite fixture mode and are not included in the application bundle. Production login, server sessions, CSRF and provider normalization continue to be checked separately by existing backend/container tests. Fixture artwork is a local synthetic image.

Run the isolated Chromium fixture smoke (starts/stops its own fixture server; install Chromium first):

```sh
cd frontend
npx playwright install chromium
npm run test:fixture
```

The suite exercises keyboard focus, exact IDs, mapping/rejected/unassigned states, metadata success followed by failure with retained artwork, URI lookup, bounded search/library paging, independent capabilities, empty/stale/failed/upstream-auth/app-auth states and a 390px mobile workflow with no horizontal overflow. Synthetic desktop/mobile screenshots are written to ignored `frontend/test-results/`. `make smoke` remains the separate isolated Docker/session/upload/manual-fallback check; neither suite authorizes or proves live household access.


## Local draft assignments (#16)

Set `APP_MODE=manage` explicitly in the container environment (Compose forwards it with a `read_only` default) to enable local assignment editing and confirmed import. This does not authorize HA mutation or playback. The persistent banner distinguishes local desired mappings from the unchanged legacy automation. The read-only mode can inspect existing drafts but blocks writes on the server and hides mutation controls.

The SQLite `0002` migration adds assignments, durable deletion tombstones, a global local revision and a bounded audit. It preserves existing sessions. Exact nonempty UTF-8 tag IDs (up to 512 characters) are retained without normalization; browser keys remain SHA-256 of the exact UTF-8 bytes. Missing registry tags and unavailable metadata do not remove drafts. Metadata remains a separate bounded session cache; it is not stored in assignments.

Authenticated routes:

- `GET /api/v1/assignments?offset=0&limit=100`: `{assignments, total, revision}`, including orphaned saved mappings. Limit 1–200, offset 0–1,000,000. Removed drafts are excluded.
- `GET /api/v1/tags/{tag_key}/assignment`: `{version, assignment}`; `assignment` is null for absent/deleted mappings. Version is 0 only for a never-written ID.
- `PUT /api/v1/tags/{tag_key}/assignment`: strict JSON with `ha_tag_id`, `input`, `media_type`, `enabled`, `shuffle`, `playback_profile_id`, `expected_version`. Both booleans are explicit; profile must be `default`, an inert local reference. Input is an album/playlist URI or the supported Spotify web link (maximum 512 characters); parsing never follows URLs or requires metadata. Tag key must match the exact ID. Returns the current state after committing.
- `DELETE /api/v1/tags/{tag_key}/assignment`: strict JSON `{expected_version}`. Removes only the local draft; the HA tag and legacy mapping remain unchanged. Returns the incremented tombstone version.

Writes require an authenticated session, matching Origin, CSRF header and manage mode. JSON bodies are bounded to 8 KiB. Validation errors are 422; mode/CSRF failures 403. Concurrent creates/edits, stale deletes and delete/recreate races return 409 with `detail: {code: "assignment_conflict", current_version}`. Reload and review before retrying. A network failure leaves an uncertain outcome: reload current state rather than assuming failure. SQLite `BEGIN IMMEDIATE` serializes the precondition and write atomically; each tag version increases through deletion/recreation. Audit retains the newest 1000 successful operations, containing action, hashed tag key (or null for import), count and UTC timestamp, never URIs, raw IDs, names, credentials or source configuration.

### Reviewed import

Preview additionally returns `preview_token` and `local_revision`. Tokens are random, session-bound, expire after 15 minutes and are held in a 32-entry in-memory cache; app restart requires a new preview. Preview itself never writes the database. The normalized downloadable report continues to retain rejected/unsupported rows.

`POST /api/v1/imports/confirm` requires `source`, `fingerprint`, `preview_token`, explicit `conflict_policy` (`reject`, `skip`, `replace`), and explicit `enabled`, `shuffle`, `playback_profile_id: "default"`. Uploaded sources also resend the exact reviewed `content` and `format`; the UI retains these reviewed bytes even if another file is selected. Configured sources are read again through the existing read-only adapter. The source is parsed again and exact-byte SHA-256 checked against the session's server-generated preview. A supplied hash alone cannot confirm arbitrary content. The JSON envelope uses the same bounded 1 MiB source / sixfold escaped-body allowance as preview.

Any local draft change since preview conflicts (including unrelated rows), requiring new preview and review. `reject` rolls back the entire import if any accepted ID already has a draft. `skip` keeps existing drafts; `replace` replaces only reviewed accepted IDs. Absent/tombstoned IDs can be imported. One transaction commits all accepted rows and one audit event; failures leave no partial writes. Unsupported rows are never guessed or converted. Successful response is `{imported, skipped, report}` with the original normalized report. Replayed/expired tokens and changed sources return 409; configured-source failure returns 503. A new preview is required after successful confirmation.

The UI permits creation from tag detail, editing/disabling/removal from tag detail or the saved-drafts list, and confirmation under a reviewed source report. The independent list keeps orphaned drafts accessible. A stale edit retains the form and requires explicit reload. Loading, failure and retained stale data remain separate. Disable/remove require the same concurrency protection as save; removal has an inline keyboard-accessible confirmation.

Fixture verification: `npm --prefix frontend run test:fixture` runs Chromium against the isolated Vite fixture server, including mobile keyboard save/conflict/reload/disable/remove/import and metadata-preview retention. Synthetic manage mode is selected by the test fixture state; its in-memory writes are demonstrations, while backend tests establish real SQLite persistence, migration, transactions and server security. No live HA or Spotify access is required.
