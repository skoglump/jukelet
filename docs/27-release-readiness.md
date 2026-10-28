# Release hardening, evidence and candidate notes (#32)

Current prepared app 0.1.0-rc.3/integration 0.1.5 retire automation migration;
see [current compatibility, upgrades and decommission boundaries](32-migration-retirement.md).
Dated evidence below retains its original source and version scope. Current probe
selection uses `standalone` instead of the historical `migration` rehearsal.

Current prepared integration 0.1.3 uses the [minimum/forward policy and dated matrix](30-ha-compatibility.md). Version-specific observations below retain their original historical scope; they do not redefine the current policy.

## Historical status (2026-10-25)

App **0.1.0-rc.2** (`0.1.0rc2` in Python) is now prepared in source; it is
**unpublished and undeployed**. See [candidate notes, evidence and remaining
gates](29-app-0.1.0-rc.2.md). Public RC1 remains frozen. Companion **0.1.2** is
separately installed/versioned and accepts exactly Core **2026.10.2/2026.10.3**;
see the [coordinated upgrade and isolated evidence](28-ha-2026-10-3-upgrade.md).

PRs [#45](https://github.com/skoglump/jukelet/pull/45) and
[#46](https://github.com/skoglump/jukelet/pull/46) merged after independent
verification, fresh review, final committed-source artifact checks and hosted CI.
The pending-review/artifact/CI statements in the historical snapshot below
record its earlier evidence timing; they are not current blockers for those PRs.
RC2 independent precommit verification now passed: full check/build (244 backend,
13 historical + 69 supported companion,80 frontend tests),13 Chromium fixture
workflows, isolated RC1→candidate/guarded SQLite recovery and actual isolated
Core3 app publication. Reproducible version/MIT/privacy/image-content evidence
is recorded in the [candidate report](29-app-0.1.0-rc.2.md#candidate-verification-and-release-gates).
Dependency pins are unchanged; lock application identity is updated. Fresh
review, real task commits/final committed-source artifacts/source-labeled image
and hostedCI exact-head readback remain pending. The precommit local image is
not a published or delivery-source-labeled image. Raw actionlint was not run
(tool absent); unchanged workflows retain the dated validator limitation.

Separately authorized production readbacks verified companion source `7536402`
and retained revision 3 after the owner upgraded Core to 2026.10.3, then resumed
the old app RC1 with **Automatic ON / Jukelet ON / legacy OFF**. The owner reported
playlist and album playback on the intended receiver and one newly seen tag
appearing without interrupting playback. See the [attributed outcomes and
limits](20-controlled-migration.md#october-25-upgrade-resume-and-owner-observations).
These are not production RC2 installation evidence or new independent playback
telemetry. Deliberate different-account takeover remains unperformed; production
restore testing remains waived/unperformed. A fresh post-upgrade full-HA backup
is not confirmed.

Whole-release readiness remains **PARTIAL**. Core3 fixes the identified uv
installer concern, while its upstream-pinned Pillow 12.3.0 retains the dated
37-advisory finding. No HA-wide security certification or dependency override is
claimed. Existing provider/accessibility/security evidence remains dated and
scoped; no platform claim is added.

## Historical PR45 hardening snapshot (2026-10-25)

The remainder records the PR45 candidate before its final review/artifact/CI
completion. Its RC1 app metadata, companion 0.1.1/Core2 fence, evidence hashes and
unperformed-household list describe **that snapshot only**, superseded by the
current status above and linked RC2/upgrade evidence. No tag/release/image/package
publication or household deployment is authorized by release preparation.

## Prerequisite and source state

Preparation fetched `origin/main` at
`83405504997b3936edf463a58a99b65ba6a33495`. #36 diagnostics, #37 guarded HA
controls, #38 integration distribution and #40 publication-focus test fix were
closed and merged through PRs #41/#42/#43/#44. #31 remains **OPEN/PARTIAL**;
PR #35 was merged despite its retained migration evidence gaps. #39 is closed:
the owner supplied its prior private completion summary establishing Automatic
selected and separately activated with fresh independent app/HA readback.
No private operational files or credentials belong in this report.

The app metadata remains `0.1.0-rc.1` (`0.1.0rc1` in Python); the independently
packaged integration is `0.1.1`. This does not repoint the frozen public app RC.
Preparing another app/integration release requires a new immutable identity,
reviewed exact commit and final artifact hashes. No tag/release/image/package
publication, household access or deployment is authorized by this preparation.

## Candidate changes and operator-visible behavior

- Complete app/separate-integration installation, pairing, daily publication,
  readiness/explicit activation, coherent backups, recovery and supported upgrade
  instructions, with current links replacing stale unimplemented-feature claims.
- Spotify metadata and artwork have a fixed-origin link to the applicable album
  or playlist and unmodified official attribution. Artwork keeps its intrinsic aspect ratio within bounded dimensions, with required 4px corners below the app's 1024px large-screen breakpoint and 8px corners from 1024px, without cropping/overlay; the UI explains temporary music data, direct image requests
  and provider disconnection. Lookup failure still preserves saved assignments,
  canonical URIs and available last-good metadata.
- Python distributions carry MIT metadata/license. Frontend bundles carry
  React/React DOM/Scheduler notices and Spotify asset provenance separately from
  MIT. See [third-party notices](../THIRD_PARTY_NOTICES.md).
- The isolated container harness creates synthetic credentials outside the
  checkout, disables implicit Compose environment files and fixes read-only mode.
  Its opt-in lifecycle check exercises the exact frozen RC image → local candidate
  replacement and guarded SQLite recovery, with HA explicitly unconfigured.

Saved, queued/published, verified-active content, dispatch enablement, script
completion and independently verified playback remain distinct. No automatic
dispatch resume, playback retry, credential extraction, broader HA compatibility
or household migration behavior is added.

## Evidence classes and support claims

| Class | Current scope / evidence | Exclusions |
|---|---|---|
| Synthetic fixtures | Backend SQLite/auth/import/provider/publication contracts, historical + supported companion tests, React components, Chromium fixture workflows and local provider HTTP simulation | Not actual HA, provider/account access or household playback |
| Actual isolated HA | Existing probes run owned Core 2026.10.2/Python 3.14.8 Linux processes with generated credentials and inert scripts; archive installation and exact baseline upgrades, pairing/publication/readiness, admin recovery and protected Core restore | Not HA OS/Supervisor, backup UI, real receiver/Spotify, hardware power loss or household restore |
| Browser/container | Linux x86-64/AMD64 local app image, Docker/Compose, real auth/session/persistence/backup/recovery HTTP checks; Chromium desktop and 390px mobile | No household TLS/proxy, other architectures/browsers, native mobile app or complete assistive-technology audit |
| Previously authorized household | Attributed public October 24 #31 report plus October 25 #39 policy outcome; no new access in #32 | Not current-candidate installation, upgrade, restart, fault or restore proof |

Only **HA Core 2026.10.2** is supported by the integration's actual setup fence.
Snapshot/status/history/fence/config-entry remain version 1; diagnostics and script
request/completion version 1. Unknown schemas/versions refuse operation. The
demonstrated integration upgrade origin is exact source
`82d5445ead6574b6f85d70391bc88fd9fe3df3d1` to packaged `0.1.1`, with synthetic
healthy/uncertain/damaged history. A version string `0.1.0` alone is insufficient.
App image replacement uses the frozen RC digest with schema `0004`; no generic
old-schema upgrade, standalone downgrade or cross-version restore is claimed.

## Security and privacy review

| Boundary | Implemented protection and regression evidence | Operator limits |
|---|---|---|
| Authentication/session | `test_auth.py`: protected APIs, HttpOnly/Secure/SameSite=Strict cookies, Origin + CSRF, invalid bodies, expiry, rotation, session replacement, login throttling; container/browser verify persistence, logout and empty browser storage | App secret is shared single-owner authentication. Loopback HTTP is development only; TLS/proxy deployment is separate. Rate limit resets on restart. |
| URL/service access | `test_config.py`, `test_ha_rest.py`, `test_ha_adapter.py`, `test_spotifyplus.py`: fixed configured origin/account, no redirects/environment proxy, bounded deadlines and service allowlist; URI parsing never fetches supplied links | HA credentials have broad admin impact. Protect host/container access; no tag-scoped credential claim. |
| Uploads/imports | `test_legacy_importer.py`, `test_inventory_api.py`, assignment/recovery tests: strict UTF-8/JSON/YAML limits, duplicate keys, no tags/aliases/templates/evaluation; session-bound preview, exact source/revision/optimistic preconditions | Normalized preview reports intentionally retain selected unsupported row fields and exact IDs; treat downloads as private. Never publish an operator export. |
| Artwork/content | `test_spotifyplus.py`, `music.test.tsx` and browser checks: approved HTTPS image hosts, direct browser request/no referrer, CSP, fixed canonical content links; labels render as React text | CDN still receives browser IP. No backend artwork proxy, URL traversal or arbitrary host fetch; no image-content/rightsholder certification. |
| Diagnostics/exports | `test_status.py`, `test_playback_diagnostics.py`, `test_recovery.py`: normalized bounded errors, no raw config/provider response, logical export excludes secrets/session/identity/jobs/cache | Logical export contains IDs, URIs/preferences and informational HA names. Complete DB/HA backups contain private operational state. Redaction is not anonymization of intended mapping exports. |
| Publication/recovery/admin | `test_publication*.py`, companion lifecycle/dispatcher/admin tests and isolated probes: immutable exact-content review, monotonic history, uncertain-write reconciliation, retained guard, explicit admin attestations and fresh readback | No script-off/restart inference that detached work stopped. Incoherent history blocks rather than resets. Independent high-water backup evidence is necessary. |

Source review covers tracked/public source and task additions, fixtures, docs,
build context and generated wheel/sdist/frontend/integration/container contents.
The [BuildKit context probe](../scripts/probe_build_context.py) uses a generated
synthetic context and never reads repository secrets. High-confidence credential
patterns and synthetic-secret artifact/log checks supplement human inspection;
they cannot mathematically prove absence of every possible private value.
Keep wire/debug logging disabled, never dump Compose configuration with secrets,
and never copy a real token/configuration into a fixture to improve a test.

### Provider and privacy review (2026-10-25)

Primary sources checked on this date:

- [Spotify Developer Terms](https://developer.spotify.com/terms), version 10,
  effective 2025-05-15: temporary caching only as needed; keep displayed data
  current and remove obsolete content, with personal-data deletion requirements.
- [Spotify Developer Policy](https://developer.spotify.com/policy), effective
  2025-05-15: attribution, applicable-content backlinks, user transparency and
  control. Metadata/artwork is not a standalone product.
- [Spotify Design & Branding Guidelines](https://developer.spotify.com/documentation/design):
  official logo, content links, original artwork/proportions, 4px small/medium and 8px large artwork corners, no crops/overlays,
  legibility/spacing and bounded browsing.

Jukelet's HA-based access does not itself grant Spotify permissions or exempt an
integration from provider terms. This is a bounded engineering review, not legal
certification, provider approval or a promise of perpetual API access. Accounts,
installed SpotifyPlus capabilities, geographic restrictions, quotas and playback
permissions remain deployment-specific. No Spotify token/OAuth flow is added.

Backend metadata has at most 128 private memory entries, 5-minute freshness and
24-hour last-good retention, with 30–300-second failure backoff and no automatic
retry. Cache scope includes configured origin/account; restart after changing the
account behind an entity. Search/library pages are at most 20, with explicit
paging and offset cap 1000. No library scrape, audio cache or provider-content
export exists. Browser previews are temporary in-memory session data, retained
visibly as stale on failures; reload clears them. Browser and server never write
Spotify metadata/artwork into assignments or portable assignment exports.

Approved image URLs are loaded directly without a referrer; the backend does
not fetch/store images. To disconnect previews, remove `SPOTIFYPLUS_ENTITY_ID`
from protected app configuration, restart, then reload open pages to clear their
preview memory. Saved assignment URIs/preferences remain as owner-authored data.
To revoke upstream access too, use HA/Spotify's account controls separately; do
not read HA credential stores. Private mapping/backups should be deleted by their
owner when no longer needed. The UI exposes these data/disconnect details.

### Dependency and license review

MIT remains the owner-selected project license. Python wheel/sdist metadata now
includes `License-Expression: MIT` and the license file. React, React DOM and
Scheduler copyright/license text is shipped with the frontend; the official
Spotify logo is a separately governed trademark. Dependency and image-base
licenses retain their own terms, not a blanket MIT declaration.

Preparation inspected installed Python metadata (35 distributions including the
app) and all 229 frontend lock entries. Declared frontend licenses: MIT 174,
MIT-0 2, Apache-2.0 20, BSD-2-Clause 8, BSD-3-Clause 3, ISC 7, MPL-2.0 12,
BlueOak-1.0.0 2 and CC0-1.0 1. Python includes permissive/PSF licenses and
MPL-2.0 `certifi`/development `pathspec`; preserve applicable notices/source
obligations when redistributing. Installed metadata/lock declarations are an
inventory, not a transitive legal audit of HA, OS base packages or Spotify content.
The integration declares no pip runtime requirements; it depends on the separately
licensed HA installation. An npm advisory snapshot reported zero known
vulnerabilities; that is time-specific and does not establish a vulnerability-free
release. The installed application Python dependency audit initially found the certifi issue below; after the narrow update, pip-audit reported no known application dependency vulnerabilities. OS/base-image vulnerability scanning and counsel review are unperformed.


### Security patch findings and approved correction

The initial installed-dependency audit found `PYSEC-2026-4320` /
`GHSA-6q48-6c7w-9gw2` in certifi `2026.7.22`: its bundle trusted the affected
emSign ECC Root CA - G3. The old bundle contained that root; updating only the
locked transitive certifi package to `2026.10.23` removed it. The new bundle
SHA-256 is `2ef52ad56b4803e264045c915e55c236cbfa045b84b81efefc218a19eb44bd2b`;
no custom certificate deletion or disabled TLS verification is used. A repeated
application pip-audit returned no known vulnerabilities. The initial failed audit
and pre-update test/image results remain historical evidence, not final passes.
See [upstream certifi correction](https://github.com/certifi/python-certifi/commit/662df63d7906df66f1f07c0751a3dfe9da14d914).

Current primary-source review also identified [uv's advisory](https://github.com/astral-sh/uv/security/advisories/GHSA-hq85-5cpj-mr62)
affecting versions before `0.13.4`, and [Python's security patch announcement](https://blog.python.org/2026/10/python-3151-3149-31317/)
covering the bundled pip correction. The owner explicitly approved updating
application/build/CI tools to Python `3.14.9` and uv `0.13.5`. The same security patch scope updates Node to `24.22.1`; [its official security release](https://nodejs.org/en/blog/release/v24.22.1) addresses the affected trust root and other vulnerabilities. Official image index
digests are pinned: Python slim-bookworm
`sha256:945c2676dc2b18e0c1f16879244122c57c0ffede60006bf3df159c507a31bcae`
and uv `sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff`.
The Node bookworm-slim index is `sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`. The smoke harness also rejects the known compromised certificate fingerprint in actual OS/default, app-certifi and base-pip trust stores. Final checks must run these patched artifacts; older result rows do not prove them.

The isolated HA Core `2026.10.2` lock remains its own exact upstream dependency
set, including uv `0.12.23` and certifi `2026.10.19`. The probes disable integration
dependency installation and use inert owned environments. This is not a security
certification of Core's bundled installer or permission to override its required
versions. Operators must review upstream HA security/update support before a
production release; broadening HA support requires separate actual testing.

### Artwork review correction (round 2)

Fresh review requested one correction: zero-radius artwork did not satisfy the
current primary design guidelines. A fixed 7rem square with `object-fit: contain`
also leaves padding around non-square artwork, so merely rounding that square
would not round the displayed image edges. The correction uses intrinsic width/
height with maximum 7rem/available-width bounds and `contain`, so the actual image
box retains its natural aspect ratio. It applies 4px corners below 1024px and
8px at/above 1024px. This breakpoint is Jukelet's implementation choice for the
guidelines' device categories, not a provider-specified pixel breakpoint.

Two Playwright regressions route only synthetic SVG artwork: a 320×160 landscape
at 390px mobile and a 160×320 portrait at 1280px desktop. They assert natural and
displayed aspect ratios, bounded image size, all four corner radii, no overflow,
canonical link/visible logo outside artwork, keyboard link focus and retained
artwork/attribution through a provider failure. Both failed against the old CSS
with a square displayed image box, then passed after correction. The source
change adds no crop, distortion, overlay, metadata mutation or new network host.
Logs: `artwork-correction-red.log` (exit 1, two expected failures),
`artwork-correction-green.log` (exit 0, two passes), and
`artwork-correction-frontend.log` (exit 0, frontend lint/types/80 component tests/
production build). The independent affected rerun below passed frontend, all 13 fixture-browser workflows, rebuilt container/browser/lifecycle/trust checks and complete source/artifact scans. Actual rendered mobile bounds were 112×56 with 4px corners, desktop 56×112 with 8px corners; independently inspected synthetic screenshots show no square letterboxing/cropping, overlay or horizontal clipping, with attribution below the art and retained through the stale/error state. Another entirely fresh review is pending. Earlier frontend/image evidence stays historical; backend/companion verification remains valid for unchanged inputs.

## Independent verification and refreshed artwork evidence

The independent native tester assessed baseline HEAD
`83405504997b3936edf463a58a99b65ba6a33495` plus all 37 task changes, including
new untracked assets/docs/tests. Every entry of the initial source manifest matched
before and after checks; its SHA-256 was
`bda8ad9b7ece79f0ef3c2e234d2ff31ca207ccd7615f60a14fab536c85215e19`.
The unrelated user documentation was excluded and preserved. A later three-document evidence/contract correction preserved all tested runtime inputs. Fresh review then identified one artwork-corner requirement gap, corrected as described above. Backend, companion, lock, workflow and probe inputs remain unchanged; the initial frontend/browser/image results and image hash are now **superseded for the changed CSS**, and the independent affected checks below refresh the changed frontend/container scope.

Exact tested environment: Linux x86-64, kernel `7.2.11-arch1-1`, glibc `2.44`,
Node `24.22.1`, npm `11.19.1`, Python `3.14.9` (also the backend venv), uv
`0.13.5`, Docker client/server `29.9.2`, Compose `5.6.1`, Playwright `1.64.1`.
**Actual isolated HA** separately used Core `2026.10.2` on Python `3.14.8`.
This does not establish HA support on Python 3.14.9 or another HA platform.

Actual app-check environment exports:

```sh
export PATH=/tmp/jukelet-issue32-tools:/tmp/jukelet-issue32-tools/node-v24.22.1-linux-x64/bin:$PATH
export UV_PYTHON_INSTALL_DIR=/tmp/jukelet-issue32-python
export UV_CACHE_DIR=/tmp/jukelet-issue32-uv-cache
export PLAYWRIGHT_BROWSERS_PATH=/tmp/jukelet-issue36-playwright
```

Logs, full source manifests, artifact inspections and exact scoped handoffs are
retained in `.workflow/2026-10-25-issue32-release/evidence/`. These ignored
working files contain scoped synthetic/read-only evidence, not household
configuration. The table's evidence filenames are relative to that directory;
`tester-verification.md` records full invocations and environment overlays.

| Command / observation | Actual result | Evidence |
|---|---|---|
| `make check build` | Exit 0: 13 historical + 64 supported companion + 244 backend + 80 frontend tests; Ruff lint/format (98 files), companion/backend mypy (17/55 files), ESLint/types, wheel/sdist/Vite builds | `tester-check-build.log` |
| Initial `npm --prefix frontend run test:fixture` | Exit 0 before the artwork correction: all 11 Chromium workflows, keyboard/mobile/focus/feedback/error/stale/provider retention | `tester-browser.log` |
| Initial sanitized `docker compose --env-file /dev/null -f compose.yaml -f compose.dev.yaml build` | Exit 0: task-only `jukelet:issue32-tester`; historical image superseded by the refreshed build below | `tester-image.log` |
| Initial `JUKELET_IMAGE=jukelet:issue32-tester python3 scripts/smoke.py --browser --lifecycle` | Exit 0: Chromium 1/1, HTTP/auth/CSRF/session/non-root/secret/config/trust-store checks; fixed RC → candidate assignment/session/identity retention; SQLite online backup/offline guarded recovery | `tester-smoke-lifecycle.log` |
| `/tmp/jukelet-ha-companion-venv/bin/python -m companion.distribution_probe` | Exit 0: actual archive clean install and healthy/uncertain/damaged-history exact-baseline upgrades; 14 installed members/hashes, pairing/readiness/recovery/separate enable, inert app-absent execution | `tester-ha-distribution.log` |
| `/tmp/jukelet-ha-companion-venv/bin/python -m companion.runtime_probe` | Exit 0: actual restart/SIGKILL/write readback/uncertainty/quarantine/replacement, protected full Core API/startup restore, exact restored state and higher-revision reconciliation | `tester-ha-runtime.log` |
| `/tmp/jukelet-ha-companion-venv/bin/python -m companion.publication_probe` | Exit 0: app HTTP → adapter → actual Core; lost responses/concurrent edit, HA/app restart, persistent opt-in/fresh reconcile, guarded app restore/reviewed revision 5 recovery | `tester-ha-publication.log` |
| `/tmp/jukelet-ha-companion-venv/bin/python -m companion.administration_probe` | Exit 0: real admin HTTP options flows, permission denial, declined/stale/busy/uncertain intents, restarts and separate stopped-work reconciliation/enable; no replay | `tester-ha-administration.log` |
| `/tmp/jukelet-ha-companion-venv/bin/python -m companion.diagnostics_probe` | Exit 0: actual read-only freshness/readiness/busy/failure/unknown, restart window reset and retained uncertainty | `tester-ha-diagnostics.log` |
| `/tmp/jukelet-ha-companion-venv/bin/python -m companion.dispatcher_probe` | Exit 0: app absence, exact context/single-overflow/duplicates, restart/crash fencing/no replay and reload drain | `tester-ha-dispatcher.log` |
| `backend/.venv/bin/mypy --config-file backend/pyproject.toml --python-executable /tmp/jukelet-ha-companion-venv/bin/python --follow-imports=silent --explicit-package-bases companion/custom_components/jukelet_bridge` | Exit 0: 9 HA-aware modules | `tester-ha-types.log` |
| `python3 scripts/package_integration.py --ref HEAD --output .workflow/2026-10-25-issue32-release/evidence/tester-integration-a`, repeated with `tester-integration-b`; installed archive verifier | Exit 0: all three output files byte-identical, exact committed MIT text, installed integrity verified; baseline-input identity below | `tester-integration-a.json`, `tester-integration-b.json`, `tester-artifact-reproduction.txt` |
| `DOCKER_CONFIG=/tmp/jukelet-issue32-docker python3 scripts/probe_build_context.py` | Exit 0: actual generated BuildKit context, 32 synthetic private paths excluded / 5 sources retained; no repository secrets copied | `tester-build-context.log` |
| `/tmp/jukelet-issue38-bin/actionlint -oneline .github/workflows/ci.yml .github/workflows/publish-docker.yml .github/workflows/publish-integration.yml` | **Exit 1**, only two known `queue`-key errors in actionlint 1.7.12 | `tester-actionlint-raw.log` |
| Same actionlint command with `-ignore 'unexpected key "queue" for "concurrency" section'` | Exit 0 for remaining validation; raw failure retained, no workflow gate weakened | `tester-actionlint-filtered.log` |
| Bounded source/artifact inspection: credential patterns, wheel/sdist MIT metadata/text, frontend exact assets, archive license/members; owned unstarted-container export scan | Pass: 240 complete source files and 2,058 runtime files, no high-confidence private-key/GitHub-token/JWT/AWS-key patterns; exact license/logo/notices hashes | `tester-artifact-audit.json`, `tester-container-artifact.json` |
| `git diff --check`; `git diff --cached --check`; complete task source manifest comparison; local Markdown targets | Exit 0; all 37 initial source hashes matched, 197 local targets existed | `tester-final-source-check.txt`, `tester-local-links.json` |

### Refreshed independent artwork checks (round 2)

The same independent tester verified every entry of
`artwork-correction-source-digests.txt` before/after (37 files; manifest SHA-256
`a6469a92576eb77f18e5a7ad94b09523e9a6226b591c44207c906ef4a0046c42`).
Tools/environment match the preceding exact environment. No backend, companion,
lock, packager or workflow inputs changed, so their earlier full suites, six
actual-HA probes and archive evidence remain applicable without claiming reruns.

| Command / observation | Actual result | Evidence |
|---|---|---|
| `make frontend-check frontend-build` | Exit 0: lint/types, 12 files / 80 unit tests, production build | `tester-round2-frontend.log` |
| `npm --prefix frontend run test:fixture` | Exit 0: all **13** workflows, including 390px landscape / 1280px portrait geometry/corners, keyboard attribution and retained stale artwork | `tester-round2-browser.log` |
| Sanitized `docker compose --env-file /dev/null -f compose.yaml -f compose.dev.yaml build`, `JUKELET_IMAGE=jukelet:issue32-tester-round2` | Exit 0: new AMD64/Linux image identity below; generated temporary secret, read-only mode and all HA/provider settings explicitly empty | `tester-round2-image.log` |
| `JUKELET_IMAGE=jukelet:issue32-tester-round2 python3 scripts/smoke.py --browser --lifecycle` | Exit 0: HTTP/auth/session/CSRF/non-root/secret/config/trust checks, Chromium 1/1, fixed-RC upgrade and guarded SQLite recovery | `tester-round2-smoke.log` |
| Complete source/current artifact inspection; owned unstarted/network-none container export | Pass: 240 source files and 2,058 runtime files, no high-confidence credential patterns; rebuilt frontend/license hashes match | `tester-round2-artifact-audit.json`, `tester-round2-container-audit.json` |
| Owned `npm --prefix frontend run dev:fixture` and independent direct Playwright geometry/visual probe | Probe exit 0; owned server exit 130 on intentional cleanup. Natural aspect retained at 112×56 / 56×112, all corners 4px / 8px; no letterboxing/crop/overlay/clipping, visible canonical attribution below image and retained stale/error state | `tester-round2-visual.json`, `tester-round2-mobile-nonsquare.png`, `tester-round2-desktop-nonsquare.png` |
| Source hashes; working/staged whitespace | Exit 0; all assessed source hashes matched; unrelated user documentation unchanged | `tester-round2-source-check.txt` |

These SVG images are solid-color synthetic fixtures, not captured Spotify content
or provider/household evidence. Independent affected verification is **PASS** with
no required code repairs. Existing Playwright color/npm notices are non-failing.
Fresh review and final committed-source archive checks remain pending; release
readiness remains **PARTIAL** for the retained gates.

The sanitized Docker build supplied only generated temporary credentials, task-only
image/secret paths, `APP_MODE=read_only` and explicitly empty HA/provider/legacy
settings. It disabled implicit Compose environment files. Smoke created/cleaned
its own project/volume; no normal deployment or `.secrets` was accessed. The old
fixed RC was used only in an owned isolated upgrade rehearsal with HA unset,
not advertised as a patched production artifact. Actual HA probes accept no
existing target/credential arguments and use generated configuration and inert
services. Protected Core restore is not household/HA OS/backup-UI restore proof.

Artifact SHA-256: unchanged backend/archive scope from the initial verification, refreshed frontend/container scope from round 2:

| Artifact | SHA-256 / identity |
|---|---|
| Wheel `backend/dist/jukelet-0.1.0rc1-py3-none-any.whl` | `6d9df0ba3e700b43342ddce32bdca7cd2a963eeb71472399626f6394b36e85e8` |
| Sdist `backend/dist/jukelet-0.1.0rc1.tar.gz` | `ab11faab1229dc96247b25286e145ec96e01226ae9a994a2535afe5029a4bdb9` |
| Current Linux AMD64 app image | `sha256:7368467aa093997d0ba41ab011525f0addd9cada049ca07c311f41d6465aeb97` |
| Current frontend index / CSS | `a75fb0cc982b30b61fe2abc6658e55ede9970f3e9232b2f86298ec35ad1181de` / `a493ee2f9c19d72b61d53e2b9691280b8daad17b0a5d915b21a1c56a00ddb762` |
| Current frontend JavaScript | `e889d85834ecbfa80b6337502b07ebdc27899dc11442d0bd635cd31771e8133f` |
| Baseline-input integration archive | `f8bbb647f62645c2a3e4a9e7f9b052e690d5dc1d2393644671b3824203fa194f` |
| Integration manifest / checksum sidecar | `b55bd9fb78acec5c75758571083ecbee8b17fda63f4e06fa3d80cfc85b92273f` / `5c13b558c9a0b4941d055d1b23534baf1151f7dbc9863284138fe158f34c21fc` |
| Changed packager script | `58571fef141dc8b3d74d90fa8bf7fd3c7ddb59335eeebc7fe218b2dd58293cb8` |
| Root/backend MIT license | `035d6ed8da8c88a9e2c4179a904fb445a4ebc61fe466f6ce3fd13bac364d26f2` |
| Frontend notices / official logo | `d4c631b0ee801224e3174442937b26a045266e71aac110b561a31bc64555aa4c` / `b91219c14405166e3667deb7f250df4b939a8a5dbc8460ee9525a75672ba9ec5` |

The prior image `sha256:7462db6e6b4dde511ad8940775ba525c5aa25e4476857cda765388b1da1c88b3` and its frontend hashes are explicitly historical and superseded for the artwork CSS. Current index/CSS/JavaScript paths and complete hashes are in `tester-round2-artifact-audit.json`; the new image was independently rebuilt, exercised and scanned.

The integration archive above uses **committed baseline input** `8340550` and
unchanged component tree `9796d2f6dff256b2e809a5299864469ca0f6ed2b` with the
separately hashed changed packager. It is not a final-commit artifact. After fresh
review and coherent commits, final-HEAD packaging, reproducibility, integrity and
actual distribution rerun must establish its new source/build-info identity;
final commit/archive hashes belong in the PR verification report. No circular
self-hash or future commit is asserted here.

The original provider regression failed for missing content links, then all 30
affected tests passed; the archive-license regression failed for the missing member,
then all five packaging tests passed. The retained trust-store negative control
rejected both interpreters in the old image and passed the patched image. Final
independent smoke includes those trust assertions. A synthetic mobile screenshot
(`tester-tag-detail-mobile.png`) was visually inspected: intact artwork, legible
original logo/link, wrapping exact URI and retained stale/error metadata without
horizontal clipping. It is Chromium evidence, not a physical-device or full
assistive-technology audit.

The first independent artifact-audit snippet accidentally selected old October 23
`backend/dist/jukelet-0.1.0*` outputs and failed their missing-MIT assertion. The
current `0.1.0rc1` wheel/sdist passed. Historical files were preserved/excluded;
this was an **audit selection/setup error**, not a current artifact defect.
Unfiltered actionlint remains a recorded validator limitation: current primary
[GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
supports `concurrency.queue: max`. Filtering exactly that unsupported-key diagnostic
does not establish an unqualified actionlint pass. Existing Starlette/httpx
and Playwright color-environment warnings are non-failing; expected synthetic HA
authorization/storage-error logs establish negative-path behavior. No unrelated
intermittent test failure was observed in this independent run.

## Release gates and unperformed checks

| Criterion | Current status and missing gate |
|---|---|
| AC-1 installation/upgrade/restore/operation | Demonstrated within the documented isolated boundary: app/image lifecycle and packaged actual HA install/exact-baseline upgrades, protected Core restore, pairing/publication/readiness/recovery/separate enable. Household restore remains waived/unperformed. |
| AC-2 security/privacy | Demonstrated by full regressions, real container/browser/HA negative paths and artifact inspection within the stated bounds; server-only secrets/read-only defaults and recovery guards retained. |
| AC-3 accessibility/mobile/failure preservation | Independent refreshed frontend checks, all 13 Chromium workflows, container/browser checks and non-square visual inspection pass, including exact 4px/8px actual-image corners and saved/last-good retention. Screen-reader/voice control, physical devices, Safari/Firefox and rendered HA frontend remain unperformed. |
| AC-4 provider obligations | Dated authoritative review and logo/link/privacy evidence retained. Corner-radius finding resolved by independently verified intrinsic bounds, exact 4px/8px corners, full affected suites and visual inspection. Another fresh review is pending. Provider approval/legal certification/account access is not claimed. |
| AC-5 MIT/dependencies/compatibility | Distribution license metadata/text/notices and exact tested versions/platforms verified. Dependency/advisory review retains OS/HA upstream tooling limitations; no broader support claim. |
| AC-6 release evidence | Four evidence classes, exact commands/results/hashes and attributed #31/#39 limits documented. Fresh reviewer verdict and final committed-source artifact evidence remain pending workflow steps. |
| AC-7 private-data exclusion | Complete task/public source, current artifacts/container and generated context inspected with no findings; bounded credential heuristics and synthetic-secret checks are not exhaustive proof. |
| AC-8 repository checks/evidence | Initial and refreshed affected independent checks passed except the explicit retained raw actionlint validator limitation. Fresh review and final-HEAD artifact identity/reproduction/distribution checks remain pending; overall release verdict remains **PARTIAL**. |

#31's unknown/unassigned physical-card and deliberate different-account checks
were not performed. The owner reported backups and expressly waived household
HA restore/recovery verification; **isolated restore is not household restore
proof**. Final migration revision 3 lacked a subsequent actual HA Core restart
test. #39 changed only opt-in and did not fill these gaps. Power-loss durability,
disk/controller failure, HA OS/Supervisor/backup UI, household TLS, other HA
versions/architectures and independently verified current-candidate Spotify
playback remain unperformed. Prior audible/context/target/advancing-playback
evidence is attributed only to the historical authorized #31 run.

Release checklist: retain exact commit/artifact hashes and this evidence split;
resolve engineering findings and independent review; retain unmet criteria as
open gates and use a draft PR; obtain separate publication authorization before
creating tags/releases/packages/images; after any authorized external write,
read back its effective state. No household waiver, closure or successful test
implicitly authorizes another operational action.
