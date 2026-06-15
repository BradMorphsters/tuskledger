"""Tests for position sizing — chooses the trade size, the gate still vetoes oversize."""
from __future__ import annotations

from app.agent_trading import (
    AccountState,
    Decision,
    GuardrailConfig,
    Position,
    SizingConfig,
    check_order,
    rebalance,
    size_decision,
    size_decisions,
)
from app.agent_trading.guardrails import ProposedOrder


def _state(cash=1000.0, positions=None, prices=None):
    return AccountState(cash=cash, positions=positions or {}, prices=prices or {},
                        equity_peak=cash, trades_today=0)


def _buy(ticker, price=10.0):
    return Decision(ticker, "buy", ref_price=price, rationale="")


# --------------------------------------------------------------------------- fixed fractional

def test_fixed_fractional_basic():
    cfg = SizingConfig(method="fixed_fractional", fraction=0.10)
    d = size_decision(_buy("ROAR"), _state(cash=1000.0, prices={"ROAR": 10.0}), cfg)
    assert d.target_notional == 100.0  # 10% of $1000


def test_fixed_fractional_clamped_by_existing_position():
    # total = $850 cash + $150 ROAR = $1000; max_fraction 20% = $200 cap, already hold
    # $150 -> only $50 headroom for more ROAR
    cfg = SizingConfig(method="fixed_fractional", fraction=0.30, max_fraction=0.20)
    state = _state(cash=850.0, positions={"ROAR": Position(15.0, 10.0)}, prices={"ROAR": 10.0})
    d = size_decision(_buy("ROAR"), state, cfg)
    assert d.target_notional == 50.0


def test_fixed_fractional_clamped_by_cash():
    # total = $30 cash + $970 OTHER = $1000; a 50% buy wants $500 but only $30 cash exists
    cfg = SizingConfig(method="fixed_fractional", fraction=0.50, max_fraction=1.0)
    state = _state(cash=30.0, positions={"OTHER": Position(97.0, 10.0)},
                   prices={"OTHER": 10.0, "ROAR": 10.0})
    d = size_decision(_buy("ROAR"), state, cfg)
    assert d.target_notional == 30.0  # clamped by available cash


def test_tiny_size_becomes_hold():
    cfg = SizingConfig(method="fixed_fractional", fraction=0.10, min_trade_notional=5.0)
    d = size_decision(_buy("ROAR"), _state(cash=20.0, prices={"ROAR": 10.0}), cfg)  # 10% of ~20
    assert d.action == "hold"


# --------------------------------------------------------------------------- vol target

def test_vol_target_sizes_inverse_to_volatility():
    cfg = SizingConfig(method="vol_target", target_risk=0.01, max_fraction=1.0)
    state = _state(cash=10_000.0, prices={"A": 10.0, "B": 10.0})
    low_vol = size_decision(_buy("A"), state, cfg, vol=0.01)   # risk 1%*10000=100 / 0.01 = 10000 -> clamp cash
    high_vol = size_decision(_buy("B"), state, cfg, vol=0.10)  # 100 / 0.10 = 1000
    assert high_vol.target_notional == 1000.0
    assert low_vol.target_notional > high_vol.target_notional  # lower vol -> bigger size


def test_vol_target_falls_back_without_vol():
    cfg = SizingConfig(method="vol_target", fraction=0.10)
    d = size_decision(_buy("A"), _state(cash=1000.0, prices={"A": 10.0}), cfg, vol=None)
    assert d.target_notional == 100.0  # fell back to fixed fraction


# --------------------------------------------------------------------------- sells

def test_sell_sizes_to_full_position_without_oversell():
    cfg = SizingConfig()
    state = _state(positions={"ROAR": Position(8.0, 9.0)}, prices={"ROAR": 11.0})
    d = size_decision(Decision("ROAR", "sell", ref_price=11.0), state, cfg)
    assert d.target_notional == 88.0  # 8 sh * $11
    # and the resulting order does NOT oversell (resolved qty == held qty)
    order = ProposedOrder("ROAR", "sell", ref_price=11.0, notional=d.target_notional)
    res = check_order(order, state, GuardrailConfig.conservative())
    assert all(c.passed for c in res.checks if c.name == "no_oversell")


def test_sell_with_no_position_becomes_hold():
    d = size_decision(Decision("ROAR", "sell", ref_price=10.0), _state(), SizingConfig())
    assert d.action == "hold"


# --------------------------------------------------------------------------- rebalance

def test_rebalance_emits_buys_to_target():
    cfg = SizingConfig()
    decisions = rebalance({"A": 0.5, "B": 0.5}, _state(cash=1000.0, prices={"A": 10.0, "B": 10.0}), cfg)
    by = {d.ticker: d for d in decisions}
    assert by["A"].action == "buy" and by["A"].target_notional == 500.0
    assert by["B"].action == "buy" and by["B"].target_notional == 500.0


def test_rebalance_sells_overweight():
    cfg = SizingConfig()
    # hold $600 of A (60%) in a $1000 account; target 40% -> sell $200
    state = _state(cash=400.0, positions={"A": Position(60.0, 10.0)}, prices={"A": 10.0})
    decisions = rebalance({"A": 0.40}, state, cfg)
    assert len(decisions) == 1
    assert decisions[0].action == "sell" and decisions[0].target_notional == 200.0


def test_rebalance_skips_names_near_target():
    cfg = SizingConfig(min_trade_notional=5.0)
    state = _state(cash=500.0, positions={"A": Position(50.0, 10.0)}, prices={"A": 10.0})  # $500 = 50%
    decisions = rebalance({"A": 0.50}, state, cfg)  # already at target
    assert decisions == []


# --------------------------------------------------------------------------- batch

def test_size_decisions_batch_with_vols():
    cfg = SizingConfig(method="vol_target", target_risk=0.01, max_fraction=1.0)
    state = _state(cash=10_000.0, prices={"A": 10.0, "B": 10.0})
    out = size_decisions([_buy("A"), _buy("B")], state, cfg, vols={"A": 0.02, "B": 0.05})
    sizes = {d.ticker: d.target_notional for d in out}
    assert sizes["A"] > sizes["B"]  # A less volatile -> larger position
