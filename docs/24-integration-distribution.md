# HA integration distribution and updates (#38)

The HA integration and app container have **separate installation, version and
release identities**. Updating or restarting the app never installs, updates or
enables the integration in HA. The supported integration is
`custom_components/jukelet_bridge`; the historical spike is not an installer.

## Build and verify the integration

Use Python 3.14.8 and Git from a reviewed clean checkout containing the intended
commit (the builder needs its Git objects):

```sh
make integration-package
python3 scripts/package_integration.py --verify dist/integration/jukelet-bridge-0.1.1.zip
```

`make integration-package` reads **committed HEAD**, ignoring working-tree and
untracked files. Commit intended runtime edits before building a candidate. To
reproduce another release, use the script from that reviewed release checkout:

```sh
python3 scripts/package_integration.py --ref integration-v0.1.1 --output /tmp/jukelet-integration
```

`integration-v0.1.1` describes the prepared release identity; this change does not
publish that tag or release. Before publication, use the reviewed full commit SHA
instead. The three outputs are:

| Output | Contents |
|---|---|
| `jukelet-bridge-0.1.1.zip` | Only the explicitly allowlisted runtime files under `custom_components/jukelet_bridge/`, plus generated runtime `build_info.json` |
| `jukelet-bridge-0.1.1.zip.manifest.json` | Integration version, exact repository commit, component Git tree/path, SHA-256 for every archive file and the archive itself |
| `jukelet-bridge-0.1.1.zip.sha256` | Standard SHA-256 archive checksum |

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
python3 scripts/package_integration.py --verify /path/to/jukelet-bridge-0.1.1.zip \
  --installed /path/to/ha-config/custom_components/jukelet_bridge
```

This reads only the selected integration runtime directory. It compares every
runtime file and rejects mixed-release extras; Python-generated `__pycache__`
files are ignored. Do not point it at a backup, `.storage` or credentials.

## Versions, source and immutable releases

Integration `0.1.1` is a separately versioned successor to the historical manifest
`0.1.0`. The demonstrated deployed `0.1.0` source is exactly
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

## Demonstrated compatibility boundary

| Component / pairing | Demonstrated scope | Boundary |
|---|---|---|
| HA Core `2026.10.2`, Python `3.14.8`, Linux | Existing lifecycle/controls probes and new archive clean-install/upgrade probe | Only supported HA version; setup refuses other Core versions |
| Integration `0.1.0` at `82d5445ead6574b6f85d70391bc88fd9fe3df3d1` → packaged `0.1.1` | Actual isolated Core processes with synthetic config entry, snapshot, retired/current publisher history, execution fence, profile and 120-second timeout | No claim for arbitrary files also labeled `0.1.0`, other upgrade origins or household upgrade |
| App source at this change, app metadata `0.1.0-rc.1` (Python `0.1.0rc1`), integration `0.1.1` | Existing actual isolated app publication/recovery probe plus strict backend consumers; record exact source SHA in verification evidence | Source pairing only; the historical published RC image predates the publisher and is not represented as a tested integration-management pairing |
| Snapshot/status protocol `1`, snapshot/history/execution Store `1`, config-entry `1` | Unchanged strict vectors, malformed-input and lifecycle/recovery tests | Unknown schemas/config-entry versions refuse operation; no implicit conversion |
| Diagnostics interface `1`, playback request/completion contract `1` | #36/#37 component/browser and actual isolated inert-script checks | Completion remains distinct from independently verified playback |

The new probe's exact source/manifest, commands and results must accompany its
verification report. These are synthetic Linux Core demonstrations, not HA OS,
Supervisor, backup UI, hardware power-loss durability, physical scans, receiver or
Spotify verification. Compatibility must not be broadened by relaxing the version
fence: test the actual HA/app/protocol pairing and all lifecycle/guards first.
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

The demonstrated path is the exact baseline above to the packaged `0.1.1` runtime,
with unchanged v1 storage/configuration. No migrations or history resets run.

1. Stop publisher activity, including automatic/queued work, using the existing
   [maintenance/recovery procedure](20-controlled-migration.md#backup-restore-and-recovery-procedure).
   Preserve unresolved/uncertain jobs for reconciliation. In the old integration,
   disable dispatch and independently read it back; establish all admitted,
   nested and external startup work stopped. Disable prevents new admission and
   does not itself stop work. Keep legacy dispatchers disabled too.
2. Take and verify a protected coherent full HA backup **before replacement**.
   Include config entry, complete matching integration release, snapshot, history,
   execution fence and referenced local scripts/configuration together. Keep app
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
   Dispatch must be **disabled**. Unknown results halt the upgrade; never retry
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
**unsupported and untested**. Do not install `0.1.0` over `0.1.1` while retaining
newer state as an operator recovery procedure. The existing isolated protected
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

Prepare the pinned environment in [companion verification](../companion/README.md#fixture-verification-and-limits).
After committing the candidate source, run:

```sh
python3 -m unittest companion.tests.test_distribution -v
/tmp/jukelet-ha-companion-venv/bin/python -m companion.distribution_probe
```

The distribution probe accepts no target/configuration/credential inputs. It builds
committed HEAD, installs the actual archive, derives baseline bytes from the fixed
Git commit, starts fresh owned HA processes, creates synthetic publisher history
(including retirement/replacement), and persists configuration through HA APIs and
companion-owned Stores. It checks clean install and three upgrade scenarios,
installed/loaded source origins, per-file hashes, preserved operational state,
no scan replay, uncertainty, damaged-history refusal and actual #37 admin HTTP
flows. Only inert capture/delay/completion scripts run; there is no app process,
receiver, Spotify integration or household access. It does not read credential
stores or edit raw `.storage` files. Logs print artifact/source hashes and bounded
synthetic outcomes. Full default/component/browser/build and existing isolated
publication/controls/lifecycle checks remain part of the final verification report.
