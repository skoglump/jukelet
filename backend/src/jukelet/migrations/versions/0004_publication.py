"""Immutable publication jobs and monotonic app publication history."""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""CREATE TABLE publication_state (
        id INTEGER PRIMARY KEY CHECK(id=1), high_water INTEGER NOT NULL DEFAULT 0,
        active_revision INTEGER, active_checksum TEXT, active_payload TEXT,
        active_desired_version INTEGER, established BOOLEAN NOT NULL DEFAULT 0,
        automatic_enabled BOOLEAN NOT NULL DEFAULT 0, healthy BOOLEAN NOT NULL DEFAULT 0,
        last_error TEXT, observed TEXT, observed_at TEXT,
        guard_generation INTEGER NOT NULL DEFAULT 0
    )""")
    op.execute("INSERT INTO publication_state(id) VALUES (1)")
    op.execute("""CREATE TABLE publication_job (
        revision INTEGER PRIMARY KEY, desired_version INTEGER NOT NULL,
        checksum TEXT NOT NULL, envelope TEXT NOT NULL, base_checksum TEXT,
        state TEXT NOT NULL, recovery BOOLEAN NOT NULL, created_at TEXT NOT NULL,
        guard_generation INTEGER NOT NULL
    )""")


def downgrade() -> None:
    op.drop_table("publication_job")
    op.drop_table("publication_state")
