---
name: project-tdd
description: Implement Jukelet behavior incrementally through meaningful regression tests at existing observable interfaces. Use during feature or bug-fix implementation where behavior changes; not for prose-only edits or as a replacement for independent verification.
---

# Incremental behavioral tests

Start from the approved criteria, current tests and the smallest useful observable interface. Prefer established public seams over new test-only abstractions. Use the highest appropriate existing boundary that exposes the behavior with reliable, focused feedback; do not force every case through a browser.

For one behavior at a time:

1. Add a meaningful test using synthetic inputs and an independently reasoned expected result. Cover the promised behavior rather than private call order or a restatement of implementation logic. Include relevant malformed data, failure and concurrency cases as the change warrants.
2. Run it before the fix where feasible. Confirm it fails for the intended missing or incorrect behavior, not import/setup errors. Record the command and actual failure. If a red run cannot be obtained, explain why and avoid claiming red/green evidence.
3. Implement the smallest complete change that passes that behavior. Run the focused tests, then add the next criterion. Do not write a large speculative test batch before receiving implementation feedback.
4. Refactor safely within scope while the tests remain green. Reuse conventions, keep interfaces cohesive and avoid opportunistic redesign. Run affected checks after the final edit and hand independent verification to [project-verify](../project-verify/SKILL.md).

Routine test placement, fixtures and safe local refactoring do not need repeated owner approval. Do not weaken criteria or assertions to pass. Avoid tests for wording-only documentation edits, reversible low-impact changes without observable behavior, or tests that merely mirror implementation. Follow repository regression requirements for behavior changes.

Within dev-loop only the implementer edits tests/application code; other roles may use this guidance to assess coverage without writing fixes. Report criterion coverage, exact commands/results, source state and limitations. Passing a regression does not establish full acceptance or live integration success.

Adapted from `tdd`; see [provenance and license](../dev-loop/references/upstream.md).
