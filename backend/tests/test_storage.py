from pathlib import Path

from sqlalchemy import inspect, text

from jukelet.storage import migrate, open_database


def test_migration_is_repeatable_and_preserves_data(tmp_path: Path) -> None:
    engine = open_database(tmp_path / "jukelet.db")
    migrate(engine)
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO owner_session VALUES (:token, :csrf, :expires)"),
            {"token": "synthetic-token-hash", "csrf": "synthetic-csrf", "expires": 123},
        )
    engine.dispose()
    reopened = open_database(tmp_path / "jukelet.db")
    migrate(reopened)
    assert set(inspect(reopened).get_table_names()) == {
        "alembic_version",
        "owner_session",
        "assignment",
        "assignment_revision",
        "assignment_audit",
        "recovery_state",
        "publication_state",
        "publication_job",
    }
    with reopened.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM owner_session")) == 1
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0004"
    reopened.dispose()


def test_upgrade_existing_session_schema(tmp_path: Path) -> None:
    from alembic import command
    from alembic.config import Config

    import jukelet.storage

    engine = open_database(tmp_path / "upgrade.db")
    config = Config()
    config.set_main_option(
        "script_location", str(Path(jukelet.storage.__file__).parent / "migrations")
    )
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0001")
        connection.execute(text("INSERT INTO owner_session VALUES ('synthetic', 'csrf', 123)"))
    migrate(engine)
    with engine.connect() as connection:
        assert connection.scalar(text("SELECT token_hash FROM owner_session")) == "synthetic"
        assert connection.scalar(text("SELECT revision FROM assignment_revision")) == 0
        assert connection.scalar(text("SELECT count(*) FROM assignment")) == 0
        assert connection.scalar(text("SELECT reconciliation_required FROM recovery_state")) == 0
        assert connection.scalar(text("SELECT length(publisher_id) FROM recovery_state")) == 36
    engine.dispose()
