"""Whole-household debt plan: totals, payoff timeline and strategy comparison.

Pure functions over plain dicts so they're easy to test. The Loans router
gathers each loan and hands this module a list of *debts*:

    {
      "id": "acct-11", "name": "Mortgage", "kind": "mortgage",
      "escrow": 350.0,                      # non-P&I part of the payment (0 if none)
      "pieces": [                           # one piece, or one per sub-loan
        {"label": "...", "balance": 95000.0, "rate": 0.02625, "payment": 1042.7},
      ],
    }

A *piece* is the unit that accrues interest and gets paid: an ordinary
loan has one; a federal student loan made of several loans has one per
loan, so extra money can target the highest-rate one first.

Three plans are compared:

- **current** — every piece pays its scheduled payment; nothing extra;
  when a loan is paid off, that money simply stops going to debt.
- **avalanche** — the extra amount, plus every payment freed when a loan
  is paid off ("rollover"), goes to the highest-rate piece first. Minimizes
  total interest.
- **snowball** — same pool, but to the smallest balance first. Pays loans
  off sooner one-by-one, usually at a little more total interest.
"""
from __future__ import annotations

import datetime
from typing import Optional

from app.services.amortization import _add_months, compute_pi_payment

STRATEGIES = ("current", "avalanche", "snowball")
_STANDARD_TERMS = (120, 180, 240, 300, 360)  # 10, 15, 20, 25, 30 years


# ─── Mortgage term inference ─────────────────────────────────────────

def _balance_after(principal: float, annual_rate: float, payment: float, k: int) -> float:
    r = annual_rate / 12
    if r <= 0:
        return principal - payment * k
    g = (1 + r) ** k
    return principal * g - payment * (g - 1) / r


def _months_between(a: datetime.date, b: datetime.date) -> int:
    return (b.year - a.year) * 12 + (b.month - a.month)


def _parse_term_months(loan_term: Optional[str]) -> Optional[int]:
    """'30 year', '30 years', '360', '360 months' -> months."""
    if not loan_term:
        return None
    digits = "".join(ch if ch.isdigit() else " " for ch in str(loan_term)).split()
    if not digits:
        return None
    n = int(digits[0])
    text = str(loan_term).lower()
    if "year" in text or "yr" in text or n <= 50:
        return n * 12
    return n


def infer_mortgage_pi(
    origination_amount: Optional[float],
    origination_date: Optional[datetime.date],
    annual_rate: Optional[float],
    current_balance: Optional[float],
    today: Optional[datetime.date] = None,
    loan_term: Optional[str] = None,
    maturity_date: Optional[datetime.date] = None,
    tolerance: float = 0.03,
) -> Optional[dict]:
    """Recover a fixed-rate mortgage's principal-and-interest payment.

    Servicers usually report the *total* monthly payment, which includes
    escrow (property tax and insurance). Amortizing the total as if it
    were P&I pays the loan off years too early. With the original amount,
    origination date and rate, the P&I payment follows from the term; when
    the servicer doesn't report the term, try the standard terms and keep
    the one whose expected balance today matches the reported balance
    (within `tolerance`, allowing a month or two of payment timing).

    Returns {"term_months", "pi_payment", "maturity_date", "source"} or None
    when it can't be determined confidently.
    """
    if not (origination_amount and origination_date and annual_rate and current_balance):
        return None
    today = today or datetime.date.today()
    elapsed = _months_between(origination_date, today)
    if elapsed <= 0:
        return None

    candidates: list[tuple[int, str]] = []
    reported = _parse_term_months(loan_term)
    if reported:
        candidates.append((reported, "reported term"))
    if maturity_date:
        candidates.append((_months_between(origination_date, maturity_date), "reported maturity"))
    candidates += [(t, "inferred from balance") for t in _STANDARD_TERMS]

    best = None
    for term, source in candidates:
        if term <= elapsed:
            continue
        pi = compute_pi_payment(origination_amount, annual_rate, term)
        # First payment is typically 1–2 months after closing.
        errs = [abs(_balance_after(origination_amount, annual_rate, pi, k) - current_balance)
                for k in (elapsed - 2, elapsed - 1, elapsed) if k > 0]
        err = min(errs) / current_balance
        if source != "inferred from balance" and err <= tolerance * 2:
            return {"term_months": term, "pi_payment": round(pi, 2),
                    "maturity_date": _add_months(origination_date, term + 1).isoformat(), "source": source}
        if best is None or err < best[0]:
            best = (err, term, pi)
    if best and best[0] <= tolerance:
        _, term, pi = best
        return {"term_months": term, "pi_payment": round(pi, 2),
                "maturity_date": _add_months(origination_date, term + 1).isoformat(),
                "source": "inferred from balance"}
    return None


# ─── Simulation ──────────────────────────────────────────────────────

def _pieces(debts: list[dict]) -> list[dict]:
    out = []
    for d in debts:
        for p in d["pieces"]:
            if float(p.get("balance") or 0) > 0.01:
                out.append({
                    "debt_id": d["id"], "debt_name": d["name"],
                    "balance": float(p["balance"]), "rate": float(p.get("rate") or 0),
                    "payment": float(p.get("payment") or 0), "paid_off_month": None,
                })
    return out


def simulate(
    debts: list[dict],
    strategy: str = "current",
    extra: float = 0.0,
    start_date: Optional[datetime.date] = None,
    max_months: int = 600,
) -> dict:
    """Month-by-month payoff of every debt under one strategy.

    Returns months to debt-free, the date, total interest and amount paid,
    when each loan is fully paid off (in order), and a monthly series of
    total balance and total payment (P&I only) for charts.
    """
    if strategy not in STRATEGIES:
        raise ValueError(f"unknown strategy {strategy!r}")
    start_date = start_date or datetime.date.today()
    pieces = _pieces(debts)
    use_pool = strategy != "current"
    extra = max(0.0, float(extra)) if use_pool else 0.0

    total_interest = total_paid = 0.0
    series = []
    month = 0
    while any(p["balance"] > 0.01 for p in pieces) and month < max_months:
        month += 1
        pool = extra
        if use_pool:
            # Rollover: payments of pieces already paid off keep going to debt.
            pool += sum(p["payment"] for p in pieces if p["paid_off_month"] is not None)
        paid_this_month = 0.0
        for p in pieces:
            if p["balance"] <= 0.01:
                continue
            interest = p["balance"] * p["rate"] / 12
            due = p["balance"] + interest
            pay = min(p["payment"], due)
            p["balance"] = due - pay
            total_interest += interest
            paid_this_month += pay
            if pay < p["payment"] and use_pool:
                pool += p["payment"] - pay   # a final partial payment frees the rest
        if use_pool and pool > 0.005:
            key = (lambda p: (-p["rate"], p["balance"])) if strategy == "avalanche" else (lambda p: (p["balance"], -p["rate"]))
            for p in sorted((p for p in pieces if p["balance"] > 0.01), key=key):
                if pool <= 0.005:
                    break
                applied = min(pool, p["balance"])
                p["balance"] -= applied
                pool -= applied
                paid_this_month += applied
        for p in pieces:
            if p["balance"] <= 0.01 and p["paid_off_month"] is None:
                p["balance"] = 0.0
                p["paid_off_month"] = month
        total_paid += paid_this_month
        series.append({
            "month": month,
            "date": _add_months(start_date, month).isoformat(),
            "balance": round(sum(p["balance"] for p in pieces), 2),
            "payment": round(paid_this_month, 2),
        })

    payoff = {}
    for p in pieces:
        m = p["paid_off_month"] or month
        payoff[p["debt_id"]] = max(payoff.get(p["debt_id"], 0), m)
    names = {d["id"]: d["name"] for d in debts}
    order = sorted(payoff.items(), key=lambda kv: kv[1])
    return {
        "strategy": strategy,
        "extra_per_month": round(extra, 2),
        "months": month,
        "debt_free_date": _add_months(start_date, month).isoformat() if month else start_date.isoformat(),
        "total_interest": round(total_interest, 2),
        "total_paid": round(total_paid, 2),
        "payoff_order": [
            {"id": i, "name": names[i], "months": m, "date": _add_months(start_date, m).isoformat()}
            for i, m in order
        ],
        "series": series,
    }


def per_debt_interest(debts: list[dict], start_date: Optional[datetime.date] = None) -> dict:
    """Interest each debt still costs on its current schedule (no extra)."""
    out = {}
    for d in debts:
        r = simulate([d], "current", 0.0, start_date)
        out[d["id"]] = {"interest_remaining": r["total_interest"], "months": r["months"],
                        "payoff_date": r["debt_free_date"]}
    return out


def payment_steps(debts: list[dict], start_date: Optional[datetime.date] = None) -> list[dict]:
    """When each loan ends on its current schedule, how much monthly payment
    it frees, and what the household's total loan payment drops to."""
    start_date = start_date or datetime.date.today()
    ends = []
    for d in debts:
        r = simulate([d], "current", 0.0, start_date)
        pi = sum(float(p.get("payment") or 0) for p in d["pieces"] if float(p.get("balance") or 0) > 0.01)
        ends.append((r["months"], d, pi))
    total = sum(pi + float(d.get("escrow") or 0) for _, d, pi in ends)
    steps = []
    for months, d, pi in sorted(ends, key=lambda e: e[0]):
        freed = pi + float(d.get("escrow") or 0)
        total -= freed
        steps.append({
            "id": d["id"], "name": d["name"], "months": months,
            "date": _add_months(start_date, months).isoformat(),
            "frees_per_month": round(freed, 2),
            "escrow_continues": round(float(d.get("escrow") or 0), 2),
            "total_after": round(max(total, 0.0), 2),
        })
    return steps


def _owed(d: dict) -> float:
    """What the household owes on a debt: the servicer's balance when known
    (it can include accrued interest), else the sum of its pieces."""
    if d.get("balance") is not None:
        return float(d["balance"])
    return sum(float(p["balance"]) for p in d["pieces"])


def summarize(
    debts: list[dict],
    extra: float = 0.0,
    monthly_income: Optional[float] = None,
    start_date: Optional[datetime.date] = None,
    exclude_from_plan: Optional[set] = None,
) -> dict:
    """Everything the Loans summary shows, in one response.

    Totals and the per-loan table cover every loan. The avalanche/snowball
    plans cover every loan except `exclude_from_plan` (e.g. a low-rate
    mortgage the household would rather not prepay); excluded loans keep
    their normal schedule.
    """
    start_date = start_date or datetime.date.today()
    exclude_from_plan = set(exclude_from_plan or ())
    live = [d for d in debts if any(float(p.get("balance") or 0) > 0.01 for p in d["pieces"])]
    balance = sum(_owed(d) for d in live)
    pi_total = sum(float(p.get("payment") or 0) for d in live for p in d["pieces"] if float(p["balance"]) > 0.01)
    escrow_total = sum(float(d.get("escrow") or 0) for d in live)
    weighted = (sum(float(p["balance"]) * float(p.get("rate") or 0) for d in live for p in d["pieces"]) / balance) if balance else 0.0
    per = per_debt_interest(live, start_date)
    in_plan = [d for d in live if d["id"] not in exclude_from_plan]
    current_all = simulate(live, "current", 0.0, start_date)
    plans = {s: simulate(in_plan, s, extra, start_date) for s in STRATEGIES}
    current = plans["current"]
    for s in ("avalanche", "snowball"):
        plans[s]["interest_saved"] = round(current["total_interest"] - plans[s]["total_interest"], 2)
        plans[s]["months_saved"] = current["months"] - plans[s]["months"]
    steps = payment_steps(live, start_date)
    monthly_payments = pi_total + escrow_total
    return {
        "as_of": start_date.isoformat(),
        "totals": {
            "balance": round(balance, 2),
            "monthly_payment": round(monthly_payments, 2),
            "monthly_principal_interest": round(pi_total, 2),
            "monthly_escrow": round(escrow_total, 2),
            "weighted_rate": weighted,
            "interest_remaining": current_all["total_interest"],
            "debt_free_date": current_all["debt_free_date"],
            "months_to_debt_free": current_all["months"],
            "loan_count": len(live),
            "monthly_income": round(monthly_income, 2) if monthly_income else None,
            "payments_share_of_income": (monthly_payments / monthly_income) if monthly_income else None,
        },
        "next_payoff": steps[0] if steps else None,
        "payment_steps": steps,
        "loans": [
            {
                "id": d["id"], "name": d["name"], "kind": d.get("kind"),
                "balance": round(_owed(d), 2),
                "rate": (sum(float(p["balance"]) * float(p.get("rate") or 0) for p in d["pieces"]) /
                         max(sum(float(p["balance"]) for p in d["pieces"]), 0.01)),
                "monthly_payment": round(sum(float(p.get("payment") or 0) for p in d["pieces"]) + float(d.get("escrow") or 0), 2),
                "escrow": round(float(d.get("escrow") or 0), 2),
                "share_of_debt": (_owed(d) / balance) if balance else 0.0,
                "in_plan": d["id"] not in exclude_from_plan,
                "pieces": len(d["pieces"]),
                **per[d["id"]],
            }
            for d in sorted(live, key=lambda d: -_owed(d))
        ],
        "excluded_from_plan": sorted(exclude_from_plan & {d["id"] for d in live}),
        "plans": {s: {k: v for k, v in p.items() if k != "series"} for s, p in plans.items()},
        "series": {s: p["series"] for s, p in plans.items()},
    }
