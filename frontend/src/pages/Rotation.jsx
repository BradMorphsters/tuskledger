/**
 * Rotation — sector-level "is capital rotating in yet?" watch.
 *
 * A single rotation temperature (Early → Stirring → Rotating → Hot) from four
 * components (public-money flow, valuation re-rating, score momentum, catalyst
 * cadence), a history curve, and a local-AI (Ollama) forward read. Low = early,
 * which is the good place to be if you're early. Informational, not advice.
 */
import { useEffect, useState } from 'react'
import { Gauge, RefreshCw, Sparkles } from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { getResearchDomains, getRotation, getRotationNarrative } from '../api/client'
import { formatCompactCurrency } from '../lib/format'
import Pill from '../components/Pill'
import EmptyState from '../components/EmptyState'

const BLUE = 'var(--accent-blue, #3b82f6)'
const POS = 'var(--accent-green, #10b981)'
const ORANGE = 'var(--accent-orange, #fb923c)'
const NEG = 'var(--accent-red, #ef4444)'
const usd = (n) => (n == null ? '—' : formatCompactCurrency(n))
const stageColor = (label) => ({ Early: BLUE, Stirring: POS, Rotating: ORANGE, Hot: NEG }[label] || BLUE)

function Gauge100({ value, label }) {
  const v = Math.max(0, Math.min(100, value || 0))
  const color = stageColor(label)
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontSize: 44, fontWeight: 700, color }}>{value}</span>
        <Pill tone="neutral" soft style={{ color, borderColor: color }}>{label}</Pill>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>rotation temperature · 0 = early, 100 = fully rotated</span>
      </div>
      <div style={{ position: 'relative', height: 10, borderRadius: 5, marginTop: 10, background: 'linear-gradient(90deg, rgba(59,130,246,0.25), rgba(16,185,129,0.25), rgba(251,146,60,0.25), rgba(239,68,68,0.25))' }}>
        <div style={{ position: 'absolute', left: `${v}%`, top: -4, transform: 'translateX(-50%)', width: 3, height: 18, background: color, borderRadius: 2 }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4 }}>
        <span>Early</span><span>Stirring</span><span>Rotating</span><span>Hot</span>
      </div>
    </div>
  )
}

function ComponentCard({ title, score, children }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{title}</div>
      <div className="stat-value">{score}</div>
      <div className="stat-sub">{children}</div>
    </div>
  )
}

export default function Rotation() {
  const [domain, setDomain] = useState(null)
  const [data, setData] = useState(null)
  const [narr, setNarr] = useState(undefined)  // undefined=loading
  const [error, setError] = useState(null)

  useEffect(() => {
    getResearchDomains().then(d => { if (d.length) setDomain(d[0].domain); else setError('No research domains') })
      .catch(e => setError(e.message))
  }, [])

  useEffect(() => {
    if (!domain) return
    getRotation(domain).then(setData).catch(e => setError(e.message || 'Failed to load'))
    loadNarrative()
  }, [domain])

  const loadNarrative = () => {
    if (!domain) return
    setNarr(undefined)
    getRotationNarrative(domain).then(setNarr).catch(() => setNarr(null))
  }

  if (error) return <div style={{ padding: 16 }}><EmptyState icon={<Gauge size={28} />} title="Rotation watch" description={error} /></div>
  if (!data) return <div style={{ padding: 16 }}><EmptyState icon={<RefreshCw size={24} className="spinning" />} title="Computing rotation…" /></div>

  const c = data.components
  const cov = data.coverage || {}
  const hist = (data.history || []).filter(h => h.temperature != null)

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Gauge size={28} style={{ color: stageColor(data.label) }} />
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Rotation watch</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
            Is capital rotating into {data.domain} yet? One temperature from money flow, valuation re-rating, momentum, and catalysts.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <Gauge100 value={data.temperature} label={data.label} />
      </div>

      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <ComponentCard title="Public-money flow" score={c.flow.score}>
          {c.flow.checked ? `${c.flow.active}/${c.flow.checked} active · lobbying ${usd(c.flow.lobbying_recent_usd)}` : 'signals not warmed'}
        </ComponentCard>
        <ComponentCard title="Valuation re-rating" score={c.rerating.score}>
          {c.rerating.rated ? `${c.rerating.oversold} of ${c.rerating.rated} oversold${c.rerating.median_upside_to_high_pct != null ? ` · ~${Math.round(c.rerating.median_upside_to_high_pct)}% to high` : ''}` : '—'}
        </ComponentCard>
        <ComponentCard title="Momentum & strength" score={c.momentum.score}>
          {(() => {
            const rs = c.momentum.relative_strength || {}
            const parts = []
            if (c.momentum.price_momentum != null) parts.push(`price ${c.momentum.price_momentum}/100`)
            if (rs.available) parts.push(`ETFs ${rs.verdict} mkt`)
            else if (c.momentum.commodity_backdrop != null) parts.push(`commodity ${c.momentum.commodity_backdrop}/100`)
            if (!parts.length && c.momentum.conviction_upside_now != null) parts.push(`conviction/upside ${c.momentum.conviction_upside_now}`)
            return parts.length ? parts.join(' · ') : 'builds as snapshots accrue'
          })()}
        </ComponentCard>
        <ComponentCard title="Catalyst cadence" score={c.cadence.score}>
          {c.cadence.near_term_catalysts} due next 2 qtrs{c.cadence.overdue_catalysts ? ` · ${c.cadence.overdue_catalysts} overdue` : ''}
        </ComponentCard>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} style={{ color: BLUE }} /> AI synthesis
            {narr && narr.source && <Pill tone={narr.source === 'ollama' ? 'success' : 'neutral'} soft>{narr.source === 'ollama' ? `local AI · ${narr.model || 'ollama'}` : 'computed summary'}</Pill>}
          </div>
          <button onClick={loadNarrative} title="Regenerate" style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={12} className={narr === undefined ? 'spinning' : ''} /> Regenerate
          </button>
        </div>
        {narr === undefined ? (
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>Generating… (a local model can take ~10–25s)</p>
        ) : narr === null ? (
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>Couldn't generate a synthesis.</p>
        ) : (
          <>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{narr.narrative}</p>
            {narr.note && <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--text-muted)' }}>{narr.note} — enable a local model with <code>LLM_ENABLED=true</code> + Ollama for a written read.</p>}
          </>
        )}
      </div>

      {hist.length >= 2 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header"><div className="card-title">Rotation curve</div></div>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={hist} margin={{ top: 6, right: 12, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="as_of" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} minTickGap={24} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={28} />
              <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="temperature" stroke={BLUE} strokeWidth={2} dot={{ r: 2 }} name="Temperature" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        Coverage: {cov.valuation_rated || 0} names valued, {cov.signals_warmed || 0} signals warmed of {cov.equities || 0} equities · the 4am job warms the rest and records a daily point. Informational only, not investment advice.
      </p>
    </div>
  )
}
