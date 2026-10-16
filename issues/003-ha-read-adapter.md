# JBM-003 — Implement read-only HA adapter and capability discovery

**GitHub issue:** [#4](https://github.com/skoglump/jukelet/issues/4)

**Milestone:** M1 — Read-only manager

**Label:** testing

**Dependencies:** [JBM-002 / #2](https://github.com/skoglump/jukelet/issues/2)

## Goal

Provide one bounded, reconnecting HA transport layer for the management app.

## Scope

Implement server-side authentication, REST reads, correlated WebSocket requests, scan subscription, installed service discovery, normalized errors and reconnect handling. Enforce an operation allowlist: metadata service POSTs can be read-only in intent; arbitrary service calls are not allowed.

Use `HA_URL` and `HA_TOKEN` environment variables supplied to the Docker container, following the owner-approved configuration preference (D11). Compose references secret variables; actual values remain outside Git. Never expose the HA token to the browser, logs or diagnostics.

## Acceptance criteria

- [ ] Fixture tests cover authentication failure, timeout, reconnect and subscription restoration.
- [ ] Version/service/capability status is exposed without leaking raw HA configuration.
- [ ] Reconnect refreshes tag inventory rather than claiming missed-event replay.
- [ ] Read-only mode blocks tag edits, configuration writes, playback, power, volume and scan simulation.
- [ ] One connection owner exists in the supported single-worker deployment.

## Verification

Run transport/contract tests. Any live handshake/discovery check is separately authorized and reported as live or not performed.

## Out of scope

No mutations, general HA proxy, direct Spotify login or receiver control.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
