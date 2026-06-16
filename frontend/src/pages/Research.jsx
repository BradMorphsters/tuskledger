/**
 * Research — the long-term-hold cockpit.
 *
 * Split view (spec: "Both"):
 *   1. Your positions — every security you hold that the research universe
 *      covers, joined onto its overlay: thesis, next catalyst (with overdue
 *      flag), invalidation triggers, conviction/upside, and a stale badge.
 *   2. The universe — the full scored list, ranked by conviction, with the
 *      names you hold marked, plus tier / conviction / held filters.
 *
 * Data is PII-free in the file; positions are joined onto live holdings at
 * query time by the backend, so the same page works in demo mode (it just
 * shows no held overlay when the synthetic portfolio doesn't overlap).
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Gem, AlertTriangle, Target, Clock, Flag, TrendingUp, X, RefreshCw,
} from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
  ScatterChart, Scatter, ZAxis,
} from 'recharts'
import {
  getResearchDomains, getResearchPositions, getResearchUniverse,
  getResearchAlerts, getResearchEntity, getResearchHistory, getResearchPrices,
  getSignalsForTicker, getEdgarForTicker, setActiveIndustry, createIndustry,
} from '../api/client'
import { formatCurrency, formatCompactCurrency, formatDate } from '../lib/format'
import Pill from '../components/Pill'
import EmptyState from '../components/EmptyState'
import PublicActivityDetail, { SignalBadge, TrendArrow } from '../components/PublicActivity'
import EdgarActivity from '../components/EdgarActivity'
import { getSignalsFeed } from '../api/client'

const POS = 'var(--accent-green, #10b981)'
const NEG = 'var(--accent-red, #ef4444)'
const BLUE = 'var(--accent-blue, #3b82f6)'
const ORANGE = 'var(--accent-orange, #fb923c)'
const GOLD = 'var(--accent-gold, #c79a1e)'  // Tier 2 — distinct from green/red on dark + light

const sevTone = (s) => ({ high: 'danger', med: 'warning', low: 'info' }[s] || 'neutral')
const riskTone = (r) => {
  const v = (r || '').toLowerCase()
  if (v.startsWith('v')) return 'danger'
  if (v === 'high') return 'danger'
  if (v === 'med') return 'warning'
  if (v === 'low') return 'success'
  return 'neutral'
}
const catTone = (s) => ({
  hit: 'success', missed: 'danger', in_progress: 'info', ongoing: 'info', upcoming: 'neutral',
}[s] || 'neutral')
const flagLabel = {
  large_position: 'Large position', below_cost: 'Below cost',
  overdue_catalyst: 'Overdue catalyst', stale_research: 'Stale', invalidation_watch: 'Invalidation watch',
}
const tierLabel = { 1: 'Tier 1 · Producing', 2: 'Tier 2 · Near-term', 3: 'Tier 3 · Speculative' }

function ScoreBar({ value, color = BLUE }) {
  const v = Math.max(0, Math.min(100, value || 0))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, minWidth: 44, height: 6, background: 'var(--bg-hover)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${v}%`, height: '100%', background: color }} />
      </div>
      <span style={{ fontSize: 12, fontWeight: 600, width: 24, textAlign: 'right' }}>
        {value ?? '—'}
      </span>
    </div>
  )
}

function HeldDot({ held }) {
  return (
    <span
      title={held ? 'You hold this' : 'Watchlist (not held)'}
      style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: 4,
        background: held ? POS : 'var(--border)', marginRight: 8, flexShrink: 0,
      }}
    />
  )
}

function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

// Parse the approximate research price string ('~$28', '~$80 ADS') to a number.
function parsePrice(v) {
  if (v == null) return null
  if (typeof v === 'number') return v
  const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}
const money = (n) =>
  n == null ? '—' : '$' + (Math.abs(n) < 10 ? Number(n).toFixed(2) : Math.round(n).toLocaleString('en-US'))

// Where current price sits relative to the analyst target range. Descriptive,
// not predictive — "oversold vs targets" means trading at/below the low target,
// NOT an RSI/momentum signal (we don't store the price history that needs).
function targetMetrics(current, targets) {
  if (!targets || targets.low == null || targets.high == null || current == null || current <= 0) return null
  const { low, base, high } = targets
  const span = high - low
  const rangePos = span > 0 ? (current - low) / span : null  // <0 = below the whole range
  const toHigh = ((high - current) / current) * 100
  const toBase = base != null ? ((base - current) / current) * 100 : null
  const toLow = ((low - current) / current) * 100
  // Color-graded green→red: green = oversold (cheap vs analyst low),
  // amber = mid-range, red = at/above the high target ("High").
  let signal, label, tone, color
  if (current < low) { signal = 'below_range'; label = 'Oversold vs targets'; tone = 'success'; color = POS }
  else if (rangePos != null && rangePos < 0.25) { signal = 'low_zone'; label = 'Bottom of range'; tone = 'info'; color = BLUE }
  else if (rangePos == null || rangePos <= 0.66) { signal = 'mid_zone'; label = 'Mid-range'; tone = 'warning'; color = ORANGE }
  else if (current <= high) { signal = 'high_zone'; label = 'Top of range'; tone = 'danger'; color = NEG }
  else { signal = 'above_range'; label = 'Above all targets'; tone = 'danger'; color = NEG }
  return { rangePos, toHigh, toBase, toLow, signal, label, tone, color }
}

// Coarse period/date → JS Date (mirrors the backend period_end), for timelines.
function periodEnd(s) {
  if (!s) return null
  s = String(s).trim()
  let m
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return new Date(+m[1], +m[2] - 1, +m[3])
  if ((m = s.match(/^(\d{4})-?Q([1-4])$/i))) {
    const mo = [2, 5, 8, 11][+m[2] - 1], d = [31, 30, 30, 31][+m[2] - 1]
    return new Date(+m[1], mo, d)
  }
  if ((m = s.match(/^(\d{4})-?H([12])$/i))) return +m[2] === 1 ? new Date(+m[1], 5, 30) : new Date(+m[1], 11, 31)
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) return new Date(+m[1], +m[2], 0)
  if ((m = s.match(/^(\d{4})$/))) return new Date(+m[1], 11, 31)
  return null
}

// ── Current price vs published analyst target range ─────────────────────
// NOT a forecast or recommendation — sourced, labeled, equities-only.
function TargetRange({ current, targets, compact = false }) {
  const { low, base, high } = targets || {}
  if (low == null || high == null) return null
  const cur = current ?? null
  const domMin = Math.min(low, cur ?? low)
  const domMax = Math.max(high, cur ?? high)
  const pad = (domMax - domMin) * 0.08 || 1
  const lo = domMin - pad, hi = domMax + pad
  const pct = (x) => `${((x - lo) / (hi - lo)) * 100}%`
  const barH = compact ? 8 : 10
  const m = targetMetrics(cur, targets)
  return (
    <div style={{ width: '100%' }}>
      <div style={{ position: 'relative', height: barH, marginTop: compact ? 8 : 18, marginBottom: 4 }}>
        <div style={{ position: 'absolute', left: pct(low), width: `calc(${pct(high)} - ${pct(low)})`, top: 0, height: barH, background: 'rgba(59,130,246,0.25)', borderRadius: barH / 2 }} />
        {base != null && <div style={{ position: 'absolute', left: pct(base), top: -3, height: barH + 6, width: 2, background: BLUE }} />}
        {cur != null && (
          <div title={`Current ${money(cur)}`} style={{ position: 'absolute', left: pct(cur), top: -5, transform: 'translateX(-50%)' }}>
            <div style={{ width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: `7px solid ${m ? m.color : 'var(--text-primary)'}` }} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)' }}>
        <span>{money(low)}</span>
        {base != null && <span style={{ color: BLUE }}>base {money(base)}</span>}
        <span>{money(high)}</span>
      </div>
      {m && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: compact ? 4 : 8, flexWrap: 'wrap' }}>
          <Pill tone={m.tone} soft title="Where current price sits in the analyst target range (descriptive, not an RSI/momentum signal)">{m.label}</Pill>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {m.toHigh >= 0 ? '+' : ''}{m.toHigh.toFixed(0)}% to high
            {!compact && m.toBase != null ? ` · ${m.toBase >= 0 ? '+' : ''}${m.toBase.toFixed(0)}% to base` : ''}
          </span>
        </div>
      )}
      {!compact && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          {cur != null && <div>Current <strong>{money(cur)}</strong></div>}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {targets.n_analysts ? `${targets.n_analysts} analysts · ` : ''}{targets.basis || 'analyst range'}{targets.as_of ? ` · as of ${targets.as_of}` : ''}
            {targets.url
              ? <> · <a href={targets.url} target="_blank" rel="noreferrer" style={{ color: BLUE }}>{targets.source || 'source'}</a></>
              : (targets.source ? ` · ${targets.source}` : '')}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
            Published analyst targets — not investment advice or a Tusk Ledger forecast.
          </div>
        </div>
      )}
    </div>
  )
}

// ── Forward catalyst timeline ───────────────────────────────────────────
function CatalystTimeline({ catalysts }) {
  const today = new Date()
  const rows = (catalysts || [])
    .map(c => ({ ...c, _d: periodEnd(c.due) }))
    .sort((a, b) => (a._d ? a._d.getTime() : Infinity) - (b._d ? b._d.getTime() : Infinity))
  if (!rows.length) return null
  return (
    <div style={{ position: 'relative', paddingLeft: 16 }}>
      <div style={{ position: 'absolute', left: 4, top: 4, bottom: 4, width: 2, background: 'var(--border)' }} />
      {rows.map((c, i) => {
        const status = (c.status || 'upcoming').toLowerCase()
        const active = status === 'upcoming' || status === 'in_progress' || status === 'ongoing'
        const overdue = c._d && c._d < today && active
        const color = overdue ? NEG : status === 'hit' ? POS : status === 'missed' ? NEG : active ? BLUE : 'var(--text-muted)'
        return (
          <div key={i} style={{ position: 'relative', marginBottom: 12, fontSize: 13 }}>
            <div style={{ position: 'absolute', left: -16, top: 3, width: 10, height: 10, borderRadius: 5, background: color, border: '2px solid var(--bg-card)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {c.due && <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)', fontSize: 12, minWidth: 64 }}>{c.due}</span>}
              <Pill tone={catTone(status)} soft>{status.replace('_', ' ')}</Pill>
              {overdue && <Pill tone="danger">overdue</Pill>}
            </div>
            <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{c.description}</div>
          </div>
        )
      })}
    </div>
  )
}

// ── Thesis-drift chart (conviction/upside over time) ────────────────────
function ThesisDrift({ history }) {
  const data = useMemo(() => {
    const rows = (history || []).filter(r => r.conviction != null || r.upside != null)
    const byKey = new Map()
    for (const r of rows) byKey.set(r.as_of, r)  // keep latest row per as_of
    return [...byKey.values()].sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)))
  }, [history])
  if (data.length < 2) {
    return (
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>
        {data.length === 0 ? 'No snapshots yet.' : `1 snapshot recorded (${data[0].as_of}).`} The
        conviction/upside trend builds as the daily job records a point each day.
      </p>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={170}>
      <LineChart data={data} margin={{ top: 6, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="as_of" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={28} />
        <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
        <Line type="monotone" dataKey="conviction" stroke={BLUE} strokeWidth={2} dot={{ r: 2 }} name="Conviction" />
        <Line type="monotone" dataKey="upside" stroke={ORANGE} strokeWidth={2} dot={{ r: 2 }} name="Upside" />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Price history (real monthly closes via Stooq, vs analyst target band) ─
function PriceHistory({ prices, targets }) {
  // prices: undefined = loading; null or {available:false} = unavailable;
  // otherwise { history:[{as_of,close}], current, source, ... }
  if (prices === undefined) {
    return <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>Loading price history…</p>
  }
  const series = (prices && prices.history) || []
  if (!prices || prices.available === false || series.length < 2) {
    return (
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>
        Price history unavailable for this ticker. The analyst target band above still applies.
      </p>
    )
  }
  const data = series.map(r => ({ as_of: r.as_of, price: r.close }))
  const t = targets && targets.low != null ? targets : null
  const px = data.map(d => d.price)
  let lo = Math.min(...px), hi = Math.max(...px)
  if (t) { lo = Math.min(lo, t.low); hi = Math.max(hi, t.high) }
  const pad = (hi - lo) * 0.1 || 1
  const domain = [Math.max(0, lo - pad), hi + pad]
  return (
    <>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} margin={{ top: 6, right: 46, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="as_of" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} minTickGap={24} />
          <YAxis domain={domain} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={40} tickFormatter={(v) => money(v)} />
          <Tooltip formatter={(v) => money(v)} contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
          {/* Short value-only labels (colour shows which is high/base/low) so they
              fit inside the right margin instead of clipping at the panel edge. */}
          {t && <ReferenceLine y={t.high} stroke={NEG} strokeDasharray="4 3" label={{ value: money(t.high), position: 'right', fontSize: 10, fill: NEG }} />}
          {t && t.base != null && <ReferenceLine y={t.base} stroke={ORANGE} strokeDasharray="4 3" label={{ value: money(t.base), position: 'right', fontSize: 10, fill: ORANGE }} />}
          {t && <ReferenceLine y={t.low} stroke={POS} strokeDasharray="4 3" label={{ value: money(t.low), position: 'right', fontSize: 10, fill: POS }} />}
          <Line type="monotone" dataKey="price" stroke={BLUE} strokeWidth={2} dot={false} name="Price" />
        </LineChart>
      </ResponsiveContainer>
      {prices.momentum && (
        <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--text-secondary)' }}>
          Momentum <strong>{prices.momentum.score}/100</strong>
          {prices.momentum.pct_off_low != null ? ` · ${prices.momentum.pct_off_low >= 0 ? '+' : ''}${prices.momentum.pct_off_low}% off 52w low` : ''}
          {prices.momentum.ret_3mo_pct != null ? ` · 3mo ${prices.momentum.ret_3mo_pct >= 0 ? '+' : ''}${prices.momentum.ret_3mo_pct}%` : ''}
          {prices.momentum.vol_trend && prices.momentum.vol_trend !== 'flat' ? ` · volume ${prices.momentum.vol_trend}` : ''}
        </p>
      )}
      <p style={{ margin: '6px 0 0', fontSize: 10.5, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        Monthly closes via {prices.source === 'twelvedata' ? 'Twelve Data' : 'Yahoo Finance'}{prices.current != null ? ` · last ${money(prices.current)}` : ''}{prices.stale ? ' · cached' : ''}; dashed lines are the analyst target band.
      </p>
    </>
  )
}

// ── Alerts ──────────────────────────────────────────────────────────────
function AlertsPanel({ alerts }) {
  const [open, setOpen] = useState(false)
  if (!alerts?.length) return null
  const shown = open ? alerts : alerts.slice(0, 5)
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={16} style={{ color: ORANGE }} /> Alerts
          <Pill tone="neutral" soft>{alerts.length}</Pill>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {shown.map((a, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13 }}>
            <Pill tone={sevTone(a.severity)} style={{ flexShrink: 0, textTransform: 'uppercase' }}>
              {a.severity}
            </Pill>
            <span style={{ color: 'var(--text-secondary)' }}>
              {a.message}
              {a.source && (
                <span style={{ marginLeft: 6, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.3, color: 'var(--text-muted)' }}>
                  · {a.source === 'edgar' ? 'SEC' : a.source}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
      {alerts.length > 5 && (
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            marginTop: 10, background: 'transparent', border: 'none',
            color: BLUE, fontSize: 12, cursor: 'pointer', padding: 0,
          }}
        >
          {open ? 'Show fewer' : `Show all ${alerts.length}`}
        </button>
      )}
    </div>
  )
}

// ── Position card (the cockpit) ─────────────────────────────────────────
function PositionCard({ p, onOpen }) {
  const r = p.research
  const pos = p.position
  const gl = pos.unrealized_gl
  const glColor = gl == null ? 'var(--text-muted)' : gl >= 0 ? POS : NEG
  const nc = r.next_catalyst
  return (
    <div
      className="card"
      onClick={() => onOpen(r.id, pos.current_price)}
      style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 15 }}>{p.ticker}</strong>
            {r.tier != null && <Pill tone="neutral" soft>{`T${r.tier}`}</Pill>}
            {r.risk_rating && <Pill tone={riskTone(r.risk_rating)} soft>{r.risk_rating} risk</Pill>}
            {r.review?.stale && <Pill tone="warning"><Clock size={11} /> Stale</Pill>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {p.name} · {r.category || p.security_type}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{formatCurrency(pos.market_value)}</div>
          <div style={{ fontSize: 12, color: glColor }}>
            {gl == null ? '—' : `${gl >= 0 ? '+' : ''}${formatCurrency(gl)}`}
            {pos.weight_pct != null && (
              <span style={{ color: 'var(--text-muted)' }}> · {pos.weight_pct}%</span>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Conviction</div>
          <ScoreBar value={r.conviction} color={BLUE} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>Upside</div>
          <ScoreBar value={r.upside} color={ORANGE} />
        </div>
      </div>

      {r.thesis_summary && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {r.thesis_summary}
        </p>
      )}

      {nc && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <Target size={13} style={{ color: nc.overdue ? NEG : 'var(--text-muted)' }} />
          <span style={{ color: 'var(--text-secondary)' }}>{nc.description}</span>
          {nc.due && <Pill tone={nc.overdue ? 'danger' : 'neutral'} soft>{nc.overdue ? 'Overdue · ' : ''}{nc.due}</Pill>}
        </div>
      )}

      {p.security_type === 'equity' && r.price_targets && r.price_targets.low != null && (
        <div onClick={e => e.stopPropagation()}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Current vs analyst target
          </div>
          <TargetRange current={pos.current_price ?? r.current_price} targets={r.price_targets} compact />
        </div>
      )}

      {!!(p.flags || []).length && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {p.flags.map(f => (
            <Pill key={f} tone={f === 'below_cost' || f === 'overdue_catalyst' ? 'danger' : f === 'large_position' ? 'info' : 'warning'} soft>
              {flagLabel[f] || f}
            </Pill>
          ))}
        </div>
      )}

      {!!(pos.accounts || []).length && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {pos.accounts.join(' · ')}
          {!!(pos.tax_buckets || []).length && <> · {pos.tax_buckets.join(', ')}</>}
        </div>
      )}
    </div>
  )
}

// ── Conviction × Upside scatter (the watchlist map) ──────────────────────
const TIER_COLOR = { 1: POS, 2: GOLD, 3: NEG }
const TIER_DOT_LABEL = { 1: 'Tier 1 · producing', 2: 'Tier 2 · near-term', 3: 'Tier 3 · speculative' }

// Collapse the granular research category into one coarse primary mineral so
// the chart can offer a short, useful filter (there are ~40 raw categories).
function primaryMineral(category) {
  const c = (category || '').toLowerCase()
  const groups = [
    ['Lithium', ['lithium', 'li ', 'dle', 'boron', 'clay']],
    ['Uranium / Nuclear', ['uranium', 'u3o8', 'u miners', 'enrichment', 'westinghouse', 'nuclear', 'smr', 'fuel']],
    ['Rare earths', ['rare earth', 'ree', 're /', 're miners', 'magnet', 'niobium', 'scandium', 'separation', 'reelement']],
    ['Copper', ['copper']],
    ['Graphite', ['graphite', 'anode']],
    ['Tungsten', ['tungsten']],
    ['Antimony', ['antimony']],
    ['Nickel / Cobalt', ['nickel', 'cobalt']],
    ['Manganese', ['manganese']],
    ['Diversified / Broad', ['broad', 'diversified', 'transition-metal', 'metals & mining', 'strategic-metal', 'battery-metal', 'battery makers', 'full li', 'supply chain', 'equal-weight', 'miners +', 'miners explicitly']],
  ]
  for (const [label, keys] of groups) if (keys.some(k => c.includes(k))) return label
  return 'Other'
}

function ScatterTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 12, boxShadow: '0 6px 20px rgba(0,0,0,0.3)', maxWidth: 240 }}>
      <div style={{ fontWeight: 700, marginBottom: 1 }}>
        {d.held ? '● ' : ''}{d.ticker}
      </div>
      <div style={{ color: 'var(--text-secondary)' }}>{d.name}</div>
      {d.category && <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 1 }}>{d.category}</div>}
      <div style={{ marginTop: 5 }}>Conviction <strong>{d.conviction}</strong> · Upside <strong>{d.upside}</strong></div>
      {d.tier != null && <div style={{ color: TIER_COLOR[d.tier], marginTop: 2, fontWeight: 600 }}>{TIER_DOT_LABEL[d.tier]}</div>}
      <div style={{ color: 'var(--text-muted)', marginTop: 5, fontSize: 11 }}>Click for the full thesis →</div>
    </div>
  )
}

function ConvictionUpsideScatter({ rows, onOpen, asOf }) {
  const [tab, setTab] = useState('equity')   // 'equity' | 'fund'
  const [tierSel, setTierSel] = useState('') // '', '1', '2', '3'
  const [mineral, setMineral] = useState('')
  const [q, setQ] = useState('')

  const counts = useMemo(() => ({
    equity: rows.filter(r => r.security_type === 'equity').length,
    fund: rows.filter(r => r.security_type !== 'equity').length,
  }), [rows])

  const base = useMemo(
    () => rows.filter(r => (tab === 'equity' ? r.security_type === 'equity' : r.security_type !== 'equity')),
    [rows, tab],
  )

  const minerals = useMemo(() => [...new Set(base.map(r => primaryMineral(r.category)))].sort(), [base])

  const filtered = useMemo(() => base
    .filter(r => {
      if (r.conviction == null || r.upside == null) return false
      if (tab === 'equity' && tierSel && String(r.tier) !== tierSel) return false
      if (mineral && primaryMineral(r.category) !== mineral) return false
      if (q) {
        const hay = `${r.ticker} ${r.name} ${r.category || ''}`.toLowerCase()
        if (!hay.includes(q.toLowerCase())) return false
      }
      return true
    })
    .map(r => ({ ...r, x: r.conviction, y: r.upside })), [base, tab, tierSel, mineral, q])

  // Equities split into one Scatter series per tier (gives the coloured legend);
  // funds carry no tier, so they're a single blue series.
  const series = useMemo(() => {
    if (tab !== 'equity') return [{ key: 'fund', name: 'ETF / Fund', color: BLUE, data: filtered }]
    return [1, 2, 3]
      .map(t => ({ key: `t${t}`, name: TIER_DOT_LABEL[t], color: TIER_COLOR[t], data: filtered.filter(r => r.tier === t) }))
      .filter(s => s.data.length)
  }, [filtered, tab])

  const handleClick = (pt) => {
    const d = pt && (pt.payload || pt)
    if (d?.id) onOpen(d.id, d.current_price)
  }

  const tabStyle = (active) => ({
    padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: 'none', borderBottom: `2px solid ${active ? BLUE : 'transparent'}`,
    background: 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)',
  })
  const chipStyle = (active) => ({
    padding: '5px 12px', fontSize: 12.5, cursor: 'pointer', borderRadius: 999,
    border: `1px solid ${active ? BLUE : 'var(--border)'}`,
    background: active ? 'var(--accent-blue-bg, rgba(59,130,246,0.12))' : 'transparent',
    color: active ? BLUE : 'var(--text-secondary)', fontWeight: active ? 600 : 400,
  })
  const inputStyle = { background: 'var(--bg-input, var(--bg-card))', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 13 }

  return (
    <div className="card" style={{ marginBottom: 20, padding: 0, overflow: 'hidden' }}>
      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', padding: '0 8px' }}>
        <button onClick={() => { setTab('equity'); setTierSel('') }} style={tabStyle(tab === 'equity')}>Equities ({counts.equity})</button>
        <button onClick={() => { setTab('fund'); setTierSel('') }} style={tabStyle(tab === 'fund')}>ETFs &amp; Funds ({counts.fund})</button>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', padding: 16 }}>
        {/* Chart */}
        <div style={{ flex: '1 1 460px', minWidth: 300 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Conviction vs. Upside</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
            Each name plotted by its two scores. Top-right = strong on both.{tab === 'equity' ? ' Color = tier.' : ''}
          </div>
          <ResponsiveContainer width="100%" height={360}>
            <ScatterChart margin={{ top: 10, right: 18, bottom: 28, left: 6 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis
                type="number" dataKey="x" name="Conviction" domain={[40, 100]}
                ticks={[40, 50, 60, 70, 80, 90, 100]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                label={{ value: 'Conviction (quality)', position: 'insideBottom', offset: -14, fontSize: 12, fill: 'var(--text-muted)' }}
              />
              <YAxis
                type="number" dataKey="y" name="Upside" domain={[40, 100]} width={44}
                ticks={[40, 50, 60, 70, 80, 90, 100]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                label={{ value: 'Upside (torque)', angle: -90, position: 'insideLeft', offset: 16, fontSize: 12, fill: 'var(--text-muted)' }}
              />
              <ZAxis range={[70, 70]} />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<ScatterTooltip />} />
              {series.map(s => (
                <Scatter key={s.key} name={s.name} data={s.data} fill={s.color} fillOpacity={0.85} onClick={handleClick} style={{ cursor: 'pointer' }} />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            {(tab === 'equity'
              ? [1, 2, 3].map(t => ({ color: TIER_COLOR[t], label: TIER_DOT_LABEL[t] }))
              : [{ color: BLUE, label: 'ETF / Fund' }]
            ).map((l, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 9, height: 9, borderRadius: 5, background: l.color, display: 'inline-block' }} />
                {l.label}
              </span>
            ))}
            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>{filtered.length} shown</span>
          </div>
        </div>

        {/* How to use this */}
        <aside style={{ flex: '0 1 260px', minWidth: 220, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--text-primary)' }}>How to use this</div>
          <p style={{ margin: '4px 0 0', color: 'var(--text-muted)' }}>A working watchlist, not advice.</p>
          <p style={{ margin: '10px 0 0' }}>
            <strong>Conviction</strong> ranks quality / risk-adjusted strength. <strong>Upside</strong> leans toward
            torque — smaller caps with big catalysts and re-rating room.
          </p>
          <p style={{ margin: '10px 0 0' }}>
            Filter by <strong>tier</strong> for a balanced basket: Tier 1 as ballast, Tier 2 for funded upside,
            Tier 3 sized small. Click any dot for the thesis and factor breakdown.
          </p>
          <p style={{ margin: '10px 0 0', fontSize: 11.5, color: 'var(--text-muted)' }}>
            Scores are approximate{asOf ? ` as of ${asOf}` : ''} — verify live before acting. China's suspension of
            antimony / gallium / germanium / tungsten export curbs (through Nov 2026) is a key swing factor.
          </p>
        </aside>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', padding: '12px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg-hover)' }}>
        {tab === 'equity' && (
          <div style={{ display: 'flex', gap: 6 }}>
            {[['', 'All'], ['1', 'Tier 1'], ['2', 'Tier 2'], ['3', 'Tier 3']].map(([v, l]) => (
              <button key={v} onClick={() => setTierSel(v)} style={chipStyle(tierSel === v)}>{l}</button>
            ))}
          </div>
        )}
        <select value={mineral} onChange={e => setMineral(e.target.value)} style={inputStyle}>
          <option value="">All minerals</option>
          {minerals.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input
          value={q} onChange={e => setQ(e.target.value)}
          placeholder="Search ticker, company, mineral…"
          style={{ ...inputStyle, flex: '1 1 200px', minWidth: 160 }}
        />
      </div>
    </div>
  )
}

// ── Universe table ──────────────────────────────────────────────────────
function UniverseTable({ rows, onOpen, signals = {} }) {
  const [sort, setSort] = useState({ key: 'conviction', dir: 'desc' })
  const hasFlow = Object.keys(signals).length > 0
  const sorted = useMemo(() => {
    const r = [...rows]
    const { key, dir } = sort
    r.sort((a, b) => {
      const av = a[key], bv = b[key]
      if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      return dir === 'asc' ? (av || 0) - (bv || 0) : (bv || 0) - (av || 0)
    })
    return r
  }, [rows, sort])
  const th = (key, label, align = 'left') => (
    <th
      onClick={() => setSort(s => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
      style={{ textAlign: align, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {label}{sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  )
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {th('ticker', 'Ticker')}
            {th('name', 'Name')}
            {th('category', 'Category')}
            {th('tier', 'Tier', 'center')}
            {th('conviction', 'Conviction')}
            {th('upside', 'Upside')}
            {th('risk_rating', 'Risk', 'center')}
            {th('to_high', 'Vs target')}
            {hasFlow && <th style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>Flow</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map(row => (
            <tr key={row.id} onClick={() => onOpen(row.id, row.current_price)} style={{ cursor: 'pointer' }}>
              <td style={{ whiteSpace: 'nowrap' }}>
                <HeldDot held={row.held} />
                <strong>{row.ticker}</strong>
                {row.stale && <Clock size={12} style={{ color: ORANGE, marginLeft: 6 }} />}
              </td>
              <td style={{ color: 'var(--text-secondary)' }}>{row.name}</td>
              <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{row.category || '—'}</td>
              <td style={{ textAlign: 'center' }}>{row.tier ?? '—'}</td>
              <td style={{ minWidth: 120 }}><ScoreBar value={row.conviction} color={BLUE} /></td>
              <td style={{ minWidth: 120 }}><ScoreBar value={row.upside} color={ORANGE} /></td>
              <td style={{ textAlign: 'center' }}>
                {row.risk_rating ? <Pill tone={riskTone(row.risk_rating)} soft>{row.risk_rating}</Pill> : '—'}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {(() => {
                  const m = targetMetrics(row.current_price, row.price_targets)
                  if (m) return (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <Pill tone={m.tone} soft>{m.label}</Pill>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m.toHigh >= 0 ? '+' : ''}{m.toHigh.toFixed(0)}%</span>
                    </span>
                  )
                  return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{row.security_type === 'equity' ? 'no coverage' : '—'}</span>
                })()}
              </td>
              {hasFlow && (
                <td style={{ whiteSpace: 'nowrap' }}>
                  {(() => {
                    const s = signals[row.ticker]
                    if (!s) return <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {s.signal ? <SignalBadge signal={s.signal} /> : null}
                        {s.dpi_recent != null && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--text-muted)' }}>
                            DPI {s.dpi_recent} <TrendArrow trend={s.dpi_trend} />
                          </span>
                        )}
                      </span>
                    )
                  })()}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Entity detail drawer ────────────────────────────────────────────────
function EntityDrawer({ domain, id, livePrice, onClose }) {
  const [ent, setEnt] = useState(null)
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [chartMode, setChartMode] = useState('price')
  const [prices, setPrices] = useState(undefined)  // undefined=loading
  const [signals, setSignals] = useState(undefined)
  const [edgar, setEdgar] = useState(undefined)
  useEffect(() => {
    let alive = true
    setLoading(true); setHistory([]); setPrices(undefined); setSignals(undefined); setEdgar(undefined)
    getResearchEntity(domain, id).then(e => {
      if (!alive) return
      setEnt(e); setLoading(false)
      getResearchHistory(domain).then(h => { if (alive) setHistory((h || []).filter(r => r.id === id)) }).catch(() => {})
      if (e.ticker) {
        getResearchPrices(domain, e.ticker).then(p => { if (alive) setPrices(p) }).catch(() => { if (alive) setPrices(null) })
        getSignalsForTicker(domain, e.ticker).then(s => { if (alive) setSignals(s) }).catch(() => { if (alive) setSignals(null) })
        if (e.security_type === 'equity') {
          getEdgarForTicker(domain, e.ticker).then(x => { if (alive) setEdgar(x) }).catch(() => { if (alive) setEdgar(null) })
        } else if (alive) { setEdgar(null) }
      } else if (alive) { setPrices(null); setSignals(null); setEdgar(null) }
    }).catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [domain, id])

  const f = ent?.fundamentals || {}
  // Authoritative current price: live market (Stooq) → holding price → snapshot.
  const cur = (prices && prices.current != null ? prices.current : null) ?? livePrice ?? parsePrice(f.price)
  const isEquity = ent?.security_type === 'equity'
  const pt = ent?.price_targets
  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200 }} />
      <aside style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(560px, 92vw)', zIndex: 201,
        background: 'var(--bg-card)', borderLeft: '1px solid var(--border)', boxShadow: '-8px 0 32px rgba(0,0,0,0.3)',
        overflowY: 'auto', padding: 24,
      }}>
        <button onClick={onClose} style={{ position: 'absolute', top: 16, right: 16, background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <X size={20} />
        </button>
        {loading && <p style={{ color: 'var(--text-muted)' }}>Loading…</p>}
        {ent && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 22 }}>{ent.ticker}</h2>
              {ent.tier != null && <Pill tone="neutral" soft>{tierLabel[ent.tier] || `Tier ${ent.tier}`}</Pill>}
              {ent.risk_rating && <Pill tone={riskTone(ent.risk_rating)} soft>{ent.risk_rating} risk</Pill>}
            </div>
            <div style={{ color: 'var(--text-secondary)', marginBottom: 18 }}>
              {ent.name} · {ent.category || ent.security_type}{ent.exchange ? ` · ${ent.exchange}` : ''}
            </div>

            <div className="stats-grid" style={{ marginBottom: 18 }}>
              <StatCard label="Conviction" value={ent.scores?.conviction ?? '—'} />
              <StatCard label="Upside" value={ent.scores?.upside ?? '—'} />
              {f.price && <StatCard label="Price" value={f.price} sub={f.as_of} />}
              {f.market_cap && <StatCard label="Market cap" value={f.market_cap} />}
            </div>

            {isEquity && (
              <Section title="Current price vs analyst target range">
                {pt && pt.low != null ? (
                  <TargetRange current={cur} targets={pt} />
                ) : (
                  <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>
                    {pt
                      ? `No published analyst coverage on file${pt.as_of ? ` (checked ${pt.as_of})` : ''}.`
                      : 'Analyst targets not yet sourced — the daily job fills these in for covered names.'}
                  </p>
                )}
              </Section>
            )}

            <Section title="History">
              <div style={{ display: 'inline-flex', marginBottom: 10, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                {[['price', 'Price'], ['scores', 'Conviction & upside']].map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => setChartMode(mode)}
                    style={{
                      padding: '5px 12px', fontSize: 12, cursor: 'pointer', border: 'none',
                      background: chartMode === mode ? 'var(--bg-hover)' : 'transparent',
                      color: chartMode === mode ? 'var(--text-primary)' : 'var(--text-muted)',
                      fontWeight: chartMode === mode ? 600 : 400,
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {chartMode === 'price'
                ? <PriceHistory prices={prices} targets={pt} />
                : <ThesisDrift history={history} />}
            </Section>

            <Section title="Public activity">
              <PublicActivityDetail bundle={signals} />
            </Section>

            {isEquity && (
              <Section title="SEC filings (free)">
                <EdgarActivity bundle={edgar} />
              </Section>
            )}

            {ent.thesis?.summary && (
              <Section title="Thesis">
                <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{ent.thesis.summary}</p>
                {ent.thesis.detail && (
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{ent.thesis.detail}</p>
                )}
              </Section>
            )}

            {!!(ent.catalysts || []).length && (
              <Section title="Catalyst timeline">
                <CatalystTimeline catalysts={ent.catalysts} />
              </Section>
            )}

            {!!(ent.invalidation_triggers || []).length && (
              <Section title="Invalidation triggers — what would make you sell">
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  {ent.invalidation_triggers.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </Section>
            )}

            {!!(ent.risks || []).length && (
              <Section title="Risks">
                {ent.risks.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4, fontSize: 13 }}>
                    {r.severity && <Pill tone={riskTone(r.severity)} soft>{r.severity}</Pill>}
                    <span style={{ color: 'var(--text-secondary)' }}>{r.desc}</span>
                  </div>
                ))}
              </Section>
            )}

            {ent.govt_support && (
              <Section title="Government support"><p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>{ent.govt_support}</p></Section>
            )}

            {(ent.review?.next_due || ent.updated_at) && (
              <Section title="Review">
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {ent.review?.last_reviewed && <>Last reviewed {formatDate(ent.review.last_reviewed)} · </>}
                  {ent.review?.next_due && <>Next due {formatDate(ent.review.next_due)}</>}
                  {ent.updated_at && <> · Updated {formatDate(ent.updated_at)} by {ent.updated_by || '—'}</>}
                </div>
              </Section>
            )}

            {!!(ent.sources || []).length && (
              <Section title="Sources">
                {ent.sources.map((s, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>
                    {s.confidence && <Pill tone={s.confidence === 'high' ? 'success' : s.confidence === 'medium' ? 'warning' : 'neutral'} soft>{s.confidence}</Pill>}{' '}
                    {s.url ? <a href={s.url} target="_blank" rel="noreferrer" style={{ color: BLUE }}>{s.title}</a> : s.title}
                    {s.as_of ? ` (${s.as_of})` : ''}
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
      </aside>
    </>
  )
}

// ── Industry admin (switch focus + create a new industry) ────────────────
function IndustrySwitcher({ domains, domain, onActiveChange, onDomainsChanged }) {
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [form, setForm] = useState({ domain: '', label: '', benchmark: 'SPY', sector_etfs: '' })
  const inputStyle = { background: 'var(--bg-input, var(--bg-card))', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 13 }

  const switchTo = async (d) => {
    if (!d || d === domain) return
    setBusy(true); setErr(null)
    try { await setActiveIndustry(d); onActiveChange(d) }
    catch (e) { setErr(e.message || 'Switch failed') }
    finally { setBusy(false) }
  }

  const create = async () => {
    const slug = form.domain.trim()
    if (!slug) { setErr('Industry key required'); return }
    setBusy(true); setErr(null)
    try {
      const etfs = form.sector_etfs.split(',').map(s => s.trim()).filter(Boolean)
      const res = await createIndustry({ domain: slug, label: form.label.trim() || slug, benchmark: form.benchmark.trim() || 'SPY', sector_etfs: etfs, activate: true })
      setCreating(false); setForm({ domain: '', label: '', benchmark: 'SPY', sector_etfs: '' })
      await onDomainsChanged(res.domain)
    } catch (e) { setErr(e.message || 'Create failed') }
    finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)' }}>Active industry</span>
        <select value={domain || ''} onChange={e => switchTo(e.target.value)} disabled={busy} style={inputStyle}>
          {domains.map(d => <option key={d.domain} value={d.domain}>{d.industry || d.title || d.domain}</option>)}
        </select>
        <button onClick={() => { setCreating(c => !c); setErr(null) }} disabled={busy}
          title="Create a new industry"
          style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
          ＋ New
        </button>
      </div>
      {creating && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 12, minWidth: 280 }}>
          <input style={inputStyle} placeholder="Industry key (e.g. retail)" value={form.domain} onChange={e => setForm(f => ({ ...f, domain: e.target.value }))} />
          <input style={inputStyle} placeholder="Label (e.g. retail)" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
          <input style={inputStyle} placeholder="Benchmark ticker (SPY)" value={form.benchmark} onChange={e => setForm(f => ({ ...f, benchmark: e.target.value }))} />
          <input style={inputStyle} placeholder="Sector ETFs, comma-sep (XRT, RTH)" value={form.sector_etfs} onChange={e => setForm(f => ({ ...f, sector_etfs: e.target.value }))} />
          <button onClick={create} disabled={busy}
            style={{ background: 'var(--accent-blue, #3b82f6)', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 12px', fontSize: 13, cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? 'Creating…' : 'Create + switch'}
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Creates an empty universe — add names afterward. Scores/targets stay yours to fill in.</span>
        </div>
      )}
      {err && <span style={{ fontSize: 11, color: 'var(--accent-red, #ef4444)' }}>{err}</span>}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────
export default function Research() {
  const [domains, setDomains] = useState([])
  const [domain, setDomain] = useState(null)
  const [positions, setPositions] = useState(null)
  const [universe, setUniverse] = useState([])
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [sigByTk, setSigByTk] = useState({})  // ticker -> compact flow summary
  const [allUniverse, setAllUniverse] = useState([])  // unfiltered, for the scatter map
  // Universe filters
  const [tier, setTier] = useState('')
  const [minConviction, setMinConviction] = useState(0)
  const [heldOnly, setHeldOnly] = useState(false)

  useEffect(() => {
    getResearchDomains()
      .then(d => {
        setDomains(d)
        if (d.length) setDomain(d[0].domain)
        else { setLoading(false) }
      })
      .catch(e => { setError(e.message || 'Failed to load research'); setLoading(false) })
  }, [])

  // Positions + alerts load once per domain (the cockpit doesn't filter).
  useEffect(() => {
    if (!domain) return
    setLoading(true); setError(null)
    Promise.all([getResearchPositions(domain), getResearchAlerts(domain)])
      .then(([p, a]) => { setPositions(p); setAlerts(a) })
      .catch(e => setError(e.message || 'Failed to load research'))
      .finally(() => setLoading(false))
  }, [domain])

  // Compact flow summary (Quiver signals cache) merged into the scan, read-only.
  // Degrades to {} when Quiver isn't configured — Research stays independent.
  useEffect(() => {
    if (!domain) { setSigByTk({}); return }
    getSignalsFeed(domain)
      .then(f => {
        const m = {}
        for (const r of (f?.rows || [])) {
          if (r.available) m[r.ticker] = { signal: r.signal, dpi_recent: r.dpi_recent, dpi_trend: r.dpi_trend }
        }
        setSigByTk(m)
      })
      .catch(() => setSigByTk({}))
  }, [domain])

  // Full universe (unfiltered) once per domain — feeds the conviction/upside
  // scatter, which carries its own tabs + filters independent of the table.
  useEffect(() => {
    if (!domain) { setAllUniverse([]); return }
    getResearchUniverse(domain, {})
      .then(rows => setAllUniverse(rows))
      .catch(() => setAllUniverse([]))
  }, [domain])

  // Universe re-fetches when filters change.
  useEffect(() => {
    if (!domain) return
    getResearchUniverse(domain, {
      tier: tier || undefined,
      minConviction: minConviction || undefined,
      heldOnly,
    })
      .then(rows => setUniverse(rows.map(r => {
        const m = targetMetrics(r.current_price, r.price_targets)
        return { ...r, to_high: m ? m.toHigh : null }
      })))
      .catch(() => setUniverse([]))
  }, [domain, tier, minConviction, heldOnly])

  const meta = domains.find(d => d.domain === domain)

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Gem size={28} style={{ color: BLUE }} />
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Research</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
              Long-term-hold conviction, catalysts, and invalidation triggers — joined onto the names you actually hold.
            </p>
          </div>
        </div>
        {domains.length > 0 && (
          <IndustrySwitcher
            domains={domains}
            domain={domain}
            onActiveChange={setDomain}
            onDomainsChanged={async (nd) => {
              try { const ds = await getResearchDomains(); setDomains(ds) } catch { /* keep old list */ }
              setDomain(nd)
            }}
          />
        )}
      </div>

      {error && (
        <div className="card" style={{ borderColor: NEG, marginBottom: 16 }}>
          <span style={{ color: NEG }}>{error}</span>
        </div>
      )}

      {loading && !positions && (
        <EmptyState icon={<RefreshCw size={24} className="spinning" />} title="Loading research…" />
      )}

      {!loading && !domains.length && !error && (
        <EmptyState
          icon={<Gem size={28} />}
          title="No research files yet"
          description="Drop a <domain>.research.json into the research/ folder (validated against research.schema.json) and it'll appear here."
        />
      )}

      {positions && (
        <>
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <StatCard
              label="Tracked holdings"
              value={positions.matched_count}
              sub={`${formatCompactCurrency(positions.matched_market_value)} of ${formatCompactCurrency(positions.total_market_value)}`}
            />
            <StatCard label="Universe" value={meta?.count ?? universe.length} sub={meta?.as_of ? `as of ${meta.as_of}` : null} />
            <StatCard label="Alerts" value={alerts.length} sub={alerts.filter(a => a.severity === 'high').length + ' high'} />
            <StatCard label="Unmatched holdings" value={positions.unmatched_holdings} sub="no research overlay" />
          </div>

          <AlertsPanel alerts={alerts} />

          {/* ── Section 1: the cockpit ── */}
          <h2 style={{ fontSize: 16, margin: '4px 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Flag size={16} style={{ color: POS }} /> Your positions
            <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>
              {positions.matched_count} name{positions.matched_count === 1 ? '' : 's'} held
            </span>
          </h2>
          {positions.positions.length === 0 ? (
            <EmptyState
              compact
              icon={<Gem size={24} />}
              title="None of your holdings are in this universe yet"
              description="When you hold a name that's scored here, it'll surface with its thesis, next catalyst, and invalidation triggers."
            />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14, marginBottom: 28 }}>
              {positions.positions.map(p => <PositionCard key={p.research.id} p={p} onOpen={(eid, lp) => setSelected({ id: eid, livePrice: lp })} />)}
            </div>
          )}

          {/* ── Section 2: the universe ── */}
          <h2 style={{ fontSize: 16, margin: '8px 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <TrendingUp size={16} style={{ color: BLUE }} /> Universe
          </h2>

          {allUniverse.length > 0 && (
            <ConvictionUpsideScatter
              rows={allUniverse}
              asOf={meta?.as_of}
              onOpen={(eid, lp) => setSelected({ id: eid, livePrice: lp })}
            />
          )}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            <select value={tier} onChange={e => setTier(e.target.value)}
              style={{ background: 'var(--bg-input, var(--bg-card))', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}>
              <option value="">All tiers</option>
              <option value="1">Tier 1 · Producing</option>
              <option value="2">Tier 2 · Near-term</option>
              <option value="3">Tier 3 · Speculative</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
              Min conviction {minConviction || 0}
              <input type="range" min={0} max={95} step={5} value={minConviction} onChange={e => setMinConviction(Number(e.target.value))} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={heldOnly} onChange={e => setHeldOnly(e.target.checked)} /> Held only
            </label>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>{universe.length} shown</span>
          </div>
          {universe.length === 0
            ? <EmptyState compact icon={<TrendingUp size={24} />} title="No names match these filters" />
            : <UniverseTable rows={universe} signals={sigByTk} onOpen={(eid, lp) => setSelected({ id: eid, livePrice: lp })} />}
        </>
      )}

      {selected && domain && (
        <EntityDrawer domain={domain} id={selected.id} livePrice={selected.livePrice} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
