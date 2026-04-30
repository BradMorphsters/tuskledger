"""database indexes for hot query paths

Revision ID: 0011
Revises: 0010
Create Date: 2026-04-25
"""
from alembic import op


revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # transactions.date — heavily filtered by date ranges across analytics
    op.create_index("ix_transactions_date", "transactions", ["date"])

    # transactions.is_transfer — filtered in basically every aggregation
    op.create_index("ix_transactions_is_transfer", "transactions", ["is_transfer"])

    # transactions.business_id — used by business reports
    op.create_index("ix_transactions_business_id", "transactions", ["business_id"])

    # Composite index transactions(account_id, date) is more useful than
    # single-column account_id for the common query pattern of
    # "fetch all transactions for an account in a date range".
    # Note: account_id already has an implicit FK index, but we're creating
    # a composite that covers both columns for efficient range queries.
    op.create_index("ix_transactions_account_id_date", "transactions", ["account_id", "date"])


def downgrade() -> None:
    op.drop_index("ix_transactions_account_id_date", table_name="transactions")
    op.drop_index("ix_transactions_business_id", table_name="transactions")
    op.drop_index("ix_transactions_is_transfer", table_name="transactions")
    op.drop_index("ix_transactions_date", table_name="transactions")
