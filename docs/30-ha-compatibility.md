# Home Assistant compatibility and integration 0.1.3

Current prepared app 0.1.0-rc.3/integration 0.1.5 retire automation migration;
see [current compatibility, upgrades and decommission boundaries](32-migration-retirement.md).
Dated evidence below retains its original source and version scope. Current probe
selection uses `standalone` instead of the historical `migration` rehearsal.

For the accepted HA OS add-on direction, see the [transition support targets and
verification matrix](33-ha-addon-transition.md#support-targets-and-verification-matrix).
Its OS/Supervisor/architecture gates are additional to this Core compatibility
policy; no add-on or household support is inferred from the dated Core-only runs.

Policy date: **2026-10-25**, issue [#48](https://github.com/skoglump/jukelet/issues/48).
This prepares integration **0.1.3**; it does not publish an integration release,
update the separately versioned app, or change a household deployment. The existing
0.1.2 archive/source and earlier production reports remain historical evidence.

For companion **0.1.4**, the policy below is retained; use its separate
[exact artifact, restart behavior and verification record](31-remembered-dispatch.md).
The 0.1.3 matrix remains specific to the older archive.

## Support policy

The minimum is **Core 2026.10.3**. This is the existing preferred baseline and
avoids carrying the old Core 2 installer transition into the new support policy.
It is an API compatibility floor, not a claim that every dependency in that Core
is secure. Core 2 installations need the existing 0.1.2 companion-first transition
to Core 3 before installing 0.1.3. Do not patch historical version gates.

| Core / observation | Classification and action |
|---|---|
| An exact archive/Core/Python/platform pairing with dated successful actual isolated results | **Tested**, within the recorded scenarios/platform; inspect the latest result before updating |
| Stable patch or monthly release at/above 2026.10.3, required contracts present, no documented exclusion | **Expected compatible**; exact patch numbers are not an allowlist. Without dated passing evidence it is not verified. Preserve backups and review new HA breaking changes |
| Beta (`YYYY.M.0bN`) or dev (`YYYY.M.P.devN`) at/above the floor | **Untested / experimental**, unsupported for household operation. May load with a warning when contracts pass so the same archive can be exercised as early warning. Even a passing beta run does not certify the later stable release |
| Missing or incompatible required API; reproduced version-specific exclusion | **Known incompatible** for that observed contract/release. Refuse setup/pairing before companion writes. Keep evidence and use a tested pair; do not delete stores or reset pairing |
| Core below 2026.10.3 | **Below minimum**, refused; follow the supported transition rather than editing version markers |
| Non-string, whitespace/local suffix, oversized (>128 characters), malformed calendar version, unsupported prerelease syntax or unknown config-entry/schema/protocol version | Refused; retain last-good state and obtain a supported release/contract |

No version-specific stable exclusion is currently declared. Future exclusions must
name the reproduced release, bounded failing contract and public tracking issue;
they require a new integration identity when runtime behavior changes. A newly
observed CI failure is not permission to add a blanket future-version block.
There is no rolling maximum that needs a monthly source edit. Raising the minimum
requires a documented API/security reason, a new integration version, upgrade
instructions and actual baseline testing. Compatibility with every future HA
release is **not promised**.

HA's [monthly release and preceding beta cycle](https://contributors.home-assistant.io/releases/how-it-works/)
and [deprecation guidance](https://contributors.home-assistant.io/releases/guides/deprecations/)
motivate recurring checks. Operator backups and reviewed upgrade/recovery remain
necessary even when a compatibility run passes.

## Runtime checks and feedback

Both setup and pairing call the same read-only version/API assessment **before**
initializing a bridge or writing pairing/history. Entry setup checks again before
opening the companion stores. Failures name a bounded contract and link this
matrix in the HA setup log or pairing/options abort; beta/dev loads emit a warning.
The additive admin-only WebSocket command `jukelet_bridge/compatibility` returns
`core_version`, `state`, `allowed`, `reason`, `minimum` and `evidence_url`. Existing
strict v1 status/snapshot/diagnostics responses are unchanged. A runtime version
string never returns `tested`; only the dated artifact-specific results establish
that classification.

| Dependency / required contract | Preflight and actual semantic evidence |
|---|---|
| ConfigFlow / OptionsFlow and config-entry lifecycle | Bind actual form/menu/abort/creation keyword combinations, including schemas/errors/placeholders. Require declared coroutine mode for awaited unique-ID/reload APIs and synchronous mode for non-awaited flow helpers. The executor-job API intentionally returns a Future and is checked separately. Actual clean pairing, existing-history reattachment, admin options and confirmation/recovery probes |
| WebSocket command registration/decorators and ActiveConnection | Check synchronous registration, admin/response/schema decorators and result/error calls, including declared callable-wrapper mode. Actual authenticated/non-admin refusal and administration/concurrency probes |
| Companion-owned `Store` | Require synchronous construction with atomic/private keywords, coroutine save/load and path support. The synchronous executor callback returns an awaitable Future; real readback probes establish that return behavior. Actual fresh disk readback, process restart/crash, degraded history/quarantine and coherent Core API/startup restore probes |
| Tag event lifecycle | Require synchronous event subscriptions/marker callbacks and the shutdown/CoreState values. Actual `tag.async_scan_tag` producer shape into installed integration, exact opaque IDs and malformed event denial |
| HA script service completion | Require coroutine service call with `blocking=True, return_response=True`, plus synchronous service/state lookups. Actual inert HA scripts exercise correlated v1 completion, busy/duplicate, timeout, partial/failing/uncertain work and recovery fences |
| Schema validation (`probatio`) | Require synchronous constructors/declared callable validators for `Schema`, `All`, both `Required`/`Optional` call forms (including `default`) and `In` before registering any command. Existing strict protocol/config-entry/history/execution validation remains authoritative |
| Runtime imports / error handling | Require a valid `HomeAssistantError` exception class before pairing can create history. Annotation-only HA symbols are type-only imports; rejection logs and returns false without depending on `ConfigEntryError`. Unknown config-entry versions log bounded repair guidance |

The cold compatibility probe additionally removes/invalidates required schema,
error and flow symbols, swaps coroutine/synchronous modes, and narrows presentation
keyword signatures, exercising setup, confirmed first pairing, entry setup and recovery
refusals before any companion store or partial command registration. Warm probes
compare existing paired data/history/snapshot/fence across the same refusals. The
new compatibility read command is exercised with both generated admin and non-admin
users; it does not change the v1 status contract.

If a flow's abort/presentation API is incompatible, refusal first validates the
abort helper instead of invoking the known-bad callable. It uses HA's supported
`AbortFlow` facility when that helper cannot produce an actionable result. Actual
Core 2026.10.4 flow-manager probes confirm that this uses the manager's own result builder,
without recursively calling the broken flow helper. If both the flow helper and
HA's `AbortFlow` machinery are unavailable, Jukelet logs the bounded repair reason
and raises a bounded setup failure before writes. HA may then be unable to render
an abort result; inspect its log and use a compatible pair. Base flow classes,
callbacks or loader machinery disappearing can likewise prevent HA's own loader
from creating a flow. No raw HA result or storage data is fabricated to bypass
those framework failures.

Every required external invocation selects an explicit synchronous, coroutine,
synchronous-constructor or Future-returning callback contract. The raw argument
binder is not used as a capability decision by itself. Declared async callable
objects and constructor initializer/metaclass modes are considered deliberately;
method names beginning `async_` do not establish a coroutine contract. Return-value
semantics beyond those structural checks remain established by the actual probes.

Callable/signature checks detect removed or changed interfaces; they cannot prove
future semantic compatibility. The CI probes supply that evidence. Fragile seams
include the current HA validator/decorator API, config-flow `_async_current_entries`
(whose ignored-entry behavior is preserved), Store atomic-write keywords and
`Store.path`/HA's quarantine-file naming used to avoid treating damaged evidence as
first install. These are deliberately bounded and tested, not silently replaced by
raw `.storage` edits. HA script/entity state alone still cannot establish that
nested or detached external work stopped. No playback, account or service allowlist
is expanded by compatibility assessment.

## Reproduce with one archive

Use the repository's Python 3.14.9/uv 0.13.5 setup and locked backend environment.
The preparation command fetches each exact Core wheel's dependency/Python metadata,
resolves the official source tag and reads that commit's `.python-version`; it
installs that interpreter and upstream dependencies without overrides. It records
the generated lock, upstream source/wheel hashes and environment manifest. Historical
locks and prior evidence are preserved.

```sh
python3 -m scripts.ha_compatibility discover --output /tmp/jukelet-ha-discovery.json
python3 -m scripts.ha_compatibility prepare --version 2026.10.3 --root /tmp/jukelet-ha-minimum
python3 -m scripts.ha_compatibility prepare --version 2026.10.4 --root /tmp/jukelet-ha-stable
python3 scripts/package_integration.py --ref f9e46d8e4b50f6dcd7cba263efea63c6d1d1e607 --output /tmp/jukelet-ha-archive
python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-ha-minimum/venv/bin/python \
  --baseline-python /tmp/jukelet-ha-minimum/venv/bin/python \
  --archive /tmp/jukelet-ha-archive/jukelet-bridge-0.1.3.zip \
  --output /tmp/jukelet-ha-minimum-result
python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-ha-stable/venv/bin/python \
  --baseline-python /tmp/jukelet-ha-minimum/venv/bin/python \
  --archive /tmp/jukelet-ha-archive/jukelet-bridge-0.1.3.zip \
  --output /tmp/jukelet-ha-stable-result
```

Choose new owned output/environment paths; commands refuse existing output roots.
They accept no HA URL, existing configuration or credentials. The supplied verified
archive is installed into every probe's fresh configuration; playback-only adapter
probes also import their transport/adapter directly from that installed archive.
Historical 0.1.2 source `7536402599f33b46f84858f22d8b1b1394aabae6`
is installed unmodified under Core 3, seeded with generated state, then replaced
with the archive under Core 3 and restarted under the selected target Core. Healthy,
uncertain and damaged-history scenarios compare exact config-entry data, publisher,
revision/checksum, history, fence, profile and timeout. No actual household state is
used. Restarts leave dispatch disabled; uncertain work is never replayed.

Each run writes `result.json`, per-probe logs, actual imported Core/Python/module
identity, complete resolved dependencies with a SHA-256, probe source hashes and
the archive source/tree/per-file/checksum manifest. `uv pip check` must succeed.
A timeout/dependency/probe failure is a failing run, not a supported pairing.

## Automatic results and how to check an update

[HA compatibility Actions](https://github.com/skoglump/jukelet/actions/workflows/ha-compatibility.yml)
runs on ordinary PRs, daily at 06:37 UTC and manually. It discovers the latest
non-yanked stable wheel from PyPI and the highest available beta for the next
calendar month; older betas/dev packages are not substituted. No upcoming beta is
reported **not available**, never as a passing test. Minimum 2026.10.3 and immediate
upgrade case 2026.10.4 remain in the deduplicated matrix. An available beta runs the
same full probe suite as an early-warning job; failures remain visible.

The standalone manager probe's healthy-enabled restart case waits for observed
idle dispatch, a clear execution fence and ready/enabled state before stopping HA.
A script capture or `dispatch_enabled` alone does not prove completion of the
dispatcher and its persistence work. The bounded check fails on unfinished work,
settled uncertainty or lost readiness; it never reconciles or re-enables dispatch.
In-flight/uncertain shutdown keeps the separate conservative restart guard.

One archive is built and verified in the preparation job and passed byte-for-byte
to all matrix jobs. A PR tests its exact checkout commit. Scheduled/manual runs
by default reproduce the last commit changing integration runtime, the package
builder or LICENSE; docs/test-evidence-only changes therefore retain the same
immutable archive identity. Manual `integration_ref` can select a reviewed exact
commit/tag; the resolved full commit is recorded and its own builder is used.
Changes to integration code/packaging require a new version. Refreshing evidence
alone does not require a new source version or replacement archive.

Inspect the run date, discovered targets, result/exit status, exact archive checksum
and Core/Python identity in the job summary and `ha-compatibility-*` artifacts
(retained 90 days). A historical green row is not proof for a newer patch or a
different archive. Expired/missing artifacts mean evidence unavailable; rerun the
manual workflow for the same immutable source. Failures remain red and retain
available setup/probe logs, including unresolved upstream installation failures.
No automated commits, release assets, tags or deployments are made.

## Dated canonical verification — 2026-10-25

**Tested:** the exact same prepared integration **0.1.3** archive passed all twelve
actual isolated HA probes on **Core 2026.10.3 and 2026.10.4**, using **Python 3.14.9,
Linux x86-64**, without rebuilding between Core versions. The independent runs
finished at **2026-10-25T18:51:31.069987Z** and
**2026-10-25T18:51:42.947802Z**, respectively. Each imported Core
version matched its distribution metadata and intended environment/module path.
Each environment followed its official source `.python-version` and unmodified
upstream requirements (`Requires-Python >=3.14.2`); dependency consistency passed.

| Canonical artifact field | Exact identity |
|---|---|
| Archive | `dist/integration/jukelet-bridge-0.1.3.zip` |
| Repository/source commit | `f9e46d8e4b50f6dcd7cba263efea63c6d1d1e607` |
| Component Git tree | `697e42893ab639302e605dc133c2b621773934f3` |
| Archive SHA-256 | `f08fae96954966fa2db96511e3a9f93584137175cc217cd93e68dc0041181403` |
| Archive members | 15: reviewed runtime, generated `build_info.json` and committed MIT `LICENSE` |
| Integrity/per-file hashes | `dist/integration/jukelet-bridge-0.1.3.zip.manifest.json` and `dist/integration/jukelet-bridge-0.1.3.zip.sha256` |

An independent rebuild from that real repository commit was byte-identical.
Actual install/upgrade processes read back the loaded version/source and every
installed member hash against that manifest. This source stays pinned after
later documentation commits: `make integration-package` packages its current
HEAD and would change `build_info.json` and archive bytes. Use the exact `--ref`
above to reproduce this checksum. No integration tag, release or package has
been published by this work.

Fresh discovery at **2026-10-25T18:46:44.456196Z** found latest stable
**2026.10.4** and **no upcoming monthly beta available**. Absence is **not available /
not run**, not a passing beta result.

| Environment | Classification / result |
|---|---|
| Core 2026.10.3 (minimum), Python 3.14.9, Linux x86-64 | **Tested — PASS**, same canonical archive, 12/12 probes, dependency check exit 0 |
| Core 2026.10.4 (current stable), Python 3.14.9, Linux x86-64 | **Tested — PASS**, same canonical archive, 12/12 probes, dependency check exit 0 |
| Later stable releases with required contracts and no exclusion | **Expected compatible**, not tested until an exact dated passing result exists |
| Upcoming monthly beta | **Not available / not run** at this discovery time |
| Dev releases or other platforms | **Untested**; beta/dev remain unsupported experimental targets |
| Known incompatible stable exclusions | None declared; observed required-contract failures still refuse operation |

Both exact canonical runs executed these probes with exit 0:

| Probe | Core 2026.10.3 | Core 2026.10.4 | Exercised boundary |
|---|---|---|---|
| `compatibility` | PASS — 71 cases, 0 failures | PASS — 71 cases, 0 failures | Fresh-config API/mode/schema/flow/exception/version faults; bounded refusal before writes or partial handlers |
| `distribution` | PASS | PASS | Packaged clean install, exact historical 0.1.2 upgrade, loaded/installed hashes, healthy/uncertain/damaged history; Core3-to-Core4 transition in the Core4 run |
| `runtime` | PASS | PASS | Pairing, persistence/restarts/crashes, concurrent publication, quarantine/recovery, coherent synthetic Core API/startup backup restore |
| `dispatcher` | PASS | PASS | Inert admission/busy/duplicate/completion/uncertainty/restart fences and guarded recovery |
| `tag` | PASS | PASS | Actual native HA tag producer, opaque IDs and malformed envelopes |
| `administration` | PASS | PASS | Actual administrator options/confirmations/readback and separate readiness/enable/reconciliation |
| `diagnostics` | PASS | PASS | Read-only bounded status and failure inspection |
| `playback` | PASS | PASS | Inert HA script request/completion contracts; no receiver or Spotify playback |
| `timeout` | PASS | PASS | Local timeout configuration/readback and uncertain completion handling |
| `preservation` | PASS | PASS | Synthetic script ordering/preferences and bounded readiness behavior |
| `publication` | PASS | PASS | App/HA publication, lost acknowledgment, restart/restore and recovery guards |
| `migration` | PASS | PASS | Isolated synthetic migration procedure and rollback/recovery guards |

The distribution checks preserve exact config-entry ID/data, current publisher,
revision/checksum, history, execution fence, profile and timeout. Warm API faults
use actual HA FlowManager and compare the same state before/after refusal. All
restarts remain **dispatch-disabled**, uncertain work is never replayed, and
readiness/legacy-disabled review/stopped-work reconciliation/separate enable remain
explicit. Authentication, origin/admin/confirmation boundaries, service allowlists,
strict v1 responses, malformed-data and concurrent-edit guards remain intact.

### Environment provenance

| Core | Official source commit | Environment lock SHA-256 | Actual dependency-list SHA-256 |
|---|---|---|---|
| 2026.10.3 | `1f214b8461dd1fbbd66e10765c6905f49d3c1d86` | `5320684f9ab230307469197c72ca6d924a506609f6f3c4b30a0e5687695aede2` | `aad44320ea20702619ee2de6c1ea96fc1cc3c2be6ff55424f2b89a403645417b` |
| 2026.10.4 | `357cae5c598dfcd7a0ea7dc5b1facccd4ec6037b` | `f0795e5514494e08a40fb5cd39e745498c4a88bcd163d60d591999b90b5177f2` | `4dffdeebb10d0c4c7dbb60bed39ba8a44b6b1deededb27cb42924325ad0e6bd2` |

The generated environment manifests/locks are at
`/tmp/jukelet-issue48-ha-2026.10.3/{environment.json,requirements.txt}` and the
corresponding `2026.10.4` directory. Canonical `core3/result.json` and
`core4/result.json` below retain imported Core/Python/module/executable identities,
resolved dependencies, probe-source hashes and the complete artifact manifest;
`dependencies.json` contains the hashed dependency list. The independent upstream
metadata/Requires-Dist comparison is retained in
`.workflow/2026-10-25-issue-48/evidence/tester/upstream-environments.json`.

### Commands, independent checks and evidence

Local evidence root: `.workflow/2026-10-25-issue-48/evidence/`. These ignored files
are retained working evidence, not installed runtime or production exports.
The canonical tester's `check-ledger.json` and per-command JSON record complete
executable arguments, environment overrides, times and exits. The actual matrix
commands used one unchanged absolute archive path:

```sh
/tmp/jukelet-issue32-tools/python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-issue48-ha-2026.10.3/venv/bin/python \
  --baseline-python /tmp/jukelet-issue48-ha-2026.10.3/venv/bin/python \
  --archive /home/sebastian/Projects/jukelet/dist/integration/jukelet-bridge-0.1.3.zip \
  --output .workflow/2026-10-25-issue-48/evidence/canonical-tester/core3
/tmp/jukelet-issue32-tools/python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-issue48-ha-2026.10.4/venv/bin/python \
  --baseline-python /tmp/jukelet-issue48-ha-2026.10.3/venv/bin/python \
  --archive /home/sebastian/Projects/jukelet/dist/integration/jukelet-bridge-0.1.3.zip \
  --output .workflow/2026-10-25-issue-48/evidence/canonical-tester/core4
/tmp/jukelet-issue32-tools/python3 -m scripts.ha_compatibility discover \
  --output .workflow/2026-10-25-issue-48/evidence/canonical-tester/discovered-releases.json
```

All three commands exited 0. The tester supplied uv 0.13.5 through its task-tool PATH
and a separate `/tmp/jukelet-issue48-tester-uv-cache`; exact overrides are recorded
in `canonical-tester/ha-core3.json` and `ha-core4.json`.

| Check | Actual result | Evidence beneath the local evidence root |
|---|---|---|
| Exact canonical Core3/Core4 runner commands above | PASS, exit 0 each, all 12 probes each | `canonical-tester/check-ledger.json`, `canonical-tester/core3/result.json`, `canonical-tester/core4/result.json` and per-probe logs |
| Independent `package_integration.build` from pinned source, byte comparison and verifier | PASS; all 15 members/source/installed hashes, byte-identical rebuild | `canonical-tester/parity-rebuild.json`, `canonical-tester/rebuild/` |
| Exact discovery command above | PASS, exit 0; stable 10.4, beta unavailable | `canonical-tester/discovery-command.json`, `canonical-tester/discovered-releases.json` |
| Independent `make backend-check` | PASS, exit 0: 13 historical + 79 supported companion + 244 backend tests, companion/backend mypy (21/55 files), Ruff lint/format | `correction3-tester/backend-check.log`, `correction3-tester/check-ledger.json` |
| Independent all-group mode/parser regressions against installed archive | PASS, exit 0: 23 fresh-config faults plus parser boundary cases | `correction3-tester/independent-all-groups.json` and `correction3-tester/independent-all-groups.log` |
| Frontend lint/types/80 tests; wheel/sdist/Vite builds; local image and isolated Chromium smoke | PASS retained by exact unchanged source/config applicability, not redundantly rerun for a companion-only identity change | `tester/frontend-build.log`, `tester/image.log`, `tester/smoke.log`; `correction3-tester/artifact-app-evidence-applicability.json` |
| Workflow Actionlint and working/staged/complete-task Git whitespace checks | PASS, exit 0 | `reviewer3/checks.json`, `canonical-tester/check-ledger.json` |

The initial unchanged frontend Recovery focus assertion failed during an earlier
`make check build` (`tester/check-build.log`). No frontend/test fix was made;
isolated 3/3 and later complete 80/80 frontend checks and both builds passed.
That failure and the successful reruns remain separate evidence. Historical failed
or superseded development archives/logs are preserved locally and are not the
canonical identity above.

The independent corrected-implementation tester reported **PASS** and the fresh
implementation reviewer reported **APPROVED** (`correction3-tester/handoff.md`,
`reviewer3/review.md`). The canonical tester then reported **PASS** for the real
committed-source archive (`canonical-tester/handoff.md`). Final documentation
review and hosted PR execution were still pending at this local evidence cutoff;
this report does not claim hosted PR/scheduled/manual runs or release publication.
Use the Actions link above for subsequent dated hosted results.

This is integration code-compatibility evidence, not an upstream security audit.
Existing [Core dependency/security limitations](28-ha-2026-10-3-upgrade.md#exact-scope-and-security-disposition),
including previously reported upstream-pinned Pillow advisories, remain explicit.
No upstream pin was overridden to obtain a passing result. Actual isolated HA
processes used generated state/credentials and inert services. Synthetic
future-version and fault cases are **not actual future/beta HA tests**. Earlier
owner-attributed production reports, HA OS/Supervisor, rendered HA frontend,
hardware power-loss, physical readers, receiver/Spotify playback and household
restore are separate or unexercised. The household restore-testing waiver is
unchanged. No compatibility with every future HA release is promised.

## Installation, upgrade and failure repair

Follow the complete-directory, protected-backup and exact readback steps in the
[distribution guide](24-integration-distribution.md#supported-ha-upgrade). Existing
Core 3/companion 0.1.2 installations can replace the complete integration with the
reviewed 0.1.3 archive while retaining config entry, publisher and companion Stores.
Verify loaded 0.1.3/source and every installed file hash before updating Core; use
the **same archive** across compatible stable updates. A Core-only update does
not require reinstalling the integration when its contracts remain compatible.

After every restart, inspect fresh status/readiness. The historical 0.1.3 archive
leaves dispatch disabled. Companion 0.1.4 remembers a reviewed enabled/disabled
choice and restores enabled dispatch only after healthy matching startup checks;
see the [current controls](23-guarded-playback-controls.md). Fresh installation,
recovery, changed configuration, failed readiness or uncertain execution still
require manual review. Retain the legacy-disabled review, separate stopped-work
reconciliation when uncertain, and explicit enable when paused. An update never replays an old scan or
resumes uncertain playback. Pairing/publication/readiness/enabled are not playback
verification. Do not reset UUIDs/counters/history, edit `.storage`, partially
restore stores, or downgrade code over newer state to bypass compatibility errors.
On an incompatible or untested update, keep both dispatchers/publisher activity
stopped, preserve backups/evidence, check the dated failing contract and use a
reviewed compatible pair or coherent supported restore under separate authority.
