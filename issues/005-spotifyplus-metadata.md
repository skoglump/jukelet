# JBM-005 — Implement SpotifyPlus metadata, search and library adapter

**Suggested milestone:** M1  
**Suggested labels:** backend, spotify, testing  
**Dependencies:** JBM-003

Draft key only; replace dependencies with actual GitHub issue links after creation.

## Goal

Retrieve useful music details through existing HA authentication while gracefully handling incomplete provider access.

## Scope

Implement supported URI/link resolution, album/playlist metadata, library pagination and search according to installed service capabilities. Normalize nested responses, classify failures, bound concurrency and cache per provider/account context. Supply a manual-URI fallback.

## Acceptance criteria

- [ ] Album and playlist detail/library/search capabilities are reported independently.
- [ ] Unexpected response wrappers fail explicitly rather than becoming empty result arrays.
- [ ] Mix/not-found lookup failures retain saved assignments and last good metadata.
- [ ] Paging/debounce/backoff are bounded; an account configuration change cannot reuse another account’s private cache.
- [ ] URI parsing rejects type mismatches and does not fetch arbitrary URLs.
- [ ] No direct Spotify OAuth or token extraction is introduced.

## Verification

Contract tests include successful results, empty verified results, nested responses, rate limits, missing fields, not-found and unsupported services. Live checks are read-only and optional.

## Out of scope

No playback, permanent API availability promise, exhaustive library scrape or browser music player.

## Implementation references

See [milestones](../docs/05-milestones.md), [integration contracts](../docs/03-integration-contracts.md), [testing and migration](../docs/06-testing-security-migration.md), and [AGENTS.md](../AGENTS.md). These repository-relative links work in the draft files; replace them with repository file URLs when pasting into a GitHub issue.

## Completion report

Record actual changes, checks run/results, evidence locations, and remaining limitations. Leave unverified criteria unchecked.
