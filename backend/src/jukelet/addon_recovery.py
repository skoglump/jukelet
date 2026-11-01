"""Private continuity for supported native Supervisor backups, before runtime IO.

The supported cold backup excludes the witness. Native restore replaces private
data; ordinary restart/update/backup retains it. This is not a general rollback
detector: manual database replacement or loss/rollback of every copy requires the
explicit offline guarded recovery procedure.
"""

import hmac
import os
import secrets
import sqlite3
from contextlib import closing
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID

from jukelet.addon import DATABASE_NAME, MARKER_NAME, SECRET_NAME, STATE_DIRECTORY, _check_private
from jukelet.backup import _directory, guard_recovery
from jukelet.backup_profile import validate_profile
from jukelet.config import Settings

_PREFIX = b"jukelet-supervisor-continuity-v1:"
_LIMIT = 256


def _identity(metadata: os.stat_result) -> tuple[int, int]:
    return metadata.st_dev, metadata.st_ino


def _file(directory: int, name: str) -> int:
    descriptor = os.open(
        name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory
    )
    try:
        metadata = os.fstat(descriptor)
        _check_private(metadata, (os.geteuid(), os.getegid()))
        if metadata.st_nlink != 1:
            raise ValueError("Private continuity state must not have hard links")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _read(directory: int, name: str, limit: int) -> bytes:
    descriptor = _file(directory, name)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            value = stream.read(limit + 1)
        if len(value) > limit:
            raise ValueError("Private continuity state exceeds its bound")
        return value
    finally:
        os.close(descriptor)


def _witness(publisher: str, secret: bytes) -> bytes:
    material = _PREFIX + publisher.encode("ascii")
    return material + b":" + hmac.digest(secret, material, "sha256").hex().encode() + b"\n"


def _publisher(value: bytes, secret: bytes) -> str:
    try:
        prefix, publisher, _digest = value.rstrip(b"\n").rsplit(b":", 2)
        identity = str(UUID(publisher.decode("ascii")))
        if prefix + b":" != _PREFIX or not hmac.compare_digest(value, _witness(identity, secret)):
            raise ValueError
        return identity
    except ValueError, UnicodeError:
        raise ValueError("Invalid private continuity witness") from None


def _check_state(directory: int, secret: bytes) -> tuple[tuple[int, int] | None, bytes | None]:
    _check_private(os.fstat(directory), (os.geteuid(), os.getegid()), directory=True)
    if not hmac.compare_digest(_read(directory, SECRET_NAME, 130).rstrip(b"\r\n"), secret):
        raise ValueError("Private continuity key changed")
    database: tuple[int, int] | None = None
    sidecar = False
    for name in (DATABASE_NAME, *(DATABASE_NAME + part for part in ("-wal", "-shm", "-journal"))):
        try:
            descriptor = _file(directory, name)
        except FileNotFoundError:
            continue
        try:
            if name == DATABASE_NAME:
                database = _identity(os.fstat(descriptor))
            else:
                sidecar = True
        finally:
            os.close(descriptor)
    try:
        marker = _read(directory, MARKER_NAME, _LIMIT)
    except FileNotFoundError:
        marker = None
    if database is None and (marker is not None or sidecar):
        raise ValueError("Private continuity database is missing")
    return database, marker


def _selected(directory: int) -> str:
    return (Path(f"/proc/self/fd/{directory}") / DATABASE_NAME).as_uri() + "?mode=rw"


def _sync_state(directory: int) -> None:
    for name in (DATABASE_NAME, *(DATABASE_NAME + part for part in ("-wal", "-journal"))):
        try:
            descriptor = _file(directory, name)
        except FileNotFoundError:
            if name == DATABASE_NAME:
                raise
            continue
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    os.fsync(directory)


def _install(directory: int, value: bytes) -> None:
    temporary = MARKER_NAME + "-" + secrets.token_hex(16)
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=directory,
    )
    try:
        os.fchmod(descriptor, 0o600)
        offset = 0
        while offset < len(value):
            written = os.write(descriptor, value[offset:])
            if written <= 0:
                raise OSError("Unable to write private continuity witness")
            offset += written
        os.fsync(descriptor)
        os.link(
            temporary,
            MARKER_NAME,
            src_dir_fd=directory,
            dst_dir_fd=directory,
            follow_symlinks=False,
        )
    finally:
        os.close(descriptor)
        os.unlink(temporary, dir_fd=directory)
    os.fsync(directory)


@dataclass(frozen=True)
class Continuity:
    path: Path
    secret: bytes = field(repr=False)
    directory_identity: tuple[int, int]
    database_identity: tuple[int, int] | None
    marker: bytes | None

    def complete(self) -> None:
        """Commit recovery and its persistence before creating any continuity authority."""
        with _directory(self.path.parent) as directory:
            database, marker = _check_state(directory, self.secret)
            if (
                _identity(os.fstat(directory)) != self.directory_identity
                or database is None
                or (self.database_identity is not None and database != self.database_identity)
                or marker != self.marker
            ):
                raise ValueError("Private continuity state changed during startup")
            with closing(sqlite3.connect(_selected(directory), uri=True)) as connection:
                connection.execute("PRAGMA synchronous=FULL")
                connection.execute("BEGIN IMMEDIATE")
                validate_profile(connection)
                publisher = connection.execute(
                    "SELECT publisher_id FROM recovery_state"
                ).fetchone()[0]
                if marker is not None:
                    if _publisher(marker, self.secret) != publisher:
                        raise ValueError("Private continuity publisher changed")
                    return
                if self.database_identity is not None:
                    guard_recovery(connection)
                connection.commit()
            _sync_state(directory)
            completed_database, completed_marker = _check_state(directory, self.secret)
            if completed_database != database or completed_marker is not None:
                raise ValueError("Private continuity state changed before witness publication")
            _install(directory, _witness(publisher, self.secret))


def preflight(settings: Settings) -> Continuity:
    """Check before migration can create or initialize a missing database."""
    path = settings.database_path.absolute()
    if path.name != DATABASE_NAME or path.parent.name != STATE_DIRECTORY or ".." in path.parts:
        raise ValueError("Invalid private continuity database path")
    with _directory(path.parent) as directory:
        database, marker = _check_state(directory, settings.auth_secret)
        if database is not None:
            with closing(sqlite3.connect(_selected(directory), uri=True)) as connection:
                connection.execute("BEGIN")
                validate_profile(connection)
                publisher = connection.execute(
                    "SELECT publisher_id FROM recovery_state"
                ).fetchone()[0]
            if marker is not None and _publisher(marker, settings.auth_secret) != publisher:
                raise ValueError("Private continuity publisher changed")
        return Continuity(
            path, settings.auth_secret, _identity(os.fstat(directory)), database, marker
        )
