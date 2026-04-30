"""Detect account-to-account transfers and credit-card / loan payments.

Runs after each sync (and can be invoked manually as a one-off backfill).
Flags transactions with ``is_transfer = True`` so they don't count as
spending or income in aggregations.

Two strategies combined:

1. **Pair matching** — the canonical internal transfer: an outflow on one
   account paired with an inflow on another account within ±3 days, same
   absolute amount. Catches things like "Internal Transfer from
   Checking → Loan" when both accounts are linked in Tusk Ledger.

2. **Issuer patterns** — catches outflows to external credit cards and
   loan servicers where we don't see the other side (Apple Card, Chase
   CC autopay, Dept of Education). Uses
   ``merchant_normalizer.classify()``; anything labeled cc_payment /
   loan_payment / internal_transfer gets flagged.

Idempotent: already-flagged transactions are skipped, and the detector
can be rerun safely.
"""
from __future__ import annotations

import datetime
import logging
from typing import Iterable

from sqlalchemy.orm import Session

from app.models import Transaction
from app.services.merchant_normalizer import classify

log = logging.getLogger(__name__)


# How far apart (in days) two paired transactions may be dated.
# 3 days covers weekend settlement delays on ACH transfers.
_PAIR_DAY_WINDOW = 3

# Amounts within this many dollars are treated as equal for pairing.
# (Plaid sometimes reports fees on one side; we keep this tight to avoid
# spurious pairings.)
_PAIR_AMOUNT_EPSILON = 0.01

# Issuer-pattern classifications that indicate a non-spending transaction.
#
# Notably absent: 'loan_payment'. Mortgage / auto loan / student loan
# payments ARE real cash outflows even though the principal portion pays
# down a liability — the original loan disbursement wasn't tracked as a
# transaction, so the monthly payment is the only cash-flow record we
# have. Counting it as spending tells the honest story for budgeting and
# the cash-flow forecast.
#
# CC payments stay flagged because the spending was already counted at
# point-of-sale (Costco, Amazon, etc.) — flagging the CC autopay too
# would double-count. Same logic for internal_transfer and
# brokerage_transfer: both sides of the move are accounts you own.
_TRANSFER_KINDS = {"cc_payment", "internal_transfer", "brokerage_transfer"}


def detect_transfers(db: Session, *, reset: bool = False) -> dict:
    """Flag transfers across all transactions. Returns counts for reporting.

    Pass `reset=True` to clear all existing is_transfer flags before
    re-running. That's needed when the classification rules change (e.g.
    if a kind that used to be in _TRANSFER_KINDS is no longer there) —
    the normal incremental run only ADDS the flag, never removes it,
    so an old classification would otherwise stick around.
    """
    if reset:
        cleared = (
            db.query(Transaction)
            .filter(Transaction.is_transfer.is_(True))
            .update({Transaction.is_transfer: False}, synchronize_session=False)
        )
        log.info("transfer detector: reset cleared %d existing flags", cleared)
        db.commit()

    pair_count = _mark_paired_transfers(db)
    pattern_count = _mark_pattern_transfers(db)
    db.commit()
    total = (
        db.query(Transaction).filter(Transaction.is_transfer.is_(True)).count()
    )
    log.info(
        "transfer detector: paired=%d, pattern=%d, total_flagged=%d",
        pair_count, pattern_count, total,
    )
    return {
        "paired_marked": pair_count,
        "pattern_marked": pattern_count,
        "total_flagged": total,
        "reset": reset,
    }


def _mark_paired_transfers(db: Session) -> int:
    """Pair outflow + inflow on different accounts, same |amount|, within window.

    Only considers transactions that aren't already flagged. A single
    transaction can pair with at most one other; we greedily take the
    closest-in-date candidate when multiple match.
    """
    # Pull candidate set once. For a local personal-finance DB this stays
    # small (thousands, not millions).
    unflagged = (
        db.query(Transaction)
        .filter(Transaction.is_transfer.is_(False))
        .order_by(Transaction.date.asc(), Transaction.id.asc())
        .all()
    )

    # Index by (abs_amount_cents, account_id, is_outflow) so pair lookup
    # is cheap. Using integer cents avoids float-equality headaches.
    by_signature: dict[tuple[int, int, bool], list[Transaction]] = {}
    for t in unflagged:
        cents = round(abs(t.amount or 0.0) * 100)
        is_outflow = (t.amount or 0.0) > 0
        key = (cents, t.account_id, is_outflow)
        by_signature.setdefault(key, []).append(t)

    matched_ids: set[int] = set()
    pairs_found = 0

    for t in unflagged:
        if t.id in matched_ids:
            continue
        cents = round(abs(t.amount or 0.0) * 100)
        if cents == 0:
            continue  # $0 transactions are never transfers.
        is_outflow = (t.amount or 0.0) > 0

        # Look for the opposite-sign, different-account counterparty.
        # Scan all other accounts that have the same cent value with
        # opposite direction.
        candidates: list[Transaction] = []
        for (c_cents, c_acct, c_outflow), txns in by_signature.items():
            if c_cents != cents:
                continue
            if c_acct == t.account_id:
                continue
            if c_outflow == is_outflow:
                continue
            for candidate in txns:
                if candidate.id in matched_ids or candidate.id == t.id:
                    continue
                if abs((candidate.date - t.date).days) > _PAIR_DAY_WINDOW:
                    continue
                candidates.append(candidate)

        if not candidates:
            continue

        # Prefer the closest-in-date match. Ties broken by lower id for
        # determinism.
        candidates.sort(key=lambda c: (abs((c.date - t.date).days), c.id))
        partner = candidates[0]

        t.is_transfer = True
        partner.is_transfer = True
        matched_ids.add(t.id)
        matched_ids.add(partner.id)
        pairs_found += 1

    return pairs_found * 2  # count each side separately for the report


def _mark_pattern_transfers(db: Session) -> int:
    """Flag transactions whose merchant name matches a known CC / loan pattern.

    Runs over all not-yet-flagged transactions (paired ones were handled
    by the previous pass). Inflows matching a CC-payment pattern are
    also flagged — e.g. "AUTOMATIC PAYMENT - THANK" confirmation deposits.
    """
    unflagged: Iterable[Transaction] = (
        db.query(Transaction).filter(Transaction.is_transfer.is_(False)).all()
    )
    flagged = 0
    for t in unflagged:
        # Check BOTH the cleaned merchant_name and the raw bank description —
        # Plaid often gives a tidy merchant_name like "Apple Card" while the
        # raw `name` field carries the richer "WITHDRAWAL APPLECARD GSBANK…"
        # string. Either one matching is enough to flag.
        combined = f"{t.merchant_name or ''} {t.name or ''}"
        if classify(combined) in _TRANSFER_KINDS:
            t.is_transfer = True
            flagged += 1
    return flagged
