/**
 * AgentExposure — cross-portfolio exposure of the Agentic sleeve vs your main portfolio.
 *
 * The agent trades a small universe; if it buys a name you already hold heavily elsewhere,
 * your true exposure is bigger than either view shows. This lists the agent's universe names
 * that you already own in your main accounts, with your existing weight — and flags the ones
 * the agent is currently proposing that you're already concentrated in. Read-only.
 */
import { useEffect, useState } from 'react'
import { Layers, AlertTriangle } from 'lucide-react'
import { getAgentTradingExposure } from '../api/client'
import { formatCurrency } from '../lib/format'
import Pill from './Pill'

const RED = 'var(--accent-red, #ef4444)'
const pct = (x) => `${(x * 100).toFixed(1)}%`

export default function AgentExposure() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  useEffect(() => {
    getAgentTradingExposure()
      .then(setData).catch((e) => setErr(e.message || 'Failed to load exposure'))
      .finally(() => setLoading(false))
  }, [])

  const overlap = data?.overlap || []
  const warnings = data?.concentrated_proposals || []

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 22,
                  background: 'var(--bg-elevated, var(--bg-secondary))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <Layers size={18} style={{ color: 'var(--accent-blue, #3b82f6)' }} />
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Cross-portfolio exposure</h2>
        {data?.n_main_names > 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            main portfolio {formatCurrency(data.main_total)} · {data.n_main_names} names
          </span>
        )}
      </div>

      {loading && <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 2px' }}>Loading…</p>}
      {err && <p style={{ fontSize: 13, color: RED, margin: '4px 2px' }}>{err}</p>}

      {!loading && !err && (
        <>
          {warnings.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', marginBottom: 10,
                          border: `1px solid ${RED}`, borderRadius: 8, fontSize: 12.5,
                          background: 'color-mix(in srgb, var(--accent-red,#ef4444) 7%, transparent)' }}>
              <AlertTriangle size={16} style={{ color: RED, flexShrink: 0, marginTop: 1 }} />
              <span>
                The agent is proposing{' '}
                {warnings.map((w, i) => (
                  <strong key={w.ticker}>{i > 0 ? ', ' : ''}{w.ticker} ({pct(w.main_pct)} of main)</strong>
                ))}
                {' '}— you're already concentrated there. Combined exposure would be larger.
              </span>
            </div>
          )}

          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 2px 8px' }}>
            {data?.n_overlap || 0} of {data?.n_universe || 0} agent-universe names overlap your main portfolio.
          </p>

          {overlap.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '2px' }}>
              No overlap — the agent's universe and your main holdings are distinct (no doubling-up risk).
            </p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Ticker', 'In main portfolio', 'Weight', ''].map((h, i) => (
                    <th key={h} style={{ ...th, textAlign: i === 0 ? 'left' : i === 2 ? 'right' : 'left' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {overlap.map((r) => (
                  <tr key={r.ticker}>
                    <td style={{ ...td, fontWeight: 600 }}>{r.ticker}</td>
                    <td style={td}>{formatCurrency(r.main_value)}</td>
                    <td style={{ ...td, textAlign: 'right', color: r.concentrated ? RED : 'var(--text-primary)', fontWeight: r.concentrated ? 600 : 400 }}>
                      {pct(r.main_pct)}
                    </td>
                    <td style={td}>
                      {r.proposed && <Pill tone="info" soft>proposed now</Pill>}
                      {r.concentrated && <Pill tone="danger" soft>concentrated</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}

const th = { padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 600 }
const td = { padding: '6px 8px', borderBottom: '1px solid var(--border)' }
