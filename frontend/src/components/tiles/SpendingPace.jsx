import { useEffect, useState } from 'react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { getSpendingTrend } from '../../api/client'
import { SkeletonCard } from '../Skeleton'
import { fmtMoney, tileCardStyle } from './shared'

// Compact dollar formatter for the y-axis ticks — keeps the axis narrow so
// the plotting area gets the most width (mirrors CashFlowForecast).
function fmtCompactMoney(v) {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${Math.round(v / 1_000)}k`
  return `$${Math.round(v)}`
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * SpendingPace — this month's cumulative spending vs a trailing moving-average
 * baseline, plotted against day-of-month. Answers "am I spending faster or
 * slower than usual this month?".
 *
 * For spending, BELOW the baseline is the good outcome — so the accent goes
 * green when under pace and red when over. The baseline is the average of the
 * prior N (default 4) calendar months' cumulative-by-day curves.
 */
export function SpendingPace() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    getSpendingTrend(4).then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="45%" rows={5} />
  if (!data || !data.points || !data.points.length) return null

  const { points, today, days_in_month, mtd_total, baseline_to_date,
          baseline_full, projected_month_end, delta, pct, baseline_window } = data

  // Under pace (delta < 0) is good for spending → green. Over → red.
  const under = delta <= 0
  const accent = under ? 'var(--accent-green)' : 'var(--accent-red)'
  const Icon = under ? TrendingDown : TrendingUp
  const monthLabel = MONTH_NAMES[(data.month || 1) - 1]
  const ticks = [1, 5, 10, 15, 20, 25, days_in_month].filter((d, i, a) => a.indexOf(d) === i && d <= days_in_month)

  return (
    <div className="card" style={tileCardStyle}>
      <div className="card-header" style={{ marginBottom: 4 }}>
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon size={14} style={{ color: accent }} /> Spending pace
        </span>
        <span style={{
          fontSize: 10, color: 'var(--text-muted)',
          padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 10,
        }}>
          vs {baseline_window}-mo avg
        </span>
      </div>

      {/* Hero: this-month MTD → vs the average month's spend by the same day,
          with the over/under delta called out in the middle. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0 10px' }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {monthLabel} so far
          </div>
          <div style={{
            fontSize: 18, fontWeight: 600, color: 'var(--text-primary)',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {fmtMoney(mtd_total)}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0 4px', flexShrink: 0 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '2px 8px', borderRadius: 10,
            background: under ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
            color: accent, fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
          }}>
            {under ? '−' : '+'}{fmtMoney(Math.abs(delta))}
            {pct != null && <span style={{ opacity: 0.8 }}>({under ? '' : '+'}{pct}%)</span>}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
            {under ? 'under' : 'over'} pace
          </div>
        </div>

        <div style={{ flex: '1 1 auto', minWidth: 0, textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Usual by day {today}
          </div>
          <div style={{
            fontSize: 18, fontWeight: 600, color: 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {fmtMoney(baseline_to_date)}
          </div>
        </div>
      </div>

      {/* Two lines sharing a day-of-month X axis: solid = this month's running
          total (stops at today), dashed = the N-month average curve across the
          whole month. */}
      <div style={{ flex: '1 1 0', minHeight: 110 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
            <XAxis
              dataKey="day"
              type="number"
              domain={[1, days_in_month]}
              ticks={ticks}
              tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
            />
            <YAxis
              tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
              tickFormatter={v => fmtCompactMoney(v)}
              width={42}
            />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
              formatter={(v, name) => [fmtMoney(v), name]}
              labelFormatter={d => `Day ${d}`}
            />
            <ReferenceLine x={today} stroke="var(--text-muted)" strokeDasharray="2 4" strokeOpacity={0.6} />
            <Line
              type="monotone" dataKey="baseline" name={`${baseline_window}-mo avg`}
              stroke="var(--text-muted)" strokeWidth={1.5} strokeDasharray="5 4" dot={false}
            />
            <Line
              type="monotone" dataKey="mtd" name={`${monthLabel} so far`}
              stroke={accent} strokeWidth={2} dot={false} connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Footer: legend + the pace-projected month-end total vs the typical
          full-month spend. */}
      <div style={{
        marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: 10, color: 'var(--text-muted)',
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 2, background: accent, display: 'inline-block' }} />
            {monthLabel}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 0, borderTop: '2px dashed var(--text-muted)', display: 'inline-block' }} />
            avg
          </span>
        </span>
        {projected_month_end != null && (
          <span>
            Proj. <span style={{ color: accent, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(projected_month_end)}</span>
            {' '}vs <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(baseline_full)}</span>
          </span>
        )}
      </div>
    </div>
  )
}
