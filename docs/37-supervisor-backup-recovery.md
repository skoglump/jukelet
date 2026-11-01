# Supervisor backup and guarded recovery (#61)

**Preparation checkpoint, 2026-11-01:** the application guard and cold-backup
metadata are implemented. Candidate `0.1.0-addon.11` is **unbuilt**; required native
Supervisor backup/restore, healthy 11-to-12 upgrade and the recovery matrix below
are **pending**. Source tests, CLI help and source-valid REST examples do not
establish those outcomes. Independent S2 source/build and standalone checks passed;
they do not establish an installed guard-capable add-on or native recovery.
Correction 1's bootstrap normalization is committed at
`db071bf2b318964aca9c870017db693f084c72fc`; independent affected verification is
reported EARLYPASS for source checks. Actual root/native verification remains
pending. Local ownership tests model numeric UID/GID over real file operations.
The earlier Core-only restore tests, private tar preservation, #60 transfer and
household restore waiver do not satisfy #61's native evidence requirement.

This procedure requires separately authorized operator access and protected,
recoverable backups. Household operator access and backup/recovery arrangements
are **not arranged**. Nothing here authorizes household work, release publication,
cutover, two publishers/dispatchers or standalone retirement.

## What the supported backup retains

The package selects `backup: cold`. Supervisor stops a running app, archives its
private data, then starts it normally. Cold backup ignores `backup_pre` and
`backup_post`; neither is a restore hook. The required file set is:

| Data | Retention requirement |
|---|---|
| `/data/jukelet/jukelet.db` and any `-wal`, `-shm`, `-journal` sidecars | Keep the complete stopped SQLite file set; never broadly exclude sidecars |
| `/data/jukelet/auth-secret` | Keep the exact server-side HMAC key for this add-on installation |
| Supervisor-owned `/data/options.json` and archived add-on metadata | Keep required options, runtime mode and image/version identity; do not edit the options file directly |
| App assignments and operational history | All eight schema-`0004` tables, exact IDs, row versions/tombstones/audit, publisher UUID, reserved revisions, anchors and immutable jobs |

Only these app-owned names are excluded:

```text
jukelet/.supervisor-continuity
jukelet/.supervisor-continuity-*
jukelet/.auth-secret-*
jukelet/.jukelet-db-*
```

The latter three are known staging names. Supervisor matches host-path suffixes,
not container-absolute `/data` paths. Exclusion of a directory skips its contents.
The current package has no shared configuration mounts or required on-disk log
files. Backup data and options remain private even with these exclusions: protect
the archive, its decryption material and independent recovery records. Never print
keys, sessions, complete options, envelopes or archive contents into ordinary logs.

## Continuity before publisher startup

The mandatory package wrapper selects the internal continuity path. Root bootstrap
makes no SQLite connection. It validates private paths and the existing key, and
can normalize the bounded native restore metadata described below. After privilege
drop, preflight runs before migration can create a missing database; validated
recovery completes before HA transport or publisher startup.

Supervisor's actual stopped-candidate-10 diagnostic restored a root:root `0700`
private directory with root:root `0644`, regular, singly linked DB/key files.
Their bytes were unchanged. Correction 1 accepts that shape only with an absent
witness and a complete fixed DB/key set; only known DB sidecars may accompany them.
It validates the entire inventory and bounded key through held no-follow file
descriptors before changing metadata, tightens files to `0600` before assigning
UID/GID `10001:10001`, and changes/syncs the private directory last. Root `0600`
and service-owned `0600` partial progress can resume safely. Unexpected entries,
witnesses, owners/groups, links, file types or modes stop; weak service-owned
`0644` files are still refused. This is no recursive repair of `/data` or
Supervisor options. A parent-directory descriptor lock serializes bootstrap
creation/validation/key publication only; it does not support two app writers.

The private `0700` directory and `0600`, regular, singly linked files must belong
to UID/GID `10001:10001`. The bounded witness is authenticated with the existing
key and bound to the publisher UUID. A valid witness retains normal restart,
upgrade and cold-backup-return choices, subject to existing fresh HA reconciliation.
It does not clear any previous recovery or uncertainty fence.

An existing DB with validated private ownership/profile but without a witness
enters mandatory one-time guarded adoption or restore. This also applies to the
first upgrade from pre-guard candidate 10; it is not evidence of a healthy
known-witness upgrade. The transaction retains
identity, assignments, counters, anchors and history, deletes restored sessions,
suspends automatic/healthy publication, advances the guard generation and fences
queued/in-flight/uncertain jobs, including recovery jobs. The DB commit and file
persistence precede atomic witness publication and directory sync.

Malformed/mismatched witnesses, unsafe paths/ownership/links, corrupt or unsupported
profiles, missing key beside retained DB, witness beside missing DB, overflow and
persistence failure stop startup. They are not repaired or reset. Interruption
before publication can repeat the conservative guard. A kill between exclusive
witness linking and staging-link removal can leave two links: retain the evidence
and stop for authorized offline inspection; do not delete links or bypass checks.

A fresh empty installation keeps initial pairing/consent semantics. Loss of both
DB and witness can resemble first installation or interrupted preparation, even
if a key remains. Host/VM snapshots that rewind every copy, raw DB replacement
leaving a witness, or complete-directory substitution are outside automatic route
recognition. Use explicit offline guarded recovery; the witness is no universal
rollback detector.

## Quiesce a coherent recovery backup

Full Supervisor backup is sequential: Core is captured before add-ons. Cold
SQLite backup alone does not make an atomic app/HA pair.

1. Stop assignment editing and new publication intents. Suspend automatic
   publication; that alone does not fence or finish already queued work.
2. In HA, use **Jukelet bridge → Configure → Inspect and control tag playback →
   Disable dispatch**, then independently read back disabled admission. Inspect
   previously admitted scripts, nested and external work. Only after independently
   proving it stopped use the separate uncertain-work reconciliation if required.
   An idle script entity, elapsed time or restart is insufficient. Follow the
   [existing administrator procedure](23-guarded-playback-controls.md#operator-procedure).
3. Stop the app and prevent restart as described below when preparing an offline
   guarded copy. For capture, prefer keeping it stopped or running it explicitly
   `read_only`. A controlled rehearsal may retain `manage` to test the recovery
   guard after restore, provided automatic publication is off, all jobs are
   settled, editing is forbidden and independent readback proves both sides stayed
   stable through capture. No editor, publisher send or dispatcher may change the
   selected pair. Preserve unresolved outcomes instead of claiming quiescence.
4. Include matching bridge Stores `jukelet_bridge.snapshot`,
   `jukelet_bridge.history`, `jukelet_bridge.execution` and
   `jukelet_bridge.activation`, plus the paired config entry/publisher,
   profile/timeout settings, matching integration code/manifest/dependencies,
   playback scripts and dependencies, relevant tag configuration and other
   dispatcher configuration. Use supported HA backup facilities. Never read HA
   credential stores or copy/edit individual `.storage` files.
5. Retain independent protected publisher/revision/checksum/high-water and newer-edit
   evidence outside the rollback set. Record the exact app/bridge/HA versions,
   source/context/image identities, selected components, protection and location.
   Verify archive completion and selected content before calling it recoverable.

The activation Store remembers a healthy enable choice. A full restore can restore
that choice too. The app guard does not disable HA dispatch or stop scripts;
capture a recovery backup with dispatch disabled and verify disabled state again
after restore.

## Pre-restore offline guard

This is mandatory **before HA-only restore**, which leaves app data and its
witness untouched. It also supplies the explicit route for manual DB recovery.
The Python key payloads below and in the transfer guide were checked on generated
local private directories, including refusal/error cases. The container commands
are prepared operator recipes; their #61 HA OS execution has not been verified.

1. Quiesce admission/work and editing as above. In Supervisor app settings turn
   **Start on boot**, **Watchdog** and **Auto update** off, read those controls back,
   stop the selected app, and confirm it is stopped. Disable any external restarter.
   The existing fixture CLI uses `ha apps stop local_jukelet` and `ha apps info
   local_jukelet`; substitute the independently observed installed slug.
2. Retain the old private directory, image/config, DB and sidecars intact. Take a
   fresh consistent DB backup after shutdown with the existing
   [offline transfer utility](36-database-transfer.md#stop-the-source-then-take-a-fresh-final-backup).
   Keep the selected app stopped. Do not replace its running DB.
3. Prepare a **new** empty `0700`, UID/GID `10001:10001` private target directory. For an
   add-on recovery retain the **exact old key** using the bounded command below.
   Do not copy its continuity witness. For standalone-to-add-on transfer, use the
   separate [fresh-key preparation](36-database-transfer.md#prepare-the-new-target-key-before-recovery)
   instead; no standalone source secret is needed.
4. Run the verified current image's existing command, with only the input directory
   mounted read-only and the new private target writable:
   `python -m jukelet.backup recover /source/final.db /target/jukelet.db`.
   The complete [container invocation and failure rules](36-database-transfer.md#recover-into-a-new-stopped-target)
   apply. Require exit 0, integrity/profile success, comparison of all eight tables and
   durable reconciliation=1, automatic=0, healthy=0, revoked sessions and fenced
   outstanding work **before** performing HA restore.
5. Through the authorized privileged operator path select the new private child
   for the stopped app, preserving the old directory separately. Keep Supervisor
   options outside it unchanged and preserve one writer. Do not start the app
   until the selected HA restore and effective readback are reconciled.

`J61_CURRENT_IMAGE`, `J61_OLD_STATE_DIRECTORY` and `J61_NEW_TARGET_DIRECTORY` must
identify the independently verified current image and protected, non-linked
private directories. This copies only the app key, with no network or HA access:

```sh
docker run --rm -i --pull=never --network none --read-only --user 10001:10001 \
  --mount "type=bind,source=$J61_OLD_STATE_DIRECTORY,target=/source,readonly" \
  --mount "type=bind,source=$J61_NEW_TARGET_DIRECTORY,target=/target" \
  --entrypoint python "$J61_CURRENT_IMAGE" - /source /target <<'PY'
import os
import stat
import sys

def require(condition):
    if not condition:
        raise ValueError("unsafe private key preparation")

source = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
target = os.open(sys.argv[2], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    for directory in (source, target):
        meta = os.fstat(directory)
        require((meta.st_uid, meta.st_gid) == (os.geteuid(), os.getegid()))
        require(stat.S_IMODE(meta.st_mode) == 0o700)
    require(not os.listdir(target))
    key = os.open("auth-secret", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source)
    try:
        meta = os.fstat(key)
        require(stat.S_ISREG(meta.st_mode) and meta.st_nlink == 1)
        require((meta.st_uid, meta.st_gid) == (os.geteuid(), os.getegid()))
        require(stat.S_IMODE(meta.st_mode) == 0o600)
        with os.fdopen(key, "rb", closefd=False) as stream:
            value = stream.read(131)
        require(len(value) <= 130 and 32 <= len(value.rstrip(b"\r\n")) <= 128)
        require(value.rstrip(b"\r\n").isascii())
    finally:
        os.close(key)
    output = os.open("auth-secret", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=target)
    try:
        os.fchmod(output, 0o600)
        offset = 0
        while offset < len(value):
            written = os.write(output, value[offset:])
            if written <= 0:
                raise OSError("private key write failed")
            offset += written
        os.fsync(output)
    finally:
        os.close(output)
    os.fsync(target)
finally:
    os.close(target)
    os.close(source)
print("Retained private app key copied and synced; value not displayed.")
PY
```

Require exit 0 and independently verify protected owner/mode/single-link metadata
and equal source/target key fingerprints without printing values. Keep failed or
interrupted outputs unselected; never overwrite them to force success. An offline
recovery followed by first unmarked startup can advance the guard again. Record
each transition against its own protected baseline; never adjust a counter to fit
an expected comparison.

This retained-key command requires an intact service-owned source directory/key.
It does not read a raw root-owned restored directory through UID 10001 or repair
it manually. The current product's bounded bootstrap normalization requires its
own actual verification; retain a suitable known-good source or stop if the
prerequisites for this offline route are unavailable.

## Native selections and completion

These are **source-verified v1 request shapes, not executed #61 results**. Use HA's
backup UI or an already authorized authenticated operator transport. Supply the
verified archive/installed slug, protected location and required password privately;
examples omit secrets and must not be mistaken for configured protection.

| Operation | Method/path | Selection body |
|---|---|---|
| Full backup | `POST /backups/new/full` | `{"name":"synthetic-full-reference","background":true,"compressed":true,"homeassistant_exclude_database":false}` |
| App-only backup | `POST /backups/new/partial` | `{"name":"synthetic-app-reference","background":true,"compressed":true,"homeassistant":false,"addons":["local_jukelet"],"folders":[]}` |
| App-only restore | `POST /backups/BACKUP_SLUG/restore/partial` | `{"background":true,"homeassistant":false,"addons":["local_jukelet"],"folders":[]}` |
| HA-only restore | `POST /backups/BACKUP_SLUG/restore/partial` | `{"background":true,"homeassistant":true,"addons":[],"folders":[]}` |
| Full restore | `POST /backups/BACKUP_SLUG/restore/full` | `{"background":true}` |

V1 uses `addons`, even where current UI terminology says apps. Full restore
requires a full archive and accepts no component selections. No supported
`no_start` override exists. `homeassistant_exclude_database` controls Core's
recorder DB, not Jukelet SQLite. Partial restore can also restore available
Supervisor mount/Docker configuration; empty add-on/folder selections are not a
promise of no other Supervisor effects.

Submit once. A background receipt's `job_id` is not success or necessarily an
archive slug. Poll `GET /jobs/JOB_ID`, check terminal state and **every recursive
child job's errors**. For backup, reconcile its reference/slug with
`GET /backups/SLUG/info`, selected content/version/protection/location and actual
required-file retention. After restore, independently verify Supervisor/Core/app
state, exact image/version, DB/key/options retention and effective guards. Do not
dump complete add-on info/options into logs.

After lost transport, reconnect read-only and reconcile the retained job or
`GET /jobs/info`, archive reference and effective state. Jobs are transient and
can disappear after Supervisor restart or retention expiry. Missing job, done=true,
100% progress, empty parent errors or a transport acknowledgment alone do not
prove success. Unknown outcome means stop, not resubmit restore.

## Restore outcomes and reconciliation

| Case | Required outcome and operator boundary |
|---|---|
| Current guard-capable app-only archive behind HA | Native replacement omits the witness. Validated private ownership/profile must permit the guard to commit before publication; unsafe ownership instead blocks startup. Retain HA's last-good snapshot and fresh same-publisher observed floor. Compare newer protected edits, then use reviewed forward recovery. Actual proof pending. |
| HA-only | Perform the offline guard/stop/restart prevention **first**. The app witness otherwise survives and cannot recognize this route. Restore only Core selection, keep app stopped through HA readback, inspect coherent bridge state and disabled dispatch, then start guarded/read-only. Actual proof pending. |
| Quiesced coherent app+HA | The omitted witness guards even when restored tuples match. Restore the four Stores with their matching entry/code/config/scripts, verify disabled admission and independently known floors/newer edits. Equal old tuples do not prove no joint rollback. Actual proof pending. |
| Normal known-witness restart/upgrade or cold-backup return | Preserve identity/history and reviewed opt-in, with ordinary fresh reconciliation and uncertainty checks; no unconditional recovery freeze. Actual 11-to-12 distinction pending. |
| Pre-guard/unknown archive image, corrupt or partial state, missing key or unknown safe floor | Stop. No identity/counter reset, store deletion, re-pairing or guessed high-water. |

Supervisor restores archived metadata and image/version too. An archive recorded
STARTED can launch that archived app in a finally path, including on partial
failure; stopping the target or setting manual boot does not prevent it.
**Do not directly restore an archive-only pre-guard image.** Current code cannot
protect old code retroactively. An independently consistent DB backup plus its
retained add-on key can use the current-image offline route above without running
the old image. Archive-only recovery is blocked until a validated selective offline
data path, compatible image/metadata/key, consistency and safe floor exist. No
generic extraction/upload utility is provided here; retain the old backup.

After any supported restore authenticate afresh and read actual bridge
publisher/revision/checksum/persistence independently. With intact same-publisher
history and a proven safe floor, use existing **Review publication recovery** and
exact healthy readback of its new higher revision. Degraded history requires the
existing [companion Configure recovery](../companion/README.md#recovery-and-replacement)
only where its intact history supports it; missing/inconsistent history requires
a known coherent HA backup. Unknown newer edits or a known floor beyond available
app/HA history means **STOP**, even if old tuples match. There is no manual-floor
API here: select suitable intact protected data/history or remain blocked.
Automatic publication and dispatch each require separate fresh opt-in/review.

## Observed preparation and pending native evidence

The owned AMD64 fixture is HA OS 18.4 / Supervisor 2026.10.5 / Core 2026.10.4. Bridge
0.1.5 was installed from archive SHA256
`dfa19523223d6b965478fbb813bc8c4a9b7f46da1c3c5e1c8a7d5743d4f347ed`, with all 15
installed files checked. A readiness helper's expired synthetic token returned 401;
normal refresh of the same configured credential reconciled API 200 without another
install/restart. Supported first pairing then read back the retained app publisher,
loaded entry, empty persistence and dispatch off. This involved no script/profile,
publication or dispatch enablement and is **not backup/restore or positive publication
control proof**. At that first-pairing checkpoint candidate 10 was read-only/guarded.
Required native backup/restore results with the new guard remain pending.

Later preparation added one variables-only, `single` inert script. Independent
readback showed it off, current 0 and never triggered, with the default profile and
30-second timeout configured. The fresh fixture's complete never-enabled/never-invoked
history supplied the stopped-work basis; script-off alone was not that basis.
Supported reviewed HA options **Reconcile** then **Disable** each had independent
readback: dispatch false, busy false, execution uncertainty false and unchanged
publisher/snapshot identity. Only the two companion-owned execution/activation
Store hashes were recorded, without Store bodies, credential-store access or raw
edits. No script was invoked and dispatch was never enabled. These are fixture
preparations, not native restore-guard or positive publication-control acceptance.

| Prepared companion Store | SHA256, fixture only |
|---|---|
| `jukelet_bridge.execution` | `e30f1c50993d6376c0501a4c32b996d4ddc82841330635c98b5c1af051076d07` |
| `jukelet_bridge.activation` | `2deddbb6e69c440315da8b4d329829d4558e26b1762d4d414b977fd64edab314` |

The actual native **stopped candidate 10** app-only backup/restore diagnostic completed with
no reported parent/child job errors. Before backup, directory/DB/key were
`10001:10001` with `0700`/`0600`/`0600`; after restore they were `0:0` with
`0700`/`0644`/`0644`, files singly linked. DB/key hashes matched. Archived STOPPED
state remained stopped: no post-restore guard/session/job proof was obtained.
Supervisor source uses ordinary `copytree`/`copy2` without preserving UID/GID;
the cause of the observed file-mode widening remains **UNKNOWN**. The earlier
prediction that `0600` would survive is superseded by these numeric observations.
The root-owned `0700` parent protected its `0644` children before bootstrap.

Local correction tests cover metadata normalization and guard continuity; actual
root bootstrap, service ownership, key/DB retention and committed guard still
need verification in the once-built current image. No manual chmod/chown may
manufacture the native result. Startup rejection by old code alone does not prove
session revocation or job fencing.

The planned native matrix remains entirely **NOT RUN**:

| Case | Required observation |
|---|---|
| N1 | Corrected candidate 11 adoption and permitted reviewed publication; after C capture, separate automatic opt-in, healthy restart and known-witness 11-to-12 upgrade retain consent/history |
| N2 | Quiesced full C on candidate 11 **before first automatic opt-in**, then STARTED app-only cold A on candidate 12 with actual stored opt-in, pending ordinary jobs and valid old session; required files/omissions and normal backup return verified |
| N3 | HA advances above every archived job; native A auto-start restore normalizes metadata, guards, revokes old cookie before bootstrap, rejects publish/activate and preserves HA last-good state |
| N4 | Before HA-only C restore, current app is stopped/restart-prevented and offline guarded; separate offline and first-unmarked guard transitions retain newer app history |
| N5 | Coherent old C restores matching old tuples/four Stores; independent newer ledger establishes **STOP**, with no recovery/floor/reset bypass |
| N6 | Native newest safe full D from candidate 12 returns to the known latest lineage while leaving app guarded/read-only, automatic off and dispatch off |

All cases require exact source/image/archive/HA identities, complete table
retention and independent effective HA readback. Images 11 and 12 remain
unbuilt. No physical scan/playback is needed for these publication guards.

The read-only [state probe](../scripts/probe_addon_state.py) requires
`--require-continuity` for current witness proof; legacy absence is explicitly
reported unverified. The [whole-state probe](../scripts/probe_database_transfer.py)
keeps `backup`/`recovered` comparisons exact. `recovered-running` accounts for
disjoint fresh session rows and hashed observation/error/time changes; all other
anchors/job fields stay strict. Its derived floor is only a stored observation:
`independent_ha_verified:false` must be corroborated through real fresh bridge
readback. Probe PASS, source tests or first pairing alone never establish native
restore acceptance.

For session-revocation evidence, test the retained old cookie on a protected API
before any GET session/UI bootstrap can replace it. Corroborate the same HA user
and Ingress path plus removed archived session rows; path rebinding alone is not
revocation proof. Guard-rejection checks require manage mode and a ready,
same-publisher bridge: `403` from read-only mode or unavailable/misconfigured HA is not
`409 recovery_required` evidence.

Pinned source facts: [Supervisor cold lifecycle, exclusion and restore](https://github.com/home-assistant/supervisor/blob/fdba115f215c61f7a02c7c0567263785cfcf0034/supervisor/apps/app.py#L1439-L1778),
[sequential restore/selection](https://github.com/home-assistant/supervisor/blob/fdba115f215c61f7a02c7c0567263785cfcf0034/supervisor/backups/manager.py#L731-L984),
[v1 backup schemas](https://github.com/home-assistant/supervisor/blob/fdba115f215c61f7a02c7c0567263785cfcf0034/supervisor/api/backups.py#L126-L181)
and [job trees](https://github.com/home-assistant/supervisor/blob/fdba115f215c61f7a02c7c0567263785cfcf0034/supervisor/api/jobs.py#L27-L120).
