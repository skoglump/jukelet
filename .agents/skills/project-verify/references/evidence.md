# Criterion evidence and complete task state

Use the original contract and stable AC IDs. When no IDs exist, assign local IDs without changing requirements. The root integrates evidence into its run record; verification roles report it without editing that record.

## Establish the assessed changes

Read the starting commit, initial status, task commits and ownership notes. Inspect HEAD, staged changes, unstaged changes and untracked files (`git status --short --branch`, `git diff --cached`, `git diff`, `git ls-files --others --exclude-standard`). Inspect task commits against the recorded baseline too. A clean working tree does not mean the task has no changes; a base-to-HEAD diff omits the working tree.

Account for pre-existing and concurrent user changes, including edits sharing a task-owned file. Use recorded initial content/diffs and ownership to isolate relevant hunks; do not attribute every difference from the starting commit to this task. Report unclear ownership to the root before assessing that area. Never discard changes to simplify review.

Record the assessed source state: HEAD, owned paths and relevant dirty/untracked content via a scoped diff or content digest/reference. Run working/staged whitespace checks and check the task's committed diff; inspect untracked task content separately. Do not use only `base...HEAD` as a complete review.

## Report checks and coverage separately

For each check, report the exact command, exit code and `PASS` / `FAIL` / `BLOCKED` / `NOT RUN`, evidence reference, assessed source state and limitations. Use `N/A` for exit codes of observations or unexecuted commands. Missing dependencies and stale evidence are not passes.

For every criterion, report:

| Criterion | Coverage | Evidence | Source state | Limits / missing demonstration |
|---|---|---|---|---|
| AC-1 | demonstrated / partially covered / unverified | Check IDs or precise observation with result | Assessed state | Remaining gap or none |

- **Demonstrated:** current evidence establishes the full criterion within its scope.
- **Partially covered:** some, but not all, required behavior is established.
- **Unverified:** no applicable current evidence establishes the criterion, including when it fails. State known failures explicitly rather than disguising them as missing evidence.

Static inspection can support structural requirements; identify it as inspection, not runtime proof. Passing a suite establishes only exercised behavior. Missing implementation remains a gap even if checks pass. Never weaken criteria or mark completion solely on an agent's assertion.

## Freshness and review

Compare final content to each check/review's source state. Relevant edits to source, configuration, requirements or test inputs invalidate affected evidence and review conclusions; record which criteria/checks became stale and why. Rerun affected checks and obtain fresh independent review on the stable result. Unchanged relevant content can retain evidence across a commit-only transition.

One fresh reviewer assesses requirements coverage separately from engineering defects (correctness, compatibility, security, concurrency, regression risk and maintainability). Prioritize objective failures. Provide actionable file/line references and concrete failure scenarios; separate optional style suggestions, which alone do not require repairs. Return one `APPROVED` or `CHANGES_REQUESTED` verdict with coverage gaps and remaining limits. No nested review agents.

The root's overall `PASS` requires all criteria met, relevant checks passed and review resolved. Use `PARTIAL` for incomplete verification/unresolved work and `BLOCKED` when a prerequisite prevents progress. Approval and passing commands cannot substitute for criterion evidence.
