# Jukelet Home Assistant bridge

The separately installed `custom_components/jukelet_bridge` integration accepts immutable v1 execution snapshots from one explicitly paired publisher. Issue #29 adds a single HA-local tag dispatcher using the #26 adapter, with a local default-only script allowlist, explicit administrator activation, durable uncertainty fencing and bounded diagnostics. Installation, publication, recovery, reload and restart never enable it. The management app remains outside execution; [its publisher/UI](../docs/19-app-publication.md) reconciles immutable app jobs with actual companion status. Follow the [dispatcher configuration, lifecycle and readback contract](../docs/18-ha-local-dispatcher.md); the [owner-reviewed household extraction plan](../docs/17-playback-script-contract.md) still requires separately authorized live work.

Version **0.1.0** supports **HA Core 2026.10.2**, tested with Python 3.14.8 on Linux. Setup refuses other HA versions rather than claiming untested compatibility. This package is separate from the app image and wheel. The historical `spikes/ha_companion` package is not the supported installation.

## Install and pair

1. Before changing an existing HA installation, obtain the owner's authorization and create a protected full HA backup using HA's supported backup facility. Keep the app's protected SQLite backup separately. This repository's tests never perform household installation.
2. Copy the complete `companion/custom_components/jukelet_bridge` directory into HA's `custom_components/jukelet_bridge` directory using the installation's supported configuration-file access. Restart HA. Do not copy the spike or add YAML configuration. Pairing requires no playback configuration; dispatch stays disabled until the separate administrative procedure.
3. In **Settings → Devices & services → Add integration → Jukelet bridge**, enter the exact app publisher UUID from its protected operational state and explicitly confirm pairing. This UUID is an identity, not an authentication credential. Do not generate a different identity to bypass recovery. Only one entry is supported; pairing never happens on the first publication request.
4. Inspect admin-authenticated `jukelet_bridge/status`. A new paired installation has `persistence: empty`, null active revision/checksum and `dispatch_enabled: false`. The history journal is already persisted and freshly read back before pairing completes. Existing stores/quarantine evidence refuse new pairing. For interrupted initial setup or a removed config entry, explicitly select **Reattach existing verified publisher history**, entering the exact current journal publisher UUID. Reattachment validates history and creates the entry without rewriting either store; degraded snapshot state remains degraded for explicit recovery. It refuses missing/damaged history and retired/wrong publisher identities. Never delete evidence to force pairing.

Use HA's authenticated WebSocket at `/api/websocket`. `jukelet_bridge/status`, `jukelet_bridge/publish`, `jukelet_bridge/configure_dispatch` and `jukelet_bridge/dispatch` require admin permission; HA admin credentials are not bridge-scoped. The exact snapshot/status schema, checksums, errors and limits are in [the v1 contract](../docs/15-companion-feasibility.md). Publication credentials remain server-side in the app publisher, never in browser storage. A successful HA authentication or transport acknowledgment is not successful publication.

The integration retains the original paired UUID in its config entry as the installation anchor. Verified replacement is recorded in the companion journal, which is authoritative for the current UUID. There is no YAML migration from the feasibility spike. Preserve spike evidence/backups and deliberately provision a new supported installation under separate owner approval; do not reuse or delete its store to force pairing.

## Publication and durable history

The snapshot remains a complete strict v1 envelope at the companion-owned `jukelet_bridge.snapshot` HA Store, version 1. The separate `jukelet_bridge.history` Store, version 1, contains the original/current publisher identities, per-publisher maximum reserved revision, and latest reserved revision/checksum. It contains no credentials or metadata. Both Stores use HA's `atomic_writes=True`, `private=True`, and a **fresh Store disk readback** after every save. The stores, dispatcher execution-fence Store and config entry must be backed up and restored together.

Under one lock the bridge validates the whole detached snapshot, checks publisher/base/revision, reserves history and verifies it, saves the snapshot and verifies it, then activates it. Only then does it report success. Matching publisher/revision/checksum retries are idempotent, even with the original old expected base. Conflicting, stale, foreign, unsupported and oversized input does not write. At most four publication/recovery transactions are admitted. Status waits for admitted persistence; there is no timeout pretending a background filesystem operation was cancelled. Disconnecting/cancelling a caller does not cancel its transaction. Unload stops admission and drains transactions; WS handlers resolve the currently loaded bridge and return `not_ready` while unloaded. HA shutdown fences acknowledgment.

Production intentionally tightens the spike's known-write-failure behavior: **any failed or uncertain journal/snapshot write returns `persistence_uncertain`, preserves last-good in-memory content, and fences writes until restart reconciliation**. The journal may already reserve the attempted revision even when snapshot writing failed. Restart recognizes matching journal/snapshot as healthy; an older, missing, corrupt or quarantined snapshot is degraded, never an initial empty installation. A valid mismatched snapshot may remain visible diagnostically with `persistence: degraded`; it is not certified as current. Status errors are bounded codes, with no raw payload or exception data.

The journal current/head revision must strictly exceed every retired publisher maximum; inconsistent history is degraded and cannot be recovered by guessing a new revision. The journal retains up to **32 distinct publisher identities**; retired UUIDs cannot be reused. At the limit, replacement returns `history_full`; history is never truncated to allow another pairing. Revisions remain within the v1 safe-integer limit. Reaching either bound requires an explicitly designed future migration, not a counter reset. Only `default` is locally allowlisted; snapshots cannot select arbitrary scripts or service names.

## Recovery and replacement

Stop the app publisher first. Preserve a protected full HA backup and the app's recovery evidence. Read status and compare the exact publisher/revision/checksum with the app's protected state. After an uncertain write, **restart/reload the bridge and read status before recovery**; the same running uncertain instance refuses recovery. If restart shows the intended snapshot healthy, reconcile that result instead of replaying blindly.

With an intact history journal, use the integration's **Configure** options flow:

1. Prepare a reviewed complete v1 snapshot from authoritative app content using the agreed checksum vectors. This is an operator recovery input, not a second assignment editor or conversion of the app's logical export format. The app offers reviewed publication/recovery for healthy same-publisher state; degraded history still requires this operator flow.
2. Set `expected_active_revision` to the exact status revision (null only when no validated active snapshot exists). Choose a new `revision` strictly greater than **every** retained publisher's reserved maximum, including failed attempts, greater than the validated active snapshot revision even if it exceeds journal history, and greater than any revision known to the restored app. The confirmation shows the maximum of retained history and the validated active snapshot. Restoring old mapping content always uses a new revision.
3. For the same publisher keep its UUID. For deliberate replacement enter the new authoritative app UUID in the envelope; it must never have been used in this installation. Review the replacement identity and retain the former app backup. Old-publisher publications are rejected after replacement.
4. Paste the JSON envelope. Review the publisher, revision, checksum, mapping count and current/history revisions on the confirmation step. Confirm explicitly, including the consequences of an empty mapping array. The publisher, active snapshot identity, persistence health/error and revision history captured when preparing confirmation are checked under the same transaction lock; another publication or recovery invalidates it. Scan diagnostics, execution telemetry and activation changes alone do not invalidate it. Reopen and review after rejection; do not change only the expected base blindly.
5. Read `status` again. Require healthy persistence and exact publisher/revision/checksum equality, and confirm dispatch remains false. Take another protected backup. This never changes app-owned drafts or clears the app's M2 recovery guard.

If history is missing, corrupt, quarantined or inconsistent, the flow refuses recovery. A validated stored snapshot whose publisher differs from the journal publisher is also inconsistent: it may prove that a replacement identity was lost when only history was restored. Status remains `degraded` with `last_error: storage_invalid`, and both normal publication and options recovery reject with `recovery_required` for every publisher, even at a higher revision. The stored evidence is preserved; no guessed revision or publisher can repair that missing history. Restore a **known, coherent full HA backup** through HA's supported backup/restore facilities; never hand-edit `.storage`, reconstruct the journal from guesses, remove the config entry as a reset, or delete quarantine files. Validate restored status before any publication. If a coherent backup and sufficient publisher evidence are unavailable, recovery is blocked pending an explicitly reviewed migration. The implementation does not claim automatic repair of irretrievably lost history.

A restored HA backup can trail the app; a restored app can trail HA. Before publication on **every startup/reconnect**, the app must compare identities/revisions/checksums, honor its durable M2 recovery guard, and require explicit reconciliation. Complete rollback/deletion of *all* HA config and storage cannot be detected by this bridge alone. A fresh-looking bridge is never permission for a previously established app to reset/re-publish automatically. HA recovery here does not clear that guard; return to the explicit app publication recovery review.

## Upgrades and rollback

Back up the complete HA configuration/companion stores and app operational state before upgrading. Stop the publisher, replace the complete integration directory with a reviewed compatible release, restart HA, and verify status. Do not mix individual files from releases. This first supported release uses config-entry version 1, journal version 1 and snapshot schema/storage version 1; there is no migration from unsupported schemas or the spike. Unknown schemas/entries and untested HA versions refuse operation. Future releases must provide explicit migrations and rerun vectors/lifecycle tests before expanding compatibility.

For rollback, stop the publisher and restore a matching integration release and coherent full HA backup through supported HA facilities. Read back identity/revision/checksum and reconcile against app history before allowing writes. Rolling back only the snapshot, only history, or only the app database is not a supported rollback procedure. No upgrade/recovery operation enables dispatch.

## Fixture verification and limits

From the repository root:

```sh
make companion-check
```

This runs strict typing and dependency-free synthetic tests for both historical vectors/spike and supported companion. It needs no HA, Spotify, secrets or readers. `make check` includes these tests and lint/format of the companion. The existing frontend component and Chromium fixture suites cover mobile/keyboard workflows and preservation of stale mappings and last-good artwork during metadata failures; this bridge adds no publisher UI.

The #29 dispatcher probe (`python -m companion.dispatcher_probe` in the pinned HA environment) demonstrates app-absent inert execution, actual process restart and crash uncertainty. See [dispatcher evidence and limits](../docs/18-ha-local-dispatcher.md).

The separate #26 playback probe runs with `/tmp/jukelet-ha-companion-venv/bin/python -m companion.playback_probe` after preparing the pinned environment below. It loads real HA scripts containing only synthetic memory capture, variables, delay and stop actions; it does not load playback integrations or access an existing configuration. See [its exact evidence and limitations](../docs/17-playback-script-contract.md#synthetic-verification-and-limits). This is separate from the lifecycle probe, which never loads scripts.

The opt-in actual HA probe reuses the pinned isolated dependency lock:

```sh
uv venv --python 3.14.8 /tmp/jukelet-ha-companion-venv
uv pip sync --python /tmp/jukelet-ha-companion-venv/bin/python spikes/ha_companion/runtime-requirements.txt
/tmp/jukelet-ha-companion-venv/bin/python -m companion.runtime_probe
```

It accepts no target, credentials or existing configuration directory. It creates temporary HA processes, generated users and loopback WebSockets, disables integration dependency installation, and never loads playback/automation/tag/Spotify/discovery integrations. It exercises actual config/options flows, permission denial, Store readback, restart, lost acknowledgments, concurrent publication, same-version reload, unsupported-version refusal, corruption/missing-storage recovery and publisher replacement. It generates a complete synthetic password-protected Core configuration backup through authenticated `backup/generate`, advances the published revision, changes a harmless copied-code fixture, damages/removes the companion stores through HA Store methods, and removes the config entry through HA. Authenticated `backup/restore` requests a real HA restart; the next child process runs Core's startup `homeassistant.backup_restore.restore_backup` path. The probe verifies restoration of the original installed code checksum, exact config-entry ID, and healthy publisher/revision/checksum, followed by stale-base rejection and explicit higher-revision reconciliation. HA itself handles archive contents and storage restoration; the probe never reads credential stores. Fault injection exists only inside the probe; no fault endpoint ships. Invalid-schema fixtures use supported Store writes; a JSON loader seam raises a synthetic decode error so **HA itself** quarantines its companion file. No raw `.storage` edits or credential-store reads occur.

Recorded evidence is in [the production evidence report](../docs/16-companion-bridge.md). SIGKILL demonstrates process termination on the tested filesystem, **not power loss**, controller-cache durability, disk exhaustion or every atomic-writer failure. HA's Store readback is the supported persistence boundary; deployment-specific hardware guarantees remain unverified. The isolated Core backup/restore API and startup path were exercised; the backup UI, Supervisor/HA OS restore, and household installation were not. Missing/corrupt history intentionally remains blocked until a coherent backup is restored and the app publisher reconciles. No playback, physical reader, live HA/Spotify, automatic migration or deployment was tested.


The opt-in [app/HA publication probe](../docs/19-app-publication.md#verification-and-limits)
adds authenticated app HTTP → real HAAdapter WebSocket → actual isolated HA
publication/readback, restart and restore evidence. Run
`python -m companion.publication_probe` in the same pinned HA environment after
`make bootstrap`. It accepts no target/config/credential arguments, creates an
owned synthetic app process, and keeps dispatch disabled throughout.

The opt-in [controlled migration rehearsal](../docs/20-controlled-migration.md#rehearsal-commands-and-evidence)
adds `python -m companion.migration_probe` in that pinned environment. It uses the
actual app publisher, generated isolated HA processes and inert legacy/new paths
to rehearse serial cutover, app-stop, separate HA restart and rollback to legacy
enabled/new disabled/automatic publication suspended. It accepts no external
target or credentials. This procedure evidence is not household authorization,
receiver/account preservation or independently verified playback.
