# Playback readiness and failure diagnostics (#36)

The manager's **Playback readiness** section separates app-to-HA connection,
observed scans, published content, dispatch enablement/readiness, busy startup,
execution uncertainty and the most recent startup attempt. Publication still owns
saved-versus-published content. An enabled dispatcher or a script reporting
completion does not establish independently verified playback. No independent
playback verifier is implemented.

The companion and app need this implementation to show diagnostics. Older
companions can continue serving the existing publication/status contract while the
new section reports diagnostics unavailable. No household script change is needed.
Scripts without trustworthy completion still produce unknown outcomes: this feature
cannot recover missing reasons from old traces or infer receiver/account readiness.

## Practical interpretation

| Observation | Meaning and next step |
|---|---|
| HA connected / content published | Transport/content observations only. Inspect dispatch readiness separately. |
| Disabled after startup/reload/restart, ready | Expected safety policy. Ask an HA administrator to review readiness, confirm any legacy dispatcher is disabled, and deliberately enable through the existing HA procedure. |
| Busy | Startup or a fence write is in progress. Extra scans are ignored without queue/replay. Wait and inspect fresh status. A temporary fence is expected during execution. |
| Execution uncertain while idle | Work may have had effects or may still be running. An HA administrator must establish that **all** previous startup work, including nested/external work, stopped before explicit reconciliation. Script entity `off` alone is insufficient. Reconciliation leaves dispatch disabled; enable is separate. Do not blindly retry or scan again. |
| No scan observed | No retained evidence since companion load. This does not prove a reader is offline. Inspect the intended reader and HA tag-event path. Events before this window or during disconnection may be unknown. |
| Correlated `readiness_failed` / `account_failed` | The configured script explicitly reported this bounded failure for this attempt/revision. Ask an HA administrator to inspect configured preparation conditions and the correlated script trace. This does not prove external work stopped. |
| `transfer_failed` / `playback_failed` | A correlated script failure report; inspect the configured target/provider and trace. The uncertainty guard remains. |
| Missing, malformed or mismatched completion / timeout / service error | Unknown or bounded generic failure without trustworthy specific preparation evidence. Inspect actual HA state and correlated traces before recovery. |
| Finished | The correlated script sequence reported completion. Playback is still independently unverified. |
| Stale/disconnected/unavailable | Current readiness is unknown. Historical results remain historical; old success cannot certify current health. Check the connection/companion and refresh. |

Readiness also explains unavailable/invalid snapshots, shuffle conflicts,
unconfigured profiles, unavailable/running scripts and shutdown. No reader entity
is selected/polled and no household identifier is hardcoded. Administrator recovery
controls belong to #37; this screen has only a read-only refresh. The existing
[HA administrator procedure](18-ha-local-dispatcher.md) still requires separately
authorized recovery/activation.

## Separate strict read contract

The authenticated HA-administrator-only WebSocket request is exactly
`{"id":1,"type":"jukelet_bridge/diagnostics","diagnostics_version":1}`. Booleans,
floats and unsupported versions reject. A missing/unloaded dispatcher returns
`not_ready`. The command calls a pure synchronous read, never the legacy status
readiness latch, publication, administrative controls or script invocation.

Diagnostics v1 contains exactly these fields:

| Fields | Shape |
|---|---|
| `diagnostics_version` | Strict integer 1. |
| `started_at`, `observed_at` | Timezone-aware UTC window-start and read timestamps. |
| `dispatch_enabled`, `ready`, `busy`, `execution_uncertain` | Separate strict booleans. `ready` matches a null `readiness_error`. |
| `readiness_error` | Null or an existing bounded dispatcher readiness code. |
| `pause_reason` | Null, `startup`, `administrator_disabled`, `snapshot_changed`, `readiness_lost`, `execution_uncertain`, or `shutting_down`. Volatile lifecycle context, not durable proof of historical cause. |
| `last_scan_at` | UTC time of the latest valid observed tag event, or null. Disabled/busy/rejected-mapping scans can still be observed. No raw tag/reader IDs. |
| `last_attempt` | Null or generated UUID `correlation_id`, positive safe-integer `snapshot_revision`, `requested_at`, nullable `completed_at`, separate `invocation`/`execution`, bounded nullable `error`, and `playback_verification:"unavailable"`. Pending means `requested`/`unknown` with no completion/error. |
| `diagnostics` | At most 32 `{observed_at, reason}` records, using existing bounded reason codes. |
| `playback_verification` | Always `unavailable`. |

The latest invoked attempt is retained separately so ignored-scan traffic cannot
evict its result. Both it and the 32-record window are in memory and reset on
restart/reload; they are **not a complete durable scan audit**. The durable execution
fence survives independently. After restart, historical failure detail may be
unknown while execution remains uncertain. Last scan is a companion observation,
not a guarantee that the app received every scan.

The app exposes only authenticated `GET /api/v1/playback-status`, returning
`{connection, checked_at, stale, error, diagnostics}`. Strict versions/types,
bounded codes, UUID correlations, timestamp order and attempt consistency are
validated. Unknown fields/malformed data invalidate the diagnostic observation;
raw values/errors never escape. Last-good data may remain in memory as explicitly
stale. There is no mutation route or broad proxy.

Reads use the existing HAAdapter WebSocket path separately from the publisher.
Disconnected/changed connection generations cannot certify freshness. Source
observations older than 30 seconds or more than 5 seconds ahead of the app clock
are unavailable; keep HA/app clocks synchronized. Browser polls run serially every
10 seconds after completion, abort superseded/unmounted reads and expire displayed
freshness after 30 seconds even if a request hangs. The same 5-second future-clock
allowance applies. Timestamps and historical outcomes remain visible when current
readiness becomes unknown.

Existing v1 snapshot/checksum/status and script completion schemas are unchanged.
Original diagnostic records receive no added timestamp fields. Specific failures
come only from existing strict matching version/type/correlation/revision checks.
Failure never clears uncertainty or triggers another attempt. The browser receives
no raw events, media URIs, script allowlist, HA configuration, service proxy,
credentials or arbitrary exception text. App-independent playback is preserved.

## Synthetic verification

`make check build` includes companion/backend/component regressions.
`npm --prefix frontend run test:fixture` covers keyboard/mobile read-only diagnosis:
fresh completion, absent scan, busy, correlated preparation failure, invalid/missing
completion and stale/disconnected status. Component tests also expire freshness
during a hanging serial poll. App-to-companion tests use the real HAAdapter over
authenticated synthetic loopback WebSockets, capture requests and reject mutations.

After [pinned isolated HA setup](../companion/README.md#fixture-verification-and-limits):

```sh
/tmp/jukelet-ha-companion-venv/bin/python -m companion.diagnostics_probe
/tmp/jukelet-ha-companion-venv/bin/python -m companion.dispatcher_probe
```

The diagnostics probe accepts no target/configuration/credential arguments. It
creates temporary HA 2026.10.2 processes, generated users and loopback WebSockets;
only inert capture/delay/response scripts run. It checks admin/version rejection,
app-absent readiness/execution, busy, correlated success/failure,
missing/mismatched/boolean completion, retained fences/no retry and actual restarts
with truthful window reset. The dispatcher probe separately checks crash/reload/drain
guards. These do not establish household reader, receiver/account, Spotify playback,
deployment or migration success. Exact results belong to the issue evidence record.

### Implementation evidence, 2026-10-25

On Node 24.22.0/npm 11.19.1, Python 3.14.8, uv 0.13.1 and isolated
HA Core 2026.10.2:

- `make check build`: passed companion/historical types and 53/13 tests, Ruff
  lint/format, backend types and 243 tests, ESLint/TypeScript and 70 component
  tests, Python distribution and Vite production build.
- `npm --prefix frontend run test:fixture`: 11 Chromium workflows passed,
  including the new keyboard/mobile diagnostics workflow. The retained screenshot
  is `frontend/test-results/playback-diagnostics-mobile.png` (generated artifact).
- `/tmp/jukelet-ha-companion-venv/bin/python -m companion.diagnostics_probe` and
  `... -m companion.dispatcher_probe`: passed actual isolated process
  restart/failure and existing crash/reload/fence checks, using inert scripts.
- HA-aware mypy on `companion/custom_components/jukelet_bridge`, using the pinned
  HA interpreter and repository configuration: passed all eight modules.

Exact invocation environments/logs are retained locally under
`.workflow/2026-10-25-issue-36/evidence/`; independent verification/review are reported
with the PR. Initial implementation checks exposed a missing static type narrowing
and formatting, both corrected before the passing run. The first browser attempt
lacked the matching Chromium binary; after isolated installation, targeted and full
workflows passed. These were implementation/setup failures, not claimed intermittent
baseline failures. No household systems, live credentials or running deployment
were inspected, and no independent playback or household verification is claimed.
