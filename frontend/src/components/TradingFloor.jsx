/**
 * TradingFloor — a playful "theater" replay of a cycle as a staggered conversation.
 *
 * The same cycle events that drive the live timeline, re-skinned as a trading desk of role
 * characters (Analyst, Sizer, Risk Officer, Portfolio Manager, Broker) who "talk" in
 * sequence: the Analyst raises a name, the Sizer sets the amount, the Risk Officer runs the
 * guardrails, the PM approves, the Broker notes nothing's placed. It's a visualization of
 * the *reasoning* — the real numbers live in the timeline + tables. Read-only; nothing trades.
 *
 * No game engine: lightweight inline-SVG avatars + CSS, client-side staggered replay over the
 * events we already emit. Characters are original CC0-style SVG (no third-party sprite assets).
 */
import { useEffect, useRef, useState } from 'react'
import { Play, RotateCcw } from 'lucide-react'
import { getAgentTradingEvents, runAgentTradingDemo } from '../api/client'

const ROLES = {
  analyst: { name: 'Analyst', color: '#3b82f6' },
  sizer:   { name: 'Sizer', color: '#8b5cf6' },
  risk:    { name: 'Risk Officer', color: '#f59e0b' },
  pm:      { name: 'Portfolio Mgr', color: '#10b981' },
  broker:  { name: 'Broker', color: '#6b7280' },
}
const ORDER = ['analyst', 'sizer', 'risk', 'pm', 'broker']

// Map a cycle event to who speaks and what they say.
function lineFor(ev) {
  const t = ev.ticker ? ` ${ev.ticker}` : ''
  switch (ev.type) {
    case 'cycle_started':   return { role: 'pm', text: "New cycle — let's review." }
    case 'read':            return { role: 'analyst', text: ev.label + (ev.detail ? ` (${ev.detail})` : '') }
    case 'decision':        return { role: 'analyst', text: `Looking at${t}.${ev.detail ? ' ' + ev.detail : ''}` }
    case 'sized':           return { role: 'sizer', text: ev.label }
    case 'gate_check':      return {
      role: 'risk',
      text: ev.status === 'blocked' ? `✗ ${ev.label}: ${ev.detail}`
          : ev.status === 'warn'    ? `⚠ ${ev.label}: ${ev.detail}`
          : `✓ ${ev.label}`,
      status: ev.status,
    }
    case 'approved':        return { role: 'pm', text: `Approved.${t}${ev.detail ? ' — ' + ev.detail : ''}`, status: 'ok' }
    case 'blocked':         return { role: 'risk', text: `Blocking${t}.${ev.detail ? ' ' + ev.detail : ''}`, status: 'blocked' }
    case 'skipped':         return { role: 'analyst', text: `Holding on${t}.` }
    case 'halted':          return { role: 'risk', text: `Halt — ${ev.detail || 'drawdown limit'}`, status: 'blocked' }
    case 'cycle_completed': return { role: 'broker', text: `${ev.label}. Nothing placed — awaiting human arm.` }
    default:                return { role: 'analyst', text: ev.label }
  }
}

function Avatar({ role, speaking }) {
  const c = ROLES[role].color
  return (
    <svg width="54" height="62" viewBox="0 0 54 62" className={speaking ? 'tf-speak' : 'tf-idle'}
         style={{ overflow: 'visible' }}>
      <ellipse cx="27" cy="58" rx="16" ry="3.5" fill="rgba(0,0,0,0.12)" />
      <rect x="13" y="30" width="28" height="26" rx="11" fill={c} />          {/* body */}
      <circle cx="27" cy="18" r="12" fill={c} />                              {/* head */}
      <circle cx="27" cy="18" r="12" fill="rgba(255,255,255,0.14)" />
      <circle cx="22.5" cy="17" r="1.7" fill="#fff" />
      <circle cx="31.5" cy="17" r="1.7" fill="#fff" />
    </svg>
  )
}

export default function TradingFloor() {
  const [speaking, setSpeaking] = useState(null)
  const [bubble, setBubble] = useState({})       // role -> {text,status}
  const [transcript, setTranscript] = useState([])
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')
  const timers = useRef([])
  const scriptRef = useRef(null)

  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const reset = () => {
    timers.current.forEach(clearTimeout); timers.current = []
    setSpeaking(null); setBubble({}); setTranscript([])
  }

  const playCycle = (events) => {
    reset()
    if (!events.length) { setHint('No cycle to replay yet — run a demo cycle.'); return }
    setHint('')
    events.forEach((ev, i) => {
      const t = setTimeout(() => {
        const line = lineFor(ev)
        setSpeaking(line.role)
        setBubble({ [line.role]: { text: line.text, status: line.status } })
        setTranscript((prev) => [...prev, { ...line, key: i }])
        if (i === events.length - 1) setTimeout(() => setSpeaking(null), 1200)
      }, i * 950)
      timers.current.push(t)
    })
  }

  const latestCycleEvents = (all) => {
    if (!all.length) return []
    const id = all[all.length - 1].cycle_id
    return all.filter((e) => e.cycle_id === id)
  }

  const replayLatest = async () => {
    setBusy(true); setHint('')
    try {
      const { events } = await getAgentTradingEvents(500)
      playCycle(latestCycleEvents(events || []))
    } catch { setHint('Could not load events.') } finally { setBusy(false) }
  }

  const runAndPlay = async () => {
    setBusy(true); setHint('Gathering the team…'); reset()
    try {
      await runAgentTradingDemo()                      // server emits a fresh cycle
      const { events } = await getAgentTradingEvents(500)
      playCycle(latestCycleEvents(events || []))
    } catch { setHint('Demo failed.') } finally { setBusy(false) }
  }

  // keep transcript scrolled to newest
  useEffect(() => { const el = scriptRef.current; if (el) el.scrollTop = el.scrollHeight }, [transcript])

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 22,
      background: 'var(--bg-elevated, var(--bg-secondary))',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Trading floor</h2>
        <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>a replay of the cycle as a conversation</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={runAndPlay} disabled={busy} style={btn(busy)}>
            <Play size={13} /> {busy ? 'Setting up…' : 'Run demo cycle'}
          </button>
          <button onClick={replayLatest} disabled={busy} style={btnGhost}>
            <RotateCcw size={13} /> Replay latest
          </button>
        </div>
      </div>

      {/* the floor */}
      <div style={{
        display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end',
        gap: 8, padding: '34px 8px 14px', minHeight: 150,
        borderBottom: '2px solid var(--border)', position: 'relative',
      }}>
        {ORDER.map((role) => (
          <div key={role} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', flex: 1 }}>
            {bubble[role] && (
              <div style={{
                position: 'absolute', bottom: 72, maxWidth: 190, padding: '7px 10px', fontSize: 12,
                lineHeight: 1.3, borderRadius: 10, textAlign: 'center',
                background: 'var(--bg-primary, #fff)',
                border: `1px solid ${bubble[role].status === 'blocked' ? 'var(--accent-red,#ef4444)'
                  : bubble[role].status === 'ok' ? 'var(--accent-green,#10b981)'
                  : bubble[role].status === 'warn' ? 'var(--accent-orange,#f59e0b)' : 'var(--border)'}`,
                color: 'var(--text-primary)', boxShadow: '0 2px 8px rgba(0,0,0,0.08)', zIndex: 2,
                animation: 'tf-pop 0.18s ease-out',
              }}>
                {bubble[role].text}
              </div>
            )}
            <Avatar role={role} speaking={speaking === role} />
            <span style={{
              marginTop: 4, fontSize: 11, fontWeight: 600,
              color: speaking === role ? ROLES[role].color : 'var(--text-secondary)',
            }}>{ROLES[role].name}</span>
          </div>
        ))}
      </div>

      {/* transcript */}
      <div ref={scriptRef} style={{ maxHeight: 150, overflowY: 'auto', marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {hint && <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '6px 2px' }}>{hint}</p>}
        {transcript.map((l) => (
          <div key={l.key} style={{ fontSize: 12.5, display: 'flex', gap: 7 }}>
            <span style={{ fontWeight: 600, color: ROLES[l.role].color, flexShrink: 0, minWidth: 92 }}>
              {ROLES[l.role].name}
            </span>
            <span style={{ color: 'var(--text-primary)' }}>{l.text}</span>
          </div>
        ))}
      </div>

      <p style={{ margin: '10px 2px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
        A visualization of the decision process. The authoritative numbers are in the timeline and tables. Nothing here trades.
      </p>

      <style>{`
        @keyframes tf-pop { from { opacity: 0; transform: translateY(4px) scale(0.96); } to { opacity: 1; transform: none; } }
        .tf-idle { animation: tf-bob 3s ease-in-out infinite; }
        .tf-speak { animation: tf-bob 0.7s ease-in-out infinite; }
        @keyframes tf-bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
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
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', fontSize: 12.5,
  border: '1px solid var(--border)', borderRadius: 8, background: 'transparent',
  color: 'var(--text-secondary)', cursor: 'pointer',
}
