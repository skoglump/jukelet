# Supervisor backup and guarded recovery (#61)

**Native checkpoint, 2026-11-01:** actual isolated Supervisor cold backups and
app-only, pre-guarded HA-only and coherent full restores passed the observations
recorded below on once-built candidates `0.1.0-addon.11` and `.12`. Separate healthy
known-witness restart and 11-to-12 upgrade retained reviewed automatic opt-in.
Native STARTED restore guarded before publication, revoked a previously valid
session and rejected unsafe publication/activation. Final complete verification,
fresh review and PR gates remain pending; these native results are not an overall
development-loop verdict. Earlier preparation marked both images unbuilt and all
native cases pending; the dated observations below supersede that checkpoint.
Core-only tests, private tar preservation, #60 transfer and a household restore
waiver remain insufficient substitutes for this native evidence.

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
The retained-key payload below and the current candidate 12 backup/recover
container route were executed on the isolated HA OS host before HA-only restore.
Eight generated-local-directory cases also cover both key payloads' success and
refusal paths. The transfer guide's **fresh-key standalone** prerequisite was then
verified in candidate 12 Docker on HA OS: new protected key, read-only frozen C7
recovery/all eight tables, unchanged key through wrapper **prepare only**, and
populated-target refusal. No server/publisher/HA connection or second installation
ran; this is offline compatibility, not a new full migration/native fresh install.

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
it manually. Product bootstrap normalization was separately verified on untouched
native-restored state. Retain a suitable service-owned source or stop if the
prerequisites for this offline route are unavailable.

## Native selections and completion

The v1 full/app-only backup and app-only/HA-only/full restore selections below
were executed in the isolated #61 rehearsal. The names are examples, not retained
archive identifiers. Use HA's backup UI or an already authorized authenticated
operator transport. Supply the
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
| Current guard-capable app-only archive behind HA | Native replacement omits the witness. Validated private ownership/profile permits the guard to commit before publication; unsafe ownership blocks startup. A12 restored with automatic=1/eight queued jobs behind HA 15: guard 9→10, sessions revoked, jobs fenced, publish/activate rejected, HA last-good unchanged. Only explicit reviewed recovery then published revision 16. |
| HA-only | Perform the offline guard/stop/restart prevention **first**. The app witness otherwise survives and cannot recognize this route. Actual offline guard 10→11 preceded Core C restore with app 12 stopped; app data/key/options bytes stayed unchanged by HA restore. Separate first unmarked start guarded 11→12, retaining app floor 16 against HA 6. Ordinary publication/activation were rejected before reviewed forward 17. |
| Quiesced coherent app+HA | The omitted witness guards even when restored tuples match. Full C restored app/HA 6 and matching four Stores/entry/code/config/scripts, but guard 9→10 still blocked publication/activation. Independently known 17 required STOP; no reviewed recovery or counter override was attempted. |
| Normal known-witness restart/upgrade or cold-backup return | Preserve identity/history and reviewed opt-in, with ordinary fresh reconciliation and uncertainty checks. Actual restart 11, upgrade 11→12 and A12 cold return retained automatic=1/guard 9, key and witness; no unconditional recovery freeze. |
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

## Actual isolated evidence (2026-11-01)

These observations used the owned AMD64 HA OS 18.4 / Supervisor 2026.10.5 /
Core 2026.10.4 fixture, app `0.1.0-rc.3` and bridge `0.1.5`. Bridge archive SHA256
`dfa19523223d6b965478fbb813bc8c4a9b7f46da1c3c5e1c8a7d5743d4f347ed` matched all
15 installed files. Supported first pairing retained the app publisher. An expired
synthetic token's initial 401 was reconciled by normal refresh of the same
configured credential and API 200, without another install/restart. Preparation
alone established no native recovery. Later native observations follow below.

The variables-only `single` script remained off, current 0 and never triggered,
using the default profile/30-second timeout. Reviewed **Reconcile** and **Disable**
had independent disabled/not-busy/execution-clear readback. Dispatch was never
enabled; no script, provider playback or physical scan ran. The activation Store
was captured **disabled**. This does not prove restoration of a remembered-enabled
dispatcher or physical playback. The fixture's complete never-invoked history,
not script-off alone, supplied the stopped-work basis.

### Immutable images and the ownership correction

Each image was built once. These are image archives and fixture registry manifests,
not native backup archive identities or public release availability:

| Identity | Candidate 11 | Candidate 12 |
|---|---|---|
| Build source | `10c707c25304342678322c2339a22ce39a98cc11` | `052eecbef1eadd97415393761abb8580bc873aad` |
| Context SHA256 | `5213b7a9a0970a14dacd1121c007e67787a4ccc70e7436ae4c75e3f2329e7aa8` | `4f2a5612b44b7f031e3eccec666406e84bb72106abdc4b496f63a5978d5ecd90` |
| Image config digest | `sha256:a4d3b2f045c123184b997c55e67e4b04895206901605ce61d2371d214e508296` | `sha256:ceb18116c08f59da51b8484951e32d7e9d9312bc2e7067d2e088bf19a50781e7` |
| Image archive SHA256 | `db0975afe275322ff048199306b3b1f242ce3a7b5cb355785587eb86f2b2e0bf` | `1c8f05adf6437dc35b9e2fd569757315daeee14ccaa923cdcd8ce703a8bf831a` |
| Fixture manifest digest | `sha256:bd260790b44f758d953ffce70db248e2dd12d730c17b4ef268f5531ac0ab49d3` | `sha256:4627ceb5ea90b9c29f76af925fe33672e521c5e85eb3b7ce94bc30d160cf2b6f` |

Later prose is not either build source and authorizes no rebuild/repoint. Delivery
used exact cached images and only the fixture loopback registry. That registry
was left off; Supervisor was healthy/supported with no issues. This proves no
public GHCR cold pull, release or Git tag.

The earlier **stopped candidate 10** native app-only diagnostic completed with no
parent/recursive-child errors. Directory/DB/key changed from `10001:10001`
`0700`/`0600`/`0600` to `0:0` `0700`/`0644`/`0644`, files singly linked and DB/key
hashes unchanged. Its STOPPED archive supplied no guard/session/job proof. The
file-mode cause remains **UNKNOWN**; the earlier prediction that `0600` survived
was wrong. The root-owned `0700` parent protected the `0644` children.

Correction 1 at `db071bf2b318964aca9c870017db693f084c72fc` passed independent
affected checks. Candidate 11 then consumed that untouched native-restored shape:
**product bootstrap**, without manual chmod/chown or root SQLite, normalized it to
service ownership/private modes. UID/GID `10001:10001` and zero capabilities were read
back. The exact key/publisher and all eight tables survived the allowed recovery
transformation, guard 8→9, sessions revoked and outstanding work fenced. Reviewed
recovery then published revision 6 with independent HA verification. One fixture
album shuffle preference first needed a supported expected-version assignment
PUT; its opaque ID and URI were preserved. This initial unmarked adoption is
distinct from the later healthy known-witness upgrade.

### Backups, controls and native restores

The guarded 11/12 matrix used three native backups and four native restores,
completed with zero parent and recursive-child errors, corroborated by effective
app/HA readback. The matrix is
an observed fixture result, not a final independent issue/review verdict:

| Case | Actual observation |
|---|---|
| N1: adoption, restart and upgrade | After adoption/reviewed recovery 6 and C capture, separate automatic opt-in enabled publication. Healthy restart 11 and normal 11→12 upgrade retained all eight tables through bounded runtime observations, key/witness, session/cookie, automatic=1 and guard 9; no recovery freeze. |
| N2: full C11 and app-only A12 capture | C captured STARTED/manage, automatic=0, guard 9 **before first automatic opt-in**. A captured STARTED 12, automatic=1, eight queued ordinary jobs, a valid old session and reserved floor 14. Ordinary cold return retained witness/key/guard 9 and A's opt-in. D later captured highest 17, read_only/automatic=0/guard 12. |
| N3: app-only A12 behind HA | Fresh independent HA 15 was above **every** archived reserved revision 14. Supervisor itself auto-started restored STARTED 12; no manual normalization/start. Guard 9→10 revoked archived sessions and fenced all eight queued jobs, retained identity/key/history and HA 15/four Stores. The old cookie changed from protected-API 200 before backup to backend 401 on the same HA user/Ingress path/key **before GET session**; fresh manage login returned 200. Ordinary publish and activate both returned `409 recovery_required`; guarded restart retained guard 10. Only then explicit reviewed forward recovery 16 was verified. |
| N4: pre-guarded HA-only C | With app 12 stopped/restart-prevented, the documented retained-key payload plus current backup/recover CLI produced a NEW guarded target, guard 10→11, before Core restore. HA restored C revision 6/four Stores/own entry/profile/code/script; app 12 DB/key/options bytes stayed unchanged by HA restore. First unmarked start was a separate guard 11→12 retaining app floor 16. Both ordinary operations returned `409 recovery_required`; only later reviewed forward 17 was verified. |
| N5: coherent old C | Full restore reinstated app 11 and HA 6, matching old tuples, four Stores and own entry/profile/code/script. Supervisor auto-started the archived STARTED app; product guard 9→10 retained all eight tables through expected recovery and rejected ordinary publish/activate. Independent known 17 exceeded selected 6: **STOP**, no recovery request, floor setter, identity or counter reset. |
| N6: latest safe D12 return | Native full D restored candidate 12 and HA/app 17, four Stores, exact key/config and own entry/profile/code/script. Product guard 12→13 retained all eight tables through expected recovery. Final state was read_only, automatic=0, reconciliation required, dispatch disabled, execution clear and no queued/in-flight/uncertain authority. No recovery or opt-in was implied. |

The 11→12 reviewed source payload differed only at the candidate config version.
Options **bytes and effective values** were retained. An initial overbroad
whole-options-metadata equality assertion failed and is preserved: Supervisor
writes options on start, the pre-update full metadata JSON was not retained, and
no claim of complete metadata/mtime equality is made. The old 11 exit code is
**UNKNOWN**. Eight container-specific journal rows showed application shutdown
complete/finished server process and no traceback; they do not prove exit code 0.
A later A harness label-validation failure also remains recorded; it caused no
repeat of the native backup/job arming and changed no acceptance criterion.

### Archive completeness and limits

Native full C archive SHA256
`d246b8bd827ccecda714f9a67902837bf50841062322756e88d5aea58bd5b315`, app-only A
archive SHA256 `24f5fe72083aea66c7c6043d0dc17d613993989d60219b8344ce7d804255cd91`
and full D archive SHA256
`32525667a142d3562acf53eb955e808b1ea3fe6b54d1db8e3726194bc1e0d727`
were inspected through a bounded approved-member path. App archives retained
integrity-checked schema0004/all eight tables, DB/key/options and required metadata,
while omitting the continuity witness and known staging files. C/D comparisons
against prebackup state permitted only normal shutdown healthy1→0 and a bounded
observation clock; every other protected field/table stayed exact. Live ordinary
cold returns retained witnesses and their selected history/consent.

Core C/D archives matched hashes for all four **companion-owned** Store payloads,
all 15 integration files and the fixture's `configuration.yaml`/`scripts.yaml`.
The `core.config_entries` container was inspected **header only**; its payload and
other HA credential-store payloads were never read. After HA-only/full restore,
supported own-entry APIs verified matching entry ID/publisher/default profile and
30-second timeout, code hashes matched, and the inert script remained never run.
No raw `.storage` edits occurred. This ties content retention to actual effective
restore readback without claiming inspection of credential payloads.

The native archives were deliberately **unencrypted** (`protected:false`) local
synthetic fixture backups. Task files/private host copies used `0600` files and
`0700` private directories. No production encryption, off-host retention, password
custody or household recovery arrangement was established. Final read-only recheck
confirmed the original C7 standalone still stopped, restart disabled, its two
original volumes retained and latest backup hash unchanged, with protected file
permissions and no source/config mutation or source secret read. It remains a
separate rollback artifact. Household readiness, compatibility
#62, reverse transfer #63, final #64 and release/cutover/retirement remain separate.

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
