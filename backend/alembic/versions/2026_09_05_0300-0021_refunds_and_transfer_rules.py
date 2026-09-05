"""transactions.is_refund + transfer_rules table

Revision ID: 0021
Revises: 0020
Create Date: 2026-09-05

Why: two leaks in "money in vs money out".

  - Refunds. Every inflow was income. A store return or a statement
    credit is not income; it is negative spend in the category it came
    from. `is_refund` is a derived flag (services/refund_detector.py)
    that the headline aggregations use to (a) keep the row out of income
    and (b) net it against its category. Backfilled here with the same
    rule the detector uses, so the numbers change once, now, rather than
    drifting as syncs happen.

  - Unpaired transfer-outs. Money sent to an account the user hasn't
    linked (external savings, a relative, an unlinked brokerage) has no
    counterpart row, so the pairing pass can't see it, and Plaid's
    TRANSFER_OUT label alone isn't proof. `transfer_rules` holds the
    user's own payee patterns; the detector consults them alongside its
    built-in issuer rules. Empty on creation — rules are made from the UI.
"""
from alembic import op
import sqlalchemy as sa


revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("transactions") as batch:
        batch.add_column(
            sa.Column("is_refund", sa.Boolean(), nullable=False, server_default="0")
        )
    op.create_table(
        "transfer_rules",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("pattern", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ux_transfer_rules_pattern", "transfer_rules", ["pattern"], unique=True)

    # Backfill — mirrors refund_detector.is_refund_row exactly.
    op.get_bind().execute(sa.text(
        "UPDATE transactions SET is_refund = 1 "
        "WHERE amount < 0 AND is_transfer = 0 "
        "AND COALESCE(custom_category, category) IS NOT NULL "
        "AND COALESCE(custom_category, category) NOT IN ('Income', 'Transfer')"
    ))


def downgrade() -> None:
    op.drop_index("ux_transfer_rules_pattern", "transfer_rules")
    op.drop_table("transfer_rules")
    with op.batch_alter_table("transactions") as batch:
        batch.drop_column("is_refund")
