"""Tests for transaction search functionality."""
import datetime
import pytest
from fastapi.testclient import TestClient

from app.database import get_db, get_real_db
from app.main import app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def client(db):
    """TestClient wired to the hermetic in-memory DB.

    Overrides both get_db and get_real_db so every code path — including
    routers that import get_real_db directly — sees the same in-memory
    session as the test fixtures.
    """
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_real_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Search tests
# ---------------------------------------------------------------------------

def test_transaction_search_by_merchant_name(client, db, factory):
    """Test that search filters transactions by merchant_name."""
    # Create an account
    acct = factory.account(name="Test Account")
    factory.commit()

    # Create 3 transactions with distinct merchant names
    txn1 = factory.transaction(
        account_id=acct.id,
        merchant_name="Starbucks Coffee",
        name="STARBUCKS #1234",
        amount=5.50,
    )
    txn2 = factory.transaction(
        account_id=acct.id,
        merchant_name="Whole Foods Market",
        name="WFM #5678",
        amount=45.30,
    )
    txn3 = factory.transaction(
        account_id=acct.id,
        merchant_name="Target Store",
        name="TARGET #9012",
        amount=32.10,
    )
    factory.commit()

    # Test search for "Starbucks" — should only return txn1
    response = client.get("/api/transactions/?q=Starbucks")
    assert response.status_code == 200
    results = response.json()
    assert len(results) == 1
    assert results[0]["id"] == txn1.id
    assert results[0]["merchant_name"] == "Starbucks Coffee"


def test_transaction_search_by_name(client, db, factory):
    """Test that search also filters by transaction name."""
    acct = factory.account(name="Test Account")
    factory.commit()

    txn1 = factory.transaction(
        account_id=acct.id,
        name="Grocery Store ABC",
        merchant_name="ABC Grocery",
        amount=50.0,
    )
    txn2 = factory.transaction(
        account_id=acct.id,
        name="Gas Station XYZ",
        merchant_name="XYZ Fuel",
        amount=60.0,
    )
    factory.commit()

    response = client.get("/api/transactions/?q=Grocery")
    assert response.status_code == 200
    results = response.json()
    assert len(results) == 1
    assert results[0]["id"] == txn1.id


def test_transaction_search_case_insensitive(client, db, factory):
    """Test that search is case-insensitive."""
    acct = factory.account(name="Test Account")
    factory.commit()

    txn = factory.transaction(
        account_id=acct.id,
        merchant_name="Starbucks Coffee",
        name="STARBUCKS #1234",
        amount=5.50,
    )
    factory.commit()

    # Search with different cases
    response = client.get("/api/transactions/?q=starbucks")
    assert response.status_code == 200
    assert len(response.json()) == 1

    response = client.get("/api/transactions/?q=STARBUCKS")
    assert response.status_code == 200
    assert len(response.json()) == 1

    response = client.get("/api/transactions/?q=StArBuCkS")
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_transaction_search_empty_q_is_ignored(client, db, factory):
    """Test that empty or whitespace-only q is treated as no filter."""
    acct = factory.account(name="Test Account")
    factory.commit()

    txn1 = factory.transaction(account_id=acct.id, merchant_name="Starbucks", amount=5.50)
    txn2 = factory.transaction(account_id=acct.id, merchant_name="Target", amount=30.0)
    factory.commit()

    # Empty q should return all transactions
    response = client.get("/api/transactions/?q=")
    assert response.status_code == 200
    assert len(response.json()) == 2

    # Whitespace-only q should also return all transactions
    response = client.get("/api/transactions/?q=%20%20")  # URL-encoded spaces
    assert response.status_code == 200
    assert len(response.json()) == 2


def test_transaction_search_composes_with_filters(client, db, factory):
    """Test that search works in combination with other filters."""
    acct1 = factory.account(name="Account 1")
    acct2 = factory.account(name="Account 2")
    factory.commit()

    # Account 1 transactions
    txn1 = factory.transaction(
        account_id=acct1.id,
        merchant_name="Starbucks Coffee",
        amount=5.50,
    )
    txn2 = factory.transaction(
        account_id=acct1.id,
        merchant_name="Target Store",
        amount=30.0,
    )

    # Account 2 transaction with same merchant as txn1
    txn3 = factory.transaction(
        account_id=acct2.id,
        merchant_name="Starbucks Coffee",
        amount=6.50,
    )
    factory.commit()

    # Search for "Starbucks" in account 1 only — should return txn1, not txn3
    response = client.get(f"/api/transactions/?q=Starbucks&account_id={acct1.id}")
    assert response.status_code == 200
    results = response.json()
    assert len(results) == 1
    assert results[0]["id"] == txn1.id
    assert results[0]["account_id"] == acct1.id


def test_transaction_search_partial_match(client, db, factory):
    """Test that search uses partial matching (LIKE)."""
    acct = factory.account(name="Test Account")
    factory.commit()

    txn1 = factory.transaction(
        account_id=acct.id,
        merchant_name="Starbucks Coffee",
        name="SBX #1234",
        amount=5.50,
    )
    factory.commit()

    # Search for partial word should match
    response = client.get("/api/transactions/?q=bucks")
    assert response.status_code == 200
    assert len(response.json()) == 1


# ─── /transactions/totals ──────────────────────────────────────
# These guard the fix where the page header summary was summing
# only the visible 50-row page instead of the full filtered scope.

def test_totals_aggregates_all_matching_rows_not_just_a_page(client, db, factory):
    """Totals must reflect every row matching the filter, even when the
    result set is bigger than the default list-transactions page size.

    Regression: the page header used to compute totals from the loaded
    page (limit=50), which silently under-reported whenever the filter
    returned more than 50 rows.
    """
    acct = factory.account(name="Test Account")
    factory.commit()

    # Create 75 spending rows ($10 each) — more than one default page.
    for _ in range(75):
        factory.transaction(account_id=acct.id, merchant_name="Coffee", amount=10.0)
    # And 5 income rows ($100 each, Plaid sign convention: negative).
    for _ in range(5):
        factory.transaction(account_id=acct.id, merchant_name="Payroll", amount=-100.0)
    factory.commit()

    r = client.get("/api/transactions/totals")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 80
    assert body["spending"] == 750.0   # 75 × $10
    assert body["income"] == 500.0     # 5 × $100, returned as positive
    assert body["transfers_excluded"] == 0


def test_totals_excludes_transfers_by_default(client, db, factory):
    """Income/spending must exclude is_transfer rows so account-to-account
    moves don't double-count.

    Without this, a $1,000 CC autopay (Family Checking → Apple Card)
    appears as $1,000 spending on Family Checking AND $1,000 income on
    Apple Card, inflating both totals symmetrically. Real-world result
    on Eduardo's data: ~$222K on each side, almost equal — clearly wrong.
    """
    checking = factory.account(name="Checking")
    credit = factory.account(name="Credit Card")
    factory.commit()

    # Real spending ($50) + real income ($200) — these should land in totals.
    factory.transaction(account_id=checking.id, merchant_name="Coffee", amount=50.0)
    factory.transaction(account_id=checking.id, merchant_name="Payroll", amount=-200.0)
    # CC autopay pair — both flagged as transfer. Should NOT appear in totals.
    factory.transaction(
        account_id=checking.id, merchant_name="CC Autopay",
        amount=1000.0, is_transfer=True,
    )
    factory.transaction(
        account_id=credit.id, merchant_name="Payment Received",
        amount=-1000.0, is_transfer=True,
    )
    factory.commit()

    # Default: transfers excluded
    r = client.get("/api/transactions/totals")
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 4              # all rows visible in list
    assert body["spending"] == 50.0        # transfers excluded from sum
    assert body["income"] == 200.0
    assert body["transfers_excluded"] == 2

    # Opt-in: include transfers (for reconciliation / auditing)
    r = client.get("/api/transactions/totals?include_transfers=true")
    body = r.json()
    assert body["spending"] == 1050.0      # 50 + 1000 transfer side
    assert body["income"] == 1200.0        # 200 + 1000 transfer side
    assert body["transfers_excluded"] == 0


def test_totals_respects_filters(client, db, factory):
    """Filters (q, category, account_id, date range) narrow the totals."""
    acct1 = factory.account(name="A")
    acct2 = factory.account(name="B")
    factory.commit()

    factory.transaction(account_id=acct1.id, merchant_name="Starbucks", amount=5.0)
    factory.transaction(account_id=acct1.id, merchant_name="Starbucks", amount=7.0)
    factory.transaction(account_id=acct2.id, merchant_name="Starbucks", amount=20.0)
    factory.transaction(account_id=acct1.id, merchant_name="Target", amount=99.0)
    factory.commit()

    # Filter to Starbucks rows in account 1 only — 2 rows totaling $12
    r = client.get(f"/api/transactions/totals?q=Starbucks&account_id={acct1.id}")
    assert r.status_code == 200
    assert r.json() == {
        "count": 2, "spending": 12.0, "income": 0.0, "transfers_excluded": 0,
    }


def test_totals_empty_filter_returns_zeros(client, db, factory):
    """No matching rows must return zeros, not null/None."""
    factory.account(name="Empty")
    factory.commit()

    r = client.get("/api/transactions/totals?q=nothing-matches-this")
    assert r.status_code == 200
    assert r.json() == {
        "count": 0, "spending": 0.0, "income": 0.0, "transfers_excluded": 0,
    }
