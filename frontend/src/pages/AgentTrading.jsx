/**
 * Agent Trading — supervisory cockpit for the Robinhood Agentic account experiment.
 *
 * Read-only by design: this page reports what the agentic-trading loop did (positions,
 * activity, which guardrails vetoed what) by reading the executor's decision log. It
 * never places, cancels, or sizes a trade. The live kill switch is a deep link to
 * Robinhood, not a control reimplemented here.
 *
 * Phase 1 (see docs/agent-trading-tab.md). Until the experiment has run, every section
 * degrades to a clean "no runs yet" state.
 */
import { useEffect, useState } from 'react'
import { Bot, ShieldCheck, ShieldAlert, Activity, Power, AlertTriangle, RefreshCw } from 'lucide-react'
import {
  getAgentTradingStatus,
  getAgentTradingSummary,
  getAgentTradingPositions,
  getAgentTradingActivity,
  getAgentTradingGuardrails,
} from '../api/client'
import { formatCurrency, formatDate } from '../lib/format'
import Pill from '../components/Pill'
import EmptyState from '../components/EmptyState'

const GREEN = 'var(--accent-green, #10b981)'
const RED = 'var(--accent-red, #ef4444)'
const BLUE = 'var(--accent-blue, #3b82f6)'
const usd = (n) => (n == null ? '—' : formatCurrency(n))
const pct = (n) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`)

const STATUS_TONE = {
  executed: 'success',
  blocked: 'danger',
  halted: 'danger',
  skipped: 'neutral',
  error: 'warning',
}

function StatCard({ label, value, tone }) {
  return (
    <div style={{
      flex: '1 1 150px', minWidth: 150, padding: '14px 16px',
      border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-elevated, var(--bg-secondary))',
    }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 650, color: tone || 'var(--text-primary)' }}>{value}</div>
    </div>
  )
}

export default function AgentTrading() {
  const [status, setStatus] = useState(null)
  const [summary, setSummary] = useState(null)
  const [positions, setPositions] = useState([])
  const [activity, setActivity] = useState([])
  const [guardrails, setGuardrails] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  const load = () => {
    setLoading(true); setErr(null)
    Promise.all([
      getAgentTradingStatus(),
      getAgentTradingSummary(),
      getAgentTradingPositions(),
      getAgentTradingActivity(100),
      getAgentTradingGuardrails(),
    ]).then(([st, sm, ps, ac, gr]) => {
      setStatus(st)
      setSummary(sm)
      setPositions(ps?.positions || [])
      setActivity(ac?.activity || [])
      setGuardrails(gr)
    }).catch((e) => setErr(e.message || 'Failed to load agent trading data'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const configured = status?.configured
  const mode = status?.mode  // 'simulated' | 'live' | null
  const halted = status?.halted
  const killUrl = status?.kill_switch_url || summary?.kill_switch_url

  const modePill = mode === 'live'
    ? <Pill tone="danger">LIVE</Pill>
    : mode === 'simulated'
      ? <Pill tone="info" soft>SIMULATED</Pill>
      : <Pill soft>no runs yet</Pill>

  return (
    <div style={{ maxWidth: 1080 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Bot size={22} style={{ color: BLUE }} />
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 680 }}>Agent Trading</h1>
        {modePill}
        <button onClick={load} title="Reload" style={{
          marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '6px 10px', fontSize: 13, border: '1px solid var(--border)',
          borderRadius: 8, background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer',
        }}>
          <RefreshCw size={14} /> Reload
        </button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary)', maxWidth: 760 }}>
        Read-only oversight of the Robinhood Agentic account experiment. This page reports what the
        autonomous loop did and which guardrails vetoed what — it never places trades. Informational, not advice.
      </p>

      {/* Kill switch + halt banner */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        {killUrl && (
          <a href={killUrl} target="_blank" rel="noopener noreferrer" style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 14px',
            border: `1px solid ${RED}`, color: RED, borderRadius: 10, fontWeight: 600,
            fontSize: 14, textDecoration: 'none', background: 'color-mix(in srgb, var(--accent-red, #ef4444) 8%, transparent)',
          }}>
            <Power size={16} /> Kill switch (Robinhood)
          </a>
        )}
        {halted && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: RED, fontWeight: 600, fontSize: 14 }}>
            <AlertTriangle size={16} /> Loop halted — drawdown limit hit; no orders placed
          </span>
        )}
      </div>

      {err && (
        <div style={{ padding: 12, border: `1px solid ${RED}`, borderRadius: 10, color: RED, marginBottom: 16, fontSize: 14 }}>
          {err}
        </div>
      )}

      {loading && !status && (
        <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Loading…</p>
      )}

      {!loading && !configured && (
        <EmptyState
          icon={<Bot size={24} />}
          title="No agent runs yet"
          description="Run the simulated experiment (python -m app.agent_trading.run_experiment) and its decision log will populate this tab."
        />
      )}

      {configured && summary && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 22 }}>
            <StatCard label="Open positions" value={summary.open_positions ?? 0} />
            <StatCard label="Market value" value={usd(summary.market_value)} />
            <StatCard label="Unrealized P&L" value={usd(summary.unrealized)}
              tone={(summary.unrealized || 0) >= 0 ? GREEN : RED} />
            <StatCard label="Net deployed" value={usd(summary.net_deployed)} />
            <StatCard label="Executed" value={summary.counts?.executed ?? 0} tone={GREEN} />
            <StatCard label="Blocked" value={summary.counts?.blocked ?? 0} tone={RED} />
          </div>
          {summary.last_run && (
            <p style={{ margin: '-10px 0 22px', fontSize: 12, color: 'var(--text-secondary)' }}>
              Last run {formatDate(summary.last_run)}
              {summary.last_rationale ? ` · latest: “${summary.last_rationale}”` : ''}
            </p>
          )}

          {/* Positions */}
          <Section icon={<Activity size={18} style={{ color: BLUE }} />} title="Positions">
            {positions.length === 0
              ? <Muted>No open positions.</Muted>
              : (
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      {['Ticker', 'Qty', 'Avg cost', 'Mark', 'Mkt value', 'Unrealized'].map((h, i) => (
                        <th key={h} style={{ ...thStyle, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => (
                      <tr key={p.ticker}>
                        <td style={{ ...tdStyle, fontWeight: 600 }}>{p.ticker}</td>
                        <td style={tdNum}>{p.qty}</td>
                        <td style={tdNum}>{usd(p.avg_cost)}</td>
                        <td style={tdNum}>{usd(p.mark)}</td>
                        <td style={tdNum}>{usd(p.market_value)}</td>
                        <td style={{ ...tdNum, color: (p.unrealized || 0) >= 0 ? GREEN : RED }}>
                          {usd(p.unrealized)} ({pct(p.unrealized_pct)})
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </Section>

          {/* Guardrail breaches */}
          <Section
            icon={guardrails?.blocked_total ? <ShieldAlert size={18} style={{ color: RED }} /> : <ShieldCheck size={18} style={{ color: GREEN }} />}
            title="Guardrail activity"
          >
            <Muted>
              {guardrails?.blocked_total
                ? `${guardrails.blocked_total} order${guardrails.blocked_total === 1 ? '' : 's'} vetoed before reaching the broker.`
                : 'No orders vetoed yet.'}
            </Muted>
            {(guardrails?.by_check?.length > 0) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {guardrails.by_check.map((b) => (
                  <Pill key={b.check} tone="danger" soft>{b.check} · {b.count}</Pill>
                ))}
              </div>
            )}
            {(guardrails?.warnings?.length > 0) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {guardrails.warnings.map((w) => (
                  <Pill key={w.kind} tone="warning" soft>{w.kind.replace('_', ' ')} warning · {w.count}</Pill>
                ))}
              </div>
            )}
          </Section>

          {/* Activity feed */}
          <Section icon={<Activity size={18} style={{ color: BLUE }} />} title="Activity">
            {activity.length === 0
              ? <Muted>No activity recorded.</Muted>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {activity.map((a, i) => (
                    <div key={i} style={{
                      padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 10,
                      display: 'flex', flexDirection: 'column', gap: 4,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <Pill tone={STATUS_TONE[a.status] || 'neutral'} soft>{a.status}</Pill>
                        <strong>{a.action} {a.ticker}</strong>
                        {a.fill && (
                          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                            {a.fill.qty} @ {usd(a.fill.price)} ({usd(a.fill.notional)})
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-secondary)' }}>
                          {a.as_of}
                        </span>
                      </div>
                      {a.rationale && (
                        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{a.rationale}</div>
                      )}
                      {a.reasons?.length > 0 && (
                        <div style={{ fontSize: 13, color: RED }}>✗ {a.reasons.join('; ')}</div>
                      )}
                      {a.warnings?.length > 0 && (
                        <div style={{ fontSize: 13, color: 'var(--accent-orange, #f59e0b)' }}>⚠ {a.warnings.join('; ')}</div>
                      )}
                      {a.error && (
                        <div style={{ fontSize: 13, color: RED }}>! {a.error}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
          </Section>
        </>
      )}
    </div>
  )
}

function Section({ icon, title, children }) {
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {icon}
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 620 }}>{title}</h2>
      </div>
      {children}
    </div>
  )
}

const Muted = ({ children }) => (
  <p style={{ margin: 0, fontSize: 14, color: 'var(--text-secondary)' }}>{children}</p>
)

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 14 }
const thStyle = { padding: '8px 10px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }
const tdStyle = { padding: '8px 10px', borderBottom: '1px solid var(--border)' }
const tdNum = { ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
