"""User-defined transfer rules: detector consults them, creation applies to
history, preview counts correctly, and the unpaired-transfer filter finds
what the rules are for."""
import datetime
from sqlalchemy.orm import Session

from app.models import TransferRule
from app.services.transfer_detector import detect_transfers, apply_transfer_rule


def _seed(db, factory):
    acct = factory.account(name="Checking")
    d = datetime.date(2026, 7, 5)
    a = factory.transaction(account_id=acct.id, amount=750.0, date=d, merchant_name=None, name="WITHDRAWAL Debit Card KIDS SAVINGS DEPOSIT KIDSSAVINGS FL", category="Transfer")
    b = factory.transaction(account_id=acct.id, amount=750.0, date=d, merchant_name=None, name="WITHDRAWAL Debit Card KIDS SAVINGS DEPOSIT KIDSSAVINGS FL", category="Transfer")
    v = factory.transaction(account_id=acct.id, amount=80.0, date=d, merchant_name="Venmo", name="Venmo", category="Transfer")
    g = factory.transaction(account_id=acct.id, amount=60.0, date=d, merchant_name="Grocer", name="GROCER", category="Groceries")
    factory.commit()
    return acct, a, b, v, g


def test_detector_honours_user_rule(db: Session, factory):
    _, a, b, v, g = _seed(db, factory)
    db.add(TransferRule(pattern="kids savings deposit")); db.commit()
    detect_transfers(db)
    for t in (a, b, v, g):
        db.refresh(t)
    assert a.is_transfer and b.is_transfer
    assert not v.is_transfer and not g.is_transfer          # Venmo stays spend unless the user says otherwise


def test_apply_rule_fixes_history_now(db: Session, factory):
    _, a, b, v, g = _seed(db, factory)
    n = apply_transfer_rule(db, "KIDS SAVINGS")             # case-insensitive
    assert n == 2
    db.refresh(a); assert a.is_transfer is True


def test_create_rule_endpoint_is_idempotent_and_reports(db: Session, factory):
    from app.routers.analytics import create_transfer_rule, list_transfer_rules
    _seed(db, factory)
    out = create_transfer_rule({"pattern": " Kids Savings Deposit "}, db=db)
    assert out["pattern"] == "kids savings deposit"
    assert out["retroactively_flagged"] == 2
    again = create_transfer_rule({"pattern": "kids savings deposit"}, db=db)
    assert again["id"] == out["id"] and again["retroactively_flagged"] == 0
    assert [r["pattern"] for r in list_transfer_rules(db=db)] == ["kids savings deposit"]


def test_preview_counts_unflagged_matches_only(db: Session, factory):
    from app.routers.analytics import preview_transfer_rule
    _, a, b, v, g = _seed(db, factory)
    a.is_transfer = True; db.commit()
    out = preview_transfer_rule(pattern="kids savings", exclude_id=None, db=db)
    assert [c["id"] for c in out["candidates"]] == [b.id]
    assert out["already_transfers"] == 1
    assert out["total_amount"] == 750.0


def test_unpaired_transfer_filter(db: Session, factory):
    from app.routers.transactions import list_transactions, list_transactions_totals
    _, a, b, v, g = _seed(db, factory)
    a.is_transfer = True; db.commit()
    rows = list_transactions(account_id=None, category=None, business_id=None, is_business=None,
                             start_date=None, end_date=None, q=None, unpaired_transfers=True,
                             limit=100, offset=0, db=db)
    assert {t.id for t in rows} == {b.id, v.id}                # Transfer-labelled outflows not yet flagged
