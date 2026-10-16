# JBM-008 — Implement local assignments, confirmed import and optimistic edits

**Suggested milestone:** M2  
**Suggested labels:** backend, database, frontend  
**Dependencies:** JBM-007

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Let the owner manage desired mappings locally while the existing jukebox remains unchanged.

## Scope

Add assignment storage, safe import confirmation, edit/disable/remove flows, validation, optimistic concurrency and a bounded audit record. Require an exact preview/source fingerprint and explicit merge conflict policy.

## Acceptance criteria

- [ ] Exact tag IDs and explicit album/playlist preferences persist across app restart.
- [ ] Syntactically valid supported URIs can be saved when metadata is unavailable.
- [ ] Concurrent edits produce a conflict rather than overwriting silently.
- [ ] Unsupported imported rows remain in the report; no guessed conversion occurs.
- [ ] UI persistently explains that drafts do not yet drive legacy playback.
- [ ] No save, delete, import or metadata refresh calls playback or edits the legacy automation.

## Verification

Run database migration, API and UI tests including invalid input, rollback, conflicts and disabled mappings.

## Out of scope

No HA publication, tag deletion, automatic migration or track-support expansion.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
