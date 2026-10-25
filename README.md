# Jukelet

**Your music. A little more hands-on.**

A personal jukebox powered by physical tags. Assign albums and playlists, then tap to play through Home Assistant.

**Status:** M0 foundation plus the M1 read-only manager (#13), reusing Home Assistant transport (#4), tag inventory and safe legacy mapping preview (#9). Docker serves an authenticated interface with persistent SQLite sessions, inventory freshness, configured-source or uploaded JSON/YAML previews and downloadable reports. SpotifyPlus album/playlist metadata, search and library previews (#11) use the configured HA account and preserve manual URI fallback. The mobile and keyboard interface adds tag detail, preview-scoped mapping filters and explicit metadata lookup. M2 local draft assignments (#16) add persistent preferences, optimistic edits and reviewed imports in explicit `APP_MODE=manage`. Drafts do not drive legacy playback. Add tag and the unassigned inbox (#17) distinguish observed scans from registered tags; explicit HA rename requires manage mode and registry readback. Versioned logical export and reviewed restore (#18) add portable mapping backups and guarded SQLite recovery. The separately installed [HA companion bridge](companion/README.md) (#25) persists validated snapshots with explicit pairing/recovery; the [HA-local dispatcher](docs/18-ha-local-dispatcher.md) (#29) adds explicit administrative activation and isolated execution/restart evidence. [App publication and reconciliation](docs/19-app-publication.md) (#30) adds immutable durable jobs, verified active-state UI and explicit persistent migration opt-in. Household cutover remains separately authorized work.

**License:** [MIT](LICENSE).

## Product in one paragraph

Jukelet is a standalone, self-hosted web application for assigning Spotify albums and playlists to tags registered in Home Assistant. Scan a tag with an existing Home Assistant reader, see it in an unassigned-tag inbox, give it a friendly name, and assign music by searching, browsing, or pasting a Spotify link. Keep existing receiver preparation and playback logic in Home Assistant. Once the execution bridge is implemented and activated, normal tag playback must not depend on the management app being online.

## Start here

For the working application, follow [development and Docker operation](docs/10-development.md). The localhost quick start is:

```sh
python3 scripts/init_secret.py
docker compose -f compose.yaml -f compose.dev.yaml build
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait
```

Open `http://localhost:8000` and use the secret from `.secrets/app-auth-token`. The secret stays outside the image and Git. SQLite persists in a named volume. Network access requires HTTPS through a reverse proxy; see the deployment guide.

Published stable and numbered RC GitHub releases automatically run CI and publish the complete app
to GHCR at `ghcr.io/skoglump/jukelet`, for Linux AMD64. The verified
[0.1.0-rc.1 preview](https://github.com/skoglump/jukelet/releases/tag/v0.1.0-rc.1)
is public and can be pulled without registry credentials. See
[release images and upgrades](docs/10-development.md#release-images-and-upgrades)
for its exact digest, verification evidence, version preparation and Compose upgrades. An RC such
as `0.1.0-rc.1` publishes only its exact image tag; stable releases also move their
minor tag and `latest`. Image availability is separate from application login and
instance configuration. Publishing an image does not update a running server.

The HA integration is installed and versioned separately from the app image. See
[integration packages, installation and upgrades](docs/24-integration-distribution.md)
for reproducible archives, integrity metadata, the tested matrix and guarded restart procedure.

For project context:

1. Read [project brief](docs/01-project-brief.md).
2. Read [architecture](docs/02-architecture.md) and [decision register](docs/08-decisions-and-risks.md).
3. Give a coding agent [AGENTS.md](AGENTS.md) and [the first-task brief](docs/09-first-agent-task.md).
4. Review the created [GitHub milestones](https://github.com/skoglump/jukelet/milestones) against [the milestone plan](docs/05-milestones.md).
5. Review the [M1 verification evidence and pending live-read path](docs/14-m1-verification.md). M2 local assignment management is implemented; rename/onboarding is implemented; versioned export and guarded recovery are implemented; see [the ordered backlog](issues/README.md) for published issues and dependencies.

## Documentation map

| File | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | Agent working rules, safety boundaries, definition of done |
| [Project brief](docs/01-project-brief.md) | Goals, user journeys, scope, non-goals |
| [Architecture](docs/02-architecture.md) | Ownership, components, reliability and deployment |
| [Integration contracts](docs/03-integration-contracts.md) | HA/SpotifyPlus APIs and proposed bridge protocol |
| [Data and application API](docs/04-data-and-api.md) | Suggested models, endpoints, statuses and concurrency |
| [Milestones](docs/05-milestones.md) | Delivery sequence and exit criteria |
| [Testing, security and migration](docs/06-testing-security-migration.md) | Quality gates, live-test boundaries, cutover and rollback |
| [Session findings](docs/07-session-findings.md) | Observations, limitations, sanitized examples and source provenance |
| [Decisions and risks](docs/08-decisions-and-risks.md) | Recommended defaults versus decisions still needing agreement |
| [First agent task](docs/09-first-agent-task.md) | Copy-ready instruction for starting implementation |
| [Issue backlog](issues/README.md) | Draft titles, milestone assignments and dependencies |
| [Development and Docker operation](docs/10-development.md) | Working setup, authentication, configuration and verification commands |
| [Domain glossary](docs/11-domain-glossary.md) | Shared vocabulary with proposed behavior distinguished from implemented capabilities |
| [Supported companion](companion/README.md) | Installation, pairing, durable history, recovery and version policy |
| [Companion feasibility](docs/15-companion-feasibility.md) | Bounded HA restart/storage spike, exact v1 bridge contract and production blockers |
| [App publication](docs/19-app-publication.md) | Durable jobs, actual-state reconciliation, reviewed recovery and explicit migration opt-in |
| [Controlled migration](docs/20-controlled-migration.md) | Private approval packet, protected backup/recovery, serial cutover/rollback and synthetic actual-HA rehearsal; household verification pending |
| [HA-local dispatcher](docs/18-ha-local-dispatcher.md) | Administrative activation, local allowlist, single admission, durable uncertainty and isolated HA restart evidence |
| [Playback script boundary](docs/17-playback-script-contract.md) | Internal reference adapter, isolated HA script evidence and owner-reviewed household extraction plan; live execution/verification pending |
| [Playback diagnostics](docs/22-playback-diagnostics.md) | Read-only readiness, bounded scan/attempt observations, freshness and failure guidance; administrator recovery remains separate |
| [Guarded HA playback controls](docs/23-guarded-playback-controls.md) | Administrator pause inspection, explicit disable/enable and separate stopped-work reconciliation with independent readback |
| [M1 verification](docs/14-m1-verification.md) | Fixture evidence, limits and separately authorized live-read checklist |
| [Agent workflow](docs/12-agent-workflow.md) | Optional preparation, native execution loop, handoffs and validation evidence |

## Recommended starting scope

Build a working **read-only manager** first: tag inventory, existing-assignment preview, metadata, music discovery, and connection status. Preserve the current HA automation unchanged. A UI-only mockup is not the milestone; an authenticated, containerized application with fixture tests and a separately authorized live-read verification is.

Implemented foundation: React/TypeScript frontend, Python/FastAPI backend, and SQLite in a single Docker container, with one backend instance, a mounted SQLite volume, and Docker Compose configuration. Secrets remain outside the image. The HA companion is installed separately in Home Assistant.

## Using this bundle in a new repository

The GitHub repository is [skoglump/jukelet](https://github.com/skoglump/jukelet). Milestones M0–M4 and reviewed implementation issues are published; later proposals remain local drafts. Keys such as `JBM-001` are planning identifiers, not GitHub issue numbers. See [the backlog](issues/README.md) for published issue links and translate later dependencies when creating those issues.

Documentation links in the published GitHub issues target the planning files on `main`.

The owner approved public development under the MIT license. Review scope and check files for private information before publishing further changes. This bundle deliberately omits the household's hostnames, account-specific entity IDs, physical tag IDs and receiver identifiers. Generic API names are retained.

Development checks: `make bootstrap`, `make check`, `make build`, `make image`, and `make smoke`. See the development guide for pinned tool versions and Chromium installation. HA transport/status, tag inventory, legacy mapping preview and [SpotifyPlus music previews](docs/13-spotifyplus-preview.md) are implemented; local assignment persistence is implemented; HA rename and onboarding are implemented with fixture verification; versioned export and guarded recovery are implemented; app publication and reviewed recovery are implemented; household migration remains pending.
