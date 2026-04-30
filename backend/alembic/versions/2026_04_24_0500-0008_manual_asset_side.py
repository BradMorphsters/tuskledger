"""manual_assets.side — asset vs liability

Generalizes the ManualAsset table to hold either side of the balance
sheet. Existing rows get 'asset' by default so Net Worth math doesn't
flip. New liability entries (student loans awaiting Plaid support,
personal loans, tax bills) use 'liability'.

Revision ID: 0008
Revises: 0007
Create Date: 2026-04-24
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "manual_assets",
        sa.Column(
            "side",
            sa.String(),
            nullable=False,
            server_default=sa.text("'asset'"),
        ),
    )


def downgrade() -> None:
    op.drop_column("manual_assets", "side")
