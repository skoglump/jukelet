"""Exercise the documented SQLite online backup and guarded offline recovery."""

import sqlite3
from pathlib import Path

from test_assignments import TAG, payload

from jukelet.assignments import AssignmentInput, AssignmentStore
from jukelet.config import Settings
from jukelet.inventory import tag_key
from jukelet.storage import migrate, open_database


def test_consistent_backup_and_guarded_recovery(settings: Settings, tmp_path: Path) -> None:
    from jukelet.backup import copy_database

    engine = open_database(settings.database_path)
    migrate(engine)
    store = AssignmentStore(engine)
    store.put(AssignmentInput.model_validate(payload()))
    with sqlite3.connect(settings.database_path) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("UPDATE assignment SET shuffle=0")  # Uncommitted writer must not leak.
        copy_database(settings.database_path, tmp_path / "backup.db", recover=False)
        writer.rollback()
    backup = tmp_path / "backup.db"
    assert backup.stat().st_mode & 0o777 == 0o600
    with sqlite3.connect(backup) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        identity = connection.execute("SELECT publisher_id FROM recovery_state").fetchone()[0]
        assert connection.execute("SELECT shuffle FROM assignment").fetchone() == (1,)
        connection.execute(
            "INSERT INTO owner_session VALUES ('synthetic-session','synthetic-csrf',9999999999)"
        )
    recovered = tmp_path / "recovered.db"
    copy_database(backup, recovered, recover=True)
    with sqlite3.connect(recovered) as connection:
        assert connection.execute(
            "SELECT publisher_id,reconciliation_required FROM recovery_state"
        ).fetchone() == (identity, 1)
        assert connection.execute("SELECT count(*) FROM owner_session").fetchone() == (0,)
        assert connection.execute("SELECT revision FROM assignment_revision").fetchone() == (1,)
    recovered_engine = open_database(recovered)
    migrate(recovered_engine)
    assert (
        AssignmentStore(recovered_engine).state(tag_key(TAG)).assignment
        == store.state(tag_key(TAG)).assignment
    )
    recovered_engine.dispose()
    engine.dispose()


def test_backup_refuses_overwrite_missing_source_and_corruption(tmp_path: Path) -> None:
    import pytest

    from jukelet.backup import copy_database

    source, destination = tmp_path / "source.db", tmp_path / "destination.db"
    with pytest.raises(FileNotFoundError):
        copy_database(source, destination, recover=False)
    assert not source.exists() and not destination.exists()
    source.write_bytes(b"corrupt")
    with pytest.raises(sqlite3.DatabaseError):
        copy_database(source, destination, recover=True)
    assert not destination.exists()
    destination.write_bytes(b"preserve")
    with pytest.raises(FileExistsError):
        copy_database(source, destination, recover=True)
    assert destination.read_bytes() == b"preserve"


def test_documented_module_commands(tmp_path: Path) -> None:
    import subprocess
    import sys

    source, backup, recovered = (
        tmp_path / name for name in ("source.db", "backup.db", "recovered.db")
    )
    engine = open_database(source)
    migrate(engine)
    engine.dispose()
    for operation, original, target in (("backup", source, backup), ("recover", backup, recovered)):
        result = subprocess.run(
            [sys.executable, "-m", "jukelet.backup", operation, str(original), str(target)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert "completed and integrity checked" in result.stdout
    with sqlite3.connect(recovered) as connection:
        assert connection.execute(
            "SELECT reconciliation_required FROM recovery_state"
        ).fetchone() == (1,)


def test_recovery_rejects_missing_identity_guard(tmp_path: Path) -> None:
    import pytest

    from jukelet.backup import copy_database

    source, destination = tmp_path / "incomplete.db", tmp_path / "recovered.db"
    engine = open_database(source)
    migrate(engine)
    engine.dispose()
    with sqlite3.connect(source) as connection:
        connection.execute("DELETE FROM recovery_state")
    with pytest.raises(ValueError, match="identity"):
        copy_database(source, destination, recover=True)
    assert not destination.exists()
