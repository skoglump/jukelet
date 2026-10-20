# Testing, security and migration

## Test layers

1. **Unit:** exact-string tag joins, URI parsing, media-kind agreement, importer validation, checksum canonicalization, revision comparison, error classification and state transitions.
2. **Adapter/contract:** sanitized fixture envelopes for HA and each provider response variant, timeouts, forbidden access, missing services, unexpected nesting, pagination and rate limits. No credentials required.
3. **Application integration:** isolated SQLite database, migrations, optimistic edits, preview/confirm import, local restore and authentication/CSRF checks.
4. **UI:** mobile/keyboard workflows, pending discovery, unavailable metadata, publication lag, stale edit and partial rename failures.
5. **Companion:** simulated registry/dispatcher/script boundary, atomic snapshot lifecycle, restart/crash recovery, queue/debounce behavior, dispatch-disabled installation.
6. **Opt-in live reads:** explicitly authorized HA inventory/service discovery/metadata checks, with redacted outputs.
7. **Opt-in live mutations/playback:** separately authorized bounded scripts for rename, migration and physical scans. Never part of ordinary CI.

Record fixture origin and schema version. Label illustrative/synthetic data as such. Do not call it a sanitized live capture unless actually derived from one with provenance. The bundle contains no full original payload fixtures.

## Essential regression cases

| Scenario | Expected result |
|---|---|
| Scan event arrives before registry entry | Pending discovery, then bounded reconciliation; no racing create |
| Backend disconnected during scans | Registry refreshed after reconnect; no fabricated historical event list |
| Registered tag has no assignment | Unassigned UI; no playback by the new dispatcher |
| Saved mapping's tag disappears from HA | Orphan warning; keep mapping pending owner decision |
| Mix lookup returns not-found | Assignment and previous display metadata retained |
| Provider response unexpectedly nested | Adapter error, not empty-success search |
| Two browsers edit one assignment | One succeeds, stale edit gets a conflict |
| Rename fails after local save | Honest partial success and targeted retry |
| Disabled/deleted assignment not yet published | UI says old active mapping may still play |
| Publication response lost | Query actual revision/checksum, then reconcile |
| Same revision/checksum repeated | No duplicate application; idempotent response |
| Same revision/different payload | Reject conflict; keep current snapshot |
| Older/foreign publisher revision | Reject and require reconciliation |
| Snapshot write interrupted/corrupt | Old good snapshot or explicit degraded state; no silent empty replacement |
| App stopped; HA restarted | Last good mapping loads locally, no app dependency |
| Duplicate rapid scans | Apply documented debounce without swallowing later intentional scans |
| Another scan during receiver preparation | Apply agreed bounded latest-pending policy or approved alternative |
| Script fails/times out | Record failure/unknown; no unbounded replay of playback |
| Authentication unavailable | Protected API stays closed; no LAN trust assumption |

## Security requirements

- Separate app authentication from HA authentication. Keep both secrets server-side and redact all diagnostics.
- Do not claim a least-privilege tag-only HA token exists. Document the actual permissions used and the impact of credential compromise.
- Use origin validation, CSRF protection, appropriate HttpOnly/Secure/SameSite session cookies, bounded login attempts and logout/session expiry.
- Validate configured HA origin and disallow arbitrary service/domain/URL passthrough from the UI.
- Restrict file upload type/size and use safe parsers. Never evaluate imported YAML tags, Python, Jinja or arbitrary expressions.
- Validate artwork URL handling. Prefer an allowlisted policy; any proxy must prevent redirects/private-network SSRF and bound size/content type. Never forward HA authorization to artwork hosts.
- Exclude tokens, cookies, household configuration, private metadata, account/device IDs and raw traces from public fixtures/logs/screenshots.
- Prevent untrusted web content from becoming executable instructions or HTML; render labels/metadata safely as text.
- Keep the application unexposed to the public internet initially. Document TLS/reverse-proxy requirements for remote access, dependency updates and credential rotation.
- Review Spotify display/linking/caching obligations before public release; this document does not grant reuse rights or promise permanent API access.

## Migration plan (only after M3 implementation)

### Preparation

1. Obtain explicit owner approval for the target HA instance, automation, playback script and test conditions.
2. Take protected backups of the original automation/script configuration and application database/export. Do not commit the household backups.
3. Read current registry and automation again. Reconcile against preview fingerprints and show a human-readable diff, including unsupported rows.
4. Verify the playback script preserves existing preparation, transfer and album/playlist behavior. Keep house-specific settings configurable.
5. Install the companion with dispatch **disabled**. Read back that status.
6. Publish a reviewed snapshot, verify revision/checksum and durability while dispatch remains disabled. Merely installing a file does not prove restart behavior.

### Cutover

7. Announce a brief maintenance gap. Disable the old dispatcher and read its state back; do not proceed if uncertain.
8. Enable the new dispatcher and read back its state. If this fails, disable/verify the new one before restoring the old one.
9. Use owner-approved real scans to test a known album, known playlist, unassigned tag and duplicate-scan behavior. Record actual receiver/account conditions. Do not manufacture scans on the live event bus without separate permission.
10. Verify the requested content/target and advancing playback where available, not just a service acknowledgment. Keep any unverified scenario explicit.
11. Stop the management app and test an assigned scan. Separately test HA restart/snapshot reload under agreed conditions. Neither proves Spotify works without a network.

### Rollback

12. Disable and verify the new dispatcher before re-enabling the old one. Restore the original configuration if it was changed, run the appropriate HA validation, and verify enabled state.
13. Explain that assignments made only in the new app may not exist in the restored legacy automation. Show the difference; do not silently promise parity.
14. To roll back mapping content within the new system, publish the chosen prior content as a new revision, not a revision-counter rewind.

Every external change needs readback. No simultaneous active dispatchers, no broad hidden HA reloads, and no automatic migration on container startup.

## Evidence report template

For each check record: environment/version, fixture or live, authorization scope, command/test name, expected result, actual result, redacted evidence location, pass/fail/blocked, and remaining limitations. A blocked live test must remain blocked; fixture success is not a substitute.

The [M1 verification report](14-m1-verification.md) records the issue #15 fixture checks and a separately authorized live-read checklist. Live verification remains pending; synthetic success does not close the full M1 live exit gate.
