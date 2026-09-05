"""Tests for pace-aware budget adherence (services/budget_health.py) and
its wiring into /analytics/financial-pulse."""
import datetime

from sqlalchemy.orm import Session

from app.models import Budget, BudgetCategory
from app.services.budget_health import (
    budget_adherence,
    elapsed_fraction_for,
    line_score,
)


def _budget(db: Session, month: int, year: int, lines: dict[str, float]) -> Budget:
    b = Budget(month=month, year=year)
    for cat, limit in lines.items():
        b.categories.append(BudgetCategory(category=cat, limit_amount=limit))
    db.add(b)
    db.commit()
    return b


# ── line_score ────────────────────────────────────────────────

def test_line_score_is_100_at_or_under_pace():
    # Half the month gone, half the limit spent → exactly on pace.
    assert line_score(spent=500, limit=1000, elapsed_fraction=0.5) == 100.0
    assert line_score(spent=100, limit=1000, elapsed_fraction=0.5) == 100.0
    assert line_score(spent=0, limit=1000, elapsed_fraction=0.5) == 100.0


def test_line_score_decays_linearly_to_zero_at_double_pace():
    assert line_score(spent=750, limit=1000, elapsed_fraction=0.5) == 50.0   # 1.5× pace
    assert line_score(spent=1000, limit=1000, elapsed_fraction=0.5) == 0.0   # 2× pace
    assert line_score(spent=5000, limit=1000, elapsed_fraction=0.5) == 0.0   # never negative


def test_line_score_ignores_lines_without_a_limit():
    assert line_score(spent=900, limit=0, elapsed_fraction=0.5) == 100.0


# ── elapsed_fraction_for ─────────────────────────────────────

def test_first_days_are_judged_as_if_a_week_had_passed():
    # Sept 1: raw fraction would be 1/30; floored to 7/30.
    assert elapsed_fraction_for(datetime.date(2026, 9, 1)) == 7 / 30
    assert elapsed_fraction_for(datetime.date(2026, 9, 7)) == 7 / 30
    assert elapsed_fraction_for(datetime.date(2026, 9, 15)) == 15 / 30
    assert elapsed_fraction_for(datetime.date(2026, 9, 30)) == 1.0


# ── budget_adherence ─────────────────────────────────────────

def test_no_budget_for_the_month_returns_none(db: Session):
    _budget(db, 8, 2026, {"Groceries": 500.0})
    assert budget_adherence(db, today=datetime.date(2026, 9, 15)) is None


def test_budget_with_only_business_or_zero_lines_returns_none(db: Session):
    _budget(db, 9, 2026, {"Business": 200.0, "Empty": 0.0})
    assert budget_adherence(db, today=datetime.date(2026, 9, 15)) is None


def test_adherence_is_pace_aware_and_limit_weighted(db: Session, factory):
    today = datetime.date(2026, 9, 15)   # elapsed = 0.5
    acct = factory.account(name="Checking")
    _budget(db, 9, 2026, {"Groceries": 600.0, "Shopping": 2400.0, "Business": 100.0})
    # Groceries: $600 limit, $150 spent → well under pace (score 100).
    factory.transaction(account_id=acct.id, amount=150.0, date=datetime.date(2026, 9, 3), category="Groceries")
    # Shopping: $2400 limit, $1800 spent → 1.5× pace (score 50).
    factory.transaction(account_id=acct.id, amount=1800.0, date=datetime.date(2026, 9, 10), category="Shopping")
    # Noise that must be ignored: a transfer, a business-tagged purchase,
    # an inflow, and a purchase dated after `today`.
    factory.transaction(account_id=acct.id, amount=500.0, date=datetime.date(2026, 9, 4), category="Shopping", is_transfer=True)
    factory.transaction(account_id=acct.id, amount=-40.0, date=datetime.date(2026, 9, 4), category="Shopping")
    factory.transaction(account_id=acct.id, amount=900.0, date=datetime.date(2026, 9, 20), category="Shopping")
    factory.commit()

    got = budget_adherence(db, today=today)

    assert got["lines"] == 2                 # Business line excluded
    assert got["on_pace"] == 1
    assert got["value"] == 50.0              # 1 of 2 lines on pace
    assert got["elapsed_pct"] == 50.0
    # Limit-weighted: (100 × 600 + 50 × 2400) / 3000 = 60
    assert got["score"] == 60.0
    worst = got["detail"][0]
    assert worst["category"] == "Shopping"
    assert worst["spent"] == 1800.0
    assert worst["pace_limit"] == 1200.0


def test_custom_category_override_counts_toward_its_budget_line(db: Session, factory):
    today = datetime.date(2026, 9, 15)
    acct = factory.account(name="Checking")
    _budget(db, 9, 2026, {"Childcare": 1000.0})
    t = factory.transaction(account_id=acct.id, amount=900.0, date=datetime.date(2026, 9, 2), category="Services")
    t.custom_category = "Childcare"
    factory.commit()
    got = budget_adherence(db, today=today)
    assert got["detail"][0]["spent"] == 900.0
    # 900 vs pace 500 → ratio 1.8 → score 20
    assert abs(got["detail"][0]["score"] - 20.0) < 0.1


# ── financial-pulse wiring ───────────────────────────────────

def test_pulse_drops_and_reweights_budget_component_when_no_budget(db: Session):
    from app.routers.analytics import financial_pulse
    result = financial_pulse(monthly_payroll_deferral=0.0, db=db)
    comp = result["components"]
    assert comp["budget"]["available"] is False
    assert comp["budget"]["score"] is None
    assert comp["budget"]["weight"] == 0.0
    # The other three re-normalize to 1.0 — no filler value in the score.
    total = comp["liquidity"]["weight"] + comp["savings"]["weight"] + comp["debt"]["weight"]
    assert abs(total - 1.0) < 1e-6
    assert 0 <= result["score"] <= 100


def test_pulse_uses_real_adherence_when_budget_exists(db: Session, factory):
    from app.routers.analytics import financial_pulse
    today = datetime.date.today()
    acct = factory.account(name="Checking")
    _budget(db, today.month, today.year, {"Groceries": 1000.0})
    # Something small, dated the 1st, so it's under pace on any day.
    factory.transaction(account_id=acct.id, amount=10.0, date=today.replace(day=1), category="Groceries")
    factory.commit()
    result = financial_pulse(monthly_payroll_deferral=0.0, db=db)
    comp = result["components"]["budget"]
    assert comp["available"] is True
    assert comp["score"] == 100.0
    assert comp["value"] == 100.0
    assert comp["weight"] == 0.15
    assert comp["lines"] == 1 and comp["on_pace"] == 1
