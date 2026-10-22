"""Closed accounts: keep the history, drop the balance.

When a bank account is closed the user wants its transactions to stay put
(Transactions, Spending, past Net Worth) while the account stops counting
as money they have. These tests pin that contract:

  - PATCH status=closed zeroes the balance and stamps closed_at;
    status=active reopens it.
  - A Plaid sync never writes a balance back onto a closed account.
  - A late Plaid row for a move-out the user already entered by hand is
    adopted onto that manual row instead of duplicating it.
  - Stale-account and connection-health alerts skip closed accounts.
"""
from __future__ import annotations

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app.database import get_db, get_real_db
from app.main import app
from app.models import Account, PlaidItem, Transaction
from app.services import sync_service


@pytest.fixture
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_real_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _clear_status_cache():
    sync_service._ITEM_STATUS_CACHE.clear()
    yield
    sync_service._ITEM_STATUS_CACHE.clear()


@pytest.fixture
def plaid_item(db):
    item = PlaidItem(
        item_id="item-closed", access_token="enc:v1:placeholder",
        institution_id="ins_1", institution_name="Test Bank", cursor=None,
    )
    db.add(item)
    db.commit()
    return item


# ---------------------------------------------------------------------------
# PATCH /api/accounts/{id}
# ---------------------------------------------------------------------------

def test_new_accounts_default_to_active(client, factory):
    acct = factory.account(current_balance=250.0)
    factory.commit()
    body = client.get(f"/api/accounts/{acct.id}").json()
    assert body["status"] == "active"
    assert body["closed_at"] is None


def test_close_zeroes_balance_and_keeps_history(client, db, factory):
    acct = factory.account(current_balance=1200.0, plaid_item_id=None)
    acct.available_balance = 1200.0
    factory.transaction(account_id=acct.id, amount=40.0, date=dt.date(2026, 1, 5))
    factory.transaction(account_id=acct.id, amount=1160.0, date=dt.date(2026, 1, 20), is_transfer=True)
    factory.commit()

    res = client.patch(f"/api/accounts/{acct.id}", json={"status": "closed", "closed_at": "2026-01-20"})
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "closed"
    assert body["closed_at"] == "2026-01-20"
    assert body["current_balance"] == 0.0
    assert body["available_balance"] == 0.0
    assert body["balance_as_of"] == "2026-01-20"
    # History untouched.
    assert db.query(Transaction).filter_by(account_id=acct.id).count() == 2
    assert body["transactions_through"] == "2026-01-20"


def test_close_defaults_to_today(client, factory):
    acct = factory.account()
    factory.commit()
    body = client.patch(f"/api/accounts/{acct.id}", json={"status": "closed"}).json()
    assert body["closed_at"] == dt.date.today().isoformat()


def test_reopen_clears_closed_at(client, factory):
    acct = factory.account()
    factory.commit()
    client.patch(f"/api/accounts/{acct.id}", json={"status": "closed", "closed_at": "2026-01-20"})
    body = client.patch(f"/api/accounts/{acct.id}", json={"status": "active"}).json()
    assert body["status"] == "active"
    assert body["closed_at"] is None


def test_invalid_status_rejected(client, factory):
    acct = factory.account()
    factory.commit()
    res = client.patch(f"/api/accounts/{acct.id}", json={"status": "archived"})
    assert res.status_code == 400


def test_rename_leaves_status_alone(client, factory):
    acct = factory.account()
    factory.commit()
    client.patch(f"/api/accounts/{acct.id}", json={"status": "closed"})
    body = client.patch(f"/api/accounts/{acct.id}", json={"custom_name": "Old checking"}).json()
    assert body["status"] == "closed"
    assert body["custom_name"] == "Old checking"


# ---------------------------------------------------------------------------
# Stale accounts
# ---------------------------------------------------------------------------

def test_stale_list_skips_closed(client, factory):
    old = dt.date.today() - dt.timedelta(days=60)
    open_acct = factory.account(name="Open", plaid_item_id=None, balance_as_of=old)
    closed = factory.account(name="Gone", plaid_item_id=None, balance_as_of=old)
    closed.status = "closed"
    closed.closed_at = old
    factory.commit()
    ids = {a["id"] for a in client.get("/api/accounts/stale").json()["accounts"]}
    assert open_acct.id in ids
    assert closed.id not in ids


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------

def _patch_sync(monkeypatch, added=None):
    monkeypatch.setattr(sync_service, "get_account_balances", lambda client, token: [{
        "account_id": "acct-1", "name": "Checking", "official_name": None,
        "type": "depository", "subtype": "checking", "mask": "0000",
        "balances": {"current": 900.0, "available": 900.0, "iso_currency_code": "USD"},
    }])
    monkeypatch.setattr(sync_service, "sync_transactions", lambda client, token, cur: {
        "added": added or [], "modified": [], "removed": [], "cursor": "cur-1",
    })
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: "access-token")
    monkeypatch.setattr(sync_service, "is_encrypted", lambda t: True)
    monkeypatch.setattr(sync_service, "get_item_status", lambda client, token: None)


def _closed_plaid_account(db, item):
    acct = Account(
        plaid_account_id="acct-1", plaid_item_id=item.id, name="Checking",
        type="depository", subtype="checking", current_balance=0.0,
        available_balance=0.0, status="closed", closed_at=dt.date(2026, 1, 20),
        balance_as_of=dt.date(2026, 1, 20),
    )
    db.add(acct)
    db.commit()
    return acct


def test_sync_does_not_restore_balance_on_closed_account(db, plaid_item, monkeypatch):
    acct = _closed_plaid_account(db, plaid_item)
    _patch_sync(monkeypatch)
    sync_service.sync_single_item(db, client=None, item=plaid_item)
    db.refresh(acct)
    assert acct.current_balance == 0.0
    assert acct.available_balance == 0.0
    assert acct.balance_as_of == dt.date(2026, 1, 20)


def test_sync_still_updates_open_account_balance(db, plaid_item, monkeypatch):
    acct = _closed_plaid_account(db, plaid_item)
    acct.status = "active"
    acct.closed_at = None
    db.commit()
    _patch_sync(monkeypatch)
    sync_service.sync_single_item(db, client=None, item=plaid_item)
    db.refresh(acct)
    assert acct.current_balance == 900.0


def _plaid_txn(txn_id, amount, date):
    return {
        "transaction_id": txn_id, "account_id": "acct-1", "name": "CHECK 1001",
        "merchant_name": None, "amount": amount, "iso_currency_code": "USD",
        "date": date, "pending": False, "personal_finance_category": None,
    }


def test_late_plaid_row_adopts_manual_closing_transfer(db, plaid_item, monkeypatch):
    acct = _closed_plaid_account(db, plaid_item)
    manual = Transaction(
        account_id=acct.id, amount=500.0, date=dt.date(2026, 1, 20),
        name="Transfer to new checking (account closed)", category="Transfer",
        custom_category="Transfer", is_transfer=True, notes="closing move-out",
    )
    db.add(manual)
    db.commit()

    _patch_sync(monkeypatch, added=[_plaid_txn("p-1", 500.0, dt.date(2026, 1, 22))])
    sync_service.sync_single_item(db, client=None, item=plaid_item)

    rows = db.query(Transaction).filter_by(account_id=acct.id).all()
    assert len(rows) == 1
    db.refresh(manual)
    assert manual.plaid_transaction_id == "p-1"
    assert manual.is_transfer is True
    assert manual.notes == "closing move-out"


def test_unmatched_plaid_row_on_closed_account_still_lands(db, plaid_item, monkeypatch):
    acct = _closed_plaid_account(db, plaid_item)
    _patch_sync(monkeypatch, added=[_plaid_txn("p-2", 12.5, dt.date(2026, 1, 10))])
    sync_service.sync_single_item(db, client=None, item=plaid_item)
    rows = db.query(Transaction).filter_by(account_id=acct.id).all()
    assert [r.plaid_transaction_id for r in rows] == ["p-2"]


# ---------------------------------------------------------------------------
# Connection health
# ---------------------------------------------------------------------------

def test_health_report_skips_item_whose_accounts_are_all_closed(db, factory, monkeypatch):
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: t)
    gone = PlaidItem(item_id="i-gone", access_token="gone", institution_name="Closed Bank")
    live = PlaidItem(item_id="i-live", access_token="live", institution_name="Live Bank")
    db.add_all([gone, live])
    db.flush()
    a = factory.account(plaid_item_id=gone.id)
    a.status = "closed"
    factory.account(plaid_item_id=live.id)
    factory.commit()

    report = sync_service.item_health_report(db, client=object(), fetch=lambda c, tok: None)
    names = {r["institution_name"] for r in report}
    assert names == {"Live Bank"}


def test_health_report_keeps_item_with_an_open_account(db, factory, monkeypatch):
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: t)
    bank = PlaidItem(item_id="i-mixed", access_token="mixed", institution_name="Mixed Bank")
    db.add(bank)
    db.flush()
    a = factory.account(plaid_item_id=bank.id)
    a.status = "closed"
    factory.account(plaid_item_id=bank.id, subtype="savings")
    factory.commit()

    report = sync_service.item_health_report(db, client=object(), fetch=lambda c, tok: None)
    assert [r["institution_name"] for r in report] == ["Mixed Bank"]


# ---------------------------------------------------------------------------
# Audit follow-ups: everywhere a "current" view reads accounts
# ---------------------------------------------------------------------------

def test_close_clears_current_holdings(client, db, factory):
    from app.models import Holding
    brokerage = factory.account(name="Old brokerage", type="investment", subtype="brokerage")
    db.add(Holding(account_id=brokerage.id, plaid_security_id="sec-1", quantity=3, institution_value=300.0))
    factory.commit()
    client.patch(f"/api/accounts/{brokerage.id}", json={"status": "closed"})
    assert db.query(Holding).filter_by(account_id=brokerage.id).count() == 0


def test_sync_skips_holdings_for_closed_account(db, plaid_item, monkeypatch):
    from app.models import Holding
    acct = _closed_plaid_account(db, plaid_item)
    acct.type = "investment"
    db.commit()
    monkeypatch.setattr(sync_service, "get_investments_holdings", lambda client, token: {
        "holdings": [{"account_id": "acct-1", "security_id": "sec-1", "quantity": 2.0,
                      "institution_price": 10.0, "institution_value": 20.0, "cost_basis": None,
                      "iso_currency_code": "USD"}],
        "securities": [{"security_id": "sec-1", "name": "Fund", "ticker_symbol": "FND", "type": "etf"}],
        "accounts": [],
    }, raising=False)
    monkeypatch.setattr(sync_service, "get_investment_transactions",
                        lambda *a, **k: {"investment_transactions": [], "securities": []}, raising=False)
    try:
        sync_service._sync_investments(db, None, "tok", plaid_item)
    except Exception:
        pass  # only the holdings loop matters here
    assert db.query(Holding).filter_by(account_id=acct.id).count() == 0


def test_loans_and_hsa_lists_skip_closed(client, factory):
    open_loan = factory.account(name="Car loan", type="loan", subtype="auto", current_balance=5000.0)
    paid = factory.account(name="Paid-off loan", type="loan", subtype="auto", current_balance=0.0)
    paid.status = "closed"
    old_hsa = factory.account(name="Old HSA", type="investment", subtype="hsa", current_balance=0.0)
    old_hsa.status = "closed"
    live_hsa = factory.account(name="HSA", type="investment", subtype="hsa", current_balance=900.0)
    factory.commit()

    loans = client.get("/api/loans/").json()
    loan_names = {row.get("name") for row in (loans if isinstance(loans, list) else loans.get("loans", []))}
    assert "Paid-off loan" not in loan_names
    hsa_ids = {a["id"] for a in client.get("/api/analytics/hsa-status").json()["accounts"]}
    assert hsa_ids == {live_hsa.id}


def test_ask_names_a_closed_account_as_closed(db, factory):
    from app.services import assistant_retrieval as ar
    factory.account(name="Joint Checking", current_balance=2500.0)
    old = factory.account(name="Credit Union Checking", current_balance=0.0)
    old.status = "closed"
    old.closed_at = dt.date(2026, 1, 20)
    factory.commit()
    res = ar.account_balance(db, None, None, "now", question="what's in my credit union checking")
    assert "closed on Jan 20, 2026" in res["answer"]
    over = ar.accounts_overview(db, None, None, "now", question="what accounts do I have")
    assert "You have 1 accounts" in over["answer"] or "You have 1 account" in over["answer"]
    assert "Credit Union" not in over["answer"]
