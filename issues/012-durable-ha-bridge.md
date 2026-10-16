# JBM-012 — Implement durable versioned HA mapping bridge

**Suggested milestone:** M3  
**Suggested labels:** integration, reliability, testing  
**Dependencies:** JBM-011

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Give HA a validated last-known-good execution snapshot that survives application downtime and HA restart.

## Scope

Implement the approved PublishSnapshot/GetStatus operations, publisher pairing, revision/checksum/base-state validation, atomic persistence/activation and explicit dispatch enablement status. Use only locally allowlisted playback profiles.

## Acceptance criteria

- [ ] Same revision/checksum retry is idempotent; stale/conflicting/foreign updates reject safely.
- [ ] Whole-snapshot validation precedes activation; failure leaves old state usable.
- [ ] Durability and actual active revision/checksum are confirmed before reporting success.
- [ ] Corrupt storage and restored-behind-app states have explicit safe recovery paths.
- [ ] Size/schema/duplicate-ID/type/profile constraints are enforced.
- [ ] Restart works without the app; dispatch stays disabled until explicitly enabled.

## Verification

Contract and crash/restart tests on isolated HA, including lost acknowledgments, interrupted persistence and corrupt snapshot handling.

## Out of scope

No music metadata fetching, arbitrary service execution, live migration or app-independent editing of assignments.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
