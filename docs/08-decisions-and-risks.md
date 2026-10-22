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
| D06 | Selected by #19 bounded spike; production/dispatch pending | Dedicated HA integration and local immutable snapshot | Real isolated HA restart/readback verified; see remaining production blockers |
| D07 | Provisional | Import known mapping shape once; no permanent automation rewriting | Decouple product data from YAML structure |
| D08 | Provisional implementation; required data-preservation invariant | Metadata optional; explicit label fallback | Personalized mixes and outages must not erase assignments |
| D09 | Accepted; M0 mechanism implemented in JBM-002 | App-secret login, SQLite server sessions, HttpOnly/SameSite cookies, origin/CSRF checks; no arbitrary HA proxy | Credentials remain outside the image; default tests use synthetic secrets |
| D10 | Provisional | Album/playlist writes initially | Match the requested core workflow; report unsupported imported media |
| D11 | Accepted; HA settings implemented in #4 | Environment variables for secrets and simple settings, including `HA_URL` and `HA_TOKEN` | Simple Docker/Compose configuration; secret values stay outside Git, images, logs and diagnostics |

Provisional choices remain the suggested design within the existing scope and invariants. JBM-002 implements Node 24.22.0/npm 11.19.1, Python 3.14.8/uv 0.13.1, and the session mechanism documented in [development and Docker operation](10-development.md). TypeScript 6.0.3 is selected for compatibility with the pinned ESLint tooling. Package lockfiles, the Python build-backend version, container base-image digests and CI action revisions are pinned.

The owner selected a localhost Docker quick start: an explicit development override permits loopback HTTP; the base configuration requires an HTTPS origin and Secure cookies. Sessions last eight hours, survive replacement and are bound to the app secret. Ten login attempts per rolling minute are allowed globally for the single-owner instance. Issue #19 settles the companion, persistence and transport feasibility choice; production implementation and dispatch remain deferred.

## Decisions to settle at explicit gates

| Gate | Decision | Proposed default | Must not block |
|---|---|---|---|
| Before M2 live writes | Permissions and mutation authorization | Dedicated deployment credential; explicit manage mode | Read-only build |
| M3 spike — resolved #19 | Companion integration vs Pyscript | Dedicated HA integration, bounded by the feasibility report | M1/M2 application work |
| M3 spike — resolved within tested scope #19 | Storage and bridge transport | Atomic HA Store plus fresh readback; authenticated WebSocket; production durability limits retained | Read-only prototype |
| Busy-scan policy resolved in #26; debounce implementation later | Preserve legacy `single`/silent overflow | Owner approved ignoring a second scan during preparation; no latest-pending queue | Metadata UI |
| Before publication UI | Auto-publish versus explicit publish | Auto-queue after save only after owner-approved cutover, with pending status | Local draft editing |
| Before release | Cache retention/artwork/link policy | Conservative, bounded and reviewed against provider rules | Basic text labels |
| Later | Multi-room, multiple accounts, direct OAuth | Separate issues, not automatic scope expansion; individual-track support retired by #26 owner decision | Album/playlist release |

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

## JBM-006 interface decisions (issue #13)

- Reuse normalized inventory, import-preview and music routes for client-side tag detail. No additional detail/filter backend route is needed for this read-only slice. Search/filter scope is explicitly the current inventory page, with navigation preserved even when no rows match.
- Assignment wording is qualified by selected preview membership, including rejected rows to preserve the importer's count semantics. No preview means unknown; rejection remains visible and never implies a supported/playable assignment. HA names, legacy labels and music titles remain separate.
- Resolve mapping metadata only on explicit request. Share music rendering/resolution with the existing discovery UI; preserve last-good display and exact source URI through HTTP/provider/network failures. The bounded session-memory display cache is not an assignment store.
- Use a development-only Vite fixture server with proxies disabled and a persistent synthetic banner for browser demonstration. Production bundle and backend behavior remain separate. No live connection, assignment persistence, rename, publication, playback or migration is introduced.


## JBM-008 local assignment decisions (issue #16)

- `manage` enables local drafts only; the default remains `read_only`. The persistent UI explanation prevents saving from being presented as publication or playback verification.
- Use strict `expected_version` on every save/remove, retain tombstones and increment per-ID versions through recreation. A global local revision conservatively invalidates imports after any draft write. SQLite immediate transactions cover comparison, mutation and audit.
- Confirm a server-issued, session-bound 15-minute preview token plus exact source SHA-256; retain at most 32 previews. Re-read configured sources and reparse uploads at confirmation. The explicit `reject` / `skip` / `replace` policy and preferences apply atomically to accepted rows only. Unsupported rows stay in reports.
- Store explicit enabled/shuffle preferences and the sole inert `default` playback-profile reference; do not accept arbitrary script names. Metadata is not a prerequisite or part of the assignment transaction.
- Preserve orphaned mappings in an independent saved-draft list. Bound successful-operation audit to 1000 sanitized entries. Session and source caches remain separate from persisted assignments. Detailed wire formats and limits are in the development guide.

## JBM-009 onboarding and naming decisions (issue #17)

- Extend explicit `manage` mode to the narrow HA rename endpoint; retain the `read_only` default. Automatic HA discovery remains read-only. Manage-mode banners and status describe the enabled mutation accurately; no playback/publication permission is implied.
- Join local saved membership across the complete inventory before inbox pagination. Disabled mappings remain assigned; legacy preview membership and actual process-observed scans retain separate meanings. Unknown/stale membership cannot imply confirmed unassigned. Observation timestamps/readers remain distinct from registry scan history.
- Serialize this app's rename/check operations, require a fresh expected-name precondition and inventory readback, and block another write after uncertain outcomes until an explicit successful check. HA has no atomic expected-name field; concurrent external writes remain a documented limitation. Rename uncertainty is bounded by the tag inventory and retained in memory, not a new assignment store.
- Per the issue implementation scope, add no assignment-saving flow. Existing #16 editing remains independent. Name failure/retry/readback preserves unsaved drafts, source reports and last-good music metadata. No `tag/create`, synthetic HA scan, automation write, playback or publication is introduced.
- Fixture transport/API/component/Chromium evidence does not replace live deployment permission/reader/rename verification. Live household access was not authorized for this issue's implementation.

## M2 portable export and guarded recovery (#18)

- Logical schema v1 carries exact IDs, canonical album/playlist mappings, explicit preferences, profile references and informational cached names/provenance. It excludes installation identity and operational/session/cache data. Unsupported rows remain in reports; duplicate IDs reject every occurrence. Restore only applies reviewed supported rows, never deletes unlisted drafts or renames HA tags.
- Restore confirmation uses a server-held, session-bound, bounded 15-minute preview and explicit policy/review. The current global revision is an atomic precondition; current per-ID versions/tombstones and local revision increase instead of trusting exported counters.
- Migration `0003` creates a stable local publisher UUID and durable `reconciliation_required` guard. Logical restore preserves that identity and sets the guard in the write transaction. Full recovery preserves the protected backup identity/counters, clears sessions and sets the guard before restart. No current route clears it.
- SQLite's online backup API is the supported consistent full-backup mechanism. Recover into a new protected path while the application is stopped; never overwrite a running database. Full backups contain sensitive operational state and are distinct from portable exports.
- M3 must honor the guard and reconcile actual HA identity/revision/checksum on every startup/reconnect, including arbitrary out-of-band database restoration. A local flag alone cannot detect filesystem rollback. Restored content must become a newer reviewed publication, never a counter rewind. This is a required future publisher contract, not a claim that M3 publication is implemented.


## M3 companion feasibility decision (#19)

- Proceed with one dedicated HA integration, using supported `Store(..., atomic_writes=True, private=True)` at `jukelet_bridge.snapshot` and admin-authenticated `jukelet_bridge/status` / `jukelet_bridge/publish`. The [exact v1 contract, alternatives, maintenance scope and evidence](15-companion-feasibility.md) govern subsequent implementation.
- A successful HA `async_save` await alone is insufficient: errors may be swallowed and shutdown may defer writes. Serialize publication, fresh Store disk readback and activation; fence uncertain/degraded outcomes. An exact same-revision retry is idempotent. Installation/publication/restart leave dispatch disabled.
- Real synthetic HA 2026.10.2 processes demonstrate graceful restart, SIGKILL before/after atomic writes, lost-response reconciliation, rejected non-admin commands and invalid-schema degraded startup. These are isolated test-environment results, not household verification or power-loss guarantees.
- Power-loss/filesystem behavior, malformed-file/quarantine runtime testing, recovery/re-pairing, upgrades, packaging and app-publisher interoperability remain blockers for stronger production claims. No dispatcher, playback, live configuration change or assignment-saving flow is implemented by this spike.


## #25 companion lifecycle and recovery (2026-10-22)

Adopt the dedicated config-entry integration in `companion/`, supporting HA 2026.10.2 only. Keep the v1 WS contract/golden vectors. Pair explicitly; keep a separately readback-verified revision journal before snapshot writes. Any partial persistence fences writes, tightening the spike failure policy. Administrative recovery/replacement is a two-step HA options flow with an exact-state precondition, strictly higher revision and retained retired identities (maximum 32; no eviction). Missing/corrupt journal requires coherent HA backup restoration; it cannot be reconstructed safely from an old snapshot. Original config-entry identity anchors established installations even after replacement. All-store/config rollback remains an app reconciliation responsibility. Dispatch remains false and only inert `default` is allowed. [Procedures and limits](../companion/README.md); [synthetic evidence](16-companion-bridge.md). No owner choice is deferred for this bounded bridge; deployment durability, household installation and playback remain separately authorized work.

## #26 internal playback boundary (2026-10-22)

Keep the v1 snapshot contract/default-only profile unchanged. An internal reference adapter takes an explicit copied local `default` → script allowlist; production setup does not construct it or expose playback configuration. Require strict exact input and correlated bounded completion responses. HA service return alone can mean a silent `single` refusal or a stopped script, so absent telemetry remains unknown. Independent playback verification is unavailable; one invocation per call, no automatic retry or scheduler. The adapter does not implement the dispatcher policy approved below.

Owner review on October 22, 2026 approved the [household extraction plan](17-playback-script-contract.md#owner-reviewed-household-extraction-plan): keep existing preparation exactly as it is, including readiness/account/transfer order; preserve album unshuffled playback and its post-start safeguard, and playlist count/fallback, random offset, context start then shuffle; retain `single`/silent overflow so a second scan during preparation is ignored; remove individual-track support from the intended migrated flow, retaining albums/playlists only. No current live behavior or configuration changes with this approval.

The generic adapter continues forwarding explicit shuffle preferences unchanged. Before future household activation, conflicting saved preferences must be visible and reconciled with the approved legacy media rules; no silent saved-draft mutation is allowed. Owner review resolves #26's plan criterion within its no-live scope. Exact household details, protected backup, extraction and separately authorized regression/rollback remain future execution/evidence gates. Neither approval nor synthetic script success proves actual household preservation.


## #29 single HA-local dispatcher (2026-10-22)

Use the existing companion and #26 adapter; no backend execution path. Reserve one busy slot synchronously, capture one healthy detached snapshot, and ignore overflow without replay. Duplicate suppression uses exact tag/optional reader keys, a 2-second monotonic window and 256-key oldest-first limit. Only default resolves through a local config-entry allowlist; require an idle `mode: single` script. Visible enabled-row shuffle conflicts block activation under the owner-approved album/playlist rules. Receiver/account/provider behavior stays in reviewed HA scripts.

Activation is administrative and read back, never implicit after publication/recovery/restart. Persist/readback an execution uncertainty fence before invoking. Only correlated finished execution or proven pre-invocation rejection clears it automatically. Failure/timeout/cancel/absent telemetry needs administrative confirmation that all prior startup work stopped, followed by separate enable; HA entity off or process restart alone is insufficient. Missing/corrupt fence is uncertain, even at first install. Unload disables/drains without cancelling; restart recovers snapshot/config but remains disabled. Record local allowlists in config-entry data so snapshot recovery options cannot erase them.

[Controls, exact limits and real isolated process evidence](18-ha-local-dispatcher.md). These conservative choices do not change approved legacy preparation/media semantics, authorize household cutover, or supply independently verified playback.
