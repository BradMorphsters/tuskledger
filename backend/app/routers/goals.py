"""Savings goals API.

Each goal has:
  - target_amount + optional target_date
  - source_account_ids (auto progress) and/or manual_current_amount (override)
  - goal_type for icon/UX classification

The GET endpoints decorate each goal with computed fields:
  - current_amount   — manual override if set, else summed source-account balance
  - pace_per_month   — 3-month moving average of growth across source accounts
  - projected_date   — at the current pace, when current_amount hits target_amount
  - progress_pct     — current / target

Pace pulls from NetWorthSnapshot.account_balances when available. That JSON
column has per-account-id keys for snapshots taken after the change went
in; older snapshots may lack account-level detail and we just bail on pace.
"""
from __future__ import annotations

import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Account, NetWorthSnapshot, SavingsGoal


router = APIRouter(prefix="/api/goals", tags=["goals"])


# ─── Schemas ─────────────────────────────────────────────
class GoalIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    target_amount: float
    target_date: Optional[datetime.date] = None
    goal_type: str = "custom"
    notes: Optional[str] = None
    source_account_ids: List[int] = Field(default_factory=list)
    manual_current_amount: Optional[float] = None


class GoalUpdate(BaseModel):
    name: Optional[str] = None
    target_amount: Optional[float] = None
    target_date: Optional[datetime.date] = None
    goal_type: Optional[str] = None
    notes: Optional[str] = None
    source_account_ids: Optional[List[int]] = None
    manual_current_amount: Optional[float] = None
    is_active: Optional[int] = None


class GoalOut(BaseModel):
    id: int
    name: str
    target_amount: float
    target_date: Optional[datetime.date]
    goal_type: str
    notes: Optional[str]
    source_account_ids: List[int]
    manual_current_amount: Optional[float]
    is_active: int
    # Derived
    current_amount: float
    progress_pct: float
    pace_per_month: Optional[float] = None
    projected_date: Optional[datetime.date] = None
    on_track: Optional[bool] = None  # only when target_date is set

    model_config = ConfigDict(from_attributes=True)


# ─── Helpers ─────────────────────────────────────────────
def _recent_snapshots(db: Session) -> list:
    """Fetch the last ~90 days of net-worth snapshots once. Callers in a
    hot loop (list_goals decorating N goals) should call this ONCE and pass
    the result into _compute_pace — otherwise we'd re-scan the snapshot
    table per goal, which gets ugly fast as the user accumulates history."""
    cutoff = datetime.date.today() - datetime.timedelta(days=95)
    return (
        db.query(NetWorthSnapshot)
        .filter(NetWorthSnapshot.date >= cutoff)
        .order_by(NetWorthSnapshot.date)
        .all()
    )


def _compute_pace(
    db: Session,
    account_ids: List[int],
    snapshots: Optional[list] = None,
) -> Optional[float]:
    """Approximate monthly growth (in $) across the given accounts using
    the last ~90 days of net-worth snapshots. Returns None when there's
    not enough data to compute a meaningful pace.

    If `snapshots` is passed, we skip the DB query — used by list_goals to
    avoid an N-snapshot-queries-per-N-goals fanout.
    """
    if not account_ids:
        return None

    snaps = snapshots if snapshots is not None else _recent_snapshots(db)
    if len(snaps) < 2:
        return None

    # snap.account_balances is a dict keyed by account label/id.
    # Two storage shapes have appeared over time — either mapping by id
    # (newer) or by display name (older). We try id first.
    str_keys = [str(i) for i in account_ids]
    int_keys = list(account_ids)

    def total_at(snap):
        bals = snap.account_balances or {}
        # Try multiple key shapes — JSON keys can be stored as strings.
        total = 0.0
        for k in str_keys + int_keys:
            v = bals.get(k)
            if v is not None:
                total += v
        return total

    first = total_at(snaps[0])
    last = total_at(snaps[-1])
    days = (snaps[-1].date - snaps[0].date).days
    if days <= 0:
        return None
    if first == 0 and last == 0:
        return None
    return (last - first) / days * 30.0


def _decorate(
    db: Session,
    goal: SavingsGoal,
    account_balances: dict,
    snapshots: Optional[list] = None,
) -> GoalOut:
    """Attach computed fields. `account_balances` is a pre-fetched id->balance
    map and `snapshots` is a pre-fetched snapshot list — both passed in by
    list_goals to avoid per-goal re-querying."""
    if goal.manual_current_amount is not None:
        current = float(goal.manual_current_amount)
    else:
        ids = goal.source_account_ids or []
        current = sum(account_balances.get(int(i), 0.0) for i in ids)

    pct = (current / goal.target_amount * 100) if goal.target_amount > 0 else 0.0
    pct = round(min(max(pct, 0.0), 999.0), 1)

    pace = _compute_pace(db, goal.source_account_ids or [], snapshots=snapshots)

    projected = None
    on_track = None
    if pace and pace > 0:
        remaining = goal.target_amount - current
        if remaining <= 0:
            projected = datetime.date.today()
        else:
            months_needed = remaining / pace
            projected = datetime.date.today() + datetime.timedelta(days=int(months_needed * 30))
        if goal.target_date:
            on_track = projected <= goal.target_date

    return GoalOut(
        id=goal.id,
        name=goal.name,
        target_amount=goal.target_amount,
        target_date=goal.target_date,
        goal_type=goal.goal_type,
        notes=goal.notes,
        source_account_ids=list(goal.source_account_ids or []),
        manual_current_amount=goal.manual_current_amount,
        is_active=goal.is_active,
        current_amount=round(current, 2),
        progress_pct=pct,
        pace_per_month=round(pace, 2) if pace is not None else None,
        projected_date=projected,
        on_track=on_track,
    )


def _account_balance_map(db: Session) -> dict:
    return {a.id: float(a.current_balance or 0) for a in db.query(Account).all()}


# ─── Routes ──────────────────────────────────────────────
@router.get("/", response_model=List[GoalOut])
def list_goals(db: Session = Depends(get_db)):
    goals = (
        db.query(SavingsGoal)
        .filter(SavingsGoal.is_active == 1)
        .order_by(SavingsGoal.id)
        .all()
    )
    balances = _account_balance_map(db)
    # Pre-fetch snapshots once and pass them through so _compute_pace
    # doesn't re-scan NetWorthSnapshot for every goal.
    snapshots = _recent_snapshots(db)
    return [_decorate(db, g, balances, snapshots=snapshots) for g in goals]


@router.post("/", response_model=GoalOut)
def create_goal(body: GoalIn, db: Session = Depends(get_db)):
    goal = SavingsGoal(
        name=body.name.strip(),
        target_amount=body.target_amount,
        target_date=body.target_date,
        goal_type=body.goal_type or "custom",
        notes=body.notes,
        source_account_ids=body.source_account_ids,
        manual_current_amount=body.manual_current_amount,
        is_active=1,
    )
    db.add(goal)
    db.commit()
    db.refresh(goal)
    return _decorate(db, goal, _account_balance_map(db))


@router.patch("/{goal_id}", response_model=GoalOut)
def update_goal(goal_id: int, body: GoalUpdate, db: Session = Depends(get_db)):
    goal = db.query(SavingsGoal).filter(SavingsGoal.id == goal_id).first()
    if not goal:
        raise HTTPException(404, "Goal not found")
    data = body.model_dump(exclude_unset=True)
    if "name" in data:
        goal.name = data["name"]
    if "target_amount" in data:
        goal.target_amount = data["target_amount"]
    if "target_date" in data:
        goal.target_date = data["target_date"]
    if "goal_type" in data:
        goal.goal_type = data["goal_type"]
    if "notes" in data:
        goal.notes = data["notes"]
    if "source_account_ids" in data:
        goal.source_account_ids = data["source_account_ids"]
    if "manual_current_amount" in data:
        goal.manual_current_amount = data["manual_current_amount"]
    if "is_active" in data:
        goal.is_active = data["is_active"]
    db.commit()
    db.refresh(goal)
    return _decorate(db, goal, _account_balance_map(db))


@router.delete("/{goal_id}")
def delete_goal(goal_id: int, db: Session = Depends(get_db)):
    goal = db.query(SavingsGoal).filter(SavingsGoal.id == goal_id).first()
    if not goal:
        raise HTTPException(404, "Goal not found")
    db.delete(goal)
    db.commit()
    return {"status": "deleted"}
