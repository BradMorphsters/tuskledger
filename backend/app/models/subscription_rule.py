"""Subscription-tagging override rule.

The recurrence detector decides whether a merchant counts as a
"subscription" (regular cadence + amount stability + ≥2 occurrences).
That works well for Netflix-shaped charges but misses two cases:

  1. A brand-new SaaS signup with only one charge so far — won't be
     flagged until the second charge lands. The user wants to track
     it from day one.
  2. A merchant that LOOKS recurring (Apple, Amazon, gas station chain
     hitting the same amount monthly by coincidence) but isn't really
     a subscription. The user wants to silence it.

This table is the user's manual override layer. Two `kind` values:

  - 'force_subscription'     — always treat matching merchants as subs,
                               even before the auto-detector would.
  - 'force_not_subscription' — never treat matching merchants as subs,
                               even when the detector flags them.

Pattern matching mirrors CategoryRule + BusinessRule: case-insensitive
substring against `merchant_name + " " + name`. Priority controls order
when multiple rules match (lower fires first); typical use leaves it
at the default and lets pattern uniqueness dominate.
"""
import datetime
from sqlalchemy import Column, Integer, String, DateTime
from app.database import Base
from app.utils import utcnow


KIND_FORCE_SUB = "force_subscription"
KIND_FORCE_NOT_SUB = "force_not_subscription"


class SubscriptionRule(Base):
    __tablename__ = "subscription_rules"

    id = Column(Integer, primary_key=True, autoincrement=True)
    pattern = Column(String, nullable=False, index=True)
    # KIND_FORCE_SUB or KIND_FORCE_NOT_SUB. Stored as string (not enum)
    # for the same reasons the other rule tables don't use enums:
    # SQLite Alembic migrations stay lighter weight, and we want to
    # be able to add future kinds (e.g. 'force_annual') without an
    # ALTER on the column type.
    kind = Column(String, nullable=False)
    priority = Column(Integer, default=100)
    notes = Column(String, nullable=True)  # optional user-facing memo
    created_at = Column(DateTime, default=utcnow)
