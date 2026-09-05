import datetime
from sqlalchemy import Column, String, Float, DateTime, Integer, ForeignKey
from sqlalchemy.orm import relationship
from app.database import Base
from app.utils import utcnow


class Budget(Base):
    """A monthly budget."""
    __tablename__ = "budgets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    month = Column(Integer, nullable=False)  # 1-12
    year = Column(Integer, nullable=False)
    total_limit = Column(Float, nullable=True)  # optional overall limit
    # Set when this month was cloned from a prior month by the automatic
    # carry-forward (services/budget_carry.py). Cleared the first time the
    # user saves the month themselves — at that point the numbers are
    # theirs, not inherited. Plain integer on purpose (no FK): deleting a
    # source month must never cascade into the months cloned from it.
    inherited_from_budget_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)

    categories = relationship("BudgetCategory", back_populates="budget", cascade="all, delete-orphan")


class BudgetCategory(Base):
    """A budget limit for a specific spending category."""
    __tablename__ = "budget_categories"

    id = Column(Integer, primary_key=True, autoincrement=True)
    budget_id = Column(Integer, ForeignKey("budgets.id"), nullable=False)
    category = Column(String, nullable=False)
    limit_amount = Column(Float, nullable=False)
    created_at = Column(DateTime, default=utcnow)

    budget = relationship("Budget", back_populates="categories")
