# JBM-014 — Implement the single HA-local tag playback dispatcher

**Suggested milestone:** M3  
**Suggested labels:** integration, playback, reliability  
**Dependencies:** JBM-012, JBM-013

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Resolve scans from the active HA snapshot and invoke the configured script without the app in the execution path.

## Scope

Handle enabled known mappings, unassigned tags, profile resolution, snapshot consistency, bounded duplicate suppression and the approved busy-scan policy. Add bounded correlation/error diagnostics without leaking private raw payloads.

## Acceptance criteria

- [ ] Each accepted scan resolves against one immutable active revision.
- [ ] Unknown/disabled tags do not invoke playback.
- [ ] Installation/publication never silently enable the dispatcher.
- [ ] Duplicate scans and competing requests follow the documented bounded policy.
- [ ] Backend scan observation cannot trigger a second playback path.
- [ ] Diagnostics distinguish script acceptance from verified playback.
- [ ] App-stop and HA-restart tests work using an isolated playback stub.

## Verification

Run event/queue tests in isolated HA. Live synthetic events are not permitted by default; real playback is a later authorized cutover check.

## Out of scope

No second backend dispatcher, arbitrary per-tag automations or unbounded queue/retry loops.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
