# JBM-007 — Verify and document the M1 read-only milestone

**Suggested milestone:** M1  
**Suggested labels:** testing, documentation  
**Dependencies:** JBM-006

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Establish a trustworthy read-only release boundary before allowing HA writes.

## Scope

Exercise build, container, auth, adapter and UI checks; document a separately authorized live read-only verification path. Record actual tag/mapping reconciliation and supported provider capabilities, not hardcoded historical counts.

## Acceptance criteria

- [ ] All default checks run without household credentials/network access.
- [ ] Live-read report is present only if authorized/executed; otherwise its status is explicitly pending.
- [ ] Reconnect and metadata-failure behavior are demonstrated.
- [ ] No automation, tag, power, volume, account activation or playback mutation occurred.
- [ ] Documentation distinguishes subscription acknowledgment from physical scan verification.
- [ ] The app is usable as a read-only manager, not merely a static screen.

## Verification

Use the evidence template in the testing document and retain only redacted results.

## Out of scope

No permission escalation, live mutations or declaring unperformed checks passed.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
