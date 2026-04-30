"""Retirement simulation engine.

Two-phase year-by-year simulator with per-bucket tax tracking, plus
Monte Carlo / sequence-of-returns stress-test helpers. Extracted from
routers/analytics.py during the Phase 1 split — pure simulation, no
HTTP / DB layer touches it.

Public functions:
    simulate_two_phase  — single deterministic run
    generate_returns_path  — random return sequence for Monte Carlo
    apply_sequence_stress  — overlay a stress preset on a return path
    aggregate_monte_carlo  — collapse N runs into percentile bands
"""
from __future__ import annotations

import random
from typing import Optional

from app.services.tax import (
    filing_constants,
    irmaa_surcharge_annual,
    ltcg_tax,
    niit_tax,
    ordinary_tax,
    rmd_divisor,
    ss_taxable,
)


def simulate_two_phase(
    starting_buckets: dict,
    current_age: int,
    return_rate: float,
    retirement_return_rate: float,
    annual_contribution: float,
    contribution_after_first_retirement: float,
    accumulation_years: int,
    first_retirement_year: int,
    horizon_years: int,
    desired_income: float,
    streams: list[dict],
    tax_rate_ordinary: float,
    tax_rate_capital_gains: float,
    spouse_age: Optional[int],
    healthcare_pre_medicare: float,
    slow_go_start_age: int,
    no_go_start_age: int,
    slow_go_multiplier: float,
    no_go_multiplier: float,
    # Survivor scenario: at user_age = survivor_at_user_age, model
    # losing one spouse — drop smaller SS (survivor benefit rule),
    # reduce pension by pension_survivor_pct, switch to Single brackets.
    survivor_at_user_age: Optional[int] = None,
    pension_survivor_pct: float = 0.5,
    # Survivor spending multiplier — once one spouse is gone, baseline
    # spending typically drops to 65-75% of couple spending (housing
    # and utilities are largely fixed; food/travel/entertainment scale
    # with people). Default 0.7 = 70%, the conservative middle of the
    # industry range. Set to 1.0 to disable (model assumes no
    # spending change after a survivor event).
    survivor_spending_multiplier: float = 0.7,
    # State tax — flat rate applied to ordinary taxable income.
    state_tax_rate: float = 0.0,
    # Long-term care expense window.
    ltc_annual_cost: float = 0.0,
    ltc_start_age: int = 80,
    ltc_duration_years: int = 3,
    # Cost basis on taxable bucket. Only the GAIN portion (= 1 - basis_pct)
    # is taxed at LTCG. 0.5 = 50% of the bucket is original basis (no
    # gain), 0.0 = all gain (heavily appreciated), 1.0 = all basis (no
    # gain — recently funded). Default 0.5 = neutral assumption.
    taxable_basis_pct: float = 0.5,
    # Wage growth + healthcare-specific inflation (real terms, above
    # general inflation). Default 0 = flat-real behavior.
    wage_growth_rate: float = 0.0,
    healthcare_growth_rate: float = 0.0,
    # HSA contribution per year during accumulation. Lands in the HSA
    # bucket (NOT tax_deferred) so it grows tax-free for qualified
    # medical and is available to fund the healthcare bridge in
    # retirement. The simulator does NOT double-count: this should be
    # SEPARATE from annual_contribution. If you previously included
    # HSA $ in annual_contribution, subtract it. 0 = no HSA contribution
    # modeled (the HSA bucket only grows from its starting balance).
    hsa_annual_contribution: float = 0.0,
    # IRMAA Medicare surcharges. When True, add the per-spouse Part B+D
    # surcharge to spending in any year where one or both spouses are
    # >=65 AND household MAGI exceeds the IRMAA threshold (2025 first
    # tier = $206k MFJ). Tiers up to ~$2k/mo per spouse at the top.
    apply_irmaa: bool = True,
    # Section 199A QBI deduction. Annual qualified business income
    # (Schedule C, S-corp, partnership) — 20% deducted before brackets
    # apply. Useful when the user has business income flowing into
    # retirement years (consulting, royalties, residual LLC income).
    # Phase-out above $383k MFJ doesn't kick in for typical retirees;
    # left out for simplicity.
    qbi_business_income: float = 0.0,
    # Tax-loss harvesting on the taxable bucket. Annual realized loss
    # the user expects to harvest from the brokerage account. IRS caps
    # the ordinary-income offset at $3,000/yr for MFJ; excess carries
    # forward (already modeled by capital_loss_carryover_tracker on
    # the Investments page). Default 0 = no TLH.
    tlh_annual: float = 0.0,
    # TCJA sunset modeling. When True, federal ordinary brackets revert
    # to the higher pre-2018 schedule starting in `tcja_sunset_year`.
    # The biggest unmodeled tax risk for households with large TD
    # bucket — RMDs in the 70s land in 25/28/33% brackets instead of
    # 22/24/32%. Default OFF (assume Congress extends TCJA permanently).
    tcja_sunset_enabled: bool = False,
    tcja_sunset_year: int = 2026,
    # Calendar year the simulation starts in. Combined with
    # tcja_sunset_year, lets us flip brackets per year.
    calendar_start_year: Optional[int] = None,
    # ── Roth conversion ladder ──
    # Strategically convert tax_deferred → roth during bridge years
    # (first retirement → first SS claim) when ordinary income is low.
    # Pays tax now at lower brackets to escape future RMDs / higher
    # bracket pressure. Conversion is added to that year's ordinary
    # taxable income; the tax owed is paid from the taxable bucket
    # (preferred — keeps the gross amount in Roth) and falls back to
    # netting the tax out of the conversion when taxable is empty.
    # roth_conversion_amount = 0 disables the feature.
    roth_conversion_amount: float = 0.0,
    roth_conversion_start_age: int = 0,
    roth_conversion_end_age: int = 0,
    # Smarter alternative: fill-to-bracket strategy. When set to a
    # marginal rate (e.g. 0.12, 0.22, 0.24, 0.32), the simulator
    # computes per-year how much room is left in that bracket given
    # pension/SS/draws and converts exactly that amount. Overrides
    # roth_conversion_amount when both are set. None = use the flat
    # amount instead.
    roth_conversion_target_bracket: Optional[float] = None,
    # Qualified Charitable Distribution. Once age 70½+, up to $108k
    # (2025 limit, inflation-indexed) of an IRA distribution can be
    # sent direct from the IRA to a qualified charity, escaping
    # ordinary income tax. Counts toward the year's RMD. The bucket is
    # depleted just like a regular RMD would deplete it, but the gross
    # amount is excluded from taxable income — biggest tax optimization
    # most charitably-inclined retirees miss. Default 0 = no QCD.
    # Honored only in years where (a) user_age >= 70.5, AND (b) tax-
    # deferred bucket has the funds. Capped at 108k internally.
    qcd_annual: float = 0.0,
    # Lumpy one-time events: [{age, amount, label}, ...]. During
    # accumulation, reduce contribution; during withdrawal, add to
    # spending. Empty list = no events.
    one_time_events: Optional[list[dict]] = None,
    # Step events: PERMANENT (or duration-bound) shifts to spending or
    # contribution starting at a given age. The honest primitive for
    # life events whose financial impact persists rather than firing
    # once (mortgage payoff, kid leaves home, college, sabbatical,
    # business income kicking in).
    #
    # Shape: [{age, kind, delta, duration_years, label}]
    #   kind: 'spending' or 'contribution'
    #   delta: $/yr in today's dollars. Positive = more of that thing
    #          (more spending, OR more contribution). Negative = less.
    #   duration_years: 0 = permanent (forever); N = applies for N years
    #          starting at age, then expires.
    # Multiple events stack additively. Spending steps during the
    # accumulation phase reduce that year's contribution (since income
    # is fixed). Contribution steps during withdrawal phase do nothing
    # (no income to save from in retirement).
    step_events: Optional[list[dict]] = None,
    # Monte Carlo / stress tests: per-year return overrides. When
    # provided, the simulator uses returns_path[y-1] for that year's
    # return instead of return_rate / retirement_return_rate. Length
    # must match accumulation_years + horizon_years.
    returns_path: Optional[list[float]] = None,
) -> list[dict]:
    """Two-phase year-by-year sim with per-bucket tracking, withdrawal-
    order tax strategy, age-banded spending, healthcare bridge, RMDs,
    and tapered contribution after first retirement.

    Phase 1 (accumulation): annual_contribution flows entirely into
    tax_deferred (most realistic — bulk of working-age savings is
    payroll 401k deferral). After the FIRST spouse retires (year >
    first_retirement_year), contribution tapers to
    contribution_after_first_retirement. All buckets grow at return_rate.

    Phase 2 (withdrawal): contributions stop. Each year:
      1. Compute active fixed income (pension + SS streams).
      2. effective_spending = baseline × phase_multiplier (go-go /
         slow-go / no-go) + healthcare_pre_medicare if either spouse
         is < 65.
      3. requested_draw = max(0, effective_spending - income).
      4. RMD enforcement at age 73+: minimum tax-deferred draw =
         tax_deferred_balance / IRS divisor. If RMD exceeds requested
         draw, excess shifts to taxable bucket (real-life cash you'd
         re-invest).
      5. Pull rest from buckets in priority taxable → tax_deferred → roth.
      6. Tax-deferred draws before age 60 incur 10% IRS penalty.
      7. Compute per-year after-tax cash income.
      8. Buckets grow at retirement_return_rate after draws.
    """
    PRE_595 = 60
    PENALTY_RATE = 0.10
    SS_TAX_RATIO = 0.85
    MEDICARE_AGE = 65

    buckets = {
        "taxable": float(starting_buckets.get("taxable", 0.0)),
        "tax_deferred": float(starting_buckets.get("tax_deferred", 0.0)),
        "roth": float(starting_buckets.get("roth", 0.0)),
        # HSA — fourth bucket. Triple-tax-advantaged when spent on
        # qualified medical: contributions deductible, growth tax-free,
        # withdrawals tax-free. Treated as the OPTIMAL play to fund
        # healthcare bridge years and LTC. After 65 it functions like
        # an IRA for non-medical spending (taxable as ordinary income),
        # but we model only the qualified-medical case here. If the
        # user has surplus HSA after all medical needs are paid, the
        # leftover sits there indefinitely (no forced distribution).
        "hsa": float(starting_buckets.get("hsa", 0.0)),
    }

    rows = []
    total_years = accumulation_years + horizon_years
    # Survivor event year (in user-time). When None, household stays MFJ.
    survivor_year = (
        max(1, survivor_at_user_age - current_age)
        if survivor_at_user_age is not None
        else None
    )
    # One-time events default to empty list.
    if one_time_events is None:
        one_time_events = []
    if step_events is None:
        step_events = []
    # Default the calendar-start to current real-world year so the TCJA
    # sunset logic has something to compare against.
    if calendar_start_year is None:
        import datetime as _dt
        calendar_start_year = _dt.date.today().year

    for y in range(1, total_years + 1):
        user_age = current_age + y
        spouse_age_now = (spouse_age + y) if spouse_age is not None else None
        is_accumulating = y <= accumulation_years
        # TCJA sunset check: are we past the sunset_year in this sim year?
        # When True, ordinary brackets revert to pre-2018 schedule (which
        # has higher rates and a smaller standard deduction).
        calendar_year = calendar_start_year + y
        post_tcja = (
            tcja_sunset_enabled and calendar_year >= tcja_sunset_year
        )
        # Has a survivor event happened by this year? Once it has, the
        # household reverts to single filer with surviving SS only.
        in_survivor_phase = survivor_year is not None and y >= survivor_year
        filing_status = "single" if in_survivor_phase else "mfj"
        # Per-year return — either from the override path (Monte Carlo
        # / sequence stress) or from the fixed default rates.
        if returns_path is not None and (y - 1) < len(returns_path):
            year_return = returns_path[y - 1]
        elif is_accumulating:
            year_return = return_rate
        else:
            year_return = retirement_return_rate
        # Total amount of one-time events landing this exact year.
        # Each event is {age, amount, label}; user_age matches.
        event_total = sum(
            float(e.get("amount", 0))
            for e in one_time_events
            if int(e.get("age", -1)) == user_age
        )

        # Step events — sum the active deltas at this user_age. An event
        # is active if it has started (age <= user_age) AND hasn't yet
        # expired. duration_years=0 means permanent. Splits into
        # contribution_step (applied during accumulation) and
        # spending_step (applied during withdrawal phase, OR reduces
        # contribution during accumulation).
        def _step_active(e):
            start = int(e.get("age", 999999))
            if start > user_age:
                return False
            dur = int(e.get("duration_years", 0) or 0)
            return dur == 0 or user_age < start + dur
        contribution_step = sum(
            float(e.get("delta", 0))
            for e in step_events
            if e.get("kind") == "contribution" and _step_active(e)
        )
        spending_step = sum(
            float(e.get("delta", 0))
            for e in step_events
            if e.get("kind") == "spending" and _step_active(e)
        )

        # ── Active fixed income for the year ──
        # Compute per-stream values first so we can apply survivor
        # adjustments below. Pension reductions and SS-survivor-benefit
        # rules need stream-level granularity, not the aggregate.
        pension_this_year = 0.0
        ss_amounts_by_label = {}  # label → today's-dollars value
        for s in streams:
            if s["amount_today"] <= 0:
                continue
            holder_age_now = s["holder_age_today"] + y
            if holder_age_now >= s["start_age"]:
                years_since_claim = holder_age_now - s["start_age"]
                value = s["amount_today"] * ((1 + s["cola"]) ** years_since_claim)
                if s.get("label") == "pension":
                    pension_this_year += value
                else:
                    ss_amounts_by_label[s["label"]] = value

        # Survivor adjustments:
        # 1. Pension drops to pension_survivor_pct of original (typical
        #    J&S 50% / 75% / 100% survivor election made at retirement).
        #    User can set pct=1.0 if their plan continues full to spouse.
        # 2. SS: survivor takes the HIGHER of the two streams (this is
        #    the SSA survivor-benefit rule). Net effect: drop the smaller.
        if in_survivor_phase:
            pension_this_year *= pension_survivor_pct
            if ss_amounts_by_label:
                higher_ss = max(ss_amounts_by_label.values())
                ss_amounts_by_label = {"ss": higher_ss}

        ss_this_year = sum(ss_amounts_by_label.values())
        income_this_year = pension_this_year + ss_this_year

        # ── Effective spending for this year (phase + healthcare + LTC) ──
        if user_age >= no_go_start_age:
            phase_multiplier = no_go_multiplier
        elif user_age >= slow_go_start_age:
            phase_multiplier = slow_go_multiplier
        else:
            phase_multiplier = 1.0
        # Survivor adjustment — applies after age-banded multiplier
        # so a no-go-phase survivor still gets the no-go reduction
        # AND the survivor reduction (compounding correctly).
        survivor_multiplier = (
            survivor_spending_multiplier if in_survivor_phase else 1.0
        )
        effective_spending = desired_income * phase_multiplier * survivor_multiplier

        # Healthcare bridge — applies only during withdrawal phase, only
        # when EITHER spouse is < 65. Grows in real terms by
        # healthcare_growth_rate (medical CPI runs above general).
        healthcare_added = 0.0
        if not is_accumulating and healthcare_pre_medicare > 0:
            user_pre_medicare = user_age < MEDICARE_AGE
            spouse_pre_medicare = (
                spouse_age_now is not None and spouse_age_now < MEDICARE_AGE
                and not in_survivor_phase  # spouse no longer in household
            )
            if user_pre_medicare or spouse_pre_medicare:
                hc_growth_factor = (1 + healthcare_growth_rate) ** y
                healthcare_added = healthcare_pre_medicare * hc_growth_factor
                effective_spending += healthcare_added

        # Long-term care — also grows at healthcare-specific rate.
        ltc_added = 0.0
        if (
            not is_accumulating
            and ltc_annual_cost > 0
            and ltc_start_age <= user_age < ltc_start_age + ltc_duration_years
        ):
            hc_growth_factor = (1 + healthcare_growth_rate) ** y
            ltc_added = ltc_annual_cost * hc_growth_factor
            effective_spending += ltc_added

        # One-time events:
        #   POSITIVE amount = expense (wedding, RV, home renovation):
        #     - During accumulation, reduces contribution that year.
        #     - During withdrawal, adds to spending that year.
        #   NEGATIVE amount = inflow (cash inheritance, gift, sale of an
        #     unmodeled asset, lawsuit settlement). Per-event `bucket`
        #     field directs where it lands; default 'taxable' matches
        #     a cash inheritance (tax-free to recipient, deposited in
        #     brokerage). Other buckets:
        #       'tax_deferred' — inherited Trad-IRA (post-SECURE Act,
        #         must be drained over 10 years; this model lets you
        #         simulate by adding to TD AND scheduling expenses to
        #         spend it down by year 10)
        #       'roth' — inherited Roth IRA (also 10-yr drain, but
        #         tax-free)
        #       'hsa' — inherited HSA (only spouse-friendly; non-spouse
        #         inheritance gets distributed as taxable income — model
        #         that case as 'tax_deferred' instead)
        # Per-event bucket overrides the default.
        event_inflow_by_bucket = {"taxable": 0.0, "tax_deferred": 0.0, "roth": 0.0, "hsa": 0.0}
        event_expense = max(0.0, event_total)
        for e in one_time_events:
            if int(e.get("age", -1)) != user_age:
                continue
            amt = float(e.get("amount", 0))
            if amt < 0:  # inflow
                target = e.get("bucket") or "taxable"
                if target not in event_inflow_by_bucket:
                    target = "taxable"
                event_inflow_by_bucket[target] += -amt
        for b, amt in event_inflow_by_bucket.items():
            if amt > 0:
                buckets[b] += amt
        # Backwards-compat alias used in the next branch's contribution
        # logic — total of all inflows this year.
        event_inflow = sum(event_inflow_by_bucket.values())
        if not is_accumulating and event_expense > 0:
            effective_spending += event_expense
        # Step events on spending shift the baseline up or down
        # permanently from their start age. Applies in withdrawal phase
        # only — during accumulation, spending isn't directly modeled
        # (the impact flows through reduced contribution below).
        if not is_accumulating:
            effective_spending += spending_step

        if is_accumulating:
            # Tapered contribution: drops to contribution_after_first_retirement
            # once one spouse has retired (year > first_retirement_year).
            base_contribution = (
                contribution_after_first_retirement
                if y > first_retirement_year
                else annual_contribution
            )
            # Apply real wage growth (compounded years from today).
            wage_factor = (1 + wage_growth_rate) ** y
            contribution_this_year = base_contribution * wage_factor
            # Apply step events:
            #   contribution_step: ADDS to contribution (e.g., mortgage
            #     payoff frees $24k/yr → user routes it to savings).
            #   spending_step: SUBTRACTS from contribution if positive
            #     (more spending = less to save). If negative, it
            #     effectively adds to contribution (less spending freed
            #     up for savings — same as a contribution_step would).
            contribution_this_year += contribution_step
            contribution_this_year -= spending_step
            # Subtract one-time event EXPENSES from contribution (e.g.,
            # wedding paid from would-be savings). Floored at 0 — doesn't
            # pull from portfolio during accumulation. (Inflows already
            # landed in the taxable bucket above and don't affect this.)
            if event_expense > 0:
                contribution_this_year = max(0.0, contribution_this_year - event_expense)
            # Floor at 0 after all adjustments — never pulls from
            # portfolio during accumulation.
            contribution_this_year = max(0.0, contribution_this_year)
            # Grow every bucket at the year's return rate; contributions
            # land in their respective buckets. HSA gets its own annual
            # contribution (real-life IRS family limit ~$8.5k as of 2025
            # plus catch-up after 55) — it is NOT subtracted from the
            # main annual_contribution because the user enters the two
            # separately. If you previously bundled HSA $ into
            # annual_contribution, subtract it from that field after
            # this fix to avoid double-counting.
            for k in buckets:
                buckets[k] *= (1 + year_return)
            buckets["tax_deferred"] += contribution_this_year
            # HSA contribution also gets the wage_factor treatment since
            # IRS limits are inflation-adjusted yearly, and the user's
            # personal contribution typically tracks that.
            hsa_contribution_this_year = hsa_annual_contribution * wage_factor
            buckets["hsa"] += hsa_contribution_this_year
            balance = buckets["taxable"] + buckets["tax_deferred"] + buckets["roth"] + buckets["hsa"]
            rows.append({
                "year": y,
                "age": user_age,
                "balance": round(balance, 2),
                "balance_taxable": round(buckets["taxable"], 2),
                "balance_tax_deferred": round(buckets["tax_deferred"], 2),
                "balance_roth": round(buckets["roth"], 2),
                "balance_hsa": round(buckets["hsa"], 2),
                "phase": "accumulating",
                "contributed": round(contribution_this_year, 2),
                "hsa_contributed": round(hsa_contribution_this_year, 2),
                "income_streams": round(income_this_year, 2),
                "portfolio_draw": 0.0,
                "draw_taxable": 0.0,
                "draw_tax_deferred": 0.0,
                "draw_roth": 0.0,
                "draw_hsa_nonmedical": 0.0,
                "income_shortfall": 0.0,
                "after_tax_income": 0.0,
                "early_withdrawal_penalty": 0.0,
                "rmd_required": 0.0,
                "effective_spending": round(effective_spending, 2),
                "healthcare_cost": 0.0,
                "ltc_cost": 0.0,
                "tax_paid": 0.0,
                "tax_federal": 0.0,
                "tax_state": 0.0,
                "taxable_ss": 0.0,
                "filing_status": filing_status,
                "roth_converted": 0.0,
                "roth_conversion_tax": 0.0,
                "hsa_medical_draw": 0.0,
                "irmaa_surcharge": 0.0,
                "qcd": 0.0,
            })
        else:
            # ── HSA pre-pays qualified medical ──
            # Healthcare bridge cost + LTC cost are both qualified
            # medical for HSA purposes — pull tax-free from HSA first
            # before computing the remaining draw. This is the optimal
            # HSA strategy: never spend HSA on non-medical, save it as
            # the dedicated medical war chest. Reduces effective_spending
            # by the amount HSA covers, which trickles down to lower
            # taxable draws (and lower lifetime tax).
            qualified_medical = healthcare_added + ltc_added
            hsa_medical_draw = 0.0
            if qualified_medical > 0 and buckets["hsa"] > 0:
                hsa_medical_draw = min(buckets["hsa"], qualified_medical)
                buckets["hsa"] -= hsa_medical_draw
                effective_spending -= hsa_medical_draw

            requested_draw = max(0.0, effective_spending - income_this_year)
            draws = {"taxable": 0.0, "tax_deferred": 0.0, "roth": 0.0, "hsa": 0.0}

            # ── Roth conversion (if active this year) ──
            # Move tax_deferred → roth. The conversion amount is added
            # to ordinary income for tax computation below. Tax owed on
            # the conversion is paid from the taxable bucket if it can
            # cover (preferred — keeps gross amount in Roth growing
            # tax-free forever); otherwise the tax is netted out of the
            # converted amount. Tracked separately from regular draws.
            #
            # Two strategies (target_bracket overrides flat amount):
            #   - Flat amount: convert roth_conversion_amount/yr.
            #   - Fill-to-bracket: pre-compute how much room is left in
            #     the target bracket given pension/SS/draws, convert
            #     exactly that amount. Smarter; bigger conversions in
            #     low-income years, smaller as SS/RMDs eat headroom.
            roth_converted = 0.0
            in_conversion_window = (
                roth_conversion_start_age <= user_age <= roth_conversion_end_age
                and buckets["tax_deferred"] > 0
            )
            if in_conversion_window and roth_conversion_target_bracket is not None:
                # Compute room in the target bracket. Estimate the
                # ordinary income BEFORE conversion: pension + planned
                # TD draws (assume requested_draw will tap TD because
                # taxable is usually drained earlier in retirement).
                # This is approximate but good enough — under/over-shoot
                # by a year is acceptable.
                bracket_top = 0.0
                brackets, _, std_ded, _, _ = filing_constants(filing_status, post_tcja=post_tcja)
                for threshold, rate in brackets:
                    if rate >= roth_conversion_target_bracket:
                        bracket_top = threshold
                        break
                pre_conversion_ordinary = max(
                    0.0,
                    pension_this_year + min(buckets["tax_deferred"], requested_draw) - std_ded,
                )
                room = max(0.0, bracket_top - pre_conversion_ordinary)
                roth_converted = min(room, buckets["tax_deferred"])
            elif in_conversion_window and roth_conversion_amount > 0:
                # Don't convert more than what's in the bucket. Also,
                # don't convert during accumulation — handled by being
                # in the else-branch (withdrawal phase only).
                roth_converted = min(
                    roth_conversion_amount, buckets["tax_deferred"]
                )
            if roth_converted > 0:
                buckets["tax_deferred"] -= roth_converted
                buckets["roth"] += roth_converted
                # Tax payment happens after we compute the year's tax
                # bill below — see the "pay conversion tax" block.

            # ── RMD enforcement ──
            divisor = rmd_divisor(user_age)
            required_rmd = (
                buckets["tax_deferred"] / divisor
                if divisor > 0 and buckets["tax_deferred"] > 0
                else 0.0
            )
            # QCD — Qualified Charitable Distribution. Once age 70½+, up
            # to $108k/yr (2025 IRC §408(d)(8) limit, inflation-indexed)
            # can flow direct from the IRA to a qualified charity. The
            # gross amount is EXCLUDED from taxable income — bigger win
            # than withdrawing + donating because most retirees take the
            # standard deduction and "lose" the charitable deduction.
            #
            # Mechanics: depletes the IRA bucket but neither satisfies
            # the user's spending need (the money went to charity, not
            # the user's pocket) nor counts as ordinary income. Counts
            # toward satisfying any RMD in years where RMD applies.
            # Requested_draw stays the same — the user still needs to
            # fund their lifestyle from remaining bucket capacity.
            qcd_this_year = 0.0
            QCD_LIMIT_2025 = 108_000.0
            QCD_AGE_THRESHOLD = 70  # IRS uses 70½; rounded down here
            if (
                qcd_annual > 0
                and user_age >= QCD_AGE_THRESHOLD
                and buckets["tax_deferred"] > 0
            ):
                qcd_this_year = min(
                    qcd_annual, QCD_LIMIT_2025, buckets["tax_deferred"]
                )
                buckets["tax_deferred"] -= qcd_this_year
                # QCD counts toward satisfying RMD obligation.
                required_rmd = max(0.0, required_rmd - qcd_this_year)
            if required_rmd > 0:
                rmd_pulled = min(buckets["tax_deferred"], required_rmd)
                buckets["tax_deferred"] -= rmd_pulled
                draws["tax_deferred"] = rmd_pulled
                # Excess RMD beyond what's needed flows to taxable
                # (real life: forced cash distribution, you re-invest
                # in brokerage). The full RMD is taxed at ordinary
                # income — only the AFTER-TAX cash actually lands in
                # the new investment. Previously we re-invested the
                # gross amount, overstating the taxable bucket growth
                # by the tax that's already been paid.
                excess_rmd_gross = max(0.0, rmd_pulled - requested_draw)
                if excess_rmd_gross > 0:
                    buckets["taxable"] += excess_rmd_gross * (1 - tax_rate_ordinary)
                # Remaining draw needed after RMD already counted.
                remaining = max(0.0, requested_draw - rmd_pulled)
            else:
                remaining = requested_draw

            # ── Priority-order draws for the rest ──
            # HSA after age 65: any leftover HSA balance can fund
            # non-medical spending at ordinary income tax (no 20%
            # penalty). So slot HSA between TD and Roth — drain it
            # before touching Roth (which we want to preserve for
            # legacy / step-up basis). Track the non-medical HSA draw
            # separately so it can be added to ordinary taxable income.
            hsa_nonmedical_draw = 0.0
            if user_age >= MEDICARE_AGE:
                priority = ("taxable", "tax_deferred", "hsa", "roth")
            else:
                priority = ("taxable", "tax_deferred", "roth")
            for bucket in priority:
                if remaining <= 0:
                    break
                pulled = min(buckets[bucket], remaining)
                draws[bucket] = draws.get(bucket, 0.0) + pulled
                buckets[bucket] -= pulled
                remaining -= pulled
                if bucket == "hsa":
                    hsa_nonmedical_draw += pulled
            actual_draw = sum(draws.values())
            income_shortfall = round(requested_draw - actual_draw, 2)

            # Pre-59½ penalty — applied to all tax-deferred draws,
            # including any RMD portion (RMDs only kick in at 73 so
            # this branch only triggers when both conditions impossibly
            # overlap; harmless safety).
            early_penalty = (
                draws["tax_deferred"] * PENALTY_RATE
                if user_age < PRE_595
                else 0.0
            )

            # ── Bracket-aware tax (MFJ or Single per filing_status) ──
            # Replaces the old flat-rate calc. Filing status switches
            # to Single after a survivor event — bracket compression
            # is one of the biggest hidden costs of losing a spouse.
            # Roth conversion adds to ordinary income for the year —
            # this is the "pay tax now" half of the conversion trade.
            # HSA non-medical draws (post-65 only) also add to ordinary
            # income — at 65+, HSA acts like a Trad IRA for non-medical
            # spending: distribution counts as ordinary income, no 20%
            # penalty. Pre-65 non-medical HSA draws aren't possible
            # under this model (HSA only flows for medical).
            other_ordinary_pretax = (
                pension_this_year + draws["tax_deferred"] + roth_converted
                + hsa_nonmedical_draw
            )
            # Cost basis: only the GAIN portion of the taxable draw is
            # taxable. taxable_basis_pct = portion that's basis (return
            # of capital, not taxed). 0.5 default = 50% of bucket is
            # basis. For heavily appreciated holdings, set lower; for
            # recently funded, set higher.
            taxable_brokerage_draw = draws["taxable"]
            taxable_gain_portion = taxable_brokerage_draw * (1 - taxable_basis_pct)

            # SS taxable uses AGI components excluding SS itself. The
            # GAIN portion of LTCG counts in AGI (basis return doesn't).
            other_income_for_ss = other_ordinary_pretax + taxable_gain_portion
            _, _, std_ded, _, _ = filing_constants(filing_status, post_tcja=post_tcja)
            taxable_ss = ss_taxable(
                ss_this_year, other_income_for_ss, filing=filing_status
            )

            # MAGI for IRMAA = AGI + tax-exempt interest. Approximated
            # here as ordinary pre-tax income + taxable SS portion +
            # LTCG gain. Tax-exempt interest (muni bonds) isn't tracked
            # so the figure is slightly understated for muni-heavy
            # portfolios.
            magi_for_irmaa = (
                other_ordinary_pretax + taxable_ss + taxable_gain_portion
            )
            # IRMAA only applies once at least one spouse is on Medicare
            # (age 65+). Two-spouse households on Medicare pay 2x the
            # per-person figure; one-spouse pays 1x.
            num_on_medicare = 0
            if user_age >= MEDICARE_AGE:
                num_on_medicare += 1
            if (
                spouse_age_now is not None
                and spouse_age_now >= MEDICARE_AGE
                and not in_survivor_phase
            ):
                num_on_medicare += 1
            irmaa_added = 0.0
            if apply_irmaa and num_on_medicare > 0 and magi_for_irmaa > 0:
                irmaa = irmaa_surcharge_annual(
                    magi_for_irmaa, filing=filing_status,
                    num_on_medicare=num_on_medicare,
                )
                irmaa_added = irmaa["annual_household"]
                effective_spending += irmaa_added

            # QBI deduction (Section 199A) — 20% of qualified business
            # income deducted before brackets. Treats QBI as additional
            # ordinary income that gets a 20% rebate via the deduction.
            qbi_deduction = qbi_business_income * 0.20
            # Tax-loss harvesting offset — IRS caps the ordinary-income
            # offset from harvested capital losses at $3,000/yr (MFJ
            # and Single — same cap). Anything above carries forward to
            # next year, which we don't track here (the Investments
            # page has a separate carryover tracker).
            tlh_deduction = min(tlh_annual, 3000.0)
            # Ordinary taxable income (after standard + QBI + TLH deductions).
            # QBI also adds to ordinary income before the deduction.
            ordinary_taxable = max(
                0.0,
                other_ordinary_pretax + taxable_ss + qbi_business_income
                - std_ded - qbi_deduction - tlh_deduction,
            )
            # Locals are explicitly suffixed _owed so they don't shadow
            # the imported tax-helper functions of the same root name.
            ord_tax_owed = ordinary_tax(ordinary_taxable, filing=filing_status, post_tcja=post_tcja)
            cap_gains_tax_owed = ltcg_tax(
                taxable_gain_portion, ordinary_taxable, filing=filing_status
            )
            # State tax — flat rate applied to all ordinary taxable
            # income + the LTCG gain portion. Most states tax LTCG as
            # ordinary income (MI does); a few (CA) have separate
            # LTCG schedules. Conservative simplification.
            state_tax = (ordinary_taxable + taxable_gain_portion) * state_tax_rate
            # NIIT 3.8% on net investment income above MAGI threshold.
            # Investment income here = LTCG gain portion only (ordinary
            # income from TD draws / pension / SS is excluded by IRC
            # 1411). MAGI approximated above as magi_for_irmaa.
            niit_owed = niit_tax(taxable_gain_portion, magi_for_irmaa, filing=filing_status)
            total_tax = ord_tax_owed + cap_gains_tax_owed + state_tax + niit_owed + early_penalty

            # ── Pay the conversion tax ──
            # The incremental tax caused by the conversion ideally comes
            # out of the taxable bucket — that keeps the gross converted
            # amount in Roth growing tax-free forever (the optimal play).
            # If taxable can't cover, the rest is netted out of the Roth
            # (less optimal but realistic). We attribute the conversion's
            # share of the year's tax bill proportionally to the share
            # of ordinary income it represents.
            roth_conversion_tax = 0.0
            if roth_converted > 0 and other_ordinary_pretax > 0:
                conv_share = roth_converted / other_ordinary_pretax
                roth_conversion_tax = (ord_tax_owed + state_tax) * conv_share
                # Pay from taxable bucket first.
                pay_from_taxable = min(
                    buckets["taxable"], roth_conversion_tax
                )
                buckets["taxable"] -= pay_from_taxable
                shortfall = roth_conversion_tax - pay_from_taxable
                # Fall back: pull the unpaid portion from Roth (effectively
                # netting out of the conversion). Reduces lifetime benefit.
                if shortfall > 0:
                    pay_from_roth = min(buckets["roth"], shortfall)
                    buckets["roth"] -= pay_from_roth

            # After-tax cash to spend = all inflows minus all taxes.
            # Roth draws are already tax-free; everything else has been
            # accounted for in total_tax. Income shortfall is spending
            # the user wanted but couldn't get from the empty portfolio
            # — surfaces as a separate field, doesn't affect tax.
            # Note: the conversion tax was already paid out of the
            # taxable / Roth buckets above, so we subtract it from the
            # tax line here to avoid double-counting against spendable
            # cash. The conversion's federal+state portion is reported
            # separately in tax_paid for the lifetime tally.
            gross_income = (
                draws["taxable"]
                + draws["tax_deferred"]
                + draws["roth"]
                + draws["hsa"]   # post-65 non-medical HSA draws count as cash
                + pension_this_year
                + ss_this_year
            )
            after_tax_income = gross_income - (total_tax - roth_conversion_tax)

            # Buckets grow on what's left after draws — at year_return
            # which is either the override (Monte Carlo / stress) or
            # the fixed retirement_return_rate.
            for k in buckets:
                buckets[k] *= (1 + year_return)
            balance = buckets["taxable"] + buckets["tax_deferred"] + buckets["roth"] + buckets["hsa"]
            rows.append({
                "year": y,
                "age": user_age,
                "balance": round(balance, 2),
                "balance_taxable": round(buckets["taxable"], 2),
                "balance_tax_deferred": round(buckets["tax_deferred"], 2),
                "balance_roth": round(buckets["roth"], 2),
                "balance_hsa": round(buckets["hsa"], 2),
                "phase": "withdrawing",
                "contributed": 0.0,
                "hsa_contributed": 0.0,
                "income_streams": round(income_this_year, 2),
                "portfolio_draw": round(actual_draw, 2),
                "draw_taxable": round(draws["taxable"], 2),
                "draw_tax_deferred": round(draws["tax_deferred"], 2),
                "draw_roth": round(draws["roth"], 2),
                # HSA non-medical draw (post-65 only). Counted as ordinary
                # income in the tax math above. Distinct from
                # hsa_medical_draw which is tax-free.
                "draw_hsa_nonmedical": round(hsa_nonmedical_draw, 2),
                "income_shortfall": income_shortfall,
                "after_tax_income": round(after_tax_income, 2),
                "early_withdrawal_penalty": round(early_penalty, 2),
                "rmd_required": round(required_rmd, 2),
                "effective_spending": round(effective_spending, 2),
                "healthcare_cost": round(healthcare_added, 2),
                "ltc_cost": round(ltc_added, 2),
                # Total tax paid this year — ordinary + LTCG + state +
                # any early-withdrawal penalty. Bracket-aware via MFJ
                # or Single per filing_status (after survivor event).
                "tax_paid": round(total_tax, 2),
                "tax_federal": round(ord_tax_owed + cap_gains_tax_owed + niit_owed + early_penalty, 2),
                "tax_state": round(state_tax, 2),
                "taxable_ss": round(taxable_ss, 2),
                "filing_status": filing_status,
                # Roth conversion this year: gross converted, tax owed
                # on the conversion (already paid from taxable/Roth above).
                "roth_converted": round(roth_converted, 2),
                "roth_conversion_tax": round(roth_conversion_tax, 2),
                # HSA tax-free draw covering qualified medical
                # (healthcare bridge + LTC). Reduces effective_spending
                # 1:1 without hitting any of the other buckets.
                "hsa_medical_draw": round(hsa_medical_draw, 2),
                "irmaa_surcharge": round(irmaa_added, 2),
                # QCD — gross dollars sent direct from IRA to charity.
                # Depletes tax_deferred bucket but skips ordinary income
                # tax. Counted toward RMD when age >= 70.5.
                "qcd": round(qcd_this_year, 2),
            })

    return rows


# ─── Monte Carlo + sequence stress helpers ─────────────────────────


def generate_returns_path(
    accumulation_years: int,
    horizon_years: int,
    accum_mean: float,
    retired_mean: float,
    accum_vol: float,
    retired_vol: float,
    rng: random.Random,
) -> list[float]:
    """Generate a random return path. Normal distribution per year:
    accumulation phase ~ N(accum_mean, accum_vol);
    withdrawal phase ~ N(retired_mean, retired_vol).
    Floored at -50% so a single catastrophic draw can't break the math."""
    out = []
    for y in range(1, accumulation_years + horizon_years + 1):
        if y <= accumulation_years:
            r = rng.gauss(accum_mean, accum_vol)
        else:
            r = rng.gauss(retired_mean, retired_vol)
        out.append(max(-0.50, r))
    return out


def apply_sequence_stress(
    base_returns: list[float],
    preset: str,
    accumulation_years: int,
) -> list[float]:
    """Overlay a stress preset on the base deterministic return path.
    Modifies the early withdrawal years to model historically bad
    sequences. Returns a new list (doesn't mutate input)."""
    if not preset or preset == "none":
        return base_returns
    out = list(base_returns)
    if preset == "bad_3":
        # First 3 withdrawal years: -20% real
        for i in range(3):
            idx = accumulation_years + i
            if idx < len(out):
                out[idx] = -0.20
    elif preset == "lost_decade":
        # First 10 withdrawal years: 0% real (treading water)
        for i in range(10):
            idx = accumulation_years + i
            if idx < len(out):
                out[idx] = 0.0
    elif preset == "recession_5":
        # Year 5 of withdrawal: -15% (mid-bridge recession)
        idx = accumulation_years + 4
        if idx < len(out):
            out[idx] = -0.15
    elif preset == "inflation_shock":
        # 2022-23 style: 3 years of -5% real returns from inflation
        # spike. Models the "your portfolio nominal returns are fine
        # but real returns get crushed because inflation runs 7-9%
        # vs 2-3% baseline" scenario. Applies in early withdrawal.
        for i in range(3):
            idx = accumulation_years + i
            if idx < len(out):
                # Subtract 5% from whatever the base return was
                # — keeps the existing return assumption but shocks it
                # by the inflation differential.
                out[idx] = out[idx] - 0.05
    return out


def aggregate_monte_carlo(all_runs: list[list[dict]]) -> dict:
    """Aggregate N Monte Carlo runs into per-year percentiles plus
    success rate and depletion-age distribution. Returns dict suitable
    for inclusion in the API response.

    Percentiles computed via simple sort + index (no scipy needed).
    """
    if not all_runs:
        return {
            "year_by_year_pct": [],
            "success_probability": 0.0,
            "n_runs": 0,
            "depletion_ages": [],
            "median_end_balance": 0.0,
        }
    n_runs = len(all_runs)
    n_years = len(all_runs[0])
    pct_rows = []
    for y_idx in range(n_years):
        balances = sorted(run[y_idx]["balance"] for run in all_runs)
        # Index for percentile: floor(p * n) — fine for our coarse use.
        def pct(p):
            return balances[min(n_runs - 1, max(0, int(p * n_runs)))]
        pct_rows.append({
            "year": all_runs[0][y_idx]["year"],
            "age": all_runs[0][y_idx]["age"],
            "balance_p10": round(pct(0.10), 2),
            "balance_p25": round(pct(0.25), 2),
            "balance_p50": round(pct(0.50), 2),
            "balance_p75": round(pct(0.75), 2),
            "balance_p90": round(pct(0.90), 2),
        })

    # Success rate: portfolio still has balance > 0 at end of horizon.
    # Conservative — counts only fully-funded paths as success.
    survivors = sum(1 for r in all_runs if r[-1]["balance"] > 0)
    success_prob = survivors / n_runs

    # Depletion age distribution — first year balance hits 0 in withdrawal.
    depletion_ages = []
    for run in all_runs:
        for row in run:
            if row["phase"] == "withdrawing" and row["balance"] <= 0:
                depletion_ages.append(row["age"])
                break

    # Median end balance — the middle outcome.
    end_balances = sorted(r[-1]["balance"] for r in all_runs)
    median_end = end_balances[n_runs // 2]

    return {
        "year_by_year_pct": pct_rows,
        "success_probability": round(success_prob, 4),
        "n_runs": n_runs,
        "depletion_ages": depletion_ages,
        "median_end_balance": round(median_end, 2),
    }
