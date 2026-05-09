"""custom_categories table for user-defined categories

Revision ID: 0018
Revises: 0017
Create Date: 2026-05-09

Why: the Operator wants to add categories beyond the hardcoded
STANDARD_CATEGORIES list (Pet Care, Hobbies, Cabin Maintenance, etc.)
without forking the codebase. See models/custom_category.py for the
full rationale and the merge model used at the API layer.

Schema notes:
  - `name` is unique-and-indexed so a duplicate "Pet Care" can't
    exist twice and the dropdown render stays clean.
  - `icon` is a string (typically a single emoji). Default "📦"
    so a row always renders with *something* even if the Operator
    doesn't supply one.
  - `sort_order` is for future display-order control. v1 has no UI
    for it; the Operator edits via SQL if they care today.
"""
from alembic import op
import sqlalchemy as sa


revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "custom_categories",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("icon", sa.String(), nullable=False, server_default="📦"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_custom_categories_name",
        "custom_categories",
        ["name"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_custom_categories_name", "custom_categories")
    op.drop_table("custom_categories")
