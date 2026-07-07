"""Tests for order construction — market vs marketable-limit. Pure."""
from __future__ import annotations

import pytest

from app.agent_trading.guardrails import ProposedOrder
from app.agent_trading.order_policy import OrderPolicy, build_order_args, limit_price


def test_market_notional_converts_to_quantity():
    # agentic place_equity_order rejects a dollar `amount` → notional becomes a share quantity
    a = build_order_args("acct", ProposedOrder("nb", "buy", 5.0, notional=100.0))
    assert a["type"] == "market" and a["quantity"] == 20.0 and a["symbol"] == "NB" and "amount" not in a


def test_market_qty_uses_quantity():
    a = build_order_args("acct", ProposedOrder("nb", "sell", 5.0, qty=10))
    assert a["type"] == "market" and a["quantity"] == 10 and "amount" not in a


def test_limit_buy_above_sell_below_and_uses_quantity():
    pol = OrderPolicy(order_type="limit", limit_offset_bps=100)  # 1%
    buy = build_order_args("a", ProposedOrder("nb", "buy", 10.0, notional=100.0), policy=pol)
    sell = build_order_args("a", ProposedOrder("nb", "sell", 10.0, qty=5), policy=pol)
    assert buy["type"] == "limit" and buy["limit_price"] == 10.10 and "quantity" in buy and "amount" not in buy
    assert sell["limit_price"] == 9.90


def test_limit_floors_to_whole_shares():
    """Robinhood limit orders aren't fractional — a limit order floors qty to whole shares at
    generation (so the proposal matches the placed order), while market stays fractional."""
    pol = OrderPolicy(order_type="limit", limit_offset_bps=25)
    # $100 / $21.97 ≈ 4.55 sh → floored to 4 for a limit order
    lim = build_order_args("a", ProposedOrder("usar", "buy", 21.97, notional=100.0), policy=pol)
    assert lim["type"] == "limit" and lim["quantity"] == 4.0
    # same sizing as a MARKET order stays fractional
    mkt = build_order_args("a", ProposedOrder("usar", "buy", 21.97, notional=100.0))
    assert mkt["type"] == "market" and round(mkt["quantity"], 6) == round(100.0 / 21.97, 6)


def test_sub_share_limit_refused_not_inflated():
    """A limit order sized under 1 share must be REFUSED, never silently inflated to a whole
    share (a $10 buy of a $50 name would become a $50 order). Callers skip these via
    is_sub_share_limit(); build_order_args is the last line of defense."""
    pol = OrderPolicy(order_type="limit", limit_offset_bps=25)
    with pytest.raises(ValueError, match="sub-share limit order"):
        build_order_args("a", ProposedOrder("x", "buy", 50.0, notional=10.0), policy=pol)


def test_limit_price_helper():
    pol = OrderPolicy(order_type="limit", limit_offset_bps=25)
    assert limit_price("buy", 100.0, pol) == 100.25
    assert limit_price("sell", 100.0, pol) == 99.75


def test_bad_policy_rejected():
    with pytest.raises(ValueError):
        OrderPolicy(order_type="stop")
    with pytest.raises(ValueError):
        OrderPolicy(limit_offset_bps=-1)
