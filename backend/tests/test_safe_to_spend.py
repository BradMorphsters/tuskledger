"""Tests for the Safe-to-spend tile's backend (services/safe_to_spend.py).

Every scenario pins `today` explicitly so the tests never depend on the
real wall clock — see the service module's docstring for why that
matters (collect_upcoming_bills and next_paycheck are both pure given a
`today`/`db`).
"""
import datetime

from sqlalchemy.orm import Session

from app.models import Budget, BudgetCategory, CreditCardDetail, MortgageDetail
from app.services.safe_to_spend import compute_safe_to_spend


TODAY = datetime.date(2026, 9, 5)


def _biweekly_paycheck(factory, acct, *, last_date: datetime.date, occurrences: int = 6, amount: float = -2000.0):
    """Seed `occurrences` deposits 14 days apart, ending at `last_date`."""
    for i in range(occurrences):
        d = last_date - datetime.timedelta(days=14 * (occurrences - 1 - i))
        factory.transaction(
            account_id=acct.id, amount=amount, date=d,
            merchant_name="Acme Payroll", name="Acme Payroll Direct Dep",
            category="Income",
        )


# ── paycheck date ────────────────────────────────────────────────

def test_paycheck_date_rolls_forward_from_last_biweekly_deposit(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=1000.0)
    # Last actual deposit is 25 days before `today` — the raw next_date
    # (last_date + 14) is in the past once before reaching today, while the
    # stream remains inside the stale-income grace window.
    _biweekly_paycheck(factory, acct, last_date=TODAY - datetime.timedelta(days=25))
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["next_paycheck_source"] == "recurring_income"
    assert result["next_paycheck_date"] == "2026-09-08"
    assert result["days_until_paycheck"] == 3


def test_month_end_fallback_when_no_income_stream(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=1000.0)
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["next_paycheck_source"] == "month_end_fallback"
    assert result["next_paycheck_date"] == "2026-10-01"
    assert result["days_until_paycheck"] == 26
    assert any("1st of next month" in n for n in result["notes"])


def test_stale_income_stream_falls_back_to_next_month(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=1000.0)
    _biweekly_paycheck(factory, acct, last_date=TODAY - datetime.timedelta(days=32))
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["next_paycheck_source"] == "month_end_fallback"
    assert result["next_paycheck_date"] == "2026-10-01"


def test_stale_employer_is_ignored_when_current_employer_stream_exists(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=1000.0)
    _biweekly_paycheck(factory, acct, last_date=TODAY - datetime.timedelta(days=32))
    for i in range(6):
        d = TODAY - datetime.timedelta(days=14 * (6 - i))
        factory.transaction(
            account_id=acct.id, amount=-1800.0, date=d,
            merchant_name="Current Employer", name="Current Employer Payroll",
            category="Income",
        )
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["next_paycheck_source"] == "recurring_income"
    assert result["next_paycheck_date"] == TODAY.isoformat()


def test_stale_income_grace_boundary_is_inclusive(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=1000.0)
    # For a 14-day stream, 2*interval+3 = 31 days is still accepted.
    _biweekly_paycheck(factory, acct, last_date=TODAY - datetime.timedelta(days=31))
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["next_paycheck_source"] == "recurring_income"


# ── spendable vs savings cash ────────────────────────────────────

def test_savings_excluded_checking_included(db: Session, factory):
    factory.account(name="Checking", subtype="checking", current_balance=1500.0)
    factory.account(name="Savings", subtype="savings", current_balance=9000.0)
    # A credit card / investment account shouldn't leak into either bucket.
    factory.account(name="Visa", type="credit", subtype="credit card", current_balance=-300.0)
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["spendable_cash"] == 1500.0
    assert result["savings_cash"] == 9000.0
    assert any("avings not counted" in n for n in result["notes"])


# ── bills before/after payday ────────────────────────────────────

def test_bills_before_payday_subtracted_bills_after_not(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=5000.0)
    factory.commit()  # no income stream -> fallback paycheck date = 2026-10-01

    mortgage_acct = factory.account(name="Home Loan", type="loan", subtype="mortgage", current_balance=-200000.0)
    db.add(MortgageDetail(
        account_id=mortgage_acct.id,
        next_payment_due_date=datetime.date(2026, 9, 10),   # before payday (Oct 1)
        next_monthly_payment=1800.0,
    ))
    cc_acct = factory.account(name="Visa", type="credit", subtype="credit card", current_balance=-500.0)
    db.add(CreditCardDetail(
        account_id=cc_acct.id,
        next_payment_due_date=datetime.date(2026, 10, 15),  # AFTER payday -> excluded
        last_statement_balance=500.0,
        minimum_payment_amount=35.0,
    ))
    db.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["next_paycheck_date"] == "2026-10-01"
    names = {b["name"] for b in result["bills"]}
    assert "Home Loan" in names
    assert "Visa" not in names
    assert result["bills_due"] == 1800.0


# ── budget pro-rating ─────────────────────────────────────────────

def test_budget_pro_rata_math_on_fixed_today(db: Session, factory):
    factory.account(subtype="checking", current_balance=2000.0)
    acct2 = factory.account(name="Spending card", subtype="checking", current_balance=0.0)

    budget = Budget(month=9, year=2026)
    budget.categories.append(BudgetCategory(category="Groceries", limit_amount=900.0))
    budget.categories.append(BudgetCategory(category="Shopping", limit_amount=300.0))
    budget.categories.append(BudgetCategory(category="Business", limit_amount=100.0))  # excluded
    db.add(budget)
    db.commit()

    factory.transaction(account_id=acct2.id, amount=200.0, date=datetime.date(2026, 9, 2), category="Groceries")
    factory.transaction(account_id=acct2.id, amount=50.0, date=datetime.date(2026, 9, 3), category="Shopping")
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    # remaining = (900-200) + (300-50) = 950; days_until_paycheck (fallback,
    # Oct 1) = 26 == days_left_in_month (30 - 5 + 1) -> ratio capped at 1.0.
    assert result["budget_source"] == "budget"
    assert result["budget_remaining_pro_rata"] == 950.0
    assert result["safe_to_spend"] == 2000.0 - 950.0


def test_trailing_average_used_when_no_budget(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=1000.0)
    # $900 of personal variable spend inside the trailing-90-day window.
    factory.transaction(account_id=acct.id, amount=900.0, date=TODAY - datetime.timedelta(days=10), category="Shopping")
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["budget_source"] == "trailing_average"
    expected_daily_rate = 900.0 / 90
    assert abs(result["budget_remaining_pro_rata"] - round(expected_daily_rate * result["days_until_paycheck"], 2)) < 0.01


# ── refunds and transfers never count toward spent ───────────────

def test_transfers_excluded_from_bills_due(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=1000.0)
    # A large recurring-looking TRANSFER must never appear in bills_due.
    for i in range(4):
        factory.transaction(
            account_id=acct.id, amount=600.0,
            date=TODAY - datetime.timedelta(days=30 * i),
            merchant_name="Internal Sweep", is_transfer=True,
        )
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["bills_due"] == 0.0
    assert result["bills"] == []


def test_repeating_refunds_never_mistaken_for_recurring_income(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=1000.0)
    # Several same-amount inflows at "Hardware Barn" 14 days apart, each
    # flagged as a refund — must NOT be picked up as a paycheck stream.
    for i in range(6):
        t = factory.transaction(
            account_id=acct.id, amount=-75.0,
            date=TODAY - datetime.timedelta(days=14 * (5 - i)) - datetime.timedelta(days=35),
            merchant_name="Hardware Barn", category="Home",
        )
        t.is_refund = True
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["next_paycheck_source"] == "month_end_fallback"


# ── empty DB ──────────────────────────────────────────────────────

def test_empty_db_is_well_shaped_and_zero(db: Session):
    result = compute_safe_to_spend(db, today=TODAY)

    assert result["safe_to_spend"] == 0.0
    assert result["spendable_cash"] == 0.0
    assert result["savings_cash"] == 0.0
    assert result["bills_due"] == 0.0
    assert result["budget_remaining_pro_rata"] == 0.0
    assert result["bills"] == []
    assert result["next_paycheck_source"] == "month_end_fallback"
    assert result["budget_source"] == "none"
    assert isinstance(result["notes"], list) and result["notes"]
    assert result["as_of"] == "2026-09-05"


def test_same_day_paycheck_excludes_tomorrow_bill(db, factory):
    acct = factory.account()
    _biweekly_paycheck(factory, acct, last_date=TODAY - datetime.timedelta(days=14))
    loan = factory.account(name="Home Loan", type="loan", subtype="mortgage")
    db.add(MortgageDetail(account_id=loan.id, next_payment_due_date=TODAY + datetime.timedelta(days=1), next_monthly_payment=100.0))
    factory.commit()
    result = compute_safe_to_spend(db, today=TODAY)
    assert result["next_paycheck_date"] == TODAY.isoformat()
    assert result["bills_due"] == 0


def test_bill_alias_dedup_does_not_hide_similarly_named_bill(db, factory):
    acct = factory.account()
    loan = factory.account(name="North Bank", type="loan", subtype="mortgage")
    loan.custom_name = "House"
    db.add(MortgageDetail(account_id=loan.id, next_payment_due_date=TODAY, next_monthly_payment=100.0))
    for name, amount in [("North Bank", 100.0), ("North Bank Insurance", 40.0)]:
        for days in (60, 30):
            factory.transaction(account_id=acct.id, merchant_name=name, amount=amount, date=TODAY - datetime.timedelta(days=days))
    factory.commit()
    result = compute_safe_to_spend(db, today=TODAY)
    assert result["bills_due"] == 140.0
    assert len(result["bills"]) == 2


def test_trailing_average_covers_exactly_90_inclusive_days(db, factory):
    acct = factory.account()
    factory.transaction(account_id=acct.id, amount=900.0, date=TODAY - datetime.timedelta(days=90))
    factory.transaction(account_id=acct.id, amount=90.0, date=TODAY - datetime.timedelta(days=89))
    factory.commit()
    result = compute_safe_to_spend(db, today=TODAY)
    assert result["budget_remaining_pro_rata"] == result["days_until_paycheck"]


# ── month-boundary budget coverage ───────────────────────────────

def _budget(db: Session, month: int, year: int, category: str, limit: float):
    budget = Budget(month=month, year=year)
    budget.categories.append(BudgetCategory(category=category, limit_amount=limit))
    db.add(budget)
    db.commit()
    return budget


def test_budget_window_crosses_calendar_year_and_ignores_future_ledger_rows(db, factory):
    today = datetime.date(2026, 12, 26)
    acct = factory.account(subtype="checking", current_balance=5000.0)
    _biweekly_paycheck(factory, acct, last_date=datetime.date(2026, 12, 25))
    _budget(db, 12, 2026, "Groceries", 1200.0)
    _budget(db, 1, 2027, "Groceries", 3100.0)
    factory.transaction(account_id=acct.id, amount=100.0, date=today, category="Groceries")
    # A scheduled row in the future month is not observed spend yet.
    factory.transaction(
        account_id=acct.id, amount=500.0,
        date=datetime.date(2027, 1, 2), category="Groceries",
    )
    factory.commit()

    result = compute_safe_to_spend(db, today=today)

    assert result["next_paycheck_date"] == "2027-01-08"
    assert result["days_until_paycheck"] == 13
    # Dec 26–31: $1,100 of Dec budget. Jan 1–7: 7/31 of $3,100 = $700.
    assert result["budget_remaining_pro_rata"] == 1800.0
    assert result["budget_source"] == "budget"


def test_budget_window_uses_leap_february_days(db, factory):
    today = datetime.date(2028, 1, 25)
    acct = factory.account(subtype="checking", current_balance=5000.0)
    _biweekly_paycheck(factory, acct, last_date=datetime.date(2028, 1, 22))
    _budget(db, 1, 2028, "Groceries", 700.0)
    _budget(db, 2, 2028, "Groceries", 2900.0)
    factory.transaction(account_id=acct.id, amount=100.0, date=today, category="Groceries")
    factory.transaction(
        account_id=acct.id, amount=1500.0,
        date=datetime.date(2028, 2, 2), category="Groceries",
    )
    factory.commit()

    result = compute_safe_to_spend(db, today=today)

    assert result["next_paycheck_date"] == "2028-02-05"
    assert result["days_until_paycheck"] == 11
    # Jan 25–31: $600. Feb 1–4: 4/29 of $2,900 = $400.
    assert result["budget_remaining_pro_rata"] == 1000.0
    assert result["budget_source"] == "budget"


def test_missing_future_budget_mixes_current_budget_with_trailing_average(db, factory):
    today = datetime.date(2026, 11, 22)
    acct = factory.account(subtype="checking", current_balance=5000.0)
    _biweekly_paycheck(factory, acct, last_date=datetime.date(2026, 11, 21))
    _budget(db, 11, 2026, "Groceries", 1000.0)
    factory.transaction(account_id=acct.id, amount=100.0, date=today, category="Groceries")
    # The no-budget December segment uses the 90-day rate: ($900 + $100) /
    # 90 × 4, since the trailing window includes current-month spend too.
    factory.transaction(
        account_id=acct.id, amount=900.0,
        date=datetime.date(2026, 11, 10), category="Shopping",
    )
    factory.commit()

    result = compute_safe_to_spend(db, today=today)

    assert result["next_paycheck_date"] == "2026-12-05"
    assert result["days_until_paycheck"] == 13
    # Nov 22–30: $900. Dec 1–4: trailing rate $11.11/day × 4 = $44.44.
    assert result["budget_remaining_pro_rata"] == 944.44
    assert result["budget_source"] == "mixed"
    assert any("Some months before payday" in note for note in result["notes"])


# Overlap matching must never remove credit-card reserves or unrelated spend.
import pytest
from app.services.safe_to_spend import _budget_remaining_pro_rata_details


@pytest.mark.parametrize("source,name,mixed,expected", [
    ("recurring", "StreamBox", False, 270.0),
    ("credit_card", "StreamBox", False, 300.0),
    ("recurring", "Different Payee", False, 300.0),
    ("recurring", "StreamBox", True, 300.0),
])
def test_overlap_only_offsets_known_stable_personal_categories(db, factory, source, name, mixed, expected):
    acct = factory.account()
    _budget(db, 9, 2026, "Subscriptions", 300.0)
    for i, days in enumerate((31, 62)):
        factory.transaction(account_id=acct.id, amount=30, date=TODAY-datetime.timedelta(days=days),
                            merchant_name="StreamBox", category="Shopping" if mixed and i else "Subscriptions")
    factory.commit()
    bills = [{"name": name, "source": source, "date": "2026-09-10", "amount": 30.0}]
    amount, _, adjustment = _budget_remaining_pro_rata_details(db, TODAY, 26, bills)
    assert amount == expected
    assert amount + adjustment == 300.0
    assert bills[0]["amount"] == 30.0


def test_trailing_overlap_uses_same_90_day_window_and_nets_refunds(db, factory):
    acct = factory.account()
    for days, amount in ((31, 30), (62, 30), (120, 900)):
        factory.transaction(account_id=acct.id, amount=amount, date=TODAY-datetime.timedelta(days=days),
                            merchant_name="StreamBox", category="Subscriptions")
    refund = factory.transaction(account_id=acct.id, amount=-20, date=TODAY,
                                  merchant_name="StreamBox", category="Subscriptions")
    refund.is_refund = True
    factory.transaction(account_id=acct.id, amount=90, date=TODAY, merchant_name="Grocer", category="Groceries")
    factory.commit()
    bills = [{"name": "StreamBox", "source": "recurring", "date": "2026-09-10", "amount": 30.0}]
    amount, source, adjustment = _budget_remaining_pro_rata_details(db, TODAY, 26, bills)
    assert source == "trailing_average"
    assert amount == 26.0  # Only unrelated groceries remain in the daily allowance.
    assert adjustment == round(40 / 90 * 26, 2)
    other_refund = factory.transaction(account_id=acct.id, amount=-300, date=TODAY,
                                        merchant_name="Grocer", category="Groceries")
    other_refund.is_refund = True
    factory.commit()
    amount, _, adjustment = _budget_remaining_pro_rata_details(db, TODAY, 26, bills)
    assert amount == 0.0 and adjustment == 0.0


def test_overlap_is_confined_to_the_bill_month(db, factory):
    today = datetime.date(2027, 1, 30)
    acct = factory.account()
    _budget(db, 1, 2027, "Subscriptions", 310)
    _budget(db, 2, 2027, "Subscriptions", 280)
    for day in (1, 15):
        factory.transaction(account_id=acct.id, amount=10, date=today.replace(day=day),
                            merchant_name="StreamBox", category="Subscriptions")
    factory.commit()
    bills = [{"name": "StreamBox", "source": "recurring", "date": "2027-02-02", "amount": 20}]
    amount, _, adjustment = _budget_remaining_pro_rata_details(db, today, 5, bills)
    assert amount == 300  # January remaining 290 plus February allowance 30 minus bill 20.
    assert adjustment == 20
