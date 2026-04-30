"""mortgage_details + credit_card_details tables

Stores Plaid Liabilities data per account. 1:1 with Account. Refreshed
every sync; deletes when the Plaid item is removed (CASCADE).

Revision ID: 0006
Revises: 0005
Create Date: 2026-04-24
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "mortgage_details",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "account_id",
            sa.Integer(),
            sa.ForeignKey("accounts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("account_number", sa.String(), nullable=True),
        sa.Column("interest_rate_percentage", sa.Float(), nullable=True),
        sa.Column("interest_rate_type", sa.String(), nullable=True),
        sa.Column("loan_term", sa.String(), nullable=True),
        sa.Column("loan_type_description", sa.String(), nullable=True),
        sa.Column("origination_date", sa.Date(), nullable=True),
        sa.Column("origination_principal_amount", sa.Float(), nullable=True),
        sa.Column("maturity_date", sa.Date(), nullable=True),
        sa.Column("next_monthly_payment", sa.Float(), nullable=True),
        sa.Column("next_payment_due_date", sa.Date(), nullable=True),
        sa.Column("last_payment_amount", sa.Float(), nullable=True),
        sa.Column("last_payment_date", sa.Date(), nullable=True),
        sa.Column("past_due_amount", sa.Float(), nullable=True),
        sa.Column("current_late_fee", sa.Float(), nullable=True),
        sa.Column("ytd_interest_paid", sa.Float(), nullable=True),
        sa.Column("ytd_principal_paid", sa.Float(), nullable=True),
        sa.Column("escrow_balance", sa.Float(), nullable=True),
        sa.Column("has_pmi", sa.Boolean(), nullable=True),
        sa.Column("has_prepayment_penalty", sa.Boolean(), nullable=True),
        sa.Column("property_street", sa.String(), nullable=True),
        sa.Column("property_city", sa.String(), nullable=True),
        sa.Column("property_region", sa.String(), nullable=True),
        sa.Column("property_postal_code", sa.String(), nullable=True),
        sa.Column("property_country", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
        sa.UniqueConstraint("account_id", name="uq_mortgage_details_account"),
    )

    op.create_table(
        "credit_card_details",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "account_id",
            sa.Integer(),
            sa.ForeignKey("accounts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("aprs", sa.JSON(), nullable=True),
        sa.Column("is_overdue", sa.Boolean(), nullable=True),
        sa.Column("last_statement_balance", sa.Float(), nullable=True),
        sa.Column("last_statement_issue_date", sa.Date(), nullable=True),
        sa.Column("last_payment_amount", sa.Float(), nullable=True),
        sa.Column("last_payment_date", sa.Date(), nullable=True),
        sa.Column("minimum_payment_amount", sa.Float(), nullable=True),
        sa.Column("next_payment_due_date", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
        sa.UniqueConstraint("account_id", name="uq_credit_card_details_account"),
    )


def downgrade() -> None:
    op.drop_table("credit_card_details")
    op.drop_table("mortgage_details")
