# Architecture

**Status:** M0 Docker/application/authentication foundation is implemented in JBM-002. HA, provider, assignment and publication components below remain proposed. See the decision register and [development guide](10-development.md) for the implementation boundary.

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
      +--- read-only legacy automation importer
      +--- versioned snapshot publisher (M3)
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

- `domain`: typed tags, assignments, metadata, import reports, publication models.
- `ha`: authentication, request correlation, reconnect, event subscription, service invocation and capability discovery.
- `providers/spotifyplus`: metadata/search/library normalization and failure classification.
- `importers`: recognized `variables.tags` structure only; preview before import.
- `storage`: schema migrations, repositories and transaction boundaries.
- `publication`: immutable snapshot generation and reconciliation.
- `api`: authenticated narrow endpoints and error serialization.

Frontend code consumes application DTOs, never raw HA/provider payloads. Read models may combine HA cache + assignment + metadata while retaining separate freshness/status fields.

## Runtime independence

The backend observes scans for management UX; it does not also trigger playback after migration. The HA dispatcher resolves scans using the active local snapshot and invokes a configured script. The snapshot must survive HA restart as well as app downtime.

Independence means the *management app* may be stopped. HA, required integrations, Spotify connectivity and receiver preparation can still be necessary. Do not market offline Spotify playback.

A simpler backend-only dispatcher was considered but is not the target: it makes tag playback depend on app uptime. A permanent editor that rewrites the automation mapping on every save was also rejected as the long-term design; it couples product data to automation structure and repeated config writes.

## Companion choice

Recommended reusable-project target: a small dedicated HA integration. Pyscript is an optional local alternative because the investigated household already has it. Do not build both initially. Before M3, run a bounded feasibility spike and approve the implementation choice, durable storage mechanism, service-response behavior and restart handling.

The companion must have no Spotify login UI, metadata browser or receiver-specific authentication code. Its responsibilities are snapshot validation/persistence, status/readback, scan dispatch and bounded result diagnostics. Installation alone must not enable dispatch.

## Configuration and deployment

Current M0 settings and session behavior are documented in [development and Docker operation](10-development.md). The following broader integration settings remain proposed; M0 reads no HA or Spotify credentials:

| Setting | Meaning |
|---|---|
| `HA_URL` | Explicit configured HA origin; never user-supplied per request |
| `HA_TOKEN_FILE` | Server-mounted token secret; never returned to browser |
| `SPOTIFYPLUS_ENTITY_ID` | Configured metadata account entity |
| `LEGACY_AUTOMATION_ENTITY_ID` | Optional read-only import source |
| `DATABASE_PATH` | Persistent SQLite path |
| `APP_MODE` | `read_only` by default; later `manage` enables explicit writes |
| `APP_AUTH_TOKEN_FILE` | Separate app secret used by the chosen auth mechanism |
| `APP_PUBLIC_ORIGIN` | Origin/CSRF enforcement |

Prefer secret-file configuration; if env fallback is provided, document its risks and ensure redaction. Discover the actual secret delivery mechanism during implementation. Never commit `.env`, databases, raw traces, or live configuration exports.

Implemented M0 auth: owner supplies an app-specific secret through a login form; the backend creates an eight-hour SQLite session using an opaque HttpOnly/SameSite=Strict cookie, origin validation, CSRF protection and logout. HTTPS uses Secure cookies. The explicitly selected development override enables loopback HTTP; network access requires reverse-proxy TLS. App secret rotation invalidates existing sessions on restart. No HA token is read or sent to the browser.

Run one backend worker/replica initially so WebSocket ownership, SQLite writes and publication jobs are unambiguous. Add explicit leadership before supporting multiple replicas. Use locked dependencies, schema migrations and a non-root runtime where practical.

## Caching and failures

- Key metadata by provider/account context plus URI, not URI alone.
- Keep `last_success_at`, `last_attempt_at` and an error category.
- Bound concurrency, paginate libraries, debounce search, and back off on upstream limits.
- Keep last good display data on refresh failure; expire/refetch according to an explicit cache policy reviewed before release.
- Never delete assignments because a provider fails.
- On HA reconnect: reauthenticate, resubscribe, refresh tag inventory and reconcile publication before retrying ambiguous writes.
- Keep browser offline, backend disconnected, bridge unhealthy and provider error as separate states.
