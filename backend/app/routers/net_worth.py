"""Net worth tracking routes."""
from datetime import date, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import NetWorthSnapshot
from app.schemas.schemas import NetWorthSnapshotOut

router = APIRouter(prefix="/api/net-worth", tags=["net-worth"])


@router.get("/", response_model=List[NetWorthSnapshotOut])
def get_net_worth_history(
    days: int = Query(default=90, le=3650),
    db: Session = Depends(get_db),
):
    """Get net worth history for the last N days."""
    cutoff = date.today() - timedelta(days=days)
    return (
        db.query(NetWorthSnapshot)
        .filter(NetWorthSnapshot.date >= cutoff)
        .order_by(NetWorthSnapshot.date)
        .all()
    )


@router.get("/latest", response_model=Optional[NetWorthSnapshotOut])
def get_latest_net_worth(db: Session = Depends(get_db)):
    return db.query(NetWorthSnapshot).order_by(NetWorthSnapshot.date.desc()).first()


@router.post("/refresh", response_model=Optional[NetWorthSnapshotOut])
def refresh_net_worth(db: Session = Depends(get_db)):
    """Recompute today's net worth snapshot from current account and
    manual-asset balances. Useful after a manual import that changes
    account balances or adds new accounts without going through Plaid
    sync. Idempotent — overwrites today's existing snapshot if present.
    """
    from app.services.sync_service import take_net_worth_snapshot
    take_net_worth_snapshot(db)
    return db.query(NetWorthSnapshot).order_by(NetWorthSnapshot.date.desc()).first()
