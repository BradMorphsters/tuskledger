"""Wash-sale watch: forward-looking guidance (don't rebuy until…, can't
harvest until…, trades the broker hasn't reported yet). Fictional data."""
from __future__ import annotations

import datetime

import pytest

from app.services.trading_tax import build_wash_watch, compute_realized_pnl

D = datetime.date
TODAY = D(2026, 11, 12)
ACCOUNTS = {
    1: {"name": "Brokerage", "tax_bucket": "taxable"},
    2: {"name": "Joint", "tax_bucket": "taxable"},
    3: {"name": "Work 401(k)", "tax_bucket": "tax_deferred"},
}


def _t(date, ttype, qty, price, sec, account_id=1, txn_id=None):
    return {
        "date": date, "type": ttype, "quantity": qty, "price": price, "fees": 0.0,
        "plaid_security_id": sec, "symbol": sec, "account_id": account_id,
        "plaid_investment_transaction_id": txn_id or f"{ttype}-{sec}-{account_id}-{date.isoformat()}",
    }


def _holding(account_id, sec, qty, price, updated=TODAY, sec_type="equity"):
    return {"account_id": account_id, "plaid_security_id": sec, "symbol": sec, "quantity": qty,
            "price": price, "security_type": sec_type, "updated": updated}


def _watch(txns, holdings=(), prices=None, as_of=TODAY, types=None):
    pnl = compute_realized_pnl(txns, as_of=as_of)
    return build_wash_watch(
        matches=pnl["matches"], txns=txns, open_positions=pnl["open_positions"],
        holdings=list(holdings), last_prices=prices or {}, accounts=ACCOUNTS, as_of=as_of,
        security_types=types or {},
    )


def test_recent_loss_sale_says_when_rebuying_is_safe():
    txns = [_t(D(2026, 3, 2), "buy", 10, 50.0, "AAA"), _t(D(2026, 11, 2), "sell", 10, 40.0, "AAA")]
    w = _watch(txns)
    (row,) = w["do_not_rebuy"]
    assert row["symbol"] == "AAA" and row["loss"] == 100.0
    assert row["safe_to_rebuy_on"] == "2026-12-03"     # sell + 31 days
    assert row["days_left"] == 21 and not row["estimated"]


def test_gain_sales_and_old_losses_are_not_listed():
    txns = [
        _t(D(2026, 1, 5), "buy", 10, 50.0, "WIN"), _t(D(2026, 11, 1), "sell", 10, 70.0, "WIN"),
        _t(D(2026, 1, 5), "buy", 10, 50.0, "OLD"), _t(D(2026, 9, 1), "sell", 10, 40.0, "OLD"),
    ]
    assert _watch(txns)["do_not_rebuy"] == []


def test_recent_buy_blocks_harvesting_an_at_loss_position():
    txns = [_t(D(2026, 2, 1), "buy", 10, 100.0, "COP", account_id=2),
            _t(D(2026, 11, 3), "buy", 5, 70.0, "COP", account_id=1)]
    holdings = [_holding(2, "COP", 10, 70.0), _holding(1, "COP", 5, 70.0)]
    w = _watch(txns, holdings)
    (row,) = w["cannot_harvest_yet"]
    assert row["symbol"] == "COP" and row["harvest_ok_on"] == "2026-12-04"
    assert row["unrealized_loss"] == 300.0              # the Feb lot: 10 × (100 − 70)
    assert row["bought_in"] == "Brokerage"


def test_unreported_sell_is_inferred_from_broker_positions():
    # Trade history stops Nov 4; broker positions refreshed today no longer
    # show XYZ → a probable sale, valued at the last known price.
    txns = [_t(D(2025, 10, 14), "buy", 10, 100.0, "XYZ", account_id=2),
            _t(D(2025, 10, 14), "buy", 1, 50.0, "KEEP", account_id=2),
            _t(D(2026, 11, 4), "buy", 1, 50.0, "KEEP", account_id=2)]
    holdings = [_holding(2, "KEEP", 2, 50.0)]
    w = _watch(txns, holdings, prices={"XYZ": 80.0})
    (sell,) = [u for u in w["unreported_trades"] if u["kind"] == "sell"]
    assert sell["symbol"] == "XYZ" and sell["estimated_gain_loss"] == -200.0 and sell["term"] == "LT"
    assert sell["since"] == "2026-11-05"
    (row,) = w["do_not_rebuy"]
    assert row["estimated"] and row["loss"] == 200.0
    assert row["safe_to_rebuy_on"] == "2026-12-13"      # counted from today: never too early
    assert w["data_lag"][0]["trades_through"] == "2026-11-04"


def test_no_inference_when_trade_history_is_current():
    txns = [_t(D(2025, 10, 14), "buy", 10, 100.0, "XYZ", account_id=2),
            _t(D(2026, 11, 12), "buy", 1, 50.0, "KEEP", account_id=2)]
    w = _watch(txns, [_holding(2, "KEEP", 1, 50.0)], prices={"XYZ": 80.0})
    assert w["unreported_trades"] == [] and w["data_lag"] == []


def test_unreported_buy_blocks_harvest_and_transfer_does_not():
    txns = [_t(D(2026, 2, 1), "buy", 10, 100.0, "DIP", account_id=1),
            _t(D(2026, 2, 1), "buy", 4, 10.0, "MOVE", account_id=2),
            _t(D(2026, 2, 1), "buy", 4, 10.0, "MOVE2", account_id=1)]
    holdings = [
        _holding(1, "DIP", 15, 60.0),       # +5 shares not in history → a buy
        _holding(1, "MOVE", 4, 9.0),        # moved in from account 2 (stale there)
        _holding(1, "MOVE2", 4, 9.0),
        _holding(2, "MOVE", 4, 9.0, updated=D(2026, 10, 1)),
    ]
    w = _watch(txns, holdings)
    kinds = {u["symbol"]: u["kind"] for u in w["unreported_trades"]}
    assert kinds["DIP"] == "buy" and kinds["MOVE"] == "transfer_in"
    blocked = {r["symbol"]: r for r in w["cannot_harvest_yet"]}
    assert blocked["DIP"]["estimated"] and blocked["DIP"]["harvest_ok_on"] == "2026-12-13"
    assert "MOVE" not in blocked


def test_crypto_and_cash_never_inferred_as_sold():
    txns = [_t(D(2026, 1, 1), "buy", 0.01, 60000.0, "BTC", account_id=1),
            _t(D(2026, 11, 1), "buy", 1, 10.0, "KEEP", account_id=1)]
    holdings = [_holding(1, "KEEP", 1, 10.0), _holding(1, "CUR:USD", 500, 1.0, sec_type="cash")]
    w = _watch(txns, holdings, prices={"BTC": 90000.0}, types={"BTC": "cryptocurrency"})
    assert all(u["symbol"] != "BTC" for u in w["unreported_trades"])


def test_two_accounts_selling_same_symbol_merge_into_one_row():
    txns = [_t(D(2026, 1, 2), "buy", 10, 50.0, "GLDX", account_id=1),
            _t(D(2026, 1, 2), "buy", 10, 50.0, "GLDX", account_id=2),
            _t(D(2026, 11, 1), "sell", 10, 45.0, "GLDX", account_id=1),
            _t(D(2026, 11, 9), "sell", 10, 45.0, "GLDX", account_id=2)]
    (row,) = _watch(txns)["do_not_rebuy"]
    assert row["loss"] == 100.0 and set(row["accounts"]) == {"Brokerage", "Joint"}
    assert row["safe_to_rebuy_on"] == "2026-12-10"      # the later window


def test_year_end_guidance_and_cross_year_flag():
    txns = [_t(D(2026, 3, 2), "buy", 10, 50.0, "AAA"), _t(D(2026, 12, 10), "sell", 10, 40.0, "AAA")]
    w = _watch(txns, as_of=D(2026, 12, 12))
    assert w["year_end"]["rebuy_inside_year_if_sold_by"] == "2026-11-30"
    assert w["do_not_rebuy"][0]["crosses_year_end"] is True
    assert _watch(txns[:1], as_of=D(2026, 9, 1))["year_end"] is None


def test_retirement_accounts_are_named():
    w = _watch([_t(D(2026, 1, 1), "buy", 1, 1.0, "A")])
    assert w["retirement_accounts"] == ["Work 401(k)"]


def test_trading_tax_endpoint_returns_wash_watch(db):
    """End to end through the router: ORM rows in, wash_watch out."""
    from app.models import Account, Holding, InvestmentTransaction, Security
    from app.routers import investments

    today = datetime.date.today()   # the endpoint reads the real clock
    sold = today - datetime.timedelta(days=10)
    acct = Account(name="Brokerage", type="investment", subtype="brokerage", tax_bucket="taxable",
                   current_balance=1000.0)
    db.add(acct)
    db.add_all([Security(plaid_security_id="s-aaa", ticker_symbol="AAA", type="equity", close_price=40.0),
                Security(plaid_security_id="s-bbb", ticker_symbol="BBB", type="equity", close_price=20.0)])
    db.flush()
    db.add_all([
        InvestmentTransaction(plaid_investment_transaction_id="b1", account_id=acct.id, plaid_security_id="s-aaa",
                              date=today - datetime.timedelta(days=200), name="BUY AAA", type="buy", quantity=10, price=50.0, amount=500.0),
        InvestmentTransaction(plaid_investment_transaction_id="s1", account_id=acct.id, plaid_security_id="s-aaa",
                              date=sold, name="SELL AAA", type="sell", quantity=10, price=40.0, amount=-400.0),
        InvestmentTransaction(plaid_investment_transaction_id="b2", account_id=acct.id, plaid_security_id="s-bbb",
                              date=sold, name="BUY BBB", type="buy", quantity=5, price=20.0, amount=100.0),
    ])
    db.add(Holding(account_id=acct.id, plaid_security_id="s-bbb", quantity=5, institution_price=20.0,
                   institution_value=100.0))
    db.commit()

    out = investments.trading_tax(db=db, year=None, account_id=None, ordinary_marginal_rate=0.22,
                                  ltcg_rate=0.15, state_rate=0.0425, wash_sale_scope="all_accounts")
    ww = out["wash_watch"]
    assert [r["symbol"] for r in ww["do_not_rebuy"]] == ["AAA"]
    assert ww["do_not_rebuy"][0]["safe_to_rebuy_on"] == (sold + datetime.timedelta(days=31)).isoformat()
