/**
 * StressSection — form section for stress tests, one-time events, and
 * step events:
 *   - Survivor planning (age, pension survivor %, spend multiplier)
 *   - LTC (cost, start age, duration, LTC comparison callout)
 *   - Monte Carlo runs + sequence stress preset
 *   - One-time / lumpy events editor (expense / inflow / bucket)
 *   - Step events editor (contribution / spending delta shifts)
 *   - LoanPayoffSuggestions integration
 *
 * Extracted from RetirementProjection.jsx. All form state is passed as
 * props. No local state other than what LoanPayoffSuggestions manages
 * internally.
 */
import { Section, FieldGrid, Field } from './FormWidgets'
import { LoanPayoffSuggestions } from './LoanPayoffSuggestions'
import { fmtRounded } from './shared'

export function StressSection({ form, setForm, update, data, INPUT_STYLE }) {
  return (
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
              {fmtRounded(data.ltc_comparison.total_ltc_paid)} of LTC over {data.ltc_comparison.ltc_duration_years} yrs starting at age {data.ltc_comparison.ltc_start_age}
              {' → '}end balance drops by{' '}
              <strong style={{ color: 'var(--accent-yellow)' }}>
                {fmtRounded(Math.abs(data.ltc_comparison.end_balance_delta))}
              </strong>
              {' '}({fmtRounded(data.ltc_comparison.no_ltc_end_balance)} without LTC vs {fmtRounded(data.ltc_comparison.with_ltc_end_balance)} with).
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
                rows exist. */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '70px 70px 100px 90px 1fr 60px',
              gap: 8, padding: '0 6px',
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
                {/* Bucket selector — only for inflows. */}
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
          kicking in. */}
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
            {/* Column headers */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '110px 70px 100px 70px 1fr 60px',
              gap: 8, padding: '0 6px',
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
  )
}
