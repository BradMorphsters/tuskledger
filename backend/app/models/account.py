import datetime
from sqlalchemy import Column, String, Float, Date, DateTime, Integer, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base


class Account(Base):
    """A financial account (checking, savings, credit card, investment, etc.)."""
    __tablename__ = "accounts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    plaid_account_id = Column(String, unique=True, nullable=True, index=True)
    plaid_item_id = Column(Integer, ForeignKey("plaid_items.id"), nullable=True)
    name = Column(String, nullable=False)          # Plaid-provided name; refreshed on every sync
    custom_name = Column(String, nullable=True)    # user-provided alias; takes precedence in the UI
    official_name = Column(String, nullable=True)
    type = Column(String, nullable=False)          # depository, credit, investment, loan
    subtype = Column(String, nullable=True)        # checking, savings, credit card, 401k, etc.
    institution_name = Column(String, nullable=True)
    mask = Column(String, nullable=True)           # last 4 digits

    current_balance = Column(Float, default=0.0)
    available_balance = Column(Float, nullable=True)
    currency = Column(String, default="USD")

    # Snapshot date for the *balance*, only populated for manual accounts
    # (where the user enters a balance from a statement). Plaid-synced
    # accounts leave this NULL — their balance updates continuously and
    # the staleness indicator on those is just `updated_at`.
    # On the UI, this drives the "as of <date>" badge that distinguishes
    # snapshot-style accounts (Apple Card statement) from live ones.
    balance_as_of = Column(Date, nullable=True)

    # Tax treatment for retirement projection — drives whether withdrawals
    # are taxed as ordinary income (tax_deferred), tax-free (roth), or at
    # LTCG (taxable). NULL for non-investment accounts where the bucket
    # doesn't apply. Migration 0013 pre-labels existing rows; user can
    # override via the dropdown editor on the Accounts page.
    # Allowed values: 'tax_deferred' | 'roth' | 'taxable' | 'hsa' | 'excluded' | NULL
    tax_bucket = Column(String, nullable=True)

    # Fractional Roth split for accounts that mix pre-tax and Roth
    # contributions in a single Plaid-synced balance (common for 401(k)
    # plans that allow per-paycheck Roth designation).
    # When set, the retirement aggregator splits the account:
    #   roth_share = current_balance * roth_split_pct → roth bucket
    #   remainder  = current_balance * (1 - roth_split_pct) → tax_bucket
    # Range 0.0-1.0. NULL = no split, whole balance lands in tax_bucket.
    # Plaid resync overwrites current_balance but leaves this percentage
    # alone — the user maintains the ratio manually from their plan portal.
    roth_split_pct = Column(Float, nullable=True)

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    transactions = relationship("Transaction", back_populates="account", cascade="all, delete-orphan")
