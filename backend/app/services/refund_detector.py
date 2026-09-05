"""Flag refunds so they net against spending instead of counting as income.

Plaid's sign convention is amount > 0 = money out, amount < 0 = money in,
and for years every aggregation in this app read "money in" as income.
That is right for a paycheck and wrong for a store return: a $400
hardware-store return is not $400 of income, it is −$400 of Home spending. Monarch,
Copilot and YNAB all net a refund against the category it came from.

Definition (pure, in `is_refund_row`): an inflow that is NOT a transfer and
whose effective category is a *spending* category — anything other than
the income-like set below. A row with no category at all is left as
income; we don't guess.

Recomputed in full after every sync (cheap: one pass over rows with
amount < 0) and for a single row whenever its category or transfer flag
changes (see routers/transactions.update_transaction). It is a derived
flag, not a user toggle — change the category and the flag follows.
"""
from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.models import Transaction
from app.utils import utcnow

log = logging.getLogger(__name__)

# Effective categories whose inflows really are income. "Transfer" is here
# because an inflow the detector could NOT pair but that Plaid labelled
# TRANSFER_IN is money arriving from somewhere we can't see — it is not a
# refund of spending, and calling it income preserves prior behaviour.
INCOME_LIKE_CATEGORIES = frozenset({"Income", "Transfer"})


def is_refund_row(amount: Optional[float], effective_category: Optional[str], is_transfer: bool) -> bool:
    """The one definition every caller shares."""
    if is_transfer or amount is None or amount >= 0:
        return False
    if not effective_category:
        return False
    return effective_category not in INCOME_LIKE_CATEGORIES


def refresh_refund_flag(t: Transaction) -> bool:
    """Recompute one row's flag in place. Returns True if it changed."""
    new = is_refund_row(t.amount, t.custom_category or t.category, bool(t.is_transfer))
    if bool(t.is_refund) != new:
        t.is_refund = new
        return True
    return False


def detect_refunds(db: Session) -> dict:
    """Recompute is_refund for every inflow. Idempotent; commits."""
    rows = db.query(Transaction).filter(Transaction.amount < 0).all()
    changed = 0
    for t in rows:
        if refresh_refund_flag(t):
            t.updated_at = utcnow()   # mobile incremental sync keys on this
            changed += 1
    # Anything that used to be a refund but is no longer an inflow (amount
    # edited to positive) — rare, but keep the flag honest.
    stale = (
        db.query(Transaction)
        .filter(Transaction.is_refund.is_(True), Transaction.amount >= 0)
        .all()
    )
    for t in stale:
        t.is_refund = False
        t.updated_at = utcnow()
        changed += 1
    db.commit()
    total = db.query(Transaction).filter(Transaction.is_refund.is_(True)).count()
    log.info("refund detector: changed=%d total_flagged=%d", changed, total)
    return {"changed": changed, "total_flagged": total}
