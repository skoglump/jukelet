---
name: workflow-retro
description: Review observed Jukelet workflow friction and propose improvements only when explicitly invoked as $workflow-retro or explicitly asked for a workflow retrospective. Does not rewrite instructions or implement recommendations.
---

# Retrospective from observed evidence

Use the current or explicitly specified session/run, its original scope, recorded decisions, checks, corrections and handoff evidence. Read available records and relevant instructions; do not infer outcomes from an intended plan or search unrelated private history. If evidence is missing, identify the limitation.

Compare intended behavior with what actually happened. Distinguish tooling/prerequisite failures, unclear requirements, implementation defects, verification gaps and instruction conflicts. Keep findings grounded in a concrete observation or evidence reference; distinguish a repeated pattern from a one-off event and a hypothesis from a demonstrated cause.

Return a short ranked list of actionable proposals. For each, identify the observed problem, smallest useful improvement, expected benefit/tradeoff, affected skill/profile/docs and a way to validate it. Prioritize changes that prevent demonstrated failures over additional process. Include practices worth retaining when the evidence supports them; omit speculative improvements unrelated to the run.

This is a proposal-only entry point: give the retrospective in conversation. It does not automatically rewrite instructions, create tracked documentation, modify the task's acceptance criteria, start another implementation loop, spawn agents or perform remote writes. A separate request to implement an improvement establishes its scope. Do not turn a single exception into a universal rule or suggest weakening checks to obtain PASS.

Adapted from `retro`; see [provenance and license](../dev-loop/references/upstream.md).
