# Jukelet

**Your music. A little more hands-on.**

A personal jukebox powered by physical tags. Assign albums and playlists, then tap to play through Home Assistant.

**Status:** planning and implementation handoff only. This bundle contains documentation and issue drafts, not an implemented app, HA integration, migration, or tested deployment. Prepared October 15, 2026 from the project discussion and read-only investigation.

**License:** [MIT](LICENSE).

## Product in one paragraph

Jukelet is a standalone, self-hosted web application for assigning Spotify albums and playlists to tags registered in Home Assistant. Scan a tag with an existing Home Assistant reader, see it in an unassigned-tag inbox, give it a friendly name, and assign music by searching, browsing, or pasting a Spotify link. Keep existing receiver preparation and playback logic in Home Assistant. Once the execution bridge is implemented and activated, normal tag playback must not depend on the management app being online.

## Start here

1. Read [project brief](docs/01-project-brief.md).
2. Read [architecture](docs/02-architecture.md) and [decision register](docs/08-decisions-and-risks.md).
3. Give a coding agent [AGENTS.md](AGENTS.md) and [the first-task brief](docs/09-first-agent-task.md).
4. Review the created [GitHub milestones](https://github.com/skoglump/jukelet/milestones) against [the milestone plan](docs/05-milestones.md).
5. The baseline decisions in [JBM-001 / #1](https://github.com/skoglump/jukelet/issues/1) are accepted. Next, implement [JBM-002 / #2](https://github.com/skoglump/jukelet/issues/2). Publish later issues from [the ordered backlog](issues/README.md) as their design is reviewed.

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

## Recommended starting scope

Build a working **read-only manager** first: tag inventory, existing-assignment preview, metadata, music discovery, and connection status. Preserve the current HA automation unchanged. A UI-only mockup is not the milestone; an authenticated, containerized application with fixture tests and a separately authorized live-read verification is.

Accepted baseline: React/TypeScript frontend, Python/FastAPI backend, and SQLite. Jukelet will run in a single Docker container serving the frontend and backend, with one backend instance, a mounted volume for SQLite persistence, and Docker Compose as the documented deployment setup. Secrets remain outside the image. The eventual HA companion is installed separately in Home Assistant. These requirements are approved; the infrastructure is not yet implemented.

## Using this bundle in a new repository

The GitHub repository is [skoglump/jukelet](https://github.com/skoglump/jukelet). Milestones M0–M4, the initial labels, and issues #1–#2 have been created; the remaining issue drafts are local files. Keys such as `JBM-001` are planning identifiers, not GitHub issue numbers. See [the backlog](issues/README.md) for published issue links and translate later dependencies when creating those issues.

Documentation links in the published GitHub issues target the planning files on `main`.

The owner approved public development under the MIT license. Review scope and check files for private information before publishing further changes. This bundle deliberately omits the household's hostnames, account-specific entity IDs, physical tag IDs and receiver identifiers. Generic API names are retained.

There are no working setup/build commands yet. Milestone M0 must add and actually test them. Do not mistake suggested interfaces or examples for shipped functionality.
