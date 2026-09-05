import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, PiggyBank } from 'lucide-react'
import { getSafeToSpend } from '../../api/client'
import { SkeletonCard } from '../Skeleton'
import LoadError from '../LoadError'
import { fmtMoney, tileCardStyle } from './shared'

/**
 * SafeToSpend — the Dashboard's "can I buy this?" answer.
 *
 * Everything here comes from GET /analytics/safe-to-spend (see
 * app/services/safe_to_spend.py) — the tile only formats the response,
 * it does no arithmetic of its own. The four terms that make up the
 * headline number are shown in the expandable breakdown so the number
 * can be checked, not just trusted.
 */
function fmtShortDate(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function SafeToSpend() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const load = () => {
    setLoading(true)
    setError(false)
    getSafeToSpend()
      .then(d => { setData(d); setLoading(false) })
      .catch(() => { setError(true); setLoading(false) })
  }

  useEffect(() => { load() }, [])

  if (loading) return <SkeletonCard titleWidth="45%" rows={3} />
  if (error) {
    return (
      <div className="card" style={tileCardStyle}>
        <div className="card-header">
          <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <PiggyBank size={14} style={{ color: 'var(--accent-blue)' }} /> Safe to spend
          </span>
        </div>
        <LoadError what="your safe-to-spend number" onRetry={load} compact />
      </div>
    )
  }
  if (!data) return null

  const positive = data.safe_to_spend >= 0
  const headlineColor = positive ? 'var(--accent-green)' : 'var(--accent-red)'

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <PiggyBank size={14} style={{ color: 'var(--accent-blue)' }} /> Safe to spend
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          until {fmtShortDate(data.next_paycheck_date)}
        </span>
      </div>

      <div style={{ marginTop: 4 }}>
        <div style={{
          fontSize: 28, fontWeight: 700, color: headlineColor,
          fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
        }}>
          {fmtMoney(data.safe_to_spend)}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          Estimated: checking − bills due − usual spending before payday
        </div>
      </div>

      {/* Fallback context: only shown when a term used a non-ideal source,
          so a confident number doesn't get cluttered with caveats. */}
      {(data.next_paycheck_source === 'month_end_fallback' || data.budget_source === 'trailing_average') && (
        <div style={{ fontSize: 11, color: 'var(--accent-orange)', marginTop: 6 }}>
          {data.next_paycheck_source === 'month_end_fallback' && 'No income stream detected — assuming next paycheck on the 1st. '}
          {data.budget_source === 'trailing_average' && 'No budget set — using your 90-day average.'}
        </div>
      )}

      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          marginTop: 10, padding: 0, background: 'none', border: 'none',
          color: 'var(--accent-blue)', fontSize: 12, cursor: 'pointer',
        }}
      >
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {expanded ? 'Hide breakdown' : 'Show breakdown'}
      </button>

      {expanded && (
        <div style={{
          marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)',
          fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <Row label="Checking cash" value={fmtMoney(data.spendable_cash)} />
          <Row label="− Bills due before payday" value={fmtMoney(data.bills_due)} negative />
          <Row
            label={`− Usual spending (${data.budget_source === 'trailing_average' ? '90-day avg' : data.budget_source === 'none' ? 'no history' : 'budget'})`}
            value={fmtMoney(data.budget_remaining_pro_rata)}
            negative
          />
          <Row label="= Safe to spend" value={fmtMoney(data.safe_to_spend)} bold color={headlineColor} />

          {data.bills.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                Bills counted
              </div>
              {data.bills.map((b, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', padding: '2px 0' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
                    {b.name} · {fmtShortDate(b.date)}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(b.amount)}</span>
                </div>
              ))}
            </div>
          )}

          {data.notes?.map(note => (
            <div key={note} style={{ color: 'var(--text-muted)' }}>{note}</div>
          ))}
          {data.savings_cash > 0 && (
            <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
              + {fmtMoney(data.savings_cash)} in savings not counted
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value, negative, bold, color }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: bold ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: bold ? 600 : 400 }}>
        {label}
      </span>
      <span style={{
        fontVariantNumeric: 'tabular-nums',
        fontWeight: bold ? 700 : 500,
        color: color || (negative ? 'var(--accent-red)' : 'var(--text-primary)'),
      }}>
        {value}
      </span>
    </div>
  )
}
