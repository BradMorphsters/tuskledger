"""baseline schema — all tables as of April 2026

This revision captures the schema that existed before Alembic was adopted.
For existing installs, the startup code in `app.main` will `alembic stamp`
this revision so the DB is considered "at baseline" without re-running DDL
against already-populated tables.

Revision ID: 0001
Revises:
Create Date: 2026-04-18
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("username", sa.String, nullable=False, unique=True),
        sa.Column("password_hash", sa.String, nullable=False),
        sa.Column("totp_secret", sa.String, nullable=False),
        sa.Column("totp_verified", sa.Boolean, nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime),
        sa.Column("last_login_at", sa.DateTime, nullable=True),
    )

    op.create_table(
        "businesses",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String, nullable=False, unique=True),
        sa.Column("color", sa.String, nullable=False, server_default="#6366f1"),
        sa.Column("icon", sa.String, nullable=False, server_default="briefcase"),
        sa.Column("description", sa.String, nullable=True),
        sa.Column("is_active", sa.Integer, server_default=sa.text("1")),
        sa.Column("created_at", sa.DateTime),
        sa.Column("updated_at", sa.DateTime),
    )

    op.create_table(
        "plaid_items",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("item_id", sa.String, nullable=False, unique=True),
        sa.Column("access_token", sa.String, nullable=False),
        sa.Column("institution_id", sa.String, nullable=True),
        sa.Column("institution_name", sa.String, nullable=True),
        sa.Column("cursor", sa.String, nullable=True),
        sa.Column("created_at", sa.DateTime),
        sa.Column("updated_at", sa.DateTime),
    )
    op.create_index("ix_plaid_items_item_id", "plaid_items", ["item_id"], unique=True)

    op.create_table(
        "accounts",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("plaid_account_id", sa.String, nullable=True, unique=True),
        sa.Column("plaid_item_id", sa.Integer, sa.ForeignKey("plaid_items.id"), nullable=True),
        sa.Column("name", sa.String, nullable=False),
        sa.Column("official_name", sa.String, nullable=True),
        sa.Column("type", sa.String, nullable=False),
        sa.Column("subtype", sa.String, nullable=True),
        sa.Column("institution_name", sa.String, nullable=True),
        sa.Column("mask", sa.String, nullable=True),
        sa.Column("current_balance", sa.Float, server_default=sa.text("0")),
        sa.Column("available_balance", sa.Float, nullable=True),
        sa.Column("currency", sa.String, server_default="USD"),
        sa.Column("created_at", sa.DateTime),
        sa.Column("updated_at", sa.DateTime),
    )
    op.create_index("ix_accounts_plaid_account_id", "accounts", ["plaid_account_id"], unique=True)

    op.create_table(
        "transactions",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("plaid_transaction_id", sa.String, nullable=True, unique=True),
        sa.Column("account_id", sa.Integer, sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("name", sa.String, nullable=False),
        sa.Column("merchant_name", sa.String, nullable=True),
        sa.Column("amount", sa.Float, nullable=False),
        sa.Column("currency", sa.String, server_default="USD"),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("pending", sa.Boolean, server_default=sa.text("0")),
        sa.Column("category", sa.String, nullable=True),
        sa.Column("subcategory", sa.String, nullable=True),
        sa.Column("custom_category", sa.String, nullable=True),
        sa.Column("business_id", sa.Integer, sa.ForeignKey("businesses.id"), nullable=True),
        sa.Column("created_at", sa.DateTime),
        sa.Column("updated_at", sa.DateTime),
    )
    op.create_index(
        "ix_transactions_plaid_transaction_id", "transactions", ["plaid_transaction_id"], unique=True
    )

    op.create_table(
        "budgets",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("month", sa.Integer, nullable=False),
        sa.Column("year", sa.Integer, nullable=False),
        sa.Column("total_limit", sa.Float, nullable=True),
        sa.Column("created_at", sa.DateTime),
        sa.Column("updated_at", sa.DateTime),
    )

    op.create_table(
        "budget_categories",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("budget_id", sa.Integer, sa.ForeignKey("budgets.id"), nullable=False),
        sa.Column("category", sa.String, nullable=False),
        sa.Column("limit_amount", sa.Float, nullable=False),
        sa.Column("created_at", sa.DateTime),
    )

    op.create_table(
        "net_worth_snapshots",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("date", sa.Date, nullable=False, unique=True),
        sa.Column("total_assets", sa.Float, server_default=sa.text("0")),
        sa.Column("total_liabilities", sa.Float, server_default=sa.text("0")),
        sa.Column("net_worth", sa.Float, server_default=sa.text("0")),
        sa.Column("account_balances", sa.JSON, nullable=True),
        sa.Column("created_at", sa.DateTime),
    )
    op.create_index("ix_net_worth_snapshots_date", "net_worth_snapshots", ["date"], unique=True)

    op.create_table(
        "category_rules",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("pattern", sa.String, nullable=False, unique=True),
        sa.Column("category", sa.String, nullable=False),
        sa.Column("created_at", sa.DateTime),
    )


def downgrade() -> None:
    op.drop_table("category_rules")
    op.drop_index("ix_net_worth_snapshots_date", table_name="net_worth_snapshots")
    op.drop_table("net_worth_snapshots")
    op.drop_table("budget_categories")
    op.drop_table("budgets")
    op.drop_index("ix_transactions_plaid_transaction_id", table_name="transactions")
    op.drop_table("transactions")
    op.drop_index("ix_accounts_plaid_account_id", table_name="accounts")
    op.drop_table("accounts")
    op.drop_index("ix_plaid_items_item_id", table_name="plaid_items")
    op.drop_table("plaid_items")
    op.drop_table("businesses")
    op.drop_table("users")
