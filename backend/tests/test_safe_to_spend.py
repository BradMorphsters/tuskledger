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
    # Last actual deposit is 35 days before `today` — the raw next_date
    # (last_date + 14) would be in the past twice before reaching today,
    # exercising the roll-forward loop rather than a single step.
    _biweekly_paycheck(factory, acct, last_date=TODAY - datetime.timedelta(days=35))
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["next_paycheck_source"] == "recurring_income"
    assert result["next_paycheck_date"] == "2026-09-12"
    assert result["days_until_paycheck"] == 7


def test_month_end_fallback_when_no_income_stream(db: Session, factory):
    acct = factory.account(subtype="checking", current_balance=1000.0)
    factory.commit()

    result = compute_safe_to_spend(db, today=TODAY)

    assert result["next_paycheck_source"] == "month_end_fallback"
    assert result["next_paycheck_date"] == "2026-10-01"
    assert result["days_until_paycheck"] == 26
    assert any("1st of next month" in n for n in result["notes"])


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
