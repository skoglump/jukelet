# Offline full-database transfer (#60)

This procedure transfers private SQLite operational state from the
[pinned standalone RC3 baseline](33-ha-addon-transition.md#evidence-and-compatibility-baseline)
to a **new, stopped** add-on database. It preserves exact IDs, assignments and
preferences, row versions/tombstones, retained audit, publisher identity and
publication/revision/job history. Logical schema-1 export cannot replace it.
Inventory/scan observations, Spotify metadata/artwork and review caches are in
memory; no persistence for those caches is promised.

**Current evidence:** independent source and actual HA OS verification demonstrate
the seven original #60 criteria for [corrected candidate 10](#corrected-candidate-10-observed-2026-11-01).
Fresh complete review and PR gates remain pending. Candidate 9's nominal results
remain historical: fresh review found unsupported AUTOINCREMENT/internal sequence
state could prevent normal saves, leaving AC-1/AC-6 incomplete. Candidate 8's
earlier CHECK/order failure and both original artifacts/results are preserved;
no counters are reset and no old candidate is rebuilt.

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

### Prepare the new target key before recovery

**Current guard-capable targets:** prepare their key while the new directory is
still empty, **before** recovering `jukelet.db`. Startup now refuses a missing key
beside retained DB state. The candidate 10 rehearsal below remains its original
historical evidence; this prerequisite neither rebuilds 10 nor changes that result.
The Python payload below passed local generated-private-directory checks, including
existing-target, unsafe-mode and linked-path refusal. Its current-image HA OS
container execution is pending with #61.

A standalone transfer creates a **fresh** private add-on HMAC key; it does not read
or copy the source standalone/HA credentials. An add-on restore must instead retain
the **exact** existing key through the [bounded retained-key route](37-supervisor-backup-recovery.md#pre-restore-offline-guard).
Never generate a replacement key beside retained state to bypass startup failure.
The current native-restore metadata normalization still requires the complete
existing DB/key set. It does not create a missing key or replace this fresh-key
preparation step for a new standalone-transfer target.

Use the independently verified current `J60_TARGET_IMAGE` and deliberately new
`J60_NEW_TARGET_DIRECTORY`, already UID/GID `10001:10001` and mode `0700`. Only this empty
private child is mounted; no source credential or Supervisor options are exposed:

```sh
docker run --rm -i --pull=never --network none --read-only --user 10001:10001 \
  --mount "type=bind,source=$J60_NEW_TARGET_DIRECTORY,target=/target" \
  --entrypoint python "$J60_TARGET_IMAGE" - /target <<'PY'
import os
import secrets
import stat
import sys

def require(condition):
    if not condition:
        raise ValueError("unsafe new-target key preparation")

directory = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    meta = os.fstat(directory)
    require((meta.st_uid, meta.st_gid) == (os.geteuid(), os.getegid()))
    require(stat.S_IMODE(meta.st_mode) == 0o700)
    require(not os.listdir(directory))
    descriptor = os.open("auth-secret", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        os.fchmod(descriptor, 0o600)
        value = secrets.token_urlsafe(48).encode("ascii")
        offset = 0
        while offset < len(value):
            written = os.write(descriptor, value[offset:])
            if written <= 0:
                raise OSError("private key write failed")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.fsync(directory)
finally:
    os.close(directory)
print("New private app key created and synced; value not displayed.")
PY
```

Require exit 0 and independent no-follow readback of UID/GID `10001:10001`, regular file,
mode `0600`, one link and exactly 64 ASCII bytes, recording only a protected fingerprint.
Existing/nonempty targets are refused without overwrite. Failed or interrupted
outputs remain unselected for inspection; use a deliberately new directory rather
than deleting an existing credential to retry. Retain this key with future backups.

### Recover the database after key preparation

`J60_TARGET_IMAGE` is the exact locally delivered, verified candidate image, not an
assumed published tag. Candidate 10's original build source and observed scope are
[recorded below](#corrected-candidate-10-observed-2026-11-01). Preserve original
sources, contexts and archives; later documentation commits are not its build
source and do not authorize rebuilding 10.
Source is read-only; only the new target directory is writable:

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

For a named volume mounted over the image's `/data`, initialize its ownership and
mode first and use `--mount "type=volume,source=$J60_SOURCE_VOLUME,target=/data,volume-nocopy"`.
The actual fixture exposed Docker copying the image's `0755` directory attributes
onto an empty volume; the probe correctly refused that setup. Preparing the owned
empty volume as UID 10001/`0700` and using `volume-nocopy` resolved it without
weakening permissions. The final-backup `/backup` path is absent from the image.

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

## Corrected candidate 10 observed (2026-11-01)

Independent verification demonstrated the seven original #60 criteria on AMD64,
HA OS 18.4, Supervisor 2026.10.5 and Core 2026.10.4, within the scope below. Candidate
`0.1.0-addon.10` was built **once** from these identities. This later prose is not
its build source and does not authorize a rebuild. Fresh complete issue review
and final PR gates remain pending.

| Artifact | Recorded identity |
| --- | --- |
| Build source | `2548dbd88073c2a2dfe97241841fe101aaf2d45e` |
| Build tree | `1d65a826f6f5a0745d48f3e9ce7f94c7db140ca8` |
| Build context SHA256 | `a6d7dbbd3b2e809febe1582ad9f14a6dfe86ab2d983430ae125c02194bb8b093` |
| Sealed image config | `sha256:1656e67d04ebad68bc6f0e57a8aaf99c5d067c431a74cec42cbc639ccfc347a4` |
| Original image archive SHA256 | `3eee6b63a30dafdfadf50a4232da695c268918079188774c050cc4b5e4ee68db` |
| Installed fixture registry manifest | `sha256:7bb3378892696383cc3b49a2aad87505f09c3abe7da32e0c63f24066a0bf6aaa` |
| Installed profile helper SHA256 | `682bee53cb20dc7577b73d02a40834c47fc5081c427c1cda26d47ec43e24f281` |
| Retained latest final RC3 backup SHA256 | `b32cfdefc1ea31f5ff06f0e05cfb8f6b570fd54ceb1aaa3475eacf3a9882d6a7` |

The same public RC3/C7 source remained stopped with restart `no` and exit 0. Its
verified shutdown preceded the latest final backup; no source/business-data edits
intervened during the 8/9 rehearsals. That unchanged protected backup was reused
for 10. Old 9 was gracefully stopped and its private data retained in a `0600`
archive under a `0700` directory before uninstall. Normal Supervisor installation
left 10 stopped, manual boot, watchdog off and auto-update off; only the fixture
registry host in metadata was overridden. This preservation is not Supervisor
restore or reverse rollback.

Recovery used a NEW private UID/GID 10001 target and a distinct read-only input,
with `0700` directories, `0600` files and no shared source/target inode. All eight
complete tables matched the source-derived expected recovery state **before
startup**, allowing only the specified session deletion, guard changes and job
fencing. Independent read-only recomputation from the unchanged backup confirmed
every digest. The actual target's eight-table inventory, four expected internal
autoindexes, table SQL, CHECKs and ordered columns matched C7, with no hidden
sequence/statistics tables.

Current profile regressions reject unsupported AUTOINCREMENT/internal tables,
including exhausted/unsaturated/leftover sequence state and ANALYZE statistics,
without resetting counters or rewriting schema. Ordinary-DDL/DML tests reproduce
the old accepted input's normal-save failure; both current CLIs reject it without
output or source/existing-target changes. Raw `0004`, C7, upgraded and harmless
format/BINARY/quoted/comment controls still accept normal future saves, including
the raw MAX-id/delete control and quoted/comment text containing AUTOINCREMENT.
Earlier payload-list, CHECK/literal/ASCII/BINARY and column-order regressions stay
covered. This is a bounded supported profile, not general SQL equivalence.

After startup and coordinator/independent native HA browser checks, all six
immutable tables and source-derived retained publication/history/guard fields
remained exact. The two assignments, tombstone version 2, eight audits and five
jobs persisted: four fenced, one verified; active revision 1, high-water 5, guard
generation 8 (source 7), reconciliation required and automatic/healthy publication
off. Only three ordinary publication observation/error/time fields and fresh
sessions changed after startup. The old seed was absent; fresh native sessions
increased 1→2. Server UID/GID 10001, zero capabilities, integrity and liveness 200
passed. Root `0600` options remained unreadable to the app.

Pinned TLS and native HA login/sidebar/Core connection, read-only session,
prefixed assets, canonical query 200, accepted bare-URL 404 and restored session
passed. Authentication was the browser's sole session side effect; no CSRF write,
publication/activation/reconciliation, playback or HA service was invoked. Source
tests separately cover valid old-session invalidation and CSRF. One synthetic
administrator/desktop browser does not complete #62's identity/device/write matrix.

Independent checks passed 840 backend, 121 spike/companion and 198 frontend tests,
lint/format/types/builds, standalone image/helper/security/persistence/Chromium
smoke, 20 local browser cases, 46 additional regression groups and add-on/bridge
package verification. Actual native HA OS evidence remains distinct from those
local fixtures. The original archive/config/manifest, all ten layer blob hashes
and decompressed ordered DiffIDs were independently verified. Normal Supervisor
delivery returned manifest `HEAD` 200 using verified cached layers; no cold-layer
GET or public GHCR availability is claimed. The temporary registry is off.
Supervisor is healthy/supported with empty unsupported/unhealthy lists, but still
has exactly one `no_current_backup` system issue and one `create_full_backup`
suggestion. Resolution is not fully empty.

The original 8/9 artifacts, nominal successes and failed completeness findings
below remain historical. Owner privileged access and recoverable backups are not
yet arranged. #61 Supervisor restore, #62 broader matrix, #63 reverse rollback and
#64 readiness remain separate. These results establish no household cutover,
provider/physical playback, release/publication or standalone retirement.

## Corrected candidate 9 observed (2026-11-01)

This historical nominal artifact was independently verified on AMD64, HA OS 18.4,
Supervisor 2026.10.5 and Core 2026.10.4. It was built **once** from the following
source. Later evidence-document commits are not its build source and do not
authorize rebuilding 9.

| Artifact | Recorded identity |
| --- | --- |
| Build source | `fa8bd989cef92de1e2f95b4c71708a05ac77008c` |
| Build tree | `e8ba80c6c9cd97deea669fdccdd9bebeac52df81` |
| Build context SHA256 | `827299b7e762c045118bd9713a0283b5f700b64af9bd085382f923aabf4403f7` |
| Sealed image config | `sha256:7f81e7814d761a280003d19c3212ab16113ec46e6ed596a6a0799517d5b67ac2` |
| Original image archive SHA256 | `f3bcacfb0ac461e887ef2bee3626a373aa4519d5be90b3b040a1f127e753fac2` |
| Installed fixture registry manifest | `sha256:56d945c737b8d10fa6e5cb4b4bdf0a05a79b39e1fd973e0be9415df847b1ca58` |
| Installed profile helper SHA256 | `ea285bd2214cdd3b2e9a86ff7f00133eb3a8ba737e930b84c1808d116f8aaa40` |
| Retained latest final RC3 backup SHA256 | `b32cfdefc1ea31f5ff06f0e05cfb8f6b570fd54ceb1aaa3475eacf3a9882d6a7` |

The actual public RC3/C7 writer remained stopped with restart `no`, exit 0 and
the same latest protected final backup. Its original verified shutdown preceded
that backup; no source or business-data edits intervened during the 8 rehearsal.
Old 8 was gracefully stopped and its private data retained in a `0600` archive
under a `0700` directory before uninstall. This is not Supervisor restore or
reverse-rollback evidence.
Normal Supervisor installation left 9 stopped, manual boot, watchdog off and
auto-update off, with only the fixture registry host overridden in metadata.

Recovery selected a NEW private UID/GID 10001 target from the read-only backup.
Input/target inodes were distinct, directories `0700`, files `0600`; options stayed
root `0600` and unreadable to the app. All eight complete tables matched the
source-derived expected recovery state **before startup**, permitting only the
documented guards/session/job changes. Independent read-only recomputation from
the preserved backup corroborated every digest. Fresh target schema SQL, CHECKs
and ordered column metadata matched the actual C7 input, including the installed
corrected helper identity above.

Candidate 9's bounded supported profile checked physical column order and known
CHECK forms, preserving harmless formatting/quoted identifiers/ASCII identifier
case and default or explicit BINARY semantics while keeping literal content/case
significant. Unknown/missing/additional/combined constraints fail closed; input
schema is never rebuilt or normalized. Independent ordinary-DDL tests rejected
both review reproducers through backup and recover, plus lexical/constraint
variants. Valid raw/C7/upgraded/TEXT-VARCHAR/format controls recovered, accepted
enabled drafts and queued correct desired-version 2/guard-generation 1 work through
the existing authority gate without transport. No general SQL-equivalence promise
is made.

After startup and coordinator/independent native HA browser checks, six complete
immutable tables and retained publication/guard fields still matched the expected
state. Observations/error/time and fresh native sessions were accounted for
separately: old seed absent, new sessions 1→2, four fenced jobs/one verified,
reconciliation required, automatic publication off. Server UID/GID 10001,
zero capabilities, integrity and liveness 200 passed. Native HA login/sidebar,
read-only session, prefixed assets, canonical query handling and accepted
bare-URL 404 passed. No publication/activation/playback or household action was
used to establish these results.

The original archive/config/manifest and all ten layer blobs/ordered DiffIDs were
independently verified. Normal Supervisor delivery used manifest `HEAD` 200 and
cached layers; it does not prove a fresh cold-layer download or public GHCR
availability. The temporary registry is off. Supervisor is healthy/supported,
unsupported/unhealthy lists empty, with exactly one `no_current_backup` system
issue and one `create_full_backup` suggestion. Resolution is not fully empty;
Supervisor backup/restore remains #61.

Fresh independent source checks passed 820 backend tests, 121 spike/companion,
198 frontend, lint/types/builds, standalone image/helper/security/persistence/
Chromium smoke, 20 local Ingress/lifecycle browser cases and package verification.
The native tester reported AC-1–AC-7 demonstrated at that checkpoint. Later fresh
review reproduced unsupported AUTOINCREMENT/sequence acceptance, leaving complete
AC-1/AC-6 coverage unproven despite the nominal transfer. The [current 10
evidence](#corrected-candidate-10-observed-2026-11-01) records new source and actual
proof; the failure and original 9 history are retained. Owner privileged access
and recoverable backups are still not arranged. #61 restore, #62 broader matrix,
#63 reverse rollback and #64 readiness remain separate; household deployment/
playback/cutover, public image availability and standalone retirement are not
established here.

## Observed disposable rehearsal (2026-11-01)

The coordinator executed this transfer on the owned AMD64 fixture with HA OS 18.4,
Supervisor 2026.10.5 and Core 2026.10.4. A fresh native tester independently checked
the installed artifact, retained data, permissions, source shutdown and native HA
browser behavior. This is isolated evidence for
[#60](https://github.com/skoglump/jukelet/issues/60), not a household migration.

Nominal candidate `0.1.0-addon.8` was built **once** from the following immutable source.
These identities refer to its original build, not this later evidence-document
commit. No candidate 7 or 8 rebuild is authorized by documentation changes.

| Artifact | Recorded identity |
| --- | --- |
| Build source | `29836bd5063e050bdf0b89bd785a8429c2b8f990` |
| Build tree | `aca5c48858d0b34fdc1dd85805ae8216dffa7d26` |
| Build context SHA256 | `5d0d47f83cd9173f161334c242306c5bc8d281ca75f523ffd260af5d1ba50621` |
| Sealed image config | `sha256:150299a26280b77e6dbe066058adc438b23397bf44cfdd64424396d8fbac00a2` |
| Original image archive SHA256 | `8bfef0e2e89d0be6ff994804f820bfbb1ab1a8680eb263006ed026c8784bf281` |
| Installed fixture registry manifest | `sha256:70f8b77e536bd42fb44f79d5c204ded5b4a7c580662240084161878af1816926` |
| Fresh final RC3 backup SHA256 | `b32cfdefc1ea31f5ff06f0e05cfb8f6b570fd54ceb1aaa3475eacf3a9882d6a7` |

The real public RC3 image at the pinned index above, source
`c7d105237fe16d842dde164f1470b3d5769da920`, ran the actual standalone app with
synthetic data and healthy HTTP. Its image config was
`sha256:03300d494d951fdd450b9a1e0c3c31956a58f9870797bc074ff253f4a2933ca3`.
Before the fresh final backup, readback confirmed restart `no`, running `false`,
PID 0 and graceful exit 0. Source and final-backup volumes were distinct; all
eight raw tables matched exactly and the source database bytes remained unchanged.

The old disposable add-on 7 was stopped gracefully and its app-private data
retained in a protected archive before uninstall. That archive is not Supervisor
backup/restore evidence. Normal Supervisor installation delivered 8 stopped, with
manual boot, watchdog off and auto-update off. Only the fixture registry host in
delivery metadata differed from the prepared configuration. Recovery used a
read-only final-backup input and a new writable private target, UID/GID 10001,
directories `0700`, files `0600`, with distinct input/target inodes. Supervisor's
options remained root `0600`. All eight complete tables matched the source-derived
expected recovery state **before startup**, allowing only the specified guards,
session deletion and job fencing.

After startup and both coordinator/independent native HA browser checks, the six
immutable tables remained exact. Retained publication anchor/history and guard
fields also matched the source-derived expectation; only fresh observation/error/
time fields and new authenticated HA sessions changed. There were four fenced
jobs and one verified job, no old synthetic session, reconciliation required and
automatic publication disabled. Fresh native sessions increased from one to two
during the independent browser run. The server stayed healthy at UID/GID 10001
with zero capabilities and liveness 200. Native sidebar/login, canonical prefixed
assets/query handling and the accepted fail-closed bare-URL 404 passed. No snapshot
publication, playback or household operation was performed by this rehearsal.

Normal Supervisor installation made a manifest `HEAD` request returning 200 and
reused verified cached layers. A separate coordinator immutable-manifest request
also returned 200; independent archive verification checked all ten layer blob
hashes and ordered DiffIDs. This does not demonstrate a fresh cold layer download
or public GHCR availability. The temporary delivery registry is stopped.
Supervisor reports healthy/supported, with empty unsupported/unhealthy lists;
it still reports **one `no_current_backup` system issue and one
`create_full_backup` suggestion**. Resolution is therefore not fully empty.
Supervisor backup/restore remains the separate #61 gate.

Independent committed-source verification passed `make check build` (790 backend,
121 spike/companion and 198 frontend tests), standalone image/security/persistence/
Chromium smoke, 20 local Ingress/lifecycle browser cases and integration/add-on
package preparation/verification. Fault regressions cover corrupt/unsupported/
ambiguous input, protected paths, existing/racing targets, hard interruption and
late persistence uncertainty. The discovered empty non-list payload-container
validation defect was repaired and independently rechecked; its original failure
evidence is retained. These local tests complement the actual HA OS transfer.

This historical 8 fixture established nominal transfer and guarded startup, but
its unsupported-CHECK/column-order acceptance defects left complete fail-closed
acceptance unproven. Candidate 9 provided new evidence for those repairs but later
failed its own internal-state review; [current candidate 10](#corrected-candidate-10-observed-2026-11-01)
has separate corrected evidence. The original failure/8 history remains unchanged.
This 8 evidence does not establish Supervisor restore (#61), the broader
compatibility matrix (#62), reverse rollback (#63), owner cutover readiness (#64),
household playback/cutover or a production recovery arrangement. Privileged operator access
and independent owner backup/recovery arrangements remain prerequisites.

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
