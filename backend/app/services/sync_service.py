"""Service to sync Plaid data into the local database."""
from __future__ import annotations

import datetime
import logging
from sqlalchemy.orm import Session
from app.models import (
    Account,
    Transaction,
    PlaidItem,
    NetWorthSnapshot,
    Security,
    Holding,
    InvestmentTransaction,
    MortgageDetail,
    CreditCardDetail,
    BusinessRule,
)
from app.services.plaid_service import (
    get_plaid_client,
    sync_transactions,
    get_transactions_range,
    get_account_balances,
    get_investments_holdings,
    get_investments_transactions,
    get_liabilities,
    parse_plaid_error,
)
from app.services.categories import map_plaid_category
from app.services.crypto import decrypt_token, encrypt_token, is_encrypted
from app.models import CategoryRule

log = logging.getLogger(__name__)


# Plaid account "type" values whose activity lives in the investment_transactions
# table, not the regular transactions table. We skip /transactions/sync for
# items that only contain these accounts because Plaid returns an error for
# pure-investment items. (Plaid's top-level type for 401k, IRA, brokerage,
# Roth, HSA-with-investments, etc. is all "investment"; the subtype
# distinguishes them, but we don't gate on subtype.)
INVESTMENT_ACCOUNT_TYPES = {"investment"}


def sync_all_items(db: Session):
    """Sync transactions and balances for all linked Plaid items."""
    client = get_plaid_client()
    items = db.query(PlaidItem).all()
    results = []

    for item in items:
        try:
            result = sync_single_item(db, client, item)
            results.append({"item_id": item.item_id, "status": "ok", **result})
        except Exception as e:
            results.append({"item_id": item.item_id, "status": "error", "error": str(e)})

    # Re-detect transfers across the full transaction set. Cheap against a
    # local SQLite DB; runs after sync so newly-inserted rows are seen.
    try:
        from app.services.transfer_detector import detect_transfers
        detect_transfers(db)
    except Exception as e:  # noqa: BLE001
        log.warning("transfer detection failed: %s", e)

    # Take a net worth snapshot after syncing
    take_net_worth_snapshot(db)
    return results


def sync_single_item(db: Session, client, item: PlaidItem) -> dict:
    """Sync a single Plaid item's transactions and balances."""
    # Lazy-migrate legacy plaintext tokens on first post-upgrade read.
    # This keeps the deploy story simple: no one-shot migration script —
    # the next sync transparently re-encrypts in place.
    if not is_encrypted(item.access_token):
        item.access_token = encrypt_token(item.access_token)
        db.add(item)
        db.flush()

    access_token = decrypt_token(item.access_token)

    # --- Sync balances ---
    plaid_accounts = get_account_balances(client, access_token)
    today = datetime.date.today()
    for pa in plaid_accounts:
        account = db.query(Account).filter_by(plaid_account_id=str(pa["account_id"])).first()
        if not account:
            account = Account(
                plaid_account_id=str(pa["account_id"]),
                plaid_item_id=item.id,
                name=str(pa.get("name", "")),
                official_name=str(pa["official_name"]) if pa.get("official_name") else None,
                type=str(pa["type"]),
                subtype=str(pa["subtype"]) if pa.get("subtype") else None,
                institution_name=item.institution_name,
                mask=str(pa["mask"]) if pa.get("mask") else None,
            )
            db.add(account)

        balance = pa.get("balances", {})
        current = balance.get("current")
        available = balance.get("available")
        account.current_balance = float(current) if current is not None else 0.0
        account.available_balance = float(available) if available is not None else None
        currency = balance.get("iso_currency_code") or "USD"
        account.currency = str(currency)
        # Stamp the sync timestamp on the account so freshness indicators
        # (Trading Tax page, Account Freshness component, stale-balance
        # alerts) reflect that we successfully pulled fresh data — even
        # in years/days where there were no transactions to advance the
        # txn_max derivation.
        account.balance_as_of = today

    db.flush()

    # Snapshot which accounts on this item are investment-type (brokerage,
    # 401k, IRA, etc.). We use this both to skip /transactions/sync on
    # pure-investment items and to know whether to call /investments/holdings.
    account_types_on_item = {a.type for a in db.query(Account).filter_by(plaid_item_id=item.id).all()}
    has_investment_accounts = bool(account_types_on_item & INVESTMENT_ACCOUNT_TYPES)
    has_cash_accounts = bool(account_types_on_item - INVESTMENT_ACCOUNT_TYPES)

    # --- Sync investments (holdings + investment transactions) ---
    inv_added = 0
    holdings_count = 0
    if has_investment_accounts:
        try:
            inv_added, holdings_count = _sync_investments(db, client, access_token, item)
        except Exception as e:  # noqa: BLE001
            # An item may return PRODUCT_NOT_READY on the very first sync
            # while Plaid is still pulling history. Don't fail the whole
            # sync — we'll retry on the next run.
            log.warning("investments sync failed for item %s: %s", item.id, e)

    # --- Sync liabilities (mortgage / CC / student loan detail) ---
    liabilities_count = 0
    has_liability_accounts = bool(account_types_on_item & {"loan", "credit"})
    if has_liability_accounts:
        try:
            liabilities_count = _sync_liabilities(db, client, access_token, item)
        except Exception as e:  # noqa: BLE001
            # Many institutions don't expose Liabilities even if the
            # product is enabled (e.g. a checking-only bank that happens
            # to have a 0-balance credit line). Skip and retry next sync.
            log.warning("liabilities sync failed for item %s: %s", item.id, e)

    # --- Sync transactions ---
    # Skip if the item is investment-only; /transactions/sync returns an
    # error (NO_ACCOUNTS) for pure investment items.
    if not has_cash_accounts:
        sync_result = {"added": [], "modified": [], "removed": [], "cursor": item.cursor}
    else:
        sync_result = sync_transactions(client, access_token, item.cursor)

    added_count = 0
    # Hoisted out of the loop: these don't change mid-sync, and querying
    # them once per added transaction made large syncs O(N x rules-query).
    # (The backfill path already does this.)
    category_rules = db.query(CategoryRule).all()
    business_rules = db.query(BusinessRule).order_by(BusinessRule.priority).all()
    for txn in sync_result["added"]:
        txn_id = str(txn["transaction_id"])
        existing = db.query(Transaction).filter_by(plaid_transaction_id=txn_id).first()
        if existing:
            continue
        account = db.query(Account).filter_by(plaid_account_id=str(txn["account_id"])).first()
        if not account:
            continue
        categories = txn.get("personal_finance_category") or {}
        cat_primary = categories.get("primary")
        cat_detailed = categories.get("detailed")
        txn_date = txn["date"]
        if hasattr(txn_date, "isoformat"):
            txn_date = txn_date  # already a date object
        else:
            txn_date = str(txn_date)
        # Auto-map Plaid category to friendly name
        friendly_cat = map_plaid_category(str(cat_primary)) if cat_primary else None
        new_txn = Transaction(
            plaid_transaction_id=txn_id,
            account_id=account.id,
            name=str(txn.get("name", "Unknown")),
            merchant_name=str(txn["merchant_name"]) if txn.get("merchant_name") else None,
            amount=float(txn["amount"]),
            currency=str(txn.get("iso_currency_code", "USD") or "USD"),
            date=txn_date,
            pending=bool(txn.get("pending", False)),
            category=friendly_cat,
            subcategory=str(cat_detailed) if cat_detailed else None,
        )
        # Apply user-defined category rules
        search_text = ((new_txn.merchant_name or "") + " " + (new_txn.name or "")).lower()
        for rule in category_rules:
            if rule.pattern in search_text:
                new_txn.custom_category = rule.category
                break
        # Apply user-defined business rules
        for rule in business_rules:
            if rule.pattern.lower() in search_text:
                new_txn.business_id = rule.business_id
                break
        db.add(new_txn)
        added_count += 1

    for txn in sync_result["modified"]:
        existing = db.query(Transaction).filter_by(plaid_transaction_id=str(txn["transaction_id"])).first()
        if existing:
            existing.amount = float(txn["amount"])
            existing.name = str(txn.get("name", existing.name))
            merchant = txn.get("merchant_name")
            existing.merchant_name = str(merchant) if merchant else existing.merchant_name
            existing.pending = bool(txn.get("pending", existing.pending))
            categories = txn.get("personal_finance_category") or {}
            cat_primary = categories.get("primary")
            cat_detailed = categories.get("detailed")
            existing.category = map_plaid_category(str(cat_primary)) if cat_primary else existing.category
            existing.subcategory = str(cat_detailed) if cat_detailed else existing.subcategory

    for txn in sync_result["removed"]:
        existing = db.query(Transaction).filter_by(plaid_transaction_id=str(txn["transaction_id"])).first()
        if existing:
            db.delete(existing)

    # Update cursor
    item.cursor = sync_result["cursor"]
    db.commit()

    return {
        "added": added_count,
        "modified": len(sync_result["modified"]),
        "removed": len(sync_result["removed"]),
        "investment_transactions_added": inv_added,
        "holdings": holdings_count,
        "liabilities_updated": liabilities_count,
    }


# ---------------------------------------------------------------------------
# Backfill — one-off historical transactions for a date range
# ---------------------------------------------------------------------------

def backfill_transactions(
    db: Session,
    start_date: datetime.date,
    end_date: datetime.date,
    item_id: int | None = None,
) -> dict:
    """Pull missing transactions for [start_date, end_date] from Plaid via
    /transactions/get and insert any that aren't already in the DB.

    Use case: the cursor-based /transactions/sync has already advanced
    past a period (say, January 2026) and you've discovered that month's
    data is incomplete — maybe the bank fed Plaid only partial data at
    the time, maybe a transient sync error caused some adds to be
    dropped before the cursor advanced. This function fills the gap
    without touching the cursor.

    Args:
      db: live session.
      start_date / end_date: inclusive range to query Plaid for.
      item_id: if given, only backfill that one PlaidItem.id; otherwise
        run for every linked item.

    Returns a dict per-item plus a top-level summary so the caller can
    show "Backfilled 47 transactions across 3 institutions" in a UI.

    Idempotent: dedupes by plaid_transaction_id, so re-running the same
    range never double-inserts.
    """
    client = get_plaid_client()
    items = (
        [db.query(PlaidItem).filter_by(id=item_id).first()]
        if item_id is not None
        else db.query(PlaidItem).all()
    )
    items = [i for i in items if i is not None]

    results = []
    total_inserted = 0

    for item in items:
        try:
            # Same lazy re-encryption pattern the regular sync uses.
            if not is_encrypted(item.access_token):
                item.access_token = encrypt_token(item.access_token)
                db.add(item)
                db.flush()
            access_token = decrypt_token(item.access_token)

            # Skip pure-investment items — /transactions/get returns
            # NO_ACCOUNTS for them, same as /transactions/sync.
            account_types = {
                a.type
                for a in db.query(Account).filter_by(plaid_item_id=item.id).all()
            }
            if not (account_types - INVESTMENT_ACCOUNT_TYPES):
                results.append({
                    "item_id": item.item_id,
                    "institution": item.institution_name,
                    "status": "skipped",
                    "reason": "investment-only item",
                    "inserted": 0,
                })
                continue

            txns = get_transactions_range(client, access_token, start_date, end_date)

            # Pre-load existing plaid_transaction_ids in this date range
            # so the dedupe check is a hash hit rather than a per-row
            # SELECT — Plaid can return hundreds in a 1-month window.
            existing_ids = {
                t.plaid_transaction_id
                for t in db.query(Transaction.plaid_transaction_id)
                .filter(
                    Transaction.date >= start_date,
                    Transaction.date <= end_date,
                )
                .all()
            }

            # Apply category rules once per backfill instead of per row
            # (matches the optimization done elsewhere). Pre-fetched here
            # because rules don't change during the backfill loop.
            rules = db.query(CategoryRule).all()

            inserted_here = 0
            for txn in txns:
                txn_id = str(txn["transaction_id"])
                if txn_id in existing_ids:
                    continue
                account = db.query(Account).filter_by(
                    plaid_account_id=str(txn["account_id"])
                ).first()
                if not account:
                    continue
                categories = txn.get("personal_finance_category") or {}
                cat_primary = categories.get("primary")
                cat_detailed = categories.get("detailed")
                friendly_cat = (
                    map_plaid_category(str(cat_primary)) if cat_primary else None
                )
                txn_date = txn["date"]
                if not hasattr(txn_date, "isoformat"):
                    txn_date = datetime.date.fromisoformat(str(txn_date))

                new_txn = Transaction(
                    plaid_transaction_id=txn_id,
                    account_id=account.id,
                    name=str(txn.get("name", "Unknown")),
                    merchant_name=str(txn["merchant_name"]) if txn.get("merchant_name") else None,
                    amount=float(txn["amount"]),
                    currency=str(txn.get("iso_currency_code", "USD") or "USD"),
                    date=txn_date,
                    pending=bool(txn.get("pending", False)),
                    category=friendly_cat,
                    subcategory=str(cat_detailed) if cat_detailed else None,
                )
                # Apply rules
                search_text = ((new_txn.merchant_name or "") + " " + (new_txn.name or "")).lower()
                for rule in rules:
                    if rule.pattern in search_text:
                        new_txn.custom_category = rule.category
                        break
                db.add(new_txn)
                existing_ids.add(txn_id)  # guard against Plaid duplicates within a single response
                inserted_here += 1

            db.commit()
            total_inserted += inserted_here
            results.append({
                "item_id": item.item_id,
                "institution": item.institution_name,
                "status": "ok",
                "fetched": len(txns),
                "inserted": inserted_here,
                "skipped_existing": len(txns) - inserted_here,
            })
        except Exception as e:  # noqa: BLE001
            db.rollback()
            results.append({
                "item_id": item.item_id,
                "institution": item.institution_name,
                "status": "error",
                "error": parse_plaid_error(e),
                "inserted": 0,
            })

    # Re-run transfer detection so newly-inserted rows get classified
    # alongside the existing dataset.
    if total_inserted > 0:
        try:
            from app.services.transfer_detector import detect_transfers
            detect_transfers(db)
        except Exception as e:  # noqa: BLE001
            log.warning("transfer detection after backfill failed: %s", e)

    return {
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "total_inserted": total_inserted,
        "items": results,
    }


# ---------------------------------------------------------------------------
# Investments
# ---------------------------------------------------------------------------

def _upsert_security(db: Session, plaid_sec: dict) -> Security:
    """Upsert a Plaid security into our Security table and return the row."""
    sec_id = str(plaid_sec["security_id"])
    sec = db.query(Security).filter_by(plaid_security_id=sec_id).first()
    if not sec:
        sec = Security(plaid_security_id=sec_id)
        db.add(sec)

    # Plaid types are enum-like; coerce to plain strings.
    sec.ticker_symbol = str(plaid_sec["ticker_symbol"]) if plaid_sec.get("ticker_symbol") else None
    sec.name = str(plaid_sec["name"]) if plaid_sec.get("name") else None
    sec.type = str(plaid_sec["type"]) if plaid_sec.get("type") else None
    sec.iso_currency_code = str(plaid_sec["iso_currency_code"]) if plaid_sec.get("iso_currency_code") else None
    sec.cusip = str(plaid_sec["cusip"]) if plaid_sec.get("cusip") else None
    sec.isin = str(plaid_sec["isin"]) if plaid_sec.get("isin") else None
    sec.institution_security_id = (
        str(plaid_sec["institution_security_id"]) if plaid_sec.get("institution_security_id") else None
    )
    sec.institution_id = str(plaid_sec["institution_id"]) if plaid_sec.get("institution_id") else None
    sec.close_price = float(plaid_sec["close_price"]) if plaid_sec.get("close_price") is not None else None
    close_as_of = plaid_sec.get("close_price_as_of")
    if close_as_of and hasattr(close_as_of, "isoformat"):
        sec.close_price_as_of = datetime.datetime.combine(close_as_of, datetime.time.min)
    sec.is_cash_equivalent = bool(plaid_sec.get("is_cash_equivalent", False))
    return sec


def _sync_investments(db: Session, client, access_token: str, item: PlaidItem) -> tuple[int, int]:
    """Refresh holdings and pull investment transactions for this item.

    Holdings are a full-state snapshot: Plaid returns every current position,
    so we upsert them all and delete any local holding for this item's
    accounts that didn't appear in the response.

    Investment transactions are pulled for the last ~2 years on first sync
    (Plaid's maximum), then just the last 30 days on subsequent syncs. We
    rely on the unique plaid_investment_transaction_id index to dedupe.
    """
    # 1) Upsert holdings + their referenced securities.
    holdings_data = get_investments_holdings(client, access_token)

    for plaid_sec in holdings_data["securities"]:
        _upsert_security(db, plaid_sec)
    db.flush()

    # Map Plaid account_id -> our internal Account.id, scoped to this item.
    item_accounts = {
        a.plaid_account_id: a
        for a in db.query(Account).filter_by(plaid_item_id=item.id).all()
    }

    # Track which accounts Plaid returned holdings for, AND how many.
    # The two-set design lets us defensibly delete stale holdings only
    # for accounts Plaid actually responded with — if Plaid returns a
    # partial response (e.g. cash-only because the holdings call timed
    # out partway through), we DON'T wipe the missing accounts'
    # positions. Old behavior nuked everything on any partial response,
    # which is how stock positions could vanish from a brokerage that
    # was clearly active.
    seen_holding_keys: set[tuple[int, str]] = set()
    accounts_with_holdings: set[int] = set()  # accounts Plaid returned ANY holding for
    holding_counts_per_account: dict[int, int] = {}
    for ph in holdings_data["holdings"]:
        plaid_acct_id = str(ph["account_id"])
        account = item_accounts.get(plaid_acct_id)
        if not account:
            continue
        sec_id = str(ph["security_id"])
        key = (account.id, sec_id)
        seen_holding_keys.add(key)
        accounts_with_holdings.add(account.id)
        holding_counts_per_account[account.id] = holding_counts_per_account.get(account.id, 0) + 1
        holding = db.query(Holding).filter_by(account_id=account.id, plaid_security_id=sec_id).first()
        if not holding:
            holding = Holding(account_id=account.id, plaid_security_id=sec_id)
            db.add(holding)
        holding.quantity = float(ph["quantity"]) if ph.get("quantity") is not None else 0.0
        holding.institution_price = (
            float(ph["institution_price"]) if ph.get("institution_price") is not None else None
        )
        inst_as_of = ph.get("institution_price_as_of")
        if inst_as_of and hasattr(inst_as_of, "isoformat"):
            holding.institution_price_as_of = datetime.datetime.combine(inst_as_of, datetime.time.min)
        holding.institution_value = (
            float(ph["institution_value"]) if ph.get("institution_value") is not None else None
        )
        holding.cost_basis = float(ph["cost_basis"]) if ph.get("cost_basis") is not None else None
        holding.iso_currency_code = (
            str(ph["iso_currency_code"]) if ph.get("iso_currency_code") else None
        )

    # Delete stale holdings ONLY for accounts that Plaid actually returned
    # at least one holding for. Skipping accounts that had zero holdings
    # in the response prevents the "Plaid hiccup wipes the portfolio"
    # failure mode. Trade-off: a position truly sold to zero won't be
    # removed until the next sync where Plaid returns at least one OTHER
    # holding for that same account (which is the common case — even
    # after selling all positions you'll have a cash sweep entry).
    for acct_id in accounts_with_holdings:
        stale = (
            db.query(Holding)
            .filter(Holding.account_id == acct_id)
            .all()
        )
        for h in stale:
            if (h.account_id, h.plaid_security_id) not in seen_holding_keys:
                db.delete(h)

    # Warn loudly when a previously-active account suddenly has very
    # few holdings — strong signal of a partial Plaid response that's
    # about to wipe the user's view of their portfolio.
    for acct_id, returned_count in holding_counts_per_account.items():
        if returned_count <= 1:
            # Count what's currently stored for context in the log.
            existing = db.query(Holding).filter_by(account_id=acct_id).count()
            if existing > 5:
                log.warning(
                    "Holdings sync for account %s returned only %d holding(s); "
                    "previously had %d. Possible partial Plaid response — "
                    "leaving existing holdings in place.",
                    acct_id, returned_count, existing,
                )

    db.flush()
    holdings_count = len(seen_holding_keys)

    # 2) Pull investment transactions. First run: go back 2 years. Subsequent
    #    runs: last 30 days is plenty for catching new activity, since we
    #    dedupe on plaid_investment_transaction_id.
    today = datetime.date.today()
    has_any_inv_txn = (
        db.query(InvestmentTransaction)
        .filter(InvestmentTransaction.account_id.in_([a.id for a in item_accounts.values()]))
        .first()
        is not None
    )
    start_date = today - datetime.timedelta(days=730 if not has_any_inv_txn else 30)

    inv_data = get_investments_transactions(client, access_token, start_date, today)
    # Securities returned here can differ from holdings securities (e.g. sold positions);
    # upsert those too so investment_transactions always have a referenced security.
    for plaid_sec in inv_data["securities"]:
        _upsert_security(db, plaid_sec)
    db.flush()

    inv_added = 0
    for it in inv_data["investment_transactions"]:
        txn_id = str(it["investment_transaction_id"])
        existing = db.query(InvestmentTransaction).filter_by(plaid_investment_transaction_id=txn_id).first()
        if existing:
            # Update mutable fields in case Plaid adjusted them (pending → posted, etc.)
            existing.pending = bool(it.get("pending", existing.pending))
            existing.amount = float(it["amount"]) if it.get("amount") is not None else existing.amount
            continue
        plaid_acct_id = str(it["account_id"])
        account = item_accounts.get(plaid_acct_id)
        if not account:
            continue
        txn_date = it["date"]
        if not hasattr(txn_date, "isoformat"):
            txn_date = datetime.date.fromisoformat(str(txn_date))
        sec_id = it.get("security_id")
        new_inv = InvestmentTransaction(
            plaid_investment_transaction_id=txn_id,
            account_id=account.id,
            plaid_security_id=str(sec_id) if sec_id else None,
            date=txn_date,
            name=str(it["name"]) if it.get("name") else None,
            type=str(it["type"]) if it.get("type") else None,
            subtype=str(it["subtype"]) if it.get("subtype") else None,
            quantity=float(it["quantity"]) if it.get("quantity") is not None else None,
            price=float(it["price"]) if it.get("price") is not None else None,
            amount=float(it["amount"]) if it.get("amount") is not None else None,
            fees=float(it["fees"]) if it.get("fees") is not None else None,
            iso_currency_code=str(it["iso_currency_code"]) if it.get("iso_currency_code") else None,
            cancel_transaction_id=(
                str(it["cancel_transaction_id"]) if it.get("cancel_transaction_id") else None
            ),
            pending=bool(it.get("pending", False)),
        )
        db.add(new_inv)
        inv_added += 1

    db.flush()
    return inv_added, holdings_count


# ---------------------------------------------------------------------------
# Liabilities (mortgage + credit card detail)
# ---------------------------------------------------------------------------

def _coerce_date(val):
    """Plaid sometimes ships dates as datetime.date, sometimes as string.
    Returns None for any value that isn't a parseable date."""
    if val is None:
        return None
    if isinstance(val, datetime.date) and not isinstance(val, datetime.datetime):
        return val
    if isinstance(val, datetime.datetime):
        return val.date()
    try:
        return datetime.date.fromisoformat(str(val))
    except (TypeError, ValueError):
        return None


def _sync_liabilities(db: Session, client, access_token: str, item: PlaidItem) -> int:
    """Refresh mortgage_details and credit_card_details for this item.

    Returns the number of liability rows upserted (mortgages + credit cards).
    Student loans are returned by the API but not yet stored — easy to add
    later when needed.
    """
    data = get_liabilities(client, access_token)
    liab = data.get("liabilities") or {}

    # Map Plaid account_id -> internal Account row, scoped to this item.
    item_accounts = {
        a.plaid_account_id: a
        for a in db.query(Account).filter_by(plaid_item_id=item.id).all()
    }

    upserted = 0

    # --- Mortgages ---
    for m in liab.get("mortgage", []) or []:
        plaid_acct_id = str(m["account_id"])
        account = item_accounts.get(plaid_acct_id)
        if not account:
            continue

        detail = (
            db.query(MortgageDetail).filter_by(account_id=account.id).first()
        )
        if not detail:
            detail = MortgageDetail(account_id=account.id)
            db.add(detail)

        detail.account_number = str(m["account_number"]) if m.get("account_number") else None

        # Plaid's interest_rate field is an object: {percentage, type}
        rate = m.get("interest_rate") or {}
        if rate:
            pct = rate.get("percentage")
            detail.interest_rate_percentage = float(pct) if pct is not None else None
            rtype = rate.get("type")
            detail.interest_rate_type = str(rtype) if rtype else None

        detail.loan_term = str(m["loan_term"]) if m.get("loan_term") else None
        detail.loan_type_description = (
            str(m["loan_type_description"]) if m.get("loan_type_description") else None
        )
        detail.origination_date = _coerce_date(m.get("origination_date"))
        opa = m.get("origination_principal_amount")
        detail.origination_principal_amount = float(opa) if opa is not None else None
        detail.maturity_date = _coerce_date(m.get("maturity_date"))

        nmp = m.get("next_monthly_payment")
        detail.next_monthly_payment = float(nmp) if nmp is not None else None
        detail.next_payment_due_date = _coerce_date(m.get("next_payment_due_date"))
        lpa = m.get("last_payment_amount")
        detail.last_payment_amount = float(lpa) if lpa is not None else None
        detail.last_payment_date = _coerce_date(m.get("last_payment_date"))
        pda = m.get("past_due_amount")
        detail.past_due_amount = float(pda) if pda is not None else None
        clf = m.get("current_late_fee")
        detail.current_late_fee = float(clf) if clf is not None else None

        ytd_int = m.get("ytd_interest_paid")
        detail.ytd_interest_paid = float(ytd_int) if ytd_int is not None else None
        ytd_pri = m.get("ytd_principal_paid")
        detail.ytd_principal_paid = float(ytd_pri) if ytd_pri is not None else None

        eb = m.get("escrow_balance")
        detail.escrow_balance = float(eb) if eb is not None else None
        if "has_pmi" in m:
            detail.has_pmi = bool(m["has_pmi"]) if m["has_pmi"] is not None else None
        if "has_prepayment_penalty" in m:
            detail.has_prepayment_penalty = (
                bool(m["has_prepayment_penalty"]) if m["has_prepayment_penalty"] is not None else None
            )

        addr = m.get("property_address") or {}
        if addr:
            detail.property_street = str(addr["street"]) if addr.get("street") else None
            detail.property_city = str(addr["city"]) if addr.get("city") else None
            detail.property_region = str(addr["region"]) if addr.get("region") else None
            detail.property_postal_code = (
                str(addr["postal_code"]) if addr.get("postal_code") else None
            )
            detail.property_country = str(addr["country"]) if addr.get("country") else None

        upserted += 1

    # --- Credit cards ---
    for c in liab.get("credit", []) or []:
        plaid_acct_id = str(c["account_id"])
        account = item_accounts.get(plaid_acct_id)
        if not account:
            continue

        detail = (
            db.query(CreditCardDetail).filter_by(account_id=account.id).first()
        )
        if not detail:
            detail = CreditCardDetail(account_id=account.id)
            db.add(detail)

        # APRs come as a list of structured dicts; serialize the relevant
        # fields. We only keep what's useful for display.
        aprs = c.get("aprs") or []
        detail.aprs = [
            {
                "apr_percentage": (
                    float(a["apr_percentage"]) if a.get("apr_percentage") is not None else None
                ),
                "apr_type": str(a["apr_type"]) if a.get("apr_type") else None,
                "balance_subject_to_apr": (
                    float(a["balance_subject_to_apr"])
                    if a.get("balance_subject_to_apr") is not None else None
                ),
                "interest_charge_amount": (
                    float(a["interest_charge_amount"])
                    if a.get("interest_charge_amount") is not None else None
                ),
            }
            for a in aprs
        ]

        if "is_overdue" in c:
            detail.is_overdue = bool(c["is_overdue"]) if c["is_overdue"] is not None else None

        lsb = c.get("last_statement_balance")
        detail.last_statement_balance = float(lsb) if lsb is not None else None
        detail.last_statement_issue_date = _coerce_date(c.get("last_statement_issue_date"))
        lpa = c.get("last_payment_amount")
        detail.last_payment_amount = float(lpa) if lpa is not None else None
        detail.last_payment_date = _coerce_date(c.get("last_payment_date"))
        mpa = c.get("minimum_payment_amount")
        detail.minimum_payment_amount = float(mpa) if mpa is not None else None
        detail.next_payment_due_date = _coerce_date(c.get("next_payment_due_date"))

        upserted += 1

    db.flush()
    return upserted


def take_net_worth_snapshot(db: Session):
    """Calculate and store a net worth snapshot for today.

    Includes both Plaid-synced accounts (depository / investment as assets,
    credit / loan as liabilities) AND user-tracked manual assets (homes,
    vehicles, etc.) which always count as assets.
    """
    from app.models import ManualAsset
    today = datetime.date.today()
    accounts = db.query(Account).all()
    manual_assets = db.query(ManualAsset).all()

    total_assets = 0.0
    total_liabilities = 0.0
    balances = {}

    for acc in accounts:
        balances[str(acc.id)] = acc.current_balance
        if acc.type in ("depository", "investment"):
            total_assets += acc.current_balance
        elif acc.type in ("credit", "loan"):
            total_liabilities += abs(acc.current_balance)

    for ma in manual_assets:
        # Namespace manual asset balances under "manual:<id>" so they don't
        # collide with the integer account ids in the same dict. Route to
        # assets or liabilities based on `side`.
        balances[f"manual:{ma.id}"] = ma.current_value
        if (ma.side or "asset") == "liability":
            total_liabilities += abs(ma.current_value or 0.0)
        else:
            total_assets += ma.current_value or 0.0

    snapshot = db.query(NetWorthSnapshot).filter_by(date=today).first()
    if not snapshot:
        snapshot = NetWorthSnapshot(date=today)
        db.add(snapshot)

    snapshot.total_assets = total_assets
    snapshot.total_liabilities = total_liabilities
    snapshot.net_worth = total_assets - total_liabilities
    snapshot.account_balances = balances
    db.commit()
