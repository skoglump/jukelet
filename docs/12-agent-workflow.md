# Agent workflow

The optional workflow prepares scoped work, then runs the existing native implementation, verification and review loop. Ordinary coding requests do not automatically start orchestration. Skills provide methods; the four existing agent roles provide bounded work and independent assessment.

## Choose an entry point

| Entry point | Use it for |
|---|---|
| [`$dev-workflow`](../.agents/skills/dev-workflow/SKILL.md) | Select necessary understand, clarify, investigate, specify, execute and demonstrate phases. |
| [`$dev-loop`](../.agents/skills/dev-loop/SKILL.md) | Execute a ready task or approved plan with implementer, independent tester and fresh reviewer. |
| [`$grill-me`](../.agents/skills/grill-me/SKILL.md) | Resolve consequential design decisions in small rounds, then summarize; discussion alone does not start implementation. |
| [`$project-verify`](../.agents/skills/project-verify/SKILL.md) | Check current changes and acceptance evidence without editing application code/tests. |
| [`$workflow-handoff`](../.agents/skills/workflow-handoff/SKILL.md) | Preserve the current run, findings, evidence and next action for resumption. |
| [`$workflow-retro`](../.agents/skills/workflow-retro/SKILL.md) | Propose improvements from observed workflow friction without rewriting instructions. |

[`project-diagnose`](../.agents/skills/project-diagnose/SKILL.md) and [`project-tdd`](../.agents/skills/project-tdd/SKILL.md) are reusable supporting methods, available through normal skill discovery and the implementer profile. They do not introduce new roles or override edit/authorization boundaries. Domain preparation uses the [glossary](11-domain-glossary.md) and existing [decision register](08-decisions-and-risks.md).

```text
$grill-me
Help define the next tag-inventory slice. Keep this discussion-only and defer M3 publication decisions.
```

```text
$dev-workflow
Plan the next read-only inventory slice using the existing issue draft. Do not edit files or implement it.
```

```text
$dev-loop
Implement the approved plan above. Do not commit, push or deploy.
```

```text
$workflow-handoff
Prepare this run for a new session. Keep the current criteria and correction count.
```

```text
$workflow-retro
Review this run's verification failures and propose the smallest useful instruction improvements. Do not edit files.
```

Explicit workflow, grilling, handoff and retrospective entry points also accept explicit natural-language requests for that activity. An approved plan skips repeated preparation. Planning-only/read-only requests stop at their requested boundary; no output files are created when writes are prohibited. Proposed slices do not authorize implementation of the backlog or publication of issues.

## Execution and local state

The root owns scope, integration, run records and authorized Git operations. Only `loop_implementer` edits application code/tests. `loop_tester` verifies independently; one fresh `loop_reviewer` assesses requirements and engineering defects. `loop_explorer` is optional and non-editing. Workers do not spawn agents. The existing model inheritance and concurrency setting remain unchanged, with mostly sequential execution and at most three correction rounds.

Root-owned `.workflow/<run-id>/contract.md` and `progress.md` hold the original requirement references, stable acceptance-criterion IDs, baseline/ownership, authorization, phase, correction count and evidence. They are gitignored context, not a second product specification. The [record conventions](../.agents/skills/dev-loop/references/run-records.md) explain scoped baseline capture and resumption. Never store secrets or raw household payloads there.

Checks record exact commands, exit codes, results and assessed source state. Each criterion is demonstrated, partially covered or unverified, with evidence and limits. Review includes task commits plus staged, unstaged and untracked task content while excluding pre-existing/concurrent user work. Relevant edits invalidate affected checks and review. Passing suites alone cannot establish acceptance.

`PASS` requires complete criteria, relevant checks and resolved review. `PARTIAL` identifies incomplete verification/work; `BLOCKED` identifies a prerequisite preventing progress. Fixture success is not live integration evidence. Handoff preserves these distinctions and the repair count; retrospective is proposal-only.

## Configuration and behavioral validation

Follow [project-verify's commands reference](../.agents/skills/project-verify/references/commands.md): validate skills with the available skill-creator `scripts/quick_validate.py`, parse TOML with Python `tomllib`, parse policy YAML with an available YAML parser, inspect local references, and run Git whitespace checks for working, staged and complete task changes. Confirm `.workflow/` is ignored and absent from the index. Application suites/builds are unnecessary for a skill/docs-only change; adding scripts or changing application inputs may require additional checks.

Use isolated synthetic fixtures for the scenarios below. Give independent evaluators the request and raw artifacts, without the desired verdict. Observe actions and outputs; instruction inspection alone does not prove behavior. Keep evaluations within authorized temporary paths and existing role boundaries.

| Scenario | Observable acceptance |
|---|---|
| Approved plan | A ready authorized task reaches execution without another interview or changed criteria. |
| Ambiguous feature, planning only | At most three independent recommended-choice questions per round; later questions deferred; no implementation or prohibited writes. |
| Reproducible bug | Meaningful failing evidence precedes the correction where feasible; the regression passes afterward. |
| Passing tests, missing criterion | The missing behavior is reported despite green tests; no overall PASS. |
| Mixed Git state | Task commits, staged, unstaged and untracked changes are assessed; initial/concurrent user work is preserved and excluded, including shared-file hunks. |
| Interrupted resume | Phase and correction count survive; changed relevant content invalidates affected evidence/review. |
| Failure boundaries | Missing prerequisites, unavailable native agents and exhausted correction rounds produce accurate outcomes; no invented substitute agents or extra repair allowance. |
| Invocation and effects | Ordinary coding does not launch orchestration; standalone grilling/handoff/retro do not implement or perform remote writes; read-only overrides are respected. |

### Recorded validation, October 19, 2026

- Integrated static checks passed: all eight skills validated; five TOML files and five explicit-only policy YAMLs parsed; 92 local reference targets resolved; working, staged and complete-task whitespace checks passed. Run records were ignored and absent from the Git index. These checks establish configuration shape, not runtime behavior.
- One independent native `loop_explorer` performed a simulated first response to a discussion-only physical-tag-replacement request after directly reading `grill-me`. It asked one consequential question with a recommendation, preserved HA ownership and saved/active/playback distinctions, deferred M3, and made no file edits or external calls. This demonstrates that conversational probe only.
- A second independent native `loop_explorer` directly read the skills and returned decision sequences for eight synthetic scenarios covering the cases above, including unavailable-role and exhausted-budget variants. Root comparison found the expected scope, evidence, role and stopping boundaries in all eight. These were simulated decisions: no hypothetical parser tests, fixes or complete orchestration were executed.
- Independent static verification and source-driven inspection passed with no implementation defect found. The tester checked all eight skills, five TOML files, five policies, 92 local references, whitespace, Git scope/ignore behavior and the 29-path task manifest. Operational criteria remain only partially covered by simulated exercises. The final reviewer verdict belongs in the root-owned run report and was pending at this documentation checkpoint.
- Fresh-session skill discovery, revised-profile loading and a full revised native workflow run: **NOT RUN**. Direct file reads and current-session agents do not prove reloading. Start a fresh trusted-project Codex session to validate loading; if required native roles are unavailable, report the limitation rather than launching a nested Codex process.

The selected methods are project-local adaptations pinned to an upstream revision. See [provenance and differences](../.agents/skills/dev-loop/references/upstream.md) and the accompanying MIT notice. No upstream plugin or automatic updater is installed.
