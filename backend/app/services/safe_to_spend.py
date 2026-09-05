""""Safe to spend until payday" — the one number a "can I buy this?" moment needs.

Why this exists: the Dashboard already computes checking balances, upcoming
bills, recurring income and budget pace — but a user standing in a store
has to open four different pages and do the subtraction themselves. This
module does the subtraction once, in one place, and names every term in
the answer so it can be trusted (and argued with) rather than treated as
a black box.

    safe_to_spend = spendable_cash − bills_due − budget_remaining_pro_rata

Every input is a REUSE of an existing, already-tested computation:
  - next paycheck date: app.services.recurring.detect_streams (the same
    detector cash_flow_forecast and the Recurring page use)
  - bills before payday: app.routers.bills.collect_upcoming_bills
  - usual spending before payday: app.services.budget_health.budget_adherence
    when a budget exists (so "spent this month" follows the exact same
    personal-only / transfer-excluded / refund rules as the Budgets page),
    else a trailing-90-day variable-spend average

Nothing here re-derives recurring-transaction detection or budget pace —
see AGENTS.md / the recurring.py module docstring for why that discipline
matters (five drifted copies of the same heuristic used to disagree).
"""
from __future__ import annotations

import calendar
import datetime
from collections import defaultdict
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Account, Budget, Transaction
from app.routers.bills import collect_upcoming_bills
from app.services.budget_health import budget_adherence
from app.services.merchant_normalizer import normalize as normalize_merchant
from app.services.recurring import detect_streams
from app.services.transaction_view import expand

# Only these count as "cash you can spend right now" — a savings account
# is real money but spending it needs a deliberate transfer first, so it's
# reported separately (see savings_cash) rather than folded into the
# headline number.
_CHECKING_SUBTYPES = {"checking"}
_SAVINGS_SUBTYPES = {"savings"}

# How far back to look for a recurring paycheck cadence. 180 days covers
# even a monthly-paid stream with room to spare (6 occurrences) while
# staying short enough that an old job's deposits age out on their own.
_INCOME_LOOKBACK_DAYS = 180

# Same lookback used for the "bills the recurring detector knows about but
# collect_upcoming_bills doesn't" pass (subscriptions/utilities have no
# MortgageDetail/CreditCardDetail row — only those two feed the bills
# aggregator; see routers/bills.py's module docstring).
_RECURRING_OUTFLOW_LOOKBACK_DAYS = 180

# Trailing-average fallback window when no budget exists for the month.
_TRAILING_AVERAGE_DAYS = 90


def _normalize_name(name: Optional[str]) -> str:
    """Lowercase, normalized merchant/account name for fuzzy de-dup matching."""
    if not name:
        return ""
    return (normalize_merchant(name) or name).strip().lower()


def _forecast_merchant_key(t: Transaction) -> str:
    raw = (t.merchant_name or t.name or "Unknown").strip()
    return normalize_merchant(raw) or raw


def _spendable_and_savings_cash(db: Session) -> tuple[float, float]:
    """Checking balances are spendable; savings is reported but excluded."""
    accounts = db.query(Account).filter(Account.type == "depository").all()
    spendable = sum(
        (a.current_balance or 0.0) for a in accounts
        if (a.subtype or "").lower() in _CHECKING_SUBTYPES
    )
    savings = sum(
        (a.current_balance or 0.0) for a in accounts
        if (a.subtype or "").lower() in _SAVINGS_SUBTYPES
    )
    return round(spendable, 2), round(savings, 2)


def next_paycheck(db: Session, today: datetime.date) -> tuple[datetime.date, str]:
    """Soonest projected recurring-income date, or the 1st-of-next-month fallback.

    Pre-filters to non-transfer, non-refund inflows (amount < 0) BEFORE
    handing rows to detect_streams — a run of store-return refunds at the
    same merchant is an inflow cadence too, and without this filter it
    could get mistaken for a paycheck.
    """
    cutoff = today - datetime.timedelta(days=_INCOME_LOOKBACK_DAYS)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff,
            Transaction.date <= today,
            Transaction.is_transfer.is_(False),
            Transaction.amount < 0,
            Transaction.is_refund.is_(False),
        )
        .order_by(Transaction.date)
        .all()
    )
    streams = detect_streams(txns, merchant_key=_forecast_merchant_key)
    income_streams = [s for s in streams if s.is_income]

    candidates: list[datetime.date] = []
    for s in income_streams:
        interval = max(int(s.median_interval), 1)
        # A stream that has missed two full cadences plus a short posting
        # grace period is stale. Continuing to roll it forward would turn an
        # old employer into a phantom paycheck indefinitely.
        if (today - s.last_date).days > (2 * interval + 3):
            continue
        nxt = s.last_date + datetime.timedelta(days=interval)
        # Roll forward past any gap (a stream detected weeks ago is still a
        # valid cadence — we just want the NEXT occurrence from today).
        while nxt < today:
            nxt += datetime.timedelta(days=interval)
        candidates.append(nxt)

    if candidates:
        return min(candidates), "recurring_income"

    # No detectable income stream: fall back to the 1st of next month —
    # a conservative "assume the worst, budget for a full month" default.
    if today.month == 12:
        fallback = datetime.date(today.year + 1, 1, 1)
    else:
        fallback = datetime.date(today.year, today.month + 1, 1)
    return fallback, "month_end_fallback"


def _bills_before_payday(
    db: Session,
    today: datetime.date,
    next_paycheck_date: datetime.date,
    days_until_paycheck: int,
) -> tuple[float, list[dict]]:
    """Upcoming bills + recurring outflows due before the next paycheck.

    Two sources, de-duplicated by normalized name so a mortgage that shows
    up both as a MortgageDetail row (collect_upcoming_bills) and as its
    own recurring cadence isn't counted twice — only an exact normalized account name or alias suppresses a recurring
    copy. Substring matches can hide unrelated obligations.
    """
    items: list[dict] = []
    total = 0.0
    seen_names: set[str] = set()

    bills = collect_upcoming_bills(db, days_ahead=days_until_paycheck, today=today)
    for b in bills:
        if b.due_date > next_paycheck_date or b.amount is None:
            continue
        key = _normalize_name(b.account_name)
        if key:
            seen_names.add(key)
        account = db.get(Account, b.account_id)
        if account:
            seen_names.update(
                normalized for name in (account.name, account.custom_name)
                if (normalized := _normalize_name(name))
            )
        items.append({
            "name": b.account_name,
            "date": b.due_date.isoformat(),
            "amount": round(b.amount, 2),
            "source": b.kind,
            "account_id": b.account_id,
        })
        total += b.amount

    cutoff = today - datetime.timedelta(days=_RECURRING_OUTFLOW_LOOKBACK_DAYS)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff,
            Transaction.date <= today,
            Transaction.is_transfer.is_(False),
            Transaction.amount > 0,
        )
        .order_by(Transaction.date)
        .all()
    )
    streams = detect_streams(txns, merchant_key=_forecast_merchant_key)
    for s in streams:
        norm = _normalize_name(s.merchant)
        # Normalization handles known bank aliases; a substring alone
        # does not establish that two differently named bills are one debt.
        if norm and norm in seen_names:
            continue
        interval = max(int(s.median_interval), 1)
        next_date = s.last_date + datetime.timedelta(days=interval)
        while next_date < today:
            next_date += datetime.timedelta(days=interval)
        while next_date <= next_paycheck_date:
            items.append({
                "name": s.merchant,
                "date": next_date.isoformat(),
                "amount": round(s.median_amount, 2),
                "source": "recurring",
            })
            total += s.median_amount
            next_date += datetime.timedelta(days=interval)

    items.sort(key=lambda it: it["date"])
    return round(total, 2), items


def _bill_match_candidates(
    db: Session,
    bills: list[dict],
    today: datetime.date,
) -> list[dict]:
    """Find only high-confidence personal categories for bill overlap.

    Credit-card statement reserves are deliberately excluded. Mortgage and
    recurring bills need an exact normalized merchant/account alias and a
    single personal category across split-aware historical lines. Any mixed
    category or business history leaves the bill conservatively unmatched.
    """
    eligible = [b for b in bills if b.get("source") in {"mortgage", "recurring"}]
    if not eligible:
        return []

    cutoff = today - datetime.timedelta(days=_RECURRING_OUTFLOW_LOOKBACK_DAYS)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff,
            Transaction.date <= today,
            Transaction.is_transfer.is_(False),
        )
        .all()
    )
    matches: list[dict] = []

    for bill in eligible:
        name_key = _normalize_name(bill.get("name"))
        aliases = {name_key} if name_key else set()
        if bill.get("source") == "mortgage" and name_key:
            # collect_upcoming_bills displays custom_name when present. Add
            # the paired account name so either exact identity is accepted.
            account = db.get(Account, bill.get("account_id")) if bill.get("account_id") else None
            if account:
                aliases.update(key for name in (account.name, account.custom_name)
                               if (key := _normalize_name(name)))
        if not aliases:
            continue

        categories: set[str] = set()
        positive_transactions: set[int] = set()
        business_seen = False
        historical_spend = 0.0
        for txn in txns:
            merchant_key = _normalize_name(txn.merchant_name or txn.name)
            if merchant_key not in aliases:
                continue
            for line in expand([txn]):
                if line.business_id is not None:
                    business_seen = True
                    continue
                if line.amount > 0:
                    categories.add(line.category)
                    positive_transactions.add(txn.id)
                    if line.date >= today - datetime.timedelta(days=_TRAILING_AVERAGE_DAYS - 1):
                        historical_spend += line.amount
                elif line.is_refund:
                    categories.add(line.category)
                    if line.date >= today - datetime.timedelta(days=_TRAILING_AVERAGE_DAYS - 1):
                        historical_spend += line.amount

        # Requiring two positive lines keeps a one-off merchant/category
        # coincidence from changing the safe-to-spend equation. Recurring
        # streams already meet this bar by construction.
        if business_seen or len(categories) != 1 or len(positive_transactions) < 2:
            continue
        matches.append({
            "bill": bill,
            "category": next(iter(categories)),
            "aliases": aliases,
            "historical_spend": historical_spend,
        })
    return matches


def _segment_bill_matches(
    matches: list[dict],
    segment_start: datetime.date,
    segment_end: datetime.date,
) -> list[dict]:
    """Return matched bills whose due date is inside a half-open segment."""
    selected: list[dict] = []
    for match in matches:
        try:
            due_date = datetime.date.fromisoformat(match["bill"]["date"])
        except (KeyError, TypeError, ValueError):
            continue
        if segment_start <= due_date < segment_end:
            selected.append(match)
    return selected


def _budget_remaining_pro_rata(
    db: Session,
    today: datetime.date,
    days_until_paycheck: int,
) -> tuple[float, str]:
    """Return usual spending before payday, preserving the legacy tuple."""
    total, source, _ = _budget_remaining_pro_rata_details(
        db, today, days_until_paycheck, bills=[]
    )
    return total, source


def _budget_remaining_pro_rata_details(
    db: Session,
    today: datetime.date,
    days_until_paycheck: int,
    bills: list[dict],
) -> tuple[float, str, float]:
    """"What you'd normally spend before payday", pro-rated by calendar month.

    Reuses budget_health.budget_adherence for the spent-MTD figure so this
    number can never disagree with the Budgets page about what counts as
    personal spend (transfers excluded, Business line excluded, split-aware).

    A payday window can cross a month boundary. Each month's remaining budget
    is therefore prorated over that month's remaining days. A future month's
    budget starts with zero observed spend as of ``today``; moving the
    adherence date into the future would incorrectly count scheduled ledger
    rows as already spent.
    """
    fallback_daily_rate, fallback_source = _trailing_average_daily_rate(db, today)
    bill_matches = _bill_match_candidates(db, bills, today)

    total = 0.0
    overlap_adjustment = 0.0
    sources: set[str] = set()
    window_end = today + datetime.timedelta(days=days_until_paycheck)
    segment_start = today
    current_month = today.replace(day=1)

    while segment_start < window_end:
        days_in_month = calendar.monthrange(segment_start.year, segment_start.month)[1]
        month_end = segment_start.replace(day=days_in_month)
        month_end_exclusive = month_end + datetime.timedelta(days=1)
        segment_end = min(month_end_exclusive, window_end)
        covered_days = (segment_end - segment_start).days

        # The first segment starts at today, so today is included in the
        # remaining-days denominator. Every later segment starts on day one.
        if segment_start.replace(day=1) == current_month:
            remaining_days = days_in_month - today.day + 1
        else:
            remaining_days = days_in_month

        if segment_start.replace(day=1) == current_month:
            adherence = budget_adherence(db, today=today)
        else:
            # A future month's adherence cannot be evaluated by moving
            # ``today`` forward: that would treat scheduled future ledger
            # rows as already spent. A future budget has no observed spend
            # as of the real today, so load its positive personal lines
            # directly and start from the full limits.
            budget = (
                db.query(Budget)
                .filter_by(month=segment_start.month, year=segment_start.year)
                .first()
            )
            adherence = None
            if budget is not None:
                lines = [
                    c for c in budget.categories
                    if c.category != "Business" and (c.limit_amount or 0) > 0
                ]
                if lines:
                    adherence = {
                        "detail": [
                            {
                                "category": c.category,
                                "limit": round(float(c.limit_amount), 2),
                                "spent": 0.0,
                            }
                            for c in lines
                        ]
                    }
        if adherence is not None:
            category_allowances: dict[str, float] = defaultdict(float)
            for line in adherence["detail"]:
                category_allowances[line["category"]] += (
                    max(line["limit"] - line["spent"], 0.0)
                    * covered_days
                    / max(remaining_days, 1)
                )
            total_remaining = sum(category_allowances.values())

            reserved_by_category: dict[str, float] = defaultdict(float)
            for match in _segment_bill_matches(bill_matches, segment_start, segment_end):
                reserved_by_category[match["category"]] += max(
                    float(match["bill"].get("amount") or 0.0), 0.0
                )
            segment_overlap = sum(
                min(category_allowances[category], reserved)
                for category, reserved in reserved_by_category.items()
            )
            total += total_remaining - segment_overlap
            overlap_adjustment += segment_overlap
            sources.add("budget")
        else:
            segment_allowance = fallback_daily_rate * covered_days
            # The trailing baseline includes historical bill spend. Remove
            # only the portion attributable to a confidently matched bill
            # that is actually reserved in this same segment.
            reserved_by_identity: dict[tuple[tuple[str, ...], str], float] = defaultdict(float)
            historical_by_identity: dict[tuple[tuple[str, ...], str], float] = {}
            for match in _segment_bill_matches(bill_matches, segment_start, segment_end):
                identity = (tuple(sorted(match["aliases"])), match["category"])
                reserved_by_identity[identity] += max(
                    float(match["bill"].get("amount") or 0.0), 0.0
                )
                historical_by_identity[identity] = match["historical_spend"]
            segment_overlap = sum(
                min(
                    max(historical_by_identity[identity], 0.0)
                    * covered_days
                    / _TRAILING_AVERAGE_DAYS,
                    reserved,
                )
                for identity, reserved in reserved_by_identity.items()
            )
            segment_overlap = min(segment_overlap, segment_allowance)
            total += segment_allowance - segment_overlap
            overlap_adjustment += segment_overlap
            sources.add(fallback_source)

        segment_start = segment_end

    if len(sources) == 1:
        return round(total, 2), sources.pop(), round(overlap_adjustment, 2)
    if not sources:
        return 0.0, "none", round(overlap_adjustment, 2)
    return round(total, 2), "mixed", round(overlap_adjustment, 2)


def _trailing_average_daily_rate(
    db: Session,
    today: datetime.date,
) -> tuple[float, str]:
    """Return the trailing variable-spend rate and its source label."""
    # No budget for a covered month: fall back to a trailing daily
    # variable-spend rate. Mirrors the personal/transfer/refund rules
    # routers/analytics.py uses elsewhere (spending = amount > 0 OR
    # is_refund, business excluded) rather than budget_health's category-keyed
    # version, since there's no per-category limit to key off of here.
    since = today - datetime.timedelta(days=_TRAILING_AVERAGE_DAYS - 1)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= since,
            Transaction.date <= today,
            Transaction.is_transfer.is_(False),
        )
        .all()
    )
    if not txns:
        return 0.0, "none"

    variable_spend = 0.0
    for line in expand(txns):
        if line.business_id is not None:
            continue
        if line.amount > 0 or line.is_refund:
            variable_spend += line.amount  # refund lines are negative: they net out
    daily_rate = max(variable_spend, 0.0) / _TRAILING_AVERAGE_DAYS
    return daily_rate, "trailing_average"


def compute_safe_to_spend(db: Session, today: Optional[datetime.date] = None) -> dict:
    """Build the full /analytics/safe-to-spend response. Pure given `today`."""
    today = today or datetime.date.today()

    spendable_cash, savings_cash = _spendable_and_savings_cash(db)
    next_paycheck_date, next_paycheck_source = next_paycheck(db, today)
    days_until_paycheck = max((next_paycheck_date - today).days, 1)
    bills_due, bills = _bills_before_payday(db, today, next_paycheck_date, days_until_paycheck)
    budget_remaining_pro_rata, budget_source, spending_overlap_adjustment = (
        _budget_remaining_pro_rata_details(
            db, today, days_until_paycheck, bills
        )
    )
    safe_to_spend = spendable_cash - bills_due - budget_remaining_pro_rata

    notes = [
        "Savings not counted toward safe-to-spend.",
        "Estimate based on current balances and past patterns; paycheck dates are not confirmed.",
        "Bills may overlap with budget or average spending, making this estimate conservative.",
    ]
    if next_paycheck_source == "month_end_fallback":
        notes.append(
            "No recent recurring income detected; assuming your next paycheck lands "
            "on the 1st of next month."
        )
    if budget_source == "trailing_average":
        notes.append(
            "No budget set for this month; using your trailing 90-day average "
            "spend instead."
        )
    elif budget_source == "mixed":
        notes.append(
            "Some months before payday use a budget, while others use your "
            "trailing average or have no spending history."
        )
    elif budget_source == "none":
        notes.append("No budget and no spending history yet — nothing counted "
                      "toward usual spending before payday.")
    if spending_overlap_adjustment > 0:
        notes.append(
            "Identified bill payments were reserved once and removed from "
            "the overlapping usual-spending allowance."
        )

    return {
        "as_of": today.isoformat(),
        "safe_to_spend": round(safe_to_spend, 2),
        "spendable_cash": spendable_cash,
        "savings_cash": savings_cash,
        "bills_due": bills_due,
        "budget_remaining_pro_rata": budget_remaining_pro_rata,
        "spending_overlap_adjustment": spending_overlap_adjustment,
        "next_paycheck_date": next_paycheck_date.isoformat(),
        "days_until_paycheck": days_until_paycheck,
        "next_paycheck_source": next_paycheck_source,
        "budget_source": budget_source,
        "bills": bills,
        "notes": notes,
    }
