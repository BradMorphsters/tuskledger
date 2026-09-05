"""budgets.inherited_from_budget_id + unique (month, year)

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-05

Why: budgets now carry forward automatically when a new month starts
with no budget of its own (see services/budget_carry.py). Two things
that needs from the schema:

  - `inherited_from_budget_id` — which prior month's budget was cloned.
    Stays set until the user saves the month themselves, so the Budgets
    page can say "carried forward from August — edit anytime" and stop
    saying it once the numbers are the user's own. Plain integer, no FK:
    a later hard-delete of the source month must not cascade into (or
    be blocked by) the months that were cloned from it.

  - a UNIQUE index on (month, year). The carry-forward runs from three
    places (startup, a daily job, and lazily on GET) and two of them can
    race on the first request of a new month. Without the index that
    race produces two September budgets and every consumer that does
    `filter_by(month, year).first()` picks one at random. With it, the
    loser gets an IntegrityError and simply re-reads the winner.
    Existing data is one row per month, so the index applies cleanly.
"""
from alembic import op
import sqlalchemy as sa


revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("budgets") as batch:
        batch.add_column(
            sa.Column("inherited_from_budget_id", sa.Integer(), nullable=True)
        )
    op.create_index(
        "ux_budgets_month_year",
        "budgets",
        ["month", "year"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ux_budgets_month_year", "budgets")
    with op.batch_alter_table("budgets") as batch:
        batch.drop_column("inherited_from_budget_id")
