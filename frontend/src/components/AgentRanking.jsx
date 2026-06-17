/**
 * AgentRanking — the rotation strategy's pick list, with your holdings marked.
 *
 * Ranks the whole universe under the rotation profile and shows where each name sits relative
 * to the two thresholds: BUY the top N, KEEP a held name until it falls past the (wider) exit
 * rank. That gap is the anti-churn buffer. The point is to see a rebalance coming — a holding
 * drifting toward the exit line, or a non-held name climbing into the buy zone. Read-only.
 */
import { useEffect, useState, useCallback } from 'react'
import { ListOrdered, RefreshCw, ArrowUp, ArrowDown } from 'lucide-react'
import { getAgentTradingRanking } from '../api/client'
import Pill from './Pill'

const GREEN = 'var(--accent-green, #10b981)'
const AMBER = 'var(--accent-orange, #f59e0b)'
const RED = 'var(--accent-red, #ef4444)'
const BLUE = 'var(--accent-blue, #3b82f6)'

// Each row's standing → a tone + label + the one fact that matters for a rebalance.
function standing(r, topN, exitN) {
  const buy = r.rank <= topN
  const buffer = r.rank > topN && r.rank <= exitN
  if (r.action === 'buy') return { tone: 'success', label: 'buying this cycle' }
  if (r.action === 'sell') return { tone: 'danger', label: 'rotating out', hint: 'fell past the keep cutoff' }
  if (r.held) {
    if (buy) return { tone: 'success', label: 'held · in basket', hint: `top ${topN}` }
    if (buffer) return { tone: 'warning', label: 'held · rebalance risk', hint: `${exitN - r.rank} from the exit line (#${exitN})` }
    return { tone: 'danger', label: 'held · below keep cutoff', hint: 'exits next cycle' }
  }
  if (buy) return { tone: 'info', label: 'in buy zone', hint: 'eligible to buy' }
  if (buffer) return { tone: 'neutral', label: 'on watch', hint: `${r.rank - topN} from the buy zone` }
  return { tone: 'neutral', label: 'below cutoff', hint: `needs to reach #${topN}` }
}

export default function AgentRanking() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    setLoading(true); setErr(null)
    getAgentTradingRanking('rotation')   // always the rotation view, regardless of the active profile
      .then(setData).catch((e) => setErr(e.message || 'Failed to load ranking'))
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  if (loading && !data) return <Shell><Muted>Loading ranking…</Muted></Shell>
  if (err) return <Shell><span style={{ color: RED, fontSize: 13 }}>{err}</span></Shell>
  if (!data?.configured) return <Shell><Muted>No research universe yet — the ranking populates once a domain is loaded.</Muted></Shell>

  const { top_n: topN, exit_n: exitN, ranking = [], connected, held_count } = data
  return (
    <Shell onReload={load}>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 2px 12px' }}>
        Buy the <strong>top {topN}</strong>; keep a holding until it falls past <strong>#{exitN}</strong> (the gap is the
        anti-churn buffer). {connected
          ? `${held_count} of your holdings shown in place.`
          : 'Connect the agent to mark your live holdings.'}
      </p>
      {!connected && (
        <Pill tone="neutral" soft style={{ marginBottom: 10 }}>holdings not live — showing ranks only</Pill>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {ranking.map((r, i) => {
          const s = standing(r, topN, exitN)
          const tone = { success: GREEN, warning: AMBER, danger: RED, info: BLUE, neutral: 'var(--text-secondary)' }[s.tone]
          const showBand = r.rank === topN || r.rank === exitN
          return (
            <div key={r.ticker}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                borderRadius: 8, background: r.held ? 'var(--bg-card, transparent)' : 'transparent',
                border: r.held ? `1px solid ${tone}` : '1px solid transparent',
              }}>
                <span style={{ width: 26, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                               fontWeight: 700, color: 'var(--text-secondary)' }}>{r.rank}</span>
                <span style={{ width: 64, fontWeight: r.held ? 700 : 600 }}>{r.ticker}</span>
                {r.held && <Pill tone="neutral" soft title={`avg cost $${r.avg_cost}`}>{(+r.held_qty).toFixed(2)} sh</Pill>}
                <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {s.hint && <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{s.hint}</span>}
                  <Pill tone={s.tone} soft style={{ color: tone, borderColor: tone, minWidth: 0 }}>{s.label}</Pill>
                  <span style={{ width: 54, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                 fontSize: 12.5, color: 'var(--text-secondary)' }}>{(+r.score).toFixed(3)}</span>
                  <TrendChip d={r.rank_delta} />
                </span>
              </div>
              {showBand && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
                  <div style={{ flex: 1, height: 1, background: r.rank === topN ? GREEN : AMBER, opacity: 0.5 }} />
                  <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
                                 color: r.rank === topN ? GREEN : AMBER }}>
                    {r.rank === topN ? 'buy line' : 'keep / exit line'}
                  </span>
                  <div style={{ flex: 1, height: 1, background: r.rank === topN ? GREEN : AMBER, opacity: 0.5 }} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Shell>
  )
}

// Rank trend since the last daily snapshot: ▲+2 climbed (green), ▼3 fell (red), flat, or blank
// when there's no prior day yet. Lower rank number = better, so a positive delta is an up-arrow.
function TrendChip({ d }) {
  if (d == null) return <span style={{ width: 40 }} title="no prior snapshot yet" />
  if (d === 0) return <span style={{ width: 40, textAlign: 'right', fontSize: 12, color: 'var(--text-muted, var(--text-secondary))' }}>–</span>
  const up = d > 0
  const color = up ? GREEN : RED
  const Icon = up ? ArrowUp : ArrowDown
  return (
    <span style={{ width: 40, display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 1,
                   color, fontSize: 12.5, fontWeight: 700 }}
          title={`${up ? 'climbed' : 'fell'} ${Math.abs(d)} rank${Math.abs(d) === 1 ? '' : 's'} since the last snapshot`}>
      <Icon size={13} />{Math.abs(d)}
    </span>
  )
}

function Shell({ children, onReload }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 22,
                  background: 'var(--bg-elevated, var(--bg-secondary))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <ListOrdered size={18} style={{ color: BLUE }} />
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Rotation ranking</h2>
        {onReload && (
          <button onClick={onReload} title="Reload" style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
            fontSize: 12, border: '1px solid var(--border)', borderRadius: 7, background: 'transparent',
            color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <RefreshCw size={13} /> Reload
          </button>
        )}
      </div>
      {children}
    </div>
  )
}

const Muted = ({ children }) => <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 2px' }}>{children}</p>
