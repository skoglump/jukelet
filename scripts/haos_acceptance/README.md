# Disposable native acceptance helpers

These files are test infrastructure for the fixed
`jukelet-m5-issue62-matrix-kvm` VM. They are excluded from the add-on build context
and the separately packaged bridge. Never install the fixture component in a
household HA configuration. Local tests do not establish native acceptance.

`python -m scripts.haos_acceptance validate CONFIGURATION` checks declarations and
private input metadata only. The configuration must be a direct child of
`/tmp/jukelet-issue62-matrix-control` (mode `0700`). Its regular file must be
single-link, owned by the current user and mode `0600`. It declares:

```json
{
  "schema_version": 1,
  "fixture": "jukelet-m5-issue62-matrix-kvm",
  "synthetic": true,
  "origin": "https://127.0.0.1:18223",
  "proxy_origin": "https://127.0.0.1:28223",
  "qmp_socket_file": "qmp.sock",
  "admin_credentials_file": "credentials-admin.json",
  "denied_credentials_file": "credentials-denied.json",
  "certificate_file": "fixture.crt",
  "candidate": {
    "source_commit": "EXACT_40_LOWERCASE_HEX",
    "context_sha256": "EXACT_64_LOWERCASE_HEX",
    "image_config_digest": "sha256:EXACT_64_LOWERCASE_HEX",
    "image_manifest_digest": "sha256:EXACT_64_LOWERCASE_HEX"
  },
  "bridge": {
    "source_commit": "EXACT_40_LOWERCASE_HEX",
    "archive_sha256": "EXACT_64_LOWERCASE_HEX"
  }
}
```

Replace identity placeholders with recorded immutable identities; they are
deliberately invalid inputs. `proxy_origin` may be `null`. References are fixed-root
basenames. Credential files require private regular single-link metadata; this
command does not read their values. The certificate may be `0600` or `0644` within
the private root. The QMP socket must be owned and inaccessible to group/others.
This command neither contacts QMP/HA nor proves the declared artifact identities.
Its report explicitly retains `native_acceptance: NOT_RUN`.

The coordinator separately installs the three files under
`fixture/custom_components/jukelet_acceptance/` in the new disposable HA config and
adds this explicit YAML opt-in:

```yaml
jukelet_acceptance:
  fixture: jukelet-m5-issue62-matrix-kvm
  synthetic: true
```

The component refuses existing SpotifyPlus services or its synthetic entity.
It registers six bounded synthetic metadata services, with no provider account,
network client or image URL. Set the app's metadata entity option to
`media_player.jukelet_acceptance`. Actual HA loading and Supervisor-issued
credential authorization must be recorded separately; they are not proved by
these local tests.

The authenticated administrator-only `jukelet_acceptance/control` WebSocket command
supports only `action: status`, `action: metadata` with mode `fresh`, `unavailable`
or `malformed`, and `action: scan` with one of the exact `policy.TAGS`. Scans use
the supported HA tag producer and the fixed synthetic reader. It does not enable
dispatch, configure a bridge profile or publish a snapshot.

`policy.script_document()` returns the exact configuration for
`script.jukelet_issue62_inert`: variables followed by a correlated v1 stop response.
There are no service, network, media or nested-script actions. The fixture observes
only calls to that script, retains at most 32 strictly synthetic requests and counts
unexpected requests without retaining their values. Combine this independent
fixture observation with bridge-correlated completion and idle/fence readback;
neither proves household playback. The status always reports independent playback
verification as unavailable.

## Initial native browser phase

After the coordinator has verified the named VM, installed the exact artifacts and
configured the app in `manage` mode, run:

```sh
node scripts/haos_acceptance/browser.mjs read-only \
  /tmp/jukelet-issue62-matrix-control/acceptance.json --seed-expiry
```

The phase performs read-only operations against the manager. It checks the actual
QMP name/running state, verifies CA and hostname, pins Chromium to that certificate's
SPKI, then uses normal HA login and the sidebar. Only same-origin reads, HA login
POSTs and the side-effect-free metadata preview POST are permitted. The real HA
WebSocket is transparently forwarded; no responses or identity are fabricated.
Playwright is imported only when this explicit phase runs. Local backend tests and
module imports work without frontend/browser dependencies.

The two dedicated browser credential files have exactly these fields:

```json
{
  "schema_version": 1,
  "fixture": "jukelet-m5-issue62-matrix-kvm",
  "synthetic": true,
  "origin": "https://127.0.0.1:18223",
  "role": "administrator",
  "username": "GENERATED_SYNTHETIC_USERNAME",
  "password": "GENERATED_SYNTHETIC_PRIVATE_PASSWORD"
}
```

Use the generated actual administrator for `administrator`, and a separately
created actual nonadministrator for `denied`. Never add API access/refresh tokens.
The browser phase reads only the selected dedicated file after VM/TLS checks;
public output contains no password, cookie, CSRF token, raw user ID or Ingress URL.
The denied identity and later manager/security/restart scenarios are separate
phases; this initial checkpoint does not claim them.

`--seed-expiry` is optional and explicit. It captures only the exact generated app
cookie and the secure, Strict `ingress_session` cookie for `/api/hassio_ingress/`,
then closes the browser completely. Only after closing does it exclusively create
private `expiry-seed.json` (schema 2) in the fixed control root, with those two
cookies and corresponding identity/path/deadline metadata. Existing seeds are never
overwritten. It exports no full browser storage or HA access/refresh token.

Supervisor 2026.10.5 uses a
[15-minute sliding session lifetime](https://github.com/home-assistant/supervisor/blob/fdba115f215c61f7a02c7c0567263785cfcf0034/supervisor/ingress.py#L134).
Proxied requests renew it, and the HA frontend parent
[validates its session every minute](https://github.com/home-assistant/frontend/blob/901c0a61ad44c7f52f50a986f6b5a81371f97a0a/src/panels/app/ha-panel-app.ts#L229).
The browser's closing time is therefore a conservative last-touch upper bound for
the captured Supervisor credential O. The public report contains only hashes and
timestamps, including replay-not-before **16 minutes after closure**, with natural
Supervisor expiry **PENDING**. It does not claim eight-hour app-session expiry or
spontaneous expiry while a live parent keeps renewing its credential.

After the recorded deadline, the separate opt-in phase is:

```sh
node scripts/haos_acceptance/browser.mjs expiry-replay \
  /tmp/jukelet-issue62-matrix-control/acceptance.json
```

It validates the exact private seed schema, configuration identity and conservative
deadline before QMP, TLS, credential values or browser activity. An early invocation
fails with `expiry_replay_too_early`; it does not wait or retry. Use the original
configuration and same actual administrator. The phase first establishes a normal,
independently valid context N through HA login/sidebar and repeats the positive
native manager, metadata and asset checks. It binds the same principal and prefix,
requires fresh N cookies, and replaces only N's Supervisor cookie with retained O.
It makes no test request after injection: the first completed O-bearing ordinary
protected GET (inventory, connection, publication, playback or capabilities poll)
must receive the actual
[Supervisor 401 before forwarding](https://github.com/home-assistant/supervisor/blob/fdba115f215c61f7a02c7c0567263785cfcf0034/supervisor/api/ingress.py#L175),
then remove the manager DOM without a standalone form. The report records endpoint
categories, request ordering and cookie hashes. A prior in-flight N response cannot
satisfy the denial; O returning success, changed app cookies, unexpected reads or
session bootstrap fail the case. No response body, raw header, URL, stack or HAR is
retained. The before-app location is a **source-backed causal inference** from the
only-cookie change and pinned Supervisor validation code; the harness does not
claim to observe an app-backend denial log.

The negative case ends at denial and the DOM fence, then closes the browser without
clicking “Check access again,” changing credentials/transports or retrying through
another account. The original seed remains unchanged. This is a
**natural Supervisor-expired-credential replay**,
with no clocks, database rows or API responses altered. It is not a natural
eight-hour app-backend expiry claim. A future app-cookie expiry probe must also
distinguish lookup expiry from expired-row cleanup by any new session creation.
Actual native results and all remaining criteria require separate retained evidence.

## Native manager editing checkpoint

The coordinator first creates and independently reads back a full backup of the
**new issue62 disposable fixture**, retains a protected copy, verifies the same
candidate/bridge identity and two distinct actual HA administrator identities, and
writes private `manager-ready.json` in the fixed control root. Its exact fields are:

```json
{
  "schema_version": 1,
  "fixture": "jukelet-m5-issue62-matrix-kvm",
  "synthetic": true,
  "origin": "https://127.0.0.1:18223",
  "configuration_A_sha256": "64_LOWERCASE_HEX",
  "configuration_B_sha256": "64_LOWERCASE_HEX",
  "actual_candidate_image_manifest_digest": "sha256:64_LOWERCASE_HEX",
  "actual_bridge_archive_sha256": "64_LOWERCASE_HEX",
  "backup_id_sha256": "64_LOWERCASE_HEX",
  "backup_artifact_sha256": "64_LOWERCASE_HEX",
  "backup_readback_verified": true,
  "backup_protected": true,
  "admin_A_user_id_sha256": "64_LOWERCASE_HEX",
  "admin_B_user_id_sha256": "DIFFERENT_64_LOWERCASE_HEX",
  "automatic_publication_disabled": true,
  "dispatch_disabled": true,
  "observed_at": "ACTUAL_UTC_ISO_TIMESTAMP"
}
```

This file must be a direct child with mode0600, current owner, one link and no
symlink in the mode0700 control root. Its observations must be no more than one
hour old both at preflight and before enabling the write gate. Configurations A/B
must match except for the dedicated administrator credential reference. The
receipt is a coordinator declaration bound to the recorded artifact/configuration
hashes; the driver does not call backup APIs or read backup contents.
`backup_protected` means a task-owned mode0700 directory/mode0600 archive plus
matching hash and supported backup readback. It makes no encryption, off-host,
household backup or recovery-readiness claim.

After those prerequisites, run:

```sh
node scripts/haos_acceptance/browser_manager.mjs manager-edit \
  /tmp/jukelet-issue62-matrix-control/acceptance.json \
  /tmp/jukelet-issue62-matrix-control/acceptance-admin2.json
```

Both independent browsers use the same normal HA login/sidebar/native bootstrap,
CA/hostname/SPKI validation and outside-request guards as the read-only phase.
Actual session UID hashes must match the two different administrators in the
receipt. Before any writes, both contexts independently read fresh publication
and playback diagnostics: automatic publication and dispatch must be off, with no
jobs, busy invocation or prior attempt. Initial assignments must be empty at
revision0; the two exact synthetic registered tags must be present.

The checkpoint uses real UI controls for album creation, metadata lookup, explicit
HA rename and separate B name readback; B then saves an edit, and A's stale save
must return actual409 while retaining its input and disabling Save. A deliberately
reloads and resaves. The playlist flow creates, disables, confirms removal and
deliberately recreates its assignment. Every write is granted once for an exact
fixed synthetic target, canonical URI, preference set, expected name and CAS
version. Extra fields, altered IDs, duplicate JSON keys, other frames, implicit
retries and all publication/restore/dispatch writes are blocked.

The pristine manager flow disables every write gate immediately after its final
write and before any failure cleanup awaits a browser close. A pending grant is
retained as uncertain evidence while disabled; even an exact late request is
refused during or after an unconfirmed close.

There are nine bounded writes (A8/B1), including the rejected conflict; seven
successful assignment changes produce final saved revision7, album version3 and
playlist version4. Both contexts read the final exact IDs/URIs/preferences back.
The active HA publisher/revision/checksum must remain unchanged, with auto and
dispatch still off and playback independently unverified. Each closed context
gets its own strict network assessment; parent warnings are never combined into
an all-zero claim. Only hashes, finite operation categories, versions, statuses
and timestamps are reported.

This mutation checkpoint is **initial/minimum-Core/pristine only**; those versions
are not a universal replay baseline. Its report records starting revision0 and
seven relative successful assignment increments, plus a digest of each final
native assignment snapshot. Later version checks must preserve the same populated
VM and compare normal native reads to the known final snapshot/identity/floor
evidence retained after all minimum-version operations. This read-only comparison
is a prerequisite for the later required manager/security compatibility checks,
not a replacement for them. Replaying the full editing sequence requires a separate
explicit starting-state receipt binding the known synthetic snapshot, versions
and global revision, then relative CAS increments. That mandatory follow-up is
not implemented by this initial checkpoint;
unknown existing state is never silently adopted. Do not reset the database,
downgrade a populated Core, or rewrite stored revisions to rerun this command.

The command makes no mutation retries and does not reset or restore state after a
failure. Retain its report and have the coordinator inspect actual outcomes before
deciding a bounded continuation; rerunning a partial operation sequence will fail
the pristine-baseline prerequisite. Export/upload/restore, publication, provider
fallback after its actual cache TTL, lifecycle/mobile/proxy and version matrix
remain separate checkpoints. Local helper tests do not establish native success.

## Read-only diagnosis of the interrupted manager run

The first native manager attempt timed out without a retained final report. The
coordinator independently reconciled saved revision2: one exact album assignment
at version2, disabled and unshuffled; the playlist remains absent at version0; the
HA label is the fixed synthetic renamed label. Automatic publication and dispatch
remain off, with no jobs or playback attempt and an empty active snapshot. This
partial state does not prove that A's stale request returned409 or that its editor
was retained. The old browser contexts are closed. The timeout cause remains
**UNPROVEN**; no application/bridge behavior change follows from it.

For a bounded read-only observation, the coordinator writes a second exact private
receipt, `manager-diagnostic-baseline.json`, with these nine flat fields:

```json
{
  "schema_version": 1,
  "fixture": "jukelet-m5-issue62-matrix-kvm",
  "synthetic": true,
  "origin": "https://127.0.0.1:18223",
  "configuration_A_sha256": "64_LOWERCASE_HEX",
  "configuration_B_sha256": "64_LOWERCASE_HEX",
  "publisher_id_sha256": "64_LOWERCASE_HEX_FROM_RECONCILIATION",
  "source_reconciliation_sha256": "64_LOWERCASE_HEX",
  "observed_at": "ACTUAL_RECONCILIATION_UTC_TIMESTAMP"
}
```

The same private ownership/mode/link rules apply. Both receipts must be no more
than one hour old at preflight and before native state inspection; never change a
timestamp without a new actual observation. The initial protected backup remains
a backup of state0, with no claim that it covers partial state2. This diagnostic
does not create a backup or restart/configure anything.

```sh
node scripts/haos_acceptance/browser_manager.mjs manager-diagnose \
  /tmp/jukelet-issue62-matrix-control/acceptance.json \
  /tmp/jukelet-issue62-matrix-control/acceptance-admin2.json
```

This phase creates two new normal HA administrator contexts, keeps both write
gates **disabled**, and independently checks the exact known partial state,
publisher identity, current HA name through the UI's read-only “Check HA name,”
disabled assignment values, fresh auto/dispatch guards and unchanged snapshot
digests. It closes both browsers and assesses their network boundaries separately.
It cannot continue the interrupted mutations or reconstruct the old A editor.

STDOUT contains one final safe JSON report. STDERR streams only recognized
`native_progress` JSONL records with schema_version1, monotonic sequence/elapsed_ms,
finite role/stage/operation/checkpoint/category enums, and optional integer status
or count. Header events are recorded before response-body parsing; body completion,
DOM and zero-write-ledger events follow independently. No URL, query, request/body
value, header, cookie, raw error, stack, HAR or WS message is included. The
coordinator must stream both outputs to its private mode0600 files from launch and
retain partial output on outer timeout. Unrecognized STDERR is private evidence;
publish only its hash, not its raw contents.

Fetches have a 10-second abort signal; native browser reads/evaluations have
15/25-second outer bounds, and body reads have a 15-second bound. Browser launch
is bounded at 20seconds, ordinary actions at 15seconds, and public browser close at
5seconds. Cleanup is memoized: an unconfirmed close is never retried and always
fails the phase with `cleanup_confirmed:false`. The CLI flushes its failure report
and exits1 in that case; this is not proof that Chromium exited. The coordinator
must still verify recorded owned descendants and limit any cleanup to that owned
process tree. Outer timeout is always failure, even if a report was printed.

A successful read-only diagnostic only establishes its current observations. It
does not resolve the earlier cause by itself or complete the issue. Any later
mutation continuation requires a new protected current-state backup, an explicit
known-partial baseline and coordinator assignment. Never replay the pristine
command, reset history or pretend the destroyed stale editor survived.

## Explicit continuation from the known partial state

After the coordinator creates and reads back a **new protected full backup of
partial state2**, it archives the prior readiness receipt and refreshes
`manager-ready.json` with that actual backup's identity/hash. It also writes private
`manager-continuation-baseline.json`, with exactly these eleven fields:

```json
{
  "schema_version": 1,
  "fixture": "jukelet-m5-issue62-matrix-kvm",
  "synthetic": true,
  "origin": "https://127.0.0.1:18223",
  "configuration_A_sha256": "64_LOWERCASE_HEX",
  "configuration_B_sha256": "64_LOWERCASE_HEX",
  "publisher_id_sha256": "64_LOWERCASE_HEX",
  "assignment_snapshot_sha256": "64_LOWERCASE_HEX_FROM_BOTH_ACTUAL_DIAGNOSTIC_READS",
  "source_diagnostic_report_sha256": "64_LOWERCASE_HEX",
  "current_backup_artifact_sha256": "64_LOWERCASE_HEX_MATCHING_REFRESHED_READY_RECEIPT",
  "observed_at": "ACTUAL_CURRENT_OBSERVATION_UTC_TIMESTAMP"
}
```

The fixed-root ownership/mode/link rules and one-hour observation bounds apply.
The driver binds both configuration hashes and the backup hash to the refreshed
readiness receipt. The prior report hash is coordinator-supplied provenance;
current native reads independently establish the actual state. It first repeats
the normal two-administrator preparation with write gates disabled, requiring the
exact two registered tags, revision2/album2 disabled/playlist0/old fixed label,
publisher identity and identical snapshot digest in both contexts. Receipt age is
checked again before enabling writes and before **every** grant. No state is
adopted or reset when a comparison fails.

```sh
node scripts/haos_acceptance/browser_manager.mjs manager-continue \
  /tmp/jukelet-issue62-matrix-control/acceptance.json \
  /tmp/jukelet-issue62-matrix-control/acceptance-admin2.json
```

This bounded sequence changes the label to the one additional fixed synthetic
value, `Jukelet62 synthetic verified rename Å`, then independently checks it from B
and verifies the assignment remains version2. Both fresh editors started at2. B
deliberately enables the album, producing3; A's version2 save requests disabled
with shuffle on and must return actual409. A must retain those unsaved values,
disable Save and leave B's version3 unchanged. A then deliberately reloads3,
reviews the current enabled/unshuffled values and saves canonical preferences at4.
This is new concurrency evidence; it makes no claim about the destroyed old A
editor or original timeout cause.

The playlist flow creates1, disables2, confirms removal at tombstone3 and
deliberately recreates4. There are eight one-shot write attempts, A7/B1, including
one rejected conflict and one label change; six successful assignment changes
advance the saved revision from2 to8. Both actual contexts must read album4 and
playlist4 back with exact opaque IDs/URIs/preferences. The publisher, empty HA
snapshot, disabled dispatch/automatic policy and independently unverified playback
remain separately checked. No publication, restore, dispatch, scan or restart is
performed.

The same bounded cleanup and STDOUT-report/STDERR-progress contract applies.
Preference-control progress uses ordinals1 media type,2 URI,3 enabled,4 shuffle,
and5 save interaction. Grant/freshness and forward-ledger events precede actual
header/status and body completion events; conflict DOM/reload checks have their
own boundaries. Gates disable after the final write and on any failure while
retaining pending/forwarded evidence. No mutation is retried, baseline advanced,
backup restored or partial state reset automatically. A failure requires separate
actual-state reconciliation under the same correction allowance.

### Explicit current3 concurrency checkpoint

`manager-resume3` is a separate, one-shot continuation from the reconciled saved
revision3 state. It refuses pristine state, partial2, later revisions and unknown
preferences. It uses the same strict 17-field readiness schema at the new fixed
`manager-resume3-ready.json` path, leaving historical receipts untouched. A new
`manager-resume3-baseline.json` contains exactly these 13 flat fields:

```json
{
  "schema_version": 1,
  "fixture": "jukelet-m5-issue62-matrix-kvm",
  "synthetic": true,
  "origin": "https://127.0.0.1:18223",
  "configuration_A_sha256": "64_LOWERCASE_HEX",
  "configuration_B_sha256": "64_LOWERCASE_HEX",
  "publisher_id_sha256": "64_LOWERCASE_HEX",
  "assignment_snapshot_sha256": "64_LOWERCASE_HEX_FROM_CURRENT3_READBACK",
  "domain_revision": 3,
  "album_version": 3,
  "source_clone_report_sha256": "8e44c686455af2c42f5551f9fa2d55b083db6a227a4956c7d1168d91711f9cd1",
  "current_backup_artifact_sha256": "64_LOWERCASE_HEX_MATCHING_NEW_READY_RECEIPT",
  "observed_at": "ACTUAL_CURRENT_OBSERVATION_UTC_TIMESTAMP"
}
```

The coordinator obtains the protected native current3 backup and fresh supported
readbacks before creating these private receipts. Both receipts must be at most
one hour old and bind the actual configurations, candidate, bridge, distinct
administrators and current backup. The driver independently requires both normal
sidebar contexts to show the exact current3 snapshot: album3 enabled/unshuffled,
playlist0 absent, the already verified fixed label, unchanged publisher, empty HA
tuple, no jobs/attempts, automatic publication and dispatch off, and clear recovery
and reconciliation guards. It performs no rename or earlier create again.

```sh
node scripts/haos_acceptance/browser_manager.mjs manager-resume3 \
  /tmp/jukelet-issue62-matrix-control/acceptance.json \
  /tmp/jukelet-issue62-matrix-control/acceptance-admin2.json
```

B deliberately disables its fresh version3 album, producing4. A's independent
version3 editor submits enabled/shuffled preferences and must receive the actual
409 with exact `assignment_conflict` and current version4. Only this exact URL,
PUT method and canonical synthetic body arm the reusable one-shot clone observer.
It preserves the native fetch Promise, Response, receiver and arguments, restores
fetch at the single match and reads one bounded real response clone. Capture still
requires Playwright `response.finished()` to return null and `response.json()` to
return the full typed 409 body, matching the clone. Missing, duplicate, mismatched,
timed-out or unconfirmed captures fail. The original body must remain unread; the
application's ordinary conflict branch runs unchanged. This is instrumented
capture evidence; it does not establish uninstrumented browser timing or an
upstream browser defect.

A must retain its URI and enabled/shuffled input with Save disabled, while B
independently reads its unchanged version4 disabled/unshuffled winner. A explicitly
reloads4, reviews those preferences and deliberately saves enabled/unshuffled at5.
The playlist then creates1, disables2, confirms tombstone3 and recreates4. Seven
one-shot attempts (A6/B1, including the rejected conflict) produce six successful
assignment increments, ending at saved revision9, album5 and playlist4. Both
contexts must read this exact state and the unchanged publisher/empty HA tuple
back. Audit and durable high-water/fixture invocation checks remain separate
coordinator observations.

Each grant rechecks receipt freshness. Gates fence before observer cleanup and all
browser cleanup, including failure and unconfirmed close; pending and forwarded
evidence stays visible. The clone has a five-second bound, its Playwright completion
and body observations have separate five-second bounds, and all other operations
retain their existing finite deadlines. The coordinator's 180-second process limit
is authoritative. A failure requires actual-state reconciliation and stops this
one-shot sequence; no write, backup, restart or baseline advance is retried.

### Final shared-capture verification from current9

The separate `manager-capture9` checkpoint exercises the delivered generic
capture path against the populated state established above. It requires new
`manager-capture9-ready.json` (the same strict 17-field schema) and
`manager-capture9-baseline.json` (the same 13-field schema, with
`source_concurrency_report_sha256` replacing `source_clone_report_sha256`, pinned
to `92d8d22a422c3144c971828e9609054d9dadbe82dd877bea72e110b2eec83663`,
`domain_revision:9` and `album_version:5`). The snapshot binds the actual album5
and playlist4, existing fixed label and unchanged publisher/empty HA tuple. Both
configuration/admin bindings, the newly protected current9 backup and all receipt
freshness/prewrite guards apply. Older receipts or partial states cannot advance
this checkpoint.

```sh
node scripts/haos_acceptance/browser_manager.mjs manager-capture9 \
  /tmp/jukelet-issue62-matrix-control/acceptance.json \
  /tmp/jukelet-issue62-matrix-control/acceptance-admin2.json
```

B deliberately disables album5, producing6 and saved revision10. A's independent
stale5 editor must receive the full actual409/current6 with the same one-shot
clone/Playwright/body/restoration checks, retained enabled/shuffled input and
disabled Save. B's winner6 must remain unchanged. A explicitly reloads6, compares
disabled/unshuffled preferences, then deliberately saves enabled/unshuffled at7,
ending at saved revision11. There are A2/B1 one-shot attempts and two successful
assignment increments. Both actual contexts must read the existing playlist4 back
with exactly its starting body hash; this checkpoint makes no playlist or rename
writes. Cleanup, finite deadlines and the coordinator's authoritative 180-second
limit remain unchanged. This checkpoint is source verification, with no new
publication, dispatch, restart or other acceptance feature.

## Native response-capture evidence and limits

The isolated minimum-Core investigation observed consumption-sensitive Playwright
completion: ordinary GET200 and strict-key GET422 responses left unread by the
browser initially timed out in both Playwright completion and JSON-body reads.
Consuming the same browser Response released both retained observations, with one
request in each case. The original comparison remains **FAIL** (report SHA256
`93914b831879f8881e53abbe2efd9319c1293d13587de0a34f0e4b86d7be9f53`);
later completion does not erase its initial timeouts. This does not establish an
upstream Chromium, proxy or application defect.

Separate native read-only controls passed with one bounded real response clone,
while preserving the original native Promise/Response and unread body. Both
GET200 and GET422 had one request/fetch/clone, Playwright completion and typed
body agreement, and subsequent consumption of the same original body without a
second fetch. Report SHA256:
`8e44c686455af2c42f5551f9fa2d55b083db6a227a4956c7d1168d91711f9cd1`.
The temporary comparison/control runner and tests were removed after exact source
and reports were preserved in the coordinator's ignored workflow evidence.

The actual two-administrator current3 continuation then passed the full UI409
case: B saved4, A's one stale3 request returned `assignment_conflict/current4`,
the actual Playwright body matched its single 61-byte clone, the original body
stayed unread, and both capture restoration and request completion were confirmed.
The UI retained A's URI/enabled/shuffle inputs with Save disabled, B's winner4
remained unchanged, and explicit Reload4/save5 plus playlist creation/edit/removal/
recreation ended at saved9/album5/playlist4. Report SHA256:
`92d8d22a422c3144c971828e9609054d9dadbe82dd877bea72e110b2eec83663`;
manager source SHA256 at that run:
`9a83e789e0ed3508e29d15837032bdbee699bf5eeb3b20d1bcc961d6ce9721af`.
This used immutable candidate12/source
`052eecbef1eadd97415393761abb8580bc873aad`, image manifest
`sha256:4627ceb5ea90b9c29f76af925fe33672e521c5e85eb3b7ce94bc30d160cf2b6f`,
bridge0.1.5, HA OS18.4, Supervisor2026.10.5 and Core2026.10.3 on AMD64.

The retained shared observer and regression tests qualify **instrumented capture**.
Every expected409 assignment save automatically requires the shared all-context cleanup
fence and capture, including the pristine1/current2, partial2/current3,
resume3/current4 and capture5/current6 scenarios. Exact URL/method/canonical body
and current-version checks, full real Playwright body/clone agreement and cleanup
fencing remain mandatory. Each later save or explicit rename/removal enables its
gate only before a fresh reviewed grant. The pristine path also rechecks its
readiness receipt on every grant. Ordinary200 captures keep their existing body
path. The observed current3
native result is historical evidence for that source; generic caller integration
and later final-source checks require their own affected verification. No candidate
runtime changed, physical playback or whole-issue acceptance is established.
Normal HA service-worker registration remains outside this blocked-worker fixture.

## Native metadata fallback and recovery checkpoint

The locally tested `metadata-fallback` command is opt-in; its native result must
come from the coordinator's separately recorded run. It uses one normal HA
administrator/sidebar session on the owned fixture and requires a new private
`metadata-ready.json` with exactly these 16 flat fields:

```json
{
  "schema_version": 1,
  "fixture": "jukelet-m5-issue62-matrix-kvm",
  "synthetic": true,
  "origin": "https://127.0.0.1:18223",
  "configuration_sha256": "64_LOWERCASE_HEX",
  "admin_user_id_sha256": "64_LOWERCASE_HEX",
  "actual_candidate_image_manifest_digest": "sha256:64_LOWERCASE_HEX",
  "actual_bridge_archive_sha256": "64_LOWERCASE_HEX",
  "publisher_id_sha256": "64_LOWERCASE_HEX",
  "assignment_snapshot_sha256": "64_LOWERCASE_HEX_FROM_CURRENT11_READBACK",
  "domain_revision": 11,
  "source_concurrency_report_sha256": "be2c277dd52a90d396aed73be9808487839dd689dc6aec138101556218fdc4d9",
  "backup_artifact_sha256": "64_LOWERCASE_HEX_FROM_NEW_NATIVE_FULL_BACKUP",
  "backup_readback_verified": true,
  "backup_protected": true,
  "observed_at": "ACTUAL_CURRENT_OBSERVATION_UTC_TIMESTAMP"
}
```

The existing private-directory/file/link checks apply. The receipt must be at most
one hour old and binds the actual config, image, bridge, administrator and new
protected current11 backup. Protection means task-owned private permissions,
hashes and supported readback; it makes no encryption/off-host recovery claim.
Actual native reads must independently match saved11/album7/playlist4, exact
opaque IDs/preferences/URI/name, publisher, empty last-good tuple, high-water0,
automatic publication off, dispatch off, no jobs/attempts and clear recovery and
reconciliation guards. App write gates remain disabled throughout.

```sh
node scripts/haos_acceptance/browser_metadata.mjs metadata-fallback \
  /tmp/jukelet-issue62-matrix-control/acceptance.json
```

The coordinator executes this single phase with an authoritative **480-second**
process limit. After the existing fresh bootstrap preview, a fresh actual UI album
preview seeds its exact last-good item and success timestamp. The driver waits
until that success is more than 300 seconds old, with a two-second margin, using
real wall and monotonic clocks. Wait intervals are at most 15 seconds; each emits
finite progress and checks the same synthetic fixture instance/counters. Clock
jumps, deadlines or unexpected counter changes fail; no HA clock, cache or
database is edited.

Only the already authenticated parent
[`home-assistant.hass` client](https://github.com/home-assistant/frontend/blob/901c0a61ad44c7f52f50a986f6b5a81371f97a0a/src/state/connection-mixin.ts#L62)
is used for fixture control. Its connected state, public administrator identity
hash and role must match the actual Ingress session. The only messages are
`jukelet_acceptance/control` with `action:status`, or `action:metadata` and
`mode:unavailable|fresh`. Calls preserve the native receiver and existing
connection. No token, authentication store, arbitrary service, scan or alternative
transport is accessed. Script invocation/unexpected-call counts and captures must
stay zero in every observation; raw status bodies are never reported.

After the real TTL, the exact synthetic UI request must return actual503/stale
with `unavailable`, one provider-call counter increment, unchanged last-success
timestamp/item/URI, the displayed retained label and the caveat that lookup availability does not determine playability. It cannot pass on a cached error with no provider attempt.
Current assignments and guards are checked again during the failure. The same
authorized client then restores the fixture to fresh. After the actual returned
negative-cache delay (first failure 30 seconds), plus a two-second margin, one
explicit recovery preview must return actual200/fresh with a newer success time
and another provider-call increment. No implicit preview retry is made. Final
assignment/name/publisher/last-good/floor/policy/dispatch state must equal the
starting state.

Authorization denials are terminal. No fresh-mode cleanup follows rejected
authority or an uncertain control outcome. After a typed expected provider503,
bounded cleanup may restore fresh once using the same still-authorized client;
it never retries an uncertain write. Such cleanup cannot turn a failed case into
a pass. Public browser close and owned-process verification remain mandatory.
The fixture has no artwork, external account or physical playback; this checkpoint
proves text/URI retention and recovery only. Other native acceptance criteria,
including the populated stable/beta matrix, remain separate.

## Logical export/restore and stale-review checkpoint

The locally tested `restore-stale-review` command requires a separately recorded
native run. It uses two normal HA administrator/sidebar contexts, the same strict
17-field readiness schema at new `restore-ready.json`, and new
`restore-baseline.json` with exactly these 13 flat fields:

```json
{
  "schema_version": 1,
  "fixture": "jukelet-m5-issue62-matrix-kvm",
  "synthetic": true,
  "origin": "https://127.0.0.1:18223",
  "configuration_A_sha256": "64_LOWERCASE_HEX",
  "configuration_B_sha256": "64_LOWERCASE_HEX",
  "publisher_id_sha256": "64_LOWERCASE_HEX",
  "assignment_snapshot_sha256": "64_LOWERCASE_HEX_FROM_CURRENT11_READBACK",
  "domain_revision": 11,
  "album_version": 7,
  "source_metadata_report_sha256": "91f53938ce7a2b0b0dc529d2de591c99797a1c4c941eebf2ad9922a56e4aa135",
  "current_backup_artifact_sha256": "64_LOWERCASE_HEX_MATCHING_NEW_READY_RECEIPT",
  "observed_at": "ACTUAL_CURRENT_OBSERVATION_UTC_TIMESTAMP"
}
```

Both receipts must be at most one hour old and bind the actual config/artifacts,
distinct administrators and new protected current11 backup. Exact native preflight
requires saved11, album7 enabled/unshuffled, playlist4 enabled/shuffled, unchanged
publisher/empty HA tuple/high-water0, healthy ordinary publication eligibility,
automatic publication and dispatch off, no jobs/attempts and clear recovery guard.
The coordinator's process limit is **180 seconds**.

```sh
node scripts/haos_acceptance/browser_restore.mjs restore-stale-review \
  /tmp/jukelet-issue62-matrix-control/acceptance.json \
  /tmp/jukelet-issue62-matrix-control/acceptance-admin2.json
```

A downloads the actual `jukelet-export-v1.json`; one clone of that same native
browser Response must match the original UI's Blob download byte for byte. The
observer preserves the original Promise/Response and normal Blob consumer. Native
diagnosis `d3b030601b6ccbc8255163666a633198a3edd1dc724976aa8e2b044349f2c2ab`
observed a valid656-byte download while Playwright's automation body was empty;
that separate result remains a recorded limitation, with lower-level mechanism
unproven. Clone/download identity retains the logical export criterion and makes
no independent-wire claim. Only private browser artifacts/RAM retain bytes. The same
buffer is uploaded through the normal file input, and each preview request must
carry its exact unchanged content. Preview11 must accept2/reject0/conflict2 and
require an explicit replace policy and row review. Names are informational and
must match independent HA readback; no restore renames a tag.

B's version7 album edit is fully prepared but unsaved. A reviews publication at11
and checks the snapshot review box. After a real normal A status11 poll, B saves
disabled at8/global12; immediately afterward A uses ordinary Confirm. Only an
actual409/full `review_stale` response completes that case. If the existing
three-second poll disables Confirm first, the outcome is **PARTIAL**, actual409
is **NOT_RUN**, and the button is never forced, polling suppressed or request
retried. Any unforwarded intent remains permanently disabled evidence. Separate
already-authorized restore observations may proceed once.

A then confirms its still-reviewed old restore preview through the actual UI. The
required409 body is exact `assignment_conflict/current_version12`, read fully by
Playwright and matched against one real response clone. The observer's only new
eligibility is POST to canonical owned Ingress `restores/confirm`, no query, exact
canonical body `{preview_token, conflict_policy:"replace", confirmed:true}`.
POST header matching accepts only data descriptors for the current UI's literal
JSON content type and CSRF header; the CSRF value is never inspected. Existing
GET/PUT eligibility and all capture/restore/identity behavior remain unchanged.
No Response, Promise, argument, receiver or response body is replaced.

The failed restore must retain its report, mark it stale and disable confirmation
without changing saved12. A previews the same old11 file again at12; policy/review
must reset before another explicit replace/review/Confirm. Success restores2,
skips0 and is independently read back at saved13/album9/playlist5. Versions and
publisher/history/floor must not rewind. Automatic publication stays off, durable
reconciliation is required, ordinary publication is fenced and the separate
recovery-review control becomes available. No recovery publication is queued here.
No pending jobs existed, so pending-job fencing is not claimed as native evidence.

Each intent is source/scenario/token/body bound, checks fresh prerequisites, and
can forward at most once. Every gate fences before observer or browser cleanup;
pending and forwarded evidence persists as hashes. The only domain writes are B's
single save and the single successful logical restore. Any unexpected partial
failure stops for actual-state reconciliation, with no replay, baseline reset,
alternate authority or automatic retry. Audit/guard-generation and installed
artifact/script checks remain independent coordinator observations. Physical
playback, later publication/lifecycle/security and the full version matrix remain
separate acceptance work.

## Reviewed recovery publication from current13

This separate opt-in checkpoint requires a new protected current13 backup and
fresh private `publication-ready.json` (the existing exact17 readiness schema).
Its new `publication-baseline.json` has exactly13 fields: `schema_version:1`,
`fixture`, `synthetic:true`, `origin`, `configuration_A_sha256`,
`configuration_B_sha256`, `publisher_id_sha256`, `assignment_snapshot_sha256`,
`domain_revision:13`, `album_version:9`, `source_restore_report_sha256`,
`current_backup_artifact_sha256` and `observed_at`. Both receipts are at most one
hour old; the backup hash must match. The source restore witness is
`ef005f8ba1e8f55c76e069079ed478f0f9ee3bc43f681e0cfeb7c722bf9e4110`.
Exact assignments13/album9/playlist5 and their snapshot must match, with empty HA
state, high-water0, no jobs, recovery required, auto-off and dispatch-off.

```sh
node scripts/haos_acceptance/browser_publication.mjs publication-recover \
  /tmp/jukelet-issue62-matrix-control/acceptance.json \
  /tmp/jukelet-issue62-matrix-control/acceptance-admin2.json
```

The coordinator runs this one-shot command with a180-second process limit.
One normal owner-admin session reviews the exact recovery mappings and checksum,
checks the review box and confirms through the UI. Review and confirm each have
one exact, fresh-receipt-bound request grant. An acknowledged queue reservation
does not complete verification. Bounded read-only polling must observe the app's
verified recovery job and its actual bridge tuple, plus a separate matching
`jukelet_bridge/status` response through the existing authenticated HA parent's
public client. Both must report healthy revision1 and the exact reviewed checksum
for saved13. No credential storage or alternate transport is read.

Assignments and their versions/timestamps remain identical; reconciliation must
clear while automatic publication, dispatch and the execution-uncertainty fence
remain unchanged. Fixture status must retain zero script invocations. Every gate
fences before cleanup; an unexpected outcome stops without requeueing. Root's
durable guard-generation/establishment/history and backup checks remain separate
evidence. This checkpoint makes no scan, startup, physical-playback, lifecycle or
whole-issue acceptance claim. Native execution is separate from local tests.

## Owned external Chromium bootstrap

This separate initial capability verifies normal local HA login/sidebar and the
existing read-only manager bootstrap in Root's fresh external desktop Chromium:

```sh
node scripts/haos_acceptance/browser_external.mjs external-read-only CONFIG_A
```

The separate `external-visibility CONFIG_A` phase first requires that same full
bootstrap, then minimizes/restores only the verified parent page's native window.
It reads the real parent and Ingress iframe `document.visibilityState`, requires
both documents hidden/visible, and observes each paused state for at least one
10-second status-poll interval before the explicit **Check access again** action.
It enters only unsaved synthetic assignment inputs and opens a local removal
confirmation; it never submits that confirmation, saves or creates server reviews.
Recovery requires a fresh same-principal session200 and saved-assignment200, an
unchecked recovered-input review, disabled write buttons and no stale confirmation
or selected preview. The report phase is `external-visibility`; Root must still
certify the actual native run, unchanged fixture state and normal process cleanup.
A missing native window manager/real visibility transition fails this phase; there
is no injected visibility/event fallback. The same immutable five-minute lease,
fixed metadata files and process/worker proof apply. This phase does not establish
File/server-review lifecycle or natural eight-hour expiry acceptance.

The separate `external-file-review CONFIG_A` phase requires the same full native
bootstrap and GUI prerequisite below. It uploads one explicitly synthetic,
source-owned schema1 File from memory, then permits exactly two normal-UI
`restores/preview` POSTs. Each one-shot permission binds the exact source body,
owned frame/page/context, principal, prefix, current CSRF and original15-second
action deadline; no arbitrary body, endpoint or method can be granted. The fixed
fixture must remain at revision13 with album9/playlist5. Preview1 must return two
supported conflicting rows, and an explicit local policy/review must enable
confirmation; the actor never clicks it.

After real native hide/reopen and both10-second paused observations, private
Recovery/report/review/confirmation DOM must be removed and no new private
request may start. One explicit access check must produce an actual same-user
session200, followed by fresh assignments200 at revision13 and Recovery200 with
`reconciliation_required:false`. Recovery exposes no guard-generation field:
Root must independently certify unchanged `guard_generation1` before/after.
The retained File marker and empty new native file input must be observed while
the old report, policy, review and confirmation are absent. Preview2 uses the
retained File without a second upload, requires the identical body and a new RAM
token, and must reset policy/review/confirmation to empty/unchecked/disabled.
The report phase is `external-file-review`; two expected preview POSTs are
separate from zero unapproved mutation attempts and zero paused private starts.
All save, rename, publication and restore-confirmation writes remain denied,
including attempts that would be aborted. Root must verify unchanged complete
domain state and normal process cleanup. This phase certifies neither a prior
download nor backend revocation of the old bounded RAM preview token. External
`noDefaults` download-path confinement remains a separate prerequisite; this
phase never starts a download. Default read-only and visibility policies remain
unchanged. Native, tester and fresh reviewer evidence are required separately
from the local fixture tests.

The `external-manager-readonly CONFIG_A` phase uses that same source-bound
external browser and GUI prerequisite. It joins the existing two-tag state
(global revision13, album row9, playlist row5, verified publication1) without
repeating rename, assignment, restore or publication writes. It refreshes saved
drafts, publication, playback and both inbox views through ordinary UI controls,
and awaits actual connection/inventory polls. Each accepted GET binds the actual
request-start phase, exact prefix/query, original response/request, verified
frame/page/context/principal, bounded JSON body and current source lease; a held
old request cannot gain freshness at later route admission. DOM checks preserve
raw opaque-ID text, current names/media/preferences, declared capabilities,
publication identity/checksums/jobs and fresh guarded playback diagnostics.

Only the existing one fixed bootstrap metadata preview and normal HA sign-in
POSTs are permitted. Post-bootstrap app mutation attempts are independently
observed even if the outer guard aborts them. The current empty inbox checks
membership availability, view/refresh completion and absence of previous-view
warnings; it does not certify a populated inbox or a newly observed scan.
Recovery exposes only reconciliation state, not guard generation. Root must
independently preserve logical/audit/history/publisher/guard/role/image/script
state, allowing ordinary sessions, the bounded bootstrap metadata delta and
read-observation cache timestamps. Root process cleanup, actual HA OS execution,
independent testing and fresh review remain mandatory; local helper controls
alone do not certify this phase or complete issue62. Downloads, identity/device/
HTTPS and operational/compatibility cases remain separate.

The verified GUI prerequisite is a task-owned X11 display with a live window
manager. Root launches with `XDG_SESSION_TYPE=x11`, no inherited `WAYLAND_*`,
private task-owned XDG runtime/config/cache/data directories, and the owned Xvfb
`DISPLAY`/`XAUTHORITY`. Setting `DISPLAY` alone does not establish isolation:
Chromium can otherwise select ambient Wayland. The exact22 Chrome arguments stay
unchanged. Root attests the critical child environment immediately before
`execve` in the same PID (Chrome may relocate its `/proc` environment), verifies
the live X11 client's `_NET_WM_PID` equals that Chrome PID, and verifies the owned
window manager through `_NET_SUPPORTING_WM_CHECK`. Bind these checks and source/
process identities into the Root receipt before HA interaction. The observed
no-WM control could not minimize; missing WM is a prerequisite, not an event or
visibility fallback. Root's verified Openbox setup uses an official package
extracted under task-owned `/tmp`, with no host installation/configuration change;
require normal WM0, Chrome0 and Xvfb0 cleanup. Earlier GUI observations without
this runtime isolation proof remain historical; retain their HTTP/domain/source
facts separately and reverify affected GUI behavior.

There is no CLI endpoint/browser/context argument. `openNativeManager` selects
this internal mode only with `externalBrowser:true`; existing callers retain
headless launch, an isolated context and their existing public cleanup behavior.
External attachment uses `connectOverCDP(..., {noDefaults:true})`, exactly one
existing default context and its one initial `about:blank` page. It never creates
a context/page or injects authentication, cookies, HA responses or lifecycle state.

Root starts the controller, Chrome and Node actor in the same exec/PID namespace;
Chrome and Node must be direct children of that controller. The actor checks its
actual parent PID/start ticks, Chrome's actual parent/start ticks/UID, the pinned
`chromium.executablePath()` real path and executable hash, exact process arguments
and a fresh owned0700 nonsymlink profile. The Node actor does not inspect process
environment, profile contents, HA credential stores or raw private configuration.
Root supplies three mode0600 flat JSON files in the existing fixed0700 control
directory, each at most16384 bytes, without duplicate/extra fields or future/older-than-five-minute
observation times:

`external-browser-ready.json` has exactly25 fields:
`schema_version:1`, `fixture`, `synthetic:true`, `origin`, `session_id`,
`configuration_A_sha256`, `actual_candidate_image_manifest_digest`,
`actual_bridge_archive_sha256`, `admin_A_user_id_sha256`, `ingress_prefix_sha256`,
`certificate_sha256`, `controller_pid`, `controller_start_ticks`, `chrome_pid`,
`chrome_start_ticks`, `executable_sha256`, `profile_basename`, `fresh_profile:true`,
`cdp_port`, `cdp_endpoint`, `proxy_port`, `argv_sha256`, `worker_policy_sha256`,
`process_preflight_sha256` and `observed_at`.

Use the exact public CONFIG_A/artifact/certificate hashes and actual administrator
and canonical prefix hashes. `session_id` is32 lowercase hexadecimal characters;
`profile_basename` is exactly `external-profile-<session_id>` in the control root.
PIDs/ports are positive JSON integers; start ticks are nonzero decimal strings.
The distinct CDP/proxy ports are1024–65535, excluding18223/28223. The endpoint is
exactly `ws://127.0.0.1:<cdp_port>/devtools/browser/<lowercase-UUID>` without
credentials, query or fragment. `argv_sha256` hashes the exact `/proc/<chrome_pid>/cmdline`
bytes, including the final NUL. `process_preflight_sha256` hashes the exact second
file. Publish only projected hashes/booleans, never the endpoint, profile path,
prefix, credentials or raw arguments.

`external-browser-preflight.json` has exactly19 fields:
`schema_version:1`, `fixture`, `synthetic:true`, `origin`, `session_id`,
`controller_pid`, `proxy_port`, `connect_authority:"127.0.0.1:18223"`,
`raw_connect_only:true`, `outside_forwarded:0`, `same_policy_sha256`,
`same_policy_report_sha256`, `same_policy_positive_control_verified:true`,
`same_policy_registrations:0`, `same_policy_sdk_workers:0`,
`same_policy_cdp_workers:0`, `same_policy_worker_script_requests:0`,
`same_policy_escape_hits:0` and `observed_at`. Shared fields must match the lease.
Root must derive these from actual owned process-proxy and same-policy controls;
the referenced report remains separate evidence, not a harness-executed claim.
The proxy permits only the literal raw CONNECT target above, with no HA TLS/body
substitution or outside forwarding. This is not a full-protocol namespace claim.

`external-parent-worker-ready.json` has exactly15 flat fields:
`schema_version:1`, `fixture`, `synthetic:true`, `origin`, `session_id`,
`configuration_A_sha256`, `actual_core_version`, `worker_asset_path`,
`worker_asset_sha256`, `worker_asset_bytes`, `public_assets_readback_sha256`,
`egress_control_report_sha256`, `native_proxy_readback_sha256`,
`worker_policy_sha256` and `observed_at`. It has the same private-file, size,
no-duplicate/extra-field and five-minute freshness requirements as the two files
above. Session/configuration/origin/policy match the lease. `actual_core_version`
selects one reviewed literal profile in `browser_core_profiles.mjs`; unknown
versions and cross-profile path/hash/size combinations fail closed. These are
fixture-harness provenance profiles, not a restriction of product support:

| Core | Public worker path | Bytes | SHA256 |
| --- | --- | --- | --- |
| 2026.10.3 | `/frontend_latest/markdown-worker.668dcd3bda774ac2.js` | 95697 | `e82decd9849c488ffed18e20ec6e4d2bf81eeb01c69bf6088e625baf917801ad` |
| 2026.11.0 | `/frontend_latest/markdown-worker.7fcdb971f47a98ea.js` | 99463 | `090f8b0e7fbda16691184f7e47a16813a58f6b3f2233095a7f07c77a5b8e47d9` |

Root matched each installed public file to a CA/hostname-verified GET. The Core11
preparation used its upstream Python3.14.10 and frontend20261028.4; it does not
change the project/app Python3.14.9 pin. Public-source/service readback alone is
not native UI acceptance or source-benign evidence. Fresh source/creator frame,
context, admission deadline, bootstrap and actual process/proxy evidence remain
required for each Core. Unknown or additional workers still fail closed.
The egress-control report hash is exactly
`a76a9d2e175ad2c9d2d67f96a14af2c830953bcf931d4a3d34959df3cc961a8e`.
That report is an inert generic SDK/proxy control, not evidence about the Core
markdown worker or current-Core native acceptance. Its unchanged generic scope
may be retained; each Core still needs its own fresh actual public-source and
proxy readbacks.
`native_proxy_readback_sha256` equals both the lease's
`process_preflight_sha256` and the actual19-field preflight file's SHA256.
`public_assets_readback_sha256` references Root's actual unauthenticated,
CA/hostname-verified public-source readback record; it is an operator attestation
reference, not a record fetched or fabricated by this actor. Root derives all
three files inside the same approved launch after fresh platform, domain, role,
proxy and owned-process readbacks. Do not refresh old receipts' timestamps.
Production loads this fixed validated policy before attachment and rechecks its
bytes/freshness and actual preflight hash with process provenance. There is no
worker URL/origin/list/CLI override. The direct adapter's trusted synthetic policy
seam supports network-free unit controls only.

Root launches the canonical pinned executable with exactly the arguments returned
by the import-safe `externalChromeArguments(lease, executable, spki)` helper. They
include the standard background/component-extension suppression, disabled QUIC,
resolver block with127.0.0.1 excluded, owned HTTP proxy and `<-loopback>` bypass
removal, loopback CDP listener, owned profile,1440×1000 window and the exact verified
fixture certificate's SPKI allowance. Blanket certificate bypass and extra flags
are rejected. Compute hashes from actual process bytes; do not repair stale facts.
The pure `validateExternalChromeCommandLine(rawBuffer, expectedArguments)` helper
accepts exactly NUL-separated arguments plus one final NUL (`nul_separated`), or
the pinned Chromium's observed single-space-joined process title plus one final
NUL (`chromium_process_title`). It compares bytes without splitting, whitespace
normalization or padding allowance. Pass the exact helper-produced launch array;
the actor also verifies the actual byte hash, pinned executable, owned parent,
PID/start ticks, UID and fresh profile. Hash the observed bytes, rather than
reconstructing a canonical representation. The representation tag is diagnostic,
and does not independently prove process ownership or launch provenance.

Before HA navigation, one public CDP session on the existing owned page reads
`Target.getTargetInfo` and `Page.getFrameTree`. The adapter checks exactly one page,
one root frame and browser-context identity, initially at `about:blank`, then
again at the current HA origin before reading credentials. All dedicated/shared/
service workers and registrations must still be absent before credentials.

After that barrier, at most one dedicated worker from that exact owned HA parent
frame/context may enter pending startup. An initially empty URL grants no app
permission. Actual owned-page SDK worker association, the matching CDP target's
exact fixed source URL, and one actual routed200 response for that public script
are all required. The response must have a valid JavaScript content type,
bounded positive declared Content-Length, supported encoding and the selected
profile's exact decoded-byte count and pinned SHA256. Completion is bounded by five seconds from
CDP creation. `Response.body()` buffers decoded bytes: header/count/completion
bounds and exact accepted size/hash apply to this single independently pinned
asset on trusted owned Core; they are not a hard prebuffer decoded-size cap or a
general untrusted response loader. There is no response substitution or worker
resume. Shared/service workers, unknown/App creators, extra workers, changed
metadata, missing proof, stale provenance and late completion fail closed.

Normal HA parent reads, its Core WebSocket and the fixed public worker GET may
initialize while private Jukelet API authority and previews remain denied.
The fixed Core10.3 fixture starts its HA-parent worker when the sidebar panel is
entered. After sidebar visibility, external-only `beforeIngress` therefore arms
only the validated canonical child document and same-prefix JavaScript/CSS shell.
The installed route guard checks frame/prefix ownership before awaiting a private
GET/HEAD request, then checks ownership and the original allowlist again before
continuing it. At most16 private reads may wait; no writes are queued and no
request is retried, duplicated or fabricated. Timeout, overflow, invalid proof,
cleanup or fencing rejects pending reads without forwarding them.

After the click, `afterIngress` requires one fully proven fixed parent worker,
closes creation admission permanently and rechecks inventories before releasing
private reads. The original30-second sidebar budget includes visibility, click
and this proof barrier; the five-second source budget still starts at creation.
An absent worker fails closed as an explicit prerequisite for this isolated
fixture, not a product or household deployment requirement. The managed path
keeps its original behavior. A proven parent worker may persist with the app
iframe; any later new worker is terminal. Inventories admit only the already
proven target and associated SDK worker, with zero shared/service workers and
registrations.
`checks.external.parent_worker_startup` reports bounded status/counts/proof
booleans; owned-parent identities are hashed. Source bytes, raw URLs and IDs are
never reported.

`parent_worker_failure` retains only the first bounded step/event and trusted
handler-entry admission state, with field-state/equality projections after
fencing. Final closed-window state alone does not show whether creation was
late. Shutdown-stage booleans record page/protocol/disconnection evidence.
External cleanup fences authority, installs the Browser `disconnected` listener,
then closes only the adapter's already-proven owned page with public
`page.close({runBeforeUnload:false})`. It never enumerates or closes unfamiliar
pages. Page closure and the subsequent browser close/native-disconnection wait
share the existing close-operation deadline; SDK fallback has its existing bound.
Closing the last owned page can itself exit Chrome. That path requires completed
owned-page closure, `isClosed()` readback and native disconnection; its report
does not fabricate a `Browser.close` acknowledgment. Otherwise actual
`Browser.close` acknowledgment and native disconnection are required. Missing,
failed or late page/event proof stays unconfirmed. The listener is removed before
SDK fallback, and late events cannot mutate the reported snapshot. Root must
still observe normal Chrome process exit independently. Page-first teardown is a
candidate for the observed native crash; the earlier inert controls did not
reproduce or establish its cause. Cleanup does not certify HA visibility/reopen.

Unexpected worker callbacks still fence authority and sockets synchronously before
reading diagnostic fields. The retained `worker_events` projection caps8 events,
4096-character hash inputs,65536-character lengths and65535 overflow count, with
explicit cap flags and no raw URLs/IDs. The legacy synthetic zero-worker adapter
controls retain one250ms already-fenced metadata query and at most2 matching
updates. Those observations never grant authority and are not native startup
certification or authorization for another metadata-only replay.

The source pin does not make the Markdown/Comlink worker a network sandbox or
unconditionally pure computation. Effective outside-fixture isolation uses the
fixed process proxy, DNS/QUIC restrictions and loopback bypass removal. The
referenced synthetic egress controls observed HTTP/HTTPS/WS/WSS positive traffic,
negative external-target zero TCP/request deltas and proxy denials; worker
WebSockets were not universally intercepted by Playwright routes. The structural
`outside_forwarded:0` counter alone is not packet-level proof. Actual native
bootstrap and normal process cleanup remain Root verification requirements.

Before HA navigation, the adapter installs this exact Playwright1.64.1 policy:

```js
if (self.ServiceWorkerContainer) ServiceWorkerContainer.prototype.register = async () => { console.warn('Service Worker registration blocked by Playwright'); };
```

It resolves `undefined`. The actual policy constant includes one LF before and
after that line, matching the SDK template exactly; SHA256 is
`ea5047cdd23c30668b9d7467303ac2ddc8ace2b46a69eda3d239fde1a8a5a6f0`.
Both policy hash fields must match. Root's earlier rejecting-sentinel control
proves a blocking mechanism; it is not certification of these exact native policy
bytes. Root runs the same-policy synthetic control before using credentials.

Existing HTTP/frame/prefix and exact WebSocket guards are installed before normal
HA navigation. Initial cookies and SDK/CDP workers must be absent. On the actual
unauthenticated HA page, registration API/context and zero registrations/workers
are checked before credentials are read or filled. The external path first waits
for the public Username, Password and Log in controls to be visible after HA's
client-side auth routing. Navigation, form readiness and the existing credential
barrier share the original 30-second budget; readiness or inventory failure fences
the session without reading credentials or retrying failed inventory. The native
R11 diagnostic observed an evaluation context destroyed by navigation; the local
Chromium regression separately demonstrates waiting through an inert client
navigation before running the unchanged zero-registration inspector. These are
harness readiness findings, not a product authentication defect. Fixed-enum
`parent_inspection_failure` and `worker_inventory_failure` diagnostics expose only
the failed step/outcome; unknown inventory remains unverified. Unapproved workers/pages,
changed provenance or failed/late observations fence later traffic. Domain writes
are always denied; only the opener's one exact synthetic metadata preview POST is
permitted. Actual session administrator/prefix binding and worker/registration
inventories are checked again after bootstrap and before closing.

Cleanup fences synchronously, then submits public CDP `Browser.close` and disconnects
the SDK with bounded memoized operations. Disconnection alone cannot establish
protocol shutdown. Reported `process_exit:REQUIRES_ROOT_READBACK` is deliberate:
Root independently requires normal Chrome exit0, proxy/display cleanup and no
owned descendants. This phase proves neither genuine visibility nor S2 pending
request cancellation, broader worker/Core-version support, remote HTTPS, physical mobile or
natural eight-hour app expiry. Those remain separate required acceptance gates.

Default controls run without frontend dependencies in the backend helper suite.
The separate default-managed-path Chromium regression requires the existing
installed frontend Playwright/Chromium dependencies and uses only an owned blank
page, blocked HTTP/WebSockets and normal cleanup:

```sh
JUKELET_EXTERNAL_BROWSER_TESTS=1 node --test scripts/haos_acceptance/browser.test.mjs scripts/haos_acceptance/browser_external.test.mjs
```

It does not start an external controller/proxy/display or establish native external
browser proof; those process controls and actual HA bootstrap are Root-owned.

## Local responsive navigation

The coordinator runs this read-only phase with a fresh administrator-A public
configuration and fresh readback-backed receipt:

```sh
node scripts/haos_acceptance/browser_navigation.mjs navigation CONFIG_A
```

Before browser work, the harness reads two mode0600 files in the fixed private
control root. `navigation-preflight.json` is a bounded (at most32768-byte), sanitized
coordinator readback document; it is hashed without logging its contents.
`nav-ready.json` has exactly19 flat fields:
`schema_version:1`, `fixture`, `synthetic:true`, `origin`,
`configuration_A_sha256`, `actual_candidate_image_manifest_digest`,
`actual_bridge_archive_sha256`, `admin_A_user_id_sha256`, `ingress_prefix_sha256`,
`publisher_id_sha256`, `assignment_snapshot_sha256`, `domain_revision:13`,
`published_revision:1`, `published_checksum`, `automatic_publication_disabled:true`,
`dispatch_disabled:true`, `backup_artifact_sha256`, `source_preflight_sha256` and
`observed_at`. Use the exact fixture/local origin and current public configuration,
candidate/bridge bytes, actual administrator-A ID and canonical prefix hashes.
The assignment hash covers the exact JSON browser body for
`GET assignments?offset=0&limit=100`, including its field order. The preflight hash
must match the exact `navigation-preflight.json` bytes. The protected latest
backup is fixed to SHA256
`94ab3bb6010cbad35bf55f7861fc113899472ce9101a7f43d27751ee1f48b481`.
`observed_at` must be fresh (no future time or age over one hour). These fields
must come from actual current readbacks; old receipts cannot be timestamp-edited.

The unchanged native opener performs normal HA login/sidebar/bootstrap, blocks
service workers, verifies TLS/hostname with pinned SPKI and installs the existing
frame/prefix HTTP and exact WebSocket guards. This phase additionally checks the
receipt on every Jukelet request. The opener's one fixed synthetic album metadata
preview POST is allowed only during bootstrap; all assignment, tag, publication,
restore and option intents remain denied. After bootstrap only reads are allowed.
Before every explicit navigation action, the actual session contract must still
be the same administrator in Ingress/manage mode and the public HA client must
independently return the expected bridge snapshot through its fixed status read.
Denial, stale authority, failed reads and deadlines fence later work. The gate is
also fenced synchronously before cleanup, including opener failure cleanup.

The same normal Chromium page is resized to1440×1000 then390×844. Keyboard
Tab/Shift+Tab/Enter activates the seven manager anchors and opens/closes exact-ID
tag and saved-draft details, checking focus return, visible targets and horizontal
layout. Reported viewport/document dimensions, anchor names and fixed step/view
labels distinguish desktop from responsive mobile-viewport evidence. Actual
bounded session/assignment/publication/playback reads before and after must retain
the current13/HA1 snapshot, history, disabled automatic publication/dispatch and
execution fence. No assignment, tag, publisher, script or option is changed.

Local controls run without frontend dependencies in the backend helper suite.
For the separate installed-Chromium controls:

```sh
JUKELET_NAVIGATION_BROWSER_TESTS=1 node --test scripts/haos_acceptance/browser_navigation.test.mjs
```

These controls use synthetic DOM on owned blank pages, actual browser keyboard,
scrolling and viewport behavior, zero forwarded HTTP/WebSockets and normal cleanup.
They prove harness behavior, not native HA acceptance. Responsive desktop Chrome
is not physical-mobile certification. Genuine visibility/hide/reopen, remote-style
HTTPS, natural eight-hour app expiry and the other native issue criteria remain
separate required gates. No household proxy change is implied.

## Native security negatives

The coordinator runs each separate case once in a fresh browser, with a180-second
outer limit and the unchanged `acceptance-denied.json` configuration schema:

```sh
node scripts/haos_acceptance/browser_security.mjs security-anonymous CONFIG_DENIED
node scripts/haos_acceptance/browser_security.mjs security-denied CONFIG_DENIED
node scripts/haos_acceptance/browser_security.mjs security-forged CONFIG_DENIED
```

The new private `security-ready.json` contains exactly21 fields:
`schema_version`, `fixture`, `synthetic`, `origin`, `configuration_denied_sha256`,
`actual_candidate_image_manifest_digest`, `actual_bridge_archive_sha256`,
`denied_user_id_sha256`, `denied_group_ids`, `denied_is_admin`, `ingress_prefix`,
`publisher_id_sha256`, `assignment_snapshot_sha256`, `domain_revision`,
`published_revision`, `published_checksum`, `automatic_publication_disabled`,
`dispatch_disabled`, `backup_artifact_sha256`, `source_prerequisite_report_sha256`
and `observed_at`. It must be mode0600 in the fixed private root, at most one hour
old, bound to actual current13/published1/artifact/preflight evidence, and declare
the actual `system-users` nonadmin. Its canonical prefix remains private.

Anonymous access must return a real Supervisor401 with no cookie or app bootstrap.
Denied and forged cases navigate once to the official `/app/local_jukelet` route,
then perform normal HA login using only the dedicated denied credentials. The
native frontend obtains its own session/cookie; the harness never injects one.
The installed first-child guard holds the same canonical document GET for at most
20 seconds until the actual public HA user matches and a rendered sidebar with
visible navigation has no dedicated Jukelet link. It then releases once. Actual
Supervisor403, gateway text, no app cookie/private content and zero app bootstrap
are required. The forged case overrides only three fixed synthetic identity/
Ingress headers; Forwarded/XFF spoofing belongs to the loopback packet tests.
Any failure fences and aborts pending continuations before browser cleanup.

Principal polling awaits each public HA observation for at most20 seconds. Only
incomplete initialization (`false`) retries; invalid context, identity or role
terminates the case. Receipt freshness is checked again before release.
The separate installed-Chromium regression command is:

```sh
node --test scripts/haos_acceptance/browser_security_polling.test.mjs
```

It requires the already installed frontend Playwright dependency and Chromium.
It uses only owned `about:blank` pages with a synthetic public-observation scope,
blocks all HTTP/WebSocket requests and closes its contexts/browser normally.
It exercises the actual Playwright polling seam, terminal observations, deadlines
and request fencing. This opt-in control is separate from dependency-free backend
checks and does not establish native HA/Supervisor denial or issue acceptance.

`security_vectors.py` performs no transport or import-time I/O. Its30 fixed
GET/HEAD plans cover app-loopback protected pages/APIs/assets with spoofed
Forwarded/identity headers, malformed or missing identity from the Supervisor
namespace, and minimal health controls. The coordinator connects to the recorded
owned app address, calls `assert_safe_vector`, then **before sending HTTP headers**
calls `assert_packet_source` with the actual connected socket's local IP and UID.
Loopback plans require127.0.0.1/UID10001; Supervisor plans require172.30.32.2 and
always retain an invalid identity. A complete trusted-source admin tuple is
refused. Duplicate trust-header cases are excluded because an adapter collapsing
duplicates could accidentally create a valid trusted tuple. `assess_packet`
requires the same source/case, one request/no redirects,
no Set-Cookie and exact denial. Packaged health GET is minimal200; HEAD is the
observed empty404 static-files fallback, with no session or privileged content.
No POST, mutation or playback is performed. Socket/container/topology and unchanged
domain/bridge/script state remain independent coordinator evidence. These local
tests and plans do not themselves establish native acceptance.

## Network isolation and the bounded HA-parent warning

The installed HTTP route guard binds the owned HA parent frame before navigation.
Only the normal Jukelet sidebar action arms one direct child; that child's first
canonical Ingress document establishes its identity and prefix before assets or
API requests can continue. Unknown frames, unexpected children, root API paths,
other prefixes and outside origins fail closed from the first child request and
are counted as escapes. Later UI frame discovery must match the binding already
established by the guard. The general same-origin HA method policy applies after
these checks; it continues to support the owned parent's normal auth/read traffic.

Service workers remain blocked so the browser's request guards can observe and
abort outside requests. Playwright 1.64.1's
[registration override](https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/server/browserContext.ts#L173)
resolves registration without a result. The pinned HA frontend
[uses the registration's `addEventListener`](https://github.com/home-assistant/frontend/blob/901c0a61ad44c7f52f50a986f6b5a81371f97a0a/src/util/register-service-worker.ts#L136),
and its [error logger](https://github.com/home-assistant/frontend/blob/901c0a61ad44c7f52f50a986f6b5a81371f97a0a/src/resources/log-message.ts#L65)
can attempt an original-source lookup. The owned minimum-Core investigation
confirmed that specific parent-only TypeError and one blocked lookup, with no
Authorization header, Cookie header or query string. This is a harness artifact;
normal HA service-worker registration is not certified by this run.

The assessment accepts either all-zero counters or only that complete known pair:
one exact undefined/`addEventListener` TypeError from recognized HA-parent app
assets, and one still-aborted parent GET/XHR for the canonical original
`register-service-worker.ts` path at a numeric frontend version. Its observed
headers must be available and contain no Authorization or Cookie; no query,
overflow, extra request, unknown/mixed/app error or Ingress escape is accepted.
All outside requests stay blocked; no response or identity is fabricated.

Reports retain the actual global counts. A separate `expected_fixture_warning`
and explicit zero app/unexpected-error assessment avoid presenting the known
parent warning as zero global errors. All original issue criteria, independent
verification and final review requirements remain unchanged.

The snapshot helper awaits the existing inbox registry-refresh response before
reading the inventory cache. The UI's count and exact opaque-ID assertions remain;
this does not change application refresh behavior or replace native HA responses.

### External export/download slice (issue62 E3)

The fixed external mode installs controlling-session download listeners and
DEFAULT-context DENY after verifying the existing blank page, before Core
navigation. Other modes retain their existing behavior. After the ordinary HA
login/sidebar/bootstrap and single synthetic metadata preview, it consumes the
one-shot read-only manager binding. Fresh UI assignment/inventory/status GETs
establish revision13, row versions9/5 and current HA names. Export rows themselves
do not contain row versions.

Root must provision fresh immutable readiness documents, its owned native
controller/private X11/process lease and new empty owned0700 directories under
`/tmp/jukelet-issue62-download-preparation/artifacts`. The historical R22 run used
`dlp2-e3-r22-positive`, `dlp2-e3-r22-wrongframe` and `ingress-e3-r22-export`; preserve
those artifacts. New CM1 execution uses the per-profile table below.

From the repository root, using the installed pinned tools:

```sh
node scripts/haos_acceptance/browser_download_inert.mjs /tmp/jukelet-issue62-matrix-control/acceptance.json
node scripts/haos_acceptance/browser_external.mjs external-export-download /tmp/jukelet-issue62-matrix-control/acceptance.json
```

These are native actor entry points, not a claim that either was executed on the
current source. Run the extracted inert prerequisite on the frozen source first;
old R20 native evidence cannot certify extracted code. Shared bootstrap changes
also require a fresh manager-readonly recheck before the actual export case.
Local helper checks are available without HA or frontend SDK imports:

```sh
node --test scripts/haos_acceptance/browser_download_policy.test.mjs scripts/haos_acceptance/browser_download_inert.test.mjs scripts/haos_acceptance/browser_export_download.test.mjs scripts/haos_acceptance/download_artifact.test.mjs
```

The actual actor clicks only **Export and recovery → Download mapping export**.
It binds unique CDP AppFrame/loader/ancestry to the verified SDKFrame, observes the
one exact bodyless/no-query/no-redirect GET and matching 200 JSON response, and
uses the existing token-bound transparent `Response.clone` observer. The app
receives its original native fetch promise/Response and consumes its original
blob. Cloning adds stream-tee timing/memory observation. SDK response body is
predeclared `NOT_READ`; there is no extra fetch or capture-path fallback. Raw
export bytes stay in memory. Reports contain hashes, counts and fixed enums.

One finite `allowAndName` window accepts a provisional fresh GUID from the exact
AppFrame and joins it to the unique actual response bytes. Both arrival orders
are supported. The exact approved filesystem verifier requires the original
Chrome GUID file, owned0600/link1, one entry in its owned0700 directory, stable
FD/inode metadata and byte equality. It checks again after normal producer close.
It never copies/chmods an artifact or revokes the app's Blob URL. Failed/missing,
late, duplicate, wrong-frame/query, malformed/oversized or mismatched evidence
fails the case. Live `revoke()` settles DENY and every pending command while
retaining download observers. The external cleanup then owns `close()` with its
fixed normal producer-close operation and independently reads actual browser/page
open and closed states. It observes native disconnection before SDK disconnect;
Root separately checks the actual Chrome process exit. Early page/transport/source
loss and missing, refused or timed-out shutdown proof cannot certify acceptance.
Download observers remain active through requested producer close and one final
local delivery turn under one shared finite producer-close deadline, and are
disposed only after closed-state proof or terminal
failure. Every unexpected begin/progress in that interval fails the whole case,
even if canceled without a file. Once requested shutdown begins, observation does
not initiate fresh commands into a potentially disconnected transport: previously
settled DENY remains in effect, and any attempt is terminal rejection. Normal
requested frame detach is distinguished from earlier source loss; navigation and
frame attachment remain failures. Reports include `producer_close_requested`, `producer_close_settled`,
`producer_closed` and `delivery_barrier_passed`; an accepted result requires all
four plus zero pending/raw promises and normal external cleanup. Callback APIs
are internal trusted adapter seams, not configuration or a selectable driver.

Download permission applies to the DEFAULT browser context, so a tiny download
from the deliberately wrong child frame can finish before DENY/cancel reaches
Chrome. A fulfilled cancel command does not undo an already completed file.
The inert runner still performs exactly two grants/five inert attempts and retains
all60 R20 protocol controls, with the owner's explicit amendment to the intentional
negative: it must be detected and rejected, with DENY/cancel requested and settled.
An actually canceled child download requires an empty destination. If it completed
first, the sole GUID file must match the known45-byte inert payload through the
same unchanged0600/0700/currentUID/link1/FD/nofollow verifier before and after normal
producer close. It stays in the private test directory as rejected quarantine,
never as an accepted export or proof that a write was prevented. Missing, extra,
partial, wrong bytes/permissions/source or unsettled commands still fail.
Reports say `permission_scope: DEFAULT_CONTEXT` and distinguish the wrong-frame
terminal state, actual cancellation efficacy and `REJECTED_NO_ARTIFACT` from
`REJECTED_QUARANTINED`, with `accepted_as_export: false` and producer-close proof.
This amended control requires new frozen-source verification; the earlier E3
native failure remains a failure. Every unexpected download in the REAL export
case still fails the whole case, even when canceled or no file remains.
The inert successful report says `ha_acceptance: NOT_RUN`.
The actual actor reports `phase: external-export-download`, `checks.export`,
`checks.export_join`, `checks.download_policy`, pre/post-close artifact receipts,
metadata-preview evidence and the existing external guard/cleanup records. Exit0
requires actor PASS; Root must independently verify native process exits,
filesystem and unchanged SQL/audit/history/publication/guard/roles/image/script0
state. No local mock protocol result establishes actual HAOS acceptance. Original
issue62 remains partial; identity/device/HTTPS/inbox/restart/app-stopped dispatch
and full native compatibility gates remain separate. No next-issue, household,
cutover, release, registry or standalone-retirement authority is added.


### Exact Core profile selection for CM1

The existing CLI/public configuration schema is unchanged. The protected parent
readiness document selects a reviewed Core version before directory leasing;
this preselection grants no browser or management authority. The existing full
factory still verifies actual PID/argv/TLS/page/context ownership and the worker
association. The inert/export actors retain and recheck the original document
bytes, then compare the factory/binding version with the preselection. A changed
known profile is also a failure, not a fallback. Bootstrap status, manager status
and rendered connection text must match that independent exact version; expected
version is never inferred from the actual response being assessed.

Root precreates the following new empty owned0700 directories below
`/tmp/jukelet-issue62-download-preparation/artifacts`, without reusing or moving
any earlier R22 artifacts:

| Profile | Inert positive | Inert rejected child | Real export |
| --- | --- | --- | --- |
| minimum2026.10.3 | `dlp2-cm1-min-positive` | `dlp2-cm1-min-wrongframe` | `ingress-cm1-min-export` |
| stable2026.11.0 | `dlp2-cm1-stable-positive` | `dlp2-cm1-stable-wrongframe` | `ingress-cm1-stable-export` |

Only these literal profile paths can be selected; no caller path or version
regex supplies authority. Directory leases and real policy evidence carry the
selected Core version. Export capture rejects a policy/binding mismatch before
installing its observer or granting permission. The original secure FD verifier,
45-byte inert quarantine semantics and staged observation through proven producer
closure remain unchanged. Reports include the reviewed-profile module source
hash and actual selected version. The old `CASES`/`EXPORT_CASE` exports remain
minimum-profile aliases for trusted local controls; actual CLI execution always
uses protected metadata, full factory proof and the matching profile binding.

Root runs only one disposable VM at a time, preserving the original populated
minimum fixture and separate working clones. It selects the correct synthetic
instance controls before API calls after checking actual QMP disk identity; a
denial is never retried with another credential or transport. Core-only CI and
unit profile controls do not establish the required populated native matrix.
Actual native results, independent testing and a fresh complete review must be
recorded separately against the final source. All other original issue62 gates
and the no-household/release/cutover/standalone-retirement boundaries remain.
