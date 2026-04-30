"""Subscription Rule CRUD.

User-defined overrides for the recurrence detector. See
models/subscription_rule.py for the rationale + the two `kind` values.

Patterns are matched case-insensitively as substrings against the
normalized merchant key the recurrence detector uses (which already
combines merchant_name + name when computing the cluster).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import SubscriptionRule
from app.models.subscription_rule import KIND_FORCE_SUB, KIND_FORCE_NOT_SUB

router = APIRouter(prefix="/api/subscription-rules", tags=["subscription-rules"])


_VALID_KINDS = {KIND_FORCE_SUB, KIND_FORCE_NOT_SUB}


class SubscriptionRuleIn(BaseModel):
    """Request body for create. `kind` must be one of the two
    documented constants — anything else returns 400."""
    pattern: str = Field(..., min_length=1, max_length=200)
    kind: str = Field(..., description="'force_subscription' or 'force_not_subscription'")
    priority: Optional[int] = Field(default=100, ge=0, le=10000)
    notes: Optional[str] = Field(default=None, max_length=500)


class SubscriptionRuleOut(BaseModel):
    id: int
    pattern: str
    kind: str
    priority: int
    notes: Optional[str] = None


@router.get("/")
def list_rules(db: Session = Depends(get_db)):
    """All subscription rules, oldest first by id within priority. The
    UI's Rules page renders these alongside category and business rules
    so the user has one mental home for all rule-driven overrides."""
    rules = db.query(SubscriptionRule).order_by(
        SubscriptionRule.priority, SubscriptionRule.id,
    ).all()
    return [
        SubscriptionRuleOut(
            id=r.id, pattern=r.pattern, kind=r.kind,
            priority=r.priority or 100, notes=r.notes,
        )
        for r in rules
    ]


@router.post("/")
def create_rule(body: SubscriptionRuleIn, db: Session = Depends(get_db)):
    """Create a new override. Idempotent on (pattern, kind) — if the
    same rule already exists we return the existing one rather than
    raising, which matches the user's intuition (clicking the button
    twice shouldn't error)."""
    if body.kind not in _VALID_KINDS:
        raise HTTPException(
            400,
            f"kind must be one of {sorted(_VALID_KINDS)}",
        )
    existing = (
        db.query(SubscriptionRule)
        .filter(
            SubscriptionRule.pattern == body.pattern,
            SubscriptionRule.kind == body.kind,
        )
        .first()
    )
    if existing:
        return SubscriptionRuleOut(
            id=existing.id, pattern=existing.pattern, kind=existing.kind,
            priority=existing.priority or 100, notes=existing.notes,
        )
    rule = SubscriptionRule(
        pattern=body.pattern,
        kind=body.kind,
        priority=body.priority or 100,
        notes=body.notes,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return SubscriptionRuleOut(
        id=rule.id, pattern=rule.pattern, kind=rule.kind,
        priority=rule.priority or 100, notes=rule.notes,
    )


@router.delete("/{rule_id}")
def delete_rule(rule_id: int, db: Session = Depends(get_db)):
    rule = db.query(SubscriptionRule).filter_by(id=rule_id).first()
    if not rule:
        raise HTTPException(404, "Rule not found")
    db.delete(rule)
    db.commit()
    return {"status": "deleted"}
