# Standalone to add-on migration and rollback

This runbook is for an isolated rehearsal with synthetic users and assignments,
the pinned standalone RC3, the candidate add-on, and one existing 0.1.5 bridge.
Keep dispatch disabled throughout the transfer. Household cutover requires a
separate decision and recoverable backups under the owner's control.

## Capture the handover

1. Record the source and target software identities, platform image digests,
   database schema, volume identities and bridge version. Preserve the old image,
   configuration, secrets and volume privately. Give each runtime its own
   database path and writable volume.
2. Suspend automatic publication. Resolve outstanding jobs against a fresh HA
   readback. Record the publisher, assignment revision, publication high-water
   mark, active revision and checksum, dispatch state and pending work. When HA
   is unavailable or an outcome is uncertain, keep publication paused.
3. Disable restart of the old writer, stop it and verify its stopped state. Take
   a fresh, integrity-checked final backup. Quiesce the bridge configuration and
   take the coherent recovery backup. Retain the timestamp, artifact digests,
   recovery keys and the readback associated with those backups. The exact
   commands and required observations are in the [transfer procedure](36-database-transfer.md)
   and [Supervisor backup procedure](37-supervisor-backup-recovery.md#quiesce-a-coherent-recovery-backup).
4. Keep the add-on stopped with automatic start, watchdog and auto-update off.
   Prepare the new private target and run guarded recovery with the source mounted
   read-only. Compare every persisted table against the final backup, accounting
   for deleted sessions, fenced jobs and the recovery guard. Include deleted
   assignments, exact identifiers, audit records and publication history. Preserve
   the stopped source, protected backup and destination as three distinct artifacts.
5. Start only the selected writer. Independently compare the app's observation
   with the current bridge state. A mismatch, an uncertain result or an unexpected
   publisher requires investigation with publication paused. Use the existing
   [reviewed reconciliation procedure](19-app-publication.md) before allowing
   publication. Capture fresh readback after any reviewed write.

## Decide which state to recover

| Observation | Recovery action |
| --- | --- |
| Transfer or startup failed before any new work | Stop the candidate, prevent its restart, and confirm the old app remains stopped. Compare the retained source and current bridge with the handover record. Only when the data and bridge still match may the operator select a guarded fresh copy for the old runtime. |
| The add-on accepted an edit, deletion or publication | Stop and fence the add-on. Back up its **current** database and the corresponding bridge state. Keep the original standalone volume archived. Reverse-transfer the current backup into a new standalone volume, preserving edits, tombstones, publisher identity, revisions, checksums and all jobs. |
| Backup is stale, HA cannot be read, or schema compatibility is uncertain | Leave both writers stopped or the sole selected writer publication-paused. Retain the bridge's last-good snapshot. Keep the newer artifacts for forward repair or separately reviewed recovery. |
| The old binary rejects the recovered schema or loses required history | Record the exact incompatibility. Keep the add-on's current database and bridge state together, with publication paused. A downgrade remains unsupported until the old runtime can consume a guarded complete copy and pass independent state comparison. |

On either recovery path verify integrity and schema with the actual old image.
Confirm restored sessions have been discarded, jobs fenced, automatic publication
disabled and reconciliation required. Keep network publication paused until the
sole selected runtime and the bridge agree on publisher, current revision and
checksum. After an update or restart repeat the readback and compare retained data
and jobs. A process that starts successfully can still have stale data.

Keep sensitive databases, keys, backup contents and raw private mappings outside
the evidence report. Record only software identities, protected artifact locations,
checksums, guard observations, check results and material limits.

## Pinned-image rollback rehearsal, 2026-11-27

On AMD64, the standalone index `sha256:2037c0154465167c626dee219453a0fd50bcb7f0bc8ce9c91baf9f4567716442`
selected the owner-baseline RC3 configuration
`sha256:03300d494d951fdd450b9a1e0c3c31956a58f9870797bc074ff253f4a2933ca3`.
Candidate `0.1.0-addon.12` had configuration
`sha256:ceb18116c08f59da51b8484951e32d7e9d9312bc2e7067d2e088bf19a50781e7`.
All three RC3 starts ran its normal server with no external networking or port
publication. Each answered `GET /health/live` on container loopback and stopped
with restart policy `no` before the next writer opened a database. The source,
final backup, candidate, before-edits rollback, post-edits backup and after-edits
rollback used six distinct private volumes. No schema conversion was required.

| Check | Observed result |
| --- | --- |
| Seed and forward transfer | The synthetic RC3 transfer probe created a versioned assignment, tombstone and five publication jobs. After stopping RC3, its backup matched all eight tables. Candidate 12's guarded recovery preserved assignment revision 8, publisher, high-water 5 and active revision 1, fenced four jobs, retained one verified job, deleted sessions and required reconciliation. |
| Restore before new edits | Guarded recovery into an empty standalone volume passed the schema-0004 comparison. The actual RC3 server started from it. The whole-state probe accounted for runtime observations and all eight tables matched. |
| Detect a stale rollback | The candidate's assignment store added two synthetic assignments then deleted one, advancing assignment revision 8 to 11. Comparing the earlier final backup to the current candidate failed on assignment rows, audit history and the assignment revision. |
| Restore after new edits | A fresh candidate backup matched its current database. Guarded recovery into another empty volume retained all four rows including tombstones, all eleven audit records and all five publication jobs. RC3 started successfully. The post-start whole-state comparison passed with guard generation 9, automatic publication disabled and reconciliation required. |

Use the [synthetic transfer probe](../scripts/probe_database_transfer.py) with
the private paths in [the forward-transfer instructions](36-database-transfer.md#synthetic-fixture-and-whole-state-evidence).
Run `compare --mode backup` after each stopped backup, `compare --mode recovered`
before starting either recovered writer, and `compare --mode recovered-running`
after the recovered runtime has been stopped again. Require all eight table
comparisons to pass. The sanitized receipt for this run had SHA-256
`cc9e7e3dca343dba60a9333f149ceb8838dcab664ac929aeb0482dd7b36eaa71`.

This Docker trial exercised assignment edits, schema compatibility, fences and
offline fallback with real image code. Its seeded job history was synthetic.
A native trial with independent bridge readback is needed for rollback after
an actual add-on publication.

### Rejected transfer and startup

Two separate disposable siblings used the post-edit backup from the pinned-image
trial. A damaged SQLite header made candidate 12's guarded recovery exit 1 and
left the new destination directory empty. A valid guarded recovery in another
volume followed by an RC3 start with its configured secret file missing exited 1.
Docker reported the container stopped with restart policy `no`. The eight-table
recovered comparison still passed. The retained good source had identical rows
and digest before and after both faults. Neither failed sibling had a network
connection or any means to change the bridge. Preserve the valid backup and
correct the failed prerequisite before trying a fresh destination.

### Populated add-on update

The [native Supervisor update rehearsal](37-supervisor-backup-recovery.md#backups-controls-and-native-restores)
covers the predecessor candidate 11 and this same candidate 12. Its established
bridge at revision 6, high-water 6, guard generation 9 and opted-in automatic
publication survived the normal healthy 11→12 update. All eight tables matched
after accounting for the three documented runtime observations. All four bridge
stores matched exactly. This is retained update evidence on a separately
populated HA OS fixture. The standalone-transfer and rollback results above use
the pinned RC3 image and their own synthetic state.

## Native transfer and two verified publications, 2026-11-27

A second rehearsal used a clean RC3 database with a deliberately opaque ID
(including Unicode and trailing spaces), one tombstone, assignment revision 3
and zero publication jobs. The actual old server ran, answered its loopback health
check, stopped and reported restart policy `no`. The fresh final backup matched
all eight source tables. Its file SHA-256 was
`d595fba3d01640a9d5029d742ca118ae74968bffb9d634d08c267ca3b126611e`.

A disposable AMD64 HA OS 18.4 / Supervisor 2026.11.0 / Core 2026.11.3 guest
had the separate bridge 0.1.5 installed, zero paired bridges and an idle inert
script. The guest had no route to the household. The installed candidate 12
was stopped and its original private state directory retained. A guarded
recovery into a new private directory matched all eight tables, including the
publisher. The first attempt stopped before transfer because it could not verify
the selected old data path. A fresh child used the independently recorded native
Supervisor data location. Both guests shut down normally.

Through the real manager sidebar, the operator paired that exact publisher with
dispatch disabled. The recovery review contained the transferred mapping.
Explicit confirmation produced one verified job at revision 1. Its independent
bridge checksum was
`61a7c0f04a074776f7116377d73f29ba7cb4c4f6faf64a0a32a6b0e352c7b3c0`.
The operator then created a synthetic tag, saved one additional assignment
and confirmed the resulting two-mapping publication. Independent HA readback
matched the manager at publication revision 2, desired assignment revision 4,
checksum `aa924539980d38663c9010927a2072b8c9433d07af938cae33ef86747adeddb3`.
Both jobs were verified, automatic publication and dispatch were disabled,
and the inert script had never run.

The add-on was stopped and its current state backed up. All eight tables matched
the stopped writer, including three assignment rows, the tombstone, four audit
records and two verified publication envelopes. The private rollback input had
SHA-256 `c6716a619b59dd69d2c245986031d4c7b268fa2c3e7e9a938d79ba4e7a628090`.
Use this **post-publication** backup and the revision-2 bridge readback together
when selecting the reverse-transfer source. The earlier revision-3 assignment
database predates the new assignment and both publication jobs.

### Recover the latest state for standalone RC3

The native post-publication backup was recovered with candidate 12's complete
schema checker into a new volume. The actual RC3 server then opened it and
answered its loopback health check. After stopping RC3 again, its eight-table
comparison against the latest backup passed. Two verified jobs, high-water 2,
the active revision-2 checksum, three assignment rows including the tombstone,
and all four audit records survived. The recovery removed restored sessions,
disabled automatic publication and advanced the guard generation to 3.

For the verified AMD64 fixture, `J63_POST` is the protected post-publication
backup volume with the selected file named `jukelet.db`. `J63_REVERSE` is a
distinct, newly created private volume with no database. Both must be owned by
10001:10001 and mode `0700`. The candidate and standalone writers must be
stopped. Before running these commands, match the backup digest and required
software identities to the handover record.

```sh
J63_CANDIDATE='sha256:ceb18116c08f59da51b8484951e32d7e9d9312bc2e7067d2e088bf19a50781e7'
J63_RC3='ghcr.io/skoglump/jukelet@sha256:2037c0154465167c626dee219453a0fd50bcb7f0bc8ce9c91baf9f4567716442'
docker run --rm --pull=never --network none --read-only --user 10001:10001 \
  --mount "type=volume,src=$J63_POST,dst=/source,readonly,volume-nocopy" \
  --mount "type=volume,src=$J63_REVERSE,dst=/target,volume-nocopy" \
  --entrypoint python "$J63_CANDIDATE" \
  -m jukelet.backup recover /source/jukelet.db /target/jukelet.db
```

For this **synthetic fixture** only, run the existing whole-state comparison from
the repository root. It emits bounded diagnostics and hashes.

```sh
docker run --rm --pull=never --network none --read-only --user 10001:10001 \
  --mount "type=volume,src=$J63_POST,dst=/source,readonly,volume-nocopy" \
  --mount "type=volume,src=$J63_REVERSE,dst=/target,readonly,volume-nocopy" \
  --mount "type=bind,src=$PWD/scripts/probe_database_transfer.py,dst=/probe.py,readonly" \
  --entrypoint python "$J63_RC3" /probe.py --fixture jukelet-m5-disposable-kvm \
  compare --mode recovered /source/jukelet.db /target/jukelet.db
```

Keep the pre-migration and post-publication backups and the recovered standalone
volume distinct. The old runtime must use its **standalone** configuration and
separately provisioned app secret. Read back the selected bridge's publisher,
active revision and checksum before considering reviewed reconciliation. A fresh
session or readback alone does not clear the guarded state.

### Core unavailable and separate add-on restart

A disposable child of the successful native migration started from the exact
stopped revision-2 database. Eight tables matched the retained final backup
before startup. Wait for Supervisor to report its running lifecycle, healthy
and supported status, and no outstanding scoped jobs before starting the app.
An earlier trial that checked health alone timed out before the outage test.

The operator stopped Core using Supervisor. The manager container remained
running with the same start identity. While Core was absent, its database still
had high-water 2, active revision 2, automatic publication disabled, assignment
revision 4 and two verified jobs. On restarting Core, fresh manager and bridge
reads agreed on the original publisher, two mappings and revision-2 checksum.
A separate add-on restart changed only the add-on's start identity and returned
the same publication evidence. The bridge stayed dispatch-disabled, the inert
script stayed idle, and the operator stopped the sole writer before shutting
down the guest normally.

### Remaining direct standalone readback

A separate native rollback trial kept the add-on stopped and recovered the
revision-2 backup for the old runtime. The isolated HA OS Docker store required
a named image reference. An initial import by configuration ID alone failed
before RC3 started. The follow-up used a local-only fixture tag and checked the
artifact before loading it. The import preserved the RC3 configuration
`03300d49…`, source revision and all nine filesystem layers. Its local
uncompressed export had manifest
`sha256:cf0a737f06a703772fbb2fc576ef19f5432b66e0637bb76adfe93e55e8eab81f`.
The earlier public OCI index and AMD64 manifest remain the distribution pins.

The named RC3 container launched and its image identity matched. The status
reader invoked inside the container exited 137 before returning an authenticated
standalone publication readback. The guest shut down normally. The exit code
does not identify the cause. The offline RC3 rollback and the separate native
bridge checks above passed, but the restored RC3 manager's own fresh observation
of that live bridge remains unverified.

For another isolated attempt, first record whether the standalone process stayed
running, its exit and termination flags, the guest's available memory, and whether
loopback health became ready. Use bounded diagnostic categories and omit service
credentials, container environments, raw request bodies and backup contents.
Once health is confirmed, read its authenticated publication status and compare
publisher, revision 2, checksum, two verified jobs and paused guards with the
independent HA readback. Keep the add-on stopped, leave the bridge untouched and
require a normal stop of RC3 before closing the disposable guest.
