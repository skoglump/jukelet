"""SQLite connection and versioned migration boundary."""

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, String, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class OwnerSession(Base):
    __tablename__ = "owner_session"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[int]


def open_database(path: Path) -> Engine:
    path.parent.mkdir(parents=True, exist_ok=True)
    return create_engine(
        "sqlite+pysqlite:///" + str(path.resolve()),
        connect_args={"check_same_thread": False, "timeout": 10},
        hide_parameters=True,
    )


def migrate(engine: Engine) -> None:
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
