# Integration contracts

**Status:** Issue #4 implements config/service reads, correlated tag-list/scan subscriptions, and internal allowlisted SpotifyPlus metadata transport. Automation/importer reads, tag mutations, provider normalization and bridge interfaces remain proposals. Live observations are recorded separately in [session findings](07-session-findings.md).

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

Proposed application behavior: upsert a pending discovery immediately, then reconcile with the registry using bounded retries. Do not race automatic registration with `tag/create`. A manually fired bus event is not proof that the native registration path ran.

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

The rename command is a mutation and is disabled in read-only mode. The registry's list key is `id`; scan/update payloads use `tag_id`. Normalize the application DTO without changing the underlying string.

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

Preview must return source fingerprint, exact mapping counts, matched/unassigned/orphaned tags, accepted rows, warnings and rejected rows. Confirmation in M2 commits only reviewed valid rows into the app database, with an explicit conflict policy. Keep the original read-only; no automatic changes to the legacy automation. Re-read/revalidate a changed source before confirmation.

## 5. Proposed HA companion protocol (M3)

These are logical operations, not existing HA endpoints. The feasibility issue must select the transport and register exact service/WebSocket names. A proposed service name in a design is not permission to call it on a live system.

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

For v1, compute the checksum over `schema_version` and `payload` only. Specify a shared deterministic UTF-8 serialization and golden vectors before implementation: sorted object keys, no insignificant whitespace, arrays sorted by exact tag ID, no floats, no Unicode normalization. Do not invent checksum values in fixtures; calculate them.

Rules:

1. Validate schema, configured publisher, URI/type, unique tag IDs, size/count bounds and locally configured playback-profile references. Profiles resolve only to allowlisted HA scripts; do not accept arbitrary service names from the payload.
2. Same publisher/revision/checksum is an idempotent retry and returns current status. Same revision with a different checksum is a conflict.
3. Reject stale revisions, unexpected active-base revisions and unpaired publishers. Empty snapshots require an explicit destructive-change confirmation on the application side.
4. Validate the full snapshot before activation. Persist it durably using the chosen companion's supported storage path, then activate consistently. Do not acknowledge success before durability and activation/readback conditions hold.
5. Reject or roll back failed publication without replacing the last good snapshot. Serialize publication against dispatch; each accepted scan uses one immutable snapshot revision.
6. Return the actual active revision/checksum. The backend reads status to verify. If the acknowledgment is lost, query status before retrying.
7. Never enable dispatch as a side effect of publication. Installation and first publication are safe while the old dispatcher remains enabled.

Atomic persistence, activation ordering, crash recovery and startup validation must be proven by the M3 spike; they are requirements, not capabilities already demonstrated here. A corrupt snapshot produces an explicit degraded state and must not be silently replaced with an empty registry.

### Dispatch enablement

Expose an explicit administrative enable/disable operation with readback. During cutover, disable the old automation first, verify it is off, then enable and verify the new dispatcher. A brief maintenance gap is preferable to overlapping dispatchers. The app must not expose arbitrary automation toggling to ordinary users.

### Restore and rollback

Restore old mapping content as a *new* revision. Do not rewind revision counters. If a restored app database trails the active bridge revision or has another publisher identity, stop automatic publication and require reconciliation. A missing/corrupt bridge snapshot may only be republished through an explicit recovery path after status inspection; do not infer permission from a timeout.

## 6. Playback script contract

Proposed inputs: exact `tag_id`, optional reader ID, `spotify_uri`, `media_type`, explicit shuffle preference, locally configured playback profile, snapshot revision and correlation ID. The script keeps receiver preparation/account activation/transfer behavior in HA.

Define an explicit distinction between script invocation accepted, script execution finished and playback independently verified. Use failure codes when available; do not invent success telemetry when the script cannot provide it. No playback call is made during tag registration, rename, metadata refresh or ordinary save.

Default proposal for the dispatcher: per-reader/per-tag short duplicate suppression; while a target is starting, retain the newest different pending request rather than an unbounded queue. Confirm this interaction with the owner's preference before implementation. The existing legacy `single` behavior is documented, not automatically replaced.

## Sources

[1] https://developers.home-assistant.io/docs/api/websocket
[2] https://developers.home-assistant.io/docs/api/rest
[3] https://raw.githubusercontent.com/home-assistant/core/2026.10.1/homeassistant/components/tag/__init__.py
[4] https://raw.githubusercontent.com/home-assistant/core/2026.10.1/homeassistant/helpers/collection.py
[5] https://raw.githubusercontent.com/thlucas1/homeassistantcomponent_spotifyplus/master/custom_components/spotifyplus/services.yaml
