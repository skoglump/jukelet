# JBM-010 — Implement versioned export, restore preview and safe backup workflow

**Suggested milestone:** M2  
**Suggested labels:** backend, recovery, documentation  
**Dependencies:** JBM-008

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Make assignment data portable and recovery predictable without exporting secrets or rewinding runtime state.

## Scope

Add logical JSON export and two-step restore, schema-version validation, conflict reporting and a consistent SQLite backup procedure. Preserve exact IDs/preferences/Unicode; keep live names informational during restore.

## Acceptance criteria

- [ ] Export excludes credentials, sessions, raw HA traces and private metadata cache by default.
- [ ] Restore has a preview and explicit confirmation/conflict policy.
- [ ] Round-trip tests preserve supported mappings and report unsupported content.
- [ ] Restore does not silently rename HA tags or adopt another publisher identity.
- [ ] Design prevents later M3 auto-publication when restored state trails HA’s active revision.
- [ ] Documented database backup/restore procedure is exercised on a test instance.

## Verification

Round-trip, corruption, unsupported schema and conflict tests; prove backup consistency without a household mutation.

## Out of scope

No automatic overwrite of live HA mappings, revision-counter rewind or opaque raw database upload endpoint.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
