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

import datetime
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


def _is_stale(ent: dict, today: Optional[str] = None) -> bool:
    """A research entity is stale once it's past its review ``next_due`` date."""
    nd = (ent.get("review") or {}).get("next_due")
    if not nd:
        return False
    today = today or datetime.date.today().isoformat()
    try:
        return str(nd) < str(today)
    except Exception:
        return False


def blend_research(conviction, upside, conv_momentum: float, stale: bool,
                   *, stale_factor: float = 0.7) -> tuple[float, float]:
    """Turn the research signals into (research_score, rotation_score).

    * ``research_score`` (the quality gate, all profiles) = conviction, **decayed if stale**.
    * ``rotation_score`` (the rotation ranking) blends three things you already store:
        - **expected value**: conviction tilted by upside  →  conv·(0.5 + 0.5·upside)
        - **conviction-momentum**: a rising thesis lifts the rank, a falling one cuts it
        - **staleness**: an out-of-review name is pushed down

    All inputs are 0–100 (conviction/upside) except ``conv_momentum`` which is a fraction
    (e.g. +0.12 = conviction up 12 points since tracking began)."""
    conv = _clamp01((conviction or 0) / 100.0)
    ups = _clamp01((upside or 0) / 100.0)
    sf = stale_factor if stale else 1.0
    research_score = round(_clamp01(conv * sf), 4)
    ev = conv * (0.5 + 0.5 * ups)
    mom_adj = 1.0 + max(-0.5, min(0.5, conv_momentum or 0.0))
    rotation_score = round(_clamp01(ev * mom_adj * sf), 4)
    return research_score, rotation_score


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
    *,
    momentum_by_ticker: Optional[dict[str, float]] = None,
    today: Optional[str] = None,
    theme: Optional[dict] = None,
) -> list[Candidate]:
    """Assemble Candidate rows. Pure: every input is plain data + an object exposing
    ``compute_momentum``. Names with no usable price are dropped (can't trade them).

    ``momentum_by_ticker`` carries conviction-momentum (the change in conviction since
    tracking began); ``today`` is used for staleness. Both feed ``blend_research``."""
    mbt = momentum_by_ticker or {}
    theme = theme or {}
    theme_mom = float(theme.get("momentum") or 0.0)
    theme_up = bool(theme.get("trend_up"))
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
        scores = ent.get("scores") or {}
        research_score, rotation_score = blend_research(
            scores.get("conviction"), scores.get("upside"),
            mbt.get(t, 0.0), _is_stale(ent, today),
        )
        hold = holdings.get(t, {})
        out.append(Candidate(
            ticker=t,
            price=float(price),
            research_score=research_score,
            rotation_score=rotation_score,
            signal_score=_signal_score(signals.get(t)),
            momentum=momentum,
            trend_up=trend_up,
            pullback=pullback,
            theme_momentum=theme_mom,
            theme_trend_up=theme_up,
            held_qty=_to_float(hold.get("qty")) or 0.0,
            avg_cost=_to_float(hold.get("avg_cost")) or 0.0,
        ))

    # Orphaned holdings: a held name that ISN'T in the active universe (e.g. left over after
    # switching industries) gets no candidate above, so it could never be exited. Surface each as
    # an exit-only candidate — research_score 0 (below any floor) so the strategy rotates it out
    # instead of stranding it. Priced from the live position; avg cost as a last resort.
    for raw, hold in (holdings or {}).items():
        t = (raw or "").upper().strip()
        if not t or t in seen:
            continue
        qty = _to_float(hold.get("qty")) or 0.0
        if qty <= 0:
            continue
        px = (_to_float(hold.get("price")) or _to_float((prices.get(t) or {}).get("current"))
              or _to_float(hold.get("avg_cost")))
        if not px or px <= 0:
            continue
        seen.add(t)
        out.append(Candidate(
            ticker=t, price=float(px),
            research_score=0.0, rotation_score=0.0, signal_score=0.0,
            momentum=0.0, trend_up=False, pullback=0.0,
            theme_momentum=theme_mom, theme_trend_up=theme_up,
            held_qty=qty, avg_cost=_to_float(hold.get("avg_cost")) or 0.0,
        ))
    return out


def freshness_skips(
    candidates: Sequence[Candidate],
    prices: dict[str, dict],
    entities_by_ticker: dict[str, dict],
    *,
    now_epoch: float,
    today: Optional[str] = None,
    max_price_age_hours: float = 48.0,
    require_fresh_research: bool = True,
) -> dict[str, str]:
    """Stale-data gate: which NON-held candidates shouldn't be *bought* because the method's
    inputs are stale. Bars are monthly, so price freshness keys off the cache's ``fetched_at``
    (when we last pulled a live price), not bar age. Held names are exempt — exits must still
    fire on a stale name (a stop-loss shouldn't be muted by a stale feed).

    Returns ``{ticker: reason}`` for names to skip. Pure: ``now_epoch`` is injected."""
    max_age = max_price_age_hours * 3600.0
    out: dict[str, str] = {}
    for c in candidates:
        if c.held:
            continue  # exits aren't gated on freshness
        t = (c.ticker or "").upper()
        pe = prices.get(t) or {}
        fa = pe.get("fetched_at")
        if fa is None:
            out[t] = "no live price (using a snapshot fallback)"
            continue
        age_h = (now_epoch - float(fa)) / 3600.0
        if age_h > max_price_age_hours:
            out[t] = f"price {age_h:.0f}h stale (> {max_price_age_hours:.0f}h)"
            continue
        if require_fresh_research and _is_stale(entities_by_ticker.get(t, {}), today):
            out[t] = "research past its review date"
    return out


def chase_skips(
    candidates: Sequence[Candidate],
    *,
    max_chase_momentum: float,
    profile: str = "momentum",
    apply_profiles: Sequence[str] = ("momentum", "rotation"),
) -> dict[str, str]:
    """"Don't chase" entry discipline: which NON-held candidates shouldn't be *bought this cycle*
    because they've run too far, too fast (trailing return above ``max_chase_momentum``). Same
    contract as :func:`freshness_skips` — a per-cycle skip (re-checked next cycle), not a block;
    held names are exempt so exits still fire. Disabled when the ceiling is 0/None or the active
    profile isn't momentum-driven. Pure.

    Returns ``{ticker: reason}``."""
    if not max_chase_momentum or max_chase_momentum <= 0 or profile not in apply_profiles:
        return {}
    out: dict[str, str] = {}
    for c in candidates:
        if c.held:
            continue
        if c.momentum is not None and c.momentum > max_chase_momentum:
            out[(c.ticker or "").upper()] = (
                f"extended: +{c.momentum:.0%} trailing is above the {max_chase_momentum:.0%} "
                f"don't-chase ceiling — deferring, re-check next cycle"
            )
    return out


def overlay_live_prices(prices: dict, quotes: dict, *, now_epoch: float) -> dict:
    """Return a copy of the price store with each ticker's ``current`` replaced by its LIVE quote
    and ``fetched_at`` bumped to now. This is how the whole consideration runs on current prices
    instead of a cache: the Analyst's momentum/pullback recompute off the live ``current`` (against
    the monthly bars), the freshness gate sees a fresh feed, and sizing uses the live price."""
    out = dict(prices)
    for t, q in (quotes or {}).items():
        tu = (t or "").upper()
        try:
            qv = float(q)
        except (TypeError, ValueError):
            continue
        if qv <= 0:
            continue
        base = dict(out.get(tu) or {})
        base["current"] = qv
        base["fetched_at"] = now_epoch
        out[tu] = base
    return out


def holdings_from_state(account_state) -> dict[str, dict]:
    """Adapt an AccountState (from the broker snapshot) to the holdings dict the provider
    overlays, so exits can value open positions. Carries the current price too, so a held name
    that's NOT in the active universe (e.g. left over from a prior industry) can still be priced
    and exited."""
    prices = getattr(account_state, "prices", None) or {}
    return {
        t.upper(): {"qty": p.qty, "avg_cost": p.avg_price, "price": prices.get(t)}
        for t, p in (account_state.positions or {}).items()
    }


def make_candidate_provider(
    domain: Optional[str],
    holdings: Optional[dict[str, dict]] = None,
    *,
    store=None,
    market_data=None,
    today: Optional[str] = None,
    prices_override: Optional[dict[str, dict]] = None,
) -> CandidateProvider:
    """Live provider over the cached research / signals / price stores for ``domain`` (the
    active research domain). ``holdings`` overlays current Agentic positions so the Analyst
    can exit. ``prices_override`` lets the caller supply a price dict already refreshed with
    LIVE quotes (so the whole consideration runs on current prices, not a cache). Stores/
    market_data are injectable for tests."""
    if store is None:
        from app.services import research_store as store  # lazy: avoid import at module load
    if market_data is None:
        from app.services import market_data as market_data
    holdings = {k.upper(): v for k, v in (holdings or {}).items()}

    entities = (store.load_domain(domain).get("entities") if domain else []) or []
    by_ticker = {(e.get("ticker") or "").upper(): e for e in entities if e.get("ticker")}
    signals = store.load_signals(domain) if domain else {}
    prices = prices_override if prices_override is not None else (store.load_prices(domain) if domain else {})
    from .themes import load_theme
    theme = load_theme(domain)

    # conviction-momentum: history rows are keyed by entity id; the first row per id is the
    # earliest, so (current conviction − earliest) is the drift since tracking began.
    momentum_by_ticker: dict[str, float] = {}
    try:
        history = store.read_history(domain) if domain else []
    except Exception:
        history = []
    first_conv: dict[str, float] = {}
    for r in history:
        i, c = r.get("id"), r.get("conviction")
        if i and isinstance(c, (int, float)) and i not in first_conv:
            first_conv[i] = c
    for e in entities:
        t = (e.get("ticker") or "").upper()
        cur = (e.get("scores") or {}).get("conviction")
        base = first_conv.get(e.get("id"))
        if t and isinstance(cur, (int, float)) and isinstance(base, (int, float)):
            momentum_by_ticker[t] = (cur - base) / 100.0

    def provider(watchlist: Sequence[str], as_of: str) -> list[Candidate]:
        universe = [w.upper() for w in (watchlist or list(by_ticker.keys()))]
        # always include held names so exits fire even if they fell off the watchlist
        tickers = list(dict.fromkeys(universe + list(holdings.keys())))
        return build_candidates(tickers, by_ticker, signals, prices, holdings, market_data,
                                momentum_by_ticker=momentum_by_ticker, today=today or as_of,
                                theme=theme)

    return provider
