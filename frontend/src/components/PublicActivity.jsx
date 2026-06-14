/**
 * Public-activity (Quiver) shared UI — a signal badge and a detail block,
 * reused by the Signals tab and the Research entity drawer.
 *
 * "Where things are going": the composite signal (Heating up / Steady /
 * Cooling) summarizes whether federal contracts, congressional buying and
 * insider buying are accelerating on a name. Informational, not advice.
 */
import { TrendingUp, TrendingDown, Minus, Landmark, Users, UserCheck, Activity } from 'lucide-react'
import Pill from './Pill'
import { formatCompactCurrency } from '../lib/format'

const sigTone = (label) => (label === 'Heating up' ? 'success' : label === 'Cooling' ? 'danger' : 'neutral')

export const DATASET_LABELS = {
  govcontracts: 'Government contracts',
  congress: 'Congressional trades',
  insider: 'Insider trades',
  lobbying: 'Lobbying',
  offexchange: 'Off-exchange / dark pool',
}

export function SignalBadge({ signal, soft = true }) {
  if (!signal || !signal.label) return null
  return (
    <Pill tone={sigTone(signal.label)} soft={soft} title={(signal.drivers || []).join(' · ')}>
      {signal.label}
    </Pill>
  )
}

export function TrendArrow({ trend }) {
  if (trend === 'up') return <TrendingUp size={13} style={{ color: 'var(--accent-green, #10b981)' }} />
  if (trend === 'down') return <TrendingDown size={13} style={{ color: 'var(--accent-red, #ef4444)' }} />
  return <Minus size={13} style={{ color: 'var(--text-muted)' }} />
}

// Deep link to Quiver's own per-ticker page — works for anyone (free web
// access or the viewing plan), no API key required.
export function QuiverLink({ ticker }) {
  if (!ticker) return null
  return (
    <a href={`https://www.quiverquant.com/congresstrading/stock/${encodeURIComponent(ticker)}`}
      target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--accent-blue, #3b82f6)' }}>
      View {ticker} on Quiver ↗
    </a>
  )
}

const usd = (n) => (n == null ? '—' : formatCompactCurrency(n))
const Row = ({ children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 4 }}>{children}</div>
)
const muted = { color: 'var(--text-muted)' }

function Block({ icon, title, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)', marginBottom: 6 }}>
        {icon} {title}
      </div>
      {children}
    </div>
  )
}

export default function PublicActivityDetail({ bundle, configured = true, compact = false }) {
  if (!configured) {
    return (
      <p style={{ margin: 0, fontSize: 12.5, ...muted }}>
        Add a Quiver <strong>API</strong> key (<code>QUIVER_API_KEY</code>) to pull this in-app. Note the API
        plan is separate from Quiver's web viewing subscription.
      </p>
    )
  }
  if (bundle === undefined) {
    return <p style={{ margin: 0, fontSize: 12.5, ...muted }}>Loading public activity…</p>
  }
  if (!bundle || !bundle.available) {
    const reason = bundle && bundle.reason
    const ticker = bundle && bundle.ticker
    return (
      <div style={{ fontSize: 12.5, ...muted }}>
        <p style={{ margin: 0 }}>
          {reason === 'no_key'
            ? "Add a Quiver API key (the API plan — separate from Quiver's web viewing subscription) to pull this in-app, or view it on Quiver's site:"
            : 'No recent public activity found in your Quiver datasets for this name.'}
        </p>
        {ticker && <p style={{ margin: '6px 0 0' }}><QuiverLink ticker={ticker} /></p>}
      </div>
    )
  }

  const gov = bundle.gov_contracts
  const con = bundle.congress
  const ins = bundle.insider
  const lob = bundle.lobbying
  const oe = bundle.offexchange

  return (
    <div>
      {bundle.signal && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <SignalBadge signal={bundle.signal} />
          <span style={{ fontSize: 12, ...muted }}>{(bundle.signal.drivers || []).join(' · ') || 'no notable activity'}</span>
        </div>
      )}

      {gov && gov.latest && (
        <Block icon={<Landmark size={13} />} title="Government contracts (quarterly obligations)">
          {gov.latest.stale ? (
            <Row><span style={muted}>No contracts in recent quarters · last {usd(gov.latest.amount)} in {gov.latest.period}</span></Row>
          ) : (
            <Row>
              <strong>{usd(gov.recent_usd_90d)}</strong> <TrendArrow trend={gov.trend} />
              <span style={muted}>{gov.latest.period} · vs {usd(gov.prior_usd_90d)} prior qtr</span>
            </Row>
          )}
        </Block>
      )}

      {con && (con.net_usd_90d != null) && (
        <Block icon={<Users size={13} />} title="Congressional trades (90d)">
          <Row>
            net <strong style={{ color: con.net_usd_90d >= 0 ? 'var(--accent-green,#10b981)' : 'var(--accent-red,#ef4444)' }}>{usd(con.net_usd_90d)}</strong>
            <span style={muted}>· {usd(con.buys_usd_90d)} buys / {usd(con.sells_usd_90d)} sells · {con.buyers_90d} buyer(s)</span>
          </Row>
          {!compact && (con.items || []).slice(0, 3).map((it, i) => (
            <Row key={i}><span style={muted}>{it.date}</span> {it.who} ({it.party || '—'}, {it.house || '—'}) · {it.tx} {usd(it.amount)}</Row>
          ))}
        </Block>
      )}

      {ins && (ins.net_usd_90d != null) && (ins.buys_90d || ins.sells_90d) && (
        <Block icon={<UserCheck size={13} />} title="Insider trades (90d)">
          <Row>
            net <strong style={{ color: ins.net_usd_90d >= 0 ? 'var(--accent-green,#10b981)' : 'var(--accent-red,#ef4444)' }}>{usd(ins.net_usd_90d)}</strong>
            <span style={muted}>· {ins.buys_90d} buy(s) / {ins.sells_90d} sell(s)</span>
          </Row>
        </Block>
      )}

      {lob && lob.recent_usd > 0 && (
        <Block icon={<Landmark size={13} />} title="Lobbying (6mo)">
          <Row><strong>{usd(lob.recent_usd)}</strong> <TrendArrow trend={lob.trend} /></Row>
        </Block>
      )}

      {oe && oe.dpi_recent != null && (
        <Block icon={<Activity size={13} />} title="Off-exchange / dark pool (30d)">
          <Row>
            DPI <strong>{oe.dpi_recent}</strong> <TrendArrow trend={oe.dpi_trend} />
            <span style={muted}>vs {oe.dpi_prior} prior{oe.short_pct != null ? ` · ${oe.short_pct}% off-exch short` : ''}</span>
          </Row>
        </Block>
      )}

      {bundle.dataset_status && Object.entries(bundle.dataset_status).some(([, s]) => s === 'gated') && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
          {Object.entries(bundle.dataset_status).filter(([, s]) => s === 'gated').map(([ds]) => (
            <Pill key={ds} tone="neutral" soft title="Available on a higher Quiver tier">
              🔒 {DATASET_LABELS[ds] || ds}
            </Pill>
          ))}
        </div>
      )}

      <div style={{ margin: '8px 0 0' }}><QuiverLink ticker={bundle.ticker} /></div>
      <p style={{ margin: '6px 0 0', fontSize: 10.5, fontStyle: 'italic', ...muted }}>
        Data: Quiver Quantitative · congressional disclosures lag up to ~45 days · informational, not advice.
      </p>
    </div>
  )
}
