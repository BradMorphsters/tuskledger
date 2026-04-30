import { useState, useEffect, useRef } from 'react'
import {
  ResponsiveContainer, ComposedChart, Area, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, ReferenceArea, Legend,
} from 'recharts'
import { Target, TrendingUp, AlertCircle, CheckCircle, Loader2, Printer } from 'lucide-react'
import { getRetirementProjection, getLoans } from '../api/client'
import { ScenariosToolbar } from './RetirementScenarios'

/**
 * Multi-decade compound-growth retirement projection.
 *
 * Lives on the NetWorth page below the existing short-horizon projection
 * toggle. The two are deliberately distinct:
 *   - That one is linear extrapolation over months. Useful for "where do
 *     I land at year-end."
 *   - This one is compound growth on investable assets only over decades.
 *     Useful for "am I on track to retire."
 *
 * Form state persists to localStorage so the user doesn't have to re-enter
 * every visit. Defaults are sensible (age 35, retirement 65, 6% real
 * return, 4% withdrawal, $80k income), but the auto-detected current
 * balance + auto-detected contribution come from the backend on every
 * request — so balance changes show up without any UI fiddling.
 */
const STORAGE_KEY = 'retirement-projection-form'

const DEFAULTS = {
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
const STATE_TAX_PRESETS = [
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

function loadForm() {
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

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0)
}

/**
 * Transform chart rows from REAL (today's-dollars) to NOMINAL
 * (future-dollars at each row's year). Multiplies each cash-flow
 * field by (1+inflation)^year. Used for the second chart that shows
 * "what will the statements actually say in 30 years" alongside
 * the planning-friendly real view.
 */
function toNominal(rows, inflation) {
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

export default function RetirementProjection() {
  const [form, setForm] = useState(loadForm)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Derived pension annual: salary basis × percent. The backend doesn't
  // know about salary/pct — they're a UX convenience. We compute the
  // dollar amount here and pass it as pension_annual.
  const derivedPensionAnnual = Math.round(
    (Number(form.pension_salary_basis) || 0) * (Number(form.pension_pct) || 0) / 100
  )

  // Resolve holder ages from the dropdown selectors. 'you' → current_age;
  // 'spouse' → spouse_age (when set; falls back to current_age if blank).
  // Backend only knows about pension_holder_age / ss_holder_age numbers
  // — the dropdown is purely a UX abstraction over those.
  const resolveHolderAge = (whose) => {
    if (whose === 'spouse' && form.spouse_age !== '' && form.spouse_age !== undefined) {
      return Number(form.spouse_age)
    }
    return Number(form.current_age)
  }
  const resolvedPensionHolderAge = resolveHolderAge(form.pension_holder)
  const resolvedSSHolderAge = resolveHolderAge(form.ss_holder)
  const resolvedSS2HolderAge = resolveHolderAge(form.ss2_holder)

  // Build the request payload: drop the helper fields and add the
  // derived pension_annual the backend expects.
  const apiPayload = {
    ...form,
    pension_annual: derivedPensionAnnual,
    pension_holder_age: resolvedPensionHolderAge,
    ss_holder_age: resolvedSSHolderAge,
    ss2_holder_age: resolvedSS2HolderAge,
    tax_rate_ordinary: form.tax_rate_ordinary,
    tax_rate_capital_gains: form.tax_rate_capital_gains,
  }
  delete apiPayload.pension_salary_basis
  delete apiPayload.pension_pct
  delete apiPayload.pension_holder
  delete apiPayload.ss_holder
  delete apiPayload.ss2_holder
  // spouse_age and spouse_retirement_age are sent through to the backend
  // (used by the two-phase simulation for accumulation_years math). When
  // either is blank the form serializes them as '', which client.js drops
  // from the query string — backend treats missing as None.
  // One-time expenses get JSON-stringified into a single query param.
  apiPayload.one_time_expenses_json = JSON.stringify(form.one_time_expenses || [])
  delete apiPayload.one_time_expenses
  // Step events same treatment.
  apiPayload.step_events_json = JSON.stringify(form.step_events || [])
  delete apiPayload.step_events

  // Persistence runs SYNCHRONOUSLY on every form change — never inside
  // the debounce. localStorage writes are cheap and synchronous, so
  // there's no benefit to delaying them, and putting them inside the
  // 300ms debounce meant a reload-within-300ms would lose the change.
  // The user reported exactly this: edited age, refreshed, value gone.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(form)) } catch {}
  }, [form])

  // Re-fetch on form change. Debounced separately so dragging a number
  // input doesn't fire a request per keystroke. The save effect above
  // has already persisted by this point regardless of whether the
  // setTimeout below ever fires.
  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true)
      setError(null)
      getRetirementProjection(apiPayload)
        .then(setData)
        .catch(e => setError(e.message || 'Projection failed'))
        .finally(() => setLoading(false))
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  const update = (key) => (e) => {
    const v = e.target.value
    setForm(prev => ({ ...prev, [key]: v === '' ? '' : Number(v) }))
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Target size={16} style={{ color: 'var(--accent-blue)' }} />
          Retirement Projection
        </span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            compound growth · investable assets only
          </span>
          {/* Print button — triggers browser print dialog. The @media print
              CSS in index.css strips nav/sidebar/FAB and reformats the
              card for clean PDF output via "Save as PDF" in the dialog. */}
          <button
            onClick={() => window.print()}
            title="Print or save as PDF (browser dialog)"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', fontSize: 11,
              background: 'transparent', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            <Printer size={11} /> Print plan
          </button>
        </div>
      </div>

      {/* Save / load / compare named scenarios. Persists to localStorage
          so users can A/B test "what if I retire at 58" without losing
          the baseline. Shows a comparison table of saved scenarios with
          key metrics (FI age, end balance, success %) for quick judging. */}
      <ScenariosToolbar
        currentForm={form}
        onLoad={(savedForm) => setForm(savedForm)}
        currentMetrics={data ? {
          fi_age: data.fi_hit_age,
          end_balance: data.end_balance,
          success_pct: data.monte_carlo
            ? Math.round(data.monte_carlo.success_probability * 100)
            : (data.on_track ? 100 : null),
        } : null}
      />

      {/* ─────────── BASICS ─────────── */}
      <Section title="Basics" subtitle="Ages, return assumptions, what you want to spend in retirement.">
        <FieldGrid>
          <Field
            label="Your age"
            help="Your age TODAY (in whole years). Drives every calendar-time calculation in the simulation: years until retirement, when SS / pension claim ages convert to calendar years, when the simulation transitions from accumulation to withdrawal phase, and when RMDs kick in at 73. Update this each year on your birthday for accurate forward projections."
          >
            <input type="number" min={18} max={100} step={1}
                   value={form.current_age} onChange={update('current_age')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Spouse age"
            help="Optional. Enables 'spouse' as a holder option for pension and SS so the math respects the calendar timing for each person."
          >
            <input type="number" min={18} max={100} step={1}
                   value={form.spouse_age}
                   placeholder="—"
                   onChange={update('spouse_age')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Retirement age"
            help="The age YOU plan to stop earning W-2 income. The simulation switches you from contribution mode to withdrawal mode at this age (or — if a spouse is set with a later retirement age — at whichever spouse retires LAST, with a tapered contribution between the two). Common targets: 55 (MI teacher pension eligibility), 59½ (penalty-free 401k withdrawals), 62 (earliest SS), 65 (Medicare), 67 (SS Full Retirement Age for those born 1960+)."
          >
            <input type="number" min={form.current_age + 1} max={100} step={1}
                   value={form.retirement_age} onChange={update('retirement_age')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Spouse retire age"
            help="Spouse's planned retirement age (in HER years). When set, contributions continue until whichever spouse retires LATER. Set to her pension-eligibility age (e.g. 55 for MI teachers) so the simulation treats the portfolio honestly. Leave blank if she doesn't have a separate retirement timeline."
          >
            <input type="number" min={18} max={100} step={1}
                   value={form.spouse_retirement_age}
                   placeholder={form.spouse_age === '' ? '—' : ''}
                   disabled={form.spouse_age === '' || form.spouse_age === undefined}
                   onChange={update('spouse_retirement_age')}
                   style={{
                     ...INPUT_STYLE,
                     opacity: form.spouse_age === '' || form.spouse_age === undefined ? 0.5 : 1,
                   }} />
          </Field>
          <Field
            label="Return % (working)"
            help="Expected REAL (after-inflation) annual portfolio return WHILE STILL WORKING. Reflects an aggressive growth-oriented allocation (stocks-heavy 401k/IRA). Historical US stock real return ≈ 6-7%; conservative estimates use 4-5%."
          >
            <input type="number" min={0} max={20} step={0.1}
                   value={Math.round(form.return_rate * 1000) / 10}
                   onChange={e => setForm(p => ({ ...p, return_rate: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Return % (retired)"
            help="Real return AFTER both spouses retire. Models the standard de-risking into bonds/CDs/treasuries — capital preservation, just enough to beat inflation. Default 1.5% real ≈ today's 5-yr CD ladder net of inflation. Set to 0% to model 'pure CDs that just match inflation' (zero real growth) or higher (e.g. 2-3%) for a still-balanced 60/40 retiree allocation."
          >
            <input type="number" min={0} max={10} step={0.1}
                   value={Math.round(form.retirement_return_rate * 1000) / 10}
                   onChange={e => setForm(p => ({ ...p, retirement_return_rate: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Withdrawal %"
            help="The Safe Withdrawal Rate — % of your nest egg you can pull each year without running out over a 30-year retirement. The standard '4% rule' from the Trinity Study is the default; some retirees use 3.5% to be conservative or 5% to retire earlier. Driving math: FI number = retirement income ÷ withdrawal rate."
          >
            <input type="number" min={0.5} max={10} step={0.1}
                   value={Math.round(form.withdrawal_rate * 1000) / 10}
                   onChange={e => setForm(p => ({ ...p, withdrawal_rate: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label={form.interpret_target_as === 'net' ? 'Retirement income (net)' : 'Retirement income (gross)'}
            help="Annual spending target in today's dollars. The Gross/Net toggle below changes interpretation: GROSS = pre-tax draw the simulator pulls from pension/SS/portfolio, with taxes netted out and reported as 'After-tax actual' (the off-the-shelf calculator default). NET = after-tax cash in your pocket; the simulator iterates upward and grosses-up the draw to hit your target net (CFP best-practice for personal planning, since you live on net). Drives the FI number = this ÷ withdrawal rate (e.g. $80k ÷ 4% = $2M nest egg target). For most households the Net mode adjusts the gross draw by 5-15% depending on bracket and SS taxation."
          >
            <input type="number" min={0} step={1000}
                   value={form.desired_annual_income} onChange={update('desired_annual_income')}
                   style={INPUT_STYLE} />
            {/* Gross/Net interpretation toggle. Sits directly under the
                income input so the user sees them as a unit. */}
            <div style={{
              marginTop: 6, display: 'flex', gap: 4,
              fontSize: 11,
            }}>
              {['gross', 'net'].map(mode => (
                <button key={mode} type="button"
                  onClick={() => setForm(p => ({ ...p, interpret_target_as: mode }))}
                  style={{
                    flex: 1, padding: '4px 6px', borderRadius: 4,
                    cursor: 'pointer',
                    background: form.interpret_target_as === mode
                      ? 'var(--accent-blue-bg)' : 'var(--bg-input)',
                    border: `1px solid ${form.interpret_target_as === mode
                      ? 'var(--accent-blue-border)' : 'var(--border-color, rgba(255,255,255,0.08))'}`,
                    color: form.interpret_target_as === mode
                      ? 'var(--accent-blue)' : 'var(--text-muted)',
                    fontWeight: form.interpret_target_as === mode ? 600 : 400,
                    textTransform: 'uppercase', letterSpacing: 0.4,
                    fontSize: 10,
                  }}
                >
                  {mode === 'gross' ? 'Gross' : 'Net (after tax)'}
                </button>
              ))}
            </div>
            {/* After-tax inline annotation — pulls from sim_after_tax_avg
                in the response so the user can see what they'll actually
                have to spend, without leaving this section of the form.
                Only renders when a sim has run. */}
            {form.interpret_target_as === 'gross' && data?.sim_after_tax_avg > 0 && (
              <div style={{
                marginTop: 4, fontSize: 11, color: 'var(--text-muted)',
                lineHeight: 1.3,
              }}>
                After-tax actual: <strong style={{ color: 'var(--text-secondary)' }}>
                  {fmt(data.sim_after_tax_avg)}
                </strong>/yr avg
                <span style={{ color: 'var(--text-muted)' }}>
                  {' '}({Math.round((1 - data.sim_after_tax_avg / form.desired_annual_income) * 100)}% to tax)
                </span>
              </div>
            )}
            {/* When in NET mode, surface what gross the simulator iterated
                up to so the user can verify the gross-up isn't running
                into pathological bracket cliffs. */}
            {form.interpret_target_as === 'net' && data?.net_target_diagnostics && (
              <div style={{
                marginTop: 4, fontSize: 11, color: 'var(--text-muted)',
                lineHeight: 1.3,
              }}>
                Grossed up to: <strong style={{ color: 'var(--text-secondary)' }}>
                  {fmt(data.net_target_diagnostics.final_gross)}
                </strong>/yr
                <span style={{ color: 'var(--text-muted)' }}>
                  {' '}(achieved {fmt(data.net_target_diagnostics.achieved_avg_net)} avg net,{' '}
                  {data.net_target_diagnostics.iterations} iter)
                </span>
              </div>
            )}
          </Field>
          <Field
            label="Contribution / yr"
            hint={data?.inputs?.contribution_source === 'auto-detected' && form.annual_contribution === ''
              ? `auto: ${fmt(data.inputs.annual_contribution)}`
              : undefined}
            help="What you contribute to investment accounts each year (401k + employer match + brokerage deposits). Auto-detect sums incoming transactions to investment accounts in the last 12 months — but Plaid CAN'T see 401k payroll deferrals (those leave your paycheck before hitting any bank), so the auto value is usually $0 or way too low. Enter your actual annual savings rate for an accurate projection."
          >
            <input type="number" min={0} step={500}
                   value={form.annual_contribution}
                   placeholder={data ? String(data.inputs.annual_contribution) : 'auto'}
                   onChange={update('annual_contribution')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Contrib after 1st retire"
            help="Annual contribution AFTER the first spouse retires (and before the second retires). Useful when one spouse's salary was helping fund savings. Leave blank to keep the same contribution throughout. E.g. if you save $40k/yr from both incomes, you might drop to $20k/yr from your salary alone after spouse stops working."
          >
            <input type="number" min={0} step={500}
                   value={form.contribution_after_first_retirement}
                   placeholder="same"
                   onChange={update('contribution_after_first_retirement')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="HSA contrib / yr"
            help="HSA contribution per year, ENTERED SEPARATELY from the main Contribution field to avoid double-counting. Lands in the HSA bucket each year so it grows tax-free for qualified medical and is available to fund the healthcare bridge in retirement. 2025 IRS limits: $4,300 self / $8,550 family + $1,000 catch-up at 55+. If you previously bundled HSA into your main Contribution number, subtract it now."
          >
            <input type="number" min={0} step={500}
                   value={form.hsa_annual_contribution}
                   onChange={update('hsa_annual_contribution')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Drain to age"
            help="Target age for the max-sustainable-spending calculator. The bisection finds the highest annual spend that drives your total portfolio (all four buckets) to ~$0 at this age. Default 105 covers the longevity tail. Set to 95 if you only want to plan to median life expectancy, 100 for a common compromise, 110 for the long-tail safety margin."
          >
            <input type="number" min={70} max={120} step={1}
                   value={form.max_sustainable_target_age}
                   onChange={update('max_sustainable_target_age')}
                   disabled={!form.compute_max_sustainable}
                   style={{ ...INPUT_STYLE, opacity: form.compute_max_sustainable ? 1 : 0.4 }} />
          </Field>
          <Field
            label="Compute max"
            help="Always-on max-sustainable calculation. Adds 10-15 extra simulation runs per request (~few hundred ms on a fast machine). Toggle off if your machine struggles or you don't need the live max."
          >
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '0 4px', fontSize: 13, height: 36,
            }}>
              <input
                type="checkbox"
                checked={form.compute_max_sustainable}
                onChange={e => setForm(p => ({ ...p, compute_max_sustainable: e.target.checked }))}
              />
              <span>{form.compute_max_sustainable ? 'On' : 'Off'}</span>
            </label>
          </Field>
          {/* Both info cards live BELOW the basic inputs so the form
              stays scannable: all editable fields cluster at the top,
              all derived/informational summaries stack at the bottom. */}
          {/* Max sustainable spending callout — full-width row. */}
          {form.compute_max_sustainable && data?.max_sustainable && (
            <div style={{ gridColumn: '1 / -1' }}>
              <MaxSustainableCallout
                result={data.max_sustainable}
                onApply={(amt) => setForm(p => ({ ...p, desired_annual_income: amt }))}
              />
            </div>
          )}
          {/* Contribution sanity check — info-card design matching the
              max-sustainable callout. Addresses advisor review item #1
              ("contribution may be under-stated"). Two W-2 spouses can
              save ~$68k/yr at IRS limits — a $20k input ringing in at
              29% is a useful nudge to verify the user has accounted for
              all available vehicles. */}
          {(() => {
            const isDualIncome = form.spouse_age !== '' && form.spouse_age !== undefined
            const limit401k = 23500
            const limitIRA = 7000
            const limitHSA = 8550
            const theoreticalMax = (isDualIncome ? 2 : 1) * (limit401k + limitIRA) + limitHSA
            const current = Number(form.annual_contribution || data?.inputs?.annual_contribution || 0)
            if (current <= 0) return null
            const pct = (current / theoreticalMax) * 100
            const pctRounded = Math.round(pct)
            // Tiers green / yellow / orange — orange (not red) for "low".
            let accentVar, accentBgVar, accentBorderVar, label
            if (pct >= 70) {
              accentVar = 'var(--accent-green)'
              accentBgVar = 'var(--accent-green-bg)'
              accentBorderVar = 'var(--accent-green-border)'
              label = 'Healthy'
            } else if (pct >= 40) {
              accentVar = 'var(--accent-yellow)'
              accentBgVar = 'var(--accent-yellow-bg)'
              accentBorderVar = 'var(--accent-yellow-border)'
              label = 'Modest'
            } else {
              accentVar = 'var(--accent-orange)'
              accentBgVar = 'var(--accent-orange-bg)'
              accentBorderVar = 'var(--accent-orange-border)'
              label = 'Low'
            }
            const fillPct = Math.min(100, pct)

            return (
              <div style={{
                gridColumn: '1 / -1',
                padding: '12px 14px',
                background: accentBgVar,
                border: `1px solid ${accentBorderVar}`,
                borderLeft: `3px solid ${accentVar}`,
                borderRadius: 6,
                fontSize: 12,
                lineHeight: 1.4,
                color: 'var(--text-primary)',
              }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginBottom: 8,
                }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                    textTransform: 'uppercase', color: 'var(--text-muted)',
                  }}>
                    Contribution check
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 7px',
                    borderRadius: 10, background: accentVar,
                    color: 'var(--bg-card)', letterSpacing: 0.3,
                  }}>
                    {label}
                  </span>
                </div>

                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 12,
                  flexWrap: 'wrap', marginBottom: 8,
                }}>
                  <div style={{
                    fontSize: 20, fontWeight: 700, color: 'var(--text-primary)',
                  }}>
                    {pctRounded}%
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
                      {' '}of household max
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {fmt(current)}/yr of {fmt(theoreticalMax)}/yr theoretical
                  </div>
                </div>

                <div style={{
                  position: 'relative', height: 6, borderRadius: 3,
                  background: 'var(--bg-input)', overflow: 'hidden', marginBottom: 8,
                }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${fillPct}%`, background: accentVar,
                    transition: 'width 200ms ease',
                  }} />
                </div>

                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  <span title="2025 IRS limits, under-50, no catch-up">
                    {isDualIncome ? '2×' : '1×'} 401(k) {fmt(limit401k)} +{' '}
                    {isDualIncome ? '2×' : '1×'} IRA {fmt(limitIRA)} +{' '}
                    family HSA {fmt(limitHSA)}
                  </span>
                  {pct < 40 && (
                    <div style={{ marginTop: 6, color: accentVar }}>
                      Possible under-count — verify if you have 403(b) /
                      457 / mega-backdoor access (advisor review item #1).
                    </div>
                  )}
                </div>
              </div>
            )
          })()}
        </FieldGrid>
      </Section>

      {/* ─────────── SPENDING ─────────── */}
      <Section
        title="Spending phases"
        subtitle="Healthcare bridge cost (pre-Medicare) and age-banded spending multipliers. Defaults of 100% mean no phase variation."
      >
        <FieldGrid>
          <Field
            label="Healthcare (pre-65) /yr"
            help="Annual healthcare expense for years where either spouse is < 65 (pre-Medicare). Covers ACA premiums + deductibles. $20k-$25k typical for a couple in MI without subsidies. Added on top of your desired retirement income for those bridge years only. 0 = bake into desired_income."
          >
            <input type="number" min={0} step={1000}
                   value={form.healthcare_pre_medicare}
                   onChange={update('healthcare_pre_medicare')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Slow-go starts"
            help="Age at which spending tapers from go-go (peak travel/hobbies) to slow-go (less active). Industry default 75."
          >
            <input type="number" min={60} max={100} step={1}
                   value={form.slow_go_start_age}
                   onChange={update('slow_go_start_age')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Slow-go %"
            help="Spending multiplier during slow-go years. Research shows ~85% of go-go is typical. 100 = no change from baseline."
          >
            <input type="number" min={10} max={200} step={1}
                   value={Math.round(form.slow_go_multiplier * 100)}
                   onChange={e => setForm(p => ({ ...p, slow_go_multiplier: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="No-go starts"
            help="Age at which spending transitions to no-go phase (often higher healthcare, lower discretionary). Industry default 85."
          >
            <input type="number" min={70} max={110} step={1}
                   value={form.no_go_start_age}
                   onChange={update('no_go_start_age')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="No-go %"
            help="Spending multiplier during no-go years. Healthcare ramps up but discretionary drops. Industry estimates 95-110% of go-go. 100 = no change."
          >
            <input type="number" min={10} max={200} step={1}
                   value={Math.round(form.no_go_multiplier * 100)}
                   onChange={e => setForm(p => ({ ...p, no_go_multiplier: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Wage growth %/yr"
            help="REAL annual contribution growth (above inflation). Industry data: salaries grow ~1-2%/yr in real terms via promotions/raises. 0 = flat (current behavior). Applied to both regular and tapered contribution."
          >
            <input type="number" min={-5} max={10} step={0.1}
                   value={Math.round(form.wage_growth_rate * 1000) / 10}
                   onChange={e => setForm(p => ({ ...p, wage_growth_rate: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Healthcare growth %/yr"
            help="Healthcare cost growth ABOVE general inflation (real terms). Medical CPI runs 1-2% above general. 0 = flat. Affects healthcare bridge cost and LTC."
          >
            <input type="number" min={-5} max={15} step={0.1}
                   value={Math.round(form.healthcare_growth_rate * 1000) / 10}
                   onChange={e => setForm(p => ({ ...p, healthcare_growth_rate: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
        </FieldGrid>
      </Section>

      {/* ─────────── PENSION ─────────── */}
      <Section
        title="Pension"
        subtitle="Defined-benefit income. Leave salary at $0 if no pension."
      >
        <FieldGrid>
          <Field
            label="Salary basis"
            help="The salary the pension formula multiplies against — usually your Final Average Compensation (FAC), not your current salary. Most defined-benefit plans use FAC = average of your highest N consecutive years (MI ORS uses highest 5 years; many private plans use highest 3 or last 5). For a rough estimate enter today's salary; for accuracy, project what your FAC will look like at retirement (modest annual raises × highest-earning years). Annual pension = salary basis × pension %."
          >
            <input type="number" min={0} step={1000}
                   value={form.pension_salary_basis}
                   onChange={update('pension_salary_basis')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="% of salary"
            help="The pension multiplier × years of service at retirement. Each plan has its own formula: MI ORS Tier 1 = 1.5% × YOS; MI ORS DB / Hybrid = 1.0-1.5% × YOS; many federal plans = 1.0-1.1% × YOS. So 30 years of service at 1.5% = 45% of salary basis. Most state/teacher pensions cap at 70-80% of FAC regardless of service years. Enter the projected percentage at YOUR retirement, not today (years of service grows over time)."
          >
            <input type="number" min={0} max={100} step={1}
                   value={form.pension_pct}
                   onChange={update('pension_pct')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Whose?"
            help="Which person this pension belongs to. Determines the calendar timing — e.g. if spouse is 38 and pension starts at her 60, that's 22 years from now regardless of your age."
          >
            <select
              value={form.pension_holder}
              onChange={e => setForm(p => ({ ...p, pension_holder: e.target.value }))}
              style={INPUT_STYLE}
            >
              <option value="you">You ({form.current_age})</option>
              <option value="spouse" disabled={form.spouse_age === '' || form.spouse_age === undefined}>
                Spouse {form.spouse_age !== '' && form.spouse_age !== undefined ? `(${form.spouse_age})` : '— set spouse age first'}
              </option>
            </select>
          </Field>
          <Field
            label={form.pension_holder === 'spouse' ? 'Starts / spouse retires' : 'Starts at age'}
            hint={form.pension_start_age === '' && derivedPensionAnnual > 0 ? `→ ${form.retirement_age}` : undefined}
            help={
              form.pension_holder === 'spouse'
                ? "Age at which the pension begins — typically also when your spouse retires from the employer. If she retires earlier, the pension is usually reduced; later, it may be increased. Enter the planned start age here."
                : "Age at which the pension begins — typically when you retire from the employer."
            }
          >
            <input type="number" min={1} max={120} step={1}
                   value={form.pension_start_age}
                   placeholder={String(form.retirement_age)}
                   onChange={update('pension_start_age')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="COLA % (nominal)"
            help="NOMINAL Cost-of-Living Adjustment — the actual % the pension check increases each year. The projection automatically subtracts inflation to get the REAL growth used in the simulation. Most MI state/teacher pensions have 0% nominal COLA, meaning the check stays flat in dollar terms and erodes by inflation in purchasing power. Federal Social Security (entered separately) typically gets 2-3% nominal COLA."
          >
            <input type="number" min={0} max={10} step={0.1}
                   value={Math.round(form.pension_cola * 1000) / 10}
                   onChange={e => setForm(p => ({ ...p, pension_cola: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
        </FieldGrid>

        {/* Derived pension annual caption — only when pension is active. */}
        {derivedPensionAnnual > 0 && (
          <div style={{
            marginTop: 8,
            fontSize: 12,
            color: 'var(--text-muted)',
          }}>
            Pension annual: <strong style={{ color: 'var(--text-primary)' }}>
              {fmt(derivedPensionAnnual)}
            </strong>
            <span style={{ color: 'var(--text-muted)' }}>
              {' '}({fmt(form.pension_salary_basis)} × {form.pension_pct}%) — in today's dollars
            </span>
          </div>
        )}

        {/* YOS calculator — quietly reminds users that the % field is
            multiplier × years_of_service. Advisor review item #4: most
            people enter a single % and forget it grows with service. */}
        {form.pension_salary_basis > 0 && (
          <div style={{
            marginTop: 6,
            fontSize: 11,
            color: '#64748b',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
          }}>
            <span>Quick formula:</span>
            <input type="number" min={0} max={5} step={0.05}
                   value={form.pension_multiplier ?? 1.5}
                   onChange={e => {
                     const m = Number(e.target.value)
                     const yos = Number(form.pension_yos ?? 30)
                     setForm(p => ({
                       ...p,
                       pension_multiplier: m,
                       pension_pct: Math.round(m * yos * 10) / 10,
                     }))
                   }}
                   style={{ ...INPUT_STYLE, width: 60, padding: 2, fontSize: 11 }} />
            <span>%/yr ×</span>
            <input type="number" min={0} max={50} step={1}
                   value={form.pension_yos ?? 30}
                   onChange={e => {
                     const yos = Number(e.target.value)
                     const m = Number(form.pension_multiplier ?? 1.5)
                     setForm(p => ({
                       ...p,
                       pension_yos: yos,
                       pension_pct: Math.round(m * yos * 10) / 10,
                     }))
                   }}
                   style={{ ...INPUT_STYLE, width: 60, padding: 2, fontSize: 11 }} />
            <span>YOS @ retirement →</span>
            <strong style={{ color: 'var(--text-primary)' }}>
              {Math.round((form.pension_multiplier ?? 1.5) * (form.pension_yos ?? 30) * 10) / 10}%
            </strong>
            <span style={{ color: '#94a3b8' }}>
              (e.g. MI ORS Tier 1 = 1.5%/yr; common federal = 1.0–1.1%)
            </span>
          </div>
        )}
      </Section>

      {/* ─────────── SOCIAL SECURITY ─────────── */}
      <Section
        title="Social Security"
        subtitle={form.ss2_annual > 0
          ? "Two streams: one per spouse. Each has its own claim age and COLA timeline."
          : "Estimated annual benefit. Pull from ssa.gov/myaccount. Add a 2nd stream for your spouse below."}
      >
        {/* SS stress-test row — applies to BOTH streams. Most important
            stress test for retirement plans, since the SSA Trustees
            project Trust Fund depletion ~2033-35 with ~77% scheduled
            benefits payable thereafter. Default 0 = full benefits. */}
        <div style={{
          marginBottom: 10,
          paddingBottom: 8,
          borderBottom: '1px dashed rgba(255,255,255,0.06)',
        }}>
          <FieldGrid>
            <Field
              label="SS haircut %"
              help="Stress-test: apply a flat reduction to BOTH SS streams. SSA Trustees project the OASI Trust Fund depletes ~2033-35; payroll taxes alone cover ~77% of scheduled benefits after that. Set to 23 for the depletion scenario, 50 for harsher cuts, 100 for 'no SS at all'. Pension is unaffected (state pensions have stronger legal protections)."
            >
              <input type="number" min={0} max={100} step={1}
                     value={Math.round(form.ss_reduction_pct * 100)}
                     onChange={e => setForm(p => ({ ...p, ss_reduction_pct: Number(e.target.value) / 100 }))}
                     style={INPUT_STYLE} />
            </Field>
          </FieldGrid>
          {form.ss_reduction_pct > 0 && (
            <div style={{
              marginTop: 6,
              fontSize: 11,
              color: 'var(--accent-orange)',
            }}>
              ⚠ Stress test active: SS benefits cut by {Math.round(form.ss_reduction_pct * 100)}%.
              Effective SS shown below already reflects the reduction.
            </div>
          )}
        </div>
        {/* SS #1 — primary holder (typically you). Person label clarifies
            whose stream this is at a glance. */}
        <PersonHeader
          label={form.ss_holder === 'spouse' ? 'Spouse' : 'You'}
          age={form.ss_holder === 'spouse' && form.spouse_age !== '' ? form.spouse_age : form.current_age}
        />
        <FieldGrid>
          <Field
            label="SS / yr"
            help="Estimated Social Security annual benefit in today's dollars. Pull your actual estimate from ssa.gov/myaccount — it varies by claim age. 0 = not modeled."
          >
            <input type="number" min={0} step={1000}
                   value={form.ss_annual}
                   onChange={update('ss_annual')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Whose?"
            help="SS is per-person. Pick which person this benefit belongs to so claim age timing aligns with their birth date."
          >
            <select
              value={form.ss_holder}
              onChange={e => setForm(p => ({ ...p, ss_holder: e.target.value }))}
              style={INPUT_STYLE}
            >
              <option value="you">You ({form.current_age})</option>
              <option value="spouse" disabled={form.spouse_age === '' || form.spouse_age === undefined}>
                Spouse {form.spouse_age !== '' && form.spouse_age !== undefined ? `(${form.spouse_age})` : '— set spouse age first'}
              </option>
            </select>
          </Field>
          <Field
            label="Claim at age"
            help="62 = earliest with reduction (~30%). 67 = full retirement age for those born 1960+. 70 = max benefit with delayed-retirement credits (+24% over 67)."
          >
            <input type="number" min={62} max={70} step={1}
                   value={form.ss_start_age}
                   onChange={update('ss_start_age')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="COLA % (nominal)"
            help="NOMINAL Social Security COLA — the actual % the SS check increases each year. Projection subtracts inflation to get real growth. SS is CPI-W indexed; historical avg 2-3%/yr. With default 2.5% inflation, 2.5% nominal COLA = 0% real growth (SS keeps pace with inflation, no real expansion)."
          >
            <input type="number" min={0} max={10} step={0.1}
                   value={Math.round(form.ss_cola * 1000) / 10}
                   onChange={e => setForm(p => ({ ...p, ss_cola: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
        </FieldGrid>

        {/* SS #2 — spouse stream. Hidden when ss2_annual is exactly 0;
            user clicks "+ Add spouse SS" to materialize it. Removing
            sets ss2_annual back to 0 so the row collapses again.
            Add-button is disabled until spouse_age is set, since the
            holder dropdown won't have a valid 'spouse' option without
            it. */}
        {form.ss2_annual > 0 ? (
          <>
            <PersonHeader
              label={form.ss2_holder === 'spouse' ? 'Spouse' : 'You'}
              age={form.ss2_holder === 'spouse' && form.spouse_age !== '' ? form.spouse_age : form.current_age}
              onRemove={() => setForm(p => ({ ...p, ss2_annual: 0 }))}
              removeTitle="Remove spouse SS"
            />
            <FieldGrid>
              <Field label="SS / yr" help="Spouse's estimated SS annual benefit in today's dollars.">
                <input type="number" min={0} step={1000}
                       value={form.ss2_annual}
                       onChange={update('ss2_annual')}
                       style={INPUT_STYLE} />
              </Field>
              <Field label="Whose?" help="Whose SS this stream represents. Defaults to spouse for the 2nd stream.">
                <select
                  value={form.ss2_holder}
                  onChange={e => setForm(p => ({ ...p, ss2_holder: e.target.value }))}
                  style={INPUT_STYLE}
                >
                  <option value="you">You ({form.current_age})</option>
                  <option value="spouse" disabled={form.spouse_age === '' || form.spouse_age === undefined}>
                    Spouse {form.spouse_age !== '' && form.spouse_age !== undefined ? `(${form.spouse_age})` : '— set spouse age first'}
                  </option>
                </select>
              </Field>
              <Field label="Claim at age" help="Same scale as primary: 62 earliest, 67 FRA, 70 max.">
                <input type="number" min={62} max={70} step={1}
                       value={form.ss2_start_age}
                       onChange={update('ss2_start_age')}
                       style={INPUT_STYLE} />
              </Field>
              <Field label="COLA % (nominal)" help="Spouse SS nominal COLA. Same handling: subtract inflation for real growth. Default 2.5% matches CPI-W historical average.">
                <input type="number" min={0} max={10} step={0.1}
                       value={Math.round(form.ss2_cola * 1000) / 10}
                       onChange={e => setForm(p => ({ ...p, ss2_cola: Number(e.target.value) / 100 }))}
                       style={INPUT_STYLE} />
              </Field>
            </FieldGrid>
          </>
        ) : (
          <div style={{ marginTop: 8 }}>
            <button
              type="button"
              onClick={() => setForm(p => ({
                ...p,
                // Seed with a sensible default so the row appears with a
                // visible value the user can edit, instead of blank zeros.
                // 24000 = ~$2k/mo, mid-range for a spouse with a moderate
                // earnings history.
                ss2_annual: 24000,
                ss2_holder: 'spouse',
                ss2_start_age: 67,
                ss2_cola: 0.025,
              }))}
              disabled={form.spouse_age === '' || form.spouse_age === undefined}
              title={form.spouse_age === '' || form.spouse_age === undefined
                ? 'Set spouse age above first'
                : 'Add a 2nd Social Security stream for your spouse'}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                background: 'rgba(96,165,250,0.12)',
                border: '1px dashed rgba(96,165,250,0.4)',
                color: 'var(--accent-blue)',
                borderRadius: 6,
                cursor: form.spouse_age === '' || form.spouse_age === undefined ? 'not-allowed' : 'pointer',
                opacity: form.spouse_age === '' || form.spouse_age === undefined ? 0.5 : 1,
              }}
            >
              + Add spouse SS
            </button>
          </div>
        )}
      </Section>

      {/* ─────────── TAXES & INFLATION ─────────── */}
      <Section
        title="Taxes & inflation"
        subtitle="Tax rates apply per account's tax bucket at withdrawal. Inflation converts your nominal COLA inputs into real growth."
      >
        <FieldGrid>
          <Field
            label="Ordinary tax rate %"
            help="Effective tax rate on traditional 401k/IRA withdrawals AND pension income. ~22% federal bracket + ~4% MI = ~26% blended is conservative; MI partially exempts public pensions."
          >
            <input type="number" min={0} max={100} step={0.1}
                   value={Math.round(form.tax_rate_ordinary * 1000) / 10}
                   onChange={e => setForm(p => ({ ...p, tax_rate_ordinary: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Capital gains rate %"
            help="LTCG rate on taxable-brokerage withdrawals. Federal 15% for most retirees; MI conforms. The projection treats the full taxable withdrawal at this rate as a conservative simplification."
          >
            <input type="number" min={0} max={100} step={0.1}
                   value={Math.round(form.tax_rate_capital_gains * 1000) / 10}
                   onChange={e => setForm(p => ({ ...p, tax_rate_capital_gains: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Inflation %"
            help="Annual inflation assumption. Real return is your nominal return minus this. Real COLA = the COLA you entered above − inflation. Examples: SS 2.5% nominal COLA + 2.5% inflation = 0% real (SS just keeps pace, no real growth). Pension at 0% nominal COLA = -2.5% real (eroded by inflation). Default 2.5% (long-run US average)."
          >
            <input type="number" min={0} max={10} step={0.1}
                   value={Math.round(form.inflation_rate * 1000) / 10}
                   onChange={e => setForm(p => ({ ...p, inflation_rate: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="State tax %"
            help="Effective state income tax rate. The dropdown auto-fills a retiree-relevant effective rate that already accounts for typical state exemptions (SS, public pensions, retirement-income credits). MI shows 2.5% rather than the headline 4.25% because public pensions (e.g. MI ORS) are partially exempt and SS isn't taxed. Override manually if you have an unusual situation."
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                value={(STATE_TAX_PRESETS.find(s => s.rate === form.state_tax_rate) || {}).code || ''}
                onChange={e => {
                  const preset = STATE_TAX_PRESETS.find(s => s.code === e.target.value)
                  if (preset && preset.rate !== null) {
                    setForm(p => ({ ...p, state_tax_rate: preset.rate }))
                  }
                }}
                style={{ ...INPUT_STYLE, flex: '0 0 70px' }}
                title="Pick a state to auto-fill the effective rate"
              >
                {STATE_TAX_PRESETS.map(s => (
                  <option key={s.code} value={s.code}>{s.code || '—'}</option>
                ))}
              </select>
              <input type="number" min={0} max={15} step={0.05}
                     value={Math.round(form.state_tax_rate * 10000) / 100}
                     onChange={e => setForm(p => ({ ...p, state_tax_rate: Number(e.target.value) / 100 }))}
                     style={{ ...INPUT_STYLE, flex: 1 }} />
            </div>
            {(() => {
              const preset = STATE_TAX_PRESETS.find(s => s.rate === form.state_tax_rate && s.code)
              return preset ? (
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, lineHeight: 1.3 }}>
                  {preset.note}
                </div>
              ) : null
            })()}
          </Field>
          <Field
            label="Taxable basis %"
            help="What % of your taxable brokerage bucket is your original cost basis (return of capital — NOT taxed at withdrawal). Default 50% = neutral. Set lower (20-30) for heavily appreciated long-held positions; higher (70-100) for recently funded accounts. The GAIN portion gets LTCG-taxed; the basis portion comes out tax-free."
          >
            <input type="number" min={0} max={100} step={1}
                   value={Math.round(form.taxable_basis_pct * 100)}
                   onChange={e => setForm(p => ({ ...p, taxable_basis_pct: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Apply IRMAA"
            help="Income-Related Monthly Adjustment Amount — the surcharge added to Medicare Part B + D premiums when MAGI exceeds tier thresholds (2025 first tier $206k MFJ). Hits any year where one or both spouses are 65+. Surcharges scale per-spouse-on-Medicare across 5 tiers up to ~$2k/mo per person at the top. Material in your 70s when RMDs + SS + pension stack. Default ON for honesty."
          >
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '0 4px', fontSize: 13, height: 36,
            }}>
              <input
                type="checkbox"
                checked={form.apply_irmaa}
                onChange={e => setForm(p => ({ ...p, apply_irmaa: e.target.checked }))}
              />
              <span>{form.apply_irmaa ? 'On' : 'Off'}</span>
            </label>
          </Field>
          <Field
            label="TCJA sunset"
            help="Federal ordinary brackets are scheduled to revert to the higher pre-2018 schedule starting in 2026 unless Congress extends. When ON, model the bracket reversion (22%→25%, 24%→28%, 32%→33%, 37%→39.6%) plus the standard deduction roughly halving. The biggest unmodeled tax risk for households with large tax-deferred bucket — RMDs in your 70s land in higher brackets. Default OFF (assume Congress extends)."
          >
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '0 4px', fontSize: 13, height: 36,
            }}>
              <input
                type="checkbox"
                checked={form.tcja_sunset_enabled}
                onChange={e => setForm(p => ({ ...p, tcja_sunset_enabled: e.target.checked }))}
              />
              <span>{form.tcja_sunset_enabled ? 'On' : 'Off'}</span>
            </label>
          </Field>
          <Field
            label="Sunset year"
            help="Calendar year the bracket reversion takes effect. Default 2026 = current TCJA expiration. Bump higher if you assume a partial extension. Only matters when TCJA sunset is ON."
          >
            <input type="number" min={2025} max={2050} step={1}
                   value={form.tcja_sunset_year}
                   onChange={e => setForm(p => ({ ...p, tcja_sunset_year: Number(e.target.value) }))}
                   disabled={!form.tcja_sunset_enabled}
                   style={{ ...INPUT_STYLE, opacity: form.tcja_sunset_enabled ? 1 : 0.4 }} />
          </Field>
          <Field
            label="QBI income / yr"
            help="Annual Qualified Business Income (Section 199A) — Schedule C, S-corp, or partnership income that flows into retirement. 20% gets deducted before brackets apply. Useful when you have ongoing consulting / royalties / pass-through income post-retirement. Phase-out above ~$383k MFJ isn't modeled (fine for typical retirees). 0 = no QBI."
          >
            <input type="number" min={0} step={1000}
                   value={form.qbi_business_income}
                   onChange={e => setForm(p => ({ ...p, qbi_business_income: Number(e.target.value) }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="TLH / yr"
            help="Tax-Loss Harvesting on the taxable brokerage bucket. Annual realized losses you expect to harvest from rebalancing trades. IRS caps the ordinary-income offset at $3,000/yr — anything above carries forward (the Investments page tracks the carryover separately). Modest cumulative effect over a long horizon. 0 = no TLH modeled."
          >
            <input type="number" min={0} max={10000} step={500}
                   value={form.tlh_annual}
                   onChange={e => setForm(p => ({ ...p, tlh_annual: Number(e.target.value) }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="QCD / yr"
            help="Qualified Charitable Distribution. Once you're 70½+, up to $108k/yr (2025 IRC §408(d)(8) limit, inflation-indexed) of an IRA distribution can flow direct from your IRA to a qualified charity. The gross amount counts toward your RMD but is EXCLUDED from taxable income. Biggest tax-optimization most charitably-inclined retirees miss — strictly better than donating cash from a taxable account once you're hit by RMDs. 0 = no QCD planned. Honored only at age 70½+."
          >
            <input type="number" min={0} max={108000} step={1000}
                   value={form.qcd_annual || 0}
                   onChange={e => setForm(p => ({ ...p, qcd_annual: Number(e.target.value) }))}
                   style={INPUT_STYLE} />
          </Field>
        </FieldGrid>
      </Section>

      {/* ─────────── ROTH CONVERSION LADDER ─────────── */}
      <Section
        title="Roth conversion ladder"
        subtitle={
          <>
            Convert tax-deferred → Roth during the bridge years (first retirement → first SS claim) when ordinary income is low.
            Pays tax now at lower brackets to escape future RMD-driven high-bracket draws. Set amount = 0 to disable.
            {data?.roth_comparison && (
              <span style={{
                display: 'inline-block',
                marginLeft: 8,
                padding: '2px 8px',
                borderRadius: 4,
                background: data.roth_comparison.lifetime_tax_savings > 0
                  ? 'var(--accent-green-bg)' : 'var(--accent-orange-bg)',
                color: data.roth_comparison.lifetime_tax_savings > 0
                  ? 'var(--accent-green)' : 'var(--accent-orange)',
                fontWeight: 600,
                fontSize: 12,
                border: `1px solid ${data.roth_comparison.lifetime_tax_savings > 0
                  ? 'var(--accent-green-border)' : 'var(--accent-orange-border)'}`,
              }}>
                Lifetime tax {data.roth_comparison.lifetime_tax_savings > 0 ? 'saved' : 'cost'}: {fmt(Math.abs(data.roth_comparison.lifetime_tax_savings))}
              </span>
            )}
          </>
        }
      >
        <FieldGrid>
          <Field
            label="Convert / yr"
            help="Annual $ to convert from tax-deferred → Roth during the conversion window. Sweet spot: fill the 12% or 22% bracket (after pension/SS) without crossing into a higher one. Common values: $30-80k/yr for a household with low bridge-year income. The conversion is taxed as ordinary income that year; the tax is paid from the taxable bucket so the gross amount keeps growing tax-free in Roth."
          >
            <input type="number" min={0} step={5000}
                   value={form.roth_conversion_amount}
                   onChange={update('roth_conversion_amount')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Start age"
            help="Age at which conversions begin. Most strategies start the year after the first spouse retires (when wages stop and ordinary income drops)."
          >
            <input type="number" min={0} max={120} step={1}
                   value={form.roth_conversion_start_age || ''}
                   placeholder="—"
                   onChange={e => setForm(p => ({ ...p, roth_conversion_start_age: Number(e.target.value) || 0 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="End age"
            help="Age at which conversions stop. Usually the year before the first SS claim (62) or before RMDs begin (73), since both add to ordinary income and shrink the cheap-bracket headroom. A typical sweet spot is the 5-7 years between first retirement and first SS claim."
          >
            <input type="number" min={0} max={120} step={1}
                   value={form.roth_conversion_end_age || ''}
                   placeholder="—"
                   onChange={e => setForm(p => ({ ...p, roth_conversion_end_age: Number(e.target.value) || 0 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Fill to bracket"
            help="Smarter alternative to a flat $/yr conversion: pick a target marginal bracket and the simulator fills exactly to the top of that bracket each conversion year. Bigger conversions in low-income years, automatically tapers as SS / RMDs eat headroom. Overrides Convert/yr when set. Choose 12% to stay in the lowest meaningful bracket; 22-24% to be more aggressive."
          >
            <select
              value={form.roth_conversion_target_bracket}
              onChange={e => setForm(p => ({ ...p, roth_conversion_target_bracket: e.target.value }))}
              style={INPUT_STYLE}
            >
              <option value="">— use $/yr</option>
              <option value="0.10">10%</option>
              <option value="0.12">12%</option>
              <option value="0.22">22%</option>
              <option value="0.24">24%</option>
              <option value="0.32">32%</option>
            </select>
          </Field>
        </FieldGrid>

        {/* Comparison summary — only when results are loaded AND the
            strategy is active (backend returns roth_comparison block). */}
        {data?.roth_comparison && (
          <div style={{
            marginTop: 12,
            padding: 12,
            background: 'var(--bg-input)',
            border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
            borderRadius: 6,
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--text-primary)',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-primary)' }}>
              Strategy vs no-conversion baseline:
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Total converted</div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                  {fmt(data.roth_comparison.total_converted)}
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Lifetime tax (with strategy)</div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                  {fmt(data.roth_comparison.with_strategy_lifetime_tax)}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                  baseline {fmt(data.roth_comparison.baseline_lifetime_tax)}
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>End balance delta</div>
                <div style={{
                  fontWeight: 600,
                  fontSize: 14,
                  color: data.roth_comparison.end_balance_delta >= 0
                    ? 'var(--accent-green)' : 'var(--accent-orange)',
                }}>
                  {data.roth_comparison.end_balance_delta >= 0 ? '+' : ''}{fmt(data.roth_comparison.end_balance_delta)}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                  vs baseline {fmt(data.roth_comparison.baseline_end_balance)}
                </div>
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* ─────────── STRESS TESTS ─────────── */}
      <Section
        title="Stress tests"
        subtitle="What-if scenarios for survivor planning and long-term care. Defaults of 0 / blank mean off — opt in to model the risk."
      >
        <FieldGrid>
          <Field
            label="Survivor @ age"
            help="Stress test: at this user-age, model losing one spouse. Lower SS terminates (SSA survivor-benefit rule), pension reduces by 1 - survivor%, filing flips MFJ → Single (brackets shrink, std deduction halves). Blank = no event modeled. Try 75 or 80 to see the surviving-spouse impact."
          >
            <input type="number" min={form.current_age + 1} max={120} step={1}
                   value={form.survivor_at_user_age}
                   placeholder="—"
                   onChange={update('survivor_at_user_age')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Pension survivor %"
            help="% of pension that continues to surviving spouse. Common J&S options: 100 (J&S 100% — full continuation), 75 (J&S 75%), 50 (J&S 50% — most common default), 0 (life-only — pension ends with holder). Determined at retirement from the plan."
          >
            <input type="number" min={0} max={100} step={5}
                   value={Math.round(form.pension_survivor_pct * 100)}
                   onChange={e => setForm(p => ({ ...p, pension_survivor_pct: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Survivor spend %"
            help="Single-retiree spending as % of couple spending. Industry data: 65-75% — housing/utilities/insurance are largely fixed, but food/travel/entertainment scale with people. Default 70% (conservative middle). Set 100 to disable (model assumes no spending change after spouse loss). Only applies in years AFTER the survivor event (set Survivor @ age above to enable that event)."
          >
            <input type="number" min={30} max={100} step={5}
                   value={Math.round(form.survivor_spending_multiplier * 100)}
                   onChange={e => setForm(p => ({ ...p, survivor_spending_multiplier: Number(e.target.value) / 100 }))}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="LTC cost / yr"
            help="Long-term care annual cost (today's dollars). Industry estimates: skilled nursing $60-100k/yr, assisted living $40-60k/yr, in-home care $25-50k/yr. Hits 70% of retirees. 0 = not modeled."
          >
            <input type="number" min={0} step={5000}
                   value={form.ltc_annual_cost}
                   onChange={update('ltc_annual_cost')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="LTC starts at"
            help="User-age at which LTC expenses begin. Industry median onset is 80-85. The cost ramps in for ltc_duration_years."
          >
            <input type="number" min={60} max={110} step={1}
                   value={form.ltc_start_age}
                   onChange={update('ltc_start_age')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="LTC duration (yrs)"
            help="How many years LTC continues. Industry median is 2-3 years. Long-tail risk — 14% of LTC stays exceed 5 years."
          >
            <input type="number" min={1} max={20} step={1}
                   value={form.ltc_duration_years}
                   onChange={update('ltc_duration_years')}
                   style={INPUT_STYLE} />
          </Field>
          {/* Inline LTC sensitivity caption — only when LTC is active.
              Shows the raw end-balance impact compared to the same plan
              without an LTC event. Themed yellow as a soft warning;
              the LTC scenario isn't an error, just an attention nudge. */}
          {data?.ltc_comparison && (
            <div style={{
              gridColumn: '1 / -1',
              fontSize: 12,
              padding: '10px 12px',
              background: 'var(--accent-yellow-bg)',
              border: '1px solid var(--accent-yellow-border)',
              borderLeft: '3px solid var(--accent-yellow)',
              borderRadius: 6,
              color: 'var(--text-primary)',
              lineHeight: 1.5,
            }}>
              <strong style={{ color: 'var(--accent-yellow)' }}>LTC stress: </strong>
              <span>
                {fmt(data.ltc_comparison.total_ltc_paid)} of LTC over {data.ltc_comparison.ltc_duration_years} yrs starting at age {data.ltc_comparison.ltc_start_age}
                {' → '}end balance drops by{' '}
                <strong style={{ color: 'var(--accent-yellow)' }}>
                  {fmt(Math.abs(data.ltc_comparison.end_balance_delta))}
                </strong>
                {' '}({fmt(data.ltc_comparison.no_ltc_end_balance)} without LTC vs {fmt(data.ltc_comparison.with_ltc_end_balance)} with).
              </span>
              <div style={{ marginTop: 4, color: 'var(--text-secondary)', fontSize: 11 }}>
                Worth pricing LTC insurance if the delta is uncomfortable.
              </div>
            </div>
          )}
          <Field
            label="Monte Carlo runs"
            help="Run N stochastic simulations with random returns drawn from N(mean=return, std=volatility). 0 = off (deterministic only). 500-1000 is industry-standard. Output shown as fan chart + probability-of-success tile. WARNING: 1000+ runs may take 1-2 seconds to compute."
          >
            <input type="number" min={0} max={5000} step={100}
                   value={form.monte_carlo_runs}
                   onChange={update('monte_carlo_runs')}
                   style={INPUT_STYLE} />
          </Field>
          <Field
            label="Sequence stress"
            help="Apply a predefined bad-returns scenario to the deterministic projection. 'Bad first 3' = -20%/yr × 3 years at start of withdrawal (worst-case sequence-of-returns risk). 'Lost decade' = 0% real for 10 yrs. 'Recession yr 5' = -15% in year 5 of retirement. Doesn't affect Monte Carlo runs."
          >
            <select
              value={form.sequence_stress_preset}
              onChange={e => setForm(p => ({ ...p, sequence_stress_preset: e.target.value }))}
              style={INPUT_STYLE}
            >
              <option value="none">None (smooth returns)</option>
              <option value="bad_3">Bad first 3 yrs (-20% × 3)</option>
              <option value="lost_decade">Lost decade (0% × 10)</option>
              <option value="recession_5">Recession yr 5 (-15%)</option>
              <option value="inflation_shock">Inflation shock (-5% real × 3y)</option>
            </select>
          </Field>
        </FieldGrid>

        {/* One-time events list — handles both EXPENSES (wedding,
            renovation) and INFLOWS (inheritance, gift, asset sale).
            Convention: positive amount = expense, negative = inflow.
            Inflows land in the taxable bucket regardless of phase. */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed rgba(255,255,255,0.06)' }}>
          <div style={{
            fontSize: 11, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>One-time / lumpy events</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={() => setForm(p => ({
                  ...p,
                  one_time_expenses: [
                    ...(p.one_time_expenses || []),
                    { age: (p.current_age || 30) + 10, amount: 25000, label: 'expense' },
                  ],
                }))}
                style={{
                  padding: '4px 10px', fontSize: 11,
                  background: 'var(--accent-orange-bg)',
                  border: '1px dashed var(--accent-orange-border)',
                  color: 'var(--accent-orange)', borderRadius: 4, cursor: 'pointer',
                }}
                title="One-time outflow — wedding, RV, renovation, mortgage payoff, etc."
              >
                + Expense
              </button>
              <button
                type="button"
                onClick={() => setForm(p => ({
                  ...p,
                  one_time_expenses: [
                    ...(p.one_time_expenses || []),
                    { age: (p.current_age || 30) + 10, amount: -100000, label: 'inheritance' },
                  ],
                }))}
                style={{
                  padding: '4px 10px', fontSize: 11,
                  background: 'var(--accent-green-bg)',
                  border: '1px dashed var(--accent-green-border)',
                  color: 'var(--accent-green)', borderRadius: 4, cursor: 'pointer',
                }}
                title="One-time inflow — inheritance, gift, asset sale. Lands in taxable bucket. Cash inheritance is federally tax-free; for inherited IRAs use the Roth conversion ladder mechanic."
              >
                + Inflow
              </button>
              {/* End-of-life suggestion preset. Industry estimate
                  (per CFP / NIA literature): ~$40k median for final
                  medical out-of-pocket + funeral / burial. The bigger
                  number applies to LTC, modeled separately as an
                  age-windowed cost. Adds at age 95 by default — far
                  enough out that most simulations have already drained
                  to fixed income, so the impact is the right shape
                  (one-time hit not modeled elsewhere). */}
              <button
                type="button"
                onClick={() => setForm(p => {
                  const exists = (p.one_time_expenses || []).some(
                    e => e.label && e.label.toLowerCase().includes('end-of-life')
                  )
                  if (exists) return p  // don't double-add
                  return {
                    ...p,
                    one_time_expenses: [
                      ...(p.one_time_expenses || []),
                      { age: 95, amount: 40000, label: 'End-of-life (medical + funeral)' },
                    ],
                  }
                })}
                style={{
                  padding: '4px 10px', fontSize: 11,
                  background: 'var(--bg-input)',
                  border: '1px dashed var(--border-color, rgba(255,255,255,0.2))',
                  color: 'var(--text-secondary)', borderRadius: 4, cursor: 'pointer',
                }}
                title="Industry estimate: ~$40k for final medical out-of-pocket + funeral / burial at age 95. Adds as a one-time expense — adjust age/amount or remove if your plan handles it elsewhere (e.g. life insurance covers funeral)."
              >
                + End-of-life
              </button>
            </div>
          </div>
          {(!form.one_time_expenses || form.one_time_expenses.length === 0) ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No events. Use <strong style={{ color: 'var(--accent-orange)' }}>+ Expense</strong> for
              one-time outflows (wedding, RV, renovation, mortgage payoff). Use{' '}
              <strong style={{ color: 'var(--accent-green)' }}>+ Inflow</strong> for windfalls
              (inheritance, gift, asset sale) — those land in the taxable bucket as a deposit.
              Amounts are entered positive for either; the convention is encoded by which
              button you used (negative amount in the table = inflow).
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Column headers — widest layout (inflow=6 cols) so the
                  Bucket header is always present even when only Expense
                  rows exist. Slightly looser visual fit on Expense-only
                  rows but gains scannability across mixed lists. */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '70px 70px 100px 90px 1fr 60px',
                gap: 8,
                padding: '0 6px',
                fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                textTransform: 'uppercase', color: 'var(--text-muted)',
              }}>
                <span>Kind</span>
                <span>Age</span>
                <span>Amount</span>
                <span>Bucket</span>
                <span>Label</span>
                <span></span>
              </div>
              {form.one_time_expenses.map((evt, idx) => {
                const isInflow = (evt.amount || 0) < 0
                const accent = isInflow ? 'var(--accent-green)' : 'var(--accent-orange)'
                return (
                <div key={idx} style={{
                  display: 'grid',
                  gridTemplateColumns: isInflow
                    ? '70px 70px 100px 90px 1fr 60px'
                    : '70px 90px 120px 1fr 60px',
                  gap: 8, alignItems: 'center',
                  padding: '4px 6px',
                  background: isInflow ? 'var(--accent-green-bg)' : 'transparent',
                  border: isInflow ? '1px solid var(--accent-green-border)' : '1px solid transparent',
                  borderRadius: 4,
                }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                    textTransform: 'uppercase', color: accent, textAlign: 'center',
                  }}>
                    {isInflow ? 'Inflow' : 'Expense'}
                  </span>
                  <input
                    type="number" min={form.current_age || 18} max={120} step={1}
                    placeholder="Age"
                    value={evt.age}
                    onChange={e => {
                      const newEvents = [...form.one_time_expenses]
                      newEvents[idx] = { ...evt, age: Number(e.target.value) }
                      setForm(p => ({ ...p, one_time_expenses: newEvents }))
                    }}
                    style={{ ...INPUT_STYLE, height: 30, fontSize: 12 }}
                  />
                  <input
                    type="number" step={1000}
                    placeholder="Amount"
                    value={evt.amount}
                    onChange={e => {
                      const newEvents = [...form.one_time_expenses]
                      newEvents[idx] = { ...evt, amount: Number(e.target.value) }
                      setForm(p => ({ ...p, one_time_expenses: newEvents }))
                    }}
                    style={{ ...INPUT_STYLE, height: 30, fontSize: 12 }}
                    title="Positive = expense, negative = inflow"
                  />
                  {/* Bucket selector — only for inflows. Cash inheritance
                      → taxable (default); inherited Trad-IRA → tax_deferred
                      (subject to 10-yr SECURE Act drain); inherited Roth
                      IRA → roth (also 10-yr drain but tax-free). */}
                  {isInflow && (
                    <select
                      value={evt.bucket || 'taxable'}
                      onChange={e => {
                        const newEvents = [...form.one_time_expenses]
                        newEvents[idx] = { ...evt, bucket: e.target.value }
                        setForm(p => ({ ...p, one_time_expenses: newEvents }))
                      }}
                      style={{ ...INPUT_STYLE, height: 30, fontSize: 11 }}
                      title="Where the inflow lands. Inherited IRAs need post-SECURE 10-yr drain — model that with paired expense events."
                    >
                      <option value="taxable">Taxable</option>
                      <option value="tax_deferred">TD (Trad IRA)</option>
                      <option value="roth">Roth IRA</option>
                      <option value="hsa">HSA</option>
                    </select>
                  )}
                  <input
                    type="text" placeholder={isInflow ? "Label (e.g. inheritance)" : "Label (e.g. wedding)"}
                    value={evt.label || ''}
                    onChange={e => {
                      const newEvents = [...form.one_time_expenses]
                      newEvents[idx] = { ...evt, label: e.target.value }
                      setForm(p => ({ ...p, one_time_expenses: newEvents }))
                    }}
                    style={{ ...INPUT_STYLE, height: 30, fontSize: 12 }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const newEvents = form.one_time_expenses.filter((_, i) => i !== idx)
                      setForm(p => ({ ...p, one_time_expenses: newEvents }))
                    }}
                    style={{
                      padding: '4px 8px', fontSize: 11,
                      background: 'transparent',
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: 'var(--text-muted)', borderRadius: 4, cursor: 'pointer',
                    }}
                  >
                    × Remove
                  </button>
                </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Step events — permanent (or duration-bound) shifts to
            spending or contribution starting at a given age. The
            honest primitive for life events whose financial impact
            persists rather than firing once: mortgage payoff, kid
            college, kid leaves home, sabbatical, business income
            kicking in. The user picks contribution-vs-spending
            explicitly so the model doesn't make assumptions about
            behavioral response (e.g., mortgage payoff CAN free up
            savings OR absorb into lifestyle — the user decides). */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed rgba(255,255,255,0.06)' }}>
          <div style={{
            fontSize: 11, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span>Step events (permanent / duration shifts)</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={() => setForm(p => ({
                  ...p,
                  step_events: [
                    ...(p.step_events || []),
                    { age: (p.current_age || 30) + 10, kind: 'contribution', delta: 24000, duration_years: 0, label: 'mortgage payoff' },
                  ],
                }))}
                style={{
                  padding: '4px 10px', fontSize: 11,
                  background: 'var(--accent-green-bg)',
                  border: '1px dashed var(--accent-green-border)',
                  color: 'var(--accent-green)', borderRadius: 4, cursor: 'pointer',
                }}
                title="Step change to contribution (e.g., mortgage payoff frees +$X/yr to savings, business income +$X/yr, etc.)"
              >
                + Contribution step
              </button>
              <button
                type="button"
                onClick={() => setForm(p => ({
                  ...p,
                  step_events: [
                    ...(p.step_events || []),
                    { age: (p.current_age || 30) + 10, kind: 'spending', delta: 30000, duration_years: 4, label: 'kid college' },
                  ],
                }))}
                style={{
                  padding: '4px 10px', fontSize: 11,
                  background: 'var(--accent-orange-bg)',
                  border: '1px dashed var(--accent-orange-border)',
                  color: 'var(--accent-orange)', borderRadius: 4, cursor: 'pointer',
                }}
                title="Step change to spending (e.g., kid college +$30k/yr × 4 yrs, kid leaves home -$15k/yr forever, lifestyle inflation +$X/yr)"
              >
                + Spending step
              </button>
            </div>
          </div>
          {/* Auto-suggest mortgage payoff step events for any loans
              whose payoff date falls during accumulation. The user
              still picks contribution-vs-spending (defaults to
              contribution since "save the freed cashflow" is the
              optimal play) and clicks Apply to add it to the list. */}
          <LoanPayoffSuggestions
            currentAge={form.current_age}
            retirementAge={form.retirement_age}
            existingEvents={form.step_events || []}
            onApply={(evt) => setForm(p => ({
              ...p,
              step_events: [...(p.step_events || []), evt],
            }))}
          />
          {(!form.step_events || form.step_events.length === 0) ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No step events. Use{' '}
              <strong style={{ color: 'var(--accent-green)' }}>+ Contribution step</strong> for
              ongoing changes to savings (mortgage payoff → +$X/yr saved, business income onset),
              and <strong style={{ color: 'var(--accent-orange)' }}>+ Spending step</strong> for
              ongoing spending shifts (college costs, kid leaves home, lifestyle inflation).
              Set <em>Years</em> to 0 for permanent, or N for an N-year window. Negative deltas
              decrease the line; positive deltas increase it.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Column headers — same grid template as the rows below
                  so each label aligns with its input. Easy to scan
                  what each number represents without hovering. */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '110px 70px 100px 70px 1fr 60px',
                gap: 8,
                padding: '0 6px',
                fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                textTransform: 'uppercase', color: 'var(--text-muted)',
              }}>
                <span>Kind</span>
                <span>Age</span>
                <span>Δ /yr</span>
                <span>Years</span>
                <span>Label</span>
                <span></span>
              </div>
              {form.step_events.map((evt, idx) => {
                const isContrib = evt.kind === 'contribution'
                const accent = isContrib ? 'var(--accent-green)' : 'var(--accent-orange)'
                const accentBg = isContrib ? 'var(--accent-green-bg)' : 'var(--accent-orange-bg)'
                const accentBorder = isContrib ? 'var(--accent-green-border)' : 'var(--accent-orange-border)'
                return (
                <div key={idx} style={{
                  display: 'grid',
                  gridTemplateColumns: '110px 70px 100px 70px 1fr 60px',
                  gap: 8, alignItems: 'center',
                  padding: '4px 6px',
                  background: accentBg,
                  border: `1px solid ${accentBorder}`,
                  borderRadius: 4,
                }}>
                  <select
                    value={evt.kind}
                    onChange={e => {
                      const newEvents = [...form.step_events]
                      newEvents[idx] = { ...evt, kind: e.target.value }
                      setForm(p => ({ ...p, step_events: newEvents }))
                    }}
                    style={{ ...INPUT_STYLE, height: 30, fontSize: 11, color: accent, fontWeight: 600 }}
                  >
                    <option value="contribution">Contribution</option>
                    <option value="spending">Spending</option>
                  </select>
                  <input
                    type="number" min={form.current_age || 18} max={120} step={1}
                    placeholder="Age"
                    value={evt.age}
                    onChange={e => {
                      const newEvents = [...form.step_events]
                      newEvents[idx] = { ...evt, age: Number(e.target.value) }
                      setForm(p => ({ ...p, step_events: newEvents }))
                    }}
                    style={{ ...INPUT_STYLE, height: 30, fontSize: 12 }}
                    title="Age this step starts"
                  />
                  <input
                    type="number" step={1000}
                    placeholder="Δ /yr"
                    value={evt.delta}
                    onChange={e => {
                      const newEvents = [...form.step_events]
                      newEvents[idx] = { ...evt, delta: Number(e.target.value) }
                      setForm(p => ({ ...p, step_events: newEvents }))
                    }}
                    style={{ ...INPUT_STYLE, height: 30, fontSize: 12 }}
                    title="Annual change in $. Positive = more of that thing, negative = less."
                  />
                  <input
                    type="number" min={0} max={80} step={1}
                    placeholder="Years"
                    value={evt.duration_years}
                    onChange={e => {
                      const newEvents = [...form.step_events]
                      newEvents[idx] = { ...evt, duration_years: Number(e.target.value) }
                      setForm(p => ({ ...p, step_events: newEvents }))
                    }}
                    style={{ ...INPUT_STYLE, height: 30, fontSize: 12 }}
                    title="0 = permanent (forever); N = lasts N years"
                  />
                  <input
                    type="text" placeholder="Label (e.g. mortgage payoff)"
                    value={evt.label || ''}
                    onChange={e => {
                      const newEvents = [...form.step_events]
                      newEvents[idx] = { ...evt, label: e.target.value }
                      setForm(p => ({ ...p, step_events: newEvents }))
                    }}
                    style={{ ...INPUT_STYLE, height: 30, fontSize: 12 }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const newEvents = form.step_events.filter((_, i) => i !== idx)
                      setForm(p => ({ ...p, step_events: newEvents }))
                    }}
                    style={{
                      padding: '4px 8px', fontSize: 11,
                      background: 'transparent',
                      border: '1px solid rgba(255,255,255,0.1)',
                      color: 'var(--text-muted)', borderRadius: 4, cursor: 'pointer',
                    }}
                  >
                    × Remove
                  </button>
                </div>
                )
              })}
            </div>
          )}
        </div>
      </Section>

      {/* Error / loading / results */}
      {error && (
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: 'rgba(248,113,113,0.08)',
          border: '1px solid rgba(248,113,113,0.3)',
          color: 'var(--accent-red)', fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {loading && !data && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: 'var(--text-muted)' }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Computing…
        </div>
      )}

      {/* Soft warning: when contribution is $0 (either typed or auto-
          detected), the projection is treating future savings as zero —
          which is almost always wrong for someone with a 401k, since
          payroll deferrals are invisible to Plaid. Surface this clearly
          so the user doesn't read the projection as gospel. */}
      {data && (data.inputs.annual_contribution || 0) === 0 && (
        <div style={{
          marginTop: 4,
          marginBottom: 12,
          padding: '8px 12px',
          background: 'rgba(251, 191, 36, 0.08)',
          border: '1px solid rgba(251, 191, 36, 0.3)',
          borderRadius: 8,
          fontSize: 12,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
        }}>
          <AlertCircle size={14} style={{ color: 'var(--accent-orange)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong style={{ color: 'var(--text-primary)' }}>Future contribution is $0.</strong>{' '}
            {data.inputs.contribution_source === 'auto-detected'
              ? 'Auto-detect found no incoming transactions to your investment accounts in the last 12 months — but Plaid can\'t see 401k payroll deferrals (those leave your paycheck before any bank sees them).'
              : 'You explicitly set the contribution to $0.'}
            {' '}If you\'re actually saving anything (401k + match, IRA, brokerage), enter that number above — it materially changes the projection.
          </div>
        </div>
      )}

      {data && <Results data={data} />}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}


function Results({ data }) {
  const onTrack = data.on_track
  const gapColor = onTrack ? 'var(--accent-green)' : 'var(--accent-red)'
  const hasPension = (data.inputs.pension_annual || 0) > 0
  const hasSocialSecurity = (data.inputs.ss_annual || 0) > 0
  const hasSocialSecurity2 = (data.inputs.ss2_annual || 0) > 0
  const hasAnySS = hasSocialSecurity || hasSocialSecurity2
  const hasFixedIncome = hasPension || hasAnySS
  // Combined SS values for tiles/captions that want a household total.
  const ssTotalAtStart = (data.ss_total_at_start ?? data.ss_at_start) || 0
  const ssTotalPv = (data.ss_total_pv ?? data.ss_pv) || 0
  const afterTaxSSTotal =
    (data.after_tax_ss_income || 0) + (data.after_tax_ss2_income || 0)
  // Two-phase sim outputs. last_retirement_user_age is when withdrawals
  // actually start in the household (max of you + spouse retirement).
  // depleted_age is null when the portfolio survives the planning horizon.
  const lastRetireAge = data.last_retirement_user_age ?? data.inputs.retirement_age
  const accumulationYears = data.accumulation_years ?? data.years_to_retirement
  const depletedAge = data.depleted_age
  const endBalance = data.end_balance ?? data.projected_balance

  // Build the chart data — historical (just one point: today's balance)
  // plus year-by-year projection. Carry `phase` so the chart can render
  // accumulation and withdrawal sections distinctly. Income/draw fields
  // are exposed for the tooltip.
  const chartData = [
    {
      year: 0, age: data.inputs.current_age,
      balance: data.current_assets,
      phase: 'accumulating',
      income_streams: 0, portfolio_draw: 0,
    },
    ...data.year_by_year.map(r => ({
      year: r.year, age: r.age, balance: r.balance,
      phase: r.phase,
      income_streams: r.income_streams ?? 0,
      portfolio_draw: r.portfolio_draw ?? 0,
      draw_taxable: r.draw_taxable ?? 0,
      draw_tax_deferred: r.draw_tax_deferred ?? 0,
      draw_roth: r.draw_roth ?? 0,
      after_tax_income: r.after_tax_income ?? 0,
      early_withdrawal_penalty: r.early_withdrawal_penalty ?? 0,
      // RMD, effective spending, healthcare bridge, LTC, tax, and
      // filing status — all surfaced in tooltip when non-zero or
      // worth showing.
      rmd_required: r.rmd_required ?? 0,
      effective_spending: r.effective_spending ?? 0,
      healthcare_cost: r.healthcare_cost ?? 0,
      ltc_cost: r.ltc_cost ?? 0,
      tax_paid: r.tax_paid ?? 0,
      tax_state: r.tax_state ?? 0,
      filing_status: r.filing_status ?? 'mfj',
      income_shortfall: r.income_shortfall ?? 0,
    })),
  ]

  // Compute USER-age at which each income stream first turns on. These
  // become reference-line annotations on the chart so the user can see
  // exactly when income comes online and connect that to the curve's
  // shape (steep drops during pure-portfolio years, flatter once income
  // kicks in). Labels are short (e.g. "Pension @55") so they don't
  // collide horizontally; vertical staggering happens below.
  const incomeOnsets = []
  if (hasPension) {
    const userAgeAtPensionStart = data.inputs.current_age + Math.max(
      0,
      (data.inputs.pension_start_age ?? data.inputs.retirement_age) -
        (data.inputs.pension_holder_age ?? data.inputs.current_age),
    )
    incomeOnsets.push({
      age: userAgeAtPensionStart,
      label: `Pension @${data.inputs.pension_start_age}`,
    })
  }
  if (hasSocialSecurity) {
    const userAgeAtSS1 = data.inputs.current_age + Math.max(
      0,
      data.inputs.ss_start_age - (data.inputs.ss_holder_age ?? data.inputs.current_age),
    )
    incomeOnsets.push({
      age: userAgeAtSS1,
      label: `SS·You @${data.inputs.ss_start_age}`,
    })
  }
  if (hasSocialSecurity2) {
    const userAgeAtSS2 = data.inputs.current_age + Math.max(
      0,
      data.inputs.ss2_start_age - (data.inputs.ss2_holder_age ?? data.inputs.current_age),
    )
    incomeOnsets.push({
      age: userAgeAtSS2,
      label: `SS·Sp @${data.inputs.ss2_start_age}`,
    })
  }

  // ─── Build a single sorted+staggered list of vertical-line annotations.
  // Recharts doesn't auto-arrange labels, so when ages are close together
  // (e.g. pension at 57 + withdrawals at 60 + SS at 67 + spouse-SS at 69)
  // the text labels collide horizontally. We:
  //   1. Collect every vertical line annotation with its color/style.
  //   2. Sort by age so adjacent labels are consecutive in the array.
  //   3. Cycle a `dy` offset across 4 stack rows (0, -14, -28, -42 px),
  //      so even neighbors get stacked vertically and never overlap.
  // The chart's top margin is sized to fit 4 rows of stacked labels.
  const verticalAnnotations = [
    ...incomeOnsets.map(o => ({
      age: o.age, label: o.label, kind: 'income',
      color: 'var(--accent-blue)', dashArray: '2 4', strokeWidth: 1.5,
    })),
    {
      age: lastRetireAge,
      label: `Withdrawals @${lastRetireAge}`,
      kind: 'withdraw',
      color: 'var(--text-secondary)',
      dashArray: '3 3',
      strokeWidth: 1.5,
    },
    ...(data.fi_hit_age != null && data.fi_hit_age >= data.inputs.current_age
      ? [{
          age: data.fi_hit_age,
          label: `FI @${data.fi_hit_age}`,
          kind: 'fi',
          color: 'var(--accent-green)',
          dashArray: '4 4',
          strokeWidth: 1.5,
        }]
      : []),
    // Depletion marker — red, prominent. Only present when the
    // simulation actually drives balance to zero within the horizon.
    // The most actionable single number on the chart: "you run out
    // here." If absent, the portfolio survives the full plan.
    ...(depletedAge != null
      ? [{
          age: depletedAge,
          label: `$0 @${depletedAge}`,
          kind: 'depleted',
          color: 'var(--accent-red)',
          dashArray: '4 2',
          strokeWidth: 2,
        }]
      : []),
  ]
    .sort((a, b) => a.age - b.age)
    .map((ann, i) => ({ ...ann, dy: -(i % 4) * 14 }))

  // FI tile shows the pension-adjusted target when a pension is active.
  // Both numbers stay reachable (the raw FI is still in data.fi_number)
  // but the headline reflects what you actually need to hit.
  const fiTileValue = hasFixedIncome ? data.effective_fi_number : data.fi_number
  const fiTileSubtitle = hasFixedIncome
    ? `${fmt(data.fi_number)} − ${[
        hasPension && `pension ${fmt(data.pension_at_start)}`,
        hasAnySS && `SS ${fmt(ssTotalAtStart)}`,
      ].filter(Boolean).join(' − ')}/yr`
    : `${(data.inputs.desired_annual_income / 1000).toFixed(0)}k/yr ÷ ${(data.inputs.withdrawal_rate * 100).toFixed(1)}%`

  return (
    <>
      {/* Headline stat tiles */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: 10,
        marginBottom: 16,
      }}>
        <StatTile
          label="Today's invested"
          value={fmt(data.current_assets)}
          // Surface excluded accounts inline — silent exclusion would
          // mislead. Lets the user audit what's actually being counted.
          subtitle={
            (data.excluded_count || 0) > 0
              ? `${fmt(data.excluded_total)} in ${data.excluded_count} account${data.excluded_count !== 1 ? 's' : ''} excluded`
              : 'across investment accounts'
          }
        />
        <StatTile
          label={hasFixedIncome
            ? `FI number (${[hasPension && 'pension', hasAnySS && 'SS']
                .filter(Boolean).join(' + ')})`
            : 'FI number'}
          value={fmt(fiTileValue)}
          subtitle={fiTileSubtitle}
        />
        <StatTile
          label="Projected at retirement"
          value={fmt(data.projected_balance)}
          // Use last_retirement_user_age — when household withdrawals
          // actually start, which differs from your retirement_age
          // when spouse retires later. accumulation_years is your
          // years until that moment.
          subtitle={lastRetireAge !== data.inputs.retirement_age
            ? `age ${lastRetireAge} (last to retire) · ${accumulationYears}y out`
            : `age ${data.inputs.retirement_age} · ${data.years_to_retirement}y out`}
          color="var(--accent-blue)"
        />
        {/* Survival tile — replaces the old "Surplus / Gap" tile.
            "Lasts until" is the most actionable answer the simulation
            gives, since it accounts for staged income onset and the
            stop-contributing-at-last-retirement rule. Falls back to a
            depletion-warning when balance hits zero within horizon. */}
        <StatTile
          label={onTrack ? 'Lasts through plan' : 'Depletes at age'}
          value={onTrack
            ? `age ${chartData[chartData.length - 1].age}+`
            : `${depletedAge}`}
          subtitle={
            onTrack
              ? data.fi_hit_age != null && data.fi_hit_age < data.inputs.retirement_age
                ? `FI reached at age ${data.fi_hit_age} (${data.inputs.retirement_age - data.fi_hit_age}y early) · ends at ${fmt(endBalance)}`
                : `simulation ends at ${fmt(endBalance)}`
              : `add ${fmt(data.monthly_contribution_to_close_gap)}/mo to close static gap`
          }
          color={gapColor}
          icon={onTrack ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
        />
      </div>

      {/* Pension-specific tiles + bridge-years caption — only when active */}
      {hasPension && (
        <>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 10,
            marginBottom: 16,
          }}>
            <StatTile
              label="Pension @ start"
              value={`${fmt(data.pension_at_start)}/yr`}
              // Real-terms model: pension at claim = today's-dollars
              // value the user entered (no pre-claim compounding). What
              // matters for sustainability is the post-claim erosion
              // pattern — surface nominal COLA + real (after-inflation)
              // so both perspectives are clear.
              subtitle={(() => {
                const nominal = data.inputs.pension_cola
                const real = (nominal - (data.inputs.inflation_rate || 0.025))
                const realPct = (real * 100).toFixed(1)
                const nominalPct = (nominal * 100).toFixed(1)
                const realLabel = real < 0
                  ? `${realPct}% real (eroded by inflation)`
                  : real === 0
                    ? '0% real (keeps pace)'
                    : `+${realPct}% real growth`
                const ageLabel = data.inputs.pension_holder_age !== data.inputs.current_age
                  ? `spouse retires at ${data.inputs.pension_start_age} (in ${
                      data.inputs.pension_start_age - data.inputs.pension_holder_age
                    }y)`
                  : `at age ${data.inputs.pension_start_age}`
                return `${ageLabel} · ${nominalPct}% nominal · ${realLabel}`
              })()}
              color="var(--accent-blue)"
            />
            <StatTile
              label="Pension lifetime value"
              value={fmt(data.pension_pv)}
              subtitle="present value of 30-yr stream"
              color="var(--accent-blue)"
            />
            {data.bridge_years > 0 && (
              <StatTile
                label="Bridge years"
                value={`${data.bridge_years} yr${data.bridge_years !== 1 ? 's' : ''}`}
                subtitle={`portfolio funds ${fmt(data.bridge_full_income_needed)} of full income before pension starts`}
                color="var(--accent-orange)"
                icon={<AlertCircle size={14} />}
              />
            )}
          </div>
        </>
      )}

      {/* Social Security tiles — render per active stream so each
          spouse's claim age and annual amount stay readable. When two
          streams are active we also surface a "household total" row. */}
      {hasSocialSecurity && (
        <SSStreamTiles
          label="SS · You"
          atStart={data.ss_at_start}
          pv={data.ss_pv}
          afterTax={data.after_tax_ss_income}
          startAge={data.inputs.ss_start_age}
          cola={data.inputs.ss_cola}
          today={data.inputs.ss_annual}
          ordinaryRate={data.inputs.tax_rate_ordinary}
          inflationRate={data.inputs.inflation_rate}
          showLabelSuffix={hasSocialSecurity2}
        />
      )}
      {hasSocialSecurity2 && (
        <SSStreamTiles
          label="SS · Spouse"
          atStart={data.ss2_at_start}
          pv={data.ss2_pv}
          afterTax={data.after_tax_ss2_income}
          startAge={data.inputs.ss2_start_age}
          cola={data.inputs.ss2_cola}
          today={data.inputs.ss2_annual}
          ordinaryRate={data.inputs.tax_rate_ordinary}
          inflationRate={data.inputs.inflation_rate}
          showLabelSuffix
        />
      )}
      {hasSocialSecurity && hasSocialSecurity2 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 10,
          marginBottom: 16,
        }}>
          <StatTile
            label="SS combined @ claim"
            value={`${fmt(ssTotalAtStart)}/yr`}
            subtitle="both streams stacked"
            color="var(--accent-blue)"
          />
          <StatTile
            label="SS combined lifetime"
            value={fmt(ssTotalPv)}
            subtitle="present value of both 30-yr streams"
            color="var(--accent-blue)"
          />
          <StatTile
            label="SS combined after-tax / yr"
            value={fmt(afterTaxSSTotal)}
            subtitle={`taxed at 85% × ${(data.inputs.tax_rate_ordinary * 100).toFixed(0)}%`}
            color="var(--accent-blue)"
          />
        </div>
      )}

      {/* SS delayed-claiming sweep — show lifetime tax + end balance
          across the standard claim ages (62/65/67/70). The actuarial
          adjustment is built in: 70% at 62, ~87% at 65, 100% at 67,
          124% at 70 (both streams adjusted in lockstep). The "best"
          strategy is whichever maximizes end balance net of lifetime
          tax — usually 67 or 70 for healthy life expectancy, but
          earlier claiming wins if longevity is questionable or you
          need the cash flow sooner. */}
      {data.ss_claim_sweep && (
        <div style={{
          marginBottom: 16,
          padding: '12px 14px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          borderRadius: 8,
          fontSize: 12,
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            marginBottom: 8,
          }}>
            SS claim-age comparison · current: age {data.ss_claim_sweep.current_claim_age}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '50px 1fr 1fr 1fr 70px 80px',
            gap: 8,
            fontSize: 11,
            color: 'var(--text-muted)',
            marginBottom: 4,
            paddingBottom: 4,
            borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.08))',
          }}>
            <div>Claim @</div>
            <div>SS combined /yr</div>
            <div>Lifetime tax</div>
            <div>End balance</div>
            <div title="Death age at which delaying becomes cumulatively positive (live past this → delaying wins; die before → earlier wins)">
              Break-even
            </div>
            <div style={{ textAlign: 'right' }}>vs current</div>
          </div>
          {(() => {
            const current = data.ss_claim_sweep.results.find(
              r => r.claim_age === data.ss_claim_sweep.current_claim_age
            )
            const baselineEnd = current ? current.end_balance : 0
            return data.ss_claim_sweep.results.map(row => {
              const delta = row.end_balance - baselineEnd
              const isCurrent = row.claim_age === data.ss_claim_sweep.current_claim_age
              const deltaColor = delta > 1000 ? 'var(--accent-green)'
                : delta < -1000 ? 'var(--accent-orange)'
                : 'var(--text-muted)'
              return (
                <div key={row.claim_age} style={{
                  display: 'grid',
                  gridTemplateColumns: '50px 1fr 1fr 1fr 70px 80px',
                  gap: 8,
                  padding: '6px 0',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  fontWeight: isCurrent ? 700 : 400,
                  borderBottom: '1px solid var(--border-color, rgba(255,255,255,0.04))',
                }}>
                  <div>
                    {row.claim_age}{isCurrent && (
                      <span style={{ color: 'var(--accent-blue)', fontSize: 10, marginLeft: 4 }}>
                        ✓
                      </span>
                    )}
                  </div>
                  <div>{fmt(row.adjusted_annual_ss_combined)}</div>
                  <div>{fmt(row.lifetime_tax)}</div>
                  <div>{fmt(row.end_balance)}</div>
                  <div style={{
                    color: row.break_even_age != null ? 'var(--accent-blue)' : 'var(--text-muted)',
                    fontWeight: 600,
                  }}>
                    {isCurrent ? '—' : (row.break_even_age != null ? `age ${row.break_even_age}` : '—')}
                  </div>
                  <div style={{ textAlign: 'right', color: deltaColor, fontWeight: 600 }}>
                    {isCurrent ? '—' : (delta >= 0 ? '+' : '') + fmt(delta)}
                  </div>
                </div>
              )
            })
          })()}
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
            Actuarial factors built in (62 = 70%, 65 = 87%, 67 = 100%, 70 = 124% of PIA). Both spouse streams adjust in lockstep. Larger end balance = more efficient claim age for your scenario.
            <strong style={{ color: 'var(--accent-blue)' }}> Break-even</strong> = death age where delaying becomes cumulatively positive (live past it → delaying wins; die before → earlier-claim wins). Pure SS-cumulative math, ignores portfolio side-effects.
          </div>
        </div>
      )}

      {/* Pre-59½ bridge warning — applies only when projection says you
          can retire before 60 AND tax-deferred is meaningful. The IRS
          10% early-withdrawal penalty makes 401(k) money mostly
          inaccessible during the bridge years; this tile tells the
          user honestly what's reachable. */}
      {data.bridge_pre_595 && (
        <div style={{
          marginBottom: 16,
          padding: '12px 14px',
          background: data.bridge_pre_595.covered
            ? 'rgba(52, 211, 153, 0.06)'
            : 'rgba(251, 146, 60, 0.08)',
          border: `1px solid ${
            data.bridge_pre_595.covered
              ? 'rgba(52, 211, 153, 0.3)'
              : 'rgba(251, 146, 60, 0.3)'
          }`,
          borderRadius: 8,
          fontSize: 13,
          color: 'var(--text-secondary)',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            color: data.bridge_pre_595.covered ? 'var(--accent-green)' : 'var(--accent-orange)',
            fontWeight: 600,
            fontSize: 13,
          }}>
            {data.bridge_pre_595.covered ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
            {data.bridge_pre_595.covered
              ? `Pre-59½ bridge IS covered`
              : `Pre-59½ bridge is short ${fmt(data.bridge_pre_595.shortfall)}`}
          </div>
          <div style={{ lineHeight: 1.6 }}>
            FI hits at age <strong>{data.bridge_pre_595.fi_hit_age}</strong>, but tax-deferred
            accounts ({fmt(data.bridge_pre_595.tax_deferred_locked)}) are locked until 59½ without
            a 10% early-withdrawal penalty. To bridge the {data.bridge_pre_595.years_to_595}-year
            gap to age 60, you'd need <strong>{fmt(data.bridge_pre_595.spending_needed)}</strong>{' '}
            in spending. Penalty-free sources during that window:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>
              {fmt(data.bridge_pre_595.total_covered)}
            </strong>{' '}
            ({fmt(data.bridge_pre_595.accessible_liquid)} taxable + Roth
            {data.bridge_pre_595.pension_contribution > 0
              && ` + ${fmt(data.bridge_pre_595.pension_contribution)} pension`}
            {data.bridge_pre_595.ss_contribution > 0
              && ` + ${fmt(data.bridge_pre_595.ss_contribution)} SS`}).
            {!data.bridge_pre_595.covered && (
              <span>
                {' '}Workarounds: <em>Rule of 55</em> (retire at 55 from current employer's plan
                only), <em>72(t) SEPP</em> (locks you into a fixed payment schedule for 5+ years),
                or a Roth conversion ladder. None of these are modeled here.
              </span>
            )}
          </div>
        </div>
      )}

      {/* After-tax stat tiles — show when taxes apply */}
      {data.weighted_withdrawal_tax_rate > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 10,
          marginBottom: 16,
        }}>
          {/* Headline now uses the SIMULATION-derived average across
              withdrawal years (more accurate than the legacy steady-
              state formula because it accounts for staged income onset,
              taxable-bridge strategy, RMDs, and phase spending). The
              range below shows volatility year-over-year so the user
              isn't surprised by a low-min year. */}
          <StatTile
            label="After-tax avg / yr"
            value={fmt(data.sim_after_tax_avg)}
            subtitle={`range ${fmt(data.sim_after_tax_min)} – ${fmt(data.sim_after_tax_max)} · per-year sim across ${data.year_by_year.filter(r => r.phase === 'withdrawing').length}y`}
            color="var(--accent-blue)"
          />
          {/* Bridge-window after-tax — separate tile because the
              taxable-first strategy makes the bridge years materially
              different from steady-state. Only shown when an SS stream
              creates a meaningful bridge (otherwise = avg). */}
          {data.sim_bridge_after_tax_avg > 0 && data.sim_bridge_after_tax_avg !== data.sim_after_tax_avg && (
            <StatTile
              label="After-tax (bridge yrs)"
              value={fmt(data.sim_bridge_after_tax_avg)}
              subtitle="avg until SS claim — shows benefit of taxable-first strategy"
              color="var(--accent-green)"
            />
          )}
          <StatTile
            label="After-tax FI number"
            value={fmt(data.after_tax_fi_number)}
            subtitle={`vs pre-tax ${fmt(data.fi_number)}`}
            color="var(--text-primary)"
          />
          <TaxExposureTile data={data} />
        </div>
      )}

      {/* Lifetime totals — surface only when something to show. RMDs
          and healthcare are 0 unless those features are active. */}
      {(data.total_taxes_paid > 0 || data.total_rmd_taken > 0 || data.total_healthcare_paid > 0 || data.total_ltc_paid > 0) && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 10,
          marginBottom: 16,
        }}>
          <StatTile
            label="Lifetime taxes"
            value={fmt(data.total_taxes_paid)}
            subtitle={
              data.total_state_tax > 0
                ? `${fmt(data.total_federal_tax)} fed + ${fmt(data.total_state_tax)} state`
                : 'federal only · across all withdrawal years'
            }
            color="var(--accent-orange)"
          />
          {data.total_rmd_taken > 0 && (
            <StatTile
              label="Lifetime RMDs"
              value={fmt(data.total_rmd_taken)}
              subtitle="forced tax-deferred draws starting at 73"
              color="var(--text-secondary)"
            />
          )}
          {data.total_healthcare_paid > 0 && (
            <StatTile
              label="Pre-Medicare healthcare"
              value={fmt(data.total_healthcare_paid)}
              subtitle="total ACA-bridge spending until both 65"
              color="var(--accent-orange)"
            />
          )}
          {data.total_ltc_paid > 0 && (
            <StatTile
              label="Lifetime LTC"
              value={fmt(data.total_ltc_paid)}
              subtitle={`${data.inputs.ltc_duration_years}y starting at age ${data.inputs.ltc_start_age}`}
              color="var(--accent-red)"
              icon={<AlertCircle size={14} />}
            />
          )}
        </div>
      )}
      {/* Monte Carlo probability tile — shown only when MC ran. Surfaces
          the headline "probability of success" + key percentile balances
          at the planning horizon. The deterministic projection above is
          still shown (the median path); MC adds the distribution context. */}
      {data.monte_carlo && data.monte_carlo.n_runs > 0 && (() => {
        const mc = data.monte_carlo
        const successPct = Math.round(mc.success_probability * 100)
        const successColor = successPct >= 90
          ? 'var(--accent-green)'
          : successPct >= 75
            ? 'var(--accent-blue)'
            : successPct >= 60
              ? 'var(--accent-orange)'
              : 'var(--accent-red)'
        const lastRow = mc.year_by_year_pct[mc.year_by_year_pct.length - 1]
        return (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 10,
            marginBottom: 16,
          }}>
            <StatTile
              label={`Probability of success (${mc.n_runs} runs)`}
              value={`${successPct}%`}
              subtitle={
                successPct >= 90
                  ? 'plan survives nearly every simulated path'
                  : successPct >= 75
                    ? 'comfortably likely to succeed'
                    : successPct >= 60
                      ? 'meaningful risk — consider stress-testing'
                      : 'high risk of running out — adjust inputs'
              }
              color={successColor}
              icon={successPct >= 90 ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
            />
            <StatTile
              label="Median end balance"
              value={fmt(mc.median_end_balance)}
              subtitle={`at age ${lastRow ? lastRow.age : '—'} (50th pct)`}
              color="var(--accent-blue)"
            />
            {lastRow && (
              <StatTile
                label="Range at end (10–90 pct)"
                value={`${fmt(lastRow.balance_p10)} – ${fmt(lastRow.balance_p90)}`}
                subtitle="80% of simulated futures land in this range"
                color="var(--text-secondary)"
              />
            )}
            {mc.depletion_ages.length > 0 && (
              <StatTile
                label="Depletion (when it happens)"
                value={(() => {
                  const sorted = [...mc.depletion_ages].sort((a, b) => a - b)
                  const median = sorted[Math.floor(sorted.length / 2)]
                  return `age ${median}`
                })()}
                subtitle={`${mc.depletion_ages.length}/${mc.n_runs} paths deplete · median age shown`}
                color="var(--accent-red)"
                icon={<AlertCircle size={14} />}
              />
            )}
          </div>
        )
      })()}

      {/* Survivor stress test indicator — show prominently when active so
          the user knows the projection above factors in the loss of a
          spouse at the specified age. */}
      {data.inputs.survivor_at_user_age != null && (
        <div style={{
          marginBottom: 16,
          padding: '10px 14px',
          background: 'rgba(168, 85, 247, 0.08)',
          border: '1px solid rgba(168, 85, 247, 0.3)',
          borderRadius: 8,
          fontSize: 12,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}>
          <span style={{
            display: 'inline-block', padding: '3px 8px',
            background: 'rgba(168, 85, 247, 0.18)',
            color: '#a855f7',
            borderRadius: 4, fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: 0.5,
          }}>
            Survivor stress
          </span>
          <span>
            Modeling loss of one spouse at age <strong>{data.inputs.survivor_at_user_age}</strong>:
            smaller SS terminates,
            pension reduces to {Math.round(data.inputs.pension_survivor_pct * 100)}% of original,
            filing flips MFJ → Single (brackets shrink, deduction halves).
          </span>
        </div>
      )}

      {/* Real vs Nominal — two stacked charts.
          Real (today's dollars) is what we use for planning since
          the FI calculation, the 4% rule, and the desired_income
          input are all defined in real terms. Nominal (future
          dollars) shows what your brokerage/SS/pension statements
          will actually say at each age, including the inflation
          tailwind on balance and the spending requirement growing
          to maintain the same real purchasing power. Same underlying
          simulation, just two views.

          Defining renderChart here so we can reuse the entire chart
          block (200+ lines of Recharts JSX) without duplication. The
          function closes over data/lastRetireAge/verticalAnnotations/
          incomeOnsets/depletedAge — everything except the chartData
          input and the mode flag. */}
      {(() => {
        const nominalChartData = toNominal(chartData, data.inputs.inflation_rate || 0.025)
        const renderChart = (rows, mode) => {
          const isNominal = mode === 'nominal'
          const yLabel = isNominal ? 'Nominal $ (future)' : 'Real $ (today)'
          return (
        <div style={{
          marginBottom: 24,
          // Visual separator between the two charts: the nominal chart
          // gets a top border + extra top padding so the eye doesn't
          // confuse it with a continuation of the real chart's legend.
          ...(isNominal ? {
            paddingTop: 20,
            borderTop: '1px solid rgba(255,255,255,0.08)',
            marginTop: 16,
          } : {}),
        }}>
          {/* Section header — badge + title + subtitle. Bigger and
              more prominent than the original inline label so the
              two charts read as distinct views. */}
          <div style={{ marginBottom: 10 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              marginBottom: 4,
            }}>
              <span style={{
                display: 'inline-block',
                padding: '4px 10px',
                background: isNominal
                  ? 'rgba(168, 85, 247, 0.15)'
                  : 'rgba(96, 165, 250, 0.15)',
                color: isNominal ? '#a855f7' : 'var(--accent-blue)',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 0.6,
              }}>
                {isNominal ? 'Nominal' : 'Real'}
              </span>
              <span style={{
                fontSize: 17,
                fontWeight: 600,
                color: 'var(--text-primary)',
                letterSpacing: 0.1,
              }}>
                {isNominal ? 'Future dollars' : 'Today\'s dollars'}
              </span>
            </div>
            <div style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              lineHeight: 1.45,
              marginLeft: 2,
            }}>
              {isNominal
                ? 'What your brokerage / pension / SS statements will literally say at each age. Inflation grows balances, spending requirements, and SS — pension stays nominally flat.'
                : 'Purchasing power held constant. This is the financial-independence / planning view — the FI number, 4% rule, and your $100k spending target are all defined here.'}
            </div>
          </div>
        <ResponsiveContainer width="100%" height={380}>
          <ComposedChart data={rows} margin={{ top: 70, right: 30, left: 5, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="age"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              label={{ value: 'Age', position: 'insideBottom', offset: -5, fill: 'var(--text-muted)', fontSize: 11 }}
            />
            {/* Primary Y axis: portfolio balance (millions). */}
            <YAxis
              yAxisId="balance"
              tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
              tickFormatter={v => `$${(v / 1_000_000).toFixed(1)}M`}
            />
            {/* Secondary Y axis: yearly portfolio draw (thousands).
                Right-side scale lets the draw bars show real dollar
                magnitude without dwarfing the balance area or vice versa. */}
            <YAxis
              yAxisId="draw"
              orientation="right"
              tick={{ fill: 'var(--accent-orange)', fontSize: 10 }}
              tickFormatter={v => v === 0 ? '0' : `$${(v / 1000).toFixed(0)}k`}
              label={{
                value: 'Portfolio draw / yr',
                angle: 90,
                position: 'insideRight',
                fill: 'var(--accent-orange)',
                fontSize: 10,
                offset: 10,
              }}
            />
            <Tooltip
              contentStyle={{ background: '#1e2130', border: '1px solid #2a2d3a', borderRadius: 8 }}
              content={<ChartTooltip desiredIncome={data.inputs.desired_annual_income} />}
            />
            {/* Subtle background shading for the withdrawal phase so
                the eye instantly sees where contributions stop and
                drawdown begins. */}
            {chartData.length > 1 && (
              <ReferenceArea
                yAxisId="balance"
                x1={lastRetireAge}
                x2={chartData[chartData.length - 1].age}
                fill="var(--accent-orange)"
                fillOpacity={0.04}
                stroke="none"
              />
            )}
            {/* All vertical reference lines (withdrawals-begin,
                income onsets, FI-hit). Sorted by age and assigned
                a cyclic dy stack offset so labels don't collide
                horizontally. See verticalAnnotations construction
                above for the staggering logic. */}
            {verticalAnnotations.map((ann, i) => (
              <ReferenceLine
                yAxisId="balance"
                key={`vann-${i}`}
                x={ann.age}
                stroke={ann.color}
                strokeDasharray={ann.dashArray}
                strokeWidth={ann.strokeWidth}
                label={{
                  value: ann.label,
                  fill: ann.color,
                  fontSize: 10,
                  fontWeight: 500,
                  position: 'top',
                  dy: ann.dy,
                }}
              />
            ))}
            {/* Horizontal target line — REAL chart only. The FI number
                is fundamentally a real concept (constant purchasing
                power); in nominal terms the target slopes upward year
                over year, so a single horizontal line is misleading.
                The vertical FI-hit-age line still shows on both charts. */}
            {!isNominal && (
              <ReferenceLine
                yAxisId="balance"
                y={data.effective_fi_number}
                stroke="var(--accent-green)"
                strokeDasharray="4 4"
                label={{
                  value: `Retirement target: ${fmt(data.effective_fi_number)}`,
                  fill: 'var(--accent-green)',
                  fontSize: 11,
                  position: 'insideTopLeft',
                }}
              />
            )}
            {/* Portfolio balance area — main blue curve. Spans both
                phases; the reference area above color-codes the
                withdrawal portion. */}
            <Area
              yAxisId="balance"
              type="monotone"
              dataKey="balance"
              stroke="var(--accent-blue)"
              strokeWidth={2}
              fill="var(--accent-blue)"
              fillOpacity={0.15}
              name="Portfolio balance"
            />
            {/* Active fixed-income bars — green. Visible in BOTH
                phases so the user can see exactly when each spouse's
                pension/SS first pays. During accumulation these are
                informational (the household is receiving the income
                but it's not flowing into the portfolio); during
                withdrawal they directly offset the portfolio draw. */}
            <Bar
              yAxisId="draw"
              dataKey="income_streams"
              fill="var(--accent-green)"
              fillOpacity={0.45}
              name="Active fixed income"
              barSize={6}
            />
            {/* Stacked yearly portfolio draw bars by tax bucket.
                Order matters: taxable on the bottom (drawn first
                during bridge years to capture 0% LTCG bracket),
                tax-deferred on top of that (kicks in once taxable
                runs out, ordinary-income tax rate), Roth at the
                very top (last resort, tax-free). Visually: bridge
                years should be all yellow (taxable), shifting to
                orange (tax-deferred) once taxable depletes, then
                brown (Roth) only if you live long enough. */}
            <Bar
              yAxisId="draw"
              dataKey="draw_taxable"
              stackId="draw"
              fill="#fbbf24"
              fillOpacity={0.7}
              name="Draw: taxable"
              barSize={6}
            />
            <Bar
              yAxisId="draw"
              dataKey="draw_tax_deferred"
              stackId="draw"
              fill="var(--accent-orange)"
              fillOpacity={0.7}
              name="Draw: tax-deferred"
              barSize={6}
            />
            <Bar
              yAxisId="draw"
              dataKey="draw_roth"
              stackId="draw"
              fill="#92400e"
              fillOpacity={0.7}
              name="Draw: Roth"
              barSize={6}
            />
          </ComposedChart>
        </ResponsiveContainer>

        {/* Inline legend explaining the chart marks. Recharts' built-in
            <Legend> doesn't capture ReferenceLine annotations, so this
            is hand-rolled to make the green markings as readable as
            the blue projection curve. */}
        <div style={{
          display: 'flex',
          gap: 18,
          flexWrap: 'wrap',
          marginTop: 4,
          fontSize: 11,
          color: 'var(--text-muted)',
        }}>
          <LegendItem
            color="var(--accent-blue)"
            label="Portfolio balance"
            description="compound growth on investable assets (left axis)"
          />
          <LegendItem
            color="var(--accent-green)"
            label="Active fixed income / yr"
            description="pension + SS flowing in (right axis) — visible in both phases"
          />
          <LegendItem
            color="#fbbf24"
            label="Draw: taxable"
            description="drawn first — LTCG rate (often 0% in bridge years)"
          />
          <LegendItem
            color="var(--accent-orange)"
            label="Draw: tax-deferred"
            description="drawn second — ordinary income tax + 10% if pre-59½"
          />
          <LegendItem
            color="#92400e"
            label="Draw: Roth"
            description="drawn last — tax-free, preserves for heirs / late retirement"
          />
          <LegendItem
            color="var(--accent-orange)"
            faded
            label="Withdrawal phase"
            description="orange-shaded zone after last spouse retires"
          />
          <LegendItem
            color="var(--accent-green)"
            dashed
            label="Retirement target"
            description={
              data.effective_fi_number !== data.fi_number
                ? `${fmt(data.effective_fi_number)} portfolio (after pension/SS reduce ${fmt(data.fi_number)} gross target)`
                : `${fmt(data.fi_number)} = retirement income ÷ withdrawal rate`
            }
          />
          {data.fi_hit_age != null && (
            <LegendItem
              color="var(--accent-green)"
              dashed
              vertical
              label={`FI @ ${data.fi_hit_age}`}
              description="year projected balance crosses the target"
            />
          )}
          <LegendItem
            color="var(--text-secondary)"
            dashed
            vertical
            label={`Withdrawals @ ${lastRetireAge}`}
            description="last spouse retires; contributions stop, conservative rate kicks in"
          />
          {incomeOnsets.length > 0 && (
            <LegendItem
              color="var(--accent-blue)"
              dashed
              vertical
              label="Pension / SS onsets"
              description="each stream marked at its claim age (e.g. SS·You @67)"
            />
          )}
          {depletedAge != null && (
            <LegendItem
              color="var(--accent-red)"
              dashed
              vertical
              label={`$0 @ ${depletedAge}`}
              description="age at which portfolio is fully drawn down"
            />
          )}
        </div>
        </div>
          )
        }
        // Fan chart for Monte Carlo: if MC results are present,
        // render a stacked fan showing 10th/25th/50th/75th/90th
        // percentile balance bands across all simulated paths. Lets
        // the user see distribution rather than single-point estimates.
        const mcRows = data.monte_carlo?.year_by_year_pct
        const renderFanChart = () => {
          if (!mcRows || mcRows.length === 0) return null
          // Recharts can render an Area as a "ranged" band when
          // dataKey returns a [low, high] pair. We compute two bands:
          // the wide 10-90 (lighter) and the narrow 25-75 (darker).
          const fanData = [
            { year: 0, age: data.inputs.current_age,
              band_10_90: [data.current_assets, data.current_assets],
              band_25_75: [data.current_assets, data.current_assets],
              p50: data.current_assets },
            ...mcRows.map(r => ({
              year: r.year, age: r.age,
              band_10_90: [r.balance_p10, r.balance_p90],
              band_25_75: [r.balance_p25, r.balance_p75],
              p50: r.balance_p50,
            })),
          ]
          return (
            <div style={{
              marginBottom: 24, paddingTop: 20,
              borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 16,
            }}>
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{
                    display: 'inline-block', padding: '4px 10px',
                    background: 'rgba(52,211,153,0.15)', color: 'var(--accent-green)',
                    borderRadius: 4, fontSize: 11, fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: 0.6,
                  }}>
                    Monte Carlo
                  </span>
                  <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-primary)' }}>
                    Probability fan ({data.monte_carlo.n_runs} runs)
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                  Each year's band shows where balances fall across {data.monte_carlo.n_runs}{' '}
                  random return paths. Inner band = 25th–75th percentile (half of simulated
                  futures). Outer band = 10th–90th. Solid line = median outcome.
                </div>
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={fanData} margin={{ top: 30, right: 30, left: 5, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="age" tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                    label={{ value: 'Age', position: 'insideBottom', offset: -5,
                             fill: 'var(--text-muted)', fontSize: 11 }} />
                  <YAxis
                    tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                    tickFormatter={v => `$${(v / 1_000_000).toFixed(1)}M`}
                  />
                  <Tooltip
                    contentStyle={{ background: '#1e2130', border: '1px solid #2a2d3a', borderRadius: 8 }}
                    formatter={(v) => Array.isArray(v) ? `${fmt(v[0])} – ${fmt(v[1])}` : fmt(v)}
                    labelFormatter={(age) => `Age ${age}`}
                  />
                  <Area type="monotone" dataKey="band_10_90"
                    fill="var(--accent-green)" fillOpacity={0.10}
                    stroke="none" name="10–90 pct" />
                  <Area type="monotone" dataKey="band_25_75"
                    fill="var(--accent-green)" fillOpacity={0.20}
                    stroke="none" name="25–75 pct" />
                  <Line type="monotone" dataKey="p50"
                    stroke="var(--accent-green)" strokeWidth={2}
                    dot={false} name="Median (50 pct)" />
                  <ReferenceLine x={lastRetireAge}
                    stroke="var(--text-secondary)" strokeDasharray="3 3"
                    strokeWidth={1.5}
                    label={{ value: `Withdrawals @${lastRetireAge}`,
                             fill: 'var(--text-secondary)', fontSize: 11,
                             position: 'top' }} />
                </ComposedChart>
              </ResponsiveContainer>
              <div style={{
                marginTop: 4, fontSize: 11, color: 'var(--text-muted)',
                display: 'flex', gap: 18, flexWrap: 'wrap',
              }}>
                <LegendItem color="var(--accent-green)" label="Median balance"
                  description="50th percentile path" />
                <LegendItem color="var(--accent-green)" faded label="25–75 pct band"
                  description="middle 50% of simulated futures" />
                <LegendItem color="var(--accent-green)" faded label="10–90 pct band"
                  description="80% of simulated futures fall here" />
              </div>
            </div>
          )
        }

        return (
          <>
            {renderChart(chartData, 'real')}
            {renderChart(nominalChartData, 'nominal')}
            {renderFanChart()}
          </>
        )
      })()}

      {/* Sensitivity at three return rates */}
      <div>
        <div style={{
          fontSize: 12, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8,
        }}>
          Sensitivity
        </div>
        <div className="table-wrapper">
          <table style={{ fontSize: 13 }}>
            <thead>
              <tr>
                <th>Return rate</th>
                <th style={{ textAlign: 'right' }}>Projected balance</th>
                <th style={{ textAlign: 'right' }}>Sustainable income</th>
                <th style={{ textAlign: 'right' }}>vs FI number</th>
              </tr>
            </thead>
            <tbody>
              {data.sensitivity.map(s => {
                const surplus = s.gap >= 0
                return (
                  <tr key={s.return_rate}>
                    <td>{(s.return_rate * 100).toFixed(0)}%</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(s.projected_balance)}
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                      {fmt(s.sustainable_income)}/yr
                    </td>
                    <td style={{
                      textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                      color: surplus ? 'var(--accent-green)' : 'var(--accent-red)',
                    }}>
                      {surplus ? '+' : ''}{fmt(s.gap)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Disclosure: assumptions + caveats */}
      <div style={{
        marginTop: 14, padding: '10px 12px',
        background: 'rgba(96,165,250,0.06)',
        border: '1px solid rgba(96,165,250,0.2)',
        borderRadius: 8,
        fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5,
      }}>
        <strong style={{ color: 'var(--text-primary)' }}>What this assumes:</strong>{' '}
        Real (inflation-adjusted) returns, end-of-year contributions,
        constant contribution rate. Two-phase simulation: contributions
        run from today until <em>whichever spouse retires last</em>, then
        portfolio enters drawdown. Returns also switch at that boundary —
        the working rate (default 6% real, growth-oriented) gives way to
        the retirement rate (default 1.5% real, CD/bond capital preservation). Each year of drawdown, active income
        streams (pension + each SS, COLA-adjusted) are subtracted from
        desired income, and the portfolio funds the remainder. Streams
        activate when the holder's age reaches their start age.
        Investable assets = sum of investment-type accounts only —
        checking, savings, and home equity are excluded since they don't
        grow at market rates and you don't withdraw from them at 4%/yr.
        Auto-detected contribution misses 401(k) payroll deductions
        (those don't traverse a bank Plaid sees) so it's a floor — enter
        the real number for an accurate projection.
        Pension/SS annuals are in TODAY'S dollars at claim age (you enter
        what the stream pays in today's purchasing-power terms). After claim,
        the COLA you enter is treated as NOMINAL — the simulator subtracts
        your inflation rate to get REAL growth. Examples: SS at 2.5% nominal
        COLA + 2.5% inflation = 0% real (just keeps pace). Pension at 0%
        nominal COLA = -2.5% real (eroded by inflation each year).
        Lifetime PV assumes a 30-year payout starting at the stream start age,
        discounted at the chosen real return rate. Survivor benefits and
        lump-sum options are not modeled.
        After-tax math: per-bucket draw simulation, year by year. Withdrawal
        order is taxable → tax-deferred → Roth (FIRE-standard for tax efficiency).
        Taxable draws taxed at LTCG; tax-deferred at ordinary income (+10% IRS
        penalty if pulled before age 60); Roth tax-free. Accumulation
        contribution flows entirely into tax-deferred. Hover any year on the
        chart for the bucket-by-bucket draw breakdown.
        <br/><br/>
        <strong style={{ color: 'var(--text-primary)' }}>New in v3:</strong>{' '}
        Pre-Medicare healthcare bridge (added to spending while either spouse {'<'} 65),
        tapered contribution (drops to "Contrib after 1st retire" once one spouse retires),
        spending phases (go-go / slow-go / no-go multipliers around the user's
        thresholds), RMDs (forced tax-deferred draws starting at 73 using the
        IRS Uniform Lifetime Table; excess shifts to taxable bucket).
        <br/><br/>
        Doesn't model: MI's partial public-pension exemption, per-share
        cost-basis tracking, 0% LTCG bracket optimization, 457-no-penalty
        carve-out, Roth conversions, sequence-of-returns risk, survivor
        benefits, or surplus income reinvestment when fixed-income exceeds
        desired (surplus stays in portfolio compounding).
      </div>
    </>
  )
}


/**
 * Custom chart tooltip — shows balance plus phase-specific context:
 * during accumulation, just balance; during withdrawal, also the
 * income-stream sum and how much the portfolio had to cover this year.
 * Recharts' default formatter is just one number; this gives the user
 * the staged-income story at every age.
 */
function ChartTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null
  const row = payload[0].payload
  if (!row) return null
  const isAccum = row.phase === 'accumulating'
  return (
    <div style={{
      background: '#1e2130',
      border: '1px solid #2a2d3a',
      borderRadius: 8,
      padding: '8px 10px',
      fontSize: 12,
      color: 'var(--text-primary)',
      minWidth: 180,
    }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        Age {row.age}{' '}
        <span style={{
          fontWeight: 400,
          fontSize: 10,
          color: isAccum ? 'var(--accent-green)' : 'var(--accent-orange)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginLeft: 4,
        }}>
          {isAccum ? '· accumulating' : '· withdrawing'}
        </span>
      </div>
      <div style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--accent-blue)' }}>
        Balance: {fmt(row.balance)}
      </div>
      {row.income_streams > 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--accent-green)' }}>
          Fixed income: {fmt(row.income_streams)}/yr
          {isAccum && (
            <span style={{ color: 'var(--text-muted)' }}> · informational</span>
          )}
        </div>
      )}
      {!isAccum && row.portfolio_draw > 0 && (
        <>
          <div style={{ fontSize: 11, color: 'var(--accent-orange)', marginTop: 2 }}>
            Portfolio draw: {fmt(row.portfolio_draw)}/yr
          </div>
          {/* Per-bucket breakdown — only show non-zero buckets so the
              line doesn't get cluttered when the strategy is single-source. */}
          {row.draw_taxable > 0 && (
            <div style={{ fontSize: 10, color: '#fbbf24', marginLeft: 10 }}>
              · Taxable: {fmt(row.draw_taxable)} (LTCG)
            </div>
          )}
          {row.draw_tax_deferred > 0 && (
            <div style={{ fontSize: 10, color: 'var(--accent-orange)', marginLeft: 10 }}>
              · Tax-deferred: {fmt(row.draw_tax_deferred)}
              {row.early_withdrawal_penalty > 0 && (
                <span style={{ color: 'var(--accent-red)' }}>
                  {' '}+ {fmt(row.early_withdrawal_penalty)} penalty
                </span>
              )}
            </div>
          )}
          {row.draw_roth > 0 && (
            <div style={{ fontSize: 10, color: '#92400e', marginLeft: 10 }}>
              · Roth: {fmt(row.draw_roth)} (tax-free)
            </div>
          )}
        </>
      )}
      {!isAccum && row.after_tax_income > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
          After-tax income: {fmt(row.after_tax_income)}/yr
        </div>
      )}
      {!isAccum && row.healthcare_cost > 0 && (
        <div style={{ fontSize: 10, color: 'var(--accent-orange)', marginTop: 2 }}>
          + Healthcare bridge: {fmt(row.healthcare_cost)}/yr
        </div>
      )}
      {!isAccum && row.ltc_cost > 0 && (
        <div style={{ fontSize: 10, color: 'var(--accent-red)', marginTop: 2 }}>
          + LTC: {fmt(row.ltc_cost)}/yr
        </div>
      )}
      {!isAccum && row.tax_paid > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          Tax: {fmt(row.tax_paid)}{row.tax_state > 0 ? ` (incl. ${fmt(row.tax_state)} state)` : ''}
        </div>
      )}
      {!isAccum && row.filing_status === 'single' && (
        <div style={{ fontSize: 10, color: '#a855f7', marginTop: 2 }}>
          Filing: Single (post-survivor)
        </div>
      )}
      {!isAccum && row.rmd_required > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          RMD required: {fmt(row.rmd_required)}/yr
        </div>
      )}
      {!isAccum && row.effective_spending > 0 && row.effective_spending !== row.income_streams + row.portfolio_draw && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          Spending target: {fmt(row.effective_spending)}/yr
        </div>
      )}
      {row.income_shortfall > 0 && (
        <div style={{ fontSize: 11, color: 'var(--accent-red)', marginTop: 2 }}>
          Income shortfall: {fmt(row.income_shortfall)}/yr (portfolio empty)
        </div>
      )}
    </div>
  )
}


/**
 * Per-stream Social Security tile group. Renders the same three tiles
 * (claim-age value, lifetime PV, after-tax) but parameterized so we can
 * call it twice — once per spouse — when both streams are active.
 *
 * showLabelSuffix toggles the " · You" / " · Spouse" suffix on the tile
 * labels: redundant when only one stream is active, helpful for
 * disambiguation when both are.
 */
function SSStreamTiles({
  label, atStart, pv, afterTax, startAge, cola, today, ordinaryRate,
  showLabelSuffix, inflationRate = 0.025,
}) {
  // Strip the " · You" / " · Spouse" suffix when there's only one stream
  // — the label "SS @ claim" is clearer than "SS · You @ claim" if
  // there's no peer stream to disambiguate against.
  const baseLabel = showLabelSuffix ? label : 'SS'
  // Real cola = nominal - inflation. Surface both so the user can see
  // why claim-age value equals today's value (in real terms) and how
  // SS will behave post-claim.
  const realCola = cola - inflationRate
  const realPct = (realCola * 100).toFixed(1)
  const nominalPct = (cola * 100).toFixed(1)
  const realLabel = realCola < 0
    ? `${realPct}% real (eroded)`
    : realCola === 0
      ? '0% real (keeps pace)'
      : `+${realPct}% real growth`
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
      gap: 10,
      marginBottom: 16,
    }}>
      <StatTile
        label={`${baseLabel} @ claim`}
        value={`${fmt(atStart)}/yr`}
        subtitle={`at age ${startAge} · ${nominalPct}% nominal · ${realLabel}`}
        color="var(--accent-blue)"
      />
      <StatTile
        label={`${baseLabel} lifetime value`}
        value={fmt(pv)}
        subtitle="present value of 30-yr stream"
        color="var(--accent-blue)"
      />
      <StatTile
        label={`${baseLabel} after-tax / yr`}
        value={fmt(afterTax)}
        subtitle={`taxed at 85% × ${(ordinaryRate * 100).toFixed(0)}%`}
        color="var(--accent-blue)"
      />
    </div>
  )
}


function StatTile({ label, value, subtitle, color, icon }) {
  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 8,
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        {icon}
        {label}
      </div>
      <div style={{
        fontSize: 20, fontWeight: 700,
        color: color || 'var(--text-primary)',
        fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
      }}>
        {value}
      </div>
      {subtitle && (
        <div style={{
          fontSize: 11, color: 'var(--text-muted)',
          marginTop: 4, lineHeight: 1.4,
        }}>
          {subtitle}
        </div>
      )}
    </div>
  )
}


/**
 * One row in the inline chart legend. Renders a small swatch (solid bar
 * for filled areas, short dashed line for ReferenceLine annotations,
 * vertical dashed line for the FI-hit-age marker) followed by a bold
 * label and a muted description.
 */
function LegendItem({ color, label, description, dashed = false, vertical = false, faded = false }) {
  let swatch
  if (faded) {
    // Soft fill block — represents ReferenceArea background shading.
    swatch = (
      <span style={{
        display: 'inline-block', width: 18, height: 12, marginRight: 6,
        background: color, opacity: 0.18,
        borderRadius: 2,
      }} />
    )
  } else if (dashed && vertical) {
    // Tiny vertical dashed bar — represents ReferenceLine x={...}
    swatch = (
      <span style={{
        display: 'inline-block', width: 2, height: 14, marginRight: 6,
        background: `repeating-linear-gradient(0deg, ${color} 0 3px, transparent 3px 6px)`,
      }} />
    )
  } else if (dashed) {
    // Horizontal dashed bar — ReferenceLine y={...}
    swatch = (
      <span style={{
        display: 'inline-block', width: 18, height: 2, marginRight: 6,
        background: `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 8px)`,
      }} />
    )
  } else {
    // Solid bar — Area / Line / Bar series
    swatch = (
      <span style={{
        display: 'inline-block', width: 18, height: 4, marginRight: 6,
        background: color, borderRadius: 1, opacity: 0.85,
      }} />
    )
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
      {swatch}
      <span style={{ color: 'var(--text-secondary)', fontWeight: 500, marginRight: 4 }}>
        {label}
      </span>
      <span style={{ color: 'var(--text-muted)' }}>· {description}</span>
    </span>
  )
}


/**
 * Section wrapper — gives the form visual structure with a bold title +
 * muted subtitle, and a divider between sections. Replaces the previous
 * flat field-grid layout where every input was the same visual weight
 * with no grouping cue.
 */
function Section({ title, subtitle, children }) {
  return (
    <div style={{
      marginBottom: 16,
      paddingTop: 14,
      paddingBottom: 4,
      borderTop: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{
          fontSize: 13, fontWeight: 600,
          color: 'var(--text-primary)',
          letterSpacing: 0.2,
          marginBottom: 2,
        }}>
          {title}
        </div>
        {subtitle && (
          <div style={{
            fontSize: 11.5, color: 'var(--text-muted)',
            lineHeight: 1.4,
          }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}


/**
 * Standard field grid used inside each section. Centralizing the grid
 * config means changing the field min-width or gap doesn't require
 * editing every section block.
 */
function FieldGrid({ children }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      gap: 10,
    }}>
      {children}
    </div>
  )
}


/**
 * Sub-header inside a section that names whose data the row below
 * belongs to (e.g., "You · 49" or "Spouse · 47"). Used in the Social
 * Security section where each spouse gets their own row of inputs and
 * the visual grouping needs to read at a glance.
 *
 * Optional onRemove turns this into a removable row (renders an "×"
 * button on the right). Used to collapse the spouse SS row.
 */
function PersonHeader({ label, age, onRemove, removeTitle }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 6,
      marginBottom: 6,
    }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
        fontWeight: 600,
      }}>
        {label}{age !== '' && age !== undefined ? ` · ${age}` : ''}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title={removeTitle || 'Remove'}
          style={{
            padding: '2px 8px',
            fontSize: 11,
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.1)',
            color: 'var(--text-muted)',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          × Remove
        </button>
      )}
    </div>
  )
}


function Field({ label, hint, help, children }) {
  // The label + optional hint sit on a single line. We pin overflow so a
  // long label can never push the hint (or worse, part of the label) onto
  // a second line and shove the input down — that's what the original
  // bug looked like with "ANNUAL CONTRIBUTION $" wrapping.
  // `help` adds a "?" icon with a click-toggleable popover (HelpPopover).
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4,
        display: 'flex', alignItems: 'center', gap: 4,
        whiteSpace: 'nowrap', overflow: 'hidden',
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </span>
        {help && <HelpPopover text={help} />}
        {hint && (
          <span style={{
            color: 'var(--accent-blue)', textTransform: 'none', fontSize: 10,
            flexShrink: 0,   // never let the hint be squeezed off
          }}>
            · {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}


/**
 * HelpPopover — click the ? to toggle a small popover with the help
 * text. Replaces the prior `title="..."` hover tooltip which:
 *   1. Only appeared after a 1-2s OS-level hover delay (poor UX),
 *   2. Didn't trigger at all on click or on touch devices,
 *   3. Got clipped by the parent's `overflow: hidden` if shown.
 *
 * Uses position:fixed coordinates derived from the button's bounding
 * rect so the popover escapes the parent's overflow clip and floats
 * above other UI. Closes on outside click or Escape.
 */
function HelpPopover({ text }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      // Stay open while clicks land on the popover or its trigger.
      if (e.target.closest?.('[data-help-popover]')) return
      setOpen(false)
    }
    const keyHandler = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('click', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('click', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [open])

  const toggle = (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      // Anchor below the icon, clamped so it doesn't overflow viewport.
      const POPOVER_W = 340
      const margin = 8
      const left = Math.min(
        rect.left,
        window.innerWidth - POPOVER_W - margin
      )
      setPos({ top: rect.bottom + 4, left: Math.max(margin, left) })
    }
    setOpen(o => !o)
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title={text}  // fallback for screen readers + native hover
        data-help-popover
        aria-label="Help"
        style={{
          flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14, borderRadius: '50%',
          fontSize: 9, fontWeight: 700,
          background: open ? 'var(--accent-blue)' : 'rgba(96, 165, 250, 0.2)',
          color: open ? '#0d0e14' : 'var(--accent-blue)',
          border: 'none', padding: 0,
          cursor: 'pointer',
          textTransform: 'none',
          fontFamily: 'inherit',
        }}
      >
        ?
      </button>
      {open && (
        <div
          data-help-popover
          style={{
            position: 'fixed',
            top: pos.top, left: pos.left,
            width: 340,
            padding: '10px 12px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
            zIndex: 1000,
            fontSize: 12, lineHeight: 1.5,
            color: 'var(--text-primary)',
            textTransform: 'none',
            letterSpacing: 0,
            fontWeight: 400,
            whiteSpace: 'normal',
          }}
        >
          {text}
        </div>
      )}
    </>
  )
}


/**
 * Inline callout shown directly under the Retirement-income input.
 * Compact info card: title + status pill, headline metric, visual
 * progress bar showing current-vs-max, supporting context, apply CTA.
 *
 * Theming: uses the app's CSS variables so it adapts to dark mode.
 * Colors are green (headroom), yellow (tight), orange (over budget) —
 * deliberately NOT red, which reads as harsh-error in this context
 * where over-spend is a planning input, not a system failure.
 *
 * Three states:
 *   ok           — finite max; show amount + headroom + bar
 *   exceeds_max  — pension/SS covers spending above $1M/yr
 *   insufficient — even $1k/yr depletes early
 */
function MaxSustainableCallout({ result, onApply }) {
  const { status, amount, target_age, current_desired, headroom, note } = result
  const fmtMoney = (n) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(Math.abs(n || 0))

  if (status === 'exceeds_max') {
    return (
      <div style={{
        marginTop: 8, fontSize: 12, padding: '8px 12px',
        background: 'var(--accent-green-bg)',
        border: '1px solid var(--accent-green-border)',
        borderRadius: 6, color: 'var(--text-primary)', lineHeight: 1.4,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ color: 'var(--accent-green)', fontSize: 14, fontWeight: 700 }}>✓</span>
        <span>
          <strong style={{ color: 'var(--text-primary)' }}>
            Max @ age {target_age}: &gt;$1M/yr.
          </strong>{' '}
          <span style={{ color: 'var(--text-secondary)' }}>
            {note || 'Pension/SS covers any reasonable spending.'}
          </span>
        </span>
      </div>
    )
  }
  if (status === 'insufficient') {
    return (
      <div style={{
        marginTop: 8, fontSize: 12, padding: '8px 12px',
        background: 'var(--accent-orange-bg)',
        border: '1px solid var(--accent-orange-border)',
        borderRadius: 6, color: 'var(--text-primary)', lineHeight: 1.4,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ color: 'var(--accent-orange)', fontSize: 14, fontWeight: 700 }}>!</span>
        <span>
          <strong style={{ color: 'var(--text-primary)' }}>
            No sustainable max @ age {target_age}.
          </strong>{' '}
          <span style={{ color: 'var(--text-secondary)' }}>
            {note || 'Plan is structurally under-funded.'}
          </span>
        </span>
      </div>
    )
  }

  // Main "ok" state. Color tiers — green / yellow / orange (no red).
  const headroomPct = current_desired > 0
    ? (headroom / current_desired) * 100
    : 0
  let accentVar, accentBgVar, accentBorderVar, headline
  if (headroom >= 0) {
    accentVar = 'var(--accent-green)'
    accentBgVar = 'var(--accent-green-bg)'
    accentBorderVar = 'var(--accent-green-border)'
    headline = 'Headroom'
  } else if (headroomPct > -5) {
    accentVar = 'var(--accent-yellow)'
    accentBgVar = 'var(--accent-yellow-bg)'
    accentBorderVar = 'var(--accent-yellow-border)'
    headline = 'Tight'
  } else {
    accentVar = 'var(--accent-orange)'
    accentBgVar = 'var(--accent-orange-bg)'
    accentBorderVar = 'var(--accent-orange-border)'
    headline = 'Over budget'
  }

  const fillPct = Math.min(100, Math.max(0, (current_desired / amount) * 100))

  return (
    <div style={{
      marginTop: 8,
      padding: '12px 14px',
      background: accentBgVar,
      border: `1px solid ${accentBorderVar}`,
      borderLeft: `3px solid ${accentVar}`,
      borderRadius: 6,
      fontSize: 12,
      lineHeight: 1.4,
      color: 'var(--text-primary)',
    }}>
      {/* Header: label + pill on the left, apply button on the right. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, marginBottom: 8,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
            textTransform: 'uppercase', color: 'var(--text-muted)',
          }}>
            Max sustainable @ {target_age}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px',
            borderRadius: 10, background: accentVar, color: 'var(--bg-card)',
            letterSpacing: 0.3,
          }}>
            {headline}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onApply && onApply(amount)}
          style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 600,
            background: accentVar, color: 'var(--bg-card)', border: 'none',
            borderRadius: 4, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
          title={`Set Retirement income to ${fmtMoney(amount)}/yr`}
        >
          Apply {fmtMoney(amount)}
        </button>
      </div>

      {/* 3-up metric tiles. Headroom gets the lead position because
          it's the actionable number — "how much can I move?" — while
          max and current are reference points. Headroom uses the
          accent color and the largest font; max and current sit
          quieter. Same anatomy whether positive (headroom) or negative
          (over budget) — only the sign + label flip. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12,
        marginBottom: 8,
      }}>
        {/* Headroom — the lead metric */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            marginBottom: 2,
          }}>
            {headroom >= 0 ? 'Headroom' : 'Over budget'}
          </div>
          <div style={{
            fontSize: 22, fontWeight: 700, color: accentVar, lineHeight: 1.1,
          }}>
            {headroom >= 0 ? '+' : '−'}{fmtMoney(headroom)}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
              /yr
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            {Math.abs(Math.round(headroomPct))}% of current spend
          </div>
        </div>

        {/* Max gross — supporting metric */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            marginBottom: 2,
          }}>
            Max gross
          </div>
          <div style={{
            fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.1,
          }}>
            {fmtMoney(amount)}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
              /yr
            </span>
          </div>
          {result.after_tax_avg > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              ~{fmtMoney(result.after_tax_avg)} after-tax ({Math.round((1 - result.after_tax_avg / amount) * 100)}%)
            </div>
          )}
        </div>

        {/* Current — reference */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
            textTransform: 'uppercase', color: 'var(--text-muted)',
            marginBottom: 2,
          }}>
            Current
          </div>
          <div style={{
            fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.1,
          }}>
            {fmtMoney(current_desired)}
            <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
              /yr
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            {Math.round((current_desired / amount) * 100)}% of max
          </div>
        </div>
      </div>

      {/* Progress bar — current vs max */}
      <div style={{
        position: 'relative', height: 6, borderRadius: 3,
        background: 'var(--bg-input)', overflow: 'hidden', marginBottom: 4,
      }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${fillPct}%`, background: accentVar,
          transition: 'width 200ms ease',
        }} />
      </div>
      {/* Bar caption — minimal since the 3 metric tiles already show
          the $ values. Just labels the endpoints for visual orientation. */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        fontSize: 10, color: 'var(--text-muted)',
      }}>
        <span>$0</span>
        <span>{Math.round(fillPct)}% of max</span>
      </div>
    </div>
  )
}


function TaxExposureTile({ data }) {
  // HSA included in the breakdown — it's the 4th first-class bucket
  // since the HSA carve-out went in. Withdrawals on qualified medical
  // come out tax-free (the most efficient bucket of the four).
  const tdBal = data.buckets.tax_deferred || 0
  const rothBal = data.buckets.roth || 0
  const taxBal = data.buckets.taxable || 0
  const hsaBal = data.buckets.hsa || 0
  const totalBuckets = tdBal + rothBal + taxBal + hsaBal

  if (totalBuckets === 0) {
    return (
      <div style={{
        padding: '12px 14px',
        borderRadius: 8,
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{
          fontSize: 11, color: 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
        }}>
          Tax exposure
        </div>
        <div style={{
          fontSize: 13, color: 'var(--text-muted)',
        }}>
          No investment accounts assigned to tax buckets
        </div>
      </div>
    )
  }

  const pct = (n) => ((n / totalBuckets) * 100).toFixed(0)
  // Only render the HSA stat when there's actually HSA dollars — keeps
  // the tile uncluttered for households without an HSA tagged.
  const showHsa = hsaBal > 0
  const bucketCount = showHsa ? 4 : 3

  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 8,
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
    }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
      }}>
        Tax exposure
      </div>
      <div style={{
        fontSize: 12, color: 'var(--text-primary)', marginBottom: 6,
        display: 'flex', gap: 12, flexWrap: 'wrap',
      }}>
        <span>Tax-deferred {pct(tdBal)}%</span>
        <span>·</span>
        <span>Roth {pct(rothBal)}%</span>
        <span>·</span>
        <span>Taxable {pct(taxBal)}%</span>
        {showHsa && <>
          <span>·</span>
          <span>HSA {pct(hsaBal)}%</span>
        </>}
      </div>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
      }}>
        {fmt(totalBuckets)} investable across {bucketCount} buckets
      </div>
    </div>
  )
}


/**
 * LoanPayoffSuggestions — surfaces an inline "auto-suggest" callout
 * for each loan whose payoff date falls during the user's accumulation
 * phase. One-click adds a contribution step event to the form.
 *
 * The default suggestion is contribution-step (= "save the freed
 * cashflow") since that's the optimal play, with a note that the user
 * can flip kind to spending after applying if they'd rather model the
 * lifestyle-creep alternative.
 *
 * Hides silently when there are no payoff-during-accumulation loans —
 * i.e. user has no loans, no Plaid mortgage detail, OR all loans pay
 * off after retirement (in which case auto-payoff doesn't free up
 * working-age contribution capacity).
 */
function LoanPayoffSuggestions({ currentAge, retirementAge, existingEvents, onApply }) {
  const [loans, setLoans] = useState(null)

  useEffect(() => {
    getLoans()
      .then(d => setLoans(d.loans || []))
      .catch(() => setLoans([]))
  }, [])

  if (!loans || loans.length === 0) return null

  const accumulationYears = Math.max(0, Number(retirementAge) - Number(currentAge))
  const today = new Date()
  // Filter to loans with computable payoff that falls during accumulation.
  const candidates = loans.filter(l => {
    if (!l.months_remaining || !l.monthly_payment) return false
    const payoffYearsFromNow = l.months_remaining / 12
    if (payoffYearsFromNow >= accumulationYears) return false
    // Skip if user already has a step event labeled with this loan's name
    // (light dedupe — not perfect but avoids duplicates on every render).
    const alreadyAdded = existingEvents.some(e => (e.label || '').includes(l.name))
    return !alreadyAdded
  })

  if (candidates.length === 0) return null

  return (
    <div style={{
      marginBottom: 8,
      padding: '8px 10px',
      background: 'var(--accent-blue-bg)',
      border: '1px solid var(--accent-blue-border)',
      borderRadius: 6,
      fontSize: 11,
      color: 'var(--text-primary)',
      lineHeight: 1.4,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
        textTransform: 'uppercase', color: 'var(--accent-blue)', marginBottom: 6,
      }}>
        Suggested step events
      </div>
      {candidates.map(loan => {
        const payoffAge = Number(currentAge) + Math.ceil(loan.months_remaining / 12)
        const annualPayment = Math.round(loan.monthly_payment * 12)
        return (
          <div key={loan.id} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 0', gap: 12,
            borderTop: '1px dashed var(--accent-blue-border)',
          }}>
            <div style={{ flex: 1 }}>
              <strong style={{ color: 'var(--text-primary)' }}>{loan.name}</strong> pays off
              at age {payoffAge} (~{Math.floor(loan.months_remaining / 12)}y from now).
              Freed cashflow: <strong style={{ color: 'var(--accent-green)' }}>
                +${annualPayment.toLocaleString()}/yr
              </strong>
            </div>
            <button
              type="button"
              onClick={() => onApply({
                age: payoffAge,
                kind: 'contribution',
                delta: annualPayment,
                duration_years: 0,
                label: `${loan.name} payoff`,
              })}
              style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 600,
                background: 'var(--accent-blue)', color: 'var(--bg-card)',
                border: 'none', borderRadius: 4, cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
              title="Adds a contribution step event. Flip kind to spending after if you'd rather model lifestyle creep."
            >
              Apply
            </button>
          </div>
        )
      })}
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
        Defaults to contribution-step (save the freed cashflow). Flip to spending after applying if you'd rather model lifestyle creep absorbing the payment.
      </div>
    </div>
  )
}


const INPUT_STYLE = {
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
