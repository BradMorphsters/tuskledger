"""Tests for persistent policy state + reconciliation against the broker.

Confirms the two things the design hinges on: the broker stays the source of truth for
cash/positions, while the equity high-water mark and halt flag persist across restarts —
so the drawdown breaker can't be reset by bouncing the process, and a tripped halt stays
tripped until a human re-arms it. Plus drift detection vs the decision log.
"""
from __future__ import annotations

import datetime

from app.agent_trading import (
    AccountState,
    AgentState,
    AgentTradingExecutor,
    GuardrailConfig,
    Position,
    ProposedOrder,
    SimulatedBroker,
    StateStore,
    StubDecisionSource,
    reconcile,
)


def _live(cash=1000.0, positions=None, prices=None):
    return AccountState(cash=cash, positions=positions or {}, prices=prices or {},
                        equity_peak=0.0, trades_today=0)


# --------------------------------------------------------------------------- store

def test_state_store_roundtrip_and_corruption(tmp_path):
    p = tmp_path / "state.json"
    store = StateStore(p)
    assert store.load() == AgentState()  # defaults when missing
    store.save(AgentState(equity_peak=1234.5, halted=True))
    again = store.load()
    assert again.equity_peak == 1234.5 and again.halted is True
    # corrupt file -> safe defaults, never a crash
    p.write_text("{ not json")
    assert store.load() == AgentState()


# --------------------------------------------------------------------------- reconcile

def test_reconcile_carries_peak_forward():
    # broker now worth 800, but our persisted peak was 1000 -> peak stays 1000
    live = _live(cash=800.0)
    res = reconcile(live, AgentState(equity_peak=1000.0), expected_positions={}, executed_today=0)
    assert res.account_state.equity_peak == 1000.0
    assert res.new_high is False


def test_reconcile_sets_new_high():
    live = _live(cash=1200.0)
    res = reconcile(live, AgentState(equity_peak=1000.0), expected_positions={}, executed_today=0)
    assert res.account_state.equity_peak == 1200.0
    assert res.new_high is True


def test_reconcile_detects_drift():
    # broker reports 12 shares; our log expected 10 (e.g. a dividend reinvest or manual buy)
    live = _live(positions={"ROAR": Position(qty=12.0, avg_price=10.0)}, prices={"ROAR": 10.0})
    res = reconcile(live, AgentState(equity_peak=0.0), expected_positions={"ROAR": 10.0}, executed_today=0)
    assert len(res.drift) == 1
    d = res.drift[0]
    assert d.ticker == "ROAR" and d.delta == 2.0


def test_reconcile_trades_today_comes_from_log_not_broker():
    res = reconcile(_live(), AgentState(), expected_positions={}, executed_today=4)
    assert res.account_state.trades_today == 4


# --------------------------------------------------------------------------- executor integration

def test_peak_survives_restart_and_trips_drawdown(tmp_path):
    """A fresh executor (simulating a process restart) must still see the prior peak and
    halt on drawdown, even though the broker's own bookkeeping started clean."""
    state_path = tmp_path / "state.json"
    log = tmp_path / "decisions.jsonl"
    # Pre-seed a high-water mark from a previous run.
    StateStore(state_path).save(AgentState(equity_peak=1000.0))

    # New broker (post-restart) holds a position now worth only ~700 (30% down from peak).
    broker = SimulatedBroker(starting_cash=200.0)
    broker.mark_prices({"ROAR": 5.0})
    broker.place_order(ProposedOrder("ROAR", "buy", ref_price=5.0, notional=200.0))  # ~0 cash, 40 sh
    broker.mark_prices({"ROAR": 12.5})  # 40 sh * 12.5 = 500 total... ensure < 850 (15% of 1000)

    source = StubDecisionSource({"ROAR": 12.5}, script={"ROAR": {"action": "buy", "notional": 20.0}})
    ex = AgentTradingExecutor(
        broker, source, GuardrailConfig(max_drawdown_pct=0.15),
        log_path=log, state_store=StateStore(state_path),
    )
    report = ex.run_cycle(["ROAR"], as_of="2026-06-16")
    assert report.halted
    assert "drawdown" in report.halt_reason
    # the halt is now persisted
    assert StateStore(state_path).load().halted is True


def test_halt_persists_until_rearm(tmp_path):
    state_path = tmp_path / "state.json"
    StateStore(state_path).save(AgentState(equity_peak=1000.0, halted=True))
    broker = SimulatedBroker(starting_cash=1000.0)
    source = StubDecisionSource({"ROAR": 10.0}, script={"ROAR": {"action": "buy", "notional": 50.0}})
    ex = AgentTradingExecutor(broker, source, GuardrailConfig.conservative(),
                              state_store=StateStore(state_path))

    # While halted, the loop refuses to trade.
    r1 = ex.run_cycle(["ROAR"], as_of="2026-06-16")
    assert r1.halted and all(o.status == "halted" for o in r1.outcomes)

    # Human re-arms; trading resumes.
    StateStore(state_path).rearm()
    r2 = ex.run_cycle(["ROAR"], as_of="2026-06-17")
    assert not r2.halted
    assert any(o.status == "executed" for o in r2.outcomes)


def test_control_status_reflects_flags():
    from app.agent_trading.state import control_status
    assert control_status(AgentState()) == "active"
    assert control_status(AgentState(paused=True)) == "paused"
    assert control_status(AgentState(halted=True)) == "halted"
    # halt takes precedence over pause
    assert control_status(AgentState(halted=True, paused=True)) == "halted"


def test_strategy_persists_in_state(tmp_path):
    from dataclasses import replace
    store = StateStore(tmp_path / "state.json")
    assert store.load().strategy == ""           # default → falls back to config
    store.save(replace(store.load(), strategy="momentum"))
    assert store.load().strategy == "momentum"
    # surviving a halt + re-arm doesn't lose the chosen strategy
    store.mark_halted()
    store.rearm()
    assert store.load().strategy == "momentum"


def test_store_pause_resume_rearm_cycle(tmp_path):
    from dataclasses import replace
    store = StateStore(tmp_path / "state.json")
    store.save(replace(store.load(), paused=True))
    assert store.load().paused is True
    store.save(replace(store.load(), paused=False))
    assert store.load().paused is False
    store.mark_halted()
    assert store.load().halted is True
    store.rearm()
    assert store.load().halted is False and store.load().paused is False


def test_no_store_path_unchanged(tmp_path):
    """Without a store, behavior is exactly as before — broker provides peak/trades."""
    broker = SimulatedBroker(starting_cash=1000.0)
    source = StubDecisionSource({"ROAR": 10.0}, script={"ROAR": {"action": "buy", "notional": 80.0}})
    ex = AgentTradingExecutor(broker, source, GuardrailConfig.conservative())
    report = ex.run_cycle(["ROAR"], as_of="2026-06-15")
    assert not report.halted
    assert any(o.status == "executed" for o in report.outcomes)
    assert report.drift == []
