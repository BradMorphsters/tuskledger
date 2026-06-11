import datetime
from sqlalchemy import Column, String, Float, Date, DateTime, Integer, ForeignKey, Boolean, UniqueConstraint
from sqlalchemy.orm import relationship
from app.database import Base
from app.utils import utcnow


class MortgageDetail(Base):
    """Plaid Liabilities mortgage data for a single Account.

    1:1 with Account. Refreshed from /liabilities/get on every sync. The
    Account row continues to hold the running principal balance via
    ``current_balance`` so Net Worth math doesn't change — this table just
    layers on rich detail (rate, escrow, payment schedule, property).
    """
    __tablename__ = "mortgage_details"
    __table_args__ = (
        UniqueConstraint("account_id", name="uq_mortgage_details_account"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    account_id = Column(Integer, ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False, index=True)

    # Snapshot of mortgage account number from Plaid (usually masked).
    account_number = Column(String, nullable=True)

    # Rate
    interest_rate_percentage = Column(Float, nullable=True)
    interest_rate_type = Column(String, nullable=True)        # "fixed" | "variable"

    # Loan setup
    loan_term = Column(String, nullable=True)                 # e.g. "30 year"
    loan_type_description = Column(String, nullable=True)     # e.g. "conventional", "fha"
    origination_date = Column(Date, nullable=True)
    origination_principal_amount = Column(Float, nullable=True)
    maturity_date = Column(Date, nullable=True)

    # Payments
    next_monthly_payment = Column(Float, nullable=True)
    next_payment_due_date = Column(Date, nullable=True)
    last_payment_amount = Column(Float, nullable=True)
    last_payment_date = Column(Date, nullable=True)
    past_due_amount = Column(Float, nullable=True)
    current_late_fee = Column(Float, nullable=True)

    # YTD
    ytd_interest_paid = Column(Float, nullable=True)
    ytd_principal_paid = Column(Float, nullable=True)

    # Escrow + flags
    escrow_balance = Column(Float, nullable=True)
    has_pmi = Column(Boolean, nullable=True)
    has_prepayment_penalty = Column(Boolean, nullable=True)

    # Property address (when bank reports it)
    property_street = Column(String, nullable=True)
    property_city = Column(String, nullable=True)
    property_region = Column(String, nullable=True)           # state
    property_postal_code = Column(String, nullable=True)
    property_country = Column(String, nullable=True)

    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    account = relationship("Account")
