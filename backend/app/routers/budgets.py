"""Budget routes."""
import datetime
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Budget, BudgetCategory
from app.schemas.schemas import BudgetIn, BudgetOut
from app.services.budget_carry import carry_forward_budget

router = APIRouter(prefix="/api/budgets", tags=["budgets"])


def _to_out(budget: Budget, db: Session) -> BudgetOut:
    """Serialize a budget, resolving the carry-forward marker (an id) into
    the month/year the UI actually wants to display."""
    out = BudgetOut.model_validate(budget)
    if budget.inherited_from_budget_id is not None:
        source = db.get(Budget, budget.inherited_from_budget_id)
        if source is not None:
            out.inherited_from_month = source.month
            out.inherited_from_year = source.year
    return out


@router.get("/", response_model=List[BudgetOut])
def list_budgets(db: Session = Depends(get_db)):
    rows = db.query(Budget).order_by(Budget.year.desc(), Budget.month.desc()).all()
    return [_to_out(b, db) for b in rows]


@router.get("/{month}/{year}", response_model=BudgetOut)
def get_budget(month: int, year: int, db: Session = Depends(get_db)):
    budget = db.query(Budget).filter_by(month=month, year=year).first()
    if not budget:
        # Only the CURRENT month is auto-created: the first page load of a
        # new month should never be blank when last month had a plan.
        # Past and future months keep the explicit 404 — see
        # services/budget_carry.py for why.
        today = datetime.date.today()
        if (month, year) == (today.month, today.year):
            budget = carry_forward_budget(db, month, year)
    if not budget:
        raise HTTPException(status_code=404, detail="Budget not found")
    return _to_out(budget, db)


@router.post("/", response_model=BudgetOut)
def create_or_update_budget(body: BudgetIn, db: Session = Depends(get_db)):
    try:
        budget = db.query(Budget).filter_by(month=body.month, year=body.year).first()
        if not budget:
            budget = Budget(month=body.month, year=body.year)
            db.add(budget)
            db.flush()  # populate budget.id before deleting/inserting categories

        budget.total_limit = body.total_limit
        # The user has now saved this month themselves — it's no longer an
        # automatic copy of a prior month, whatever the numbers are.
        budget.inherited_from_budget_id = None

        # Delete existing categories and insert new ones in the same transaction.
        # Both operations commit together — no window where the budget exists
        # without any categories.
        db.query(BudgetCategory).filter_by(budget_id=budget.id).delete()

        for cat in body.categories:
            budget.categories.append(
                BudgetCategory(category=cat.category, limit_amount=cat.limit_amount)
            )

        db.commit()
        db.refresh(budget)
        return _to_out(budget, db)
    except Exception:
        db.rollback()
        raise
