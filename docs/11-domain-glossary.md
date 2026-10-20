# Domain glossary

These terms summarize the [project brief](01-project-brief.md), [architecture](02-architecture.md), [proposed bridge contract](03-integration-contracts.md) and [state model](04-data-and-api.md). The [decision register](08-decisions-and-risks.md) remains authoritative for accepted versus provisional choices. Definitions do not imply that a feature is implemented: local draft assignments are implemented in #16; publication and playback states remain future work.

| Term | Meaning |
|---|---|
| Tag identity | Opaque ID owned by Home Assistant; preserve its exact value. |
| Tag name | HA-owned friendly name. A local rename intent is not a confirmed name until readback succeeds. |
| Assignment | Jukelet-owned association of a tag with music and playback preferences. HA may receive an execution snapshot, not a second editable master. |
| Metadata | Provider-sourced labels and artwork. Missing metadata does not invalidate an assignment or establish playability. |
| Saved | An assignment change retained by the app. It does not establish publication or playback. |
| Published | A snapshot sent to HA through the proposed publication process. Delivery or acknowledgment alone does not prove the expected revision is active. |
| Active | The snapshot revision HA actually reports as selected for execution. Verify the expected revision and checksum through readback; dispatch enablement is separate. |
| Playback-verified | Playback independently observed to be occurring. Acceptance of a request or completion of a script is insufficient. Missing telemetry means unknown. |
| Execution snapshot | Proposed immutable, versioned copy of assignments for HA execution, preserving the last known good state on failure. |
| Dispatcher | Proposed HA-side scan handler that resolves an assignment and invokes existing playback logic. Its activation requires controlled migration. |
| Read-only manager | Management behavior that observes HA without changing tags, automation, receiver state or playback. |

The distinctions between saved, published, active and playback-verified are required vocabulary; exact future transport and state-machine choices remain subject to the documented milestone gates.
