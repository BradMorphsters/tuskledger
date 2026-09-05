"""Tests for GET /analytics/rules/preview and the custom_category clear
semantics that Undo relies on."""
import datetime
from sqlalchemy.orm import Session

from app.routers.analytics import preview_rule
from app.routers.transactions import update_transaction
from app.schemas.schemas import TransactionUpdate


def _seed(db, factory):
    acct = factory.account(name="Card")
    d = datetime.date(2026, 8, 1)
    rows = {}
    rows["a"] = factory.transaction(account_id=acct.id, amount=10, date=d, merchant_name="Coffee Hut", name="COFFEE HUT #12", category="Shopping")
    rows["b"] = factory.transaction(account_id=acct.id, amount=11, date=d + datetime.timedelta(days=1), merchant_name="Coffee Hut", name="COFFEE HUT #99", category="Shopping")
    rows["c"] = factory.transaction(account_id=acct.id, amount=12, date=d + datetime.timedelta(days=2), merchant_name=None, name="POS COFFEE HUT DOWNTOWN", category="Food & Dining")  # already right
    rows["d"] = factory.transaction(account_id=acct.id, amount=13, date=d + datetime.timedelta(days=3), merchant_name="Coffee Hut", name="COFFEE HUT", category="Shopping")
    rows["d"].custom_category = "Gifts & Donations"   # user's own call
    rows["e"] = factory.transaction(account_id=acct.id, amount=14, date=d, merchant_name="Tea Barn", name="TEA BARN", category="Shopping")
    factory.commit()
    return rows


def test_preview_counts_history_not_just_a_page(db: Session, factory):
    rows = _seed(db, factory)
    out = preview_rule(pattern="coffee hut", category="Food & Dining", exclude_id=rows["a"].id, db=db)
    ids = {c["id"] for c in out["candidates"]}
    assert ids == {rows["b"].id, rows["d"].id}          # a excluded, c already right, e no match
    assert out["already_correct"] == 1
    assert out["matched"] == 3
    # Rule semantics never override d's hand-set category → only b.
    assert out["rule_would_update"] == 1


def test_preview_carries_prior_override_for_undo(db: Session, factory):
    rows = _seed(db, factory)
    out = preview_rule(pattern="Coffee Hut", category="Food & Dining", exclude_id=None, db=db)
    by_id = {c["id"]: c for c in out["candidates"]}
    assert by_id[rows["b"].id]["prior_custom_category"] is None
    assert by_id[rows["d"].id]["prior_custom_category"] == "Gifts & Donations"
    assert by_id[rows["d"].id]["current_category"] == "Gifts & Donations"
    assert out["pattern"] == "coffee hut"                # normalized


def test_preview_is_case_insensitive_and_matches_raw_name(db: Session, factory):
    rows = _seed(db, factory)
    out = preview_rule(pattern="COFFEE HUT DOWNTOWN", category="Shopping", exclude_id=None, db=db)
    assert [c["id"] for c in out["candidates"]] == [rows["c"].id]


def test_patch_empty_custom_category_clears_the_override(db: Session, factory):
    rows = _seed(db, factory)
    d = rows["d"]
    out = update_transaction(d.id, TransactionUpdate(custom_category=""), db=db)
    assert out.custom_category is None
    out = update_transaction(d.id, TransactionUpdate(custom_category="  Travel "), db=db)
    assert out.custom_category == "Travel"
    # null still means "leave unchanged"
    out = update_transaction(d.id, TransactionUpdate(notes="x"), db=db)
    assert out.custom_category == "Travel"
