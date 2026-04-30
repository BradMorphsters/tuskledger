"""Utilities for expanding split transactions into per-category line items.

A "line" is a 4-tuple (date, amount, category, transaction_id) representing
either the full amount of a non-split transaction, or each split of a split
transaction. Analytics code should iterate over lines rather than raw
Transaction rows so split amounts get attributed to the correct category.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date as _date
from typing import Iterable, Iterator, Optional

from app.models import Transaction


@dataclass(frozen=True)
class TxnLine:
    date: _date
    amount: float
    category: str
    transaction_id: int
    merchant: Optional[str]
    business_id: Optional[int]


def expand(txns: Iterable[Transaction]) -> Iterator[TxnLine]:
    """Yield one TxnLine per split, or one per transaction if it has no splits.

    Category precedence for non-split transactions:
      custom_category > category > "Uncategorized"
    Splits always use their own category verbatim.
    """
    for t in txns:
        merchant = t.merchant_name or t.name
        if t.splits:
            for s in t.splits:
                yield TxnLine(
                    date=t.date,
                    amount=s.amount,
                    category=s.category or "Uncategorized",
                    transaction_id=t.id,
                    merchant=merchant,
                    business_id=s.business_id or t.business_id,
                )
        else:
            yield TxnLine(
                date=t.date,
                amount=t.amount,
                category=t.custom_category or t.category or "Uncategorized",
                transaction_id=t.id,
                merchant=merchant,
                business_id=t.business_id,
            )
