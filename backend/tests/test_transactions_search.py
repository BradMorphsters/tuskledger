"""Tests for transaction search functionality."""
import datetime
from fastapi.testclient import TestClient
from app.main import app


def test_transaction_search_by_merchant_name(db, factory):
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
    client = TestClient(app)
    response = client.get("/api/transactions/?q=Starbucks")
    assert response.status_code == 200
    results = response.json()
    assert len(results) == 1
    assert results[0]["id"] == txn1.id
    assert results[0]["merchant_name"] == "Starbucks Coffee"


def test_transaction_search_by_name(db, factory):
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

    client = TestClient(app)
    response = client.get("/api/transactions/?q=Grocery")
    assert response.status_code == 200
    results = response.json()
    assert len(results) == 1
    assert results[0]["id"] == txn1.id


def test_transaction_search_case_insensitive(db, factory):
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

    client = TestClient(app)
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


def test_transaction_search_empty_q_is_ignored(db, factory):
    """Test that empty or whitespace-only q is treated as no filter."""
    acct = factory.account(name="Test Account")
    factory.commit()

    txn1 = factory.transaction(account_id=acct.id, merchant_name="Starbucks", amount=5.50)
    txn2 = factory.transaction(account_id=acct.id, merchant_name="Target", amount=30.0)
    factory.commit()

    client = TestClient(app)

    # Empty q should return all transactions
    response = client.get("/api/transactions/?q=")
    assert response.status_code == 200
    assert len(response.json()) == 2

    # Whitespace-only q should also return all transactions
    response = client.get("/api/transactions/?q=%20%20")  # URL-encoded spaces
    assert response.status_code == 200
    assert len(response.json()) == 2


def test_transaction_search_composes_with_filters(db, factory):
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

    client = TestClient(app)

    # Search for "Starbucks" in account 1 only — should return txn1, not txn3
    response = client.get(f"/api/transactions/?q=Starbucks&account_id={acct1.id}")
    assert response.status_code == 200
    results = response.json()
    assert len(results) == 1
    assert results[0]["id"] == txn1.id
    assert results[0]["account_id"] == acct1.id


def test_transaction_search_partial_match(db, factory):
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

    client = TestClient(app)

    # Search for partial word should match
    response = client.get("/api/transactions/?q=bucks")
    assert response.status_code == 200
    assert len(response.json()) == 1
