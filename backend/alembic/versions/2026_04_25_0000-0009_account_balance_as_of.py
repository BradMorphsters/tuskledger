"""accounts.balance_as_of — snapshot date for manual account balances

Distinguishes "live" Plaid balances from "as-of" manual balances on the UI.
Nullable; populated when manual accounts are created or their balance is
updated. Plaid sync paths leave it NULL.

Revision ID: 0009
Revises: 0008
Create Date: 2026-04-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "accounts",
        sa.Column("balance_as_of", sa.Date(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("accounts", "balance_as_of")
