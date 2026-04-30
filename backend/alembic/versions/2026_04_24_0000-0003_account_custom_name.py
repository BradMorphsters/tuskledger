"""accounts.custom_name — user-provided alias for display

Plaid overwrites accounts.name on every sync, so we keep that as the source
of truth and add a nullable custom_name that the UI prefers when set.

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-24
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "accounts",
        sa.Column("custom_name", sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("accounts", "custom_name")
