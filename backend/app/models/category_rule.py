import datetime
from sqlalchemy import Column, String, Integer, DateTime
from app.database import Base


class CategoryRule(Base):
    """User-defined rule: if merchant name contains `pattern`, auto-assign `category`."""
    __tablename__ = "category_rules"

    id = Column(Integer, primary_key=True, autoincrement=True)
    pattern = Column(String, nullable=False, unique=True)  # case-insensitive match on merchant/name
    category = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
