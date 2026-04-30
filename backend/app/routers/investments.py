"""Investment accounts: holdings, transactions, and portfolio summary."""
from __future__ import annotations

import datetime
from dataclasses import asdict
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import Account, Holding, InvestmentTransaction, Security
from app.schemas.schemas import (
    AccountValueOut,
    HoldingAllocationRow,
    HoldingOut,
    InvestmentTransactionOut,
    InvestmentsSummary,
    SecurityOut,
    TopHoldingRow,
)
from app.services.trading_tax import (
    aggregate_by_symbol,
    build_form_8949_rows,
    compute_quarterly_pacing,
    compute_realized_pnl,
    estimate_tax_owed,
    harvest_candidates,
    lt_savings_per_position,
    simulate_hypothetical_sell,
    top_winners_losers,
)
from pydantic import BaseModel, Field
from fastapi.responses import Response
import csv
import io

router = APIRouter(prefix="/api/investments", tags=["investments"])


def _account_display_name(account: Account) -> str:
    return account.custom_name or account.name


@router.get("/holdings", response_model=List[HoldingOut])
def list_holdings(
    db: Session = Depends(get_db),
    account_id: Optional[int] = Query(None, description="Filter to a single account"),
):
    q = db.query(Holding).options(joinedload(Holding.security), joinedload(Holding.account))
    if account_id is not None:
        q = q.filter(Holding.account_id == account_id)
    holdings = q.all()

    out: list[HoldingOut] = []
    for h in holdings:
        account = h.account
        security = h.security
        gain_loss = None
        if h.institution_value is not None and h.cost_basis is not None:
            gain_loss = round(h.institution_value - h.cost_basis, 2)
        out.append(
            HoldingOut(
                id=h.id,
                account_id=h.account_id,
                account_name=_account_display_name(account) if account else "(unknown)",
                plaid_security_id=h.plaid_security_id,
                security=SecurityOut.model_validate(security) if security else SecurityOut(plaid_security_id=h.plaid_security_id),
                quantity=h.quantity,
                institution_price=h.institution_price,
                institution_value=h.institution_value,
                cost_basis=h.cost_basis,
                gain_loss=gain_loss,
                iso_currency_code=h.iso_currency_code,
            )
        )
    # Highest market value first, then alphabetical by ticker/name.
    out.sort(key=lambda x: (-(x.institution_value or 0), (x.security.ticker_symbol or x.security.name or "")))
    return out


@router.get("/transactions", response_model=List[InvestmentTransactionOut])
def list_investment_transactions(
    db: Session = Depends(get_db),
    account_id: Optional[int] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
):
    q = (
        db.query(InvestmentTransaction)
        .options(joinedload(InvestmentTransaction.account), joinedload(InvestmentTransaction.security))
        .order_by(InvestmentTransaction.date.desc(), InvestmentTransaction.id.desc())
    )
    if account_id is not None:
        q = q.filter(InvestmentTransaction.account_id == account_id)
    items = q.limit(limit).all()

    out: list[InvestmentTransactionOut] = []
    for it in items:
        account = it.account
        security = it.security
        out.append(
            InvestmentTransactionOut(
                id=it.id,
                account_id=it.account_id,
                account_name=_account_display_name(account) if account else "(unknown)",
                date=it.date,
                name=it.name,
                type=it.type,
                subtype=it.subtype,
                ticker_symbol=security.ticker_symbol if security else None,
                security_name=security.name if security else None,
                quantity=it.quantity,
                price=it.price,
                amount=it.amount,
                fees=it.fees,
                pending=it.pending,
            )
        )
    return out


@router.get("/summary", response_model=InvestmentsSummary)
def investments_summary(db: Session = Depends(get_db)):
    """Portfolio rollup with per-account breakdown.

    Cash vs invested split:
      - "cash" = holdings where the security is flagged is_cash_equivalent
        (Plaid does this for money-market positions, settled cash, etc.).
      - "invested" = everything else (equity, ETF, mutual fund, fixed income, ...).

    Cost basis and gain/loss are only computed across non-cash holdings,
    since cash positions don't have a meaningful basis (cb == value by
    definition). This makes "gain/loss" honest — you don't see $0 of gain
    on $117k of cash watering down per-account performance numbers.
    """
    holdings = (
        db.query(Holding)
        .options(joinedload(Holding.security), joinedload(Holding.account))
        .all()
    )

    # Per-account aggregation. Keyed by account_id so accounts that
    # share a display name (e.g. two "Robinhood individual" accounts)
    # stay distinct.
    by_acct: dict[int, dict] = {}
    total_value = 0.0
    total_cash = 0.0
    total_invested = 0.0
    total_cost = 0.0
    cost_known = False

    # Legacy maps for backwards compatibility.
    legacy_by_account: dict[str, float] = {}
    legacy_by_type: dict[str, float] = {}

    # For allocation and top holdings
    allocation_by_type: dict[str, float] = {}  # security.type -> total value (including cash)
    all_holdings_data: list[tuple] = []  # (value, security_name, ticker, cost_basis, h.institution_value)

    for h in holdings:
        value = h.institution_value or 0.0
        is_cash = bool(h.security and h.security.is_cash_equivalent)
        total_value += value
        if is_cash:
            total_cash += value
        else:
            total_invested += value

        if h.account is None:
            continue
        bucket = by_acct.setdefault(h.account.id, {
            "account_id": h.account.id,
            "name": _account_display_name(h.account),
            "institution": h.account.institution_name,
            "subtype": h.account.subtype,
            "is_manual": h.account.plaid_item_id is None,
            "balance_as_of": h.account.balance_as_of,
            "cash_value": 0.0,
            "invested_value": 0.0,
            "cost_basis": 0.0,
            "cost_known": False,
            "holding_count": 0,
        })
        if is_cash:
            bucket["cash_value"] += value
        else:
            bucket["invested_value"] += value
            if h.cost_basis is not None:
                bucket["cost_basis"] += h.cost_basis
                bucket["cost_known"] = True
                total_cost += h.cost_basis
                cost_known = True
        bucket["holding_count"] += 1

        # Legacy maps still get every holding (cash + invested).
        acct_name = _account_display_name(h.account)
        legacy_by_account[acct_name] = legacy_by_account.get(acct_name, 0.0) + value
        sec_type = (h.security.type if h.security else None) or "other"
        legacy_by_type[sec_type] = legacy_by_type.get(sec_type, 0.0) + value

        # Build allocation by type and collect holdings data
        allocation_by_type[sec_type] = allocation_by_type.get(sec_type, 0.0) + value
        all_holdings_data.append((
            value,
            h.security.name if h.security else None,
            h.security.ticker_symbol if h.security else None,
            h.cost_basis,
            h.institution_value,
        ))

    # Manual investment accounts don't have Holdings — they only have an
    # Account.current_balance. The Holdings loop above misses them, so
    # they'd be invisible on the Investments page. Pull them in here
    # using current_balance as the total. Without a Holdings breakdown
    # we don't know the cash-vs-invested split (an HSA might be $4k cash
    # + $14k invested), so treat the whole balance as 'invested' — better
    # than zero and consistent with how net worth treats the same dollars.
    investment_account_ids_with_holdings = set(by_acct.keys())
    manual_investment_accounts = (
        db.query(Account)
        .filter(
            Account.type == 'investment',
            ~Account.id.in_(investment_account_ids_with_holdings)
                if investment_account_ids_with_holdings else True,
        )
        .all()
    )
    for acct in manual_investment_accounts:
        bal = float(acct.current_balance or 0.0)
        if bal <= 0:
            continue  # skip empty placeholders
        by_acct[acct.id] = {
            "account_id": acct.id,
            "name": _account_display_name(acct),
            "institution": acct.institution_name,
            "subtype": acct.subtype,
            "is_manual": acct.plaid_item_id is None,
            "balance_as_of": acct.balance_as_of,
            "cash_value": 0.0,
            "invested_value": bal,
            "cost_basis": 0.0,
            "cost_known": False,
            "holding_count": 0,
        }
        total_value += bal
        total_invested += bal

    # Build the per-account list, computing gain/loss and pct.
    accounts_out: list[AccountValueOut] = []
    for b in by_acct.values():
        total_v = b["cash_value"] + b["invested_value"]
        gl = round(b["invested_value"] - b["cost_basis"], 2) if b["cost_known"] else None
        pct = round((total_v / total_value) * 100, 2) if total_value > 0 else 0.0
        accounts_out.append(AccountValueOut(
            account_id=b["account_id"],
            name=b["name"],
            institution=b["institution"],
            subtype=b["subtype"],
            cash_value=round(b["cash_value"], 2),
            invested_value=round(b["invested_value"], 2),
            total_value=round(total_v, 2),
            cost_basis=round(b["cost_basis"], 2) if b["cost_known"] else None,
            gain_loss=gl,
            holding_count=b["holding_count"],
            pct_of_portfolio=pct,
            is_manual=b["is_manual"],
            balance_as_of=b["balance_as_of"],
        ))
    accounts_out.sort(key=lambda a: a.total_value, reverse=True)

    gain_loss = round(total_invested - total_cost, 2) if cost_known else None

    # Compute total_gain_loss_pct: (total_gain_loss / total_cost_basis) * 100
    gain_loss_pct = None
    if cost_known and total_cost > 0:
        gain_loss_pct = round((gain_loss / total_cost) * 100, 2)

    # Build allocation list grouped by security type
    allocation_out: list[HoldingAllocationRow] = []
    for sec_type, value in sorted(allocation_by_type.items()):
        pct = round((value / total_value) * 100, 2) if total_value > 0 else 0.0
        # Map security types to display labels
        type_label = {
            "equity": "Stocks",
            "etf": "ETFs",
            "mutual fund": "Mutual Funds",
            "bond": "Bonds",
            "fixed income": "Fixed Income",
            "cash": "Cash",
            "cryptocurrency": "Cryptocurrency",
            "derivative": "Derivatives",
        }.get(sec_type, sec_type.title() if sec_type else "Other")
        allocation_out.append(HoldingAllocationRow(
            type=sec_type,
            label=type_label,
            value=round(value, 2),
            pct=pct,
        ))

    # Build top_holdings: top 5 by institution_value
    # Sort by value descending, take top 5
    sorted_holdings = sorted(all_holdings_data, key=lambda x: x[0], reverse=True)[:5]
    top_holdings_out: list[TopHoldingRow] = []
    for value, sec_name, ticker, cost_basis, inst_value in sorted_holdings:
        h_gain_loss = None
        h_gain_loss_pct = None
        if inst_value is not None and cost_basis is not None:
            h_gain_loss = round(inst_value - cost_basis, 2)
            if cost_basis > 0:
                h_gain_loss_pct = round((h_gain_loss / cost_basis) * 100, 2)
        pct = round((value / total_value) * 100, 2) if total_value > 0 else 0.0
        top_holdings_out.append(TopHoldingRow(
            security_name=sec_name,
            ticker=ticker,
            value=round(value, 2),
            pct_of_portfolio=pct,
            gain_loss=h_gain_loss,
            gain_loss_pct=h_gain_loss_pct,
        ))

    return InvestmentsSummary(
        total_value=round(total_value, 2),
        total_cash=round(total_cash, 2),
        total_invested=round(total_invested, 2),
        total_cost_basis=round(total_cost, 2) if cost_known else None,
        total_gain_loss=gain_loss,
        total_gain_loss_pct=gain_loss_pct,
        allocation=allocation_out,
        top_holdings=top_holdings_out,
        accounts=accounts_out,
        by_account={k: round(v, 2) for k, v in legacy_by_account.items()},
        by_security_type={k: round(v, 2) for k, v in legacy_by_type.items()},
    )


# ─── Trading-tax surface ────────────────────────────────────────────
# Realized YTD P&L with ST/LT split + IRC §1091 wash-sale detection +
# open-position long-term countdown + estimated tax owed. Pure read of
# the InvestmentTransaction table — no DB writes; safe to call as often
# as the UI wants. The heavy lifting is the trading_tax service; this
# handler just adapts ORM rows into the service's input shape.

@router.get("/trading-tax")
def trading_tax(
    db: Session = Depends(get_db),
    year: Optional[int] = Query(
        None, ge=1990, le=2100,
        description="Limit to transactions in this calendar year. Defaults to YTD.",
    ),
    account_id: Optional[int] = Query(
        None,
        description="Restrict to a single investment account (e.g. just Robinhood).",
    ),
    ordinary_marginal_rate: float = Query(
        0.22, ge=0.0, le=0.50,
        description="User's marginal ordinary-income rate for ST gain tax. "
                    "Defaults to 22% (the 2025 MFJ bracket from $96,950 to $206,700).",
    ),
    ltcg_rate: float = Query(
        0.15, ge=0.0, le=0.50,
        description="LTCG rate. 15% covers most MFJ filers in 2025; "
                    "20% applies above ~$583k MFJ.",
    ),
    state_rate: float = Query(
        0.0425, ge=0.0, le=0.15,
        description="State income tax rate (MI = 4.25% default). "
                    "Most states tax both ST and LT as ordinary; the few "
                    "with separate LTCG schedules can override.",
    ),
    wash_sale_scope: str = Query(
        "all_accounts",
        description="'all_accounts' (default — IRC §1091, taxpayer-wide) "
                    "or 'per_account' (broker-style — only flag washes when "
                    "the replacement buy is in the same account as the loss). "
                    "Per-account is informational; the IRS rule is all-accounts.",
    ),
):
    """YTD trading-tax dashboard data.

    Returns:
      summary: {st_gain, st_loss, st_net, lt_gain, lt_loss, lt_net,
                wash_sale_disallowed, net_realized, ...}
      tax: {st_tax_federal, st_tax_state, lt_tax_federal, lt_tax_state,
            estimated_tax_total, carryover_to_next_year}
      matches: per-sell records for the audit table (Form 8949 lines)
      open_positions: lots still held; LT countdown + days-held
      lt_savings: open positions sorted by tax-savings-from-holding-to-LT
    """
    today = datetime.date.today()
    year_filter = year if year is not None else today.year
    start = datetime.date(year_filter, 1, 1)
    end = datetime.date(year_filter, 12, 31)

    # IMPORTANT: We always pull ALL accounts' transactions into the
    # calculator, even when account_id is set. IRC §1091 wash-sale
    # detection applies per TAXPAYER, not per account — a buy in your
    # IRA after a loss in your taxable brokerage is still a wash.
    # The account_id filter is applied to the OUTPUT (matches +
    # open_positions) so the user sees per-account numbers without
    # the calculator losing visibility into cross-account washes.
    rows = (
        db.query(InvestmentTransaction)
        .options(joinedload(InvestmentTransaction.security))
        .filter(
            InvestmentTransaction.date >= start,
            InvestmentTransaction.date <= end,
        )
        .order_by(InvestmentTransaction.date.asc(), InvestmentTransaction.id.asc())
        .all()
    )

    # Convert ORM rows into the service's lightweight dict shape.
    # account_id is now passed through so the calculator can do
    # per-(account, security) FIFO matching — mirrors brokerage
    # 1099-B reporting and avoids cross-account lot mingling.
    txns = []
    for r in rows:
        sec = r.security
        txns.append({
            "date": r.date,
            "type": r.type,
            "quantity": r.quantity,
            "price": r.price,
            "fees": r.fees or 0.0,
            "plaid_security_id": r.plaid_security_id,
            "symbol": (sec.ticker_symbol or sec.name or r.plaid_security_id) if sec else r.plaid_security_id,
            "plaid_investment_transaction_id": r.plaid_investment_transaction_id,
            "account_id": r.account_id,
        })

    pnl = compute_realized_pnl(txns, as_of=today, wash_sale_scope=wash_sale_scope)

    # Per-account display: scope matches + open_positions to the
    # selected account if requested. Wash-sale flags survive because
    # the calculator already saw cross-account history above.
    matches_full = pnl["matches"]
    open_full = pnl["open_positions"]
    if account_id is not None:
        matches_view = [m for m in matches_full if m.account_id == account_id]
        open_view = [p for p in open_full if p.account_id == account_id]
    else:
        matches_view = matches_full
        open_view = open_full

    # Recompute summary on the visible matches so the headline numbers
    # match what the user can see (otherwise filtering to one account
    # could show "$5k ST gain" while the matches table only shows $2k).
    summary_view = _summary_from_matches(matches_view, len(open_view))
    # Carry the locked-vs-captured wash split from the calculator's
    # own per-lot tracking (more accurate than re-deriving it at this
    # layer, since the calculator knows which buy txn ids are still
    # open). For the unfiltered case this is exact. For the per-account
    # filtered case, it shows the TAXPAYER-WIDE numbers — which is the
    # right framing since wash-sale rules apply per taxpayer regardless
    # of which account you're scoping to display.
    summary_view["wash_sale_disallowed_locked"] = pnl["summary"].get(
        "wash_sale_disallowed_locked", 0.0
    )
    summary_view["wash_sale_disallowed_captured"] = pnl["summary"].get(
        "wash_sale_disallowed_captured", 0.0
    )
    tax = estimate_tax_owed(
        summary_view,
        ordinary_marginal_rate=ordinary_marginal_rate,
        ltcg_rate=ltcg_rate,
        state_rate=state_rate,
    )

    # Build a price map from current Holdings (institution_price) so the
    # LT-savings tile can compute "tax saved if I hold to LT" using
    # today's mark-to-market valuation.
    # ALSO aggregate cash positions per account here in the same pass —
    # Plaid flags cash sweep / settled cash holdings via the security's
    # is_cash_equivalent bit. Useful as "dry powder" context for swing
    # traders: how much could I deploy without selling anything?
    price_map: dict[str, float] = {}
    cash_by_account_id: dict[int, float] = {}
    holdings = db.query(Holding).options(joinedload(Holding.security)).all()
    for h in holdings:
        if h.security and h.security.ticker_symbol and h.institution_price:
            price_map[h.security.ticker_symbol] = h.institution_price
        if h.security and h.security.is_cash_equivalent and h.institution_value:
            cash_by_account_id[h.account_id] = (
                cash_by_account_id.get(h.account_id, 0.0) + h.institution_value
            )
    lt_save = lt_savings_per_position(
        open_view,
        price_map,
        ordinary_marginal_rate=ordinary_marginal_rate,
        ltcg_rate=ltcg_rate,
        state_rate=state_rate,
    )

    # Account-name lookup so the UI can show "Robinhood" / "IRA" etc.
    # next to per-account rows instead of bare account_ids.
    account_id_to_name: dict[int, str] = {
        a.id: _account_display_name(a)
        for a in db.query(Account).filter(Account.type == "investment").all()
    }

    # Convert dataclass instances to dicts for JSON serialization.
    matches_out = []
    for m in matches_view:
        d = asdict(m)
        d["sell_date"] = m.sell_date.isoformat()
        d["buy_date"] = m.buy_date.isoformat()
        d["account_name"] = account_id_to_name.get(m.account_id) if m.account_id else None
        d["wash_sale_replacement_account_name"] = (
            account_id_to_name.get(m.wash_sale_replacement_account_id)
            if m.wash_sale_replacement_account_id else None
        )
        matches_out.append(d)
    open_out = []
    for p in open_view:
        d = asdict(p)
        d["earliest_buy_date"] = p.earliest_buy_date.isoformat()
        d["account_name"] = account_id_to_name.get(p.account_id) if p.account_id else None
        # Mark-to-market columns: current value (qty × today's price)
        # and unrealized gain (current_value − cost_basis). Sourced
        # from the same price_map the LT-savings tile uses, so the
        # number stays consistent with the "save $X by holding" math.
        # Falls back to None when we don't have a current price for
        # the symbol (manual accounts without holding rows, or
        # securities Plaid hasn't priced).
        cp = price_map.get(p.symbol)
        if cp and p.quantity:
            d["current_price"] = round(cp, 4)
            d["current_value"] = round(p.quantity * cp, 2)
            d["unrealized_gain"] = round(p.quantity * cp - p.cost_basis, 2)
        else:
            d["current_price"] = None
            d["current_value"] = None
            d["unrealized_gain"] = None
        open_out.append(d)

    # Audit trail for the UI: how many cross-account wash sales got
    # caught in the calculation (regardless of which account is being
    # viewed). Lets us surface "wash detection considered all your
    # accounts" with concrete evidence.
    cross_account_wash_count = sum(
        1 for m in matches_full
        if m.wash_sale_replacement_account_id is not None
    )

    # Cash-by-account view, scoped to the same account filter so the
    # cash row lines up with what the user is looking at. Empty when no
    # investment account has cash positions.
    cash_rows = []
    for aid, cash in cash_by_account_id.items():
        if account_id is not None and aid != account_id:
            continue
        if cash <= 0:
            continue
        cash_rows.append({
            "account_id": aid,
            "account_name": account_id_to_name.get(aid, "(unknown)"),
            "cash_value": round(cash, 2),
        })
    cash_rows.sort(key=lambda r: -r["cash_value"])
    total_cash = round(sum(r["cash_value"] for r in cash_rows), 2)

    # Per-symbol aggregation + top winners/losers + quarterly pacing.
    # All built on the SAME matches_view so the per-account filter
    # carries through — diagnostic outputs match what the user is
    # looking at, not the taxpayer-wide picture.
    by_symbol = aggregate_by_symbol(matches_view)
    winners_losers = top_winners_losers(by_symbol, limit=5)
    quarterly = compute_quarterly_pacing(
        ytd_tax_owed=tax["estimated_tax_total"],
        as_of=today,
        year=year_filter,
    )

    # Tax-loss harvesting candidates — open positions sitting at a
    # loss that could be sold to offset realized gains. Restricted to
    # TAXABLE accounts (TLH only helps in taxable; loss in 401k/IRA
    # is wasted shelter). Uses the existing price_map for current
    # market value and a recent_buy_dates lookup for wash-safety.
    taxable_account_ids = {
        a.id for a in db.query(Account).filter(
            Account.tax_bucket == "taxable"
        ).all()
    }
    # If no accounts are tagged taxable, fall back to brokerage
    # subtype as a heuristic — many users haven't tagged tax_bucket
    # explicitly but their Robinhood-style accounts are clearly taxable.
    if not taxable_account_ids:
        taxable_account_ids = {
            a.id for a in db.query(Account).filter(
                Account.subtype == "brokerage"
            ).all()
        }
    taxable_open_positions = [
        p for p in open_view if p.account_id in taxable_account_ids
    ]
    # Build recent buy dates per symbol from the matches we already
    # have visibility into (within past 30 days). Approximate but good
    # enough for the wash-safety pre-flag — the actual TLH execution
    # would route through the existing pre-flight modal which has
    # full transaction-level detail.
    recent_buy_cutoff = today - datetime.timedelta(days=30)
    recent_buy_dates: dict[str, datetime.date] = {}
    for r in rows:
        if r.type != "buy":
            continue
        if r.date < recent_buy_cutoff:
            continue
        sec = r.security
        sym = (sec.ticker_symbol if sec else None) or r.plaid_security_id
        prev = recent_buy_dates.get(sym)
        if prev is None or r.date > prev:
            recent_buy_dates[sym] = r.date
    tlh_candidates = harvest_candidates(
        open_positions=taxable_open_positions,
        current_prices=price_map,
        recent_buy_dates=recent_buy_dates,
        as_of=today,
        ordinary_marginal_rate=ordinary_marginal_rate,
        ltcg_rate=ltcg_rate,
        state_rate=state_rate,
    )
    # Aggregate the savings opportunity across candidates so the UI
    # can show "harvest all of these = $X tax saved" as a banner.
    tlh_total_savings = round(
        sum(c["estimated_tax_savings"] for c in tlh_candidates), 2
    )
    tlh_total_loss = round(
        sum(c["unrealized_loss"] for c in tlh_candidates), 2
    )

    return {
        "year": year_filter,
        "as_of": today.isoformat(),
        "account_id": account_id,
        "summary": summary_view,
        "tax": tax,
        "matches": matches_out,
        "open_positions": open_out,
        "lt_savings": lt_save,
        "cash_by_account": cash_rows,
        "total_cash": total_cash,
        "by_symbol": by_symbol,
        "top_winners": winners_losers["winners"],
        "top_losers": winners_losers["losers"],
        "quarterly_pacing": quarterly,
        "tlh_candidates": tlh_candidates,
        "tlh_total_savings": tlh_total_savings,
        "tlh_total_loss": tlh_total_loss,
        "accounts": [
            {"id": aid, "name": name}
            for aid, name in account_id_to_name.items()
        ],
        "cross_account_wash_count": cross_account_wash_count,
        "is_account_filtered": account_id is not None,
        "wash_sale_scope": wash_sale_scope,
    }


def _summary_from_matches(matches: list, open_count: int, open_position_txn_ids: Optional[set] = None) -> dict:
    """Re-aggregate the summary numbers from a (possibly filtered)
    list of matches. Mirrors the logic at the bottom of
    compute_realized_pnl so the per-account view stays internally
    consistent.

    `open_position_txn_ids` (optional) is the set of plaid_txn_ids
    that are still open-and-not-fully-consumed lots; passed through
    from the calculator so the per-account summary can compute the
    locked-vs-captured wash-sale split honestly. When None, falls
    back to lumping all wash-disallowed into the captured bucket.
    """
    st_gain = sum(m.gain_loss for m in matches if m.term == "ST" and m.gain_loss > 0)
    st_loss = sum(
        m.gain_loss + m.wash_sale_disallowed
        for m in matches if m.term == "ST" and m.gain_loss < 0
    )
    lt_gain = sum(m.gain_loss for m in matches if m.term == "LT" and m.gain_loss > 0)
    lt_loss = sum(
        m.gain_loss + m.wash_sale_disallowed
        for m in matches if m.term == "LT" and m.gain_loss < 0
    )
    wash = sum(m.wash_sale_disallowed for m in matches)
    wash_locked = 0.0
    wash_captured = 0.0
    if open_position_txn_ids is not None:
        for m in matches:
            if m.wash_sale_disallowed <= 0:
                continue
            replacement_id = getattr(m, "wash_sale_replacement_txn_id", None)
            if replacement_id in open_position_txn_ids:
                wash_locked += m.wash_sale_disallowed
            else:
                wash_captured += m.wash_sale_disallowed
    else:
        wash_captured = wash
    return {
        "st_gain": round(st_gain, 2),
        "st_loss": round(st_loss, 2),
        "st_net": round(st_gain + st_loss, 2),
        "lt_gain": round(lt_gain, 2),
        "lt_loss": round(lt_loss, 2),
        "lt_net": round(lt_gain + lt_loss, 2),
        "wash_sale_disallowed": round(wash, 2),
        "wash_sale_disallowed_locked": round(wash_locked, 2),
        "wash_sale_disallowed_captured": round(wash_captured, 2),
        "net_realized": round(st_gain + st_loss + lt_gain + lt_loss, 2),
        "match_count": len(matches),
        "open_position_count": open_count,
    }


class PreflightSellRequest(BaseModel):
    """Request body for the pre-flight sell simulator. Mirrors the
    minimum needed to drop a hypothetical sell into the realized-P&L
    calculator: which security, how many shares, at what assumed price."""
    plaid_security_id: str = Field(..., description="Security to sell (matches the holdings table)")
    quantity: float = Field(..., gt=0, description="Shares to sell (positive)")
    price: float = Field(..., gt=0, description="Assumed per-share sell price")
    year: Optional[int] = Field(None, description="Tax year context. Defaults to current.")
    account_id: Optional[int] = Field(None, description="Restrict baseline to a single account")
    ordinary_marginal_rate: float = Field(0.22, ge=0.0, le=0.50)
    ltcg_rate: float = Field(0.15, ge=0.0, le=0.50)
    state_rate: float = Field(0.0425, ge=0.0, le=0.15)
    wash_sale_scope: str = Field(
        "all_accounts",
        description="'all_accounts' (IRS rule) or 'per_account' (broker-style)",
    )


@router.post("/trading-tax/preflight")
def trading_tax_preflight(
    body: PreflightSellRequest,
    db: Session = Depends(get_db),
):
    """"What if I sold X today?" — runs the realized-P&L calculator
    twice (current state, current state + the hypothetical sell) and
    returns the diff. The killer pre-trade safety check: surfaces wash-
    sale risk and the dollar tax delta BEFORE you place the trade in
    your broker.

    Body: see PreflightSellRequest.

    Response includes the baseline summary, the with-hypothetical
    summary, the delta, the matches generated by the hypothetical, a
    recommendation tier ('proceed' / 'caution' / 'avoid'), and a
    human-readable explanation of any wash-sale risk.
    """
    today = datetime.date.today()
    year_filter = body.year if body.year is not None else today.year
    start = datetime.date(year_filter, 1, 1)
    end = datetime.date(year_filter, 12, 31)

    q = (
        db.query(InvestmentTransaction)
        .options(joinedload(InvestmentTransaction.security))
        .filter(
            InvestmentTransaction.date >= start,
            InvestmentTransaction.date <= end,
        )
        .order_by(InvestmentTransaction.date.asc(), InvestmentTransaction.id.asc())
    )
    if body.account_id is not None:
        q = q.filter(InvestmentTransaction.account_id == body.account_id)
    rows = q.all()

    txns = []
    for r in rows:
        sec = r.security
        txns.append({
            "date": r.date,
            "type": r.type,
            "quantity": r.quantity,
            "price": r.price,
            "fees": r.fees or 0.0,
            "plaid_security_id": r.plaid_security_id,
            "symbol": (sec.ticker_symbol or sec.name or r.plaid_security_id) if sec else r.plaid_security_id,
            "plaid_investment_transaction_id": r.plaid_investment_transaction_id,
            "account_id": r.account_id,
        })

    return simulate_hypothetical_sell(
        transactions=txns,
        plaid_security_id=body.plaid_security_id,
        quantity=body.quantity,
        price=body.price,
        sell_date=today,
        ordinary_marginal_rate=body.ordinary_marginal_rate,
        ltcg_rate=body.ltcg_rate,
        state_rate=body.state_rate,
        wash_sale_scope=body.wash_sale_scope,
        account_id=body.account_id,
    )


@router.get("/trading-tax/form-8949")
def trading_tax_form_8949(
    db: Session = Depends(get_db),
    year: Optional[int] = Query(None, ge=1990, le=2100),
    account_id: Optional[int] = Query(None),
    wash_sale_scope: str = Query("all_accounts"),
):
    """Form 8949 line items as a downloadable CSV.

    Each row is one buy-lot match — exactly the granularity Form 8949
    wants. Box A (short-term covered) and Box D (long-term covered)
    are tagged on each row so the user (or their accountant) can split
    into the right form sections.

    Wash-sale rows carry code 'W' in column (f) and the disallowed
    loss in column (g). Column (h) is the REPORTED gain/loss after the
    wash-sale adjustment — i.e. proceeds - basis + adjustment, which
    nets to $0 for a fully-disallowed loss.

    Filter behavior matches /trading-tax: account_id scopes the export
    to one account; wash_sale_scope picks all_accounts vs per_account
    vs selected_accounts.
    """
    today = datetime.date.today()
    year_filter = year if year is not None else today.year
    start = datetime.date(year_filter, 1, 1)
    end = datetime.date(year_filter, 12, 31)

    rows = (
        db.query(InvestmentTransaction)
        .options(joinedload(InvestmentTransaction.security))
        .filter(
            InvestmentTransaction.date >= start,
            InvestmentTransaction.date <= end,
        )
        .order_by(InvestmentTransaction.date.asc(), InvestmentTransaction.id.asc())
        .all()
    )
    txns = []
    for r in rows:
        sec = r.security
        txns.append({
            "date": r.date,
            "type": r.type,
            "quantity": r.quantity,
            "price": r.price,
            "fees": r.fees or 0.0,
            "plaid_security_id": r.plaid_security_id,
            "symbol": (sec.ticker_symbol or sec.name or r.plaid_security_id) if sec else r.plaid_security_id,
            "plaid_investment_transaction_id": r.plaid_investment_transaction_id,
            "account_id": r.account_id,
        })
    pnl = compute_realized_pnl(txns, as_of=today, wash_sale_scope=wash_sale_scope)

    matches = pnl["matches"]
    if account_id is not None:
        matches = [m for m in matches if m.account_id == account_id]

    form_rows = build_form_8949_rows(matches)

    # Build CSV. Header column names mirror IRS Form 8949 lettering for
    # reconciliation; the leading "Box"+"Term" columns are Tusk Ledger
    # additions to help the accountant split short-vs-long-term.
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "Box", "Term",
        "(a) Description",
        "(b) Date acquired",
        "(c) Date sold",
        "(d) Proceeds",
        "(e) Cost basis",
        "(f) Code",
        "(g) Adjustment",
        "(h) Gain/loss",
    ])
    for r in form_rows:
        writer.writerow([
            r["form_box"], r["term"], r["description"],
            r["date_acquired"], r["date_sold"],
            f"{r['proceeds']:.2f}", f"{r['basis']:.2f}",
            r["code"], f"{r['adjustment']:.2f}", f"{r['gain_loss']:.2f}",
        ])

    filename = f"form-8949-{year_filter}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
