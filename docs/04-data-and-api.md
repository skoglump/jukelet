# Data model and application API

**Status:** M0 health/session and M1 status, paged tag inventory, import-preview and [music preview routes](13-spotifyplus-preview.md) are implemented. The read-only UI composes tag detail and page-scoped filtering from these existing DTOs; local assignment records, their list/detail/write routes and confirmed import (#16) are implemented. Onboarding and explicit verified rename (#17) are implemented. Export/publication routes below remain draft contracts. See [the development guide](10-development.md) for exact implemented response/error shapes. Use `/api/v1` for versioned application routes. The default `read_only` mode permits reads and safe previews. `manage` additionally enables local draft writes and explicit HA tag rename.

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

All responses use normalized application DTOs; never return raw HA configuration or tokens.

| Route | Milestone | Behavior |
|---|---|---|
| `GET /health/live` | M0 | Minimal process health; no secrets/upstream payloads |
| `POST /api/v1/session`, `GET /api/v1/session`, `DELETE /api/v1/session` | M0 | Implemented owner login, protected session probe and CSRF-checked logout |
| `GET /api/v1/status` | M1 | Authorized HA/provider/capability status; later publication/bridge state |
| `GET /api/v1/tags` | M1 | Implemented paged HA inventory, exact total and freshness; preview report supplies mapping joins |
| `GET /api/v1/tags/{tag_key}` | M1 | Tag + mapping + metadata + independent statuses |
| `POST /api/v1/imports/preview` | M1 | Read configured legacy source or parse a supplied safe file; no HA writes |
| `GET /api/v1/music/search` | M1 | Bounded supported search with explicit unsupported/failed state |
| `GET /api/v1/music/library` | M1 | Paged albums/playlists; capabilities may differ |
| `POST /api/v1/music/resolve` | M1 | Parse supported URI/link and fetch/cache metadata; no playback |
| `GET /api/v1/assignments` | M2 | Implemented paged local drafts, independent of registry availability |
| `GET /api/v1/tags/{tag_key}/assignment` | M2 | Implemented current draft or tombstone version |
| `POST /api/v1/imports/confirm` | M2 | Implemented exact preview token + source fingerprint + explicit policy and preferences |
| `PUT /api/v1/tags/{tag_key}/assignment` | M2 | Implemented local desired mapping with `expected_version` precondition |
| `DELETE /api/v1/tags/{tag_key}/assignment` | M2 | Implemented removal with `expected_version`; durable tombstone prevents version reuse; never delete HA tag |
| `GET /api/v1/tags/inbox` | M2, implemented #17 | Local assignment membership joined across inventory before paging; observed scans have separate provenance |
| `GET /api/v1/tags/{tag_key}/name` | M2, implemented #17 | Fresh inventory readback; reconciles an uncertain rename without writing |
| `PATCH /api/v1/tags/{tag_key}/name` | M2, implemented #17 | Explicit HA rename with expected name, followed by verified readback |
| `GET /api/v1/export` | M2 | Versioned logical export excluding secrets/cache by default |
| `POST /api/v1/restores/preview`, `POST /api/v1/restores/confirm` | M2 | Dry-run first; confirmation changes local state only before M3 |
| `POST /api/v1/publications` | M3 | Publish immutable desired revision; never imply playback |
| `GET /api/v1/publications/{revision}` | M3 | Actual synchronization outcome |
| `POST /api/v1/tags/{tag_key}/test-playback` | M3 | Explicitly authorized disruptive test, separate from save |

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

During M2, display a persistent banner: local drafts are not driving the existing jukebox. During M3 after explicit cutover, saves can queue publication automatically with clear pending status; publish only immutable committed revisions. Coalesce superseded queued revisions without altering an in-flight payload.

## Error format

Illustrative application response, not a captured HA payload:

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
