"""Loan amortization endpoints.

Tier-A loan-planning surface. For any loan-type Account in the system
(Plaid mortgage / Plaid auto / Plaid student / manual liability),
returns a full amortization schedule + summary, with optional extra
principal per month for "what if" modeling.

For mortgages with Plaid Liabilities data the rate / payment /
origination come from `MortgageDetail` automatically. For other loans
the user passes overrides via query params (rate, payment, term).

Companion to /api/networth and /api/accounts — those continue to track
the running balance; this endpoint adds the time dimension on top.
"""
from __future__ import annotations

import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Account, ManualAsset, MortgageDetail
from app.services.amortization import (
    compute_pi_payment,
    compute_remaining_months,
    compute_schedule,
    compute_summary,
    compare_extra_payment,
    compare_biweekly,
    compare_refinance,
    compute_heloc_schedule,
    find_pmi_dropoff,
)


router = APIRouter(prefix="/api/loans", tags=["loans"])


# Composite-ID prefixes so a single endpoint can route to either the
# accounts table (Plaid mortgages, HELOCs) or the manual_assets table
# (auto loans, student loans, anything Plaid-Liabilities can't reach).
# Format: "acct-N" or "liab-N".
_ACCT = "acct-"
_LIAB = "liab-"


def _parse_loan_id(loan_id: str) -> tuple[str, int]:
    """Split a composite loan_id into (kind, numeric_id). Raises 400
    for malformed input."""
    for prefix, kind in ((_ACCT, "account"), (_LIAB, "liability")):
        if loan_id.startswith(prefix):
            try:
                return kind, int(loan_id[len(prefix):])
            except ValueError:
                pass
    raise HTTPException(400, f"Invalid loan id '{loan_id}'. Expected acct-N or liab-N.")


def _subtype_for_manual(asset_type: str) -> str:
    """Map ManualAsset.type → loan-page subtype keyword."""
    return {
        "auto_loan": "auto",
        "student_loan": "student",
        "personal_loan": "personal",
    }.get(asset_type, "personal")


def _resolve_loan(
    loan_id: str,
    db: Session,
    rate_override: Optional[float],
    payment_override: Optional[float],
):
    """Shared loan-resolution helper used by every per-loan endpoint.

    Returns (principal, rate, payment, loan_meta, mortgage_detail).
    Raises 404 if the loan doesn't exist; 400 if rate or payment can't
    be resolved (no Plaid data + no override).
    """
    kind, num_id = _parse_loan_id(loan_id)
    md = None
    if kind == "account":
        acct = db.query(Account).filter_by(id=num_id).first()
        if not acct:
            raise HTTPException(404, "Account not found")
        principal = abs(acct.current_balance or 0.0)
        loan_meta = {
            "id": loan_id,
            "name": acct.custom_name or acct.name,
            "type": acct.type,
            "subtype": acct.subtype,
            "source": "account",
        }
        md = (
            db.query(MortgageDetail)
            .filter_by(account_id=num_id)
            .first()
        )
        default_rate = md.interest_rate_percentage / 100 if md and md.interest_rate_percentage else None
        default_payment = md.next_monthly_payment if md and md.next_monthly_payment else None
    else:
        liab = db.query(ManualAsset).filter_by(id=num_id).first()
        if not liab or liab.side != "liability":
            raise HTTPException(404, "Liability not found")
        principal = abs(liab.current_value or 0.0)
        loan_meta = {
            "id": loan_id,
            "name": liab.name,
            "type": "loan",
            "subtype": _subtype_for_manual(liab.type),
            "source": "liability",
        }
        default_rate = None
        default_payment = None

    rate = rate_override if rate_override is not None else default_rate
    if rate is None:
        raise HTTPException(
            400,
            "Loan has no interest rate on file. Pass rate_override (e.g. 0.0625 for 6.25%).",
        )
    payment = payment_override if payment_override is not None else default_payment
    if payment is None:
        raise HTTPException(
            400,
            "Loan has no monthly payment on file. Pass payment_override.",
        )
    return principal, rate, payment, loan_meta, md


@router.get("/")
def list_loans(db: Session = Depends(get_db)):
    """All loan-shaped objects with quick payoff metadata. Unions:

    - **Accounts** with type='loan' or loan-ish subtype (Plaid
      mortgages + HELOCs).
    - **ManualAssets** with side='liability' (auto loans, student
      loans, personal loans the user enters by hand because Plaid
      doesn't have a clean integration).

    Each row carries a composite `id` (acct-N or liab-N) so the
    amortization endpoint can route back to the correct source.
    """
    out = []

    # ── Accounts: Plaid-synced loans ──
    acct_rows = (
        db.query(Account)
        .filter(
            (Account.type == "loan")
            | (Account.subtype.in_((
                "mortgage", "auto", "student", "personal", "credit card",
                # HELOC variants — Plaid normalizes to a few different
                # spellings depending on the institution.
                "home equity", "heloc", "line of credit",
            )))
        )
        .all()
    )
    for acct in acct_rows:
        # Skip credit cards from the loan-planning view — their payoff
        # math is meaningless without per-statement APR + payment terms.
        if acct.subtype == "credit card":
            continue
        md = (
            db.query(MortgageDetail)
            .filter_by(account_id=acct.id)
            .first()
        )
        rate = md.interest_rate_percentage / 100 if md and md.interest_rate_percentage else None
        payment = md.next_monthly_payment if md and md.next_monthly_payment else None
        months_remaining = None
        if rate and payment and acct.current_balance:
            months_remaining = compute_remaining_months(
                abs(acct.current_balance), rate, payment
            )
        out.append({
            "id": f"{_ACCT}{acct.id}",
            "source": "account",
            "name": acct.custom_name or acct.name,
            "type": acct.type,
            "subtype": acct.subtype,
            "balance": abs(acct.current_balance or 0.0),
            "interest_rate": rate,
            "monthly_payment": payment,
            "months_remaining": months_remaining,
            "maturity_date": md.maturity_date.isoformat() if md and md.maturity_date else None,
            "origination_date": md.origination_date.isoformat() if md and md.origination_date else None,
            "has_pmi": md.has_pmi if md else None,
            "has_mortgage_detail": md is not None,
        })

    # ── Manual liabilities: auto, student, personal loans ──
    # No rate/payment stored on ManualAsset today — user supplies via
    # overrides on the Loans page (persisted to localStorage).
    liab_rows = (
        db.query(ManualAsset)
        .filter(ManualAsset.side == "liability")
        .all()
    )
    for liab in liab_rows:
        out.append({
            "id": f"{_LIAB}{liab.id}",
            "source": "liability",
            "name": liab.name,
            "type": "loan",
            "subtype": _subtype_for_manual(liab.type),
            "balance": abs(liab.current_value or 0.0),
            # Manual liabilities have no rate/payment in DB. The Loans
            # page surfaces the overrides input automatically when these
            # are null, so the user just types them once.
            "interest_rate": None,
            "monthly_payment": None,
            "months_remaining": None,
            "maturity_date": None,
            "origination_date": None,
            "has_pmi": None,
            "has_mortgage_detail": False,
        })

    # Sort largest-balance-first across both sources.
    out.sort(key=lambda r: r["balance"], reverse=True)
    return {"loans": out}


@router.get("/{loan_id}/amortization")
def amortization(
    loan_id: str,
    extra_principal: float = Query(0.0, ge=0, le=50000,
        description="Extra principal $/mo for what-if modeling. 0 = baseline schedule."),
    # Overrides — used when the loan doesn't have MortgageDetail
    # (auto loan, manual liability) and the user supplies the terms.
    rate_override: Optional[float] = Query(None, ge=0, le=0.30,
        description="Annual rate (e.g. 0.0625). Overrides MortgageDetail when set."),
    payment_override: Optional[float] = Query(None, ge=0, le=50000,
        description="Monthly P+I payment. Overrides MortgageDetail when set."),
    db: Session = Depends(get_db),
):
    """Month-by-month amortization for a single loan, with side-by-side
    comparison vs no-extra-payment baseline.

    `loan_id` is composite (acct-N for accounts table, liab-N for
    manual_assets). Routes to the right source automatically.

    Response shape:
        loan: {balance, rate, payment, ...}
        schedule: [{month, date, beginning_balance, payment, interest,
                    principal, extra_principal, ending_balance}, ...]
        summary: {months, payoff_date, total_paid, total_interest, ...}
        comparison: {months_saved, interest_saved, ...} (only when
            extra_principal > 0)
    """
    principal, rate, payment, loan_meta, md = _resolve_loan(
        loan_id, db, rate_override, payment_override,
    )

    if principal <= 0:
        return {
            "loan": {**loan_meta, "balance": 0.0, "rate": rate, "payment": payment,
                     "has_mortgage_detail": md is not None},
            "schedule": [],
            "summary": compute_summary([]),
            "comparison": None,
        }

    schedule = compute_schedule(
        principal=principal,
        annual_rate=rate,
        monthly_payment=payment,
        extra_principal=extra_principal,
    )
    summary = compute_summary(schedule)

    comparison = None
    if extra_principal > 0:
        comparison = compare_extra_payment(
            principal=principal,
            annual_rate=rate,
            monthly_payment=payment,
            extra_principal=extra_principal,
        )

    return {
        "loan": {
            **loan_meta,
            "balance": principal,
            "rate": rate,
            "payment": payment,
            "has_mortgage_detail": md is not None,
            "ytd_principal_paid": md.ytd_principal_paid if md else None,
            "ytd_interest_paid": md.ytd_interest_paid if md else None,
            "origination_date": md.origination_date.isoformat() if md and md.origination_date else None,
            "maturity_date": md.maturity_date.isoformat() if md and md.maturity_date else None,
        },
        "schedule": schedule,
        "summary": summary,
        "comparison": comparison,
    }


@router.get("/{loan_id}/biweekly")
def biweekly(
    loan_id: str,
    rate_override: Optional[float] = Query(None, ge=0, le=0.30),
    payment_override: Optional[float] = Query(None, ge=0, le=50000),
    db: Session = Depends(get_db),
):
    """Compare standard monthly schedule vs accelerated bi-weekly.

    Bi-weekly = pay HALF the monthly amount every 2 weeks → 26 half-
    payments/yr = 13 monthly equivalents (one extra "13th" payment).
    Typically pays off a 30-yr mortgage 5-7 years early. The
    consumer-finance no-brainer most banks won't proactively offer.
    """
    principal, rate, payment, loan_meta, _ = _resolve_loan(
        loan_id, db, rate_override, payment_override,
    )
    return {
        "loan": loan_meta,
        "principal": principal,
        **compare_biweekly(principal, rate, payment),
    }


@router.get("/{loan_id}/refinance")
def refinance(
    loan_id: str,
    new_rate: float = Query(..., ge=0, le=0.30,
        description="New annual rate (e.g. 0.055 for 5.5%)"),
    new_term_months: int = Query(..., ge=12, le=480,
        description="New loan term in months (e.g. 360 for 30 years)"),
    closing_costs: float = Query(0.0, ge=0, le=100000,
        description="Up-front closing costs (origination, appraisal, title, etc.)"),
    rate_override: Optional[float] = Query(None, ge=0, le=0.30),
    payment_override: Optional[float] = Query(None, ge=0, le=50000),
    db: Session = Depends(get_db),
):
    """Side-by-side current loan vs refinance into new_rate / new_term.

    Returns monthly savings, lifetime interest saved, and break-even
    months on the closing costs. The honest "should I refi" answer
    treats closing costs as cost-of-ownership not a freebie.
    """
    principal, rate, payment, loan_meta, _ = _resolve_loan(
        loan_id, db, rate_override, payment_override,
    )
    return {
        "loan": loan_meta,
        "principal": principal,
        **compare_refinance(
            current_balance=principal,
            current_rate=rate,
            current_payment=payment,
            new_rate=new_rate,
            new_term_months=new_term_months,
            closing_costs=closing_costs,
        ),
    }


@router.get("/{loan_id}/heloc")
def heloc(
    loan_id: str,
    draw_period_months_remaining: int = Query(..., ge=0, le=240,
        description="Months left in interest-only draw phase. 0 = already in repayment."),
    repayment_period_months: int = Query(240, ge=12, le=480,
        description="Repayment period after draw ends. Typical 15-20 yrs."),
    extra_principal: float = Query(0.0, ge=0, le=50000),
    rate_override: Optional[float] = Query(None, ge=0, le=0.30),
    payment_override: Optional[float] = Query(None, ge=0, le=50000),
    db: Session = Depends(get_db),
):
    """HELOC-specific amortization with two-phase modeling: interest-
    only draw period, then P+I repayment. Most homeowners with HELOCs
    don't realize the payment shock that hits when draw period ends —
    monthly cost can 2-3× overnight. This surfaces it explicitly."""
    principal, rate, _, loan_meta, _ = _resolve_loan(
        loan_id, db, rate_override, payment_override,
    )
    schedule = compute_heloc_schedule(
        principal=principal,
        annual_rate=rate,
        draw_period_months_remaining=draw_period_months_remaining,
        repayment_period_months=repayment_period_months,
        extra_principal=extra_principal,
    )
    summary = compute_summary(schedule)
    # Detect the payment-shock month (last draw → first repayment)
    last_draw = next(
        (r for r in reversed(schedule) if r.get("phase") == "draw"),
        None,
    )
    first_repay = next(
        (r for r in schedule if r.get("phase") == "repayment"),
        None,
    )
    payment_shock = None
    if last_draw and first_repay:
        payment_shock = {
            "draw_payment": last_draw["payment"],
            "repayment_payment": first_repay["payment"],
            "shock_amount": round(first_repay["payment"] - last_draw["payment"], 2),
            "shock_multiple": round(
                first_repay["payment"] / max(0.01, last_draw["payment"]), 2
            ),
            "shock_date": first_repay["date"],
        }
    return {
        "loan": loan_meta,
        "principal": principal,
        "rate": rate,
        "draw_period_months_remaining": draw_period_months_remaining,
        "repayment_period_months": repayment_period_months,
        "schedule": schedule,
        "summary": summary,
        "payment_shock": payment_shock,
    }


@router.get("/{loan_id}/pmi-dropoff")
def pmi_dropoff(
    loan_id: str,
    original_purchase_price: float = Query(..., gt=0,
        description="Original home purchase price (PMI uses this as the LTV denominator)."),
    pmi_monthly_cost: float = Query(0.0, ge=0,
        description="Current PMI premium $/mo (typical: 0.5% of original loan / 12). "
                    "Pass 0 to skip the savings figure."),
    ltv_threshold: float = Query(0.80, ge=0.50, le=1.0,
        description="LTV ratio at which PMI auto-cancels. Federal HPA threshold is 0.80."),
    rate_override: Optional[float] = Query(None, ge=0, le=0.30),
    payment_override: Optional[float] = Query(None, ge=0, le=50000),
    db: Session = Depends(get_db),
):
    """Find the projected month the loan balance crosses the LTV
    threshold (default 80% of original purchase price), at which point
    PMI is borrower-cancellable under the federal HPA. Banks often
    miss the auto-cancellation date — this surfaces it explicitly with
    a savings estimate."""
    principal, rate, payment, loan_meta, _ = _resolve_loan(
        loan_id, db, rate_override, payment_override,
    )
    return {
        "loan": loan_meta,
        **find_pmi_dropoff(
            current_balance=principal,
            annual_rate=rate,
            monthly_payment=payment,
            original_purchase_price=original_purchase_price,
            pmi_monthly_cost=pmi_monthly_cost,
            ltv_threshold=ltv_threshold,
        ),
    }
