"""Consistent SQLite backup; recovery creates a new, guarded offline database.

Run `python -m jukelet.backup {backup,recover} SOURCE NEW_DESTINATION`.
Never replace a running application's database. See docs/10-development.md.
"""

import argparse
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from uuid import UUID


def copy_database(source: Path, destination: Path, *, recover: bool) -> None:
    if not source.is_file():
        raise FileNotFoundError("Source database does not exist")
    # Exclusive creation protects an existing destination and fixes permissions before data exists.
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)) as original:
            with closing(sqlite3.connect(destination)) as copied:
                original.backup(copied, pages=128, sleep=0.05)
                if copied.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise ValueError("Database integrity check failed")
                if copied.execute("SELECT version_num FROM alembic_version").fetchall() != [
                    ("0004",)
                ]:
                    raise ValueError("Backup/recovery requires the current database schema")
                identities = copied.execute("SELECT id,publisher_id FROM recovery_state").fetchall()
                if len(identities) != 1 or identities[0][0] != 1:
                    raise ValueError("Missing or ambiguous publisher identity")
                UUID(identities[0][1])
                if recover:
                    # The persisted identity and old revision are evidence, never permission to
                    # overwrite newer active HA state. M3 must reconcile before any publication.
                    copied.execute("UPDATE recovery_state SET reconciliation_required=1 WHERE id=1")
                    copied.execute(
                        "UPDATE publication_state SET "
                        "automatic_enabled=0,healthy=0,guard_generation=guard_generation+1 WHERE "
                        "id=1"
                    )
                    copied.execute(
                        "UPDATE publication_job SET state='fenced' WHERE state IN "
                        "('queued','in_flight','uncertain')"
                    )
                    copied.execute("DELETE FROM owner_session")
                copied.commit()
                copied.execute("PRAGMA journal_mode=DELETE")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("backup", "recover"))
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        copy_database(args.source, args.destination, recover=args.operation == "recover")
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.exit(
            1,
            f"Database {args.operation} failed ({type(error).__name__}); "
            "no new usable output created.\n",
        )
    print(f"Database {args.operation} completed and integrity checked.")


if __name__ == "__main__":
    main()
