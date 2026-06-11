import datetime
from sqlalchemy import Column, String, DateTime, Integer
from app.database import Base
from app.utils import utcnow


class PlaidItem(Base):
    """Represents a Plaid Item (a connection to a single financial institution)."""
    __tablename__ = "plaid_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    item_id = Column(String, unique=True, nullable=False, index=True)
    access_token = Column(String, nullable=False)
    institution_id = Column(String, nullable=True)
    institution_name = Column(String, nullable=True)
    cursor = Column(String, nullable=True)  # for transaction sync pagination
    created_at = Column(DateTime, default=utcnow)
    updated_at = Column(DateTime, default=utcnow, onupdate=utcnow)
