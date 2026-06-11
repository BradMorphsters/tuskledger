/**
 * TaxesSection — form section for tax and inflation inputs:
 * ordinary/CG rates, inflation, state tax (with preset dropdown),
 * taxable basis %, IRMAA, TCJA sunset, QBI, TLH, QCD.
 * Also handles the Spending phases sub-section (healthcare bridge,
 * go-go/slow-go/no-go, wage/healthcare growth).
 *
 * Extracted from RetirementProjection.jsx. All form state is passed as
 * props. No local state, no API calls.
 */
import { Section, FieldGrid, Field } from './FormWidgets'
import { STATE_TAX_PRESETS } from './shared'

export function SpendingSection({ form, setForm, update, INPUT_STYLE }) {
  return (
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
  )
}


export function TaxesInflationSection({ form, setForm, update, INPUT_STYLE }) {
  return (
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px', fontSize: 13, height: 36 }}>
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 4px', fontSize: 13, height: 36 }}>
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
  )
}
