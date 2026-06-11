/**
 * PensionSection — form section for defined-benefit pension inputs:
 * salary basis, percent, holder, start age, COLA, and YOS quick-calc.
 *
 * Extracted from RetirementProjection.jsx. All form state is passed as
 * props. No local state, no API calls.
 */
import { Section, FieldGrid, Field } from './FormWidgets'
import { fmtRounded } from './shared'

export function PensionSection({ form, setForm, update, derivedPensionAnnual, INPUT_STYLE }) {
  return (
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
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          Pension annual: <strong style={{ color: 'var(--text-primary)' }}>
            {fmtRounded(derivedPensionAnnual)}
          </strong>
          <span style={{ color: 'var(--text-muted)' }}>
            {' '}({fmtRounded(form.pension_salary_basis)} × {form.pension_pct}%) — in today's dollars
          </span>
        </div>
      )}

      {/* YOS calculator — quietly reminds users that the % field is
          multiplier × years_of_service. Advisor review item #4: most
          people enter a single % and forget it grows with service. */}
      {form.pension_salary_basis > 0 && (
        <div style={{
          marginTop: 6, fontSize: 11, color: '#64748b',
          display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
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
  )
}
