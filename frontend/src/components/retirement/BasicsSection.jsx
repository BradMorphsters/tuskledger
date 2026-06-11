/**
 * BasicsSection — form section for core projection inputs:
 * ages, return rates, retirement income, contribution, HSA, max-sustainable.
 *
 * Extracted from RetirementProjection.jsx. All form state is passed as
 * props (form, setForm, data, update, INPUT_STYLE). No local state, no
 * API calls.
 */
import { Section, FieldGrid, Field } from './FormWidgets'
import { MaxSustainableCallout } from './StatTiles'
import { fmtRounded } from './shared'

export function BasicsSection({ form, setForm, data, update, INPUT_STYLE }) {
  return (
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
          <div style={{ marginTop: 6, display: 'flex', gap: 4, fontSize: 11 }}>
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
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.3 }}>
              After-tax actual: <strong style={{ color: 'var(--text-secondary)' }}>
                {fmtRounded(data.sim_after_tax_avg)}
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
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.3 }}>
              Grossed up to: <strong style={{ color: 'var(--text-secondary)' }}>
                {fmtRounded(data.net_target_diagnostics.final_gross)}
              </strong>/yr
              <span style={{ color: 'var(--text-muted)' }}>
                {' '}(achieved {fmtRounded(data.net_target_diagnostics.achieved_avg_net)} avg net,{' '}
                {data.net_target_diagnostics.iterations} iter)
              </span>
            </div>
          )}
        </Field>
        <Field
          label="Contribution / yr"
          hint={data?.inputs?.contribution_source === 'auto-detected' && form.annual_contribution === ''
            ? `auto: ${fmtRounded(data.inputs.annual_contribution)}`
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px', fontSize: 13, height: 36 }}>
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
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
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {pctRounded}%
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
                    {' '}of household max
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {fmtRounded(current)}/yr of {fmtRounded(theoreticalMax)}/yr theoretical
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
                  {isDualIncome ? '2×' : '1×'} 401(k) {fmtRounded(limit401k)} +{' '}
                  {isDualIncome ? '2×' : '1×'} IRA {fmtRounded(limitIRA)} +{' '}
                  family HSA {fmtRounded(limitHSA)}
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
  )
}
