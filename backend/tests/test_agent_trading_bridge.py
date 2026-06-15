"""Tests for the Cowork↔Tusk Ledger bridge (ADR-0001).

The defining property: `plan_cycle()` decides everything but can place nothing. It takes a
snapshot Cowork fetched and returns approved order ARGS — there is no broker/MCP anywhere
in its signature or body. These tests assert the gate's verdicts and that approvals are
emitted as inert args, never executed.
"""
from __future__ import annotations

import json

from app.agent_trading import (
    AccountState,
    AgentState,
    Decision,
    GuardrailConfig,
    Position,
    StateStore,
    cycle_log_rows,
    plan_cycle,
    record_cycle,
)

ACCT = "test-agentic-001"  # placeholder — never a real account number


def _snap(cash=1000.0, positions=None, prices=None, peak=0.0):
    return AccountState(cash=cash, positions=positions or {}, prices=prices or {},
                        equity_peak=peak, trades_today=0)


def _dec(ticker, action="buy", price=10.0, notional=80.0):
    return Decision(ticker=ticker, action=action, ref_price=price, target_notional=notional,
                    rationale=f"{action} {ticker}")


# --------------------------------------------------------------------------- gate verdicts

def test_approves_clean_order_with_ready_args():
    plan = plan_cycle(
        account_number=ACCT, snapshot=_snap(prices={"ROAR": 10.0}),
        decisions=[_dec("ROAR", notional=80.0)],
        config=GuardrailConfig.conservative(), persisted=AgentState(),
        as_of="2026-06-15",
    )
    assert len(plan.approved) == 1
    args = plan.approved[0].order_args
    # args are exactly what place_equity_order expects — and that's ALL plan_cycle produces
    assert args == {"account_number": ACCT, "symbol": "ROAR", "side": "buy",
                    "type": "market", "amount": 80.0}


def test_blocks_oversized_order():
    plan = plan_cycle(
        account_number=ACCT, snapshot=_snap(cash=300.0, prices={"HMNI": 25.0}),
        decisions=[_dec("HMNI", notional=600.0)],
        config=GuardrailConfig.conservative(), persisted=AgentState(), as_of="2026-06-15",
    )
    assert plan.approved == []
    assert len(plan.blocked) == 1
    assert any("per-order cap" in r for r in plan.blocked[0].guardrail.reasons)


def test_sequential_cash_floor_within_cycle():
    # two buys; the first eats the headroom so the second should be blocked by cash floor
    cfg = GuardrailConfig(per_order_max_notional=1000, max_position_pct=1.0, cash_floor_pct=0.5)
    plan = plan_cycle(
        account_number=ACCT, snapshot=_snap(cash=1000.0, prices={"A": 10.0, "B": 10.0}),
        decisions=[_dec("A", notional=500.0), _dec("B", notional=300.0)],
        config=cfg, persisted=AgentState(), as_of="2026-06-15",
    )
    statuses = {p.decision.ticker for p in plan.approved}
    blocked = {o.decision.ticker for o in plan.blocked}
    assert "A" in statuses          # first fits (cash 1000 -> 500, floor 500 ok)
    assert "B" in blocked           # second would drop cash below the 50% floor


def test_holds_are_skipped_not_ordered():
    plan = plan_cycle(
        account_number=ACCT, snapshot=_snap(prices={"ROAR": 10.0}),
        decisions=[_dec("ROAR", action="hold")],
        config=GuardrailConfig.conservative(), persisted=AgentState(), as_of="2026-06-15",
    )
    assert plan.approved == [] and len(plan.skipped) == 1


# --------------------------------------------------------------------------- policy state

def test_persisted_halt_approves_nothing():
    plan = plan_cycle(
        account_number=ACCT, snapshot=_snap(prices={"ROAR": 10.0}),
        decisions=[_dec("ROAR")], config=GuardrailConfig.conservative(),
        persisted=AgentState(halted=True), as_of="2026-06-15",
    )
    assert plan.halted and plan.approved == []


def test_drawdown_halt_uses_persisted_peak():
    # peak 1000 persisted; snapshot now worth 700 -> 30% drawdown > 15% limit
    plan = plan_cycle(
        account_number=ACCT, snapshot=_snap(cash=700.0, prices={"ROAR": 10.0}),
        decisions=[_dec("ROAR")], config=GuardrailConfig(max_drawdown_pct=0.15),
        persisted=AgentState(equity_peak=1000.0), as_of="2026-06-16",
    )
    assert plan.halted and "drawdown" in plan.halt_reason
    assert plan.state.halted is True  # trip is persisted


def test_drift_passthrough():
    # broker shows 12 shares, log expected 10
    snap = _snap(positions={"ROAR": Position(12.0, 10.0)}, prices={"ROAR": 10.0})
    plan = plan_cycle(
        account_number=ACCT, snapshot=snap, decisions=[],
        config=GuardrailConfig.conservative(), persisted=AgentState(),
        expected_positions={"ROAR": 10.0}, as_of="2026-06-15",
    )
    assert plan.drift and plan.drift[0]["delta"] == 2.0


# --------------------------------------------------------------------------- recording

def test_record_cycle_logs_executed_and_blocked(tmp_path):
    plan = plan_cycle(
        account_number=ACCT, snapshot=_snap(cash=1000.0, prices={"ROAR": 10.0, "HMNI": 25.0}),
        decisions=[_dec("ROAR", notional=80.0), _dec("HMNI", notional=600.0)],
        config=GuardrailConfig.conservative(), persisted=AgentState(), as_of="2026-06-15",
    )
    # Cowork "placed" the one approved order and got a fill back
    fills = [{"ticker": "ROAR", "side": "buy", "qty": 8.0, "price": 10.0,
              "notional": 80.0, "ts": "2026-06-15T15:00:00Z", "venue": "robinhood"}]
    log = tmp_path / "decisions.jsonl"
    store = StateStore(tmp_path / "state.json")
    rows = record_cycle(plan, fills, log_path=log, state_store=store)

    by_status = {r["status"] for r in rows}
    assert by_status == {"executed", "blocked"}
    # decision log is parseable and the executed row carries the real fill
    parsed = [json.loads(l) for l in log.read_text().splitlines()]
    ex = next(r for r in parsed if r["status"] == "executed")
    assert ex["fill"]["venue"] == "robinhood"
    # state persisted
    assert (tmp_path / "state.json").exists()


def test_plan_cycle_has_no_trade_capability():
    """Guard rail on the design itself: approving an order yields inert args, and there is
    no broker/place call anywhere in plan_cycle's result."""
    plan = plan_cycle(
        account_number=ACCT, snapshot=_snap(prices={"ROAR": 10.0}),
        decisions=[_dec("ROAR")], config=GuardrailConfig.conservative(),
        persisted=AgentState(), as_of="2026-06-15",
    )
    # the "approval" is pure data — a dict of args — not a side effect
    assert isinstance(plan.approved_order_args()[0], dict)
    assert plan.approved_order_args()[0]["symbol"] == "ROAR"
