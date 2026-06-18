"""Research AI synthesis — one holistic local-AI read across EVERYTHING the Research layer knows.

Unlike the Rotation watch (which reads at the SECTOR level), this synthesizes for the holder's
own book: held positions + flags, the scored universe, the rotation temperature, public-money
flow (Quiver), SEC filings (EDGAR dilution / insider), Finnhub earnings dates + estimate
revisions, the FRED commodity backdrop, valuation-vs-targets, near-term catalysts, and the
derived alerts — joined into one bundle the local LLM narrates.

Same guard rail as the rotation / Dashboard narratives: every number is computed in Python; the
local LLM (Ollama) only narrates; no invented figures, no buy/sell directives, no price
forecasts. Degrades to a deterministic template when the LLM is off or unreachable. Read-only.
"""
from __future__ import annotations

import json
from datetime import date
from typing import Optional

from app.config import settings
from app.services import research_join as rj
from app.services import rotation as rot
from app.services.llm_ollama import LLMUnavailable, OllamaClient

_SYSTEM = """You are a portfolio analyst for a long-term, thesis-driven holder of a thematic
equity universe. You are handed ONE JSON of PRE-COMPUTED facts spanning their actual holdings
and the wider universe: position flags, the sector rotation temperature, public-money flow, SEC
filings (dilution / insider), analyst earnings dates + estimate revisions, the commodity
backdrop, valuation vs analyst targets, near-term catalysts, and derived alerts.

Hard rules — not suggestions:
  - ONLY use numbers, tickers, and reasons present in the JSON. Never invent figures, prices,
    targets, dates, or names.
  - No buy/sell directives and no price predictions. You MAY name tickers and explain why their
    signals align or conflict — that is surfacing what's true, not advice.
  - Synthesize ACROSS the planes for THIS holder. Four short paragraphs, plain English, no
    headers and no bullet lists:
    (1) Portfolio read in one line — is the thesis broadly intact, and what is the single biggest
        risk flag among the HOLDINGS right now (e.g. a dilution filing on a below-cost name, an
        earnings print within days, estimates turning down, single-theme concentration)?
    (2) The 1-2 HELD names that most need attention and exactly why (cite the specific flags /
        filings / revisions / catalysts behind each).
    (3) The 1-2 WATCH (non-held) names where the thesis + live signals line up best, with the
        confluence behind them and any caveat.
    (4) The sector backdrop in one line (rotation temperature + commodity context) and the single
        most important thing to watch next.
  - If a plane is empty or cold, say so briefly rather than guessing.
  - You are given `data_freshness` (cache ages in hours). If the price cache is stale (its
    `stalest_h` is well past `stale_threshold_h`, or `n_stale` > 0), add a short caveat that the
    price/valuation-based reads may be out of date — never present stale numbers as current.
  - End the prose with: "Informational only, not investment advice."
  - You are also given `available_spotlights`: ids of small PRE-COMPUTED visuals that can render
    beside this read. After the "Informational only..." line, output ONE final line exactly:
    `HIGHLIGHTS: <ids>` — a comma-separated subset of `available_spotlights`, ordered MOST relevant
    to THIS read first. Use only ids from that list, include only the ones that matter to what you
    wrote, and never invent an id.
"""


def _data_freshness(domain: str, stale_h: float = 48.0) -> dict:
    """Cache ages (hours) so the read can flag stale inputs — old data must never be presented as
    current. Keyed on each cache's ``fetched_at``. Prices are the acute risk (rate-limited feed)."""
    import time

    from app.services import research_store as store
    now = time.time()

    def summarize(d) -> Optional[dict]:
        ages = [(now - v["fetched_at"]) / 3600 for v in (d or {}).values()
                if isinstance(v, dict) and v.get("fetched_at")]
        if not ages:
            return None
        return {"stalest_h": round(max(ages), 1), "freshest_h": round(min(ages), 1),
                "n": len(ages), "n_stale": sum(1 for a in ages if a > stale_h)}

    out: dict = {"stale_threshold_h": stale_h}
    for name, loader in (("prices", store.load_prices), ("signals", store.load_signals),
                         ("edgar", store.load_edgar)):
        try:
            out[name] = summarize(loader(domain))
        except Exception:  # noqa: BLE001
            out[name] = None
    try:
        from app.services import finnhub as _fh
        out["finnhub"] = summarize(_fh.load_cache(domain))
    except Exception:  # noqa: BLE001
        out["finnhub"] = None
    return out


def build_synthesis_bundle(db, domain: str, today: Optional[date] = None) -> dict:
    """Assemble the holistic bundle. Cache/DB only; degrades gracefully on any cold plane."""
    today = today or date.today()
    # Sector + names_to_watch (reuses the rotation bundle, which already folds in Finnhub
    # earnings/revisions + the FRED commodity context).
    try:
        rbundle = rot.build_bundle(domain)
    except Exception:  # noqa: BLE001
        rbundle = {}

    try:
        pr = rj.get_position_research(db, domain=domain, today=today)
    except Exception:  # noqa: BLE001
        pr = {"positions": [], "matched_market_value": 0}
    try:
        from app.services import finnhub as _fh
        fh_cache = _fh.load_cache(domain) or {}
    except Exception:  # noqa: BLE001
        fh_cache = {}
    holdings = []
    for p in pr.get("positions", []):
        r = p.get("research") or {}
        tk = (p.get("ticker") or "").upper()
        fh = fh_cache.get(tk) or {}
        ne = fh.get("next_earnings")
        days = None
        if ne:
            try:
                days = (date.fromisoformat(str(ne)[:10]) - today).days
            except (TypeError, ValueError):
                days = None
        holdings.append({
            "ticker": p.get("ticker"),
            "market_value": (p.get("position") or {}).get("market_value"),
            "weight_pct": (p.get("position") or {}).get("weight_pct"),
            "conviction": r.get("conviction"),
            "flags": p.get("flags") or [],
            "thesis": r.get("thesis_summary") or (r.get("thesis") or {}).get("summary") if isinstance(r.get("thesis"), dict) else r.get("thesis"),
            "next_catalyst": r.get("next_catalyst"),
            "invalidation_triggers": (r.get("invalidation_triggers") or [])[:2],
            "next_earnings": ne,
            "days_to_earnings": days,
            "revision": fh.get("revision"),
        })

    try:
        alerts = rj.get_alerts(db, domain=domain, today=today)
    except Exception:  # noqa: BLE001
        alerts = []
    alert_rows = [{"severity": a.get("severity"), "type": a.get("type"), "scope": a.get("scope"),
                   "ticker": a.get("ticker"), "source": a.get("source"), "message": a.get("message")}
                  for a in (alerts or [])[:20]]

    try:
        pol = rj.get_political_flow(domain=domain, today=today, limit=5)
    except Exception:  # noqa: BLE001
        pol = {"rows": []}

    return {
        "domain": domain,
        "as_of": today.isoformat(),
        "portfolio": {
            "n_positions": len(holdings),
            "matched_market_value": pr.get("matched_market_value"),
            "holdings": holdings,
        },
        "alerts": alert_rows,
        "sector": {
            "rotation_temperature_0_100": rbundle.get("rotation_temperature_0_100"),
            "stage": rbundle.get("stage"),
            "commodity_context": rbundle.get("commodity_context"),
            "trend": rbundle.get("trend"),
        },
        "names_to_watch": rbundle.get("names_to_watch") or [],
        "political_flow": pol.get("rows") or [],
        "data_freshness": _data_freshness(domain),
    }


def _template(bundle: dict) -> str:
    """Deterministic, non-AI synthesis used when Ollama is off/unreachable."""
    p = bundle.get("portfolio") or {}
    al = bundle.get("alerts") or []
    s = bundle.get("sector") or {}
    names = bundle.get("names_to_watch") or []
    mv = p.get("matched_market_value") or 0
    bits = [f"You hold {p.get('n_positions', 0)} research-tracked name(s) (~${mv:,.0f} matched to the universe)."]

    highs = [a for a in al if a.get("severity") == "high"]
    if highs:
        bits.append(f"Top risk flag: {highs[0]['message']}")
    elif al:
        bits.append(f"Most notable flag: {al[0]['message']}")
    else:
        bits.append("No high-severity flags across your holdings right now.")

    if names:
        n0 = names[0]
        cav = f" (caveat: {n0['caveats'][0]})" if n0.get("caveats") else ""
        bits.append(f"Best signal confluence on the watch list: {n0['ticker']} — "
                    f"{', '.join((n0.get('reasons') or [])[:3])}{cav}.")
    else:
        bits.append("No non-held name shows strong signal confluence yet.")

    cc = s.get("commodity_context") or {}
    tail = (f"; commodity backdrop {cc['commodity_3mo_change']:+.1%} over 3mo"
            if cc.get("commodity_3mo_change") is not None else "")
    bits.append(f"Sector reads {s.get('stage') or 'unknown'} "
                f"(rotation temperature {s.get('rotation_temperature_0_100')}/100){tail}.")
    fr = (bundle.get("data_freshness") or {}).get("prices") or {}
    if fr.get("n_stale"):
        bits.append(f"Note: {fr['n_stale']} of {fr['n']} prices are >48h old "
                    f"(stalest {fr['stalest_h']:.0f}h) — price/valuation reads may lag.")
    bits.append("Informational only, not investment advice.")
    return " ".join(str(b) for b in bits)


_FLAG_LABEL = {
    "below_cost": ("below cost", "warning"), "large_position": ("large position", "warning"),
    "invalidation_watch": ("invalidation watch", "danger"), "overdue_catalyst": ("catalyst overdue", "warning"),
    "stale_research": ("research stale", "neutral"), "large_below_cost": ("large + below cost", "danger"),
}
_ALERT_LABEL = {
    "dilution_watch": ("dilution", "danger"), "earnings_soon": ("earnings soon", "warning"),
    "revision_down": ("estimates falling", "warning"), "revision_up": ("estimates rising", "success"),
    "insider_cluster": ("insider cluster", "info"), "flow_contract": ("federal contracts", "info"),
}


def build_spotlights(bundle: dict) -> list[dict]:
    """Deterministic, chart-ready visuals computed from the bundle (numbers only — never the LLM).
    Each has a stable ``id`` the AI may reference to curate/order which appear. Pure."""
    out: list[dict] = []
    p = bundle.get("portfolio") or {}
    holdings = p.get("holdings") or []
    alerts = bundle.get("alerts") or []
    sector = bundle.get("sector") or {}
    watch = bundle.get("names_to_watch") or []

    weighted = [(h.get("ticker"), h.get("weight_pct")) for h in holdings
                if isinstance(h.get("weight_pct"), (int, float))]
    if weighted:
        weighted.sort(key=lambda x: -(x[1] or 0))
        out.append({"id": "concentration", "type": "concentration", "title": "Single-name concentration",
                    "guide_pct": 10.0,
                    "items": [{"ticker": t, "weight_pct": round(w, 1)} for t, w in weighted[:5]]})

    alerts_by_tk: dict[str, list] = {}
    for a in alerts:
        tk = (a.get("ticker") or "").upper()
        if tk:
            alerts_by_tk.setdefault(tk, []).append(a)

    def _risk_score(h) -> int:
        tk = (h.get("ticker") or "").upper()
        s = len(h.get("flags") or [])
        for a in alerts_by_tk.get(tk, []):
            s += {"high": 3, "med": 2, "low": 1}.get(a.get("severity"), 1)
        return s

    if holdings:
        worst = max(holdings, key=_risk_score)
        if _risk_score(worst) > 0:
            tk = (worst.get("ticker") or "").upper()
            chips: list[dict] = []
            for f in (worst.get("flags") or []):
                lbl = _FLAG_LABEL.get(f)
                if lbl and not any(c["label"] == lbl[0] for c in chips):
                    chips.append({"label": lbl[0], "severity": lbl[1]})
            for a in alerts_by_tk.get(tk, []):
                lbl = _ALERT_LABEL.get(a.get("type"))
                if lbl and not any(c["label"] == lbl[0] for c in chips):
                    chips.append({"label": lbl[0], "severity": lbl[1]})
            if chips:
                out.append({"id": "risk_flags", "type": "risk_flags", "title": f"{tk} risk flags",
                            "ticker": tk, "weight_pct": worst.get("weight_pct"), "flags": chips})

    if sector.get("rotation_temperature_0_100") is not None:
        cc = sector.get("commodity_context") or {}
        out.append({"id": "sector_gauge", "type": "sector_gauge", "title": "Sector backdrop",
                    "temperature": sector.get("rotation_temperature_0_100"), "stage": sector.get("stage"),
                    "commodity_3mo_change": cc.get("commodity_3mo_change")})

    events: list[dict] = []
    seen: set[str] = set()
    for src in (holdings, watch):
        for n in src:
            tk = (n.get("ticker") or "").upper()
            ne, dd = n.get("next_earnings"), n.get("days_to_earnings")
            if tk and ne and isinstance(dd, (int, float)) and 0 <= dd <= 90 and tk not in seen:
                seen.add(tk)
                events.append({"ticker": tk, "date": ne, "days": int(dd)})
    if events:
        events.sort(key=lambda e: e["days"])
        out.append({"id": "earnings_runway", "type": "earnings_runway", "title": "Earnings runway (90d)",
                    "horizon_days": 90, "blackout_days": 5, "events": events[:6]})

    pol = [r for r in (bundle.get("political_flow") or [])
           if (r.get("buys_usd_90d") or r.get("sells_usd_90d") or r.get("trades"))]
    if pol:
        out.append({"id": "political_flow", "type": "political_flow", "title": "Congressional flow",
                    "items": [{"ticker": r["ticker"], "direction": r.get("direction"),
                               "buys_usd_90d": r.get("buys_usd_90d"), "sells_usd_90d": r.get("sells_usd_90d"),
                               "buyers_90d": r.get("buyers_90d")} for r in pol[:4]]})
    return out


def _parse_highlights(text: str, valid_ids: list[str]) -> tuple[str, Optional[list[str]]]:
    """Pull a trailing ``HIGHLIGHTS: a, b, c`` line the model emits, strip it from the narrative,
    and return the ordered subset that intersects the real spotlight ids (model order preserved).
    Returns ``(clean_text, None)`` when no valid line is present."""
    valid = set(valid_ids)
    keep_lines, picks = [], None
    for line in (text or "").splitlines():
        m = line.strip()
        if m.upper().startswith("HIGHLIGHTS:"):
            raw = m.split(":", 1)[1]
            seen: list[str] = []
            for tok in raw.replace(";", ",").split(","):
                tid = tok.strip().lower()
                if tid in valid and tid not in seen:
                    seen.append(tid)
            picks = seen or None
            continue
        keep_lines.append(line)
    return "\n".join(keep_lines).strip(), picks


_SPOT_KEYWORDS = {
    "concentration": ["concentrat", "single-name", "single name", "overweight", "% of the book", "weight"],
    "risk_flags": ["dilution", "insider", "below cost", "below-cost", "risk flag", "invalidation"],
    "sector_gauge": ["sector", "rotation", "commodity", "copper", "backdrop", "stirring", "rotating", "early-stage"],
    "earnings_runway": ["earnings", "reports", "the print", "blackout"],
    "political_flow": ["congress", "congressional", "representative", "senator", "lawmaker", "capitol", "political"],
}


def _infer_highlights(narrative: str, spotlights: list[dict]) -> Optional[list[str]]:
    """Fallback curation when the model doesn't emit a HIGHLIGHTS line: order the spotlights by
    where each first appears in the prose (earlier emphasis = higher priority). The model's own
    written focus drives the order — still AI-driven, just inferred. None if nothing matches."""
    text = (narrative or "").lower()
    hits: list[tuple[int, str]] = []
    for s in spotlights:
        words = list(_SPOT_KEYWORDS.get(s.get("type"), []))
        if s.get("ticker"):
            words.append(str(s["ticker"]).lower())
        if s.get("type") == "concentration":
            words += [str(i.get("ticker", "")).lower() for i in (s.get("items") or [])[:1] if i.get("ticker")]
        positions = [text.find(w) for w in words if w and text.find(w) >= 0]
        if positions:
            hits.append((min(positions), s["id"]))
    hits.sort()
    return [hid for _, hid in hits] or None


def synthesize(db, domain: str) -> dict:
    """The holistic Research AI read. Returns ``{source, narrative, bundle, note?}``."""
    bundle = build_synthesis_bundle(db, domain)
    spotlights = build_spotlights(bundle)        # slice 1: deterministic, chart-ready
    spot_ids = [s["id"] for s in spotlights]
    base = {"bundle": bundle, "spotlights": spotlights}
    if not settings.LLM_ENABLED:
        return {"source": "template", "narrative": _template(bundle), "highlights": None, **base}
    # Any LLM-infra failure (unreachable, proxy/env error, model error) degrades to the computed
    # template — the synthesis must never 500 on the optional local model.
    try:
        client = OllamaClient(base_url=settings.LLM_URL, model=settings.LLM_MODEL)
        if not client.health():
            return {"source": "template", "narrative": _template(bundle), "highlights": None,
                    "note": "Ollama not reachable — showing a computed summary.", **base}
        user = json.dumps({**bundle, "available_spotlights": spot_ids}, indent=2, default=str)
        raw = client.complete(_SYSTEM, user)
    except (LLMUnavailable, Exception):  # noqa: BLE001
        return {"source": "template", "narrative": _template(bundle), "highlights": None,
                "note": "Local model unavailable — showing a computed summary.", **base}
    # slice 2: the model curates which spotlights matter — explicitly via a trailing HIGHLIGHTS
    # line, or (fallback) inferred from where it emphasises each topic in the prose.
    narrative, highlights = _parse_highlights(raw, spot_ids)
    if highlights is None:
        highlights = _infer_highlights(narrative, spotlights)
    return {"source": "ollama", "narrative": narrative, "highlights": highlights, **base}
