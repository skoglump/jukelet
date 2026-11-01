"""Opt-in synthetic database-transfer fixture; never use household data.

The coordinator runs this script in the owned disposable RC3/target environments.
It neither controls containers nor contacts Home Assistant, Spotify or a network.
Running recovery accounts for stored observations only. Corroborate its derived
floor against independent fresh HA readback; this probe is not native restore proof.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import sqlite3
import stat
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any
from uuid import UUID

FIXTURE = "jukelet-m5-disposable-kvm"
TABLES = {
    "alembic_version",
    "owner_session",
    "assignment",
    "assignment_revision",
    "assignment_audit",
    "recovery_state",
    "publication_state",
    "publication_job",
}
JOB_STATES = ("queued", "in_flight", "uncertain", "verified", "fenced")


def _encoded(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False
    ).encode()


def _digest(value: object) -> str:
    return hashlib.sha256(_encoded(value)).hexdigest()


def _counter(value: Any, *, nullable: bool = False) -> int | None:
    if value is None and nullable:
        return None
    if type(value) is not int or not 0 <= value <= 2**63 - 1:
        raise ValueError("Fixture counter is not supported")
    return value


def _private_parent(path: Path) -> None:
    if any(parent.is_symlink() for parent in (path, *path.absolute().parents)):
        raise ValueError("Fixture paths must not use links")
    metadata = path.lstat()
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise ValueError("Fixture parent must be private and owned by the operator")


def _snapshot(path: Path) -> dict[str, list[dict[str, Any]]]:
    _private_parent(path.parent)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            raise ValueError("Fixture database must be a private regular file")
        with closing(
            sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True)
        ) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only=ON")
            connection.execute("BEGIN")
            objects = connection.execute("SELECT type,name FROM sqlite_schema").fetchall()
            tables = {name for kind, name in objects if kind == "table"}
            if (
                tables != TABLES
                or any(kind not in {"table", "index"} for kind, _name in objects)
                or connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
            ):
                raise ValueError("Fixture database is not supported")
            state = {
                table: sorted(
                    (dict(row) for row in connection.execute(f'SELECT * FROM "{table}"')),
                    key=_encoded,
                )
                for table in sorted(TABLES)
            }
            if state["alembic_version"] != [{"version_num": "0004"}]:
                raise ValueError("Fixture database schema mismatch")
            if any(
                len(state[name]) != 1 or state[name][0]["id"] != 1
                for name in ("assignment_revision", "recovery_state", "publication_state")
            ):
                raise ValueError("Fixture database singleton mismatch")
            publisher = state["recovery_state"][0]["publisher_id"]
            if not isinstance(publisher, str) or str(UUID(publisher)) != publisher:
                raise ValueError("Fixture database publisher mismatch")
            return state
    finally:
        os.close(descriptor)


def _report(state: dict[str, list[dict[str, Any]]]) -> dict[str, object]:
    recovery, publication = state["recovery_state"][0], state["publication_state"][0]
    if any(job["state"] not in JOB_STATES for job in state["publication_job"]):
        raise ValueError("Fixture job state is not supported")
    if any(
        type(value) is not int or value not in (0, 1)
        for value in (
            recovery["reconciliation_required"],
            publication["automatic_enabled"],
            publication["healthy"],
        )
    ):
        raise ValueError("Fixture guard state is not supported")
    return {
        "fixture": FIXTURE,
        "result": "PASS",
        "schema": "0004",
        "integrity_ok": True,
        "state_sha256": _digest(state),
        "tables": {
            table: {"rows": len(rows), "sha256": _digest(rows)}
            for table, rows in sorted(state.items())
        },
        "publisher_sha256": hashlib.sha256(recovery["publisher_id"].encode()).hexdigest(),
        "publication": {
            name: _counter(publication[name], nullable=name == "active_revision")
            for name in ("high_water", "active_revision", "guard_generation")
        },
        "assignment_revision": _counter(state["assignment_revision"][0]["revision"]),
        "sessions": len(state["owner_session"]),
        "job_states": {
            name: sum(job["state"] == name for job in state["publication_job"])
            for name in JOB_STATES
        },
        "guards": {
            "reconciliation_required": bool(recovery["reconciliation_required"]),
            "automatic_disabled": publication["automatic_enabled"] == 0,
            "healthy_disabled": publication["healthy"] == 0,
            "sessions_empty": not state["owner_session"],
            "no_outstanding_jobs": all(
                job["state"] not in {"queued", "in_flight", "uncertain"}
                for job in state["publication_job"]
            ),
        },
    }


def _populate(path: Path) -> None:
    # These are existing public-RC3 modules, not feature-branch-only helpers.
    from sqlalchemy import text

    from jukelet.assignments import AssignmentInput, AssignmentStore
    from jukelet.inventory import tag_key
    from jukelet.publication_store import queue
    from jukelet.storage import migrate, open_database

    engine = open_database(path)
    try:
        migrate(engine)
        assignments = AssignmentStore(engine)
        exact = "  synthetic/Å/e\u0301 日本語  "

        def save(tag: str, version: int = 0, *, shuffle: bool = False) -> None:
            assignments.put(
                AssignmentInput(
                    ha_tag_id=tag,
                    input="spotify:album:0123456789ABCDEFGHIJKL",
                    media_type="album",
                    enabled=True,
                    shuffle=shuffle,
                    playback_profile_id="default",
                    expected_version=version,
                )
            )

        save(exact)
        save("synthetic-tombstone")
        assignments.delete(tag_key("synthetic-tombstone"), 1)
        with engine.begin() as connection:
            connection.execute(text("UPDATE publication_state SET guard_generation=7"))
        for version, state in enumerate(
            ("verified", "fenced", "queued", "in_flight", "uncertain"), 1
        ):
            save(exact, version, shuffle=bool(version % 2))
            with engine.begin() as connection:
                revision = queue(connection)
                job = (
                    connection.execute(
                        text("SELECT * FROM publication_job WHERE revision=:n"), {"n": revision}
                    )
                    .mappings()
                    .one()
                )
                connection.execute(
                    text(
                        "UPDATE publication_job SET state=:state,recovery=:recovery "
                        "WHERE revision=:n"
                    ),
                    {"state": state, "recovery": state == "fenced", "n": revision},
                )
                if state == "verified":
                    connection.execute(
                        text(
                            "UPDATE publication_state SET active_revision=:n,"
                            "active_checksum=:checksum,active_payload=:payload,"
                            "active_desired_version=:version,established=1"
                        ),
                        {
                            "n": revision,
                            "checksum": job["checksum"],
                            "payload": json.dumps(json.loads(job["envelope"])["payload"], indent=2),
                            "version": job["desired_version"],
                        },
                    )
        with engine.begin() as connection:
            observed = {
                "protocol_version": 1,
                "schema_version": 1,
                "publisher_id": connection.scalar(text("SELECT publisher_id FROM recovery_state")),
                "active_revision": 1,
                "active_checksum": connection.scalar(
                    text("SELECT active_checksum FROM publication_state")
                ),
                "mapping_count": 1,
                "persistence": "healthy",
                "last_error": None,
                "dispatch_enabled": False,
                "supported_media": ["album", "playlist"],
                "supported_preferences": ["enabled", "shuffle"],
                "playback_profiles": ["default"],
            }
            connection.execute(
                text(
                    "UPDATE publication_state SET automatic_enabled=1,healthy=1,"
                    "last_error='synthetic-retained-error',observed=:observed,observed_at='synthetic-time'"
                ),
                {"observed": json.dumps(observed)},
            )
            connection.execute(
                text(
                    "INSERT INTO owner_session VALUES "
                    "('synthetic-old-session','SYNTHETIC_PRIVATE_CSRF',9999999999)"
                )
            )
    finally:
        engine.dispose()


def seed(database: Path) -> dict[str, object]:
    _private_parent(database.parent)
    if database.exists() or database.is_symlink():
        raise ValueError("Fixture database already exists")
    with tempfile.TemporaryDirectory(
        prefix=".jukelet-transfer-fixture-", dir=database.parent
    ) as private:
        staged = Path(private) / "fixture.db"
        descriptor = os.open(staged, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        _populate(staged)
        # Report after publication/cleanup so the selected fixture has a single link.
        os.link(staged, database, follow_symlinks=False)
    return _report(_snapshot(database))


def _account_runtime(
    original: dict[str, list[dict[str, Any]]],
    expected: dict[str, list[dict[str, Any]]],
    actual: dict[str, list[dict[str, Any]]],
) -> dict[str, object]:
    # This public-RC3 protocol model is available in both images. No current-only
    # recovery module is imported, and this probe never changes application state.
    from jukelet.publication_protocol import BridgeStatus

    publication = actual["publication_state"][0]
    observed = publication["observed"]
    if (observed is None) != (publication["observed_at"] is None):
        raise ValueError("Runtime observation is incomplete")
    if any(
        publication[name] is not None
        and (not isinstance(publication[name], str) or len(publication[name]) > limit)
        for name, limit in (("observed", 65536), ("observed_at", 128), ("last_error", 128))
    ):
        raise ValueError("Runtime observation exceeds its supported shape")
    floor = _counter(expected["publication_state"][0]["high_water"])
    assert floor is not None
    if observed is not None:

        def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            value: dict[str, Any] = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("Ambiguous runtime observation")
                value[key] = item
            return value

        status = BridgeStatus.model_validate(json.loads(observed, object_pairs_hook=unique))
        if status.publisher_id == expected["recovery_state"][0]["publisher_id"]:
            floor = max(floor, status.active_revision or 0)
    fields = ("observed", "observed_at", "last_error")
    changes = {
        name: {
            "changed": expected["publication_state"][0][name] != publication[name],
            "before_sha256": _digest(expected["publication_state"][0][name]),
            "after_sha256": _digest(publication[name]),
        }
        for name in fields
    }
    for name in fields:
        expected["publication_state"][0][name] = publication[name]
    expected["publication_state"][0]["high_water"] = floor
    old_tokens = {row["token_hash"] for row in original["owner_session"]}
    fresh = actual["owner_session"]
    old_absent = old_tokens.isdisjoint(row["token_hash"] for row in fresh)
    if any(
        not isinstance(row["token_hash"], str)
        or len(row["token_hash"]) != 64
        or any(part not in "0123456789abcdef" for part in row["token_hash"])
        or not isinstance(row["csrf_token"], str)
        or re.fullmatch(r"[A-Za-z0-9_-]{43}", row["csrf_token"]) is None
        or _counter(row["expires_at"]) is None
        for row in fresh
    ):
        raise ValueError("Runtime session shape is not supported")
    if old_absent:
        expected["owner_session"] = copy.deepcopy(fresh)
    return {
        "stored_observation_only": True,
        "independent_ha_verified": False,
        "old_sessions_absent": old_absent,
        "fresh_sessions": len(fresh) if old_absent else 0,
        "publication_fields": changes,
        "observed_floor": floor,
    }


def compare(
    baseline: Path, current: Path, *, recovered: bool, running: bool = False
) -> dict[str, object]:
    if os.path.samestat(baseline.stat(), current.stat()):
        raise ValueError("Source and destination must be distinct files")
    original, actual = _snapshot(baseline), _snapshot(current)
    _report(original)
    observed_report = _report(actual)
    if running and not recovered:
        raise ValueError("Runtime accounting requires guarded recovery")
    expected = copy.deepcopy(original)
    if recovered:
        expected["owner_session"] = []
        expected["recovery_state"][0]["reconciliation_required"] = 1
        publication = expected["publication_state"][0]
        publication["automatic_enabled"] = publication["healthy"] = 0
        publication["guard_generation"] += 1
        for job in expected["publication_job"]:
            if job["state"] in {"queued", "in_flight", "uncertain"}:
                job["state"] = "fenced"
        expected["publication_job"].sort(key=_encoded)
    runtime = _account_runtime(original, expected, actual) if running else None
    matches = {table: expected[table] == actual[table] for table in sorted(TABLES)}
    return {
        "fixture": FIXTURE,
        "result": "PASS" if all(matches.values()) else "FAIL",
        "mode": "recovered-running" if running else "recovered" if recovered else "backup",
        "matches": matches,
        "baseline_sha256": _digest(original),
        "expected_sha256": _digest(expected),
        "observed": observed_report,
        "runtime": runtime,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", required=True)
    commands = parser.add_subparsers(dest="operation", required=True)
    create = commands.add_parser("seed")
    create.add_argument("database", type=Path)
    observe = commands.add_parser("observe")
    observe.add_argument("database", type=Path)
    comparison = commands.add_parser("compare")
    comparison.add_argument(
        "--mode", required=True, choices=("backup", "recovered", "recovered-running")
    )
    comparison.add_argument("baseline", type=Path)
    comparison.add_argument("current", type=Path)
    args = parser.parse_args()
    try:
        if args.fixture != FIXTURE:
            raise ValueError("The owned disposable fixture must be explicit")
        if args.operation == "seed":
            result = seed(args.database)
        elif args.operation == "observe":
            result = _report(_snapshot(args.database))
        else:
            result = compare(
                args.baseline,
                args.current,
                recovered=args.mode != "backup",
                running=args.mode == "recovered-running",
            )
    except OSError, ValueError, sqlite3.Error, KeyError, IndexError, TypeError:
        print('{"result":"FAIL","reason":"synthetic database fixture failed"}')
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0 if result["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
