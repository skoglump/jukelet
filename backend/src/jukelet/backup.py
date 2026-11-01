"""Consistent SQLite backup; recovery creates a new, guarded offline database.

Run `python -m jukelet.backup {backup,recover} SOURCE NEW_DESTINATION`.
Never replace a running application's database. See docs/10-development.md.
"""

import argparse
import os
import sqlite3
import stat
import tempfile
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path

from jukelet.backup_profile import validate_profile


class OutputPersistenceUncertain(OSError):
    """A complete output was installed, but final filesystem persistence is uncertain."""


def _complete_database(source: Path, destination: Path, *, recover: bool) -> None:
    # This pathname belongs to our private staging directory, never to the application.
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
        with closing(sqlite3.connect(destination)) as copied:
            original.backup(copied, pages=128, sleep=0.05)
            validate_profile(copied)
            if recover:
                if copied.execute("SELECT guard_generation FROM publication_state").fetchone() == (
                    2**63 - 1,
                ):
                    raise ValueError("Recovery guard generation exhausted")
                # Retained identity/history require reviewed HA reconciliation before publication.
                copied.execute("UPDATE recovery_state SET reconciliation_required=1 WHERE id=1")
                copied.execute(
                    "UPDATE publication_state SET "
                    "automatic_enabled=0,healthy=0,guard_generation=guard_generation+1 WHERE id=1"
                )
                copied.execute(
                    "UPDATE publication_job SET state='fenced' WHERE state IN "
                    "('queued','in_flight','uncertain')"
                )
                copied.execute("DELETE FROM owner_session")
            copied.commit()
            copied.execute("PRAGMA journal_mode=DELETE")


def _check_directory(metadata: os.stat_result, *, final: bool) -> None:
    # A sandbox/user namespace may expose the system root's owner as an unmapped UID.
    system_owner = os.stat("/").st_uid
    trusted = metadata.st_uid in {0, system_owner, os.geteuid()}
    writable = bool(stat.S_IMODE(metadata.st_mode) & 0o022)
    shared_temporary = metadata.st_uid in {0, system_owner} and bool(
        metadata.st_mode & stat.S_ISVTX
    )
    if not trusted or (writable and (final or not shared_temporary)):
        raise ValueError("Unsafe database directory ownership or permissions")


@contextmanager
def _directory(path: Path) -> Iterator[int]:
    # Anchor each component, refusing links instead of resolving them. A root-owned
    # sticky temporary ancestor is allowed, but the selected parent must be protected.
    parts = path.absolute().parts[1:]
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        _check_directory(os.fstat(descriptor), final=not parts)
        for index, part in enumerate(parts):
            child = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = child
            _check_directory(os.fstat(descriptor), final=index == len(parts) - 1)
        yield descriptor
    finally:
        os.close(descriptor)


def _check_source(metadata: os.stat_result, original: os.stat_result) -> None:
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid not in {0, os.stat("/").st_uid, os.geteuid()}
        or stat.S_IMODE(metadata.st_mode) & 0o022
        or metadata.st_nlink != 1
        or (metadata.st_dev, metadata.st_ino) != (original.st_dev, original.st_ino)
    ):
        raise ValueError("Unsafe or changed source database")


def _copy_selected(
    source: Path,
    destination: Path,
    *,
    recover: bool,
    source_parent: int,
    destination_parent: int,
    original: os.stat_result,
) -> None:
    try:
        os.stat(destination.name, dir_fd=destination_parent, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise FileExistsError("Destination already exists")
    installed = False
    try:
        anchored = Path(f"/proc/self/fd/{destination_parent}")
        with tempfile.TemporaryDirectory(prefix=".jukelet-db-", dir=anchored) as private:
            staged = Path(private) / "database.db"
            selected = Path(f"/proc/self/fd/{source_parent}") / source.name
            _complete_database(selected, staged, recover=recover)
            _check_source(
                os.stat(source.name, dir_fd=source_parent, follow_symlinks=False), original
            )
            with staged.open("rb") as completed:
                os.fsync(completed.fileno())
            # Same-filesystem hard-link creation is atomic and never replaces an existing name.
            # The file is complete and guarded before it can become the selected database.
            os.link(staged, destination.name, dst_dir_fd=destination_parent, follow_symlinks=False)
            installed = True
        os.fsync(destination_parent)
    except BaseException:
        if installed:
            # The selected database may already be open or have changed. Never unlink it.
            raise OutputPersistenceUncertain("Complete output may already exist") from None
        raise


def copy_database(source: Path, destination: Path, *, recover: bool) -> None:
    # Linux is the supported Docker/add-on platform. Pinned directory/file descriptors
    # retain the selected paths; no weaker path-following fallback is used.
    with (
        _directory(source.parent) as source_parent,
        _directory(destination.parent) as target_parent,
    ):
        descriptor = os.open(
            source.name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
            dir_fd=source_parent,
        )
        try:
            original = os.fstat(descriptor)
            _check_source(original, original)
            _copy_selected(
                source,
                destination,
                recover=recover,
                source_parent=source_parent,
                destination_parent=target_parent,
                original=original,
            )
        finally:
            os.close(descriptor)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("backup", "recover"))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        copy_database(args.source, args.destination, recover=args.operation == "recover")
    except OutputPersistenceUncertain:
        parser.exit(
            1,
            f"Database {args.operation} final persistence is uncertain; a complete output may "
            "already exist. Inspect it before any retry; do not overwrite or remove it.\n",
        )
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.exit(
            1,
            f"Database {args.operation} failed ({type(error).__name__}); "
            "no new usable output created.\n",
        )
    print(f"Database {args.operation} completed and integrity checked.")


if __name__ == "__main__":
    main()
