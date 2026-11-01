"""Opt-in read-only observation inside the task-owned disposable add-on container.

The coordinator streams this file to `docker exec -i --user 10001:10001 ... python -`
only after verifying the owned VM. There are no host, command, SQL or service inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import sqlite3
import stat
import urllib.request
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


def _read(path: Path, limit: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Probe input must be regular")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            value = stream.read(limit + 1)
        if len(value) > limit:
            raise ValueError("Probe input exceeds its fixed bound")
        return value
    finally:
        os.close(descriptor)


def _metadata(path: Path, *, directory: bool = False) -> dict[str, int]:
    value = path.lstat()
    if not (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode)):
        raise ValueError("Probe state must not use symlinks or special files")
    return {
        "uid": value.st_uid,
        "gid": value.st_gid,
        "mode": stat.S_IMODE(value.st_mode),
        "size": value.st_size,
        "mtime_ns": value.st_mtime_ns,
        "nlink": value.st_nlink,
    }


def _private_metadata(path: Path, *, directory: bool = False) -> dict[str, int]:
    if any(parent.is_symlink() for parent in (path, *path.absolute().parents)):
        raise ValueError("Probe private paths must not follow links")
    value = _metadata(path, directory=directory)
    if (
        (value["uid"], value["gid"]) != (os.geteuid(), os.getegid())
        or value["mode"] != (0o700 if directory else 0o600)
        or (not directory and value["nlink"] != 1)
    ):
        raise ValueError("Probe private state is unsafe")
    return value


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def _counter(value: Any, *, nullable: bool = False, flag: bool = False) -> int | None:
    if value is None and nullable:
        return None
    if type(value) is not int or not 0 <= value <= (1 if flag else 2**63 - 1):
        raise ValueError("Probe counter is not supported")
    return value


def _continuity(state: Path, publisher: str, secret: bytes, required: bool) -> dict[str, Any]:
    marker = state / ".supervisor-continuity"
    try:
        metadata = _private_metadata(marker)
    except FileNotFoundError:
        if required:
            raise ValueError("Required continuity witness is missing") from None
        return {"required": False, "present": False, "valid": False}
    value = _read(marker, 256)
    material = b"jukelet-supervisor-continuity-v1:" + publisher.encode("ascii")
    key = secret.rstrip(b"\r\n")
    if not 32 <= len(key) <= 128 or not key.isascii():
        raise ValueError("Continuity key is invalid")
    expected = material + b":" + hmac.digest(key, material, "sha256").hex().encode() + b"\n"
    if not hmac.compare_digest(value, expected):
        raise ValueError("Continuity witness is not bound to the selected state")
    return {
        "required": required,
        "present": True,
        "valid": True,
        "metadata": metadata,
        "sha256": hashlib.sha256(value).hexdigest(),
    }


def _fingerprint(path: Path, limit: int) -> dict[str, Any]:
    return {**_metadata(path), "sha256": hashlib.sha256(_read(path, limit)).hexdigest()}


def _options_observation(path: Path) -> dict[str, Any]:
    metadata = _metadata(path)
    try:
        contents = _read(path, 16384)
    except PermissionError:
        # Supervisor may keep this root:root 0600; only bootstrap needs its contents.
        return {
            **metadata,
            "readable": False,
            "sha256": None,
            "hash_evidence": "separate_fixture_operator_required",
        }
    return {**metadata, "readable": True, "sha256": hashlib.sha256(contents).hexdigest()}


def snapshot(
    source_commit: str,
    context_sha256: str,
    *,
    data: Path = Path("/data"),
    process: Path = Path("/proc/1/status"),
    build_info: Path = Path("/app/addon-build-info.json"),
    require_continuity: bool = False,
) -> dict[str, Any]:
    raw = _read(build_info, 256 * 1024)
    identity = json.loads(raw)
    files = {**identity["payload_files"], "build-info.json": hashlib.sha256(raw).hexdigest()}
    context = hashlib.sha256(
        (json.dumps(files, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode()
    ).hexdigest()
    if identity["source_commit"] != source_commit or context != context_sha256:
        raise ValueError("Probe candidate identity mismatch")
    fields = dict(
        line.split(":", 1) for line in _read(process, 16384).decode().splitlines() if ":" in line
    )
    runtime: dict[str, Any] = {
        name: [int(part) for part in fields[name].split()] for name in ("Uid", "Gid", "Groups")
    }
    runtime.update(
        {name: fields[name].strip() for name in ("CapEff", "CapPrm", "CapInh", "CapAmb")}
    )
    if (
        runtime["Uid"] != [10001] * 4
        or runtime["Gid"] != [10001] * 4
        or runtime["Groups"]
        or any(int(runtime[name], 16) for name in ("CapEff", "CapPrm", "CapInh", "CapAmb"))
    ):
        raise ValueError("Probe observed unsafe server privileges")
    state = data / "jukelet"
    report: dict[str, Any] = {
        "fixture": FIXTURE,
        "source_commit": source_commit,
        "source_tree": identity["source_tree"],
        "addon_version": identity["addon_version"],
        "context_sha256": context,
        "runtime": runtime,
        "directory": _private_metadata(state, directory=True),
        "database": _private_metadata(state / "jukelet.db"),
        "secret": {
            **_private_metadata(state / "auth-secret"),
            **_fingerprint(state / "auth-secret", 130),
        },
        "options": _options_observation(data / "options.json"),
    }
    database = (state / "jukelet.db").absolute().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(database, uri=True)) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        connection.row_factory = sqlite3.Row
        objects = connection.execute("SELECT type,name FROM sqlite_schema").fetchall()
        if {name for kind, name in objects if kind == "table"} != TABLES or any(
            kind not in {"table", "index"} for kind, _name in objects
        ):
            raise ValueError("Probe database objects are not supported")
        tables = {
            table: sorted(
                (dict(row) for row in connection.execute(f'SELECT * FROM "{table}"')),
                key=lambda row: json.dumps(row, sort_keys=True),
            )
            for table in sorted(TABLES)
        }
        if (
            tables["alembic_version"] != [{"version_num": "0004"}]
            or any(
                len(tables[name]) != 1 or tables[name][0]["id"] != 1
                for name in ("recovery_state", "publication_state", "assignment_revision")
            )
            or any(row["state"] not in JOB_STATES for row in tables["publication_job"])
        ):
            raise ValueError("Probe database state is not supported")
        publisher, guard = connection.execute(
            "SELECT publisher_id,reconciliation_required FROM recovery_state WHERE id=1"
        ).fetchone()
        if not isinstance(publisher, str) or str(UUID(publisher)) != publisher:
            raise ValueError("Probe publisher identity is not canonical")
        publication = connection.execute(
            "SELECT high_water,active_revision,established,automatic_enabled,healthy,"
            "guard_generation FROM publication_state WHERE id=1"
        ).fetchone()
        publication = {
            name: _counter(
                value,
                nullable=name == "active_revision",
                flag=name in {"established", "automatic_enabled", "healthy"},
            )
            for name, value in zip(
                (
                    "high_water",
                    "active_revision",
                    "established",
                    "automatic_enabled",
                    "healthy",
                    "guard_generation",
                ),
                publication,
                strict=True,
            )
        }
        if [tuple(row) for row in connection.execute("PRAGMA quick_check")] != [("ok",)]:
            raise ValueError("Probe integrity check failed")
        report.update(
            schema=connection.execute("SELECT version_num FROM alembic_version").fetchone()[0],
            integrity="ok",
            publisher_sha256=hashlib.sha256(publisher.encode()).hexdigest(),
            reconciliation_required=_counter(guard, flag=True),
            assignment_revision=_counter(
                connection.execute(
                    "SELECT revision FROM assignment_revision WHERE id=1"
                ).fetchone()[0]
            ),
            assignments=connection.execute("SELECT COUNT(*) FROM assignment").fetchone()[0],
            publication=publication,
            publication_jobs=connection.execute("SELECT COUNT(*) FROM publication_job").fetchone()[
                0
            ],
            tables={
                name: {"rows": len(value), "sha256": _digest(value)}
                for name, value in tables.items()
            },
            sessions=len(tables["owner_session"]),
            job_states={
                name: sum(row["state"] == name for row in tables["publication_job"])
                for name in JOB_STATES
            },
            continuity=_continuity(
                state, publisher, _read(state / "auth-secret", 130), require_continuity
            ),
        )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--context-sha256", required=True)
    parser.add_argument("--require-continuity", action="store_true")
    args = parser.parse_args()
    if args.fixture != FIXTURE:
        parser.error("only the explicitly owned disposable fixture is allowed")
    if not re.fullmatch(r"[a-f0-9]{40}", args.source_commit) or not re.fullmatch(
        r"[a-f0-9]{64}", args.context_sha256
    ):
        parser.error("exact candidate commit and context identities are required")
    try:
        if os.getuid() != 10001 or os.getgid() != 10001:
            raise ValueError("Probe itself must run as the application user")
        result = snapshot(
            args.source_commit, args.context_sha256, require_continuity=args.require_continuity
        )
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
            "http://127.0.0.1:8000/health/live", timeout=2
        ) as response:
            if response.status != 200 or response.read(128) != b'{"status":"ok"}':
                raise ValueError("Probe liveness failed")
        result.update(result="PASS", liveness=200, probe_uid=os.getuid(), probe_gid=os.getgid())
    except OSError, ValueError, KeyError, TypeError, sqlite3.Error:
        print('{"result":"FAIL","reason":"state observation failed"}')
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
