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
    assert set(inspect(reopened).get_table_names()) == {"alembic_version", "owner_session"}
    with reopened.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM owner_session")) == 1
        assert connection.scalar(text("SELECT version_num FROM alembic_version")) == "0001"
    reopened.dispose()
