"""Plaid Link and account connection routes."""
from __future__ import annotations

import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from app.database import _is_demo_request, get_db
from app.models import (
    PlaidItem,
    Account,
    Transaction,
    Holding,
    InvestmentTransaction,
    MortgageDetail,
    CreditCardDetail,
)
from app.schemas.schemas import LinkTokenResponse, PublicTokenExchange
from app.services.plaid_service import get_plaid_client, create_link_token, exchange_public_token
from app.services.sync_service import sync_single_item
from app.services.crypto import encrypt_token

router = APIRouter(prefix="/api/plaid", tags=["plaid"])


@router.post("/link-token", response_model=LinkTokenResponse)
def get_link_token():
    """Generate a Plaid Link token for the frontend."""
    client = get_plaid_client()
    token = create_link_token(client)
    return {"link_token": token}


@router.post("/exchange-token")
def exchange_token(body: PublicTokenExchange, db: Session = Depends(get_db)):
    """Exchange a public token from Plaid Link for an access token and sync accounts."""
    client = get_plaid_client()
    result = exchange_public_token(client, body.public_token)

    # Store the Plaid item. The access_token is encrypted at rest.
    item = PlaidItem(
        item_id=result["item_id"],
        access_token=encrypt_token(result["access_token"]),
        institution_id=body.institution_id,
        institution_name=body.institution_name,
    )
    db.add(item)
    db.commit()
    db.refresh(item)

    # Immediately sync this item
    sync_result = sync_single_item(db, client, item)

    return {"status": "connected", "item_id": result["item_id"], "sync": sync_result}


@router.post("/sync")
def trigger_sync(request: Request, db: Session = Depends(get_db)):
    """Manually trigger a sync of all linked accounts."""
    # In demo mode the "Plaid items" are fake — short-circuit before we
    # try to call Plaid's API with a synthetic access token.
    if _is_demo_request(request):
        return {"status": "ok", "results": [], "note": "demo mode — sync is a no-op"}
    from app.services.sync_service import sync_all_items
    results = sync_all_items(db)
    return {"status": "ok", "results": results}


@router.post("/backfill")
def backfill_range(
    request: Request,
    start: datetime.date = Query(..., description="Inclusive start date (YYYY-MM-DD)"),
    end: datetime.date = Query(..., description="Inclusive end date (YYYY-MM-DD)"),
    item_id: Optional[int] = Query(
        None, description="If provided, backfill only this PlaidItem.id; otherwise all items"
    ),
    db: Session = Depends(get_db),
):
    """One-off historical backfill via Plaid's /transactions/get.

    Use case: /transactions/sync has already advanced past a window
    (e.g. January 2026) and you've discovered missing transactions.
    Calling this re-fetches the date range and inserts anything not
    already in the DB. Cursor stays untouched. Idempotent — re-running
    the same range never double-inserts (dedupes by plaid_transaction_id).

    Demo mode short-circuits since the synthetic data has no Plaid backing.

    Example:
      curl -X POST 'http://127.0.0.1:8000/api/plaid/backfill?start=2026-01-01&end=2026-01-31'
    """
    if _is_demo_request(request):
        return {"status": "ok", "note": "demo mode — backfill is a no-op", "items": []}
    if end < start:
        raise HTTPException(400, "end date must be on or after start date")
    # Plaid's /transactions/get supports up to 24 months back. Bigger
    # windows aren't blocked here — Plaid will surface the error itself.
    from app.services.sync_service import backfill_transactions
    result = backfill_transactions(db, start_date=start, end_date=end, item_id=item_id)
    return {"status": "ok", **result}


@router.post("/detect-transfers")
def detect_transfers_route(reset: bool = False, db: Session = Depends(get_db)):
    """Re-run the transfer detector across all existing transactions.

    Useful after a code change to the detector or after categorizing
    rules, without waiting for the next sync. Idempotent.

    Pass `?reset=true` to clear all existing is_transfer flags before
    re-running — needed when classification rules have changed (e.g.
    a kind that used to be a transfer is no longer treated as one).
    """
    from app.services.transfer_detector import detect_transfers
    return detect_transfers(db, reset=reset)


@router.post("/debug-liabilities/{item_id}")
def debug_liabilities(item_id: int, db: Session = Depends(get_db)):
    """Diagnostic: call /liabilities/get for one item and return the
    raw response (or the raw error). Bypasses the silent catch in the
    main sync path so we can see why liability data isn't landing.
    """
    from app.services.plaid_service import get_plaid_client, get_liabilities
    from app.services.crypto import decrypt_token
    item = db.query(PlaidItem).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(404, "Item not found")
    client = get_plaid_client()
    access_token = decrypt_token(item.access_token)
    try:
        data = get_liabilities(client, access_token)
        return {
            "ok": True,
            "account_count": len(data.get("accounts", [])),
            "mortgage_count": len(((data.get("liabilities") or {}).get("mortgage") or [])),
            "credit_count": len(((data.get("liabilities") or {}).get("credit") or [])),
            "student_count": len(((data.get("liabilities") or {}).get("student") or [])),
            "raw_keys": list((data.get("liabilities") or {}).keys()),
        }
    except Exception as e:  # noqa: BLE001
        # Strip any access tokens / IDs from the error string before returning.
        import re
        msg = str(e)[:2000]
        msg = re.sub(r"[a-zA-Z0-9_-]{25,}", "BIGID", msg)
        return {
            "ok": False,
            "error_type": type(e).__name__,
            "error": msg,
        }


@router.get("/items")
def list_items(db: Session = Depends(get_db)):
    """List all connected financial institutions."""
    items = db.query(PlaidItem).all()
    return [
        {
            "id": item.id,
            "item_id": item.item_id,
            "institution_name": item.institution_name,
            "created_at": item.created_at,
        }
        for item in items
    ]


@router.delete("/items/{item_id}")
def delete_item(item_id: int, db: Session = Depends(get_db)):
    """Remove a connected institution and all its accounts/transactions."""
    item = db.query(PlaidItem).filter_by(id=item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    # Delete associated accounts and every row that hangs off them.
    #
    # These child tables (holdings, investment_transactions, and the two
    # liability-detail tables) declare `ondelete="CASCADE"` on their
    # account_id FK, but SQLite does NOT honor FK cascades unless
    # `PRAGMA foreign_keys=ON` is set on the connection — and we never
    # enable it. So the DB won't clean these up for us; deleting only the
    # transactions + accounts + item leaves orphaned holdings /
    # investment-transaction / liability rows behind (they later surface
    # as phantom positions and net-worth math referencing a dead account).
    # Delete them explicitly here rather than flipping the pragma globally
    # (which would change delete semantics app-wide).
    accounts = db.query(Account).filter_by(plaid_item_id=item.id).all()
    for acc in accounts:
        db.query(Transaction).filter_by(account_id=acc.id).delete()
        db.query(Holding).filter_by(account_id=acc.id).delete()
        db.query(InvestmentTransaction).filter_by(account_id=acc.id).delete()
        db.query(MortgageDetail).filter_by(account_id=acc.id).delete()
        db.query(CreditCardDetail).filter_by(account_id=acc.id).delete()
        db.delete(acc)

    db.delete(item)
    db.commit()
    return {"status": "deleted", "item_id": item_id}
