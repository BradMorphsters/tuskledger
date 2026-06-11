import { useEffect, useState } from 'react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine } from 'recharts'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { getCashFlowForecast } from '../../api/client'
import { SkeletonCard } from '../Skeleton'
import { fmtMoney, tileCardStyle } from './shared'

// Compact dollar formatter for chart tick labels — keeps the y-axis
// width small so the line drawing area gets maximum width.
function fmtCompactMoney(v) {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${Math.round(v / 1_000)}k`
  return `$${Math.round(v)}`
}

// CashFlowForecast uses the existing /analytics/cash-flow-forecast
// endpoint (recurring detector + variable-spend baseline) — not our
// own naive version. The import is at the top of the file already.

export function CashFlowForecast() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    getCashFlowForecast(90).then(d => { setData(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <SkeletonCard titleWidth="40%" rows={5} />
  if (!data || !data.series || !data.series.length) return null

  // Adapt to the existing endpoint's data shape:
  // series rows have { date, balance, ... }, plus low_point + per-day rates
  const startBal = data.series[0]?.balance || 0
  const endBal = data.series[data.series.length - 1]?.balance || 0
  const netChange = endBal - startBal
  const trending = netChange >= 0
  const Icon = trending ? TrendingUp : TrendingDown
  const trendColor = trending ? 'var(--accent-green)' : 'var(--accent-red)'

  // Min/max from the series for "lowest point" footer summary. The endpoint
  // ships its own low_point (worst balance) but we also want a max for
  // quick range context, so derive both from the series.
  const balances = data.series.map(s => s.balance)
  const seriesMin = Math.min(...balances)
  const seriesMax = Math.max(...balances)
  const minPoint = data.low_point || data.series.find(s => s.balance === seriesMin)
  const lowIsNegative = minPoint && minPoint.balance < 0

  return (
    <div className="card" style={tileCardStyle}>
      {/* Compact title bar — drops the technical "recurring + variable spend"
          subtitle (it took space and meant nothing to a casual viewer). */}
      <div className="card-header" style={{ marginBottom: 4 }}>
        <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon size={14} style={{ color: trendColor }} /> Cash flow forecast
        </span>
        <span style={{
          fontSize: 10, color: 'var(--text-muted)',
          padding: '2px 6px', border: '1px solid var(--border)', borderRadius: 10,
        }}>
          90 days
        </span>
      </div>

      {/* Negative-balance warning ribbon — promoted to the TOP so it's the
          first thing the user sees if their cash dips below zero. */}
      {lowIsNegative && (
        <div style={{
          padding: '6px 10px', marginBottom: 8,
          background: 'rgba(248,113,113,0.08)',
          border: '1px solid rgba(248,113,113,0.3)',
          borderRadius: 6, fontSize: 11, color: 'var(--accent-red)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        }}>
          <span>⚠ Cash dips to <strong>{fmtMoney(minPoint.balance)}</strong></span>
          <span style={{ color: 'var(--text-muted)' }}>{minPoint.date?.slice(5)}</span>
        </div>
      )}

      {/* Hero: today → projected, with arrow and delta in between. Replaces
          the old cramped 3-column grid where "Net change +" / "Net change −"
          used two unnecessary slots. Now it reads naturally L-to-R. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 0 10px',
      }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Today
          </div>
          <div style={{
            fontSize: 18, fontWeight: 600, color: 'var(--text-primary)',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {fmtMoney(startBal)}
          </div>
        </div>

        {/* Center delta block — colored pill with arrow + amount */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          padding: '0 4px', flexShrink: 0,
        }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '2px 8px', borderRadius: 10,
            background: trending ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)',
            color: trendColor, fontSize: 11, fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {trending ? '+' : '−'}{fmtMoney(Math.abs(netChange))}
          </div>
          <div style={{ fontSize: 16, color: 'var(--text-muted)', marginTop: -2 }}>→</div>
        </div>

        <div style={{ flex: '1 1 auto', minWidth: 0, textAlign: 'right' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            In 90 days
          </div>
          <div style={{
            fontSize: 18, fontWeight: 600, color: trendColor,
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {fmtMoney(endBal)}
          </div>
        </div>
      </div>

      {/* Chart fills remaining vertical space so the tile sizes match its
          siblings whatever the row height ends up being. The narrower
          left-axis tick formatter saves horizontal real estate so the
          line itself gets the room it needs. */}
      <div style={{ flex: '1 1 0', minHeight: 110 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.series} margin={{ top: 4, right: 4, left: -8, bottom: 0 }}>
            <XAxis
              dataKey="date"
              tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
              tickFormatter={d => d?.slice(5)}
              minTickGap={32}
            />
            <YAxis
              tick={{ fill: 'var(--text-muted)', fontSize: 10 }}
              tickFormatter={v => fmtCompactMoney(v)}
              width={42}
            />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}
              formatter={v => fmtMoney(v)}
              labelFormatter={d => d}
            />
            {/* Reference lines: zero gets dashed red as before; today's
                balance gets a faint horizontal so the chart self-explains
                "you're heading up/down from here". */}
            <ReferenceLine y={0} stroke="var(--accent-red)" strokeDasharray="3 3" />
            <ReferenceLine y={startBal} stroke="var(--text-muted)" strokeDasharray="2 4" strokeOpacity={0.5} />
            <Line type="monotone" dataKey="balance" stroke={trendColor} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Footer summary — min/max range as a compact strip, replaces the
          standalone low-point alert (which still appears at the TOP if
          the dip is actually negative). Always visible, gives spatial
          range context for the chart. */}
      <div style={{
        marginTop: 6, paddingTop: 6,
        borderTop: '1px solid var(--border)',
        display: 'flex', justifyContent: 'space-between',
        fontSize: 10, color: 'var(--text-muted)',
      }}>
        <span>
          Low: <span style={{
            color: lowIsNegative ? 'var(--accent-red)' : 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}>{fmtMoney(seriesMin)}</span>
        </span>
        <span>
          High: <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {fmtMoney(seriesMax)}
          </span>
        </span>
      </div>
    </div>
  )
}
