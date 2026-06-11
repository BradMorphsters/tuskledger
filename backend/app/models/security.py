import datetime
from sqlalchemy import Column, String, Float, DateTime, Boolean
from app.database import Base
from app.utils import utcnow


class Security(Base):
    """A security (stock, ETF, mutual fund, etc.) referenced by holdings and investment transactions.

    Keyed on Plaid's stable security_id. Reference prices are refreshed on
    every sync when Plaid ships a new close_price. Tickers and names can
    change (e.g. ticker symbol changes, name rebrands) but security_id
    stays stable across those.
    """
    __tablename__ = "securities"

    plaid_security_id = Column(String, primary_key=True)
    ticker_symbol = Column(String, nullable=True, index=True)
    name = Column(String, nullable=True)
    type = Column(String, nullable=True)          # equity, etf, mutual fund, cash, fixed income, derivative, loan, cryptocurrency, other
    iso_currency_code = Column(String, nullable=True)
    cusip = Column(String, nullable=True)
    isin = Column(String, nullable=True)
    institution_security_id = Column(String, nullable=True)  # retirement plan internal fund id, if any
    institution_id = Column(String, nullable=True)

    close_price = Column(Float, nullable=True)     # last reported close
    close_price_as_of = Column(DateTime, nullable=True)

    is_cash_equivalent = Column(Boolean, default=False)

    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)
