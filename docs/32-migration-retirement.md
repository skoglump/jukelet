# Standalone operation and automation migration retirement (#51)

App **0.1.0-rc.3** (`0.1.0rc3` in Python) and separately installed integration
**0.1.5** are new prepared identities. They are not releases or deployed upgrades.
Do not replace any previously published RC image, integration archive or tag.

## Current behavior and compatibility

No old automation, automation entity ID or mapping report is required. HA supplies
tag identity/names; SQLite supplies assignments and preferences; the companion
executes a versioned snapshot through the configured local playback script.
Inventory joins each page with saved assignments. Disabled assignments count as
assigned. Filters/search describe this page of saved data, not active HA content.
Publication reports independent actual-state readback. Saved, published,
dispatch-enabled and independently playback-verified are distinct; no independent
Spotify playback verification has been added.

`LEGACY_AUTOMATION_ENTITY_ID` is no longer read, validated, forwarded by Compose or
stored in settings. Old environment values, including malformed ones, are ignored
without logging them. Remove obsolete values during normal deployment upkeep.
No compatibility path fetches `/api/config/automation/config/*` or selects an old
automation. Both configured-source and uploaded JSON/YAML `variables.tags` imports,
source reports, confirmation tokens and parser are removed. PyYAML remains a dev
dependency for independent HA preservation tooling, not an app runtime dependency.

The old `/api/v1/imports/preview` and `/api/v1/imports/confirm` POST URLs have only
rejection tombstones: authenticated, same-origin requests return HTTP **410** with
`detail.code: automation_import_retired`, even for malformed bodies or stale tokens.
Unauthenticated requests return 401; invalid Origin/host keeps existing 403/400
boundaries. Bodies are not parsed and no HA calls or domain transactions occur.
No replacement bulk importer is introduced. `/api/v1/export`, `/api/v1/restores/*`
and guarded SQLite backup/recovery retain their existing contracts.

App `/api/v1/publication/confirm` replaces request field `migration_attested` with
`automatic_publication_attested`. The old field is an unknown field and returns
422; there is no alias. A new session-bound, expiring review and explicit
confirmation of backups, exclusive tag-playback dispatch and rollback is required
for a new automatic-publication opt-in. Existing persisted opt-in is the same
choice to automatically publish later saves, and is retained; healthy reconciliation,
content/conflict checks and recovery suspension still gate every publication.
No old request or in-memory review is converted into new consent.

Integration 0.1.5's HA options form replaces `confirm_legacy_disabled` with
`confirm_exclusive_dispatcher`: the administrator verifies **no other tag-playback
dispatcher is active or will resume after restart**. Old form submissions cannot
satisfy that checkbox. Its internal guarded-control parameter becomes
`confirmed_exclusive_dispatcher`; there is no compatibility alias. Existing v1
snapshot/status/readback and low-level administrator WebSocket command shapes
remain unchanged. Those low-level commands retain their documented separate
operator review boundary; app sign-in does not grant HA administrator authority.
Fresh expiring options intents, independent readback and separate stopped-work
reconciliation remain. Controls do not invoke playback.

There are no SQLite, config-entry, snapshot/history or activation Store schema
changes. Saved assignments, URIs, preferences, metadata behavior, publisher and
config-entry IDs, revisions, tombstones and execution fences remain. The remembered
enable/disable choice introduced in 0.1.4 retains its meaning and healthy startup
checks; upgrade does not create a new choice. Uncertain/degraded/recovered state
stays paused, and old scans are never replayed. Restored content is never implicitly
republished. An old app may still read unchanged bridge protocols, but use matched
current app/UI assets for the changed app consent request and HA form.

## Upgrade and reproducibility

Use protected coherent backups, stop the publisher for maintenance, replace the
complete integration directory, restart, then independently verify loaded
version/source/hash and fresh readiness. Preserve all stores/config-entry data and
the configured script/profile/timeout. Never delete identity/history or edit HA
`.storage` to force an upgrade. Keep automatic publication suspended when reviewing
recovery; ordinary compatible updates preserve existing choices and do not grant
new consent. See [distribution](24-integration-distribution.md) and
[operations](26-installation-and-operations.md) for the established supported path.

Build one archive from the exact reviewed committed integration source with
`scripts/package_integration.py --ref <full-commit> --output <new-owned-directory>`.
Use those identical bytes for minimum Core 2026.10.3, discovered current stable
and upcoming beta early warning under [the compatibility policy](30-ha-compatibility.md).
CI resolves the selected Core source commit’s exact `.python-version` and provisions
it with the pinned setup-python action before pinned uv creates the HA environment.
This permits new Python patches absent from uv’s bundled download catalogue without
overriding upstream dependencies.

Record the archive SHA-256, source commit/tree/per-file manifest, imported Core/Python
and upstream dependency identities; a changed runtime/package source needs a new
identity. No archive is published by this issue.

Current CI replaces `migration` with `standalone`. The standalone probe loads no
automation integration and exercises real app publication, preference conflicts,
busy/duplicate rejection, exact IDs, app-stopped inert-script execution, automatic
opt-in persistence and healthy enabled/disabled process restarts with no replay.
Existing publication/runtime/dispatcher/administration/distribution/tag probes
retain recovery, malformed input, uncertainty, pairing, upgrade and fencing cases.
Unit/API/browser fixtures cover inventory/onboarding/rename, saved assignment display,
retired requests and native data recovery. These are separate evidence classes;
passing fixtures is not an actual HA result.

Historical migration rehearsal and its exact importer are reproducible from
[source 46104123165599e2adb71505993c948fe4eba5b2](https://github.com/skoglump/jukelet/tree/46104123165599e2adb71505993c948fe4eba5b2)
in a separate disposable checkout with its pinned dependencies, using
`python -m companion.migration_probe`. Do not run historical probes against current
source or an existing installation. Earlier reports and immutable archives retain
their dated scope; retirement does not rewrite them.

## Separate HA decommission procedure — additional authorization required

This repository change performs no household inspection or deletion. Removal of an
old tag-trigger automation and any exclusively owned helpers is a separate change:

1. Obtain scoped read authorization and inspect references to the selected old
   automation and candidate helpers using supported HA facilities. Include tag
   triggers, scripts, scenes, dashboards, other automations and restart behavior.
   Produce a concrete reference/change list. Never dump entire private configuration.
2. Identify and retain the active configured playback script and **every shared
   dependency**, including nested preparation, account activation, receiver power,
   transfer/readiness helpers and integration entities. Sharing or uncertain
   ownership excludes a helper from deletion until resolved.
3. Create protected, coherent full HA backups (including config entries and all
   companion snapshot/history/fence/activation stores), consistent app SQLite backups,
   and portable native exports where useful. Retain recovery keys privately. Record
   exact identities/counters and the intended disabled/enabled choices. Follow the
   existing restore-testing waiver; having backups is not proof that they restore.
4. Prepare the exact deletion list, supported HA operation for each item, independent
   readback checks, maintenance order and rollback plan. Obtain **explicit deletion
   authorization** for that list. Repository/upgrade permission does not authorize
   deleting an automation, helper or script.
5. Stop admission/publisher activity as the approved plan requires, read back stopped
   state, and separately establish all nested/external work stopped where relevant.
   Perform only the authorized supported UI/API/configuration operations; never edit
   HA `.storage`. Independently verify removed references and preserved dependencies.
6. Before any resumed dispatcher, verify exactly one intended dispatcher can run,
   including after restart. Restore/rollback must reconcile current app authority and
   monotonic history. **Old backups can restore a competing dispatcher and an old
   automation mapping is not the current assignment master.** Never blindly re-enable
   that stale automation as a recovery shortcut. A coherent supported restore may
   also restore a remembered enabled choice; plan admission control before restore.

No new household restore, HA OS/Supervisor, physical reader, receiver/Spotify or
power-loss test is claimed. The [restore-testing waiver and prior limitations](20-controlled-migration.md)
remain unchanged. Actual synthetic HA script captures establish invocation/completion
contracts only, not physical playback.
