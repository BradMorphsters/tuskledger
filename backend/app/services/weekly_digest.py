"""The weekly digest — "what happened, what's coming, what changed" in one read.

Why this exists: Tusk Ledger already computes everything a once-a-week
user needs (spending deltas, upcoming bills, budget pace, net worth
movement) but each lives on its own page. A person who only opens the
app on Sundays gets none of that value unless it's assembled into a
single page for them. This module is that assembly — every number here
is produced by calling an existing, already-tested function; nothing
below re-derives recurring detection, budget pace or refund/transfer
rules from scratch (see recurring.py's module docstring for why that
discipline matters).

Reused directly:
  - app.services.safe_to_spend.next_paycheck — Feature 1's paycheck-date
    projection, for the "coming" section.
  - app.routers.bills.collect_upcoming_bills — the "coming" bills list.
  - app.services.budget_health.budget_adherence — budget-pace status.
  - app.services.transaction_view.expand — split-aware line iteration.
  - app.services.recurring.detect_streams — the canonical recurring
    detector, for the price-hike ("notable") signal.

Deliberately NOT a direct call to routers/analytics.py's get_insights():
that endpoint hardwires `date.today()` for its 14-day/2-year windows,
so it can't be pointed at an arbitrary `week_ending` and stay
deterministic for tests. Rather than import a router function and fight
its hidden "today", the first-time-merchant and large-transaction
signals below are re-parametrized versions of the same rules (thresholds
and lookback windows copied verbatim from get_insights) over the
digest's own window. The price-hike signal doesn't have this problem —
its anomaly math never reads "today" — so it calls detect_streams
directly rather than duplicating detect_recurring's next-date logic.
"""
from __future__ import annotations

import datetime
from collections import defaultdict
from typing import Optional

from sqlalchemy.orm import Session

from app.models import NetWorthSnapshot, Transaction
from app.routers.bills import collect_upcoming_bills
from app.services.budget_health import budget_adherence
from app.services.merchant_normalizer import normalize as normalize_merchant
from app.services.recurring import detect_streams
from app.services.safe_to_spend import next_paycheck
from app.services.transaction_view import expand

# Same thresholds get_insights (routers/analytics.py) uses for its
# first-time-merchant / large-transaction / recurring-anomaly signals —
# kept identical so "notable" here never disagrees with the Insights page.
_NEW_MERCHANT_MIN_AMOUNT = 50.0
_NEW_MERCHANT_LOOKBACK_DAYS = 730
_LARGE_TXN_LOOKBACK_DAYS = 365
_LARGE_TXN_MULTIPLE = 2.0
_LARGE_TXN_MIN_PRIOR_OCCURRENCES = 3
_PRICE_HIKE_LOOKBACK_DAYS = 365
_PRICE_HIKE_THRESHOLD_PCT = 25.0

_TOP_N = 5


def _merchant_key(t: Transaction) -> str:
    raw = (t.merchant_name or t.name or "Unknown").strip()
    return normalize_merchant(raw) or raw


def _week_txns(db: Session, start: datetime.date, end: datetime.date, *, exclude_transfers: bool = True):
    q = db.query(Transaction).filter(Transaction.date >= start, Transaction.date <= end)
    if exclude_transfers:
        q = q.filter(Transaction.is_transfer.is_(False))
    return q.all()


def _spend_and_income(txns) -> tuple[float, float]:
    """Personal spend / income totals for a batch of transactions.

    Convention (see routers/analytics.py "spending = amount > 0 or
    is_refund"): a refund is a negative-amount inflow that nets against
    the spend side rather than counting as income.
    """
    spend = 0.0
    income = 0.0
    for line in expand(txns):
        if line.amount > 0 or line.is_refund:
            spend += line.amount
        elif line.amount < 0:
            income += -line.amount
    return round(spend, 2), round(income, 2)


def _spend_by_category(txns) -> dict[str, float]:
    out: dict[str, float] = defaultdict(float)
    for line in expand(txns):
        if line.amount > 0 or line.is_refund:
            out[line.category or "Uncategorized"] += line.amount
    return dict(out)


def _spend_by_merchant(txns) -> dict[str, float]:
    out: dict[str, float] = defaultdict(float)
    for line in expand(txns):
        if line.amount > 0 or line.is_refund:
            name = normalize_merchant(line.merchant or "") or (line.merchant or "Unknown")
            out[name] += line.amount
    return dict(out)


def _happened(db: Session, week_start: datetime.date, week_end: datetime.date) -> dict:
    cur_txns = _week_txns(db, week_start, week_end)
    prior_start = week_start - datetime.timedelta(days=7)
    prior_end = week_start - datetime.timedelta(days=1)
    prior_txns = _week_txns(db, prior_start, prior_end)

    cur_spend, cur_income = _spend_and_income(cur_txns)
    prior_spend, prior_income = _spend_and_income(prior_txns)

    def _delta(cur: float, prior: float) -> dict:
        d = round(cur - prior, 2)
        pct = round((d / prior) * 100, 1) if prior else None
        return {"amount": d, "pct": pct}

    cur_cats = _spend_by_category(cur_txns)
    prior_cats = _spend_by_category(prior_txns)
    top_categories = [
        {
            "category": cat,
            "amount": round(amt, 2),
            "prior_amount": round(prior_cats.get(cat, 0.0), 2),
            "delta": round(amt - prior_cats.get(cat, 0.0), 2),
        }
        for cat, amt in sorted(cur_cats.items(), key=lambda kv: kv[1], reverse=True)[:_TOP_N]
    ]

    cur_merchants = _spend_by_merchant(cur_txns)
    top_merchants = [
        {"merchant": m, "amount": round(amt, 2)}
        for m, amt in sorted(cur_merchants.items(), key=lambda kv: kv[1], reverse=True)[:_TOP_N]
    ]

    # "New transactions" is ledger activity, not spend — include transfers
    # (a bill payment or internal move still happened this week) but the
    # refund count only makes sense against inflow rows.
    all_txns = _week_txns(db, week_start, week_end, exclude_transfers=False)

    return {
        "spend": cur_spend,
        "spend_delta": _delta(cur_spend, prior_spend),
        "income": cur_income,
        "income_delta": _delta(cur_income, prior_income),
        "top_categories": top_categories,
        "top_merchants": top_merchants,
        "transaction_count": len(all_txns),
        "refund_count": sum(1 for t in all_txns if t.is_refund),
    }


def _notable(db: Session, week_start: datetime.date, week_end: datetime.date) -> dict:
    cur_txns = _week_txns(db, week_start, week_end)

    # First-time merchants: same rule as get_insights Signal 2, windowed
    # on [week_start, week_end] instead of "the last 14 days".
    seen_cutoff = week_start - datetime.timedelta(days=_NEW_MERCHANT_LOOKBACK_DAYS)
    prior_rows = (
        db.query(Transaction.merchant_name, Transaction.name)
        .filter(
            Transaction.date < week_start,
            Transaction.date >= seen_cutoff,
            Transaction.is_transfer.is_(False),
        )
        .distinct()
        .all()
    )
    seen_merchants = {
        normalize_merchant(mn or nm or "").lower()
        for mn, nm in prior_rows
        if (mn or nm)
    }
    new_merchant_hits: dict[str, float] = defaultdict(float)
    for t in cur_txns:
        if t.amount is None or t.amount <= _NEW_MERCHANT_MIN_AMOUNT:
            continue
        norm = normalize_merchant(t.merchant_name or t.name or "")
        if norm and norm.lower() not in seen_merchants:
            new_merchant_hits[norm] = max(new_merchant_hits[norm], t.amount)
    new_merchants = [
        {"merchant": m, "amount": round(a, 2)}
        for m, a in sorted(new_merchant_hits.items(), key=lambda kv: kv[1], reverse=True)[:_TOP_N]
    ]

    # Unusually large transactions: same rule as get_insights Signal 3.
    hist_cutoff = week_start - datetime.timedelta(days=_LARGE_TXN_LOOKBACK_DAYS)
    hist_rows = (
        db.query(Transaction.amount, Transaction.merchant_name, Transaction.name)
        .filter(
            Transaction.amount > 0,
            Transaction.date < week_start,
            Transaction.date >= hist_cutoff,
            Transaction.is_transfer.is_(False),
        )
        .all()
    )
    merchant_history: dict[str, list[float]] = defaultdict(list)
    for amount, mn, nm in hist_rows:
        norm = normalize_merchant(mn or nm or "")
        if norm:
            merchant_history[norm.lower()].append(amount)
    large_txns = []
    for t in cur_txns:
        if t.amount is None or t.amount <= 0:
            continue
        norm = normalize_merchant(t.merchant_name or t.name or "")
        if not norm:
            continue
        hist = merchant_history.get(norm.lower())
        if not hist or len(hist) < _LARGE_TXN_MIN_PRIOR_OCCURRENCES:
            continue
        median_amt = sorted(hist)[len(hist) // 2]
        if t.amount > median_amt * _LARGE_TXN_MULTIPLE:
            large_txns.append({
                "merchant": norm,
                "date": t.date.isoformat(),
                "amount": round(t.amount, 2),
                "typical_amount": round(median_amt, 2),
            })
    large_txns.sort(key=lambda c: c["amount"], reverse=True)
    large_txns = large_txns[:_TOP_N]

    # Price hikes: reuse detect_streams (not detect_recurring, which lives
    # in routers/analytics.py and importing it here would create a cycle
    # — analytics.py imports this module for the /weekly-digest route) to
    # establish each merchant's BASELINE cadence from history strictly
    # BEFORE this week, then compare this week's actual charge to that
    # baseline median ourselves. This deliberately does NOT reuse
    # detect_recurring's own is_anomalous field: that field is computed
    # from a stream whose amount list already INCLUDES the latest charge,
    # so a hike big enough to be "anomalous" (>25%) is also big enough to
    # fail the same detector's own tolerance-of-25%-from-median admission
    # check for outflows — the two thresholds can never both be satisfied
    # by the same point. Comparing the new charge against a baseline that
    # excludes it sidesteps that collision while still reusing
    # detect_streams for the cadence/median detection itself.
    hike_cutoff = week_start - datetime.timedelta(days=_PRICE_HIKE_LOOKBACK_DAYS)
    baseline_txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= hike_cutoff,
            Transaction.date < week_start,
            Transaction.is_transfer.is_(False),
        )
        .order_by(Transaction.date)
        .all()
    )
    baseline_by_merchant = {
        s.merchant: s
        for s in detect_streams(baseline_txns, merchant_key=_merchant_key)
        if not s.is_income and s.median_amount > 0
    }
    price_hike_hits: dict[str, dict] = {}
    for t in cur_txns:
        if t.amount is None or t.amount <= 0:
            continue
        stream = baseline_by_merchant.get(_merchant_key(t))
        if stream is None:
            continue
        delta_pct = ((t.amount - stream.median_amount) / stream.median_amount) * 100
        if delta_pct <= _PRICE_HIKE_THRESHOLD_PCT:
            continue
        existing = price_hike_hits.get(stream.merchant)
        if existing is None or delta_pct > existing["delta_pct"]:
            price_hike_hits[stream.merchant] = {
                "merchant": stream.merchant,
                "latest_amount": round(t.amount, 2),
                "typical_amount": round(stream.median_amount, 2),
                "delta_pct": round(delta_pct, 1),
            }
    price_hikes = sorted(price_hike_hits.values(), key=lambda c: c["delta_pct"], reverse=True)[:_TOP_N]

    return {
        "new_merchants": new_merchants,
        "large_transactions": large_txns,
        "price_hikes": price_hikes,
    }


def _coming(db: Session, week_end: datetime.date) -> dict:
    bills = collect_upcoming_bills(db, days_ahead=14, today=week_end)
    next_date, next_source = next_paycheck(db, week_end)
    return {
        "bills": [
            {
                "name": b.account_name,
                "date": b.due_date.isoformat(),
                "days_until": b.days_until,
                "amount": b.amount,
                "kind": b.kind,
            }
            for b in bills
        ],
        "next_paycheck_date": next_date.isoformat(),
        "next_paycheck_source": next_source,
    }


def _budget_status(db: Session, week_end: datetime.date) -> Optional[dict]:
    adherence = budget_adherence(db, today=week_end)
    if adherence is None:
        return None
    return {
        "month": adherence["month"],
        "year": adherence["year"],
        "score": adherence["score"],
        "on_pace": adherence["on_pace"],
        "lines": adherence["lines"],
        "over_pace": [d for d in adherence["detail"] if d["score"] < 100],
    }


def _net_worth_change(db: Session, week_end: datetime.date) -> Optional[dict]:
    latest = (
        db.query(NetWorthSnapshot)
        .filter(NetWorthSnapshot.date <= week_end)
        .order_by(NetWorthSnapshot.date.desc())
        .first()
    )
    if latest is None:
        return None
    prior_target = week_end - datetime.timedelta(days=7)
    prior = (
        db.query(NetWorthSnapshot)
        .filter(NetWorthSnapshot.date <= prior_target)
        .order_by(NetWorthSnapshot.date.desc())
        .first()
    )
    return {
        "date": latest.date.isoformat(),
        "net_worth": latest.net_worth,
        "prior_date": prior.date.isoformat() if prior else None,
        "prior_net_worth": prior.net_worth if prior else None,
        "delta": round(latest.net_worth - prior.net_worth, 2) if prior else None,
    }


def _action_items(db: Session, week_start: datetime.date, week_end: datetime.date) -> dict:
    week_txns = _week_txns(db, week_start, week_end)
    # Transfer-labelled outflows the transfer detector never paired —
    # is_transfer stays False so they still show up as (mislabeled) spend.
    unpaired_transfers = sum(
        1 for t in week_txns
        if t.amount is not None and t.amount > 0
        and (t.custom_category or t.category) == "Transfer"
    )
    uncategorized = sum(
        1 for t in week_txns
        if (t.custom_category or t.category or "Uncategorized") == "Uncategorized"
    )
    return {
        "unpaired_transfers": {"count": unpaired_transfers, "url": "/transactions"},
        "uncategorized": {"count": uncategorized, "url": "/transactions"},
    }


def compute_weekly_digest(db: Session, week_ending: Optional[datetime.date] = None) -> dict:
    """Build the full /analytics/weekly-digest response. Pure given `week_ending`."""
    week_end = week_ending or datetime.date.today()
    week_start = week_end - datetime.timedelta(days=6)  # 7-day inclusive window

    return {
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "happened": _happened(db, week_start, week_end),
        "notable": _notable(db, week_start, week_end),
        "coming": _coming(db, week_end),
        "budget_status": _budget_status(db, week_end),
        "net_worth": _net_worth_change(db, week_end),
        "action_items": _action_items(db, week_start, week_end),
    }
