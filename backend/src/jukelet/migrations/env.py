"""Migrations use the application's connection; no separate credential configuration."""

from alembic import context

from jukelet.storage import Base

context.configure(connection=context.config.attributes["connection"], target_metadata=Base.metadata)
with context.begin_transaction():
    context.run_migrations()
