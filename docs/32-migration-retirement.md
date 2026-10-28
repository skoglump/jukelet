# Standalone operation and automation migration retirement (#51)

App **0.1.0-rc.3** (`0.1.0rc3` in Python) and separately installed integration
**0.1.5** are new prepared identities. They are not releases or deployed upgrades.
Do not replace any previously published RC image, integration archive or tag.

## Current behavior and compatibility

No old automation, automation entity ID or mapping report is required. HA supplies
tag identity/names; SQLite supplies assignments and preferences; the companion
executes a versioned snapshot through the configured local playback script.
Inventory joins each page with saved assignments. Disabled assignments count as
assigned. Filters/search describe this page of saved data, not active HA content.
Publication reports independent actual-state readback. Saved, published,
dispatch-enabled and independently playback-verified are distinct; no independent
Spotify playback verification has been added.

`LEGACY_AUTOMATION_ENTITY_ID` is no longer read, validated, forwarded by Compose or
stored in settings. Old environment values, including malformed ones, are ignored
without logging them. Remove obsolete values during normal deployment upkeep.
No compatibility path fetches `/api/config/automation/config/*` or selects an old
automation. Both configured-source and uploaded JSON/YAML `variables.tags` imports,
source reports, confirmation tokens and parser are removed. PyYAML remains a dev
dependency for independent HA preservation tooling, not an app runtime dependency.

The old `/api/v1/imports/preview` and `/api/v1/imports/confirm` POST URLs have only
rejection tombstones: authenticated, same-origin requests return HTTP **410** with
`detail.code: automation_import_retired`, even for malformed bodies or stale tokens.
Unauthenticated requests return 401; invalid Origin/host keeps existing 403/400
boundaries. Bodies are not parsed and no HA calls or domain transactions occur.
No replacement bulk importer is introduced. `/api/v1/export`, `/api/v1/restores/*`
and guarded SQLite backup/recovery retain their existing contracts.

App `/api/v1/publication/confirm` replaces request field `migration_attested` with
`automatic_publication_attested`. The old field is an unknown field and returns
422; there is no alias. A new session-bound, expiring review and explicit
confirmation of backups, exclusive tag-playback dispatch and rollback is required
for a new automatic-publication opt-in. Existing persisted opt-in is the same
choice to automatically publish later saves, and is retained; healthy reconciliation,
content/conflict checks and recovery suspension still gate every publication.
No old request or in-memory review is converted into new consent.

Integration 0.1.5's HA options form replaces `confirm_legacy_disabled` with
`confirm_exclusive_dispatcher`: the administrator verifies **no other tag-playback
dispatcher is active or will resume after restart**. Old form submissions cannot
satisfy that checkbox. Its internal guarded-control parameter becomes
`confirmed_exclusive_dispatcher`; there is no compatibility alias. Existing v1
snapshot/status/readback and low-level administrator WebSocket command shapes
remain unchanged. Those low-level commands retain their documented separate
operator review boundary; app sign-in does not grant HA administrator authority.
Fresh expiring options intents, independent readback and separate stopped-work
reconciliation remain. Controls do not invoke playback.

There are no SQLite, config-entry, snapshot/history or activation Store schema
changes. Saved assignments, URIs, preferences, metadata behavior, publisher and
config-entry IDs, revisions, tombstones and execution fences remain. The remembered
enable/disable choice introduced in 0.1.4 retains its meaning and healthy startup
checks; upgrade does not create a new choice. Uncertain/degraded/recovered state
stays paused, and old scans are never replayed. Restored content is never implicitly
republished. An old app may still read unchanged bridge protocols, but use matched
current app/UI assets for the changed app consent request and HA form.

## Upgrade and reproducibility

Use protected coherent backups, stop the publisher for maintenance, replace the
complete integration directory, restart, then independently verify loaded
version/source/hash and fresh readiness. Preserve all stores/config-entry data and
the configured script/profile/timeout. Never delete identity/history or edit HA
`.storage` to force an upgrade. Keep automatic publication suspended when reviewing
recovery; ordinary compatible updates preserve existing choices and do not grant
new consent. See [distribution](24-integration-distribution.md) and
[operations](26-installation-and-operations.md) for the established supported path.

Build one archive from the exact reviewed committed integration source with
`scripts/package_integration.py --ref <full-commit> --output <new-owned-directory>`.
Use those identical bytes for minimum Core 2026.10.3, discovered current stable
and upcoming beta early warning under [the compatibility policy](30-ha-compatibility.md).
CI resolves the selected Core source commit’s exact `.python-version` and provisions
it with the pinned setup-python action before pinned uv creates the HA environment.
This permits new Python patches absent from uv’s bundled download catalogue without
overriding upstream dependencies.

Record the archive SHA-256, source commit/tree/per-file manifest, imported Core/Python
and upstream dependency identities; a changed runtime/package source needs a new
identity. No archive is published by this issue.

Current CI replaces `migration` with `standalone`. The standalone probe loads no
automation integration and exercises real app publication, preference conflicts,
busy/duplicate rejection, exact IDs, app-stopped inert-script execution, automatic
opt-in persistence and healthy enabled/disabled process restarts with no replay.
Existing publication/runtime/dispatcher/administration/distribution/tag probes
retain recovery, malformed input, uncertainty, pairing, upgrade and fencing cases.
Unit/API/browser fixtures cover inventory/onboarding/rename, saved assignment display,
retired requests and native data recovery. These are separate evidence classes;
passing fixtures is not an actual HA result.

Historical migration rehearsal and its exact importer are reproducible from
[source 46104123165599e2adb71505993c948fe4eba5b2](https://github.com/skoglump/jukelet/tree/46104123165599e2adb71505993c948fe4eba5b2)
in a separate disposable checkout with its pinned dependencies, using
`python -m companion.migration_probe`. Do not run historical probes against current
source or an existing installation. Earlier reports and immutable archives retain
their dated scope; retirement does not rewrite them.

## Dated verification and canonical artifact — 2026-10-28

The canonical integration archive is built from committed implementation source,
not from this later evidence-only documentation. No release, tag, package, image
publication or deployment occurred.

| Artifact field | Exact identity |
|---|---|
| Archive | `jukelet-bridge-0.1.5.zip` |
| Source commit | `6ea31d55f0fb4ba3fe7af605a594172d8a3ddb2c` |
| Component Git tree | `0308d0b8598086598ad9c1b81a6d6be57038976e` |
| Archive SHA-256 | `b481593914d9e9810027cbe62a9f1d12dc02a607e8efa25c2abe6704461c9371` |
| Members | 15: integration runtime, generated `build_info.json` and committed MIT license |
| Local canonical archive and sidecars | `/tmp/jukelet-issue51-artifact/` |

An independent rebuild from that exact commit was byte-identical (`cmp`, exit 0),
and the package verifier passed. Reproduce with the exact `--ref` below; packaging
a later docs-only HEAD changes build identity and is not reproduction of these bytes.

```sh
python3 scripts/package_integration.py \
  --ref 6ea31d55f0fb4ba3fe7af605a594172d8a3ddb2c \
  --output /tmp/jukelet-issue51-tester/archive-rebuild
cmp /tmp/jukelet-issue51-tester/archive-rebuild/jukelet-bridge-0.1.5.zip \
  /tmp/jukelet-issue51-artifact/jukelet-bridge-0.1.5.zip
python3 scripts/package_integration.py --verify \
  /tmp/jukelet-issue51-artifact/jukelet-bridge-0.1.5.zip
```

These commands already ran; use a new owned output directory for another rebuild.
The manifest and `.sha256` sidecar accompany the canonical archive. The independent
tester captured a complete source-content manifest, compared with no mismatches
before this documentation addition. Integration, backend and packaging remain
identical to the canonical commit. Later frontend and probe corrections below have
separate validation and do not change the integration archive.

### Independent application, browser and upgrade checks

All commands ran from `/tmp/jukelet-issue51` after
`source .workflow/2026-10-28-issue51/tools.env`, selecting Node 24.22.1/npm 11.19.1,
Python 3.14.9 and uv 0.13.5. Command/exits/timestamps and logs reside under the
local `/tmp/jukelet-issue51-tester/` evidence root; these are local working evidence,
not published artifacts or household exports.

| Exact command / check | Result | Local evidence |
|---|---|---|
| `make check build` | Exit 0: Ruff lint/format, mypy (22 companion/historical and 52 backend files), 13 historical + 96 supported companion tests, 217 backend tests, frontend ESLint/types/78 tests, wheel/sdist and Vite build | `check-build.json`, `check-build.log` |
| `npm --prefix frontend run test:fixture` | Exit 0: 13/13 Chromium fixture workflows, including saved assignments, keyboard/mobile metadata fallback, onboarding/rename, native restore and publication | `browser.json`, `browser.log` |
| `make image smoke` | Exit 0: local image build; isolated HTTP authentication/CSRF, container replacement/session persistence, non-root/secret isolation and rejected startup settings; 1/1 Chromium login/reload/obsolete-request/manual-URI/logout workflow | `image-smoke.json`, `image-smoke.log` |
| Prior app → current app database upgrade and native recovery harness below | Exit 0; exact preserved data/identity/counter checks and recovery guards | `upgrade.py`, `upgrade.json`, `upgrade.log` |
| Exact-source archive rebuild, byte comparison and verifier above | Exit 0; identical canonical archive | `artifact.json`, `artifact.log`, `archive-rebuild/` |
| `/tmp/jukelet-issue51-tester/actionlint/actionlint .github/workflows/ha-compatibility.yml` | Exit 0 with Actionlint 1.7.12 | `workflow.json`, `workflow.log` |

The upgrade harness ran these exact commands against a disposable synthetic database:

```sh
PYTHONPATH=/tmp/jukelet-issue51-baseline/backend/tests:/tmp/jukelet-issue51-baseline \
  /tmp/jukelet-issue51-baseline/backend/.venv/bin/python \
  /tmp/jukelet-issue51-tester/upgrade.py seed
PYTHONPATH=backend/tests:. backend/.venv/bin/python \
  /tmp/jukelet-issue51-tester/upgrade.py verify
```

The seed phase executed baseline app APIs from
`46104123165599e2adb71505993c948fe4eba5b2`, creating exact opaque IDs, an enabled album,
a disabled playlist with explicit preferences and a deletion tombstone. It published
through the loopback synthetic bridge fixture and explicitly enabled automatic
publication using the old consent field before closing the old app. This is an
actual old-app/new-app database transition using a **synthetic bridge**, not actual HA.

Current startup accepted a malformed obsolete environment value without using it.
The harness compared assignments, revisions, publisher identity, jobs and audit exactly;
retained publication high-water/active content/established status/persisted opt-in;
and required fresh reconciliation (`healthy=0`). Export assignments matched the old
export. Configured/uploaded/malformed obsolete requests returned 410 and old consent
returned 422 with identical before/after domain state. Native logical restore preserved
publisher/high-water/jobs, advanced current assignment revisions, set recovery guards
and suspended automatic publication. Consistent SQLite backup followed by offline
recovery retained assignments/identity/counters, advanced the guard generation,
removed sessions and created a protected mode-0600 destination. Reopening that recovered
app retained its guarded state and two assignments; nothing implicitly republished.

An implementer full-suite run separately observed the unchanged
`Recovery.test.tsx` initial-preview focus assertion fail intermittently. The only
`Recovery.tsx` edit changes successful-confirmation text, which that failing path did
not reach. Isolated 3/3 Recovery tests and a complete 78/78 frontend/full-check rerun
passed without edits, as did the independent tester's complete suite and Chromium
restore workflow. The failure is retained in `/tmp/issue51-final-check.log`, with
no-change reruns in `/tmp/issue51-recovery-focus.log` and
`/tmp/issue51-final-check-rerun.log`. This is consistent with the earlier timing-related
observation retained in [historical compatibility evidence](30-ha-compatibility.md);
it is not a claim that the intermittent test behavior was fixed.

### Frontend review correction — 2026-10-28

Independent review reproduced a saved-detail inconsistency: keep a first-page tag
open, navigate to page two, then edit or remove its assignment. The editor reflected
the successful response while the retained tag detail still showed its previous
assignment. The correction passes the authoritative assignment (or removal `null`)
from the successful response to both the inventory page and selected-tag snapshot.
The editor remains mounted, preserving unsaved form contents across page navigation.

Two component regressions failed before the fix for the intended stale detail,
then passed. A Chromium regression also checks off-page save/removal and retained
form contents when navigating back. Exact commands ran with the pinned environment
above; logs below are local evidence, not hosted checks:

| Command | Result | Local log |
|---|---|---|
| `npm --prefix frontend test -- src/Inventory.test.tsx -t 'off-page'` before correction | Exit 1: both edit/removal regressions failed on stale displayed saved data | `/tmp/issue51-repair1-red.log` |
| `npm --prefix frontend test -- src/Inventory.test.tsx src/Assignments.test.tsx` after correction | Exit 0: 14/14 tests | `/tmp/issue51-repair1-focused.log` |
| `npm --prefix frontend run lint && npm --prefix frontend run typecheck && npm --prefix frontend test && npm --prefix frontend run build` | Exit 0: lint/types, 80/80 tests and Vite production build | `/tmp/issue51-repair1-frontend.log` |
| `npm --prefix frontend run test:fixture` | Exit 0: 14/14 Chromium workflows, including the new off-page regression | `/tmp/issue51-repair1-browser.log` |

The earlier backend, recovery and actual HA evidence still applies to unchanged
backend/integration/probe sources. Earlier frontend counts describe the original
canonical source; the results above cover the first correction. Independent repetition
of `make frontend-check frontend-build`, the 14 Chromium workflows and `make image
smoke` passed. However, the tester's additional malformed-response and concurrent-edit
browser probes found two further saved-detail failures. That verification outcome
was **FAIL**, with exact commands/results and reproductions retained in
`/tmp/jukelet-issue51-tester-repair1/handoff.md` and its adjacent logs; passing ordinary
checks did not close those findings.

### Frontend response validation and reconciliation correction — 2026-10-28

A malformed HTTP-200 mutation body could falsely clear the selected saved assignment.
Separately, after an off-page concurrent edit and 409, explicit reload updated the
editor but left the selected saved detail stale. Both failures were reproduced by
new component regressions before correction.

Initial reads, explicit reloads and mutation replies now validate the complete DTO,
safe revision, exact tag key/opaque ID, supported URI/media type and preferences.
Mutation responses must advance the expected revision and represent the requested
save or removal. Malformed or failed responses retain the last confirmed saved detail
and form, report uncertainty and block further writes until a valid reload. Validated
reads update selected saved data through a separate read notification; they neither
announce a mutation nor restart the fetch effect. Explicit successful reload remains
the action that replaces unsaved form input after conflict. Failed/malformed reloads
retain it, and ordinary parent/page renders do not reset it.

| Exact command after sourcing the pinned environment | Result | Local log |
|---|---|---|
| `npm --prefix frontend test -- src/Inventory.test.tsx -t 'malformed successful\|conflict reconciliation'` before correction | Exit 1: both intended regression assertions failed | `/tmp/issue51-repair2-red.log` |
| Same focused regression command after correction | Exit 0: both regressions passed | `/tmp/issue51-repair2-first-green.log` |
| `npm --prefix frontend test -- src/Assignments.test.tsx src/Inventory.test.tsx` | Exit 0: 37/37, including malformed DTO/identity/version checks, off-page save/remove, failed read/write retention, initial reads and explicit conflict reconciliation | `/tmp/issue51-repair2-focused.log` |
| `npm --prefix frontend run lint && npm --prefix frontend run typecheck && npm --prefix frontend test && npm --prefix frontend run build` | Exit 0: lint/types, 103/103 tests and Vite production build | `/tmp/issue51-repair2-frontend.log` |
| `npm --prefix frontend run test:fixture` | Exit 0: 15/15 Chromium workflows, including malformed-success rejection, failed read retention and off-page concurrent-edit reconciliation | `/tmp/issue51-repair2-browser.log` |

Two pre-existing editor test fixtures were made complete API DTOs, and the rename
fixture now returns the saved assignment it displays; no assertions were weakened.
This frontend-only correction leaves backend, integration, HA probes and packaging
identical to the canonical source. Their earlier evidence remains applicable; the
earlier frontend/image/browser evidence does not verify this later correction.

Independent verification of this corrected frontend completed **PASS** on
2026-10-28. The evidence root is `/tmp/jukelet-issue51-tester-repair2/`; its
`check-ledger.json` and individual command JSON records retain exact commands, UTC
times and exits. All commands below used the same pinned tool environment.

| Independent command | Result | Local evidence within that root |
|---|---|---|
| `make frontend-check frontend-build` | Initial exit 2: 102/103 tests, unchanged Recovery focus assertion failed; unchanged complete rerun exit 0: lint/types, 103/103 tests and production build | `frontend.json/log`, `frontend-rerun.json/log` |
| `npm --prefix frontend test -- src/Recovery.test.tsx` | Exit 0: 3/3 tests, without source changes | `recovery-focused.json/log` |
| `npm --prefix frontend run test:fixture` | Exit 0: 15/15 Chromium workflows | `browser.json/log` |
| `make image smoke` | Exit 0: rebuilt image, synthetic HTTP/security/container-replacement persistence and 1/1 Chromium session workflow | `image-smoke.json/log` |
| `node /tmp/jukelet-issue51-tester-repair2/malformed.mjs && node /tmp/jukelet-issue51-tester-repair2/conflict-reload.mjs` | Exit 0: both independent original reproductions now confirm corrected behavior | `regressions.json/log` and screenshots |
| `node /tmp/jukelet-issue51-tester-repair2/read-failures.mjs` | Verified exit 0: malformed initial read rejected, failed/malformed off-page reloads retain detail/form, valid removal read reconciles detail, no read loop | `read-failures-verified.json/log` |

The full passing frontend rerun ran from `17:49:22.579334` to `17:49:34.617174` UTC.
The initial Recovery focus failure is preserved alongside its isolated and full
unchanged reruns; the correction does not claim to fix that known intermittent
test behavior. Chromium's native restore workflow also passed independently.

The independent read-failure harness initially exited 1 because its expected one
mount read omitted development React StrictMode's mount/abort/remount. The tester
corrected only that local harness expectation; application/test sources were unchanged.
The verified run counted exactly seven assignment reads: two initial mount reads
and five explicit reloads. Two waits beyond the five-second inventory poll interval
added no assignment reads and preserved pending form input. The original failed
harness result remains in `read-failures.json/log`.

`end-state.json` records no source changes during verification; `source-applicability.json`
confirms that unchanged backend, HA, probes and archive retain their earlier evidence.
This final documentation update adds evidence only. Fresh review and hosted PR checks
remain pending at this cutoff.

### Hosted probe synchronization correction — 2026-10-28

Fresh review of the frontend correction was approved and [PR #52](https://github.com/skoglump/jukelet/pull/52)
was opened. Ordinary hosted checks passed. The minimum-HA job in compatibility run
`40740234240` first failed an inherited administration-probe assertion after a fixed
20 ms scan wait. Stable and beta passed. One unchanged failed-job rerun then failed
an exact distribution-upgrade fence comparison after its fixed 400 ms seed wait.
Neither failure is erased by the earlier local matrix pass.

Independent diagnosis used generated isolated HA state with an 800 ms delay in
completion-fence Store persistence. The old sampling boundary captured execution
`finished` while dispatch was still busy and the fence remained uncertain. Restarting
the **same historical 0.1.2 bytes**, without an upgrade, changed only that in-flight
fence. Waiting for observed `busy=false` before sampling preserved every compared
field across both same-version restart and archive upgrade. Administration likewise
had no guarantee that invocation occurred within its 20 ms window; its original
hosted log did not record the instantaneous capture count or later state, so that
particular delayed invocation remains an inference. The controlled persistence race
is reproduced evidence, not an inferred integration defect.

Probe synchronization now waits for the exact expected capture count and, for
completion checks, independently read dispatcher `busy=false`, with a five-second
deadline and explicit failure on missing/excess capture or unfinished persistence.
It accepts settled uncertainty as the expected outcome in failure scenarios.
Busy-state assertions use an explicit hold/release latch in the **inert capture
service**, released in cleanup and bounded by a 20-second timeout. The same short
busy-sampling windows in dispatcher, diagnostics, native-tag and timeout probes use
this observation boundary. Exact upgrade comparisons, busy/duplicate drops,
uncertainty, no-replay assertions and the real 30/31-second timeout scenarios remain.
No production runtime, API, schema, app code or artifact identity changed.

The implementer demonstrated a delayed-persistence seed regression fail before the
fix and pass afterward. Eight probe regressions cover delayed admission/persistence,
settled uncertainty, missing/excess captures, deadline failure (including a response
arriving after the deadline) and latch cleanup.
`make backend-check` passed after correcting a typing issue in the new synthetic
test fixture: 13 historical + 104 supported companion tests, 217 backend tests,
Ruff and mypy. The initial typing failure and passing rerun are retained as
`/tmp/issue51-repair3-backend-check.log` and `-rerun.log`; the final check after the
additional deadline regression is `/tmp/issue51-repair3-final-backend-check.log`.
Red/green/focused results are `/tmp/issue51-repair3-{red,first-green,focused}.log`,
with the intended late-response failure in `/tmp/issue51-repair3-deadline-red.log`.

With the pinned tool environment and
`JUKELET_PROBE_ARCHIVE=/tmp/jukelet-issue51-artifact/jukelet-bridge-0.1.5.zip`, the exact
command `/tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python -m companion.PROBE_probe`
passed for each of `administration`, `distribution`, `dispatcher`, `diagnostics`,
`tag` and `timeout`. Each exit was 0; logs are `/tmp/issue51-repair3-PROBE.log`.
Administration and distribution also passed again after the final late-response
deadline guard; those logs are `/tmp/issue51-repair3-final-{administration,distribution}.log`.
The separate actual-HA command
`/tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python /tmp/issue51-repair3-delayed.py`
also exited 0, comparing no-delay control, old sampling with 800 ms persistence delay,
and the corrected observed boundary. Its structured result in
`/tmp/issue51-repair3-delayed/distribution-fence-race-result.json` records the canonical
archive SHA-256 `b481593914d9e9810027cbe62a9f1d12dc02a607e8efa25c2abe6704461c9371`;
the delayed old sample changed only the fence on restart, while the corrected sample
retained all fields through restart/upgrade with no replay.

Independent verification then repeated the checks below with unchanged frozen
probe source. Exact commands, UTC times and exits are retained under
`/tmp/jukelet-issue51-tester-repair3/`; each command used the pinned tool environment.

| Independent command | Result | Evidence within that root |
|---|---|---|
| `make backend-check` | Exit 0: 13 historical + 104 supported companion tests, 217 backend tests, Ruff and mypy; `18:27:02.084905` → `18:28:04.227617` UTC | `backend-check.json/log` |
| `/tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python /tmp/jukelet-issue51-tester-repair3/distribution-fence-race.py` | Exit 0: original no-delay and delayed 800 ms cases using the corrected seed both preserve exact state across same-historical-version restart and canonical archive upgrade, with no replay | `delayed-fence.json/log`, `distribution-fence-race-result.json` |
| `/tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python /tmp/jukelet-issue51-tester-repair3/admission-gate.py` | Exit 0: delayed actual admission, bounded held-work/missing-capture failures, exception cleanup and rejected/malformed status handling | `admission-gate.json/log`, `admission-gate-result.json` |

The independent admission experiment delayed admission persistence by 150 ms: the
old 20 ms sample observed zero captures, while the corrected wait observed one
capture and held busy state after about 159 ms. Releasing the latch then reached
settled state. Deliberately held work and a deliberately missing second capture
each failed their configured 50 ms observation deadline in about 51 ms; an assertion
exception released the actual inert gate. Rejected and malformed status observations
failed rather than being accepted as readiness. This establishes the timing mechanism
under controlled actual HA conditions; it does not recover the missing instantaneous
state from the original hosted failure.

`source-applicability.json` confirms the canonical archive hash and frozen probe
content, retaining the earlier 103-test frontend checks/build, 15 Chromium workflows,
rebuilt image/smoke and native app upgrade/recovery evidence for unchanged content.
The completed matrix below supersedes the initial matrix for the changed probes.
Fresh review and hosted checks for this correction remain pending at this cutoff.

### Final independent actual HA matrix after probe correction — PASS

All twelve probes passed again on all three HA versions using the **same canonical
0.1.5 ZIP**, SHA-256
`b481593914d9e9810027cbe62a9f1d12dc02a607e8efa25c2abe6704461c9371`.
Each runner, dependency check and individual probe exited 0. Imported Core/Python
and installed dependency-list hashes match the original environment identities
recorded below; the beta remains early-warning evidence.

| Core / role | Imported Python | UTC command start → finish, 2026-10-28 | Result |
|---|---|---|---|
| 2026.10.3 / declared minimum | 3.14.9 | `18:27:02.096289` → `18:32:19.047091` | 12/12 PASS |
| 2026.10.4 / discovered stable | 3.14.9 | `18:27:02.089814` → `18:32:27.625823` | 12/12 PASS |
| 2026.11.0b0 / upcoming beta | 3.14.10 | `18:27:02.124067` → `18:32:34.627340` | 12/12 PASS |

Exact commands from `/tmp/jukelet-issue51` after sourcing the pinned environment:

```sh
python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python \
  --baseline-python /tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python \
  --archive /tmp/jukelet-issue51-artifact/jukelet-bridge-0.1.5.zip \
  --output /tmp/jukelet-issue51-tester-repair3/ha-2026.10.3
python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-issue51-ha-2026.10.4/venv/bin/python \
  --baseline-python /tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python \
  --archive /tmp/jukelet-issue51-artifact/jukelet-bridge-0.1.5.zip \
  --output /tmp/jukelet-issue51-tester-repair3/ha-2026.10.4
python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-issue51-ha-2026.11.0b0-ready/venv/bin/python \
  --baseline-python /tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python \
  --archive /tmp/jukelet-issue51-artifact/jukelet-bridge-0.1.5.zip \
  --output /tmp/jukelet-issue51-tester-repair3/ha-2026.11.0b0
```

Use new owned output directories when repeating them. Exact command records are
`/tmp/jukelet-issue51-tester-repair3/ha-VERSION.json`; each `ha-VERSION/result.json`
contains all twelve probe exits, archive manifest, imported runtime/dependency
identities and identical final probe-source hashes. Adjacent named probe logs
retain individual assertions. The shared `companion/dispatcher_probe.py` SHA-256 is
`ebf21b492e9d6e61cabfa07f39b9119419718fd284c44c0cda6a04d703db1d7e`;
the six corrected probe files and regression test are also covered by
`source-manifest.json`. Integration runtime bytes still come from canonical commit
`6ea31d55f0fb4ba3fe7af605a594172d8a3ddb2c`; probe changes were tested separately from
that immutable archive. This later evidence-only documentation does not alter the
tested runtime or probes. Both earlier hosted failures and the initial matrix
remain recorded; this local matrix does not claim that updated hosted checks or
fresh review have passed.

### Initial actual isolated HA matrix — PASS, before probe correction

The independent tester completed all twelve probes on each Core version with the
identical canonical 0.1.5 archive above. Every runner, probe and dependency check
exited 0. These are actual isolated HA processes with generated credentials,
disposable configuration/storage and inert synthetic scripts. Beta is early-warning
evidence, not supported household status. The PyPI discovery repeated at
`2026-10-28T17:21:59.688937+00:00` selected stable 2026.10.4 and beta 2026.11.0b0.

| Core / role | Imported Python | UTC command start → finish, 2026-10-28 | Result |
|---|---|---|---|
| 2026.10.3 / declared minimum | 3.14.9 | `17:18:30.187299` → `17:24:08.212342` | 12/12 PASS |
| 2026.10.4 / discovered stable | 3.14.9 | `17:18:30.201104` → `17:24:11.741264` | 12/12 PASS |
| 2026.11.0b0 / upcoming beta | 3.14.10 | `17:18:30.216198` → `17:24:26.353758` | 12/12 PASS |

All twelve probes ran in each environment: `compatibility`, `distribution`,
`runtime`, `dispatcher`, `tag`, `administration`, `diagnostics`, `playback`, `timeout`,
`preservation`, `publication` and `standalone`. In particular, standalone verified
native tag onboarding/rename, saved assignments, rejected old requests, captured HA
HTTP paths with no automation-configuration fetches, app-stopped script execution,
remembered enabled/disabled process restarts and no replay. Distribution verified
the pinned 0.1.3 → canonical archive upgrade preserving entry/publisher/history/
snapshot/fence and recovery guards. Administration and publication retain the
separate authorization, uncertainty and stopped-work reconciliation scenarios.
These results complement the prior-app database upgrade and recovery harness above;
they do not turn fixture results into actual HA evidence.

The following upstream identities were independently compared with the preparation
records; every `requirements_match_upstream` result was true. The dependency hash
identifies the complete captured installed-distribution list in `dependencies.json`.

| Core | Upstream source commit | Prepared lock SHA-256 | Installed dependency-list SHA-256 |
|---|---|---|---|
| 2026.10.3 | `1f214b8461dd1fbbd66e10765c6905f49d3c1d86` | `5441384af6164e53b836895803e8b44db3d07e02b4512ab8450eeea5b1354336` | `03e09c205e9536c75dfa16cf2cc1f3a740a9197dc8f7a2403d4108103b48d73e` |
| 2026.10.4 | `357cae5c598dfcd7a0ea7dc5b1facccd4ec6037b` | `ed8a19f372bfdb7997a12483803bcf175f1bb8f5d07c2727e8686cde39c7978e` | `3d0d0e1f92edca4f31914e3e53180df7d7d805725a91ae3d18b1a7f27fc8797c` |
| 2026.11.0b0 | `0c0eec0038d643e536884ea8d0bf9cd26c87701e` | `54c802b9d0340f51942638179ea7404bc685afa29815267ee3fcc26e6084ecee` | `f72c5d98f082061e329d494eb19e170f8547c827db13bd687da7e818810e121d` |

Exact successful matrix commands, after sourcing the pinned tool environment above:

```sh
python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python \
  --baseline-python /tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python \
  --archive /tmp/jukelet-issue51-artifact/jukelet-bridge-0.1.5.zip \
  --output /tmp/jukelet-issue51-tester/ha-2026.10.3
python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-issue51-ha-2026.10.4/venv/bin/python \
  --baseline-python /tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python \
  --archive /tmp/jukelet-issue51-artifact/jukelet-bridge-0.1.5.zip \
  --output /tmp/jukelet-issue51-tester/ha-2026.10.4
python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-issue51-ha-2026.11.0b0-ready/venv/bin/python \
  --baseline-python /tmp/jukelet-issue51-ha-2026.10.3/venv/bin/python \
  --archive /tmp/jukelet-issue51-artifact/jukelet-bridge-0.1.5.zip \
  --output /tmp/jukelet-issue51-tester/ha-2026.11.0b0
```

Use fresh owned output directories to repeat them. Local evidence is
`/tmp/jukelet-issue51-tester/ha-VERSION.json` for exact command/exits/times and
`ha-VERSION/result.json`, `dependencies.json`, `dependency-check.log` and each
named probe log for imported Core/Python paths, artifact/per-file identities,
probe-source hashes and outcomes. `upstream-identity.json` records the comparison;
`discovery-result.json` records discovery. The tested backend, integration,
configuration and packaging remain identical to source
`6ea31d55f0fb4ba3fe7af605a594172d8a3ddb2c`. Subsequent frontend and probe changes have
the separate correction evidence above; this initial matrix does not verify those
later changes or browser behavior. The final independent matrix above verifies
the corrected probes; fresh review and hosted checks remain pending at this cutoff.

## Separate HA decommission procedure — additional authorization required

This repository change performs no household inspection or deletion. Removal of an
old tag-trigger automation and any exclusively owned helpers is a separate change:

1. Obtain scoped read authorization and inspect references to the selected old
   automation and candidate helpers using supported HA facilities. Include tag
   triggers, scripts, scenes, dashboards, other automations and restart behavior.
   Produce a concrete reference/change list. Never dump entire private configuration.
2. Identify and retain the active configured playback script and **every shared
   dependency**, including nested preparation, account activation, receiver power,
   transfer/readiness helpers and integration entities. Sharing or uncertain
   ownership excludes a helper from deletion until resolved.
3. Create protected, coherent full HA backups (including config entries and all
   companion snapshot/history/fence/activation stores), consistent app SQLite backups,
   and portable native exports where useful. Retain recovery keys privately. Record
   exact identities/counters and the intended disabled/enabled choices. Follow the
   existing restore-testing waiver; having backups is not proof that they restore.
4. Prepare the exact deletion list, supported HA operation for each item, independent
   readback checks, maintenance order and rollback plan. Obtain **explicit deletion
   authorization** for that list. Repository/upgrade permission does not authorize
   deleting an automation, helper or script.
5. Stop admission/publisher activity as the approved plan requires, read back stopped
   state, and separately establish all nested/external work stopped where relevant.
   Perform only the authorized supported UI/API/configuration operations; never edit
   HA `.storage`. Independently verify removed references and preserved dependencies.
6. Before any resumed dispatcher, verify exactly one intended dispatcher can run,
   including after restart. Restore/rollback must reconcile current app authority and
   monotonic history. **Old backups can restore a competing dispatcher and an old
   automation mapping is not the current assignment master.** Never blindly re-enable
   that stale automation as a recovery shortcut. A coherent supported restore may
   also restore a remembered enabled choice; plan admission control before restore.

No new household restore, HA OS/Supervisor, physical reader, receiver/Spotify or
power-loss test is claimed. The [restore-testing waiver and prior limitations](20-controlled-migration.md)
remain unchanged. Actual synthetic HA script captures establish invocation/completion
contracts only, not physical playback.
