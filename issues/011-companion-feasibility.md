# JBM-011 — Spike HA companion persistence and approve the bridge contract

**Suggested milestone:** M3  
**Suggested labels:** architecture, spike, integration  
**Dependencies:** JBM-007

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Resolve the highest-risk runtime assumptions before committing to a companion implementation.

## Scope

Choose dedicated HA integration versus deliberate local Pyscript implementation. In an isolated/test HA environment, prove supported storage, schema validation, restart loading, service/WebSocket response behavior and disabled-by-default dispatch. Finalize protocol names, canonical checksum serialization and limit values.

## Acceptance criteria

- [ ] Decision record identifies implementation, alternatives and maintenance scope.
- [ ] Real test-environment restart demonstrates persisted snapshot recovery.
- [ ] Failure/interruption behavior and acknowledgment timing are documented with evidence.
- [ ] Bridge schema, exact transport, status/readback and checksum golden vectors are agreed.
- [ ] Installation and publication do not enable dispatch.
- [ ] Unproven durability/response claims remain blockers, not assumed features.

## Verification

Execute a bounded spike with clearly labeled test data; retain the result and decide proceed/pivot. No household install without separate approval.

## Out of scope

No two competing companion implementations, metadata browser, production migration or receiver authentication rewrite.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
