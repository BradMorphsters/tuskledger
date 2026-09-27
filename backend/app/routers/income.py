"""Income / paychecks: household pay schedules, extra-paycheck months, and
the user's corrections to them. See app/services/pay_schedule.py."""
from __future__ import annotations

from datetime import date
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.services.pay_schedule import (
    OverrideError,
    build_income_profile,
    clear_override,
    set_override,
)

router = APIRouter(prefix="/api/income", tags=["income"])


@router.get("/schedule")
def income_schedule(db: Session = Depends(get_db)):
    """Earners, their pay calendars, upcoming paydays, and a 25-month
    paycheck grid (12 back, this month, 12 ahead) with extra-paycheck
    months flagged."""
    return build_income_profile(db, today=date.today())


@router.put("/earners/{key}")
def update_earner(key: str, payload: Dict[str, Any] = Body(...), db: Session = Depends(get_db)):
    """Correct what the detector inferred for one earner.

    Accepted fields (all optional; null clears): nickname, hidden,
    frequency (weekly | bi-weekly | semi-monthly | monthly), days_of_month
    (semi-monthly: two days, monthly: one; 31 = last day), anchor (any known
    payday, for weekly/bi-weekly), per_check (take-home per paycheck).
    """
    try:
        set_override(db, key, payload)
    except OverrideError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return build_income_profile(db, today=date.today())


@router.delete("/earners/{key}")
def reset_earner(key: str, db: Session = Depends(get_db)):
    """Drop every correction for one earner and go back to auto-detection."""
    clear_override(db, key)
    return build_income_profile(db, today=date.today())
