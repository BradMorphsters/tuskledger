"""Sector "rotation watch" — is capital rotating INTO this universe yet?

Rolls every signal we already collect up to the *sector* level and into a
single 0-100 **rotation temperature** (Early → Stirring → Rotating → Hot), so
an early-stage thesis-holder can watch for the inflection instead of staring at
mostly-quiet per-name data. Four transparent components:

  • flow      — public-money arriving (lobbying / federal contracts /
                congressional & insider buying, from the Quiver signals cache)
  • rerating  — share of names that have climbed out of "oversold vs analyst
                low" toward / above their target band (from the research file)
  • momentum  — conviction/upside drift over time (from the snapshot history)
  • cadence   — density of near-term catalysts (next ~2 quarters)

Low temperature = early (the good place to be if you're early). The components
are computed here in Python; a local LLM (Ollama) only *narrates* them — it is
never given latitude to invent numbers (same guard rail as the Dashboard
narrative). Everything degrades gracefully: sparse caches → partial coverage,
no Ollama → a templated (non-AI) read.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from app.config import settings
from app.services import market_data as md
from app.services import research_join as rj
from app.services import research_store as store
from app.services.llm_ollama import LLMUnavailable, OllamaClient

WINDOW_180 = 180


def _temp_label(t: float) -> str:
    return "Hot" if t >= 75 else "Rotating" if t >= 50 else "Stirring" if t >= 25 else "Early"


def _momentum(hist: list[dict]) -> tuple[int, Optional[float], Optional[float]]:
    """Conviction+upside average drift across the universe, earliest→latest
    snapshot. Returns (0-100 score, latest_avg, first_avg). Neutral (50) when
    there's <2 dated snapshots."""
    by_asof: dict[str, list[float]] = {}
    for r in hist:
        c, u = r.get("conviction"), r.get("upside")
        if c is None and u is None:
            continue
        vals = [v for v in (c, u) if v is not None]
        by_asof.setdefault(r.get("as_of"), []).append(sum(vals) / len(vals))
    keys = sorted(k for k in by_asof if k)
    if len(keys) < 2:
        return 50, None, None
    first = sum(by_asof[keys[0]]) / len(by_asof[keys[0]])
    last = sum(by_asof[keys[-1]]) / len(by_asof[keys[-1]])
    return max(0, min(100, round(50 + (last - first) * 2))), round(last, 1), round(first, 1)


# Insider Form-4 filings in 90d at/above which a name counts as a "cluster".
EDGAR_INSIDER_CLUSTER = 8
# Universal default benchmark when a domain doesn't declare one.
DEFAULT_BENCHMARK = "SPY"
# Default rotation-temperature component weights (sum to 1.0).
DEFAULT_WEIGHTS = {"flow": 0.35, "rerating": 0.30, "momentum": 0.20, "cadence": 0.15}
# Flow sub-signals that can be toggled per industry. Defaults to all on, so
# critical minerals is unchanged; a retail universe (no federal contracts or
# lobbying) can switch the irrelevant ones off so they stop diluting the read.
ALL_FLOW_SIGNALS = ("gov_contracts", "congress", "lobbying", "edgar")


def _normalize_weights(raw: Optional[dict]) -> dict:
    w = {k: float((raw or {}).get(k, DEFAULT_WEIGHTS[k])) for k in DEFAULT_WEIGHTS}
    w = {k: max(0.0, v) for k, v in w.items()}
    total = sum(w.values())
    return {k: v / total for k, v in w.items()} if total > 0 else dict(DEFAULT_WEIGHTS)


def industry_config(domain: str, data: Optional[dict] = None) -> dict:
    """The per-domain industry knobs (from ``meta.industry`` in the research
    file) that retarget the engine to a different industry/theme:

      • ``label``         — human label for prompts/UI (falls back to title/domain)
      • ``benchmark``     — broad-market ticker for relative strength (default SPY)
      • ``sector_etfs``   — proxy ETFs measured vs the benchmark (default: none →
                            the sector relative-strength view simply doesn't compute)
      • ``proxy_keywords``— category-substring → proxy ETF map (per-name backdrop)

    Everything is optional, so a brand-new industry works with just a research
    file; the only thing it loses without ``sector_etfs`` is the sector RS read.
    """
    try:
        meta = ((data if data is not None else store.load_domain(domain)) or {}).get("meta", {})
    except Exception:  # noqa: BLE001 — config read must never break compute()
        meta = {}
    cfg = meta.get("industry") or {}
    raw_signals = cfg.get("flow_signals")
    flow_signals = ({str(s).lower() for s in raw_signals}
                    if raw_signals is not None else set(ALL_FLOW_SIGNALS))
    return {
        "label": cfg.get("label") or meta.get("title") or domain,
        "benchmark": (cfg.get("benchmark") or DEFAULT_BENCHMARK).upper(),
        "sector_etfs": [str(e).upper() for e in (cfg.get("sector_etfs") or [])],
        "proxy_keywords": {str(k).lower(): str(v).upper()
                           for k, v in (cfg.get("proxy_keywords") or {}).items()},
        "weights": _normalize_weights(cfg.get("rotation_weights")),
        "flow_signals": flow_signals,
    }


def proxy_etf_for(category: Optional[str], domain: Optional[str] = None,
                  keywords: Optional[dict] = None) -> Optional[str]:
    kw_map = keywords if keywords is not None else (
        industry_config(domain)["proxy_keywords"] if domain else {})
    cl = (category or "").lower()
    for kw, etf in kw_map.items():
        if kw in cl:
            return etf
    return None


def _price_momentum(domain: str, equities: list[dict],
                    sector_etfs: Optional[list] = None) -> tuple[Optional[int], Optional[int], int]:
    """(avg per-name price-momentum score, sector-backdrop score, n) from the
    price cache. Backdrop = avg momentum of the domain's sector-proxy ETFs."""
    etfs = sector_etfs if sector_etfs is not None else industry_config(domain)["sector_etfs"]
    prices = store.load_prices(domain)

    def mom(tk: Optional[str]) -> Optional[int]:
        p = prices.get((tk or "").upper())
        return ((p or {}).get("momentum") or {}).get("score")

    scores = [s for s in (mom(e.get("ticker")) for e in equities) if s is not None]
    backdrop = [s for s in (mom(etf) for etf in etfs) if s is not None]
    return (round(sum(scores) / len(scores)) if scores else None,
            round(sum(backdrop) / len(backdrop)) if backdrop else None,
            len(scores))


def _relative_strength(domain: str, benchmark: Optional[str] = None,
                       sector_etfs: Optional[list] = None) -> tuple[Optional[int], dict]:
    """Sector relative strength: the domain's proxy ETFs vs its broad-market
    benchmark, from the price cache. Returns (0-100 score or None, detail).
    >50 = the sector is outperforming the market (a rotation tell). Industries
    that don't declare ``sector_etfs`` simply report unavailable."""
    cfg = industry_config(domain)
    bench_tk = (benchmark or cfg["benchmark"]).upper()
    etfs = sector_etfs if sector_etfs is not None else cfg["sector_etfs"]
    if not etfs:
        return None, {"benchmark": bench_tk, "available": False, "reason": "no sector ETFs configured"}
    prices = store.load_prices(domain)
    bench = (prices.get(bench_tk) or {}).get("history")
    if not bench:
        return None, {"benchmark": bench_tk, "available": False, "reason": "no benchmark prices"}
    per: list[dict] = []
    for etf in etfs:
        hist = (prices.get(etf) or {}).get("history")
        if not hist:
            continue
        rs = md.relative_strength(hist, bench)
        if rs:
            per.append({"etf": etf, **rs})
    if not per:
        return None, {"benchmark": bench_tk, "available": False, "reason": "no sector ETF prices"}
    score = round(sum(p["score"] for p in per) / len(per))
    verdict = "outperforming" if score >= 60 else "lagging" if score <= 40 else "inline"
    return score, {"benchmark": bench_tk, "available": True, "score": score,
                   "verdict": verdict, "etfs": per}


def compute(domain: str, today: Optional[date] = None) -> dict:
    today = today or date.today()
    data = store.load_domain(domain)
    entities = data.get("entities", []) or []
    equities = [e for e in entities if e.get("security_type") == "equity"]
    signals = store.load_signals(domain)
    cfg = industry_config(domain, data)  # per-industry knobs (benchmark/ETFs/label)

    # ── 1. Valuation re-rating (research file: fundamentals.price vs targets) ──
    oversold = in_range = above = rated = 0
    upside_to_high: list[float] = []
    for e in equities:
        pt = e.get("price_targets") or {}
        cur = rj.parse_price((e.get("fundamentals") or {}).get("price"))
        if pt.get("low") is None or cur is None:
            continue
        rated += 1
        if cur < pt["low"]:
            oversold += 1
        elif pt.get("high") is not None and cur > pt["high"]:
            above += 1
        else:
            in_range += 1
        if pt.get("high"):
            upside_to_high.append((pt["high"] - cur) / cur * 100)
    rerating = round((in_range + above) / rated * 100) if rated else 0
    upside_to_high.sort()
    median_upside = round(upside_to_high[len(upside_to_high) // 2], 1) if upside_to_high else None

    # ── 2. Public-money flow (Quiver signals cache; sparse until warmed) ──
    sig = [signals.get((e.get("ticker") or "").upper()) for e in equities]
    sig = [s for s in sig if s and s.get("available")]
    checked = len(sig)
    lobby_recent = sum((s.get("lobbying") or {}).get("recent_usd", 0) or 0 for s in sig)
    lobby_prior = sum((s.get("lobbying") or {}).get("prior_usd", 0) or 0 for s in sig)
    gov_recent = sum((s.get("gov_contracts") or {}).get("recent_usd_90d", 0) or 0 for s in sig)
    congress_net = sum((s.get("congress") or {}).get("net_usd_90d", 0) or 0 for s in sig)
    active = sum(1 for s in sig if ((s.get("signal") or {}).get("score", 0) or 0) > 0
                 or ((s.get("lobbying") or {}).get("recent_usd", 0) or 0) > 0)
    fs = cfg["flow_signals"]  # which flow sub-signals count for this industry
    flow = 0
    if checked:
        flow = round(active / checked * 60)
        if "lobbying" in fs and lobby_recent > lobby_prior:
            flow += 20
        if "gov_contracts" in fs and gov_recent > 0:
            flow += 10
        if "congress" in fs and congress_net > 0:
            flow += 10

    # ── 2b. SEC EDGAR flow (independent of Quiver — works on its own) ──
    # Insider Form-4 clustering nudges flow up; capital raises (dilution) are
    # the opposite of capital rotating *in*, so they drag it down. Reads only
    # the edgar cache; contributes nothing when that cache is cold.
    edgar = store.load_edgar(domain)
    ed = [edgar.get((e.get("ticker") or "").upper()) for e in equities]
    ed = [x for x in ed if x and x.get("available")]
    edgar_checked = len(ed)
    insider_clusters = sum(1 for x in ed
                           if (x.get("insider_filings_90d") or 0) >= EDGAR_INSIDER_CLUSTER
                           and x.get("insider_trend") == "up")
    capital_raises = sum(1 for x in ed if (x.get("capital_raises_90d") or 0) > 0)
    if edgar_checked and "edgar" in fs:
        flow += min(10, insider_clusters * 3)
        flow -= min(10, capital_raises * 2)
    flow = max(0, min(flow, 100))

    # ── 3. Momentum (price momentum + sector relative strength + conviction drift) ──
    conv_mom, conv_last, conv_first = _momentum(store.read_history(domain))
    price_mom, commodity_backdrop, mom_n = _price_momentum(domain, equities, cfg["sector_etfs"])
    rs_score, rs_detail = _relative_strength(domain, cfg["benchmark"], cfg["sector_etfs"])
    _parts = [x for x in (price_mom, rs_score, (conv_mom if conv_last is not None else None))
              if x is not None]
    momentum = round(sum(_parts) / len(_parts)) if _parts else conv_mom

    # ── 4. Catalyst cadence (near-term catalysts) ──
    near = overdue = 0
    for e in equities:
        for c in e.get("catalysts") or []:
            status = (c.get("status") or "").lower()
            if status in ("hit", "missed"):
                continue
            d = rj.period_end(c.get("due"))
            if d and today <= d <= today + timedelta(days=WINDOW_180):
                near += 1
            if d and d < today and status in ("upcoming", "in_progress", "ongoing"):
                overdue += 1
    cadence = min(round((near / max(len(equities), 1)) * 200), 100)

    w = cfg["weights"]
    temperature = round(w["flow"] * flow + w["rerating"] * rerating
                        + w["momentum"] * momentum + w["cadence"] * cadence)

    return {
        "domain": domain,
        "industry": cfg["label"],
        "as_of": today.isoformat(),
        "temperature": temperature,
        "label": _temp_label(temperature),
        "components": {
            "flow": {"score": flow, "checked": checked, "active": active,
                     "lobbying_recent_usd": round(lobby_recent), "lobbying_prior_usd": round(lobby_prior),
                     "gov_recent_usd": round(gov_recent), "congress_net_usd": round(congress_net),
                     "edgar_checked": edgar_checked, "insider_clusters": insider_clusters,
                     "capital_raises": capital_raises},
            "rerating": {"score": rerating, "rated": rated, "oversold": oversold,
                         "in_range": in_range, "above": above, "median_upside_to_high_pct": median_upside},
            "momentum": {"score": momentum, "price_momentum": price_mom,
                         "commodity_backdrop": commodity_backdrop, "names_priced": mom_n,
                         "relative_strength": rs_detail,
                         "conviction_upside_now": conv_last, "then": conv_first},
            "cadence": {"score": cadence, "near_term_catalysts": near, "overdue_catalysts": overdue,
                        "equities": len(equities)},
        },
        "coverage": {"equities": len(equities), "signals_warmed": checked, "valuation_rated": rated},
    }


def _confluence(domain: str, data: dict, signals: dict, edgar: dict,
                today: date, limit: int = 4) -> list[dict]:
    """The decision-relevant standouts: names where the *thesis* and the live
    public-money / filing / valuation signals currently line up. Each name is
    scored by how many independent planes agree, with plain-English reasons plus
    the thesis + invalidation context so the LLM can reason about the idea, not
    just the aggregates. Cache-only; degrades to [] when nothing's warmed."""
    out: list[dict] = []
    for e in (data.get("entities") or []):
        if e.get("security_type") != "equity":
            continue
        tk = (e.get("ticker") or "").upper()
        if not tk:
            continue
        conv = (e.get("scores") or {}).get("conviction") or 0
        score = 0
        reasons: list[str] = []
        caveats: list[str] = []

        if conv >= 85:
            score += 2
            reasons.append(f"high conviction ({conv})")
        elif conv >= 75:
            score += 1

        pt = e.get("price_targets") or {}
        cur = rj.parse_price((e.get("fundamentals") or {}).get("price"))
        if pt.get("low") is not None and cur is not None and cur < pt["low"]:
            score += 2
            up = f", ~{round((pt['high'] - cur) / cur * 100)}% to high" if pt.get("high") else ""
            reasons.append(f"oversold vs analyst low{up}")

        sig = signals.get(tk)
        if sig and sig.get("available"):
            gov = sig.get("gov_contracts") or {}
            con = sig.get("congress") or {}
            lob = sig.get("lobbying") or {}
            oe = sig.get("offexchange") or {}
            if gov.get("recent_usd_90d") and gov.get("trend") == "up" and not (gov.get("latest") or {}).get("stale"):
                score += 1
                reasons.append("federal contracts accelerating")
            if (con.get("net_usd_90d") or 0) > 0:
                score += 1
                reasons.append("net congressional buying")
            if (lob.get("recent_usd") or 0) > 0 and lob.get("trend") == "up":
                score += 1
                reasons.append("lobbying rising")
            if oe.get("dpi_trend") == "up":
                score += 1
                reasons.append("dark-pool activity rising")

        ed = edgar.get(tk)
        if ed and ed.get("available"):
            if (ed.get("insider_filings_90d") or 0) >= EDGAR_INSIDER_CLUSTER and ed.get("insider_trend") == "up":
                score += 1
                reasons.append("insider Form-4 cluster")
            if (ed.get("capital_raises_90d") or 0) > 0:
                score -= 1
                caveats.append("recent capital-raise filing (dilution risk)")

        for c in e.get("catalysts") or []:
            st = (c.get("status") or "").lower()
            if st in ("hit", "missed"):
                continue
            d = rj.period_end(c.get("due"))
            if d and today <= d <= today + timedelta(days=WINDOW_180):
                score += 1
                reasons.append("near-term catalyst")
                break

        if score >= 3 and len(reasons) >= 2:
            out.append({
                "ticker": tk, "name": e.get("name"), "conviction": conv,
                "confluence_score": score, "reasons": reasons, "caveats": caveats,
                "thesis": (e.get("thesis") or {}).get("summary"),
                "invalidation_triggers": (e.get("invalidation_triggers") or [])[:2],
            })
    out.sort(key=lambda x: (-x["confluence_score"], -(x["conviction"] or 0)))
    return out[:limit]


def _record_daily(domain: str, agg: dict) -> bool:
    """Append one rotation history row per day (deduped on as_of) so the trend
    curve accrues. Returns True if a row was written."""
    hist = store.read_rotation(domain)
    if hist and hist[-1].get("as_of") == agg["as_of"]:
        return False
    store.append_rotation(domain, {
        "recorded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "as_of": agg["as_of"], "temperature": agg["temperature"], "label": agg["label"],
        "flow": agg["components"]["flow"]["score"], "rerating": agg["components"]["rerating"]["score"],
        "momentum": agg["components"]["momentum"]["score"], "cadence": agg["components"]["cadence"]["score"],
    })
    return True


def snapshot(domain: str) -> dict:
    """Compute + append a rotation history row (the daily heartbeat, deduped)."""
    agg = compute(domain)
    try:
        _record_daily(domain, agg)
    except OSError:
        pass
    return agg


# ── Local-AI synthesis ────────────────────────────────────────────────────
_SYSTEM = """You are a concise sector analyst helping a long-term holder decide
whether capital is beginning to ROTATE into a thematic equity universe they
already research. You are given a JSON object of PRE-COMPUTED metrics: a sector
rotation temperature with its components, a `trend` (what changed since the last
reading), and `names_to_watch` — specific tickers where this holder's own thesis
and the live public-money / filing / valuation signals currently line up, each
with the reasons, any caveats, and the thesis + invalidation notes.

Hard rules — not suggestions:
  - ONLY use numbers, tickers, and reasons that appear in the JSON. Never invent
    figures, prices, targets, or names that aren't present.
  - Do NOT give buy/sell directives or price predictions. You MAY name the
    tickers in names_to_watch and explain WHY their signals align (and flag any
    caveat, e.g. a dilution filing cutting against a named invalidation trigger)
    — that is surfacing what's true, not advice.
  - Lead with what's actionable for THIS holder. Three short paragraphs, plain
    English, no headers or bullet lists:
    (1) the stance in one line — EARLY / STIRRING / ROTATING / HOT — and what
        changed since the last read (use `trend`; if no prior snapshot, say so);
    (2) the 1–2 names that matter most right now and the specific confluence of
        signals behind each (cite their reasons; note any caveat against the
        name's invalidation trigger);
    (3) the single most important thing to watch next that would confirm the
        rotation is starting.
  - If names_to_watch is empty, say plainly that no single name shows strong
    signal confluence yet, and keep the read at the sector level.
  - End with: "Informational only, not investment advice."
"""


def _trend_note(domain: str, agg: dict) -> dict:
    """Recent temperature delta from the rotation history, for the prompt."""
    hist = store.read_rotation(domain)
    if len(hist) >= 2:
        return {"temperature_prev": hist[-2].get("temperature"),
                "temperature_change": agg["temperature"] - (hist[-2].get("temperature") or agg["temperature"]),
                "snapshots_recorded": len(hist)}
    return {"snapshots_recorded": len(hist)}


def build_bundle(domain: str, agg: Optional[dict] = None) -> dict:
    agg = agg or compute(domain)
    c = agg["components"]
    try:
        data = store.load_domain(domain)
    except Exception:  # noqa: BLE001
        data = {}
    try:
        today = date.fromisoformat(agg["as_of"])
    except (KeyError, ValueError):
        today = date.today()
    names = _confluence(domain, data, store.load_signals(domain), store.load_edgar(domain), today)
    return {
        "sector": agg.get("industry") or domain,
        "rotation_temperature_0_100": agg["temperature"],
        "stage": agg["label"],
        "public_money_flow": c["flow"],
        "valuation_rerating": c["rerating"],
        "score_momentum": c["momentum"],
        "catalyst_cadence": c["cadence"],
        "trend": _trend_note(domain, agg),
        "names_to_watch": names,
    }


def _template_narrative(agg: dict, names: Optional[list] = None) -> str:
    """Deterministic fallback when Ollama is off/unreachable."""
    c = agg["components"]
    rr, fl, mo = c["rerating"], c["flow"], c["momentum"]
    rs = (mo.get("relative_strength") or {})
    bits = [
        f"{agg['domain']} reads {agg['label']} (rotation temperature {agg['temperature']}/100).",
        (f"{rr['oversold']} of {rr['rated']} scored names still trade below their analyst low"
         + (f" (median ~{rr['median_upside_to_high_pct']:.0f}% to the high target)" if rr.get("median_upside_to_high_pct") is not None else "")
         + ".") if rr["rated"] else "Valuation coverage is still being built.",
        (f"Public-money flow is light so far: {fl['active']} of {fl['checked']} checked names show activity, "
         f"lobbying ${fl['lobbying_recent_usd']:,} (prior ${fl['lobbying_prior_usd']:,}).") if fl["checked"]
        else "Public-activity data isn't warmed yet.",
        (f"Versus the broad market, the sector ETFs are {rs['verdict']} (relative-strength {rs['score']}/100)."
         if rs.get("available") else "Sector relative strength isn't warmed yet."),
    ]
    if names:
        n0 = names[0]
        cav = f" (caveat: {n0['caveats'][0]})" if n0.get("caveats") else ""
        bits.append(f"Where the thesis and signals line up most: {n0['ticker']} — "
                    f"{', '.join(n0['reasons'][:3])}{cav}.")
    else:
        bits.append("No single name shows strong signal confluence yet.")
    bits += [
        f"{c['cadence']['near_term_catalysts']} catalysts are due in the next two quarters.",
        "Watch for lobbying/contracts rising, the oversold count shrinking, and the sector ETFs starting to "
        "outperform the market — the first signs the rotation is starting.",
        "Informational only, not investment advice.",
    ]
    return " ".join(bits)


def narrative(domain: str) -> dict:
    """Local-AI synthesis of the rotation picture (graceful fallback)."""
    agg = compute(domain)
    bundle = build_bundle(domain, agg)
    names = bundle.get("names_to_watch")
    # Keep the trend curve fresh (once per day), so "what changed" populates
    # even without the scheduled job. Never write on the locked public demo.
    if not settings.DEMO_LOCKED:
        try:
            _record_daily(domain, agg)
        except OSError:
            pass
    if not settings.LLM_ENABLED:
        return {"source": "template", "narrative": _template_narrative(agg, names), "bundle": bundle}
    client = OllamaClient(base_url=settings.LLM_URL, model=settings.LLM_MODEL)
    if not client.health():
        return {"source": "template", "narrative": _template_narrative(agg, names),
                "bundle": bundle, "note": "Ollama not reachable — showing a computed summary."}
    try:
        text = client.complete(_SYSTEM, json.dumps(bundle, indent=2))
    except LLMUnavailable:
        return {"source": "template", "narrative": _template_narrative(agg, names),
                "bundle": bundle, "note": "Ollama error — showing a computed summary."}
    return {"source": "ollama", "model": settings.LLM_MODEL, "narrative": text, "bundle": bundle}
