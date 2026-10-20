# M1 read-only verification — issue #15

## Boundary and environment

Verification date: 2026-10-20. Source baseline: `3a33ecdbe620ac30ea97aa402b87493637a5a98a`, plus the issue #15 regression tests and this report. This change adds acceptance evidence; it does not add assignment saving or change application behavior.

Authorization covers synthetic tests, isolated containers and browser checks only. **Live HA/Spotify verification is pending and was not performed.** Issue #15 allows this explicitly pending result; the broader [M1 exit criterion](05-milestones.md#m1--read-only-manager) requiring owner-authorized live reconciliation remains open. No automation/tag mutation, receiver power, volume, account activation, playback, scan simulation or deployment was performed.

Environment: Arch Linux x86-64, Python 3.14.8, Node 24.22.0, npm 11.19.1, uv 0.13.1, Docker 29.9.1, Playwright 1.64.1 and Chromium 156.0.8078.4 (revision 1248). Playwright used its Ubuntu 24.04 fallback build on Arch Linux; this is not cross-platform verification. Node and uv were extracted from the already installed pinned container images into `/tmp/jukelet-15-tools`; the host defaults were not used. Commands below used `PATH=/tmp/jukelet-15-tools/bin:$PATH`, `UV_CACHE_DIR=/tmp/jukelet-15-uv-cache`, and browser checks used `PLAYWRIGHT_BROWSERS_PATH=/tmp/jukelet-15-browsers`. These temporary paths are local setup, not new project requirements. Dependency/browser downloads are distinct from household access.

## Executed checks

All checks below use synthetic inputs, local fake HTTP/WebSocket servers or isolated synthetic app sessions. No household credentials are required. Existing [development commands](10-development.md#reproducible-development-checks) remain the reproduction path.

| Command / expected result | Actual result | Evidence / limits |
|---|---|---|
| `npm --prefix frontend test -- InventoryPreview.test.tsx` before edits: existing component behavior passes | PASS, exit 0; 7 tests | Baseline component suite |
| `make check`: lint, formatting, types and unit/integration tests pass | PASS, exit 0; 126 backend and 35 frontend tests | Ruff, mypy, ESLint, TypeScript, pytest and Vitest; existing Starlette/httpx deprecation warning |
| `make build`: Python distribution and production frontend compile | PASS, exit 0 | Wheel/source distribution and Vite assets |
| `make image`: single application image builds | PASS, exit 0 | Local `jukelet:local`; Docker used the classic builder because buildx was absent |
| `npm --prefix frontend run test:fixture`: actual manager works in Chromium | PASS, exit 0; 6 browser tests | Synthetic desktop/mobile screenshots under ignored `frontend/test-results/`; no live backend |
| `make smoke`: isolated container HTTP/security/persistence and browser checks pass | PASS, exit 0; HTTP assertions and 1 Chromium test | Session survives container replacement; CSRF, non-root UID, secret isolation, bad-config rejection, login/logout and uploaded preview/manual fallback; harness cleaned its project/volume |
| `git diff --check` and `git diff --cached --check` | PASS, exit 0 | Whitespace checks; user-owned `.gitignore` excluded from task changes |

Local raw command logs are in `/tmp/jukelet-15-{check,build,image,fixture,smoke}.log`; they are ephemeral, not committed artifacts. This table and the named tests are the durable redacted evidence. Independent verification/review and Git publication are recorded separately in the PR.

The added component test first failed because its assertion incorrectly equated every `role="status"` with loading; the existing UI also uses that role for lookup availability. The assertion now targets the loading message. No product bug or red/green application fix is claimed. An initial `make check` was blocked by the read-only default uv cache; using a writable temporary cache resolved setup. The initial browser attempt could not launch because the required Chromium revision was missing; it was installed separately into the temporary browser directory.

## Criterion evidence

| Criterion | Evidence and interpretation |
|---|---|
| Reconnect and last-good state | `backend/tests/test_ha_adapter.py::test_reconnect_restores_subscription_inventory_and_preserves_ids` uses a real local WebSocket server: disconnect, reauthenticate, resubscribe, refresh changed inventory, retain exact opaque ID and mark a discovery gap. `test_queue_overflow_refreshes_and_malformed_inventory_keeps_last_good` and `test_empty_inventory_id_preserves_last_good_snapshot` cover failed refresh preservation. No historical scan replay is claimed. |
| Metadata failures preserve mapping preview | `frontend/src/InventoryPreview.test.tsx` tests explicit lookup, HTTP 503/upstream authentication and network failures, exact source URI, previous title/artwork and stale state after reopening detail. The added deferred-response test proves pending refresh retains the source report and last-good metadata while showing loading, then transitions to unavailable/stale. |
| Mobile and keyboard manager | `frontend/e2e/manager.spec.ts` exercises actual React UI in Chromium, 390px viewport, keyboard entry/lookup/back focus, filters, search/library paging, exact IDs and artwork alternatives. The added scenario retains metadata/report during a pending request and failed metadata/source refresh, then reopens stale detail. Focus assertions cover the tested workflow, not a full accessibility audit. |
| Separate loading/error/stale states | Component deferred requests distinguish loading from failed lookup; existing browser scenarios distinguish empty, unsupported, stale inventory, failed inventory, upstream rejection and expired app sessions. Source, inventory and music states remain independent. |
| Auth and isolation | Backend session/origin/CSRF tests and the separate Docker smoke cover the real authentication boundary. Fixture login is simulated and cannot establish production authentication. `scripts/smoke.py` clears HA/provider settings; Vite fixture mode disables backend proxies and terminates unknown API requests locally. |
| Live read and physical scans | PENDING. Subscription acknowledgment means HA accepted a subscription; it does not prove a physical reader emitted an event, native tag registration occurred or music played. Synthetic events are fixture evidence only. |

Fixtures originate in repository test builders and `frontend/fixtures/manager.ts`, not a captured household payload. The frontend fixture uses normalized M1 DTOs and preview report `schema_version: 1`; backend fixtures exercise the supported adapter envelopes, including malformed ones. Its normal source report has 3 rows (2 accepted, 1 rejected), 2 matched IDs, 1 unassigned registry ID and 1 orphan. Those are synthetic expectations only. Its six music capabilities are independently represented, with playlist search unsupported in the normal scenario. Neither these counts nor these capabilities describe a live installation.

## Separately authorized live-read path — pending

This is a future checklist, not authorization or an executable live-test script. Before any connection, obtain explicit approval naming the target installation privately, time window, allowed reads, configured source and SpotifyPlus account, bounded metadata examples, evidence destination and stop conditions. Keep credentials server-side in the existing configured interface; never inspect HA credential stores or copy Spotify tokens. Do not print full configuration, tokens, account/entity/tag IDs or raw private metadata into public logs/reports.

1. Record application commit/image, HA and installed SpotifyPlus versions and the approved scope. Use the existing read-only app configuration. No new deployment or household configuration change is implied by this document; obtain approval for any setup action separately.
2. Read connection/capability status and current inventory through the app. Record the observation time, freshness, registry total, pending-discovery count and bounded error categories. Compare exact IDs privately without trimming or normalization. Record subscription acknowledgment separately from physical-reader verification, which remains **not performed**.
3. Preview the approved configured legacy source. If its version-sensitive read is forbidden or unavailable, stop that path and record the failure. An owner-supplied, separately approved export may be uploaded for preview; do not change transport or broaden permissions to bypass denial. Retain raw exports only in the approved private location.
4. Reconcile that actual preview against the current inventory: source fingerprint privately, row counts, accepted/rejected rows, matched/unassigned/orphaned distinct IDs, registry freshness and unsupported-row categories. Document count semantics from the development guide. Never compare to historical household counts as fixed acceptance thresholds or save/confirm the preview as assignments.
5. Record all six discovered provider capabilities independently. For the explicitly approved album/playlist examples, request bounded metadata through HA's allowlisted SpotifyPlus interface; perform search/library requests only if included in scope. Record normalized success/failure and last-success/attempt times, without publishing titles/artwork/private library contents. Service availability alone does not establish lookup success; lookup success does not establish playability.
6. Do not interrupt HA, change credentials, restart household services or force failures to demonstrate reconnect. Reconnect/failure acceptance is synthetic in this report. Any future controlled disruption or physical scan needs a separate scope; an ordinary scan can trigger the existing playback automation.
7. Sign out and end the approved test session. Record actual commands/actions, expected versus observed results, redacted evidence locations, pass/fail/blocked, remaining limits and confirmation that no mutation/playback was attempted. Leave every unperformed check pending. Owner review of the live reconciliation evidence is still required before claiming the full M1 exit gate.
