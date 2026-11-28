# Installation and operations

Choose a management runtime before installing. Standalone Docker and the HA OS
add-on each run one manager and keep their own private SQLite database. Both
use one separately installed HA bridge. The public standalone baseline is
**0.1.0-rc.3**. The prebuilt add-on **0.1.0-addon.12** has been verified in
isolation and awaits separately approved distribution. See the
[artifact and release readiness report](27-release-readiness.md).

## Fresh HA OS installation

Use these steps on an authorized disposable HA OS system. The tested platform
is AMD64, HA OS 18.4 or later within the tested matrix, Supervisor 2026.10.5
minimum, Core 2026.10.3 minimum and Jukelet bridge 0.1.5 minimum.
[Compatibility matrix](30-ha-compatibility.md)

1. Obtain the approved repository metadata and the exact prebuilt candidate.
   Check the version, build source, image archive and manifest against the
   [candidate 12 identities](37-supervisor-backup-recovery.md#immutable-images-and-the-ownership-correction).
   In the lab, Supervisor read local app metadata pointing at the fixture
   registry, with the tested image preloaded or delivered privately. Reload
   the Store, select **Jukelet**, install it, then check the installed version.
   A public Store URL or pullable GHCR candidate is still a distribution gate.
   [Prebuilt distribution procedure](35-addon-distribution.md)
2. In the app configuration set `public_origin` to the exact HTTPS origin used
   to open HA, including a nondefault port. For another address to the same
   installation, add its exact HTTPS origin to `additional_origins` (up to
   eight). Leave `mode` at `read_only` for inspection. Select `manage`
   explicitly when editing is intended. Optionally set `spotifyplus_entity_id`
   to the intended HA media player for metadata. Save and start the app.
3. Turn on **Show in sidebar** and, as an HA administrator, open **Jukelet** in
   the sidebar. Use the native panel link, which supplies the trailing slash.
   The bare Ingress URL returns 404. A reverse proxy terminating local or remote
   HTTPS fronts HA normally. The app has no public port or separate login
   secret to enter. Its backend verifies the HA administrator and keeps the
   Supervisor credential server-side.
4. For a new bridge installation, verify the exact 0.1.5 integration archive,
   stage the complete `custom_components/jukelet_bridge` directory through
   supported HA configuration access, and restart HA. In **Settings → Devices
   & services → Add integration → Jukelet bridge**, pair the exact publisher
   UUID from the manager. Read back the new entry, empty snapshot and disabled
   dispatch. Select the intended local profile and reviewed single-mode playback
   script before any later activation. Preserve an existing bridge entry and its
   history when migrating. [Bridge installation and pairing](../companion/README.md#install-and-pair)
5. Check that the expected inventory is visible. Review assignments, explicitly
   confirm publication and read back the active publisher, revision and checksum
   before considering dispatch. **Starting the manager does not activate
   playback.** Once enabled separately, the bridge can dispatch with the
   manager stopped. Actual playback is a separate observation.

Supervisor owns the options. The manager keeps its DB and persistent key under
`/data/jukelet` with UID/GID 10001. Preserve the DB, key, options and bridge
history together in a protected backup. Before a same-channel update, take a
coherent backup, verify the approved new image and check the installed version,
healthy startup, publisher, revisions, guarded jobs and dispatch after restart.
A populated 11→12 update and a separate migrated candidate-12 restart were
exercised. [Backup, restore and update evidence](37-supervisor-backup-recovery.md)

## Existing standalone installation moving to HA OS

Use the [migration and rollback runbook](38-migration-rehearsal.md) before
starting the new writer. A logical assignment export cannot transfer publisher
identity, tombstones or publication history. Stop the old writer and take the
fresh full-database backup, recover it into a separate stopped add-on target,
then compare the persisted state and current bridge readback with automatic
publication paused. After any new edits or publication, recover from the
**latest** database into a new protected standalone volume. Keep both originals
and check the current HA revision and checksum. Stop on a mismatch or unknown
outcome. [Full database transfer](36-database-transfer.md) ·
[Supervisor backup and restore](37-supervisor-backup-recovery.md)

## Install the app container

For a new local development installation, follow the [Docker quick start](10-development.md#local-docker-quick-start):

```sh
python3 scripts/init_secret.py
docker compose --env-file /dev/null -f compose.yaml -f compose.dev.yaml build
docker compose --env-file /dev/null -f compose.yaml -f compose.dev.yaml up -d --wait
```

These are operator installation commands, not household test commands. The helper
creates a new private app secret under `.secrets`; enter it locally at
`http://localhost:8000`, never in chat/logs/issues. The app runs as UID 10001,
with a read-only root filesystem, dropped capabilities and a named `/data` volume.
The development override permits HTTP only on loopback. `down` retains data;
**do not use `down --volumes` on an installation you intend to keep**.

For network use, configure an existing TLS reverse proxy and exact HTTPS
`APP_PUBLIC_ORIGIN`; use base Compose without the development override. Preserve
the external Host header. See [HTTPS configuration](10-development.md#https-deployment).
Household TLS/proxy configuration is unverified by isolated HTTP checks.

Set `HA_URL` and `HA_TOKEN` together server-side, with optional
`SPOTIFYPLUS_ENTITY_ID`. No old automation setting is required. Leave these empty to run
without HA. Use protected operator configuration outside Git; Compose references
variables, never committed values. The HA credential has administrator privileges
for tag rename/companion operations; it is not a tag-scoped token. Host users with
Docker access can inspect container environment variables. Keep app and HA
credentials distinct, rotate compromised credentials and restart to apply changes.

Default `APP_MODE=read_only` permits inspection and safe previews. Explicit
`manage` enables local assignment changes, reviewed native restore, HA rename and
publication intents. Manage mode is not migration, automatic-publication opt-in,
dispatch activation or permission to access household systems. See the complete
[configuration/session contract](10-development.md#configuration-and-session-contract).

For a published image, pull and verify its immutable digest/version/source labels
before using `JUKELET_IMAGE` and `--no-build`. The [first RC's exact digest](10-development.md#verified-first-rc)
is historical; it does not contain this hardening. The RC2 metadata prepares a new immutable identity; a separately authorized
release and verified final-source artifacts are required before distribution. Bare tags/commits do not publish an
image; published stable/numbered-RC releases invoke full CI and GHCR publishing.

## Historical 0.1.2 bridge installation and pairing

The following commands and version claims apply to the earlier 0.1.2 archive.
Use the [complete archive workflow](24-integration-distribution.md#ha-clean-installation)
on exactly **HA Core 2026.10.2 or 2026.10.3**, Python 3.14.8, Linux. Prefer 2026.10.3; follow the [coordinated Core upgrade order](28-ha-2026-10-3-upgrade.md#operator-order) before changing an existing installation. No HA OS/Supervisor or other
Core version is claimed. From reviewed committed source:

```sh
make integration-package
python3 scripts/package_integration.py --verify dist/integration/jukelet-bridge-0.1.2.zip
```

The builder reads committed Git blobs, not uncommitted edits or an HA directory.
Verify archive SHA-256, manifest, source commit/tree and every installed file.
Stop HA through its supported process manager, replace the **entire** reviewed
integration directory, then restart. Never overlay a few files or edit `.storage`.
Keep app/integration release identities separate; no integration archive is
installed by the app image. Integration release tags are `integration-vX.Y.Z`.
The separately verified production companion is 0.1.2 from exact source
`7536402599f33b46f84858f22d8b1b1394aabae6`, runtime tree
`fa6ef41b605b57ac5efebbc68042fc0e0221e126`. A package built from a later app
commit has different source/integrity metadata even when runtime bytes match;
do not relabel it as that installed archive. RC2 prepares no integration release.

In HA, **Settings → Devices & services → Add integration → Jukelet bridge** pairs
the app's existing publisher UUID explicitly. Follow [pairing](../companion/README.md#install-and-pair).
Read actual status: a genuinely new pair is empty, with dispatch disabled.
An established installation must never delete/re-pair to imitate new state.

Configure the local `default` profile to a reviewed `mode: single` HA script via
the [administrator configuration contract](18-ha-local-dispatcher.md). The
snapshot never supplies arbitrary service/script names. Preserve existing
receiver/account preparation and transfer order. Albums are unshuffled with the
approved safeguard; playlists preserve count/fallback/random-offset/context-start
then shuffle. Resolve conflicting saved preferences visibly before activation.
Tracks are unsupported. There is no automation-format import. Retain protected historical
records when needed; the app's current saved assignments are authoritative.

## Everyday assignment and publication workflow

The owner selected **Automatic** in #39 on 2026-10-25 and separately authorized
the existing opt-in activation. Independent fresh app and HA reads verified it
enabled without changed content, jobs or dispatch. This historical evidence did
not inspect deployed source or exercise a live save, restart, fault, restore or
playback. New installations still start without opt-in; this policy outcome does
not activate another installation.

1. Edit an album/playlist assignment and save locally. Saving never starts music.
   HA label edits have their own registry readback and can succeed/fail separately.
2. With healthy automatic publication already opted in, a save normally queues a
   complete immutable snapshot. Wait for fresh exact publisher/revision/checksum
   readback showing the desired saved content verified active in HA. Saved,
   queued, published and dispatch-enabled remain separate states.
3. While automatic mode is suspended, use **Review snapshot publication**, review
   exact content/removals/preferences, confirm, then wait for verified readback.
   A disabled/deleted assignment can still play from the previous HA snapshot
   until its replacement is verified. Empty snapshots require separate
   exact-content confirmation even in automatic mode.
4. A disconnect or conflict may leave pending/uncertain work. Refresh/reconcile
   actual state before any new explicit retry. Do not resend blindly. Recovery
   guards require reviewed recovery; matching observations alone do not clear them.
5. Automatic opt-in survives clean app restart but requires fresh reconciliation.
   Recovery/conflict suspends it and reviewed recovery does not re-enable it.
   A separate opt-in requires the existing healthy active-content, preference,
   no-outstanding-job and backup, exclusive-dispatcher and rollback attestations. **Suspend automatic
   publication** stops future auto-queueing; already queued jobs remain.

Read [publication/recovery details](19-app-publication.md). A script completion
report is not independent playback verification. Jukelet has no independent
Spotify verifier; absent evidence remains unknown. The app may be stopped while
HA executes its local active snapshot, but HA/provider/receiver connectivity is
still necessary.

## Readiness and explicit activation

Inspect app **Tag playback readiness** for fresh observations, separate from
publication status. Stale/unavailable observations cannot certify readiness;
no observed scan does not establish an offline reader. Busy scans are ignored
without a pending queue or later replay. Keep ignored scans and unknown outcomes
distinct from failed playback.

In HA **Configure → Inspect and control tag playback**:

1. Refresh state; disable dispatch and read it back before maintenance. Disable
   prevents admission but does not stop already admitted/nested/external work.
2. If execution is uncertain, independently establish **all** previous work
   stopped, then separately **Reconcile uncertain startup work** with the required
   attestation. Script entities being off, elapsed time or a restart are
   insufficient. Reconciliation leaves dispatch disabled.
3. Verify every other tag-playback dispatcher disabled. Review healthy matching snapshot,
   compatible preferences, available idle single-mode script, clear fence and no
   busy work; then **Review and enable dispatch** with explicit confirmation.
4. Inspect action result **and independent fresh readback**. Rejected/uncertain
   outcomes never retry automatically. Companion 0.1.4 remembers the explicit
   enable/disable choice across healthy restarts/reloads. Installation, recovery,
   changed configuration, failed readiness or uncertain execution require review
   and explicit enable. Upgrade from an older companion requires one initial
   reviewed enable to establish the saved choice.

These [#37 controls](23-guarded-playback-controls.md) are HA-admin operations.
App sign-in grants no HA administrative control. Snapshot recovery is separate
and cannot be repaired by stopped-work attestation. Publication never enables
dispatch. Normal compatible publication can preserve an already enabled healthy
dispatcher, so publication is not a maintenance-disable control.

## Routine backups and supported recovery

Keep protected app configuration/secret references, exact image/integration
identities, independent publisher/revision/checksum/high-water evidence and
coherent full HA backups. Retain multiple generations outside running volumes
with their recovery keys/passwords. Back up before upgrades, migration or
recovery, and after verified reconciliations; select frequency to match acceptable
lost edits. Periodically exercise the installation's supported recovery route in
an authorized isolated environment. Never put backups in Git or release artifacts.

For the add-on, use the [cold Supervisor backup and guarded recovery procedure](37-supervisor-backup-recovery.md).
Actual isolated 11/12 cold backups and native app-only/HA-only/coherent restores
were verified on 2026-11-01, separately from normal known-witness restart/upgrade.
A stopped10 diagnostic retained DB/key bytes but restored root-owned private
metadata. Candidate 11's product bootstrap normalized that untouched bounded shape
before privilege drop; the service then committed the guard. Lost keys/unsafe state
still stop. Final review/PR gates and household recovery arrangements remain open. The
fixture archives were private and unencrypted; production encryption, off-host
retention and owner recovery arrangements were not established. A coherent recovery
backup requires stopped editing/publication, independently disabled dispatch and quiescent previous work
before sequential Core/app capture. Include snapshot/history/execution/**activation**
Stores with matching HA entry/code/config/scripts. HA-only restore must first stop
and durably guard the app while preventing restart; its unchanged witness cannot
recognize Core-only data replacement. Archived pre-guard images can auto-start and
must not be directly restored under an assumption that target stop/manual boot
protects them. Unknown newer edits/floors remain blocked without resets.

Logical **Export assignments** is portable mapping data, not a complete system
backup. It includes exact IDs, URIs/preferences and informational HA names; treat
it as private. It excludes credentials, sessions, publisher identity, job/history
and provider metadata/artwork. Preview/confirm restore applies only reviewed
supported rows and never deletes unlisted assignments or renames tags. Restore
sets the durable recovery guard and suspends automatic publication.

Use SQLite's online backup utility for a consistent complete app backup, not a
filesystem copy of a live database/WAL. The [exact module commands](10-development.md#consistent-sqlite-backup-and-offline-recovery)
write a **new** protected destination, check integrity and require schema `0004`.
To recover, stop the app, run `jukelet.backup recover BACKUP NEW_DATABASE` with
matching reviewed code, select that new path and restart. It retains identity and
reserved counters/jobs, fences outstanding work, invalidates sessions and latches
reconciliation; do not swap a database under a running worker. Migrate older
backups only on disposable offline copies with a supported migration path.

For HA, back up matching integration code, config entry, snapshot/history/fence
and local scripts/configuration coherently through supported HA facilities. With
intact history, reviewed companion recovery publishes previous content as a
**new higher revision**. Missing/corrupt/inconsistent history requires a known
coherent full HA restore; do not guess counters, clear stores or change UUID to
bypass it. After any restore, verify source, identity/revision/checksum/persistence
and disabled dispatch, reconcile the app guard, then review readiness and enable
separately. A joint rollback of every copy can be locally indistinguishable from
the past: retain independent high-water evidence.

Isolated protected **Core API/startup restore** evidence is not HA OS/Supervisor,
backup-UI, power-loss or household restore proof. The owner waived household
backup/recovery testing for #31; it remains **unperformed**. The waiver changes
no guard or general recovery requirement. Follow [the recovery procedure and
limits](20-controlled-migration.md#backup-restore-and-recovery-procedure).

## Upgrade and downgrade boundaries

The completed PR45 app upgrade rehearsal used the frozen published RC digest to
that hardening candidate with a synthetic schema-`0004` database. The separate
[Current validation and exact artifact evidence](32-migration-retirement.md#upgrade-and-reproducibility) must bind the new identity before it is distributed. The prior rehearsal verified
exact saved assignment, session and publisher retention across image replacement,
then guarded SQLite recovery. This is software replacement on that schema, not proof
of every older migration or future upgrade. The HA upgrade is exact public source
`82d5445ead6574b6f85d70391bc88fd9fe3df3d1` to prepared integration `0.1.2`, followed by Core 2026.10.2 → 2026.10.3 in the dedicated rehearsal,
with healthy, uncertain and damaged-history scenarios on actual isolated Core.

Stop publisher activity, resolve uncertain work without discarding evidence,
disable/read back dispatch, take verified coherent backups, replace the entire
reviewed component, restart, and inspect loaded source/hash/state before resuming.
Use the [detailed HA upgrade steps](24-integration-distribution.md#supported-ha-upgrade)
and [app image commands](10-development.md#pull-and-upgrade-an-existing-installation).
Keep the Compose project/volume and protected configuration unchanged.

Standalone code downgrades, partial-store restores, cross-version HA restore and
arbitrary `0.1.0` integration bytes are unsupported. An old image may not support
a migrated database. Recovery requires a known coherent backup and matching
reviewed code, followed by reconciliation; retaining an old image is not enough.
Unknown versions/schemas halt rather than resetting state. No automatic live
cutover or dual enabled dispatchers are supported.
