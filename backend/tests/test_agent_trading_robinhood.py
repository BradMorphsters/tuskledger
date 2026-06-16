"""Tests for the Robinhood MCP broker — read-only tier + schema pinned to the live API.

The fake MCP client returns the REAL response envelopes captured from a live connection on
2026-06-15 (a ``data`` wrapper; cash under ``get_portfolio``; ``account_number`` args). It
*raises* if a write tool is ever called, so "read-only can't trade" is enforced, not asserted.
"""
from __future__ import annotations

import pytest

from app.agent_trading import (
    BrokerError,
    MODE_DISARMED,
    MODE_LIVE,
    MODE_READ_ONLY,
    ProposedOrder,
    RobinhoodMCPBroker,
    parse_account_state,
)

WRITE_TOOLS = {"place_equity_order", "cancel_equity_order"}


def test_place_raw_binds_account_and_stringifies_quantity(monkeypatch):
    """place_equity_order rejects a placeholder account and a numeric quantity — place_raw must
    force the bound account and send quantity as a STRING."""
    monkeypatch.setattr("app.agent_trading.brokers._log_place", lambda *a, **k: None)  # no runtime-file write
    seen = {}

    def fake_client(tool, args):
        seen["tool"], seen["args"] = tool, dict(args)
        return {"data": {"id": "ord-1", "filled_quantity": "4.3176", "average_price": "23.2"}}

    broker = RobinhoodMCPBroker(account_number="test-agentic-001", mcp_client=fake_client, mode=MODE_LIVE)
    fill = broker.place_raw({"account_number": "live-sleeve", "symbol": "USAR", "side": "buy",
                             "type": "market", "quantity": 4.317603})
    assert seen["tool"] == "place_equity_order"
    assert seen["args"]["account_number"] == "test-agentic-001"  # bound account, not the placeholder
    assert seen["args"]["quantity"] == "4.317603" and isinstance(seen["args"]["quantity"], str)
    assert fill.venue == "robinhood" and fill.ticker == "USAR"


def test_place_raw_reads_nested_order_and_queued_state(monkeypatch):
    """The REAL place_equity_order success shape nests the order under data.order with a
    ``state`` (e.g. 'unconfirmed') and empty fills — a placed-but-not-yet-filled (queued) order.
    place_raw must read the nested id (not flag a false 'no order id') and report it as NOT
    filled, with the order id captured."""
    monkeypatch.setattr("app.agent_trading.brokers._log_place", lambda *a, **k: None)
    # Captured verbatim from a live placement on 2026-06-16.
    raw = {"data": {"order": {
        "id": "00000000-0000-4000-8000-0000000000aa", "symbol": "", "side": "buy", "type": "market",
        "state": "unconfirmed", "quantity": "4.552697", "cumulative_quantity": "0.000000",
        "price": "21.970000", "average_price": None, "executions": [],
        "created_at": "2026-06-16T19:09:40.985836Z"}},
        "guide": "The order has been submitted — not necessarily filled."}
    broker = RobinhoodMCPBroker(account_number="test-agentic-001", mcp_client=lambda *a: raw, mode=MODE_LIVE)
    fill = broker.place_raw({"account_number": "live-sleeve", "symbol": "USAR", "side": "buy",
                             "type": "market", "quantity": 4.552697})
    assert fill.order_id == "00000000-0000-4000-8000-0000000000aa"
    assert fill.state == "unconfirmed"
    assert fill.is_filled is False                     # submitted, not yet executed → "queued"
    assert fill.ticker == "USAR" and fill.qty == 4.552697   # symbol="" in response → use order_args


def test_place_raw_reports_filled_when_executed(monkeypatch):
    """A response whose order has filled (state='filled', cumulative_quantity>0) is is_filled."""
    monkeypatch.setattr("app.agent_trading.brokers._log_place", lambda *a, **k: None)
    raw = {"data": {"order": {"id": "abc", "state": "filled", "quantity": "5",
                              "cumulative_quantity": "5.000000", "average_price": "18.74"}}}
    broker = RobinhoodMCPBroker(account_number="test-agentic-001", mcp_client=lambda *a: raw, mode=MODE_LIVE)
    fill = broker.place_raw({"symbol": "ALM", "side": "buy", "type": "market", "quantity": 5})
    assert fill.is_filled is True and fill.state == "filled"
    assert fill.qty == 5.0 and fill.price == 18.74


def test_order_status_reads_back_executed_vs_queued(monkeypatch):
    """order_status finds the order in get_equity_orders and reports executed (filled) vs queued."""
    monkeypatch.setattr("app.agent_trading.brokers._log_place", lambda *a, **k: None)
    orders = {"data": {"orders": [
        {"id": "queued-1", "state": "unconfirmed", "cumulative_quantity": "0"},
        {"id": "done-1", "state": "filled", "cumulative_quantity": "5.0", "average_price": "18.74"}]}}
    broker = RobinhoodMCPBroker(account_number="test-agentic-001", mcp_client=lambda *a: orders, mode=MODE_LIVE)
    assert broker.order_status("done-1") == {
        "order_id": "done-1", "state": "filled", "executed": True,
        "filled_qty": 5.0, "avg_price": 18.74, "found": True}
    q = broker.order_status("queued-1")
    assert q["state"] == "unconfirmed" and q["executed"] is False and q["found"] is True
    assert broker.order_status("missing")["found"] is False   # not in the feed


ACCT = "test-agentic-001"  # placeholder — never a real account number


class FakeMCP:
    """Canned Robinhood Trading MCP using the live response shapes. Raises on write tools."""

    def __init__(self, *, positions=None, allow_writes=False):
        self.calls = []
        self.allow_writes = allow_writes
        self._positions = positions if positions is not None else [
            {"symbol": "NVDA", "quantity": "2", "average_buy_price": "120.00"}
        ]

    def __call__(self, tool, args):
        self.calls.append((tool, args))
        if tool in WRITE_TOOLS and not self.allow_writes:
            raise AssertionError(f"WRITE TOOL {tool} called when it must be blocked!")
        if tool == "get_accounts":
            return {"data": {"accounts": [
                {"account_number": "test-default-002", "agentic_allowed": False, "is_default": True},
                {"account_number": ACCT, "nickname": "Agentic", "agentic_allowed": True},
            ]}}
        if tool == "get_portfolio":
            return {"data": {"total_value": "500", "equity_value": "0", "cash": "500",
                             "buying_power": {"buying_power": "500.0000",
                                              "unleveraged_buying_power": "500.0000"}}}
        if tool == "get_equity_positions":
            return {"data": {"positions": self._positions}}
        if tool == "get_equity_quotes":
            return {"data": {"quotes": [{"symbol": "NVDA", "last_trade_price": "130.00"}]}}
        if tool == "review_equity_order":
            return {"data": {"warnings": [], "would_execute": True}}
        if tool == "place_equity_order":
            return {"data": {"filled_quantity": "1", "average_price": "130.00",
                             "filled_notional": "130.00"}}
        return {}

    def tools(self):
        return [t for t, _ in self.calls]


def _order():
    return ProposedOrder("NVDA", "buy", ref_price=130.0, notional=130.0)


# --------------------------------------------------------------------------- disarmed

def test_disarmed_blocks_reads_and_writes():
    b = RobinhoodMCPBroker(ACCT, FakeMCP())  # default disarmed
    for call in (b.ping, b.snapshot):
        with pytest.raises(BrokerError):
            call()
    with pytest.raises(BrokerError):
        b.place_order(_order())


# --------------------------------------------------------------------------- read-only

def test_read_only_snapshot_parses_live_account():
    mcp = FakeMCP()
    b = RobinhoodMCPBroker(ACCT, mcp, mode=MODE_READ_ONLY)
    state = b.snapshot()
    assert state.cash == 500.0                       # from get_portfolio
    assert state.positions["NVDA"].qty == 2.0
    assert state.positions["NVDA"].avg_price == 120.0
    assert state.prices["NVDA"] == 130.0             # from the quote
    assert state.total_value() == 500.0 + 2 * 130.0
    # snapshot used account_number, never account_id
    assert all("account_id" not in args for _, args in mcp.calls)


def test_read_only_allows_review_but_blocks_place():
    mcp = FakeMCP()
    b = RobinhoodMCPBroker(ACCT, mcp, mode=MODE_READ_ONLY)
    review = b.review_order(_order())                # simulate — allowed
    assert review["would_execute"] is True
    assert "review_equity_order" in mcp.tools()
    with pytest.raises(BrokerError):
        b.place_order(_order())                       # blocked before the client is called
    assert "place_equity_order" not in mcp.tools()    # write tool never invoked


def test_ping_and_find_agentic_account():
    b = RobinhoodMCPBroker(ACCT, FakeMCP(), mode=MODE_READ_ONLY)
    res = b.ping()
    assert res["ok"] and res["agentic_account_found"] and res["accounts"] == 2
    assert b.find_agentic_account() == ACCT          # picks the agentic_allowed one


# --------------------------------------------------------------------------- live

def test_live_allows_place_and_returns_fill():
    mcp = FakeMCP(allow_writes=True)
    b = RobinhoodMCPBroker(ACCT, mcp, mode=MODE_LIVE)
    fill = b.place_order(_order())
    assert fill.venue == "robinhood"
    assert fill.qty == 1.0 and fill.price == 130.0
    assert "place_equity_order" in mcp.tools()


def test_unknown_mode_rejected():
    with pytest.raises(ValueError):
        RobinhoodMCPBroker(ACCT, FakeMCP(), mode="yolo")


# --------------------------------------------------------------------------- schema pin

def test_parse_real_empty_account_payloads():
    """Exact shapes captured live: a funded-but-empty Agentic account."""
    portfolio = {"data": {"total_value": "500", "equity_value": "0", "cash": "500",
                          "buying_power": {"buying_power": "500.0000"}}}
    positions = {"data": {"positions": []}}
    state = parse_account_state(portfolio, positions, {})
    assert state.cash == 500.0
    assert state.positions == {}
    assert state.total_value() == 500.0


def test_parse_real_nested_quotes():
    """get_equity_quotes nests the price under results[].quote (captured live)."""
    from app.agent_trading.brokers import parse_quotes
    payload = {"data": {"results": [
        {"quote": {"symbol": "NVDA", "last_trade_price": "212.450000"}, "close": {"price": "205.19"}},
        {"quote": {"symbol": "F", "last_trade_price": "14.790000"}, "close": {"price": "14.84"}},
    ]}}
    q = parse_quotes(payload)
    assert q["NVDA"] == 212.45 and q["F"] == 14.79


def test_parse_account_state_defensive_fields():
    # flat buying_power string + alternate position field names still parse
    account = {"buying_power": "250.50"}
    positions = [
        {"ticker": "ROAR", "shares": "10", "average_buy_price": "9.00"},
        {"symbol": "HMNI", "quantity": "0", "average_cost": "25"},  # zero qty -> dropped
    ]
    state = parse_account_state(account, positions, {"ROAR": 11.0})
    assert state.cash == 250.5
    assert set(state.positions) == {"ROAR"}
    assert state.prices["ROAR"] == 11.0
