/**
 * AgentExposure — cross-portfolio exposure of the Agentic sleeve vs your main portfolio.
 *
 * The agent trades a small universe; if it buys a name you already hold heavily elsewhere,
 * your true exposure is bigger than either view shows. This lists the agent's universe names
 * that you already own in your main accounts, with your existing weight — and flags the ones
 * the agent is currently proposing that you're already concentrated in. Read-only.
 */
import { useEffect, useState } from 'react'
import { Layers } from 'lucide-react'
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
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 2px 6px' }}>
            {data?.n_overlap || 0} of {data?.n_universe || 0} agent-universe names overlap your main portfolio.
          </p>
          <p style={{ fontSize: 12, color: 'var(--text-muted, var(--text-secondary))', margin: '0 2px 10px', fontStyle: 'italic' }}>
            Informational only — your other holdings don't limit what the agent buys. It trades its method in the
            isolated sleeve; this is just awareness of where the two books overlap.
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
