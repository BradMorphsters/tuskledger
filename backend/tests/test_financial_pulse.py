"""Tests for /analytics/financial-pulse.

The financial pulse endpoint aggregates four signals (liquidity, savings
rate, budget adherence, debt service) into a 0-100 score. These tests
exercise the happy path and the corner cases that produce divide-by-zero
or NaN if the math isn't defensive.
"""
import datetime
from sqlalchemy.orm import Session

from app.routers.analytics import financial_pulse


def test_pulse_returns_well_shaped_response_on_empty_db(db: Session):
    """Empty database (no accounts, no transactions) should return a
    valid response shape — no exceptions, no NaN values. Score may be
    arbitrary but the structure must be intact for the frontend tile."""
    result = financial_pulse(monthly_payroll_deferral=0.0, db=db)
    assert "score" in result
    assert "components" in result
    assert isinstance(result["score"], (int, float))
    # Score is bounded 0-100.
    assert 0 <= result["score"] <= 100
    # All four components present even when data is absent.
    component_keys = {c["key"] for c in result["components"]}
    assert {"liquidity", "savings", "budget", "debt"}.issubset(component_keys)


def test_pulse_with_basic_account_data(db: Session, factory):
    """A user with a checking account, monthly paycheck, and modest
    spending should get back a non-trivial score with populated
    component data."""
    today = datetime.date.today()
    checking = factory.account(
        name="Checking", type="depository", subtype="checking",
        current_balance=10_000.0,
    )
    # 3 months of monthly paychecks ($5k each — total $15k income)
    for months_back in range(3):
        d = today.replace(day=15) - datetime.timedelta(days=30 * months_back)
        factory.transaction(
            account_id=checking.id, amount=-5_000.0, date=d,
            merchant_name="Employer Inc", category="Income",
        )
    # 90 days of $50/day spending = $4500 total expenses
    for days_back in range(90):
        factory.transaction(
            account_id=checking.id, amount=50.0,
            date=today - datetime.timedelta(days=days_back),
            merchant_name="Misc", category="Shopping",
        )
    factory.commit()

    result = financial_pulse(monthly_payroll_deferral=0.0, db=db)
    assert result["score"] >= 0
    # Liquidity component should show measurable runway given $10k cash.
    liquidity = next(c for c in result["components"] if c["key"] == "liquidity")
    assert liquidity["value"] > 0


def test_pulse_payroll_deferral_increases_savings_rate(db: Session, factory):
    """The monthly_payroll_deferral parameter is the 'true savings rate'
    correction — it adds back the 401(k) deductions that don't show up
    as visible income in Plaid. A user with $1000/mo deferral should
    get a higher savings rate component than the same user reporting 0."""
    today = datetime.date.today()
    checking = factory.account(
        name="Checking", current_balance=5_000.0,
    )
    # 3 months of $4k take-home (the AFTER-deferral paycheck)
    for months_back in range(3):
        d = today.replace(day=15) - datetime.timedelta(days=30 * months_back)
        factory.transaction(
            account_id=checking.id, amount=-4_000.0, date=d,
            merchant_name="Employer Inc",
        )
    # $3000/month of spending
    for days_back in range(90):
        factory.transaction(
            account_id=checking.id, amount=100.0,
            date=today - datetime.timedelta(days=days_back),
            merchant_name="Spending",
        )
    factory.commit()

    no_deferral = financial_pulse(monthly_payroll_deferral=0.0, db=db)
    with_deferral = financial_pulse(monthly_payroll_deferral=1_000.0, db=db)

    # With $1k/mo invisible deferral added back, savings rate component
    # should be higher than the visible-only baseline.
    no_def_savings = next(c for c in no_deferral["components"] if c["key"] == "savings")
    with_def_savings = next(c for c in with_deferral["components"] if c["key"] == "savings")
    assert with_def_savings["value"] > no_def_savings["value"]
