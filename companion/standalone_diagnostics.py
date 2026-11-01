"""Standard-library-only finite scan diagnostics; no runtime is started on import."""

import time
from typing import Any

ALBUM = " Synthetic standalone:Å/😀 "
PLAYLIST = "Synthetic e\u0301 playlist"


def scan_diagnostic(
    before: dict[str, Any], after: dict[str, Any], trace: list[tuple[str, int, int, int, int]]
) -> dict[str, Any]:
    """Reason-only projection of already observed state; never requests more state."""
    reasons = {
        "ignored_disabled",
        "ignored_busy",
        "rejected_event",
        "shutting_down",
        "snapshot_unavailable",
        "snapshot_invalid",
        "preference_conflict",
        "execution_uncertain",
        "profile_unconfigured",
        "script_unavailable_or_running",
        "ignored_duplicate",
        "rejected_mapping",
        "invocation_requested",
        "execution_result",
        "execution_cancelled",
        "execution_error",
    }

    def project(value: dict[str, Any]) -> dict[str, Any]:
        dispatcher = value["dispatcher"]
        assert all(
            type(dispatcher[key]) is bool for key in ("busy", "execution_uncertain", "ready")
        )
        rows = dispatcher["diagnostics"]
        assert type(rows) is list and len(rows) <= 32
        order, tags = [], []
        for row in rows:
            reason = row.get("reason")
            order.append(reason if type(reason) is str and reason in reasons else "unknown_reason")
            tag = row.get("tag_id")
            tags.append(
                "missing"
                if "tag_id" not in row
                else "album"
                if tag == ALBUM
                else "playlist"
                if tag == PLAYLIST
                else "other"
            )
        readiness = dispatcher["readiness_error"]
        return {
            **{key: dispatcher[key] for key in ("busy", "execution_uncertain", "ready")},
            "readiness_error": readiness
            if readiness is None or type(readiness) is str and readiness in reasons
            else "unknown_reason",
            "reason_order": order,
            "reason_tags": tags,
            "unknown_reason_count": order.count("unknown_reason"),
        }

    assert 0 < len(trace) <= 7
    origin = trace[0][1]
    timeline = []
    for label, begin, end, events, captures in trace:
        assert label in {
            "initial_pair",
            "duplicate_album",
            "unknown",
            "unassigned",
            "disabled",
            "excluded_track",
            "playlist",
        }
        assert all(type(value) is int for value in (begin, end, events, captures))
        assert origin <= begin <= end <= origin + 600_000_000_000
        assert 0 <= events <= 2 and 0 <= captures <= 1000
        timeline.append(
            {
                "stage": label,
                "started_ms": (begin - origin) // 1_000_000,
                "elapsed_ms": (end - begin) // 1_000_000,
                "events": events,
                "captures": captures,
            }
        )
    initial, final = project(before), project(after)
    return {
        "event": "standalone_scan_diagnostic",
        "schema_version": 1,
        "before": initial,
        "after": final,
        "trace": timeline,
        "missing_required_reasons": sorted(
            {"ignored_busy", "ignored_duplicate", "rejected_mapping"} - set(final["reason_order"])
        ),
    }


def trace_scan(
    runtime: Any,
    stage: str,
    events: list[dict[str, Any]],
    trace: list[tuple[str, int, int, int, int]],
) -> list[dict[str, Any]]:
    """Only time the unchanged call; no extra state reads, waits or per-scan output."""
    begin = time.monotonic_ns()
    result: dict[str, list[dict[str, Any]]] = runtime.local("scan", events=events)
    end = time.monotonic_ns()
    trace.append((stage, begin, end, len(events), len(result["captures"])))
    return result["captures"]
