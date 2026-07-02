"""Business routes — CRUD, tagging, P&L reporting."""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.database import get_db
from app.models import Transaction, Account, Business
from app.services.categories import CATEGORY_ICONS
from app.utils import utcnow

router = APIRouter(prefix="/api/businesses", tags=["businesses"])


# ─── Business CRUD ─────────────────────────────────────────
@router.get("/")
def list_businesses(db: Session = Depends(get_db)):
    """List all businesses."""
    businesses = db.query(Business).order_by(Business.name).all()
    return [_business_to_dict(b) for b in businesses]


@router.post("/")
def create_business(body: dict, db: Session = Depends(get_db)):
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "Business name is required")

    existing = db.query(Business).filter_by(name=name).first()
    if existing:
        raise HTTPException(409, f"Business '{name}' already exists")

    biz = Business(
        name=name,
        color=body.get("color", "#6366f1"),
        icon=body.get("icon", "briefcase"),
        description=body.get("description", ""),
    )
    db.add(biz)
    db.commit()
    db.refresh(biz)
    return _business_to_dict(biz)


@router.put("/{business_id}")
def update_business(business_id: int, body: dict, db: Session = Depends(get_db)):
    biz = db.query(Business).filter_by(id=business_id).first()
    if not biz:
        raise HTTPException(404, "Business not found")

    if "name" in body:
        biz.name = body["name"].strip()
    if "color" in body:
        biz.color = body["color"]
    if "icon" in body:
        biz.icon = body["icon"]
    if "description" in body:
        biz.description = body["description"]
    if "is_active" in body:
        biz.is_active = 1 if body["is_active"] else 0

    db.commit()
    db.refresh(biz)
    return _business_to_dict(biz)


@router.delete("/{business_id}")
def delete_business(business_id: int, db: Session = Depends(get_db)):
    biz = db.query(Business).filter_by(id=business_id).first()
    if not biz:
        raise HTTPException(404, "Business not found")

    # Un-tag all transactions belonging to this business
    db.query(Transaction).filter_by(business_id=business_id).update({"business_id": None})
    db.delete(biz)
    db.commit()
    return {"status": "deleted"}


# ─── Bulk tag / untag ──────────────────────────────────────
@router.post("/{business_id}/tag")
def tag_transactions(business_id: int, body: dict, db: Session = Depends(get_db)):
    """Tag one or more transactions with a business."""
    biz = db.query(Business).filter_by(id=business_id).first()
    if not biz:
        raise HTTPException(404, "Business not found")

    txn_ids = body.get("transaction_ids", [])
    if not txn_ids:
        raise HTTPException(400, "transaction_ids required")

    count = (
        db.query(Transaction)
        .filter(Transaction.id.in_(txn_ids))
        # updated_at set explicitly: bulk UPDATE bypasses the ORM onupdate
        # hook, and mobile incremental sync filters on updated_at.
        .update(
            {"business_id": business_id, "updated_at": utcnow()},
            synchronize_session="fetch",
        )
    )
    db.commit()
    return {"tagged": count}


@router.post("/untag")
def untag_transactions(body: dict, db: Session = Depends(get_db)):
    """Remove business tag from transactions."""
    txn_ids = body.get("transaction_ids", [])
    if not txn_ids:
        raise HTTPException(400, "transaction_ids required")

    count = (
        db.query(Transaction)
        .filter(Transaction.id.in_(txn_ids))
        .update(
            {"business_id": None, "updated_at": utcnow()},
            synchronize_session="fetch",
        )
    )
    db.commit()
    return {"untagged": count}


# ─── P&L Report ────────────────────────────────────────────
@router.get("/{business_id}/report")
def business_report(
    business_id: int,
    months: int = Query(default=12, le=60),
    db: Session = Depends(get_db),
):
    """Full P&L report for a business."""
    biz = db.query(Business).filter_by(id=business_id).first()
    if not biz:
        raise HTTPException(404, "Business not found")

    cutoff = date.today() - timedelta(days=months * 30)
    txns = (
        db.query(Transaction)
        .filter(Transaction.business_id == business_id, Transaction.date >= cutoff)
        .order_by(Transaction.date)
        .all()
    )

    # Monthly breakdown
    monthly = defaultdict(lambda: {"income": 0.0, "expenses": 0.0, "transactions": 0})
    by_category = defaultdict(float)
    total_income = 0.0
    total_expenses = 0.0

    for t in txns:
        month_key = t.date.strftime("%Y-%m") if hasattr(t.date, 'strftime') else str(t.date)[:7]
        cat = t.custom_category or t.category or "Uncategorized"

        if t.amount < 0:
            # Negative = income (Plaid convention)
            amt = abs(t.amount)
            monthly[month_key]["income"] += amt
            total_income += amt
        else:
            monthly[month_key]["expenses"] += t.amount
            total_expenses += t.amount
            by_category[cat] += t.amount

        monthly[month_key]["transactions"] += 1

    # Sort monthly and build list
    monthly_list = []
    for key in sorted(monthly.keys()):
        d = monthly[key]
        monthly_list.append({
            "month": key,
            "income": round(d["income"], 2),
            "expenses": round(d["expenses"], 2),
            "net": round(d["income"] - d["expenses"], 2),
            "transactions": d["transactions"],
        })

    # Category breakdown (expenses only)
    categories = sorted(by_category.items(), key=lambda x: x[1], reverse=True)
    category_list = [
        {
            "category": cat,
            "amount": round(amt, 2),
            "icon": CATEGORY_ICONS.get(cat, "\U0001f4e6"),
            "percentage": round(amt / total_expenses * 100, 1) if total_expenses > 0 else 0,
        }
        for cat, amt in categories
    ]

    # Top merchants
    merchant_spend = defaultdict(float)
    for t in txns:
        if t.amount > 0:
            merchant_spend[t.merchant_name or t.name or "Unknown"] += t.amount
    top_merchants = [
        {"merchant": m, "amount": round(a, 2)}
        for m, a in sorted(merchant_spend.items(), key=lambda x: x[1], reverse=True)[:10]
    ]

    return {
        "business": _business_to_dict(biz),
        "period_months": months,
        "summary": {
            "total_income": round(total_income, 2),
            "total_expenses": round(total_expenses, 2),
            "net_profit": round(total_income - total_expenses, 2),
            "transaction_count": len(txns),
            "avg_monthly_expenses": round(total_expenses / max(len(monthly_list), 1), 2),
            "avg_monthly_income": round(total_income / max(len(monthly_list), 1), 2),
        },
        "monthly": monthly_list,
        "categories": category_list,
        "top_merchants": top_merchants,
    }


# ─── Overview (all businesses) ─────────────────────────────
@router.get("/overview/summary")
def businesses_overview(
    months: int = Query(default=6, le=24),
    db: Session = Depends(get_db),
):
    """Summary across all businesses for the overview page."""
    cutoff = date.today() - timedelta(days=months * 30)
    businesses = db.query(Business).filter_by(is_active=1).all()

    results = []
    for biz in businesses:
        txns = (
            db.query(Transaction)
            .filter(Transaction.business_id == biz.id, Transaction.date >= cutoff)
            .all()
        )
        income = sum(abs(t.amount) for t in txns if t.amount < 0)
        expenses = sum(t.amount for t in txns if t.amount > 0)
        results.append({
            **_business_to_dict(biz),
            "income": round(income, 2),
            "expenses": round(expenses, 2),
            "net": round(income - expenses, 2),
            "transaction_count": len(txns),
        })

    total_income = sum(r["income"] for r in results)
    total_expenses = sum(r["expenses"] for r in results)

    return {
        "businesses": results,
        "totals": {
            "income": round(total_income, 2),
            "expenses": round(total_expenses, 2),
            "net": round(total_income - total_expenses, 2),
        },
        "period_months": months,
    }


# ─── Business CSV Export ───────────────────────────────────
@router.get("/{business_id}/export")
def export_business_csv(
    business_id: int,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    db: Session = Depends(get_db),
):
    """Export business transactions as CSV."""
    biz = db.query(Business).filter_by(id=business_id).first()
    if not biz:
        raise HTTPException(404, "Business not found")

    query = (
        db.query(Transaction)
        .filter(Transaction.business_id == business_id)
        .order_by(Transaction.date.desc())
    )
    if start_date:
        query = query.filter(Transaction.date >= start_date)
    if end_date:
        query = query.filter(Transaction.date <= end_date)

    txns = query.all()
    accounts = {a.id: a for a in db.query(Account).all()}

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Date", "Description", "Merchant", "Category", "Account", "Type", "Amount", "Currency", "Business"])

    for t in txns:
        acct = accounts.get(t.account_id)
        writer.writerow([
            t.date.isoformat() if hasattr(t.date, 'isoformat') else str(t.date),
            t.name,
            t.merchant_name or "",
            t.custom_category or t.category or "Uncategorized",
            acct.name if acct else "",
            "Income" if t.amount < 0 else "Expense",
            t.amount,
            t.currency or "USD",
            biz.name,
        ])

    output.seek(0)
    safe_name = biz.name.replace(" ", "_").lower()
    filename = f"{safe_name}_transactions"
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


def _business_to_dict(biz: Business) -> dict:
    return {
        "id": biz.id,
        "name": biz.name,
        "color": biz.color,
        "icon": biz.icon,
        "description": biz.description or "",
        "is_active": bool(biz.is_active),
    }


# ─── Schedule C summary (per-business, per-tax-year) ─────────────────
# Walks every transaction tagged to a business in a given tax year and
# aggregates by Tusk Ledger category. The frontend overlays a per-category
# IRS Schedule C line mapping (kept in localStorage) and renders the
# TaxAct-ready totals. Asset Register (capital purchases for Form 4562)
# also lives in localStorage on the frontend — no DB schema change.

@router.get("/{business_id}/schedule-c-summary")
def schedule_c_summary(
    business_id: int,
    # Resolve the default INSIDE the handler: a Query default is evaluated
    # once at import, so date.today().year would freeze to the process's
    # start year and serve last year after a New-Year rollover. None →
    # resolve per-request.
    year: Optional[int] = Query(default=None, ge=2020, le=2030),
    db: Session = Depends(get_db),
):
    """Roll up a year's worth of business transactions for Schedule C
    preparation. Income (negative-amount transactions) and expenses
    (positive amounts) are returned separately, with expenses grouped
    by Tusk Ledger category so the UI can map each category onto an IRS
    Schedule C expense line.
    """
    year = year or date.today().year
    biz = db.query(Business).filter_by(id=business_id).first()
    if not biz:
        raise HTTPException(404, "Business not found")

    year_start = date(year, 1, 1)
    year_end = date(year, 12, 31)
    txns = (
        db.query(Transaction)
        .filter(
            Transaction.business_id == business_id,
            Transaction.date >= year_start,
            Transaction.date <= year_end,
        )
        .order_by(Transaction.date)
        .all()
    )

    # Aggregate income (negative-amount = inflow per Plaid convention).
    income_total = 0.0
    income_count = 0
    income_txns = []
    # Aggregate expenses by Tusk Ledger category.
    by_category: dict[str, dict] = {}

    for t in txns:
        cat = t.custom_category or t.category or "Uncategorized"
        merchant = t.display_name or t.merchant_name or t.name or ""
        if t.amount < 0:
            income_total += abs(t.amount)
            income_count += 1
            income_txns.append({
                "id": t.id,
                "date": t.date.isoformat() if hasattr(t.date, 'isoformat') else str(t.date),
                "merchant": merchant,
                "amount": round(abs(t.amount), 2),
                "category": cat,
            })
        else:
            row = by_category.setdefault(cat, {
                "category": cat,
                "total": 0.0,
                "count": 0,
                "merchants": set(),
                "transactions": [],
            })
            row["total"] += t.amount
            row["count"] += 1
            row["merchants"].add(merchant[:40])
            row["transactions"].append({
                "id": t.id,
                "date": t.date.isoformat() if hasattr(t.date, 'isoformat') else str(t.date),
                "merchant": merchant,
                "amount": round(t.amount, 2),
            })

    # Convert sets to sorted lists, round totals.
    expense_categories = []
    for row in by_category.values():
        row["total"] = round(row["total"], 2)
        row["merchants"] = sorted(row["merchants"])[:8]  # cap to 8 samples
        expense_categories.append(row)
    expense_categories.sort(key=lambda r: -r["total"])  # biggest first

    expense_total = round(sum(r["total"] for r in expense_categories), 2)

    return {
        "business_id": biz.id,
        "business_name": biz.name,
        "year": year,
        "income": {
            "gross_receipts": round(income_total, 2),
            "transaction_count": income_count,
            "transactions": income_txns[:50],  # cap for response size
        },
        "expenses": {
            "total": expense_total,
            "by_category": expense_categories,
        },
        "tentative_profit": round(income_total - expense_total, 2),
    }
