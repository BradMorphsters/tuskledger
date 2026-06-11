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
