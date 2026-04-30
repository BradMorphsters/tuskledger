"""Tests for the Plaid sync orchestration.

These mock the Plaid SDK at the function boundary (get_account_balances,
sync_transactions, etc.) and feed canned responses through the real
sync_single_item path. The goal is to catch:

  * Plaid SDK contract drift — if a future SDK release changes the shape
    of a returned balance dict, our mapping breaks here loudly instead
    of silently writing zeros to the DB next sync.
  * Schema drift between sync_service and the ORM — if a column gets
    dropped or renamed without updating sync_service, the insert fails.
  * The lazy plaintext-token re-encryption migration (a deploy-time
    safety mechanism — easy to break by mistake, very expensive to
    diagnose later).
  * The balance_as_of stamping that we just added as a fix — make sure
    a future refactor doesn't quietly drop it again.

We do NOT test the live Plaid HTTP layer here — that's covered by
manually relinking accounts after upgrades.
"""
from __future__ import annotations

import datetime as _dt
from types import SimpleNamespace

import pytest

from app.services import sync_service
from app.models import Account, Transaction, PlaidItem


def _plaid_account(account_id: str, name: str, balance: float, type_: str = "depository", subtype: str = "checking"):
    """Shape that get_account_balances returns. Mirrors Plaid's
    /accounts/balance/get response item dict."""
    return {
        "account_id": account_id,
        "name": name,
        "official_name": name,
        "type": type_,
        "subtype": subtype,
        "mask": "1234",
        "balances": {
            "current": balance,
            "available": balance,
            "iso_currency_code": "USD",
        },
    }


def _plaid_txn(txn_id: str, account_id: str, amount: float, name: str, date: _dt.date):
    """Shape that sync_transactions['added'] entries return."""
    return {
        "transaction_id": txn_id,
        "account_id": account_id,
        "name": name,
        "merchant_name": name,
        "amount": amount,
        "iso_currency_code": "USD",
        "date": date,
        "pending": False,
        "personal_finance_category": {"primary": "FOOD_AND_DRINK", "detailed": "FOOD_AND_DRINK_FAST_FOOD"},
    }


@pytest.fixture
def plaid_item(db, factory):
    """A minimal PlaidItem so sync_single_item has something to walk."""
    item = PlaidItem(
        item_id="test-item-id",
        access_token="enc:v1:placeholder",  # already-encrypted shape; real value not used
        institution_id="ins_1",
        institution_name="Test Bank",
        cursor=None,
    )
    db.add(item)
    db.commit()
    return item


def _patch_plaid(monkeypatch, *, accounts, txn_added=None, txn_modified=None, txn_removed=None, cursor="cur-1"):
    """Patch every Plaid-facing call sync_service makes with canned responses."""
    monkeypatch.setattr(sync_service, "get_account_balances",
                        lambda client, token: accounts)
    monkeypatch.setattr(sync_service, "sync_transactions",
                        lambda client, token, cur: {
                            "added": txn_added or [],
                            "modified": txn_modified or [],
                            "removed": txn_removed or [],
                            "cursor": cursor,
                        })
    # Decrypt is called on the access token; have it pass through
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: "plaid-access-token")
    monkeypatch.setattr(sync_service, "encrypt_token", lambda t: "enc:v1:" + (t or ""))
    monkeypatch.setattr(sync_service, "is_encrypted", lambda t: isinstance(t, str) and t.startswith("enc:v1:"))


def test_creates_account_and_transaction_on_first_sync(db, factory, plaid_item, monkeypatch):
    """First-ever sync for an item: account row + transaction row both
    get created from the Plaid responses. This is the happy path that
    every other test layers on top of."""
    _patch_plaid(
        monkeypatch,
        accounts=[_plaid_account("acct-1", "Checking", balance=2500.0)],
        txn_added=[_plaid_txn("txn-1", "acct-1", 12.50, "Coffee Shop", _dt.date(2026, 4, 5))],
    )
    result = sync_service.sync_single_item(db, client=None, item=plaid_item)

    accounts = db.query(Account).all()
    assert len(accounts) == 1
    assert accounts[0].name == "Checking"
    assert accounts[0].current_balance == 2500.0
    assert accounts[0].plaid_item_id == plaid_item.id

    txns = db.query(Transaction).all()
    assert len(txns) == 1
    assert txns[0].name == "Coffee Shop"
    assert txns[0].amount == 12.50
    assert result["added"] == 1


def test_sync_is_idempotent_on_same_transaction_id(db, factory, plaid_item, monkeypatch):
    """Plaid /transactions/sync can return the same added txn twice in
    edge cases (re-cursor, replay). We must dedupe by plaid_transaction_id
    so a re-sync doesn't double the user's spend totals."""
    txn = _plaid_txn("txn-dup", "acct-1", 50.0, "Lunch", _dt.date(2026, 4, 6))

    _patch_plaid(
        monkeypatch,
        accounts=[_plaid_account("acct-1", "Checking", 1000.0)],
        txn_added=[txn],
    )
    sync_service.sync_single_item(db, client=None, item=plaid_item)
    # Second call returns the same added entry
    sync_service.sync_single_item(db, client=None, item=plaid_item)

    assert db.query(Transaction).count() == 1, \
        "second sync should NOT have duplicated the transaction"


def test_balance_as_of_stamped_on_every_sync(db, factory, plaid_item, monkeypatch):
    """Regression test for a real bug we shipped: sync used to leave
    balance_as_of unset, which made the freshness panel + stale-balance
    alerts give wrong staleness values. Every sync must stamp today on
    every account that returned data."""
    _patch_plaid(
        monkeypatch,
        accounts=[_plaid_account("acct-1", "Checking", 1000.0)],
    )
    sync_service.sync_single_item(db, client=None, item=plaid_item)
    acct = db.query(Account).first()
    assert acct.balance_as_of == _dt.date.today(), \
        "sync must stamp account.balance_as_of with today's date on every run"


def test_cursor_advances_after_sync(db, factory, plaid_item, monkeypatch):
    """The cursor is the state token for /transactions/sync — if it
    doesn't advance, the next sync re-fetches every transaction we
    already have. Plaid bills per call, so a cursor regression also
    burns through your free tier quickly."""
    assert plaid_item.cursor is None
    _patch_plaid(
        monkeypatch,
        accounts=[_plaid_account("acct-1", "Checking", 1000.0)],
        cursor="cur-after-sync",
    )
    sync_service.sync_single_item(db, client=None, item=plaid_item)
    db.refresh(plaid_item)
    assert plaid_item.cursor == "cur-after-sync"


def test_modified_transaction_updates_existing_row(db, factory, plaid_item, monkeypatch):
    """Plaid emits a 'modified' entry when a pending charge posts (amount
    finalizes, merchant cleans up). We must apply the update in place,
    not insert a duplicate row."""
    txn_v1 = _plaid_txn("txn-mod", "acct-1", 9.99, "AMZN MKTPL", _dt.date(2026, 4, 6))
    txn_v2 = dict(txn_v1, amount=12.34, name="Amazon", merchant_name="Amazon", pending=False)

    _patch_plaid(
        monkeypatch,
        accounts=[_plaid_account("acct-1", "Checking", 1000.0)],
        txn_added=[txn_v1],
    )
    sync_service.sync_single_item(db, client=None, item=plaid_item)
    assert db.query(Transaction).count() == 1
    assert db.query(Transaction).first().amount == 9.99

    # Second sync delivers the modification
    _patch_plaid(
        monkeypatch,
        accounts=[_plaid_account("acct-1", "Checking", 1000.0)],
        txn_modified=[txn_v2],
    )
    sync_service.sync_single_item(db, client=None, item=plaid_item)

    assert db.query(Transaction).count() == 1, "modify must not insert"
    updated = db.query(Transaction).first()
    assert updated.amount == 12.34
    assert updated.name == "Amazon"


def test_removed_transaction_is_deleted(db, factory, plaid_item, monkeypatch):
    """Plaid sends 'removed' when a pending charge gets dropped (failed
    auth, merchant void). We delete the row so it stops affecting totals."""
    txn = _plaid_txn("txn-rm", "acct-1", 25.0, "Test", _dt.date(2026, 4, 6))
    _patch_plaid(
        monkeypatch,
        accounts=[_plaid_account("acct-1", "Checking", 1000.0)],
        txn_added=[txn],
    )
    sync_service.sync_single_item(db, client=None, item=plaid_item)
    assert db.query(Transaction).count() == 1

    _patch_plaid(
        monkeypatch,
        accounts=[_plaid_account("acct-1", "Checking", 1000.0)],
        txn_removed=[{"transaction_id": "txn-rm"}],
    )
    sync_service.sync_single_item(db, client=None, item=plaid_item)
    assert db.query(Transaction).count() == 0


def test_legacy_plaintext_token_gets_lazy_re_encrypted(db, factory, monkeypatch):
    """Pre-encryption Items have access_token stored as plaintext. On the
    first post-upgrade sync, the service must transparently re-encrypt
    in place. This is the deploy-without-migration-script promise the
    crypto module makes."""
    # Build a PlaidItem with a plaintext token
    item = PlaidItem(
        item_id="legacy-item",
        access_token="plaintext-token-from-old-version",  # no enc:v1: prefix
        institution_id="ins_1",
        institution_name="Test Bank",
        cursor=None,
    )
    db.add(item)
    db.commit()

    # Track encrypt_token calls to confirm it's invoked exactly once
    encrypt_calls = []
    real_encrypt = sync_service.encrypt_token

    def tracking_encrypt(t):
        encrypt_calls.append(t)
        return "enc:v1:" + (t or "")
    monkeypatch.setattr(sync_service, "encrypt_token", tracking_encrypt)
    monkeypatch.setattr(sync_service, "decrypt_token", lambda t: t.replace("enc:v1:", "") if t and t.startswith("enc:v1:") else t)
    monkeypatch.setattr(sync_service, "is_encrypted", lambda t: isinstance(t, str) and t.startswith("enc:v1:"))
    monkeypatch.setattr(sync_service, "get_account_balances", lambda client, token: [])
    monkeypatch.setattr(sync_service, "sync_transactions",
                        lambda client, token, cur: {"added": [], "modified": [], "removed": [], "cursor": "x"})

    sync_service.sync_single_item(db, client=None, item=item)

    db.refresh(item)
    assert item.access_token.startswith("enc:v1:"), \
        "legacy plaintext access_token must be re-encrypted in place on first sync"
    assert encrypt_calls == ["plaintext-token-from-old-version"], \
        "encrypt_token should be called exactly once with the plaintext value"
