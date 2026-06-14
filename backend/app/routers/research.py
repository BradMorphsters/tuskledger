"""Long-term-hold research layer — read + validated-write API.

Additive, read-mostly, consistent with the existing data routers (spec §6.3).
The headline is ``GET /api/research/{domain}/positions`` — the user's held
securities joined onto their research overlay (the "long-term hold cockpit").

Writes (``POST``/``PATCH``) are schema-validated before they touch disk and are
blocked automatically on any read-only device or the public demo by the
``read_only_gate`` middleware in ``main.py`` (no extra guard needed here).
"""
from __future__ import annotations

import time
from datetime import date
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.services import market_data as md
from app.services import research_join as rj
from app.services import research_store as store

router = APIRouter(prefix="/api/research", tags=["research"])

# How long a cached price series stays fresh before an on-demand refetch.
PRICE_TTL_SECONDS = 12 * 3600


# ── Error translation ─────────────────────────────────────────────────────
def _handle(exc: Exception):
    if isinstance(exc, store.ResearchNotFound):
        raise HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, store.ResearchValidationError):
        raise HTTPException(
            status_code=422,
            detail={"message": str(exc), "errors": exc.errors},
        )
    if isinstance(exc, store.ResearchError):
        raise HTTPException(status_code=400, detail=str(exc))
    raise exc


# ── Discovery ─────────────────────────────────────────────────────────────
@router.get("/domains")
def list_research_domains():
    """Every research domain on disk with its meta header.

    The active industry (``ACTIVE_RESEARCH_DOMAIN``) is returned first so the UI
    defaults to it — the app focuses on one industry at a time even when several
    research files coexist.
    """
    active = store.get_active_domain()
    out = []
    for dom in store.list_domains():
        try:
            data = store.load_domain(dom)
        except store.ResearchError:
            continue
        meta = data.get("meta", {})
        out.append(
            {
                "domain": dom,
                "title": meta.get("title"),
                "description": meta.get("description"),
                "industry": (meta.get("industry") or {}).get("label"),
                "active": dom == active,
                "as_of": meta.get("as_of"),
                "last_updated": meta.get("last_updated"),
                "updated_by": meta.get("updated_by"),
                "schema_version": meta.get("schema_version"),
                "count": len(data.get("entities", [])),
            }
        )
    if active:
        out.sort(key=lambda d: d["domain"] != active)
    return out


@router.get("/active")
def get_active_industry():
    """The currently-focused industry (runtime-switchable)."""
    return {"domain": store.get_active_domain()}


class SetActiveIn(BaseModel):
    domain: str


@router.post("/active")
def set_active_industry(body: SetActiveIn):
    """Switch the focused industry at runtime (admin action; no restart). The
    read-only middleware blocks this on the demo + read-only devices."""
    try:
        dom = store.set_active_domain(body.domain.strip())
    except Exception as exc:  # noqa: BLE001
        _handle(exc)
    return {"domain": dom}


class CreateIndustryIn(BaseModel):
    domain: str
    title: Optional[str] = None
    label: Optional[str] = None
    benchmark: str = "SPY"
    sector_etfs: list[str] = []
    proxy_keywords: dict[str, str] = {}
    factors: Optional[list[dict]] = None
    tiers: Optional[list[dict]] = None
    activate: bool = True


@router.post("/industries")
def create_industry(body: CreateIndustryIn):
    """Scaffold a new validated research file for an industry (admin action).

    Creates the file structure + meta.industry config with an empty universe;
    populate it afterward via the add-entity API. Blocked on demo/read-only.
    """
    from datetime import datetime, timezone

    slug = store._slug(body.domain)
    if slug in {store._slug(d) for d in store.list_domains()}:
        raise HTTPException(status_code=409, detail=f"Industry {slug!r} already exists")
    factors = body.factors or [
        {"id": "moat", "label": "Competitive moat"},
        {"id": "growth", "label": "Growth runway"},
    ]
    tiers = body.tiers or [
        {"id": 1, "label": "Core"}, {"id": 2, "label": "Emerging"}, {"id": 3, "label": "Speculative"},
    ]
    doc = {
        "meta": {
            "schema_version": "1.0",
            "domain": slug,
            "title": body.title or f"{(body.label or slug).title()} — Long-Term Hold Research",
            "description": f"Research universe for {body.label or slug}.",
            "last_updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "updated_by": "industry-admin",
            "base_currency": "USD",
            "disclaimer": "Research/educational only; not investment advice.",
            "industry": {
                "label": body.label or slug,
                "benchmark": (body.benchmark or "SPY").upper(),
                "sector_etfs": [e.strip().upper() for e in body.sector_etfs if e.strip()],
                "proxy_keywords": {k.lower(): v.upper() for k, v in body.proxy_keywords.items()},
            },
        },
        "dimensions": {"factors": factors, "scale": {"min": 1, "max": 5},
                       "tiers": tiers, "composites": {"equity": {}, "fund": {}}},
        "entities": [],
    }
    try:
        store.save_domain(slug, doc, updated_by="industry-admin")
        if body.activate:
            store.set_active_domain(slug)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)
    return {"domain": slug, "active": body.activate}


@router.get("/ticker/{ticker}")
def research_for_ticker(ticker: str):
    """The single research entity matching a ticker (across all domains)."""
    norm = ticker.strip().upper()
    for dom in store.list_domains():
        for e in store.load_domain(dom).get("entities", []):
            tickers = {(e.get("ticker") or "").upper()} | {
                (a or "").upper() for a in (e.get("aliases") or [])
            }
            if norm in tickers:
                return e
    raise HTTPException(status_code=404, detail=f"No research entity for ticker {ticker!r}")


# ── Per-domain reads ──────────────────────────────────────────────────────
@router.get("/{domain}/meta")
def research_meta(domain: str):
    """``meta`` + ``dimensions`` (factor labels, scale, tiers, composite weights)
    so the viewer can render the scoring vocabulary self-describingly."""
    try:
        data = store.load_domain(domain)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)
    return {"meta": data.get("meta", {}), "dimensions": data.get("dimensions", {})}


@router.get("/{domain}/universe")
def research_universe(
    domain: str,
    db: Session = Depends(get_db),
    tier: Optional[int] = Query(None, ge=1, le=3),
    min_conviction: Optional[float] = Query(None, ge=0, le=100),
    held_only: bool = Query(False),
):
    """The scored universe, optionally filtered, each row marked ``held``."""
    try:
        return rj.get_universe(
            db, domain=domain, tier=tier,
            min_conviction=min_conviction, held_only=held_only,
        )
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{domain}/positions")
def position_research(domain: str, db: Session = Depends(get_db)):
    """Held securities × research overlay — the long-term-hold cockpit."""
    try:
        return rj.get_position_research(db, domain=domain)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{domain}/alerts")
def research_alerts(domain: str, db: Session = Depends(get_db)):
    """Derived flags: stale, overdue catalyst, invalidation watch,
    large below-cost positions, category concentration."""
    try:
        return rj.get_alerts(db, domain=domain)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{domain}/history")
def research_history(domain: str):
    """Append-only snapshot rows for trend / thesis-drift charts."""
    try:
        return store.read_history(domain)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{domain}/snapshot")
def record_research_snapshot(domain: str):
    """Append a current-state snapshot for every entity (the daily heartbeat
    that feeds the thesis-drift chart). Blocked on read-only/demo like other
    writes."""
    try:
        return {"domain": domain, "recorded": store.record_snapshots(domain)}
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{domain}/prices/{ticker}")
def research_prices(
    domain: str,
    ticker: str,
    months: int = Query(14, ge=2, le=60),
    refresh: bool = Query(False),
    debug: bool = Query(False),
):
    if debug:
        # Bypass cache; report exactly what the Stooq fetch did.
        return md.diagnose(ticker, months=months)
    """Real monthly close history + current price for one ticker (Stooq).

    On-demand: serves the cache if fresh (<12h), else fetches from Stooq and
    caches. Degrades gracefully — a timeout/unknown symbol returns
    ``{available: false}`` (or the last cached series, marked stale) rather
    than erroring, so the drawer always renders.
    """
    key = ticker.strip().upper()
    cache = store.load_prices(domain)
    entry = cache.get(key)
    fresh = bool(entry and entry.get("history") and (time.time() - entry.get("fetched_at", 0) < PRICE_TTL_SECONDS))
    if entry and fresh and not refresh:
        return {**entry, "ticker": key, "cached": True}
    # Don't make outbound calls from the locked public demo.
    if settings.DEMO_LOCKED:
        if entry and entry.get("history"):
            return {**entry, "ticker": key, "cached": True, "stale": True}
        return {"ticker": key, "available": False, "reason": "price fetch disabled on demo"}

    fetched = md.fetch_prices(ticker, months=months)
    if not fetched:
        if entry and entry.get("history"):
            return {**entry, "ticker": key, "cached": True, "stale": True}
        return {"ticker": key, "available": False, "reason": "no price data for this symbol"}
    entry = {**fetched, "fetched_at": time.time()}
    cache[key] = entry
    try:
        store.save_prices(domain, cache)
    except OSError:
        pass  # serving the data matters more than caching it
    return {**entry, "ticker": key, "cached": False}


@router.post("/{domain}/refresh-prices")
def refresh_research_prices(
    domain: str,
    months: int = Query(14, ge=2, le=60),
    update_fundamentals: bool = Query(True),
):
    """Bulk-warm the price cache for every ticker (the daily-job entry point).

    Optionally writes each entity's ``fundamentals.price`` to the latest close
    so the universe/cards converge on real prices. Blocked on read-only/demo
    by the middleware like other writes.
    """
    try:
        data = store.load_domain(domain)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)
    cache = store.load_prices(domain)
    refreshed = 0
    failed: list[str] = []
    ym = date.today().strftime("%Y-%m")
    changed_fundamentals = False
    for e in data.get("entities", []):
        tk = e.get("ticker")
        if not tk:
            continue
        fetched = md.fetch_prices(tk, months=months, exchange=e.get("exchange"))
        if not fetched:
            failed.append(tk)
            continue
        cache[tk.strip().upper()] = {**fetched, "fetched_at": time.time()}
        refreshed += 1
        if update_fundamentals and fetched.get("current") is not None:
            f = e.setdefault("fundamentals", {})
            f["price"] = f"${fetched['current']:.2f}"
            f["as_of"] = ym
            f["price_source"] = "stooq"
            changed_fundamentals = True
    # Also warm this domain's broad-market benchmark + sector-proxy ETFs (for
    # relative strength) even when they aren't entities in the universe. These
    # come from the domain's meta.industry config, so a different industry warms
    # its own benchmark/ETFs automatically.
    from app.services import rotation as rot
    cfg = rot.industry_config(domain, data)
    for tk in (cfg["benchmark"], *cfg["sector_etfs"]):
        key = (tk or "").strip().upper()
        if not key or cache.get(key, {}).get("history"):
            continue  # already warmed above (e.g. ETF is a universe entity)
        fetched = md.fetch_prices(tk, months=months)
        if fetched:
            cache[key] = {**fetched, "fetched_at": time.time()}
    try:
        store.save_prices(domain, cache)
    except OSError:
        pass
    if changed_fundamentals:
        try:
            store.save_domain(domain, data, updated_by="price-refresh")
        except store.ResearchError:
            pass  # never fail the whole refresh on a validation hiccup
    return {"domain": domain, "refreshed": refreshed, "failed": failed}


@router.get("/{domain}/entity/{entity_id}")
def research_entity(domain: str, entity_id: str):
    """One full entity (all fields) by its stable id."""
    try:
        return store.get_entity(domain, entity_id)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


# ── Validated writes ──────────────────────────────────────────────────────
class UpdateFieldIn(BaseModel):
    path: str
    value: Any
    updated_by: str = "manual"


@router.post("/{domain}/entity")
def upsert_entity(
    domain: str,
    entity: dict[str, Any] = Body(..., description="Full or partial entity; matched by id/ticker"),
    updated_by: str = Query("manual"),
):
    """Insert or merge an entity. The whole document is re-validated against
    ``research.schema.json`` before the atomic write; a bad payload 422s and
    leaves the file untouched."""
    try:
        return store.upsert_entity(domain, entity, updated_by=updated_by)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.patch("/{domain}/entity/{entity_id}")
def update_entity_field(domain: str, entity_id: str, body: UpdateFieldIn):
    """Set a single field (e.g. ``scores.conviction``) on one entity, validated."""
    try:
        return store.update_field(
            domain, entity_id, body.path, body.value, updated_by=body.updated_by
        )
    except Exception as exc:  # noqa: BLE001
        _handle(exc)
