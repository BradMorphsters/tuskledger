"""Transaction routes."""
import secrets
from datetime import date, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from app.database import get_db
from app.models import Account, Transaction, TransactionSplit, Budget, BudgetCategory
from app.schemas.schemas import (
    TransactionOut,
    TransactionUpdate,
    TransactionSplitOut,
    TransactionSplitsReplace,
    SpendingSummary,
    CategorySpending,
)
from app.services.categories import map_plaid_category, STANDARD_CATEGORIES, CATEGORY_ICONS
from app.services.transaction_view import expand as expand_splits
from app.services.merchant_normalizer import normalize

router = APIRouter(prefix="/api/transactions", tags=["transactions"])


@router.post("/manual", response_model=TransactionOut)
def create_manual_transaction(body: dict, db: Session = Depends(get_db)):
    """Create a manual transaction (e.g., cash purchase, tip).

    Required body: amount (float, Plaid convention: positive=outflow), name (str),
    account_id (int), date (str YYYY-MM-DD).
    Optional: merchant_name, category, custom_category, notes.

    Generates a unique plaid_transaction_id with manual: prefix so manual
    entries can be distinguished from synced Plaid transactions.
    """
    required = ["amount", "name", "account_id", "date"]
    for field in required:
        if field not in body:
            raise HTTPException(400, f"Missing required field: {field}")
    account = db.query(Account).filter(Account.id == int(body["account_id"])).first()
    if not account:
        raise HTTPException(404, "Account not found")

    # Manual transactions get a synthetic ID so they're idempotent if
    # the user accidentally double-submits. Prefix lets us identify
    # manual entries vs Plaid-synced ones.
    manual_id = f"manual:{secrets.token_hex(8)}"
    txn = Transaction(
        plaid_transaction_id=manual_id,
        account_id=int(body["account_id"]),
        name=str(body["name"]),
        merchant_name=body.get("merchant_name"),
        amount=float(body["amount"]),
        date=date.fromisoformat(body["date"]),
        category=body.get("category"),
        custom_category=body.get("custom_category"),
        notes=body.get("notes"),
        pending=False,
    )
    db.add(txn)
    db.commit()
    db.refresh(txn)
    return txn


@router.get("/search")
def global_search(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Cross-cutting search. Returns matches across:
      - Transactions (name + merchant + notes)
      - Accounts (custom_name + name + institution)
    Single endpoint so the frontend command palette can fan out from
    one query without making N requests."""
    pattern = f"%{q.lower()}%"
    results = {"transactions": [], "accounts": []}

    txns = (
        db.query(Transaction)
        .filter(or_(
            func.lower(Transaction.name).like(pattern),
            func.lower(func.coalesce(Transaction.merchant_name, "")).like(pattern),
            func.lower(func.coalesce(Transaction.notes, "")).like(pattern),
        ))
        .order_by(Transaction.date.desc())
        .limit(limit)
        .all()
    )
    for t in txns:
        results["transactions"].append({
            "id": t.id,
            "name": t.display_name,
            "amount": t.amount,
            "date": t.date.isoformat() if t.date else None,
            "category": t.display_category,
            "account_id": t.account_id,
        })

    accts = (
        db.query(Account)
        .filter(or_(
            func.lower(func.coalesce(Account.custom_name, "")).like(pattern),
            func.lower(Account.name).like(pattern),
            func.lower(func.coalesce(Account.institution_name, "")).like(pattern),
        ))
        .limit(10)
        .all()
    )
    for a in accts:
        results["accounts"].append({
            "id": a.id,
            "name": a.custom_name or a.name,
            "institution": a.institution_name,
            "type": a.type,
            "balance": a.current_balance,
        })

    return results


@router.get("/", response_model=List[TransactionOut])
def list_transactions(
    account_id: Optional[int] = None,
    category: Optional[str] = None,
    business_id: Optional[int] = None,
    is_business: Optional[bool] = Query(
        None,
        description=(
            "Filter on whether the transaction is tagged to ANY business. "
            "true = business_id IS NOT NULL (used by the Budgets page "
            "Business rollup drill-down). false = personal only "
            "(business_id IS NULL). None (default) = both."
        ),
    ),
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    q: Optional[str] = None,
    limit: int = Query(default=100, le=500),
    offset: int = 0,
    db: Session = Depends(get_db),
):
    query = db.query(Transaction)
    if account_id:
        query = query.filter(Transaction.account_id == account_id)
    if business_id:
        query = query.filter(Transaction.business_id == business_id)
    elif is_business is True:
        query = query.filter(Transaction.business_id.isnot(None))
    elif is_business is False:
        query = query.filter(Transaction.business_id.is_(None))
    if category:
        query = query.filter(
            (Transaction.custom_category == category) | (Transaction.category == category)
        )
    if start_date:
        query = query.filter(Transaction.date >= start_date)
    if end_date:
        query = query.filter(Transaction.date <= end_date)
    if q and q.strip():
        # Case-insensitive search on name, merchant_name, or display_name.
        # For SQL filtering, use name and merchant_name (display_name is a Python property).
        search_term = f"%{q.strip()}%"
        query = query.filter(
            (func.lower(Transaction.name).like(func.lower(search_term))) |
            (func.lower(Transaction.merchant_name).like(func.lower(search_term)))
        )

    return query.order_by(Transaction.date.desc()).offset(offset).limit(limit).all()


@router.patch("/{transaction_id}", response_model=TransactionOut)
def update_transaction(transaction_id: int, body: TransactionUpdate, db: Session = Depends(get_db)):
    txn = db.query(Transaction).filter_by(id=transaction_id).first()
    if not txn:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Transaction not found")
    if body.custom_category is not None:
        txn.custom_category = body.custom_category
    if body.business_id is not None:
        # Allow setting to 0 or null to clear, or a valid business id
        txn.business_id = body.business_id if body.business_id else None
    if body.is_transfer is not None:
        # User-asserted transfer flag. Overrides whatever the auto-detector
        # decided — used by bulk recategorize and the per-row "is transfer"
        # toggle. Detector won't reset this on its next run unless the user
        # explicitly re-runs it with reset=True.
        txn.is_transfer = bool(body.is_transfer)
    if body.notes is not None:
        # Empty string clears the note; non-empty stores it. Whitespace-only
        # is treated as a clear so the UI doesn't accidentally persist
        # invisible content.
        stripped = body.notes.strip()
        txn.notes = stripped or None
    db.commit()
    db.refresh(txn)
    return txn


# ─── Splits ─────────────────────────────────────────────────
@router.get("/{transaction_id}/splits", response_model=List[TransactionSplitOut])
def list_splits(transaction_id: int, db: Session = Depends(get_db)):
    from fastapi import HTTPException
    txn = db.query(Transaction).filter_by(id=transaction_id).first()
    if not txn:
        raise HTTPException(404, "Transaction not found")
    return txn.splits


@router.put("/{transaction_id}/splits", response_model=List[TransactionSplitOut])
def replace_splits(
    transaction_id: int,
    body: TransactionSplitsReplace,
    db: Session = Depends(get_db),
):
    """Replace all splits for a transaction.

    Rules:
      - An empty splits list clears any existing splits (back to a normal txn).
      - Otherwise there must be at least 2 splits.
      - Each split amount must have the same sign as the parent amount
        (can't split a $50 expense into income). Signs follow Plaid's
        convention: positive = money out, negative = money in.
      - The sum of split amounts must equal the parent amount within 1 cent
        of floating-point tolerance.
    """
    from fastapi import HTTPException

    txn = db.query(Transaction).filter_by(id=transaction_id).first()
    if not txn:
        raise HTTPException(404, "Transaction not found")

    # Wipe existing splits first — cascade delete via relationship.
    db.query(TransactionSplit).filter_by(transaction_id=transaction_id).delete()

    if not body.splits:
        db.commit()
        return []

    if len(body.splits) < 2:
        raise HTTPException(400, "A split transaction needs at least 2 parts (or pass an empty list to clear).")

    parent_sign = 1 if txn.amount >= 0 else -1
    for s in body.splits:
        s_sign = 1 if s.amount >= 0 else -1
        if s_sign != parent_sign and s.amount != 0:
            raise HTTPException(400, "Each split must have the same sign as the parent transaction.")

    total = sum(s.amount for s in body.splits)
    if abs(total - txn.amount) > 0.01:
        raise HTTPException(
            400,
            f"Split amounts must sum to {txn.amount:.2f}; got {total:.2f}.",
        )

    created = []
    for s in body.splits:
        row = TransactionSplit(
            transaction_id=transaction_id,
            amount=s.amount,
            category=s.category,
            note=s.note,
            business_id=s.business_id or None,
        )
        db.add(row)
        created.append(row)

    db.commit()
    for row in created:
        db.refresh(row)
    return created


@router.delete("/{transaction_id}/splits")
def clear_splits(transaction_id: int, db: Session = Depends(get_db)):
    """Remove all splits from a transaction, reverting it to a normal single-category transaction."""
    from fastapi import HTTPException
    txn = db.query(Transaction).filter_by(id=transaction_id).first()
    if not txn:
        raise HTTPException(404, "Transaction not found")
    db.query(TransactionSplit).filter_by(transaction_id=transaction_id).delete()
    db.commit()
    return {"status": "cleared"}


@router.get("/spending-summary", response_model=SpendingSummary)
def spending_summary(
    month: int = Query(...),
    year: int = Query(...),
    business_filter: str = Query(
        "all",
        regex="^(all|personal|business)$",
        description=(
            "How business-tagged spending interacts with the categories list. "
            "'all' (default, back-compat) = include everything in categories. "
            "'personal' = exclude business-tagged lines from categories so "
            "personal totals aren't inflated by business expenses. "
            "'business' = only include business-tagged lines. "
            "business_total and business_budget_limit are populated regardless."
        ),
    ),
    db: Session = Depends(get_db),
):
    """Get spending by category for a given month, compared against budget
    limits.

    The business_filter param lets the Budgets UI render personal categories
    without business pollution while still surfacing business spend as its
    own rollup tile (using business_total). The synthetic "Business" budget
    category — a regular BudgetCategory with category="Business" — is used
    to track business spend against a target without showing up in the
    normal categories list.
    """
    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month + 1, 1)

    # Expand splits so each split's amount lands in its own category rather
    # than the parent transaction's single category. Transfers (CC
    # autopay, internal account transfers, loan payments) are excluded —
    # they aren't real spending.
    month_txns = (
        db.query(Transaction)
        .filter(
            Transaction.date >= start,
            Transaction.date < end,
            Transaction.is_transfer.is_(False),
        )
        .all()
    )
    totals: dict[str, float] = {}
    business_total = 0.0
    for line in expand_splits(month_txns):
        if line.amount <= 0:
            continue
        is_business = line.business_id is not None
        if is_business:
            business_total += line.amount
        # Apply the filter to the categories list. Note we still tally
        # business_total above unconditionally — the rollup tile needs
        # that number even when the user is viewing personal-only.
        if business_filter == "personal" and is_business:
            continue
        if business_filter == "business" and not is_business:
            continue
        totals[line.category] = totals.get(line.category, 0.0) + line.amount
    rows = list(totals.items())

    # Load budget for this month
    budget = db.query(Budget).filter_by(month=month, year=year).first()
    budget_map: dict[str, float] = {}
    business_budget_limit: Optional[float] = None
    if budget:
        for bc in budget.categories:
            if bc.category == "Business":
                # Pull the synthetic Business category limit out so the
                # frontend can render it on its own rollup row instead
                # of mixing it into the personal categories list.
                business_budget_limit = bc.limit_amount
            else:
                budget_map[bc.category] = bc.limit_amount

    categories = []
    total_spent = 0.0
    for cat, total in rows:
        total = round(total, 2)
        total_spent += total
        limit = budget_map.get(cat)
        categories.append(CategorySpending(
            category=cat,
            total=total,
            budget_limit=limit,
            percentage_used=round((total / limit) * 100, 1) if limit else None,
        ))

    categories.sort(key=lambda c: c.total, reverse=True)

    return SpendingSummary(
        month=month,
        year=year,
        total_spent=round(total_spent, 2),
        categories=categories,
        business_total=round(business_total, 2),
        business_budget_limit=business_budget_limit,
    )


@router.post("/migrate-categories")
def migrate_categories(db: Session = Depends(get_db)):
    """One-time migration: map all raw Plaid categories to friendly names."""
    txns = db.query(Transaction).filter(Transaction.custom_category.is_(None)).all()
    count = 0
    for t in txns:
        if t.category:
            friendly = map_plaid_category(t.category)
            if friendly != t.category:
                t.category = friendly
                count += 1
    db.commit()
    return {"migrated": count, "total_checked": len(txns)}


@router.get("/categories")
def list_categories():
    """Return the list of standard categories and their icons."""
    return [{"name": c, "icon": CATEGORY_ICONS.get(c, "📦")} for c in STANDARD_CATEGORIES]


@router.get("/income-vs-spending")
def income_vs_spending(
    months: int = Query(default=6, le=24),
    db: Session = Depends(get_db),
):
    """Get monthly income vs spending for the last N months."""
    today = date.today()
    results = []

    for i in range(months - 1, -1, -1):
        # Calculate month/year going backwards
        m = today.month - i
        y = today.year
        while m <= 0:
            m += 12
            y -= 1

        start = date(y, m, 1)
        if m == 12:
            end = date(y + 1, 1, 1)
        else:
            end = date(y, m + 1, 1)

        month_txns = db.query(Transaction).filter(
            Transaction.date >= start,
            Transaction.date < end,
            Transaction.is_transfer.is_(False),
        ).all()

        income = 0.0
        spending = 0.0
        for t in month_txns:
            if t.amount < 0:
                income += abs(t.amount)
            else:
                spending += t.amount

        results.append({
            "month": start.strftime("%b %Y"),
            "month_num": m,
            "year": y,
            "income": round(income, 2),
            "spending": round(spending, 2),
            "net": round(income - spending, 2),
        })

    return results


@router.get("/category-breakdown")
def category_breakdown(
    month: int = Query(...),
    year: int = Query(...),
    db: Session = Depends(get_db),
):
    """Detailed category breakdown with friendly names, for a given month."""
    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month + 1, 1)

    txns = db.query(Transaction).filter(
        Transaction.date >= start,
        Transaction.date < end,
        Transaction.is_transfer.is_(False),
    ).all()

    spending_by_cat = {}
    income_by_cat = {}
    transaction_counts = {}

    # Iterate over expanded lines so splits attribute to their own category.
    for line in expand_splits(txns):
        friendly = map_plaid_category(line.category)
        if line.amount > 0:
            spending_by_cat[friendly] = spending_by_cat.get(friendly, 0) + line.amount
            transaction_counts[friendly] = transaction_counts.get(friendly, 0) + 1
        else:
            income_by_cat[friendly] = income_by_cat.get(friendly, 0) + abs(line.amount)

    spending_categories = []
    total_spending = sum(spending_by_cat.values())
    for cat, total in sorted(spending_by_cat.items(), key=lambda x: x[1], reverse=True):
        spending_categories.append({
            "category": cat,
            "icon": CATEGORY_ICONS.get(cat, "📦"),
            "amount": round(total, 2),
            "percentage": round((total / total_spending) * 100, 1) if total_spending > 0 else 0,
            "transaction_count": transaction_counts.get(cat, 0),
        })

    income_categories = []
    total_income = sum(income_by_cat.values())
    for cat, total in sorted(income_by_cat.items(), key=lambda x: x[1], reverse=True):
        income_categories.append({
            "category": cat,
            "icon": CATEGORY_ICONS.get(cat, "💰"),
            "amount": round(total, 2),
            "percentage": round((total / total_income) * 100, 1) if total_income > 0 else 0,
        })

    return {
        "month": month,
        "year": year,
        "total_spending": round(total_spending, 2),
        "total_income": round(total_income, 2),
        "net": round(total_income - total_spending, 2),
        "spending_categories": spending_categories,
        "income_categories": income_categories,
    }


@router.get("/by-merchant/{merchant_name}")
def get_merchant_details(merchant_name: str, db: Session = Depends(get_db)):
    """Get detailed drill-down for a merchant: YTD total, all-time total, transaction count,
    monthly trend (last 12 months), and recent transactions.

    Matches both merchant_name (case-insensitive) and normalized output of merchant_normalizer
    so transactions that never had merchant_name populated are still caught.
    """
    from datetime import datetime
    from urllib.parse import unquote

    # Decode the URL-encoded merchant name
    merchant_name = unquote(merchant_name)

    # Calculate year-to-date start
    today = date.today()
    ytd_start = date(today.year, 1, 1)

    # Query all transactions matching this merchant (case-insensitive) or its normalized form
    all_txns = db.query(Transaction).all()
    matching_txns = []
    for txn in all_txns:
        txn_merchant = txn.merchant_name or txn.name
        # Try exact match (case-insensitive) first
        if txn_merchant and txn_merchant.lower() == merchant_name.lower():
            matching_txns.append(txn)
        # Also try matching against normalized form
        elif normalize(txn_merchant) and normalize(txn_merchant).lower() == merchant_name.lower():
            matching_txns.append(txn)

    # Calculate YTD (non-transfers only for totals)
    ytd_total = 0.0
    ytd_count = 0
    for txn in matching_txns:
        if txn.date >= ytd_start and not txn.is_transfer and txn.amount > 0:
            ytd_total += txn.amount
            ytd_count += 1

    # Calculate all-time (non-transfers only for totals)
    all_time_total = 0.0
    all_time_count = 0
    for txn in matching_txns:
        if not txn.is_transfer and txn.amount > 0:
            all_time_total += txn.amount
            all_time_count += 1

    # Monthly trend: last 12 months (non-transfers only)
    monthly_trend = []
    for i in range(11, -1, -1):
        m = today.month - i
        y = today.year
        while m <= 0:
            m += 12
            y -= 1

        month_start = date(y, m, 1)
        if m == 12:
            month_end = date(y + 1, 1, 1)
        else:
            month_end = date(y, m + 1, 1)

        month_total = 0.0
        month_count = 0
        for txn in matching_txns:
            if (txn.date >= month_start and txn.date < month_end and
                not txn.is_transfer and txn.amount > 0):
                month_total += txn.amount
                month_count += 1

        monthly_trend.append({
            "month": f"{y:04d}-{m:02d}",
            "total": round(month_total, 2),
            "count": month_count,
        })

    # Recent transactions (all types, including transfers, for visibility)
    # Sort by date descending, limit to 50
    recent = sorted(matching_txns, key=lambda t: t.date, reverse=True)[:50]
    transactions_out = [
        {
            "id": t.id,
            "date": t.date.isoformat(),
            "amount": t.amount,
            "name": t.display_name or t.merchant_name or t.name,
            "account_id": t.account_id,
            "is_transfer": t.is_transfer,
        }
        for t in recent
    ]

    return {
        "merchant": merchant_name,
        "total_ytd": round(ytd_total, 2),
        "total_all_time": round(all_time_total, 2),
        "transaction_count": all_time_count,
        "monthly_trend": monthly_trend,
        "transactions": transactions_out,
    }
