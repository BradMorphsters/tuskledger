"""SavingsGoal — a user-defined target tracked against one or more accounts.

Progress can flow in two ways:
  - Auto: source_account_ids names a list of accounts whose summed
    current_balance counts toward the goal. Most common case (e.g. an
    Emergency Fund tracked against a savings account).
  - Manual: manual_current_amount overrides the auto sum. Useful when the
    "goal" doesn't map cleanly to a single Plaid account (e.g. savings
    held in multiple instruments, or a goal tracked alongside regular
    spend in the same checking account).

The two are not mutually exclusive — if both are set, manual wins. That
keeps the model simple while letting the UI flip between the two modes.
"""
from __future__ import annotations

import datetime

from sqlalchemy import Column, Date, DateTime, Float, Integer, JSON, String

from app.database import Base
from app.utils import utcnow


class SavingsGoal(Base):
    __tablename__ = "savings_goals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    target_amount = Column(Float, nullable=False)
    target_date = Column(Date, nullable=True)
    # Free-form classification — used by the frontend to pick an icon and
    # is the only thing distinguishing an "emergency fund" from a "vacation"
    # goal in computed progress (they're identical mechanically).
    goal_type = Column(String, nullable=False, default="custom")
    notes = Column(String, nullable=True)
    # JSON list of account ids whose current_balance contributes to the
    # goal. Empty list → no auto-tracking, manual_current_amount required.
    source_account_ids = Column(JSON, nullable=False, default=list)
    manual_current_amount = Column(Float, nullable=True)
    is_active = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=utcnow,
        onupdate=utcnow,
    )
