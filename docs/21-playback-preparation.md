# Offline playback preparation worksheet

This is a synthetic rehearsal and an extraction checklist for #31. **The household
wrapper is not install-ready.** A fresh, explicitly authorized read-only source
capture is now held privately outside Git; its contents are not published here.
A private candidate is prepared; its synthetic twin has passed scoped independent
isolated verification. Operational approval remains pending. Compare source freshness again at cutover under the existing
scoped authorization gates. No receiver, account, target, predicate or value in the
public fixture identifies the household.

[The executable YAML fixture](../companion/examples/synthetic_preservation.yaml)
loads only into [the preservation probe](../companion/preservation_probe.py). Its
`synthetic_probe` handlers append to memory and return invented metadata. The probe
loads the real HA script engine, but no remote, media-player, SpotifyPlus, discovery
or automation integrations. Do not install this fixture or replace its service names
and assume it implements the household. Its state predicates and `0.2` volume are
invented test inputs. The separate preparation helper is a **stand-in**, not an edited
copy of the existing household helper. It is illustrative, not source-equivalent:
provider delay fields in the source must remain service arguments, not additional
HA waits, and the four-second wait plus shuffle-off safeguard is album-only.

## Exact extraction review

Fill the protected columns privately with original source references, exact
expressions, service names/arguments, installed versions, before/after SHA-256 values
and reviewer result. Keep the original automation and reusable helper in protected
backup. Missing fields block installation; do not infer predicates from entity names.

| Known preservation requirement | Executable synthetic illustration | Protected extraction still required |
|---|---|---|
| Conditional Harmony Music readiness, wait up to 25 seconds; stop on readiness failure | Invented `sensor.synthetic_needs_music` / `music_ready`; actual HA wait and timeout stop | Exact condition, activity/action, ready expression and failure branch |
| Existing conditional start-volume action then 1 second | Independent invented volume predicate and inert volume record | Exact condition and nesting relative to Music readiness, existing target/value and approved ceiling; no new clamp or unconditional action |
| Original preparation actions/mode/limits preserved, `queued` / max 3; approved completion handshake added | Separate synthetic helper with those modes; does not demonstrate the proposed handshake | Protected source/hash comparison and exact reply validation before transfer; helper remains HA-owned |
| Preparation readiness up to 25 seconds and at most 12 activation/refresh iterations with 1 second per iteration | Synthetic account/device predicates; inert activate, delay, refresh | Exact account/device identifiers and predicates, activation/refresh arguments, exhaustion and nested-failure behavior; do not invent a new retry policy |
| Transfer with `play:false`, `force_activate:false`, then 2 seconds | Inert transfer record with invented account/target | Exact installed provider service, native device selection and response/error handling |
| Playlist lookup asks for `tracks(total),name,uri`, `continue_on_error`; fallback count 50 | Inert response or deliberate lookup error | Exact provider response shape, source count/fallback expression, malformed response behavior |
| Playlist random `range(0,max(count,1))`; context starts at random offset and position 0 | Real HA template/random selection; zero count uses offset 0 | Exact context service/arguments and position/offset units |
| Playlist context with provider delay 0.5, then shuffle true with provider delay 0.25 | Inert captures with illustrative HA waits | Preserve delay fields as provider arguments, alongside exact target/account and parameters |
| Album context with shuffle false, position 0 and provider delay 1 | Inert context record with illustrative HA wait | Preserve provider delay argument; no extra initial shuffle service |
| Album-only wait 4 seconds, then shuffle-off safeguard | Illustration waits after both branches; not source-equivalent | Keep the wait and safeguard inside the album condition; no playlist safeguard wait |
| Wrapper `single` / silent overflow; correlated v1 completion | Real single script with `max_exceeded:silent`, revision/correlation response | Exact extracted wrapper, all failure/early-stop paths, no detached work reported as finished |
| Conflicting preferences explicitly rejected; no assignment rewrites | Dispatcher readiness rejects enabled conflicts; fixture guard has no service effects | Review each saved album/playlist preference using app optimistic versions; owner explicitly resolves conflicts before activation |

The fixture deliberately keeps malformed metadata semantics unimplemented beyond
failure rather than inventing household fallbacks. Missing wrapper completion is
unknown at the adapter; a nested helper stop alone does not prevent the caller from
continuing. The [completion review](17-playback-script-contract.md#preparation-helper-completion-review-2026-10-24)
blocks the unchanged-helper candidate: the owner-approved plan appends a typed,
correlated helper success reply and requires exact validation before transfer.
Missing, failed, malformed or mismatched replies must stop unknown/fenced, without
blind retry. This specific interface exception preserves all original helper actions,
mode and limits and leaves the legacy automation unchanged. The scoped independent
verification is recorded in the completion review above; it does not authorize live
service calls, deployment or playback. No script response proves that external
effects stopped. The helper's exhaustion test proves a bounded synthetic loop, not the household's readiness or post-exhaustion handling. The app remains the
assignment authority; script extraction must not rewrite its immutable snapshots.

## Deadline review and local readback

The [local admin configuration](18-ha-local-dispatcher.md#administrative-configuration-and-activation)
accepts an optional numeric `timeout_seconds`, strictly greater than zero and at most
300 seconds. The default stays 30 seconds; omitted values preserve a prior explicit
setting. It bounds the complete adapter attempt, including preparation, provider
calls and safeguards. It does not bound music duration or certify stopped work.

A **proposed 120-second value is only a planning candidate**, not a selected or applied
household setting. Review the exact extracted paths and provider timings first:
25-second waits, up to twelve 1-second iterations and the remaining service/delay
work can exceed 30 seconds. Do not merely add nominal delays and claim a bound on
provider/network latency. If the reviewed bound is unsuitable even within 300,
stop and review the design; never relax uncertainty or introduce automatic retries.

After a separately authorized configuration, read `jukelet_bridge/dispatch_config`
independently and compare both `profiles` and `timeout_seconds`. Read ordinary
`jukelet_bridge/status` separately for snapshot identity/checksum, disabled dispatch,
readiness and uncertainty. Configuration neither clears the fence nor enables
execution. Repeat both reads after an authorized reload/restart. A longer timeout
must never be used as a reason to replay an uncertain attempt.

## Reproducible isolated checks

Prepare the pinned environment using [companion setup](../companion/README.md#fixture-verification-and-limits),
then run from the repository root:

```sh
/tmp/jukelet-ha-companion-venv/bin/python -m companion.timeout_probe
/tmp/jukelet-ha-companion-venv/bin/python -m companion.preservation_probe
```

Both commands reject arguments and generate their own temporary configuration.
The first uses authenticated loopback WebSockets and fresh HA processes. It checks
admin-only configuration/readback, numeric validation, disabled/idle gating, omitted
field preservation, corrupt persisted configuration refusal, reload and an actual
distinct-PID restart. A real 31-second inert startup times out under the unchanged
30-second default and completes with an explicitly configured synthetic 45-second
bound. Busy scans are dropped, uncertainty survives restart, and no replay occurs.
Non-finite JSON is rejected by HA by closing that test socket; a separate admin
observer verifies configuration was not changed. Persisted invalid numeric values
are also checked at setup.

The second executes the YAML fixture using real HA templates, waits and delays. It
checks conditional paths, playlist count 3 / zero / lookup failure and fallback 50,
random bounds, transfer flags, context-before-shuffle, album safeguard, bounded
helper iterations, correlated completion and readiness-timeout stop. These commands
are intentionally slower than unit tests because they exercise real HA waits.
Their illustrative waits do not prove source-equivalent provider delay semantics
or the proposed helper handshake. Fixture success never establishes household preservation, account
readiness, physical playback or migration completion. Use the existing
[controlled migration gates](20-controlled-migration.md) for any future installation.
