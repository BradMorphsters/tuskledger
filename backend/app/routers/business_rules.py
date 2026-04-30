"""Business Rules CRUD & retroactive application."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import and_

from app.database import get_db
from app.models import BusinessRule, Transaction, Business
from app.schemas.schemas import BusinessRuleIn, BusinessRuleOut, BusinessRuleApplyResult

router = APIRouter(prefix="/api/business-rules", tags=["business-rules"])


# ─── CRUD ─────────────────────────────────────────────────────────
@router.get("/")
def list_business_rules(db: Session = Depends(get_db)):
    """List all business rules with business name for display."""
    rules = db.query(BusinessRule).order_by(BusinessRule.priority, BusinessRule.id).all()
    result = []
    for rule in rules:
        biz = db.query(Business).filter_by(id=rule.business_id).first()
        result.append(
            BusinessRuleOut(
                id=rule.id,
                pattern=rule.pattern,
                business_id=rule.business_id,
                priority=rule.priority,
                business_name=biz.name if biz else None,
            )
        )
    return result


@router.post("/")
def create_business_rule(body: BusinessRuleIn, db: Session = Depends(get_db)):
    """Create a new business rule."""
    biz = db.query(Business).filter_by(id=body.business_id).first()
    if not biz:
        raise HTTPException(404, "Business not found")

    rule = BusinessRule(
        pattern=body.pattern,
        business_id=body.business_id,
        priority=body.priority or 100,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)

    return BusinessRuleOut(
        id=rule.id,
        pattern=rule.pattern,
        business_id=rule.business_id,
        priority=rule.priority,
        business_name=biz.name,
    )


@router.delete("/{rule_id}")
def delete_business_rule(rule_id: int, db: Session = Depends(get_db)):
    """Delete a business rule."""
    rule = db.query(BusinessRule).filter_by(id=rule_id).first()
    if not rule:
        raise HTTPException(404, "Rule not found")

    db.delete(rule)
    db.commit()
    return {"status": "deleted"}


# ─── Apply retroactively ──────────────────────────────────────────
@router.post("/{rule_id}/apply")
def apply_business_rule(rule_id: int, db: Session = Depends(get_db)):
    """
    Retroactively apply a business rule to all matching transactions.

    Match logic: pattern.lower() substring in (merchant_name + " " + name).lower()
    - If business_id is null OR equals the rule's business_id, update to rule's business_id
    - If business_id is already set to a DIFFERENT business, skip (don't overwrite manual tag)

    Returns count of matched and actually updated transactions.
    """
    rule = db.query(BusinessRule).filter_by(id=rule_id).first()
    if not rule:
        raise HTTPException(404, "Rule not found")

    # Find all matching transactions
    all_txns = db.query(Transaction).all()
    matched_ids = []
    skipped_ids = []

    pattern_lower = rule.pattern.lower()
    for txn in all_txns:
        search_text = (
            ((txn.merchant_name or "") + " " + (txn.name or "")).lower()
        )
        if pattern_lower in search_text:
            # This transaction matches the pattern
            if txn.business_id is None or txn.business_id == rule.business_id:
                # Safe to tag: either untagged or already tagged with this business
                matched_ids.append(txn.id)
            else:
                # Already tagged with a different business — don't overwrite
                skipped_ids.append(txn.id)

    # Single SQL update for all matched transactions
    updated_count = 0
    if matched_ids:
        updated_count = (
            db.query(Transaction)
            .filter(Transaction.id.in_(matched_ids))
            .update({"business_id": rule.business_id}, synchronize_session="fetch")
        )
        db.commit()

    return BusinessRuleApplyResult(
        rule_id=rule_id,
        matched=len(matched_ids) + len(skipped_ids),
        updated=updated_count,
        skipped_already_tagged=len(skipped_ids),
    )
