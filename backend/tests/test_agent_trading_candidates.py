"""Tests for the live candidate provider — the join of research + signals + prices + holdings.

The assembly is pure: it takes the same dict shapes the on-disk caches use (conviction 0–100,
the Quiver signal bundle, the price-cache rows) and a market_data-like object, and produces
Candidate feature rows. A fake market_data keeps it DB- and key-free.
"""
from __future__ import annotations

from app.agent_trading import StrategyConfig, build_candidates, make_candidate_provider
from app.agent_trading.candidates import _research_score, _signal_score
from app.agent_trading.strategy import propose


class FakeMD:
    """Stand-in for services.market_data with the real compute_momentum contract."""
    def __init__(self, by_ticker=None):
        self._by = by_ticker or {}

    def compute_momentum(self, history, current):
        # keyed by the history marker we pass in tests; default = a healthy uptrend
        if history and isinstance(history[0], dict) and history[0].get("tag") in self._by:
            return self._by[history[0]["tag"]]
        return {"score": 70, "ret_3mo_pct": 8.0, "pct_off_high": -4.0}


# --------------------------------------------------------------------------- normalization

def test_research_score_normalizes_conviction_0_100():
    assert _research_score({"scores": {"conviction": 60}}) == 0.6
    assert _research_score({"scores": {}}) == 0.0


def test_signal_score_maps_heating_up_above_threshold():
    # composite "heating up" is score >= 2; should clear the default 0.6 entry threshold
    assert _signal_score({"signal": {"score": 2}}) > 0.6
    assert _signal_score({"signal": {"score": 0}}) == 0.0
    assert _signal_score({"signal": {"score": -2}}) == 0.0   # net selling -> 0


# --------------------------------------------------------------------------- assembly

def test_build_candidates_joins_all_sources():
    entities = {"ROAR": {"ticker": "ROAR", "scores": {"conviction": 82}}}
    signals = {"ROAR": {"signal": {"score": 3, "label": "Heating up"}}}
    prices = {"ROAR": {"current": 10.0, "history": [{"tag": "up"}]}}
    md = FakeMD({"up": {"score": 72, "ret_3mo_pct": 12.0, "pct_off_high": -3.0}})
    cands = build_candidates(["ROAR"], entities, signals, prices, {}, md)
    c = cands[0]
    assert c.ticker == "ROAR" and c.price == 10.0
    assert c.research_score == 0.82
    assert c.signal_score == 1.0                 # 3/3 clamped
    assert c.trend_up and round(c.momentum, 2) == 0.12 and round(c.pullback, 2) == 0.03


def test_build_candidates_overlays_holdings_and_drops_priceless():
    entities = {"AAA": {"ticker": "AAA", "scores": {"conviction": 70}}}
    prices = {"AAA": {"current": 25.0, "history": [{"tag": "x"}]}}
    holdings = {"AAA": {"qty": 4, "avg_cost": 20.0}}
    md = FakeMD()
    cands = build_candidates(["AAA", "NOPRICE"], entities, {}, prices, holdings, md)
    assert len(cands) == 1                        # NOPRICE has no price -> dropped
    assert cands[0].held and cands[0].held_qty == 4 and cands[0].avg_cost == 20.0


def test_fundamentals_price_fallback():
    entities = {"BBB": {"ticker": "BBB", "scores": {"conviction": 55}, "fundamentals": {"price": "$12.50"}}}
    cands = build_candidates(["BBB"], entities, {}, {}, {}, FakeMD())
    assert cands[0].price == 12.5


# --------------------------------------------------------------------------- provider + end-to-end

class FakeStore:
    def __init__(self, entities, signals, prices):
        self._e, self._s, self._p = entities, signals, prices
    def load_domain(self, d): return {"entities": list(self._e.values())}
    def load_signals(self, d): return self._s
    def load_prices(self, d): return self._p


def test_provider_includes_held_names_not_in_watchlist():
    entities = {"AAA": {"ticker": "AAA", "scores": {"conviction": 80}}}
    prices = {"AAA": {"current": 10.0, "history": [{"tag": "x"}]}, "HELD": {"current": 5.0, "history": [{"tag": "x"}]}}
    store = FakeStore(entities, {}, prices)
    holdings = {"HELD": {"qty": 3, "avg_cost": 6.0}}
    provider = make_candidate_provider("demo", holdings, store=store, market_data=FakeMD())
    cands = provider(["AAA"], "2026-06-16")
    tickers = {c.ticker for c in cands}
    assert "AAA" in tickers and "HELD" in tickers   # held name pulled in for exit checks


def test_end_to_end_provider_feeds_analyst():
    # research + signal data flows through the provider into a real strategy decision
    entities = {"ROAR": {"ticker": "ROAR", "scores": {"conviction": 82}}}
    signals = {"ROAR": {"signal": {"score": 3}}}
    prices = {"ROAR": {"current": 10.0, "history": [{"tag": "x"}]}}
    store = FakeStore(entities, signals, prices)
    provider = make_candidate_provider("demo", {}, store=store, market_data=FakeMD())
    cands = provider(["ROAR"], "2026-06-16")
    decisions = propose(cands, StrategyConfig(profile="signal_event"))
    assert decisions and decisions[0].ticker == "ROAR" and decisions[0].action == "buy"
    assert "signal" in decisions[0].rationale
