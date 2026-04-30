"""manual_assets.paired_manual_liability_id column

Revision ID: 0014
Revises: 0013
Create Date: 2026-04-27

Why: existing `plaid_mortgage_account_id` only pairs an asset with a
loan that lives in the `accounts` table (Plaid-synced or manually-
entered Account). Auto loans for vehicles often live as
manual_assets rows with side='liability' and type='auto_loan'
(Plaid auto-loan integrations are flaky). Without a way to pair a
vehicle asset with that manual liability, the UI can't show the
vehicle's equity inline.

Strategy: add `paired_manual_liability_id` as a nullable self-FK to
manual_assets.id. Asset rows can use either FK (or both, though
unusual) — frontend chooses which based on asset type:
  - real_estate → mortgage_account_id (Plaid mortgage account)
  - vehicle / other → paired_manual_liability_id (manual auto loan)

ON DELETE SET NULL so deleting a liability doesn't orphan-cascade
the asset.
"""
from alembic import op
import sqlalchemy as sa


revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "manual_assets",
        sa.Column("paired_manual_liability_id", sa.Integer(), nullable=True),
    )
    # Self-FK with SET NULL so the asset survives liability deletion.
    # Named explicitly so SQLite's batch_alter_table can find it later
    # if we ever need to drop it.
    with op.batch_alter_table("manual_assets") as batch_op:
        batch_op.create_foreign_key(
            "fk_manual_assets_paired_liability",
            "manual_assets",
            ["paired_manual_liability_id"],
            ["id"],
            ondelete="SET NULL",
        )
    op.create_index(
        "ix_manual_assets_paired_manual_liability_id",
        "manual_assets",
        ["paired_manual_liability_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_manual_assets_paired_manual_liability_id", "manual_assets")
    with op.batch_alter_table("manual_assets") as batch_op:
        batch_op.drop_constraint("fk_manual_assets_paired_liability", type_="foreignkey")
    op.drop_column("manual_assets", "paired_manual_liability_id")
