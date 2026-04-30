/**
 * SpendingExtras — additional Spending & Income page widgets.
 *   TopMerchants     — sortable table of top spend by merchant + sparkline trend
 *   SpendingHeatmap  — 365-day calendar grid colored by daily spend intensity
 */
import { useEffect, useState, useMemo } from 'react'
import { getTopMerchants, getSpendingHeatmap } from '../api/client'
import { SkeletonCard } from './Skeleton'

function fmt(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0)
}

/* ──────────────────────────── Top merchants ──────────────────────────── */

export function TopMerchants({ months = 6, limit = 15 }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    getTopMerchants(months, limit).then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [months, limit])

  if (loading) return <SkeletonCard titleWidth="40%" rows={6} />
  if (!data || !data.merchants?.length) return null

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Top merchants · last {months}mo</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {data.merchants.length} merchants
        </span>
      </div>
      <div className="table-wrapper">
        <table style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Merchant</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              <th style={{ textAlign: 'right' }}>Avg / txn</th>
              <th style={{ textAlign: 'right' }}>Count</th>
              <th style={{ textAlign: 'left', minWidth: 120 }}>Trend</th>
            </tr>
          </thead>
          <tbody>
            {data.merchants.map(m => (
              <tr key={m.merchant}>
                <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.merchant}
                </td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(m.total)}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>
                  {fmt(m.avg_per_txn)}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{m.txn_count}</td>
                <td><Sparkline values={m.sparkline} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Sparkline({ values, width = 110, height = 22 }) {
  if (!values || !values.length) return null
  const max = Math.max(...values, 1)
  const w = width / Math.max(1, values.length - 1)
  // Build a polyline path from values
  const pts = values.map((v, i) => {
    const x = i * w
    const y = height - (v / max) * (height - 4) - 2
    return `${x},${y}`
  }).join(' ')
  // Color: green if last value < first (decreasing), red if increasing
  const trending = values[values.length - 1] > values[0]
  const stroke = trending ? 'var(--accent-red)' : 'var(--accent-green)'
  return (
    <svg width={width} height={height}>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} />
      {/* Fill area under curve */}
      <polyline
        points={`${pts} ${(values.length - 1) * w},${height} 0,${height}`}
        fill={stroke} fillOpacity={0.15} stroke="none"
      />
    </svg>
  )
}

/* ──────────────────────────── Spending heatmap ──────────────────────── */

export function SpendingHeatmap() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [hovered, setHovered] = useState(null)
  useEffect(() => {
    getSpendingHeatmap(365).then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  // IMPORTANT: useMemo MUST sit above any early returns. When the page
  // first mounts `data` is null, so the early-return branch ran with 4
  // hooks; the next render had data and ran 5 hooks → React threw
  // "Rendered more hooks than during the previous render" and the whole
  // SpendingIncome page crashed. Hook count must be stable across renders.
  const weeks = useMemo(() => {
    if (!data?.days?.length) return []
    const out = []
    let week = []
    data.days.forEach((d, i) => {
      const dt = new Date(d.date + 'T12:00:00')
      const dow = dt.getDay() // 0=Sun
      if (i === 0) {
        // Pad the first week with empty cells to align to Sunday
        for (let p = 0; p < dow; p++) week.push(null)
      }
      week.push(d)
      if (week.length === 7) {
        out.push(week)
        week = []
      }
    })
    if (week.length) {
      while (week.length < 7) week.push(null)
      out.push(week)
    }
    return out
  }, [data])

  if (loading) return <SkeletonCard titleWidth="40%" rows={5} />
  if (!data || !data.days?.length) return null

  const colorFor = (total) => {
    if (!total) return 'var(--bg-elevated)'
    const { p25, p50, p75, p90 } = data.thresholds
    if (total >= p90) return 'rgba(248,113,113,0.85)'
    if (total >= p75) return 'rgba(251,146,60,0.75)'
    if (total >= p50) return 'rgba(251,191,36,0.65)'
    if (total >= p25) return 'rgba(96,165,250,0.50)'
    return 'rgba(96,165,250,0.20)'
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Spending heatmap · 365 days</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          color = daily spend intensity
        </span>
      </div>
      <div style={{ display: 'flex', gap: 2, overflowX: 'auto', paddingBottom: 8 }}>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {week.map((day, di) => (
              <div
                key={`${wi}-${di}`}
                onMouseEnter={() => day && setHovered(day)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  width: 12, height: 12,
                  background: day ? colorFor(day.total) : 'transparent',
                  borderRadius: 2, cursor: day ? 'pointer' : 'default',
                  transition: 'transform 0.1s',
                  transform: hovered === day ? 'scale(1.5)' : 'scale(1)',
                }}
                title={day ? `${day.date}: ${fmt(day.total)} (${day.count} txns)` : ''}
              />
            ))}
          </div>
        ))}
      </div>
      <div style={{
        marginTop: 8, display: 'flex', alignItems: 'center', gap: 12,
        fontSize: 11, color: 'var(--text-muted)',
      }}>
        <span>Less</span>
        {[
          'rgba(96,165,250,0.20)', 'rgba(96,165,250,0.50)',
          'rgba(251,191,36,0.65)', 'rgba(251,146,60,0.75)',
          'rgba(248,113,113,0.85)',
        ].map((c, i) => (
          <div key={i} style={{ width: 12, height: 12, background: c, borderRadius: 2 }} />
        ))}
        <span>More</span>
        {hovered && (
          <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>
            {hovered.date}: <strong style={{ color: 'var(--text-primary)' }}>{fmt(hovered.total)}</strong> · {hovered.count} txns
          </span>
        )}
      </div>
    </div>
  )
}
