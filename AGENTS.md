# Agent instructions

## Project intent

Build a standalone tag-to-Spotify management app. Home Assistant owns tag identity/name and performs playback; the app owns assignments. Preserve existing household playback logic. Read `README.md`, `docs/01-project-brief.md`, `docs/02-architecture.md`, and the assigned issue before editing.

The M0 foundation lives in `backend` and `frontend`, with Docker/Compose and CI. M1 and later contracts remain proposals. Confirm the real repository layout and available commands rather than assuming them.

## Scope and workflow

- Implement one assigned issue or explicitly agreed milestone at a time. Do not implement the entire backlog unasked.
- Read dependencies and acceptance criteria. Raise conflicts rather than silently rewriting the architecture.
- Use the suggested stack unless the issue explicitly approves a change. Record material decisions in `docs/08-decisions-and-risks.md` or a subsequent ADR.
- Keep changes focused, typed, modular and tested. Separate HA transport, Spotify provider, importer, domain logic and UI.
- Update docs and actual development commands when behavior changes. Do not publish hypothetical commands as verified.
- Do not create remote repositories, issues, releases, or deployment changes without an explicit request covering that action.

## Safety boundaries

- Default to fixture data and read-only HA access. Default tests must not need secrets, HA, Spotify, or a physical reader.
- Live verification requires explicit authorization and documented scope. A permission to read HA is not permission to rename tags, install a companion, change automations, or play music.
- Never call playback, volume, receiver power, account activation, tag-scan simulation, or automation editing services in ordinary tests.
- Never bypass a denied operation by switching transports.
- Never read HA credential stores or copy Spotify tokens into this app. Use the configured HA service interface.
- Keep secrets server-side, outside git, logs, fixtures and browser storage. Do not embed real household IDs in examples.
- Do not edit HA `.storage` files. A future companion may own its own supported persistence; this is not permission to edit other integrations' stores.
- Do not automatically migrate the live jukebox. Require a backup, explicit cutover approval and rollback procedure. Never leave two live playback dispatchers enabled.

## Domain invariants

- Preserve opaque tag IDs exactly; reject unsupported input rather than silently repairing IDs.
- HA is authoritative for tag names. Local name edits are intents until readback succeeds.
- The app database is authoritative for assignments. HA receives a versioned execution snapshot, not a second independently editable master.
- Metadata failure does not imply an invalid or unplayable assignment. Keep saved URIs and last good labels/artwork.
- Validate supported URI type against the media type; do not execute arbitrary imported templates.
- Saved, published, active and playback-verified are different states. Do not collapse them into one success message.
- Preserve the last known good HA snapshot on failed publication. Reconcile uncertain outcomes before retrying writes.
- Ordinary scans must eventually work with the management app stopped; this is not a promise of playback without HA, Spotify or receiver connectivity.

## Verification and reporting

- Add regression tests for behavior changes. Exercise error paths, malformed upstream data and concurrent edits.
- Run the actual lint, type, unit, integration and build checks appropriate to the change. Report exactly what ran and what was unavailable.
- Keep fixtures clearly labeled. Never present mock data as a successful live integration.
- Verify external writes by reading the target back. A transport acknowledgment alone is not proof of effective state.
- Do not log a complete HA configuration, authorization headers, tokens or raw private Spotify data.
- Finish with a short summary: changed behavior, checks/results, limitations and decisions needing the owner.

## Commands

Use Node 24.22.0/npm 11.19.1, Python 3.14.8 and uv 0.13.1. Run from the repository root:

- `make bootstrap`: install locked backend and frontend dependencies.
- `make check`: backend/frontend lint, formatting, types and unit/integration tests.
- `make build`: Python distribution and compiled frontend.
- `make image`: build the single application image.
- `make smoke`: isolated Docker HTTP/persistence/security checks plus Chromium login/logout. First install Chromium with `cd frontend && npx playwright install chromium`.
- `python3 scripts/smoke.py`: container checks without the browser.

Smoke tests create only generated synthetic credentials and their own Compose project/volume, then clean them up. Never point them at a household deployment. See `docs/10-development.md` for local setup and configuration. Record actual results rather than assuming CI or live integration success.
