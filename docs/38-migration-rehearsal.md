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
