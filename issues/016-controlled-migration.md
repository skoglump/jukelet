# JBM-016 — Perform owner-approved migration and rollback verification

**Suggested milestone:** M3  
**Suggested labels:** migration, testing, operations  
**Dependencies:** JBM-009, JBM-010, JBM-014, JBM-015

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Activate the new runtime only after backups, a reviewed diff and explicit approval, then verify the intended reliability boundary.

## Scope

Follow the migration runbook with fresh configuration reads, protected backups, disabled companion publication, old-dispatcher disable/readback and new-dispatcher enable/readback. Exercise approved real scans, app-stop behavior, HA restart and rollback.

## Acceptance criteria

- [ ] Approval, exact target scope, backups and rollback plan are documented privately.
- [ ] No interval has two enabled playback dispatchers.
- [ ] Actual content/target/playback is checked after owner-approved album and playlist scans.
- [ ] Unassigned/disabled tags and duplicate/busy policies behave as agreed.
- [ ] App stopped and HA restarted scenarios are verified separately.
- [ ] Rollback restores a single working legacy dispatcher and explains any mapping differences.
- [ ] Unperformed cold/account-switch or recovery checks are stated as limitations, not passed.

## Verification

Record redacted live evidence with actual receiver/account conditions. If authorization or hardware checks are unavailable, leave this issue open/blocked rather than faking completion.

## Out of scope

No unattended production migration, unrelated household changes, publishing private backups or broad automatic HA reloads.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
