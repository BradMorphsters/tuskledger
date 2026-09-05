"""Carry a budget forward into a month that has none.

Best-in-class budgeting tools (YNAB, Monarch) never start a month blank:
last month's plan is this month's plan until you change it. Before this
module the app required a manual "Copy from <prior month>" click plus a
save every month, and until that happened every consumer of the current
month's budget — the Budgets page, spending-summary, Ask Tusk, the phone's
Budgets card, budget alerts — saw *no budget at all* for days.

Three call sites, all idempotent:

  1. App startup (main.py lifespan) — covers a laptop that was closed
     over the month boundary.
  2. A daily scheduler job just after midnight — covers a machine that
     stays up.
  3. Lazily from GET /budgets/{month}/{year} when the requested month is
     the current one — covers the first page load of a new month before
     either of the above has run.

The clone is a *persisted* row (not a computed fallback) on purpose:
many code paths query `Budget` directly by month/year, and a phantom
budget that only the Budgets page knew about would leave the rest of
the app disagreeing with it. The row carries `inherited_from_budget_id`
so the UI can label it, and the router clears that marker the first
time the user saves the month.

Only the CURRENT month is ever auto-created. Past months stay empty
(retro-creating budgets would rewrite history the user never planned),
and future months are left to the user.
"""
from __future__ import annotations

import datetime
import logging
from typing import Optional

from sqlalchemy import or_, and_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Budget, BudgetCategory

log = logging.getLogger(__name__)


def latest_budget_before(db: Session, month: int, year: int) -> Optional[Budget]:
    """The most recent budget strictly earlier than (month, year), or None."""
    return (
        db.query(Budget)
        .filter(
            or_(
                Budget.year < year,
                and_(Budget.year == year, Budget.month < month),
            )
        )
        .order_by(Budget.year.desc(), Budget.month.desc())
        .first()
    )


def carry_forward_budget(db: Session, month: int, year: int) -> Optional[Budget]:
    """Return the budget for (month, year), creating it from the latest
    prior month if it doesn't exist.

    Returns None only when there is nothing to clone (a brand-new install
    with no budget history). Never raises on the create/create race —
    the unique (month, year) index makes the loser's INSERT fail, and it
    simply re-reads the row the winner committed.
    """
    existing = db.query(Budget).filter_by(month=month, year=year).first()
    if existing:
        return existing

    source = latest_budget_before(db, month, year)
    if source is None:
        return None

    clone = Budget(
        month=month,
        year=year,
        total_limit=source.total_limit,
        inherited_from_budget_id=source.id,
    )
    for line in source.categories:
        clone.categories.append(
            BudgetCategory(category=line.category, limit_amount=line.limit_amount)
        )
    db.add(clone)
    try:
        db.commit()
    except IntegrityError:
        # Lost the race to another caller — theirs is the budget now.
        db.rollback()
        return db.query(Budget).filter_by(month=month, year=year).first()

    db.refresh(clone)
    log.info(
        "budget carry-forward: %04d-%02d created from %04d-%02d (%d lines)",
        year, month, source.year, source.month, len(clone.categories),
    )
    return clone


def ensure_current_month_budget(db: Session, today: Optional[datetime.date] = None) -> Optional[Budget]:
    """Startup / scheduler entry point: make sure *this* month has a budget."""
    today = today or datetime.date.today()
    return carry_forward_budget(db, today.month, today.year)
