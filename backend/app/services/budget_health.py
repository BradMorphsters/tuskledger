"""Pace-aware budget adherence for the Financial Pulse tile.

The pulse's "budget adherence" component was a hardcoded 75 with a 15%
weight — a constant dressed up as a measurement, sitting inside the one
number the Dashboard asks the user to trust. This module replaces it
with something a person can argue with.

Definition
----------
For each budgeted category with a positive limit, compare month-to-date
spend against where the limit says you *should* be on this day of the
month:

    pace_limit = limit × elapsed_fraction
    ratio      = spent / pace_limit

A line scores 100 at or under pace and decays linearly to 0 at twice
pace (ratio 1.5 → 50). The component score is the limit-weighted mean
of line scores, so a $2,400 line matters more than a $50 one. The
reported `value` is the plain share of lines on pace (as a percent) —
the intuitive headline — while `score` carries the weighting.

Early-month guard: on the 1st, elapsed_fraction is 1/30 and a single
grocery run makes every line "over pace". The fraction is floored at one
week's worth of the month so the first few days are judged as if a week
had passed. Monarch does something similar by simply not judging the
first days; a floor keeps the number defined instead of blank.

What's excluded, and why:
  - the synthetic "Business" line (spending-summary handles business
    spend as its own rollup; mixing it here double-counts),
  - lines with a zero/negative limit (no target → nothing to adhere to),
  - transfers (never spend) and business-tagged transactions (not
    personal budget spend).

Returns None when the month has no budget at all — the caller drops the
component and re-weights the rest rather than inventing a number.
"""
from __future__ import annotations

import calendar
import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Budget, Transaction
from app.services.transaction_view import expand

BUSINESS_CATEGORY = "Business"
# Judge the first days of a month as if this many days had elapsed.
_MIN_ELAPSED_DAYS = 7


def line_score(spent: float, limit: float, elapsed_fraction: float) -> float:
    """Score one budget line 0–100 against its day-of-month pace."""
    if limit <= 0:
        return 100.0
    pace_limit = limit * max(elapsed_fraction, 1e-9)
    ratio = spent / pace_limit
    if ratio <= 1.0:
        return 100.0
    # Linear decay: ratio 1.0 → 100, 2.0 → 0.
    return max(0.0, 100.0 * (2.0 - ratio))


def elapsed_fraction_for(today: datetime.date) -> float:
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    effective_day = max(today.day, min(_MIN_ELAPSED_DAYS, days_in_month))
    return effective_day / days_in_month


def budget_adherence(db: Session, today: Optional[datetime.date] = None) -> Optional[dict]:
    """Compute the pulse's budget component for the current month.

    Returns None when no budget exists for the month.
    """
    today = today or datetime.date.today()
    budget = db.query(Budget).filter_by(month=today.month, year=today.year).first()
    if budget is None:
        return None

    lines = [
        (c.category, float(c.limit_amount))
        for c in budget.categories
        if c.category != BUSINESS_CATEGORY and (c.limit_amount or 0) > 0
    ]
    if not lines:
        return None

    month_start = today.replace(day=1)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= month_start,
            Transaction.date <= today,
            Transaction.is_transfer.is_(False),
        )
        .all()
    )
    spent_by_cat: dict[str, float] = {}
    for line in expand(txns):
        if line.amount <= 0 or line.business_id is not None:
            continue
        spent_by_cat[line.category] = spent_by_cat.get(line.category, 0.0) + line.amount

    elapsed = elapsed_fraction_for(today)
    total_limit = sum(limit for _, limit in lines)
    weighted = 0.0
    on_pace = 0
    detail = []
    for category, limit in lines:
        spent = spent_by_cat.get(category, 0.0)
        s = line_score(spent, limit, elapsed)
        weighted += s * (limit / total_limit)
        if s >= 100.0:
            on_pace += 1
        detail.append({
            "category": category,
            "limit": round(limit, 2),
            "spent": round(spent, 2),
            "pace_limit": round(limit * elapsed, 2),
            "score": round(s, 1),
        })

    return {
        "score": round(weighted, 1),
        "value": round(100.0 * on_pace / len(lines), 1),
        "lines": len(lines),
        "on_pace": on_pace,
        "elapsed_pct": round(elapsed * 100.0, 1),
        "month": today.month,
        "year": today.year,
        "detail": sorted(detail, key=lambda d: d["score"]),
    }
