---
name: workflow-handoff
description: Prepare resumable Jukelet work context only when explicitly invoked as $workflow-handoff or explicitly asked for a workflow handoff. Preserve decisions, source state and evidence without continuing implementation.
---

# Preserve a resumable handoff

Read the original request/approved plan and existing [run records](../dev-loop/references/run-records.md). Reuse their references and stable criterion IDs rather than drafting a replacement specification. If the run is unclear, inspect available records and current context before asking which task to hand off.

1. Compare repository path, branch, HEAD and staged/unstaged/untracked content with the recorded baseline and latest evidence. Preserve pre-existing/concurrent user work and flag ambiguous ownership. Use [evidence freshness rules](../project-verify/references/evidence.md) to mark affected checks and review conclusions stale; do not rerun implementation or claim stale evidence remains current.
2. Preserve the original scope, accepted decisions, assumptions, deferred questions, authorized effects, task ownership, current phase, correction rounds used, task commits, unresolved findings, check results and reviewer verdict. Record exact source state and evidence references, missing prerequisites, and one concrete next action with its responsible role.
3. The root updates the existing ignored `contract.md` only for established decisions and `progress.md` for current state. If no run exists, the root may create the compact records from the shared templates, distinguishing known history from unknown facts. Never invent a baseline or reset the repair allowance because context is missing.
4. Return a concise resume packet: record paths or inline context, original requirement references, state/remaining work, evidence limitations and next action. Tell the next session to verify source state before reusing results and to load the applicable workflow/profile instructions.

An explicit handoff request authorizes ignored local handoff records by default, not tracked documentation edits. Honor read-only/output-only instructions by providing the packet in conversation without writes. Workers report handoff information to the root rather than writing root-owned records. This entry point does not continue implementation, reset correction counts, invoke new agents, publish issues, commit, push or deploy.

Adapted from `handoff`; see [provenance and license](../dev-loop/references/upstream.md).
