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
