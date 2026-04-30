"""US tax math used by the retirement projection.

Extracted from routers/analytics.py during the Phase 1 split. All values
are 2025 figures sourced from IRS Rev. Proc. 2024-40 and the SECURE 2.0
RMD Uniform Lifetime Table.

The retirement projection runs in real (today's-dollars) terms, so
brackets are held constant — they're inflation-adjusted in real life and
the model's "real" framing already accounts for that.
"""
from __future__ import annotations

# ─── Tax bracket constants (MFJ 2025) ──────────────────────────────
TAX_BRACKETS_MFJ = [
    (23850,    0.10),
    (96950,    0.12),
    (206700,   0.22),
    (394600,   0.24),
    (501050,   0.32),
    (751600,   0.35),
    (float("inf"), 0.37),
]
LTCG_BRACKETS_MFJ = [
    (96700,    0.00),  # 0% bracket — huge benefit for low-income retirees
    (600050,   0.15),
    (float("inf"), 0.20),
]
STANDARD_DEDUCTION_MFJ = 30000  # 2025; usually slightly higher each year
SS_TAX_BASE1_MFJ = 32000
SS_TAX_BASE2_MFJ = 44000

# Single filer brackets (used after a survivor event flips the household
# filing status from MFJ to Single — bracket compression is one of the
# biggest hidden costs of losing a spouse).
TAX_BRACKETS_SINGLE = [
    (11925,    0.10),
    (48475,    0.12),
    (103350,   0.22),
    (197300,   0.24),
    (250525,   0.32),
    (626350,   0.35),
    (float("inf"), 0.37),
]
LTCG_BRACKETS_SINGLE = [
    (48350,    0.00),
    (533400,   0.15),
    (float("inf"), 0.20),
]
STANDARD_DEDUCTION_SINGLE = 15000  # 2025 — half of MFJ
SS_TAX_BASE1_SINGLE = 25000
SS_TAX_BASE2_SINGLE = 34000


# ─── Pre-TCJA (post-sunset) brackets ───────────────────────────────
# TCJA is scheduled to sunset at end of 2025; absent congressional
# action, federal ordinary brackets revert to the pre-2018 schedule
# starting in 2026: 22%→25%, 24%→28%, 32%→33%, 35%→35%, 37%→39.6%.
# Standard deduction roughly halves. These figures are the 2017
# brackets adjusted to today's-dollar terms (2025 thresholds with the
# old rate schedule mapped on). LTCG schedule is unchanged by TCJA.
TAX_BRACKETS_MFJ_POST_TCJA = [
    (23850,    0.10),
    (96950,    0.15),  # was 12% under TCJA
    (206700,   0.25),  # was 22%
    (394600,   0.28),  # was 24%
    (501050,   0.33),  # was 32%
    (751600,   0.35),  # unchanged
    (float("inf"), 0.396),  # was 37%
]
TAX_BRACKETS_SINGLE_POST_TCJA = [
    (11925,    0.10),
    (48475,    0.15),
    (103350,   0.25),
    (197300,   0.28),
    (250525,   0.33),
    (626350,   0.35),
    (float("inf"), 0.396),
]
# Standard deduction roughly halves under post-TCJA. Use IRS 2017
# adjusted-to-today figures.
STANDARD_DEDUCTION_MFJ_POST_TCJA = 15000   # ~half of TCJA's $30k
STANDARD_DEDUCTION_SINGLE_POST_TCJA = 7500
# Toggle: when set, ordinary_tax / filing_constants use the post-TCJA
# tables. Default False = TCJA still in effect (current law for 2025
# and any extended-by-Congress scenarios). The simulator wires the
# user's toggle through.
TCJA_SUNSET_ACTIVE = False


def filing_constants(filing: str, post_tcja: bool = False):
    """Return (brackets, ltcg_brackets, std_deduction, ss_base1, ss_base2)
    for the given filing status. 'mfj' or 'single'.

    `post_tcja=True` returns the higher pre-TCJA brackets and smaller
    standard deduction. LTCG brackets and SS taxation thresholds are
    unchanged by TCJA so they're constant across both modes."""
    if filing == "single":
        return (
            TAX_BRACKETS_SINGLE_POST_TCJA if post_tcja else TAX_BRACKETS_SINGLE,
            LTCG_BRACKETS_SINGLE,
            STANDARD_DEDUCTION_SINGLE_POST_TCJA if post_tcja else STANDARD_DEDUCTION_SINGLE,
            SS_TAX_BASE1_SINGLE,
            SS_TAX_BASE2_SINGLE,
        )
    return (
        TAX_BRACKETS_MFJ_POST_TCJA if post_tcja else TAX_BRACKETS_MFJ,
        LTCG_BRACKETS_MFJ,
        STANDARD_DEDUCTION_MFJ_POST_TCJA if post_tcja else STANDARD_DEDUCTION_MFJ,
        SS_TAX_BASE1_MFJ,
        SS_TAX_BASE2_MFJ,
    )


def ordinary_tax(taxable_income: float, filing: str = "mfj", post_tcja: bool = False) -> float:
    """Progressive ordinary-income tax on `taxable_income` (post-deduction).
    Picks brackets by filing status + TCJA-active flag. Walks the
    brackets and sums the marginal portions — standard tax-table calc."""
    if taxable_income <= 0:
        return 0.0
    brackets, _, _, _, _ = filing_constants(filing, post_tcja=post_tcja)
    tax = 0.0
    prev_threshold = 0.0
    for threshold, rate in brackets:
        if taxable_income <= threshold:
            return tax + (taxable_income - prev_threshold) * rate
        tax += (threshold - prev_threshold) * rate
        prev_threshold = threshold
    return tax  # unreachable (last bracket is inf)


def ltcg_tax(ltcg_amount: float, ordinary_taxable: float, filing: str = "mfj") -> float:
    """LTCG tax with the 0% / 15% / 20% bracket structure.

    Critical detail: LTCG stacks ON TOP of ordinary taxable income for
    bracket purposes. So if ordinary_taxable = $50k and LTCG = $40k,
    the $40k gets taxed where it falls in the bracket — first $46.7k
    of LTCG room ($96.7k - $50k) at 0%, then any overflow at 15%.

    For low-income early retirees, this is a HUGE benefit: pension at
    $40k + $50k LTCG draw = $90k AGI, all under $96.7k threshold = 0%
    LTCG tax. Old flat-15% model was overstating their tax by $7,500/yr."""
    if ltcg_amount <= 0:
        return 0.0
    _, ltcg_brackets, _, _, _ = filing_constants(filing)
    tax = 0.0
    remaining = ltcg_amount
    current_income = max(0.0, ordinary_taxable)
    for threshold, rate in ltcg_brackets:
        if current_income >= threshold:
            continue
        room_in_bracket = threshold - current_income
        applicable = min(remaining, room_in_bracket)
        tax += applicable * rate
        remaining -= applicable
        current_income += applicable
        if remaining <= 0:
            break
    return tax


def ss_taxable(ss_benefits: float, other_income: float, filing: str = "mfj") -> float:
    """Compute the taxable portion of SS benefits using IRS Pub 915
    rules. Combined income drives the tier:
      < base1:      SS is 0% taxable (free!)
      base1-base2:  up to 50% of excess over base1 counts as taxable SS
      > base2:      85% rule kicks in for additional excess
    Caps at 85% of total benefits regardless. base1/base2 differ for
    MFJ vs single filing status.

    `other_income` should be AGI components excluding SS itself —
    typically pension + tax-deferred draws + LTCG (full taxable draw,
    treating it conservatively as gain).
    """
    if ss_benefits <= 0:
        return 0.0
    _, _, _, base1, base2 = filing_constants(filing)
    half_ss = ss_benefits / 2
    combined = other_income + half_ss
    excess1 = max(0.0, combined - base1)
    if excess1 == 0:
        return 0.0  # SS is tax-free
    bracket_50_amt = min(excess1, base2 - base1)
    excess2 = max(0.0, combined - base2)
    portion_50 = min(half_ss, 0.5 * bracket_50_amt)
    portion_85 = 0.85 * excess2
    return min(portion_50 + portion_85, 0.85 * ss_benefits)


# ─── RMD (Required Minimum Distribution) constants ─────────────────
# IRS Uniform Lifetime Table for Required Minimum Distributions
# (2023 SECURE Act 2.0). Divisor at each age:
#   required_rmd = previous-year-end tax-deferred balance / divisor.
# Roth IRAs are RMD-exempt; Roth 401(k) became exempt in 2024. HSAs
# exempt. 457(b) and 403(b) are subject to RMD same as Trad 401(k)/IRA.
RMD_DIVISORS = {
    73: 27.4, 74: 26.5, 75: 25.5, 76: 24.6, 77: 23.7, 78: 22.9, 79: 22.0,
    80: 21.1, 81: 20.2, 82: 19.4, 83: 18.5, 84: 17.7, 85: 16.8,
    86: 16.0, 87: 15.2, 88: 14.4, 89: 13.7, 90: 12.9, 91: 12.2,
    92: 11.5, 93: 10.8, 94: 10.1, 95: 9.5, 96: 8.9, 97: 8.4,
    98: 7.8, 99: 7.3, 100: 6.8, 101: 6.4, 102: 6.0, 103: 5.6,
    104: 5.2, 105: 4.9, 106: 4.6, 107: 4.3, 108: 4.0, 109: 3.7,
    110: 3.5, 111: 3.4, 112: 3.3, 113: 3.1, 114: 3.0, 115: 2.9,
}


def rmd_divisor(age: int) -> float:
    """Returns the IRS Uniform Lifetime Table divisor for the given age.
    Returns 0 (= no RMD required) for ages below 73; uses oldest-table
    value for ages above 115."""
    if age < 73:
        return 0.0
    return RMD_DIVISORS.get(age, RMD_DIVISORS[115])


# ─── HSA Contribution Limits ───────────────────────────────────────
# IRS Rev. Proc. annual inflation adjustments. Self-only and family
# limits + a $1,000 catch-up for the account holder at age 55+. The
# catch-up is per-spouse — if both have HSAs and both are 55+ they
# each get their own $1k.
HSA_LIMITS = {
    2024: {"self": 4150, "family": 8300, "catch_up_55_plus": 1000},
    2025: {"self": 4300, "family": 8550, "catch_up_55_plus": 1000},
    2026: {"self": 4400, "family": 8750, "catch_up_55_plus": 1000},
}


# ─── State Income Tax Presets ──────────────────────────────────────
# Effective rate the simulator should use for ordinary income, with
# notes on quirks the flat-rate model can't capture (pension/SS
# exemptions, LTCG conformance). Effective rates account for typical
# retiree-relevant exemptions — they're NOT the headline statutory
# bracket rate. Sourced from state tax codes circa 2025; revisit when
# any state changes its retirement-income treatment.
STATE_TAX_PRESETS = {
    "MI": {
        "name": "Michigan",
        "headline_rate": 0.0425,
        "effective_rate": 0.025,
        "ltcg_conforms_to_ordinary": True,
        "ss_exempt": True,
        "public_pension_exempt": True,  # MI ORS partially/fully exempt by tier
        "notes": "MI doesn't tax SS; partial public-pension exemption (MI ORS pensions qualify). Effective rate ~2.5% blends headline 4.25% with these exemptions.",
    },
    "CA": {
        "name": "California",
        "headline_rate": 0.093,
        "effective_rate": 0.06,
        "ltcg_conforms_to_ordinary": True,
        "ss_exempt": True,
        "public_pension_exempt": False,
        "notes": "CA exempts SS but taxes pensions and LTCG as ordinary. Brackets are progressive; 6% reflects mid-bracket retiree.",
    },
    "NY": {
        "name": "New York",
        "headline_rate": 0.065,
        "effective_rate": 0.045,
        "ltcg_conforms_to_ordinary": True,
        "ss_exempt": True,
        "public_pension_exempt": True,  # up to $20k/yr
        "notes": "NY exempts SS and first $20k/yr of pension/IRA distributions. Effective ~4.5% after exemptions.",
    },
    "TX": {
        "name": "Texas",
        "headline_rate": 0.0,
        "effective_rate": 0.0,
        "ltcg_conforms_to_ordinary": False,
        "ss_exempt": True,
        "public_pension_exempt": True,
        "notes": "No state income tax. (Higher property/sales taxes not modeled here.)",
    },
    "FL": {
        "name": "Florida",
        "headline_rate": 0.0,
        "effective_rate": 0.0,
        "ltcg_conforms_to_ordinary": False,
        "ss_exempt": True,
        "public_pension_exempt": True,
        "notes": "No state income tax.",
    },
    "WA": {
        "name": "Washington",
        "headline_rate": 0.0,
        "effective_rate": 0.0,
        "ltcg_conforms_to_ordinary": False,
        "ss_exempt": True,
        "public_pension_exempt": True,
        "notes": "No state income tax on wages. Note: 7% capital gains tax on gains over $250k/yr (not modeled here).",
    },
    "IL": {
        "name": "Illinois",
        "headline_rate": 0.0495,
        "effective_rate": 0.0,
        "ltcg_conforms_to_ordinary": True,
        "ss_exempt": True,
        "public_pension_exempt": True,
        "notes": "IL exempts ALL retirement income (SS, pension, 401k, IRA). For a retired household, effective rate is ~0%.",
    },
    "OH": {
        "name": "Ohio",
        "headline_rate": 0.035,
        "effective_rate": 0.025,
        "ltcg_conforms_to_ordinary": True,
        "ss_exempt": True,
        "public_pension_exempt": False,  # has retirement income credit, not full exempt
        "notes": "OH exempts SS; small retirement income credit on pensions/IRAs. Effective ~2.5%.",
    },
}


def state_tax_preset(code: str) -> dict | None:
    """Look up a state preset by 2-letter code. Returns None if unknown."""
    return STATE_TAX_PRESETS.get(code.upper()) if code else None


# ─── IRMAA Medicare Surcharges ─────────────────────────────────────
# Income-Related Monthly Adjustment Amount: surcharges added to
# Medicare Part B and Part D premiums when MAGI exceeds tier
# thresholds. 2025 figures from CMS. Applies starting at age 65 with
# a 2-year lookback (2025 surcharge based on 2023 MAGI), but for
# planning purposes we use current-year MAGI.
#
# Tier structure: (MFJ MAGI threshold, Single MAGI threshold,
#                  monthly Part B surcharge per person,
#                  monthly Part D surcharge per person)
# Surcharges are PER PERSON ON MEDICARE — household with both spouses
# on Medicare pays ~2x the per-person rate.
IRMAA_TIERS_2025 = [
    # (mfj_magi_min, single_magi_min, part_b_monthly, part_d_monthly)
    (0,       0,       0.00,    0.00),    # Standard premium, no surcharge
    (206_000, 103_000, 74.00,   13.70),   # Tier 1
    (258_000, 129_000, 185.00,  35.30),   # Tier 2
    (322_000, 161_000, 295.90,  57.00),   # Tier 3
    (386_000, 193_000, 406.90,  78.60),   # Tier 4
    (750_000, 500_000, 443.90,  85.80),   # Tier 5 (top)
]


def niit_tax(net_investment_income: float, magi: float, filing: str = "mfj") -> float:
    """Net Investment Income Tax (Section 1411): 3.8% surtax on the
    LESSER of net investment income or MAGI excess over the threshold.

    Thresholds: $250k MFJ, $200k Single. Investment income = LTCG +
    qualified dividends + interest + rental/royalty + non-qualified
    annuity income (NOT W-2 wages, NOT IRA distributions, NOT SS).

    Bites in years with big LTCG, business income, or large taxable
    bucket draws on top of regular retirement income.
    """
    if net_investment_income <= 0:
        return 0.0
    threshold = 250_000 if filing == "mfj" else 200_000
    excess_magi = max(0.0, magi - threshold)
    base = min(net_investment_income, excess_magi)
    return base * 0.038


def irmaa_surcharge_annual(magi: float, filing: str = "mfj", num_on_medicare: int = 2) -> dict:
    """Annual IRMAA surcharge $ for the household.

    Args:
        magi: Modified AGI for the year.
        filing: 'mfj' or 'single'.
        num_on_medicare: 1 or 2. Surcharges are per-person on Medicare.

    Returns dict with tier number, per-person monthly figures, and
    annualized household total.
    """
    # Pick the right column for filing status.
    threshold_col = 0 if filing == "mfj" else 1
    # Find the highest tier whose threshold MAGI exceeds.
    tier_idx = 0
    for i, row in enumerate(IRMAA_TIERS_2025):
        if magi >= row[threshold_col]:
            tier_idx = i
        else:
            break
    tier = IRMAA_TIERS_2025[tier_idx]
    monthly_per_person = tier[2] + tier[3]  # Part B + Part D
    annual_household = monthly_per_person * 12 * num_on_medicare
    return {
        "tier": tier_idx,
        "magi": round(magi, 2),
        "monthly_per_person": round(monthly_per_person, 2),
        "monthly_part_b_per_person": tier[2],
        "monthly_part_d_per_person": tier[3],
        "num_on_medicare": num_on_medicare,
        "annual_household": round(annual_household, 2),
    }


def hsa_limit(year: int, coverage: str = "family", age: int = 0) -> int:
    """Annual HSA contribution limit for the given year + coverage type.

    - `coverage` = "self" or "family". Defaults to family which is the
      common case for a household.
    - `age` enables the $1,000 catch-up at age 55+ for the account
      holder (NOT spouse — catch-up is per-HSA, per-holder).
    - When `year` is outside the known range, falls back to the most
      recent year we have on file (limits creep ~2-3% per year).
    """
    year_limits = HSA_LIMITS.get(year, HSA_LIMITS[max(HSA_LIMITS.keys())])
    base = year_limits.get(coverage, year_limits["self"])
    if age >= 55:
        base += year_limits["catch_up_55_plus"]
    return base
