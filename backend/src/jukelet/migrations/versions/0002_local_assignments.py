"""Local drafts, durable tombstone versions, and bounded diagnostic audit."""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "assignment",
        sa.Column("tag_key", sa.String(64), primary_key=True),
        sa.Column("ha_tag_id", sa.String(512), nullable=False, unique=True),
        sa.Column("spotify_uri", sa.String(64), nullable=False),
        sa.Column("media_type", sa.String(8), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("shuffle", sa.Boolean(), nullable=False),
        sa.Column("playback_profile_id", sa.String(32), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False),
        sa.CheckConstraint("media_type IN ('album', 'playlist')"),
        sa.CheckConstraint("version > 0"),
        sa.CheckConstraint("playback_profile_id = 'default'"),
    )
    op.create_table(
        "assignment_revision",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
    )
    op.execute("INSERT INTO assignment_revision VALUES (1, 0)")
    op.create_table(
        "assignment_audit",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("tag_key", sa.String(64), nullable=True),
        sa.Column("affected", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("assignment_audit")
    op.drop_table("assignment_revision")
    op.drop_table("assignment")
