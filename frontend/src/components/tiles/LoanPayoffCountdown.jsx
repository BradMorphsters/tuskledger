import { useEffect, useState } from 'react'
import { Calendar } from 'lucide-react'
import { getLoans } from '../../api/client'
import { SkeletonCard } from '../Skeleton'
import { fmtMoney, tileCardStyle } from './shared'

/**
 * LoanPayoffCountdown — at-a-glance "when does each loan pay off"
 * tile. Pulls from /api/loans/ (which returns months_remaining +
 * maturity_date + balance per loan when rate/payment data is on
 * file). Sorted by closest payoff so the next milestone sits up top.
 *
 * Hides silently when no loans have payoff data — i.e. no Plaid
 * MortgageDetail and no manual rate/payment override on file. To
 * surface a loan here, set its rate + monthly payment on the Loans
 * page and the tile picks it up automatically.
 */
export function LoanPayoffCountdown() {
  const [loans, setLoans] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getLoans()
      .then(d => setLoans(d.loans || []))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="35%" rows={3} />
  if (!loans || loans.length === 0) return null

  // Only show loans with computable payoff data. Sort closest-first.
  const withPayoff = loans
    .filter(l => l.months_remaining != null && l.months_remaining > 0)
    .sort((a, b) => a.months_remaining - b.months_remaining)

  if (withPayoff.length === 0) return null

  const fmtDate = (months) => {
    const d = new Date()
    d.setMonth(d.getMonth() + months)
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  }

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={14} style={{ color: 'var(--accent-blue)' }} /> Loan payoff timeline
        </span>
        <a href="/loans" style={{ fontSize: 11, color: 'var(--accent-blue)' }}>
          Detail →
        </a>
      </div>
      {/* Loans list. flex: 1 absorbs the row's stretched height so a
          single-loan tile doesn't sit at the top with empty space
          below it. The per-loan rows space out evenly. */}
      <div style={{
        display: 'flex', flexDirection: 'column',
        gap: 10, paddingTop: 4, flex: 1,
      }}>
        {withPayoff.map((loan, idx) => {
          const yrs = Math.floor(loan.months_remaining / 12)
          const mos = loan.months_remaining % 12
          // Progress = how much of the original loan term is gone.
          // Falls back gracefully if original_term_months isn't known —
          // we just don't render the bar, the row collapses to its
          // existing layout.
          const totalMonths = loan.original_term_months
          const progressPct = totalMonths
            ? Math.min(100, Math.max(0, ((totalMonths - loan.months_remaining) / totalMonths) * 100))
            : null
          return (
            <div key={loan.id} style={{
              display: 'flex', flexDirection: 'column',
              gap: 6,
              paddingBottom: idx < withPayoff.length - 1 ? 12 : 0,
              borderBottom: idx < withPayoff.length - 1
                ? '1px solid var(--border-color, rgba(255,255,255,0.04))'
                : 'none',
            }}>
              <div style={{
                display: 'flex', alignItems: 'baseline',
                justifyContent: 'space-between', gap: 12,
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {loan.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {fmtMoney(loan.balance)}
                    {loan.interest_rate != null && ` · ${(loan.interest_rate * 100).toFixed(2)}%`}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-blue)' }}>
                    {yrs > 0 && `${yrs}y`}{yrs > 0 && mos > 0 && ' '}{mos > 0 && `${mos}mo`}
                    {yrs === 0 && mos === 0 && '—'}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    → {fmtDate(loan.months_remaining)}
                  </div>
                </div>
              </div>
              {progressPct != null && (
                <div title={`${Math.round(progressPct)}% paid off (term-elapsed)`}>
                  <div style={{
                    height: 4, borderRadius: 2,
                    background: 'var(--border-color, rgba(255,255,255,0.06))',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${progressPct}%`, height: '100%',
                      background: 'var(--accent-blue)',
                      borderRadius: 2,
                    }} />
                  </div>
                  <div style={{
                    fontSize: 9, color: 'var(--text-dim)', marginTop: 2,
                    display: 'flex', justifyContent: 'space-between',
                  }}>
                    <span>{Math.round(progressPct)}% of term elapsed</span>
                    <span>{Math.round(100 - progressPct)}% to go</span>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
