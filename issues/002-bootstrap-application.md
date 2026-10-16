# JBM-002 — Bootstrap application, authentication boundary and CI

**Milestone:** M0  
**Labels:** foundation, security, testing  
**Dependencies:** [#1 — JBM-001](https://github.com/skoglump/jukelet/issues/1)

**GitHub issue:** [#2](https://github.com/skoglump/jukelet/issues/2). JBM-002 is the stable planning key.

## Goal

Create a runnable and tested project foundation rather than a UI-only mockup.

## Scope

Create React/TypeScript frontend and Python/FastAPI backend packages, locked dependencies, and a SQLite migration foundation. Build a single Docker container serving frontend and backend with one backend worker/instance, Docker Compose development/deployment configuration, a persistent SQLite volume, minimal health route and fixture-friendly test setup. Implement the approved app auth/secret boundary with secrets outside the image and an enforced read-only default. Document actual supported versions and commands.

## Acceptance criteria

- [x] Container starts and a real health request succeeds.
- [ ] Frontend/backend build, lint, type and minimal tests run through documented commands and CI.
- [x] Protected routes reject unauthenticated requests; session/origin/CSRF behavior matches the chosen design.
- [x] HA/app credentials stay out of browser assets, tracked files and logs.
- [x] Data volume persists across container replacement; default configuration cannot mutate HA.
- [x] README and AGENTS Commands section contain commands actually exercised.

## Verification

Build/run locally and execute the configured checks using fixtures only; inspect browser output and logs for secret leakage.

## Out of scope

No live HA connection required, Spotify implementation, new dispatcher or elaborate product UI.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Implemented on `feat/issue-2-bootstrap`. Includes the locked frontend/backend foundation, Alembic session migration, owner authentication, minimal accessible UI, non-root Docker runtime, persistent volume, explicit loopback development mode, and CI.

Local verification on October 16, 2026:

- `make bootstrap`: locked uv/npm installations completed.
- `make check`: Ruff lint/format checks and strict mypy passed; 29 pytest tests and 7 Vitest tests passed; ESLint and TypeScript checks passed.
- `make build`: Python source/wheel distributions and Vite production bundle built.
- Docker Compose build and `python3 scripts/smoke.py --browser`: passed real HTTP health/login/logout, origin/CSRF boundaries, SQLite session persistence across replacement, UID 10001 operation, invalid-mode/missing-secret failures, and image/log secret checks. One Chromium end-to-end test passed; mobile login screenshot visually inspected.
- GitHub workflow syntax validated with actionlint. GitHub Actions execution remains pending the PR; the combined local/CI criterion above stays unchecked until verified.

See [development and Docker operation](../docs/10-development.md) for commands, configuration, API/session contract, and deployment limits. Local tool locations/cache overrides were used for the sandbox; supported versions match the documented pins.

No live HA/Spotify/reader access or playback occurred. Linux x86-64 and localhost HTTP were exercised; an actual household HTTPS proxy and other architectures were not. The current Starlette test client emits an upstream httpx deprecation warning; all tests pass. The Python project builds, but distribution to a package index is outside scope. The application image is local only; CI performs no publication or deployment.
