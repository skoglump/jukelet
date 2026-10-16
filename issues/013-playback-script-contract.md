# JBM-013 — Define reusable playback script contract and preserve existing behavior

**Suggested milestone:** M3  
**Suggested labels:** integration, playback, documentation  
**Dependencies:** JBM-011

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Provide a configurable HA playback boundary without moving receiver-specific behavior into the app.

## Scope

Define script inputs/status semantics and a generic reference adapter. Prepare an owner-reviewed extraction plan for the existing automation’s readiness, account preparation, transfer and album/playlist behavior. Keep household configuration out of the public repository.

## Acceptance criteria

- [ ] Inputs include URI/type/preferences, exact tag context, revision and correlation ID.
- [ ] Configured profiles resolve only to allowlisted scripts.
- [ ] Accepted, finished, failed and independently verified playback have distinct meanings.
- [ ] Current receiver/account behavior and relevant album/playlist differences are explicitly preserved or changes are approved.
- [ ] Timeouts/errors do not create unbounded automatic playback retries.
- [ ] A protected backup and authorized regression procedure exist before touching live configuration.

## Verification

Test the generic contract with a stub script in isolated HA. Any real extraction/playback test needs separate approval and state verification.

## Out of scope

No account credential extraction, receiver login implementation, unrelated automation cleanup or hardcoded household identifiers.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
