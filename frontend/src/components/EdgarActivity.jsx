/**
 * SEC EDGAR filing-activity detail — free (no key) public-filing signals.
 *
 * Insider Form-4 *count* activity (volume of filings, not $ — fills the gap
 * left by Quiver's tier-gated insider feed), 8-K material events, and S-1/424B
 * capital-raise (dilution) filings. Informational, not advice.
 */
import { FileText, UserCheck, Activity, DollarSign } from 'lucide-react'
import { TrendArrow } from './PublicActivity'

const muted = { color: 'var(--text-muted)' }
const Row = ({ children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 4 }}>{children}</div>
)

// Deep link to the company's filing list on EDGAR (works for everyone, no key).
function EdgarLink({ cik, ticker }) {
  const href = cik
    ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(cik)}&type=&dateb=&owner=include&count=40`
    : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(ticker || '')}&type=&dateb=&owner=include&count=40`
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--accent-blue, #3b82f6)' }}>
      View {ticker} filings on EDGAR ↗
    </a>
  )
}

export default function EdgarActivity({ bundle }) {
  if (bundle === undefined) {
    return <p style={{ margin: 0, fontSize: 12.5, ...muted }}>Loading SEC filings…</p>
  }
  if (!bundle || !bundle.available) {
    const ticker = bundle && bundle.ticker
    return (
      <div style={{ fontSize: 12.5, ...muted }}>
        <p style={{ margin: 0 }}>No recent SEC filings found for this name.</p>
        {ticker && <p style={{ margin: '6px 0 0' }}><EdgarLink cik={bundle.cik} ticker={ticker} /></p>}
      </div>
    )
  }

  const latest = bundle.latest_filing
  const hasNothing = !bundle.insider_filings_90d && !bundle.events_8k_90d && !bundle.capital_raises_90d
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Row>
          <UserCheck size={13} /> Insider filings (Form 4, 90d):
          <strong>{bundle.insider_filings_90d ?? 0}</strong> <TrendArrow trend={bundle.insider_trend} />
          <span style={muted}>vs {bundle.insider_filings_prior_90d ?? 0} prior 90d</span>
        </Row>
        <Row>
          <Activity size={13} /> Material events (8-K, 90d): <strong>{bundle.events_8k_90d ?? 0}</strong>
        </Row>
        <Row>
          <DollarSign size={13} /> Capital-raise filings (90d):{' '}
          <strong style={{ color: bundle.capital_raises_90d ? 'var(--accent-red,#ef4444)' : 'inherit' }}>
            {bundle.capital_raises_90d ?? 0}
          </strong>
          {bundle.capital_raises_90d ? <span style={muted}>· potential dilution</span> : null}
        </Row>
      </div>

      {(bundle.recent_8k || []).length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, ...muted, marginBottom: 4 }}>Recent 8-K events</div>
          {(bundle.recent_8k || []).slice(0, 4).map((f, i) => (
            <Row key={i}><FileText size={12} /><span style={muted}>{f.date}</span> {f.form}</Row>
          ))}
        </div>
      )}

      {hasNothing && (
        <p style={{ margin: '0 0 8px', fontSize: 12.5, ...muted }}>
          No insider, event, or capital-raise filings in the last 90 days{latest ? ` — last filing ${latest.form} on ${latest.date}` : ''}.
        </p>
      )}

      <div style={{ margin: '4px 0 0' }}><EdgarLink cik={bundle.cik} ticker={bundle.ticker} /></div>
      <p style={{ margin: '6px 0 0', fontSize: 10.5, fontStyle: 'italic', ...muted }}>
        Data: SEC EDGAR (free) · Form-4 counts are filing volume, not dollars · informational, not advice.
      </p>
    </div>
  )
}
