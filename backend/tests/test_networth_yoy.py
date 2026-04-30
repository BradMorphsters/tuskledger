"""Tests for /analytics/networth-yoy.

The bug that motivated these tests: clicking the YoY toggle on the
NetWorth chart silently did nothing when the user had no snapshots
from a year ago. The endpoint correctly returned an empty array, but
the frontend treated it as success and rendered no overlay. The fix
combined a backend behaviour test (returns empty when no priors) with
a frontend banner — these tests cover the backend half.
"""
import datetime
from sqlalchemy.orm import Session

from app.models import NetWorthSnapshot
from app.routers.analytics import networth_yoy


def _add_snapshot(db: Session, day: datetime.date, value: float) -> None:
    snap = NetWorthSnapshot(date=day, net_worth=value)
    db.add(snap)


def test_yoy_empty_with_no_snapshots(db: Session):
    """No data at all → both arrays empty, no error."""
    result = networth_yoy(db=db)
    assert result == {"current": [], "prior_year": []}


def test_yoy_recent_only_returns_current_no_priors(db: Session):
    """Recent snapshots but nothing from a year ago → current populated,
    prior_year empty. This is the case that previously surfaced as a
    silently-broken toggle."""
    today = datetime.date.today()
    for i in range(30):
        _add_snapshot(db, today - datetime.timedelta(days=29 - i), 100_000)
    db.commit()

    result = networth_yoy(db=db)
    assert len(result["current"]) == 30
    assert result["prior_year"] == []


def test_yoy_pairs_current_with_priors(db: Session):
    """When ≥1y of history exists, every current row gets a paired
    prior_year value drawn from the closest snapshot ≤365 days earlier."""
    today = datetime.date.today()
    # Build 400 days of monotonic snapshots so we have material on both
    # sides of the 365-day boundary.
    for i in range(400):
        _add_snapshot(db, today - datetime.timedelta(days=399 - i), 100_000 + i * 100)
    db.commit()

    result = networth_yoy(db=db)
    # current covers the last 365 days; prior_year is anchored to those
    # same dates with values from 365 days earlier.
    assert len(result["current"]) > 0
    assert len(result["prior_year"]) == len(result["current"])
    # Each prior_year value should be lower than the matching current
    # value because the underlying snapshots are monotonically growing.
    for current_row, prior_row in zip(result["current"], result["prior_year"]):
        assert current_row["date"] == prior_row["date"]
        assert current_row["value"] > prior_row["value"]


def test_yoy_falls_back_to_closest_prior_when_exact_date_missing(db: Session):
    """When the exact 365-days-prior snapshot is missing, fall back
    to the closest snapshot at-or-before that target date."""
    today = datetime.date.today()
    # Sparse snapshots — only the 1st of every month for 14 months.
    for months_back in range(14):
        d = today - datetime.timedelta(days=30 * months_back)
        d = d.replace(day=1)
        _add_snapshot(db, d, 50_000 + (14 - months_back) * 1_000)
    db.commit()

    result = networth_yoy(db=db)
    # Should have at least some pairings even though no snapshot exists
    # exactly 365 days before each current row.
    assert len(result["prior_year"]) > 0
