"""Tests for the agentic-trading experiment harness.

These exercise the load-bearing piece — the guardrail gate — and the executor loop end
to end against the simulated broker. The gate is pure, so these are fast and deterministic.
"""
from __future__ import annotations

import json

import pytest

from app.agent_trading import (
    AccountState,
    AgentTradingExecutor,
    GuardrailConfig,
    Position,
    ProposedOrder,
    SimulatedBroker,
    StubDecisionSource,
    check_order,
)
from app.agent_trading.brokers import BrokerError, RobinhoodMCPBroker


# --------------------------------------------------------------------------- gate

def _state(cash=1000.0, positions=None, prices=None, peak=1000.0, trades=0):
    return AccountState(
        cash=cash,
        positions=positions or {},
        prices=prices or {},
        equity_peak=peak,
        trades_today=trades,
    )


def test_clean_buy_passes():
    cfg = GuardrailConfig.conservative()
    order = ProposedOrder("ROAR", "buy", ref_price=10.0, notional=100.0)
    res = check_order(order, _state(prices={"ROAR": 10.0}), cfg)
    assert res.ok
    assert res.reasons == []


def test_per_order_cap_blocks():
    cfg = GuardrailConfig(per_order_max_notional=500.0)
    order = ProposedOrder("HMNI", "buy", ref_price=25.0, notional=600.0)
    res = check_order(order, _state(prices={"HMNI": 25.0}), cfg)
    assert not res.ok
    assert any("per-order cap" in r for r in res.reasons)


def test_blocklist_blocks():
    cfg = GuardrailConfig(blocklist=frozenset({"MEME"}))
    order = ProposedOrder("MEME", "buy", ref_price=5.0, notional=50.0)
    res = check_order(order, _state(prices={"MEME": 5.0}), cfg)
    assert not res.ok
    assert any("blocklist" in r for r in res.reasons)


def test_allowlist_blocks_unlisted():
    cfg = GuardrailConfig(allowlist=frozenset({"ROAR"}))
    order = ProposedOrder("HMNI", "buy", ref_price=25.0, notional=50.0)
    res = check_order(order, _state(prices={"HMNI": 25.0}), cfg)
    assert not res.ok
    assert any("allowlist" in r for r in res.reasons)


def test_cash_floor_blocks():
    cfg = GuardrailConfig(cash_floor_pct=0.10, per_order_max_notional=10_000)
    # total value 1000, floor = 100; spending 950 would leave 50 < 100
    order = ProposedOrder("ROAR", "buy", ref_price=10.0, notional=950.0)
    res = check_order(order, _state(cash=1000.0, prices={"ROAR": 10.0}), cfg)
    assert not res.ok
    assert any("floor" in r for r in res.reasons)


def test_max_position_pct_blocks():
    cfg = GuardrailConfig(max_position_pct=0.20, per_order_max_notional=10_000, cash_floor_pct=0.0)
    # total 1000, cap per name = 200; buying 300 of one name exceeds it
    order = ProposedOrder("ROAR", "buy", ref_price=10.0, notional=300.0)
    res = check_order(order, _state(cash=1000.0, prices={"ROAR": 10.0}), cfg)
    assert not res.ok
    assert any("cap" in r for r in res.reasons)


def test_no_shorting_on_sell():
    cfg = GuardrailConfig.conservative()
    order = ProposedOrder("ROAR", "sell", ref_price=10.0, qty=5.0)
    res = check_order(order, _state(positions={"ROAR": Position(2.0, 9.0)}, prices={"ROAR": 10.0}), cfg)
    assert not res.ok
    assert any("shorting" in r or "exceeds held" in r for r in res.reasons)


def test_drawdown_halt_flag():
    cfg = GuardrailConfig(max_drawdown_pct=0.15)
    # peak 1000, value now 800 -> 20% drawdown > 15%
    order = ProposedOrder("ROAR", "buy", ref_price=10.0, notional=50.0)
    res = check_order(order, _state(cash=800.0, peak=1000.0, prices={"ROAR": 10.0}), cfg)
    assert not res.ok
    assert any("drawdown" in r for r in res.reasons)


def test_wash_sale_warns_by_default_but_passes():
    cfg = GuardrailConfig(block_on_wash_sale=False)
    order = ProposedOrder("NVDA", "buy", ref_price=120.0, notional=50.0)
    res = check_order(order, _state(prices={"NVDA": 120.0}), cfg, wash_sale_lookup=lambda t, s: True)
    assert res.ok  # not blocking
    assert any("wash-sale" in w for w in res.warnings)


def test_wash_sale_blocks_when_configured():
    cfg = GuardrailConfig(block_on_wash_sale=True)
    order = ProposedOrder("NVDA", "buy", ref_price=120.0, notional=50.0)
    res = check_order(order, _state(prices={"NVDA": 120.0}), cfg, wash_sale_lookup=lambda t, s: True)
    assert not res.ok
    assert any("wash-sale" in r for r in res.reasons)


def test_checks_trace_is_complete():
    cfg = GuardrailConfig.conservative()
    order = ProposedOrder("ROAR", "buy", ref_price=10.0, notional=100.0)
    res = check_order(order, _state(prices={"ROAR": 10.0}), cfg)
    names = {c.name for c in res.checks}
    # the trace should always include the headline checks for transparency in the UI/log
    assert {"drawdown_halt", "per_order_notional", "max_position_pct", "wash_sale_risk"} <= names


# --------------------------------------------------------------------------- sim broker

def test_sim_broker_buy_then_sell_roundtrip():
    b = SimulatedBroker(starting_cash=1000.0)
    b.mark_prices({"ROAR": 10.0})
    fill = b.place_order(ProposedOrder("ROAR", "buy", ref_price=10.0, notional=100.0))
    assert fill.qty == pytest.approx(10.0)
    snap = b.snapshot()
    assert snap.cash == pytest.approx(900.0)
    assert snap.positions["ROAR"].qty == pytest.approx(10.0)

    b.place_order(ProposedOrder("ROAR", "sell", ref_price=11.0, qty=10.0))
    snap = b.snapshot()
    assert "ROAR" not in snap.positions
    assert snap.cash == pytest.approx(1010.0)  # sold 10 @ 11


def test_sim_broker_rejects_oversell():
    b = SimulatedBroker(starting_cash=1000.0)
    with pytest.raises(BrokerError):
        b.place_order(ProposedOrder("ROAR", "sell", ref_price=10.0, qty=1.0))


# --------------------------------------------------------------------------- executor

def test_executor_executes_and_blocks(tmp_path):
    prices = {"ROAR": 10.0, "HMNI": 25.0}
    script = {
        "ROAR": {"action": "buy", "notional": 80.0},
        "HMNI": {"action": "buy", "notional": 600.0},  # over the 500 cap
    }
    broker = SimulatedBroker(starting_cash=1000.0)
    source = StubDecisionSource(prices, script=script)
    cfg = GuardrailConfig.conservative()
    log = tmp_path / "decisions.jsonl"
    ex = AgentTradingExecutor(broker, source, cfg, log_path=log)

    report = ex.run_cycle(["ROAR", "HMNI"], as_of="2026-06-15")
    statuses = {o.decision.ticker: o.status for o in report.outcomes}
    assert statuses["ROAR"] == "executed"
    assert statuses["HMNI"] == "blocked"

    # decision log is written and parseable
    rows = [json.loads(l) for l in log.read_text().splitlines()]
    assert len(rows) == 2
    assert {r["status"] for r in rows} == {"executed", "blocked"}


def test_executor_halts_on_drawdown():
    broker = SimulatedBroker(starting_cash=1000.0)
    # Manufacture a drawdown: buy, then the price collapses below the halt threshold.
    broker.mark_prices({"ROAR": 10.0})
    broker.place_order(ProposedOrder("ROAR", "buy", ref_price=10.0, notional=1000.0))
    broker.mark_prices({"ROAR": 2.0})  # value now ~200 vs peak 1000 -> 80% drawdown

    source = StubDecisionSource({"ROAR": 2.0}, script={"ROAR": {"action": "buy", "notional": 50.0}})
    cfg = GuardrailConfig(max_drawdown_pct=0.15)
    ex = AgentTradingExecutor(broker, source, cfg)
    report = ex.run_cycle(["ROAR"], as_of="2026-06-16")
    assert report.halted
    assert all(o.status == "halted" for o in report.outcomes)


def test_robinhood_broker_refuses_when_disarmed():
    b = RobinhoodMCPBroker("agentic-123")  # disarmed by default
    with pytest.raises(BrokerError):
        b.place_order(ProposedOrder("ROAR", "buy", ref_price=10.0, notional=50.0))
