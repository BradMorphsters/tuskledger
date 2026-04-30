import datetime
from sqlalchemy import Column, String, Float, Date, DateTime, Integer, ForeignKey, Boolean
from sqlalchemy.orm import relationship
from app.database import Base


class InvestmentTransaction(Base):
    """A buy, sell, dividend, fee, or other action on an investment account.

    Separate from the Transaction table because the schema is different
    (quantity, price, security reference, position-changing vs. cash-only)
    and because we don't want these polluting spending/budget categorization.
    """
    __tablename__ = "investment_transactions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    plaid_investment_transaction_id = Column(String, unique=True, nullable=False, index=True)
    account_id = Column(Integer, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    plaid_security_id = Column(String, ForeignKey("securities.plaid_security_id"), nullable=True, index=True)

    date = Column(Date, nullable=False, index=True)
    name = Column(String, nullable=True)                      # e.g. "BUY VANGUARD 500 INDEX"
    type = Column(String, nullable=True, index=True)          # buy, sell, cash, dividend, fee, transfer, cancel
    subtype = Column(String, nullable=True)                   # Plaid subtype, e.g. "dividend", "contribution", "rollover"

    quantity = Column(Float, nullable=True)                   # shares (positive for buy, negative for sell)
    price = Column(Float, nullable=True)                      # per-share price
    amount = Column(Float, nullable=True)                     # total cash impact; positive = cash out of account
    fees = Column(Float, nullable=True)
    iso_currency_code = Column(String, nullable=True)

    cancel_transaction_id = Column(String, nullable=True)
    pending = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    account = relationship("Account")
    security = relationship("Security")
