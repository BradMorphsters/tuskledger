"""CSV Import routes — bulk transaction upload from CSV files."""
from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Account, Transaction
from app.services.csv_classifier import (
    detect_format,
    parse_date,
    parse_amount,
    classify_merchant_and_category,
    make_merchant_signature,
)
from app.services.categories import map_plaid_category

router = APIRouter(prefix="/api/csv-import", tags=["csv-import"])


@router.post("/")
async def import_csv(
    file: UploadFile = File(...),
    account_id: int = Query(...),
    db: Session = Depends(get_db),
):
    """
    Upload and import CSV transactions.
    
    Auto-detects format (LMCU, Chase, generic).
    Deduplicates by (account_id, date, amount, merchant_signature).
    Returns import summary with per-row status.
    """
    # Verify account exists
    account = db.query(Account).filter_by(id=account_id).first()
    if not account:
        raise HTTPException(404, "Account not found")

    # Read file
    try:
        content = await file.read()
        text = content.decode('utf-8')
    except Exception as e:
        raise HTTPException(400, f"Failed to read file: {str(e)}")

    # Parse CSV
    try:
        reader = csv.DictReader(io.StringIO(text))
        if not reader.fieldnames:
            raise HTTPException(400, "CSV is empty")
        
        rows = list(reader)
    except Exception as e:
        raise HTTPException(400, f"Failed to parse CSV: {str(e)}")

    # Detect format
    fmt = detect_format(list(reader.fieldnames))
    if not fmt:
        raise HTTPException(400, f"Unrecognized CSV format. Headers: {', '.join(reader.fieldnames[:5])}")

    # Process rows
    parsed_rows = []
    inserted_count = 0
    skipped_count = 0
    row_results = []

    # Build existing transaction signatures for deduplication
    existing_txns = db.query(Transaction).filter_by(account_id=account_id).all()
    existing_sigs = set()
    for txn in existing_txns:
        sig_key = (
            txn.date.isoformat() if hasattr(txn.date, 'isoformat') else str(txn.date),
            txn.amount,
            make_merchant_signature(txn.merchant_name or txn.name or ""),
        )
        existing_sigs.add(sig_key)

    for i, row in enumerate(rows):
        try:
            # Extract based on format
            if fmt == 'lmcu':
                date_val = parse_date(row.get('Date', ''))
                amount_val = parse_amount(row.get('Amount', ''), fmt)
                description = row.get('Description', '').strip()
                merchant = row.get('Merchant', '').strip() or description.split()[0] if description else "Unknown"
            elif fmt == 'chase':
                date_val = parse_date(row.get('Transaction Date') or row.get('Post Date', ''))
                amount_val = parse_amount(row.get('Amount', ''), fmt)
                description = row.get('Description', '').strip()
                merchant = description.split()[0] if description else "Unknown"
            else:  # generic
                date_val = parse_date(row.get('Date', ''))
                amount_val = parse_amount(row.get('Amount', ''), fmt)
                description = row.get('Description', '').strip()
                merchant = description.split()[0] if description else "Unknown"

            if not date_val or amount_val is None:
                row_results.append({
                    "date": date_val or "—",
                    "amount": amount_val,
                    "merchant": merchant or "—",
                    "status": "skipped",
                    "reason": "Missing date or amount",
                })
                continue

            # Classify
            merchant_name, category = classify_merchant_and_category(description, merchant)

            # Check for duplicate
            sig_key = (date_val, amount_val, make_merchant_signature(merchant_name))
            if sig_key in existing_sigs:
                row_results.append({
                    "date": date_val,
                    "amount": amount_val,
                    "merchant": merchant_name,
                    "status": "skipped",
                    "reason": "Already exists",
                })
                skipped_count += 1
                continue

            # Create transaction
            txn = Transaction(
                account_id=account_id,
                date=datetime.fromisoformat(date_val).date(),
                name=description,
                merchant_name=merchant_name,
                amount=amount_val,
                category=category,
                custom_category=None,
                pending=False,
                plaid_transaction_id=None,
            )
            db.add(txn)
            existing_sigs.add(sig_key)
            inserted_count += 1
            row_results.append({
                "date": date_val,
                "amount": amount_val,
                "merchant": merchant_name,
                "status": "inserted",
            })

        except Exception as e:
            row_results.append({
                "date": row.get('Date', '—'),
                "amount": "—",
                "merchant": row.get('Description', '—')[:30],
                "status": "skipped",
                "reason": f"Error: {str(e)[:50]}",
            })

    db.commit()

    return {
        "format_detected": fmt,
        "parsed": len(rows),
        "inserted": inserted_count,
        "skipped_existing": skipped_count,
        "rows": row_results,
    }
