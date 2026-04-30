"""accounts.roth_split_pct column

Revision ID: 0015
Revises: 0014
Create Date: 2026-04-27

Why: many 401(k) plans let participants split contributions between
pre-tax (traditional) and Roth designations within the same account.
Plaid syncs the TOTAL balance — there's no per-source breakdown in the
account-level data — but the user often knows the ratio from their plan
portal (most major recordkeepers show source breakdowns).

The previous schema forced one bucket per account, which mis-classified
mixed accounts. Example: a 401(k) showing $100k total but where the
plan portal reveals ~60% is in Roth 401(k) — the simulator would treat
the whole balance as tax-deferred, materially overstating future RMDs
and lifetime tax.

Strategy: add `roth_split_pct` as a nullable Float (0.0-1.0). When set,
the retirement aggregator splits the account's balance:
  roth_share       = current_balance * roth_split_pct
  remaining_share  = current_balance * (1 - roth_split_pct)
The remaining_share goes into the account's primary `tax_bucket`
(typically tax_deferred), the roth_share goes to the roth bucket. NULL
preserves the old behavior — whole balance in tax_bucket as-is.
"""
from alembic import op
import sqlalchemy as sa


revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "accounts",
        sa.Column("roth_split_pct", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("accounts", "roth_split_pct")
