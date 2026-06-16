/**
 * TradingFloor — an interactive, "alive" replay of a cycle as a staggered conversation.
 *
 * The cycle events that drive the live timeline, re-skinned as a trading desk of role
 * characters who talk in sequence. Interactive: play / pause / step / speed + a scrubber,
 * a history picker to replay any past cycle, and click a character or order ticket to drill
 * into the full reasoning / guardrail trace. Alive: role props, status-driven expressions,
 * the speaker steps forward, an order ticket travels the line and gets stamped
 * APPROVED / BLOCKED, plus a wall clock and a market-open light.
 *
 * No game engine, no third-party sprite assets — original inline SVG + CSS. It's a
 * visualization of the *reasoning*; the authoritative numbers live in the timeline + tables.
 * Read-only — nothing here trades.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, RotateCcw, X } from 'lucide-react'
import { getAgentTradingEvents, runAgentTradingDemo } from '../api/client'

const ROLES = {
  analyst: { name: 'Analyst', color: '#3b82f6', prop: 'chart' },
  sizer:   { name: 'Sizer', color: '#8b5cf6', prop: 'scale' },
  risk:    { name: 'Risk Officer', color: '#f59e0b', prop: 'shield' },
  pm:      { name: 'Portfolio Mgr', color: '#10b981', prop: 'clipboard' },
  broker:  { name: 'Broker', color: '#6b7280', prop: 'phone' },
}
const ORDER = ['analyst', 'sizer', 'risk', 'pm', 'broker']
const BASE_MS = 950

function lineFor(ev) {
  const t = ev.ticker ? ` ${ev.ticker}` : ''
  switch (ev.type) {
    case 'cycle_started':   return { role: 'pm', text: "New cycle — let's review.", mood: 'thinking' }
    case 'read':            return { role: 'analyst', text: ev.label + (ev.detail ? ` (${ev.detail})` : ''), mood: 'thinking' }
    case 'decision':        return { role: 'analyst', text: `Looking at${t}.${ev.detail ? ' ' + ev.detail : ''}`, mood: 'thinking' }
    case 'sized':           return { role: 'sizer', text: ev.label, mood: 'thinking' }
    case 'gate_check':      return {
      role: 'risk', status: ev.status, mood: ev.status === 'blocked' ? 'frown' : 'thinking',
      text: ev.status === 'blocked' ? `✗ ${ev.label}: ${ev.detail}` : ev.status === 'warn' ? `⚠ ${ev.label}: ${ev.detail}` : `✓ ${ev.label}`,
    }
    case 'approved':        return { role: 'pm', status: 'ok', mood: 'happy', text: `Approved.${t}${ev.detail ? ' — ' + ev.detail : ''}` }
    case 'blocked':         return { role: 'risk', status: 'blocked', mood: 'frown', text: `Blocking${t}.${ev.detail ? ' ' + ev.detail : ''}` }
    case 'skipped':         return { role: 'analyst', text: `Holding on${t}.`, mood: 'neutral' }
    case 'halted':          return { role: 'risk', status: 'blocked', mood: 'frown', text: `Halt — ${ev.detail || 'drawdown limit'}` }
    case 'cycle_completed': return { role: 'broker', status: 'ok', mood: 'happy', text: `${ev.label}. Nothing placed — awaiting human arm.` }
    default:                return { role: 'analyst', text: ev.label, mood: 'neutral' }
  }
}

function Prop({ kind, color }) {
  switch (kind) {
    case 'chart':     return <g><rect x="44" y="42" width="3" height="8" fill={color} /><rect x="48.5" y="38" width="3" height="12" fill={color} /><rect x="53" y="34" width="3" height="16" fill={color} /></g>
    case 'scale':     return <g stroke={color} strokeWidth="1.6" fill="none"><line x1="50" y1="34" x2="50" y2="48" /><line x1="44" y1="38" x2="56" y2="38" /><circle cx="44" cy="42" r="2.2" /><circle cx="56" cy="42" r="2.2" /></g>
    case 'shield':    return <path d="M50 33 l6 2.5 v6 c0 4 -3 6 -6 7.5 c-3 -1.5 -6 -3.5 -6 -7.5 v-6 z" fill={color} opacity="0.9" />
    case 'clipboard': return <g><rect x="45" y="34" width="11" height="15" rx="1.5" fill={color} /><rect x="48" y="32" width="5" height="3" rx="1" fill="#fff" opacity="0.8" /><path d="M47.5 41 l2 2 l4 -4" stroke="#fff" strokeWidth="1.4" fill="none" /></g>
    case 'phone':     return <g><rect x="47" y="34" width="8" height="14" rx="2" fill={color} /><rect x="48.5" y="36.5" width="5" height="8" rx="0.5" fill="#fff" opacity="0.7" /></g>
    default:          return null
  }
}

function Avatar({ role, speaking, mood }) {
  const c = ROLES[role].color
  const m = speaking ? mood : 'neutral'
  const mouth = m === 'happy' ? 'M22 21 Q27 25 32 21' : m === 'frown' ? 'M22 24 Q27 20 32 24' : 'M23 22 L31 22'
  return (
    <svg width="62" height="70" viewBox="0 0 62 70" style={{ overflow: 'visible', cursor: 'pointer' }}>
      <ellipse cx="27" cy="58" rx="16" ry="3.5" fill="rgba(0,0,0,0.12)" />
      <Prop kind={ROLES[role].prop} color={c} />
      <rect x="13" y="30" width="28" height="26" rx="11" fill={c} />
      <circle cx="27" cy="18" r="12" fill={c} />
      <circle cx="27" cy="18" r="12" fill="rgba(255,255,255,0.14)" />
      <circle cx="22.5" cy={m === 'thinking' ? 16 : 17} r="1.7" fill="#fff" />
      <circle cx="31.5" cy={m === 'thinking' ? 16 : 17} r="1.7" fill="#fff" />
      <path d={mouth} stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  )
}

function MarketLight() {
  const [open, setOpen] = useState(false)
  const [clock, setClock] = useState('')
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now)
      const get = (t) => p.find((x) => x.type === t)?.value
      const wd = get('weekday'); const h = +get('hour'); const mn = +get('minute')
      const mins = h * 60 + mn
      const weekday = !['Sat', 'Sun'].includes(wd)
      setOpen(weekday && mins >= 570 && mins < 960)  // 9:30–16:00 ET
      setClock(`${get('hour')}:${get('minute')} ET`)
    }
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id)
  }, [])
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-secondary)' }}>
      <span style={{ width: 8, height: 8, borderRadius: 4, background: open ? 'var(--accent-green,#10b981)' : 'var(--accent-red,#ef4444)' }} />
      {open ? 'Market open' : 'Market closed'} · {clock}
    </span>
  )
}

export default function TradingFloor() {
  const [cycles, setCycles] = useState([])      // [{id,label,events}]
  const [ci, setCi] = useState(0)               // selected cycle index
  const [step, setStep] = useState(0)           // event index within cycle
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('No cycle loaded — run a demo cycle.')
  const [inspect, setInspect] = useState(null)  // {type:'role'|'ticker', key}
  const scriptRef = useRef(null)

  const cycle = cycles[ci]
  const events = cycle?.events || []
  const cur = events[step]
  const line = cur ? lineFor(cur) : null
  const speaking = line?.role
  const shown = useMemo(() => events.slice(0, step + 1), [events, step])
  const activeTicker = cur?.ticker
  const ticketStatus = cur?.type === 'approved' ? 'ok' : cur?.type === 'blocked' ? 'blocked' : null

  // playback engine
  useEffect(() => {
    if (!playing) return
    if (step >= events.length - 1) { setPlaying(false); return }
    const t = setTimeout(() => setStep((s) => Math.min(s + 1, events.length - 1)), BASE_MS / speed)
    return () => clearTimeout(t)
  }, [playing, step, speed, events.length])

  useEffect(() => { const el = scriptRef.current; if (el) el.scrollTop = el.scrollHeight }, [shown])

  const loadCycles = async () => {
    const { events: all } = await getAgentTradingEvents(800)
    const map = new Map()
    for (const e of all || []) {
      if (!map.has(e.cycle_id)) map.set(e.cycle_id, [])
      map.get(e.cycle_id).push(e)
    }
    const list = [...map.entries()].map(([id, evs]) => ({
      id, events: evs.sort((a, b) => a.seq - b.seq),
      label: (evs.find((e) => e.type === 'cycle_started')?.label) || id,
    }))
    setCycles(list)
    return list
  }

  const selectCycle = (i, autoplay = false) => { setCi(i); setStep(0); setInspect(null); setPlaying(autoplay) }

  const replayLatest = async () => {
    setBusy(true); setHint('')
    try { const l = await loadCycles(); if (l.length) selectCycle(l.length - 1, true); else setHint('No cycle to replay — run a demo cycle.') }
    catch { setHint('Could not load events.') } finally { setBusy(false) }
  }
  const runAndPlay = async () => {
    setBusy(true); setHint('Gathering the team…')
    try { await runAgentTradingDemo(); const l = await loadCycles(); if (l.length) selectCycle(l.length - 1, true) }
    catch { setHint('Demo failed.') } finally { setBusy(false) }
  }

  const inspectData = useMemo(() => {
    if (!inspect) return null
    if (inspect.type === 'role') return events.filter((e) => lineFor(e).role === inspect.key)
    return events.filter((e) => e.ticker === inspect.key)
  }, [inspect, events])

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Trading floor</h2>
        <MarketLight />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {cycles.length > 1 && (
            <select value={ci} onChange={(e) => selectCycle(+e.target.value)} style={sel}>
              {cycles.map((c, i) => <option key={c.id} value={i}>{c.label}</option>)}
            </select>
          )}
          <button onClick={runAndPlay} disabled={busy} style={btn(busy)}><Play size={13} /> {busy ? 'Setting up…' : 'Run demo cycle'}</button>
          <button onClick={replayLatest} disabled={busy} style={btnGhost}><RotateCcw size={13} /> Reload</button>
        </div>
      </div>

      {/* traveling order-ticket lane — its own band above the desks so it never overlaps
          the speech bubbles */}
      <div style={ticketLane}>
        {activeTicker && (
          <div style={{
            position: 'absolute', top: 4,
            left: `calc(${((ORDER.indexOf(speaking) + 0.5) / ORDER.length) * 100}% - 43px)`,
            transition: 'left 0.6s cubic-bezier(.5,.05,.3,1)', width: 86, padding: '5px 7px', fontSize: 10.5,
            borderRadius: 7, background: 'var(--bg-primary,#fff)', border: '1px solid var(--border)',
            boxShadow: '0 2px 6px rgba(0,0,0,0.12)', textAlign: 'center', zIndex: 3,
          }}>
            <div style={{ fontWeight: 700 }}>{activeTicker}</div>
            <div style={{ color: 'var(--text-secondary)' }}>order ticket</div>
            {ticketStatus && (
              <div style={{
                marginTop: 2, fontWeight: 800, fontSize: 11, transform: 'rotate(-7deg)',
                color: ticketStatus === 'ok' ? 'var(--accent-green,#10b981)' : 'var(--accent-red,#ef4444)',
                border: `1.5px solid ${ticketStatus === 'ok' ? 'var(--accent-green,#10b981)' : 'var(--accent-red,#ef4444)'}`,
                borderRadius: 4, display: 'inline-block', padding: '0 4px',
              }}>{ticketStatus === 'ok' ? 'APPROVED' : 'BLOCKED'}</div>
            )}
          </div>
        )}
      </div>

      {/* the floor */}
      <div style={floor}>
        {ORDER.map((role) => (
          <div key={role} onClick={() => setInspect({ type: 'role', key: role })}
               title={`Inspect ${ROLES[role].name}`}
               style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', flex: 1,
                        transform: speaking === role ? 'translateY(-7px) scale(1.06)' : 'none', transition: 'transform 0.3s' }}>
            {speaking === role && line && (
              <div style={{ ...bubble, borderColor: bubbleColor(line.status) }}>{line.text}</div>
            )}
            <Avatar role={role} speaking={speaking === role} mood={line?.mood} />
            <span style={{ marginTop: 3, fontSize: 11, fontWeight: 600, color: speaking === role ? ROLES[role].color : 'var(--text-secondary)' }}>
              {ROLES[role].name}
            </span>
          </div>
        ))}
      </div>

      {/* playback controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '12px 0 4px', flexWrap: 'wrap' }}>
        <button onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)) }} disabled={!events.length} style={ctrl}><SkipBack size={15} /></button>
        <button onClick={() => setPlaying((p) => !p)} disabled={!events.length} style={ctrl}>{playing ? <Pause size={15} /> : <Play size={15} />}</button>
        <button onClick={() => { setPlaying(false); setStep((s) => Math.min(events.length - 1, s + 1)) }} disabled={!events.length} style={ctrl}><SkipForward size={15} /></button>
        <input type="range" min={0} max={Math.max(0, events.length - 1)} value={step} disabled={!events.length}
               onChange={(e) => { setPlaying(false); setStep(+e.target.value) }} style={{ flex: 1, minWidth: 120, accentColor: 'var(--accent-blue,#3b82f6)' }} />
        <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', minWidth: 54, textAlign: 'right' }}>
          {events.length ? `${step + 1} / ${events.length}` : '—'}
        </span>
        <div style={{ display: 'flex', gap: 3 }}>
          {[0.5, 1, 2].map((s) => (
            <button key={s} onClick={() => setSpeed(s)} style={{ ...speedBtn, ...(speed === s ? speedActive : {}) }}>{s}×</button>
          ))}
        </div>
      </div>

      {!events.length && <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '6px 2px' }}>{hint}</p>}

      {/* inspect drill-down */}
      {inspect && inspectData && (
        <div style={inspectBox}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>
              {inspect.type === 'role' ? `${ROLES[inspect.key].name} — what they did this cycle` : `${inspect.key} — guardrail trace`}
            </strong>
            <button onClick={() => setInspect(null)} style={{ ...ctrl, marginLeft: 'auto' }}><X size={14} /></button>
          </div>
          {inspectData.length === 0 ? <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>Nothing this cycle.</p> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 160, overflowY: 'auto' }}>
              {inspectData.map((e, i) => (
                <div key={i} style={{ fontSize: 12, display: 'flex', gap: 7 }}>
                  <span style={{ color: dotColor(e.status), flexShrink: 0 }}>●</span>
                  <span style={{ color: 'var(--text-primary)' }}>{e.label}{e.detail ? <span style={{ color: 'var(--text-secondary)' }}> — {e.detail}</span> : null}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* transcript (click a line with a ticker to inspect it) */}
      <div ref={scriptRef} style={{ maxHeight: 150, overflowY: 'auto', marginTop: 10, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {shown.map((ev, i) => {
          const l = lineFor(ev)
          return (
            <div key={i} onClick={() => ev.ticker && setInspect({ type: 'ticker', key: ev.ticker })}
                 style={{ fontSize: 12.5, display: 'flex', gap: 7, cursor: ev.ticker ? 'pointer' : 'default' }}>
              <span style={{ fontWeight: 600, color: ROLES[l.role].color, flexShrink: 0, minWidth: 92 }}>{ROLES[l.role].name}</span>
              <span style={{ color: l.status === 'blocked' ? 'var(--accent-red,#ef4444)' : 'var(--text-primary)' }}>{l.text}</span>
            </div>
          )
        })}
      </div>

      <p style={{ margin: '10px 2px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
        A visualization of the decision process — the authoritative numbers are in the timeline and tables. Nothing here trades.
      </p>

      <style>{`
        @keyframes tf-pop { from { opacity: 0; transform: translateY(4px) scale(0.96); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  )
}

const bubbleColor = (s) => s === 'blocked' ? 'var(--accent-red,#ef4444)' : s === 'ok' ? 'var(--accent-green,#10b981)' : s === 'warn' ? 'var(--accent-orange,#f59e0b)' : 'var(--border)'
const dotColor = (s) => s === 'blocked' || s === 'halted' ? 'var(--accent-red,#ef4444)' : s === 'ok' ? 'var(--accent-green,#10b981)' : s === 'warn' ? 'var(--accent-orange,#f59e0b)' : 'var(--text-secondary)'

const card = { border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 22, background: 'var(--bg-elevated, var(--bg-secondary))' }
const ticketLane = { position: 'relative', height: 56, marginBottom: 2 }
const floor = { position: 'relative', display: 'flex', justifyContent: 'space-around', alignItems: 'flex-end', gap: 8, padding: '58px 8px 14px', minHeight: 160, borderBottom: '2px solid var(--border)', overflow: 'visible' }
const bubble = { position: 'absolute', bottom: 80, maxWidth: 195, padding: '7px 10px', fontSize: 12, lineHeight: 1.3, borderRadius: 10, textAlign: 'center', background: 'var(--bg-primary, #fff)', border: '1px solid var(--border)', color: 'var(--text-primary)', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', zIndex: 2, animation: 'tf-pop 0.18s ease-out' }
const inspectBox = { marginTop: 12, padding: 12, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-primary, transparent)' }
const btn = (d) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', fontSize: 12.5, fontWeight: 600, border: '1px solid var(--accent-blue, #3b82f6)', borderRadius: 8, background: 'transparent', color: 'var(--accent-blue, #3b82f6)', cursor: d ? 'default' : 'pointer', opacity: d ? 0.6 : 1 })
const btnGhost = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 11px', fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 8, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }
const ctrl = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 28, border: '1px solid var(--border)', borderRadius: 7, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }
const speedBtn = { padding: '4px 8px', fontSize: 11.5, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }
const speedActive = { background: 'var(--accent-blue, #3b82f6)', color: '#fff', borderColor: 'var(--accent-blue, #3b82f6)' }
const sel = { padding: '5px 8px', fontSize: 12, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-primary, transparent)', color: 'var(--text-primary)' }
