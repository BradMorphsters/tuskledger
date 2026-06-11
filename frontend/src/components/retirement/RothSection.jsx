/**
 * RothSection — form section for Roth conversion ladder inputs:
 * convert amount, start/end ages, fill-to-bracket strategy, and
 * the comparison summary card when results are available.
 *
 * Extracted from RetirementProjection.jsx. All form state is passed as
 * props. No local state, no API calls.
 */
import { Section, FieldGrid, Field } from './FormWidgets'
import { fmtRounded } from './shared'

export function RothSection({ form, setForm, update, data, INPUT_STYLE }) {
  return (
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
              Lifetime tax {data.roth_comparison.lifetime_tax_savings > 0 ? 'saved' : 'cost'}: {fmtRounded(Math.abs(data.roth_comparison.lifetime_tax_savings))}
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
                {fmtRounded(data.roth_comparison.total_converted)}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>Lifetime tax (with strategy)</div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                {fmtRounded(data.roth_comparison.with_strategy_lifetime_tax)}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                baseline {fmtRounded(data.roth_comparison.baseline_lifetime_tax)}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>End balance delta</div>
              <div style={{
                fontWeight: 600, fontSize: 14,
                color: data.roth_comparison.end_balance_delta >= 0
                  ? 'var(--accent-green)' : 'var(--accent-orange)',
              }}>
                {data.roth_comparison.end_balance_delta >= 0 ? '+' : ''}{fmtRounded(data.roth_comparison.end_balance_delta)}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                vs baseline {fmtRounded(data.roth_comparison.baseline_end_balance)}
              </div>
            </div>
          </div>
        </div>
      )}
    </Section>
  )
}
