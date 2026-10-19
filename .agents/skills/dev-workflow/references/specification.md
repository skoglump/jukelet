# Compact specification and optional slices

Synthesize established decisions; do not restart an interview when the contract is already ready. Reference the approved plan or existing issue as the source of truth. Use the [task contract](../../dev-loop/references/contract-template.md) for local execution context rather than maintaining duplicate requirements.

Match the existing [issue-draft structure](../../../../issues/004-tag-inventory-import-preview.md) and [backlog conventions](../../../../issues/README.md). Draft locally in the authorized run record, or in conversation when no file output is requested/permitted. Update an existing tracked issue draft only within the task's write scope.

```markdown
# <Draft key or local slice ID> — <User-visible outcome>

**Suggested milestone:** <existing milestone, if applicable>
**Dependencies:** <actual blocking issues or local slice IDs, or none>

## Goal
Current problem and intended observable result.

## Scope
Behavior and consequential interface/data-flow decisions already settled.

## Acceptance criteria
- [ ] AC-1: Observable criterion.

## Verification
Existing public interfaces/test seams; relevant success, failure and concurrency cases; evidence needed for each criterion.

## Out of scope
Explicit exclusions and deferred decisions with revisit conditions.

## Implementation references
Original plan, authoritative domain decisions and relevant existing implementation.

## Completion report
Actual changes, criterion evidence, commands/results and limitations; leave unverified criteria unchecked.
```

Keep small tasks small; omit inapplicable metadata. Prefer existing observable interfaces and established tests, without requiring user approval of routine test placement. Resolve only consequential missing requirements before execution. Preserve stable criterion IDs when a contract already exists.

For work that needs decomposition, propose independently demonstrable or verifiable vertical slices, each with its real blocking dependencies and acceptance evidence. Do not force unrelated layers into a slice or split a mechanical refactor into pieces that cannot be verified safely. Keep dependency labels local until publication; JBM planning keys are not GitHub issue numbers. Do not allocate a new permanent JBM key unless editing the backlog is authorized.

Reuse an approved breakdown without another approval round. When a proposed breakdown materially changes scope, get the owner's decision before executing it. A request to plan or draft slices does not authorize implementing all slices or publishing tracker objects. Remote publication remains a separate explicitly authorized action using the repository host's CLI and existing backlog conventions.
