"""Tests for the /api/analytics/top-merchants endpoint.

The endpoint accepts either:
  - months (rolling lookback, the existing UI shape), OR
  - start_date + end_date (arbitrary half-open range, used by the MCP
    server for windows that don't align to a months lookback).

Before the start_date/end_date branch was added, the MCP tool's
schema advertised those params but the backend silently ignored them
and returned a 6-month default — a worse-than-422 footgun because
nothing surfaced to the caller. These tests pin the new behavior in
place so a future refactor can't reintroduce that drift.
"""
from __future__ import annotations
import datetime as _dt

from fastapi import HTTPException
import pytest

from app.routers.analytics import top_merchants


def _april(day: int) -> _dt.date:
    return _dt.date(2026, 4, day)


def test_top_merchants_explicit_range_overrides_months(db, factory):
    """When start_date + end_date are both supplied, the explicit window
    wins over the months default. Verified by stuffing transactions far
    outside the range and confirming they don't bleed into the totals."""
    acct = factory.account()
    factory.commit()
    # Way outside range — must not appear in totals
    factory.transaction(account_id=acct.id, amount=999.0, date=_dt.date(2025, 1, 5),
                        category="Old", merchant_name="Ancient Co")
    # Inside [Apr 1, Apr 15)
    factory.transaction(account_id=acct.id, amount=100.0, date=_april(2),
                        category="Food", merchant_name="Coffee Shop")
    factory.transaction(account_id=acct.id, amount=50.0, date=_april(10),
                        category="Food", merchant_name="Coffee Shop")
    # Boundary day excluded (end is exclusive)
    factory.transaction(account_id=acct.id, amount=777.0, date=_april(15),
                        category="Boundary", merchant_name="Boundary Co")
    factory.commit()

    out = top_merchants(
        months=6, limit=20, business_id=None,
        start_date=_april(1), end_date=_april(15),
        db=db,
    )
    merchants_by_name = {m["merchant"]: m for m in out["merchants"]}
    assert "Coffee Shop" in merchants_by_name
    assert merchants_by_name["Coffee Shop"]["total"] == 150.0
    assert "Ancient Co" not in merchants_by_name
    assert "Boundary Co" not in merchants_by_name


def test_top_merchants_defaults_to_months_lookback_when_no_dates(db, factory):
    """No date args = the original UI shape. Months drives both the
    lookback window and the sparkline length."""
    acct = factory.account()
    factory.commit()
    today = _dt.date.today()
    factory.transaction(account_id=acct.id, amount=42.0, date=today,
                        category="Food", merchant_name="Today Cafe")
    factory.commit()

    out = top_merchants(
        months=3, limit=10, business_id=None,
        start_date=None, end_date=None,
        db=db,
    )
    assert out["months"] == 3
    merchants = {m["merchant"]: m for m in out["merchants"]}
    assert merchants.get("Today Cafe", {}).get("total") == 42.0
    # Sparkline should have 3 buckets matching the lookback
    assert len(merchants["Today Cafe"]["sparkline"]) == 3


def test_top_merchants_rejects_unpaired_date():
    """Half-supplied range = silent footgun if we let it through. Must
    400 so the caller sees their mistake."""
    with pytest.raises(HTTPException) as exc:
        top_merchants(
            months=6, limit=20, business_id=None,
            start_date=_april(1), end_date=None,
            db=None,
        )
    assert exc.value.status_code == 400


def test_top_merchants_rejects_inverted_range():
    """end <= start = malformed. Returning zero merchants would mislead."""
    with pytest.raises(HTTPException) as exc:
        top_merchants(
            months=6, limit=20, business_id=None,
            start_date=_april(10), end_date=_april(5),
            db=None,
        )
    assert exc.value.status_code == 400


def test_top_merchants_sparkline_length_matches_range_in_months(db, factory):
    """For an explicit range, the sparkline has one bucket per month
    (rounded up). This is informational rather than precise — users
    passing arbitrary windows care about totals, not sparkline shape —
    but it shouldn't be wildly wrong (e.g. all 6 months of buckets for
    a 30-day window, which was the silent-fall-through behavior)."""
    acct = factory.account()
    factory.commit()
    factory.transaction(account_id=acct.id, amount=100.0, date=_april(5),
                        category="Food", merchant_name="Cafe")
    factory.commit()

    # 30-day window → 1 sparkline bucket
    out_30 = top_merchants(
        months=6, limit=10, business_id=None,
        start_date=_april(1), end_date=_dt.date(2026, 5, 1),
        db=db,
    )
    cafe_30 = next(m for m in out_30["merchants"] if m["merchant"] == "Cafe")
    assert len(cafe_30["sparkline"]) == 1

    # 90-day window → 3 sparkline buckets
    out_90 = top_merchants(
        months=6, limit=10, business_id=None,
        start_date=_dt.date(2026, 2, 1), end_date=_dt.date(2026, 5, 1),
        db=db,
    )
    cafe_90 = next(m for m in out_90["merchants"] if m["merchant"] == "Cafe")
    assert len(cafe_90["sparkline"]) == 3
