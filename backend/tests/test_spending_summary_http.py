"""HTTP-level tests for /api/transactions/spending-summary.

We already have function-level tests in test_spending_summary.py that
exercise the Python signature directly. These complement them by going
through TestClient → FastAPI router → Pydantic deserialization →
SpendingSummary serialization, which is the path real users hit.

Why both layers? FastAPI minor-version bumps occasionally change query
param parsing (regex format, type coercion) or response serialization
(Pydantic v2's `from_attributes` vs old `orm_mode`, datetime handling).
Function tests miss those because they bypass the FastAPI machinery.
HTTP tests catch them.
"""
from __future__ import annotations

import datetime as _dt

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.config import settings
from app.database import get_db, get_real_db


@pytest.fixture
def client(db, factory, monkeypatch):
    """TestClient with both get_db and get_real_db pointing at the in-memory
    test session, so neither the spending-summary route (uses get_db) nor
    the auth router (uses get_real_db) writes to the user's actual DB."""
    monkeypatch.setattr(settings, "DEV_BYPASS_AUTH", True)  # skip auth for these tests
    monkeypatch.setattr(settings, "DEMO_ENABLED", False)

    def _override():
        yield db

    app.dependency_overrides[get_db] = _override
    app.dependency_overrides[get_real_db] = _override
    yield TestClient(app)
    app.dependency_overrides.clear()


def _april(day: int) -> _dt.date:
    return _dt.date(2026, 4, day)


def test_default_business_filter_is_all(client, db, factory):
    """No business_filter param → must default to 'all' (back-compat
    contract for any existing client of this endpoint)."""
    acct = factory.account()
    biz = factory.business(name="Test LLC")
    factory.commit()
    factory.transaction(account_id=acct.id, amount=200.0, date=_april(5),
                        category="Food & Dining", merchant_name="Restaurant")
    factory.transaction(account_id=acct.id, amount=100.0, date=_april(7),
                        category="Services", merchant_name="Office",
                        business_id=biz.id)
    factory.commit()

    r = client.get("/api/transactions/spending-summary?month=4&year=2026")
    assert r.status_code == 200
    body = r.json()
    cats = {c["category"]: c["total"] for c in body["categories"]}
    assert cats == {"Food & Dining": 200.0, "Services": 100.0}
    assert body["total_spent"] == 300.0
    assert body["business_total"] == 100.0


def test_personal_filter_excludes_business_via_query_param(client, db, factory):
    """The query param flow must propagate through to the route logic.
    Catches FastAPI Query() parsing regressions."""
    acct = factory.account()
    biz = factory.business(name="Test LLC")
    factory.commit()
    factory.transaction(account_id=acct.id, amount=200.0, date=_april(5),
                        category="Food & Dining", merchant_name="Restaurant")
    factory.transaction(account_id=acct.id, amount=100.0, date=_april(7),
                        category="Services", merchant_name="Office",
                        business_id=biz.id)
    factory.commit()

    r = client.get("/api/transactions/spending-summary?month=4&year=2026&business_filter=personal")
    assert r.status_code == 200
    body = r.json()
    cats = {c["category"]: c["total"] for c in body["categories"]}
    assert cats == {"Food & Dining": 200.0}, "business spend should be excluded"
    assert body["business_total"] == 100.0, "business_total reported regardless of filter"


def test_business_filter_invalid_value_returns_422(client):
    """The Query() regex must reject typos before they reach handler code.
    A regression here would silently fall through to default 'all'
    behavior, which is hard to notice from outside."""
    r = client.get("/api/transactions/spending-summary?month=4&year=2026&business_filter=oops")
    assert r.status_code == 422, \
        "invalid business_filter value should be rejected by FastAPI validation"


def test_response_shape_matches_pydantic_schema(client, db, factory):
    """The response body must contain every field SpendingSummary declares.
    If a Pydantic v2 patch changes serialization defaults (e.g. dropping
    None fields by default), the frontend will break in subtle ways."""
    factory.account()
    factory.commit()

    r = client.get("/api/transactions/spending-summary?month=4&year=2026")
    assert r.status_code == 200
    body = r.json()
    required_keys = {"month", "year", "total_spent", "categories",
                     "business_total", "business_budget_limit"}
    assert required_keys <= set(body.keys()), \
        f"Response missing required keys: {required_keys - set(body.keys())}"


def test_business_only_filter_inverts_result(client, db, factory):
    """business_filter=business → only business-tagged spend lands in
    categories. Useful for the Schedule C view."""
    acct = factory.account()
    biz = factory.business(name="LLC")
    factory.commit()
    factory.transaction(account_id=acct.id, amount=50.0, date=_april(2),
                        category="Personal Care", merchant_name="Haircut")
    factory.transaction(account_id=acct.id, amount=300.0, date=_april(3),
                        category="Travel", merchant_name="Flight",
                        business_id=biz.id)
    factory.commit()

    r = client.get("/api/transactions/spending-summary?month=4&year=2026&business_filter=business")
    body = r.json()
    cats = {c["category"]: c["total"] for c in body["categories"]}
    assert cats == {"Travel": 300.0}
    assert body["total_spent"] == 300.0
    assert body["business_total"] == 300.0


def test_synthetic_business_budget_surfaces_via_dedicated_field(client, db, factory):
    """A regular BudgetCategory(category='Business', limit_amount=X) is
    special-cased — it must appear ONLY in business_budget_limit, never
    in categories[]. This is what powers the Business rollup row on the
    Budgets page."""
    from app.models import Budget, BudgetCategory

    acct = factory.account()
    biz = factory.business(name="LLC")
    factory.commit()
    factory.transaction(account_id=acct.id, amount=100.0, date=_april(5),
                        category="Food & Drink", merchant_name="Restaurant")
    factory.transaction(account_id=acct.id, amount=350.0, date=_april(7),
                        category="Services", merchant_name="Office",
                        business_id=biz.id)
    budget = Budget(month=4, year=2026, total_limit=2000.0)
    db.add(budget)
    db.flush()
    db.add(BudgetCategory(budget_id=budget.id, category="Food & Drink", limit_amount=200.0))
    db.add(BudgetCategory(budget_id=budget.id, category="Business", limit_amount=500.0))
    factory.commit()

    r = client.get("/api/transactions/spending-summary?month=4&year=2026&business_filter=personal")
    body = r.json()
    assert body["business_budget_limit"] == 500.0
    assert all(c["category"] != "Business" for c in body["categories"]), \
        "synthetic Business category must NOT appear in categories list"
