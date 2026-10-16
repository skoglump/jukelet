"""Create owner sessions; domain schemas belong to later milestones."""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "owner_session",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("csrf_token", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("owner_session")
