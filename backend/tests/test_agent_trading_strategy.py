"""Tests for the configurable Analyst (Gate 1 decision rules).

Each standard philosophy is a setting; the same pure engine applies its entry/exit rules
over Candidate feature rows. These assert that "considered for purchase" means a concrete,
explainable rule fired — not a black box.
"""
from __future__ import annotations

import pytest

from app.agent_trading import Candidate, StrategyConfig, StrategyDecisionSource
from app.agent_trading.strategy import propose


def C(ticker, **kw):
    return Candidate(ticker=ticker, price=kw.pop("price", 10.0), **kw)


# --------------------------------------------------------------------------- config

def test_unknown_profile_rejected():
    with pytest.raises(ValueError):
        StrategyConfig(profile="yolo")


# --------------------------------------------------------------------------- signal_event

def test_signal_event_buys_on_strong_signal_in_quality_name():
    cfg = StrategyConfig(profile="signal_event", signal_threshold=0.6, research_floor=0.5)
    cands = [
        C("AAA", research_score=0.8, signal_score=0.7),   # strong signal + quality -> buy
        C("BBB", research_score=0.8, signal_score=0.3),   # weak signal -> no
        C("CCC", research_score=0.3, signal_score=0.9),   # strong signal but junk -> no (quality gate)
    ]
    d = propose(cands, cfg)
    assert [x.ticker for x in d] == ["AAA"]
    assert d[0].action == "buy" and "signal" in d[0].rationale


def test_signal_event_exits_on_decay():
    cfg = StrategyConfig(profile="signal_event", signal_exit=0.3, research_floor=0.5,
                         stop_pct=0.5, target_pct=0.5)
    held = [C("AAA", research_score=0.8, signal_score=0.2, held_qty=10, avg_cost=10.0, price=10.5)]
    d = propose(held, cfg)
    assert d[0].action == "sell" and "decayed" in d[0].rationale


# --------------------------------------------------------------------------- momentum

def test_momentum_buys_uptrend_strength():
    cfg = StrategyConfig(profile="momentum", momentum_threshold=0.0, research_floor=0.5)
    cands = [
        C("UP", research_score=0.7, trend_up=True, momentum=0.12),    # uptrend + strength -> buy
        C("DN", research_score=0.7, trend_up=False, momentum=0.20),   # not in uptrend -> no
    ]
    d = propose(cands, cfg)
    assert [x.ticker for x in d] == ["UP"]


def test_momentum_exits_on_broken_trend():
    cfg = StrategyConfig(profile="momentum", research_floor=0.5, stop_pct=0.5, target_pct=0.9)
    held = [C("UP", research_score=0.7, trend_up=False, held_qty=5, avg_cost=10.0, price=10.2)]
    d = propose(held, cfg)
    assert d[0].action == "sell" and "trend broke" in d[0].rationale


# --------------------------------------------------------------------------- mean reversion

def test_mean_reversion_buys_dip_in_uptrend():
    cfg = StrategyConfig(profile="mean_reversion", pullback_pct=0.05, research_floor=0.5)
    cands = [
        C("DIP", research_score=0.7, trend_up=True, pullback=0.08),    # quality dip in uptrend -> buy
        C("EXT", research_score=0.7, trend_up=True, pullback=0.01),    # barely down -> no
    ]
    d = propose(cands, cfg)
    assert [x.ticker for x in d] == ["DIP"]
    assert "pulled back" in d[0].rationale


# --------------------------------------------------------------------------- shared exits

def test_stop_and_target_exits_apply_to_all_profiles():
    cfg = StrategyConfig(profile="momentum", stop_pct=0.08, target_pct=0.15, research_floor=0.5)
    cands = [
        C("LOSS", research_score=0.7, held_qty=10, avg_cost=10.0, price=9.0),    # -10% -> stop
        C("WIN", research_score=0.7, held_qty=10, avg_cost=10.0, price=11.6),    # +16% -> target
    ]
    d = {x.ticker: x for x in propose(cands, cfg)}
    assert d["LOSS"].action == "sell" and "stop-loss" in d["LOSS"].rationale
    assert d["WIN"].action == "sell" and "target" in d["WIN"].rationale


# --------------------------------------------------------------------------- rotation

def test_rotation_holds_top_n_and_rotates_out():
    cfg = StrategyConfig(profile="rotation", rotation_top_n=2, research_floor=0.5, max_new_positions=5)
    cands = [
        C("A", research_score=0.9, rotation_score=0.9),                 # top -> buy (not held)
        C("B", research_score=0.8, rotation_score=0.8),                 # top -> buy (not held)
        C("C", research_score=0.7, rotation_score=0.7),                 # not top -> ignore
        C("OLD", research_score=0.6, rotation_score=0.4, held_qty=10, avg_cost=10),  # held, dropped -> sell
    ]
    d = {x.ticker: x.action for x in propose(cands, cfg)}
    assert d.get("A") == "buy" and d.get("B") == "buy"
    assert d.get("OLD") == "sell"
    assert "C" not in d


# --------------------------------------------------------------------------- cap + source

def test_max_new_positions_caps_buys():
    cfg = StrategyConfig(profile="signal_event", signal_threshold=0.5, research_floor=0.5, max_new_positions=2)
    cands = [C(t, research_score=0.8, signal_score=0.9) for t in ("A", "B", "C", "D")]
    d = propose(cands, cfg)
    assert len([x for x in d if x.action == "buy"]) == 2


def test_decision_source_uses_provider_and_profile():
    cfg = StrategyConfig(profile="signal_event", signal_threshold=0.6, research_floor=0.5)
    provider = lambda watchlist, as_of: [C("AAA", research_score=0.8, signal_score=0.7)]
    src = StrategyDecisionSource(cfg, provider)
    decisions = src.get_decisions(["AAA"], "2026-06-16")
    assert decisions[0].ticker == "AAA" and decisions[0].action == "buy"
    # size is left to the sizer — the Analyst only decides what + why
    assert decisions[0].target_notional is None
