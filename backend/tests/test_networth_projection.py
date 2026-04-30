"""Tests for /analytics/networth-projection.

The bug that motivated these tests: the endpoint was silently returning
{historical: [], projected: []} when the snapshot history covered less
than 2 monthly buckets. The frontend toggle silently did nothing — no
indication to the user. Now the endpoint either projects (≥14 days) or
returns a structured `reason` string explaining why it can't.
"""
import datetime
from sqlalchemy.orm import Session

from app.models import NetWorthSnapshot
from app.routers.analytics import networth_projection


def _add_snapshot(db: Session, day: datetime.date, value: float) -> None:
    snap = NetWorthSnapshot(date=day, net_worth=value)
    db.add(snap)


def test_projection_empty_when_no_history(db: Session):
    """Zero snapshots → empty + low-confidence + actionable reason."""
    result = networth_projection(months=12, db=db)
    assert result["historical"] == []
    assert result["projected"] == []
    assert result["confidence"] == "low"
    assert result["monthly_pace"] is None


def test_projection_refuses_under_14_days(db: Session):
    """The bug case. Less than 14 days of history → return reason
    rather than extrapolate (account-onboarding skew would project
    millions per month from a few days of partial data)."""
    today = datetime.date.today()
    for i in range(4):
        _add_snapshot(db, today - datetime.timedelta(days=3 - i), 100_000 + i * 50_000)
    db.commit()

    result = networth_projection(months=12, db=db)
    assert result["projected"] == []
    assert result["confidence"] == "low"
    assert result["reason"] is not None
    assert "14 days" in result["reason"]


def test_projection_uses_daily_pace_fallback_at_14_days(db: Session):
    """Sub-monthly history with ≥14 days → daily-pace × 30 fallback,
    low confidence but real numbers. This is the path that would
    otherwise have returned empty (the original bug)."""
    today = datetime.date.today()
    # 20 daily snapshots, $1k/day growth → monthly pace ≈ $30k
    for i in range(20):
        _add_snapshot(
            db, today - datetime.timedelta(days=19 - i), 100_000 + i * 1_000
        )
    db.commit()

    result = networth_projection(months=6, db=db)
    assert len(result["projected"]) == 6
    # Monthly pace should be roughly daily pace × 30 ≈ $30k
    assert result["monthly_pace"] > 25_000
    assert result["monthly_pace"] < 35_000
    assert result["confidence"] == "low"


def test_projection_uses_monthly_buckets_when_available(db: Session):
    """≥2 monthly buckets → uses month-over-month deltas (the high-quality
    path). Confidence escalates with snapshot count."""
    today = datetime.date.today()
    # 60 daily snapshots spanning ~2 months, monotonic growth.
    for i in range(60):
        _add_snapshot(
            db, today - datetime.timedelta(days=59 - i), 500_000 + i * 200
        )
    db.commit()

    result = networth_projection(months=12, db=db)
    assert len(result["projected"]) == 12
    assert result["monthly_pace"] is not None
    # Confidence should be at least "medium" with 60 snapshots.
    assert result["confidence"] in ("medium", "high")
    # Each projection row carries the marker the frontend reads.
    assert all(row["is_projection"] for row in result["projected"])


def test_projection_horizon_is_user_controlled(db: Session):
    """`months` parameter controls how far forward the projection runs."""
    today = datetime.date.today()
    for i in range(60):
        _add_snapshot(db, today - datetime.timedelta(days=59 - i), 100_000)
    db.commit()

    short = networth_projection(months=3, db=db)
    long = networth_projection(months=24, db=db)
    assert len(short["projected"]) == 3
    assert len(long["projected"]) == 24
