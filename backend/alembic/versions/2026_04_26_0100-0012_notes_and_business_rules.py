"""transactions.notes column + business_rules table

Revision ID: 0012
Revises: 0011
Create Date: 2026-04-26

Two related additions in one migration:

1. transactions.notes (TEXT, nullable) — free-text user notes per
   transaction. Used by the new TransactionDrawer notes field.

2. business_rules table — pattern-based business tagging. Each row
   maps a substring (matched against name + merchant_name) to a
   business_id, optionally also setting a category. Mirrors the
   existing category_rules table; kept separate so the rule sets
   evolve independently and a single transaction can be tagged by
   one of each without coupling.
"""
from alembic import op
import sqlalchemy as sa


revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) transactions.notes
    op.add_column(
        "transactions",
        sa.Column("notes", sa.Text(), nullable=True),
    )

    # 2) business_rules — same shape as category_rules but for business_id.
    op.create_table(
        "business_rules",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("pattern", sa.String(), nullable=False),         # case-insensitive substring
        sa.Column("business_id", sa.Integer(), sa.ForeignKey("businesses.id"), nullable=False),
        sa.Column("priority", sa.Integer(), server_default="100"),  # lower = matched first
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.current_timestamp()),
    )
    op.create_index("ix_business_rules_pattern", "business_rules", ["pattern"])


def downgrade() -> None:
    op.drop_index("ix_business_rules_pattern", table_name="business_rules")
    op.drop_table("business_rules")
    op.drop_column("transactions", "notes")
