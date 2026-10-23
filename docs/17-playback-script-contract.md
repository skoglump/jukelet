# Internal playback script contract and extraction plan (#26)

The companion contains a reference boundary in [`playback.py`](../companion/custom_components/jukelet_bridge/playback.py) and [`ha_playback.py`](../companion/custom_components/jukelet_bridge/ha_playback.py), verified with synthetic requests and inert scripts in actual HA Core 2026.10.2. Issue #26 introduced it as an internal boundary. Issue #29 now constructs it only inside the explicitly activated [HA-local dispatcher](18-ha-local-dispatcher.md), adding local configuration and administrative controls. Installation, publication, recovery and restart never enable dispatch; no household script or assignment-saving change is added.

**Extraction plan status: owner-reviewed on October 22, 2026.** The owner approved preserving preparation and album/playlist rules, retaining `single` behavior that ignores a second scan during preparation, and removing individual-track support from the intended migrated flow. This resolves #26's owner-review criterion within its no-live scope. Existing observations and approval establish intended behavior; exact household details and actual preservation remain unverified. No household backup, live extraction, regression or cutover has been authorized or performed.

## Request and local configuration

`PlaybackAdapter(transport, profiles, timeout=30.0)` takes an explicit local map such as `{"default": "script.synthetic_finished"}`. This example is a fixture identifier, not household configuration. The adapter copies the map; later caller edits cannot redirect it. Only the v1 `default` profile is supported. An empty map safely rejects execution as `profile_unconfigured`; unknown profile keys, arbitrary domains, templates, invalid names, and generic `script.turn_on`, `turn_off`, `toggle`, and `reload` services are rejected. Script names must match `script.[a-z0-9_]+` and be at most 128 characters. A missing installed script returns `script_unavailable` without starting its body.

Snapshots retain their exact existing v1 schema and checksum vectors. They carry a profile reference, never a service/script name. The bridge can store `default` while no script is configured; a healthy stored snapshot does not establish playback readiness. The #29 dispatcher deliberately supplies this local map under its administrative activation controls. The reference adapter does not read configuration entries or snapshots itself.

`execute(value)` validates and detaches a strictly shaped request before any asynchronous call. All fields below except `reader_id` are required; unknown fields, coercion and implicit repair are rejected with bounded `ProtocolError` codes.

| Field | Rule |
|---|---|
| `tag_id` | Exact nonempty Unicode scalar string, 1–256 UTF-8 bytes; no U+0000–001F, U+007F or lone surrogates. Preserve spaces, case and normalization. |
| `media_type` | Exactly `album` or `playlist`. |
| `spotify_uri` | `spotify:<matching media_type>:<22 ASCII alphanumeric characters>`; no URLs, track URIs or templates. |
| `enabled`, `shuffle` | Explicit booleans. `enabled: false` rejects as `disabled` before invocation. No media-dependent shuffle default is invented. |
| `playback_profile_id` | Exactly `default`; other strings return `unsupported_profile`. |
| `snapshot_revision` | Integer 1–9,007,199,254,740,991; booleans/floats rejected. Future dispatcher supplies the one immutable active revision used for this request. |
| `correlation_id` | Caller-generated identifier using the same text limits as `tag_id`; preserve exactly. The future caller must use a unique ID per intentional attempt. This is correlation, not a deduplication key. |
| `reader_id` | Optional exact reader identifier with the same text limits; omit when unknown, rather than send null/empty text. It is context, not permission to route to an arbitrary target. |

All validated fields become direct HA script variables, unchanged. The transport uses `hass.services.async_call("script", <locally selected name>, variables, blocking=True, return_response=True)`. It does not call `script.turn_on` or accept target/entity/service overrides from the request. Receiver readiness, account selection/activation, transfer, provider calls, album/playlist sequencing and their verification belong in the locally reviewed script.

## Completion, uncertainty and retries

A cooperating script can return exactly this response through HA's `stop` / `response_variable` mechanism:

```json
{
  "contract_version": 1,
  "correlation_id": "synthetic-request-1",
  "snapshot_revision": 7,
  "execution": "finished",
  "error": null
}
```

`contract_version` must be integer 1, and correlation/revision must exactly match the request with strict types. `execution` is `finished` with null error, or `failed` with one of `readiness_failed`, `account_failed`, `transfer_failed`, `playback_failed`. Unknown fields/statuses/error text are invalid telemetry. A completed script reports that its sequence reached the response; it cannot certify receiver/provider state independently by setting a success flag.

The immutable adapter result retains correlation/revision and separate fields:

| Observation | `invocation` | `execution` | Bounded `error` |
|---|---|---|---|
| Disabled, unconfigured profile, absent selected script | `rejected` | `not_started` | `disabled`, `profile_unconfigured`, `script_unavailable` |
| Correlated explicit completion | `accepted` | `finished` | null |
| Correlated explicit failure | `accepted` | `failed` | Script code from the list above |
| HA service raises an error (possibly after effects) | `unknown` | `failed` | `script_failed` |
| Successful call with no completion data | `accepted` | `unknown` | `completion_unavailable` |
| Invalid, stale or mismatched completion data | `accepted` | `unknown` | `invalid_completion` |
| Deadline expires / other transport error | `unknown` | `unknown` | `timeout` / `transport_error` |

`accepted` means HA returned from the service call, **not proof that the script body started**. The actual HA probe demonstrates that `mode: single` refusal and `stop` with `error: true` both return empty data. Neither earns `finished`. A missing nested service may occur after preparation effects; it is a script failure, not a claim that nothing ran. HA-owned logs/traces may retain script variables; the adapter adds no raw payload/exception logging, and the household plan must address protected diagnostic retention.

`playback_verification` is always `unavailable` in this implementation. There is no independent receiver/provider observation, and script telemetry cannot promote it. Future verified-playback evidence must correlate the intended context and target to observed state; a provider acknowledgment, script completion or metadata result is insufficient. Saved drafts, published snapshots, active dispatch, accepted invocation, finished execution and verified playback remain distinct.

Each `execute` performs at most one transport call. Timeout defaults to 30 seconds and must be finite, positive and at most 300 seconds. It limits waiting, not receiver side effects: cancellation cannot undo previous actions or guarantee that nested/external work stopped. Caller cancellation propagates `CancelledError`; its result must be treated as unknown. There is no automatic retry, background replay, pending queue, deduplication, durable outcome ledger or scheduling policy. Concurrent callers keep their own correlations; the HA script's own mode controls execution. After an uncertain outcome, inspect actual script/receiver/provider state under separately authorized procedures before a new intentional attempt. Reusing correlation IDs does not make playback idempotent.

The #29 dispatcher now supplies the scheduling and durable uncertainty policy described in [its lifecycle contract](18-ha-local-dispatcher.md). Statements about “future dispatcher” below describe the original extraction plan; its household-detail and live-regression gates remain outstanding.

## Owner-reviewed household extraction plan

Source: [session findings, observed automation structure](07-session-findings.md#existing-automation-structure), from read-only investigation on October 15, 2026. These observations were not rerun for #26. On October 22, 2026, the owner reviewed the plan and decided:

- Keep the existing preparation exactly as it is, including its existing readiness, account and transfer sequence.
- Preserve existing album/playlist rules: album unshuffled with the post-start safeguard; playlist count/fallback, random starting offset, context start, then shuffle.
- Ignoring a second scan during preparation is acceptable: preserve legacy `single` with silent overflow, without a latest-pending queue.
- Remove individual-track support from the intended migrated flow; albums and playlists are sufficient.

These are approved intended behaviors, not evidence that a live extraction has preserved them. The table records the approved targets and remaining technical gaps; it is not deployable configuration.

| Existing evidence | Owner-approved extraction target | Gap / future verification |
|---|---|---|
| `tag_scanned` and exact membership in `variables.tags` gate execution | Future dispatcher uses exact IDs and active approved mappings; unknown/disabled mappings do not invoke the script. | Physical scan and final dispatcher behavior are future work. |
| Harmony Music / receiver readiness handling where needed | Keep the same conditional readiness sequence in HA before account/transfer/playback. | Exact conditions, delays, readiness signals, failure handling and receiver-off/cold-start behavior were not captured here. |
| Existing reusable Onkyo preparation script before transfer | Reuse the reviewed preparation script in the same order; do not recreate login/account behavior in Jukelet. | Account activation, cross-account takeover, credentials handling and idempotence are unverified. Do not extract credential stores. |
| Transfer to configured native Spotify Connect target | Retain target selection and transfer order in local HA script configuration. | Target discovery/readiness, transfer confirmation, retries and account-specific constraints require protected review. |
| Playlist reads track count with fallback, chooses random starting offset, starts context, then enables shuffle | Preserve this sequence and fallback unchanged. | Exact count fallback, zero/unavailable-count handling and offset bounds are unknown; preserve from protected source, do not guess from metadata errors. |
| Album is explicitly unshuffled, with post-start shuffle safeguard | Preserve initial unshuffled album start and the post-start safeguard. | Exact timing/condition of safeguard and stale shuffle state need verification. |
| Separate track branch exists | Owner-approved removal of individual-track support from the intended migrated flow; albums/playlists only. Retain the original automation in protected backup and unsupported rows in import reports. | Inventory any affected legacy mappings and report their exclusion before future activation. This decision makes no current live change. |
| `mode: single`, silent overflow | Preserve legacy scheduling; ignore a second scan during preparation, with no latest-pending queue. | The later dispatcher must implement and verify this approved policy. No scheduling is implemented here; duplicate-scan debounce details remain later implementation work. |

The v1 app already stores explicit shuffle preferences. The generic adapter continues forwarding them unchanged. The approved household plan preserves playlist shuffle-on and album shuffle-off/safeguard behavior. Stored preferences that conflict with those rules, such as album `shuffle: true` or playlist `shuffle: false`, must be visible and reconciled before future activation. Do not silently mutate saved drafts or present conflicting preferences as applied. This follow-up changes no adapter, saved mapping or live configuration; reconciliation implementation belongs to the future activation work.

Technical work remaining before a future authorized extraction:

- Compare protected current configuration with the approved targets and capture exact readiness/account/transfer order, playlist fallback and album safeguard details without changing them.
- Identify and visibly reconcile preference conflicts in the proposed activation set while preserving saved drafts until an explicit edit.
- Verify that rapid scans during preparation retain `single`/silent-overflow behavior and do not create a pending queue.
- Inventory and report any legacy track mappings excluded by the approved albums/playlists-only scope.

Owner approval is recorded above and in the [decision register](08-decisions-and-risks.md#26-internal-playback-boundary-2026-10-22). It approves the intended plan, including track retirement, without authorizing household access or mutations. Preserve exact household configuration and future regression evidence in protected records; publish only sanitized findings.

## Protected backup and separately authorized regression gate

Before any household configuration is touched:

1. Obtain explicit scope for the target installation, permitted configuration changes, playback tests, accounts/devices, volume limits, maintenance window and rollback triggers. Read access alone does not authorize extraction edits, receiver preparation, transfer or playback.
2. Create a protected full HA backup through supported HA facilities, including the legacy automation, reusable scripts, integration config and companion config entry/stores. Preserve the matching installed integration release and a separate consistent app operational SQLite backup if present. Keep secrets and household IDs outside Git, fixtures and PRs. Record backup identity/time and verify supported restore availability; a backup request acknowledgment alone is insufficient. Do not hand-edit `.storage` or inspect credential stores.
3. Review the actual automation and referenced preparation scripts within separately authorized read scope; compare against every approved target above and fill missing technical details privately. Any proposed deviation from the approved behavior requires owner approval; the plan review need not be repeated merely to carry it out. Keep original behavior available for rollback. Do not infer a runnable script from the sanitized examples.
4. Only under approved mutation scope, prepare the local script and allowlist while new dispatch remains disabled. Review exact script inputs/responses and provider capabilities against the installed versions. Stop if observed behavior differs from the approved plan.
5. Run the approved regression matrix below in a controlled window. Record expected versus observed receiver/account/target/context/shuffle state, timing and failures; distinguish service acceptance from independently observed playback. Do not repeat uncertain operations blindly.
6. Cutover belongs to later dispatcher/migration work and requires its own approval: disable the old dispatcher, read back that it is off, then explicitly enable and read back the new one. Never leave both enabled. A maintenance gap is acceptable. Verify ordinary physical scans, app-stopped execution and HA restart only within the approved scope.
7. On an approved rollback trigger, disable and verify the new dispatcher first, restore the reviewed prior scripts/configuration through supported HA backup/configuration facilities as needed, then enable and verify the legacy dispatcher. Reconcile app/bridge identity/revision/checksum before future publication; old content uses a new revision rather than a counter rewind. Confirm exactly one dispatcher is active and verify the approved legacy behavior. If state or backup coherence is uncertain, halt and keep dispatch disabled pending owner recovery.

| Future authorized scenario | Evidence required |
|---|---|
| Warm target / cold receiver / receiver off | Correct conditional readiness, preparation ordering and bounded failure behavior; observed receiver state. |
| Correct account / different active account / unavailable account | Approved account preparation and takeover behavior; account/transfer state without credential capture. |
| Native target ready / unavailable / transfer error | Correct target and transfer confirmation; failure must not start an unapproved replay loop. |
| Album from a previously shuffled session | Unshuffled start and post-start safeguard observed; conflicting stored shuffle preferences surfaced and reconciled before activation. |
| Playlist with normal count / count lookup unavailable / empty count | Approved fallback and valid random offset; context starts then approved shuffle behavior. Metadata failure alone is not an unplayable assignment verdict. |
| Script failure / deadline / lost result | Correlated failed or unknown outcome, independently checked state, no automatic repeated playback. |
| Rapid same/different scans during preparation | Legacy `single` with silent overflow: second scan ignored, no latest-pending queue. |
| Unsupported tracks / unknown or disabled tags | Tracks excluded from the migrated flow as approved, affected mappings reported, original backup preserved; no unintended new dispatch. |
| Rollback, app stopped, HA restart | Exactly one dispatcher, recovered approved mapping state and independently observed behavior. |

**Pending:** exact household-detail capture, visible preference reconciliation, protected household backup, live script extraction, physical scans, receiver/account regression, independent playback verification and rollback demonstration. Owner plan review is complete; these future execution/evidence gates do not reopen the approved behavior decisions. The existing #25 synthetic full backup/restore probe does not satisfy any household backup gate.

## Synthetic verification and limits

Default command: `make companion-check` (also included in `make check`). The new tests require no HA, Spotify, readers or credentials. They cover strict values/Unicode/limits, exact variable forwarding, immutable local configuration, missing/denied profiles, disabled requests, malformed/mismatched completion, bounded errors, cancellation/deadlines and concurrent correlation. Behavioral red→green was recorded for mismatched URI/media type and rejection of generic script control services.

The opt-in real HA probe reuses the existing pinned dependency lock:

```sh
uv venv --python 3.14.8 /tmp/jukelet-ha-playback-venv
uv pip sync --python /tmp/jukelet-ha-playback-venv/bin/python spikes/ha_companion/runtime-requirements.txt
/tmp/jukelet-ha-playback-venv/bin/python -m companion.playback_probe
```

It accepts no arguments, existing config directory, target or credential. It creates a temporary HA Core instance, disables dependency installation, loads the real script integration, and permits only inert fixtures (memory capture, variables, delay, stop and an intentionally missing synthetic service). No automation, tag, media-player, SpotifyPlus or discovery integration is loaded. It does not need a network listener or access the management app. Cleanup stops HA and removes the generated configuration.

Recorded on October 22, 2026: `/tmp/jukelet-issue25-ha-venv/bin/python -m companion.playback_probe` exited 0 on HA Core 2026.10.2/Python 3.14.8. It demonstrated exact album/playlist variables, local profile rejection, explicit completion/reported failure, absent telemetry, `stop` error telemetry limits, raised nested service failure, `single` refusal, timeout and cancellation with no replay. The initial probe expectation that HA's `stop` error raises to the caller failed; source inspection and the actual empty response established the conservative unknown result now asserted. This was a probe expectation correction, not a claim of a fixed HA behavior.

No compatibility beyond the pinned HA version, live script semantics, provider calls, receiver effects, household preservation, power-loss durability or verified playback is established by these fixtures. Full repository verification and independent review are recorded in the PR completion report.

Pinned implementation references: [HA script service handler](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/components/script/__init__.py), [script execution and stop handling](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/helpers/script.py), and [service registry call semantics](https://github.com/home-assistant/core/blob/2026.10.2/homeassistant/core.py). Implementation was inspected in the installed pinned environment and tested by the isolated probe.

## Offline sequence illustration

The [offline preparation worksheet](21-playback-preparation.md) now pairs a real isolated HA script fixture with the known sanitized sequence and exact-source gaps. It is not the household extraction. The existing helper remains unchanged in the intended migration; its synthetic stand-in proves no household account or receiver behavior. An explicit local adapter timeout can be reviewed through the existing admin dispatcher configuration, while the default remains 30 seconds and uncertainty/no-replay rules remain unchanged.
