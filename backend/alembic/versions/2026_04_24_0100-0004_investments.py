"""investments: securities, holdings, investment_transactions

Adds the three tables needed for Plaid's Investments product. Securities
are keyed on plaid_security_id (stable across ticker/name changes).
Holdings are (account, security) unique. Investment transactions have their
own table to keep them out of the spending/budget stream.

Revision ID: 0004
Revises: 0003
Create Date: 2026-04-24
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "securities",
        sa.Column("plaid_security_id", sa.String(), primary_key=True),
        # index=True auto-creates ix_securities_ticker_symbol — don't ALSO op.create_index it.
        sa.Column("ticker_symbol", sa.String(), nullable=True, index=True),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("type", sa.String(), nullable=True),
        sa.Column("iso_currency_code", sa.String(), nullable=True),
        sa.Column("cusip", sa.String(), nullable=True),
        sa.Column("isin", sa.String(), nullable=True),
        sa.Column("institution_security_id", sa.String(), nullable=True),
        sa.Column("institution_id", sa.String(), nullable=True),
        sa.Column("close_price", sa.Float(), nullable=True),
        sa.Column("close_price_as_of", sa.DateTime(), nullable=True),
        sa.Column("is_cash_equivalent", sa.Boolean(), server_default=sa.false()),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )

    op.create_table(
        "holdings",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "account_id",
            sa.Integer(),
            sa.ForeignKey("accounts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "plaid_security_id",
            sa.String(),
            sa.ForeignKey("securities.plaid_security_id"),
            nullable=False,
            index=True,
        ),
        sa.Column("quantity", sa.Float(), nullable=False, server_default="0"),
        sa.Column("institution_price", sa.Float(), nullable=True),
        sa.Column("institution_price_as_of", sa.DateTime(), nullable=True),
        sa.Column("institution_value", sa.Float(), nullable=True),
        sa.Column("cost_basis", sa.Float(), nullable=True),
        sa.Column("iso_currency_code", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
        sa.UniqueConstraint("account_id", "plaid_security_id", name="uq_holdings_account_security"),
    )

    op.create_table(
        "investment_transactions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("plaid_investment_transaction_id", sa.String(), nullable=False, unique=True, index=True),
        sa.Column(
            "account_id",
            sa.Integer(),
            sa.ForeignKey("accounts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "plaid_security_id",
            sa.String(),
            sa.ForeignKey("securities.plaid_security_id"),
            nullable=True,
            index=True,
        ),
        sa.Column("date", sa.Date(), nullable=False, index=True),
        sa.Column("name", sa.String(), nullable=True),
        sa.Column("type", sa.String(), nullable=True, index=True),
        sa.Column("subtype", sa.String(), nullable=True),
        sa.Column("quantity", sa.Float(), nullable=True),
        sa.Column("price", sa.Float(), nullable=True),
        sa.Column("amount", sa.Float(), nullable=True),
        sa.Column("fees", sa.Float(), nullable=True),
        sa.Column("iso_currency_code", sa.String(), nullable=True),
        sa.Column("cancel_transaction_id", sa.String(), nullable=True),
        sa.Column("pending", sa.Boolean(), server_default=sa.false()),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )


def downgrade() -> None:
    op.drop_table("investment_transactions")
    op.drop_table("holdings")
    op.drop_table("securities")
