# HA companion feasibility and v1 contract (#19)

> Historical #19 evidence and exact v1 wire contract. The supported #25 implementation, additive lifecycle/recovery policy and tighter persistence-failure fencing are documented in [the companion bridge report](16-companion-bridge.md) and [operator guide](../companion/README.md). Production uses config-entry pairing; the YAML setup and missing production features below describe the retained spike.

## Decision and boundary

**Proceed with a dedicated HA integration**, using supported companion-owned HA `Store` persistence and authenticated custom WebSocket commands. This resolves the M3 spike gate for the tested HA Core **2026.10.2**, Python **3.14.8**, Linux environment. The prototype and reproducible probe live in [`spikes/ha_companion`](../spikes/ha_companion/README.md). This is a bounded feasibility decision, not completion of JBM-012 or M3.

Pyscript remains a deliberate local-only alternative, rejected as the reusable default because it adds a separate runtime/lifecycle dependency. An app-hosted dispatcher fails the app-stopped requirement. Rewriting automation mappings on every save retains unwanted coupling to household configuration. A dedicated integration keeps validation, persistence and future dispatch in one HA lifecycle and permits explicit version compatibility tests.

Maintenance scope: one small integration, one v1 snapshot schema, validation/storage/status/readback, and later a separately scoped dispatcher/script boundary. No metadata, Spotify authentication, receiver logic or alternate editable assignment master. HA updates must rerun the probe and protocol vectors; only 2026.10.2 is tested here. Config-entry installation, upgrades, recovery tooling, packaging and supported-version policy belong to JBM-012/release work. The app publisher and dispatcher are still unimplemented. No household installation or migration was performed or authorized.

## Exact transport

Use HA's authenticated WebSocket at `/api/websocket`. The client must complete HA authentication, correlate monotonically increasing connection-local positive `id` values, and possess HA admin permission. This is not a narrowly scoped bridge-only credential. Both commands reject authenticated non-admin users.

```json
{"id":1,"type":"jukelet_bridge/status"}
```

```text
{"id":2,"type":"jukelet_bridge/publish","snapshot":<envelope below>}
```

Only these two commands exist. There is no REST service, enable-dispatch operation, script call, tag event listener or test-fault command. `status` rejects extra command fields; `publish` requires the snapshot and rejects extra command fields. HA's normal `result` envelope contains `success: true` and the status object, or `success: false` and an error. Never interpret successful socket authentication or command delivery as publication success.

The publisher is explicitly configured at integration startup (`jukelet_bridge.publisher_id`), not implicitly paired to the first caller. The synthetic harness uses `00000000-0000-4000-8000-000000000019`. Production pairing/replacement UI is not part of this spike.

### Snapshot schema and limits

All fields are required; unknown envelope/payload/mapping fields are rejected. JSON values are strictly typed, without coercion. Object key order and mapping-array input order are irrelevant after validation. Duplicate **tag IDs** are rejected. JSON parsing is HA-owned; this is validation of the decoded object, not a replacement raw-JSON parser.

| Field | v1 rule |
|---|---|
| `schema_version` | Integer exactly `1`; booleans/floats rejected |
| `publisher_id` | Canonical lowercase hyphenated UUID, exactly the configured publisher |
| `revision` | Integer 1 through 9,007,199,254,740,991; monotonic per publisher |
| `expected_active_revision` | Same positive integer range, or `null` only for initial empty state |
| `payload_checksum` | Exactly the lowercase 64-character SHA-256 digest described below |
| `payload` | Object containing only `mappings` |
| `mappings` | Array of 0–1,000 complete mapping objects |
| Complete envelope | At most 262,144 bytes in its canonical UTF-8 encoding; independent of HA's transport limits |
| `tag_id` | Exact nonempty Unicode scalar string, 1–256 UTF-8 bytes; reject U+0000–001F, U+007F and lone surrogates; preserve whitespace/case/normalization |
| `media_type` | Exactly `album` or `playlist` |
| `spotify_uri` | `spotify:<matching media_type>:<22 ASCII alphanumeric characters>`; no URLs or implicit repair |
| `enabled`, `shuffle` | Explicit JSON booleans |
| `playback_profile_id` | Exactly `default` in v1 spike; inert, with no script resolution or playback implementation |

The future production bridge must resolve approved profiles only through its local allowlist; accepting arbitrary script/service names is prohibited. Empty payloads are valid protocol input but the application must obtain explicit destructive-change confirmation before publishing an empty snapshot. No assignment saving or publication flow is added to the application here.

### Canonical checksum and vectors

Hash **only** `{"schema_version":1,"payload":{"mappings":[...]}}`. Sort mappings by exact `tag_id` Unicode **scalar/code-point** order. Sort every object's keys the same way, use standard JSON escapes, UTF-8 without BOM, no whitespace outside strings, literal non-ASCII scalars (`ensure_ascii=False`), and ordinary integer decimal notation. No floats, Unicode normalization, timestamps, publisher IDs, revisions or expected-base values enter the hash. `/` remains unescaped. A JavaScript implementation must explicitly use scalar order rather than default UTF-16 code-unit sorting for non-BMP IDs.

[Committed golden vectors](../spikes/ha_companion/vectors/checksums.json) include the exact canonical string and independently calculated SHA-256 for empty and Unicode payloads, including leading/trailing spaces, composed/decomposed characters and BMP/non-BMP sorting. Tests check hashes and permutation invariance. A future app publisher must consume the same vectors before interoperability is claimed. The runtime's one-row synthetic payload checksum is:

```text
4ef32839a0205dc9b0092825697a32478d23c295ba67164f92353a3ab34856a2
```

### Status/readback

Both successful publication and status return the same object:

| Field | Meaning |
|---|---|
| `protocol_version`, `schema_version` | `1` |
| `publisher_id` | Configured paired publisher UUID |
| `active_revision`, `active_checksum` | Validated loaded/acknowledged snapshot identity, or `null` |
| `mapping_count` | Count of all rows, including disabled rows; zero if no validated snapshot |
| `persistence` | `empty`, `healthy`, or `degraded` |
| `last_error` | `null` or a bounded code, never raw snapshot/exception data |
| `dispatch_enabled` | Always `false` in this spike, including after install/publish/restart |
| `supported_media` | `["album","playlist"]` |
| `supported_preferences` | `["enabled","shuffle"]` |
| `playback_profiles` | `["default"]` |

`healthy` proves the snapshot lifecycle checks described here, not playback. `degraded` may retain a last-good in-memory identity for diagnosis; it does not certify that identity currently matches disk. A cold corrupt/foreign/invalid snapshot has no active identity and remains degraded. The client must require healthy persistence **and** exact publisher/revision/checksum equality. Status deliberately does not expose the mapping data as a second assignment editor.

## State transitions and acknowledgment timing

Publication and status serialize through one companion lock. Up to four publications (including the executing request) are admitted; excess calls return `busy`. Validation detaches input containers before asynchronous persistence. Same publisher/revision/checksum is an idempotent retry returning status without another write, even when its original expected base is now old. Same revision with changed checksum conflicts; older revisions, foreign publishers and unexpected bases are rejected. Skipped positive revision numbers are permitted. Input/checksum validation precedes retry recognition.

The integration stores the entire envelope at the supported `Store` key `jukelet_bridge.snapshot`, storage version 1, with `atomic_writes=True` and `private=True`. It does not directly write `.storage` or inspect other integrations' files.

The critical HA finding is that `await Store.async_save()` alone is **not** persistence proof. HA catches/logs `WriteError` and serialization errors and can defer writes while stopping. After save, the companion constructs a **fresh** Store and reloads the invalidated-cache disk record under the same lock. Only equality of the complete candidate with that readback, plus a non-stopping HA state, permits in-memory activation and a success result. The code rejects new publication during `stopping`, `final_write` or `not_running`, and rechecks after I/O.

If readback still equals the prior snapshot, the operation fails with `persistence_failed`, retaining that validated snapshot. A readback error, unexpected record, or shutdown race marks `persistence_uncertain`/degraded and blocks further writes. Do not blindly rewrite the old record over an uncertain newer write. On restart, validate whatever the supported store actually contains. Invalid schema/checksum/foreign publisher gives degraded status; it is never silently replaced with empty mappings.

Cancellation of the requesting handler does not cancel a pending persistence transaction. A shielded task keeps the lock through save/readback, and status waits for it. This is necessary because cancelling an async waiter cannot reliably stop an executor filesystem write. There is no success before readback, nor a server timeout that claims a failed disk operation cannot later complete. A hung filesystem can delay status; the client should use the existing 10-second request deadline, treat timeout/disconnect as **unknown**, reconnect/read status before retry, and require owner recovery if degraded. Loss of the response can mean the old or new revision survived. Retry only after reconciling actual status; do not create a competing publication while outcome is unresolved.

### Errors

| Code | Client response |
|---|---|
| HA `unauthorized`, `invalid_format` | Fix permissions or command shape; do not retry unchanged |
| `invalid_snapshot`, `unsupported_schema`, `snapshot_too_large`, `checksum_mismatch` | Fix validated local input; existing snapshot unchanged |
| `publisher_mismatch`, `revision_conflict`, `stale_revision`, `base_conflict` | Read status and reconcile identity/revision/content; no blind overwrite |
| `busy`, `shutting_down` | No publication admitted; reconnect/read status before retry |
| `persistence_failed` | Fresh readback still matches old record; inspect status/storage, then explicit retry |
| `persistence_uncertain`, `recovery_required` | Halt writes; degraded state requires investigation/recovery |
| status `storage_invalid` | Startup load/validation failed; no implicit empty replacement |

Error messages are fixed and contain no tag IDs, payloads, tokens or underlying exception text. Publication is separate from saved, dispatch-active and playback-verified states. The M2 restore guard and startup/reconnect reconciliation contract remain mandatory for the future publisher.

## Evidence recorded 2026-10-22

All records below use synthetic data. None is a household HA/Spotify integration result.

| Check | Actual result | What it establishes |
|---|---|---|
| `python3 -m unittest discover -s spikes/ha_companion/tests -v` | 13 passed | Strict validation/limits, golden vectors, detached input, idempotency/conflicts, one concurrent winner, cancellation/readback ordering, bounded admission, shutdown fencing, retained last-good/degraded failures |
| Initial missing-envelope test | Failed because no exception was raised, then passed after validation | Recorded behavioral red→green, not an import/setup failure |
| Initial publish/restart test | Failed with active revision `None`, then passed after persistence lifecycle implementation | Recorded behavioral red→green for publication |
| `/tmp/jukelet-issue19-ha-venv/bin/python -m spikes.ha_companion.runtime_probe` | Passed on actual HA 2026.10.2 / Python 3.14.8 | Real HA lifecycle, Store, authenticated loopback WebSocket, generated admin/read-only users; no management app |
| Graceful HA subprocess stop/start | Exact revision 1/checksum recovered | Actual process restart, not a mocked Store reload |
| SIGKILL after acknowledged revision 2 | Exact revision 2/checksum recovered | Abrupt process termination after success on tested filesystem |
| Injected HA atomic-writer `WriteError` | HA swallowed/logged error; bridge returned `persistence_failed`; revision 2 retained | Regression against false acknowledgment from `async_save()` |
| SIGKILL paused before real atomic writer | Revision 2 recovered | In-flight request without acknowledgment can leave old record |
| SIGKILL paused after real atomic writer, before readback/result | Revision 3 recovered; same request retried without conflict | Lost response/uncertain publication can leave new record; status reconciliation works |
| Invalid-schema record saved through supported companion Store, then restart | Degraded, no active revision, dispatch false, publication denied | Invalid stored content does not become an empty success |
| Non-admin WebSocket commands | Both denied on every process start | Actual admin authorization boundary |

Expected injected-write/unauthorized log entries are not unexpected test failures. The probe asserts that automation, script, tag, media-player, discovery and default-config integrations are absent. The test hooks pause before/after the atomic writer and do not simulate every instruction-level failure inside it. The successful path really uses HA's atomic writer, disk readback and new operating-system processes.

## Blockers retained for production

- Power loss, filesystem/controller write-cache behavior, disk exhaustion and atomic-replace failures **inside** the writer have not been demonstrated. HA's atomic writer uses fsync, but SIGKILL is not a power-loss proof. Production durability claims require deployment-specific evidence.
- HA's malformed-JSON loader quarantines the file and returns `None`. The adapter detects an existing companion file/quarantine marker and degrades instead of silently accepting empty. That branch is source-reviewed, not a malformed-file runtime experiment: this work does not directly edit HA `.storage` files. A production recovery/backup procedure and malformed/quarantine restart tests remain required.
- Deletion of **all** companion storage/quarantine evidence cannot be distinguished locally from first installation. The future app must reconcile its persisted publisher/revision and recovery guard against an empty bridge; never auto-republish as if it were a new installation.
- Config-entry setup, upgrade migrations, explicit recovery/re-pairing, a supported HA version matrix, deployment packaging and app-publisher interoperability remain JBM-012/release work. This spike has no recovery endpoint and intentionally refuses degraded writes.
- No scan dispatcher, physical scan, receiver/script, Spotify playback, household restart or controlled cutover was exercised. These remain separate authorization and M3 exit gates. Installation/publication here never enables dispatch.

These limits do not invalidate the bounded proceed decision. They block stronger production durability/compatibility/playback claims and M3 completion.

## Primary references

- [HA WebSocket API](https://developers.home-assistant.io/docs/api/websocket/), [custom WebSocket commands](https://developers.home-assistant.io/docs/frontend/extending/websocket-api/).
- [Pinned HA Store implementation](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/helpers/storage.py): save exception handling, shutdown deferral, cache invalidation, quarantine behavior.
- [Pinned atomic file writer](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/util/file.py): `write_utf8_file_atomic` and fsync behavior.
- [Pinned WebSocket decorators](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/websocket_api/decorators.py): schema and admin enforcement.
