# Offline full-database transfer (#60)

This procedure transfers private SQLite operational state from the
[pinned standalone RC3 baseline](33-ha-addon-transition.md#evidence-and-compatibility-baseline)
to a **new, stopped** add-on database. It preserves exact IDs, assignments and
preferences, row versions/tombstones, retained audit, publisher identity and
publication/revision/job history. Logical schema-1 export cannot replace it.
Inventory/scan observations, Spotify metadata/artwork and review caches are in
memory; no persistence for those caches is promised.

Both databases use Alembic `0004`; no schema, wire, pairing, identity or counter
reset occurs. Recovery deletes all restored sessions, requires reconciliation,
disables automatic/healthy publication, advances the guard generation and fences
queued/in-flight/uncertain jobs. Verified/fenced jobs and every original envelope,
checksum, anchor, observation and retained history remain.

Reconciliation gates HA execution-snapshot publication/activation. Local draft
repair and independent rename retain their fresh-session, CSRF and manage gates;
this is not a freeze of every local or HA write. The separate playback bridge,
its last-good active snapshot and app-stopped playback remain unchanged. Copied
jobs are evidence, never permission to resend uncertain operations or rewind HA.

## Prerequisites and authority

The utility targets Linux Docker/add-on environments, requiring `/proc`, no-follow
directory/file operations and same-filesystem hard-link support. It rejects
corrupt/incompatible profiles, missing/ambiguous required state, unsupported schema
objects, linked/unsafe inputs and existing/racing destinations. Source files must
be regular, singly linked, trusted-owned and not writable by other users. Ordinary
standalone `0644` inputs remain supported. Selected parents cannot be writable by
other users; components are pinned without following links. Staging directories
are `0700` and output/staging files `0600`. No weaker path or overwrite fallback exists.

For the add-on use UID/GID `10001:10001`, a new private `0700` directory and `0600` files.
The operator arranges ownership of new paths; the utility does not repair source
permissions. Retain source image/config/data and separately configured app secrets,
HA bridge/config and recoverable backups. SQLite backups contain private sessions
and operational state: keep them outside Git, issues, web roots and ordinary logs.

Standalone Docker-host access and HA OS host access are separate prerequisites.
The ordinary Terminal & SSH app does not expose the host Docker/filesystem access
used below. The isolated rehearsal uses explicitly authorized privileged
developer/operator host-console access. Home Assistant's
[developer debugging documentation](https://contributors.home-assistant.io/os/operating-system/debugging/)
distinguishes this from the limited SSH app and cautions about host modification.
This is not a standard supported Terminal & SSH upload path. This task enables no
household debug SSH/keys, new add-on maps, Docker API or elevated permissions.
Authorized owner access and backup/recovery arrangements remain future deployment
prerequisites; they are not yet arranged.

Household cutover requires separate approval. Supervisor backup/restore (#61),
reverse transfer/rollback after edits (#63), and final readiness (#64) remain
subsequent gates. This procedure neither retires standalone support nor authorizes
a second household publisher/dispatcher.

## Stop the source, then take a fresh final backup

Record the source container, immutable image/digest, database/schema and volume
identities. Retain its configuration and database/WAL/SHM together. Record pending
or uncertain publication outcomes and require exact bridge readback before later
reviewed publication. Do not copy a running SQLite file or discard sidecars.

These commands run on the authorized **standalone Docker host**. Names identify
deliberately selected disposable resources, not household discovery. The distinct
backup volume must already be owned by UID 10001, mode `0700`, with no `final.db`:

```sh
J60_RC3='ghcr.io/skoglump/jukelet@sha256:2037c0154465167c626dee219453a0fd50bcb7f0bc8ce9c91baf9f4567716442'
J60_SOURCE_CONTAINER='jukelet-issue60-source'
J60_SOURCE_VOLUME='jukelet-issue60-source-data'
J60_FINAL_VOLUME='jukelet-issue60-final-backup'

docker update --restart=no "$J60_SOURCE_CONTAINER"
docker stop "$J60_SOURCE_CONTAINER"
docker inspect --format '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}} {{.Image}}' "$J60_SOURCE_CONTAINER"
```

Require `false no` and the recorded RC3 image identity. Disable any external
service/orchestrator that could restart it. **After that readback**, take the fresh
final backup using RC3's existing consistent SQLite backup API:

```sh
docker run --rm --pull=never --network none --read-only --user 10001:10001 \
  --mount "type=volume,source=$J60_SOURCE_VOLUME,target=/source,readonly" \
  --mount "type=volume,source=$J60_FINAL_VOLUME,target=/backup" \
  --entrypoint python "$J60_RC3" \
  -m jukelet.backup backup /source/jukelet.db /backup/final.db
```

Require exit 0 and integrity-checked success. If the stopped source needs unavailable
WAL state on the read-only mount, stop and resolve that prerequisite while retaining
all original files. Never discard sidecars, substitute raw copying or start another
writer. RC3's old utility lacks the new interruption-safe publication protocol:
a failed/interrupted final backup is not accepted merely because a file exists.
Keep it unselected and investigate before using a new private name.

Retain the stopped source, its image/config/data and the distinct final backup.
Never mount its database/live volume into the target app. Ordinary standalone
online backup remains supported; this migration requires its final backup after
writer shutdown and restart prevention.

## Recover into a new stopped target

On the authorized isolated HA OS host console, record the target slug, immutable
image, source/context and private directory. In HA app settings turn **Start on
boot**, **Watchdog** and **Auto update** off and read them back. Stop and confirm:

```sh
ha apps stop local_jukelet
ha apps info local_jukelet
```

`local_jukelet` is the fixture slug; a separately approved deployment uses its
recorded exact slug. There is no `ha apps options` command in this rehearsal CLI.
Operational start/watchdog/update controls differ from app option values. Do not
change Supervisor-owned root `0600` `options.json`.

Retain any existing target private state separately while stopped. Require a **new**
UID 10001, mode `0700` private directory without `jukelet.db`; never remove or overwrite a
usable DB to satisfy this check. Arranging the new selected directory requires the
separately authorized privileged operator path, retaining the prior directory
intact. Scope the writable mount to that private child, excluding options and
unrelated data. Transfer the final backup into a distinct protected input directory
on this host and verify its recorded identity/hash.

`J60_TARGET_IMAGE` is the exact locally delivered, verified candidate image, not an
assumed published tag. Candidate8 is reserved for these changes and must be built
once from validated committed source by the coordinator. Source is read-only;
only the new target directory is writable:

```sh
docker run --rm --pull=never --network none --read-only --user 10001:10001 \
  --mount "type=bind,source=$J60_TRANSFER_DIRECTORY,target=/source,readonly" \
  --mount "type=bind,source=$J60_NEW_TARGET_DIRECTORY,target=/target" \
  --entrypoint python "$J60_TARGET_IMAGE" \
  -m jukelet.backup recover /source/final.db /target/jukelet.db
```

Require exit 0, integrity-checked success and protected output ownership/mode.
The new helper completes supported-profile validation and commits all recovery
guards before publishing the final pathname exclusively. Keep both apps stopped
until offline checks finish. Source, final backup and new target must remain
separate files/volumes; never share one SQLite file between applications.

Only then start the target and verify exact image, health, permissions and durable
publication/reconciliation fences. Authenticate anew through native HA Ingress
with fresh session/CSRF. Preserve the bridge's last-good snapshot and require fresh
exact bridge readback plus existing reviewed recovery before publication or
activation. This does not authorize a household start or a new dispatcher.

## Synthetic fixture and whole-state evidence

The opt-in [probe](../scripts/probe_database_transfer.py) is only for the owned
synthetic fixture, never household backups. Mount it read-only as `/probe.py` in
the exact RC3 image. Seed uses RC3-existing storage/assignment/publication APIs,
not feature-only helpers, and starts no app/HA publisher. Its NEW DB parent must
already be owned by UID 10001, mode `0700`. The coordinator creates a synthetic auth-secret separately
and starts the real RC3 app without network, HA/provider settings or published
ports, in read-only mode. Stop/readback still precedes the final backup; seeding
alone is not evidence of stopping a running source app.

The source fixture uses `APP_AUTH_TOKEN_FILE=/data/auth-secret`,
`APP_PUBLIC_ORIGIN=http://127.0.0.1:8000`, `APP_ALLOW_INSECURE_HTTP=true`,
`APP_MODE=read_only` and `DATABASE_PATH=/data/jukelet.db`, with no
`HA_URL`, `HA_TOKEN` or `SPOTIFYPLUS_ENTITY_ID`. The synthetic secret is a private
32–128 byte ASCII file; no value appears in command output or reports.

```sh
python /probe.py --fixture jukelet-m5-disposable-kvm seed /data/jukelet.db
python /probe.py --fixture jukelet-m5-disposable-kvm observe /source/jukelet.db
python /probe.py --fixture jukelet-m5-disposable-kvm compare --mode backup /source/jukelet.db /backup/final.db
python /probe.py --fixture jukelet-m5-disposable-kvm compare --mode recovered /source/final.db /target/jukelet.db
```

Observe/compare mounts are read-only. Compare requires distinct files and compares
every field of every persisted table, not just counts. Backup permits no data
change; recovery permits exactly the documented session/fence/guard changes.
Perform both comparisons **before target startup**. Record ordinary subsequent HA
observations independently, without waiving mismatches in transfer comparisons.

The seed has exact Unicode/space/slash/decomposed IDs, two assignments including a
versioned tombstone, eight audits, nonzero counters/anchor/checksums/envelopes,
five jobs across retained states and one synthetic persisted session row. That row
proves deletion, not valid browser authentication. Existing authentication tests
separately cover old valid sessions; actual HA session/startup results must be
reported as observed. Output contains counts, hashes and guard/match booleans,
never raw IDs, session material, URIs or envelopes.

Local regression/package evidence belongs to the issue's run record. At this
preparation checkpoint the actual public-RC3/HA OS transfer and candidate8 build
remain pending; no household success or owner recovery readiness is claimed.

## Failure and operator recovery

On profile, integrity, ownership, linked-path or existing-target rejection, retain
source/backup/current deployment intact and stopped. Failure before publication
leaves no selected output. SIGKILL can leave protected `.jukelet-db-*` staging;
never select that staging file. Resolve the actual prerequisite and retry into a
deliberately new protected name.

If the CLI says **final persistence is uncertain**, a complete guarded final may
already exist or be open. Never delete/overwrite it based on exit status. Keep the
target stopped and retain all artifacts. An authorized operator checks the exact
file, integrity/guards, ownership, link count and source relationship before
selecting a new output. A kill after publication can leave a second link inside
private staging. Do not remove either file blindly or bypass the single-link
check; retain evidence and reconcile only confirmed task-owned staging while
stopped. Cleanup is not automatic or destructive.

Transfer/startup/HA failure does not authorize restarting stale source state or
clearing guards. Preserve the active HA snapshot and both data sets, keep
publication paused and use separately reviewed recovery/rollback with later #63
evidence. Independent recoverable backups and retained image/config/secrets remain
prerequisites after the fixture succeeds.
