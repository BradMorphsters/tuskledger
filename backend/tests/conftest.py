"""Pytest fixtures for Tusk Ledger backend tests."""
import datetime
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models import (
    Account,
    Transaction,
    Security,
    Holding,
    InvestmentTransaction,
    Business,
)


@pytest.fixture(scope="function")
def db():
    """In-memory SQLite database session for each test.

    Two SQLite-specific knobs are required when the engine is going to
    be reached from FastAPI's TestClient:
      - check_same_thread=False — the TestClient runs the app on
        Starlette's threadpool, which is a different thread than the
        one the test fixture used to set up data. Without this,
        every TestClient request raises 'SQLite objects created in
        a thread can only be used in that same thread'.
      - poolclass=StaticPool — sqlite::memory: gives each connection
        its OWN private database, so the test fixture's INSERTs would
        be invisible to the connection FastAPI later opens. StaticPool
        keeps a single shared connection alive for the whole engine,
        so every code path sees the same in-memory DB.
    """
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    yield session
    session.close()
    engine.dispose()


class Factory:
    """Test data factory for building models without boilerplate."""

    def __init__(self, db: Session):
        self.db = db

    def account(
        self,
        name: str = "Test Account",
        type: str = "depository",
        subtype: str = "checking",
        current_balance: float = 1000.0,
        plaid_item_id: int | None = None,
        balance_as_of: datetime.date | None = None,
    ) -> Account:
        """Create an Account."""
        acct = Account(
            name=name,
            type=type,
            subtype=subtype,
            current_balance=current_balance,
            plaid_item_id=plaid_item_id,
            balance_as_of=balance_as_of or datetime.date.today(),
        )
        self.db.add(acct)
        self.db.flush()
        return acct

    def transaction(
        self,
        account_id: int,
        amount: float = 100.0,
        date: datetime.date | None = None,
        merchant_name: str = "Test Merchant",
        name: str = "Test Transaction",
        category: str | None = None,
        is_transfer: bool = False,
        business_id: int | None = None,
    ) -> Transaction:
        """Create a Transaction."""
        txn = Transaction(
            account_id=account_id,
            amount=amount,
            date=date or datetime.date.today(),
            name=name,
            merchant_name=merchant_name,
            category=category,
            is_transfer=is_transfer,
            business_id=business_id,
        )
        self.db.add(txn)
        self.db.flush()
        return txn

    def security(
        self,
        plaid_security_id: str = "test_security_1",
        ticker_symbol: str | None = "TEST",
        name: str = "Test Security",
        type: str = "equity",
        is_cash_equivalent: bool = False,
    ) -> Security:
        """Create a Security."""
        sec = Security(
            plaid_security_id=plaid_security_id,
            ticker_symbol=ticker_symbol,
            name=name,
            type=type,
            is_cash_equivalent=is_cash_equivalent,
        )
        self.db.add(sec)
        self.db.flush()
        return sec

    def holding(
        self,
        account_id: int,
        plaid_security_id: str = "test_security_1",
        quantity: float = 10.0,
        institution_value: float = 1000.0,
        cost_basis: float | None = None,
    ) -> Holding:
        """Create a Holding."""
        holding = Holding(
            account_id=account_id,
            plaid_security_id=plaid_security_id,
            quantity=quantity,
            institution_value=institution_value,
            cost_basis=cost_basis,
        )
        self.db.add(holding)
        self.db.flush()
        return holding

    def investment_transaction(
        self,
        account_id: int,
        plaid_security_id: str = "test_security_1",
        date: datetime.date | None = None,
        type: str = "buy",
        quantity: float = 10.0,
        price: float = 100.0,
        amount: float = 1000.0,
    ) -> InvestmentTransaction:
        """Create an InvestmentTransaction."""
        inv_txn = InvestmentTransaction(
            account_id=account_id,
            plaid_security_id=plaid_security_id,
            date=date or datetime.date.today(),
            type=type,
            quantity=quantity,
            price=price,
            amount=amount,
        )
        self.db.add(inv_txn)
        self.db.flush()
        return inv_txn

    def business(
        self,
        name: str = "Test Business",
    ) -> Business:
        """Create a Business."""
        biz = Business(name=name)
        self.db.add(biz)
        self.db.flush()
        return biz

    def commit(self) -> None:
        """Commit all pending changes."""
        self.db.commit()


@pytest.fixture(scope="function")
def factory(db: Session) -> Factory:
    """Test data factory."""
    return Factory(db)
