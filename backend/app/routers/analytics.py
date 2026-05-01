"""Analytics routes — rules, recurring detection, merchant insights, reports, export."""
from __future__ import annotations

import csv
import io
import json
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.config import settings
from app.database import get_db
from app.models import (
    Account, CategoryRule, CreditCardDetail, ManualAsset,
    MortgageDetail, Transaction, NetWorthSnapshot,
)
from app.schemas.schemas import InsightCard, InsightsResponse, RuleApplyResult
from app.services.categories import STANDARD_CATEGORIES, CATEGORY_ICONS, map_plaid_category
from app.services.insights_narrative import (
    DEMO_NARRATIVE, build_insights_bundle, build_user_prompt, SYSTEM_PROMPT,
)
from app.services.llm_ollama import LLMUnavailable, OllamaClient
from app.services.merchant_normalizer import normalize as normalize_merchant
from app.services.tax import HSA_LIMITS, hsa_limit
from app.services.transaction_view import expand

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


# ─── Category Rules ────────────────────────────────────────────
@router.get("/rules")
def list_rules(db: Session = Depends(get_db)):
    rules = db.query(CategoryRule).order_by(CategoryRule.pattern).all()
    return [{"id": r.id, "pattern": r.pattern, "category": r.category} for r in rules]


@router.post("/rules")
def create_rule(body: dict, db: Session = Depends(get_db)):
    pattern = body.get("pattern", "").strip().lower()
    category = body.get("category", "").strip()
    if not pattern or not category:
        raise HTTPException(400, "pattern and category are required")

    existing = db.query(CategoryRule).filter_by(pattern=pattern).first()
    if existing:
        existing.category = category
    else:
        db.add(CategoryRule(pattern=pattern, category=category))
    db.commit()

    # Retroactively apply this rule to existing transactions
    applied = apply_rule_to_existing(db, pattern, category)
    return {"status": "ok", "pattern": pattern, "category": category, "retroactively_applied": applied}


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int, db: Session = Depends(get_db)):
    rule = db.query(CategoryRule).filter_by(id=rule_id).first()
    if not rule:
        raise HTTPException(404, "Rule not found")
    db.delete(rule)
    db.commit()
    return {"status": "deleted"}


@router.post("/rules/{rule_id}/apply")
def apply_category_rule(rule_id: int, db: Session = Depends(get_db)):
    """
    Retroactively apply a category rule to all matching transactions.

    Match logic: pattern substring in (merchant_name + " " + name).lower()
    - If custom_category is null OR equals the rule's category, update it
    - If custom_category is already set to a DIFFERENT category, skip (don't overwrite)

    Returns count of matched and actually updated transactions.
    """
    rule = db.query(CategoryRule).filter_by(id=rule_id).first()
    if not rule:
        raise HTTPException(404, "Rule not found")

    # Find all matching transactions
    all_txns = db.query(Transaction).all()
    update_ids = []

    pattern_lower = rule.pattern.lower()
    for txn in all_txns:
        search_text = (
            ((txn.merchant_name or "") + " " + (txn.name or "")).lower()
        )
        if pattern_lower in search_text:
            # This transaction matches the pattern
            if txn.custom_category is None or txn.custom_category == rule.category:
                # Safe to update: either uncategorized or already this category
                update_ids.append(txn.id)

    # Single SQL update for all matched transactions
    updated_count = 0
    if update_ids:
        updated_count = (
            db.query(Transaction)
            .filter(Transaction.id.in_(update_ids))
            .update({"custom_category": rule.category}, synchronize_session="fetch")
        )
        db.commit()

    return RuleApplyResult(
        rule_id=rule_id,
        pattern=rule.pattern,
        category=rule.category,
        matched=len(update_ids),
        updated=updated_count,
    )



def apply_rule_to_existing(db: Session, pattern: str, category: str) -> int:
    """Apply a category rule to all existing transactions matching the pattern."""
    txns = db.query(Transaction).filter(
        Transaction.custom_category.is_(None)
    ).all()
    count = 0
    for t in txns:
        search_text = ((t.merchant_name or "") + " " + (t.name or "")).lower()
        if pattern in search_text:
            t.custom_category = category
            count += 1
    db.commit()
    return count


def apply_all_rules(db: Session, transaction: Transaction):
    """Apply all category rules to a single transaction. Called during sync."""
    if transaction.custom_category:
        return  # User already set a custom category
    rules = db.query(CategoryRule).all()
    search_text = ((transaction.merchant_name or "") + " " + (transaction.name or "")).lower()
    for rule in rules:
        if rule.pattern in search_text:
            transaction.custom_category = rule.category
            break


# ─── Recurring Transactions / Subscriptions ─────────────────
FREQUENCY_BANDS = (
    ("weekly", 6, 8, 52),
    ("bi-weekly", 13, 16, 26),
    ("monthly", 27, 35, 12),
    ("quarterly", 85, 100, 4),
    ("annual", 350, 380, 1),
)


def _classify_frequency(avg_interval: float):
    """Return (name, per_year_multiplier) or None."""
    for name, lo, hi, mult in FREQUENCY_BANDS:
        if lo <= avg_interval <= hi:
            return name, mult
    return None


def _classify_kind(merchant: str, median_amount: float, frequency: str, category: str | None) -> str:
    """Rough label to help the UI sort: subscription vs bill vs income vs other."""
    name = (merchant or "").lower()
    cat = (category or "").lower()
    # Known subscription keywords
    sub_keywords = (
        "netflix", "spotify", "hulu", "disney", "apple", "adobe", "notion",
        "figma", "github", "dropbox", "onedrive", "youtube", "prime", "hbo",
        "paramount", "peacock", "audible", "chatgpt", "nyt", "substack",
    )
    bill_keywords = ("electric", "gas", "water", "sewer", "utility", "comcast", "xfinity",
                     "verizon", "at&t", "att", "t-mobile", "insurance", "rent", "mortgage")
    if any(k in name for k in sub_keywords):
        return "subscription"
    if any(k in name for k in bill_keywords) or "utilit" in cat or "bill" in cat:
        return "bill"
    if frequency in ("weekly", "bi-weekly") and median_amount < 50:
        return "subscription"
    if frequency == "monthly" and median_amount < 50:
        return "subscription"
    return "bill" if frequency == "monthly" else "other"


@router.get("/recurring")
def detect_recurring(db: Session = Depends(get_db)):
    """Detect recurring transactions by finding merchants with regular intervals.

    In addition to the basic cadence/amount heuristics, each recurring entry
    is enriched with:
      - kind: "subscription" / "bill" / "other" (for UI grouping)
      - latest_amount and latest_vs_median_pct (for anomaly highlighting)
      - is_overdue (next_expected has passed by more than one cadence gap)
      - is_anomalous (latest charge > median by > 25%)
    """
    today = date.today()
    cutoff = today - timedelta(days=365)  # wider window so annual patterns surface
    # Pull both outflows and inflows — the variance check below treats them
    # differently (income is naturally lumpier). Including inflows lets
    # paychecks appear as recurring sources in the UI and feed the forecast.
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff,
            Transaction.is_transfer.is_(False),
        )
        .order_by(Transaction.date)
        .all()
    )

    # Group by NORMALIZED merchant name so different raw descriptions for
    # the same logical merchant ('WITHDRAWAL WF HOME MTG TYPE:...' vs
    # 'Wf Home Mtg Pay Id:...') collapse together. Without this, the
    # mortgage gets fragmented into 3-4 sub-groups, none with enough
    # transactions to trip the cadence detection.
    merchant_txns = defaultdict(list)
    for t in txns:
        raw = (t.merchant_name or t.name or "Unknown").strip()
        key = normalize_merchant(raw) or raw
        merchant_txns[key].append(t)

    recurring = []
    for merchant, txn_list in merchant_txns.items():
        if len(txn_list) < 2:
            continue

        sorted_txns = sorted(txn_list, key=lambda x: x.date)
        amounts = [t.amount for t in sorted_txns]
        dates_ = [t.date for t in sorted_txns]

        # Mixed-sign merchant (refunds + purchases at the same merchant) —
        # not really a recurring pattern. Skip.
        if any(a > 0 for a in amounts) and any(a < 0 for a in amounts):
            continue

        is_income = amounts[0] < 0
        abs_amounts = [abs(a) for a in amounts]
        median_amount = sorted(abs_amounts)[len(abs_amounts) // 2]
        if median_amount <= 0:
            continue

        # Outflows have to be tight (a "monthly bill" that swings 2x is
        # probably not really one bill). Income is naturally lumpier —
        # paychecks vary with overtime, PTO, supplemental pay, bonuses
        # mixed in with regular gross — so allow up to 60% variance on
        # the inflow side.
        tolerance = 0.60 if is_income else 0.25
        if not all(abs(a - median_amount) / median_amount < tolerance for a in abs_amounts):
            continue

        intervals = [(dates_[i + 1] - dates_[i]).days for i in range(len(dates_) - 1)]
        if not intervals:
            continue
        # Median is more robust than mean — for a seasonal merchant
        # (e.g. lawn care: monthly Apr–Oct, dormant Nov–Mar) the winter
        # gap shows up as one ~180-day interval that would skew the mean
        # out of the monthly band entirely. Median ignores it.
        sorted_intervals = sorted(intervals)
        median_interval = sorted_intervals[len(sorted_intervals) // 2]

        classification = _classify_frequency(median_interval)
        if not classification:
            continue
        frequency, per_year = classification

        # ─── Seasonality detection ──────────────────────────
        # If the merchant only charges during a subset of calendar months
        # over the past year, classify as seasonal and record those months.
        # Bound 3..10 distinct months — fewer than 3 isn't really seasonal,
        # more than 10 is just "year-round with one missing month or two."
        active_months = sorted({d.month for d in dates_})
        is_seasonal = 3 <= len(active_months) <= 10
        # Annual cost reflects active months only. For monthly seasonal,
        # this is median × len(active_months) instead of median × 12.
        if is_seasonal and frequency == "monthly":
            annual_multiplier = len(active_months)
        else:
            annual_multiplier = per_year

        last_date = dates_[-1]
        # Next-expected logic: for non-seasonal, simple last_date + interval.
        # For seasonal, if the projected next date falls in an inactive
        # month, push to the 1st of the earliest active month that follows.
        candidate = last_date + timedelta(days=int(median_interval))
        if is_seasonal and candidate.month not in active_months:
            # Find the next active month after `today`.
            cur = max(today, candidate)
            for _ in range(13):
                if cur.month in active_months:
                    break
                # Step to the 1st of next month.
                if cur.month == 12:
                    cur = date(cur.year + 1, 1, 1)
                else:
                    cur = date(cur.year, cur.month + 1, 1)
            next_date = cur
        else:
            next_date = candidate

        latest_amount = abs(amounts[-1])
        latest_delta_pct = round(((latest_amount - median_amount) / median_amount) * 100, 1)
        # Anomaly only meaningful for outflows. For income, a high paycheck
        # (bonus / overtime week) isn't a problem — flagging it would be noise.
        is_anomalous = (not is_income) and latest_delta_pct > 25.0
        # Overdue check: skip for seasonal merchants when today is in their
        # off-season — the absence of a charge is expected, not a missed bill.
        # Also skip for income (an unfreq paycheck means PTO / changed jobs;
        # surfacing that as 'overdue' adds anxiety, not value).
        if is_income or (is_seasonal and today.month not in active_months):
            is_overdue = False
        else:
            is_overdue = (today - last_date).days > int(median_interval * 1.25)

        category = sorted_txns[-1].custom_category or sorted_txns[-1].category or "Uncategorized"
        if is_income:
            kind = "salary" if frequency in ("weekly", "bi-weekly", "monthly") else "income"
        else:
            kind = _classify_kind(merchant, median_amount, frequency, category)

        recurring.append({
            "merchant": merchant,
            "frequency": frequency,
            "kind": kind,
            "is_income": is_income,
            "avg_amount": round(median_amount, 2),
            "latest_amount": round(latest_amount, 2),
            "latest_vs_median_pct": latest_delta_pct,
            "is_anomalous": is_anomalous,
            "is_overdue": is_overdue,
            "is_seasonal": is_seasonal,
            "active_months": active_months,
            "occurrences": len(txn_list),
            "last_date": last_date.isoformat(),
            "next_expected": next_date.isoformat(),
            "category": category,
            "icon": CATEGORY_ICONS.get(category, "📦"),
            "annual_cost": round(median_amount * annual_multiplier, 2),
        })

    # ── Apply user-defined subscription rule overrides ──
    # Two kinds of override:
    #   force_subscription     — flip kind to 'subscription' even if
    #     the auto-detector classified it as something else (e.g. a
    #     gas station hitting the same monthly amount that the
    #     classifier called 'bill').
    #   force_not_subscription — flip kind away from 'subscription' so
    #     the merchant stops showing up in the subscriptions count
    #     and annual-cost total.
    # We also synthesize entries for merchants with only ONE charge
    # so far when they match a force_subscription rule — important for
    # brand-new SaaS signups the user wants to track from day one.
    from app.models import SubscriptionRule
    from app.models.subscription_rule import KIND_FORCE_SUB, KIND_FORCE_NOT_SUB
    sub_rules = db.query(SubscriptionRule).order_by(SubscriptionRule.priority).all()

    def _matches_rules(merchant_text: str, kind_filter: str) -> bool:
        text = merchant_text.lower()
        for r in sub_rules:
            if r.kind == kind_filter and r.pattern.lower() in text:
                return True
        return False

    # Apply overrides to existing entries.
    for r in recurring:
        text = r["merchant"].lower()
        if _matches_rules(text, KIND_FORCE_NOT_SUB):
            if r["kind"] == "subscription":
                r["kind"] = "other"
                r["forced_not_subscription"] = True
        elif _matches_rules(text, KIND_FORCE_SUB):
            if r["kind"] != "subscription":
                r["kind"] = "subscription"
                r["forced_subscription"] = True

    # Synthesize entries for force_subscription merchants that don't
    # show up yet (only 1 occurrence). Search the past 365 days for
    # any transaction whose normalized merchant matches a
    # force_subscription rule but isn't already in the list.
    existing_merchants = {r["merchant"] for r in recurring}
    sub_only_rules = [r for r in sub_rules if r.kind == KIND_FORCE_SUB]
    if sub_only_rules:
        for merchant_key, txn_list in merchant_txns.items():
            if merchant_key in existing_merchants:
                continue
            if not _matches_rules(merchant_key.lower(), KIND_FORCE_SUB):
                continue
            # Use the most recent occurrence as the seed.
            sorted_t = sorted(txn_list, key=lambda x: x.date)
            latest = sorted_t[-1]
            if latest.amount <= 0:
                continue  # income shouldn't get force-flagged as subscription
            # Project the next charge a month out as a default — user
            # can drag it on the calendar to refine.
            next_date = latest.date + timedelta(days=30)
            recurring.append({
                "merchant": merchant_key,
                "frequency": "monthly",
                "kind": "subscription",
                "is_income": False,
                "avg_amount": round(latest.amount, 2),
                "latest_amount": round(latest.amount, 2),
                "latest_vs_median_pct": 0.0,
                "is_anomalous": False,
                "is_overdue": False,
                "is_seasonal": False,
                "active_months": [],
                "occurrences": len(txn_list),
                "last_date": latest.date.isoformat(),
                "next_expected": next_date.isoformat(),
                "category": latest.custom_category or latest.category or "Subscriptions",
                "icon": CATEGORY_ICONS.get(latest.category or "Subscriptions", "📦"),
                "annual_cost": round(latest.amount * 12, 2),
                "forced_subscription": True,
            })

    recurring.sort(key=lambda x: x["annual_cost"], reverse=True)
    # Totals separate income from outflows so the headline "monthly recurring
    # cost" stays a real cost, not net of paychecks.
    outflows = [r for r in recurring if not r.get("is_income")]
    incomes = [r for r in recurring if r.get("is_income")]
    total_annual = sum(r["annual_cost"] for r in outflows)
    total_monthly = round(total_annual / 12, 2)
    income_annual = sum(r["annual_cost"] for r in incomes)
    subs_annual = sum(r["annual_cost"] for r in outflows if r["kind"] == "subscription")
    anomaly_count = sum(1 for r in outflows if r["is_anomalous"])
    overdue_count = sum(1 for r in outflows if r["is_overdue"])

    return {
        "recurring": recurring,
        "total_annual_cost": round(total_annual, 2),
        "total_monthly_cost": total_monthly,
        "total_annual_income": round(income_annual, 2),
        "total_monthly_income": round(income_annual / 12, 2),
        "subscription_annual_cost": round(subs_annual, 2),
        "anomaly_count": anomaly_count,
        "overdue_count": overdue_count,
        "count": len(recurring),
        "income_count": len(incomes),
        "outflow_count": len(outflows),
    }


# ─── Merchant Insights ──────────────────────────────────────
@router.get("/merchants")
def merchant_insights(
    months: int = Query(default=6, le=24),
    db: Session = Depends(get_db),
):
    """Top merchants by total spend, with transaction counts and trends."""
    cutoff = date.today() - timedelta(days=months * 30)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff,
            Transaction.amount > 0,
            Transaction.is_transfer.is_(False),
        )
        .all()
    )

    # Group by the normalized merchant name so raw bank descriptions like
    # 'WITHDRAWAL WF HOME MTG TYPE: AUTO PAY ID: XXXXXX7461 DATA: ACH...'
    # collapse into 'Wells Fargo Mortgage' before aggregation. Without
    # this, the same logical merchant fragments into multiple rows
    # whenever the bank changes its raw description format.
    merchant_data = defaultdict(lambda: {"total": 0.0, "count": 0, "categories": set(), "last_date": None})
    for t in txns:
        raw = (t.merchant_name or t.name or "Unknown").strip()
        key = normalize_merchant(raw) or raw
        d = merchant_data[key]
        d["total"] += t.amount
        d["count"] += 1
        cat = t.custom_category or t.category
        if cat:
            d["categories"].add(cat)
        if d["last_date"] is None or t.date > d["last_date"]:
            d["last_date"] = t.date

    merchants = []
    for name, d in sorted(merchant_data.items(), key=lambda x: x[1]["total"], reverse=True)[:30]:
        cats = list(d["categories"])
        primary_cat = cats[0] if cats else "Uncategorized"
        merchants.append({
            "merchant": name,
            "total": round(d["total"], 2),
            "count": d["count"],
            "avg_transaction": round(d["total"] / d["count"], 2),
            "category": primary_cat,
            "icon": CATEGORY_ICONS.get(primary_cat, "📦"),
            "last_date": d["last_date"].isoformat() if d["last_date"] else None,
        })

    return {"merchants": merchants, "period_months": months}


# ─── Monthly Summary Report ─────────────────────────────────
@router.get("/monthly-report")
def monthly_report(
    month: int = Query(...),
    year: int = Query(...),
    db: Session = Depends(get_db),
):
    """Comprehensive monthly report with MoM comparisons."""
    # Current month
    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month + 1, 1)

    # Previous month
    prev_month = month - 1 if month > 1 else 12
    prev_year = year if month > 1 else year - 1
    prev_start = date(prev_year, prev_month, 1)

    cur_txns = db.query(Transaction).filter(
        Transaction.date >= start,
        Transaction.date < end,
        Transaction.is_transfer.is_(False),
    ).all()
    prev_txns = db.query(Transaction).filter(
        Transaction.date >= prev_start,
        Transaction.date < start,
        Transaction.is_transfer.is_(False),
    ).all()

    def summarize(txns):
        spending = sum(t.amount for t in txns if t.amount > 0)
        income = sum(abs(t.amount) for t in txns if t.amount < 0)
        by_cat = defaultdict(float)
        for t in txns:
            if t.amount > 0:
                cat = t.custom_category or t.category or "Uncategorized"
                by_cat[cat] += t.amount
        top_cats = sorted(by_cat.items(), key=lambda x: x[1], reverse=True)
        top_merchants = defaultdict(float)
        for t in txns:
            if t.amount > 0:
                top_merchants[t.merchant_name or t.name or "Unknown"] += t.amount
        top_merch = sorted(top_merchants.items(), key=lambda x: x[1], reverse=True)[:5]
        return {
            "spending": round(spending, 2),
            "income": round(income, 2),
            "net": round(income - spending, 2),
            "transaction_count": len(txns),
            "top_categories": [{"category": c, "amount": round(a, 2), "icon": CATEGORY_ICONS.get(c, "📦")} for c, a in top_cats[:8]],
            "top_merchants": [{"merchant": m, "amount": round(a, 2)} for m, a in top_merch],
        }

    current = summarize(cur_txns)
    previous = summarize(prev_txns)

    # Calculate changes
    def pct_change(cur, prev):
        if prev == 0:
            return None
        return round(((cur - prev) / prev) * 100, 1)

    # ─── Year-over-year comparison ───────────────────────────
    # Pull the same calendar month from the previous year and compare
    # against current. None when there's no data 12 months back.
    yoy_start = date(year - 1, month, 1)
    yoy_end = date(year, month, 1) if month != 12 else date(year - 1 + 1, 1, 1)
    # Wait: yoy_end should be the start of the next month, in the prior year.
    if month == 12:
        yoy_end = date(year, 1, 1)
    else:
        yoy_end = date(year - 1, month + 1, 1)
    yoy_txns = db.query(Transaction).filter(
        Transaction.date >= yoy_start,
        Transaction.date < yoy_end,
        Transaction.is_transfer.is_(False),
    ).all()
    yoy_summary = summarize(yoy_txns) if yoy_txns else None

    # ─── Category drift — what's notably above its 3-month trailing avg ──
    # Build per-category totals for the last 3 closed months (excluding
    # the current month). Then compare each current-month category to
    # that average; flag anything > 25% above.
    drift_alerts = []
    by_cat_3mo: dict = defaultdict(list)
    for offset in range(1, 4):  # 1, 2, 3 months back from current
        idx_y, idx_m = year, month - offset
        while idx_m <= 0:
            idx_m += 12
            idx_y -= 1
        m_start = date(idx_y, idx_m, 1)
        m_end = date(idx_y + 1, 1, 1) if idx_m == 12 else date(idx_y, idx_m + 1, 1)
        m_txns = db.query(Transaction).filter(
            Transaction.date >= m_start,
            Transaction.date < m_end,
            Transaction.is_transfer.is_(False),
            Transaction.amount > 0,
        ).all()
        m_by_cat: dict = defaultdict(float)
        for t in m_txns:
            cat = t.custom_category or t.category or "Uncategorized"
            m_by_cat[cat] += t.amount
        for cat, amt in m_by_cat.items():
            by_cat_3mo[cat].append(amt)

    # Current-month per-category totals
    cur_by_cat: dict = defaultdict(float)
    for t in cur_txns:
        if t.amount > 0:
            cat = t.custom_category or t.category or "Uncategorized"
            cur_by_cat[cat] += t.amount

    for cat, cur_amt in cur_by_cat.items():
        history = by_cat_3mo.get(cat, [])
        if not history:
            continue
        avg = sum(history) / len(history)
        if avg <= 0:
            continue
        delta_pct = round(((cur_amt - avg) / avg) * 100, 1)
        if delta_pct > 25:  # significantly above trailing avg
            drift_alerts.append({
                "category": cat,
                "icon": CATEGORY_ICONS.get(cat, "📦"),
                "current_amount": round(cur_amt, 2),
                "trailing_3mo_avg": round(avg, 2),
                "delta_pct": delta_pct,
                "delta_dollars": round(cur_amt - avg, 2),
            })

    drift_alerts.sort(key=lambda x: x["delta_pct"], reverse=True)

    return {
        "month": month,
        "year": year,
        "current": current,
        "previous": previous,
        "yoy": yoy_summary,
        "yoy_changes": {
            "spending": pct_change(current["spending"], yoy_summary["spending"]) if yoy_summary else None,
            "income": pct_change(current["income"], yoy_summary["income"]) if yoy_summary else None,
        } if yoy_summary else None,
        "drift_alerts": drift_alerts,
        "changes": {
            "spending": pct_change(current["spending"], previous["spending"]),
            "income": pct_change(current["income"], previous["income"]),
            "net": pct_change(current["net"], previous["net"]) if previous["net"] != 0 else None,
        },
        "insights": generate_insights(current, previous),
    }


def generate_insights(current, previous):
    """Generate human-readable insights from the report data."""
    insights = []

    if previous["spending"] > 0:
        change = ((current["spending"] - previous["spending"]) / previous["spending"]) * 100
        if change > 10:
            insights.append(f"⚠️ Spending increased {abs(change):.0f}% compared to last month")
        elif change < -10:
            insights.append(f"✅ Spending decreased {abs(change):.0f}% compared to last month")

    if current["net"] > 0:
        insights.append(f"💰 You saved {current['net']:,.2f} this month")
    elif current["net"] < 0:
        insights.append(f"📉 You spent ${abs(current['net']):,.2f} more than you earned")

    if current["top_categories"]:
        top = current["top_categories"][0]
        insights.append(f"🏆 Biggest spending category: {top['icon']} {top['category']} (${top['amount']:,.2f})")

    if current["top_merchants"]:
        top = current["top_merchants"][0]
        insights.append(f"🏪 Top merchant: {top['merchant']} (${top['amount']:,.2f})")

    return insights


# ─── Category Trends (MoM, YoY, sparkline history) ───────────
@router.get("/category-trends")
def category_trends(
    month: int = Query(...),
    year: int = Query(...),
    months_back: int = Query(default=6, le=24),
    db: Session = Depends(get_db),
):
    """For each category in the selected month, return its current spend, MoM
    change, YoY change, and a list of the prior `months_back` months of spend
    suitable for a small sparkline."""

    def shift_month(y: int, m: int, by: int) -> tuple[int, int]:
        idx = (y * 12 + (m - 1)) + by
        return idx // 12, (idx % 12) + 1

    def month_start(y: int, m: int) -> date:
        return date(y, m, 1)

    def month_end_excl(y: int, m: int) -> date:
        return date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)

    cur_start, cur_end = month_start(year, month), month_end_excl(year, month)
    prev_y, prev_m = shift_month(year, month, -1)
    yoy_y, yoy_m = shift_month(year, month, -12)
    hist_start_y, hist_start_m = shift_month(year, month, -(months_back - 1))

    earliest = min(month_start(hist_start_y, hist_start_m), month_start(yoy_y, yoy_m))
    latest = max(cur_end, month_end_excl(yoy_y, yoy_m))

    txns = db.query(Transaction).filter(
        Transaction.date >= earliest,
        Transaction.date < latest,
        Transaction.is_transfer.is_(False),
        Transaction.amount > 0,
    ).all()

    by_yc: dict[tuple[int, int], dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for t in txns:
        cat = t.custom_category or t.category or "Uncategorized"
        by_yc[(t.date.year, t.date.month)][cat] += t.amount

    cur_cats = by_yc.get((year, month), {})

    history_months = []
    for i in range(months_back):
        hy, hm = shift_month(year, month, -(months_back - 1 - i))
        history_months.append((hy, hm))

    result = []
    for cat, cur_amount in sorted(cur_cats.items(), key=lambda x: x[1], reverse=True):
        prev_amount = by_yc.get((prev_y, prev_m), {}).get(cat, 0.0)
        yoy_amount = by_yc.get((yoy_y, yoy_m), {}).get(cat, 0.0)
        history = [round(by_yc.get((hy, hm), {}).get(cat, 0.0), 2) for hy, hm in history_months]
        mom_pct = round(((cur_amount - prev_amount) / prev_amount) * 100, 1) if prev_amount > 0 else None
        yoy_pct = round(((cur_amount - yoy_amount) / yoy_amount) * 100, 1) if yoy_amount > 0 else None
        result.append({
            "category": cat,
            "icon": CATEGORY_ICONS.get(cat, "📦"),
            "amount": round(cur_amount, 2),
            "prev_month_amount": round(prev_amount, 2),
            "mom_pct": mom_pct,
            "yoy_amount": round(yoy_amount, 2),
            "yoy_pct": yoy_pct,
            "history": history,
        })

    return {
        "month": month,
        "year": year,
        "months_back": months_back,
        "history_labels": [f"{hy}-{hm:02d}" for hy, hm in history_months],
        "categories": result,
    }


# ─── Spending Patterns (DOW heatmap, forecast, waterfall, income sources) ───
# Categories that count as "fixed" obligations for the cash-flow waterfall.
# The rest of spending is treated as discretionary/variable.
FIXED_CATEGORIES = {
    "Bills & Utilities",
    "Loan Payments",
    "Subscriptions",
    "Government & Taxes",
    "Home",  # mortgage / rent typically lands here
}


@router.get("/spending-patterns")
def spending_patterns(
    month: int = Query(...),
    year: int = Query(...),
    db: Session = Depends(get_db),
):
    """Day-of-week heatmap, MTD forecast, cash-flow waterfall, and income
    source breakdown for the selected month."""
    start = date(year, month, 1)
    end = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    days_in_month = (end - start).days
    today = date.today()

    txns = db.query(Transaction).filter(
        Transaction.date >= start,
        Transaction.date < end,
        Transaction.is_transfer.is_(False),
    ).all()

    spending = [t for t in txns if t.amount > 0]
    income = [t for t in txns if t.amount < 0]
    total_spending = sum(t.amount for t in spending)
    total_income = sum(abs(t.amount) for t in income)

    # Day-of-week (Mon=0..Sun=6 from Python's weekday())
    dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    dow_buckets = defaultdict(lambda: {"total": 0.0, "count": 0})
    for t in spending:
        dow = t.date.weekday()
        dow_buckets[dow]["total"] += t.amount
        dow_buckets[dow]["count"] += 1
    dow_heatmap = [
        {
            "day": dow_names[i],
            "day_index": i,
            "total": round(dow_buckets[i]["total"], 2),
            "count": dow_buckets[i]["count"],
        } for i in range(7)
    ]

    # MTD forecast (only meaningful for the current month)
    is_current = (year == today.year and month == today.month)
    if is_current:
        days_elapsed = today.day
        mtd_spend = sum(t.amount for t in spending if t.date <= today)
        mtd_income = sum(abs(t.amount) for t in income if t.date <= today)
        daily_avg = mtd_spend / max(days_elapsed, 1)
        projected = daily_avg * days_in_month
    else:
        days_elapsed = days_in_month
        mtd_spend = total_spending
        mtd_income = total_income
        daily_avg = total_spending / max(days_in_month, 1)
        projected = total_spending

    forecast = {
        "is_current_month": is_current,
        "mtd_spend": round(mtd_spend, 2),
        "mtd_income": round(mtd_income, 2),
        "days_elapsed": days_elapsed,
        "days_in_month": days_in_month,
        "daily_avg": round(daily_avg, 2),
        "projected_total": round(projected, 2),
    }

    # Cash-flow waterfall: Income → Fixed → Variable → Net
    fixed_total = sum(
        t.amount for t in spending
        if (t.custom_category or t.category or "") in FIXED_CATEGORIES
    )
    variable_total = total_spending - fixed_total
    net = total_income - total_spending
    waterfall = [
        {"label": "Income", "value": round(total_income, 2), "type": "in"},
        {"label": "Fixed", "value": round(fixed_total, 2), "type": "out"},
        {"label": "Variable", "value": round(variable_total, 2), "type": "out"},
        {"label": "Net", "value": round(net, 2), "type": "net"},
    ]

    # Income sources
    sources = defaultdict(float)
    for t in income:
        key = (t.merchant_name or t.name or "Unknown").strip()
        sources[key] += abs(t.amount)
    income_sources = sorted(
        [{"source": s, "amount": round(a, 2)} for s, a in sources.items()],
        key=lambda x: x["amount"], reverse=True,
    )[:10]

    # Savings rate
    savings_rate = round(((total_income - total_spending) / total_income) * 100, 1) if total_income > 0 else None

    return {
        "month": month,
        "year": year,
        "total_income": round(total_income, 2),
        "total_spending": round(total_spending, 2),
        "savings_rate": savings_rate,
        "dow_heatmap": dow_heatmap,
        "forecast": forecast,
        "waterfall": waterfall,
        "income_sources": income_sources,
    }


# ─── Cash Flow Forecast ─────────────────────────────────────
@router.get("/cash-flow-forecast")
def cash_flow_forecast(
    days: int = Query(default=30, ge=7, le=180),
    baseline: str = Query(
        default="median_3",
        regex="^(median_3|median_6|last_month|rolling_90)$",
        description="Variable-spend baseline: median_3 / median_6 / last_month / rolling_90",
    ),
    db: Session = Depends(get_db),
):
    """Project the next `days` of cash flow off two signals:

      1. **Recurring charges and income** — known dates, known amounts,
         pulled from the recurring detector (paychecks, mortgage, subs).
         Seasonal merchants only emit events during their active months.

      2. **Variable spending** — a typical-day rate computed from one of
         four baselines (controlled by the `baseline` query param):
           - median_3   median monthly variable spend across the last 3
                        complete calendar months (default — outlier-robust)
           - median_6   same, last 6 months
           - last_month last complete calendar month
           - rolling_90 90-day mean (legacy; sensitive to one-off events)

    **Variable income is NOT projected forward.** Tax refunds, bonuses,
    cash gifts and similar one-off inflows happened in the past but
    shouldn't be amortized into the future — that's how the previous
    rolling-90 baseline made the forecast look unrealistically optimistic.
    Only the paychecks that the recurring detector identified as a
    cadence (and therefore expected to repeat) project forward.

    Returns a daily series + flat upcoming-events list + `baseline_meta`
    explaining what was used so the UI can show it.
    """
    today = date.today()
    horizon = today + timedelta(days=days)

    # ─── Pull recurring events out of the existing detector ──
    # We re-use `detect_recurring`'s logic by querying transactions and
    # walking forward from each merchant's `next_expected` date until we
    # exit the horizon.
    cutoff = today - timedelta(days=365)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff,
            Transaction.is_transfer.is_(False),
        )
        .order_by(Transaction.date)
        .all()
    )

    by_merchant: dict[str, list[Transaction]] = defaultdict(list)
    for t in txns:
        key = (t.merchant_name or t.name or "Unknown").strip()
        by_merchant[key].append(t)

    # day_index → list of {kind, source, amount}
    events: dict[date, list[dict]] = defaultdict(list)

    for merchant, lst in by_merchant.items():
        if len(lst) < 2:
            continue
        sorted_txns = sorted(lst, key=lambda x: x.date)
        amounts = [t.amount for t in sorted_txns]
        median = sorted(amounts)[len(amounts) // 2]
        if median <= 0:
            continue
        if not all(abs(a - median) / median < 0.25 for a in amounts):
            continue
        intervals = [(sorted_txns[i + 1].date - sorted_txns[i].date).days for i in range(len(sorted_txns) - 1)]
        if not intervals:
            continue
        # Median (not mean) so seasonal merchants survive their winter gap.
        sorted_intervals = sorted(intervals)
        median_int = sorted_intervals[len(sorted_intervals) // 2]
        if not any(lo <= median_int <= hi for _, lo, hi, _ in FREQUENCY_BANDS):
            continue

        # Seasonality: detect active calendar months and use them to skip
        # off-season events when projecting forward.
        active_months = {d.date.month for d in sorted_txns}
        is_seasonal = 3 <= len(active_months) <= 10

        # Walk forward from last_date
        next_date = sorted_txns[-1].date + timedelta(days=int(median_int))
        while next_date <= horizon:
            if next_date >= today and (not is_seasonal or next_date.month in active_months):
                latest = sorted_txns[-1]
                kind = "outflow" if latest.amount > 0 else "inflow"
                events[next_date].append({
                    "kind": kind,
                    "source": merchant,
                    "amount": round(abs(median), 2),
                    "category": (latest.custom_category or latest.category or None),
                    "recurring": True,
                    "seasonal": is_seasonal,
                })
            next_date += timedelta(days=int(median_int))

    # ─── Variable-spend baseline ─────────────────────────────────
    # Build per-month variable-spend totals for the last 6 *complete*
    # calendar months (not including today's partial month). Variable =
    # total spending minus what the recurring detector already covers, so
    # we don't double-count.
    def _shift_month(y: int, m: int, by: int) -> tuple[int, int]:
        idx = y * 12 + (m - 1) + by
        return idx // 12, (idx % 12) + 1

    # Monthly recurring estimate (used to net out from per-month spend).
    # We approximate by counting the median × per-year multiplier from the
    # detector — events[] already has dates+amounts in the horizon window,
    # but we want the steady-state monthly rate, so use the recurring
    # records themselves.
    monthly_recurring_outflow = 0.0
    monthly_recurring_inflow = 0.0
    by_merchant_for_baseline: dict[str, list[Transaction]] = defaultdict(list)
    for t in txns:
        by_merchant_for_baseline[(t.merchant_name or t.name or "Unknown").strip()].append(t)
    for lst in by_merchant_for_baseline.values():
        if len(lst) < 2:
            continue
        st = sorted(lst, key=lambda x: x.date)
        amts = [x.amount for x in st]
        med = sorted(amts)[len(amts) // 2]
        if med <= 0:
            continue
        if not all(abs(a - med) / med < 0.25 for a in amts):
            continue
        intervals = [(st[i + 1].date - st[i].date).days for i in range(len(st) - 1)]
        if not intervals:
            continue
        mi = sorted(intervals)[len(intervals) // 2]
        cls = _classify_frequency(mi)
        if not cls:
            continue
        _, per_year = cls
        active = {x.date.month for x in st}
        mult = len(active) if 3 <= len(active) <= 10 else per_year
        monthly_rate = abs(med) * mult / 12
        if med > 0:
            monthly_recurring_outflow += monthly_rate
        else:
            monthly_recurring_inflow += monthly_rate  # never hits because med > 0 above

    # Also include the inflow side: the same logic but for negative amounts.
    # Loop over the same merchant groups because some merchants are inflow.
    for lst in by_merchant_for_baseline.values():
        if len(lst) < 2:
            continue
        st = sorted(lst, key=lambda x: x.date)
        amts = [x.amount for x in st]
        if all(a >= 0 for a in amts):
            continue  # outflow merchant, already counted above
        # Swap to absolute values for the median test.
        abs_amts = [abs(a) for a in amts]
        med = sorted(abs_amts)[len(abs_amts) // 2]
        if med <= 0:
            continue
        if not all(abs(a - med) / med < 0.25 for a in abs_amts):
            continue
        intervals = [(st[i + 1].date - st[i].date).days for i in range(len(st) - 1)]
        if not intervals:
            continue
        mi = sorted(intervals)[len(intervals) // 2]
        cls = _classify_frequency(mi)
        if not cls:
            continue
        _, per_year = cls
        active = {x.date.month for x in st}
        mult = len(active) if 3 <= len(active) <= 10 else per_year
        monthly_recurring_inflow += med * mult / 12

    # Per-month variable spend over the last 6 complete calendar months.
    # Median of these is naturally outlier-resistant: a single bonus or
    # holiday-spending month doesn't pull the projection up; a sparse
    # incomplete month (very early in the dataset) is dropped entirely.
    monthly_variable: list[float] = []
    monthly_labels: list[str] = []
    for back in range(1, 7):  # months 1..6 ago
        y, m = _shift_month(today.year, today.month, -back)
        m_start = date(y, m, 1)
        m_end = date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)
        m_spend_txns = [t for t in txns if m_start <= t.date < m_end and t.amount > 0]
        m_income_txns = [t for t in txns if m_start <= t.date < m_end and t.amount < 0]
        m_spend = sum(t.amount for t in m_spend_txns)
        # Skip months with very little data — likely the user hadn't
        # connected accounts yet. Threshold is intentionally low; we just
        # want to drop "0 transactions" months, not normal quiet months.
        if len(m_spend_txns) + len(m_income_txns) < 5:
            continue
        # Subtract the steady-state recurring estimate so we don't
        # double-count what the recurring detector will already project.
        monthly_variable.append(max(m_spend - monthly_recurring_outflow, 0))
        monthly_labels.append(f"{y}-{m:02d}")

    # ─── Salary-source income (separate from the variable median) ──
    # Only project income from merchants that have shown up in 3+
    # distinct calendar months over the last 6 — those are the real
    # employers / salary sources. One-off events (tax refunds, cash
    # gifts, profit-sharing, bonus deposits) appear in 1-2 months and
    # are filtered out by this threshold. For each salary source, the
    # projected monthly contribution is the median of its observed
    # monthly totals (so a single anomalous high paycheck doesn't pull
    # one source's projection up either).
    def _clean_source(merchant_name: Optional[str], name: Optional[str]) -> str:
        raw = (merchant_name or name or "").strip()
        if not raw:
            return "Unknown"
        # Strip ACH gunk
        raw = re.sub(r"\s+(TYPE:|ID:|DATA:|CO:|PPD|ACH ECC|ACH Trace).*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"^(DEPOSIT|WITHDRAWAL|TRANSFER|PAYMENT|PURCHASE)\s+", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s+", " ", raw).strip()
        if raw == raw.upper() and len(raw) > 3:
            raw = raw.title()
        return raw or "Unknown"

    # Track whether each merchant's transactions land in the "Income"
    # category (a strong signal that a single appearance is salary, not
    # a one-off refund). Combined with month-presence, this makes the
    # threshold adaptive instead of demanding a flat 3-month history.
    income_by_source: dict[str, dict[tuple[int, int], float]] = defaultdict(lambda: defaultdict(float))
    income_category_hits: dict[str, int] = defaultdict(int)
    months_observed_in_data: set[tuple[int, int]] = set()
    for back in range(0, 7):  # current + last 6 months
        y, m = _shift_month(today.year, today.month, -back)
        m_start = date(y, m, 1)
        m_end = date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)
        for t in txns:
            if t.amount >= 0 or t.is_transfer:
                continue
            if not (m_start <= t.date < m_end):
                continue
            source = _clean_source(t.merchant_name, t.name)
            income_by_source[source][(y, m)] += abs(t.amount)
            cat = (t.custom_category or t.category or "").lower()
            if cat == "income":
                income_category_hits[source] += 1
            months_observed_in_data.add((y, m))

    # Adaptive presence threshold: scale with how much income history we
    # have. Brand-new users (1-2 months of data) shouldn't be told "we
    # don't see any salary yet" — give them benefit of the doubt with
    # 1-month-plus-Income-category. Established users (6+ months) get
    # the strict 3-month bar to keep one-off refunds out.
    data_depth = len(months_observed_in_data)
    if data_depth >= 6:
        presence_floor = 3
    elif data_depth >= 4:
        presence_floor = 2
    else:
        presence_floor = 1

    salary_sources: list[dict] = []
    excluded_sources: list[dict] = []
    for source, monthly_totals in income_by_source.items():
        amounts = list(monthly_totals.values())
        median_monthly = sorted(amounts)[len(amounts) // 2]
        months_observed = len(monthly_totals)
        category_hits = income_category_hits.get(source, 0)

        # Floor on the per-month median — filters out tiny cashback /
        # offer credits that hit every month (e.g. Marathon Fuel $1.58).
        AMOUNT_FLOOR = 100.0
        if median_monthly < AMOUNT_FLOOR:
            excluded_sources.append({
                "source": source,
                "reason": "below_amount_floor",
                "median_monthly": round(median_monthly, 2),
                "months_observed": months_observed,
            })
            continue

        # Inclusion: presence_floor months OR a single month *with* the
        # Income category tag (which the user/Plaid explicitly asserts is
        # salary). The Income-category fast path catches freshly-employed
        # users who haven't accumulated enough months yet.
        passes_presence = months_observed >= presence_floor
        passes_category = months_observed >= 1 and category_hits >= 2 and median_monthly >= 500

        if not (passes_presence or passes_category):
            excluded_sources.append({
                "source": source,
                "reason": "insufficient_history",
                "median_monthly": round(median_monthly, 2),
                "months_observed": months_observed,
            })
            continue

        salary_sources.append({
            "source": source,
            "median_monthly": round(median_monthly, 2),
            "months_observed": months_observed,
            "income_category_hits": category_hits,
            # Why this source qualified — useful for the UI tooltip.
            "qualification": "presence" if passes_presence else "income_category",
        })

    salary_sources.sort(key=lambda x: x["median_monthly"], reverse=True)
    excluded_sources.sort(key=lambda x: x["median_monthly"], reverse=True)
    monthly_salary_income = sum(s["median_monthly"] for s in salary_sources)

    def _median(vals: list[float]) -> Optional[float]:
        if not vals:
            return None
        s = sorted(vals)
        n = len(s)
        return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2

    if baseline == "median_3":
        spend_sample = monthly_variable[:3]
        baseline_spend = _median(spend_sample)
        baseline_label = f"Median of last {len(spend_sample)} complete month{'' if len(spend_sample) == 1 else 's'}"
    elif baseline == "median_6":
        spend_sample = monthly_variable[:6]
        baseline_spend = _median(spend_sample)
        baseline_label = f"Median of last {len(spend_sample)} complete month{'' if len(spend_sample) == 1 else 's'}"
    elif baseline == "last_month":
        spend_sample = monthly_variable[:1]
        baseline_spend = spend_sample[0] if spend_sample else None
        baseline_label = "Last complete month"
    else:  # rolling_90
        cutoff90 = today - timedelta(days=90)
        recent = [t for t in txns if t.date >= cutoff90]
        spend_90 = sum(t.amount for t in recent if t.amount > 0)
        baseline_spend = max(spend_90 - monthly_recurring_outflow * 3, 0) / 3
        spend_sample = []
        baseline_label = "Rolling 90-day mean"

    monthly_variable_spend = baseline_spend or 0.0
    variable_spend_per_day = monthly_variable_spend / 30 if monthly_variable_spend else 0.0

    # Income comes from the salary-source filter above — NOT a median of
    # all monthly inflows. This is the key fix: one-off inflows (tax
    # refunds, bonuses, mobile deposits, cashback offers) appear in 1-2
    # months over the year, so they fail the "3+ distinct months" test
    # and never enter the projection. Only merchants that pay you
    # regularly (paychecks from a primary employer, etc.) feed the
    # daily inflow rate.
    variable_income_per_day = monthly_salary_income / 30 if monthly_salary_income else 0.0

    # Today's actual cash balance — used to translate cumulative_delta
    # into a projected balance ($X today + $Y delta = balance at day N).
    # Includes depository / checking / savings only. Used for chart
    # rendering on the Dashboard tile; the legacy cumulative_delta
    # field stays for callers that want just the change.
    starting_cash = (
        db.query(func.coalesce(func.sum(Account.current_balance), 0.0))
        .filter(Account.type.in_(("depository", "checking", "savings")))
        .scalar()
        or 0.0
    )

    # ─── Build the daily series ──
    series = []
    cum = 0.0
    low_point = {"date": None, "delta": 0.0, "balance": starting_cash}
    for i in range(days + 1):
        d = today + timedelta(days=i)
        recurring_out = sum(ev["amount"] for ev in events[d] if ev["kind"] == "outflow")
        recurring_in = sum(ev["amount"] for ev in events[d] if ev["kind"] == "inflow")
        out = recurring_out + variable_spend_per_day
        inn = recurring_in + variable_income_per_day
        net = inn - out
        cum += net
        balance = starting_cash + cum
        if cum < low_point["delta"]:
            low_point = {
                "date": d.isoformat(),
                "delta": round(cum, 2),
                "balance": round(balance, 2),
            }
        series.append({
            "date": d.isoformat(),
            "projected_outflow": round(out, 2),
            "projected_inflow": round(inn, 2),
            "net": round(net, 2),
            "cumulative_delta": round(cum, 2),
            # Projected balance (= today's cash + cumulative delta).
            # New field. Existing callers that only read cumulative_delta
            # are unaffected.
            "balance": round(balance, 2),
            "events": events[d],
        })

    # Top-level upcoming events list, sorted chronologically
    upcoming = []
    for d, evs in sorted(events.items()):
        for ev in evs:
            upcoming.append({"date": d.isoformat(), **ev})

    return {
        "horizon_days": days,
        "today": today.isoformat(),
        "starting_cash": round(starting_cash, 2),
        "variable_spend_per_day": round(variable_spend_per_day, 2),
        "variable_income_per_day": round(variable_income_per_day, 2),
        "low_point": low_point if low_point["date"] else None,
        "series": series,
        "upcoming_events": upcoming,
        "baseline_meta": {
            "baseline": baseline,
            "label": baseline_label,
            "monthly_variable_spend": round(monthly_variable_spend, 2),
            "monthly_salary_income": round(monthly_salary_income, 2),
            "salary_sources": salary_sources,
            "excluded_sources": excluded_sources,
            "presence_floor": presence_floor,
            "data_depth_months": data_depth,
            "sampled_months": monthly_labels[:len(spend_sample)] if spend_sample else [],
            "monthly_recurring_outflow": round(monthly_recurring_outflow, 2),
            "note": (
                f"Salary detection uses a {presence_floor}-month presence threshold "
                f"(adapted to your {data_depth} months of income history) plus an "
                f"Income-category fast path. Sources below ${100} median or appearing "
                f"in too few months are listed as exceptions and excluded from the "
                f"projection. Spend uses median of monthly totals to stay outlier-robust."
            ),
        },
    }


# ─── Debt payoff trajectories ────────────────────────────────
import math
import re


def _amortize(balance: float, annual_rate_pct: Optional[float], monthly_payment: Optional[float]) -> dict:
    """Standard fixed-payment amortization. Returns months remaining, total
    interest, and the principal paid down per month at the start of the
    schedule (informational — actual principal grows as the balance shrinks).

    Returns dict with whatever could be computed; missing fields are None.
    Edge cases handled:
      - Payment can't cover monthly interest → "negative amortization",
        emit a flag rather than a math error.
      - Zero or unknown rate → straight-line (balance / payment).
      - Zero or unknown payment → can't project, return Nones.
    """
    out = {"months_remaining": None, "total_interest": None, "negative_amortization": False}
    if not monthly_payment or monthly_payment <= 0 or balance <= 0:
        return out

    if annual_rate_pct and annual_rate_pct > 0:
        monthly_rate = annual_rate_pct / 100 / 12
        monthly_interest = balance * monthly_rate
        if monthly_payment <= monthly_interest:
            # Payment doesn't even cover interest — debt grows.
            out["negative_amortization"] = True
            return out
        try:
            n = -math.log(1 - (balance * monthly_rate) / monthly_payment) / math.log(1 + monthly_rate)
            n = int(math.ceil(n))
            total_interest = n * monthly_payment - balance
        except (ValueError, ZeroDivisionError):
            return out
    else:
        n = int(math.ceil(balance / monthly_payment))
        total_interest = 0.0

    out["months_remaining"] = n
    out["total_interest"] = round(total_interest, 2)
    return out


def _payment_from_notes(notes: Optional[str]) -> Optional[float]:
    """Extract '$420/mo' or '420/month' style amounts from free-text notes.
    Used for manual liabilities where the user types a hint rather than
    storing the payment in a structured field."""
    if not notes:
        return None
    m = re.search(r"\$?(\d{1,5}(?:\.\d{1,2})?)\s*/\s*(?:mo|month)", notes, re.IGNORECASE)
    return float(m.group(1)) if m else None


def _payment_from_recurring_match(db: Session, name: str, months: int = 6) -> Optional[float]:
    """Look back over `months` of transactions for ones whose merchant or
    name contains the first word of `name` (e.g. 'Hyundai'), and return the
    average monthly outflow. Useful for manual liabilities where we don't
    have structured payment info but the user is paying monthly."""
    if not name:
        return None
    head = name.lower().split()[0]
    if len(head) < 3:
        return None
    cutoff = date.today() - timedelta(days=months * 31)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff,
            Transaction.amount > 0,  # outflow
        )
        .all()
    )
    matching = [
        t for t in txns
        if head in (t.name or "").lower() or head in (t.merchant_name or "").lower()
    ]
    if not matching:
        return None
    total = sum(t.amount for t in matching)
    # Approximate by spreading across the lookback window — undercounts if
    # the user's only had this loan for part of that window, but close enough.
    return total / months


@router.get("/debt-payoff")
def debt_payoff(db: Session = Depends(get_db)):
    """Compute amortization for every active liability — Plaid mortgage and
    credit-card accounts plus manual liabilities (auto loan, student loan, etc.)
    For each, return balance, rate (when known), monthly payment, months
    remaining, projected payoff date, and total remaining interest."""
    today = date.today()
    debts = []

    # ─── Plaid liability accounts ────────────────────────
    accounts = (
        db.query(Account)
        .filter(Account.type.in_(["loan", "credit"]))
        .filter(Account.current_balance > 0)
        .all()
    )
    for a in accounts:
        balance = float(a.current_balance or 0)
        if balance < 1:
            continue

        rate = None
        payment = None
        kind = a.type
        if a.type == "loan":
            mtg = db.query(MortgageDetail).filter_by(account_id=a.id).first()
            if mtg:
                rate = mtg.interest_rate_percentage
                payment = mtg.next_monthly_payment
                kind = "mortgage"
        elif a.type == "credit":
            cc = db.query(CreditCardDetail).filter_by(account_id=a.id).first()
            if cc:
                if cc.aprs:
                    purchase_apr = next(
                        (apr for apr in cc.aprs if "purchase" in (apr.get("apr_type") or "").lower()),
                        None,
                    )
                    if purchase_apr:
                        rate = purchase_apr.get("apr_percentage")
                # Use the minimum payment when nothing else is known. The user
                # should ideally pay more than minimum, but the projection is
                # still useful as a "worst case at minimum" reference.
                payment = cc.minimum_payment_amount
                kind = "credit_card"

        amort = _amortize(balance, rate, payment)
        payoff_date = (
            (today + timedelta(days=int(amort["months_remaining"] * 30)))
            if amort["months_remaining"]
            else None
        )

        debts.append({
            "id": a.id,
            "source": "plaid",
            "kind": kind,
            "name": a.custom_name or a.name,
            "institution": a.institution_name,
            "mask": a.mask,
            "balance": round(balance, 2),
            "annual_rate_pct": rate,
            "monthly_payment": round(payment, 2) if payment else None,
            "months_remaining": amort["months_remaining"],
            "payoff_date": payoff_date.isoformat() if payoff_date else None,
            "total_interest_remaining": amort["total_interest"],
            "negative_amortization": amort["negative_amortization"],
        })

    # ─── Manual liabilities ──────────────────────────────
    manual = db.query(ManualAsset).filter_by(side="liability").all()
    for m in manual:
        balance = float(m.current_value or 0)
        if balance < 1:
            continue

        # Manual liabilities don't have structured rate/payment fields, so we
        # try a couple of heuristics in order: (1) parse the notes for a
        # '$X/mo' hint, (2) detect a recurring outflow whose merchant matches
        # the liability name. Either way, no rate — the projection without
        # interest is a "worst case" upper bound on time to payoff.
        payment = _payment_from_notes(m.notes) or _payment_from_recurring_match(db, m.name)
        amort = _amortize(balance, None, payment)
        payoff_date = (
            (today + timedelta(days=int(amort["months_remaining"] * 30)))
            if amort["months_remaining"]
            else None
        )

        debts.append({
            "id": m.id,
            "source": "manual",
            "kind": m.type or "liability",
            "name": m.name,
            "institution": None,
            "mask": None,
            "balance": round(balance, 2),
            "annual_rate_pct": None,
            "monthly_payment": round(payment, 2) if payment else None,
            "months_remaining": amort["months_remaining"],
            "payoff_date": payoff_date.isoformat() if payoff_date else None,
            "total_interest_remaining": amort["total_interest"],
            "negative_amortization": amort["negative_amortization"],
            "notes": m.notes,
        })

    # Sort: longest-remaining first (mortgage at the top usually). Items
    # that couldn't be projected go to the bottom so the math-known ones
    # are visible without scrolling.
    debts.sort(key=lambda d: (d["months_remaining"] is None, -(d["months_remaining"] or 0)))

    total_balance = sum(d["balance"] for d in debts)
    total_interest = sum((d["total_interest_remaining"] or 0) for d in debts)
    total_monthly = sum((d["monthly_payment"] or 0) for d in debts)
    return {
        "today": today.isoformat(),
        "debts": debts,
        "total_balance": round(total_balance, 2),
        "total_interest_remaining": round(total_interest, 2),
        "total_monthly_payments": round(total_monthly, 2),
        "count": len(debts),
    }


# ─── First-time merchants ────────────────────────────────────
@router.get("/first-time-merchants")
def first_time_merchants(
    month: int = Query(...),
    year: int = Query(...),
    db: Session = Depends(get_db),
):
    """Return merchants whose first-ever transaction (in the local DB)
    falls inside the given month. Useful for catching new subscriptions
    or one-off splurges that are easy to miss in a busy month."""
    start = date(year, month, 1)
    end = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)

    # Build the set of merchants seen *before* the start of this month.
    prior = (
        db.query(Transaction)
        .filter(
            Transaction.date < start,
            Transaction.is_transfer.is_(False),
        )
        .all()
    )
    seen_keys = set()
    for t in prior:
        key = ((t.merchant_name or t.name or "").strip().lower())
        if key:
            seen_keys.add(key)

    cur = (
        db.query(Transaction)
        .filter(
            Transaction.date >= start,
            Transaction.date < end,
            Transaction.is_transfer.is_(False),
            Transaction.amount > 0,  # spending only — incoming wires aren't usually surprises
        )
        .all()
    )
    new_by_key: dict = defaultdict(list)
    for t in cur:
        key = ((t.merchant_name or t.name or "").strip().lower())
        if key and key not in seen_keys:
            new_by_key[key].append(t)

    out = []
    for key, lst in new_by_key.items():
        first = min(lst, key=lambda t: t.date)
        category = first.custom_category or first.category or "Uncategorized"
        out.append({
            "merchant": first.merchant_name or first.name or "Unknown",
            "category": category,
            "icon": CATEGORY_ICONS.get(category, "📦"),
            "first_date": first.date.isoformat(),
            "first_amount": round(first.amount, 2),
            "transaction_count": len(lst),
            "total_amount": round(sum(t.amount for t in lst), 2),
        })

    out.sort(key=lambda r: r["total_amount"], reverse=True)
    return {
        "month": month,
        "year": year,
        "new_merchants": out,
        "count": len(out),
    }


# ─── Cash flow health (emergency runway + bill stress) ───────
@router.get("/cash-flow-health")
def cash_flow_health(db: Session = Depends(get_db)):
    """Two-number cash-flow health check:

      - Emergency runway: liquid balances ÷ avg monthly spend (months).
      - Bill stress:     recurring outflows ÷ avg monthly income (% of paycheck).

    Liquid = checking + savings (instant access) + taxable brokerage
    (2-day liquid via sell + ACH; penalty-free; ofteñ 0% LTCG in low-
    income years). Mirrors the Financial Pulse runway logic so the two
    tiles agree on what counts as deployable in an emergency. Tagged
    via Account.type for depository and tax_bucket='taxable' for
    brokerage. tax_deferred (401k/IRA), roth, hsa, and excluded
    accounts are intentionally NOT counted.
    """
    today = date.today()
    cutoff90 = today - timedelta(days=90)

    # Liquid reserves: depository (instant) + taxable brokerage (2-day liquid)
    pure_cash_total = sum(
        float(a.current_balance or 0)
        for a in db.query(Account).filter(Account.type == "depository").all()
    )
    taxable_brokerage_total = sum(
        float(a.current_balance or 0)
        for a in db.query(Account).filter(Account.tax_bucket == "taxable").all()
    )
    liquid_total = pure_cash_total + taxable_brokerage_total

    # Spend / income over the last 90 days, excluding transfers.
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff90,
            Transaction.is_transfer.is_(False),
        )
        .all()
    )
    spend_90 = sum(t.amount for t in txns if t.amount > 0)
    income_90 = sum(abs(t.amount) for t in txns if t.amount < 0)
    avg_monthly_spend = round(spend_90 / 3, 2) if spend_90 else 0.0
    avg_monthly_income = round(income_90 / 3, 2) if income_90 else 0.0

    runway_months = round(liquid_total / avg_monthly_spend, 2) if avg_monthly_spend > 0 else None

    # Recurring outflows — re-detect quickly here using the same cadence
    # logic. Could call detect_recurring() but pulling its sums directly
    # avoids the JSON round-trip.
    monthly_recurring_outflow = 0.0
    by_merchant: dict = defaultdict(list)
    cutoff365 = today - timedelta(days=365)
    rt = db.query(Transaction).filter(
        Transaction.date >= cutoff365,
        Transaction.is_transfer.is_(False),
        Transaction.amount > 0,
    ).all()
    for t in rt:
        by_merchant[(t.merchant_name or t.name or "Unknown").strip()].append(t)
    for lst in by_merchant.values():
        if len(lst) < 2:
            continue
        sorted_t = sorted(lst, key=lambda x: x.date)
        amts = [t.amount for t in sorted_t]
        med = sorted(amts)[len(amts) // 2]
        if med <= 0:
            continue
        if not all(abs(a - med) / med < 0.25 for a in amts):
            continue
        intervals = [(sorted_t[i + 1].date - sorted_t[i].date).days for i in range(len(sorted_t) - 1)]
        if not intervals:
            continue
        mi = sorted(intervals)[len(intervals) // 2]
        cls = _classify_frequency(mi)
        if not cls:
            continue
        _, per_year = cls
        active_months = {d.date.month for d in sorted_t}
        if 3 <= len(active_months) <= 10:
            mult = len(active_months)
        else:
            mult = per_year
        monthly_recurring_outflow += med * mult / 12

    bill_stress_pct = round((monthly_recurring_outflow / avg_monthly_income) * 100, 1) if avg_monthly_income > 0 else None

    # Status banding for the UI
    if runway_months is None:
        runway_status = "unknown"
    elif runway_months >= 6:
        runway_status = "healthy"
    elif runway_months >= 3:
        runway_status = "moderate"
    else:
        runway_status = "thin"

    if bill_stress_pct is None:
        bill_status = "unknown"
    elif bill_stress_pct < 50:
        bill_status = "healthy"
    elif bill_stress_pct < 70:
        bill_status = "moderate"
    else:
        bill_status = "high"

    return {
        "liquid_balance": round(liquid_total, 2),
        "liquid_breakdown": {
            "cash": round(pure_cash_total, 2),
            "taxable_brokerage": round(taxable_brokerage_total, 2),
        },
        "avg_monthly_spend": avg_monthly_spend,
        "avg_monthly_income": avg_monthly_income,
        "monthly_recurring_outflow": round(monthly_recurring_outflow, 2),
        "runway_months": runway_months,
        "runway_status": runway_status,
        "bill_stress_pct": bill_stress_pct,
        "bill_status": bill_status,
    }


# ─── Anomaly Insight Cards ─────────────────────────────────
@router.get("/top-merchants")
def top_merchants(
    months: int = Query(6, ge=1, le=24, description="Lookback window in months"),
    limit: int = Query(20, ge=1, le=100),
    business_id: Optional[int] = Query(None, description="Filter to one business"),
    db: Session = Depends(get_db),
):
    """Top merchants by total $ spent in the lookback window, with a
    sparkline showing month-over-month spend at each merchant. Used by
    the Spending & Income page's "Top merchants" table.

    Optional business_id filter constrains to transactions tagged to
    that business — useful for the per-business dashboard view.
    """
    today = date.today()
    cutoff = today - timedelta(days=months * 31)
    q = db.query(Transaction).filter(
        Transaction.date >= cutoff,
        Transaction.amount > 0,  # outflows only
        Transaction.is_transfer == False,  # noqa: E712
    )
    if business_id is not None:
        q = q.filter(Transaction.business_id == business_id)
    txns = q.all()

    # Group by normalized merchant
    by_merchant = defaultdict(list)
    for t in txns:
        raw = t.merchant_name or t.name or "Unknown"
        norm = normalize_merchant(raw) or raw
        by_merchant[norm].append(t)

    # Build entries with monthly sparkline
    out = []
    for merchant, ts in by_merchant.items():
        total = sum(x.amount for x in ts)
        # Per-month buckets (newest first)
        monthly = defaultdict(float)
        for t in ts:
            key = (t.date.year, t.date.month)
            monthly[key] += t.amount
        # Sparkline: last `months` months, oldest → newest
        sparkline = []
        for back in range(months - 1, -1, -1):
            y = today.year + (today.month - back - 1) // 12
            m = ((today.month - back - 1) % 12) + 1
            sparkline.append(round(monthly.get((y, m), 0.0), 2))
        out.append({
            "merchant": merchant,
            "total": round(total, 2),
            "txn_count": len(ts),
            "avg_per_txn": round(total / len(ts), 2),
            "sparkline": sparkline,
        })
    out.sort(key=lambda x: x["total"], reverse=True)
    return {"merchants": out[:limit], "months": months}


@router.get("/spending-heatmap")
def spending_heatmap(
    days: int = Query(365, ge=30, le=730),
    db: Session = Depends(get_db),
):
    """365-day calendar heatmap of daily spending. Returns one entry per
    day with date + total outflow + transaction count. Frontend renders
    as a GitHub-contribution-graph style grid colored by intensity."""
    today = date.today()
    cutoff = today - timedelta(days=days)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff,
            Transaction.amount > 0,
            Transaction.is_transfer == False,  # noqa: E712
        )
        .all()
    )
    by_day = defaultdict(lambda: {"total": 0.0, "count": 0})
    for t in txns:
        by_day[t.date]["total"] += t.amount
        by_day[t.date]["count"] += 1

    days_out = []
    for i in range(days + 1):
        d = cutoff + timedelta(days=i)
        days_out.append({
            "date": d.isoformat(),
            "total": round(by_day[d]["total"], 2),
            "count": by_day[d]["count"],
        })
    # Distribution stats so frontend can pick color thresholds
    daily_totals = sorted([d["total"] for d in days_out if d["total"] > 0])
    if daily_totals:
        p25 = daily_totals[len(daily_totals) // 4]
        p50 = daily_totals[len(daily_totals) // 2]
        p75 = daily_totals[3 * len(daily_totals) // 4]
        p90 = daily_totals[9 * len(daily_totals) // 10]
    else:
        p25 = p50 = p75 = p90 = 0.0
    return {
        "days": days_out,
        "thresholds": {
            "p25": round(p25, 2),
            "p50": round(p50, 2),
            "p75": round(p75, 2),
            "p90": round(p90, 2),
        },
    }


@router.get("/networth-yoy")
def networth_yoy(db: Session = Depends(get_db)):
    """Year-over-year net worth comparison. Returns paired (current_date,
    prior_year_value) so the chart can overlay last year's trajectory."""
    today = date.today()
    one_year_ago = today - timedelta(days=365)
    snapshots = (
        db.query(NetWorthSnapshot)
        .order_by(NetWorthSnapshot.date)
        .all()
    )
    if not snapshots:
        return {"current": [], "prior_year": []}

    # Build a date → net_worth lookup
    by_date = {s.date: s.net_worth for s in snapshots}

    # Walk the last 365 days and try to find a matching snapshot from
    # exactly 365 days earlier. Falls back to closest-prior snapshot.
    out_current = []
    out_prior = []
    sorted_dates = sorted(by_date.keys())
    for s in snapshots:
        if s.date < one_year_ago:
            continue
        out_current.append({"date": s.date.isoformat(), "value": s.net_worth})
        # Look for snapshot ~365 days earlier
        target = s.date - timedelta(days=365)
        # Find the closest snapshot at or before `target`
        closest = None
        for d in sorted_dates:
            if d <= target:
                closest = d
            else:
                break
        if closest:
            out_prior.append({"date": s.date.isoformat(), "value": by_date[closest]})
    return {"current": out_current, "prior_year": out_prior}


@router.get("/financial-pulse")
def financial_pulse(
    monthly_payroll_deferral: float = Query(
        0.0, ge=0, le=100000,
        description="Monthly 401k / Roth 401k / 403(b) / 457 payroll deferral that "
                    "doesn't show up in bank transactions (it's deducted before the "
                    "paycheck hits the bank). Added to income for the 'true' savings "
                    "rate, which corrects the systematic understatement from Plaid-"
                    "only data. 0 = use visible bank-only rate.",
    ),
    db: Session = Depends(get_db),
):
    """Single-number "how's it going?" health score (0-100) plus
    component breakdown. Aggregates four signals:

      - Liquidity: cash ÷ monthly outflow (months of runway)
      - Savings rate: (income - expenses) ÷ income
      - Budget adherence: % of budget categories under budget this month
      - Debt service: liabilities ÷ assets

    Each component scored 0-100 and weighted equally. Lets a non-
    finance-savvy user open the app and see one number that means
    "you're fine" or "needs attention."
    """
    today = date.today()
    month_start = today.replace(day=1)
    # 90-day rolling window for inflow/outflow averaging — stable
    # against month-end timing variance and lumpy single-month
    # expenses. Normalized to monthly equivalents below.
    last_90 = today - timedelta(days=90)

    # ── Liquidity: months of runway ──
    # Two layers, both count as runway:
    #   1. Depository / checking / savings — instant access
    #   2. Taxable brokerage (tax_bucket='taxable') — 2-day liquid via
    #      sell + ACH; penalty-free; often 0% LTCG in low-income years.
    #      Tagged via the existing per-account tax_bucket field.
    # tax_deferred (401k/IRA), roth (earmarked), and excluded (HELOC-
    # borrowed brokerage etc.) are intentionally NOT counted.
    liquid_types = ("depository", "checking", "savings")
    pure_cash = (
        db.query(func.coalesce(func.sum(Account.current_balance), 0.0))
        .filter(Account.type.in_(liquid_types))
        .scalar()
        or 0.0
    )
    taxable_brokerage = (
        db.query(func.coalesce(func.sum(Account.current_balance), 0.0))
        .filter(Account.tax_bucket == "taxable")
        .scalar()
        or 0.0
    )
    available_runway = pure_cash + taxable_brokerage

    # 90-day total outflow → divide by 3 for monthly equivalent.
    # More stable than a 30-day snapshot which gets twitchy from
    # month-end timing of bills.
    raw_outflow_90d = (
        db.query(func.coalesce(func.sum(Transaction.amount), 0.0))
        .filter(
            Transaction.date >= last_90,
            Transaction.amount > 0,
            Transaction.is_transfer == False,  # noqa: E712
        )
        .scalar()
        or 0.0
    )
    monthly_outflow = raw_outflow_90d / 3.0
    runway_months = (available_runway / monthly_outflow) if monthly_outflow > 0 else 999
    # Score: 0 months = 0, 6+ months = 100. Most personal-finance
    # guidance pegs "healthy" at 3-6 months emergency fund equivalent;
    # we anchor 100 at 6 months, but with taxable brokerage included,
    # most invested users will score very high — which is honest:
    # they really do have plenty of runway accessible if needed.
    liquidity_score = max(0, min(100, (runway_months / 6.0) * 100))

    # ── Savings rate (90-day average, monthly equivalents) ──
    # Two flavors:
    #   visible_savings_rate = (bank_inflow − bank_outflow) / bank_inflow
    #     What's actually flowing through bank accounts. Systematically
    #     understates true savings because 401k payroll deferrals never
    #     touch the bank — they're deducted before the paycheck arrives.
    #   true_savings_rate = (visible_savings + payroll_deferral) / true_gross
    #     Adds the user-provided monthly_payroll_deferral to both income
    #     and savings. This is the number that reflects actual savings
    #     behavior including pre-tax payroll contributions.
    raw_inflow_90d = (
        db.query(func.coalesce(func.sum(-Transaction.amount), 0.0))
        .filter(
            Transaction.date >= last_90,
            Transaction.amount < 0,
            Transaction.is_transfer == False,  # noqa: E712
        )
        .scalar()
        or 0.0
    )
    monthly_inflow = raw_inflow_90d / 3.0
    if monthly_inflow > 0:
        visible_savings_rate = (monthly_inflow - monthly_outflow) / monthly_inflow
    else:
        visible_savings_rate = 0
    # True rate adds payroll deferral to both numerator and denominator.
    # Net effect: true rate is always >= visible rate (assuming deferral > 0).
    true_gross = monthly_inflow + monthly_payroll_deferral
    if true_gross > 0:
        true_savings = (monthly_inflow - monthly_outflow) + monthly_payroll_deferral
        true_savings_rate = true_savings / true_gross
    else:
        true_savings_rate = 0
    # Score uses the TRUE rate when payroll deferral is set; otherwise
    # falls back to visible. 0% → 0, 30%+ → 100 (FIRE-grade).
    rate_for_score = true_savings_rate if monthly_payroll_deferral > 0 else visible_savings_rate
    savings_score = max(0, min(100, (rate_for_score / 0.30) * 100))

    # ── Debt service: liabilities ÷ total assets ──
    assets = (
        db.query(func.coalesce(func.sum(Account.current_balance), 0.0))
        .filter(Account.type.in_(("depository", "checking", "savings", "investment", "brokerage")))
        .scalar()
        or 0.0
    )
    liabilities = (
        db.query(func.coalesce(func.sum(Account.current_balance), 0.0))
        .filter(Account.type.in_(("credit", "loan", "mortgage")))
        .scalar()
        or 0.0
    )
    if assets > 0:
        debt_ratio = liabilities / assets
    else:
        debt_ratio = 1.0
    # Score: 0% debt = 100, 100%+ debt = 0
    debt_score = max(0, min(100, (1 - debt_ratio) * 100))

    # ── Budget adherence — count budgets under-spent vs over-spent.
    # Simplification: just count categories under budget for this month.
    all_budgets = db.query(Budget).all() if False else []  # skip for now if Budget query is complex
    budget_score = 75.0  # placeholder — could be computed from BudgetCategory totals

    # Composite score (weighted average)
    weights = {"liquidity": 0.30, "savings": 0.30, "debt": 0.25, "budget": 0.15}
    overall = (
        liquidity_score * weights["liquidity"]
        + savings_score * weights["savings"]
        + debt_score * weights["debt"]
        + budget_score * weights["budget"]
    )

    return {
        "score": round(overall, 1),
        "components": {
            "liquidity": {
                "score": round(liquidity_score, 1),
                "value": round(runway_months, 1),
                "label": "months of runway",
                "weight": weights["liquidity"],
                # Breakdown so the UI can show "Cash $X + Brokerage $Y"
                "pure_cash": round(pure_cash, 2),
                "taxable_brokerage": round(taxable_brokerage, 2),
                "available_runway": round(available_runway, 2),
            },
            "savings": {
                "score": round(savings_score, 1),
                "value": round(rate_for_score * 100, 1),
                "label": "savings rate %",
                "weight": weights["savings"],
                # Both flavors so the UI can show "20% visible / 33% true"
                # when payroll_deferral is set, or just one number otherwise.
                "visible_rate_pct": round(visible_savings_rate * 100, 1),
                "true_rate_pct": round(true_savings_rate * 100, 1),
                "monthly_payroll_deferral": round(monthly_payroll_deferral, 2),
                "uses_true_rate": monthly_payroll_deferral > 0,
            },
            "debt": {
                "score": round(debt_score, 1),
                "value": round(debt_ratio * 100, 1),
                "label": "debt-to-assets %",
                "weight": weights["debt"],
            },
            "budget": {
                "score": round(budget_score, 1),
                "value": None,
                "label": "budget adherence",
                "weight": weights["budget"],
            },
        },
        "context": {
            "current_cash": round(pure_cash, 2),
            "taxable_brokerage": round(taxable_brokerage, 2),
            "available_runway": round(available_runway, 2),
            "monthly_inflow": round(monthly_inflow, 2),
            "monthly_outflow": round(monthly_outflow, 2),
            "total_assets": round(assets, 2),
            "total_liabilities": round(liabilities, 2),
        },
    }


@router.get("/insights")
def get_insights(
    limit: int = Query(default=5, ge=1, le=10),
    db: Session = Depends(get_db),
) -> InsightsResponse:
    """Generate up to N insight cards from recent spending anomalies.

    Returns three signal types:
      1. Category spending up vs trailing baseline
      2. First-time merchants in the last 14 days
      3. Unusually large single transactions at a merchant
    """
    today = date.today()
    cards: list[InsightCard] = []

    # Signal 1: Category spending up vs trailing 3-mo average
    # Current month-to-date vs avg of same fraction-of-month in last 3 calendar months
    mtd_start = date(today.year, today.month, 1)
    days_in_month = (date(today.year, today.month + 1, 1) if today.month < 12
                     else date(today.year + 1, 1, 1)) - mtd_start
    days_elapsed = (today - mtd_start).days + 1
    fraction_of_month = days_elapsed / days_in_month.days

    # Gather current MTD spending by category
    cur_txns = db.query(Transaction).filter(
        Transaction.date >= mtd_start,
        Transaction.date <= today,
        Transaction.amount > 0,
        Transaction.is_transfer.is_(False),
    ).all()

    cur_by_cat: dict[str, float] = defaultdict(float)
    for t in cur_txns:
        cat = t.custom_category or t.category or "Uncategorized"
        cur_by_cat[cat] += t.amount

    # Gather the same fraction of the last 3 calendar months for baseline
    baseline_by_cat: dict[str, list[float]] = defaultdict(list)
    for offset in range(1, 4):
        # Compute month/year offset
        m = today.month - offset
        y = today.year
        while m <= 0:
            m += 12
            y -= 1
        m_start = date(y, m, 1)
        m_end = date(y, m + 1, 1) if m < 12 else date(y + 1, 1, 1)
        m_days = (m_end - m_start).days
        # Same fraction of the month
        cutoff = m_start + timedelta(days=int(m_days * fraction_of_month))

        m_txns = db.query(Transaction).filter(
            Transaction.date >= m_start,
            Transaction.date <= cutoff,
            Transaction.amount > 0,
            Transaction.is_transfer.is_(False),
        ).all()

        m_by_cat: dict[str, float] = defaultdict(float)
        for t in m_txns:
            cat = t.custom_category or t.category or "Uncategorized"
            m_by_cat[cat] += t.amount

        for cat, amt in m_by_cat.items():
            baseline_by_cat[cat].append(amt)

    # Check each category for anomalies
    for cat, cur_amt in cur_by_cat.items():
        if cat not in baseline_by_cat or not baseline_by_cat[cat]:
            continue
        baseline_avg = sum(baseline_by_cat[cat]) / len(baseline_by_cat[cat])
        if baseline_avg <= 0:
            continue
        # Signal fires: cur > 1.30 * baseline AND cur > $50
        if cur_amt > baseline_avg * 1.30 and cur_amt > 50:
            pct_increase = round(((cur_amt - baseline_avg) / baseline_avg) * 100, 0)
            cards.append(InsightCard(
                type="category_up",
                title=f"{cat} is up {int(pct_increase)}% this month",
                subtitle=f"${cur_amt:.2f} vs ${baseline_avg:.2f} trailing avg",
                severity="warning",
                category=cat,
                amount=cur_amt,
            ))

    # Signal 2: First-time merchants (last 14 days, amount > $50)
    # Check merchants whose first transaction is within last 14 days
    cutoff_14d = today - timedelta(days=14)

    # Get all merchants before cutoff (baseline)
    prior_txns = db.query(Transaction).filter(
        Transaction.date < cutoff_14d,
        Transaction.is_transfer.is_(False),
    ).all()
    seen_merchants: set[str] = set()
    for t in prior_txns:
        norm = normalize_merchant(t.merchant_name or t.name or "")
        if norm:
            seen_merchants.add(norm.lower())

    # Get recent txns and find new merchants
    recent_txns = db.query(Transaction).filter(
        Transaction.date >= cutoff_14d,
        Transaction.date <= today,
        Transaction.amount > 0,
        Transaction.is_transfer.is_(False),
    ).all()

    new_merchants: dict[str, list[Transaction]] = defaultdict(list)
    for t in recent_txns:
        norm = normalize_merchant(t.merchant_name or t.name or "")
        if norm and norm.lower() not in seen_merchants and t.amount > 50:
            new_merchants[norm].append(t)

    # Cap at 3 new merchant cards
    for merchant, txn_list in sorted(new_merchants.items(),
                                      key=lambda x: max(t.amount for t in x[1]),
                                      reverse=True)[:3]:
        max_amt = max(t.amount for t in txn_list)
        cards.append(InsightCard(
            type="new_merchant",
            title=f"First time at {merchant}",
            subtitle=f"${max_amt:.2f} transaction",
            severity="info",
            merchant=merchant,
            amount=max_amt,
        ))

    # Signal 3: Unusually large transaction at a merchant
    # Last 14 days: if single txn > 2x median historical at that merchant
    # (must have >=3 prior txns to qualify)
    # Group all historical transactions by normalized merchant
    all_txns = db.query(Transaction).filter(
        Transaction.amount > 0,
        Transaction.is_transfer.is_(False),
    ).all()

    merchant_history: dict[str, list[float]] = defaultdict(list)
    for t in all_txns:
        norm = normalize_merchant(t.merchant_name or t.name or "")
        if norm:
            merchant_history[norm.lower()].append(t.amount)

    # Check recent transactions for unusual amounts
    large_txn_cards: list[InsightCard] = []
    for t in recent_txns:
        norm = normalize_merchant(t.merchant_name or t.name or "")
        if not norm:
            continue
        norm_lower = norm.lower()
        if norm_lower not in merchant_history or len(merchant_history[norm_lower]) < 3:
            continue
        # Median of all historical amounts at this merchant
        historical = merchant_history[norm_lower]
        median_amt = sorted(historical)[len(historical) // 2]
        # Fire if current > 2x median
        if t.amount > median_amt * 2:
            large_txn_cards.append(InsightCard(
                type="large_transaction",
                title=f"Unusually large: {norm}",
                subtitle=f"${t.amount:.2f} vs ${median_amt:.2f} typical",
                severity="alert",
                merchant=norm,
                amount=t.amount,
            ))

    # Cap at 3 large transaction cards, sort by severity
    large_txn_cards.sort(key=lambda c: c.amount or 0, reverse=True)
    cards.extend(large_txn_cards[:3])

    # Signal 4: Recurring-charge anomaly — a known recurring subscription
    # whose latest charge jumped >25% above the median (price hike, plan
    # change, currency conversion, etc.). Reuses the existing recurring
    # detector's is_anomalous flag so we don't recompute.
    try:
        recurring_detail = detect_recurring(db=db)  # returns full payload
        recurring_items = recurring_detail.get("recurring", []) if isinstance(recurring_detail, dict) else []
    except Exception:
        recurring_items = []
    recurring_anomaly_cards: list[InsightCard] = []
    for r in recurring_items:
        if not r.get("is_anomalous"):
            continue
        latest = r.get("latest_amount") or 0
        median = r.get("median_amount") or 0
        if latest <= 0 or median <= 0:
            continue
        delta_pct = round(((latest - median) / median) * 100, 0)
        recurring_anomaly_cards.append(InsightCard(
            type="recurring_anomaly",
            title=f"{r.get('merchant', 'Subscription')} charged {int(delta_pct)}% more",
            subtitle=f"${latest:.2f} vs ${median:.2f} typical · {r.get('frequency', 'recurring')}",
            severity="warning",
            merchant=r.get("merchant"),
            amount=latest,
        ))
    # Show top 3 anomalies sorted by largest delta.
    recurring_anomaly_cards.sort(key=lambda c: c.amount or 0, reverse=True)
    cards.extend(recurring_anomaly_cards[:3])

    # Sort by recency/severity: category_up → large_transaction → new_merchant
    # Within each type, higher amount first
    type_order = {"category_up": 0, "large_transaction": 1, "new_merchant": 2}
    cards.sort(key=lambda c: (type_order.get(c.type, 3), -(c.amount or 0)))

    # Cap total at limit
    cards = cards[:limit]

    return InsightsResponse(cards=cards, generated_at=datetime.utcnow())


# ─── AI Narrative (optional, Ollama-backed) ─────────────────
#
# Sibling to /insights above. Same underlying signals (MTD vs trailing
# baseline, top movers, largest single transaction), but rolled into a
# single structured bundle and handed to a local LLM that writes 2-3
# paragraphs of plain English around the numbers.
#
# Three response shapes the frontend needs to handle:
#   200 {narrative, source: "ollama"|"demo", generated_at, from_cache}
#       — happy path
#   200 {narrative: null, source: "disabled", generated_at, from_cache: false}
#       — feature off
#   503 — Ollama enabled but unreachable (model not pulled, daemon
#         down, etc.). Frontend shows a quiet "set up Ollama" hint.
#
# Demo mode (fintrack_mode=demo cookie) ALWAYS returns the canned
# DEMO_NARRATIVE — even if Ollama is enabled and reachable. Two reasons:
# the demo data is synthetic so an LLM-generated narrative would either
# be uselessly generic or wrongly specific, and we want the marketing
# screenshots to be reproducible without depending on any model output.
#
# Caching: a single-entry, in-process, date-keyed cache. Once-per-day
# TTL is the right default for this kind of qualitative summary —
# refreshing on every Dashboard mount would be 5-15s of wasted local
# inference for output that almost never changes within a day. Manual
# `?refresh=true` lets the user force a regen after a Plaid sync. The
# cache is dropped on backend restart, which is fine — restarts are
# rare in steady state, and a fresh narrative on first load after a
# restart is a feature, not a bug. Demo + disabled paths skip the
# cache entirely (they're already instant).
_NARRATIVE_CACHE: dict[str, dict] = {}  # key: ISO date, value: response dict


@router.get("/narrative")
def get_narrative(
    request: Request,
    db: Session = Depends(get_db),
    refresh: bool = Query(default=False, description="Bypass the daily cache and force a fresh LLM call"),
):
    """Plain-English summary of this month's finances for the Dashboard.

    Returns canned text in demo mode so screenshots work offline.
    Returns the LLM-generated text when LLM_ENABLED=true and Ollama is
    reachable. Returns a `disabled` source when the feature is off, so
    the frontend can show its setup-hint state.

    Result is cached for the calendar day; pass `?refresh=true` to
    force a regen (used by the refresh button on the card).
    """
    is_demo = request.cookies.get("fintrack_mode") == "demo"
    now_iso = datetime.utcnow().isoformat() + "Z"

    if is_demo:
        return {
            "narrative": DEMO_NARRATIVE,
            "source": "demo",
            "model": None,
            "generated_at": now_iso,
            "from_cache": False,
        }

    if not settings.LLM_ENABLED:
        return {
            "narrative": None,
            "source": "disabled",
            "model": None,
            "generated_at": now_iso,
            "from_cache": False,
        }

    today_key = date.today().isoformat()

    # Serve from cache unless the caller explicitly asked for fresh.
    # Cache hit returns the original `generated_at` (when the LLM
    # actually ran) so the frontend's "Generated at" label stays
    # truthful — not the time of THIS request.
    if not refresh and today_key in _NARRATIVE_CACHE:
        cached = _NARRATIVE_CACHE[today_key]
        return {**cached, "from_cache": True}

    bundle = build_insights_bundle(db)
    client = OllamaClient(base_url=settings.LLM_URL, model=settings.LLM_MODEL)

    # Cheap pre-flight check so the user sees a clean 503 instead of a
    # 60-second hang when Ollama isn't running or the requested model
    # isn't pulled. Skipping this for the model check would let Ollama
    # silently start downloading multi-GB weights on the first request.
    if not client.health():
        raise HTTPException(
            status_code=503,
            detail=(
                f"Ollama not reachable at {settings.LLM_URL}. "
                f"Start it with `ollama serve` or set LLM_ENABLED=false."
            ),
        )
    if not client.has_model(settings.LLM_MODEL):
        raise HTTPException(
            status_code=503,
            detail=(
                f"Ollama is up but model '{settings.LLM_MODEL}' is not pulled. "
                f"Run `ollama pull {settings.LLM_MODEL}` and try again."
            ),
        )

    try:
        text = client.complete(SYSTEM_PROMPT, build_user_prompt(bundle))
    except LLMUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    result = {
        "narrative": text,
        "source": "ollama",
        "model": settings.LLM_MODEL,
        "generated_at": now_iso,
        "from_cache": False,
    }

    # Replace the whole cache (single-entry, date-keyed). This auto-
    # evicts yesterday's entry when today's first request lands —
    # no separate cleanup needed.
    _NARRATIVE_CACHE.clear()
    _NARRATIVE_CACHE[today_key] = result
    return result


# ─── CSV Export ──────────────────────────────────────────────
@router.get("/export")
def export_csv(
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    account_id: Optional[int] = None,
    category: Optional[str] = None,
    business_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    """Export transactions as CSV for tax prep or record keeping.
    Now respects the same filters available on the Transactions page —
    account / category / business — so the user can download a slice
    that matches what they see in the UI."""
    query = db.query(Transaction).order_by(Transaction.date.desc())
    if start_date:
        query = query.filter(Transaction.date >= start_date)
    if end_date:
        query = query.filter(Transaction.date <= end_date)
    if account_id:
        query = query.filter(Transaction.account_id == account_id)
    if business_id:
        query = query.filter(Transaction.business_id == business_id)
    if category:
        query = query.filter(
            (Transaction.custom_category == category) | (Transaction.category == category)
        )

    txns = query.all()

    # Build account lookup
    accounts = {a.id: a for a in db.query(Account).all()}

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Date", "Description", "Merchant", "Category", "Account", "Account Type", "Amount", "Currency"])

    for t in txns:
        acct = accounts.get(t.account_id)
        writer.writerow([
            t.date.isoformat() if hasattr(t.date, 'isoformat') else str(t.date),
            t.name,
            t.merchant_name or "",
            t.custom_category or t.category or "Uncategorized",
            acct.name if acct else "",
            acct.type if acct else "",
            t.amount,
            t.currency or "USD",
        ])

    output.seek(0)
    filename = f"tuskledger_transactions"
    if start_date:
        filename += f"_{start_date}"
    if end_date:
        filename += f"_to_{end_date}"
    filename += ".csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ─── Year-over-Year Comparison ──────────────────────────────
@router.get("/year-over-year")
def year_over_year_comparison(
    month: int = Query(..., ge=1, le=12),
    year: int = Query(...),
    db: Session = Depends(get_db),
):
    """Compare spending breakdown for a given month vs same month one year prior."""

    def get_month_data(target_month: int, target_year: int):
        """Fetch transactions for a specific month, aggregate by category."""
        start = date(target_year, target_month, 1)
        # Last day of month
        if target_month == 12:
            end = date(target_year + 1, 1, 1) - timedelta(days=1)
        else:
            end = date(target_year, target_month + 1, 1) - timedelta(days=1)

        txns = (
            db.query(Transaction)
            .filter(
                Transaction.date >= start,
                Transaction.date <= end,
                Transaction.is_transfer.is_(False),
            )
            .all()
        )

        # Expand splits so each split category gets attributed correctly
        lines = list(expand(txns))
        
        categories = defaultdict(float)
        total_spending = 0.0
        total_income = 0.0
        
        for line in lines:
            friendly_cat = map_plaid_category(line.category) or line.category
            if line.amount >= 0:
                categories[friendly_cat] += line.amount
                total_spending += line.amount
            else:
                # Income is negative in the system
                categories[friendly_cat] += abs(line.amount)
                total_income += abs(line.amount)
        
        return {
            "month": target_month,
            "year": target_year,
            "total_spending": round(total_spending, 2),
            "total_income": round(total_income, 2),
            "net": round(total_income - total_spending, 2),
            "categories": [
                {"category": cat, "amount": round(amt, 2)}
                for cat, amt in sorted(categories.items(), key=lambda x: x[1], reverse=True)
            ],
        }
    
    current = get_month_data(month, year)
    prior = get_month_data(month, year - 1)
    
    # Calculate deltas
    def safe_pct(current_val, prior_val):
        if prior_val == 0:
            return 0.0 if current_val == 0 else (100.0 if current_val > 0 else -100.0)
        return round(((current_val - prior_val) / abs(prior_val)) * 100, 1)
    
    deltas = {
        "spending_pct": safe_pct(current["total_spending"], prior["total_spending"]),
        "income_pct": safe_pct(current["total_income"], prior["total_income"]),
        "net_pct": safe_pct(current["net"], prior["net"]),
        "by_category": [],
    }
    
    # Category-by-category deltas
    all_cats = set()
    for cat_data in current["categories"] + prior["categories"]:
        all_cats.add(cat_data["category"])
    
    for cat in sorted(all_cats):
        current_amt = next((c["amount"] for c in current["categories"] if c["category"] == cat), 0.0)
        prior_amt = next((c["amount"] for c in prior["categories"] if c["category"] == cat), 0.0)
        delta_pct = safe_pct(current_amt, prior_amt)
        deltas["by_category"].append({
            "category": cat,
            "current": current_amt,
            "prior": prior_amt,
            "delta_pct": delta_pct,
        })
    
    return {
        "current": current,
        "prior": prior,
        "deltas": deltas,
    }


# ─── Cash Flow Calendar ────────────────────────────────────
@router.get("/cashflow-calendar")
def cashflow_calendar(
    days: int = Query(default=30, le=180),
    db: Session = Depends(get_db),
):
    """Return expected cash events (bills/paychecks) for the next N days."""
    today = date.today()
    
    # Reuse detect_recurring logic to find all recurring transactions with next_expected dates
    cutoff = today - timedelta(days=365)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= cutoff,
            Transaction.is_transfer.is_(False),
        )
        .order_by(Transaction.date)
        .all()
    )
    
    merchant_txns = defaultdict(list)
    for t in txns:
        raw = (t.merchant_name or t.name or "Unknown").strip()
        key = normalize_merchant(raw) or raw
        merchant_txns[key].append(t)
    
    # Extract recurring events
    events = []
    for merchant, txn_list in merchant_txns.items():
        if len(txn_list) < 2:
            continue
        
        sorted_txns = sorted(txn_list, key=lambda x: x.date)
        amounts = [t.amount for t in sorted_txns]
        dates_ = [t.date for t in sorted_txns]
        
        # Skip mixed-sign merchants
        if any(a > 0 for a in amounts) and any(a < 0 for a in amounts):
            continue
        
        is_income = amounts[0] < 0
        abs_amounts = [abs(a) for a in amounts]
        median_amount = sorted(abs_amounts)[len(abs_amounts) // 2]
        if median_amount <= 0:
            continue
        
        # Check if it passes variance tolerance
        tolerance = 0.60 if is_income else 0.25
        if not all(abs(a - median_amount) / median_amount < tolerance for a in abs_amounts):
            continue
        
        intervals = [(dates_[i + 1] - dates_[i]).days for i in range(len(dates_) - 1)]
        if not intervals:
            continue
        
        sorted_intervals = sorted(intervals)
        median_interval = sorted_intervals[len(sorted_intervals) // 2]
        
        classification = _classify_frequency(median_interval)
        if not classification:
            continue
        
        # Compute next expected date
        last_date = dates_[-1]
        candidate = last_date + timedelta(days=int(median_interval))
        next_date = candidate
        
        # Only include if within the lookahead window
        if next_date >= today and (next_date - today).days <= days:
            # Compute confidence based on historical occurrences
            if len(txn_list) >= 6:
                confidence = 0.95
            elif len(txn_list) >= 3:
                confidence = 0.70
            else:
                confidence = 0.50
            
            events.append({
                "date": next_date.isoformat(),
                "type": "income" if is_income else "expense",
                "merchant": merchant,
                "amount": round(abs(median_amount), 2),
                "confidence": confidence,
            })
    
    # Sort by date
    events.sort(key=lambda e: e["date"])
    
    # Compute summary
    total_income = sum(e["amount"] for e in events if e["type"] == "income")
    total_expenses = sum(e["amount"] for e in events if e["type"] == "expense")
    
    # Starting cash balance — sum of all depository accounts. Used by
    # the frontend to compute a running daily balance through the
    # forecast window so the user can see which day they hit a low
    # point or risk an overdraft. Same definition as cash-flow-health
    # for the cash portion (taxable brokerage isn't included here
    # because the calendar is about checking/savings cash flow, not
    # available emergency runway).
    starting_cash = sum(
        float(a.current_balance or 0)
        for a in db.query(Account).filter(Account.type == "depository").all()
    )

    return {
        "as_of": today.isoformat(),
        "days_ahead": days,
        "events": events,
        "starting_cash": round(starting_cash, 2),
        "summary": {
            "total_expected_income": round(total_income, 2),
            "total_expected_expenses": round(total_expenses, 2),
            "net": round(total_income - total_expenses, 2),
        },
    }


# ─── Net Worth Projection ──────────────────────────────────
@router.get("/networth-projection")
def networth_projection(
    months: int = Query(default=12, ge=1, le=60),
    db: Session = Depends(get_db),
):
    """Project net worth forward based on historical trend."""
    today = date.today()
    
    # Pull last 90 days of snapshots
    cutoff = today - timedelta(days=90)
    snapshots = (
        db.query(NetWorthSnapshot)
        .filter(NetWorthSnapshot.date >= cutoff)
        .order_by(NetWorthSnapshot.date)
        .all()
    )
    
    if len(snapshots) < 2:
        # Need at least 2 data points to draw any kind of trend line.
        return {
            "historical": [],
            "projected": [],
            "monthly_pace": None,
            "confidence": "low",
            "reason": "Need at least 2 net-worth snapshots to project. Wait for the next sync.",
        }

    # Downsample to monthly by picking last snapshot of each month
    historical_data = []
    current_month = None
    last_of_month = None

    for snap in snapshots:
        snap_month = (snap.date.year, snap.date.month)
        if snap_month != current_month:
            if last_of_month:
                historical_data.append(last_of_month)
            current_month = snap_month
            last_of_month = snap
        else:
            last_of_month = snap

    if last_of_month:
        historical_data.append(last_of_month)

    # Compute average monthly delta. Two paths:
    #   - Multi-month history (>=2 monthly buckets): use month-over-month
    #     deltas — most stable signal, smooths out daily noise.
    #   - Sub-month history but at least 14 days: fall back to daily
    #     pace × 30. Less stable, "low" confidence.
    #   - Less than 14 days: refuse with a reason. Earlier snapshots
    #     during account onboarding (when not all institutions have
    #     synced yet) skew daily pace by orders of magnitude — a
    #     newly-linked account flipping from $0 to $200k in two days
    #     would project +$3M/month, which is worse than no projection.
    if len(historical_data) >= 2:
        first_nw = historical_data[0].net_worth or 0.0
        last_nw = historical_data[-1].net_worth or 0.0
        num_months = len(historical_data) - 1
        monthly_pace = (last_nw - first_nw) / num_months if num_months > 0 else 0.0
    else:
        first_snap = snapshots[0]
        last_snap = snapshots[-1]
        days_span = (last_snap.date - first_snap.date).days
        if days_span < 14:
            return {
                "historical": [],
                "projected": [],
                "monthly_pace": None,
                "confidence": "low",
                "reason": (
                    f"Only {days_span} day{'s' if days_span != 1 else ''} of net-worth history. "
                    "Need at least 14 days for a meaningful projection — early snapshots during "
                    "account onboarding (before all institutions have synced) would skew the trend."
                ),
            }
        first_nw = first_snap.net_worth or 0.0
        last_nw = last_snap.net_worth or 0.0
        daily_pace = (last_nw - first_nw) / days_span
        monthly_pace = daily_pace * 30
        # We only have one month "bucket" — record it so the historical
        # array still has something for the frontend to anchor on.
        historical_data = [last_snap]
    
    # Determine confidence based on data quality
    if len(snapshots) >= 60:
        confidence = "high"
    elif len(snapshots) >= 30:
        confidence = "medium"
    else:
        confidence = "low"
    
    # Return historical as array of {date, net_worth}
    historical = [
        {"date": snap.date.isoformat(), "net_worth": round(snap.net_worth or 0.0, 2)}
        for snap in historical_data
    ]
    
    # Project forward N months
    projected = []
    last_date = historical_data[-1].date
    last_nw = historical_data[-1].net_worth or 0.0
    
    for i in range(1, months + 1):
        # Add months to last_date
        proj_month = last_date.month + i
        proj_year = last_date.year + ((proj_month - 1) // 12)
        proj_month = ((proj_month - 1) % 12) + 1
        
        # Use last day of month
        if proj_month == 12:
            proj_date = date(proj_year + 1, 1, 1) - timedelta(days=1)
        else:
            proj_date = date(proj_year, proj_month + 1, 1) - timedelta(days=1)
        
        proj_nw = last_nw + (monthly_pace * i)
        projected.append({
            "date": proj_date.isoformat(),
            "net_worth": round(proj_nw, 2),
            "is_projection": True,
        })
    
    return {
        "historical": historical,
        "projected": projected,
        "monthly_pace": round(monthly_pace, 2),
        "confidence": confidence,
    }


# ─── HSA Contribution Tracker ───────────────────────────────────────
# Helps avoid leaving HSA tax savings on the table — a common pattern
# where a family-HDHP HSA is funded only via employer contribution and
# the personal-side gap goes unfunded all year, costing real federal +
# state tax savings. Frontend stores per-account YTD contributions in
# localStorage; this endpoint just returns the IRS limits and the list
# of detected HSA accounts so the UI has a single source of truth.

@router.get("/hsa-status")
def hsa_status(
    year: int = Query(default=date.today().year, ge=2024, le=2030),
    db: Session = Depends(get_db),
):
    """Return HSA accounts in the system + IRS contribution limits for
    the given tax year. The frontend overlays per-account YTD
    contribution amounts (from localStorage) and computes the remaining
    headroom + dollarized tax savings.

    HSA detection is liberal — matches subtype='hsa' OR name containing
    'HSA' (case-insensitive) so it catches both Plaid-synced accounts
    and manual entries. Tighten if false positives become a problem.
    """
    hsas = (
        db.query(Account)
        .filter(
            (Account.subtype.ilike("%hsa%")) | (Account.name.ilike("%hsa%"))
        )
        .all()
    )
    # HSA contribution deadline = federal tax-filing deadline of the
    # following year. For prior tax years where the deadline has passed,
    # this is informational only.
    deadline = date(year + 1, 4, 15)
    days_remaining = max(0, (deadline - date.today()).days)
    return {
        "year": year,
        "limits": {
            "self": hsa_limit(year, "self"),
            "family": hsa_limit(year, "family"),
            "self_55_plus": hsa_limit(year, "self", age=55),
            "family_55_plus": hsa_limit(year, "family", age=55),
            "catch_up_55_plus": HSA_LIMITS.get(
                year, HSA_LIMITS[max(HSA_LIMITS.keys())]
            )["catch_up_55_plus"],
        },
        "deadline": deadline.isoformat(),
        "days_remaining": days_remaining,
        "accounts": [
            {
                "id": a.id,
                "name": a.custom_name or a.name,
                "current_balance": a.current_balance,
                "institution_name": a.institution_name,
                "subtype": a.subtype,
            }
            for a in hsas
        ],
    }
