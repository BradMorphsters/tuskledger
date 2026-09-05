from sqlalchemy import Column, String, Integer, DateTime
from app.database import Base
from app.utils import utcnow


class TransferRule(Base):
    """User-defined transfer rule: any transaction whose merchant/name
    contains `pattern` (case-insensitive) is a transfer, not spending.

    Exists for the money the transfer detector can't pair: deposits to an
    external savings account, a brokerage the user hasn't linked, a
    relative's account. Plaid files those under TRANSFER_OUT and, with no
    counterpart row to match, they were counted as spending. One rule per
    payee fixes history and every future sync.
    """
    __tablename__ = "transfer_rules"

    id = Column(Integer, primary_key=True, autoincrement=True)
    pattern = Column(String, nullable=False, unique=True)   # lower-cased substring
    created_at = Column(DateTime, default=utcnow)
