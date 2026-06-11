/**
 * SocialSecuritySection — form section for Social Security inputs:
 * two streams (you + spouse), SS haircut stress test, claim ages, COLAs.
 *
 * Extracted from RetirementProjection.jsx. All form state is passed as
 * props. No local state, no API calls.
 */
import { Section, FieldGrid, Field, PersonHeader } from './FormWidgets'

export function SocialSecuritySection({ form, setForm, update, INPUT_STYLE }) {
  return (
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
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--accent-orange)' }}>
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
              padding: '6px 12px', fontSize: 12,
              background: 'rgba(96,165,250,0.12)',
              border: '1px dashed rgba(96,165,250,0.4)',
              color: 'var(--accent-blue)', borderRadius: 6,
              cursor: form.spouse_age === '' || form.spouse_age === undefined ? 'not-allowed' : 'pointer',
              opacity: form.spouse_age === '' || form.spouse_age === undefined ? 0.5 : 1,
            }}
          >
            + Add spouse SS
          </button>
        </div>
      )}
    </Section>
  )
}
