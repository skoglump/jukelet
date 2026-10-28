# App publication, revision reconciliation and status (#30)

The app database owns saved assignments. HA owns tag names and playback. The app
publishes detached v1 execution snapshots through the existing companion; it has
no dispatcher, activation, scan simulation or playback endpoint. Publication does
not enable HA dispatch. Receiver/account preparation, transfer and album/playlist
behavior remain in HA scripts. Only the local `default` profile is accepted.

## Selected operating policy (#39, 2026-10-25)

The owner selected **Automatic** and separately approved the existing persistent opt-in activation. Fresh independent app and direct companion reads verified it enabled, with content, jobs and dispatcher state unchanged. This is an attributed prior authorized outcome, not a new deployment inspection. No live save, restart, fault, playback or restore was performed for #39; restart persistence and failure/conflict suspension evidence remains synthetic. The deployed source was not inspected. The [operator workflow](26-installation-and-operations.md#everyday-assignment-and-publication-workflow) explains normal saves, suspended-mode review and recovery. #31 remains partial with the household restore waiver retained.

## Save, review, publish and read back

The existing editor/delete/restore flows remain the only assignment-saving
flows. A save commits locally without requiring metadata or HA availability.
**Publication** shows the desired app revision/checksum separately from the last
verified publication and fresh actual HA status. **Review snapshot publication**
shows exact IDs, URIs, enabled/shuffle preferences and the checksum. Confirmation
queues that complete immutable content; it does not claim publication success.

Only a separate, healthy `jukelet_bridge/status` read with the exact publisher,
revision and checksum verifies a job. Its captured desired version remains fixed:
finishing an older job cannot mark newer edits published. A pending removal or
disable warns that the previous HA mapping may still play. Rename still uses its
own HA registry readback and can independently succeed or fail. Music provider
failures preserve saved URIs and last-good labels/artwork.

The UI separates saved, pending, published, dispatch-enabled and independently
playback-verified states. No independent Spotify playback verifier exists here;
playback is always unverified. Stale/unavailable status does not certify current
dispatch or publication. Browser polling waits for each request to finish before
scheduling the next and aborts superseded reads.

## Durable jobs and reconciliation

Migration `0004` adds SQLite publication state and immutable job envelopes. Each
job captures the desired version, payload/checksum, reserved revision and exact
base revision/checksum. Revisions reserve monotonically in the same immediate
transaction as queue insertion. Automatic queueing participates in the existing
save/delete transaction. In-flight payloads are never rewritten or rebased.

Startup resets connection health and converts interrupted in-flight jobs to
uncertain. Every write first reads actual companion state, including after a new
socket connection or an HA integration reload within the same connection. The
transport checks the reconciled connection generation again inside the acquired
request slot immediately before sending. Disconnect immediately invalidates the
cached publication gate.

An exact accepted job found by readback completes without resending. A lost or
uncertain response can retry the same immutable envelope only after a fresh
healthy read proves its original base. A transport acknowledgment cannot complete
a job. Known permanent protocol/permission rejections fence the dependent queue
and remain visible instead of entering a periodic retry loop.

Foreign publishers, same-revision checksum disagreement, HA-ahead/HA-behind and a
fresh-looking bridge against an established app latch the durable recovery guard.
Degraded/uncertain history fences publication too. A healthy status that happens
to match later does not clear the guard. Automatic publication is suspended.
Existing queued evidence is retained as fenced rather than silently rebased.

## Reviewed recovery and empty snapshots

Keep protected app and coherent full HA backups. Compare identities and revision
history before selecting **Review publication recovery**. For healthy same-publisher
HA state, this queues the reviewed desired content with the exact observed base
and a new revision above the retained app high-water and observed HA revision.
Only exact healthy readback of that reviewed recovery clears its guard generation.
A subsequent logical/full app restore advances the guard generation and fences
old jobs, so an older recovery completion cannot clear a newer restore guard.
Automatic publication stays suspended after recovery and needs another opt-in.

The public status protocol intentionally does not expose the companion's reserved
history floor. The app cannot repair degraded/foreign history by guessing a
revision or changing identity. Use the existing companion **Configure** recovery
flow, which can review retained history. Missing/corrupt/inconsistent history
requires a known coherent full HA backup. Then return to explicit app recovery;
HA recovery alone does not clear the app guard. Never edit `.storage` or discard
history to force pairing. See [the companion procedure](../companion/README.md).

Every empty mapping-array publication, including after automatic opt-in, needs a
separate explicit empty confirmation. The session-bound review token expires in
15 minutes; it binds action, exact desired version/checksum and observed HA
publisher/revision/checksum/persistence. Changed content or actual state invalidates
it. Review tokens are in-memory, bounded to 32 and lost on app restart. Empty
confirmation cannot be reused for different content.

Logical restore always suspends automatic publication and sets the guard in its
assignment transaction. The offline database recovery utility preserves identity,
reserved revisions and immutable jobs, advances the guard, fences outstanding jobs
and invalidates sessions before making its new output usable. It requires schema
`0004`; migrate an offline disposable copy of older backups first. A complete joint
rollback of all app and HA history to an indistinguishable coherent past cannot be
detected from those restored copies alone; retain independent protected recovery
evidence and review it. No counter-reset or identity-change escape hatch exists.

## Explicit persistent automatic-publication opt-in

The owner approved a separate app opt-in after backup, exclusive-dispatcher and rollback
prerequisites have been completed. It requires currently reviewed content already
verified active, no enabled-row preference conflicts, no outstanding job, and
explicit attestation that backup, exclusive tag-playback dispatch and rollback
prerequisites were handled outside the app. It never configures HA dispatch or
changes automations. This implementation does not perform household migration.

The persisted choice survives clean app restart, but writes still require fresh
reconciliation. Later saves auto-queue only while reconciliation is healthy and
no recovery guard exists. Conflicts/recovery suspend opt-in. Album shuffle-on and
playlist shuffle-off on enabled mappings are visible conflicts under the approved
HA behavior; saved preferences are never silently rewritten. An automatic empty
snapshot waits for a reviewed, content-bound empty confirmation.

**Suspend automatic publication** stops future automatic queue creation. Already
queued reviewed snapshots can still publish; the control and result explain this.
Recovery/conflict fencing stops their unsafe dependent writes instead.

## App API

Read-only [playback diagnostics](22-playback-diagnostics.md) use the independent
`GET /api/v1/playback-status` interface. They do not call publisher reconciliation
or change its jobs/guards, and unsupported diagnostics do not break the existing
publication contract. Publication and operational readiness remain distinct.

All routes require an authenticated app session. POST requires same-origin, CSRF
and `APP_MODE=manage`; the existing bounded strict JSON parser applies.

| Route | Request / result |
|---|---|
| `GET /api/v1/publication` | Fresh actual-state reconciliation and normalized desired/active/job/guard/automatic/telemetry status. Never publishes. |
| `POST /api/v1/publication/review` | `{action: "publish" | "recover" | "activate"}` → token, exact mappings/version/checksum, empty/conflict/removal flags and actual status. |
| `POST /api/v1/publication/confirm` | `{review_token, confirmed: true, confirm_empty: boolean, automatic_publication_attested: boolean}` → current status after durable queue/opt-in commit. No transport-success claim. |
| `POST /api/v1/publication/suspend` | Disable future automatic queue creation; retain already queued immutable work. |

Review/precondition failures return 409 with bounded `detail.code`; authentication,
mode/CSRF/Origin and validation use the existing 401/403/422/413/415 semantics.
HA credentials stay server-side. Status ignores unsupported execution telemetry
rather than inferring independently verified playback.

## Verification and limits

`make check` includes independent app golden-vector tests and authenticated app API
→ actual loopback HAAdapter WebSocket → supported companion Bridge fixtures.
These exercise concurrent edits, queued restart, committed/uncommitted lost
responses, immutable retry, same-revision/foreign/degraded/restore fences, guard
generations, permanent rejections, empty confirmation, automatic-publication opt-in and malformed
telemetry. Component and Chromium fixture workflows cover mobile/keyboard review,
pending removal/disable, explicit empty consent, stale/error/recovery and provider
failure. The Vite fixture is explicitly synthetic and has no backend/HA proxy.

The separately opt-in actual-process probe uses the pinned HA environment and the
locked app environment created by `make bootstrap`:

```sh
/tmp/jukelet-ha-companion-venv/bin/python -m companion.publication_probe
```

It accepts no target/config/credential arguments and creates its own temporary
HA processes, app subprocess, generated credentials and loopback ports. It reuses
the existing runtime probe's authenticated protected Core backup/restore and
supported Store/options-flow seams. Only probe code can delay a response or pass
generated child credentials over its private pipe; no fault endpoint ships.
Dispatch stays disabled and no script, playback, Spotify, automation or physical
reader integrations are loaded.

The probe is synthetic actual-HA integration evidence, not household verification,
power-loss durability, independent Spotify playback, deployment or migration.
Exact run results are recorded with the issue completion evidence.
