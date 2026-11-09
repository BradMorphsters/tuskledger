"""manual_assets: interest_rate, monthly_payment, loan_tranches

Revision ID: 0023
Revises: 0022
Create Date: 2026-11-09

Why: manual liabilities (student, auto, personal loans) had no terms in
the database, so the Loans page could only amortize them after the user
typed a rate and payment into browser-local overrides, and a loan made
of several pieces (federal student loans are typically one line per
disbursement, each with its own rate and payment) collapsed into one
blended rate, which misstates the payoff timeline.

  - interest_rate:   annual rate as a fraction (0.0595 = 5.95%)
  - monthly_payment: total scheduled monthly payment
  - loan_tranches:   optional JSON list of {label, balance, rate, payment};
                     when present the Loans page amortizes each piece on
                     its own schedule and sums them month by month.
"""
from alembic import op
import sqlalchemy as sa


revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("manual_assets") as batch:
        batch.add_column(sa.Column("interest_rate", sa.Float(), nullable=True))
        batch.add_column(sa.Column("monthly_payment", sa.Float(), nullable=True))
        batch.add_column(sa.Column("loan_tranches", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("manual_assets") as batch:
        batch.drop_column("loan_tranches")
        batch.drop_column("monthly_payment")
        batch.drop_column("interest_rate")
