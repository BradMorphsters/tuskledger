import { useState, useEffect } from 'react'
import { Target, AlertCircle, Loader2, Printer } from 'lucide-react'
import { getRetirementProjection } from '../api/client'
import { ScenariosToolbar } from './RetirementScenarios'
import { STORAGE_KEY, DEFAULTS, loadForm, INPUT_STYLE } from './retirement/shared'
import { BasicsSection } from './retirement/BasicsSection'
import { SpendingSection, TaxesInflationSection } from './retirement/TaxesSection'
import { PensionSection } from './retirement/PensionSection'
import { SocialSecuritySection } from './retirement/SocialSecuritySection'
import { RothSection } from './retirement/RothSection'
import { StressSection } from './retirement/StressSection'
import { Results } from './retirement/ResultsPanel'

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
 *
 * Subcomponents live in ./retirement/:
 *   shared.js                 — DEFAULTS, STATE_TAX_PRESETS, loadForm, fmtRounded, INPUT_STYLE, toNominal
 *   FormWidgets.jsx           — Section, FieldGrid, PersonHeader, Field, HelpPopover
 *   StatTiles.jsx             — StatTile, SSStreamTiles, TaxExposureTile, LegendItem, MaxSustainableCallout
 *   ChartTooltip.jsx          — ChartTooltip
 *   LoanPayoffSuggestions.jsx — LoanPayoffSuggestions
 *   BasicsSection.jsx         — BasicsSection
 *   TaxesSection.jsx          — SpendingSection, TaxesInflationSection
 *   PensionSection.jsx        — PensionSection
 *   SocialSecuritySection.jsx — SocialSecuritySection
 *   RothSection.jsx           — RothSection
 *   StressSection.jsx         — StressSection (stress tests + one-time events + step events)
 *   ResultsPanel.jsx          — Results (full results section)
 */

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
      <BasicsSection
        form={form}
        setForm={setForm}
        data={data}
        update={update}
        INPUT_STYLE={INPUT_STYLE}
      />

      {/* ─────────── SPENDING ─────────── */}
      <SpendingSection
        form={form}
        setForm={setForm}
        update={update}
        INPUT_STYLE={INPUT_STYLE}
      />

      {/* ─────────── PENSION ─────────── */}
      <PensionSection
        form={form}
        setForm={setForm}
        update={update}
        derivedPensionAnnual={derivedPensionAnnual}
        INPUT_STYLE={INPUT_STYLE}
      />

      {/* ─────────── SOCIAL SECURITY ─────────── */}
      <SocialSecuritySection
        form={form}
        setForm={setForm}
        update={update}
        INPUT_STYLE={INPUT_STYLE}
      />

      {/* ─────────── TAXES & INFLATION ─────────── */}
      <TaxesInflationSection
        form={form}
        setForm={setForm}
        update={update}
        INPUT_STYLE={INPUT_STYLE}
      />

      {/* ─────────── ROTH CONVERSION LADDER ─────────── */}
      <RothSection
        form={form}
        setForm={setForm}
        update={update}
        data={data}
        INPUT_STYLE={INPUT_STYLE}
      />

      {/* ─────────── STRESS TESTS ─────────── */}
      <StressSection
        form={form}
        setForm={setForm}
        update={update}
        data={data}
        INPUT_STYLE={INPUT_STYLE}
      />

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
              ? "Auto-detect found no incoming transactions to your investment accounts in the last 12 months — but Plaid can't see 401k payroll deferrals (those leave your paycheck before any bank sees them)."
              : 'You explicitly set the contribution to $0.'}
            {' '}If you're actually saving anything (401k + match, IRA, brokerage), enter that number above — it materially changes the projection.
          </div>
        </div>
      )}

      {data && <Results data={data} />}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
