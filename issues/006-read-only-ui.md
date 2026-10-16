# JBM-006 — Build mobile-friendly read-only tag and music interface

**Suggested milestone:** M1  
**Suggested labels:** frontend, accessibility  
**Dependencies:** JBM-004, JBM-005

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Make the first connected milestone genuinely useful without implying editing is live.

## Scope

Render inventory, tag detail, recognized mapping preview, assigned/unassigned filters, last scan, metadata, manual URI resolution, search/library chooser and separate connection/capability states. Keep editing/rename/play controls unavailable until their stages exist.

## Acceptance criteria

- [ ] Mobile and keyboard workflows work with accessible labels and artwork alternatives.
- [ ] Tag label is distinct from music title, and stale data is visibly marked.
- [ ] Metadata failure does not remove the assignment from the view.
- [ ] Fixture/demo mode is obvious and cannot be mistaken for the household connection.
- [ ] Loading, empty, unauthorized, unsupported and failed states are distinct.
- [ ] Browser receives normalized DTOs, no HA token or complete raw configuration.

## Verification

Run component/UI tests and a real browser smoke check against fixture mode; record the actual result.

## Out of scope

No pretend functional edit buttons, live rename, assignment publication or automatic playback.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
