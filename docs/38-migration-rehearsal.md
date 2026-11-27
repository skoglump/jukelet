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
