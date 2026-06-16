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

def _ranked(n, held=()):
    """n candidates ranked by descending rotation_score; `held` = set of indices held."""
    out = []
    for i in range(n):
        out.append(Candidate(f"T{i}", price=10.0, research_score=0.9, rotation_score=1.0 - i * 0.05,
                             held_qty=(1.0 if i in held else 0.0), avg_cost=10.0))
    return out


def test_rotation_hysteresis_holds_through_small_slip():
    # held names at rank 6 (T5) and rank 9 (T8); buy top 5, sell only below rank 8
    cands = _ranked(9, held={5, 8})
    cfg = StrategyConfig(profile="rotation", rotation_top_n=5, rotation_exit_n=8, max_new_positions=5)
    acts = {x.ticker: x.action for x in propose(cands, cfg)}
    assert "T5" not in acts            # rank 6 → inside the keep buffer (top 8) → HELD, no sell
    assert acts.get("T8") == "sell"    # rank 9 → below exit rank 8 → rotated out


def test_rotation_without_hysteresis_sells_on_slip():
    cands = _ranked(9, held={5})
    cfg = StrategyConfig(profile="rotation", rotation_top_n=5, rotation_exit_n=5)  # no buffer
    acts = {x.ticker: x.action for x in propose(cands, cfg)}
    assert acts.get("T5") == "sell"    # rank 6 with no buffer → sold the moment it slips


def test_rotation_holds_top_n_and_rotates_out():
    # exit_n == top_n disables the hysteresis buffer for this rotate-out test
    cfg = StrategyConfig(profile="rotation", rotation_top_n=2, rotation_exit_n=2,
                         research_floor=0.5, max_new_positions=5)
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


# --------------------------------------------------------------------------- full-universe ranking

def test_rank_universe_covers_every_name_with_status():
    from app.agent_trading.strategy import rank_universe
    cands = _ranked(10, held={6})  # T6 held, ranks 7th
    cfg = StrategyConfig(profile="rotation", rotation_top_n=5, rotation_exit_n=8)
    rows = rank_universe(cands, cfg)
    assert [r.ticker for r in rows] == [c.ticker for c in cands]   # WHOLE list, ranked
    by = {r.ticker: r for r in rows}
    assert by["T0"].status == "in_basket"        # top 5
    assert by["T6"].status == "buffer"           # rank 7 → inside the 8-wide keep buffer, held
    assert by["T9"].status == "below_cutoff"     # rank 10 → must climb to be bought
    assert "climb" in by["T9"].note              # tells you what it needs


def test_rank_universe_small_name_makes_the_cut_on_trigger():
    from app.agent_trading.strategy import rank_universe
    # a low research_score name still qualifies in momentum purely on its own trend+strength
    cands = [
        C("BIG", research_score=0.95, trend_up=False, momentum=0.01),   # top quality, no trigger
        C("SMALL", research_score=0.55, trend_up=True, momentum=0.18),  # small, but strong trigger
    ]
    cfg = StrategyConfig(profile="momentum", research_floor=0.5)
    by = {r.ticker: r for r in rank_universe(cands, cfg)}
    assert by["SMALL"].action == "buy" and by["SMALL"].status == "qualifies"
    assert by["BIG"].action is None and by["BIG"].status == "blocked"
    assert "uptrend" in by["BIG"].note            # names the missing trigger


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
