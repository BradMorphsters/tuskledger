import { useState, useEffect } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  FileText, TrendingUp, TrendingDown, Download,
  AlertTriangle, Store, Sparkles, Calendar,
  ChevronDown, ChevronRight, Scissors, WifiOff,
} from 'lucide-react'
import {
  getMerchantInsights, getMonthlyReport, getExportUrl,
  getFirstTimeMerchants,
  getSpendingPatterns, getTransactions, getRecurring,
} from '../api/client'
import { formatCurrencyZero as formatCurrency, cleanMerchantName, yearOptions } from '../lib/format'
import { useStoredState } from '../lib/storage'
import EmptyState from '../components/EmptyState'
import { SkeletonCard } from '../components/Skeleton'


// Reusable form input style — used in the goal modal in lieu of a global class.
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

// ─── Tab: Top Merchants ────────────────────────────────
function MerchantsTab() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const [months, setMonths] = useState(6)
  useEffect(() => {
    setData(null); setError(false)
    getMerchantInsights(months).then(setData).catch(() => setError(true))
  }, [months])

  if (error) return <EmptyState compact icon={<WifiOff size={20} />} title="Couldn't load merchants" description="Check your connection and try refreshing." />
  if (!data) return <SkeletonCard rows={5} />

  // Truncate generously — the merchant strings are normalized server-side
  // now ('Wells Fargo Mortgage', 'Apple Card Payment', etc.), so most fit
  // comfortably and only outliers like Apple's full Cupertino address
  // string get clipped. Keep the full name in the tooltip so nothing's
  // ever lost.
  const chartData = data.merchants.slice(0, 10).map(m => ({
    name: m.merchant.length > 28 ? m.merchant.slice(0, 28) + '…' : m.merchant,
    fullName: m.merchant,
    total: m.total,
  }))

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        {[3, 6, 12].map(n => (
          <button key={n} onClick={() => setMonths(n)}
            className={months === n ? 'btn btn-primary' : 'btn btn-secondary'}
            style={{ padding: '6px 14px', fontSize: 12 }}
          >{n} months</button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
          {data.merchants.length} merchants · ranked by total spend
        </span>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title">Top Merchants by Spend</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            top 10 over the last {months} month{months === 1 ? '' : 's'}
          </span>
        </div>
        {chartData.length > 0 ? (
          // Taller chart + wider Y-axis = readable merchant labels.
          // Height scales with row count so 10 merchants don't get squished.
          <ResponsiveContainer width="100%" height={Math.max(360, chartData.length * 38)}>
            <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
                tickFormatter={v => `$${v.toLocaleString()}`}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fill: 'var(--text-primary)', fontSize: 13, fontWeight: 500 }}
                width={200}
                interval={0}
              />
              <Tooltip
                cursor={{ fill: 'var(--bg-hover)' }}
                contentStyle={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  color: 'var(--text-primary)',
                }}
                labelFormatter={(_label, payload) => payload?.[0]?.payload?.fullName || _label}
                formatter={v => [formatCurrency(v), 'Total']}
              />
              <Bar dataKey="total" fill="#60a5fa" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>No data</p>
        )}
      </div>

      <div className="card">
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Merchant</th>
                <th>Category</th>
                <th>Transactions</th>
                <th style={{ textAlign: 'right' }}>Avg</th>
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {data.merchants.map((m, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{i + 1}</td>
                  <td style={{ fontWeight: 500 }}>{m.merchant}</td>
                  <td><span className="category-badge">{m.icon} {m.category}</span></td>
                  <td>{m.count}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{formatCurrency(m.avg_transaction)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--accent-red)' }}>{formatCurrency(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}


// ─── Tab: Monthly Report ───────────────────────────────
function ReportTab() {
  const [report, setReport] = useState(null)
  const [reportError, setReportError] = useState(false)
  const [newMerchants, setNewMerchants] = useState(null)
  const [month, setMonth] = useState(new Date().getMonth() + 1)
  const [year, setYear] = useState(new Date().getFullYear())

  useEffect(() => {
    setReport(null); setReportError(false)
    getMonthlyReport(month, year).then(setReport).catch(() => setReportError(true))
  }, [month, year])
  useEffect(() => {
    setNewMerchants(null)
    getFirstTimeMerchants(month, year)
      .then(setNewMerchants)
      .catch(() => setNewMerchants({ new_merchants: [] }))
  }, [month, year])

  if (reportError) return <EmptyState compact icon={<WifiOff size={20} />} title="Couldn't load monthly report" description="Check your connection and try refreshing." />
  if (!report) return <SkeletonCard rows={6} />

  const c = {
    top_categories: [], top_merchants: [], transaction_count: 0,
    spending: 0, income: 0, net: 0,
    ...report.current,
  }
  const p = {
    top_categories: [], top_merchants: [], transaction_count: 0,
    spending: 0, income: 0, net: 0,
    ...report.previous,
  }
  const ch = report.changes

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <select value={month} onChange={e => setMonth(Number(e.target.value))}
          style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 14 }}>
          {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => (
            <option key={i} value={i + 1}>{m}</option>
          ))}
        </select>
        <select value={year} onChange={e => setYear(Number(e.target.value))}
          style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 14 }}>
          {yearOptions().map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <a href={getExportUrl(`${year}-${String(month).padStart(2,'0')}-01`, month === 12 ? `${year+1}-01-01` : `${year}-${String(month+1).padStart(2,'0')}-01`)}
          className="btn btn-secondary" style={{ marginLeft: 'auto', fontSize: 13 }}
          download>
          <Download size={14} /> Export CSV
        </a>
      </div>

      {/* Insights */}
      {(report.insights ?? []).length > 0 && (
        <div className="card" style={{ marginBottom: 20, padding: 16 }}>
          {(report.insights ?? []).map((insight, i) => (
            <div key={i} style={{ padding: '6px 0', fontSize: 14, color: 'var(--text-primary)' }}>{insight}</div>
          ))}
        </div>
      )}

      {/* What's changed — category drift alerts */}
      {report.drift_alerts && report.drift_alerts.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} style={{ color: 'var(--accent-orange)' }} />
              What's changed
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              categories spending notably above their 3-month trailing average
            </span>
          </div>
          <table style={{ width: '100%' }}>
            <tbody>
              {report.drift_alerts.map(d => (
                <tr key={d.category}>
                  <td style={{ width: 28 }}><span style={{ fontSize: 18 }}>{d.icon}</span></td>
                  <td style={{ fontWeight: 500 }}>{d.category}</td>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                    {formatCurrency(d.current_amount)}
                    <span style={{ color: 'var(--text-muted)' }}> vs avg {formatCurrency(d.trailing_3mo_avg)}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span style={{
                      color: 'var(--accent-red)',
                      fontWeight: 600,
                      fontSize: 13,
                    }}>
                      ↑ {d.delta_pct.toFixed(1)}%
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 6 }}>
                        +{formatCurrency(d.delta_dollars)}
                      </span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Year-over-year — only renders when same-month-last-year data exists */}
      {report.yoy && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
              Vs same month last year
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {month}/{year - 1} → {month}/{year}
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <YoYRow label="Spending" current={c.spending} prior={report.yoy.spending} pct={report.yoy_changes?.spending} inverse />
            <YoYRow label="Income" current={c.income} prior={report.yoy.income} pct={report.yoy_changes?.income} />
          </div>
        </div>
      )}

      {/* Income sources — drill-down to see why a month's income was unusually
          high or low. Click any row to expand the underlying payments. */}
      <IncomeSourcesPanel month={month} year={year} totalIncome={c.income} />

      {/* Current vs Previous */}
      <div className="stats-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Spending</div>
          <div className="stat-value negative">{formatCurrency(c.spending)}</div>
          {ch.spending != null && (
            <div style={{ fontSize: 12, marginTop: 4, color: ch.spending > 0 ? 'var(--accent-red)' : 'var(--accent-green)' }}>
              {ch.spending > 0 ? '↑' : '↓'} {Math.abs(ch.spending)}% vs last month
            </div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">Income</div>
          <div className="stat-value positive">{formatCurrency(c.income)}</div>
          {ch.income != null && (
            <div style={{ fontSize: 12, marginTop: 4, color: ch.income > 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
              {ch.income > 0 ? '↑' : '↓'} {Math.abs(ch.income)}% vs last month
            </div>
          )}
        </div>
        <div className="stat-card">
          <div className="stat-label">Net Savings</div>
          <div className={`stat-value ${c.net >= 0 ? 'positive' : 'negative'}`}>{formatCurrency(c.net)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Transactions</div>
          <div className="stat-value">{c.transaction_count}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Top Categories */}
        <div className="card">
          <div className="card-header"><span className="card-title">Top Categories</span></div>
          {c.top_categories.map((cat, i) => (
            <div key={cat.category} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < c.top_categories.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <span>{cat.icon} {cat.category}</span>
              <span style={{ fontWeight: 600, color: 'var(--accent-red)' }}>{formatCurrency(cat.amount)}</span>
            </div>
          ))}
        </div>

        {/* Top Merchants */}
        <div className="card">
          <div className="card-header"><span className="card-title">Top Merchants</span></div>
          {c.top_merchants.map((m, i) => (
            <div key={m.merchant} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: i < c.top_merchants.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <span style={{ fontWeight: 500 }}>{m.merchant}</span>
              <span style={{ fontWeight: 600, color: 'var(--accent-red)' }}>{formatCurrency(m.amount)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* First-time merchants — surfaces new subscriptions or one-off splurges */}
      {newMerchants && newMerchants.new_merchants && newMerchants.new_merchants.length > 0 && (
        <div className="card" style={{ marginTop: 20 }}>
          <div className="card-header">
            <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <Sparkles size={16} style={{ color: 'var(--accent-blue)' }} />
              New merchants this month
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {newMerchants.new_merchants.length} merchant{newMerchants.new_merchants.length === 1 ? '' : 's'} you've never transacted with before
            </span>
          </div>
          <table style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>First date</th>
                <th>Merchant</th>
                <th>Category</th>
                <th>Transactions</th>
                <th style={{ textAlign: 'right' }}>First charge</th>
                <th style={{ textAlign: 'right' }}>Total this month</th>
              </tr>
            </thead>
            <tbody>
              {newMerchants.new_merchants.map(m => (
                <tr key={m.merchant + m.first_date}>
                  <td style={{ color: 'var(--text-secondary)', fontSize: 13, whiteSpace: 'nowrap' }}>{m.first_date}</td>
                  <td style={{ fontWeight: 500 }}>{m.merchant}</td>
                  <td><span className="category-badge">{m.icon} {m.category}</span></td>
                  <td>{m.transaction_count}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{formatCurrency(m.first_amount)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--accent-red)' }}>{formatCurrency(m.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}


// Cash-flow health metric card. Big number + status pill + thin context line.
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


// ─── Income Sources panel (Monthly Report) ─────────────
// Shows cleaned + deduped income sources for the selected month. Each
// row expands to reveal the individual transactions that make up its
// total — handy for spotting "why was Feb so high?" answers like a
// year-end bonus or a quarterly profit-share.
function IncomeSourcesPanel({ month, year, totalIncome }) {
  const [patterns, setPatterns] = useState(null)
  const [monthTxns, setMonthTxns] = useState(null)
  const [openRows, setOpenRows] = useState(() => new Set())

  // Reset everything when the user picks a different month/year.
  useEffect(() => {
    setPatterns(null)
    setMonthTxns(null)
    setOpenRows(new Set())
    getSpendingPatterns(month, year).then(setPatterns).catch(() => setPatterns(null))
  }, [month, year])

  const ensureTxnsLoaded = () => {
    if (monthTxns !== null) return
    const pad = n => String(n).padStart(2, '0')
    const lastDay = new Date(year, month, 0).getDate()
    const start_date = `${year}-${pad(month)}-01`
    const end_date = `${year}-${pad(month)}-${pad(lastDay)}`
    getTransactions({ start_date, end_date, limit: 500 })
      .then(txns => setMonthTxns(txns || []))
      .catch(() => setMonthTxns([]))
  }

  const toggleRow = (key) => {
    ensureTxnsLoaded()
    setOpenRows(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Dedupe income_sources by their cleaned name. Same dedup as Dashboard
  // — multiple paychecks from the same employer collapse into one row.
  const merged = (() => {
    if (!patterns?.income_sources) return []
    const m = new Map()
    for (const s of patterns.income_sources) {
      const cleaned = cleanMerchantName(s.source)
      const cur = m.get(cleaned) || { name: cleaned, raw: s.source, amount: 0, count: 0 }
      cur.amount += s.amount
      cur.count += 1
      m.set(cleaned, cur)
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount)
  })()

  if (!patterns) return null
  if (merged.length === 0) return null

  const total = totalIncome || merged.reduce((s, m) => s + m.amount, 0)
  const maxAmt = Math.max(...merged.map(m => m.amount), 1)

  const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header">
        <span className="card-title" style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          color: 'var(--accent-green)',
        }}>
          <TrendingUp size={16} />
          Income sources
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {merged.length} source{merged.length === 1 ? '' : 's'} · click a row to see individual payments
        </span>
      </div>

      {merged.map(row => {
        const pct = (row.amount / maxAmt) * 100
        const totalPct = total > 0 ? (row.amount / total) * 100 : 0
        const isOpen = openRows.has(row.name)
        const subTxns = isOpen && monthTxns
          ? monthTxns
              .filter(t => (
                t.amount < 0 && !t.is_transfer &&
                cleanMerchantName(t.merchant_name || t.name || '') === row.name
              ))
              .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
          : []

        return (
          <div key={row.name} style={{ borderBottom: '1px solid var(--border)' }}>
            <div
              onClick={() => toggleRow(row.name)}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 1.4fr 3fr auto',
                gap: 12,
                alignItems: 'center',
                padding: '10px 0',
                cursor: 'pointer',
              }}
            >
              <span style={{ color: 'var(--text-muted)', display: 'flex', justifyContent: 'center' }}>
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <div title={row.raw} style={{
                  fontWeight: 500, fontSize: 14,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>{row.name}</div>
                {row.count > 1 && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {row.count} payments
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  flex: 1, height: 6, background: 'var(--bg-hover)',
                  borderRadius: 3, overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${pct}%`, height: '100%',
                    borderRadius: 3, background: 'var(--accent-green)',
                  }} />
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 44, textAlign: 'right' }}>
                  {totalPct.toFixed(1)}%
                </span>
              </div>
              <div className="tabular" style={{
                fontWeight: 600, fontSize: 14,
                color: 'var(--accent-green)', minWidth: 100, textAlign: 'right',
              }}>
                {formatCurrency(row.amount)}
              </div>
            </div>

            {isOpen && (
              <div style={{ paddingLeft: 32, paddingBottom: 10 }}>
                {monthTxns === null ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>
                    Loading transactions…
                  </div>
                ) : subTxns.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>
                    No matching transactions found in this month.
                  </div>
                ) : (
                  <table style={{ width: '100%', fontSize: 12 }}>
                    <tbody>
                      {subTxns.map(t => {
                        // Same display polish as Dashboard — collapse "Foo Foo" → "Foo"
                        // when merchant_name and name produce a duplicated string.
                        let displayName = cleanMerchantName(t.merchant_name || t.name || '')
                        const half = Math.floor(displayName.length / 2)
                        const a = displayName.slice(0, half).trim()
                        const b = displayName.slice(half).trim()
                        if (a && a === b) displayName = a
                        return (
                          <tr key={t.id} style={{ borderBottom: '1px dotted var(--border)' }}>
                            <td style={{
                              width: 60, padding: '4px 8px 4px 0',
                              color: 'var(--text-muted)', whiteSpace: 'nowrap',
                            }}>
                              {fmtDate(t.date)}
                            </td>
                            <td style={{ padding: '4px 8px 4px 0', minWidth: 0 }}>
                              <div title={t.name} style={{
                                color: 'var(--text-primary)',
                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                maxWidth: 380,
                              }}>{displayName}</div>
                            </td>
                            <td style={{
                              textAlign: 'right', whiteSpace: 'nowrap',
                              fontVariantNumeric: 'tabular-nums', fontWeight: 500,
                              color: 'var(--accent-green)',
                              paddingLeft: 8,
                            }}>
                              {formatCurrency(Math.abs(t.amount))}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )
      })}

      {/* Total */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '20px 1.4fr 3fr auto',
        gap: 12,
        alignItems: 'center',
        padding: '12px 0 4px',
        fontSize: 13,
      }}>
        <div />
        <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Total</div>
        <div />
        <div className="tabular" style={{
          fontWeight: 700, fontSize: 14, color: 'var(--accent-green)',
          minWidth: 100, textAlign: 'right',
        }}>
          {formatCurrency(total)}
        </div>
      </div>
    </div>
  )
}


// Side-by-side YoY metric pairing for the Monthly Report.
function YoYRow({ label, current, prior, pct, inverse }) {
  // For spending, "up" is bad → red. For income, "up" is good → green.
  const upIsBad = !!inverse
  const isUp = pct !== null && pct !== undefined && pct > 0
  const tone = pct === null || pct === undefined
    ? 'var(--text-muted)'
    : (isUp === upIsBad ? 'var(--accent-red)' : 'var(--accent-green)')
  return (
    <div style={{ padding: '8px 4px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 4 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
          {formatCurrency(current)}
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          vs {formatCurrency(prior)}
        </span>
      </div>
      {pct !== null && pct !== undefined && (
        <div style={{ color: tone, fontSize: 12, marginTop: 2 }}>
          {isUp ? '↑' : '↓'} {Math.abs(pct).toFixed(1)}%
        </div>
      )}
    </div>
  )
}


// ─── Tab: Subscriptions to cancel ──────────────────────
//
// Closes the loop on the Spending & Income page's subscription status
// tracker — anything tagged 'cancel' or 'watch' there gets surfaced
// here as an actionable card with annual savings rolled up at the top.
//
// Status lives in localStorage (same key the SpendingIncome page uses);
// no backend round-trip needed for personal-use bookkeeping.
//
// Subscription status keyed identically to SpendingIncome → RecurringCard
// so the two tabs share state via localStorage.
const SUB_STATUS_KEY = 'tuskledger.subscriptionStatus.v1'

function SubscriptionsTab() {
  const [data, setData] = useState(null)
  const [statusMap, setStatusMap] = useStoredState(SUB_STATUS_KEY, {})

  useEffect(() => { getRecurring().then(setData).catch(() => setData({ recurring: [] })) }, [])

  if (!data) {
    return <p style={{ color: 'var(--text-muted)', padding: 40, textAlign: 'center' }}>Loading…</p>
  }

  const items = data.recurring || []
  const tagged = (status) => items.filter(r => statusMap[r.merchant] === status)
  const toCancel = tagged('cancel')
  const watching = tagged('watch')
  const untagged = items.filter(r => !statusMap[r.merchant])

  const sumAnnual = (rs) => rs.reduce((s, r) => s + (r.annual_cost || 0), 0)
  const cancelAnnual = sumAnnual(toCancel)
  const watchAnnual = sumAnnual(watching)
  const totalAnnual = sumAnnual(items)

  // Mark a subscription as cancelled (i.e. user followed through and
  // actually unsubscribed). useStoredState handles the localStorage
  // write transparently — no manual save call needed.
  const markStatus = (merchant, status) => {
    setStatusMap(prev => {
      const next = { ...prev }
      if (status === 'active' || !status) {
        delete next[merchant]
      } else {
        next[merchant] = status
      }
      return next
    })
  }

  return (
    <div>
      {/* Hero rollup — at-a-glance savings opportunity */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
        marginBottom: 20,
      }}>
        <SubsRollupCard
          icon={<Scissors size={16} />}
          label="Tagged to cancel"
          value={formatCurrency(cancelAnnual)}
          sub={`${toCancel.length} subscription${toCancel.length === 1 ? '' : 's'} · annual`}
          tone="positive"
          dim={cancelAnnual === 0}
        />
        <SubsRollupCard
          icon={<AlertTriangle size={16} />}
          label="Under review"
          value={formatCurrency(watchAnnual)}
          sub={`${watching.length} watching · annual`}
          tone="warning"
          dim={watchAnnual === 0}
        />
        <SubsRollupCard
          icon={<Sparkles size={16} />}
          label="All subscriptions"
          value={formatCurrency(totalAnnual)}
          sub={`${items.length} active · annual cost`}
          tone="neutral"
        />
      </div>

      {/* Action list — Cancel queue front and center */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Scissors size={16} style={{ color: 'var(--accent-green)' }} />
            Cancel queue
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            actions you've decided to take
          </span>
        </div>
        {toCancel.length === 0 ? (
          <div style={{
            padding: '24px 12px', textAlign: 'center',
            color: 'var(--text-muted)', fontSize: 13,
          }}>
            Nothing tagged for cancellation yet. Open Spending &amp; Income → Recurring &amp;
            Subscriptions and tap the pill on a row to mark it Cancel.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {toCancel.map(r => (
              <SubsActionRow
                key={r.merchant}
                row={r}
                onMarkCancelled={() => markStatus(r.merchant, 'active')}
                onChangeMind={() => markStatus(r.merchant, 'watch')}
                primaryLabel="✓ I cancelled it"
                secondaryLabel="Move to watch"
              />
            ))}
          </ul>
        )}
      </div>

      {/* Watch list */}
      {watching.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <span className="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} style={{ color: 'var(--accent-yellow)' }} />
              Watch list
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              keeping an eye on these
            </span>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {watching.map(r => (
              <SubsActionRow
                key={r.merchant}
                row={r}
                onMarkCancelled={() => markStatus(r.merchant, 'cancel')}
                onChangeMind={() => markStatus(r.merchant, 'active')}
                primaryLabel="✂ Move to cancel"
                secondaryLabel="Decided to keep"
              />
            ))}
          </ul>
        </div>
      )}

      {/* Untagged callout — gentle nudge, only if there are any */}
      {untagged.length > 0 && (
        <div style={{
          padding: '10px 14px', fontSize: 12,
          color: 'var(--text-muted)',
          background: 'var(--bg-card)',
          border: '1px dashed var(--border)',
          borderRadius: 6,
        }}>
          {untagged.length} subscription{untagged.length === 1 ? ' is' : 's are'} untagged.
          Visit Spending &amp; Income → Recurring &amp; Subscriptions to triage them.
        </div>
      )}
    </div>
  )
}

function SubsRollupCard({ icon, label, value, sub, tone, dim }) {
  const accent = tone === 'positive' ? 'var(--accent-green)'
    : tone === 'warning' ? 'var(--accent-yellow)'
    : 'var(--text-secondary)'
  return (
    <div className="card" style={{
      padding: 16, opacity: dim ? 0.6 : 1,
    }}>
      <div style={{
        fontSize: 11, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: 0.4,
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ color: accent }}>{icon}</span>
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 700, color: accent,
        marginTop: 6, fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
        {sub}
      </div>
    </div>
  )
}

function SubsActionRow({ row, onMarkCancelled, onChangeMind, primaryLabel, secondaryLabel }) {
  return (
    <li style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 0', borderBottom: '1px solid var(--border)',
    }}>
      <span style={{ fontSize: 22, flexShrink: 0 }}>{row.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontWeight: 500, fontSize: 14,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {cleanMerchantName(row.merchant)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
          {row.frequency} · {formatCurrency(row.avg_amount)}/charge · next {row.next_expected}
        </div>
      </div>
      <div className="tabular" style={{ textAlign: 'right', minWidth: 110 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent-green)' }}>
          {formatCurrency(row.annual_cost)}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>per year</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
        <button
          onClick={onMarkCancelled}
          style={{
            padding: '5px 10px', fontSize: 12, fontWeight: 500,
            background: 'var(--accent-green)', color: '#0d0e14',
            border: 'none', borderRadius: 4, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {primaryLabel}
        </button>
        <button
          onClick={onChangeMind}
          style={{
            padding: '4px 10px', fontSize: 11,
            background: 'transparent', color: 'var(--text-secondary)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {secondaryLabel}
        </button>
      </div>
    </li>
  )
}

// ─── Main Insights Page ────────────────────────────────
export default function Insights() {
  const [tab, setTab] = useState('report')

  const tabs = [
    { id: 'report', label: 'Monthly Report', icon: FileText },
    { id: 'merchants', label: 'Top Merchants', icon: Store },
    { id: 'subscriptions', label: 'Subscriptions', icon: Scissors },
  ]

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Insights</h1>
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

      {tab === 'report' && <ReportTab />}
      {tab === 'merchants' && <MerchantsTab />}
      {tab === 'subscriptions' && <SubscriptionsTab />}
    </div>
  )
}
