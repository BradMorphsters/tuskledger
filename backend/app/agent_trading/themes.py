"""Sector-tailwind signal — new external data: is the *commodity/theme* itself trending?

For a thematic universe (critical minerals, etc.) the underlying sector is the real driver:
rare-earth / lithium / uranium / copper prices moving together is a tailwind for the whole
basket. We read that via sector-proxy ETFs through the price feed you already have (no new
key, no paywall), aggregate their momentum, and stamp a ``theme_momentum`` / ``theme_trend_up``
onto every Candidate — a new input the Analyst can consider (and an optional "don't fight the
sector" regime filter).

Pure aggregation (:func:`theme_features`) + a thin live fetch/cache (:func:`refresh_theme`).
"""
from __future__ import annotations

import json
import re
import time
from typing import Optional

# Sector-proxy ETFs per research domain (commodity baskets that track the theme). This is just a
# curated default for the built-in domain; ANY other industry supplies its own proxies via
# ``meta.industry.sector_etfs`` in its research file (no code change needed to retarget).
THEME_PROXIES: dict[str, list[str]] = {
    "critical-minerals": ["URA", "REMX", "LIT", "COPX"],   # uranium, rare-earth, lithium, copper miners
}


def proxies_for(domain: Optional[str]) -> list[str]:
    """Sector-proxy ETFs for the domain. Built-in domains use the curated default above; a
    new industry falls back to whatever it declared in ``meta.industry.sector_etfs`` — so the
    sector-tailwind signal works for any industry configured on the Research page."""
    if not domain:
        return []
    hit = THEME_PROXIES.get(domain.strip().lower())
    if hit:
        return hit
    try:  # fall back to the per-domain industry config (meta.industry.sector_etfs)
        from app.services import research_store as store
        meta = ((store.load_domain(domain) or {}).get("meta", {}) or {}).get("industry", {}) or {}
        return [str(e).upper() for e in (meta.get("sector_etfs") or [])]
    except Exception:
        return []


def fred_series_for(domain: Optional[str]) -> list[str]:
    """FRED macro/commodity series IDs the domain declared in ``meta.industry.fred_series``
    (e.g. ["PCOPPUSDM"] for copper). Empty when none configured → theme stays ETF-only."""
    if not domain:
        return []
    try:
        from app.services import research_store as store
        meta = ((store.load_domain(domain) or {}).get("meta", {}) or {}).get("industry", {}) or {}
        return [str(s).strip() for s in (meta.get("fred_series") or []) if str(s).strip()]
    except Exception:
        return []


def blend_theme(etf_feat: dict, fred_feat: Optional[dict]) -> dict:
    """Combine the ETF-proxy tailwind with the FRED macro/commodity tailwind into one read.

    Keeps the ETF feat's shape; overrides ``momentum`` with the average of whichever components
    are present, and retains both component reads for transparency. ``trend_up`` requires the
    blended momentum to be non-negative AND at least one component trending up — so a commodity
    rolling over can flip the regime even while the miner ETF lags."""
    out = dict(etf_feat or {})
    if not fred_feat or fred_feat.get("n", 0) == 0:
        return out
    parts: list[float] = []
    if (etf_feat or {}).get("n", 0) > 0:
        parts.append(float(etf_feat.get("momentum") or 0.0))
    parts.append(float(fred_feat.get("momentum") or 0.0))
    mom = round(sum(parts) / len(parts), 4)
    out["etf_momentum"] = (etf_feat or {}).get("momentum")
    out["fred_momentum"] = fred_feat.get("momentum")
    out["fred"] = fred_feat
    out["momentum"] = mom
    out["trend_up"] = (mom >= 0.0) and bool((etf_feat or {}).get("trend_up") or fred_feat.get("trend_up"))
    return out


def theme_features(proxy_histories: dict[str, dict], market_data) -> dict:
    """Aggregate sector-proxy momentum into one tailwind read.

    ``proxy_histories`` = ``{etf: {history:[{close,...}], current}}``. Returns
    ``{momentum, trend_up, label, n}`` where momentum is the average 3-mo return (fraction)
    and trend_up means the average momentum score is in the upper half of the range."""
    rets, scores = [], []
    for etf, row in (proxy_histories or {}).items():
        hist, cur = (row or {}).get("history"), (row or {}).get("current")
        m = market_data.compute_momentum(hist, cur) if (hist and cur) else None
        if not m:
            continue
        if m.get("ret_3mo_pct") is not None:
            rets.append(m["ret_3mo_pct"])
        scores.append(m.get("score") or 0)
    if not scores:
        return {"momentum": 0.0, "trend_up": False, "label": "unknown", "n": 0}
    avg_ret = sum(rets) / len(rets) if rets else 0.0
    avg_score = sum(scores) / len(scores)
    trend_up = avg_score >= 50
    label = "uptrend" if avg_score >= 60 else "downtrend" if avg_score < 40 else "mixed"
    return {"momentum": round(avg_ret / 100.0, 4), "trend_up": trend_up, "label": label, "n": len(scores)}


# --------------------------------------------------------------------------- cache

def _theme_path(domain: str):
    from app.services import research_store as store  # lazy
    slug = re.sub(r"[^a-z0-9]+", "-", domain.lower()).strip("-")
    return store.research_dir() / f"{slug}.theme.json"


def load_theme(domain: Optional[str]) -> dict:
    if not domain:
        return {}
    try:
        p = _theme_path(domain)
        return json.loads(p.read_text()) if p.exists() else {}
    except Exception:
        return {}


def refresh_theme(domain: str, *, market_data=None, store=None, months: int = 14,
                  fred_fetch=None) -> dict:
    """Fetch the domain's sector-proxy ETFs, aggregate, blend in any configured FRED macro/
    commodity series, and cache the tailwind. (Daily job.) ``fred_fetch`` is injectable for tests."""
    if market_data is None:
        from app.services import market_data as market_data
    proxies = proxies_for(domain)
    histories: dict[str, dict] = {}
    for etf in proxies:
        try:
            fetched = market_data.fetch_prices(etf, months=months)
        except Exception:
            fetched = None
        if fetched:
            histories[etf] = fetched
    feat = theme_features(histories, market_data)
    feat["proxies"] = proxies

    # Blend the underlying commodity/macro trend (FRED) when the domain declares series. Keyless;
    # any fetch failure just leaves the ETF-only read intact.
    series = fred_series_for(domain)
    if series:
        from app.services import fred as fred_mod
        fetch = fred_fetch or fred_mod.fetch_series
        changes: dict[str, Optional[float]] = {}
        for sid in series:
            try:
                obs = fetch(sid)
            except Exception:
                obs = []
            changes[sid] = fred_mod.series_change(obs) if obs else None
        feat = blend_theme(feat, fred_mod.theme_from_series(changes))

    feat["fetched_at"] = time.time()
    try:
        p = _theme_path(domain)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(feat, indent=2))
    except Exception:
        pass
    return feat
