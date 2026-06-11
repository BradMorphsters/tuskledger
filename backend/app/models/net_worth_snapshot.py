import datetime
from sqlalchemy import Column, Float, DateTime, Integer, Date, JSON
from app.database import Base
from app.utils import utcnow


class NetWorthSnapshot(Base):
    """Daily snapshot of total net worth and per-account balances."""
    __tablename__ = "net_worth_snapshots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(Date, unique=True, nullable=False, index=True)
    total_assets = Column(Float, default=0.0)
    total_liabilities = Column(Float, default=0.0)
    net_worth = Column(Float, default=0.0)
    account_balances = Column(JSON, nullable=True)  # {account_id: balance}
    created_at = Column(DateTime, default=utcnow)
