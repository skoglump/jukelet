# Companion 0.1.4: remembered dispatch choice

On October 26, 2026 the owner approved remembering explicit dispatch choices across
healthy HA restarts. This replaces the earlier mandatory enable after every
restart. Installation alone still never enables playback.

## Operator behavior

In HA, open **Settings → Devices & services → Jukelet bridge → Configure → Inspect
and control tag playback**. The status text states `Dispatch: enabled` or
`Dispatch: disabled`; both action menu entries are always present.

| Situation | Behavior |
|---|---|
| Reviewed enable, healthy idle restart/reload | One check after HA startup restores enabled dispatch if snapshot/history/publisher, script allowlist and timeout match, persistence is healthy, the execution fence is clear and the configured single-mode script is available and idle |
| Explicit disable | Remains disabled across restarts; publication cannot enable it |
| First install or upgrade from 0.1.3 without saved consent | Remains disabled until one reviewed enable establishes the saved choice |
| Snapshot recovery/replacement, changed configuration, failed readiness or uncertain execution | Remains disabled; review is required, with separate all-work-stopped reconciliation when uncertain |
| Script dependency unavailable at the startup check | Remains disabled even if the dependency later appears; refresh and enable manually after review |
| A full HA backup restored through supported facilities | Restores that backup's saved choice too; use paused recovery backups and inspect state before admitting scans |

Keep **every legacy dispatcher disabled across restarts**. The integration does not
select or modify legacy automations. Enabling admits only future intentional
scans. It never invokes playback by itself, queues an ignored scan or replays
uncertain work. App Automatic publication and HA dispatch remain separate controls.

The new private companion-owned `jukelet_bridge.activation` Store is version 1.
It binds consent to validated execution identity, with strict schema validation,
atomic save and fresh disk readback. No existing snapshot/history/execution,
config-entry, v1 status or diagnostics schema changes. Before invoking an admitted
attempt, saved resume is disabled; trustworthy finished/rejected completion and
clear-fence readback permit restoring it. Persistence work is serialized and owned
through cancellation/unload. Failed save/readback pauses dispatch and is not a
confirmed durable choice. A shutdown during admitted work may conservatively
require manual enable afterwards.

A coherent full restore can be indistinguishable from a normal restart; this
feature cannot detect every restoration of an enabled backup. The supported
maintenance/recovery procedure disables dispatch **before backup**, keeps legacy
OFF and verifies restored state before reviewed enable. Snapshot recovery through
the companion always leaves it disabled. The existing household restore-testing
waiver remains unchanged; no household restore test is claimed.

## Immutable artifact

| Item | Identity |
|---|---|
| Integration | 0.1.4; integration-only, no app image update |
| Source commit | `092aa037ba7f35ae7a0f83afc980ece907d80020` |
| Component tree | `b37ab2d0e2e2be4a1e4116ba6ab9827595520636` |
| Archive | `dist/integration/jukelet-bridge-0.1.4.zip`, 15 allowlisted members including build identity and MIT license |
| Archive SHA-256 | `5f4482573ded77bd895fe358848cd71db12a09ffde7ade3d4de0097f3813d72e` |

Reproduce using the trusted builder from that source and a fresh output directory:

```sh
python3 scripts/package_integration.py --ref 092aa037ba7f35ae7a0f83afc980ece907d80020 --output /tmp/jukelet-bridge-014
python3 scripts/package_integration.py --verify /tmp/jukelet-bridge-014/jukelet-bridge-0.1.4.zip
```

Later documentation/probe commits are separate evidence identities; building from
a later HEAD changes archive bytes. Never overwrite 0.1.3 or republish changed
bytes under an existing release identity. No tag/release/package/image publication
is authorized by preparing this artifact. Minimum **Core 2026.10.3**, stable forward
compatibility and beta/dev limits remain as [documented](30-ha-compatibility.md).

## Verification evidence

On October 26, both exact-artifact runs passed on Linux x86-64, Python 3.14.9,
using upstream HA dependency pins without overrides. `uv pip check` exited 0.

| Actual isolated Core | Same archive | Result |
|---|---|---|
| 2026.10.3 (minimum) | SHA-256 `5f448257…3813d72e` | 12/12 probes passed |
| 2026.10.4 | SHA-256 `5f448257…3813d72e` | 12/12 probes passed |

Each run exercises 71 fresh-config compatibility negatives, clean distribution, historical 0.1.2
and immediate exact 0.1.3 upgrades, durable recovery, native tag event validation,
admin controls, diagnostics, inert scripts, real timeout boundaries, preservation,
app publication and migration. New actual-process scenarios verify enabled resume,
disabled choice retention, snapshot recovery remaining disabled across restart,
clear-fence/readiness requirements and no replay. No production credentials,
readers, playback services or household state enter these tests.

Exact final matrix commands (with the existing `/tmp/jukelet-issue32-tools` on
PATH, including uv 0.13.5, and `UV_CACHE_DIR=/tmp/jukelet-issue48-uv-cache`):

```sh
python3 -m scripts.ha_compatibility run --python /tmp/jukelet-issue48-ha-2026.10.3/venv/bin/python --baseline-python /tmp/jukelet-issue48-ha-2026.10.3/venv/bin/python --archive dist/integration/jukelet-bridge-0.1.4.zip --output .workflow/2026-10-26-dispatch-resume/evidence/verified-ha-2026.10.3
python3 -m scripts.ha_compatibility run --python /tmp/jukelet-issue48-ha-2026.10.4/venv/bin/python --baseline-python /tmp/jukelet-issue48-ha-2026.10.3/venv/bin/python --archive dist/integration/jukelet-bridge-0.1.4.zip --output .workflow/2026-10-26-dispatch-resume/evidence/verified-ha-2026.10.4
```

Each `result.json` records loaded Core/distribution/Python/module identities, exact
artifact and file hashes, all commands/exit codes, probe source hashes and complete
dependency versions/hash. Probe source is recorded separately from archive source.
The final source hashes were checked unchanged after both runs.

Repository checks: `make backend-check` passed historical 13 and current 95
companion tests, strict types/lint/format and 244 backend tests; `make frontend-check
build` passed frontend lint/types, 80 tests, wheel/sdist and frontend build.
The existing FastAPI/Starlette test-client deprecation warning remains. Independent
review passed, including reproduced regressions for shutdown polling/scans,
closed-instance controls and reconciliation drain. A prior candidate's diagnostics
probe assumed restart disabled; it was corrected to explicitly pause before
configuration. Earlier candidates/aborted runs are not the canonical evidence.

The protected local run record is `.workflow/2026-10-26-dispatch-resume/`.
Production deployment observations are separate from these isolated results and
are recorded in `.workflow/2026-10-26-ha-0.1.4-deployment/`.

## Actual authorized HA deployment — October 26

At 10:13 UTC, companion 0.1.4 was installed and verified on actual Core
**2026.10.4**, using the exact archive above. Core and the app image were unchanged.
All 15 installed file hashes and source identity matched; the complete previous
0.1.3 integration was preserved. Supported `ha core check`, `stop` and `start`
operations were used, with independent endpoint/loaded-entry readback. Household
scripts were unchanged; no raw HA storage or credential store was edited.

After initial guarded enable, one further actual Core stop/start was performed
with the publisher stopped. Dispatch resumed **enabled without another enable
command**. Fresh diagnostics showed ready, idle, no uncertainty, no attempt or
scan since startup. Independent readbacks preserved config-entry/publisher,
revision 4, checksum, all 10 mappings, script allowlist and 120-second timeout.
The unchanged app resumed healthy with Automatic ON, exact reconciliation, no new
jobs and unchanged publication high-water; legacy stayed OFF.

Protected coherent full HA and consistent app backups were taken before and after
the companion replacement, both with dispatch paused. The before HA ciphertext
stream was hashed and matched its 2,351,616,000-byte metadata size; the after HA
backup was verified through completed protected metadata (not a second stream
hash). Recovery keys and database copies remain private. No physical or simulated
scan, playback, volume, power, account action or household restore test was run.
The existing restore-testing waiver is unchanged.

The recorded operational command was
`backend/.venv/bin/python .workflow/2026-10-26-ha-0.1.4-deployment/continue_verified_preflight.py`
(exit 0). Its per-step private evidence covers maintenance disable/readback,
correct-target offline SQLite backup, full `backup/generate` and protected metadata
verification, encrypted backup download, stopped complete-directory replacement,
configuration/start/readback, app reconciliation and post backups, native guarded
enable, then actual enabled restart and all-file verification. An earlier
WebSocket handshake timeout stopped the first attempt during a read, before any
mutation; fresh same-endpoint readback established original healthy state before
continuing. Only bounded read operations were retried; no writes were retried.
See private `deployment-continuation.log`, `actual-healthy-restart-readback.json`
and `final-result.json` for exact scoped commands/results. Synthetic fixtures,
actual isolated HA and this production observation remain distinct evidence.
