# Project brief

## Product identity

**Name:** Jukelet  
**Tagline:** Your music. A little more hands-on.

A personal jukebox powered by physical tags. Assign albums and playlists, then tap to play through Home Assistant.

## Problem

The current HA jukebox keeps tag-to-music assignments inside an automation. Changing what a tag plays requires editing automation configuration; discovering an unknown tag and assigning a friendly name/music is not a unified workflow. The project should make that management task accessible through a separate web app without replacing working playback behavior.

## Goals

- View all HA tags, with clear assigned, unassigned and disabled states.
- Assign an album or playlist using a Spotify URI/link, search or library browsing.
- Rename a tag through HA while keeping its label separate from Spotify's title.
- Surface newly seen and older unassigned tags in an inbox.
- Preserve mappings even when metadata is unavailable.
- Preserve saved assignments and native Jukelet export/restore; old automation imports are retired by #51.
- Provide portable backup/export and a reversible migration.
- Ultimately keep scan-to-play execution within HA, independent of app uptime.
- Keep the app generic and reusable: household-specific receiver actions belong in configured HA scripts, not application code.

## Non-goals for the first release

- Playing Spotify audio in the browser or implementing a streaming client.
- A new Spotify OAuth flow or extracting integration credentials.
- Writing NFC tags from the browser, replacing readers, or depending on Web NFC support.
- Managing arbitrary HA automations, a universal Jinja importer, or a generic HA API proxy.
- SaaS, multi-household tenancy, multiple app writers, direct receiver authentication, or a microservice architecture.
- Supporting every music provider, HA deployment mode or Spotify account restriction immediately.
- Copying all of the household's private automation configuration into the public repository.

## User journeys

### Browse existing tags

Open the app, see tag name, assigned music, available artwork, last scan, metadata status and publication status. Filter or search by tag label/music title. Distinguish a missing HA tag from an unassigned registered tag.

### Discover and assign

Open Add tag or scan while the management UI is closed. The backend reconciles discoveries into the unassigned inbox when connected. Choose the matching scan/reader, supply a label, select music and save. When publication is available, show pending until HA confirms the exact revision. Saving never starts music.

Tags scanned while the backend is disconnected can be found through registry reconciliation; do not promise complete recovery of individual historical scan events. Unassigned tags are not necessarily newly scanned or intended for this jukebox.

### Change music

Select another album/playlist, inspect the preview, save with optimistic concurrency, and display whether the currently active HA mapping differs. A metadata refresh must not replace a user-defined tag label.

### Replace a physical tag

Later, transfer an assignment to another existing HA tag with a preview. Explicitly choose whether to disable/unassign the old tag. Do not delete the old HA tag automatically; it may serve unrelated automations.

### Diagnose a failed scan

Distinguish no recent observed scan, no assignment, disabled mapping, bridge unavailable, receiver preparation failed and playback request accepted. Only display playback verified when independently checked; missing telemetry means unknown, not failed playback.

## Historical delivery stages (not current prerequisites)

- **M0:** application foundation using React/TypeScript, FastAPI and SQLite; one Docker container, persistent SQLite volume, Docker Compose, authentication/secrets boundary, enforced read-only default and fixture-only verification. No live household access.
- **M1:** read-only inventory, legacy-map preview, metadata and discovery. No HA writes.
- **M2:** local draft assignments, explicit HA rename, onboarding and backups. Existing automation remains the playback owner; drafts are not advertised as live.
- **M3:** publication bridge, reusable playback script contract, single HA dispatcher and controlled migration.
- **M4:** release hardening, supported deployment documentation and operational diagnostics.

Current operation and retirement boundaries are in [#51 guidance](32-migration-retirement.md).

Albums and playlists are the writable baseline. The existing automation also has a track branch; imported tracks or other types must be reported as unsupported and preserved in the import report, not discarded. In the October 22, 2026 [#26 plan review](17-playback-script-contract.md#owner-reviewed-household-extraction-plan), the owner approved removing individual-track support from the intended migrated flow; no current live configuration changes with that decision.

## UX requirements

Mobile-friendly layout, keyboard-accessible controls, text alternatives for artwork, clear empty/loading/error states, timestamps for cached information, and confirmation for disruptive operations. No autoplay or hidden test playback. Provide a manual URI option when search/library capabilities are absent.

Initial UI language can be English, but preserve Unicode labels and avoid assumptions that preclude Swedish names or later localization.

## Success criteria

The owner can assign a newly registered tag without editing YAML. A metadata outage does not destroy an assignment. Existing saved assignments remain unchanged by retirement. After M3, stopping the app does not disable scans handled by the active HA bridge. Every success claim has a defined verification method.
