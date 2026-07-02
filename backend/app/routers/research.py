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


@router.get("/{domain}/synthesis")
def research_synthesis(domain: str, db: Session = Depends(get_db)):
    """Holistic local-AI synthesis across the WHOLE Research picture — held positions + flags, the
    scored universe, rotation temperature, public-money flow, SEC filings (dilution/insider),
    Finnhub earnings/revisions, the FRED commodity backdrop, valuation, catalysts, and alerts.
    Numbers computed in Python; the local LLM only narrates. Read-only; falls back to a computed
    template when the LLM is off/unreachable."""
    from app.services import research_synthesis as rsyn
    try:
        return rsyn.synthesize(db, domain)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.post("/{domain}/refresh-committees")
def refresh_committees(domain: str):
    """Rebuild the member→committee map (phase 2) from the public unitedstates/congress-legislators
    data — the backend httpx-fetches the full files. Global map (serves every industry); ``domain``
    is accepted for routing parity. Returns ``{ok, members, relevant_committees}``."""
    from app.services import congress_committees as cc
    try:
        return cc.refresh()
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{domain}/political-flow")
def research_political_flow(domain: str):
    """Universe-filtered congressional trades (buys AND sells, with the individual trades) plus
    EDGAR insider Form-4 activity. Read-only, cache-only."""
    try:
        return rj.get_political_flow(domain=domain)
    except Exception as exc:  # noqa: BLE001
        _handle(exc)


@router.get("/{domain}/market-extras")
def research_market_extras(domain: str):
    """Read-only display feed for the new external signals: per-ticker Finnhub earnings/revision
    (for the universe-table badges + drawer) and the domain's sector-tailwind theme incl. the
    FRED commodity blend. Cache-only — empty/None where a key/cache is cold. Demo-safe."""
    from datetime import date as _date

    from app.agent_trading.themes import load_theme
    from app.services import finnhub as _finnhub
    try:
        today = _date.today()
        cache = _finnhub.load_cache(domain) or {}
        finnhub_rows: dict[str, dict] = {}
        for tk, v in cache.items():
            if not isinstance(v, dict) or not v.get("available"):
                continue
            ne = v.get("next_earnings")
            days = None
            if ne:
                try:
                    days = (_date.fromisoformat(str(ne)[:10]) - today).days
                except ValueError:
                    days = None
            finnhub_rows[tk] = {"next_earnings": ne, "days_to_earnings": days,
                                "revision": v.get("revision")}
        theme = load_theme(domain) or {}
        return {"domain": domain, "finnhub": finnhub_rows, "theme": theme}
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
    """Real monthly close history + current price for one ticker (Stooq).

    On-demand: serves the cache if fresh (<12h), else fetches from Stooq and
    caches. Degrades gracefully — a timeout/unknown symbol returns
    ``{available: false}`` (or the last cached series, marked stale) rather
    than erroring, so the drawer always renders.
    """
    key = ticker.strip().upper()
    cache = store.load_prices(domain)
    entry = cache.get(key)
    # Don't make outbound calls from the locked public demo. This guard
    # MUST sit above the debug branch below: md.diagnose() hits Stooq, and
    # the public demo could otherwise fire outbound market-data calls via
    # ?debug=true, defeating the lock. Serve cache (marked stale) or a
    # disabled sentinel instead.
    if settings.DEMO_LOCKED:
        if entry and entry.get("history"):
            return {**entry, "ticker": key, "cached": True, "stale": True}
        return {"ticker": key, "available": False, "reason": "price fetch disabled on demo"}

    if debug:
        # Bypass cache; report exactly what the Stooq fetch did.
        return md.diagnose(ticker, months=months)

    fresh = bool(entry and entry.get("history") and (time.time() - entry.get("fetched_at", 0) < PRICE_TTL_SECONDS))
    if entry and fresh and not refresh:
        return {**entry, "ticker": key, "cached": True}

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
    # Stalest-first: a rate-limited provider (Twelve Data free ~8/min) can only refresh a handful
    # per run, so iterating in file order leaves later names PERMANENTLY stale. Sorting by cached
    # fetched_at (missing = oldest) rotates coverage so the most out-of-date names refresh first.
    _ents = sorted((e for e in data.get("entities", []) if e.get("ticker")),
                   key=lambda e: (cache.get((e.get("ticker") or "").strip().upper()) or {}).get("fetched_at", 0))
    for e in _ents:
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

    # Warm the agent-trading cycle's external-signal caches on the same daily pass: the
    # sector-tailwind theme (sector ETFs + any FRED commodity/macro series the domain declares)
    # and the Finnhub estimates/earnings cache. Both degrade to no-ops without keys/series and
    # must never fail the price refresh. (EDGAR's dilution cache is warmed by /edgar/refresh.)
    theme_warmed = finnhub_warmed = 0
    try:
        from app.agent_trading.themes import refresh_theme
        feat = refresh_theme(domain)
        theme_warmed = int(bool(feat))
    except Exception:  # noqa: BLE001
        pass
    try:
        if settings.FINNHUB_API_KEY:
            from app.services import finnhub as fh
            tickers = [e.get("ticker") for e in data.get("entities", []) if e.get("ticker")]
            finnhub_warmed = len(fh.refresh(domain, tickers, api_key=settings.FINNHUB_API_KEY))
    except Exception:  # noqa: BLE001
        pass
    try:   # self-heal the congress committee map on first run (it changes ~once per Congress)
        from app.services import congress_committees as cc
        if not (cc.load_map().get("members")):
            cc.refresh()
    except Exception:  # noqa: BLE001
        pass
    return {"domain": domain, "refreshed": refreshed, "failed": failed,
            "theme_warmed": theme_warmed, "finnhub_warmed": finnhub_warmed}


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
