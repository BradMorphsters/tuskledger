"""transactions.is_transfer flag

Marks account-to-account transfers and credit-card/loan payments so they
don't pollute the spending rollup. Populated by the transfer detector
after each sync; defaults to false.

Revision ID: 0005
Revises: 0004
Create Date: 2026-04-24
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # server_default so existing rows get False without a separate UPDATE.
    op.add_column(
        "transactions",
        sa.Column(
            "is_transfer",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("transactions", "is_transfer")
