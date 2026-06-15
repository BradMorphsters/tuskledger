"""Order lifecycle — the realities between an approved order and a clean fill.

Four concerns, all pure and deterministic so they test without a broker:

* **Market-hours gate** — don't fire into a closed market (US equity regular hours, ET,
  weekends + NYSE holidays excluded).
* **Symbol validation** — reject a malformed or non-tradable ticker before the broker.
* **Idempotency** — a deterministic client order id + a duplicate finder, so a re-run of
  the same cycle never double-places.
* **Partial fills** — classify a fill as filled / partial / unfilled and report the
  remainder, so the loop knows what (if anything) is still outstanding.
"""
from __future__ import annotations

import datetime
import hashlib
import re
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

# NYSE full-day closures for 2026 (early-close half-days are not modeled).
NYSE_HOLIDAYS_2026 = {
    datetime.date(2026, 1, 1),    # New Year's Day
    datetime.date(2026, 1, 19),   # MLK Jr. Day
    datetime.date(2026, 2, 16),   # Washington's Birthday
    datetime.date(2026, 4, 3),    # Good Friday
    datetime.date(2026, 5, 25),   # Memorial Day
    datetime.date(2026, 6, 19),   # Juneteenth
    datetime.date(2026, 7, 3),    # Independence Day (observed)
    datetime.date(2026, 9, 7),    # Labor Day
    datetime.date(2026, 11, 26),  # Thanksgiving
    datetime.date(2026, 12, 25),  # Christmas
}


# --------------------------------------------------------------------------- market hours

def market_session(now: datetime.datetime | None = None) -> tuple[str, str]:
    """Return (session, reason). session ∈ {open, pre_market, closed}."""
    now = now or datetime.datetime.now(ET)
    now = now.replace(tzinfo=ET) if now.tzinfo is None else now.astimezone(ET)
    if now.weekday() >= 5:
        return ("closed", "weekend")
    if now.date() in NYSE_HOLIDAYS_2026:
        return ("closed", "exchange holiday")
    open_t = now.replace(hour=9, minute=30, second=0, microsecond=0)
    close_t = now.replace(hour=16, minute=0, second=0, microsecond=0)
    if now < open_t:
        return ("pre_market", "before the 9:30 ET open")
    if now >= close_t:
        return ("closed", "after the 16:00 ET close")
    return ("open", "regular trading hours")


def is_market_open(now: datetime.datetime | None = None) -> bool:
    return market_session(now)[0] == "open"


# --------------------------------------------------------------------------- symbol

_SYMBOL = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")  # AAPL, BRK.B, F …


def validate_symbol(symbol: str, *, tradable: bool | None = None) -> tuple[bool, str]:
    """Format check + optional tradability (from get_equity_tradability). ``tradable=None``
    means "not checked"; ``False`` is a hard reject."""
    s = (symbol or "").upper().strip()
    if not _SYMBOL.match(s):
        return (False, f"{symbol!r} is not a valid equity symbol")
    if tradable is False:
        return (False, f"{s} is not currently tradable")
    return (True, "")


# --------------------------------------------------------------------------- idempotency

def client_order_id(cycle_id: str, symbol: str, side: str, seq: int) -> str:
    """Deterministic idempotency key. The same (cycle, symbol, side, seq) always yields the
    same id, so replaying a cycle can be deduped against orders already placed."""
    raw = f"{cycle_id}:{symbol.upper().strip()}:{side.lower().strip()}:{seq}"
    return "tl-" + hashlib.sha1(raw.encode()).hexdigest()[:16]


_LIVE_STATES = {"new", "queued", "confirmed", "unconfirmed", "partially_filled", "filled"}


def find_duplicates(planned: list[dict], recent_orders: list[dict]) -> set[int]:
    """Indices of ``planned`` order-args that already have a live/filled order in
    ``recent_orders`` (same symbol + side). The guard against double-placing on a re-run."""
    dupes: set[int] = set()
    for i, o in enumerate(planned):
        sym = str(o.get("symbol", "")).upper()
        side = str(o.get("side", "")).lower()
        for r in recent_orders:
            if (str(r.get("symbol", "")).upper() == sym
                    and str(r.get("side", "")).lower() == side
                    and str(r.get("state", "")).lower() in _LIVE_STATES):
                dupes.add(i)
                break
    return dupes


# --------------------------------------------------------------------------- fills

def classify_fill(
    *,
    requested_qty: float | None = None,
    requested_notional: float | None = None,
    filled_qty: float = 0.0,
    filled_notional: float = 0.0,
    tol: float = 0.01,
) -> dict:
    """Classify a fill as filled / partial / unfilled and report the remainder.

    Compares in whichever unit the order was placed (shares for quantity orders, dollars for
    notional/amount orders). ``tol`` is the fractional slack treated as "fully filled".
    """
    if requested_qty:
        done = filled_qty >= requested_qty * (1 - tol)
        return {
            "status": "filled" if done else ("partial" if filled_qty > 0 else "unfilled"),
            "filled_qty": round(filled_qty, 6),
            "remaining_qty": round(max(0.0, requested_qty - filled_qty), 6),
        }
    req = requested_notional or 0.0
    done = filled_notional >= req * (1 - tol)
    return {
        "status": "filled" if done else ("partial" if filled_notional > 0 else "unfilled"),
        "filled_notional": round(filled_notional, 2),
        "remaining_notional": round(max(0.0, req - filled_notional), 2),
    }
