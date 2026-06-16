"""Tests for the settled-cash guardrail (cash-account T+1). Default-off; only fires when
required AND the broker reported settled cash."""
from __future__ import annotations

from app.agent_trading.guardrails import AccountState, GuardrailConfig, ProposedOrder, check_order


def _state(cash, settled=None):
    return AccountState(cash=cash, positions={}, prices={}, equity_peak=cash, trades_today=0, settled_cash=settled)


# loose limits so ONLY the settled-cash check can gate
_CFG_ON = GuardrailConfig(require_settled_cash=True, per_order_max_notional=1e9,
                          cash_floor_pct=0.0, max_position_pct=1.0)


def test_blocks_buy_above_settled_cash():
    r = check_order(ProposedOrder("NB", "buy", 10.0, notional=500.0), _state(1000.0, settled=200.0), _CFG_ON)
    assert not r.ok and any("settled" in x for x in r.reasons)


def test_passes_when_within_settled_cash():
    r = check_order(ProposedOrder("NB", "buy", 10.0, notional=150.0), _state(1000.0, settled=200.0), _CFG_ON)
    assert r.ok


def test_off_by_default_ignores_settled():
    cfg = GuardrailConfig(per_order_max_notional=1e9, cash_floor_pct=0.0, max_position_pct=1.0)
    r = check_order(ProposedOrder("NB", "buy", 10.0, notional=500.0), _state(1000.0, settled=10.0), cfg)
    assert r.ok


def test_skipped_when_settled_unknown():
    # required, but broker didn't report settled cash → check can't fire (no false block)
    r = check_order(ProposedOrder("NB", "buy", 10.0, notional=500.0), _state(1000.0, settled=None), _CFG_ON)
    assert r.ok
