"""Tests for the real cross-account wash-sale check.

Drives the actual IRC §1091 engine (services/trading_tax.compute_realized_pnl) with
hand-built transaction histories, then confirms the guardrail gate blocks/warns on the
result. No DB — the rule is pure; the DB fetcher is a thin adapter exercised in the app.
"""
from __future__ import annotations

import datetime

from app.agent_trading import (
    AccountState,
    GuardrailConfig,
    ProposedOrder,
    check_order,
    assess_wash_sale,
    make_wash_sale_lookup,
)

TODAY = datetime.date(2026, 6, 15)


def _txn(days_ago, type_, qty, price):
    return {
        "date": TODAY - datetime.timedelta(days=days_ago),
        "plaid_security_id": "NVDA",
        "symbol": "NVDA",
        "type": type_,
        "quantity": qty,
        "price": price,
        "fees": 0.0,
    }


# --------------------------------------------------------------------------- pure rule

def test_buy_flagged_after_recent_loss_sale():
    # bought @150 (40d ago), sold @120 (10d ago) -> $30 realized loss within window
    txns = [_txn(40, "buy", 1, 150.0), _txn(10, "sell", 1, 120.0)]
    flagged, reason = assess_wash_sale("NVDA", "buy", txns, as_of=TODAY)
    assert flagged
    assert "§1091" in reason and "loss" in reason.lower()


def test_buy_not_flagged_after_recent_gain_sale():
    # bought @100, sold @150 -> a GAIN, no wash-sale concern
    txns = [_txn(40, "buy", 1, 100.0), _txn(10, "sell", 1, 150.0)]
    flagged, _ = assess_wash_sale("NVDA", "buy", txns, as_of=TODAY)
    assert not flagged


def test_buy_not_flagged_when_loss_sale_outside_window():
    # loss sale was 45 days ago -> outside the ±30d window
    txns = [_txn(80, "buy", 1, 150.0), _txn(45, "sell", 1, 120.0)]
    flagged, _ = assess_wash_sale("NVDA", "buy", txns, as_of=TODAY)
    assert not flagged


def test_sell_flagged_with_recent_purchase():
    # acquired 12 days ago -> selling now could be a wash if it closes at a loss
    txns = [_txn(12, "buy", 1, 120.0)]
    flagged, reason = assess_wash_sale("NVDA", "sell", txns, as_of=TODAY)
    assert flagged
    assert "§1091" in reason


def test_sell_not_flagged_without_recent_purchase():
    txns = [_txn(60, "buy", 1, 120.0)]
    flagged, _ = assess_wash_sale("NVDA", "sell", txns, as_of=TODAY)
    assert not flagged


# --------------------------------------------------------------------------- lookup + gate

def _seeded_lookup(txns):
    def fetch(symbol, since):
        return [t for t in txns if t["date"] >= since]
    return make_wash_sale_lookup(fetch, get_today=lambda: TODAY)


def _state():
    return AccountState(cash=1000.0, positions={}, prices={"NVDA": 120.0}, equity_peak=1000.0)


def test_gate_blocks_buy_when_configured_to_block():
    lookup = _seeded_lookup([_txn(40, "buy", 1, 150.0), _txn(10, "sell", 1, 120.0)])
    order = ProposedOrder("NVDA", "buy", ref_price=120.0, notional=50.0)
    res = check_order(order, _state(), GuardrailConfig(block_on_wash_sale=True), lookup)
    assert not res.ok
    assert any("§1091" in r or "wash" in r.lower() for r in res.reasons)


def test_gate_warns_buy_by_default():
    lookup = _seeded_lookup([_txn(40, "buy", 1, 150.0), _txn(10, "sell", 1, 120.0)])
    order = ProposedOrder("NVDA", "buy", ref_price=120.0, notional=50.0)
    res = check_order(order, _state(), GuardrailConfig(block_on_wash_sale=False), lookup)
    assert res.ok  # not blocking
    assert any("§1091" in w or "wash" in w.lower() for w in res.warnings)


def test_gate_clean_when_no_recent_loss():
    lookup = _seeded_lookup([_txn(40, "buy", 1, 100.0), _txn(10, "sell", 1, 150.0)])  # a gain
    order = ProposedOrder("NVDA", "buy", ref_price=120.0, notional=50.0)
    res = check_order(order, _state(), GuardrailConfig(block_on_wash_sale=True), lookup)
    assert res.ok
    assert not res.warnings
