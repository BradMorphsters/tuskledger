"""Quiver public-purchase signals — API for the Signals tab + Research overlay.

Read-mostly; writes only the local signals cache. Everything degrades to a
"connect Quiver" / "unavailable" shape when ``QUIVER_API_KEY`` is unset so the
rest of the app is unaffected.
"""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.services import quiver
from app.services import research_join as rj
from app.services import research_store as store

router = APIRouter(prefix="/api/signals", tags=["signals"])

SIGNALS_TTL_SECONDS = 24 * 3600  # gov/congress data updates daily


def _ts(entry: dict) -> float:
    return entry.get("_ts", 0) if isinstance(entry, dict) else 0


@router.get("/status")
def signals_status():
    """Quiver connection + which datasets the key unlocks (tier-aware)."""
    if settings.DEMO_LOCKED:
        return {"configured": quiver.has_key(), "demo": True, "datasets": {}, "accessible": [], "locked": []}
    return quiver.capabilities()


@router.get("/explore")
def signals_explore(ticker: str = "TSLA"):
    """Probe which broader Quiver datasets the current key unlocks (discovery)."""
    if not quiver.has_key():
        return {"configured": False}
    if settings.DEMO_LOCKED:
        return {"demo": True}
    return {"ticker": ticker.strip().upper(), "datasets": quiver.probe_access(ticker)}


@router.get("/{domain}/feed")
def signals_feed(domain: str, db: Session = Depends(get_db)):
    """Universe-wide public-activity momentum (from cache), joined to research.

    Sorted by the composite signal score so the names where federal /
    congressional / insider buying is *accelerating* float to the top.
    """
    if not quiver.has_key():
        return {"configured": False, "rows": []}
    cache = store.load_signals(domain)
    try:
        entities = store.load_domain(domain).get("entities", [])
    except store.ResearchError:
        entities = []
    held: set = set()
    try:
        held = {r["ticker"] for r in rj.get_universe(db, domain=domain, held_only=True)}
    except Exception:  # noqa: BLE001
        pass

    rows = []
    for e in entities:
        tk = (e.get("ticker") or "").upper()
        base = {"ticker": tk, "name": e.get("name"), "held": tk in held,
                "conviction": (e.get("scores") or {}).get("conviction")}
        sig = cache.get(tk)
        if not sig or not sig.get("available"):
            rows.append({**base, "available": False})
            continue
        gov = sig.get("gov_contracts") or {}
        con = sig.get("congress") or {}
        ins = sig.get("insider") or {}
        lob = sig.get("lobbying") or {}
        oe = sig.get("offexchange") or {}
        rows.append({
            **base, "available": True, "signal": sig.get("signal"),
            "gov_recent_usd_90d": gov.get("recent_usd_90d"), "gov_trend": gov.get("trend"),
            "congress_net_usd_90d": con.get("net_usd_90d"), "congress_buyers_90d": con.get("buyers_90d"),
            "insider_net_usd_90d": ins.get("net_usd_90d"),
            "lobbying_recent_usd": lob.get("recent_usd"), "lobbying_trend": lob.get("trend"),
            "dpi_recent": oe.get("dpi_recent"), "dpi_trend": oe.get("dpi_trend"), "short_pct": oe.get("short_pct"),
        })
    rows.sort(key=lambda r: (
        not r["available"],
        -((r.get("signal") or {}).get("score", 0) if r["available"] else 0),
        -(r.get("conviction") or 0),
    ))
    return {"configured": True, "rows": rows, "warmed": any(r["available"] for r in rows)}


@router.get("/{domain}/{ticker}")
def signals_ticker(domain: str, ticker: str, refresh: bool = Query(False), debug: bool = Query(False)):
    """Full public-activity bundle for one ticker (on-demand fetch + 24h cache)."""
    if debug:
        return quiver.diagnose(ticker)
    if not quiver.has_key():
        return {"ticker": ticker.strip().upper(), "available": False, "reason": "no_key"}
    key = ticker.strip().upper()
    cache = store.load_signals(domain)
    entry = cache.get(key)
    fresh = bool(entry and entry.get("available") and (time.time() - _ts(entry) < SIGNALS_TTL_SECONDS))
    if entry and fresh and not refresh:
        return {**entry, "cached": True}
    if settings.DEMO_LOCKED:
        return entry or {"ticker": key, "available": False, "reason": "disabled on demo"}
    bundle = quiver.signals_for(ticker)
    bundle["_ts"] = time.time()
    cache[key] = bundle
    try:
        store.save_signals(domain, cache)
    except OSError:
        pass
    return {**bundle, "cached": False}


# Spacing between names in the bulk warm. Each name fans out to up to 5 Quiver
# calls; pulling all ~60 names back-to-back trips the Hobbyist rate limit, which
# made successive runs churn a different subset. A small gap keeps it under.
SIGNALS_REFRESH_SLEEP = 0.6


@router.post("/{domain}/refresh")
def signals_refresh(domain: str):
    """Bulk-warm public-activity signals for every ticker (daily-job entry).

    Rate-limit resilient: a fetch that comes back unavailable (e.g. Quiver
    throttled this pass) does NOT overwrite a previously-good cached bundle —
    the prior data is kept and flagged ``stale`` instead. So repeated runs (and
    the nightly job) *accumulate* coverage rather than churning it.
    """
    if not quiver.has_key():
        raise HTTPException(status_code=400, detail="QUIVER_API_KEY not set")
    try:
        entities = store.load_domain(domain).get("entities", [])
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail=str(exc))
    cache = store.load_signals(domain)
    refreshed = 0
    failed: list[str] = []
    kept: list[str] = []
    tickers = [e.get("ticker") for e in entities if e.get("ticker")]
    for i, tk in enumerate(tickers):
        key = tk.strip().upper()
        bundle = quiver.signals_for(tk)
        if not bundle.get("available"):
            prev = cache.get(key)
            if prev and prev.get("available"):
                # Transient failure — preserve the good prior pull.
                cache[key] = {**prev, "stale": True}
                kept.append(tk)
            else:
                bundle["_ts"] = time.time()
                cache[key] = bundle
                failed.append(tk)
        else:
            bundle["_ts"] = time.time()
            cache[key] = bundle
            refreshed += 1
        if i < len(tickers) - 1:
            time.sleep(SIGNALS_REFRESH_SLEEP)
    try:
        store.save_signals(domain, cache)
    except OSError:
        pass
    return {"domain": domain, "refreshed": refreshed, "kept_stale": kept, "failed": failed}
