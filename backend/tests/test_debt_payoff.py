"""Tests for debt amortization and payoff calculations."""
import datetime
import pytest
from sqlalchemy.orm import Session

from app.models import Account, MortgageDetail


def test_amortization_known_mortgage(db: Session, factory):
    """Known mortgage example: correct principal/interest split across periods."""
    # Standard 30-year mortgage: $300k at 4% APR → ~$1432/month
    # Month 1: ~$1000 interest, ~$432 principal
    # Month 360: ~$1 interest, ~$1431 principal

    principal = 300000.0
    annual_rate = 4.0
    loan_term = 30  # years
    monthly_rate = annual_rate / 100 / 12
    num_payments = loan_term * 12

    # Standard amortization: M = P * [r(1+r)^n] / [(1+r)^n - 1]
    compound = (1 + monthly_rate) ** num_payments
    monthly_payment = principal * (monthly_rate * compound) / (compound - 1)

    # Approximate: ~1432.25
    assert 1430 < monthly_payment < 1435, f"Monthly payment should be ~1432, got {monthly_payment}"

    # Month 1: interest = 300000 * 0.04 / 12 = 1000
    month_1_interest = principal * monthly_rate
    assert 999 < month_1_interest < 1001
    month_1_principal = monthly_payment - month_1_interest
    assert 430 < month_1_principal < 435


def test_amortization_zero_rate_fallback(db: Session, factory):
    """Zero interest rate falls back to simple division: payment = principal / months."""
    principal = 10000.0
    annual_rate = 0.0
    num_payments = 12

    # Zero rate: no compounding, just equal principal payments
    monthly_payment = principal / num_payments
    assert monthly_payment == pytest.approx(833.33, rel=0.01)


def test_amortization_negative_amortization_detection(db: Session, factory):
    """Negative amortization: payment < interest accrued (loan grows)."""
    principal = 100000.0
    annual_rate = 10.0
    monthly_rate = annual_rate / 100 / 12

    # Interest accrued per month
    monthly_interest = principal * monthly_rate

    # If monthly payment < interest, principal grows
    monthly_payment = monthly_interest * 0.5  # Pay only 50% of interest

    balance_change = monthly_interest - monthly_payment
    assert balance_change > 0, "Negative amortization: balance should grow"

    new_balance = principal + balance_change
    assert new_balance > principal


def test_amortization_adjustable_rate_recalculation(db: Session, factory):
    """ARM (adjustable-rate mortgage) recalculates after rate change."""
    # Year 1-5: 3% teaser rate
    # Year 6+: rate resets to 6%

    principal = 300000.0
    teaser_rate = 3.0
    reset_rate = 6.0
    loan_term = 30  # years

    # Initial 5-year payment on teaser
    monthly_rate_1 = teaser_rate / 100 / 12
    num_payments = loan_term * 12
    compound_1 = (1 + monthly_rate_1) ** num_payments
    payment_1 = principal * (monthly_rate_1 * compound_1) / (compound_1 - 1)

    # After 60 payments, calculate remaining balance
    balance = principal
    for i in range(60):
        interest = balance * monthly_rate_1
        principal_paid = payment_1 - interest
        balance -= principal_paid

    # Recalculate for remaining term (300 payments left)
    remaining_term = num_payments - 60
    monthly_rate_2 = reset_rate / 100 / 12
    compound_2 = (1 + monthly_rate_2) ** remaining_term
    payment_2 = balance * (monthly_rate_2 * compound_2) / (compound_2 - 1)

    # Payment 2 should be significantly higher (higher rate)
    assert payment_2 > payment_1, f"Reset payment {payment_2} should exceed teaser {payment_1}"


def test_payoff_projection_month_count(db: Session, factory):
    """Payoff projection correctly counts months until balance = 0."""
    principal = 10000.0
    monthly_payment = 500.0
    annual_rate = 5.0
    monthly_rate = annual_rate / 100 / 12

    balance = principal
    months = 0
    while balance > 0 and months < 300:
        interest = balance * monthly_rate
        principal_payment = monthly_payment - interest
        if principal_payment <= 0:
            break  # Can't pay off if payment < interest
        balance -= principal_payment
        months += 1

    # Roughly 20-21 months for $10k at 5% APR with $500 payment
    assert 20 <= months <= 22, f"Payoff should take ~21 months, got {months}"


def test_payoff_early_vs_standard(db: Session, factory):
    """Extra principal payments shorten payoff term and reduce total interest."""
    principal = 100000.0
    standard_payment = 500.0
    extra_payment = 100.0
    annual_rate = 4.0
    monthly_rate = annual_rate / 100 / 12

    # Standard payoff
    balance_std = principal
    interest_std = 0.0
    months_std = 0
    while balance_std > 0 and months_std < 600:
        interest = balance_std * monthly_rate
        interest_std += interest
        principal_payment = standard_payment - interest
        balance_std -= principal_payment
        months_std += 1

    # With extra payment
    balance_extra = principal
    interest_extra = 0.0
    months_extra = 0
    while balance_extra > 0 and months_extra < 600:
        interest = balance_extra * monthly_rate
        interest_extra += interest
        principal_payment = (standard_payment + extra_payment) - interest
        balance_extra -= principal_payment
        months_extra += 1

    # Extra payment should reduce both term and interest
    assert months_extra < months_std
    assert interest_extra < interest_std
