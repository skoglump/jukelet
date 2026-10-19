---
name: dev-loop
description: Coordinate a bounded development task through native Codex implementer, tester, and reviewer subagents when explicitly invoked as $dev-loop, explicitly requested as an orchestrated development loop, or reached from an explicitly invoked dev-workflow. Do not use for ordinary coding requests.
---

# Development loop

The root session is the orchestrator: own scope, integration, repair decisions, and the final report. Use the project's native `loop_*` profiles, not a spawned orchestrator, external framework, or nested `codex` process.

## Planning integration

- If an approved plan for the current task exists in the current conversation, use it as the implementation contract.
- Preserve its scope, decisions, and acceptance criteria.
- Do not repeat planning unless implementation reveals a material inconsistency or missing requirement.
- If no approved plan exists, perform lightweight planning before delegating work.
- Escalate significant scope or architectural changes to the user instead of silently modifying the approved plan.

Include the approved plan, when present, in implementer, tester, and reviewer handoffs, including correction rounds.

## Task record

Before delegating, read [run-record conventions](references/run-records.md) and establish the root-owned contract and progress record under `.workflow/<run-id>/`. Use the [contract template](references/contract-template.md), referencing an approved plan instead of creating a competing specification. Reuse an existing run when this task is continuing. Update progress after phase transitions and correction rounds; verify repository state and invalidate affected evidence before resuming. Keep records local and free of secrets.

Give each role the same contract, relevant progress/evidence, and original requirements. The root owns record updates; workers report evidence and findings for the root to integrate.

Use [criterion evidence and complete task state](../project-verify/references/evidence.md) for tester/reviewer handoffs and the final report. Include task commits, staged, unstaged and untracked changes while excluding pre-existing/concurrent user work. Provide content-specific source-state references and ownership notes rather than a HEAD-only diff. Report each stable criterion ID as demonstrated, partially covered or unverified; passing commands alone do not establish acceptance. Invalidate affected evidence/review after relevant edits and repeat affected checks plus fresh review.

Ask one fresh reviewer to separate requirements coverage from engineering defects and prioritize objective failures. Require a single verdict with file/line findings and failure scenarios; style preferences alone do not require repair. No nested review agents.

## Scope and baseline

1. Read applicable `AGENTS.md`, the original request or assigned issue, and affected code. Use the approved plan or lightweight planning to establish acceptance criteria, constraints, risk boundaries, file ownership, and expected checks without redefining approved decisions or criteria. Ask only about material behavior decisions or missing authorization.
2. Record Git status and the starting commit before edits. Preserve existing changes and track which diff belongs to this task, including later commits. Run relevant safe baseline checks when practical, or assign baseline inspection to `loop_tester`; distinguish existing failures from regressions.
3. Use `loop_explorer` only when a separate bounded investigation adds value. Give it concrete questions and require file references; it must not edit.

## Implement, verify, and review

4. Spawn native `loop_implementer` with the original requirements, acceptance criteria, bounded ownership, repository instructions, and expected handoff. Wait for completion. Only this role edits application code or tests; the root integrates results and makes decisions. Never assign overlapping edits concurrently.
5. Once the working tree is stable, spawn `loop_tester` with the original criteria, current code, and baseline information. Do not frame the implementation as already correct. Have it use [project-verify](../project-verify/SKILL.md), collect exact commands and exit codes/results, inspect uncovered cases, and report reproducible failures without fixing files.
6. Spawn a fresh `loop_reviewer` after implementation, preferably after verification. Provide original requirements, the task's complete diff relative to its baseline, and actual test evidence. Require `APPROVED` or `CHANGES_REQUESTED` with actionable file/line findings and remaining risks. A fresh review must not merely endorse the implementer's account.

Use the installed client's actual native spawn, message, and wait mechanisms; do not invent tool names or profile-selection parameters. Assign independent contexts with sufficient requirements and repository context. Keep the first version mostly sequential, avoid polling and redundant agents, and respect the configured concurrency limit. Workers must not spawn further agents.

If native subagent tools or required profiles cannot be used, stop and report `BLOCKED: native subagents unavailable` with the observed limitation and any fresh-session requirement. Never imitate agents or silently fall back to single-agent execution. Use an alternative only if the user explicitly requests it.

## Repair and finish

7. Evaluate objective checks before review opinions. For actionable failures, send one focused correction assignment to the implementer (or a new native implementer if required), then repeat affected verification and fresh independent review on the stable result. Allow at most **3 correction rounds** after the initial implementation. Stop earlier when blocked, repeating a failure without progress, or a proposed fix exceeds authorized scope.
8. Report `PASS`, `PARTIAL`, or `BLOCKED`, with changed files, exact checks and actual results, checks not run, reviewer verdict, remaining risks, and what the human should inspect. PASS requires acceptance criteria met, relevant checks passed, and review resolved; LLM approval alone is insufficient. Use PARTIAL for incomplete verification or unresolved work, and BLOCKED when a prerequisite prevents progress. Never claim an agent ran unless it actually did.

All agents inherit parent permissions. Non-editing roles are constrained by instructions, not separate read-only sandboxes. Preserve repository safety boundaries and existing authorization; do not weaken/delete tests or change success criteria to pass. Do not run destructive or production-affecting checks, make deployment changes, or commit/push/merge without explicit authorization. Authorized Git publication remains the root's responsibility.
