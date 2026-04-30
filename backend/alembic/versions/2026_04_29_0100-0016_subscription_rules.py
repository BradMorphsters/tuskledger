"""subscription_rules table

Revision ID: 0016
Revises: 0015
Create Date: 2026-04-29

Why: the recurrence detector classifies merchants as subscriptions
based on cadence + amount stability + occurrence count. That works
for the common case but misses two specific user pain points:

  1. Brand-new SaaS signups with only 1 charge so far → won't be
     flagged until a second charge proves recurrence. The user wants
     to track them from day one.
  2. False positives where a non-subscription merchant happens to hit
     the same monthly amount (Apple, Amazon, etc.) → the user wants
     to silence them.

Mirrors the BusinessRule + CategoryRule shape (pattern + priority +
created_at) plus a `kind` column with two values:
  - 'force_subscription'     → always treat matching merchants as subs
  - 'force_not_subscription' → never treat matching merchants as subs
The detector applies these as a final overlay — auto-detection runs,
then rules adjust the subscription flag per-merchant.
"""
from alembic import op
import sqlalchemy as sa


revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "subscription_rules",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("pattern", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("priority", sa.Integer(), default=100),
        sa.Column("notes", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_subscription_rules_pattern",
        "subscription_rules",
        ["pattern"],
    )


def downgrade() -> None:
    op.drop_index("ix_subscription_rules_pattern", "subscription_rules")
    op.drop_table("subscription_rules")
