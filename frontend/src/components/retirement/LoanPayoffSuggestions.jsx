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
 *
 * Extracted from RetirementProjection.jsx.
 */
import { useState, useEffect } from 'react'
import { getLoans } from '../../api/client'

export function LoanPayoffSuggestions({ currentAge, retirementAge, existingEvents, onApply }) {
  const [loans, setLoans] = useState(null)

  useEffect(() => {
    getLoans()
      .then(d => setLoans(d.loans || []))
      .catch(() => setLoans([]))
  }, [])

  if (!loans || loans.length === 0) return null

  const accumulationYears = Math.max(0, Number(retirementAge) - Number(currentAge))
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
