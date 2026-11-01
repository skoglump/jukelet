"""Transfer probe tests use synthetic local databases, not Docker or HA."""

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from jukelet.backup import copy_database
from scripts.probe_database_transfer import FIXTURE

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/probe_database_transfer.py"


def probe(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--fixture", FIXTURE, *arguments],
        capture_output=True,
        text=True,
        check=False,
    )


def test_explicit_fixture_seed_creates_a_new_nonzero_private_database(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    database = tmp_path / "source.db"
    result = probe("seed", str(database))
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["result"] == "PASS"
    assert report["tables"]["assignment"]["rows"] == 2
    assert report["tables"]["assignment_audit"]["rows"] == 8
    assert report["tables"]["publication_job"]["rows"] == 5
    assert report["tables"]["owner_session"]["rows"] == 1
    assert database.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize("mode", ["backup", "recovered"])
def test_probe_compares_every_persisted_field_with_only_required_recovery_changes(
    tmp_path: Path, mode: str
) -> None:
    tmp_path.chmod(0o700)
    source, target = tmp_path / "source.db", tmp_path / "target.db"
    assert probe("seed", str(source)).returncode == 0
    copy_database(source, target, recover=mode == "recovered")
    result = probe("compare", "--mode", mode, str(source), str(target))
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)["matches"] == {
        table: True
        for table in (
            "alembic_version",
            "owner_session",
            "assignment",
            "assignment_revision",
            "assignment_audit",
            "recovery_state",
            "publication_state",
            "publication_job",
        )
    }


@pytest.mark.parametrize(
    ("table", "mutation"),
    [
        (
            "assignment",
            "UPDATE assignment SET ha_tag_id='SYNTHETIC_PRIVATE_CHANGED' WHERE deleted=0",
        ),
        ("assignment", "UPDATE assignment SET deleted=0 WHERE deleted=1"),
        ("assignment_revision", "UPDATE assignment_revision SET revision=revision+1"),
        ("assignment_audit", "UPDATE assignment_audit SET affected=affected+1 WHERE id=1"),
        ("recovery_state", "UPDATE recovery_state SET reconciliation_required=1"),
        (
            "publication_state",
            "UPDATE publication_state SET observed_at='SYNTHETIC_PRIVATE_CHANGED'",
        ),
        (
            "publication_job",
            "UPDATE publication_job SET envelope='SYNTHETIC_PRIVATE_CHANGED' WHERE revision=5",
        ),
        ("owner_session", "UPDATE owner_session SET csrf_token='SYNTHETIC_PRIVATE_CHANGED'"),
    ],
)
def test_same_count_state_changes_fail_comparison_without_disclosing_rows(
    tmp_path: Path, table: str, mutation: str
) -> None:
    tmp_path.chmod(0o700)
    source, target = tmp_path / "source.db", tmp_path / "target.db"
    assert probe("seed", str(source)).returncode == 0
    copy_database(source, target, recover=False)
    original = source.read_bytes()
    with sqlite3.connect(target) as connection:
        connection.execute(mutation)
    result = probe("compare", "--mode", "backup", str(source), str(target))
    assert result.returncode == 1, result.stdout + result.stderr
    report = json.loads(result.stdout)
    assert report["matches"][table] is False
    assert "SYNTHETIC_PRIVATE" not in result.stdout + result.stderr
    assert source.read_bytes() == original


def test_observation_is_read_only_and_outputs_no_raw_identity_or_history(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    source = tmp_path / "source.db"
    assert probe("seed", str(source)).returncode == 0
    with sqlite3.connect(source) as connection:
        publisher = connection.execute("SELECT publisher_id FROM recovery_state").fetchone()[0]
    original = source.read_bytes()
    result = probe("observe", str(source))
    assert result.returncode == 0 and result.stderr == ""
    assert source.read_bytes() == original
    for private in (publisher, "SYNTHETIC_PRIVATE_CSRF", "synthetic-old-session", "spotify:album:"):
        assert private not in result.stdout
    report = json.loads(result.stdout)
    assert report["tables"]["assignment"]["rows"] == 2
    assert report["guards"]["sessions_empty"] is False


@pytest.mark.parametrize(
    "unsafe", ["existing", "source_mode", "parent_mode", "source_link", "parent_link"]
)
def test_seed_or_observe_refuses_unsafe_paths_without_repair(tmp_path: Path, unsafe: str) -> None:
    private = tmp_path / "private"
    private.mkdir(mode=0o700)
    source = private / "source.db"
    assert probe("seed", str(source)).returncode == 0
    original = source.read_bytes()
    selected, command = source, "observe"
    if unsafe == "existing":
        command = "seed"
    elif unsafe == "source_mode":
        source.chmod(0o644)
    elif unsafe == "parent_mode":
        private.chmod(0o755)
    elif unsafe == "source_link":
        selected = private / "link.db"
        selected.symlink_to(source)
    else:
        alias = tmp_path / "alias"
        alias.symlink_to(private, target_is_directory=True)
        selected = alias / "source.db"
    result = probe(command, str(selected))
    assert result.returncode == 1 and result.stderr == ""
    assert json.loads(result.stdout)["result"] == "FAIL"
    assert source.read_bytes() == original


def test_same_database_cannot_be_reported_as_a_transfer(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    source = tmp_path / "source.db"
    assert probe("seed", str(source)).returncode == 0
    result = probe("compare", "--mode", "backup", str(source), str(source))
    assert result.returncode == 1
    assert json.loads(result.stdout)["result"] == "FAIL"


def test_wrong_fixture_and_corrupt_input_fail_without_private_details(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    source = tmp_path / "SYNTHETIC_PRIVATE_PATH.db"
    source.write_bytes(b"SYNTHETIC_PRIVATE_CORRUPTION")
    source.chmod(0o600)
    for arguments in (
        ["--fixture", "SYNTHETIC_PRIVATE_WRONG", "observe", str(source)],
        ["--fixture", FIXTURE, "observe", str(source)],
    ):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *arguments], capture_output=True, text=True, check=False
        )
        assert result.returncode == 1 and result.stderr == ""
        assert json.loads(result.stdout)["result"] == "FAIL"
        assert "SYNTHETIC_PRIVATE" not in result.stdout


def test_observe_rejects_retained_internal_state_instead_of_hiding_a_ninth_table(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    database = tmp_path / "source.db"
    assert probe("seed", str(database)).returncode == 0
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE discarded(id INTEGER PRIMARY KEY AUTOINCREMENT)")
        connection.execute("DROP TABLE discarded")
    before = database.read_bytes()
    result = probe("observe", str(database))
    assert result.returncode == 1, (
        "internal SQLite state must not be hidden from the strict profile"
    )
    assert json.loads(result.stdout)["result"] == "FAIL"
    assert database.read_bytes() == before


def test_running_recovery_accounts_for_fresh_sessions_and_observations_explicitly(
    tmp_path: Path,
) -> None:
    tmp_path.chmod(0o700)
    source, target = tmp_path / "source.db", tmp_path / "current.db"
    assert probe("seed", str(source)).returncode == 0
    copy_database(source, target, recover=True)
    with sqlite3.connect(target) as connection:
        connection.execute(
            "INSERT INTO owner_session VALUES (?,?,?)", ("a" * 64, "b" * 43, 9999999999)
        )
        connection.execute(
            "UPDATE publication_state SET last_error='recovery_required',"
            "observed_at='fresh-observation'"
        )
    strict = probe("compare", "--mode", "recovered", str(source), str(target))
    assert strict.returncode == 1
    running = probe("compare", "--mode", "recovered-running", str(source), str(target))
    assert running.returncode == 0, running.stdout + running.stderr
    report = json.loads(running.stdout)
    assert all(report["matches"].values())
    assert report["runtime"]["fresh_sessions"] == 1
    assert report["runtime"]["old_sessions_absent"] is True
    assert report["runtime"]["stored_observation_only"] is True
    assert report["runtime"]["independent_ha_verified"] is False
    assert report["runtime"]["publication_fields"]["observed_at"]["changed"] is True
    assert report["observed"]["job_states"] == {
        "queued": 0,
        "in_flight": 0,
        "uncertain": 0,
        "verified": 1,
        "fenced": 4,
    }
    assert report["observed"]["publication"]["guard_generation"] == 8
    for private in ("fresh-observation", "recovery_required", "a" * 64, "b" * 43):
        assert private not in running.stdout


@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE assignment SET enabled=0 WHERE deleted=0",
        "UPDATE assignment_audit SET affected=affected+1 WHERE id=1",
        "UPDATE publication_state SET active_checksum='SYNTHETIC_PRIVATE_CHANGED'",
        "UPDATE publication_state SET high_water=99",
        "UPDATE publication_state SET guard_generation=7",
        "UPDATE publication_state SET automatic_enabled=1",
        "UPDATE publication_state SET healthy=1",
        "UPDATE recovery_state SET reconciliation_required=0",
        "UPDATE publication_job SET envelope='SYNTHETIC_PRIVATE_CHANGED' WHERE revision=5",
        "UPDATE publication_job SET state='queued' WHERE revision=3",
        "UPDATE publication_job SET recovery=1 WHERE revision=3",
    ],
)
def test_runtime_accounting_cannot_hide_same_count_history_or_guard_changes(
    tmp_path: Path, mutation: str
) -> None:
    tmp_path.chmod(0o700)
    source, target = tmp_path / "source.db", tmp_path / "target.db"
    assert probe("seed", str(source)).returncode == 0
    copy_database(source, target, recover=True)
    with sqlite3.connect(target) as connection:
        connection.execute(mutation)
    result = probe("compare", "--mode", "recovered-running", str(source), str(target))
    assert result.returncode == 1
    assert json.loads(result.stdout)["result"] == "FAIL"
    assert "SYNTHETIC_PRIVATE" not in result.stdout + result.stderr


def test_runtime_floor_comes_only_from_same_publisher_observation(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    source, target = tmp_path / "source.db", tmp_path / "target.db"
    assert probe("seed", str(source)).returncode == 0
    copy_database(source, target, recover=True)
    with sqlite3.connect(target) as connection:
        observed = json.loads(
            connection.execute("SELECT observed FROM publication_state").fetchone()[0]
        )
        observed["active_revision"] = 9
        connection.execute(
            "UPDATE publication_state SET observed=?,high_water=9", (json.dumps(observed),)
        )
    result = probe("compare", "--mode", "recovered-running", str(source), str(target))
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)["runtime"]["observed_floor"] == 9
    with sqlite3.connect(target) as connection:
        observed["publisher_id"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        connection.execute("UPDATE publication_state SET observed=?", (json.dumps(observed),))
    result = probe("compare", "--mode", "recovered-running", str(source), str(target))
    assert result.returncode == 1
    assert json.loads(result.stdout)["matches"]["publication_state"] is False


def test_runtime_accounting_rejects_old_sessions_and_ambiguous_observations(tmp_path: Path) -> None:
    tmp_path.chmod(0o700)
    source, target = tmp_path / "source.db", tmp_path / "target.db"
    assert probe("seed", str(source)).returncode == 0
    with sqlite3.connect(source) as connection:
        connection.execute(
            "UPDATE owner_session SET token_hash=?,csrf_token=?", ("a" * 64, "b" * 43)
        )
    copy_database(source, target, recover=True)
    with sqlite3.connect(target) as connection:
        connection.execute(
            "INSERT INTO owner_session VALUES (?,?,?)", ("a" * 64, "b" * 43, 9999999999)
        )
    result = probe("compare", "--mode", "recovered-running", str(source), str(target))
    assert result.returncode == 1
    assert json.loads(result.stdout)["runtime"]["old_sessions_absent"] is False
    with sqlite3.connect(target) as connection:
        connection.execute("DELETE FROM owner_session")
        observed = connection.execute("SELECT observed FROM publication_state").fetchone()[0]
        connection.execute(
            "UPDATE publication_state SET observed=?", ('{"active_revision":99,' + observed[1:],)
        )
    result = probe("compare", "--mode", "recovered-running", str(source), str(target))
    assert result.returncode == 1 and result.stderr == ""
    assert json.loads(result.stdout)["result"] == "FAIL"


@pytest.mark.parametrize("operation", ["seed", "observe", "compare"])
def test_legacy_probe_routes_do_not_import_current_only_recovery_modules(
    tmp_path: Path, operation: str
) -> None:
    tmp_path.chmod(0o700)
    source, target = tmp_path / "source.db", tmp_path / "target.db"
    arguments = ["seed", str(source)]
    if operation != "seed":
        assert probe("seed", str(source)).returncode == 0
        arguments = ["observe", str(source)]
        if operation == "compare":
            copy_database(source, target, recover=False)
            arguments = ["compare", "--mode", "backup", str(source), str(target)]
    script = """
import builtins, runpy, sys
real_import = builtins.__import__
def restricted(name, *args, **kwargs):
    if name in {"jukelet.addon_recovery", "jukelet.backup_profile", "jukelet.backup"}:
        raise ImportError("current-only recovery unavailable in legacy fixture")
    return real_import(name, *args, **kwargs)
builtins.__import__ = restricted
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(SCRIPT), "--fixture", FIXTURE, *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert json.loads(result.stdout)["result"] == "PASS"
