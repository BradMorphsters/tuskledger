/**
 * AgentProposals — the human-in-the-loop approval queue.
 *
 * The read-only cycle runs the Analyst → guardrail gate and queues each gate-APPROVED order
 * here. You Approve or Reject each one. Approving marks it ready-to-place; it does NOT place a
 * trade from this screen — placement is bound to your approval and done by the backend once it's
 * the authorized Robinhood agent. Rejecting discards it. Nothing here can move money on its own.
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { ClipboardCheck, Check, X, RefreshCw, ShieldCheck, CheckCircle2, Clock, AlertTriangle } from 'lucide-react'
import {
  getAgentTradingProposals,
  generateAgentTradingProposals,
  approveAgentTradingProposal,
  rejectAgentTradingProposal,
  getAgentTradingOrderStatus,
  reconcileAgentTradingOrders,
} from '../api/client'
import { formatCurrency } from '../lib/format'
import Pill from './Pill'

const GREEN = 'var(--accent-green, #10b981)'
const RED = 'var(--accent-red, #ef4444)'
const BLUE = 'var(--accent-blue, #3b82f6)'
const AMBER = 'var(--accent-orange, #f59e0b)'
const usd = (n) => (n == null ? '—' : formatCurrency(n))

export default function AgentProposals() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)        // id or 'generate' currently acting
  const [err, setErr] = useState(null)
  const [cycleResult, setCycleResult] = useState(null)
  const [placeResult, setPlaceResult] = useState(null)  // last approve outcome: {ticker, state, executed, ...}
  const pollRef = useRef(null)

  const load = useCallback(() => {
    setLoading(true)
    getAgentTradingProposals()
      .then(setData).catch((e) => setErr(e.message || 'Failed to load proposals'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])
  // On mount, ask the backend to read back any placed-but-not-filled orders so a queued order
  // that has since filled flips to FILLED on the timeline (the emitted event streams in via SSE).
  useEffect(() => { reconcileAgentTradingOrders().catch(() => {}) }, [])
  useEffect(() => () => clearTimeout(pollRef.current), [])  // cleanup poll on unmount

  const act = async (fn, key) => {
    setBusy(key); setErr(null)
    try { await fn() } catch (e) { setErr(e.message || 'Action failed') }
    finally { setBusy(null); load() }
  }

  // Approve → capture the placement outcome, then (if the order is queued, not yet filled) poll
  // the order-status read-back a few times to flip QUEUED → FILLED without a manual refresh.
  const approve = async (p) => {
    setBusy(p.id); setErr(null); setPlaceResult(null)
    clearTimeout(pollRef.current)
    try {
      const res = await approveAgentTradingProposal(p.id)
      setPlaceResult({ ticker: p.ticker, ...res })
      if (res.placed && !res.executed) {
        let tries = 0
        const poll = async () => {
          tries += 1
          try {
            const st = await getAgentTradingOrderStatus(p.id)
            if (st.found) setPlaceResult((r) => (r && r.ticker === p.ticker ? { ...r, ...st } : r))
            if (st.executed || tries >= 6) return
          } catch { /* keep last result */ }
          pollRef.current = setTimeout(poll, 5000)
        }
        pollRef.current = setTimeout(poll, 4000)
      }
    } catch (e) { setErr(e.message || 'Approve failed') }
    finally { setBusy(null); load() }
  }

  const runCycle = async () => {
    setBusy('generate'); setErr(null)
    try {
      setCycleResult(await generateAgentTradingProposals())
    } catch (e) { setErr(e.message || 'Run failed') }
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
          <button onClick={runCycle} disabled={busy === 'generate'} style={genBtn}>
            <RefreshCw size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
            {busy === 'generate' ? 'Running…' : 'Run cycle'}
          </button>
        </span>
      </div>

      {cycleResult && (
        <div style={{ margin: '0 2px 10px' }}>
          <p style={{ fontSize: 12, color: 'var(--text-muted, var(--text-secondary))', margin: '0 0 4px', fontStyle: 'italic' }}>
            {cycleResult.note}
          </p>
          {[...(cycleResult.blocked_detail || []), ...(cycleResult.stale_skipped || [])].length > 0 && (
            <p style={{ fontSize: 11.5, color: 'var(--text-secondary)', margin: 0 }}>
              <strong>Not proposed this cycle:</strong>{' '}
              {[
                ...(cycleResult.blocked_detail || []).map((b) => `${b.ticker} — ${b.reason}`),
                ...(cycleResult.stale_skipped || []).map((s) => `${s.ticker} — ${s.reason}`),
              ].join(' · ')}
            </p>
          )}
        </div>
      )}

      {placeResult && <PlaceResult r={placeResult} />}

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
            const isLimit = p.order_type === 'limit' && p.limit_price != null
            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
                                       border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-card, transparent)' }}>
                <span style={{ ...sideBadge, color: buy ? GREEN : RED,
                               borderColor: buy ? GREEN : RED }}>{buy ? 'BUY' : 'SELL'}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 650 }}>
                    {p.ticker} <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>
                      · ~{usd(p.est_notional)}{p.qty ? ` · ${(+p.qty).toFixed(isLimit ? 0 : 2)} sh` : ''}
                      {isLimit ? <> · <span style={{ color: AMBER, fontWeight: 600 }}>
                        limit {usd(p.limit_price)} {buy ? 'max' : 'min'}</span></>
                        : ` @ ${usd(p.est_price)}`}
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
                <button onClick={() => approve(p)} disabled={busy === p.id}
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

function PlaceResult({ r }) {
  // No live broker armed: approval recorded, nothing placed — neutral note.
  if (r.placed === false && r.ok !== false) {
    return <Banner color="var(--text-secondary)" icon={Clock}
      text={`${r.ticker} approved. ${r.note || 'No live broker armed, so nothing was placed.'}`} />
  }
  // Genuine reject/error from the broker.
  if (r.ok === false) {
    return <Banner color={RED} icon={AlertTriangle} text={`${r.ticker} not placed — ${r.reason || 'broker rejected the order.'}`} />
  }
  const oid = (r.fill?.order_id || r.order_id || '').slice(0, 8)
  const qty = r.filled_qty || r.fill?.qty
  const qtyTxt = qty ? ` · ${(+qty).toFixed(4)} sh` : ''
  // Executed — shares in hand.
  if (r.executed) {
    return <Banner color={GREEN} icon={CheckCircle2}
      text={`${r.ticker} FILLED${qtyTxt}${oid ? ` · order ${oid}` : ''}`} />
  }
  // Accepted but still queued — this is the "warning", not a failure.
  return <Banner color={AMBER} icon={Clock}
    text={`${r.ticker} placed — ${r.state || 'submitted'}, not yet filled${oid ? ` · order ${oid}` : ''}. Checking for fill…`} />
}

function Banner({ color, icon: Icon, text }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 2px 10px', padding: '8px 11px',
                  border: `1px solid ${color}`, borderRadius: 9, background: 'var(--bg-card, transparent)' }}>
      <Icon size={15} style={{ color, flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{text}</span>
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
