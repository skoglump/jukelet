# JBM-001 — Confirm baseline scope and repository decisions

**Milestone:** M0  
**Labels:** planning, architecture  
**Dependencies:** None

**GitHub issue:** [#1](https://github.com/skoglump/jukelet/issues/1). JBM-001 is the stable planning key.

## Goal

Record the minimum decisions needed to start implementation without turning recommendations into unapproved requirements.

## Scope

Confirm the read-only-first sequence, stack, single-instance Docker deployment, ownership model and agent safety rules. Use the owner-approved Jukelet name, tagline and description recorded in the project brief and decision register. Record the approved public repository scope and MIT license; defer the companion implementation choice to JBM-011.

## Acceptance criteria

- [x] Decision register identifies accepted, provisional and deferred choices.
- [x] M0/M1 scope and no-live-mutation boundary are explicit.
- [x] Owner-specific identifiers/secrets are excluded from repository material.
- [x] Unresolved M3 choices do not unnecessarily block a read-only prototype.

## Verification

Review the project brief, architecture and decision register together for consistency. No live access is needed.

## Out of scope

No app implementation, companion installation or license selection on the owner’s behalf. The owner selected MIT; this issue records that selection.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Completed October 16, 2026. The owner approved React/TypeScript, FastAPI, SQLite, one Docker container/backend instance, persistent SQLite storage, Compose deployment, fixture-first development, read-only-first scope, HA/app ownership, public development and MIT licensing.

Evidence: [decision register](../docs/08-decisions-and-risks.md), [architecture](../docs/02-architecture.md), [project brief](../docs/01-project-brief.md), [LICENSE](../LICENSE), and [AGENTS.md](../AGENTS.md).

Verification: reviewed the brief, architecture, milestones and decision register for consistency; checked repository material for credentials and household identifiers; checked local Markdown link targets and Git whitespace while allowing intentional Markdown hard breaks. No live HA access or application tests were run; application commands do not exist yet.

Runtime/package versions and the exact authentication implementation remain JBM-002 work. M3 companion/persistence/transport choices remain gated by JBM-011 and do not block the read-only foundation.
