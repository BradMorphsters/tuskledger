"""SEC EDGAR filing activity — free (no key) public-filing signals.

Powers the "SEC filings" block in the Research drawer and a column in the
Signals feed: insider Form-4 activity, 8-K material events, and capital-raise
(dilution) filings per name. Read-mostly; writes only the local EDGAR cache.
Outbound calls are skipped on the locked public demo.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Query

from app.config import settings
from app.services import research_store as store
from app.services import sec_edgar as edgar

router = APIRouter(prefix="/api/edgar", tags=["edgar"])

EDGAR_TTL_SECONDS = 12 * 3600  # filings post intraday; a twice-daily refresh is plenty


def _ts(entry: dict) -> float:
    return entry.get("_ts", 0) if isinstance(entry, dict) else 0


@router.get("/{domain}/feed")
def edgar_feed(domain: str):
    """Universe-wide SEC filing activity (from cache), sorted so the names with
    the most recent insider / event / capital-raise activity float to the top."""
    cache = store.load_edgar(domain)
    try:
        entities = store.load_domain(domain).get("entities", [])
    except store.ResearchError:
        entities = []
    rows = []
    for e in entities:
        if e.get("security_type") not in (None, "equity"):
            continue
        tk = (e.get("ticker") or "").upper()
        if not tk:
            continue
        base = {"ticker": tk, "name": e.get("name")}
        ent = cache.get(tk)
        if not ent or not ent.get("available"):
            rows.append({**base, "available": False})
            continue
        rows.append({
            **base, "available": True,
            "insider_filings_90d": ent.get("insider_filings_90d"),
            "insider_trend": ent.get("insider_trend"),
            "events_8k_90d": ent.get("events_8k_90d"),
            "capital_raises_90d": ent.get("capital_raises_90d"),
            "latest_filing": ent.get("latest_filing"),
        })
    rows.sort(key=lambda r: (
        not r["available"],
        -((r.get("insider_filings_90d") or 0) + (r.get("events_8k_90d") or 0)
          + 3 * (r.get("capital_raises_90d") or 0) if r["available"] else 0),
    ))
    return {"rows": rows, "warmed": any(r["available"] for r in rows)}


@router.get("/{domain}/{ticker}")
def edgar_ticker(domain: str, ticker: str, refresh: bool = Query(False), debug: bool = Query(False)):
    """Full SEC filing-activity bundle for one ticker (on-demand fetch + cache)."""
    if debug:
        return edgar.diagnose(ticker)
    key = ticker.strip().upper()
    cache = store.load_edgar(domain)
    entry = cache.get(key)
    fresh = bool(entry and entry.get("available") and (time.time() - _ts(entry) < EDGAR_TTL_SECONDS))
    if entry and fresh and not refresh:
        return {**entry, "cached": True}
    if settings.DEMO_LOCKED:
        return entry or {"ticker": key, "available": False, "reason": "disabled on demo"}
    bundle = edgar.fetch_activity(ticker)
    bundle["_ts"] = time.time()
    cache[key] = bundle
    try:
        store.save_edgar(domain, cache)
    except OSError:
        pass
    return {**bundle, "cached": False}


@router.post("/{domain}/refresh")
def edgar_refresh(domain: str):
    """Bulk-warm SEC filing activity for every equity (daily-job entry point).

    Throttled to stay under the SEC's ~10 req/s courtesy limit.
    """
    try:
        entities = store.load_domain(domain).get("entities", [])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail=str(exc))
    cache = store.load_edgar(domain)
    refreshed = 0
    failed: list[str] = []
    for e in entities:
        if e.get("security_type") not in (None, "equity"):
            continue
        tk = e.get("ticker")
        if not tk:
            continue
        key = tk.strip().upper()
        bundle = edgar.fetch_activity(tk)
        if not bundle.get("available"):
            prev = cache.get(key)
            if prev and prev.get("available"):
                cache[key] = {**prev, "stale": True}  # keep good data on a transient miss
            else:
                bundle["_ts"] = time.time()
                cache[key] = bundle
                failed.append(tk)
        else:
            bundle["_ts"] = time.time()
            cache[key] = bundle
            refreshed += 1
        time.sleep(0.15)  # ~7 req/s — under the SEC fair-access limit
    try:
        store.save_edgar(domain, cache)
    except OSError:
        pass
    return {"domain": domain, "refreshed": refreshed, "failed": failed}
