"""Orphaned holdings on an industry switch: a held name that isn't in the active universe still
gets surfaced as an exit-only candidate, so rotation cleans it up instead of stranding it."""
from __future__ import annotations

from app.agent_trading.candidates import build_candidates
from app.agent_trading.strategy import StrategyConfig, propose


class _MD:
    def compute_momentum(self, history, current):
        return None  # no momentum read needed for this test


def test_held_name_outside_universe_becomes_an_exit_candidate_and_sells():
    # Active universe is a single strong name; we still hold OLD from a prior industry.
    tickers = ["AAA"]
    entities = {"AAA": {"scores": {"conviction": 0.95, "upside": 0.6}}}
    prices = {"AAA": {"current": 10.0}}
    holdings = {
        "AAA": {"qty": 5, "avg_cost": 9.0, "price": 10.0},     # in-universe holding
        "OLD": {"qty": 3, "avg_cost": 20.0, "price": 18.0},    # prior-industry orphan
    }
    cands = build_candidates(tickers, entities, {}, prices, holdings, _MD())
    by = {c.ticker: c for c in cands}

    # OLD is surfaced, priced from the live position, and scored 0 so it can't be (re)bought
    assert "OLD" in by
    assert by["OLD"].held_qty == 3 and by["OLD"].price == 18.0 and by["OLD"].research_score == 0.0

    # AAA is still built as a normal in-universe candidate (its keep/exit is decided by its score)
    assert "AAA" in by

    # rotation proposes selling the orphan, with an accurate "not in the active universe" reason
    sells = {d.ticker: d for d in propose(cands, StrategyConfig(profile="rotation")) if d.action == "sell"}
    assert "OLD" in sells
    assert "universe" in sells["OLD"].rationale or "floor" in sells["OLD"].rationale


def test_no_orphans_when_all_holdings_are_in_universe():
    tickers = ["AAA"]
    entities = {"AAA": {"scores": {"conviction": 0.9, "upside": 0.5}}}
    prices = {"AAA": {"current": 10.0}}
    holdings = {"AAA": {"qty": 5, "avg_cost": 9.0, "price": 10.0}}
    cands = build_candidates(tickers, entities, {}, prices, holdings, _MD())
    assert [c.ticker for c in cands] == ["AAA"]   # no phantom orphan rows added
