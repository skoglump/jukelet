# Home Assistant compatibility and integration 0.1.3

Policy date: **2026-10-25**, issue [#48](https://github.com/skoglump/jukelet/issues/48).
This prepares integration **0.1.3**; it does not publish an integration release,
update the separately versioned app, or change a household deployment. The existing
0.1.2 archive/source and earlier production reports remain historical evidence.

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
Core4 flow-manager probes confirm that this uses the manager's own result builder,
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
python3 scripts/package_integration.py --ref REVIEWED_COMMIT --output /tmp/jukelet-ha-archive
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

## Dated evidence for this change

Current discovery on **2026-10-25** found stable **2026.10.4** and **no upcoming
beta available**. This is metadata discovery, not a beta test. Both exact stable
versions require Python **>=3.14.2**; their official source `.python-version` is
**3.14.9**, used by the newly prepared Linux environments. Each follows its own
unmodified upstream dependency requirements.

| Core | Python / platform | Archive / result |
|---|---|---|
| 2026.10.3 (minimum) | 3.14.9 / Linux x86-64 | Current source awaits independent verification; earlier candidate evidence below is provisional |
| 2026.10.4 | 3.14.9 / Linux x86-64 | Same current candidate, awaiting independent verification; earlier evidence below is provisional |
| Future stable release with present contracts | Its upstream-required environment | Expected compatible, **not tested** until a dated passing run |
| Upcoming beta | Not available at discovery time | **Not available / not run** |
| Dev / other platform | Unexercised | **Untested / unsupported experimental** |
| Known incompatible stable exclusions | None declared | Required-contract failures still refuse operation |

Initial development evidence is retained under
`.workflow/2026-10-25-issue-48/evidence/implementer/`. The byte-identical provisional
candidate2 archive SHA-256
`94507bb02a1af24bd260566c1771cffb1c0b09fcf3c7a5d575c2452383a38319`
(source in an isolated synthetic Git repository
`33772ae8981856528353c8e9f0d887e253e6926e`, runtime tree
`7bde8a6a8c3f8471346b514a97c81e51152572ad`) passed actual isolated distribution,
lifecycle/restore, dispatcher, native-tag, administrator, diagnostics, playback,
timeout and preservation probes on both Core 2026.10.3 and Core 2026.10.4. App publication/migration
were still running at this evidence freeze. Subsequent typed-preflight return and
flow-import/preflight changes mean this is **not the final artifact's evidence**.
Independent verification and committed-source archive results must replace the
pending rows before the change is considered complete. The local actual Core 2026.10.3
administration probe on current working source passed separately.

`PATH=/tmp/jukelet-issue32-tools:/tmp/jukelet-issue32-tools/node-v24.22.1-linux-x64/bin:$PATH UV_CACHE_DIR=/tmp/jukelet-issue48-uv-cache make check build`
completed with exit0 on the current implementation: 13 historical spike + 78
supported companion + 244 backend + 80 frontend tests; companion/backend mypy,
Ruff lint/format, ESLint/types, Python wheel/sdist and Vite builds passed.
`/tmp/jukelet-issue48-actionlint/actionlint .github/workflows/ha-compatibility.yml`
and working/staged Git whitespace checks passed. These local results are separate
from future hosted PR/scheduled executions.

Independent candidate3 testing passed the earlier eleven actual HA probes but
found additional required-symbol gaps: `probatio.Optional`/`In` and
`HomeAssistantError` were not assessed, and rejection depended on `ConfigEntryError`.
The focused correction adds cold refusal regressions and the complete directly
used schema/error checks, with logging-based rejection that requires no HA error
helper. Current source passed actual isolated Core4 cold/warm negative checks;
the corrected immutable archive still requires independent verification. Earlier
candidate3 successes do not establish acceptance for this correction. Subsequent
candidate4 verification passed twelve probes on both actual Cores, but fresh review
found awaited-API mode and actual presentation-keyword omissions. The second focused
correction adds fresh-config differential regressions for these exact gaps and
safe native abort fallback. Its current-source cold/warm Core4 checks pass; the
corrected immutable archive remains pending independent verification and fresh review.
The final focused correction extends invocation-mode validation to every required
API group, not just flows, and bounds oversized version parsing. Fresh-config
cold/warm Core4 regression evidence covers these cases; exact corrected-archive
verification and fresh review remain separate gates.

This matrix concerns integration code compatibility. It is not an upstream
security audit: existing [Core dependency/security limitations](28-ha-2026-10-3-upgrade.md#exact-scope-and-security-disposition)
remain explicit, including the previously reported upstream-pinned Pillow
advisories. Do not override HA pins to manufacture a green run or call a passing
probe a security-clean certification. No HA OS/Supervisor, rendered HA frontend,
hardware power-loss, real reader, receiver/Spotify or production update is proved.
Synthetic future-version/fault tests, actual isolated HA processes with synthetic
state, and earlier owner-attributed production reports are separate evidence.
The household restore-testing waiver is unchanged.

## Installation, upgrade and failure repair

Follow the complete-directory, protected-backup and exact readback steps in the
[distribution guide](24-integration-distribution.md#supported-ha-upgrade). Existing
Core 3/companion 0.1.2 installations can replace the complete integration with the
reviewed 0.1.3 archive while retaining config entry, publisher and companion Stores.
Verify loaded 0.1.3/source and every installed file hash before updating Core; use
the **same archive** across compatible stable updates. A Core-only update does
not require reinstalling the integration when its contracts remain compatible.

After every restart, inspect fresh status/readiness. Dispatch remains **disabled**.
Retain the legacy-disabled review, separate stopped-work reconciliation when
uncertain, and separate explicit enable. An update never replays an old scan or
resumes uncertain playback. Pairing/publication/readiness/enabled are not playback
verification. Do not reset UUIDs/counters/history, edit `.storage`, partially
restore stores, or downgrade code over newer state to bypass compatibility errors.
On an incompatible or untested update, keep both dispatchers/publisher activity
stopped, preserve backups/evidence, check the dated failing contract and use a
reviewed compatible pair or coherent supported restore under separate authority.
