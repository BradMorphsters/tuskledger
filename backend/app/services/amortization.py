"""Loan amortization math.

Pure functions — no DB or HTTP dependencies. Given (principal, annual
rate, monthly payment), produce a month-by-month schedule and aggregate
summary stats. Supports optional extra principal per month so the
"what if I pay extra" slider just calls this with different values.

For mortgages with Plaid Liabilities data, the rate / payment / origination
date come from MortgageDetail. For other loans (auto, manually-entered)
the user enters the terms; the math is the same.

Conventions:
    - All rates are ANNUAL nominal (e.g., 0.0625 for 6.25%). Internal
      math converts to monthly = annual / 12.
    - Payments are monthly P+I only. Escrow (taxes + insurance) is
      tracked separately on the account; it doesn't amortize.
    - Extra principal is a fixed extra amount applied each month BEYOND
      the standard P+I. Not a one-time lump sum (that's a separate
      mechanic — TODO if needed).
    - When extra_principal is large enough that ending_balance would go
      negative in a given month, that month's payment is reduced to
      exactly clear the balance (no overpayment).
"""
from __future__ import annotations

import datetime
from typing import Optional


def compute_pi_payment(
    principal: float,
    annual_rate: float,
    total_months: int,
) -> float:
    """Standard mortgage P+I payment formula.

    P&I = principal × (r × (1+r)^n) / ((1+r)^n − 1)
    where r = monthly rate, n = total months.

    Handles edge case of 0% rate (just principal / months).
    """
    if total_months <= 0:
        return 0.0
    if annual_rate <= 0:
        return principal / total_months
    r = annual_rate / 12
    factor = (1 + r) ** total_months
    return principal * (r * factor) / (factor - 1)


def compute_remaining_months(
    principal: float,
    annual_rate: float,
    monthly_payment: float,
) -> int:
    """How many months until payoff at the given fixed monthly payment.

    Useful when we have current balance + payment + rate but not the
    original term. Inverts the P&I formula:
        n = -log(1 − (P × r) / pmt) / log(1 + r)
    """
    if principal <= 0 or monthly_payment <= 0:
        return 0
    if annual_rate <= 0:
        return int(-(-principal // monthly_payment))  # ceil
    r = annual_rate / 12
    if monthly_payment <= principal * r:
        # Payment doesn't even cover interest — would never pay off.
        # Sentinel: 1200 months (100 yrs) so the UI can flag it.
        return 1200
    import math
    n = -math.log(1 - (principal * r) / monthly_payment) / math.log(1 + r)
    return int(round(n))


def compute_schedule(
    principal: float,
    annual_rate: float,
    monthly_payment: float,
    extra_principal: float = 0.0,
    start_date: Optional[datetime.date] = None,
    max_months: int = 600,  # 50-year safety cap
) -> list[dict]:
    """Month-by-month amortization schedule.

    Each row:
        month: 1-indexed month number from now
        date: ISO month-end date (approximate)
        beginning_balance: balance before this month's payment
        payment: total payment this month (P+I + extra principal)
        interest: portion that went to interest
        principal: portion that went to standard principal
        extra_principal: portion that was extra-paid against principal
        ending_balance: balance after this month's payment

    Stops when balance hits 0 (or max_months as a safety cap).
    """
    if start_date is None:
        start_date = datetime.date.today()
    rows = []
    balance = float(principal)
    r = annual_rate / 12 if annual_rate > 0 else 0.0
    extra = max(0.0, float(extra_principal))
    base_payment = float(monthly_payment)

    month = 0
    while balance > 0.01 and month < max_months:
        month += 1
        beginning = balance
        interest = beginning * r if r > 0 else 0.0
        # Standard principal = base_payment - interest. Floored at 0
        # so a too-low payment doesn't go negative (would be flagged
        # by compute_remaining_months returning 1200).
        std_principal = max(0.0, base_payment - interest)
        # Apply extras after standard. Both clamped so we don't
        # over-pay on the final month.
        total_principal_paid = min(std_principal + extra, beginning)
        actual_payment = interest + total_principal_paid
        # If extras consumed more than std, attribute the overage as extra.
        actual_extra = max(0.0, total_principal_paid - std_principal)
        actual_std = total_principal_paid - actual_extra
        ending = beginning - total_principal_paid
        # Approximate month-end date: shift by `month` months from start.
        approx_date = _add_months(start_date, month)
        rows.append({
            "month": month,
            "date": approx_date.isoformat(),
            "beginning_balance": round(beginning, 2),
            "payment": round(actual_payment, 2),
            "interest": round(interest, 2),
            "principal": round(actual_std, 2),
            "extra_principal": round(actual_extra, 2),
            "ending_balance": round(ending, 2),
        })
        balance = ending
    return rows


def compute_summary(schedule: list[dict]) -> dict:
    """Roll up an amortization schedule into headline numbers."""
    if not schedule:
        return {
            "months": 0,
            "payoff_date": None,
            "total_paid": 0.0,
            "total_principal": 0.0,
            "total_interest": 0.0,
            "total_extra_principal": 0.0,
        }
    return {
        "months": len(schedule),
        "payoff_date": schedule[-1]["date"],
        "total_paid": round(sum(r["payment"] for r in schedule), 2),
        "total_principal": round(sum(r["principal"] for r in schedule), 2),
        "total_interest": round(sum(r["interest"] for r in schedule), 2),
        "total_extra_principal": round(sum(r["extra_principal"] for r in schedule), 2),
    }


def compare_extra_payment(
    principal: float,
    annual_rate: float,
    monthly_payment: float,
    extra_principal: float,
    start_date: Optional[datetime.date] = None,
) -> dict:
    """Side-by-side: baseline (no extra) vs with extra-principal slider.

    Returns the difference numbers the UI shows: months saved, total
    interest saved, payoff dates for both, and whether extra is even
    big enough to matter (sometimes a $25/mo extra is rounding noise).
    """
    base = compute_schedule(principal, annual_rate, monthly_payment, 0.0, start_date)
    extra = compute_schedule(principal, annual_rate, monthly_payment, extra_principal, start_date)
    base_sum = compute_summary(base)
    extra_sum = compute_summary(extra)
    return {
        "extra_principal_per_month": round(extra_principal, 2),
        "baseline": base_sum,
        "with_extra": extra_sum,
        "months_saved": base_sum["months"] - extra_sum["months"],
        "interest_saved": round(base_sum["total_interest"] - extra_sum["total_interest"], 2),
        "total_paid_saved": round(base_sum["total_paid"] - extra_sum["total_paid"], 2),
    }


def _add_months(start: datetime.date, months: int) -> datetime.date:
    """Add N months to a date, snapping to month-end if needed."""
    new_year = start.year + (start.month - 1 + months) // 12
    new_month = (start.month - 1 + months) % 12 + 1
    # Snap to last day of new month if start.day exceeds it.
    import calendar
    last_day = calendar.monthrange(new_year, new_month)[1]
    return datetime.date(new_year, new_month, min(start.day, last_day))


# ─── HELOC amortization (interest-only draw → P+I repayment) ───────


def compute_heloc_schedule(
    principal: float,
    annual_rate: float,
    draw_period_months_remaining: int,
    repayment_period_months: int,
    extra_principal: float = 0.0,
    start_date: Optional[datetime.date] = None,
) -> list[dict]:
    """HELOC-specific amortization. HELOCs have two phases:

    1. Draw period (typically 10 yrs from origination): interest-only
       payments. Principal stays flat unless borrower voluntarily
       pays extra. Variable rate (modeled as fixed here for projection
       cleanliness — user can re-run if rate changes).
    2. Repayment period (typically 15-20 yrs after draw ends):
       converts to standard P+I amortization on the remaining
       principal, fully amortizing over the repayment term.

    `draw_period_months_remaining` = months left in the draw phase
    from today. 0 means already in repayment.

    During draw: payment = principal × annual_rate / 12 (interest only)
    plus any extra_principal (which actually reduces balance).
    During repayment: standard amortization formula on remaining
    balance over repayment_period_months.
    """
    if start_date is None:
        start_date = datetime.date.today()
    rows = []
    balance = float(principal)
    r = annual_rate / 12 if annual_rate > 0 else 0.0
    extra = max(0.0, float(extra_principal))

    month = 0
    # ── Draw phase: interest-only ──
    while balance > 0.01 and month < draw_period_months_remaining:
        month += 1
        beginning = balance
        interest = beginning * r
        # Principal paid = extras only (no scheduled principal during draw)
        principal_paid = min(extra, beginning)
        actual_payment = interest + principal_paid
        ending = beginning - principal_paid
        rows.append({
            "month": month,
            "date": _add_months(start_date, month).isoformat(),
            "beginning_balance": round(beginning, 2),
            "payment": round(actual_payment, 2),
            "interest": round(interest, 2),
            "principal": 0.0,
            "extra_principal": round(principal_paid, 2),
            "ending_balance": round(ending, 2),
            "phase": "draw",
        })
        balance = ending

    # ── Repayment phase: standard P+I ──
    if balance > 0.01 and repayment_period_months > 0:
        # Compute the P+I payment based on remaining balance + remaining term.
        repay_payment = compute_pi_payment(balance, annual_rate, repayment_period_months)
        repay_month_count = 0
        while balance > 0.01 and repay_month_count < repayment_period_months:
            month += 1
            repay_month_count += 1
            beginning = balance
            interest = beginning * r
            std_principal = max(0.0, repay_payment - interest)
            total_principal = min(std_principal + extra, beginning)
            actual_payment = interest + total_principal
            actual_extra = max(0.0, total_principal - std_principal)
            actual_std = total_principal - actual_extra
            ending = beginning - total_principal
            rows.append({
                "month": month,
                "date": _add_months(start_date, month).isoformat(),
                "beginning_balance": round(beginning, 2),
                "payment": round(actual_payment, 2),
                "interest": round(interest, 2),
                "principal": round(actual_std, 2),
                "extra_principal": round(actual_extra, 2),
                "ending_balance": round(ending, 2),
                "phase": "repayment",
            })
            balance = ending

    return rows


# ─── Bi-weekly payment comparison ──────────────────────────────────


def compare_biweekly(
    principal: float,
    annual_rate: float,
    monthly_payment: float,
    start_date: Optional[datetime.date] = None,
) -> dict:
    """Compare standard monthly schedule vs accelerated bi-weekly.

    Bi-weekly mechanic: pay HALF the monthly amount every two weeks.
    26 half-payments per year = 13 full-payment equivalents/yr (one
    extra "13th" payment compared to a 12-month schedule). All of
    that 13th payment lands on principal, dramatically shortening
    the term.

    Implementation shortcut: model bi-weekly as a monthly schedule with
    extra principal = monthly_payment / 12 added each month. Same final
    answer, much simpler than tracking 26 half-period intervals. The
    half-payment-twice-a-month version saves trivially less interest
    than the true bi-weekly because the timing-arbitrage portion is
    small relative to the 13th-payment portion.
    """
    extra_per_month = monthly_payment / 12
    standard = compute_schedule(principal, annual_rate, monthly_payment, 0.0, start_date)
    biweekly = compute_schedule(
        principal, annual_rate, monthly_payment, extra_per_month, start_date,
    )
    std_sum = compute_summary(standard)
    bw_sum = compute_summary(biweekly)
    return {
        "monthly_payment": round(monthly_payment, 2),
        "biweekly_half_payment": round(monthly_payment / 2, 2),
        "extra_principal_equivalent": round(extra_per_month, 2),
        "standard": std_sum,
        "biweekly": bw_sum,
        "months_saved": std_sum["months"] - bw_sum["months"],
        "interest_saved": round(std_sum["total_interest"] - bw_sum["total_interest"], 2),
    }


# ─── Refinance modeler ─────────────────────────────────────────────


def compare_refinance(
    current_balance: float,
    current_rate: float,
    current_payment: float,
    new_rate: float,
    new_term_months: int,
    closing_costs: float = 0.0,
    start_date: Optional[datetime.date] = None,
) -> dict:
    """Side-by-side: stay-on-current-loan vs refinance into a new loan.

    Refinance assumed to roll the current_balance unchanged into a new
    loan at new_rate for new_term_months. Closing costs are paid up-
    front (financed-into-the-new-loan would change the balance — TODO
    if anyone actually wants that flavor).

    Break-even = months until cumulative monthly savings (under refi)
    have offset the closing costs paid up front. Assumes you save the
    monthly payment differential rather than spending it.

    Returns:
        current: {payment, months, total_interest, total_paid}
        refinanced: {payment, months, total_interest, total_paid,
                     closing_costs}
        monthly_savings: refinanced.payment − current.payment (negative
                         if new payment is HIGHER, e.g. shorter term)
        lifetime_interest_saved
        breakeven_months: months for monthly savings to recoup closing
                          costs. None when monthly_savings <= 0.
    """
    current_sched = compute_schedule(
        current_balance, current_rate, current_payment, 0.0, start_date,
    )
    current_sum = compute_summary(current_sched)

    new_payment = compute_pi_payment(current_balance, new_rate, new_term_months)
    refi_sched = compute_schedule(
        current_balance, new_rate, new_payment, 0.0, start_date,
    )
    refi_sum = compute_summary(refi_sched)

    # Monthly savings = OLD payment - NEW payment. Positive = save $/mo.
    monthly_savings = current_payment - new_payment
    breakeven_months = None
    if monthly_savings > 0 and closing_costs > 0:
        breakeven_months = int(round(closing_costs / monthly_savings))
    elif monthly_savings > 0:
        breakeven_months = 0  # no closing costs → instant savings

    return {
        "current": {
            "payment": round(current_payment, 2),
            "rate": current_rate,
            "months": current_sum["months"],
            "total_interest": current_sum["total_interest"],
            "total_paid": current_sum["total_paid"],
        },
        "refinanced": {
            "payment": round(new_payment, 2),
            "rate": new_rate,
            "term_months": new_term_months,
            "months": refi_sum["months"],
            "total_interest": refi_sum["total_interest"],
            "total_paid": refi_sum["total_paid"],
            "closing_costs": round(closing_costs, 2),
        },
        "monthly_savings": round(monthly_savings, 2),
        "lifetime_interest_saved": round(
            current_sum["total_interest"] - refi_sum["total_interest"], 2
        ),
        # Total cost of ownership comparison: includes closing costs in
        # the refi side. The honest "should I refi" answer.
        "lifetime_total_paid_diff": round(
            current_sum["total_paid"] - (refi_sum["total_paid"] + closing_costs), 2
        ),
        "breakeven_months": breakeven_months,
    }


# ─── PMI drop-off detection ────────────────────────────────────────


def find_pmi_dropoff(
    current_balance: float,
    annual_rate: float,
    monthly_payment: float,
    original_purchase_price: float,
    pmi_monthly_cost: float = 0.0,
    ltv_threshold: float = 0.80,
    start_date: Optional[datetime.date] = None,
) -> dict:
    """Find the month the amortizing balance crosses ltv_threshold of
    the original purchase price (default 80%, the federal HPA threshold
    for borrower-requested PMI cancellation).

    Returns the projected drop-off month + date + a savings estimate.
    The user supplies pmi_monthly_cost since neither Plaid nor the
    schema track it (typical: 0.5% of original loan / 12). Pass 0 to
    skip the savings figure.
    """
    threshold_balance = original_purchase_price * ltv_threshold
    if current_balance <= threshold_balance:
        # Already below — nothing to do.
        return {
            "already_below": True,
            "ltv_threshold": ltv_threshold,
            "threshold_balance": round(threshold_balance, 2),
            "current_balance": round(current_balance, 2),
            "months_until_dropoff": 0,
            "dropoff_date": None,
            "estimated_monthly_savings": 0.0,
            "estimated_lifetime_savings": 0.0,
        }
    schedule = compute_schedule(
        current_balance, annual_rate, monthly_payment, 0.0, start_date,
    )
    drop_row = next(
        (r for r in schedule if r["ending_balance"] <= threshold_balance),
        None,
    )
    if drop_row is None:
        # Loan pays off before reaching the threshold (shouldn't happen
        # for a fresh loan with PMI, but possible if user is already
        # close to payoff).
        return {
            "already_below": False,
            "ltv_threshold": ltv_threshold,
            "threshold_balance": round(threshold_balance, 2),
            "current_balance": round(current_balance, 2),
            "months_until_dropoff": None,
            "dropoff_date": None,
            "estimated_monthly_savings": 0.0,
            "estimated_lifetime_savings": 0.0,
            "note": "Balance never reaches the threshold under current schedule.",
        }
    months_remaining_after_dropoff = len(schedule) - drop_row["month"]
    return {
        "already_below": False,
        "ltv_threshold": ltv_threshold,
        "threshold_balance": round(threshold_balance, 2),
        "current_balance": round(current_balance, 2),
        "months_until_dropoff": drop_row["month"],
        "dropoff_date": drop_row["date"],
        "estimated_monthly_savings": round(pmi_monthly_cost, 2),
        "estimated_lifetime_savings": round(
            pmi_monthly_cost * months_remaining_after_dropoff, 2
        ),
    }
