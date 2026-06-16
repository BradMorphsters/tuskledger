"""Tests for the total-deployment ceiling (the 'go live with $300, expand later' guardrail)."""
from __future__ import annotations

from app.agent_trading.guardrails import AccountState, GuardrailConfig, Position, ProposedOrder, check_order


def _state(cash, positions=None):
    pos = positions or {}
    prices = {t: p.avg_price for t, p in pos.items()}
    invested = sum(p.qty * p.avg_price for p in pos.values())
    return AccountState(cash=cash, positions=pos, prices=prices, equity_peak=cash + invested)


# loose on everything else so only the deployment ceiling can gate
_CAP = GuardrailConfig(max_deployed_notional=300.0, per_order_max_notional=1e9,
                       cash_floor_pct=0.0, max_position_pct=1.0)


def test_blocks_buy_over_the_ceiling():
    st = _state(cash=1700, positions={"AAA": Position(25, 10.0)})       # $250 already invested
    r = check_order(ProposedOrder("BBB", "buy", 10.0, notional=100.0), st, _CAP)  # → $350
    assert not r.ok and any("ceiling" in x for x in r.reasons)


def test_allows_buy_up_to_the_ceiling():
    st = _state(cash=1900, positions={"AAA": Position(10, 10.0)})       # $100 invested
    r = check_order(ProposedOrder("BBB", "buy", 10.0, notional=200.0), st, _CAP)  # → exactly $300
    assert r.ok


def test_no_ceiling_when_unset():
    cfg = GuardrailConfig(per_order_max_notional=1e9, cash_floor_pct=0.0, max_position_pct=1.0)
    r = check_order(ProposedOrder("BBB", "buy", 10.0, notional=900.0), _state(2000), cfg)
    assert r.ok  # max_deployed_notional is None → no cap
