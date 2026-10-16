---
name: project-verify
description: Verify Jukelet changes against repository requirements using targeted lint, types, tests, and builds, with exact evidence and no edits to tracked application files. Use when verification is requested or delegated by dev-loop.
---

# Project verification

Read applicable `AGENTS.md`, the original acceptance criteria, Git status/diff, and the affected code. Use the root's baseline when supplied; distinguish pre-existing changes and failures from regressions.

Read [commands and prerequisites](references/commands.md) before choosing checks. Confirm commands against the current Makefile, package scripts, and CI rather than assuming the reference cannot drift.

1. Select the smallest relevant compile, unit, integration, lint, static-analysis, and acceptance checks; broaden only for affected boundaries or unresolved concerns. Prefer existing wrappers and CI commands.
2. Check prerequisites and authorization before execution. Do not install dependencies (including implicit uv synchronization or npx downloads), start external services, contact production endpoints, use credentials, or change shared databases without authorization. Existing authorization remains valid; do not ask again unnecessarily.
3. Run `git diff --check` and `git diff --cached --check`. If the task includes commits, also check its complete diff against the recorded base. Inspect untracked task files separately because Git diff omits them.
4. Run the selected safe checks. Do not modify tracked application files or tests, rewrite formatting, regenerate snapshots, weaken assertions, or repair failures. Compilation and tests may generate ignored artifacts and isolated synthetic test databases. Report needed fixes to the root.
5. Inspect coverage of requirements and relevant error paths, malformed upstream data, and concurrent edits. Report reproducible gaps even when existing tests pass.
6. Recheck Git status/diff for unexpected tracked changes caused by commands; report them without discarding user work.

Return a concise handoff: each command, exit code, PASS / FAIL / BLOCKED / NOT RUN, reproducible findings, criteria covered, uncovered cases, and limitations. Missing prerequisites are BLOCKED or NOT RUN, never PASS. Automated evidence outweighs self-assessment.

Fixture tests do not prove live HA permissions, provider availability, physical-reader behavior, playback, or a successful household deployment. Never represent mock data as live success. Do not access HA/Spotify, simulate scans, or exercise playback without the separate explicit scope required by repository instructions.
