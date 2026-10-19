# Decision register and risks

This register distinguishes owner-approved requirements from provisional recommendations and deferred implementation choices. Approval records intent; it is not evidence of an implemented or verified application.

## Accepted decisions

Owner-approved configuration preference (October 16, 2026):

- **Secrets and simple settings:** Prefer environment variables supplied to the Docker container, directly or through Docker Compose. For JBM-003, use `HA_URL` and `HA_TOKEN`. Committed Compose files should reference secret variables (for example, `HA_TOKEN: ${HA_TOKEN}`); actual values belong outside Git. Keep integration credentials server-side and redact secrets from logs and diagnostics. Users with Docker access can inspect container environment variables; this tradeoff is accepted. This is the direction for future configuration work; the implemented M0 app authentication still uses `APP_AUTH_TOKEN_FILE` until explicitly migrated and verified.

Owner-approved product identity (October 16, 2026):

- **Name:** Jukelet
- **Tagline:** Your music. A little more hands-on.
- **Description:** A personal jukebox powered by physical tags. Assign albums and playlists, then tap to play through Home Assistant.

Owner-approved baseline (October 16, 2026), completing JBM-001:

- **Stack and deployment:** React/TypeScript frontend, Python/FastAPI backend, and SQLite. A single Docker container serves the compiled frontend and backend API, with one backend worker/instance. SQLite persists in a mounted volume. Docker Compose is the documented deployment setup; secrets stay outside the image. A future companion is installed separately in Home Assistant.
- **Scope and safety:** M0 establishes the foundation, followed by the M1 read-only manager. Development and default tests use clearly labeled fixtures with no live household access. Live reads require separate authorization; HA mutations, playback and migration require their own explicit authorization. The boundaries in AGENTS.md apply throughout.
- **Ownership:** Home Assistant owns tag identity/name and playback; Jukelet owns assignments. Preserve existing household playback logic.
- **Publication and license:** The repository remains public at `skoglump/jukelet`. The owner selected the MIT license; see [LICENSE](../LICENSE).

## Baseline decision status

| ID | Status | Decision / recommendation | Rationale / consequence |
|---|---|---|---|
| D01 | Accepted | Standalone app; HA executes playback | Independent project without duplicating reliable household automation |
| D02 | Accepted | React/TypeScript + FastAPI + SQLite; one Docker container/worker, persistent volume and Compose | Small deployment and clear typed boundaries |
| D03 | Accepted | HA owns tag identity/name; app owns assignments | No competing editable masters |
| D04 | Provisional | SpotifyPlus first; provider adapter boundary | Reuse existing integration authentication/capabilities |
| D05 | Accepted | Read-only milestone before edits; fixture development and separately authorized live access | Useful first increment without risking playback |
| D06 | Provisional; M3 feasibility gate | Local immutable HA snapshot for runtime | App maintenance cannot disable scan dispatch |
| D07 | Provisional | Import known mapping shape once; no permanent automation rewriting | Decouple product data from YAML structure |
| D08 | Provisional implementation; required data-preservation invariant | Metadata optional; explicit label fallback | Personalized mixes and outages must not erase assignments |
| D09 | Accepted; M0 mechanism implemented in JBM-002 | App-secret login, SQLite server sessions, HttpOnly/SameSite cookies, origin/CSRF checks; no arbitrary HA proxy | Credentials remain outside the image; default tests use synthetic secrets |
| D10 | Provisional | Album/playlist writes initially | Match the requested core workflow; report unsupported imported media |
| D11 | Accepted; HA settings implemented in #4 | Environment variables for secrets and simple settings, including `HA_URL` and `HA_TOKEN` | Simple Docker/Compose configuration; secret values stay outside Git, images, logs and diagnostics |

Provisional choices remain the suggested design within the existing scope and invariants. JBM-002 implements Node 24.22.0/npm 11.19.1, Python 3.14.8/uv 0.13.1, and the session mechanism documented in [development and Docker operation](10-development.md). TypeScript 6.0.3 is selected for compatibility with the pinned ESLint tooling. Package lockfiles, the Python build-backend version, container base-image digests and CI action revisions are pinned.

The owner selected a localhost Docker quick start: an explicit development override permits loopback HTTP; the base configuration requires an HTTPS origin and Secure cookies. Sessions last eight hours, survive replacement and are bound to the app secret. Ten login attempts per rolling minute are allowed globally for the single-owner instance. M3 companion, persistence, transport and dispatch decisions remain deferred and do not block M0/M1.

## Decisions to settle at explicit gates

| Gate | Decision | Proposed default | Must not block |
|---|---|---|---|
| Before M2 live writes | Permissions and mutation authorization | Dedicated deployment credential; explicit manage mode | Read-only build |
| M3 spike | Companion integration vs Pyscript | Dedicated HA integration for reusable distribution; Pyscript if deliberately local-only | M1/M2 application work |
| M3 spike | Durable storage and bridge transport | Supported HA integration primitives; prove persistence/response behavior | Read-only prototype |
| Before dispatcher implementation | Busy-scan/debounce behavior | Per reader/tag short debounce; latest different pending request per target | Metadata UI |
| Before publication UI | Auto-publish versus explicit publish | Auto-queue after save only after owner-approved cutover, with pending status | Local draft editing |
| Before release | Cache retention/artwork/link policy | Conservative, bounded and reviewed against provider rules | Basic text labels |
| Later | Track support, multi-room, multiple accounts, direct OAuth | Separate issues, not automatic scope expansion | Album/playlist release |

## Risks and mitigations

- **Spotify/provider capabilities vary:** discover installed services and test actual response shapes; preserve manual URI entry.
- **Metadata failure is mistaken for bad assignment:** independent status fields and regression tests.
- **Version-sensitive HA configuration API:** isolate importer, provide safe upload fallback, avoid claiming universal support.
- **Two assignment stores drift:** one writer, immutable published snapshots, revision/checksum reconciliation.
- **Lost acknowledgment causes duplicate action:** idempotent publication, status readback, no automatic playback retry.
- **App database restored behind HA:** halt auto-publication and reconcile publisher/revision rather than overwriting blindly.
- **Bridge adds maintenance burden:** minimal interface, one implementation initially, compatibility tests and documented installation.
- **Refactor breaks receiver/account preparation:** retain it in existing HA scripts; explicit regression tests under real conditions.
- **Duplicate playback during migration:** verify old off before new on; installation/publication do not enable dispatch.
- **Sensitive home data enters GitHub:** synthetic fixture policy, local protected backups, pre-publication review.
- **A coding agent overbuilds:** one issue at a time, clear non-goals and verified milestone exit criteria.

## Rejected as defaults

Permanent per-save automation rewriting; one automation per tag; direct database editing inside HA; exposing HA tokens to the browser; introducing separate Spotify authentication in M1; Redis/microservices; silently using metadata lookup as a playability validator; application-triggered playback alongside the HA dispatcher.

## How to change a decision

Record context, alternatives, selected option, migration/security effects and tests. Update the affected docs and issue acceptance criteria together. A local shortcut must not silently become a general product guarantee.

## Issue #4 transport decisions

One FastAPI lifespan owns the HA connection in the supported single-worker deployment. HTTPX and websockets use the configured origin only, no redirects or environment proxies, and default TLS verification. The token remains server-side; WebSocket wire logging is disabled because debug frames contain credentials. Authentication rejection stops reconnecting until restart with corrected settings. Transient failures use exponential jittered backoff capped at 30 seconds.

Requests have a 10-second total deadline, at most 32 in-flight commands (and 32 REST requests), a 4 MiB response/message limit, and a 128-entry scan queue. Overflow drops the oldest notification, marks a discovery gap and refreshes the registry. Caches are in-memory and retain last-good inventory/timestamps on failure. The overall success timestamp requires all four discovery stages to succeed; partial capability results remain independent. Empty tag/scan IDs are rejected without trimming or normalizing nonempty opaque IDs. Reconnect restores the subscription and refreshes services and inventory; it cannot recover historical events. Ordinary scan reconciliation/onboarding remains a later issue.

Six documented SpotifyPlus services are allowlisted internally. Discovery requires known argument fields and response support; unknown required arguments disable the capability. Explicit album/playlist IDs prevent current-playback fallback. Metadata POSTs are never automatically retried and discovery is not proof of a successful lookup. No browser service proxy, importer endpoints, database schema changes or playback operations are added. App authentication continues using the existing secret file.


## JBM-004 implementation decisions (issue #9)

- Inventory remains a lifespan-owned in-memory HA cache. Stable browser keys are deterministic SHA-256 hashes of exact UTF-8 tag IDs; no assignment or tag-cache persistence schema is added in this read-only slice.
- The importer accepts only literal `variables.tags` album/playlist URI pairs. Safe YAML node parsing preserves duplicates and rejects ambiguous containers, aliases/custom tags and non-string IDs. Concrete limits and report/count semantics are specified in [development](10-development.md#inventory-and-legacy-preview-9).
- Source fingerprints cover exact UTF-8 bytes. Drift is a visible preview warning; confirm/save and conflict policy remain M2. Missing registry data means unknown join counts, while stale successful snapshots remain usable with explicit warnings.
- Minimal inventory/preview UI and normalized report download are included. This download preserves rejected rows and exact IDs but is not the proposed M2 logical assignment backup. Configured automation reads remain version-sensitive, with uploaded JSON/YAML as fallback.
- Validation is fixture-only. No live household access, playback change, migration or assignment write is authorized or performed.


## JBM-005 implementation decisions (issue #11)

- Keep one immutable configured SpotifyPlus account per app lifespan. A restart after configuration/account changes clears private in-memory data. No additional database tables or direct Spotify authentication are introduced.
- Use bounded metadata previews with six independent capabilities and explicit error states. Preserve last-good URI/title/artwork without treating lookup availability as a playability validator. Existing inventory/import reports remain independent; assignment saving stays M2.
- Require installed paging fields for libraries and a limit for search. Select one concurrent upstream request, eight admitted requests, 20-item pages, offset cap 1000, first-page-only search, 350 ms debounce, 128 cache entries, 5-minute freshness and 24-hour last-good retention. Failed lookups use a 30–300-second local backoff with no automatic retry.
- Allow only selected Spotify HTTPS image CDN hosts in normalized metadata and browser CSP; load images directly with no referrer and no persistent artwork cache. Wider artwork/provider policy still requires release review.
- Details, failure classification limitations, fixture provenance and exact API shapes are in [SpotifyPlus preview](13-spotifyplus-preview.md). Tests are synthetic; no live access, assignment import/save, playback or configuration mutation is part of this issue.
