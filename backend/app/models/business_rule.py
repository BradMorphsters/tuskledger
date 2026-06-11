"""Business-tagging rule: pattern → business_id.

Mirrors CategoryRule but for the business_id column. Kept as its own
model so the rule sets evolve independently — a single transaction
can match one rule of each type without their schemas being coupled.

Pattern is matched case-insensitively as a substring against
`merchant_name + " " + name` (same as CategoryRule). `priority`
controls match order when multiple patterns match — lower fires first.
"""
import datetime
from sqlalchemy import Column, Integer, String, ForeignKey, DateTime
from sqlalchemy.orm import relationship
from app.database import Base
from app.utils import utcnow


class BusinessRule(Base):
    __tablename__ = "business_rules"

    id = Column(Integer, primary_key=True, autoincrement=True)
    pattern = Column(String, nullable=False, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"), nullable=False)
    priority = Column(Integer, default=100)
    created_at = Column(DateTime, default=utcnow)

    business = relationship("Business")
