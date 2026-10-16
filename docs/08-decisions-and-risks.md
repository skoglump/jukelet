# Decision register and risks

This register distinguishes owner-approved requirements from provisional recommendations and deferred implementation choices. Approval records intent; it is not evidence of an implemented or verified application.

## Accepted decisions

Owner-approved product identity (October 16, 2026):

- **Name:** Jukelet
- **Tagline:** Your music. A little more hands-on.
- **Description:** A personal jukebox powered by physical tags. Assign albums and playlists, then tap to play through Home Assistant.

Owner-approved baseline (October 16, 2026), completing JBM-001:

- **Stack and deployment:** React/TypeScript frontend, Python/FastAPI backend, and SQLite. A single Docker container serves the compiled frontend and backend API, with one backend worker/instance. SQLite persists in a mounted volume. Docker Compose is the documented deployment setup; secrets stay outside the image. A future companion is installed separately in Home Assistant.
- **Scope and safety:** M0 establishes the foundation, followed by the M1 read-only manager. Development and default tests use clearly labeled fixtures with no live household access. Live reads require separate authorization; HA mutations, playback and migration require their own explicit authorization. The boundaries in AGENTS.md apply throughout.
- **Ownership:** Home Assistant owns tag identity/name and playback; Jukelet owns assignments. Preserve existing household playback logic.
- **Publication and license:** The repository remains public at `skoglump/jukelet`. The owner selected the MIT license; see [LICENSE](../LICENSE).

## Baseline decision status

| ID | Status | Decision / recommendation | Rationale / consequence |
|---|---|---|---|
| D01 | Accepted | Standalone app; HA executes playback | Independent project without duplicating reliable household automation |
| D02 | Accepted | React/TypeScript + FastAPI + SQLite; one Docker container/worker, persistent volume and Compose | Small deployment and clear typed boundaries |
| D03 | Accepted | HA owns tag identity/name; app owns assignments | No competing editable masters |
| D04 | Provisional | SpotifyPlus first; provider adapter boundary | Reuse existing integration authentication/capabilities |
| D05 | Accepted | Read-only milestone before edits; fixture development and separately authorized live access | Useful first increment without risking playback |
| D06 | Provisional; M3 feasibility gate | Local immutable HA snapshot for runtime | App maintenance cannot disable scan dispatch |
| D07 | Provisional | Import known mapping shape once; no permanent automation rewriting | Decouple product data from YAML structure |
| D08 | Provisional implementation; required data-preservation invariant | Metadata optional; explicit label fallback | Personalized mixes and outages must not erase assignments |
| D09 | Accepted boundary; mechanism provisional in M0 | App-specific auth, secrets server-side/outside the image, no arbitrary HA proxy | Broad HA credentials must not reach the browser |
| D10 | Provisional | Album/playlist writes initially | Match the requested core workflow; report unsupported imported media |

Provisional choices remain the suggested design within the existing scope and invariants. Runtime/package versions and the exact authentication implementation are selected and recorded in JBM-002. M3 companion, persistence, transport and dispatch decisions remain deferred to their gates and do not block M0/M1.

## Decisions to settle at explicit gates

| Gate | Decision | Proposed default | Must not block |
|---|---|---|---|
| M0 | Supported runtime versions and package tools | Choose supported pinned versions at implementation time | No inferred version promises |
| M0 | Authentication deployment | App-secret login with server-side sessions; TLS for network access | Fixture development |
| Before M2 live writes | Permissions and mutation authorization | Dedicated deployment credential; explicit manage mode | Read-only build |
| M3 spike | Companion integration vs Pyscript | Dedicated HA integration for reusable distribution; Pyscript if deliberately local-only | M1/M2 application work |
| M3 spike | Durable storage and bridge transport | Supported HA integration primitives; prove persistence/response behavior | Read-only prototype |
| Before dispatcher implementation | Busy-scan/debounce behavior | Per reader/tag short debounce; latest different pending request per target | Metadata UI |
| Before publication UI | Auto-publish versus explicit publish | Auto-queue after save only after owner-approved cutover, with pending status | Local draft editing |
| Before release | Cache retention/artwork/link policy | Conservative, bounded and reviewed against provider rules | Basic text labels |
| Later | Track support, multi-room, multiple accounts, direct OAuth | Separate issues, not automatic scope expansion | Album/playlist release |

## Risks and mitigations

- **Spotify/provider capabilities vary:** discover installed services and test actual response shapes; preserve manual URI entry.
- **Metadata failure is mistaken for bad assignment:** independent status fields and regression tests.
- **Version-sensitive HA configuration API:** isolate importer, provide safe upload fallback, avoid claiming universal support.
- **Two assignment stores drift:** one writer, immutable published snapshots, revision/checksum reconciliation.
- **Lost acknowledgment causes duplicate action:** idempotent publication, status readback, no automatic playback retry.
- **App database restored behind HA:** halt auto-publication and reconcile publisher/revision rather than overwriting blindly.
- **Bridge adds maintenance burden:** minimal interface, one implementation initially, compatibility tests and documented installation.
- **Refactor breaks receiver/account preparation:** retain it in existing HA scripts; explicit regression tests under real conditions.
- **Duplicate playback during migration:** verify old off before new on; installation/publication do not enable dispatch.
- **Sensitive home data enters GitHub:** synthetic fixture policy, local protected backups, pre-publication review.
- **A coding agent overbuilds:** one issue at a time, clear non-goals and verified milestone exit criteria.

## Rejected as defaults

Permanent per-save automation rewriting; one automation per tag; direct database editing inside HA; exposing HA tokens to the browser; introducing separate Spotify authentication in M1; Redis/microservices; silently using metadata lookup as a playability validator; application-triggered playback alongside the HA dispatcher.

## How to change a decision

Record context, alternatives, selected option, migration/security effects and tests. Update the affected docs and issue acceptance criteria together. A local shortcut must not silently become a general product guarantee.
