# Integration contracts

**Status:** Issue #4 implements config/service reads, correlated tag-list/scan subscriptions, and internal allowlisted SpotifyPlus metadata transport. Issue #9 adds bounded configured automation reads, literal mapping previews and inventory discovery reconciliation. Issue #11 adds [bounded SpotifyPlus normalization and music previews](13-spotifyplus-preview.md). Issue #17 implements explicit, manage-only tag rename with inventory readback and onboarding. Issue #19 settles the [v1 companion contract and feasibility evidence](15-companion-feasibility.md). Issue #25 implements the separately installed [supported companion bridge](../companion/README.md) with snapshot publication, durable history and explicit pairing/recovery on HA Core 2026.10.2. The app publisher and scan/playback dispatch remain unimplemented. Live observations are recorded separately in [session findings](07-session-findings.md).

## 1. Home Assistant connection

Use the configured HA origin, authenticate server-side, correlate WebSocket command IDs, and maintain one connection owner. The WebSocket API supports event subscriptions and request/result exchanges.[1] REST service calls that support responses use `?return_response`; the response includes `service_response` separately from changed states.[2]

Required read-only operations:

| Operation | Interface | Purpose |
|---|---|---|
| Version/config | `GET /api/config` | Compatibility diagnostics; do not expose raw config |
| Services | `GET /api/services` | Discover available services, fields and response support |
| Automation state | `GET /api/states/<configured entity>` | Resolve its configuration ID |
| Legacy configuration | `GET /api/config/automation/config/<resolved id>` | Preview recognized existing mappings |
| Tag inventory | WebSocket `tag/list` | Read tag IDs/names/last scan |
| Scan notifications | WebSocket `subscribe_events`, `event_type: tag_scanned` | Management discovery UX |

The automation-config read was successful in this session, but treat it as a version-sensitive adapter rather than a universal documented API guarantee. Provide uploaded JSON/YAML preview as a fallback; never load unsafe YAML or evaluate templates.

Minimum reconnection behavior: bounded exponential backoff with jitter, reauthentication, subscription restoration, registry refresh, and explicit stale-data timestamps. Do not promise event replay. Never retry a non-idempotent action just because a request timed out.

## 2. Tag lifecycle and renaming

HA Core 2026.10.1's normal scan handler emits the event before updating/creating the stored tag. It automatically registers unknown tags. The event's name can initially be null. `tag/list` merges names from the entity registry.[3]

Implemented inventory behavior: expose a pending discovery immediately, then reconcile with the registry using bounded retries. Do not race automatic registration with `tag/create`. A manually fired bus event is not proof that the native registration path ran.

Use WebSocket `tag/update` with `tag_id` and `name` for a requested rename, then read the inventory back. The collection's create/update/delete operations require admin privileges.[3][4] Confirm permissions for the deployment; do not advertise the token as scoped only to tags.

Illustrative commands, with placeholder IDs (not captured live payloads):

```json
{"id": 10, "type": "tag/list"}
```

```json
{"id": 11, "type": "subscribe_events", "event_type": "tag_scanned"}
```

```json
{"id": 12, "type": "tag/update", "tag_id": "EXAMPLE_TAG_A", "name": "Dinner music"}
```

The implemented rename command is a mutation and is disabled in read-only mode. It has a fresh-name precondition and explicit uncertain-outcome reconciliation; see [the exact API contract](10-development.md#tag-onboarding-and-ha-rename-17). HA does not offer an atomic expected-name compare-and-set, so an external edit between pre-read and update remains possible. The registry's list key is `id`; scan/update payloads use `tag_id`. Normalize the application DTO without changing the underlying string.

## 3. SpotifyPlus provider

The inspected service definitions expose album/playlist metadata, saved/followed collections, and search.[5] At startup inspect the installed service schemas and report capabilities separately; do not assume the repository's current branch exactly matches the installed integration.

| Service | Main request fields |
|---|---|
| `spotifyplus.get_album` | configured `entity_id`, explicit `album_id` |
| `spotifyplus.get_playlist` | `entity_id`, explicit `playlist_id`, optionally `exclude_items` when supported |
| `spotifyplus.get_album_favorites` | `entity_id`, supported paging fields |
| `spotifyplus.get_playlist_favorites` | `entity_id`, supported paging fields |
| `spotifyplus.search_albums` | `entity_id`, `criteria`, supported bounded limit |
| `spotifyplus.search_playlists` | `entity_id`, `criteria`, supported bounded limit |

Call through HA, not direct Spotify authentication. Explicit IDs avoid accidental dependence on currently playing media. Normalize version-specific wrappers and paging into the app DTO. The session probes generally used `service_response.result`; do not assume every search returns a flat `items` list. Unexpected response shapes are adapter errors, not an empty successful result.

Classify errors as unauthorized, forbidden, not-found, rate-limited, timeout, unavailable or unsupported-response. Allow the UI to retain a valid URI with unavailable metadata. Do not infer playback success/failure from lookup availability.

## 4. Legacy importer

Supported first schema: an object at `variables.tags` keyed by literal tag ID; each entry supplies static `media_content_id` and `media_content_type` values. Recognize only supported album/playlist types initially. Report templates, duplicates, type/URI mismatches, missing registry tags and unsupported types as row-level diagnostics.

Preview must return source fingerprint, exact mapping counts, matched/unassigned/orphaned tags, accepted rows, warnings and rejected rows. Implemented confirmation (#16) commits only reviewed valid rows into the app database, with an explicit conflict policy and preferences. See [development](10-development.md#reviewed-import) for the session-bound preview token, source fingerprint and local revision preconditions. Keep the original read-only; no automatic changes to the legacy automation. Re-read/revalidate a changed source before confirmation.

## 5. Supported HA companion protocol (#25)

Issue #19 selects a dedicated HA integration and authenticated WebSocket commands `jukelet_bridge/status` and `jukelet_bridge/publish`. The [v1 contract](15-companion-feasibility.md) specifies exact schemas, limits, checksum vectors, error codes and readback timing. Issue #25 implements those admin-only commands in the [supported companion](../companion/README.md), preserving the wire schema and vectors. The application publisher, reconciliation UI and scan/playback dispatcher remain separate work. Compatibility is limited to HA Core 2026.10.2; [current evidence and durability limits](16-companion-bridge.md) distinguish the supported bridge from the historical isolated prototype. No live-system access is implied.

### `GetStatus`

Return protocol/schema versions, paired publisher ID, active revision/checksum, persistence health, dispatch-enabled status, supported media/preferences, and bounded last-error details. A healthy process is not necessarily a usable active snapshot.

### `PublishSnapshot`

Request envelope:

```text
schema_version: integer
publisher_id: stable installation identifier
revision: monotonically increasing integer for this publisher
expected_active_revision: integer or null for first publication
payload_checksum: SHA-256 of the specified canonical payload
payload:
  mappings: [tag_id, media_type, spotify_uri, enabled, shuffle, playback_profile_id]
```

For v1, compute the checksum over `schema_version` and `payload` only. Use the [specified deterministic UTF-8 serialization and committed golden vectors](15-companion-feasibility.md#canonical-checksum-and-vectors): sorted object keys, no insignificant whitespace, arrays sorted by exact Unicode scalar tag ID, no floats or Unicode normalization.

Rules:

1. Validate schema, configured publisher, URI/type, unique tag IDs, size/count bounds and locally configured playback-profile references. The supported bridge allowlists only the inert `default` profile. Future dispatch must resolve profiles only to allowlisted HA scripts; arbitrary service names are never accepted from snapshots.
2. Same publisher/revision/checksum is an idempotent retry and returns current status. Same revision with a different checksum is a conflict.
3. Reject stale revisions, unexpected active-base revisions and unpaired publishers. Empty snapshots require an explicit destructive-change confirmation on the application side.
4. Validate the full snapshot before activation. Persist it durably using the chosen companion's supported storage path, then activate consistently. Do not acknowledge success before durability and activation/readback conditions hold.
5. Preserve last-good in-memory content on failed publication. Any journal/snapshot persistence failure returns `persistence_uncertain` and fences writes until restart reconciliation. Publication is serialized; future dispatch must use one immutable snapshot revision for each accepted scan.
6. Return the actual active revision/checksum. The backend reads status to verify. If the acknowledgment is lost, query status before retrying.
7. Never enable dispatch as a side effect of publication. Installation and first publication are safe while the old dispatcher remains enabled.

The supported bridge uses explicit config-entry pairing and companion-owned HA Stores with atomic writes and fresh disk readback. A durable history journal reserves revisions before snapshot persistence and retains retired publishers. Restart validates history and snapshot together; a corrupt, missing or inconsistent snapshot is degraded and never silently replaced with an empty registry. The [production evidence report](16-companion-bridge.md) records actual isolated setup, restart, recovery and protected full Core backup/restore checks. Power-loss and deployment-specific durability remain unverified.

Confirmed HA options-flow recovery/replacement requires usable history, a revision above all retained history and any validated active snapshot, and the exact confirmation-state precondition. Missing/corrupt history or a snapshot publisher inconsistent with journal history requires coherent backup restoration; all normal and recovery writes remain fenced. Such a mismatch may conceal a lost publisher replacement, so a higher revision alone cannot repair it. See the [operator procedure](../companion/README.md#recovery-and-replacement).

### Dispatch enablement (future work)

The supported bridge always reports `dispatch_enabled: false`; it exposes no enable/disable command or scan dispatcher. Future work must expose an explicit administrative enable/disable operation with readback. During cutover, disable the old automation first, verify it is off, then enable and verify the new dispatcher. A brief maintenance gap is preferable to overlapping dispatchers. The app must not expose arbitrary automation toggling to ordinary users.

### Restore and rollback

M2 #18 persists a recovery guard and installation identity; see [the implemented recovery procedure](10-development.md#consistent-sqlite-backup-and-offline-recovery). The future publisher must honor this guard and reconcile HA identity/revision/checksum on every startup and reconnect before automatic or queued writes, because arbitrary filesystem restores cannot be detected by a local flag alone. Only an explicit reviewed recovery flow with verified active-state readback may clear the guard.

Restore old mapping content as a *new* revision. Do not rewind revision counters. If a restored app database trails the active bridge revision or has another publisher identity, stop automatic publication and require reconciliation. A missing/corrupt bridge snapshot may only be republished through an explicit recovery path after status inspection; do not infer permission from a timeout.

## 6. Playback script contract

Issue #26 implements an internal reference adapter with strict `tag_id`, optional `reader_id`, matching album/playlist `spotify_uri` and `media_type`, explicit `enabled`/`shuffle`, `playback_profile_id`, `snapshot_revision` and `correlation_id`. See the [exact request/result contract, synthetic evidence and owner-reviewed extraction plan](17-playback-script-contract.md). Only v1 `default` resolves through an explicitly supplied local script allowlist; snapshots cannot supply script/service names. Production setup does not construct this adapter or expose playback configuration. The script keeps receiver preparation/account activation/transfer behavior in HA.

Invocation accepted, execution finished/failed/unknown and independently verified playback are separate. Correlated explicit script responses can establish completion, while absent telemetry (including HA `single` refusal and `stop` error) stays unknown. Independent playback verification is unavailable. The adapter never retries automatically. No playback call is made during installation, publication, tag registration, rename, metadata refresh or ordinary save. On October 22, 2026 the owner approved preserving existing preparation and album/playlist rules, retaining `single`/silent overflow, and retiring individual-track support from the intended migrated flow. Exact household details and live preservation remain unverified. The adapter still forwards explicit shuffle preferences; conflicting saved preferences must be visible and reconciled before future activation without silent draft edits.

The approved busy-scan policy preserves legacy `single` behavior: ignore a second scan during preparation with silent overflow and no latest-pending queue. This supersedes the earlier latest-pending proposal. Dispatcher implementation and duplicate-scan debounce details remain later work; this reference adapter implements neither.

## Sources

[1] https://developers.home-assistant.io/docs/api/websocket
[2] https://developers.home-assistant.io/docs/api/rest
[3] https://raw.githubusercontent.com/home-assistant/core/2026.10.1/homeassistant/components/tag/__init__.py
[4] https://raw.githubusercontent.com/home-assistant/core/2026.10.1/homeassistant/helpers/collection.py
[5] https://raw.githubusercontent.com/thlucas1/homeassistantcomponent_spotifyplus/master/custom_components/spotifyplus/services.yaml
