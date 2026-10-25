# Publication review focus synchronization (#40)

Investigation on October 25, 2026 used `main` at
`1680dbf7ffa69d7ecee1156a63cdf5ba114137cc`, including #36/#41 diagnostics,
#37/#42 guarded controls and #38/#43 integration distribution. This is a focused
test correction under [#40](https://github.com/skoglump/jukelet/issues/40), not
completion of the broader release-readiness issue #32. All responses were
synthetic. No household system, running deployment or live credential was used.

## Diagnosis and limits

The original assertion remained at `frontend/src/Publication.test.tsx:32`:

```tsx
expect(await screen.findByRole('heading', { name: /^Review snapshot$/ })).toHaveFocus();
```

`findByRole` waits for the heading to exist. `Publication` transfers focus in a
passive `useEffect` after the review is rendered. These are separate observable
states. The first attempt of CI run
[40110446852](https://github.com/skoglump/jukelet/actions/runs/40110446852/attempts/1)
failed with the heading present and `BODY` focused. A later passing attempt did
not establish a fix.

Ten separate-process runs of the original four tests passed locally. A temporary
diagnostic then ran the original review/confirmation case 30 times in one
process, with a DOM `MutationObserver` and a spy that recorded and immediately
delegated to the native `HTMLElement.focus`. Every trace showed this order:

```text
mutation:heading-present:focused=false
focus:H3:Review snapshot
find-resolved:focused=true
```

This establishes an actual unfocused-heading interval before the existing focus
effect, without delaying or replacing focus. On these diagnostic runs the
original query happened to finish after focus. The exact failing CI scheduling
was not reproduced locally. The trace discriminates the presence-versus-focus
synchronization gap from a component that never focuses, or another target
stealing focus in this transition. It supports correcting the assertion's wait
condition; it does not claim every possible component focus race is excluded.

The test setup already cleans up rendered components after each test. The
component aborts its status request and clears its polling timer on unmount.
There was no observed leaked instance or competing feedback focus in the
diagnosed transition, so cleanup, polling and component behavior are unchanged.
An added successful-refresh case checks that a new status response preserves a
keyboard user's position in the review while fencing confirmation of older
content.

## Correction and regression coverage

The assertion now waits for the exact intended heading to have focus, using the
existing `waitFor` default deadline. It still fails if focus never reaches that
heading. There are no added sleeps, larger timeouts, retries or alternate
acceptable targets.

The eight component tests retain the empty-snapshot and content-token checks,
queued-versus-active wording, stale/recovery fences and migration attestation.
They additionally exercise deferred review responses, cancellation and focus
return, fresh confirmations after reopening, focused review-preparation errors,
focused confirmation errors, status refresh before retry, and a changed saved
revision fencing the older review. Migration review also asserts its exact
heading focus; queued confirmation feedback asserts its own focus.

A temporary negative control removed only the review-heading focus effect. The
corrected empty-confirmation test failed at its exact-heading focus assertion
(exit 1). Restoring the component byte-for-byte returned all eight tests to
passing (exit 0). This is evidence that the corrected assertion still detects
missing keyboard focus; it is not a product red/green change. No component or
browser behavior was changed.

## Reproduction and evidence

Tools: Node `24.22.0`, npm `11.19.1`, Vitest `5.0.5`, React/React DOM `19.3.1`,
jsdom `27.4.0`. Existing installed dependencies were used. The local tool prefix
for these commands was:

```sh
export PATH=/tmp/jukelet-issue36-npm/bin:/tmp/node-v24.22.0-linux-x64/bin:$PATH
```

| Command / setup | Actual result |
|---|---|
| `npm --prefix frontend test -- src/Publication.test.tsx`, original source, 10 independent processes | All passed; no local original-assertion failure |
| Same file with temporary 30-case tracing, `npm --prefix frontend test -- src/Publication.test.tsx --reporter=verbose --disableConsoleIntercept` | 33 tests passed; all 30 review traces showed the unfocused DOM interval then native heading focus |
| `npm --prefix frontend test -- src/Publication.test.tsx -t 'requires content-bound empty confirmation'`, heading-focus negative control | Exit 1, exact-heading focus failure; 7 tests skipped |
| `npm --prefix frontend test -- src/Publication.test.tsx`, restored component and final tests | Exit 0, 8 tests passed |
| `npm --prefix frontend run lint` | Exit 0 |
| `npm --prefix frontend run typecheck` | Exit 0 |

Initial CI output, local baseline logs, the temporary diagnostic source and
ordered traces, negative-control patch/failure and final targeted output are
retained locally under
`.workflow/2026-10-25-issue40-focus/evidence/`. These ignored artifacts are working
evidence, not published fixtures. The unchanged component SHA-256 is
`fe9b59051ec5d17247d38676163fef3008e196d2563b571a4c1f22278102d375`;
`implementation-source-digests.txt` records the component, tests and relevant
configuration. Independent repeated/full frontend and fixture-browser results
belong in the task's PR verification report. These component checks make no
claim about live HA, playback or household deployment.
