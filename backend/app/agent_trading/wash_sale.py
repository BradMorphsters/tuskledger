"""Real cross-account wash-sale check for the guardrail gate.

The trading agent only ever sees the Agentic account, so it cannot know that buying a
name here re-establishes a position you just sold at a loss in your *main* account —
which disallows that loss under IRC §1091. This module closes that blind spot by wiring
the guardrail's ``wash_sale_lookup`` hook to the authoritative §1091 engine that already
powers the Trading Tax page (``services/trading_tax.compute_realized_pnl``).

Layering, so it stays testable:

* :func:`assess_wash_sale` — pure decision over a list of transaction dicts. No DB.
* :func:`make_wash_sale_lookup` — turns any transaction *fetcher* into the
  ``(ticker, side) -> bool`` hook the gate expects.
* :func:`db_txn_fetcher` / :func:`make_db_wash_sale_lookup` — the live wiring: pull one
  symbol's buys & sells across *all* accounts (taxpayer-wide, per §1091) from the DB.

Only the DB helpers import ORM models (lazily), so the rule itself imports and tests
anywhere — ``trading_tax`` is pure stdlib.
"""
from __future__ import annotations

import datetime
from typing import Callable, Optional

from app.services.trading_tax import WASH_WINDOW_DAYS, compute_realized_pnl

# Fetch one symbol's buy/sell transactions (across all accounts) on/after ``since``.
# Each dict follows compute_realized_pnl's contract: date, plaid_security_id, symbol,
# type ('buy'|'sell'), quantity (positive), price, fees.
TxnFetcher = Callable[[str, datetime.date], list[dict]]


def assess_wash_sale(
    symbol: str,
    side: str,
    txns: list[dict],
    as_of: Optional[datetime.date] = None,
    window_days: int = WASH_WINDOW_DAYS,
) -> tuple[bool, str]:
    """Would this order be the wash-sale replacement leg? Returns (flagged, reason).

    BUY  → flag if a *realized loss* sale of ``symbol`` occurred within the trailing
           window. Buying now is the replacement purchase that disallows that loss.
    SELL → flag if ``symbol`` was *acquired* within the trailing window. That recent buy
           is a candidate replacement leg, so if this sale closes at a loss it's a wash.

    The BUY path runs the real FIFO §1091 engine to know which recent sells were losses;
    the SELL path is necessarily forward-looking (we don't know the sale's loss pre-fill),
    so it flags conservatively on any recent acquisition.
    """
    if as_of is None:
        as_of = datetime.date.today()
    side = side.lower().strip()
    sym = symbol.upper().strip()

    # Window semantics (both paths below): `0 <= days <= window_days` is an
    # INCLUSIVE trailing window — with window_days=30 that's 31 calendar days
    # counting today, i.e. one side of §1091's 61-day (±30) period. CALENDAR
    # days, not trading days, matching the statute. If you ever change
    # WASH_WINDOW_DAYS, remember the <= keeps it inclusive (31 → 32-day span).
    if side == "buy":
        result = compute_realized_pnl(txns, as_of=as_of)
        recent_losses = [
            m for m in result["matches"]
            if m.gain_loss < 0 and 0 <= (as_of - m.sell_date).days <= window_days
        ]
        if recent_losses:
            worst = min(recent_losses, key=lambda m: m.gain_loss)
            return True, (
                f"{sym}: buying within {window_days}d of a realized loss sale on "
                f"{worst.sell_date} (${worst.gain_loss:,.2f}) — this purchase would "
                f"disallow that loss (IRC §1091)"
            )
        return False, ""

    if side == "sell":
        recent_buys = [
            t for t in txns
            if str(t.get("type", "")).lower() == "buy"
            and t.get("date") is not None
            and 0 <= (as_of - t["date"]).days <= window_days
        ]
        if recent_buys:
            latest = max(recent_buys, key=lambda t: t["date"])
            return True, (
                f"{sym}: selling within {window_days}d of a purchase on {latest['date']} "
                f"— if this sale closes at a loss it would be a wash sale (IRC §1091)"
            )
        return False, ""

    return False, ""


# Pull effectively all history. The §1091 *window* applies to the sell date, but FIFO
# realized-P&L needs the original buy lot, which can be arbitrarily old — so the fetch
# must reach back far enough to capture basis, not just the 61-day window.
_HISTORY_START = datetime.date(1970, 1, 1)


def make_wash_sale_lookup(
    fetch: TxnFetcher,
    *,
    get_today: Optional[Callable[[], datetime.date]] = None,
    window_days: int = WASH_WINDOW_DAYS,
    history_start: Optional[datetime.date] = None,
    on_flag: Optional[Callable[[str, str, str], None]] = None,
) -> Callable[[str, str], bool]:
    """Adapt a transaction fetcher into the gate's ``(ticker, side) -> bool`` hook.

    The fetcher is asked for the symbol's full history (``history_start``, default 1970)
    so FIFO has the purchase lots it needs; the window check then runs on the sell date.
    Exceptions from ``fetch`` propagate to the guardrail, which records them as a
    non-blocking warning — a momentary data hiccup must not silently disable the check
    *or* halt trading. ``on_flag`` lets a caller capture the human-readable reason.
    """
    _today = get_today or datetime.date.today
    _start = history_start or _HISTORY_START

    def lookup(symbol: str, side: str) -> bool:
        as_of = _today()
        txns = fetch(symbol, _start)
        flagged, reason = assess_wash_sale(symbol, side, txns, as_of=as_of, window_days=window_days)
        if flagged and on_flag:
            on_flag(symbol, side, reason)
        return flagged

    return lookup


# --------------------------------------------------------------------------- live wiring

def db_txn_fetcher(db) -> TxnFetcher:
    """A fetcher backed by the Tusk Ledger DB — taxpayer-wide across all accounts.

    Imports ORM models lazily so this module stays importable (and the rule testable)
    without SQLAlchemy.
    """
    def fetch(symbol: str, since: datetime.date) -> list[dict]:
        from app.models import InvestmentTransaction, Security  # lazy

        rows = (
            db.query(InvestmentTransaction, Security)
            .join(Security, InvestmentTransaction.plaid_security_id == Security.plaid_security_id)
            .filter(Security.ticker_symbol == symbol.upper())
            .filter(InvestmentTransaction.date >= since)
            .filter(InvestmentTransaction.type.in_(["buy", "sell"]))
            .all()
        )
        out: list[dict] = []
        for it, sec in rows:
            if it.quantity is None or it.price is None:
                continue
            out.append({
                "date": it.date,
                "plaid_security_id": it.plaid_security_id,
                "symbol": sec.ticker_symbol or symbol.upper(),
                "type": (it.type or "").lower(),
                "quantity": abs(it.quantity),
                "price": it.price,
                "fees": it.fees or 0.0,
                "plaid_investment_transaction_id": it.plaid_investment_transaction_id,
            })
        return out

    return fetch


def make_db_wash_sale_lookup(db, **kwargs) -> Callable[[str, str], bool]:
    """Convenience: the live, DB-backed wash-sale hook for the executor."""
    return make_wash_sale_lookup(db_txn_fetcher(db), **kwargs)
