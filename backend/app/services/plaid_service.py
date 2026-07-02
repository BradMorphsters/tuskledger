"""Plaid API integration service."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

import plaid
from plaid.api import plaid_api
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.transactions_sync_request import TransactionsSyncRequest
from plaid.model.transactions_get_request import TransactionsGetRequest
from plaid.model.transactions_get_request_options import TransactionsGetRequestOptions
from plaid.model.accounts_get_request import AccountsGetRequest
from plaid.model.investments_holdings_get_request import InvestmentsHoldingsGetRequest
from plaid.model.investments_transactions_get_request import InvestmentsTransactionsGetRequest
from plaid.model.investments_transactions_get_request_options import InvestmentsTransactionsGetRequestOptions
from plaid.model.liabilities_get_request import LiabilitiesGetRequest
from plaid.model.products import Products
from plaid.model.country_code import CountryCode
from app.config import settings


def get_plaid_client() -> plaid_api.PlaidApi:
    env_map = {
        "sandbox": "https://sandbox.plaid.com",
        "development": "https://development.plaid.com",
        "production": "https://production.plaid.com",
    }
    configuration = plaid.Configuration(
        host=env_map.get(settings.PLAID_ENV, "https://sandbox.plaid.com"),
        api_key={
            "clientId": settings.PLAID_CLIENT_ID,
            "secret": settings.PLAID_SECRET,
        },
    )
    api_client = plaid.ApiClient(configuration)
    return plaid_api.PlaidApi(api_client)


def create_link_token(client: plaid_api.PlaidApi) -> str:
    """Create a Plaid Link token for the frontend to initialize Link.

    Products strategy:
      - **required** (``products``): transactions — essentially every
        consumer bank has at least one transactions-eligible account, so
        requiring it doesn't block any normal link.
      - **optional** (``optional_products``): investments, liabilities —
        enrich items that have them (Merrill 401k gives holdings; Wells
        Fargo mortgage gives rate/escrow/payment detail), but don't
        block items that don't. A checking-only bank won't error on the
        "No investment accounts" guard, a mortgage-only bank won't error
        on "No investment accounts", etc.

    Plaid only charges for products actually used per-item, so listing
    optionals is free for items that don't exercise them.
    """
    # Pass phone_number_verified_time to skip phone verification in sandbox
    user = LinkTokenCreateRequestUser(
        client_user_id="fintrack-user",
        phone_number_verified_time=datetime.now(timezone.utc),
    )
    request = LinkTokenCreateRequest(
        user=user,
        client_name="Tusk Ledger",
        products=[Products("transactions")],
        optional_products=[
            Products("investments"),
            Products("liabilities"),
        ],
        country_codes=[CountryCode("US")],
        language="en",
    )
    response = client.link_token_create(request)
    return response["link_token"]


def exchange_public_token(client: plaid_api.PlaidApi, public_token: str) -> dict:
    """Exchange a public token from Link for a persistent access token."""
    request = ItemPublicTokenExchangeRequest(public_token=public_token)
    response = client.item_public_token_exchange(request)
    return {
        "access_token": response["access_token"],
        "item_id": response["item_id"],
    }


def sync_transactions(client: plaid_api.PlaidApi, access_token: str, cursor: Optional[str] = None) -> dict:
    """Use the transactions/sync endpoint to get new, modified, and removed transactions."""
    added = []
    modified = []
    removed = []
    has_more = True
    next_cursor = cursor or ""

    while has_more:
        request = TransactionsSyncRequest(
            access_token=access_token,
            cursor=next_cursor,
        )
        response = client.transactions_sync(request)
        added.extend(response["added"])
        modified.extend(response["modified"])
        removed.extend(response["removed"])
        has_more = response["has_more"]
        next_cursor = response["next_cursor"]

    return {
        "added": added,
        "modified": modified,
        "removed": removed,
        "cursor": next_cursor,
    }


def parse_plaid_error(exc: Exception) -> dict:
    """Extract Plaid's structured error fields from an SDK exception.

    Plaid's ApiException carries the JSON error body in `exc.body`. The
    default str(exc) dumps the entire HTTP transcript (status line,
    headers, body) — useful for debugging in logs but unreadable as a
    user-facing message. This function picks out the meaningful bits so
    callers can return a clean error to the UI.

    Returns a dict with whichever fields Plaid included; never raises.
    """
    body = getattr(exc, "body", None)
    if body:
        try:
            import json
            data = json.loads(body) if isinstance(body, (str, bytes)) else body
            if isinstance(data, dict):
                # Keep only the fields a user/UI actually cares about.
                # error_code is the stable identifier we can pattern-match
                # on (PRODUCTS_NOT_SUPPORTED etc.); error_message is the
                # human-readable explanation Plaid wrote.
                return {
                    "code": data.get("error_code"),
                    "type": data.get("error_type"),
                    "message": data.get("error_message"),
                    "display_message": data.get("display_message"),
                    "suggested_action": data.get("suggested_action"),
                    "request_id": data.get("request_id"),
                }
        except Exception:  # noqa: BLE001
            pass
    # Fallback: unknown exception type, or Plaid changed its response shape.
    # Truncate so a runaway stack trace doesn't bloat the response.
    return {"code": None, "message": str(exc)[:200]}


def get_transactions_range(
    client: plaid_api.PlaidApi,
    access_token: str,
    start_date,
    end_date,
) -> list:
    """One-off historical pull via /transactions/get.

    Use case: backfilling a specific date range that /transactions/sync
    has already advanced past. The cursor stays untouched — this endpoint
    is independent of the sync state machine.

    Returns a list of transaction dicts in the same shape as sync's
    `added` list, so the caller can reuse the existing insert logic.

    Why not just use /transactions/sync? Once Plaid has handed you a
    cursor and you've advanced past the period in question, sync won't
    re-deliver those transactions unless they're modified. /transactions/get
    is the surgical tool for filling a gap after the fact.

    Plaid caps each /transactions/get response at 500 transactions; we
    paginate via offset + count until we've fetched total_transactions.
    For a single month on a single account, almost always one page.
    """
    PAGE_SIZE = 500
    all_txns: list = []
    offset = 0

    while True:
        opts = TransactionsGetRequestOptions(count=PAGE_SIZE, offset=offset)
        request = TransactionsGetRequest(
            access_token=access_token,
            start_date=start_date,
            end_date=end_date,
            options=opts,
        )
        response = client.transactions_get(request)
        page = response["transactions"]
        all_txns.extend(page)

        total = response.get("total_transactions", len(all_txns))
        # Stop when we've collected everything Plaid says exists for this
        # window, OR when the institution returned an empty page (defensive
        # against off-by-one bugs in the count field).
        if not page or len(all_txns) >= total:
            break
        offset = len(all_txns)

    return all_txns


def get_investments_holdings(client: plaid_api.PlaidApi, access_token: str) -> dict:
    """Fetch current holdings and the securities that back them.

    Returns {"accounts": [...], "holdings": [...], "securities": [...]} with
    the shapes Plaid returns directly. If the item doesn't have any investment
    accounts, Plaid raises PRODUCT_NOT_READY or NO_INVESTMENT_ACCOUNTS — we
    let callers decide whether that's fatal (it isn't).
    """
    request = InvestmentsHoldingsGetRequest(access_token=access_token)
    response = client.investments_holdings_get(request)
    return {
        "accounts": response["accounts"],
        "holdings": response["holdings"],
        "securities": response["securities"],
    }


def get_investments_transactions(
    client: plaid_api.PlaidApi,
    access_token: str,
    start_date,
    end_date,
    account_ids: Optional[List[str]] = None,
) -> dict:
    """Fetch investment transactions in [start_date, end_date].

    Plaid paginates via offset; we fold all pages together. account_ids filters
    to specific investment accounts under the item when provided.
    """
    all_txns = []
    securities = []
    offset = 0
    total_transactions = None

    while True:
        options_kwargs = {"offset": offset, "count": 500}
        if account_ids:
            options_kwargs["account_ids"] = account_ids
        request = InvestmentsTransactionsGetRequest(
            access_token=access_token,
            start_date=start_date,
            end_date=end_date,
            options=InvestmentsTransactionsGetRequestOptions(**options_kwargs),
        )
        response = client.investments_transactions_get(request)
        page = response["investment_transactions"]
        # Defensive against an empty page paired with an inflated
        # `total_investment_transactions`: without this, offset never
        # advances past the (already-collected) count and we loop forever.
        # Mirrors the empty-page guard in get_transactions_range above.
        if not page:
            break
        all_txns.extend(page)
        # Securities are returned alongside; merge and de-dupe by plaid_security_id.
        for sec in response["securities"]:
            securities.append(sec)
        total_transactions = response["total_investment_transactions"]
        offset = len(all_txns)
        if offset >= total_transactions:
            break

    # De-dupe securities by id (later pages often repeat the same list).
    seen = set()
    unique_securities = []
    for sec in securities:
        sid = str(sec["security_id"])
        if sid in seen:
            continue
        seen.add(sid)
        unique_securities.append(sec)

    return {
        "investment_transactions": all_txns,
        "securities": unique_securities,
    }


def get_liabilities(client: plaid_api.PlaidApi, access_token: str) -> dict:
    """Fetch credit-card, mortgage, and student-loan liability detail.

    Returns the raw Plaid response shape:
      {"accounts": [...], "liabilities": {"credit": [...], "mortgage": [...], "student": [...]}}

    **Why we bypass the SDK here:** plaid-python's OpenAPI-generated
    response models enforce strict type validation. Plaid's actual
    production responses for some institutions (notably Wells Fargo
    mortgages) include `null` for fields the spec marks as required
    (`mortgage[].account_number`). The SDK raises ``ApiTypeError`` on
    those payloads even though the rest of the response is well-formed.
    POSTing to /liabilities/get directly and parsing the JSON ourselves
    sidesteps that validation entirely. Downstream code already iterates
    via dict access, so plain dicts work in place of the SDK's typed
    objects with no further changes.

    Some items genuinely lack liability data (checking-only banks);
    callers should treat NO_LIABILITY_ACCOUNTS / PRODUCT_NOT_READY as
    non-fatal and just skip the item this cycle.
    """
    # `client` is unused but kept in the signature so the existing call
    # sites in sync_service don't have to change. The pattern mirrors
    # other helpers in this module.
    _ = client

    # Use stdlib urllib rather than `requests` so this doesn't add a
    # new pip dependency to the Tusk Ledger venv.
    import json as _json
    import urllib.request
    import urllib.error
    env_map = {
        "sandbox": "https://sandbox.plaid.com",
        "development": "https://development.plaid.com",
        "production": "https://production.plaid.com",
    }
    host = env_map.get(settings.PLAID_ENV, "https://sandbox.plaid.com")
    payload = _json.dumps({
        "client_id": settings.PLAID_CLIENT_ID,
        "secret": settings.PLAID_SECRET,
        "access_token": access_token,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{host}/liabilities/get",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = _json.loads(resp.read())
    except urllib.error.HTTPError as e:
        # Plaid returns structured error JSON on 400s. Surface a
        # readable error so existing logging stays useful (mirrors
        # what the SDK's ApiException would have given us).
        body = e.read().decode("utf-8", errors="replace")
        try:
            err = _json.loads(body)
            raise RuntimeError(
                f"Plaid /liabilities/get {e.code}: "
                f"{err.get('error_code', '?')} — {err.get('error_message', '?')}"
            )
        except ValueError:
            raise RuntimeError(f"Plaid /liabilities/get {e.code}: {body[:300]}")

    return {
        "accounts": data.get("accounts", []),
        "liabilities": data.get("liabilities", {}),
    }


def get_account_balances(client: plaid_api.PlaidApi, access_token: str) -> list:
    """Fetch current accounts + cached balances for an item.

    Uses /accounts/get (included with the Transactions product) rather than
    /accounts/balance/get, which requires the paid Balance product and 400s
    with INVALID_PRODUCT if it isn't enabled on the client. Balance data
    shape is identical; only freshness differs — /accounts/get returns the
    last cached balances from Plaid rather than forcing a live refresh.
    """
    request = AccountsGetRequest(access_token=access_token)
    response = client.accounts_get(request)
    return response["accounts"]
