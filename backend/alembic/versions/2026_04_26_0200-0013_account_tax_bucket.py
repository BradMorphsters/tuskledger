"""accounts.tax_bucket column + pre-labeling pass

Revision ID: 0013
Revises: 0012
Create Date: 2026-04-26

Why: the retirement projection needs to know which accounts are
tax-deferred (traditional 401k/IRA — taxed as ordinary income on
withdrawal), Roth (tax-free), or taxable brokerage (LTCG on gains
only). Without this distinction every after-tax projection is wrong.

Strategy:
  1) Add `tax_bucket` TEXT column, default NULL.
  2) Pre-label existing rows via SQL heuristics on subtype/name.
     'roth' wins if present; then 401k/IRA/pension keywords map to
     tax_deferred; everything else falls to 'taxable' (the user's
     stated 'default when unsure' rule — it's also the conservative
     choice since taxable has the highest tax drag).
  3) Backfill values are best-effort; user can correct via the
     dropdown editor on the Accounts page.

We don't NOT NULL the column because manual_assets / non-investment
account types don't really need a bucket. Allowing NULL keeps that
distinction explicit; the projection only sums buckets for accounts
where type IN ('investment',).
"""
from alembic import op
import sqlalchemy as sa


revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("tax_bucket", sa.String(), nullable=True))

    # Pre-labeling — case-insensitive matches against subtype + name +
    # custom_name. SQL is portable across SQLite (LOWER() works).
    # Order of these UPDATEs matters: 'roth' first, then tax_deferred
    # heuristics; everything investment-typed but unmatched falls to
    # 'taxable' last.
    op.execute("""
        UPDATE accounts
        SET tax_bucket = 'roth'
        WHERE LOWER(COALESCE(subtype,'') || ' ' || COALESCE(name,'') || ' ' || COALESCE(custom_name,''))
              LIKE '%roth%'
    """)
    op.execute("""
        UPDATE accounts
        SET tax_bucket = 'tax_deferred'
        WHERE tax_bucket IS NULL
          AND (
            LOWER(COALESCE(subtype,'')) IN ('401k', '403b', 'ira', '457', 'pension')
            OR LOWER(COALESCE(subtype,'') || ' ' || COALESCE(name,'') || ' ' || COALESCE(custom_name,''))
               LIKE '%401(k)%'
            OR LOWER(COALESCE(subtype,'') || ' ' || COALESCE(name,'') || ' ' || COALESCE(custom_name,''))
               LIKE '%401k%'
            OR LOWER(COALESCE(subtype,'') || ' ' || COALESCE(name,'') || ' ' || COALESCE(custom_name,''))
               LIKE '%403(b)%'
            OR LOWER(COALESCE(subtype,'') || ' ' || COALESCE(name,'') || ' ' || COALESCE(custom_name,''))
               LIKE '%403b%'
            OR LOWER(COALESCE(subtype,'') || ' ' || COALESCE(name,'') || ' ' || COALESCE(custom_name,''))
               LIKE '%traditional ira%'
            OR LOWER(COALESCE(subtype,'') || ' ' || COALESCE(name,'') || ' ' || COALESCE(custom_name,''))
               LIKE '%netbenefits%'
          )
    """)
    # Default everything else that's an investment account to 'taxable'.
    # The user's rule: 'post tax as default when unsure'. Conservative
    # because taxable has the highest tax drag — projection underestimates
    # rather than overestimates after-tax income.
    op.execute("""
        UPDATE accounts
        SET tax_bucket = 'taxable'
        WHERE tax_bucket IS NULL
          AND type = 'investment'
    """)


def downgrade() -> None:
    op.drop_column("accounts", "tax_bucket")
