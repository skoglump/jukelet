# HA OS add-on transition contract (#53)

Accepted **2026-10-30** for [M5](https://github.com/skoglump/jukelet/milestone/6).
Jukelet will move its existing React/FastAPI application and SQLite database into
an HA OS add-on with Ingress and a sidebar entry. The separately installed HA
playback bridge and configured playback scripts remain separate. Standalone Docker
remains supported throughout the transition; removal waits for the gates below.
This records intent and constraints, not an installable add-on or a completed migration.
Only [#53](https://github.com/skoglump/jukelet/issues/53) is in this change's scope.

**October 31, 2026, #58 clarification:** [D16](08-decisions-and-risks.md#accepted-decisions)
records the owner's explicit native-Ingress choice. The HA-provided canonical
trailing-slash entry must preserve queries and prefixed app requests. A bare URL
may fail closed with 404, without Jukelet HTML/bootstrap or app asset/API requests;
a correct canonical redirect remains valid. This supersedes #58's unconditional
redirect prerequisite, with its historical failure evidence preserved. No external
proxy, browser mount setting or authentication inference is introduced.

## Evidence and compatibility baseline

Inspected repository facts at `c7d105237fe16d842dde164f1470b3d5769da920`, the
existing local `feature/ha-addon` starting point, and public metadata read on
2026-10-30:

| Preserved item | Inspected identity / scope |
|---|---|
| Standalone app source | `v0.1.0-rc.3` resolves to `c7d105237fe16d842dde164f1470b3d5769da920` |
| Public release | [RC3](https://github.com/skoglump/jukelet/releases/tag/v0.1.0-rc.3), published 2026-10-28; [image workflow 40750153119](https://github.com/skoglump/jukelet/actions/runs/40750153119) succeeded for that source |
| Standalone image | `ghcr.io/skoglump/jukelet:0.1.0-rc.3`; pin `ghcr.io/skoglump/jukelet@sha256:2037c0154465167c626dee219453a0fd50bcb7f0bc8ce9c91baf9f4567716442` (OCI index) |
| Executable platform manifest | Linux AMD64, `sha256:049289bb765497f6ddf40fb6b12e66636513214414e2a9008e0820d59d686e20`; the index's other entry is an attestation, not ARM support |
| Image labels | OCI version `0.1.0-rc.3`, revision `c7d105237fe16d842dde164f1470b3d5769da920`, source `https://github.com/skoglump/jukelet` |
| Package/schema baseline | Backend `0.1.0rc3`, frontend `0.1.0-rc.3`; Alembic head `0004`, required by [backup/recovery](../backend/src/jukelet/backup.py); logical export schema `1` is a different contract |
| Separate bridge source | [manifest](../companion/custom_components/jukelet_bridge/manifest.json) version `0.1.5` at the same source; this is not proof of an installed or separately published bridge archive |
| Implemented runtime | [Dockerfile](../Dockerfile), [Compose](../compose.yaml), [settings](../backend/src/jukelet/config.py), [application boundary](../backend/src/jukelet/main.py): one worker, standalone secret/session, direct HA origin/token, SQLite; no Ingress/Supervisor mode yet |

The registry index, AMD64 manifest and config were read anonymously using GHCR's
public pull token endpoint and `/v2/skoglump/jukelet/manifests/0.1.0-rc.3`, then
manifest/config digest URLs. This establishes artifact metadata, not a new pull,
execution or household result. Preserve immutable RC1/RC2 artifacts too; RC3 is the
public transition rehearsal baseline, not an assertion about the owner's deployment.
Dated reports calling RC3 “prepared” remain historical; public publication is now
confirmed separately here.

**Unverified deployment facts:** the owner must supply the currently deployed app
source/image digest, database schema, bridge version/source, HA OS/Supervisor/Core
versions, machine model/architecture, installation type and backup/recovery
arrangements before choosing the final migration pair. Keep private identifiers
and backups out of issues. No household access is authorized to discover these.
If deployed state differs, add its exact compatible pair to the rehearsal matrix;
do not assume a tag or current checkout proves deployment identity.

## Branch and release strategy

- `feature/ha-addon` is the integration branch based on the existing local branch,
  not a newly rebased `main`. Issue branches target it; this task uses
  `feature/ha-addon-53-transition-contract` → `feature/ha-addon`.
- Keep `main` and existing standalone release behavior usable until retirement.
  Integrate fixes deliberately with review and run both-mode checks when shared
  behavior changes. No force pushes or overwriting divergent remote branches.
- Proposed add-on artifact namespace: `ghcr.io/skoglump/jukelet-addon`, experimental
  tags `0.1.0-addon.1`, increasing the last number for changed bytes, and separate
  release tags `addon-v0.1.0-addon.1`. These are naming contracts for #59, not
  existing artifacts or commands accepted by today's standalone release checker.
  Add-on metadata must resolve the exact candidate version and recorded digest.
- #59 must isolate release triggers/validation before any such release is published:
  today's [Docker publishing workflow](../.github/workflows/publish-docker.yml)
  excludes only `integration-v` tags, so publishing an add-on release now is unsafe.
  Never move standalone `latest`/minor/RC tags or reuse a candidate identity.
  Keep the shared application's package identity traceable to source, with a
  separately validated add-on packaging version; no package versions change in #53.
- Bridge archives keep independent `integration-vX.Y.Z` identities and checksums.
  Add-on updates never replace bridge files. A future stable add-on channel needs
  reviewed #59 tooling, exact tested artifacts and a separate release request.
  Branch pushes/PRs are not release or deployment authorization.

## Temporary runtime and authorization contract

The following is required future behavior for #54–58, except the explicitly
implemented standalone column. Runtime selection must be explicit server-side
configuration; request headers must never switch modes. This is independent of
`APP_MODE=read_only|manage`, which retains its existing mutation gates and defaults.

| Boundary | Standalone (implemented, retained) | HA OS Ingress (required, unimplemented) |
|---|---|---|
| Browser access | Root path, app-secret login, eight-hour server session, logout | HA-authenticated Ingress prefix; no second secret form or misleading app-only HA logout |
| Authorization | Existing single-owner secret/session policy | **HA administrators only**, verified at backend access boundary; sidebar visibility is never authorization |
| Trust | Exact configured Host/Origin; no forwarded-header trust | Validate Supervisor ingress peer/path before accepting forwarded identity; reject direct-port, forged-header, non-admin, missing/unknown identity requests |
| Session/intent | HttpOnly/SameSite cookie, Secure with HTTPS, Origin/CSRF, expiring session-bound reviews | Path-scoped app session tied to verified HA user; retain CSRF, expiry, user/session-bound publication/restore intents; no cross-user or stale confirmation |
| Backend HA credential | Optional paired `HA_URL`/`HA_TOKEN`, server-side | Supervisor-issued credential remains backend-only; fixed Core REST/WebSocket transport, never a browser credential or generic proxy |
| Network/data | One app container and private SQLite volume | Reuse app build with private `/data`, one worker, no published Ingress port; no host network/socket, privileged mode or broad mounts by default |

The backend's Supervisor credential is a service credential, **not evidence that
the browser user is an administrator**. #55 must demonstrate trustworthy user/admin
verification; if Supervisor metadata cannot establish it, refuse access until a
supported verification design exists. Do not treat token possession or absent
identity as an owner session. Installation does not authorize publication, rename,
dispatch enablement or playback. Administrator bridge controls remain in HA with
their independent review/readback; app access does not bypass those controls.
A narrowly scoped liveness-only exception may remain unauthenticated; it must
expose no private state and cannot create a session.

Shared inventory, onboarding, rename, metadata/fallback, assignment/concurrency,
export/restore, publication and diagnostics retain existing domain/API semantics.
Ingress changes routing/trust/session establishment, not assignment ownership or
review requirements. Browser requests/assets/downloads/uploads stay beneath the
validated prefix, never HA's own `/api`. Session expiry must preserve recoverable
unsaved work without exposing one user's private state to another. Intended HA
embedding and local/remote HTTPS origins need explicit tested policies rather
than globally relaxed Host/Origin/frame protections. Secrets stay outside browser
payloads, storage, logs, images and Git; never extract HA/Spotify credential stores.

## Preserved bridge and recovery invariants

Reuse the [v1 bridge](16-companion-bridge.md), [publisher](19-app-publication.md),
[controls](23-guarded-playback-controls.md) and [current standalone contract](32-migration-retirement.md).
No snapshot/status/diagnostics wire-version change, re-pairing, publisher UUID reset,
revision reset or replacement importer is part of this transition.

- HA owns exact opaque tag IDs/names; SQLite owns assignments/preferences. Preserve
  row versions, tombstones, audit, publisher identity, publication job/revision and
  checksum history, recovery flag and last-good data. Transfer all existing data,
  including any cache present; it must not invent persistence for in-memory caches.
- Preserve monotonic publication, same-revision idempotency, failed-write last-good
  snapshots and lost-acknowledgment readback before retry. Unknown/foreign/stale
  state blocks publication; transport acknowledgment is not effective-state proof.
- There is **one assignment writer and one household publisher**, and **one HA
  tag-playback dispatcher**. Never share a live SQLite file/volume between old and
  new apps, even for convenience. Experimental managers use disposable databases
  and isolated HA, not a second connection to the household bridge.
- The bridge remains in HA and handles scans with the management app/add-on stopped.
  Preserve configured playback preparation/account/receiver scripts; no app scan
  dispatcher, scan replay or automatic playback retries. Saved, published, enabled
  and independently playback-verified remain distinct.
- Normal restart/update retains reviewed choices only under existing healthy checks.
  Restore/recovery is different: invalidate restored browser sessions, suspend
  automatic publication, fence outstanding jobs and reconcile before writes.
  Preserve bridge snapshot/history/execution fence and remembered activation Store;
  uncertainty requires stopped-work review and remains paused. No raw `.storage`
  edits, partial history restore or bypass by changing transport.

## Support targets and verification matrix

**Target, not certification:** HA OS with Supervisor-managed add-ons; standalone
Docker remains the transitional target. Core minimum stays **2026.10.3** with
required contracts and the existing [forward compatibility policy](30-ha-compatibility.md).
Use bridge **0.1.5 minimum** for the transition's current consent/retirement baseline;
older v1 wire compatibility alone is insufficient to certify a migration pair.
Freeze and record the exact bridge archive/source/hash in later acceptance runs.

For #58's experimental AMD64 package, use **HA OS 18.4 / Supervisor
2026.10.5** as conservative numeric minima: this is the first disposable pair
with actual local installation, options, lifecycle and native Ingress identity
evidence, using Core **2026.10.4**. Older OS/Supervisor pairs are untested, rather
than declared broken. Supervisor 2026.10.4's source-level identity prerequisite is
not a tested support floor. The manifest's Core **2026.10.3** installation target
remains distinct from the actually tested Core version. [The package record](34-local-ha-addon.md)
separates historical failures from candidate 5's actual native-routing and
lifecycle PASS, bound to its immutable source/context/image identity.
#62 must exercise minimum/current Core, custom commands, manager/security and
the broader compatibility matrix; backup/recovery has its separate gates. These
numbers do not certify all later releases, ARM64, household migration or cutover.

AMD64 is the inspected standalone artifact platform and mandatory first isolated
add-on test target. ARM64 is conditional on owner-confirmed hardware; if required,
#59 must build/test it and #62/#63 must exercise it before cutover. Other architectures
are unsupported until separately scoped. Neither OS/Supervisor nor ARM64 behavior
is demonstrated by existing Linux x86-64 Core-process tests.

| Gate / owner issue | Required evidence before advancing | Status at #53 |
|---|---|---|
| Documentation #53 | Source/artifact/schema assertions, references, consistency and all issue criteria; independent verification/review | Contract only; checks reported in PR |
| Standalone regression #54–59 | Root-path assets/login, existing APIs/CSRF and Docker image/persistence/security/Chromium smoke; pinned RC3 rehearsal input | Existing commands retained; no new runtime result claimed |
| Synthetic dual-mode #54–57 | At least two Ingress prefixes plus root, real requested URLs, upload/download, malformed prefixes, forged/direct requests, non-admin/unknown identity, expiry, two sessions/cross-user/stale intents, reconnect/lost ACK | Pending implementation |
| Real isolated HA OS #58/#59/#62 | Exact OS/Supervisor/Core/bridge/image/source/digest/architecture; clean install/update, admin service-command permissions, sidebar desktop/mobile/keyboard, manager workflows, failures/restarts and app-stopped inert-script dispatch | Pending; cannot be replaced by mocks/Core-only probes |
| Compatibility #62 | Same candidate on minimum Core 2026.10.3 and discovered current stable; upcoming beta if available as experimental, absence recorded N/A; exact upstream Python/dependencies and bridge archive | Historical Core evidence remains artifact-specific; new add-on matrix pending |
| Recovery #60/#61/#63 | Full DB transfer, corrupt/schema/existing-destination/interruption refusal, real Supervisor backup/restore, app-only/HA-only/coherent restore, before/after-new-edits rollback, sole writer and retained history | Pending at #53; [nominal 9 source/actual transfer verified 2026-11-01](36-database-transfer.md#corrected-candidate-9-observed-2026-11-01), but fresh review exposed AUTOINCREMENT/internal-state acceptance. Complete AC-1/AC-6 await candidate 10 checks/proof; 8/9 histories and #61/#63 pending gates remain |
| Hardware/deployment #64/#65 | Owner facts confirmed, required architecture tested, exact final pair rehearsed, scoped live acceptance and observation window | Unknown/pending separate authority |

Use synthetic tags/users/credentials and inert scripts in disposable isolated
environments. Record exact commands, exit codes, dated artifacts and limits. The
existing `make check`, `make build`, `make image`, `make smoke` remain applicable to
runtime changes; this documentation-only task requires static checks, not invented
behavioral regression tests. No HA OS installation commands are claimed working yet.

## Delivery sequence and gates

The [current M5 roadmap](05-milestones.md#m5--home-assistant-add-on-transition)
links each issue. Its dependency graph is: #53 → #54/#55/#57;
#54+#55 → #56; #55+#56+#57 → #58; #53+#58 → #59 and #60;
#58 → #61; #58+#59 → #62; #60+#61+#62 → #63;
#62+#63 → #64 → #65 → #66. This is sequencing context, not authorization to
start those issues. It builds on #18/#25/#29/#30/#38/#48 and does not reopen #51.

Before #65, #64 must provide tested installation/update instructions, exact matrix,
protected rollback artifacts and a reviewed runbook. Fresh installation has no old
database to adopt; migration must retain the existing publisher/history through
#60's offline full-database transfer. Logical schema-1 assignment export is useful
portable data but cannot replace full operational-state transfer. #61 must prove
consistent Supervisor backups and restore detection/mandatory guarded startup;
prefer cold backup initially unless a hot strategy is demonstrated. Preserve
separate app secrets/config and coherent HA bridge/config/scripts/stores. Joint
rollback may be indistinguishable from old valid state; document detection limits
and require explicit reconciliation instead of claiming a database flag detects all restores.

The [#60 offline transfer procedure](36-database-transfer.md) specifies protected
source/final-backup/new-target separation, complete persisted-state comparison and
operator failure recovery. It requires separately authorized privileged HA OS
developer/operator access, not the ordinary Terminal & SSH app, and does not arrange
household access or replace the later Supervisor/rollback/readiness gates.

**2026-11-01, #60 evidence:** actual pinned public RC3 was stopped with restart
disabled before its fresh final backup. Candidate 8, built once from
`29836bd5063e050bdf0b89bd785a8429c2b8f990`, received all eight persisted tables
with only required recovery transformations before startup; independent native
HA browser/readback confirmed retained history and durable publication fences.
The [recorded artifact identities and limits](36-database-transfer.md#observed-disposable-rehearsal-2026-11-01)
retain that original build source despite later documentation commits. Supervisor
is healthy/supported but retains the disposable system's no-current-backup issue
and create-full-backup suggestion; #61 and #63 are not satisfied by this transfer.
That nominal 8 evidence did not close the later unsupported-CHECK/column-order
review findings. **Corrected 9 evidence, 2026-11-01:** independent source and actual
HA OS verification demonstrated all seven original criteria at build source
`fa8bd989cef92de1e2f95b4c71708a05ac77008c`, using the unchanged latest backup from
the still-stopped C7 source and a NEW stopped/private target. The
[recorded 9 identities, preserved schema/history, native session and limits](36-database-transfer.md#corrected-candidate-9-observed-2026-11-01)
supersede 8's completeness without rewriting its failures or original artifact.
Later prose is not 9's build source and must not cause a rebuild. A subsequent
fresh review found AUTOINCREMENT/internal sequence state could prevent ordinary
saves despite nominal 9's passing transfer. That counterexample supersedes its
complete AC-1/AC-6 conclusion; candidate 10 requires new independent/source/actual
proof. Original failure and artifact histories remain. The backup advisory/owner
prerequisites and #61/#62/#63/#64 gates remain separate.

**Cutover requires separate explicit owner approval** for exact artifacts,
installation, household access, backup/restore, mutations and any named physical
playback/app-stopped checks. #53 authorizes none of these. Before transfer, stop the
old writer and disable its automatic restart, resolve/fence outstanding uncertainty,
take a fresh final consistent backup and retain the old image/config/data. Stage
and validate a new guarded destination without replacing running data. Verify exact
IDs/preferences, publisher/revisions/checksums, recovery state and fresh bridge
readback before reviewed publication/activation. Installation alone never activates
dispatch. Retain one publisher/dispatcher throughout and preserve the active snapshot
on transfer/startup/HA failure. Stop rather than improvise if validation is uncertain.

**Rollback before new edits** uses a guarded recovery copy of the retained baseline,
with current HA history readback and reviewed publication at a revision above
retained/observed history where needed; never blindly restart a stale database.
**Rollback after new edits or publication** first stops the add-on writer, captures
current consistent data/history and compares its schema with the old executable.
Only a demonstrated reverse-transfer/recovery path may carry the latest assignments,
identity, tombstones and publication history back; invalidate sessions, fence jobs,
reconcile exact readback and retain monotonic revisions. If the old app cannot read
the new schema, or reverse transfer cannot preserve newer work, that downgrade is
unsupported: keep publishing paused, retain both backups and use an approved forward
repair or separately reviewed recovery. Data loss or resetting IDs/counters is not
an acceptable shortcut. #63 must rehearse both cases and document stop conditions;
#65 must retain rollback readiness throughout the owner-agreed observation window.

**Retirement (#66)** requires recorded owner acceptance after verified cutover,
completion of the agreed observation window, recoverable rollback evidence including
newer edits, declared support facts, and passing add-on install/update/security,
backup/restore/publication/app-stopped checks. Then audit references and remove
standalone-only Compose/login/config/release paths and exclusive tests in that
bounded issue; retain shared application/domain/recovery/bridge and useful isolated
tooling. Keep historical source/images/instructions and protected backups; code
cleanup never authorizes registry deletion, household container/volume deletion or
removal of current HA playback dependencies. Any such cleanup needs its own scoped
authority and verified checklist. This retirement is distinct from #51's completed
automation-import retirement and has no promised date.
