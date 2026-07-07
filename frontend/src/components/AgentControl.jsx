/**
 * AgentControl — pause / resume / re-arm the agentic loop.
 *
 * Reflects the persisted policy state (active | paused | halted) and lets a human stop or
 * resume the loop. This is distinct from Robinhood's kill switch (which disconnects the
 * agent entirely) — this governs whether *our* loop is allowed to trade. Re-arming a
 * drawdown halt is confirm-gated, since it clears a safety trip.
 */
import { useEffect, useState } from 'react'
import { ShieldCheck, PauseCircle, PlayCircle, RotateCcw, AlertOctagon } from 'lucide-react'
import {
  getAgentTradingControl, pauseAgentTrading, resumeAgentTrading, rearmAgentTrading,
  setAgentTradingStrategy,
} from '../api/client'
import { formatCurrency } from '../lib/format'
import Pill from './Pill'

const STRATEGY_LABELS = {
  signal_event: 'Signal / event',
  momentum: 'Momentum',
  mean_reversion: 'Mean reversion',
  rotation: 'Rotation',
}

const STRATEGY_DESC = {
  signal_event: 'Event-driven swing — buy on insider / congress / gov-contract signals; hold the catalyst, exit on signal decay.',
  momentum: 'Trend-following — buy price strength in an uptrend; exit when the trend breaks.',
  mean_reversion: 'Dip-buying — buy a quality name pulled back inside an uptrend; exit on the bounce.',
  rotation: 'Conviction basket — hold the top names ranked by research thesis (conviction × upside); rotate a holding out once it falls past the keep cutoff (low turnover).',
}

const STATUS = {
  active: { tone: 'success', icon: ShieldCheck, label: 'Active', color: 'var(--accent-green,#10b981)' },
  paused: { tone: 'warning', icon: PauseCircle, label: 'Paused', color: 'var(--accent-orange,#f59e0b)' },
  halted: { tone: 'danger', icon: AlertOctagon, label: 'Halted', color: 'var(--accent-red,#ef4444)' },
}

export default function AgentControl() {
  const [ctrl, setCtrl] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const load = () => getAgentTradingControl().then(setCtrl).catch((e) => setErr(e.message))
  useEffect(() => { load() }, [])

  const act = async (fn, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    setBusy(true); setErr(null)
    try { setCtrl(await fn()) } catch (e) { setErr(e.message || 'Action failed') }
    finally { setBusy(false) }
  }

  const status = ctrl?.status || 'active'
  const meta = STATUS[status] || STATUS.active
  const Icon = meta.icon

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px', marginBottom: 18,
      background: 'var(--bg-elevated, var(--bg-secondary))',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon size={20} style={{ color: meta.color }} />
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 650, fontSize: 15 }}>Loop</span>
            <Pill tone={meta.tone}>{meta.label}</Pill>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2 }}>
            {status === 'halted' && 'Drawdown breaker tripped — review, then re-arm to resume.'}
            {status === 'paused' && 'Manually paused — the loop will place nothing until resumed.'}
            {status === 'active' && 'The loop may run (subject to the read-only / armed mode).'}
          </div>
        </div>
      </div>

      {ctrl?.equity_peak > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          peak {formatCurrency(ctrl.equity_peak)}
        </div>
      )}

      {/* Analyst strategy selector — changes what the loop *considers*, not whether it trades.
          Each option carries a one-line description (hover tooltip), and the selected one's
          description shows beneath the dropdown. */}
      {ctrl?.strategies?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 260 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            Strategy
            <select value={ctrl.strategy || ''} disabled={busy}
                    title={STRATEGY_DESC[ctrl.strategy] || ''}
                    onChange={(e) => act(() => setAgentTradingStrategy(e.target.value))}
                    style={{ padding: '5px 8px', fontSize: 12.5, borderRadius: 7, border: '1px solid var(--border)',
                             background: 'var(--bg-primary, transparent)', color: 'var(--text-primary)', cursor: 'pointer' }}>
              {ctrl.strategies.map((p) => (
                <option key={p} value={p} title={STRATEGY_DESC[p] || ''}>{STRATEGY_LABELS[p] || p}</option>
              ))}
            </select>
          </label>
          {STRATEGY_DESC[ctrl.strategy] && (
            <span style={{ fontSize: 10.5, lineHeight: 1.3, color: 'var(--text-secondary)' }}>
              {STRATEGY_DESC[ctrl.strategy]}
            </span>
          )}
        </div>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        {status === 'active' && (
          <button onClick={() => act(pauseAgentTrading)} disabled={busy} style={btn('warning', busy)}>
            <PauseCircle size={14} /> Pause
          </button>
        )}
        {status === 'paused' && (
          <button onClick={() => act(resumeAgentTrading)} disabled={busy} style={btn('success', busy)}>
            <PlayCircle size={14} /> Resume
          </button>
        )}
        {status === 'halted' && (
          <button
            onClick={() => act(rearmAgentTrading,
              'Re-arm clears the drawdown halt and lets the loop run again. Only do this after reviewing why it tripped. Continue?')}
            disabled={busy} style={btn('danger', busy)}
          >
            <RotateCcw size={14} /> Re-arm
          </button>
        )}
      </div>

      {err && <div style={{ flexBasis: '100%', color: 'var(--accent-red,#ef4444)', fontSize: 12 }}>{err}</div>}
    </div>
  )
}

const COLORS = {
  success: 'var(--accent-green, #10b981)',
  warning: 'var(--accent-orange, #f59e0b)',
  danger: 'var(--accent-red, #ef4444)',
}
const btn = (tone, disabled) => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 13px', fontSize: 13,
  fontWeight: 600, border: `1px solid ${COLORS[tone]}`, borderRadius: 8, background: 'transparent',
  color: COLORS[tone], cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1,
})
