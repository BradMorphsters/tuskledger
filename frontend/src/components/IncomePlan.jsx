import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Wallet, Sparkles } from 'lucide-react'
import { getIncomeSchedule } from '../api/client'
import { formatCurrencyZero as fmt, formatDate } from '../lib/format'

/**
 * IncomePlan: the Budgets page's income strip.
 *
 * Budget on BASELINE income, the pay every month is guaranteed to bring
 * (two checks for bi-weekly and semi-monthly earners alike), and treat the
 * third bi-weekly check that lands twice a year as a planned extra rather
 * than letting it silently inflate one month. Data: GET /api/income/schedule.
 * Renders nothing until paychecks are detected.
 */
export function incomePlanFor(schedule, year, month) {
  if (!schedule?.household || !schedule.earners?.length) return null
  const key = `${year}-${String(month).padStart(2, '0')}`
  const m = (schedule.months || []).find(x => x.month === key) || null
  const nextExtra = (schedule.extra_paycheck_months || []).find(x => x.month > key) || null
  return { baseline: schedule.household.baseline_monthly, month: m, nextExtra }
}

export default function IncomePlan({ year, month, totalBudget }) {
  const [schedule, setSchedule] = useState(null)

  useEffect(() => {
    let live = true
    getIncomeSchedule().then(d => { if (live) setSchedule(d) }).catch(() => {})
    return () => { live = false }
  }, [])

  const plan = incomePlanFor(schedule, year, month)
  if (!plan || !plan.baseline) return null
  const { baseline, month: m, nextExtra } = plan
  const left = baseline - (totalBudget || 0)

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Wallet size={14} style={{ color: 'var(--accent-green)' }} /> Income plan
        </span>
        <Link to="/paychecks" style={{ fontSize: 12 }}>Pay schedules →</Link>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, fontSize: 13 }}>
        <div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Baseline income</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{fmt(baseline)}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>arrives every month</div>
        </div>
        {totalBudget > 0 && (
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{left >= 0 ? 'Unbudgeted baseline' : 'Budget above baseline'}</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: left >= 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>{fmt(Math.abs(left))}</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {left >= 0 ? 'free for savings or goals' : 'relies on extra checks or savings'}
            </div>
          </div>
        )}
        {m && (
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Paychecks this month</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>
              {m.paycheck_count} · {fmt(m.period === 'past' ? m.received_total : m.expected_total)}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {m.period === 'past' ? 'received' : m.period === 'current' && m.remaining_total > 0 ? `${fmt(m.remaining_total)} still to come` : 'expected'}
            </div>
          </div>
        )}
      </div>
      {m?.is_extra_month ? (
        <div style={{ marginTop: 12, padding: '8px 10px', borderRadius: 6, background: 'var(--accent-yellow-bg)', fontSize: 13, display: 'flex', gap: 8 }}>
          <Sparkles size={15} style={{ color: 'var(--accent-yellow)', flexShrink: 0, marginTop: 1 }} />
          <span>
            Extra-paycheck month: {m.extra_checks} additional check{m.extra_checks === 1 ? '' : 's'} worth {fmt(m.extra_amount)}
            {' '}({m.paychecks.filter(p => p.is_extra).map(p => `${p.name}, ${formatDate(p.date)}`).join('; ')}).
            {' '}It's not needed for the budget above. Put it toward savings, debt or irregular bills.
          </span>
        </div>
      ) : nextExtra ? (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
          Next extra-paycheck month: <strong style={{ color: 'var(--text-secondary)' }}>{nextExtra.label}</strong> (+{fmt(nextExtra.extra_amount)}).
        </div>
      ) : null}
    </div>
  )
}
