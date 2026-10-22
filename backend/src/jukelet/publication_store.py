"""SQLite publication state. All queued envelopes are immutable and durable."""

import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import Connection, Engine, text

from jukelet.publication_protocol import MAX_REVISION, canonical, checksum, payload


def now() -> str:
    return datetime.now(UTC).isoformat()


def desired(connection: Connection) -> tuple[int, dict[str, Any]]:
    version = int(connection.scalar(text("SELECT revision FROM assignment_revision")) or 0)
    rows = connection.execute(text("SELECT * FROM assignment WHERE deleted=0")).mappings()
    value = payload(
        [
            {
                "tag_id": row["ha_tag_id"],
                "media_type": row["media_type"],
                "spotify_uri": row["spotify_uri"],
                "enabled": bool(row["enabled"]),
                "shuffle": bool(row["shuffle"]),
                "playback_profile_id": row["playback_profile_id"],
            }
            for row in rows
        ]
    )
    return version, value


def preferences_conflict(value: dict[str, Any]) -> bool:
    # Existing HA script defaults are album shuffle off / playlist shuffle on.
    return any(
        row["enabled"] and row["shuffle"] != (row["media_type"] == "playlist")
        for row in value["mappings"]
    )


def record(connection: Connection) -> dict[str, Any]:
    return dict(
        connection.execute(
            text(
                "SELECT p.*,r.publisher_id,r.reconciliation_required FROM publication_state p "
                "JOIN recovery_state r ON p.id=r.id"
            )
        )
        .mappings()
        .one()
    )


def queue(
    connection: Connection,
    *,
    recovery: bool = False,
    base: tuple[int | None, str | None] | None = None,
) -> int:
    state = record(connection)
    version, value = desired(connection)
    digest = checksum(value)
    pending = (
        connection.execute(
            text(
                "SELECT * FROM publication_job WHERE state IN ('queued','in_flight','uncertain') "
                "ORDER BY revision DESC LIMIT 1"
            )
        )
        .mappings()
        .first()
    )
    if (
        not recovery
        and pending
        and pending["desired_version"] == version
        and pending["checksum"] == digest
    ):
        return int(pending["revision"])
    expected, base_checksum = (
        base
        if base is not None
        else (
            (pending["revision"], pending["checksum"])
            if pending
            else (state["active_revision"], state["active_checksum"])
        )
    )
    revision = int(max(state["high_water"], expected or 0)) + 1
    if revision > MAX_REVISION:
        raise ValueError("Publication revision limit reached")
    envelope = {
        "schema_version": 1,
        "publisher_id": state["publisher_id"],
        "revision": revision,
        "expected_active_revision": expected,
        "payload_checksum": digest,
        "payload": value,
    }
    connection.execute(
        text(
            "INSERT INTO publication_job VALUES "
            "(:revision,:version,:checksum,:envelope,:base,'queued',:recovery,:at,:guard)"
        ),
        {
            "revision": revision,
            "version": version,
            "checksum": digest,
            "envelope": canonical(envelope).decode(),
            "base": base_checksum,
            "recovery": recovery,
            "at": now(),
            "guard": state["guard_generation"],
        },
    )
    connection.execute(
        text("UPDATE publication_state SET high_water=:revision WHERE id=1"), {"revision": revision}
    )
    return revision


def auto_queue(connection: Connection) -> None:
    """Called in the existing save/import/delete transaction; never performs IO."""
    state = record(connection)
    if not state["automatic_enabled"] or not state["healthy"] or state["reconciliation_required"]:
        return
    try:
        _, value = desired(connection)
        if not value["mappings"]:
            error = "empty_confirmation_required"
        elif preferences_conflict(value):
            connection.execute(text("UPDATE publication_state SET automatic_enabled=0 WHERE id=1"))
            error = "shuffle_conflict"
        else:
            queue(connection)
            error = None
    except ValueError:
        error = "invalid_snapshot"
    connection.execute(
        text("UPDATE publication_state SET last_error=:error WHERE id=1"), {"error": error}
    )


class PublicationStore:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def reset_connection(self) -> None:
        with self.engine.begin() as connection:
            connection.execute(text("UPDATE publication_state SET healthy=0 WHERE id=1"))
            connection.execute(
                text("UPDATE publication_job SET state='uncertain' WHERE state='in_flight'")
            )

    def read(self) -> dict[str, Any]:
        with self.engine.connect() as connection:
            connection.exec_driver_sql("BEGIN")
            state = record(connection)
            try:
                version, value = desired(connection)
                digest, error = checksum(value), None
            except ValueError:
                version = int(
                    connection.scalar(text("SELECT revision FROM assignment_revision")) or 0
                )
                value, digest, error = {"mappings": []}, None, "invalid_snapshot"
            jobs = [
                dict(row)
                for row in connection.execute(
                    text(
                        "SELECT revision,desired_version,checksum,state,recovery,created_at FROM "
                        "publication_job ORDER BY revision DESC LIMIT 50"
                    )
                ).mappings()
            ]
            previous = (
                json.loads(state["active_payload"]) if state["active_payload"] else {"mappings": []}
            )
            current = {row["tag_id"]: row for row in value["mappings"]}
            removals = [
                row["tag_id"]
                for row in previous["mappings"]
                if row["enabled"]
                and (row["tag_id"] not in current or not current[row["tag_id"]]["enabled"])
            ]
            return {
                **state,
                "mappings": value["mappings"],
                "desired_version": version,
                "desired_checksum": digest,
                "mapping_count": len(value["mappings"]),
                "invalid": error,
                "shuffle_conflict": preferences_conflict(value),
                "pending_removals": removals,
                "jobs": jobs,
            }
