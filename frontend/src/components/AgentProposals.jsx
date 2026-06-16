/**
 * AgentProposals — the human-in-the-loop approval queue.
 *
 * The read-only cycle runs the Analyst → guardrail gate and queues each gate-APPROVED order
 * here. You Approve or Reject each one. Approving marks it ready-to-place; it does NOT place a
 * trade from this screen — placement is bound to your approval and done by the backend once it's
 * the authorized Robinhood agent. Rejecting discards it. Nothing here can move money on its own.
 */
import { useEffect, useState, useCallback } from 'react'
import { ClipboardCheck, Check, X, RefreshCw, ShieldCheck } from 'lucide-react'
import {
  getAgentTradingProposals,
  generateAgentTradingProposals,
  approveAgentTradingProposal,
  rejectAgentTradingProposal,
} from '../api/client'
import { formatCurrency } from '../lib/format'
import Pill from './Pill'

const GREEN = 'var(--accent-green, #10b981)'
const RED = 'var(--accent-red, #ef4444)'
const BLUE = 'var(--accent-blue, #3b82f6)'
const usd = (n) => (n == null ? '—' : formatCurrency(n))

export default function AgentProposals() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)        // id or 'generate' currently acting
  const [err, setErr] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    getAgentTradingProposals()
      .then(setData).catch((e) => setErr(e.message || 'Failed to load proposals'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const act = async (fn, key) => {
    setBusy(key); setErr(null)
    try { await fn() } catch (e) { setErr(e.message || 'Action failed') }
    finally { setBusy(null); load() }
  }

  const pending = (data?.proposals || []).filter((p) => p.status === 'pending')
  const counts = data?.counts || {}

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 22,
                  background: 'var(--bg-elevated, var(--bg-secondary))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <ClipboardCheck size={18} style={{ color: BLUE }} />
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Orders awaiting your approval</h2>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          {counts.approved > 0 && <Pill tone="success" soft>{counts.approved} approved</Pill>}
          {counts.rejected > 0 && <Pill tone="neutral" soft>{counts.rejected} rejected</Pill>}
          <button onClick={() => act(() => generateAgentTradingProposals(), 'generate')} disabled={busy === 'generate'}
            style={genBtn}>
            <RefreshCw size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
            {busy === 'generate' ? 'Running…' : 'Run cycle'}
          </button>
        </span>
      </div>

      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 2px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <ShieldCheck size={14} style={{ color: GREEN }} />
        These passed the guardrail gate. Approving queues an order for the bound agent to place —
        nothing is placed from this screen, and rejecting discards it.
      </p>

      {err && <p style={{ fontSize: 13, color: RED, margin: '4px 2px' }}>{err}</p>}
      {loading && !data && <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 2px' }}>Loading…</p>}

      {!loading && pending.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '2px' }}>
          No orders waiting. Run a cycle to have the Analyst propose trades for your review.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {pending.map((p) => {
            const buy = p.side === 'buy'
            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                                       border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-card, transparent)' }}>
                <span style={{ ...sideBadge, color: buy ? GREEN : RED,
                               borderColor: buy ? GREEN : RED }}>{buy ? 'BUY' : 'SELL'}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 650 }}>
                    {p.ticker} <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>
                      · ~{usd(p.est_notional)} @ {usd(p.est_price)}{p.qty ? ` · ${(+p.qty).toFixed(2)} sh` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.rationale}
                  </div>
                  {(p.guardrail_notes || []).length > 0 && (
                    <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {p.guardrail_notes.map((n, i) => <Pill key={i} tone="warning" soft>{n}</Pill>)}
                    </div>
                  )}
                </div>
                <button onClick={() => act(() => approveAgentTradingProposal(p.id), p.id)} disabled={busy === p.id}
                  title="Approve — queues this order for the bound agent to place" style={{ ...actBtn, color: GREEN, borderColor: GREEN }}>
                  <Check size={15} /> Approve
                </button>
                <button onClick={() => act(() => rejectAgentTradingProposal(p.id), p.id)} disabled={busy === p.id}
                  title="Reject — discard this order" style={{ ...actBtn, color: RED, borderColor: RED }}>
                  <X size={15} /> Reject
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

const genBtn = {
  fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 7, cursor: 'pointer',
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
}
const sideBadge = {
  fontSize: 11, fontWeight: 700, letterSpacing: 0.4, padding: '3px 8px', borderRadius: 6,
  border: '1px solid', flexShrink: 0,
}
const actBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600,
  padding: '6px 11px', borderRadius: 8, cursor: 'pointer', border: '1px solid', background: 'transparent',
  flexShrink: 0,
}
