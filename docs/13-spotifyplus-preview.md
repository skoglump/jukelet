# SpotifyPlus music preview (#11 / JBM-005)

This read-only slice adds album/playlist detail, search and library previews through the existing HA authentication and service allowlist. It does not save assignments, import mappings into SQLite, create OAuth flows, extract Spotify credentials or invoke playback. Inventory and uploaded mapping reports remain independent of music lookup failures. The only database tables remain the foundation's session/migration tables.

## Configuration and capabilities

Set optional `SPOTIFYPLUS_ENTITY_ID` to a configured `media_player.[a-z0-9_]{1,128}` entity alongside `HA_URL` and `HA_TOKEN`. It is server-side configuration, never a request parameter. Missing configuration leaves manual URI parsing available. Restart the single backend worker after account, HA or credential configuration changes: this constructs a fresh private in-memory cache. Changing the account behind the same HA entity also requires a restart; Jukelet cannot detect an upstream account switch that retains the same entity ID.

`GET /api/v1/music/capabilities` returns six independent keys: `album_detail`, `playlist_detail`, `album_library`, `playlist_library`, `album_search`, `playlist_search`. Values are `unknown`, `supported`, or `unsupported`. The existing installed-service discovery checks known required fields, unknown mandatory arguments, and response support. Library additionally requires `limit` and `offset`, and search requires `limit`, to make the operation safely bounded. Missing account configuration disables all six. Capability discovery is a schema check, not proof of successful access. The UI refreshes it every 30 seconds.

## Application API

All routes require the owner session cookie. All responses are `Cache-Control: no-store`. No route accepts an account, HA URL, service name or token override.

| Route | Input | Result |
|---|---|---|
| `POST /api/v1/music/resolve` | JSON `{"input":"spotify:album:0123456789ABCDEFGHIJKL","media_type":"album"}`; configured Origin and `X-CSRF-Token` required | Canonical `uri`, optional normalized `item`, independent metadata status |
| `GET /api/v1/music/search?media_type=album&q=example` | `album` or `playlist`; 1–200 nonblank query characters | Up to 20 normalized `items`, `total`; search is limited to the first page |
| `GET /api/v1/music/library?media_type=playlist&offset=0` | `album` or `playlist`; integer offset 0–1000 | One page of up to 20 items, `total` and nullable `next_offset` |

Result fields: `uri`, `item`, `items`, `total`, `next_offset`, `state` (`fresh`, `stale`, `unavailable`), `last_attempt_at`, `last_success_at`, `error`, and nullable `retry_after` seconds. An item contains canonical URI, media type, title, optional artist/owner display and artwork URL. Unknown wrappers and malformed required data return `unsupported_response`, never a successful empty array. A verified empty page has `items: []` plus valid paging fields. No upstream payload/user profile is returned.

A successful metadata result returns HTTP 200. Provider failures return HTTP 503 with the same normalized result and retained last-good display data when cached; a retry delay also sets `Retry-After`. Codes are `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `timeout`, `unavailable`, `unsupported_response`, or `unsupported_operation`. Upstream authorization failures remain 503 so they cannot be mistaken for expiry of the app session (401). Invalid application input returns bounded 422 `detail`; missing/invalid app session is 401, Origin/CSRF errors are 403, non-JSON resolve input is 415 and resolve bodies over 4096 bytes are 413.

Metadata lookup does not validate playability. Personalized Mix and other lookup failures retain the canonical URI and last-good metadata while advancing the attempt/error state. There is no saved assignment model in this release to mutate or delete. The UI labels previews and keeps previous results visibly identified when a network request fails; it never reports saving, publication or playback success.

## Supported inputs and upstream shapes

Accepted inputs are exact `spotify:album:<id>` / `spotify:playlist:<id>` URIs and `https://open.spotify.com/album/<id>` / `https://open.spotify.com/playlist/<id>` links. IDs are exactly 22 ASCII alphanumeric characters. The declared media type must match. Only `si` and `utm_source` share query parameters may be discarded. Whitespace/control characters, extra path components, localized paths, fragments, ports, credentials, shorteners, other URL schemes/hosts and other media types are rejected. Inputs are limited to 512 characters. Supplied links are parsed locally and are never fetched or followed.

The HA REST adapter removes the `service_response` envelope. The provider accepts the documented `{result: ...}` service response and an HA entity-keyed `{<configured entity>: {result: ...}}` envelope. Detail results require a matching URI, type and nonblank name. Returned labels and artwork URLs must encode as valid UTF-8; escaped unpaired surrogates reject the response before it can replace cached data. Library pages require `items`, integer `total`, `offset` matching the requested page, and `limit` from 1 to 20. Saved album entries contain an `album` object; playlist entries are direct objects. Search accepts a direct page or a `result.albums` / `result.playlists` page. It does not recursively hunt for arbitrary `items` arrays or follow upstream `next` URLs. Null/malformed entries, inconsistent paging and overlarge pages fail the entire request, retaining a previous successful response if available.

Synthetic fixtures derive their shapes from public SpotifyPlus `media_player.py` methods (`service_spotify_get_album`, `service_spotify_get_playlist`, favorites and search) and SpotifyWebApiPython model `ToDictionary` methods. The current inspected SpotifyPlus search methods return a direct page; nested search support is based on the SDK `SearchResponse` model. The entity-keyed envelope is an explicitly supported HA transport variant, covered synthetically. These are not captured household responses or a claim about every installed integration version.

Public source references inspected October 19, 2026:

- [SpotifyPlus service definitions](https://github.com/thlucas1/homeassistantcomponent_spotifyplus/blob/master/custom_components/spotifyplus/services.yaml)
- [SpotifyPlus service implementation](https://github.com/thlucas1/homeassistantcomponent_spotifyplus/blob/master/custom_components/spotifyplus/media_player.py)
- [SpotifyWebApiPython search model](https://github.com/thlucas1/SpotifyWebApiPython/blob/master/spotifywebapipython/models/searchresponse.py)
- [Saved album model](https://github.com/thlucas1/SpotifyWebApiPython/blob/master/spotifywebapipython/models/albumsaved.py) and [page model](https://github.com/thlucas1/SpotifyWebApiPython/blob/master/spotifywebapipython/models/pageobject.py)

HA can convert a Spotify error into a generic service error, losing its original HTTP category. Jukelet classifies HTTP status codes it actually receives; it does not parse arbitrary private error bodies to guess whether a generic HA failure was a Spotify 404 or 429. Such failures are `unavailable` and retain last-good data.

## Bounds and privacy

- One upstream metadata call at a time, at most eight admitted requests including the active call, and a 12-second overall deadline including lock wait. Overflow returns bounded unavailable/retry state. The existing HA REST deadline is 10 seconds and response limit 4 MiB. Concurrent identical requests reuse the first successful cached result.
- No automatic metadata retry, exhaustive library scrape, background library load, or fetching supplied links. The UI searches after 350 ms of inactivity, aborts superseded requests, ignores late responses, and offers explicit library paging and retries. Browser cancellation does not guarantee cancellation of an already dispatched HA operation.
- Per-provider-instance LRU cache: 128 detail/search/page entries, 5-minute freshness, last-good retention up to 24 hours from the last success. Expired entries are purged on the next request; unused data is never returned past retention. Entries may be evicted earlier by the size bound. No disk/browser storage. Cache keys include provider, configured HA origin, account entity, operation and request parameters. Restart clears all cache/backoff state; there is no cross-instance cache.
- Failures suppress repeated calls for 30, 60, 120, 240, then 300 seconds (maximum); HTTP 429 also establishes a provider-wide cooldown. These are local conservative delays, not a guarantee about Spotify's retry window. No internal retry occurs when the delay expires: another user request is required.
- Library page size is 20 and the highest starting offset is 1000 (at most 1020 browsable results). Search only returns the first 20. Every UI library page is explicit; previous-page navigation uses visited offsets, including short pages, and resets when changing music type or browsing mode. Unsupported paging schemas disable that capability.
- Titles and artist/owner labels are bounded. Only HTTPS artwork at `i.scdn.co`, `mosaic.scdn.co`, `image-cdn-ak.spotifycdn.com`, and `image-cdn-fa.spotifycdn.com` is retained. The browser loads those images directly without a referrer; CSP permits only those image hosts plus same-origin. Other artwork hosts are omitted. Images are not proxied, persisted or fetched by the backend. Broader artwork/provider policy remains a release review item.

## Verification

`make check` covers provider normalization, parser negatives, verified-empty/malformed responses, HTTP categories, last-good preservation, bounded paging/cache/concurrency/backoff, isolated account caches, authenticated/CSRF API behavior and UI debounce/stale-request/manual fallback. `make build` packages both applications. `make smoke` exercises a synthetic container/browser session, imported preview retention and manual music fallback with HA and SpotifyPlus configuration explicitly cleared.

Optional local HTTP simulation, when Postman CLI is installed (no workspace/login required):

```sh
postman simulation run scripts/fixtures/music/preview.sim.yaml --port 4900 --output ndjson --no-history
# In another shell, after the local simulation reports ready:
uv run --project backend --locked python scripts/probe_music_simulation.py
```

Restart the simulation before each probe because its deterministic sequence is success, HTTP 429, then HTTP 404. The real RestClient/provider probe is fixed to `127.0.0.1:4900` with synthetic credentials and never reads household settings. Stop the simulation with Ctrl-C. This supplements the default in-process HTTP fixtures; it is not required for normal tests or a live integration claim.

No live HA/Spotify, private library, physical reader, playback, deployment or migration verification is performed by these checks. Installed provider versions, permissions and account restrictions remain deployment-specific limitations.
