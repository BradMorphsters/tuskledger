import { useEffect, useState } from 'react'
import { Calendar } from 'lucide-react'
import { getTransactions } from '../../api/client'
import { SkeletonCard } from '../Skeleton'
import { fmtMoney, tileCardStyle } from './shared'

// Small label/value pair used by the Daily Snapshot tile.
function ForecastStat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  )
}

function processTxns(txns) {
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const todayDow = today.getDay()
  // Week start (Monday)
  const weekStart = new Date(today)
  const dayOffset = (today.getDay() + 6) % 7
  weekStart.setDate(weekStart.getDate() - dayOffset)
  const weekStartStr = weekStart.toISOString().slice(0, 10)

  let todayOutflow = 0
  let weekOutflow = 0
  let weekTxnCount = 0
  const dowOutflows = [] // outflows on same DoW as today, prior weeks

  txns.forEach(t => {
    if (!t.amount || t.amount <= 0 || t.is_transfer) return
    const tDate = new Date(t.date + 'T12:00:00')
    if (t.date === todayStr) todayOutflow += t.amount
    if (t.date >= weekStartStr && t.date <= todayStr) {
      weekOutflow += t.amount
      weekTxnCount++
    }
    // Prior same-DoW outflows for averaging (skip today itself)
    if (tDate.getDay() === todayDow && t.date !== todayStr) {
      dowOutflows.push({ date: t.date, amount: t.amount })
    }
  })

  // Average outflow per same-DoW (group by date first to handle multi-txn days)
  const byDate = {}
  dowOutflows.forEach(d => { byDate[d.date] = (byDate[d.date] || 0) + d.amount })
  const dailyTotals = Object.values(byDate)
  const dowAverage = dailyTotals.length
    ? dailyTotals.reduce((a, b) => a + b, 0) / dailyTotals.length
    : 0

  return {
    todayOutflow,
    weekOutflow,
    weekTxnCount,
    dowAverage,
    dowName: dowNames[todayDow],
  }
}

/**
 * DailySnapshot — at-a-glance "how am I doing today/this week" tile.
 * Pulls last 90 days of transactions and computes:
 *   - Today's outflow
 *   - This week's outflow (Mon-Sun)
 *   - Same-day-of-week average from prior weeks (anomaly comparison)
 * Useful for "is today normal?" quick checks.
 */
export function DailySnapshot() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const today = new Date()
    const cutoff = new Date(today)
    cutoff.setDate(cutoff.getDate() - 90)
    getTransactions({
      start_date: cutoff.toISOString().slice(0, 10),
      end_date: today.toISOString().slice(0, 10),
      limit: 5000,
    })
      .then(txns => { setData(processTxns(txns || [])); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="35%" rows={3} />
  if (!data) return null

  const todayVsAvg = data.todayOutflow - data.dowAverage
  const todayColor = todayVsAvg > data.dowAverage * 0.5
    ? 'var(--accent-orange)'
    : todayVsAvg < -data.dowAverage * 0.3
      ? 'var(--accent-green)'
      : 'var(--text-primary)'

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header">
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Calendar size={14} style={{ color: 'var(--accent-blue)' }} /> Daily snapshot
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>vs typical {data.dowName}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <ForecastStat label="Today" value={fmtMoney(data.todayOutflow)} color={todayColor} />
        <ForecastStat label="This week" value={fmtMoney(data.weekOutflow)} color="var(--text-primary)" />
        <ForecastStat
          label={`Avg ${data.dowName}`}
          value={fmtMoney(data.dowAverage)}
          color="var(--text-secondary)"
        />
      </div>
      <div style={{
        marginTop: 10, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5,
      }}>
        {todayVsAvg > 0
          ? `Today is ${fmtMoney(todayVsAvg)} above your typical ${data.dowName}.`
          : todayVsAvg < 0
            ? `Today is ${fmtMoney(-todayVsAvg)} below your typical ${data.dowName}. 👍`
            : 'On pace with a typical day.'}
        {' '}{data.weekTxnCount} txns this week.
      </div>
    </div>
  )
}
