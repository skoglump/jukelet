---
name: dev-workflow
description: Prepare and execute scoped Jukelet work through selected clarification, investigation, specification and native dev-loop phases. Use only when explicitly invoked as $dev-workflow or explicitly requested as an orchestrated development workflow.
---

# Development workflow

The root selects phases and owns decisions. Use the existing native roles through [dev-loop](../dev-loop/SKILL.md); do not create an agent per phase or delegate orchestration. Ordinary coding requests do not activate this workflow.

## Select the next useful phase

Start with the original request, applicable `AGENTS.md`, current source and any approved plan. Preserve approved scope and criteria; do not interview again merely because this entry point was used. A clear task can enter execution directly after baseline/contract capture.

| Phase | Use when | Output / next step |
|---|---|---|
| Understand | Establishing the task or resuming it | Current behavior, intended result, constraints and existing authority. |
| Clarify | A consequential decision prevents implementation | Read the [interview method](../grill-me/references/interview.md); use [domain clarification](../grill-me/references/domain.md) only when terms or ownership matter. Summarize decisions and deferred questions. |
| Investigate | A factual uncertainty or unexplained failure blocks a sound approach | Gather bounded read-only evidence or a synthetic reproduction. The root may use one existing non-editing `loop_explorer` for a specific question; it must not spawn workers. |
| Specify | The scoped implementation contract is incomplete | Read [specification and slicing](references/specification.md); produce observable criteria, non-goals, dependencies and verification approach. |
| Execute | The task is ready and implementation is authorized | Follow native `dev-loop` with the same run/contract, approved plan, baseline and evidence; retain its single writer, tester, fresh reviewer and repair limit. |
| Demonstrate | Work or planning reaches its requested boundary | Report the actual result against criteria, supporting evidence, unresolved work and limitations. Distinguish synthetic demonstrations from live verification. |

Read only references needed for the selected phase. Using the shared interview method does not invoke the standalone `grill-me` entry point. Do not invent required tools or substitute a nested Codex process for native agents. If a required native role cannot run, follow dev-loop's blocked outcome.

## State and stopping boundaries

For authorized execution, establish or reuse [local run records](../dev-loop/references/run-records.md) before delegation. The root maintains them at transitions and corrections. Preserve the starting baseline and repair count across preparation, execution and handoff. Workers receive the original requirements and common contract; only the implementer edits application code/tests.

For planning-only or read-only requests, stop before implementation and report the plan/evidence in conversation. Do not create records or other files when writes are prohibited; planning alone does not require persistence. Creating or updating tracked specs and decisions requires the task's authorization. Resumption must compare recorded source state before reusing evidence.

Select only the assigned issue or explicitly approved scope. Proposed slices are options for later work, not permission to execute the backlog. Within an explicitly approved multi-part scope, sequence bounded slices and preserve per-slice criteria plus an overall completion check. No parallel writers or new permanent roles.

Keep existing authorization for local Git actions, but never infer permission to commit, publish issues, push, merge, deploy or access live household systems from this workflow. The root owns authorized Git actions. Do not add a final approval ceremony when the user has already authorized the next step.

Return the dev-loop outcome for implementation (`PASS`, `PARTIAL`, or `BLOCKED`), with criterion evidence and reviewer verdict. For planning-only work report planning readiness and remaining decisions; do not label the proposed implementation as verified.

Adaptation details: [upstream provenance](../dev-loop/references/upstream.md).
