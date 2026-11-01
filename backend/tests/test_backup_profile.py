"""Supported raw SQLite transfers use disposable, synthetic data only."""

import hashlib
import json
import os
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text

from jukelet.assignments import AssignmentInput, AssignmentStore
from jukelet.publication_store import PublicationStore, queue
from jukelet.storage import migrate, open_database


def database(path: Path) -> None:
    engine = open_database(path)
    migrate(engine)
    engine.dispose()


def populated_database(path: Path) -> None:
    engine = open_database(path)
    migrate(engine)
    assignments = AssignmentStore(engine)
    opaque = "  opaque/Å/e\u0301 日本語  "

    def save(tag: str, expected: int = 0, *, shuffle: bool = False) -> None:
        assignments.put(
            AssignmentInput(
                ha_tag_id=tag,
                input="spotify:album:0123456789ABCDEFGHIJKL",
                media_type="album",
                enabled=True,
                shuffle=shuffle,
                playback_profile_id="default",
                expected_version=expected,
            )
        )

    save(opaque)
    save("synthetic-tombstone")
    from jukelet.inventory import tag_key

    assignments.delete(tag_key("synthetic-tombstone"), 1)
    with engine.begin() as connection:
        connection.execute(text("UPDATE publication_state SET guard_generation=7"))
    for version, state in enumerate(("verified", "fenced", "queued", "in_flight", "uncertain"), 1):
        save(opaque, version, shuffle=bool(version % 2))
        with engine.begin() as connection:
            revision = queue(connection)
            connection.execute(
                text(
                    "UPDATE publication_job SET state=:state,recovery=:recovery WHERE revision=:n"
                ),
                {"state": state, "recovery": state == "fenced", "n": revision},
            )
            if state == "verified":
                job = (
                    connection.execute(
                        text("SELECT * FROM publication_job WHERE revision=:n"), {"n": revision}
                    )
                    .mappings()
                    .one()
                )
                connection.execute(
                    text(
                        "UPDATE publication_state SET active_revision=:n,active_checksum=:checksum,"
                        "active_payload=:payload,active_desired_version=:version,established=1"
                    ),
                    {
                        "n": revision,
                        "checksum": job["checksum"],
                        "payload": json.dumps(json.loads(job["envelope"])["payload"], indent=2),
                        "version": job["desired_version"],
                    },
                )
    with engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE publication_state SET automatic_enabled=1,healthy=1,"
                "last_error='synthetic-retained-error',observed=:observed,observed_at='synthetic-time'"
            ),
            {
                "observed": json.dumps(
                    {
                        "protocol_version": 1,
                        "schema_version": 1,
                        "publisher_id": connection.scalar(
                            text("SELECT publisher_id FROM recovery_state")
                        ),
                        "active_revision": 1,
                        "active_checksum": connection.scalar(
                            text("SELECT active_checksum FROM publication_state")
                        ),
                        "mapping_count": 1,
                        "persistence": "healthy",
                        "last_error": None,
                        "dispatch_enabled": True,
                        "supported_media": ["album", "playlist"],
                        "supported_preferences": ["enabled", "shuffle"],
                        "playback_profiles": ["default"],
                    }
                )
            },
        )
        connection.execute(
            text(
                "INSERT INTO owner_session VALUES "
                "('old-synthetic-session','SYNTHETIC_PRIVATE_CSRF',9999999999)"
            )
        )
    engine.dispose()


def rows(path: Path) -> dict[str, list[dict[str, Any]]]:
    with sqlite3.connect(path) as connection:
        connection.row_factory = sqlite3.Row
        tables = connection.execute("SELECT name FROM sqlite_schema WHERE type='table'").fetchall()
        return {
            row[0]: [dict(value) for value in connection.execute(f'SELECT * FROM "{row[0]}"')]
            for row in tables
        }


@pytest.mark.parametrize("recover", [False, True])
def test_complete_nonzero_profile_retains_all_persisted_data(tmp_path: Path, recover: bool) -> None:
    from jukelet.backup import copy_database

    source, destination = tmp_path / "source.db", tmp_path / "output.db"
    populated_database(source)
    original = source.read_bytes()
    expected = rows(source)
    assert len(expected["assignment"]) == 2
    assert any(row["deleted"] == 1 and row["version"] == 2 for row in expected["assignment"])
    assert len(expected["assignment_audit"]) == 8
    assert len(expected["publication_job"]) == 5
    if recover:
        expected["owner_session"] = []
        expected["recovery_state"][0]["reconciliation_required"] = 1
        expected["publication_state"][0]["automatic_enabled"] = 0
        expected["publication_state"][0]["healthy"] = 0
        expected["publication_state"][0]["guard_generation"] += 1
        for job in expected["publication_job"]:
            if job["state"] in {"queued", "in_flight", "uncertain"}:
                job["state"] = "fenced"
    copy_database(source, destination, recover=recover)
    assert rows(destination) == expected
    assert source.read_bytes() == original
    assert destination.stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE publication_state SET high_water=-1",
        "UPDATE publication_state SET high_water=1",
        "UPDATE publication_job SET envelope='{}' WHERE revision=5",
        "UPDATE recovery_state SET publisher_id=x'53594e544845544943'",
    ],
)
def test_recovery_rejects_incoherent_retained_publication_history(
    tmp_path: Path, mutation: str
) -> None:
    from jukelet.backup import copy_database

    source, destination = tmp_path / "source.db", tmp_path / "output.db"
    populated_database(source)
    with sqlite3.connect(source) as connection:
        connection.execute(mutation)
    original = source.read_bytes()
    with pytest.raises(ValueError):
        copy_database(source, destination, recover=True)
    assert not destination.exists()
    assert source.read_bytes() == original


@pytest.mark.parametrize("operation", ["backup", "recover"])
def test_cli_rejects_missing_publication_singleton(tmp_path: Path, operation: str) -> None:
    source, destination = tmp_path / "source.db", tmp_path / "output.db"
    database(source)
    with sqlite3.connect(source) as connection:
        connection.execute("DELETE FROM publication_state")
    original = source.read_bytes()
    result = subprocess.run(
        [sys.executable, "-m", "jukelet.backup", operation, str(source), str(destination)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1, "A supported schema marker cannot replace required durable state"
    assert not destination.exists()
    assert source.read_bytes() == original
    assert not list(tmp_path.glob(".jukelet-db-*"))


@pytest.mark.parametrize(
    "mutation",
    [
        "ALTER TABLE publication_job DROP COLUMN base_checksum",
        "CREATE TRIGGER alter_identity AFTER UPDATE ON recovery_state BEGIN "
        "UPDATE recovery_state SET publisher_id='00000000-0000-0000-0000-000000000001'; END",
        "INSERT INTO assignment_revision VALUES (2,7)",
        "CREATE INDEX unsupported_expression ON publication_state (length(active_payload))",
    ],
)
def test_recovery_rejects_incomplete_or_ambiguous_supported_profile(
    tmp_path: Path, mutation: str
) -> None:
    from jukelet.backup import copy_database

    source, destination = tmp_path / "source.db", tmp_path / "output.db"
    database(source)
    with sqlite3.connect(source) as connection:
        connection.execute(mutation)
    original = source.read_bytes()
    with pytest.raises(ValueError):
        copy_database(source, destination, recover=True)
    assert not destination.exists()
    assert source.read_bytes() == original


@pytest.mark.parametrize("unsafe", ["source-link", "source-hardlink", "source-mode", "parent-link"])
def test_transfer_rejects_unsafe_source_selection(tmp_path: Path, unsafe: str) -> None:
    from jukelet.backup import copy_database

    private = tmp_path / "private"
    private.mkdir(mode=0o700)
    source, destination = private / "source.db", tmp_path / "output.db"
    database(source)
    original = source.read_bytes()
    selected = source
    if unsafe == "source-link":
        selected = tmp_path / "source-link.db"
        selected.symlink_to(source)
    elif unsafe == "source-hardlink":
        os.link(source, tmp_path / "source-hardlink.db")
    elif unsafe == "source-mode":
        source.chmod(0o666)
    else:
        alias = tmp_path / "alias"
        alias.symlink_to(private, target_is_directory=True)
        selected = alias / source.name
    with pytest.raises((OSError, ValueError)):
        copy_database(selected, destination, recover=True)
    assert not destination.exists()
    assert source.read_bytes() == original


@pytest.mark.parametrize(
    "unsafe", ["writable-source-parent", "writable-target-parent", "target-link"]
)
def test_transfer_rejects_unsafe_parent_directories(tmp_path: Path, unsafe: str) -> None:
    from jukelet.backup import copy_database

    old, new = tmp_path / "old", tmp_path / "new"
    old.mkdir(mode=0o700)
    new.mkdir(mode=0o700)
    source, destination = old / "source.db", new / "output.db"
    database(source)
    original = source.read_bytes()
    if unsafe == "writable-source-parent":
        old.chmod(0o777)
    elif unsafe == "writable-target-parent":
        new.chmod(0o777)
    else:
        alias = tmp_path / "alias"
        alias.symlink_to(new, target_is_directory=True)
        destination = alias / "output.db"
    with pytest.raises((OSError, ValueError)):
        copy_database(source, destination, recover=True)
    assert not (new / "output.db").exists()
    assert source.read_bytes() == original


def test_transfer_rejects_untrusted_source_owner_without_chown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jukelet.backup import copy_database

    source, destination = tmp_path / "source.db", tmp_path / "output.db"
    database(source)
    original_fstat = os.fstat

    def fstat(descriptor: int) -> os.stat_result:
        metadata = original_fstat(descriptor)
        if stat.S_ISREG(metadata.st_mode):
            fields = list(metadata)
            fields[4] = os.geteuid() + 9876
            return os.stat_result(fields)
        return metadata

    monkeypatch.setattr(os, "fstat", fstat)
    with pytest.raises(ValueError, match="source"):
        copy_database(source, destination, recover=True)
    assert not destination.exists()


def test_source_replacement_during_copy_is_rejected_without_publishing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from jukelet.backup import copy_database

    source, preserved, destination = (
        tmp_path / name for name in ("source.db", "old.db", "output.db")
    )
    database(source)
    original = source.read_bytes()
    connect = sqlite3.connect
    replaced = False

    def replace(path: str | Path, *, uri: bool = False) -> sqlite3.Connection:
        nonlocal replaced
        if uri and not replaced:
            source.rename(preserved)
            source.write_bytes(original)
            replaced = True
        return connect(path, uri=uri)

    monkeypatch.setattr(sqlite3, "connect", replace)
    with pytest.raises(ValueError, match="source"):
        copy_database(source, destination, recover=True)
    assert replaced and not destination.exists()
    assert source.read_bytes() == preserved.read_bytes() == original


def test_equivalent_structure_and_legitimate_upgrade_remain_supported(tmp_path: Path) -> None:
    from jukelet import storage
    from jukelet.backup import copy_database

    source, destination = tmp_path / "source.db", tmp_path / "output.db"
    engine = open_database(source)
    config = Config()
    config.set_main_option("script_location", str(Path(storage.__file__).parent / "migrations"))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0002")
    migrate(engine)
    engine.dispose()
    with sqlite3.connect(source) as connection:
        # TEXT and VARCHAR have the same SQLite affinity. SQL formatting is not identity.
        connection.execute("DROP TABLE owner_session")
        connection.execute(
            "CREATE TABLE owner_session (token_hash TEXT NOT NULL PRIMARY KEY, "
            "csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL)"
        )
    source.chmod(0o644)  # Existing standalone defaults remain a supported input.
    copy_database(source, destination, recover=True)
    assert rows(destination)["recovery_state"][0]["reconciliation_required"] == 1
    supported_future_writes(destination)


def test_long_exact_local_drafts_are_not_restricted_to_publication_ids(tmp_path: Path) -> None:
    from jukelet.backup import copy_database

    source, destination = tmp_path / "source.db", tmp_path / "output.db"
    database(source)
    engine = open_database(source)
    AssignmentStore(engine).put(
        AssignmentInput(
            ha_tag_id=" x/" + "Å" * 500,
            input="spotify:album:0123456789ABCDEFGHIJKL",
            media_type="album",
            enabled=False,
            shuffle=True,
            playback_profile_id="default",
            expected_version=0,
        )
    )
    engine.dispose()
    original = rows(source)["assignment"]
    copy_database(source, destination, recover=True)
    assert rows(destination)["assignment"] == original


@pytest.mark.parametrize(
    "mutation",
    [
        "UPDATE alembic_version SET version_num='0005'",
        "UPDATE recovery_state SET publisher_id='SYNTHETIC_PRIVATE_INVALID_UUID'",
        "UPDATE publication_state SET automatic_enabled=2",
        "UPDATE publication_state SET active_payload='{\"mappings\":[]}'",
        "UPDATE publication_state SET guard_generation=9223372036854775807",
        "UPDATE publication_job SET desired_version=-1 WHERE revision=5",
        "UPDATE owner_session SET csrf_token=x'53594e544845544943'",
        "CREATE TABLE unsupported_private_state (value TEXT)",
        "CREATE VIEW misleading_assignments AS SELECT * FROM assignment",
    ],
)
def test_malformed_profile_cli_failures_are_redacted_and_leave_no_output(
    tmp_path: Path, mutation: str
) -> None:
    source, destination = tmp_path / "SYNTHETIC_PRIVATE_PATH.db", tmp_path / "output.db"
    populated_database(source)
    with sqlite3.connect(source) as connection:
        connection.execute(mutation)
    original = source.read_bytes()
    result = subprocess.run(
        [sys.executable, "-m", "jukelet.backup", "recover", str(source), str(destination)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1
    assert "failed (" in result.stderr and "Traceback" not in result.stderr
    assert "SYNTHETIC_PRIVATE" not in result.stdout + result.stderr
    assert not destination.exists() and source.read_bytes() == original
    assert not list(tmp_path.glob(".jukelet-db-*"))


@pytest.mark.parametrize("invalid", ["duplicate", "nonfinite", "deep"])
def test_invalid_retained_json_is_rejected_without_raw_error_details(
    tmp_path: Path, invalid: str
) -> None:
    from jukelet.backup import copy_database

    source, destination = tmp_path / "source.db", tmp_path / "output.db"
    populated_database(source)
    with sqlite3.connect(source) as connection:
        original = connection.execute(
            "SELECT envelope FROM publication_job WHERE revision=5"
        ).fetchone()[0]
        if invalid == "duplicate":
            malformed = original.replace(
                '"schema_version":1', '"schema_version":1,"schema_version":1'
            )
        elif invalid == "nonfinite":
            malformed = original.replace('"schema_version":1', '"schema_version":1e999')
        else:
            malformed = '{"SYNTHETIC_PRIVATE":' + "[" * 2000 + "0" + "]" * 2000 + "}"
        connection.execute("UPDATE publication_job SET envelope=? WHERE revision=5", (malformed,))
    with pytest.raises(ValueError) as error:
        copy_database(source, destination, recover=True)
    assert "SYNTHETIC_PRIVATE" not in str(error.value)
    assert not destination.exists()


@pytest.mark.parametrize("operation", ["backup", "recover"])
@pytest.mark.parametrize("location", ["job", "active"])
@pytest.mark.parametrize(
    "mappings", [{}, "", []], ids=["empty-object", "empty-string", "empty-list"]
)
def test_retained_payload_requires_a_raw_mapping_list_before_checksum(
    tmp_path: Path, operation: str, location: str, mappings: object
) -> None:
    source, destination = tmp_path / "SYNTHETIC_PRIVATE_SOURCE.db", tmp_path / "output.db"
    database(source)
    # Empty non-list iterables must not borrow the supported empty-list checksum.
    # This independent canonical vector avoids using the permissive iterable helper
    # as the validity oracle for the raw retained JSON container.
    digest = hashlib.sha256(b'{"payload":{"mappings":[]},"schema_version":1}').hexdigest()
    retained = {"mappings": mappings}
    with sqlite3.connect(source) as connection:
        publisher = connection.execute("SELECT publisher_id FROM recovery_state").fetchone()[0]
        envelope = {
            "schema_version": 1,
            "publisher_id": publisher,
            "revision": 1,
            "expected_active_revision": None,
            "payload_checksum": digest,
            "payload": retained if location == "job" else {"mappings": []},
        }
        connection.execute(
            "INSERT INTO publication_job VALUES (1,0,?,?,NULL,'verified',0,?,0)",
            (digest, json.dumps(envelope), "synthetic-time"),
        )
        connection.execute("UPDATE publication_state SET high_water=1")
        if location == "active":
            connection.execute(
                "UPDATE publication_state SET active_revision=1,active_checksum=?,active_payload=?,"
                "active_desired_version=0,established=1",
                (digest, json.dumps(retained)),
            )
    original = source.read_bytes()
    result = subprocess.run(
        [sys.executable, "-m", "jukelet.backup", operation, str(source), str(destination)],
        capture_output=True,
        text=True,
        check=False,
    )
    valid = isinstance(mappings, list)
    assert result.returncode == (0 if valid else 1), result.stdout + result.stderr
    assert destination.exists() is valid
    assert source.read_bytes() == original
    assert "SYNTHETIC_PRIVATE" not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr
    assert not list(tmp_path.glob(".jukelet-db-*"))


def incompatible_schema(path: Path, kind: str) -> None:
    """Ordinary DDL can retain all PRAGMA metadata while changing future behavior."""
    table = "assignment" if kind == "check" else "publication_job"
    with sqlite3.connect(path) as connection:
        original = connection.execute(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?", (table,)
        ).fetchone()[0]
        if kind == "check":
            changed = original.replace(
                "CHECK (media_type IN ('album', 'playlist'))",
                "CHECK (media_type IN ('album', 'playlist') AND enabled=0)",
            )
        else:
            changed = original.replace("desired_version INTEGER", "temporary_marker INTEGER")
            changed = changed.replace("guard_generation INTEGER", "desired_version INTEGER")
            changed = changed.replace("temporary_marker INTEGER", "guard_generation INTEGER")
        assert changed != original
        connection.execute(f'DROP TABLE "{table}"')
        connection.execute(changed)
        assert connection.execute("PRAGMA integrity_check").fetchall() == [("ok",)]


@pytest.mark.parametrize("operation", ["backup", "recover"])
@pytest.mark.parametrize("kind", ["check", "order"])
def test_cli_rejects_constraints_or_ordinals_that_break_future_supported_writes(
    tmp_path: Path, operation: str, kind: str
) -> None:
    source, destination = tmp_path / "SYNTHETIC_PRIVATE_SOURCE.db", tmp_path / "output.db"
    database(source)
    incompatible_schema(source, kind)
    original = source.read_bytes()
    result = subprocess.run(
        [sys.executable, "-m", "jukelet.backup", operation, str(source), str(destination)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1, (
        "An integrity-OK marker cannot establish executable compatibility"
    )
    assert not destination.exists()
    assert source.read_bytes() == original
    assert "SYNTHETIC_PRIVATE" not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr
    assert not list(tmp_path.glob(".jukelet-db-*"))


def supported_future_writes(path: Path) -> None:
    """A supported recovered schema accepts enabled drafts and correct new job fields."""
    engine = open_database(path)
    try:
        migrate(engine)
        for tag in ("synthetic-correction-two-a", "synthetic-correction-two-b"):
            AssignmentStore(engine).put(
                AssignmentInput(
                    ha_tag_id=tag,
                    input="spotify:album:0123456789ABCDEFGHIJKL",
                    media_type="album",
                    enabled=True,
                    shuffle=False,
                    playback_profile_id="default",
                    expected_version=0,
                )
            )
        with engine.begin() as connection:
            revision = queue(connection, recovery=True, base=(None, None))
            assert tuple(
                connection.execute(
                    text(
                        "SELECT desired_version,guard_generation FROM publication_job "
                        "WHERE revision=:n"
                    ),
                    {"n": revision},
                ).one()
            ) == (2, 1)
            connection.execute(
                text("UPDATE publication_job SET state='in_flight' WHERE revision=:n"),
                {"n": revision},
            )
        with PublicationStore(engine).sending(revision):
            pass  # Authority is valid; no transport or HA service is called.
    finally:
        engine.dispose()


def rebuild_table(connection: sqlite3.Connection, table: str, sql: str) -> None:
    data = connection.execute(f'SELECT * FROM "{table}"').fetchall()
    connection.execute(f'DROP TABLE "{table}"')
    connection.execute(sql)
    if data:
        connection.executemany(
            f'INSERT INTO "{table}" VALUES ({",".join("?" for _ in data[0])})', data
        )


@pytest.mark.parametrize("formatted", [False, True])
def test_supported_check_format_and_ordinals_allow_normal_post_recovery_writes(
    tmp_path: Path, formatted: bool
) -> None:
    from jukelet.backup import copy_database

    source, backup, recovered = (
        tmp_path / name for name in ("source.db", "backup.db", "recovered.db")
    )
    database(source)
    if formatted:
        with sqlite3.connect(source) as connection:
            original = connection.execute(
                "SELECT sql FROM sqlite_schema WHERE name='assignment'"
            ).fetchone()[0]
            changed = (
                original.replace("VARCHAR(64)", "TEXT")
                .replace(
                    "playback_profile_id VARCHAR(32)",
                    "playback_profile_id VARCHAR(32) COLLATE BINARY",
                )
                .replace(
                    "CHECK (media_type IN ('album', 'playlist'))",
                    'CONSTRAINT "CHECK(fake)" cHeCk '
                    "((([media_type]) iN (('playlist'), ('album')))) "
                    "/* CHECK(enabled=0) */",
                )
                .replace("CHECK (version > 0)", 'CHECK (("version") > (00)) -- CHECK(enabled=0)\n')
            )
            changed = changed.replace(
                "CHECK (playback_profile_id = 'default')",
                "CHECK ((`PLAYBACK_PROFILE_ID`) == ('default'))",
            )
            rebuild_table(connection, "assignment", changed)
            original = connection.execute(
                "SELECT sql FROM sqlite_schema WHERE name='publication_state'"
            ).fetchone()[0]
            rebuild_table(
                connection,
                "publication_state",
                original.replace("CHECK(id=1)", "cHeCk (([id]) == (01))"),
            )
    original_bytes = source.read_bytes()
    copy_database(source, backup, recover=False)
    copy_database(backup, recovered, recover=True)
    supported_future_writes(recovered)
    assert source.read_bytes() == original_bytes


@pytest.mark.parametrize("operation", ["backup", "recover"])
@pytest.mark.parametrize("kind", ["check", "order"])
def test_incompatible_schema_never_replaces_an_existing_open_destination(
    tmp_path: Path, operation: str, kind: str
) -> None:
    source, target = tmp_path / "source.db", tmp_path / "retained.db"
    database(source)
    incompatible_schema(source, kind)
    database(target)
    original_source, original_target = source.read_bytes(), target.read_bytes()
    with sqlite3.connect(target) as running:
        result = subprocess.run(
            [sys.executable, "-m", "jukelet.backup", operation, str(source), str(target)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 1 and "FileExistsError" in result.stderr
        assert running.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    assert source.read_bytes() == original_source and target.read_bytes() == original_target


@pytest.mark.parametrize("operation", ["backup", "recover"])
@pytest.mark.parametrize(
    "kind",
    [
        "upper-media",
        "upper-profile",
        "non-ascii-identifier",
        "collation",
        "duplicate",
        "missing",
        "additional",
        "combined",
        "deep",
        "oversized",
    ],
)
def test_unknown_constraint_shapes_fail_closed_with_redacted_cli_errors(
    tmp_path: Path, operation: str, kind: str
) -> None:
    source, target = tmp_path / "SYNTHETIC_PRIVATE_SOURCE.db", tmp_path / "output.db"
    database(source)
    with sqlite3.connect(source) as connection:
        original = connection.execute(
            "SELECT sql FROM sqlite_schema WHERE name='assignment'"
        ).fetchone()[0]
        if kind == "upper-media":
            changed = original.replace("'album', 'playlist'", "'ALBUM', 'PLAYLIST'")
        elif kind == "upper-profile":
            changed = original.replace("'default'", "'DEFAULT'")
        elif kind == "non-ascii-identifier":
            # SQLite folds only ASCII identifier case. Its double-quoted-string
            # fallback must not turn a different Unicode name into the known column.
            changed = original.replace(
                "playback_profile_id = 'default'", "\"playbacK_profile_id\" = 'default'"
            )
        elif kind == "collation":
            changed = original.replace(
                "playback_profile_id VARCHAR(32)",
                "playback_profile_id VARCHAR(32) COLLATE NOCASE",
            )
        elif kind == "duplicate":
            changed = original.replace(
                "CHECK (version > 0)", "CHECK (version > 0), CHECK(version>0)"
            )
        elif kind == "missing":
            changed = original.replace("CHECK (version > 0),", "")
        elif kind == "additional":
            changed = original.replace(
                "CHECK (version > 0)", "CHECK (version > 0), CHECK(enabled=0)"
            )
        elif kind == "combined":
            changed = original.replace(
                "CHECK (version > 0)", "CHECK(version>0 AND playback_profile_id='default')"
            )
        elif kind == "deep":
            changed = original.replace(
                "CHECK (version > 0)", "CHECK(" + "(" * 32 + "version>0" + ")" * 32 + ")"
            )
        else:
            changed = original.replace(
                "CHECK (version > 0)", "CHECK(version>0)/*" + "x" * 65536 + "*/"
            )
        rebuild_table(connection, "assignment", changed)
        assert connection.execute("PRAGMA integrity_check").fetchall() == [("ok",)]
    before = source.read_bytes()
    result = subprocess.run(
        [sys.executable, "-m", "jukelet.backup", operation, str(source), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1 and not target.exists()
    assert "SYNTHETIC_PRIVATE" not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr
    assert source.read_bytes() == before
