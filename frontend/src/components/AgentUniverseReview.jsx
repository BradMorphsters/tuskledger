/**
 * AgentUniverseReview — Approve/Reject the weekly universe-review candidate queue.
 *
 * The universe screener keeps the candidate LIST fresh: it discovers names that should be ADDED
 * (new players in the theme's sector ETFs / fresh SEC filers in its mining codes) and flags weak,
 * stale names to DROP. That queue is read-only on its own — THIS panel is the explicit apply step:
 *
 *   • Approve an add  → creates the research entity, fetches its price, assigns a *provisional*,
 *     evidence-based conviction, then runs the Analyst scorer and shows the name's standing.
 *   • Approve a drop  → removes the entity from the universe.
 *   • Reject          → durably dismisses the candidate so it doesn't reappear next week (Undo-able).
 *
 * Nothing here moves money or places a trade — it only edits the research candidate list.
 */
import { useEffect, useState, useCallback } from 'react'
import { Telescope, Plus, Minus, Check, X, RotateCcw, RefreshCw, Sparkles, CheckCheck, Trash2 } from 'lucide-react'
import {
  getAgentTradingUniverseReview,
  decideAgentTradingUniverseCandidate,
  decideAgentTradingUniverseBulk,
} from '../api/client'
import Pill from './Pill'

const GREEN = 'var(--accent-green, #10b981)'
const RED = 'var(--accent-red, #ef4444)'
const BLUE = 'var(--accent-blue, #3b82f6)'
const AMBER = 'var(--accent-orange, #f59e0b)'

const STATUS_TONE = {
  in_basket: 'success', qualifies: 'success', held: 'success',
  buffer: 'info', capped: 'info',
  below_cutoff: 'neutral', blocked: 'warning', exit: 'danger',
}

export default function AgentUniverseReview() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)      // ticker (or 'bulk-*') currently acting
  const [err, setErr] = useState(null)
  const [results, setResults] = useState({})  // ticker -> approve outcome (standing banner)
  const [bulkResult, setBulkResult] = useState(null)  // last bulk outcome summary

  const load = useCallback(() => {
    setLoading(true)
    getAgentTradingUniverseReview()
      .then(setData).catch((e) => setErr(e.message || 'Failed to load the universe review'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const decide = async (decision, { keepResult = false } = {}) => {
    setBusy(decision.ticker); setErr(null)
    try {
      const res = await decideAgentTradingUniverseCandidate(decision)
      if (keepResult && res?.applied === 'add') {
        setResults((r) => ({ ...r, [decision.ticker]: res }))
      }
    } catch (e) {
      setErr(e.message || 'Action failed')
    } finally {
      setBusy(null); load()
    }
  }

  // Bulk apply to a whole group. `items` are the candidates currently shown.
  const decideBulk = async (action, kind, items, confirmMsg) => {
    if (!items.length) return
    if (confirmMsg && !window.confirm(confirmMsg)) return
    setBusy(`bulk-${kind}`); setErr(null); setBulkResult(null)
    try {
      const res = await decideAgentTradingUniverseBulk({ action, kind, items })
      setBulkResult({ action, kind, ...res })
      setResults({})  // per-row standings are superseded by the bulk summary
    } catch (e) {
      setErr(e.message || 'Bulk action failed')
    } finally {
      setBusy(null); load()
    }
  }

  const adds = [
    ...((data?.add || []).map((c) => ({ ...c, kind: 'add' }))),
    ...((data?.add_edgar || []).map((c) => ({ ...c, kind: 'add_edgar' }))),
  ]
  const drops = data?.drop || []
  const screened = data?.below_floor_screened || 0
  const ignored = data?.ignored || []
  const kept = data?.kept || []
  const dismissed = ignored.length + kept.length

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Telescope size={18} style={{ color: BLUE }} />
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Universe review — candidates to add / drop</h2>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {adds.length > 0 && <Pill tone="success" soft>{adds.length} add</Pill>}
          {drops.length > 0 && <Pill tone="danger" soft>{drops.length} drop</Pill>}
          <button onClick={load} disabled={loading} style={genBtn}>
            <RefreshCw size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />
            {loading ? 'Loading…' : 'Reload'}
          </button>
        </span>
      </div>

      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 2px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Sparkles size={14} style={{ color: GREEN }} />
        Candidates are scored first — only names that clear the 0.50 buy floor are suggested here.
        Approving adds the name to the monitor list and prices it; rejecting dismisses it so it won't reappear.
        {screened > 0 ? ` ${screened} below-floor name${screened === 1 ? '' : 's'} screened out this run.` : ''} No trades.
      </p>

      {err && <p style={{ fontSize: 13, color: RED, margin: '4px 2px' }}>{err}</p>}
      {bulkResult && <BulkBanner r={bulkResult} />}
      {loading && !data && <p style={muted}>Loading…</p>}

      {data && (data.configured === false) && (
        <p style={muted}>No active research domain configured.</p>
      )}

      {/* Add candidates */}
      {adds.length > 0 && (
        <Group title="Suggested additions (score ≥ 0.50)" icon={<Plus size={15} style={{ color: GREEN }} />}
          action={
            <button
              onClick={() => decideBulk('approve', 'adds',
                adds.map((c) => ({ ticker: c.ticker, name: c.name, kind: c.kind, weight: c.weight || 0, sources: c.sources || [] })),
                `Approve all ${adds.length} suggested addition${adds.length === 1 ? '' : 's'}? Each is already scored at/above the buy floor; prices fill on the next refresh.`)}
              disabled={busy === 'bulk-adds' || adds.length === 0}
              title="Approve every suggested addition (all are pre-scored at or above the 0.50 buy floor)"
              style={{ ...bulkBtn, color: GREEN, borderColor: GREEN, opacity: adds.length === 0 ? 0.5 : 1 }}>
              <CheckCheck size={14} /> {busy === 'bulk-adds' ? 'Approving…' : `Approve all (${adds.length})`}
            </button>
          }>
          {adds.map((c) => (
            <div key={`${c.kind}:${c.ticker}`} style={row}>
              <span style={{ ...kindBadge, color: GREEN, borderColor: GREEN }}>
                {c.kind === 'add' ? 'ETF' : 'EDGAR'}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 650 }}>
                  {c.ticker}
                  {c.name && <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}> · {c.name}</span>}
                </div>
                <div style={rowSub}>{(c.sources || []).join(' · ') || (c.cik ? `CIK ${c.cik}` : '')}</div>
                {c.provisional && (
                  <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <Pill tone="success" soft>score ~{c.provisional.conviction}</Pill>
                    <span style={{ fontSize: 11, color: 'var(--text-muted, var(--text-secondary))', fontStyle: 'italic' }}>
                      {(c.provisional.basis || []).join(' · ')}
                    </span>
                  </div>
                )}
                {results[c.ticker] && <Standing res={results[c.ticker]} />}
              </div>
              <button
                onClick={() => decide({ action: 'approve', kind: c.kind, ticker: c.ticker, name: c.name, weight: c.weight || 0, sources: c.sources || [] }, { keepResult: true })}
                disabled={busy === c.ticker} title="Approve — add to the universe and score it" style={{ ...actBtn, color: GREEN, borderColor: GREEN }}>
                <Check size={15} /> Approve
              </button>
              <button
                onClick={() => decide({ action: 'reject', kind: c.kind, ticker: c.ticker })}
                disabled={busy === c.ticker} title="Reject — dismiss this add (won't reappear)" style={{ ...actBtn, color: RED, borderColor: RED }}>
                <X size={15} /> Reject
              </button>
            </div>
          ))}
        </Group>
      )}

      {/* Drop candidates */}
      {drops.length > 0 && (
        <Group title="Drop candidates" icon={<Minus size={15} style={{ color: RED }} />}
          action={
            <button
              onClick={() => decideBulk('approve', 'drops',
                drops.map((c) => ({ ticker: c.ticker })),
                `Remove all ${drops.length} flagged name${drops.length === 1 ? '' : 's'} from the universe?`)}
              disabled={busy === 'bulk-drops'} title="Remove every drop candidate" style={{ ...bulkBtn, color: RED, borderColor: RED }}>
              <Trash2 size={14} /> {busy === 'bulk-drops' ? 'Removing…' : `Remove all (${drops.length})`}
            </button>
          }>
          {drops.map((c) => (
            <div key={`drop:${c.ticker}`} style={row}>
              <span style={{ ...kindBadge, color: RED, borderColor: RED }}>DROP</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 650 }}>{c.ticker}</div>
                <div style={rowSub}>{(c.reasons || []).join(' · ')}</div>
              </div>
              <button
                onClick={() => decide({ action: 'approve', kind: 'drop', ticker: c.ticker })}
                disabled={busy === c.ticker} title="Approve — remove this name from the universe" style={{ ...actBtn, color: RED, borderColor: RED }}>
                <Check size={15} /> Remove
              </button>
              <button
                onClick={() => decide({ action: 'reject', kind: 'drop', ticker: c.ticker })}
                disabled={busy === c.ticker} title="Keep — don't flag this for drop again" style={{ ...actBtn, color: 'var(--text-secondary)', borderColor: 'var(--border)' }}>
                <X size={15} /> Keep
              </button>
            </div>
          ))}
        </Group>
      )}

      {!loading && data && adds.length === 0 && drops.length === 0 && (
        <p style={muted}>
          No candidates to review. The weekly screen found nothing new in the theme ETFs / SEC codes,
          and no held name is weak or stale.
        </p>
      )}

      {/* Dismissed (rejected) — with undo */}
      {dismissed > 0 && (
        <Group title={`Dismissed (${dismissed})`} icon={<RotateCcw size={14} style={{ color: 'var(--text-secondary)' }} />} muted>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {ignored.map((tk) => (
              <Dismissed key={`ig:${tk}`} ticker={tk} label="add" busy={busy === tk}
                onUndo={() => decide({ action: 'restore', kind: 'add', ticker: tk })} />
            ))}
            {kept.map((tk) => (
              <Dismissed key={`kp:${tk}`} ticker={tk} label="kept" busy={busy === tk}
                onUndo={() => decide({ action: 'restore', kind: 'drop', ticker: tk })} />
            ))}
          </div>
        </Group>
      )}
    </div>
  )
}

function Standing({ res }) {
  const s = res.standing
  const tone = s ? (STATUS_TONE[s.status] || 'neutral') : 'neutral'
  return (
    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Pill tone="info" soft>conviction {res.conviction}{res.price != null ? ` · $${(+res.price).toFixed(2)}` : ''}</Pill>
      {s
        ? <Pill tone={tone} soft>Analyst #{s.rank}/{s.total} · {s.status.replace('_', ' ')}</Pill>
        : <Pill tone="warning" soft>added — will rank on next price refresh</Pill>}
      {s?.note && <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{s.note}</span>}
      {(res.basis || []).length > 0 && (
        <span style={{ fontSize: 11, color: 'var(--text-muted, var(--text-secondary))', fontStyle: 'italic' }}>
          {res.basis.join(' · ')}
        </span>
      )}
    </div>
  )
}

function BulkBanner({ r }) {
  let text
  if (r.applied === 'add') {
    const blocked = (r.names || []).filter((n) => n.status === 'blocked').length
    text = `Approved ${r.count} add${r.count === 1 ? '' : 's'} — provisional scores assigned, prices fill on the next refresh`
      + (blocked ? ` · ${blocked} below the buy floor (need a thesis)` : '')
  } else if (r.applied === 'drop') {
    text = `Removed ${r.count} name${r.count === 1 ? '' : 's'} from the universe`
  } else if (r.applied === 'ignore' || r.applied === 'keep') {
    text = `Dismissed ${r.count} candidate${r.count === 1 ? '' : 's'}`
  } else {
    text = 'Nothing to apply.'
  }
  const color = r.applied === 'drop' ? RED : GREEN
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 2px 10px', padding: '8px 11px',
                  border: `1px solid ${color}`, borderRadius: 9, background: 'var(--bg-card, transparent)' }}>
      <CheckCheck size={15} style={{ color, flexShrink: 0 }} />
      <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{text}</span>
    </div>
  )
}

function Dismissed({ ticker, label, onUndo, busy }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px',
                   border: '1px solid var(--border)', borderRadius: 8, fontSize: 12.5 }}>
      <span style={{ fontWeight: 600 }}>{ticker}</span>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <button onClick={onUndo} disabled={busy} title="Undo — put it back in the review queue"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent',
                 color: BLUE, cursor: 'pointer', fontSize: 12, padding: 0 }}>
        <RotateCcw size={12} /> Undo
      </button>
    </span>
  )
}

function Group({ title, icon, children, muted: isMuted, action }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        {icon}
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: isMuted ? 'var(--text-secondary)' : 'var(--text-primary)' }}>{title}</h3>
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  )
}

const card = {
  border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 22,
  background: 'var(--bg-elevated, var(--bg-secondary))',
}
const row = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px',
  border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-card, transparent)',
}
const rowSub = { fontSize: 12.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const muted = { fontSize: 13, color: 'var(--text-secondary)', margin: '2px' }
const genBtn = {
  fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 7, cursor: 'pointer',
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
}
const bulkBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600,
  padding: '4px 10px', borderRadius: 7, cursor: 'pointer', border: '1px solid', background: 'transparent',
}
const kindBadge = {
  fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, padding: '3px 7px', borderRadius: 6,
  border: '1px solid', flexShrink: 0,
}
const actBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 600,
  padding: '6px 11px', borderRadius: 8, cursor: 'pointer', border: '1px solid', background: 'transparent',
  flexShrink: 0,
}
