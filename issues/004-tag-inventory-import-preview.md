# JBM-004 — Build tag inventory and safe legacy mapping preview

**Suggested milestone:** M1  
**Suggested labels:** backend, import, testing  
**Dependencies:** JBM-003

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Join HA tags with recognized existing mappings without changing either system’s playback configuration.

## Scope

Normalize tag IDs/names/last scans, create stable application tag keys, read configured automation state/config and parse static variables.tags mappings. Add safe uploaded-file preview as a fallback. Report counts and row-level warnings/rejections.

## Acceptance criteria

- [ ] Exact tag IDs survive joins and exports; hardware-like and UUID-like identifiers are accepted without normalization.
- [ ] Matched, unassigned and orphaned counts are calculated programmatically.
- [ ] Templates, unsupported media, malformed URI/type pairs and changed source fingerprints are explicit diagnostics.
- [ ] Preview performs no app assignment commit and no HA configuration write.
- [ ] Event-before-registry discovery can reconcile without duplicate tag creation.

## Verification

Fixture tests cover the recognized shape, safe YAML handling, duplicates, unsupported rows, missing tags and source drift. Document any separately approved live read.

## Out of scope

No universal Jinja importer, automatic migration, HA tag deletion or silent dropping of unsupported rows.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
