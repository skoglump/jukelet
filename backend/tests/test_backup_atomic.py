"""Atomic backup/recovery boundaries use only disposable synthetic databases."""

import errno
import os
import sqlite3
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

from jukelet.storage import migrate, open_database


def database(path: Path) -> None:
    engine = open_database(path)
    migrate(engine)
    engine.dispose()


def wait_for_source(process: subprocess.Popen[bytes], source: Path) -> None:
    """Observe the real child opening the locked source, without a production hook."""
    expected = source.stat()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            pytest.fail("Backup child exited before opening its locked source")
        for descriptor in (Path("/proc") / str(process.pid) / "fd").iterdir():
            try:
                actual = descriptor.stat()
            except OSError:
                continue
            if (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino):
                return
        time.sleep(0.01)
    pytest.fail("Backup child did not open its locked source")


@pytest.mark.skipif(sys.platform != "linux", reason="Selected Docker platform uses Linux /proc")
@pytest.mark.parametrize("operation", ["backup", "recover"])
def test_hard_interruption_never_exposes_an_incomplete_output(
    tmp_path: Path, operation: str
) -> None:
    source, destination = tmp_path / "source.db", tmp_path / "recovered.db"
    database(source)
    with sqlite3.connect(source) as blocker:
        blocker.execute("PRAGMA journal_mode=DELETE")
        original = source.read_bytes()
        blocker.execute("BEGIN EXCLUSIVE")
        process = subprocess.Popen(
            [sys.executable, "-m", "jukelet.backup", operation, str(source), str(destination)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            wait_for_source(process, source)
            assert not destination.exists(), (
                "A partial recovery is visible before copying completes"
            )
        finally:
            if process.poll() is None:
                process.kill()  # SIGKILL does not run Python exception cleanup.
            process.communicate(timeout=10)
            blocker.rollback()
    assert not destination.exists()
    assert source.read_bytes() == original
    for private in tmp_path.glob(".jukelet-db-*"):
        assert stat.S_IMODE(private.stat().st_mode) == 0o700
        assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in private.iterdir())


@pytest.mark.skipif(sys.platform != "linux", reason="Selected Docker platform uses Linux signals")
@pytest.mark.parametrize("operation", ["backup", "recover"])
def test_hard_interruption_after_copy_never_exposes_unvalidated_output(
    tmp_path: Path, operation: str
) -> None:
    source, destination, ready = (tmp_path / name for name in ("source.db", "output.db", "ready"))
    database(source)
    with sqlite3.connect(source) as connection:
        connection.execute(
            "INSERT INTO owner_session VALUES ('old-synthetic-session','synthetic-csrf',9999999999)"
        )
    original = source.read_bytes()
    # Pause the real SQLite backup API after its copy returns, before application validation
    # or recovery guards. This harness changes no production API or environment setting.
    paused_copy = """
from pathlib import Path
import signal, sqlite3, sys
from jukelet import backup
operation, source, destination, ready = sys.argv[1:]
connect = sqlite3.connect
class PausedCopy(sqlite3.Connection):
    def backup(self, target, **options):
        super().backup(target, **options)
        Path(ready).write_text('copied')
        signal.pause()
def observed_connect(*args, **options):
    return connect(*args, factory=PausedCopy, **options)
backup.sqlite3.connect = observed_connect
sys.argv = ['jukelet.backup', operation, source, destination]
backup.main()
"""
    process = subprocess.Popen(
        [sys.executable, "-c", paused_copy, operation, str(source), str(destination), str(ready)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            assert process.poll() is None, "Copy child exited before its observation point"
            time.sleep(0.01)
        assert ready.read_text() == "copied"
        assert not destination.exists(), "A copied but unvalidated database became visible"
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)
    assert not destination.exists()
    assert source.read_bytes() == original
    for private in tmp_path.glob(".jukelet-db-*"):
        assert stat.S_IMODE(private.stat().st_mode) == 0o700
        assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in private.iterdir())


@pytest.mark.skipif(sys.platform != "linux", reason="Selected Docker platform uses Linux signals")
def test_hard_interruption_after_publication_leaves_only_a_complete_guarded_output(
    tmp_path: Path,
) -> None:
    source, destination, ready = (tmp_path / name for name in ("source.db", "output.db", "ready"))
    database(source)
    with sqlite3.connect(source) as connection:
        connection.execute(
            "INSERT INTO owner_session VALUES ('old-synthetic-session','synthetic-csrf',9999999999)"
        )
    original = source.read_bytes()
    paused_publication = """
from pathlib import Path
import os, signal, sys
from jukelet import backup
source, destination, ready = sys.argv[1:]
link = os.link
def observed_link(*args, **options):
    link(*args, **options)
    Path(ready).write_text('published')
    signal.pause()
backup.os.link = observed_link
sys.argv = ['jukelet.backup', 'recover', source, destination]
backup.main()
"""
    process = subprocess.Popen(
        [sys.executable, "-c", paused_publication, str(source), str(destination), str(ready)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            assert process.poll() is None, "Publication child exited before its observation point"
            time.sleep(0.01)
        assert ready.read_text() == "published"
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)
    with sqlite3.connect(destination) as recovered:
        assert recovered.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
        assert recovered.execute(
            "SELECT reconciliation_required FROM recovery_state"
        ).fetchone() == (1,)
        assert recovered.execute("SELECT count(*) FROM owner_session").fetchone() == (0,)
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert source.read_bytes() == original
    for private in tmp_path.glob(".jukelet-db-*"):
        assert stat.S_IMODE(private.stat().st_mode) == 0o700
        assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in private.iterdir())


@pytest.mark.parametrize("failure", ["file-sync", "unsupported-link"])
def test_prepublication_filesystem_failure_never_selects_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    from jukelet import backup

    source, destination = tmp_path / "source.db", tmp_path / "output.db"
    database(source)
    original = source.read_bytes()

    def refuse(*args: object, **options: object) -> None:
        raise OSError(errno.EIO if failure == "file-sync" else errno.EOPNOTSUPP, "synthetic")

    monkeypatch.setattr(os, "fsync" if failure == "file-sync" else "link", refuse)
    with pytest.raises(OSError) as error:
        backup.copy_database(source, destination, recover=True)
    assert not isinstance(error.value, backup.OutputPersistenceUncertain)
    assert not destination.exists()
    assert source.read_bytes() == original
    assert not list(tmp_path.glob(".jukelet-db-*"))


def test_copy_failure_cannot_remove_a_competing_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jukelet.backup import copy_database

    source, destination = tmp_path / "corrupt.db", tmp_path / "competing.db"
    source.write_bytes(b"not a SQLite database")
    original_connect = sqlite3.connect
    competing: sqlite3.Connection | None = None

    def connect(path: str | Path, *, uri: bool = False) -> sqlite3.Connection:
        nonlocal competing
        if uri and competing is None:
            # A different process may create/select the destination while copying fails.
            destination.unlink(missing_ok=True)
            competing = original_connect(destination)
            competing.execute("CREATE TABLE retained (value TEXT)")
            competing.execute("INSERT INTO retained VALUES ('synthetic-other-writer')")
            competing.commit()
        return original_connect(path, uri=uri)

    monkeypatch.setattr(sqlite3, "connect", connect)
    try:
        with pytest.raises(sqlite3.DatabaseError):
            copy_database(source, destination, recover=True)
        assert destination.exists()
        assert competing is not None
        assert competing.execute("SELECT value FROM retained").fetchall() == [
            ("synthetic-other-writer",)
        ]
        assert source.read_bytes() == b"not a SQLite database"
        assert not list(tmp_path.glob(".jukelet-db-*"))
    finally:
        if competing is not None:
            competing.close()


def test_destination_created_during_copy_is_never_overwritten(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jukelet.backup import copy_database

    source, destination = tmp_path / "source.db", tmp_path / "competing.db"
    database(source)
    original = source.read_bytes()
    original_link = os.link

    def link(
        source_path: Path,
        target_path: Path,
        *,
        follow_symlinks: bool = True,
        dst_dir_fd: int | None = None,
    ) -> None:
        with sqlite3.connect(destination) as competing:
            competing.execute("CREATE TABLE retained (value TEXT)")
            competing.execute("INSERT INTO retained VALUES ('synthetic-other-writer')")
        original_link(
            source_path, target_path, follow_symlinks=follow_symlinks, dst_dir_fd=dst_dir_fd
        )

    monkeypatch.setattr(os, "link", link)
    with pytest.raises(FileExistsError):
        copy_database(source, destination, recover=True)
    with sqlite3.connect(destination) as retained:
        assert retained.execute("SELECT value FROM retained").fetchall() == [
            ("synthetic-other-writer",)
        ]
    assert source.read_bytes() == original
    assert not list(tmp_path.glob(".jukelet-db-*"))


def test_concurrent_cli_recoveries_install_one_complete_guarded_database(tmp_path: Path) -> None:
    source, destination = tmp_path / "source.db", tmp_path / "recovered.db"
    database(source)
    with sqlite3.connect(source) as connection:
        connection.execute(
            "INSERT INTO owner_session VALUES ('old-synthetic-session','synthetic-csrf',9999999999)"
        )
        identity = connection.execute("SELECT publisher_id FROM recovery_state").fetchone()[0]
    original = source.read_bytes()
    command = [sys.executable, "-m", "jukelet.backup", "recover", str(source), str(destination)]
    processes = [
        subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(4)
    ]
    try:
        outputs = [process.communicate(timeout=10) for process in processes]
        assert sorted(process.wait(timeout=1) for process in processes) == [0, 1, 1, 1]
        assert sum(b"completed and integrity checked" in out for out, _err in outputs) == 1
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=10)
    with sqlite3.connect(destination) as recovered:
        assert recovered.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
        assert recovered.execute(
            "SELECT publisher_id,reconciliation_required FROM recovery_state"
        ).fetchall() == [(identity, 1)]
        assert recovered.execute("SELECT count(*) FROM owner_session").fetchone() == (0,)
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert destination.stat().st_nlink == 1
    assert source.read_bytes() == original
    assert not list(tmp_path.glob(".jukelet-db-*"))


@pytest.mark.parametrize("cli", [False, True])
def test_failure_after_installation_preserves_a_new_sessions_running_database(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    cli: bool,
) -> None:
    from jukelet import backup

    source, destination = tmp_path / "source.db", tmp_path / "recovered.db"
    database(source)
    original = source.read_bytes()
    original_fsync = os.fsync
    connections: list[sqlite3.Connection] = []
    canary = "SYNTHETIC_PRIVATE_CSRF_DO_NOT_LOG"

    def fsync(descriptor: int) -> None:
        if stat.S_ISDIR(os.fstat(descriptor).st_mode):
            # Another worker may open the completed output before directory persistence finishes.
            running = sqlite3.connect(destination)
            connections.append(running)
            running.execute(
                "INSERT INTO owner_session VALUES ('new-synthetic-session',?,9999999999)",
                (canary,),
            )
            running.commit()
            raise OSError(errno.EIO, canary)
        original_fsync(descriptor)

    monkeypatch.setattr(os, "fsync", fsync)
    try:
        if cli:
            monkeypatch.setattr(
                sys, "argv", ["jukelet.backup", "recover", str(source), str(destination)]
            )
            with pytest.raises(SystemExit) as result:
                backup.main()
            assert result.value.code == 1
            captured = capsys.readouterr()
            assert "may already exist" in captured.err
            assert "no new usable output" not in captured.err
            assert canary not in captured.out + captured.err
        else:
            with pytest.raises(backup.OutputPersistenceUncertain) as uncertain:
                backup.copy_database(source, destination, recover=True)
            assert canary not in str(uncertain.value)
        assert destination.exists()
        assert len(connections) == 1
        assert connections[0].execute("SELECT * FROM owner_session").fetchall() == [
            ("new-synthetic-session", canary, 9999999999)
        ]
        assert connections[0].execute(
            "SELECT reconciliation_required FROM recovery_state"
        ).fetchone() == (1,)
        assert stat.S_IMODE(destination.stat().st_mode) == 0o600
        assert destination.stat().st_nlink == 1
        assert source.read_bytes() == original
        assert not list(tmp_path.glob(".jukelet-db-*"))
    finally:
        for connection in connections:
            connection.close()
