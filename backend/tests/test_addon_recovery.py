"""Private synthetic Supervisor lifecycle state; no Supervisor or household access."""

import copy
import hmac
import json
import os
import sqlite3
import stat
import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any, cast

import pytest

from jukelet.addon import MARKER_NAME, prepare
from jukelet.addon_recovery import preflight
from jukelet.auth import AuthService
from jukelet.config import Settings
from jukelet.ha.adapter import HAAdapter
from jukelet.ingress import IngressIdentity
from jukelet.main import create_app
from jukelet.publication import PublicationError, Publisher
from jukelet.storage import open_database
from scripts.probe_database_transfer import seed


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def configured(tmp_path: Path) -> Settings:
    options = tmp_path / "options.json"
    options.write_text(json.dumps({"public_origin": "https://ha.example", "mode": "manage"}))
    environment = prepare(
        options,
        tmp_path,
        {"SUPERVISOR_TOKEN": "synthetic-supervisor-private"},
        owner=(os.getuid(), os.getgid()),
    )
    return Settings.load(environment)


def rows(database: Path) -> dict[str, list[dict[str, Any]]]:
    with sqlite3.connect(database) as connection:
        connection.row_factory = sqlite3.Row
        tables = sorted(
            name
            for (name,) in connection.execute("SELECT name FROM sqlite_schema WHERE type='table'")
        )
        return {
            table: sorted(
                (dict(row) for row in connection.execute(f'SELECT * FROM "{table}"')), key=repr
            )
            for table in tables
        }


@pytest.mark.anyio
async def test_unmarked_existing_database_is_guarded_before_ha_or_publisher_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    engine = open_database(settings.database_path)
    identity = IngressIdentity("a" * 32, "/api/hassio_ingress/synthetic-recovery")
    auth = AuthService(engine, settings.auth_secret, runtime="ingress")
    old_token, _ = auth.ingress_login(identity, None)
    assert auth.lookup(old_token, identity) is not None
    before = rows(settings.database_path)
    expected = copy.deepcopy(before)
    expected["owner_session"] = []
    expected["recovery_state"][0]["reconciliation_required"] = 1
    expected["publication_state"][0].update(automatic_enabled=0, healthy=0, guard_generation=8)
    for job in expected["publication_job"]:
        if job["state"] in {"queued", "in_flight", "uncertain"}:
            job["state"] = "fenced"
    started: list[str] = []

    def check_before_start(_: object) -> None:
        with sqlite3.connect(settings.database_path) as connection:
            assert connection.execute(
                "SELECT reconciliation_required FROM recovery_state"
            ).fetchone() == (1,), "restored state must be guarded before HA starts"
            assert connection.execute(
                "SELECT automatic_enabled,healthy,guard_generation FROM publication_state"
            ).fetchone() == (0, 0, 8)
            assert connection.execute("SELECT count(*) FROM owner_session").fetchone() == (0,)
            assert connection.execute(
                "SELECT count(*) FROM publication_job WHERE state IN "
                "('queued','in_flight','uncertain')"
            ).fetchone() == (0,)
        started.append("started")

    monkeypatch.setattr(HAAdapter, "start", check_before_start)
    monkeypatch.setattr(Publisher, "start", check_before_start)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        assert started == ["started", "started"]
        assert auth.lookup(old_token, identity) is None
        assert rows(settings.database_path) == expected
        fresh_token, _ = auth.ingress_login(identity, old_token)
        assert fresh_token != old_token and auth.lookup(fresh_token, identity) is not None
    engine.dispose()


@pytest.mark.anyio
async def test_valid_continuity_preserves_normal_restart_choices_and_uncertainty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    preflight(settings).complete()
    marker = settings.database_path.parent / MARKER_NAME
    witness = marker.read_bytes()
    engine = open_database(settings.database_path)
    identity = IngressIdentity("a" * 32, "/api/hassio_ingress/synthetic-recovery")
    auth = AuthService(engine, settings.auth_secret, runtime="ingress")
    token, _ = auth.ingress_login(identity, None)
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("UPDATE recovery_state SET reconciliation_required=0")
        connection.execute("UPDATE publication_state SET automatic_enabled=1,healthy=1")
        connection.execute("UPDATE publication_job SET state='uncertain' WHERE revision=5")
    before = rows(settings.database_path)
    seen: list[str] = []

    def start(_: object) -> None:
        assert rows(settings.database_path) == before
        assert marker.read_bytes() == witness
        assert auth.lookup(token, identity) is not None
        seen.append("normal")

    monkeypatch.setattr(HAAdapter, "start", start)
    monkeypatch.setattr(Publisher, "start", start)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        assert seen == ["normal", "normal"]
    engine.dispose()


@pytest.mark.anyio
async def test_same_identity_restore_fences_recovery_jobs_and_sends_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    preflight(settings).complete()
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("UPDATE recovery_state SET reconciliation_required=0")
        connection.execute("UPDATE publication_state SET automatic_enabled=1,healthy=1")
        connection.execute("UPDATE publication_job SET state='queued',recovery=1 WHERE revision=3")
        actual = json.loads(
            connection.execute("SELECT observed FROM publication_state").fetchone()[0]
        )
    # Model the native route's omitted witness with the same app/HA identity tuple.
    # This is an application regression, never a claim of actual Supervisor restore.
    (settings.database_path.parent / MARKER_NAME).unlink()
    captured: list[Publisher] = []
    sent: list[object] = []
    original_start = Publisher.start

    def start(publisher: Publisher) -> None:
        captured.append(publisher)
        original_start(publisher)

    def ha_start(ha: HAAdapter) -> None:
        ha.status.connection = "connected"

    async def status(_: HAAdapter) -> object:
        return actual

    async def publish(_: HAAdapter, *args: Any, **kwargs: Any) -> None:
        sent.append(args)

    monkeypatch.setattr(HAAdapter, "start", ha_start)
    monkeypatch.setattr(HAAdapter, "bridge_status", status)
    monkeypatch.setattr(HAAdapter, "publish_snapshot", publish)
    monkeypatch.setattr(Publisher, "start", start)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        publisher = captured[0]
        await publisher.step()
        observed = await publisher.refresh()
        assert observed["reconciliation_required"] and not observed["automatic_enabled"]
        assert publisher.store.read()["guard_generation"] == 9
        assert sent == []
        for action in ("publish", "activate"):
            with pytest.raises(PublicationError, match="recovery_required"):
                await publisher.review(action, "synthetic-fresh-session")
        state = rows(settings.database_path)
        assert all(
            job["state"] not in {"queued", "in_flight", "uncertain"}
            for job in state["publication_job"]
        )


@pytest.mark.anyio
async def test_fresh_install_and_interrupted_wrapper_preparation_keep_initial_consent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = configured(tmp_path)
    secret = settings.auth_secret
    # A wrapper restart before SQLite creation retains its already complete key.
    settings = configured(tmp_path)
    assert settings.auth_secret == secret
    monkeypatch.setattr(HAAdapter, "start", lambda _: None)
    monkeypatch.setattr(Publisher, "start", lambda _: None)
    previous = os.umask(0o077)  # The real wrapper sets this before exec/privilege drop.
    try:
        app = create_app(settings)
        async with app.router.lifespan_context(app):
            state = rows(settings.database_path)
            assert state["recovery_state"][0]["reconciliation_required"] == 0
            assert state["publication_state"][0]["guard_generation"] == 0
            assert state["publication_state"][0]["automatic_enabled"] == 0
            assert state["owner_session"] == state["publication_job"] == []
            marker = settings.database_path.parent / MARKER_NAME
            assert marker.is_file() and marker.stat().st_mode & 0o777 == 0o600
            assert marker.stat().st_nlink == 1 and len(marker.read_bytes()) <= 256
        assert configured(tmp_path).auth_secret == secret
        preflight(settings).complete()
        assert rows(settings.database_path)["publication_state"][0]["guard_generation"] == 0
    finally:
        os.umask(previous)


@pytest.mark.anyio
async def test_generic_ingress_supervisor_transport_does_not_infer_native_restore(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    settings = replace(settings, supervisor_continuity=False)
    monkeypatch.setattr(HAAdapter, "start", lambda _: None)
    monkeypatch.setattr(Publisher, "start", lambda _: None)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        state = rows(settings.database_path)
        assert state["recovery_state"][0]["reconciliation_required"] == 0
        assert state["publication_state"][0]["automatic_enabled"] == 1
        assert state["publication_state"][0]["guard_generation"] == 7
        assert not (settings.database_path.parent / MARKER_NAME).exists()


@pytest.mark.parametrize(
    "damage",
    [
        "malformed",
        "oversize",
        "wrong_key",
        "foreign_publisher",
        "symlink",
        "hardlink",
        "directory",
        "fifo",
        "permissions",
    ],
)
def test_unsafe_witness_never_reaches_migration_or_repairs_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, damage: str
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    preflight(settings).complete()
    marker = settings.database_path.parent / MARKER_NAME
    external = tmp_path / "external"
    external.write_bytes(marker.read_bytes())
    external.chmod(0o600)
    marker.unlink()
    if damage == "malformed":
        marker.write_bytes(b"SYNTHETIC_PRIVATE_MALFORMED")
    elif damage == "oversize":
        marker.write_bytes(b"x" * 257)
    elif damage == "wrong_key":
        value = external.read_bytes().rsplit(b":", 1)[0]
        marker.write_bytes(
            value + b":" + hmac.digest(b"another-key", value, "sha256").hex().encode() + b"\n"
        )
    elif damage == "foreign_publisher":
        value = b"jukelet-supervisor-continuity-v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        marker.write_bytes(
            value + b":" + hmac.digest(settings.auth_secret, value, "sha256").hex().encode() + b"\n"
        )
    elif damage == "symlink":
        marker.symlink_to(external)
    elif damage == "hardlink":
        os.link(external, marker)
    elif damage == "directory":
        marker.mkdir()
    elif damage == "fifo":
        os.mkfifo(marker)
    else:
        marker.write_bytes(external.read_bytes())
    if damage not in {"symlink", "directory", "fifo"}:
        marker.chmod(0o644 if damage == "permissions" else 0o600)
    before = rows(settings.database_path)

    def forbidden(_: object) -> None:
        pytest.fail("unsafe continuity must stop before migration or runtime startup")

    monkeypatch.setattr("jukelet.main.migrate", forbidden)
    monkeypatch.setattr(HAAdapter, "start", forbidden)
    monkeypatch.setattr(Publisher, "start", forbidden)
    with pytest.raises((ValueError, OSError)) as error:
        create_app(settings)
    assert "SYNTHETIC_PRIVATE_MALFORMED" not in str(error.value)
    assert rows(settings.database_path) == before
    assert external.read_bytes().startswith(b"jukelet-supervisor-continuity-v1:")


@pytest.mark.parametrize(
    "damage",
    ["empty", "corrupt", "missing_identity", "unknown_schema", "internal_table", "bad_job"],
)
def test_existing_unsafe_database_is_not_migrated_or_reinitialized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, damage: str
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    if damage in {"empty", "corrupt"}:
        settings.database_path.write_bytes(b"" if damage == "empty" else b"synthetic-corrupt")
    else:
        sql = {
            "missing_identity": "DELETE FROM recovery_state",
            "unknown_schema": "UPDATE alembic_version SET version_num='future'",
            "internal_table": "CREATE TABLE unknown(id INTEGER PRIMARY KEY AUTOINCREMENT)",
            "bad_job": "UPDATE publication_job SET envelope='{}' WHERE revision=3",
        }[damage]
        with sqlite3.connect(settings.database_path) as connection:
            connection.execute(sql)
    original = settings.database_path.read_bytes()

    def forbidden(_: object) -> None:
        pytest.fail("unsafe existing database must stop before migration")

    monkeypatch.setattr("jukelet.main.migrate", forbidden)
    with pytest.raises((ValueError, sqlite3.Error)):
        create_app(settings)
    assert settings.database_path.read_bytes() == original
    assert not (settings.database_path.parent / MARKER_NAME).exists()


def test_lost_database_with_existing_witness_cannot_create_a_new_identity(tmp_path: Path) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    preflight(settings).complete()
    settings.database_path.unlink()
    with pytest.raises(ValueError, match="missing"):
        create_app(settings)
    assert not settings.database_path.exists()
    with pytest.raises(ValueError, match="missing"):
        configured(tmp_path)
    assert not settings.database_path.exists()


@pytest.mark.anyio
async def test_exhausted_guard_stops_startup_without_publisher_cleanup_mutation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("UPDATE publication_state SET guard_generation=?", (2**63 - 1,))
    before = rows(settings.database_path)

    def forbidden(_: object) -> None:
        pytest.fail("failed guard must not start HA/publisher or invoke publisher cleanup")

    monkeypatch.setattr(HAAdapter, "start", forbidden)
    monkeypatch.setattr(Publisher, "start", forbidden)
    monkeypatch.setattr(Publisher, "close", forbidden)
    app = create_app(settings)
    with pytest.raises(ValueError, match="exhausted"):
        async with app.router.lifespan_context(app):
            pytest.fail("startup must fail")
    assert rows(settings.database_path) == before
    assert not (settings.database_path.parent / MARKER_NAME).exists()


@pytest.mark.anyio
async def test_failed_guard_commit_leaves_no_witness_and_rolls_back_all_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    before = rows(settings.database_path)
    real_connect = sqlite3.connect

    class FailedCommit(sqlite3.Connection):
        def commit(self) -> None:
            raise sqlite3.OperationalError("synthetic commit failure")

    def connect(database: str, *args: Any, **kwargs: Any) -> sqlite3.Connection:
        if kwargs.get("uri"):
            kwargs["factory"] = FailedCommit
        return cast(sqlite3.Connection, real_connect(database, *args, **kwargs))

    monkeypatch.setattr(sqlite3, "connect", connect)
    app = create_app(settings)
    with pytest.raises(sqlite3.OperationalError, match="synthetic commit failure"):
        async with app.router.lifespan_context(app):
            pytest.fail("startup must fail")
    assert rows(settings.database_path) == before
    assert not (settings.database_path.parent / MARKER_NAME).exists()


@pytest.mark.anyio
@pytest.mark.parametrize(
    "failure", ["database_sync", "marker_write", "marker_sync", "link", "directory_sync"]
)
async def test_persistence_failure_cannot_certify_unguarded_data_and_retry_is_conservative(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    marker = settings.database_path.parent / MARKER_NAME
    real_sync, real_write, real_link = os.fsync, os.write, os.link
    failed = False

    def assert_guarded() -> None:
        state = rows(settings.database_path)
        assert state["recovery_state"][0]["reconciliation_required"] == 1
        assert state["publication_state"][0]["guard_generation"] == 8
        assert not state["publication_state"][0]["automatic_enabled"]
        assert state["owner_session"] == []

    def sync(descriptor: int) -> None:
        nonlocal failed
        selected = Path(os.readlink(f"/proc/self/fd/{descriptor}")).name
        trigger = (
            (failure == "database_sync" and selected == "jukelet.db")
            or (failure == "marker_sync" and selected.startswith(MARKER_NAME + "-"))
            or (
                failure == "directory_sync"
                and marker.exists()
                and stat.S_ISDIR(os.fstat(descriptor).st_mode)
            )
        )
        if trigger and not failed:
            assert_guarded()
            failed = True
            raise OSError("synthetic fsync failure")
        real_sync(descriptor)

    def write(descriptor: int, contents: bytes) -> int:
        nonlocal failed
        if failure == "marker_write" and not failed:
            assert_guarded()
            real_write(descriptor, contents[:7])
            failed = True
            raise OSError("synthetic partial witness write")
        return real_write(descriptor, contents)

    def link(*args: Any, **kwargs: Any) -> None:
        nonlocal failed
        if failure == "link" and not failed:
            assert_guarded()
            failed = True
            raise OSError("synthetic witness publication failure")
        real_link(*args, **kwargs)

    monkeypatch.setattr(os, "fsync", sync)
    monkeypatch.setattr(os, "write", write)
    monkeypatch.setattr(os, "link", link)
    app = create_app(settings)
    with pytest.raises(OSError, match="synthetic"):
        async with app.router.lifespan_context(app):
            pytest.fail("startup must fail")
    assert failed
    assert_guarded()
    assert marker.exists() == (failure == "directory_sync")
    assert not list(settings.database_path.parent.glob(MARKER_NAME + "-*"))
    monkeypatch.setattr(HAAdapter, "start", lambda _: None)
    monkeypatch.setattr(Publisher, "start", lambda _: None)
    retry = create_app(settings)
    async with retry.router.lifespan_context(retry):
        state = rows(settings.database_path)
        assert state["publication_state"][0]["guard_generation"] == (
            8 if failure == "directory_sync" else 9
        )
        assert state["recovery_state"][0]["reconciliation_required"] == 1
        assert not state["publication_state"][0]["automatic_enabled"]


@pytest.mark.parametrize("point", ["before_marker", "linked_marker", "after_marker"])
@pytest.mark.parametrize("journal", ["DELETE", "WAL"])
def test_hard_interruption_never_leaves_a_witness_for_unguarded_state(
    tmp_path: Path, point: str, journal: str
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(f"PRAGMA journal_mode={journal}")
    script = """
import asyncio, os, signal, stat, sys
from pathlib import Path
from jukelet.config import Settings
from jukelet.main import create_app
from jukelet.addon import MARKER_NAME
settings = Settings.load()
marker = settings.database_path.parent / MARKER_NAME
real_sync, real_link = os.fsync, os.link
def link(*args, **kwargs):
    real_link(*args, **kwargs)
    if sys.argv[1] == "linked_marker":
        os.kill(os.getpid(), signal.SIGKILL)
def interrupt(fd):
    name = Path(os.readlink(f"/proc/self/fd/{fd}")).name
    if ((sys.argv[1] == "before_marker" and name.startswith(MARKER_NAME + "-"))
        or (sys.argv[1] == "after_marker" and marker.exists()
            and stat.S_ISDIR(os.fstat(fd).st_mode))):
        os.kill(os.getpid(), signal.SIGKILL)
    real_sync(fd)
os.fsync = interrupt
os.link = link
app = create_app(settings)
async def start():
    async with app.router.lifespan_context(app):
        raise AssertionError("interruption must precede runtime startup")
asyncio.run(start())
"""
    environment = {
        **os.environ,
        "APP_PUBLIC_ORIGIN": settings.public_origin,
        "APP_AUTH_TOKEN_FILE": str(settings.database_path.parent / "auth-secret"),
        "DATABASE_PATH": str(settings.database_path),
        "APP_RUNTIME": "ingress",
        "HA_TRANSPORT": "supervisor",
        "SUPERVISOR_TOKEN": "synthetic-private",
        "JUKELET_SUPERVISOR_CONTINUITY": "required",
    }
    result = subprocess.run(
        [sys.executable, "-c", script, point],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )
    assert result.returncode == -9, result.stdout + result.stderr
    state = rows(settings.database_path)
    assert state["publication_state"][0]["guard_generation"] == 8
    assert state["recovery_state"][0]["reconciliation_required"] == 1
    assert not state["publication_state"][0]["automatic_enabled"]
    assert state["owner_session"] == []
    marker = settings.database_path.parent / MARKER_NAME
    assert marker.exists() == (point != "before_marker")
    if point == "linked_marker":
        assert marker.stat().st_nlink == 2
        with pytest.raises(ValueError, match="hard links"):
            preflight(settings)
        assert rows(settings.database_path)["publication_state"][0]["guard_generation"] == 8
        return  # Retain ambiguous task-owned links; never repair an unsafe witness automatically.
    preflight(settings).complete()
    assert rows(settings.database_path)["publication_state"][0]["guard_generation"] == (
        8 if point == "after_marker" else 9
    )


def test_database_loss_during_persistence_cannot_publish_continuity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    selected = preflight(settings)
    real_sync = os.fsync
    removed = False

    def sync(descriptor: int) -> None:
        nonlocal removed
        if not removed and os.path.samestat(os.fstat(descriptor), settings.database_path.stat()):
            settings.database_path.unlink()
            removed = True
        real_sync(descriptor)

    monkeypatch.setattr(os, "fsync", sync)
    with pytest.raises((OSError, ValueError)):
        selected.complete()
    assert removed
    assert not (settings.database_path.parent / MARKER_NAME).exists()


@pytest.mark.parametrize(
    "damage",
    [
        "parent_link",
        "database_link",
        "database_hardlink",
        "key_link",
        "key_hardlink",
        "key_permissions",
        "parent_permissions",
        "key_changed",
    ],
)
def test_server_preflight_independently_rejects_changed_private_paths(
    tmp_path: Path, damage: str
) -> None:
    settings = configured(tmp_path)
    seed(settings.database_path)
    original = rows(settings.database_path)
    parent = settings.database_path.parent
    if damage == "parent_link":
        actual = tmp_path / "actual"
        parent.rename(actual)
        parent.symlink_to(actual, target_is_directory=True)
    elif damage == "parent_permissions":
        parent.chmod(0o750)
    else:
        path = settings.database_path if damage.startswith("database") else parent / "auth-secret"
        if damage.endswith("link"):
            actual = tmp_path / "retained"
            path.rename(actual)
            if damage.endswith("hardlink"):
                os.link(actual, path)
                os.link(actual, tmp_path / "another-link")
            else:
                path.symlink_to(actual)
        elif damage == "key_permissions":
            path.chmod(0o644)
        else:
            path.write_bytes(b"another-private-key-not-the-configured-key-123456789")
    with pytest.raises((OSError, ValueError)):
        create_app(settings)
    assert rows(settings.database_path) == original
    assert not (parent / MARKER_NAME).exists()
