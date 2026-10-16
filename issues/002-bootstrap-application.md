# JBM-002 — Bootstrap application, authentication boundary and CI

**Milestone:** M0  
**Labels:** foundation, security, testing  
**Dependencies:** [#1 — JBM-001](https://github.com/skoglump/jukelet/issues/1)

**GitHub issue:** [#2](https://github.com/skoglump/jukelet/issues/2). JBM-002 is the stable planning key.

## Goal

Create a runnable and tested project foundation rather than a UI-only mockup.

## Scope

Create frontend/backend packages, locked dependencies, SQLite migration foundation, a single-container build, Compose development configuration, persistent volume, minimal health route and fixture-friendly test setup. Implement the approved app auth/secret boundary and enforced read-only default. Document actual supported versions and commands.

## Acceptance criteria

- [ ] Container starts and a real health request succeeds.
- [ ] Frontend/backend build, lint, type and minimal tests run through documented commands and CI.
- [ ] Protected routes reject unauthenticated requests; session/origin/CSRF behavior matches the chosen design.
- [ ] HA/app credentials stay out of browser assets, tracked files and logs.
- [ ] Data volume persists across container replacement; default configuration cannot mutate HA.
- [ ] README and AGENTS Commands section contain commands actually exercised.

## Verification

Build/run locally and execute the configured checks using fixtures only; inspect browser output and logs for secret leakage.

## Out of scope

No live HA connection required, Spotify implementation, new dispatcher or elaborate product UI.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
