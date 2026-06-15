/**
 * AgentActivity — the live "watch the agent think" timeline.
 *
 * Connects to the backend SSE stream (/api/agent-trading/stream) and renders each
 * execution event as it arrives: cycle start, account read + reconcile, then per order
 * the decision, the size, every guardrail check, and the APPROVED/BLOCKED verdict — the
 * trace-timeline pattern (LangSmith / AG-UI). A "Run demo cycle" button emits a sample
 * cycle so you can see the stream animate without a real run. Read-only; nothing trades.
 */
import { useEffect, useRef, useState } from 'react'
import { Activity, CheckCircle2, XCircle, AlertTriangle, Circle, Loader2, Play, Trash2, Radio } from 'lucide-react'
import { runAgentTradingDemo } from '../api/client'

const STREAM_URL = '/api/agent-trading/stream'

const TONE = {
  ok:      'var(--accent-green, #10b981)',
  blocked: 'var(--accent-red, #ef4444)',
  halted:  'var(--accent-red, #ef4444)',
  warn:    'var(--accent-orange, #f59e0b)',
  running: 'var(--accent-blue, #3b82f6)',
  info:    'var(--text-secondary, #6b7280)',
}

function StatusIcon({ status }) {
  const c = TONE[status] || TONE.info
  const p = { size: 15, style: { color: c, flexShrink: 0 } }
  if (status === 'ok') return <CheckCircle2 {...p} />
  if (status === 'blocked' || status === 'halted') return <XCircle {...p} />
  if (status === 'warn') return <AlertTriangle {...p} />
  if (status === 'running') return <Loader2 {...p} className="spin" />
  return <Circle {...p} />
}

const BOLD = new Set(['cycle_started', 'cycle_completed', 'approved', 'blocked', 'halted'])
const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString() } catch { return '' } }

export default function AgentActivity() {
  const [events, setEvents] = useState([])
  const [connected, setConnected] = useState(false)
  const [running, setRunning] = useState(false)
  const listRef = useRef(null)

  useEffect(() => {
    if (typeof EventSource === 'undefined') return  // jsdom / unsupported — no-op
    const es = new EventSource(STREAM_URL, { withCredentials: true })
    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data)
        setEvents((prev) => [...prev.slice(-499), ev])
      } catch { /* heartbeat / non-JSON */ }
    }
    return () => es.close()
  }, [])

  // auto-scroll to newest
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events])

  const runDemo = async () => {
    setRunning(true)
    try { await runAgentTradingDemo() } catch { /* ignore */ }
    finally { setTimeout(() => setRunning(false), 5000) }
  }

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 22,
      background: 'var(--bg-elevated, var(--bg-secondary))',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Activity size={18} style={{ color: 'var(--accent-blue, #3b82f6)' }} />
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Agent activity</h2>
        <span title={connected ? 'Live stream connected' : 'Stream offline'} style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
          color: connected ? TONE.ok : TONE.info,
        }}>
          <Radio size={12} className={connected ? 'pulse' : ''} /> {connected ? 'LIVE' : 'offline'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={runDemo} disabled={running} style={btn(running)}>
            <Play size={13} /> {running ? 'Running…' : 'Run demo cycle'}
          </button>
          <button onClick={() => setEvents([])} title="Clear view" style={btnGhost}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div ref={listRef} style={{
        maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2,
        fontSize: 13, paddingRight: 4,
      }}>
        {events.length === 0 ? (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '8px 4px' }}>
            No activity yet. Hit <strong>Run demo cycle</strong> to watch a cycle stream through
            the gate step by step — it places nothing.
          </p>
        ) : events.map((e, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 9, padding: '5px 6px', borderRadius: 7,
            background: BOLD.has(e.type) ? 'var(--bg-secondary, transparent)' : 'transparent',
          }}>
            <span style={{ marginTop: 1 }}><StatusIcon status={e.status} /></span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span style={{ fontWeight: BOLD.has(e.type) ? 650 : 450,
                               color: e.status === 'blocked' || e.status === 'halted' ? TONE.blocked : 'var(--text-primary)' }}>
                  {e.label}
                </span>
                {e.ticker && <span style={chip}>{e.ticker}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                  {fmtTime(e.ts)}
                </span>
              </div>
              {e.detail && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>{e.detail}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <p style={{ margin: '10px 4px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
        Streamed live over SSE. APPROVED orders are <em>not</em> placed — execution is a separate, human-armed step.
      </p>

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .pulse { animation: pulse 1.4s ease-in-out infinite; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      `}</style>
    </div>
  )
}

const btn = (disabled) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', fontSize: 12.5,
  fontWeight: 600, border: '1px solid var(--accent-blue, #3b82f6)', borderRadius: 8,
  background: 'transparent', color: 'var(--accent-blue, #3b82f6)',
  cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
})
const btnGhost = {
  display: 'inline-flex', alignItems: 'center', padding: '6px 9px', border: '1px solid var(--border)',
  borderRadius: 8, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
}
const chip = {
  fontSize: 10.5, fontWeight: 600, padding: '1px 6px', borderRadius: 5,
  background: 'var(--bg-secondary, #eee)', color: 'var(--text-secondary)',
}
