"""Upcoming-bills aggregator.

Pulls next-payment data from any source we have it:
  - MortgageDetail.next_payment_due_date / next_monthly_payment
  - CreditCardDetail.next_payment_due_date / last_statement_balance / minimum_payment_amount

Returns a flat list sorted by due date so the Dashboard can render a
chronological "what's coming up" view without needing to know about
which sub-table each bill came from.

Manual liabilities (Apple Card, Nelnet, Hyundai) currently store payment
detail in a free-text `notes` field. Parsing arbitrary notes is fragile,
so we leave those out of this endpoint and add structured payment fields
later if the need warrants it.
"""
from __future__ import annotations

import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models import Account, MortgageDetail, CreditCardDetail

router = APIRouter(prefix="/api/bills", tags=["bills"])


class UpcomingBill(BaseModel):
    account_id: int
    account_name: str            # custom_name or Plaid name
    institution: Optional[str] = None
    kind: str                    # "mortgage" | "credit_card"
    due_date: datetime.date
    days_until: int              # negative = overdue, 0 = today
    amount: Optional[float] = None       # next payment owed (mortgage) or statement balance (CC)
    minimum: Optional[float] = None      # CC minimum payment (mortgage = same as amount)
    note: Optional[str] = None           # short label like "minimum $32" or "next payment"


@router.get("/upcoming", response_model=List[UpcomingBill])
def upcoming_bills(
    days_ahead: int = 60,
    include_overdue: bool = True,
    db: Session = Depends(get_db),
):
    """Bills due in the next `days_ahead` days, plus optionally any
    already-overdue ones (their `days_until` will be negative)."""
    today = datetime.date.today()
    cutoff = today + datetime.timedelta(days=days_ahead)
    bills: list[UpcomingBill] = []

    # Mortgages
    mortgages = (
        db.query(MortgageDetail)
        .options(joinedload(MortgageDetail.account))
        .filter(MortgageDetail.next_payment_due_date.isnot(None))
        .all()
    )
    for m in mortgages:
        d = m.next_payment_due_date
        if d > cutoff:
            continue
        if not include_overdue and d < today:
            continue
        acct = m.account
        bills.append(UpcomingBill(
            account_id=m.account_id,
            account_name=(acct.custom_name or acct.name) if acct else "(unknown)",
            institution=acct.institution_name if acct else None,
            kind="mortgage",
            due_date=d,
            days_until=(d - today).days,
            amount=m.next_monthly_payment,
            minimum=m.next_monthly_payment,
            note="next payment",
        ))

    # Credit cards
    cards = (
        db.query(CreditCardDetail)
        .options(joinedload(CreditCardDetail.account))
        .filter(CreditCardDetail.next_payment_due_date.isnot(None))
        .all()
    )
    for c in cards:
        d = c.next_payment_due_date
        if d > cutoff:
            continue
        if not include_overdue and d < today:
            continue
        acct = c.account
        bills.append(UpcomingBill(
            account_id=c.account_id,
            account_name=(acct.custom_name or acct.name) if acct else "(unknown)",
            institution=acct.institution_name if acct else None,
            kind="credit_card",
            due_date=d,
            days_until=(d - today).days,
            amount=c.last_statement_balance,
            minimum=c.minimum_payment_amount,
            note="statement balance",
        ))

    bills.sort(key=lambda b: b.due_date)
    return bills
