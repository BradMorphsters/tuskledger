import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Wallet, CalendarDays, Sparkles, AlertTriangle, TrendingUp, TrendingDown, Pencil, RotateCcw, EyeOff, Eye } from 'lucide-react'
import { getIncomeSchedule, updateEarner, resetEarner } from '../api/client'
import { SkeletonPage } from '../components/Skeleton'
import LoadError from '../components/LoadError'
import EmptyState from '../components/EmptyState'
import Pill from '../components/Pill'
import Stat from '../components/Stat'
import { useReadOnlyMode } from '../components/ReadOnlyMode'
import { formatCurrencyZero as fmt, formatDate } from '../lib/format'
import { useLatestRequest } from '../hooks/useLatestRequest'

/**
 * Paychecks — how the household actually gets paid.
 *
 * Bi-weekly pay (26 checks a year) and semi-monthly pay (24, on fixed days)
 * look alike in a bank feed but behave differently in a budget: bi-weekly
 * drops a third check into two months a year, semi-monthly never does.
 * Everything here comes from GET /api/income/schedule
 * (app/services/pay_schedule.py). The page only lays it out, plus a small
 * editor for correcting what the detector inferred.
 */

const EARNER_COLORS = ['var(--accent-blue)', 'var(--accent-purple)', 'var(--accent-green)', 'var(--accent-orange)']
const FREQUENCIES = [
  { value: 'bi-weekly', label: 'Every other week (26/yr)' },
  { value: 'semi-monthly', label: 'Twice a month (24/yr)' },
  { value: 'weekly', label: 'Weekly (52/yr)' },
  { value: 'monthly', label: 'Monthly (12/yr)' },
]
const DAY_OPTIONS = [...Array.from({ length: 28 }, (_, i) => i + 1), 31]
const SHIFT_OPTIONS = [
  { value: 'before', label: 'Paid the business day before' },
  { value: 'after', label: 'Paid the business day after' },
  { value: 'none', label: 'Paid that same day' },
]
const dayLabel = d => (d === 31 ? 'Last day' : String(d))

function statusPill(e) {
  if (e.status === 'late') {
    return <Pill tone="warning" title="A scheduled payday passed with no deposit">Late · expected {formatDate(e.expected_missed)}</Pill>
  }
  if (e.status === 'ended') return <Pill tone="neutral" title="No deposit for two pay cycles">Ended</Pill>
  return <Pill tone="success">On track</Pill>
}

function scheduleSourceLabel(e) {
  if (e.schedule_source === 'custom') return 'set by you'
  if (e.schedule_source === 'detected') {
    const fit = e.schedule.fit != null ? ` · matches ${Math.round(e.schedule.fit * 100)}% of paydays` : ''
    return `auto-detected${fit}`
  }
  return 'estimated from deposit spacing'
}

function EarnerEditor({ earner, onSave, onCancel, onReset, saving }) {
  const [nickname, setNickname] = useState(earner.nickname || '')
  const [frequency, setFrequency] = useState(earner.schedule.frequency)
  const [days, setDays] = useState(() => {
    const d = earner.schedule.days_of_month || []
    if (earner.schedule.frequency === 'semi-monthly' && d.length === 2) return d
    if (earner.schedule.frequency === 'monthly' && d.length === 1) return [d[0], 15]
    return [15, 31]
  })
  const [anchor, setAnchor] = useState(earner.last_paid)
  const [shift, setShift] = useState(earner.schedule.shift || 'before')
  const [perCheck, setPerCheck] = useState(earner.per_check_source === 'custom' ? String(earner.per_check) : '')
  const [err, setErr] = useState(null)

  const submit = (ev) => {
    ev.preventDefault()
    const payload = { nickname: nickname.trim() || null }
    const scheduleChanged = frequency !== earner.schedule.frequency ||
      (frequency === 'semi-monthly' && String(days) !== String(earner.schedule.days_of_month)) ||
      (frequency === 'monthly' && days[0] !== earner.schedule.days_of_month?.[0]) ||
      earner.schedule_source === 'custom'
    if (scheduleChanged) {
      payload.frequency = frequency
      if (frequency === 'semi-monthly') {
        if (days[0] === days[1]) { setErr('Pick two different days.'); return }
        payload.days_of_month = [...days].sort((a, b) => a - b)
      } else if (frequency === 'monthly') {
        payload.days_of_month = [days[0]]
      } else {
        payload.anchor = anchor || null
      }
    }
    if (shift !== (earner.schedule.shift || 'before')) payload.shift = shift
    if (perCheck.trim()) {
      const n = Number(perCheck)
      if (!Number.isFinite(n) || n <= 0) { setErr('Per-check amount must be a positive number.'); return }
      payload.per_check = n
    } else {
      payload.per_check = null
    }
    setErr(null)
    onSave(payload).catch(e => setErr(e.message || 'Could not save'))
  }

  const fieldStyle = {
    padding: '6px 8px', fontSize: 13, borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--bg-input)', color: 'var(--text-primary)',
  }
  const labelStyle = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }

  return (
    <form onSubmit={submit} style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <label style={labelStyle}>
          Name to show
          <input style={fieldStyle} value={nickname} maxLength={40} placeholder={earner.payer}
                 onChange={e => setNickname(e.target.value)} aria-label="Nickname" />
        </label>
        <label style={labelStyle}>
          Pay schedule
          <select style={fieldStyle} value={frequency} onChange={e => setFrequency(e.target.value)} aria-label="Pay schedule">
            {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        {frequency === 'semi-monthly' && (
          <label style={labelStyle}>
            Paydays
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {[0, 1].map(i => (
                <select key={i} style={fieldStyle} value={days[i]} aria-label={`Payday ${i + 1}`}
                        onChange={e => setDays(prev => { const n = [...prev]; n[i] = Number(e.target.value); return n })}>
                  {DAY_OPTIONS.map(d => <option key={d} value={d}>{dayLabel(d)}</option>)}
                </select>
              ))}
            </span>
          </label>
        )}
        {frequency === 'monthly' && (
          <label style={labelStyle}>
            Payday
            <select style={fieldStyle} value={days[0]} aria-label="Payday"
                    onChange={e => setDays(prev => [Number(e.target.value), prev[1]])}>
              {DAY_OPTIONS.map(d => <option key={d} value={d}>{dayLabel(d)}</option>)}
            </select>
          </label>
        )}
        {(frequency === 'bi-weekly' || frequency === 'weekly') && (
          <label style={labelStyle}>
            A recent payday
            <input type="date" style={fieldStyle} value={anchor || ''} onChange={e => setAnchor(e.target.value)} aria-label="A recent payday" />
          </label>
        )}
        <label style={labelStyle}>
          Payday on a weekend or holiday
          <select style={fieldStyle} value={shift} onChange={e => setShift(e.target.value)} aria-label="Weekend or holiday rule">
            {SHIFT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label style={labelStyle}>
          Take-home per check
          <input style={fieldStyle} inputMode="decimal" value={perCheck} placeholder={`Auto: ${fmt(earner.per_check)}`}
                 onChange={e => setPerCheck(e.target.value)} aria-label="Take-home per check" />
        </label>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
        Schedules, paydays and the weekend/holiday rule are learned from your deposits; change anything that's off. Leave the amount blank to use the median of the last three checks.
      </p>
      {err && <div style={{ color: 'var(--accent-red)', fontSize: 13 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>Save</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onReset} disabled={saving} title="Forget your changes and use auto-detection">
          <RotateCcw size={13} /> Reset to detected
        </button>
      </div>
    </form>
  )
}

function EarnerCard({ earner, color, readOnly, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const run = (fn) => {
    setSaving(true)
    return fn()
      .then(profile => { onChanged(profile); setEditing(false) })
      .finally(() => setSaving(false))
  }
  const save = payload => run(() => updateEarner(earner.key, payload))
  const reset = () => run(() => resetEarner(earner.key)).catch(() => {})
  const toggleHidden = () => run(() => updateEarner(earner.key, { hidden: !earner.hidden })).catch(() => {})

  const dim = earner.hidden || earner.status === 'ended'
  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: `3px solid ${color}`, opacity: dim ? 0.65 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>{earner.display_name}</span>
            {statusPill(earner)}
            {earner.hidden && <Pill tone="neutral">Hidden from totals</Pill>}
          </div>
          {earner.nickname && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{earner.payer}</div>}
          <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Pill tone="info" soft>{earner.schedule.label}</Pill>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{scheduleSourceLabel(earner)}</span>
          </div>
        </div>
        {!readOnly && !editing && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)} aria-label={`Edit ${earner.display_name}`}>
              <Pencil size={13} /> Edit
            </button>
            <button className="btn btn-ghost btn-sm" onClick={toggleHidden} disabled={saving}
                    title={earner.hidden ? 'Count this income again' : 'Not a paycheck? Leave it out of income totals'}>
              {earner.hidden ? <Eye size={13} /> : <EyeOff size={13} />} {earner.hidden ? 'Unhide' : 'Hide'}
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginTop: 14 }}>
        <Metric label="Per check" value={fmt(earner.per_check)}
                sub={earner.per_check_source === 'custom' ? 'set by you' : 'median of last 3'} />
        <Metric label="Every month (baseline)" value={fmt(earner.baseline_monthly)}
                sub={`${earner.schedule.min_per_month} check${earner.schedule.min_per_month === 1 ? '' : 's'} minimum`} />
        <Metric label="Monthly average" value={fmt(earner.normalized_monthly)}
                sub={`${earner.schedule.per_year} checks ÷ 12`} />
        <Metric label="Per year" value={fmt(earner.annual)} sub="take-home" />
      </div>

      {earner.change && (
        <div style={{ marginTop: 12, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
                      color: earner.change.direction === 'up' ? 'var(--accent-green)' : 'var(--accent-orange)' }}>
          {earner.change.direction === 'up' ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
          Take-home {earner.change.direction === 'up' ? 'went up' : 'went down'} {Math.abs(earner.change.pct)}%
          {earner.change.since && <> starting {formatDate(earner.change.since)}</>}
          {' '}(was {fmt(earner.change.previous_per_check)} a check).
        </div>
      )}

      {earner.split_deposit?.length > 1 && (
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
          Split deposit, counted as one paycheck:{' '}
          {earner.split_deposit.map((s, i) => (
            <span key={s.account_id}>{i > 0 && ' + '}{fmt(s.amount)} to {s.account}</span>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
        Last paid {formatDate(earner.last_paid)} ({fmt(earner.last_amount)})
        {earner.next_paydays?.length > 0 && <> · Next: {earner.next_paydays.slice(0, 3).map(formatDate).join(', ')}</>}
      </div>

      {editing && (
        <EarnerEditor earner={earner} saving={saving} onSave={save} onReset={reset} onCancel={() => setEditing(false)} />
      )}
    </div>
  )
}

function Metric({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
}

function MonthTile({ month, colorFor }) {
  const extra = month.is_extra_month
  return (
    <div
      data-testid={`month-${month.month}`}
      style={{
        border: `1px solid ${extra ? 'var(--accent-yellow)' : 'var(--border)'}`,
        background: extra ? 'var(--accent-yellow-bg)' : month.period === 'current' ? 'var(--bg-elevated)' : 'var(--bg-card)',
        borderRadius: 8, padding: '10px 12px', minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{month.label}</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {month.paycheck_count} check{month.paycheck_count === 1 ? '' : 's'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4, margin: '8px 0', flexWrap: 'wrap' }} aria-hidden="true">
        {month.paychecks.map(p => (
          <span key={`${p.key}-${p.date}`} title={`${p.name} · ${formatDate(p.date)} · ${fmt(p.amount)}${p.received ? '' : ' (expected)'}`}
                style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: p.received ? colorFor(p.key) : 'transparent',
                  border: `2px solid ${colorFor(p.key)}`,
                  outline: p.is_extra ? '2px solid var(--accent-yellow)' : 'none', outlineOffset: 1,
                }} />
        ))}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {fmt(month.period === 'past' ? month.received_total : month.expected_total)}
      </div>
      {extra && (
        <div style={{ fontSize: 11, color: 'var(--accent-yellow)', marginTop: 2, fontWeight: 600 }}>
          +{month.extra_checks} extra check{month.extra_checks === 1 ? '' : 's'} ({fmt(month.extra_amount)})
        </div>
      )}
      {month.period === 'current' && month.remaining_total > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{fmt(month.remaining_total)} still to come</div>
      )}
    </div>
  )
}

export default function Paychecks() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [showPast, setShowPast] = useState(false)
  const { readOnly } = useReadOnlyMode()
  const runLatest = useLatestRequest()

  const load = useCallback(() => {
    setLoading(true)
    setError(false)
    return runLatest(token => getIncomeSchedule()
      .then(d => { if (token.live) { setData(d); setLoading(false) } })
      .catch(() => { if (token.live) { setError(true); setLoading(false) } }))
  }, [runLatest])

  useEffect(() => load(), [load])

  const colorFor = useMemo(() => {
    const keys = (data?.earners || []).map(e => e.key)
    return key => EARNER_COLORS[Math.max(keys.indexOf(key), 0) % EARNER_COLORS.length]
  }, [data])

  if (loading) return <SkeletonPage stats={4} cards={3} rows={3} />

  const hh = data?.household
  const earners = data?.earners || []
  const months = (data?.months || []).filter(m => showPast || m.period !== 'past')

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Paychecks</h1>
      </div>
      {error && <LoadError what="your pay schedules" onRetry={load} />}
      {!error && data && earners.length === 0 && (
        <EmptyState
          icon={<Wallet size={28} />}
          title="No regular paycheck detected yet"
          description="Once two or three paydays from the same employer have synced, their schedule shows up here. Weekly, every-other-week, twice-a-month and monthly pay are all recognized."
        />
      )}
      {!error && data && earners.length > 0 && <>
        <div className="stats-grid">
          <Stat label="Every month brings at least" value={fmt(hh.baseline_monthly)} tone="positive"
                sub="Budget on this. It's guaranteed in every month" />
          <Stat label="Monthly average" value={fmt(hh.normalized_monthly)}
                sub="All checks in a year ÷ 12" />
          <Stat label="Extra checks per year" value={fmt(hh.extra_per_year)}
                sub={data.extra_paycheck_months.length
                  ? `Next: ${data.extra_paycheck_months[0].label}`
                  : 'No extra-paycheck months ahead'} />
          <Stat label="Next payday"
                value={hh.next_payday ? formatDate(hh.next_payday.date) : '—'}
                sub={hh.next_payday ? `${hh.next_payday.name} · ${fmt(hh.next_payday.amount)}` : null} />
        </div>

        {data.guidance?.length > 0 && (
          <div className="card" style={{ marginBottom: 16, background: 'var(--accent-blue-bg)', borderColor: 'transparent' }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <Sparkles size={16} style={{ color: 'var(--accent-blue)', flexShrink: 0, marginTop: 2 }} />
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13, lineHeight: 1.6 }}>
                {data.guidance.map(t => <li key={t}>{t}</li>)}
              </ul>
            </div>
          </div>
        )}

        {earners.some(e => e.status === 'late' && !e.hidden) && (
          <div className="card" style={{ marginBottom: 16, background: 'var(--accent-orange-bg)', borderColor: 'transparent', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <AlertTriangle size={16} style={{ color: 'var(--accent-orange)' }} />
            A payday passed without a deposit. If the bank feed is behind, a sync will clear this; if pay really changed, edit the schedule below.
          </div>
        )}

        {earners.map(e => (
          <EarnerCard key={e.key} earner={e} color={colorFor(e.key)} readOnly={readOnly} onChanged={setData} />
        ))}

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <CalendarDays size={14} style={{ color: 'var(--accent-blue)' }} /> Paycheck calendar
            </span>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} />
              Show the past 12 months
            </label>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
            {earners.filter(e => !e.hidden && e.status !== 'ended').map(e => (
              <span key={e.key} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: colorFor(e.key) }} /> {e.display_name}
              </span>
            ))}
            <span>Filled dot = received · ring = expected · highlighted month = extra paycheck</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            {months.map(m => <MonthTile key={m.month} month={m} colorFor={colorFor} />)}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header"><span className="card-title">Upcoming paydays</span></div>
          <div className="table-wrapper">
            <table className="table" style={{ width: '100%' }}>
              <thead><tr><th style={{ textAlign: 'left' }}>Date</th><th style={{ textAlign: 'left' }}>Who</th><th style={{ textAlign: 'right' }}>Expected</th></tr></thead>
              <tbody>
                {data.upcoming.map(u => (
                  <tr key={`${u.key}-${u.date}`}>
                    <td>{formatDate(u.date)}</td>
                    <td><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: colorFor(u.key), marginRight: 6 }} />{u.name}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(u.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '8px 0 0' }}>
            These dates also drive <Link to="/">Safe to spend</Link>, the <Link to="/cash-flow">cash-flow forecast</Link> and the <Link to="/bills-calendar">bills calendar</Link>.
          </p>
        </div>

        {data.other_income?.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header"><span className="card-title">Other recurring income</span></div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0 }}>Regular deposits too small or irregular to be a paycheck (interest, cashback, and similar). Not counted above.</p>
            {data.other_income.map(o => (
              <div key={o.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
                <span>{o.payer} <span style={{ color: 'var(--text-muted)' }}>· {o.frequency}</span></span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(o.monthly)}/mo</span>
              </div>
            ))}
          </div>
        )}
      </>}
    </div>
  )
}
