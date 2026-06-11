import datetime
from sqlalchemy import Column, String, Float, Date, DateTime, Integer, ForeignKey, Boolean, JSON, UniqueConstraint
from sqlalchemy.orm import relationship
from app.database import Base
from app.utils import utcnow


class CreditCardDetail(Base):
    """Plaid Liabilities credit-card data for a single Account.

    1:1 with Account. Refreshed every sync. Statement and minimum-payment
    detail is what makes the existing Chase CC entry useful for budgeting:
    "When is this due and how much do I owe at next statement?".
    """
    __tablename__ = "credit_card_details"
    __table_args__ = (
        UniqueConstraint("account_id", name="uq_credit_card_details_account"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    account_id = Column(Integer, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)

    # APR breakdown — Plaid returns a list of {apr_percentage, apr_type, balance_subject_to_apr,
    # interest_charge_amount}. We store as JSON to preserve all variants
    # (purchase, balance_transfer, cash_advance, special, etc.) without
    # exploding the schema.
    aprs = Column(JSON, nullable=True)

    is_overdue = Column(Boolean, nullable=True)

    # Statement
    last_statement_balance = Column(Float, nullable=True)
    last_statement_issue_date = Column(Date, nullable=True)

    # Payment
    last_payment_amount = Column(Float, nullable=True)
    last_payment_date = Column(Date, nullable=True)
    minimum_payment_amount = Column(Float, nullable=True)
    next_payment_due_date = Column(Date, nullable=True)

    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    account = relationship("Account")
