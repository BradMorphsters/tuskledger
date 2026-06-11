import datetime
from sqlalchemy import Column, String, Float, DateTime, Integer, ForeignKey, Date, Boolean
from sqlalchemy.orm import relationship
from app.database import Base
from app.utils import utcnow


class Transaction(Base):
    """A single financial transaction."""
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    plaid_transaction_id = Column(String, unique=True, nullable=True, index=True)
    account_id = Column(Integer, ForeignKey("accounts.id"), nullable=False)

    name = Column(String, nullable=False)
    merchant_name = Column(String, nullable=True)
    amount = Column(Float, nullable=False)          # positive = money out, negative = money in (Plaid convention)
    currency = Column(String, default="USD")
    date = Column(Date, nullable=False)
    pending = Column(Boolean, default=False)

    # Categorization
    category = Column(String, nullable=True)        # primary category
    subcategory = Column(String, nullable=True)
    custom_category = Column(String, nullable=True)  # user override

    # Transfer flag — true when this transaction is an account-to-account
    # transfer or a credit-card/loan payment (not real "spending"). Set by
    # app.services.transfer_detector after each sync. Excluded from
    # spending summaries, category breakdowns, and budget totals.
    is_transfer = Column(Boolean, default=False, nullable=False)

    # Business tagging
    business_id = Column(Integer, ForeignKey("businesses.id"), nullable=True)
    business = relationship("Business")

    # Free-text user notes — receipts info, audit-trail context, etc.
    # Editable from the TransactionDrawer; never set by sync or import.
    notes = Column(String, nullable=True)

    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    account = relationship("Account", back_populates="transactions")
    splits = relationship(
        "TransactionSplit",
        back_populates="transaction",
        cascade="all, delete-orphan",
    )

    @property
    def display_category(self):
        return self.custom_category or self.category or "Uncategorized"

    @property
    def display_name(self) -> str:
        """Human-friendly merchant name: normalizes Plaid's raw bank strings
        (ACH metadata stripped, known issuers mapped to friendly names).
        Falls back through merchant_name → name so we always return
        something readable.
        """
        # Local import to avoid a circular dep if merchant_normalizer ever
        # grows to reference models.
        from app.services.merchant_normalizer import normalize
        candidate = self.merchant_name or self.name
        return normalize(candidate) or candidate or ""

    @property
    def is_split(self) -> bool:
        return bool(self.splits)
