"""Tests for the business-aware spending-summary endpoint.

The endpoint splits transactions into personal vs business based on
each TxnLine's business_id, driven by a `business_filter` query param
(all|personal|business). business_total is computed unconditionally so
the Budgets page can render a Business rollup tile even when the
categories list is filtered to personal-only.

These tests call the route function directly (not through HTTP) since
that's the simplest way to inject a per-test in-memory SQLite session.
"""
from __future__ import annotations
import datetime as _dt

from app.routers.transactions import spending_summary


def _april(day: int) -> _dt.date:
    return _dt.date(2026, 4, day)


def test_spending_summary_default_includes_everything(db, factory):
    """Default business_filter='all' = legacy behavior: business spend
    is mixed in with personal categories. business_total is still
    populated so callers that want the breakdown can read it."""
    acct = factory.account()
    biz = factory.business(name="Test LLC")
    factory.commit()

    factory.transaction(account_id=acct.id, amount=200.0, date=_april(5),
                        category="Food & Dining", merchant_name="Restaurant A")
    factory.transaction(account_id=acct.id, amount=100.0, date=_april(7),
                        category="Services", merchant_name="Office X",
                        business_id=biz.id)
    factory.commit()

    out = spending_summary(month=4, year=2026, business_filter="all", db=db)

    cats = {c.category: c.total for c in out.categories}
    assert cats == {"Food & Dining": 200.0, "Services": 100.0}
    assert out.total_spent == 300.0
    # business_total is always reported, regardless of filter
    assert out.business_total == 100.0


def test_spending_summary_personal_excludes_business_from_categories(db, factory):
    """business_filter='personal' = the Budgets page default. Business
    spend is removed from the categories list so personal totals aren't
    inflated, but business_total still surfaces the rollup figure."""
    acct = factory.account()
    biz = factory.business(name="Test LLC")
    factory.commit()

    factory.transaction(account_id=acct.id, amount=200.0, date=_april(5),
                        category="Food & Dining", merchant_name="Restaurant A")
    factory.transaction(account_id=acct.id, amount=100.0, date=_april(7),
                        category="Services", merchant_name="Office X",
                        business_id=biz.id)
    # Same category as business but personal — must NOT be filtered out
    factory.transaction(account_id=acct.id, amount=50.0, date=_april(9),
                        category="Services", merchant_name="Personal SaaS")
    factory.commit()

    out = spending_summary(month=4, year=2026, business_filter="personal", db=db)

    cats = {c.category: c.total for c in out.categories}
    assert cats == {"Food & Dining": 200.0, "Services": 50.0}
    assert out.total_spent == 250.0
    assert out.business_total == 100.0


def test_spending_summary_business_only(db, factory):
    """business_filter='business' = inverse view. Useful for Schedule C
    bucketing during tax prep — see only what's tagged to a business."""
    acct = factory.account()
    biz = factory.business(name="Test LLC")
    factory.commit()

    factory.transaction(account_id=acct.id, amount=200.0, date=_april(5),
                        category="Food & Dining", merchant_name="Restaurant A")
    factory.transaction(account_id=acct.id, amount=100.0, date=_april(7),
                        category="Services", merchant_name="Office X",
                        business_id=biz.id)
    factory.transaction(account_id=acct.id, amount=300.0, date=_april(9),
                        category="Travel", merchant_name="Airline",
                        business_id=biz.id)
    factory.commit()

    out = spending_summary(month=4, year=2026, business_filter="business", db=db)

    cats = {c.category: c.total for c in out.categories}
    assert cats == {"Services": 100.0, "Travel": 300.0}
    assert out.total_spent == 400.0
    # business_total reflects the same dollars as total_spent here
    assert out.business_total == 400.0


def test_spending_summary_excludes_transfers_regardless_of_filter(db, factory):
    """Transfers are never spending. The is_transfer guard fires
    before the business filter, so a flagged transfer never lands in
    categories OR in business_total — even if it's tagged to a business."""
    acct = factory.account()
    biz = factory.business(name="Test LLC")
    factory.commit()

    factory.transaction(account_id=acct.id, amount=500.0, date=_april(3),
                        category="Loan Payments", is_transfer=True,
                        merchant_name="Mortgage Co")
    factory.transaction(account_id=acct.id, amount=400.0, date=_april(5),
                        category="Services", is_transfer=True,
                        business_id=biz.id, merchant_name="Internal xfer")
    factory.transaction(account_id=acct.id, amount=200.0, date=_april(7),
                        category="Food & Dining", merchant_name="Real spend")
    factory.commit()

    out = spending_summary(month=4, year=2026, business_filter="all", db=db)
    cats = {c.category: c.total for c in out.categories}
    assert cats == {"Food & Dining": 200.0}
    assert out.business_total == 0.0


def test_business_total_populated_when_personal_filter(db, factory):
    """The whole point of always-populating business_total: the UI in
    'personal' view still needs to render the Business rollup tile."""
    acct = factory.account()
    biz = factory.business(name="Test LLC")
    factory.commit()

    factory.transaction(account_id=acct.id, amount=100.0, date=_april(5),
                        category="Food & Dining", merchant_name="Restaurant")
    factory.transaction(account_id=acct.id, amount=350.0, date=_april(7),
                        category="Services", merchant_name="Office",
                        business_id=biz.id)
    factory.commit()

    out_personal = spending_summary(month=4, year=2026, business_filter="personal", db=db)
    assert out_personal.business_total == 350.0
    # ...and the categories list does NOT include the business txn
    assert all(c.total != 350.0 or c.category != "Services" for c in out_personal.categories)


def test_business_budget_limit_pulled_from_synthetic_category(db, factory):
    """A regular BudgetCategory with category='Business' is treated as
    the synthetic Business rollup limit and surfaced via the dedicated
    business_budget_limit field — not mixed into categories[]."""
    from app.models import Budget, BudgetCategory

    acct = factory.account()
    biz = factory.business(name="Test LLC")
    factory.commit()

    factory.transaction(account_id=acct.id, amount=100.0, date=_april(5),
                        category="Food & Dining", merchant_name="Restaurant")
    factory.transaction(account_id=acct.id, amount=350.0, date=_april(7),
                        category="Services", merchant_name="Office",
                        business_id=biz.id)
    # Set up a budget with both a normal category and the synthetic Business one
    budget = Budget(month=4, year=2026, total_limit=2000.0)
    db.add(budget)
    db.flush()
    db.add(BudgetCategory(budget_id=budget.id, category="Food & Dining", limit_amount=300.0))
    db.add(BudgetCategory(budget_id=budget.id, category="Business", limit_amount=500.0))
    factory.commit()

    out = spending_summary(month=4, year=2026, business_filter="personal", db=db)
    # Personal category gets its limit attached as before
    food = next(c for c in out.categories if c.category == "Food & Dining")
    assert food.budget_limit == 300.0
    # Business limit comes through the dedicated field, NOT in categories[]
    assert out.business_budget_limit == 500.0
    assert all(c.category != "Business" for c in out.categories)


def test_spending_summary_start_end_date_overrides_month_year(db, factory):
    """When start_date + end_date are both provided, they take precedence
    over month/year. Aggregates only what falls in the half-open range.

    The MCP server passes start_date/end_date for arbitrary windows
    (e.g. a 90-day rolling lookback) that don't align to a calendar
    month — without this branch, the endpoint 422s on missing month/year.
    """
    acct = factory.account()
    factory.commit()
    # March 25 — outside range
    factory.transaction(account_id=acct.id, amount=999.0, date=_dt.date(2026, 3, 25),
                        category="Outside", merchant_name="X")
    # April 1 — inside range
    factory.transaction(account_id=acct.id, amount=100.0, date=_april(1),
                        category="Food & Dining", merchant_name="Restaurant A")
    # April 14 — inside range
    factory.transaction(account_id=acct.id, amount=50.0, date=_april(14),
                        category="Food & Dining", merchant_name="Restaurant B")
    # April 15 — at boundary, EXCLUDED (end is exclusive)
    factory.transaction(account_id=acct.id, amount=777.0, date=_april(15),
                        category="Boundary", merchant_name="Y")
    factory.commit()

    out = spending_summary(
        month=None, year=None,
        start_date=_april(1), end_date=_april(15),
        business_filter="all", db=db,
    )
    cats = {c.category: c.total for c in out.categories}
    assert cats == {"Food & Dining": 150.0}
    assert out.total_spent == 150.0
    # Response month/year mirrors the start_date so client schema is stable
    assert out.month == 4
    assert out.year == 2026


def test_spending_summary_defaults_to_current_month_when_nothing_passed(db, factory):
    """No args = current calendar month. Lets casual MCP callers ask
    'what have I spent this month' without supplying date params."""
    today = _dt.date.today()
    acct = factory.account()
    factory.commit()
    factory.transaction(account_id=acct.id, amount=42.0, date=today,
                        category="Food & Dining", merchant_name="Today")
    factory.commit()

    out = spending_summary(
        month=None, year=None,
        start_date=None, end_date=None,
        business_filter="all", db=db,
    )
    assert out.month == today.month
    assert out.year == today.year
    cats = {c.category: c.total for c in out.categories}
    assert cats.get("Food & Dining", 0) >= 42.0


def test_spending_summary_rejects_unpaired_start_date():
    """Half-supplied range = footgun. Must be rejected loudly, not
    silently fall back to month/year."""
    from fastapi import HTTPException
    import pytest
    with pytest.raises(HTTPException) as exc:
        spending_summary(
            month=None, year=None,
            start_date=_april(1), end_date=None,
            business_filter="all", db=None,
        )
    assert exc.value.status_code == 400


def test_spending_summary_rejects_inverted_range():
    """end_date <= start_date is malformed. The endpoint silently
    returning zero rows would mislead users who flipped the args."""
    from fastapi import HTTPException
    import pytest
    with pytest.raises(HTTPException) as exc:
        spending_summary(
            month=None, year=None,
            start_date=_april(10), end_date=_april(5),
            business_filter="all", db=None,
        )
    assert exc.value.status_code == 400


def test_business_filter_invalid_value_rejected_by_query_validator():
    """The regex on the Query() catches typos before they reach the
    function body. We don't need to test the regex itself in detail —
    just confirm the param has the regex attached so a future refactor
    can't silently broaden it (e.g., dropping the regex would let a
    malformed value through and silently skip both branches of the
    if/elif, which == 'all' behavior — easy to miss in review)."""
    import inspect
    from app.routers.transactions import spending_summary as ss
    sig = inspect.signature(ss)
    bf = sig.parameters["business_filter"].default
    # FastAPI Query() default; check it has a regex constraint
    # (compatible with both pydantic v1 and v2 styles)
    has_regex = (
        getattr(bf, "regex", None)
        or (hasattr(bf, "metadata") and any(
            getattr(m, "pattern", None) for m in bf.metadata
        ))
    )
    assert has_regex, "business_filter must have a regex/pattern constraint"
