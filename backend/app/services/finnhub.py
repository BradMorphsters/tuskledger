"""Finnhub — free-tier analyst estimates + earnings calendar for the agent.

Two cheap, high-signal additions the rotation engine was missing:

* **Earnings calendar** → the next report date per name, so the cycle can blackout NEW buys in
  the days before a print (event risk) — held names are never force-sold by it.
* **Recommendation/estimate revisions** → the month-over-month change in analyst net bullishness,
  a small tilt to the rotation score (rising estimates lift the rank, falling cut it).

Free tier (60 calls/min) covers both. Blank ``FINNHUB_API_KEY`` → every fetch returns "no data"
and the overlays are inert (no gate, no tilt). Pure parsers (``next_earnings_date``,
``recommendation_revision``) + thin fetchers with an injectable getter for tests; a per-domain
cache mirrors the EDGAR/theme caches so the per-cycle read stays fast.
"""
from __future__ import annotations

import datetime
import json
import re
import time
from typing import Any, Callable, Optional

import httpx

BASE = "https://finnhub.io/api/v1"
_TIMEOUT = 10.0

# (url) -> (json | None, error | None)
Getter = Callable[[str], "tuple[Optional[Any], Optional[str]]"]


def _http_get(url: str) -> "tuple[Optional[Any], Optional[str]]":
    try:
        r = httpx.get(url, timeout=_TIMEOUT)
        if r.status_code != 200:
            return None, f"HTTP {r.status_code}"
        return r.json(), None
    except Exception as e:  # noqa: BLE001 — degrade to "no data", never raise
        return None, str(e)


# --------------------------------------------------------------------------- pure parsers

def next_earnings_date(payload: dict, today: str) -> Optional[str]:
    """Earliest earnings date on/after ``today`` from a Finnhub ``calendar/earnings`` payload."""
    rows = (payload or {}).get("earningsCalendar") or []
    try:
        t = datetime.date.fromisoformat(today[:10])
    except (TypeError, ValueError):
        return None
    upcoming: list[str] = []
    for r in rows:
        d = r.get("date")
        try:
            if datetime.date.fromisoformat(str(d)[:10]) >= t:
                upcoming.append(str(d)[:10])
        except (TypeError, ValueError):
            continue
    return min(upcoming) if upcoming else None


def earnings_by_symbol(payload: dict, today: str) -> dict[str, str]:
    """Group a FULL (unfiltered) ``calendar/earnings`` payload into ``{SYMBOL: earliest upcoming
    date}``. The free tier serves the whole calendar but gates the per-``symbol`` filter, so we
    pull the window once and filter client-side."""
    rows = (payload or {}).get("earningsCalendar") or []
    try:
        t = datetime.date.fromisoformat(today[:10])
    except (TypeError, ValueError):
        return {}
    out: dict[str, str] = {}
    for r in rows:
        sym = str(r.get("symbol", "")).upper().strip()
        try:
            d = datetime.date.fromisoformat(str(r.get("date"))[:10])
        except (TypeError, ValueError):
            continue
        if not sym or d < t:
            continue
        iso = d.isoformat()
        if sym not in out or iso < out[sym]:
            out[sym] = iso
    return out


def _net_rating(row: dict) -> Optional[float]:
    """Net analyst bullishness for one period, in [-1, 1]: strong calls weighted double."""
    sb, b = float(row.get("strongBuy") or 0), float(row.get("buy") or 0)
    h = float(row.get("hold") or 0)
    s, ss = float(row.get("sell") or 0), float(row.get("strongSell") or 0)
    total = sb + b + h + s + ss
    if total <= 0:
        return None
    return (2 * sb + b - s - 2 * ss) / (2 * total)


def recommendation_revision(rows: list[dict]) -> Optional[float]:
    """Latest-vs-prior change in net analyst bullishness (rows are newest-first), in ~[-2, 2].
    Positive = estimates/ratings improving. ``None`` if there isn't a clean two-period read."""
    if not rows or len(rows) < 2:
        return None
    latest, prior = _net_rating(rows[0]), _net_rating(rows[1])
    if latest is None or prior is None:
        return None
    return round(latest - prior, 4)


# --------------------------------------------------------------------------- fetchers

def fetch_name(ticker: str, *, api_key: str, today: Optional[str] = None,
               get: Getter = _http_get) -> dict:
    """Earnings date + recommendation revision for one ticker. Always returns a dict with an
    ``available`` flag; never raises. No key → ``available=False``."""
    today = today or datetime.date.today().isoformat()
    if not api_key:
        return {"available": False, "reason": "no FINNHUB_API_KEY", "ticker": ticker}
    sym = (ticker or "").upper().strip()
    horizon = (datetime.date.fromisoformat(today[:10]) + datetime.timedelta(days=120)).isoformat()
    cal, _e1 = get(f"{BASE}/calendar/earnings?from={today}&to={horizon}&symbol={sym}&token={api_key}")
    rec, _e2 = get(f"{BASE}/stock/recommendation?symbol={sym}&token={api_key}")
    nxt = next_earnings_date(cal or {}, today) if isinstance(cal, dict) else None
    rev = recommendation_revision(rec) if isinstance(rec, list) else None
    return {"available": True, "ticker": sym, "next_earnings": nxt, "revision": rev,
            "source": "finnhub", "as_of": today}


# --------------------------------------------------------------------------- cache

def _cache_path(domain: str):
    from app.services import research_store as store  # lazy
    slug = re.sub(r"[^a-z0-9]+", "-", domain.lower()).strip("-")
    return store.research_dir() / f"{slug}.finnhub.json"


def load_cache(domain: Optional[str]) -> dict[str, dict]:
    if not domain:
        return {}
    try:
        p = _cache_path(domain)
        return json.loads(p.read_text()) if p.exists() else {}
    except Exception:
        return {}


def save_cache(domain: str, data: dict[str, dict]) -> None:
    """Write the per-domain Finnhub cache (used by ``refresh`` and by tests)."""
    p = _cache_path(domain)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2))


def refresh(domain: str, tickers: list[str], *, api_key: str, today: Optional[str] = None,
            get: Getter = _http_get, horizon_days: int = 90) -> dict[str, dict]:
    """Warm the per-domain Finnhub cache for ``tickers`` (daily job). No key → writes nothing.

    Earnings dates come from ONE unfiltered ``calendar/earnings`` pull (the free-tier path —
    the per-symbol filter is premium), mapped to our tickers client-side. Recommendation
    revisions are per-symbol and PREMIUM, so they stay ``None`` on a free key (the tilt then
    safely no-ops)."""
    if not api_key:
        return {}
    today = today or datetime.date.today().isoformat()
    horizon = (datetime.date.fromisoformat(today[:10]) + datetime.timedelta(days=horizon_days)).isoformat()
    prior = load_cache(domain)   # preserve good data across runs (free tier 60/min can 429 a few)
    cal, _e = get(f"{BASE}/calendar/earnings?from={today}&to={horizon}&token={api_key}")
    emap = earnings_by_symbol(cal, today) if isinstance(cal, dict) else {}
    out: dict[str, dict] = {}
    for raw in tickers:
        sym = (raw or "").upper().strip()
        if not sym:
            continue
        old = prior.get(sym) or {}
        rec, _r = get(f"{BASE}/stock/recommendation?symbol={sym}&token={api_key}")
        rev = recommendation_revision(rec) if isinstance(rec, list) else None
        # a None from a rate-limited pass shouldn't wipe a previously-good value
        nxt = emap.get(sym) if emap.get(sym) is not None else old.get("next_earnings")
        if rev is None:
            rev = old.get("revision")
        out[sym] = {"available": True, "ticker": sym, "next_earnings": nxt,
                    "revision": rev, "source": "finnhub", "as_of": today, "fetched_at": time.time()}
    try:
        p = _cache_path(domain)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(out, indent=2))
    except Exception:
        pass
    return out
