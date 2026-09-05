"""Refund flag: definition, detector, PATCH follow-through, and the headline
endpoints that must net refunds against spend instead of counting income."""
import datetime
from sqlalchemy.orm import Session

from app.services.refund_detector import is_refund_row, detect_refunds, INCOME_LIKE_CATEGORIES


def test_definition():
    assert is_refund_row(-40.0, "Shopping", False) is True
    assert is_refund_row(-40.0, "Income", False) is False        # paycheck
    assert is_refund_row(-40.0, "Transfer", False) is False      # unpaired transfer-in
    assert is_refund_row(-40.0, "Shopping", True) is False       # transfers are never refunds
    assert is_refund_row(40.0, "Shopping", False) is False       # outflow
    assert is_refund_row(-40.0, None, False) is False            # uncategorised → don't guess
    assert is_refund_row(None, "Shopping", False) is False
    assert "Income" in INCOME_LIKE_CATEGORIES


def _seed(db, factory):
    acct = factory.account(name="Checking")
    d = datetime.date(2026, 8, 5)
    pay = factory.transaction(account_id=acct.id, amount=-3000, date=d, merchant_name="Payroll", category="Income")
    ret = factory.transaction(account_id=acct.id, amount=-400.0, date=d, merchant_name="Hardware Store", category="Home")
    buy = factory.transaction(account_id=acct.id, amount=500.0, date=d, merchant_name="Hardware Store", category="Home")
    cc = factory.transaction(account_id=acct.id, amount=-900.0, date=d, merchant_name=None, name="AUTOMATIC PAYMENT - THANK", category="Income", is_transfer=True)
    factory.commit()
    return acct, pay, ret, buy, cc


def test_detector_flags_only_spending_category_inflows(db: Session, factory):
    _, pay, ret, buy, cc = _seed(db, factory)
    out = detect_refunds(db)
    for t in (pay, ret, buy, cc):
        db.refresh(t)
    assert ret.is_refund is True
    assert pay.is_refund is False and buy.is_refund is False and cc.is_refund is False
    assert out["total_flagged"] == 1
    # Idempotent
    assert detect_refunds(db)["changed"] == 0


def test_patch_recategorize_moves_flag(db: Session, factory):
    from app.routers.transactions import update_transaction
    from app.schemas.schemas import TransactionUpdate
    _, pay, ret, *_ = _seed(db, factory)
    detect_refunds(db)
    # User says the "return" was actually a reimbursement → Income → not a refund
    out = update_transaction(ret.id, TransactionUpdate(custom_category="Income"), db=db)
    assert out.is_refund is False
    # And back
    out = update_transaction(ret.id, TransactionUpdate(custom_category="Home"), db=db)
    assert out.is_refund is True
    # Marking a refund as a transfer clears it
    out = update_transaction(ret.id, TransactionUpdate(is_transfer=True), db=db)
    assert out.is_refund is False


def test_income_vs_spending_nets_refund_into_spend(db: Session, factory):
    from app.routers.transactions import income_vs_spending
    _seed(db, factory); detect_refunds(db)
    rows = income_vs_spending(months=1, end_month=8, end_year=2026, db=db)
    aug = rows[-1]
    assert aug["income"] == 3000.0                     # the return is NOT income
    assert aug["spending"] == round(500.0 - 400.0, 2) # netted
    assert aug["net"] == round(3000.0 - (500.0 - 400.0), 2)


def test_category_breakdown_nets_and_never_draws_negative_slices(db: Session, factory):
    from app.routers.transactions import category_breakdown
    acct, *_ = _seed(db, factory)
    # A refund-only category this month: statement credit, no purchases.
    factory.transaction(account_id=acct.id, amount=-75.0, date=datetime.date(2026, 8, 6), merchant_name="Card", name="STATEMENT CREDIT", category="Miscellaneous")
    factory.commit(); detect_refunds(db)
    out = category_breakdown(month=8, year=2026, start_date=None, end_date=None, db=db)
    by = {c["category"]: c for c in out["spending_categories"]}
    assert by["Home"]["amount"] == round(500.0 - 400.0, 2)
    assert by["Home"]["transaction_count"] == 1            # the refund isn't a purchase
    assert "Miscellaneous" not in by                        # net ≤ 0 → not drawn
    assert out["total_income"] == 3000.0
    assert [c["category"] for c in out["income_categories"]] == ["Income"]


def test_totals_report_refunds_separately_and_net(db: Session, factory):
    from app.routers.transactions import list_transactions_totals
    _seed(db, factory); detect_refunds(db)
    out = list_transactions_totals(
        account_id=None, category=None, business_id=None, is_business=None,
        start_date=None, end_date=None, q=None, include_transfers=False, db=db,
    )
    assert out["income"] == 3000.0
    assert out["refunds"] == 400.0
    assert round(out["spending"], 2) == round(500.0 - 400.0, 2)
