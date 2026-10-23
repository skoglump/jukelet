# Controlled migration and rollback (#31)

This is the preparation runbook for [#31](https://github.com/skoglump/jukelet/issues/31), not a completed household migration. Preparation and generated isolated rehearsals are authorized. Household reads, installation, configuration changes, scans, playback, app stops and HA restarts require one later approval of a completed private scope packet. No existing localhost app, `.secrets/live-read.env`, credential store or household configuration is an authorized rehearsal target.

The owner's chosen final state after the rollback drill is **legacy dispatcher enabled, new dispatcher disabled, automatic publication suspended**. This preference does not authorize execution. Do not repeat cutover after the drill without new scope.

## Prerequisites and fixed contract

The prerequisite implementations are present in main at `9849391982cf7a0dc3a7f5c7d176974c33126e69`:

| Dependency | Implemented boundary to review |
|---|---|
| [#17](https://github.com/skoglump/jukelet/issues/17), onboarding | [Discovery/name readback](../backend/src/jukelet/tag_onboarding.py); names remain HA-owned. Migration does not require tag rename. |
| [#18](https://github.com/skoglump/jukelet/issues/18), recovery | [Consistent SQLite utility](../backend/src/jukelet/backup.py), [reviewed logical restore](../backend/src/jukelet/recovery.py), [operational procedure](10-development.md#export-reviewed-restore-and-protected-sqlite-recovery-18). |
| [#26](https://github.com/skoglump/jukelet/issues/26), owner-reviewed behavior | [Extraction plan and unresolved household details](17-playback-script-contract.md#owner-reviewed-household-extraction-plan), [reference adapter](../companion/custom_components/jukelet_bridge/ha_playback.py). |
| [#29](https://github.com/skoglump/jukelet/issues/29), dispatcher | [Admission/fence implementation](../companion/custom_components/jukelet_bridge/dispatcher.py), [administrative activation/readiness](18-ha-local-dispatcher.md). |
| [#30](https://github.com/skoglump/jukelet/issues/30), publisher | [Publisher/readback/review](../backend/src/jukelet/publication.py), [durable job store](../backend/src/jukelet/publication_store.py), [separate persistent opt-in](19-app-publication.md). |

Use the existing supported companion, [v1 schema/checksum](15-companion-feasibility.md), immutable app-owned snapshots and local `default` profile. Installation and publication never enable dispatch or invoke playback. Receiver preparation, account activation, transfer and media behavior stay in the reviewed HA scripts. Do not implement a second assignment master, a migration API or a new recovery protocol.

The companion supports **HA Core 2026.10.2** with Python 3.14.8. Historical session findings mention 2026.10.1; they do not establish the current household version. After authorization, freshly verify the actual version before installation. An unsupported version halts this run; upgrading HA or relaxing the version fence requires separately reviewed work.

## Stable acceptance and evidence matrix

Keep these IDs in the private ledger and final redacted report. Issue criteria AC-1–AC-9 remain incomplete until their household evidence exists. Passing PREP criteria does not close the issue.

| ID | Acceptance criterion | Synthetic fixtures | Actual isolated HA | Authorized household |
|---|---|---|---|---|
| AC-1 | Exact approval, target, protected verified backups and rollback plan | Utility/restore tests | Generated protected Core backup/restore; SQLite backup | Pending private approval and target-specific backups/recovery availability |
| AC-2 | No interval with two enabled dispatchers | Administrative/admission tests | Serialized legacy-off readback before new-on; reverse at rollback | Pending every transition and restart readback |
| AC-3 | Intended album/playlist content, target and advancing playback independently observed | Cannot prove | Inert captures cannot prove | Pending approved physical scans and independent provider/receiver observations |
| AC-4 | Unknown/unassigned/disabled tags and duplicate/busy rules | Exact IDs, malformed events, 2-second bounded duplicates, single/busy tests | Generated unknown/unmapped/disabled/excluded events; inert busy/duplicate suppression | Pending approved physical/simulated cases; no implicit scan permission |
| AC-5 | App stopped and actual HA restart checked separately, explicit re-enable | Lifecycle tests | Separate app-stop invocation, new HA process/PID, persisted snapshot and disabled startup | Pending approved stop/restart counts, readiness and playback |
| AC-6 | New off/readback before legacy restore/on; one working legacy dispatcher; differences explained; chosen final state | State/fence tests | Inert legacy automation works after rollback; no second cutover | Pending actual legacy playback proof and final-state ledger |
| AC-7 | Unperformed cold/account-switch/recovery cases explicitly limited | Fixture scope stated | No receiver/accounts/hardware | Pending exact permitted conditions; all unperformed cases stay unverified |
| AC-8 | Exact protected preservation comparison; source fingerprints, differences, excluded tracks and conflicts visible | Import/review/preference tests | Changed source rejected; track exclusion; explicit edits resolve both shuffle conflicts | Pending protected current source/script details and owner decisions on any conflicts |
| AC-9 | Identity/revision/checksum/persistence/dispatch readbacks; uncertain outcomes halt; restore guards and higher revisions | Guard/retry/history tests | Actual publication, restart, coherent restore and reviewed monotonic recovery | Pending private readbacks; no counter rewind or guessed history repair |
| PREP-1 | Prerequisites, focused plan and stable three-tier matrix | This contract and source review | Version-pinned probe setup | Does not authorize household access |
| PREP-2 | Concrete runbook, source review, backups/restore, rollback/approval/evidence packet | Procedures below | Supported procedures exercised only on generated state | Missing target fields explicitly block execution |
| PREP-3 | Applicable publication/cutover/restart/rollback transitions rehearsed | Existing suites | New migration probe plus unchanged runtime/publication probes | Does not establish completed migration |
| PREP-4 | Applicable checks/build/browser, exact versions/results/content hashes; independent test and fresh review | Repository checks | Opt-in probe logs | Draft PR while live criteria remain; leave #31 open |

## Private scope packet and one approval gate

Prepare this packet outside Git, public issues/PRs, web-served paths and shared logs. Use private references in public reports. These fields are **pending**, not defaults to infer from previous sessions. Before consolidated approval, identify the owner-supplied target/scope and concrete review/backup/recovery procedures. Fresh household readouts and backup results are collected only **after that approval**, then must pass preflight **before any configuration change**. Existing owner-supplied evidence can inform the packet but does not replace fresh preflight. Credentials must never be pasted into an approval message.

| Private field | Required concrete content before approval |
|---|---|
| Target and operator | Exact HA installation/deployment and owner-reported version if known; app deployment/database/volume; maintenance operator and recovery access. Fresh version verification is authorized preflight. |
| Dispatch/configuration | Exact legacy automation(s), scripts/preparation dependencies, new script/profile; reviewed file/release fingerprints; each permitted installation/configuration change and validation mechanism. |
| Music and devices | Specific permitted accounts, native Spotify target, receiver, physical reader and test tags; allowed albums/playlists; current warm/cold/account condition. |
| Window and effects | Start/end/time zone, maximum volume and how it is independently checked; permitted account changes, transfer, receiver power and playback conditions. |
| Scans/restarts | Explicit physical and/or synthetic scan cases and count; app stop/start and HA restart counts; whether cold start/account switch is included. Blank means not permitted. |
| Source review | Concrete scoped source/mapping comparison procedure and expected baseline/extraction plan; owner-supplied details if available. Fresh fingerprints, differences, track inventory and explicit conflict resolution are mandatory pre-change/pre-activation preflight results, not permission to read now. |
| Backup/recovery | Exact supported protected HA/app backup method, protected destination/reference, restore operator/path, required coherent contents/release, password/recovery-key availability through owner practice and expected downtime. Fresh backup identities/times/fingerprints/integrity results must be verified during authorized preflight before changes. |
| Rollback triggers | The halt/rollback rules below plus owner-specific limits; enough window remaining to restore safely. |
| Automatic publication | Whether the separate persistent opt-in step is permitted, at which step, and how pending jobs are reconciled before suspension/rollback. Publication/dispatch consent does not imply opt-in. |
| Final state | Legacy enabled; new disabled; automatic publication suspended. Record any separately approved change to this preference explicitly. |

Only when those fields and the exact proposed changes are reviewable, request one consolidated approval: **“Approve the private packet [reference/version] for [installation] during [window], including only its listed changes, scans/playback limits and app/HA restarts, its separate automatic-publication choice, rollback triggers and final legacy-on/new-off/automatic-suspended state?”** A request for information or approval of intended behavior is not execution approval. Until the packet is complete, report missing installation/scope/backups/hardware as blockers and finish repository preparation; do not issue a broad live-access request.

## Protected source and mapping review

After separately authorized fresh scoped reads, retain the exact source bytes, retrieval time, installed versions and SHA-256 digests privately. Read only the selected automation and its referenced preparation/playback scripts; do not collect full configuration or credential stores. Compare the configured-source preview fingerprint against the reviewed import using the same representation; it hashes the submitted source bytes, so even formatting changes require another review. Hash referenced script/configuration files independently. A mapping fingerprint alone cannot prove script preservation. Stop on a changed source or local assignment version and produce a new review.

For each exact opaque tag ID, compare legacy type/URI, app type/URI, enabled/shuffle/profile and presence in the proposed snapshot. Preserve spaces, case, Unicode and normalization exactly. Review added, removed, changed, disabled, orphaned, duplicate, malformed and unsupported rows; the importer only accepts its recognized literal structure and never evaluates templates. Keep unsupported rows and diagnostic reasons in the report. Migrate albums/playlists only. Inventory every legacy track with its exclusion and rollback behavior before activation; do not silently drop it or convert it to another type.

Use a private table with columns: **exact tag ID; source fingerprint; legacy URI/type; proposed URI/type; enabled/shuffle/default profile; change/exclusion reason; owner decision; reviewed local version; published checksum**. A second protected table records source line/function/order and expected versus proposed behavior for each item:

- Existing receiver readiness conditions, delays, signals and bounded failure handling.
- Existing account activation and preparation script, order and transfer/native-target selection, including confirmation and failure handling. Preserve credentials in their existing system; never extract them.
- Playlist count lookup, exact fallback for unavailable/zero count, valid random-offset bounds, context start **followed by** shuffle.
- Album unshuffled start and exact post-start shuffle safeguard condition/timing.
- `mode: single`, `max_exceeded: silent`; a scan during preparation is ignored, with no pending queue. The new companion's documented duplicate window is separate from busy handling.

The approved media rules require enabled albums `shuffle:false` and playlists `shuffle:true`. Show each conflicting saved row and require an explicit owner choice/edit using optimistic versions; never silently rewrite assignments or claim a conflicting preference was applied. Conflicts block activation/automatic opt-in. Metadata failure alone does not invalidate a saved URI or justify erasing labels/artwork.

The migration probe's generated example deliberately includes:

| Synthetic review case | Expected and asserted result |
|---|---|
| Source gains a newline after review | Different fingerprint; old review confirmation returns 409; no stale import. |
| `Synthetic excluded track` | Unsupported track appears in rejected rows; not in the app snapshot; retained in inert legacy mapping. |
| Album shuffle-on and playlist shuffle-off drafts | Review visibly reports conflict and keeps both values; explicit versioned PUT edits resolve them before publishing. |
| App album later changes from synthetic A to B | Automatic publication reaches revision 2; rollback legacy still refers to A. Explain this difference instead of promising parity. |
| Disabled app-only row and missing mappings | Do not invoke new script; no assignment is fabricated for an unmapped event. The probe does not establish physical tag registration. |

These are synthetic operator examples, not an extraction of private behavior. The inert script has no receiver preparation, fallback, account or shuffle implementation and cannot prove those household semantics.

## Backup, restore and recovery procedure

Before a configuration change, make a **fresh protected full HA backup** through the installation's supported backup facility. Include the original automation/scripts, relevant integration/configuration, complete companion release, config entry, snapshot, history and execution fence coherently. Record backup identity/time, protected/completed state, expected contents/release and a protected archive fingerprint where available. Independently verify the backup is available and the operator has the recovery key/password and supported restore route. A request acknowledgment or filename alone is insufficient. Do not open credential stores, edit `.storage`, copy individual companion stores as recovery, or claim a Core probe validates HA OS/Supervisor restore.

Take a consistent app operational SQLite backup, plus an optional logical mapping export for review. The operational backup preserves publisher identity, counters, jobs and sessions; the logical export does not. Retain separately configured secrets through the owner's existing secret-management practice. With locked dependencies installed, the supported utility is:

```sh
uv run --project backend --locked python -m jukelet.backup backup /private/jukelet.db /private/jukelet-backup.db
uv run --project backend --locked python -m jukelet.backup recover /private/jukelet-backup.db /private/jukelet-recovered.db
```

These are path templates for a scoped operator, not household commands already executed. The first command uses SQLite online backup including committed WAL data, creates a new `0600` file and verifies integrity/schema `0004`. Record its successful exit, integrity result and protected destination fingerprint. Do not copy a running `.db` file and discard its sidecars.

For database restore, stop the one app instance; retain its original database/WAL/SHM together. Run `recover` into a new destination from the reviewed backup, validate success, then point the stopped deployment at that guarded file. It invalidates sessions, suspends automatic publication and fences outstanding work before use. Sign in anew, run only one app writer and read actual HA state before publication. Older schemas require an offline disposable-copy migration using the documented matching version; do not experiment on the deployment.

For HA restore, first disable/read back new dispatch and establish all old startup/external work stopped; stop the app publisher. Restore a known coherent full HA backup and matching reviewed integration release using the installation's supported recovery path. Validate configuration and restart only within the approved scope. Since the legacy automation's restored enabled state may differ, freshly inspect both dispatchers before any scan or enable. New dispatch remains disabled after companion restart/recovery. Keep it disabled throughout rollback.

Compare restored publisher/revision/checksum/persistence against protected app/high-water evidence. Missing/corrupt/inconsistent HA history needs coherent full-backup restoration, not guessed counters or identity changes. Intact-history recovery uses the companion's reviewed **Configure** flow with a complete app-owned v1 snapshot and a revision above all retained reserved/known revisions. Follow [companion recovery](../companion/README.md#recovery-and-replacement), then the app's **Review publication recovery**. Healthy same-publisher app recovery uses the exact observed base, a strictly higher revision and exact healthy readback before its durable guard clears. HA recovery alone cannot clear that app guard. Automatic publication stays suspended until another separately approved opt-in. Never republish old content at its old revision or blindly retry an uncertain write.

A joint restore of all histories to an indistinguishable past cannot be detected from those copies alone. Preserve independent protected revision/high-water evidence; if coherence or the restore route is unavailable, halt rather than clearing evidence. The generated runtime/publication probes exercise the supported Core and app paths, not household backup recovery availability.

## Serialized transition checklist

The root operator alone performs household operations after approval; agents receive repository/synthetic work only, never live credentials or mutations. Pause scans for the maintenance window. Prevent concurrent configuration/app edits and retain protected evidence. No broad reload, unrelated change or unreviewed deployment is part of this procedure.

At **every** row independently read HA companion status and legacy state after any command: publisher identity, active revision/checksum, persistence/error, `dispatch_enabled`, readiness/busy/uncertainty, configured profile/script and legacy on/off. Compare app desired/verified/guard/automatic state when app is running. Record expected and actual states, time, command/result and evidence reference. `GET /api/v1/publication` is observational; HA admin WebSocket `jukelet_bridge/status` is the independent companion read. Control acknowledgments alone do not authorize the next step. The companion cannot detect or turn off legacy automations: the operator must establish the invariant.

| Step | Action and required readback before proceeding |
|---|---|
| T0: approve/preflight | First obtain consolidated approval of the concrete target, permitted effects and procedures. Only then perform fresh scoped version/state/source reads and protected HA/app backups; verify recovery availability and compare mappings/scripts before any configuration change. Confirm legacy is the only enabled dispatcher, no unknown startup work, automatic suspended and no pending publisher jobs. Halt on unsupported versions, unresolved source/preference decisions, failed backups or deviations from approved scope. Approval alone does not waive these preflight gates. |
| T1: local setup | Install only reviewed compatible companion/script/configuration under the approved change list. Validate exact source preservation, local `default` allowlist and `single`/silent script. Read new off; legacy stays as approved. Installation/reload/restart never grants enable permission. |
| T2: disabled publication | Review app mappings/checksum/exclusions/conflicts and publish with new off. Separately read exact publisher/revision/checksum, healthy persistence, profile and both dispatcher states. Confirm active desired version matches; no playback claim. |
| T3: readiness | Independently establish previous scripts, nested and external startup work stopped. Explicitly reconcile the new execution fence if required; read back clear/idle/ready and new still off. A script entity `off` alone does not prove detached work stopped. |
| T4: legacy off | Stop accepting scans; drain/establish stopped legacy startup work. Disable legacy using the approved supported control and read **legacy off, new off**. Halt on missing/unknown state or pending work. Never enable new on a presumed legacy disable. |
| T5: new on | Explicitly enable new, then separately read **legacy off, new on**, exact healthy snapshot and expected readiness. A refusal/lost response requires reconciliation, not another blind enable. |
| T6: bounded scans | Only approved scans, accounts/targets/conditions/volume. Observe content/context, actual target and advancing playback independently. Record script accepted/finished separately. Unknown/unassigned/disabled tags must cause no new attempt; verify duplicate/busy rules only within approved scan scope. No unapproved simulated tag events. |
| T7: separate opt-in | Only if the private packet explicitly approves it and backup/cutover/rollback prerequisites and active content are verified, review/confirm **automatic publication migration opt-in**. This persistent choice is separate from T2/T5. If not approved, leave it suspended. Do not use attestation to bypass unfinished prerequisites. |
| T8: app stopped | Within scope, stop app, verify it actually stopped, perform only approved scan/check and record independent playback. HA has the local snapshot. App absence does not imply provider/receiver connectivity. |
| T9: actual HA restart | Separately perform the approved HA process restart. Read both dispatchers before any scan; require the same healthy publisher/revision/checksum and new off. Review readiness/allowlist/version/idle and establish stopped work; reconcile uncertainty only with explicit attestation. If approved to continue, enable new explicitly only after legacy off readback. Perform the separately approved restart scan/check. Do not equate app restart with HA restart. |
| T10: quiesce publisher | Reconnect/reconcile app if restarted, suspend automatic publication and inspect immutable queued/in-flight/uncertain jobs. Suspension stops new queue creation but does not cancel existing jobs. Resolve/drain reviewed jobs with exact readback, or stop the publisher and retain fenced/uncertain evidence under the recovery procedure. Do not proceed assuming an empty queue. |
| T11: rollback new off | Disable new and independently read new off. Confirm idle and independently stopped nested/external work before restoring scripts/enabling legacy; disable does not cancel an already admitted attempt. Keep both off on uncertainty. |
| T12: restore/on legacy | Restore reviewed prior configuration only if needed, with approved validation/restore steps. Explain added/changed/excluded mappings. Read new off **before** legacy enable; then read exactly legacy on/new off. Perform only the approved legacy scan and independently verify its expected content/target/advancing playback. |
| T13: final | Read final legacy on/new off/automatic suspended, queue disposition, snapshot identity/revision/checksum and recovery guard. Explain every app-versus-legacy mapping difference and unperformed case. Stop; do not repeat cutover. Leave #31 open when any live criterion remains unverified. |

After any timeout, lost acknowledgment, unavailable state, checksum/publisher mismatch, degraded persistence, unexpected enabled dispatcher, unsupported version, preference conflict, unexpected playback/target/volume, failed backup, elapsed window or uncertain external work: **halt new scans/writes; reconcile actual state first**. If authorized and state is known, disable/read back new and use T10–T13 rollback. If either dispatch state or external work remains unknown, do not enable either path or blindly retry playback/publication. Record the blocker and require reviewed recovery. Never switch transport to bypass a denied operation.

## Rehearsal commands and evidence

Use the pinned tools in [development](10-development.md) and [isolated HA setup](../companion/README.md#fixture-verification-and-limits), plus `make bootstrap` for the app environment. Opt-in commands from the repository root:

```sh
python -m companion.migration_probe
python -m companion.runtime_probe
python -m companion.publication_probe
```

Here `python` must be the generated pinned HA environment's Python, not an arbitrary system interpreter. These commands accept no target/configuration/credential arguments and use only generated temporary directories, users, app secrets and loopback processes. The app helper starts from a small environment allowlist, so live integration settings are not inherited. The migration probe loads real HA script/automation integrations with inert memory capture/delay/response actions; no media player, SpotifyPlus, tag-reader or default discovery integration is loaded. The app publisher is the actual application, not a publication stub. All generated configuration/state is removed at cleanup.

The migration probe prints redacted transition readbacks, versions and source SHA-256 digests. It checks source change/exclusion/conflict review, publication while new is disabled, serial cutover, inert unknown/unmapped/disabled/duplicate/busy admission, a **separate** automatic opt-in, app-stopped invocation, a different actual HA process/PID with disabled restart, explicit readiness/enable and final rollback. Its legacy automation deliberately starts disabled on each fresh process; it cannot prove a household legacy automation's restart behavior. Serialized tested commands establish no overlap in this controlled rehearsal; there is no new production cross-dispatcher interlock.

The unchanged runtime probe separately exercises protected Core backup/restore, matching installed-code/config-entry restoration and higher-revision recovery. The unchanged publication probe separately exercises consistent app backup/guarded restore, Core restore, exact active-state reconciliation and reviewed monotonic recovery. Do not combine these different scenarios into a claim that one household end-to-end restore ran. No receiver/account/content/physical reader or independently advancing playback is tested by any inert probe.

For each evidence item record: **ID and AC/PREP IDs; synthetic / real isolated HA / authorized household; authorization reference if applicable; exact command and exit code; Python/HA/Node/npm/uv versions; source commit plus task-file digests; expected/actual result; UTC time; redacted log/artifact location; limits and stale-evidence conditions**. Store detailed household evidence/backups privately; publish only redacted summaries. Repeat affected checks after relevant changes, and distinguish implementation failures from unrelated intermittent tests. Repository changes require applicable lint/types/unit/integration/component/Chromium workflows and builds, independent tester evidence and a fresh reviewer verdict. A draft PR can deliver preparation while household ACs remain explicitly pending.

## Offline installation readiness

The [playback preparation worksheet](21-playback-preparation.md) extends preparation with PREP-5 (optional explicit local timeout, unchanged 30-second default, persistent admin readback and retained uncertainty) and PREP-6 (executable synthetic sequence, real isolated timing/error checks and exact-source extraction gaps). The earlier migration probe remains a procedural rehearsal; the new sequence fixture does not turn it into household preservation evidence. Exact source capture/comparison, final wrapper review and a concrete approved deadline remain installation gates. An owner-reported backup or restart does not prove recovery availability or behavior after a future companion installation. No live setting is selected or applied by this preparation.
