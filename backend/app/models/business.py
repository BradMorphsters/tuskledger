"""Business entity for tracking business expenses across accounts."""
import datetime
from sqlalchemy import Column, String, Integer, DateTime
from app.database import Base
from app.utils import utcnow


class Business(Base):
    """A business entity that transactions can be tagged with."""
    __tablename__ = "businesses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False, unique=True)
    color = Column(String, nullable=False, default="#6366f1")  # hex color for badges
    icon = Column(String, nullable=False, default="briefcase")  # lucide icon name
    description = Column(String, nullable=True)
    is_active = Column(Integer, default=1)  # SQLite doesn't have native bool; 1=active

    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)
