"""Opt-in read-only observation inside the task-owned disposable add-on container.

The coordinator streams this file to `docker exec -i --user 10001:10001 ... python -`
only after verifying the owned VM. There are no host, command, SQL or service inputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import stat
import urllib.request
from contextlib import closing
from pathlib import Path
from typing import Any

FIXTURE = "jukelet-m5-disposable-kvm"


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
        "directory": _metadata(state, directory=True),
        "database": _metadata(state / "jukelet.db"),
        "secret": _fingerprint(state / "auth-secret", 130),
        "options": _options_observation(data / "options.json"),
    }
    database = (state / "jukelet.db").absolute().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(database, uri=True)) as connection:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        publisher, guard = connection.execute(
            "SELECT publisher_id,reconciliation_required FROM recovery_state WHERE id=1"
        ).fetchone()
        publication = connection.execute(
            "SELECT high_water,active_revision,established,automatic_enabled,healthy,"
            "guard_generation FROM publication_state WHERE id=1"
        ).fetchone()
        report.update(
            schema=connection.execute("SELECT version_num FROM alembic_version").fetchone()[0],
            integrity=connection.execute("PRAGMA quick_check").fetchone()[0],
            publisher_sha256=hashlib.sha256(publisher.encode()).hexdigest(),
            reconciliation_required=guard,
            assignment_revision=connection.execute(
                "SELECT revision FROM assignment_revision WHERE id=1"
            ).fetchone()[0],
            assignments=connection.execute("SELECT COUNT(*) FROM assignment").fetchone()[0],
            publication=dict(
                zip(
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
            ),
            publication_jobs=connection.execute("SELECT COUNT(*) FROM publication_job").fetchone()[
                0
            ],
        )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--context-sha256", required=True)
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
        result = snapshot(args.source_commit, args.context_sha256)
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
