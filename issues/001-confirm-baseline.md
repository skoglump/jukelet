# JBM-001 — Confirm baseline scope and repository decisions

**Milestone:** M0  
**Labels:** planning, architecture  
**Dependencies:** None

**GitHub issue:** [#1](https://github.com/skoglump/jukelet/issues/1). JBM-001 is the stable planning key.

## Goal

Record the minimum decisions needed to start implementation without turning recommendations into unapproved requirements.

## Scope

Confirm the read-only-first sequence, stack, single-instance scope, ownership model and agent safety rules. Use the owner-approved Jukelet name, tagline and description recorded in the project brief and decision register. The GitHub repository is currently public; confirm the intended publication scope and record the outstanding license decision; defer the companion implementation choice to JBM-011.

## Acceptance criteria

- [ ] Decision register identifies accepted, provisional and deferred choices.
- [ ] M0/M1 scope and no-live-mutation boundary are explicit.
- [ ] Owner-specific identifiers/secrets are excluded from repository material.
- [ ] Unresolved M3 choices do not unnecessarily block a read-only prototype.

## Verification

Review the project brief, architecture and decision register together for consistency. No live access is needed.

## Out of scope

No app implementation, GitHub publication, companion installation or license selection on the owner’s behalf.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
