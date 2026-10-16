# JBM-009 — Add unassigned-tag onboarding and explicit HA rename

**Suggested milestone:** M2  
**Suggested labels:** frontend, integration, security  
**Dependencies:** JBM-008

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Combine scan discovery, naming and local assignment without confusing partial success or racing HA registration.

## Scope

Build Add tag and unassigned inbox flows; show reader/time context and handle delayed registry appearance. Implement the narrow rename endpoint with permission errors and readback, enabled only in manage mode.

## Acceptance criteria

- [ ] Existing unassigned tags are not falsely labeled as newly scanned.
- [ ] Event-before-registry handling never blindly issues tag/create.
- [ ] Rename success is checked against HA inventory and updates the cache.
- [ ] Assignment save and rename failures are reported independently with targeted retry.
- [ ] No rename/save starts playback or publishes to the legacy automation.
- [ ] Disconnected-period discovery uses registry reconciliation without inventing scan history.

## Verification

Fixture tests first. Real unknown-tag and rename checks require explicit approval; verify actual registry changes and any requested cleanup.

## Out of scope

No browser NFC writing, automatic tag deletion or implicit tag creation via synthetic event.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
