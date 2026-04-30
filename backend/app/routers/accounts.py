"""Account routes."""
import datetime
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Account, MortgageDetail, CreditCardDetail, Transaction
from app.schemas.schemas import (
    AccountOut,
    AccountUpdate,
    ManualAccountCreate,
    MortgageDetailOut,
    CreditCardDetailOut,
    StaleAccountOut,
    StaleAccountsResponse,
)

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


def _attach_derived_fields(accounts: list[Account], db: Session) -> list[Account]:
    """Decorate Account rows with the derived fields AccountOut wants:
       - is_manual (plaid_item_id IS NULL)
       - transactions_through (MAX(transaction.date) per account)

    Single GROUP BY query so we don't N+1 across the account list.
    """
    rows = (
        db.query(Transaction.account_id, func.max(Transaction.date))
        .group_by(Transaction.account_id)
        .all()
    )
    through_by = {acct_id: max_date for acct_id, max_date in rows}
    for acc in accounts:
        # SQLAlchemy lets us slap dynamic attributes on a model instance;
        # Pydantic's from_attributes mode will pick them up.
        acc.is_manual = acc.plaid_item_id is None
        acc.transactions_through = through_by.get(acc.id)
    return accounts


@router.get("/", response_model=List[AccountOut])
def list_accounts(db: Session = Depends(get_db)):
    accounts = db.query(Account).order_by(Account.type, Account.name).all()
    return _attach_derived_fields(accounts, db)


@router.post("/", response_model=AccountOut)
def create_manual_account(body: ManualAccountCreate, db: Session = Depends(get_db)):
    """Create a manual (non-Plaid) account. Balance and transactions on
    these accounts are managed by the user — sync_service skips them
    because plaid_item_id is NULL.
    """
    account = Account(
        plaid_account_id=None,
        plaid_item_id=None,
        name=body.name.strip(),
        custom_name=body.custom_name.strip() if body.custom_name else None,
        type=body.type,
        subtype=body.subtype,
        institution_name=body.institution_name,
        mask=body.mask,
        current_balance=body.current_balance,
        currency=body.currency or "USD",
        # Snapshot date is "today" by default — that's when we recorded
        # the balance unless the caller knows the underlying statement
        # period and passes it explicitly (e.g. statement end date).
        balance_as_of=body.balance_as_of or datetime.date.today(),
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    _attach_derived_fields([account], db)
    return account


def _start_of_previous_month(today: datetime.date) -> datetime.date:
    """First day of the calendar month preceding `today`.

    Used as the staleness threshold for manual accounts — once we're
    in month N+1 with as_of < first-of-month-N, the user is missing a
    statement that has had time to publish.
    """
    if today.month == 1:
        return datetime.date(today.year - 1, 12, 1)
    return datetime.date(today.year, today.month - 1, 1)


_MONTH_NAMES = [
    "", "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


@router.get("/stale", response_model=StaleAccountsResponse)
def list_stale_accounts(
    days: int = Query(
        7, ge=1,
        description="Plaid-synced accounts older than this many days are considered stale. "
                    "Manual accounts use a calendar-month rule instead and ignore this value.",
    ),
    db: Session = Depends(get_db),
):
    """Return accounts whose data is overdue. Two cadences:

    **Plaid accounts** (plaid_item_id IS NOT NULL): stale when the most
    recent transaction or balance snapshot is more than `days` old.
    Plaid's scheduler refreshes every few hours, so a multi-day gap means
    something's broken (ITEM_LOGIN_REQUIRED, institution down, etc.).

    **Manual accounts** (plaid_item_id IS NULL): stale only when a
    completed prior calendar month is unaccounted for. Concretely:
    `as_of < first-of-previous-month`. The user updates these via
    monthly statements, which only become available AFTER the month
    closes — flagging mid-month is noise because there's nothing to
    upload yet. As soon as the new month starts, anything that doesn't
    cover the just-finished month gets surfaced.

    Skips accounts that have neither a balance snapshot nor any
    transactions (never been touched).

    NOTE: This route MUST be declared before /{account_id} or FastAPI will
    try to parse "stale" as an int and 422 on the path param.
    """
    today = datetime.date.today()
    plaid_threshold = today - datetime.timedelta(days=days)
    prev_month_start = _start_of_previous_month(today)
    prev_month_name = _MONTH_NAMES[prev_month_start.month]

    # Pre-compute MAX(transaction.date) per account in one GROUP BY to avoid N+1.
    txn_max = dict(
        db.query(Transaction.account_id, func.max(Transaction.date))
        .group_by(Transaction.account_id)
        .all()
    )

    stale_list = []
    for acct in db.query(Account).all():
        # Manual accounts use balance_as_of; synced accounts use last txn date.
        as_of = acct.balance_as_of if acct.balance_as_of is not None else txn_max.get(acct.id)
        if as_of is None:
            continue  # never touched — skip rather than flag a noisy "infinity stale"

        is_manual = acct.plaid_item_id is None
        days_stale = (today - as_of).days

        if is_manual:
            # Calendar-month cadence — flag only when the previous full
            # month has fully elapsed without being covered.
            if as_of >= prev_month_start:
                continue
            reason = f"{prev_month_name} statement overdue"
            cadence = "manual"
        else:
            # Plaid days-based threshold.
            if as_of > plaid_threshold:
                continue
            reason = f"{days_stale} days since last sync"
            cadence = "plaid"

        stale_list.append(
            StaleAccountOut(
                id=acct.id,
                name=acct.custom_name or acct.name,
                institution_name=acct.institution_name,
                last_seen=as_of,
                days_stale=days_stale,
                cadence=cadence,
                reason=reason,
            )
        )

    stale_list.sort(key=lambda x: x.days_stale, reverse=True)

    return StaleAccountsResponse(
        stale_count=len(stale_list),
        threshold_days=days,
        as_of=today,
        accounts=stale_list,
    )


@router.get("/{account_id}", response_model=AccountOut)
def get_account(account_id: int, db: Session = Depends(get_db)):
    account = db.query(Account).filter_by(id=account_id).first()
    if not account:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")
    _attach_derived_fields([account], db)
    return account


@router.patch("/{account_id}", response_model=AccountOut)
def update_account(account_id: int, body: AccountUpdate, db: Session = Depends(get_db)):
    """Update the user-editable fields on an account (currently just custom_name).

    `custom_name`:
      - omitted or null  → no change
      - empty string     → clear the alias (fall back to the Plaid name)
      - any other string → set as the alias
    """
    account = db.query(Account).filter_by(id=account_id).first()
    if not account:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Account not found")

    data = body.model_dump(exclude_unset=True)
    if "custom_name" in data:
        value = data["custom_name"]
        account.custom_name = value.strip() if isinstance(value, str) and value.strip() else None
    if "current_balance" in data and data["current_balance"] is not None:
        # Only honored on manual (no plaid_item_id) accounts; Plaid will
        # overwrite this on next sync for real items, so silently ignore.
        if account.plaid_item_id is None:
            account.current_balance = float(data["current_balance"])
            # Auto-bump the snapshot date when the balance changes —
            # mirrors the value_as_of behavior on manual_assets.
            if "balance_as_of" not in data:
                account.balance_as_of = datetime.date.today()
    if "balance_as_of" in data and data["balance_as_of"] is not None:
        if account.plaid_item_id is None:
            account.balance_as_of = data["balance_as_of"]
    if "tax_bucket" in data:
        # Allow setting any of the valid buckets, or clearing entirely
        # (e.g., for non-investment accounts where the bucket doesn't apply).
        # 'excluded' means the account is INVESTMENT-typed but should be
        # ignored by the retirement projection (e.g. balance is borrowed
        # money owed back to a HELOC). Other features still see the account
        # normally — only the retirement-projection sum skips it.
        # 'hsa' is the triple-tax-advantaged bucket added with the HSA
        # carve-out — qualified-medical withdrawals come tax-free.
        # Reject typos so the projection math doesn't silently mis-bucket.
        v = data["tax_bucket"]
        if v in (None, '', 'tax_deferred', 'roth', 'taxable', 'hsa', 'excluded'):
            account.tax_bucket = v if v else None
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid tax_bucket '{v}'. Must be tax_deferred, roth, taxable, hsa, or excluded.",
            )

    if "roth_split_pct" in data:
        # Fractional Roth split for accounts that mix pre-tax and Roth
        # contributions in a single Plaid balance. NULL/empty clears it.
        v = data["roth_split_pct"]
        if v in (None, ""):
            account.roth_split_pct = None
        else:
            try:
                pct = float(v)
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="roth_split_pct must be a number between 0 and 1.",
                )
            if not 0.0 <= pct <= 1.0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="roth_split_pct must be between 0 and 1.",
                )
            account.roth_split_pct = pct

    db.commit()
    db.refresh(account)
    _attach_derived_fields([account], db)
    return account


@router.get("/{account_id}/mortgage", response_model=MortgageDetailOut)
def get_mortgage_detail(account_id: int, db: Session = Depends(get_db)):
    """Plaid Liabilities mortgage detail for the given account.

    Returns 404 if the account doesn't exist or doesn't have a mortgage
    record (e.g., it isn't a mortgage, or the bank doesn't expose
    Liabilities for it). UI should call this only for type=loan accounts.
    """
    detail = db.query(MortgageDetail).filter_by(account_id=account_id).first()
    if not detail:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No mortgage detail for this account",
        )
    return detail


@router.get("/{account_id}/credit-card", response_model=CreditCardDetailOut)
def get_credit_card_detail(account_id: int, db: Session = Depends(get_db)):
    """Plaid Liabilities credit-card detail (APRs, statement, payment) for
    the given account. 404 when not present.
    """
    detail = db.query(CreditCardDetail).filter_by(account_id=account_id).first()
    if not detail:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No credit-card detail for this account",
        )
    return detail


