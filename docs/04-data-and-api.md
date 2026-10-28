# Data model and application API

**Status:** Versioned `/api/v1` supports inventory with saved assignments, music metadata,
onboarding/HA rename, assignment editing, native export/restore, guarded publication
and read-only playback diagnostics. Automation imports are retired in app 0.1.0-rc.3.
`read_only` permits reads and native restore previews; `manage` permits explicit writes.

## Data model

| Record | Suggested fields and rules |
|---|---|
| `tag_cache` | app-generated stable `tag_key`, exact `ha_tag_id` unique, HA name, last scan/reader, fetched-at, pending-discovery/missing state |
| `assignment` | ID, `tag_key` unique, media type, canonical Spotify URI, enabled, explicit shuffle, profile ID, row version, timestamps |
| `metadata_cache` | provider/account-context key + URI unique, title, artist/owner display, artwork URLs, fetched/attempt timestamps, error state |
| `publication` | publisher ID, revision, immutable payload/checksum, desired/verified-active state, attempts, error, timestamps |
| `audit_entry` | bounded record of local edit/publication/rename outcomes; no credentials or complete raw payloads |
| `settings` | supported schema/config references and stable publisher ID; no browser-exposed secrets |

Use migrations and database constraints. Generate a browser-facing tag key rather than embedding raw potentially slash-containing tag IDs in routes. Exports retain the exact original HA tag ID. A changed/deleted HA name does not rename an assignment's Spotify metadata.

Single configured HA instance and SpotifyPlus account initially. Include provider/account context in cache keys so a later configuration change cannot leak stale private-library metadata between accounts. Do not implement multi-tenant infrastructure prematurely.

## Validation

- Treat HA tag IDs as opaque nonempty strings within explicit size limits. Reject malformed requests; never silently change case, separators or Unicode.
- Support canonical Spotify album/playlist URIs and the explicitly supported Spotify web-link forms. Strip recognized share-query parameters when converting a supported link to a URI; do not repair an invalid catalog ID.
- Keep URI kind and declared media type consistent. Unsupported links/types produce a clear validation error.
- Prefer parsing supported links locally. Do not follow arbitrary URLs, shorteners or redirects server-side. A short-link resolver, if later added, needs an independent SSRF review.
- Metadata success is not a prerequisite for saving a syntactically valid supported URI.
- Enforce bounded input lengths, upload size, result page size and snapshot size. Choose/document concrete limits during implementation and test their boundaries.

## API routes

This table lists implemented routes. Earlier proposed plural `/publications` routes, a consolidated `GET /tags/{tag_key}` route and app `test-playback` route were not implemented; do not call or advertise them. Tag detail is composed in the browser. Playback controls remain in HA, and the app has only read-only playback diagnostics.

All responses use normalized application DTOs; never return raw HA configuration or tokens.

| Route | Milestone | Behavior |
|---|---|---|
| `GET /health/live` | M0 | Minimal process health; no secrets/upstream payloads |
| `POST /api/v1/session`, `GET /api/v1/session`, `DELETE /api/v1/session` | M0 | Implemented owner login, protected session probe and CSRF-checked logout |
| `GET /api/v1/status` | M1 | Authorized cached HA/provider/capability status; publication/diagnostics have separate routes |
| `GET /api/v1/tags` | M1 | Implemented paged HA inventory, exact total and freshness; preview report supplies mapping joins |
| `POST /api/v1/imports/preview` | M1 | Retired: HTTP 410 `automation_import_retired`; no HA calls or writes |
| `GET /api/v1/music/capabilities` | M1 | Six independently discovered provider capabilities |
| `GET /api/v1/music/search` | M1 | Bounded supported search with explicit unsupported/failed state |
| `GET /api/v1/music/library` | M1 | Paged albums/playlists; capabilities may differ |
| `POST /api/v1/music/resolve` | M1 | Parse supported URI/link and fetch/cache metadata; no playback |
| `GET /api/v1/assignments` | M2 | Implemented paged local drafts, independent of registry availability |
| `GET /api/v1/tags/{tag_key}/assignment` | M2 | Implemented current draft or tombstone version |
| `POST /api/v1/imports/confirm` | M2 | Retired: HTTP 410 `automation_import_retired`; no HA calls or writes |
| `PUT /api/v1/tags/{tag_key}/assignment` | M2 | Implemented local desired mapping with `expected_version` precondition |
| `DELETE /api/v1/tags/{tag_key}/assignment` | M2 | Implemented removal with `expected_version`; durable tombstone prevents version reuse; never delete HA tag |
| `GET /api/v1/tags/inbox` | M2, implemented #17 | Local assignment membership joined across inventory before paging; observed scans have separate provenance |
| `GET /api/v1/tags/{tag_key}/name` | M2, implemented #17 | Fresh inventory readback; reconciles an uncertain rename without writing |
| `PATCH /api/v1/tags/{tag_key}/name` | M2, implemented #17 | Explicit HA rename with expected name, followed by verified readback |
| `GET /api/v1/export` | M2, implemented #18 | Versioned logical export excluding secrets/cache/runtime identity |
| `POST /api/v1/restores/preview`, `POST /api/v1/restores/confirm` | M2, implemented #18 | Bounded preview; explicit policy and session-bound confirmation; local writes and durable reconciliation guard |
| `GET /api/v1/recovery` | M2, implemented #18 | Durable recovery reconciliation status; no clear/publication route |
| `GET /api/v1/publication` | M3, implemented #30 | Reconcile desired/jobs/guard with actual companion state; never publish |
| `POST /api/v1/publication/review`, `POST /api/v1/publication/confirm` | M3, implemented #30 | Content-bound explicit review and durable publish/recover/opt-in intent; separate active-state readback |
| `POST /api/v1/publication/suspend` | M3, implemented #30 | Suspend future automatic queue creation; retain queued work |
| `GET /api/v1/playback-status` | M4, implemented #36 | Independent read-only readiness/diagnostics; no activation or playback |

Polling is sufficient for the first UI. SSE or a browser WebSocket may be added for live discovery only if worthwhile; do not add two client event transports by default.

## State distinctions

- **HA connection:** connected, reconnecting, unavailable, unauthorized.
- **Tag:** registered, pending discovery, missing from current registry.
- **Assignment:** unassigned, assigned/enabled, assigned/disabled.
- **Metadata:** not requested, fresh, stale with previous result, unavailable, lookup failed.
- **Publication:** not configured, local draft, queued, publishing, active verified, failed, reconciliation required.
- **Playback:** not tested, request accepted, execution failed, verified playing, unknown.

These are independent dimensions. HTTP 200 on a metadata request says nothing about playback. A delete/disable saved while HA is unreachable does not stop the old active assignment: explicitly show that it remains active until publication succeeds.

## Concurrency and partial failures

Require `If-Match`/ETag or a documented `expected_version` for local edits; choose one consistent wire format. Return a conflict with current version if another edit won. A rename and assignment are independent requests so the UI can report partial success honestly.

During M2, display a persistent banner: local drafts are not driving the existing jukebox. During M3 after explicit cutover, saves can queue publication automatically with clear pending status; publish only immutable committed revisions. The implemented publisher captures immutable jobs and fences unsafe dependent work; it does not rewrite or silently coalesce reviewed payloads.

## Error format

Historical illustrative error proposal, not the implemented wire envelope or a captured HA payload. Current routes use bounded `detail` responses (including structured conflict codes); see [the exact current development contract](10-development.md#configuration-and-session-contract) and feature-specific API sections:

```json
{
  "error": {
    "code": "metadata_unavailable",
    "message": "The assignment is saved, but music details could not be retrieved.",
    "retryable": true,
    "correlation_id": "example-correlation-id"
  }
}
```

Use HTTP semantics consistently: authentication/authorization failures, validation errors, conflicts and unavailable upstreams are not empty successful arrays. Include per-capability failures for combined views without destroying unrelated data. Bound diagnostic detail and redact upstream content.

## Export and recovery

Versioned JSON export includes exact tag IDs, assignment preferences, profile references and export provenance; name values are informative snapshots, not permission to overwrite HA on restore. Exclude HA/app secrets, raw traces, cached private library data and browser sessions. Export/import must preserve Unicode and unsupported rows in reports.

Application backup and logical export are different: document a consistent SQLite backup procedure during implementation, do not casually copy an actively written database file. Keep stable publisher identity in a protected backup; never use importing someone else's logical mapping export to silently adopt their publisher identity.

Implemented schema, bounds, error responses and recovery commands are documented in [export and recovery](10-development.md#export-reviewed-restore-and-protected-sqlite-recovery-18). Logical restore increments current local versions; full backup recovery preserves its protected runtime evidence and requires reconciliation before any future publication.


## Implemented publication API (#30)

The authenticated status/review/confirm/suspend endpoints and durable job/recovery
semantics are specified in [app publication](19-app-publication.md#app-api). This
implementation uses the companion v1 checksum/schema and local default profile.
Publication success requires separate exact healthy active-state readback; saved,
pending, dispatch-enabled and independently playback-verified states remain distinct.
