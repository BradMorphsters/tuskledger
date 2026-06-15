"""Tests for the order-lifecycle module: market hours, symbol validation, idempotency, fills."""
from __future__ import annotations

import datetime

from app.agent_trading.lifecycle import (
    ET,
    classify_fill,
    client_order_id,
    find_duplicates,
    is_market_open,
    market_session,
    validate_symbol,
)


def _et(y, m, d, hh, mm=0):
    return datetime.datetime(y, m, d, hh, mm, tzinfo=ET)


# --------------------------------------------------------------------------- market hours

def test_market_open_during_regular_hours():
    assert market_session(_et(2026, 6, 15, 10, 0)) == ("open", "regular trading hours")  # Mon
    assert is_market_open(_et(2026, 6, 15, 10, 0))


def test_market_closed_weekend_and_holiday():
    assert market_session(_et(2026, 6, 13, 11, 0))[0] == "closed"   # Saturday
    assert market_session(_et(2026, 6, 19, 11, 0)) == ("closed", "exchange holiday")  # Juneteenth (Fri)


def test_market_pre_and_after_hours():
    assert market_session(_et(2026, 6, 15, 9, 0))[0] == "pre_market"
    assert market_session(_et(2026, 6, 15, 16, 30))[0] == "closed"


# --------------------------------------------------------------------------- symbols

def test_valid_and_invalid_symbols():
    assert validate_symbol("AAPL")[0]
    assert validate_symbol("BRK.B")[0]
    assert not validate_symbol("aapl123")[0]
    assert not validate_symbol("")[0]
    assert not validate_symbol("TOOLONG")[0]
    ok, reason = validate_symbol("NVDA", tradable=False)
    assert not ok and "tradable" in reason


# --------------------------------------------------------------------------- idempotency

def test_client_order_id_is_deterministic():
    a = client_order_id("cyc-1", "NVDA", "buy", 0)
    b = client_order_id("cyc-1", "NVDA", "buy", 0)
    c = client_order_id("cyc-1", "NVDA", "buy", 1)
    assert a == b and a != c and a.startswith("tl-")


def test_find_duplicates_against_recent_orders():
    planned = [
        {"symbol": "NVDA", "side": "buy"},
        {"symbol": "F", "side": "buy"},
    ]
    recent = [{"symbol": "NVDA", "side": "buy", "state": "filled"}]
    dupes = find_duplicates(planned, recent)
    assert dupes == {0}          # NVDA already placed; F is new


# --------------------------------------------------------------------------- fills

def test_classify_fill_quantity():
    assert classify_fill(requested_qty=10, filled_qty=10)["status"] == "filled"
    p = classify_fill(requested_qty=10, filled_qty=4)
    assert p["status"] == "partial" and p["remaining_qty"] == 6
    assert classify_fill(requested_qty=10, filled_qty=0)["status"] == "unfilled"


def test_classify_fill_notional():
    assert classify_fill(requested_notional=80, filled_notional=80)["status"] == "filled"
    p = classify_fill(requested_notional=80, filled_notional=30)
    assert p["status"] == "partial" and p["remaining_notional"] == 50
