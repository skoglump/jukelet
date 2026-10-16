# Session findings and evidence boundaries

## Provenance

The following live findings come from read-only tools run earlier in this conversation on October 15, 2026. They were not rerun while assembling this documentation. External protocol references below were retrieved while preparing the bundle. No project application or companion has been implemented or live-tested.

Household-specific URLs, account identifiers, physical tag IDs, reader IDs, automation IDs and receiver IDs have deliberately been omitted from this repository-ready version. Obtain them through owner-supplied configuration/discovery during implementation. Do not guess them from these examples.

## Observed live

| Check | Result | Boundary |
|---|---|---|
| HA config | Version `2026.10.1` | Point-in-time observation, not a minimum-version guarantee |
| Tag inventory | 11 registered tags | Actual `tag/list` result |
| Legacy map | 9 mappings: 8 playlists, 1 album | Counted programmatically from `variables.tags` |
| Inventory comparison | 2 registered tags unassigned; 0 mapped IDs missing from registry | Exact-string join, not name matching |
| Tag events | WebSocket subscription acknowledged | No physical new-tag scan was performed |
| Album metadata | Currents title, URI, artwork returned | Read-only lookup |
| Playlist metadata | Top50 title, URI, artwork returned | Read-only lookup |
| Personalized mix | One existing mix returned HTTP 400 / Resource not found | Does not establish playability or root cause |
| Library query | A page of followed/owned playlists returned | Did not exhaustively verify every playlist |
| Album search | Currents and a related release returned | Verified album search only |
| Playlist search | Preliminary probe printed an empty list | Response normalization was not sufficiently established; do not treat this as proven search support or a genuine zero-result query |
| HA changes/playback | None during the investigation | Metadata operations used service requests but did not request playback |

The distinction between a successfully registered subscription and a real end-to-end scan matters. Unknown-tag onboarding, rename permissions for the eventual app credential, restart survival and migration still require explicit tests.

## Existing automation structure

Observed behavior, summarized rather than copied:

1. Receives `tag_scanned` events.
2. Continues only if the scanned tag ID appears in `variables.tags`.
3. Resolves `media_content_id` and `media_content_type` from that map.
4. Starts Harmony Music/receiver readiness handling where needed.
5. Calls an existing reusable Onkyo preparation script before transfer.
6. Transfers playback to a configured native Spotify Connect target.
7. Has distinct playlist, album and track branches.
8. Has a post-start album shuffle safeguard.
9. Uses `mode: single` with silent overflow behavior.

The playlist branch reads a track count with a fallback, selects a random starting offset, starts context playback, then enables shuffle. The album path is explicitly unshuffled. These are observed existing behaviors, not recommendations to generalize every quirk unchanged. Preserve behavior initially; independently review compatibility and fallback logic before refactoring it.

Receiver/account readiness is deliberately outside the proposed app's responsibility. This investigation did not retest cold startup, cross-account takeover or the full playback sequence.

## Sanitized shape example

This is an illustrative, manually sanitized shape, **not a raw API capture or a runnable fixture**. Angle-bracket catalog IDs are placeholders and intentionally fail normal URI validation. Future test fixtures must use deliberate synthetic data and be labeled accordingly.

```json
{
  "variables": {
    "tags": {
      "EXAMPLE_TAG_A": {
        "media_content_id": "spotify:playlist:<playlist-id>",
        "media_content_type": "playlist"
      },
      "EXAMPLE_TAG_B": {
        "media_content_id": "spotify:album:<album-id>",
        "media_content_type": "album"
      }
    }
  }
}
```

Illustrative tag-list shape (not a captured payload):

```json
{
  "id": 1,
  "type": "result",
  "success": true,
  "result": [
    {"id": "EXAMPLE_TAG_A", "name": "Dinner music", "last_scanned": null}
  ]
}
```

## External evidence and limits

Detailed protocol claims are cited in [integration contracts](03-integration-contracts.md). HA tag and collection source references are pinned to the observed core version. SpotifyPlus's service source is an unpinned upstream branch; the installed service schema must win when the two differ.

Spotify's February 6, 2026 announcement describes tighter Development Mode access; its March 9 update says endpoint-access changes for existing integrations were postponed while other requirements remained.[6] This is dated context, not a complete current capability matrix. Do not attribute the observed mix lookup failure to those changes without evidence. Recheck provider rules at implementation/release, especially before adding direct OAuth or distributing to other accounts.

## Findings that remain unverified

- Whether each music-discovery service works with the eventual configured account.
- Playlist-search normalization and paging behavior.
- Installed SpotifyPlus version/library details and compatibility across versions.
- A real unknown tag arriving while the app is open, closed or disconnected.
- The app credential's usable permissions and safe deployment authentication.
- Durable snapshot publication/activation, idempotency and crash recovery.
- Any proposed bridge name, service, response schema or storage implementation.
- Any build, lint, automated test suite, Docker image or application runtime.

Do not turn these unknowns into claims of completion when creating issues or prompting a coding agent.

## Sources

[6] https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security
