# Domain clarification

Read the [glossary](../../../../docs/11-domain-glossary.md), [architecture](../../../../docs/02-architecture.md), and relevant entries in the [decision register](../../../../docs/08-decisions-and-risks.md) when terms or ownership affect a decision. Check the implementation before describing a proposal as existing behavior.

Use concrete scenarios to resolve overloaded terms: a local save while HA is unavailable, a publication with a lost acknowledgment, or metadata failure for a retained assignment. Ask which state or owner the user means when it changes the current contract. Preserve opaque IDs exactly; keep tag names, assignment labels and provider metadata distinct.

Keep accepted requirements, provisional designs and demonstrated capabilities separate. Future bridge design must not block unrelated read-only work. Do not silently settle the deferred M3 choices in the register.

During a standalone interview, propose terminology and decision updates in the conversation. During an authorized implementation, update the glossary for agreed vocabulary and the existing decision register for material decisions; keep affected requirements consistent. Do not create a parallel ADR system by default. A glossary explains terms, not implementation mechanics or new product promises.
