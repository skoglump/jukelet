# GitHub issue backlog

This backlog contains **17 issue specifications**. JBM-001 through JBM-005 are published on GitHub; the remaining 12 are local drafts. Planning keys are stable references, not GitHub issue numbers.

## Published on GitHub

- [#1 — JBM-001: Confirm baseline scope and repository decisions](https://github.com/skoglump/jukelet/issues/1)
- [#2 — JBM-002: Bootstrap application, authentication boundary and CI](https://github.com/skoglump/jukelet/issues/2), dependent on #1
- [#4 — JBM-003: Implement read-only HA adapter and capability discovery](https://github.com/skoglump/jukelet/issues/4), dependent on #2; milestone M1, label `testing`
- [#9 — JBM-004: Build tag inventory and safe legacy mapping preview](https://github.com/skoglump/jukelet/issues/9), dependent on #4; milestone M1
- [#11 — JBM-005: Implement SpotifyPlus metadata, search and library adapter](https://github.com/skoglump/jukelet/issues/11), dependent on #4; milestone M1, label `testing`
- [Milestones M0–M4](https://github.com/skoglump/jukelet/milestones) and labels `planning`, `architecture`, `foundation`, `security`, and `testing` are created.

Verified October 16, 2026. The repository is public; documentation links in the published issues target the planning files on `main`. JBM-001 and JBM-002 are closed on GitHub. JBM-003 is published and includes the owner-approved environment-variable configuration preference. Check for existing objects before publishing additional issues or milestones.

Publication links updated October 19, 2026: JBM-004 is #9 and JBM-005 is #11. Acceptance criteria remain unchecked until verified; check GitHub for current issue state.

## Creation workflow

1. Review the accepted baseline decisions, Jukelet name, MIT license and public repository scope.
2. Create milestone names M0–M4 from [the milestone document](../docs/05-milestones.md).
3. Create the early issues first; there is no need to open every later task before reviewing the design.
4. Use the heading as the issue title and the remaining body as the description.
5. Translate draft-key dependencies to actual issue references after creation.
6. Replace relative documentation links with links to the files in your repository; relative links in pasted issue bodies do not automatically refer to the same paths.
7. Keep checkboxes unchecked until the named behavior is verified.

## Ordered backlog

| Draft key | Title / body file | Milestone | Depends on |
|---|---|---|---|
| JBM-001 | [Confirm baseline scope and repository decisions](001-confirm-baseline.md) | M0 | — |
| JBM-002 | [Bootstrap application, authentication boundary and CI](002-bootstrap-application.md) | M0 | JBM-001 |
| JBM-003 | [Implement read-only HA adapter and capability discovery](003-ha-read-adapter.md) | M1 | JBM-002 |
| JBM-004 | [Build tag inventory and safe legacy mapping preview](004-tag-inventory-import-preview.md) | M1 | JBM-003 |
| JBM-005 | [Implement SpotifyPlus metadata, search and library adapter](005-spotifyplus-metadata.md) | M1 | JBM-003 |
| JBM-006 | [Build mobile-friendly read-only tag and music interface](006-read-only-ui.md) | M1 | JBM-004, JBM-005 |
| JBM-007 | [Verify and document the M1 read-only milestone](007-read-only-acceptance.md) | M1 | JBM-006 |
| JBM-008 | [Implement local assignments, confirmed import and optimistic edits](008-local-assignment-editing.md) | M2 | JBM-007 |
| JBM-009 | [Add unassigned-tag onboarding and explicit HA rename](009-tag-onboarding-rename.md) | M2 | JBM-008 |
| JBM-010 | [Implement versioned export, restore preview and safe backup workflow](010-export-backup-restore.md) | M2 | JBM-008 |
| JBM-011 | [Spike HA companion persistence and approve the bridge contract](011-companion-feasibility.md) | M3 | JBM-007 |
| JBM-012 | [Implement durable versioned HA mapping bridge](012-durable-ha-bridge.md) | M3 | JBM-011 |
| JBM-013 | [Define reusable playback script contract and preserve existing behavior](013-playback-script-contract.md) | M3 | JBM-011 |
| JBM-014 | [Implement the single HA-local tag playback dispatcher](014-ha-scan-dispatcher.md) | M3 | JBM-012, JBM-013 |
| JBM-015 | [Connect app publication, revision reconciliation and status UI](015-publication-reconciliation.md) | M3 | JBM-008, JBM-010, JBM-012 |
| JBM-016 | [Perform owner-approved migration and rollback verification](016-controlled-migration.md) | M3 | JBM-009, JBM-010, JBM-014, JBM-015 |
| JBM-017 | [Complete release hardening and installation documentation](017-release-hardening.md) | M4 | JBM-016 |

## Milestone labels

- M0: Repository foundation and safe defaults
- M1: Read-only manager
- M2: Local assignment management and onboarding
- M3: HA-local execution and controlled cutover
- M4: Release readiness

Start implementation with JBM-001 and JBM-002. M1 ends at a working, safe read-only manager. M2 does not make edits active in the legacy jukebox. M3 requires a companion feasibility gate and explicit live-migration approval.

Suggested labels are optional. Establish a consistent small set in GitHub rather than treating every descriptive label in these drafts as mandatory.

## Future ideas

Separate later issues can cover reader/room routing, tag replacement, tracks, localization, alternate providers or direct Spotify OAuth. None is required to close the initial milestone set unless explicitly added to scope.
