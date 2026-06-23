/**
 * AskTusk — voice + text, read-only insight assistant.
 *
 * Push-to-talk = press to START a conversation session, press again to END it (not per-utterance).
 * While the session is open: the mic stays on, client-side VAD (RMS + silence timer) segments each
 * turn, then runs transcribe → ask → speak → play, and resumes listening. Capture pauses while Tusk
 * is speaking so it doesn't hear itself. A text box is always available (works without the voice
 * models). Everything is read-only — the assistant never takes an action.
 *
 * Phase 2: the answer STREAMS (SSE) so the panel renders — and the voice layer speaks — sentence by
 * sentence instead of waiting for the whole reply; recent turns are sent for multi-turn follow-ups
 * ("and last month?"); and a Stop button interrupts generation + playback (barge-in).
 */
import { useEffect, useRef, useState } from 'react'
import { Mic, Square, Send, Sparkles, Volume2, StopCircle, ThumbsUp, ThumbsDown, Check, X } from 'lucide-react'
import {
  streamAssistantAsk, getAssistantBriefing, getVoiceStatus, voiceTranscribe, voiceSpeak,
  submitFeedback, feedbackCorrect, feedbackApprove, feedbackReject,
} from '../api/client'

const BLUE = 'var(--accent-blue, #378ADD)'

// Receipts: the actual rows the answer was computed from, so any figure is one click from
// verifiable. Native <details> keeps it stateless across re-renders.
function fmtCell(key, v) {
  if (v == null) return '—'
  if (typeof v === 'number' && /amount|total|net_worth|value|dollars|price|spent|gain/i.test(key))
    return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
// Feedback: 👍/👎 on an answer. A 👎 captures the Q&A, shows the backend's diagnosis, and — if a
// grounded correction is proposed (or the user picks the right read) — offers Approve, which teaches
// the router. Self-contained: it only needs the turn's question/answer/intent.
function Feedback({ q, answer, intent, onCorrected }) {
  const [state, setState] = useState('idle')   // idle | up | down | thanks | dismissed
  const [fid, setFid] = useState(null)
  const [diag, setDiag] = useState(null)
  const [suggested, setSuggested] = useState(null)
  const [hint, setHint] = useState('')
  if (!q || !answer || !answer.trim()) return null

  const up = async () => { setState('up'); try { await submitFeedback({ question: q, answer, rating: 'up', intent }) } catch { /* */ } }
  const down = async () => {
    setState('down')
    try {
      const r = await submitFeedback({ question: q, answer, rating: 'down', intent })
      setFid(r.feedback_id); setDiag(r.diagnosis || null)
      if (r.diagnosis && r.diagnosis.suggested_answer) setSuggested({ answer: r.diagnosis.suggested_answer, rows: r.diagnosis.suggested_rows })
    } catch { /* */ }
  }
  // The user describes what they meant in plain language; the backend routes it to the right read.
  const tryHint = async () => {
    if (!hint.trim() || !fid) return
    try {
      const r = await feedbackCorrect(fid, hint.trim())
      if (r && r.preview) setSuggested({ answer: r.preview, intent: r.intent, rows: r.rows })
      else if (r && r.error) setSuggested({ answer: r.error, error: true })
    } catch { /* */ }
  }
  const approve = async () => {
    try { await feedbackApprove(fid) } catch { /* */ }
    // Replace the wrong answer on screen with the corrected one so the user sees it change.
    if (suggested && suggested.answer && !suggested.error && onCorrected)
      onCorrected({ text: suggested.answer, rows: suggested.rows || [], intent: suggested.intent })
    setState('thanks')
  }
  const dismiss = async () => { try { if (fid) await feedbackReject(fid) } catch { /* */ } setState('dismissed') }

  const dim = { fontSize: 11, color: 'var(--text-muted)' }
  if (state === 'idle') return (
    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
      <button onClick={up} title="Good answer" style={iconBtn}><ThumbsUp size={12} /></button>
      <button onClick={down} title="Wrong or unhelpful" style={iconBtn}><ThumbsDown size={12} /></button>
    </div>
  )
  if (state === 'up') return <div style={{ ...dim, marginTop: 4 }}>Thanks for the 👍</div>
  if (state === 'thanks') return <div style={{ ...dim, marginTop: 4, color: 'var(--accent-blue,#378ADD)' }}>Thanks — I'll answer questions like this correctly from now on.</div>
  if (state === 'dismissed') return <div style={{ ...dim, marginTop: 4 }}>Got it — dismissed. The feedback is logged.</div>
  // state === 'down'
  return (
    <div style={{ marginTop: 6, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-hover)' }}>
      {diag && diag.note && <div style={{ ...dim, marginBottom: 6 }}>{diag.note}</div>}
      {diag && diag.type === 'coverage_gap' && !suggested &&
        <div style={{ ...dim, marginBottom: 6 }}>Logged as a coverage request.</div>}
      {suggested && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ ...dim, marginBottom: 2 }}>Here's another read:</div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{suggested.answer}</div>
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); tryHint() }} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="What did you mean? e.g. 'my biggest debt'"
          style={{ flex: 1, fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)' }} />
        <button type="submit" disabled={!hint.trim()} style={{ ...pillBtn, opacity: hint.trim() ? 1 : 0.5 }}>Try</button>
      </form>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {suggested && !suggested.error && <button onClick={approve} style={{ ...pillBtn, color: 'var(--accent-blue,#378ADD)', borderColor: 'var(--accent-blue,#378ADD)' }}><Check size={12} /> Approve this</button>}
        <button onClick={dismiss} style={pillBtn}><X size={12} /> Dismiss</button>
      </div>
    </div>
  )
}
const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, padding: 0, borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }
const pillBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', fontSize: 11.5, borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }

function Receipts({ intent, window, rows }) {
  if (!rows || !rows.length) return null
  const cols = Object.keys(rows[0]).filter(k => typeof rows[0][k] !== 'object').slice(0, 6)
  return (
    <details style={{ marginTop: 5 }}>
      <summary style={{ fontSize: 10.5, color: 'var(--text-muted)', cursor: 'pointer', listStyle: 'none' }}>
        ▸ show data{window ? ` · ${window}` : ''}
      </summary>
      <div style={{ marginTop: 6, overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
          <thead><tr>{cols.map(c => (
            <th key={c} style={{ textAlign: 'left', padding: '2px 12px 4px 0', color: 'var(--text-muted)', fontWeight: 600 }}>{c}</th>
          ))}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>{cols.map(c => (
              <td key={c} style={{ padding: '2px 12px 2px 0', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{fmtCell(c, r[c])}</td>
            ))}</tr>
          ))}</tbody>
        </table>
      </div>
    </details>
  )
}

// ── WAV helpers (downsample to 16 kHz mono, 16-bit PCM — what Parakeet wants) ──
function downsample(buf, fromRate, toRate) {
  if (toRate >= fromRate) return buf
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.round(buf.length / ratio))
  for (let i = 0, j = 0; i < out.length; i++) {
    const next = Math.round((i + 1) * ratio)
    let sum = 0, n = 0
    for (let k = Math.round(i * ratio); k < next && k < buf.length; k++) { sum += buf[k]; n++ }
    out[i] = n ? sum / n : 0
  }
  return out
}
function encodeWav(float32, sampleRate) {
  const buffer = new ArrayBuffer(44 + float32.length * 2)
  const view = new DataView(buffer)
  const w = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); view.setUint32(4, 36 + float32.length * 2, true); w(8, 'WAVE')
  w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  w(36, 'data'); view.setUint32(40, float32.length * 2, true)
  let off = 44
  for (let i = 0; i < float32.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
  }
  return new Blob([view], { type: 'audio/wav' })
}

// Pull complete sentences out of a growing buffer: terminal punctuation FOLLOWED BY whitespace
// (so "$848,415.21" mid-number doesn't split). The tail without trailing space stays buffered
// until the next chunk or the final flush.
const SENT_RE = /[\s\S]*?[.!?]+(?=\s)/g

export default function AskTusk({ floating = false, panelOpen = true }) {
  const [voice, setVoice] = useState(null)            // {stt_available, tts_available, enabled}
  const [session, setSession] = useState(false)
  const [state, setState] = useState('idle')          // idle | listening | thinking | speaking
  const [turns, setTurns] = useState([])              // {who:'you'|'tusk', text}
  const [text, setText] = useState('')
  const [level, setLevel] = useState(0)               // live mic RMS (for the meter)
  const [thresh, setThresh] = useState(0.01)          // current adaptive VAD threshold
  const [hasMic, setHasMic] = useState(true)          // is a microphone present? (gates voice)
  const audio = useRef({})                             // ctx/stream/node/buffers
  const audioEl = useRef(null)
  const levelRef = useRef(0)
  const floorRef = useRef(0.01)
  const threshRef = useRef(0.01)
  const rafRef = useRef(0)
  const turnsRef = useRef([])                          // mirror of `turns` for sync reads (history)
  const cancelRef = useRef(null)                       // aborts the in-flight SSE stream (Stop)
  const ttsBufRef = useRef('')                         // un-segmented streamed text
  const ttsQueueRef = useRef([])                       // sentences waiting to be spoken
  const ttsPlayingRef = useRef(false)
  const stoppedRef = useRef(false)                     // Stop pressed → halt queue + playback
  const voiceRef = useRef(null)
  const briefingFetchedRef = useRef(false)             // proactive 'morning read' fetched once per open
  const briefingSpokenRef = useRef(false)
  const briefingTextRef = useRef('')

  useEffect(() => { getVoiceStatus().then(v => { setVoice(v); voiceRef.current = v }).catch(() => { const v = { stt_available: false, tts_available: false }; setVoice(v); voiceRef.current = v }) }, [])
  useEffect(() => { turnsRef.current = turns }, [turns])

  // Is there actually a microphone? Gate the voice UI on this so 'Start conversation' never appears
  // (or stalls "Listening…") on a machine with no input device. Re-check when devices change.
  useEffect(() => {
    const md = navigator.mediaDevices
    if (!md || !md.enumerateDevices || !md.getUserMedia) { setHasMic(false); return }
    const check = () => md.enumerateDevices()
      .then(ds => setHasMic(ds.some(d => d.kind === 'audioinput')))
      .catch(() => setHasMic(false))
    check()
    md.addEventListener && md.addEventListener('devicechange', check)
    return () => { md.removeEventListener && md.removeEventListener('devicechange', check) }
  }, [])

  // Greet with a simple opener — NOT a financial read. The proactive rundown is available on
  // demand via the "Catch me up" button (and fetched lazily then).
  useEffect(() => {
    if (!panelOpen || briefingFetchedRef.current) return
    briefingFetchedRef.current = true
    setTurns(ts => ts.length === 0 ? [{ who: 'tusk', text: 'Hi — how can I help?' }] : ts)
  }, [panelOpen])

  // On-demand proactive rundown (net worth move, spending, top alert). Fetched lazily; spoken if a
  // voice session is open.
  async function catchMeUp() {
    let txt = briefingTextRef.current
    if (!txt) {
      try { const b = await getAssistantBriefing(); txt = (b && b.briefing) || '' } catch { /* */ }
      briefingTextRef.current = txt || ''
    }
    if (!txt) return
    addTurn('tusk', txt)
    if (voiceRef.current?.tts_available && session) {
      stoppedRef.current = false
      enqueueSpeech(txt, { flush: true })
    }
  }

  const addTurn = (who, t) => setTurns(ts => [...ts, { who, text: t }])
  const patchLastTusk = (patch) => setTurns(ts => {
    const copy = ts.slice()
    for (let i = copy.length - 1; i >= 0; i--) { if (copy[i].who === 'tusk') { copy[i] = { ...copy[i], ...patch }; break } }
    return copy
  })
  const setLastTusk = (t) => patchLastTusk({ text: t })
  const patchTurnAt = (idx, patch) => setTurns(ts => ts.map((t, i) => (i === idx ? { ...t, ...patch } : t)))

  // ── Speech queue: synthesize + play sentences in order, sequentially ──
  function playBlob(blob) {
    return new Promise((resolve) => {
      const el = audioEl.current
      if (!blob || !el) return resolve()
      el.src = URL.createObjectURL(blob)
      const done = () => { el.onended = null; el.onerror = null; resolve() }
      el.onended = done; el.onerror = done
      el.play().catch(() => resolve())
    })
  }
  async function drainTts() {
    if (ttsPlayingRef.current) return
    const v = voiceRef.current
    if (!v?.tts_available) { ttsQueueRef.current = []; return }
    ttsPlayingRef.current = true
    setState('speaking')
    if (audio.current.ctx) audio.current.paused = true       // don't transcribe ourselves
    while (ttsQueueRef.current.length && !stoppedRef.current) {
      const sentence = ttsQueueRef.current.shift()
      let blob = null
      try { blob = await voiceSpeak(sentence) } catch { blob = null }
      if (stoppedRef.current) break
      if (blob) await playBlob(blob)
    }
    ttsPlayingRef.current = false
    if (ttsQueueRef.current.length && !stoppedRef.current) return drainTts()   // more arrived
    finishAnswer()
  }
  function enqueueSpeech(chunk, { flush = false } = {}) {
    const v = voiceRef.current
    if (!v?.tts_available) return
    ttsBufRef.current += chunk
    let m, last = 0
    while ((m = SENT_RE.exec(ttsBufRef.current)) !== null) {
      const s = m[0].trim(); if (s) ttsQueueRef.current.push(s); last = SENT_RE.lastIndex
    }
    SENT_RE.lastIndex = 0
    if (last) ttsBufRef.current = ttsBufRef.current.slice(last)
    if (flush && ttsBufRef.current.trim()) { ttsQueueRef.current.push(ttsBufRef.current.trim()); ttsBufRef.current = '' }
    if (ttsQueueRef.current.length) drainTts()
  }
  function finishAnswer() {
    if (ttsPlayingRef.current || ttsQueueRef.current.length) return   // still speaking
    if (audio.current.ctx) { audio.current.paused = false; setState('listening') }
    else setState('idle')
  }

  async function runTurn(question) {
    if (!question || !question.trim()) return
    stoppedRef.current = false
    ttsBufRef.current = ''; ttsQueueRef.current = []
    const history = (turnsRef.current || []).slice(-6)
    addTurn('you', question)
    addTurn('tusk', '')                       // placeholder we stream into
    setState('thinking')
    let acc = ''; let meta = null
    return new Promise((resolve) => {
      const cancel = streamAssistantAsk(question, history, {
        onMeta: (m) => { meta = m },
        onDelta: (d) => { acc += d; setLastTusk(acc); enqueueSpeech(d) },
        onError: (msg) => { setLastTusk(acc || `Sorry — ${msg || 'something went wrong'}.`); finishAnswer(); resolve() },
        onDone: (payload) => {
          if (!acc.trim()) setLastTusk('(no answer)')
          // Attach the retrieval receipts so the answer is verifiable.
          patchLastTusk({
            text: acc.trim() || '(no answer)',
            q: question,                                 // pair the question with the answer for feedback
            rows: (payload && payload.rows) || [],
            intent: (payload && payload.intent) ?? meta?.intent,
            window: (payload && payload.window) ?? meta?.window,
            grounded: meta?.grounded,
          })
          enqueueSpeech('', { flush: true })
          if (!ttsPlayingRef.current && !ttsQueueRef.current.length) finishAnswer()
          resolve()
        },
      })
      cancelRef.current = cancel
    })
  }

  // Stop / barge-in: abort generation, drop the speech queue, stop playback, resume listening.
  function stopAll() {
    stoppedRef.current = true
    try { cancelRef.current && cancelRef.current() } catch { /* */ }
    cancelRef.current = null
    ttsQueueRef.current = []; ttsBufRef.current = ''; ttsPlayingRef.current = false
    try { if (audioEl.current) { audioEl.current.pause(); audioEl.current.currentTime = 0 } } catch { /* */ }
    if (audio.current.ctx) { audio.current.paused = false; setState('listening') }
    else setState('idle')
  }

  // Reset a (possibly half-started) session and surface a one-line reason. Safe to call anytime.
  function failSession(msg) {
    try { cancelAnimationFrame(rafRef.current) } catch { /* */ }
    const st = audio.current || {}
    try { st.node && (st.node.onaudioprocess = null); st.node && st.node.disconnect(); st.sink && st.sink.disconnect(); st.source && st.source.disconnect(); st.ctx && st.ctx.close(); st.stream && st.stream.getTracks().forEach(t => t.stop()) } catch { /* */ }
    audio.current = {}
    setSession(false); setState('idle'); setLevel(0)
    if (msg) addTurn('tusk', msg)
  }

  // ── Voice session (VAD-segmented turns) ──
  async function startSession() {
    const md = navigator.mediaDevices
    if (!md || !md.getUserMedia) { addTurn('tusk', 'Voice needs a secure (https) page and a microphone — you can type your question below.'); return }
    let stream
    try {
      stream = await md.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch (e) {
      const name = (e && e.name) || ''
      const msg = /NotFound|Overconstrained|NotReadable/i.test(name)
        ? 'I don’t see a working microphone on this device — you can still type your question below.'
        : /NotAllowed|Security|Permission/i.test(name)
          ? 'Microphone access is blocked — allow it in the browser’s site settings, or just type below.'
          : 'I couldn’t open the microphone — you can type your question below.'
      setHasMic(false)
      failSession(msg)
      return
    }
    if (!stream || stream.getAudioTracks().length === 0) {
      try { stream && stream.getTracks().forEach(t => t.stop()) } catch { /* */ }
      setHasMic(false)
      addTurn('tusk', 'I don’t see a working microphone on this device — you can still type your question below.')
      return
    }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      if (ctx.state === 'suspended') await ctx.resume()              // Chrome starts ctx suspended
      // If the mic is unplugged mid-session, end gracefully instead of stalling on "Listening…".
      stream.getAudioTracks()[0].addEventListener('ended', () => { if (audio.current.ctx) failSession('The microphone disconnected — type below or restart the conversation.') })
      const source = ctx.createMediaStreamSource(stream)
      const node = ctx.createScriptProcessor(4096, 1, 1)
      const sink = ctx.createGain(); sink.gain.value = 0             // silent sink so onaudioprocess fires without echo
      floorRef.current = 0.01
      const st = { ctx, stream, node, source, sink, frames: [], silence: 0, started: false, paused: false }
      node.onaudioprocess = (e) => {
        if (st.paused) return
        const buf = e.inputBuffer.getChannelData(0)
        let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        const rms = Math.sqrt(sum / buf.length)
        levelRef.current = rms
        // Adaptive VAD: track the noise floor and trigger a bit above it (works in quiet or noisy rooms).
        floorRef.current = rms < floorRef.current ? (floorRef.current * 0.9 + rms * 0.1) : (floorRef.current * 0.999 + rms * 0.001)
        const threshold = Math.max(0.006, floorRef.current * 2.2)
        threshRef.current = threshold
        const voiced = rms > threshold
        if (voiced) { st.started = true; st.silence = 0; st.frames.push(new Float32Array(buf)) }
        else if (st.started) {
          st.frames.push(new Float32Array(buf)); st.silence += buf.length / ctx.sampleRate
          if (st.silence > 0.9 && st.frames.length) {                // ~0.9s of trailing silence = end of turn
            const merged = mergeFrames(st.frames); st.frames = []; st.started = false; st.silence = 0
            st.paused = true                                          // stop listening while we answer
            ;(async () => {
              const wav = encodeWav(downsample(merged, ctx.sampleRate, 16000), 16000)
              setState('thinking')
              let q = ''
              try { q = (await voiceTranscribe(wav)).text } catch { q = '' }
              if (q && q.trim()) { await runTurn(q.trim()) }          // runTurn manages pause/resume via the speech queue
              else if (audio.current.ctx) { st.paused = false; setState('listening') }   // heard nothing, resume
            })()
          }
        }
      }
      source.connect(node); node.connect(sink); sink.connect(ctx.destination)
      audio.current = st
      // Drive the live meter off the latest RMS (~20fps), independent of React state churn.
      const tick = () => { setLevel(levelRef.current); setThresh(threshRef.current); rafRef.current = requestAnimationFrame(tick) }
      rafRef.current = requestAnimationFrame(tick)
      setSession(true); setState('listening')
      // No auto-spoken briefing — the session just starts listening after the simple greeting.
    } catch (e) {
      failSession('I couldn’t start listening on this device — you can type your question below.')
    }
  }
  function mergeFrames(frames) {
    const len = frames.reduce((n, f) => n + f.length, 0)
    const out = new Float32Array(len); let o = 0
    for (const f of frames) { out.set(f, o); o += f.length }
    return out
  }
  function endSession() {
    stopAll()
    const st = audio.current
    cancelAnimationFrame(rafRef.current)
    try { st.node && (st.node.onaudioprocess = null); st.node && st.node.disconnect(); st.sink && st.sink.disconnect(); st.source && st.source.disconnect(); st.ctx && st.ctx.close(); st.stream && st.stream.getTracks().forEach(t => t.stop()) } catch { /* */ }
    audio.current = {}
    setSession(false); setState('idle'); setLevel(0)
  }
  useEffect(() => () => endSession(), [])   // cleanup on unmount

  const stateLabel = { idle: '', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' }[state]
  const busy = state === 'thinking' || state === 'speaking'
  const canVoice = voice && voice.stt_available && voice.tts_available

  return (
    <div className="card" style={floating
      ? { marginBottom: 0, boxShadow: 'none', border: 'none', background: 'transparent', padding: 0,
          height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }
      : { marginBottom: 20 }}>
      <div className="card-header" style={{ flexShrink: 0, ...(floating ? { justifyContent: 'flex-end' } : {}) }}>
        {/* In the panel the title + disclaimer already live in the panel header, so show only the
            action buttons here (avoids the subtitle colliding with the buttons in a narrow panel). */}
        {!floating && (
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} style={{ color: BLUE }} /> Ask Tusk
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>read-only insight · not financial advice</span>
          </div>
        )}
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <button onClick={catchMeUp} title="A quick read of your finances"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer',
              border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)' }}>
            <Sparkles size={12} /> Catch me up
          </button>
          {canVoice && hasMic && (
            <button onClick={() => (session ? endSession() : startSession())}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${session ? 'var(--danger, #E24B4A)' : 'var(--border)'}`, background: session ? 'var(--danger-bg, rgba(226,75,74,0.12))' : 'transparent',
                color: session ? 'var(--danger, #E24B4A)' : 'var(--text-primary)' }}>
              {session ? <><Square size={13} /> End</> : <><Mic size={13} /> Start conversation</>}
            </button>
          )}
          {canVoice && !hasMic && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text-muted)' }}>
              <Mic size={12} /> no mic — type below
            </span>
          )}
        </div>
      </div>

      {stateLabel && <div style={{ fontSize: 12, color: BLUE, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{state === 'speaking' && <Volume2 size={13} />}{stateLabel}</span>
        {busy && (
          <button onClick={stopAll} title="Stop" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 6, fontSize: 11.5, cursor: 'pointer',
            border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)' }}>
            <StopCircle size={12} /> Stop
          </button>
        )}
      </div>}

      {session && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ position: 'relative', height: 8, background: 'var(--bg-hover)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, level * 1200)}%`, background: level > thresh ? BLUE : 'var(--text-muted)', transition: 'width 60ms linear' }} />
            <div style={{ position: 'absolute', left: `${Math.min(100, thresh * 1200)}%`, top: -2, bottom: -2, borderLeft: '1.5px dashed var(--text-secondary)' }} />
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4 }}>
            mic level {level > thresh ? '— hearing you ✓' : '— speak; the bar should cross the dashed line'}
          </div>
        </div>
      )}

      <div style={floating
        ? { display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0, overflowY: 'auto', marginBottom: 10 }
        : { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto', marginBottom: 10 }}>
        {turns.length === 0 && <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
          {canVoice ? 'Press “Start conversation” and ask about your net worth, spending, or holdings — or type below.'
            : 'Ask about your net worth, spending, or holdings. (Install Parakeet + Kokoro for voice — see services/voice.py.)'}
        </p>}
        {turns.map((t, i) => (
          <div key={i} style={{ alignSelf: t.who === 'you' ? 'flex-end' : 'flex-start', maxWidth: '85%',
            background: t.who === 'you' ? 'var(--bg-hover)' : 'transparent', borderRadius: 10, padding: t.who === 'you' ? '6px 12px' : '2px 0' }}>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 2 }}>{t.who === 'you' ? 'You' : 'Tusk'}</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{t.text || (t.who === 'tusk' && state === 'thinking' ? '…' : '')}</div>
            {t.who === 'tusk' && <Receipts intent={t.intent} window={t.window} rows={t.rows} />}
            {t.who === 'tusk' && t.text && state !== 'thinking' && <Feedback q={t.q} answer={t.text} intent={t.intent} onCorrected={(patch) => patchTurnAt(i, patch)} />}
          </div>
        ))}
      </div>

      <form onSubmit={e => { e.preventDefault(); const q = text; setText(''); runTurn(q) }} style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Type a question…"
          style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13 }} />
        <button type="submit" disabled={!text.trim()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', opacity: text.trim() ? 1 : 0.5 }}>
          <Send size={14} /> Ask
        </button>
      </form>

      <audio ref={audioEl} style={{ display: 'none' }} />
    </div>
  )
}
