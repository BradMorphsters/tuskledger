"""device_tokens table for the mobile app pairing/auth flow

Revision ID: 0017
Revises: 0016
Create Date: 2026-05-08

Why: the mobile app authenticates with bearer tokens issued by an
explicit on-device pairing flow, separate from the web's session
cookies + DEV_BYPASS_AUTH. See models/device_token.py for rationale.

Schema notes:
  - token_hash is unique + indexed because every authenticated mobile
    request does a single-row lookup by hash. The lookup is hot.
  - pairing_code is also unique + indexed but the read pattern is
    occasional (only during pairing). Index is mostly there to enforce
    uniqueness — collisions mid-pairing would hand the wrong device
    its peer's token.
"""
from alembic import op
import sqlalchemy as sa


revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "device_tokens",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("label", sa.String(), nullable=True),
        sa.Column("token_hash", sa.String(), nullable=True),
        sa.Column("pairing_code", sa.String(), nullable=True),
        sa.Column("pairing_expires_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True),
    )
    op.create_index(
        "ix_device_tokens_token_hash",
        "device_tokens",
        ["token_hash"],
        unique=True,
    )
    op.create_index(
        "ix_device_tokens_pairing_code",
        "device_tokens",
        ["pairing_code"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_device_tokens_pairing_code", "device_tokens")
    op.drop_index("ix_device_tokens_token_hash", "device_tokens")
    op.drop_table("device_tokens")
