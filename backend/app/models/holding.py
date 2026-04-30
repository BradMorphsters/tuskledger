import datetime
from sqlalchemy import Column, String, Float, DateTime, Integer, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship
from app.database import Base


class Holding(Base):
    """A position: one account holding one security at a point in time.

    Plaid returns the full current-state list on every /investments/holdings/get
    call. We upsert by (account_id, plaid_security_id): one row per position
    per account. Holdings that disappear from Plaid's response for an account
    are deleted (sold / transferred out).
    """
    __tablename__ = "holdings"
    __table_args__ = (
        UniqueConstraint("account_id", "plaid_security_id", name="uq_holdings_account_security"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    account_id = Column(Integer, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)
    plaid_security_id = Column(String, ForeignKey("securities.plaid_security_id"), nullable=False, index=True)

    quantity = Column(Float, nullable=False, default=0.0)
    institution_price = Column(Float, nullable=True)          # price from the institution (usually close)
    institution_price_as_of = Column(DateTime, nullable=True)
    institution_value = Column(Float, nullable=True)          # quantity * institution_price, as reported
    cost_basis = Column(Float, nullable=True)                 # total cost basis if the institution reports it
    iso_currency_code = Column(String, nullable=True)

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    account = relationship("Account")
    security = relationship("Security")
