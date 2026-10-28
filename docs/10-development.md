# Development and Docker operation

JBM-002 implements the application foundation; issue #4 adds optional read-only Home Assistant transport and connection/capability status. Issue #9 added inventory; #51 retires its old automation preview/import. Issue #11 adds [SpotifyPlus music previews](13-spotifyplus-preview.md). The interface contains no sample assignments presented as live data.

For the current operator path, support matrix and release gates, start with [installation and operations](26-installation-and-operations.md) and [release evidence](27-release-readiness.md). Historical feature sections below retain their original verification scope.

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

## Release images and upgrades

The release workflow follows Arrtorrent's publishing pattern. Publishing a stable
or numbered RC GitHub release builds the complete frontend/backend image for `linux/amd64` and
pushes it to `ghcr.io/skoglump/jukelet`. It checks out the release commit, validates
versions, and reuses the full CI workflow before registry login or publication.
Drafts, ordinary commits and bare tag pushes do not publish images. Stable
releases require `X.Y.Z` or `vX.Y.Z` and GitHub's prerelease flag must be false.
RC releases require `X.Y.Z-rc.N` or `vX.Y.Z-rc.N` and that flag must be true.
Version numbers and `N` have no leading zeroes; other prerelease suffixes and
build metadata are unsupported. A mismatched flag/tag or package version fails
validation before the publishing job can run.

For a release such as `v0.2.0`, the image tags are `0.2.0`, `0.2`, and `latest`.
An RC such as `v0.1.0-rc.1` publishes **only `0.1.0-rc.1`**; it never updates
`latest` or a minor tag. This allows a preview before the eventual stable release.
Rolling tags follow successful stable-release publication, rather than numerical
version order: publishing an older version also moves `latest` and its minor tag.
Release runs queue serially (up to GitHub's 100 pending-run limit), without
cancelling the active run. A failed validation or CI gate prevents publication;
a failed registry push can leave partial tags and needs inspection before retry.
OCI labels record the repository, version and release commit. The workflow summary
records the pushed image digest for pinning.

### Prepare and publish a version

Keep the version in `backend/pyproject.toml`, the application entry in
`backend/uv.lock`, `frontend/package.json`, and both root version entries in
`frontend/package-lock.json` synchronized by meaning. Python uses canonical
PEP 440, so this candidate is `0.1.0rc1` in backend metadata/lock and
`0.1.0-rc.1` in frontend metadata/lock, GitHub and image tags. The companion has its own version (`0.1.3` currently); see [integration distribution](24-integration-distribution.md). The frozen first app RC remains unchanged. From the repository root, candidate
preparation is:

```sh
uv version --project backend --no-sync 0.1.0rc1
npm --prefix frontend version 0.1.0-rc.1 --no-git-tag-version
python3 scripts/check_release.py v0.1.0-rc.1 --prerelease true
make check build
make image smoke
```

For an example future stable release, both package ecosystems use `0.2.0`:

```sh
uv version --project backend --no-sync 0.2.0
npm --prefix frontend version 0.2.0 --no-git-tag-version
python3 scripts/check_release.py v0.2.0 --prerelease false
make check build
make image smoke
```

`uv version` updates the Python metadata and lock; `npm version` updates the
frontend metadata and lock. Review, commit and push those changes through the
normal review process, then publish a GitHub release for that exact commit using
the GitHub UI or authenticated `gh`. The workflow must be present in the released
commit; a branch does not need to be merged before an explicitly reviewed preview.
Mark an RC as a GitHub **prerelease**, not the latest stable release. Version
preparation does not itself create a tag, release or registry image. Never move
an existing release tag to different content; prepare another candidate instead.

Publishing uses the repository's `GITHUB_TOKEN`, with package-write permission
restricted to the publishing job; no stored registry PAT is required in Actions.
A release created by another workflow using its `GITHUB_TOKEN` does not trigger
the release workflow. See GitHub's [token-triggered event rules](https://docs.github.com/en/actions/concepts/security/github_token).

The owner approved keeping the current GHCR package **public** after the first
RC publication. Pulling this image requires no registry credentials; application
login, secrets and instance configuration remain separate. Registry publishing
still uses the job-scoped `GITHUB_TOKEN` permission described above.
For every release verify the actual workflow result, expected remote image tags,
matching digest/version/commit labels, package visibility and a successful pull. For an RC,
confirm that existing `latest`/minor tags were not moved or newly created. Local
checks alone establish only their exercised scripts, builds and isolated
containers; report registry publication only after remote readback. The build
context excludes `.secrets`, `.workflow`, environment files, databases and private
documentation/evidence; no such files should be added to the image or release.
Environment files and secret/workflow directories are excluded at every nesting
level, including frontend env files that Vite could otherwise compile into assets.
With Docker Buildx available, run `python3 scripts/probe_build_context.py` for an
opt-in real BuildKit regression. It copies only `.dockerignore` into a generated
temporary context, checks root/nested env/secret/workflow/database exclusions and
retained synthetic source files, and never copies repository secrets. Default
unit tests do not require Docker.
See [GitHub's Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
for visibility and authentication.

### Verified first RC

[Release v0.1.0-rc.1](https://github.com/skoglump/jukelet/releases/tag/v0.1.0-rc.1)
was published from [commit 77fcf95](https://github.com/skoglump/jukelet/commit/77fcf95)
by successful [release workflow 39940034730](https://github.com/skoglump/jukelet/actions/runs/39940034730).
The Linux AMD64 image has this verified digest:

```text
ghcr.io/skoglump/jukelet@sha256:cf34632641534b4e8e0062780211f835b885a0ccfac270837fad2a8ad2e0ce56
```

Remote readback confirmed only the exact RC tag and matching source/version/commit
labels. An authenticated pull, installed Python package version `0.1.0rc1`, and isolated
HTTP/Chromium smoke checks against the downloaded image passed. The package was
observed public; the owner explicitly chose to keep it public. These checks do
not establish household deployment, HA integration, migration or playback.

### Pull a preview without replacing the running app

Pull the exact public candidate anonymously:

```sh
docker pull ghcr.io/skoglump/jukelet:0.1.0-rc.1
docker image inspect ghcr.io/skoglump/jukelet:0.1.0-rc.1 --format '{{json .RepoDigests}}'
docker image inspect ghcr.io/skoglump/jukelet:0.1.0-rc.1 --format '{{json .Config.Labels}}'
```

Compare the registry digest and OCI version/revision labels with the successful
release workflow and exact reviewed commit. Retain the resulting
`ghcr.io/skoglump/jukelet@sha256:…` reference for digest-pinned use. Pulling does
not start or replace a container. Preview publication does not authorize a
household deployment or HA/dispatcher changes; isolated testing uses generated
credentials and its own project/volume with no household HA settings.

### Pull and upgrade an existing installation

For a separately planned upgrade, use the verified public image without registry
login. A private mirror would require an authorized `read:packages` credential
through Docker's password prompt and a credential helper; never put tokens in
commands or logs.

```sh
export JUKELET_IMAGE=ghcr.io/skoglump/jukelet@sha256:cf34632641534b4e8e0062780211f835b885a0ccfac270837fad2a8ad2e0ce56
docker compose -f compose.yaml pull app
docker compose -f compose.yaml up -d --no-build --wait app
```

These are the upgrade commands for an already configured HTTPS installation;
retain its environment, secret file, Compose project name and persistent volume.
Use a specific version or the recorded digest for predictable upgrades. The
`JUKELET_IMAGE` override works with the existing Compose file and `--no-build`
prevents a local source build. Confirm container health and the loaded login page
after replacement. Local source builds remain available through `make image`.

Take a protected database backup before upgrading: startup runs schema migrations.
An older application image may not support an upgraded database. Follow the
[guarded recovery procedure](#consistent-sqlite-backup-and-offline-recovery) when
database recovery is needed; retain the prior image digest and backup as rollback
inputs. Image publication does not install the HA companion, enable dispatch,
perform a household cutover, or update a running server automatically.

## Configuration and session contract

| Setting | Behavior |
|---|---|
| `APP_PUBLIC_ORIGIN` | Required exact HTTP(S) origin; no path, credentials, query, or fragment |
| `APP_AUTH_TOKEN_FILE` | Required server-side file containing a 32–128 byte ASCII app secret; helper generates 32 random bytes encoded as hex |
| `APP_ALLOW_INSECURE_HTTP` | Defaults to `false`; `true` permits HTTP only for a loopback origin |
| `DATABASE_PATH` | SQLite path; `/data/jukelet.db` in Docker |
| `APP_STATIC_DIR` | Compiled frontend directory; `/app/frontend` in Docker |
| `APP_MODE` | Defaults to `read_only`; `manage` enables local draft writes and explicit HA tag renames; other values fail startup |
| `HA_URL` | Optional exact HTTP(S) origin, including optional port; no trailing slash, path, user credentials, query or fragment |
| `HA_TOKEN` | Server-side HA access token; required with `HA_URL`, supplied through the environment |
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

Supported current baseline: Node 24.22.1 with npm 11.19.1, Python 3.14.9 and uv 0.13.5 (owner-approved security patch updates under #32; earlier evidence used Node 24.22.0/Python 3.14.8/uv 0.13.1). Runtime selection is recorded in `.nvmrc`, `.python-version`, the Dockerfile and CI. Install these tools before running host development commands; `uv` is not bundled in the application image.

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

`make bootstrap` uses `uv sync --locked` and `npm ci`. `make check` runs Ruff lint/format checks, strict mypy, pytest, ESLint, TypeScript and Vitest. `make build` builds the Python distribution and frontend. `make smoke` runs real HTTP checks and a Chromium browser against isolated Docker containers with generated synthetic credentials and a temporary volume. It verifies session persistence across replacement, non-root execution, invalid startup configuration, secret isolation, login/logout and obsolete API rejection and metadata fallback. Generated credentials live in an owned temporary directory outside the checkout; Compose uses `--env-file /dev/null` and enforced read-only mode. The harness explicitly clears inherited `HA_URL`, `HA_TOKEN` and `SPOTIFYPLUS_ENTITY_ID` (also overriding Compose environment files), so it cannot connect to a household deployment. Cleanup removes only its uniquely named Compose project and volume.

Use `python3 scripts/smoke.py` for the same container checks without Chromium. The full browser run saves only the empty mobile login screen to the ignored `frontend/test-results` directory; traces and video are disabled. CI installs Chromium system dependencies and runs all checks on Ubuntu 24.04. Push/PR CI builds and tests without publication. The stable-release workflow reuses CI before publishing an image to public GHCR; server deployment remains separate.

Frontend libraries are React 19.3.1 and Vite 8.3.4. TypeScript is pinned to 6.0.3 because typescript-eslint 8.71.2 does not support TypeScript 7. The backend uses FastAPI 0.143.2, SQLAlchemy 2.1.4 and Alembic 1.20.0. Complete dependency versions and hashes live in the lockfiles; the Python build backend and container base-image digests are also pinned.

Version and packaging references checked during implementation: [Node release schedule](https://github.com/nodejs/Release), [Python 3.14.9](https://www.python.org/downloads/release/python-3149/), [Vite requirements](https://vite.dev/guide/), [uv locked installs](https://docs.astral.sh/uv/concepts/projects/sync/), and [Docker Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

## Limits

This release supports one owner, one backend worker, one SQLite database and one container. Sessions, assignments, recovery identity/guards and immutable publication jobs use versioned SQLite migrations through `0004`. HA inventory and scan observations are cached in memory and displayed with freshness; they are refreshed after restart. Music metadata/search/library previews use a bounded private in-memory cache. Local assignments, reviewed native restores, app publication and a separately installed HA dispatcher are implemented. The app never performs playback. [Historical household migration evidence](20-controlled-migration.md#authorized-household-outcome-2026-10-24) is distinct from current-candidate checks and retains open #31 limitations. The local verification platform is Linux x86-64; other architectures are not yet verified.

## HA connection behavior

HA is optional and public health remains independent of HA availability. Connection states are `not_configured`, `connecting`, `connected`, `disconnected`, and `unauthorized`. Capability states are `unknown`, `supported`, and `unsupported`; installed service schemas must expose the required known fields and response support. Available services do not prove metadata lookup or playback success. The six read-intent metadata methods remain internal allowlisted transport APIs, consumed by the narrow music-preview routes; no generic service proxy is exposed.

One persistent WebSocket authenticates, subscribes to `tag_scanned` and reads `tag/list`; REST reads `/api/config` and `/api/services`. Automatic reconnect restores subscription and refreshes the registry/services. A failed refresh retains the last good inventory and its timestamp, marked stale. `last_success_at` advances only when config read, service discovery, scan subscription and inventory refresh all succeed in one discovery pass; partial or total failure preserves the previous value (initially null). Individual capability and cache timestamps still update independently. No historical scan replay is claimed. Authentication rejection requires a restart with corrected configuration. Other failures retry with jittered exponential delays capped at 30 seconds.

Transport limits: 10 seconds per request including slot wait, 32 simultaneous WebSocket commands, 32 REST requests, 4 MiB per response/frame and 128 queued scan notifications. Queue overflow drops the oldest notification, records a gap and schedules registry reconciliation. Connections never follow redirects or environment proxies and verify TLS normally. Do not enable transport wire logging. Supported normalized errors are `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `timeout`, `unavailable`, `unsupported_response`, and `unsupported_operation`.

Tests use synthetic HTTP fixtures and a local fake WebSocket server, including auth rejection, deadlines, malformed/oversized responses, concurrency/correlation, disconnect/reconnect, subscription restoration and last-good cache preservation. No live HA handshake, service lookup, scan or playback verification has been performed.

## Inventory and saved assignments (#51)

`GET /api/v1/tags` retains bounded pagination and HA freshness and adds
`saved_assignment` (the same assignment DTO as the editor, or null) to each tag.
Disabled saved mappings remain assigned. Search and filters apply to the current
page and saved data, not active HA state. Publication provides independent actual
HA readback. No preview report or automation configuration is needed.

Both obsolete import URLs return authenticated HTTP 410 `automation_import_retired`.
They never parse submitted source data, call HA or write assignments. Obsolete
`LEGACY_AUTOMATION_ENTITY_ID` values are inert, ignored without validation or logging;
remove them from deployment environments during normal configuration upkeep.

## Read-only manager and isolated browser fixtures (#13)

The manager combines paged inventory, saved assignments and music APIs. Tag detail
separates exact IDs, HA labels and saved URIs from music titles. Metadata lookup is
explicit; failure preserves saved content and last-good labels/artwork. Back restores
keyboard focus. Filters describe saved assignments, including disabled mappings.

Tag search and filters apply to the current page of at most 100 tags; paging stays
available when filters match nothing. Search includes HA labels, exact IDs, saved
URIs and explicitly loaded music titles. Failed page requests identify the retained
page. Saved membership is independent of registry freshness and active HA state.

Saved assignments, inventory and music have independent loading/failure/freshness states. HTTP 503 provider errors and network failures retain mapping URIs, last-good music titles/artwork and timestamps with stale/error labels. Per-mapping display state survives closing/reopening detail during the session. The browser keeps at most 128 explicitly requested mapping metadata results in memory, never persistent browser storage. App-session expiry returns to login; an upstream authentication rejection leaves the app session intact.

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

The suite exercises keyboard focus, exact IDs, saved/disabled/unassigned states, metadata success followed by failure with retained artwork, URI lookup, bounded search/library paging, independent capabilities, empty/stale/failed/upstream-auth/app-auth states and a 390px mobile workflow with no horizontal overflow. Synthetic desktop/mobile screenshots are written to ignored `frontend/test-results/`. `make smoke` remains the separate isolated Docker/session/retired-request/manual-fallback check; neither suite authorizes or proves live household access.


## Local draft assignments (#16)

Set `APP_MODE=manage` explicitly in the container environment (Compose forwards it with a `read_only` default) to enable local assignment editing and native restore. Since #17, manage mode also enables the separate explicit HA rename endpoint; publication uses the separate [reviewed workflow](19-app-publication.md), while playback stays in HA. Enabling manage mode is not permission for an agent to access a household deployment. The persistent banner distinguishes local desired mappings from the independently active HA snapshot. The read-only mode can inspect existing drafts but blocks writes on the server and hides mutation controls.

The SQLite `0002` migration adds assignments, durable deletion tombstones, a global local revision and a bounded audit. It preserves existing sessions. Exact nonempty UTF-8 tag IDs (up to 512 characters) are retained without normalization; browser keys remain SHA-256 of the exact UTF-8 bytes. Missing registry tags and unavailable metadata do not remove drafts. Metadata remains a separate bounded session cache; it is not stored in assignments.

Authenticated routes:

- `GET /api/v1/assignments?offset=0&limit=100`: `{assignments, total, revision}`, including orphaned saved mappings. Limit 1–200, offset 0–1,000,000. Removed drafts are excluded.
- `GET /api/v1/tags/{tag_key}/assignment`: `{version, assignment}`; `assignment` is null for absent/deleted mappings. Version is 0 only for a never-written ID.
- `PUT /api/v1/tags/{tag_key}/assignment`: strict JSON with `ha_tag_id`, `input`, `media_type`, `enabled`, `shuffle`, `playback_profile_id`, `expected_version`. Both booleans are explicit; profile must be `default`, an inert local reference. Input is an album/playlist URI or the supported Spotify web link (maximum 512 characters); parsing never follows URLs or requires metadata. Tag key must match the exact ID. Returns the current state after committing.
- `DELETE /api/v1/tags/{tag_key}/assignment`: strict JSON `{expected_version}`. Removes only the local draft; the HA tag remains unchanged; active HA content changes only through publication. Returns the incremented tombstone version.

Writes require an authenticated session, matching Origin, CSRF header and manage mode. JSON bodies are bounded to 8 KiB. Validation errors are 422; mode/CSRF failures 403. Concurrent creates/edits, stale deletes and delete/recreate races return 409 with `detail: {code: "assignment_conflict", current_version}`. Reload and review before retrying. A network failure leaves an uncertain outcome: reload current state rather than assuming failure. SQLite `BEGIN IMMEDIATE` serializes the precondition and write atomically; each tag version increases through deletion/recreation. Audit retains the newest 1000 successful operations, containing action, hashed tag key (or null for import), count and UTC timestamp, never URIs, raw IDs, names, credentials or source configuration.

### Removed automation import

See [retirement and versioned compatibility](32-migration-retirement.md). Native
export/restore below is unchanged. Fixture Chromium coverage retains keyboard
save/conflict/reload/disable/remove, saved metadata, onboarding and native recovery.

## Tag onboarding and HA rename (#17)

**Add tag / unassigned inbox** opens a read-only discovery panel. The default inbox means no saved local assignment, across all inventory pages, independently of active HA membership. A disabled draft still counts as assigned. **Observed scans** shows only the latest event per tag actually seen by this app process, including reader/time when supplied. It is a bounded in-memory observation cache, not a durable scan history. A registry last-scan timestamp without an observed event never supplies an invented reader or claims a newly scanned tag. Disconnect gaps remain visible; reconnect recovers registered tags without replaying events. Pending observations reconcile through the existing bounded registry refresh (immediate, 250 ms, 1 s); the open panel polls every five seconds and offers manual refresh. Each connected inbox request reads the registry again, so registration delayed beyond the event retry window can still reconcile. Failed reads retain the stale registry snapshot. Jukelet never calls `tag/create` or fires synthetic HA scans.

`GET /api/v1/tags/inbox?view=unassigned&offset=0&limit=100` requires app authentication. `view` is `unassigned` or `observed`, limit 1–200, offset 0–20,000. It returns the inventory freshness envelope (`tags`, filtered `total`, `registry_available`, `stale`, `updated_at`, `discovery_gap`) plus `assignments_available`. Each row includes `local_assignment` (`unassigned`, `enabled`, `disabled`, `unknown`), `observed_at` and `observed_reader`. Local membership is read in one SQLite query and joined **before** filtering/paging, so a second inventory or assignment page is not mistaken for unassigned. A database read failure returns unknown membership and an explicit warning, never confirmed unassigned. Browser request failure retains the prior snapshot with a stale-membership warning. The general `/tags` inventory also exposes observation fields; its existing `last_reader` belongs to the displayed last scan only when that scan was observed.

Manage mode exposes independent rename controls in tag detail and the discovery selection. Pending tags cannot be renamed until registered. Inputs and requests remain separate from the existing #16 draft editor: rename/retry/check never save an assignment, clear an unsaved draft, refresh music automatically, publish, change other dispatchers, or start playback. Metadata errors retain the saved URI, last-good music title/artwork and requested HA label. Keyboard opening/back/close restores focus; operation feedback receives focus. Read-only mode retains discovery and hides rename controls.

Authenticated name routes use the existing SHA-256 key of the exact UTF-8 HA tag ID:

- `PATCH /api/v1/tags/{tag_key}/name` requires matching Origin, session CSRF and `APP_MODE=manage`. Strict JSON: `{ha_tag_id, expected_name, name}`; no extra fields. IDs are exact, nonempty, at most 512 characters and must hash to the route key. `expected_name` is required, null or a string of at most 512 characters. The requested `name` is a nonblank UTF-8 string of 1–512 characters, preserved without trimming. The body is capped at 8 KiB. Invalid inputs return 422; wrong media type 415; oversize 413; app authentication 401; Origin/CSRF/mode failures 403.
- The server serializes its own name operations, reads fresh `tag/list`, checks `expected_name`, sends only `{type: "tag/update", tag_id, name}` if needed, then reads `tag/list` again. Success is `{tag_key, name, state: "verified"}` only when the requested label is present in inventory; this refreshes the shared cache. Even a lost update acknowledgment can be verified by successful readback. An unchanged requested label needs only the fresh pre-read and performs no write.
- A changed precondition returns 409 with `detail: {code: "name_conflict", state: "conflict", current_name}`. A missing registered tag returns 404 (`not_registered`). HA permission rejection returns 403 (`forbidden`, state `rejected`); unsupported/not-found mutation responses return 503 with state `rejected`. The UI retains the requested label and offers a targeted rename retry. The HA credential generally needs admin privileges for `tag/update`; it is not a tag-scoped token, and permission success is not established by service discovery.
- Timeout, disconnect, malformed readback or a label mismatch cannot report rename success. A 503 response carries bounded `detail: {code, state: "uncertain"}`; another PATCH is blocked with 409 `reconciliation_required`. Cancellation after sending also leaves the server operation uncertain. `GET /api/v1/tags/{tag_key}/name` performs a new inventory read, returns `{tag_key, name, state: "current"}`, and clears uncertainty only after successful readback. The UI uses **Check HA name** after conflict/uncertainty (including browser network errors), preserves the requested label and requires review before another rename. Failed checks leave retry disabled. GET is a read, available in either app mode, and never renames.

The current HA API provides no atomic compare-and-set for external writers: a rename elsewhere between this app's pre-read and write can still race. The app detects known stale names and post-write mismatches; it does not claim distributed transactions or global exclusion. Name intents/uncertainty live only in the process (at most 10,000 unresolved operations; further writes are refused until reconciliation frees space); fresh pre-read remains mandatory after restart. No database schema or assignment audit is added for naming.

Verification uses synthetic API/SQLite tests, actual local-loopback WebSocket fixtures and the real Chromium fixture UI. The transport tests cover exact IDs, permission denial, stale preconditions, lost acknowledgments, malformed/mismatched readback and blocked retries. `npm --prefix frontend run test:fixture` includes a 390px keyboard discovery→pending→registered→rename workflow plus metadata failure, retained source/unsaved draft, explicit uncertain-outcome readback and no assignment writes. Screenshots are generated under ignored `frontend/test-results/`. These tests do not establish a working deployment credential or real reader registration. Live HA/Spotify access, unknown-tag scans and rename verification remain pending and require separate owner authorization.

## Export, reviewed restore and protected SQLite recovery (#18)

**Export and recovery** downloads `jukelet-export-v1.json` and previews a selected UTF-8 JSON file. Export is available in either app mode. Restore requires `APP_MODE=manage`, an explicit conflict policy and a reviewed confirmation. It changes local drafts only. Source tag names are informational snapshots and never rename HA tags. Provider availability is irrelevant to export/restore; existing mapping previews and last-good music display survive metadata failures.

The implemented authenticated API is:

- `GET /api/v1/export`: attachment with `{schema_version: 1, provenance, assignments}`. Provenance contains `application: "jukelet"`, UTC `exported_at`, informational `local_revision`, `names_updated_at` and `names_stale`. Each row contains exact `ha_tag_id`, canonical `spotify_uri`, `media_type`, explicit `enabled`/`shuffle`, `playback_profile_id: "default"`, and nullable informational `name`. Assignments and revision come from one SQLite read transaction; names come from one cached HA inventory snapshot with independent freshness. No HA read is triggered. Export excludes publisher identity, row versions, tombstones, audit, sessions, credentials, raw traces and metadata/private library caches.
- `POST /api/v1/restores/preview`: `{document: <export object>}`. Session, Origin and CSRF are required even in read-only mode. The response contains `rows`, `accepted`, `rejected`, `conflicts`, `local_revision`, `preview_token`. Each row retains the supplied `source` object, row number, accepted/conflict flags and diagnostics. Unknown fields/preferences/profiles, unsupported media, mismatched URI kinds, malformed IDs and every occurrence of a duplicate tag ID are rejected as rows; they remain downloadable in the report. Malformed containers, unsupported schema, duplicate JSON fields and oversized documents reject the whole request. Preview performs no database or HA writes.
- `POST /api/v1/restores/confirm`: `{preview_token, conflict_policy: "reject" | "skip" | "replace", confirmed: true}`. Requires session, Origin, CSRF and manage mode. `reject` aborts the entire restore if any supported row already has a draft; `skip` keeps existing drafts; `replace` replaces only supported matching IDs. Absent/tombstoned IDs can be restored. Unlisted drafts remain unchanged. The stored server preview is the only source; neither uploaded runtime counters nor names become authoritative. Returns `{restored, skipped, report, reconciliation_required: true}` after commit.
- `GET /api/v1/recovery`: `{reconciliation_required: boolean}`. The durable flag survives restart. Only explicit reviewed publication recovery plus verified healthy HA readback can clear it; see [publication](19-app-publication.md).

Limits: 4 MiB UTF-8 export, 10,000 rows, 16 JSON nesting levels, exact IDs/names up to 512 characters and canonical URIs up to 64 characters. Export rejects collections exceeding its limits instead of truncating them or producing an unrestorable file; use protected SQLite backup in that case. The preview request envelope permits 4 MiB + 4 KiB; the browser sends the original JSON bytes inside the envelope so duplicate fields reach server validation. Confirm uses the existing 8 KiB request bound. The preview cache retains at most four documents, bound to the creating owner session for 15 minutes; restart, expiry, eviction and a successful confirmation require another preview. Reports in the browser remain available, marked stale, after a failed preview/confirmation or selecting another file. Downloaded reports omit the token. Tokens are not a substitute for CSRF or authentication.

Any local draft change after preview invalidates confirmation, including changes to unrelated IDs. One SQLite immediate transaction checks the global revision, applies the selected policy, increments current local row versions (including tombstones), increments the current local revision, records one bounded audit event, and sets the recovery guard. Stale/conflicting/replayed/expired confirmations return 409; validation errors 422; oversize 413; wrong content type 415; session expiry 401; mode/CSRF/Origin failures 403. Failed transactions leave no partial rows or guard changes. After a network failure, reload current drafts and obtain a new preview to reconcile an uncertain outcome; do not blindly retry.

### Consistent SQLite backup and offline recovery

A logical export is portable mapping data. A full database backup is **private operational state**, including publisher identity, versions/tombstones, bounded audit and sessions. It does not include separately configured app/HA secrets, so retain those separately using the owner's secret-management practice. Keep database backups outside Git and web-served directories, on protected storage. The utility creates a new destination exclusively with mode `0600` and never overwrites an existing path. A backup may run while the single application writer is running: SQLite's online backup API captures a consistent committed snapshot, including WAL contents, rather than copying the database file and guessing about sidecars.

From a checkout with locked backend dependencies installed, these are the actual utility commands (replace the paths with deliberately selected local files):

```sh
uv run --project backend --locked python -m jukelet.backup backup /private/jukelet.db /private/jukelet-backup.db
uv run --project backend --locked python -m jukelet.backup recover /private/jukelet-backup.db /private/jukelet-recovered.db
```

Both commands require schema `0004`, refuse missing/corrupt sources and existing destinations, use SQLite backup, and run `PRAGMA integrity_check`. Upgrade older backups in a disposable offline working copy using the matching application's documented migration path before using this utility; keep the original protected backup. The application runs migrations on startup. Do not point a migration experiment at a household deployment.

For recovery, stop the application before selecting its replacement database; keep its existing database and any WAL/SHM files together as the rollback copy. Choose a known backup from the same installation. Run **recover** into a new path, inspect its success exit status, and only then configure that new path/volume for the stopped app. The recovery operation preserves the backup's publisher identity and runtime counters but atomically marks reconciliation required and invalidates all restored sessions **before** the recovered file is usable. Do not resume an old browser session; sign in anew. Do not run two instances against the recovered data. If validation fails, retain the existing deployment; no new usable output is produced. Rollback likewise uses a guarded recovered copy of the saved original database, never a casual file copy over a running process.

The database can legitimately contain older counters than HA after recovery. They are recovery evidence, not permission to publish. The app publisher compares publisher identity, active revision and checksum with HA on **every startup/reconnect** and before queued/automatic publication, and honors the durable recovery flag. Arbitrary filesystem copies cannot be reliably detected by a database flag alone. Clearing the flag requires explicitly reviewed publication recovery, verified exact healthy HA readback, and restored content published at a new revision above retained app/observed HA history. No logical export can adopt a foreign publisher ID; the implemented M3 publisher honors that guard; see [publication recovery](19-app-publication.md#reviewed-recovery-and-empty-snapshots).

Synthetic verification: `backend/tests/test_recovery.py` covers exact IDs, Unicode, preferences, tombstones, conflict rollback, concurrent confirmations, malformed schemas/rows, authentication and restart durability. `backend/tests/test_backup.py` exercises a real WAL database with an uncommitted writer, committed snapshot contents, integrity, private file permissions, guarded recovery and session invalidation. `frontend/src/Recovery.test.tsx` covers review/policy gating, stale/loading/error states and read-only preview. `npm --prefix frontend run test:fixture` includes actual mobile Chromium export download, file upload, keyboard preview/confirmation, concurrent-edit rejection, and preservation of mapping previews/last-good artwork through metadata failure. These fixtures do not establish live HA/Spotify integration or perform playback.


## Isolated HA companion spike (#19)

`make check` and CI's `make backend-check` include `make companion-check`: HA-independent protocol/state-machine type checks and 13 synthetic regression tests. Spike Python lint/format checks run with backend checks. This adds no HA dependency to the application or default tests. The HA adapter also has an opt-in type check against the actual pinned HA environment; ordinary checks intentionally type-check the independent protocol/state machine/test files with imported adapter modules skipped.

The separate [runtime probe instructions](../spikes/ha_companion/README.md) create temporary synthetic HA Core 2026.10.2 processes, generated authentication and loopback WebSocket transport. They accept no household target or credentials, and demonstrate actual persistence/restart and bounded failure behavior. Installation of the dedicated pinned environment requires package-index access; running the probe does not install integrations. See the [contract/evidence report and unproven production guarantees](15-companion-feasibility.md). This prototype is not shipped in the application image.


## Supported isolated companion (#25)

`make companion-check` now also checks the supported `companion/` protocol/state/tests, and backend lint/format checks cover that package. The application dependency lock and image remain separate from HA. Use [the current compatibility runner](30-ha-compatibility.md#reproduce-with-one-archive) and [companion guide](../companion/README.md) for upstream-matched isolated HA setup and `python -m companion.runtime_probe`, explicit pairing/recovery, supported versions and upgrade limitations. The historical spike command remains reproducible but is not the supported integration. Publication and reconciliation are implemented in #30; the separate HA-local dispatcher is implemented in #29. Household activation remains separately authorized work.


## App publication and reviewed automatic-publication opt-in (#30)

See [app publication](19-app-publication.md) for durable jobs, strict snapshot limits,
readback/recovery semantics, API controls and the separate opt-in actual HA/app
process probe. `make check` runs synthetic app/bridge fixtures;
`npm --prefix frontend run test:fixture` covers mobile/keyboard publication review.
Automatic publication starts disabled and needs explicit reviewed automatic-publication
attestation after current content is verified active. No app control enables
HA dispatch or performs playback.

## Read-only playback diagnostics (#36)

See [playback diagnostics](22-playback-diagnostics.md) for the separate strict read
contract, freshness policy and practical restart/failure guidance. Both app and
companion need this implementation for diagnostics; an older companion can retain
publication support with diagnostics unavailable. No household script is changed.

`make check build` covers companion/backend/component regressions and
`npm --prefix frontend run test:fixture` includes read-only mobile/keyboard playback
diagnosis. After the companion's pinned isolated HA setup, run
`/tmp/jukelet-ha-minimum/venv/bin/python -m companion.diagnostics_probe` for actual
temporary HA processes and inert-script restart/failure checks. These commands
never target a household deployment; exact results are recorded with the issue.


### Guarded playback recovery controls (#37)

HA administrators use **Settings → Devices & services → Jukelet bridge → Configure
→ Inspect and control tag playback**. The app only explains status and navigation.
Read [the operator procedure](23-guarded-playback-controls.md) before enable or
uncertainty reconciliation. Snapshot recovery is the separate **Recover or replace
publisher snapshot** menu item. Neither recovery nor restart enables dispatch.
Using the existing pinned HA environment, the opt-in isolated command is:

```sh
/tmp/jukelet-ha-minimum/venv/bin/python -m companion.administration_probe
```

It uses generated synthetic users and inert scripts only.

## Separate HA integration distribution (#38)

`make integration-package` builds only the committed `custom_components/jukelet_bridge`
runtime into a deterministic archive with exact source identity, per-file hashes
and archive checksum. The integration version/release is separate from the app
container and wheel; app upgrades never replace HA files. Follow the
[distribution, matrix and operator procedures](24-integration-distribution.md)
for archive verification, the exact supported upgrade baseline, protected backups,
installed version/source inspection, disabled-after-upgrade readiness review and
explicit #37 enablement. New integration releases use `integration-vX.Y.Z`; existing
numbered app RC artifacts/tags remain immutable. Publication needs separate approval.
