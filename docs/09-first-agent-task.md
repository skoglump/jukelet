# First coding-agent task

JBM-002 now implements this foundation task. The original bounded prompt below is retained as scope context. See [development and Docker operation](10-development.md) for working commands; after the foundation PR is reviewed and merged, follow the next instruction below.

## Copy-ready prompt

> Read `AGENTS.md`, `README.md`, the project brief, architecture and milestone documents. Inspect the repository before making assumptions. Implement JBM-002 after recording or confirming the required JBM-001 baseline choices. Stop before M1 HA integration work unless I explicitly extend the scope.
>
> Build the actual repository foundation: frontend/backend shell, SQLite migration foundation, dependency locks, Docker/Compose development path, authentication/secret boundary, read-only default, minimal health endpoint and CI. Do not create a pretend fully functioning jukebox UI.
>
> Select supported runtime/package versions using current primary documentation; record what you selected. Establish and run the real build, lint, type and test commands. Document those commands and update the Commands section in AGENTS.md.
>
> Use clearly labeled fixtures and no live household access. Do not rename tags, edit Home Assistant configuration, install a companion, simulate scans, start playback, or extract Spotify credentials. Keep all secrets out of the repository and browser. Do not create or publish remote GitHub objects unless separately asked.
>
> Deliver working code and a concise report of changes, actual command outputs, limitations and unresolved decisions. If a required check cannot run, explain the blocker rather than claiming completion. Do not implement the rest of the backlog automatically.

## Next instruction after M0 passes

Assign JBM-003 for the read-only HA adapter, then follow the dependency order in `issues/README.md`. Provide secrets through the deployment's private mechanism, never as issue text or chat-visible example config. An authorized live read is a separate step; passing fixture tests does not authorize it.

## Review checklist for the owner

- Does the agent distinguish shipped behavior from planned behavior?
- Are real run/test commands present and exercised?
- Is read-only the enforced default, not just a UI convention?
- Are secrets absent from the browser bundle, repository and logs?
- Has the agent stopped at the assigned boundary?
- Are changes small enough to review before the next issue?
