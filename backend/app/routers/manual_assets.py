"""User-tracked manual assets (homes, vehicles, etc.).

These have no Plaid backing — the user enters and updates the value
themselves. They roll up into Net Worth as assets.
"""
from __future__ import annotations

import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import ManualAsset
from app.schemas.schemas import ManualAssetCreate, ManualAssetOut, ManualAssetUpdate

router = APIRouter(prefix="/api/manual-assets", tags=["manual-assets"])


@router.get("/", response_model=List[ManualAssetOut])
def list_manual_assets(db: Session = Depends(get_db)):
    return (
        db.query(ManualAsset)
        .order_by(ManualAsset.type, ManualAsset.name)
        .all()
    )


def _refresh_net_worth(db: Session) -> None:
    """Re-snapshot Net Worth after a manual-asset change so the Dashboard
    and Net Worth pages reflect the new total without waiting for the
    next Plaid sync."""
    from app.services.sync_service import take_net_worth_snapshot
    take_net_worth_snapshot(db)


@router.post("/", response_model=ManualAssetOut)
def create_manual_asset(body: ManualAssetCreate, db: Session = Depends(get_db)):
    asset = ManualAsset(
        name=body.name.strip(),
        side=body.side or "asset",
        type=body.type,
        current_value=body.current_value,
        value_as_of=body.value_as_of or datetime.date.today(),
        notes=body.notes,
        address_street=body.address_street,
        address_city=body.address_city,
        address_region=body.address_region,
        address_postal_code=body.address_postal_code,
        address_country=body.address_country,
        plaid_mortgage_account_id=body.plaid_mortgage_account_id,
        paired_manual_liability_id=body.paired_manual_liability_id,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    _refresh_net_worth(db)
    return asset


@router.patch("/{asset_id}", response_model=ManualAssetOut)
def update_manual_asset(
    asset_id: int,
    body: ManualAssetUpdate,
    db: Session = Depends(get_db),
):
    asset = db.query(ManualAsset).filter_by(id=asset_id).first()
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")

    data = body.model_dump(exclude_unset=True)
    # Bump value_as_of automatically when current_value changes and the
    # caller didn't explicitly set a new date — that's the most common
    # update flow ("hey I just looked at Zillow, here's the new number").
    if "current_value" in data and "value_as_of" not in data:
        data["value_as_of"] = datetime.date.today()

    for field, value in data.items():
        setattr(asset, field, value)

    db.commit()
    db.refresh(asset)
    _refresh_net_worth(db)
    return asset


@router.delete("/{asset_id}")
def delete_manual_asset(asset_id: int, db: Session = Depends(get_db)):
    asset = db.query(ManualAsset).filter_by(id=asset_id).first()
    if not asset:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")
    db.delete(asset)
    db.commit()
    _refresh_net_worth(db)
    return {"status": "deleted", "id": asset_id}
