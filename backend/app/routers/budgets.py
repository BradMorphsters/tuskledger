"""Budget routes."""
from typing import List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Budget, BudgetCategory
from app.schemas.schemas import BudgetIn, BudgetOut

router = APIRouter(prefix="/api/budgets", tags=["budgets"])


@router.get("/", response_model=List[BudgetOut])
def list_budgets(db: Session = Depends(get_db)):
    return db.query(Budget).order_by(Budget.year.desc(), Budget.month.desc()).all()


@router.get("/{month}/{year}", response_model=BudgetOut)
def get_budget(month: int, year: int, db: Session = Depends(get_db)):
    budget = db.query(Budget).filter_by(month=month, year=year).first()
    if not budget:
        raise HTTPException(status_code=404, detail="Budget not found")
    return budget


@router.post("/", response_model=BudgetOut)
def create_or_update_budget(body: BudgetIn, db: Session = Depends(get_db)):
    try:
        budget = db.query(Budget).filter_by(month=body.month, year=body.year).first()
        if not budget:
            budget = Budget(month=body.month, year=body.year)
            db.add(budget)
            db.flush()  # populate budget.id before deleting/inserting categories

        budget.total_limit = body.total_limit

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
        return budget
    except Exception:
        db.rollback()
        raise
