/**
 * Shared constants, helpers, and style objects used by multiple
 * components in the retirement/ directory.
 */

export const STORAGE_KEY = 'retirement-projection-form'

export const DEFAULTS = {
  current_age: 35,
  spouse_age: '',                  // optional; enables 'spouse' as a holder option
  // Spouse's retirement age (in HER years). When set, contributions
  // continue until WHICHEVER spouse retires later. For Michigan
  // teacher pension: 55 is a common pension-eligibility age. Leave
  // blank to use the user's retirement age as the household exit point.
  spouse_retirement_age: '',
  retirement_age: 65,
  return_rate: 0.06,
  // Conservative real return during the WITHDRAWAL phase. Models the
  // standard de-risking into bonds/CDs once both spouses are retired.
  // 1.5% real ≈ today's 5-yr CD ladder net of inflation and tax.
  retirement_return_rate: 0.015,
  desired_annual_income: 80000,
  // 'gross' (default, today's behavior) or 'net'. When 'net', the
  // backend iterates desired_income upward until average withdrawal-
  // phase after-tax income hits the target. Lets the user enter the
  // number that matters to them ("I want $80k in my pocket") rather
  // than the gross they need to draw to get there.
  interpret_target_as: 'gross',
  withdrawal_rate: 0.04,
  // annual_contribution intentionally omitted — backend auto-detects when
  // the field is left blank/null.
  annual_contribution: '',
  // HSA contribution per year. Lands in the HSA bucket directly (NOT
  // in tax_deferred). Should be entered SEPARATELY from
  // annual_contribution to avoid double-counting. 2025 IRS family
  // limit is $8,550; self is $4,300; +$1,000 catch-up at 55+.
  hsa_annual_contribution: 0,
  // IRMAA Medicare surcharges. Default ON since they're a real cost
  // for any household with MAGI >$206k MFJ in retirement.
  apply_irmaa: true,
  // TCJA sunset modeling. Default OFF (assume Congress extends).
  // Toggle ON to model the full risk: brackets revert to pre-2018
  // schedule starting in tcja_sunset_year (default 2026).
  tcja_sunset_enabled: false,
  tcja_sunset_year: 2026,
  // Section 199A QBI deduction. Annual qualified business income
  // (Schedule C, S-corp, partnership) — 20% deducted before brackets.
  // Set when business income flows into retirement years.
  qbi_business_income: 0,
  // Tax-loss harvesting on the taxable bucket. Annual realized loss
  // expected to be harvested. Capped at $3k ordinary-income offset
  // per IRS rules.
  tlh_annual: 0,
  // Qualified Charitable Distribution. Annual amount sent direct from
  // IRA to charity once age 70½+. Capped at $108k by IRC §408(d)(8)
  // (2025 limit, inflation-indexed). Counts toward RMD; gross excluded
  // from taxable income. Default 0 = no QCD planned.
  qcd_annual: 0,
  // Pension / fixed income (V1: single source). pension_annual is now
  // DERIVED from salary basis × percent — pension formulas are typically
  // quoted as "X% of final compensation" rather than a flat dollar
  // amount. The derived value is computed in the component and sent to
  // the backend as pension_annual; salary/pct are persisted for display
  // continuity. 0% (or 0 salary) = no pension, hides the pension stat
  // tiles and bridge-years caption.
  pension_salary_basis: 0,
  pension_pct: 60,                  // 60% is a common multiplier (e.g. 30 yrs × 2%/yr)
  pension_holder: 'you',           // 'you' | 'spouse' — picks which age controls timing
  pension_holder_age: '',           // legacy / advanced override; auto-derived from holder pick
  pension_start_age: '',
  pension_cola: 0,
  // Social Security: 2nd fixed-income source. Defaults to 0 (modeled
  // off when annual = 0), claim age 67 = full retirement age for those
  // born 1960+, COLA 2.5% (CPI-W historical).
  ss_annual: 0,
  ss_holder: 'you',                // 'you' | 'spouse'
  ss_holder_age: '',                // legacy / advanced override
  ss_start_age: 67,
  ss_cola: 0.025,
  // Social Security #2 — second household stream (typically the
  // spouse's). 0 = not modeled; the UI hides the row entirely until
  // the user clicks "+ Add spouse SS". Defaults mirror SS#1; holder
  // defaults to 'spouse' since by definition you'd be modeling the
  // OTHER person here.
  ss2_annual: 0,
  ss2_holder: 'spouse',
  ss2_holder_age: '',
  ss2_start_age: 67,
  ss2_cola: 0.025,
  // SS stress test — flat haircut % applied to BOTH streams.
  // 0 = full benefits, 0.23 = SSA Trustees' Trust Fund depletion
  // scenario (~77% payable), 1.0 = SS gone entirely.
  ss_reduction_pct: 0,
  // Tax rates for after-tax projection
  tax_rate_ordinary: 0.22,
  tax_rate_capital_gains: 0.15,
  // Inflation assumption — used to convert nominal COLAs (the rate on
  // the user's actual pension/SS check) into REAL growth so the
  // projection is self-consistent (return_rate is real). 2.5% is the
  // long-run US average. Higher = less real growth from COLAs (faster
  // erosion of fixed-COLA pensions); lower = more.
  inflation_rate: 0.025,
  // Pre-Medicare healthcare cost — added to spending in years where
  // either spouse is < 65. Default 0 so existing scenarios don't
  // change unless user opts in. $20-25k is typical for a couple in
  // MI without ACA subsidies.
  healthcare_pre_medicare: 0,
  // Tapered contribution after the FIRST spouse retires. Empty =
  // no taper (use the full annual_contribution throughout).
  contribution_after_first_retirement: '',
  // Spending phases. Multipliers default to 100% = no variation
  // (preserves prior behavior). User can dial slow_go down to ~85
  // and no_go around 100 to model the standard go-go/slow-go/no-go
  // pattern.
  slow_go_start_age: 75,
  no_go_start_age: 85,
  slow_go_multiplier: 1.0,
  no_go_multiplier: 1.0,
  // Stress tests + advanced inputs (all default to off / neutral)
  survivor_at_user_age: '',     // blank = no event
  pension_survivor_pct: 0.5,    // J&S 50% common default
  survivor_spending_multiplier: 0.7, // Single retiree spends ~70% of couple
  state_tax_rate: 0,            // 0.0425 for MI, 0.0 for TX/FL/WA
  ltc_annual_cost: 0,           // 0 = LTC not modeled
  ltc_start_age: 80,
  ltc_duration_years: 3,
  taxable_basis_pct: 0.5,       // 50% of taxable bucket is basis (no gain)
  // Real wage growth + healthcare-specific inflation (real terms,
  // above general inflation). Defaults reflect industry norms after
  // advisor review — salaries grow ~1%/yr real via promotions/raises;
  // medical CPI runs ~1.5% above general inflation long-run.
  wage_growth_rate: 0.01,
  healthcare_growth_rate: 0.015,
  // Roth conversion ladder. Annual $ amount to convert from
  // tax-deferred → Roth during the conversion window (typically the
  // bridge years between first retirement and first SS claim, when
  // ordinary income is low). 0 = strategy off.
  roth_conversion_amount: 0,
  roth_conversion_start_age: 0,
  roth_conversion_end_age: 0,
  // Fill-to-bracket strategy. Empty = use flat amount above.
  // 0.12, 0.22, 0.24 etc. = convert to top of that bracket each year.
  roth_conversion_target_bracket: '',
  // Max sustainable spending — bisects on desired_income for the
  // highest spend that drains the portfolio to ~$0 at target age.
  // Always-on by default; toggle off on slow machines (each
  // projection runs 10-15 extra sims when enabled).
  compute_max_sustainable: true,
  max_sustainable_target_age: 105,
  // One-time / lumpy events: array of {age, amount, label}.
  one_time_expenses: [],
  // Step events: permanent or duration-bound shifts to contribution
  // or spending starting at a given age. Array of
  // {age, kind, delta, duration_years, label}. kind = 'contribution' |
  // 'spending'. duration_years = 0 for permanent. Models mortgage
  // payoff (contribution +$X/yr forever), kid college (spending +$X/yr
  // for 4 years), kid leaves home (spending -$X/yr forever), etc.
  step_events: [],
  // Monte Carlo + sequence stress
  monte_carlo_runs: 0,          // 0 = off, 500 / 1000 typical
  return_volatility_working: 0.15,
  return_volatility_retired: 0.05,
  sequence_stress_preset: 'none',
}

// State-tax presets mirror backend services/tax.STATE_TAX_PRESETS.
// Effective rates blend headline brackets with retiree-relevant
// exemptions (SS exempt, public-pension treatment) — they are NOT the
// statutory rate. Surface as a dropdown next to the state-tax field
// so picking a state auto-fills the rate and shows the caveats.
export const STATE_TAX_PRESETS = [
  { code: '', name: '— select —', rate: null, note: '' },
  { code: 'MI', name: 'Michigan', rate: 0.025,
    note: 'Headline 4.25%. Exempts SS; partial public-pension exemption (MI ORS pensions qualify). Effective ~2.5%.' },
  { code: 'CA', name: 'California', rate: 0.06,
    note: 'Progressive to 9.3%+. Exempts SS but taxes pensions/LTCG as ordinary. ~6% mid-bracket retiree.' },
  { code: 'NY', name: 'New York', rate: 0.045,
    note: 'Exempts SS and first $20k/yr of pension/IRA distributions. Effective ~4.5%.' },
  { code: 'OH', name: 'Ohio', rate: 0.025,
    note: 'Exempts SS; small retirement income credit. Effective ~2.5%.' },
  { code: 'IL', name: 'Illinois', rate: 0.0,
    note: 'Exempts ALL retirement income (SS, pension, 401k, IRA). Effective 0% in retirement.' },
  { code: 'TX', name: 'Texas', rate: 0.0, note: 'No state income tax.' },
  { code: 'FL', name: 'Florida', rate: 0.0, note: 'No state income tax.' },
  { code: 'WA', name: 'Washington', rate: 0.0,
    note: 'No state income tax on wages. Note: 7% LTCG tax over $250k/yr (not modeled).' },
]

export function loadForm() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw)
    // Migration: older versions stored a flat pension_annual. If the
    // user has that but no salary/pct, back-fill so their dollar amount
    // is preserved (salary = annual, pct = 100). They can re-enter the
    // numbers however they like; this just keeps the displayed pension
    // amount stable across the upgrade.
    if (
      parsed.pension_annual > 0 &&
      (parsed.pension_salary_basis === undefined ||
        parsed.pension_salary_basis === 0)
    ) {
      parsed.pension_salary_basis = parsed.pension_annual
      parsed.pension_pct = 100
    }
    delete parsed.pension_annual  // no longer a stored field — derived now

    // Migration: spouse_age + holder dropdown. If the user previously set
    // pension_holder_age or ss_holder_age to a value different from
    // current_age, infer that they were modeling a spouse — back-fill
    // spouse_age from whichever holder_age was set, and switch the
    // dropdown to 'spouse'. Don't blow away an existing spouse_age.
    if (parsed.spouse_age === undefined || parsed.spouse_age === '') {
      const ph = Number(parsed.pension_holder_age)
      const sh = Number(parsed.ss_holder_age)
      const cur = Number(parsed.current_age)
      if (Number.isFinite(ph) && ph > 0 && ph !== cur) {
        parsed.spouse_age = ph
        if (!parsed.pension_holder) parsed.pension_holder = 'spouse'
      } else if (Number.isFinite(sh) && sh > 0 && sh !== cur) {
        parsed.spouse_age = sh
        if (!parsed.ss_holder) parsed.ss_holder = 'spouse'
      }
    }

    return { ...DEFAULTS, ...parsed }
  } catch {
    return DEFAULTS
  }
}

// 0-decimal formatter for projection tiles — whole dollars are easier to read at decade scale
export function fmtRounded(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0)
}

/**
 * Transform chart rows from REAL (today's-dollars) to NOMINAL
 * (future-dollars at each row's year). Multiplies each cash-flow
 * field by (1+inflation)^year. Used for the second chart that shows
 * "what will the statements actually say in 30 years" alongside
 * the planning-friendly real view.
 */
export function toNominal(rows, inflation) {
  return rows.map(r => {
    const factor = Math.pow(1 + (inflation || 0), r.year || 0)
    return {
      ...r,
      balance: (r.balance || 0) * factor,
      income_streams: (r.income_streams || 0) * factor,
      portfolio_draw: (r.portfolio_draw || 0) * factor,
      draw_taxable: (r.draw_taxable || 0) * factor,
      draw_tax_deferred: (r.draw_tax_deferred || 0) * factor,
      draw_roth: (r.draw_roth || 0) * factor,
      after_tax_income: (r.after_tax_income || 0) * factor,
      effective_spending: (r.effective_spending || 0) * factor,
      healthcare_cost: (r.healthcare_cost || 0) * factor,
      rmd_required: (r.rmd_required || 0) * factor,
      income_shortfall: (r.income_shortfall || 0) * factor,
    }
  })
}

export const INPUT_STYLE = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 13,
  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
  borderRadius: 6,
  background: 'var(--bg-input, rgba(255,255,255,0.04))',
  color: 'inherit',
  height: 36,
  boxSizing: 'border-box',
}
