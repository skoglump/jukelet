# Architecture

**Status:** Standalone inventory, saved assignment management, onboarding, HA rename,
native recovery and guarded publication are implemented. #51 retires the automation
importer. See [the current retirement contract](32-migration-retirement.md).

## Accepted HA OS transition (in progress)

[#53's transition contract](33-ha-addon-transition.md) selects an HA OS add-on
with Ingress for this same frontend/backend/SQLite application. The bridge stays
separately installed in HA; ownership and app-stopped playback stay unchanged.
Standalone Docker remains supported until verified, owner-approved cutover and
bounded retirement under #66. The diagram below describes the implemented
standalone runtime, not an existing Ingress deployment.

The temporary target is two explicit server-selected runtime modes sharing domain
and API semantics: existing standalone secret/session/direct-Core access, and
future Ingress user/session/Supervisor transport. Ingress access is restricted to
verified HA administrators at the backend boundary, independently of sidebar
visibility; backend service credentials never establish browser authority.
One writer/publisher uses a private database in either mode; never connect both
managers to the household or share a live SQLite file. See the contract for exact
baseline identities, trust boundaries, support facts still to confirm, verification
matrix and migration/rollback gates. No packaging/auth/transport changes are
implemented by this architecture decision.

Subsequent implementation #54 provides browser prefix routing, and #55 adds the
[explicit backend Ingress trust/session boundary](10-development.md#backend-ingress-boundary-55)
with source-supported verified administrator metadata and user/path-scoped sessions.
These are bounded implementation steps; Ingress UI lifecycle, Supervisor transport,
add-on packaging and actual isolated HA OS certification remain pending. The
separate bridge, domain permissions, publisher history and recovery guards are
unchanged.

## Components

```text
Browser (React / TypeScript)
          | same-origin authenticated application API
          v
Application container
  FastAPI backend ---- SQLite on a persistent volume
      |                assignments, metadata cache, audit, publication state
      |
      +--- HA adapter: REST requests + persistent WebSocket
      +--- SpotifyPlus provider through HA services
      +--- versioned snapshot publisher (#30)
          |
          v
Home Assistant
  Tag registry and scan events
  Companion: persisted last-good snapshot + local scan dispatcher (M3)
          |
          v
  Configured playback script
  Existing preparation / account readiness / transfer / playback behavior
          |
          v
  SpotifyPlus + receiver / Harmony / Spotify
```

The single Docker application container serves compiled frontend assets and the backend API from one origin, using one backend worker/instance. Docker Compose provides the documented deployment setup, and SQLite data persists in a mounted volume. Secrets remain outside the image. There is no separate database server, Redis, message broker or frontend hosting requirement. The HA companion is a separate component installed into HA, not a second app service hidden inside the diagram.

## Ownership

| Data / behavior | Owner | Other copies |
|---|---|---|
| Tag ID, name, last scan | HA | Backend cache, with freshness |
| Assignment and playback preferences | App database | HA execution snapshot |
| Metadata | External provider | Replaceable cache scoped to provider/account context |
| Receiver readiness and playback | HA scripts/integrations | Backend may show bounded diagnostic status |
| Publication status | App records desired state; bridge reports actual state | Reconciled by revision + checksum |

One writer owns assignments. The HA snapshot is not an alternate editable registry. Detect drift and report it; do not silently import changes from both sides.

A rename and an assignment save cross different systems. Return separate results and permit retry of the failed part. Do not claim a distributed transaction.

## Backend boundaries

Suggested modules:

- `domain`: typed tags, assignments, metadata, native restore reports, publication models.
- `ha`: authentication, request correlation, reconnect, event subscription, service invocation and capability discovery.
- `providers/spotifyplus`: metadata/search/library normalization and failure classification.
- `storage`: schema migrations, repositories and transaction boundaries.
- `publication`: immutable snapshot generation and reconciliation.
- `api`: authenticated narrow endpoints and error serialization.

Frontend code consumes application DTOs, never raw HA/provider payloads. Read models may combine HA cache + assignment + metadata while retaining separate freshness/status fields.

## Runtime independence

The backend observes scans for management UX; it does not also trigger playback . The HA dispatcher resolves scans using the active local snapshot and invokes a configured script. The snapshot must survive HA restart as well as app downtime.

Independence means the *management app* may be stopped. HA, required integrations, Spotify connectivity and receiver preparation can still be necessary. Do not market offline Spotify playback.

A simpler backend-only dispatcher was considered but is not the target: it makes tag playback depend on app uptime. A permanent editor that rewrites the automation mapping on every save was also rejected as the long-term design; it couples product data to automation structure and repeated config writes.

## Companion choice

Issue #19 selects a small dedicated HA integration after the [bounded HA 2026.10.2 feasibility spike](15-companion-feasibility.md). Use supported companion-owned atomic Store persistence with fresh readback and authenticated custom WebSocket commands. Pyscript remains an optional deliberately local alternative; do not build both. Actual process restart and bounded failure scenarios are demonstrated; production packaging, recovery, stronger durability guarantees and dispatch remain separate gates.

The companion must have no Spotify login UI, metadata browser or receiver-specific authentication code. Its responsibilities are snapshot validation/persistence, status/readback, scan dispatch and bounded result diagnostics. Installation alone must not enable dispatch.

## Configuration and deployment

Current settings and session behavior are documented in [development and Docker operation](10-development.md). `HA_URL` and `HA_TOKEN` are implemented as an optional pair; Obsolete automation settings are ignored without reads or logging. The optional SpotifyPlus account setting enables read-only music previews:

| Setting | Meaning |
|---|---|
| `HA_URL` | Explicit configured HA origin; never user-supplied per request |
| `HA_TOKEN` | Server-side token supplied through the container environment; never returned to browser |
| `SPOTIFYPLUS_ENTITY_ID` | Configured metadata account entity |
| `DATABASE_PATH` | Persistent SQLite path |
| `APP_MODE` | `read_only` by default; explicit `manage` enables local draft writes and requested HA tag renames |
| `APP_AUTH_TOKEN_FILE` | Current M0 file-based app secret; migration to the environment-variable preference is not yet implemented |
| `APP_PUBLIC_ORIGIN` | Origin/CSRF enforcement |

The owner prefers environment variables for secrets and simple settings, supplied directly to Docker or through Compose. Committed Compose files reference secret variables such as `HA_TOKEN: ${HA_TOKEN}` rather than containing their values. Users with Docker access can inspect container environment variables; keep secrets out of logs and diagnostics. Never commit `.env`, databases, raw traces, or live configuration exports. Issue #4 implements this preference for HA credentials. The existing app secret-file setup remains unchanged.

Implemented M0 auth: owner supplies an app-specific secret through a login form; the backend creates an eight-hour SQLite session using an opaque HttpOnly/SameSite=Strict cookie, origin validation, CSRF protection and logout. HTTPS uses Secure cookies. The explicitly selected development override enables loopback HTTP; network access requires reverse-proxy TLS. App secret rotation invalidates existing sessions on restart. The optional HA token is read only by the backend and never sent to the browser.

Run one backend worker/replica initially so WebSocket ownership, SQLite writes and publication jobs are unambiguous. Add explicit leadership before supporting multiple replicas. Use locked dependencies, schema migrations and a non-root runtime where practical.

## Caching and failures

- Key metadata by provider/account context plus URI, not URI alone.
- Keep `last_success_at`, `last_attempt_at` and an error category.
- Bound concurrency, paginate libraries, debounce search, and back off on upstream limits.
- Keep last good display data on refresh failure; expire/refetch according to an explicit cache policy reviewed before release.
- Never delete assignments because a provider fails.
- On HA reconnect: reauthenticate, resubscribe, refresh tag inventory and reconcile publication before retrying ambiguous writes.
- Keep browser offline, backend disconnected, bridge unhealthy and provider error as separate states.
