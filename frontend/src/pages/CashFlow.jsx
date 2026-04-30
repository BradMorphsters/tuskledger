import { useState, useEffect } from 'react'
import {
  Area, AreaChart, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  TrendingUp, Repeat, AlertTriangle, ShieldCheck, Banknote,
} from 'lucide-react'
import { getRecurring, getCashFlowForecast, getCashFlowHealth } from '../api/client'
import { formatCurrencyZero as formatCurrency } from '../lib/format'

const INPUT_STYLE = {
  width: '100%',
  background: 'var(--bg-input, var(--bg-primary))',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 13,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
}

function HealthCard({ label, icon, value, sub, status, tone }) {
  const statusLabel = ({
    healthy: 'Healthy', moderate: 'Moderate', thin: 'Thin', high: 'High', unknown: '',
  }[status] || '')
  return (
    <div className="stat-card" style={{ position: 'relative' }}>
      <div className="stat-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon}
        {label}
        {statusLabel && (
          <span style={{
            marginLeft: 'auto',
            fontSize: 10, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase',
            padding: '2px 6px', borderRadius: 4,
            background: `color-mix(in oklab, ${tone} 18%, transparent)`,
            color: tone,
            border: `1px solid color-mix(in oklab, ${tone} 35%, transparent)`,
          }}>
            {statusLabel}
          </span>
        )}
      </div>
      <div className="stat-value" style={{ color: tone }}>{value}</div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          {sub}
        </div>
      )}
    </div>
  )
}

function ForecastView() {
  const [data, setData] = useState(null)
  const [health, setHealth] = useState(null)
  const [days, setDays] = useState(30)
  const [baseline, setBaseline] = useState('median_3')
  useEffect(() => { getCashFlowForecast(days, baseline).then(setData).catch(() => {}) }, [days, baseline])
  useEffect(() => { getCashFlowHealth().then(setHealth).catch(() => {}) }, [])

  if (!data) return <p style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>Loading…</p>

  const totalOut = data.series.reduce((s, x) => s + x.projected_outflow, 0)
  const totalIn = data.series.reduce((s, x) => s + x.projected_inflow, 0)
  const net = totalIn - totalOut

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {[30, 60, 90, 180].map(n => (
          <button key={n} onClick={() => setDays(n)}
            className={days === n ? 'btn btn-primary' : 'btn btn-secondary'}
            style={{ padding: '6px 14px', fontSize: 12 }}>
            {n} days
          </button>
        ))}

        <span style={{ marginLeft: 16, fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Baseline:
        </span>
        <select
          value={baseline}
          onChange={e => setBaseline(e.target.value)}
          title="How variable spend per day is estimated. Median is robust to one-off events; rolling-90-day mean is sensitive to recent bonuses/refunds."
          style={{
            background: 'var(--bg-card)', color: 'var(--text-primary)',
            border: '1px solid var(--border)', borderRadius: 6,
            padding: '6px 10px', fontSize: 12, cursor: 'pointer',
          }}
        >
          <option value="median_3">Median of last 3 months</option>
          <option value="median_6">Median of last 6 months</option>
          <option value="last_month">Last complete month</option>
          <option value="rolling_90">Rolling 90-day mean</option>
        </select>
      </div>

      {data.baseline_meta && (
        <div style={{
          marginBottom: 16,
          padding: '12px 14px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontSize: 12, color: 'var(--text-muted)',
        }}>
          {/* Spend baseline */}
          <div style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Variable spend
            </span>
            <strong style={{ color: 'var(--text-primary)' }}>
              {formatCurrency(data.baseline_meta.monthly_variable_spend)}/mo
            </strong>
            <span>({formatCurrency(data.variable_spend_per_day)}/day)</span>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            <span><strong style={{ color: 'var(--text-primary)' }}>{data.baseline_meta.label}</strong></span>
            {data.baseline_meta.sampled_months?.length > 0 && (
              <span>
                from <code style={{ background: 'var(--bg-hover)', padding: '1px 6px', borderRadius: 3 }}>
                  {data.baseline_meta.sampled_months.join(', ')}
                </code>
              </span>
            )}
          </div>

          {/* Salary sources */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Salary income
            </span>
            <strong style={{ color: 'var(--accent-green)' }}>
              {formatCurrency(data.baseline_meta.monthly_salary_income)}/mo
            </strong>
            <span>({formatCurrency(data.variable_income_per_day)}/day)</span>
            <span style={{ color: 'var(--text-muted)' }}>·</span>
            {data.baseline_meta.salary_sources?.length > 0 ? (
              <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
                {data.baseline_meta.salary_sources.map(s => (
                  <span
                    key={s.source}
                    title={`Median across ${s.months_observed} months`}
                    style={{
                      background: 'rgba(52,211,153,0.10)',
                      border: '1px solid rgba(52,211,153,0.25)',
                      color: 'var(--accent-green)',
                      padding: '2px 8px', borderRadius: 4,
                      fontSize: 11, fontWeight: 600,
                    }}
                  >
                    {s.source} {formatCurrency(s.median_monthly)}
                  </span>
                ))}
              </span>
            ) : (
              <span style={{ fontStyle: 'italic' }}>
                No regular income sources detected.
              </span>
            )}
          </div>

          {/* Transparent: what got excluded as exceptions, with the reason */}
          {data.baseline_meta.excluded_sources?.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{
                cursor: 'pointer', fontSize: 11, color: 'var(--text-muted)',
                userSelect: 'none',
              }}>
                {data.baseline_meta.excluded_sources.length} excluded as exception{data.baseline_meta.excluded_sources.length === 1 ? '' : 's'}
                {' '}— show
              </summary>
              <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {data.baseline_meta.excluded_sources.map(s => (
                  <span
                    key={s.source}
                    title={({
                      below_amount_floor: 'Median below $100/mo — likely a cashback or fee credit',
                      insufficient_history: `Only ${s.months_observed} month${s.months_observed === 1 ? '' : 's'} observed — could be a one-off`,
                    }[s.reason] || s.reason)}
                    style={{
                      background: 'var(--bg-hover)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-muted)',
                      padding: '2px 8px', borderRadius: 4,
                      fontSize: 11,
                    }}
                  >
                    {s.source.length > 28 ? s.source.slice(0, 28) + '…' : s.source} {formatCurrency(s.median_monthly)}
                  </span>
                ))}
              </div>
            </details>
          )}

          <div style={{ marginTop: 8, fontStyle: 'italic', fontSize: 11 }}>
            {data.baseline_meta.note}
          </div>
        </div>
      )}

      {/* Health metrics — runway + bill stress (above forecast totals) */}
      {health && (
        <div className="stats-grid" style={{ marginBottom: 12 }}>
          <HealthCard
            label="Emergency runway"
            icon={<ShieldCheck size={14} />}
            value={health.runway_months !== null
              ? `${health.runway_months.toFixed(1)} mo`
              : '—'}
            sub={health.runway_months !== null
              ? `${formatCurrency(health.liquid_balance)} liquid ÷ ${formatCurrency(health.avg_monthly_spend)}/mo spend`
              : 'Need more spending history'}
            status={health.runway_status}
            tone={{ healthy: 'var(--accent-green)', moderate: 'var(--accent-yellow)', thin: 'var(--accent-red)', unknown: 'var(--text-muted)' }[health.runway_status]}
          />
          <HealthCard
            label="Bill stress"
            icon={<Banknote size={14} />}
            value={health.bill_stress_pct !== null
              ? `${health.bill_stress_pct.toFixed(1)}%`
              : '—'}
            sub={health.bill_stress_pct !== null
              ? `${formatCurrency(health.monthly_recurring_outflow)} fixed ÷ ${formatCurrency(health.avg_monthly_income)}/mo income`
              : 'Need more income history'}
            status={health.bill_status}
            tone={{ healthy: 'var(--accent-green)', moderate: 'var(--accent-yellow)', high: 'var(--accent-red)', unknown: 'var(--text-muted)' }[health.bill_status]}
          />
          <div className="stat-card">
            <div className="stat-label">Liquid reserve</div>
            <div className="stat-value">{formatCurrency(health.liquid_balance)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              checking + savings
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Avg monthly income</div>
            <div className="stat-value positive">{formatCurrency(health.avg_monthly_income)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              90-day average
            </div>
          </div>
        </div>
      )}

      {/* Stat cards */}
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Projected outflows</div>
          <div className="stat-value negative">{formatCurrency(totalOut)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Projected inflows</div>
          <div className="stat-value positive">{formatCurrency(totalIn)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net over period</div>
          <div className={`stat-value ${net >= 0 ? 'positive' : 'negative'}`}>{formatCurrency(net)}</div>
        </div>
        {data.low_point && (
          <div className="stat-card" title="Largest cumulative drawdown from today">
            <div className="stat-label">Low point</div>
            <div className="stat-value negative">{formatCurrency(data.low_point.delta)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              on {data.low_point.date}
            </div>
          </div>
        )}
      </div>

      {/* Cumulative chart */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title">Projected cash flow</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            cumulative net change from today (today = $0)
          </span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={data.series}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3a" />
            <XAxis
              dataKey="date"
              tick={{ fill: '#9aa0a6', fontSize: 11 }}
              tickFormatter={d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              minTickGap={32}
            />
            <YAxis tick={{ fill: '#9aa0a6', fontSize: 11 }} tickFormatter={v => `$${(v/1000).toFixed(1)}k`} />
            <Tooltip
              contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)' }}
              labelFormatter={d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              formatter={(v, k) => [formatCurrency(v), k === 'cumulative_delta' ? 'Cumulative net' : k]}
            />
            <Area type="monotone" dataKey="cumulative_delta" stroke="#60a5fa" fill="rgba(96,165,250,0.18)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Upcoming events */}
      <div className="card">
        <div className="card-header">
          <span className="card-title">Upcoming recurring events</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{data.upcoming_events.length} expected</span>
        </div>
        {data.upcoming_events.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13, padding: 20, textAlign: 'center' }}>
            No recurring events detected in the forecast window.
          </p>
        ) : (
          <table style={{ width: '100%' }}>
            <thead>
              <tr><th>Date</th><th>Source</th><th>Category</th><th></th><th style={{ textAlign: 'right' }}>Amount</th></tr>
            </thead>
            <tbody>
              {data.upcoming_events.slice(0, 25).map((e, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 13, whiteSpace: 'nowrap' }}>{e.date}</td>
                  <td style={{ fontWeight: 500 }}>{e.source}</td>
                  <td><span className="category-badge">{e.category || 'Uncategorized'}</span></td>
                  <td>
                    {e.kind === 'inflow'
                      ? <span style={{ color: 'var(--accent-green)', fontSize: 12 }}>+ income</span>
                      : <span style={{ color: 'var(--accent-red)', fontSize: 12 }}>− outflow</span>}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: e.kind === 'inflow' ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                    {e.kind === 'inflow' ? '+' : '−'}{formatCurrency(e.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function SubscriptionsView() {
  const [data, setData] = useState(null)
  const [cutSubscriptions, setCutSubscriptions] = useState(new Set())
  useEffect(() => { getRecurring().then(setData).catch(() => {}) }, [])

  const toggleCut = (merchantKey) => {
    setCutSubscriptions(prev => {
      const next = new Set(prev)
      if (next.has(merchantKey)) next.delete(merchantKey)
      else next.add(merchantKey)
      return next
    })
  }

  const cutMonthlySavings = data ? data.recurring
    .filter(r => !r.is_income && cutSubscriptions.has(r.merchant))
    .reduce((sum, r) => sum + (r.avg_amount || 0), 0) : 0
  const cutAnnualSavings = cutMonthlySavings * 12

  if (!data) return <p style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>Loading...</p>

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Monthly Recurring</div>
          <div className="stat-value negative">{formatCurrency(data.total_monthly_cost)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Annual Cost</div>
          <div className="stat-value negative">{formatCurrency(data.total_annual_cost)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Of That, Subscriptions</div>
          <div className="stat-value">{formatCurrency(data.subscription_annual_cost || 0)}</div>
        </div>
        <div className="stat-card" title="Latest charge > 25% above the usual amount">
          <div className="stat-label">Charges Over Usual</div>
          <div className="stat-value" style={{ color: (data.anomaly_count || 0) > 0 ? 'var(--accent-red)' : undefined }}>
            {data.anomaly_count || 0}
          </div>
        </div>
        <div className="stat-card" title="Expected charge hasn't appeared yet">
          <div className="stat-label">Possibly Missed</div>
          <div className="stat-value" style={{ color: (data.overdue_count || 0) > 0 ? 'var(--accent-yellow)' : undefined }}>
            {data.overdue_count || 0}
          </div>
        </div>
      </div>

      {/* Savings if cut simulator */}
      {cutMonthlySavings > 0 && (
        <div style={{
          background: 'rgba(34, 197, 94, 0.1)',
          border: '1px solid rgba(34, 197, 94, 0.3)',
          borderRadius: 8,
          padding: 12,
          marginBottom: 16,
          color: 'var(--accent-green)',
          fontSize: 13,
          fontWeight: 500,
        }}>
          Cut {cutSubscriptions.size} → save {formatCurrency(cutMonthlySavings)}/mo · {formatCurrency(cutAnnualSavings)}/yr
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Detected Recurring Charges</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            outflows only · paychecks live on the Spending & Income page
          </span>
        </div>
        {(() => {
          // Subscriptions tab is for outflows you might want to audit / cancel.
          // Income (paychecks, recurring deposits) gets detected by the same
          // engine but doesn't belong here — it's surfaced on the Spending &
          // Income page's Income Sources panel instead.
          const charges = data.recurring.filter(r => !r.is_income)
          if (charges.length === 0) {
            return (
              <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>
                Not enough transaction history to detect patterns yet. Check back after a few months of data.
              </p>
            )
          }
          return (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>Cut</th>
                  <th>Merchant</th>
                  <th>Frequency</th>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th style={{ textAlign: 'right' }}>Annual Cost</th>
                  <th>Next Expected</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((r, i) => (
                  <tr key={i} style={{
                    background: cutSubscriptions.has(r.merchant)
                      ? 'rgba(107, 114, 128, 0.1)'
                      : r.is_anomalous
                      ? 'rgba(239, 68, 68, 0.06)'
                      : r.is_overdue ? 'rgba(234, 179, 8, 0.06)' : undefined,
                    opacity: cutSubscriptions.has(r.merchant) ? 0.6 : 1,
                  }}>
                    <td style={{ textAlign: 'center', padding: '8px 4px' }}>
                      <input
                        type="checkbox"
                        checked={cutSubscriptions.has(r.merchant)}
                        onChange={() => toggleCut(r.merchant)}
                        style={{ cursor: 'pointer' }}
                        title={cutSubscriptions.has(r.merchant) ? 'Include in savings' : 'Remove from budget'}
                      />
                    </td>
                    <td style={{ fontWeight: 500 }}>
                      {r.merchant}
                      {r.kind === 'subscription' && (
                        <span className="category-badge" style={{
                          marginLeft: 6, fontSize: 10, padding: '2px 6px',
                          background: 'var(--accent-blue-bg)', color: 'var(--accent-blue)'
                        }}>SUB</span>
                      )}
                      {r.kind === 'bill' && (
                        <span className="category-badge" style={{
                          marginLeft: 6, fontSize: 10, padding: '2px 6px',
                          background: 'var(--bg-hover)', color: 'var(--text-secondary)'
                        }}>BILL</span>
                      )}
                      {r.is_seasonal && (
                        <span
                          className="category-badge"
                          title={`Charges only in months ${(r.active_months || []).map(m => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]).join(', ')}`}
                          style={{
                            marginLeft: 6, fontSize: 10, padding: '2px 6px',
                            background: 'rgba(251,146,60,0.15)', color: 'var(--accent-orange)',
                          }}>SEASONAL</span>
                      )}
                      {r.is_overdue && (
                        <span className="category-badge" title="Expected charge hasn't posted yet" style={{
                          marginLeft: 6, fontSize: 10, padding: '2px 6px',
                          background: 'rgba(234, 179, 8, 0.15)', color: 'var(--accent-yellow)'
                        }}>MISSED?</span>
                      )}
                    </td>
                    <td>
                      <span className="category-badge" style={{
                        background: r.frequency === 'monthly' ? 'var(--accent-blue-bg)' : 'var(--bg-hover)',
                        color: r.frequency === 'monthly' ? 'var(--accent-blue)' : 'var(--text-secondary)'
                      }}>
                        {r.frequency}
                      </span>
                    </td>
                    <td><span className="category-badge">{r.icon} {r.category}</span></td>
                    <td style={{ textAlign: 'right' }}>
                      {formatCurrency(r.avg_amount)}
                      {r.is_anomalous && (
                        <div style={{ fontSize: 11, color: 'var(--accent-red)' }}>
                          latest {formatCurrency(r.latest_amount)} (+{r.latest_vs_median_pct}%)
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--accent-red)' }}>
                      {formatCurrency(r.annual_cost)}
                    </td>
                    <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{r.next_expected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )
        })()}
      </div>
    </div>
  )
}

export default function CashFlow() {
  const [tab, setTab] = useState('forecast')

  const tabs = [
    { id: 'forecast', label: 'Forecast', icon: TrendingUp },
    { id: 'subscriptions', label: 'Subscriptions', icon: Repeat },
  ]

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Cash Flow</h1>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid var(--border)', paddingBottom: 4 }}>
        {tabs.map(t => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 16px', borderRadius: '8px 8px 0 0',
                background: tab === t.id ? 'var(--bg-card)' : 'transparent',
                color: tab === t.id ? 'var(--accent-green)' : 'var(--text-secondary)',
                border: tab === t.id ? '1px solid var(--border)' : '1px solid transparent',
                borderBottom: tab === t.id ? '1px solid var(--bg-card)' : 'none',
                fontSize: 13, fontWeight: 500, cursor: 'pointer',
                marginBottom: -5,
              }}
            >
              <Icon size={15} /> {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'forecast' && <ForecastView />}
      {tab === 'subscriptions' && <SubscriptionsView />}
    </div>
  )
}
