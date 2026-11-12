import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Loader2, AlertCircle, TrendingDown, CalendarCheck } from 'lucide-react'
import { getLoansSummary } from '../api/client'

/**
 * LoansSummary — every loan together, at the top of the Loans page.
 *
 *  - KPI tiles: total owed, monthly payments (with escrow called out),
 *    average rate, interest still to pay, debt-free date, and loan
 *    payments as a share of take-home pay.
 *  - "What ends next": each loan's payoff date on its current schedule,
 *    how much monthly payment it frees and what the total drops to.
 *  - Payoff planner: an extra $/month, compared across the current
 *    schedule, avalanche (highest rate first) and snowball (smallest
 *    balance first). Paid-off loans' payments roll into the next one.
 *    Any loan (typically a low-rate mortgage) can be left out of the plan.
 *  - Per-loan breakdown table.
 *
 * All math is done by the backend (/api/loans/summary).
 */

const EXTRA_KEY = 'tuskledger.loanPlan.extra.v1'
const EXCLUDE_KEY = 'tuskledger.loanPlan.exclude.v1'

function readLocal(key, fallback) {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : JSON.parse(v)
  } catch { return fallback }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode */ }
}

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
export const money = (n) => usd0.format(n || 0)

// "2 yr 3 mo", "11 mo", "now"
export function fmtDuration(months) {
  if (months == null) return '—'
  if (months <= 0) return 'now'
  const y = Math.floor(months / 12)
  const m = months % 12
  if (!y) return `${m} mo`
  return m ? `${y} yr ${m} mo` : `${y} yr`
}

// "May 2040" from an ISO date. Parsed by parts so time zones can't shift the month.
export function fmtMonthYear(iso) {
  if (!iso) return '—'
  const [y, mo] = iso.split('-').map(Number)
  return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

// Share of take-home pay going to loans → tone. Under 20% is comfortable;
// 36% is the classic lender ceiling for total debt payments.
export function burdenTone(share) {
  if (share == null) return null
  if (share < 0.2) return 'good'
  if (share < 0.36) return 'ok'
  return 'warn'
}

// Only pass overrides for loans that actually need them (no stored terms),
// with numeric values.
export function summaryOverrides(overrides, needsOverride) {
  const out = {}
  for (const [id, o] of Object.entries(overrides || {})) {
    if (!needsOverride(id) || !o) continue
    const rate = parseFloat(o.rate)
    const payment = parseFloat(o.payment)
    if (Number.isFinite(rate) && Number.isFinite(payment) && payment > 0) out[id] = { rate, payment }
  }
  return out
}

// Merge plan series into chart rows: {date, current, avalanche, snowball}.
export function planChartRows(series, maxPoints = 180) {
  if (!series) return []
  const len = Math.max(0, ...Object.values(series).map(s => s.length))
  const stride = Math.max(1, Math.ceil(len / maxPoints))
  const rows = []
  for (let i = 0; i < len; i += stride) {
    const row = {}
    for (const [k, s] of Object.entries(series)) {
      const p = s[i]
      row[k] = p ? p.balance : 0
      if (p && !row.date) row.date = p.date
    }
    rows.push(row)
  }
  return rows
}

// One tick per calendar year: the first row of each year.
export function yearTicks(rows) {
  const seen = new Set()
  return rows.filter(r => {
    const y = r.date?.slice(0, 4)
    if (!y || seen.has(y)) return false
    seen.add(y)
    return true
  }).map(r => r.date)
}

const card = {
  padding: 16,
  background: 'var(--bg-card)',
  border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
  borderRadius: 8,
}
const eyebrow = {
  fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
  textTransform: 'uppercase', color: 'var(--text-muted)',
}
const th = { textAlign: 'left', padding: '6px 8px', fontWeight: 600, color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }
const td = { padding: '6px 8px', fontSize: 12, whiteSpace: 'nowrap' }
const num = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

function Kpi({ label, value, sub, tone }) {
  const color = tone === 'warn' ? 'var(--accent-orange)'
    : tone === 'good' ? 'var(--accent-green)' : 'var(--text-primary)'
  return (
    <div style={{
      padding: '12px 14px', background: 'var(--bg-input)',
      border: '1px solid var(--border-color, rgba(255,255,255,0.06))', borderRadius: 6,
      minWidth: 0,
    }}>
      <div style={{ ...eyebrow, fontSize: 10 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

const PLAN_LABEL = { current: 'Current schedule', avalanche: 'Avalanche', snowball: 'Snowball' }
const PLAN_HINT = {
  current: 'Each loan pays its own payment. No extra.',
  avalanche: 'Extra goes to the highest rate first. Least interest.',
  snowball: 'Extra goes to the smallest balance first. Fastest early wins.',
}
const PLAN_COLOR = { current: 'var(--text-muted)', avalanche: 'var(--accent-blue)', snowball: 'var(--accent-purple)' }

export default function LoansSummary({ overrides = {}, needsOverride = () => false, onSelectLoan }) {
  const [extra, setExtra] = useState(() => Number(readLocal(EXTRA_KEY, 0)) || 0)
  const [exclude, setExclude] = useState(() => {
    const v = readLocal(EXCLUDE_KEY, [])
    return Array.isArray(v) ? v : []
  })
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const ov = summaryOverrides(overrides, needsOverride)
  const ovKey = JSON.stringify(ov)

  useEffect(() => {
    let alive = true
    setLoading(true)
    const t = setTimeout(() => {
      getLoansSummary({ extra, overrides: ov, exclude })
        .then(d => { if (alive) { setData(d); setError(null) } })
        .catch(e => { if (alive) setError(e?.message || 'Could not load the summary') })
        .finally(() => { if (alive) setLoading(false) })
    }, 250)
    return () => { alive = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extra, ovKey, exclude.join(',')])

  const updateExtra = (v) => {
    const n = Math.max(0, Math.min(100000, Number(v) || 0))
    setExtra(n); writeLocal(EXTRA_KEY, n)
  }
  const toggleExclude = (id) => {
    const next = exclude.includes(id) ? exclude.filter(x => x !== id) : [...exclude, id]
    setExclude(next); writeLocal(EXCLUDE_KEY, next)
  }

  if (!data && loading) {
    return (
      <div style={{ ...card, marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
        <Loader2 size={16} className="spin" /> Building your loan summary…
      </div>
    )
  }
  if (!data) {
    return (
      <div style={{ ...card, marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent-orange)', fontSize: 13 }}>
        <AlertCircle size={16} /> {error}
      </div>
    )
  }

  const t = data.totals
  if (!t.loan_count) {
    return data.excluded?.length ? (
      <div style={{ ...card, marginTop: 16, fontSize: 13, color: 'var(--text-muted)' }}>
        Add an interest rate and monthly payment to a loan below to see the summary.
      </div>
    ) : null
  }

  const tone = burdenTone(t.payments_share_of_income)
  const best = ['avalanche', 'snowball'].reduce((a, b) =>
    (data.plans[b].total_interest < data.plans[a].total_interest ? b : a), 'avalanche')
  const chartRows = planChartRows(data.series)
  const planHasLoans = data.plans.avalanche.payoff_order.length > 0

  return (
    <section aria-label="Loans summary" style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <Kpi label="Total owed" value={money(t.balance)}
          sub={`${t.loan_count} loan${t.loan_count === 1 ? '' : 's'}`} />
        <Kpi label="Monthly payments" value={money(t.monthly_payment)}
          sub={t.monthly_escrow > 0
            ? `${money(t.monthly_principal_interest)} P&I + ${money(t.monthly_escrow)} escrow`
            : 'Principal & interest'} />
        <Kpi label="Average rate" value={`${(t.weighted_rate * 100).toFixed(2)}%`} sub="Weighted by balance" />
        <Kpi label="Interest left" value={money(t.interest_remaining)} sub="On current schedules" />
        <Kpi label="Debt-free" value={fmtMonthYear(t.debt_free_date)} sub={`in ${fmtDuration(t.months_to_debt_free)}`} />
        {t.payments_share_of_income != null && (
          <Kpi label="Of take-home pay" value={`${Math.round(t.payments_share_of_income * 100)}%`}
            tone={tone === 'warn' ? 'warn' : tone === 'good' ? 'good' : null}
            sub={`${money(t.monthly_payment)} of ${money(t.monthly_income)}/mo (90-day avg)`} />
        )}
      </div>

      {data.excluded?.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 6, alignItems: 'center' }}>
          <AlertCircle size={14} />
          Not counted: {data.excluded.map(e => e.name).join(', ')}. Add a rate and payment to include {data.excluded.length === 1 ? 'it' : 'them'}.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {/* What ends next */}
        <div style={card}>
          <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: 6 }}>
            <CalendarCheck size={14} /> What ends next
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 10px' }}>
            On current schedules, and what your monthly loan payments drop to.
          </div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.payment_steps.map((s, i) => (
              <li key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{
                  flex: '0 0 22px', height: 22, borderRadius: 11, fontSize: 11, fontWeight: 700,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: i === 0 ? 'var(--accent-green-bg, rgba(16,185,129,0.15))' : 'var(--bg-input)',
                  color: i === 0 ? 'var(--accent-green)' : 'var(--text-muted)',
                }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Paid off {fmtMonthYear(s.date)} ({fmtDuration(s.months)}) · frees {money(s.frees_per_month - s.escrow_continues)}/mo
                    {s.escrow_continues > 0 && ` (escrow of ${money(s.escrow_continues)} continues as taxes and insurance)`}
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                  <div style={{ fontWeight: 600 }}>{money(s.total_after)}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>/mo after</div>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* Payoff planner */}
        <div style={card}>
          <div style={{ ...eyebrow, display: 'flex', alignItems: 'center', gap: 6 }}>
            <TrendingDown size={14} /> Payoff planner
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 10px' }}>
            Put extra toward debt each month. When a loan is paid off, its payment rolls into the next one.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 6 }}>
            Extra per month
            <span style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 8, top: 5, color: 'var(--text-muted)' }}>$</span>
              <input type="number" min="0" step="50" value={extra}
                aria-label="Extra per month"
                onChange={e => updateExtra(e.target.value)}
                style={{
                  width: 100, padding: '4px 8px 4px 18px', fontSize: 13,
                  background: 'var(--bg-input)', color: 'var(--text-primary)',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.12))', borderRadius: 4,
                }} />
            </span>
            {loading && <Loader2 size={14} className="spin" style={{ color: 'var(--text-muted)' }} />}
          </label>
          <input type="range" min="0" max="2000" step="25" value={Math.min(extra, 2000)}
            aria-label="Extra per month slider"
            onChange={e => updateExtra(e.target.value)} style={{ width: '100%' }} />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 10px', fontSize: 11, color: 'var(--text-muted)' }}>
            Include:
            {data.loans.map(l => (
              <label key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={!exclude.includes(l.id)} onChange={() => toggleExclude(l.id)} />
                <span style={{ color: 'var(--text-secondary)' }}>{l.name}</span>
              </label>
            ))}
          </div>

          {planHasLoans ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Plan</th>
                  <th style={{ ...th, textAlign: 'right' }}>Debt-free</th>
                  <th style={{ ...th, textAlign: 'right' }}>Interest</th>
                  <th style={{ ...th, textAlign: 'right' }}>Saves</th>
                </tr>
              </thead>
              <tbody>
                {['current', 'avalanche', 'snowball'].map(k => {
                  const p = data.plans[k]
                  const isBest = k === best && p.interest_saved > 0
                  return (
                    <tr key={k} title={PLAN_HINT[k]} style={{ borderTop: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
                      <td style={td}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: PLAN_COLOR[k], marginRight: 6 }} />
                        {PLAN_LABEL[k]}
                        {isBest && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent-green)', fontWeight: 700 }}>BEST</span>}
                      </td>
                      <td style={num}>{fmtMonthYear(p.debt_free_date)}</td>
                      <td style={num}>{money(p.total_interest)}</td>
                      <td style={{ ...num, color: p.interest_saved > 0 ? 'var(--accent-green)' : 'var(--text-muted)' }}>
                        {k === 'current' ? '—' : `${money(p.interest_saved)}${p.months_saved > 0 ? ` · ${fmtDuration(p.months_saved)} sooner` : ''}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Select at least one loan to plan.</div>
          )}
          {planHasLoans && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              {PLAN_LABEL[best]} order: {data.plans[best].payoff_order.map(o => `${o.name} (${fmtMonthYear(o.date)})`).join(' → ')}
            </div>
          )}
        </div>
      </div>

      {/* Balance over time by plan */}
      {planHasLoans && chartRows.length > 1 && (
        <div style={card}>
          <div style={eyebrow}>Total balance by plan</div>
          <div style={{ height: 220, marginTop: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartRows} margin={{ top: 5, right: 16, bottom: 5, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color, rgba(255,255,255,0.08))" />
                <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={11}
                  ticks={yearTicks(chartRows)}
                  tickFormatter={d => (d ? d.slice(0, 4) : '')} minTickGap={24} />
                <YAxis stroke="var(--text-muted)" fontSize={11} tickFormatter={v => `$${Math.round(v / 1000)}k`} />
                <Tooltip formatter={(v, n) => [money(v), PLAN_LABEL[n] || n]} labelFormatter={fmtMonthYear}
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border-color, rgba(255,255,255,0.15))', borderRadius: 6, fontSize: 12 }} />
                <Legend formatter={n => PLAN_LABEL[n] || n} wrapperStyle={{ fontSize: 11 }} />
                {['current', 'avalanche', 'snowball'].map(k => (
                  <Line key={k} type="monotone" dataKey={k} stroke={PLAN_COLOR[k]} dot={false}
                    strokeWidth={k === best ? 2.5 : 1.5} strokeDasharray={k === 'current' ? '4 3' : undefined} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {exclude.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loans left out of the plan aren't in this chart.</div>
          )}
        </div>
      )}

      {/* Per-loan breakdown */}
      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={{ ...eyebrow, marginBottom: 8 }}>By loan</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>Loan</th>
              <th style={{ ...th, textAlign: 'right' }}>Balance</th>
              <th style={{ ...th, textAlign: 'right' }}>Share</th>
              <th style={{ ...th, textAlign: 'right' }}>Rate</th>
              <th style={{ ...th, textAlign: 'right' }}>Payment</th>
              <th style={{ ...th, textAlign: 'right' }}>Interest left</th>
              <th style={{ ...th, textAlign: 'right' }}>Paid off</th>
            </tr>
          </thead>
          <tbody>
            {data.loans.map(l => (
              <tr key={l.id} style={{ borderTop: '1px solid var(--border-color, rgba(255,255,255,0.06))' }}>
                <td style={td}>
                  {onSelectLoan
                    ? <button type="button" onClick={() => onSelectLoan(l.id)} style={{
                        background: 'none', border: 0, padding: 0, color: 'var(--accent-blue)', cursor: 'pointer', fontSize: 12,
                      }}>{l.name}</button>
                    : l.name}
                  {l.pieces > 1 && <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> · {l.pieces} loans</span>}
                </td>
                <td style={num}>{money(l.balance)}</td>
                <td style={num}>
                  <span style={{
                    display: 'inline-block', width: 40, height: 6, borderRadius: 3, marginRight: 6, verticalAlign: 'middle',
                    background: `linear-gradient(to right, var(--accent-blue) ${Math.round(l.share_of_debt * 100)}%, var(--bg-input) 0)`,
                  }} />
                  {Math.round(l.share_of_debt * 100)}%
                </td>
                <td style={num}>{(l.rate * 100).toFixed(2)}%</td>
                <td style={num}>
                  {money(l.monthly_payment)}
                  {l.escrow > 0 && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>incl. {money(l.escrow)} escrow</div>}
                </td>
                <td style={num}>{money(l.interest_remaining)}</td>
                <td style={num}>{fmtMonthYear(l.payoff_date)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border-color, rgba(255,255,255,0.12))', fontWeight: 700 }}>
              <td style={td}>Total</td>
              <td style={num}>{money(t.balance)}</td>
              <td style={num}>100%</td>
              <td style={num}>{(t.weighted_rate * 100).toFixed(2)}%</td>
              <td style={num}>{money(t.monthly_payment)}</td>
              <td style={num}>{money(t.interest_remaining)}</td>
              <td style={num}>{fmtMonthYear(t.debt_free_date)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}
