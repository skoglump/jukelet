# Jukelet

**Your music. A little more hands-on.**

A personal jukebox powered by physical tags. Assign albums and playlists, then tap to play through Home Assistant.

**Status:** Standalone tag inventory, onboarding, HA rename, saved assignments,
metadata discovery/fallback, native export/restore and guarded publication are implemented.
The separately installed HA bridge performs playback through the configured script and
remembers healthy reviewed enable/disable choices. App **0.1.0-rc.3** and integration
**0.1.5** retire the old automation migration feature; no old automation, entity ID or
mapping report is required. See [retirement, upgrade and decommission guidance](docs/32-migration-retirement.md).
Saved, published, enabled and independently playback-verified remain separate states.
Historical household evidence and the restore-testing waiver remain unchanged.


**Accepted next direction:** move this application into an HA OS add-on with
Ingress, retaining the separate playback bridge. Standalone Docker remains
supported until verified, owner-approved cutover and retirement. The
[transition contract](docs/33-ha-addon-transition.md) and [M5 roadmap](docs/05-milestones.md#m5--home-assistant-add-on-transition)
define the planned modes, safety gates and deployment facts still to confirm;
browser prefix routing and the [backend Ingress trust/session boundary](docs/10-development.md#backend-ingress-boundary-55)
are implemented. Ingress UI lifecycle, Supervisor transport, add-on packaging and
actual HA OS verification remain pending.

**License:** [MIT](LICENSE).

## Product in one paragraph

Jukelet is a standalone, self-hosted web application for assigning Spotify albums and playlists to tags registered in Home Assistant. Scan a tag with an existing Home Assistant reader, see it in an unassigned-tag inbox, give it a friendly name, and assign music by searching, browsing, or pasting a Spotify link. Keep existing receiver preparation and playback logic in Home Assistant. Once the execution bridge is implemented and activated, normal tag playback must not depend on the management app being online.

## Start here

For installation, configuration, daily use, backups and recovery, follow [installation and operations](docs/26-installation-and-operations.md). See [release readiness and evidence](docs/27-release-readiness.md) for the tested support boundary and open gates. The [app 0.1.0-rc.3 notes](docs/32-migration-retirement.md) retain their preparation-time scope; [public RC3 artifact metadata](docs/33-ha-addon-transition.md#evidence-and-compatibility-baseline) now confirms publication. Earlier RC artifacts remain frozen. [Development and Docker operation](docs/10-development.md) contains the detailed commands. The localhost quick start is:

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
for reproducible archives, integrity metadata, the tested matrix and guarded restart procedure. For integration 0.1.5, consult the [remembered-dispatch behavior and artifact evidence](docs/31-remembered-dispatch.md) and [minimum/forward compatibility policy](docs/30-ha-compatibility.md) before updating HA. The [0.1.2/Core 3 coordinated guide](docs/28-ha-2026-10-3-upgrade.md) remains the historical transition for older installations.

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
| [App publication](docs/19-app-publication.md) | Durable jobs, actual-state reconciliation, reviewed recovery and explicit automatic-publication opt-in |
| [Controlled migration](docs/20-controlled-migration.md) | Private approval packet, protected backup/recovery, serial cutover/rollback, isolated actual-HA rehearsal and attributed household evidence/limits |
| [HA-local dispatcher](docs/18-ha-local-dispatcher.md) | Administrative activation, local allowlist, single admission, durable uncertainty and isolated HA restart evidence |
| [Playback script boundary](docs/17-playback-script-contract.md) | Internal reference adapter, isolated HA script evidence and owner-reviewed household extraction plan; live execution/verification pending |
| [Playback diagnostics](docs/22-playback-diagnostics.md) | Read-only readiness, bounded scan/attempt observations, freshness and failure guidance; administrator recovery remains separate |
| [Guarded HA playback controls](docs/23-guarded-playback-controls.md) | Administrator pause inspection, explicit disable/enable and separate stopped-work reconciliation with independent readback |
| [M1 verification](docs/14-m1-verification.md) | Fixture evidence, limits and separately authorized live-read checklist |
| [Agent workflow](docs/12-agent-workflow.md) | Optional preparation, native execution loop, handoffs and validation evidence |

## Current operation

Use the standalone inventory and saved assignment editor. HA owns names and playback;
the app database owns assignments. An assignment save never starts music. Publication
and administrator dispatch activation have independent review and readback.

## Using this bundle in a new repository

The GitHub repository is [skoglump/jukelet](https://github.com/skoglump/jukelet). Milestones M0–M5 and reviewed implementation issues are published; M5 links and dependencies are in the current milestone plan, while the original backlog retains dated planning history. Keys such as `JBM-001` are planning identifiers, not GitHub issue numbers. See [the backlog](issues/README.md) for published issue links and translate later dependencies when creating those issues.

Documentation links in the published GitHub issues target the planning files on `main`.

The owner approved public development under the MIT license. Review scope and check files for private information before publishing further changes. This bundle deliberately omits the household's hostnames, account-specific entity IDs, physical tag IDs and receiver identifiers. Generic API names are retained.

Development checks: `make bootstrap`, `make check`, `make build`, `make image`, and
`make smoke`. See the development guide for pinned tools and isolated verification.
No current verification claim replaces the [dated household limitations](docs/20-controlled-migration.md).
