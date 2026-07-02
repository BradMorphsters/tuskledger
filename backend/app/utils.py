"""Small shared utilities."""
from __future__ import annotations

import datetime as _datetime


def utcnow() -> _datetime.datetime:
    """Naive UTC now — drop-in replacement for the deprecated
    ``datetime.utcnow()`` (removal slated post-3.12).

    Deliberately returns a NAIVE datetime: every datetime stored in the DB
    is naive UTC, the mobile sync cursor compares against those stored
    values, and SQLite stores datetimes as strings — introducing
    timezone-aware values here would change the stored format
    ("...+00:00" suffix) and break cursor/string comparisons against
    existing rows. If the app ever migrates to aware datetimes, do it as
    a deliberate one-shot data migration, not by editing this function.
    """
    return _datetime.datetime.now(_datetime.timezone.utc).replace(tzinfo=None)


def shift_month(year: int, month: int, by: int) -> tuple[int, int]:
    """Return the (year, month) that is `by` months from (year, month).

    `by` may be negative (into the past) or positive (into the future).
    Canonical replacement for the several ad-hoc month-shift closures
    scattered through routers/analytics.py — those all reimplement this
    same modular arithmetic with slightly different loop styles.
    """
    idx = year * 12 + (month - 1) + by
    return idx // 12, (idx % 12) + 1


def month_start(year: int, month: int) -> _datetime.date:
    """First calendar day of (year, month)."""
    return _datetime.date(year, month, 1)


def month_end_exclusive(year: int, month: int) -> _datetime.date:
    """First day of the FOLLOWING month — the exclusive upper bound for a
    `date >= start, date < end` month-range query. Handles the December
    year rollover."""
    if month == 12:
        return _datetime.date(year + 1, 1, 1)
    return _datetime.date(year, month + 1, 1)
