"""The public demo should exercise the app's features, not show empty
states. Seeds a throwaway database and checks the pieces newer features
depend on are present and consistent."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db, get_real_db
from app.main import app
from app.models import Account, ManualAsset, Transaction, TransferRule
from app.scripts.seed_demo import seed_database


@pytest.fixture(scope="module")
def demo():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    seed_database(db)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_real_db] = lambda: db
    try:
        yield db, TestClient(app)
    finally:
        app.dependency_overrides.clear()
        db.close()


def test_every_demo_loan_has_terms_and_the_mortgage_splits_escrow(demo):
    db, client = demo
    s = client.get("/api/loans/summary", params={"extra": 300}).json()
    assert s["excluded"] == []
    assert s["totals"]["loan_count"] >= 4
    assert s["totals"]["monthly_escrow"] > 0
    mortgage = next(l for l in client.get("/api/loans/").json()["loans"] if l["subtype"] == "mortgage")
    assert mortgage["escrow_monthly"] > 0 and mortgage["months_remaining"] > 300
    # Student loans hold several rates, so the plan shows more than one phase.
    assert len(s["plans"]["avalanche"]["extra_phases"]) >= 3
    student = db.query(ManualAsset).filter(ManualAsset.type == "student_loan").one()
    assert len({p["rate"] for p in student.loan_tranches}) >= 3


def test_demo_has_a_closed_account_with_history(demo):
    db, _ = demo
    closed = db.query(Account).filter(Account.status == "closed").all()
    assert closed and all(a.current_balance == 0 and a.closed_at for a in closed)
    assert db.query(Transaction).filter(Transaction.account_id == closed[0].id).count() >= 3


def test_demo_has_refunds_and_a_transfer_rule(demo):
    db, _ = demo
    assert db.query(Transaction).filter(Transaction.is_refund.is_(True)).count() >= 2
    rule = db.query(TransferRule).one()
    matched = db.query(Transaction).filter(Transaction.name.ilike(f"%{rule.pattern}%")).all()
    assert matched and all(t.is_transfer for t in matched)
