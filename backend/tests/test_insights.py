"""Tests for the insights endpoint."""
import datetime
import pytest
from app.routers.analytics import get_insights


def test_insights_empty_db(db, factory):
    """Empty database returns no insight cards."""
    response = get_insights(db=db)
    assert response.cards == []
    assert response.generated_at is not None


def test_insights_category_up(db, factory):
    """Category spending up vs baseline fires a card."""
    today = datetime.date.today()
    acct = factory.account()

    # Build 3 months of baseline: $100 in Shopping each month
    for offset in range(1, 4):
        m = today.month - offset
        y = today.year
        while m <= 0:
            m += 12
            y -= 1
        # One transaction per month in Shopping
        factory.transaction(
            account_id=acct.id,
            amount=100.0,
            date=datetime.date(y, m, 15),
            merchant_name="Store",
            category="Shopping",
        )

    # Current month: $200 in Shopping (> 1.30 * 100, and > $50)
    mtd_start = datetime.date(today.year, today.month, 1)
    factory.transaction(
        account_id=acct.id,
        amount=200.0,
        date=today,
        merchant_name="Store",
        category="Shopping",
    )
    factory.commit()

    response = get_insights(db=db)

    # Should have at least one category_up card
    category_up_cards = [c for c in response.cards if c.type == "category_up"]
    assert len(category_up_cards) >= 1
    card = category_up_cards[0]
    assert card.category == "Shopping"
    assert card.amount == 200.0


def test_insights_new_merchant_below_threshold(db, factory):
    """New merchant with amount <= $50 does not fire."""
    today = datetime.date.today()
    acct = factory.account()

    # Add a transaction > 14 days ago at this merchant (establish baseline)
    old_date = today - datetime.timedelta(days=30)
    factory.transaction(
        account_id=acct.id,
        amount=100.0,
        date=old_date,
        merchant_name="OldStore",
        category="Shopping",
    )

    # New merchant with $30 transaction (below $50 threshold)
    factory.transaction(
        account_id=acct.id,
        amount=30.0,
        date=today,
        merchant_name="NewStore",
        category="Shopping",
    )
    factory.commit()

    response = get_insights(db=db)

    # Should NOT fire a new_merchant card for the small transaction
    new_merch_cards = [c for c in response.cards if c.type == "new_merchant"]
    # NewStore should not appear
    assert not any(c.merchant == "NewStore" for c in new_merch_cards)


def test_insights_new_merchant_fires(db, factory):
    """New merchant with amount > $50 in last 14 days fires a card."""
    today = datetime.date.today()
    acct = factory.account()

    # New merchant (no prior txns), amount $100
    factory.transaction(
        account_id=acct.id,
        amount=100.0,
        date=today,
        merchant_name="BrandNewStore",
        category="Shopping",
    )
    factory.commit()

    response = get_insights(db=db)

    # Should fire a new_merchant card
    new_merch_cards = [c for c in response.cards if c.type == "new_merchant"]
    assert len(new_merch_cards) >= 1
    assert any("BrandNewStore" in (c.merchant or "") for c in new_merch_cards)


def test_insights_limit(db, factory):
    """Respects the limit parameter."""
    today = datetime.date.today()
    acct = factory.account()

    # Create many new merchants to exceed a low limit
    for i in range(10):
        factory.transaction(
            account_id=acct.id,
            amount=100.0,
            date=today,
            merchant_name=f"Store{i}",
            category="Shopping",
        )
    factory.commit()

    response = get_insights(limit=3, db=db)
    assert len(response.cards) <= 3


def test_insights_transfers_excluded(db, factory):
    """Transfers are excluded from insight calculations."""
    today = datetime.date.today()
    acct = factory.account()

    # Add a transfer (is_transfer=True)
    factory.transaction(
        account_id=acct.id,
        amount=500.0,
        date=today,
        merchant_name="Another Account",
        category="Transfer",
        is_transfer=True,
    )
    factory.commit()

    response = get_insights(db=db)

    # Transfer should not contribute to any card
    assert all(c.merchant != "Another Account" for c in response.cards)
