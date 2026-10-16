# JBM-017 — Complete release hardening and installation documentation

**Suggested milestone:** M4  
**Suggested labels:** security, documentation, release  
**Dependencies:** JBM-016

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Prepare a maintainable release with a support boundary matching what was actually tested.

## Scope

Document installation, configuration, companion pairing, migration, upgrades, backup/restore, compatibility and known provider limits. Review authentication, uploads, URL/artwork handling, redaction, accessibility and dependency/license status.

## Acceptance criteria

- [ ] Clean install and supported upgrade/restore are exercised on documented environments.
- [ ] Security tests cover auth/session/origin, arbitrary service/URL prevention and secret redaction.
- [ ] Accessibility/mobile checks pass or known issues are explicitly tracked.
- [ ] Provider cache/artwork/link obligations have been reviewed and reflected in behavior.
- [ ] Owner-selected license, supported versions and known limitations are present.
- [ ] Release notes distinguish fixture, isolated-HA and household verification.
- [ ] No credentials/private home configuration appear in the source, fixtures, docs or release artifacts.

## Verification

Run release checklist and real build/test pipeline. Public publishing requires an explicit request separate from preparing artifacts.

## Out of scope

No promise to support untested HA/provider versions, multi-tenant SaaS or every future enhancement.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
