"""Tests for the weekly digest (services/weekly_digest.py).

`week_ending` is pinned throughout so every derived window (the current
week, the prior week for deltas, the 14-day "coming" window) is fully
deterministic regardless of the real wall clock.
"""
import datetime

from sqlalchemy.orm import Session

from app.models import Budget, BudgetCategory, MortgageDetail, NetWorthSnapshot
from app.services.weekly_digest import compute_weekly_digest


WEEK_ENDING = datetime.date(2026, 9, 6)   # window: 2026-08-31 .. 2026-09-06
WEEK_START = datetime.date(2026, 8, 31)
PRIOR_START = datetime.date(2026, 8, 24)  # prior window: 08-24 .. 08-30


# ── happened: spend/income deltas, top categories/merchants ──────

def test_happened_deltas_top_categories_and_merchants(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=1000.0)

    # Current week: $100 Groceries + $50 Shopping = $150 spend, one paycheck.
    factory.transaction(account_id=acct.id, amount=100.0, date=datetime.date(2026, 9, 1),
                         merchant_name="Northside Grocer", category="Groceries")
    factory.transaction(account_id=acct.id, amount=50.0, date=datetime.date(2026, 9, 2),
                         merchant_name="Corner Boutique", category="Shopping")
    factory.transaction(account_id=acct.id, amount=-2000.0, date=datetime.date(2026, 9, 1),
                         merchant_name="Acme Payroll", category="Income")
    # A transfer + a refund, both inside the window, to sanity-check counts.
    factory.transaction(account_id=acct.id, amount=500.0, date=datetime.date(2026, 9, 3),
                         merchant_name="Internal Sweep", is_transfer=True)
    refund = factory.transaction(account_id=acct.id, amount=-20.0, date=datetime.date(2026, 9, 4),
                                  merchant_name="Northside Grocer", category="Groceries")
    refund.is_refund = True

    # Prior week: $60 Groceries + $80 Shopping = $140 spend, no income.
    factory.transaction(account_id=acct.id, amount=60.0, date=datetime.date(2026, 8, 25),
                         merchant_name="Northside Grocer", category="Groceries")
    factory.transaction(account_id=acct.id, amount=80.0, date=datetime.date(2026, 8, 26),
                         merchant_name="Corner Boutique", category="Shopping")
    factory.commit()

    result = compute_weekly_digest(db, week_ending=WEEK_ENDING)
    happened = result["happened"]

    # Groceries net of the $20 refund: 100 - 20 = 80; total spend = 80 + 50 = 130.
    assert happened["spend"] == 130.0
    assert happened["spend_delta"]["amount"] == 130.0 - 140.0
    assert happened["income"] == 2000.0
    assert happened["income_delta"]["pct"] is None  # prior income was 0

    cats = {c["category"]: c for c in happened["top_categories"]}
    assert cats["Groceries"]["amount"] == 80.0
    assert cats["Groceries"]["delta"] == 80.0 - 60.0
    assert cats["Shopping"]["delta"] == 50.0 - 80.0

    merchants = {m["merchant"] for m in happened["top_merchants"]}
    assert "Northside Grocer" in merchants
    assert "Corner Boutique" in merchants

    # 5 rows landed inside the window (2 spend + 1 income + 1 transfer + 1 refund).
    assert happened["transaction_count"] == 5
    assert happened["refund_count"] == 1


# ── notable: first-time merchant, large transaction, price hike ──

def test_notable_first_time_merchant(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=500.0)
    # Established merchant seen well before the window.
    factory.transaction(account_id=acct.id, amount=40.0, date=datetime.date(2025, 1, 5),
                         merchant_name="Northside Grocer", category="Groceries")
    # Brand-new merchant, first appearance inside the window.
    factory.transaction(account_id=acct.id, amount=120.0, date=datetime.date(2026, 9, 2),
                         merchant_name="Hardware Barn", category="Home")
    factory.commit()

    result = compute_weekly_digest(db, week_ending=WEEK_ENDING)
    names = {m["merchant"] for m in result["notable"]["new_merchants"]}
    assert "Hardware Barn" in names
    assert "Northside Grocer" not in names


def test_notable_unusually_large_transaction(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=500.0)
    # 3 prior $50 charges (median $50), then a $150 charge this week (>2x).
    for i, d in enumerate([datetime.date(2026, 6, 1), datetime.date(2026, 7, 1), datetime.date(2026, 8, 1)]):
        factory.transaction(account_id=acct.id, amount=50.0, date=d, merchant_name="Hardware Barn", category="Home")
    factory.transaction(account_id=acct.id, amount=150.0, date=datetime.date(2026, 9, 2),
                         merchant_name="Hardware Barn", category="Home")
    factory.commit()

    result = compute_weekly_digest(db, week_ending=WEEK_ENDING)
    large = result["notable"]["large_transactions"]
    assert any(t["merchant"] == "Hardware Barn" and t["amount"] == 150.0 for t in large)


def test_notable_price_hike_on_recurring_charge(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=500.0)
    # $20/month subscription for 4 months, then a hike to $30 (>25%) this week.
    for m in range(5, 9):
        factory.transaction(account_id=acct.id, amount=20.0, date=datetime.date(2026, m, 1),
                             merchant_name="StreamBox", category="Subscriptions")
    factory.transaction(account_id=acct.id, amount=30.0, date=datetime.date(2026, 9, 1),
                         merchant_name="StreamBox", category="Subscriptions")
    factory.commit()

    result = compute_weekly_digest(db, week_ending=WEEK_ENDING)
    hikes = result["notable"]["price_hikes"]
    assert any(h["merchant"] == "StreamBox" for h in hikes)


# ── coming: 14-day bill window edges ──────────────────────────────

def test_coming_bills_window_edges(db: Session, factory):
    acct_in = factory.account(name="Home Loan", type="loan", subtype="mortgage", current_balance=-100000.0)
    db.add(MortgageDetail(
        account_id=acct_in.id,
        next_payment_due_date=WEEK_ENDING + datetime.timedelta(days=14),   # day 14 -> IN
        next_monthly_payment=1200.0,
    ))
    acct_out = factory.account(name="Cabin Loan", type="loan", subtype="mortgage", current_balance=-50000.0)
    db.add(MortgageDetail(
        account_id=acct_out.id,
        next_payment_due_date=WEEK_ENDING + datetime.timedelta(days=15),   # day 15 -> OUT
        next_monthly_payment=600.0,
    ))
    db.commit()

    result = compute_weekly_digest(db, week_ending=WEEK_ENDING)
    names = {b["name"] for b in result["coming"]["bills"]}
    assert "Home Loan" in names
    assert "Cabin Loan" not in names
    assert "next_paycheck_date" in result["coming"]


# ── budget status: lines over pace ────────────────────────────────

def test_budget_status_lists_lines_over_pace(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=500.0)
    budget = Budget(month=WEEK_ENDING.month, year=WEEK_ENDING.year)
    budget.categories.append(BudgetCategory(category="Shopping", limit_amount=100.0))
    db.add(budget)
    db.commit()
    # Way over pace: $150 spent against a $100 monthly limit this early.
    factory.transaction(account_id=acct.id, amount=150.0, date=datetime.date(2026, 9, 2), category="Shopping")
    factory.commit()

    result = compute_weekly_digest(db, week_ending=WEEK_ENDING)
    status = result["budget_status"]
    assert status is not None
    assert any(line["category"] == "Shopping" for line in status["over_pace"])


def test_budget_status_none_when_no_budget(db: Session):
    result = compute_weekly_digest(db, week_ending=WEEK_ENDING)
    assert result["budget_status"] is None


# ── net worth delta ────────────────────────────────────────────────

def test_net_worth_delta_vs_snapshot_closest_to_7_days_earlier(db: Session):
    db.add(NetWorthSnapshot(date=WEEK_ENDING, net_worth=50000.0, total_assets=60000.0, total_liabilities=10000.0))
    db.add(NetWorthSnapshot(date=WEEK_ENDING - datetime.timedelta(days=7), net_worth=48000.0,
                             total_assets=58000.0, total_liabilities=10000.0))
    db.commit()

    result = compute_weekly_digest(db, week_ending=WEEK_ENDING)
    nw = result["net_worth"]
    assert nw["net_worth"] == 50000.0
    assert nw["prior_net_worth"] == 48000.0
    assert nw["delta"] == 2000.0


# ── action items ───────────────────────────────────────────────────

def test_action_items_unpaired_transfers_and_uncategorized(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=500.0)
    # Transfer-labelled but never paired by the transfer detector.
    factory.transaction(account_id=acct.id, amount=300.0, date=datetime.date(2026, 9, 2),
                         category="Transfer", is_transfer=False)
    # Uncategorized outflow.
    factory.transaction(account_id=acct.id, amount=40.0, date=datetime.date(2026, 9, 2), category=None)
    factory.commit()

    result = compute_weekly_digest(db, week_ending=WEEK_ENDING)
    items = result["action_items"]
    assert items["unpaired_transfers"]["count"] == 1
    assert items["uncategorized"]["count"] == 1
    assert items["unpaired_transfers"]["url"] == "/transactions"


# ── empty DB ──────────────────────────────────────────────────────

def test_empty_db_is_well_shaped(db: Session):
    result = compute_weekly_digest(db, week_ending=WEEK_ENDING)

    assert result["week_start"] == WEEK_START.isoformat()
    assert result["week_end"] == WEEK_ENDING.isoformat()
    assert result["happened"]["spend"] == 0.0
    assert result["happened"]["income"] == 0.0
    assert result["notable"]["new_merchants"] == []
    assert result["notable"]["large_transactions"] == []
    assert result["notable"]["price_hikes"] == []
    assert result["coming"]["bills"] == []
    assert result["budget_status"] is None
    assert result["net_worth"] is None
    assert result["action_items"]["unpaired_transfers"]["count"] == 0
