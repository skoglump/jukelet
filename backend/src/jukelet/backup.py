"""Consistent SQLite backup; recovery creates a new, guarded offline database.

Run `python -m jukelet.backup {backup,recover} SOURCE NEW_DESTINATION`.
Never replace a running application's database. See docs/10-development.md.
"""

import argparse
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from uuid import UUID


class OutputPersistenceUncertain(OSError):
    """A complete output was installed, but final filesystem persistence is uncertain."""


def _complete_database(source: Path, destination: Path, *, recover: bool) -> None:
    # This pathname belongs to our private staging directory, never to the application.
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as original:
        with closing(sqlite3.connect(destination)) as copied:
            original.backup(copied, pages=128, sleep=0.05)
            if copied.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("Database integrity check failed")
            if copied.execute("SELECT version_num FROM alembic_version").fetchall() != [("0004",)]:
                raise ValueError("Backup/recovery requires the current database schema")
            identities = copied.execute("SELECT id,publisher_id FROM recovery_state").fetchall()
            if len(identities) != 1 or identities[0][0] != 1:
                raise ValueError("Missing or ambiguous publisher identity")
            UUID(identities[0][1])
            if recover:
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


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def copy_database(source: Path, destination: Path, *, recover: bool) -> None:
    if not source.is_file():
        raise FileNotFoundError("Source database does not exist")
    try:
        destination.lstat()
    except FileNotFoundError:
        pass
    else:
        raise FileExistsError("Destination already exists")
    installed = False
    try:
        with tempfile.TemporaryDirectory(prefix=".jukelet-db-", dir=destination.parent) as private:
            staged = Path(private) / "database.db"
            _complete_database(source, staged, recover=recover)
            with staged.open("rb") as completed:
                os.fsync(completed.fileno())
            # Same-filesystem hard-link creation is atomic and never replaces an existing name.
            # The file is complete and guarded before it can become the selected database.
            os.link(staged, destination, follow_symlinks=False)
            installed = True
        _sync_directory(destination.parent)
    except BaseException:
        if installed:
            # The selected database may already be open or have changed. Never unlink it.
            raise OutputPersistenceUncertain("Complete output may already exist") from None
        raise


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
