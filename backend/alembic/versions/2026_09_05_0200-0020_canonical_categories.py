"""Fold existing rows onto the canonical category taxonomy

Revision ID: 0020
Revises: 0019
Create Date: 2026-09-05

Why: two importers wrote category labels that don't exist in
STANDARD_CATEGORIES — the CSV classifier's "Food & Drink" / "Utilities" /
"Healthcare" / "Other", and Plaid's unmapped LOAN_DISBURSEMENTS falling
through as "Loan Disbursements". The same spending therefore lived in
two near-duplicate buckets (Food & Drink beside Food & Dining), and no
budget line could see the stray one. The write paths now go through
categories.canonical_category(); this migration brings the rows that
were written before it into line.

Also: transfer-flagged rows whose category is "Income" get
custom_category = "Transfer", matching what transfer_detector now does
at flag time — a CC autopay credit has no business in the Income list.

Data-only. The renames apply to `category` (the importer's label) AND to
`custom_category`, because the Apple Card load script wrote its labels
into custom_category — those 47 "Food & Drink" rows were never a user's
choice (the label isn't in any dropdown). Every alias here is a spelling
variant of a standard category, so no user intent is lost. The transfer
relabel touches custom_category only where it is NULL. Safe to re-run;
downgrade is a no-op because the original labels carried no information
worth restoring.
"""
from alembic import op
import sqlalchemy as sa


revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


# (old label, canonical label) — mirrors categories.CATEGORY_ALIASES for
# the labels actually observed in the wild. Kept inline so the migration
# stays reproducible even if the alias table grows later.
_RENAMES = [
    ("Food & Drink", "Food & Dining"),
    ("Utilities", "Bills & Utilities"),
    ("Healthcare", "Health & Medical"),
    ("Other", "Miscellaneous"),
    ("Loan Disbursements", "Transfer"),
]


def upgrade() -> None:
    conn = op.get_bind()
    for old, new in _RENAMES:
        conn.execute(
            sa.text("UPDATE transactions SET category = :new WHERE category = :old"),
            {"old": old, "new": new},
        )
        conn.execute(
            sa.text(
                "UPDATE transactions SET custom_category = :new WHERE custom_category = :old"
            ),
            {"old": old, "new": new},
        )
        conn.execute(
            sa.text(
                "UPDATE transaction_splits SET category = :new WHERE category = :old"
            ),
            {"old": old, "new": new},
        )
    conn.execute(
        sa.text(
            "UPDATE transactions SET custom_category = 'Transfer' "
            "WHERE is_transfer = 1 AND custom_category IS NULL AND category = 'Income'"
        )
    )


def downgrade() -> None:
    # Intentionally a no-op: see module docstring.
    pass
