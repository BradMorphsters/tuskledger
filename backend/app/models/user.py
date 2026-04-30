"""User model for Tusk Ledger authentication.

Tusk Ledger is a single-user local application, so this table is expected to
contain at most one row. The User row stores the password hash and TOTP
shared secret that gate access to the local dashboard and the underlying
Plaid data.
"""
import datetime
from sqlalchemy import Column, Integer, String, DateTime, Boolean
from app.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String, unique=True, nullable=False, default="operator")
    password_hash = Column(String, nullable=False)
    totp_secret = Column(String, nullable=False)
    totp_verified = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    last_login_at = Column(DateTime, nullable=True)
