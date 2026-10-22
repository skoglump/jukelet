"""Stable local publisher identity and a durable, fail-closed recovery guard."""

import uuid

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "recovery_state",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("publisher_id", sa.String(36), nullable=False),
        sa.Column("reconciliation_required", sa.Boolean(), nullable=False),
    )
    op.get_bind().execute(
        sa.text("INSERT INTO recovery_state VALUES (1, :publisher, 0)"),
        {"publisher": str(uuid.uuid4())},
    )


def downgrade() -> None:
    op.drop_table("recovery_state")
