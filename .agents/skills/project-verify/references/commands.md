# Verification commands

Run from the repository root. Source of truth: [Makefile](../../../../Makefile), [frontend scripts](../../../../frontend/package.json), [CI](../../../../.github/workflows/ci.yml), and [development guide](../../../../docs/10-development.md). Recheck these files when commands change.

Supported tools: Node 24.22.0/npm 11.19.1, Python 3.14.8, uv 0.13.1. Missing tools or dependencies are a reported prerequisite, not permission to install them.

## Choose checks by change

| Change | Existing checks | Prerequisites and effects |
| --- | --- | --- |
| Agent configuration or skills | Python `tomllib` for TOML; available skill validator and YAML parser for frontmatter/policy; inspect references and final diff | No application execution needed. Syntax validation does not prove native-agent loading or behavior. |
| Backend or Python scripts | `make backend-check` | Ruff lint/format check, strict mypy, pytest. Requires the locked backend development environment. Tests use synthetic fixtures and temporary databases. |
| Frontend | `make frontend-check` | ESLint, TypeScript, Vitest. Requires installed locked frontend dependencies. |
| Both application layers | `make check` | Combines both check targets; same prerequisites. |
| Backend packaging | `make backend-build` | uv builds source/wheel distributions; build isolation may resolve/download dependencies. |
| Frontend compilation/assets | `make frontend-build` | TypeScript and Vite; produces ignored build output. Requires installed frontend dependencies. |
| Both builds | `make build` | Combines both build targets. |
| Container or HTTP/persistence/security behavior | `make image`, then `python3 scripts/smoke.py` | Docker daemon/Compose, image builds and possible downloads; smoke starts isolated containers and cleans its generated project/volume. Requires authorization for those effects. |
| Browser login/logout acceptance | `make image`, then `make smoke` | Same container prerequisites plus installed frontend dependencies, Chromium, and required system libraries. Uses the isolated smoke harness, never a household deployment. |

For a narrow change, select individual commands already present in the wrappers, such as a relevant pytest file or a Vitest test file, before broader checks. Record the actual command and selected scope; a targeted pass is not a full-suite pass.

## Installation and network boundaries

- `make bootstrap` runs `uv sync --project backend --locked` and `npm --prefix frontend ci`. It installs dependencies; it is not a default verification step.
- Backend check wrappers use `uv run --locked`, which can synchronize the environment and download dependencies. Before using them, confirm those effects are authorized. Otherwise, use already-installed backend executables with equivalent arguments from the Makefile, or report the check blocked. Do not silently switch interpreters or omit required checks.
- `uv build` can create an isolated build environment and fetch build requirements. Do not assume a packaging check is offline.
- Frontend scripts use installed dependencies; do not use npx as a fallback that may download missing tools.
- Chromium installation is a separate authorized setup step: `cd frontend && npx playwright install chromium`. CI additionally installs system dependencies. Do not perform either implicitly.
- Do not start the normal development deployment or run secret-generation helpers for verification. The smoke harness owns synthetic credentials and its uniquely named Compose project/volume.

## CI and evidence

CI runs `make backend-check backend-build`, `make frontend-check frontend-build`, and `make image smoke` after explicit environment setup. These are discovered commands, not claims of successful execution.

Always run Git whitespace checks and inspect the relevant diff. For setup-only changes, validate configuration and skills without running unrelated application suites. Record runtime-profile loading as NOT RUN if a fresh session is required; do not launch nested Codex processes to imitate a native-agent smoke test.

For workflow changes, also verify explicit-only invocation policies and local reference targets, confirm `.workflow/` is ignored and excluded from the index, and use the [workflow validation scenarios](../../../../docs/12-agent-workflow.md) for independent behavioral evaluation when authorized. Distinguish static parsing, simulated/direct-read probes, and actual fresh-session native runs in the evidence report. Never infer runtime loading from a successful TOML parse.

Tests use fixtures rather than HA, Spotify, or a physical reader. Even Docker HTTP/browser success proves only the isolated test deployment, not external permissions, real playback, or household HTTPS operation.
