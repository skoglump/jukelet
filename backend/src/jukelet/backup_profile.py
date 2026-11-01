"""Structural validation of the supported raw schema0004 backup profile.

Compare SQLite structure and persisted values, never CREATE TABLE formatting.
The profile includes sessions and all retained history; it is not a logical export.
"""

import json
import math
import re
import sqlite3
from typing import Any
from uuid import UUID

from jukelet.ha.models import exact_tag_id
from jukelet.inventory import tag_key
from jukelet.publication_protocol import MAX_BYTES, MAX_REVISION, BridgeStatus, checksum


def _columns(*, text: str = "", integer: str = "", numeric: str = "") -> dict[str, str]:
    return {
        name: affinity
        for names, affinity in ((text, "TEXT"), (integer, "INTEGER"), (numeric, "NUMERIC"))
        for name in names.split()
    }


_COLUMNS = {
    "alembic_version": _columns(text="version_num"),
    "owner_session": _columns(text="token_hash csrf_token", integer="expires_at"),
    "assignment": _columns(
        text="tag_key ha_tag_id spotify_uri media_type playback_profile_id updated_at",
        integer="version",
        numeric="enabled shuffle deleted",
    ),
    "assignment_revision": _columns(integer="id revision"),
    "assignment_audit": _columns(text="action tag_key created_at", integer="id affected"),
    "recovery_state": _columns(
        text="publisher_id", integer="id", numeric="reconciliation_required"
    ),
    "publication_state": _columns(
        text="active_checksum active_payload last_error observed observed_at",
        integer="id high_water active_revision active_desired_version guard_generation",
        numeric="established automatic_enabled healthy",
    ),
    "publication_job": _columns(
        text="checksum envelope base_checksum state created_at",
        integer="revision desired_version guard_generation",
        numeric="recovery",
    ),
}
_PRIMARY = {
    "alembic_version": "version_num",
    "owner_session": "token_hash",
    "assignment": "tag_key",
    "assignment_revision": "id",
    "assignment_audit": "id",
    "recovery_state": "id",
    "publication_state": "id",
    "publication_job": "revision",
}
_NULLABLE = {
    "assignment_audit": {"tag_key"},
    # SQLite's INTEGER PRIMARY KEY reports notnull=0 for the raw0004 tables.
    "publication_state": {
        "id",
        "active_revision",
        "active_checksum",
        "active_payload",
        "active_desired_version",
        "last_error",
        "observed",
        "observed_at",
    },
    "publication_job": {"revision", "base_checksum"},
}
_INDEXES = {
    "alembic_version": {("pk", ("version_num",))},
    "owner_session": {("pk", ("token_hash",))},
    "assignment": {("pk", ("tag_key",)), ("u", ("ha_tag_id",))},
}


def _affinity(declaration: str) -> str:
    value = declaration.upper()
    if "INT" in value:
        return "INTEGER"
    if any(part in value for part in ("CHAR", "CLOB", "TEXT")):
        return "TEXT"
    if "BLOB" in value or not value:
        return "BLOB"
    if any(part in value for part in ("REAL", "FLOA", "DOUB")):
        return "REAL"
    return "NUMERIC"


def _require(condition: bool) -> None:
    if not condition:
        raise ValueError("Unsupported or ambiguous persisted state")


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        _require(key not in result)
        result[key] = value
    return result


def _float(value: str) -> float:
    result = float(value)
    _require(math.isfinite(result))
    return result


def _constant(value: str) -> None:
    raise ValueError("Unsupported JSON number")


def _json(value: str) -> dict[str, Any]:
    _require(len(value.encode("utf-8")) <= MAX_BYTES)
    result: Any = json.loads(
        value, object_pairs_hook=_object, parse_float=_float, parse_constant=_constant
    )
    _require(isinstance(result, dict))
    return dict(result)


def _digest(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def _payload(value: Any, digest: Any) -> None:
    _require(
        isinstance(value, dict)
        and set(value) == {"mappings"}
        and isinstance(value["mappings"], list)
        and _digest(digest)
    )
    _require(checksum(value) == digest)


def _rows(connection: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    cursor = connection.execute(f'SELECT * FROM "{table}"')
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row, strict=True)) for row in cursor]


def _values(connection: sqlite3.Connection, publisher: str) -> None:
    # SQLite permits dynamically typed values even in INTEGER/BOOLEAN columns.
    for table, columns in _COLUMNS.items():
        for name, affinity in columns.items():
            allowed = "'integer'" if affinity in {"INTEGER", "NUMERIC"} else "'text'"
            if name in _NULLABLE.get(table, set()):
                allowed += ",'null'"
            _require(
                connection.execute(
                    f'SELECT 1 FROM "{table}" WHERE typeof("{name}") NOT IN ({allowed}) LIMIT 1'
                ).fetchone()
                is None
            )
            if affinity == "NUMERIC":
                _require(
                    connection.execute(
                        f'SELECT 1 FROM "{table}" WHERE "{name}" NOT IN (0,1) LIMIT 1'
                    ).fetchone()
                    is None
                )
    revision = _rows(connection, "assignment_revision")[0]["revision"]
    state = _rows(connection, "publication_state")[0]
    _require(revision >= 0 and 0 <= state["high_water"] <= MAX_REVISION)
    _require(state["guard_generation"] >= 0)
    assignments = _rows(connection, "assignment")
    _require(len({row["ha_tag_id"] for row in assignments}) == len(assignments))
    for row in assignments:
        exact_tag_id(row["ha_tag_id"])
        _require(row["tag_key"] == tag_key(row["ha_tag_id"]) and row["version"] >= 1)
        _require(row["media_type"] in {"album", "playlist"})
        _require(
            re.fullmatch("spotify:" + row["media_type"] + r":[A-Za-z0-9]{22}", row["spotify_uri"])
            is not None
        )
        _require(row["playback_profile_id"] == "default")
    for row in _rows(connection, "assignment_audit"):
        _require(row["id"] >= 1 and row["affected"] >= 0)
    jobs = _rows(connection, "publication_job")
    for job in jobs:
        _require(1 <= job["revision"] <= state["high_water"])
        _require(0 <= job["desired_version"] <= revision)
        _require(0 <= job["guard_generation"] <= state["guard_generation"])
        _require(job["state"] in {"queued", "in_flight", "uncertain", "verified", "fenced"})
        envelope = _json(job["envelope"])
        _require(
            set(envelope)
            == {
                "schema_version",
                "publisher_id",
                "revision",
                "expected_active_revision",
                "payload_checksum",
                "payload",
            }
        )
        _require(type(envelope["schema_version"]) is int and envelope["schema_version"] == 1)
        _require(type(envelope["revision"]) is int and envelope["revision"] == job["revision"])
        _require(envelope["publisher_id"] == publisher)
        _require(envelope["payload_checksum"] == job["checksum"])
        _payload(envelope["payload"], job["checksum"])
        base = envelope["expected_active_revision"]
        if base is None:
            _require(job["base_checksum"] is None)
        else:
            _require(type(base) is int and 1 <= base < job["revision"])
            _require(_digest(job["base_checksum"]))
    active = [
        state[name]
        for name in (
            "active_revision",
            "active_checksum",
            "active_payload",
            "active_desired_version",
        )
    ]
    if state["active_revision"] is None:
        _require(all(value is None for value in active) and state["established"] == 0)
    else:
        _require(all(value is not None for value in active) and state["established"] == 1)
        _require(1 <= state["active_revision"] <= state["high_water"])
        _require(0 <= state["active_desired_version"] <= revision)
        _payload(_json(state["active_payload"]), state["active_checksum"])
        _require(
            any(
                job["revision"] == state["active_revision"]
                and job["checksum"] == state["active_checksum"]
                and job["desired_version"] == state["active_desired_version"]
                for job in jobs
            )
        )
    _require((state["observed"] is None) == (state["observed_at"] is None))
    if state["observed"] is not None:
        BridgeStatus.model_validate(_json(state["observed"]))


def validate_profile(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA trusted_schema=OFF")
    if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("Database integrity check failed")
    objects = connection.execute("SELECT type,name FROM sqlite_schema").fetchall()
    if any(kind not in {"table", "index"} for kind, _name in objects):
        raise ValueError("Unsupported database schema objects")
    tables = {name for kind, name in objects if kind == "table" and not name.startswith("sqlite_")}
    if tables != _COLUMNS.keys():
        raise ValueError("Unsupported database tables")
    for table, expected in _COLUMNS.items():
        indexes: set[tuple[str, tuple[str, ...]]] = set()
        for _seq, name, unique, origin, partial in connection.execute(
            f'PRAGMA index_list("{table}")'
        ):
            _require(unique == 1 and origin in {"pk", "u"} and partial == 0)
            quoted = name.replace('"', '""')
            keys = connection.execute(f'PRAGMA index_xinfo("{quoted}")').fetchall()
            _require(
                all(
                    cid >= 0 and collation == "BINARY"
                    for _n, cid, _name, _desc, collation, key in keys
                    if key
                )
            )
            indexes.add(
                (origin, tuple(column for _n, _cid, column, _desc, _coll, key in keys if key))
            )
        if indexes != _INDEXES.get(table, set()):
            raise ValueError("Unsupported database indexes")
        if connection.execute(f'PRAGMA foreign_key_list("{table}")').fetchall():
            raise ValueError("Unsupported database foreign keys")
        columns = connection.execute(f'PRAGMA table_xinfo("{table}")').fetchall()
        actual = {name: _affinity(kind) for _cid, name, kind, *_rest in columns}
        if actual != expected or len(columns) != len(expected):
            raise ValueError("Unsupported database columns")
        for _cid, name, _kind, notnull, _default, primary, hidden in columns:
            if (
                hidden
                or primary != int(name == _PRIMARY[table])
                or notnull != int(name not in _NULLABLE.get(table, set()))
            ):
                raise ValueError("Unsupported database column constraints")
    if connection.execute("SELECT version_num FROM alembic_version").fetchall() != [("0004",)]:
        raise ValueError("Backup/recovery requires the current database schema")
    identities = connection.execute("SELECT id,publisher_id FROM recovery_state").fetchall()
    if len(identities) != 1 or identities[0][0] != 1 or not isinstance(identities[0][1], str):
        raise ValueError("Missing or ambiguous publisher identity")
    UUID(identities[0][1])
    for table in ("assignment_revision", "publication_state"):
        if connection.execute(f"SELECT id FROM {table}").fetchall() != [(1,)]:
            raise ValueError("Missing or ambiguous database singleton")
    try:
        _require(str(UUID(identities[0][1])) == identities[0][1])
        _values(connection, identities[0][1])
    except ValueError, TypeError, KeyError, OverflowError, RecursionError:
        raise ValueError("Unsupported or ambiguous persisted state") from None
