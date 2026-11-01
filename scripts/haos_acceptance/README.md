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
Every expected409 save automatically requires the shared all-context cleanup
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
