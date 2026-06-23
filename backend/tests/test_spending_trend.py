"""Tests for the /analytics/spending-trend endpoint (the Spending pace tile).

The endpoint returns this month's cumulative spend by day-of-month plus a
baseline curve that is the average of the prior N calendar months'
cumulative-by-day curves (an N-month moving average). Called directly with a
per-test in-memory session, the same way test_spending_summary does, and
anchored to date.today() so it's deterministic regardless of when it runs.
"""
from __future__ import annotations

import calendar
import datetime as _dt

from app.routers.analytics import spending_trend


def _months_back(y: int, m: int, n: int) -> tuple[int, int]:
    for _ in range(n):
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return y, m


def test_baseline_is_moving_average_of_prior_months(db, factory):
    today = _dt.date.today()
    cy, cm = today.year, today.month
    acct = factory.account()
    factory.commit()

    # Current month, day 1: $100 spend, plus a transfer and an income/refund
    # line that must NOT be counted as spending.
    factory.transaction(account_id=acct.id, amount=100.0, date=_dt.date(cy, cm, 1), category="Shopping")
    factory.transaction(account_id=acct.id, amount=500.0, date=_dt.date(cy, cm, 1), category="Transfer", is_transfer=True)
    factory.transaction(account_id=acct.id, amount=-300.0, date=_dt.date(cy, cm, 1), category="Income")

    # Prior month: $200 on day 1. Two months ago: $400 on day 1.
    y1, m1 = _months_back(cy, cm, 1)
    y2, m2 = _months_back(cy, cm, 2)
    factory.transaction(account_id=acct.id, amount=200.0, date=_dt.date(y1, m1, 1), category="Shopping")
    factory.transaction(account_id=acct.id, amount=400.0, date=_dt.date(y2, m2, 1), category="Shopping")
    factory.commit()

    out = spending_trend(months=2, db=db)

    # Baseline averages the two prior months (oldest → newest in the label).
    assert out["baseline_window"] == 2
    assert out["baseline_months"] == [f"{y2}-{m2:02d}", f"{y1}-{m1:02d}"]

    # Day-1 baseline = avg(200, 400) = 300. The prior months only spent on
    # day 1, so their cumulative curve is flat 300 from day 1 onward.
    assert out["points"][0]["baseline"] == 300.0
    assert out["baseline_to_date"] == 300.0
    assert out["baseline_full"] == 300.0

    # This month's day-1 cumulative = 100 (transfer + income excluded).
    assert out["points"][0]["mtd"] == 100.0
    assert out["mtd_total"] == 100.0

    # Under the usual pace by $200 (-66.7%), so not "ahead".
    assert out["delta"] == -200.0
    assert out["pct"] == -66.7
    assert out["ahead"] is False
    # Pace-projected month end = 100/300 * 300 = 100.
    assert out["projected_month_end"] == 100.0


def test_points_cover_month_and_mtd_stops_at_today(db, factory):
    today = _dt.date.today()
    cy, cm = today.year, today.month
    acct = factory.account()
    factory.commit()
    factory.transaction(account_id=acct.id, amount=50.0, date=_dt.date(cy, cm, 1), category="Shopping")
    factory.commit()

    out = spending_trend(months=4, db=db)

    assert len(out["points"]) == calendar.monthrange(cy, cm)[1]
    # The MTD series is present only through today; baseline spans every day.
    for p in out["points"]:
        assert ("mtd" in p) == (p["day"] <= today.day)
        assert "baseline" in p


def test_baseline_window_shrinks_when_history_is_thin(db, factory):
    """Requesting a 4-month baseline with only one prior month of data
    averages over the month that exists, not zeros — baseline_window reflects
    the actual count used."""
    today = _dt.date.today()
    cy, cm = today.year, today.month
    acct = factory.account()
    factory.commit()
    factory.transaction(account_id=acct.id, amount=100.0, date=_dt.date(cy, cm, 1), category="Shopping")
    y1, m1 = _months_back(cy, cm, 1)
    factory.transaction(account_id=acct.id, amount=600.0, date=_dt.date(y1, m1, 1), category="Shopping")
    factory.commit()

    out = spending_trend(months=4, db=db)

    assert out["baseline_window"] == 1
    assert out["baseline_months"] == [f"{y1}-{m1:02d}"]
    assert out["points"][0]["baseline"] == 600.0
