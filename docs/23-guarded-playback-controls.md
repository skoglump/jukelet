# Guarded HA administrator playback controls (#37)

Current prepared integration 0.1.3 uses the [minimum/forward policy and dated matrix](30-ha-compatibility.md). Version-specific observations below retain their original historical scope; they do not redefine the current policy.

In HA, open **Settings → Devices & services → Jukelet bridge → Configure →
Inspect and control tag playback**. These native options screens reuse the
[#36 diagnostics](22-playback-diagnostics.md): dispatch enablement, pause reason,
readiness, busy execution and execution uncertainty. They also show observation
time and the effective snapshot revision/checksum and persistence health.
Observations are point in time, and script completion never independently verifies
playback. The manager only explains status and gives this navigation path; app
sign-in or manage mode grants no HA administrator authority.

## Operator procedure

1. Refresh actual state. Installation, recovery, reload and HA restart leave
   dispatch disabled. Publication never enables disabled dispatch, but compatible
   normal publication can preserve an already administrator-enabled healthy
   dispatcher. Publishing is not a way to stop scan admission. A clean restart
   with a healthy snapshot and clear execution fence needs readiness review and a
   deliberate enable; there is no automatic resume or replay.
2. If necessary, **Disable dispatch** and confirm. Read the result and independent
   state observation. Disable stops new scan admission; it does not stop an
   already admitted startup or establish that its nested/external work stopped.
   Before maintenance that requires stopped admission, or before enabling a
   legacy dispatcher, explicitly disable Jukelet and independently read back that
   dispatch is disabled. Do not substitute publication for this step.
3. For execution uncertainty, independently inspect all previous startup work,
   including old scripts removed from configuration, nested scripts and external
   work. **Script entities being off alone is insufficient.** Neither elapsed time,
   restart nor an acknowledgment proves stopped work. Only after establishing this
   may the administrator choose **Reconcile uncertain startup work** and explicitly
   confirm that **all** such work stopped. Declining confirmation performs no action.
   Reconciliation clears only the durable execution fence and leaves dispatch
   disabled. A separate enable is required; do not blindly retry an old scan.
4. Before **Review and enable dispatch**, independently verify in HA that **every
   previous/legacy dispatcher is disabled**. Explicitly attest to this verification.
   The integration never selects or changes legacy automations and has no hardcoded
   household identifiers. Review readiness: healthy matching snapshot/persistence,
   compatible album/playlist shuffle preferences, configured available idle
   `mode: single` script, no busy startup and a clear execution fence are required.
   Existing snapshot/publication/recovery guards remain in force.
5. Inspect **Action result and independent readback**. A confirmed result requires
   both an acknowledgment and a separate fresh observation consistent with the
   requested action. Rejection and uncertainty are distinct from observed state.
   A lost/malformed acknowledgment stays uncertain even if readback shows the
   intended state. Missing readback shows current state unavailable, never stale
   success. No action retries automatically. Refresh and inspect actual state
   before making any new explicit intent; do not repeatedly submit after a timeout.

Confirmation expires after 60 seconds and is invalidated by intervening controls,
startup admission, publication/recovery identity or persistence changes, effective
script availability changes, and dispatcher replacement/reload. A stale intent
rejects and reads actual state. Controls never queue behind a competing control or
publication transaction. A busy rejection can wait for outstanding persistence to
finish before displaying truthful readback; that wait does not retry the mutation.
Diagnostic-only scan observations do not by themselves invalidate confirmation.

Missing/degraded snapshots, invalid content, conflicting preferences, missing or
running scripts, shutdown and execution uncertainty remain bounded readiness
reasons. Fix authoritative content through its existing reviewed workflow; these
controls do not edit preferences, assignments, snapshots, publisher identity or
revision history. They never invoke a script, scan, provider or playback service.
Enabling only admits future intentional scans. There is no pending scan queue.

**Recover or replace publisher snapshot** remains a separate Configure-menu option
with the existing protected backup, reviewed snapshot, monotonic revision and
confirmation-precondition requirements. Execution reconciliation does not recover
snapshots or clear the management app's recovery guard.

## Boundaries and verification

HA Core's options HTTP endpoints enforce administrator authorization on creation,
GET and every continuation POST, including a forged request using another flow's
ID. The existing administrator WebSocket controls are retained for compatibility;
the options flow uses the same dispatcher implementation through a guarded HA-local
entry point. No administrative mutation proxy or credentials reach the app browser.
The low-level administrator procedure remains documented in
[the dispatcher contract](18-ha-local-dispatcher.md).

The reviewed operation compares the loaded instance, monotonic expiry and a digest
of publication identity/history/persistence, dispatcher generation/state and local
configuration under the dispatcher control lock and bridge persistence lock. It
then rechecks the existing operation guards. A separate observer resolves the
currently loaded dispatcher and reads bridge status and existing diagnostics after
each attempted action, including rejection or an uncertain acknowledgment. Only
bounded status and fixed error explanations are displayed; raw exceptions are not.

Synthetic regressions live in `companion/tests/test_administration.py`. The opt-in
actual HA workflow is:

```sh
/tmp/jukelet-ha-companion-venv/bin/python -m companion.administration_probe
```

Use the pinned isolated environment described in [companion installation](../companion/README.md).
The probe accepts no target, credential or existing configuration arguments. It
creates owned temporary HA processes, generated users and inert scripts. It drives
the real HTTP options flow, checks nonadmin creation/read/forged-continuation denial,
declined confirmation, separate reconciliation/enable/disable and legacy attestation,
stale competing intentions, overlapping fence writes, lost/malformed acknowledgments,
unavailable readback, busy startup, missing/malformed completion and actual clean
and uncertain process restarts. Fault injection exists only in probe code. No
household system, credentials, receiver or provider is involved.

This exercises HA flow results/schema/translations over actual HTTP, not a rendered
HA frontend. The pinned minimal HA environment has no `hass_frontend` package. The
app's component and Chromium fixture workflows exercise the read-only navigation
guidance, keyboard/mobile status and absence of administrative requests. Exact
commands, versions, source manifests, failures/corrections and independent results
are retained in the task PR/run evidence. Synthetic execution does not prove
household recovery, actual playback, detached external work stopped, HA OS behavior
or support beyond HA Core 2026.10.2. Live use requires separately approved scope.
