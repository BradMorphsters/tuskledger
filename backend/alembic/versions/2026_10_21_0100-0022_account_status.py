"""accounts.status + accounts.closed_at

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-21

Why: when a bank account is closed, deleting it (or unlinking the Plaid
item) throws away its transaction history. A closed account should stay
in the DB so its history keeps showing up in Transactions, Spending and
past Net Worth, while it drops out of "current" views.

  - status: 'active' (default) | 'closed'
  - closed_at: the date the account was closed (NULL while active)

Closed accounts hold a zero balance, sync_service leaves that balance
alone, and the stale-account / connection-health alerts skip them.
"""
from alembic import op
import sqlalchemy as sa


revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.add_column(
            sa.Column("status", sa.String(), nullable=False, server_default="active")
        )
        batch.add_column(sa.Column("closed_at", sa.Date(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("accounts") as batch:
        batch.drop_column("closed_at")
        batch.drop_column("status")
