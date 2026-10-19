# Local run records

The root maintains `.workflow/<run-id>/contract.md` and `progress.md`. Choose a unique descriptive run ID, for example `2026-10-19-tag-filter`; do not overwrite another run. These files are gitignored working context, not a second source of product requirements. Keep accepted lasting decisions in the project's decision register when the task authorizes that documentation change.

## Start and hand off

Use [contract-template.md](contract-template.md) to capture the original request or approved plan and stable acceptance-criterion IDs. Reference existing issues and specs; include enough original requirements in each agent handoff for the role to work independently. Preserve user-approved criteria rather than rewriting them to fit the implementation.

Record the repository path, starting commit (`git rev-parse HEAD`), branch and initial status (`git status --short --branch`). Describe pre-existing staged, unstaged and untracked changes and their ownership. Preserve them and exclude them from this task's changes. Record authorized Git actions separately from implementation permission.

Retain sanitized, scoped initial diff/content references for relevant pre-existing staged, unstaged and untracked files, sufficient to distinguish their hunks if the task later edits the same files. Status and path descriptions alone cannot reconstruct this baseline. Capture only task-relevant context, never secrets or a whole-repository snapshot. If a safe content reference cannot be retained, record the limitation and resolve ownership before editing overlapping content.

## Progress

Maintain this compact Markdown structure in `progress.md`:

```markdown
# Run progress
- Phase: understand / clarify / investigate / specify / implement / verify / review / finish
- Status: in progress / PASS / PARTIAL / BLOCKED
- Correction rounds used: 0 of 3
- Current source state: commit, branch, and task working-tree changes
- Task commits and owned paths:
- Last completed action:
- Next action and owner:

## Evidence
| ID | AC IDs | Command or observation | Exit code/result | Source state | Artifact/reference | Validity |
|---|---|---|---|---|---|---|

## Findings and decisions
- Unresolved findings, responsible role, and affected criteria:
- Reviewer verdict and reviewed source state:
- New decisions, assumptions, deferred questions, and source of authorization:
- Checks not run and reason:
```

Update after each phase transition and correction round, retaining earlier evidence with its validity rather than silently replacing failures. Use `N/A` for exit codes of observations. Record exact commands, actual outcomes, and concise sanitized evidence. Never include credentials, raw private HA/Spotify payloads, or a full household configuration.

## Resume and evidence validity

Read the contract and progress before restarting work. Confirm the repository, branch, HEAD and staged/unstaged/untracked state against the record. Reconstruct the task's complete changes from the starting commit, task commits and working tree; distinguish concurrent and pre-existing user work. Do not reset or discard unfamiliar changes. Resolve ownership before touching overlapping work.

Tie evidence to the tested/reviewed state, including relevant uncommitted and untracked content. A commit hash alone is insufficient for a dirty tree: use a scoped diff or content digest/reference for the relevant files. Review and verification may remain valid after a commit-only change if the relevant content is unchanged.

If relevant source, configuration, requirements or test inputs changed, mark affected evidence and reviewer conclusions stale and rerun affected verification and fresh review. If applicability cannot be established, treat evidence as stale. Preserve the correction count on resume; a handoff is not a new allowance of three rounds. Record limitations and the next concrete action when work stops.

For an explicitly requested handoff, use [workflow-handoff](../../workflow-handoff/SKILL.md) to package these same records; do not create a parallel contract. A retrospective, when explicitly requested, uses [workflow-retro](../../workflow-retro/SKILL.md) to propose improvements from actual evidence without modifying the instructions automatically.
