"""Tests for the realized P&L + wash-sale calculator.

Bug here = real tax dollars wrong on a 1099-B reconciliation, so the
test surface is exhaustive: holding-period boundaries, FIFO matching
across multiple lots, wash-sale window edges, basis-roll-forward,
fee allocation, and the tax-savings-from-holding-to-LT helper.
"""
from __future__ import annotations

import datetime

from app.services.trading_tax import (
    LT_DAYS,
    WASH_WINDOW_DAYS,
    compute_realized_pnl,
    estimate_tax_owed,
    lt_savings_per_position,
)


def _txn(date, ttype, qty, price, sec_id="AAPL", txn_id=None, fees=0.0, symbol=None):
    """Compact factory for transaction dicts in test cases."""
    return {
        "date": date,
        "type": ttype,
        "quantity": qty,
        "price": price,
        "fees": fees,
        "plaid_security_id": sec_id,
        "symbol": symbol or sec_id,
        "plaid_investment_transaction_id": txn_id or f"{ttype}-{date.isoformat()}",
    }


D = datetime.date


# ─── Basic FIFO matching ─────────────────────────────────────────────


def test_simple_buy_then_sell_at_gain():
    """One buy, one sell, profit. Short-term."""
    txns = [
        _txn(D(2026, 1, 10), "buy", 10, 100.0),
        _txn(D(2026, 4, 1), "sell", 10, 120.0),
    ]
    r = compute_realized_pnl(txns)
    assert len(r["matches"]) == 1
    m = r["matches"][0]
    assert m.gain_loss == 200.0       # (120 - 100) * 10
    assert m.term == "ST"
    assert m.holding_period_days == 81
    assert r["summary"]["st_gain"] == 200.0
    assert r["summary"]["lt_gain"] == 0.0
    assert r["summary"]["wash_sale_disallowed"] == 0.0
    assert r["open_positions"] == []


def test_simple_buy_then_sell_at_loss():
    """One buy, one sell, loss. Short-term."""
    txns = [
        _txn(D(2026, 1, 10), "buy", 10, 100.0),
        _txn(D(2026, 2, 1), "sell", 10, 80.0),
    ]
    r = compute_realized_pnl(txns)
    assert r["matches"][0].gain_loss == -200.0
    assert r["summary"]["st_loss"] == -200.0
    assert r["summary"]["wash_sale_disallowed"] == 0.0   # no replacement buy


def test_partial_sell_leaves_open_lot():
    """Sell less than the buy quantity — remainder stays open."""
    txns = [
        _txn(D(2026, 1, 10), "buy", 10, 100.0),
        _txn(D(2026, 4, 1), "sell", 4, 120.0),
    ]
    r = compute_realized_pnl(txns, as_of=D(2026, 4, 1))
    assert r["matches"][0].quantity == 4
    assert r["matches"][0].gain_loss == 80.0
    # 6 shares remain open; no wash worries since the sell was a gain.
    assert len(r["open_positions"]) == 1
    p = r["open_positions"][0]
    assert p.quantity == 6
    assert p.cost_basis == 600.0


def test_oversell_is_silently_ignored():
    """Selling more than you own — conservative behavior is to ignore
    the un-covered portion rather than fabricate basis. Regression
    guard: a single bad row shouldn't crash the whole YTD computation."""
    txns = [
        _txn(D(2026, 1, 10), "buy", 5, 100.0),
        _txn(D(2026, 4, 1), "sell", 10, 120.0),
    ]
    r = compute_realized_pnl(txns)
    # Only 5 shares matched; the other 5 were dropped silently.
    assert sum(m.quantity for m in r["matches"]) == 5


# ─── Multi-lot FIFO ──────────────────────────────────────────────────


def test_fifo_across_multiple_lots():
    """Two buys at different prices, single sell consumes both.
    FIFO = first lot consumed first."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
        _txn(D(2026, 2, 1), "buy", 10, 110.0, txn_id="b2"),
        _txn(D(2026, 5, 1), "sell", 15, 120.0, txn_id="s1"),
    ]
    r = compute_realized_pnl(txns)
    # Two matches: 10 from b1 (gain $200), 5 from b2 (gain $50)
    assert len(r["matches"]) == 2
    m1, m2 = r["matches"]
    assert m1.quantity == 10 and m1.gain_loss == 200.0
    assert m2.quantity == 5 and m2.gain_loss == 50.0
    # Remaining 5 shares from b2 stay open.
    assert r["open_positions"][0].quantity == 5


def test_chronological_order_independent_of_input_order():
    """Transactions arrive out of order — should still match correctly."""
    txns = [
        _txn(D(2026, 5, 1), "sell", 10, 120.0),
        _txn(D(2026, 1, 1), "buy", 10, 100.0),
    ]
    r = compute_realized_pnl(txns)
    assert r["matches"][0].gain_loss == 200.0


# ─── Holding-period boundary (ST vs LT) ──────────────────────────────


def test_lt_boundary_at_366_days():
    """Holding > 365 days = LT. We use >= 366 as the strict boundary."""
    buy = D(2026, 1, 1)
    sell_at_lt = buy + datetime.timedelta(days=LT_DAYS)  # exactly 366 days
    sell_at_st = buy + datetime.timedelta(days=LT_DAYS - 1)
    # ST case
    r_st = compute_realized_pnl([
        _txn(buy, "buy", 10, 100.0, txn_id="b-st"),
        _txn(sell_at_st, "sell", 10, 120.0, txn_id="s-st"),
    ])
    assert r_st["matches"][0].term == "ST"
    # LT case (separate run with separate buy lot)
    r_lt = compute_realized_pnl([
        _txn(buy, "buy", 10, 100.0, txn_id="b-lt"),
        _txn(sell_at_lt, "sell", 10, 120.0, txn_id="s-lt"),
    ])
    assert r_lt["matches"][0].term == "LT"


# ─── Wash sale rule ──────────────────────────────────────────────────


def test_wash_sale_buy_after_sell_within_30_days():
    """Sell at a loss, buy back within 30 days → loss disallowed."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
        _txn(D(2026, 3, 1), "sell", 10, 80.0, txn_id="s1"),    # $200 loss
        _txn(D(2026, 3, 15), "buy", 10, 85.0, txn_id="b2"),    # 14 days later — wash!
    ]
    r = compute_realized_pnl(txns)
    m = r["matches"][0]
    assert m.gain_loss == -200.0
    assert m.wash_sale_disallowed == 200.0
    assert r["summary"]["wash_sale_disallowed"] == 200.0
    # The $200 disallowed loss rolls into b2's basis. b2 is still open
    # (10 shares at $85 + $200 disallowed adjustment = effective basis $1050).
    p = r["open_positions"][0]
    assert p.cost_basis == 1050.0


def test_wash_sale_buy_BEFORE_sell_within_30_days():
    """Wash rule applies to buys 30 days BEFORE the sell too. Common
    scenario: doubling down on a losing position then closing the
    original lot — IRS still disallows the loss."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
        _txn(D(2026, 2, 25), "buy", 10, 95.0, txn_id="b2"),    # 4 days before sell
        _txn(D(2026, 3, 1), "sell", 10, 80.0, txn_id="s1"),    # closes b1 at $200 loss
    ]
    r = compute_realized_pnl(txns)
    # First match consumes b1 (FIFO) → loss
    m = r["matches"][0]
    assert m.gain_loss == -200.0
    # b2 was bought 4 days earlier → wash sale
    assert m.wash_sale_disallowed == 200.0


def test_no_wash_sale_outside_window():
    """Replacement buy 31 days later — outside the window. Loss allowed."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
        _txn(D(2026, 3, 1), "sell", 10, 80.0, txn_id="s1"),
        _txn(D(2026, 4, 5), "buy", 10, 85.0, txn_id="b2"),    # 35 days later
    ]
    r = compute_realized_pnl(txns)
    assert r["matches"][0].wash_sale_disallowed == 0.0


def test_no_wash_on_gain_match():
    """Wash rule only triggers on losses. A gain with a replacement
    buy in the window is a normal taxable gain."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
        _txn(D(2026, 3, 1), "sell", 10, 120.0, txn_id="s1"),  # GAIN, not loss
        _txn(D(2026, 3, 15), "buy", 10, 115.0, txn_id="b2"),
    ]
    r = compute_realized_pnl(txns)
    m = r["matches"][0]
    assert m.gain_loss == 200.0
    assert m.wash_sale_disallowed == 0.0


def test_wash_sale_window_edge_exactly_30_days():
    """Buy exactly 30 days after sell — INSIDE the window per IRS
    (the rule says 'during the 61-day period')."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
        _txn(D(2026, 3, 1), "sell", 10, 80.0, txn_id="s1"),
        _txn(D(2026, 3, 31), "buy", 10, 85.0, txn_id="b2"),  # exactly 30 days
    ]
    r = compute_realized_pnl(txns)
    assert r["matches"][0].wash_sale_disallowed == 200.0


# ─── Fee allocation ──────────────────────────────────────────────────


def test_buy_fees_increase_basis():
    """A $5 fee on a 10-share buy adds $0.50 per share to basis."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, fees=5.0),
        _txn(D(2026, 4, 1), "sell", 10, 120.0),
    ]
    r = compute_realized_pnl(txns)
    # Cost basis = 1000 + 5 fees = 1005
    assert r["matches"][0].basis == 1005.0
    assert r["matches"][0].gain_loss == 195.0


def test_sell_fees_reduce_proceeds():
    """A $5 fee on a 10-share sell reduces proceeds by $5."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0),
        _txn(D(2026, 4, 1), "sell", 10, 120.0, fees=5.0),
    ]
    r = compute_realized_pnl(txns)
    # Proceeds = 1200 - 5 = 1195
    assert r["matches"][0].proceeds == 1195.0
    assert r["matches"][0].gain_loss == 195.0


# ─── Different securities don't cross-contaminate ────────────────────


def test_separate_symbols_have_independent_lots():
    """A buy of MSFT shouldn't trigger a wash sale on a loss in AAPL."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, sec_id="AAPL", txn_id="a1"),
        _txn(D(2026, 3, 1), "sell", 10, 80.0, sec_id="AAPL", txn_id="a2"),
        _txn(D(2026, 3, 10), "buy", 10, 200.0, sec_id="MSFT", txn_id="m1"),  # different sec
    ]
    r = compute_realized_pnl(txns)
    assert r["matches"][0].wash_sale_disallowed == 0.0


# ─── Aggregate summary ───────────────────────────────────────────────


def test_summary_st_lt_split():
    """Mix of ST and LT trades — summary buckets each correctly."""
    buy_lt = D(2024, 1, 1)
    sell_lt = D(2026, 1, 5)  # 2 years later → LT
    buy_st = D(2026, 1, 1)
    sell_st = D(2026, 4, 1)  # 90 days → ST
    txns = [
        _txn(buy_lt, "buy", 10, 100.0, sec_id="AAPL", txn_id="lt-b"),
        _txn(sell_lt, "sell", 10, 150.0, sec_id="AAPL", txn_id="lt-s"),
        _txn(buy_st, "buy", 10, 100.0, sec_id="MSFT", txn_id="st-b"),
        _txn(sell_st, "sell", 10, 120.0, sec_id="MSFT", txn_id="st-s"),
    ]
    r = compute_realized_pnl(txns)
    assert r["summary"]["lt_gain"] == 500.0
    assert r["summary"]["st_gain"] == 200.0
    assert r["summary"]["net_realized"] == 700.0


# ─── Open-position metadata ──────────────────────────────────────────


def test_open_position_lt_countdown():
    """An open lot bought 100 days ago has 266 days until LT."""
    buy_date = D(2026, 1, 1)
    as_of = D(2026, 4, 11)  # 100 days later
    txns = [_txn(buy_date, "buy", 10, 100.0)]
    r = compute_realized_pnl(txns, as_of=as_of)
    p = r["open_positions"][0]
    assert p.days_held_so_far == 100
    assert p.days_until_lt == LT_DAYS - 100
    assert p.is_long_term is False


def test_open_position_already_long_term():
    """Lot bought >1yr ago — countdown = 0, is_long_term = True."""
    buy_date = D(2024, 1, 1)
    as_of = D(2026, 4, 1)
    txns = [_txn(buy_date, "buy", 10, 100.0)]
    r = compute_realized_pnl(txns, as_of=as_of)
    p = r["open_positions"][0]
    assert p.is_long_term is True
    assert p.days_until_lt == 0


# ─── Tax estimation ──────────────────────────────────────────────────


def test_estimate_tax_st_gain_only():
    summary = {"st_net": 5000.0, "lt_net": 0.0}
    t = estimate_tax_owed(summary, ordinary_marginal_rate=0.22, state_rate=0.0425)
    assert t["st_tax_federal"] == 1100.0
    assert t["st_tax_state"] == 212.5
    assert t["estimated_tax_total"] == 1312.5


def test_estimate_tax_st_gain_offset_by_lt_loss():
    """ST gain + LT loss should net before tax computation per IRS rules."""
    summary = {"st_net": 5000.0, "lt_net": -2000.0}
    t = estimate_tax_owed(summary)
    # After offset: st_net = 3000, lt_net = 0
    # Tax on $3000 ST at 22% + 4.25% = $787.50
    assert t["estimated_tax_total"] == 787.5


def test_estimate_tax_net_loss_caps_at_3000_for_ordinary_offset():
    """Net loss > $3k — only $3k offsets ordinary; the rest carries forward."""
    summary = {"st_net": -5000.0, "lt_net": 0.0}
    t = estimate_tax_owed(summary, ordinary_marginal_rate=0.22, state_rate=0.0425)
    # $3,000 deductible loss × 26.25% combined rate ≈ -$787.50 (a refund)
    assert t["estimated_tax_total"] == round(-3000 * 0.2625, 2)
    assert t["carryover_to_next_year"] == -2000.0  # the un-deducted $2k


# ─── lt_savings_per_position ─────────────────────────────────────────


def test_lt_savings_picks_highest_leverage_first():
    """Open positions sorted by tax-savings-from-holding desc."""
    from app.services.trading_tax import OpenPosition
    open_positions = [
        OpenPosition(
            symbol="LOW", plaid_security_id="LOW", account_id=1, quantity=10, cost_basis=1000, avg_cost_per_share=100,
            earliest_buy_date=D(2026, 1, 1), days_held_so_far=200,
            days_until_lt=166, is_long_term=False,
        ),
        OpenPosition(
            symbol="BIG", plaid_security_id="BIG", account_id=1, quantity=10, cost_basis=1000, avg_cost_per_share=100,
            earliest_buy_date=D(2026, 1, 1), days_held_so_far=300,
            days_until_lt=66, is_long_term=False,
        ),
    ]
    prices = {"LOW": 105, "BIG": 200}  # BIG has way more unrealized gain
    out = lt_savings_per_position(open_positions, prices)
    assert out[0]["symbol"] == "BIG"
    assert out[0]["savings_from_holding"] > out[1]["savings_from_holding"]


def test_lt_savings_skips_already_long_term_positions():
    from app.services.trading_tax import OpenPosition
    open_positions = [OpenPosition(
        symbol="OLD", plaid_security_id="OLD", account_id=1, quantity=10, cost_basis=1000, avg_cost_per_share=100,
        earliest_buy_date=D(2024, 1, 1), days_held_so_far=500,
        days_until_lt=0, is_long_term=True,
    )]
    out = lt_savings_per_position(open_positions, {"OLD": 200})
    assert out == []


def test_lt_savings_skips_positions_at_loss():
    """No tax-savings opportunity if the position is currently underwater."""
    from app.services.trading_tax import OpenPosition
    open_positions = [OpenPosition(
        symbol="DOWN", plaid_security_id="DOWN", account_id=1, quantity=10, cost_basis=1000, avg_cost_per_share=100,
        earliest_buy_date=D(2026, 1, 1), days_held_so_far=100,
        days_until_lt=266, is_long_term=False,
    )]
    out = lt_savings_per_position(open_positions, {"DOWN": 80})  # underwater
    assert out == []


# ─── Skip-types defensiveness ────────────────────────────────────────


def test_dividend_and_fee_transactions_ignored():
    """Only buy/sell types should affect P&L. Dividends, fees, transfers
    pass through without contributing matches."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0),
        {"date": D(2026, 2, 1), "type": "dividend", "quantity": 0.5,
         "price": 0.10, "plaid_security_id": "AAPL", "fees": 0,
         "plaid_investment_transaction_id": "div-1"},
        _txn(D(2026, 4, 1), "sell", 10, 120.0),
    ]
    r = compute_realized_pnl(txns)
    assert len(r["matches"]) == 1
    assert r["matches"][0].gain_loss == 200.0


def test_zero_quantity_or_zero_price_skipped():
    """Defensive — bad data shouldn't crash."""
    txns = [
        {"date": D(2026, 1, 1), "type": "buy", "quantity": 0, "price": 100,
         "plaid_security_id": "AAPL", "plaid_investment_transaction_id": "x"},
        _txn(D(2026, 1, 2), "buy", 10, 100.0),
        _txn(D(2026, 4, 1), "sell", 10, 120.0),
    ]
    r = compute_realized_pnl(txns)
    assert len(r["matches"]) == 1
    assert r["matches"][0].gain_loss == 200.0


def test_empty_transaction_list():
    r = compute_realized_pnl([])
    assert r["matches"] == []
    assert r["open_positions"] == []
    assert r["summary"]["net_realized"] == 0.0


# ─── simulate_hypothetical_sell ──────────────────────────────────────


from app.services.trading_tax import simulate_hypothetical_sell


def test_preflight_clean_gain_sell():
    """No prior wash-risk, modest tax — should recommend 'proceed'."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
    ]
    r = simulate_hypothetical_sell(
        transactions=txns,
        plaid_security_id="AAPL",
        quantity=10,
        price=110.0,
        sell_date=D(2026, 4, 1),
    )
    assert r["wash_sale_triggered"] is False
    assert r["delta"]["st_added"] == 100.0   # (110 - 100) * 10
    assert r["delta"]["lt_added"] == 0.0
    assert r["recommendation"] == "proceed"
    assert "Routine" in r["recommendation_note"] or "loss" in r["recommendation_note"]


def test_preflight_wash_sale_triggers_avoid():
    """Sell at loss with a buy in the past 30 days → wash → 'avoid'."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
        _txn(D(2026, 3, 20), "buy", 10, 90.0, txn_id="b2"),  # 12 days before sell
    ]
    r = simulate_hypothetical_sell(
        transactions=txns,
        plaid_security_id="AAPL",
        quantity=10,
        price=80.0,    # selling lot 1 at a $200 loss
        sell_date=D(2026, 4, 1),
    )
    assert r["wash_sale_triggered"] is True
    assert r["delta"]["wash_sale_added"] == 200.0
    assert r["recommendation"] == "avoid"
    assert "wash sale" in r["recommendation_note"].lower()


def test_preflight_close_to_lt_recommends_caution():
    """ST gain on a lot 350 days old (16 days from LT) → 'caution'."""
    buy_date = D(2025, 4, 1)
    sell_date = buy_date + datetime.timedelta(days=350)
    txns = [_txn(buy_date, "buy", 10, 100.0, txn_id="b1")]
    r = simulate_hypothetical_sell(
        transactions=txns,
        plaid_security_id="AAPL",
        quantity=10,
        price=120.0,
        sell_date=sell_date,
    )
    assert r["recommendation"] == "caution"
    assert "long-term" in r["recommendation_note"].lower()


def test_preflight_large_tax_hit_recommends_caution():
    """Big absolute tax adds → caution about quarterly estimated payments."""
    # 100 shares bought at $100, selling at $250 = $15k ST gain ≈ $4k tax.
    txns = [_txn(D(2026, 1, 1), "buy", 100, 100.0, txn_id="b1")]
    r = simulate_hypothetical_sell(
        transactions=txns,
        plaid_security_id="AAPL",
        quantity=100,
        price=250.0,
        sell_date=D(2026, 5, 1),  # well past the LT-close window
    )
    assert r["recommendation"] == "caution"
    assert "quarterly" in r["recommendation_note"].lower() or "underpayment" in r["recommendation_note"].lower()


def test_preflight_loss_with_no_wash_recommends_proceed_for_tlh():
    """Loss with no replacement buy → useful for tax-loss harvesting."""
    txns = [_txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1")]
    r = simulate_hypothetical_sell(
        transactions=txns,
        plaid_security_id="AAPL",
        quantity=10,
        price=80.0,
        sell_date=D(2026, 5, 1),
    )
    assert r["wash_sale_triggered"] is False
    assert r["recommendation"] == "proceed"
    assert "harvest" in r["recommendation_note"].lower() or "loss" in r["recommendation_note"].lower()


def test_preflight_baseline_unchanged_by_hypothetical():
    """Sanity check: the baseline summary in the response must reflect
    the state BEFORE the hypothetical sell — same as compute_realized_pnl
    on the unmodified transaction list. Bug-class: a future refactor
    that mutates the input list would silently double-count."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
        _txn(D(2026, 3, 1), "sell", 10, 130.0, txn_id="s1"),
    ]
    baseline_alone = compute_realized_pnl(txns, as_of=D(2026, 4, 1))
    r = simulate_hypothetical_sell(
        transactions=txns,
        plaid_security_id="MSFT",  # different symbol — shouldn't affect AAPL math
        quantity=5,
        price=200.0,
        sell_date=D(2026, 4, 1),
    )
    assert r["baseline"]["summary"]["st_gain"] == baseline_alone["summary"]["st_gain"]
    assert r["baseline"]["summary"]["net_realized"] == baseline_alone["summary"]["net_realized"]


def test_preflight_delta_isolates_only_hypothetical_matches():
    """The delta should reflect ONLY the new sell's impact, not prior
    realized activity. Verify by comparing to the absolute summary diff."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, sec_id="AAPL", txn_id="b1"),
        _txn(D(2026, 2, 1), "buy", 10, 100.0, sec_id="MSFT", txn_id="b2"),
        _txn(D(2026, 3, 1), "sell", 10, 130.0, sec_id="AAPL", txn_id="s1"),
    ]
    r = simulate_hypothetical_sell(
        transactions=txns,
        plaid_security_id="MSFT",
        quantity=10,
        price=120.0,    # $200 ST gain
        sell_date=D(2026, 4, 1),
    )
    # Baseline already had $300 ST gain from the AAPL sell; hypothetical
    # adds $200 of MSFT ST gain. Delta should be +$200, not +$500.
    assert r["delta"]["st_added"] == 200.0
    # Total tax should also reflect only the hypothetical's contribution.
    expected_tax_delta = round(200.0 * (0.22 + 0.0425), 2)
    assert r["delta"]["tax_added"] == expected_tax_delta


# ─── Multi-account scenarios (cross-account wash + per-account FIFO) ──


def _txn_a(date, ttype, qty, price, account_id, sec_id="AAPL", txn_id=None):
    """Like _txn but with explicit account_id."""
    t = _txn(date, ttype, qty, price, sec_id=sec_id, txn_id=txn_id)
    t["account_id"] = account_id
    return t


def test_multi_account_per_account_fifo():
    """Two accounts each with their own AAPL lots — FIFO matches happen
    within each account, not across them. A sell in account 1 must NOT
    consume lots from account 2."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 10, 100.0, account_id=1, txn_id="acct1-b1"),
        _txn_a(D(2026, 1, 5), "buy", 10, 50.0, account_id=2, txn_id="acct2-b1"),  # cheaper lot in different account
        _txn_a(D(2026, 4, 1), "sell", 10, 120.0, account_id=1, txn_id="acct1-s1"),
    ]
    r = compute_realized_pnl(txns)
    # Sell in account 1 must consume account 1's lot ($100 basis), not
    # the cheaper account 2 lot ($50 basis). Gain = ($120-$100)*10 = $200.
    assert len(r["matches"]) == 1
    assert r["matches"][0].gain_loss == 200.0
    assert r["matches"][0].account_id == 1
    # Account 2's 10-share lot is still open.
    assert any(p.account_id == 2 and p.quantity == 10 for p in r["open_positions"])


def test_multi_account_cross_account_wash_sale():
    """Sell at loss in account 1, buy back in account 2 within 30 days.
    IRS §1091 applies per taxpayer → wash sale must trigger."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 10, 100.0, account_id=1, txn_id="acct1-b1"),
        _txn_a(D(2026, 3, 1), "sell", 10, 80.0, account_id=1, txn_id="acct1-s1"),  # $200 loss in acct 1
        _txn_a(D(2026, 3, 15), "buy", 10, 85.0, account_id=2, txn_id="acct2-b1"),  # 14 days later in DIFFERENT account
    ]
    r = compute_realized_pnl(txns)
    m = r["matches"][0]
    assert m.gain_loss == -200.0
    assert m.wash_sale_disallowed == 200.0
    # Cross-account marker set so the UI can flag this specially.
    assert m.wash_sale_replacement_account_id == 2
    # The disallowed loss rolls into account 2's open lot's basis.
    acct2_pos = next(p for p in r["open_positions"] if p.account_id == 2)
    assert acct2_pos.cost_basis == 1050.0  # 10 × $85 + $200 disallowed


def test_multi_account_same_account_wash_sets_no_cross_marker():
    """When the wash-sale replacement is in the SAME account as the loss,
    wash_sale_replacement_account_id stays None — only set when cross."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 10, 100.0, account_id=1, txn_id="b1"),
        _txn_a(D(2026, 3, 1), "sell", 10, 80.0, account_id=1, txn_id="s1"),
        _txn_a(D(2026, 3, 15), "buy", 10, 85.0, account_id=1, txn_id="b2"),
    ]
    r = compute_realized_pnl(txns)
    m = r["matches"][0]
    assert m.wash_sale_disallowed == 200.0
    assert m.wash_sale_replacement_account_id is None  # same-account = not cross


def test_multi_account_open_positions_separated_per_account():
    """Same security held in two accounts → two separate OpenPosition
    rows so users see per-account holdings (matches 1099-B reporting)."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 10, 100.0, account_id=1, sec_id="AAPL"),
        _txn_a(D(2026, 1, 2), "buy", 5, 200.0, account_id=2, sec_id="AAPL"),
    ]
    r = compute_realized_pnl(txns)
    aapl_positions = [p for p in r["open_positions"] if p.plaid_security_id == "AAPL"]
    assert len(aapl_positions) == 2
    accts = {p.account_id for p in aapl_positions}
    assert accts == {1, 2}


def test_multi_account_no_account_id_falls_back_to_legacy_grouping():
    """Backwards compat: transactions without account_id share the
    same (None, sec_id) bucket — preserves the original behavior for
    callers that don't track accounts."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0),
        _txn(D(2026, 4, 1), "sell", 10, 120.0),
    ]
    r = compute_realized_pnl(txns)
    assert len(r["matches"]) == 1
    assert r["matches"][0].gain_loss == 200.0
    assert r["matches"][0].account_id is None


# ─── Wash-sale scope toggle (IRS-correct vs broker-style) ────────────


from app.services.trading_tax import WASH_SCOPE_ALL_ACCOUNTS, WASH_SCOPE_PER_ACCOUNT


def test_wash_scope_all_accounts_catches_cross_account():
    """Default scope = IRS rule = catches cross-account washes."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 10, 100.0, account_id=1, txn_id="b1"),
        _txn_a(D(2026, 3, 1), "sell", 10, 80.0, account_id=1, txn_id="s1"),
        _txn_a(D(2026, 3, 15), "buy", 10, 85.0, account_id=2, txn_id="b2"),  # cross-account
    ]
    r = compute_realized_pnl(txns, wash_sale_scope=WASH_SCOPE_ALL_ACCOUNTS)
    assert r["matches"][0].wash_sale_disallowed == 200.0


def test_wash_scope_per_account_skips_cross_account():
    """Per-account scope (broker-style) ignores buys in other accounts."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 10, 100.0, account_id=1, txn_id="b1"),
        _txn_a(D(2026, 3, 1), "sell", 10, 80.0, account_id=1, txn_id="s1"),
        _txn_a(D(2026, 3, 15), "buy", 10, 85.0, account_id=2, txn_id="b2"),  # different account
    ]
    r = compute_realized_pnl(txns, wash_sale_scope=WASH_SCOPE_PER_ACCOUNT)
    # No wash because the replacement buy was in a different account
    # and we're only looking within account 1.
    assert r["matches"][0].wash_sale_disallowed == 0.0


def test_wash_scope_per_account_still_catches_same_account():
    """Per-account scope must still catch same-account washes — the
    toggle only ignores CROSS-account replacements, not all of them."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 10, 100.0, account_id=1, txn_id="b1"),
        _txn_a(D(2026, 3, 1), "sell", 10, 80.0, account_id=1, txn_id="s1"),
        _txn_a(D(2026, 3, 15), "buy", 10, 85.0, account_id=1, txn_id="b2"),  # same account
    ]
    r = compute_realized_pnl(txns, wash_sale_scope=WASH_SCOPE_PER_ACCOUNT)
    assert r["matches"][0].wash_sale_disallowed == 200.0


# ─── Wash-sale scope: 'selected_accounts' (bounded IRS) ──────────────


from app.services.trading_tax import WASH_SCOPE_SELECTED


def test_wash_scope_selected_includes_replacement_in_set():
    """Selected scope = scan only the user's chosen account set.
    A wash with a replacement in one of the SELECTED accounts must fire."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 10, 100.0, account_id=1, txn_id="b1"),
        _txn_a(D(2026, 3, 1), "sell", 10, 80.0, account_id=1, txn_id="s1"),
        _txn_a(D(2026, 3, 15), "buy", 10, 85.0, account_id=2, txn_id="b2"),  # in selected set
    ]
    r = compute_realized_pnl(
        txns,
        wash_sale_scope=WASH_SCOPE_SELECTED,
        wash_sale_account_ids={1, 2},
    )
    assert r["matches"][0].wash_sale_disallowed == 200.0


def test_wash_scope_selected_excludes_replacement_outside_set():
    """A wash with a replacement OUTSIDE the selected set is NOT flagged.
    This is the 'just my Robinhood accounts' use case — the user wants
    to ignore washes that involve a Fidelity buy when they're scoped
    to Robinhood-only."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 10, 100.0, account_id=1, txn_id="b1"),
        _txn_a(D(2026, 3, 1), "sell", 10, 80.0, account_id=1, txn_id="s1"),
        _txn_a(D(2026, 3, 15), "buy", 10, 85.0, account_id=99, txn_id="b2"),  # OUTSIDE set
    ]
    r = compute_realized_pnl(
        txns,
        wash_sale_scope=WASH_SCOPE_SELECTED,
        wash_sale_account_ids={1, 2},  # 99 not included
    )
    assert r["matches"][0].wash_sale_disallowed == 0.0


def test_wash_scope_selected_with_no_set_falls_back_to_all_accounts():
    """If the user picks 'selected' but provides no account_ids, fall
    back to ALL_ACCOUNTS behavior — defensive default."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 10, 100.0, account_id=1, txn_id="b1"),
        _txn_a(D(2026, 3, 1), "sell", 10, 80.0, account_id=1, txn_id="s1"),
        _txn_a(D(2026, 3, 15), "buy", 10, 85.0, account_id=99, txn_id="b2"),
    ]
    r = compute_realized_pnl(
        txns,
        wash_sale_scope=WASH_SCOPE_SELECTED,
        wash_sale_account_ids=None,
    )
    # No selection → behave like all_accounts → catches the cross-account wash
    assert r["matches"][0].wash_sale_disallowed == 200.0


# ─── Inter-account transfer reconciliation ──────────────────────────


def test_inter_account_transfer_reconciles_oversell():
    """Sell oversells in account A, account B has open shares of the
    same security → pull from B to satisfy the sell. Models the
    'transferred shares between accounts then sold them' case where
    Plaid doesn't emit a clean transfer event (the COPX scenario).
    """
    txns = [
        # Account 1: bought 100, sold 100 (fully closed locally).
        _txn_a(D(2026, 1, 1), "buy", 100, 80.0, account_id=1, txn_id="b1"),
        # Account 2: bought 200, sold 300 (oversold by 100).
        _txn_a(D(2026, 1, 5), "buy", 200, 90.0, account_id=2, txn_id="b2"),
        _txn_a(D(2026, 3, 1), "sell", 300, 100.0, account_id=2, txn_id="s2"),
    ]
    r = compute_realized_pnl(txns)
    # Account 2 originally consumed its own 200 shares + pulled 100 from account 1.
    # Total matched quantity = 300 (the full sell).
    total_matched = sum(m.quantity for m in r["matches"])
    assert abs(total_matched - 300) < 1e-6
    # Net open across all accounts should be 0 (everything closed).
    total_open = sum(p.quantity for p in r["open_positions"])
    assert total_open == 0


def test_inter_account_transfer_preserves_account_attribution():
    """When shares are pulled from account B to satisfy a sell in
    account A, the resulting Match's account_id should be A (where
    the tax event lands). The buy_txn_id preserves the link to B's lot."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 100, 80.0, account_id=1, txn_id="b1-acct1"),
        _txn_a(D(2026, 3, 1), "sell", 100, 100.0, account_id=2, txn_id="s2-acct2"),
    ]
    r = compute_realized_pnl(txns)
    # Cross-account match: sell is in account 2, source lot is in account 1.
    cross_matches = [m for m in r["matches"] if m.account_id == 2]
    assert len(cross_matches) == 1
    m = cross_matches[0]
    assert m.account_id == 2  # tax event in account 2
    assert m.buy_txn_id == "b1-acct1"  # source from account 1's lot
    assert m.gain_loss == 2000.0  # ($100 - $80) × 100


def test_partial_inter_account_pull_when_insufficient():
    """Oversell exceeds combined open shares — pull what's available,
    drop the rest silently. Defense against the data-error case."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 50, 80.0, account_id=1, txn_id="b1"),
        # Account 2 oversells by 100: bought 0, sold 100. Only 50 available
        # to pull from account 1.
        _txn_a(D(2026, 3, 1), "sell", 100, 100.0, account_id=2, txn_id="s2"),
    ]
    r = compute_realized_pnl(txns)
    # 50 shares consumed cross-account; the other 50 silently dropped.
    total_matched = sum(m.quantity for m in r["matches"])
    assert abs(total_matched - 50) < 1e-6


def test_inter_account_pull_does_not_fire_when_local_lots_available():
    """Sanity: when the selling account has its own lots, those are
    consumed first. Cross-account pull only fires after local lots
    are exhausted (preserves per-account 1099-B reconciliation in
    the normal case)."""
    txns = [
        _txn_a(D(2026, 1, 1), "buy", 100, 80.0, account_id=1, txn_id="b1"),
        _txn_a(D(2026, 1, 5), "buy", 100, 90.0, account_id=2, txn_id="b2"),
        # Account 2 sells 50 — should consume from its OWN lot (b2),
        # not from account 1's older cheaper lot.
        _txn_a(D(2026, 3, 1), "sell", 50, 100.0, account_id=2, txn_id="s2"),
    ]
    r = compute_realized_pnl(txns)
    assert len(r["matches"]) == 1
    m = r["matches"][0]
    assert m.buy_txn_id == "b2"  # account 2's own lot
    assert m.basis == 4500.0    # 50 × $90 (account 2's price), not 50 × $80


# ─── Wash-sale chain propagation (the v2 chronological pass) ────────


def test_chain_propagation_two_link_basis_inflates_downstream_match():
    """The headline test for the v2 algorithm: a wash sale's disallowed
    loss should inflate the basis of the replacement lot, and when
    that lot is later sold, the inflated basis must show up in the
    downstream match's gain_loss. This is the case the OLD pass-2
    wash detection couldn't handle (basis adjustment was set on
    consumed lots that never re-entered matching)."""
    txns = [
        # Buy 100 @ $100 = $10,000 basis
        _txn(D(2026, 1, 1), "buy", 100, 100.0, txn_id="b1"),
        # Sell at $80 = $200 loss on each share, $2,000 total loss
        _txn(D(2026, 2, 1), "sell", 100, 80.0, txn_id="s1"),
        # Replacement buy 14 days later → washes the loss
        _txn(D(2026, 2, 15), "buy", 100, 85.0, txn_id="b2"),
        # Final sell at $90 → SHOULD reflect inflated basis
        # Raw gain = ($90 - $85) × 100 = $500
        # Inflated basis = $85 + ($2,000 disallowed / 100 shares) = $105/sh
        # Reported gain/loss = ($90 - $105) × 100 = -$1,500 LOSS
        _txn(D(2026, 5, 1), "sell", 100, 90.0, txn_id="s2"),
    ]
    r = compute_realized_pnl(txns)
    # Two matches: s1 (washed loss) + s2 (downstream match with inflated basis)
    assert len(r["matches"]) == 2
    s1_match = next(m for m in r["matches"] if m.sell_txn_id == "s1")
    s2_match = next(m for m in r["matches"] if m.sell_txn_id == "s2")
    # s1 was washed → wash_sale_disallowed = $2,000
    assert s1_match.wash_sale_disallowed == 2000.0
    # s2 should reflect the inflated basis: $10,500 not $8,500
    # gain_loss = $9,000 proceeds - $10,500 basis = -$1,500
    assert s2_match.basis == 10500.0, f"Expected $10,500 basis, got {s2_match.basis}"
    assert s2_match.gain_loss == -1500.0, f"Expected -$1,500 gain/loss, got {s2_match.gain_loss}"


def test_chain_terminates_when_no_subsequent_buy():
    """If the final sell in a chain has no subsequent buy within 30
    days, the cumulative disallowed loss CAPTURES via the inflated
    basis. The summary's st_loss should reflect the captured amount."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 100, 100.0, txn_id="b1"),
        _txn(D(2026, 2, 1), "sell", 100, 80.0, txn_id="s1"),     # loss $2k, washed
        _txn(D(2026, 2, 15), "buy", 100, 85.0, txn_id="b2"),     # replacement
        _txn(D(2026, 5, 1), "sell", 100, 90.0, txn_id="s2"),     # downstream sell, no further buys
    ]
    r = compute_realized_pnl(txns)
    # The downstream s2 match shows -$1,500 loss (inflated basis captured).
    # That loss is NOT washed (no subsequent buy within 30 days).
    # → st_loss should reflect -$1,500.
    assert r["summary"]["st_loss"] == -1500.0, f"Expected -$1,500 st_loss, got {r['summary']['st_loss']}"
    # st_gain stays $0 (s2 was a loss after adjustment, s1 was a wash).
    assert r["summary"]["st_gain"] == 0.0
    assert r["summary"]["st_net"] == -1500.0


def test_three_link_chain_full_capture():
    """Three-link chain: A loss → B replacement → B sell loss → C
    replacement → C sell gain. The final sell terminates the chain
    cleanly. Verifies the chain propagates through multiple links."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 100, 100.0, txn_id="bA"),
        _txn(D(2026, 1, 15), "sell", 100, 90.0, txn_id="sA"),    # -$1,000 loss
        _txn(D(2026, 1, 20), "buy", 100, 85.0, txn_id="bB"),     # washes sA
        _txn(D(2026, 2, 5), "sell", 100, 80.0, txn_id="sB"),     # raw -$500, w/ rolled $1k = -$1,500 loss
        _txn(D(2026, 2, 10), "buy", 100, 75.0, txn_id="bC"),     # washes sB
        _txn(D(2026, 5, 1), "sell", 100, 95.0, txn_id="sC"),     # raw +$2,000, w/ rolled $1.5k = +$500
    ]
    r = compute_realized_pnl(txns)
    # Three sell matches.
    assert len(r["matches"]) == 3
    sA = next(m for m in r["matches"] if m.sell_txn_id == "sA")
    sB = next(m for m in r["matches"] if m.sell_txn_id == "sB")
    sC = next(m for m in r["matches"] if m.sell_txn_id == "sC")
    # sA washed by bB.
    assert sA.wash_sale_disallowed == 1000.0
    # sB consumed bB, basis = $85 + $10/sh from rolled $1k = $95/sh
    # sB at $80 = -$1,500 loss (raw price diff $5/sh × 100 = $500, plus rolled $1k = $1,500).
    assert sB.basis == 9500.0, f"sB basis should be $9,500, got {sB.basis}"
    assert sB.gain_loss == -1500.0, f"sB gain_loss should be -$1,500, got {sB.gain_loss}"
    # sB washed by bC → disallowed $1,500 rolled into bC.
    assert sB.wash_sale_disallowed == 1500.0
    # sC consumed bC. basis = $75 + $15/sh rolled = $90/sh.
    # sC at $95 = +$500 gain.
    assert sC.basis == 9000.0, f"sC basis should be $9,000, got {sC.basis}"
    assert sC.gain_loss == 500.0, f"sC gain_loss should be +$500, got {sC.gain_loss}"
    # sC is a gain, no wash applies.
    assert sC.wash_sale_disallowed == 0.0
    # Final summary: st_gain $500 from sC, st_loss $0 (sA fully washed, sB fully washed).
    assert r["summary"]["st_gain"] == 500.0
    assert r["summary"]["st_loss"] == 0.0
    assert r["summary"]["st_net"] == 500.0


def test_chain_with_open_replacement_locks_the_disallowance():
    """If the chain's replacement lot is still OPEN at the end (not
    sold), the disallowance is "locked" — it sits in the open lot's
    basis waiting for a future sell. Confirms the locked vs captured
    split is honest."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 100, 100.0, txn_id="b1"),
        _txn(D(2026, 2, 1), "sell", 100, 80.0, txn_id="s1"),
        _txn(D(2026, 2, 15), "buy", 100, 85.0, txn_id="b2"),
        # No further sells — b2's lot stays open with $2k disallowed.
    ]
    r = compute_realized_pnl(txns, as_of=D(2026, 6, 1))
    assert r["summary"]["wash_sale_disallowed_locked"] == 2000.0
    assert r["summary"]["wash_sale_disallowed_captured"] == 0.0
    # Open position should have inflated basis.
    p = r["open_positions"][0]
    assert p.cost_basis == 10500.0  # 100 × $85 + $2,000 disallowed


# ─── aggregate_by_symbol ────────────────────────────────────────────


from app.services.trading_tax import (
    aggregate_by_symbol,
    top_winners_losers,
    compute_quarterly_pacing,
    build_form_8949_rows,
    harvest_candidates,
    OpenPosition,
)


def test_aggregate_by_symbol_basic_rollup():
    """Multiple matches for the same ticker collapse to one row with
    summed gain/loss, share count, and trade count."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, sec_id="AAPL", txn_id="b1"),
        _txn(D(2026, 1, 2), "buy", 5, 110.0, sec_id="AAPL", txn_id="b2"),
        _txn(D(2026, 4, 1), "sell", 8, 120.0, sec_id="AAPL", txn_id="s1"),
        _txn(D(2026, 5, 1), "sell", 7, 130.0, sec_id="AAPL", txn_id="s2"),
    ]
    r = compute_realized_pnl(txns)
    rolled = aggregate_by_symbol(r["matches"])
    assert len(rolled) == 1
    aapl = rolled[0]
    assert aapl["symbol"] == "AAPL"
    assert aapl["trade_count"] == len(r["matches"])
    assert abs(aapl["shares_total"] - 15) < 1e-6
    # Net realized = sum of gain_loss across all matches
    expected_realized = round(sum(m.gain_loss for m in r["matches"]), 2)
    assert aapl["realized"] == expected_realized


def test_aggregate_by_symbol_st_lt_split():
    """ST and LT realized are tracked separately so the UI can show
    both columns honestly."""
    txns = [
        _txn(D(2024, 1, 1), "buy", 10, 100.0, txn_id="b-lt"),
        _txn(D(2026, 4, 1), "sell", 10, 130.0, txn_id="s-lt"),  # LT, +$300
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b-st"),
        _txn(D(2026, 4, 1), "sell", 10, 110.0, txn_id="s-st"),  # ST, +$100
    ]
    r = compute_realized_pnl(txns)
    rolled = aggregate_by_symbol(r["matches"])
    aapl = rolled[0]
    assert aapl["lt_realized"] == 300.0
    assert aapl["st_realized"] == 100.0
    assert aapl["realized"] == 400.0


def test_aggregate_by_symbol_sort_by_absolute_magnitude():
    """Symbols sorted by |realized| descending, so the biggest movers
    (winners or losers, doesn't matter which) sit at the top."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, sec_id="SMALL", txn_id="b-s"),
        _txn(D(2026, 4, 1), "sell", 10, 105.0, sec_id="SMALL", txn_id="s-s"),  # +50
        _txn(D(2026, 1, 1), "buy", 10, 100.0, sec_id="BIGLOSS", txn_id="b-l"),
        _txn(D(2026, 4, 1), "sell", 10, 50.0, sec_id="BIGLOSS", txn_id="s-l"),  # -500
        _txn(D(2026, 1, 1), "buy", 10, 100.0, sec_id="BIGWIN", txn_id="b-w"),
        _txn(D(2026, 4, 1), "sell", 10, 200.0, sec_id="BIGWIN", txn_id="s-w"),  # +1000
    ]
    r = compute_realized_pnl(txns)
    rolled = aggregate_by_symbol(r["matches"])
    assert [s["symbol"] for s in rolled] == ["BIGWIN", "BIGLOSS", "SMALL"]


def test_aggregate_by_symbol_handles_wash_disallowed_separately():
    """Wash disallowed amounts get summed into their own field so the
    UI can show both raw realized AND disallowed in the per-symbol table."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
        _txn(D(2026, 3, 1), "sell", 10, 80.0, txn_id="s1"),     # -200 loss
        _txn(D(2026, 3, 15), "buy", 10, 85.0, txn_id="b2"),    # washes s1
    ]
    r = compute_realized_pnl(txns)
    rolled = aggregate_by_symbol(r["matches"])
    assert len(rolled) == 1
    assert rolled[0]["wash_disallowed"] == 200.0
    assert rolled[0]["realized"] == -200.0  # raw, not adjusted


def test_aggregate_by_symbol_empty_input():
    """Defense: empty match list returns empty list, no crash."""
    assert aggregate_by_symbol([]) == []


# ─── top_winners_losers ─────────────────────────────────────────────


def test_top_winners_losers_splits_by_sign():
    """Symbols with realized > 0 → winners; < 0 → losers; == 0 → dropped."""
    by_symbol = [
        {"symbol": "BIG", "trade_count": 1, "shares_total": 10, "realized": 1000, "st_realized": 1000, "lt_realized": 0, "wash_disallowed": 0},
        {"symbol": "MID", "trade_count": 1, "shares_total": 10, "realized": 500, "st_realized": 500, "lt_realized": 0, "wash_disallowed": 0},
        {"symbol": "BAD", "trade_count": 1, "shares_total": 10, "realized": -300, "st_realized": -300, "lt_realized": 0, "wash_disallowed": 0},
        {"symbol": "FLAT", "trade_count": 1, "shares_total": 10, "realized": 0, "st_realized": 0, "lt_realized": 0, "wash_disallowed": 0},
    ]
    out = top_winners_losers(by_symbol, limit=5)
    assert [w["symbol"] for w in out["winners"]] == ["BIG", "MID"]
    assert [l["symbol"] for l in out["losers"]] == ["BAD"]


def test_top_winners_losers_respects_limit():
    """Limit caps each side independently — top 3 winners + top 3 losers."""
    rows = [
        {"symbol": f"W{i}", "trade_count": 1, "shares_total": 1, "realized": 1000 - i, "st_realized": 1000 - i, "lt_realized": 0, "wash_disallowed": 0}
        for i in range(10)
    ]
    out = top_winners_losers(rows, limit=3)
    assert len(out["winners"]) == 3
    assert out["winners"][0]["symbol"] == "W0"  # largest


def test_top_winners_losers_sorts_losers_by_magnitude():
    """Losers ranked by most-negative-first (largest loss = top loser)."""
    rows = [
        {"symbol": "SMALL_LOSS", "trade_count": 1, "shares_total": 1, "realized": -50, "st_realized": -50, "lt_realized": 0, "wash_disallowed": 0},
        {"symbol": "BIG_LOSS", "trade_count": 1, "shares_total": 1, "realized": -500, "st_realized": -500, "lt_realized": 0, "wash_disallowed": 0},
    ]
    out = top_winners_losers(rows, limit=10)
    assert [l["symbol"] for l in out["losers"]] == ["BIG_LOSS", "SMALL_LOSS"]


def test_top_winners_losers_empty_returns_empty_lists():
    out = top_winners_losers([], limit=5)
    assert out == {"winners": [], "losers": []}


# ─── compute_quarterly_pacing ───────────────────────────────────────


def test_quarterly_pacing_zero_tax_no_projection():
    """No YTD tax → projection is zero, no underpayment risk flagged."""
    p = compute_quarterly_pacing(ytd_tax_owed=0, as_of=D(2026, 6, 1), year=2026)
    assert p["projected_full_year_tax"] == 0.0
    assert p["underpayment_risk"] is False
    assert len(p["quarters"]) == 4


def test_quarterly_pacing_linear_projection_at_quarter_in():
    """100 days into the year with $5k YTD → projected ~$18,250 full-year."""
    p = compute_quarterly_pacing(ytd_tax_owed=5000, as_of=D(2026, 4, 10), year=2026)
    # day 100 of 365 → 27.4% elapsed → projected = 5000 / 0.274 ≈ 18,248
    assert 17000 < p["projected_full_year_tax"] < 19500
    # Quarterly = projected / 4
    assert p["quarterly_amount"] == round(p["projected_full_year_tax"] / 4, 2)


def test_quarterly_pacing_underpayment_risk_above_1k():
    """Per IRS, underpayment penalty kicks in above $1k owed at filing."""
    big = compute_quarterly_pacing(ytd_tax_owed=5000, as_of=D(2026, 4, 10), year=2026)
    small = compute_quarterly_pacing(ytd_tax_owed=200, as_of=D(2026, 12, 1), year=2026)
    assert big["underpayment_risk"] is True
    assert small["underpayment_risk"] is False  # projected stays below $1k


def test_quarterly_pacing_q4_deadline_in_next_year():
    """Q4 estimated tax due Jan 15 of NEXT year — verify the year wrap."""
    p = compute_quarterly_pacing(ytd_tax_owed=4000, as_of=D(2026, 6, 1), year=2026)
    q4 = next(q for q in p["quarters"] if q["label"] == "Q4")
    assert q4["deadline"] == "2027-01-15"


def test_quarterly_pacing_passed_quarters_marked():
    """Quarters whose deadline has passed get passed=True; the next
    upcoming one stays passed=False so the UI can highlight it."""
    p = compute_quarterly_pacing(ytd_tax_owed=4000, as_of=D(2026, 7, 1), year=2026)
    q1 = next(q for q in p["quarters"] if q["label"] == "Q1")
    q2 = next(q for q in p["quarters"] if q["label"] == "Q2")
    q3 = next(q for q in p["quarters"] if q["label"] == "Q3")
    q4 = next(q for q in p["quarters"] if q["label"] == "Q4")
    assert q1["passed"] is True   # Apr 15 < Jul 1
    assert q2["passed"] is True   # Jun 15 < Jul 1
    assert q3["passed"] is False
    assert q4["passed"] is False


def test_quarterly_pacing_cumulative_obligation_grows_through_year():
    """Each quarter's cumulative obligation = projected × (months/12).
    Q1=4/12, Q2=6/12, Q3=9/12, Q4=12/12. Should be monotonically increasing."""
    p = compute_quarterly_pacing(ytd_tax_owed=12000, as_of=D(2026, 12, 1), year=2026)
    cums = [q["cumulative_obligation"] for q in p["quarters"]]
    assert cums == sorted(cums)
    # Q4 should equal projected_full_year_tax (12/12).
    q4 = next(q for q in p["quarters"] if q["label"] == "Q4")
    assert q4["cumulative_obligation"] == round(p["projected_full_year_tax"], 2)


# ─── build_form_8949_rows ───────────────────────────────────────────


def test_form_8949_short_term_uses_box_a():
    """ST matches → Box A (short-term covered). LT → Box D."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0),
        _txn(D(2026, 4, 1), "sell", 10, 120.0),
    ]
    r = compute_realized_pnl(txns)
    rows = build_form_8949_rows(r["matches"])
    assert len(rows) == 1
    assert rows[0]["form_box"] == "A"
    assert rows[0]["term"] == "ST"


def test_form_8949_long_term_uses_box_d():
    txns = [
        _txn(D(2024, 1, 1), "buy", 10, 100.0),
        _txn(D(2026, 4, 1), "sell", 10, 120.0),
    ]
    r = compute_realized_pnl(txns)
    rows = build_form_8949_rows(r["matches"])
    assert rows[0]["form_box"] == "D"
    assert rows[0]["term"] == "LT"


def test_form_8949_wash_sale_carries_code_W_and_adjustment():
    """Wash sale rows must have code='W' in column (f) and the
    disallowed amount in column (g). Column (h) shows the IRS-reported
    gain/loss (proceeds − basis + adjustment), netting to zero for
    fully washed losses."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0, txn_id="b1"),
        _txn(D(2026, 3, 1), "sell", 10, 80.0, txn_id="s1"),     # -$200 loss
        _txn(D(2026, 3, 15), "buy", 10, 85.0, txn_id="b2"),    # washes s1
    ]
    r = compute_realized_pnl(txns)
    # Get the wash-sale match.
    m = next(m for m in r["matches"] if m.wash_sale_disallowed > 0)
    rows = build_form_8949_rows([m])
    assert rows[0]["code"] == "W"
    assert rows[0]["adjustment"] == 200.0
    # gain/loss = -200 + 200 = 0 reported
    assert rows[0]["gain_loss"] == 0.0


def test_form_8949_no_wash_no_code():
    """Non-wash matches have empty code and zero adjustment."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 10, 100.0),
        _txn(D(2026, 4, 1), "sell", 10, 120.0),
    ]
    r = compute_realized_pnl(txns)
    rows = build_form_8949_rows(r["matches"])
    assert rows[0]["code"] == ""
    assert rows[0]["adjustment"] == 0.0
    assert rows[0]["gain_loss"] == 200.0


def test_form_8949_description_includes_qty_and_symbol():
    """Form 8949 column (a) requires 'X.XXXX sh SYMBOL' style. Verify."""
    txns = [
        _txn(D(2026, 1, 1), "buy", 12.5, 100.0, sec_id="AAPL"),
        _txn(D(2026, 4, 1), "sell", 12.5, 120.0, sec_id="AAPL"),
    ]
    r = compute_realized_pnl(txns)
    rows = build_form_8949_rows(r["matches"])
    desc = rows[0]["description"]
    assert "AAPL" in desc
    assert "12.5" in desc


# ─── harvest_candidates ─────────────────────────────────────────────


def _open_pos(symbol="AAPL", account_id=1, qty=10, cost_basis=1000,
              days_held=100, days_until_lt=266, is_long_term=False):
    """Compact factory for OpenPosition test fixtures."""
    return OpenPosition(
        symbol=symbol,
        plaid_security_id=symbol,
        account_id=account_id,
        quantity=qty,
        cost_basis=cost_basis,
        avg_cost_per_share=cost_basis / qty,
        earliest_buy_date=D(2026, 1, 1),
        days_held_so_far=days_held,
        days_until_lt=days_until_lt,
        is_long_term=is_long_term,
    )


def test_harvest_candidates_skips_positions_at_gain():
    """Only positions UNDERWATER are harvest candidates. Positions at
    a gain are dropped entirely (TLH only helps for loss positions)."""
    pos = [_open_pos(symbol="UP", qty=10, cost_basis=1000)]
    out = harvest_candidates(
        open_positions=pos,
        current_prices={"UP": 150.0},  # 10 × $150 = $1,500 > $1,000 basis
        recent_buy_dates={},
        as_of=D(2026, 5, 1),
    )
    assert out == []


def test_harvest_candidates_returns_loss_positions_with_savings():
    """A position at a loss with no wash risk produces a candidate
    with the right tax-savings calculation."""
    pos = [_open_pos(symbol="DOWN", qty=10, cost_basis=1000)]
    out = harvest_candidates(
        open_positions=pos,
        current_prices={"DOWN": 80.0},  # value $800, loss $200
        recent_buy_dates={},
        as_of=D(2026, 5, 1),
        ordinary_marginal_rate=0.22,
        state_rate=0.0425,
    )
    assert len(out) == 1
    c = out[0]
    assert c["unrealized_loss"] == 200.0
    # ST, so applies ordinary + state = 26.25%.
    assert c["estimated_tax_savings"] == round(200 * 0.2625, 2)
    assert c["wash_sale_risk"] is False


def test_harvest_candidates_lt_uses_ltcg_rate():
    """LT positions apply the LTCG rate, not ordinary, since the
    harvested loss would offset LT gains at the lower rate."""
    pos = [_open_pos(symbol="DOWN_LT", qty=10, cost_basis=1000,
                     days_held=400, days_until_lt=0, is_long_term=True)]
    out = harvest_candidates(
        open_positions=pos,
        current_prices={"DOWN_LT": 80.0},
        recent_buy_dates={},
        as_of=D(2026, 5, 1),
        ordinary_marginal_rate=0.22,
        ltcg_rate=0.15,
        state_rate=0.0425,
    )
    c = out[0]
    assert c["term"] == "LT"
    # LTCG + state = 19.25%.
    assert c["estimated_tax_savings"] == round(200 * 0.1925, 2)


def test_harvest_candidates_flags_wash_risk_when_recent_buy():
    """A buy of the same symbol within 30 days marks the candidate as
    wash-blocked. The notes string mentions the wait period."""
    pos = [_open_pos(symbol="DOWN", qty=10, cost_basis=1000)]
    out = harvest_candidates(
        open_positions=pos,
        current_prices={"DOWN": 80.0},
        recent_buy_dates={"DOWN": D(2026, 4, 25)},  # 6 days ago
        as_of=D(2026, 5, 1),
    )
    c = out[0]
    assert c["wash_sale_risk"] is True
    assert "wash" in c["notes"].lower()


def test_harvest_candidates_no_wash_when_buy_outside_window():
    """Buy >30 days before doesn't trigger wash-risk flag."""
    pos = [_open_pos(symbol="DOWN", qty=10, cost_basis=1000)]
    out = harvest_candidates(
        open_positions=pos,
        current_prices={"DOWN": 80.0},
        recent_buy_dates={"DOWN": D(2026, 3, 1)},  # 61 days ago
        as_of=D(2026, 5, 1),
    )
    assert out[0]["wash_sale_risk"] is False


def test_harvest_candidates_suggests_replacement_for_known_pairs():
    """Known tickers in the replacement-pair table get a suggestion
    so the user can preserve exposure post-harvest."""
    pos = [_open_pos(symbol="VTI", qty=10, cost_basis=1000)]
    out = harvest_candidates(
        open_positions=pos,
        current_prices={"VTI": 80.0},
        recent_buy_dates={},
        as_of=D(2026, 5, 1),
    )
    assert out[0]["suggested_replacement"] == "ITOT"
    assert "ITOT" in out[0]["notes"]


def test_harvest_candidates_no_replacement_for_unknown_symbols():
    """A position whose ticker isn't in the lookup table gets None
    for the replacement and a graceful note about picking one manually."""
    pos = [_open_pos(symbol="OBSCURE", qty=10, cost_basis=1000)]
    out = harvest_candidates(
        open_positions=pos,
        current_prices={"OBSCURE": 80.0},
        recent_buy_dates={},
        as_of=D(2026, 5, 1),
    )
    c = out[0]
    assert c["suggested_replacement"] is None
    assert "not-substantially-identical" in c["notes"]


def test_harvest_candidates_sorted_by_estimated_tax_savings_desc():
    """Biggest opportunity at the top so the user sees what to act on first."""
    pos = [
        _open_pos(symbol="SMALL", qty=10, cost_basis=1000),
        _open_pos(symbol="LARGE", qty=10, cost_basis=10000),
    ]
    out = harvest_candidates(
        open_positions=pos,
        current_prices={"SMALL": 80.0, "LARGE": 800.0},
        recent_buy_dates={},
        as_of=D(2026, 5, 1),
    )
    assert [c["symbol"] for c in out] == ["LARGE", "SMALL"]


def test_harvest_candidates_close_to_lt_warning_in_notes():
    """When a position is within 30 days of LT, the notes mention it
    so the user knows the ST-loss window is closing."""
    pos = [_open_pos(symbol="ALMOST_LT", qty=10, cost_basis=1000,
                     days_held=350, days_until_lt=15)]
    out = harvest_candidates(
        open_positions=pos,
        current_prices={"ALMOST_LT": 80.0},
        recent_buy_dates={},
        as_of=D(2026, 5, 1),
    )
    assert "LT" in out[0]["notes"]
    assert "15" in out[0]["notes"]


def test_harvest_candidates_skips_positions_without_current_price():
    """If we have no current price for a symbol (e.g., manual account
    without a Holdings record), skip rather than crash."""
    pos = [_open_pos(symbol="NO_PRICE", qty=10, cost_basis=1000)]
    out = harvest_candidates(
        open_positions=pos,
        current_prices={},  # empty
        recent_buy_dates={},
        as_of=D(2026, 5, 1),
    )
    assert out == []


def test_harvest_candidates_empty_open_positions():
    """Defensive: empty input → empty output, no errors."""
    assert harvest_candidates(
        open_positions=[],
        current_prices={},
        recent_buy_dates={},
    ) == []
