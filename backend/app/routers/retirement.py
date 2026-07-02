"""Retirement projection endpoint.

The single biggest endpoint in the codebase, extracted from
routers/analytics.py during the Phase 1 split. Two-phase simulation
(accumulation + withdrawal) of investable assets, layered with pension
and Social Security streams, with Monte Carlo / sequence-of-returns
stress tests, healthcare bridge, RMDs, spending phases, and per-bucket
tax tracking.

Heavy lifting lives in services/retirement_sim.py and services/tax.py.
This router is mostly parameter parsing, derived calculations
(FI number, pension PV, after-tax projections, sensitivity table) and
shaping the response payload.
"""
from __future__ import annotations

import json
import random
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app.models import Account, Transaction
from app.services.retirement_sim import (
    aggregate_monte_carlo,
    apply_sequence_stress,
    generate_returns_path,
    simulate_two_phase,
)
from app.services.tax import STATE_TAX_PRESETS

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


# SSA benefit-vs-claim-age anchors, expressed relative to the full-
# retirement-age (67) benefit: ~70% at 62, ~86.7% at 65, 100% at 67,
# ~124% at 70. The real SSA schedule is piecewise-linear between these,
# so we linearly interpolate for the in-between ages (63, 64, 66, 68,
# 69) rather than defaulting them to 1.0.
_ACTUARIAL_ANCHORS = {62: 0.70, 65: 0.867, 67: 1.0, 70: 1.24}


def actuarial_factor(age: int) -> float:
    """SSA benefit factor (relative to age-67 PIA) for any claim age.

    Linearly interpolates between the anchor ages and clamps outside the
    62–70 range (you can't claim retirement benefits earlier than 62, and
    delayed credits stop accruing at 70)."""
    anchors = sorted(_ACTUARIAL_ANCHORS.items())
    lo_age, lo_val = anchors[0]
    hi_age, hi_val = anchors[-1]
    if age <= lo_age:
        return lo_val
    if age >= hi_age:
        return hi_val
    if age in _ACTUARIAL_ANCHORS:
        return _ACTUARIAL_ANCHORS[age]
    # Find the bracketing anchors and interpolate.
    for i in range(len(anchors) - 1):
        a0, v0 = anchors[i]
        a1, v1 = anchors[i + 1]
        if a0 <= age <= a1:
            frac = (age - a0) / (a1 - a0)
            return v0 + frac * (v1 - v0)
    return 1.0  # unreachable given the clamps above


# Account types we treat as "investable" — these grow at the projection's
# return rate and contribute toward the retirement number. Cash sitting
# in checking/savings doesn't grow meaningfully, so we don't include it.
# (User can override by manually upping current_assets in the UI.)
_INVESTABLE_TYPES = {"investment"}


def _detect_annual_contribution(db: Session) -> float:
    """Heuristic: how much the user puts into investment accounts per year.

    Counts incoming transactions (negative amount = money in) on
    investment-type accounts over the trailing 12 months. Misses 401(k)
    payroll deductions (those don't traverse a bank account Plaid sees)
    so this is a FLOOR — the user can override to match reality.
    Returns 0.0 if no signal.
    """
    today = date.today()
    cutoff = today - timedelta(days=365)
    investment_account_ids = [
        a.id
        for a in db.query(Account).filter(Account.type.in_(_INVESTABLE_TYPES)).all()
    ]
    if not investment_account_ids:
        return 0.0
    inflows = (
        db.query(func.sum(Transaction.amount))
        .filter(
            Transaction.account_id.in_(investment_account_ids),
            Transaction.date >= cutoff,
            Transaction.amount < 0,
        )
        .scalar()
        or 0.0
    )
    # amount is negative for inflows in Plaid's convention; flip sign.
    return abs(round(float(inflows), 2))


def _project_compound(pv: float, annual_contribution: float, rate: float, years: int) -> list[dict]:
    """Year-by-year compound growth (accumulation only, no withdrawals).

    Standard FV formula applied iteratively so each row also carries the
    contribution + interest split — useful for the chart's stacked view.
    Contributions assumed end-of-year (slightly conservative vs.
    beginning-of-year).

    Used by the sensitivity table for a quick "balance at retirement age
    if returns are X%" comparison. The headline projection now uses the
    full two-phase simulator (simulate_two_phase) which extends past
    retirement and tracks staged income onset.
    """
    rows = []
    balance = pv
    for year in range(1, years + 1):
        interest = balance * rate
        balance = balance + interest + annual_contribution
        rows.append({
            "year": year,
            "balance": round(balance, 2),
            "interest": round(interest, 2),
            "contributed": round(annual_contribution, 2),
        })
    return rows


def _find_max_sustainable_income(
    sim_kwargs: dict,
    target_age: int,
    current_age: int,
    accumulation_years: int,
    base_returns: list,
) -> dict:
    """Bisect on desired_income to find the max value that drains total
    portfolio (taxable + tax_deferred + roth + hsa) to ~$0 at target_age.

    Strategy: lo=$1k (sanity floor), hi=$1M (almost certainly above any
    real-world max for a normal household), bisect 16 iterations or
    until interval < $250.

    Two failure signals tell us we're spending too much:
      1. Cumulative income_shortfall > $0 in any year ≤ target_age
         (portfolio fully depleted but spending demand continues)
      2. Final balance at target_age > target_balance + tolerance
         means we COULD spend more (under-spending).

    Returns dict with the result + status flag:
      - status='ok': converged to a finite max
      - status='exceeds_max': even at $1M/yr the portfolio survives
        (e.g., huge pension/SS covers all needs)
      - status='insufficient': even at $1k/yr the portfolio drains
        early (e.g., starting balance too small or stress too severe)
    """
    # Extend horizon so the sim reaches target_age. Original horizon may
    # stop earlier (default 45 yrs past last retirement). Compute the
    # extra years needed and use that for the bisection runs.
    horizon_needed = max(target_age - (current_age + accumulation_years) + 1, 1)
    # Pad returns_path to match the longer horizon. After the original
    # path runs out, repeat the last (retirement) return rate.
    if len(base_returns) < accumulation_years + horizon_needed:
        last_rate = base_returns[-1] if base_returns else 0.0
        padded = base_returns + [last_rate] * (
            accumulation_years + horizon_needed - len(base_returns)
        )
    else:
        padded = base_returns[: accumulation_years + horizon_needed]

    bisect_kwargs = {**sim_kwargs, "horizon_years": horizon_needed}

    def run(income: float) -> tuple[float, float]:
        """Return (end_balance_at_target, total_shortfall_through_target)."""
        rows = simulate_two_phase(
            **{**bisect_kwargs, "desired_income": income},
            returns_path=padded,
        )
        target_rows = [r for r in rows if r["age"] == target_age]
        end_bal = (
            target_rows[0]["balance"] if target_rows
            else (rows[-1]["balance"] if rows else 0.0)
        )
        shortfall = sum(
            r.get("income_shortfall", 0.0)
            for r in rows
            if r["age"] <= target_age
        )
        return end_bal, shortfall

    # First check the bounds — if even $1M/yr leaves a balance, the user
    # has so much fixed income that the question is meaningless.
    high_balance, high_shortfall = run(1_000_000.0)
    if high_balance > 1_000 and high_shortfall <= 0:
        return {
            "status": "exceeds_max",
            "amount": 1_000_000.0,
            "target_age": target_age,
            "note": "Pension/SS + portfolio covers spending above $1M/yr — bisection ceiling reached.",
        }

    # And the floor — if even $1k/yr drains, the plan is structurally
    # under-funded and no answer exists.
    low_balance, low_shortfall = run(1_000.0)
    if low_shortfall > 0:
        return {
            "status": "insufficient",
            "amount": 0.0,
            "target_age": target_age,
            "note": "Even at $1k/yr spending the portfolio depletes before target age.",
        }

    # Bisection invariant: lo is always the highest spend known to NOT
    # cause a shortfall (safe ceiling). hi is the lowest spend known to
    # cause one (over-spend floor). We return lo at the end — that's
    # the conservative answer the user wants ("max spend without
    # over-drawing"). Returning the midpoint would sometimes over-shoot
    # by a few thousand and report a number that technically depletes.
    lo, hi = 1_000.0, 1_000_000.0
    for _ in range(20):
        if hi - lo < 250:
            break
        mid = (lo + hi) / 2
        end_bal, shortfall = run(mid)
        if shortfall > 0:
            # Over-spending — depleted before target_age
            hi = mid
        else:
            # No shortfall — this is a known-safe ceiling. Move lo up.
            # Even if end_bal is comfortable, push higher; we're after
            # the BOUNDARY between safe and unsafe.
            lo = mid

    # One extra sim at the converged answer to capture after-tax avg.
    # Lets the UI show "$X gross / $Y after-tax" instead of forcing the
    # user to mentally apply their effective tax rate to the gross max.
    final_rows = simulate_two_phase(
        **{**bisect_kwargs, "desired_income": lo},
        returns_path=padded,
    )
    after_tax_years = [
        r["after_tax_income"]
        for r in final_rows
        if r["phase"] == "withdrawing" and r["age"] <= target_age
    ]
    after_tax_avg = (
        sum(after_tax_years) / len(after_tax_years)
        if after_tax_years else 0.0
    )

    return {
        "status": "ok",
        "amount": round(lo, 0),
        "after_tax_avg": round(after_tax_avg, 2),
        "target_age": target_age,
    }


def _gross_up_for_net_target(
    sim_kwargs: dict,
    returns_path: list,
    target_net: float,
    max_iters: int = 6,
    tolerance: float = 200.0,
) -> tuple[list, float, dict]:
    """Iteratively gross up `desired_income` so that average withdrawal-
    phase after-tax income hits `target_net`.

    Strategy: secant-like adjustment. Run sim with current gross guess,
    compare avg after-tax income across all withdrawal years, and adjust
    gross by the absolute miss. Typically converges in 2-4 iterations
    because the federal bracket structure makes the relationship
    near-linear within a household's tax neighborhood.

    Returns (year_by_year_rows, final_gross_used, diagnostics).

    diagnostics: {iterations, target_net, achieved_avg_net, final_gross}
    """
    # Initial guess: target_net itself (bottom-of-bracket case).
    gross = float(target_net)
    rows = []
    avg_net = 0.0
    iters_used = 0
    for i in range(max_iters):
        rows = simulate_two_phase(
            **{**sim_kwargs, "desired_income": gross},
            returns_path=returns_path,
        )
        withdraw_rows = [r for r in rows if r["phase"] == "withdrawing"]
        if not withdraw_rows:
            # No withdrawal phase → can't iterate. Return as-is.
            iters_used = i + 1
            break
        avg_net = sum(r["after_tax_income"] for r in withdraw_rows) / len(withdraw_rows)
        diff = target_net - avg_net
        iters_used = i + 1
        if abs(diff) <= tolerance:
            break
        # Adjust gross by the miss. The relationship gross→net is roughly
        # gross × (1 - effective_rate) so adding `diff` overshoots a bit
        # in the wrong direction; damp by 0.95 to avoid oscillation.
        gross = max(0.0, gross + diff * 0.95)
    return rows, round(gross, 2), {
        "iterations": iters_used,
        "target_net": round(target_net, 2),
        "achieved_avg_net": round(avg_net, 2),
        "final_gross": round(gross, 2),
    }


@router.get("/retirement-state-presets")
def retirement_state_presets():
    """Lookup table for common state-tax effective rates with retiree-
    relevant exemption notes. Frontend renders this as a dropdown next
    to the state-tax-rate input — picking a state auto-fills the
    effective rate and surfaces caveats (SS exempt, public-pension
    treatment, LTCG conformance)."""
    return {
        "presets": [
            {"code": code, **data}
            for code, data in sorted(STATE_TAX_PRESETS.items())
        ]
    }


@router.get("/retirement-projection")
def retirement_projection(
    current_age: int = Query(..., ge=18, le=100, description="Today's age"),
    retirement_age: int = Query(65, ge=18, le=100, description="Target retirement age"),
    # Household composition. Spouse fields enable two-phase simulation
    # where contributions run until the LAST person retires (not just
    # the user) and each fixed-income stream activates at its own
    # calendar moment based on the holder's age.
    spouse_age: Optional[int] = Query(
        None, ge=18, le=100,
        description="Spouse's current age. Optional — when set, allows pension/SS "
                    "calendar timing to be calculated against the spouse's age "
                    "rather than the user's. When omitted, spouse retirement "
                    "doesn't extend the contribution period.",
    ),
    spouse_retirement_age: Optional[int] = Query(
        None, ge=18, le=100,
        description="Age at which the spouse retires (in spouse's years). When "
                    "set, contributions continue until WHICHEVER spouse retires "
                    "later. Set to spouse's pension-eligible age (e.g., 55 for "
                    "MI teachers) when she retires before the user.",
    ),
    return_rate: float = Query(
        0.06, ge=0.0, le=0.20,
        description="Expected real (after-inflation) annual return DURING ACCUMULATION — 0.06 = 6%. "
                    "Reflects an aggressive growth-oriented allocation while you're still working "
                    "(stocks-heavy 401k/IRA). Once both spouses retire, the simulator switches to "
                    "retirement_return_rate to model the typical de-risking into bonds/CDs.",
    ),
    retirement_return_rate: float = Query(
        0.015, ge=0.0, le=0.10,
        description="Real annual return DURING WITHDRAWAL (post-retirement). Models the standard "
                    "de-risking into capital-preservation assets — CD ladder, treasuries, high-grade "
                    "bonds. 0.015 = 1.5% real ≈ today's 5-yr CD ladder net of inflation. The switch "
                    "happens at the moment the LAST spouse retires (when withdrawals begin); before "
                    "that the simulator uses return_rate.",
    ),
    desired_annual_income: float = Query(
        80000.0, ge=0,
        description="What you want to spend per year in retirement (today's dollars)",
    ),
    annual_contribution: Optional[float] = Query(
        None, ge=0,
        description="Annual contribution. If omitted, auto-detected from last 12mo of "
                    "incoming transactions on investment accounts (a floor — payroll "
                    "401k deductions are invisible to Plaid).",
    ),
    withdrawal_rate: float = Query(
        0.04, ge=0.005, le=0.10,
        description="Safe withdrawal rate. 0.04 (the '4% rule') is the standard rule of thumb.",
    ),
    pension_annual: float = Query(0.0, ge=0),
    pension_holder_age: Optional[int] = Query(None, ge=18, le=100),
    pension_start_age: Optional[int] = Query(None, ge=18, le=100),
    pension_cola: float = Query(0.0, ge=0, le=0.10),
    ss_annual: float = Query(0.0, ge=0),
    ss_holder_age: Optional[int] = Query(None, ge=18, le=100),
    ss_start_age: int = Query(67, ge=62, le=70),
    ss_cola: float = Query(0.025, ge=0, le=0.10),
    ss2_annual: float = Query(0.0, ge=0),
    ss2_holder_age: Optional[int] = Query(None, ge=18, le=100),
    ss2_start_age: int = Query(67, ge=62, le=70),
    ss2_cola: float = Query(0.025, ge=0, le=0.10),
    ss_reduction_pct: float = Query(0.0, ge=0, le=1),
    tax_rate_ordinary: float = Query(0.22, ge=0, le=0.50),
    tax_rate_capital_gains: float = Query(0.15, ge=0, le=0.50),
    inflation_rate: float = Query(0.025, ge=0, le=0.10),
    healthcare_pre_medicare: float = Query(0.0, ge=0, le=100000),
    contribution_after_first_retirement: Optional[float] = Query(None, ge=0),
    slow_go_start_age: int = Query(75, ge=60, le=100),
    no_go_start_age: int = Query(85, ge=70, le=110),
    slow_go_multiplier: float = Query(1.0, ge=0.1, le=2.0),
    no_go_multiplier: float = Query(1.0, ge=0.1, le=2.0),
    survivor_at_user_age: Optional[int] = Query(None, ge=18, le=120),
    pension_survivor_pct: float = Query(0.5, ge=0.0, le=1.0),
    survivor_spending_multiplier: float = Query(0.7, ge=0.3, le=1.0),
    state_tax_rate: float = Query(0.0, ge=0.0, le=0.15),
    ltc_annual_cost: float = Query(0.0, ge=0),
    ltc_start_age: int = Query(80, ge=60, le=110),
    ltc_duration_years: int = Query(3, ge=1, le=20),
    taxable_basis_pct: float = Query(0.5, ge=0.0, le=1.0),
    # Defaults reflect industry norms (advisor review item #6, #7).
    # Real wage growth ~1%/yr through age 50 from promotions/raises;
    # medical CPI runs ~1.5% above general inflation long-run.
    wage_growth_rate: float = Query(0.01, ge=-0.05, le=0.10),
    healthcare_growth_rate: float = Query(0.015, ge=-0.05, le=0.15),
    # HSA contribution (separate from annual_contribution to avoid
    # double-counting). Lands in the HSA bucket each accumulation year.
    hsa_annual_contribution: float = Query(0.0, ge=0, le=20000),
    apply_irmaa: bool = Query(True),
    tcja_sunset_enabled: bool = Query(False),
    tcja_sunset_year: int = Query(2026, ge=2025, le=2050),
    qbi_business_income: float = Query(0.0, ge=0, le=500000),
    tlh_annual: float = Query(0.0, ge=0, le=10000),
    # Qualified Charitable Distribution. Annual amount sent direct from
    # IRA to charity. Capped at $108k by the simulator (2025 IRC limit).
    # Honored only at age 70½+; tax-deferred bucket must have funds.
    # Counts toward RMD when applicable. Default 0 = no QCD planned.
    qcd_annual: float = Query(0.0, ge=0, le=108000),
    # ── Roth conversion ladder (advisor review item #3) ──
    # Convert tax_deferred → roth during bridge years to escape future
    # RMD-driven tax pressure. 0 = off. When >0, the response includes
    # a `roth_conversion_comparison` block showing lifetime tax delta
    # vs no-conversion baseline.
    roth_conversion_amount: float = Query(0.0, ge=0, le=500000),
    roth_conversion_start_age: int = Query(0, ge=0, le=120),
    roth_conversion_end_age: int = Query(0, ge=0, le=120),
    roth_conversion_target_bracket: Optional[float] = Query(
        None, ge=0.0, le=0.5,
        description="If set (e.g. 0.12, 0.22, 0.24), each conversion year "
                    "fills exactly to the top of that bracket. Overrides "
                    "roth_conversion_amount when both are set."),
    # ── Max sustainable spending calculator ──
    # When enabled, run a bisection on desired_income to find the
    # maximum that drains total portfolio to ~$0 at target age. Useful
    # for "how much can I actually spend" answers without manually
    # iterating on the desired_income field. Respects all other inputs
    # (LTC, survivor, Roth conversions, stress preset). Adds ~1-2 sec
    # per request — toggle off on slower machines.
    compute_max_sustainable: bool = Query(True),
    max_sustainable_target_age: int = Query(105, ge=70, le=120),
    one_time_expenses_json: str = Query("[]"),
    # Step events (mortgage payoff, kid college, sabbatical, etc.).
    # JSON-encoded list of {age, kind, delta, duration_years, label}.
    step_events_json: str = Query("[]"),
    monte_carlo_runs: int = Query(0, ge=0, le=5000),
    return_volatility_working: float = Query(0.15, ge=0, le=0.50),
    return_volatility_retired: float = Query(0.05, ge=0, le=0.30),
    sequence_stress_preset: str = Query("none"),
    # Net-vs-gross target interpretation (#102/#133). When 'gross', the
    # desired_annual_income value is the GROSS spending the simulator
    # tries to fund — taxes are netted out and reported separately as
    # after_tax_income (today's behavior — preserved as default for
    # backwards compat). When 'net', the value is treated as the
    # AFTER-TAX number the user wants in their pocket each year and the
    # simulator is iterated to gross it up. CFP best-practice for
    # personal-planning conversations ("how much do I want to spend"
    # almost always means after-tax).
    interpret_target_as: str = Query(
        "gross", description="'gross' (default) or 'net'. Net = iterate to gross-up.",
    ),
    db: Session = Depends(get_db),
):
    """Multi-decade compound-growth retirement projection, with optional
    pension / Social Security streams, Monte Carlo simulation, and
    sequence-of-returns stress test.

    Heavy simulation logic lives in services/retirement_sim.py — this
    handler does parameter parsing + post-sim aggregation (FI number,
    pension PV, sensitivity table, after-tax breakdowns) and shapes the
    response. See the simulator module for per-year logic.

    Output keys (selected):
      - current_assets: today's investable total
      - fi_number / effective_fi_number: nest egg required (with/without pension)
      - projected_balance: balance at last_retirement_user_age
      - depleted_age: first year balance hit 0, or None if never
      - on_track: did the simulation survive the planning horizon
      - monte_carlo: percentile bands + success probability when MC runs > 0
      - bridge_pre_595: penalty-free liquidity check when FI < 60
      - year_by_year: per-year breakdown for charting + table
      - sensitivity: same projection at 4% / 6% / 8% returns
    """
    if retirement_age <= current_age:
        raise HTTPException(400, "retirement_age must be greater than current_age")

    # 1) Sum investable assets — only investment-type accounts. Manual
    #    accounts of type investment count too (e.g., a manual 401k
    #    entry where the user updates balance from quarterly statements).
    # Aggregate per-row rather than via SQL GROUP BY because of the
    # per-account roth_split_pct: an account with split=0.6 contributes
    # to BOTH the roth and tax_deferred buckets in a single record, which
    # the GROUP BY can't express.
    investable_accounts = (
        db.query(
            Account.id,
            Account.tax_bucket,
            Account.current_balance,
            Account.roth_split_pct,
        )
        .filter(Account.type.in_(_INVESTABLE_TYPES))
        .all()
    )
    buckets = {"tax_deferred": 0.0, "roth": 0.0, "taxable": 0.0, "hsa": 0.0}
    excluded_total = 0.0  # tracked separately for the UI's transparency caption
    excluded_count = 0
    for _id, tax_bucket, balance, roth_split in investable_accounts:
        amt = float(balance or 0.0)
        bucket = tax_bucket or "taxable"  # null → conservative default
        if bucket == "excluded":
            # Account is investment-typed but the user has flagged it as
            # not-really-retirement (e.g., balance is borrowed money owed
            # back to a HELOC, leveraged positions, etc.). Skip from the
            # projection sum but report so the UI can show what's
            # excluded — silent exclusion would be misleading.
            excluded_total += amt
            excluded_count += 1
            continue
        # Unknown buckets fall back to 'taxable' — conservative default
        # per the user's "post tax when unsure" rule.
        primary = bucket if bucket in buckets else "taxable"
        # Per-account Roth split. When set, route that fraction of the
        # balance to the roth bucket and the remainder to the primary
        # bucket. Common case: 401(k) plans that allow
        # per-paycheck Roth designation but report a single Plaid
        # balance. The split is a manual estimate from the user's plan
        # portal — Plaid doesn't expose source-level breakdowns.
        if roth_split and 0.0 < roth_split <= 1.0 and primary != "roth":
            buckets["roth"] += amt * roth_split
            buckets[primary] += amt * (1.0 - roth_split)
        else:
            buckets[primary] += amt
    current_assets = sum(buckets.values())

    # 2) Annual contribution: explicit override > auto-detect > 0
    if annual_contribution is None:
        contribution = _detect_annual_contribution(db)
        contribution_source = "auto-detected"
    else:
        contribution = float(annual_contribution)
        contribution_source = "user-provided"

    years = retirement_age - current_age

    # 3) FI number — the standard "you can retire when invested assets ×
    #    withdrawal_rate covers your annual spending" rule. This is the
    #    BASE FI (no pension); we compute a pension-adjusted version below.
    fi_number = desired_annual_income / withdrawal_rate

    # 3b) Pension math
    if pension_holder_age is None:
        pension_holder_age = current_age
    if pension_start_age is None:
        pension_start_age = retirement_age

    # CALENDAR years until the pension starts — measured against the
    # pension HOLDER's age, not the user's.
    years_until_pension_starts = max(0, pension_start_age - pension_holder_age)
    years_until_user_retires = retirement_age - current_age

    # Real-terms COLA conversion.
    pension_cola_real = max(-0.99, pension_cola - inflation_rate)
    ss_cola_real = max(-0.99, ss_cola - inflation_rate)
    ss2_cola_real = max(-0.99, ss2_cola - inflation_rate)

    pension_at_start = pension_annual

    # PV at claim age of receiving the pension stream for ~30 years,
    # with real-cola growth (typically negative for fixed pensions),
    # discounted at the real return rate. Growing-annuity formula:
    #   PV = pmt × (1 − ((1+g)/(1+r))^n) / (r − g)
    RETIREMENT_HORIZON_YEARS = 30
    bridge_years = max(0, years_until_pension_starts - years_until_user_retires)
    pension_payment_years = max(0, RETIREMENT_HORIZON_YEARS - bridge_years)
    if pension_annual > 0 and pension_payment_years > 0:
        if abs(return_rate - pension_cola_real) < 1e-6:
            pension_pv = pension_at_start * pension_payment_years
        else:
            ratio = (1 + pension_cola_real) / (1 + return_rate)
            pension_pv = pension_at_start * (1 - ratio ** pension_payment_years) / (return_rate - pension_cola_real)
    else:
        pension_pv = 0.0

    # ─── Social Security (V3: 2 fixed-income streams) ──────────────
    def _compute_ss_stream(annual, holder_age, start_age, nominal_cola):
        """Returns (at_start, pv, holder_age). Defaults
        holder_age → current_age when None."""
        if holder_age is None:
            holder_age = current_age
        real_cola = max(-0.99, nominal_cola - inflation_rate)
        # Apply SS-haircut stress test to the at-claim value.
        at_start = annual * (1 - ss_reduction_pct)
        # Bridge years from USER's retirement to when this stream
        # actually starts paying.
        years_until_starts = max(0, start_age - holder_age)
        years_until_user_retires_local = max(0, retirement_age - current_age)
        bridge = max(0, years_until_starts - years_until_user_retires_local)
        payment_years = max(0, RETIREMENT_HORIZON_YEARS - bridge)
        if annual > 0 and payment_years > 0:
            if abs(return_rate - real_cola) < 1e-6:
                pv = at_start * payment_years
            else:
                ratio = (1 + real_cola) / (1 + return_rate)
                pv = at_start * (1 - ratio ** payment_years) / (return_rate - real_cola)
        else:
            pv = 0.0
        return at_start, pv, holder_age

    ss_at_start, ss_pv, ss_holder_age = _compute_ss_stream(
        ss_annual, ss_holder_age, ss_start_age, ss_cola
    )
    ss2_at_start, ss2_pv, ss2_holder_age = _compute_ss_stream(
        ss2_annual, ss2_holder_age, ss2_start_age, ss2_cola
    )

    # Combined SS at steady state.
    ss_total_at_start = ss_at_start + ss2_at_start
    ss_total_pv = ss_pv + ss2_pv

    # Effective FI: portfolio only needs to fund the gap after ALL
    # fixed-income sources start producing.
    fixed_income_at_steady_state = pension_at_start + ss_total_at_start
    annual_gap = max(0.0, desired_annual_income - fixed_income_at_steady_state)
    effective_fi_number = annual_gap / withdrawal_rate
    bridge_full_income_needed = bridge_years * desired_annual_income

    # 4) Two-phase simulation setup.
    your_years_to_retire = years
    spouse_years_to_retire = 0
    if spouse_age is not None and spouse_retirement_age is not None:
        spouse_years_to_retire = max(0, spouse_retirement_age - spouse_age)
    accumulation_years = max(your_years_to_retire, spouse_years_to_retire)
    last_retirement_user_age = current_age + accumulation_years
    if spouse_age is not None and spouse_retirement_age is not None:
        first_retirement_year = min(your_years_to_retire, spouse_years_to_retire)
    else:
        first_retirement_year = your_years_to_retire
    contribution_after = (
        contribution_after_first_retirement
        if contribution_after_first_retirement is not None
        else contribution
    )

    # Withdrawal horizon: extend the chart out to the user's chosen
    # drain-age (default 105) so the trajectory matches the Max
    # Sustainable target. Floors at 30 years past last retirement so
    # users with a low target don't get a useless stub of a chart, and
    # falls back to 45 if the calculator is disabled.
    if compute_max_sustainable and max_sustainable_target_age > last_retirement_user_age:
        WITHDRAWAL_HORIZON_YEARS = max(
            30,
            max_sustainable_target_age - last_retirement_user_age + 1,
        )
    else:
        WITHDRAWAL_HORIZON_YEARS = 45

    # Build income-stream descriptors for the simulator. SS streams use
    # the post-haircut value; pension is unaffected (state pensions have
    # stronger legal protections than SS).
    streams = [
        {
            "amount_today": pension_annual,
            "holder_age_today": pension_holder_age,
            "start_age": pension_start_age,
            "cola": pension_cola_real,
            "label": "pension",
        },
        {
            "amount_today": ss_annual * (1 - ss_reduction_pct),
            "holder_age_today": ss_holder_age,
            "start_age": ss_start_age,
            "cola": ss_cola_real,
            "label": "ss",
        },
        {
            "amount_today": ss2_annual * (1 - ss_reduction_pct),
            "holder_age_today": ss2_holder_age,
            "start_age": ss2_start_age,
            "cola": ss2_cola_real,
            "label": "ss2",
        },
    ]

    # Parse one-time events JSON. Tolerant — bad input → empty list.
    try:
        one_time_events = json.loads(one_time_expenses_json or "[]")
        if not isinstance(one_time_events, list):
            one_time_events = []
    except (json.JSONDecodeError, TypeError):
        one_time_events = []
    try:
        step_events = json.loads(step_events_json or "[]")
        if not isinstance(step_events, list):
            step_events = []
    except (json.JSONDecodeError, TypeError):
        step_events = []

    # Build base deterministic returns path with optional sequence stress.
    base_returns = (
        [return_rate] * accumulation_years
        + [retirement_return_rate] * WITHDRAWAL_HORIZON_YEARS
    )
    base_returns = apply_sequence_stress(
        base_returns, sequence_stress_preset, accumulation_years
    )

    # Common kwargs for both deterministic and Monte Carlo runs.
    sim_kwargs = dict(
        starting_buckets=buckets,
        current_age=current_age,
        return_rate=return_rate,
        retirement_return_rate=retirement_return_rate,
        annual_contribution=contribution,
        contribution_after_first_retirement=contribution_after,
        accumulation_years=accumulation_years,
        first_retirement_year=first_retirement_year,
        horizon_years=WITHDRAWAL_HORIZON_YEARS,
        desired_income=desired_annual_income,
        streams=streams,
        tax_rate_ordinary=tax_rate_ordinary,
        tax_rate_capital_gains=tax_rate_capital_gains,
        spouse_age=spouse_age,
        healthcare_pre_medicare=healthcare_pre_medicare,
        slow_go_start_age=slow_go_start_age,
        no_go_start_age=no_go_start_age,
        slow_go_multiplier=slow_go_multiplier,
        no_go_multiplier=no_go_multiplier,
        survivor_at_user_age=survivor_at_user_age,
        pension_survivor_pct=pension_survivor_pct,
        survivor_spending_multiplier=survivor_spending_multiplier,
        state_tax_rate=state_tax_rate,
        ltc_annual_cost=ltc_annual_cost,
        ltc_start_age=ltc_start_age,
        ltc_duration_years=ltc_duration_years,
        taxable_basis_pct=taxable_basis_pct,
        wage_growth_rate=wage_growth_rate,
        healthcare_growth_rate=healthcare_growth_rate,
        hsa_annual_contribution=hsa_annual_contribution,
        apply_irmaa=apply_irmaa,
        tcja_sunset_enabled=tcja_sunset_enabled,
        tcja_sunset_year=tcja_sunset_year,
        qbi_business_income=qbi_business_income,
        tlh_annual=tlh_annual,
        qcd_annual=qcd_annual,
        roth_conversion_amount=roth_conversion_amount,
        roth_conversion_start_age=roth_conversion_start_age,
        roth_conversion_end_age=roth_conversion_end_age,
        roth_conversion_target_bracket=roth_conversion_target_bracket,
        one_time_events=one_time_events,
        step_events=step_events,
    )

    # Deterministic projection (the headline curve). When the user asked
    # to interpret desired_annual_income as a NET (after-tax) target, run
    # the gross-up loop so the simulator pulls enough to leave that much
    # in their pocket post-tax. Otherwise (default), pass the value
    # straight through as gross spending.
    net_target_diagnostics = None
    if interpret_target_as == "net":
        year_by_year, gross_used, net_target_diagnostics = _gross_up_for_net_target(
            sim_kwargs=sim_kwargs,
            returns_path=base_returns,
            target_net=desired_annual_income,
        )
        # Update sim_kwargs so downstream uses (max_sustainable, LTC,
        # SS sweep) all run consistently against the gross-equivalent
        # the user actually needs.
        sim_kwargs = {**sim_kwargs, "desired_income": gross_used}
    else:
        year_by_year = simulate_two_phase(
            **sim_kwargs,
            returns_path=base_returns,
        )

    # ── Max sustainable spending ──
    # Bisects on desired_income to find the maximum spend that drains
    # the total portfolio to ~$0 at the user's target age. Respects
    # every other input (LTC, survivor, Roth ladder, stress preset)
    # so the number is internally consistent with the chart. ~10-15
    # extra sim runs; toggle off via compute_max_sustainable=false.
    max_sustainable = None
    if compute_max_sustainable:
        max_sustainable = _find_max_sustainable_income(
            sim_kwargs=sim_kwargs,
            target_age=max_sustainable_target_age,
            current_age=current_age,
            accumulation_years=accumulation_years,
            base_returns=base_returns,
        )
        # Annotate with the headroom vs the user's current desired_income
        # so the UI can show "you're $X under/over the max" without
        # re-doing the math client-side.
        if max_sustainable.get("amount") is not None:
            max_sustainable["current_desired"] = round(desired_annual_income, 2)
            max_sustainable["headroom"] = round(
                max_sustainable["amount"] - desired_annual_income, 2
            )

    # ── LTC sensitivity comparison ──
    # When LTC is active (annual_cost > 0), run a parallel sim WITHOUT
    # the LTC event and surface the delta. Lets the advisor see the
    # raw shock the LTC bucket imposes, rather than guessing from a
    # single-line projection. Common scenario: $80k × 3 yrs at age 82.
    ltc_comparison = None
    if ltc_annual_cost > 0:
        no_ltc_kwargs = {**sim_kwargs, "ltc_annual_cost": 0.0}
        no_ltc_rows = simulate_two_phase(
            **no_ltc_kwargs, returns_path=base_returns,
        )
        with_ltc_end = year_by_year[-1]["balance"] if year_by_year else 0
        no_ltc_end = no_ltc_rows[-1]["balance"] if no_ltc_rows else 0
        with_ltc_paid = sum(
            r.get("ltc_cost", 0)
            for r in year_by_year if r["phase"] == "withdrawing"
        )
        ltc_comparison = {
            "ltc_annual_cost": ltc_annual_cost,
            "ltc_start_age": ltc_start_age,
            "ltc_duration_years": ltc_duration_years,
            "total_ltc_paid": round(with_ltc_paid, 2),
            "with_ltc_end_balance": round(with_ltc_end, 2),
            "no_ltc_end_balance": round(no_ltc_end, 2),
            # Negative delta = LTC drains the portfolio by this amount
            # (expected). Magnitude is the actual cost in real terms.
            "end_balance_delta": round(with_ltc_end - no_ltc_end, 2),
        }

    # ── SS delayed-claiming sweep ──
    # Run the deterministic projection across the standard SS claim
    # ages (62/65/67/70) and surface lifetime SS PV + lifetime tax +
    # end-balance side-by-side. Helps the user see the actuarial
    # break-even point for delaying. Only runs when at least one SS
    # stream is configured (skip when SS isn't part of the plan).
    # Adjusts BOTH ss_start_age and ss2_start_age in lockstep to keep
    # the comparison apples-to-apples; per-stream optimization is a
    # follow-up if needed.
    ss_claim_sweep = None
    if ss_annual > 0 or ss2_annual > 0:
        ss_claim_sweep_results = []
        for claim_age in (62, 65, 67, 70):
            sweep_streams = [
                {**s, "start_age": claim_age} if s.get("label", "").startswith("ss") else s
                for s in streams
            ]
            sweep_kwargs = {**sim_kwargs, "streams": sweep_streams}
            sweep_rows = simulate_two_phase(
                **sweep_kwargs, returns_path=base_returns,
            )
            sw_w = [r for r in sweep_rows if r["phase"] == "withdrawing"]
            lifetime_tax = sum(r["tax_paid"] for r in sw_w)
            end_balance = sweep_rows[-1]["balance"] if sweep_rows else 0
            # Lifetime SS PV = sum of SS payouts over the run, in
            # real (today's $) terms. Use the after-haircut at-start
            # value × years from claim to last sim row.
            years_collecting = max(0, (sweep_rows[-1]["age"] - claim_age + 1)) if sweep_rows else 0
            # Per-claim-age "at-start" amount differs by SSA actuarial
            # adjustment: ~70% at 62, ~86.7% at 65, 100% at 67, ~124% at 70.
            # The model takes the user's entered amount as their PIA
            # at the entered start age. Re-scale relative to that.
            #
            # ss_start_age may be an age NOT in the anchor table (63, 64,
            # 66, 68, 69). The old `.get(ss_start_age, 1.0)` silently
            # fell back to 1.0 — the age-67 factor — for those, badly
            # skewing base_ratio (e.g. a user claiming at 63 was treated
            # as if their PIA equalled their full-retirement benefit).
            # Interpolate between the surrounding anchors instead.
            base_ratio = actuarial_factor(claim_age) / actuarial_factor(ss_start_age)
            adjusted_ss = ss_annual * (1 - ss_reduction_pct) * base_ratio
            adjusted_ss2 = ss2_annual * (1 - ss_reduction_pct) * base_ratio
            ss_claim_sweep_results.append({
                "claim_age": claim_age,
                "lifetime_tax": round(lifetime_tax, 2),
                "end_balance": round(end_balance, 2),
                "adjusted_annual_ss_combined": round(adjusted_ss + adjusted_ss2, 2),
                "actuarial_factor_vs_67": actuarial_factor(claim_age),
            })
        # Break-even age per row — purely actuarial (cumulative SS cash
        # received), no additional sim runs needed.
        # Compares each alternative claim age against the user's CURRENT
        # claim age. Returns the death age at which delaying becomes
        # cumulatively positive.
        #   - Row at later age (e.g. 70 vs current 67): break-even =
        #     death age at which the later-claim cumulative finally
        #     exceeds the current-claim cumulative.
        #   - Row at earlier age (e.g. 62 vs current 67): break-even =
        #     death age at which the current-claim (later) cumulative
        #     finally catches up. If you live past that age, you should
        #     have STAYED at the current age instead of switching.
        # In both cases the number answers "live past this age, delaying
        # wins."
        current_row = next(
            (r for r in ss_claim_sweep_results if r["claim_age"] == ss_start_age),
            None,
        )
        for r in ss_claim_sweep_results:
            r["break_even_age"] = None
            if current_row is None or r["claim_age"] == ss_start_age:
                continue
            # Identify "early" and "late" so the cumulative math is
            # symmetrical regardless of which side of current we're on.
            if r["claim_age"] > ss_start_age:
                early_age, early_annual = current_row["claim_age"], current_row["adjusted_annual_ss_combined"]
                late_age, late_annual = r["claim_age"], r["adjusted_annual_ss_combined"]
            else:
                early_age, early_annual = r["claim_age"], r["adjusted_annual_ss_combined"]
                late_age, late_annual = current_row["claim_age"], current_row["adjusted_annual_ss_combined"]
            # Find smallest death age where late-claim cumulative >=
            # early-claim cumulative.
            for d in range(late_age, 121):
                early_cum = early_annual * (d - early_age + 1)
                late_cum = late_annual * (d - late_age + 1)
                if late_cum >= early_cum:
                    r["break_even_age"] = d
                    break
        ss_claim_sweep = {
            "current_claim_age": ss_start_age,
            "results": ss_claim_sweep_results,
        }

    # ── Roth conversion baseline comparison ──
    # When conversions are active, run a SECOND deterministic sim with
    # conversions OFF and surface the lifetime-tax + ending-balance
    # delta. This is the headline number that justifies the strategy.
    roth_comparison = None
    if roth_conversion_amount > 0:
        baseline_kwargs = {**sim_kwargs, "roth_conversion_amount": 0.0}
        baseline_rows = simulate_two_phase(
            **baseline_kwargs, returns_path=base_returns,
        )
        bw_rows = [r for r in baseline_rows if r["phase"] == "withdrawing"]
        ww_rows = [r for r in year_by_year if r["phase"] == "withdrawing"]
        baseline_lifetime_tax = sum(r["tax_paid"] for r in bw_rows)
        with_lifetime_tax = sum(r["tax_paid"] for r in ww_rows)
        baseline_end_balance = baseline_rows[-1]["balance"] if baseline_rows else 0
        with_end_balance = year_by_year[-1]["balance"] if year_by_year else 0
        total_converted = sum(r.get("roth_converted", 0) for r in ww_rows)
        roth_comparison = {
            "total_converted": round(total_converted, 2),
            "with_strategy_lifetime_tax": round(with_lifetime_tax, 2),
            "baseline_lifetime_tax": round(baseline_lifetime_tax, 2),
            "lifetime_tax_savings": round(
                baseline_lifetime_tax - with_lifetime_tax, 2
            ),
            "with_strategy_end_balance": round(with_end_balance, 2),
            "baseline_end_balance": round(baseline_end_balance, 2),
            "end_balance_delta": round(
                with_end_balance - baseline_end_balance, 2
            ),
        }

    # Monte Carlo simulation when requested.
    mc_results = None
    if monte_carlo_runs > 0:
        # Deterministic seed for reproducibility within a session.
        rng = random.Random(monte_carlo_runs * 7919 + accumulation_years)
        all_runs = []
        for _ in range(monte_carlo_runs):
            rand_returns = generate_returns_path(
                accumulation_years=accumulation_years,
                horizon_years=WITHDRAWAL_HORIZON_YEARS,
                accum_mean=return_rate,
                retired_mean=retirement_return_rate,
                accum_vol=return_volatility_working,
                retired_vol=return_volatility_retired,
                rng=rng,
            )
            run_rows = simulate_two_phase(**sim_kwargs, returns_path=rand_returns)
            all_runs.append(run_rows)
        mc_results = aggregate_monte_carlo(all_runs)

    # Snapshot at the moment withdrawals begin.
    if accumulation_years > 0 and accumulation_years <= len(year_by_year):
        projected_balance = year_by_year[accumulation_years - 1]["balance"]
    else:
        projected_balance = current_assets

    # Detect depletion — first withdrawal year balance hits 0.
    depleted_age = None
    end_balance = year_by_year[-1]["balance"] if year_by_year else current_assets
    for row in year_by_year:
        if row["phase"] == "withdrawing" and row["balance"] <= 0:
            depleted_age = row["age"]
            break

    # 5) Gap analysis.
    gap = projected_balance - effective_fi_number
    on_track = depleted_age is None
    sustainable_income = projected_balance * withdrawal_rate
    combined_sustainable_income = sustainable_income + pension_at_start + ss_total_at_start

    # 5a) FI-hit year.
    fi_hit_year = None
    fi_hit_age = None
    if effective_fi_number > 0:
        for row in year_by_year:
            if row["phase"] != "accumulating":
                break
            if row["balance"] >= effective_fi_number:
                fi_hit_year = row["year"]
                fi_hit_age = row["age"]
                break
    else:
        fi_hit_year = 0
        fi_hit_age = current_age

    # 5b) Pre-59½ bridge analysis.
    PRE_595_AGE = 60  # round 59.5 up
    bridge_pre_595 = None
    if fi_hit_age is not None and fi_hit_age < PRE_595_AGE:
        accessible_taxable = buckets["taxable"] + buckets["roth"]
        years_to_595 = PRE_595_AGE - fi_hit_age
        bridge_window_rows = [
            r for r in year_by_year
            if r["phase"] == "withdrawing"
            and fi_hit_age <= r["age"] < PRE_595_AGE
        ]
        if bridge_window_rows:
            bridge_spending_needed = sum(r.get("effective_spending", desired_annual_income) for r in bridge_window_rows)
        else:
            bridge_spending_needed = years_to_595 * (desired_annual_income + healthcare_pre_medicare)
        # Convert pension/SS start ages (HOLDER ages, possibly spouse)
        # into equivalent USER age for apples-to-apples comparison.
        pension_starts_at_user_age = current_age + max(
            0, pension_start_age - pension_holder_age
        )
        ss_starts_at_user_age = current_age + max(
            0, ss_start_age - ss_holder_age
        )
        ss2_starts_at_user_age = current_age + max(
            0, ss2_start_age - ss2_holder_age
        )
        pension_active_years = (
            max(0, PRE_595_AGE - max(fi_hit_age, pension_starts_at_user_age))
            if pension_annual > 0 else 0
        )
        ss_active_years = (
            max(0, PRE_595_AGE - max(fi_hit_age, ss_starts_at_user_age))
            if ss_annual > 0 else 0
        )
        ss2_active_years = (
            max(0, PRE_595_AGE - max(fi_hit_age, ss2_starts_at_user_age))
            if ss2_annual > 0 else 0
        )
        pension_bridge_contribution = pension_at_start * pension_active_years
        ss_bridge_contribution = (
            ss_at_start * ss_active_years + ss2_at_start * ss2_active_years
        )
        bridge_covered = (
            accessible_taxable + pension_bridge_contribution + ss_bridge_contribution
        )
        bridge_shortfall = max(0.0, bridge_spending_needed - bridge_covered)
        bridge_pre_595 = {
            "fi_hit_age": fi_hit_age,
            "years_to_595": years_to_595,
            "spending_needed": round(bridge_spending_needed, 2),
            "accessible_liquid": round(accessible_taxable, 2),
            "pension_contribution": round(pension_bridge_contribution, 2),
            "ss_contribution": round(ss_bridge_contribution, 2),
            "total_covered": round(bridge_covered, 2),
            "shortfall": round(bridge_shortfall, 2),
            "covered": bridge_shortfall <= 0,
            "tax_deferred_locked": round(buckets["tax_deferred"], 2),
        }

    # 5b) After-tax sustainable income (legacy steady-state calc).
    if current_assets > 0:
        weighted_withdrawal_tax_rate = (
            buckets["tax_deferred"] * tax_rate_ordinary
            + buckets["roth"] * 0.0
            + buckets["taxable"] * tax_rate_capital_gains
        ) / current_assets
    else:
        weighted_withdrawal_tax_rate = 0.0

    after_tax_portfolio_income = sustainable_income * (1 - weighted_withdrawal_tax_rate)
    after_tax_pension_income = pension_at_start * (1 - tax_rate_ordinary)
    ss_effective_tax_rate = tax_rate_ordinary * 0.85
    after_tax_ss_income = ss_at_start * (1 - ss_effective_tax_rate)
    after_tax_ss2_income = ss2_at_start * (1 - ss_effective_tax_rate)
    after_tax_combined_income = (
        after_tax_portfolio_income
        + after_tax_pension_income
        + after_tax_ss_income
        + after_tax_ss2_income
    )

    if (1 - weighted_withdrawal_tax_rate) > 0:
        after_tax_fi_number = effective_fi_number / (1 - weighted_withdrawal_tax_rate)
    else:
        after_tax_fi_number = effective_fi_number

    # 6) Monthly contribution to close gap.
    monthly_to_close_gap = 0.0
    if gap < 0 and accumulation_years > 0:
        gap_amount = -gap
        if return_rate > 0:
            growth_factor = ((1 + return_rate) ** accumulation_years - 1) / return_rate
        else:
            growth_factor = accumulation_years
        if growth_factor > 0:
            additional_annual = gap_amount / growth_factor
            monthly_to_close_gap = round(additional_annual / 12, 2)

    # 6b) Aggregate after-tax metrics from year-by-year sim.
    withdrawal_rows = [r for r in year_by_year if r["phase"] == "withdrawing"]
    bridge_rows = [r for r in withdrawal_rows if r["age"] < (ss_start_age if ss_annual > 0 else retirement_age)]
    if withdrawal_rows:
        sim_after_tax_avg = sum(r["after_tax_income"] for r in withdrawal_rows) / len(withdrawal_rows)
        sim_after_tax_min = min(r["after_tax_income"] for r in withdrawal_rows)
        sim_after_tax_max = max(r["after_tax_income"] for r in withdrawal_rows)
    else:
        sim_after_tax_avg = sim_after_tax_min = sim_after_tax_max = 0.0
    if bridge_rows:
        sim_bridge_after_tax_avg = sum(r["after_tax_income"] for r in bridge_rows) / len(bridge_rows)
    else:
        sim_bridge_after_tax_avg = 0.0
    total_taxes_paid = sum(r.get("tax_paid", 0.0) for r in withdrawal_rows)
    total_rmd_taken = sum(r.get("rmd_required", 0.0) for r in withdrawal_rows)
    total_healthcare_paid = sum(r.get("healthcare_cost", 0.0) for r in withdrawal_rows)
    total_ltc_paid = sum(r.get("ltc_cost", 0.0) for r in withdrawal_rows)
    # HSA tax-free medical draws: portion of healthcare + LTC covered by
    # HSA before any taxable bucket was touched. Surfaced separately so
    # the UI can show "X of healthcare was paid tax-free from HSA."
    total_hsa_medical_paid = sum(r.get("hsa_medical_draw", 0.0) for r in withdrawal_rows)
    total_state_tax = sum(r.get("tax_state", 0.0) for r in withdrawal_rows)
    total_federal_tax = sum(r.get("tax_federal", 0.0) for r in withdrawal_rows)

    # 7) Sensitivity at three return rates.
    sensitivity = []
    for r in (0.04, 0.06, 0.08):
        rows = _project_compound(current_assets, contribution, r, accumulation_years)
        end_bal = rows[-1]["balance"] if rows else current_assets
        sensitivity.append({
            "return_rate": r,
            "projected_balance": round(end_bal, 2),
            "gap": round(end_bal - effective_fi_number, 2),
            "sustainable_income": round(end_bal * withdrawal_rate, 2),
        })

    return {
        "inputs": {
            "current_age": current_age,
            "retirement_age": retirement_age,
            "return_rate": return_rate,
            "retirement_return_rate": retirement_return_rate,
            "desired_annual_income": desired_annual_income,
            "annual_contribution": round(contribution, 2),
            "contribution_source": contribution_source,
            "withdrawal_rate": withdrawal_rate,
            "pension_annual": pension_annual,
            "pension_holder_age": pension_holder_age,
            "pension_start_age": pension_start_age,
            "pension_cola": pension_cola,
            "ss_annual": ss_annual,
            "ss_holder_age": ss_holder_age,
            "ss_start_age": ss_start_age,
            "ss_cola": ss_cola,
            "ss2_annual": ss2_annual,
            "ss2_holder_age": ss2_holder_age,
            "ss2_start_age": ss2_start_age,
            "ss2_cola": ss2_cola,
            "ss_reduction_pct": ss_reduction_pct,
            "tax_rate_ordinary": tax_rate_ordinary,
            "tax_rate_capital_gains": tax_rate_capital_gains,
            "spouse_age": spouse_age,
            "spouse_retirement_age": spouse_retirement_age,
            "inflation_rate": inflation_rate,
            "healthcare_pre_medicare": healthcare_pre_medicare,
            "contribution_after_first_retirement": contribution_after,
            "slow_go_start_age": slow_go_start_age,
            "no_go_start_age": no_go_start_age,
            "slow_go_multiplier": slow_go_multiplier,
            "no_go_multiplier": no_go_multiplier,
            "survivor_at_user_age": survivor_at_user_age,
            "pension_survivor_pct": pension_survivor_pct,
            "survivor_spending_multiplier": survivor_spending_multiplier,
            "state_tax_rate": state_tax_rate,
            "ltc_annual_cost": ltc_annual_cost,
            "ltc_start_age": ltc_start_age,
            "ltc_duration_years": ltc_duration_years,
            "taxable_basis_pct": taxable_basis_pct,
            "wage_growth_rate": wage_growth_rate,
            "healthcare_growth_rate": healthcare_growth_rate,
            "hsa_annual_contribution": hsa_annual_contribution,
            "roth_conversion_amount": roth_conversion_amount,
            "roth_conversion_start_age": roth_conversion_start_age,
            "roth_conversion_end_age": roth_conversion_end_age,
            "one_time_expenses": one_time_events,
            "step_events": step_events,
            "monte_carlo_runs": monte_carlo_runs,
            "return_volatility_working": return_volatility_working,
            "return_volatility_retired": return_volatility_retired,
            "sequence_stress_preset": sequence_stress_preset,
        },
        "monte_carlo": mc_results,
        "roth_comparison": roth_comparison,
        "ltc_comparison": ltc_comparison,
        "max_sustainable": max_sustainable,
        "ss_claim_sweep": ss_claim_sweep,
        "sim_after_tax_avg": round(sim_after_tax_avg, 2),
        "sim_after_tax_min": round(sim_after_tax_min, 2),
        "sim_after_tax_max": round(sim_after_tax_max, 2),
        "sim_bridge_after_tax_avg": round(sim_bridge_after_tax_avg, 2),
        "total_taxes_paid": round(total_taxes_paid, 2),
        "total_federal_tax": round(total_federal_tax, 2),
        "total_state_tax": round(total_state_tax, 2),
        "total_rmd_taken": round(total_rmd_taken, 2),
        "total_healthcare_paid": round(total_healthcare_paid, 2),
        "total_ltc_paid": round(total_ltc_paid, 2),
        "total_hsa_medical_paid": round(total_hsa_medical_paid, 2),
        "first_retirement_year": first_retirement_year,
        "current_assets": round(current_assets, 2),
        "years_to_retirement": years,
        "accumulation_years": accumulation_years,
        "last_retirement_user_age": last_retirement_user_age,
        "spouse_years_to_retire": spouse_years_to_retire,
        "depleted_age": depleted_age,
        "end_balance": round(end_balance, 2),
        "fi_number": round(fi_number, 2),
        "effective_fi_number": round(effective_fi_number, 2),
        "projected_balance": round(projected_balance, 2),
        "gap": round(gap, 2),
        "on_track": on_track,
        "sustainable_income": round(sustainable_income, 2),
        "combined_sustainable_income": round(combined_sustainable_income, 2),
        "monthly_contribution_to_close_gap": monthly_to_close_gap,
        "fi_hit_year": fi_hit_year,
        "fi_hit_age": fi_hit_age,
        "pension_at_start": round(pension_at_start, 2),
        "pension_pv": round(pension_pv, 2),
        "bridge_years": bridge_years,
        "bridge_full_income_needed": round(bridge_full_income_needed, 2),
        "year_by_year": year_by_year,
        "sensitivity": sensitivity,
        "buckets": {
            "tax_deferred": round(buckets["tax_deferred"], 2),
            "roth": round(buckets["roth"], 2),
            "taxable": round(buckets["taxable"], 2),
            "hsa": round(buckets["hsa"], 2),
        },
        "excluded_total": round(excluded_total, 2),
        "excluded_count": excluded_count,
        "ss_at_start": round(ss_at_start, 2),
        "ss_pv": round(ss_pv, 2),
        "after_tax_ss_income": round(after_tax_ss_income, 2),
        "ss2_at_start": round(ss2_at_start, 2),
        "ss2_pv": round(ss2_pv, 2),
        "after_tax_ss2_income": round(after_tax_ss2_income, 2),
        "ss_total_at_start": round(ss_total_at_start, 2),
        "ss_total_pv": round(ss_total_pv, 2),
        "bridge_pre_595": bridge_pre_595,
        "weighted_withdrawal_tax_rate": round(weighted_withdrawal_tax_rate, 4),
        "after_tax_portfolio_income": round(after_tax_portfolio_income, 2),
        "after_tax_pension_income": round(after_tax_pension_income, 2),
        "after_tax_combined_income": round(after_tax_combined_income, 2),
        "after_tax_fi_number": round(after_tax_fi_number, 2),
        # Net-target diagnostics — populated only when interpret_target_as='net'.
        # Tells the UI: "you asked for $80k net, the simulator iterated to a
        # gross of $X to hit it (Y iterations)." Lets the user verify the
        # gross-up isn't pathological (e.g. running into bracket cliffs).
        "interpret_target_as": interpret_target_as,
        "net_target_diagnostics": net_target_diagnostics,
    }
