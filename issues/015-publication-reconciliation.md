# JBM-015 — Connect app publication, revision reconciliation and status UI

**Suggested milestone:** M3  
**Suggested labels:** backend, frontend, reliability  
**Dependencies:** JBM-008, JBM-010, JBM-012

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Show exactly when desired assignments become active in HA and handle uncertain outcomes safely.

## Scope

Generate immutable canonical snapshots, persist publication jobs, publish through the approved bridge and read back status. Display local desired versus active revision, pending removals/disables, errors and reconciliation-required states. Auto-queue saves only after explicit migration activation.

## Acceptance criteria

- [ ] Checksum golden vectors match the companion.
- [ ] Lost acknowledgment reconciles before retry; in-flight payloads are never mutated.
- [ ] Same-revision conflicts and restored database/publisher mismatches stop unsafe publication.
- [ ] Pending delete/disable clearly warns that the prior active mapping may still play.
- [ ] Actual active revision/checksum, not HTTP success alone, drives the success UI.
- [ ] Rename and publication remain independent outcomes.
- [ ] Test-playback, if included, is a separate explicitly authorized action with real result semantics.

## Verification

End-to-end app/bridge fixture tests plus isolated HA publication/readback. No automatic household cutover.

## Out of scope

No silently enabling dispatch, arbitrary automation control or pretending eventual synchronization is an atomic distributed save.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
