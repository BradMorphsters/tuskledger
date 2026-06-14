/**
 * Signals — public-purchase activity (Quiver Quantitative), scoped to the
 * research universe and ranked by where the buying is *accelerating*.
 *
 * Columns: a composite "Heating up / Steady / Cooling" signal, government
 * contract $ (90d, with trend), net congressional buying, net insider buying.
 * Click a row for the full breakdown (same block shown in the Research drawer).
 * Informational, not advice.
 */
import { useEffect, useState, Fragment } from 'react'
import { Landmark, RefreshCw, FileText } from 'lucide-react'
import {
  getSignalsStatus, getSignalsFeed, getResearchDomains, getSignalsForTicker, refreshSignals,
  getEdgarFeed, getEdgarForTicker, refreshEdgar,
} from '../api/client'
import { formatCompactCurrency } from '../lib/format'
import Pill from '../components/Pill'
import EmptyState from '../components/EmptyState'
import PublicActivityDetail, { SignalBadge, TrendArrow } from '../components/PublicActivity'
import EdgarActivity from '../components/EdgarActivity'

const BLUE = 'var(--accent-blue, #3b82f6)'
const POS = 'var(--accent-green, #10b981)'
const usd = (n) => (n == null ? '—' : formatCompactCurrency(n))

// A name "has activity" if any public-purchase stream is non-trivial. Used to
// hide the (many) quiet names by default so real signal isn't buried.
const isActive = (r) => r.available && (
  ((r.signal && r.signal.score) || 0) !== 0 ||
  (r.gov_recent_usd_90d || 0) > 0 ||
  (r.congress_net_usd_90d || 0) !== 0 ||
  (r.insider_net_usd_90d || 0) !== 0 ||
  (r.lobbying_recent_usd || 0) > 0 ||
  r.dpi_trend === 'up'  // rising dark-pool/off-exchange activity
)

function HeldDot({ held }) {
  return <span title={held ? 'You hold this' : 'Watchlist'} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: held ? POS : 'var(--border)', marginRight: 8 }} />
}

const RED = 'var(--accent-red, #ef4444)'

// Free SEC EDGAR filing-activity section — no API key. Shown regardless of
// whether Quiver is configured, so the page has value on its own.
function EdgarSection({ domain }) {
  const [feed, setFeed] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const [detail, setDetail] = useState({})
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!domain) return
    setFeed(null)
    getEdgarFeed(domain).then(setFeed).catch(e => setErr(e.message || 'Failed to load SEC filings'))
  }, [domain])

  const refresh = async () => {
    if (!domain) return
    setRefreshing(true); setErr(null)
    try { await refreshEdgar(domain); setFeed(await getEdgarFeed(domain)) }
    catch (e) { setErr(e.message || 'Refresh failed') }
    finally { setRefreshing(false) }
  }

  const toggle = (tk) => {
    if (expanded === tk) { setExpanded(null); return }
    setExpanded(tk)
    if (!(tk in detail)) {
      setDetail(d => ({ ...d, [tk]: undefined }))
      getEdgarForTicker(domain, tk).then(b => setDetail(d => ({ ...d, [tk]: b }))).catch(() => setDetail(d => ({ ...d, [tk]: null })))
    }
  }

  const rows = feed?.rows || []
  const warmed = feed?.warmed
  const hasAct = (r) => r.available && ((r.insider_filings_90d || 0) > 0 || (r.events_8k_90d || 0) > 0 || (r.capital_raises_90d || 0) > 0)
  const active = rows.filter(hasAct)
  const shown = warmed ? (active.length ? active : rows.filter(r => r.available)) : rows

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <FileText size={20} style={{ color: BLUE }} />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>SEC filings</h2>
        <Pill tone="success" soft>free · no key</Pill>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary)', maxWidth: 720 }}>
        Pulled straight from SEC EDGAR: insider Form-4 filing activity, 8-K material events, and S-1/424B
        capital-raise (dilution) filings for each name. No subscription required.
      </p>
      {err && <div className="card" style={{ borderColor: RED, marginBottom: 12 }}><span style={{ color: RED }}>{err}</span></div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <button onClick={refresh} disabled={refreshing}
          className={`sync-btn${refreshing ? ' syncing' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 13, cursor: refreshing ? 'wait' : 'pointer' }}>
          <RefreshCw size={14} className={refreshing ? 'spinning' : ''} /> {refreshing ? 'Pulling EDGAR…' : 'Refresh filings'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {warmed ? `Showing ${active.length} name(s) with recent filing activity; refreshed daily.` : 'Not warmed yet — click Refresh (takes ~10s; the 4am job also warms it).'}
        </span>
      </div>

      {feed === null ? (
        <EmptyState icon={<RefreshCw size={20} className="spinning" />} title="Loading filings…" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Ticker</th>
                <th style={{ textAlign: 'left' }}>Name</th>
                <th style={{ textAlign: 'right' }}>Insider 4 (90d)</th>
                <th style={{ textAlign: 'right' }}>8-K (90d)</th>
                <th style={{ textAlign: 'right' }}>Raises (90d)</th>
                <th style={{ textAlign: 'left' }}>Latest</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <Fragment key={r.ticker}>
                  <tr onClick={() => toggle(r.ticker)} style={{ cursor: 'pointer' }}>
                    <td style={{ whiteSpace: 'nowrap' }}><strong>{r.ticker}</strong></td>
                    <td style={{ color: 'var(--text-secondary)' }}>{r.name}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {r.available
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>{r.insider_filings_90d ?? 0} <TrendArrow trend={r.insider_trend} /></span>
                        : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{r.available ? (r.events_8k_90d ?? 0) : '—'}</td>
                    <td style={{ textAlign: 'right', color: (r.capital_raises_90d || 0) > 0 ? RED : 'var(--text-muted)' }}>
                      {r.available ? (r.capital_raises_90d ?? 0) : '—'}
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {r.available && r.latest_filing ? `${r.latest_filing.form} · ${r.latest_filing.date}` : '—'}
                    </td>
                  </tr>
                  {expanded === r.ticker && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--bg-elevated, rgba(255,255,255,0.02))', padding: 16 }}>
                        <EdgarActivity bundle={detail[r.ticker]} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {warmed && shown.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12 }}>No equities with SEC filings found for this universe.</p>
      )}
    </div>
  )
}

export default function Signals() {
  const [domain, setDomain] = useState(null)
  const [configured, setConfigured] = useState(null) // null = loading
  const [caps, setCaps] = useState(null)
  const [feed, setFeed] = useState(null)
  const [expanded, setExpanded] = useState(null)
  const [detail, setDetail] = useState({})
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [activeOnly, setActiveOnly] = useState(true)

  useEffect(() => {
    Promise.all([getSignalsStatus(), getResearchDomains().catch(() => [])])
      .then(([s, doms]) => {
        setConfigured(!!s.configured)
        setCaps(s)
        if (doms.length) setDomain(doms[0].domain)
      })
      .catch(e => { setError(e.message); setConfigured(false) })
  }, [])

  useEffect(() => {
    if (!domain || !configured) return
    getSignalsFeed(domain).then(setFeed).catch(e => setError(e.message || 'Failed to load signals'))
  }, [domain, configured])

  const handleRefresh = async () => {
    if (!domain) return
    setRefreshing(true); setError(null)
    try { await refreshSignals(domain); setFeed(await getSignalsFeed(domain)) }
    catch (e) { setError(e.message || 'Refresh failed') }
    finally { setRefreshing(false) }
  }

  const toggle = (tk) => {
    if (expanded === tk) { setExpanded(null); return }
    setExpanded(tk)
    if (detail[tk] === undefined && !(tk in detail)) {
      setDetail(d => ({ ...d, [tk]: undefined }))
      getSignalsForTicker(domain, tk)
        .then(b => setDetail(d => ({ ...d, [tk]: b })))
        .catch(() => setDetail(d => ({ ...d, [tk]: null })))
    }
  }

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
      <Landmark size={28} style={{ color: BLUE }} />
      <div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Signals</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>
          Public-purchase activity for your research names — government contracts, congressional & insider buying, ranked by momentum.
        </p>
      </div>
    </div>
  )

  if (configured === null) {
    return <div style={{ padding: 16 }}>{header}<EmptyState icon={<RefreshCw size={24} className="spinning" />} title="Loading…" /></div>
  }

  if (!configured) {
    return (
      <div style={{ padding: 16 }}>
        {header}
        <EmptyState
          icon={<Landmark size={28} />}
          title="Connect Quiver Quantitative"
          description="This tab pulls publicly-disclosed buying — federal government contracts, congressional trades, insider Form-4 trades, and lobbying — and ranks your research universe by where that activity is accelerating. It works on any Quiver tier: a free key surfaces a subset (basic congressional data, with some lag), and a paid plan unlocks the rest — the tab shows you exactly what your key unlocks."
        />
        <div className="card" style={{ maxWidth: 620, margin: '16px auto 0', fontSize: 13, lineHeight: 1.7 }}>
          <strong>Setup</strong>
          <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            <li>Get a Quiver <strong>API</strong> key at <a href="https://api.quiverquant.com/pricing/" target="_blank" rel="noreferrer" style={{ color: BLUE }}>api.quiverquant.com</a> — this is the <strong>API plan</strong>, separate from Quiver's web/viewing subscription. (Hobbyist ~$30/mo covers congressional trades + government contracts; Trader ~$75/mo adds insider & lobbying.)</li>
            <li>Add <code>QUIVER_API_KEY=your_key</code> to <code>backend/.env</code>.</li>
            <li>Restart the backend.</li>
          </ol>
          <p style={{ margin: '10px 0 0', color: 'var(--text-muted)' }}>No API plan? You can still open any name in the Research tab and click <strong>"View on Quiver ↗"</strong> to see its data on Quiver's site. Per-name activity also appears in each stock's Research drawer once a key is set.</p>
        </div>
        <EdgarSection domain={domain} />
      </div>
    )
  }

  const rows = feed?.rows || []
  const warmed = feed?.warmed
  const activeCount = rows.filter(isActive).length
  const checked = rows.filter(r => r.available).length
  const shown = activeOnly ? rows.filter(isActive) : rows

  return (
    <div style={{ padding: 16 }}>
      {header}
      {error && <div className="card" style={{ borderColor: 'var(--accent-red,#ef4444)', marginBottom: 16 }}><span style={{ color: 'var(--accent-red,#ef4444)' }}>{error}</span></div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <button onClick={handleRefresh} disabled={refreshing}
          className={`sync-btn${refreshing ? ' syncing' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', fontSize: 13, cursor: refreshing ? 'wait' : 'pointer' }}>
          <RefreshCw size={14} className={refreshing ? 'spinning' : ''} /> {refreshing ? 'Refreshing…' : 'Refresh signals'}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {warmed ? 'Pulled from Quiver; refreshed daily.' : 'Not warmed yet — click Refresh (may take a minute; the 4am job also warms it).'}
        </span>
      </div>

      {caps && caps.configured && Object.keys(caps.datasets || {}).length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 14, fontSize: 12 }}>
          <span style={{ color: 'var(--text-muted)' }}>Your Quiver plan:</span>
          {Object.entries(caps.datasets).map(([ds, info]) => (
            <Pill key={ds} tone={info.status === 'ok' ? 'success' : 'neutral'} soft
              title={info.status === 'ok' ? 'Unlocked' : 'Upgrade your Quiver plan to unlock'}>
              {info.status === 'ok' ? '' : '🔒 '}{info.label}
            </Pill>
          ))}
          {(caps.locked || []).length > 0 && (
            <a href="https://api.quiverquant.com/pricing/" target="_blank" rel="noreferrer" style={{ color: BLUE }}>upgrade to unlock more</a>
          )}
        </div>
      )}

      {warmed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, fontSize: 12, color: 'var(--text-muted)' }}>
          <span><strong style={{ color: 'var(--text-primary)' }}>{activeCount}</strong> of {checked} checked names show recent activity{checked < rows.length ? ` · ${rows.length - checked} not pulled yet (Refresh / runs at 4am)` : ''}</span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} /> Only active
          </label>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Ticker</th>
              <th style={{ textAlign: 'left' }}>Name</th>
              <th style={{ textAlign: 'center' }}>Conv.</th>
              <th style={{ textAlign: 'left' }}>Signal</th>
              <th style={{ textAlign: 'right' }}>Gov $ (qtr)</th>
              <th style={{ textAlign: 'right' }}>Congress net</th>
              <th style={{ textAlign: 'right' }}>Insider net</th>
              <th style={{ textAlign: 'right' }}>Lobbying (6mo)</th>
              <th style={{ textAlign: 'right' }}>Dark pool DPI</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <Fragment key={r.ticker}>
                <tr onClick={() => toggle(r.ticker)} style={{ cursor: 'pointer' }}>
                  <td style={{ whiteSpace: 'nowrap' }}><HeldDot held={r.held} /><strong>{r.ticker}</strong></td>
                  <td style={{ color: 'var(--text-secondary)' }}>{r.name}</td>
                  <td style={{ textAlign: 'center' }}>{r.conviction ?? '—'}</td>
                  <td>{r.available ? <SignalBadge signal={r.signal} /> : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {r.available && r.gov_recent_usd_90d != null
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>{usd(r.gov_recent_usd_90d)} <TrendArrow trend={r.gov_trend} /></span>
                      : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: r.congress_net_usd_90d > 0 ? POS : r.congress_net_usd_90d < 0 ? 'var(--accent-red,#ef4444)' : 'var(--text-muted)' }}>
                    {r.available && r.congress_net_usd_90d != null ? usd(r.congress_net_usd_90d) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: r.insider_net_usd_90d > 0 ? POS : r.insider_net_usd_90d < 0 ? 'var(--accent-red,#ef4444)' : 'var(--text-muted)' }}>
                    {r.available && r.insider_net_usd_90d != null ? usd(r.insider_net_usd_90d) : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {r.available && (r.lobbying_recent_usd || 0) > 0
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>{usd(r.lobbying_recent_usd)} <TrendArrow trend={r.lobbying_trend} /></span>
                      : (r.available ? <span style={{ color: 'var(--text-muted)' }}>$0</span> : '—')}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {r.available && r.dpi_recent != null
                      ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>{r.dpi_recent} <TrendArrow trend={r.dpi_trend} /></span>
                      : '—'}
                  </td>
                </tr>
                {expanded === r.ticker && (
                  <tr>
                    <td colSpan={9} style={{ background: 'var(--bg-elevated, rgba(255,255,255,0.02))', padding: 16 }}>
                      <PublicActivityDetail bundle={detail[r.ticker]} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {warmed && shown.length === 0 && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 14, maxWidth: 640 }}>
          No recent public-purchase activity across your names. This watchlist is mostly junior miners and
          ETFs, where congressional / contract / insider data is naturally sparse — so treat this as a
          <strong> tripwire</strong>: the 4am briefing flags the rare day a name lands a federal contract or
          gets congressional/insider buying. Toggle off "Only active" to see the full list, or click any name
          for its detail + a "View on Quiver" link.
        </p>
      )}

      <EdgarSection domain={domain} />
    </div>
  )
}
