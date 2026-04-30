"""TransactionSplit: allocate one transaction across multiple categories.

When a transaction has splits, analytics code should attribute each split's
amount to its own category instead of the parent transaction's category.
A transaction has either zero splits (treat normally) or N splits whose
amounts sum to the parent `transactions.amount`.
"""
import datetime
from sqlalchemy import Column, Float, String, Integer, DateTime, ForeignKey
from sqlalchemy.orm import relationship

from app.database import Base


class TransactionSplit(Base):
    __tablename__ = "transaction_splits"

    id = Column(Integer, primary_key=True, autoincrement=True)
    transaction_id = Column(
        Integer,
        ForeignKey("transactions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    amount = Column(Float, nullable=False)
    category = Column(String, nullable=False)
    note = Column(String, nullable=True)
    business_id = Column(Integer, ForeignKey("businesses.id"), nullable=True)

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

    transaction = relationship("Transaction", back_populates="splits")
