---
name: project-diagnose
description: Diagnose a Jukelet bug with bounded reproduction, competing explanations and regression evidence. Use for unexplained failures or a bug-fix task before choosing a correction; does not authorize live household access.
---

# Diagnose a bounded failure

Read the task contract and relevant implementation. Establish the expected observable behavior, actual symptom, triggering inputs and environment, and evidence already available. Separate observations from hypotheses; inspect code even when reproduction is unavailable.

1. Reproduce at the smallest useful existing interface using synthetic fixtures and isolated state. Record the exact command, inputs, result and source state. Distinguish a product failure from missing prerequisites or a broken test harness. Avoid copying private payloads into fixtures.
2. Reduce the failing case without removing the condition that causes it. Where the cause is uncertain, compare plausible falsifiable explanations and choose the next observation that discriminates between them. Change one relevant variable at a time; avoid speculative batches of fixes.
3. Explain the causal path before changing behavior. If reproduction is unavailable, state what prevents it, what code/evidence supports the diagnosis and what remains uncertain. Continue useful authorized inspection; do not invent a reproduction or infer permission for live access.
4. Within an authorized fix, have the implementer add a regression at an appropriate observable boundary, demonstrate the failure where feasible, make the smallest complete correction, and verify the original case plus relevant neighboring failure paths. Use [project-tdd](../project-tdd/SKILL.md) for incremental implementation.
5. Remove task-owned temporary diagnostics from the delivered change; preserve useful regression coverage and existing user files. Report the symptom, cause or confidence limit, before/after evidence, changes and remaining risks.

In the loop, only the implementer writes code or tests. A root/explorer/tester/reviewer using this method remains non-editing for application code/tests and hands findings to the implementer. A diagnosis-only request stops at findings. No HA/Spotify access, scan simulation or playback is implied; repository authorization and safety boundaries still apply.

Adapted from `diagnosing-bugs`; see [provenance and license](../dev-loop/references/upstream.md).
