# Milestones and delivery order

Dates and effort estimates are intentionally not promised. Each stage ends with evidence, not a UI screenshot alone. Issue keys below are draft identifiers; map them to real GitHub issue numbers after creation.

## M0 — Repository foundation and safe defaults

**Issues:** JBM-001, JBM-002.

Deliver a runnable application shell, chosen supported runtime versions, locked dependencies, a single Docker container with Docker Compose development/deployment setup, persistent SQLite volume, basic CI, authentication/secrets boundary and read-only default. JBM-001 records the accepted baseline and owner-selected MIT license; JBM-002 implements and verifies the foundation.

Exit criteria:

- A documented command starts the real shell and a health check succeeds.
- Frontend and backend build/type/lint/test commands actually run.
- Browser assets, logs and repository contain no credentials.
- Requests cannot act as an arbitrary HA proxy.
- README and AGENTS contain actual verified commands rather than guessed scripts.

## M1 — Read-only manager

**Issues:** JBM-003 through JBM-007.

Deliver HA tag inventory, importer preview, metadata resolution/library/search according to discovered capabilities, assigned/unassigned filters and connection/error states. The existing automation remains untouched and remains the only playback dispatcher.

Exit criteria:

- Fixture suite covers transport, parsing, failure handling and UI behavior.
- App works with fixtures without credentials and visibly labels that mode.
- Owner-authorized live read confirms tag inventory and legacy-map reconciliation at that time; do not hardcode the session's counts as permanent requirements.
- Metadata errors retain the mapping; malformed provider response is not presented as zero results.
- Reconnect refreshes the registry; subscription ACK is not claimed as physical scan verification.
- No HA mutation, playback, power, volume or scan simulation was used for acceptance.

## M2 — Local assignment management and onboarding

**Issues:** JBM-008, JBM-009, JBM-010.

Deliver reviewed local import, assignment editing, explicit HA renaming, unassigned inbox, logical export/restore and conflict handling. UI clearly states that these are local drafts, not active changes to the legacy jukebox.

Exit criteria:

- All local write APIs reject stale edits and invalid type/URI combinations.
- Missing metadata does not prevent a supported valid URI from being saved.
- Rename and assignment outcomes are independently reported.
- Export/restore preserves exact IDs, preferences and Unicode without secrets.
- A real rename/unknown-tag test is only run with separate permission and readback; otherwise mark the live check pending.
- No legacy automation write or implicit playback occurs.

## M3 — HA-local execution and controlled cutover

**Issues:** JBM-011 through JBM-016.

First approve the companion implementation based on a restart/persistence spike. Then build the bridge, playback-script interface, dispatcher and publisher. Leave dispatch disabled until explicit cutover approval.

Exit criteria:

- Same revision retries are idempotent; conflicting/stale writes are rejected.
- Failed publication leaves the old snapshot intact; lost acknowledgments reconcile correctly.
- Snapshot is durable across HA restart and loads without the app.
- UI distinguishes desired and active revisions, including removals not yet applied.
- Existing receiver/account-preparation behavior is preserved through configured scripts.
- Exactly one playback dispatcher is enabled during normal operation.
- Owner-approved physical scans verify the migrated flow; record account/receiver conditions, not just service HTTP status.
- Stopping the app does not stop mapped-tag execution; rollback is demonstrated or its untested scope explicitly prevents milestone closure.

## M4 — Release readiness

**Issue:** JBM-017.

Deliver tested install/upgrade/backup instructions, compatibility matrix, secret-safe diagnostics, security review, accessibility pass and documented provider limitations. Release only the platforms and behaviors actually exercised.

Exit criteria:

- Clean installation and upgrade/restore paths are exercised on documented environments.
- Dependency versions and licenses are reviewed; owner-selected project license is present.
- Configuration/export/log redaction checks pass.
- Destructive/disruptive actions are explicit; default CI never contacts the household.
- Release notes separate verified behaviors from known limitations.

## Follow-on candidates (not initial commitments)

Reader-to-room routing; multiple playback profiles; physical tag replacement workflow; optional history/diagnostic timeline; explicit track support; localization; alternate music providers; direct Spotify OAuth; HA app/add-on packaging; multiple writers/replicas. Create separate issues only after scope and platform costs are understood.

## Suggested parallelism

After M0, HA adapter work and provider-fixture research can proceed independently. Tag/import UI depends on stable DTOs. The M3 feasibility spike may overlap local editing work, but publication/dispatch implementation must wait for its decision. Do not parallelize conflicting changes to contracts without a shared schema owner.
