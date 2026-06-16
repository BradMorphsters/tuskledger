/**
 * AgentBacktest — strategy backtest scoreboard + per-name drill-down.
 *
 * Runs the price-driven Analyst profiles over the cached monthly history and shows which
 * beats equal-weight buy-and-hold, so you pick a strategy with its track record in view.
 * Click a profile to load its per-ticker simulated entries/exits. Read-only, directional —
 * monthly bars, no costs, quality/signal gates neutralized.
 */
import { useEffect, useState } from 'react'
import { FlaskConical, ChevronRight, ChevronDown } from 'lucide-react'
import { getAgentTradingBacktest } from '../api/client'

const GREEN = 'var(--accent-green, #10b981)'
const RED = 'var(--accent-red, #ef4444)'
const LABELS = { momentum: 'Momentum', mean_reversion: 'Mean reversion', rotation: 'Rotation' }
const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`)

export default function AgentBacktest() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [open, setOpen] = useState(null)   // expanded ticker in the detail

  const load = (profile) => {
    setLoading(true); setErr(null)
    getAgentTradingBacktest(profile)
      .then((d) => { setData(d); setOpen(null) })
      .catch((e) => setErr(e.message || 'Backtest failed'))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const cmp = data?.comparison || []
  const detail = data?.detail
  const byTicker = detail?.trades_by_ticker || {}
  const tickers = Object.keys(byTicker).sort()

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 22,
                  background: 'var(--bg-elevated, var(--bg-secondary))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <FlaskConical size={18} style={{ color: 'var(--accent-blue, #3b82f6)' }} />
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650 }}>Strategy backtest</h2>
        {data?.configured && (
          <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            {data.months} monthly steps · {data.domain} · benchmark (hold){' '}
            <strong style={{ color: data.benchmark_return >= 0 ? GREEN : RED }}>{pct(data.benchmark_return)}</strong>
          </span>
        )}
      </div>

      {loading && <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 2px' }}>Running…</p>}
      {err && <p style={{ fontSize: 13, color: RED, margin: '4px 2px' }}>{err}</p>}
      {!loading && !data?.configured && (
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 2px' }}>
          No price history cached yet for the active research domain — warm the price cache to backtest.
        </p>
      )}

      {data?.configured && (
        <>
          {/* scoreboard */}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['Profile', 'Return', 'CAGR', 'Max DD', 'Trades', ''].map((h, i) => (
                  <th key={h} style={{ ...th, textAlign: i === 0 ? 'left' : i === 5 ? 'center' : 'right' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cmp.map((r) => (
                <tr key={r.profile} onClick={() => load(r.profile)}
                    style={{ cursor: 'pointer', background: detail?.profile === r.profile ? 'var(--bg-secondary, transparent)' : 'transparent' }}>
                  <td style={{ ...td, fontWeight: 600 }}>{LABELS[r.profile] || r.profile}</td>
                  <td style={{ ...tdNum, color: r.total_return >= 0 ? GREEN : RED, fontWeight: 600 }}>{pct(r.total_return)}</td>
                  <td style={tdNum}>{pct(r.cagr)}</td>
                  <td style={{ ...tdNum, color: RED }}>{pct(r.max_drawdown)}</td>
                  <td style={tdNum}>{r.trades}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{r.beats ? <span style={{ color: GREEN }}>✓ beats hold</span> : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* equity curve: strategy vs equal-weight hold */}
          {detail?.equity_curve?.length > 1 && (
            <EquityChart strategy={detail.equity_curve} benchmark={detail.benchmark_curve} />
          )}

          {/* per-name detail */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
              Simulated trades — <strong>{LABELS[detail?.profile] || detail?.profile}</strong> (click a profile row above to switch; click a ticker to expand):
            </div>
            {tickers.length === 0 ? (
              <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: 0 }}>No trades for this profile.</p>
            ) : tickers.map((tk) => (
              <div key={tk} style={{ borderBottom: '1px solid var(--border)' }}>
                <div onClick={() => setOpen(open === tk ? null : tk)}
                     style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 2px', cursor: 'pointer', fontSize: 13 }}>
                  {open === tk ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <strong>{tk}</strong>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
                    {byTicker[tk].length} trade{byTicker[tk].length === 1 ? '' : 's'}
                  </span>
                </div>
                {open === tk && (
                  <div style={{ padding: '2px 0 8px 24px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {byTicker[tk].map((t, i) => (
                      <div key={i} style={{ fontSize: 12.5, display: 'flex', gap: 8 }}>
                        <span style={{ color: 'var(--text-secondary)', minWidth: 56 }}>{t.as_of}</span>
                        <span style={{ fontWeight: 600, color: t.action === 'buy' ? GREEN : RED, minWidth: 32 }}>{t.action}</span>
                        <span>{t.shares} sh @ ${t.price} (${t.notional})</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <p style={{ margin: '10px 2px 0', fontSize: 11, color: 'var(--text-secondary)' }}>
            Directional only — monthly bars, no costs/slippage, quality &amp; signal gates neutralized (historical scores aren't retained). A sanity check, not a P&amp;L promise.
          </p>
        </>
      )}
    </div>
  )
}

function EquityChart({ strategy, benchmark }) {
  const W = 480, H = 120, pad = 8
  const all = [...strategy, ...(benchmark || [])].filter((v) => v != null)
  if (all.length < 2) return null
  const lo = Math.min(...all), hi = Math.max(...all), rng = hi - lo || 1
  const path = (curve) => curve.map((v, i) => {
    const x = pad + (i / (curve.length - 1)) * (W - 2 * pad)
    const y = H - pad - ((v - lo) / rng) * (H - 2 * pad)
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <div style={{ marginTop: 12 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="120" preserveAspectRatio="none" role="img" aria-label="Backtest equity curve">
        {benchmark?.length > 1 && (
          <path d={path(benchmark)} fill="none" stroke="var(--text-secondary, #9ca3af)" strokeWidth="1.5" strokeDasharray="4 3" />
        )}
        <path d={path(strategy)} fill="none" stroke="var(--accent-blue, #3b82f6)" strokeWidth="2" />
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
        <span><span style={{ color: 'var(--accent-blue,#3b82f6)', fontWeight: 700 }}>—</span> strategy</span>
        <span><span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>– –</span> equal-weight hold</span>
      </div>
    </div>
  )
}

const th = { padding: '6px 8px', borderBottom: '1px solid var(--border)', fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 600 }
const td = { padding: '6px 8px', borderBottom: '1px solid var(--border)' }
const tdNum = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
