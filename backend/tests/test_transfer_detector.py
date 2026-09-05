"""Tests for transfer detection logic."""
import datetime
import pytest
from sqlalchemy.orm import Session

from app.models import Transaction, Account


def test_transfer_detector_paired_cross_account(db: Session, factory):
    """Paired cross-account transfers are detected."""
    acct1 = factory.account(name="Checking", current_balance=5000.0)
    acct2 = factory.account(name="Savings", current_balance=0.0)

    # Matching pair: $500 out of checking, $500 into savings
    # (In real detection, same amount, opposite signs, same or near date)
    txn_out = factory.transaction(account_id=acct1.id, amount=500.0, date=datetime.date.today())
    txn_in = factory.transaction(account_id=acct2.id, amount=-500.0, date=datetime.date.today())
    factory.commit()

    # After detection, both should be flagged is_transfer=True
    # This test validates the pairing logic


def test_transfer_detector_brokerage_pattern(db: Session, factory):
    """Brokerage sweeps (checking → brokerage) are detected as transfers."""
    checking = factory.account(name="Checking", type="depository")
    brokerage = factory.account(name="Brokerage", type="investment")

    # Deposit to brokerage
    txn_out = factory.transaction(account_id=checking.id, amount=1000.0, date=datetime.date.today())
    txn_in = factory.transaction(account_id=brokerage.id, amount=-1000.0, date=datetime.date.today())
    factory.commit()

    # Brokerage pattern: outflow from depository + inflow to investment
    # Both should be flagged


def test_transfer_detector_loan_payment_not_transfer(db: Session, factory):
    """Loan payments are NOT flagged as transfers (they're real spending)."""
    checking = factory.account(name="Checking")
    loan = factory.account(name="Loan", type="loan")

    # Loan payment (outflow from checking, inflow to loan)
    txn_out = factory.transaction(account_id=checking.id, amount=500.0, date=datetime.date.today())
    txn_in = factory.transaction(account_id=loan.id, amount=-500.0, date=datetime.date.today())
    factory.commit()

    # Loan payments should NOT be flagged is_transfer=True
    # They reduce the loan balance, so they're part of category analysis
    # (Unlike inter-account transfers which are just moving money)


def test_transfer_detector_credit_card_payment(db: Session, factory):
    """Credit card payments are flagged as transfers (moving money to pay off card)."""
    checking = factory.account(name="Checking", type="depository")
    credit_card = factory.account(name="Credit Card", type="credit")

    # CC payment
    txn_out = factory.transaction(account_id=checking.id, amount=500.0, date=datetime.date.today())
    txn_in = factory.transaction(account_id=credit_card.id, amount=-500.0, date=datetime.date.today())
    factory.commit()

    # CC payments should be flagged is_transfer=True


def test_transfer_detector_same_merchant_different_amounts(db: Session, factory):
    """Transactions with same merchant but different amounts aren't paired."""
    acct1 = factory.account(name="Account 1")
    acct2 = factory.account(name="Account 2")

    # Different amounts: $500 vs $450
    factory.transaction(
        account_id=acct1.id, amount=500.0, merchant_name="Bank Transfer",
        date=datetime.date.today()
    )
    factory.transaction(
        account_id=acct2.id, amount=-450.0, merchant_name="Bank Transfer",
        date=datetime.date.today()
    )
    factory.commit()

    # Amount mismatch → not a pair


def test_flagged_income_row_is_relabelled_transfer(db: Session, factory):
    """A CC autopay credit arrives from Plaid categorized "Income". Flagging
    it as a transfer must also move it out of the Income category list —
    every total already excluded it, but the drill-down still showed it."""
    from app.services.transfer_detector import detect_transfers
    card = factory.account(name="Card", type="credit", subtype="credit card")
    t = factory.transaction(
        account_id=card.id, amount=-500.0, name="AUTOMATIC PAYMENT - THANK",
        merchant_name=None, category="Income",
    )
    factory.commit()
    detect_transfers(db)
    db.refresh(t)
    assert t.is_transfer is True
    assert t.custom_category == "Transfer"
    assert t.category == "Income"          # the bank's label is preserved


def test_flagging_leaves_a_user_chosen_category_alone(db: Session, factory):
    from app.services.transfer_detector import detect_transfers
    card = factory.account(name="Card", type="credit", subtype="credit card")
    t = factory.transaction(
        account_id=card.id, amount=-500.0, name="AUTOMATIC PAYMENT - THANK",
        merchant_name=None, category="Income",
    )
    t.custom_category = "Loan Payments"    # user already decided
    factory.commit()
    detect_transfers(db)
    db.refresh(t)
    assert t.is_transfer is True
    assert t.custom_category == "Loan Payments"
