"""The candidate provider — the 'research desk' that feeds the Analyst.

It joins the cached layers Tusk Ledger already maintains into the :class:`Candidate`
feature rows the strategy engine reads:

* research universe → ``research_score``  (conviction, 0–100 → 0..1)
* Quiver signals cache → ``signal_score``  (composite public-buying score → 0..1)
* market-price cache → ``trend_up`` / ``momentum`` / ``pullback``  (via compute_momentum)
* current Agentic holdings → ``held_qty`` / ``avg_cost``  (so exits can fire)

No live API calls per cycle — it reads the same on-disk caches the daily jobs warm, so a
cycle is fast and key-independent. The assembly (:func:`build_candidates`) is pure and
testable; :func:`make_candidate_provider` is the thin live wiring.
"""
from __future__ import annotations

from typing import Optional, Sequence

from .strategy import Candidate, CandidateProvider


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _to_float(v) -> Optional[float]:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().lstrip("$").replace(",", "")
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _research_score(ent: dict) -> float:
    c = (ent.get("scores") or {}).get("conviction")
    return _clamp01(c / 100.0) if isinstance(c, (int, float)) else 0.0


def _signal_score(entry: dict) -> float:
    raw = ((entry or {}).get("signal") or {}).get("score")
    # composite score is a small int (~ -3..+5); ≈2 = "heating up". /3 puts "heating up"
    # just above the default 0.6 entry threshold. Negative → 0.
    return _clamp01((raw or 0) / 3.0) if isinstance(raw, (int, float)) else 0.0


def _price_features(price_entry: dict, market_data) -> tuple[Optional[float], bool, float, float]:
    """(current_price, trend_up, momentum_fraction, pullback_fraction) from the price cache."""
    if not price_entry:
        return (None, False, 0.0, 0.0)
    current = _to_float(price_entry.get("current"))
    history = price_entry.get("history") or []
    m = market_data.compute_momentum(history, current) if (history and current) else None
    if not m:
        return (current, False, 0.0, 0.0)
    momentum = (m.get("ret_3mo_pct") or 0.0) / 100.0
    trend_up = (m.get("score") or 0) >= 50           # upper half of the ~52w range
    off_high = m.get("pct_off_high") or 0.0          # negative when below the high
    pullback = max(0.0, -off_high) / 100.0
    return (current, trend_up, momentum, pullback)


def build_candidates(
    tickers: Sequence[str],
    entities_by_ticker: dict[str, dict],
    signals: dict[str, dict],
    prices: dict[str, dict],
    holdings: dict[str, dict],
    market_data,
) -> list[Candidate]:
    """Assemble Candidate rows. Pure: every input is plain data + an object exposing
    ``compute_momentum``. Names with no usable price are dropped (can't trade them)."""
    out: list[Candidate] = []
    seen: set[str] = set()
    for raw in tickers:
        t = (raw or "").upper().strip()
        if not t or t in seen:
            continue
        seen.add(t)
        ent = entities_by_ticker.get(t, {})
        price, trend_up, momentum, pullback = _price_features(prices.get(t), market_data)
        if price is None:  # fall back to the research snapshot's fundamentals price
            price = _to_float((ent.get("fundamentals") or {}).get("price"))
        if not price or price <= 0:
            continue
        hold = holdings.get(t, {})
        out.append(Candidate(
            ticker=t,
            price=float(price),
            research_score=_research_score(ent),
            signal_score=_signal_score(signals.get(t)),
            momentum=momentum,
            trend_up=trend_up,
            pullback=pullback,
            held_qty=_to_float(hold.get("qty")) or 0.0,
            avg_cost=_to_float(hold.get("avg_cost")) or 0.0,
        ))
    return out


def holdings_from_state(account_state) -> dict[str, dict]:
    """Adapt an AccountState (from the broker snapshot) to the holdings dict the provider
    overlays, so exits can value open positions."""
    return {
        t.upper(): {"qty": p.qty, "avg_cost": p.avg_price}
        for t, p in (account_state.positions or {}).items()
    }


def make_candidate_provider(
    domain: Optional[str],
    holdings: Optional[dict[str, dict]] = None,
    *,
    store=None,
    market_data=None,
) -> CandidateProvider:
    """Live provider over the cached research / signals / price stores for ``domain`` (the
    active research domain). ``holdings`` overlays current Agentic positions so the Analyst
    can exit. Stores/market_data are injectable for tests."""
    if store is None:
        from app.services import research_store as store  # lazy: avoid import at module load
    if market_data is None:
        from app.services import market_data as market_data
    holdings = {k.upper(): v for k, v in (holdings or {}).items()}

    entities = (store.load_domain(domain).get("entities") if domain else []) or []
    by_ticker = {(e.get("ticker") or "").upper(): e for e in entities if e.get("ticker")}
    signals = store.load_signals(domain) if domain else {}
    prices = store.load_prices(domain) if domain else {}

    def provider(watchlist: Sequence[str], as_of: str) -> list[Candidate]:
        universe = [w.upper() for w in (watchlist or list(by_ticker.keys()))]
        # always include held names so exits fire even if they fell off the watchlist
        tickers = list(dict.fromkeys(universe + list(holdings.keys())))
        return build_candidates(tickers, by_ticker, signals, prices, holdings, market_data)

    return provider
