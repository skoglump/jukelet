# HA integration distribution and updates (#38)

Current prepared app 0.1.0-rc.3/integration 0.1.5 retire automation migration;
see [current compatibility, upgrades and decommission boundaries](32-migration-retirement.md).
Dated evidence below retains its original source and version scope. Current probe
selection uses `standalone` instead of the historical `migration` rehearsal.

The HA integration and app container have **separate installation, version and
release identities**. Updating or restarting the app never installs, updates or
enables the integration in HA. The supported integration is
`custom_components/jukelet_bridge`; the historical spike is not an installer.

Integration **0.1.3** introduced the policy replacing exact patch allowlisting with minimum **Core 2026.10.3** plus required API checks. See the [current support policy, dated matrix, immutable archive identity and CI results](30-ha-compatibility.md). The earlier [0.1.2 coordinated upgrade](28-ha-2026-10-3-upgrade.md) remains historical; no old archive is replaced.

## Companion 0.1.4: remembered dispatch choice

The new companion 0.1.4 remembers reviewed enable/disable choices across healthy
HA restarts and reloads. See [the current controls](23-guarded-playback-controls.md)
and [decision](08-decisions-and-risks.md#remembered-dispatch-after-healthy-ha-restarts-2026-10-26).
First installation or upgrade from 0.1.3 needs one reviewed enable to create the
new companion-owned `jukelet_bridge.activation` Store (version 1). Existing
snapshot/history/execution Stores, config-entry and v1 APIs are unchanged. Include
activation in coherent backups. Snapshot recovery/replacement, configuration
mismatch, startup readiness failure and uncertain work still require manual review.
A complete HA backup restores its recorded choice too; do not assume restoring an
enabled backup can be distinguished from an ordinary restart. Follow the paused
backup/recovery procedure, keep legacy dispatchers disabled across restarts and
inspect state before returning a restored HA to service. No household restore test
or change to the existing waiver follows from this feature.

See the [0.1.4 artifact and verification record](31-remembered-dispatch.md).
The 0.1.3 artifact and its dated matrix below are frozen historical evidence, not
0.1.4 verification. New version/source/archive identities and actual isolated
results are recorded separately; never overwrite the old ZIP or its sidecars.

## Build and verify the integration

The frozen **0.1.3** archive is pinned to source
`f9e46d8e4b50f6dcd7cba263efea63c6d1d1e607`, component tree
`697e42893ab639302e605dc133c2b621773934f3`, archive SHA-256
`f08fae96954966fa2db96511e3a9f93584137175cc217cd93e68dc0041181403`.
The [dated canonical matrix and independent evidence](30-ha-compatibility.md#dated-canonical-verification--2026-10-25)
record the same bytes on actual Core 2026.10.3 and 2026.10.4.

Use Python 3.14.9 and Git, with the trusted builder and Git objects from that
reviewed source. Reproduce into a fresh owned output directory:

```sh
python3 scripts/package_integration.py \
  --ref f9e46d8e4b50f6dcd7cba263efea63c6d1d1e607 \
  --output /tmp/jukelet-bridge-0.1.3-f9e46d8
python3 scripts/package_integration.py \
  --verify /tmp/jukelet-bridge-0.1.3-f9e46d8/jukelet-bridge-0.1.3.zip
```

`make integration-package` remains the generic **committed HEAD** package command,
ignoring working-tree/untracked files. A later documentation-only HEAD changes
`build_info.json` and therefore archive bytes; it does **not** reproduce the pinned
checksum. Use the exact source above for this artifact, even after evidence-only
documentation updates. Scheduled/manual compatibility CI selects the last commit
changing runtime, the builder or LICENSE, preserving that archive source while
refreshing test evidence separately.

`integration-v0.1.3` is the prepared release identity, not a published tag/release.
No release publication is performed by this change. A later separately authorized
release must retain its exact reviewed source and immutable assets.

The three outputs are:

| Output | Contents |
|---|---|
| `jukelet-bridge-0.1.3.zip` | Only the explicitly allowlisted runtime files under `custom_components/jukelet_bridge/`, plus generated runtime `build_info.json` and the exact committed root MIT `LICENSE` |
| `jukelet-bridge-0.1.3.zip.manifest.json` | Integration version, exact repository commit, component Git tree/path, SHA-256 for every archive file and the archive itself |
| `jukelet-bridge-0.1.3.zip.sha256` | Standard SHA-256 archive checksum |

ZIP entries have fixed timestamps, order, permissions and no compression-dependent
bytes. Rebuilding the same committed input produces identical outputs. The builder
refuses to replace different existing output bytes. Use a fresh output directory
when comparing candidates. It packages Git blobs rather than recursively copying
an operator's configuration. Missing, extra tracked, symlink or executable runtime
files fail the reviewed allowlist. Untracked files are never included. Automated
synthetic contamination tests cover credentials, private configuration, assignments,
fixtures and migration evidence. No such operational data belongs in the archive.

The manifest describes integrity, not an independent signature or proof that the
source/release is trusted. Obtain the archive and sidecars from the same reviewed
release, validate its expected source SHA and inspect release notes. To compare
an extracted or installed directory, run the trusted release's verifier with the
sidecars adjacent to the archive:

```sh
python3 scripts/package_integration.py --verify /path/to/jukelet-bridge-0.1.3.zip \
  --installed /path/to/ha-config/custom_components/jukelet_bridge
```

This reads only the selected integration runtime directory. It compares every
runtime file and rejects mixed-release extras; Python-generated `__pycache__`
files are ignored. Do not point it at a backup, `.storage` or credentials.

## Versions, source and immutable releases

Integration `0.1.3` adds a forward-compatibility policy and API preflight without changing v1 storage/configuration. Its demonstrated immediate upgrade origin is exact 0.1.2 source `7536402599f33b46f84858f22d8b1b1394aabae6` on Core 3. The following 0.1.0→0.1.1 history remains historical. No Store/config-entry/protocol migration is introduced. The demonstrated deployed `0.1.0` source is exactly
`82d5445ead6574b6f85d70391bc88fd9fe3df3d1`, documented in the
[controlled migration report](20-controlled-migration.md). Later commits for
[#36](22-playback-diagnostics.md) and [#37](23-guarded-playback-controls.md) retained
the old manifest version; **the string `0.1.0` alone does not identify those bytes**.
Do not label a newly built package as the previously deployed artifact. This
upgrade baseline comes exclusively from public repository history, with fresh
synthetic operational state, not captured household files.

Future integration runtime or packaging changes require a new integration version
and new `integration-vX.Y.Z` tag/release identity. A changed Git source identity
also changes `build_info.json` and archive bytes: never retarget a published tag or
replace its artifacts, even for a documentation fix or rerun. Check out the exact
old tag to reproduce it. Use patch releases for compatible fixes; protocol,
config-entry or Store changes need explicit compatibility/migration decisions and
new lifecycle evidence before release. A larger version number alone does not
authorize a schema migration or unsupported downgrade.

App releases retain their existing `vX.Y.Z` / `vX.Y.Z-rc.N` workflow and metadata
checks. Existing numbered RC tags, images, digests and assets, including
`v0.1.0-rc.1`, remain unchanged. An integration-only fix does not require changing
app metadata or republishing an app image under its old RC identity. A future app
change must likewise receive a new app release identity before publication.

The prepared `.github/workflows/publish-integration.yml` reacts only to published
`integration-vX.Y.Z` releases, checks the tag against committed integration
metadata, runs reusable CI, rebuilds from the event's exact commit, and uploads the
three integration assets without `--clobber`. Any existing assets cause refusal,
including a partial prior upload; investigate and create a fresh release identity
rather than replacing/deleting published bytes. Its concurrency queue serializes
integration releases. The app publication workflow skips integration tags; app
releases do not upload integration archives. Ordinary PR CI builds/verifies the
package but publishes neither integration assets nor images.

Before separately authorized publication, release notes must name the integration
version/source, checksum and demonstrated matrix; link these installation/recovery
instructions and report isolated tests separately from historical household
evidence. State explicitly whether an app container is included (integration-only
releases include none). Preparing/testing these workflows does not run publication.
Broader security, provider, accessibility and final release hardening remain #32.

## Current and historical compatibility boundaries

| Component / pairing | Demonstrated scope | Boundary |
|---|---|---|
| Integration 0.1.3 / Core >=2026.10.3 | [Current dated matrix and required contracts](30-ha-compatibility.md) | Later stable expected compatible; beta/dev untested experimental; no blanket future guarantee |
| Historical integration 0.1.2 / HA Core `2026.10.2` and `2026.10.3`, Python `3.14.8`, Linux | Exact historical allowlist; [earlier evidence and sequential upgrade](28-ha-2026-10-3-upgrade.md) | Other versions refuse setup; Core 2 is transition compatibility, not an upstream security claim |
| Integration `0.1.0` at `82d5445ead6574b6f85d70391bc88fd9fe3df3d1` → packaged `0.1.1` | Actual isolated Core processes with synthetic config entry, snapshot, retired/current publisher history, execution fence, profile and 120-second timeout | No claim for arbitrary files also labeled `0.1.0`, other upgrade origins or household upgrade |
| Historical app code at source `90844db81b8546c47004da23f6763495862ecc0c`, app metadata `0.1.0-rc.1` (Python `0.1.0rc1`), integration `0.1.1` | Existing actual isolated app publication/recovery probe plus strict backend consumers; record exact source SHA in verification evidence | Source pairing only; the historical published RC image predates the newer diagnostics, administrator screens and reproducible integration packaging; current pairing evidence names exact source/image identities |
| Snapshot/status protocol `1`, snapshot/history/execution Store `1`, config-entry `1` | Unchanged strict vectors, malformed-input and lifecycle/recovery tests | Unknown schemas/config-entry versions refuse operation; no implicit conversion |
| Diagnostics interface `1`, playback request/completion contract `1` | #36/#37 component/browser and actual isolated inert-script checks | Completion remains distinct from independently verified playback |

The new probe's exact source/manifest, commands and results must accompany its
verification report. These are synthetic Linux Core demonstrations, not HA OS,
Supervisor, backup UI, hardware power-loss durability, physical scans, receiver or
Spotify verification. The 0.1.3 version-policy change is backed by required-API checks and actual isolated lifecycle/guard testing; a version string alone does not establish compatibility.
Unknown app protocol responses fail strict parsing; incompatible content must not
be published or activated. Stop and retain the last good state for reviewed
recovery instead of editing version markers to force startup.

## App container installation and updates

Follow [app Docker installation and release images](10-development.md#release-images-and-upgrades).
Keep its protected SQLite backup and app-specific configuration/secret handling.
Use a reviewed compatible new image identity/digest, run one writer, and reconcile
publication identity/revisions/checksum after restart. The app's durable recovery
guard and automatic-publication opt-in are separate from HA dispatch. Do not clear
a recovery guard or turn on automatic publication as an integration-upgrade step.
The app container does not mount or modify HA's integration directory.

## HA clean installation

1. Confirm the demonstrated HA version and operator authorization. Preserve a
   protected full HA backup through the installation's supported facilities, with
   a usable recovery key/password and restore route. Keep the app's consistent
   protected SQLite backup and independent high-water evidence separately.
2. Verify the archive, sidecars and expected source/version. Extract into an empty
   staging directory outside the running installation. Inspect the complete
   `custom_components/jukelet_bridge` subtree. Stop HA using its supported process
   manager, install that complete directory into HA's configuration directory,
   and start HA. Do not overlay individual files, copy tests/spikes, or add YAML.
3. Follow [explicit pairing](../companion/README.md#install-and-pair). Inspect
   `jukelet_bridge/status`: a genuinely new paired instance is empty, with no active
   revision/checksum and dispatch disabled. A missing/corrupt execution fence is
   uncertain, not ready to execute. Previously established installations must
   never delete evidence/re-pair to imitate a new installation.
4. Read the installed manifest version and `build_info.json`, compare their source
   commit/tree to the integrity manifest and verify installed file hashes. These
   are separate from the app's displayed version. A fresh HA process must load the
   complete reviewed directory; reading files while an old process runs does not
   establish the loaded version. HA's integration information shows the manifest
   version; source identity comes from `build_info.json` and verified file hashes.
5. Pair/publish only through the established reviewed workflow. Installation,
   configuration and publication leave dispatch disabled. Use the #37 procedure
   below before admitting any intentional scan.

## Supported HA upgrade

The current companion update is 0.1.3 to 0.1.4 on Core >=2026.10.3, with one initial reviewed enable establishing the saved choice. The earlier demonstrated 0.1.2-to-0.1.3 path and its same-archive matrix remain historical. See the [new support/matrix guide](30-ha-compatibility.md). Core 2 installations must first follow the historical 0.1.2 companion-first transition to Core 3 [as documented](28-ha-2026-10-3-upgrade.md#operator-order); do not install 0.1.3 on Core 2. No migrations or history resets run.

1. Stop publisher activity, including automatic/queued work, using the existing
   [maintenance/recovery procedure](20-controlled-migration.md#backup-restore-and-recovery-procedure).
   Preserve unresolved/uncertain jobs for reconciliation. In the old integration,
   disable dispatch and independently read it back; establish all admitted,
   nested and external startup work stopped. Disable prevents new admission and
   does not itself stop work. Keep legacy dispatchers disabled too.
2. Take and verify a protected coherent full HA backup **before replacement**.
   Include config entry, complete matching integration release, snapshot, history,
   execution fence, activation Store (when present) and referenced local scripts/configuration together. Keep app
   backup and independent publisher/revision/checksum/high-water evidence. Retain
   the old archive/source fingerprints; do not expose backups in release artifacts.
3. Record current publisher, active revision/checksum, persistence health,
   uncertainty and local profile/timeout via the established admin read interfaces.
   Verify the staged new archive/source and compatibility. Stop HA, replace the
   entire old integration directory with the staged new directory, then start HA.
   Do not leave mixed-version files or hot-copy over a running integration. A
   same-process reload is not the demonstrated distribution upgrade procedure.
4. Verify newly loaded version/source/file hashes, retained config-entry anchor,
   current publisher, revisions/checksum, healthy persistence, profile and timeout.
   Dispatch must be **disabled**, preserving the maintenance-disable choice from step 1 (or because the old version had no saved choice). Unknown results halt the upgrade; never retry
   publication, reset identity or rewrite counters to make them appear correct.
5. In **Settings → Devices & services → Jukelet bridge → Configure → Inspect and
   control tag playback**, review fresh readiness. If execution is uncertain,
   inspect all previous work, then separately **Reconcile uncertain startup work**
   with the explicit stopped-work confirmation. Reconciliation leaves dispatch
   disabled. Neither an idle script entity, restart nor elapsed time proves that
   detached work stopped. Degraded history/snapshot needs separate recovery and
   cannot be solved by this attestation.
6. Independently verify every legacy dispatcher disabled. Review the healthy
   matching snapshot, album/playlist preferences, configured available idle
   `mode: single` script, timeout, no busy work and clear fence. Explicitly choose
   **Review and enable dispatch** with legacy-disabled confirmation. Inspect the
   action result and its independent fresh readback; rejection/uncertainty never
   retries. Only future intentional scans can execute; there is no replay queue.
7. Reconcile the app's state and recovery guard through its existing workflow
   before resuming publisher activity. Take a fresh protected backup. HA enablement
   is not app automatic-publication opt-in or playback verification.

The new probe exercises both a clear execution fence and a retained uncertain
fence across a real baseline-to-archive process restart. It also upgrades synthetic
damaged history and requires degraded/refused publication/enable with evidence
preserved. No production guard or snapshot checksum changes for packaging.

## Recovery and unsupported downgrade limits

A standalone code downgrade, partial-store rollback or snapshot-only restore is
**unsupported and untested**. Do not install an older integration over 0.1.3 while retaining newer state as an operator recovery procedure. The historical 0.1.0/0.1.1 packages also refuse Core 2026.10.3; 0.1.2 accepts that Core version. The existing isolated protected
Core backup/restore probe demonstrates a coherent matching-source full restore;
it does not establish this cross-version downgrade or a household restore route.

On failed loading, identity/hash mismatch, uncertain write, damaged history,
missing snapshot or unexpected dispatch state: keep publisher and both dispatchers
stopped/disabled, preserve all evidence and the pre-upgrade backups. Follow
[companion recovery](../companion/README.md#recovery-and-replacement). With intact
history, reviewed recovery restores old content at a **new higher revision** and
requires exact fresh readback. Missing/corrupt/inconsistent history requires a
known coherent full HA backup and its matching reviewed code through supported
HA restoration; unavailable coherence/restore evidence blocks recovery pending
an explicitly designed migration. Never edit `.storage`, clear history/fences,
re-pair with a new UUID or guess counters.

After a supported coherent restore, inspect both dispatchers before scans, verify
identity/revision/checksum/persistence/source, and reconcile app history and its
durable guard. Keep new dispatch disabled until #37 readiness review and separate
explicit enable. Retain independent high-water evidence: rolling all copies back
together can be locally indistinguishable from their old state. Household backup
availability, restore success and detached-work termination require separately
authorized operator verification.

## Reproduce isolated verification

Use the [upstream-matched environment preparation and complete matrix runner](30-ha-compatibility.md#reproduce-with-one-archive), with a locked backend environment.
Keep the canonical source/archive fixed while selecting the HA interpreter:

```sh
python3 -m unittest companion.tests.test_distribution -v
python3 -m scripts.ha_compatibility run \
  --python /tmp/jukelet-ha-minimum/venv/bin/python \
  --baseline-python /tmp/jukelet-ha-minimum/venv/bin/python \
  --archive /tmp/jukelet-bridge-0.1.3-f9e46d8/jukelet-bridge-0.1.3.zip \
  --output /tmp/jukelet-bridge-0.1.3-minimum-result
```

Use fresh owned paths and the same archive for the Core 2026.10.4 run documented
in the matrix guide. The full runner supplies that archive to all twelve probes;
the distribution probe uses the unmodified historical 0.1.2 source on Core3,
then the canonical archive on Core3 and the selected target Core. Its clean and
healthy/uncertain/damaged-history upgrade scenarios independently verify actual
loaded source/file hashes and exact publisher, revision/checksum, history,
config-entry, fence, profile and timeout retention. Restarts stay disabled, no
uncertain scan is replayed, and guarded administrator review/enable remains separate.

These probes create their own HA configurations and synthetic credentials, accept
no HA target or existing configuration, and use inert scripts. They neither read
credential stores nor edit raw `.storage` files. The [canonical command/result
ledger](30-ha-compatibility.md#commands-independent-checks-and-evidence) distinguishes
actual isolated HA, synthetic faults, retained app/browser checks and prior
production reports. Household playback/restore and other platform guarantees do
not follow from these tests.

### License completion of the unpublished candidate (#32)

The first prepared `0.1.1` archive had not been tagged or distributed when #32 reviewed packaging. The candidate now also carries the exact committed root MIT `LICENSE`, hashed and verified as a required installed member; runtime source allowlisting is unchanged. Root verified no `integration-*` remote tags/releases existed. This corrects the still-unpublished candidate rather than replacing immutable published bytes. Subsequent published identities remain immutable. Tests prove committed-license inclusion despite uncommitted edits and preserve reproducibility, contamination/tamper rejection and installed file checks. Archive evidence built before the final task commit uses the committed baseline runtime/root license with the separately recorded changed packager hash; that historical report distinguished pre-commit evidence from its final committed source. For 0.1.3, the pinned canonical source/checksum above remains authoritative after documentation-only commits.
